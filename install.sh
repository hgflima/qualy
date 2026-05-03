#!/usr/bin/env bash
#
# qualy installer — copies (or symlinks) the harness artifacts and the CLI
# into ~/.claude/ so Claude Code can discover the /lint skill and its
# slash commands / subagents.
#
# Idempotent: re-running replaces previously installed artifacts in place.
# Defensive: refuses to remove anything outside of <target>/{skills,commands,
# agents}/lint* or <target>/skills/lint/cli.
#
# Source of truth for the layout: SPEC.md §3 + PLAN.md §Resolução do CLI.
# Decision rationale: docs/adrs/0009-install-script-distribution.md (planned).
#
# Verification anchor (PLAN §Fase 0):
#   - Running on Node < 22.6 must abort with a clear message.
#   - Running on Node ≥ 22.6 with no source dirs present must succeed,
#     reporting "skip" lines for missing categories.

set -euo pipefail

readonly MIN_NODE_MAJOR=22
readonly MIN_NODE_MINOR=6
readonly DEFAULT_TARGET="${HOME}/.claude"

readonly SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

INSTALL_MODE="copy"   # copy | symlink
TARGET_ROOT="$DEFAULT_TARGET"
DRY_RUN=0

usage() {
  cat <<EOF
qualy installer

Usage:
  ./install.sh [--dev] [--target <path>] [--dry-run]
  ./install.sh --help

Modes:
  (default) copy        Copy artifacts into <target>/. Safer for users.
  --dev                 Symlink artifacts into <target>/. Source edits
                        take effect immediately. Recommended when working
                        on qualy itself.

Flags:
  --target <path>       Install root (default: \$HOME/.claude).
  --dry-run             Print what would happen without touching the FS.
  --help, -h            Show this message and exit.

Requires Node >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} (for --experimental-strip-types).
EOF
}

log() {
  printf '[qualy/install] %s\n' "$*"
}

err() {
  printf '[qualy/install] %s\n' "$*" >&2
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dev) INSTALL_MODE="symlink"; shift ;;
      --target)
        if [[ $# -lt 2 ]]; then err "--target requires a path"; exit 2; fi
        TARGET_ROOT="$2"; shift 2 ;;
      --dry-run) DRY_RUN=1; shift ;;
      --help|-h) usage; exit 0 ;;
      *)
        err "unknown flag: $1"
        usage >&2
        exit 2 ;;
    esac
  done
}

require_node() {
  if ! command -v node >/dev/null 2>&1; then
    err "node not found in PATH. Install Node >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} (https://nodejs.org/) and retry."
    exit 1
  fi

  local raw major minor
  raw=$(node --version 2>/dev/null || true)
  raw="${raw#v}"
  if [[ -z "$raw" ]]; then
    err "could not read Node version (\`node --version\` returned empty)."
    exit 1
  fi

  major="${raw%%.*}"
  local rest="${raw#*.}"
  minor="${rest%%.*}"

  if ! [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]]; then
    err "could not parse Node version '$raw' (expected MAJOR.MINOR.PATCH)."
    exit 1
  fi

  if (( major < MIN_NODE_MAJOR )) || { (( major == MIN_NODE_MAJOR )) && (( minor < MIN_NODE_MINOR )); }; then
    err "Node $raw found, but qualy requires >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}."
    err "Reason: the CLI is executed with --experimental-strip-types (no build step)."
    err "Upgrade Node and retry. See docs/adrs/0007-runtime-ts-strip-types.md for context."
    exit 1
  fi

  log "node $raw OK (>= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR})."
}

