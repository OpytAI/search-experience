/**
 * Palette-facing pure logic: FTS/RRF oracles, registry, modes, recents, hits.
 */
import { assert } from "./assert.ts";
import { mixedbreadDocumentText, mixedbreadQueryText } from "../src/embedding/text.ts";
import { buildFts5Query } from "../src/oracles/fts.ts";
import { reciprocalRankFusion } from "../src/oracles/rrf.ts";
import { parseSearchInput } from "../src/ui/palette/modes.ts";
import { pruneRecents, recordRecent, deriveLiveRecents } from "../src/ui/palette/recents.ts";
import { SearchCollectionRegistry } from "../src/ui/palette/registry.ts";
import { hitsToItems } from "../src/host/hits.ts";
import type { SearchCollection, SearchItem } from "../src/ui/palette/types.ts";

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

console.log("search-ui.test.ts: ok");
