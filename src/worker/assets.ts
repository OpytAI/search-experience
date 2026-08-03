/**
 * Integrity-checked asset loading for the runtime worker.
 */
import type { AssetDescriptor, SearchExperienceManifest } from "../protocol/manifest.js";
import type { McCoreModule } from "../host/vm-boot.js";

export async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function loadBytes(base: string, relative: string): Promise<Uint8Array> {
  const response = await fetch(new URL(relative, base));
  if (!response.ok) throw new Error(`asset HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function verifiedBytes(base: string, descriptor: AssetDescriptor, name: string): Promise<Uint8Array> {
  const bytes = await loadBytes(base, descriptor.url);
  if (Number.isSafeInteger(descriptor.bytes) && descriptor.bytes > 0 && bytes.byteLength !== descriptor.bytes) {
    // Allow length mismatch only if sha still matches (compression edge cases); prefer sha.
  }
  const hash = await sha256(bytes);
  if (hash !== descriptor.sha256) {
    throw new Error(`integrity check failed for ${name}`);
  }
  return bytes;
}

export async function verifiedText(base: string, descriptor: AssetDescriptor, name: string): Promise<string> {
  const bytes = await verifiedBytes(base, descriptor, name);
  return new TextDecoder().decode(bytes);
}

/**
 * Load mc-core from verified bytes via blob URL to avoid TOCTOU on a second fetch.
 */
export async function importMcCore(base: string, descriptor: AssetDescriptor): Promise<McCoreModule> {
  const bytes = await verifiedBytes(base, descriptor, "mc-core");
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy], { type: "text/javascript" });
  const blobUrl = URL.createObjectURL(blob);
  try {
    const mod = await import(/* @vite-ignore */ blobUrl) as McCoreModule;
    if (!mod.mc || !mod.tool || !mod.z || !mod.OpfsContentStore) {
      throw new Error("mc-core.mjs does not export mc/tool/z/OpfsContentStore");
    }
    return mod;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

export async function verifyModelAssets(
  base: string,
  model: NonNullable<SearchExperienceManifest["model"]>,
): Promise<void> {
  await Promise.all(
    Object.entries(model.assets).map(async ([key, descriptor]) => {
      await verifiedBytes(base, descriptor, `model.${key}`);
    }),
  );
}
