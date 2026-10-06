#!/usr/bin/env bash
# W2.1 (asimposiumorg-jfi) forward-migration rehearsal.
#
#   scripts/e2e-migrations.sh            # local (default): real local D1, no account
#   scripts/e2e-migrations.sh staging    # blocked (exit 78) until the operator deploy path exists
#
# Local: a disposable local D1 is bootstrapped at the manifest baseline, seeded
# with sentinel rows, checkpointed (SQLite online backup), then migrated forward
# with infra/migrate.mjs while the whole runner process group is SIGKILLed
# mid-run. The resumed run must finish the forward plan, a second run must apply
# nothing, and the invariants must hold: the journal is the exact contiguous
# forward suffix with the files' digests, the sentinel rows are unchanged, and
# SQLite's integrity and foreign-key checks are clean. The runner's own lineage
# classification then pins the final catalog to the manifest's schema head.
#
# Logs are one JSON object per phase (OPS.2a): environment, revision, migration
# ids/digests, phase, digests, status/code, duration. Never row contents,
# credentials, cookies, tokens, fragments or production identifiers.
#
# Exit: 0 pass, 1 fail, 78 blocked.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

TARGET="${1:-local}"
BLOCKED_EXIT_CODE=78
REVISION="$(git rev-parse HEAD)"
DATABASE_NAME="asimposium-local"
WRANGLER_CONFIG="infra/wrangler.toml"
WRANGLER_ENTRY="apps/wire/node_modules/wrangler/bin/wrangler.js"

now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }
PHASE_STARTED_AT="$(now_ms)"

emit() {
  # emit <phase> <status> <code> <detail> [extra-json-object]
  local phase="$1" status="$2" code="$3" detail="$4" extra="${5:-}"
  [ -n "$extra" ] || extra="{}"
  local finished
  finished="$(now_ms)"
  python3 -c '
import json, sys
record = {
    "tool": "bash", "package": "infra", "suite": "migration-e2e",
    "environment": sys.argv[1], "revision": sys.argv[2], "phase": sys.argv[3],
    "status": sys.argv[4], "code": sys.argv[5], "detail": sys.argv[6],
    "duration_ms": int(sys.argv[7]),
    "reproduce": "scripts/e2e-migrations.sh " + sys.argv[1],
}
record.update(json.loads(sys.argv[8]))
print(json.dumps(record, separators=(",", ":")))
' "$TARGET" "$REVISION" "$phase" "$status" "$code" "$detail" \
    "$((finished - PHASE_STARTED_AT))" "$extra"
  PHASE_STARTED_AT="$finished"
}

fail_phase() {
  emit "$1" "fail" "$2" "$3" "${4:-}"
  exit 1
}

