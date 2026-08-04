/**
 * Optional publisher host — same searchd protocol and host-tool contracts.
 * Drive configure/crawl/embed/checkpoint and emit a warm MCSN snapshot.
 *
 * Modes:
 *   plan_only  — pure orchestration plan + metadata template (no guest). Default when
 *                capture is not requested. Used by hermetic unit tests.
 *   captured   — boots the real product path in Chromium against a fixture origin
 *                (or a provided base URL), waits for ready, and writes real
 *                search.snapshot + search.snapshot.metadata.json bytes via
 *                exportSnapshot (page ↔ worker ↔ vm.snapshot()).
 *
 * Usage:
 *   bun src/publisher/cli.ts --origin=https://example.com --out=./warm
 *   bun src/publisher/cli.ts --capture --release-dir=demo/public/agentos-search --out=./warm
 *
 * Prewarmed release packaging: after capture, run tools/package-prewarm.mjs to inject
 * snapshot assets into the agentos-search/ layout and update the manifest digests.
 *
 * Reserved for optional acceleration; visitors never require it.
 */

import {
  SEARCHD_PROTOCOL_VERSION,
  SNAPSHOT_FORMAT_VERSION,
} from "../protocol/versions.js";
import {
  computeCompatibilityKey,
  hashConfiguration,
  type SnapshotCompatibility,
} from "../protocol/snapshot.js";
import { isHttpOrHttpsUrl } from "../security/urls.js";
import type { BrowserCrawlDefinition } from "../protocol/collections.js";

export interface PublisherOptions {
  origin: string;
  outDir: string;
  collections?: unknown[];
  /**
   * When true, drive Chromium against the product package and write real MCSN.
   * Requires releaseDir (unpacked agentos-search/) unless baseUrl is set.
   */
  capture?: boolean;
  /** Unpacked agentos-search/ directory (must contain agentos-search.manifest.json). */
  releaseDir?: string;
  /**
   * Optional already-running product origin. When set with capture, skips local
   * fixture server and uses this origin (must expose __agentosSearch).
   */
  baseUrl?: string;
  /** Chromium executable path (default /usr/bin/chromium). */
  chromiumPath?: string;
  /** Max wait for lexical ready during capture (ms). */
  readyTimeoutMs?: number;
  /** When true, wait for semanticReady before snapshot (slower). */
  requireSemantic?: boolean;
}

export type PublisherPlanStep =
  | { op: "configure"; note: string }
  | { op: "crawl_step"; loop: true; until: string; note: string }
  | { op: "embed_step"; loop: true; until: string; note: string }
  | { op: "checkpoint"; kind: "lexical" | "semantic" | "idle"; note: string }
  | { op: "snapshot"; note: string };

export interface PublisherPlan {
  protocol: "searchd";
  protocolVersion: typeof SEARCHD_PROTOCOL_VERSION;
  mode: "plan_only" | "captured";
  origin: string;
  outDir: string;
  collections: BrowserCrawlDefinition[];
  configurationHash: string;
  compatibilityKey: string;
  steps: PublisherPlanStep[];
  requirements: {
    hostRuntime: string;
    hostTools: readonly string[];
    note: string;
  };
  outputs: {
    plan: string;
    metadata: string;
    snapshot: string;
  };
}

export type PublisherResult =
  | {
      ok: true;
      mode: "plan_only";
      protocol: "searchd";
      protocolVersion: typeof SEARCHD_PROTOCOL_VERSION;
      planPath: string;
      metadataPath: string;
      message: string;
      plan: PublisherPlan;
    }
  | {
      ok: true;
      mode: "captured";
      protocol: "searchd";
      protocolVersion: typeof SEARCHD_PROTOCOL_VERSION;
      planPath: string;
      metadataPath: string;
      snapshotPath: string;
      snapshotBytes: number;
      message: string;
      plan: PublisherPlan;
      meta: SnapshotCompatibility;
    }
  | {
      ok: false;
      code: "invalid_options" | "io_error" | "capture_failed";
      message: string;
      protocol: "searchd";
      protocolVersion: typeof SEARCHD_PROTOCOL_VERSION;
    };

