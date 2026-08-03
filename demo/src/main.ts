/**
 * Demo host — release-like product path.
 * Boots the real runtime worker against copied AgentOS assets when present;
 * otherwise falls back to static fixture collections for UI-only HMR.
 */
import "../../src/register.js";
import type { McSiteSearch } from "../../src/elements/mc-site-search.js";
import type { SearchCollection, SearchItem } from "../../src/search/types.js";
import { bootstrapSearchExperience } from "../../src/runtime/bootstrap.js";

const fixtureItems: SearchItem[] = [
  {
    id: "runtime",
    collectionId: "docs",
    kind: "page",
    label: "Runtime notes",
    secondary: "How the AgentOS search machine boots",
    href: "/docs/runtime.html",
    preview: {
      eyebrow: "docs",
      title: "Runtime notes",
      description: "Kernel, atlas, searchd, and host tools.",
      facts: [{ label: "Path", value: "/docs/runtime.html" }],
    },
  },
  {
    id: "collections",
    collectionId: "blog",
    kind: "page",
    label: "Collections example",
    secondary: "First-class presentation collections",
    href: "/blog/collections.html",
    preview: {
      eyebrow: "blog",
      title: "Collections example",
      description: "Docs and blog as separate sections.",
    },
  },
];

function fixtureCollections(): SearchCollection[] {
  return [
    {
      id: "docs",
      label: "Documentation",
      order: 10,
      prefix: "docs:",
      placeholder: "Search docs",
      minQueryLength: 1,
      limit: 8,
      source: "local",
      capabilities: ["lexical"],
      search: ({ query }) => {
        const q = query.toLowerCase();
        return fixtureItems.filter((item) => item.collectionId === "docs" && (
          !q || item.label.toLowerCase().includes(q) || (item.secondary ?? "").toLowerCase().includes(q)
        ));
      },
    },
    {
      id: "blog",
      label: "Blog",
      order: 20,
      prefix: "blog:",
      placeholder: "Search blog",
      minQueryLength: 1,
      limit: 8,
      source: "local",
      capabilities: ["lexical"],
      search: ({ query }) => {
        const q = query.toLowerCase();
        return fixtureItems.filter((item) => item.collectionId === "blog" && (
          !q || item.label.toLowerCase().includes(q) || (item.secondary ?? "").toLowerCase().includes(q)
        ));
      },
    },
  ];
}

const element = document.querySelector<McSiteSearch>("mc-site-search");
if (element) {
  element.showLauncher = true;
  element.placeholder = "Search the demo site";
}

// Prefer the real product bootstrap when a release-like package is available.
const releaseManifest = new URL("/agentos-search/agentos-search.manifest.json", location.href);
void (async () => {
  try {
    const probe = await fetch(releaseManifest, { method: "HEAD", cache: "no-cache" });
    if (!probe.ok) throw new Error("no release package");
    globalThis.AgentOSSearch = {
      assetBase: new URL("/agentos-search/", location.href),
      manifestUrl: releaseManifest,
      collections: [
        {
          id: "docs",
          label: "Documentation",
          seeds: ["/docs/"],
          includePathPrefixes: ["/docs/"],
          order: 10,
          maxPages: 20,
        },
        {
          id: "blog",
          label: "Blog",
          seeds: ["/blog/"],
          includePathPrefixes: ["/blog/"],
          order: 20,
          maxPages: 20,
        },
      ],
    };
    await bootstrapSearchExperience(globalThis.AgentOSSearch);
    console.info("[search-experience demo] product path ready");
  } catch {
    if (element) {
      element.statusMessage = "";
      element.phase = "demo";
      element.collections = fixtureCollections();
    }
    console.info("[search-experience demo] fixture collections (release assets not mounted)");
  }
})();

declare global {
  // eslint-disable-next-line no-var
  var AgentOSSearch: import("../../src/runtime/bootstrap.js").SearchExperienceOptions | undefined;
}
