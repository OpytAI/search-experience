/**
 * Product contracts: dual-DB paths, promote gates, snapshot keys, publisher plan_only.
 */
import { assert } from "./assert.ts";
import {
  computeCompatibilityKey,
  hashConfiguration,
  snapshotStorageKey,
} from "../src/protocol/snapshot.ts";

// Dual-DB path constants (must match guest/searchd/src/main.rs)
{
  const STATE_DIR = "/var/searchd";
  const INDEX_PATH = `${STATE_DIR}/index.db`;
  const CANDIDATE_PATH = `${STATE_DIR}/candidate.db`;
  const writePath = (writeCandidate: boolean) => (writeCandidate ? CANDIDATE_PATH : INDEX_PATH);
  const queryPath = () => INDEX_PATH;
  assert(queryPath() === INDEX_PATH, "queries always index.db");
  assert(writePath(true) === CANDIDATE_PATH, "refresh writes candidate.db");
  assert(writePath(false) === INDEX_PATH, "cold write index.db");
  assert(writePath(true) !== queryPath(), "candidate never equals query path");
}

// Promote gate (mirrors guest validation before copy candidate → index)
{
  const canPromote = (c: { pages: number; chunks: number; truncated?: boolean; writing: boolean }) =>
    c.writing && c.pages >= 1 && c.chunks >= 1 && !c.truncated;
  assert(canPromote({ pages: 2, chunks: 5, writing: true }), "promote ok");
  assert(!canPromote({ pages: 0, chunks: 5, writing: true }), "reject empty pages");
  assert(!canPromote({ pages: 2, chunks: 0, writing: true }), "reject empty chunks");
  assert(!canPromote({ pages: 2, chunks: 5, truncated: true, writing: true }), "reject truncated");
  assert(!canPromote({ pages: 2, chunks: 5, writing: false }), "reject when not writing candidate");
}

// robots group isolation (selection algorithm intent)
{
  type Group = { agents: string[]; disallow: string[] };
  const groups: Group[] = [
    { agents: ["googlebot"], disallow: ["/private"] },
    { agents: ["*"], disallow: ["/"] },
  ];
  const pick = (ua: string) => {
    const lower = ua.toLowerCase();
    for (const g of groups) {
      if (g.agents.some((a) => a !== "*" && lower.includes(a))) return g;
    }
    for (const g of groups) {
      if (g.agents.includes("*")) return g;
    }
    return { agents: [], disallow: [] as string[] };
  };
  assert(pick("Googlebot").disallow[0] === "/private", "specific UA group");
  assert(pick("AgentOSSearch/1.0").disallow[0] === "/", "star group for our bot");
}

// Snapshot compatibility key shape
{
  const cfgHash = await hashConfiguration({ a: 1 });
  assert(cfgHash.length === 64, "configuration hash");
  const cfgHash2 = await hashConfiguration({ a: 2 });
  assert(cfgHash !== cfgHash2, "configuration hash changes with input");

  const compat = await computeCompatibilityKey({
    kernelSha256: "a".repeat(64),
    imageSha256: "b".repeat(64),
    schemaSha256: "c".repeat(64),
    modelFingerprint: "d".repeat(64),
    configurationHash: cfgHash,
  });
  assert(compat.length === 32, "compat key length");
  assert(snapshotStorageKey(compat).startsWith("search-"), "snapshot key prefix");

  const compatOtherImage = await computeCompatibilityKey({
    kernelSha256: "a".repeat(64),
    imageSha256: "e".repeat(64),
    schemaSha256: "c".repeat(64),
    modelFingerprint: "d".repeat(64),
    configurationHash: cfgHash,
  });
  assert(compat !== compatOtherImage, "image digest invalidates compat key");
}

