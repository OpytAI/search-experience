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

const bundle = await rolldown({
  input,
  platform,
  external: platform === "node" ? isExternal : undefined,
  plugins: [{
    name: "search-resolve",
    resolveId(id) {
      if (platform === "browser" && isExternal(id)) {
        return `\0search-browser-node-shim:${id.replace(/^node:/, "")}`;
      }
      if (id === "onnxruntime-common") {
        try {
          return require.resolve(id);
        } catch {
          return null;
        }
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
