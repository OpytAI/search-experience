# search-experience

Copy-and-import site search built on **AgentOS** as a **Bazel module** (Strategy B).

- **Plane B only** for AgentOS runtime: kernel, mc-core, catalog-compiler, and
  `search-atlas` are built from `@agent-os//…` labels (git-pinned), not from
  GitHub release `http_file` pins.
- Product owns `//guest/searchd` (stamped `/svc/searchd`) and
  `//guest/image:search_atlas` (posix + sqlite + searchd).
- Production transport is **`serviceCall` only** — no Luau file-transport dual path.

## Architecture

| Layer | Responsibility |
| --- | --- |
| Integrator | Copy `agentos-search/`, import `agentos-search.mjs`. Optional collections + CSS |
| `<mc-site-search>` | VM-agnostic palette (collections, keyboard, preview, a11y, recents) |
| Tiny SW | Distribution/update lifecycle only |
| Runtime worker | Boot/restore machine; host tools; UI ↔ `serviceCall`; snapshots |
| `/svc/searchd` | Crawl plan, schema, journals, FTS5/VANN, fusion, generations |
| Host tools | Bounded fetch, extract, embed only |
| Persistence | Compatibility-keyed OPFS snapshots; Cache Storage for dist assets |

## Developer workflow

Bazel is the only public workflow. Bun is a hermetic toolchain (`rules_bun`).

```sh
# After editing package.json files:
bazel run //tools/deps:update_lock

# Live demo (Vite HMR)
bazel run //demo:dev
# → http://127.0.0.1:5191

# Typecheck + unit smoke
bazel test //:check

# Ship archive for site owners (plane B artifacts)
bazel build //:release
# → bazel-bin/release.tar  (contains agentos-search/)
```

Large guest builds use:

```text
startup --output_user_root=/mnt/workspace/search-experience-bazel
```

(in `.bazelrc`).

## Website integration

```sh
tar -xf release.tar -C /path/to/site/static/root
```

```html
<script type="module" src="/agentos-search/agentos-search.mjs"></script>
```

Optional collections:

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

## Layout

```text
src/protocol/   page, searchd, host-tool, snapshot, manifest contracts
src/host-tools/ fetch / extract / embed (effects only)
src/runtime/    bootstrap, worker client, VM boot, searchd serviceCall client
src/elements/   <mc-site-search> palette
guest/searchd/  stamped /svc/searchd (Rust mc_rust_program via @agent-os)
guest/image/    search-atlas = posix + sqlite + searchd
index/          SQLite schema
tools/          bundle + manifest helpers
third_party/    patches applied to git-pinned agent-os
```

## Product image

`//:release` packs **plane-B** `search-atlas.tar`:

| Layer | Source |
| --- | --- |
| base | `@agent-os//memcontainers/images:base` (sh, tools, git — no coreutils) |
| sqlite | product `mc_service_layer` over `@agent-os//…/sqlite:sqlite` |
| searchd | `//guest/searchd:searchd_layer` |
| dirs | `/var/searchd` |

Manifest `service.transport` is **`serviceCall`**. Guest policy is only `/svc/searchd`.
