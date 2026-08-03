/**
 * Host-tool input/output contracts for searchd.
 * Only effects live here; crawl policy and ranking stay in the guest.
 */

export interface SearchFetchInput {
  url: string;
  /** Max response body bytes (guest-supplied budget). */
  maxBytes?: number;
  timeoutMs?: number;
  userAgent?: string;
}

export interface SearchFetchOutput {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
}

export interface SearchExtractInput {
  url: string;
  html: string;
}

export interface ExtractedBlock {
  heading: string;
  text: string;
}

export interface SearchExtractOutput {
  requestedUrl: string;
  canonicalUrl: string;
  title: string;
  description: string;
  language: string;
  noindex: boolean;
  blocks: ExtractedBlock[];
  links: string[];
}

export interface SearchEmbedBatchInput {
  texts: readonly string[];
  /** "document" | "query" — host may apply template pre-processing. */
  kind?: "document" | "query";
}

export interface SearchEmbedBatchOutput {
  /** Row-major 384-d vectors (one per input text). */
  vectors: readonly (readonly number[])[];
  dimensions: 384;
  modelFingerprint: string;
}
