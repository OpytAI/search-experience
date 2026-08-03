import { defineConfig } from "vite";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function pkg(name: string): string {
  return dirname(require.resolve(`${name}/package.json`));
}

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
  },
  resolve: {
    // Resolve shared deps from demo node_modules when product sources live under ../src.
    alias: {
      lit: pkg("lit"),
      "@search": resolve(root, "../src"),
    },
    dedupe: ["lit"],
  },
});
