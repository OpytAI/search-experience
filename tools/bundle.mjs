/**
 * Production multi-entry bundler for the copy-and-import search product.
 * usage: bundle.mjs <input> <output> [browser|node]
 */
import { rolldown } from "rolldown";
import { createRequire } from "node:module";

const [input, output, platform = "browser"] = process.argv.slice(2);
if (!input || !output || !["browser", "node"].includes(platform)) {
  throw new Error("usage: bundle.mjs <input> <output> [browser|node]");
}

const NODE_BUILTINS =
  /^(assert|buffer|child_process|crypto|events|fs|fs\/promises|http|https|module|net|os|path|process|stream|tls|url|util|zlib)$/;
const isExternal = (id) => id.startsWith("node:") || NODE_BUILTINS.test(id);
const require = createRequire(import.meta.url);

const BROWSER_NODE_EXPORTS = {
  fs: ["mkdirSync", "readFileSync", "writeFileSync", "existsSync", "statSync", "rmSync"],
  "fs/promises": ["access", "cp", "lstat", "mkdir", "mkdtemp", "readFile", "readdir", "readlink", "realpath", "rm", "stat", "writeFile"],
  path: ["basename", "delimiter", "dirname", "extname", "isAbsolute", "join", "normalize", "relative", "resolve", "sep"],
  os: ["arch", "homedir", "platform", "tmpdir"],
  child_process: ["execFile", "spawn", "spawnSync"],
  module: ["createRequire"],
  url: ["fileURLToPath", "pathToFileURL"],
  process: ["cwd", "env", "platform", "arch", "stdout", "stderr"],
  buffer: ["Buffer"],
  crypto: ["createHash", "randomBytes"],
};

function browserNodeShim(id) {
  const canonical = id.replace(/^node:/, "");
  const names = BROWSER_NODE_EXPORTS[canonical] ?? [];
  const exports = names.map((name) => (
    ["env", "platform", "arch", "stdout", "stderr", "sep", "delimiter", "Buffer"].includes(name)
      ? `export const ${name} = undefined;`
      : `export const ${name} = () => { throw new Error(${JSON.stringify(`Node builtin ${canonical}.${name} is unavailable in the browser`)}); };`
  ));
  return `${exports.join("\n")}\nexport default Object.freeze({});\n`;
}

function resolveTransformersWeb() {
  // Force the browser build so we never ship transformers.node.* into product.
  const candidates = [
    "@huggingface/transformers/dist/transformers.web.js",
    "@huggingface/transformers/dist/transformers.web.min.js",
  ];
  for (const c of candidates) {
    try {
      return require.resolve(c);
    } catch {
      /* try next */
    }
  }
  try {
    const pkg = require.resolve("@huggingface/transformers/package.json");
    const { dirname, join } = require("node:path");
    return join(dirname(pkg), "dist", "transformers.web.js");
  } catch {
    return null;
  }
}

const isEmbedEntry = input.endsWith("mixedbread.ts") || input.endsWith("embedding.ts") || output.endsWith("agentos-search-embed.mjs");

const bundle = await rolldown({
  input,
  platform,
  // Never externalize transformers for browser product bundles — must be hermetic.
  external: platform === "node" ? isExternal : undefined,
  plugins: [{
    name: "search-resolve",
    resolveId(id) {
      if (platform === "browser" && isExternal(id)) {
        return `\0search-browser-node-shim:${id.replace(/^node:/, "")}`;
      }
      if (id === "onnxruntime-common" || id === "onnxruntime-web") {
        try {
          return require.resolve(id);
        } catch {
          return null;
        }
      }
      if (id === "@huggingface/transformers" || id.startsWith("@huggingface/transformers/")) {
        const web = resolveTransformersWeb();
        if (web) return web;
      }
      // Prefer vendored mc-core.mjs when present in the package stage.
      if (id === "@mc/core" || id === "mc-core" || id.endsWith("/mc-core.mjs")) {
        return null;
      }
      return null;
    },
    load(id) {
      const prefix = "\0search-browser-node-shim:";
      if (id.startsWith(prefix)) {
        return { code: browserNodeShim(id.slice(prefix.length)), moduleSideEffects: false };
      }
      return null;
    },
  }],
});

await bundle.write({
  file: output,
  format: "es",
  codeSplitting: false,
});
await bundle.close();

// Guard: product browser bundles must not leave bare npm imports for transformers.
// Doc comments inside inlined transformers.web.js mention the package name — strip comments first.
if (platform === "browser") {
  const { readFile } = await import("node:fs/promises");
  const code = await readFile(output, "utf8");
  const stripped = code
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
  const liveImport =
    /import\s*\(\s*["']@huggingface\/transformers["']\s*\)/.test(stripped) ||
    /from\s+["']@huggingface\/transformers["']/.test(stripped) ||
    /import\s+[^;]*["']@huggingface\/transformers["']/.test(stripped);
  if (liveImport) {
    throw new Error(
      `${output}: hermetic check failed — live @huggingface/transformers import remains. ` +
        `Bundle transformers into the artifact (especially agentos-search-embed.mjs).`,
    );
  }
  if (isEmbedEntry && code.length < 100_000) {
    throw new Error(`${output}: embed bundle too small (${code.length} B); transformers likely not inlined`);
  }
}
