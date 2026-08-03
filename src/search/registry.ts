import type { SearchCollection, SearchMode } from "./types.js";
import { validateCollectionPrefixes } from "./modes.js";

function assertCollection(collection: SearchCollection): void {
  if (!collection.id.trim()) throw new Error("search collection id must not be empty");
  if (!collection.label.trim()) throw new Error(`search collection ${collection.id} has no label`);
  if (typeof collection.search !== "function") {
    throw new Error(`search collection ${collection.id} has no search function`);
  }
}

export class SearchCollectionRegistry {
  private readonly collections = new Map<string, SearchCollection>();

  register(collection: SearchCollection): () => void {
    assertCollection(collection);
    validateCollectionPrefixes([...this.collections.values(), collection]);
    if (this.collections.has(collection.id)) {
      throw new Error(`search collection id already registered: ${collection.id}`);
    }
    this.collections.set(collection.id, collection);
    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      if (this.collections.get(collection.id) === collection) this.collections.delete(collection.id);
    };
  }

  replaceAll(collections: readonly SearchCollection[]): void {
    const next = new Map<string, SearchCollection>();
    for (const collection of collections) {
      assertCollection(collection);
      if (next.has(collection.id)) {
        throw new Error(`duplicate search collection id: ${collection.id}`);
      }
      next.set(collection.id, collection);
    }
    validateCollectionPrefixes(collections);
    this.collections.clear();
    for (const [id, collection] of next) this.collections.set(id, collection);
  }

  get(id: string): SearchCollection | undefined {
    return this.collections.get(id);
  }

  list(mode = ""): readonly SearchCollection[] {
    return [...this.collections.values()]
      .filter((collection) => !mode || collection.id === mode || collection.modes?.includes(mode as SearchMode))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  }
}
