#!/usr/bin/env bash
# Backups, Exports, and Retention Enforcement E2E Gate (W2.8, bead asimposiumorg-p4b).
# Proves:
# 1. Representative public/private state: public active problems with claims/citations/events vs private-drafts and workshop state.
# 2. Per-problem export serialization: NDJSON with header control record (CC BY 4.0 license), ledger events, terminal export_end record.
# 3. Gzip export (/p/:slug/export.jsonl.gz) decompresses to verified NDJSON under CC BY 4.0.
# 4. Strict offline chain verification (tamper-evidence, sequence gaps, row digests, embedded checkpoints).
# 5. Privacy invariant: workshop pushes and private drafts are strictly absent from public exports.
# 6. Citation export: BibTeX (@misc, @article) and CSL JSON with stable URLs, cite keys, statement versions, and access dates.
# 7. Scratch target authority: restore strictly refuses any non-scratch target (prod, staging, live, primary, main) before any writes.
# 8. Atomic restore: row-for-row restoration into validated scratch target, and total rollback on tampered payloads or missing trailers.
# 9. Retention enforcement: hard-deletion of never-published private drafts upon authenticated sponsor request with 90-day retention receipts.
# 10. Ledger immutability: hard-deletion of public problems or problems with committed events is refused.
# 11. Security records expiration: scheduled sweep of expired nonces and stale device lookups without touching ledger history.
# 12. Deletion-safe restore: replay of deletion journal ensures deleted private drafts are never reactivated from older snapshots.
# 13. Canonical face parity: re-exporting restored state produces byte-identical exports.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../e2e/lib/run-diagnostics.sh disable=SC1091
source "$repository_root/e2e/lib/run-diagnostics.sh"
trap 'e2e_close_artifact_writer_leases_on_exit' EXIT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 130' INT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 143' TERM
trap 'e2e_leave_artifact_writer_leases_open_on_signal 129' HUP

suite="e2e-export-restore"
reproduce="bash scripts/e2e-export-restore.sh"
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

# 1. Run pure unit test suites for export, backup, restore, retention, and citation
if ! bun test apps/wire/test/unit/krater-export.test.ts \
              apps/wire/test/unit/krater-backup.test.ts \
              apps/wire/test/unit/backup-restore-drill.test.ts \
              apps/wire/test/unit/krater-retention.test.ts \
              apps/wire/test/unit/krater-citation.test.ts \
              apps/wire/test/unit/citations.test.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "EXPORT_RESTORE_UNIT_TESTS_FAILED" "$reproduce"
  exit 1
fi

# 2. Run the comprehensive export-restore E2E integration runner
if ! bun scripts/suite/export-restore-e2e.ts; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "EXPORT_RESTORE_E2E_RUNNER_FAILED" "$reproduce"
  exit 1
fi

e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "pass" "" "$reproduce"
exit 0
