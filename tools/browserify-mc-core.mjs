/**
 * Produce a browser-loadable mc-core.mjs from the AgentOS sdk-js/core bundle.
 *
 * AgentOS leaves node: builtins external (server-only loaders). The browser never
 * executes those paths on the VM boot flow, but raw ESM import still fails to
 * resolve node:fs etc. This pure transform rewrites those imports to inert stubs
 * so the product can import mc-core via integrity-checked blob URL.
 *
 * No bundler required — safe to run in a Bazel genrule with only Bun.
 *
 * usage: browserify-mc-core.mjs <input-mc-core.mjs> <output-mc-core.mjs>
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  throw new Error("usage: browserify-mc-core.mjs <input> <output>");
}

const PREAMBLE = `/* browserify-mc-core: node builtin stubs (server-only paths must not run) */
const __nodeStubHandler = {
  get(_t, prop) {
    if (prop === "__esModule") return true;
    if (prop === "default") return __nodeStub;
    if (prop === "then") return undefined;
    if (typeof prop === "symbol") return undefined;
    if (prop === "sep") return "/";
    if (prop === "delimiter") return ":";
    if (prop === "platform") return "browser";
    if (prop === "arch") return "wasm32";
    if (prop === "env") return {};
    if (prop === "Browser") return undefined;
    if (prop === "constants") return {};
    return (..._args) => {
      throw new Error("Node builtin " + String(prop) + " is unavailable in the browser AgentOS host");
    };
  },
  apply() {
    throw new Error("Node builtin is unavailable in the browser AgentOS host");
  },
};
const __nodeStub = new Proxy(function(){}, __nodeStubHandler);
const __nodeJoin = (...parts) => parts.filter((p) => p !== undefined && p !== null && p !== "").join("/").replace(/\\\\/g, "/").replace(/\\/+/g, "/");
const __nodePathStub = new Proxy({
  join: __nodeJoin,
  resolve: __nodeJoin,
  dirname: (p) => { const s = String(p); const i = s.lastIndexOf("/"); return i <= 0 ? "." : s.slice(0, i); },
  basename: (p, ext) => { let s = String(p); const i = s.lastIndexOf("/"); s = i < 0 ? s : s.slice(i + 1); if (ext && s.endsWith(ext)) s = s.slice(0, -ext.length); return s; },
  extname: (p) => { const s = String(p); const i = s.lastIndexOf("."); const j = s.lastIndexOf("/"); return i > j ? s.slice(i) : ""; },
  normalize: (p) => String(p).replace(/\\\\/g, "/"),
  relative: (_f, t) => String(t),
  isAbsolute: (p) => String(p).startsWith("/"),
  sep: "/",
  delimiter: ":",
}, __nodeStubHandler);
const __nodeOsStub = new Proxy({
  tmpdir: () => "/tmp",
  homedir: () => "/",
  platform: () => "browser",
  arch: () => "wasm32",
  cpus: () => [],
}, __nodeStubHandler);
`;

function rewriteNodeImports(source) {
  let out = source;

  // import "node:fs";
  out = out.replace(/^import\s+["']node:[^"']+["'];?\s*$/gm, "/* node side-effect import stubbed */");

  // import defaultExport from "node:..."
  out = out.replace(
    /^import\s+([A-Za-z_$][\w$]*)\s+from\s+["']node:([^"']+)["'];?\s*$/gm,
    (_m, name, mod) => {
      if (mod === "path" || mod.startsWith("path/")) return `const ${name} = __nodePathStub;`;
      if (mod === "os" || mod.startsWith("os/")) return `const ${name} = __nodeOsStub;`;
      return `const ${name} = __nodeStub;`;
    },
  );

  // import * as ns from "node:..."
  out = out.replace(
    /^import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+["']node:([^"']+)["'];?\s*$/gm,
    (_m, name, mod) => {
      if (mod === "path" || mod.startsWith("path/")) return `const ${name} = __nodePathStub;`;
      if (mod === "os" || mod.startsWith("os/")) return `const ${name} = __nodeOsStub;`;
      return `const ${name} = __nodeStub;`;
    },
  );

  // import { a, b as c } from "node:..."
  out = out.replace(
    /^import\s+\{([^}]+)\}\s+from\s+["']node:([^"']+)["'];?\s*$/gm,
    (_m, names, mod) => {
      const stub =
        mod === "path" || mod.startsWith("path/")
          ? "__nodePathStub"
          : mod === "os" || mod.startsWith("os/")
            ? "__nodeOsStub"
            : "__nodeStub";
      const parts = names.split(",").map((s) => s.trim()).filter(Boolean);
      return parts
        .map((p) => {
          const [orig, alias] = p.split(/\s+as\s+/).map((x) => x.trim());
          const id = alias || orig;
          // Prefer named props on path/os stubs when present.
          return `const ${id} = ${stub}.${orig} ?? ${stub};`;
        })
        .join("\n");
    },
  );

  // Bare builtin without node: prefix (rare but allowed by AgentOS external list)
  const bare =
    /^(assert|buffer|child_process|crypto|events|fs|fs\/promises|http|https|module|net|os|path|process|stream|tls|url|util|zlib)$/;
  out = out.replace(
    /^import\s+(\w+)\s+from\s+["']([^"']+)["'];?\s*$/gm,
    (m, name, mod) => (bare.test(mod) ? `const ${name} = __nodeStub;` : m),
  );
  out = out.replace(
    /^import\s+\*\s+as\s+(\w+)\s+from\s+["']([^"']+)["'];?\s*$/gm,
    (m, name, mod) => (bare.test(mod) ? `const ${name} = __nodeStub;` : m),
  );
  out = out.replace(
    /^import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["'];?\s*$/gm,
    (m, names, mod) => {
      if (!bare.test(mod)) return m;
      const parts = names.split(",").map((s) => s.trim()).filter(Boolean);
      return parts
        .map((p) => {
          const [orig, alias] = p.split(/\s+as\s+/).map((x) => x.trim());
          const id = alias || orig;
          return `const ${id} = __nodeStub.${orig} ?? __nodeStub;`;
        })
        .join("\n");
    },
  );

  return PREAMBLE + "\n" + out;
}

const inPath = resolve(input);
const outPath = resolve(output);
const source = await readFile(inPath, "utf8");
const rewritten = rewriteNodeImports(source);

const residual = rewritten.match(/^import\s+.+from\s+["']node:[^"']+["']/gm);
if (residual?.length) {
  throw new Error(
    `browserify-mc-core: residual node: imports:\n${residual.slice(0, 15).join("\n")}`,
  );
}

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, rewritten);
console.log(`browserify-mc-core: wrote ${outPath} (${rewritten.length} bytes)`);
