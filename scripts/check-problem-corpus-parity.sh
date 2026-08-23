#!/usr/bin/env bash
#
# Problem-refusal corpus parity gate.
#
# packages/contracts/src/problem.ts is the closed vocabulary of refusal codes
# the platform can emit; the golden corpus under
# packages/contracts/test/fixtures/valid is what proves each code's document
# face parses. The W1.5 coverage tests inside the contracts lane enforce that
# union at test time — but three peer slices on 2026-08-22/23 landed new codes
# without fixtures and discovered the gap only when some other agent's suite
# run went red (asimposiumorg-33ks was the first repair; the W5.5 gap/revise
# codes were the second).
#
# This gate moves the failure to commit time: every code in the source enum
# must have a valid golden fixture named problem-<slug>.json OR be carried in
# the CORPUS_COVERAGE_DEBT ledger with a stated reason; and every
# problem-*.json fixture must name a live code. It is deliberately dumber than
# the runtime gate — a tripwire, not a second validator — so it costs
# milliseconds and cannot disagree about shape, only about presence.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

PROBLEM_SRC="packages/contracts/src/problem.ts"
VALID_DIR="packages/contracts/test/fixtures/valid"
CORPUS_LEDGER="packages/contracts/test/unit/schema.test.ts"

drift=0

# Recorded debt is part of the W1.5 contract: a code may be covered by a
# fixture OR carried in CORPUS_COVERAGE_DEBT with a stated reason. Extract
# that ledger's slugs so this tripwire enforces the real rule instead of a
# stricter one that would sit permanently red on honest debt.
RECORDED_DEBT="$(sed -n '/^const CORPUS_COVERAGE_DEBT/,/^);/p' "${CORPUS_LEDGER}" | LC_ALL=C grep -oE '"[a-z0-9-]+"' | tr -d '"' | LC_ALL=C sort -u || true)"

for code in $(LC_ALL=C grep -oE '^  "[A-Z][A-Z0-9_]+",' "${PROBLEM_SRC}" | LC_ALL=C sort -u | tr -d ' ",'); do
  slug="$(printf '%s' "${code}" | tr '[:upper:]_' '[:lower:]-')"
  if [[ ! -f "${VALID_DIR}/problem-${slug}.json" ]]; then
    if LC_ALL=C grep -qxF "${slug}" <<<"${RECORDED_DEBT}"; then
      continue
    fi
    echo "corpus-drift: ${code} exists in the enum but ${VALID_DIR}/problem-${slug}.json is missing" >&2
    drift=1
  fi
done

while IFS= read -r fixture; do
  base="$(basename "${fixture}")"
  [[ "${base}" == problem-*.json ]] || continue
  slug="${base#problem-}"
  slug="${slug%.json}"
  code="$(printf '%s' "${slug}" | tr '[:lower:]-' '[:upper:]_')"
  if ! grep -qF "\"${code}\"" "${PROBLEM_SRC}"; then
    echo "corpus-drift: ${base} names no live code (${code} absent from ${PROBLEM_SRC})" >&2
    drift=1
  fi
done < <(LC_ALL=C find "${VALID_DIR}" -maxdepth 1 -name 'problem-*.json' | LC_ALL=C sort)

exit "${drift}"
