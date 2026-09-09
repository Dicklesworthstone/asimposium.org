#!/usr/bin/env bash
# W3.6 Naming Law Validator E2E Gate (bead asimposiumorg-83g).
# Exercises these representative cases through real local Worker/D1 bindings;
# the unit suite retains the wider table-driven grammar/property coverage:
# 1. Regex ^[a-z][a-z0-9-]{2,31}$ edge rules, lowercase ASCII constraints, and valid odd names.
# 2. Rejection of model identities with MODEL_AS_NAME and three available suggestions.
# 3. Rejection of harness identities with HARNESS_AS_NAME and three available suggestions.
# 4. Rejection of reserved platform identities and product names with NAME_RESERVED.
# 5. Rejection of impersonation affixes (official / real / -mod) with NAME_RESERVED.
# 6. Rejection of exact and leetspeak-normalized profanities with NAME_RESERVED.
# 7. Rejection of grammar violations with NAME_INVALID.
# 8. Suggested names accepted, sponsor-approved, and usable through bearer-authenticated hello.
# 9. Rejection of collision on already-taken names with NAME_TAKEN (excluding taken name from suggestions).
# 10. DB-level uniqueness constraint COLLATE NOCASE and permanent tombstone (DELETE prohibited).
# 11. OPS.2a records exclude tested secrets, tokens, and the profanity fixture.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=e2e/lib/run-diagnostics.sh
source "$repository_root/e2e/lib/run-diagnostics.sh"
trap 'e2e_close_artifact_writer_leases_on_exit' EXIT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 130' INT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 143' TERM
trap 'e2e_leave_artifact_writer_leases_open_on_signal 129' HUP

suite="e2e-naming-law"
reproduce="bash scripts/e2e-naming-law.sh"
started_ms="$(e2e_now_ms)"
self_test=0
write_artifacts=0
explicit_run_id=""

usage_failure() {
  e2e_emit_diagnostic "$suite" "$started_ms" "fail" "$1" "$reproduce"
  exit 64
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --self-test)
      self_test=1
      ;;
    --write-artifacts)
      write_artifacts=1
      ;;
    --run-id)
      [[ "$#" -ge 2 ]] || usage_failure "RUN_ID_MISSING"
      if [[ "$2" == --* || -z "$2" ]]; then
        usage_failure "RUN_ID_MISSING"
      fi
      explicit_run_id="$2"
      shift
      ;;
    *)
      usage_failure "UNKNOWN_ARGUMENT"
      ;;
  esac
  shift
done

if [[ -n "$explicit_run_id" ]]; then
  e2e_validate_run_id "$explicit_run_id" || usage_failure "RUN_ID_INVALID"
fi

if [[ "$self_test" -eq 1 ]]; then
  e2e_run_harness_self_test "$suite" "$started_ms" "$reproduce"
  exit 0
fi

run_id="$(e2e_resolve_run_id "$suite" "$explicit_run_id")" || usage_failure "RUN_ID_INVALID"
if [[ "$write_artifacts" -eq 1 ]] \
  && ! e2e_claim_artifact_run_at_root "$repository_root" "$run_id"; then
  e2e_emit_diagnostic "$suite" "$started_ms" "blocked" "ARTIFACT_RUN_ALREADY_EXISTS" "$reproduce"
  exit 78
fi

cd "$repository_root"

# Wrangler requires genuine Node. Honor an explicit runtime; otherwise allow
# the system Node when PATH's node is a Bun shim.
node_binary="${ASIMPOSIUM_NODE_BINARY:-node}"
if [[ -z "${ASIMPOSIUM_NODE_BINARY:-}" ]] \
  && ! "$node_binary" -e 'process.exit(process.versions.bun ? 1 : 0)' >/dev/null 2>&1; then
  node_binary="/usr/bin/node"
fi
if ! "$node_binary" -e 'process.exit(process.versions.bun ? 1 : 0)' >/dev/null 2>&1; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "blocked" "NAMING_NODE_UNAVAILABLE" "$reproduce"
  exit 78
fi

if ! "$node_binary" scripts/suite/naming-law-e2e.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "NAMING_LAW_E2E_ASSERTION_FAILED" "$reproduce"
  exit 1
fi

# This receipt certifies the local Worker/D1 naming journey. Google, browser,
# staging and fresh-harness enrollment remain separate G0 gates.
e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "pass" "NAMING_LAW_LOCAL_BINDINGS_COMPLETE" "$reproduce"
exit 0
