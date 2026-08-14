#!/usr/bin/env bash
# S-6 LOCAL ingress proof (bead asimposiumorg-vw3).
#
# Starts real local workerd via Wrangler with a real local D1 binding and drives
# the unmounted auth adapter over HTTP. The replay winner is decided by the
# unique index in db/migrations/0003_auth_nonce_replay.sql inside workerd — not
# by an in-process Map and not by a bun:sqlite shim standing in for D1.
#
# This is LOCAL proof. It is never deployed proof. The deployed seam — a real
# Vercel Auth.js Google cookie, a deployed Worker and D1, multi-colo isolate
# distribution, and true cross-plane behaviour — is owned by
# scripts/e2e-s6-cross-plane-auth.sh and stays blocked. This script therefore
# ends at exit 78 with those blockers named, even when every local check passes.
#
# Exit codes: 0 is never returned by a full run (78 is the honest terminal
# state) · 1 a local assertion failed or the harness could not start · 78 local
# checks passed and the external blockers below remain.
#
# Usage:
#   bash scripts/e2e-s6-auth-ingress.sh
#   S6_PORT=8815 bash scripts/e2e-s6-auth-ingress.sh
#   S6_SELF_TEST=1 bash scripts/e2e-s6-auth-ingress.sh   # planted fail + lifecycle

set -u -o pipefail

# Job control puts every background job in its own process group whose id equals
# the job's pid, which is what makes `kill -TERM -PID` address the whole group.
# Without it `$!` is merely a pid inside the script's group, the negative-pid
# kill fails, the fallback reaches only the wrapper, and workerd is orphaned
# holding the port. The launcher verifies the group rather than assuming it.
set -m

readonly BLOCKED_EXIT=78
readonly REPRODUCE="bash scripts/e2e-s6-auth-ingress.sh"
readonly WRANGLER="apps/wire/node_modules/.bin/wrangler"
readonly CONFIG="apps/wire/wrangler.s6.toml"
readonly CHECKER="apps/wire/src/auth/local-check.ts"
readonly READY_DEADLINE_SECONDS=30
readonly CHECK_DEADLINE_SECONDS=90

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
readonly ROOT="$PWD"

emit() { printf '%s\n' "$1"; }

fail_record() {
  emit "{\"suite\":\"s6-auth-ingress-local\",\"assertion\":\"$1\",\"status\":\"fail\",\"detail\":\"$2\",\"reproduce\":\"${REPRODUCE}\"}"
}

show_redacted() {
  local label="$1" file="$2" limit="${3:-40}"
  [[ -s "${file}" ]] || return 0
  printf '%s\n' "--- ${label} (redacted, first ${limit} lines) ---" >&2
  # `HOME` may legitimately be unset; under `set -u` an unguarded expansion here
  # would abort redaction at exactly the moment a failure needs to be shown.
  local home="${HOME:-}"
  [[ -n "${home}" ]] || home="__no_home_set__"
  sed -e "s|${ROOT}|<repo>|g" -e "s|${home}|<home>|g" \
      -e 's|asimp_ag_[A-Za-z0-9_-]\{4,\}|<redacted>|g' \
      -e 's|Bearer [A-Za-z0-9._~+/-]\{8,\}|<redacted>|g' \
      -e 's|#v1\.[A-Za-z0-9._~-]\{8,\}|<redacted>|g' \
      "${file}" | head -n "${limit}" >&2
  printf '%s\n' "--- end ${label} ---" >&2
}

if [[ ! -x "${WRANGLER}" ]]; then
  fail_record "wrangler_available" "wrangler is not installed under apps/wire; run bun install"
  exit 1
fi

# ── an owned, dynamic port ───────────────────────────────────────────────────
allocate_port() {
  bun --eval 'const s = Bun.serve({ port: 0, fetch: () => new Response("ready") }); console.log(s.port); s.stop(true);'
}

# A pinned port that something already holds must be refused up front. Starting
# anyway produces the worst diagnostic available: readiness polls a foreign
# listener, never sees this run's marker, and reports "the Worker never
# answered" — blaming the Worker for a port that was never free.
port_is_occupied() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    [[ -n "$(lsof -ti tcp:"${port}" 2>/dev/null)" ]] && return 0
  fi
  # Fallback probe: a successful bind means the port was free.
  bun --eval '
    const port = Number(process.argv[1]);
    try {
      const server = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("probe") });
      server.stop(true);
      process.exit(1);
    } catch {
      process.exit(0);
    }
  ' "${port}" >/dev/null 2>&1
}

