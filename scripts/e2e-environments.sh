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

ENVIRONMENT="${1:-staging}"
BLOCKED_EXIT_CODE=78
STARTED_AT_NS=$(date +%s000000000 2>/dev/null || echo 0)
BLOCKERS=()

now_ms() { echo $(( ($(date +%s) * 1000) )); }

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
# ---------------------------------------------------------------------------
TOPOLOGY_JSON="$(bun infra/validate-environments.mjs)"
case "$TOPOLOGY_JSON" in
  *'"preview_environment":"staging"'*)
    emit "preview-key-isolation" "pass" "OK" \
      "Vercel previews are wired to staging; the topology validator rejects a preview that targets production, holds production keys, or shares a key id"
    ;;
  *)
    fail_phase "preview-key-isolation" "PREVIEW_WIRING_UNCONFIRMED" \
      "Could not confirm Vercel previews are wired to a non-production preview tier."
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
# Phase 5 — forward migration rehearsal (plan only, no database).
# ---------------------------------------------------------------------------
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
for required in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID ASIMP_D1_DATABASE_ID_STAGING; do
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
  block_phase "deploy-disposable-revision" "ENVIRONMENT_NOT_PROVISIONED" \
    "No D1 database, R2 buckets, or Durable Object namespace exists for ${ENVIRONMENT}."
  block_phase "migrate-apply-twice" "ENVIRONMENT_NOT_PROVISIONED" \
    "Idempotence must be observed against a real D1; the planner is unit-tested but has applied nothing."
  block_phase "health-and-smoke" "ENVIRONMENT_NOT_PROVISIONED" \
    "No deployed Worker to probe."
  block_phase "r2-private-canary" "ENVIRONMENT_NOT_PROVISIONED" \
    "Proving a private-only object is unreachable through every public hostname requires real buckets and custom domains."

  printf '{"tool":"bash","package":"infra","suite":"environment-e2e","phase":"summary","environment":"%s","status":"blocked","code":"EXTERNAL_PREREQUISITE_MISSING","blocked_phases":%d,"detail":"Local phases passed; every phase requiring a provisioned Cloudflare environment was skipped and reported, not simulated.","reproduce":"scripts/e2e-environments.sh %s"}\n' \
    "$ENVIRONMENT" "${#BLOCKERS[@]}" "$ENVIRONMENT"
  exit "$BLOCKED_EXIT_CODE"
fi

# Reached only when a real environment exists. Deliberately not implemented
# against an imagined account: the deploy, apply-twice, smoke, and private-canary
# phases are written when there is something to run them against.
block_phase "deploy-disposable-revision" "NOT_IMPLEMENTED" \
  "Credentials are present but the deploy path has never been exercised; it must be written against a real environment, not guessed."
printf '{"tool":"bash","package":"infra","suite":"environment-e2e","phase":"summary","environment":"%s","status":"blocked","code":"DEPLOY_PATH_UNWRITTEN","reproduce":"scripts/e2e-environments.sh %s"}\n' \
  "$ENVIRONMENT" "$ENVIRONMENT"
exit "$BLOCKED_EXIT_CODE"
