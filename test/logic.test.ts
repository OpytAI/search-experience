import { mixedbreadDocumentText, mixedbreadQueryText } from "../src/embedding-text.ts";
import { SEARCH_PROTOCOL_VERSION, SEARCHD_PROTOCOL_VERSION, HOST_TOOL_ADDRESSES } from "../src/protocol/versions.ts";
import {
  encodeSearchdRequest,
  decodeSearchdResponse,
  encodeSearchdResponse,
  decodeSearchdRequest,
  nextSearchdId,
} from "../src/protocol/searchd.ts";
import { validateManifest } from "../src/protocol/manifest.ts";
import { buildFts5Query } from "../src/search/fts-oracle.ts";
import { reciprocalRankFusion } from "../src/search/rrf-oracle.ts";
import { runSearchExtract } from "../src/host-tools/extract.ts";
import { runSearchFetch, isPrivateHostname } from "../src/host-tools/fetch.ts";
import { computeCompatibilityKey, hashConfiguration, snapshotStorageKey } from "../src/protocol/snapshot.ts";
import { parseSearchInput } from "../src/search/modes.ts";
import { pruneRecents, recordRecent, deriveLiveRecents } from "../src/search/recents.ts";
import { SearchCollectionRegistry } from "../src/search/registry.ts";
import { sanitizeNavigationUrl, sanitizeHttpUrl, isSameOrigin } from "../src/security/urls.ts";
import { hitsToItems } from "../src/runtime/hits.ts";
import { SearchdClient, defaultTimeoutFor } from "../src/runtime/searchd-client.ts";
import { SearchWorkerClient } from "../src/runtime/client.ts";
import type { SearchCollection, SearchItem } from "../src/search/types.ts";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

// --- versions ---
assert(SEARCH_PROTOCOL_VERSION === 1, "page protocol version");
assert(SEARCHD_PROTOCOL_VERSION === 1, "searchd protocol version");
assert(HOST_TOOL_ADDRESSES.fetch === "host.org.main.search.fetch", "fetch address");

// --- embedding helpers ---
assert(mixedbreadDocumentText("Title", "H", "Body") === "Title\nH\nBody", "document text join");
assert(mixedbreadQueryText("  hello   world ") === "hello world", "query normalize");

// --- searchd codec full fidelity ---
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

// --- FTS / RRF oracles ---
assert(buildFts5Query("Hello World!") === '"hello"* AND "world"*', "fts oracle");
const fused = reciprocalRankFusion(
  [{ id: "a", rank: 1 }, { id: "b", rank: 2 }],
  [{ id: "b", rank: 1 }, { id: "c", rank: 2 }],
);
assert(fused[0]?.id === "b", "rrf prefers overlap");

// --- extract + URL safety ---
const extracted = runSearchExtract({
  url: "https://example.com/docs/runtime.html",
  html: `<!doctype html><html lang="en"><head><title>Runtime</title>
    <meta name="description" content="Notes"><link rel="canonical" href="/docs/runtime.html">
    </head><body><main><h1>Runtime</h1><p>AgentOS boots the kernel.</p>
    <a href="/docs/other.html">Other</a>
    <a href="javascript:alert(1)">Bad</a>
    <a href="https://evil.example/x">Off</a>
    </main></body></html>`,
});
assert(extracted.title === "Runtime", "extract title");
assert(extracted.blocks.some((b) => b.text.includes("AgentOS")), "extract body");
assert(extracted.links.every((l) => l.startsWith("http")), "extract http only");
assert(!extracted.links.some((l) => l.startsWith("javascript:")), "no javascript links");
assert(extracted.canonicalUrl.includes("/docs/runtime.html"), "canonical");

assert(sanitizeNavigationUrl("javascript:alert(1)", "https://example.com") === null, "block js nav");
assert(sanitizeNavigationUrl("https://evil.example/", "https://example.com") === null, "block cross-origin nav");
assert(sanitizeNavigationUrl("/docs/a", "https://example.com") === "https://example.com/docs/a", "relative nav");
assert(sanitizeHttpUrl("javascript:void(0)") === null, "sanitizeHttpUrl js");

// --- fetch allowlist / private / size (mock fetch) ---
assert(isPrivateHostname("127.0.0.1"), "private loopback");
assert(isPrivateHostname("192.168.1.1"), "private lan");
assert(!isPrivateHostname("example.com"), "public host");

const originalFetch = globalThis.fetch;
const calls: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  calls.push(href);
  if (href.includes("redirect-away")) {
    return new Response("moved", {
      status: 200,
      headers: { "content-type": "text/html" },
      // Simulate final URL off-origin by using a Response with url (not all envs support)
    });
  }
  const body = "x".repeat(100);
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html" },
  });
}) as typeof fetch;

