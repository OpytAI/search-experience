/**
 * Docs site host — release-like product path on every page.
 * Boots the real runtime worker against copied AgentOS assets when present;
 * otherwise falls back to static fixture collections for UI-only HMR.
 *
 * Loaded from home, docs, and blog so ⌘K / Ctrl+K works site-wide.
 */
import "../../src/register.js";
import type { McSiteSearch } from "../../src/ui/mc-site-search/element.js";
import type { SearchCollection, SearchItem } from "../../src/ui/palette/types.js";
import { bootstrapSearchExperience } from "../../src/host/bootstrap.js";

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
      description: "Kernel, search-atlas, searchd, and host tools.",
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
      description: "Docs and blog as separate sections in the palette.",
      facts: [{ label: "Path", value: "/blog/collections.html" }],
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

/** Ensure a palette host exists (header slot preferred; else body mount). */
function ensureSearchElement(): McSiteSearch {
  let element = document.querySelector<McSiteSearch>("mc-site-search");
  if (!element) {
    element = document.createElement("mc-site-search") as McSiteSearch;
    const header = document.querySelector(".site-header");
    if (header) header.append(element);
    else document.body.prepend(element);
  }
  element.showLauncher = true;
  element.placeholder = "Search the docs site";
  return element;
}

const element = ensureSearchElement();

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
    console.info("[search-experience docs] product path ready");
  } catch {
    element.statusMessage = "";
    element.phase = "docs";
    element.collections = fixtureCollections();
    console.info("[search-experience docs] fixture collections (release assets not mounted)");
  }
})();

declare global {
  // eslint-disable-next-line no-var
  var AgentOSSearch: import("../../src/host/bootstrap.js").SearchExperienceOptions | undefined;
}
