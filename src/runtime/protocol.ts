/** Worker ↔ page protocol. Bump SEARCH_PROTOCOL_VERSION when the contract changes. */

export const SEARCH_PROTOCOL_VERSION = 1 as const;

export interface AssetDescriptor {
  url: string;
  bytes: number;
  sha256: string;
}

export interface BrowserCrawlDefinition {
  id: string;
  label: string;
  seeds: string[];
  origins?: string[];
  includePathPrefixes?: string[];
  excludePathPrefixes?: string[];
  order?: number;
  limit?: number;
  minQueryLength?: number;
  placeholder?: string;
}

export interface SearchExperienceManifest {
  schema: 1;
  protocol: typeof SEARCH_PROTOCOL_VERSION;
  agentos?: {
    tag: string;
    image: string;
  };
  assets: {
    main: AssetDescriptor;
    worker: AssetDescriptor;
    runtime: AssetDescriptor;
    embedder: AssetDescriptor;
    kernel: AssetDescriptor;
    image: AssetDescriptor;
    schema: AssetDescriptor;
    catalogCompiler?: AssetDescriptor;
  };
  collections: BrowserCrawlDefinition[];
  model?: {
    id: string;
    fingerprint?: string;
    assets?: Record<string, AssetDescriptor>;
  } | null;
}

export type RuntimeToPageMessage =
  | { type: "ready"; protocol: typeof SEARCH_PROTOCOL_VERSION }
  | { type: "status"; phase: string; message?: string }
  | { type: "error"; message: string }
  | { type: "results"; query: string; collections: unknown[] };

export type PageToRuntimeMessage =
  | { type: "init"; manifestUrl: string; assetBase: string; collections?: BrowserCrawlDefinition[] }
  | { type: "query"; query: string; requestId: string }
  | { type: "refresh" };
