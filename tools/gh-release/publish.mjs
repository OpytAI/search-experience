// publish.mjs — cut a GitHub release over the REST API (no `gh` CLI).
//
// Port of agent-os //bazel/tools/gh-release:publish, adapted for this product's
// rules_bun runfiles layout. Graph assets ride in as runfiles; the Starlark rule
// hands the tool a name→path map via MC_RELEASE_ASSETS.
//
// GitHub flow:
//   GET  api.github.com/repos/{repo}/releases/tags/{tag}
//   POST api.github.com/repos/{repo}/releases
//   POST uploads.github.com/.../releases/{id}/assets?name=<file>
// Re-runs are idempotent: existing releases are reused (notes synced, same-named
// assets replaced via delete-then-upload).
//
// Always uploads a generated SHA256SUMS over the exact asset bytes.
// Notes are mandatory (--notes / --notes-file); never auto-generated.
//
// Env from the gh_release rule:
//   MC_RELEASE_REPO    "owner/repo"
//   MC_RELEASE_ASSETS  JSON {assetName: rlocation-or-absolute-path}
// Auth: GITHUB_TOKEN (or GH_TOKEN), or --token-file. Not needed for --dry-run.

import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";

const API = "https://api.github.com";
const UA = "search-experience-release";
const API_VERSION = "2022-11-28";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function die(msg) {
  console.error(`publish: ${msg}`);
  process.exit(1);
}

function printHelp() {
  console.error(`usage: bazel run //tools/gh-release:publish -- --tag <tag> (--notes <t> | --notes-file <p>) [options]

  --tag <tag>          (required) git tag for the release, e.g. v0.1.0
  --notes <text>       (required, or --notes-file) release body text
  --notes-file <path>  (required, or --notes) release body read from a file
  --name <name>        release title (default: the tag)
  --target <commitish> commit/branch the tag points at (default: GitHub repo default branch)
  --draft              create as a draft (not published)
  --prerelease         mark as a pre-release
  --repo <owner/repo>  override MC_RELEASE_REPO
  --token-file <path>  read the token from a file instead of GITHUB_TOKEN
  --dry-run            resolve + validate assets/notes and exit; make no GitHub calls
  -h, --help           this message

Notes are mandatory — GitHub auto-generated release notes are never used.`);
}

function parseArgs(argv) {
  const opts = { draft: false, prerelease: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) die(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case "--tag":
        opts.tag = val();
        break;
      case "--name":
        opts.name = val();
        break;
      case "--target":
        opts.target = val();
        break;
      case "--notes":
        opts.notes = val();
        break;
      case "--notes-file":
        opts.notesFile = val();
        break;
      case "--draft":
        opts.draft = true;
        break;
      case "--prerelease":
        opts.prerelease = true;
        break;
      case "--repo":
        opts.repo = val();
        break;
      case "--token-file":
        opts.tokenFile = val();
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
      default:
        die(`unknown argument ${JSON.stringify(a)} (try --help)`);
    }
  }
  if (!opts.tag) die("missing required --tag <tag> (try --help)");
  return opts;
}

function resolveNotes(opts) {
  let body;
  if (opts.notes !== undefined) {
    body = opts.notes;
  } else if (opts.notesFile !== undefined) {
    try {
      body = readFileSync(opts.notesFile, "utf8");
    } catch (e) {
      die(`--notes-file ${opts.notesFile}: ${e.message}`);
    }
  } else {
    die(
      "release notes are required: pass --notes <text> or --notes-file <path> (notes are never auto-generated)",
    );
  }
  if (body.trim() === "") {
    die("release notes are empty — provide real notes (notes are never auto-generated)");
  }
  return body;
}

function runfilesDir() {
  return process.env.RUNFILES_DIR ?? process.env.JS_BINARY__RUNFILES ?? null;
}

/** Resolve a path under the Bazel runfiles tree (main-repo + external layouts). */
function resolveRunfile(rel) {
  if (isAbsolute(rel)) return rel;
  const rf = runfilesDir();
  if (!rf) die(`RUNFILES_DIR unset; cannot resolve asset path ${rel}`);
  const candidates = [
    join(rf, rel),
    join(rf, "_main", rel),
    join(rf, "search-experience", rel),
  ];
  for (const path of candidates) {
    try {
      statSync(path);
      return path;
    } catch {
      /* try next */
    }
  }
  die(`asset not found for ${rel} (tried under ${rf})`);
}

function resolveAssets() {
  const raw = process.env.MC_RELEASE_ASSETS;
  if (!raw) {
    die(
      "MC_RELEASE_ASSETS not set — run via `bazel run //tools/gh-release:publish`, not bun/node directly",
    );
  }
  const map = JSON.parse(raw);
  const assets = [];
  for (const [name, rel] of Object.entries(map)) {
    const path = resolveRunfile(rel);
    let size;
    try {
      size = statSync(path).size;
    } catch {
      die(`asset ${name} not found at ${path} (rlocationpath ${rel})`);
    }
    assets.push({ name, path, size });
  }
  if (assets.length === 0) die("no assets to publish");
  return assets;
}

function sha256SumsAsset(assets) {
  const lines = assets
    .slice()
    .sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
    .map((a) => `${createHash("sha256").update(readFileSync(a.path)).digest("hex")}  ${a.name}`);
  const bytes = Buffer.from(lines.join("\n") + "\n", "utf8");
  return { name: "SHA256SUMS", bytes, size: bytes.length };
}

