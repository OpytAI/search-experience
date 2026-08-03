/** Versioned page ↔ dedicated runtime worker protocol. */

import type { BrowserCrawlDefinition, CrawlCollectionDescriptor } from "./collections.js";
import type { SearchItem } from "../search/types.js";
import { SEARCH_PROTOCOL_VERSION } from "./versions.js";

export type { BrowserCrawlDefinition, CrawlCollectionDescriptor };

export type PageToRuntimeMessage =
  | {
      protocol: typeof SEARCH_PROTOCOL_VERSION;
      type: "init";
      requestId: string;
      manifestUrl: string;
      assetBase: string;
      pageOrigin: string;
      collections: readonly BrowserCrawlDefinition[];
      refreshAfterMs?: number;
    }
  | {
      protocol: typeof SEARCH_PROTOCOL_VERSION;
      type: "query";
      requestId: string;
      collectionId: string;
      query: string;
      limit: number;
      generation: number;
    }
  | {
      protocol: typeof SEARCH_PROTOCOL_VERSION;
      type: "refresh";
      requestId: string;
    }
  | {
      protocol: typeof SEARCH_PROTOCOL_VERSION;
      type: "cancel";
      requestId: string;
      targetRequestId: string;
      generation: number;
    }
  | {
      protocol: typeof SEARCH_PROTOCOL_VERSION;
      type: "status";
      requestId: string;
    };

export type RuntimeToPageMessage =
  | {
      protocol: typeof SEARCH_PROTOCOL_VERSION;
      type: "ready";
      requestId: string;
      collections: readonly CrawlCollectionDescriptor[];
      phase: string;
    }
  | {
      protocol: typeof SEARCH_PROTOCOL_VERSION;
      type: "status";
      requestId?: string;
      phase: string;
      message?: string;
      lexicalReady?: boolean;
      semanticReady?: boolean;
    }
  | {
      protocol: typeof SEARCH_PROTOCOL_VERSION;
      type: "progress";
      requestId: string;
      generation: number;
      collectionId: string;
      stage: "lexical" | "semantic" | "hybrid";
      items: readonly SearchItem[];
    }
  | {
      protocol: typeof SEARCH_PROTOCOL_VERSION;
      type: "results";
      requestId: string;
      generation: number;
      collectionId: string;
      items: readonly SearchItem[];
      semanticAvailable: boolean;
    }
  | {
      protocol: typeof SEARCH_PROTOCOL_VERSION;
      type: "error";
      requestId?: string;
      code?: string;
      message: string;
    };

export function isRuntimeToPageMessage(value: unknown): value is RuntimeToPageMessage {
  if (!value || typeof value !== "object") return false;
  const m = value as RuntimeToPageMessage;
  return m.protocol === SEARCH_PROTOCOL_VERSION && typeof m.type === "string";
}
