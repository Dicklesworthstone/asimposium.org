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
# Exit codes: normal mode returns 1 for a local/harness failure or 78 after all
# local checks pass because the deployed blockers below remain. S6_SELF_TEST=1
# is a harness test, not S-6 evidence: expected planted failures are emitted as
# `status:"expected_negative"`, and a successful self-test ends with one
# `self_test_complete` JSON record and exit 0.
#
# Usage:
#   bash scripts/e2e-s6-auth-ingress.sh
#   S6_PORT=8815 bash scripts/e2e-s6-auth-ingress.sh
#   S6_SELF_TEST=1 bash scripts/e2e-s6-auth-ingress.sh   # expected negatives + lifecycle; exit 0

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
# One wall-clock ceiling for this script, independent of Bun's configuration.
# Work stops at 180 seconds so the last 30 seconds are reserved for its bounded
# EXIT finalizer. The test wrapper's 230-second inner budget therefore has a
# real script-owned deadline to rely on rather than an inert root bunfig value.
readonly SCRIPT_TOTAL_DEADLINE_SECONDS=210
readonly SCRIPT_CLEANUP_RESERVE_SECONDS=30
readonly SCRIPT_WORK_DEADLINE=$((SECONDS + SCRIPT_TOTAL_DEADLINE_SECONDS - SCRIPT_CLEANUP_RESERVE_SECONDS))
readonly SCRIPT_FINAL_DEADLINE=$((SECONDS + SCRIPT_TOTAL_DEADLINE_SECONDS))
readonly REDACTION_REPOSITORY="<repo>"
readonly REDACTION_HOME="<home>"
readonly REDACTION_SECRET="<redacted>"

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
readonly ROOT="$PWD"

emit() { printf '%s\n' "$1"; }

fail_record() {
  # Only the assertion deliberately injected by a self-test may be classified
  # as expected-negative. A blanket context used to hide a real launcher or
  # cleanup failure behind the planted fault's status.
  if [[ -n "${EXPECTED_NEGATIVE_ASSERTION:-}" && "$1" == "${EXPECTED_NEGATIVE_ASSERTION}" ]]; then
    expected_negative_record "$1" "$2"
    return 0
  fi
  emit "{\"suite\":\"s6-auth-ingress-local\",\"assertion\":\"$1\",\"status\":\"fail\",\"detail\":\"$2\",\"reproduce\":\"${REPRODUCE}\"}"
}

expected_negative_record() {
  emit "{\"suite\":\"s6-auth-ingress-local\",\"assertion\":\"$1\",\"status\":\"expected_negative\",\"detail\":\"$2\",\"reproduce\":\"S6_SELF_TEST=1 ${REPRODUCE}\"}"
}

lifecycle_capability_block() {
  local code="$1" blocked_on="$2"
  if [[ "${LIFECYCLE_CAPABILITY_BLOCK_REPORTED:-0}" != "1" ]]; then
    emit "{\"suite\":\"s6-auth-ingress-local\",\"status\":\"blocked\",\"exit_code\":78,\"code\":\"${code}\",\"blocked_on\":\"${blocked_on}\",\"forbidden_substitutes\":\"an empty or failed inspection presented as zero surviving runtime\",\"reproduce\":\"${REPRODUCE}\"}"
    LIFECYCLE_CAPABILITY_BLOCK_REPORTED=1
  fi
}

deadline_after_work() {
  local requested="$1" deadline
  deadline=$((SECONDS + requested))
  (( deadline > SCRIPT_WORK_DEADLINE )) && deadline="${SCRIPT_WORK_DEADLINE}"
  printf '%s\n' "${deadline}"
}

deadline_after_cleanup() {
  local requested="$1" deadline
  deadline=$((SECONDS + requested))
  (( deadline > SCRIPT_FINAL_DEADLINE )) && deadline="${SCRIPT_FINAL_DEADLINE}"
  printf '%s\n' "${deadline}"
}

assert_work_budget() {
  if (( SECONDS >= SCRIPT_WORK_DEADLINE )); then
    fail_record "script_deadline_exhausted" \
      "the ${SCRIPT_TOTAL_DEADLINE_SECONDS}-second script budget reached its cleanup reserve"
    return 1
  fi
}

SELF_TEST="${S6_SELF_TEST:-0}"
SELF_TEST_NESTED="${S6_SELF_TEST_NESTED:-0}"
if [[ "${SELF_TEST}" != "0" && "${SELF_TEST}" != "1" ]]; then
  fail_record "self_test_mode_valid" "S6_SELF_TEST must be 0 or 1"
  exit 1
fi
if [[ "${SELF_TEST_NESTED}" != "0" && "${SELF_TEST_NESTED}" != "1" ]] \
  || { [[ "${SELF_TEST_NESTED}" == "1" ]] && [[ "${SELF_TEST}" != "1" ]]; }; then
  fail_record "self_test_mode_valid" "S6_SELF_TEST_NESTED requires S6_SELF_TEST=1 and must be 0 or 1"
  exit 1
fi
TEST_SEAM_NAMES=()
while IFS='=' read -r test_name _; do
  [[ "${test_name}" == S6_TEST_* ]] && TEST_SEAM_NAMES+=("${test_name}")