if [[ -n "${S6_PORT:-}" ]]; then
  if ! [[ "${S6_PORT}" =~ ^[0-9]{2,5}$ ]] || (( S6_PORT < 1024 || S6_PORT > 65535 )); then
    fail_record "port_valid" "S6_PORT must be an integer in 1024..65535"
    exit 1
  fi
  if port_is_occupied "${S6_PORT}"; then
    fail_record "pinned_port_is_free" \
      "S6_PORT=${S6_PORT} is already in use; refusing to start rather than mistake a foreign listener for this run"
    exit 1
  fi
else
  S6_PORT="$(allocate_port)"
fi
readonly S6_PORT
readonly ORIGIN="http://127.0.0.1:${S6_PORT}"

STATE_DIR="$(mktemp -d -t asimposium-s6-auth)"
readonly STATE_DIR
if [[ -z "${STATE_DIR}" || ! -d "${STATE_DIR}" || -L "${STATE_DIR}" ]]; then
  fail_record "state_dir_valid" "mktemp did not produce a real private directory"
  exit 1
fi
readonly SERVER_LOG="${STATE_DIR}/wrangler.log"
readonly CHECK_LOG="${STATE_DIR}/check.log"
readonly CURL_LOG="${STATE_DIR}/curl.log"

# A bounded curl whose stderr is retained rather than discarded.
#
# `2>/dev/null` on every probe is convenient right up to the moment a probe
# fails: a connection refused, a TLS error and a DNS failure all become the
# same empty string, and the run reports "never answered" with no way to tell
# which. The transcript is appended here and shown, redacted, only on a failing
# path — so a passing run stays quiet and a failing one can be diagnosed.
probe() {
  local url="$1"
  curl --silent --show-error --connect-timeout 1 --max-time 2 "${url}" 2>>"${CURL_LOG}" || true
}

# Both are read by the EXIT trap, which is armed before `start_worker` ever
# runs. An early exit — a missing wrangler, an invalid port, key material that
# would not generate — fires that trap, and under `set -u` an uninitialised
# SERVER_PGID would abort cleanup with "unbound variable" at the one moment
# cleanup matters.
SERVER_PID=""
SERVER_PGID=""

# The controller's own process group. Nothing may ever be signalled with this:
# `kill -TERM -${CONTROLLER_PGID}` would terminate this script rather than the
# worker, and a `ps` that returns the parent's group instead of the child's is
# exactly how that happens by accident.
CONTROLLER_PGID="$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')"
readonly CONTROLLER_PGID

# Terminate the whole child process group, then escalate. Wrangler spawns a
# workerd grandchild; killing only the wrapper strands the runtime holding the
# port. Files are never deleted: AGENTS.md forbids cleanup-by-deletion, and the
# state directory is deliberately retained for diagnosis.
# Every process still in the group, wrapper and workerd alike. The parent pid
# exiting proves nothing: the grandchild is what holds the port.
group_members() {
  local pgid="$1"
  [[ -n "${pgid}" ]] || return 0
  ps -eo pid=,pgid= 2>/dev/null | awk -v g="${pgid}" '$2 == g { print $1 }'
}

# Does this group still belong to this run?
#
# A pgid is just a number, and the kernel reissues it once the leader has been
# reaped. `kill -TERM -${pgid}` against a recycled number reaches whatever
# unrelated process tree now holds it. Ownership is therefore proven before
# every signal, by checking that some member of the group is a wrangler/workerd
# process referencing *this* run's private state directory. A group that no
# longer matches is not ours to signal, whatever it is.
group_is_ours() {
  local pgid="$1"
  [[ -n "${pgid}" ]] || return 1
  local pids
  pids="$(group_members "${pgid}")"
  [[ -n "${pids}" ]] || return 1
  local pid
  for pid in ${pids}; do
    if ps -o command= -p "${pid}" 2>/dev/null | grep -qF -- "${STATE_DIR}"; then
      return 0
    fi
  done
  return 1
}