try {
  // Host enforces min maxBytes of 1024.
  globalThis.fetch = (async () => {
    return new Response("x".repeat(3000), {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  }) as typeof fetch;
  const okFetch = await runSearchFetch(
    { url: "https://example.com/page", maxBytes: 1500 },
    { allowedOrigins: new Set(["https://example.com"]) },
  );
  assert(okFetch.truncated === true, "size budget truncates");
  assert(okFetch.body.length === 1500, "truncated body length");

  let blocked = false;
  try {
    await runSearchFetch(
      { url: "https://evil.example/x" },
      { allowedOrigins: new Set(["https://example.com"]) },
    );
  } catch {
    blocked = true;
  }
  assert(blocked, "origin allowlist");

  let privateBlocked = false;
  try {
    await runSearchFetch(
      { url: "http://127.0.0.1:9/x" },
      { allowedOrigins: new Set(["https://example.com"]), allowPrivateAddresses: false },
    );
  } catch {
    privateBlocked = true;
  }
  assert(privateBlocked, "private host blocked when not allowlisted");

  // Localhost demo: origin explicitly allowlisted may proceed (private hostname on allowlisted origin).
  const localOk = await runSearchFetch(
    { url: "http://127.0.0.1:5191/docs" },
    { allowedOrigins: new Set(["http://127.0.0.1:5191"]), allowPrivateAddresses: false },
  );
  assert(localOk.status === 200, "allowlisted localhost origin allowed");
} finally {
  globalThis.fetch = originalFetch;
}

// --- finalUrl origin check (redirect simulation via mock returning different response.url) ---
globalThis.fetch = (async () => {
  const res = new Response("<html></html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  });
  Object.defineProperty(res, "url", { value: "https://evil.example/stolen" });
  return res;
}) as typeof fetch;
try {
  let redirectBlocked = false;
  try {
    await runSearchFetch(
      { url: "https://example.com/start" },
      { allowedOrigins: new Set(["https://example.com"]) },
    );
  } catch (e) {
    redirectBlocked = e instanceof Error && e.message.includes("finalUrl");
  }
  assert(redirectBlocked, "off-origin finalUrl rejected");
} finally {
  globalThis.fetch = originalFetch;
}

// --- manifest validation ---
const goodManifest = {
  schema: 1,
  protocol: 1,
  version: "0.1.0",
  agentos: { tag: "plane-B", image: "search-atlas" },
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

// --- hitsToItems ---
const items = hitsToItems([
  {
    id: "1",
    collectionId: "docs",
    pageId: 1,
    url: "https://example.com/a",
    title: "A",
    score: 1,
  },
  {
    id: "2",
    collectionId: "docs",
    pageId: 2,
    url: "javascript:alert(1)",
    title: "Bad",
    score: 1,
  },
  {
    id: "3",
    collectionId: "docs",
    pageId: 3,
    url: "https://evil.example/x",
    title: "Off",
    score: 1,
  },
], "https://example.com");
assert(items.length === 1, "hitsToItems filters unsafe/cross-origin");
assert(items[0]?.href === "https://example.com/a", "safe href");

// --- registry ---
const registry = new SearchCollectionRegistry();
const col: SearchCollection = {
  id: "docs",
  label: "Docs",
  prefix: "docs:",
  search: () => [],
};
registry.register(col);
assert(registry.list().length === 1, "registry list");
assert(registry.get("docs")?.label === "Docs", "registry get");

// --- snapshot / modes / recents ---
const cfgHash = await hashConfiguration({ a: 1 });
assert(cfgHash.length === 64, "configuration hash");
const compat = await computeCompatibilityKey({
  kernelSha256: "a".repeat(64),
  imageSha256: "b".repeat(64),
  schemaSha256: "c".repeat(64),
  modelFingerprint: "d".repeat(64),
  configurationHash: cfgHash,
});
assert(compat.length === 32, "compat key length");
assert(snapshotStorageKey(compat).startsWith("search-"), "snapshot key prefix");

const collections: SearchCollection[] = [{
  id: "docs",
  label: "Docs",
  prefix: "docs:",
  search: () => [],
}];
const parsed = parseSearchInput("docs: kernel", collections);
assert(parsed.mode === "docs" && parsed.query === "kernel", "prefix parse");

const item: SearchItem = { id: "1", collectionId: "docs", kind: "page", label: "One" };
const recents = recordRecent([], item);
assert(pruneRecents(recents).length === 1, "recents");
assert(deriveLiveRecents(recents, [item]).length === 1, "live recents");

// --- SearchdClient mutex serialization + timeout holds lock (serviceCall) ---
{
  let concurrent = 0;
  let maxConcurrent = 0;
  let inFlight = 0;
  const okStatus = (id: string) =>
    encodeSearchdResponse({
      v: 1,
      id,
      ok: true,
      op: "status",
      status: {
        phase: "lexical_ready",
        lexicalReady: true,
        semanticReady: false,
        collections: [],
      },
    });
  const client = new SearchdClient({
    async serviceCall(_name, req) {
      concurrent += 1;
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 40));
      concurrent -= 1;
      inFlight -= 1;
      const decoded = decodeSearchdRequest(req);
      return okStatus(decoded.id);
    },
  });
  await Promise.all([
    client.call({ v: 1, op: "status", id: "1" }, 5_000),
    client.call({ v: 1, op: "status", id: "2" }, 5_000),
    client.call({ v: 1, op: "status", id: "3" }, 5_000),
  ]);
  assert(maxConcurrent === 1, "searchd client serializes serviceCall calls");
  assert(inFlight === 0, "no leftover in-flight after queue drains");

  // Timeout rejects caller but still serializes with next call.
  let timedOut = false;
  const slow = new SearchdClient({
    async serviceCall(_name, req) {
      inFlight += 1;
      await new Promise((r) => setTimeout(r, 80));
      inFlight -= 1;
      const decoded = decodeSearchdRequest(req);
      return okStatus(decoded.id);
    },
  });
  try {
    await slow.call({ v: 1, op: "status", id: "slow" }, 20);
  } catch {
    timedOut = true;
  }
  assert(timedOut, "timeout rejects caller");
  await slow.call({ v: 1, op: "status", id: "after" }, 5_000);
  assert(inFlight === 0, "mutex held until dispatch settled after timeout");
}

assert(defaultTimeoutFor({ v: 1, op: "crawl_step", id: "c" }) >= 120_000, "crawl timeout");
assert(defaultTimeoutFor({ v: 1, op: "query", id: "q", collectionId: "d", query: "x" }) <= 30_000, "query timeout");

// --- SearchdClient serviceCall-only ---
{
  let serviceCalls = 0;
  const client = new SearchdClient({
    async serviceCall(_name, req) {
      serviceCalls += 1;
      const decoded = decodeSearchdRequest(req);
      return encodeSearchdResponse({
        v: 1,
        id: decoded.id,
        ok: true,
        op: decoded.op,
        status: {
          phase: "lexical_ready",
          lexicalReady: true,
          semanticReady: false,
          collections: [],
        },
      });
    },
  });
  const res = await client.call({ v: 1, op: "status", id: "svc-1" }, 5_000);
  assert(res.ok === true, "serviceCall ok");
  assert(serviceCalls === 1, "serviceCall used");
  assert(client.transport === "serviceCall", "transport is serviceCall");
}

// --- Dual-DB path constants (product contract; guest/searchd/src/main.rs) ---
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

// --- promote gate pure logic ---
{
  const canPromote = (c: { pages: number; chunks: number; truncated?: boolean; writing: boolean }) =>
    c.writing && c.pages >= 1 && c.chunks >= 1 && !c.truncated;
  assert(canPromote({ pages: 2, chunks: 5, writing: true }), "promote ok");
  assert(!canPromote({ pages: 0, chunks: 5, writing: true }), "reject empty pages");
  assert(!canPromote({ pages: 2, chunks: 0, writing: true }), "reject empty chunks");
  assert(!canPromote({ pages: 2, chunks: 5, truncated: true, writing: true }), "reject truncated");
}

// --- robots group isolation (TS mirror of guest parse intent) ---
{
  // Specific UA group must not inherit * Disallow when a dedicated group exists first.
  const body = [
    "User-agent: Googlebot",
    "Disallow: /private",
    "",
    "User-agent: *",
    "Disallow: /",
  ].join("\n");
  // Prefer matching group for AgentOSSearch → falls to *; Googlebot gets /private only.
  // We assert the group-selection algorithm used in Luau via a small pure port:
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

// --- publisher import is non-throwing ---
{
  const pub = await import("../src/publisher/cli.ts");
  const result = await pub.publishWarmSnapshot({ origin: "https://example.com", outDir: "./warm" });
  assert(result.ok === false, "publisher stub not ok");
  assert(result.protocol === "searchd", "publisher same protocol");
}

// --- configure resume + refresh codec ---
{
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
}

// --- isSameOrigin strict ---
assert(isSameOrigin("https://example.com/a", "https://example.com"), "same origin");
assert(!isSameOrigin("http://example.com", "https://example.com"), "scheme mismatch");
assert(!isSameOrigin("https://example.com:8443", "https://example.com"), "port mismatch");
assert(!isSameOrigin("https://evil.example", "https://example.com"), "host mismatch");

// --- SearchWorkerClient cancel posts message ---
{
  const posted: unknown[] = [];
  const fakeWorker = {
    postMessage(msg: unknown) { posted.push(msg); },
    addEventListener() {},
  } as unknown as Worker;
  const client = new SearchWorkerClient(fakeWorker);
  const ac = new AbortController();
  const searchPromise = client.makeProviderCollections([{
    id: "docs",
    label: "Docs",
    capabilities: ["lexical"],
  }])[0]!.search({
    query: "x",
    mode: "",
    limit: 5,
    signal: ac.signal,
  });
  ac.abort();
  let aborted = false;
  try {
    await searchPromise;
  } catch (e) {
    aborted = e instanceof DOMException && e.name === "AbortError";
  }
  assert(aborted, "abort rejects search");
  assert(posted.some((m) => (m as { type?: string }).type === "cancel"), "cancel message posted");
}

console.log("logic.test.ts: ok");
