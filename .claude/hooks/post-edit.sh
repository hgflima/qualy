#!/usr/bin/env bash
# qualy · PostToolUse hook · oxlint fast tier
#
# Triggered by Claude Code after Write/Edit/MultiEdit. Filters
# $CLAUDE_FILE_PATHS to oxc-supported extensions and runs the fast oxlint
# preset on the survivors. No-op when the env var is empty, no path matches,
# or oxlint is not installed — must never block the agent's edit loop.
#
# Contract (SPEC §4 templates):
#   - shebang: /usr/bin/env bash
#   - strict mode: set -euo pipefail
#   - extension filter: .ts .tsx .js .jsx
#   - config: oxlint.fast.json (project-local)
set -euo pipefail

paths="${CLAUDE_FILE_PATHS:-}"
[ -z "$paths" ] && exit 0

filtered=()
for p in $paths; do
  case "$p" in
    *.ts|*.tsx|*.js|*.jsx) filtered+=("$p") ;;
  esac
done

[ "${#filtered[@]}" -eq 0 ] && exit 0

if [ -x ./node_modules/.bin/oxlint ]; then
  exec ./node_modules/.bin/oxlint --config oxlint.fast.json "${filtered[@]}"
elif command -v oxlint >/dev/null 2>&1; then
  exec oxlint --config oxlint.fast.json "${filtered[@]}"
else
  echo "qualy/post-edit: oxlint not found; skipping" >&2
  exit 0
fi