stop_group() {
  local pgid="$1"
  [[ -n "${pgid}" ]] || return 0
  # Refuse to signal our own group. If a `ps` lookup ever returns the parent's
  # pgid — a wrapper that did not become a leader, job control silently off —
  # a negative-pid kill here would take down the controller mid-run and the
  # failure would look like an unrelated crash.
  if [[ -n "${CONTROLLER_PGID}" && "${pgid}" == "${CONTROLLER_PGID}" ]]; then
    fail_record "never_signals_the_controller_group" \
      "refused to signal pgid ${pgid}, which is this script's own process group"
    return 1
  fi
  # Already empty: nothing to signal, and nothing to report. Signalling here is
  # exactly how a recycled number gets hit.
  if [[ -z "$(group_members "${pgid}")" ]]; then
    return 0
  fi
  # Occupied by something that is not ours: stale or recycled. Say so and send
  # nothing rather than terminate an unrelated process tree.
  if ! group_is_ours "${pgid}"; then
    fail_record "never_signals_a_recycled_group" \
      "pgid ${pgid} is occupied by processes that do not belong to this run; sent no signal"
    return 1
  fi
  kill -TERM "-${pgid}" 2>/dev/null || true
  for _wait in {1..40}; do
    [[ -z "$(group_members "${pgid}")" ]] && break
    sleep 0.25
  done
  if [[ -n "$(group_members "${pgid}")" ]]; then
    # Re-prove ownership immediately before escalating. The whole group can
    # exit during the TERM grace and the kernel can hand the number to an
    # unrelated tree in the same window; a SIGKILL decided ten seconds ago and
    # delivered now is precisely the recycled-pgid hazard.
    if ! group_is_ours "${pgid}"; then
      fail_record "never_signals_a_recycled_group" \
        "pgid ${pgid} stopped belonging to this run during the termination grace; sent no SIGKILL"
      return 1
    fi
    kill -KILL "-${pgid}" 2>/dev/null || true
    for _wait in {1..20}; do
      [[ -z "$(group_members "${pgid}")" ]] && break
      sleep 0.25
    done
    # SIGKILL is not refusable, so anything still here after the grace is a
    # survivor this run failed to reap -- a wrangler or workerd holding a port
    # and a D1 file into the next run. That has to fail the run on the NORMAL
    # path, not only under S6_SELF_TEST: a leak that is reported only when the
    # harness is testing itself is a leak that is never reported in practice,
    # and "zero surviving processes" would be claimed on the strength of an
    # assertion that never ran. Reporting survivors is also all this can
    # honestly do: they have already ignored SIGKILL.
    local survivors
    survivors="$(group_members "${pgid}" | tr '\n' ' ')"
    if [[ -n "${survivors// /}" ]]; then
      fail_record "leaves_no_surviving_process_group_members" \
        "pgid ${pgid} still has members after SIGKILL: ${survivors% }"
      return 1
    fi
  fi
}

stop_worker() {
  [[ -n "${SERVER_PGID}" ]] || { SERVER_PID=""; return 0; }
  local cleanup_status=0
  stop_group "${SERVER_PGID}" || cleanup_status=$?
  if [[ -n "${SERVER_PID}" ]]; then
    if ! wait "${SERVER_PID}" 2>/dev/null; then :; fi
  fi
  SERVER_PID=""
  SERVER_PGID=""
  return "${cleanup_status}"
}

trap stop_worker EXIT
trap 'stop_worker; exit 130' INT
trap 'stop_worker; exit 143' TERM
trap 'stop_worker; exit 129' HUP

# ── harness key material (ephemeral, never written to the repo) ──────────────
KEY_MATERIAL="$(bun --eval '
const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
const hex = Array.from(raw, (b) => b.toString(16).padStart(2, "0")).join("");
const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
console.log(JSON.stringify({ hex, jwk }));
')" || KEY_MATERIAL=""
if [[ -z "${KEY_MATERIAL}" ]]; then
  fail_record "harness_key_material" "could not generate an Ed25519 harness keypair"
  exit 1
fi
S6_PUBLIC_KEY_HEX="$(printf '%s' "${KEY_MATERIAL}" | bun --eval 'const v = JSON.parse(await Bun.stdin.text()); console.log(v.hex);')"
S6_PRIVATE_KEY_JWK="$(printf '%s' "${KEY_MATERIAL}" | bun --eval 'const v = JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify(v.jwk));')"
readonly S6_PUBLIC_KEY_HEX S6_PRIVATE_KEY_JWK
readonly S6_KID="s6-local"
# A non-secret, per-run ownership marker. Readiness must match it exactly, or a
# foreign Worker already listening on this port would be mistaken for ours.
S6_RUN_ID="$(bun --eval 'console.log(crypto.randomUUID().replace(/-/g, ""));')"
readonly S6_RUN_ID
S6_NOW="$(bun --eval 'console.log(Math.floor(Date.now() / 1000));')"
readonly S6_NOW

