# Guest build graph (AgentOS plane B)

AgentOS is a **git-pinned Bazel module** (`bazel_dep` + `git_override` in the
product `MODULE.bazel`). Guest compilation and runtime artifacts are labels
under `@agent-os//…` plus product-owned `//guest/...`.

There is **no** plane-A (GitHub release `http_file`) path for kernel/image/mc-core.

## Layout

```text
guest/
  searchd/     # stamped /svc/searchd (Rust + protocol JSON)
  image/       # search-atlas = base + sqlite layer + searchd layer
```

## Authority rule

- **searchd** owns crawl/index/query policy.
- Host tools only fetch, extract, and embed.
- Runtime worker is a thin adapter: boot/restore, tools, `serviceCall`, snapshots.
- **No Luau production transport** — serviceCall only.

## Build

```sh
bazel build //guest/searchd:searchd
bazel build //guest/image:search_atlas
# → bazel-bin/guest/image/search_atlas.tar
```

## Ship path

1. Product builds `search-atlas.tar` (base + `/svc/sqlite` + `/svc/searchd`).
2. Plane-B kernel, mc-core, catalog-compiler from `@agent-os//…`.
3. Runtime boots search-atlas and talks `vm.serviceCall("searchd", …)`.

Guest durable state lives under **`/var/searchd/`** (product-canonical). See
[`searchd/README.md`](searchd/README.md) for the path table (active vs candidate DB).

## Nested Luau note

Stock AgentOS `atlas` includes loom (`/bin/luau`). Nested compilation of Luau
under `@agent-os` can hit Zig `CacheCheckFailed` when main-repo-relative
`-include` paths do not resolve (see patch `0003-luau-include-external-root`).
This product does not need Luau in the image; search-atlas layers sqlite +
searchd on **base** (no coreutils) instead.
