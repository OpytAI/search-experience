/**
 * Boot or restore the AgentOS search machine with host tools attached.
 */

import { buildSearchHostTools, type HostToolRuntime, type McToolModule } from "../host-tools/register.js";
import {
  createEmbedToolState,
  configureEmbedTool,
  type EmbedderFactory,
} from "../host-tools/embed.js";
import type { MixedbreadEmbedderOptions } from "../embedding/text.js";
import {
  decodeMcsnPayload,
  encodeMcsnPayload,
  isGzipBytes,
  MCSN_PAYLOAD_ENCODING,
} from "../protocol/mcsn-codec.js";
import { mcsnKindFromBytes, type SnapshotCompatibility } from "../protocol/snapshot.js";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface McCoreModule extends McToolModule {
  mc: {
    create(options: Record<string, unknown>): Promise<SearchVm>;
    restore(snapshot: Uint8Array, options: Record<string, unknown>): Promise<SearchVm>;
  };
  OpfsContentStore: {
    open(name: string): Promise<ContentStore>;
  };
}

/**
 * Subset of AgentOS ContentStore used for OPFS warm snapshots.
 * Keyed snapshots: `snapshot` / `putSnapshot`.
 * Content-addressed MCSN: `snapshotObject` / `putSnapshotObject` (digest in, digest out).
 */
export interface ContentStore {
  /** Keyed snapshot read (AgentOS OpfsContentStore.snapshot). */
  snapshot?(key: string): Promise<Uint8Array | null | undefined>;
  /** Keyed snapshot write. */
  putSnapshot?(key: string, bytes: Uint8Array): Promise<void>;
  /** Content-addressed full MCSN read by sha256:… digest. */
  snapshotObject?(digest: string): Promise<Uint8Array | null | undefined>;
  /** Content-addressed full MCSN write; returns digest. */
  putSnapshotObject?(bytes: Uint8Array): Promise<string>;
  /** Generic blob helpers (optional; not used for keyed OPFS warm path). */
  get?(key: string): Promise<Uint8Array | null | undefined>;
  put?(key: string, bytes: Uint8Array): Promise<void>;
  putBlob?(bytes: Uint8Array): Promise<string>;
  delete?(key: string): Promise<void>;
}

export type McsnCaptureMode = "full" | "incremental";

