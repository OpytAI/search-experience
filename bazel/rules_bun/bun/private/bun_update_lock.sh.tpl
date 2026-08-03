#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${BUILD_WORKSPACE_DIRECTORY:-}" ]]; then
  echo "error: run this target with bazel run" >&2
  exit 1
fi

RUNFILES_DIR="${RUNFILES_DIR:-$0.runfiles}"

resolve_runfile() {
  local path="$1"
  if [[ "$path" = /* ]]; then
    printf '%s\n' "$path"
  elif [[ -e "$RUNFILES_DIR/_main/$path" ]]; then
    printf '%s\n' "$RUNFILES_DIR/_main/$path"
  else
    printf '%s\n' "$RUNFILES_DIR/$path"
  fi
}

cd "$BUILD_WORKSPACE_DIRECTORY"
exec "$(resolve_runfile "{{bun_short_path}}")" install --lockfile-only