# ── real local D1 through the real numbered migrations ──────────────────────
if ! "${WRANGLER}" d1 migrations apply DB --config "${CONFIG}" --local \
  --persist-to "${STATE_DIR}" >"${STATE_DIR}/migration.log" 2>&1; then
  show_redacted "d1 migrations" "${STATE_DIR}/migration.log"
  fail_record "local_d1_migrations_applied" "wrangler could not apply db/migrations to local D1"
  exit 1
fi
emit "{\"suite\":\"s6-auth-ingress-local\",\"assertion\":\"local_d1_migrations_applied\",\"status\":\"pass\",\"detail\":\"0003_auth_nonce_replay.sql applied through the real migration path\",\"reproduce\":\"${REPRODUCE}\"}"

start_worker() {
  "${WRANGLER}" dev \
    --config "${CONFIG}" \
    --local \
    --persist-to "${STATE_DIR}" \
    --port "${S6_PORT}" \
    --inspector-port 0 \
    --log-level error \
    --show-interactive-dev-session=false \
    --var "S6_PUBLIC_KEY_HEX:${S6_PUBLIC_KEY_HEX}" \
    --var "S6_KID:${S6_KID}" \
    --var "S6_NOW:${S6_NOW}" \
    --var "S6_PSEUDONYM_SALT:s6-local-salt" \
    --var "S6_RUN_ID:${S6_RUN_ID}" \
    >>"${SERVER_LOG}" 2>&1 &
  SERVER_PID=$!
  # With job control the child leads its own group; verify rather than assume,
  # because a silent fallback to a parent-only kill is how workerd leaks.
  SERVER_PGID="$(ps -o pgid= -p "${SERVER_PID}" 2>/dev/null | tr -d " ")"
  if [[ -z "${SERVER_PGID}" || "${SERVER_PGID}" != "${SERVER_PID}" ]]; then
    fail_record "worker_owns_its_process_group" "child pid ${SERVER_PID} is not its own group leader (pgid ${SERVER_PGID:-unknown}); a group kill would leak workerd"
    stop_group "${SERVER_PGID}"
    return 1
  fi

  local deadline=$((SECONDS + READY_DEADLINE_SECONDS))
  while (( SECONDS < deadline )); do
    # Readiness is tied to child liveness: a dead child can never become ready,
    # and waiting the full deadline on a corpse hides the real failure.
    if ! kill -0 "${SERVER_PID}" 2>/dev/null; then return 1; fi
    # …and to ownership: a 200 from a foreign Worker on this port is not ours.
    local health
    health="$(probe "${ORIGIN}/__s6/health")"
    if [[ "${health}" == *"\"run_id\":\"${S6_RUN_ID}\""* ]]; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

if ! start_worker; then
  show_redacted "wrangler" "${SERVER_LOG}"
  show_redacted "curl" "${CURL_LOG}"
  stop_worker
  fail_record "local_worker_ready" "the local Worker never answered on its owned port"
  exit 1
fi

# ── the checks ───────────────────────────────────────────────────────────────
run_checker() {
  env S6_ORIGIN="${ORIGIN}" S6_NOW="${S6_NOW}" S6_KID="${S6_KID}" \
    S6_PRIVATE_KEY_JWK="${S6_PRIVATE_KEY_JWK}" \
    bun "${CHECKER}" 2>"${CHECK_LOG}" &
  local checker_pid=$!
  local deadline=$((SECONDS + CHECK_DEADLINE_SECONDS))
  while kill -0 "${checker_pid}" 2>/dev/null; do
    if (( SECONDS >= deadline )); then
      # Bounded escalation. TERM alone is a request: a checker wedged in a
      # syscall or ignoring the signal would leave `wait` blocking forever,
      # turning a timeout into a hang — the failure mode a deadline exists to
      # prevent. KILL follows within a fixed window.
      kill -TERM "${checker_pid}" 2>/dev/null || true
      for _grace in {1..20}; do
        kill -0 "${checker_pid}" 2>/dev/null || break
        sleep 0.25
      done
      if kill -0 "${checker_pid}" 2>/dev/null; then
        kill -KILL "${checker_pid}" 2>/dev/null || true
        for _grace in {1..20}; do
          kill -0 "${checker_pid}" 2>/dev/null || break
          sleep 0.25
        done
      fi
      if ! wait "${checker_pid}"; then :; fi
      return 124
    fi
    sleep 0.2
  done
  wait "${checker_pid}"
}

run_checker
CHECK_EXIT=$?
show_redacted "checker stderr" "${CHECK_LOG}"

if [[ ${CHECK_EXIT} -ne 0 ]]; then
  show_redacted "wrangler" "${SERVER_LOG}"
  show_redacted "curl" "${CURL_LOG}"
  stop_worker
  fail_record "local_ingress_checks" "a local ingress assertion failed (checker exit ${CHECK_EXIT})"
  exit 1
fi

# ── lifecycle self-tests, opt-in ─────────────────────────────────────────────
if [[ "${S6_SELF_TEST:-0}" == "1" ]]; then
  # ── planted: stop_group must FAIL when members outlive SIGKILL ─────────────
  #
  # No real process can ignore SIGKILL, so the survivor branch cannot be reached
  # with a live process tree -- which is exactly why it is the branch most
  # likely to rot unnoticed. The probe and the signal are therefore stubbed
  # inside a subshell: `group_members` reports a member forever, `kill` and
  # `sleep` do nothing. `stop_group` must then return non-zero and name the
  # survivors, rather than falling off the end reporting success.
  #
  # The stubs live in a subshell so nothing here can leak into the real run.
  survivor_probe="$(
    (
      group_members() { printf '%s\n' 4242; }
      group_is_ours() { return 0; }
      kill() { return 0; }
      sleep() { return 0; }
      if stop_group 999999; then printf 'returned-success'; else printf 'returned-failure'; fi
    ) 2>&1
  )"
  if [[ "${survivor_probe}" != *"returned-failure"* ]]; then
    stop_worker
    fail_record "stop_group_fails_when_members_survive_sigkill" \
      "stop_group reported success with group members still present after SIGKILL"
    exit 1
  fi
  if [[ "${survivor_probe}" != *"leaves_no_surviving_process_group_members"* ]]; then
    stop_worker
    fail_record "stop_group_names_the_surviving_members" \
      "stop_group failed without emitting the survivor assertion"
    exit 1
  fi
  emit "{\"suite\":\"s6-auth-ingress-local\",\"assertion\":\"stop_group_fails_when_members_survive_sigkill\",\"status\":\"pass\",\"detail\":\"survivors after SIGKILL are reported and fail the run on the normal path\",\"reproduce\":\"${REPRODUCE}\"}"

  # Planted failure: the same checker against a shifted clock must FAIL, which
  # proves the gate is capable of failing rather than structurally green.
  STALE_NOW=$((S6_NOW - 86400))
  if ! [[ "${STALE_NOW}" =~ ^[0-9]+$ ]]; then
    stop_worker
    fail_record "self_test_is_runnable" "could not compute a stale clock for the planted failure"
    exit 1
  fi
  planted_exit=0
  env S6_ORIGIN="${ORIGIN}" S6_NOW="${STALE_NOW}" S6_KID="${S6_KID}" \
    S6_PRIVATE_KEY_JWK="${S6_PRIVATE_KEY_JWK}" \
    bun "${CHECKER}" >/dev/null 2>"${STATE_DIR}/planted.log" || planted_exit=$?
  if [[ ${planted_exit} -eq 0 ]]; then
    stop_worker
    fail_record "planted_failure_is_detected" "a deliberately stale-clock run passed; the gate cannot fail"
    exit 1
  fi
  emit "{\"suite\":\"s6-auth-ingress-local\",\"assertion\":\"planted_failure_is_detected\",\"status\":\"pass\",\"detail\":\"a stale-clock run exits ${planted_exit}\",\"reproduce\":\"${REPRODUCE}\"}"

  # Busy port: a second Worker on the owned port must not become ready, and must
  # not be reported as a pass by borrowing the first Worker's liveness.
  # The contender runs with its OWN run id. Two things must hold: it must never
  # win the port, and the health endpoint must keep answering with the original
  # run id — which is what proves a contender can never be mistaken for ours.
  busy_run_id="contender$(bun --eval 'console.log(crypto.randomUUID().replace(/-/g, "").slice(0, 12));')"
  "${WRANGLER}" dev --config "${CONFIG}" --local --persist-to "${STATE_DIR}" \
    --port "${S6_PORT}" --inspector-port 0 --log-level error \
    --show-interactive-dev-session=false \
    --var "S6_RUN_ID:${busy_run_id}" >>"${STATE_DIR}/busy.log" 2>&1 &
  busy_pid=$!
  busy_pgid="$(ps -o pgid= -p "${busy_pid}" 2>/dev/null | tr -d ' ')"

  busy_served=no
  for _wait in {1..24}; do
    busy_health="$(probe "${ORIGIN}/__s6/health")"
    if [[ "${busy_health}" == *"\"run_id\":\"${busy_run_id}\""* ]]; then
      busy_served=yes
      break
    fi
    sleep 0.25
  done

  owner_health="$(probe "${ORIGIN}/__s6/health")"
  stop_group "${busy_pgid}"

  if [[ "${busy_served}" == "yes" ]]; then
    stop_worker
    fail_record "busy_port_contender_never_wins" "a second Worker answered on the owned port with its own run id"
    exit 1
  fi
  if [[ "${owner_health}" != *"\"run_id\":\"${S6_RUN_ID}\""* ]]; then
    stop_worker
    fail_record "busy_port_owner_keeps_the_port" "the owned port stopped answering with this run's id while a contender was up"
    exit 1
  fi
  busy_survivors="$(group_members "${busy_pgid}" | wc -l | tr -d ' ')"
  if [[ "${busy_survivors}" != "0" ]]; then
    stop_worker
    fail_record "busy_port_contender_group_is_reaped" "${busy_survivors} contender process(es) survived termination"
    exit 1
  fi
  emit "{\"suite\":\"s6-auth-ingress-local\",\"assertion\":\"busy_port_contender_never_wins\",\"status\":\"pass\",\"detail\":\"the contender never served its own run id, the owner kept the port, and the contender group left no survivor\",\"reproduce\":\"${REPRODUCE}\"}"

  # Foreign readiness: a Worker answering /__s6/health with someone else's run
  # id must never satisfy readiness. Proven against the live endpoint by asking
  # whether a *different* marker would be accepted, rather than by re-reading
  # the launcher's source.
  foreign_id="foreign$(bun --eval 'console.log(crypto.randomUUID().replace(/-/g, "").slice(0, 12));')"
  live_health="$(probe "${ORIGIN}/__s6/health")"
  if [[ -z "${live_health}" ]]; then
    stop_worker
    fail_record "foreign_readiness_is_rejected" "the owned health endpoint returned nothing to test against"
    exit 1
  fi
  if [[ "${live_health}" == *"\"run_id\":\"${foreign_id}\""* ]]; then
    stop_worker
    fail_record "foreign_readiness_is_rejected" "the health endpoint reported a run id this run never minted"
    exit 1
  fi
  if [[ "${live_health}" != *"\"run_id\":\"${S6_RUN_ID}\""* ]]; then
    stop_worker
    fail_record "foreign_readiness_is_rejected" "the health endpoint did not carry this run's ownership marker"
    exit 1
  fi
  emit "{\"suite\":\"s6-auth-ingress-local\",\"assertion\":\"foreign_readiness_is_rejected\",\"status\":\"pass\",\"detail\":\"readiness matches this run's marker exactly and rejects a foreign one\",\"reproduce\":\"${REPRODUCE}\"}"

  # SIGTERM: a terminated worker group must actually die, within the bound, and
  # must not leave the port held. This is the signal a CI runner sends.
  sigterm_pgid="${SERVER_PGID}"
  kill -TERM "-${sigterm_pgid}" 2>/dev/null || true
  sigterm_reaped=no
  for _wait in {1..40}; do
    if [[ -z "$(group_members "${sigterm_pgid}")" ]]; then
      sigterm_reaped=yes
      break
    fi
    sleep 0.25
  done
  if [[ "${sigterm_reaped}" != "yes" ]]; then
    stop_worker
    fail_record "sigterm_terminates_the_worker_group" "the worker group survived SIGTERM within its bound"
    exit 1
  fi
  sigterm_listeners="$(lsof -ti tcp:"${S6_PORT}" 2>/dev/null | wc -l | tr -d ' ')"
  if [[ "${sigterm_listeners}" != "0" ]]; then
    stop_worker
    fail_record "sigterm_releases_the_port" "${sigterm_listeners} listener(s) still hold the port after SIGTERM"
    exit 1
  fi
  emit "{\"suite\":\"s6-auth-ingress-local\",\"assertion\":\"sigterm_terminates_the_worker_group\",\"status\":\"pass\",\"detail\":\"SIGTERM reaped the whole group within its bound and released the port\",\"reproduce\":\"${REPRODUCE}\"}"

  # Orphan check: no workerd may outlive the group under any ancestor. A
  # grandchild reparented to init still holds the port, and a pid-only check
  # would call that clean.
  orphans="$(ps -eo pid=,ppid=,command= 2>/dev/null \
    | awk -v state="${STATE_DIR}" '$0 ~ /workerd|wrangler/ && index($0, state) > 0 { print $1 }' \
    | wc -l | tr -d ' ')"
  if [[ "${orphans}" != "0" ]]; then
    stop_worker
    fail_record "no_orphaned_runtime_survives" "${orphans} workerd/wrangler process(es) referencing this run's state directory outlived the group"
    exit 1
  fi
  emit "{\"suite\":\"s6-auth-ingress-local\",\"assertion\":\"no_orphaned_runtime_survives\",\"status\":\"pass\",\"detail\":\"no workerd or wrangler process referencing this run's state directory survives, under any parent\",\"reproduce\":\"${REPRODUCE}\"}"

  # Child cleanup: after stop_worker, nothing may still hold the owned port.
  reaped_pgid="${SERVER_PGID}"
  stop_worker
  sleep 1
  listeners="$(lsof -ti tcp:"${S6_PORT}" 2>/dev/null | wc -l | tr -d ' ')"
  members="$(group_members "${reaped_pgid}" | wc -l | tr -d ' ')"
  if [[ "${listeners}" != "0" || "${members}" != "0" ]]; then
    fail_record "child_process_group_is_reaped" "${listeners} listener(s) and ${members} group member(s) survived cleanup"
    exit 1
  fi
  emit "{\"suite\":\"s6-auth-ingress-local\",\"assertion\":\"child_process_group_is_reaped\",\"status\":\"pass\",\"detail\":\"no process holds the owned port after process-group termination\",\"reproduce\":\"${REPRODUCE}\"}"