function readToken(opts) {
  if (opts.tokenFile) return readFileSync(opts.tokenFile, "utf8").trim();
  const t = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!t) die("no token: set GITHUB_TOKEN (or GH_TOKEN), or pass --token-file <path>");
  return t.trim();
}

async function ghFetch(
  url,
  { method = "GET", token, body, contentType, accept = "application/vnd.github+json" } = {},
) {
  const headers = { Accept: accept, "User-Agent": UA, "X-GitHub-Api-Version": API_VERSION };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (contentType) headers["Content-Type"] = contentType;
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { method, headers, body });
      if (res.status < 500) return res;
      lastErr = new Error(`${method} ${url} -> ${res.status} ${res.statusText}`);
    } catch (e) {
      lastErr = e;
    }
    if (attempt < 4) await sleep(500 * 2 ** (attempt - 1));
  }
  throw lastErr;
}

async function errBody(res, ctx) {
  let detail = "";
  try {
    detail = JSON.stringify(await res.json());
  } catch {
    /* non-JSON error body */
  }
  return `${ctx}: ${res.status} ${res.statusText} ${detail}`;
}

async function findRelease(repo, tag, token) {
  const res = await ghFetch(`${API}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, {
    token,
  });
  if (res.status === 404) return null;
  if (!res.ok) die(await errBody(res, `look up release ${tag}`));
  return res.json();
}

async function createRelease(repo, opts, body, token) {
  const payload = {
    tag_name: opts.tag,
    name: opts.name ?? opts.tag,
    body,
    draft: opts.draft,
    prerelease: opts.prerelease,
  };
  if (opts.target) payload.target_commitish = opts.target;

  const res = await ghFetch(`${API}/repos/${repo}/releases`, {
    method: "POST",
    token,
    contentType: "application/json",
    body: JSON.stringify(payload),
  });
  if (!res.ok) die(await errBody(res, `create release ${opts.tag}`));
  return res.json();
}

async function updateReleaseBody(repo, releaseId, body, token) {
  const res = await ghFetch(`${API}/repos/${repo}/releases/${releaseId}`, {
    method: "PATCH",
    token,
    contentType: "application/json",
    body: JSON.stringify({ body }),
  });
  if (!res.ok) die(await errBody(res, `update release notes`));
  return res.json();
}

async function deleteAsset(repo, assetId, token) {
  const res = await ghFetch(`${API}/repos/${repo}/releases/assets/${assetId}`, {
    method: "DELETE",
    token,
  });
  if (!res.ok && res.status !== 404) die(await errBody(res, `delete stale asset ${assetId}`));
}

async function uploadAsset(uploadUrlTemplate, asset, token) {
  const base = uploadUrlTemplate.split("{")[0];
  const url = `${base}?name=${encodeURIComponent(asset.name)}`;
  const body = asset.bytes ?? readFileSync(asset.path);
  const res = await ghFetch(url, {
    method: "POST",
    token,
    contentType: "application/octet-stream",
    body,
  });
  if (!res.ok) die(await errBody(res, `upload ${asset.name}`));
  return res.json();
}

function human(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 ** 2).toFixed(2)} MiB`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const repo = opts.repo ?? process.env.MC_RELEASE_REPO;
  if (!repo) {
    die("no repo: set MC_RELEASE_REPO (via the gh_release rule) or pass --repo owner/repo");
  }
  const notes = resolveNotes(opts);
  const assets = resolveAssets();
  const sums = sha256SumsAsset(assets);
  const uploads = [...assets, sums];

  console.error(`release: ${repo} @ ${opts.tag}  (${assets.length} assets + SHA256SUMS)`);
  for (const a of uploads) console.error(`  • ${a.name.padEnd(16)} ${human(a.size).padStart(10)}`);

  if (opts.dryRun) {
    console.error(`\n--- SHA256SUMS ---\n${sums.bytes.toString("utf8").trimEnd()}`);
    console.error(
      `\n--dry-run: ${assets.length} assets + SHA256SUMS resolved; notes present (${notes.trim().length} chars); no GitHub calls made.`,
    );
    console.error(`would create release ${opts.tag}${opts.draft ? " (draft)" : ""} on ${repo}.`);
    return;
  }

  const token = readToken(opts);
  let release = await findRelease(repo, opts.tag, token);
  if (release) {
    console.error(
      `\nrelease ${opts.tag} exists (#${release.id}) — reusing; syncing notes, replacing same-named assets`,
    );
    await updateReleaseBody(repo, release.id, notes, token);
  } else {
    release = await createRelease(repo, opts, notes, token);
    console.error(`\ncreated release ${opts.tag} (#${release.id})`);
  }

  const existing = new Map((release.assets ?? []).map((a) => [a.name, a.id]));
  for (const a of uploads) {
    if (existing.has(a.name)) {
      await deleteAsset(repo, existing.get(a.name), token);
    }
    const up = await uploadAsset(release.upload_url, a, token);
    console.error(
      `  uploaded ${a.name.padEnd(16)} ${human(a.size).padStart(10)}  ${up.browser_download_url}`,
    );
  }

  console.error(`\n✓ ${release.html_url}`);
}

main().catch((e) => die(e?.stack || String(e)));
