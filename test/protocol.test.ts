/**
 * Protocol contracts: versions, searchd codec, manifest validation.
 */
import { assert } from "./assert.ts";
import {
  SEARCH_PROTOCOL_VERSION,
  SEARCHD_PROTOCOL_VERSION,
  HOST_TOOL_ADDRESSES,
} from "../src/protocol/versions.ts";
import {
  encodeSearchdRequest,
  decodeSearchdResponse,
  encodeSearchdResponse,
  decodeSearchdRequest,
  nextSearchdId,
} from "../src/protocol/searchd.ts";
import { validateManifest } from "../src/protocol/manifest.ts";
import { isRuntimeToPageMessage } from "../src/protocol/page-runtime.ts";

assert(SEARCH_PROTOCOL_VERSION === 1, "page protocol version");
assert(SEARCHD_PROTOCOL_VERSION === 1, "searchd protocol version");
assert(HOST_TOOL_ADDRESSES.fetch === "host.org.main.search.fetch", "fetch address");
assert(HOST_TOOL_ADDRESSES.extract === "host.org.main.search.extract", "extract address");
assert(HOST_TOOL_ADDRESSES.embedBatch === "host.org.main.search.embed.batch", "embed address");

const req = {
  v: 1 as const,
  op: "query" as const,
  id: nextSearchdId("t"),
  collectionId: "docs",
  query: "runtime",
  limit: 5,
  rrfK: 60,
};
const reqBytes = encodeSearchdRequest(req);
const decodedReq = decodeSearchdRequest(reqBytes);
assert(decodedReq.op === "query", "round-trip request op");
assert((decodedReq as typeof req).collectionId === "docs", "round-trip collectionId");
assert((decodedReq as typeof req).limit === 5, "round-trip limit");
assert((decodedReq as typeof req).query === "runtime", "round-trip query");

const ok = encodeSearchdResponse({
  v: 1,
  id: req.id,
  ok: true,
  op: "query",
  hits: [{
    id: "docs:/a",
    collectionId: "docs",
    pageId: 1,
    url: "https://example.com/a",
    title: "A",
    score: 0.5,
    fusedRank: 1,
  }],
  semanticAvailable: true,
});
const decoded = decodeSearchdResponse(ok);
assert(decoded.ok === true, "ok response");
if (decoded.ok) {
  assert(decoded.hits?.length === 1, "hits length");
  assert(decoded.semanticAvailable === true, "semantic flag");
  assert(decoded.hits?.[0]?.title === "A", "hit title");
}

const errBytes = encodeSearchdResponse({
  v: 1,
  id: "e1",
  ok: false,
  code: "not_ready",
  error: "lexical index not ready",
});
const err = decodeSearchdResponse(errBytes);
assert(err.ok === false, "error ok flag");
if (!err.ok) {
  assert(err.code === "not_ready", "error code");
  assert(err.error.includes("lexical"), "error message");
}

let threw = false;
try {
  decodeSearchdResponse(new TextEncoder().encode("{not json"));
} catch {
  threw = true;
}
assert(threw, "invalid json throws");

const resumeReq = encodeSearchdRequest({
  v: 1,
  op: "configure",
  id: "cfg1",
  config: {
    collections: [{ id: "docs", label: "Docs", seeds: ["https://example.com/"] }],
    schemaSql: "SELECT 1;",
    modelFingerprint: "m",
    compatibilityKey: "k",
    pageOrigin: "https://example.com",
    resume: true,
  },
});
const decodedResume = decodeSearchdRequest(resumeReq);
assert(decodedResume.op === "configure", "configure op");
assert((decodedResume as { config: { resume?: boolean } }).config.resume === true, "resume flag");

const refreshReq = encodeSearchdRequest({ v: 1, op: "refresh", id: "r1" });
assert(decodeSearchdRequest(refreshReq).op === "refresh", "refresh op");

