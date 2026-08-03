/**
 * Mixedbread mxbai-embed-xsmall-v1 UINT8 host embedding surface.
 *
 * This module is the release entry `agentos-search-embed.mjs`. Rolldown
 * **statically** bundles `@huggingface/transformers` so the copy-and-import
 * package has no bare npm imports for site visitors.
 */

import { env, pipeline } from "@huggingface/transformers";
import {
  MIXEDBREAD_DIMENSIONS,
  type MixedbreadEmbedder,
  type MixedbreadEmbedderOptions,
} from "./embedding-text.js";

export {
  MIXEDBREAD_MODEL_ID,
  MIXEDBREAD_MODEL_REVISION,
  MIXEDBREAD_DIMENSIONS,
  mixedbreadDocumentText,
  mixedbreadQueryText,
  type EmbedderAsset,
  type MixedbreadEmbedderOptions,
  type MixedbreadEmbedder,
} from "./embedding-text.js";

function normalize(values: readonly number[]): Float32Array {
  let squared = 0;
  for (const value of values) squared += value * value;
  const norm = Math.sqrt(squared) || 1;
  return Float32Array.from(values, (value) => value / norm);
}

/**
 * Create the Mixedbread embedder using the hermetically bundled Transformers.js
 * graph and only the copied ONNX/tokenizer/ORT assets next to the release.
 */
export async function createMixedbreadEmbedder(options: MixedbreadEmbedderOptions): Promise<MixedbreadEmbedder> {
  const runtimeGlobal = globalThis as typeof globalThis & Record<PropertyKey, unknown>;
  const savedProcess = runtimeGlobal.process;
  const emulatedBrowser = typeof savedProcess !== "undefined" && typeof window === "undefined";
  if (emulatedBrowser) Reflect.set(runtimeGlobal, "process", undefined);

  try {
    const assetBase = new URL(options.assetBase);
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    env.localModelPath = assetBase.href;
    env.useBrowserCache = !options.cache && typeof caches !== "undefined";
    env.useCustomCache = Boolean(options.cache);
    env.customCache = options.cache ?? null;
    if (!env.backends.onnx?.wasm) {
      throw new Error("Transformers.js does not expose the ONNX Wasm backend");
    }
    const runtimeBase = new URL("model/runtime/", assetBase);
    if (options.runtimeModule) {
      env.backends.onnx.wasm.wasmPaths = {
        mjs: new URL(options.runtimeModule).href,
        wasm: new URL(
          options.runtimeWasm ?? "ort-wasm-simd-threaded.jsep.wasm",
          options.runtimeWasm ? undefined : runtimeBase,
        ).href,
      };
    } else {
      // Prefer shipped ORT under model/runtime/ — never fall back to a CDN.
      env.backends.onnx.wasm.wasmPaths = runtimeBase.href;
    }
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.proxy = false;

    const extractor = await pipeline("feature-extraction", "model", {
      dtype: "uint8",
      device: "wasm",
    });

    return {
      async embed(texts: readonly string[]): Promise<readonly Float32Array[]> {
        if (texts.length === 0) return [];
        const output = await extractor([...texts], { pooling: "mean", normalize: true });
        const listed = (output as { tolist: () => unknown }).tolist() as unknown;
        const rows = Array.isArray(listed) && typeof listed[0] === "number" ? [listed] : listed;
        if (!Array.isArray(rows) || rows.length !== texts.length) {
          throw new Error("embedding output shape does not match input batch");
        }
        return rows.map((row) => {
          if (
            !Array.isArray(row) ||
            row.length !== MIXEDBREAD_DIMENSIONS ||
            row.some((value) => typeof value !== "number" || !Number.isFinite(value))
          ) {
            throw new Error("embedding output is not a finite 384-dimensional vector");
          }
          return normalize(row as number[]);
        });
      },
      async dispose(): Promise<void> {
        await (extractor as { dispose?: () => Promise<void> }).dispose?.();
      },
    };
  } finally {
    if (emulatedBrowser) Reflect.set(runtimeGlobal, "process", savedProcess);
  }
}

/** Stable public alias used by release embed entry. */
export async function createEmbedder(options?: MixedbreadEmbedderOptions): Promise<MixedbreadEmbedder> {
  if (!options) throw new Error("createEmbedder requires assetBase and model layout options");
  return createMixedbreadEmbedder(options);
}