case "$TARGET" in
  local) ;;
  staging)
    # The disposable staging database, its deploy and smoke need the operator's
    # deploy authority (asimposiumorg-rs5n). Presence is tested, nothing is read
    # or simulated.
    missing=()
    for required in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID ASIMP_D1_DATABASE_ID_STAGING; do
      if [ -z "${!required:-}" ]; then missing+=("$required"); fi
    done
    if [ ${#missing[@]} -gt 0 ]; then
      emit "credentials" "blocked" "CREDENTIALS_ABSENT" \
        "Not set in this environment: ${missing[*]}. Presence was tested; no value was read."
    else
      emit "staging" "blocked" "STAGING_REHEARSAL_NOT_IMPLEMENTED" \
        "Credentials are present, but the disposable staging rehearsal is not implemented yet; nothing was run."
    fi
    exit "$BLOCKED_EXIT_CODE"
    ;;
  *)
    printf 'usage: scripts/e2e-migrations.sh [local|staging]\n' >&2
    exit 2
    ;;
esac

for tool in bun node python3 setsid; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    emit "toolchain" "blocked" "TOOL_UNAVAILABLE" "$tool is not on PATH."
    exit "$BLOCKED_EXIT_CODE"
  fi
done
if [ ! -f "$WRANGLER_ENTRY" ]; then
  emit "toolchain" "blocked" "PINNED_WRANGLER_UNAVAILABLE" \
    "The workspace Wrangler is not installed. Run bun install --frozen-lockfile."
  exit "$BLOCKED_EXIT_CODE"
fi
emit "toolchain" "pass" "OK" "bun, node, python3, setsid and the pinned Wrangler are present"

PERSIST="$(mktemp -d "${TMPDIR:-/tmp}/asimposium-e2e-migrations.XXXXXX")"
ARTIFACT="$(python3 -c 'import json; print(json.load(open("db/bootstrap/manifest.json"))["default_artifact_id"])')"

wrangler_local() {
  node "$WRANGLER_ENTRY" d1 "$@" --local --persist-to "$PERSIST" --config "$WRANGLER_CONFIG"
}

# The local D1 file behind the binding, read only while no runner is live.
d1_file() {
  python3 -c '
import glob, os, sys
files = [path for path in glob.glob(os.path.join(sys.argv[1], "v3", "d1", "*", "*.sqlite"))
         if os.path.basename(path) != "metadata.sqlite"]
if len(files) != 1:
    sys.exit(1)
print(files[0])
' "$PERSIST"
}

# --- 1. bootstrap ------------------------------------------------------------
if ! output="$(bun infra/migrate.mjs --env local --local-persist-to "$PERSIST" --bootstrap "$ARTIFACT" --apply 2>&1)"; then
  code="$(printf '%s' "$output" | sed -n 's/.*"code":"\([A-Z_]*\)".*/\1/p' | head -1)"
  fail_phase "bootstrap" "${code:-BOOTSTRAP_FAILED}" "The disposable local D1 could not be bootstrapped."
fi
emit "bootstrap" "pass" "OK" "disposable local D1 bootstrapped at the manifest baseline" \
  "{\"bootstrap_artifact\":\"$ARTIFACT\"}"

# --- 2. sentinels and checkpoint ---------------------------------------------
SEED_SQL="INSERT INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES ('usr_e2e_migrations_sentinel', 1760000000000, 1760000000001);
INSERT INTO problems (id, public_seq, created_at, updated_at) VALUES ('P-E2EMIGRATIONSENTINEL', 0, '2026-10-06T00:00:00.000Z', '2026-10-06T00:00:00.000Z');"
if ! wrangler_local execute "$DATABASE_NAME" --command "$SEED_SQL" >/dev/null 2>&1; then
  fail_phase "seed" "SEED_FAILED" "The sentinel rows could not be written at the baseline."
fi

SENTINEL_DIGEST_SQL="SELECT 'sponsor', sponsor_id, created_at, last_seen_at FROM sponsors WHERE sponsor_id = 'usr_e2e_migrations_sentinel'
UNION ALL SELECT 'problem', id, created_at, updated_at FROM problems WHERE id = 'P-E2EMIGRATIONSENTINEL'"
sentinel_digest() {
  python3 -c '
import hashlib, json, sqlite3, sys
connection = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True)
rows = connection.execute(sys.argv[2]).fetchall()
if len(rows) != 2:
    sys.exit(1)
print(hashlib.sha256(json.dumps(sorted(map(list, rows)), sort_keys=True).encode()).hexdigest())
' "$(d1_file)" "$SENTINEL_DIGEST_SQL"
}
SENTINEL_BEFORE="$(sentinel_digest)" || fail_phase "seed" "SENTINEL_UNREADABLE" "The sentinel rows were not found after seeding."

# wrangler d1 export cannot target a --persist-to database, so the checkpoint
# is SQLite's own online backup of the local D1 file (restorable as is) and
# the digest of its SQL dump.
if ! CHECKPOINT_DIGEST="$(python3 -c '
import hashlib, sqlite3, sys
source = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True)
target = sqlite3.connect(sys.argv[2])
source.backup(target)
digest = hashlib.sha256()
for line in target.iterdump():
    digest.update(line.encode() + b"\n")
print(digest.hexdigest())
' "$(d1_file)" "$PERSIST/checkpoint-before.sqlite")"; then
  fail_phase "checkpoint" "CHECKPOINT_FAILED" "The baseline checkpoint of the local D1 could not be taken."
fi
emit "checkpoint" "pass" "OK" "sentinels seeded and the baseline checkpointed" \
  "{\"sentinel_digest\":\"$SENTINEL_BEFORE\",\"checkpoint_sha256\":\"$CHECKPOINT_DIGEST\"}"

journal_count() {
  python3 -c '
import sqlite3, sys
connection = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True)
print(connection.execute("SELECT COUNT(*) FROM _asimposium_migrations").fetchone()[0])
' "$(d1_file)"
}

FORWARD_COUNT="$(python3 -c '
import glob, json
manifest = json.load(open("db/bootstrap/manifest.json"))
head = next(a for a in manifest["artifacts"] if a["id"] == manifest["default_artifact_id"])["head_sequence"]
print(sum(1 for path in glob.glob("db/migrations/[0-9][0-9][0-9][0-9]_*.sql") if int(path.split("/")[-1][:4]) > head))
')"

# --- 3. forward apply, killed mid-run ----------------------------------------
# The whole runner process group (bun, Wrangler, workerd) is SIGKILLed: a
# crash, not a polite stop. The delay grows until at least one migration has
# landed; reaching the end without an interruption is a failure, not a pass.
delay=6
interrupted_at=0
for attempt in 1 2 3 4 5; do
  setsid bun infra/migrate.mjs --env local --local-persist-to "$PERSIST" --apply \
    >"$PERSIST/interrupted-$attempt.log" 2>&1 &
  runner_pid=$!
  sleep "$delay"
  kill -KILL -- "-$runner_pid" 2>/dev/null || true
  wait "$runner_pid" 2>/dev/null || true
  # Give the killed group's sockets and file handles time to close.
  sleep 2
  interrupted_at="$(journal_count)"
  if [ "$interrupted_at" -gt 0 ]; then break; fi
  delay=$((delay * 2))
