import "./register.js";

import type { McSiteSearch } from "./elements/mc-site-search.js";
import { bootstrapSearchExperience } from "./runtime/bootstrap.js";

export { McSiteSearch } from "./elements/mc-site-search.js";
export { defineSearchElements } from "./register.js";
export { bootstrapSearchExperience } from "./runtime/bootstrap.js";
export type { SearchExperience, SearchExperienceOptions } from "./runtime/bootstrap.js";
export type {
  SearchCollection,
  SearchContext,
  SearchItem,
  SearchMatch,
  SearchPreview,
  SearchSelectionDetail,
} from "./search/types.js";

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
    globalThis as typeof globalThis & { AgentOSSearch?: import("./runtime/bootstrap.js").SearchExperienceOptions }
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
