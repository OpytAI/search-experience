BunPackageLinkInfo = provider(
    doc = "One package or .bin entry linked into a workspace package's node_modules.",
    fields = {
        "link_file": "Declared symlink artifact for this node_modules entry.",
        "link_path": "Path to the source link inside the generated dependency repository.",
        "owner": "Workspace-relative package path that owns this node_modules entry, or '.' for the root package.",
        "package_name": "Path below node_modules, such as 'vite', '@scope/pkg', or '.bin/vite'.",
        "root_marker": "Marker file at the generated dependency repository root.",
    },
)

BunNodeModulesInfo = provider(
    doc = "Bun-installed package links managed by Bazel.",
    fields = {
        "links": "List of BunPackageLinkInfo entries to link for an action.",
        "root_marker": "Marker file at the node_modules repository root.",
    },
)
