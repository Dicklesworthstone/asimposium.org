#!/usr/bin/env bash
# Inbox, Follows, Notices, and Impact Echoes E2E Gate (W6.3, bead asimposiumorg-1e7).
# Proves:
# 1. GET /v1/inbox returns oldest-first notices, cursor, unacknowledged count, and omitted array.
# 2. All 10 notice types and 4 impact echo kinds validated and delivered.
# 3. POST /v1/inbox/ack acknowledges notices by notice_ids or until_seq.
# 4. Cursor pagination (since, limit, unread_only) with teaching RFC 7807 errors.
# 5. Diptych Markdown face (/v1/inbox.md and Accept: text/markdown) with YAML frontmatter.
# 6. Private problem follows (POST, GET, DELETE /v1/p/:id/follow and /v1/problems/:id/follow) with idempotency.
# 7. Follow privacy invariants: private to subscriber, no public graph/count, no authority boost.
# 8. Cross-fellow privacy and notice isolation.
# 9. OPS.2a structured diagnostic logging (facility, stage, IDs, cursors, latency; no directive text, secrets, or tokens).
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=e2e/lib/run-diagnostics.sh
source "$repository_root/e2e/lib/run-diagnostics.sh"
trap 'e2e_close_artifact_writer_leases_on_exit' EXIT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 130' INT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 143' TERM
trap 'e2e_leave_artifact_writer_leases_open_on_signal 129' HUP

suite="e2e-inbox-follows"
reproduce="bash scripts/e2e-inbox-follows.sh"
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

cd "$repository_root" || exit 1

# Run the inbox & follows E2E test engine
# Real local Workerd/D1/R2 first (lu59): causal notices, exact-once delivery
# under a replayed job and racing ticks, follow/unfollow, revision notices,
# directives with cross-sponsor refusal and ack, and no public follower keys.
if ! node apps/wire/test/integration/stoa-surface-real-bindings.mjs; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "INBOX_FOLLOWS_REAL_BINDINGS_FAILED" "$reproduce"
  exit 1
fi
# Unit-level taxonomy checks (bun:sqlite, in-process; not e2e proof)
if ! bun scripts/suite/inbox-follows-e2e.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "INBOX_FOLLOWS_E2E_ASSERTION_FAILED" "$reproduce"
  exit 1
fi

e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "pass" "INBOX_FOLLOWS_E2E_COMPLETE" "$reproduce"
exit 0
