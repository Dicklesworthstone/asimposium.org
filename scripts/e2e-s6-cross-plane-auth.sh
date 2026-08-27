#!/usr/bin/env bash
# shellcheck disable=SC2016 # Single-quoted programs are expanded by their inner shells.
# S-6 cross-plane auth, live preview spike (historical acceptance-evidence bead
# asimposiumorg-vw3).
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
export -n ASIMP_S6_TEST_GOOGLE_PASS ASIMP_S6_TEST_GOOGLE_USER ASIMP_S6_FELLOW_TOKEN ASIMP_S6_SIGNING_KEY_HEX ASIMP_S6_SIGNING_KID 2>/dev/null || true
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
#   ASIMP_S6_REVISION         lowercase 40- or 64-hex source revision supplied
#                             by the deployment harness; recorded as declared,
#                             because neither live plane exposes revision metadata
#   ASIMP_S6_DEPLOYMENT_ID    non-secret paired-deployment identifier supplied
#                             by the harness and recorded as format-only input
#   ASIMP_S6_EVIDENCE_DIR     must be exactly the repository-local destination
#                             e2e/artifacts/s6-cross-plane-auth
#
# Evidence: a redacted JSON bundle. It records deployment provenance, the
# validator-backed non-secret request/result tuple, cookie assertions and
# latency. Never cookies, OAuth artifacts, bearer tokens, signatures, join
# fragments, payload bodies, screenshots or raw browser traces.

set -u -o pipefail

# The anonymous duplex authority below deliberately uses named `coproc` and
# dynamic descriptor closure. ASImposium invokes this file through
# `#!/usr/bin/env bash`; Bash 4.1 is the explicit minimum. Bash 3 cannot parse
# `coproc` at all, so `/bin/bash -n` on stock macOS is outside the contract and
# cannot reach this typed refusal; the selected interpreter must satisfy it.
bash_version_supported() {
  local major="$1" minor="$2"
  (( major > 4 || (major == 4 && minor >= 1) ))
}
if ! bash_version_supported "${BASH_VERSINFO[0]:-0}" "${BASH_VERSINFO[1]:-0}"; then
  printf '%s\n' '{"suite":"s6-cross-plane-auth","status":"blocked","code":"BASH_VERSION_UNSUPPORTED","detail":"Bash 4.1 or newer is required for anonymous supervisor capabilities"}'
  exit 126
fi

# Job control puts every background job in its own process group. A live
# same-group supervisor receives nonce-bound commands over a private pipe and
# self-signals that group; the parent never targets a numeric pid or pgid.
set -m

readonly SUITE="s6-cross-plane-auth"
readonly EX_CONFIG=78
readonly EX_FAIL=1
# RESERVED LIFECYCLE BAND 124..127 — contiguous by contract, not by accident.
#
# `run_bounded` remaps ANY child exit inside this band to `EX_FAIL` (the
# `status >= 124 && status <= 127` guards below), so a payload can never forge a
# lifecycle outcome; the exact child status stays readable in the typed globals.
#
# Two members collide with shell conventions — 126 "cannot execute" and 127
# "command not found". That is accepted and typed, not overlooked: every branch
# exiting with one of these also emits an NDJSON record carrying its `code` and
# `stage`, and that record, never the bare status, is the disambiguator. A
# harness reading only the exit code cannot tell them apart and must not try.
#
# Do not renumber a single member. The guards are RANGE checks, and the 123/124
# boundary is causally planted, so moving one value silently breaks both.
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

ROOT=""
PLAYWRIGHT_RUNNER=""
# This script's own path, canonicalized only after main has de-exported every
# credential, so the signal plant can run a nested instance from any caller cwd.
SCRIPT_SELF="${BASH_SOURCE[0]}"

