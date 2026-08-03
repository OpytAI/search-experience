#!/usr/bin/env bash
set -euo pipefail

MANIFEST="$1"
STAGE="$2"

EXECROOT="$PWD"
BUN=""
CHDIR="."
NODE_MODULES_MARKER=""
OUT_PATH=""
OUT_REL=""
ARGS=()
SRCS=()
NODE_MODULE_LINK_SRCS=()
NODE_MODULE_LINK_DESTS=()
NODE_MODULE_ALIAS_SRCS=()
NODE_MODULE_ALIAS_DESTS=()
NODE_MODULES_ROOT=""
WORKSPACE_LINK_NAMES=()
WORKSPACE_LINK_PATHS=()

while IFS=$'\t' read -r kind value rest extra; do
  case "$kind" in
    ""|"#")
      ;;
    arg)
      ARGS+=("$value")
      ;;
    bun)
      BUN="$value"
      ;;
    chdir)
      CHDIR="$value"
      ;;
    node_modules_marker)
      NODE_MODULES_MARKER="$value"
      ;;
    node_modules_link)
      NODE_MODULE_LINK_SRCS+=("$value")
      NODE_MODULE_LINK_DESTS+=("$rest")
      ;;
    node_modules_alias)
      NODE_MODULE_ALIAS_SRCS+=("$value")
      NODE_MODULE_ALIAS_DESTS+=("$rest")
      ;;
    out_path)
      OUT_PATH="$value"
      ;;
    out_rel)
      OUT_REL="$value"
      ;;
    src)
      SRCS+=("$value")
      ;;
    workspace_link)
      WORKSPACE_LINK_NAMES+=("$value")
      WORKSPACE_LINK_PATHS+=("$rest")
      ;;
    *)
      echo "error: unknown rules_bun manifest entry '$kind'" >&2
      exit 2
      ;;
  esac
done < "$MANIFEST"

if [[ -z "$BUN" || -z "$NODE_MODULES_MARKER" ]]; then
  echo "error: rules_bun manifest missing bun or node_modules_marker" >&2
  exit 2
fi

abs_exec_path() {
  local path="$1"
  if [[ "$path" = /* ]]; then
    printf '%s\n' "$path"
  else
    printf '%s\n' "$EXECROOT/$path"
  fi
}

link_file() {
  local src="$1"
  local dst="$2"
  mkdir -p "$(dirname "$dst")"
  cp -f "$(abs_exec_path "$src")" "$dst"
}

link_workspace_package() {
  local node_modules_root="$1"
  local package_name="$2"
  local package_path="$3"
  [[ -d "$node_modules_root" ]] || return 0
  mkdir -p "$node_modules_root/$(dirname "$package_name")"
  rm -rf "$node_modules_root/$package_name"
  ln -s "$STAGE/$package_path" "$node_modules_root/$package_name"
}

link_node_modules_entry() {
  local source_path="$1"
  local dest_path="$2"
  local src="$NODE_MODULES_ROOT/$source_path"
  local dst="$STAGE/$dest_path"
  if [[ ! -e "$src" && ! -L "$src" ]]; then
    echo "error: declared node_modules link '$source_path' does not exist" >&2
    exit 2
  fi
  mkdir -p "$(dirname "$dst")"
  rm -rf "$dst"
  ln -s "$src" "$dst"
}

link_node_modules_alias() {
  local source_path="$1"
  local dest_path="$2"
  local src="$STAGE/$source_path"
  local dst="$STAGE/$dest_path"
  [[ -d "$src" ]] || return 0
  mkdir -p "$(dirname "$dst")"
  rm -rf "$dst"
  ln -s "$src" "$dst"
}

STAGE="$(abs_exec_path "$STAGE")"
rm -rf "$STAGE"
mkdir -p "$STAGE"
trap 'rm -rf "$STAGE"' EXIT

for src in "${SRCS[@]}"; do
  link_file "$src" "$STAGE/$src"
done

NODE_MODULES_ROOT="$(dirname "$(realpath "$(abs_exec_path "$NODE_MODULES_MARKER")")")"
for i in "${!NODE_MODULE_LINK_SRCS[@]}"; do
  link_node_modules_entry \
    "${NODE_MODULE_LINK_SRCS[$i]}" \
    "${NODE_MODULE_LINK_DESTS[$i]}"
done
for i in "${!NODE_MODULE_ALIAS_SRCS[@]}"; do
  link_node_modules_alias \
    "${NODE_MODULE_ALIAS_SRCS[$i]}" \
    "${NODE_MODULE_ALIAS_DESTS[$i]}"
done

for i in "${!WORKSPACE_LINK_NAMES[@]}"; do
  package_name="${WORKSPACE_LINK_NAMES[$i]}"
  package_path="${WORKSPACE_LINK_PATHS[$i]}"
  link_workspace_package "$STAGE/node_modules" "$package_name" "$package_path"
  link_workspace_package "$STAGE/$CHDIR/node_modules" "$package_name" "$package_path"
done

for owner_path in "${WORKSPACE_LINK_PATHS[@]}"; do
  for i in "${!WORKSPACE_LINK_NAMES[@]}"; do
    link_workspace_package "$STAGE/$owner_path/node_modules" "${WORKSPACE_LINK_NAMES[$i]}" "${WORKSPACE_LINK_PATHS[$i]}"
  done
done

export BUN_INSTALL_NO_TRACK=1
export DO_NOT_TRACK=1
export NO_COLOR="${NO_COLOR:-1}"

cd "$STAGE/$CHDIR"
"$(abs_exec_path "$BUN")" "${ARGS[@]}"

if [[ "$OUT_REL" == "__stamp__" ]]; then
  mkdir -p "$(dirname "$(abs_exec_path "$OUT_PATH")")"
  printf "ok\n" > "$(abs_exec_path "$OUT_PATH")"
elif [[ -n "$OUT_PATH" ]]; then
  rm -rf "$(abs_exec_path "$OUT_PATH")"
  mkdir -p "$(dirname "$(abs_exec_path "$OUT_PATH")")"
  mv "$STAGE/$CHDIR/$OUT_REL" "$(abs_exec_path "$OUT_PATH")"
fi