# Validate that $1 is safe to remove. A safe path must be inside $TARGET_ROOT
# and must not be empty, '/', '$HOME', '$HOME/', or '$TARGET_ROOT' itself.
assert_safe_target() {
  local path="$1"

  if [[ -z "$path" ]]; then
    err "refusing to operate on empty path"; exit 1
  fi
  case "$path" in
    "/"|"$HOME"|"$HOME/"|"$TARGET_ROOT"|"$TARGET_ROOT/")
      err "refusing to operate on protected path: $path"; exit 1 ;;
  esac
  case "$path" in
    "$TARGET_ROOT"/*) : ;;
    *)
      err "refusing to operate on path outside target ($TARGET_ROOT): $path"
      exit 1 ;;
  esac
}

# Replace $dest with a copy or symlink of $src, depending on $INSTALL_MODE.
# Idempotent: existing $dest (file, dir, or correct symlink) is replaced.
install_path() {
  local src="$1" dest="$2"

  assert_safe_target "$dest"

  if [[ "$INSTALL_MODE" == "symlink" ]]; then
    if [[ -L "$dest" ]]; then
      local current
      current=$(readlink "$dest")
      if [[ "$current" == "$src" ]]; then
        log "ok (symlink already points to source): $dest"
        return 0
      fi
    fi
    if (( DRY_RUN )); then
      log "(dry-run) symlink $dest -> $src"
      return 0
    fi
    rm -rf -- "$dest"
    mkdir -p -- "$(dirname "$dest")"
    ln -s "$src" "$dest"
    log "symlinked $dest -> $src"
  else
    if (( DRY_RUN )); then
      log "(dry-run) copy $src -> $dest"
      return 0
    fi
    rm -rf -- "$dest"
    mkdir -p -- "$(dirname "$dest")"
    cp -R -- "$src" "$dest"
    log "copied $src -> $dest"
  fi
}

# Install every immediate sub-directory of <source>/$category into
# <target>/$category/<name>. Used for skills/ and commands/ (the SPEC layout
# scopes everything under a per-skill subdir, e.g. skills/lint/, commands/lint/).
install_category_subdirs() {
  local category="$1"
  local src_cat="$SOURCE_ROOT/$category"

  if [[ ! -d "$src_cat" ]]; then
    log "skip $category/ (not present in source yet)"
    return 0
  fi

  local found=0
  for sub in "$src_cat"/*/; do
    [[ -d "$sub" ]] || continue
    found=1
    local name dest
    name=$(basename "$sub")
    sub="${sub%/}"
    dest="$TARGET_ROOT/$category/$name"
    install_path "$sub" "$dest"
  done

  if (( found == 0 )); then
    log "skip $category/ (no subdirs to install yet)"
  fi
}

# Install every *.md file from agents/ into <target>/agents/<file>. Different
# pattern than skills/commands because subagents are flat .md files (SPEC §3).
install_agent_files() {
  local src_dir="$SOURCE_ROOT/agents"

  if [[ ! -d "$src_dir" ]]; then
    log "skip agents/ (not present in source yet)"
    return 0
  fi

  shopt -s nullglob
  local files=("$src_dir"/*.md)
  shopt -u nullglob

  if (( ${#files[@]} == 0 )); then
    log "skip agents/ (no .md files to install yet)"
    return 0
  fi

  for f in "${files[@]}"; do
    local name dest
    name=$(basename "$f")
    dest="$TARGET_ROOT/agents/$name"
    install_path "$f" "$dest"
  done
}

# Install cli/ inside <target>/skills/lint/cli so the resolution pattern from
# PLAN §Resolução do CLI ($CLAUDE_PLUGIN_ROOT/skills/lint/cli/src/index.ts)
# works without extra wiring.
install_cli() {
  local src="$SOURCE_ROOT/cli"

  if [[ ! -d "$src" ]]; then
    log "skip cli/ (not present in source yet)"
    return 0
  fi

  install_path "$src" "$TARGET_ROOT/skills/lint/cli"
}

main() {
  parse_args "$@"
  require_node

  log "mode=$INSTALL_MODE  source=$SOURCE_ROOT  target=$TARGET_ROOT  dry_run=$DRY_RUN"

  if (( DRY_RUN == 0 )); then
    mkdir -p -- "$TARGET_ROOT"
  fi

  install_category_subdirs "skills"
  install_category_subdirs "commands"
  install_agent_files
  install_cli

  log "done."
}

main "$@"
