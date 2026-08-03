/**
 * Build all browser entrypoints into dist-bundles/ for the product release.
 * Invoked under rules_bun with chdir = repo root.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const outDir = resolve("dist-bundles");
await mkdir(outDir, { recursive: true });

// Only ship bundles that appear in //:release (no unused element-only entry).
const entries = [
  ["src/index.ts", "agentos-search.mjs", "browser"],
  ["src/worker/main.ts", "agentos-search-runtime.mjs", "browser"],
  ["src/service-worker.ts", "agentos-search-sw.mjs", "browser"],
  ["src/embedding/mixedbread.ts", "agentos-search-embed.mjs", "browser"],
];

function run(cmd, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`));
    });
  });
}

// Prefer bun's node-compatible runner for the rolldown script.
const bun = process.execPath.includes("bun") ? process.execPath : "bun";

for (const [input, output, platform] of entries) {
  const outPath = resolve(outDir, output);
  await run(bun, ["tools/bundle.mjs", input, outPath, platform]);
  console.log("bundled", output);
}

await writeFile(resolve(outDir, ".ok"), "ok\n");
