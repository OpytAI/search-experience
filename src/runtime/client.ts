import type { BrowserCrawlDefinition, PageToRuntimeMessage, RuntimeToPageMessage } from "./protocol.js";
import { SEARCH_PROTOCOL_VERSION } from "./protocol.js";
import type { SearchCollection, SearchItem } from "../search/types.js";

export function makeCrawlCollection(definition: BrowserCrawlDefinition): SearchCollection {
  return {
    id: definition.id,
    label: definition.label,
    order: definition.order ?? 10,
    items: [] as SearchItem[],
  };
}

export class SearchWorkerClient {
  readonly worker: Worker;
  private readonly listeners = new Set<(message: RuntimeToPageMessage) => void>();

  constructor(worker: Worker) {
    this.worker = worker;
    this.worker.addEventListener("message", (event: MessageEvent<RuntimeToPageMessage>) => {
      for (const listener of this.listeners) listener(event.data);
    });
  }

  onMessage(listener: (message: RuntimeToPageMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  post(message: PageToRuntimeMessage): void {
    this.worker.postMessage(message);
  }

  init(manifestUrl: string, assetBase: string, collections?: readonly BrowserCrawlDefinition[]): void {
    this.post({
      type: "init",
      manifestUrl,
      assetBase,
      collections: collections ? [...collections] : undefined,
    });
  }

  query(query: string, requestId: string): void {
    this.post({ type: "query", query, requestId });
  }

  get protocol(): typeof SEARCH_PROTOCOL_VERSION {
    return SEARCH_PROTOCOL_VERSION;
  }
}
