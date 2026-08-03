load(":providers.bzl", "BunNodeModulesInfo", "BunPackageLinkInfo")

def _check_manifest_value(value, context):
    if "\n" in value or "\t" in value:
        fail("rules_bun manifest values may not contain tabs or newlines in {}: {}".format(context, value))

def _manifest_line(kind, value):
    _check_manifest_value(value, kind)
    return "{}\t{}".format(kind, value)

def _manifest_lines(kind, values):
    return [_manifest_line(kind, value) for value in values]

def _workspace_link_lines(workspace_links):
    lines = []
    for name in sorted(workspace_links.keys()):
        path = workspace_links[name]
        if "\n" in name or "\t" in name or "\n" in path or "\t" in path:
            fail("workspace link names and paths may not contain tabs or newlines")
        lines.append("workspace_link\t{}\t{}".format(name, path))
    return lines

def _relative_path(target_path, from_path):
    target_parts = target_path.split("/")
    from_parts = from_path.split("/")[:-1]

    common = 0
    limit = min(len(target_parts), len(from_parts))
    for i in range(limit):
        if target_parts[i] == from_parts[i]:
            common = i + 1
        else:
            break

    return "/".join([".."] * (len(from_parts) - common) + target_parts[common:])

def _node_modules_dest_path(owner, package_name):
    if owner == ".":
        return "node_modules/{}".format(package_name)
    return "{}/node_modules/{}".format(owner, package_name)

def _node_modules_root_path(owner):
    if owner == ".":
        return "node_modules"
    return "{}/node_modules".format(owner)

def _node_modules_owner_for_chdir(node_modules, chdir):
    owners = {}
    for link in node_modules.links:
        owners[link.owner] = True

    best = ""
    for owner in owners.keys():
        if owner == ".":
            continue
        if chdir == owner or chdir.startswith(owner + "/"):
            if best == "" or len(owner) > len(best):
                best = owner

    if best:
        return best
    if "." in owners:
        return "."
    return None

def _node_modules_link_lines(node_modules, chdir):
    link_rows = []
    for link in node_modules.links:
        _check_manifest_value(link.owner, "node_modules link owner")
        _check_manifest_value(link.package_name, "node_modules link package")
        source_path = link.link_path
        dest_path = _node_modules_dest_path(link.owner, link.package_name)
        _check_manifest_value(source_path, "node_modules link source")
        _check_manifest_value(dest_path, "node_modules link destination")
        link_rows.append((source_path, dest_path))

    lines = [
        "node_modules_link\t{}\t{}".format(source_path, dest_path)
        for source_path, dest_path in sorted(link_rows)
    ]

    owner = _node_modules_owner_for_chdir(node_modules, chdir)
    if owner and owner != chdir:
        source_path = _node_modules_root_path(owner)
        dest_path = _node_modules_root_path(chdir)
        _check_manifest_value(source_path, "node_modules alias source")
        _check_manifest_value(dest_path, "node_modules alias destination")
        lines.append("node_modules_alias\t{}\t{}".format(source_path, dest_path))

    return lines

def _source_paths(files, short_paths):
    if short_paths:
        return [f.short_path for f in files]
    return [f.path for f in files]

def _runtime_manifest_content(
        *,
        bun,
        chdir,
        fixed_args,
        live_workspace,
        node_modules,
        srcs,
        workspace_links,
        workspace_roots):
    lines = [
        _manifest_line("bun", bun.short_path),
        _manifest_line("chdir", chdir),
        _manifest_line("live_workspace", "1" if live_workspace else "0"),
        _manifest_line("node_modules_marker", node_modules.root_marker.short_path),
    ]
    lines.extend(_manifest_lines("arg", fixed_args))
    lines.extend(_node_modules_link_lines(node_modules, chdir))
    lines.extend(_manifest_lines("src", _source_paths(srcs, short_paths = True)))
    lines.extend(_manifest_lines("workspace_root", workspace_roots))
    lines.extend(_workspace_link_lines(workspace_links))
    return "\n".join(lines) + "\n"

def _action_manifest_content(
        *,
        bun,
        chdir,
        fixed_args,
        node_modules,
        out_path,
        out_rel,
        srcs,
        workspace_links):
    lines = [
        _manifest_line("bun", bun.path),
        _manifest_line("chdir", chdir),
        _manifest_line("node_modules_marker", node_modules.root_marker.path),
        _manifest_line("out_path", out_path),
        _manifest_line("out_rel", out_rel),
    ]
    lines.extend(_manifest_lines("arg", fixed_args))
    lines.extend(_node_modules_link_lines(node_modules, chdir))
    lines.extend(_manifest_lines("src", _source_paths(srcs, short_paths = False)))
    lines.extend(_workspace_link_lines(workspace_links))
    return "\n".join(lines) + "\n"