// Publisher plan_only path: non-throwing, protocol-aligned, writes plan + metadata
{
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const outDir = await mkdtemp(join(tmpdir(), "search-publisher-"));
  try {
    const pub = await import("../src/publisher/cli.ts");
    const result = await pub.publishWarmSnapshot({
      origin: "https://example.com",
      outDir,
    });
    assert(result.ok === true, "publisher plan_only ok");
    assert(result.protocol === "searchd", "publisher same protocol");
    if (result.ok) {
      assert(result.mode === "plan_only", "publisher mode plan_only without guest");
      assert(typeof result.planPath === "string" && result.planPath.length > 0, "plan path");
      assert(typeof result.metadataPath === "string" && result.metadataPath.length > 0, "metadata path");
      const planJson = JSON.parse(await readFile(result.planPath, "utf8")) as {
        steps: unknown[];
        mode: string;
      };
      assert(planJson.mode === "plan_only", "plan file mode");
      assert(Array.isArray(planJson.steps) && planJson.steps.length >= 4, "plan has orchestration steps");
      const metaJson = JSON.parse(await readFile(result.metadataPath, "utf8")) as {
        provenance?: { source?: string };
        kernelSha256?: string;
      };
      assert(metaJson.provenance?.source === "publisher", "metadata provenance");
      assert(metaJson.kernelSha256 === "", "kernel sha placeholder until host pin");
    }

    const bad = await pub.publishWarmSnapshot({ origin: "", outDir });
    assert(bad.ok === false, "empty origin rejected");
    assert(bad.protocol === "searchd", "invalid result still protocol-aligned");
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

// MCSN gzip codec: round-trip encode/decode; decode requires gzip input
{
  const {
    encodeMcsnPayload,
    decodeMcsnPayload,
    isGzipBytes,
    isRawMcsnBytes,
    MCSN_PAYLOAD_ENCODING,
  } = await import("../src/protocol/mcsn-codec.ts");

  // Minimal synthetic MCSN-looking header + sparse body (compresses well).
  const raw = new Uint8Array(4096);
  raw[0] = 0x4d;
  raw[1] = 0x43;
  raw[2] = 0x53;
  raw[3] = 0x4e;
  raw[8] = 1; // kind full
  for (let i = 128; i < 256; i++) raw[i] = i & 0xff;

  assert(isRawMcsnBytes(raw), "synthetic raw MCSN magic");
  assert(!isGzipBytes(raw), "raw is not gzip");

  const encoded = await encodeMcsnPayload(raw);
  assert(isGzipBytes(encoded), "encode yields gzip");
  assert(encoded.byteLength < raw.byteLength, "gzip smaller than sparse MCSN");
  assert(MCSN_PAYLOAD_ENCODING === "gzip", "encoding constant");

  const decoded = await decodeMcsnPayload(encoded);
  assert(decoded.byteLength === raw.byteLength, "round-trip length");
  assert(
    decoded.every((b, i) => b === raw[i]),
    "round-trip bytes",
  );

  let rawRejected = false;
  try {
    await decodeMcsnPayload(raw);
  } catch (error) {
    rawRejected = error instanceof Error && /gzip/i.test(error.message);
  }
  assert(rawRejected, "decode requires gzip");

  let doubleEncodeRejected = false;
  try {
    await encodeMcsnPayload(encoded);
  } catch (error) {
    doubleEncodeRejected = error instanceof Error && /gzip|raw MCSN/i.test(error.message);
  }
  assert(doubleEncodeRejected, "encode rejects already-gzip input");
}

// RRF fusion math oracle (mirrors guest fuse_rrf with k=60, unit weights)
{
  const { reciprocalRankFusion } = await import("../src/oracles/rrf.ts");
  const fused = reciprocalRankFusion(
    [
      { id: "lex-only", rank: 1 },
      { id: "both", rank: 2 },
    ],
    [
      { id: "both", rank: 1 },
      { id: "sem-only", rank: 2 },
    ],
    { rrfK: 60 },
  );
  assert(fused.length === 3, "rrf retains union of lists");
  assert(fused[0]?.id === "both", "overlap wins RRF");
  const expectedBoth = 1 / (60 + 2) + 1 / (60 + 1);
  assert(Math.abs((fused[0]?.score ?? 0) - expectedBoth) < 1e-12, "rrf both score");
  assert(fused.some((f) => f.id === "lex-only" && f.lexicalRank === 1 && f.semanticRank === undefined), "lexical-only retained");
  assert(fused.some((f) => f.id === "sem-only" && f.semanticRank === 2 && f.lexicalRank === undefined), "semantic-only retained");
}

console.log("contracts.test.ts: ok");