done
if [ "$interrupted_at" -le 0 ] || [ "$interrupted_at" -ge "$FORWARD_COUNT" ]; then
  fail_phase "interrupt" "INTERRUPTION_NOT_OBSERVED" \
    "The forward apply was not caught mid-run (journal held $interrupted_at of $FORWARD_COUNT)." \
    "{\"journal_records\":$interrupted_at,\"forward_migrations\":$FORWARD_COUNT}"
fi
emit "interrupt" "pass" "OK" "forward apply SIGKILLed mid-run" \
  "{\"journal_records\":$interrupted_at,\"forward_migrations\":$FORWARD_COUNT,\"kill_after_s\":$delay}"

# --- 4. resume and idempotence -----------------------------------------------
if ! resumed="$(bun infra/migrate.mjs --env local --local-persist-to "$PERSIST" --apply 2>&1)"; then
  code="$(printf '%s' "$resumed" | sed -n 's/.*"code":"\([A-Z_]*\)".*/\1/p' | head -1)"
  fail_phase "resume" "${code:-RESUME_FAILED}" \
    "The resumed apply after the crash failed; re-run infra/migrate.mjs on the retained database for the diagnostic." \
    "{\"retained_database\":\"$PERSIST\"}"
fi
resumed_applied="$(printf '%s' "$resumed" | tail -1 | python3 -c 'import json, sys; print(len(json.loads(sys.stdin.read())["applied"]))')"
if [ "$((interrupted_at + resumed_applied))" -ne "$FORWARD_COUNT" ]; then
  fail_phase "resume" "RESUME_INCOMPLETE" "The resumed apply did not finish exactly the remaining migrations." \
    "{\"journal_records_before\":$interrupted_at,\"applied\":$resumed_applied,\"forward_migrations\":$FORWARD_COUNT}"
fi
emit "resume" "pass" "OK" "the resumed apply finished exactly the remaining migrations" \
  "{\"applied\":$resumed_applied}"

if ! again="$(bun infra/migrate.mjs --env local --local-persist-to "$PERSIST" --apply 2>&1)"; then
  fail_phase "idempotent" "SECOND_APPLY_FAILED" "The second apply after the resume failed."
fi
again_applied="$(printf '%s' "$again" | tail -1 | python3 -c 'import json, sys; print(len(json.loads(sys.stdin.read())["applied"]))')"
if [ "$again_applied" -ne 0 ]; then
  fail_phase "idempotent" "NOT_IDEMPOTENT" "The second apply applied migrations again."
fi
emit "idempotent" "pass" "OK" "the second apply applied nothing (the runner re-verified lineage at the pinned head)"

# --- 5. invariants -----------------------------------------------------------
SENTINEL_AFTER="$(sentinel_digest)" || fail_phase "invariants" "SENTINEL_LOST" "A sentinel row did not survive the forward migration."
if [ "$SENTINEL_AFTER" != "$SENTINEL_BEFORE" ]; then
  fail_phase "invariants" "SENTINEL_CHANGED" "A sentinel row changed across the forward migration." \
    "{\"before\":\"$SENTINEL_BEFORE\",\"after\":\"$SENTINEL_AFTER\"}"
fi
if ! invariant="$(python3 -c '
import glob, hashlib, json, sqlite3, sys
connection = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True)
journal = connection.execute("SELECT id, sequence, digest FROM _asimposium_migrations ORDER BY sequence").fetchall()
manifest = json.load(open("db/bootstrap/manifest.json"))
head = next(a for a in manifest["artifacts"] if a["id"] == manifest["default_artifact_id"])["head_sequence"]
files = sorted(path for path in glob.glob("db/migrations/[0-9][0-9][0-9][0-9]_*.sql") if int(path.split("/")[-1][:4]) > head)
expected = [(path.split("/")[-1], int(path.split("/")[-1][:4]), hashlib.sha256(open(path, "rb").read()).hexdigest()) for path in files]
problems = []
if [tuple(row) for row in journal] != expected:
    problems.append("journal is not the exact forward suffix with file digests")
if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
    problems.append("integrity_check")
if connection.execute("PRAGMA foreign_key_check").fetchall():
    problems.append("foreign_key_check")
print(json.dumps({"problems": problems, "journal_records": len(journal), "head": journal[-1][1] if journal else None}))
sys.exit(1 if problems else 0)
' "$(d1_file)")"; then
  fail_phase "invariants" "INVARIANT_FAILED" "Post-migration invariants failed." "$invariant"
fi
emit "invariants" "pass" "OK" "journal is the exact forward suffix; sentinels unchanged; integrity and foreign keys clean" \
  "$(printf '%s' "$invariant" | python3 -c 'import json, sys; d = json.loads(sys.stdin.read()); d.pop("problems"); print(json.dumps(d))')"

emit "summary" "pass" "OK" "forward migration survived a mid-run crash, resumed, and is idempotent on a real local D1" \
  "{\"retained_database\":\"$PERSIST\"}"
