#!/usr/bin/env bun
/**
 * Browser end-to-end acceptance for AgentOS site search.
 *
 * Boots kernel + search-atlas in real Chromium against a fixture origin,
 * waits for ready, runs a crawl-backed query, and optionally exports MCSN.
 *
 * Usage:
 *   bun tools/browser-e2e.mjs --release-dir=docs/public/agentos-search
 *   bun tools/browser-e2e.mjs --release-dir=... --out=./warm --export-snapshot
 *
 * Exit 0 only when ready + non-empty search results are observed.
 * Hermetic unit tests are NOT a substitute for this path.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  attachDiagnostics,
  exportSnapshotFromPage,
  launchChromium,
  productFixtureHtml,
  resolveReleaseDir,
  runSearchQuery,
  startFixtureServer,
  summarizeLogs,
  waitForSearchReady,
} from "./browser-harness.mjs";

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const releaseDir = resolveReleaseDir(arg("release-dir"));
const outDir = arg("out", "");
const exportSnap = hasFlag("export-snapshot") || Boolean(outDir);
const requireSemantic = hasFlag("require-semantic");
const readyTimeoutMs = Number(arg("ready-timeout-ms", "900000")) || 900_000;
const queryTimeoutMs = Number(arg("query-timeout-ms", "180000")) || 180_000;
const chromiumPath = arg("chromium", process.env.CHROMIUM_PATH || undefined);
const query = arg("query", "runtime");
const collectionId = arg("collection", "docs");
const port = Number(arg("port", "0")) || 0;

if (!releaseDir) {
  console.error(
    "browser-e2e: missing release package.\n" +
      "  Unpack first: bazel build //:release && tar -xf bazel-bin/release.tar -C docs/public\n" +
      "  Then: bun tools/browser-e2e.mjs --release-dir=docs/public/agentos-search",
  );
  process.exit(2);
}

console.log(JSON.stringify({ event: "start", releaseDir, exportSnap, requireSemantic }, null, 2));

const server = await startFixtureServer({
  releaseDir,
  hostPageHtml: productFixtureHtml(),
  port,
});
console.log(JSON.stringify({ event: "server", origin: server.origin }, null, 2));

const browser = await launchChromium({ chromiumPath, headless: !hasFlag("headed") });
const page = await browser.newPage();
const logs = attachDiagnostics(page);
page.setDefaultTimeout(readyTimeoutMs);

let exitCode = 1;
/** @type {Record<string, unknown>} */
const report = {
  ok: false,
  origin: server.origin,
  releaseDir,
};

try {
  await page.goto(server.origin + "/", { waitUntil: "domcontentloaded" });

  console.log(JSON.stringify({ event: "waiting_ready", timeoutMs: readyTimeoutMs }, null, 2));
  const ready = await waitForSearchReady(page, {
    timeoutMs: readyTimeoutMs,
    requireSemantic,
  });
  report.ready = ready;
  console.log(JSON.stringify({ event: "ready", ready }, null, 2));

  // Give crawl a moment after ready if still crawling
  if (ready.phase === "crawling" || !ready.lexicalReady) {
    await new Promise((r) => setTimeout(r, 8_000));
  }

  console.log(JSON.stringify({ event: "query", collectionId, query }, null, 2));
  const items = await runSearchQuery(page, {
    collectionId,
    query,
    limit: 10,
    timeoutMs: queryTimeoutMs,
  });
  report.items = items;
  console.log(JSON.stringify({ event: "results", count: items.length, items }, null, 2));

  if (!Array.isArray(items) || items.length === 0) {
    // Retry once after more crawl time
    console.log(JSON.stringify({ event: "retry_query_after_crawl_wait" }, null, 2));
    await new Promise((r) => setTimeout(r, 20_000));
    const retry = await runSearchQuery(page, {
      collectionId,
      query,
      limit: 10,
      timeoutMs: queryTimeoutMs,
    });
    report.items = retry;
    console.log(JSON.stringify({ event: "results_retry", count: retry.length, items: retry }, null, 2));
    if (!retry.length) {
      throw new Error(`query "${query}" returned 0 hits — crawl/index not usable`);
    }
  }

  // Prefer hits that look related to fixture content
  const hitLabels = (report.items || []).map((i) => `${i.label} ${i.secondary || ""}`.toLowerCase());
  const relevant = hitLabels.some(
    (t) => t.includes("runtime") || t.includes("kernel") || t.includes("docs") || t.includes("search"),
  );
  if (!relevant) {
    console.warn(
      JSON.stringify({
        event: "warn",
        message: "hits present but none obviously match fixture keywords; accepting non-empty results",
      }),
    );
  }

  if (exportSnap) {
    console.log(JSON.stringify({ event: "export_snapshot" }, null, 2));
    const snap = await exportSnapshotFromPage(page, { timeoutMs: 180_000 });
    if (!snap.byteLength || snap.byteLength < 64) {
      throw new Error(`exportSnapshot returned empty/tiny payload (${snap.byteLength} bytes)`);
    }
    report.snapshotBytes = snap.byteLength;
    report.snapshotMeta = snap.meta;
    console.log(
      JSON.stringify(
        {
          event: "snapshot",
          bytes: snap.byteLength,
          encoding: snap.meta?.encoding ?? "gzip",
          uncompressedBytes: snap.meta?.uncompressedBytes,
          mcsnKind: snap.meta?.mcsnKind ?? "full",
          lexicalReady: snap.meta?.lexicalReady,
          semanticReady: snap.meta?.semanticReady,
          compatibilityKey: snap.meta?.compatibilityKey?.slice?.(0, 16),
        },
        null,
        2,
      ),
    );

    if (outDir) {
      const dest = resolve(outDir);
      await mkdir(dest, { recursive: true });
      const snapPath = join(dest, "search.snapshot");
      const metaPath = join(dest, "search.snapshot.metadata.json");
      await writeFile(snapPath, snap.bytes);
      await writeFile(metaPath, `${JSON.stringify(snap.meta, null, 2)}\n`);
      report.snapshotPath = snapPath;
      report.metadataPath = metaPath;
      console.log(JSON.stringify({ event: "wrote", snapPath, metaPath }, null, 2));
    }
  }

  report.ok = true;
  exitCode = 0;
  console.log(JSON.stringify({ event: "pass", report }, null, 2));
} catch (error) {
  report.ok = false;
  report.error = error instanceof Error ? error.message : String(error);
  report.logTail = summarizeLogs(logs);
  console.error(JSON.stringify({ event: "fail", report }, null, 2));
  if (report.logTail) console.error(report.logTail);
  exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
}

process.exit(exitCode);
