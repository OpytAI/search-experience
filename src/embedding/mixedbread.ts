/**
 * Mixedbread mxbai-embed-xsmall-v1 UINT8 host embedding surface.
 *
 * This module is the release entry `agentos-search-embed.mjs`. Rolldown
 * **statically** bundles `@huggingface/transformers` so the copy-and-import
 * package has no bare npm imports for site visitors.
 *
 * Package layout (release):
 *   model/model.onnx              ← uint8 weights (manifest assets.model)
 *   model/config.json
 *   model/tokenizer.json
 *   model/tokenizer_config.json
 *   model/runtime/ort-*.{mjs,wasm}
 *
 * Transformers.js 3.x with `dtype: "uint8"` and default `subfolder: "onnx"`
 * requests `{localModelPath}/model/onnx/model_uint8.onnx` when the model id is
 * `"model"`. That path is **not** how we ship the file. Integrity requires the
 * verified `model/model.onnx` bytes to be served under every URL Transformers
 * will actually request — see `TRANSFORMERS_MODEL_WEIGHT_ALIASES`.
 */

import { env, pipeline } from "@huggingface/transformers";
import {
  MIXEDBREAD_DIMENSIONS,
  type EmbedderAsset,
  type MixedbreadEmbedder,
  type MixedbreadEmbedderOptions,
} from "./text.js";

export {
  MIXEDBREAD_MODEL_ID,
  MIXEDBREAD_MODEL_REVISION,
  MIXEDBREAD_DIMENSIONS,
  mixedbreadDocumentText,
  mixedbreadQueryText,
  type EmbedderAsset,
  type MixedbreadEmbedderOptions,
  type MixedbreadEmbedder,
} from "./text.js";

/** Model id passed to pipeline(); with localModelPath = package root → model/* */
export const TRANSFORMERS_MODEL_ID = "model" as const;

/**
 * Relative to package root: paths Transformers requests for the ONNX graph when
 * `pipeline(…, "model", { dtype: "uint8", subfolder: "onnx" })` runs.
 * All aliases map to the same verified bytes as manifest `assets.model`
 * (`model/model.onnx`).
 */
export const TRANSFORMERS_MODEL_WEIGHT_ALIASES = [
  // Actual Transformers 3.x resolution (dtype uint8 → suffix _uint8, default subfolder onnx).
  "model/onnx/model_uint8.onnx",
  // Shipped package path (manifest).
  "model/model.onnx",
] as const;

/** Non-weight files Transformers loads next to the model id directory. */
export const TRANSFORMERS_SIDE_FILES = {
  config: "model/config.json",
  tokenizer: "model/tokenizer.json",
  tokenizerConfig: "model/tokenizer_config.json",
} as const;

