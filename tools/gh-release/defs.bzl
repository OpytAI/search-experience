"""gh_release — `bazel run` a GitHub release from the build graph (REST API, no `gh` CLI).

A release is a side-effecting DEPLOY, not a hermetic build: it talks to api.github.com +
uploads.github.com over HTTPS. So it is a `bazel run` target (client env, network) wrapping
publish.mjs under the pinned Bun toolchain.

Assets are ordinary graph outputs. Each rides in as a runfile; the rule hands the tool a
name→short_path map via MC_RELEASE_ASSETS so the uploaded bytes cannot drift from the data-deps.

Usage:
    load("//tools/gh-release:defs.bzl", "gh_release")

    gh_release(
        name = "publish",
        repo = "OpytAI/search-experience",
        assets = {
            "//:release": "release.tar",
        },
    )

    GITHUB_TOKEN=... bazel run //tools/gh-release:publish -- --tag v0.1.0 --notes-file NOTES.md [--draft]
    bazel run //tools/gh-release:publish -- --tag v0.1.0 --notes "..." --dry-run
"""

_LAUNCHER_TEMPLATE = """#!/usr/bin/env bash
set -euo pipefail

# Runfiles resolution (bazel run and direct binary under .runfiles).
if [[ -z "${RUNFILES_DIR:-}" ]]; then
  if [[ -d "${0}.runfiles" ]]; then
    RUNFILES_DIR="${0}.runfiles"
  elif [[ -d "$(dirname "$0")/../_main" ]]; then
    RUNFILES_DIR="$(cd "$(dirname "$0")/.." && pwd)"
  fi
fi
export RUNFILES_DIR="${RUNFILES_DIR:-}"

rlocation() {
  local path="$1"
  local candidate
  for candidate in \\
    "${RUNFILES_DIR}/_main/${path}" \\
    "${RUNFILES_DIR}/${path}" \\
    "${RUNFILES_DIR}/search-experience/${path}"
  do
    if [[ -e "${candidate}" ]]; then
      printf '%s\\n' "${candidate}"
      return 0
    fi
  done
  return 1
}

BUN="$(rlocation "@@BUN_SHORT_PATH@@" || true)"
if [[ -z "${BUN}" || ! -x "${BUN}" ]]; then
  echo "publish: could not find bun at @@BUN_SHORT_PATH@@ under RUNFILES_DIR=${RUNFILES_DIR}" >&2
  exit 2
fi

PUBLISH="$(rlocation "@@ENTRY_SHORT_PATH@@" || true)"
if [[ -z "${PUBLISH}" || ! -f "${PUBLISH}" ]]; then
  echo "publish: could not find publish.mjs at @@ENTRY_SHORT_PATH@@ under RUNFILES_DIR=${RUNFILES_DIR}" >&2
  exit 2
fi

export MC_RELEASE_REPO='@@REPO@@'
export MC_RELEASE_ASSETS='@@ASSETS_JSON@@'
export RUNFILES_DIR

exec "${BUN}" "${PUBLISH}" "$@"
"""

def _gh_release_impl(ctx):
    bun = ctx.toolchains["@rules_bun//bun:toolchain_type"].buninfo.bun
    entry = ctx.file.entry_point

    asset_map = {}
    runfiles_list = [bun, entry]

    for target, filename in ctx.attr.assets.items():
        files = target.files.to_list()
        if len(files) != 1:
            fail(
                "gh_release asset %s must produce exactly one file, got %d" % (
                    target.label,
                    len(files),
                ),
            )
        f = files[0]
        asset_map[filename] = f.short_path
        runfiles_list.append(f)

    # JSON with short_paths; publish.mjs resolves under RUNFILES_DIR / _main / workspace name.
    assets_json = json.encode(asset_map)

    # Escape for single-quoted shell assignment.
    assets_json_shell = assets_json.replace("'", "'\"'\"'")
    repo_shell = ctx.attr.repo.replace("'", "'\"'\"'")

    launcher = ctx.actions.declare_file(ctx.label.name + ".sh")
    content = (
        _LAUNCHER_TEMPLATE
            .replace("@@BUN_SHORT_PATH@@", bun.short_path)
            .replace("@@ENTRY_SHORT_PATH@@", entry.short_path)
            .replace("@@REPO@@", repo_shell)
            .replace("@@ASSETS_JSON@@", assets_json_shell)
    )
    ctx.actions.write(
        output = launcher,
        is_executable = True,
        content = content,
    )

    runfiles = ctx.runfiles(files = runfiles_list)
    for target in ctx.attr.assets.keys():
        di = target[DefaultInfo]
        runfiles = runfiles.merge(di.default_runfiles)

    return [
        DefaultInfo(
            executable = launcher,
            runfiles = runfiles,
        ),
    ]

gh_release = rule(
    implementation = _gh_release_impl,
    doc = "A `bazel run` GitHub-release publisher over the REST API (Bun + publish.mjs).",
    attrs = {
        "repo": attr.string(
            mandatory = True,
            doc = 'GitHub "owner/repo" the release is cut on.',
        ),
        "assets": attr.label_keyed_string_dict(
            allow_files = True,
            mandatory = True,
            doc = "Map of Bazel label → upload filename. Each label must produce exactly one file.",
        ),
        "entry_point": attr.label(
            allow_single_file = True,
            default = Label("//tools/gh-release:publish.mjs"),
            doc = "The Bun/Node uploader script.",
        ),
    },
    executable = True,
    toolchains = ["@rules_bun//bun:toolchain_type"],
)
