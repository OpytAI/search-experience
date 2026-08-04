#!/usr/bin/env bun
/**
 * Inject a prewarmed MCSN snapshot into an unpacked agentos-search/ release layout.
 *
 * Updates agentos-search.manifest.json with integrity-checked assets.snapshot and
 * assets.snapshotMetadata so the worker can seed restore on first visit
 * (see src/host/vm-boot.ts prewarmedSnapshot + worker init).
 *
 * Snapshot bytes must be gzip-encoded MCSN (`encoding: "gzip"` in metadata).
 *
 * Usage:
 *   bun tools/package-prewarm.mjs \
 *     --release-dir=docs/public/agentos-search \
 *     --snapshot=./warm/search.snapshot \
 *     --metadata=./warm/search.snapshot.metadata.json
 *
 * Optional: --out-dir=... copies the whole package (with snapshot) to a new tree.
 * Default mutates release-dir in place.
 *
 * This is the documented producer path for optional prewarmed release packaging.
 * Ordinary installs never require snapshot assets.
 */
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isGzip(bytes) {
  return bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function isRawMcsn(bytes) {
  return (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x4d &&
    bytes[1] === 0x43 &&
    bytes[2] === 0x53 &&
    bytes[3] === 0x4e
  );
}

const releaseDirIn = arg("release-dir");
const snapshotPath = arg("snapshot");
const metadataPath = arg("metadata");
const outDir = arg("out-dir", "");
const snapshotName = arg("snapshot-name", "search.snapshot");
const metadataName = arg("metadata-name", "search.snapshot.metadata.json");

if (!releaseDirIn || !snapshotPath || !metadataPath) {
  console.error(
    "usage: package-prewarm.mjs --release-dir=agentos-search --snapshot=search.snapshot --metadata=search.snapshot.metadata.json [--out-dir=...]",
  );
  process.exit(2);
}

const releaseDir = resolve(releaseDirIn);
const manifestPath = join(releaseDir, "agentos-search.manifest.json");
if (!existsSync(manifestPath)) {
  console.error(`no manifest at ${manifestPath}`);
  process.exit(1);
}
if (!existsSync(resolve(snapshotPath))) {
  console.error(`snapshot not found: ${snapshotPath}`);
  process.exit(1);
}
if (!existsSync(resolve(metadataPath))) {
  console.error(`metadata not found: ${metadataPath}`);
  process.exit(1);
}

const destRoot = outDir ? resolve(outDir) : releaseDir;
if (outDir) {
  await mkdir(destRoot, { recursive: true });
  await cp(releaseDir, destRoot, { recursive: true });
}

const inputBytes = await readFile(resolve(snapshotPath));
const metaText = await readFile(resolve(metadataPath), "utf8");
let metaJson;
try {
  metaJson = JSON.parse(metaText);
} catch {
  console.error("metadata is not valid JSON");
  process.exit(1);
}

if (!isGzip(inputBytes)) {
  if (isRawMcsn(inputBytes)) {
    console.error(
      "snapshot must be gzip-encoded MCSN. Re-export with browser-e2e --export-snapshot or publisher --capture.",
    );
  } else {
    console.error("snapshot is not gzip-encoded (expected magic 1f 8b)");
  }
  process.exit(1);
}

// Verify gunzip yields MCSN.
let raw;
try {
  raw = gunzipSync(inputBytes);
} catch (error) {
  console.error(`gzip decompress failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
if (!isRawMcsn(raw)) {
  console.error("gunzip output is not MCSN (corrupt payload?)");
  process.exit(1);
}

const snapBytes = inputBytes;
const snapSha = sha256Hex(snapBytes);
metaJson.encoding = "gzip";
metaJson.uncompressedBytes = raw.byteLength;
metaJson.snapshotSha256 = snapSha;

const snapDest = join(destRoot, snapshotName);
const metaDest = join(destRoot, metadataName);
await writeFile(snapDest, snapBytes);
await writeFile(metaDest, `${JSON.stringify(metaJson, null, 2)}\n`);

const metaBytes = await readFile(metaDest);
const metaSha = sha256Hex(metaBytes);

const manifest = JSON.parse(await readFile(join(destRoot, "agentos-search.manifest.json"), "utf8"));
if (!manifest.assets || typeof manifest.assets !== "object") {
  console.error("manifest.assets missing");
  process.exit(1);
}

manifest.assets.snapshot = {
  url: snapshotName,
  bytes: snapBytes.byteLength,
  sha256: snapSha,
};
manifest.assets.snapshotMetadata = {
  url: metadataName,
  bytes: metaBytes.byteLength,
  sha256: metaSha,
};

// Surface format + optional key for integrators; worker still verifies digests.
manifest.snapshot = {
  ...(manifest.snapshot && typeof manifest.snapshot === "object" ? manifest.snapshot : { format: 1 }),
  format: metaJson.format ?? 1,
  encoding: "gzip",
  compatibilityKey: metaJson.compatibilityKey,
};

await writeFile(
  join(destRoot, "agentos-search.manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

const result = {
  ok: true,
  releaseDir: destRoot,
  snapshot: manifest.assets.snapshot,
  snapshotMetadata: manifest.assets.snapshotMetadata,
  encoding: "gzip",
  uncompressedBytes: raw.byteLength,
  compressedBytes: snapBytes.byteLength,
  ratio: Number((snapBytes.byteLength / raw.byteLength).toFixed(3)),
  compatibilityKey: metaJson.compatibilityKey,
  lexicalReady: metaJson.lexicalReady,
  semanticReady: metaJson.semanticReady,
};
console.log(JSON.stringify(result, null, 2));