def _runfiles_launcher(ctx, *, live_workspace):
    bun = ctx.toolchains["@rules_bun//bun:toolchain_type"].buninfo.bun
    node_modules = ctx.attr.node_modules[BunNodeModulesInfo]
    manifest = ctx.actions.declare_file(ctx.label.name + ".rules_bun_manifest")
    ctx.actions.write(
        manifest,
        _runtime_manifest_content(
            bun = bun,
            chdir = ctx.attr.chdir,
            fixed_args = ctx.attr.fixed_args,
            live_workspace = live_workspace,
            node_modules = node_modules,
            srcs = ctx.files.srcs,
            workspace_links = ctx.attr.workspace_links,
            workspace_roots = ctx.attr.workspace_roots,
        ),
    )

    launcher = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.expand_template(
        output = launcher,
        template = ctx.file._launcher_template,
        substitutions = {
            "{{manifest_short_path}}": manifest.short_path,
            "{{runner_short_path}}": ctx.executable._runfiles_runner.short_path,
        },
        is_executable = True,
    )

    runfiles = ctx.runfiles(files = [
        bun,
        ctx.executable._runfiles_runner,
        manifest,
        node_modules.root_marker,
    ] + [link.link_file for link in node_modules.links] + ctx.files.srcs)

    return [DefaultInfo(executable = launcher, runfiles = runfiles)]

def _bun_package_link_impl(ctx):
    link_output_path = ".rules_bun_links/{}/node_modules/{}".format(
        "_root" if ctx.attr.owner == "." else ctx.attr.owner,
        ctx.attr.package_name,
    )
    link_file = ctx.actions.declare_symlink(link_output_path)
    source_link_path = "{}/{}".format(ctx.file.root_marker.dirname, ctx.attr.link_path)
    relative_target = _relative_path(source_link_path, link_file.path)
    # Bazel 8+: actions.symlink no longer accepts target_type. Directory vs file
    # is inferred from the target path; declare_symlink already marks the output.
    ctx.actions.symlink(
        output = link_file,
        target_path = relative_target,
    )

    return [
        DefaultInfo(files = depset([ctx.file.root_marker, link_file])),
        BunPackageLinkInfo(
            link_file = link_file,
            link_path = ctx.attr.link_path,
            owner = ctx.attr.owner,
            package_name = ctx.attr.package_name,
            root_marker = ctx.file.root_marker,
        ),
    ]

bun_package_link = rule(
    implementation = _bun_package_link_impl,
    attrs = {
        "link_path": attr.string(mandatory = True),
        "owner": attr.string(mandatory = True),
        "package_name": attr.string(mandatory = True),
        "root_marker": attr.label(allow_single_file = True, mandatory = True),
    },
    provides = [BunPackageLinkInfo],
    doc = "Declare one package or binary link in a generated Bun node_modules tree.",
)

def _bun_node_modules_impl(ctx):
    links = [dep[BunPackageLinkInfo] for dep in ctx.attr.direct_deps]
    link_files = [link.link_file for link in links]

    return [
        DefaultInfo(
            files = depset([ctx.file.root_marker] + link_files),
            runfiles = ctx.runfiles(files = [ctx.file.root_marker] + link_files),
        ),
        BunNodeModulesInfo(
            links = links,
            root_marker = ctx.file.root_marker,
        ),
    ]

bun_node_modules = rule(
    implementation = _bun_node_modules_impl,
    attrs = {
        "direct_deps": attr.label_list(providers = [BunPackageLinkInfo], default = []),
        "root_marker": attr.label(allow_single_file = True, mandatory = True),
    },
    provides = [BunNodeModulesInfo],
    doc = "Aggregate declared Bun package links for an action.",
)

