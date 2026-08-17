#!/usr/bin/env bash
# S-6 cross-plane auth, live preview spike (bead asimposiumorg-vw3).
#
# Proves the seam against REAL infrastructure: a Vercel preview running Auth.js
# with Google, and a deployed Worker with real bindings. In one run:
#
#   1. a real Google sign-in issues a HOST-ONLY session cookie on the apex,
#      observed as the live `Set-Cookie` header (no Domain= attribute);
#   2. a sponsor write leaves through the real console Server Action and the
#      Worker attributes the resulting enrollment to that human;
#   3. WRONG_PRINCIPAL in BOTH directions, each with its exact 403 and code;
#   4. replay, altered payload and expired envelope are each refused.
#
# There is no offline mode, no fixture mode and no "simulated" pass. Exit 78
# (EX_CONFIG) means blocked; exit 1 means the spike ran and something failed.
#
# ## Division of labour, and why the browser leg exists
#
# Two claims cannot be made from a shell:
#
#   * host-only cookie scoping is an assertion about what the ORIGIN SENT. A
#     storage-state file is a product of a login that already happened and
#     cannot testify to the header. An earlier revision asserted cookie
#     attributes from such a file and was correctly rejected for it.
#   * `mintJoinUrl` is a Server Action gated on an HMAC-sealed payload from a
#     prior action and addressed by a per-build action id.
#
# Both belong to `e2e/playwright/s6-cross-plane-runner.ts`, which performs the
# real Google sign-in with the configured test account. This script requires
# that runner; the Google credentials are USED, not merely demanded.
#
# ## What this script signs, and why that is not a second auth seam
#
# Negative cases need envelopes real in every respect except the property under
# test, so they are minted by the PRODUCT minter — `apps/web/lib/service-envelope.ts`,
# the module the Agora server actions use — through a runtime shim. This script
# implements no canonicalization, no signing and no key handling of its own.
#
# ## Credential handling
#
# No secret ever appears in argv. Every request that carries a credential passes
# its headers to curl through a `--config` document on stdin, which is not
# visible in the process table. Child processes receive a scrubbed environment.
#
# Required environment:
#   ASIMP_S6_PREVIEW_URL      https://<preview>.vercel.app   (Agora, apex plane)
#   ASIMP_S6_WORKER_URL       https://<preview-worker>       (Stoa, agent plane)
#   ASIMP_S6_TEST_GOOGLE_USER Google test account, used by the browser leg
#   ASIMP_S6_TEST_GOOGLE_PASS its password, from the operator secret store
#   ASIMP_S6_FELLOW_TOKEN     a Fellow bearer, for the bearer-on-sponsor case
#   ASIMP_S6_SIGNING_KEY_HEX  Ed25519 private seed, 64 lowercase hex chars.
#                             The product's key format
#                             (SERVICE_ENVELOPE_PRIVATE_KEY_HEX); the bead text
#                             says "JWK", but apps/web/lib/service-envelope.ts
#                             imports a hex seed and building a JWK path here
#                             would be the parallel auth seam this spike must
#                             not create.
#   ASIMP_S6_SIGNING_KID      the matching non-secret key id
#   ASIMP_S6_SPONSOR_ID       canonical opaque sponsor id bound by the envelope
#
# Optional:
#   ASIMP_S6_EVIDENCE_DIR     directory for the redacted evidence bundle
#
# Evidence: a redacted JSON bundle. It records non-secret kid, hosts, counts and
# durations. Never cookies, OAuth artifacts, bearer tokens, signatures, join
# fragments, payload bodies, screenshots or raw browser traces.

set -u -o pipefail
# Job control puts every background job in its own process group. A live
# same-group supervisor receives nonce-bound commands over a private pipe and
# self-signals that group; the parent never targets a numeric pid or pgid.
set -m

readonly SUITE="s6-cross-plane-auth"
readonly EX_CONFIG=78
readonly EX_FAIL=1
# A child could not be reaped, or its process group could not be proven empty.
# Distinct from a plain failure so no caller can read it as success.
readonly EX_CLEANUP_UNPROVEN=125
# The bounded supervisor or its authenticated result channel was unavailable.
# Fail closed: an unbounded child or an untyped terminal record is never green.
readonly EX_WATCHDOG_UNAVAILABLE=126
# The supervisor could not validate and acknowledge the bounded input bootstrap.
readonly EX_INPUT_BOOTSTRAP_UNAVAILABLE=127
readonly REPRODUCE="bash scripts/e2e-s6-cross-plane-auth.sh"

# One monotonic budget for the whole run, measured from a single start stamp so
# a later phase cannot silently extend it. The reserve keeps enough time to
# write evidence and reap children after the work bound is reached.
readonly SCRIPT_TOTAL_DEADLINE_SECONDS=420
readonly SCRIPT_CLEANUP_RESERVE_SECONDS=45
readonly HTTP_CONNECT_TIMEOUT_SECONDS=10
readonly HTTP_TOTAL_TIMEOUT_SECONDS=30
readonly MINTER_TIMEOUT_SECONDS=30
readonly BROWSER_TIMEOUT_SECONDS=240
readonly INPUT_BOOTSTRAP_WAIT_SECONDS=3
# ONE absolute deadline, expressed against bash's own `SECONDS` counter, which
# starts at shell start and is never reassigned here. Every phase reads its
# bound from `remaining_budget`, so no phase can begin with its full nominal
# bound when only seconds of the reserve remain — the defect that let a 240s
# browser bound start at T+400 inside a 420s budget.
readonly WORK_BUDGET_SECONDS=$((SCRIPT_TOTAL_DEADLINE_SECONDS - SCRIPT_CLEANUP_RESERVE_SECONDS))

# Seconds left before the work budget is exhausted; never negative.
remaining_budget() {
  local left=$((WORK_BUDGET_SECONDS - SECONDS))
  (( left < 0 )) && left=0
  printf '%s' "$left"
}

# The bound a phase may actually use: its nominal maximum, clamped to what is
# left. A phase with no budget left returns 0 and its caller refuses to start.
phase_budget() {
  local nominal="$1" left
  left="$(remaining_budget)"
  if (( left < nominal )); then printf '%s' "$left"; else printf '%s' "$nominal"; fi
}

readonly ROOT="$PWD"
readonly PLAYWRIGHT_RUNNER="e2e/playwright/s6-cross-plane-runner.ts"
# This script's own path, so the signal plant can run a nested instance.
SCRIPT_SELF="${BASH_SOURCE[0]}"
readonly SCRIPT_SELF

readonly REQUIRED_VARS=(
  ASIMP_S6_PREVIEW_URL
  ASIMP_S6_WORKER_URL
  ASIMP_S6_TEST_GOOGLE_USER
  ASIMP_S6_TEST_GOOGLE_PASS
  ASIMP_S6_FELLOW_TOKEN
  ASIMP_S6_SIGNING_KEY_HEX
  ASIMP_S6_SIGNING_KID
  ASIMP_S6_SPONSOR_ID
)

# Values that must never reach stdout, stderr, a file, an argv, or an evidence
# record. Every one of these is scanned for by the leak canary; none is skipped
# for being short, because a short secret is still a secret.
readonly SECRET_VARS=(
  ASIMP_S6_TEST_GOOGLE_PASS
  ASIMP_S6_FELLOW_TOKEN
  ASIMP_S6_SIGNING_KEY_HEX
)

FAILURES=0
ASSERTIONS=0
RUN_STATE_DIR=""
CHILD_PIDS=()
CHILD_OWNER_TOKENS=()
CHILD_KINDS=()
VALID_ENVELOPE_HEADER=""
RECEIPT=""
BROWSER_BLOCKED_CODE=""
BROWSER_BLOCKED_DETAIL=""

log() { printf '%s\n' "$*" >&2; }
emit() { printf '%s\n' "$1"; }

json_string() {
  local raw="$1"
  raw="${raw//\\/\\\\}"
  raw="${raw//\"/\\\"}"
  raw="${raw//$'\n'/ }"
  raw="${raw//$'\r'/ }"
  raw="${raw//$'\t'/ }"
  printf '%s' "$raw"
}

pass_record() {
  ASSERTIONS=$((ASSERTIONS + 1))
  emit "{\"suite\":\"${SUITE}\",\"assertion\":\"$(json_string "$1")\",\"status\":\"pass\",\"detail\":\"$(json_string "$2")\",\"reproduce\":\"${REPRODUCE}\"}"
}

fail_record() {
  ASSERTIONS=$((ASSERTIONS + 1))
  FAILURES=$((FAILURES + 1))
  emit "{\"suite\":\"${SUITE}\",\"assertion\":\"$(json_string "$1")\",\"status\":\"fail\",\"detail\":\"$(json_string "$2")\",\"reproduce\":\"${REPRODUCE}\"}"
}

blocked_record() {
  emit "{\"suite\":\"${SUITE}\",\"status\":\"blocked\",\"code\":\"$(json_string "$1")\",\"bead\":\"asimposiumorg-vw3\",\"detail\":\"$(json_string "$2")\",\"reproduce\":\"${REPRODUCE}\"}"
}

# Browser refusal is a terminal outcome, so it is DATA until lifecycle cleanup
# has been proved. Emitting it inside `run_browser_leg` let a tidy blocked record
# escape before `main` discovered a surviving child group.
buffer_browser_blocked() {
  BROWSER_BLOCKED_CODE="$1"
  BROWSER_BLOCKED_DETAIL="$2"
}

publish_buffered_browser_blocked() {
  [[ -n "$BROWSER_BLOCKED_CODE" ]] || return 1
  blocked_record "$BROWSER_BLOCKED_CODE" "$BROWSER_BLOCKED_DETAIL"
  BROWSER_BLOCKED_CODE=""
  BROWSER_BLOCKED_DETAIL=""
}

# ---------------------------------------------------------------------------
# Lifecycle: one cleanup path for success, failure, INT and TERM
# ---------------------------------------------------------------------------

CLEANED_UP=0

# Playwright launches Chromium as a grandchild and the minter can fork, so each
# payload runs beneath a same-group supervisor. The parent never signals a
# numeric pid or pgid. It writes a nonce-bound command to the sole live listener;
# that supervisor self-signals group zero. Once the listener dies, EPIPE closes
# the authority rather than letting a recycled number become a target.
SIGNAL_KILL_FAILURE_PLANT=0
SIGNAL_KILL_NO_SETTLE_PLANT=0
OWNER_TOKEN_COUNTER=0
OWNER_TOKEN=""
GROUP_CONTROL_PID=""
GROUP_CONTROL_TOKEN=""
GROUP_CONTROL_OPEN=0
GROUP_RESULT_OPEN=0
GROUP_RECORD=""
GROUP_RECORD_INVALID=0
GROUP_PENDING_CHILD_RECORD=""
GROUP_QUEUED_CHILD_RECORDS=0

mint_owner_token() {
  local label="$1"
  OWNER_TOKEN_COUNTER=$((OWNER_TOKEN_COUNTER + 1))
  # Four independent Bash RNG words plus the process-local counter make each
  # harmless ownership nonce unique without launching a helper that could
  # inherit credentials before `main` de-exports them.
  OWNER_TOKEN="s6${label}${BASHPID}${RANDOM}${RANDOM}${RANDOM}${RANDOM}${OWNER_TOKEN_COUNTER}"
}

register_child() {
  local pid="$1" token="$2" kind="${3:-ordinary}"
  local index="${#CHILD_PIDS[@]}"
  CHILD_PIDS+=("$pid")
  CHILD_OWNER_TOKENS[$index]="$token"
  CHILD_KINDS[$index]="$kind"
}

