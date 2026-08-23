#!/usr/bin/env bash
#
# Migration-pin parity gate.
#
# The S2 Krater harness (scripts/e2e-s2-krater.sh) and the token-lifecycle
# harness (scripts/e2e-token-lifecycle.sh) both carry closed migration
# journals whose runtime checks compare DISK against the pinned list. A commit
# that adds db/migrations/00NN_*.sql without updating both pins therefore does
# not fail where the migration landed — it fails later, deterministically, in
# two unrelated unit clusters (observed as a 23-test red class across three
# consecutive peer slices on 2026-08-23).
#
# This gate moves that failure to the moment of the omission: every migration
# on disk must be named in each harness, and every name a harness pins must
# exist on disk (so deletions and renames cannot strand a pin either).

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

HARNESSES=(
  scripts/e2e-s2-krater.sh
  scripts/e2e-token-lifecycle.sh
)

drift=0

for migration in db/migrations/*.sql; do
  name="$(basename "${migration}")"
  for harness in "${HARNESSES[@]}"; do
    if ! grep -qF "${name}" "${harness}"; then
      echo "migration-pin-drift: ${name} exists on disk but is not pinned in ${harness}" >&2
      drift=1
    fi
  done
done

for harness in "${HARNESSES[@]}"; do
  while IFS= read -r pinned; do
    [[ -n "${pinned}" ]] || continue
    if [[ ! -f "db/migrations/${pinned}" ]]; then
      echo "migration-pin-drift: ${harness} pins ${pinned} which does not exist on disk" >&2
      drift=1
    fi
  done < <(LC_ALL=C grep -oE '[0-9]{4}_[a-z0-9_]+\.sql' "${harness}" | LC_ALL=C sort -u)
done

if (( drift == 1 )); then
  echo "" >&2
  echo "Fix: update BOTH harness pin lists (journal array + source-path list in" >&2
  echo "scripts/e2e-s2-krater.sh, EXPECTED_MIGRATIONS in scripts/e2e-token-lifecycle.sh)" >&2
  echo "in the same commit as the migration change." >&2
fi

exit "${drift}"
