/**
 * Tiny distribution service worker — cache lifecycle + integrity checks.
 * Crawl, AgentOS, and ONNX stay in the dedicated runtime worker.
 *
 * When a request carries ?sha256=<hex>, the body is hashed before cache put/use.
 * Without a digest param, executable assets use network-first to avoid sticky poison.
 */

const CACHE = "agentos-search-distribution-v1";

const worker = self as unknown as {
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  location: { origin: string };
  addEventListener(
    type: "install" | "activate",
    listener: (event: { waitUntil(p: Promise<unknown>): void }) => void,
  ): void;
  addEventListener(
    type: "fetch",
    listener: (event: {
      request: Request;
      respondWith(r: Promise<Response> | Response): void;
    }) => void,
  ): void;
};

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isExecutableAsset(pathname: string): boolean {
  return (
    pathname.endsWith(".mjs") ||
    pathname.endsWith(".wasm") ||
    pathname.endsWith(".tar") ||
    pathname.endsWith(".luau")
  );
}

worker.addEventListener("install", (event) => {
  event.waitUntil(worker.skipWaiting());
});

worker.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
    await worker.clients.claim();
  })());
});

worker.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== worker.location.origin) return;
  if (
    !url.pathname.includes("agentos-search") &&
    !url.pathname.endsWith(".wasm") &&
    !url.pathname.endsWith(".tar") &&
    !url.pathname.endsWith(".mjs") &&
    !url.pathname.endsWith(".json") &&
    !url.pathname.endsWith(".sql") &&
    !url.pathname.endsWith(".onnx") &&
    !url.pathname.endsWith(".luau")
  ) {
    return;
  }

  event.respondWith((async () => {
    const expected = url.searchParams.get("sha256");
    const cache = await caches.open(CACHE);
    const cacheKey = expected
      ? new Request(url.pathname + url.search, { method: "GET" })
      : event.request;

    // With integrity digest: prefer verified cache entry.
    if (expected && /^[a-f0-9]{64}$/.test(expected)) {
      const cached = await cache.match(cacheKey);
      if (cached) {
        const buf = await cached.clone().arrayBuffer();
        const hash = await sha256Hex(buf);
        if (hash === expected) return cached;
        await cache.delete(cacheKey);
      }
      const response = await fetch(event.request);
      if (!response.ok || event.request.method !== "GET") return response;
      const body = await response.arrayBuffer();
      const hash = await sha256Hex(body);
      if (hash !== expected) {
        // Fail closed: never return or cache a mismatched body.
        return new Response("integrity check failed", {
          status: 502,
          statusText: "Integrity Check Failed",
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
        });
      }
      const verified = new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      await cache.put(cacheKey, verified.clone());
      return verified;
    }

    // No digest: network-first for executable assets; cache-first for static data.
    if (isExecutableAsset(url.pathname)) {
      try {
        const response = await fetch(event.request);
        if (response.ok && event.request.method === "GET") {
          await cache.put(event.request, response.clone());
        }
        return response;
      } catch {
        const cached = await cache.match(event.request);
        if (cached) return cached;
        throw new Error("network failed");
      }
    }

    const cached = await cache.match(event.request);
    if (cached) return cached;
    const response = await fetch(event.request);
    if (response.ok && event.request.method === "GET") {
      await cache.put(event.request, response.clone());
    }
    return response;
  })());
});

export {};
