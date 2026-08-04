/**
 * Docs site host — real documentation + live product demo.
 * Boots the runtime worker against unpacked agentos-search/ when present;
 * otherwise fixture collections keep ⌘K usable for UI work.
 */
import "../../src/register.js";
import type { McSiteSearch } from "../../src/ui/mc-site-search/element.js";
import type { SearchCollection, SearchItem } from "../../src/ui/palette/types.js";
import { bootstrapSearchExperience } from "../../src/host/bootstrap.js";

const fixtureItems: SearchItem[] = [
  {
    id: "first-install",
    collectionId: "docs",
    kind: "page",
    label: "Install the package on a static site",
    secondary: "Tutorial — unpack release.tar and load the entry script",
    href: "/docs/tutorials/first-install.html",
    meta: "/docs/tutorials/first-install.html",
  },
  {
    id: "multi-collection",
    collectionId: "docs",
    kind: "page",
    label: "Walk through multi-collection search",
    secondary: "Tutorial — two scopes, prefixes, and palette sections",
    href: "/docs/tutorials/multi-collection.html",
    meta: "/docs/tutorials/multi-collection.html",
  },
  {
    id: "architecture",
    collectionId: "docs",
    kind: "page",
    label: "How the runtime fits together",
    secondary: "Explanation — page, worker, guest, OPFS",
    href: "/docs/explanation/architecture.html",
    meta: "/docs/explanation/architecture.html",
  },
  {
    id: "hybrid-ranking",
    collectionId: "docs",
    kind: "page",
    label: "Hybrid ranking",
    secondary: "Explanation — FTS5, VANN, and reciprocal rank fusion",
    href: "/docs/explanation/hybrid-ranking.html",
    meta: "/docs/explanation/hybrid-ranking.html",
  },
  {
    id: "configuration",
    collectionId: "docs",
    kind: "page",
    label: "Configuration",
    secondary: "Reference — AgentOSSearch options and BrowserCrawlDefinition",
    href: "/docs/reference/configuration.html",
    meta: "/docs/reference/configuration.html",
  },
  {
    id: "searchd-protocol",
    collectionId: "docs",
    kind: "page",
    label: "searchd protocol",
    secondary: "Reference — serviceCall ops configure through cancel",
    href: "/docs/reference/searchd-protocol.html",
    meta: "/docs/reference/searchd-protocol.html",
  },
  {
    id: "csp-howto",
    collectionId: "docs",
    kind: "page",
    label: "Set Content-Security-Policy for the package",
    secondary: "How-to — wasm-unsafe-eval, blob, worker-src",
    href: "/docs/how-to/csp.html",
    meta: "/docs/how-to/csp.html",
  },
  {
    id: "collections-blog",
    collectionId: "blog",
    kind: "page",
    label: "Why collections exist",
    secondary: "Blog — scopes without host-side ranking",
    href: "/blog/collections.html",
    meta: "/blog/collections.html",
  },
  {
    id: "command-palette-blog",
    collectionId: "blog",
    kind: "page",
    label: "Command palette on the desktop, sheet on the phone",
    secondary: "Blog — one component, two layout modes",
    href: "/blog/command-palette.html",
    meta: "/blog/command-palette.html",
  },
  {
    id: "guest-boundary-blog",
    collectionId: "blog",
    kind: "page",
    label: "Living with a guest boundary",
    secondary: "Blog — costs and benefits of searchd authority",
    href: "/blog/guest-boundary.html",
    meta: "/blog/guest-boundary.html",
  },
].map((item) => ({
  ...item,
  preview: {
    eyebrow: item.collectionId,
    title: item.label,
    description: item.secondary,
    facts: [{ label: "Path", value: item.href! }],
  },
}));

function fixtureCollections(): SearchCollection[] {
  return [
    {
      id: "docs",
      label: "Documentation",
      order: 10,
      prefix: "docs:",
      placeholder: "Search docs",
      minQueryLength: 1,
      limit: 12,
      source: "local",
      capabilities: ["lexical"],
      search: ({ query }) => {
        const q = query.toLowerCase();
        return fixtureItems.filter((item) => item.collectionId === "docs" && (
          !q
          || item.label.toLowerCase().includes(q)
          || (item.secondary ?? "").toLowerCase().includes(q)
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
          !q
          || item.label.toLowerCase().includes(q)
          || (item.secondary ?? "").toLowerCase().includes(q)
        ));
      },
    },
  ];
}

function ensureSearchElement(): McSiteSearch {
  let element = document.querySelector<McSiteSearch>("mc-site-search");
  if (!element) {
    element = document.createElement("mc-site-search") as McSiteSearch;
    const header = document.querySelector(".site-header");
    if (header) header.append(element);
    else document.body.prepend(element);
  }
  element.showLauncher = true;
  element.placeholder = "Search documentation";
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
          // Real HTML seeds only — bare "/docs/" is a directory without index.html
          // and nginx returns 403, so the crawl never discovers pages (empty results
          // on production while local fixtures or different seed resolution still work).
          seeds: [
            "/docs/tutorials/index.html",
            "/docs/how-to/index.html",
            "/docs/reference/index.html",
            "/docs/explanation/index.html",
          ],
          includePathPrefixes: ["/docs/"],
          order: 10,
          maxPages: 80,
        },
        {
          id: "blog",
          label: "Blog",
          seeds: ["/blog/index.html"],
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
