#!/usr/bin/env bash
# Environment end-to-end rehearsal (bead asimposiumorg-p1g, OPS.3).
#
# Runs every phase that can be executed honestly from a checkout, then stops at
# the first phase that needs a real Cloudflare environment and reports BLOCKED
# with the exact missing thing. It never deploys, never mutates a console, and
# never simulates a result it did not obtain.
#
#   exit 0  every phase that could run, ran and passed
#   exit 1  a phase ran and failed
#   exit 78 a phase could not run because an external prerequisite is absent
#           (EX_CONFIG; the repository-wide "deliberately blocked" convention)
#
# Diagnostics are one NDJSON record per phase on stdout: environment, phase,
# status, code, duration, and a reproduction command. Never a secret, a
# credential, a cookie, a token, a service signature, or a database row. The
# script tests only for the PRESENCE of credential variables and never prints,
# logs, exports, or interpolates their values.

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
  local scratch fake_bun fake_curl command_log nested_output nested_status
  local supplied scratch_mode scratch_owner retained_scratch
  local planted_token="asimp_ag_remote_e2e_canary_1234567890abcdefghijklmnop"

  # A caller that already owns a private directory may lend it, so a repeated
  # focused test run creates no additional directory. It is accepted only when
  # it is an absolute, existing, self-owned 0700 directory: a world-readable or
  # someone else's directory would put the planted credential canary and the
  # fake command shims somewhere another user can read or replace.
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
  else
    scratch="$(mktemp -d "${TMPDIR:-/tmp}/asimposium-environment-e2e.XXXXXX")" || {
      printf '%s\n' '{"tool":"bash","package":"infra","suite":"environment-e2e","phase":"self-test","environment":"staging","status":"fail","code":"SELF_TEST_SCRATCH_UNAVAILABLE","detail":"could not create bounded scratch"}'
      return 1
    }
    chmod 700 "$scratch"
    retained_scratch="$scratch"
  fi

  fake_bun="$scratch/bun"
  fake_curl="$scratch/curl"
  command_log="$scratch/commands.log"

  # The log is appended to by the fake commands, so a lent directory must start
  # this run empty or the exact-sequence comparison below would see the previous
  # run's entries. Truncation is not deletion: the file stays, at zero length.
  : >"$command_log"
  chmod 600 "$command_log"

  # shellcheck disable=SC2016 # The fake command must expand its own variables later.
  printf '%s\n' '#!/bin/sh' \
    'printf "%s\\n" "$*" >> "$E2E_ENVIRONMENTS_TEST_COMMAND_LOG"' \
    'case "$*" in' \
    '  "infra/validate-scaffold.mjs"|"infra/generate-wrangler.mjs --check"|"infra/generate-wrangler.test.mjs") exit 0 ;;' \
    '  "infra/validate-environments.mjs") printf "{\\\"preview_environment\\\":\\\"staging\\\"}\\n"; exit 0 ;;' \
    '  *) exit 93 ;;' \
    'esac' >"$fake_bun"
  # shellcheck disable=SC2016 # The fake command must expand its own variables later.
  printf '%s\n' '#!/bin/sh' \
    'printf "curl %s\\n" "$*" >> "$E2E_ENVIRONMENTS_TEST_COMMAND_LOG"' \
    'exit 94' >"$fake_curl"
  chmod 700 "$fake_bun" "$fake_curl"

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

  if [ "$nested_status" -ne "$BLOCKED_EXIT_CODE" ] ||
    [[ "$nested_output" != *'"code":"MIGRATION_REMOTE_INTERFACE_UNVERIFIED"'* ]] ||
    [[ "$nested_output" == *"$planted_token"* ]] ||
    [ ! -f "$command_log" ] ||
    [[ "$(cat "$command_log")" != $'infra/validate-scaffold.mjs\ninfra/validate-environments.mjs\ninfra/validate-environments.mjs\ninfra/generate-wrangler.mjs --check\ninfra/generate-wrangler.test.mjs' ]] ||
    grep -Eq '(^| )(infra/migrate\.mjs|infra/resolve-wrangler-deploy\.mjs|wrangler|curl)( |$)' "$command_log"; then
    printf '%s\n' '{"tool":"bash","package":"infra","suite":"environment-e2e","phase":"self-test","environment":"staging","status":"fail","code":"REMOTE_INTERFACE_GATE_PLANT_FAILED","detail":"credential-present gate reached an unapproved command or did not block exactly"}'
    return 1
  fi

  # A standalone run keeps the one directory it made and says so, rather than
  # deleting evidence. A lent directory is reported as retained by nobody here.
  printf '{"tool":"bash","package":"infra","suite":"environment-e2e","phase":"self-test","environment":"staging","status":"pass","code":"REMOTE_INTERFACE_GATE_PLANT_PASSED","detail":"credential-present nested run blocked before resolver, deploy, migration, or curl","retained_evidence_dir":"%s"}\n' \
    "$retained_scratch"
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
emit "toolchain" "pass" "OK" "bun present"

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
TOPOLOGY_JSON="$(bun infra/validate-environments.mjs)"
case "$TOPOLOGY_JSON" in
  *'"preview_environment":"staging"'*)
    emit "preview-key-isolation" "pass" "OK" \
      "repository topology designates staging as the preview tier; the topology validator rejects a preview that targets production, holds production keys, or shares a key id. Live Vercel preview wiring is not observed by this check"
    ;;
  *)
    fail_phase "preview-key-isolation" "PREVIEW_WIRING_UNCONFIRMED" \
      "Repository topology does not designate a non-production preview tier."
    ;;
