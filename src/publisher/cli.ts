/**
 * Optional publisher host — same searchd protocol and host-tool contracts.
 * Drive configure/crawl/embed/checkpoint and emit a warm snapshot.
 *
 * Usage (after product packaging):
 *   bun src/publisher/cli.ts --origin=https://example.com --out=./warm
 *
 * Reserved for optional acceleration; visitors never require it.
 * Importing this module is safe; only the CLI entry throws when incomplete.
 */

export interface PublisherOptions {
  origin: string;
  outDir: string;
  collections?: unknown[];
}

export interface PublisherResult {
  ok: false;
  code: "not_implemented";
  message: string;
  protocol: "searchd";
  protocolVersion: 1;
}

/**
 * Same-protocol stub: returns a structured not-implemented result without
 * throwing so library importers can feature-detect cleanly.
 */
export async function publishWarmSnapshot(options: PublisherOptions): Promise<PublisherResult> {
  if (!options.origin) {
    return {
      ok: false,
      code: "not_implemented",
      message: "origin is required",
      protocol: "searchd",
      protocolVersion: 1,
    };
  }
  return {
    ok: false,
    code: "not_implemented",
    message:
      "publisher reserved: wire Node/Bun host tools + searchd transport (same protocol as the runtime worker) to emit a warm snapshot under outDir",
    protocol: "searchd",
    protocolVersion: 1,
  };
}

function isCliEntry(): boolean {
  if (typeof process === "undefined" || !process.argv?.[1]) return false;
  const entry = process.argv[1].replace(/\\/g, "/");
  return entry.endsWith("/publisher/cli.ts") || entry.endsWith("/publisher/cli.js") || entry.endsWith("cli.ts");
}

if (isCliEntry()) {
  const origin = process.argv.find((a) => a.startsWith("--origin="))?.slice(9);
  const outDir = process.argv.find((a) => a.startsWith("--out="))?.slice(6) ?? "./warm";
  if (!origin) {
    console.error("usage: publisher --origin=https://site.example --out=./warm");
    process.exit(2);
  }
  void publishWarmSnapshot({ origin, outDir }).then((result) => {
    console.error(result.message);
    process.exit(result.ok ? 0 : 1);
  });
}
