<div align="center">
  <h1>AgentOS site search</h1>

  <p><strong>Drop-in search for your site — no server needed.</strong></p>

  <p>
    Unpack next to your pages, add one script tag, and visitors get a command-palette
    search over <em>your</em> content. No separate backend. No third-party index.
  </p>

  <p>
    <a href="./LICENSE"><img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache%202.0-blue"></a>
    <img alt="Version 0.1.0" src="https://img.shields.io/badge/version-0.1.0-informational">
    <img alt="Runtime: Browser" src="https://img.shields.io/badge/runtime-Browser-654ff0">
    <a href="https://github.com/NarendraPatwardhan/agent-os"><img alt="Built on AgentOS" src="https://img.shields.io/badge/built%20on-AgentOS-f5c542"></a>
  </p>

  <p>
    <a href="#install-on-your-site">Install</a> ·
    <a href="#configuration">Configuration</a> ·
    <a href="#for-developers">Developers</a> ·
    <a href="#system-guide">System guide</a>
  </p>
</div>

---

## Install on your site

### 1. Get `release.tar`

From a CI artifact, or build from this repo:

```sh
bazel build //:release
# → bazel-bin/release.tar
```

### 2. Unpack into your static root

```sh
tar -xf release.tar -C <site-static-root>
```

That creates **`agentos-search/`** next to your public assets.

### 3. Load the entry script

```html
<script type="module" src="/agentos-search/agentos-search.mjs"></script>
```

On first load the script registers `<mc-site-search>`, boots the guest, crawls from configured **seeds** (default: `/`), and opens with **⌘K** / **Ctrl+K**. Check that shortcut after load.

Optional config **must run before** the module script:

```html
<script>
  globalThis.AgentOSSearch = {
    collections: [
      { id: "docs", label: "Documentation", seeds: ["/docs/"], includePathPrefixes: ["/docs/"] },
      { id: "blog", label: "Blog", seeds: ["/blog/"], includePathPrefixes: ["/blog/"] },
    ],
  };
</script>
<script type="module" src="/agentos-search/agentos-search.mjs"></script>
```

Unpack into the directory your stack serves at the site root: `public/` (Vite, Next, Nuxt, Astro), `static/` (Hugo, SvelteKit), document root (plain HTML / nginx), or your host’s static output root. Example: `tar -xf release.tar -C public`.

