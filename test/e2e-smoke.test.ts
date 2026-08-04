/**
 * Hermetic pipeline smoke — not a full Chromium browser E2E.
 * Chains pure + client pieces that a cold boot would exercise before the guest VM.
 * Full browser E2E (kernel + search-atlas + OPFS) remains a follow-up with Playwright.
 */
import { assert } from "./assert.ts";
import { pathAllowed } from "../src/security/paths.ts";
import { buildFts5Query } from "../src/oracles/fts.ts";
import { reciprocalRankFusion } from "../src/oracles/rrf.ts";
import { hitsToItems } from "../src/host/hits.ts";
import { resolveActiveKey } from "../src/ui/palette/recents.ts";
import {
  decideResume,
  evaluateSearchdStatusProbe,
  semanticClaimAllowed,
} from "../src/host/reattach-checks.ts";
import { validateManifest } from "../src/protocol/manifest.ts";
import { publishWarmSnapshot } from "../src/publisher/cli.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Crawl policy gate before fetch
assert(
  pathAllowed("/docs/intro", ["/docs/"], ["/docs/private"]),
  "docs path allowed",
);
assert(
  !pathAllowed("/blog/x", ["/docs/"], []),
  "blog excluded from docs collection",
);

// Lexical query builder + fusion oracle (mirrors guest RRF math)
const fts = buildFts5Query("site search");
assert(fts.includes("site") && fts.includes("search"), "fts tokens");
const fused = reciprocalRankFusion(
  [{ id: "a", rank: 1 }, { id: "b", rank: 2 }],
  [{ id: "b", rank: 1 }, { id: "c", rank: 2 }],
  { rrfK: 60 },
);
assert(fused[0]?.id === "b", "rrf prefers overlap");

// Hit sanitization + active selection stability after reorder
const items = hitsToItems(
  [
    {
      id: "p1",
      collectionId: "docs",
      pageId: 1,
      url: "https://example.com/docs/a",
      title: "A",
      score: 0.9,
      fusedRank: 1,
      matchMode: "hybrid",
    },
    {
      id: "bad",
      collectionId: "docs",
      pageId: 2,
      url: "javascript:alert(1)",
      title: "X",
      score: 0.1,
      fusedRank: 2,
    },
  ],
  "https://example.com",
);
assert(items.length === 1, "unsafe hit stripped");
const key = `docs\0p1`;
const reordered = [items[0]!];
assert(resolveActiveKey(key, reordered) === key, "active id preserved");

// Reattach / resume decisions after snapshot restore
assert(
  decideResume({
    restored: true,
    restoreError: undefined,
    expectedCompatibilityKey: "abc",
    snapshotMeta: { compatibilityKey: "abc", lexicalReady: true },
  }).resume === true,
  "warm resume ok",
);
assert(
  evaluateSearchdStatusProbe({ ok: false, error: "down" }).probeOk === false,
  "status probe fail closed",
);
assert(
  semanticClaimAllowed(true, { semanticReady: true, lexicalReady: true }) === true,
  "semantic claim",
);
assert(
  semanticClaimAllowed(false, { semanticReady: true, lexicalReady: true }) === false,
  "no semantic without probe",
);

// Manifest with richer optional fields still validates
const manifest = {
  schema: 1,
  protocol: 1,
  version: "0.1.0",
  agentos: { tag: "source", image: "search-atlas" },
  service: { name: "searchd" as const, protocol: 1 as const, transport: "serviceCall" as const },
  searchd: { protocol: 1, transport: "serviceCall" as const },
  fusion: { strategy: "rrf" as const, rrfK: 60, perPageLimit: 2 },
  hostTools: {
    addresses: [
      "host.org.main.search.fetch",
      "host.org.main.search.extract",
      "host.org.main.search.embed.batch",
    ],
  },
  assets: {
    main: { url: "a.mjs", bytes: 1, sha256: "a".repeat(64) },
    worker: { url: "b.mjs", bytes: 1, sha256: "b".repeat(64) },
    runtime: { url: "c.mjs", bytes: 1, sha256: "c".repeat(64) },
    embedder: { url: "d.mjs", bytes: 1, sha256: "d".repeat(64) },
    kernel: { url: "k.wasm", bytes: 1, sha256: "e".repeat(64) },
    image: { url: "search-atlas.tar", bytes: 1, sha256: "f".repeat(64) },
    schema: { url: "s.sql", bytes: 1, sha256: "1".repeat(64) },
    mcCore: { url: "mc-core.mjs", bytes: 1, sha256: "2".repeat(64) },
  },
  sqlite: { requiredFeatures: ["FTS5", "VANN"] as const, indexPath: "/var/searchd/index.db" },
  model: null,
  collections: [],
};
assert(validateManifest(manifest).fusion?.strategy === "rrf", "rich manifest ok");

// Publisher plan_only smoke (real MCSN capture is tools/browser-e2e.mjs + --capture)
const dir = await mkdtemp(join(tmpdir(), "search-e2e-"));
try {
  const pub = await publishWarmSnapshot({
    origin: "https://example.com",
    outDir: dir,
    collections: [{ id: "site", label: "Site", seeds: ["/"] }],
  });
  assert(pub.ok === true, "publisher ok");
  if (pub.ok) {
    assert(pub.mode === "plan_only", "plan_only without --capture");
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(
  "e2e-smoke.test.ts: ok (hermetic pipeline). Full browser acceptance: bun tools/browser-e2e.mjs --release-dir=demo/public/agentos-search",
);
