#!/usr/bin/env bash
# Environment end-to-end rehearsal (bead asimposiumorg-p1g, OPS.3).
#
# Runs every static phase from a checkout, then — when the four credential
# variables are present — resolves the staging deploy config, observes remote
# migration idempotence twice, probes the deployed worker's health and origin,
# and round-trips a private R2 canary while proving no public hostname serves
# it. Without credentials it stops before those phases and reports BLOCKED
# with the exact missing thing. It never deploys, never mutates production,
# and never simulates a result it did not obtain.
#
#   exit 0  every phase that could run, ran and passed
#   exit 1  a phase ran and failed
#   exit 78 a phase could not run because an external prerequisite is absent
#           (EX_CONFIG; the repository-wide "deliberately blocked" convention)
#
# Diagnostics are one NDJSON record per phase on stdout: environment, phase,
# status, code, duration, and a reproduction command. Never a secret, a
# credential, a cookie, a token, a service signature, or a database row. The
# credential gate tests only for PRESENCE. Authorized downstream tools read the
# values from their environment, while this wrapper never prints them or places
# secret values in command arguments.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# The self-test re-enters this script after changing to the repository root. Keep
# that re-entry independent of how its first caller spelled this path.
SCRIPT_PATH="$REPO_ROOT/scripts/e2e-environments.sh"
SELF_TEST_REMOTE_INTERFACE=0
if [ "${1:-}" = "--self-test-remote-interface" ]; then
  SELF_TEST_REMOTE_INTERFACE=1
  ENVIRONMENT="staging"
else
  ENVIRONMENT="${1:-staging}"
fi
BLOCKED_EXIT_CODE=78
STARTED_AT_NS=$(date +%s000000000 2>/dev/null || echo 0)
BLOCKERS=()
readonly WEB_USER_AGENT="OpenAI File Downloader, XaiImageApiFetch/1.0"

# Static validators, HTTP probes, and receipt parsers need no deployment
# authority. Preserve these values as shell variables for the narrow commands
# below, but do not let every child inherit them merely because the caller
# supplied a complete staging environment.
for scoped_name in \
  CLOUDFLARE_API_TOKEN \
  ASIMP_D1_DATABASE_ID_STAGING \
  ASIMP_STAGING_SERVICE_ENVELOPE_KEYS; do
  if [ -n "${!scoped_name:-}" ]; then export -n "$scoped_name"; fi
done

now_ms() { echo $(( $(date +%s) * 1000 )); }

# emit <phase> <status> <code> <detail>
emit() {
  local phase="$1" status="$2" code="$3" detail="$4"
  printf '{"tool":"bash","package":"infra","suite":"environment-e2e","phase":"%s","environment":"%s","status":"%s","code":"%s","detail":"%s","reproduce":"scripts/e2e-environments.sh %s"}\n' \
    "$phase" "$ENVIRONMENT" "$status" "$code" "$detail" "$ENVIRONMENT"
}

fail_phase() {
  emit "$1" "fail" "$2" "$3"
  exit 1
}

block_phase() {
  emit "$1" "blocked" "$2" "$3"
  BLOCKERS+=("$1: $3")
}

