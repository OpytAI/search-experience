#!/usr/bin/env bash
# bazel run //docs:dev — build //:release, stage agentos-search under docs/public (gitignored), start Vite.
set -euo pipefail

# --- runfiles resolution (works for bazel run and direct binary under .runfiles) ---
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
  for candidate in \
    "${RUNFILES_DIR}/_main/${path}" \
    "${RUNFILES_DIR}/${path}" \
    "${RUNFILES_DIR}/search-experience/${path}"
  do
    if [[ -e "${candidate}" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done
  return 1
}

if [[ -z "${BUILD_WORKSPACE_DIRECTORY:-}" ]]; then
  echo "error: //docs:dev must be started with 'bazel run //docs:dev'" >&2
  exit 2
fi

RELEASE_TAR="$(rlocation "release.tar" || true)"
if [[ -z "${RELEASE_TAR}" ]]; then
  echo "error: could not find //:release (release.tar) in runfiles" >&2
  exit 2
fi

VITE_LAUNCHER="$(rlocation "docs/_dev_vite.sh" || rlocation "docs/_dev_vite" || true)"
if [[ -z "${VITE_LAUNCHER}" || ! -x "${VITE_LAUNCHER}" ]]; then
  # Fallback: same package next to this script in runfiles
  for candidate in \
    "$(dirname "$0")/_dev_vite.sh" \
    "$(dirname "$0")/_dev_vite"
  do
    if [[ -x "${candidate}" ]]; then
      VITE_LAUNCHER="${candidate}"
      break
    fi
  done
fi
if [[ -z "${VITE_LAUNCHER:-}" || ! -x "${VITE_LAUNCHER}" ]]; then
  echo "error: could not find docs/_dev_vite launcher in runfiles" >&2
  exit 2
fi

PUBLIC_DIR="${BUILD_WORKSPACE_DIRECTORY}/docs/public"
STAGE_DIR="${PUBLIC_DIR}/agentos-search"

# Always refresh from the release this run depends on (Bazel rebuilds //:release when inputs change).
rm -rf "${STAGE_DIR}"
mkdir -p "${PUBLIC_DIR}"
tar -xf "${RELEASE_TAR}" -C "${PUBLIC_DIR}"
if [[ ! -d "${STAGE_DIR}" ]]; then
  echo "error: release.tar did not unpack docs/public/agentos-search/" >&2
  exit 2
fi

echo "[docs:dev] staged $(basename "${RELEASE_TAR}") → docs/public/agentos-search/" >&2

export RUNFILES_DIR
exec "${VITE_LAUNCHER}" "$@"
