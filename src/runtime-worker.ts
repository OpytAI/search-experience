/**
 * Dedicated module worker for AgentOS search.
 *
 * Loads release kernel + atlas, then owns crawl/index/query once indexing is wired.
 * Snapshot restore and /svc/searchd serviceCall land with the guest image path.
 */
import type { PageToRuntimeMessage, RuntimeToPageMessage, SearchExperienceManifest } from "./runtime/protocol.js";
import { SEARCH_PROTOCOL_VERSION } from "./runtime/protocol.js";

function post(message: RuntimeToPageMessage): void {
  self.postMessage(message);
}

async function loadManifest(url: string): Promise<SearchExperienceManifest> {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`manifest HTTP ${response.status}`);
  return response.json() as Promise<SearchExperienceManifest>;
}

async function loadBytes(base: string, relative: string): Promise<Uint8Array> {
  const response = await fetch(new URL(relative, base));
  if (!response.ok) throw new Error(`${relative}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function init(message: Extract<PageToRuntimeMessage, { type: "init" }>): Promise<void> {
  post({ type: "status", phase: "loading", message: "Loading search assets…" });
  const manifest = await loadManifest(message.manifestUrl);
  if (manifest.protocol !== SEARCH_PROTOCOL_VERSION) {
    throw new Error(`unsupported search protocol ${manifest.protocol}`);
  }

  post({ type: "status", phase: "booting", message: "Fetching AgentOS kernel + atlas…" });
  const base = message.manifestUrl;
  const [kernel, image] = await Promise.all([
    loadBytes(base, manifest.assets.kernel.url),
    loadBytes(base, manifest.assets.image.url),
  ]);

  if (kernel.byteLength === 0 || image.byteLength === 0) {
    throw new Error("kernel or atlas asset is empty");
  }

  post({
    type: "status",
    phase: "ready",
    message: `Runtime loaded (kernel ${kernel.byteLength} B, atlas ${image.byteLength} B).`,
  });
  post({ type: "ready", protocol: SEARCH_PROTOCOL_VERSION });
}

self.addEventListener("message", (event: MessageEvent<PageToRuntimeMessage>) => {
  const message = event.data;
  if (!message || typeof message !== "object") return;

  void (async () => {
    try {
      if (message.type === "init") {
        await init(message);
      } else if (message.type === "query") {
        post({ type: "results", query: message.query, collections: [] });
      } else if (message.type === "refresh") {
        post({ type: "status", phase: "refresh", message: "Refresh is not available yet." });
      }
    } catch (error) {
      post({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })();
});
