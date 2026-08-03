/**
 * Versioned `/svc/searchd` request/response contract.
 * Host always encodes/decodes this envelope; guest is the sole policy authority.
 */

import type { BrowserCrawlDefinition, CrawlCollectionDescriptor } from "./collections.js";
import { SEARCHD_PROTOCOL_VERSION } from "./versions.js";

export type SearchdOp =
  | "configure"
  | "status"
  | "crawl_step"
  | "embed_step"
  | "query"
  | "checkpoint"
  | "promote"
  | "refresh"
  | "cancel";

export interface SearchdConfigureRequest {
  v: typeof SEARCHD_PROTOCOL_VERSION;
  op: "configure";
  id: string;
  config: {
    collections: readonly BrowserCrawlDefinition[];
    schemaSql: string;
    modelFingerprint: string;
    compatibilityKey: string;
    pageOrigin: string;
    refreshAfterMs?: number;
    indexPath?: string;
    /**
     * When true, if guest state already matches compatibilityKey and is
     * lexical-ready, do not wipe index/queues — warm resume after snapshot restore.
     */
    resume?: boolean;
  };
}

export interface SearchdRefreshRequest {
  v: typeof SEARCHD_PROTOCOL_VERSION;
  op: "refresh";
  id: string;
}

export interface SearchdStatusRequest {
  v: typeof SEARCHD_PROTOCOL_VERSION;
  op: "status";
  id: string;
}

export interface SearchdCrawlStepRequest {
  v: typeof SEARCHD_PROTOCOL_VERSION;
  op: "crawl_step";
  id: string;
  /** Max host-tool fetch calls this step (guest-enforced budget). */
  maxFetches?: number;
}

export interface SearchdEmbedStepRequest {
  v: typeof SEARCHD_PROTOCOL_VERSION;
  op: "embed_step";
  id: string;
  maxChunks?: number;
}

export interface SearchdQueryRequest {
  v: typeof SEARCHD_PROTOCOL_VERSION;
  op: "query";
  id: string;
  collectionId: string;
  query: string;
  limit?: number;
  /** Optional query embedding (384-d float32 as number[]). */
  queryVector?: readonly number[];
  candidateLimit?: number;
  perPageLimit?: number;
  rrfK?: number;
}

export interface SearchdCheckpointRequest {
  v: typeof SEARCHD_PROTOCOL_VERSION;
  op: "checkpoint";
  id: string;
  kind?: "lexical" | "semantic" | "idle";
}

export interface SearchdPromoteRequest {
  v: typeof SEARCHD_PROTOCOL_VERSION;
  op: "promote";
  id: string;
  generationId: string;
}

export interface SearchdCancelRequest {
  v: typeof SEARCHD_PROTOCOL_VERSION;
  op: "cancel";
  id: string;
  targetId?: string;
}

export type SearchdRequest =
  | SearchdConfigureRequest
  | SearchdStatusRequest
  | SearchdCrawlStepRequest
  | SearchdEmbedStepRequest
  | SearchdQueryRequest
  | SearchdCheckpointRequest
  | SearchdPromoteRequest
  | SearchdRefreshRequest
  | SearchdCancelRequest;

export interface SearchdHit {
  id: string;
  collectionId: string;
  pageId: number;
  url: string;
  title: string;
  heading?: string;
  snippet?: string;
  body?: string;
  score: number;
  lexicalRank?: number;
  semanticRank?: number;
  fusedRank?: number;
}

export interface SearchdStatusBody {
  phase:
    | "unconfigured"
    | "configuring"
    | "crawling"
    | "lexical_ready"
    | "embedding"
    | "semantic_ready"
    | "refreshing"
    | "error";
  message?: string;
  compatibilityKey?: string;
  activeGeneration?: string;
  candidateGeneration?: string | null;
  lexicalReady: boolean;
  semanticReady: boolean;
  collections: readonly CrawlCollectionDescriptor[];
  pages?: number;
  chunks?: number;
  embeddedChunks?: number;
  queueDepth?: number;
  error?: string;
  truncated?: boolean;
}

export interface SearchdOkResponse {
  v: typeof SEARCHD_PROTOCOL_VERSION;
  id: string;
  ok: true;
  op: SearchdOp;
  status?: SearchdStatusBody;
  /** crawl_step / embed_step progress */
  progress?: {
    fetches?: number;
    indexedPages?: number;
    indexedChunks?: number;
    embeddedChunks?: number;
    queueDepth?: number;
    done: boolean;
  };
  hits?: readonly SearchdHit[];
  semanticAvailable?: boolean;
  checkpoint?: { kind: string; at: string };
  promoted?: { generationId: string };
}

export interface SearchdErrResponse {
  v: typeof SEARCHD_PROTOCOL_VERSION;
  id: string;
  ok: false;
  code: string;
  error: string;
}

export type SearchdResponse = SearchdOkResponse | SearchdErrResponse;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeSearchdRequest(request: SearchdRequest): Uint8Array {
  return textEncoder.encode(JSON.stringify(request));
}

export function decodeSearchdResponse(bytes: Uint8Array): SearchdResponse {
  const text = textDecoder.decode(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("searchd response is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("searchd response must be an object");
  const r = parsed as Partial<SearchdResponse>;
  if (r.v !== SEARCHD_PROTOCOL_VERSION) throw new Error(`unsupported searchd protocol ${String(r.v)}`);
  if (typeof r.id !== "string") throw new Error("searchd response missing id");
  if (r.ok !== true && r.ok !== false) throw new Error("searchd response missing ok");
  return r as SearchdResponse;
}

export function encodeSearchdResponse(response: SearchdResponse): Uint8Array {
  return textEncoder.encode(JSON.stringify(response));
}

export function decodeSearchdRequest(bytes: Uint8Array): SearchdRequest {
  const text = textDecoder.decode(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("searchd request is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("searchd request must be an object");
  const r = parsed as Partial<SearchdRequest>;
  if (r.v !== SEARCHD_PROTOCOL_VERSION) throw new Error(`unsupported searchd protocol ${String(r.v)}`);
  if (typeof r.op !== "string" || typeof r.id !== "string") {
    throw new Error("searchd request missing op/id");
  }
  return r as SearchdRequest;
}

let reqSeq = 0;
export function nextSearchdId(prefix = "req"): string {
  reqSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${reqSeq}`;
}
