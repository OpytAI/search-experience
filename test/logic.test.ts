import { mixedbreadDocumentText } from "../src/embedding.ts";
import { SEARCH_PROTOCOL_VERSION } from "../src/runtime/protocol.ts";
import { makeCrawlCollection } from "../src/runtime/client.ts";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

assert(SEARCH_PROTOCOL_VERSION === 1, "protocol version");
assert(
  mixedbreadDocumentText("Title", "H", "Body") === "Title\n\nH\n\nBody",
  "document text join",
);

const collection = makeCrawlCollection({
  id: "docs",
  label: "Documentation",
  seeds: ["/docs/"],
  order: 5,
});
assert(collection.id === "docs", "collection id");
assert(collection.items.length === 0, "empty collection items");
assert(collection.order === 5, "collection order");

console.log("logic.test.ts: ok");
