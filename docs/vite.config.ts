import { defineConfig } from "vite";
import { createRequire } from "node:module";
import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function pkg(name: string): string {
  // Prefer package root; some packages (e.g. lit) do not export package.json via "exports".
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    return dirname(require.resolve(name));
  }
}

/** HTML entries under docs/ (not public/) so Vite rewrites /src/* to hashed assets. */
function collectHtml(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "public") continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) out.push(...collectHtml(path));
    else if (name.endsWith(".html")) out.push(path);
  }
  return out;
}

const htmlInputs = Object.fromEntries(
  collectHtml(root).map((file) => {
    const rel = relative(root, file).replaceAll("\\", "/");
    // Stable rollup input names (paths as keys break on some platforms).
    const name = rel.replace(/\.html$/, "").replaceAll("/", "__") || "index";
    return [name, file];
  }),
);

export default defineConfig({
  root,
  publicDir: resolve(root, "public"),
  server: {
    host: "127.0.0.1",
    port: 5191,
    strictPort: true,
    fs: {
      allow: [resolve(root, "..")],
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: htmlInputs,
    },
  },
  resolve: {
    // Live rules_bun stages source via symlinks; keep resolution on the stage
    // tree (…/rules_bun_stage/docs/node_modules) instead of realpath'ing into
    // the checkout (which has no workspace node_modules).
    preserveSymlinks: true,
    // `vite dev` defaults to the "development" export condition. Lit (lit-html,
    // lit-element, @lit/reactive-element) then loads development/*.js and prints
    // "Lit is in dev mode". Prefer production entry points so the docs site
    // exercises mc-site-search the same way a release bundle does.
    conditions: ["production", "module", "browser", "import", "default"],
    // Resolve shared deps from docs node_modules when product sources live under ../src.
    alias: {
      lit: pkg("lit"),
      "@search": resolve(root, "../src"),
    },
    dedupe: ["lit"],
  },
  // Keep prebundled deps on the same conditions (Vite caches optimizeDeps separately).
  optimizeDeps: {
    esbuildOptions: {
      conditions: ["production", "module", "browser", "import", "default"],
    },
  },
});
