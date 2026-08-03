/** Pure text helpers + embed option types — no ML runtime imports. */

export const MIXEDBREAD_MODEL_ID = "mixedbread-ai/mxbai-embed-xsmall-v1" as const;
export const MIXEDBREAD_MODEL_REVISION = "e6ac24e5d6efb8782b59de1647b3ececb4ece94e" as const;
export const MIXEDBREAD_DIMENSIONS = 384 as const;

export interface EmbedderAsset {
  url: string;
  bytes: number;
  sha256: string;
}

export interface MixedbreadEmbedderOptions {
  assetBase: string | URL;
  assets?: Readonly<Record<string, EmbedderAsset>>;
  runtimeModule?: string | URL;
  runtimeWasm?: string | URL;
  cache?: Pick<Cache, "match" | "put">;
}

export interface MixedbreadEmbedder {
  embed(texts: readonly string[]): Promise<readonly Float32Array[]>;
  dispose(): Promise<void>;
}

export function mixedbreadDocumentText(title: string, heading: string, body: string): string {
  return [title.trim(), heading.trim(), body.trim()].filter(Boolean).join("\n");
}

export function mixedbreadQueryText(query: string): string {
  return query.normalize("NFKC").replace(/\s+/g, " ").trim();
}
