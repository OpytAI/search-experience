/**
 * Demo host. Imports product sources for live development under //demo:dev.
 */
import "../../src/register.ts";
import type { McSiteSearch } from "../../src/elements/mc-site-search.ts";

const element = document.querySelector<McSiteSearch>("mc-site-search");
if (element) {
  element.statusMessage = "Press ⌘/Ctrl+K to open search.";
  element.phase = "demo";
  element.collections = [
    {
      id: "docs",
      label: "Documentation",
      order: 10,
      items: [
        {
          id: "runtime",
          collectionId: "docs",
          title: "Runtime notes",
          url: "/docs/runtime.html",
        },
      ],
    },
    {
      id: "blog",
      label: "Blog",
      order: 20,
      items: [
        {
          id: "collections",
          collectionId: "blog",
          title: "Collections example",
          url: "/blog/collections.html",
        },
      ],
    },
  ];
}

console.info("[search-experience demo] ready");