const PLAN_FILENAME = "publisher.plan.json";
const METADATA_FILENAME = "search.snapshot.metadata.json";
const SNAPSHOT_FILENAME = "search.snapshot";

function defaultCollections(origin: string): BrowserCrawlDefinition[] {
  const url = new URL(origin);
  return [
    {
      id: "site",
      label: url.hostname || "site",
      seeds: [new URL("/", url.origin).href],
      origins: [url.origin],
      order: 10,
      limit: 10,
      minQueryLength: 1,
      placeholder: "Search this site",
      maxPages: 50,
    },
  ];
}

function isCrawlDefinition(value: unknown): value is BrowserCrawlDefinition {
  if (!value || typeof value !== "object") return false;
  const c = value as BrowserCrawlDefinition;
  return (
    typeof c.id === "string" &&
    c.id.length > 0 &&
    typeof c.label === "string" &&
    Array.isArray(c.seeds) &&
    c.seeds.every((s) => typeof s === "string" && s.length > 0)
  );
}

function normalizeCollections(
  origin: string,
  collections: unknown[] | undefined,
): { ok: true; collections: BrowserCrawlDefinition[] } | { ok: false; message: string } {
  if (collections === undefined) {
    return { ok: true, collections: defaultCollections(origin) };
  }
  if (!Array.isArray(collections)) {
    return { ok: false, message: "collections must be an array when provided" };
  }
  if (collections.length === 0) {
    return { ok: false, message: "collections must be non-empty when provided" };
  }
  const out: BrowserCrawlDefinition[] = [];
  for (let i = 0; i < collections.length; i++) {
    if (!isCrawlDefinition(collections[i])) {
      return {
        ok: false,
        message: `collections[${i}] must include id, label, and non-empty seeds[]`,
      };
    }
    out.push(collections[i] as BrowserCrawlDefinition);
  }
  return { ok: true, collections: out };
}

function buildSteps(mode: "plan_only" | "captured"): PublisherPlanStep[] {
  return [
    {
      op: "configure",
      note: "searchd configure with collections, schemaSql, modelFingerprint, compatibilityKey, pageOrigin",
    },
    {
      op: "crawl_step",
      loop: true,
      until: "guest reports crawl complete or maxPages / queue empty",
      note: "loop crawl_step with host-tool fetch+extract budgets (same protocol as browser worker)",
    },
    {
      op: "checkpoint",
      kind: "lexical",
      note: "flush SQLite at lexical-ready boundary before optional MCSN capture",
    },
    {
      op: "embed_step",
      loop: true,
      until: "all pending chunks embedded or semanticReady",
      note: "loop embed_step via host embed.batch under the shared model fingerprint",
    },
    {
      op: "checkpoint",
      kind: "semantic",
      note: "quiescent boundary for full warm snapshot",
    },
    {
      op: "snapshot",
      note:
        mode === "captured"
          ? "exportSnapshot → vm.snapshot(); wrote real search.snapshot bytes"
          : "vm.snapshot() after waitForQuiescence; write search.snapshot + fill kernel/image sha in metadata",
    },
  ];
}

function fail(
  code: "invalid_options" | "io_error" | "capture_failed",
  message: string,
): PublisherResult {
  return {
    ok: false,
    code,
    message,
    protocol: "searchd",
    protocolVersion: SEARCHD_PROTOCOL_VERSION,
  };
}

/**
 * Validate options and either write plan_only artifacts or capture real MCSN in Chromium.
 */