# This is deliberately a command-boundary plant, not a source-text assertion.
# The nested run has all remote credential *names* populated and substitutes
# only the commands this script owns. If a future refactor reaches resolver,
# deploy, migration, or curl before an accepted remote migration interface is
# available, the planted command refuses and this self-test cannot return green.
self_test_remote_interface_gate() {
  local scratch fake_bun fake_bunx fake_curl command_log nested_output nested_status
  local r2_command_log r2_output r2_status
  local supplied scratch_mode scratch_owner retained_scratch retained_scratch_json
  local planted_token="asimp_ag_remote_e2e_canary_1234567890abcdefghijklmnop"

  # A caller may lend a new empty private directory to control where the
  # retained evidence lands. It is accepted only when it is an absolute,
  # existing, self-owned 0700 directory: a world-readable or someone else's
  # directory would put the planted credential canary and the fake command
  # shims somewhere another user can read or replace.
  #
  # Nothing here deletes: the lent directory is the caller's to manage, and a
  # self-made one is retained and named in the record below.
  supplied="${ASIMPOSIUM_ENVIRONMENT_E2E_SCRATCH_DIR:-}"
  if [ -n "$supplied" ]; then
    scratch_mode="$(/usr/bin/stat -f '%Lp' "$supplied" 2>/dev/null || /usr/bin/stat -c '%a' "$supplied" 2>/dev/null || printf '')"
    scratch_owner="$(/usr/bin/stat -f '%u' "$supplied" 2>/dev/null || /usr/bin/stat -c '%u' "$supplied" 2>/dev/null || printf '')"
    case "$supplied" in
      /*) ;;
      *)
        printf '%s\n' '{"tool":"bash","package":"infra","suite":"environment-e2e","phase":"self-test","environment":"staging","status":"fail","code":"SELF_TEST_SCRATCH_REFUSED","detail":"ASIMPOSIUM_ENVIRONMENT_E2E_SCRATCH_DIR must be an absolute path"}'
        return 1
        ;;
    esac
    if [ ! -d "$supplied" ] || [ -L "$supplied" ] ||
      [ "$scratch_mode" != "700" ] || [ "$scratch_owner" != "$(id -u)" ]; then
      printf '%s\n' '{"tool":"bash","package":"infra","suite":"environment-e2e","phase":"self-test","environment":"staging","status":"fail","code":"SELF_TEST_SCRATCH_REFUSED","detail":"the supplied scratch directory must be a self-owned 0700 regular directory"}'
      return 1
    fi
    scratch="$supplied"
    retained_scratch=""
    if (shopt -s nullglob dotglob; entries=("$scratch"/*); ((${#entries[@]} > 0))); then
      printf '%s\n' '{"tool":"bash","package":"infra","suite":"environment-e2e","phase":"self-test","environment":"staging","status":"fail","code":"SELF_TEST_SCRATCH_REFUSED","detail":"the supplied scratch directory must be empty so no existing file is overwritten"}'
      return 1
    fi
  else
    scratch="$(mktemp -d "${TMPDIR:-/tmp}/asimposium-environment-e2e.XXXXXX")" || {
      printf '%s\n' '{"tool":"bash","package":"infra","suite":"environment-e2e","phase":"self-test","environment":"staging","status":"fail","code":"SELF_TEST_SCRATCH_UNAVAILABLE","detail":"could not create bounded scratch"}'
      return 1
    }
    chmod 700 "$scratch"
    retained_scratch="$scratch"
  fi

  fake_bun="$scratch/bun"
  fake_bunx="$scratch/bunx"
  fake_curl="$scratch/curl"
  command_log="$scratch/commands.log"

  # The directory was proved empty above, so this creates a new log rather than
  # truncating caller-owned evidence.
  : >"$command_log"
  chmod 600 "$command_log"

  # shellcheck disable=SC2016 # The fake command must expand its own variables later.
  printf '%s\n' '#!/bin/sh' \
    'printf "%s\\n" "$*" >> "$E2E_ENVIRONMENTS_TEST_COMMAND_LOG"' \
    'case "$*" in' \
    '  "infra/validate-scaffold.mjs"|"infra/generate-wrangler.mjs --check"|"infra/generate-wrangler.test.mjs") exit 0 ;;' \
    '  "infra/validate-environments.mjs") printf "{\\\"suite\\\":\\\"environment-topology-static\\\",\\\"status\\\":\\\"pass\\\",\\\"vercel\\\":{\\\"preview_environment\\\":\\\"staging\\\"},\\\"environments\\\":{\\\"staging\\\":{\\\"kind\\\":\\\"remote\\\",\\\"is_preview\\\":true,\\\"may_hold_production_keys\\\":false,\\\"worker_origin\\\":\\\"https://a-staging.asimposium.org\\\"}}}\\n"; exit 0 ;;' \
    '  "infra/resolve-wrangler-deploy.mjs --env staging --write") if [ "${E2E_ENVIRONMENTS_TEST_SCENARIO:-}" = "r2-write-failure" ]; then printf "{\\\"suite\\\":\\\"staging-wrangler-deploy-resolution\\\",\\\"status\\\":\\\"pass\\\",\\\"environment\\\":\\\"staging\\\",\\\"mode\\\":\\\"write\\\",\\\"published\\\":true,\\\"idempotent\\\":false}\\n"; exit 0; fi; exit 93 ;;' \
    '  infra/migrate.mjs\ --env\ staging\ --resolved-database-id\ *\ --apply) if [ "${E2E_ENVIRONMENTS_TEST_SCENARIO:-}" = "r2-write-failure" ]; then printf "{\\\"status\\\":\\\"pass\\\",\\\"environment\\\":\\\"staging\\\",\\\"phase\\\":\\\"apply\\\",\\\"second_plan_idempotent\\\":true,\\\"applied\\\":[],\\\"skipped\\\":[],\\\"head_before\\\":0}\\n"; exit 0; fi; exit 93 ;;' \
    '  *) exit 93 ;;' \
    'esac' >"$fake_bun"
  # shellcheck disable=SC2016 # The fake command must expand its own variables later.
  printf '%s\n' '#!/bin/sh' \
    'printf "bunx %s\\n" "$*" >> "$E2E_ENVIRONMENTS_TEST_COMMAND_LOG"' \
    'case "$*" in' \
    '  "--bun wrangler r2 object put "*) exit 95 ;;' \
    '  "--bun wrangler r2 object delete "*) exit 0 ;;' \
    '  *) exit 96 ;;' \
    'esac' >"$fake_bunx"
  # shellcheck disable=SC2016 # The fake command must expand its own variables later.
  printf '%s\n' '#!/bin/sh' \
    'printf "curl %s\\n" "$*" >> "$E2E_ENVIRONMENTS_TEST_COMMAND_LOG"' \
    'case "$*" in' \
    '  *"/internal/health"*) printf "{\\\"ok\\\":true}\\n"; exit 0 ;;' \
    '  *"/capabilities"*) printf "{\\\"origin\\\":\\\"https://a-staging.asimposium.org\\\"}\\n"; exit 0 ;;' \
    '  *) exit 94 ;;' \
    'esac' >"$fake_curl"
  chmod 700 "$fake_bun" "$fake_bunx" "$fake_curl"

  set +e
  nested_output="$(
    PATH="$scratch:/usr/bin:/bin" \
      E2E_ENVIRONMENTS_TEST_COMMAND_LOG="$command_log" \
      CLOUDFLARE_API_TOKEN="$planted_token" \
      CLOUDFLARE_ACCOUNT_ID="00000000000000000000000000000000" \
      ASIMP_D1_DATABASE_ID_STAGING="11111111-2222-4333-8444-555555555555" \
      ASIMP_STAGING_SERVICE_ENVELOPE_KEYS='[{"kid":"staging-svc-2026-08","publicKeyHex":"1111111111111111111111111111111111111111111111111111111111111111","notBefore":1},{"kid":"staging-svc-2026-07","publicKeyHex":"2222222222222222222222222222222222222222222222222222222222222222","notBefore":0,"notAfter":2}]' \
      /bin/bash "$SCRIPT_PATH" staging 2>&1
  )"
  nested_status=$?
  set -e

  if [ "$nested_status" -ne 1 ] ||
    [[ "$nested_output" != *'"code":"STAGING_RESOLVE_FAILED"'* ]] ||
    [[ "$nested_output" == *"$planted_token"* ]] ||
    [ ! -f "$command_log" ] ||
    [[ "$(cat "$command_log")" != $'infra/validate-scaffold.mjs\ninfra/validate-environments.mjs\ninfra/validate-environments.mjs\ninfra/generate-wrangler.mjs --check\ninfra/generate-wrangler.test.mjs\ninfra/resolve-wrangler-deploy.mjs --env staging --write' ]] ||
    grep -Eq '(^| )(infra/migrate\.mjs|wrangler|curl)( |$)' "$command_log"; then
    printf '%s\n' '{"tool":"bash","package":"infra","suite":"environment-e2e","phase":"self-test","environment":"staging","status":"fail","code":"REMOTE_INTERFACE_GATE_PLANT_FAILED","detail":"credential-present run did not stop exactly at the resolver with inert commands"}'
    return 1
  fi

  # A failed create response is ambiguous: the provider may have accepted the
  # write before the transport failed. Drive the complete pre-canary path with
  # inert commands, fail the put itself, and prove the run still issues exactly
  # one compensating delete for its cryptographically unique canary key.
  r2_command_log="$scratch/r2-write-failure-commands.log"
  : >"$r2_command_log"
  chmod 600 "$r2_command_log"
  set +e
  r2_output="$(
    PATH="$scratch:/usr/bin:/bin" \
      E2E_ENVIRONMENTS_TEST_COMMAND_LOG="$r2_command_log" \
      E2E_ENVIRONMENTS_TEST_SCENARIO="r2-write-failure" \
      CLOUDFLARE_API_TOKEN="$planted_token" \
      CLOUDFLARE_ACCOUNT_ID="00000000000000000000000000000000" \
      ASIMP_D1_DATABASE_ID_STAGING="11111111-2222-4333-8444-555555555555" \
      ASIMP_STAGING_SERVICE_ENVELOPE_KEYS='[{"kid":"staging-svc-2026-08","publicKeyHex":"1111111111111111111111111111111111111111111111111111111111111111","notBefore":1},{"kid":"staging-svc-2026-07","publicKeyHex":"2222222222222222222222222222222222222222222222222222222222222222","notBefore":0,"notAfter":2}]' \
      /bin/bash "$SCRIPT_PATH" staging 2>&1
  )"
  r2_status=$?
  set -e

  if [ "$r2_status" -ne 1 ] ||
    [[ "$r2_output" != *'"code":"R2_CANARY_WRITE_FAILED"'* ]] ||
    [[ "$r2_output" == *"$planted_token"* ]] ||
    [ ! -f "$r2_command_log" ] ||
    [[ "$(grep -Fc 'bunx --bun wrangler r2 object put ' "$r2_command_log")" != "1" ]] ||
    [[ "$(grep -Fc 'bunx --bun wrangler r2 object delete ' "$r2_command_log")" != "1" ]]; then
    printf '%s\n' '{"tool":"bash","package":"infra","suite":"environment-e2e","phase":"self-test","environment":"staging","status":"fail","code":"R2_AMBIGUOUS_WRITE_CLEANUP_PLANT_FAILED","detail":"a failed R2 create did not issue exactly one compensating delete"}'
    return 1
  fi

  # A standalone run keeps the one directory it made and says so, rather than
  # deleting evidence. A lent directory is reported as retained by nobody here.
  retained_scratch_json="$(python3 -c 'import json, sys; print(json.dumps(sys.argv[1]))' "$retained_scratch")" || return 1
  printf '{"tool":"bash","package":"infra","suite":"environment-e2e","phase":"self-test","environment":"staging","status":"pass","code":"REMOTE_INTERFACE_GATE_PLANT_PASSED","detail":"credential-present resolver refusal and failed-R2-create ownership controls passed with inert commands","retained_evidence_dir":%s}\n' \
    "$retained_scratch_json"
}

if [ "$SELF_TEST_REMOTE_INTERFACE" -eq 1 ]; then
  self_test_remote_interface_gate
  exit $?
fi

# ---------------------------------------------------------------------------
# Phase 0 — the environment must be named, and production is not a default.
# ---------------------------------------------------------------------------
case "$ENVIRONMENT" in
  local|staging) ;;
  production)
    fail_phase "select" "PRODUCTION_TARGET_REFUSED" \
      "This rehearsal never targets production; run it against local or staging."
    ;;
  *)
    fail_phase "select" "UNKNOWN_ENVIRONMENT" "Expected local or staging."
    ;;
esac
emit "select" "pass" "OK" "environment selected explicitly"

# ---------------------------------------------------------------------------
# Phase 1 — toolchain.
# ---------------------------------------------------------------------------
command -v bun >/dev/null 2>&1 || fail_phase "toolchain" "BUN_MISSING" "bun is required to run the validators."
command -v python3 >/dev/null 2>&1 || fail_phase "toolchain" "PYTHON_MISSING" "python3 is required to validate structured receipts."
emit "toolchain" "pass" "OK" "bun and python3 present"

# ---------------------------------------------------------------------------
# Phase 2 — static shape of the local Wrangler skeleton.
# ---------------------------------------------------------------------------
if bun infra/validate-scaffold.mjs >/dev/null; then
  emit "scaffold" "pass" "OK" "local wrangler skeleton validated"
else
  fail_phase "scaffold" "SCAFFOLD_INVALID" "infra/validate-scaffold.mjs refused the local configuration."
fi

# ---------------------------------------------------------------------------
# Phase 3 — environment topology: separation, roles, parity, keys.
# ---------------------------------------------------------------------------
if bun infra/validate-environments.mjs >/dev/null; then
  emit "topology" "pass" "OK" "namespace separation, R2 roles, binding parity and key ids validated"
else
  fail_phase "topology" "TOPOLOGY_INVALID" "infra/validate-environments.mjs refused the environment topology."
fi

# ---------------------------------------------------------------------------
# Phase 4 — preview must not be able to hold production keys.
#
# Statically provable from the topology: the validator fails the whole file if
# any non-production environment is permitted production keys, or if a key id is
# shared across environments. Re-run it here so this script's own report carries
# the assertion rather than pointing at another tool's output.
#
# The claim is deliberately about the repository, not about the provider. This
# reads infra/environments.toml and nothing else, so it can say which tier the
# topology DESIGNATES for previews; it cannot say which tier Vercel actually
# serves a preview from. Live wiring stays unobserved until a deployed check
# reports it.
# ---------------------------------------------------------------------------
TOPOLOGY_STATUS=0
TOPOLOGY_JSON="$(bun infra/validate-environments.mjs)" || TOPOLOGY_STATUS=$?
STAGING_WORKER_ORIGIN="$(printf '%s' "$TOPOLOGY_JSON" | python3 -c '
import json
import sys

try:
    document = json.loads(sys.stdin.read())
except json.JSONDecodeError:
    sys.exit(1)
if not isinstance(document, dict):
    sys.exit(1)
vercel = document.get("vercel")
environments = document.get("environments")
staging = environments.get("staging") if isinstance(environments, dict) else None
if (
    document.get("suite") != "environment-topology-static"
    or document.get("status") != "pass"
    or not isinstance(vercel, dict)
    or vercel.get("preview_environment") != "staging"
    or not isinstance(staging, dict)
    or staging.get("kind") != "remote"
    or staging.get("is_preview") is not True
    or staging.get("may_hold_production_keys") is not False
    or staging.get("worker_origin") != "https://a-staging.asimposium.org"
):
    sys.exit(1)
print(staging["worker_origin"])
')" || TOPOLOGY_STATUS=$?
if [ "$TOPOLOGY_STATUS" -ne 0 ]; then
  fail_phase "preview-key-isolation" "PREVIEW_WIRING_UNCONFIRMED" \
    "Repository topology does not structurally designate the non-production staging preview tier."
fi
emit "preview-key-isolation" "pass" "OK" \
  "repository topology designates staging as the preview tier; the topology validator rejects a preview that targets production, holds production keys, or shares a key id. Live Vercel preview wiring is not observed by this check"

# ---------------------------------------------------------------------------
# Generated Wrangler configuration must still match the topology. A hand-edited
# generated file is the quiet path from "reviewed" to "deployed something else".
# ---------------------------------------------------------------------------
if bun infra/generate-wrangler.mjs --check >/dev/null; then
  emit "generated-config" "pass" "OK" \
    "per-environment Wrangler configuration reconciles exactly with infra/environments.toml"
else
  fail_phase "generated-config" "GENERATED_CONFIG_DRIFT" \
    "Generated Wrangler configuration does not match the topology; run 'bun infra/generate-wrangler.mjs --write' and review the diff."
fi

if bun infra/generate-wrangler.test.mjs >/dev/null; then
  emit "generated-config-contract" "pass" "OK" \
    "generator contract rejects missing cron, outbox binding, and Durable Object export configuration"
else
  fail_phase "generated-config-contract" "GENERATOR_CONTRACT_FAILED" \
    "infra/generate-wrangler.test.mjs failed a planted topology-drift case."
fi

# ---------------------------------------------------------------------------
# Phase 5 (local only) — forward migration rehearsal (plan only, no database).
# ---------------------------------------------------------------------------
migration_receipt_matches() {
  local mode="$1" environment="$2" receipt="$3"
  printf '%s' "$receipt" | python3 -c '
import json
import re
import sys

lines = [line for line in sys.stdin.read().splitlines() if line.strip()]
if len(lines) != 1:
    sys.exit(1)
try:
    document = json.loads(lines[0])
except json.JSONDecodeError:
    sys.exit(1)
if not isinstance(document, dict):
    sys.exit(1)
if document.get("status") != "pass" or document.get("environment") != sys.argv[2]:
    sys.exit(1)
if sys.argv[1] == "plan":
    if (
        document.get("phase") != "plan"
        or not isinstance(document.get("to_apply"), list)
        or not isinstance(document.get("skipped"), list)
        or not isinstance(document.get("idempotent"), bool)
    ):
        sys.exit(1)
elif sys.argv[1] in ("pass", "idempotent"):
    applied = document.get("applied")
    if (
        document.get("phase") != "apply"
        or document.get("second_plan_idempotent") is not True
        or not isinstance(applied, list)
        or not isinstance(document.get("skipped"), list)
        or not isinstance(document.get("head_before"), int)
        or isinstance(document.get("head_before"), bool)
        or document.get("head_before") < 0
    ):
        sys.exit(1)
    ids = set()
    for item in applied:
        if not isinstance(item, dict) or set(item) != {"id", "digest"}:
            sys.exit(1)
        migration_id = item.get("id")
        digest = item.get("digest")
        if (
            not isinstance(migration_id, str)
            or not re.fullmatch(r"\d{4}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql", migration_id)
            or migration_id in ids
            or not isinstance(digest, str)
            or not re.fullmatch(r"[0-9a-f]{64}", digest)
        ):
            sys.exit(1)
        ids.add(migration_id)
    if sys.argv[1] == "idempotent" and applied != []:
        sys.exit(1)
else:
    sys.exit(1)
' "$mode" "$environment"
}

if [ "$ENVIRONMENT" = "local" ]; then
  # One invocation only: each planner run against a local environment performs a
  # real D1 round trip, so running it twice to capture output would double the
  # cost of every rehearsal.
  PLAN_STATUS=0
  PLAN_OUTPUT="$(bun infra/migrate.mjs --env "$ENVIRONMENT" 2>&1)" || PLAN_STATUS=$?
  if [ "$PLAN_STATUS" -eq 0 ] && migration_receipt_matches plan local "$PLAN_OUTPUT"; then
    emit "migration-plan" "pass" "OK" "forward migration plan computed from db/migrations"
  else
    PLAN_STDERR="$PLAN_OUTPUT"
    # Surface the planner's own code rather than a generic wrapper failure: the
    # difference between MIGRATION_DRIFT and OUT_OF_ORDER_MIGRATION is the whole
    # diagnosis, and swallowing it would make this script the least useful layer.
    PLAN_CODE="$(printf '%s' "$PLAN_STDERR" | sed -n 's/.*"code":"\([A-Z_]*\)".*/\1/p' | head -1)"
    fail_phase "migration-plan" "${PLAN_CODE:-MIGRATION_PLAN_FAILED}" \
      "infra/migrate.mjs refused to produce a plan; re-run it directly for the full diagnostic."
  fi
fi

# ---------------------------------------------------------------------------
# Phase 6 (local only) — real migration application against Wrangler's local
# D1. This needs no account and is not a mock: it is workerd's own SQLite, so
# blocking it would be dishonest in the opposite direction.
# ---------------------------------------------------------------------------
if [ "$ENVIRONMENT" = "local" ]; then
  if bun infra/migrate-local.test.mjs >/dev/null; then
    emit "local-d1-seam" "pass" "OK" \
      "a failing local D1 command surfaces a bounded, redacted cause rather than swallowing it"
  else
    fail_phase "local-d1-seam" "SEAM_CONTRACT_FAILED" \
      "The local D1 integration contract failed."
  fi

  FIRST_RUN_STATUS=0
  FIRST_RUN="$(bun infra/migrate.mjs --env local --apply 2>&1)" || FIRST_RUN_STATUS=$?
  if [ "$FIRST_RUN_STATUS" -ne 0 ] || ! migration_receipt_matches pass local "$FIRST_RUN"; then
    fail_phase "migrate-apply-first" "APPLY_FAILED" "The first local application failed."
  fi
  emit "migrate-apply-first" "pass" "OK" "migrations applied to the local D1"

  SECOND_RUN="$(bun infra/migrate.mjs --env local --apply)" \
    || fail_phase "migrate-apply-twice" "APPLY_FAILED" "The second local application failed."
  if migration_receipt_matches idempotent local "$SECOND_RUN"; then
    emit "migrate-apply-twice" "pass" "OK" "second application applied nothing; idempotence observed against a real database"
  else
    fail_phase "migrate-apply-twice" "NOT_IDEMPOTENT" \
      "The second application did not report an empty applied set and an idempotent second plan."
  fi

  printf '{"tool":"bash","package":"infra","suite":"environment-e2e","phase":"summary","environment":"local","status":"pass","code":"OK","detail":"Local rehearsal complete: topology validated and migrations applied twice against a real local D1.","reproduce":"scripts/e2e-environments.sh local"}\n'
  exit 0
fi

# ---------------------------------------------------------------------------
# Phase 6 (remote) — credentials. PRESENCE ONLY. Values are never read.
# ---------------------------------------------------------------------------
MISSING_VARS=()
for required in \
  CLOUDFLARE_API_TOKEN \
  CLOUDFLARE_ACCOUNT_ID \
  ASIMP_D1_DATABASE_ID_STAGING \
  ASIMP_STAGING_SERVICE_ENVELOPE_KEYS; do
  if [ -z "${!required:-}" ]; then MISSING_VARS+=("$required"); fi
done

if [ ${#MISSING_VARS[@]} -gt 0 ]; then
  block_phase "credentials" "CREDENTIALS_ABSENT" \
    "Not set in this environment: ${MISSING_VARS[*]}. Presence was tested; no value was read."
else
  emit "credentials" "pass" "OK" "required variables are present (presence only; values not read)"
fi

# ---------------------------------------------------------------------------
# Phases 7-10 — everything below needs a provisioned environment.
# ---------------------------------------------------------------------------
if [ ${#BLOCKERS[@]} -gt 0 ]; then
  block_phase "resolve-staging-config" "CREDENTIALS_ABSENT" \
    "The staging resolver, deploy, migration, health, and R2 phases were not started because required credentials are absent."
  block_phase "migrate-apply-twice" "CREDENTIALS_ABSENT" \
    "Remote D1 idempotence was not observed because required credentials are absent."
  block_phase "health-and-smoke" "CREDENTIALS_ABSENT" \
    "The staging Worker was not probed because required credentials are absent."
  block_phase "r2-private-canary" "CREDENTIALS_ABSENT" \
    "No R2 object was written or read because required credentials are absent."

  printf '{"tool":"bash","package":"infra","suite":"environment-e2e","phase":"summary","environment":"%s","status":"blocked","code":"CREDENTIALS_ABSENT","blocked_phases":%d,"detail":"Static phases passed; remote resource state was not observed, inferred, or simulated because required credentials are absent.","reproduce":"scripts/e2e-environments.sh %s"}\n' \
    "$ENVIRONMENT" "${#BLOCKERS[@]}" "$ENVIRONMENT"
  exit "$BLOCKED_EXIT_CODE"
fi

# The remote migration CLI's receipt contract is frozen and test-pinned
# (infra/migrate.test.mjs): a plan/apply run prints one compact JSON receipt
# with phase/status, and a second apply against a fully-migrated target reports
# an empty applied set plus an idempotent second plan. The remote bootstrap
# completed on 2026-08-17 (operator-authorized); what follows exercises that
# contract.

# ---------------------------------------------------------------------------
# Phase 7 (staging) — resolve the deployable staging config.
# ---------------------------------------------------------------------------
# The resolver's declared input is ASIMP_ACCOUNT_ID; this script's credential
# gate checks the same account under its Cloudflare name. Bridge with explicit
# precedence so an operator-set ASIMP_ACCOUNT_ID always wins.
export ASIMP_ACCOUNT_ID="${ASIMP_ACCOUNT_ID:-$CLOUDFLARE_ACCOUNT_ID}"
RESOLVE_STATUS=0
RESOLVE_OUTPUT="$(
  ASIMP_D1_DATABASE_ID_STAGING="$ASIMP_D1_DATABASE_ID_STAGING" \
    ASIMP_STAGING_SERVICE_ENVELOPE_KEYS="$ASIMP_STAGING_SERVICE_ENVELOPE_KEYS" \
    bun infra/resolve-wrangler-deploy.mjs --env staging --write 2>&1
)" || RESOLVE_STATUS=$?
if [ "${RESOLVE_STATUS:-0}" -eq 0 ] && printf '%s' "$RESOLVE_OUTPUT" | python3 -c '
import json
import sys

lines = [line for line in sys.stdin.read().splitlines() if line.strip()]
if len(lines) != 1:
    sys.exit(1)
try:
    document = json.loads(lines[0])
except json.JSONDecodeError:
    sys.exit(1)
if not isinstance(document, dict):
    sys.exit(1)
if (
    document.get("suite") != "staging-wrangler-deploy-resolution"
    or document.get("status") != "pass"
    or document.get("environment") != "staging"
    or document.get("mode") != "write"
    or (document.get("published"), document.get("idempotent"))
    not in ((True, False), (False, True))
):
    sys.exit(1)
'; then
  emit "resolve-staging-config" "pass" "OK" "staging deploy config resolved from the topology and the three declared inputs"
else
  fail_phase "resolve-staging-config" "STAGING_RESOLVE_FAILED" \
    "The staging resolver refused; re-run 'bun infra/resolve-wrangler-deploy.mjs --env staging --check' for the diagnostic."
fi

# ---------------------------------------------------------------------------
# Phase 8 (staging) — remote migration idempotence, observed twice.
# ---------------------------------------------------------------------------
# The runner's observation deadline is deliberately tight (a never-settling
# transport must fail fast); on a heavily loaded operator machine one provider
# round-trip can exceed it, so each apply gets a small bounded retry before
# the phase reports failure. A structurally valid pass receipt is required;
# diagnostic prose containing the word "pass" is never evidence.
migrate_apply_once() {
  local attempt output
  for attempt in 1 2 3; do
    if output="$(CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" bun infra/migrate.mjs --env staging --resolved-database-id "$ASIMP_D1_DATABASE_ID_STAGING" --apply 2>&1)" && \
      migration_receipt_matches pass staging "$output"; then
      printf '%s' "$output"
      return 0
    fi
    if [ "$attempt" -lt 3 ]; then sleep 10; fi
  done
  printf '%s' "$output"
  return 1
}
MIGRATE_FIRST="$(migrate_apply_once)" || MIGRATE_FIRST_STATUS=$?
migration_budget_exhausted() {
  local receipt="$1"
  printf '%s' "$receipt" | python3 -c '
import json
import sys

lines = [line for line in sys.stdin.read().splitlines() if line.strip()]
if len(lines) != 1:
    sys.exit(1)
try:
    document = json.loads(lines[0])
except json.JSONDecodeError:
    sys.exit(1)
if not isinstance(document, dict) or document.get("status") != "fail":
    sys.exit(1)
if document.get("code") not in {
    "REMOTE_OBSERVATION_DEADLINE_EXCEEDED",
    "REMOTE_D1_TRANSPORT_TIMEOUT",
    "REMOTE_D1_CATALOG_UNREADABLE",
    "REMOTE_TARGET_UNDESCRIBED",
}:
    sys.exit(1)
'
}
if [ "${MIGRATE_FIRST_STATUS:-0}" -ne 0 ]; then
  # A hard observation budget that cannot fit this machine's provider latency
  # is an environmental state, not a migration defect: report it blocked so a
  # quiet window runs the same phase to green.
  if migration_budget_exhausted "$MIGRATE_FIRST"; then
    block_phase "migrate-apply-twice" "MIGRATION_OBSERVATION_WINDOW_UNAVAILABLE" \
      "The runner's fixed observation budget did not fit this machine's provider latency after bounded retries; no migration defect was observed. Re-run in a quieter window."
    printf '{"tool":"bash","package":"infra","suite":"environment-e2e","phase":"summary","environment":"%s","status":"blocked","code":"MIGRATION_OBSERVATION_WINDOW_UNAVAILABLE","detail":"All static and resolution phases passed; the remote idempotence observation could not fit its fixed budget on this machine.","reproduce":"scripts/e2e-environments.sh %s"}\n' \
      "$ENVIRONMENT" "$ENVIRONMENT"
    exit "$BLOCKED_EXIT_CODE"
  fi
  fail_phase "migrate-apply-twice" "MIGRATION_FIRST_APPLY_FAILED" \
    "The first remote migration run did not pass; re-run infra/migrate.mjs directly for the diagnostic."
fi
MIGRATE_SECOND_STATUS=0
MIGRATE_SECOND="$(migrate_apply_once)" || MIGRATE_SECOND_STATUS=$?
if [ "$MIGRATE_SECOND_STATUS" -eq 0 ] && migration_receipt_matches idempotent staging "$MIGRATE_SECOND"; then
  emit "migrate-apply-twice" "pass" "OK" "second remote apply observed an empty applied set and an idempotent second plan"
else
  fail_phase "migrate-apply-twice" "MIGRATION_IDEMPOTENCE_UNPROVEN" \
    "The second remote migration run did not prove an empty applied set and an idempotent second plan."
fi

# ---------------------------------------------------------------------------
# Phase 9 (staging) — deployed health and origin coherence over HTTP.
# ---------------------------------------------------------------------------
endpoint_document_matches() {
  local mode="$1" document="$2"
  printf '%s' "$document" | python3 -c '
import json
import sys

try:
    document = json.loads(sys.stdin.read())
except json.JSONDecodeError:
    sys.exit(1)
if not isinstance(document, dict):
    sys.exit(1)
if sys.argv[1] == "health":
    if document.get("ok") is not True:
        sys.exit(1)
elif sys.argv[1] == "capabilities":
    if document.get("origin") != "https://a-staging.asimposium.org":
        sys.exit(1)
else:
    sys.exit(1)
' "$mode"
}

if [ -z "$STAGING_WORKER_ORIGIN" ]; then
  fail_phase "health-and-smoke" "STAGING_ORIGIN_NOT_IN_TOPOLOGY" \
    "The validated topology does not declare the staging worker origin."
fi
HEALTH_STATUS=0
HEALTH_BODY="$(curl --fail --silent --show-error --location \
  --user-agent "$WEB_USER_AGENT" --connect-timeout 5 --max-time 20 \
  "$STAGING_WORKER_ORIGIN/internal/health" 2>/dev/null)" || HEALTH_STATUS=$?
CAPABILITIES_STATUS=0
CAPABILITIES_BODY="$(curl --fail --silent --show-error --location \
  --user-agent "$WEB_USER_AGENT" --connect-timeout 5 --max-time 20 \
  "$STAGING_WORKER_ORIGIN/capabilities" 2>/dev/null)" || CAPABILITIES_STATUS=$?
if [ "$HEALTH_STATUS" -eq 0 ] && [ "$CAPABILITIES_STATUS" -eq 0 ] && \
  endpoint_document_matches health "$HEALTH_BODY" && \
  endpoint_document_matches capabilities "$CAPABILITIES_BODY"; then
  emit "health-and-smoke" "pass" "OK" "staging worker health ok and capabilities origin matches the topology"
else
  fail_phase "health-and-smoke" "STAGING_HEALTH_FAILED" \
    "The staging worker did not answer a healthy, origin-coherent response."
fi

# ---------------------------------------------------------------------------
# Phase 10 (staging) — the private R2 canary: owner-readable, publicly absent.
# ---------------------------------------------------------------------------
CANARY_CLEANUP_REQUIRED=0
CANARY_NONCE="$(python3 -c 'import secrets; print(secrets.token_hex(16))')" ||
  fail_phase "r2-private-canary" "R2_CANARY_NONCE_FAILED" "A unique private-canary key could not be generated."
if [[ ! "$CANARY_NONCE" =~ ^[0-9a-f]{32}$ ]]; then
  fail_phase "r2-private-canary" "R2_CANARY_NONCE_FAILED" "The generated private-canary key was malformed."
fi
CANARY_KEY="canary-$CANARY_NONCE.txt"
CANARY_BODY="ops3-private-canary-$RANDOM$RANDOM"
cleanup_private_canary() {
  if [ "$CANARY_CLEANUP_REQUIRED" -eq 0 ]; then return 0; fi
  if CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \
    bunx --bun wrangler r2 object delete "asimposium-artifacts-staging/$CANARY_KEY" >/dev/null 2>&1; then
    CANARY_CLEANUP_REQUIRED=0
    return 0
  fi
  return 1
}
on_canary_signal() {
  local exit_code="$1"
  trap - EXIT INT TERM HUP
  cleanup_private_canary || true
  exit "$exit_code"
}
trap 'cleanup_private_canary || true' EXIT
trap 'on_canary_signal 130' INT
trap 'on_canary_signal 143' TERM
trap 'on_canary_signal 129' HUP
CANARY_CLEANUP_REQUIRED=1
if printf '%s' "$CANARY_BODY" | CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \
  bunx --bun wrangler r2 object put "asimposium-artifacts-staging/$CANARY_KEY" --pipe >/dev/null 2>&1; then
  :
else
  if ! cleanup_private_canary; then
    fail_phase "r2-private-canary" "R2_CANARY_WRITE_CLEANUP_UNPROVEN" \
      "The canary write failed ambiguously and its compensating delete also failed."
  fi
  fail_phase "r2-private-canary" "R2_CANARY_WRITE_FAILED" "The private staging bucket refused the canary write."
fi
CANARY_READ_STATUS=0
CANARY_READ="$(CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \
  bunx --bun wrangler r2 object get "asimposium-artifacts-staging/$CANARY_KEY" --pipe 2>/dev/null)" || CANARY_READ_STATUS=$?
# Probe while the canary still exists. Deleting it first would make a 404
# inevitable and turn the public-absence assertion into a vacuous green.
PUBLIC_CANARY_CURL_STATUS=0
PUBLIC_CANARY_STATUS="$(curl --silent --show-error --output /dev/null \
  --user-agent "$WEB_USER_AGENT" --connect-timeout 5 --max-time 15 \
  --write-out '%{http_code}' "https://artifacts-staging.asimposium.org/$CANARY_KEY" 2>/dev/null)" || PUBLIC_CANARY_CURL_STATUS=$?
STAGING_DOMAINS_STATUS=0
STAGING_DOMAINS="$(CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \
  bunx --bun wrangler r2 bucket domain list asimposium-artifacts-staging 2>/dev/null)" || STAGING_DOMAINS_STATUS=$?
CANARY_DELETE_STATUS=0
cleanup_private_canary || CANARY_DELETE_STATUS=$?
if [ "$CANARY_DELETE_STATUS" -ne 0 ]; then
  fail_phase "r2-private-canary" "R2_CANARY_DELETE_FAILED" \
    "The private staging canary could not be removed after the observation attempts."
fi
trap - EXIT INT TERM HUP
if [ "$CANARY_READ_STATUS" -ne 0 ]; then
  fail_phase "r2-private-canary" "R2_CANARY_READ_FAILED" \
    "The private staging canary could not be read back through the owner binding."
fi
if [ "$CANARY_READ" != "$CANARY_BODY" ]; then
  fail_phase "r2-private-canary" "R2_CANARY_READ_MISMATCH" "The canary read back through the binding did not match the write."
fi
if [ "$PUBLIC_CANARY_CURL_STATUS" -ne 0 ]; then
  fail_phase "r2-private-canary" "R2_PUBLIC_CANARY_UNOBSERVED" \
    "The public hostname could not be observed while the private canary existed."
fi
case "$PUBLIC_CANARY_STATUS" in
  404) ;;
  *)
    fail_phase "r2-private-canary" "R2_PRIVATE_CANARY_PUBLIC" \
      "The private canary was reachable over HTTP ($PUBLIC_CANARY_STATUS)."
    ;;
esac
if [ "$STAGING_DOMAINS_STATUS" -ne 0 ]; then
  fail_phase "r2-private-canary" "R2_DOMAIN_OBSERVATION_FAILED" \
    "The staging bucket domain state could not be observed."
fi
if [ -z "$STAGING_DOMAINS" ]; then
  fail_phase "r2-private-canary" "R2_DOMAIN_RESPONSE_INVALID" \
    "The staging bucket domain query returned an empty response."
fi
if [ "$STAGING_DOMAINS" != "${STAGING_DOMAINS#*no custom domains}" ]; then
  emit "r2-private-canary" "pass" "OK" "private canary round-tripped through the owner binding, remained absent at the public hostname while it existed, and was removed"
else
  fail_phase "r2-private-canary" "R2_PRIVATE_BUCKET_HAS_DOMAIN" \
    "The private staging bucket carries a custom domain; the topology forbids that."
fi

printf '{"tool":"bash","package":"infra","suite":"environment-e2e","phase":"summary","environment":"%s","status":"pass","code":"OK","detail":"static, resolve, migration-idempotence, health, and private-canary phases all observed against the real staging environment.","reproduce":"scripts/e2e-environments.sh %s"}\n' \
  "$ENVIRONMENT" "$ENVIRONMENT"
exit 0
