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

Serve `.mjs` as JavaScript and `.wasm` as `application/wasm` (most static hosts do this already; nginx may need an explicit `types` map).

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
| Browser | Modern engine with **Workers** + **OPFS**; secure context (`https:` or `http://localhost`) |
| Hosting | Static files with correct MIME for `.mjs` and `.wasm` |
| Crawl | Same-origin pages the visitor can GET without credentials |
| Size | Crawl follows same-origin links from seeds until the queue drains; keep seed graphs small on large sites |
| Not included | Server-side crawler, SEO sitemap generation, off-origin indexing, Luau scripting path |

Private / link-local hosts are blocked unless the page origin itself is allowlisted (normal for local demos).

---

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Manifest HTTP 404 | Is `agentos-search/` under the **published** static root? Open the manifest URL in the browser. |
| Assets 404 / wrong path | Script `src`, `assetBase`, and unpack location must agree. |
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

Large guest builds use (see `.bazelrc`):

```text
startup --output_user_root=/mnt/workspace/search-experience-bazel
```

---

## Repo layout

```text
search-experience/
├── MODULE.bazel                 # agent-os git_override, hermetic_cc, rules_bun, model http_files
├── BUILD.bazel                  # //:check, //:release, bundles, manifest, runtime assets
├── src/                         # host product (TypeScript)
│   ├── protocol/                # contracts: page↔worker, searchd, host-tools, snapshot, manifest
│   ├── host-tools/              # fetch / extract / embed only
│   ├── runtime/                 # bootstrap, worker client, VM boot, SearchdClient
│   ├── elements/mc-site-search.ts
│   ├── runtime-worker.ts        # module worker
│   └── service-worker.ts        # distribution cache only
├── guest/
│   ├── searchd/                 # stamped /svc/searchd (Rust mc_rust_program)
│   └── image/                   # search-atlas = base + sqlite + searchd
├── index/schema.sql
├── demo/                        # Vite demo site
├── test/
├── tools/                       # bundles, manifest, lock update
└── third_party/agent-os/        # patches on the git-pinned module
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

`guest/searchd/main.luau` is historical reference only — **not** in `//:release`.

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