export async function publishWarmSnapshot(options: PublisherOptions): Promise<PublisherResult> {
  const protocol = "searchd" as const;
  const protocolVersion = SEARCHD_PROTOCOL_VERSION;

  if (!options || typeof options !== "object") {
    return fail("invalid_options", "options object is required");
  }

  const originRaw = typeof options.origin === "string" ? options.origin.trim() : "";
  // Capture mode can invent a local origin; plan_only needs an absolute http(s) origin.
  if (!options.capture) {
    if (!originRaw) return fail("invalid_options", "origin is required");
    if (!isHttpOrHttpsUrl(originRaw)) {
      return fail("invalid_options", "origin must be an absolute http(s) URL");
    }
  } else if (originRaw && !isHttpOrHttpsUrl(originRaw) && !originRaw.startsWith("http://127.0.0.1")) {
    if (!isHttpOrHttpsUrl(originRaw)) {
      return fail("invalid_options", "origin must be an absolute http(s) URL when provided");
    }
  }

  const outDir = typeof options.outDir === "string" ? options.outDir.trim() : "";
  if (!outDir) return fail("invalid_options", "outDir is required");

  const originForCollections = originRaw || "http://127.0.0.1/";
  const normalized = normalizeCollections(originForCollections, options.collections);
  if (!normalized.ok) return fail("invalid_options", normalized.message);

  if (options.capture) {
    return captureWarmSnapshot({
      ...options,
      outDir,
      collections: normalized.collections,
      origin: originRaw,
    });
  }

  const pageOrigin = new URL(originRaw).origin;
  const configurationHash = await hashConfiguration({
    collections: normalized.collections,
    pageOrigin,
    modelFingerprint: "none",
    publisher: true,
  });
  const compatibilityKey = await computeCompatibilityKey({
    kernelSha256: "",
    imageSha256: "",
    schemaSha256: "",
    modelFingerprint: "none",
    configurationHash,
  });

  const plan: PublisherPlan = {
    protocol,
    protocolVersion,
    mode: "plan_only",
    origin: pageOrigin,
    outDir,
    collections: normalized.collections,
    configurationHash,
    compatibilityKey,
    steps: buildSteps("plan_only"),
    requirements: {
      hostRuntime:
        "AgentOS mc.create (or restore) + serviceCall to /svc/searchd with strict host-tool reattachment",
      hostTools: [
        "host.org.main.search.fetch",
        "host.org.main.search.extract",
        "host.org.main.search.embed.batch",
      ],
      note:
        "Full MCSN capture: re-run with --capture --release-dir=<unpacked agentos-search>. This process wrote plan + metadata only (plan_only).",
    },
    outputs: {
      plan: PLAN_FILENAME,
      metadata: METADATA_FILENAME,
      snapshot: SNAPSHOT_FILENAME,
    },
  };

  const metadata: SnapshotCompatibility = {
    format: SNAPSHOT_FORMAT_VERSION,
    compatibilityKey,
    searchdProtocol: SEARCHD_PROTOCOL_VERSION,
    kernelSha256: "",
    imageSha256: "",
    schemaSha256: "",
    modelFingerprint: "none",
    configurationHash,
    activeGeneration: "gen-1",
    lexicalReady: false,
    semanticReady: false,
    builtAt: new Date().toISOString(),
    provenance: {
      source: "publisher",
      pageOrigin,
    },
  };

  try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await mkdir(outDir, { recursive: true });
    const planPath = join(outDir, PLAN_FILENAME);
    const metadataPath = join(outDir, METADATA_FILENAME);
    await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

    return {
      ok: true,
      mode: "plan_only",
      protocol,
      protocolVersion,
      planPath,
      metadataPath,
      message:
        "Wrote publisher plan and snapshot metadata template (plan_only). Use --capture --release-dir=... for real MCSN.",
      plan,
    };
  } catch (error) {
    return fail(
      "io_error",
      error instanceof Error ? error.message : "failed to write publisher outputs",
    );
  }
}