function normalize(values: readonly number[]): Float32Array {
  let squared = 0;
  for (const value of values) squared += value * value;
  const norm = Math.sqrt(squared) || 1;
  return Float32Array.from(values, (value) => value / norm);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Fetch + SHA-256 verify one manifest model asset against `packageBase`.
 * Descriptor URLs are package-relative (e.g. `model/model.onnx`).
 */
async function verifiedAssetBytes(
  packageBase: string | URL,
  descriptor: EmbedderAsset,
  name: string,
): Promise<Uint8Array> {
  const url = new URL(descriptor.url, packageBase);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`model asset ${name} HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const hash = await sha256Hex(bytes);
  if (hash !== descriptor.sha256) {
    throw new Error(`integrity check failed for model.${name}`);
  }
  return bytes;
}

function indexBytes(byUrl: Map<string, Uint8Array>, absoluteHref: string, bytes: Uint8Array): void {
  byUrl.set(absoluteHref, bytes);
  try {
    byUrl.set(new URL(absoluteHref).pathname, bytes);
  } catch {
    /* ignore */
  }
}

/**
 * Cache Storage-shaped store that serves only pre-verified bytes.
 * Transformers.js consults customCache before network when useCustomCache is set.
 * Misses return undefined so Transformers falls through — with allowRemoteModels=false
 * and no matching local file that is fail-closed for unknown paths.
 */
function createVerifiedCache(byUrl: Map<string, Uint8Array>): Pick<Cache, "match" | "put"> {
  const matchOne = (requestUrl: string): Response | undefined => {
    const exact = byUrl.get(requestUrl);
    if (exact) {
      const copy = new Uint8Array(exact.byteLength);
      copy.set(exact);
      return new Response(copy, {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      });
    }
    let reqPath: string | undefined;
    try {
      reqPath = new URL(requestUrl).pathname;
    } catch {
      reqPath = undefined;
    }
    if (reqPath && byUrl.has(reqPath)) {
      const bytes = byUrl.get(reqPath)!;
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      return new Response(copy, {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      });
    }
    // Suffix match for pathJoin / trailing-slash variance (still only verified keys).
    for (const [key, bytes] of byUrl) {
      if (!key.includes("/") && !key.includes(":")) continue;
      try {
        const keyPath = key.startsWith("/") ? key : new URL(key).pathname;
        if (reqPath && (reqPath === keyPath || reqPath.endsWith(keyPath) || keyPath.endsWith(reqPath))) {
          const copy = new Uint8Array(bytes.byteLength);
          copy.set(bytes);
          return new Response(copy, {
            status: 200,
            headers: { "Content-Type": "application/octet-stream" },
          });
        }
      } catch {
        if (requestUrl.endsWith(key) || key.endsWith(requestUrl)) {
          const copy = new Uint8Array(bytes.byteLength);
          copy.set(bytes);
          return new Response(copy, {
            status: 200,
            headers: { "Content-Type": "application/octet-stream" },
          });
        }
      }
    }
    return undefined;
  };

  return {
    async match(request: RequestInfo | URL) {
      const url =
        typeof request === "string"
          ? request
          : request instanceof URL
            ? request.href
            : request.url;
      return matchOne(url) ?? undefined;
    },
    async put() {
      // Immutable verified map — ignore writer puts from the library.
    },
  };
}

/**
 * Build the verified URL map: every manifest digest, plus Transformers load-path
 * aliases so the **executed** ONNX graph is the same bytes that were hashed.
 */
export async function buildVerifiedModelUrlMap(
  localRoot: URL,
  assets: Readonly<Record<string, EmbedderAsset>>,
): Promise<Map<string, Uint8Array>> {
  const byUrl = new Map<string, Uint8Array>();
  const verified = new Map<string, Uint8Array>();

  for (const [key, descriptor] of Object.entries(assets)) {
    const bytes = await verifiedAssetBytes(localRoot, descriptor, key);
    verified.set(key, bytes);
    indexBytes(byUrl, new URL(descriptor.url, localRoot).href, bytes);
  }

  const modelBytes = verified.get("model");
  if (!modelBytes) {
    throw new Error("model integrity: assets.model is required");
  }

  // Bind verified weights to every path Transformers may request for this layout.
  for (const rel of TRANSFORMERS_MODEL_WEIGHT_ALIASES) {
    indexBytes(byUrl, new URL(rel, localRoot).href, modelBytes);
  }

  // Side files under the names Transformers requests (usually equal to descriptor urls).
  const side: Array<[string, string]> = [
    ["config", TRANSFORMERS_SIDE_FILES.config],
    ["tokenizer", TRANSFORMERS_SIDE_FILES.tokenizer],
    ["tokenizerConfig", TRANSFORMERS_SIDE_FILES.tokenizerConfig],
  ];
  for (const [key, rel] of side) {
    const bytes = verified.get(key);
    if (!bytes) throw new Error(`model integrity: assets.${key} is required`);
    indexBytes(byUrl, new URL(rel, localRoot).href, bytes);
  }

  // Fail closed: required Transformers weight path must resolve in the map.
  for (const rel of TRANSFORMERS_MODEL_WEIGHT_ALIASES) {
    const href = new URL(rel, localRoot).href;
    if (!byUrl.has(href) && !byUrl.has(new URL(rel, localRoot).pathname)) {
      throw new Error(`model integrity: missing verified mapping for ${rel}`);
    }
  }

  return byUrl;
}

/**
 * Create the Mixedbread embedder using the hermetically bundled Transformers.js
 * graph. Production (`options.assets` set) verifies every digest, then binds
 * Transformers to those bytes via customCache — including aliases for the
 * `onnx/model_uint8.onnx` path Transformers actually requests.
 */
export async function createMixedbreadEmbedder(options: MixedbreadEmbedderOptions): Promise<MixedbreadEmbedder> {
  const runtimeGlobal = globalThis as typeof globalThis & Record<PropertyKey, unknown>;
  const savedProcess = runtimeGlobal.process;
  const emulatedBrowser = typeof savedProcess !== "undefined" && typeof window === "undefined";
  if (emulatedBrowser) Reflect.set(runtimeGlobal, "process", undefined);

  const blobUrls: string[] = [];
  try {
    const packageBase = new URL(options.assetBase);
    // Package root so model id "model" → model/* under localModelPath.
    const localRoot =
      packageBase.pathname.endsWith("/model/") || packageBase.pathname.endsWith("/model")
        ? new URL("..", packageBase.href.endsWith("/") ? packageBase : packageBase.href + "/")
        : packageBase;

    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    env.localModelPath = localRoot.href;
    env.useBrowserCache = false;

    let runtimeModuleUrl: string | undefined;
    let runtimeWasmUrl: string | undefined;

    if (options.assets && Object.keys(options.assets).length > 0) {
      const byUrl = await buildVerifiedModelUrlMap(localRoot, options.assets);
      env.useCustomCache = true;
      env.customCache = createVerifiedCache(byUrl);

      const runtimeModule = options.assets.runtimeModule;
      const runtimeWasm = options.assets.runtimeWasm;
      if (!runtimeModule || !runtimeWasm) {
        throw new Error("model integrity: runtimeModule and runtimeWasm assets are required");
      }
      const mjsHref = new URL(runtimeModule.url, localRoot).href;
      const wasmHref = new URL(runtimeWasm.url, localRoot).href;
      const mjsBytes = byUrl.get(mjsHref) ?? (await verifiedAssetBytes(localRoot, runtimeModule, "runtimeModule"));
      const wasmBytes = byUrl.get(wasmHref) ?? (await verifiedAssetBytes(localRoot, runtimeWasm, "runtimeWasm"));
      {
        const copy = new Uint8Array(mjsBytes.byteLength);
        copy.set(mjsBytes);
        runtimeModuleUrl = URL.createObjectURL(new Blob([copy], { type: "text/javascript" }));
        blobUrls.push(runtimeModuleUrl);
      }
      {
        const copy = new Uint8Array(wasmBytes.byteLength);
        copy.set(wasmBytes);
        runtimeWasmUrl = URL.createObjectURL(new Blob([copy], { type: "application/wasm" }));
        blobUrls.push(runtimeWasmUrl);
      }
    } else {
      // Dev / incomplete options: no digests — not production integrity.
      env.useCustomCache = Boolean(options.cache);
      env.customCache = options.cache ?? null;
      env.useBrowserCache = !options.cache && typeof caches !== "undefined";
      if (options.runtimeModule) runtimeModuleUrl = new URL(options.runtimeModule).href;
      if (options.runtimeWasm) runtimeWasmUrl = new URL(options.runtimeWasm).href;
    }

    if (!env.backends.onnx?.wasm) {
      throw new Error("Transformers.js does not expose the ONNX Wasm backend");
    }
    if (runtimeModuleUrl && runtimeWasmUrl) {
      env.backends.onnx.wasm.wasmPaths = {
        mjs: runtimeModuleUrl,
        wasm: runtimeWasmUrl,
      };
    } else {
      env.backends.onnx.wasm.wasmPaths = new URL("model/runtime/", localRoot).href;
    }
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.proxy = false;

    // Explicit dtype + subfolder so load path is deterministic:
    // → model/onnx/model_uint8.onnx under localModelPath (aliased to verified model.onnx).
    const extractor = await pipeline("feature-extraction", TRANSFORMERS_MODEL_ID, {
      dtype: "uint8",
      device: "wasm",
      subfolder: "onnx",
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
        for (const u of blobUrls) URL.revokeObjectURL(u);
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