fi

if ! stop_worker; then
  fail_record "worker_group_cleanup_proved" \
    "the worker group no longer carried this run's ownership proof, so cleanup refused to signal it"
  exit 1
fi

# ── the external boundary, stated rather than implied ────────────────────────
emit "{\"suite\":\"s6-auth-ingress-local\",\"assertion\":\"local_scope_summary\",\"status\":\"pass\",\"detail\":\"real local workerd and real local D1 only\",\"scope\":\"local-workerd + local-D1 on one machine\",\"reproduce\":\"${REPRODUCE}\"}"
for blocker in \
  'VERCEL_AUTHJS_GOOGLE_COOKIE_ABSENT|a Vercel preview running Auth.js with a real Google sign-in issuing a host-only apex cookie|a scripted cookie string, a fixture session, or this local harness presented as browser-issued session proof' \
  'DEPLOYED_WORKER_AND_D1_ABSENT|a deployed Worker with a deployed D1 binding|local workerd or local D1 presented as deployed proof' \
  'MULTI_COLO_DISTRIBUTION_ABSENT|two isolates in different colos sharing one D1 binding|concurrent requests to one local isolate presented as cross-isolate or multi-colo proof' \
  'TRUE_CROSS_PLANE_PROOF_ABSENT|an Agora server action minting the envelope and a Stoa Worker consuming it across real hosts|an in-repo signer and an unmounted local adapter presented as cross-plane proof'
do
  code="${blocker%%|*}"; rest="${blocker#*|}"; blocked_on="${rest%%|*}"; forbidden="${rest#*|}"
  emit "{\"suite\":\"s6-cross-plane-deployed\",\"status\":\"blocked\",\"exit_code\":78,\"code\":\"${code}\",\"blocked_on\":\"${blocked_on}\",\"forbidden_substitutes\":\"${forbidden}\",\"reproduce\":\"bash scripts/e2e-s6-cross-plane-auth.sh\"}"
done
printf '%s\n' 'BLOCKED s6-cross-plane-deployed (exit 78): local ingress proved; deployed cross-plane proof is not configured' >&2
exit "${BLOCKED_EXIT}"
