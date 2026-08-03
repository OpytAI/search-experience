DEFAULT_BUN_VERSION = "1.3.11"

_BUN_RELEASES = {
    "1.3.11": {
        "linux_x86_64": {
            "sha256": "8611ba935af886f05a6f38740a15160326c15e5d5d07adef966130b4493607ed",
            "strip_prefix": "bun-linux-x64",
            "url": "https://github.com/oven-sh/bun/releases/download/bun-v1.3.11/bun-linux-x64.zip",
        },
    },
}

def _platform(rctx):
    os_name = rctx.os.name.lower()
    arch = rctx.os.arch.lower()
    if "linux" in os_name and arch in ("x86_64", "amd64"):
        return "linux_x86_64"
    fail("rules_bun currently supports only linux_x86_64; got os={} arch={}".format(os_name, arch))

_BUN_BUILD = """\
load("@rules_bun//bun:toolchains.bzl", "bun_toolchain")

package(default_visibility = ["//visibility:public"])

exports_files(["bun"])

bun_toolchain(
    name = "toolchain",
    bun = ":bun",
)

toolchain(
    name = "toolchain_def",
    toolchain = ":toolchain",
    toolchain_type = "@rules_bun//bun:toolchain_type",
)
"""

def _bun_repository_impl(rctx):
    version = rctx.attr.version or DEFAULT_BUN_VERSION
    platform = _platform(rctx)
    release = _BUN_RELEASES.get(version, {}).get(platform)
    if not release:
        fail("No pinned Bun release for version={} platform={}".format(version, platform))

    rctx.download_and_extract(
        url = release["url"],
        sha256 = release["sha256"],
        stripPrefix = release["strip_prefix"],
    )
    rctx.file("BUILD.bazel", _BUN_BUILD)

bun_repository = repository_rule(
    implementation = _bun_repository_impl,
    attrs = {
        "version": attr.string(default = DEFAULT_BUN_VERSION),
    },
)

_JS_DEPS_BUILD_HEADER = """\
load("@rules_bun//bun:defs.bzl", "bun_node_modules", "bun_package_link")

package(default_visibility = ["//visibility:public"])
"""

_JS_DEPS_BUILD_FOOTER = """\
exports_files([
    ".rules_bun_lock_workspace_deps",
    ".rules_bun_node_modules_root",
    "bun.lock",
    "package.json",
])
"""

def _owner_target_prefix(owner):
    if owner == ".":
        return "root"
    return owner.replace("/", "_").replace("-", "_").replace(".", "_")

def _safe_target_part(value):
    return value.replace("@", "scope__").replace("/", "__").replace("-", "_").replace(".", "_").replace("+", "_")

def _link_target_name(owner, package_name):
    return "{}__{}".format(_owner_target_prefix(owner), _safe_target_part(package_name))

def _node_modules_link_path(owner, package_name):
    link_path = "node_modules/{}".format(package_name)
    if owner == ".":
        return link_path
    return "{}/{}".format(owner, link_path)

def _path_exists(rctx, path):
    return rctx.path(path).exists

def _manifest_deps(manifest):
    deps = {}
    for section in ["dependencies", "devDependencies", "optionalDependencies"]:
        for name in manifest.get(section, {}).keys():
            deps[name] = True
    return sorted(deps.keys())

def _quoted_key(line):
    parts = line.split("\"")
    if len(parts) < 3:
        return None
    return parts[1]

def _lock_workspace_deps(lock_content):
    deps_by_owner = {}
    in_workspaces = False
    current_owner = None
    current_section = None

    for raw_line in lock_content.split("\n"):
        if not in_workspaces:
            if raw_line.startswith("  \"workspaces\": {"):
                in_workspaces = True
            continue

        if current_owner == None and raw_line.startswith("  },"):
            break

        if current_section:
            if raw_line.startswith("      },"):
                current_section = None
                continue
            if raw_line.startswith("        \""):
                dep_name = _quoted_key(raw_line)
                if dep_name:
                    deps_by_owner[current_owner][dep_name] = True
            continue

        if current_owner:
            if raw_line.startswith("    },"):
                current_owner = None
                continue
            if raw_line.startswith("      \""):
                key = _quoted_key(raw_line)
                if key in ["dependencies", "devDependencies", "optionalDependencies"]:
                    current_section = key
            continue

        if raw_line.startswith("    \""):
            owner = _quoted_key(raw_line)
            if owner == None:
                continue
            if owner == "":
                owner = "."
            current_owner = owner
            deps_by_owner[owner] = {}

    result = {}
    for owner in deps_by_owner.keys():
        result[owner] = sorted(deps_by_owner[owner].keys())
    return result

def _list_diff(left, right):
    right_set = {}
    for item in right:
        right_set[item] = True

    missing = []
    for item in left:
        if item not in right_set:
            missing.append(item)
    return missing

