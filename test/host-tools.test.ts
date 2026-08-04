/**
 * Host tools: extract, fetch allowlist, URL safety.
 */
import { assert } from "./assert.ts";
import { runSearchExtract } from "../src/host-tools/extract.ts";
import { runSearchFetch, isPrivateHostname } from "../src/host-tools/fetch.ts";
import { sanitizeNavigationUrl, sanitizeHttpUrl, isSameOrigin } from "../src/security/urls.ts";

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

const preferH1 = runSearchExtract({
  url: "https://example.com/",
  html: `<!doctype html><html><head><title>AgentOS Search Experience Demo</title></head>
    <body><main>
      <p class="eyebrow">Product demo</p>
      <h1>Site search on AgentOS</h1>
      <p class="lead">Press Ctrl-K from any page to open the palette and search your site content in the browser.</p>
    </main></body></html>`,
});
assert(preferH1.title === "Site search on AgentOS", "extract prefers H1 over site title");
assert(
  preferH1.description.includes("Press Ctrl-K"),
  "extract description falls back to first substantial block",
);
assert(!preferH1.description.startsWith("Product demo"), "description skips short eyebrow");

const docsShape = runSearchExtract({
  url: "https://example.com/docs/tutorials/warm.html",
  html: `<!doctype html><html><head>
    <title>Ship a warm first visit</title>
    <meta name="description" content="Capture a gzip MCSN after a real crawl and inject it so empty OPFS can restore." />
    </head><body>
    <header><nav><a href="/">Home</a></nav></header>
    <main>
      <article>
        <div class="page-meta"><p class="eyebrow">Tutorial</p><span class="page-path">/docs/…</span></div>
        <h1>Ship a warm first visit</h1>
        <p class="lead">Capture a gzip MCSN after a real crawl and inject it so empty OPFS can restore.</p>
        <p>Cold crawl on every new browser is honest but slow for large sites.</p>
      </article>
    </main>
    <footer>AgentOS site search documentation</footer>
    </body></html>`,
});
assert(docsShape.title === "Ship a warm first visit", "docs-shaped page title is H1");
assert(
  docsShape.description.startsWith("Capture a gzip MCSN"),
  "docs-shaped description uses meta, not type eyebrow",
);
assert(
  !docsShape.blocks.some((b) => b.text === "Tutorial"),
  "docs-shaped blocks skip Diátaxis eyebrow",
);

assert(sanitizeNavigationUrl("javascript:alert(1)", "https://example.com") === null, "block js nav");
assert(sanitizeNavigationUrl("https://evil.example/", "https://example.com") === null, "block cross-origin nav");
assert(sanitizeNavigationUrl("/docs/a", "https://example.com") === "https://example.com/docs/a", "relative nav");
assert(sanitizeHttpUrl("javascript:void(0)") === null, "sanitizeHttpUrl js");

assert(isPrivateHostname("127.0.0.1"), "private loopback");
assert(isPrivateHostname("192.168.1.1"), "private lan");
assert(isPrivateHostname("10.0.0.2"), "private 10/8");
assert(!isPrivateHostname("example.com"), "public host");

assert(isSameOrigin("https://example.com/a", "https://example.com"), "same origin");
assert(!isSameOrigin("http://example.com", "https://example.com"), "scheme mismatch");
assert(!isSameOrigin("https://example.com:8443", "https://example.com"), "port mismatch");
assert(!isSameOrigin("https://evil.example", "https://example.com"), "host mismatch");

const originalFetch = globalThis.fetch;
try {
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

  const localOk = await runSearchFetch(
    { url: "http://127.0.0.1:5191/docs" },
    { allowedOrigins: new Set(["http://127.0.0.1:5191"]), allowPrivateAddresses: false },
  );
  assert(localOk.status === 200, "allowlisted localhost origin allowed");
} finally {
  globalThis.fetch = originalFetch;
}

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

console.log("host-tools.test.ts: ok");
