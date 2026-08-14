/** Versioned page ↔ dedicated runtime worker protocol. */

import type { BrowserCrawlDefinition, CrawlCollectionDescriptor } from "./collections.js";
import type { SearchItem } from "../ui/palette/types.js";
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
    }
  | {
      protocol: typeof SEARCH_PROTOCOL_VERSION;
      type: "diagnostics";
      requestId: string;
    }
  | {
      protocol: typeof SEARCH_PROTOCOL_VERSION;
      type: "exportSnapshot";
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
      type: "diagnostics";
      requestId: string;
      /** Cold/warm boot duration to init completion, when measured. */
      bootMs?: number;
      /** Last query end-to-end latency in the worker, when measured. */
      lastQueryMs?: number;
      lexicalReady: boolean;
      semanticReady: boolean;
      /** Non-sensitive prefix of the active compatibility key. */
      compatibilityKeyPrefix?: string;
      /** Sum of known asset byte totals from the distribution manifest. */
      assetBytesTotal?: number;
      phase?: string;
    }
  | {
      protocol: typeof SEARCH_PROTOCOL_VERSION;
      type: "error";
      requestId?: string;
      code?: string;
      message: string;
    }
  | {
      protocol: typeof SEARCH_PROTOCOL_VERSION;
      type: "snapshot";
      requestId: string;
      /** MCSN bytes as base64 for transfer across the worker boundary. */
      snapshotBase64: string;
      meta: import("./snapshot.js").SnapshotCompatibility;
    };

/**
 * Discriminated runtime→page message check (used by client + tests).
 * Requires the fields that the union declares as non-optional for each type.
 */
export function isRuntimeToPageMessage(value: unknown): value is RuntimeToPageMessage {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  if (m.protocol !== SEARCH_PROTOCOL_VERSION || typeof m.type !== "string") return false;
  switch (m.type) {
    case "status":
      return typeof m.phase === "string";
    case "ready":
      return (
        typeof m.requestId === "string" &&
        typeof m.phase === "string" &&
        Array.isArray(m.collections)
      );
    case "progress":
      return (
        typeof m.requestId === "string" &&
        typeof m.generation === "number" &&
        typeof m.collectionId === "string" &&
        typeof m.stage === "string" &&
        Array.isArray(m.items)
      );
    case "results":
      return (
        typeof m.requestId === "string" &&
        typeof m.generation === "number" &&
        typeof m.collectionId === "string" &&
        Array.isArray(m.items) &&
        typeof m.semanticAvailable === "boolean"
      );
    case "diagnostics":
      return (
        typeof m.requestId === "string" &&
        typeof m.lexicalReady === "boolean" &&
        typeof m.semanticReady === "boolean"
      );
    case "error":
      return typeof m.message === "string";
    case "snapshot":
      return (
        typeof m.requestId === "string" &&
        typeof m.snapshotBase64 === "string" &&
        m.meta !== null &&
        typeof m.meta === "object"
      );
    default:
      return false;
  }
}
