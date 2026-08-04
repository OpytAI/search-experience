/**
 * Dedicated module worker for AgentOS site search.
 *
 * Owns: asset load, VM create/restore, host tools, page protocol, snapshots.
 * Does not own: crawl plan, ranking, schema policy — those are searchd.
 */

import type { BrowserCrawlDefinition } from "../protocol/collections.js";
import { validateManifest, type SearchExperienceManifest } from "../protocol/manifest.js";
import type { PageToRuntimeMessage, RuntimeToPageMessage } from "../protocol/page-runtime.js";
import {
  nextSearchdId,
  type SearchdResponse,
  type SearchdStatusBody,
} from "../protocol/searchd.js";
import {
  computeCompatibilityKey,
  hashConfiguration,
  snapshotMetadataKey,
  snapshotStorageKey,
  type SnapshotCompatibility,
} from "../protocol/snapshot.js";
import {
  SEARCH_PROTOCOL_VERSION,
  SEARCHD_PROTOCOL_VERSION,
  SNAPSHOT_FORMAT_VERSION,
} from "../protocol/versions.js";
import {
  configureResumeAllowed,
  decideResume,
  evaluateSearchdStatusProbe,
  semanticClaimAllowed,
} from "../host/reattach-checks.js";
import { SearchdClient } from "../host/searchd-client.js";
import { hitsToItems } from "../host/hits.js";
import {
  bootSearchVm,
  captureMcsn,
  persistSnapshot,
  waitForQuiescence,
  type McCoreModule,
  type SearchVm,
  type ContentStore,
} from "../host/vm-boot.js";
import { encodeMcsnPayload, MCSN_PAYLOAD_ENCODING } from "../protocol/mcsn-codec.js";
import type { HostToolRuntime } from "../host-tools/register.js";
import { isPrivateHostname } from "../host-tools/fetch.js";
import { isSameOrigin } from "../security/urls.js";

import {
  sha256,
  verifiedBytes,
  verifiedText,
  importMcCore,
  verifyModelAssets,
} from "./assets.js";
import { buildDiagnostics } from "./diagnostics.js";
import { withIndexLock } from "./indexing-lock.js";

function post(message: RuntimeToPageMessage): void {
  self.postMessage(message);
}

let manifest: SearchExperienceManifest | undefined;
let pageOrigin = "";
let vm: SearchVm | undefined;
let store: ContentStore | undefined;
let searchd: SearchdClient | undefined;
let hostRuntime: HostToolRuntime | undefined;
let compatibilityKey = "";
let configHash = "";
let snapshotKey = "";
let snapshotMetaKey = "";
let kernelSha = "";
let imageSha = "";
let schemaSha = "";
let modelFingerprint = "";
let schemaSql = "";
let indexPromise: Promise<void> | undefined;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let configuredRefreshAfterMs: number | undefined;
let initCompleted = false;
let lastStatus: SearchdStatusBody | undefined;
let lastRestoreError: string | undefined;
/** Wall time from init start to ready/indexing kickoff (ms). */
let bootMs: number | undefined;
/** Last successful or failed query latency in this worker (ms). */
let lastQueryMs: number | undefined;
/** Status probe succeeded after boot (serviceCall path alive). */
let statusProbeOk = false;
const cancelled = new Set<string>();
const MAX_CANCELLED = 256;

function trackCancel(id: string): void {
  cancelled.add(id);
  if (cancelled.size > MAX_CANCELLED) {
    const first = cancelled.values().next().value;
    if (first) cancelled.delete(first);
  }
}

async function callSearchd(
  request: Parameters<SearchdClient["call"]>[0],
  timeoutMs?: number,
): Promise<SearchdResponse> {
  if (!searchd) throw new Error("searchd client is not ready");
  const response = await searchd.call(request, timeoutMs);
  if (response.ok && response.status) lastStatus = response.status;
  return response;
}

function scheduleRefresh(refreshAfterMs: number | undefined = configuredRefreshAfterMs): void {
  if (refreshTimer !== undefined) {
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
  }
  if (refreshAfterMs !== undefined) configuredRefreshAfterMs = refreshAfterMs;
  const ms = configuredRefreshAfterMs;
  if (!ms || ms <= 0 || !Number.isFinite(ms)) return;
  const delay = Math.min(Math.max(ms, 60_000), 7 * 24 * 60 * 60 * 1_000);
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    void handleRefresh({
      protocol: SEARCH_PROTOCOL_VERSION,
      type: "refresh",
      requestId: nextSearchdId("auto-refresh"),
    }).finally(() => {
      // Re-arm for the next interval after each completed (or failed) refresh cycle.
      scheduleRefresh();
    });
  }, delay);
}

