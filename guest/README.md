# Guest build graph (AgentOS plane B)

This directory is reserved for the **resident search guest** path. Platform
runtime artifacts (kernel, base atlas, `mc-core.mjs`) continue to be consumed
from **AgentOS GitHub releases** via `http_file` pins in the product
`MODULE.bazel`. Guest compilation needs the full AgentOS build graph and is
**not** performed as a thin nested `bazel_dep` inside this product module.

## Layout

```text
guest/
  searchd/     # mc_rust_program (or equivalent) service = "searchd"
  image/       # overlay: release atlas + searchd layer → search-atlas.tar
```

## Build workflow (sibling AgentOS)

1. Check out AgentOS next to this repo (for example
   `../agent-os/agent-os-search`).
2. Author `searchd` with AgentOS macros (`bazel/mc_program.bzl`, service stamp /
   attest, `mc_service_layer`).
3. Build a product image overlay on stock **atlas** (do not invent a second
   global AgentOS flavor).
4. Publish or copy `search-atlas.tar` + sha256 into this product’s pins
   (`http_file` or CI artifact URL).
5. Point `//:release` at the product image instead of stock `atlas.tar`.
6. Host runtime worker talks to `vm.serviceCall("searchd", …)`.

Until `searchd` ships, the product uses **stock atlas** from the AgentOS release
tag pinned in `MODULE.bazel`.
