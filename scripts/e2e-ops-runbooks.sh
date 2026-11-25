#!/usr/bin/env bash
# OPS.5 Runbook Index, Never-Log Redaction, and Audit-Logged Ops Commands Gate
# (bead asimposiumorg-vpx, Fable §13.3 / §14.3).
#
# Modes:
#   --local    (default) Exercises:
#              1. All 12 Fable §13.3 runbooks, docs/runbooks/INDEX.md, rehearsal log,
#                 never-log redaction corpus, append-only SHA-256 audit log, and dry-run /
#                 scratch-execute ops commands + planted detectors (`scripts/ops-vpx.test.ts`).
#              2. CLI `--help` contracts across all 6 `scripts/ops-*.ts` operator commands.
#              3. Live `scripts/ops-outbox-reconcile.ts` dry-run against a scratch SQLite DB
#                 proving healthy exit 0 and planted stale-backlog alert exit 1.
#   --staging  Fails closed (exit 78) unless non-production staging authority is
#              explicitly provisioned. Never touches production data.
set -euo pipefail
set +x

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=e2e/lib/run-diagnostics.sh
source "${REPO_ROOT}/e2e/lib/run-diagnostics.sh"

MODE="local"
STARTED_MS="$(e2e_now_ms)"
RUN_ID="$(e2e_generated_run_id "ops-runbooks")"
SUITE="e2e-ops-runbooks"
REPRODUCE="bash scripts/e2e-ops-runbooks.sh"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --local)
      MODE="local"
      shift
      ;;
    --staging)
      MODE="staging"
      shift
      ;;
    -h|--help)
      echo "Usage: bash scripts/e2e-ops-runbooks.sh [--local | --staging]"
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument '$1'" >&2
      exit 2
      ;;
  esac
done

cd "$REPO_ROOT"

if [[ "$MODE" == "staging" ]]; then
  if ! e2e_validate_staging_origin "ASIMPOSIUM_STAGING_AGENT_BASE_URL"; then
    e2e_emit_and_optionally_record 0 "$RUN_ID" "$SUITE" "$STARTED_MS" "blocked" "STAGING_AGENT_BASE_URL_UNAVAILABLE_OR_INVALID" "$REPRODUCE --staging"
    exit 78
  fi
  e2e_emit_and_optionally_record 0 "$RUN_ID" "$SUITE" "$STARTED_MS" "blocked" "STAGING_OPS_RUNBOOK_DRILL_NOT_PROVISIONED" "$REPRODUCE --staging"
  exit 78
fi

echo "==> [OPS.5 1/3] Running OPS.5 runbook index, never-log corpus, audit log & ops:* command suite"
bun test --timeout=30000 scripts/ops-vpx.test.ts

echo "==> [OPS.5 2/3] Verifying CLI --help contracts for all 6 ops:* commands"
for cmd in \
  scripts/ops-event-verify.ts \
  scripts/ops-projection-rebuild.ts \
  scripts/ops-outbox-reconcile.ts \
  scripts/ops-artifact-inventory.ts \
  scripts/ops-cache-privacy-test.ts \
  scripts/ops-backup-restore-smoke.ts; do
  if [[ ! -f "$cmd" ]]; then
    echo "ERROR: missing contracted ops command: $cmd" >&2
    exit 1
  fi
  bun "$cmd" --help >/dev/null
done

echo "==> [OPS.5 3/3] Rehearsing ops-outbox-reconcile CLI on scratch SQLite (healthy + planted lag)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/asimposium-ops-runbooks.XXXXXX")"
bun -e '
import { Database } from "bun:sqlite";
const dbPath = process.argv[1];
const db = new Database(dbPath);
db.exec(`
  CREATE TABLE problems (id TEXT PRIMARY KEY, status TEXT NOT NULL);
  CREATE TABLE claims (id TEXT NOT NULL, problem_id TEXT NOT NULL);
  CREATE TABLE outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL,
    problem_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    dedupe_key TEXT NOT NULL UNIQUE,
    payload_sha256 TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT "pending",
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    last_error TEXT,
    quarantined_at TEXT,
    created_at TEXT NOT NULL
  );
  INSERT INTO problems VALUES ("P-1", "active");
  INSERT INTO outbox (event_id, problem_id, kind, dedupe_key, payload_sha256, state, created_at)
  VALUES ("EV-1", "P-1", "search.index", "search.index:EV-1", "a", "delivered", "2026-11-23T00:00:00.000Z");
`);
db.close();
' "${SCRATCH}/healthy.sqlite"
bun scripts/ops-outbox-reconcile.ts --sqlite "${SCRATCH}/healthy.sqlite" --dry-run >/dev/null

bun -e '
import { Database } from "bun:sqlite";
const dbPath = process.argv[1];
const db = new Database(dbPath);
db.exec(`
  CREATE TABLE problems (id TEXT PRIMARY KEY, status TEXT NOT NULL);
  CREATE TABLE claims (id TEXT NOT NULL, problem_id TEXT NOT NULL);
  CREATE TABLE outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL,
    problem_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    dedupe_key TEXT NOT NULL UNIQUE,
    payload_sha256 TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT "pending",
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    last_error TEXT,
    quarantined_at TEXT,
    created_at TEXT NOT NULL
  );
  INSERT INTO problems VALUES ("P-1", "active");
  INSERT INTO outbox (event_id, problem_id, kind, dedupe_key, payload_sha256, state, created_at)
  VALUES ("EV-STALE", "P-1", "search.index", "search.index:EV-STALE", "a", "pending", "2020-01-01T00:00:00.000Z");
`);
db.close();
' "${SCRATCH}/lagging.sqlite"
lag_rc=0
bun scripts/ops-outbox-reconcile.ts --sqlite "${SCRATCH}/lagging.sqlite" --dry-run >/dev/null 2>&1 || lag_rc=$?
if [[ "$lag_rc" -ne 1 ]]; then
  echo "ERROR: ops-outbox-reconcile planted stale backlog exited ${lag_rc}, expected 1" >&2
  exit 1
fi

REV="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
printf '{"facility":"OPS.2a","gate":"OPS5_RUNBOOKS_LOCAL_PASS","bead":"asimposiumorg-vpx","revision":"%s","mode":"local","runbooks_verified":12,"ops_commands_verified":6,"does_not_prove":["hosted staging restore drill (rs5n)","live Cloudflare R2/D1 incident execution"]}\n' "$REV"
e2e_emit_and_optionally_record 0 "$RUN_ID" "$SUITE" "$STARTED_MS" "pass" "OPS5_RUNBOOKS_LOCAL_PASS" "$REPRODUCE"