If the package is not at `/agentos-search/`, set both the script `src` and `assetBase` (see [Configuration](#configuration)). MIME types and CSP matter — see [Hosting](#hosting-mime-and-csp).

**Next.js (App Router)** — load once from the root layout with a real browser script (`next/script` or a normal `<script type="module">`):

```tsx
// app/layout.tsx
import Script from "next/script";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Script id="agentos-search-config" strategy="beforeInteractive">{`
          globalThis.AgentOSSearch = globalThis.AgentOSSearch || {};
        `}</Script>
        <Script
          type="module"
          src="/agentos-search/agentos-search.mjs"
          strategy="afterInteractive"
        />
      </body>
    </html>
  );
}
```

---

## What’s in the package

```text
agentos-search/
├── agentos-search.mjs              # page entry
├── agentos-search.manifest.json    # digests + layout
├── agentos-search-runtime.mjs      # module worker
├── agentos-search-sw.mjs           # asset cache only
├── agentos-search-embed.mjs
├── kernel.wasm
├── search-atlas.tar
├── mc-core.mjs
├── catalog-compiler.wasm
├── index/schema.sql
├── searchd/searchd.protocol.json
└── model/                          # ONNX + tokenizer + ORT runtime
```

One **compatibility unit** — replace the whole directory on upgrade; do not mix builds.

---

## Configuration

Set `globalThis.AgentOSSearch` **before** `agentos-search.mjs`.

| Option | Default | Meaning |
| --- | --- | --- |
| `collections` | one whole-site collection | What to crawl and how it appears |
| `autoMount` | `true` | Create `<mc-site-search>` if missing |
| `showLauncher` | `true` | Show the Search / ⌘K control |
| `assetBase` | entry script directory | Package asset root |
| `manifestUrl` | `…/agentos-search.manifest.json` | Override manifest URL |
| `refreshAfterMs` | none | Background re-crawl interval (clamped 1 min … 7 days when set) |

Default collection when `collections` is omitted: `id: "site"`, seeds `["/"]` on the page origin, label from document title or hostname.

**Collections today:** palette fields (`id`, `label`, `order`, `prefix`, `placeholder`, `minQueryLength`, `limit`) and **`seeds`** are live. Crawl is **same-origin only** (page origin). Path prefixes, `maxPages`, and sitemaps may be present in config but are **not enforced by guest searchd yet** — tighten seeds and the site graph until they are. Prefer explicit seeds; UI prefixes (`docs:`, `blog:`) still scope queries in the palette.

```html
<script>
  globalThis.AgentOSSearch = {
    collections: [
      { id: "docs", label: "Documentation", seeds: ["/docs/"], prefix: "docs:", order: 10 },
      { id: "blog", label: "Blog", seeds: ["/blog/"], prefix: "blog:", order: 20 },
    ],
    refreshAfterMs: 60 * 60 * 1000,
  };
</script>
<script type="module" src="/agentos-search/agentos-search.mjs"></script>
```

Place the control yourself with `autoMount: false` and a `<mc-site-search>` in the page (bootstrap fails if both are missing). Under a subpath:

```html
<script>
  globalThis.AgentOSSearch = { assetBase: "/assets/search/" };
</script>
<script type="module" src="/assets/search/agentos-search.mjs"></script>
```

### Events and theming

Events bubble/composed: `mc-search-query` (`{ query, mode }`), `mc-search-error` (`{ collectionId, error }`), and cancelable `mc-search-select` (`{ item, collection, query, method }` — `preventDefault()` for SPA routing).

```css
mc-site-search {
  --mc-search-fg: #0f172a;
  --mc-search-surface: #ffffff;
  --mc-search-focus: #4f46e5;
  --mc-search-border: #e2e8f0;
  --mc-search-width: 720px;
}
```

Other tokens: `--mc-search-fg-secondary`, `--mc-search-elevated`, `--mc-search-substrate`, `--mc-search-active-bg`, `--mc-search-active-fg`, `--mc-search-radius`, `--mc-search-max-height`, `--mc-search-backdrop`. Dark defaults follow `prefers-color-scheme`.

---

## How it works

```text
Page  →  agentos-search.mjs  →  module worker
                                    │
                    kernel + search-atlas + mc-core
                                    │
                         guest /svc/searchd  (serviceCall only)
                         crawl · FTS5/VANN · promote
                         host tools: fetch / extract / embed
                                    │
                    OPFS index  ·  palette UI (⌘K)
```

Search policy lives only in guest `searchd`. Durable index state is OPFS; the service worker (best-effort) caches distribution assets only. Same-origin crawl; replace the whole package on upgrade (snapshot may cold-boot if digests change).

Needs a modern browser with module scripts, module workers, Wasm, OPFS, and a secure context. Hosting is static files with correct MIME and a CSP that allows modules, workers, Wasm, and same-origin fetches. Not included: off-origin indexing, a production server-side crawler, or SEO sitemap generation (optional prewarm is separate — see developers).

---

## Hosting (MIME and CSP)

Serve `.mjs` as JavaScript (`text/javascript` or `application/javascript`), `.wasm` as `application/wasm`, and leave `.json` / `.tar` / `.onnx` as ordinary static types. nginx often needs an explicit map:

```nginx
types {
  text/javascript                       js mjs;
  application/wasm                      wasm;
  application/json                      json;
  application/octet-stream              onnx;
  application/x-tar                     tar;
  # …keep your other types…
}
```

If the site sends a CSP, the page that loads the entry script needs roughly:

```http
Content-Security-Policy:
  script-src 'self' 'wasm-unsafe-eval' blob:;
  worker-src 'self' blob:;
  connect-src 'self';
```

Prefer `'wasm-unsafe-eval'` over `'unsafe-eval'`. `blob:` is required because verified package JS is re-imported from blob URLs after digest checks. No third-party script/CDN origins. Cross-origin isolation is not required.

**Common failures:** package not under the published static root; script `src` / `assetBase` mismatch; `.mjs` served as `application/octet-stream`; CSP missing Wasm or `blob:`; empty results because seeds never crawled; unexpected pages because guest follows same-origin links from seeds (path prefixes not enforced yet).

---

# For developers

Standalone Bazel product. AgentOS is a **git-pinned module** (`bazel_dep` + `git_override` in root `MODULE.bazel`), not a monorepo sibling.

```sh
bazel run //tools/deps:update_lock   # after package.json changes
bazel test //:check                  # typecheck + unit smoke
bazel run //demo:dev                 # http://127.0.0.1:5191
bazel build //:release               # bazel-bin/release.tar
```

Bazel’s user root lives under **`./bazel-cache`** (see `.bazelrc`; gitignored). Run from the workspace root.

```text
search-experience/
├── MODULE.bazel / BUILD.bazel
├── src/           # host, worker, UI, protocol, host-tools, embedding
├── guest/searchd/ # Rust /svc/searchd
├── guest/image/   # search-atlas
├── index/schema.sql
├── demo/  test/  tools/
└── third_party/agent-os/
```

### AgentOS pin

Kernel, mc-core, catalog-compiler, base image, sqlite guest, and `mc_program.bzl` all come from **`@agent-os//…` labels built from the pin** — not GitHub-release `http_file`s. Root re-hosts `hermetic_cc` so `@zig_sdk` exists when AgentOS is nested. Patches under `third_party/agent-os/` strip Elixir/server, fix nested tree-sitter loads, fix Luau include paths, and cap the sqlite Wasm stack at 1 MiB.

Bump: change `commit` in `git_override`, re-check patches, `bazel test //:check && bazel build //:release`. Snapshot compatibility keys will churn (visitors cold-boot).

### Guest image and authority

`//guest/image:search_atlas` layers AgentOS **base** + product sqlite + eager `/svc/searchd` + `/var/searchd`. Not stock atlas/loom/Luau — production path is **serviceCall-only** searchd. Searchd does not shell out to coreutils, so base (not posix) is enough.

| Who | Owns |
| --- | --- |
| `/svc/searchd` | Crawl plan, FTS5/VANN, fusion, promote |
| Host tools | Same-origin fetch, extract, embed (`host.org.main.search.*`) |
| Runtime worker | Boot/restore, tools, OPFS |
| `<mc-site-search>` | Palette UI |
| Service worker | Dist asset cache only |

Queries always use `/var/searchd/index.db`. Cold index writes `index.db`; refresh rebuilds `candidate.db` then promote (non-empty pages **and** chunks) copies candidate → index.

### Local demo, E2E, prewarm

UI fixtures only: `bazel run //demo:dev`. Full product path:

```sh
bazel build //:release
tar -xf bazel-bin/release.tar -C demo/public
bazel run //demo:dev
```

Browser acceptance (system Chromium):

```sh
bun tools/browser-e2e.mjs \
  --release-dir=demo/public/agentos-search \
  --export-snapshot \
  --out=./warm
```

Publisher: `bun src/publisher/cli.ts --origin=… --out=./warm` (plan) or `--capture --release-dir=…` (real gzip MCSN). Inject into a release tree:

```sh
bun tools/package-prewarm.mjs \
  --release-dir=demo/public/agentos-search \
  --snapshot=./warm/search.snapshot \
  --metadata=./warm/search.snapshot.metadata.json
```

Snapshots are **gzip-only** (`meta.encoding: "gzip"`; `snapshotSha256` digests the gzip bytes). `//:release` does not embed a site-specific snapshot by default.

---

# System guide

Protocol versions stay separate (`src/protocol/versions.ts`): page↔worker, host↔searchd, manifest (`transport: "serviceCall"`), OPFS snapshot format. OPFS keys hash kernel/image/schema/model/protocol plus collections and page origin — any change invalidates warm restore.

Security: http(s) fetch only, `credentials: "omit"`, origin allowlist, redirect final origin checked, body/timeout caps, result navigation sanitized to same-origin http(s).

Keep `searchd.protocol.json`, `src/protocol/searchd.ts`, and `guest/searchd/src/main.rs` aligned. Do not reintroduce Luau production transport, prebuilt AgentOS asset pins as the default path, or host-side ranking as production authority (TS FTS/RRF helpers are test oracles only).

### Contributing

1. `bazel run //tools/deps:update_lock` after `package.json` changes.  
2. Gate: `bazel test //:check`.  
3. Guest/protocol/schema changes → rebuild searchd + search-atlas; expect snapshot key churn.  
4. AgentOS bumps → re-verify patches + root `hermetic_cc`.  
5. Packaging smoke: build release, unpack into `demo/public`, `bazel run //demo:dev`.
