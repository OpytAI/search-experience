import type { SearchEmbedBatchInput, SearchEmbedBatchOutput } from "../protocol/host-tools.js";
import {
  mixedbreadDocumentText,
  mixedbreadQueryText,
  MIXEDBREAD_DIMENSIONS,
  type MixedbreadEmbedder,
  type MixedbreadEmbedderOptions,
} from "../embedding/text.js";

export type { MixedbreadEmbedderOptions, MixedbreadEmbedder };
export { mixedbreadDocumentText, mixedbreadQueryText };

export type EmbedderFactory = (options: MixedbreadEmbedderOptions) => Promise<MixedbreadEmbedder>;

export interface EmbedToolState {
  embedder: MixedbreadEmbedder | null;
  modelFingerprint: string;
  loading: Promise<MixedbreadEmbedder> | null;
  options: MixedbreadEmbedderOptions | null;
  factory: EmbedderFactory | null;
}

export function createEmbedToolState(): EmbedToolState {
  return { embedder: null, modelFingerprint: "", loading: null, options: null, factory: null };
}

export function configureEmbedTool(
  state: EmbedToolState,
  options: MixedbreadEmbedderOptions,
  fingerprint: string,
  factory?: EmbedderFactory | null,
): void {
  state.options = options;
  state.modelFingerprint = fingerprint;
  state.embedder = null;
  state.loading = null;
  if (factory) state.factory = factory;
}

export function setEmbedderFactory(state: EmbedToolState, factory: EmbedderFactory): void {
  state.factory = factory;
  state.embedder = null;
  state.loading = null;
}

async function ensureEmbedder(state: EmbedToolState): Promise<MixedbreadEmbedder> {
  if (state.embedder) return state.embedder;
  if (!state.options) throw new Error("embed tool is not configured");
  if (!state.factory) {
    throw new Error(
      "embedder factory is not configured; runtime must load agentos-search-embed.mjs hermetically",
    );
  }
  if (!state.loading) {
    state.loading = state.factory(state.options).then((embedder) => {
      state.embedder = embedder;
      return embedder;
    }).catch((error) => {
      state.loading = null;
      throw error;
    });
  }
  return state.loading;
}

export async function runSearchEmbedBatch(
  state: EmbedToolState,
  input: SearchEmbedBatchInput,
): Promise<SearchEmbedBatchOutput> {
  const texts = input.texts.map((text) => {
    if (input.kind === "query") return mixedbreadQueryText(text);
    return text;
  });
  const embedder = await ensureEmbedder(state);
  const vectors = await embedder.embed(texts);
  return {
    vectors: vectors.map((row) => [...row]),
    dimensions: MIXEDBREAD_DIMENSIONS,
    modelFingerprint: state.modelFingerprint,
  };
}
