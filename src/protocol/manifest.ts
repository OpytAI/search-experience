import type { BrowserCrawlDefinition } from "./collections.js";
import {
  HOST_TOOL_ADDRESSES,
  MANIFEST_SCHEMA_VERSION,
  SEARCH_PROTOCOL_VERSION,
  SEARCHD_PROTOCOL_VERSION,
} from "./versions.js";

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

/** Guest fusion fingerprint — must match searchd RRF defaults when present. */
export interface ManifestFusion {
  strategy: "rrf";
  rrfK: number;
  perPageLimit: number;
}

/** Host-tool addresses required for searchd effects (fetch / extract / embed). */
export interface ManifestHostTools {
  addresses: readonly string[];
}

/**
 * Optional mirror of service for deployments that key on "searchd" explicitly.
 * When present, must agree with `service`.
 */
export interface ManifestSearchd {
  protocol: typeof SEARCHD_PROTOCOL_VERSION;
  transport: "serviceCall";
}

export interface SearchExperienceManifest {
  schema: typeof MANIFEST_SCHEMA_VERSION;
  protocol: typeof SEARCH_PROTOCOL_VERSION;
  version: string;
  agentos: {
    tag: string;
    /** Product guest image (search-atlas: base + sqlite + /svc/searchd). */
    image: "search-atlas" | string;
  };
  service: {
    name: "searchd";
    protocol: typeof SEARCHD_PROTOCOL_VERSION;
    /** Production transport is serviceCall only (stamped /svc/searchd). */
    transport: "serviceCall";
  };
  /** Optional explicit searchd block (same contract as service.protocol/transport). */
  searchd?: ManifestSearchd;
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
  /**
   * Site collection descriptors. Build-time release ships `[]`; runtime configure
   * supplies the integrator crawl definitions.
   */
  collections: readonly BrowserCrawlDefinition[];
  /** Optional fusion fingerprint (RRF). Omitted manifests still validate. */
  fusion?: ManifestFusion;
  /** Optional host-tool address list. Omitted manifests still validate. */
  hostTools?: ManifestHostTools;
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

function validateFusion(value: unknown): asserts value is ManifestFusion {
  if (!value || typeof value !== "object") throw new Error("search manifest fusion must be an object");
  const f = value as Partial<ManifestFusion>;
  if (f.strategy !== "rrf") throw new Error('search manifest fusion.strategy must be "rrf"');
  if (typeof f.rrfK !== "number" || !Number.isFinite(f.rrfK) || f.rrfK <= 0) {
    throw new Error("search manifest fusion.rrfK must be a positive number");
  }
  if (typeof f.perPageLimit !== "number" || !Number.isInteger(f.perPageLimit) || f.perPageLimit <= 0) {
    throw new Error("search manifest fusion.perPageLimit must be a positive integer");
  }
}

function validateHostTools(value: unknown): asserts value is ManifestHostTools {
  if (!value || typeof value !== "object") throw new Error("search manifest hostTools must be an object");
  const h = value as Partial<ManifestHostTools>;
  if (!Array.isArray(h.addresses) || h.addresses.length === 0) {
    throw new Error("search manifest hostTools.addresses must be a non-empty string array");
  }
  if (!h.addresses.every((a) => typeof a === "string" && a.length > 0)) {
    throw new Error("search manifest hostTools.addresses must contain only non-empty strings");
  }
  const required = Object.values(HOST_TOOL_ADDRESSES);
  for (const addr of required) {
    if (!h.addresses.includes(addr)) {
      throw new Error(`search manifest hostTools.addresses missing required ${addr}`);
    }
  }
}

function validateSearchd(value: unknown, service: SearchExperienceManifest["service"]): asserts value is ManifestSearchd {
  if (!value || typeof value !== "object") throw new Error("search manifest searchd must be an object");
  const s = value as Partial<ManifestSearchd>;
  if (s.protocol !== SEARCHD_PROTOCOL_VERSION) {
    throw new Error("search manifest searchd.protocol must be 1");
  }
  if (s.transport !== "serviceCall") {
    throw new Error("search manifest searchd.transport must be serviceCall");
  }
  if (s.protocol !== service.protocol || s.transport !== service.transport) {
    throw new Error("search manifest searchd must match service.protocol/transport");
  }
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
  // Optional richer fields — accept when present, never require.
  if (m.fusion !== undefined) validateFusion(m.fusion);
  if (m.hostTools !== undefined) validateHostTools(m.hostTools);
  if (m.searchd !== undefined) validateSearchd(m.searchd, m.service);
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