/** Loose harness surface — loaded dynamically from tools/browser-harness.mjs (not in tsc root). */
interface BrowserHarness {
  resolveReleaseDir(explicit?: string | null): string | null;
  startFixtureServer(opts: {
    releaseDir: string;
    hostPageHtml?: string;
    port?: number;
  }): Promise<{ origin: string; close: () => Promise<void> }>;
  productFixtureHtml(options?: { collections?: unknown[] }): string;
  launchChromium(opts?: {
    chromiumPath?: string;
    headless?: boolean;
  }): Promise<{ newPage: () => Promise<HarnessPage>; close: () => Promise<void> }>;
  attachDiagnostics(page: HarnessPage): unknown[];
  waitForSearchReady(
    page: HarnessPage,
    opts?: { timeoutMs?: number; requireSemantic?: boolean },
  ): Promise<Record<string, unknown>>;
  exportSnapshotFromPage(
    page: HarnessPage,
    opts?: { timeoutMs?: number },
  ): Promise<{ bytes: Uint8Array; meta: SnapshotCompatibility; byteLength: number }>;
}

interface HarnessPage {
  setDefaultTimeout(ms: number): void;
  goto(url: string, opts?: { waitUntil?: string }): Promise<unknown>;
}

async function captureWarmSnapshot(options: {
  outDir: string;
  collections: BrowserCrawlDefinition[];
  origin: string;
  releaseDir?: string;
  baseUrl?: string;
  chromiumPath?: string;
  readyTimeoutMs?: number;
  requireSemantic?: boolean;
}): Promise<PublisherResult> {
  const protocol = "searchd" as const;
  const protocolVersion = SEARCHD_PROTOCOL_VERSION;
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join, resolve, dirname } = await import("node:path");
  const { fileURLToPath, pathToFileURL } = await import("node:url");

  // Load harness from tools/ (sibling of src/) — not part of the page bundle.
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const harnessUrl = pathToFileURL(join(repoRoot, "tools/browser-harness.mjs")).href;

  let harness: BrowserHarness;
  try {
    harness = (await import(harnessUrl)) as BrowserHarness;
  } catch (error) {
    return fail(
      "capture_failed",
      `failed to load browser harness: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const releaseDir =
    options.releaseDir?.trim() || harness.resolveReleaseDir(undefined) || "";
  const baseUrl = options.baseUrl?.trim() || "";

  if (!baseUrl && !releaseDir) {
    return fail(
      "invalid_options",
      "capture requires --release-dir=<unpacked agentos-search> or --base-url=<running product origin>",
    );
  }

  let server: { origin: string; close: () => Promise<void> } | null = null;
  let browser: {
    newPage: () => Promise<HarnessPage>;
    close: () => Promise<void>;
  } | null = null;

  try {
    let origin = baseUrl;
    if (!origin) {
      server = await harness.startFixtureServer({
        releaseDir: resolve(releaseDir),
        hostPageHtml: harness.productFixtureHtml({
          collections: options.collections.map((c) => ({
            ...c,
            // Fixture server is same-origin; keep path seeds relative.
            seeds: c.seeds.map((s) => {
              try {
                const u = new URL(s, "http://127.0.0.1/");
                return u.pathname.endsWith("/") || u.pathname.includes(".")
                  ? u.pathname + u.search
                  : `${u.pathname}/`;
              } catch {
                return s;
              }
            }),
          })),
        }),
      });
      origin = server.origin;
    }

    browser = await harness.launchChromium({
      chromiumPath: options.chromiumPath,
      headless: true,
    });
    const page = await browser.newPage();
    const readyTimeoutMs = options.readyTimeoutMs ?? 900_000;
    page.setDefaultTimeout(readyTimeoutMs);

    await page.goto(origin.replace(/\/?$/, "/"), { waitUntil: "domcontentloaded" });
    await harness.waitForSearchReady(page, {
      timeoutMs: readyTimeoutMs,
      requireSemantic: Boolean(options.requireSemantic),
    });

    // Brief settle for crawl after ready
    await new Promise((r) => setTimeout(r, 5_000));

    const snap = await harness.exportSnapshotFromPage(page, { timeoutMs: 180_000 });
    if (!snap.byteLength || snap.byteLength < 64) {
      throw new Error(`exportSnapshot returned empty/tiny payload (${snap.byteLength} bytes)`);
    }

    const meta = snap.meta;
    const pageOrigin = new URL(origin).origin;
    const configurationHash = await hashConfiguration({
      collections: options.collections,
      pageOrigin,
      modelFingerprint: meta.modelFingerprint || "none",
      publisher: true,
    });

    const plan: PublisherPlan = {
      protocol,
      protocolVersion,
      mode: "captured",
      origin: pageOrigin,
      outDir: options.outDir,
      collections: options.collections,
      configurationHash: meta.configurationHash || configurationHash,
      compatibilityKey: meta.compatibilityKey || "",
      steps: buildSteps("captured"),
      requirements: {
        hostRuntime: "Chromium + product agentos-search package (exportSnapshot)",
        hostTools: [
          "host.org.main.search.fetch",
          "host.org.main.search.extract",
          "host.org.main.search.embed.batch",
        ],
        note: "gzip MCSN from live guest via page→worker exportSnapshot → vm.snapshot() + encode",
      },
      outputs: {
        plan: PLAN_FILENAME,
        metadata: METADATA_FILENAME,
        snapshot: SNAPSHOT_FILENAME,
      },
    };

    await mkdir(options.outDir, { recursive: true });
    const planPath = join(options.outDir, PLAN_FILENAME);
    const metadataPath = join(options.outDir, METADATA_FILENAME);
    const snapshotPath = join(options.outDir, SNAPSHOT_FILENAME);
    await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    await writeFile(metadataPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
    await writeFile(snapshotPath, snap.bytes);

    return {
      ok: true,
      mode: "captured",
      protocol,
      protocolVersion,
      planPath,
      metadataPath,
      snapshotPath,
      snapshotBytes: snap.byteLength,
      message: `Captured gzip MCSN (${snap.byteLength} bytes, encoding=${meta.encoding ?? "gzip"}). Inject into release with: bun tools/package-prewarm.mjs --release-dir=... --snapshot=${snapshotPath} --metadata=${metadataPath}`,
      plan,
      meta,
    };
  } catch (error) {
    return fail(
      "capture_failed",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await server.close().catch(() => {});
  }
}

function isCliEntry(): boolean {
  if (typeof process === "undefined" || !process.argv?.[1]) return false;
  const entry = process.argv[1].replace(/\\/g, "/");
  return (
    entry.endsWith("/publisher/cli.ts") ||
    entry.endsWith("/publisher/cli.js") ||
    entry.endsWith("cli.ts")
  );
}

if (isCliEntry()) {
  const origin =
    process.argv.find((a) => a.startsWith("--origin="))?.slice(9) ?? "";
  const outDir =
    process.argv.find((a) => a.startsWith("--out="))?.slice(6) ?? "./warm";
  const releaseDir =
    process.argv.find((a) => a.startsWith("--release-dir="))?.slice(14);
  const baseUrl = process.argv.find((a) => a.startsWith("--base-url="))?.slice(11);
  const chromiumPath =
    process.argv.find((a) => a.startsWith("--chromium="))?.slice(12);
  const capture = process.argv.includes("--capture") || Boolean(releaseDir) || Boolean(baseUrl);
  const requireSemantic = process.argv.includes("--require-semantic");
  const readyTimeoutMs = Number(
    process.argv.find((a) => a.startsWith("--ready-timeout-ms="))?.slice(19) ?? "",
  );

  if (!capture && !origin) {
    console.error(
      "usage:\n" +
        "  publisher --origin=https://site.example --out=./warm\n" +
        "  publisher --capture --release-dir=demo/public/agentos-search --out=./warm",
    );
    process.exit(2);
  }

  void publishWarmSnapshot({
    origin: origin || "http://127.0.0.1/",
    outDir,
    capture,
    releaseDir,
    baseUrl,
    chromiumPath,
    requireSemantic,
    readyTimeoutMs: Number.isFinite(readyTimeoutMs) && readyTimeoutMs > 0
      ? readyTimeoutMs
      : undefined,
  }).then((result) => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  });
}
