import type {
  BrowserCrawlDefinition,
  CrawlCollectionDescriptor,
  PageToRuntimeMessage,
  RuntimeToPageMessage,
} from "../protocol/page-runtime.js";
import { SEARCH_PROTOCOL_VERSION } from "../protocol/versions.js";
import type { SearchCollection, SearchContext, SearchItem } from "../ui/palette/types.js";

export class SearchWorkerClient {
  private readonly listeners = new Set<(message: RuntimeToPageMessage) => void>();
  private nextId = 1;

  constructor(readonly worker: Worker) {
    this.worker.addEventListener("message", (event: MessageEvent<RuntimeToPageMessage>) => {
      const message = event.data;
      if (!message || typeof message !== "object") return;
      for (const listener of this.listeners) listener(message);
    });
  }

  onMessage(listener: (message: RuntimeToPageMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private requestId(): string {
    return `p-${this.nextId++}`;
  }

  post(message: PageToRuntimeMessage): void {
    this.worker.postMessage(message);
  }

  init(args: {
    manifestUrl: string;
    assetBase: string;
    pageOrigin: string;
    collections: readonly BrowserCrawlDefinition[];
    refreshAfterMs?: number;
  }): string {
    const requestId = this.requestId();
    this.post({
      protocol: SEARCH_PROTOCOL_VERSION,
      type: "init",
      requestId,
      ...args,
    });
    return requestId;
  }

  query(collectionId: string, query: string, limit: number, generation: number): string {
    const requestId = this.requestId();
    this.post({
      protocol: SEARCH_PROTOCOL_VERSION,
      type: "query",
      requestId,
      collectionId,
      query,
      limit,
      generation,
    });
    return requestId;
  }

  cancel(targetRequestId: string, generation: number): string {
    const requestId = this.requestId();
    this.post({
      protocol: SEARCH_PROTOCOL_VERSION,
      type: "cancel",
      requestId,
      targetRequestId,
      generation,
    });
    return requestId;
  }

  refresh(): string {
    const requestId = this.requestId();
    this.post({ protocol: SEARCH_PROTOCOL_VERSION, type: "refresh", requestId });
    return requestId;
  }

  /** Request local resource diagnostics (no UI ranking lab). */
  diagnostics(): string {
    const requestId = this.requestId();
    this.post({ protocol: SEARCH_PROTOCOL_VERSION, type: "diagnostics", requestId });
    return requestId;
  }

  /** Capture a warm MCSN snapshot from the live guest (publisher / e2e). */
  exportSnapshot(timeoutMs = 120_000): Promise<{
    bytes: Uint8Array;
    meta: import("../protocol/snapshot.js").SnapshotCompatibility;
  }> {
    const requestId = this.requestId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`exportSnapshot timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.delete(listener);
      };
      const listener = (message: RuntimeToPageMessage) => {
        if (message.type === "snapshot" && message.requestId === requestId) {
          cleanup();
          const binary = atob(message.snapshotBase64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          resolve({ bytes, meta: message.meta });
          return;
        }
        if (message.type === "error" && message.requestId === requestId) {
          cleanup();
          reject(new Error(message.message));
        }
      };
      this.listeners.add(listener);
      this.post({ protocol: SEARCH_PROTOCOL_VERSION, type: "exportSnapshot", requestId });
    });
  }

  makeProviderCollections(
    descriptors: readonly CrawlCollectionDescriptor[],
  ): SearchCollection[] {
    return descriptors.map((descriptor) => {
      const collection: SearchCollection = {
        id: descriptor.id,
        label: descriptor.label,
        order: descriptor.order ?? 10,
        minQueryLength: descriptor.minQueryLength ?? 1,
        limit: descriptor.limit ?? 10,
        prefix: descriptor.prefix,
        placeholder: descriptor.placeholder,
        emptyStateLabel: descriptor.emptyStateLabel,
        source: "crawl",
        capabilities: descriptor.capabilities,
        search: (context: SearchContext) => this.searchCollection(descriptor.id, context),
      };
      return collection;
    });
  }

  private searchCollection(collectionId: string, context: SearchContext): Promise<SearchItem[]> {
    return new Promise((resolve, reject) => {
      const generation = Date.now();
      const requestId = this.query(collectionId, context.query, context.limit, generation);
      const onAbort = () => {
        this.cancel(requestId, generation);
        cleanup();
        reject(new DOMException("Aborted", "AbortError"));
      };
      const cleanup = () => {
        this.listeners.delete(listener);
        context.signal.removeEventListener("abort", onAbort);
      };
      // progress = staged lexical (then optional hybrid) paints; results = final settle.
      // Palette preserves activeKey by stable id across publish + resolve reorders.
      const listener = (message: RuntimeToPageMessage) => {
        if (message.type === "progress" && message.requestId === requestId) {
          context.publish?.([...message.items]);
          return;
        }
        if (message.type === "results" && message.requestId === requestId) {
          cleanup();
          resolve([...message.items]);
          return;
        }
        if (message.type === "error" && message.requestId === requestId) {
          cleanup();
          reject(new Error(message.message));
        }
      };
      this.listeners.add(listener);
      context.signal.addEventListener("abort", onAbort, { once: true });
      if (context.signal.aborted) onAbort();
    });
  }
}

export function descriptorToPlaceholderCollection(definition: BrowserCrawlDefinition): CrawlCollectionDescriptor {
  return {
    id: definition.id,
    label: definition.label,
    order: definition.order ?? 10,
    minQueryLength: definition.minQueryLength ?? 1,
    limit: definition.limit ?? 10,
    prefix: definition.prefix,
    placeholder: definition.placeholder,
    emptyStateLabel: definition.emptyStateLabel,
    language: definition.language,
    capabilities: ["lexical"],
    pages: 0,
    chunks: 0,
  };
}
