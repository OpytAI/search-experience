/**
 * Pure mirrors of guest searchd crawl path policy + RRF fusion math.
 * Production authority remains guest/searchd; these catch rule drift.
 */
import { assert } from "./assert.ts";
import {
  pathAllowed,
  pathStartsWith,
  urlAllowedForCollection,
  urlPathname,
  DEFAULT_MAX_PAGES,
} from "../src/security/paths.ts";
import { reciprocalRankFusion } from "../src/oracles/rrf.ts";
import { buildFts5Query } from "../src/oracles/fts.ts";

// ── path prefix rules (mirror crawl_policy.rs) ───────────────────────────────

assert(pathStartsWith("/docs/a", "/docs") === true, "prefix match");
assert(pathStartsWith("/docs", "/docs") === true, "exact prefix");
assert(pathStartsWith("/doc", "/docs") === false, "non-prefix");
assert(pathStartsWith("/docs", "") === false, "empty prefix never matches");

assert(pathAllowed("/blog/x", [], []) === true, "empty include allows all");
assert(pathAllowed("/blog/x", ["/docs"], []) === false, "include miss");
assert(pathAllowed("/docs/x", ["/docs"], []) === true, "include hit");
assert(pathAllowed("/docs/private", ["/docs"], ["/docs/private"]) === false, "exclude wins");
assert(
  pathAllowed("/docs/public", ["/docs"], ["/docs/private"]) === true,
  "exclude other path still allowed",
);
assert(pathAllowed("/admin", [], ["/admin"]) === false, "exclude alone");
assert(
  pathAllowed("/docs/a", ["/docs", "/blog"], ["/blog"]) === true,
  "multi include",
);
assert(
  pathAllowed("/blog/a", ["/docs", "/blog"], ["/blog"]) === false,
  "include then exclude",
);

assert(urlPathname("https://example.com/docs/a?q=1") === "/docs/a", "pathname drops query");
assert(urlPathname("https://example.com") === "/", "root pathname");
assert(urlPathname("javascript:alert(1)") === null, "reject non-http");

assert(
  urlAllowedForCollection("https://example.com/docs/a", {
    origins: ["https://example.com"],
    includePathPrefixes: ["/docs"],
  }) === true,
  "url allowed",
);
assert(
  urlAllowedForCollection("https://evil.com/docs/a", {
    origins: ["https://example.com"],
    includePathPrefixes: ["/docs"],
  }) === false,
  "wrong origin",
);
assert(
  urlAllowedForCollection("https://example.com/secret", {
    origins: ["https://example.com"],
    excludePathPrefixes: ["/secret"],
  }) === false,
  "url exclude",
);

assert(DEFAULT_MAX_PAGES === 50, "default max pages matches guest");

// ── FTS oracle still quotes safely ───────────────────────────────────────────

assert(buildFts5Query(`hello "world"`) === '"hello"* AND "world"*', "fts strips/quotes");
assert(buildFts5Query("") === "", "empty fts");
assert(buildFts5Query("!!!") === "", "punctuation only → empty");

// ── RRF oracle (same math as guest fuse_rrf k=60) ────────────────────────────

{
  const fused = reciprocalRankFusion(
    [
      { id: "a", rank: 1 },
      { id: "b", rank: 2 },
    ],
    [
      { id: "b", rank: 1 },
      { id: "c", rank: 2 },
    ],
    { rrfK: 60 },
  );
  // b: 1/(60+2) + 1/(60+1) = 1/62 + 1/61
  // a: 1/61
  // c: 1/62
  assert(fused[0]?.id === "b", "rrf prefers overlap");
  const scoreB = 1 / 62 + 1 / 61;
  assert(Math.abs((fused[0]?.score ?? 0) - scoreB) < 1e-12, "rrf score b");
  const scoreA = 1 / 61;
  const a = fused.find((x) => x.id === "a");
  assert(a !== undefined && Math.abs(a.score - scoreA) < 1e-12, "rrf score a lexical-only");
  const c = fused.find((x) => x.id === "c");
  assert(c !== undefined && Math.abs(c.score - 1 / 62) < 1e-12, "rrf score c semantic-only");
  assert(fused.length === 3, "keeps lexical-only and semantic-only");
}

// Per-page diversity is guest-side; oracle only fuses ranks — document expected guest behavior:
// max N chunks per pageId applied after fusion sort. Here we only verify fusion math stability.
{
  const fused = reciprocalRankFusion(
    [{ id: "p1#1", rank: 1 }, { id: "p1#2", rank: 2 }, { id: "p2#1", rank: 3 }],
    [{ id: "p2#1", rank: 1 }],
    { rrfK: 60 },
  );
  assert(fused[0]?.id === "p2#1", "hybrid tops pure lexical siblings");
}

console.log("guest-policy.test.ts: ok");
