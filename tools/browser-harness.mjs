/**
 * Shared Chromium + static-server harness for product acceptance and publisher capture.
 *
 * Serves a minimal fixture origin alongside an unpacked agentos-search/ package,
 * boots the real kernel + search-atlas path, and exposes wait/query/export helpers.
 *
 * Requires system Chromium (default /usr/bin/chromium) and puppeteer-core.
 */
import http from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_CHROMIUM =
  process.env.CHROMIUM_PATH ||
  (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : "/usr/bin/chromium-browser");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".tar": "application/x-tar",
  ".onnx": "application/octet-stream",
  ".sql": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

/** Minimal product-path host page — same install contract as README (script tag + AgentOSSearch). */
export function productFixtureHtml(options = {}) {
  const collections = options.collections ?? [
    {
      id: "docs",
      label: "Documentation",
      seeds: ["/docs/"],
      includePathPrefixes: ["/docs/"],
      order: 10,
      maxPages: 10,
      minQueryLength: 1,
      placeholder: "Search docs",
    },
    {
      id: "blog",
      label: "Blog",
      seeds: ["/blog/"],
      includePathPrefixes: ["/blog/"],
      order: 20,
      maxPages: 10,
      minQueryLength: 1,
      placeholder: "Search blog",
    },
  ];
  const config = {
    assetBase: "/agentos-search/",
    manifestUrl: "/agentos-search/agentos-search.manifest.json",
    collections,
    showLauncher: true,
  };
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AgentOS Search E2E Fixture</title>
</head>
<body>
  <h1>AgentOS Search E2E Fixture</h1>
  <p>Product path: kernel + search-atlas via serviceCall.</p>
  <mc-site-search placeholder="Search the fixture site"></mc-site-search>
  <script>
    globalThis.AgentOSSearch = ${JSON.stringify(config)};
  </script>
  <script type="module" src="/agentos-search/agentos-search.mjs"></script>
</body>
</html>
`;
}

const FIXTURE_PAGES = {
  "/docs/runtime.html": `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><title>Runtime notes</title></head>
<body><main><article>
<h1>Runtime notes</h1>
<p>How the AgentOS search machine boots: kernel and search-atlas, serviceCall to searchd.</p>
<p>Keywords: runtime, kernel, wasm, guest, VANN, FTS5, hybrid ranking.</p>
<ul>
  <li>kernel.wasm — guest VM</li>
  <li>search-atlas.tar — base + sqlite + searchd</li>
  <li>host tools — fetch, extract, embed</li>
</ul>
<a href="/docs/">Docs index</a>
<a href="/blog/collections.html">Collections blog</a>
</article></main></body></html>
`,
  "/docs/index.html": `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><title>Docs</title></head>
<body><main><article>
<h1>Documentation</h1>
<p>Fixture documentation root for crawl seeds.</p>
<a href="/docs/runtime.html">Runtime notes</a>
</article></main></body></html>
`,
  "/blog/collections.html": `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><title>Collections example</title></head>
<body><main><article>
<h1>Collections example</h1>
<p>Docs and blog stay independent sections in the palette with separate crawl seeds.</p>
<p>Keywords: collections, palette, prefixes, presentation, site search.</p>
<a href="/blog/">Blog index</a>
<a href="/docs/runtime.html">Runtime notes</a>
</article></main></body></html>
`,
  "/blog/index.html": `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><title>Blog</title></head>
<body><main><article>
<h1>Blog</h1>
<p>Fixture blog root for crawl seeds.</p>
<a href="/blog/collections.html">Collections example</a>
</article></main></body></html>
`,
  "/robots.txt": "User-agent: *\nAllow: /\n",
};

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  const rel = decoded.replace(/^\/+/, "");
  const full = normalize(join(root, rel));
  if (!full.startsWith(root + sep) && full !== root) return null;
  return full;
}

async function tryFile(path) {
  try {
    const s = await stat(path);
    if (s.isFile()) return path;
    if (s.isDirectory()) {
      const index = join(path, "index.html");
      const is = await stat(index).catch(() => null);
      if (is?.isFile()) return index;
    }
  } catch {
    /* miss */
  }
  return null;
}

/**
 * @param {{ releaseDir: string, hostPageHtml?: string, port?: number }} opts
 * @returns {Promise<{ port: number, origin: string, close: () => Promise<void> }>}
 */
export async function startFixtureServer(opts) {
  const releaseDir = resolve(opts.releaseDir);
  if (!existsSync(join(releaseDir, "agentos-search.manifest.json"))) {
    throw new Error(
      `releaseDir must contain agentos-search.manifest.json (got ${releaseDir})`,
    );
  }
  const hostHtml = opts.hostPageHtml ?? productFixtureHtml();
  const preferredPort = opts.port ?? 0;

  // COOP/COEP required for SharedArrayBuffer / crossOriginIsolated AgentOS path.
  const isolationHeaders = {
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-embedder-policy": "require-corp",
    "cross-origin-resource-policy": "same-origin",
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const path = url.pathname;

      if (path === "/" || path === "/index.html") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          ...isolationHeaders,
        });
        res.end(hostHtml);
        return;
      }

      if (path.startsWith("/agentos-search/")) {
        const rel = path.slice("/agentos-search/".length);
        const filePath = safeJoin(releaseDir, rel || ".");
        if (!filePath) {
          res.writeHead(403).end("forbidden");
          return;
        }
        const found = await tryFile(filePath);
        if (!found) {
          res.writeHead(404).end("not found");
          return;
        }
        const ext = extname(found).toLowerCase();
        res.writeHead(200, {
          "content-type": MIME[ext] || "application/octet-stream",
          "cache-control": "no-cache",
          ...isolationHeaders,
        });
        createReadStream(found).pipe(res);
        return;
      }

      if (FIXTURE_PAGES[path]) {
        const body = FIXTURE_PAGES[path];
        const ext = extname(path).toLowerCase() || ".html";
        res.writeHead(200, {
          "content-type": MIME[ext] || "text/html; charset=utf-8",
          "cache-control": "no-store",
          ...isolationHeaders,
        });
        res.end(body);
        return;
      }

      // Directory seeds: /docs/ → docs index
      if (path.endsWith("/")) {
        const indexPath = path + "index.html";
        if (FIXTURE_PAGES[indexPath]) {
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            ...isolationHeaders,
          });
          res.end(FIXTURE_PAGES[indexPath]);
          return;
        }
      }

      res.writeHead(404, {
        "content-type": "text/plain",
        ...isolationHeaders,
      }).end("not found");
    } catch (error) {
      res.writeHead(500).end(error instanceof Error ? error.message : String(error));
    }
  });

  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(preferredPort, "127.0.0.1", () => resolveListen());
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : preferredPort;
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolveClose, reject) => {
        server.close((err) => (err ? reject(err) : resolveClose()));
      }),
  };
}

/**
 * @param {{ chromiumPath?: string, headless?: boolean }} opts
 */
export async function launchChromium(opts = {}) {
  const executablePath = opts.chromiumPath || DEFAULT_CHROMIUM;
  if (!existsSync(executablePath)) {
    throw new Error(`Chromium not found at ${executablePath}; set CHROMIUM_PATH`);
  }
  const browser = await puppeteer.launch({
    executablePath,
    headless: opts.headless !== false,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--enable-features=SharedArrayBuffer",
      "--disable-gpu",
    ],
  });
  return browser;
}

/**
 * Wait until product bootstrap exposed __agentosSearch and the UI is ready-ish.
 * Lexical ready is enough for crawl/query acceptance; semantic may still be embedding.
 *
 * @param {import('puppeteer-core').Page} page
 * @param {{ timeoutMs?: number, requireSemantic?: boolean }} opts
 */
export async function waitForSearchReady(page, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const requireSemantic = Boolean(opts.requireSemantic);

  await page.waitForFunction(
    () => Boolean(globalThis.__agentosSearch?.client),
    { timeout: Math.min(timeoutMs, 120_000) },
  );

  const deadline = Date.now() + timeoutMs;
  let lastPhase = "";
  let lastMessage = "";

  while (Date.now() < deadline) {
    const state = await page.evaluate(async () => {
      const exp = globalThis.__agentosSearch;
      if (!exp) return { ok: false, reason: "no __agentosSearch" };
      const el = exp.element;
      const phase = el?.phase ?? "";
      const statusMessage = el?.statusMessage ?? "";
      const collectionCount = el?.collections?.length ?? 0;
      // Pull worker diagnostics when available
      let diag = null;
      try {
        diag = await new Promise((resolve, reject) => {
          const id = exp.client.diagnostics();
          const t = setTimeout(() => reject(new Error("diagnostics timeout")), 8_000);
          const off = exp.client.onMessage((msg) => {
            if (msg.type === "diagnostics" && msg.requestId === id) {
              clearTimeout(t);
              off();
              resolve(msg);
            }
            if (msg.type === "error" && msg.requestId === id) {
              clearTimeout(t);
              off();
              reject(new Error(msg.message));
            }
          });
        });
      } catch (e) {
        diag = { error: e instanceof Error ? e.message : String(e) };
      }
      return {
        ok: true,
        phase,
        statusMessage,
        collectionCount,
        lexicalReady: Boolean(diag?.lexicalReady),
        semanticReady: Boolean(diag?.semanticReady),
        diagError: diag?.error,
      };
    });

    if (!state.ok) throw new Error(state.reason);
    lastPhase = state.phase;
    lastMessage = state.statusMessage;

    if (state.phase === "error") {
      throw new Error(`search entered error phase: ${state.statusMessage || lastPhase}`);
    }

    const lexical =
      state.lexicalReady ||
      state.collectionCount > 0 ||
      ["ready", "lexical_ready", "semantic_ready", "idle", "crawling", "embedding"].includes(
        state.phase,
      );

    // Prefer real lexicalReady from diagnostics; allow collection-bound UI as weak ready
    // only after we have collections from the ready message.
    if (state.lexicalReady || (state.collectionCount > 0 && state.phase !== "booting" && state.phase !== "loading")) {
      if (!requireSemantic || state.semanticReady) {
        return state;
      }
    }

    // Keep polling while booting/crawling
    await new Promise((r) => setTimeout(r, 1500));
  }

  throw new Error(
    `timed out waiting for search ready (last phase=${lastPhase} message=${lastMessage})`,
  );
}

/**
 * Run a collection search via the product client and return items.
 * @param {import('puppeteer-core').Page} page
 * @param {{ collectionId: string, query: string, limit?: number, timeoutMs?: number }} opts
 */
export async function runSearchQuery(page, opts) {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return page.evaluate(
    async ({ collectionId, query, limit, timeoutMs: t }) => {
      const exp = globalThis.__agentosSearch;
      if (!exp) throw new Error("no __agentosSearch");
      const collections = exp.element.collections || [];
      const col = collections.find((c) => c.id === collectionId) || collections[0];
      if (!col) throw new Error("no collections registered");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), t);
      try {
        const items = await col.search({
          query,
          limit: limit ?? 10,
          signal: controller.signal,
        });
        return items.map((item) => ({
          id: item.id,
          collectionId: item.collectionId,
          label: item.label,
          href: item.href,
          secondary: item.secondary,
        }));
      } finally {
        clearTimeout(timer);
      }
    },
    {
      collectionId: opts.collectionId,
      query: opts.query,
      limit: opts.limit ?? 10,
      timeoutMs,
    },
  );
}

/**
 * Capture MCSN bytes + metadata via page↔worker exportSnapshot.
 * @param {import('puppeteer-core').Page} page
 * @param {{ timeoutMs?: number }} opts
 * @returns {Promise<{ bytes: Uint8Array, meta: object, byteLength: number }>}
 */
export async function exportSnapshotFromPage(page, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const result = await page.evaluate(async (t) => {
    const exp = globalThis.__agentosSearch;
    if (!exp?.client?.exportSnapshot) throw new Error("exportSnapshot not available");
    const { bytes, meta } = await exp.client.exportSnapshot(t);
    // Transfer as base64 — structured clone of huge typed arrays can be flaky.
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return { base64: btoa(binary), meta, byteLength: bytes.byteLength };
  }, timeoutMs);

  const binary = Buffer.from(result.base64, "base64");
  return {
    bytes: new Uint8Array(binary),
    meta: result.meta,
    byteLength: result.byteLength,
  };
}

/**
 * Collect console/page errors for failure diagnostics.
 * @param {import('puppeteer-core').Page} page
 */
export function attachDiagnostics(page) {
  const logs = [];
  page.on("console", (msg) => {
    logs.push({ type: msg.type(), text: msg.text() });
  });
  page.on("pageerror", (err) => {
    logs.push({ type: "pageerror", text: err.message });
  });
  page.on("requestfailed", (req) => {
    logs.push({
      type: "requestfailed",
      text: `${req.url()} ${req.failure()?.errorText || ""}`,
    });
  });
  return logs;
}

export function summarizeLogs(logs, limit = 40) {
  return logs
    .filter((l) => l.type === "error" || l.type === "pageerror" || l.type === "requestfailed")
    .slice(-limit)
    .map((l) => `[${l.type}] ${l.text}`)
    .join("\n");
}

/** Resolve release dir from CLI env or common unpack locations. */
export function resolveReleaseDir(explicit) {
  const candidates = [
    explicit,
    process.env.AGENTOS_SEARCH_DIR,
    join(ROOT, "demo/public/agentos-search"),
    join(ROOT, "agentos-search"),
  ].filter(Boolean);
  for (const c of candidates) {
    const p = resolve(c);
    if (existsSync(join(p, "agentos-search.manifest.json"))) return p;
  }
  return null;
}

export { ROOT };