child_record_index() {
  local wanted="$1" index
  CHILD_RECORD_INDEX=""
  for ((index = 0; index < ${#CHILD_PIDS[@]}; index++)); do
    if [[ "${CHILD_PIDS[$index]}" == "$wanted" ]]; then
      CHILD_RECORD_INDEX="$index"
      return 0
    fi
  done
  return 1
}

child_record_is_kind() {
  local pid="$1" expected="$2" index
  child_record_index "$pid" || return 1
  index="$CHILD_RECORD_INDEX"
  [[ "${CHILD_KINDS[$index]:-ordinary}" == "$expected" ]]
}

adopt_group_control() {
  local pid="$1" token="$2"
  # FD 6 is the write-only end of the anonymous process-substitution pipe. The
  # in-group supervisor owns the only read end, so supervisor death makes writes
  # fail with EPIPE. No RDWR FIFO or parent-side reader can mask that death.
  GROUP_CONTROL_PID="$pid"
  GROUP_CONTROL_TOKEN="$token"
  GROUP_CONTROL_OPEN=1
  GROUP_RESULT_OPEN=1
  GROUP_PENDING_CHILD_RECORD=""
}

release_group_control() {
  local pid="$1"
  [[ "$GROUP_CONTROL_PID" == "$pid" ]] || return 0
  if (( GROUP_CONTROL_OPEN == 1 )); then exec 6>&-; fi
  if (( GROUP_RESULT_OPEN == 1 )); then exec 5>&-; fi
  GROUP_CONTROL_PID=""
  GROUP_CONTROL_TOKEN=""
  GROUP_CONTROL_OPEN=0
  GROUP_RESULT_OPEN=0
  GROUP_PENDING_CHILD_RECORD=""
}

read_group_record() {
  local expected="$1" record="" deadline=$((SECONDS + 2)) remaining
  GROUP_RECORD=""
  (( GROUP_RESULT_OPEN == 1 )) || return 1
  while (( SECONDS < deadline )); do
    remaining=$((deadline - SECONDS))
    IFS= read -r -t "$remaining" record <&5 || return 1
    if [[ "$record" == "$expected" ]]; then
      GROUP_RECORD="$record"
      return 0
    fi
    # A timeout can race the payload result into the shared channel. The
    # timeout verdict is already latched, but consuming that one record must not
    # hide the following typed control acknowledgement.
    if [[ "$record" == child:* ]]; then
      [[ "$record" == "child:${GROUP_CONTROL_TOKEN}:"* ]] || return 1
      [[ -z "$GROUP_PENDING_CHILD_RECORD" ]] || return 1
      GROUP_PENDING_CHILD_RECORD="$record"
      GROUP_QUEUED_CHILD_RECORDS=$((GROUP_QUEUED_CHILD_RECORDS + 1))
      continue
    fi
    # A late readiness record is harmless during pre-ready retirement.
    if [[ "$record" == control-ready:* ]]; then
      continue
    fi
    # No other control record is legitimate while an exact requested ack is
    # outstanding. Treat unsolicited or out-of-order acks as protocol drift.
    [[ "$record" != control-ack:* && "$record" != control-closed:* ]] || return 1
    return 1
  done
  return 1
}

read_group_outcome() {
  local seconds="$1" record="" deadline=$((SECONDS + seconds)) remaining read_status
  GROUP_RECORD=""
  GROUP_RECORD_INVALID=0
  (( GROUP_RESULT_OPEN == 1 )) || return 1
  if [[ -n "$GROUP_PENDING_CHILD_RECORD" ]]; then
    GROUP_RECORD="$GROUP_PENDING_CHILD_RECORD"
    GROUP_PENDING_CHILD_RECORD=""
    return 0
  fi
  while (( SECONDS < deadline )); do
    remaining=$((deadline - SECONDS))
    IFS= read -r -t "$remaining" record <&5
    read_status=$?
    (( read_status == 0 )) || return "$read_status"
    if [[ "$record" == child:* ]]; then
      if [[ "$record" != "child:${GROUP_CONTROL_TOKEN}:"* ]]; then
        GROUP_RECORD_INVALID=1
        return 1
      fi
      GROUP_RECORD="$record"
      return 0
    fi
    # No signal has been requested while the main outcome is pending. A control
    # ack/close here is unsolicited and must make the run fail closed.
    if [[ "$record" == control-ack:* || "$record" == control-closed:* ]]; then
      GROUP_RECORD_INVALID=1
      return 1
    fi
    GROUP_RECORD_INVALID=1
    return 1
  done
  # Reaching the absolute deadline without another read is the same typed
  # timeout as Bash read -t (128 + SIGALRM on supported Bash versions).
  return 142
}

request_group_signal() {
  local pid="$1" signal="$2" index token status expected
  child_record_index "$pid" || return 1
  index="$CHILD_RECORD_INDEX"
  token="${CHILD_OWNER_TOKENS[$index]:-}"
  [[ "${CHILD_KINDS[$index]:-ordinary}" == "controlled-group" ]] || return 1
  [[ "$GROUP_CONTROL_PID" == "$pid" && "$GROUP_CONTROL_TOKEN" == "$token" ]] || return 1
  (( GROUP_CONTROL_OPEN == 1 )) || return 1
  case "$signal" in TERM|KILL|DIE) ;; *) return 1 ;; esac
  if (( SIGNAL_KILL_FAILURE_PLANT == 1 )) && [[ "$signal" == "KILL" ]]; then return 1; fi
  if (( SIGNAL_KILL_NO_SETTLE_PLANT == 1 )) && [[ "$signal" == "KILL" ]]; then return 0; fi
  if [[ "$signal" == "DIE" ]]; then
    expected="control-closed:${token}"
  else
    expected="control-ack:${token}:${signal}"
  fi
  # Ignore PIPE only around the builtin write. A dead same-group supervisor
  # makes this fail; no parent-side numeric signal or fallback exists.
  trap '' PIPE
  printf 'SIGNAL\t%s\t%s\n' "$token" "$signal" >&6 2>/dev/null
  status=$?
  trap - PIPE
  (( status == 0 )) || return 1
  read_group_record "$expected"
}

# Bounded, PRE-REAP settlement proof. The direct leader is still registered for
# every call, so its group identity remains the one this owner created. Once
# this reports absent, `wait` is only the reap of an already-settled child. No
# caller may signal or probe the numeric identity after that wait.
CHILD_SETTLE_ATTEMPTS=80
CHILD_SETTLE_POLL_SECONDS=0.05
group_settled_before_wait() {
  local pid="$1" attempts=0
  while (( attempts < CHILD_SETTLE_ATTEMPTS )); do
    kill -0 -- "-${pid}" 2>/dev/null || return 0
    # A process listing is not settlement authority: a partial exit-zero
    # snapshot can omit a stopped or uninterruptible member. Only absence of
    # the still-owned process group permits the subsequent direct-child reap.
    sleep "$CHILD_SETTLE_POLL_SECONDS"
    attempts=$((attempts + 1))
  done
  return 1
}

# Exact direct-child settlement. Unlike a group census, one exact Z row is
# sufficient: there are no hidden group members, and the unreaped child still
# pins this pid. Empty or partial ps output is never treated as settlement.
direct_child_settled_before_wait() {
  local pid="$1" attempts=0 state
  while (( attempts < CHILD_SETTLE_ATTEMPTS )); do
    if ! kill -0 "$pid" 2>/dev/null; then return 0; fi
    state="$(/bin/ps -o stat= -p "$pid" 2>/dev/null || printf '')"
    state="${state//[[:space:]]/}"
    [[ "$state" == Z* ]] && return 0
    sleep "$CHILD_SETTLE_POLL_SECONDS"
    attempts=$((attempts + 1))
  done
  return 1
}

# Ownership records are ACTIVE-ONLY.
#
# `CHILD_PIDS` used to be append-only, so a pid stayed registered long after its
# child was reaped. The kernel reuses pids, so a later `reap_children` — from
# the EXIT trap or an INT — could TERM and then KILL an unrelated process, or a
# whole unrelated process group, that merely inherited the number. An owner that
# signals things it does not own is worse than one that signals nothing.
#
# Entries are removed the moment a reap is proven, on every return path.
# Comparison is exact and numeric: the array is rebuilt by string equality, so a
# value containing glob or regex characters can never match another entry.
# NOTE ON A REJECTED DESIGN: no pgid ledger.
#
# `set -m` puts each payload in its own process group. Publishing those pgids to
# a file was tried and removed: bare pgids are not identity, so signalling from
# such a list risks killing a recycled group, and censusing it is fail-open. Each
# invocation now has a live nonce-bearing supervisor whose pipe EOF self-retires
# its group if this shell is killed. An outer harness that had to kill this shell
# still cannot receive the supervisor's settlement proof, however, so that
# boundary remains explicitly cleanup-unproven rather than claiming containment.

unregister_child() {
  local pid="$1" kept=() kept_tokens=() kept_kinds=() current index
  for ((index = 0; index < ${#CHILD_PIDS[@]}; index++)); do
    current="${CHILD_PIDS[$index]}"
    [[ "$current" == "$pid" ]] && continue
    kept+=("$current")
    kept_tokens+=("${CHILD_OWNER_TOKENS[$index]:-}")
    kept_kinds+=("${CHILD_KINDS[$index]:-ordinary}")
  done
  CHILD_PIDS=(${kept[@]+"${kept[@]}"})
  CHILD_OWNER_TOKENS=(${kept_tokens[@]+"${kept_tokens[@]}"})
  CHILD_KINDS=(${kept_kinds[@]+"${kept_kinds[@]}"})
  release_group_control "$pid"
}

clear_child_records() {
  CHILD_PIDS=()
  CHILD_OWNER_TOKENS=()
  CHILD_KINDS=()
}

# Sets REAP_SURVIVORS. It must NOT print its result: a caller writing
# `survivors="$(reap_children)"` would run the whole reap — every `wait`
# included — inside a subshell, so the parent would never actually reap the
# children it owns.
REAP_SURVIVORS=0
REAP_GRACE_SECONDS=5

reap_children() {
  # Every production child is represented by its durable supervisor, commanded
  # through the capability channel, and verified gone before wait. Test-only
  # ordinary helpers must settle themselves and are never signalled here.
  local pid
  REAP_SURVIVORS=0
  for pid in ${CHILD_PIDS[@]+"${CHILD_PIDS[@]}"}; do
    # Only the live same-group supervisor receives cleanup commands. The parent
    # never sends a negative numeric PGID; the supervisor self-signals group zero.
    child_record_is_kind "$pid" "controlled-group" && request_group_signal "$pid" TERM || true
  done
  # Keep the historical five-second grace without probing after a reap. The
  # former poll could never observe an empty group while an unreaped leader was
  # still a member, and its final post-wait census used recyclable numbers.
  (( ${#CHILD_PIDS[@]} > 0 )) && sleep "$REAP_GRACE_SECONDS"
  for pid in ${CHILD_PIDS[@]+"${CHILD_PIDS[@]}"}; do
    if child_record_is_kind "$pid" "controlled-group" && group_settled_before_wait "$pid"; then
      wait "$pid" 2>/dev/null || true
      unregister_child "$pid"
      continue
    fi

    if child_record_is_kind "$pid" "controlled-group"; then
      # The write-only nonce channel is the sole delayed authority. A dead
      # supervisor makes the write or typed acknowledgement fail; there is no
      # numeric fallback that could strike a recycled PGID.
      if ! request_group_signal "$pid" KILL; then
        REAP_SURVIVORS=1
        continue
      fi
      if group_settled_before_wait "$pid"; then
        wait "$pid" 2>/dev/null || true
        unregister_child "$pid"
      else
        REAP_SURVIVORS=1
      fi
      continue
    fi

    # Test-only ordinary helpers are never signalled. They must publish their
    # own bounded settlement before registration is released.
    if direct_child_settled_before_wait "$pid"; then
      wait "$pid" 2>/dev/null || true
      unregister_child "$pid"
    else
      REAP_SURVIVORS=1
    fi
  done
}

# shellcheck disable=SC2329 # Invoked by the EXIT trap.
on_exit() {
  local status=$?
  (( CLEANED_UP == 1 )) && return
  CLEANED_UP=1
  reap_children
  if (( REAP_SURVIVORS != 0 )); then
    emit "{\"suite\":\"${SUITE}\",\"assertion\":\"no-child-survivors\",\"status\":\"fail\",\"detail\":\"a child process group survived cleanup\",\"reproduce\":\"${REPRODUCE}\"}"
    exit "$EX_FAIL"
  fi
  exit "$status"
}

# shellcheck disable=SC2329 # Invoked by the INT and TERM traps.
on_signal() {
  local signal="$1"
  (( CLEANED_UP == 1 )) && exit "$EX_FAIL"
  CLEANED_UP=1
  reap_children
  # A survivor must NOT be reported as a tidy interruption.
  #
  # This previously emitted INTERRUPTED unconditionally — "terminated its
  # children" — regardless of whether anything was actually reaped. A reader
  # would take that as a clean stop when a process group was still running.
  if (( REAP_SURVIVORS != 0 )); then
    blocked_record "CLEANUP_UNPROVEN" "the run received SIG${signal} and a child process group survived cleanup"
    exit "$EX_CLEANUP_UNPROVEN"
  fi
  blocked_record "INTERRUPTED" "the run received SIG${signal} and every child process group was reaped"
  exit "$EX_FAIL"
}

trap 'on_exit' EXIT
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM

deadline_guard() {
  if (( SECONDS >= WORK_BUDGET_SECONDS )); then
    fail_record "script-deadline" "the ${SCRIPT_TOTAL_DEADLINE_SECONDS}-second budget reached its cleanup reserve"
    finish
  fi
}

# Run a bounded child, record its pid, and return its status. `timeout` bounds
# the wall clock; the pid record bounds the cleanup.
# Run a child under a WALL-CLOCK bound, in its own process group.
#
# An earlier revision counted loop iterations and slept 0.1s per iteration. Each
# iteration also forked `kill -0`, so real elapsed time ran well past the
# nominal bound — a 240s browser limit could consume roughly twice that and blow
# the 420s script budget it was supposed to fit inside. The deadline is now read
# from the clock, so per-iteration overhead cannot extend it.
# THE launcher. Every child in this script is built here, and the self-test's
# argv/env plants drive this exact function — a plant that built its own
# stand-in would keep passing while the real launcher regressed.
#
# The environment is MINIMAL AT SPAWN. `env -i` replaces the environment at
# exec, and only non-secret values (PATH, HOME, TMPDIR) appear in its argv.
#
# Two rejected shapes, and why:
#
#   * `env -i NAME=secret …` puts the secret in env's own argument vector,
#     which the process table exposes for the life of the exec.
#   * `bash -c 'unset NAME; exec …'` was the previous design here. The
#     intermediate shell INHERITS every parent secret and only unsets after
#     startup, so on any platform that exposes a same-UID `environ` the leak
#     simply moved from argv to environ — while the comments claimed minimal
#     env. A child that must never hold a secret cannot be given one first.
#
# Secrets a child genuinely needs arrive later, as one bounded record on stdin,
# so they are in neither argv nor environ and no descendant (Chromium included)
# can inherit them.
#
# Sets MINIMAL_CMD.
MINIMAL_CMD=()
minimal_env_command() {
  MINIMAL_CMD=(
    env -i
    "PATH=$PATH"
    "HOME=${HOME:-}"
    "TMPDIR=${TMPDIR:-/tmp}"
    "$@"
  )
}

# Bootstrap one exact bounded stdin record over the same private capability pipe
# that later carries lifecycle commands. No writer child or FIFO exists. The
# group leader validates the nonce, line count and byte count before it forks
# the payload, then reconstructs the record into an in-group anonymous pipe.
send_group_input() {
  local pid="$1" record="$2" index token status=0 remaining line count=1 bytes
  local LC_ALL=C
  child_record_index "$pid" || return 1
  index="$CHILD_RECORD_INDEX"
  token="${CHILD_OWNER_TOKENS[$index]:-}"
  [[ "${CHILD_KINDS[$index]:-ordinary}" == "controlled-group" ]] || return 1
  [[ "$GROUP_CONTROL_PID" == "$pid" && "$GROUP_CONTROL_TOKEN" == "$token" ]] || return 1
  (( GROUP_CONTROL_OPEN == 1 )) || return 1
  trap '' PIPE
  if [[ "$record" == "-" ]]; then
    printf 'START-NONE\t%s\n' "$token" >&6 2>/dev/null || status=$?
  else
    (( ${#record} <= 4096 )) || status=1
    remaining="$record"
    while (( status == 0 )) && [[ "$remaining" == *$'\n'* ]]; do
      count=$((count + 1))
      remaining="${remaining#*$'\n'}"
    done
    (( count <= 128 )) || status=1
    bytes="${#record}"
    (( status != 0 )) || printf 'START-DATA\t%s\t%s\t%s\n' "$token" "$count" "$bytes" >&6 2>/dev/null || status=$?
    remaining="$record"
    while (( status == 0 )); do
      if [[ "$remaining" == *$'\n'* ]]; then
        line="${remaining%%$'\n'*}"
        remaining="${remaining#*$'\n'}"
      else
        line="$remaining"
        remaining=""
      fi
      printf 'DATA\t%s\t%s\n' "$token" "$line" >&6 2>/dev/null || status=$?
      [[ -n "$remaining" || "$record" == *$'\n' ]] || break
      if [[ -z "$remaining" && "$record" == *$'\n' ]]; then
        # Preserve one final empty line when the shell value itself ends in LF.
        printf 'DATA\t%s\t\n' "$token" >&6 2>/dev/null || status=$?
        break
      fi
    done
    (( status != 0 )) || printf 'END-DATA\t%s\n' "$token" >&6 2>/dev/null || status=$?
  fi
  trap - PIPE
  (( status == 0 )) || return 1
  read_group_record "input-ready:${token}"
}

# Regression-only in-process faults. They are assigned only by `self_test`; no
# environment variable or live invocation can switch them on.
SUPERVISOR_READY_WRITE_PLANT=0
SUPERVISOR_DEPART_AFTER_RESULT_PLANT=0
SUPERVISOR_EARLY_ACK_PLANT=0
SUPERVISOR_CHILD_BEFORE_ACK_PLANT=0
SUPERVISOR_CHILD_STATUS_PLANT=""
DEAD_LISTENER_WRITE_REFUSAL_OBSERVED=0

# run_bounded <seconds> <stdout_file> <stdin_file|-> <command...>
#
# MUST be called from the parent shell, never inside `$( )`.
#
# An earlier revision captured child output with command substitution. That runs
# the whole call in a subshell, so `CHILD_PIDS+=` mutated a copy that died with
# the subshell: the parent's EXIT trap then held no pid and no pgid, and reaped
# nothing. Child stdout therefore goes to a FILE the caller reads afterwards,
# which keeps the spawn — and the pid registration — in the parent.
#
# The group is swept on EVERY exit path, including a clean direct-child exit: a
# child can exit while leaving Chromium behind, and waiting on the direct pid
# alone would call that success.
run_bounded() {
  local seconds="$1" stdout_file="$2" stdin_file="$3"
  shift 3
  # Allocate every control object BEFORE the payload exists. An allocation
  # failure therefore leaves no unbounded child to recover and no stale numeric
  # identity to signal after a reap.
  local dog_dir result_fifo order_fifo="-" supervisor_token control_ready boot_status=0
  [[ -z "$GROUP_CONTROL_PID" ]] || return "$EX_CLEANUP_UNPROVEN"
  dog_dir="$(mktemp -d "${TMPDIR:-/tmp}/s6-watchdog.XXXXXX" 2>/dev/null)" || return "$EX_WATCHDOG_UNAVAILABLE"
  result_fifo="${dog_dir}/result"
  mkfifo -m 600 "$result_fifo" 2>/dev/null || return "$EX_WATCHDOG_UNAVAILABLE"
  if (( SUPERVISOR_CHILD_BEFORE_ACK_PLANT == 1 )); then
    order_fifo="${dog_dir}/recorded"
    mkfifo -m 600 "$order_fifo" 2>/dev/null || return "$EX_WATCHDOG_UNAVAILABLE"
  fi
  # FD 5 multiplexes token-bound readiness, input-ready, terminal and control-
  # acknowledgement records. RDWR removes FIFO open-order races; it carries no
  # secret and is closed with the control capability on every return path.
  exec 5<>"$result_fifo" || return "$EX_WATCHDOG_UNAVAILABLE"
  mint_owner_token "supervisor"
  supervisor_token="$OWNER_TOKEN"

  # FD 6 is a write-only anonymous pipe created by process substitution. The
  # Perl prelude makes its sole reader the process-group leader before exec.
  # That same supervisor remains the listener for its whole lifetime; payloads
  # receive /dev/null or an in-group anonymous pipe and close every control fd.
  # TERM/KILL are data here, and only the live leader turns them into `kill 0`.
  exec 6> >(
    /usr/bin/perl -e \
      'setpgrp(0,0) or die $!; exec @ARGV or die $!;' \
      bash -c '
        stdout_file="$1" unavailable="$2" ready_plant="$3" early_ack_plant="$4" child_before_ack_plant="$5" child_status_plant="$6" order_fifo="$7"
        shift 7
        set +m
        LC_ALL=C
        export LC_ALL
        trap "" TERM HUP INT
        exec 7<&0
        exec </dev/null
        tab="$(printf "\t")"
        IFS="$tab" read -r boot_kind token boot_extra <&7 || exit "$unavailable"
        [[ "$boot_kind" == "BOOT" && -n "$token" && -z "$boot_extra" ]] || exit "$unavailable"
        if [[ "$child_before_ack_plant" == "1" ]]; then
          exec 8<>"$order_fifo" || exit "$unavailable"
        fi
        if [[ "$ready_plant" == "1" ]]; then exit "$unavailable"; fi
        printf "control-ready:%s\n" "$token" >&5 || exit "$unavailable"

        input_mode="" input_record="" start_frame=""
        IFS= read -r start_frame <&7 || kill -KILL 0
        if [[ "$start_frame" == "START-NONE${tab}${token}" ]]; then
          input_mode="none"
        else
          start_prefix="START-DATA${tab}${token}${tab}"
          [[ "$start_frame" == "$start_prefix"* ]] || kill -KILL 0
          metadata="${start_frame#"$start_prefix"}"
          line_count="${metadata%%"$tab"*}"
          byte_count="${metadata#*"$tab"}"
          [[ "$line_count" =~ ^[0-9]+$ && "$byte_count" =~ ^[0-9]+$ ]] || kill -KILL 0
          (( line_count >= 1 && line_count <= 128 && byte_count <= 4096 )) || kill -KILL 0
          newline="$(printf "\nx")"
          newline="${newline%x}"
          data_prefix="DATA${tab}${token}${tab}"
          index=0
          while (( index < line_count )); do
            IFS= read -r data_frame <&7 || kill -KILL 0
            [[ "$data_frame" == "$data_prefix"* ]] || kill -KILL 0
            data="${data_frame#"$data_prefix"}"
            if (( index == 0 )); then
              input_record="$data"
            else
              input_record="${input_record}${newline}${data}"
            fi
            index=$((index + 1))
          done
          IFS= read -r end_frame <&7 || kill -KILL 0
          [[ "$end_frame" == "END-DATA${tab}${token}" ]] || kill -KILL 0
          (( ${#input_record} == byte_count )) || kill -KILL 0
          input_mode="record"
        fi
        printf "input-ready:%s\n" "$token" >&5 || kill -KILL 0
        if [[ "$early_ack_plant" == "1" ]]; then
          printf "control-ack:%s:EARLY\n" "$token" >&5 || kill -KILL 0
        fi

        # The recorder retains the supervisors ignored dispositions so TERM can
        # never prevent it publishing the terminal record. The nested payload
        # resets TERM/HUP/INT immediately before exec; real curl/Bun/browser
        # children therefore remain cooperative instead of inheriting ignores.
        (
          exec 7<&-
          command_status=0
          (
            trap - TERM HUP INT
            if [[ "$input_mode" == "record" ]]; then
              exec 0< <(exec 0<&- 5>&- 6>&- 7>&-; printf "%s\n" "$input_record")
            else
              exec </dev/null
            fi
            exec "$@" 3<&- 4>&- 5>&- 6>&- 7>&- 8>&- 9>&- >"$stdout_file"
          ) || command_status=$?
          if [[ -n "$child_status_plant" ]]; then command_status="$child_status_plant"; fi
          printf "child:%s:%s\n" "$token" "$command_status" >&5 || kill -KILL 0
          if [[ "$child_before_ack_plant" == "1" ]]; then
            printf "recorded:%s\n" "$token" >&8 || kill -KILL 0
          fi
        ) &
        while IFS="$tab" read -r request_kind request_token request_signal <&7; do
          [[ "$request_kind" == "SIGNAL" && "$request_token" == "$token" ]] || kill -KILL 0
          case "$request_signal" in
            TERM)
              if [[ "$child_before_ack_plant" == "1" ]]; then
                # Test-only deterministic ordering handshake. The planted
                # payload exits from TERM, then its signal-resistant recorder
                # writes the real child record before the exact token marker.
                # The target closes FD8 and cannot forge this ordering proof.
                kill -TERM 0 2>/dev/null || kill -KILL 0
                IFS= read -r -t 1 recorded <&8 || kill -KILL 0
                [[ "$recorded" == "recorded:${token}" ]] || kill -KILL 0
                printf "control-ack:%s:TERM\n" "$token" >&5 || kill -KILL 0
              else
                printf "control-ack:%s:TERM\n" "$token" >&5 || kill -KILL 0
                kill -TERM 0 2>/dev/null || kill -KILL 0
              fi
              ;;
            KILL)
              printf "control-ack:%s:KILL\n" "$token" >&5 || kill -KILL 0
              kill -KILL 0
              ;;
            DIE)
              # Self-test only. Closing the sole read end before publishing the
              # ack makes the next parent write causally fail with EPIPE.
              exec 7<&-
              printf "control-closed:%s\n" "$token" >&5 || exit "$unavailable"
              exit 0
              ;;
            *) kill -KILL 0 ;;
          esac
        done
        kill -KILL 0
      ' "s6-bounded-supervisor" "$stdout_file" \
      "$EX_WATCHDOG_UNAVAILABLE" "$SUPERVISOR_READY_WRITE_PLANT" \
      "$SUPERVISOR_EARLY_ACK_PLANT" "$SUPERVISOR_CHILD_BEFORE_ACK_PLANT" \
      "$SUPERVISOR_CHILD_STATUS_PLANT" "$order_fifo" "$@"
  )
  local pid=$!
  register_child "$pid" "$supervisor_token" "controlled-group"
  adopt_group_control "$pid" "$supervisor_token"
  trap '' PIPE
  printf 'BOOT\t%s\n' "$supervisor_token" >&6 2>/dev/null || boot_status=$?
  trap - PIPE
  if (( boot_status != 0 )); then
    if group_settled_before_wait "$pid"; then
      wait "$pid" 2>/dev/null || true
      unregister_child "$pid"
      return "$EX_WATCHDOG_UNAVAILABLE"
    fi
    return "$EX_CLEANUP_UNPROVEN"
  fi
  IFS= read -r -t 2 control_ready <&5 || control_ready=""
  if [[ "$control_ready" != "control-ready:${supervisor_token}" ]]; then
    # The channel is adopted before readiness. If the leader is live it accepts
    # an authenticated self-KILL; if it departed before publishing, the group
    # must prove absent before the direct child may be waited and unregistered.
    request_group_signal "$pid" KILL || true
    if group_settled_before_wait "$pid"; then
      wait "$pid" 2>/dev/null || true
      unregister_child "$pid"
      return "$EX_WATCHDOG_UNAVAILABLE"
    fi
    return "$EX_CLEANUP_UNPROVEN"
  fi
  if ! send_group_input "$pid" "$stdin_file"; then
    request_group_signal "$pid" KILL || true
    if group_settled_before_wait "$pid"; then
      wait "$pid" 2>/dev/null || true
      unregister_child "$pid"
      return "$EX_INPUT_BOOTSTRAP_UNAVAILABLE"
    fi
    return "$EX_CLEANUP_UNPROVEN"
  fi

  # The parent builtin owns the sole wall-clock deadline. There is no watchdog
  # child to stop, orphan, or reap: one timeout read races the payload result,
  # then the still-live supervisor accepts the TERM/KILL sequence itself.
  local outcome="" child_status="" status="$EX_WATCHDOG_UNAVAILABLE"
  local cleanup_unproven=0 timed_out=0 read_status=0
  if read_group_outcome "$seconds"; then
    outcome="$GROUP_RECORD"
    child_status="${outcome#"child:${supervisor_token}:"}"
    if [[ "$outcome" == "child:${supervisor_token}:${child_status}" &&
          "$child_status" =~ ^(0|[1-9]|[1-9][0-9]|[1-9][0-9][0-9])$ ]] &&
       (( 10#$child_status <= 255 )); then
      status="$((10#$child_status))"
    else
      status="$EX_WATCHDOG_UNAVAILABLE"
    fi
  else
    read_status=$?
    if (( GROUP_RECORD_INVALID == 1 )); then
      status="$EX_WATCHDOG_UNAVAILABLE"
    elif (( read_status > 128 )); then
      # The parent-memory latch is authoritative before teardown starts. There
      # is no target-writable flag path to forge, redirect, or chmod.
      timed_out=1
      status=124
    else
      status="$EX_WATCHDOG_UNAVAILABLE"
    fi
  fi

  if (( SUPERVISOR_DEPART_AFTER_RESULT_PLANT == 1 && timed_out == 0 )); then
    # Causal recycled-PGID polarity: make the sole reader close, prove the group
    # gone, reap its leader (so the number is now reusable), then write only to
    # the stale nonce channel. EPIPE/EBADF is the required outcome; there is no
    # numeric signal or probe after the wait.
    if ! request_group_signal "$pid" DIE || ! group_settled_before_wait "$pid"; then
      return "$EX_CLEANUP_UNPROVEN"
    fi
    wait "$pid" 2>/dev/null || true
    if ! request_group_signal "$pid" TERM; then
      DEAD_LISTENER_WRITE_REFUSAL_OBSERVED=1
    fi
    unregister_child "$pid"
    return "$status"
  fi

  if ! request_group_signal "$pid" TERM; then cleanup_unproven=1; fi
  if (( timed_out == 1 )); then sleep 3; else sleep 0.2; fi
  if ! request_group_signal "$pid" KILL; then cleanup_unproven=1; fi

  # A write or typed-ack refusal never falls into a wait. The unreaped leader
  # and its open control channel remain registered for the outer cleanup owner.
  (( cleanup_unproven == 0 )) || return "$EX_CLEANUP_UNPROVEN"
  group_settled_before_wait "$pid" || return "$EX_CLEANUP_UNPROVEN"

  # FIRST reap. No signal or numeric existence probe uses `$pid` below here.
  wait "$pid" 2>/dev/null || true
  unregister_child "$pid"
  return "$status"
}

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

missing_vars() {
  local name
  for name in "${REQUIRED_VARS[@]}"; do
    if [[ -z "${!name:-}" ]]; then printf '%s\n' "$name"; fi
  done
}

emit_blocked_env_record() {
  local missing_csv="$1"
  printf '{"suite":"%s","status":"blocked","code":"PREVIEW_NOT_PROVISIONED",' "$SUITE"
  printf '"bead":"asimposiumorg-vw3","missing_env":[%s],' "$missing_csv"
  printf '"blocked_on":"a Vercel preview deployment with Auth.js Google credentials and a deployed Worker with real bindings (OPS.3 environments, W3 Propylon)",'
  printf '"forbidden_substitutes":"a mocked Worker or stubbed Auth.js presented as runtime proof; the in-process unit vectors relabelled as a live run; a hand-written transcript; a recorded fixture replayed as a deployment; a storage-state file presented as live cookie evidence",'
  printf '"unit_coverage":"apps/wire/test/unit/service-envelope.test.ts, apps/wire/test/unit/principal-routing.test.ts, apps/wire/test/security/cross-plane-refusals.test.ts, apps/web/test/unit/service-envelope.test.ts"}\n'
}

valid_https_origin() {
  [[ "$1" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/?$ ]]
}

origin_host() {
  local value="${1#https://}"
  value="${value%%/*}"
  printf '%s' "${value%%:*}"
}

# ---------------------------------------------------------------------------
# HTTP — credentials travel on stdin, never in argv
# ---------------------------------------------------------------------------

# http_request <method> <url> <body_file|""> [<config_stdin>]
#
# The fourth argument is a curl config document. It may contain credential
# headers; it is fed on stdin and therefore never appears in the process table,
# in a shell history, or on disk. `--disable` stops a user's .curlrc from
# redirecting the request; there is no --location, because a redirect would
# carry the credential to a host the envelope never authorised.
http_request() {
  local method="$1" url="$2" body_file="$3" config="${4:-}"
  # A request may not outlive the run's remaining budget, so a late phase cannot
  # start a full 30s request with 5s of reserve left.
  local max_time
  max_time="$(phase_budget "$HTTP_TOTAL_TIMEOUT_SECONDS")"
  (( max_time > 0 )) || max_time=1
  local connect_timeout="$HTTP_CONNECT_TIMEOUT_SECONDS"
  (( connect_timeout > max_time )) && connect_timeout="$max_time"
  local -a args=(
    --disable --silent --show-error
    --request "$method"
    --connect-timeout "$connect_timeout"
    --max-time "$max_time"
    --write-out '\n%{http_code}'
    --output -
  )
  if [[ -n "$body_file" ]]; then args+=(--data-binary "@${body_file}"); fi
  args+=(--config -)

  # Sets HTTP_RESPONSE, and MUST be called from the parent shell.
  #
  # This used to be `printf … | env -i curl …` inside `$( )`. Both halves of
  # that were ownership losses: the command substitution ran the call in a
  # subshell, and the pipeline created processes this script never registered.
  # Neither the curl nor its group appeared in CHILD_PIDS, so an INT or TERM
  # left them running until curl's own max-time — contradicting the claim that
  # every child is owned and reaped.
  #
  # The config document (which may carry a bearer) travels on the same anonymous
  # pipe transport the minter uses: never an argv, never an environ, never disk.
  HTTP_RESPONSE=""
  local out_dir out_file
  out_dir="$(mktemp -d "${RUN_STATE_DIR:-${TMPDIR:-/tmp}}/http.XXXXXX" 2>/dev/null)" || return 1
  chmod 700 "$out_dir" 2>/dev/null || true
  out_file="${out_dir}/response"

  minimal_env_command curl "${args[@]}" "$url"
  # The bound is the request's own max-time plus a small settling margin, so a
  # wedged curl is retired by the owner rather than by its internal timer.
  # The child's EXACT status decides whether the response may be used. `|| true`
  # discarded it, so a request that timed out (124), left cleanup unproven (125)
  # or could not be bounded (126) still handed its partial bytes to the caller
  # and the phase went green on them.
  local rc=0
  run_bounded "$((max_time + 5))" "$out_file" "$config" "${MINIMAL_CMD[@]}" 2>/dev/null || rc=$?
  if (( rc != 0 )); then
    HTTP_RESPONSE=""
    return "$rc"
  fi
  HTTP_RESPONSE="$(cat "$out_file" 2>/dev/null || printf '')"
}
HTTP_RESPONSE=""

status_of() { printf '%s' "${1##*$'\n'}"; }
body_of() { printf '%s' "${1%$'\n'*}"; }

problem_code() {
  printf '%s' "$1" | sed -n 's/.*"code"[[:space:]]*:[[:space:]]*"\([A-Z_]*\)".*/\1/p' | head -1
}

# ---------------------------------------------------------------------------
# Envelope minting through the PRODUCT minter
# ---------------------------------------------------------------------------

write_envelope_shim() {
  cat > "${RUN_STATE_DIR}/mint-envelope.mjs" <<SHIM
import { readSync } from "node:fs";
import {
  importEd25519PrivateSeedHex,
  mintServiceEnvelope,
  SERVICE_ENVELOPE_HEADER,
} from "${ROOT}/apps/web/lib/service-envelope.ts";

const [, , method, route, action, principalId, body, skewSecondsRaw] = process.argv;

// The key arrives as ONE bounded tab-separated record on stdin. It is in
// neither this process's argv nor its environ, so nothing that inspects either
// — and no descendant — can recover it.
// Read to EOF and validate EXACT bytes: one record, one trailing LF, nothing
// after it. Stopping at the first newline would accept trailing bytes nobody
// examined; the cap is measured in BYTES, not UTF-16 string length, so a
// multi-byte payload cannot slip past a character-count bound.
// ROOT CAUSE, measured on bun 1.3.8 / macOS: \`Bun.stdin.stream()\` never
// observes end-of-stream when stdin is a FIFO. The record arrives in full — the
// descriptor's offset equals the record length and no writer remains — and the
// process then blocks forever. Over a plain pipe the same code terminates, so
// the defect is invisible unless the transport is exercised. A bounded
// synchronous read is not subject to it.
//
// MAX+1 is read on purpose: reading exactly MAX cannot tell "full" from
// "overflowing", and an over-cap record must be refused rather than truncated.
const MAX_SECRET_RECORD_BYTES = 4096;
const buffer = Buffer.alloc(MAX_SECRET_RECORD_BYTES + 1);
let total = 0;
for (;;) {
  let read = 0;
  try {
    read = readSync(0, buffer, total, buffer.length - total, null);
  } catch (error) {
    // EINTR is a genuine, bounded interruption and is retried. EAGAIN is NOT
    // retried: a non-blocking descriptor would turn this loop into an unbounded
    // CPU spin, and nothing has armed a deadline yet at this point. It is a
    // typed refusal instead.
    if (error?.code === "EINTR") continue;
    if (error?.code === "EOF") break;
    if (error?.code === "EAGAIN") {
      process.stderr.write("mint-envelope: stdin is non-blocking; refusing to spin\n");
      process.exit(2);
    }
    throw error;
  }
  if (read === 0) break;
  total += read;
  if (total > MAX_SECRET_RECORD_BYTES) {
    process.stderr.write("mint-envelope: secret record exceeded its byte bound\n");
    process.exit(2);
  }
}
// FATAL decoding: a malformed byte must be a refusal, not U+FFFD smuggled into
// a credential field.
let raw;
try {
  raw = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, total));
} catch {
  process.stderr.write("mint-envelope: secret record is not valid UTF-8\n");
  process.exit(2);
}
const lines = raw.split("\n");
if (lines.length !== 2 || lines[1] !== "") {
  process.stderr.write("mint-envelope: expected exactly one LF-terminated record\n");
  process.exit(2);
}
const fields = lines[0].split("\t");
if (fields.length !== 2) {
  process.stderr.write("mint-envelope: secret record must have exactly two fields\n");
  process.exit(2);
}
const [hex, kid] = fields;

// Exactly the product's own validation in apps/web/lib/stoa.ts. A harness that
// accepted a looser key than the Agora does would prove the wrong thing.
if (!/^[0-9a-f]{64}\$/.test(hex ?? "") || !/^[A-Za-z0-9._-]{1,64}\$/.test(kid ?? "")) {
  process.stderr.write("mint-envelope: signing key or kid is not the product format\n");
  process.exit(2);
}

const skewSeconds = Number.parseInt(skewSecondsRaw ?? "0", 10);
if (!Number.isSafeInteger(skewSeconds)) {
  process.stderr.write("mint-envelope: skew must be a whole number of seconds\n");
  process.exit(2);
}

try {
  const envelope = await mintServiceEnvelope({
    method,
    route,
    action,
    principalType: "sponsor",
    principalId,
    body,
    privateKey: await importEd25519PrivateSeedHex(hex),
    kid,
    now: Math.floor(Date.now() / 1000) + skewSeconds,
  });
  // EXACTLY one newline-terminated record. The reader waits for a newline, so a
  // bare write would hang it until its timeout and clear the result — while a
  // probe that printed a newline passed. The record is the contract.
  process.stdout.write(\`header = "\${SERVICE_ENVELOPE_HEADER}: \${JSON.stringify(envelope).replace(/"/g, '\\\\"')}"\n\`);
} catch (error) {
  process.stderr.write(\`mint-envelope: \${error?.constructor?.name ?? "Error"}\n\`);
  process.exit(2);
}
SHIM
}

# Prints a curl config line carrying the envelope header.
mint_envelope_config() {
  local method="$1" route="$2" action="$3" principal="$4" body="$5" skew="${6:-0}"
  # Sets MINTED_CONFIG. It must NOT print: every caller used to write
  # `config="$(mint_envelope_config ...)"`, which put this whole function —
  # including the `run_bounded` inside it — in a subshell, so the pid
  # registration died there just as it did one level down. Ownership only
  # survives if the spawn happens in the parent shell.
  MINTED_CONFIG=""
  local bound
  bound="$(phase_budget "$MINTER_TIMEOUT_SECONDS")"
  (( bound > 0 )) || return 1

  # The minted envelope carries a real Ed25519 SIGNATURE and is a usable
  # credential until its nonce is consumed. An earlier revision routed it
  # through a retained `mint.out`, which left that credential on disk and
  # contradicted this file's own promise never to record signatures.
  #
  # It now travels through a private FIFO: a rendezvous with no backing store,
  # so no envelope byte is ever persisted. The parent opens the FIFO read/write
  # BEFORE the child starts, which is what stops `mkfifo` semantics from
  # deadlocking and lets `run_bounded` stay in the foreground — preserving the
  # parent-owned pid registration this whole design depends on.
  local fifo_dir fifo
  fifo_dir="$(mktemp -d "${RUN_STATE_DIR}/mint-fifo.XXXXXX" 2>/dev/null)" || return 1
  chmod 700 "$fifo_dir" 2>/dev/null || true
  fifo="${fifo_dir}/envelope"
  mkfifo -m 600 "$fifo" 2>/dev/null || return 1
  # Two descriptors, deliberately. Fd 9 is a read/write GUARD: opening a FIFO
  # read-only blocks until a writer arrives, and the guard removes that block so
  # fd 8 can be opened before the child exists. But the guard is itself a writer,
  # so EOF is unreachable while it is open — it is closed immediately after the
  # child finishes, and only then can the reader see end-of-stream.
  # Fixed descriptors rather than `{var}<>`: portable to older bash.
  exec 9<>"$fifo" || return 1
  exec 8<"$fifo" || { exec 9>&-; return 1; }

  # Secrets reach the child through its ENVIRONMENT, never through an argv.
  # `env -i NAME=secret …` would place the signing key in `env`'s own argument
  # vector, where the process table exposes it for the life of the exec. The
  # child instead inherits, and the variables it has no business holding are
  # unset in the subshell that becomes that child.
  # The signing key and kid travel as ONE bounded record on stdin, so they are
  # in neither the child's argv nor its environ.
  local secret_record="${ASIMP_S6_SIGNING_KEY_HEX}"$'\t'"${ASIMP_S6_SIGNING_KID}"

  minimal_env_command bun "${RUN_STATE_DIR}/mint-envelope.mjs" \
    "$method" "$route" "$action" "$principal" "$body" "$skew"
  local status=0
  run_bounded "$bound" "$fifo" "$secret_record" "${MINIMAL_CMD[@]}" \
    2>>"${RUN_STATE_DIR}/mint.err" || status=$?
  # Drop the guard writer now the child is done, so EOF is reachable.
  exec 9>&-
  if (( status != 0 )); then
    exec 8<&-
    return 1
  fi
  # EXACTLY one newline-terminated bounded record, then end of stream.
  local extra="" extra_status=0
  IFS= read -r -t 10 MINTED_CONFIG <&8 || MINTED_CONFIG=""
  IFS= read -r -t 2 extra <&8 || extra_status=$?
  # EXACT end-of-stream is required. `read` returns 1 at EOF and >128 on
  # timeout; the previous form treated both as "no extra bytes", so a writer
  # that stayed open — the very deadlock this transport had — was accepted as a
  # clean single record.
  if (( extra_status == 0 )) || (( extra_status > 128 )) || [[ -n "$extra" ]]; then
    MINTED_CONFIG=""
  fi
  exec 8<&-
  (( ${#MINTED_CONFIG} <= MAX_ENVELOPE_HEADER_BYTES )) || MINTED_CONFIG=""
  [[ -n "$MINTED_CONFIG" ]] || return 1

  # Retain this signature for the leak canary. `MINTED_CONFIG` is overwritten by
  # the next mint, so scanning only that left every earlier signature — each a
  # live credential until its nonce is consumed — unchecked. Extracted with
  # parameter expansion so the value never reaches an argv, and never printed.
  local tail_part="${MINTED_CONFIG##*\\\"signature\\\":\\\"}"
  local signature="${tail_part%%\\\"*}"
  if [[ -n "$signature" && "$signature" != "$MINTED_CONFIG" ]]; then
    MINTED_SIGNATURES+=("$signature")
  fi
}
# Every signature this run has minted. Non-exported, never printed.
MINTED_SIGNATURES=()
# An envelope header is a bounded record; anything larger is not one.
readonly MAX_ENVELOPE_HEADER_BYTES=16384
MINTED_CONFIG=""

# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

# A GET sponsor route: proves verification and attribution without minting state.
readonly ROUTE_PROPOSALS="/v1/enrollments/proposals"
readonly ACTION_PROPOSALS="enrollment.proposals.list"
# A real POST sponsor route. The tamper case MUST use this: posting to a
# GET-only route would be refused by routing with 404/405 before the envelope
# verifier ever ran, and that refusal would prove nothing about tamper
# detection. A refused envelope commits no write, so this is side-effect free.
readonly ROUTE_MINT="/v1/enrollments"
readonly ACTION_MINT="enrollment.mint"

# ---------------------------------------------------------------------------
# Phase 1 — the browser leg: live Set-Cookie, live cookie refusal, real action
# ---------------------------------------------------------------------------

run_browser_leg() {
  local worker="$1"
  if [[ ! -f "$PLAYWRIGHT_RUNNER" ]]; then
    buffer_browser_blocked "BROWSER_RUNNER_MISSING" "the browser leg requires ${PLAYWRIGHT_RUNNER}"
    return 1
  fi
  local status=0
  # `run_bounded` runs in the PARENT shell and writes to a file, so its pid and
  # process group stay registered where the EXIT trap can reach them. Capturing
  # it with `$( )` would strand Chromium's group in a dead subshell.
  local out_file="${RUN_STATE_DIR}/browser.out"
  local bound
  bound="$(phase_budget "$BROWSER_TIMEOUT_SECONDS")"
  if (( bound <= 0 )); then
    fail_record "browser-leg" "no budget remained to start the browser leg"
    return 1
  fi
  # The browser receives ONLY what it needs. It never holds the Fellow bearer or
  # the envelope signing key, so a page, an extension, or a Chromium crash dump
  # cannot carry them out. The unwanted variables are unset in the subshell that
  # BECOMES the child, so no secret is ever written into an `env` argv where the
  # process table would expose it.
  # Origins and the Google account travel as ONE bounded JSON record on stdin.
  # Nothing secret is in argv or environ, so Chromium cannot inherit any of it.
  local config_record
  config_record="$(printf '{"previewUrl":"%s","workerUrl":"%s","user":"%s","password":"%s"}' \
    "$(json_string "$ASIMP_S6_PREVIEW_URL")" "$(json_string "$ASIMP_S6_WORKER_URL")" \
    "$(json_string "$ASIMP_S6_TEST_GOOGLE_USER")" "$(json_string "$ASIMP_S6_TEST_GOOGLE_PASS")")"
  minimal_env_command bun "$PLAYWRIGHT_RUNNER"
  run_bounded "$bound" "$out_file" "$config_record" "${MINIMAL_CMD[@]}" \
    2>"${RUN_STATE_DIR}/browser.err" || status=$?

  # STATUS FIRST, before the record is even looked at.
  #
  # A runner that printed a well-formed pass record and then timed out (124),
  # left cleanup unproven (125) or could not be bounded (126) would otherwise
  # have its record parsed and its claims accepted. The exit status is part of
  # the evidence, not a footnote to it.
  if [[ "$status" -ne 0 && "$status" -ne "$EX_CONFIG" ]]; then
    fail_record "browser-leg" "the browser leg exited ${status}; its output is not evidence"
    return 1
  fi

  local record
  record="$(grep -F '"suite":"s6-cross-plane-browser"' "$out_file" 2>/dev/null | tail -1)"
  if [[ -z "$record" ]]; then
    fail_record "browser-leg" "the browser runner produced no record (status ${status})"
    return 1
  fi

  if [[ "$status" -eq "$EX_CONFIG" ]]; then
    buffer_browser_blocked "BROWSER_LEG_BLOCKED" "the browser leg could not run: $(problem_code "$record")"
    return 1
  fi

  # Attribute assertions are made here, against the runner's typed record, so
  # this script's own report carries them rather than pointing at another tool.
  if [[ "$record" == *'"host_only":true'* && "$record" == *'"http_only":true'* &&
    "$record" == *'"secure":true'* && "$record" == *'"same_site":"lax"'* &&
    "$record" == *'"scoped_to_apex":true'* && "$record" == *'"present_for_agent_host":false'* ]]; then
    pass_record "cookie-host-only-live" "the live Set-Cookie header from the Agora origin carried no Domain attribute and the jar scoped it to the apex alone"
  else
    fail_record "cookie-host-only-live" "the live Set-Cookie header did not prove host-only apex scoping"
  fi

  # Direction B of WRONG_PRINCIPAL.
  #
  # State this one exactly, because the obvious wording is false. The session
  # cookie is host-only on the apex, so the browser NEVER attaches it to a
  # request for the agent host — that non-transmission is precisely what
  # host-only means, and `present_for_agent_host:false` above is its direct
  # evidence. The probe therefore does not present a cookie and get refused; it
  # carries no credential at all, and the agent host answers 403 WRONG_PRINCIPAL.
  # Claiming "a live cookie was refused" would describe a weaker world than the
  # one proved, in which the cookie reached `a.` and was merely rejected there.
  if [[ "$record" == *'"cookie_probe":{"status":403,"code":"WRONG_PRINCIPAL"}'* ]]; then
    pass_record "cookie-not-sent-to-agent-host" "the live host-only cookie was not sent to the agent host; that request carried no credential and ${ROUTE_PROPOSALS} answered exactly 403 WRONG_PRINCIPAL"
  else
    fail_record "cookie-not-sent-to-agent-host" "the agent-host request from the logged-in browser did not answer exactly 403 WRONG_PRINCIPAL"
  fi

  # Request correlation, matching the runner's `edge_request_id` field EXACTLY.
  #
  # This parsed `"deployment"` after the runner had been renamed, so the field
  # never matched and every otherwise-green live run failed here — a silent
  # cross-file drift that no local gate could see, because neither file is wrong
  # on its own. The TS suite now pins both halves of this contract together.
  local edge_request_id
  edge_request_id="$(printf '%s' "$record" | sed -n 's/.*"edge_request_id":"\([^"]\{1,200\}\)".*/\1/p')"
  # NOT AN ASSERTION. Fable S-6 does not require `x-vercel-id`, the runner types
  # the field as nullable, and its absence proves nothing — so no success claim
  # depends on it and it does not inflate the assertion count either way. When an
  # edge supplies it, it is logged for correlation and nothing more.
  if [[ -n "$edge_request_id" ]]; then
    log "${SUITE}: edge request id ${edge_request_id} (correlation only; not a deployment or revision pin)"
  fi

  # The receipt is accepted only in its exact structured form, and only when the
  # runner proved the id was absent before the action. A bare id would be a
  # reading of the page, not a receipt for the write.
  RECEIPT="$(printf '%s' "$record" | sed -n 's/.*"receipt":{"enrollment_id":"\(ASIMP-EN-[0-9A-HJKMNP-TV-Z]\{26\}\)","absent_before_action":true}.*/\1/p')"
  if [[ -z "$RECEIPT" ]]; then
    fail_record "agora-origination" "the browser leg reported no structured receipt proven absent before the action"
    return 1
  fi
  pass_record "agora-origination" "the real console Server Action minted an enrollment absent before the click, through the signed envelope path"
  return 0
}

# ---------------------------------------------------------------------------
# Phase 2 — Worker verification of real signed envelopes
# ---------------------------------------------------------------------------

assert_worker_accepts_valid_envelope() {
  local worker="$1" sponsor="$2" config response status
  mint_envelope_config GET "$ROUTE_PROPOSALS" "$ACTION_PROPOSALS" "$sponsor" "" || {
    fail_record "worker-accepts-valid-envelope" "the product minter produced no envelope"
    return
  }
  config="$MINTED_CONFIG"
  http_request GET "${worker}${ROUTE_PROPOSALS}" "" "$config"
  response="$HTTP_RESPONSE"
  status="$(status_of "$response")"
  if [[ "$status" == "200" ]]; then
    pass_record "worker-accepts-valid-envelope" "the deployed Worker verified a product-minted envelope and returned 200"
    VALID_ENVELOPE_HEADER="$config"
  else
    fail_record "worker-accepts-valid-envelope" "expected 200 from ${ROUTE_PROPOSALS}, observed ${status}"
  fi
}

assert_replay_refused() {
  local worker="$1"
  if [[ -z "$VALID_ENVELOPE_HEADER" ]]; then
    fail_record "envelope-replay-refused" "no accepted envelope to replay"
    return
  fi
  local response status code
  http_request GET "${worker}${ROUTE_PROPOSALS}" "" "$VALID_ENVELOPE_HEADER"
  response="$HTTP_RESPONSE"
  status="$(status_of "$response")"
  code="$(problem_code "$(body_of "$response")")"
  # Replay, tamper and expiry share one opaque 401 face on purpose (Rule A5):
  # a distinct code per failure mode would be a forgery oracle.
  if [[ "$status" == "401" && "$code" == "UNAUTHORIZED" ]]; then
    pass_record "envelope-replay-refused" "the second presentation of a single-use nonce was refused 401 UNAUTHORIZED"
  else
    fail_record "envelope-replay-refused" "expected 401 UNAUTHORIZED on replay, observed ${status} ${code:-<no code>}"
  fi
}

assert_altered_payload_refused() {
  local worker="$1" sponsor="$2" config response status code
  # The envelope binds a digest of `{}` on a route that really accepts POST, so
  # the request reaches envelope verification and the refusal is about the
  # payload digest rather than about routing.
  mint_envelope_config POST "$ROUTE_MINT" "$ACTION_MINT" "$sponsor" '{}' || {
    fail_record "envelope-altered-payload-refused" "the product minter produced no envelope"
    return
  }
  config="$MINTED_CONFIG"
  printf '%s' '{"altered":true}' > "${RUN_STATE_DIR}/altered.json"
  # The router checks the JSON content-type BEFORE it authenticates
  # (apps/wire/src/enrollment/router.ts, `hasJsonContentType` precedes
  # `requireSponsor`). Without this header the request is refused as
  # JSON_CONTENT_TYPE_REQUIRED and never reaches envelope verification, so the
  # case would pass for entirely the wrong reason.
  config="${config}"$'\n''header = "content-type: application/json; charset=utf-8"'
  http_request POST "${worker}${ROUTE_MINT}" "${RUN_STATE_DIR}/altered.json" "$config"
  response="$HTTP_RESPONSE"
  status="$(status_of "$response")"
  code="$(problem_code "$(body_of "$response")")"
  if [[ "$code" == "JSON_CONTENT_TYPE_REQUIRED" ]]; then
    fail_record "envelope-altered-payload-refused" "the tamper request was refused for its content-type before reaching envelope verification; this case proved nothing about tamper detection"
    return
  fi
  if [[ "$status" == "401" && "$code" == "UNAUTHORIZED" ]]; then
    pass_record "envelope-altered-payload-refused" "a body whose digest differs from the signed payload_sha256 was refused 401 UNAUTHORIZED on a POST route that reaches the verifier"
  else
    fail_record "envelope-altered-payload-refused" "expected 401 UNAUTHORIZED on altered payload, observed ${status} ${code:-<no code>}; a 404 or 405 would mean the request never reached envelope verification"
  fi
}

assert_expired_envelope_refused() {
  local worker="$1" sponsor="$2" config response status code
  mint_envelope_config GET "$ROUTE_PROPOSALS" "$ACTION_PROPOSALS" "$sponsor" "" -3600 || {
    fail_record "envelope-expired-refused" "the product minter produced no envelope"
    return
  }
  config="$MINTED_CONFIG"
  http_request GET "${worker}${ROUTE_PROPOSALS}" "" "$config"
  response="$HTTP_RESPONSE"
  status="$(status_of "$response")"
  code="$(problem_code "$(body_of "$response")")"
  if [[ "$status" == "401" && "$code" == "UNAUTHORIZED" ]]; then
    pass_record "envelope-expired-refused" "an envelope one hour past its expiry was refused 401 UNAUTHORIZED"
  else
    fail_record "envelope-expired-refused" "expected 401 UNAUTHORIZED on expired envelope, observed ${status} ${code:-<no code>}"
  fi
}

# ---------------------------------------------------------------------------
# Phase 3 — WRONG_PRINCIPAL direction A, and the non-consultation differential
# ---------------------------------------------------------------------------

assert_bearer_on_sponsor_route_refused() {
  local worker="$1" response status code
  # The bearer travels in a stdin config document, never in argv.
  http_request GET "${worker}${ROUTE_PROPOSALS}" "" \
    "header = \"authorization: Bearer ${ASIMP_S6_FELLOW_TOKEN}\""
  response="$HTTP_RESPONSE"
  status="$(status_of "$response")"
  code="$(problem_code "$(body_of "$response")")"
  if [[ "$status" == "403" && "$code" == "WRONG_PRINCIPAL" ]]; then
    pass_record "bearer-on-sponsor-route-refused" "a Fellow bearer on ${ROUTE_PROPOSALS} was refused with exactly 403 WRONG_PRINCIPAL"
  else
    fail_record "bearer-on-sponsor-route-refused" "expected 403 WRONG_PRINCIPAL, observed ${status} ${code:-<no code>}"
  fi
}

# The control for direction B, from outside the browser entirely.
#
# The browser's agent-host request carried no cookie, because the cookie is
# host-only on the apex. This issues the same request from a client that has no
# session at all and requires the identical answer. Agreement is what lets the
# two be read together: the agent host gives one refusal for "no credential",
# and a logged-in browser gets exactly that refusal, so holding an apex session
# buys nothing on `a.`.
assert_cookie_changed_nothing() {
  local worker="$1" response status code
  http_request GET "${worker}${ROUTE_PROPOSALS}" "" ""
  response="$HTTP_RESPONSE"
  status="$(status_of "$response")"
  code="$(problem_code "$(body_of "$response")")"
  if [[ "$status" == "403" && "$code" == "WRONG_PRINCIPAL" ]]; then
    pass_record "no-credential-differential" "a sessionless client on ${ROUTE_PROPOSALS} stayed at exactly 403 WRONG_PRINCIPAL, matching the logged-in browser's agent-host result"
  else
    fail_record "no-credential-differential" "the sessionless control returned ${status} ${code:-<no code>} instead of 403 WRONG_PRINCIPAL, so it no longer matches the browser's agent-host result"
  fi
}

# ---------------------------------------------------------------------------
# Phase 4 — the receipt is attributed in deployed D1
# ---------------------------------------------------------------------------

assert_receipt_attributed() {
  local worker="$1" sponsor="$2" config response status
  [[ -n "$RECEIPT" ]] || { fail_record "agora-origination-attributed" "no receipt to confirm"; return; }
  mint_envelope_config GET "$ROUTE_PROPOSALS" "$ACTION_PROPOSALS" "$sponsor" "" || {
    fail_record "agora-origination-attributed" "the product minter produced no envelope"
    return
  }
  config="$MINTED_CONFIG"
  http_request GET "${worker}${ROUTE_PROPOSALS}" "" "$config"
  response="$HTTP_RESPONSE"
  status="$(status_of "$response")"
  if [[ "$status" != "200" ]]; then
    fail_record "agora-origination-attributed" "could not read the sponsor's proposals (status ${status})"
    return
  fi
  # Fixed-string, never a regex: an enrollment id is data, and treating data as
  # a pattern is how an unexpected character silently changes what matched.
  if printf '%s' "$(body_of "$response")" | grep -qF -- "$RECEIPT"; then
    pass_record "agora-origination-attributed" "the enrollment minted by the real Server Action is attributed to this sponsor in deployed D1"
  else
    fail_record "agora-origination-attributed" "the receipted enrollment is not present under this sponsor's attribution"
  fi
}

# ---------------------------------------------------------------------------
# Evidence, leak canary, exit
# ---------------------------------------------------------------------------

# Writes ONE fresh evidence file per run and never overwrites another.
#
# An earlier revision redirected onto a fixed `${dir}/${SUITE}.json` and was
# called twice, so a second run silently destroyed the first run's evidence and
# the second call clobbered the first. `noclobber` makes an existing path a
# typed refusal instead of a truncation, and the name is unique per run.
# Writes ONE fresh evidence file and FAILS CLOSED.
#
# Every field is a fixed non-secret scalar this run computed for itself. The
# record is built after the leak scan so its counts are final, and
# `EVIDENCE_PATH` is set only once a regular, owner-only, non-empty file has
# been verified on disk — a run must not report `pass` with no evidence behind
# it. `noclobber` makes an existing path a refusal, never a truncation.
write_evidence_bundle() {
  local dir="${ASIMP_S6_EVIDENCE_DIR:-}"
  [[ -n "$dir" ]] || return 0
  if ! mkdir -p "$dir" 2>/dev/null; then
    fail_record "evidence-written" "the evidence directory could not be created"
    return 1
  fi
  local path="${dir}/${SUITE}.$$.${SECONDS}.json"
  if [[ -e "$path" ]]; then
    fail_record "evidence-written" "an artifact already exists at the allocated evidence path; refusing to overwrite it"
    return 1
  fi
  local previous_umask
  previous_umask="$(umask)"
  umask 077
  (
    set -C
    printf '{"suite":"%s","schema_version":3,"bead":"asimposiumorg-vw3","kid":"%s","apex_host":"%s","agent_host":"%s","assertions":%s,"failures":%s,"duration_seconds":%s}\n' \
      "$SUITE" \
      "$(json_string "${ASIMP_S6_SIGNING_KID:-}")" \
      "$(json_string "$(origin_host "${ASIMP_S6_PREVIEW_URL:-}")")" \
      "$(json_string "$(origin_host "${ASIMP_S6_WORKER_URL:-}")")" \
      "$ASSERTIONS" "$FAILURES" "$SECONDS" \
      > "$path"
  )
  local wrote=$?
  umask "$previous_umask"
  if (( wrote != 0 )) || [[ ! -f "$path" || ! -s "$path" ]]; then
    fail_record "evidence-written" "the evidence record was not created as a non-empty regular file"
    return 1
  fi
  # FAIL CLOSED on an unobservable mode. Accepting an empty stat result meant a
  # platform where the probe failed silently produced "evidence" whose
  # permissions had never been checked at all.
  if [[ -L "$path" ]]; then
    fail_record "evidence-written" "the evidence path is a symlink; refusing to follow it"
    return 1
  fi
  local mode
  mode="$(/usr/bin/stat -f '%Lp' "$path" 2>/dev/null || /usr/bin/stat -c '%a' "$path" 2>/dev/null || printf '')"
  if [[ "$mode" != "600" ]]; then
    fail_record "evidence-written" "the evidence record's mode could not be confirmed as owner-only (observed '${mode:-unreadable}')"
    return 1
  fi
  EVIDENCE_PATH="$path"
  return 0
}
EVIDENCE_PATH=""

# Search REGULAR FILES ONLY for a fixed string. Returns 0 on a hit.
#
# `find … | xargs -0 -r grep -q` cannot be used: on macOS `xargs -r` still exits
# 0 when the input is empty, so an empty directory reported a hit. It also would
# open a FIFO and block once its writers closed. This loop tests each regular
# file explicitly, so "no files" is unambiguously "no hit".
# Absolute grep, resolved once. Internal seam only; never taken from the caller.
SCAN_GREP="/usr/bin/grep"
scan_regular_files_for() {
  local needle="$1"
  shift
  local file
  while IFS= read -r -d '' file; do
    # The needle travels on STDIN, never in an argv.
    #
    # `$SCAN_GREP` is an INTERNAL seam, never read from the caller's
    # environment: the self-test points it at a held wrapper so the real
    # scanner's own argv can be inspected while it runs.
    #
    # `grep -qF -- "$needle" file` published the secret in grep's own command
    # line for the life of the process — the exact exposure the whole transport
    # design exists to avoid, committed by the canary meant to detect it.
    # `printf` is a builtin, so the value never becomes any process's argument,
    # and `-f -` makes grep read the pattern from the pipe.
    printf '%s' "$needle" | "$SCAN_GREP" -qFf - "$file" 2>/dev/null && return 0
  done < <(find "$@" -type f -print0 2>/dev/null)
  return 1
}

# Proves the never-log property held for this run rather than asserting it. No
# value is skipped for being short: a short secret is still a secret, and
# silently declining to scan one is how a leak stays invisible. A value too
# short to be a reliable canary is reported as such and still scanned.
assert_no_secret_escaped() {
  local name value hits=0
  # THIS RUN's private artifacts only.
  #
  # The caller's evidence directory is deliberately NOT scanned: it is
  # unbounded, may hold unrelated files from other runs and tools, and walking
  # it could match stale bytes this run never wrote or outlive the deadline. The
  # final evidence record is built from fixed non-secret fields after this scan,
  # so it needs no scanning of its own.
  local -a targets=()
  [[ -n "$RUN_STATE_DIR" ]] && targets+=("$RUN_STATE_DIR")
  (( ${#targets[@]} == 0 )) && { pass_record "no-secret-escaped" "no retained artifact directory to scan"; return; }

  for name in "${SECRET_VARS[@]}"; do
    value="${!name:-}"
    [[ -n "$value" ]] || continue
    if (( ${#value} < 16 )); then
      # Named, not skipped: the scan still runs below.
      emit "{\"suite\":\"${SUITE}\",\"assertion\":\"secret-canary-weak\",\"status\":\"pass\",\"detail\":\"$(json_string "${name} is shorter than 16 bytes; it is still scanned, but a short value is a weak canary")\",\"reproduce\":\"${REPRODUCE}\"}"
    fi
    # REGULAR FILES ONLY. A recursive grep would open the envelope FIFO and
    # block forever once its writers had closed, hanging `finish` on the very
    # transport chosen to keep the signature off disk. `-type f` also skips
    # devices and sockets, which cannot hold a retained secret anyway.
    if scan_regular_files_for "$value" "${targets[@]}"; then
      hits=$((hits + 1))
      fail_record "no-secret-escaped" "the value of ${name} reached a retained artifact"
    fi
  done

  # EVERY minted signature, not just the current one.
  #
  # `MINTED_CONFIG` holds only the most recent envelope, so scanning it alone
  # left every earlier signature unchecked — and each one is a live credential
  # until its nonce is consumed. They are retained in non-exported shell state
  # and scanned here. Neither the array nor any element is ever printed.
  local index=0 signature
  for signature in ${MINTED_SIGNATURES[@]+"${MINTED_SIGNATURES[@]}"}; do
    index=$((index + 1))
    [[ -n "$signature" ]] || continue
    if scan_regular_files_for "$signature" "${targets[@]}"; then
      hits=$((hits + 1))
      fail_record "no-secret-escaped" "a minted envelope signature (#${index}) reached a retained artifact"
    fi
  done

  if (( hits == 0 )); then
    pass_record "no-secret-escaped" "no never-log value and no minted signature appears in any retained artifact (${#SECRET_VARS[@]} declared secrets, ${index} minted signatures)"
  fi
}

finish() {
  # CLEANUP IS PROVEN FIRST — before the scan, before the evidence, before any
  # terminal verdict.
  #
  # Previously `finish` published a pass and an immutable evidence record and
  # only then returned into the EXIT trap, where the reap happened. A run could
  # therefore emit a green result followed by a late cleanup failure, with the
  # evidence already written. Proving it here means a survivor becomes an
  # assertion failure that the verdict below must account for.
  reap_children
  # The EXIT trap must not repeat the reap it has already been given.
  CLEANED_UP=1
  if (( REAP_SURVIVORS != 0 )); then
    # Same rule as the blocked path: seal nothing while a survivor remains.
    blocked_record "CLEANUP_UNPROVEN" "a child process group survived cleanup; no scan, evidence or verdict was sealed"
    log "FAILED ${SUITE}: cleanup could not be proven; nothing was sealed."
    exit "$EX_CLEANUP_UNPROVEN"
  fi

  # Scan next, then write exactly one bundle whose counts already include both
  # the cleanup verdict and the canary's.
  assert_no_secret_escaped
  write_evidence_bundle
  [[ -n "$EVIDENCE_PATH" ]] && log "${SUITE}: evidence at ${EVIDENCE_PATH}"
  if (( FAILURES > 0 )); then
    emit "{\"suite\":\"${SUITE}\",\"status\":\"fail\",\"assertions\":${ASSERTIONS},\"failures\":${FAILURES},\"reproduce\":\"${REPRODUCE}\"}"
    log "FAILED ${SUITE}: ${FAILURES} of ${ASSERTIONS} assertions failed."
    exit "$EX_FAIL"
  fi
  emit "{\"suite\":\"${SUITE}\",\"status\":\"pass\",\"assertions\":${ASSERTIONS},\"failures\":0,\"reproduce\":\"${REPRODUCE}\"}"
  log "PASSED ${SUITE}: ${ASSERTIONS} assertions."
  exit 0
}

# ---------------------------------------------------------------------------
# Self-test: harness logic only, no network, no deployment claim
# ---------------------------------------------------------------------------

self_test() {
  local failures=0 r
  # Production retains its five-second TERM grace. Every self-test descendant
  # below has a deterministic readiness barrier and owns a TERM sidecar, so a
  # five-second idle pause adds no causal coverage and can conceal a hang behind
  # the outer controller's fixed 100-second bound.
  REAP_GRACE_SECONDS=0.2
  # Keep the production four-second settlement window here: on loaded macOS an
  # ordinary KILLed group can remain observable for longer than one second.
  # The deliberately non-settling plants still fit beneath the unchanged outer
  # 100-second self-test ceiling.
  CHILD_SETTLE_ATTEMPTS=80
  check() {
    if [[ "$2" == "$3" ]]; then
      emit "{\"suite\":\"${SUITE}\",\"assertion\":\"$(json_string "$1")\",\"status\":\"pass\",\"detail\":\"self-test\"}"
    else
      failures=$((failures + 1))
      emit "{\"suite\":\"${SUITE}\",\"assertion\":\"$(json_string "$1")\",\"status\":\"fail\",\"detail\":\"expected $(json_string "$3"), got $(json_string "$2")\"}"
    fi
  }

  # Test-only children settle through the same bounded pre-wait rule. On expiry
  # their ownership record is retained and the assertion fails; no helper can
  # strand this self-test in a bare `wait`.
  settle_selftest_child() {
    local name="$1" pid="$2"
    if ! direct_child_settled_before_wait "$pid"; then
      failures=$((failures + 1))
      emit "{\"suite\":\"${SUITE}\",\"assertion\":\"$(json_string "$name")\",\"status\":\"fail\",\"detail\":\"test child did not settle within the bounded pre-wait window; owner retained\"}"
      return 1
    fi
    wait "$pid" 2>/dev/null || true
    unregister_child "$pid"
    return 0
  }

  register_selftest_child() {
    local pid="$1"
    mint_owner_token "selftest"
    register_child "$pid" "$OWNER_TOKEN" "ordinary"
  }

  valid_https_origin "https://p.vercel.app" && r=yes || r=no
  check "origin-accepts-https" "$r" "yes"
  valid_https_origin "http://p.vercel.app" && r=yes || r=no
  check "origin-rejects-plaintext" "$r" "no"
  valid_https_origin "https://p.vercel.app/?share=1" && r=yes || r=no
  check "origin-rejects-query" "$r" "no"
  valid_https_origin "https://user:pw@p.vercel.app" && r=yes || r=no
  check "origin-rejects-credentials" "$r" "no"
  valid_https_origin "https://p.vercel.app/callback" && r=yes || r=no
  check "origin-rejects-path" "$r" "no"

  check "origin-host-strips-port" "$(origin_host "https://p.vercel.app:8443/")" "p.vercel.app"
  check "problem-code-extracted" "$(problem_code '{"code":"WRONG_PRINCIPAL","status":403}')" "WRONG_PRINCIPAL"
  check "problem-code-absent-is-empty" "$(problem_code '{"status":403}')" ""
  check "status-split" "$(status_of $'{"a":1}\n403')" "403"
  check "body-split" "$(body_of $'{"a":1}\n403')" '{"a":1}'
  check "json-string-escapes-quote" "$(json_string 'a"b')" 'a\"b'
  check "secret-vars-declared" "${#SECRET_VARS[@]}" "3"

  # Secret bootstrap creates no independent writer owner. The same durable
  # supervisor receives two exact lines, feeds them to the payload, then
  # self-signals and is reaped as the only ownership record.
  clear_child_records
  local bootstrap_out="${TMPDIR:-/tmp}/s6-bootstrap.$$" bootstrap_status=0 bootstrap_value=""
  run_bounded 10 "$bootstrap_out" $'line-one\nline-two' \
    bash -c 'IFS= read -r first; IFS= read -r second; printf "%s|%s" "$first" "$second"' \
    || bootstrap_status=$?
  [[ -f "$bootstrap_out" ]] && bootstrap_value="$(cat "$bootstrap_out" 2>/dev/null || printf '')"
  check "reaper-reports-no-survivors" "${bootstrap_status}:${#CHILD_PIDS[@]}" "0:0"
  check "reaper-actually-kills" "$bootstrap_value" "line-one|line-two"
  check "secret-bootstrap-has-no-independent-writer-owner" "${bootstrap_status}:${#CHILD_PIDS[@]}" "0:0"

  # A successful KILL dispatch is not settlement proof. This child is already
  # stopped, and the injected signal seam reports success without changing it.
  # The reaper must return cleanup-unproven within the settlement window while
  # retaining ownership; a real disarmed KILL then performs the only wait.
  clear_child_records
  local stopped_reaper_status=0 stopped_reaper_records
  SIGNAL_KILL_NO_SETTLE_PLANT=1
  run_bounded 10 "${TMPDIR:-/tmp}/s6-stopped-reaper.$$" - true || stopped_reaper_status=$?
  stopped_reaper_records="${#CHILD_PIDS[@]}"
  SIGNAL_KILL_NO_SETTLE_PLANT=0
  reap_children
  check "reaper-successful-kill-without-settlement-is-explicit" "$stopped_reaper_status" "$EX_CLEANUP_UNPROVEN"
  check "reaper-stopped-child-retains-owner" "$stopped_reaper_records" "1"
  check "reaper-stopped-child-retry-reaps-owner" "${REAP_SURVIVORS}:${#CHILD_PIDS[@]}" "0:0"

  # Causal: run_bounded must stop a child that outlives its bound and report
  # 124, and it must do so on the CLOCK. An iteration-counting bound drifts far
  # past its nominal limit once per-iteration work is counted.
  clear_child_records
  local bounded_status=0 bounded_start bounded_elapsed
  local bounded_out="${TMPDIR:-/tmp}/s6-bounded.$$"
  bounded_start="$(date +%s)"
  run_bounded 1 "$bounded_out" - sleep 30 || bounded_status=$?
  bounded_elapsed=$(( $(date +%s) - bounded_start ))
  check "run-bounded-times-out" "$bounded_status" "124"

  # Causal: a fast, successful child must return 0 PROMPTLY. `kill -0` reports a
  # zombie as alive, so a poll loop built on it waited out the whole bound and
  # then killed a process that had already succeeded — turning every quick child
  # into a 124. Both the status and the elapsed time are asserted; lowering the
  # bound would hide this rather than fix it.
  clear_child_records
  local fast_status=0 fast_start fast_elapsed
  fast_start=$SECONDS
  run_bounded 30 "$bounded_out" - true || fast_status=$?
  fast_elapsed=$((SECONDS - fast_start))
  check "run-bounded-fast-exit-status" "$fast_status" "0"
  if (( fast_elapsed <= 5 )); then
    emit "{\"suite\":\"${SUITE}\",\"assertion\":\"run-bounded-fast-exit-is-prompt\",\"status\":\"pass\",\"detail\":\"a child that exits at once returned in ${fast_elapsed}s under a 30s bound\"}"
  else
    failures=$((failures + 1))
    emit "{\"suite\":\"${SUITE}\",\"assertion\":\"run-bounded-fast-exit-is-prompt\",\"status\":\"fail\",\"detail\":\"a child that exits at once took ${fast_elapsed}s; the loop is treating a zombie as running\"}"
  fi
  if (( bounded_elapsed <= 6 )); then
    emit "{\"suite\":\"${SUITE}\",\"assertion\":\"run-bounded-honours-wall-clock\",\"status\":\"pass\",\"detail\":\"a 1s bound returned in ${bounded_elapsed}s\"}"
  else
    failures=$((failures + 1))
    emit "{\"suite\":\"${SUITE}\",\"assertion\":\"run-bounded-honours-wall-clock\",\"status\":\"fail\",\"detail\":\"a 1s bound took ${bounded_elapsed}s; the bound is not wall-clock\"}"
  fi

  # The builtin read timeout is latched in parent memory before teardown. A
  # cooperative payload exits zero from its TERM trap, but that later terminal
  # status cannot override the already-authoritative 124.
  local deadline_plant_dir deadline_ready deadline_term deadline_status=0
  deadline_plant_dir="$(mktemp -d "${TMPDIR:-/tmp}/s6-deadline-plant.XXXXXX" 2>/dev/null)" || deadline_plant_dir=""
  if [[ -n "$deadline_plant_dir" ]]; then
    deadline_ready="${deadline_plant_dir}/ready"
    deadline_term="${deadline_plant_dir}/term-observed"
    run_bounded 1 "$bounded_out" - \
      bash -c "trap 'printf term-observed > \"\$2\"; exit 0' TERM; printf ready > \"\$1\"; while :; do sleep 30; done" \
      _ "$deadline_ready" "$deadline_term" || deadline_status=$?
  fi
  local deadline_ready_value="" deadline_term_value=""
  [[ -f "${deadline_ready:-}" ]] && deadline_ready_value="$(cat "$deadline_ready" 2>/dev/null || printf '')"
  [[ -f "${deadline_term:-}" ]] && deadline_term_value="$(cat "$deadline_term" 2>/dev/null || printf '')"
  check "parent-deadline-cooperative-term-ready" "$deadline_ready_value" "ready"
  check "parent-deadline-cooperative-term-observed" "$deadline_term_value" "term-observed"
  check "parent-deadline-exact-124-overrides-child-zero" "$deadline_status" "124"

  # Opposite polarity: this target deliberately ignores TERM. Its endless
  # builtin loop can settle only when the supervisor executes self-KILL; status
  # 124 with no retained owner therefore proves the resistant branch completed.
  clear_child_records
  local resistant_dir resistant_ready resistant_status=0 resistant_ready_value=""
  resistant_dir="$(mktemp -d "${TMPDIR:-/tmp}/s6-resistant-plant.XXXXXX" 2>/dev/null)" || resistant_dir=""
  if [[ -n "$resistant_dir" ]]; then
    resistant_ready="${resistant_dir}/ready"
    run_bounded 1 "$bounded_out" - \
      bash -c 'trap "" TERM; printf ready > "$1"; while :; do IFS= read -r -t 30 _ || true; done' \
      _ "$resistant_ready" || resistant_status=$?
  fi
  [[ -f "${resistant_ready:-}" ]] && resistant_ready_value="$(cat "$resistant_ready" 2>/dev/null || printf '')"
  check "parent-deadline-resistant-kill-ready" "$resistant_ready_value" "ready"
  check "parent-deadline-resistant-kill-settles" "${resistant_status}:${#CHILD_PIDS[@]}" "124:0"

  # Causal KILL-dispatch failure. The watchdog's final KILL is rejected while
  # the supervisor is still live. `run_bounded` must return cleanup-unproven on
  # its own clock, retaining the active record instead of waiting forever. The
  # same injected failure is then driven through `reap_children`, which must
  # also return with the record intact; only after the fault is disarmed may a
  # successful KILL reap and unregister the pinned group.
  clear_child_records
  local kill_failure_status=0 kill_failure_started=$SECONDS kill_failure_elapsed
  SIGNAL_KILL_FAILURE_PLANT=1
  run_bounded 1 "$bounded_out" - sleep 30 || kill_failure_status=$?
  kill_failure_elapsed=$((SECONDS - kill_failure_started))
  local kill_failure_records_after_bound="${#CHILD_PIDS[@]}"
  # Both reaps below target a TERM-resistant supervisor specifically to reach
  # the KILL branch. Its ordinary five-second TERM grace adds no coverage here,
  # so this in-process plant sets that unrelated pause to zero and restores the
  # production value before any later check.
  local saved_reap_grace="$REAP_GRACE_SECONDS"
  REAP_GRACE_SECONDS=0
  reap_children
  local kill_failure_reap_verdict="$REAP_SURVIVORS"
  local kill_failure_records_after_failed_reap="${#CHILD_PIDS[@]}"
  SIGNAL_KILL_FAILURE_PLANT=0
  reap_children
  REAP_GRACE_SECONDS="$saved_reap_grace"
  check "watchdog-kill-dispatch-failure-status" "$kill_failure_status" "$EX_CLEANUP_UNPROVEN"
  check "watchdog-kill-dispatch-failure-retains-owner" "$kill_failure_records_after_bound" "1"
  check "reaper-kill-dispatch-failure-is-explicit" "$kill_failure_reap_verdict" "1"
  check "reaper-kill-dispatch-failure-retains-owner" "$kill_failure_records_after_failed_reap" "1"
  check "kill-dispatch-retry-reaps-owner" "${REAP_SURVIVORS}:${#CHILD_PIDS[@]}" "0:0"
  if (( kill_failure_elapsed <= 6 )); then
    emit "{\"suite\":\"${SUITE}\",\"assertion\":\"watchdog-kill-dispatch-failure-is-bounded\",\"status\":\"pass\",\"detail\":\"the injected KILL refusal returned in ${kill_failure_elapsed}s without waiting on the live supervisor\"}"
  else
    failures=$((failures + 1))
    emit "{\"suite\":\"${SUITE}\",\"assertion\":\"watchdog-kill-dispatch-failure-is-bounded\",\"status\":\"fail\",\"detail\":\"the injected KILL refusal took ${kill_failure_elapsed}s\"}"
  fi

  # Pre-ready failure: the process-substitution leader departs before publishing
  # readiness. The already-adopted write-only channel either retires it or fails
  # with EPIPE; bounded group absence is required before the direct wait.
  clear_child_records
  local pre_ready_status=0
  SUPERVISOR_READY_WRITE_PLANT=1
  run_bounded 10 "$bounded_out" - true || pre_ready_status=$?
  SUPERVISOR_READY_WRITE_PLANT=0
  check "pre-ready-supervisor-failure-status" "$pre_ready_status" "$EX_WATCHDOG_UNAVAILABLE"
  check "pre-ready-supervisor-failure-reaped" "${#CHILD_PIDS[@]}:${GROUP_CONTROL_PID}" "0:"

  # The payload must not inherit either side of the supervisor channel. FD 6 is
  # the parent writer and the supervisor read side is FD7; the payload gets
  # /dev/null and sees result/control/order FDs 5 through 8 closed.
  clear_child_records
  local fd_status=0 fd_record=""
  run_bounded 10 "$bounded_out" - \
    bash -c 'if { : >&5; } 2>/dev/null || { : >&6; } 2>/dev/null || { : <&7; } 2>/dev/null || { : >&8; } 2>/dev/null; then printf inherited; else printf closed; fi' \
    || fd_status=$?
  [[ -f "$bounded_out" ]] && fd_record="$(cat "$bounded_out" 2>/dev/null || printf '')"
  check "supervisor-control-fd-not-inherited" "${fd_status}:${fd_record}" "0:closed"

  # An unsolicited control acknowledgement cannot occur before the parent has
  # requested any signal. Inject it before payload fork; the main outcome reader
  # must refuse rather than queue it and later publish a false success.
  clear_child_records
  local early_ack_status=0
  SUPERVISOR_EARLY_ACK_PLANT=1
  run_bounded 10 "$bounded_out" - true || early_ack_status=$?
  SUPERVISOR_EARLY_ACK_PLANT=0
  check "unsolicited-control-ack-fails-closed" "$early_ack_status" "$EX_WATCHDOG_UNAVAILABLE"

  # Legitimate opposite order: after timeout, a child terminal record may reach
  # fd5 immediately before the requested TERM ack. The ack reader must retain the
  # child record, consume the exact ack, and still finish the authoritative 124.
  clear_child_records
  local child_before_ack_dir child_before_ack_ready child_before_ack_ready_value=""
  local child_before_ack_status=0 child_queue_before="$GROUP_QUEUED_CHILD_RECORDS"
  child_before_ack_dir="$(mktemp -d "${TMPDIR:-/tmp}/s6-child-before-ack.XXXXXX" 2>/dev/null)" || child_before_ack_dir=""
  if [[ -n "$child_before_ack_dir" ]]; then
    child_before_ack_ready="${child_before_ack_dir}/ready"
    SUPERVISOR_CHILD_BEFORE_ACK_PLANT=1
    run_bounded 1 "$bounded_out" - \
      bash -c 'trap "exit 0" TERM; printf ready > "$1"; while :; do sleep 30; done' \
      _ "$child_before_ack_ready" || child_before_ack_status=$?
    SUPERVISOR_CHILD_BEFORE_ACK_PLANT=0
  else
    child_before_ack_status="$EX_WATCHDOG_UNAVAILABLE"
  fi
  [[ -n "${child_before_ack_ready:-}" && -f "$child_before_ack_ready" ]] && \
    child_before_ack_ready_value="$(cat "$child_before_ack_ready" 2>/dev/null || printf '')"
  check "child-terminal-before-control-ack-ready" "$child_before_ack_ready_value" "ready"
  check "child-terminal-before-control-ack-is-retained" \
    "${child_before_ack_status}:$((GROUP_QUEUED_CHILD_RECORDS - child_queue_before))" "124:1"

  # A supervisor terminal status is canonical decimal in [0,255]. Token binding
  # alone must not make malformed 256 (or a leading-zero drift) acceptable.
  clear_child_records
  local malformed_child_status=0 leading_zero_child_status=0
  SUPERVISOR_CHILD_STATUS_PLANT=256
  run_bounded 10 "$bounded_out" - true || malformed_child_status=$?
  SUPERVISOR_CHILD_STATUS_PLANT=00
  run_bounded 10 "$bounded_out" - true || leading_zero_child_status=$?
  SUPERVISOR_CHILD_STATUS_PLANT=""
  check "token-bound-child-status-above-255-is-refused" "$malformed_child_status" "$EX_WATCHDOG_UNAVAILABLE"
  check "token-bound-child-status-leading-zero-is-refused" "$leading_zero_child_status" "$EX_WATCHDOG_UNAVAILABLE"

  # Same-UID hostile target: discover the predictable result FIFO without being
  # told its exact path and inject the formerly accepted unkeyed `child:0` before
  # exiting nonzero. The private token is never in target argv/env/fds, so the
  # forged record must turn the run red rather than green.
  clear_child_records
  local forged_root forged_status=0
  forged_root="$(mktemp -d "${TMPDIR:-/tmp}/s6-forged-result-root.XXXXXX" 2>/dev/null)" || forged_root=""
  forged_result_plant() {
    local TMPDIR="$1"
    run_bounded 10 "$bounded_out" - \
      bash "$SCRIPT_SELF" --self-test-forge-result "$TMPDIR"
  }
  if [[ -n "$forged_root" ]]; then
    forged_result_plant "$forged_root" || forged_status=$?
  else
    forged_status="$EX_WATCHDOG_UNAVAILABLE"
  fi
  check "unkeyed-forged-child-zero-cannot-green" "$forged_status" "$EX_WATCHDOG_UNAVAILABLE"

  # Force the sole listener to close and its leader to be reaped, making the old
  # numeric PGID reusable. A subsequent capability write must fail through the
  # dead pipe; there is structurally no numeric signal fallback.
  clear_child_records
  local dead_listener_status=0
  DEAD_LISTENER_WRITE_REFUSAL_OBSERVED=0
  SUPERVISOR_DEPART_AFTER_RESULT_PLANT=1
  run_bounded 10 "$bounded_out" - true || dead_listener_status=$?
  SUPERVISOR_DEPART_AFTER_RESULT_PLANT=0
  check "dead-listener-write-is-refused" \
    "${dead_listener_status}:${DEAD_LISTENER_WRITE_REFUSAL_OBSERVED}" "0:1"
  check "departed-listener-never-signals-recycled-pgid" \
    "$DEAD_LISTENER_WRITE_REFUSAL_OBSERVED" "1"

  # Supervisor KILL reports success but deliberately leaves the group live.
  # `run_bounded` must prove settlement before its supervisor wait, retain that
  # owner on expiry, and let only a disarmed reaper wait/unregister it.
  clear_child_records
  local stopped_supervisor_status=0 stopped_supervisor_records
  SIGNAL_KILL_NO_SETTLE_PLANT=1
  run_bounded 10 "$bounded_out" - true || stopped_supervisor_status=$?
  SIGNAL_KILL_NO_SETTLE_PLANT=0
  stopped_supervisor_records="${#CHILD_PIDS[@]}"
  reap_children
  check "successful-supervisor-kill-without-settlement-status" "$stopped_supervisor_status" "$EX_CLEANUP_UNPROVEN"
  check "successful-supervisor-kill-without-settlement-retains-owner" "$stopped_supervisor_records" "1"
  check "stopped-supervisor-retry-reaps-owner" "${REAP_SURVIVORS}:${#CHILD_PIDS[@]}" "0:0"

  # The old child-before-open failure is structurally absent: no independent
  # writer or input FIFO exists. Drive the real bootstrap and require exact bytes plus zero
  # ownership records after the one supervisor settles.
  clear_child_records
  local bootstrap_plant_status=0 bootstrap_plant_started=$SECONDS bootstrap_plant_elapsed bootstrap_plant_payload=""
  run_bounded 10 "$bounded_out" "planted-input-bootstrap-record" \
    bash -c 'IFS= read -r value; printf "%s" "$value"' || bootstrap_plant_status=$?
  [[ -f "$bounded_out" ]] && bootstrap_plant_payload="$(cat "$bounded_out" 2>/dev/null || printf '')"
  bootstrap_plant_elapsed=$((SECONDS - bootstrap_plant_started))
  check "input-bootstrap-exact-record-status" "${bootstrap_plant_status}:${bootstrap_plant_payload}" "0:planted-input-bootstrap-record"
  check "input-bootstrap-has-one-disarmed-owner" "${#CHILD_PIDS[@]}" "0"
  if (( bootstrap_plant_elapsed <= INPUT_BOOTSTRAP_WAIT_SECONDS + 2 )); then
    emit "{\"suite\":\"${SUITE}\",\"assertion\":\"input-bootstrap-is-bounded\",\"status\":\"pass\",\"detail\":\"the writer-free bootstrap returned in ${bootstrap_plant_elapsed}s\"}"
  else
    failures=$((failures + 1))
    emit "{\"suite\":\"${SUITE}\",\"assertion\":\"input-bootstrap-is-bounded\",\"status\":\"fail\",\"detail\":\"the writer-free bootstrap took ${bootstrap_plant_elapsed}s\"}"
  fi

  # Drive a KILL refusal after the real secret bootstrap. There is exactly one
  # durable supervisor owner; refusal retains it and a disarmed reaper retires it.
  clear_child_records
  local bootstrap_kill_status=0 bootstrap_kill_started=$SECONDS bootstrap_kill_elapsed
  SIGNAL_KILL_FAILURE_PLANT=1
  run_bounded 1 "$bounded_out" "planted-bootstrap-kill-refusal" sleep 30 || bootstrap_kill_status=$?
  bootstrap_kill_elapsed=$((SECONDS - bootstrap_kill_started))
  local bootstrap_kill_records="${#CHILD_PIDS[@]}"
  SIGNAL_KILL_FAILURE_PLANT=0
  reap_children
  # Keep these two historical record names: the TypeScript adapter requires
  # both, so deleting the former writer/KILL causal boundary cannot false-green.
  check "secret-writer-kill-dispatch-failure-status" "$bootstrap_kill_status" "$EX_CLEANUP_UNPROVEN"
  check "input-bootstrap-kill-dispatch-failure-retains-owner" "$bootstrap_kill_records" "1"
  check "input-bootstrap-kill-dispatch-retry-reaps-owner" \
    "${REAP_SURVIVORS}:${#CHILD_PIDS[@]}" "0:0"
  if (( bootstrap_kill_elapsed <= INPUT_BOOTSTRAP_WAIT_SECONDS + 2 )); then
    emit "{\"suite\":\"${SUITE}\",\"assertion\":\"secret-writer-kill-dispatch-failure-is-bounded\",\"status\":\"pass\",\"detail\":\"the injected KILL refusal returned in ${bootstrap_kill_elapsed}s with its owner retained\"}"
  else
    failures=$((failures + 1))
    emit "{\"suite\":\"${SUITE}\",\"assertion\":\"secret-writer-kill-dispatch-failure-is-bounded\",\"status\":\"fail\",\"detail\":\"the injected KILL refusal took ${bootstrap_kill_elapsed}s\"}"
  fi

  # Input-ready then successful-but-nonsettling KILL. The bootstrap ack is not a
  # cleanup proof; the single supervisor stays owned until a real retry settles.
  clear_child_records
  local stopped_bootstrap_status=0 stopped_bootstrap_records
  SIGNAL_KILL_NO_SETTLE_PLANT=1
  run_bounded 10 "$bounded_out" "planted-stopped-bootstrap" true || stopped_bootstrap_status=$?
  SIGNAL_KILL_NO_SETTLE_PLANT=0
  stopped_bootstrap_records="${#CHILD_PIDS[@]}"
  reap_children
  check "stopped-input-bootstrap-completion-status" "$stopped_bootstrap_status" "$EX_CLEANUP_UNPROVEN"
  check "stopped-input-bootstrap-retains-owner" "$stopped_bootstrap_records" "1"
  check "stopped-input-bootstrap-retry-reaps-owner" \
    "${REAP_SURVIVORS}:${#CHILD_PIDS[@]}" "0:0"

  # The shared dead-listener plant above covers this former writer boundary too:
  # after leader reap, the capability write refused and no numeric seam fired.
  check "departed-bootstrap-refuses-recycled-pid-signal" \
    "$DEAD_LISTENER_WRITE_REFUSAL_OBSERVED" "1"

  # A browser blocked record is buffered as data and produces zero bytes until
  # the post-cleanup publisher is invoked.
  local blocked_plant_dir blocked_capture blocked_before="" blocked_after=""
  blocked_plant_dir="$(mktemp -d "${TMPDIR:-/tmp}/s6-blocked-buffer.XXXXXX" 2>/dev/null)" || blocked_plant_dir=""
  blocked_capture="${blocked_plant_dir}/capture"
  if [[ -n "$blocked_plant_dir" ]]; then
    buffer_browser_blocked "PLANTED_BROWSER_BLOCKED" "plant" >"$blocked_capture"
    [[ -s "$blocked_capture" ]] && blocked_before="emitted" || blocked_before="buffered"
    publish_buffered_browser_blocked >>"$blocked_capture" || true
    grep -qF '"code":"PLANTED_BROWSER_BLOCKED"' "$blocked_capture" 2>/dev/null && \
      blocked_after="published" || blocked_after="missing"
  fi
  check "browser-blocked-record-is-buffered" "$blocked_before" "buffered"
  check "browser-blocked-record-publishes-after-cleanup-hook" "$blocked_after" "published"

  # Execute the production runner's pure terminal selector in a separate Bun
  # process. This proves the blocked+teardown polarity without importing the
  # Playwright runner into Bun's own test process, which perturbs nested capture
  # descriptors on the affected runtime.
  clear_child_records
  local selector_dir selector_out selector_status=0 selector_record=""
  selector_dir="$(mktemp -d "${TMPDIR:-/tmp}/s6-runner-selector.XXXXXX" 2>/dev/null)" || selector_dir=""
  selector_out="${selector_dir}/result"
  if [[ -n "$selector_dir" ]]; then
    minimal_env_command bun "$PLAYWRIGHT_RUNNER" --self-test-terminal-selector
    run_bounded 15 "$selector_out" - "${MINIMAL_CMD[@]}" || selector_status=$?
  else
    selector_status="$EX_WATCHDOG_UNAVAILABLE"
  fi
  [[ -f "$selector_out" ]] && selector_record="$(cat "$selector_out" 2>/dev/null || printf '')"
  check "blocked-runner-teardown-selector-status" "$selector_status" "0"
  if [[ "$selector_record" == *'"assertion":"blocked-runner-teardown-failure-overrides","status":"pass"'* ]]; then
    emit "{\"suite\":\"${SUITE}\",\"assertion\":\"blocked-runner-teardown-failure-overrides\",\"status\":\"pass\",\"detail\":\"self-test\"}"
  else
    failures=$((failures + 1))
    emit "{\"suite\":\"${SUITE}\",\"assertion\":\"blocked-runner-teardown-failure-overrides\",\"status\":\"fail\",\"detail\":\"the runner selector did not publish its causal pass record\"}"
  fi
  if [[ "$selector_record" == *'"assertion":"runner-deadline-race-overrides-pass","status":"pass"'* ]]; then
    emit "{\"suite\":\"${SUITE}\",\"assertion\":\"runner-deadline-race-overrides-pass\",\"status\":\"pass\",\"detail\":\"self-test\"}"
  else
    failures=$((failures + 1))
    emit "{\"suite\":\"${SUITE}\",\"assertion\":\"runner-deadline-race-overrides-pass\",\"status\":\"fail\",\"detail\":\"the runner selector did not publish its deadline-race pass record\"}"
  fi

  # Causal descendant plants.
  #
  # An earlier revision read the marker as `[[ -n "$pid" ]] && kill -0 …`, so a
  # marker that was never written fell straight through to the pass branch: the
  # plant reported success precisely when it had failed to plant anything. Every
  # plant below demands an exact numeric pid AND proves it alive before cleanup.

  # Freshly allocated, never reused, never deleted.
  #
  # An earlier revision cleared markers with `rm -f`, which AGENTS.md Rule 1
  # forbids outright. Each marker is instead a new path from a monotonic
  # counter, and `noclobber` refuses to open one that somehow already exists —
  # so a stale file becomes a loud failure rather than a silently reused value.
  new_marker() {
    # `mktemp -d` allocates atomically: the kernel creates the directory or the
    # call fails, so two plants can never be handed the same path and a stale
    # file can never be silently reused. A predictable name plus an `-e` test
    # would be a check-then-use race, not an allocation. Retained, never deleted.
    local dir
    dir="$(mktemp -d "${TMPDIR:-/tmp}/s6-marker-$1.XXXXXX" 2>/dev/null)" || {
      failures=$((failures + 1))
      emit "{\"suite\":\"${SUITE}\",\"assertion\":\"marker-allocation\",\"status\":\"fail\",\"detail\":\"could not allocate a private marker directory\"}"
      return 1
    }
    chmod 700 "$dir" 2>/dev/null || true
    printf '%s' "${dir}/marker"
  }

  # Wait until a marker holds a numeric pid, then echo it. Empty on timeout.
  local plant_pid=""
  await_planted_pid() {
    local marker="$1" waited=0
    plant_pid=""
    while (( waited < 50 )); do
      if [[ -f "$marker" ]]; then
        plant_pid="$(cat "$marker" 2>/dev/null || printf '')"
        [[ "$plant_pid" =~ ^[0-9]+$ ]] && return 0
      fi
      sleep 0.1
      waited=$((waited + 1))
    done
    plant_pid=""
    return 1
  }

  # $1 assertion name, $2 the pid that had to be live beforehand, $3 a
  # descendant-owned TERM acknowledgement. No numeric identity is used after
  # cleanup has reaped the leaders.
  judge_plant() {
    local name="$1" child="$2" terminated="$3" acknowledgement=""
    if [[ ! "$child" =~ ^[0-9]+$ ]]; then
      failures=$((failures + 1))
      emit "{\"suite\":\"${SUITE}\",\"assertion\":\"${name}\",\"status\":\"fail\",\"detail\":\"no numeric descendant pid was planted, so the plant proved nothing\"}"
      return 0
    fi
    [[ -f "$terminated" ]] && acknowledgement="$(cat "$terminated" 2>/dev/null || printf '')"
    if [[ "$acknowledgement" != "term-observed" ]]; then
      failures=$((failures + 1))
      emit "{\"suite\":\"${SUITE}\",\"assertion\":\"${name}\",\"status\":\"fail\",\"detail\":\"the proven-live descendant published no TERM acknowledgement\"}"
    else
      emit "{\"suite\":\"${SUITE}\",\"assertion\":\"${name}\",\"status\":\"pass\",\"detail\":\"self-test\"}"
    fi
  }

  clear_child_records
  local marker group_terminated
  marker="$(new_marker "group")" || marker=""
  group_terminated="$(new_marker "group-terminated")" || group_terminated=""
  # shellcheck disable=SC2016 # The inner shell expands its own arguments.
  run_bounded 10 "$bounded_out" - \
    bash -c 'bash "$1" --self-test-ack-victim "$2" "$3" & wait' \
    _ "$SCRIPT_SELF" "$marker" "$group_terminated" || true
  local grandchild=""
  if await_planted_pid "$marker"; then
    grandchild="$plant_pid"
  fi
  if [[ -z "$grandchild" ]]; then
    failures=$((failures + 1))
    emit "{\"suite\":\"${SUITE}\",\"assertion\":\"reaper-kills-descendants\",\"status\":\"fail\",\"detail\":\"the descendant was never live before the reap, so the plant proved nothing\"}"
  else
    judge_plant "reaper-kills-descendants" "$grandchild" "$group_terminated"
  fi

  # Causal: run_bounded must register its pid in the PARENT shell. If the call
  # were wrapped in `$( )` the append would land in a dead subshell and this
  # array would still be empty — the exact defect that left the EXIT trap with
  # nothing to reap.
  # WHAT IS DELIBERATELY NOT ASSERTED HERE.
  #
  # An earlier version backgrounded `run_bounded` so it could watch the array
  # mid-flight. That put the very mutation under test inside a subshell and then
  # asserted only the parent's post-reap count, which says nothing about the
  # foreground production call — a false claim, so it is removed rather than
  # reworded. The foreground property is pinned statically instead, by the suite
  # assertion that no call site wraps `run_bounded`, `mint_envelope_config` or
  # `http_request` in a command substitution. What follows is what can be proven
  # causally in-process.

  # Directly: a registered pid is dropped once its reap is proven.
  clear_child_records
  true &
  local reg_victim=$!
  register_selftest_child "$reg_victim"
  local armed="${#CHILD_PIDS[@]}"
  settle_selftest_child "registered-child-bounded-settlement" "$reg_victim" || true
  check "child-record-armed-then-disarmed" "${armed}:${#CHILD_PIDS[@]}" "1:0"

  # Negative: unregister must remove ONLY the exact numeric pid. A value with
  # glob or regex characters must not match, and must not remove a real entry.
  clear_child_records
  CHILD_PIDS=(101 102 103)
  CHILD_OWNER_TOKENS=(a b c)
  CHILD_KINDS=(ordinary ordinary ordinary)
  unregister_child "10*"
  local glob_kept="${#CHILD_PIDS[@]}"
  unregister_child "102"
  check "unregister-is-exact-not-glob" "${glob_kept}:${#CHILD_PIDS[@]}" "3:2"

  # Causal: a descendant must be swept on the ORDINARY exit path too. The direct
  # child exits at once and leaves a sleeper behind; waiting on the direct pid
  # alone would call that a clean run.
  # A descendant left behind by a clean exit, a failing exit, and a timeout. In
  # each case the sleeper is proven live before the sweep, so a plant that never
  # armed is a failure rather than a quiet pass.
  #
  # `run_bounded` is run in the FOREGROUND here, exactly as production calls it.
  # Backgrounding the plant would put all parent-side ownership mutations in a
  # throwaway subshell and the real EXIT trap would retain no capability record.
  #
  # Liveness is therefore proven by the CHILD, which only writes the marker once
  # it has confirmed its own descendant is running. A marker holding a numeric
  # pid is thus evidence the sleeper was alive while the group was intact.
  #
  # $1 assertion name, $2 the trailing statement for the child, $3 the bound.
  sweep_plant() {
    local name="$1" trailer="$2" bound="$3"
    local marker terminated
    marker="$(new_marker "sweep-${name}")" || return 0
    terminated="$(new_marker "sweep-${name}-terminated")" || return 0
    clear_child_records
    # The descendant owns its TERM acknowledgement. The PID marker is written
    # only after that trap is installed, so the plant has a causal readiness
    # barrier but never probes or signals the number after cleanup.
    run_bounded "$bound" "$bounded_out" - \
      bash -c "bash \"\$1\" --self-test-ack-victim \"\$2\" \"\$3\" & waited=0; while [[ ! -f \"\$2\" && \$waited -lt 100 ]]; do sleep 0.02; waited=\$((waited + 1)); done; ${trailer}" \
      _ "$SCRIPT_SELF" "$marker" "$terminated" || true
    local child=""
    [[ -f "$marker" ]] && child="$(cat "$marker" 2>/dev/null || printf '')"
    judge_plant "$name" "$child" "$terminated"
  }

  sweep_plant "normal-exit-sweeps-group" "exit 0" 10
  sweep_plant "error-exit-sweeps-group" "exit 9" 10
  sweep_plant "timeout-sweeps-group" "sleep 45" 1

  # Causal: the TERM trap must reap a live descendant. A nested instance holds a
  # sleeper and waits; signalling it exercises on_signal against a real group.
  local signal_marker signal_terminated
  signal_marker="$(new_marker "signal")" || signal_marker=""
  signal_terminated="$(new_marker "signal-terminated")" || signal_terminated=""
  bash "$SCRIPT_SELF" --self-test-signal-victim "$signal_marker" "$signal_terminated" >/dev/null 2>&1 &
  local victim=$!
  register_selftest_child "$victim"
  local signal_child=""
  if await_planted_pid "$signal_marker" && kill -0 "$plant_pid" 2>/dev/null; then
    signal_child="$plant_pid"
  fi
  kill -TERM "$victim" 2>/dev/null || true
  settle_selftest_child "term-signal-victim-bounded-settlement" "$victim" || true
  judge_plant "term-signal-reaps-descendants" "$signal_child" "$signal_terminated"

  # Planted: while a child is HELD past exec, no secret may appear in the argv of
  # the launcher or anything it spawned.
  #
  # This drives `scrubbed_child_command` — the exact helper production uses — so
  # a regression back to `env -i NAME=secret` fails here. A plant that built its
  # own `bash -c` stand-in would keep passing while the real launcher leaked.
  #
  # The child is held at a deterministic barrier: it writes its pid, then waits
  # for a release file the parent creates, so the inspection cannot race the
  # exec. Nothing is deleted; every path is freshly allocated.
  #
  # $1 assertion name, $2 expected ("clean"|"leaks"), $3 mode:
  #   real   — build the launch argv with the PRODUCTION helper
  #   unsafe — the rejected `env -i NAME=secret` shape, as a detection control
  argv_plant() {
    local name="$1" expect="$2" mode="$3"
    local hold release verdict="unknown"
    hold="$(new_marker "argv-hold")" || return 0
    release="$(new_marker "argv-release")" || return 0
    # The held command: announce, then block until released.
    # shellcheck disable=SC2016 # The inner bash expands $$ , $1 and $2.
    local barrier='printf "%s" "$$" > "$1"; while [ ! -e "$2" ]; do sleep 0.05; done'
    local -a launch=()
    if [[ "$mode" == "real" ]]; then
      # The exact array production runs. A hard-coded replica here would stay
      # green after the real helper regressed, which is the whole risk.
      # shellcheck disable=SC2016 # The inner bash expands $$ , $1 and $2.
      minimal_env_command bash -c "$barrier" _ "$hold" "$release"
      launch=("${MINIMAL_CMD[@]}")
    else
      # shellcheck disable=SC2016 # The inner bash expands $$ , $1 and $2.
      launch=(env -i "PATH=$PATH"
        "ASIMP_S6_SIGNING_KEY_HEX=planted-key-canary-0123456789abcdef"
        bash -c "$barrier" _ "$hold" "$release")
    fi
    # The decisive check is the CONSTRUCTED argv, not a live process.
    # `env -i NAME=secret cmd` execs immediately and its argv is replaced by the
    # target's, so any post-exec `ps` sees a clean command line while the secret
    # was still exposed between fork and exec. Inspecting the array closes that
    # window and is deterministic rather than a race.
    local element
    for element in "${launch[@]}"; do
      if [[ "$element" == *"planted-key-canary"* || "$element" == *"planted-pass-canary"* ]]; then
        verdict="leaks"
        break
      fi
    done

    clear_child_records
    ASIMP_S6_SIGNING_KEY_HEX="planted-key-canary-0123456789abcdef" \
    ASIMP_S6_TEST_GOOGLE_PASS="planted-pass-canary-0123456789abcdef" \
      "${launch[@]}" &
    local launcher=$!
    register_selftest_child "$launcher"
    # Defence in depth: with the child HELD past exec, nothing in its group may
    # show a canary either. This cannot replace the array check above — it runs
    # after exec — but it catches a launcher that keeps a secret in a live argv.
    if await_planted_pid "$hold"; then
      local argv_text
      argv_text="$(ps -o args= -g "$launcher" 2>/dev/null || printf '')"
      argv_text="${argv_text}$(ps -o args= -p "$launcher" 2>/dev/null || printf '')"
      argv_text="${argv_text}$(ps -o args= -p "$plant_pid" 2>/dev/null || printf '')"
      if [[ "$argv_text" == *"planted-key-canary"* || "$argv_text" == *"planted-pass-canary"* ]]; then
        verdict="leaks"
      elif [[ "$verdict" != "leaks" ]]; then
        verdict="clean"
      fi
    fi
    printf 'go' > "$release"
    settle_selftest_child "${name}-bounded-settlement" "$launcher" || true
    check "$name" "$verdict" "$expect"
  }

  # Causal: the envelope transport must leave no bytes on disk, and the leak
  # scan must not hang on the FIFO it uses.
  #
  # A stand-in shim emits an exact fake signature through the same FIFO
  # rendezvous the real minter uses. After a successful read the canary must be
  # absent from every retained regular file: a transport that persisted the
  # envelope would leave a reusable credential behind.
  local fifo_probe_dir fifo_probe transport_value="" transport_verdict="unknown"
  fifo_probe_dir="$(mktemp -d "${TMPDIR:-/tmp}/s6-fifo-probe.XXXXXX" 2>/dev/null)" || fifo_probe_dir=""
  if [[ -n "$fifo_probe_dir" ]]; then
    chmod 700 "$fifo_probe_dir" 2>/dev/null || true
    fifo_probe="${fifo_probe_dir}/envelope"
    if mkfifo -m 600 "$fifo_probe" 2>/dev/null; then
      # The SAME two-descriptor protocol production uses: RDWR guard so the
      # read end can be opened, dedicated reader, guard dropped after the child
      # so EOF is reachable. A probe that used a single fd would pass while
      # production hung.
      exec 9<>"$fifo_probe"
      exec 8<"$fifo_probe"
      clear_child_records
      # Launched through the production launcher, exactly as the minter is.
      minimal_env_command \
        bash -c 'printf "%s\n" "header = \"asimp-service-envelope: {\\\"signature\\\":\\\"FAKE-SIGNATURE-CANARY-abcdef0123456789\\\"}\""'
      run_bounded 10 "$fifo_probe" - "${MINIMAL_CMD[@]}" || true
      exec 9>&-
      IFS= read -r -t 10 transport_value <&8 || transport_value=""
      exec 8<&-
      if [[ "$transport_value" == *"FAKE-SIGNATURE-CANARY"* ]]; then
        # The value crossed the rendezvous; now prove it is nowhere on disk.
        # `-type f` is what keeps this scan from opening the FIFO and blocking.
        if scan_regular_files_for "FAKE-SIGNATURE-CANARY" \
          "$fifo_probe_dir" "${RUN_STATE_DIR:-$fifo_probe_dir}"; then
          transport_verdict="persisted"
        else
          transport_verdict="ephemeral"
        fi
      else
        transport_verdict="not-delivered"
      fi
    fi
  fi
  check "envelope-transport-leaves-no-bytes" "$transport_verdict" "ephemeral"

  # Causal: the bounded scan must terminate even with a FIFO present and no
  # writer. A recursive grep would open it and block forever, hanging `finish`.
  local scan_started=$SECONDS scan_elapsed
  if [[ -n "$fifo_probe_dir" ]]; then
    scan_regular_files_for "never-present-canary" "$fifo_probe_dir" || true
  fi
  scan_elapsed=$((SECONDS - scan_started))
  if (( scan_elapsed <= 5 )); then
    emit "{\"suite\":\"${SUITE}\",\"assertion\":\"leak-scan-cannot-block-on-fifo\",\"status\":\"pass\",\"detail\":\"the bounded scan returned in ${scan_elapsed}s with a writerless FIFO present\"}"
  else
    failures=$((failures + 1))
    emit "{\"suite\":\"${SUITE}\",\"assertion\":\"leak-scan-cannot-block-on-fifo\",\"status\":\"fail\",\"detail\":\"the scan took ${scan_elapsed}s; it is opening special files\"}"
  fi

  # Causal: the ACTUAL generated shim must be valid and must mint.
  #
  # Nothing previously executed the file `write_envelope_shim` writes — the
  # transport probe used a `bash -c printf` stand-in — so a malformed heredoc
  # (a duplicated opener putting a `cat …` line at the top of the .mjs, say)
  # would have survived every green run and failed only on the live path. This
  # generates the real file and drives the real `mint_envelope_config` with a
  # throwaway key, which also exercises the stdin secret record and the EOF
  # protocol end to end.
  local shim_dir shim_verdict="unknown" shim_first=""
  shim_dir="$(mktemp -d "${TMPDIR:-/tmp}/s6-shim-probe.XXXXXX" 2>/dev/null)" || shim_dir=""
  if [[ -n "$shim_dir" ]]; then
    chmod 700 "$shim_dir" 2>/dev/null || true
    RUN_STATE_DIR="$shim_dir"
    write_envelope_shim
    if [[ -f "${shim_dir}/mint-envelope.mjs" ]]; then
      shim_first="$(head -1 "${shim_dir}/mint-envelope.mjs")"
      # The first line must be JS, never a leaked shell line. Asserted by shape
      # rather than an exact string: pinning one literal made an ordinary import
      # change look like the heredoc defect this is meant to catch (a duplicated
      # opener putting a `cat … <<SHIM` line at the top of the .mjs).
      if [[ "$shim_first" == import\ * && "$shim_first" != *"<<SHIM"* && "$shim_first" != cat\ * ]]; then
        clear_child_records
        # TWO real mints through the real FIFO transport. The second proves the
        # signature array grows per mint rather than only holding the latest —
        # deleting the extraction/append inside `mint_envelope_config` fails here.
        local sig_before="${#MINTED_SIGNATURES[@]}" mint_ok=1
        local selftest_key
        selftest_key="$(printf '1%.0s' {1..64})"
        for _ in 1 2; do
          if ! ASIMP_S6_SIGNING_KEY_HEX="$selftest_key" \
             ASIMP_S6_SIGNING_KID="s6-selftest" \
             mint_envelope_config GET "$ROUTE_PROPOSALS" "$ACTION_PROPOSALS" usr_selftest ""; then
            mint_ok=0
            break
          fi
        done
        if (( mint_ok == 0 )); then
          shim_verdict="did-not-mint"
        else
          case "$MINTED_CONFIG" in
            'header = "asimp-service-envelope: {'*) shim_verdict="mints" ;;
            *) shim_verdict="malformed-output" ;;
          esac
        fi
        local sig_delta=$(( ${#MINTED_SIGNATURES[@]} - sig_before ))
        local sig_a="" sig_b=""
        if (( ${#MINTED_SIGNATURES[@]} >= 2 )); then
          sig_a="${MINTED_SIGNATURES[$(( ${#MINTED_SIGNATURES[@]} - 2 ))]}"
          sig_b="${MINTED_SIGNATURES[$(( ${#MINTED_SIGNATURES[@]} - 1 ))]}"
        fi
        check "every-minted-signature-retained" "$sig_delta" "2"
        if [[ -n "$sig_a" && -n "$sig_b" && "$sig_a" != "$sig_b" ]]; then
          emit "{\"suite\":\"${SUITE}\",\"assertion\":\"retained-signatures-are-distinct\",\"status\":\"pass\",\"detail\":\"self-test\"}"
        else
          failures=$((failures + 1))
          emit "{\"suite\":\"${SUITE}\",\"assertion\":\"retained-signatures-are-distinct\",\"status\":\"fail\",\"detail\":\"two mints did not yield two distinct non-empty signatures\"}"
        fi
        # Run the ACTUAL canary while RUN_STATE_DIR is still this shim dir: the
        # signatures must be scannable and must NOT be found on disk.
        local failures_before_scan="$FAILURES"
        assert_no_secret_escaped
        check "retained-signatures-not-on-disk" "$FAILURES" "$failures_before_scan"
      else
        shim_verdict="not-javascript"
      fi
    else
      shim_verdict="not-generated"
    fi
    RUN_STATE_DIR=""
  fi
  check "generated-shim-executes-and-mints" "$shim_verdict" "mints"

  # Causal: a child that prints a convincing result and then FAILS must not be
  # treated as evidence. `run_bounded` must surface the exact nonzero status so
  # the caller discards the output rather than greening on it.
  clear_child_records
  local liar_status=0
  run_bounded 1 "$bounded_out" - \
    bash -c 'printf "%s\n" "{\"suite\":\"s6-cross-plane-browser\",\"status\":\"pass\"}"; sleep 45' \
    || liar_status=$?
  check "convincing-output-then-timeout-is-not-success" "$liar_status" "124"

  clear_child_records
  local liar2_status=0
  run_bounded 10 "$bounded_out" - \
    bash -c 'printf "%s\n" "{\"suite\":\"s6-cross-plane-browser\",\"status\":\"pass\"}"; exit 3' \
    || liar2_status=$?
  check "convincing-output-then-failure-is-not-success" "$liar2_status" "3"

  # (A) Causal: a REAL held helper must not be able to SEE the S6 secrets.
  #
  # macOS `ps -E` / `ps eww` cannot read another process's environ at all — the
  # control below caught that observer being blind — so the helper reports on its
  # OWN environment, the only reliable observation available here. It writes a
  # COUNT, never the values, so nothing secret reaches disk.
  #
  # The suite launches this self-test with the ambient S6 variables REMOVED and
  # canaries planted in their place, so `main`'s `export -n` is the only reason
  # the count can be zero. Deleting that line makes this fail.
  #
  # $1 assertion, $2 pattern to count, $3 expected verdict, $4 optional export.
  environ_plant() {
    local name="$1" pattern="$2" expected="$3" extra_export="${4:-}"
    local hold count_file release verdict="unknown"
    hold="$(new_marker "environ-hold")" || return 0
    release="$(new_marker "environ-release")" || return 0
    count_file="${hold}.count"
    local body
    # shellcheck disable=SC2016 # The inner sh expands these, not this shell.
    body='printf "%s" "$$" >"$1"; env | grep -c "$4" >"$2" 2>/dev/null || printf 0 >"$2"; while [ ! -e "$3" ]; do sleep 0.05; done'
    if [[ -n "$extra_export" ]]; then
      # shellcheck disable=SC2016 # The inner sh expands $$ and $1..$4, not this shell.
      env "S6_CTL_CANARY=${extra_export}" /bin/sh -c "$body" _ "$hold" "$count_file" "$release" "$pattern" &
    else
      # shellcheck disable=SC2016 # The inner sh expands $$ and $1..$4, not this shell.
      /bin/sh -c "$body" _ "$hold" "$count_file" "$release" "$pattern" &
    fi
    local helper=$!
    register_selftest_child "$helper"
    await_planted_pid "$hold" || true
    local observed="" waited=0
    while (( waited < 40 )); do
      [[ -s "$count_file" ]] && observed="$(cat "$count_file" 2>/dev/null || printf '')"
      [[ "$observed" =~ ^[0-9]+$ ]] && break
      sleep 0.1
      waited=$((waited + 1))
    done
    printf 'go' > "$release"
    settle_selftest_child "${name}-bounded-settlement" "$helper" || true
    if [[ "$observed" =~ ^[0-9]+$ ]]; then
      if (( observed == 0 )); then verdict="absent"; else verdict="present"; fi
    fi
    check "$name" "$verdict" "$expected"
  }

  # The planted secrets must be invisible to an ordinary helper.
  environ_plant "real-helper-environ-has-no-secret" "planted-selftest" "absent"
  # Observer-positive control: an explicitly EXPORTED canary must be visible, or
  # "absent" above could simply mean the helper cannot read its own environment.
  environ_plant "environ-inspection-observes-an-export" "planted-observer-canary" \
    "present" "planted-observer-canary"

  # (B) Causal: the REAL scanner's grep must never carry the needle in argv.
  #
  # `SCAN_GREP` is pointed at a wrapper that announces its pid, waits, then
  # execs the real grep — so the argv inspected is the one the production
  # function actually built. Reverting to `grep -qF -- "$needle"` fails this.
  local scan_dir scan_wrapper scan_hold scan_release scan_verdict="unknown"
  local scan_ctl_verdict="unknown" saved_scan_grep="$SCAN_GREP"
  scan_dir="$(mktemp -d "${TMPDIR:-/tmp}/s6-scanseam.XXXXXX" 2>/dev/null)" || scan_dir=""
  if [[ -n "$scan_dir" ]]; then
    scan_hold="$(new_marker "scan-hold")" || scan_hold=""
    scan_release="$(new_marker "scan-release")" || scan_release=""
    scan_wrapper="${scan_dir}/grep-wrapper"
    # shellcheck disable=SC2016 # The wrapper expands these at run time.
    printf '%s\n' '#!/bin/sh' \
      'printf "%s" "$$" > "$S6_SCAN_HOLD"' \
      'while [ ! -e "$S6_SCAN_RELEASE" ]; do sleep 0.05; done' \
      'exec /usr/bin/grep "$@"' > "$scan_wrapper"
    chmod 700 "$scan_wrapper"
    printf 'nothing-here\n' > "${scan_dir}/target"
    if [[ -n "$scan_hold" && -n "$scan_release" ]]; then
      SCAN_GREP="$scan_wrapper"
      S6_SCAN_HOLD="$scan_hold" S6_SCAN_RELEASE="$scan_release" \
        scan_regular_files_for "planted-needle-canary" "$scan_dir" &
      local scan_runner=$!
      register_selftest_child "$scan_runner"
      if await_planted_pid "$scan_hold"; then
        local scan_argv
        scan_argv="$(/bin/ps -o args= -p "$plant_pid" 2>/dev/null || printf '')"
        if [[ "$scan_argv" == *"planted-needle-canary"* ]]; then
          scan_verdict="leaks"
        elif [[ -n "$scan_argv" ]]; then
          scan_verdict="clean"
        fi
      fi
      printf 'go' > "$scan_release"
      settle_selftest_child "scan-runner-bounded-settlement" "$scan_runner" || true
      SCAN_GREP="$saved_scan_grep"
    fi
    # Unsafe control: the same inspection must SEE a needle placed in argv.
    local ctl_argv_hold ctl_argv_release
    ctl_argv_hold="$(new_marker "scan-ctl-hold")" || ctl_argv_hold=""
    ctl_argv_release="$(new_marker "scan-ctl-release")" || ctl_argv_release=""
    if [[ -n "$ctl_argv_hold" && -n "$ctl_argv_release" ]]; then
      S6_SCAN_HOLD="$ctl_argv_hold" S6_SCAN_RELEASE="$ctl_argv_release" \
        "$scan_wrapper" -qF -- "planted-needle-canary" "${scan_dir}/target" &
      local ctl_scan=$!
      register_selftest_child "$ctl_scan"
      if await_planted_pid "$ctl_argv_hold"; then
        local ctl_scan_argv
        ctl_scan_argv="$(/bin/ps -o args= -p "$plant_pid" 2>/dev/null || printf '')"
        if [[ "$ctl_scan_argv" == *"planted-needle-canary"* ]]; then
          scan_ctl_verdict="leaks"
        elif [[ -n "$ctl_scan_argv" ]]; then
          scan_ctl_verdict="clean"
        fi
      fi
      printf 'go' > "$ctl_argv_release"
      settle_selftest_child "scan-control-bounded-settlement" "$ctl_scan" || true
    fi
  fi
  check "leak-scan-needle-not-in-argv" "$scan_verdict" "clean"
  check "argv-inspection-observes-a-needle" "$scan_ctl_verdict" "leaks"

  # The three causal proofs above are IMPLEMENTED, each with a working control.
  #
  # A first attempt at all three was removed because each proved nothing and one
  # hung the suite. What replaced them, and why each control matters:
  #
  #   * `real-helper-environ-has-no-secret` — the suite launches this self-test
  #     with the ambient S6 variables removed and canaries planted, so `export -n`
  #     is the only reason a held helper reads none of them. The helper reports on
  #     its OWN environ, because `environ-inspection-observes-an-export` proved
  #     that macOS `ps -E` cannot read another process's environment at all.
  #   * `leak-scan-needle-not-in-argv` — drives the real
  #     `scan_regular_files_for` through the `SCAN_GREP` seam pointed at a held
  #     wrapper, so the argv inspected is the one production built.
  #     `argv-inspection-observes-a-needle` proves the inspection can see a leak.
  #   * `every-minted-signature-retained` / `retained-signatures-are-distinct` /
  #     `retained-signatures-not-on-disk` — two real mints through the real FIFO,
  #     then the actual canary with `RUN_STATE_DIR` still set.
  #
  # What remains genuinely unproven is NOT in this list: containment of this
  # script's nested process groups when an outer harness hard-kills only the
  # group it leads. That is reported as cleanup-unproven, never as contained.

  # The production launcher itself must be clean.
  argv_plant "no-secret-in-child-argv" "clean" real

  # Control: the rejected `env -i NAME=secret` shape must be DETECTED as leaking.
  # Without it, "clean" could simply mean the inspection sees nothing at all.
  argv_plant "argv-inspection-detects-a-leak" "leaks" unsafe

  # Planted: the ACTUAL launcher must produce a minimal environment.
  #
  # A sentinel is exported in the parent and must be absent from the child's own
  # `env` after exec. This drives `minimal_env_command`, so the rejected
  # `bash -c 'unset X; exec …'` shape — where the intermediate shell inherits
  # every secret and only unsets after startup — fails here.
  minimal_env_command /usr/bin/env
  local env_seen
  env_seen="$(
    ASIMP_S6_FELLOW_TOKEN=planted-bearer-canary \
    ASIMP_S6_SIGNING_KEY_HEX=planted-key-canary \
    ASIMP_S6_TEST_GOOGLE_PASS=planted-pass-canary \
      "${MINIMAL_CMD[@]}" 2>/dev/null | grep -c 'planted-bearer-canary\|planted-key-canary\|planted-pass-canary' || true
  )"
  check "child-environment-scrubbed" "$env_seen" "0"

  # Control: the inherit-then-unset shape must be DETECTED as leaking at exec.
  # Without it, a zero above could just mean the sentinel was never exported.
  local inherit_seen
  inherit_seen="$(
    ASIMP_S6_FELLOW_TOKEN=planted-bearer-canary \
      bash -c 'exec /usr/bin/env' 2>/dev/null | grep -c 'planted-bearer-canary' || true
  )"
  check "env-inspection-detects-inheritance" "$inherit_seen" "1"

  CLEANED_UP=1
  if (( failures > 0 )); then
    emit "{\"suite\":\"${SUITE}\",\"status\":\"fail\",\"self_test\":true,\"failures\":${failures}}"
    exit "$EX_FAIL"
  fi
  emit "{\"suite\":\"${SUITE}\",\"status\":\"self_test_complete\",\"self_test\":true,\"failures\":0}"
  exit 0
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  # FIRST BUILT-IN STEP, before any external helper runs.
  #
  # The operator hands these in as exported variables, so until this line every
  # `mktemp`, `chmod`, `sleep`, `grep`, `find` and `stat` this script runs would
  # inherit the Google password, the Fellow bearer and the signing seed in its
  # own environ — regardless of how carefully the product children are launched.
  # `export -n` drops the export attribute while KEEPING the shell value, so the
  # script can still use them and no descendant can read them.
  #
  # The Google user is included: it identifies a real account and is treated as
  # private here even though it is not a credential.
  export -n ASIMP_S6_TEST_GOOGLE_PASS 2>/dev/null || true
  export -n ASIMP_S6_TEST_GOOGLE_USER 2>/dev/null || true
  export -n ASIMP_S6_FELLOW_TOKEN 2>/dev/null || true
  export -n ASIMP_S6_SIGNING_KEY_HEX 2>/dev/null || true

  # Hidden stopped child for successful-dispatch/no-settlement plants. It owns
  # its readiness marker and stops itself only after publishing the exact pid;
  # the parent never probes that number after cleanup.
  if [[ "${1:-}" == "--self-test-stopped-victim" ]]; then
    local stopped_marker="${2:?stopped marker required}"
    trap '' HUP TERM
    printf '%s' "$BASHPID" > "$stopped_marker"
    kill -STOP "$BASHPID"
    while :; do sleep 3600; done
  fi

  # Hidden acknowledgement child used by cleanup plants. It publishes readiness
  # only after its TERM trap is installed, then owns the termination record; no
  # parent needs to probe or signal its numeric pid after cleanup.
  if [[ "${1:-}" == "--self-test-ack-victim" ]]; then
    local ready_marker="${2:?ready marker required}"
    local terminated_marker="${3:?terminated marker required}"
    local hold_fifo="${ready_marker}.hold"
    trap '' HUP
    trap 'printf term-observed > "$terminated_marker"; exit 0' TERM
    mkfifo -m 600 "$hold_fifo" || exit "$EX_FAIL"
    # A builtin read keeps the acknowledgement shell itself interruptible. A
    # foreground `sleep` would enter a fresh job-control group and defer Bash's
    # TERM trap until the sleep ended, making the plant measure that unrelated
    # child rather than the group signal under test.
    exec 6<>"$hold_fifo" || exit "$EX_FAIL"
    printf '%s' "$BASHPID" > "$ready_marker"
    while :; do IFS= read -r -t 3600 _ <&6 || true; done
  fi

  # Hidden hostile-target mode. It receives only a non-secret search root,
  # discovers the result FIFO by name, writes the obsolete unkeyed success
  # record, and then really exits nonzero. A tokenless parser would false-green.
  if [[ "${1:-}" == "--self-test-forge-result" ]]; then
    local search_root="${2:?search root required}" candidate wrote=0
    for candidate in "$search_root"/s6-watchdog.*/result; do
      [[ -p "$candidate" ]] || continue
      if printf 'child:0\n' > "$candidate" 2>/dev/null; then wrote=1; fi
    done
    (( wrote == 1 )) || exit 97
    exit 9
  fi

  # Hidden mode used only by the signal plant: hold a live descendant and wait
  # to be signalled, so the INT/TERM trap can be exercised against a real group.
  if [[ "${1:-}" == "--self-test-signal-victim" ]]; then
    local victim_marker="${2:?marker required}"
    local terminated_marker="${3:?terminated marker required}"
    # Hidden causal mode: its descendant has an interruptible builtin wait and
    # a TERM acknowledgement, so the production five-second grace is unrelated
    # to what this plant proves.
    REAP_GRACE_SECONDS=0.2
    # Foreground the production supervisor. If this shell receives TERM while
    # its bounded read is active, on_signal owns the same nonce channel and
    # retires the descendant group without any direct-child numeric signal.
    run_bounded 45 /dev/null - \
      bash "$SCRIPT_SELF" --self-test-ack-victim "$victim_marker" "$terminated_marker" || true
    exit 0
  fi

  if [[ "${1:-}" == "--self-test" || "${S6_SELF_TEST:-}" == "1" ]]; then
    self_test
  fi

  local missing=()
  while IFS= read -r line; do missing+=("$line"); done < <(missing_vars)

  if (( ${#missing[@]} > 0 )); then
    local csv="" name
    for name in "${missing[@]}"; do csv+="${csv:+,}\"${name}\""; done
    emit_blocked_env_record "$csv"
    log "BLOCKED ${SUITE}: the live spike has no infrastructure to run against."
    log "  missing environment: ${missing[*]}"
    log "  blocked on: a Vercel preview with Auth.js Google credentials, and a deployed"
    log "              Worker with real D1/R2 bindings (OPS.3 environments, W3 Propylon)."
    log "  this script has no offline or fixture mode on purpose: the whole point of S-6"
    log "  is a claim about running infrastructure, and a mock cannot make that claim."
    CLEANED_UP=1
    exit "$EX_CONFIG"
  fi

  valid_https_origin "$ASIMP_S6_PREVIEW_URL" || {
    blocked_record "PREVIEW_ORIGIN_INVALID" "ASIMP_S6_PREVIEW_URL must be an exact https origin"
    CLEANED_UP=1; exit "$EX_CONFIG"
  }
  valid_https_origin "$ASIMP_S6_WORKER_URL" || {
    blocked_record "WORKER_ORIGIN_INVALID" "ASIMP_S6_WORKER_URL must be an exact https origin"
    CLEANED_UP=1; exit "$EX_CONFIG"
  }

  local preview="${ASIMP_S6_PREVIEW_URL%/}" worker="${ASIMP_S6_WORKER_URL%/}"
  local apex_host agent_host
  apex_host="$(origin_host "$preview")"
  agent_host="$(origin_host "$worker")"
  if [[ "$apex_host" == "$agent_host" ]]; then
    blocked_record "PLANES_NOT_SPLIT" "the Agora and Stoa origins resolve to one host"
    CLEANED_UP=1; exit "$EX_CONFIG"
  fi

  RUN_STATE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/s6-cross-plane.XXXXXX")" || {
    blocked_record "STATE_DIR_UNAVAILABLE" "could not create a private run directory"
    CLEANED_UP=1; exit "$EX_CONFIG"
  }
  readonly RUN_STATE_DIR
  chmod 700 "$RUN_STATE_DIR"
  log "${SUITE}: run state at ${RUN_STATE_DIR}"

  command -v bun >/dev/null 2>&1 || {
    blocked_record "BUN_UNAVAILABLE" "the product envelope minter is TypeScript and needs bun on PATH"
    exit "$EX_CONFIG"
  }

  write_envelope_shim
  log "${SUITE}: environment present; running the live spike."

  # The browser leg first: it establishes the cookie evidence and the receipt.
  if ! run_browser_leg "$worker"; then
    # Same publication rule as `finish`: cleanup is proven BEFORE the scan, the
    # evidence and the terminal record. This path used to publish first and reap
    # afterwards in the EXIT trap, so a blocked or failing run could emit
    # immutable evidence and a terminal verdict and only then discover a
    # survivor.
    reap_children
    CLEANED_UP=1
    if (( REAP_SURVIVORS != 0 )); then
      # NOTHING is sealed while a survivor remains: no scan, no evidence
      # artifact, no pass/fail bundle. A fixed typed refusal is the only output,
      # because an immutable record written now would describe a run whose own
      # cleanup is still unresolved.
      blocked_record "CLEANUP_UNPROVEN" "a child process group survived cleanup; no scan, evidence or verdict was sealed"
      log "FAILED ${SUITE}: cleanup could not be proven; nothing was sealed."
      exit "$EX_CLEANUP_UNPROVEN"
    fi
    assert_no_secret_escaped
    write_evidence_bundle
    [[ -n "$EVIDENCE_PATH" ]] && log "${SUITE}: evidence at ${EVIDENCE_PATH}"
    if (( FAILURES > 0 )); then
      emit "{\"suite\":\"${SUITE}\",\"status\":\"fail\",\"assertions\":${ASSERTIONS},\"failures\":${FAILURES},\"reproduce\":\"${REPRODUCE}\"}"
      log "FAILED ${SUITE}: ${FAILURES} of ${ASSERTIONS} assertions failed."
      exit "$EX_FAIL"
    fi
    # The terminal refusal is published only after the reap, survivor verdict,
    # leak scan and evidence write above. A buffered refusal can never outrun a
    # cleanup failure.
    if [[ -n "$BROWSER_BLOCKED_CODE" ]]; then
      publish_buffered_browser_blocked
    fi
    log "BLOCKED ${SUITE}: the browser leg could not run. This is NOT a green S-6."
    exit "$EX_CONFIG"
  fi
  deadline_guard

  assert_worker_accepts_valid_envelope "$worker" "$ASIMP_S6_SPONSOR_ID"; deadline_guard
  assert_replay_refused "$worker"; deadline_guard
  assert_altered_payload_refused "$worker" "$ASIMP_S6_SPONSOR_ID"; deadline_guard
  assert_expired_envelope_refused "$worker" "$ASIMP_S6_SPONSOR_ID"; deadline_guard
  assert_bearer_on_sponsor_route_refused "$worker"; deadline_guard
  assert_cookie_changed_nothing "$worker"; deadline_guard
  assert_receipt_attributed "$worker" "$ASIMP_S6_SPONSOR_ID"

  finish
}

main "$@"
