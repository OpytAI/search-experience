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
    <a href="#how-it-works">How it works</a> ·
    <a href="#hosting-mime-and-csp">Hosting</a> ·
    <a href="#for-developers">Developers</a> ·
    <a href="#system-guide">System guide</a>
  </p>
</div>

---

## Install on your site

### 1. Get `release.tar`

Build from this repo, or take a CI artifact:

```sh
bazel build //:release
# → bazel-bin/release.tar
```

### 2. Unpack into your static root

```sh
tar -xf release.tar -C <site-static-root>
```

That creates an `agentos-search/` directory next to your other public assets. Use the folder your stack already serves at the site root: `public/` for Vite, Next.js, Nuxt, and Astro; `static/` for Hugo and SvelteKit; the document root for plain HTML or nginx; or whatever your host treats as the published static root.

### 3. Load the entry script

```html
<script type="module" src="/agentos-search/agentos-search.mjs"></script>
```

On load the package registers `<mc-site-search>`, boots the guest, crawls from the default seeds, and opens with **⌘K** / **Ctrl+K**. Check that shortcut after the page is up.

That is the whole default install. Collections, launcher placement, and asset paths live under [Configuration](#configuration). If you serve the package from somewhere other than `/agentos-search/`, set both the script `src` and `assetBase` there. Static hosting notes (MIME types and CSP) are under [Hosting](#hosting-mime-and-csp).

**Next.js (App Router).** Load the module once from the root layout with a real browser script (`next/script` or a normal `<script type="module">`), not a self-closing tag that never executes in the browser:

```tsx
// app/layout.tsx
import Script from "next/script";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
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

Any `globalThis.AgentOSSearch` setup must run **before** that module (for example a second `Script` with `strategy="beforeInteractive"`). See [Configuration](#configuration).

---

## What’s in the package

```text
agentos-search/
├── agentos-search.mjs              # page entry
├── agentos-search.manifest.json    # digests + layout
├── agentos-search-runtime.mjs      # module worker
├── agentos-search-sw.mjs           # distribution asset cache only
├── agentos-search-embed.mjs
├── kernel.wasm
├── search-atlas.tar
├── mc-core.mjs
├── catalog-compiler.wasm
├── index/schema.sql
├── searchd/searchd.protocol.json
└── model/                          # ONNX weights, tokenizer, ORT runtime
```

Treat the directory as one **compatibility unit**. Replace the whole tree when you upgrade; do not mix files from different builds.

---

## Configuration

Everything optional goes through `globalThis.AgentOSSearch`, set **before** `agentos-search.mjs` loads.

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

| Option | Default | Meaning |
| --- | --- | --- |
| `collections` | one whole-site collection | What to crawl and how it appears in the palette |
| `autoMount` | `true` | Create `<mc-site-search>` if the page has none |
| `showLauncher` | `true` | Show the Search / ⌘K control |
| `assetBase` | directory of the entry script | Where package assets are served from |
| `manifestUrl` | `agentos-search.manifest.json` under `assetBase` | Override manifest location |
| `refreshAfterMs` | none | Background re-crawl interval; when set, clamped between 1 minute and 7 days |

If you omit `collections`, the product uses a single collection: `id: "site"`, seeds `["/"]` on the current page origin, and a label taken from the document title or hostname.

### Collections

Palette fields that work today: `id`, `label`, `order`, `prefix`, `placeholder`, `minQueryLength`, and `limit`. Crawl starts from each collection’s **`seeds`** and follows same-origin links from there. Fetch is limited to the **page origin**; extra `origins` are only accepted when they match that origin.

Path prefixes, `maxPages`, and sitemaps may appear in config, but guest `searchd` does **not** enforce them yet. Until it does, keep seeds explicit and the public site graph tight. Prefixes such as `docs:` and `blog:` still scope **queries** in the palette even when path isolation is incomplete.

### Placement and asset location

To put the control in your own markup, set `autoMount: false` and render `<mc-site-search>` yourself. Bootstrap fails if auto-mount is off and no element is present.

```html
<header>
  <mc-site-search placeholder="Search this site"></mc-site-search>
</header>
<script>
  globalThis.AgentOSSearch = { autoMount: false };
</script>
<script type="module" src="/agentos-search/agentos-search.mjs"></script>
```

If the package is not at `/agentos-search/`, keep the script URL and `assetBase` in sync:

```html
<script>
  globalThis.AgentOSSearch = { assetBase: "/assets/search/" };
</script>
<script type="module" src="/assets/search/agentos-search.mjs"></script>
```

### Events

All three bubble and are composed, so you can listen on the element or on `document`.

| Event | Cancelable | `detail` |
| --- | --- | --- |
| `mc-search-query` | no | `{ query, mode }` as the user types |
| `mc-search-error` | no | `{ collectionId, error }` when a collection search fails |
| `mc-search-select` | yes | `{ item, collection, query, method }` — `method` is `keyboard`, `pointer`, or `api` |

Call `preventDefault()` on `mc-search-select` to skip the default `location.assign` and route yourself (SPAs).

```js
document.addEventListener("mc-search-select", (event) => {
  // event.detail.item.href, .label, .collectionId, …
  // event.preventDefault();
});
```

### Theming

```css
mc-site-search {
  --mc-search-fg: #0f172a;
  --mc-search-surface: #ffffff;
  --mc-search-focus: #4f46e5;
  --mc-search-border: #e2e8f0;
  --mc-search-width: 720px;
}
```

Useful tokens also include `--mc-search-fg-secondary`, `--mc-search-elevated`, `--mc-search-substrate`, `--mc-search-active-bg`, `--mc-search-active-fg`, `--mc-search-radius`, `--mc-search-max-height`, and `--mc-search-backdrop`. The element ships sensible dark defaults via `prefers-color-scheme`.

On viewports **≤680px** the dialog becomes a full-viewport **sheet** (`layout="sheet"`): width / max-height / top tokens apply to the desktop **palette** only. Sheet mode tracks `visualViewport` for the software keyboard and shows a close control (`::part(close)`).

---

## How it works

```text
Your page
  │  agentos-search.mjs (+ optional globalThis.AgentOSSearch)
  ▼
Entry (main thread)
  │  registers <mc-site-search>
  │  optional service worker (package asset cache)
  │  starts the module worker
  ▼
Runtime worker
  │  kernel.wasm + search-atlas.tar + mc-core
  │  cold boot or OPFS restore
  ▼
Guest /svc/searchd   ◄── serviceCall only (not a public HTTP API)
  │  crawl plan · FTS5 / VANN · fusion · promote
  │  host tools for fetch / extract / embed
  ▼
Index under /var/searchd/  →  palette UI (⌘K)
```

Crawl is same-origin. Ranking and crawl policy live only in guest `searchd` — TypeScript never ranks production results. The durable index sits in OPFS; the service worker, when allowed, only caches distribution files. Upgrading means replacing the whole `agentos-search/` tree; visitors may cold-boot if digests change.

**Requirements.** A modern browser with module scripts, module workers, WebAssembly, and OPFS, on a secure context (`https:` or `http://localhost`). Host static files with correct MIME types and a CSP that allows modules, workers, Wasm, and same-origin fetches.

**Out of scope for the visitor package.** Off-origin indexing, SEO sitemap generation as a product feature, and any production path that ranks outside guest searchd. Optional **prewarm** (build a snapshot ahead of time) is a maintainer flow described under [Developers](#for-developers).

---

## Hosting (MIME and CSP)

The package is same-origin static files. There is no CDN fallback and no remote model download. Your host must serve the unpacked tree with the right types, and any site-wide CSP must allow what the entry script actually does.

### MIME types

Browsers refuse module scripts and module workers when the response is not a JavaScript MIME type. Serve `.mjs` as `text/javascript` or `application/javascript`, `.wasm` as `application/wasm`, and leave `.json`, `.tar`, and `.onnx` as ordinary static content. Most CDNs already do this; **nginx** often needs an explicit map:

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

Do not let reverse proxies rewrite those types or truncate large bodies (`.tar`, `.onnx`, `.wasm`).

### Content-Security-Policy

If the site sends a CSP, the page that loads `agentos-search.mjs` needs approximately:

```http
Content-Security-Policy:
  script-src 'self' 'wasm-unsafe-eval' blob:;
  worker-src 'self' blob:;
  connect-src 'self';
```

Prefer `'wasm-unsafe-eval'` over `'unsafe-eval'` — this product needs Wasm compilation, not general `eval`. The `blob:` source is required because verified package JS is re-imported from blob URLs after SHA-256 checks; blocking it usually surfaces as a dynamic-import or CSP console error. The package never needs a third-party script or worker origin. Cross-origin isolation (COOP/COEP) is **not** required.

Service worker registration is best-effort and scoped under the package directory. A failed registration only disables the distribution cache; search can still run online.

### If something fails

- Manifest or assets 404 → the tree is not under the **published** static root, or `src` / `assetBase` disagree.
- `.mjs` fails as a module → response is not a JavaScript MIME type (often `application/octet-stream`).
- Wasm or dynamic-import errors under CSP → allow `'wasm-unsafe-eval'` and `blob:` as above.
- Empty results → wait for ready; confirm seeds resolve and Network shows crawl GETs.
- Unexpected pages indexed → guest follows same-origin links from seeds; path prefixes are not enforced yet.

---

# For developers

This repository is the **product** that builds and ships AgentOS site search. It is a standalone Bazel workspace. AgentOS is not vendored as a monorepo sibling; it is a **git-pinned Bazel module** declared in root `MODULE.bazel`.

### Everyday commands

```sh
bazel run //tools/deps:update_lock   # after package.json changes
bazel test //:check                  # typecheck + unit smoke
bazel run //demo:dev                 # http://127.0.0.1:5191
bazel build //:release               # bazel-bin/release.tar
```

Bazel’s user root (caches and outputs) lives under **`./bazel-cache`** in this repo (see `.bazelrc`). That path is gitignored. Always run Bazel from the workspace root so it resolves next to `MODULE.bazel`.

### Layout

```text
search-experience/
├── MODULE.bazel              # agent-os pin, hermetic_cc, rules_bun, model fetches
├── BUILD.bazel               # //:check, //:release, bundles, manifest
├── src/
│   ├── host/                 # bootstrap, SearchdClient, VM boot
│   ├── worker/               # runtime worker + integrity
│   ├── host-tools/           # fetch / extract / embed
│   ├── ui/                   # palette + <mc-site-search>
│   ├── protocol/             # pure wire contracts
│   └── embedding/            # Mixedbread + helpers
├── guest/searchd/            # Rust /svc/searchd
├── guest/image/              # search-atlas definition
├── index/schema.sql
├── demo/                     # Vite demo site
├── test/
├── tools/                    # browser e2e, prewarm, packaging helpers
└── third_party/agent-os/     # patches applied to the pin
```

### How AgentOS is consumed

Root `MODULE.bazel` pins AgentOS with `bazel_dep` + `git_override` (commit SHA is the source of truth). Product targets use `@agent-os//…` labels for the kernel, mc-core bundle, catalog compiler, base image, sqlite guest glue, and guest macros (`mc_rust_program`, `mc_service_layer`). There is **no** default path that downloads those from GitHub releases; they are built from the pin.

bzlmod only materializes some extension repos for the **root** module. AgentOS expects `@zig_sdk` from `hermetic_cc_toolchain`, so this product re-hosts that extension at root and registers the Zig toolchains.

Patches under `third_party/agent-os/` keep the nested module usable for this product: strip Elixir/server deps we do not need, fix main-repo-relative loads for tree-sitter, fix Luau include paths under an external root, and cap the sqlite Wasm stack at 1 MiB so guest memory stays on budget.

To bump AgentOS: change the `commit` in `git_override`, confirm patches still apply, then run `bazel test //:check` and `bazel build //:release`. Expect snapshot compatibility keys to change so visitors cold-boot.

### Guest image and who owns what

Production does **not** ship stock AgentOS `atlas` / `loom` / Luau. The guest image is **`search-atlas`**: AgentOS **base**, a product sqlite layer (FTS5 + VANN), eager `/svc/searchd`, and `/var/searchd`. Searchd does not shell out to coreutils, so base is enough; stock atlas would pull Luau we deliberately avoid.

Authority is split cleanly:

- **`/svc/searchd`** owns crawl plan, journals, FTS5/VANN, fusion, generations, and promote.
- **Host tools** own same-origin fetch, HTML extract, and embedding batches (`host.org.main.search.*`). They do not rank.
- **Runtime worker** owns boot/restore, tool wiring, the serviceCall queue, and OPFS snapshots.
- **`<mc-site-search>`** owns the palette UI only.
- **Service worker** owns distribution asset cache only — not crawl, ONNX, or AgentOS.

Queries always read `/var/searchd/index.db`. A cold first index writes `index.db` directly. A refresh rebuilds `/var/searchd/candidate.db`, then promote copies a non-empty candidate (pages **and** chunks ≥ 1) over the active index and clears the candidate. Incomplete candidates are discarded.

### Demo, browser E2E, and prewarm

`bazel run //demo:dev` alone runs UI fixtures without guest assets — useful for palette work, not for the unpack-and-script-tag product path.

Full product path against the demo site:

```sh
bazel build //:release
tar -xf bazel-bin/release.tar -C demo/public
bazel run //demo:dev
```

Hermetic unit tests are not browser E2E. After a release is unpacked, run system Chromium against the real package (`CHROMIUM_PATH` or `/usr/bin/chromium`):

```sh
bun tools/browser-e2e.mjs \
  --release-dir=demo/public/agentos-search \
  --export-snapshot \
  --out=./warm
```

That boots kernel + search-atlas, crawls the demo docs/blog fixtures, asserts non-empty hits, and with `--export-snapshot` writes a gzip-encoded full MCSN.

The publisher CLI can plan without a guest (`bun src/publisher/cli.ts --origin=https://example.com --out=./warm`) or capture for real (`--capture --release-dir=…`). Capture always writes gzip MCSN (`meta.encoding: "gzip"`; `snapshotSha256` digests those gzip bytes).

`//:release` does not embed a site-specific snapshot — configuration is integrator-owned. After capture, inject snapshot assets and rewrite integrity digests:

```sh
bun tools/package-prewarm.mjs \
  --release-dir=demo/public/agentos-search \
  --snapshot=./warm/search.snapshot \
  --metadata=./warm/search.snapshot.metadata.json
```

On first visit with empty OPFS the worker can seed restore from those assets; reattachment rules still apply. Snapshot bytes on disk are **gzip only** — uncompressed MCSN is rejected.

---

# System guide

This section is for people changing the product, not for site owners.

### Protocol layers

Keep envelopes distinct. Constants live in `src/protocol/versions.ts` and the matching protocol modules:

| Layer | What it covers |
| --- | --- |
| Page ↔ runtime worker | `SEARCH_PROTOCOL_VERSION` — UI and host bootstrap talking to the worker |
| Host ↔ guest searchd | `SEARCHD_PROTOCOL_VERSION` — serviceCall bodies; keep `searchd.protocol.json`, `src/protocol/searchd.ts`, and `guest/searchd/src/main.rs` aligned |
| Distribution manifest | `MANIFEST_SCHEMA_VERSION` — layout and digests; `transport` must be `"serviceCall"` |
| OPFS snapshot metadata | `SNAPSHOT_FORMAT_VERSION` — warm restore metadata (gzip MCSN payload) |

OPFS compatibility keys include digests of kernel, image, schema, model fingerprint, searchd protocol, plus a hash of collections and page origin. Change any of those and warm restore is intentionally invalidated: visitors cold-boot and re-crawl.

### Security model

Fetch is http(s) only, with `credentials: "omit"`, a fixed product User-Agent, body and timeout caps, and an origin allowlist derived from the page (and same-origin collection origins). Redirect final origins are checked. Result navigation is sanitized to http(s) and same-origin when the page origin is known. Private and link-local hosts are blocked unless the page origin itself is that host (normal for local demos).

### Product boundaries

Do not reintroduce a Luau production transport, prebuilt AgentOS asset pins as the default build path, or a second host-side ranking authority. TypeScript FTS/RRF helpers in this tree are **test oracles**, not production rankers. The service worker stays a distribution cache, not a compute surface.

### Contributing

1. After `package.json` changes, run `bazel run //tools/deps:update_lock`.
2. Gate every change with `bazel test //:check`.
3. Guest, protocol, or schema changes need a rebuild of searchd and search-atlas; expect snapshot key churn.
4. AgentOS bumps need a patch re-check and a root `hermetic_cc` sanity pass.
5. Packaging work: build `//:release`, unpack into `demo/public`, run `//demo:dev`, and use the browser E2E path when the change touches boot, crawl, or restore.