def _bun_run_binary_impl(ctx):
    bun = ctx.toolchains["@rules_bun//bun:toolchain_type"].buninfo.bun
    node_modules = ctx.attr.node_modules[BunNodeModulesInfo]

    if ctx.attr.out_dir:
        out = ctx.actions.declare_directory(ctx.attr.out_dir)
        out_rel = ctx.attr.out_dir
    else:
        out = ctx.actions.declare_file(ctx.label.name + ".stamp")
        out_rel = "__stamp__"

    stage_path = "{}/{}.rules_bun_scratch".format(out.dirname, ctx.label.name)
    manifest = ctx.actions.declare_file(ctx.label.name + ".rules_bun_manifest")
    ctx.actions.write(
        manifest,
        _action_manifest_content(
            bun = bun,
            chdir = ctx.attr.chdir,
            fixed_args = ctx.attr.fixed_args,
            node_modules = node_modules,
            out_path = out.path,
            out_rel = out_rel,
            srcs = ctx.files.srcs,
            workspace_links = ctx.attr.workspace_links,
        ),
    )

    args = ctx.actions.args()
    args.add(manifest.path)
    args.add(stage_path)

    ctx.actions.run(
        executable = ctx.executable._action_runner,
        arguments = [args],
        inputs = depset(
            [bun, manifest, node_modules.root_marker] + [link.link_file for link in node_modules.links] + ctx.files.srcs,
        ),
        outputs = [out],
        env = ctx.attr.env,
        mnemonic = "BunRun",
        progress_message = "Running Bun command for {}".format(ctx.label),
    )

    return [DefaultInfo(files = depset([out]))]

bun_run_binary = rule(
    implementation = _bun_run_binary_impl,
    attrs = {
        "chdir": attr.string(default = "."),
        "env": attr.string_dict(default = {}),
        "fixed_args": attr.string_list(mandatory = True),
        "node_modules": attr.label(providers = [BunNodeModulesInfo], mandatory = True),
        "out_dir": attr.string(default = ""),
        "srcs": attr.label_list(allow_files = True, default = []),
        "workspace_links": attr.string_dict(default = {}),
        "_action_runner": attr.label(
            default = "@rules_bun//bun/private:bun_action_runner.sh",
            allow_single_file = True,
            executable = True,
            cfg = "exec",
        ),
    },
    toolchains = ["@rules_bun//bun:toolchain_type"],
)

def _bun_dev_binary_impl(ctx):
    return _runfiles_launcher(ctx, live_workspace = True)

bun_dev_binary = rule(
    implementation = _bun_dev_binary_impl,
    attrs = {
        "chdir": attr.string(default = "."),
        "fixed_args": attr.string_list(mandatory = True),
        "node_modules": attr.label(providers = [BunNodeModulesInfo], mandatory = True),
        "srcs": attr.label_list(allow_files = True, default = []),
        "workspace_links": attr.string_dict(default = {}),
        "workspace_roots": attr.string_list(default = []),
        "_launcher_template": attr.label(
            default = "@rules_bun//bun/private:bun_runfiles_launcher.sh.tpl",
            allow_single_file = True,
        ),
        "_runfiles_runner": attr.label(
            default = "@rules_bun//bun/private:bun_runfiles_runner.sh",
            allow_single_file = True,
            executable = True,
            cfg = "exec",
        ),
    },
    executable = True,
    toolchains = ["@rules_bun//bun:toolchain_type"],
)

def _bun_command_test_impl(ctx):
    return _runfiles_launcher(ctx, live_workspace = False)

bun_command_test = rule(
    implementation = _bun_command_test_impl,
    attrs = {
        "chdir": attr.string(default = "."),
        "fixed_args": attr.string_list(mandatory = True),
        "node_modules": attr.label(providers = [BunNodeModulesInfo], mandatory = True),
        "srcs": attr.label_list(allow_files = True, default = []),
        "workspace_links": attr.string_dict(default = {}),
        "workspace_roots": attr.string_list(default = []),
        "_launcher_template": attr.label(
            default = "@rules_bun//bun/private:bun_runfiles_launcher.sh.tpl",
            allow_single_file = True,
        ),
        "_runfiles_runner": attr.label(
            default = "@rules_bun//bun/private:bun_runfiles_runner.sh",
            allow_single_file = True,
            executable = True,
            cfg = "exec",
        ),
    },
    test = True,
    toolchains = ["@rules_bun//bun:toolchain_type"],
)

def _bun_update_lock_impl(ctx):
    bun = ctx.toolchains["@rules_bun//bun:toolchain_type"].buninfo.bun
    launcher = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.expand_template(
        output = launcher,
        template = ctx.file._update_lock_template,
        substitutions = {
            "{{bun_short_path}}": bun.short_path,
        },
        is_executable = True,
    )
    return [DefaultInfo(executable = launcher, runfiles = ctx.runfiles(files = [bun]))]

bun_update_lock = rule(
    implementation = _bun_update_lock_impl,
    attrs = {
        "_update_lock_template": attr.label(
            default = "@rules_bun//bun/private:bun_update_lock.sh.tpl",
            allow_single_file = True,
        ),
    },
    executable = True,
    toolchains = ["@rules_bun//bun:toolchain_type"],
)
