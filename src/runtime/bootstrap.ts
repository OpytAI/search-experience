import type { McSiteSearch } from "../elements/mc-site-search.js";
import { makeCrawlCollection, SearchWorkerClient } from "./client.js";
import {
  SEARCH_PROTOCOL_VERSION,
  type BrowserCrawlDefinition,
  type SearchExperienceManifest,
} from "./protocol.js";

export interface SearchExperienceOptions {
  assetBase?: string | URL;
  manifestUrl?: string | URL;
  autoMount?: boolean;
  collections?: readonly BrowserCrawlDefinition[];
  refreshAfterMs?: number;
}

export interface SearchExperience {
  element: McSiteSearch;
  manifest: SearchExperienceManifest;
  registration: ServiceWorkerRegistration | null;
  runtime: Worker;
}

function validateManifest(value: unknown): SearchExperienceManifest {
  if (!value || typeof value !== "object") throw new Error("search manifest must be an object");
  const manifest = value as Partial<SearchExperienceManifest>;
  if (manifest.schema !== 1 || manifest.protocol !== SEARCH_PROTOCOL_VERSION) {
    throw new Error("unsupported AgentOS search manifest/protocol");
  }
  if (
    !manifest.assets?.worker?.url ||
    !manifest.assets?.runtime?.url ||
    !manifest.assets?.kernel?.url ||
    !manifest.assets?.image?.url ||
    !manifest.assets?.schema?.url ||
    !manifest.assets?.embedder?.url
  ) {
    throw new Error("search manifest is missing required runtime assets");
  }
  if (!Array.isArray(manifest.collections)) throw new Error("search manifest collections must be an array");
  return manifest as SearchExperienceManifest;
}

function crawlDefinitions(options: SearchExperienceOptions): readonly BrowserCrawlDefinition[] {
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
  }];
  return configured.map((definition) => ({
    ...definition,
    seeds: definition.seeds.map((seed) =>
      typeof location !== "undefined" ? new URL(seed, location.href).href : seed
    ),
    origins: definition.origins?.map((origin) =>
      typeof location !== "undefined" ? new URL(origin, location.href).origin : origin
    ),
  }));
}

function mountElement(autoMount: boolean): McSiteSearch {
  const existing = document.querySelector<McSiteSearch>("mc-site-search");
  if (existing) return existing;
  if (!autoMount) throw new Error("no <mc-site-search> element is present");
  const element = document.createElement("mc-site-search") as McSiteSearch;
  document.body.append(element);
  return element;
}

export async function bootstrapSearchExperience(
  options: SearchExperienceOptions = {},
): Promise<SearchExperience> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("AgentOS site search requires a browser document");
  }

  const element = mountElement(options.autoMount !== false);
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
    registration = await navigator.serviceWorker.register(workerUrl, {
      type: "module",
      scope: workerScope.href,
      updateViaCache: "none",
    });
  } else {
    element.statusMessage = "Service workers unavailable; search will not persist offline.";
  }

  const runtimeUrl = new URL(manifest.assets.runtime.url, manifestUrl);
  runtimeUrl.searchParams.set("sha256", manifest.assets.runtime.sha256);
  const runtime = new Worker(runtimeUrl, { type: "module", name: "agentos-site-search" });
  const client = new SearchWorkerClient(runtime);
  const collections = crawlDefinitions(options);

  client.onMessage((message) => {
    if (message.type === "status") {
      element.statusMessage = message.message ?? message.phase;
      element.phase = message.phase;
    } else if (message.type === "error") {
      element.statusMessage = message.message;
      element.phase = "error";
    } else if (message.type === "ready") {
      element.phase = "ready";
      element.statusMessage = "";
      element.collections = collections.map(makeCrawlCollection);
    } else if (message.type === "results") {
      element.phase = "ready";
    }
  });

  client.init(manifestUrl.href, assetBase.href, collections);
  element.placeholder = collections[0]?.placeholder ?? "Search this site";
  element.phase = "booting";
  element.statusMessage = "Starting AgentOS search…";

  return { element, manifest, registration, runtime };
}
