import "./register.js";

import type { McSiteSearch } from "./ui/mc-site-search/element.js";
import { bootstrapSearchExperience } from "./host/bootstrap.js";

export { McSiteSearch } from "./ui/mc-site-search/element.js";
export { defineSearchElements } from "./register.js";
export { bootstrapSearchExperience } from "./host/bootstrap.js";
export type { SearchExperience, SearchExperienceOptions } from "./host/bootstrap.js";
export type {
  SearchCollection,
  SearchContext,
  SearchItem,
  SearchMatch,
  SearchPreview,
  SearchSelectionDetail,
} from "./ui/palette/types.js";
export {
  SEARCH_PROTOCOL_VERSION,
  SEARCHD_PROTOCOL_VERSION,
  SEARCHD_SERVICE_NAME,
  HOST_TOOL_ADDRESSES,
} from "./protocol/versions.js";

let automaticBootstrap: Promise<unknown> | undefined;

function showBootstrapError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const element = document.querySelector<McSiteSearch>("mc-site-search");
  if (element) element.statusMessage = `AgentOS search is unavailable: ${message}`;
  console.error("AgentOS search bootstrap failed", error);
}

function startAutomaticBootstrap(): void {
  if (automaticBootstrap) return;
  const configured = (
    globalThis as typeof globalThis & { AgentOSSearch?: import("./host/bootstrap.js").SearchExperienceOptions }
  ).AgentOSSearch;
  automaticBootstrap = bootstrapSearchExperience(configured).catch(showBootstrapError);
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startAutomaticBootstrap, { once: true });
  } else {
    startAutomaticBootstrap();
  }
}