export interface SearchVm {
  /** Required for production search-atlas (/svc/searchd). */
  serviceCall(name: string, req: Uint8Array): Promise<Uint8Array>;
  fs: {
    write(path: string, data: string | Uint8Array): Promise<void> | void;
    read(path: string): Promise<Uint8Array | string> | Uint8Array | string;
    mkdir?(path: string, recursive?: boolean): Promise<void> | void;
  };
  /** Optional: not used by production search (serviceCall-only). */
  luau?(src: string, args?: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Capture a full MCSN (self-contained warm machine image). */
  snapshot(opts?: { mode?: McsnCaptureMode }): Promise<Uint8Array>;
  close(): Promise<void>;
  inflightEgress?(): Promise<number>;
}

export interface CapturedMcsn {
  bytes: Uint8Array;
  kind: "full";
}

export interface BootAssets {
  kernel: Uint8Array;
  image: Uint8Array;
  catalogCompiler?: Uint8Array;
  schemaSql: string;
}

export interface BootOptions {
  mcCore: McCoreModule;
  assets: BootAssets;
  storeName?: string;
  allowedOrigins: ReadonlySet<string>;
  allowPrivateAddresses?: boolean;
  embedOptions?: MixedbreadEmbedderOptions | null;
  /** Factory from hermetic agentos-search-embed.mjs (no bare npm import in runtime). */
  embedderFactory?: EmbedderFactory | null;
  modelFingerprint?: string;
  snapshotKey?: string;
  snapshotMetaKey?: string;
  expectedCompatibilityKey?: string;
  /**
   * Optional prewarmed MCSN bytes from the release package (manifest.assets.snapshot).
   * Used when OPFS has no compatible snapshot. Strict reattachment still applies.
   */
  prewarmedSnapshot?: Uint8Array | null;
  /** Compatibility metadata for prewarmedSnapshot (manifest.assets.snapshotMetadata). */
  prewarmedSnapshotMeta?: SnapshotCompatibility | null;
}

export interface BootResult {
  vm: SearchVm;
  store: ContentStore;
  runtime: HostToolRuntime;
  restored: boolean;
  snapshotMeta: SnapshotCompatibility | null;
  restoreError?: string;
}

async function loadSnapshotBytes(store: ContentStore, key: string): Promise<Uint8Array | null> {
  // Prefer keyed OPFS snapshot API (compatibility-keyed warm path).
  if (store.snapshot) {
    const value = await store.snapshot(key);
    if (value && value.byteLength > 0) return value;
  }
  if (store.get) {
    const value = await store.get(key);
    if (value && value.byteLength > 0) return value;
  }
  return null;
}

async function loadSnapshotMeta(store: ContentStore, key: string): Promise<SnapshotCompatibility | null> {
  let raw: Uint8Array | null | undefined;
  if (store.snapshot) {
    raw = await store.snapshot(key);
  }
  if ((!raw || raw.byteLength === 0) && store.get) {
    raw = await store.get(key);
  }
  if (!raw || raw.byteLength === 0) return null;
  try {
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    return JSON.parse(text) as SnapshotCompatibility;
  } catch {
    return null;
  }
}

export type PersistedSnapshot = {
  /** Gzip payload written to OPFS (also suitable for export / prewarm). */
  encoded: Uint8Array;
  meta: SnapshotCompatibility;
};

/** Persist a raw MCSN capture as gzip on OPFS. */
export async function persistSnapshot(
  store: ContentStore,
  key: string,
  metaKey: string,
  rawMcsn: Uint8Array,
  meta: SnapshotCompatibility,
): Promise<PersistedSnapshot> {
  const encoded = await encodeMcsnPayload(rawMcsn);
  const storedMeta: SnapshotCompatibility = {
    ...meta,
    encoding: MCSN_PAYLOAD_ENCODING,
    uncompressedBytes: rawMcsn.byteLength,
    snapshotSha256: await sha256Hex(encoded),
    mcsnKind: meta.mcsnKind ?? mcsnKindFromBytes(rawMcsn),
  };
  // AgentOS: putSnapshot(key, bytes) is the keyed warm path.
  // putSnapshotObject(bytes) is content-addressed and must NOT receive a string key
  // (that was the "invalid snapshot: too_short" bug — parseSnapshot on a key string).
  if (store.putSnapshot) {
    await store.putSnapshot(key, encoded);
  } else if (store.put) {
    await store.put(key, encoded);
  } else if (store.putSnapshotObject) {
    // Last resort: CAS only (caller cannot re-load by compatibility key without digest).
    await store.putSnapshotObject(encoded);
  }
  const metaBytes = new TextEncoder().encode(JSON.stringify(storedMeta));
  if (store.putSnapshot) {
    await store.putSnapshot(metaKey, metaBytes);
  } else if (store.put) {
    await store.put(metaKey, metaBytes);
  }
  return { encoded, meta: storedMeta };
}

/** Decode a stored OPFS/prewarm payload to raw MCSN for `mc.restore`. */
export async function decodeStoredMcsn(
  stored: Uint8Array,
  meta: SnapshotCompatibility | null,
): Promise<Uint8Array> {
  if (!meta || meta.encoding !== MCSN_PAYLOAD_ENCODING) {
    throw new Error("snapshot missing gzip encoding");
  }
  if (!isGzipBytes(stored)) {
    throw new Error("snapshot payload is not gzip-encoded");
  }
  if (meta.snapshotSha256) {
    const hash = await sha256Hex(stored);
    if (hash !== meta.snapshotSha256) {
      throw new Error("snapshot payload digest mismatch");
    }
  }
  return decodeMcsnPayload(stored);
}

export async function bootSearchVm(options: BootOptions): Promise<BootResult> {
  const { mc, OpfsContentStore } = options.mcCore;
  const store = await OpfsContentStore.open(options.storeName ?? "agentos-search");
  const runtime: HostToolRuntime = {
    fetchOptions: {
      allowedOrigins: options.allowedOrigins,
      allowPrivateAddresses: options.allowPrivateAddresses === true,
    },
    embed: createEmbedToolState(),
  };
  if (options.embedOptions && options.modelFingerprint) {
    configureEmbedTool(
      runtime.embed,
      options.embedOptions,
      options.modelFingerprint,
      options.embedderFactory ?? null,
    );
  }

  const tools = buildSearchHostTools(options.mcCore, runtime);
  // Host tools (fetch/extract/embed) are MapHostCall handlers; CAP_NET on guest
  // services still requires net capability plumbing for tools→host_call in some
  // AgentOS builds. Allow network for same-origin crawl origins (filtered by
  // host tool allowlist, not open egress).
  const originHosts = [...options.allowedOrigins].map((o) => {
    try {
      return new URL(o).hostname;
    } catch {
      return "";
    }
  }).filter(Boolean);
  const common = {
    runtime: "browser",
    kernel: options.assets.kernel,
    catalogCompiler: options.assets.catalogCompiler,
    store,
    tools,
    deterministic: true,
    restoreAttachments: "strict" as const,
    // Full MCSN only: no boot template full for incremental baselines.
    templateFill: "off" as const,
    net: true,
    permissions: {
      network: {
        // Allowlisted hosts only — product host-tool policy still enforces origins.
        allow: originHosts,
      },
    },
  };

  let restored = false;
  let snapshotMeta: SnapshotCompatibility | null = null;
  let restoreError: string | undefined;
  let vm: SearchVm | null = null;

  async function tryRestore(
    snap: Uint8Array,
    meta: SnapshotCompatibility | null,
    source: "opfs" | "prewarmed",
  ): Promise<void> {
    if (snap.byteLength === 0) return;
    if (
      options.expectedCompatibilityKey &&
      meta &&
      meta.compatibilityKey !== options.expectedCompatibilityKey
    ) {
      restoreError = `${source} snapshot compatibility key mismatch`;
      return;
    }
    try {
      const raw = await decodeStoredMcsn(snap, meta);
      vm = await mc.restore(raw, {
        ...common,
        image: options.assets.image,
      });
      restored = true;
      snapshotMeta = meta;
      restoreError = undefined;
    } catch (error) {
      vm = null;
      restored = false;
      restoreError = error instanceof Error ? error.message : `${source} snapshot restore failed`;
    }
  }

  // Prefer OPFS-resident snapshot; fall back to optional release prewarmed bytes.
  if (options.snapshotKey) {
    const snap = await loadSnapshotBytes(store, options.snapshotKey);
    const meta = options.snapshotMetaKey
      ? await loadSnapshotMeta(store, options.snapshotMetaKey)
      : null;
    if (snap && snap.byteLength > 0) {
      await tryRestore(snap, meta, "opfs");
    }
  }

  if (!vm && options.prewarmedSnapshot && options.prewarmedSnapshot.byteLength > 0) {
    await tryRestore(
      options.prewarmedSnapshot,
      options.prewarmedSnapshotMeta ?? null,
      "prewarmed",
    );
  }

  if (!vm) {
    vm = await mc.create({
      ...common,
      image: options.assets.image,
    });
  }

  // Ensure product state dir exists; searchd owns dual-DB under /var/searchd.
  // Image already ships var/ + var/searchd/; tolerate EEXIST / already-present.
  try {
    await vm.fs.mkdir?.("/var", true);
  } catch {
    /* parent may already exist from search-atlas product_dirs */
  }
  try {
    await vm.fs.mkdir?.("/var/searchd", true);
  } catch {
    /* leaf may already exist; searchd fsutil also mkdir-tolerantly */
  }

  return { vm, store, runtime, restored, snapshotMeta, restoreError };
}

/** Returns true only when egress is zero (or API absent). */
export async function waitForQuiescence(vm: SearchVm, timeoutMs = 5_000): Promise<boolean> {
  if (!vm.inflightEgress) return true;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const n = await vm.inflightEgress();
    if (n === 0) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/**
 * Capture a **full** MCSN (self-contained machine image).
 * Full is the shipping/prewarm format: one file, no separate CAS baseline.
 */
export async function captureMcsn(vm: SearchVm, _store?: ContentStore): Promise<CapturedMcsn> {
  const bytes = await vm.snapshot({ mode: "full" });
  const kind = mcsnKindFromBytes(bytes);
  if (kind !== "full") {
    throw new Error(`expected full MCSN, got ${kind}`);
  }
  return { bytes, kind: "full" };
}
