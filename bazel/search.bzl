"""Product wrappers around rules_bun for search-experience."""

load("@rules_bun//bun:defs.bzl", "bun_command_test", "bun_dev_binary", "bun_run_binary")

SEARCH_NODE_MODULES_BY_OWNER = {
    ".": "@js_deps//:node_modules",
    "docs": "@js_deps//:docs_node_modules",
}

SEARCH_SOURCE_TARGETS = ["//:all_sources"]

SEARCH_WORKSPACE_LINKS = {}

SEARCH_WORKSPACE_ROOTS = [
    "src",
    "docs",
    "index",
    "tools",
    "test",
    "guest",
    "package.json",
    "tsconfig.json",
    "bunfig.toml",
]

def _node_modules_for_chdir(chdir):
    best_owner = "."
    for owner in SEARCH_NODE_MODULES_BY_OWNER.keys():
        if owner == ".":
            continue
        if chdir == owner or chdir.startswith(owner + "/"):
            if best_owner == "." or len(owner) > len(best_owner):
                best_owner = owner
    return SEARCH_NODE_MODULES_BY_OWNER[best_owner]

def search_typecheck(name, chdir = ".", tsconfig = "tsconfig.json", srcs = SEARCH_SOURCE_TARGETS, **kwargs):
    bun_command_test(
        name = name,
        fixed_args = [
            "node_modules/.bin/tsc",
            "-p",
            tsconfig,
            "--noEmit",
            "--incremental",
            "false",
        ],
        chdir = chdir,
        node_modules = _node_modules_for_chdir(chdir),
        srcs = srcs,
        workspace_links = SEARCH_WORKSPACE_LINKS,
        **kwargs
    )

def search_dev_binary(name, chdir, fixed_args, srcs = SEARCH_SOURCE_TARGETS, **kwargs):
    bun_dev_binary(
        name = name,
        chdir = chdir,
        fixed_args = fixed_args,
        node_modules = _node_modules_for_chdir(chdir),
        srcs = srcs,
        workspace_links = SEARCH_WORKSPACE_LINKS,
        workspace_roots = SEARCH_WORKSPACE_ROOTS,
        **kwargs
    )

def search_build_binary(name, chdir, fixed_args, out_dir, srcs = SEARCH_SOURCE_TARGETS, **kwargs):
    bun_run_binary(
        name = name,
        chdir = chdir,
        fixed_args = fixed_args,
        node_modules = _node_modules_for_chdir(chdir),
        out_dir = out_dir,
        srcs = srcs,
        workspace_links = SEARCH_WORKSPACE_LINKS,
        **kwargs
    )

def search_command_test(name, chdir = ".", fixed_args = [], srcs = SEARCH_SOURCE_TARGETS, **kwargs):
    bun_command_test(
        name = name,
        fixed_args = fixed_args,
        chdir = chdir,
        node_modules = _node_modules_for_chdir(chdir),
        srcs = srcs,
        workspace_links = SEARCH_WORKSPACE_LINKS,
        **kwargs
    )
