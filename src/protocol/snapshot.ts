/** Compatibility-keyed OPFS MCSN snapshot metadata. */

import { SEARCHD_PROTOCOL_VERSION, SNAPSHOT_FORMAT_VERSION } from "./versions.js";

export interface SnapshotCompatibility {
  format: typeof SNAPSHOT_FORMAT_VERSION;
  /** Deterministic key: kernel+image+service+schema+model+policy+collections. */
  compatibilityKey: string;
  searchdProtocol: typeof SEARCHD_PROTOCOL_VERSION;
  kernelSha256: string;
  imageSha256: string;
  schemaSha256: string;
  modelFingerprint: string;
  configurationHash: string;
  activeGeneration: string;
  lexicalReady: boolean;
  semanticReady: boolean;
  builtAt: string;
  /** SHA-256 of the snapshot payload bytes; verified on restore. */
  snapshotSha256?: string;
  provenance?: {
    source: "browser" | "publisher";
    pageOrigin?: string;
  };
}

export interface SnapshotObjectRecord {
  key: string;
  kind: "full" | "incremental";
  digest: string;
  bytes: number;
  metadata: SnapshotCompatibility;
}

export function snapshotStorageKey(compatibilityKey: string): string {
  return `search-${compatibilityKey}`;
}

export function snapshotMetadataKey(compatibilityKey: string): string {
  return `search-${compatibilityKey}.meta`;
}

/** Stable hash inputs for the compatibility key (caller supplies already-hex digests). */
export async function computeCompatibilityKey(parts: {
  kernelSha256: string;
  imageSha256: string;
  schemaSha256: string;
  modelFingerprint: string;
  configurationHash: string;
  searchdProtocol?: number;
}): Promise<string> {
  const material = [
    `fmt=${SNAPSHOT_FORMAT_VERSION}`,
    `svc=${parts.searchdProtocol ?? SEARCHD_PROTOCOL_VERSION}`,
    `kernel=${parts.kernelSha256}`,
    `image=${parts.imageSha256}`,
    `schema=${parts.schemaSha256}`,
    `model=${parts.modelFingerprint}`,
    `cfg=${parts.configurationHash}`,
  ].join("|");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

export async function hashConfiguration(value: unknown): Promise<string> {
  const json = JSON.stringify(value);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
