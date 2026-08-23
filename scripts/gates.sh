#!/usr/bin/env bash
#
# Host-agnostic gate runner. The operator has banned GitHub Actions for this
# repository permanently; this script is THE enforcement entrypoint instead.
# It runs the same gates the deleted workflow ran, on any machine with bun
# installed - a developer laptop here, or a fleet build host (trj/ts1/mmini)
# driven over SSH by whatever orchestration wraps it.
#
# Usage:
#   scripts/gates.sh              # static (typecheck+lint) + fast unit suites
#   scripts/gates.sh --wire       # additionally the full wire unit gate (~15 min)
#   scripts/gates.sh --cli        # additionally cargo test for cli/
#   scripts/gates.sh --all        # everything
#
# Exit code is non-zero if any selected phase fails.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

WANT_STATIC=0
WANT_FAST=0
WANT_WIRE=0
WANT_CLI=0

if [[ $# -eq 0 ]]; then
  WANT_STATIC=1
  WANT_FAST=1
fi

for arg in "$@"; do
  case "$arg" in
    --static) WANT_STATIC=1 ;;
    --fast) WANT_FAST=1 ;;
    --wire) WANT_WIRE=1 ;;
    --cli) WANT_CLI=1 ;;
    --all)
      WANT_STATIC=1
      WANT_FAST=1
      WANT_WIRE=1
      WANT_CLI=1
      ;;
    *)
      echo "unknown option: $arg (use --static --fast --wire --cli --all)" >&2
      exit 64
      ;;
  esac
done

phase() {
  local name="$1"
  shift
  echo ""
  echo "=== gate: ${name} ==="
  "$@"
}

if [[ "$WANT_STATIC" == 1 ]]; then
  phase "install (frozen lockfile)" bun install --frozen-lockfile
  phase "typecheck (8 packages)" bun run typecheck
  phase "lint (8 packages)" bun run lint
fi

if [[ "$WANT_FAST" == 1 ]]; then
  for package in contracts protocol render web; do
    phase "unit+contract: @asimposium/${package}" bun run --filter "@asimposium/${package}" test
  done
fi

if [[ "$WANT_WIRE" == 1 ]]; then
  phase "wire unit gate (real workerd)" bun run --filter @asimposium/wire test:unit
fi

if [[ "$WANT_CLI" == 1 ]]; then
  phase "asimp cargo tests" bash -c 'cd cli && cargo test'
fi

echo ""
echo "=== all selected gates passed ==="