def _validate_lock_workspace_deps(package_json_by_owner, lock_deps_by_owner):
    for owner in sorted(package_json_by_owner.keys()):
        if owner not in lock_deps_by_owner:
            fail("bun.lock is missing workspace '{}'".format(owner))

        manifest_deps = _manifest_deps(json.decode(package_json_by_owner[owner]))
        lock_deps = lock_deps_by_owner[owner]
        missing_from_lock = _list_diff(manifest_deps, lock_deps)
        extra_in_lock = _list_diff(lock_deps, manifest_deps)
        if missing_from_lock or extra_in_lock:
            fail("bun.lock workspace deps for '{}' do not match package.json. Missing from lock: [{}]. Extra in lock: [{}]".format(
                owner,
                ", ".join(missing_from_lock),
                ", ".join(extra_in_lock),
            ))

    for owner in sorted(lock_deps_by_owner.keys()):
        if owner not in package_json_by_owner:
            fail("bun.lock contains workspace '{}' but no package.json was passed to bun_deps.install".format(owner))

def _lock_workspace_deps_report(lock_deps_by_owner):
    lines = []
    for owner in sorted(lock_deps_by_owner.keys()):
        lines.append("[{}]".format(owner))
        for dep in lock_deps_by_owner[owner]:
            lines.append(dep)
        lines.append("")
    return "\n".join(lines) + "\n"

def _bin_names(rctx, owner, package_name):
    manifest_path = "{}/package.json".format(_node_modules_link_path(owner, package_name))
    if not _path_exists(rctx, manifest_path):
        return []

    manifest = json.decode(rctx.read(rctx.path(manifest_path)))
    bin_field = manifest.get("bin")
    if type(bin_field) == "string":
        bin_names = [package_name.split("/")[-1]]
    elif type(bin_field) == "dict":
        bin_names = sorted(bin_field.keys())
    else:
        bin_names = []

    return [
        bin_name
        for bin_name in bin_names
        if _path_exists(rctx, _node_modules_link_path(owner, ".bin/{}".format(bin_name)))
    ]

def _package_link_rule(owner, package_name, link_path):
    return """\
bun_package_link(
    name = "{target}",
    owner = "{owner}",
    package_name = "{package_name}",
    link_path = "{link_path}",
    root_marker = ".rules_bun_node_modules_root",
)
""".format(
        link_path = link_path,
        owner = owner,
        package_name = package_name,
        target = _link_target_name(owner, package_name),
    )

def _node_modules_rule(name, labels):
    label_lines = ["        \":{}\",".format(label) for label in sorted(labels)]
    return """\
bun_node_modules(
    name = "{name}",
    root_marker = ".rules_bun_node_modules_root",
    direct_deps = [
{deps}
    ],
)
""".format(
        deps = "\n".join(label_lines),
        name = name,
    )

def _alias_rule(name, actual):
    return """\
alias(
    name = "{name}",
    actual = ":{actual}",
)
""".format(name = name, actual = actual)

def _workspace_owner_closure(owner, lock_deps_by_owner, workspace_package_names):
    closure = {owner: True}

    # Bounded fixed point: the closure can grow at most by the number of workspace owners.
    for _unused in sorted(lock_deps_by_owner.keys()):
        for current_owner in sorted(closure.keys()):
            for dep_name in lock_deps_by_owner.get(current_owner, []):
                dep_owner = workspace_package_names.get(dep_name)
                if dep_owner:
                    closure[dep_owner] = True

    return sorted(closure.keys())

def _node_modules_labels_for_owner(owner, labels_by_owner, lock_deps_by_owner, workspace_package_names):
    labels = []
    seen = {}
    for closure_owner in _workspace_owner_closure(owner, lock_deps_by_owner, workspace_package_names):
        for label in labels_by_owner.get(closure_owner, []):
            if label not in seen:
                labels.append(label)
                seen[label] = True
    return labels

