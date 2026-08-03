#!/usr/bin/env bash
set -euo pipefail

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

RUNNER="$(resolve_runfile "{{runner_short_path}}")"
MANIFEST="$(resolve_runfile "{{manifest_short_path}}")"

export RUNFILES_DIR
exec "$RUNNER" "$MANIFEST" "$@"
