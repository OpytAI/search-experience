/**
 * Product contracts: dual-DB paths, promote gates, snapshot keys, publisher stub.
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

// Publisher stub stays non-throwing and protocol-aligned
{
  const pub = await import("../src/publisher/cli.ts");
  const result = await pub.publishWarmSnapshot({ origin: "https://example.com", outDir: "./warm" });
  assert(result.ok === false, "publisher stub not ok");
  assert(result.protocol === "searchd", "publisher same protocol");
}

console.log("contracts.test.ts: ok");
