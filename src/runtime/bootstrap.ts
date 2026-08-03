import type { McSiteSearch } from "../elements/mc-site-search.js";
import type { BrowserCrawlDefinition } from "../protocol/collections.js";
import { validateManifest, type SearchExperienceManifest } from "../protocol/manifest.js";
import { SEARCH_PROTOCOL_VERSION } from "../protocol/versions.js";
import { SearchWorkerClient } from "./client.js";

export interface SearchExperienceOptions {
  assetBase?: string | URL;
  manifestUrl?: string | URL;
  autoMount?: boolean;
  collections?: readonly BrowserCrawlDefinition[];
  refreshAfterMs?: number;
  showLauncher?: boolean;
}

export interface SearchExperience {
  element: McSiteSearch;
  manifest: SearchExperienceManifest;
  registration: ServiceWorkerRegistration | null;
  runtime: Worker;
  client: SearchWorkerClient;
}

function crawlDefinitions(options: SearchExperienceOptions): BrowserCrawlDefinition[] {
  const configured = options.collections ?? [{
    id: "site",
    label: (typeof document !== "undefined" && document.title.trim()) ||
      (typeof location !== "undefined" ? location.hostname : "site"),
    seeds: [typeof location !== "undefined" ? new URL("/", location.href).href : "/"],
    origins: typeof location !== "undefined" ? [location.origin] : undefined,
    order: 10,
    limit: 10,
    minQueryLength: 1,
    placeholder: "Search this site",
    maxPages: 50,
  }];
  return configured.map((definition) => ({
    ...definition,
    seeds: definition.seeds.map((seed) =>
      typeof location !== "undefined" ? new URL(seed, location.href).href : seed
    ),
    origins: definition.origins?.map((origin) =>
      typeof location !== "undefined" ? new URL(origin, location.href).origin : origin
    ) ?? (typeof location !== "undefined" ? [location.origin] : undefined),
  }));
}

function mountElement(autoMount: boolean, showLauncher?: boolean): McSiteSearch {
  const existing = document.querySelector<McSiteSearch>("mc-site-search");
  if (existing) {
    if (showLauncher !== undefined) existing.showLauncher = showLauncher;
    return existing;
  }
  if (!autoMount) throw new Error("no <mc-site-search> element is present");
  const element = document.createElement("mc-site-search") as McSiteSearch;
  if (showLauncher !== undefined) element.showLauncher = showLauncher;
  document.body.append(element);
  return element;
}

export async function bootstrapSearchExperience(
  options: SearchExperienceOptions = {},
): Promise<SearchExperience> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("AgentOS site search requires a browser document");
  }

  const element = mountElement(options.autoMount !== false, options.showLauncher);
  const assetBase = new URL(options.assetBase ?? "./", import.meta.url);
  const manifestUrl = new URL(options.manifestUrl ?? "agentos-search.manifest.json", assetBase);
  const manifestResponse = await fetch(manifestUrl, { cache: "no-cache" });
  if (!manifestResponse.ok) {
    throw new Error(`search manifest returned HTTP ${manifestResponse.status}`);
  }
  const manifest = validateManifest(await manifestResponse.json());

  let registration: ServiceWorkerRegistration | null = null;
  if ("serviceWorker" in navigator) {
    const workerUrl = new URL(manifest.assets.worker.url, manifestUrl);
    workerUrl.searchParams.set("sha256", manifest.assets.worker.sha256);
    const workerScope = new URL("./", workerUrl);
    try {
      registration = await navigator.serviceWorker.register(workerUrl, {
        type: "module",
        scope: workerScope.href,
        updateViaCache: "none",
      });
    } catch {
      element.statusMessage = "Service worker registration failed; online search still works.";
    }
  }

  const runtimeUrl = new URL(manifest.assets.runtime.url, manifestUrl);
  runtimeUrl.searchParams.set("sha256", manifest.assets.runtime.sha256);
  const runtime = new Worker(runtimeUrl, { type: "module", name: "agentos-site-search" });
  const client = new SearchWorkerClient(runtime);
  const collections = crawlDefinitions(options);

  client.onMessage((message) => {
    if (message.type === "status") {
      element.phase = message.phase;
      // Progress must not blank the results palette after collections are live.
      const blocking = message.phase === "error" || message.phase === "loading" || message.phase === "booting";
      if (blocking && element.collections.length === 0) {
        element.statusMessage = message.message ?? "";
      } else if (message.phase === "error") {
        element.statusMessage = message.message ?? "";
      } else {
        element.statusMessage = "";
      }
    } else if (message.type === "error") {
      element.statusMessage = message.message;
      element.phase = "error";
    } else if (message.type === "ready") {
      element.phase = message.phase || "ready";
      element.statusMessage = "";
      element.collections = client.makeProviderCollections(message.collections);
      element.placeholder = collections[0]?.placeholder ?? "Search this site";
    }
  });

  client.init({
    manifestUrl: manifestUrl.href,
    assetBase: assetBase.href,
    pageOrigin: location.origin,
    collections,
    refreshAfterMs: options.refreshAfterMs,
  });

  element.placeholder = collections[0]?.placeholder ?? "Search this site";
  element.phase = "booting";
  element.statusMessage = "Starting AgentOS search…";

  return { element, manifest, registration, runtime, client };
}

export { SEARCH_PROTOCOL_VERSION };