initialize_repository_paths() {
  local source_path="$SCRIPT_SELF" source_directory source_name
  if [[ "$source_path" == */* ]]; then
    source_directory="${source_path%/*}"
    source_name="${source_path##*/}"
  else
    source_directory="$PWD"
    source_name="$source_path"
  fi
  [[ "$source_directory" == /* ]] || source_directory="${PWD}/${source_directory}"
  source_directory="$(cd -P -- "$source_directory" && pwd -P)" || return 1
  SCRIPT_SELF="${source_directory}/${source_name}"
  [[ "$source_name" == "e2e-s6-cross-plane-auth.sh" && \
    -f "$SCRIPT_SELF" && ! -L "$SCRIPT_SELF" ]] || return 1
  ROOT="$(cd -P -- "${source_directory}/.." && pwd -P)" || return 1
  [[ "$source_directory" == "${ROOT}/scripts" && \
    -f "${ROOT}/e2e/lib/run-diagnostics.sh" && \
    ! -L "${ROOT}/e2e/lib/run-diagnostics.sh" ]] || return 1
  PLAYWRIGHT_RUNNER="e2e/playwright/s6-cross-plane-runner.ts"
  # shellcheck source=../e2e/lib/run-diagnostics.sh
  source "${ROOT}/e2e/lib/run-diagnostics.sh"
  cd "$ROOT" || return 1
  readonly ROOT PLAYWRIGHT_RUNNER SCRIPT_SELF
}

readonly REQUIRED_VARS=(
  ASIMP_S6_PREVIEW_URL
  ASIMP_S6_WORKER_URL
  ASIMP_S6_TEST_GOOGLE_USER
  ASIMP_S6_TEST_GOOGLE_PASS
  ASIMP_S6_FELLOW_TOKEN
  ASIMP_S6_SIGNING_KEY_HEX
  ASIMP_S6_SIGNING_KID
  ASIMP_S6_SPONSOR_ID
  ASIMP_S6_REVISION
  ASIMP_S6_DEPLOYMENT_ID
  ASIMP_S6_EVIDENCE_DIR
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
HTTP_REQUEST_LATENCY_SECONDS=""
BROWSER_LEG_LATENCY_SECONDS=""
EVIDENCE_COOKIE_ASSERTIONS_VALIDATED=0
EVIDENCE_ENVELOPE_METHOD=""
EVIDENCE_ENVELOPE_ACTION=""
EVIDENCE_ENVELOPE_PAYLOAD_SHA256=""
EVIDENCE_ENVELOPE_PRINCIPAL_PSEUDONYM=""
EVIDENCE_ENVELOPE_ROUTE_TEMPLATE=""
EVIDENCE_ENVELOPE_INITIAL_STATUS=""
EVIDENCE_ENVELOPE_INITIAL_LATENCY_SECONDS=""
EVIDENCE_ENVELOPE_REPLAY_STATUS=""
EVIDENCE_ENVELOPE_REPLAY_CODE=""
EVIDENCE_ENVELOPE_REPLAY_LATENCY_SECONDS=""
S6_ARTIFACT_ROOT_IDENTITY=""
S6_ARTIFACT_NAMESPACE_IDENTITY=""
S6_ARTIFACT_RUN_IDENTITY=""
S6_ARTIFACT_WRITER_LEASE_PATH=""
S6_ARTIFACT_WRITER_LEASE_IDENTITY=""
S6_ARTIFACT_WRITER_LEASE_OWNED=0
S6_RUN_ID=""
S6_RUN_DIRECTORY=""
S6_RUN_RELATIVE_DIRECTORY=""

s6_artifact_writer_boundary_is_open() {
  (( S6_ARTIFACT_WRITER_LEASE_OWNED == 1 )) || return 1
  e2e_artifact_namespaced_run_matches_at_root \
    "$ROOT" "$SUITE" "$S6_RUN_ID" \
    "$S6_ARTIFACT_ROOT_IDENTITY" "$S6_ARTIFACT_NAMESPACE_IDENTITY" \
    "$S6_ARTIFACT_RUN_IDENTITY" "$S6_ARTIFACT_WRITER_LEASE_PATH" \
    "$S6_ARTIFACT_WRITER_LEASE_IDENTITY"
}

s6_claim_artifact_run() {
  (( S6_ARTIFACT_WRITER_LEASE_OWNED == 0 )) || return 1
  S6_RUN_ID="s6-${BASHPID}-${SECONDS}-${RANDOM}${RANDOM}${RANDOM}${RANDOM}"
  e2e_claim_artifact_namespaced_run_at_root "$ROOT" "$SUITE" "$S6_RUN_ID" || return 1
  S6_ARTIFACT_ROOT_IDENTITY="$ASIMPOSIUM_E2E_SELECTED_ARTIFACT_ROOT_IDENTITY"
  S6_ARTIFACT_NAMESPACE_IDENTITY="$ASIMPOSIUM_E2E_SELECTED_ARTIFACT_NAMESPACE_IDENTITY"
  S6_ARTIFACT_RUN_IDENTITY="$ASIMPOSIUM_E2E_SELECTED_RUN_IDENTITY"
  S6_ARTIFACT_WRITER_LEASE_PATH="$ASIMPOSIUM_E2E_SELECTED_LEASE_DIRECTORY"
  S6_ARTIFACT_WRITER_LEASE_IDENTITY="$ASIMPOSIUM_E2E_SELECTED_LEASE_IDENTITY"
  S6_RUN_DIRECTORY="$ASIMPOSIUM_E2E_SELECTED_RUN_DIRECTORY"
  S6_RUN_RELATIVE_DIRECTORY="${ASIMP_S6_EVIDENCE_DIR}/${S6_RUN_ID}"
  S6_ARTIFACT_WRITER_LEASE_OWNED=1
  [[ "$S6_RUN_DIRECTORY" == "${ROOT}/${S6_RUN_RELATIVE_DIRECTORY}" ]] || return 1
  s6_artifact_writer_boundary_is_open
}

s6_close_artifact_writer_lease_after_settlement() {
  (( S6_ARTIFACT_WRITER_LEASE_OWNED == 1 )) || return 0
  (( REAP_SURVIVORS == 0 && ${#CHILD_PIDS[@]} == 0 )) || return 1
  [[ -z "$GROUP_CONTROL_PID" ]] || return 1
  # Closing is not publication. A maintenance fence raised after our claim
  # must stop every later write, but it must not strand an already-settled
  # writer lease and thereby prevent maintenance from ever observing
  # quiescence. The close helper still re-proves the captured lease path and
  # device/inode identity immediately before creating its append-only marker.
  e2e_close_artifact_writer_lease \
    "$S6_ARTIFACT_WRITER_LEASE_PATH" "$S6_ARTIFACT_WRITER_LEASE_IDENTITY" || return 1
  S6_ARTIFACT_WRITER_LEASE_OWNED=0
}

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

SELF_TEST_MODE=0

pass_record() {
  ASSERTIONS=$((ASSERTIONS + 1))
  if (( SELF_TEST_MODE == 1 )); then
    emit "{\"suite\":\"${SUITE}\",\"assertion\":\"$(json_string "$1")\",\"status\":\"pass\",\"detail\":\"$(json_string "$2")\"}"
  else
    emit "{\"suite\":\"${SUITE}\",\"assertion\":\"$(json_string "$1")\",\"status\":\"pass\",\"detail\":\"$(json_string "$2")\",\"reproduce\":\"${REPRODUCE}\"}"
  fi
}

fail_record() {
  ASSERTIONS=$((ASSERTIONS + 1))
  FAILURES=$((FAILURES + 1))
  if (( SELF_TEST_MODE == 1 )); then
    emit "{\"suite\":\"${SUITE}\",\"assertion\":\"$(json_string "$1")\",\"status\":\"fail\",\"detail\":\"$(json_string "$2")\"}"
  else
    emit "{\"suite\":\"${SUITE}\",\"assertion\":\"$(json_string "$1")\",\"status\":\"fail\",\"detail\":\"$(json_string "$2")\",\"reproduce\":\"${REPRODUCE}\"}"
  fi
}

blocked_record() {
  emit "{\"suite\":\"${SUITE}\",\"status\":\"blocked\",\"code\":\"$(json_string "$1")\",\"historical_evidence_bead\":\"asimposiumorg-vw3\",\"detail\":\"$(json_string "$2")\",\"reproduce\":\"${REPRODUCE}\"}"
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
SELF_TEST_BOUNDED_OUT=""
CLEANUP_IN_PROGRESS=0
CLEANUP_SECOND_SIGNAL=0
SIGNAL_CLEANUP_MARKER=""
LIFECYCLE_TERMINAL_PUBLISHED=0
SPAWN_REGISTRATION_ACTIVE=0
LATCHED_SIGNAL=""
SPAWN_REGISTRATION_READY_MARKER=""
SPAWN_REGISTRATION_RELEASE_MARKER=""
SPAWN_HANDOFF_READY_MARKER=""
SPAWN_HANDOFF_RELEASE_MARKER=""
# Set by an outer self-test before it spawns any descendant. Descendants inherit it
# and must never re-enter self_test: without this a child that reaches the self-test
# gate re-runs the whole suite and forks another generation of victims (exponential).
SELF_TEST_NESTED="${S6_SELF_TEST_NESTED:-0}"

# Playwright launches Chromium as a grandchild and the minter can fork, so each
# payload runs beneath a same-group supervisor. The parent never signals a
# numeric pid or pgid. It writes a nonce-bound command to the sole live listener;
# that supervisor self-signals group zero. Once the listener dies, EPIPE closes
# the authority rather than letting a recycled number become a target.
SIGNAL_KILL_FAILURE_PLANT=0
SIGNAL_TERM_FAILURE_PLANT=0
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
GROUP_PROTOCOL_STATE="idle"
GROUP_TERMINAL_SEEN=0
GROUP_ALLOW_CHILD_BEFORE_ACK=0

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
  CHILD_OWNER_TOKENS[index]="$token"
  CHILD_KINDS[index]="$kind"
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

prepare_group_control() {
  local pid="$1" token="$2"
  # FD 6 is the write-only end of the anonymous coprocess pipe. The
  # in-group supervisor owns the only read end, so supervisor death makes writes
  # fail with EPIPE. No RDWR FIFO or parent-side reader can mask that death.
  GROUP_CONTROL_PID="$pid"
  GROUP_CONTROL_TOKEN="$token"
  GROUP_CONTROL_OPEN=1
  GROUP_RESULT_OPEN=1
  GROUP_PENDING_CHILD_RECORD=""
  GROUP_PROTOCOL_STATE="boot"
  GROUP_TERMINAL_SEEN=0
  GROUP_ALLOW_CHILD_BEFORE_ACK=0
}

adopt_group_control() {
  local pid="$1" token="$2" index
  [[ "$GROUP_CONTROL_PID" == "$pid" && "$GROUP_CONTROL_TOKEN" == "$token" ]] || return 1
  child_record_index "$pid" || return 1
  index="$CHILD_RECORD_INDEX"
  [[ "${CHILD_KINDS[$index]:-ordinary}" == "ordinary" ]] || return 1
  CHILD_KINDS[index]="controlled-group"
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
  GROUP_PROTOCOL_STATE="idle"
  GROUP_TERMINAL_SEEN=0
  GROUP_ALLOW_CHILD_BEFORE_ACK=0
}

validate_group_child_record() {
  local record="$1" prefix="child:${GROUP_CONTROL_TOKEN}:" status
  [[ "$record" == "$prefix"* ]] || return 1
  status="${record#"$prefix"}"
  [[ "$status" =~ ^(0|[1-9]|[1-9][0-9]|[1-9][0-9][0-9])$ ]] || return 1
  (( 10#$status <= 255 )) || return 1
}

read_group_exact_until() {
  local expected="$1" deadline="$2" allow_child="${3:-0}" record="" remaining read_status
  GROUP_RECORD=""
  GROUP_RECORD_INVALID=0
  (( GROUP_RESULT_OPEN == 1 )) || return 1
  while (( SECONDS < deadline )); do
    remaining=$((deadline - SECONDS))
    IFS= read -r -t "$remaining" record <&5
    read_status=$?
    if (( read_status != 0 )); then
      if (( SECONDS >= deadline )); then return 142; fi
      return "$read_status"
    fi
    if [[ "$record" == "$expected" ]]; then
      GROUP_RECORD="$record"
      return 0
    fi
    # Exactly one real child terminal may race a requested TERM acknowledgement,
    # but only after the parent has latched its deadline. No readiness/input
    # phase and no later KILL acknowledgement may queue another terminal.
    if (( allow_child == 1 )) && [[ "$GROUP_PROTOCOL_STATE" == "running" || "$GROUP_PROTOCOL_STATE" == "terminal" ]] &&
       (( GROUP_TERMINAL_SEEN == 0 )) && [[ -z "$GROUP_PENDING_CHILD_RECORD" ]] &&
       validate_group_child_record "$record"; then
      GROUP_PENDING_CHILD_RECORD="$record"
      GROUP_TERMINAL_SEEN=1
      GROUP_PROTOCOL_STATE="terminal"
      GROUP_QUEUED_CHILD_RECORDS=$((GROUP_QUEUED_CHILD_RECORDS + 1))
      continue
    fi
    GROUP_RECORD_INVALID=1
    return 2
  done
  return 142
}

read_group_record() {
  local expected="$1" allow_child="${2:-0}"
  read_group_exact_until "$expected" "$((SECONDS + 2))" "$allow_child"
}

read_group_outcome() {
  local seconds="$1" record="" remaining read_status
  local deadline=$((SECONDS + seconds))
  GROUP_RECORD=""
  GROUP_RECORD_INVALID=0
  (( GROUP_RESULT_OPEN == 1 )) || return 1
  [[ "$GROUP_PROTOCOL_STATE" == "running" || "$GROUP_PROTOCOL_STATE" == "terminal" ]] || return 1
  if [[ -n "$GROUP_PENDING_CHILD_RECORD" ]]; then
    GROUP_RECORD="$GROUP_PENDING_CHILD_RECORD"
    GROUP_PENDING_CHILD_RECORD=""
    return 0
  fi
  while (( SECONDS < deadline )); do
    remaining=$((deadline - SECONDS))
    IFS= read -r -t "$remaining" record <&5
    read_status=$?
    if (( read_status != 0 )); then
      if (( SECONDS >= deadline )); then return 142; fi
      return "$read_status"
    fi
    if (( GROUP_TERMINAL_SEEN == 0 )) && validate_group_child_record "$record"; then
      GROUP_TERMINAL_SEEN=1
      GROUP_PROTOCOL_STATE="terminal"
      GROUP_RECORD="$record"
      return 0
    fi
    GROUP_RECORD_INVALID=1
    return 2
  done
  # Reaching the absolute deadline without another read is the same typed
  # timeout as Bash read -t (128 + SIGALRM on supported Bash versions).
  return 142
}

request_group_signal() {
  local pid="$1" signal="$2" index token status expected allow_child=0
  child_record_index "$pid" || return 1
  index="$CHILD_RECORD_INDEX"
  token="${CHILD_OWNER_TOKENS[$index]:-}"
  [[ "${CHILD_KINDS[$index]:-ordinary}" == "controlled-group" ]] || return 1
  [[ "$GROUP_CONTROL_PID" == "$pid" && "$GROUP_CONTROL_TOKEN" == "$token" ]] || return 1
  (( GROUP_CONTROL_OPEN == 1 )) || return 1
  case "$signal" in TERM|KILL|DIE) ;; *) return 1 ;; esac
  case "$signal:$GROUP_PROTOCOL_STATE" in
    TERM:ready|TERM:running|TERM:terminal|KILL:ready|KILL:running|KILL:terminal|DIE:terminal) ;;
    *) return 1 ;;
  esac
  if (( SIGNAL_TERM_FAILURE_PLANT == 1 )) && [[ "$signal" == "TERM" ]]; then return 1; fi
  if (( SIGNAL_KILL_FAILURE_PLANT == 1 )) && [[ "$signal" == "KILL" ]]; then return 1; fi
  if (( SIGNAL_KILL_NO_SETTLE_PLANT == 1 )) && [[ "$signal" == "KILL" || "$signal" == "DIE" ]]; then return 0; fi
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
  if [[ "$GROUP_PROTOCOL_STATE" == "running" ]] &&
     (( GROUP_ALLOW_CHILD_BEFORE_ACK == 1 )); then
    allow_child=1
  fi
  read_group_record "$expected" "$allow_child"
  status=$?
  if (( status == 0 )) && [[ "$signal" == "DIE" ]]; then GROUP_PROTOCOL_STATE="closing"; fi
  return "$status"
}

verify_group_result_eof() {
  local record="" read_status
  (( GROUP_RESULT_OPEN == 1 )) || return 1
  IFS= read -r -t 2 record <&5
  read_status=$?
  # EOF is the only valid post-settlement condition. One more line means a
  # duplicate terminal, duplicate acknowledgement, or protocol drift.
  (( read_status == 1 )) || return 1
  [[ -z "$record" ]]
}

# Cleanup may encounter a transcript that has already been rejected (duplicate,
# malformed, or out-of-order record). Once the owned group is independently
# proven absent, drain only to establish closure of the anonymous result writer;
# no drained bytes are interpreted as a valid outcome.
drain_group_result_to_eof() {
  local deadline="$1" record="" read_status remaining
  (( GROUP_RESULT_OPEN == 1 )) || return 1
  while (( SECONDS < deadline )); do
    remaining=$((deadline - SECONDS))
    IFS= read -r -t "$remaining" record <&5
    read_status=$?
    (( read_status == 1 )) && return 0
    (( read_status == 0 )) || return 1
  done
  return 1
}

# Before authenticated READY the supervisor has forked no payload. Closing its
# anonymous control writer makes its builtin BOOT/input read reach EOF. The
# anonymous result read end is exact authority for its departure: only EOF (or
# one already-in-flight exact READY followed by EOF) permits the cached wait.
# No numeric process-group probe is used for provisional ownership.
settle_provisional_owner_from_result() {
  local pid="$1" token="$2" deadline="$3" allow_ready="${4:-0}"
  local record="" read_status remaining ready_seen=0
  while (( SECONDS < deadline )); do
    remaining=$((deadline - SECONDS))
    IFS= read -r -t "$remaining" record <&5
    read_status=$?
    if (( read_status == 1 )); then
      direct_child_settled_before_wait "$pid" || return 1
      wait "$pid" 2>/dev/null || true
      unregister_child "$pid"
      return 0
    fi
    if (( read_status == 0 )) && (( allow_ready == 1 && ready_seen == 0 )) &&
       [[ "$record" == "control-ready:${token}" ]]; then
      ready_seen=1
      continue
    fi
    return 1
  done
  return 1
}

consume_group_terminal_during_grace() {
  local grace="$1" record="" read_status
  if [[ -n "$GROUP_PENDING_CHILD_RECORD" ]]; then
    GROUP_PENDING_CHILD_RECORD=""
    return 0
  fi
  if (( GROUP_TERMINAL_SEEN == 1 )); then
    sleep "$CHILD_SETTLE_POLL_SECONDS"
    return 0
  fi
  IFS= read -r -t "$grace" record <&5
  read_status=$?
  if (( read_status > 128 || read_status == 1 )); then return 0; fi
  (( read_status == 0 )) || return 1
  if [[ "$GROUP_PROTOCOL_STATE" == "running" ]] && (( GROUP_TERMINAL_SEEN == 0 )) &&
     validate_group_child_record "$record"; then
    GROUP_TERMINAL_SEEN=1
    GROUP_PROTOCOL_STATE="terminal"
    sleep "$CHILD_SETTLE_POLL_SECONDS"
    return 0
  fi
  GROUP_RECORD_INVALID=1
  return 1
}

# Bounded, PRE-REAP settlement proof. The direct leader is still registered for
# every call, so its group identity remains the one this owner created. Once
# this reports absent, `wait` is only the reap of an already-settled child. No
# caller may signal or probe the numeric identity after that wait.
CHILD_SETTLE_ATTEMPTS=80
CHILD_SETTLE_POLL_SECONDS=0.05
KERNEL_INSPECTION_FAILURE_PLANT=""

# Return 0 live, 1 exact ESRCH absence, 2 any other inspection refusal. Bash's
# `kill -0` status alone collapses EPERM and ESRCH, so it cannot authorize a
# subsequent wait/unregister. The trusted Perl already required by the
# supervisor preserves errno without signalling the target.
kernel_identity_state() {
  local target="$1" kind="$2"
  if [[ "$KERNEL_INSPECTION_FAILURE_PLANT" == "$kind" ]]; then return 2; fi
  /usr/bin/perl -MErrno=ESRCH -e '
    my $target = 0 + $ARGV[0];
    exit 0 if kill 0, $target;
    exit((0 + $!) == ESRCH ? 1 : 2);
  ' -- "$target" 2>/dev/null
}

group_settled_before_wait() {
  local pid="$1" attempts=0 state=0
  while (( attempts < CHILD_SETTLE_ATTEMPTS )); do
    kernel_identity_state "-${pid}" group
    state=$?
    (( state == 1 )) && return 0
    (( state == 0 )) || return 1
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
  local pid="$1" attempts=0 state kernel_state=0
  while (( attempts < CHILD_SETTLE_ATTEMPTS )); do
    kernel_identity_state "$pid" direct
    kernel_state=$?
    (( kernel_state == 1 )) && return 0
    (( kernel_state == 0 )) || return 1
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
  if (( ${#kept[@]} == 0 )); then
    CHILD_PIDS=()
    CHILD_OWNER_TOKENS=()
    CHILD_KINDS=()
  else
    CHILD_PIDS=("${kept[@]}")
    CHILD_OWNER_TOKENS=("${kept_tokens[@]}")
    CHILD_KINDS=("${kept_kinds[@]}")
  fi
  release_group_control "$pid"
}

clear_child_records() {
  # Self-tests may reset empty arrays, but they may never erase a retained
  # owner. Doing so would suppress the EXIT reaper and turn cleanup-unproven
  # into an orphan hidden by test bookkeeping.
  (( ${#CHILD_PIDS[@]} == 0 )) || return "$EX_CLEANUP_UNPROVEN"
  CHILD_PIDS=()
  CHILD_OWNER_TOKENS=()
  CHILD_KINDS=()
  [[ -z "$GROUP_CONTROL_PID" ]] || release_group_control "$GROUP_CONTROL_PID"
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
  REAP_SURVIVORS=0
  (( ${#CHILD_PIDS[@]} > 0 )) || return 0
  for pid in "${CHILD_PIDS[@]}"; do
    if child_record_is_kind "$pid" "controlled-group"; then
      # A cooperative payload may publish CHILD after TERM ACK but before KILL.
      # Drain that one typed terminal during the grace, and permit the same race
      # while awaiting KILL ACK. Any duplicate or other record fails closed.
      GROUP_ALLOW_CHILD_BEFORE_ACK=1
      request_group_signal "$pid" TERM || true
      consume_group_terminal_during_grace "$REAP_GRACE_SECONDS" || true
      request_group_signal "$pid" KILL || true
      GROUP_ALLOW_CHILD_BEFORE_ACK=0
      if group_settled_before_wait "$pid"; then
        if verify_group_result_eof || drain_group_result_to_eof "$((SECONDS + 2))"; then
          wait "$pid" 2>/dev/null || true
          unregister_child "$pid"
          continue
        fi
      fi
      REAP_SURVIVORS=1
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

# Positive lifecycle evidence is emitted only after the owner set itself is
# empty. This proves the registered same-process-groups created by this script;
# it deliberately makes no claim about an arbitrary payload that detached into
# a new session or process group.
# shellcheck disable=SC2329 # Transitively invoked by the EXIT trap through on_exit.
publish_lifecycle_settled() {
  (( LIFECYCLE_TERMINAL_PUBLISHED == 0 )) || return 0
  (( REAP_SURVIVORS == 0 && ${#CHILD_PIDS[@]} == 0 )) || return 1
  [[ -z "$GROUP_CONTROL_PID" ]] || return 1
  (( S6_ARTIFACT_WRITER_LEASE_OWNED == 0 )) || return 1
  emit "{\"suite\":\"${SUITE}\",\"record_type\":\"lifecycle-terminal\",\"status\":\"pass\",\"owned_same_process_groups\":\"settled\",\"artifact_writer_lease\":\"closed-or-not-acquired\"}"
  LIFECYCLE_TERMINAL_PUBLISHED=1
}

# shellcheck disable=SC2329 # Invoked by the EXIT trap.
on_exit() {
  local status=$?
  (( BASH_SUBSHELL == 0 )) || return 0
  # The per-run bounded-supervisor stdout capture leaks on every early
  # self_test exit, so retire it here where all exit paths converge.
  [[ -z "${SELF_TEST_BOUNDED_OUT:-}" ]] || rm -f "$SELF_TEST_BOUNDED_OUT" 2>/dev/null || true
  if (( CLEANED_UP == 1 )); then
    s6_close_artifact_writer_lease_after_settlement || {
      emit "{\"suite\":\"${SUITE}\",\"assertion\":\"artifact-writer-lease-closed\",\"status\":\"fail\",\"detail\":\"the exact run boundary or settled owner set could not be revalidated before lease close\",\"reproduce\":\"${REPRODUCE}\"}"
      trap - EXIT
      exit "$EX_CLEANUP_UNPROVEN"
    }
    publish_lifecycle_settled || {
      emit "{\"suite\":\"${SUITE}\",\"assertion\":\"no-child-survivors\",\"status\":\"fail\",\"detail\":\"owned process-group settlement was not proven\",\"reproduce\":\"${REPRODUCE}\"}"
      trap - EXIT
      exit "$EX_CLEANUP_UNPROVEN"
    }
    return
  fi
  CLEANUP_IN_PROGRESS=1
  trap 'CLEANUP_SECOND_SIGNAL=1' INT TERM
  reap_children
  CLEANUP_IN_PROGRESS=0
  if (( REAP_SURVIVORS != 0 || CLEANUP_SECOND_SIGNAL != 0 )); then
    emit "{\"suite\":\"${SUITE}\",\"assertion\":\"no-child-survivors\",\"status\":\"fail\",\"detail\":\"a child process group survived cleanup\",\"reproduce\":\"${REPRODUCE}\"}"
    CLEANED_UP=1
    trap - EXIT
    exit "$EX_CLEANUP_UNPROVEN"
  fi
  CLEANED_UP=1
  s6_close_artifact_writer_lease_after_settlement || {
    emit "{\"suite\":\"${SUITE}\",\"assertion\":\"artifact-writer-lease-closed\",\"status\":\"fail\",\"detail\":\"the exact run boundary or settled owner set could not be revalidated before lease close\",\"reproduce\":\"${REPRODUCE}\"}"
    trap - EXIT
    exit "$EX_CLEANUP_UNPROVEN"
  }
  publish_lifecycle_settled || {
    trap - EXIT
    exit "$EX_CLEANUP_UNPROVEN"
  }
  trap - EXIT
  exit "$status"
}

# shellcheck disable=SC2329 # Invoked by the INT and TERM traps.
on_signal() {
  local signal="$1"
  if (( SPAWN_REGISTRATION_ACTIVE == 1 )); then
    if [[ -z "$LATCHED_SIGNAL" ]]; then
      LATCHED_SIGNAL="$signal"
    else
      CLEANUP_SECOND_SIGNAL=1
    fi
    return
  fi
  if (( CLEANUP_IN_PROGRESS == 1 )); then
    CLEANUP_SECOND_SIGNAL=1
    return
  fi
  (( CLEANED_UP == 1 )) && exit "$EX_FAIL"
  CLEANUP_IN_PROGRESS=1
  trap 'CLEANUP_SECOND_SIGNAL=1' INT TERM
  if [[ -n "$SIGNAL_CLEANUP_MARKER" ]]; then
    printf 'cleanup-started' >"$SIGNAL_CLEANUP_MARKER" 2>/dev/null || true
  fi
  reap_children
  # A survivor must NOT be reported as a tidy interruption.
  #
  # This previously emitted INTERRUPTED unconditionally — "terminated its
  # children" — regardless of whether anything was actually reaped. A reader
  # would take that as a clean stop when a process group was still running.
  CLEANUP_IN_PROGRESS=0
  if (( REAP_SURVIVORS != 0 || CLEANUP_SECOND_SIGNAL != 0 )); then
    blocked_record "CLEANUP_UNPROVEN" "the run received SIG${signal} and a child process group survived cleanup"
    CLEANED_UP=1
    trap - EXIT
    exit "$EX_CLEANUP_UNPROVEN"
  fi
  CLEANED_UP=1
  if ! s6_close_artifact_writer_lease_after_settlement; then
    blocked_record "CLEANUP_UNPROVEN" \
      "the run received SIG${signal}, child groups settled, but the exact artifact writer boundary could not be revalidated for lease close"
    trap - EXIT
    exit "$EX_CLEANUP_UNPROVEN"
  fi
  blocked_record "INTERRUPTED" "the run received SIG${signal} and every child process group was reaped"
  exit "$EX_FAIL"
}

# Close the launch window only once the provisional child has either become an
# authenticated controlled owner or has been boundedly settled. Clearing the
# latch before dispatch is deliberate: a later signal enters normal cleanup,
# while an earlier one is already stored in `pending`.
end_spawn_registration_window() {
  SPAWN_REGISTRATION_ACTIVE=0
  if [[ -n "$SPAWN_HANDOFF_READY_MARKER" ]]; then
    printf 'ready' >"$SPAWN_HANDOFF_READY_MARKER" 2>/dev/null || true
    while [[ -n "$SPAWN_HANDOFF_RELEASE_MARKER" &&
             ! -e "$SPAWN_HANDOFF_RELEASE_MARKER" ]]; do
      IFS= read -r -t 0.05 _ || true
    done
  fi
  local pending="$LATCHED_SIGNAL"
  LATCHED_SIGNAL=""
  if [[ -n "$pending" ]]; then on_signal "$pending"; fi
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

# A physical frame is always smaller than PIPE_BUF. The prior exact ACK proves
# the sole listener drained the previous frame, so even a listener stopped
# between frames cannot make the next builtin write block on a full pipe.
group_frame_size_valid() {
  local frame="$1" LC_ALL=C
  # Include the serialized LF in the 512-byte minimum atomic-pipe bound.
  (( ${#frame} <= 511 ))
}

send_group_frame_until() {
  local frame="$1" expected="$2" deadline="$3" status=0
  local LC_ALL=C
  group_frame_size_valid "$frame" || return 1
  (( SECONDS < deadline )) || return 1
  trap '' PIPE
  printf '%s\n' "$frame" >&6 2>/dev/null || status=$?
  trap - PIPE
  (( status == 0 )) || return 1
  read_group_exact_until "$expected" "$deadline" 0
}

# Bootstrap one exact bounded stdin record over the anonymous control stream.
# Every <=512-byte physical frame has a nonce-bound ACK and shares the one
# deadline created before BOOT. The supervisor validates counts and exact bytes
# before it forks the payload, then reconstructs stdin into an anonymous pipe.
send_group_input() {
  local pid="$1" record="$2" deadline="$3" index token remaining line count=1 bytes
  local line_index=0 chunk_index chunk final frame
  local LC_ALL=C
  child_record_index "$pid" || return 1
  index="$CHILD_RECORD_INDEX"
  token="${CHILD_OWNER_TOKENS[$index]:-}"
  [[ "${CHILD_KINDS[$index]:-ordinary}" == "controlled-group" ]] || return 1
  [[ "$GROUP_CONTROL_PID" == "$pid" && "$GROUP_CONTROL_TOKEN" == "$token" ]] || return 1
  (( GROUP_CONTROL_OPEN == 1 )) || return 1
  [[ "$GROUP_PROTOCOL_STATE" == "input" ]] || return 1
  if [[ "$record" == "-" ]]; then
    send_group_frame_until $'START-NONE\t'"${token}" "input-ready:${token}" "$deadline" || return 1
    GROUP_PROTOCOL_STATE="running"
    return 0
  fi
  (( ${#record} <= 4096 )) || return 1
  remaining="$record"
  while [[ "$remaining" == *$'\n'* ]]; do
    count=$((count + 1))
    remaining="${remaining#*$'\n'}"
  done
  (( count <= 128 )) || return 1
  bytes="${#record}"
  send_group_frame_until $'START-DATA\t'"${token}"$'\t'"${count}"$'\t'"${bytes}" \
    "input-ack:${token}:start" "$deadline" || return 1

  remaining="$record"
  while (( line_index < count )); do
    if (( line_index + 1 < count )); then
      line="${remaining%%$'\n'*}"
      remaining="${remaining#*$'\n'}"
    else
      line="$remaining"
      remaining=""
    fi
    chunk_index=0
    while :; do
      if (( ${#line} > 256 )); then
        chunk="${line:0:256}"
        line="${line:256}"
        final=0
      else
        chunk="$line"
        line=""
        final=1
      fi
      frame=$'DATA\t'"${token}"$'\t'"${line_index}"$'\t'"${chunk_index}"$'\t'"${final}"$'\t'"${chunk}"
      send_group_frame_until "$frame" \
        "input-ack:${token}:${line_index}:${chunk_index}" "$deadline" || return 1
      chunk_index=$((chunk_index + 1))
      (( final == 1 )) && break
    done
    line_index=$((line_index + 1))
  done
  send_group_frame_until $'END-DATA\t'"${token}" "input-ready:${token}" "$deadline" || return 1
  GROUP_PROTOCOL_STATE="running"
}

# Regression-only in-process faults. They are assigned only by `self_test`; no
# environment variable or live invocation can switch them on.
SUPERVISOR_READY_WRITE_PLANT=0
SUPERVISOR_DEPART_AFTER_RESULT_PLANT=0
SUPERVISOR_EARLY_ACK_PLANT=0
SUPERVISOR_CHILD_BEFORE_ACK_PLANT=0
SUPERVISOR_CHILD_STATUS_PLANT=""
SUPERVISOR_INPUT_ACK_PLANT=""
SUPERVISOR_EXTRA_RECORD_PLANT=0
DEAD_LISTENER_WRITE_REFUSAL_OBSERVED=0
RUN_BOUNDED_OUTCOME="idle"
RUN_BOUNDED_CHILD_STATUS=""
RUN_BOUNDED_STAGE="idle"

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
  local supervisor_token boot_status=0 setup_status=0
  local pid coproc_pid coproc_read_fd coproc_write_fd input_deadline
  local stable_result=0 stable_control=0
  [[ -z "$GROUP_CONTROL_PID" ]] || return "$EX_CLEANUP_UNPROVEN"
  (( SPAWN_REGISTRATION_ACTIVE == 0 )) || return "$EX_CLEANUP_UNPROVEN"
  RUN_BOUNDED_OUTCOME="unavailable"
  RUN_BOUNDED_CHILD_STATUS=""
  RUN_BOUNDED_STAGE="pre-coproc"
  mint_owner_token "supervisor"
  supervisor_token="$OWNER_TOKEN"
  input_deadline=$((SECONDS + INPUT_BOOTSTRAP_WAIT_SECONDS))

  # Both authority directions are anonymous coprocess pipes. The payload can
  # neither reopen a pathname nor read the token-bearing result stream. The
  # coprocess body immediately execs Perl, so its pid remains the exact group
  # leader through Perl -> Bash supervisor for the whole capability lifetime.
  LATCHED_SIGNAL=""
  SPAWN_REGISTRATION_ACTIVE=1
  unset -v S6_BOUNDED_SUPERVISOR S6_BOUNDED_SUPERVISOR_PID 2>/dev/null || true
  coproc S6_BOUNDED_SUPERVISOR {
    exec /usr/bin/perl -MPOSIX -e '
      $^F=9;
      my @fds; my $fd_dir_found=0;
      for my $path ("/proc/self/fd", "/dev/fd") {
        if (opendir(my $dh, $path)) {
          @fds = grep { /^[0-9]+$/ } readdir($dh);
          closedir($dh);
          $fd_dir_found=1;
          last;
        }
      }
      die "close-from unavailable" unless $fd_dir_found;
      POSIX::close($_) for grep { $_ > 2 } @fds;
      pipe(my $reader, my $writer) or die $!;
      my $r=fileno($reader); my $w=fileno($writer);
      if ($r==9 && $w!=9) { $r=POSIX::dup($r); die $! if $r<0; }
      POSIX::dup2($w,9) unless $w==9;
      POSIX::dup2($r,8) unless $r==8;
      POSIX::close($r) if $r!=8 && $r!=9;
      POSIX::close($w) if $w!=8 && $w!=9;
      defined(setpgrp(0,0)) or die $!;
      exec @ARGV or die $!;
    ' \
      bash -c '
        stdout_file="$1" unavailable="$2" ready_plant="$3" early_ack_plant="$4" child_before_ack_plant="$5" child_status_plant="$6" input_ack_plant="$7" extra_record_plant="$8"
        shift 8
        supervisor_bootstrap_fail() {
          printf "s6-supervisor-bootstrap:%s\n" "$1" >&2
          exit "$unavailable"
        }
        set +m
        LC_ALL=C
        export LC_ALL
        trap "" TERM HUP INT PIPE
        exec 7<&0 || supervisor_bootstrap_fail control-fd
        exec 5>&1 || supervisor_bootstrap_fail result-fd
        exec 0</dev/null 1>/dev/null
        printf -v tab "\t"
        (( ${#tab} == 1 )) || supervisor_bootstrap_fail tab-width
        IFS="$tab" read -r boot_kind token boot_extra <&7 || supervisor_bootstrap_fail boot-read
        [[ "$boot_kind" == "BOOT" ]] || supervisor_bootstrap_fail boot-kind
        [[ -n "$token" ]] || supervisor_bootstrap_fail boot-token-empty
        [[ -z "$boot_extra" ]] || supervisor_bootstrap_fail boot-extra-field
        if [[ "$ready_plant" == "1" ]]; then exit "$unavailable"; fi
        printf "control-ready:%s\n" "$token" >&5 || supervisor_bootstrap_fail ready-write

        input_mode="" input_record="" start_frame=""
        # READY is already an authenticated retirement capability. A signal
        # latched between coproc spawn and parent adoption is drained before
        # START, so no payload is forked merely to make cleanup possible.
        while :; do
          IFS= read -r start_frame <&7 || kill -KILL 0
          if [[ "$start_frame" == "SIGNAL${tab}${token}${tab}TERM" ]]; then
            printf "control-ack:%s:TERM\n" "$token" >&5 || kill -KILL 0
            continue
          fi
          if [[ "$start_frame" == "SIGNAL${tab}${token}${tab}KILL" ]]; then
            printf "control-ack:%s:KILL\n" "$token" >&5 || kill -KILL 0
            kill -KILL 0
          fi
          break
        done
        if [[ "$start_frame" == "START-NONE${tab}${token}" ]]; then
          input_mode="none"
          printf "input-ready:%s\n" "$token" >&5 || kill -KILL 0
        else
          start_prefix="START-DATA${tab}${token}${tab}"
          [[ "$start_frame" == "$start_prefix"* ]] || kill -KILL 0
          metadata="${start_frame#"$start_prefix"}"
          line_count="${metadata%%"$tab"*}"
          byte_count="${metadata#*"$tab"}"
          [[ "$line_count" =~ ^[0-9]+$ && "$byte_count" =~ ^[0-9]+$ ]] || kill -KILL 0
          (( line_count >= 1 && line_count <= 128 && byte_count <= 4096 )) || kill -KILL 0
          [[ "$input_ack_plant" == "start" ]] || \
            printf "input-ack:%s:start\n" "$token" >&5 || kill -KILL 0
          printf -v newline "\n"
          line_index=0
          while (( line_index < line_count )); do
            line_value="" chunk_index=0 final=0
            while (( final == 0 )); do
              IFS= read -r data_frame <&7 || kill -KILL 0
              data_prefix="DATA${tab}${token}${tab}${line_index}${tab}${chunk_index}${tab}"
              [[ "$data_frame" == "$data_prefix"* ]] || kill -KILL 0
              data_tail="${data_frame#"$data_prefix"}"
              [[ "$data_tail" == *"$tab"* ]] || kill -KILL 0
              final="${data_tail%%"$tab"*}"
              data="${data_tail#*"$tab"}"
              [[ "$final" == "0" || "$final" == "1" ]] || kill -KILL 0
              (( ${#data} <= 256 )) || kill -KILL 0
              line_value="${line_value}${data}"
              if [[ "$input_ack_plant" == "depart-mid" && "$line_index:$chunk_index" == "0:0" ]]; then
                kill -KILL 0
              elif [[ "$input_ack_plant" != "mid" || "$line_index:$chunk_index" != "0:0" ]]; then
                printf "input-ack:%s:%s:%s\n" "$token" "$line_index" "$chunk_index" >&5 || kill -KILL 0
              fi
              chunk_index=$((chunk_index + 1))
            done
            if (( line_index == 0 )); then
              input_record="$line_value"
            else
              input_record="${input_record}${newline}${line_value}"
            fi
            line_index=$((line_index + 1))
          done
          IFS= read -r end_frame <&7 || kill -KILL 0
          [[ "$end_frame" == "END-DATA${tab}${token}" ]] || kill -KILL 0
          (( ${#input_record} == byte_count )) || kill -KILL 0
          input_mode="record"
          printf "input-ready:%s\n" "$token" >&5 || kill -KILL 0
        fi
        if [[ "$early_ack_plant" == "1" ]]; then
          printf "control-ack:%s:EARLY\n" "$token" >&5 || kill -KILL 0
        fi

        # The recorder retains the supervisors ignored dispositions so TERM can
        # never prevent it publishing the terminal record. The nested payload
        # resets TERM/HUP/INT immediately before exec; real curl/Bun/browser
        # children therefore remain cooperative instead of inheriting ignores.
        (
          exec 5>&- 7<&- 8<&-
          command_status=0
          (
            trap - TERM HUP INT PIPE
            unset token boot_kind start_frame
            if [[ "$input_mode" == "record" ]]; then
              exec 0< <(exec 0<&- 5>&- 7>&- 8>&- 9>&-; printf "%s\n" "$input_record")
            else
              exec </dev/null
            fi
            exec /usr/bin/perl -MPOSIX -e '"'"'
              my @fds; my $fd_dir_found=0;
              for my $path ("/proc/self/fd", "/dev/fd") {
                if (opendir(my $dh, $path)) {
                  @fds = grep { /^[0-9]+$/ } readdir($dh);
                  closedir($dh);
                  $fd_dir_found=1;
                  last;
                }
              }
              die "close-from unavailable" unless $fd_dir_found;
              POSIX::close($_) for grep { $_ > 2 } @fds;
              exec {$ARGV[0]} @ARGV or exec @ARGV or die $!;
            '"'"' -- "$@" >"$stdout_file"
          ) || command_status=$?
          if [[ -n "$child_status_plant" ]]; then command_status="$child_status_plant"; fi
          printf "child:%s:%s\n" "$token" "$command_status" >&9 || kill -KILL 0
          exec 9>&-
        ) &
        exec 9>&-
        child_sent=0
        while :; do
          if (( child_sent == 0 )); then
            if IFS= read -r -t 0.05 child_record <&8; then
              child_prefix="child:${token}:"
              [[ "$child_record" == "$child_prefix"* ]] || kill -KILL 0
              child_status="${child_record#"$child_prefix"}"
              [[ "$child_status" =~ ^(0|[1-9]|[1-9][0-9]|[1-9][0-9][0-9])$ ]] || kill -KILL 0
              (( 10#$child_status <= 255 )) || kill -KILL 0
              printf "child:%s:%s\n" "$token" "$child_status" >&5 || kill -KILL 0
              if [[ "$extra_record_plant" == "1" ]]; then
                printf "child:%s:%s\n" "$token" "$child_status" >&5 || kill -KILL 0
              fi
              child_sent=1
            fi
          fi
          request_status=0
          IFS="$tab" read -r -t 0.05 request_kind request_token request_signal request_extra <&7 || request_status=$?
          if (( request_status == 0 )); then
            [[ "$request_kind" == "SIGNAL" && "$request_token" == "$token" && -z "$request_extra" ]] || kill -KILL 0
            case "$request_signal" in
            TERM)
              if [[ "$child_before_ack_plant" == "1" ]]; then
                kill -TERM 0 2>/dev/null || kill -KILL 0
                if (( child_sent == 0 )); then
                  IFS= read -r -t 3 child_record <&8 || kill -KILL 0
                  child_prefix="child:${token}:"
                  [[ "$child_record" == "$child_prefix"* ]] || kill -KILL 0
                  child_status="${child_record#"$child_prefix"}"
                  [[ "$child_status" =~ ^(0|[1-9]|[1-9][0-9]|[1-9][0-9][0-9])$ ]] || kill -KILL 0
                  (( 10#$child_status <= 255 )) || kill -KILL 0
                  printf "child:%s:%s\n" "$token" "$child_status" >&5 || kill -KILL 0
                  child_sent=1
                fi
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
          elif (( request_status == 1 )); then
            kill -KILL 0
          fi
        done
      ' "s6-bounded-supervisor" "$stdout_file" \
      "$EX_WATCHDOG_UNAVAILABLE" "$SUPERVISOR_READY_WRITE_PLANT" \
      "$SUPERVISOR_EARLY_ACK_PLANT" "$SUPERVISOR_CHILD_BEFORE_ACK_PLANT" \
      "$SUPERVISOR_CHILD_STATUS_PLANT" "$SUPERVISOR_INPUT_ACK_PLANT" \
      "$SUPERVISOR_EXTRA_RECORD_PLANT" "$@"
  }
  pid=$!
  if [[ -n "$SPAWN_REGISTRATION_READY_MARKER" ]]; then
    printf 'ready' >"$SPAWN_REGISTRATION_READY_MARKER" 2>/dev/null || true
    while [[ -n "$SPAWN_REGISTRATION_RELEASE_MARKER" &&
             ! -e "$SPAWN_REGISTRATION_RELEASE_MARKER" ]]; do
      IFS= read -r -t 0.05 _ || true
    done
  fi
  coproc_pid="${S6_BOUNDED_SUPERVISOR_PID:-}"
  coproc_read_fd="${S6_BOUNDED_SUPERVISOR[0]:-}"
  coproc_write_fd="${S6_BOUNDED_SUPERVISOR[1]:-}"
  RUN_BOUNDED_STAGE="coproc-snapshot"
  if [[ ! "$pid" =~ ^[0-9]+$ ]]; then
    end_spawn_registration_window
    return "$EX_WATCHDOG_UNAVAILABLE"
  fi
  register_child "$pid" "$supervisor_token" "ordinary"
  [[ "$pid" =~ ^[0-9]+$ && "$coproc_pid" == "$pid" ]] || setup_status=1
  [[ "$coproc_read_fd" =~ ^[0-9]+$ && "$coproc_write_fd" =~ ^[0-9]+$ ]] || setup_status=1
  (( setup_status != 0 || (coproc_read_fd > 9 && coproc_write_fd > 9) )) || setup_status=1
  if (( setup_status == 0 )); then
    if exec 5<&"$coproc_read_fd"; then stable_result=1; else setup_status=$?; fi
  fi
  if (( setup_status == 0 )); then
    if exec 6>&"$coproc_write_fd"; then stable_control=1; else setup_status=$?; fi
  fi
  if [[ "$coproc_read_fd" =~ ^[0-9]+$ ]]; then exec {coproc_read_fd}<&- 2>/dev/null || true; fi
  if [[ "$coproc_write_fd" =~ ^[0-9]+$ ]]; then exec {coproc_write_fd}>&- 2>/dev/null || true; fi
  if (( setup_status != 0 )); then
    (( stable_control == 1 )) && exec 6>&- 2>/dev/null || true
    if (( stable_result == 1 )) &&
       settle_provisional_owner_from_result \
         "$pid" "$supervisor_token" "$((SECONDS + 2))" 0; then
      exec 5<&- 2>/dev/null || true
      end_spawn_registration_window
      return "$EX_WATCHDOG_UNAVAILABLE"
    fi
    if (( stable_result == 0 )) && direct_child_settled_before_wait "$pid"; then
      wait "$pid" 2>/dev/null || true
      unregister_child "$pid"
      end_spawn_registration_window
      return "$EX_WATCHDOG_UNAVAILABLE"
    fi
    end_spawn_registration_window
    return "$EX_CLEANUP_UNPROVEN"
  fi
  RUN_BOUNDED_STAGE="fds-stable"
  if ! prepare_group_control "$pid" "$supervisor_token"; then
    exec 6>&- 2>/dev/null || true
    stable_control=0
    if settle_provisional_owner_from_result \
      "$pid" "$supervisor_token" "$((SECONDS + 2))" 0; then
      exec 5<&- 2>/dev/null || true
      end_spawn_registration_window
      return "$EX_WATCHDOG_UNAVAILABLE"
    fi
    end_spawn_registration_window
    return "$EX_CLEANUP_UNPROVEN"
  fi
  RUN_BOUNDED_STAGE="control-prepared"
  send_group_frame_until $'BOOT\t'"${supervisor_token}" \
    "control-ready:${supervisor_token}" "$input_deadline" || boot_status=$?
  if (( boot_status != 0 )); then
    exec 6>&- 2>/dev/null || true
    GROUP_CONTROL_OPEN=0
    if settle_provisional_owner_from_result \
      "$pid" "$supervisor_token" "$((SECONDS + 2))" 1; then
      end_spawn_registration_window
      return "$EX_WATCHDOG_UNAVAILABLE"
    fi
    end_spawn_registration_window
    return "$EX_CLEANUP_UNPROVEN"
  fi
  GROUP_PROTOCOL_STATE="ready"
  RUN_BOUNDED_STAGE="boot-acknowledged"
  if ! adopt_group_control "$pid" "$supervisor_token"; then
    exec 6>&- 2>/dev/null || true
    GROUP_CONTROL_OPEN=0
    if settle_provisional_owner_from_result \
      "$pid" "$supervisor_token" "$((SECONDS + 2))" 0; then
      end_spawn_registration_window
      return "$EX_WATCHDOG_UNAVAILABLE"
    fi
    end_spawn_registration_window
    return "$EX_CLEANUP_UNPROVEN"
  fi
  end_spawn_registration_window
  GROUP_PROTOCOL_STATE="input"
  if ! send_group_input "$pid" "$stdin_file" "$input_deadline"; then
    exec 6>&- 2>/dev/null || true
    GROUP_CONTROL_OPEN=0
    if settle_provisional_owner_from_result \
      "$pid" "$supervisor_token" "$((SECONDS + 2))" 0; then
      return "$EX_INPUT_BOOTSTRAP_UNAVAILABLE"
    fi
    return "$EX_CLEANUP_UNPROVEN"
  fi
  RUN_BOUNDED_STAGE="input-ready"

  # The parent builtin owns the sole wall-clock deadline. There is no watchdog
  # child to stop, orphan, or reap: one timeout read races the payload result,
  # then the still-live supervisor accepts the TERM/KILL sequence itself.
  local outcome="" child_status="" status="$EX_WATCHDOG_UNAVAILABLE"
  local cleanup_unproven=0 timed_out=0 read_status=0 result_eof=0
  if read_group_outcome "$seconds"; then
    outcome="$GROUP_RECORD"
    child_status="${outcome#"child:${supervisor_token}:"}"
    if [[ "$outcome" == "child:${supervisor_token}:${child_status}" &&
          "$child_status" =~ ^(0|[1-9]|[1-9][0-9]|[1-9][0-9][0-9])$ ]] &&
       (( 10#$child_status <= 255 )); then
      status="$((10#$child_status))"
      RUN_BOUNDED_OUTCOME="child"
      RUN_BOUNDED_CHILD_STATUS="$status"
    else
      status="$EX_WATCHDOG_UNAVAILABLE"
      RUN_BOUNDED_OUTCOME="unavailable"
      RUN_BOUNDED_STAGE="record-decode"
    fi
  else
    # Outer branch: `read_group_outcome` did not deliver a terminal record.
    read_status=$?
    (( read_status == 1 && GROUP_RECORD_INVALID == 0 )) && result_eof=1
    if (( GROUP_RECORD_INVALID == 1 )); then
      status="$EX_WATCHDOG_UNAVAILABLE"
    elif (( read_status > 128 )); then
      # The parent-memory latch is authoritative before teardown starts. There
      # is no target-writable flag path to forge, redirect, or chmod.
      timed_out=1
      status=124
      RUN_BOUNDED_OUTCOME="timeout"
    else
      status="$EX_WATCHDOG_UNAVAILABLE"
      RUN_BOUNDED_OUTCOME="unavailable"
      RUN_BOUNDED_STAGE="terminal-record-missing"
    fi
  fi

  # EOF can mean the supervisor rejected a malformed recorder result. It is not
  # settlement by itself; only exact owned-group absence plus a second exact EOF
  # permits the cached direct wait and a typed unavailable return.
  if (( result_eof == 1 )); then
    if group_settled_before_wait "$pid" && verify_group_result_eof; then
      wait "$pid" 2>/dev/null || true
      unregister_child "$pid"
      return "$EX_WATCHDOG_UNAVAILABLE"
    fi
    return "$EX_CLEANUP_UNPROVEN"
  fi

  if (( SUPERVISOR_DEPART_AFTER_RESULT_PLANT == 1 && timed_out == 0 )); then
    # Causal recycled-PGID polarity: make the sole reader close, prove the group
    # gone, reap its leader (so the number is now reusable), then write only to
    # the stale nonce channel. EPIPE/EBADF is the required outcome; there is no
    # numeric signal or probe after the wait.
    if ! request_group_signal "$pid" DIE || ! group_settled_before_wait "$pid"; then
      return "$EX_CLEANUP_UNPROVEN"
    fi
    verify_group_result_eof || return "$EX_CLEANUP_UNPROVEN"
    wait "$pid" 2>/dev/null || true
    trap '' PIPE
    for _ in {1..500}; do
      printf 'SIGNAL\t%s\tTERM\n' "$supervisor_token" >&6 2>/dev/null || {
        DEAD_LISTENER_WRITE_REFUSAL_OBSERVED=1
        break
      }
    done
    trap - PIPE
    unregister_child "$pid"
    if [[ "$RUN_BOUNDED_OUTCOME" == "child" ]] && (( status >= 124 && status <= 127 )); then
      return "$EX_FAIL"
    fi
    return "$status"
  fi

  # A legitimate terminal can race TERM acknowledgement on every teardown,
  # including an unavailable main outcome. Permit exactly one token-bound CHILD;
  # terminalSeen/pending state still rejects duplicates.
  GROUP_ALLOW_CHILD_BEFORE_ACK=1
  if ! request_group_signal "$pid" TERM; then cleanup_unproven=1; fi
  if (( timed_out == 1 )); then
    consume_group_terminal_during_grace 3 || cleanup_unproven=1
  else
    consume_group_terminal_during_grace 1 || cleanup_unproven=1
  fi
  if ! request_group_signal "$pid" KILL; then cleanup_unproven=1; fi
  GROUP_ALLOW_CHILD_BEFORE_ACK=0

  # A write or typed-ack refusal never falls into a wait. The unreaped leader
  # and its open control channel remain registered for the outer cleanup owner.
  (( cleanup_unproven == 0 )) || return "$EX_CLEANUP_UNPROVEN"
  group_settled_before_wait "$pid" || return "$EX_CLEANUP_UNPROVEN"
  if ! verify_group_result_eof; then
    wait "$pid" 2>/dev/null || true
    unregister_child "$pid"
    RUN_BOUNDED_OUTCOME="unavailable"
    RUN_BOUNDED_CHILD_STATUS=""
    return "$EX_WATCHDOG_UNAVAILABLE"
  fi

  # FIRST reap. No signal or numeric existence probe uses `$pid` below here.
  wait "$pid" 2>/dev/null || true
  unregister_child "$pid"
  if [[ "$RUN_BOUNDED_OUTCOME" == "child" ]] && (( status >= 124 && status <= 127 )); then
    return "$EX_FAIL"
  fi
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
  printf '{"suite":"%s","status":"blocked","code":"REQUIRED_HARNESS_INPUTS_MISSING",' "$SUITE"
  printf '"missing_env":[%s],' "$missing_csv"
  printf '"blocked_on":"external execution prerequisite: supply every required S-6 harness input for the configured paired Agora and Worker target",'
  printf '"historical_evidence_bead":"asimposiumorg-vw3",'
  printf '"proof_boundary":"configuration presence is not executed cross-plane proof, and missing caller inputs do not establish provider provisioning state",'
  printf '"forbidden_substitutes":"a mocked Worker or stubbed Auth.js presented as runtime proof; the in-process unit vectors relabelled as a live run; a hand-written transcript; a recorded fixture replayed as a deployment; a storage-state file presented as live cookie evidence",'
  printf '"unit_coverage":"apps/wire/test/unit/service-envelope.test.ts, apps/wire/test/unit/principal-routing.test.ts, apps/wire/test/security/cross-plane-refusals.test.ts, apps/web/test/unit/service-envelope.test.ts",'
  printf '"reproduce":"%s"}\n' "$REPRODUCE"
}

valid_https_origin() {
  [[ "$1" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/?$ ]]
}

valid_evidence_directory() {
  [[ "$1" == "e2e/artifacts/s6-cross-plane-auth" ]]
}

evidence_directory_has_symlink_component() {
  [[ -L "e2e" || -L "e2e/artifacts" ||
     -L "e2e/artifacts/s6-cross-plane-auth" ]]
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
  local request_started="$SECONDS"
  HTTP_REQUEST_LATENCY_SECONDS=""
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
    --max-filesize 65536
    --write-out '\n%{http_code}'
    --output -
  )
  if [[ -n "$body_file" ]]; then args+=(--data-binary "@${body_file}"); fi
  args+=(--config -)

  # Sets HTTP_RESPONSE_FILE, and MUST be called from the parent shell.
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
  HTTP_RESPONSE_FILE=""
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
  HTTP_REQUEST_LATENCY_SECONDS=$((SECONDS - request_started))
  if (( rc != 0 )); then
    return "$rc"
  fi
  HTTP_RESPONSE_FILE="$out_file"
}
HTTP_RESPONSE_FILE=""

# Validate the pinned curl transcript through the runner's one contract tree.
# Only a fixed non-secret normalized line crosses back into this shell.
validate_http_response() {
  [[ -n "$HTTP_RESPONSE_FILE" && -f "$PLAYWRIGHT_RUNNER" ]] || return 1
  local kind="$1" validator_file bound transport_status=0 status=0
  shift
  validator_file="${RUN_STATE_DIR}/http-validator.$RANDOM.$RANDOM"
  bound="$(phase_budget 10)"
  (( bound > 0 )) || return 1
  minimal_env_command bun "$PLAYWRIGHT_RUNNER" --validate-http-response \
    "$HTTP_RESPONSE_FILE" "$kind" "$@"
  run_bounded "$bound" "$validator_file" - "${MINIMAL_CMD[@]}" 2>/dev/null || transport_status=$?
  if [[ "$RUN_BOUNDED_OUTCOME" == "child" ]]; then
    status="$RUN_BOUNDED_CHILD_STATUS"
  else
    status="$transport_status"
  fi
  (( status == 0 )) || return 1

  local normalized="" extra="" first_read=0 second_read=0
  exec 7<"$validator_file" || return 1
  IFS= read -r normalized <&7 || first_read=$?
  IFS= read -r extra <&7 || second_read=$?
  exec 7<&-
  (( first_read == 0 && second_read == 1 )) || return 1
  [[ -z "$extra" && "$normalized" == $'ok\t'"$kind" ]]
}

# Validate the retained evidence file through the runner's shared exact schema
# tree. Success is status-only: this shell never reparses a child transcript,
# and a timeout, cleanup refusal, nonzero exit, or unexpected stdout all refuse.
validate_evidence_bundle() {
  local path="$1" expected_revision="$2" expected_deployment_id="$3"
  local expected_agora_host="$4" expected_stoa_host="$5" expected_kid="$6"
  local expected_payload_sha256="$7" expected_principal_pseudonym="$8"
  local expected_initial_latency_seconds="$9" expected_replay_latency_seconds="${10}"
  local expected_browser_leg_seconds="${11}" expected_run_seconds="${12}"
  local expected_assertions="${13}" expected_failures="${14}"
  local validator_file bound transport_status=0 status=0
  [[ -n "$path" && -f "$PLAYWRIGHT_RUNNER" ]] || return 1
  validator_file="${RUN_STATE_DIR}/evidence-validator.$RANDOM.$RANDOM"
  bound="$(phase_budget 10)"
  (( bound > 0 )) || return 1
  minimal_env_command bun "$PLAYWRIGHT_RUNNER" --validate-evidence \
    "$path" "$expected_revision" "$expected_deployment_id" \
    "$expected_agora_host" "$expected_stoa_host" "$expected_kid" \
    "$expected_payload_sha256" "$expected_principal_pseudonym" \
    "$expected_initial_latency_seconds" "$expected_replay_latency_seconds" \
    "$expected_browser_leg_seconds" "$expected_run_seconds" \
    "$expected_assertions" "$expected_failures"
  run_bounded "$bound" "$validator_file" - "${MINIMAL_CMD[@]}" 2>/dev/null || transport_status=$?
  if [[ "$RUN_BOUNDED_OUTCOME" == "child" ]]; then
    status="$RUN_BOUNDED_CHILD_STATUS"
  else
    status="$transport_status"
  fi
  (( status == 0 )) || return 1
  [[ -f "$validator_file" && ! -s "$validator_file" ]]
}

# ---------------------------------------------------------------------------
# Envelope minting through the PRODUCT minter
# ---------------------------------------------------------------------------

write_envelope_shim() {
  cat > "${RUN_STATE_DIR}/mint-envelope.mjs" <<SHIM
import { readSync } from "node:fs";
import { createHash } from "node:crypto";
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
if (!/^[0-9a-f]{64}$/.test(hex ?? "") || !/^[A-Za-z0-9._-]{1,64}$/.test(kid ?? "")) {
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
  const principalPseudonym = createHash("sha256").update(principalId, "utf8").digest("hex");
  // EXACTLY one newline-terminated record. The reader waits for a newline, so a
  // bare write would hang it until its timeout and clear the result — while a
  // probe that printed a newline passed. The two non-secret digests precede
  // the credential-bearing config so the shell can retain the exact request
  // tuple without parsing or persisting the envelope JSON.
  process.stdout.write(\`\${principalPseudonym}\t\${envelope.claims.payload_sha256}\theader = "\${SERVICE_ENVELOPE_HEADER}: \${JSON.stringify(envelope).replace(/"/g, '\\\\"')}"\n\`);
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
  MINTED_PRINCIPAL_PSEUDONYM=""
  MINTED_PAYLOAD_SHA256=""
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
  # Fixed payload descriptors keep the wire format auditable; the launcher
  # itself explicitly requires Bash 4.1 for anonymous named-coproc ownership.
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
  IFS= read -r -t 5 extra <&8 || extra_status=$?
  # EXACT end-of-stream is required. `read` returns 1 at EOF and >128 on
  # timeout; the previous form treated both as "no extra bytes", so a writer
  # that stayed open — the very deadlock this transport had — was accepted as a
  # clean single record.
  if (( extra_status == 0 )) || (( extra_status > 128 )) || [[ -n "$extra" ]]; then
    MINTED_CONFIG=""
  fi
  exec 8<&-
  MINTED_PRINCIPAL_PSEUDONYM="${MINTED_CONFIG%%$'\t'*}"
  local metadata_tail="${MINTED_CONFIG#*$'\t'}"
  MINTED_PAYLOAD_SHA256="${metadata_tail%%$'\t'*}"
  MINTED_CONFIG="${metadata_tail#*$'\t'}"
  if [[ ! "$MINTED_PRINCIPAL_PSEUDONYM" =~ ^[0-9a-f]{64}$ ||
        ! "$MINTED_PAYLOAD_SHA256" =~ ^[0-9a-f]{64}$ ||
        "$MINTED_CONFIG" != 'header = "asimp-service-envelope: {'* ]]; then
    MINTED_CONFIG=""
    MINTED_PRINCIPAL_PSEUDONYM=""
    MINTED_PAYLOAD_SHA256=""
  fi
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
MINTED_PRINCIPAL_PSEUDONYM=""
MINTED_PAYLOAD_SHA256=""

# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

# A GET sponsor route: proves verification and attribution without minting state.
readonly ROUTE_PROPOSALS="/v1/enrollments/proposals"
readonly ACTION_PROPOSALS="enrollment.proposals.list"
readonly ROUTE_HELLO="/v1/hello"
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
  local browser_started="$SECONDS"
  BROWSER_LEG_LATENCY_SECONDS=""
  if [[ ! -f "$PLAYWRIGHT_RUNNER" ]]; then
    buffer_browser_blocked "BROWSER_RUNNER_MISSING" "the browser leg requires ${PLAYWRIGHT_RUNNER}"
    return 1
  fi
  local status=0 transport_status=0 validator_status=0 validator_transport_status=0
  # `run_bounded` runs in the PARENT shell and writes to a file, so its pid and
  # process group stay registered where the EXIT trap can reach them. Capturing
  # it with `$( )` would strand Chromium's group in a dead subshell.
  local out_file="${RUN_STATE_DIR}/browser.out"
  local validator_file="${RUN_STATE_DIR}/browser.validated"
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
    "$(json_string "$ASIMP_S6_PREVIEW_URL")" "$(json_string "$worker")" \
    "$(json_string "$ASIMP_S6_TEST_GOOGLE_USER")" "$(json_string "$ASIMP_S6_TEST_GOOGLE_PASS")")"
  minimal_env_command bun "$PLAYWRIGHT_RUNNER"
  run_bounded "$bound" "$out_file" "$config_record" "${MINIMAL_CMD[@]}" \
    2>"${RUN_STATE_DIR}/browser.err" || transport_status=$?
  BROWSER_LEG_LATENCY_SECONDS=$((SECONDS - browser_started))
  if [[ "$RUN_BOUNDED_OUTCOME" == "child" ]]; then
    status="$RUN_BOUNDED_CHILD_STATUS"
  else
    status="$transport_status"
  fi

  # STATUS FIRST. A convincing record followed by timeout, cleanup refusal or a
  # fault is never parsed as evidence.
  if [[ "$status" -ne 0 && "$status" -ne "$EX_CONFIG" ]]; then
    fail_record "browser-leg" "the browser leg exited ${status}; its output is not evidence"
    return 1
  fi

  # The runner owns the one JSON contract tree. Its validator reads a bounded
  # regular file with fatal UTF-8, requires exactly one canonical LF-terminated
  # record, validates every top-level and nested key/type/cross-field, and binds
  # status=pass/code=OK to exit 0 (or a typed blocked record to exit 78). The
  # shell consumes only the fixed normalized line; grep/tail/substrings/sed can
  # no longer green on a convincing fragment or a later duplicate.
  local validator_bound normalized="" extra="" first_read=0 second_read=0
  validator_bound="$(phase_budget 10)"
  if (( validator_bound <= 0 )); then
    fail_record "browser-leg" "no budget remained to validate the browser evidence"
    return 1
  fi
  minimal_env_command bun "$PLAYWRIGHT_RUNNER" --validate-record "$status" "$out_file"
  run_bounded "$validator_bound" "$validator_file" - "${MINIMAL_CMD[@]}" \
    2>"${RUN_STATE_DIR}/browser-validator.err" || validator_transport_status=$?
  if [[ "$RUN_BOUNDED_OUTCOME" == "child" ]]; then
    validator_status="$RUN_BOUNDED_CHILD_STATUS"
  else
    validator_status="$validator_transport_status"
  fi
  if [[ "$validator_status" -ne "$status" ]]; then
    fail_record "browser-leg" "the strict browser evidence validator refused the exit/status pairing"
    return 1
  fi
  if ! exec 7<"$validator_file"; then
    fail_record "browser-leg" "the strict browser evidence validator produced no readable result"
    return 1
  fi
  IFS= read -r normalized <&7 || first_read=$?
  IFS= read -r extra <&7 || second_read=$?
  exec 7<&-
  if (( first_read != 0 || second_read != 1 )) || [[ -n "$extra" ]]; then
    fail_record "browser-leg" "the browser evidence validator did not produce exactly one LF-terminated normalized line"
    return 1
  fi

  if [[ "$status" -eq "$EX_CONFIG" ]]; then
    local blocked_code="${normalized#$'blocked\t'}"
    if [[ "$normalized" != $'blocked\t'"$blocked_code" ||
          ! "$blocked_code" =~ ^[A-Z][A-Z0-9_]{0,63}$ ]]; then
      fail_record "browser-leg" "the normalized blocked browser evidence was malformed"
      return 1
    fi
    buffer_browser_blocked "$blocked_code" "the browser leg reported a typed provisioning or environment blocker"
    return 1
  fi

  RECEIPT="${normalized#$'pass\t'}"
  if [[ "$normalized" != $'pass\t'"$RECEIPT" || -z "$RECEIPT" ]]; then
    fail_record "browser-leg" "the normalized pass receipt was malformed"
    return 1
  fi
  pass_record "cookie-host-only-live" "every observed non-deletion session issuance was host-only, HttpOnly, Secure and SameSite=Lax, and the live family remained apex-scoped"
  pass_record "cookie-not-sent-to-agent-host" "natural browser eligibility omitted the live host-only session family at Stoa and the exact no-redirect request answered 403 WRONG_PRINCIPAL"
  # Fable direction B: unlike the natural-omission observation above, this fresh
  # Playwright context explicitly presented the live session family in memory.
  pass_record "cookie-presented-to-agent-host-refused" "the exact Worker route refused the explicitly presented live session family with 403 WRONG_PRINCIPAL"
  pass_record "agora-origination" "the exact Agora action rendered one absent-before receipt and its transient fragment completed the exact 202 Worker claim contract"
  # This marker is set only after the runner's strict selector validates the
  # complete cookie object and both exact 403 WRONG_PRINCIPAL probes.
  EVIDENCE_COOKIE_ASSERTIONS_VALIDATED=1
  return 0
}

# ---------------------------------------------------------------------------
# Phase 2 — Worker verification of real signed envelopes
# ---------------------------------------------------------------------------

assert_worker_accepts_valid_envelope() {
  local worker="$1" sponsor="$2" config
  mint_envelope_config GET "$ROUTE_PROPOSALS" "$ACTION_PROPOSALS" "$sponsor" "" || {
    fail_record "worker-accepts-valid-envelope" "the product minter produced no envelope"
    return
  }
  config="$MINTED_CONFIG"
  if http_request GET "${worker}${ROUTE_PROPOSALS}" "" "$config" &&
     validate_http_response proposals-present "$RECEIPT"; then
    pass_record "worker-accepts-valid-envelope" "the deployed Worker verified a product-minted envelope and returned one exact pending attribution card"
    VALID_ENVELOPE_HEADER="$config"
    EVIDENCE_ENVELOPE_METHOD="GET"
    EVIDENCE_ENVELOPE_ACTION="$ACTION_PROPOSALS"
    EVIDENCE_ENVELOPE_PAYLOAD_SHA256="$MINTED_PAYLOAD_SHA256"
    EVIDENCE_ENVELOPE_PRINCIPAL_PSEUDONYM="$MINTED_PRINCIPAL_PSEUDONYM"
    EVIDENCE_ENVELOPE_ROUTE_TEMPLATE="$ROUTE_PROPOSALS"
    EVIDENCE_ENVELOPE_INITIAL_STATUS=200
    EVIDENCE_ENVELOPE_INITIAL_LATENCY_SECONDS="$HTTP_REQUEST_LATENCY_SECONDS"
  else
    fail_record "worker-accepts-valid-envelope" "the signed proposal response failed its exact status/schema/attribution contract"
  fi
}

assert_replay_refused() {
  local worker="$1"
  if [[ -z "$VALID_ENVELOPE_HEADER" ]]; then
    fail_record "envelope-replay-refused" "no accepted envelope to replay"
    return
  fi
  http_request GET "${worker}${ROUTE_PROPOSALS}" "" "$VALID_ENVELOPE_HEADER" || {
    fail_record "envelope-replay-refused" "the replay request did not settle cleanly"
    return
  }
  # Replay, tamper and expiry share one opaque 401 face on purpose (Rule A5):
  # a distinct code per failure mode would be a forgery oracle.
  if validate_http_response problem 401 UNAUTHORIZED; then
    pass_record "envelope-replay-refused" "the second presentation of a single-use nonce was refused 401 UNAUTHORIZED"
    EVIDENCE_ENVELOPE_REPLAY_STATUS=401
    EVIDENCE_ENVELOPE_REPLAY_CODE="UNAUTHORIZED"
    EVIDENCE_ENVELOPE_REPLAY_LATENCY_SECONDS="$HTTP_REQUEST_LATENCY_SECONDS"
  else
    fail_record "envelope-replay-refused" "the replay response failed the exact 401 UNAUTHORIZED ProblemDocument contract"
  fi
}

assert_altered_payload_refused() {
  local worker="$1" sponsor="$2" config
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
  http_request POST "${worker}${ROUTE_MINT}" "${RUN_STATE_DIR}/altered.json" "$config" || {
    fail_record "envelope-altered-payload-refused" "the tamper request did not settle cleanly"
    return
  }
  if validate_http_response problem 401 UNAUTHORIZED; then
    pass_record "envelope-altered-payload-refused" "a body whose digest differs from the signed payload_sha256 was refused 401 UNAUTHORIZED on a POST route that reaches the verifier"
  else
    fail_record "envelope-altered-payload-refused" "the altered payload failed the exact 401 UNAUTHORIZED ProblemDocument contract; routing/content-type refusals are not accepted"
  fi
}

assert_expired_envelope_refused() {
  local worker="$1" sponsor="$2" config
  mint_envelope_config GET "$ROUTE_PROPOSALS" "$ACTION_PROPOSALS" "$sponsor" "" -3600 || {
    fail_record "envelope-expired-refused" "the product minter produced no envelope"
    return
  }
  config="$MINTED_CONFIG"
  http_request GET "${worker}${ROUTE_PROPOSALS}" "" "$config" || {
    fail_record "envelope-expired-refused" "the expired-envelope request did not settle cleanly"
    return
  }
  if validate_http_response problem 401 UNAUTHORIZED; then
    pass_record "envelope-expired-refused" "an envelope one hour past its expiry was refused 401 UNAUTHORIZED"
  else
    fail_record "envelope-expired-refused" "the expiry response failed the exact 401 UNAUTHORIZED ProblemDocument contract"
  fi
}

# ---------------------------------------------------------------------------
# Phase 3 — WRONG_PRINCIPAL direction A, and the non-consultation differential
# ---------------------------------------------------------------------------

assert_bearer_on_sponsor_route_refused() {
  local worker="$1" bearer_config
  # First prove the exact mounted Fellow route rejects an absent credential.
  # Without this causal negative, a public or accidentally permissive hello
  # route could make any configured bearer look live.
  if ! http_request GET "${worker}${ROUTE_HELLO}" "" "" ||
     ! validate_http_response problem 401 UNAUTHORIZED; then
    fail_record "hello-without-credential-refused" "the no-credential control failed the exact 401 UNAUTHORIZED ProblemDocument contract on ${ROUTE_HELLO}"
    fail_record "bearer-live-on-fellow-route" "the Fellow bearer liveness proof is not causal because ${ROUTE_HELLO} did not first refuse an absent credential exactly"
    fail_record "bearer-on-sponsor-route-refused" "the sponsor-route refusal is not evidence because the Fellow bearer was not causally proven live"
    return
  fi
  pass_record "hello-without-credential-refused" "the exact mounted ${ROUTE_HELLO} route refused an absent credential with the exact 401 UNAUTHORIZED ProblemDocument"

  # The exact same bearer first has to prove it is a live Fellow credential on
  # the mounted hello route. A shape-valid garbage token cannot green a
  # refusal-only test. The bearer stays in the anonymous stdin config stream.
  bearer_config="header = \"authorization: Bearer ${ASIMP_S6_FELLOW_TOKEN}\""
  if ! http_request GET "${worker}${ROUTE_HELLO}" "" "$bearer_config" ||
     ! validate_http_response hello; then
    fail_record "bearer-live-on-fellow-route" "the Fellow bearer failed the exact 200 EnrollmentHelloResponse contract"
    fail_record "bearer-on-sponsor-route-refused" "the sponsor-route refusal is not evidence because the bearer was not first proven live"
    return
  fi
  pass_record "bearer-live-on-fellow-route" "the same in-memory bearer received an exact 200 EnrollmentHelloResponse on ${ROUTE_HELLO}"
  if ! http_request GET "${worker}${ROUTE_PROPOSALS}" "" "$bearer_config"; then
    fail_record "bearer-on-sponsor-route-refused" "the sponsor-route bearer request did not settle cleanly"
    return
  fi
  if validate_http_response problem 403 WRONG_PRINCIPAL; then
    pass_record "bearer-on-sponsor-route-refused" "that same live Fellow bearer was refused by ${ROUTE_PROPOSALS} with the exact 403 WRONG_PRINCIPAL ProblemDocument"
  else
    fail_record "bearer-on-sponsor-route-refused" "the sponsor-route response failed the exact 403 WRONG_PRINCIPAL ProblemDocument contract"
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
  local worker="$1"
  if http_request GET "${worker}${ROUTE_PROPOSALS}" "" "" &&
     validate_http_response problem 403 WRONG_PRINCIPAL; then
    pass_record "no-credential-differential" "a sessionless client on ${ROUTE_PROPOSALS} stayed at exactly 403 WRONG_PRINCIPAL, matching the logged-in browser's agent-host result"
  else
    fail_record "no-credential-differential" "the sessionless control failed the exact 403 WRONG_PRINCIPAL ProblemDocument contract"
  fi
}

# ---------------------------------------------------------------------------
# Phase 4 — the receipt is attributed in deployed D1
# ---------------------------------------------------------------------------

assert_receipt_attributed() {
  local worker="$1" sponsor="$2" config other_sponsor
  [[ -n "$RECEIPT" ]] || { fail_record "agora-origination-attributed" "no receipt to confirm"; return; }
  mint_envelope_config GET "$ROUTE_PROPOSALS" "$ACTION_PROPOSALS" "$sponsor" "" || {
    fail_record "agora-origination-attributed" "the product minter produced no envelope"
    return
  }
  config="$MINTED_CONFIG"
  if ! http_request GET "${worker}${ROUTE_PROPOSALS}" "" "$config" ||
     ! validate_http_response proposals-present "$RECEIPT"; then
    fail_record "agora-origination-attributed" "the current sponsor did not receive exactly one matching pending proposal card"
    return
  fi
  pass_record "agora-origination-attributed" "the claimed enrollment appears exactly once as a pending proposal under the minting sponsor"

  other_sponsor="usr_s6_other_sponsor"
  [[ "$other_sponsor" != "$sponsor" ]] || other_sponsor="usr_s6_other_sponsor_2"
  mint_envelope_config GET "$ROUTE_PROPOSALS" "$ACTION_PROPOSALS" "$other_sponsor" "" || {
    fail_record "agora-origination-not-cross-attributed" "the product minter produced no opposite-sponsor envelope"
    return
  }
  config="$MINTED_CONFIG"
  if http_request GET "${worker}${ROUTE_PROPOSALS}" "" "$config" &&
     validate_http_response proposals-absent "$RECEIPT"; then
    pass_record "agora-origination-not-cross-attributed" "a distinct signed sponsor received a valid proposal list with zero cards for the claimed enrollment"
  else
    fail_record "agora-origination-not-cross-attributed" "the opposite-sponsor list was invalid or exposed the claimed enrollment"
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
  local dir="${S6_RUN_RELATIVE_DIRECTORY:-}"
  if ! valid_evidence_directory "${ASIMP_S6_EVIDENCE_DIR:-}" || \
     [[ -z "$dir" || "$dir" != "${ASIMP_S6_EVIDENCE_DIR}/${S6_RUN_ID}" ]] || \
     ! s6_artifact_writer_boundary_is_open; then
    fail_record "evidence-written" "the exclusive run directory or its artifact-root epoch and writer lease could not be revalidated; refusing to seal evidence"
    return 1
  fi
  # A typed provisioning blocker has no complete live tuple. Preserve the
  # blocker and seal nothing; converting it into a partial evidence failure
  # would misclassify unavailable infrastructure as an executed red test.
  [[ -z "$BROWSER_BLOCKED_CODE" ]] || return 0
  local apex_host agent_host
  apex_host="$(origin_host "${ASIMP_S6_PREVIEW_URL:-}")"
  agent_host="$(origin_host "${ASIMP_S6_WORKER_URL:-}")"
  # Revision and provider-native deployment identity are not exposed by either
  # deployed plane today. Preserve that boundary: accept only explicit,
  # tightly typed harness declarations and label both format-only. The exact
  # HTTPS hosts remain separate, observable exercised-origin fields.
  if [[ ! "${ASIMP_S6_REVISION:-}" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ||
        ! "${ASIMP_S6_DEPLOYMENT_ID:-}" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ ]]; then
    fail_record "evidence-written" "revision or deployment provenance was absent or failed the exact harness-input format; refusing to seal evidence"
    return 1
  fi
  # Every request/result field below is latched only after the runner-owned
  # strict validator accepts the actual response. Missing state means the run
  # never proved the tuple and no partial evidence artifact may be written.
  if [[ "$EVIDENCE_COOKIE_ASSERTIONS_VALIDATED" != "1" ||
        "$EVIDENCE_ENVELOPE_METHOD" != "GET" ||
        "$EVIDENCE_ENVELOPE_ACTION" != "$ACTION_PROPOSALS" ||
        ! "$EVIDENCE_ENVELOPE_PAYLOAD_SHA256" =~ ^[0-9a-f]{64}$ ||
        ! "$EVIDENCE_ENVELOPE_PRINCIPAL_PSEUDONYM" =~ ^[0-9a-f]{64}$ ||
        "$EVIDENCE_ENVELOPE_ROUTE_TEMPLATE" != "$ROUTE_PROPOSALS" ||
        "$EVIDENCE_ENVELOPE_INITIAL_STATUS" != "200" ||
        ! "$EVIDENCE_ENVELOPE_INITIAL_LATENCY_SECONDS" =~ ^[0-9]+$ ||
        "$EVIDENCE_ENVELOPE_REPLAY_STATUS" != "401" ||
        "$EVIDENCE_ENVELOPE_REPLAY_CODE" != "UNAUTHORIZED" ||
        ! "$EVIDENCE_ENVELOPE_REPLAY_LATENCY_SECONDS" =~ ^[0-9]+$ ||
        ! "$BROWSER_LEG_LATENCY_SECONDS" =~ ^[0-9]+$ ]]; then
    fail_record "evidence-written" "the validator-backed request, response, cookie, or latency tuple was incomplete; refusing to seal partial evidence"
    return 1
  fi
  if [[ ! -d "$dir" || -L "$dir" ]] || ! s6_artifact_writer_boundary_is_open; then
    fail_record "evidence-written" "the preclaimed evidence run was not the same real repository-local directory before publication"
    return 1
  fi
  # ONE immutable expected tuple feeds both rendering and validation. In
  # particular run_seconds is captured before the validator child starts, so
  # validator startup time cannot make the retained record disagree with its
  # expected value.
  local -r expected_revision="$ASIMP_S6_REVISION"
  local -r expected_deployment_id="$ASIMP_S6_DEPLOYMENT_ID"
  local -r expected_agora_host="$apex_host" expected_stoa_host="$agent_host"
  local -r expected_kid="${ASIMP_S6_SIGNING_KID:-}"
  local -r expected_method="$EVIDENCE_ENVELOPE_METHOD"
  local -r expected_action="$EVIDENCE_ENVELOPE_ACTION"
  local -r expected_payload_sha256="$EVIDENCE_ENVELOPE_PAYLOAD_SHA256"
  local -r expected_principal_pseudonym="$EVIDENCE_ENVELOPE_PRINCIPAL_PSEUDONYM"
  local -r expected_route_template="$EVIDENCE_ENVELOPE_ROUTE_TEMPLATE"
  local -r expected_initial_status="$EVIDENCE_ENVELOPE_INITIAL_STATUS"
  local -r expected_initial_latency_seconds="$EVIDENCE_ENVELOPE_INITIAL_LATENCY_SECONDS"
  local -r expected_replay_status="$EVIDENCE_ENVELOPE_REPLAY_STATUS"
  local -r expected_replay_code="$EVIDENCE_ENVELOPE_REPLAY_CODE"
  local -r expected_replay_latency_seconds="$EVIDENCE_ENVELOPE_REPLAY_LATENCY_SECONDS"
  local -r expected_browser_leg_seconds="$BROWSER_LEG_LATENCY_SECONDS"
  local -r expected_run_seconds="$SECONDS"
  local -r expected_assertions="$ASSERTIONS" expected_failures="$FAILURES"
  local path="${dir}/evidence.json"
  if [[ -e "$path" || -L "$path" ]] || ! s6_artifact_writer_boundary_is_open; then
    fail_record "evidence-written" "an artifact already exists at the allocated evidence path; refusing to overwrite it"
    return 1
  fi
  local previous_umask
  previous_umask="$(umask)"
  umask 077
  (
    set -C
    s6_artifact_writer_boundary_is_open || exit "$EX_CLEANUP_UNPROVEN"
    {
      printf '{"suite":"%s","schema_version":4,"bead":"asimposiumorg-vw3",' "$SUITE"
      printf '"revision":{"value":"%s","source":"required_harness_input","verification":"format_only"},' \
        "$(json_string "$expected_revision")"
      printf '"deployment":{"id":"%s","source":"required_harness_input","verification":"format_only","exercised_origins":{"agora_host":"%s","stoa_host":"%s","source":"exercised_https_origin"}},' \
        "$(json_string "$expected_deployment_id")" \
        "$(json_string "$expected_agora_host")" "$(json_string "$expected_stoa_host")"
      printf '"service_envelope":{"kid":"%s","method":"%s","action":"%s","payload_sha256":"%s","principal_pseudonym":{"scheme":"sha256","value":"%s"},"route_template":"%s",' \
        "$(json_string "$expected_kid")" \
        "$expected_method" \
        "$(json_string "$expected_action")" \
        "$expected_payload_sha256" \
        "$expected_principal_pseudonym" \
        "$(json_string "$expected_route_template")"
      printf '"initial_response":{"status":%s,"code":null,"latency_seconds":%s},"replay_response":{"status":%s,"code":"%s","latency_seconds":%s}},' \
        "$expected_initial_status" "$expected_initial_latency_seconds" \
        "$expected_replay_status" "$expected_replay_code" \
        "$expected_replay_latency_seconds"
      printf '"cookie_assertions":{"host_only":true,"http_only":true,"secure":true,"same_site":"lax","scoped_to_apex":true,"natural_agent_host":{"attached":false,"status":403,"code":"WRONG_PRINCIPAL"},"explicit_agent_host":{"attached":true,"status":403,"code":"WRONG_PRINCIPAL"}},'
      printf '"latency":{"browser_leg_seconds":%s,"run_seconds":%s},"assertions":%s,"failures":%s}\n' \
        "$expected_browser_leg_seconds" "$expected_run_seconds" \
        "$expected_assertions" "$expected_failures"
    } > "$path"
  )
  local wrote=$?
  umask "$previous_umask"
  if (( wrote != 0 )) || [[ ! -f "$path" || ! -s "$path" ]] || \
     ! s6_artifact_writer_boundary_is_open; then
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
  if ! s6_artifact_writer_boundary_is_open || ! validate_evidence_bundle \
    "$path" "$expected_revision" "$expected_deployment_id" \
    "$expected_agora_host" "$expected_stoa_host" "$expected_kid" \
    "$expected_payload_sha256" "$expected_principal_pseudonym" \
    "$expected_initial_latency_seconds" "$expected_replay_latency_seconds" \
    "$expected_browser_leg_seconds" "$expected_run_seconds" \
    "$expected_assertions" "$expected_failures"; then
    fail_record "evidence-written" "the retained evidence bytes failed the bounded shared schema-v4 validator"
    return 1
  fi
  if ! s6_artifact_writer_boundary_is_open; then
    fail_record "evidence-written" "the exact run boundary changed while the retained evidence was being validated"
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
  if (( REAP_SURVIVORS != 0 )); then
    # Same rule as the blocked path: seal nothing while a survivor remains.
    blocked_record "CLEANUP_UNPROVEN" "a child process group survived cleanup; no scan, evidence or verdict was sealed"
    log "FAILED ${SUITE}: cleanup could not be proven; nothing was sealed."
    exit "$EX_CLEANUP_UNPROVEN"
  fi
  # Only a proven-empty owner set can suppress the EXIT reaper.
  CLEANED_UP=1

  # Scan next, then write exactly one bundle whose counts already include both
  # the cleanup verdict and the canary's.
  assert_no_secret_escaped
  write_evidence_bundle
  if [[ -z "$EVIDENCE_PATH" ]]; then
    fail_record "evidence-present-before-pass" "the mandatory evidence bundle was not sealed; refusing to publish a pass terminal"
  fi
  if ! s6_close_artifact_writer_lease_after_settlement; then
    blocked_record "CLEANUP_UNPROVEN" \
      "child groups settled, but the exact artifact writer boundary could not be revalidated and closed after final evidence publication"
    exit "$EX_CLEANUP_UNPROVEN"
  fi
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
  SELF_TEST_MODE=1
  check() {
    if [[ "$2" == "$3" ]]; then
      emit "{\"suite\":\"${SUITE}\",\"assertion\":\"$(json_string "$1")\",\"status\":\"pass\",\"detail\":\"self-test\"}"
    else
      failures=$((failures + 1))
      local got_display="$2"
      # A 125 is honest teardown-unproven; naming the stage makes the late-
      # suite leg diagnosable instead of a mystery status (S-6 RCA, 9ba1).
      if [[ "$2" == "$EX_CLEANUP_UNPROVEN" || "$2" == "$EX_WATCHDOG_UNAVAILABLE" || "$2" == "$EX_INPUT_BOOTSTRAP_UNAVAILABLE" || "$2" == "124" ]]; then
        got_display="$2 (run_bounded_stage=${RUN_BOUNDED_STAGE})"
      fi
      emit "{\"suite\":\"${SUITE}\",\"assertion\":\"$(json_string "$1")\",\"status\":\"fail\",\"detail\":\"expected $(json_string "$3"), got $(json_string "$got_display")\"}"
    fi
  }

  local version_40="accepted" version_41="refused"
  bash_version_supported 4 0 || version_40="refused"
  bash_version_supported 4 1 && version_41="accepted"
  check "bash-4.0-is-typed-unsupported" "$version_40" "refused"
  check "bash-4.1-is-minimum-supported" "$version_41" "accepted"

  # macOS Perl does not expose POSIX::setpgrp, while the portable builtin
  # returns numeric zero on success. Pin both halves of the bootstrap repair:
  # unqualified lookup, and definedness rather than truthiness.
  local supervisor_source setpgrp_source="wrong"
  supervisor_source="$(declare -f run_bounded)"
  if [[ "$supervisor_source" == *"defined(setpgrp(0,0)) or die"* &&
        "$supervisor_source" != *"POSIX::setpgrp(0,0)"* ]]; then
    setpgrp_source="portable-defined-success"
  fi
  check "supervisor-setpgrp-is-portable-defined-success" \
    "$setpgrp_source" "portable-defined-success"

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
    emit "{\"suite\":\"${SUITE}\",\"assertion\":\"$(json_string "$name")\",\"status\":\"pass\",\"detail\":\"self-test\"}"
    return 0
  }

  register_selftest_child() {
    local pid="$1"
    mint_owner_token "selftest"
    register_child "$pid" "$OWNER_TOKEN" "ordinary"
  }

  # Test bookkeeping may never erase an unresolved owner. This fake numeric
  # record is intentionally not a process; it pins the array/refusal polarity
  # without creating anything that cleanup could orphan.
  CHILD_PIDS=(424242)
  CHILD_OWNER_TOKENS=(selftest-retained-owner)
  CHILD_KINDS=(ordinary)
  local refused_clear_status=0
  clear_child_records || refused_clear_status=$?
  check "clear-child-records-refuses-live-owner" \
    "${refused_clear_status}:${#CHILD_PIDS[@]}" "${EX_CLEANUP_UNPROVEN}:1"
  unregister_child 424242

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
  check "json-string-escapes-quote" "$(json_string 'a"b')" 'a\"b'
  check "secret-vars-declared" "${#SECRET_VARS[@]}" "3"

  # Secret bootstrap creates no independent writer owner. It is also the causal
  # companion to the setpgrp source guard above: the same durable supervisor
  # must cross the real Perl -> Bash bootstrap, receive two exact lines, feed
  # them to the payload, then self-signal and be reaped as the only owner.
  clear_child_records
  local bootstrap_out="${TMPDIR:-/tmp}/s6-bootstrap.$$" bootstrap_status=0 bootstrap_value=""
  run_bounded 10 "$bootstrap_out" $'line-one\nline-two' \
    bash -c 'IFS= read -r first; IFS= read -r second; printf "%s|%s" "$first" "$second"' \
    || bootstrap_status=$?
  [[ -f "$bootstrap_out" ]] && bootstrap_value="$(cat "$bootstrap_out" 2>/dev/null || printf '')"
  check "reaper-reports-no-survivors" "${bootstrap_status}:${#CHILD_PIDS[@]}" "0:0"
  check "supervisor-portable-setpgrp-bootstrap" "$bootstrap_status" "0"
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
  SELF_TEST_BOUNDED_OUT="$bounded_out"
  bounded_start="$(date +%s)"
  run_bounded 2 "$bounded_out" - sleep 30 || bounded_status=$?
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
    run_bounded 2 "$bounded_out" - \
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
    run_bounded 2 "$bounded_out" - \
      bash -c 'trap "" TERM; printf ready > "$1"; while :; do sleep 30; done' \
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
  run_bounded 2 "$bounded_out" - sleep 30 || kill_failure_status=$?
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

  # Pre-ready failure: the anonymous coprocess leader departs before publishing
  # readiness. The already-adopted write-only channel either retires it or fails
  # with EPIPE; bounded group absence is required before the direct wait.
  clear_child_records
  local pre_ready_status=0
  SUPERVISOR_READY_WRITE_PLANT=1
  run_bounded 10 "$bounded_out" - true || pre_ready_status=$?
  SUPERVISOR_READY_WRITE_PLANT=0
  check "pre-ready-supervisor-failure-status" "$pre_ready_status" "$EX_WATCHDOG_UNAVAILABLE"
  check "pre-ready-supervisor-failure-reaped" "${#CHILD_PIDS[@]}:${GROUP_CONTROL_PID}" "0:"

  # The payload must not inherit any caller or supervisor descriptor. FD42 is a
  # caller-owned canary above the old fixed close range; the real close-from
  # launcher must make it EBADF along with control/result/recorder FDs 3..9.
  clear_child_records
  local fd_status=0 fd_record=""
  exec 42</dev/null
  run_bounded 10 "$bounded_out" - \
    bash -c 'for fd in 3 4 5 6 7 8 9 42; do if eval ": <&${fd}" 2>/dev/null || eval ": >&${fd}" 2>/dev/null; then printf inherited-%s "$fd"; exit 9; fi; done; printf closed' \
    || fd_status=$?
  exec 42<&-
  [[ -f "$bounded_out" ]] && fd_record="$(cat "$bounded_out" 2>/dev/null || printf '')"
  check "all-nonstandard-fds-not-inherited" "${fd_status}:${fd_record}" "0:closed"

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
    run_bounded 2 "$bounded_out" - \
      bash -c 'trap "exit 0" TERM; printf ready > "$1"; while :; do sleep 30; done' \
      _ "$child_before_ack_ready" || child_before_ack_status=$?
    SUPERVISOR_CHILD_BEFORE_ACK_PLANT=0
  else
    child_before_ack_status="$EX_WATCHDOG_UNAVAILABLE"
  fi
  if await_marker_value "$child_before_ack_ready" "ready"; then
    child_before_ack_ready_value="ready"
  else
    [[ -n "${child_before_ack_ready:-}" && -f "$child_before_ack_ready" ]] && \
      child_before_ack_ready_value="$(cat "$child_before_ack_ready" 2>/dev/null || printf '')"
  fi
  check "child-terminal-before-control-ack-ready" "$child_before_ack_ready_value" "ready"
  check "child-terminal-before-control-ack-is-retained" \
    "${child_before_ack_status}:$((GROUP_QUEUED_CHILD_RECORDS - child_queue_before))" "124:1"

  # The same ordering must work from the EXIT/signal reaper, not only from the
  # run_bounded timeout owner. Suppress its first TERM/KILL commands so a live,
  # cooperative payload remains registered; the disarmed reaper then receives
  # CHILD before TERM ACK and must still retire the exact owner.
  clear_child_records
  local reaper_child_before_ack_status=0 reaper_child_before_ack_records
  local reaper_child_queue_before="$GROUP_QUEUED_CHILD_RECORDS"
  SUPERVISOR_CHILD_BEFORE_ACK_PLANT=1
  SUPERVISOR_EARLY_ACK_PLANT=1
  SIGNAL_TERM_FAILURE_PLANT=1
  SIGNAL_KILL_FAILURE_PLANT=1
  run_bounded 10 "$bounded_out" - \
    bash -c 'trap "exit 0" TERM; while :; do sleep 30; done' \
    || reaper_child_before_ack_status=$?
  reaper_child_before_ack_records="${#CHILD_PIDS[@]}"
  SIGNAL_TERM_FAILURE_PLANT=0
  SIGNAL_KILL_FAILURE_PLANT=0
  SUPERVISOR_EARLY_ACK_PLANT=0
  reap_children
  SUPERVISOR_CHILD_BEFORE_ACK_PLANT=0
  check "reaper-child-before-ack-refusal-retains-owner" \
    "${reaper_child_before_ack_status}:${reaper_child_before_ack_records}" \
    "${EX_CLEANUP_UNPROVEN}:1"
  check "reaper-child-before-ack-is-retired" \
    "${REAP_SURVIVORS}:${#CHILD_PIDS[@]}:$((GROUP_QUEUED_CHILD_RECORDS - reaper_child_queue_before))" \
    "0:0:1"

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

  # Child exit values are data, not lifecycle outcomes. The reserved 124..127
  # wrapper range maps to ordinary failure while the typed globals preserve the
  # exact child status for callers (notably the browser blocked exit 78).
  local planted_child expected_wrapper planted_wrapper
  for planted_child in 0 123 124 125 126 127 255; do
    clear_child_records
    planted_wrapper=0
    SUPERVISOR_CHILD_STATUS_PLANT="$planted_child"
    run_bounded 10 "$bounded_out" - true || planted_wrapper=$?
    if (( planted_child >= 124 && planted_child <= 127 )); then
      expected_wrapper="$EX_FAIL"
    else
      expected_wrapper="$planted_child"
    fi
    check "typed-child-status-${planted_child}" \
      "${planted_wrapper}:${RUN_BOUNDED_OUTCOME}:${RUN_BOUNDED_CHILD_STATUS}" \
      "${expected_wrapper}:child:${planted_child}"
  done
  SUPERVISOR_CHILD_STATUS_PLANT=""

  # A duplicate terminal after a syntactically valid zero is protocol failure,
  # never a green prefix. The second record must be observed before result EOF.
  clear_child_records
  local duplicate_terminal_status=0
  SUPERVISOR_EXTRA_RECORD_PLANT=1
  run_bounded 10 "$bounded_out" - true || duplicate_terminal_status=$?
  SUPERVISOR_EXTRA_RECORD_PLANT=0
  check "duplicate-terminal-record-fails-closed" \
    "$duplicate_terminal_status" "$EX_CLEANUP_UNPROVEN"
  reap_children
  check "duplicate-terminal-owner-reaped-after-refusal" \
    "${REAP_SURVIVORS}:${#CHILD_PIDS[@]}" "0:0"

  # Same-UID hostile target: scan for the rejected named result authority, try
  # to steal/replay a token-bearing record if one exists, inject token-bound
  # success, then really exit 9. Anonymous coprocess pipes leave no pathname to
  # open, so the exact child 9 must remain authoritative.
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
  check "result-token-theft-replay-cannot-green" \
    "${forged_status}:${RUN_BOUNDED_OUTCOME}:${RUN_BOUNDED_CHILD_STATUS}" "9:child:9"

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

  local frame_511 frame_512 frame_boundary=""
  printf -v frame_511 '%*s' 511 ''
  printf -v frame_512 '%*s' 512 ''
  group_frame_size_valid "$frame_511" && frame_boundary="${frame_boundary}accept511:"
  group_frame_size_valid "$frame_512" || frame_boundary="${frame_boundary}refuse512"
  check "input-frame-bound-includes-newline" "$frame_boundary" "accept511:refuse512"

  # Maximum accepted record: many 256-byte physical chunks, every one ACKed,
  # must reconstruct byte-exactly. One byte beyond the record cap is refused
  # before the target can publish its start marker.
  clear_child_records
  local max_record oversized_record max_status=0 max_value="" oversized_status=0
  local oversized_dir oversized_marker oversized_started=""
  printf -v max_record '%*s' 4096 ''
  max_record="${max_record// /x}"
  run_bounded 10 "$bounded_out" "$max_record" \
    bash -c 'IFS= read -r value; printf "%s" "${#value}"' || max_status=$?
  [[ -f "$bounded_out" ]] && max_value="$(cat "$bounded_out" 2>/dev/null || printf '')"
  check "maximum-input-record-is-byte-exact" "${max_status}:${max_value}" "0:4096"

  clear_child_records
  oversized_record="${max_record}x"
  oversized_dir="$(mktemp -d "${TMPDIR:-/tmp}/s6-oversized-input.XXXXXX" 2>/dev/null)" || oversized_dir=""
  oversized_marker="${oversized_dir:+${oversized_dir}/started}"
  if [[ -n "$oversized_marker" ]]; then
    run_bounded 10 "$bounded_out" "$oversized_record" \
      bash -c 'printf started > "$1"' _ "$oversized_marker" || oversized_status=$?
  else
    oversized_status="$EX_WATCHDOG_UNAVAILABLE"
  fi
  [[ -f "$oversized_marker" ]] && oversized_started="started"
  check "oversized-input-refuses-before-target" \
    "${oversized_status}:${oversized_started}" "${EX_INPUT_BOOTSTRAP_UNAVAILABLE}:"

  # Withholding the initial metadata ACK, withholding a middle DATA ACK, and
  # departing between DATA and ACK exercise all bounded bootstrap polarities.
  # The target marker must remain absent in each case.
  local input_fault fault_status fault_started fault_begin fault_elapsed
  for input_fault in start mid depart-mid; do
    clear_child_records
    fault_status=0 fault_started="" fault_begin=$SECONDS
    SUPERVISOR_INPUT_ACK_PLANT="$input_fault"
    if [[ -n "$oversized_marker" ]]; then
      run_bounded 10 "$bounded_out" "$max_record" \
        bash -c 'printf started > "$1"' _ "$oversized_marker" || fault_status=$?
    else
      fault_status="$EX_WATCHDOG_UNAVAILABLE"
    fi
    fault_elapsed=$((SECONDS - fault_begin))
    [[ -f "$oversized_marker" ]] && fault_started="started"
    check "input-${input_fault}-refuses-before-target" \
      "${fault_status}:${fault_started}" "${EX_INPUT_BOOTSTRAP_UNAVAILABLE}:"
    if (( fault_elapsed <= INPUT_BOOTSTRAP_WAIT_SECONDS + 2 )); then
      pass_record "input-${input_fault}-is-bounded" "the per-frame fault refused in ${fault_elapsed}s"
    else
      failures=$((failures + 1))
      fail_record "input-${input_fault}-is-bounded" "the per-frame fault took ${fault_elapsed}s"
    fi
  done
  SUPERVISOR_INPUT_ACK_PLANT=""

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
    # S-6 RCA (9ba1): under load the ack-victim pays a full script re-parse
    # before publishing its pid; 50x0.1s missed real windows. 120x0.1s keeps
    # the fail-closed timeout semantics with sane headroom.
    while (( waited < 120 )); do
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

  local marker_value=""
  await_marker_value() {
    local marker="$1" expected="$2" waited=0
    marker_value=""
    # Same load headroom rationale as await_planted_pid above (9ba1).
    while (( waited < 120 )); do
      if [[ -f "$marker" ]]; then
        marker_value="$(cat "$marker" 2>/dev/null || printf '')"
        [[ "$marker_value" == "$expected" ]] && return 0
      fi
      sleep 0.1
      waited=$((waited + 1))
    done
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
    if await_marker_value "$terminated" "term-observed"; then
      acknowledgement="term-observed"
    else
      [[ -f "$terminated" ]] && acknowledgement="$(cat "$terminated" 2>/dev/null || printf '')"
    fi
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

  # EPERM/other inspection errors are not ESRCH. They must retain ownership and
  # return cleanup-unproven until an exact later inspection can prove absence.
  clear_child_records
  true &
  local inspection_direct_pid=$!
  register_selftest_child "$inspection_direct_pid"
  KERNEL_INSPECTION_FAILURE_PLANT=direct
  local direct_inspection="accepted"
  direct_child_settled_before_wait "$inspection_direct_pid" || direct_inspection="refused"
  check "direct-inspection-error-refuses-settlement" \
    "${direct_inspection}:${#CHILD_PIDS[@]}" "refused:1"
  KERNEL_INSPECTION_FAILURE_PLANT=""
  settle_selftest_child "direct-inspection-error-owner-eventually-reaped" \
    "$inspection_direct_pid" || true

  clear_child_records
  KERNEL_INSPECTION_FAILURE_PLANT=group
  local group_inspection_status=0
  run_bounded 10 "$bounded_out" - bash -c 'exit 0' || group_inspection_status=$?
  check "group-inspection-error-is-cleanup-unproven" "$group_inspection_status" \
    "$EX_CLEANUP_UNPROVEN"
  check "group-inspection-error-retains-owner" "${#CHILD_PIDS[@]}" "1"
  KERNEL_INSPECTION_FAILURE_PLANT=""
  reap_children
  check "group-inspection-error-owner-eventually-reaped" "${#CHILD_PIDS[@]}" "0"

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
  unregister_child "101"
  unregister_child "103"

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
      bash -c "bash \"\$1\" --self-test-ack-victim \"\$2\" \"\$3\" & waited=0; while [[ ! -f \"\$2\" && \$waited -lt 600 ]]; do sleep 0.02; waited=\$((waited + 1)); done; sleep 0.05; ${trailer}" \
      _ "$SCRIPT_SELF" "$marker" "$terminated" || true
    local child=""
    [[ -f "$marker" ]] && child="$(cat "$marker" 2>/dev/null || printf '')"
    judge_plant "$name" "$child" "$terminated"
  }

  sweep_plant "normal-exit-sweeps-group" "exit 0" 10
  sweep_plant "error-exit-sweeps-group" "exit 9" 10
  sweep_plant "timeout-sweeps-group" "sleep 45" 3

  # Deterministic launcher-window plants. Each real signal is exercised both
  # after `$!`/before provisional registration and after ACTIVE is cleared at
  # the handoff/before the latch snapshot. Exact byte comparison requires the
  # one INTERRUPTED record followed by the positive lifecycle terminal, with a
  # final LF and no extra/reordered record.
  registration_signal_plant() {
    local seam="$1" signal="$2" capture ready release payload expected err
    local status=0 dispatch="failed" exact="mismatch" ready_seen=""
    capture="$(new_marker "${seam}-${signal}-capture")" || return 0
    ready="$(new_marker "${seam}-${signal}-ready")" || return 0
    release="$(new_marker "${seam}-${signal}-release")" || return 0
    payload="$(new_marker "${seam}-${signal}-payload")" || return 0
    expected="$(new_marker "${seam}-${signal}-expected")" || return 0
    err="$(new_marker "${seam}-${signal}-err")" || return 0
    /usr/bin/perl -e '$SIG{INT}="DEFAULT"; $SIG{TERM}="DEFAULT"; exec @ARGV or die $!' -- \
      bash "$SCRIPT_SELF" --self-test-registration-signal-victim \
      "$seam" "$ready" "$release" "$payload" >"$capture" 2>"$err" &
    local victim_pid=$!
    register_selftest_child "$victim_pid"
    if await_marker_value "$ready" ready; then
      ready_seen="$marker_value"
      if kill -"$signal" "$victim_pid" 2>/dev/null; then dispatch="sent"; fi
      printf 'release' >"$release"
    fi
    if direct_child_settled_before_wait "$victim_pid"; then
      wait "$victim_pid" 2>/dev/null || status=$?
      unregister_child "$victim_pid"
    else
      status="$EX_CLEANUP_UNPROVEN"
    fi
    printf '%s\n%s\n' \
      "{\"suite\":\"${SUITE}\",\"status\":\"blocked\",\"code\":\"INTERRUPTED\",\"historical_evidence_bead\":\"asimposiumorg-vw3\",\"detail\":\"the run received SIG${signal} and every child process group was reaped\",\"reproduce\":\"${REPRODUCE}\"}" \
      "{\"suite\":\"${SUITE}\",\"record_type\":\"lifecycle-terminal\",\"status\":\"pass\",\"owned_same_process_groups\":\"settled\",\"artifact_writer_lease\":\"closed-or-not-acquired\"}" >"$expected"
    cmp -s "$capture" "$expected" && exact="exact"
    check "${seam}-${signal}-registration-barrier-armed" "$ready_seen" "ready"
    check "${seam}-${signal}-dispatch-succeeded" "$dispatch" "sent"
    check "${seam}-${signal}-is-interruption" "$status" "$EX_FAIL"
    check "${seam}-${signal}-prevents-payload-fork" \
      "$([[ -e "$payload" ]] && printf started || printf absent)" "absent"
    check "${seam}-${signal}-exact-two-record-transcript" "$exact" "exact"
  }
  registration_signal_plant prereg TERM
  registration_signal_plant prereg INT
  registration_signal_plant handoff TERM
  registration_signal_plant handoff INT

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

  # EXIT may not preserve an earlier zero when cleanup authority refuses. The
  # hidden instance retains its controlled owner through both injected command
  # refusals; exact 125 and the typed survivor record must override exit 0.
  local exit_refusal_capture exit_refusal_status=0 exit_refusal_record=""
  exit_refusal_capture="$(new_marker "exit-refusal-capture")" || exit_refusal_capture=""
  if [[ -n "$exit_refusal_capture" ]]; then
    bash "$SCRIPT_SELF" --self-test-exit-refusal-victim >"$exit_refusal_capture" 2>&1 &
    local exit_refusal_pid=$!
    register_selftest_child "$exit_refusal_pid"
    if direct_child_settled_before_wait "$exit_refusal_pid"; then
      wait "$exit_refusal_pid" || exit_refusal_status=$?
      unregister_child "$exit_refusal_pid"
    else
      exit_refusal_status="$EX_CLEANUP_UNPROVEN"
    fi
    exit_refusal_record="$(cat "$exit_refusal_capture" 2>/dev/null || printf '')"
  else
    exit_refusal_status="$EX_FAIL"
  fi
  check "exit-cleanup-refusal-is-exact-125" "$exit_refusal_status" "$EX_CLEANUP_UNPROVEN"
  if [[ "$exit_refusal_record" == *'"assertion":"no-child-survivors","status":"fail"'* ]]; then
    pass_record "exit-cleanup-refusal-publishes-no-survivor" "the EXIT owner published its typed refusal"
  else
    failures=$((failures + 1))
    fail_record "exit-cleanup-refusal-publishes-no-survivor" "the EXIT owner omitted its typed refusal"
  fi

  # A second signal arrives only after on_signal has installed its latch and
  # published the cleanup-started barrier. Even if the first cleanup succeeds,
  # that second signal must override the tidy interruption with exact 125.
  local multi_capture multi_ready multi_cleanup multi_status=0 multi_record=""
  local multi_ready_seen="" multi_cleanup_seen=""
  multi_capture="$(new_marker "multi-capture")" || multi_capture=""
  multi_ready="$(new_marker "multi-ready")" || multi_ready=""
  multi_cleanup="$(new_marker "multi-cleanup")" || multi_cleanup=""
  if [[ -n "$multi_capture" && -n "$multi_ready" && -n "$multi_cleanup" ]]; then
    bash "$SCRIPT_SELF" --self-test-multi-signal-victim \
      "$multi_cleanup" "$multi_ready" >"$multi_capture" 2>&1 &
    local multi_pid=$!
    register_selftest_child "$multi_pid"
    if await_marker_value "$multi_ready" ready; then
      multi_ready_seen="$marker_value"
      kill -TERM "$multi_pid" 2>/dev/null || true
    fi
    if await_marker_value "$multi_cleanup" cleanup-started; then
      multi_cleanup_seen="$marker_value"
      kill -TERM "$multi_pid" 2>/dev/null || true
    fi
    if direct_child_settled_before_wait "$multi_pid"; then
      wait "$multi_pid" || multi_status=$?
      unregister_child "$multi_pid"
    else
      multi_status="$EX_CLEANUP_UNPROVEN"
    fi
    multi_record="$(cat "$multi_capture" 2>/dev/null || printf '')"
  else
    multi_status="$EX_FAIL"
  fi
  check "multi-signal-cleanup-barriers-armed" \
    "${multi_ready_seen}:${multi_cleanup_seen}" "ready:cleanup-started"
  check "second-signal-during-cleanup-is-exact-125" "$multi_status" "$EX_CLEANUP_UNPROVEN"
  if [[ "$multi_record" == *'"code":"CLEANUP_UNPROVEN"'* ]]; then
    pass_record "second-signal-during-cleanup-publishes-refusal" "the second signal overrode tidy interruption"
  else
    failures=$((failures + 1))
    fail_record "second-signal-during-cleanup-publishes-refusal" "the second signal did not publish cleanup-unproven"
  fi

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
  run_bounded 2 "$bounded_out" - \
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
    body='printf "%s" "$$" >"$1"; env | grep -E "^(ASIMP_S6_|S6_CTL_CANARY=)" | grep -c "$4" >"$2" 2>/dev/null || printf 0 >"$2"; while [ ! -e "$3" ]; do sleep 0.05; done'
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

  reap_children
  if (( REAP_SURVIVORS != 0 || ${#CHILD_PIDS[@]} != 0 )); then
    emit "{\"suite\":\"${SUITE}\",\"status\":\"blocked\",\"code\":\"CLEANUP_UNPROVEN\",\"self_test\":true}"
    exit "$EX_CLEANUP_UNPROVEN"
  fi
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

  if ! initialize_repository_paths; then
    blocked_record "REPOSITORY_ROOT_INVALID" \
      "the canonical script path, repository root, or shared artifact diagnostics library was unavailable"
    CLEANED_UP=1
    exit "$EX_CONFIG"
  fi

  # One exact, provider-free supervisor bootstrap for focused portability and
  # fd-handoff diagnosis. It exercises the production run_bounded path without
  # entering the full self-test or reading any live credential.
  if [[ "${1:-}" == "--self-test-supervisor-bootstrap" ]]; then
    local bootstrap_status=0 bootstrap_outcome bootstrap_stage bootstrap_record
    local bootstrap_transcript_plant="${2:-canonical}"
    clear_child_records
    run_bounded 5 /dev/null - /usr/bin/true || bootstrap_status=$?
    bootstrap_outcome="$RUN_BOUNDED_OUTCOME"
    bootstrap_stage="$RUN_BOUNDED_STAGE"
    reap_children
    if (( REAP_SURVIVORS != 0 || ${#CHILD_PIDS[@]} != 0 )); then
      emit "{\"suite\":\"${SUITE}\",\"assertion\":\"supervisor-bootstrap-only\",\"status\":\"fail\",\"code\":\"CLEANUP_UNPROVEN\",\"run_status\":${bootstrap_status},\"outcome\":\"$(json_string "$bootstrap_outcome")\",\"stage\":\"$(json_string "$bootstrap_stage")\"}"
      exit "$EX_CLEANUP_UNPROVEN"
    fi
    CLEANED_UP=1
    if (( bootstrap_status == 0 )) && [[ "$bootstrap_outcome" == "child" ]]; then
      bootstrap_record="{\"suite\":\"${SUITE}\",\"assertion\":\"supervisor-bootstrap-only\",\"status\":\"pass\",\"run_status\":0,\"outcome\":\"child\",\"stage\":\"$(json_string "$bootstrap_stage")\"}"
      case "$bootstrap_transcript_plant" in
        canonical)
          emit "$bootstrap_record"
          ;;
        partial)
          printf '%s' "$bootstrap_record"
          ;;
        duplicate)
          printf '%s\n%s\n' "$bootstrap_record" "$bootstrap_record"
          ;;
        trailing)
          printf '%s\n\n' "$bootstrap_record"
          ;;
        malformed)
          printf '\377\n'
          ;;
        bom)
          printf '\357\273\277%s\n' "$bootstrap_record"
          ;;
        dead-stream)
          exec >/dev/null
          ;;
        *)
          emit "{\"suite\":\"${SUITE}\",\"assertion\":\"supervisor-bootstrap-only\",\"status\":\"fail\",\"code\":\"UNKNOWN_TRANSCRIPT_PLANT\"}"
          exit "$EX_CONFIG"
          ;;
      esac
      exit 0
    fi
    emit "{\"suite\":\"${SUITE}\",\"assertion\":\"supervisor-bootstrap-only\",\"status\":\"fail\",\"code\":\"BOOTSTRAP_UNAVAILABLE\",\"run_status\":${bootstrap_status},\"outcome\":\"$(json_string "$bootstrap_outcome")\",\"stage\":\"$(json_string "$bootstrap_stage")\"}"
    exit "$bootstrap_status"
  fi

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
    rm -f "$hold_fifo" 2>/dev/null || true
    mkfifo -m 600 "$hold_fifo" || exit "$EX_FAIL"
    exec 6<>"$hold_fifo" || exit "$EX_FAIL"
    printf '%s' "$BASHPID" > "$ready_marker"
    while :; do IFS= read -r -t 3600 _ <&6 || true; done
  fi

  # Hidden hostile-target mode. It receives only a non-secret search root. If a
  # rejected named result stream ever reappears, it opens that path RDWR, steals
  # and replays the first token-bearing record, injects token-bound success, and
  # then really exits 9. With the anonymous coprocess transport there is no path.
  if [[ "${1:-}" == "--self-test-forge-result" ]]; then
    local search_root="${2:?search root required}" candidate record token
    for candidate in "$search_root"/s6-watchdog.*/result; do
      [[ -p "$candidate" ]] || continue
      exec 41<>"$candidate" 2>/dev/null || continue
      if IFS= read -r -t 1 record <&41; then
        token="${record#*:}"
        token="${token%%:*}"
        printf '%s\nchild:%s:0\n' "$record" "$token" >&41 2>/dev/null || true
      fi
      exec 41>&- 41<&-
    done
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

  # Hidden launcher-window polarity. `prereg` pauses after `$!` and before
  # provisional registration; `handoff` pauses immediately after ACTIVE=0 and
  # before the pending latch snapshot. Both occur before START can fork payload.
  if [[ "${1:-}" == "--self-test-registration-signal-victim" ]]; then
    local registration_seam="${2:?registration seam required}"
    local registration_ready="${3:?ready marker required}"
    local registration_release="${4:?release marker required}"
    local prereg_payload_marker="${5:?payload marker required}"
    case "$registration_seam" in
      prereg)
        SPAWN_REGISTRATION_READY_MARKER="$registration_ready"
        SPAWN_REGISTRATION_RELEASE_MARKER="$registration_release"
        ;;
      handoff)
        SPAWN_HANDOFF_READY_MARKER="$registration_ready"
        SPAWN_HANDOFF_RELEASE_MARKER="$registration_release"
        ;;
      *) exit "$EX_FAIL" ;;
    esac
    # No payload has been forked at either barrier, so there is no cooperative
    # child terminal to await during the causal plant's retirement grace.
    REAP_GRACE_SECONDS=0
    run_bounded 45 /dev/null - \
      bash -c 'printf started >"$1"; while :; do IFS= read -r -t 30 _; __rc=$?; (( __rc == 0 || __rc > 128 )) || break; done' \
      _ "$prereg_payload_marker" || true
    exit 0
  fi

  # Hidden EXIT-refusal polarity. The injected early protocol record makes the
  # parent refuse while a TERM-resistant payload remains live; both control
  # commands refuse, so EXIT must preserve the owner and override the requested
  # zero with exact cleanup-unproven 125. Pipe EOF then makes the durable
  # supervisor self-retire without numeric fallback.
  if [[ "${1:-}" == "--self-test-exit-refusal-victim" ]]; then
    REAP_GRACE_SECONDS=0
    CHILD_SETTLE_ATTEMPTS=2
    SUPERVISOR_EARLY_ACK_PLANT=1
    SIGNAL_TERM_FAILURE_PLANT=1
    SIGNAL_KILL_FAILURE_PLANT=1
    run_bounded 10 /dev/null - \
      bash -c 'trap "" TERM; while :; do IFS= read -r -t 30 _; __rc=$?; (( __rc == 0 || __rc > 128 )) || break; done' || true
    exit 0
  fi

  # Hidden two-signal polarity. The target is ready before the first signal;
  # on_signal publishes its cleanup barrier only after installing the second-
  # signal latch. A second TERM during the bounded grace must force exact 125
  # even when the first cleanup otherwise proves the group empty.
  if [[ "${1:-}" == "--self-test-multi-signal-victim" ]]; then
    SIGNAL_CLEANUP_MARKER="${2:?cleanup marker required}"
    local multi_ready="${3:?ready marker required}"
    REAP_GRACE_SECONDS=2
    run_bounded 45 /dev/null - \
      bash -c 'trap "" TERM; printf ready > "$1"; while :; do sleep 30; done' \
      _ "$multi_ready" || true
    exit 0
  fi

  if [[ "${1:-}" == "--self-test" || "${S6_SELF_TEST:-}" == "1" ]]; then
    # Only the outermost self-test runs the suite. Every process this suite
    # spawns inherits S6_SELF_TEST=1, so without this gate a descendant that
    # reaches here starts a whole new suite -- the 2026-08-25 fork bomb.
    if [[ "$SELF_TEST_NESTED" != "0" ]]; then
      # NEVER a silent `exit 0` here. A bare success with zero assertions run is
      # indistinguishable from a real pass to anything reading the exit code, and
      # the EXIT trap would publish a `lifecycle-terminal status:pass` on top of
      # it. Refuse as BLOCKED (EX_CONFIG, the suite's own "did not determine
      # anything" code) so a leaked S6_SELF_TEST_NESTED can never green a gate.
      blocked_record "SELF_TEST_NESTED_REFUSED" \
        "S6_SELF_TEST_NESTED is set, so this invocation is a descendant of a running self-test and must not start a second suite."
      CLEANED_UP=1
      exit "$EX_CONFIG"
    fi
    export S6_SELF_TEST_NESTED=1
    self_test
  fi

  local missing=()
  while IFS= read -r line; do missing+=("$line"); done < <(missing_vars)

  if (( ${#missing[@]} > 0 )); then
    local csv="" name
    for name in "${missing[@]}"; do csv+="${csv:+,}\"${name}\""; done
    emit_blocked_env_record "$csv"
    log "BLOCKED ${SUITE}: required external harness inputs were not supplied."
    log "  missing environment: ${missing[*]}"
    log "  blocked on: supply every named input for the configured paired Agora and"
    log "              Worker target; this run did not determine provider state."
    log "  this script has no offline or fixture mode on purpose: the whole point of S-6"
    log "  is a claim about running infrastructure, and configuration or a mock cannot"
    log "  make that claim."
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
  if [[ ! "$ASIMP_S6_REVISION" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]]; then
    blocked_record "REVISION_INVALID" "ASIMP_S6_REVISION must be one lowercase 40- or 64-hex harness-declared source revision"
    CLEANED_UP=1; exit "$EX_CONFIG"
  fi
  if [[ ! "$ASIMP_S6_DEPLOYMENT_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ ]]; then
    blocked_record "DEPLOYMENT_ID_INVALID" "ASIMP_S6_DEPLOYMENT_ID must be one non-secret 1-128 byte harness-declared identifier using only alphanumerics, dot, underscore, colon, and hyphen"
    CLEANED_UP=1; exit "$EX_CONFIG"
  fi
  if ! valid_evidence_directory "$ASIMP_S6_EVIDENCE_DIR" ||
     evidence_directory_has_symlink_component; then
    blocked_record "EVIDENCE_DIR_INVALID" "ASIMP_S6_EVIDENCE_DIR must be exactly e2e/artifacts/s6-cross-plane-auth with no symlink component"
    CLEANED_UP=1; exit "$EX_CONFIG"
  fi

  if ! s6_claim_artifact_run; then
    blocked_record "ARTIFACT_RUN_CLAIM_FAILED" \
      "the exclusive S-6 run directory and artifact-root writer lease could not be claimed before product work"
    exit "$EX_CONFIG"
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
    if (( REAP_SURVIVORS != 0 )); then
      # NOTHING is sealed while a survivor remains: no scan, no evidence
      # artifact, no pass/fail bundle. A fixed typed refusal is the only output,
      # because an immutable record written now would describe a run whose own
      # cleanup is still unresolved.
      blocked_record "CLEANUP_UNPROVEN" "a child process group survived cleanup; no scan, evidence or verdict was sealed"
      log "FAILED ${SUITE}: cleanup could not be proven; nothing was sealed."
      exit "$EX_CLEANUP_UNPROVEN"
    fi
    CLEANED_UP=1
    assert_no_secret_escaped
    write_evidence_bundle
    if ! s6_close_artifact_writer_lease_after_settlement; then
      blocked_record "CLEANUP_UNPROVEN" \
        "child groups settled, but the exact artifact writer boundary could not be revalidated and closed after the blocked browser path"
      exit "$EX_CLEANUP_UNPROVEN"
    fi
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
