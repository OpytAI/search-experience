/**
 * Build agentos-search.manifest.json with integrity digests for every shipped asset.
 * usage: manifest.mjs <output> <main> <worker> <runtime-worker> <embedder> <kernel> <image> <schema> [catalog]
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

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
] = process.argv.slice(2);

if (!schemaPath) {
  throw new Error(
    "usage: manifest.mjs <output> <main> <worker> <runtime-worker> <embedder> <kernel> <image> <schema> [catalog]",
  );
}

const inputs = [
  ["main", "agentos-search.mjs", mainPath],
  ["worker", "agentos-search-sw.mjs", workerPath],
  ["runtime", "agentos-search-runtime.mjs", runtimePath],
  ["embedder", "agentos-search-embed.mjs", embedderPath],
  ["kernel", "kernel.wasm", kernelPath],
  ["image", "atlas.tar", imagePath],
  ["schema", "index/schema.sql", schemaPath],
];

if (catalogPath) {
  inputs.push(["catalogCompiler", "catalog-compiler.wasm", catalogPath]);
}

const assets = {};
for (const [key, url, filePath] of inputs) {
  const bytes = await readFile(filePath);
  assets[key] = {
    url,
    bytes: bytes.byteLength,
    sha256: await sha256(bytes),
  };
}

const manifest = {
  schema: 1,
  protocol: 1,
  agentos: {
    tag: "v0.5.0",
    image: "atlas",
  },
  assets,
  collections: [],
  model: null,
};

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`);