/**
 * Exclusive index mutation across tabs.
 *
 * Leader holds navigator.locks `agentos-search-index` for the entire
 * driveCrawl / driveEmbed / handleRefresh path (guest promote on candidate
 * completion runs under that same crawl). Readers (query/status/diagnostics)
 * never acquire the lock, so they keep serving the active generation while
 * another tab rebuilds a candidate — avoiding double-promote races on shared
 * OPFS candidate.db / index.db.
 */
function runIndexing(task: () => Promise<void>): Promise<void> {
  const start = (): Promise<void> => {
    if (indexPromise) return indexPromise;
    indexPromise = task().finally(() => {
      indexPromise = undefined;
    });
    return indexPromise;
  };
  return withIndexLock(start);
}

async function driveCrawl(): Promise<void> {
  if (!searchd) return;
  post({
    protocol: SEARCH_PROTOCOL_VERSION,
    type: "status",
    phase: "crawling",
    message: "Crawling site…",
    lexicalReady: lastStatus?.lexicalReady,
  });
  for (let i = 0; i < 500; i++) {
    const response = await callSearchd({
      v: SEARCHD_PROTOCOL_VERSION,
      op: "crawl_step",
      id: nextSearchdId("crawl"),
      maxFetches: 4,
    });
    if (!response.ok) {
      post({
        protocol: SEARCH_PROTOCOL_VERSION,
        type: "status",
        phase: "error",
        message: response.error,
      });
      return;
    }
    if (response.progress?.done) break;
    if (response.status?.lexicalReady) {
      post({
        protocol: SEARCH_PROTOCOL_VERSION,
        type: "status",
        phase: response.status.phase || "lexical_ready",
        message: response.status.message ?? "Lexical search ready",
        lexicalReady: true,
        semanticReady: response.status.semanticReady,
      });
    }
  }
  await callSearchd({
    v: SEARCHD_PROTOCOL_VERSION,
    op: "checkpoint",
    id: nextSearchdId("ckpt"),
    kind: "lexical",
  });
  await captureSnapshot("lexical");
  post({
    protocol: SEARCH_PROTOCOL_VERSION,
    type: "status",
    phase: lastStatus?.phase ?? "lexical_ready",
    message: lastStatus?.message ?? "Lexical index ready",
    lexicalReady: true,
  });
}

async function driveEmbed(): Promise<void> {
  if (!searchd) return;
  post({
    protocol: SEARCH_PROTOCOL_VERSION,
    type: "status",
    phase: "embedding",
    message: "Building semantic index…",
    lexicalReady: true,
  });
  for (let i = 0; i < 200; i++) {
    const response = await callSearchd({
      v: SEARCHD_PROTOCOL_VERSION,
      op: "embed_step",
      id: nextSearchdId("embed"),
      maxChunks: 8,
    });
    if (!response.ok) {
      post({
        protocol: SEARCH_PROTOCOL_VERSION,
        type: "status",
        phase: "lexical_ready",
        message: response.error,
        lexicalReady: true,
        semanticReady: false,
      });
      break;
    }
    if (response.status?.message && !response.status.semanticReady) {
      post({
        protocol: SEARCH_PROTOCOL_VERSION,
        type: "status",
        phase: response.status.phase,
        message: response.status.message,
        lexicalReady: true,
        semanticReady: false,
      });
    }
    if (response.progress?.done) break;
  }
  await callSearchd({
    v: SEARCHD_PROTOCOL_VERSION,
    op: "checkpoint",
    id: nextSearchdId("ckpt"),
    kind: "semantic",
  });
  await captureSnapshot("semantic");
  post({
    protocol: SEARCH_PROTOCOL_VERSION,
    type: "status",
    phase: lastStatus?.phase ?? "semantic_ready",
    message: lastStatus?.message ?? "Search ready",
    lexicalReady: true,
    semanticReady: lastStatus?.semanticReady,
  });
}

