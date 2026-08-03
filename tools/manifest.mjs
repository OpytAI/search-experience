/**
 * Build agentos-search.manifest.json with integrity digests for every shipped asset.
 *
 * usage: manifest.mjs <output> <main> <worker> <runtime> <embedder> <kernel> <image> <schema>
 *        [catalog] [searchd-protocol] [unused-guest-slot] [mc-core]
 *        [--model model.onnx tokenizer.json tokenizer_config.json config.json ort.mjs ort.wasm]
 *
 * Production transport is serviceCall only (stamped /svc/searchd in search-atlas).
 * The unused-guest-slot positional is accepted as "NONE" for BUILD compatibility.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function asset(url, filePath) {
  const bytes = await readFile(filePath);
  return {
    url,
    bytes: bytes.byteLength,
    sha256: await sha256(bytes),
  };
}

const argv = process.argv.slice(2);
const modelFlag = argv.indexOf("--model");
const modelPaths = modelFlag >= 0 ? argv.slice(modelFlag + 1) : [];
const positional = modelFlag >= 0 ? argv.slice(0, modelFlag) : argv;

const [
  output,
  mainPath,
  workerPath,
  runtimePath,
  embedderPath,
  kernelPath,
  imagePath,
  schemaPath,
  catalogPath,
  searchdProtocolPath,
  _searchdGuestPath,
  mcCorePath,
] = positional;

if (!schemaPath) {
  throw new Error(
    "usage: manifest.mjs <output> <main> <worker> <runtime> <embedder> <kernel> <image> <schema> [catalog] [searchd-protocol] [NONE] [mc-core] [--model ...]",
  );
}

const imageName = "search-atlas";
const imageUrl = "search-atlas.tar";

const assets = {
  main: await asset("agentos-search.mjs", mainPath),
  worker: await asset("agentos-search-sw.mjs", workerPath),
  runtime: await asset("agentos-search-runtime.mjs", runtimePath),
  embedder: await asset("agentos-search-embed.mjs", embedderPath),
  kernel: await asset("kernel.wasm", kernelPath),
  image: await asset(imageUrl, imagePath),
  schema: await asset("index/schema.sql", schemaPath),
};

if (catalogPath && catalogPath !== "NONE") {
  assets.catalogCompiler = await asset("catalog-compiler.wasm", catalogPath);
}
if (searchdProtocolPath && searchdProtocolPath !== "NONE") {
  assets.searchdProtocol = await asset("searchd/searchd.protocol.json", searchdProtocolPath);
}
// Guest authority is stamped /svc/searchd (serviceCall); no alternate guest source asset.
if (mcCorePath && mcCorePath !== "NONE") {
  assets.mcCore = await asset("mc-core.mjs", mcCorePath);
}

let model = null;
if (modelPaths.length >= 6) {
  const [onnx, tokenizer, tokenizerConfig, config, ortMjs, ortWasm] = modelPaths;
  const modelAssets = {
    model: await asset("model/model.onnx", onnx),
    tokenizer: await asset("model/tokenizer.json", tokenizer),
    tokenizerConfig: await asset("model/tokenizer_config.json", tokenizerConfig),
    config: await asset("model/config.json", config),
    runtimeModule: await asset("model/runtime/ort-wasm-simd-threaded.jsep.mjs", ortMjs),
    runtimeWasm: await asset("model/runtime/ort-wasm-simd-threaded.jsep.wasm", ortWasm),
  };
  const fingerprintMaterial = [
    modelAssets.model.sha256,
    modelAssets.tokenizer.sha256,
    modelAssets.config.sha256,
    "uint8",
    "384",
  ].join(":");
  const fingerprint = await sha256(new TextEncoder().encode(fingerprintMaterial));
  model = {
    id: "mixedbread-ai/mxbai-embed-xsmall-v1",
    revision: "e6ac24e5d6efb8782b59de1647b3ececb4ece94e",
    quantization: "uint8",
    dtype: "uint8",
    dimensions: 384,
    maxLength: 512,
    pooling: "mean",
    normalize: true,
    documentTemplate: "title-heading-body-v1",
    queryTemplate: "normalized-query-v1",
    fingerprint,
    assets: modelAssets,
  };
}

const manifest = {
  schema: 1,
  protocol: 1,
  version: "0.1.0",
  agentos: {
    // Informational only — kernel/image digests in assets are the real compatibility key.
    tag: "source",
    image: imageName,
  },
  service: {
    name: "searchd",
    protocol: 1,
    transport: "serviceCall",
  },
  assets,
  sqlite: {
    requiredFeatures: ["FTS5", "VANN"],
    indexPath: "/var/searchd/index.db",
  },
  collections: [],
  model,
  snapshot: {
    format: 1,
  },
};

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`);