// page ↔ runtime diagnostics message shape (protocol v1 extension)
{
  const diag = {
    protocol: SEARCH_PROTOCOL_VERSION,
    type: "diagnostics" as const,
    requestId: "d1",
    bootMs: 10,
    lastQueryMs: 5,
    lexicalReady: true,
    semanticReady: false,
    compatibilityKeyPrefix: "abcd",
    assetBytesTotal: 1000,
  };
  assert(isRuntimeToPageMessage(diag), "diagnostics is RuntimeToPageMessage");
  assert(diag.type === "diagnostics", "diagnostics type");
}

const goodManifest = {
  schema: 1,
  protocol: 1,
  version: "0.1.0",
  agentos: { tag: "source", image: "search-atlas" },
  service: { name: "searchd" as const, protocol: 1 as const, transport: "serviceCall" as const },
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
assert(validateManifest(goodManifest).version === "0.1.0", "validateManifest ok");

let badManifest = false;
try {
  validateManifest({ ...goodManifest, protocol: 99 });
} catch {
  badManifest = true;
}
assert(badManifest, "reject bad protocol");

let noMcCore = false;
try {
  const { mcCore: _drop, ...assets } = goodManifest.assets;
  validateManifest({ ...goodManifest, assets });
} catch {
  noMcCore = true;
}
assert(noMcCore, "require mcCore");

let badTransport = false;
try {
  validateManifest({
    ...goodManifest,
    service: { ...goodManifest.service, transport: "guest-luau" as "serviceCall" },
  });
} catch {
  badTransport = true;
}
assert(badTransport, "reject non-serviceCall transport");

let badImagePath = false;
try {
  validateManifest({
    ...goodManifest,
    sqlite: { ...goodManifest.sqlite, indexPath: "relative.db" },
  });
} catch {
  badImagePath = true;
}
assert(badImagePath, "reject relative sqlite indexPath");

// Optional fusion / hostTools / searchd are accepted when shaped correctly and ignored when absent.
const richManifest = {
  ...goodManifest,
  searchd: { protocol: 1 as const, transport: "serviceCall" as const },
  fusion: { strategy: "rrf" as const, rrfK: 60, perPageLimit: 2 },
  hostTools: {
    addresses: [
      HOST_TOOL_ADDRESSES.fetch,
      HOST_TOOL_ADDRESSES.extract,
      HOST_TOOL_ADDRESSES.embedBatch,
    ],
  },
};
const rich = validateManifest(richManifest);
assert(rich.fusion?.strategy === "rrf", "fusion strategy");
assert(rich.fusion?.rrfK === 60, "fusion rrfK");
assert(rich.fusion?.perPageLimit === 2, "fusion perPageLimit");
assert(rich.hostTools?.addresses.includes(HOST_TOOL_ADDRESSES.embedBatch), "hostTools addresses");
assert(rich.searchd?.transport === "serviceCall", "searchd transport");

// Baseline without optional fields still validates (backward compatible).
assert(validateManifest(goodManifest).version === "0.1.0", "optional fields not required");

let badFusion = false;
try {
  validateManifest({ ...goodManifest, fusion: { strategy: "bm25", rrfK: 60, perPageLimit: 2 } });
} catch {
  badFusion = true;
}
assert(badFusion, "reject non-rrf fusion strategy");

let badFusionK = false;
try {
  validateManifest({ ...goodManifest, fusion: { strategy: "rrf", rrfK: 0, perPageLimit: 2 } });
} catch {
  badFusionK = true;
}
assert(badFusionK, "reject non-positive rrfK");

let badHostTools = false;
try {
  validateManifest({
    ...goodManifest,
    hostTools: { addresses: [HOST_TOOL_ADDRESSES.fetch] },
  });
} catch {
  badHostTools = true;
}
assert(badHostTools, "reject incomplete hostTools.addresses");

let badSearchd = false;
try {
  validateManifest({
    ...goodManifest,
    searchd: { protocol: 1, transport: "guest-luau" as "serviceCall" },
  });
} catch {
  badSearchd = true;
}
assert(badSearchd, "reject non-serviceCall searchd.transport");

console.log("protocol.test.ts: ok");
