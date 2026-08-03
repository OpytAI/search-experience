# guest/image — product guest image (`search-atlas`)

Plane **B** only: built from `@agent-os//…` labels plus `//guest/searchd`.

## Composition

| Layer | Source | Role |
|-------|--------|------|
| `base` | `@agent-os//memcontainers/images:base` | `/bin/sh`, pkgfsd, `/svc/tools`, adapters, git |
| `sqlite_layer` | product `mc_service_layer` over public sqlite | `/svc/sqlite` (FTS5) |
| `searchd_layer` | `//guest/searchd:searchd_layer` | `/svc/searchd` — product policy authority |
| `product_dirs` | local | `/var/searchd` for index + candidate DBs |

## Why not stock `atlas` / posix / minimal?

Stock `atlas` = `loom` (posix + **Luau**) + sqlite. Production path is
**serviceCall-only** with `/svc/searchd` as sole policy authority — no Luau transport.

`posix` / `minimal` only add coreutils applets on top of `base`. Searchd talks
sqlite and host tools via services; it does not shell out to `ls`/`awk`/….
So the honest substrate is **`base` + sqlite + searchd**.

## Build

```bash
bazel build //guest/image:search_atlas
# → bazel-bin/guest/image/search_atlas.tar
```
