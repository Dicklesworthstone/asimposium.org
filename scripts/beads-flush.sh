#!/usr/bin/env bash
# Flush beads DB -> issues.jsonl, then strip the local-machine path field
# (source_repo_path) that br exports but which must not land in a public repo.
# Always use this instead of bare `br sync --flush-only` (see AGENTS.md).
set -euo pipefail
cd "$(dirname "$0")/.."

br sync --flush-only

JSONL=.beads/issues.jsonl
if [ -f "$JSONL" ]; then
  TMP="$(mktemp)"
  jq -c 'del(.source_repo_path)' "$JSONL" > "$TMP"
  mv "$TMP" "$JSONL"
  echo "beads-flush: stripped source_repo_path from $(wc -l < "$JSONL" | tr -d ' ') records"
fi

echo "beads-flush: done — now: git add .beads/ && git commit"
