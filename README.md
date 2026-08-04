# AgentOS site search

Drop-in, same-origin **site search** for static sites and app frontends. Unpack a small package next to your pages, add one script tag, and visitors get a command-palette search (**⌘K** / **Ctrl+K**) that crawls and indexes your site **in the browser**.

No search server. No third-party index. No server-side crawl job. Policy, indexing, and ranking live in a guest service (`/svc/searchd`); the host only fetches pages, extracts text, and embeds.

| Audience | Start here |
| --- | --- |
| **Site owners / frontend** | [Install on your site](#install-on-your-site) |
| **Maintainers of this repo** | [For developers](#for-developers) · [System guide](#system-guide) |

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

On first load the script:

1. Registers `<mc-site-search>` and auto-mounts it (unless configured otherwise)
2. Boots a runtime worker with the packaged kernel + guest image
3. Crawls your site from configured **seeds** (default: current origin’s `/`), following same-origin links
4. Opens with **⌘K** / **Ctrl+K** (and a launcher button)

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

### What “it worked” looks like

- No console error from `agentos-search.mjs`
- Network shows `agentos-search.manifest.json` → **200**
- Launcher appears (unless disabled); **⌘K** opens the palette
- First visit may take a moment while the guest boots and crawls (status text on the element)
- Later visits restore faster from **OPFS** when the package/config still match

---

## Framework static folders

Put the whole `agentos-search/` directory in the folder that is served at the **site root**. The script URL is then always `/agentos-search/agentos-search.mjs`.

| Stack | Unpack into | Script URL |
| --- | --- | --- |
| Plain HTML / nginx | document root | `/agentos-search/agentos-search.mjs` |
| Vite | `public/` | same |
| Next.js | `public/` | same |
| Nuxt | `public/` | same |
| Astro | `public/` | same |
| Hugo | `static/` | same |
| Jekyll | site root (or your static dir) | same (use `relative_url` if needed) |
| SvelteKit | `static/` | same |
| Cloudflare Pages | project / `public` as configured | same |

### Examples

**Vite / Next / Nuxt / Astro**

```sh
tar -xf release.tar -C public
```

**Hugo / SvelteKit**

```sh
tar -xf release.tar -C static
```

**nginx**

```sh
tar -xf release.tar -C /usr/share/nginx/html
```

MIME types and Content-Security-Policy matter for this package — see [Content-Security-Policy and static hosting](#content-security-policy-and-static-hosting).

**Next.js (App Router) — load once in the root layout**

Use a real browser script (not a self-closing JSX tag alone). Example with `next/script`:

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

Or inject a normal `<script type="module" src="…">` from a plain HTML shell if you do not use `next/script`.

**Hugo base template**

```html
<script type="module" src="/agentos-search/agentos-search.mjs"></script>
```

**Nuxt**

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  app: {
    head: {
      script: [{ type: "module", src: "/agentos-search/agentos-search.mjs" }],
    },
  },
});
```

If the package is **not** at `/agentos-search/`, set both the script `src` and `assetBase` to that folder (see [Configuration](#configuration)).

---

## What’s in the package

After unpack, you should see:

```text
agentos-search/
├── README.md
├── agentos-search.mjs              # page entry (auto-bootstrap)
├── agentos-search.manifest.json    # integrity digests + layout
├── agentos-search-runtime.mjs      # module worker (boot, tools, serviceCall)
├── agentos-search-sw.mjs           # service worker (asset cache only)
├── agentos-search-embed.mjs        # hermetic embedder
├── kernel.wasm                     # AgentOS kernel
├── search-atlas.tar                # guest image (searchd + sqlite)
├── mc-core.mjs                     # browser VM runtime
├── catalog-compiler.wasm
├── index/schema.sql
├── searchd/searchd.protocol.json
└── model/
    ├── model.onnx
    ├── tokenizer.json
    ├── tokenizer_config.json
    ├── config.json
    └── runtime/                    # ORT .mjs + .wasm
```

All of these are part of one **compatibility unit**. Replace the whole directory when upgrading; do not mix files from different builds.

---

## Configuration

Set `globalThis.AgentOSSearch` **before** `agentos-search.mjs`.

### Options

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `collections` | `BrowserCrawlDefinition[]` | one whole-site collection | What to crawl and how it appears in the palette |
| `autoMount` | `boolean` | `true` | Create `<mc-site-search>` if missing |
| `showLauncher` | `boolean` | `true` | Show the Search / ⌘K control |
| `assetBase` | `string \| URL` | directory of the entry script | Where package assets live |
| `manifestUrl` | `string \| URL` | `agentos-search.manifest.json` under `assetBase` | Override manifest location |
| `refreshAfterMs` | `number` | none | Background re-crawl interval; when set, clamped to **60 000 ms … 7 days** |

### Default collection

If you omit `collections`:

| Field | Value |
| --- | --- |
| `id` | `"site"` |
| `label` | document title or hostname |
| `seeds` | `["/"]` (resolved absolute against the page) |
| `origins` | current page origin |
| `order` / `limit` / `minQueryLength` | `10` / `10` / `1` |
| `placeholder` | `"Search this site"` |

### What collections control today

| Area | Honored now | Notes |
| --- | --- | --- |
| **Palette / UI** | `id`, `label`, `order`, `prefix`, `placeholder`, `minQueryLength`, `limit`, `emptyStateLabel` | How sections and results appear |
| **Crawl start** | `seeds` | Queue is seeded from these URLs only |
| **Network** | same-origin only | Host fetch allowlist is the **page origin** (extra `origins` only accepted if same-origin) |
| **Path prefixes / maxPages / sitemaps** | **carried in config, not enforced by stamped Rust `searchd` yet** | Guest BFS follows same-origin links from seeds; do not rely on prefixes for isolation until guest enforces them |
| **Per-fetch bounds** | host tool | Body size and timeout caps on fetch (not collection `maxPages`) |

### Multi-collection example

```html
<script>
  globalThis.AgentOSSearch = {
    collections: [
      {
        id: "docs",
        label: "Documentation",
        seeds: ["/docs/", "/docs/runtime.html"],
        prefix: "docs:",
        order: 10,
      },
      {
        id: "blog",
        label: "Blog",
        seeds: ["/blog/", "/blog/collections.html"],
        prefix: "blog:",
        order: 20,
      },
    ],
    refreshAfterMs: 60 * 60 * 1000,
  };
</script>
<script type="module" src="/agentos-search/agentos-search.mjs"></script>
```

Prefer **explicit seeds** (and keep the site graph tight) until path-prefix enforcement lands in guest searchd. UI prefixes (`docs:`, `blog:`) still scope **queries** in the palette.

### Place the control yourself

```html
<header>
  <mc-site-search placeholder="Search this site"></mc-site-search>
</header>
<script>
  globalThis.AgentOSSearch = { autoMount: false, showLauncher: true };
</script>
<script type="module" src="/agentos-search/agentos-search.mjs"></script>
```

If `autoMount` is `false` and no `<mc-site-search>` exists, bootstrap fails.

### Package under a subpath

```html
<script>
  globalThis.AgentOSSearch = { assetBase: "/assets/search/" };
</script>
<script type="module" src="/assets/search/agentos-search.mjs"></script>
```

---

## Extension points

| What you can change | How |
| --- | --- |
| **What gets crawled** | `collections[].seeds` (start URLs); same-origin link following |
| **How sections appear** | `label`, `order`, `prefix`, `placeholder`, `limit` |
| **Where the control lives** | Place `<mc-site-search>` + `autoMount: false` |
| **Launcher visibility** | `showLauncher` |
| **Asset location** | `assetBase` / `manifestUrl` + matching script `src` |
| **Look and feel** | CSS custom properties on `mc-site-search` |
| **Client-side navigation** | `mc-search-select` + `preventDefault()` (SPAs) |
| **Query telemetry** | `mc-search-query` (each input); `mc-search-error` (per-collection search failure) |

### Events

Events bubble and are composed (listen on the element or `document`).

| Event | Cancelable | `detail` |
| --- | --- | --- |
| `mc-search-query` | no | `{ query, mode }` — fires as the user types |
| `mc-search-error` | no | `{ collectionId, error }` — collection search failed (not boot failure) |
| `mc-search-select` | **yes** | `{ item, collection, query, method }` — `method` is `keyboard` \| `pointer` \| `api`. `preventDefault()` skips default `location.assign` navigation |

```js
document.addEventListener("mc-search-select", (event) => {
  // event.detail.item.href, .label, .collectionId, …
  // event.preventDefault(); // SPA: route yourself
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

Useful tokens: `--mc-search-fg`, `--mc-search-fg-secondary`, `--mc-search-surface`, `--mc-search-elevated`, `--mc-search-substrate`, `--mc-search-border`, `--mc-search-focus`, `--mc-search-active-bg`, `--mc-search-active-fg`, `--mc-search-radius`, `--mc-search-width`, `--mc-search-max-height`, `--mc-search-backdrop`. Dark mode can override the same set; the element also has sensible `prefers-color-scheme: dark` defaults.

---

## How it works

```text
Your page
  │  script type=module → agentos-search.mjs
  │  optional globalThis.AgentOSSearch
  ▼
Entry (main thread)
  │  registers <mc-site-search>
  │  optional service worker (cache package assets by digest)
  │  starts module worker
  ▼
Runtime worker
  │  loads kernel.wasm + search-atlas.tar + mc-core
  │  creates or restores guest machine (OPFS snapshot)
  ▼
Guest /svc/searchd   ◄── serviceCall only (not a public HTTP API)
  │  crawl plan · FTS5/VANN · fusion · promote
  │  asks host tools for fetch / extract / embed
  ▼
Index under /var/searchd/
  · index.db      ← all queries
  · candidate.db  ← rebuild during refresh, then promote
  ▼
Palette UI  ←  ⌘K · results · preview · navigate
```

**Design constraints:**

- Crawl is **same-origin** (page origin allowlist; non–same-origin `origins` are ignored).
- Search policy is **only** in guest `searchd` — TypeScript never ranks production results.
- Durable index state is **OPFS**; distribution files use Cache Storage via the service worker (SW registration is best-effort and non-fatal if blocked).
- Upgrade by replacing the whole `agentos-search/` tree; snapshot restore may cold-boot if digests change.

---

## Requirements and limits

| Need | Detail |
| --- | --- |
| Browser | Modern engine with **module scripts**, **module Workers**, **WebAssembly**, and **OPFS**; secure context (`https:` or `http://localhost`) |
| Hosting | Static files with correct MIME types; CSP must allow modules, workers, Wasm, and same-origin fetches (see below) |
| Crawl | Same-origin pages the visitor can GET without credentials |
| Size | Crawl follows same-origin links from seeds until the queue drains; keep seed graphs small on large sites |
| Not included | Server-side crawler, SEO sitemap generation, off-origin indexing, Luau scripting path |

Private / link-local hosts are blocked unless the page origin itself is allowlisted (normal for local demos).

---

## Content-Security-Policy and static hosting

The copy-and-import package is **same-origin static files only**. There is no CDN, no remote model download, and no Node server at runtime. Your host must serve the unpacked `agentos-search/` tree with correct MIME types, and any site-wide CSP must allow the browser features the entry script actually uses.

### What the browser loads

| Asset class | Examples in the package | How it is used |
| --- | --- | --- |
| Page ES module | `agentos-search.mjs` | `<script type="module">` on the page |
| Module worker | `agentos-search-runtime.mjs` | `new Worker(url, { type: "module" })` — boots the guest, tools, search |
| Module service worker | `agentos-search-sw.mjs` | Best-effort `navigator.serviceWorker.register(url, { type: "module" })` for **distribution asset cache only** (crawl / ONNX / AgentOS stay in the runtime worker). Registration failure is non-fatal |
| WebAssembly | `kernel.wasm`, `catalog-compiler.wasm`, ORT `*.wasm` under `model/runtime/` | Fetched as bytes; compiled/instantiated in the runtime worker |
| Guest image | `search-atlas.tar` | Fetched as bytes; cold-boot / restore input for the guest |
| ONNX + tokenizer | `model/model.onnx`, `tokenizer.json`, … | Fetched same-origin by the hermetic embedder (no remote Hugging Face / CDN path) |
| Other JS modules | `mc-core.mjs`, `agentos-search-embed.mjs`, ORT `*.mjs` | Fetched, integrity-checked, then loaded (some via `blob:` URL + dynamic `import()` after verify) |
| Manifest / schema / JSON | `agentos-search.manifest.json`, `index/schema.sql`, model configs | Same-origin `fetch` |

Network access after load is **same-origin**: package assets under `assetBase`, crawl GETs of visitor-reachable pages on the **page origin**, and Cache Storage for verified distribution files. Embeddings do **not** call out to a model CDN.

### MIME types (static host)

Browsers refuse module scripts and module workers when the response is not a JavaScript MIME type. Serve at least:

| Extension | Required / recommended `Content-Type` | Why |
| --- | --- | --- |
| `.mjs` | `text/javascript` or `application/javascript` | Page entry, module worker, module service worker, ORT runtime JS |
| `.wasm` | `application/wasm` | Kernel, catalog compiler, ONNX Runtime Wasm |
| `.json` | `application/json` | Manifest, tokenizer/config |
| `.tar` | `application/x-tar` or `application/octet-stream` | Guest image bytes (`search-atlas.tar`) |
| `.onnx` | `application/octet-stream` | Embedding model weights |
| `.sql` | `text/plain` or `application/sql` | Schema text |

Most CDNs and “static site” hosts already map `.mjs` and `.wasm` correctly. **nginx** often needs an explicit map:

```nginx
types {
  text/html                             html htm;
  text/css                              css;
  text/javascript                       js mjs;
  application/wasm                      wasm;
  application/json                      json;
  application/octet-stream              onnx;
  application/x-tar                     tar;
  text/plain                            sql txt;
  # …keep your other types…
}
```

Also ensure reverse proxies do not rewrite or strip these types, and that large binaries (`.tar`, `.onnx`, `.wasm`) are not truncated by body-size limits.

### Content-Security-Policy

If the site sends a CSP, the page that loads `agentos-search.mjs` must allow the following. Adjust host lists if you already pin `'self'` more tightly; the package never requires a third-party script or worker origin.

| Directive | Minimum for this package | Why |
| --- | --- | --- |
| `script-src` | `'self' 'wasm-unsafe-eval' blob:` | Page module; **WebAssembly** compile/instantiate under CSP (kernel + ONNX Runtime); integrity-checked modules loaded via **`blob:`** dynamic `import()` (mc-core, embedder) |
| `worker-src` | `'self' blob:` | **Module worker** (`agentos-search-runtime.mjs`) and **module service worker** (`agentos-search-sw.mjs`); `blob:` if a worker-side dynamic import is governed by this directive in your browser |
| `connect-src` | `'self'` | Manifest + package asset fetches, same-origin crawl `fetch`, Cache Storage network fallback |
| `default-src` | Do not set a tight default that overrides the above without re-stating them | Missing `worker-src` falls back to `script-src` / `default-src` in CSP3; a bare `default-src 'none'` without worker/script allowances will block boot |

**Illustrative** policy fragment (merge with the rest of your site’s CSP; do not treat this as a full-site policy):

```http
Content-Security-Policy:
  script-src 'self' 'wasm-unsafe-eval' blob:;
  worker-src 'self' blob:;
  connect-src 'self';
```

Notes:

- Prefer **`'wasm-unsafe-eval'`** over **`'unsafe-eval'`**. This product needs Wasm compilation, not general `eval`.
- **`blob:`** is required because verified package JS is re-imported from blob URLs after SHA-256 checks (avoids a second TOCTOU fetch). Blocking `blob:` in `script-src` typically fails boot with a dynamic-import / CSP console error.
- Service worker registration uses `{ type: "module" }` and a **scope under the package directory** (the SW script’s folder). A failed registration only disables the distribution cache; search can still run online.
- **Cross-Origin Isolation** (COOP/COEP) is **not** required for this package: the embedder runs ONNX Runtime with a single thread and does not depend on `SharedArrayBuffer`.
- Crawl and asset loads use ordinary same-origin HTTP(S) fetches with `credentials: "omit"`. You do not need to open `connect-src` to model or package CDNs.

### Checklist before go-live

1. Open `/agentos-search/agentos-search.manifest.json` → **200**, `Content-Type` includes `json`.
2. Open `/agentos-search/agentos-search.mjs` → **200**, JavaScript MIME (not `application/octet-stream`).
3. Open a `.wasm` and `search-atlas.tar` → **200**, full body (not HTML error page).
4. Console: no CSP violations for `script-src` / `worker-src` / `connect-src`; no “module scripts don’t work with this MIME type”.
5. Application → Storage: OPFS (or equivalent) writable on a secure context; optional service worker registered under the package path.

---

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Manifest HTTP 404 | Is `agentos-search/` under the **published** static root? Open the manifest URL in the browser. |
| Assets 404 / wrong path | Script `src`, `assetBase`, and unpack location must agree. |
| `.mjs` fails as module / worker | Response `Content-Type` must be a **JavaScript** MIME (`text/javascript` or `application/javascript`), not `application/octet-stream`. |
| Wasm / kernel / ORT errors under CSP | Allow **`'wasm-unsafe-eval'`** in `script-src` (prefer that over `'unsafe-eval'`). |
| Boot fails mentioning `blob:` or dynamic import | Allow **`blob:`** in `script-src` (and `worker-src` if you set it); mc-core and the embedder load via verified blob URLs. |
| Worker or service worker blocked | `worker-src` (or fallback `script-src`) must include `'self'` for same-origin module workers; SW failure alone is non-fatal. |
| Stale package | Hard refresh; clear Cache Storage / unregister old service workers. |
| Empty results | Wait for ready; verify seeds resolve; check Network for crawl GETs. |
| Unexpected pages indexed | Guest follows same-origin links from seeds; path prefixes are not enforced yet — tighten seeds / site graph. |
| Private host blocked | Use a public hostname in production; localhost only works as same-origin. |
| OPFS / storage errors | Not private-mode only; free quota; secure context. |
| No palette / no launcher | Console errors? `autoMount: false` without an element? `showLauncher: false`? |

---

# For developers

This repository is a **standalone Bazel product**. AgentOS is consumed as a **git-pinned Bazel module** (`bazel_dep` + `git_override` in root `MODULE.bazel`) — not as a monorepo sibling, and not via `local_path_override` for normal work.

```sh
bazel run //tools/deps:update_lock   # after package.json changes
bazel test //:check                  # typecheck + unit smoke
bazel run //demo:dev                 # http://127.0.0.1:5191
bazel build //:release               # bazel-bin/release.tar → agentos-search/
```

Bazel’s user root (action cache, install, outputs) lives under **`./bazel-cache`**
in the repo (see `.bazelrc`). It is gitignored by `/bazel-*`. Run Bazel from the
workspace root so that path resolves next to `MODULE.bazel`.

---

## Repo layout

```text
search-experience/
├── MODULE.bazel                 # agent-os git_override, hermetic_cc, rules_bun, model http_files
├── BUILD.bazel                  # //:check, //:release, bundles, manifest, runtime assets
├── src/
│   ├── index.ts / register.ts   # package entry (auto-bootstrap)
│   ├── protocol/                # pure wire contracts
│   ├── host/                    # bootstrap, SearchdClient, VM boot, page↔worker client
│   ├── worker/                  # runtime worker entry + asset integrity
│   ├── host-tools/              # fetch / extract / embed (effects only)
│   ├── ui/mc-site-search/       # palette element + styles
│   ├── ui/palette/              # modes, recents, registry, types
│   ├── embedding/               # Mixedbread + text helpers (embed bundle entry)
│   ├── oracles/                 # FTS/RRF test oracles (not production authority)
│   ├── security/
│   └── service-worker.ts
├── guest/searchd/src/           # modular Rust: paths, state, svc, handlers, …
├── guest/image/                 # search-atlas
├── index/schema.sql
├── demo/
├── test/                        # protocol, host-tools, search-ui, searchd-client, contracts
├── tools/
└── third_party/agent-os/
```

---

## AgentOS as an external package

### Dependency shape

```python
# MODULE.bazel (abridged)
bazel_dep(name = "agent-os", version = "0.0.0")

git_override(
    module_name = "agent-os",
    commit = "<pinned-sha>",  # MODULE.bazel is source of truth; bump deliberately
    remote = "https://github.com/NarendraPatwardhan/agent-os.git",
    patch_strip = 1,
    patches = [
        "//third_party/agent-os:0001-module-strip-elixir-server.patch",
        "//third_party/agent-os:0002-tree-sitter-load-agent-os.patch",
        "//third_party/agent-os:0003-luau-include-external-root.patch",
    ],
)
```

Product code references **`@agent-os//…` labels**, for example:

| Need | Label |
| --- | --- |
| Kernel | `@agent-os//memcontainers/kernel/rust:kernel` |
| mc-core bundle | `@agent-os//memcontainers/sdk-js/core:bundle` |
| Catalog compiler | `@agent-os//memcontainers/lib/catalog-compiler:wasm` |
| Base image | `@agent-os//memcontainers/images:base` |
| SQLite guest | `@agent-os//memcontainers/programs/sqlite/glue:sqlite` |
| Guest macros | `@agent-os//bazel:mc_program.bzl` (`mc_rust_program`, `mc_service_layer`) |

There is **no** GitHub-release `http_file` path for kernel / image / mc-core. Those are built from the pinned module.

### Why root re-hosts `hermetic_cc`

bzlmod only materializes some extension repos for the **root** module. AgentOS expects `@zig_sdk` from `hermetic_cc_toolchain`. When AgentOS is nested, this product must instantiate the extension at root and `register_toolchains` for Zig.

### Patches

| Patch | Purpose |
| --- | --- |
| `0001-module-strip-elixir-server` | Drop Elixir/Erlang server deps (not needed for guest Wasm / searchd) |
| `0002-tree-sitter-load-agent-os` | Fix main-repo `load("@//bazel:…")` → `@agent-os//bazel:…` when nested |
| `0003-luau-include-external-root` | Luau `-include` basenames so nested paths resolve (stock atlas Luau is not in our image, but the module may still build those targets) |

### Bumping AgentOS

1. Update `commit` in `git_override`; re-check patches apply.
2. `bazel test //:check && bazel build //:release`.
3. Expect snapshot **compatibility keys** to change (cold boot for visitors).

---

## Guest image: `search-atlas`

Product does **not** ship stock AgentOS `atlas` / `loom` / Luau. Production authority is stamped **`/svc/searchd`**.

`//guest/image:search_atlas`:

| Layer | Source | Role |
| --- | --- | --- |
| **base** | `@agent-os//memcontainers/images:base` | `/bin/sh`, pkgfsd, `/svc/tools`, adapters, git (no coreutils) |
| **sqlite_layer** | product layer over public sqlite glue | `/svc/sqlite` (FTS5 + VANN) |
| **searchd_layer** | `//guest/searchd:searchd_layer` | eager `/svc/searchd` |
| **product_dirs** | local | `/var/searchd` |

```sh
bazel build //guest/searchd:searchd //guest/image:search_atlas
```

**Why base, not posix?** Searchd does not shell out to coreutils.  
**Why not stock atlas?** Atlas pulls Luau; this product is serviceCall-only.

---

## Authority and dual databases

| Component | Owns | Does not own |
| --- | --- | --- |
| **`/svc/searchd`** | Crawl plan, journals, FTS5/VANN, fusion, generations, promote | Browser cookies, unbounded network |
| **Host tools** | Same-origin fetch, extract, embed | Ranking / crawl policy |
| **Runtime worker** | Boot/restore, tool wiring, serviceCall queue, OPFS snapshots | Search policy |
| **`<mc-site-search>`** | Palette UI | VM / SQL / embeddings |
| **Service worker** | Dist asset cache | Crawl / ONNX / AgentOS |

Host tool addresses:

| Address | Role |
| --- | --- |
| `host.org.main.search.fetch` | Bounded GET, no credentials |
| `host.org.main.search.extract` | HTML → title / blocks / links |
| `host.org.main.search.embed.batch` | UINT8 embedding batch |

### Dual-DB layout

| Path | Role |
| --- | --- |
| `/var/searchd/index.db` | **Active** generation — **all queries**; cold crawl writes here when not refreshing |
| `/var/searchd/candidate.db` | Rebuild target during **refresh** only |
| `/var/searchd/state.json` | Journals / generation metadata |

1. Queries always open `index.db`.  
2. Cold first index writes `index.db` directly (`writeCandidate = false`).  
3. Refresh rebuilds `candidate.db` only.  
4. Promote requires a non-empty candidate (pages **and** chunks ≥ 1); **copies** candidate → index, then wipes candidate. Incomplete candidates are discarded.  
5. Next refresh starts a clean candidate again.

---

## Key Bazel targets

| Target | Purpose |
| --- | --- |
| `//:check` | typecheck + unit tests + demo typecheck |
| `//:release` | `agentos-search/` tarball |
| `//:bundles` | page / worker / runtime / embed JS |
| `//:agentos_runtime_assets` | kernel, mc-core, catalog-compiler from `@agent-os` |
| `//guest/searchd:searchd` | stamped searchd Wasm |
| `//guest/image:search_atlas` | product guest image |
| `//demo:dev` | Vite demo |
| `//tools/deps:update_lock` | refresh `bun.lock` |

---

## Local demo

**UI-only fixtures** (no guest assets):

```sh
bazel run //demo:dev
# console: fixture collections (release assets not mounted)
```

This path loads `demo/src/main.ts` with local fixture hits — not the unpack-and-script-tag product flow.

**Full product path:**

```sh
bazel build //:release
tar -xf bazel-bin/release.tar -C demo/public
bazel run //demo:dev
# console: [search-experience demo] product path ready
```

Demo pages (home, `/docs/runtime.html`, `/blog/collections.html`) all load search so **⌘K** works site-wide.

### Browser end-to-end acceptance (required for “product complete”)

Hermetic unit tests are **not** browser E2E. After unpacking a release, run Chromium against the real product package:

```sh
bazel build //:release
tar -xf bazel-bin/release.tar -C demo/public
bun tools/browser-e2e.mjs \
  --release-dir=demo/public/agentos-search \
  --export-snapshot \
  --out=./warm
```

This boots **kernel + search-atlas** in system Chromium (`/usr/bin/chromium` or `CHROMIUM_PATH`), crawls fixture `/docs` + `/blog`, asserts non-empty query hits, and (with `--export-snapshot`) writes a gzip-encoded full MCSN via `exportSnapshot`.

### Optional warm-snapshot publisher

```sh
# Plan only (no guest) — orchestration template for CI that lacks Chromium
bun src/publisher/cli.ts --origin=https://example.com --out=./warm

# Real MCSN capture (same harness as browser-e2e)
bun src/publisher/cli.ts --capture \
  --release-dir=demo/public/agentos-search \
  --out=./warm
```

Capture writes `search.snapshot` as gzip (`meta.encoding: "gzip"`). `snapshotSha256` is the digest of those gzip bytes.

### Optional prewarmed snapshot in the release package

`//:release` does not embed a site-specific snapshot (configuration is integrator-owned). After capture, inject snapshot assets and rewrite integrity digests:

```sh
bun tools/package-prewarm.mjs \
  --release-dir=demo/public/agentos-search \
  --snapshot=./warm/search.snapshot \
  --metadata=./warm/search.snapshot.metadata.json
```

Snapshot bytes must be gzip-encoded MCSN (`meta.encoding: "gzip"`). That sets `manifest.assets.snapshot` + `snapshotMetadata`. On first visit with empty OPFS the worker seeds restore from those assets (`src/host/vm-boot.ts` gunzips before `mc.restore`); strict reattachment still applies.

---

# System guide

### Protocol layers

Keep envelopes distinct (`src/protocol/versions.ts`):

| Layer | Constant | Where |
| --- | --- | --- |
| Page ↔ runtime worker | `SEARCH_PROTOCOL_VERSION` | `page-runtime.ts` |
| Host ↔ guest searchd | `SEARCHD_PROTOCOL_VERSION` | `searchd.ts` + `searchd.protocol.json` |
| Distribution manifest | `MANIFEST_SCHEMA_VERSION` | `manifest.ts`; `transport` must be `"serviceCall"` |
| OPFS snapshot metadata | `SNAPSHOT_FORMAT_VERSION` | `snapshot.ts` |

### Snapshot compatibility

OPFS keys include digests of kernel, image, schema, model fingerprint, searchd protocol, and a hash of collections + page origin. Changing any of these **invalidates** warm restore → cold boot + re-crawl.

### Security

- Fetch: http(s) only, `credentials: "omit"`, fixed product User-Agent  
- Origin allowlist from page + same-origin collection origins  
- Redirect final origin checked  
- Body / timeout caps  
- Result navigation sanitized to **http(s)** and **same-origin** when the page origin is known

### Not in this product

| Absent | Why |
| --- | --- |
| Stock atlas / loom / production Luau | Authority is stamped searchd |
| Luau file-transport dual path | Removed; client is serviceCall only |
| Release pins for kernel/image/mc-core | Built from git-pinned `@agent-os` |
| Host-side ranking as production | TS FTS/RRF helpers are **test oracles** only |
| Service worker as compute | Distribution / asset cache only |

---

## Contributing

1. Update locks after `package.json` changes: `bazel run //tools/deps:update_lock`.  
2. Gate: `bazel test //:check`.  
3. Guest/protocol/schema changes: rebuild searchd + search-atlas; expect snapshot key churn.  
4. Keep `searchd.protocol.json`, `src/protocol/searchd.ts`, and `guest/searchd/src/main.rs` aligned.  
5. AgentOS bumps: re-verify patches + root `hermetic_cc`.  
6. Release smoke for packaging work:

```sh
bazel build //:release
tar -xf bazel-bin/release.tar -C demo/public
bazel run //demo:dev
```

7. Do **not** reintroduce Luau production transport, prebuilt AgentOS asset pins as the default path, or a second host ranking authority.