done < <(env)
if (( ${#TEST_SEAM_NAMES[@]} > 0 )) && [[ "${SELF_TEST}" != "1" ]]; then
  fail_record "test_seams_require_explicit_self_test" \
    "S6_TEST_* seams require S6_SELF_TEST=1; refusing ${TEST_SEAM_NAMES[*]} outside an explicit self-test"
  exit 1
fi

CHECK_DEADLINE_SECONDS="${S6_TEST_CHECK_DEADLINE_SECONDS:-90}"
readonly CHECK_DEADLINE_SECONDS
TEST_GROUP_INSPECTION_FAILURES_REMAINING="${S6_TEST_GROUP_INSPECTION_FAILURES_REMAINING:-0}"

if ! [[ "${CHECK_DEADLINE_SECONDS}" =~ ^[0-9]+$ ]] \
  || (( CHECK_DEADLINE_SECONDS < 2 || CHECK_DEADLINE_SECONDS > 90 )); then
  fail_record "self_test_deadline_valid" \
    "S6_TEST_CHECK_DEADLINE_SECONDS must be an integer in 2..90"
  exit 1
fi
if ! [[ "${TEST_GROUP_INSPECTION_FAILURES_REMAINING}" =~ ^[0-9]+$ ]] \
  || (( TEST_GROUP_INSPECTION_FAILURES_REMAINING > 1 )); then
  fail_record "self_test_group_inspection_failures_valid" \
    "S6_TEST_GROUP_INSPECTION_FAILURES_REMAINING must be 0 or 1"
  exit 1
fi

if ! command -v lsof >/dev/null 2>&1; then
  lifecycle_capability_block "LIFECYCLE_LSOF_UNAVAILABLE" \
    "lsof is unavailable before launch, so state-directory ownership cannot be inspected"
  exit "${BLOCKED_EXIT}"
fi

show_redacted() {
  local label="$1" file="$2" limit="${3:-40}"
  [[ -s "${file}" ]] || return 0
  printf '%s\n' "--- ${label} (redacted, first ${limit} lines) ---" >&2
  # `HOME` may legitimately be unset; under `set -u` an unguarded expansion here
  # would abort redaction at exactly the moment a failure needs to be shown.
  local home="${HOME:-}"
  [[ -n "${home}" ]] || home="__no_home_set__"
  sed -e "s|${ROOT}|${REDACTION_REPOSITORY}|g" -e "s|${home}|${REDACTION_HOME}|g" \
      -e "s|asimp_ag_[A-Za-z0-9_-]\\{4,\\}|${REDACTION_SECRET}|g" \
      -e "s|Bearer [A-Za-z0-9._~+/-]\\{8,\\}|${REDACTION_SECRET}|g" \
      -e "s|#v1\\.[A-Za-z0-9._~-]\\{8,\\}|${REDACTION_SECRET}|g" \
      -e "s|\"signature\":\"[0-9a-f]\\{128\\}\"|\"signature\":\"${REDACTION_SECRET}\"|g" \
      -e "s|\"nonce\":\"[A-Za-z0-9_-]\\{32,128\\}\"|\"nonce\":\"${REDACTION_SECRET}\"|g" \
      -e "s|\"principal_id\":\"[A-Za-z0-9_-]\\{1,64\\}\"|\"principal_id\":\"${REDACTION_SECRET}\"|g" \
      -e "s|\"d\":\"[A-Za-z0-9_-]\\{16,\\}\"|\"d\":\"${REDACTION_SECRET}\"|g" \
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

# `lsof` is useful attribution, but an empty answer alone cannot prove that it
# saw every listener. A bind of the exact owned address/port is an independent
# kernel check: it succeeds only after the listener is actually gone.
port_accepts_bind() {
  local port="$1"
  bun --eval '
    const port = Number(process.argv[1]);
    try {
      const server = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("probe") });
      server.stop(true);
      process.exit(0);
    } catch {
      process.exit(1);
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
# supervisor identity would abort cleanup with "unbound variable" at the one
# moment cleanup matters.
SERVER_SUPERVISOR_PID=""
SERVER_PGID=""
SERVER_SUPERVISOR_STARTED_AT=""
SERVER_SUPERVISOR_TOKEN=""
PROVISIONAL_SUPERVISOR_OWNED=0
RESTART_CHECKER_PID=""
RESTART_CHECKER_STARTED_AT=""
RESTART_CHECKER_TOKEN=""
CHECKER_PID=""
CHECKER_STARTED_AT=""
CHECKER_TOKEN=""
CHECKER_OWNED=0
BUSY_SUPERVISOR_PID=""
BUSY_PGID=""
BUSY_SUPERVISOR_STARTED_AT=""
BUSY_SUPERVISOR_TOKEN=""
BUSY_SUPERVISOR_OWNED=0
TEST_REPEAT_SIGNAL_DURING_CLEANUP="${S6_TEST_REPEAT_SIGNAL_DURING_CLEANUP:-0}"
TEST_RESTART_INSPECTION_FAILURES_REMAINING=0
TEST_DIRECT_CHILD_CLEANUP_SECONDS=5
NESTED_HARNESS_CLEANUP_SECONDS=15
INSPECTED_GROUP_MEMBERS=""
CLEANUP_FINALIZED=0
LIFECYCLE_CRITICAL=0
PENDING_SIGNAL_STATUS=0
SIGNAL_WINDOW_FIRED=0
OWNED_GROUP_HISTORY=()
LIFECYCLE_CAPABILITY_BLOCK_REPORTED="${LIFECYCLE_CAPABILITY_BLOCK_REPORTED:-0}"
NESTED_HARNESS_PID=""
NESTED_HARNESS_STARTED_AT=""
NESTED_HARNESS_TOKEN=""
NESTED_HARNESS_LOG=""
NESTED_HARNESS_OUTPUT=""
NESTED_HARNESS_EXIT=""

# The controller's own process group. Nothing may ever be signalled with this:
# `kill -TERM -${CONTROLLER_PGID}` would terminate this script rather than the
# worker, and a `ps` that returns the parent's group instead of the child's is
# exactly how that happens by accident.
CONTROLLER_PGID="$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')"
CONTROLLER_PGID_STATUS=$?
if (( CONTROLLER_PGID_STATUS != 0 )) || ! [[ "${CONTROLLER_PGID}" =~ ^[0-9]+$ ]]; then
  fail_record "controller_group_inspection_available" \
    "could not establish this runner's process group; refusing to launch a signal-managed worker"
  exit 1
fi
readonly CONTROLLER_PGID

# A process group is not an identity: its numeric id can be reused once its
# leader exits. Each Wrangler launch therefore has a dedicated bash supervisor
# that stops before it executes Wrangler, is recorded by pid + lstart + an
# unguessable per-run argv marker, and deliberately stays alive after Wrangler
# exits. While that exact leader is live the group id cannot be recycled. This
# narrows the signal claim to the observed supervisor/group; it does not claim
# containment of arbitrary daemons that escape the process group.
SUPERVISOR_PID=""
SUPERVISOR_PGID=""
SUPERVISOR_STARTED_AT=""
SUPERVISOR_TOKEN=""
SUPERVISOR_READY=0
LAST_PROVISIONAL_REAPED_PID=""
LAST_PROVISIONAL_REAPED_STARTED_AT=""
LAST_PROVISIONAL_REAPED_TOKEN=""

mint_supervisor_token() {
  bun --eval 'console.log(crypto.randomUUID().replace(/-/g, ""));'
}

remember_owned_group() {
  local pgid="$1" existing
  [[ "${pgid}" =~ ^[0-9]+$ ]] || return 1
  for existing in "${OWNED_GROUP_HISTORY[@]}"; do
    [[ "${existing}" == "${pgid}" ]] && return 0
  done
  OWNED_GROUP_HISTORY+=("${pgid}")
}

# shellcheck disable=SC2329 # invoked by the INT, TERM, and HUP traps below.
handle_signal() {
  local status="$1"
  if (( LIFECYCLE_CRITICAL != 0 )); then
    PENDING_SIGNAL_STATUS="${status}"
    return 0
  fi
  exit "${status}"
}

leave_lifecycle_critical() {
  local pending
  LIFECYCLE_CRITICAL=0
  pending="${PENDING_SIGNAL_STATUS}"
  PENDING_SIGNAL_STATUS=0
  if (( pending != 0 )); then
    exit "${pending}"
  fi
}

maybe_signal_window() {
  local window="$1"
  if [[ "${S6_TEST_SIGNAL_WINDOW:-}" == "${window}" && "${SIGNAL_WINDOW_FIRED}" == "0" ]]; then
    SIGNAL_WINDOW_FIRED=1
    expected_negative_record "signal_during_${window//-/_}" \
      "HUP entered the finalizer while the ${window} ownership window was live"
    kill -HUP "$$"
    fail_record "signal_during_${window//-/_}" "HUP did not enter the finalizer"
    exit 1
  fi
}

supervisor_identity_is_exact() {
  local pid="$1" pgid="$2" started_at="$3" token="$4"
  local observed_pid observed_pgid observed_started observed_command status
  [[ "${pid}" =~ ^[0-9]+$ && "${pgid}" =~ ^[0-9]+$ && -n "${started_at}" && -n "${token}" ]] || return 1
  kill -0 "${pid}" 2>/dev/null || return 1
  observed_pid="$(ps -o pid= -p "${pid}" 2>/dev/null)"; status=$?
  (( status == 0 )) || return 1
  observed_pgid="$(ps -o pgid= -p "${pid}" 2>/dev/null)"; status=$?
  (( status == 0 )) || return 1
  observed_started="$(ps -o lstart= -p "${pid}" 2>/dev/null)"; status=$?
  (( status == 0 )) || return 1
  observed_command="$(ps -ww -o command= -p "${pid}" 2>/dev/null)"; status=$?
  (( status == 0 )) || return 1
  observed_pid="${observed_pid//[[:space:]]/}"
  observed_pgid="${observed_pgid//[[:space:]]/}"
  [[ "${observed_pid}" == "${pid}" && "${observed_pgid}" == "${pgid}" ]] || return 1
  [[ "${observed_started}" == "${started_at}" ]] || return 1
  [[ "${observed_command}" == *"s6-pinned-supervisor:${token}"* ]] || return 1
}

# Before a stopped supervisor has a proven process group, it is still safe to
# address its individual PID: this shell created it directly and has not waited
# for it, so an exited child remains an unreaped zombie and its PID cannot be
# recycled. The random argv marker and lstart bind the normal path; direct-child
# unreaped status is the narrow fallback if process inspection itself failed.
supervisor_direct_child_is_exact() {
  local pid="$1" started_at="$2" token="$3"
  local observed_pid observed_started observed_command status
  [[ "${pid}" =~ ^[0-9]+$ && -n "${started_at}" && -n "${token}" ]] || return 1
  kill -0 "${pid}" 2>/dev/null || return 1
  observed_pid="$(ps -o pid= -p "${pid}" 2>/dev/null)"; status=$?
  (( status == 0 )) || return 1
  observed_started="$(ps -o lstart= -p "${pid}" 2>/dev/null)"; status=$?
  (( status == 0 )) || return 1
  observed_command="$(ps -ww -o command= -p "${pid}" 2>/dev/null)"; status=$?
  (( status == 0 )) || return 1
  observed_pid="${observed_pid//[[:space:]]/}"
  [[ "${observed_pid}" == "${pid}" ]] || return 1
  [[ "${observed_started}" == "${started_at}" ]] || return 1
  [[ "${observed_command}" == *"s6-pinned-supervisor:${token}"* ]]
}

# A stopped child makes plain `wait PID` return as soon as it observes STOP on
# some Bash releases, rather than when the KILL actually terminates it.  Use
# `wait -f` where Bash provides it; otherwise wait until ps observes Z/death
# first, then reap.  This helper is only called for a child this shell spawned
# and has not previously waited, after sending that exact individual KILL.
wait_supports_full_completion() {
  # `help` is localized. Force the documented C synopsis before checking for
  # `-f`; scraping a translated synopsis would make cleanup capability depend
  # on the operator's locale. This asks this exact Bash, rather than assuming a
  # version number still implies the option is available.
  LC_ALL=C help wait 2>/dev/null | LC_ALL=C grep -Eq '^wait: wait \[-[^]]*f'
}

wait_for_killed_direct_child_reap() {
  local pid="$1" deadline state status wait_status
  [[ "${pid}" =~ ^[0-9]+$ ]] || return 1
  deadline="$(deadline_after_cleanup 5)"
  while (( SECONDS < deadline )); do
    state="$(ps -o stat= -p "${pid}" 2>/dev/null)"; status=$?
    if (( status != 0 )) || [[ "${state}" == *Z* ]]; then
      # Do not use `wait -f` as the thing that establishes the deadline: even
      # after SIGKILL, an unbounded wait would let a stuck child bypass the
      # finalizer's report. Once ps has observed death or a zombie, either wait
      # form is a reap only. Detect `-f` from the C synopsis for this Bash so
      # locale never changes that choice.
      if wait_supports_full_completion; then
        if wait -f "${pid}" 2>/dev/null; then wait_status=0; else wait_status=$?; fi
      else
        if wait "${pid}" 2>/dev/null; then wait_status=0; else wait_status=$?; fi
      fi
      (( wait_status != 127 ))
      return
    fi
    sleep 0.05
  done
  return 1
}

reap_provisional_supervisor() {
  local pid="${SUPERVISOR_PID}" started_at="${SUPERVISOR_STARTED_AT}" token="${SUPERVISOR_TOKEN}"
  (( PROVISIONAL_SUPERVISOR_OWNED == 1 )) || return 0
  [[ "${pid}" =~ ^[0-9]+$ && -n "${token}" ]] || {
    fail_record "pinned_supervisor_preexec_reap" \
      "the provisional direct child lacks a bounded identity; sent no signal"
    return 1
  }
  # Bash may reap a completed background child before an explicit `wait`, after
  # which the numeric PID can name an unrelated replacement. Direct-child status
  # is therefore never authority to signal. Retry transient inspection, then
  # fail closed with ownership retained unless lstart and the random argv marker
  # both still match.
  local exact=0
  for _identity_wait in {1..20}; do
    (( SECONDS < SCRIPT_FINAL_DEADLINE )) || break
    if supervisor_direct_child_is_exact "${pid}" "${started_at}" "${token}"; then
      exact=1
      break
    fi
    sleep 0.05
  done
  if (( exact != 1 )); then
    fail_record "pinned_supervisor_preexec_reap" \
      "the provisional supervisor identity stayed unavailable or changed; sent no signal to pid ${pid}"
    return 1
  fi
  if ! kill -KILL "${pid}" 2>/dev/null; then
    fail_record "pinned_supervisor_preexec_reap" \
      "could not KILL the provisional direct child before it executed Wrangler"
    return 1
  fi
  if ! wait_for_killed_direct_child_reap "${pid}"; then
    fail_record "pinned_supervisor_preexec_reap" \
      "the provisional direct child did not terminate and reap after KILL"
    return 1
  fi
  if supervisor_direct_child_is_exact "${pid}" "${started_at}" "${token}"; then
    fail_record "pinned_supervisor_preexec_reap" \
      "the exact provisional direct child remained live after KILL and wait"
    return 1
  fi
  LAST_PROVISIONAL_REAPED_PID="${pid}"
  LAST_PROVISIONAL_REAPED_STARTED_AT="${started_at}"
  LAST_PROVISIONAL_REAPED_TOKEN="${token}"
  PROVISIONAL_SUPERVISOR_OWNED=0
  SUPERVISOR_PID=""
  SUPERVISOR_PGID=""
  SUPERVISOR_STARTED_AT=""
  SUPERVISOR_TOKEN=""
  return 0
}

fail_preexec_supervisor() {
  local detail="$1"
  if ! reap_provisional_supervisor; then
    fail_record "pinned_supervisor_identity" "${detail}; provisional direct-child reap also failed"
    return 1
  fi
  fail_record "pinned_supervisor_identity" "${detail}; the stopped direct child was KILLed and waited"
  return 1
}

launch_pinned_supervisor() {
  local log_file="$1"
  shift
  local deadline state status
  assert_work_budget || return 1
  if (( PROVISIONAL_SUPERVISOR_OWNED == 1 )); then
    fail_record "pinned_supervisor_identity" \
      "refused to overwrite an owned provisional supervisor"
    return 1
  fi
  # Never let a failed later launch inherit a prior launch's identifiers. The
  # caller may retain only identities observed for this invocation.
  SUPERVISOR_PID=""
  SUPERVISOR_PGID=""
  SUPERVISOR_STARTED_AT=""
  SUPERVISOR_TOKEN=""
  SUPERVISOR_READY=0
  SUPERVISOR_TOKEN="$(mint_supervisor_token)" || SUPERVISOR_TOKEN=""
  if ! [[ "${SUPERVISOR_TOKEN}" =~ ^[A-Za-z0-9]{32}$ ]]; then
    fail_record "pinned_supervisor_identity" "could not mint a bounded supervisor identity marker"
    return 1
  fi

  # The first action in the child is SIGSTOP. The controller records and checks
  # its immutable identity before it can execute Wrangler or join a readiness
  # race. TERM is trapped by the supervisor while its wait loop keeps the exact
  # leader live until its direct Wrangler child has actually exited and reaped.
  # That preserves a live identity throughout any later group-signal decision;
  # the leader then exits with its child instead of manufacturing a sleeper that
  # could outlive the controlled runtime.
  LIFECYCLE_CRITICAL=1
  bash -c '
    token="$1"
    shift
    kill -STOP "$$"
    # This supervisor was placed in a dedicated group by the controller. Its
    # child must inherit that group rather than receive a nested job-control
    # group, otherwise a group TERM could release the supervisor while leaving
    # Wrangler/workerd outside the owned signal target.
    set +m
    trap ":" TERM INT HUP
    trap "exit 0" USR1
    "$@" &
    child="$!"
    while kill -0 "${child}" 2>/dev/null; do
      # A trapped TERM may interrupt wait before Wrangler has exited. Re-enter
      # it while the child is live so this exact leader cannot disappear before
      # a later SIGKILL decision needs to prove group ownership.
      if ! wait "${child}"; then :; fi
    done
  ' "s6-pinned-supervisor:${SUPERVISOR_TOKEN}" "${SUPERVISOR_TOKEN}" "$@" >>"${log_file}" 2>&1 &
  SUPERVISOR_PID=$!
  PROVISIONAL_SUPERVISOR_OWNED=1
  SUPERVISOR_STARTED_AT="$(ps -o lstart= -p "${SUPERVISOR_PID}" 2>/dev/null)"; status=$?
  leave_lifecycle_critical
  if (( status != 0 )) || [[ -z "${SUPERVISOR_STARTED_AT}" ]]; then
    fail_preexec_supervisor "could not capture the stopped supervisor birth time immediately after launch"
    return 1
  fi
  if ! supervisor_direct_child_is_exact \
    "${SUPERVISOR_PID}" "${SUPERVISOR_STARTED_AT}" "${SUPERVISOR_TOKEN}"; then
    fail_preexec_supervisor "the stopped supervisor did not match its provisional direct-child identity"
    return 1
  fi
  SUPERVISOR_PGID="$(ps -o pgid= -p "${SUPERVISOR_PID}" 2>/dev/null | tr -d ' ')"
  status=$?
  if [[ "${S6_TEST_SUPERVISOR_NOT_GROUP_LEADER:-0}" == "1" ]]; then
    SUPERVISOR_PGID="${CONTROLLER_PGID}"
  fi
  if (( status != 0 )) || [[ "${SUPERVISOR_PID}" != "${SUPERVISOR_PGID}" ]]; then
    fail_preexec_supervisor "the stopped supervisor did not become its own process-group leader"
    return 1
  fi
  remember_owned_group "${SUPERVISOR_PGID}" || {
    fail_preexec_supervisor "the stopped supervisor process group could not be retained for final inspection"
    return 1
  }

  if [[ "${S6_TEST_SUPERVISOR_IDENTITY_UNAVAILABLE:-0}" == "1" ]]; then
    fail_preexec_supervisor "the stopped supervisor identity probe was injected unavailable before exec"
    return 1
  fi

  deadline="$(deadline_after_work 10)"
  while (( SECONDS < deadline )); do
    state="$(ps -o stat= -p "${SUPERVISOR_PID}" 2>/dev/null)"; status=$?
    if (( status == 0 )) && [[ "${state}" == *T* ]]; then
      if supervisor_identity_is_exact \
        "${SUPERVISOR_PID}" "${SUPERVISOR_PGID}" "${SUPERVISOR_STARTED_AT}" "${SUPERVISOR_TOKEN}"; then
        SUPERVISOR_READY=1
        maybe_signal_window "provisional-supervisor"
        return 0
      fi
    fi
    if ! kill -0 "${SUPERVISOR_PID}" 2>/dev/null; then break; fi
    sleep 0.1
  done
  fail_preexec_supervisor "the Wrangler supervisor did not remain stopped with the recorded identity before exec"
  return 1
}

resume_pinned_supervisor() {
  local pid="$1" pgid="$2" started_at="$3" token="$4"
  if ! supervisor_identity_is_exact "${pid}" "${pgid}" "${started_at}" "${token}"; then
    fail_record "pinned_supervisor_identity" "the recorded Wrangler supervisor was not live and exact before resume"
    return 1
  fi
  if ! kill -CONT "${pid}" 2>/dev/null; then
    fail_record "pinned_supervisor_identity" "the recorded Wrangler supervisor could not be resumed"
    return 1
  fi
}

adopt_provisional_as_worker() {
  (( PROVISIONAL_SUPERVISOR_OWNED == 1 && SUPERVISOR_READY == 1 )) || return 1
  LIFECYCLE_CRITICAL=1
  SERVER_SUPERVISOR_PID="${SUPERVISOR_PID}"
  SERVER_PGID="${SUPERVISOR_PGID}"
  SERVER_SUPERVISOR_STARTED_AT="${SUPERVISOR_STARTED_AT}"
  SERVER_SUPERVISOR_TOKEN="${SUPERVISOR_TOKEN}"
  PROVISIONAL_SUPERVISOR_OWNED=0
  leave_lifecycle_critical
}

adopt_provisional_as_busy_contender() {
  (( PROVISIONAL_SUPERVISOR_OWNED == 1 && SUPERVISOR_READY == 1 )) || return 1
  LIFECYCLE_CRITICAL=1
  BUSY_SUPERVISOR_PID="${SUPERVISOR_PID}"
  BUSY_PGID="${SUPERVISOR_PGID}"
  BUSY_SUPERVISOR_STARTED_AT="${SUPERVISOR_STARTED_AT}"
  BUSY_SUPERVISOR_TOKEN="${SUPERVISOR_TOKEN}"
  BUSY_SUPERVISOR_OWNED=1
  PROVISIONAL_SUPERVISOR_OWNED=0
  leave_lifecycle_critical
}

# Terminate the whole child process group, then escalate. Wrangler spawns a
# workerd grandchild; killing only the wrapper strands the runtime holding the
# port. Files are never deleted: AGENTS.md forbids cleanup-by-deletion, and the
# state directory is deliberately retained for diagnosis.
# Every process still in the group, wrapper and workerd alike. The parent pid
# exiting proves nothing: the grandchild is what holds the port.
# Members of a process group, or exit 2 if the process table could not be read.
#
# The old form piped `ps` straight into `awk`, so a failing or missing `ps`
# produced empty output that every caller read as "the group is empty". That is
# fail-open in the one direction that matters: it reports a clean shutdown
# precisely when it has no idea.
group_members() {
  local pgid="$1"
  [[ -n "${pgid}" ]] || return 0
  local table row leader leader_status group_liveness_status
  table="$(ps -eo pid=,pgid= 2>/dev/null)" || return 2
  [[ -n "${table}" ]] || return 2
  while IFS= read -r row; do
    [[ -z "${row}" ]] && continue
    [[ "${row}" =~ ^[[:space:]]*[0-9]+[[:space:]]+[0-9]+[[:space:]]*$ ]] || return 2
  done <<<"${table}"
  local members
  members="$(printf '%s\n' "${table}" | awk -v g="${pgid}" '$2 == g { print $1 }')"
  if [[ -n "${members}" ]]; then
    printf '%s\n' "${members}"
    return 0
  fi

  # An otherwise well-formed partial table that simply omits our group is just
  # as dangerous as an unreadable one: treating it as empty would report a
  # clean shutdown while a live workerd is still running. Check the kernel's
  # view of the group independently. If its leader is still present, it too
  # must be represented in the complete table we are about to trust.
  leader="$(ps -o pid=,pgid= -p "${pgid}" 2>/dev/null)"
  leader_status=$?
  # A successful-but-empty direct lookup is not proof that the leader vanished:
  # it is also exactly what a partial `ps` can produce.  `ps` must explicitly
  # report its normal no-such-process status with no bytes before the kernel
  # liveness probe is allowed to decide that the group may be gone.
  if (( leader_status == 0 )); then
    [[ -n "${leader}" ]] || return 2
    [[ "${leader}" =~ ^[[:space:]]*${pgid}[[:space:]]+${pgid}[[:space:]]*$ ]] || return 2
    return 2
  fi
  if (( leader_status != 1 )) || [[ -n "${leader}" ]]; then
    return 2
  fi
  kill -0 "-${pgid}" 2>/dev/null
  group_liveness_status=$?
  if (( group_liveness_status == 0 )); then
    return 2
  fi
  # With no leader and a negative kernel liveness result, the group may be
  # gone. The caller still runs the broader all-process survivor scan before a
  # terminal pass, so this is never the sole evidence for cleanup.
  return 0
}

# Run the real group-members parser before applying the transient inspection
# seam. Keeping the seam in this parent-shell wrapper preserves its countdown;
# placing it inside `members="$(group_members ...)"` would decrement only in a
# command-substitution subshell. Status 75 is reserved for this planted,
# already-recorded transient and tells stop_group not to mislabel an expected
# negative as a production failure.
inspect_group_members() {
  local pgid="$1" parsed status
  INSPECTED_GROUP_MEMBERS=""
  parsed="$(group_members "${pgid}")"
  status=$?
  (( status == 0 )) || return "${status}"
  INSPECTED_GROUP_MEMBERS="${parsed}"
  if (( TEST_GROUP_INSPECTION_FAILURES_REMAINING > 0 )); then
    TEST_GROUP_INSPECTION_FAILURES_REMAINING=$((TEST_GROUP_INSPECTION_FAILURES_REMAINING - 1))
    expected_negative_record "post_parser_group_inspection_failure" \
      "the real group_members parser completed before the planted transient inspection failure; no signal was sent"
    return 75
  fi
  return 0
}

stop_group() {
  local pgid="$1" leader_pid="$2" leader_started_at="$3" leader_token="$4"
  [[ -n "${pgid}" ]] || return 0
  local members group_members_status survivors
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
  inspect_group_members "${pgid}"
  group_members_status=$?
  members="${INSPECTED_GROUP_MEMBERS}"
  if (( group_members_status != 0 )); then
    if (( group_members_status != 75 )); then
      fail_record "group_inspection_available" \
        "the process table could not be read while deciding whether pgid ${pgid} is empty; sent no signal"
    fi
    return 1
  fi
  if [[ -z "${members}" ]]; then
    return 0
  fi
  if ! supervisor_identity_is_exact "${leader_pid}" "${pgid}" "${leader_started_at}" "${leader_token}"; then
    fail_record "never_signals_a_recycled_group" \
      "the pinned supervisor was not live and exact before TERM for pgid ${pgid}; sent no signal"
    return 1
  fi
  if ! kill -TERM "-${pgid}" 2>/dev/null; then
    fail_record "worker_group_signal_delivered" "TERM could not be delivered to the recorded worker group"
    return 1
  fi
  for _wait in {1..40}; do
    (( SECONDS < SCRIPT_FINAL_DEADLINE )) || break
    members="$(group_members "${pgid}")"
    group_members_status=$?
    if (( group_members_status != 0 )); then
      fail_record "group_inspection_available" \
        "the process table could not be read during TERM cleanup of pgid ${pgid}; sent no further signal"
      return 1
    fi
    [[ -z "${members}" ]] && return 0
    if [[ "${members//$'\n'/}" == "${leader_pid}" ]]; then
      if ! supervisor_identity_is_exact "${leader_pid}" "${pgid}" "${leader_started_at}" "${leader_token}"; then
        fail_record "never_signals_a_recycled_group" \
          "the pinned supervisor was not live and exact before its release; sent no signal"
        return 1
      fi
      if ! kill -USR1 "${leader_pid}" 2>/dev/null; then
        fail_record "pinned_supervisor_release" "the recorded supervisor could not be released after child completion"
        return 1
      fi
    fi
    sleep 0.25
  done
  members="$(group_members "${pgid}")"
  group_members_status=$?
  if (( group_members_status != 0 )); then
    fail_record "group_inspection_available" \
      "the process table could not be read after TERM cleanup of pgid ${pgid}; sent no further signal"
    return 1
  fi
  if [[ -n "${members}" ]]; then
    # The leader deliberately ignored group TERM, so it remains an exact,
    # unrecycled identity through the escalation decision.
    if ! supervisor_identity_is_exact "${leader_pid}" "${pgid}" "${leader_started_at}" "${leader_token}"; then
      fail_record "never_signals_a_recycled_group" \
        "the pinned supervisor was not live and exact before SIGKILL for pgid ${pgid}; sent no signal"
      return 1
    fi
    if ! kill -KILL "-${pgid}" 2>/dev/null; then
      fail_record "worker_group_signal_delivered" "SIGKILL could not be delivered to the recorded worker group"
      return 1
    fi
    for _wait in {1..20}; do
      (( SECONDS < SCRIPT_FINAL_DEADLINE )) || break
      members="$(group_members "${pgid}")"
      group_members_status=$?
      if (( group_members_status != 0 )); then
        fail_record "group_inspection_available" \
          "the process table could not be read during SIGKILL cleanup of pgid ${pgid}; survivor state is unknown"
        return 1
      fi
      [[ -z "${members}" ]] && return 0
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
    survivors="${members//$'\n'/ }"
    if [[ -n "${survivors// /}" ]]; then
      fail_record "leaves_no_surviving_process_group_members" \
        "pgid ${pgid} still has members after SIGKILL: ${survivors% }"
      return 1
    fi
  fi
}

stop_worker() {
  if [[ -z "${SERVER_PGID}" ]]; then
    [[ -z "${SERVER_SUPERVISOR_PID}" ]] && return 0
    fail_record "worker_group_cleanup_proved" \
      "the worker supervisor exists but its process group is unknown; cleanup refused to guess"
    return 1
  fi
  local cleanup_status=0
  stop_group "${SERVER_PGID}" "${SERVER_SUPERVISOR_PID}" \
    "${SERVER_SUPERVISOR_STARTED_AT}" "${SERVER_SUPERVISOR_TOKEN}" || cleanup_status=$?
  # Leave identity intact on failure so the EXIT finalizer can retry its
  # inspection. Clearing it here used to turn "cleanup unknown" into a later
  # no-op, which is indistinguishable from successful reaping.
  if (( cleanup_status != 0 )); then
    return "${cleanup_status}"
  fi
  if [[ -n "${SERVER_SUPERVISOR_PID}" ]]; then
    if ! wait "${SERVER_SUPERVISOR_PID}" 2>/dev/null; then :; fi
  fi
  SERVER_SUPERVISOR_PID=""
  SERVER_PGID=""
  SERVER_SUPERVISOR_STARTED_AT=""
  SERVER_SUPERVISOR_TOKEN=""
  SUPERVISOR_READY=0
  return "${cleanup_status}"
}

stop_busy_contender() {
  (( BUSY_SUPERVISOR_OWNED == 1 )) || return 0
  local cleanup_status=0
  stop_group "${BUSY_PGID}" "${BUSY_SUPERVISOR_PID}" \
    "${BUSY_SUPERVISOR_STARTED_AT}" "${BUSY_SUPERVISOR_TOKEN}" || cleanup_status=$?
  if (( cleanup_status != 0 )); then
    return "${cleanup_status}"
  fi
  if [[ -n "${BUSY_SUPERVISOR_PID}" ]]; then
    if ! wait "${BUSY_SUPERVISOR_PID}" 2>/dev/null; then :; fi
  fi
  BUSY_SUPERVISOR_PID=""
  BUSY_PGID=""
  BUSY_SUPERVISOR_STARTED_AT=""
  BUSY_SUPERVISOR_TOKEN=""
  BUSY_SUPERVISOR_OWNED=0
}

# Direct children are identities only while pid + lstart + the random argv
# marker all agree. Bash may reap a completed background child before an
# explicit `wait`, so "we spawned that number" is never a fallback authority to
# signal it: after reuse the same number can belong to an unrelated process.
direct_child_identity_is_exact() {
  local pid="$1" started_at="$2" marker="$3"
  local observed_pid observed_started observed_command status
  [[ "${pid}" =~ ^[0-9]+$ && -n "${started_at}" && -n "${marker}" ]] || return 1
  observed_pid="$(ps -o pid= -p "${pid}" 2>/dev/null)"; status=$?
  (( status == 0 )) || return 1
  observed_started="$(ps -o lstart= -p "${pid}" 2>/dev/null)"; status=$?
  (( status == 0 )) || return 1
  observed_command="$(ps -ww -o command= -p "${pid}" 2>/dev/null)"; status=$?
  (( status == 0 )) || return 1
  observed_pid="${observed_pid//[[:space:]]/}"
  [[ "${observed_pid}" == "${pid}" ]] || return 1
  [[ "${observed_started}" == "${started_at}" ]] || return 1
  [[ "${observed_command}" == *"${marker}"* ]]
}

restart_checker_identity_is_exact() {
  local pid="$1" started_at="$2" token="$3"
  [[ "${token}" =~ ^[A-Za-z0-9]{32}$ ]] || return 1
  direct_child_identity_is_exact "${pid}" "${started_at}" "s6-restart-checker:${token}"
}

checker_identity_is_exact() {
  local pid="$1" started_at="$2" token="$3"
  [[ "${token}" =~ ^[A-Za-z0-9]{32}$ ]] || return 1
  direct_child_identity_is_exact "${pid}" "${started_at}" "s6-ordinary-checker:${token}"
}

direct_child_is_gone() {
  local pid="$1" observed status
  observed="$(ps -o pid= -p "${pid}" 2>/dev/null)"; status=$?
  (( status == 1 )) && [[ -z "${observed}" ]]
}

direct_child_has_exited() {
  local pid="$1" started_at="$2" observed_started state status
  direct_child_is_gone "${pid}" && return 0
  observed_started="$(ps -o lstart= -p "${pid}" 2>/dev/null)"; status=$?
  (( status == 0 )) || return 1
  state="$(ps -o stat= -p "${pid}" 2>/dev/null)"; status=$?
  (( status == 0 )) || return 1
  [[ "${observed_started}" == "${started_at}" && "${state}" == *Z* ]]
}

stop_exact_direct_child() {
  local assertion="$1" pid="$2" started_at="$3" marker="$4" resume_first="$5"
  local cleanup_seconds="${6:-${TEST_DIRECT_CHILD_CLEANUP_SECONDS}}" deadline exact
  [[ "${pid}" =~ ^[0-9]+$ ]] || return 0
  [[ "${cleanup_seconds}" =~ ^[0-9]+$ && "${cleanup_seconds}" != "0" ]] || return 1
  deadline="$(deadline_after_cleanup "${cleanup_seconds}")"

  # Inspection failures are retryable only inside this fixed budget. A marker or
  # birth-time mismatch is never converted into authority by direct-child
  # bookkeeping; persistent uncertainty leaves the replacement unsignalled.
  exact=0
  while (( SECONDS < deadline )); do
    if direct_child_identity_is_exact "${pid}" "${started_at}" "${marker}"; then
      exact=1
      break
    fi
    if direct_child_has_exited "${pid}" "${started_at}"; then
      if ! wait "${pid}" 2>/dev/null; then :; fi
      return 0
    fi
    sleep 0.05
  done
  if (( exact != 1 )); then
    fail_record "${assertion}" \
      "pid ${pid} did not retain its exact lstart and argv marker; sent no signal"
    return 1
  fi

  if [[ "${resume_first}" == "1" ]]; then
    if ! direct_child_identity_is_exact "${pid}" "${started_at}" "${marker}"; then
      fail_record "${assertion}" "the stopped child identity changed before CONT; sent no signal"
      return 1
    fi
    if ! kill -CONT "${pid}" 2>/dev/null; then
      fail_record "${assertion}" "the exact stopped child could not be resumed"
      return 1
    fi
  fi
  exact=0
  deadline="$(deadline_after_cleanup "${cleanup_seconds}")"
  while (( SECONDS < deadline )); do
    if direct_child_has_exited "${pid}" "${started_at}"; then
      if ! wait "${pid}" 2>/dev/null; then :; fi
      return 0
    fi
    if direct_child_identity_is_exact "${pid}" "${started_at}" "${marker}"; then
      exact=1
      break
    fi
    sleep 0.05
  done
  if (( exact != 1 )); then
    fail_record "${assertion}" "the child identity changed before TERM; sent no signal"
    return 1
  fi
  if ! kill -TERM "${pid}" 2>/dev/null; then
    if direct_child_has_exited "${pid}" "${started_at}"; then
      if ! wait "${pid}" 2>/dev/null; then :; fi
      return 0
    fi
    fail_record "${assertion}" "the exact child could not receive TERM"
    return 1
  fi

  deadline="$(deadline_after_cleanup "${cleanup_seconds}")"
  while (( SECONDS < deadline )); do
    if direct_child_has_exited "${pid}" "${started_at}"; then
      if ! wait "${pid}" 2>/dev/null; then :; fi
      return 0
    fi
    sleep 0.05
  done

  if ! direct_child_identity_is_exact "${pid}" "${started_at}" "${marker}"; then
    fail_record "${assertion}" \
      "the child identity was unavailable or changed before SIGKILL; sent no signal"
    return 1
  fi
  if ! kill -KILL "${pid}" 2>/dev/null; then
    fail_record "${assertion}" "the exact child survived bounded TERM cleanup"
    return 1
  fi
  if ! wait_for_killed_direct_child_reap "${pid}"; then
    fail_record "${assertion}" "the exact child survived SIGKILL cleanup"
    return 1
  fi
  return 0
}

clear_restart_checker_identity() {
  RESTART_CHECKER_PID=""
  RESTART_CHECKER_STARTED_AT=""
  RESTART_CHECKER_TOKEN=""
}

clear_checker_identity() {
  CHECKER_PID=""
  CHECKER_STARTED_AT=""
  CHECKER_TOKEN=""
  CHECKER_OWNED=0
}

stop_restart_checker() {
  [[ -n "${RESTART_CHECKER_PID}" ]] || return 0
  if ! stop_exact_direct_child "restart_checker_cleanup" "${RESTART_CHECKER_PID}" \
    "${RESTART_CHECKER_STARTED_AT}" "s6-restart-checker:${RESTART_CHECKER_TOKEN}" 1; then
    return 1
  fi
  clear_restart_checker_identity
}

stop_checker() {
  (( CHECKER_OWNED == 1 )) || return 0
  if ! stop_exact_direct_child "ordinary_checker_cleanup" "${CHECKER_PID}" \
    "${CHECKER_STARTED_AT}" "s6-ordinary-checker:${CHECKER_TOKEN}" 0; then
    return 1
  fi
  clear_checker_identity
}

# The self-test runs intentional child scripts for the wedged-checker and
# signal-window cases. They are ordinary, exact direct children of this shell,
# not command substitutions: a TERM can therefore reach this shell's trap
# between bounded polls, and the finalizer can ask each child to run its own
# cleanup before any outer SIGKILL is considered.
clear_nested_harness_identity() {
  NESTED_HARNESS_PID=""
  NESTED_HARNESS_STARTED_AT=""
  NESTED_HARNESS_TOKEN=""
  NESTED_HARNESS_LOG=""
}

stop_nested_harness() {
  local pid="${NESTED_HARNESS_PID}" started_at="${NESTED_HARNESS_STARTED_AT}"
  local marker="s6-nested-harness:${NESTED_HARNESS_TOKEN}" deadline descendants_status
  [[ -n "${pid}" ]] || return 0
  if ! direct_child_identity_is_exact "${pid}" "${started_at}" "${marker}"; then
    if direct_child_has_exited "${pid}" "${started_at}"; then
      if ! wait "${pid}" 2>/dev/null; then :; fi
      clear_nested_harness_identity
      return 0
    fi
    fail_record "nested_harness_cleanup" \
      "the nested harness identity was unavailable or changed; sent no signal"
    return 1
  fi
  if ! kill -TERM "${pid}" 2>/dev/null; then
    fail_record "nested_harness_cleanup" "the exact nested harness could not receive TERM"
    return 1
  fi
  deadline="$(deadline_after_cleanup "${NESTED_HARNESS_CLEANUP_SECONDS}")"
  while (( SECONDS < deadline )); do
    if direct_child_has_exited "${pid}" "${started_at}"; then
      if ! wait "${pid}" 2>/dev/null; then :; fi
      clear_nested_harness_identity
      return 0
    fi
    nested_harness_descendants_present "${pid}"
    descendants_status=$?
    if (( descendants_status == 1 )); then
      # The child has no remaining descendants, so an exact KILL can only reap
      # the shell that failed to leave on TERM; it cannot strand its workerd.
      if ! direct_child_identity_is_exact "${pid}" "${started_at}" "${marker}"; then
        fail_record "nested_harness_cleanup" \
          "the nested harness identity changed before a descendant-free SIGKILL; sent no signal"
        return 1
      fi
      if ! kill -KILL "${pid}" 2>/dev/null \
        || ! wait_for_killed_direct_child_reap "${pid}"; then
        fail_record "nested_harness_cleanup" \
          "the descendant-free nested harness could not be KILLed and reaped"
        return 1
      fi
      clear_nested_harness_identity
      return 0
    fi
    if (( descendants_status != 0 )); then
      fail_record "nested_harness_cleanup" \
        "the nested descendant table was unavailable; SIGKILL was refused because runtime ownership is unknown"
      return 1
    fi
    sleep 0.05
  done
  fail_record "nested_harness_cleanup" \
    "the nested harness did not finish its own bounded finalizer; SIGKILL was refused while descendants remained"
  return 1
}

# Return 0 when the exact nested harness still has a descendant, 1 when it has
# none, or 2 when the process table cannot be trusted. This is deliberately
# narrower than a cleanup scan: it establishes only whether KILLing the nested
# shell would risk stranding one of its worker descendants.
nested_harness_descendants_present() {
  local root="$1" table row
  [[ "${root}" =~ ^[0-9]+$ ]] || return 2
  table="$(ps -eo pid=,ppid=,command= 2>/dev/null)" || return 2
  [[ -n "${table}" ]] || return 2
  while IFS= read -r row; do
    [[ -z "${row}" ]] && continue
    [[ "${row}" =~ ^[[:space:]]*[0-9]+[[:space:]]+[0-9]+[[:space:]]+.+$ ]] || return 2
  done <<<"${table}"
  printf '%s\n' "${table}" | awk -v root="${root}" '
    { parent[$1] = $2 }
    END {
      for (pid in parent) {
        current = pid
        while (current in parent) {
          if (parent[current] == root) exit 0
          if (parent[current] == current) break
          current = parent[current]
        }
      }
      exit 1
    }
  '
}

run_nested_harness() {
  local label="$1"
  shift
  local deadline status assignment name value log exact=0
  [[ "${SELF_TEST}" == "1" && "${SELF_TEST_NESTED}" == "0" ]] || return 1
  [[ -z "${NESTED_HARNESS_PID}" ]] || return 1
  assert_work_budget || return 1
  NESTED_HARNESS_OUTPUT=""
  NESTED_HARNESS_EXIT=""
  NESTED_HARNESS_TOKEN="$(mint_supervisor_token)" || NESTED_HARNESS_TOKEN=""
  if ! [[ "${NESTED_HARNESS_TOKEN}" =~ ^[A-Za-z0-9]{32}$ ]]; then
    fail_record "nested_harness_identity" "could not mint the nested harness argv marker"
    return 1
  fi
  NESTED_HARNESS_LOG="${STATE_DIR}/nested-${label}-${NESTED_HARNESS_TOKEN}.log"
  log="${NESTED_HARNESS_LOG}"
  for assignment in "$@"; do
    if ! [[ "${assignment}" =~ ^S6_TEST_[A-Z0-9_]+= ]]; then
      fail_record "nested_harness_assignment" \
        "nested harness settings must be S6_TEST_* name=value assignments"
      return 1
    fi
  done
  (
    unset S6_PORT
    export S6_SELF_TEST=1
    export S6_SELF_TEST_NESTED=1
    for assignment in "$@"; do
      name="${assignment%%=*}"
      value="${assignment#*=}"
      export "${name}=${value}"
    done
    exec bash "${BASH_SOURCE[0]}" "s6-nested-harness:${NESTED_HARNESS_TOKEN}"
  ) >"${NESTED_HARNESS_LOG}" 2>&1 &
  NESTED_HARNESS_PID=$!
  NESTED_HARNESS_STARTED_AT="$(ps -o lstart= -p "${NESTED_HARNESS_PID}" 2>/dev/null)"; status=$?
  deadline="$(deadline_after_work 5)"
  while (( status == 0 && SECONDS < deadline )); do
    if direct_child_identity_is_exact \
      "${NESTED_HARNESS_PID}" "${NESTED_HARNESS_STARTED_AT}" \
      "s6-nested-harness:${NESTED_HARNESS_TOKEN}"; then
      exact=1
      break
    fi
    direct_child_is_gone "${NESTED_HARNESS_PID}" && break
    sleep 0.05
  done
  if (( exact != 1 )); then
    if ! stop_nested_harness; then
      fail_record "nested_harness_identity" \
        "the nested harness identity was unavailable and exact-only cleanup also failed"
    fi
    return 1
  fi
  deadline="$(deadline_after_work 45)"
  while (( SECONDS < deadline )); do
    if direct_child_is_gone "${NESTED_HARNESS_PID}"; then
      if wait "${NESTED_HARNESS_PID}"; then status=0; else status=$?; fi
      NESTED_HARNESS_EXIT="${status}"
      NESTED_HARNESS_OUTPUT="$(<"${log}")"
      clear_nested_harness_identity
      return 0
    fi
    sleep 0.1
  done
  if ! stop_nested_harness; then
    fail_record "nested_harness_deadline" \
      "nested ${label} exceeded its bounded wait and exact-only cleanup failed"
    return 1
  fi
  NESTED_HARNESS_EXIT=124
  NESTED_HARNESS_OUTPUT="$(<"${log}")"
  fail_record "nested_harness_deadline" \
    "nested ${label} exceeded its bounded wait and was terminated through its exact direct-child identity"
  return 1
}

cleanup_and_verify() {
  local cleanup_status=0 blocked_status=0 inspected_group status
  (( CLEANUP_FINALIZED == 0 )) || return 0
  if ! stop_nested_harness; then
    cleanup_status=1
  fi
  if ! stop_checker; then
    cleanup_status=1
  fi
  if ! stop_restart_checker; then
    cleanup_status=1
  fi
  if ! stop_busy_contender; then
    cleanup_status=1
  fi
  if ! stop_worker; then
    cleanup_status=1
  fi
  if ! reap_provisional_supervisor; then
    cleanup_status=1
  fi
  # A stop that could not establish identity or survivor state leaves its exact
  # ownership record intact for cleanup_with_retry. Do not run terminal survivor
  # assertions while that owned process is intentionally still live.
  (( cleanup_status == 0 )) || return 1
  sleep 1
  if (( ${#OWNED_GROUP_HISTORY[@]} == 0 )); then
    if assert_no_survivors ""; then
      :
    else
      status=$?
      if (( status == BLOCKED_EXIT )); then blocked_status="${status}"; else cleanup_status=1; fi
    fi
  else
    for inspected_group in "${OWNED_GROUP_HISTORY[@]}"; do
      if assert_no_survivors "${inspected_group}"; then
        :
      else
        status=$?
        if (( status == BLOCKED_EXIT )); then blocked_status="${status}"; else cleanup_status=1; fi
      fi
    done
  fi
  (( cleanup_status == 0 )) || return 1
  (( blocked_status == 0 )) || return "${blocked_status}"
  CLEANUP_FINALIZED=1
  return 0
}

# shellcheck disable=SC2329 # on_exit invokes this through the EXIT trap.
cleanup_with_retry() {
  local attempt status
  for attempt in 1 2; do
    if cleanup_and_verify; then
      if (( attempt > 1 )); then
        emit "{\"suite\":\"s6-auth-ingress-local\",\"assertion\":\"finalizer_retried_transient_inspection\",\"status\":\"pass\",\"detail\":\"the retained exact identity was reaped after transient inspection failure on cleanup attempt ${attempt}\",\"reproduce\":\"${REPRODUCE}\"}"
      fi
      return 0
    fi
    status=$?
    (( status == BLOCKED_EXIT )) && return "${status}"
    if (( attempt == 1 )); then
      emit "{\"suite\":\"s6-auth-ingress-local\",\"assertion\":\"finalizer_retrying_cleanup\",\"status\":\"blocked\",\"detail\":\"cleanup attempt 1 could not establish survivor state; retaining identity for one bounded retry\",\"reproduce\":\"${REPRODUCE}\"}"
      sleep 0.1
    fi
  done
  return 1
}

# shellcheck disable=SC2329 # The shell invokes this function through the EXIT trap.
on_exit() {
  local original_status=$? cleanup_status
  trap - EXIT
  # Once EXIT is disarmed, a second terminal signal must not run `exit` midway
  # through cleanup. Ignore all three until the bounded finalizer has completed.
  trap '' INT TERM HUP
  if [[ "${TEST_REPEAT_SIGNAL_DURING_CLEANUP}" == "1" ]]; then
    local cleanup_pid="${BASHPID:-$$}"
    ( sleep 0.05; kill -HUP "${cleanup_pid}" 2>/dev/null || true
      sleep 0.05; kill -TERM "${cleanup_pid}" 2>/dev/null || true ) &
  fi
  if cleanup_with_retry; then
    :
  else
    cleanup_status=$?
    if (( cleanup_status == BLOCKED_EXIT )); then
      exit "${BLOCKED_EXIT}"
    fi
    exit 1
  fi
  if [[ "${TEST_REPEAT_SIGNAL_DURING_CLEANUP}" == "1" ]]; then
    if (( original_status != 129 )); then
      fail_record "repeated_signal_finalizer" \
        "the planted repeated-signal cleanup did not retain its original HUP status"
      exit 1
    fi
    emit "{\"suite\":\"s6-auth-ingress-local\",\"assertion\":\"repeated_signal_finalizer\",\"status\":\"pass\",\"detail\":\"HUP started cleanup, later HUP and TERM were masked, and process, port, and state-directory checks completed before exit 129\",\"reproduce\":\"${REPRODUCE}\"}"
  fi
  exit "${original_status}"
}

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
# Inherit the private key directly into checker processes. Do not pass it as an
# `env KEY=value` argument, which is observable in the short-lived launcher's
# argv before `env` execs Bun.
export S6_PUBLIC_KEY_HEX S6_PRIVATE_KEY_JWK S6_KID S6_NOW

# ── real local D1 through the real numbered migrations ──────────────────────
if ! assert_work_budget; then
  exit 1
fi
if ! "${WRANGLER}" d1 migrations apply DB --config "${CONFIG}" --local \
  --persist-to "${STATE_DIR}" >"${STATE_DIR}/migration.log" 2>&1; then
  show_redacted "d1 migrations" "${STATE_DIR}/migration.log"
  fail_record "local_d1_migrations_applied" "wrangler could not apply db/migrations to local D1"
  exit 1
fi
emit "{\"suite\":\"s6-auth-ingress-local\",\"assertion\":\"local_d1_migrations_applied\",\"status\":\"pass\",\"detail\":\"0003_auth_nonce_replay.sql applied through the real migration path\",\"reproduce\":\"${REPRODUCE}\"}"

start_worker() {
  local launch_status=0
  assert_work_budget || return 1
  launch_pinned_supervisor "${SERVER_LOG}" "${WRANGLER}" dev \
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
    --var "S6_RUN_ID:${S6_RUN_ID}" || launch_status=$?

  if (( launch_status != 0 )); then
    return "${launch_status}"
  fi
  # Failed pre-exec launches are reaped directly inside launch_pinned_supervisor.
  # Only a stopped, exact, group-owned supervisor may become Worker cleanup
  # state; copying provisional fields here would turn a safe direct reap into a
  # later negative-group decision with incomplete identity.
  if (( SUPERVISOR_READY != 1 )); then
    fail_record "pinned_supervisor_identity" \
      "launch returned without an exact stopped supervisor; refusing to start Wrangler"
    return 1
  fi
  if ! adopt_provisional_as_worker; then
    fail_record "pinned_supervisor_identity" \
      "the stopped supervisor could not be transferred atomically to Worker ownership"
    return 1
  fi
  if ! resume_pinned_supervisor "${SERVER_SUPERVISOR_PID}" "${SERVER_PGID}" \
    "${SERVER_SUPERVISOR_STARTED_AT}" "${SERVER_SUPERVISOR_TOKEN}"; then
    return 1
  fi

  local deadline
  deadline="$(deadline_after_work "${READY_DEADLINE_SECONDS}")"
  while (( SECONDS < deadline )); do
    # Readiness is tied to the exact pinned supervisor: a recycled PGID or a
    # foreign listener can never satisfy readiness for this run.
    if ! supervisor_identity_is_exact "${SERVER_SUPERVISOR_PID}" "${SERVER_PGID}" \
      "${SERVER_SUPERVISOR_STARTED_AT}" "${SERVER_SUPERVISOR_TOKEN}"; then
      return 1
    fi
    # …and to ownership: a 200 from a foreign Worker on this port is not ours.
    local health
    health="$(probe "${ORIGIN}/__s6/health")"
    if [[ "${health}" == *"\"run_id\":\"${S6_RUN_ID}\""* ]]; then
      maybe_signal_window "worker"
      return 0
    fi
    sleep 0.25
  done
  return 1
}

# ── cleanup survivors, asserted on every path ────────────────────────────────
#
# These ran only under S6_SELF_TEST, which is the one configuration where a leak
# is least likely to matter and most likely to be noticed anyway. The ordinary
# run -- the one CI executes, the one that ends in a blocked 78 -- reported
# nothing about survivors at all, so a workerd holding a port and a D1 file into
# the next run would exit 78 looking exactly like a clean run.
assert_no_survivors() {
  local pgid="$1"
  local table row orphans listeners state_fds members status state_fd_pid

  # ── the process table ─────────────────────────────────────────────────────
  # Assigned before it is tested. `local x="$(cmd)"` would discard cmd's exit
  # status behind `local`'s own, which is always 0.
  table="$(ps -eo pid=,ppid=,command= 2>/dev/null)"
  status=$?
  if (( status != 0 )); then
    fail_record "process_inspection_available" \
      "ps exited ${status}; survivor state is unknown, so this run will not report zero"
    return 1
  fi
  if [[ -z "${table}" ]]; then
    fail_record "process_inspection_available" \
      "ps produced no rows at all; survivor state is unknown, so this run will not report zero"
    return 1
  fi
  # One well-formed row used to be enough. A truncated or malformed row can be
  # precisely the runtime we failed to account for, so every nonempty row must
  # parse before a zero count means anything. The runner itself must appear too:
  # a partial table containing only unrelated processes is not an inspection.
  while IFS= read -r row; do
    [[ -z "${row}" ]] && continue
    if ! [[ "${row}" =~ ^[[:space:]]*[0-9]+[[:space:]]+[0-9]+[[:space:]]+.+$ ]]; then
      fail_record "process_inspection_parsable" \
        "a nonempty ps row did not match the expected 'pid ppid command' shape; survivor state is unknown"
      return 1
    fi
  done <<<"${table}"
  if ! printf '%s\n' "${table}" | awk -v runner="$$" '$1 == runner { found = 1 } END { exit(found ? 0 : 1) }'; then
    fail_record "process_inspection_has_runner_sentinel" \
      "ps did not report this runner pid $$; survivor state is unknown"
    return 1
  fi

  # ── listeners on the owned port ───────────────────────────────────────────
  if ! command -v lsof >/dev/null 2>&1; then
    lifecycle_capability_block "LIFECYCLE_LSOF_UNAVAILABLE" \
      "lsof is unavailable while inspecting the owned port; listener and state-directory ownership are unknown"
    return "${BLOCKED_EXIT}"
  fi
  # lsof exits 1 with empty output when nothing matches -- that is "no listener",
  # not a failure. Any other nonzero status, or a nonzero status with output, is
  # an inspection failure and must not be read as zero.
  listeners="$(lsof -ti tcp:"${S6_PORT}" 2>/dev/null)"
  status=$?
  if (( status > 1 )) || { (( status == 1 )) && [[ -n "${listeners}" ]]; }; then
    lifecycle_capability_block "LIFECYCLE_LSOF_UNAVAILABLE" \
      "lsof exited ${status} while inspecting the owned port; listener and state-directory ownership are unknown"
    return "${BLOCKED_EXIT}"
  fi
  if ! port_accepts_bind "${S6_PORT}"; then
    fail_record "listener_bind_proves_port_released" \
      "the owned loopback port could not be rebound after cleanup; lsof's empty result is insufficient"
    return 1
  fi

  # lsof's recursive state-directory view is a second, distinct claim: after
  # cleanup it must be able to show that no process retains an FD under this
  # run's D1/log directory. This is not a claim to find arbitrary daemons on a
  # platform without containment; it is a fail-closed inspection of this exact
  # runtime state root.
  state_fds="$(lsof -t +D "${STATE_DIR}" 2>/dev/null)"
  status=$?
  if (( status > 1 )) || { (( status == 1 )) && [[ -n "${state_fds}" ]]; }; then
    lifecycle_capability_block "LIFECYCLE_LSOF_UNAVAILABLE" \
      "lsof exited ${status} while inspecting state-directory file descriptors; ownership is unknown"
    return "${BLOCKED_EXIT}"
  fi
  while IFS= read -r state_fd_pid; do
    [[ -z "${state_fd_pid}" ]] && continue
    if ! [[ "${state_fd_pid}" =~ ^[0-9]+$ ]]; then
      lifecycle_capability_block "LIFECYCLE_LSOF_UNAVAILABLE" \
        "lsof returned a malformed state-directory holder row; ownership is unknown"
      return "${BLOCKED_EXIT}"
    fi
  done <<<"${state_fds}"

  # ── the worker's process group ────────────────────────────────────────────
  members="$(group_members "${pgid}")"
  status=$?
  if (( status != 0 )); then
    fail_record "group_inspection_available" \
      "the process table could not be read while counting group members; survivors are unknown"
    return 1
  fi
  emit "{\"suite\":\"s6-auth-ingress-local\",\"assertion\":\"survivor_inspection_available\",\"status\":\"pass\",\"detail\":\"ps, lsof, lsof +D, the group probe, and an independent bind probe all answered\",\"reproduce\":\"${REPRODUCE}\"}"

  # ── the counts themselves ─────────────────────────────────────────────────
  # Any parent: a grandchild reparented to init still holds the port, and a
  # pid-only check would call that clean.
  orphans="$(printf '%s\n' "${table}" \
    | awk -v state="${STATE_DIR}" '$0 ~ /workerd|wrangler/ && index($0, state) > 0 { print $1 }' \
    | wc -l | tr -d ' ')"
  if [[ "${orphans}" != "0" ]]; then
    fail_record "no_orphaned_runtime_survives" \
      "${orphans} workerd/wrangler process(es) referencing this run's state directory outlived the group"
    return 1
  fi
  emit "{\"suite\":\"s6-auth-ingress-local\",\"assertion\":\"no_orphaned_runtime_survives\",\"status\":\"pass\",\"detail\":\"no workerd or wrangler process referencing this run's state directory survives, under any parent; arbitrary daemon containment is not claimed\",\"reproduce\":\"${REPRODUCE}\"}"

  local listener_count member_count
  listener_count="$(printf '%s' "${listeners}" | grep -c . || true)"
  member_count="$(printf '%s' "${members}" | grep -c . || true)"
  if [[ "${listener_count}" != "0" || "${member_count}" != "0" ]]; then
    fail_record "child_process_group_is_reaped" \
      "${listener_count} listener(s) and ${member_count} group member(s) survived cleanup"
    return 1
  fi
  if [[ -n "${state_fds}" ]]; then
    fail_record "no_runtime_state_directory_fds_survive" \
      "one or more processes still hold file descriptors under this run's state directory"
    return 1
  fi
  emit "{\"suite\":\"s6-auth-ingress-local\",\"assertion\":\"no_runtime_state_directory_fds_survive\",\"status\":\"pass\",\"detail\":\"lsof +D reported no open file descriptor under this run's state directory\",\"reproduce\":\"${REPRODUCE}\"}"
  emit "{\"suite\":\"s6-auth-ingress-local\",\"assertion\":\"child_process_group_is_reaped\",\"status\":\"pass\",\"detail\":\"the worker group is empty, lsof reports no listener, and the owned loopback port was independently rebound\",\"reproduce\":\"${REPRODUCE}\"}"
  return 0
}

# Arm cleanup only after every helper it calls is defined, and before the first
# `start_worker` invocation. A start failure can already own a provisional
# supervisor; the EXIT path must therefore be able to perform the survivor scan
# rather than call an as-yet undefined shell function.
trap on_exit EXIT
trap 'handle_signal 130' INT
trap 'handle_signal 143' TERM
trap 'handle_signal 129' HUP

if ! start_worker; then
  show_redacted "wrangler" "${SERVER_LOG}"
  show_redacted "curl" "${CURL_LOG}"
  fail_record "local_worker_ready" "the local Worker never answered on its owned port"
  exit 1
fi

# ── the checks ───────────────────────────────────────────────────────────────
run_checker() {
  local deadline status exact
  assert_work_budget || return 1
  CHECKER_TOKEN="$(mint_supervisor_token)" || CHECKER_TOKEN=""
  if ! [[ "${CHECKER_TOKEN}" =~ ^[A-Za-z0-9]{32}$ ]]; then
    fail_record "ordinary_checker_identity" "could not mint the checker argv marker"
    return 1
  fi
  LIFECYCLE_CRITICAL=1
  S6_ORIGIN="${ORIGIN}" S6_PHASE="${1:-full}" \
    bun "${CHECKER}" "s6-ordinary-checker:${CHECKER_TOKEN}" 2>"${CHECK_LOG}" &
  CHECKER_PID=$!
  CHECKER_OWNED=1
  CHECKER_STARTED_AT="$(ps -o lstart= -p "${CHECKER_PID}" 2>/dev/null)"; status=$?
  leave_lifecycle_critical
  if (( status != 0 )) || ! checker_identity_is_exact \
    "${CHECKER_PID}" "${CHECKER_STARTED_AT}" "${CHECKER_TOKEN}"; then
    if ! stop_checker; then
      fail_record "ordinary_checker_identity" \
        "the checker identity could not be established and exact-only cleanup also failed"
    fi
    return 1
  fi
  maybe_signal_window "ordinary-checker"

  deadline="$(deadline_after_work "${CHECK_DEADLINE_SECONDS}")"
  while (( SECONDS < deadline )); do
    if direct_child_is_gone "${CHECKER_PID}"; then
      if wait "${CHECKER_PID}"; then status=0; else status=$?; fi
      clear_checker_identity
      return "${status}"
    fi
    # A transiently unreadable process table does not grant signal authority and
    # does not erase the original deadline. Keep polling inside the same budget.
    exact=0
    checker_identity_is_exact \
      "${CHECKER_PID}" "${CHECKER_STARTED_AT}" "${CHECKER_TOKEN}" && exact=1
    if (( exact == 0 )) && direct_child_is_gone "${CHECKER_PID}"; then
      if wait "${CHECKER_PID}"; then status=0; else status=$?; fi
      clear_checker_identity
      return "${status}"
    fi
    sleep 0.2
  done
  if ! stop_checker; then
    return 125
  fi
  return 124
}

readonly RESTART_CHECKER_PHASE_LOG="${STATE_DIR}/restart-checker.ndjson"

restart_checker_phase_is_safe_and_recorded() {
  bun --eval '
    const lines = (await Bun.file(process.argv[1]).text()).split("\n").filter(Boolean);
    const expectedKeys = ["assertion", "detail", "phase", "reproduce", "status", "suite"];
    const matched = lines.some((line) => {
      try {
        const record = JSON.parse(line);
        return JSON.stringify(Object.keys(record).sort()) === JSON.stringify(expectedKeys)
          && record.suite === "s6-auth-ingress-local"
          && record.reproduce === "bash scripts/e2e-s6-auth-ingress.sh"
          && record.assertion === "restart_checker_stopped_with_spent_envelope"
          && record.status === "pass"
          && record.phase === "restart"
          && record.detail === "one accepted envelope remains only in this checker process memory";
      } catch {
        return false;
      }
    });
    process.exit(matched ? 0 : 1);
  ' "${RESTART_CHECKER_PHASE_LOG}" >/dev/null 2>&1
}

start_restart_checker() {
  local deadline state status
  assert_work_budget || return 1
  [[ -z "${RESTART_CHECKER_PID}" ]] || return 1
  RESTART_CHECKER_PID=""
  RESTART_CHECKER_STARTED_AT=""
  RESTART_CHECKER_TOKEN="$(mint_supervisor_token)" || RESTART_CHECKER_TOKEN=""
  if ! [[ "${RESTART_CHECKER_TOKEN}" =~ ^[A-Za-z0-9]{32}$ ]]; then return 1; fi
  LIFECYCLE_CRITICAL=1
  S6_ORIGIN="${ORIGIN}" S6_PHASE="restart" \
    S6_RESTART_CHECKER_TOKEN="${RESTART_CHECKER_TOKEN}" \
    bun "${CHECKER}" "s6-restart-checker:${RESTART_CHECKER_TOKEN}" \
      >"${RESTART_CHECKER_PHASE_LOG}" 2>"${CHECK_LOG}" &
  RESTART_CHECKER_PID=$!
  RESTART_CHECKER_STARTED_AT="$(ps -o lstart= -p "${RESTART_CHECKER_PID}" 2>/dev/null)"; status=$?
  leave_lifecycle_critical
  if (( status != 0 )) || ! restart_checker_identity_is_exact \
    "${RESTART_CHECKER_PID}" "${RESTART_CHECKER_STARTED_AT}" "${RESTART_CHECKER_TOKEN}"; then
    if ! stop_restart_checker; then
      fail_record "restart_checker_coordination" \
        "the checker identity could not be established and exact-only cleanup also failed"
    fi
    return 1
  fi

  deadline="$(deadline_after_work "${CHECK_DEADLINE_SECONDS}")"
  while (( SECONDS < deadline )); do
    if ! restart_checker_identity_is_exact \
      "${RESTART_CHECKER_PID}" "${RESTART_CHECKER_STARTED_AT}" "${RESTART_CHECKER_TOKEN}"; then
      if direct_child_is_gone "${RESTART_CHECKER_PID}"; then
        if ! wait "${RESTART_CHECKER_PID}" 2>/dev/null; then :; fi
        clear_restart_checker_identity
        return 1
      fi
      sleep 0.1
      continue
    fi
    state="$(ps -o stat= -p "${RESTART_CHECKER_PID}" 2>/dev/null)"; status=$?
    if (( status != 0 )); then return 1; fi
    if [[ "${state}" == *T* ]]; then
      if restart_checker_phase_is_safe_and_recorded; then
        maybe_signal_window "restart-checker"
        return 0
      fi
      if ! stop_restart_checker; then
        fail_record "restart_checker_coordination" \
          "the stopped checker phase record was unsafe and exact-only cleanup failed"
      fi
      return 1
    fi
    sleep 0.1
  done
  if ! stop_restart_checker; then
    fail_record "restart_checker_coordination" \
      "the checker did not stop by its deadline and exact-only cleanup failed"
  fi
  return 1
}

resume_restart_checker() {
  [[ -n "${RESTART_CHECKER_PID}" ]] || return 1
  assert_work_budget || return 124
  local deadline status exact=0 saw_injected_failure=0
  deadline="$(deadline_after_work "${CHECK_DEADLINE_SECONDS}")"
  # The deadline is established before the first inspection and is never reset.
  # A failed ps therefore consumes budget instead of falling into `wait` on a
  # child whose completion has not been established.
  while (( SECONDS < deadline )); do
    if restart_checker_identity_is_exact \
      "${RESTART_CHECKER_PID}" "${RESTART_CHECKER_STARTED_AT}" "${RESTART_CHECKER_TOKEN}"; then
      exact=1
      break
    fi
    if direct_child_is_gone "${RESTART_CHECKER_PID}"; then
      if wait "${RESTART_CHECKER_PID}"; then status=0; else status=$?; fi
      clear_restart_checker_identity
      return "${status}"
    fi
    sleep 0.1
  done
  if (( exact != 1 )); then
    return 124
  fi
  if ! restart_checker_identity_is_exact \
    "${RESTART_CHECKER_PID}" "${RESTART_CHECKER_STARTED_AT}" "${RESTART_CHECKER_TOKEN}" \
    || ! kill -CONT "${RESTART_CHECKER_PID}" 2>/dev/null; then
    return 1
  fi
  while (( SECONDS < deadline )); do
    if (( TEST_RESTART_INSPECTION_FAILURES_REMAINING > 0 )); then
      TEST_RESTART_INSPECTION_FAILURES_REMAINING=$((TEST_RESTART_INSPECTION_FAILURES_REMAINING - 1))
      saw_injected_failure=1
      sleep 0.1
      continue
    fi
    if direct_child_is_gone "${RESTART_CHECKER_PID}"; then
      if wait "${RESTART_CHECKER_PID}"; then status=0; else status=$?; fi
      clear_restart_checker_identity
      if (( saw_injected_failure == 1 )); then
        expected_negative_record "post_resume_inspection_failure_is_bounded" \
          "transient post-resume identity inspection failures consumed the original deadline and then recovered"
      fi
      return "${status}"
    fi
    # No wait follows a failed inspection. Exact identity may reappear on the
    # next poll; a replaced PID can never be signalled by this function.
    if ! restart_checker_identity_is_exact \
      "${RESTART_CHECKER_PID}" "${RESTART_CHECKER_STARTED_AT}" "${RESTART_CHECKER_TOKEN}"; then
      sleep 0.1
      continue
    fi
    sleep 0.1
  done
  if ! stop_restart_checker; then
    return 125
  fi
  return 124
}

run_checker
CHECK_EXIT=$?
show_redacted "checker stderr" "${CHECK_LOG}"

if [[ ${CHECK_EXIT} -ne 0 ]]; then
  show_redacted "wrangler" "${SERVER_LOG}"
  show_redacted "curl" "${CURL_LOG}"
  fail_record "local_ingress_checks" "a local ingress assertion failed (checker exit ${CHECK_EXIT})"
  exit 1
fi

# ── restart-persistent replay: the nonce must outlive the process ────────────
#
# Everything above ran against one live isolate, so all of it is equally
# satisfied by an in-memory nonce set. One checker spends the envelope then
# SIGSTOPs itself with that envelope only in memory; the shell verifies that
# stopped child before restarting workerd and resumes the exact same child.
if ! start_restart_checker; then
  show_redacted "checker stderr" "${CHECK_LOG}"
  fail_record "restart_checker_coordination" \
    "the restart checker did not stop within its bound after a safe phase record"
  exit 1
fi
show_redacted "checker stderr" "${CHECK_LOG}"
emit "{\"suite\":\"s6-auth-ingress-local\",\"assertion\":\"restart_checker_coordination\",\"status\":\"pass\",\"detail\":\"the exact checker child stopped after spending its envelope and before worker restart\",\"reproduce\":\"${REPRODUCE}\"}"

# A clean stop, so D1 flushes to the persist directory rather than being killed
# mid-write. A SIGKILL here would make a lost row indistinguishable from a lost
# defence.
if ! stop_worker; then
  fail_record "restart_persistent_replay" "the worker group could not be cleanly stopped before the restart"
  exit 1
fi

if ! start_worker; then
  show_redacted "wrangler" "${SERVER_LOG}"
  show_redacted "curl" "${CURL_LOG}"
  fail_record "restart_persistent_replay" "the local Worker did not come back up against the persisted state directory"
  exit 1
fi
emit "{\"suite\":\"s6-auth-ingress-local\",\"assertion\":\"the_worker_restarts_against_the_same_persisted_d1\",\"status\":\"pass\",\"detail\":\"workerd stopped and restarted with the same --persist-to state directory\",\"reproduce\":\"${REPRODUCE}\"}"

if [[ "${SELF_TEST}" == "1" && "${SELF_TEST_NESTED}" == "0" ]]; then
  TEST_RESTART_INSPECTION_FAILURES_REMAINING=3
fi
resume_restart_checker
PERSIST_REPLAY_EXIT=$?
show_redacted "checker stderr" "${CHECK_LOG}"
if [[ ${PERSIST_REPLAY_EXIT} -ne 0 ]]; then
  show_redacted "wrangler" "${SERVER_LOG}"
  fail_record "restart_persistent_replay" "the same envelope was not refused after the restart (checker exit ${PERSIST_REPLAY_EXIT})"
  exit 1
fi
emit "{\"suite\":\"s6-auth-ingress-local\",\"assertion\":\"restart_persistent_replay\",\"status\":\"pass\",\"detail\":\"one in-memory envelope was accepted before restart, refused after restart, and a distinct fresh envelope was accepted after restart\",\"reproduce\":\"${REPRODUCE}\"}"

# ── lifecycle self-tests, opt-in ─────────────────────────────────────────────
if [[ "${SELF_TEST}" == "1" ]] \
  && { [[ "${SELF_TEST_NESTED}" == "0" ]] \
    || [[ "${S6_TEST_SIGNAL_WINDOW:-}" == "busy-contender" ]]; }; then
  # ── planted: every survivor inspection must fail CLOSED ───────────────────
  #
  # Each stub below breaks one inspection. Before this, all of them produced the
  # same answer -- "0 survivors" -- because a failing `ps`, a missing `lsof` and
  # an unparsable process table all yield empty output, and empty output counts
  # as zero. A run on a machine without lsof would have reported a clean
  # shutdown it never established. Each case must now name its own failure.
  #
  # The stubs are plain function definitions inside a subshell, so nothing here
  # can leak into the real run, and no `eval` is involved.
  run_inspection() {
    if assert_no_survivors "${SERVER_PGID}"; then printf 'returned-success'; else printf 'returned-failure'; fi
  }
  judge_inspection() {
    local expected="$1" observed="$2" parser_fault="${3:-}"
    if [[ "${observed}" != *"returned-failure"* || "${observed}" != *"${expected}"* ]]; then
      fail_record "survivor_inspection_fails_closed" \
        "with ${expected} broken, the survivor check did not fail closed naming that assertion"
      exit 1
    fi
    if [[ -n "${parser_fault}" ]]; then
      expected_negative_record "process_table_parser_rejects_${parser_fault}_row" \
        "the real assert_no_survivors parser rejected the planted ${parser_fault} process-table row"
    fi
  }
  judge_blocked_capability() {
    local observed="$1"
    if [[ "${observed}" != *"returned-failure"* \
      || "${observed}" != *'"status":"blocked"'* \
      || "${observed}" != *'"code":"LIFECYCLE_LSOF_UNAVAILABLE"'* ]]; then
      fail_record "lifecycle_lsof_unavailable_is_blocked" \
        "a missing or unusable lsof did not return the named blocked capability result"
      exit 1
    fi
  }

  judge_inspection "process_inspection_available" \
    "$( ( ps() { return 3; }; run_inspection ) 2>&1 )"
  judge_inspection "process_inspection_available" \
    "$( ( ps() { printf ''; }; run_inspection ) 2>&1 )"
  judge_inspection "process_inspection_parsable" \
    "$( ( ps() { printf 'not a process table\n'; }; run_inspection ) 2>&1 )" "malformed"
  judge_inspection "process_inspection_parsable" \
    "$( ( ps() { printf '  1  1 init\ntruncated-row\n'; }; run_inspection ) 2>&1 )" "truncated"
  judge_inspection "process_inspection_has_runner_sentinel" \
    "$( ( ps() { printf '  1  1 init\n'; }; run_inspection ) 2>&1 )"
  # shellcheck disable=SC2329 # `command` is invoked indirectly by assert_no_survivors.
  judge_blocked_capability \
    "$( ( command() { [[ "$2" == "lsof" ]] && return 1; builtin command "$@"; }; run_inspection ) 2>&1 )"
  # shellcheck disable=SC2329 # `lsof` is invoked indirectly by assert_no_survivors.
  judge_blocked_capability \
    "$( ( lsof() { printf 'junk\n'; return 4; }; run_inspection ) 2>&1 )"
  emit "{\"suite\":\"s6-auth-ingress-local\",\"assertion\":\"lifecycle_lsof_unavailable_is_blocked\",\"status\":\"pass\",\"detail\":\"planted missing and unusable lsof capability both produced LIFECYCLE_LSOF_UNAVAILABLE blocked records\",\"reproduce\":\"${REPRODUCE}\"}"
  # PLANTED: an installed lsof can still return its normal empty/no-match shape
  # while a listener exists. The independent bind must reject that false green.
  # shellcheck disable=SC2329 # `lsof` is invoked indirectly by assert_no_survivors.
  judge_inspection "listener_bind_proves_port_released" \
    "$( ( lsof() { return 1; }; run_inspection ) 2>&1 )"
  judge_inspection "group_inspection_available" \
    "$( ( lsof() { return 1; }; port_accepts_bind() { return 0; }; group_members() { return 2; }; run_inspection ) 2>&1 )"
  expected_negative_record "survivor_inspection_fails_closed" \
    "planted inspection failures were all rejected without a zero-survivor claim"

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
      supervisor_identity_is_exact() { return 0; }
      kill() { return 0; }
      sleep() { return 0; }
      if stop_group 999999 4242 started token; then printf 'returned-success'; else printf 'returned-failure'; fi
    ) 2>&1
  )"
  if [[ "${survivor_probe}" != *"returned-failure"* ]]; then
    fail_record "stop_group_fails_when_members_survive_sigkill" \
      "stop_group reported success with group members still present after SIGKILL"
    exit 1
  fi
  if [[ "${survivor_probe}" != *"leaves_no_surviving_process_group_members"* ]]; then
    fail_record "stop_group_names_the_surviving_members" \
      "stop_group failed without emitting the survivor assertion"
    exit 1
  fi
  expected_negative_record "stop_group_fails_when_members_survive_sigkill" \
    "a planted survivor after SIGKILL was reported and rejected"

  # Exercise group_members itself with bad `ps` results. These reach the real
  # table parser: malformed and truncated successful output must be rejected,
  # and a nonzero `ps` status must remain inspection-unavailable rather than
  # being converted into an empty group.
  run_group_members_parser_probe() {
    if group_members 999999; then
      printf 'returned-success'
    else
      printf 'returned-failure:%s' "$?"
    fi
  }
  malformed_group_probe="$(
    ( ps() { printf 'not a process table\n'; return 0; }; run_group_members_parser_probe ) 2>&1
  )"
  truncated_group_probe="$(
    ( ps() { printf '  1  1\n  2\n'; return 0; }; run_group_members_parser_probe ) 2>&1
  )"
  unreadable_parser_probe="$(
    ( ps() { return 3; }; run_group_members_parser_probe ) 2>&1
  )"
  judge_group_members_parser() {
    local table_fault="$1" parser_probe="$2"
    if [[ "${parser_probe}" != *"returned-failure:2"* ]]; then
      fail_record "group_members_parser_fails_closed" \
        "the planted ${table_fault} process table bypassed the real group_members parser"
      exit 1
    fi
    expected_negative_record "group_members_parser_rejects_${table_fault}_table" \
      "the real group_members parser returned inspection status 2 for the planted ${table_fault} table"
  }
  judge_group_members_parser "malformed" "${malformed_group_probe}"
  judge_group_members_parser "truncated" "${truncated_group_probe}"
  judge_group_members_parser "unreadable" "${unreadable_parser_probe}"
  expected_negative_record "group_members_parser_rejects_malformed_truncated_and_unreadable_tables" \
    "executed malformed, truncated, and unreadable ps tables all returned inspection status 2"

  partial_group_probe="$(
    (
      ps() { [[ "$1" == "-eo" ]] && { printf '  1  1\n'; return 0; }; return 1; }
      kill() { [[ "$1" == "-0" ]] && return 0; builtin kill "$@"; }
      if group_members 999999; then printf 'returned-success'; else printf 'returned-failure'; fi
    ) 2>&1
  )"
  if [[ "${partial_group_probe}" != *"returned-failure"* ]]; then
    fail_record "group_members_rejects_partial_ps_table" \
      "a live group missing from an otherwise well-formed process table was treated as empty"
    exit 1
  fi

  blank_direct_group_probe="$(
    (
      ps() {
        if [[ "$1" == "-eo" ]]; then printf '  1  1\n'; return 0; fi
        if [[ "$1" == "-o" ]]; then printf ''; return 0; fi
        return 1
      }
      if group_members 999999; then printf 'returned-success'; else printf 'returned-failure'; fi
    ) 2>&1
  )"
  if [[ "${blank_direct_group_probe}" != *"returned-failure"* ]]; then
    fail_record "group_members_rejects_blank_direct_ps" \
      "a successful but empty direct ps lookup was treated as proof that a group was gone"
    exit 1
  fi

  # A process-table failure must never be converted into an empty group by a
  # command substitution inside `[[ -z ... ]]`. Exercise both the initial
  # emptiness check and the ownership proof with an unreadable group probe.
  unreadable_group_probe="$(
    (
      # shellcheck disable=SC2329 # stop_group reaches this through group_members.
      ps() { return 3; }
      if stop_group 999999 4242 started token; then printf 'returned-success'; else printf 'returned-failure'; fi
    ) 2>&1
  )"
  if [[ "${unreadable_group_probe}" != *"returned-failure"* || "${unreadable_group_probe}" != *"group_inspection_available"* ]]; then
    fail_record "stop_group_fails_closed_when_ps_is_unreadable" \
      "an unreadable group probe was treated as empty or did not name the inspection failure"
    exit 1
  fi
  supervisor_identity_probe="$(
    (
      group_members() { printf '%s\n' 4242; }
      supervisor_identity_is_exact() { return 1; }
      if stop_group 999999 4242 started token; then printf 'returned-success'; else printf 'returned-failure'; fi
    ) 2>&1
  )"
  if [[ "${supervisor_identity_probe}" != *"returned-failure"* || "${supervisor_identity_probe}" != *"never_signals_a_recycled_group"* ]]; then
    fail_record "pinned_supervisor_identity_fails_closed" \
      "a missing or replaced pinned supervisor was treated as a safe group to signal"
    exit 1
  fi
  expected_negative_record "stop_group_fails_closed_when_ps_is_unreadable" \
    "planted partial and unreadable process tables, plus a missing supervisor identity, all failed closed"

  # These are executable pre-exec faults, not source-shape checks. Each forces
  # launch_pinned_supervisor to reject after SIGSTOP and proves its exact direct
  # child was KILLed and waited without a negative-PGID signal.
  run_preexec_fault() {
    local mode="$1" launch_status=0 reaped_pid=""
    LAST_PROVISIONAL_REAPED_PID=""
    EXPECTED_NEGATIVE_ASSERTION="pinned_supervisor_identity"
    if [[ "${mode}" == "not-group-leader" ]]; then
      S6_TEST_SUPERVISOR_NOT_GROUP_LEADER=1 \
        launch_pinned_supervisor "${STATE_DIR}/preexec-${mode}.log" sleep 2147483647 || launch_status=$?
    else
      S6_TEST_SUPERVISOR_IDENTITY_UNAVAILABLE=1 \
        launch_pinned_supervisor "${STATE_DIR}/preexec-${mode}.log" sleep 2147483647 || launch_status=$?
    fi
    EXPECTED_NEGATIVE_ASSERTION=""
    reaped_pid="${LAST_PROVISIONAL_REAPED_PID}"
    if (( launch_status == 0 )) || ! [[ "${reaped_pid}" =~ ^[0-9]+$ ]] \
      || supervisor_direct_child_is_exact "${reaped_pid}" \
        "${LAST_PROVISIONAL_REAPED_STARTED_AT}" "${LAST_PROVISIONAL_REAPED_TOKEN}"; then
      fail_record "preexec_supervisor_fault_reaped" \
        "${mode} did not return nonzero with a reaped stopped direct child"
      exit 1
    fi
  }
  run_preexec_fault "not-group-leader"
  run_preexec_fault "identity-unavailable"
  expected_negative_record "preexec_supervisor_fault_reaped" \
    "injected non-leader and transient identity-unavailable launches returned nonzero with no live stopped child"

  # Persistent inspection failure and a planted reused PID must never turn
  # shell parentage into signal authority. Both probes record every attempted
  # signal; an exact marker/lstart failure must leave that record empty.
  provisional_reuse_probe="$({
    (
      SUPERVISOR_PID=424242
      SUPERVISOR_STARTED_AT="Mon Jan  1 00:00:00 2001"
      SUPERVISOR_TOKEN="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      PROVISIONAL_SUPERVISOR_OWNED=1
      supervisor_direct_child_is_exact() { return 1; }
      kill() { printf 'SIGNALLED:%s\n' "$*"; return 0; }
      sleep() { return 0; }
      if reap_provisional_supervisor; then printf 'returned-success\n'; else printf 'returned-failure\n'; fi
    ) 2>&1
  })"
  if [[ "${provisional_reuse_probe}" != *"returned-failure"* \
    || "${provisional_reuse_probe}" == *"SIGNALLED:"* ]]; then
    fail_record "reused_direct_pid_is_never_signalled" \
      "a provisional supervisor with mismatched lstart/marker was signalled or accepted"
    exit 1
  fi

  persistent_inspection_probe="$({
    (
      TEST_DIRECT_CHILD_CLEANUP_SECONDS=1
      direct_child_identity_is_exact() { return 1; }
      direct_child_has_exited() { return 1; }
      kill() { printf 'SIGNALLED:%s\n' "$*"; return 0; }
      if stop_exact_direct_child persistent_inspection 434343 started marker 1; then
        printf 'returned-success\n'
      else
        printf 'returned-failure\n'
      fi
    ) 2>&1
  })"
  if [[ "${persistent_inspection_probe}" != *"returned-failure"* \
    || "${persistent_inspection_probe}" == *"SIGNALLED:"* ]]; then
    fail_record "persistent_identity_inspection_fails_closed" \
      "persistent identity inspection failure signalled an unverified direct PID"
    exit 1
  fi
  expected_negative_record "reused_direct_pid_is_never_signalled" \
    "planted reused and persistently uninspectable direct PIDs received no CONT, TERM, or KILL"

  # Planted failure: the same checker against a shifted clock must FAIL, which
  # proves the gate is capable of failing rather than structurally green.
  STALE_NOW=$((S6_NOW - 86400))
  if ! [[ "${STALE_NOW}" =~ ^[0-9]+$ ]]; then
    fail_record "self_test_is_runnable" "could not compute a stale clock for the planted failure"
    exit 1
  fi
  planted_exit=0
  env S6_ORIGIN="${ORIGIN}" S6_NOW="${STALE_NOW}" S6_KID="${S6_KID}" \
    bun "${CHECKER}" >/dev/null 2>"${STATE_DIR}/planted.log" || planted_exit=$?
  if [[ ${planted_exit} -eq 0 ]]; then
    fail_record "planted_failure_is_detected" "a deliberately stale-clock run passed; the gate cannot fail"
    exit 1
  fi
  expected_negative_record "planted_failure_is_detected" \
    "the deliberately stale-clock checker exited ${planted_exit}"

  # Busy port: a second Worker on the owned port must not become ready, and must
  # not be reported as a pass by borrowing the first Worker's liveness.
  # The contender runs with its OWN run id. Two things must hold: it must never
  # win the port, and the health endpoint must keep answering with the original
  # run id — which is what proves a contender can never be mistaken for ours.
  busy_run_id="contender$(bun --eval 'console.log(crypto.randomUUID().replace(/-/g, "").slice(0, 12));')"
  if ! launch_pinned_supervisor "${STATE_DIR}/busy.log" "${WRANGLER}" dev --config "${CONFIG}" --local --persist-to "${STATE_DIR}" \
    --port "${S6_PORT}" --inspector-port 0 --log-level error \
    --show-interactive-dev-session=false \
    --var "S6_RUN_ID:${busy_run_id}"; then
    fail_record "busy_port_contender_group_inspection" \
      "could not establish the contender's stopped pinned supervisor"
    exit 1
  fi
  if ! adopt_provisional_as_busy_contender; then
    fail_record "busy_port_contender_group_inspection" \
      "could not transfer the contender atomically into finalizer ownership"
    exit 1
  fi
  busy_pgid="${BUSY_PGID}"
  if ! resume_pinned_supervisor "${BUSY_SUPERVISOR_PID}" "${BUSY_PGID}" \
    "${BUSY_SUPERVISOR_STARTED_AT}" "${BUSY_SUPERVISOR_TOKEN}"; then
    fail_record "busy_port_contender_group_inspection" \
      "could not resume the contender's recorded pinned supervisor"
    exit 1
  fi
  maybe_signal_window "busy-contender"

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
  if ! stop_busy_contender; then
    fail_record "busy_port_contender_group_is_reaped" \
      "the contender group could not be inspected and terminated safely"
    exit 1
  fi

  if [[ "${busy_served}" == "yes" ]]; then
    fail_record "busy_port_contender_never_wins" "a second Worker answered on the owned port with its own run id"
    exit 1
  fi
  if [[ "${owner_health}" != *"\"run_id\":\"${S6_RUN_ID}\""* ]]; then
    fail_record "busy_port_owner_keeps_the_port" "the owned port stopped answering with this run's id while a contender was up"
    exit 1
  fi
  busy_members="$(group_members "${busy_pgid}")"
  busy_group_status=$?
  if (( busy_group_status != 0 )); then
    fail_record "busy_port_contender_group_is_reaped" \
      "the contender group could not be inspected after termination"
    exit 1
  fi
  busy_survivors="$(printf '%s' "${busy_members}" | grep -c . || true)"
  if [[ "${busy_survivors}" != "0" ]]; then
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
    fail_record "foreign_readiness_is_rejected" "the owned health endpoint returned nothing to test against"
    exit 1
  fi
  if [[ "${live_health}" == *"\"run_id\":\"${foreign_id}\""* ]]; then
    fail_record "foreign_readiness_is_rejected" "the health endpoint reported a run id this run never minted"
    exit 1
  fi
  if [[ "${live_health}" != *"\"run_id\":\"${S6_RUN_ID}\""* ]]; then
    fail_record "foreign_readiness_is_rejected" "the health endpoint did not carry this run's ownership marker"
    exit 1
  fi
  emit "{\"suite\":\"s6-auth-ingress-local\",\"assertion\":\"foreign_readiness_is_rejected\",\"status\":\"pass\",\"detail\":\"readiness matches this run's marker exactly and rejects a foreign one\",\"reproduce\":\"${REPRODUCE}\"}"

  # SIGTERM: exercise the production stop path rather than sending a raw
  # negative-PGID signal here. That keeps the self-test under the same pinned
  # supervisor identity proof and reuse guard as normal cleanup.
  sigterm_pgid="${SERVER_PGID}"
  if ! stop_worker; then
    fail_record "sigterm_terminates_the_worker_group" \
      "the production pinned-supervisor stop path could not terminate the worker group"
    exit 1
  fi
  if ! assert_no_survivors "${sigterm_pgid}"; then
    fail_record "sigterm_releases_the_port" \
      "the production stop path did not establish an empty group, released port, and closed state-directory descriptors"
    exit 1
  fi
  emit "{\"suite\":\"s6-auth-ingress-local\",\"assertion\":\"sigterm_terminates_the_worker_group\",\"status\":\"pass\",\"detail\":\"the production pinned-supervisor stop path reaped the group and proved port release\",\"reproduce\":\"${REPRODUCE}\"}"

  # A wedged post-resume checker must consume its original deadline and be
  # terminated by exact identity, never enter an unbounded wait. Run the full
  # live path in a child so its intentional nonzero terminal record is evidence
  # consumed by this self-test rather than a `status:"fail"` record in the
  # successful self-test stream.
  if ! run_nested_harness "wedged-restart-checker" \
    "S6_TEST_WEDGE_AFTER_RESTART=1" \
    "S6_TEST_CHECK_DEADLINE_SECONDS=2"; then
    fail_record "wedged_restart_checker_is_bounded" \
      "the tracked nested harness could not be completed or exactly cleaned"
    exit 1
  fi
  wedged_status="${NESTED_HARNESS_EXIT}"
  wedged_output="${NESTED_HARNESS_OUTPUT}"
  if [[ "${wedged_status}" != "1" \
    || "${wedged_output}" != *"checker exit 124"* \
    || "${wedged_output}" != *"\"assertion\":\"child_process_group_is_reaped\",\"status\":\"pass\""* \
    || "${wedged_output}" != *"\"assertion\":\"no_runtime_state_directory_fds_survive\",\"status\":\"pass\""* ]]; then
    fail_record "wedged_restart_checker_is_bounded" \
      "the wedged post-resume checker did not time out at 124 with zero group, port, and state-directory survivors"
    exit 1
  fi
  expected_negative_record "wedged_restart_checker_is_bounded" \
    "a TERM-resistant post-resume checker exhausted the original deadline, was reaped by exact identity, and left zero survivors"

  # Exercise the real EXIT finalizer from every ownership window. Each child is
  # expected to terminate with HUP's 129, and every one must independently prove
  # an empty owned process group, a re-bindable port, and no state-directory FD.
  run_signal_window() {
    local window="$1" child_status child_output repeat_signal=0 inspection_failure=0
    if [[ "${window}" == "worker" ]]; then
      repeat_signal=1
      inspection_failure=1
    fi
    if ! run_nested_harness "signal-${window}" \
      "S6_TEST_SIGNAL_WINDOW=${window}" \
      "S6_TEST_REPEAT_SIGNAL_DURING_CLEANUP=${repeat_signal}" \
      "S6_TEST_GROUP_INSPECTION_FAILURES_REMAINING=${inspection_failure}" \
      "S6_TEST_CHECK_DEADLINE_SECONDS=5"; then
      fail_record "finalizer_owns_${window//-/_}" \
        "the tracked ${window} harness could not be completed or exactly cleaned"
      exit 1
    fi
    child_status="${NESTED_HARNESS_EXIT}"
    child_output="${NESTED_HARNESS_OUTPUT}"
    if [[ "${child_status}" != "129" \
      || "${child_output}" != *"\"assertion\":\"signal_during_${window//-/_}\",\"status\":\"expected_negative\""* \
      || "${child_output}" != *"\"assertion\":\"child_process_group_is_reaped\",\"status\":\"pass\""* \
      || "${child_output}" != *"\"assertion\":\"no_runtime_state_directory_fds_survive\",\"status\":\"pass\""* \
      || "${child_output}" != *"\"assertion\":\"no_orphaned_runtime_survives\",\"status\":\"pass\""* \
      || "${child_output}" == *"\"status\":\"fail\""* ]]; then
      fail_record "finalizer_owns_${window//-/_}" \
        "signal-window child exited ${child_status} without clean group, port, FD, and orphan evidence"
      exit 1
    fi
    if [[ "${window}" == "worker" \
      && ( "${child_output}" != *"\"assertion\":\"post_parser_group_inspection_failure\",\"status\":\"expected_negative\""* \
        || "${child_output}" != *"\"assertion\":\"finalizer_retried_transient_inspection\",\"status\":\"pass\""* ) ]]; then
      fail_record "post_parser_group_inspection_failure_is_retried" \
        "the worker-window child did not execute the real parser before one bounded finalizer retry"
      exit 1
    fi
    expected_negative_record "finalizer_owns_${window//-/_}" \
      "HUP during ${window} ownership exited 129 after zero process-group, port, FD, and orphan survivors"
    if [[ "${window}" == "worker" ]]; then
      expected_negative_record "post_parser_group_inspection_failure_is_retried" \
        "the real group_members parser ran before the planted failure and the retained worker identity was reaped on bounded retry"
    fi
  }

  for signal_window in provisional-supervisor ordinary-checker restart-checker worker busy-contender; do
    run_signal_window "${signal_window}"
  done

  if ! cleanup_and_verify; then
    fail_record "self_test_cleanup_proved" \
      "the parent self-test did not leave zero process-group, port, FD, and orphan survivors"
    exit 1
  fi
  emit "{\"suite\":\"s6-auth-ingress-local\",\"assertion\":\"self_test_complete\",\"status\":\"pass\",\"mode\":\"self-test\",\"exit_code\":0,\"detail\":\"all expected negatives were detected and every lifecycle owner was finalized without survivors\",\"reproduce\":\"S6_SELF_TEST=1 ${REPRODUCE}\"}"
  exit 0
fi

if cleanup_and_verify; then
  :
else
  cleanup_status=$?
  if (( cleanup_status == BLOCKED_EXIT )); then
    exit "${BLOCKED_EXIT}"
  fi
  fail_record "worker_group_cleanup_proved" \
    "cleanup or survivor inspection could not establish that this run left no runtime behind"
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
