# searchd (guest authority)

`searchd` is the sole product authority for crawl planning, schema/journals,
FTS5/VANN retrieval, fusion, generation validation, and promotion.

Built **in this repo** with `@agent-os//bazel:mc_program.bzl` — not inside the
AgentOS monorepo, and not downloaded as a prebuilt binary.

## Protocol

- Machine-readable: [`searchd.protocol.json`](searchd.protocol.json)
- TypeScript mirror: `src/protocol/searchd.ts`
- Transport: **`vm.serviceCall("searchd", requestBytes)` only**

## Host tools (effects only)

| Address | Role |
| --- | --- |
| `host.org.main.search.fetch` | Bounded same-origin fetch |
| `host.org.main.search.extract` | HTML → title/blocks/links |
| `host.org.main.search.embed.batch` | Mixedbread UINT8 batch embed |

## Build

```sh
bazel build //guest/searchd:searchd
# → bazel-bin/guest/searchd/searchd.wasm

bazel build //guest/image:search_atlas
# base + /svc/sqlite + /svc/searchd → search_atlas.tar
```

| Target | Role |
| --- | --- |
| `//guest/searchd:searchd` | `mc_rust_program` service=`searchd` |
| `//guest/searchd:searchd_layer` | `mc_service_layer` (eager) |
| `//guest/image:search_atlas` | product image for release |

## Schema

SQL schema is product-owned: `../../index/schema.sql` (packaged into release).

## Guest filesystem paths

| Path | Role |
| --- | --- |
| `/var/searchd/` | Product state root (survives MCSN snapshots) |
| `/var/searchd/index.db` | **Always** the active SQLite index (queries forever) |
| `/var/searchd/candidate.db` | Refresh write target only; promote copies → index.db then wipes |
| `/var/searchd/state.json` | Journals, queues, generation metadata |

### Dual-DB refresh

1. Queries always open `index.db`.
2. Cold first index writes `index.db` directly.
3. `refresh` rebuilds `candidate.db` only.
4. Promote requires non-empty candidate pages **and** chunks; copies candidate → index; wipes candidate.
5. Next refresh uses a fresh `candidate.db`.

