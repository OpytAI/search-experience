/**
 * Tiny distribution service worker — cache lifecycle only.
 * Long crawl / AgentOS / ONNX work stays in the dedicated runtime worker.
 */

const CACHE = "agentos-search-distribution-v1";

// Service-worker globals; avoid ServiceWorkerGlobalScope (webworker lib conflicts with DOM).
const worker = self as unknown as {
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  location: { origin: string };
  addEventListener(type: "install" | "activate", listener: (event: { waitUntil(p: Promise<unknown>): void }) => void): void;
  addEventListener(type: "fetch", listener: (event: {
    request: Request;
    respondWith(r: Promise<Response> | Response): void;
  }) => void): void;
};

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
  // Only same-origin distribution assets under this SW scope.
  if (url.origin !== worker.location.origin) return;
  if (!url.pathname.includes("agentos-search") && !url.pathname.endsWith(".wasm") &&
    !url.pathname.endsWith(".tar") && !url.pathname.endsWith(".mjs") &&
    !url.pathname.endsWith(".json") && !url.pathname.endsWith(".sql") &&
    !url.pathname.endsWith(".onnx")) {
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
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
