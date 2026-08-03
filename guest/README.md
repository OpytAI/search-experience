# Guest programs

Product-owned guest code, compiled with AgentOS macros from the git-pinned
`@agent-os` module.

## Layout

```text
guest/
  searchd/     # stamped /svc/searchd (Rust + protocol JSON)
  image/       # search-atlas = base + sqlite layer + searchd layer
```

## Authority

- **searchd** owns crawl/index/query policy.
- Host tools only fetch, extract, and embed.
- Runtime worker is a thin adapter: boot/restore, tools, `serviceCall`, snapshots.
- Production transport is **serviceCall only** (no Luau file transport).

## Build

```sh
bazel build //guest/searchd:searchd
bazel build //guest/image:search_atlas
# → bazel-bin/guest/image/search_atlas.tar
```

## Ship path

1. Product builds `search-atlas.tar` (base + `/svc/sqlite` + `/svc/searchd`).
2. Kernel, mc-core, and catalog-compiler come from `@agent-os//…` in the same graph.
3. Runtime boots search-atlas and talks `vm.serviceCall("searchd", …)`.

Guest durable state lives under **`/var/searchd/`**. See
[`searchd/README.md`](searchd/README.md) for dual-DB paths (active vs candidate).

## Image note

Stock AgentOS `atlas` includes loom (`/bin/luau`). This product does not need Luau
in the image; search-atlas layers sqlite + searchd on **base** (no coreutils).
Nested Luau C++ under `@agent-os` can still hit include-path issues if built; see
product patch `third_party/agent-os/0003-luau-include-external-root.patch`.