def _generated_js_deps_build(rctx, repo_name, lock_deps_by_owner, workspace_package_names):
    rules = [_JS_DEPS_BUILD_HEADER]
    labels_by_owner = {}
    generated_labels = {}

    for owner in sorted(lock_deps_by_owner.keys()):
        labels_by_owner[owner] = []
        for package_name in lock_deps_by_owner[owner]:
            if package_name in workspace_package_names:
                continue

            link_path = _node_modules_link_path(owner, package_name)
            if not _path_exists(rctx, link_path):
                continue

            label = _link_target_name(owner, package_name)
            if label not in generated_labels:
                rules.append(_package_link_rule(owner, package_name, link_path))
                generated_labels[label] = True
            labels_by_owner[owner].append(label)

            for bin_name in _bin_names(rctx, owner, package_name):
                bin_package_name = ".bin/{}".format(bin_name)
                bin_link_path = _node_modules_link_path(owner, bin_package_name)
                bin_label = _link_target_name(owner, bin_package_name)
                if bin_label not in generated_labels:
                    rules.append(_package_link_rule(owner, bin_package_name, bin_link_path))
                    generated_labels[bin_label] = True
                labels_by_owner[owner].append(bin_label)

    rules.append(_node_modules_rule(
        "node_modules",
        _node_modules_labels_for_owner(".", labels_by_owner, lock_deps_by_owner, workspace_package_names),
    ))
    rules.append(_alias_rule(repo_name, "node_modules"))

    for owner in sorted(labels_by_owner.keys()):
        if owner == ".":
            continue
        rules.append(_node_modules_rule(
            "{}_node_modules".format(_owner_target_prefix(owner)),
            _node_modules_labels_for_owner(owner, labels_by_owner, lock_deps_by_owner, workspace_package_names),
        ))

    rules.append(_JS_DEPS_BUILD_FOOTER)
    return "\n".join(rules)

def _copy_label(rctx, label, dest = None):
    dest = dest or (label.package + "/" + label.name if label.package else label.name)
    content = rctx.read(rctx.path(label))
    rctx.file(dest, content)
    return content

def _bun_install_impl(rctx):
    version = rctx.attr.bun_version or DEFAULT_BUN_VERSION
    platform = _platform(rctx)
    release = _BUN_RELEASES.get(version, {}).get(platform)
    if not release:
        fail("No pinned Bun release for version={} platform={}".format(version, platform))

    rctx.download_and_extract(
        url = release["url"],
        sha256 = release["sha256"],
        stripPrefix = release["strip_prefix"],
        output = ".bun-toolchain",
    )

    marker_parts = []
    package_json_by_owner = {}

    package_json_by_owner["."] = _copy_label(rctx, rctx.attr.package_json, "package.json")
    marker_parts.append(package_json_by_owner["."])
    lock_content = _copy_label(rctx, rctx.attr.lock, rctx.attr.lock.name)
    marker_parts.append(lock_content)
    if rctx.attr.bunfig:
        marker_parts.append(_copy_label(rctx, rctx.attr.bunfig, rctx.attr.bunfig.name))
    for workspace_file in rctx.attr.workspace_files:
        content = _copy_label(rctx, workspace_file)
        marker_parts.append(content)
        if workspace_file.name == "package.json":
            package_json_by_owner[workspace_file.package] = content
    rctx.file(".rules_bun_node_modules_root", "\n--- rules_bun input ---\n".join(marker_parts))

    lock_deps_by_owner = _lock_workspace_deps(lock_content)
    _validate_lock_workspace_deps(package_json_by_owner, lock_deps_by_owner)
    rctx.file(".rules_bun_lock_workspace_deps", _lock_workspace_deps_report(lock_deps_by_owner))

    args = [
        rctx.path(".bun-toolchain/bun"),
        "install",
        "--frozen-lockfile",
        "--no-progress",
    ]
    if rctx.attr.ignore_scripts:
        args.append("--ignore-scripts")
    for dep in rctx.attr.trusted_dependencies:
        args.extend(["--trust", dep])
    args.extend(rctx.attr.install_flags)

    result = rctx.execute(
        args,
        environment = {
            "BUN_INSTALL_CACHE_DIR": str(rctx.path(".bun-cache")),
            "BUN_INSTALL_NO_TRACK": "1",
            "DO_NOT_TRACK": "1",
            "HOME": str(rctx.path(".home")),
            "NO_COLOR": "1",
        },
        quiet = rctx.attr.quiet,
        timeout = rctx.attr.timeout,
    )
    if result.return_code:
        fail("bun install failed for {}.\nSTDOUT:\n{}\nSTDERR:\n{}".format(
            rctx.name,
            result.stdout,
            result.stderr,
        ))

    workspace_package_names = {}
    for owner, content in package_json_by_owner.items():
        if owner == ".":
            continue
        package_name = json.decode(content).get("name")
        if package_name:
            workspace_package_names[package_name] = owner

    rctx.file("BUILD.bazel", _generated_js_deps_build(
        rctx,
        rctx.name,
        lock_deps_by_owner,
        workspace_package_names,
    ))

bun_install = repository_rule(
    implementation = _bun_install_impl,
    attrs = {
        "bun_version": attr.string(default = ""),
        "bunfig": attr.label(allow_single_file = True),
        "ignore_scripts": attr.bool(default = True),
        "install_flags": attr.string_list(default = []),
        "lock": attr.label(allow_single_file = True, mandatory = True),
        "package_json": attr.label(allow_single_file = True, mandatory = True),
        "quiet": attr.bool(default = True),
        "timeout": attr.int(default = 600),
        "trusted_dependencies": attr.string_list(default = []),
        "workspace_files": attr.label_list(allow_files = True, default = []),
    },
)
