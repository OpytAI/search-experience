/**
 * Palette-facing pure logic: FTS/RRF oracles, registry, modes, recents, hits.
 */
import { assert } from "./assert.ts";
import { mixedbreadDocumentText, mixedbreadQueryText } from "../src/embedding/text.ts";
import { buildFts5Query } from "../src/oracles/fts.ts";
import { reciprocalRankFusion } from "../src/oracles/rrf.ts";
import { parseSearchInput } from "../src/ui/palette/modes.ts";
import {
  pruneRecents,
  recordRecent,
  deriveLiveRecents,
  recentKey,
  resolveActiveKey,
} from "../src/ui/palette/recents.ts";
import { SearchCollectionRegistry } from "../src/ui/palette/registry.ts";
import { rankCollectionStatesForQuery } from "../src/ui/palette/collection-rank.ts";
import { hitsToItems } from "../src/host/hits.ts";
import type { CollectionResultState, SearchCollection, SearchItem } from "../src/ui/palette/types.ts";

assert(mixedbreadDocumentText("Title", "H", "Body") === "Title\nH\nBody", "document text join");
assert(mixedbreadQueryText("  hello   world ") === "hello world", "query normalize");
assert(mixedbreadQueryText("") === "", "empty query normalize");

assert(buildFts5Query("Hello World!") === '"hello"* AND "world"*', "fts oracle");
assert(buildFts5Query("  one   two  ") === '"one"* AND "two"*', "fts collapses space");

const fused = reciprocalRankFusion(
  [{ id: "a", rank: 1 }, { id: "b", rank: 2 }],
  [{ id: "b", rank: 1 }, { id: "c", rank: 2 }],
);
assert(fused[0]?.id === "b", "rrf prefers overlap");
assert(fused.length === 3, "rrf keeps all ids");

const items = hitsToItems([
  {
    id: "1",
    collectionId: "docs",
    pageId: 1,
    url: "https://example.com/a",
    title: "A",
    score: 1,
  },
  {
    id: "2",
    collectionId: "docs",
    pageId: 2,
    url: "javascript:alert(1)",
    title: "Bad",
    score: 1,
  },
  {
    id: "3",
    collectionId: "docs",
    pageId: 3,
    url: "https://evil.example/x",
    title: "Off",
    score: 1,
  },
], "https://example.com");
assert(items.length === 1, "hitsToItems filters unsafe/cross-origin");
assert(items[0]?.href === "https://example.com/a", "safe href");

const registry = new SearchCollectionRegistry();
const col: SearchCollection = {
  id: "docs",
  label: "Docs",
  prefix: "docs:",
  search: () => [],
};
registry.register(col);
assert(registry.list().length === 1, "registry list");
assert(registry.get("docs")?.label === "Docs", "registry get");

const collections: SearchCollection[] = [{
  id: "docs",
  label: "Docs",
  prefix: "docs:",
  search: () => [],
}];
const parsed = parseSearchInput("docs: kernel", collections);
assert(parsed.mode === "docs" && parsed.query === "kernel", "prefix parse");
const bare = parseSearchInput("kernel", collections);
assert(bare.mode === "" && bare.query === "kernel", "bare query");

const item: SearchItem = { id: "1", collectionId: "docs", kind: "page", label: "One" };
const recents = recordRecent([], item);
assert(pruneRecents(recents).length === 1, "recents");
assert(deriveLiveRecents(recents, [item]).length === 1, "live recents");
assert(deriveLiveRecents(recents, []).length === 0, "stale recents drop");

// Preserve active selection by stable id (collectionId+id) across hybrid reordering.
const lexical: SearchItem[] = [
  { id: "a", collectionId: "docs", kind: "page", label: "A" },
  { id: "b", collectionId: "docs", kind: "page", label: "B" },
  { id: "c", collectionId: "docs", kind: "page", label: "C" },
];
const hybridOrder: SearchItem[] = [
  { id: "c", collectionId: "docs", kind: "page", label: "C" },
  { id: "a", collectionId: "docs", kind: "page", label: "A" },
  { id: "b", collectionId: "docs", kind: "page", label: "B" },
];
const activeOnB = recentKey(lexical[1]!);
assert(resolveActiveKey(activeOnB, hybridOrder) === activeOnB, "active key survives reorder");
assert(resolveActiveKey("", hybridOrder) === recentKey(hybridOrder[0]!), "empty key → first enabled");
assert(
  resolveActiveKey(recentKey({ id: "gone", collectionId: "docs" }), hybridOrder) === recentKey(hybridOrder[0]!),
  "missing id falls back to first",
);
assert(
  resolveActiveKey(activeOnB, [{ ...lexical[1]!, disabled: true }, hybridOrder[0]!]) === recentKey(hybridOrder[0]!),
  "disabled previous falls back",
);

const docsCol: SearchCollection = { id: "docs", label: "Documentation", order: 10, search: () => [] };
const blogCol: SearchCollection = { id: "blog", label: "Blog", order: 20, search: () => [] };
// RRF rank-1 scores are ~equal across collections — title affinity must decide.
const fixedOrder: CollectionResultState[] = [
  {
    collection: docsCol,
    status: "ready",
    items: [{
      id: "home",
      collectionId: "docs",
      kind: "page",
      label: "Site search that ships with your pages",
      secondary: "Pedagogical docs and a multi-collection demo",
      score: 0.0164,
    }],
  },
  {
    collection: blogCol,
    status: "ready",
    items: [{
      id: "collections",
      collectionId: "blog",
      kind: "page",
      label: "Why collections exist",
      secondary: "Scopes without host ranking",
      score: 0.0161,
    }],
  },
];
const ranked = rankCollectionStatesForQuery(fixedOrder, "collections");
assert(ranked[0]?.collection.id === "blog", "title match pulls blog section above docs");
assert(ranked[1]?.collection.id === "docs", "weaker title match follows");
const tie = rankCollectionStatesForQuery([
  { collection: blogCol, status: "ready", items: [{ id: "a", collectionId: "blog", kind: "page", label: "Alpha", score: 0.02 }] },
  { collection: docsCol, status: "ready", items: [{ id: "b", collectionId: "docs", kind: "page", label: "Bravo", score: 0.02 }] },
], "zzzz");
assert(tie[0]?.collection.id === "docs", "no query affinity → collection.order");

console.log("search-ui.test.ts: ok");
