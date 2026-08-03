import type { BrowserCrawlDefinition } from "./collections.js";
import { MANIFEST_SCHEMA_VERSION, SEARCH_PROTOCOL_VERSION, SEARCHD_PROTOCOL_VERSION } from "./versions.js";

export interface AssetDescriptor {
  url: string;
  bytes: number;
  sha256: string;
}

export interface ModelDescriptor {
  id: "mixedbread-ai/mxbai-embed-xsmall-v1";
  revision: string;
  quantization: "uint8";
  dtype: "uint8";
  dimensions: 384;
  maxLength: number;
  pooling: "mean";
  normalize: true;
  documentTemplate: "title-heading-body-v1";
  queryTemplate: "normalized-query-v1";
  fingerprint: string;
  assets: Record<string, AssetDescriptor>;
}

export interface SearchExperienceManifest {
  schema: typeof MANIFEST_SCHEMA_VERSION;
  protocol: typeof SEARCH_PROTOCOL_VERSION;
  version: string;
  agentos: {
    tag: string;
    /** Product image: plane-B search-atlas (posix + sqlite + /svc/searchd). */
    image: "search-atlas" | string;
  };
  service: {
    name: "searchd";
    protocol: typeof SEARCHD_PROTOCOL_VERSION;
    /** Production transport is serviceCall only (stamped /svc/searchd). */
    transport: "serviceCall";
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
    /** Required — runtime loads mc-core from this integrity-checked descriptor. */
    mcCore: AssetDescriptor;
    searchdProtocol?: AssetDescriptor;
    snapshot?: AssetDescriptor;
    snapshotMetadata?: AssetDescriptor;
  };
  sqlite: {
    requiredFeatures: readonly ("FTS5" | "VANN")[];
    indexPath: string;
  };
  model: ModelDescriptor | null;
  collections: readonly BrowserCrawlDefinition[];
  snapshot?: {
    format: number;
    compatibilityKey?: string;
  };
}

export function isAssetDescriptor(value: unknown): value is AssetDescriptor {
  if (!value || typeof value !== "object") return false;
  const d = value as AssetDescriptor;
  return (
    typeof d.url === "string" &&
    Number.isSafeInteger(d.bytes) &&
    d.bytes >= 0 &&
    typeof d.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(d.sha256)
  );
}

export function validateManifest(value: unknown): SearchExperienceManifest {
  if (!value || typeof value !== "object") throw new Error("search manifest must be an object");
  const m = value as Partial<SearchExperienceManifest>;
  if (m.schema !== MANIFEST_SCHEMA_VERSION) throw new Error(`unsupported manifest schema ${String(m.schema)}`);
  if (m.protocol !== SEARCH_PROTOCOL_VERSION) throw new Error(`unsupported search protocol ${String(m.protocol)}`);
  if (!m.version || typeof m.version !== "string") throw new Error("search manifest missing version");
  if (!m.assets) throw new Error("search manifest missing assets");
  for (const key of ["main", "worker", "runtime", "embedder", "kernel", "image", "schema", "mcCore"] as const) {
    if (!isAssetDescriptor(m.assets[key])) throw new Error(`search manifest has invalid assets.${key}`);
  }
  if (m.assets.catalogCompiler && !isAssetDescriptor(m.assets.catalogCompiler)) {
    throw new Error("search manifest has invalid assets.catalogCompiler");
  }
  if (!m.sqlite?.requiredFeatures?.includes("FTS5") || !m.sqlite.requiredFeatures.includes("VANN")) {
    throw new Error("search image must declare FTS5 and VANN");
  }
  if (typeof m.sqlite.indexPath !== "string" || !m.sqlite.indexPath.startsWith("/")) {
    throw new Error("search manifest sqlite.indexPath must be an absolute guest path");
  }
  if (!Array.isArray(m.collections)) throw new Error("search manifest collections must be an array");
  if (m.service?.name !== "searchd" || m.service.protocol !== SEARCHD_PROTOCOL_VERSION) {
    throw new Error("search manifest service must be searchd protocol v1");
  }
  if (m.service.transport !== "serviceCall") {
    throw new Error("search manifest service.transport must be serviceCall");
  }
  if (m.model) {
    if (m.model.id !== "mixedbread-ai/mxbai-embed-xsmall-v1") {
      throw new Error("unsupported embedding model id");
    }
    if (!/^[a-f0-9]{64}$/.test(m.model.fingerprint)) {
      throw new Error("invalid model fingerprint");
    }
    for (const key of ["model", "tokenizer", "tokenizerConfig", "config", "runtimeModule", "runtimeWasm"]) {
      if (!isAssetDescriptor(m.model.assets?.[key])) {
        throw new Error(`search manifest model.assets.${key} is required`);
      }
    }
  }
  return m as SearchExperienceManifest;
}