function buildSnapshotMeta(
  kind: "lexical" | "semantic",
  source: "browser" | "publisher" = "browser",
  mcsn?: { kind: "full" | "incremental" },
): SnapshotCompatibility {
  return {
    format: SNAPSHOT_FORMAT_VERSION,
    compatibilityKey,
    searchdProtocol: SEARCHD_PROTOCOL_VERSION,
    kernelSha256: kernelSha,
    imageSha256: imageSha,
    schemaSha256: schemaSha,
    modelFingerprint,
    configurationHash: configHash,
    activeGeneration: lastStatus?.activeGeneration ?? "gen-1",
    lexicalReady: Boolean(lastStatus?.lexicalReady) || kind === "lexical" || kind === "semantic",
    semanticReady: kind === "semantic" || Boolean(lastStatus?.semanticReady),
    builtAt: new Date().toISOString(),
    encoding: MCSN_PAYLOAD_ENCODING,
    mcsnKind: mcsn?.kind ?? "full",
    provenance: { source, pageOrigin: pageOrigin || undefined },
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function captureSnapshot(kind: "lexical" | "semantic"): Promise<void> {
  if (!vm || !store || !compatibilityKey) return;
  try {
    const quiet = await waitForQuiescence(vm, 5_000);
    if (!quiet) {
      console.warn("search snapshot skipped: guest egress not quiescent");
      return;
    }
    const captured = await captureMcsn(vm, store);
    const meta = buildSnapshotMeta(kind, "browser", { kind: captured.kind });
    // persistSnapshot gzip-encodes and stamps snapshotSha256 on stored meta.
    await persistSnapshot(store, snapshotKey, snapshotMetaKey, captured.bytes, meta);
  } catch {
    console.warn("search snapshot failed");
  }
}

/** Export MCSN bytes + meta to the page (publisher / e2e). */
async function handleExportSnapshot(
  message: Extract<PageToRuntimeMessage, { type: "exportSnapshot" }>,
): Promise<void> {
  if (!vm || !compatibilityKey || !store) {
    post({
      protocol: SEARCH_PROTOCOL_VERSION,
      type: "error",
      requestId: message.requestId,
      code: "not_ready",
      message: "exportSnapshot requires an initialized VM",
    });
    return;
  }
  try {
    const quiet = await waitForQuiescence(vm, 8_000);
    if (!quiet) {
      post({
        protocol: SEARCH_PROTOCOL_VERSION,
        type: "error",
        requestId: message.requestId,
        code: "busy",
        message: "guest egress not quiescent",
      });
      return;
    }
    const captured = await captureMcsn(vm, store);
    const kind = lastStatus?.semanticReady ? "semantic" : "lexical";
    const baseMeta = buildSnapshotMeta(kind, "publisher", { kind: captured.kind });
    let encoded: Uint8Array;
    let meta: SnapshotCompatibility;
    if (snapshotKey && snapshotMetaKey) {
      const persisted = await persistSnapshot(
        store,
        snapshotKey,
        snapshotMetaKey,
        captured.bytes,
        baseMeta,
      );
      encoded = persisted.encoded;
      meta = persisted.meta;
    } else {
      encoded = await encodeMcsnPayload(captured.bytes);
      meta = {
        ...baseMeta,
        encoding: MCSN_PAYLOAD_ENCODING,
        uncompressedBytes: captured.bytes.byteLength,
        snapshotSha256: await sha256(encoded),
      };
    }
    post({
      protocol: SEARCH_PROTOCOL_VERSION,
      type: "snapshot",
      requestId: message.requestId,
      snapshotBase64: bytesToBase64(encoded),
      meta,
    });
  } catch (error) {
    post({
      protocol: SEARCH_PROTOCOL_VERSION,
      type: "error",
      requestId: message.requestId,
      code: "snapshot_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function init(message: Extract<PageToRuntimeMessage, { type: "init" }>): Promise<void> {
  if (initCompleted) {
    post({
      protocol: SEARCH_PROTOCOL_VERSION,
      type: "status",
      requestId: message.requestId,
      phase: lastStatus?.phase ?? "ready",
      message: "Already initialized",
      lexicalReady: lastStatus?.lexicalReady,
      semanticReady: lastStatus?.semanticReady,
    });
    if (lastStatus?.collections) {
      post({
        protocol: SEARCH_PROTOCOL_VERSION,
        type: "ready",
        requestId: message.requestId,
        collections: lastStatus.collections,
        phase: lastStatus.phase,
      });
    }
    return;
  }

  const bootStartedAt = Date.now();

  post({
    protocol: SEARCH_PROTOCOL_VERSION,
    type: "status",
    requestId: message.requestId,
    phase: "loading",
    message: "Loading search assets…",
  });

  pageOrigin = message.pageOrigin;
  configuredRefreshAfterMs = message.refreshAfterMs;
  const manifestJson = await (await fetch(message.manifestUrl, { cache: "no-cache" })).json();
  manifest = validateManifest(manifestJson);

  // Asset resolution base: integrator assetBase when set, else the manifest URL directory.
  const base = message.assetBase || message.manifestUrl;
  post({
    protocol: SEARCH_PROTOCOL_VERSION,
    type: "status",
    requestId: message.requestId,
    phase: "booting",
    message: "Booting AgentOS search machine…",
  });

  // Integrity failure rejects init (fail closed) — verifiedBytes throws.
  const [kernel, image, schemaText] = await Promise.all([
    verifiedBytes(base, manifest.assets.kernel, "kernel"),
    verifiedBytes(base, manifest.assets.image, "image"),
    verifiedText(base, manifest.assets.schema, "schema"),
  ]);
  schemaSql = schemaText;
  kernelSha = manifest.assets.kernel.sha256;
  imageSha = manifest.assets.image.sha256;
  schemaSha = manifest.assets.schema.sha256;
  modelFingerprint = manifest.model?.fingerprint ?? "none";

  const mcCore = await importMcCore(base, manifest.assets.mcCore);

  let catalogCompiler: Uint8Array | undefined;
  if (manifest.assets.catalogCompiler) {
    catalogCompiler = await verifiedBytes(base, manifest.assets.catalogCompiler, "catalogCompiler");
  }

  configHash = await hashConfiguration({
    collections: message.collections,
    pageOrigin: message.pageOrigin,
    modelFingerprint,
  });
  compatibilityKey = await computeCompatibilityKey({
    kernelSha256: kernelSha,
    imageSha256: imageSha,
    schemaSha256: schemaSha,
    modelFingerprint,
    configurationHash: configHash,
  });
  snapshotKey = snapshotStorageKey(compatibilityKey);
  snapshotMetaKey = snapshotMetadataKey(compatibilityKey);

  // Crawl allowlist: page origin only (strict same-origin for any extra configured origins).
  const allowedOrigins = new Set<string>([message.pageOrigin]);
  for (const collection of message.collections) {
    for (const origin of collection.origins ?? []) {
      if (isSameOrigin(origin, message.pageOrigin)) {
        allowedOrigins.add(new URL(origin).origin);
      }
    }
  }

  if (manifest.model) {
    await verifyModelAssets(base, manifest.model);
  }

  // Load hermetic embed factory from the shipped agentos-search-embed.mjs (transformers
  // is statically bundled there — never bare-import npm from the runtime worker).
  let embedderFactory: import("../host-tools/embed.js").EmbedderFactory | null = null;
  if (manifest.model && manifest.assets.embedder) {
    const embedBytes = await verifiedBytes(base, manifest.assets.embedder, "embedder");
    const copy = new Uint8Array(embedBytes.byteLength);
    copy.set(embedBytes);
    const blobUrl = URL.createObjectURL(new Blob([copy], { type: "text/javascript" }));
    try {
      const embedMod = await import(/* @vite-ignore */ blobUrl) as {
        createMixedbreadEmbedder?: import("../host-tools/embed.js").EmbedderFactory;
        createEmbedder?: import("../host-tools/embed.js").EmbedderFactory;
      };
      const factory = embedMod.createMixedbreadEmbedder ?? embedMod.createEmbedder;
      if (!factory) throw new Error("agentos-search-embed.mjs missing createEmbedder export");
      embedderFactory = factory;
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }

  const embedOptions = manifest.model
    ? {
        assetBase: new URL("model/", base),
        assets: manifest.model.assets,
        runtimeModule: manifest.model.assets.runtimeModule
          ? new URL(manifest.model.assets.runtimeModule.url, base)
          : undefined,
        runtimeWasm: manifest.model.assets.runtimeWasm
          ? new URL(manifest.model.assets.runtimeWasm.url, base)
          : undefined,
      }
    : null;

  // Optional release-package prewarm (manifest.assets.snapshot): seed restore when OPFS is empty.
  let prewarmedSnapshot: Uint8Array | null = null;
  let prewarmedSnapshotMeta: SnapshotCompatibility | null = null;
  if (manifest.assets.snapshot) {
    try {
      prewarmedSnapshot = await verifiedBytes(base, manifest.assets.snapshot, "snapshot");
      if (manifest.assets.snapshotMetadata) {
        const metaText = await verifiedText(base, manifest.assets.snapshotMetadata, "snapshotMetadata");
        prewarmedSnapshotMeta = JSON.parse(metaText) as SnapshotCompatibility;
      }
    } catch {
      console.warn("prewarmed snapshot asset load failed; continuing with OPFS/cold boot");
      prewarmedSnapshot = null;
      prewarmedSnapshotMeta = null;
    }
  }

  const boot = await bootSearchVm({
    mcCore,
    assets: {
      kernel,
      image,
      catalogCompiler,
      schemaSql,
    },
    allowedOrigins,
    // Same-origin private/loopback page origins must fetch their own site.
    allowPrivateAddresses: (() => {
      try {
        return isPrivateHostname(new URL(message.pageOrigin).hostname);
      } catch {
        return false;
      }
    })(),
    embedOptions,
    embedderFactory,
    modelFingerprint,
    snapshotKey,
    snapshotMetaKey,
    expectedCompatibilityKey: compatibilityKey,
    prewarmedSnapshot,
    prewarmedSnapshotMeta,
  });
  vm = boot.vm;
  store = boot.store;
  hostRuntime = boot.runtime;
  lastRestoreError = boot.restoreError;
  if (boot.restoreError) {
    post({
      protocol: SEARCH_PROTOCOL_VERSION,
      type: "status",
      requestId: message.requestId,
      phase: "booting",
      message: "Warm snapshot unavailable; cold boot",
    });
  }
  searchd = new SearchdClient(vm, "serviceCall");

  // Strict reattachment: prove serviceCall("searchd", status) works before ready.
  const probeResponse = await callSearchd({
    v: SEARCHD_PROTOCOL_VERSION,
    op: "status",
    id: nextSearchdId("probe"),
  });
  const probe = evaluateSearchdStatusProbe(
    probeResponse.ok
      ? { ok: true, status: probeResponse.status }
      : { ok: false, error: probeResponse.error },
  );
  statusProbeOk = probe.probeOk;
  if (!probe.probeOk) {
    throw new Error(
      `searchd reattachment failed: ${probe.error ?? "status probe failed"} — refusing ready`,
    );
  }

  const resumeDecision = decideResume({
    restored: boot.restored,
    expectedCompatibilityKey: compatibilityKey,
    snapshotMeta: boot.snapshotMeta,
    restoreError: boot.restoreError,
    expectedKernelSha256: kernelSha,
    expectedImageSha256: imageSha,
  });
  // Fail closed: never resume after failed restore or bad compatibility.
  const resume = configureResumeAllowed(
    resumeDecision.resume,
    Boolean(boot.restoreError) || !boot.restored,
    resumeDecision.resume,
  );

  const configure = await callSearchd({
    v: SEARCHD_PROTOCOL_VERSION,
    op: "configure",
    id: nextSearchdId("cfg"),
    config: {
      collections: message.collections,
      schemaSql,
      modelFingerprint,
      compatibilityKey,
      pageOrigin: message.pageOrigin,
      refreshAfterMs: message.refreshAfterMs,
      indexPath: manifest.sqlite.indexPath,
      resume,
    },
  });
  if (!configure.ok) {
    // Fail closed on configure errors (including bad compatibility on cold path).
    throw new Error(
      resume
        ? `searchd configure failed on resume: ${configure.error}`
        : `searchd configure failed (cold/fail-closed): ${configure.error}`,
    );
  }

  bootMs = Date.now() - bootStartedAt;

  if (resume && configure.status?.lexicalReady) {
    // Trust guest semantic claim only via successful status/configure body.
    const semanticReady = semanticClaimAllowed(true, configure.status);
    lastStatus = {
      ...configure.status,
      semanticReady,
    };
    post({
      protocol: SEARCH_PROTOCOL_VERSION,
      type: "ready",
      requestId: message.requestId,
      collections: configure.status.collections,
      phase: configure.status.phase,
    });
    if (!semanticReady) {
      void runIndexing(async () => {
        await driveEmbed();
      });
    }
    initCompleted = true;
    scheduleRefresh(message.refreshAfterMs);
    return;
  }

  // Cold path (or resume rejected): do not claim semantic ready from stale probe.
  if (configure.status) {
    lastStatus = {
      ...configure.status,
      lexicalReady: Boolean(configure.status.lexicalReady),
      semanticReady: semanticClaimAllowed(true, configure.status),
    };
  }

  post({
    protocol: SEARCH_PROTOCOL_VERSION,
    type: "ready",
    requestId: message.requestId,
    collections: configure.status?.collections ?? message.collections.map((c: BrowserCrawlDefinition) => ({
      id: c.id,
      label: c.label,
      order: c.order ?? 10,
      capabilities: ["lexical"] as const,
      minQueryLength: c.minQueryLength ?? 1,
      limit: c.limit ?? 10,
    })),
    phase: "crawling",
  });

  initCompleted = true;
  void runIndexing(async () => {
    await driveCrawl();
    await driveEmbed();
    scheduleRefresh(message.refreshAfterMs);
  });
}

async function handleQuery(message: Extract<PageToRuntimeMessage, { type: "query" }>): Promise<void> {
  if (cancelled.has(message.requestId)) return;
  const queryStartedAt = Date.now();
  // Wait for lexical readiness without host-side embedding. Queries do not take
  // the index lock — readers stay coherent while a leader refreshes.
  const start = Date.now();
  while (!lastStatus?.lexicalReady && Date.now() - start < 15_000) {
    await new Promise((r) => setTimeout(r, 100));
    if (cancelled.has(message.requestId)) return;
  }
  if (cancelled.has(message.requestId)) return;

  const runQuery = () =>
    callSearchd({
      v: SEARCHD_PROTOCOL_VERSION,
      op: "query",
      id: nextSearchdId("q"),
      collectionId: message.collectionId,
      query: message.query,
      limit: message.limit,
    });

  // Guest owns query embedding via host embed tool when semantic is ready.
  // When already semanticReady, searchd returns hybrid in one shot (P0) — that is fine.
  // When not, stage lexical progress first, then re-query once semantic becomes ready.
  // Trust guest semanticAvailable claim on query responses.
  const first = await runQuery();
  if (cancelled.has(message.requestId)) return;
  if (!first.ok) {
    lastQueryMs = Date.now() - queryStartedAt;
    post({
      protocol: SEARCH_PROTOCOL_VERSION,
      type: "error",
      requestId: message.requestId,
      code: first.code,
      message: first.error,
    });
    return;
  }

  let items = hitsToItems(first.hits ?? [], pageOrigin);
  let semanticAvailable = Boolean(first.semanticAvailable);

  if (!semanticAvailable) {
    // Early lexical paint for the palette (preserve-active-id on later reorder).
    if (items.length) {
      post({
        protocol: SEARCH_PROTOCOL_VERSION,
        type: "progress",
        requestId: message.requestId,
        generation: message.generation,
        collectionId: message.collectionId,
        stage: "lexical",
        items,
      });
    }

    // Wait only while index/embed work is still in flight; do not stall when semantic will never ready.
    const mayBecomeSemantic =
      indexPromise !== undefined || lastStatus?.phase === "embedding" || lastStatus?.phase === "crawling";
    if (mayBecomeSemantic && !lastStatus?.semanticReady) {
      const waitStart = Date.now();
      const SEMANTIC_WAIT_MS = 12_000;
      while (!lastStatus?.semanticReady && Date.now() - waitStart < SEMANTIC_WAIT_MS) {
        if (
          indexPromise === undefined
          && lastStatus?.phase !== "embedding"
          && lastStatus?.phase !== "crawling"
        ) {
          break;
        }
        await new Promise((r) => setTimeout(r, 150));
        if (cancelled.has(message.requestId)) return;
      }
    }

    if (lastStatus?.semanticReady && !cancelled.has(message.requestId)) {
      const second = await runQuery();
      if (cancelled.has(message.requestId)) return;
      if (second.ok) {
        items = hitsToItems(second.hits ?? [], pageOrigin);
        semanticAvailable = Boolean(second.semanticAvailable);
        if (semanticAvailable && items.length) {
          post({
            protocol: SEARCH_PROTOCOL_VERSION,
            type: "progress",
            requestId: message.requestId,
            generation: message.generation,
            collectionId: message.collectionId,
            stage: "hybrid",
            items,
          });
        }
      }
    }
  }

  lastQueryMs = Date.now() - queryStartedAt;
  post({
    protocol: SEARCH_PROTOCOL_VERSION,
    type: "results",
    requestId: message.requestId,
    generation: message.generation,
    collectionId: message.collectionId,
    items,
    semanticAvailable,
  });
}

function handleDiagnostics(message: Extract<PageToRuntimeMessage, { type: "diagnostics" }>): void {
  const body = buildDiagnostics({
    bootMs,
    lastQueryMs,
    lexicalReady: lastStatus?.lexicalReady,
    semanticReady: statusProbeOk
      ? semanticClaimAllowed(statusProbeOk, lastStatus)
      : Boolean(lastStatus?.semanticReady && lastStatus?.lexicalReady),
    compatibilityKey,
    manifest,
    phase: lastStatus?.phase,
  });
  // Optional console surface for support — not a ranking lab UI.
  console.info("[agentos-search diagnostics]", body);
  post({
    protocol: SEARCH_PROTOCOL_VERSION,
    type: "diagnostics",
    requestId: message.requestId,
    bootMs: body.bootMs,
    lastQueryMs: body.lastQueryMs,
    lexicalReady: body.lexicalReady,
    semanticReady: body.semanticReady,
    compatibilityKeyPrefix: body.compatibilityKeyPrefix,
    assetBytesTotal: body.assetBytesTotal,
    phase: body.phase,
  });
}

async function handleRefresh(message: Extract<PageToRuntimeMessage, { type: "refresh" }>): Promise<void> {
  if (indexPromise) {
    post({
      protocol: SEARCH_PROTOCOL_VERSION,
      type: "status",
      requestId: message.requestId,
      phase: "refreshing",
      message: "Index work already in progress",
      lexicalReady: lastStatus?.lexicalReady,
    });
    return;
  }
  post({
    protocol: SEARCH_PROTOCOL_VERSION,
    type: "status",
    requestId: message.requestId,
    phase: "refreshing",
    message: "Refreshing index…",
    lexicalReady: true,
  });
  await runIndexing(async () => {
    const started = await callSearchd({
      v: SEARCHD_PROTOCOL_VERSION,
      op: "refresh",
      id: nextSearchdId("refresh"),
    });
    if (!started.ok) {
      post({
        protocol: SEARCH_PROTOCOL_VERSION,
        type: "status",
        requestId: message.requestId,
        phase: "error",
        message: started.error,
        lexicalReady: lastStatus?.lexicalReady,
      });
      return;
    }
    await driveCrawl();
    await driveEmbed();
    // Explicit refresh path also re-arms the interval timer.
    scheduleRefresh();
  });
}

self.addEventListener("message", (event: MessageEvent<PageToRuntimeMessage>) => {
  const message = event.data;
  if (!message || typeof message !== "object" || message.protocol !== SEARCH_PROTOCOL_VERSION) return;

  void (async () => {
    try {
      if (message.type === "init") {
        await init(message);
      } else if (message.type === "query") {
        await handleQuery(message);
      } else if (message.type === "refresh") {
        await handleRefresh(message);
      } else if (message.type === "cancel") {
        trackCancel(message.targetRequestId);
      } else if (message.type === "status") {
        post({
          protocol: SEARCH_PROTOCOL_VERSION,
          type: "status",
          requestId: message.requestId,
          phase: lastStatus?.phase ?? "idle",
          message: lastStatus?.message,
          lexicalReady: lastStatus?.lexicalReady,
          semanticReady: lastStatus?.semanticReady,
        });
      } else if (message.type === "diagnostics") {
        handleDiagnostics(message);
      } else if (message.type === "exportSnapshot") {
        await handleExportSnapshot(message);
      }
    } catch (error) {
      post({
        protocol: SEARCH_PROTOCOL_VERSION,
        type: "error",
        requestId: "requestId" in message ? message.requestId : undefined,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })();
});
