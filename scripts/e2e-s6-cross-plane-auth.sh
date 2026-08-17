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
# Job control puts every background job in its own process group whose id equals
# the job's pid. That is what makes `kill -- -PID` reach Chromium and every other
# descendant, rather than only the direct child this script forked.
set -m

readonly SUITE="s6-cross-plane-auth"
readonly EX_CONFIG=78
readonly EX_FAIL=1
# A child was reaped but its process group could not be proven empty.
# Distinct from a plain failure so no caller can read it as success.
readonly EX_CLEANUP_UNPROVEN=125
# The bound could not be armed (no watchdog flag, or the child is not its own
# group leader). Fail closed: an unbounded child is never acceptable.
readonly EX_WATCHDOG_UNAVAILABLE=126
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
VALID_ENVELOPE_HEADER=""
RECEIPT=""

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

# ---------------------------------------------------------------------------
# Lifecycle: one cleanup path for success, failure, INT and TERM
# ---------------------------------------------------------------------------

CLEANED_UP=0

# Signal a whole process GROUP, not one pid.
#
# Playwright launches Chromium as a grandchild and the minter can fork; killing
# only the direct pid leaves those descendants running. `set -m` puts each
# background job in its own group whose id equals the job's pid, which is what
# makes the negative-pid form address every descendant.
# GROUP ONLY, never a bare pid.
#
# Every child this script tracks is a backgrounded job under `set -m`, so each
# is its own group leader and `-PID` addresses it exactly. A bare-pid fallback
# would fire in precisely the dangerous case: the group has already gone, the
# record has not yet been removed, and the number now belongs to something else.
# If the group is gone there is nothing left to signal, and that is the correct
# outcome rather than a second guess.
signal_group() {
  local pid="$1" signal="$2"
  kill "-${signal}" -- "-${pid}" 2>/dev/null || true
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
unregister_child() {
  local pid="$1" kept=() current
  for current in ${CHILD_PIDS[@]+"${CHILD_PIDS[@]}"}; do
    [[ "$current" == "$pid" ]] && continue
    kept+=("$current")
  done
  CHILD_PIDS=(${kept[@]+"${kept[@]}"})
}

# True while any recorded group still has a member alive.
#
# Group-only for the same reason as `signal_group`: a bare-pid probe would
# classify an unrelated process that reused a departed child's number as our
# survivor, and report a cleanup failure that is not ours.
group_alive() {
  local pid
  for pid in ${CHILD_PIDS[@]+"${CHILD_PIDS[@]}"}; do
    kill -0 -- "-${pid}" 2>/dev/null && return 0
  done
  return 1
}

# Sets REAP_SURVIVORS. It must NOT print its result: a caller writing
# `survivors="$(reap_children)"` would run the whole reap — every `wait`
# included — inside a subshell, so the parent would never actually reap the
# children it owns.
REAP_SURVIVORS=0

reap_children() {
  # Every child this script starts is recorded, its whole group is signalled,
  # then verified gone. A harness that leaves a browser behind turns the next
  # run's timing into somebody else's problem.
  local pid
  REAP_SURVIVORS=0
  for pid in ${CHILD_PIDS[@]+"${CHILD_PIDS[@]}"}; do
    signal_group "$pid" TERM
  done
  # Wall-clock grace, not an iteration count.
  local grace_until=$(( $(date +%s) + 5 ))
  while (( $(date +%s) < grace_until )); do
    group_alive || break
    sleep 0.1
  done
  for pid in ${CHILD_PIDS[@]+"${CHILD_PIDS[@]}"}; do
    signal_group "$pid" KILL
    wait "$pid" 2>/dev/null || true
  done
  if group_alive; then REAP_SURVIVORS=1; fi
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
  blocked_record "INTERRUPTED" "the run received SIG${signal} and terminated its children"
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

# Deliver ONE record to a child's stdin and then CLOSE, so the child can see EOF.
#
# The previous design held the write end open in the parent with `exec 7<>fifo`
# across `run_bounded`. Two writers therefore survived for the child's whole
# life: the parent's, and the copy the child itself inherited (bash's
# exec-opened descriptors are not close-on-exec). A reader that reads to EOF —
# every one of ours, plus `curl --config -` — could never observe it, so the
# minter and the browser would block until their bound expired. That is a
# deadlock, not a transport.
#
# A short-lived writer process fixes it: it opens the FIFO, writes the record,
# and exits. The rendezvous is what orders it — the writer's open blocks until
# the child opens for reading, and vice versa — so nothing has to be open in
# advance. The parent holds no descriptor, and the child inherits none.
#
# `printf` is a builtin, so the record never becomes an argv anywhere.
SECRET_WRITER_PID=""
start_secret_writer() {
  local fifo="$1" record="$2"
  ( printf '%s\n' "$record" > "$fifo" ) &
  SECRET_WRITER_PID=$!
  CHILD_PIDS+=("$SECRET_WRITER_PID")
}

# Reap the writer once the child has consumed the record.
finish_secret_writer() {
  [[ -n "$SECRET_WRITER_PID" ]] || return 0
  wait "$SECRET_WRITER_PID" 2>/dev/null || true
  # Same rule as any other child: the record goes as soon as the reap is proven.
  unregister_child "$SECRET_WRITER_PID"
  SECRET_WRITER_PID=""
}

# Allocate a private FIFO for one bounded secret record. Sets SECRET_FIFO.
# A FIFO has no backing store, so the record never lands on disk.
SECRET_FIFO=""
new_secret_fifo() {
  local dir
  dir="$(mktemp -d "${RUN_STATE_DIR:-${TMPDIR:-/tmp}}/s6-secrets.XXXXXX" 2>/dev/null)" || return 1
  chmod 700 "$dir" 2>/dev/null || true
  SECRET_FIFO="${dir}/record"
  mkfifo -m 600 "$SECRET_FIFO" 2>/dev/null || return 1
}

# run_bounded <seconds> <stdout_file> <command...>
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
  if [[ "$stdin_file" == "-" ]]; then
    "$@" >"$stdout_file" </dev/null &
  else
    "$@" >"$stdout_file" <"$stdin_file" &
  fi
  local pid=$!
  CHILD_PIDS+=("$pid")
  # NO POLLING. An owned watchdog enforces the bound while the parent blocks in
  # `wait`, which reaps the instant the child exits.
  #
  # The previous loop polled `kill -0`, which reports an exited-but-unreaped
  # child as alive on macOS, so every fast success waited out its whole bound
  # and came back 124. Polling `/bin/ps` instead fixed that but introduced a
  # worse property: an unbounded external observer on every tick, mapping any
  # ps stall or transient failure to "exited" — fail-open, and able to drop the
  # loop into a bare `wait` with no bound at all. Blocking in `wait` and letting
  # a watchdog own the clock needs no inspection of any kind.
  # The watchdog needs its flag before it can be trusted to report a timeout,
  # and the child's process GROUP must exist before anything may be signalled.
  # Both are proven up front; neither is allowed to degrade silently.
  local dog_dir flag=""
  dog_dir="$(mktemp -d "${TMPDIR:-/tmp}/s6-watchdog.XXXXXX" 2>/dev/null)" || dog_dir=""
  if [[ -z "$dog_dir" ]]; then
    signal_group "$pid" KILL
    wait "$pid" 2>/dev/null || true
    return "$EX_WATCHDOG_UNAVAILABLE"
  fi
  flag="${dog_dir}/timed-out"
  # No group-existence precondition here. A fast child can finish before this
  # line runs, and its group is then legitimately gone — treating that as
  # "cannot arm" turned every quick success into a typed failure. Group-only
  # signalling is already safe in that case: `kill -- -PID` simply finds nothing
  # rather than addressing a reused bare pid.

  (
    sleep "$seconds"
    printf 'x' > "$flag"
    # GROUP ONLY. A bare-pid fallback would, once the leader has exited and been
    # reaped, address whatever process later inherited that number.
    kill -TERM -- "-${pid}" 2>/dev/null || true
    sleep 3
    kill -KILL -- "-${pid}" 2>/dev/null || true
  ) &
  local dog=$!
  CHILD_PIDS+=("$dog")

  local status=0
  wait "$pid" || status=$?

  # Retire the watchdog whether or not it fired.
  #
  # This is the one place a direct pid signal is provably safe, and it must be
  # used: `$dog` is our own subshell, still UNREAPED at this instant, so the
  # number cannot yet belong to anything else — the pid-reuse hazard applies to
  # stale records, not to a child we are about to `wait` on. Group-only here was
  # a real regression: a subshell is not reliably its own group leader, so the
  # signal missed, `wait` blocked for the watchdog's full sleep, and every fast
  # child came back 124 after ~33s.
  kill -TERM -- "-${dog}" 2>/dev/null || kill -TERM "$dog" 2>/dev/null || true
  wait "$dog" 2>/dev/null || true
  unregister_child "$dog"

  # The direct child is reaped; its descendants may not be. Ownership is
  # surrendered ONLY when both are proven done.
  #
  # Dropping the record after a FAILED sweep was worse than not sweeping: it
  # erased the one thing that let the EXIT trap try again, and allowed a status
  # 0 to be returned while a survivor was still running. A sweep that cannot
  # prove the group empty therefore keeps the record armed and returns a
  # distinct code, so no caller can read the result as success.
  if sweep_group "$pid"; then
    unregister_child "$pid"
  else
    return "$EX_CLEANUP_UNPROVEN"
  fi

  if [[ -n "$flag" && -f "$flag" ]]; then return 124; fi
  return "$status"
}

# Terminate any survivor still in a finished child's group, and PROVE the group
# is gone before returning. Returning right after sending KILL would report
# success while the kernel had not yet reaped anything.
# Returns 0 when the group is empty, 1 when a member outlived the kill.
sweep_group() {
  local pid="$1"
  kill -0 -- "-${pid}" 2>/dev/null || return 0
  signal_group "$pid" TERM
  local until_at=$((SECONDS + 2))
  while kill -0 -- "-${pid}" 2>/dev/null && (( SECONDS < until_at )); do sleep 0.1; done
  signal_group "$pid" KILL
  # Post-KILL confirmation: SIGKILL is delivered asynchronously.
  until_at=$((SECONDS + 3))
  while kill -0 -- "-${pid}" 2>/dev/null && (( SECONDS < until_at )); do sleep 0.1; done
  if kill -0 -- "-${pid}" 2>/dev/null; then
    return 1
  fi
  return 0
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
  # The config document (which may carry a bearer) travels on the same private
  # FIFO transport the minter uses: never an argv, never an environ, never disk.
  HTTP_RESPONSE=""
  local out_dir out_file
  out_dir="$(mktemp -d "${RUN_STATE_DIR:-${TMPDIR:-/tmp}}/http.XXXXXX" 2>/dev/null)" || return 1
  chmod 700 "$out_dir" 2>/dev/null || true
  out_file="${out_dir}/response"

  new_secret_fifo || return 1
  local secrets="$SECRET_FIFO"
  start_secret_writer "$secrets" "$config"

  minimal_env_command curl "${args[@]}" "$url"
  # The bound is the request's own max-time plus a small settling margin, so a
  # wedged curl is retired by the owner rather than by its internal timer.
  # The child's EXACT status decides whether the response may be used. `|| true`
  # discarded it, so a request that timed out (124), left cleanup unproven (125)
  # or could not be bounded (126) still handed its partial bytes to the caller
  # and the phase went green on them.
  local rc=0
  run_bounded "$((max_time + 5))" "$out_file" "$secrets" "${MINIMAL_CMD[@]}" 2>/dev/null || rc=$?
  finish_secret_writer
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
    if (error?.code === "EAGAIN") continue;
    if (error?.code === "EOF") break;
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
  new_secret_fifo || { exec 9>&-; exec 8<&-; return 1; }
  local secrets="$SECRET_FIFO"
  start_secret_writer "$secrets" "$(printf '%s\t%s' "$ASIMP_S6_SIGNING_KEY_HEX" "$ASIMP_S6_SIGNING_KID")"

  minimal_env_command bun "${RUN_STATE_DIR}/mint-envelope.mjs" \
    "$method" "$route" "$action" "$principal" "$body" "$skew"
  local status=0
  run_bounded "$bound" "$fifo" "$secrets" "${MINIMAL_CMD[@]}" \
    2>>"${RUN_STATE_DIR}/mint.err" || status=$?
  finish_secret_writer
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
}
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
    blocked_record "BROWSER_RUNNER_MISSING" "the browser leg requires ${PLAYWRIGHT_RUNNER}"
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
  new_secret_fifo || { fail_record "browser-leg" "could not allocate the secret transport"; return 1; }
  local secrets="$SECRET_FIFO" config_record
  config_record="$(printf '{"previewUrl":"%s","workerUrl":"%s","user":"%s","password":"%s"}' \
    "$(json_string "$ASIMP_S6_PREVIEW_URL")" "$(json_string "$ASIMP_S6_WORKER_URL")" \
    "$(json_string "$ASIMP_S6_TEST_GOOGLE_USER")" "$(json_string "$ASIMP_S6_TEST_GOOGLE_PASS")")"
  start_secret_writer "$secrets" "$config_record"

  minimal_env_command bun "$PLAYWRIGHT_RUNNER"
  run_bounded "$bound" "$out_file" "$secrets" "${MINIMAL_CMD[@]}" \
    2>"${RUN_STATE_DIR}/browser.err" || status=$?
  finish_secret_writer

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
    blocked_record "BROWSER_LEG_BLOCKED" "the browser leg could not run: $(problem_code "$record")"
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

  # Immutable deployment evidence pins this report to one deployment.
  local deployment
  deployment="$(printf '%s' "$record" | sed -n 's/.*"deployment":"\([^"]\{1,200\}\)".*/\1/p')"
  if [[ -z "$deployment" ]]; then
    fail_record "deployment-identified" "the browser leg reported no deployment identifier from the serving edge"
  else
    pass_record "deployment-identified" "the run is pinned to deployment ${deployment}"
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
scan_regular_files_for() {
  local needle="$1"
  shift
  local file
  while IFS= read -r -d '' file; do
    grep -qF -- "$needle" "$file" 2>/dev/null && return 0
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
  if (( hits == 0 )); then
    pass_record "no-secret-escaped" "no never-log value appears in any retained artifact"
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
    fail_record "no-child-survivors" "a child process group survived cleanup; no pass may be published"
  fi
  # The EXIT trap must not repeat the reap it has already been given.
  CLEANED_UP=1

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
  check() {
    if [[ "$2" == "$3" ]]; then
      emit "{\"suite\":\"${SUITE}\",\"assertion\":\"$(json_string "$1")\",\"status\":\"pass\",\"detail\":\"self-test\"}"
    else
      failures=$((failures + 1))
      emit "{\"suite\":\"${SUITE}\",\"assertion\":\"$(json_string "$1")\",\"status\":\"fail\",\"detail\":\"expected $(json_string "$3"), got $(json_string "$2")\"}"
    fi
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

  # Causal: the reaper must actually terminate a live child and report zero
  # survivors. A cleanup path asserted only by reading the source is not a
  # cleanup path.
  CHILD_PIDS=()
  sleep 30 &
  local victim=$!
  CHILD_PIDS+=("$victim")
  reap_children
  check "reaper-reports-no-survivors" "$REAP_SURVIVORS" "0"
  if kill -0 "$victim" 2>/dev/null; then
    failures=$((failures + 1))
    emit "{\"suite\":\"${SUITE}\",\"assertion\":\"reaper-actually-kills\",\"status\":\"fail\",\"detail\":\"the child survived\"}"
  else
    emit "{\"suite\":\"${SUITE}\",\"assertion\":\"reaper-actually-kills\",\"status\":\"pass\",\"detail\":\"self-test\"}"
  fi

  # Causal: run_bounded must stop a child that outlives its bound and report
  # 124, and it must do so on the CLOCK. An iteration-counting bound drifts far
  # past its nominal limit once per-iteration work is counted.
  CHILD_PIDS=()
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
  CHILD_PIDS=()
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

  # $1 assertion name, $2 marker, $3 the pid that had to be live beforehand.
  judge_plant() {
    local name="$1" child="$2"
    if [[ ! "$child" =~ ^[0-9]+$ ]]; then
      failures=$((failures + 1))
      emit "{\"suite\":\"${SUITE}\",\"assertion\":\"${name}\",\"status\":\"fail\",\"detail\":\"no numeric descendant pid was planted, so the plant proved nothing\"}"
      return 0
    fi
    if kill -0 "$child" 2>/dev/null; then
      kill -KILL "$child" 2>/dev/null || true
      failures=$((failures + 1))
      emit "{\"suite\":\"${SUITE}\",\"assertion\":\"${name}\",\"status\":\"fail\",\"detail\":\"a proven-live descendant survived cleanup\"}"
    else
      emit "{\"suite\":\"${SUITE}\",\"assertion\":\"${name}\",\"status\":\"pass\",\"detail\":\"self-test\"}"
    fi
  }

  CHILD_PIDS=()
  local marker
  marker="$(new_marker "group")" || marker=""
  # shellcheck disable=SC2016 # The inner bash must expand $! and $1, not this one.
  bash -c 'sleep 45 & echo $! > "$1"; sleep 45' _ "$marker" &
  local group_leader=$!
  CHILD_PIDS+=("$group_leader")
  local grandchild=""
  if await_planted_pid "$marker" && kill -0 "$plant_pid" 2>/dev/null; then
    grandchild="$plant_pid"
  fi
  if [[ -z "$grandchild" ]]; then
    failures=$((failures + 1))
    emit "{\"suite\":\"${SUITE}\",\"assertion\":\"reaper-kills-descendants\",\"status\":\"fail\",\"detail\":\"the descendant was never live before the reap, so the plant proved nothing\"}"
    reap_children
  else
    reap_children
    judge_plant "reaper-kills-descendants" "$grandchild"
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
  CHILD_PIDS=()
  sleep 5 &
  local reg_victim=$!
  CHILD_PIDS+=("$reg_victim")
  local armed="${#CHILD_PIDS[@]}"
  kill -KILL "$reg_victim" 2>/dev/null || true
  wait "$reg_victim" 2>/dev/null || true
  unregister_child "$reg_victim"
  check "child-record-armed-then-disarmed" "${armed}:${#CHILD_PIDS[@]}" "1:0"

  # Negative: unregister must remove ONLY the exact numeric pid. A value with
  # glob or regex characters must not match, and must not remove a real entry.
  CHILD_PIDS=(101 102 103)
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
  # Backgrounding the plant would put `run_bounded` in a subshell where job
  # control assigns no fresh process group, so `kill -- -PID` would address the
  # wrong group and the plant would fail for a reason the production path does
  # not have.
  #
  # Liveness is therefore proven by the CHILD, which only writes the marker once
  # it has confirmed its own descendant is running. A marker holding a numeric
  # pid is thus evidence the sleeper was alive while the group was intact.
  #
  # $1 assertion name, $2 the trailing statement for the child, $3 the bound.
  sweep_plant() {
    local name="$1" trailer="$2" bound="$3"
    local marker
    marker="$(new_marker "sweep-${name}")" || return 0
    CHILD_PIDS=()
    # shellcheck disable=SC2016 # The inner bash must expand its own $! and $1.
    run_bounded "$bound" "$bounded_out" - \
      bash -c "sleep 45 & sleeper=\$!; kill -0 \"\$sleeper\" 2>/dev/null && printf '%s' \"\$sleeper\" > \"\$1\"; ${trailer}" \
      _ "$marker" || true
    local child=""
    [[ -f "$marker" ]] && child="$(cat "$marker" 2>/dev/null || printf '')"
    judge_plant "$name" "$child"
  }

  sweep_plant "normal-exit-sweeps-group" "exit 0" 10
  sweep_plant "error-exit-sweeps-group" "exit 9" 10
  sweep_plant "timeout-sweeps-group" "sleep 45" 1

  # Causal: the TERM trap must reap a live descendant. A nested instance holds a
  # sleeper and waits; signalling it exercises on_signal against a real group.
  local signal_marker
  signal_marker="$(new_marker "signal")" || signal_marker=""
  bash "$SCRIPT_SELF" --self-test-signal-victim "$signal_marker" >/dev/null 2>&1 &
  local victim=$!
  local signal_child=""
  if await_planted_pid "$signal_marker" && kill -0 "$plant_pid" 2>/dev/null; then
    signal_child="$plant_pid"
  fi
  kill -TERM "$victim" 2>/dev/null || true
  wait "$victim" 2>/dev/null || true
  local settle=$((SECONDS + 5))
  while [[ -n "$signal_child" ]] && kill -0 "$signal_child" 2>/dev/null && (( SECONDS < settle )); do
    sleep 0.1
  done
  judge_plant "term-signal-reaps-descendants" "$signal_child"

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

    CHILD_PIDS=()
    ASIMP_S6_SIGNING_KEY_HEX="planted-key-canary-0123456789abcdef" \
    ASIMP_S6_TEST_GOOGLE_PASS="planted-pass-canary-0123456789abcdef" \
      "${launch[@]}" &
    local launcher=$!
    CHILD_PIDS+=("$launcher")
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
    kill -TERM "$launcher" 2>/dev/null || true
    wait "$launcher" 2>/dev/null || true
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
      CHILD_PIDS=()
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
        CHILD_PIDS=()
        if ASIMP_S6_SIGNING_KEY_HEX="$(printf '1%.0s' {1..64})" \
           ASIMP_S6_SIGNING_KID="s6-selftest" \
           mint_envelope_config GET "$ROUTE_PROPOSALS" "$ACTION_PROPOSALS" usr_selftest ""; then
          case "$MINTED_CONFIG" in
            'header = "asimp-service-envelope: {'*) shim_verdict="mints" ;;
            *) shim_verdict="malformed-output" ;;
          esac
        else
          shim_verdict="did-not-mint"
        fi
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
  CHILD_PIDS=()
  local liar_status=0
  run_bounded 1 "$bounded_out" - \
    bash -c 'printf "%s\n" "{\"suite\":\"s6-cross-plane-browser\",\"status\":\"pass\"}"; sleep 45' \
    || liar_status=$?
  check "convincing-output-then-timeout-is-not-success" "$liar_status" "124"

  CHILD_PIDS=()
  local liar2_status=0
  run_bounded 10 "$bounded_out" - \
    bash -c 'printf "%s\n" "{\"suite\":\"s6-cross-plane-browser\",\"status\":\"pass\"}"; exit 3' \
    || liar2_status=$?
  check "convincing-output-then-failure-is-not-success" "$liar2_status" "3"

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
  # Hidden mode used only by the signal plant: hold a live descendant and wait
  # to be signalled, so the INT/TERM trap can be exercised against a real group.
  if [[ "${1:-}" == "--self-test-signal-victim" ]]; then
    local victim_marker="${2:?marker required}"
    sleep 45 &
    local sleeper=$!
    CHILD_PIDS+=("$sleeper")
    kill -0 "$sleeper" 2>/dev/null && printf '%s' "$sleeper" > "$victim_marker"
    sleep 45
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
    assert_no_secret_escaped
    write_evidence_bundle
    [[ -n "$EVIDENCE_PATH" ]] && log "${SUITE}: evidence at ${EVIDENCE_PATH}"
    if (( FAILURES > 0 )); then
      emit "{\"suite\":\"${SUITE}\",\"status\":\"fail\",\"assertions\":${ASSERTIONS},\"failures\":${FAILURES},\"reproduce\":\"${REPRODUCE}\"}"
      log "FAILED ${SUITE}: ${FAILURES} of ${ASSERTIONS} assertions failed."
      exit "$EX_FAIL"
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