esac

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
if [ "$ENVIRONMENT" = "local" ]; then
  # One invocation only: each planner run against a local environment performs a
  # real D1 round trip, so running it twice to capture output would double the
  # cost of every rehearsal.
  PLAN_STATUS=0
  PLAN_OUTPUT="$(bun infra/migrate.mjs --env "$ENVIRONMENT" 2>&1)" || PLAN_STATUS=$?
  if [ "$PLAN_STATUS" -eq 0 ]; then
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

  if ! bun infra/migrate.mjs --env local --apply >/dev/null; then
    fail_phase "migrate-apply-first" "APPLY_FAILED" "The first local application failed."
  fi
  emit "migrate-apply-first" "pass" "OK" "migrations applied to the local D1"

  SECOND_RUN="$(bun infra/migrate.mjs --env local --apply)" \
    || fail_phase "migrate-apply-twice" "APPLY_FAILED" "The second local application failed."
  case "$SECOND_RUN" in
    *'"applied":[]'*)
      emit "migrate-apply-twice" "pass" "OK" "second application applied nothing; idempotence observed against a real database"
      ;;
    *)
      fail_phase "migrate-apply-twice" "NOT_IDEMPOTENT" \
        "The second application was not a no-op."
      ;;
  esac

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

# The candidate remote migration CLI is owned by a concurrent OPS.3a change and
# has not yet been handed off with a frozen receipt contract. Do not resolve,
# deploy, or probe an account until the owner confirms its exact successful
# plan/apply fields and second-apply idempotence assertion. Calling a moving
# candidate here would turn source churn into a staging claim.
block_phase "migration-interface" "MIGRATION_REMOTE_INTERFACE_UNVERIFIED" \
  "The staging remote migration plan/apply candidate has no accepted receipt contract; no resolver, deploy, D1, R2, or HTTP operation was attempted."
printf '{"tool":"bash","package":"infra","suite":"environment-e2e","phase":"summary","environment":"%s","status":"blocked","code":"MIGRATION_REMOTE_INTERFACE_UNVERIFIED","detail":"Credentials were present, but the remote migration interface has not been handed off with its exact staging identity and idempotence receipt. No provider operation or local fallback occurred.","reproduce":"scripts/e2e-environments.sh %s"}\n' \
  "$ENVIRONMENT" "$ENVIRONMENT"
exit "$BLOCKED_EXIT_CODE"
