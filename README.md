# search-experience

Copy-and-import site search built on **AgentOS**, developed in its own Bazel
repository. Platform runtime comes from AgentOS **GitHub releases**; product UI,
workers, schema, and packaging live here. Guest services (`searchd`) use the
AgentOS **build graph** in a sibling checkout — see
[`guest/README.md`](guest/README.md).

## Developer workflow

Bazel is the only public workflow. Bun is a hermetic toolchain and lockfile
format (`rules_bun`); do not run package-manager install commands as a normal
dev step, and do not put `scripts` in `package.json`.

```sh
# After editing package.json files:
bazel run //tools/deps:update_lock

# Live demo (Vite HMR via rules_bun live_workspace)
bazel run //demo:dev
# → http://127.0.0.1:5191

# Typecheck + unit smoke
bazel test //:check

# Ship archive for site owners
bazel build //:release
# → bazel-bin/release.tar  (contains agentos-search/)
```

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
src/           product host TypeScript
demo/          Vite demo (bazel run //demo:dev)
index/         SQLite schema
guest/         AgentOS build-graph guest (searchd)
tools/         bundle + manifest helpers
bazel/         search.bzl + vendored rules_bun
```
