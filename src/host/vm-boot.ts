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
import type { SnapshotCompatibility } from "../protocol/snapshot.js";

export interface McCoreModule extends McToolModule {
  mc: {
    create(options: Record<string, unknown>): Promise<SearchVm>;
    restore(snapshot: Uint8Array, options: Record<string, unknown>): Promise<SearchVm>;
  };
  OpfsContentStore: {
    open(name: string): Promise<ContentStore>;
  };
}

export interface ContentStore {
  get?(key: string): Promise<Uint8Array | null | undefined>;
  put?(key: string, bytes: Uint8Array): Promise<void>;
  putBlob?(key: string, bytes: Uint8Array): Promise<void>;
  putSnapshotObject?(key: string, bytes: Uint8Array, meta?: unknown): Promise<void>;
  getSnapshotObject?(key: string): Promise<Uint8Array | null | undefined>;
  delete?(key: string): Promise<void>;
}

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
  snapshot(): Promise<Uint8Array>;
  close(): Promise<void>;
  inflightEgress?(): Promise<number>;
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
  if (store.getSnapshotObject) {
    const value = await store.getSnapshotObject(key);
    if (value) return value;
  }
  if (store.get) {
    const value = await store.get(key);
    if (value) return value;
  }
  return null;
}

async function loadSnapshotMeta(store: ContentStore, key: string): Promise<SnapshotCompatibility | null> {
  if (!store.get) return null;
  const raw = await store.get(key);
  if (!raw) return null;
  try {
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    return JSON.parse(text) as SnapshotCompatibility;
  } catch {
    return null;
  }
}

export async function persistSnapshot(
  store: ContentStore,
  key: string,
  metaKey: string,
  bytes: Uint8Array,
  meta: SnapshotCompatibility,
): Promise<void> {
  if (store.putSnapshotObject) {
    await store.putSnapshotObject(key, bytes, meta);
  } else if (store.putBlob) {
    await store.putBlob(key, bytes);
  } else if (store.put) {
    await store.put(key, bytes);
  }
  if (store.put) {
    await store.put(metaKey, new TextEncoder().encode(JSON.stringify(meta)));
  }
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
  const common = {
    runtime: "browser",
    kernel: options.assets.kernel,
    catalogCompiler: options.assets.catalogCompiler,
    store,
    tools,
    deterministic: true,
    restoreAttachments: "strict" as const,
  };

  let restored = false;
  let snapshotMeta: SnapshotCompatibility | null = null;
  let restoreError: string | undefined;
  let vm: SearchVm | null = null;

  if (options.snapshotKey) {
    const snap = await loadSnapshotBytes(store, options.snapshotKey);
    snapshotMeta = options.snapshotMetaKey
      ? await loadSnapshotMeta(store, options.snapshotMetaKey)
      : null;
    if (
      options.expectedCompatibilityKey &&
      snapshotMeta &&
      snapshotMeta.compatibilityKey !== options.expectedCompatibilityKey
    ) {
      restoreError = "snapshot compatibility key mismatch";
      snapshotMeta = null;
    } else if (snap && snap.byteLength > 0) {
      if (snapshotMeta?.snapshotSha256) {
        const copy = new Uint8Array(snap);
        const digest = await crypto.subtle.digest("SHA-256", copy);
        const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
        if (hash !== snapshotMeta.snapshotSha256) {
          restoreError = "snapshot payload digest mismatch";
          snapshotMeta = null;
        }
      }
      if (!restoreError) {
        try {
          vm = await mc.restore(snap, {
            ...common,
            image: options.assets.image,
          });
          restored = true;
        } catch (error) {
          vm = null;
          restored = false;
          restoreError = error instanceof Error ? error.message : "snapshot restore failed";
        }
      }
    }
  }

  if (!vm) {
    vm = await mc.create({
      ...common,
      image: options.assets.image,
    });
  }

  // Ensure product state dir exists; searchd owns dual-DB under /var/searchd.
  await vm.fs.mkdir?.("/var/searchd", true);

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
