#!/usr/bin/env bash
# Fable §5.2 / S-1 cold-enrollment runner.
#
# This script deliberately keeps credentials in process memory and JSON POST
# bodies. It retains local-state artifacts, but a token, fragment secret, or flow
# handle must never become a path, query string, log, or retained test result.
#
# ## Lifecycle contract for the local-D1 mode
#
# The local mode starts a real `wrangler dev` (workerd) child and must not leave
# it behind, must not collide with a parallel run, and must not mistake somebody
# else's server for its own:
#
#   * the loopback port is allocated dynamically and proven free before use; a
#     caller-pinned `S1_LOCAL_PORT` is validated and refused when busy, rather
#     than handed to wrangler to fail on later;
#   * `--inspector-port 0` so two runs do not fight over the debugger port;
#   * readiness is tied to *our* child: the child must still be alive, the
#     server must answer, and a mint carrying this run's unique token must be
#     visible in this run's own persisted D1 state. A foreign server holding the
#     port writes to its own state and is refused;
#   * the child runs in its own process group (`set -m`), and every exit path —
#     success, failure, INT, TERM — terminates that whole group with a bounded
#     TERM then KILL, so workerd grandchildren cannot be orphaned;
#   * every curl carries connect and total timeouts, readiness has a deadline,
#     and the client run has an overall deadline.
#
# The per-run state directory is deliberately RETAINED on every path, including
# interruption. It holds local workerd state and phase logs, never credentials,
# and AGENTS.md forbids cleanup-by-deletion.
set -euo pipefail
umask 077

# A bare shell status is not actionable evidence. Log only the failing line and
# status: never BASH_COMMAND, because later commands carry enrollment secrets in
# environment variables and request bodies. Bash suppresses ERR for failures
# that are explicitly handled by if/while/&&/||, so planted refusals stay quiet.
trap 'status=$?; printf "[%s] shell-error status=%s line=%s\n" "s1-cold-enrollment" "$status" "$LINENO" >&2; exit "$status"' ERR

readonly SUITE="s1-cold-enrollment"
readonly VERSION="1"
readonly REPRODUCE="scripts/e2e-s1-cold-enrollment.sh"
readonly BLOCKED_EXIT_CODE=78
readonly HARNESS_IDENTITIES=("claude-code" "codex" "gemini-cli")
readonly LOCAL_WRANGLER="apps/wire/node_modules/.bin/wrangler"
# Local-D1-only deterministic test binding. Production must inject a distinct
# secret binding; the Worker fails closed when this binding is absent.
readonly LOCAL_REPLAY_KEY="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

# Bounds. Every one of these exists so a wedged child cannot hold a gate open.
readonly CONNECT_TIMEOUT_SECONDS=3
readonly REQUEST_TIMEOUT_SECONDS=15
readonly READINESS_DEADLINE_SECONDS=45
readonly CLIENT_DEADLINE_SECONDS=180
readonly SUPERVISOR_STOP_DEADLINE_SECONDS=10
readonly TERMINATION_GRACE_SECONDS=5
readonly TRANSIENT_INSPECTION_DEADLINE_SECONDS=1
readonly FIXTURE_START_DEADLINE_SECONDS=10
readonly SELF_TEST_CONTROLLER_DEADLINE_SECONDS=10
readonly EXIT_CLEANUP_ATTEMPTS=2
readonly PORT_ALLOCATION_ATTEMPTS=40
readonly EPHEMERAL_PORT_FLOOR=20000
readonly EPHEMERAL_PORT_SPAN=20000

# Mutable lifecycle state, read by the traps. SERVER_PGID is the process group
# *proven* to belong to the child at spawn time; it stays set after the leader
# exits, because that is exactly when cleanup still has descendants to reach and
# can no longer derive the group from the leader.
SERVER_PID=""
SERVER_PGID=""
SERVER_IDENTITY=""
SERVER_MARKER=""
SERVER_STATUS_FILE=""
SERVER_STATUS_AUTH=""
# The timed client phase runs in its own process group. It is tracked here so an
# interrupt arriving mid-phase terminates that group too, instead of orphaning it.
CLIENT_PID=""
CLIENT_PGID=""
CLIENT_IDENTITY=""
CLIENT_MARKER=""
CLIENT_STATUS_FILE=""
CLIENT_STATUS_AUTH=""
STATE_DIR=""
PHASE_LOG=""
# Resolved by `resolve_port` / `resolve_run_token`, which refuse in this shell
# rather than inside a command substitution. See the comment on `allocate_port`.
RESOLVED_PORT=""
RUN_TOKEN=""
# Fault injection is test-only and deliberately disarmed while a fixture is
# started. A caller cannot turn a real local-D1 run into a synthetic failure by
# inheriting this environment variable.
SELF_TEST_MODE=""
FAULT_ACTIVE=0
FAULT_ONCE_MARKER=""
FIXTURE_DESCENDANT=""
# The only synthetic table corruption is a real row omission from an otherwise
# valid `ps` snapshot. It is populated only after a fixture descendant exists.
PS_PARTIAL_OMIT_PID=""
PS_PARTIAL_OMISSION_MARKER=""
# From before `&` until caller adoption, signals are deferred. Bash cannot make
# `$!`, its marker, its birth identity, CONT release, a function return, and the
# caller's CLIENT/SERVER assignments one indivisible command; this explicit
# critical section makes them one lifecycle transaction instead. The first
# deferred signal is dispatched only after ownership is safely adopted.
LIFECYCLE_CRITICAL=0
PENDING_INTERRUPT=""
INTERRUPT_TERMINAL_CODE=""
PROVISIONAL_PID=""
PROVISIONAL_PGID=""
PROVISIONAL_IDENTITY=""
PROVISIONAL_MARKER=""
PROVISIONAL_LABEL=""
PROVISIONAL_STATUS_FILE=""
PROVISIONAL_STATUS_AUTH=""

started_ms() {
  local seconds
  seconds="$(date +%s)"
  printf '%s000' "$seconds"
}

STARTED_MS="$(started_ms)"
readonly STARTED_MS

duration_ms() {
  local now
  now="$(started_ms)"
  printf '%s' "$((now - STARTED_MS))"
}

# Transient inspection is allowed a very short retry window, but it must be a
# single absolute high-resolution deadline. `SECONDS` advances only on whole
# seconds, which can almost double a one-second retry budget depending on where
# the first observation lands. Bash 5 exposes microsecond wall time directly;
# the Perl fallback preserves the same contract on older Bash installations.
# A clock failure ends the retry window rather than turning an unknown process
# state into an unbounded wait or an absence claim.
absolute_time_us() {
  local seconds fraction value
  if [[ "${EPOCHREALTIME:-}" =~ ^([0-9]+)\.([0-9]{1,6})$ ]]; then
    seconds="${BASH_REMATCH[1]}"
    fraction="${BASH_REMATCH[2]}"
    while ((${#fraction} < 6)); do fraction+="0"; done
    printf '%s%s' "$seconds" "$fraction"
    return 0
  fi
  value="$(perl -MTime::HiRes=gettimeofday -e '@now = gettimeofday; printf "%d", $now[0] * 1_000_000 + $now[1]' 2>/dev/null)" || return 1
  [[ "$value" =~ ^[0-9]+$ ]] || return 1
  printf '%s' "$value"
}

transient_retry_deadline_us() {
  local now
  now="$(absolute_time_us)" || return 1
  [[ "$now" =~ ^[0-9]+$ ]] || return 1
  printf '%s' "$((now + TRANSIENT_INSPECTION_DEADLINE_SECONDS * 1000000))"
}

# Returns success only when the absolute retry deadline has passed. A clock
# read failure is deliberately treated as elapsed so retry callers fail closed.
transient_retry_deadline_elapsed() {
  local deadline="$1" now
  [[ "$deadline" =~ ^[0-9]+$ ]] || return 0
  now="$(absolute_time_us)" || return 0
  [[ "$now" =~ ^[0-9]+$ ]] || return 0
  ((now >= deadline))
}

# All values here are caller-independent constants. Do not add request values,
# URLs, headers, handles, registration bodies, or credentials to this record.
emit() {
  local status="$1"
  local code="$2"
  printf '{"tool":"curl+bun","package":"e2e","suite":"%s","version":"%s","duration_ms":%s,"status":"%s","code":"%s","reproduce":"%s"}\n' \
    "$SUITE" "$VERSION" "$(duration_ms)" "$status" "$code" "$REPRODUCE"
}

# Phase logging goes to the retained state directory and to stderr. It records
# lifecycle facts only: phase, port, pid, elapsed. Never a credential, never a
# response body, never the replay key.
log_phase() {
  local phase="$1"
  local detail="${2:-}"
  local line
  line="$(printf '[%s] %s %s' "$SUITE" "$phase" "$detail")"
  printf '%s\n' "$line" >&2
  if [[ -n "$PHASE_LOG" && -f "$PHASE_LOG" ]]; then
    printf '%s\n' "$line" >>"$PHASE_LOG" 2>/dev/null || true
  fi
}

blocked() {
  local code="$1"
  printf 'BLOCKED %s: %s\n' "$SUITE" "$code" >&2
  emit "blocked" "$code"
  exit "$BLOCKED_EXIT_CODE"
}

failed() {
  local code="$1"
  printf 'FAILED %s: %s\n' "$SUITE" "$code" >&2
  emit "fail" "$code"
  exit 1
}

# The retained directory is private state for this shell invocation. A status
# authenticator is meaningful only while its parent remains a real,
# owner-controlled directory; a symlinked or foreign directory makes every
# status observation untrusted.
private_state_directory() {
  [[ -n "$STATE_DIR" && -d "$STATE_DIR" && ! -L "$STATE_DIR" && -O "$STATE_DIR" && -r "$STATE_DIR" && -w "$STATE_DIR" && -x "$STATE_DIR" ]]
}

# Failure-only fault injection, only for a named self-test mode. These hooks
# model a process table that cannot prove completeness; they never fabricate a
# smaller table and let the runner call that complete. `ps-once` is persisted in
# the retained self-test state so an EXIT trap really exercises its retry.
fault_active() {
  local kind="$1"
  [[ -n "$SELF_TEST_MODE" && "$FAULT_ACTIVE" == "1" ]] || return 1
  case "${S1_FAULT_INJECT:-}" in
    ps-once)
      [[ "$kind" == "ps-once" ]] || return 1
      [[ -n "$FAULT_ONCE_MARKER" ]] || return 1
      [[ -e "$FAULT_ONCE_MARKER" ]] && return 1
      : >"$FAULT_ONCE_MARKER"
      return 0
      ;;
    "$kind") return 0 ;;
    *) return 1 ;;
  esac
}

ps_table_unavailable() {
  # `ps-once` must make the first *table* read fail. That makes the first
  # cleanup refusal observable, and lets the EXIT trap's second pass prove the
  # same retained group only after the one-shot fault has been consumed.
  fault_active ps-unreadable || fault_active ps-once
}

identity_unavailable() {
  # The launch fault is armed only after the provisional birth identity has
  # been captured. That lets the planted proof failure exercise the same safe
  # direct-reap path as a later transient inspection failure; an actually
  # unavailable first observation still leaves no identity and authorizes no
  # signal.
  if [[ -n "$PROVISIONAL_IDENTITY" ]] && fault_active identity-unavailable; then
    return 0
  fi
  fault_active ps-unreadable
}

# Returns 0 only when the target still exists, 1 only for an explicit ESRCH
# result, and 2 for EPERM or any other inspection failure. Shell `kill -0` maps
# ESRCH and EPERM to the same non-zero status, which is not enough information
# for a cleanup gate: an inaccessible process must stay unknown, never be
# treated as absent. The Bun probe writes its private state marker only to this
# command substitution; an exit status alone is never absence evidence.
kernel_signal_zero_state() {
  local target="${1:-}" result="" status=0 probe_fault=""
  [[ "$target" =~ ^-?[1-9][0-9]*$ ]] || return 2
  if [[ -n "$SELF_TEST_MODE" && "${S1_KERNEL_PROBE_FAULT:-}" == "bun-exit-1" ]]; then
    probe_fault="bun-exit-1"
  fi
  result="$(S1_KERNEL_PROBE_FAULT="$probe_fault" bun -e '
const target = Number(process.argv[1]);
if (process.env.S1_KERNEL_PROBE_FAULT === "bun-exit-1") process.exit(1);
if (!Number.isSafeInteger(target) || target === 0) process.exit(2);
try {
  process.kill(target, 0);
  process.stdout.write("s1-kernel-probe:present");
} catch (error) {
  if (error && typeof error === "object" && error.code === "ESRCH") {
    process.stdout.write("s1-kernel-probe:esrch");
  } else {
    process.stdout.write("s1-kernel-probe:unknown");
  }
}
' -- "$target" 2>/dev/null)" || status=$?
  ((status == 0)) || return 2
  case "$result" in
    s1-kernel-probe:present) return 0 ;;
    s1-kernel-probe:esrch) return 1 ;;
    *) return 2 ;;
  esac
}

# One validated snapshot of the process table.
#
# The distinction this exists to preserve is *unknown* versus *empty*. `ps` can
# fail, be truncated, or be unavailable under a restrictive sandbox, and every
# liveness question in this file is asked in order to decide whether cleanup may
# stop. An unreadable table read as "no processes" is therefore a false green with
# a live child behind it. So: a table must be non-empty and must contain this very
# runner, or it is not a table and callers are told so.
ps_table() {
  local table filtered
  ps_table_unavailable && return 1
  table="$(ps -A -o pid=,ppid=,pgid=,stat= 2>/dev/null)" || return 1
  [[ -n "$table" ]] || return 1
  # These mutations happen before validation and exercise the actual parser
  # rejection path. The first places a malformed row after the runner row (the
  # ordering that exposed END overriding an early awk exit); the second models
  # a snapshot cut off in the middle of its final record.
  if fault_active ps-malformed-after-self; then
    table="$(printf '%s\n' "$table" | awk -v self="$$" '
      $1 == self { print; print "MALFORMED AFTER SELF"; injected = 1; next }
      { print }
      END { if (!injected) exit 1 }
    ')" || return 1
  elif fault_active ps-truncated-tail; then
    table="${table}"$'\n''999999 1'
  elif fault_active ps-truncated-before-self; then
    # A syntactically valid prefix can still be truncated before the runner.
    # This exercises the production `found_self` check rather than a malformed
    # record branch; do not replace it with a fabricated bad row.
    table="$(printf '%s\n' "$table" | awk -v self="$$" '
      $1 == self { found = 1; exit }
      { print }
      END { if (!found) exit 1 }
    ')" || return 1
    [[ -n "$table" ]] || return 1
  fi
  printf '%s\n' "$table" |
    awk -v self="$$" '
      {
        # Some host `ps` implementations legitimately report an inaccessible
        # unrelated process as a one-character `?` state. It is still a full
        # row, and treating it as a malformed snapshot makes cleanup depend on
        # ambient process churn. In a target group it remains non-zombie and
        # therefore conservatively live below.
        if (NF != 4 || $1 !~ /^[0-9]+$/ || $2 !~ /^[0-9]+$/ || $3 !~ /^[0-9]+$/ || $4 !~ /^([[:alpha:]][^[:space:]]*|[?])$/) {
          malformed = 1
        } else if ($1 == self) {
          found_self = 1
        }
      }
      # Do not exit from a record action: awk still runs END, so the complete
      # parser verdict is decided exactly once here after every row was seen.
      END {
        if (malformed || !found_self) exit 1
        exit 0
      }
    ' || return 1
  # A table can be syntactically valid yet omit exactly the descendant whose
  # continued liveness matters. Model that real failure shape by removing a
  # known fixture row only after validating the unmodified snapshot. Callers
  # must not infer completeness merely because the runner and leader remain.
  if fault_active ps-partial; then
    [[ "$PS_PARTIAL_OMIT_PID" =~ ^[0-9]+$ ]] || return 1
    filtered="$(printf '%s\n' "$table" | awk -v omit="$PS_PARTIAL_OMIT_PID" '$1 != omit')"
    # Once cleanup has actually killed the planted descendant, the next genuine
    # snapshot no longer contains its row. That is a complete empty-after-KILL
    # observation, not a reason to fabricate a fresh inspection failure.
    if [[ "$filtered" != "$table" ]]; then
      table="$filtered"
      if [[ -n "$PS_PARTIAL_OMISSION_MARKER" ]]; then : >"$PS_PARTIAL_OMISSION_MARKER"; fi
    fi
  fi
  printf '%s\n' "$table"
}

# A pid is not an identity. The only workload signals in this file target a
# recorded process group, never an enumerated pid. Its leader still needs an
# identity, so a recycled PGID is not mistaken for the direct child we launched.
#
# Returns 1 when no such process exists, and 2 when inspection is unavailable —
# callers must not collapse those two, because the first is "nothing to do" and
# the second is "do not touch anything".
process_identity() {
  local identity marker="${2:-}" argv status=0 liveness=0
  [[ -n "${1:-}" ]] || return 1
  identity_unavailable && return 2
  # PGID, start time, and command remain stable for a live group leader. PPID is
  # intentionally excluded: during an EXIT trap the shell may already have begun
  # reparenting children, and treating that expected change as PID reuse would
  # withhold cleanup from the very group we proved at launch.
  identity="$(ps -p "$1" -o pgid=,lstart=,comm= 2>/dev/null)" || status=$?
  if ((status != 0)); then
    # `ps -p` exits non-zero for "no such process" and for a real failure alike.
    # Signal 0 distinguishes an extant-but-uninspectable process without changing
    # it. Only a positively absent pid is a mismatch; an extant pid stays unknown
    # so bounded callers can retry and persistent unknown authorizes no signal.
    kernel_signal_zero_state "$1" || liveness=$?
    ((liveness == 1)) || return 2
    if ps -p "$$" -o pid= >/dev/null 2>&1; then return 1; fi
    return 2
  fi
  identity="$(printf '%s' "$identity" | tr -s '[:space:]' ' ')"
  [[ -n "${identity// /}" ]] || return 2
  if [[ -n "$marker" ]]; then
    argv="$(ps -p "$1" -o args= 2>/dev/null)" || return 2
    # The marker is generated from /dev/urandom and passed as bash's $0. It is
    # therefore present in argv before the payload is released, while lstart
    # remains the independent birth identity for a recycled numeric PID/PGID.
    [[ "$argv" == *"$marker"* ]] || return 1
  fi
  printf '%s' "$identity"
}

# The process group id of a pid; non-zero when the process is gone, the pid is not
# a pid, or the table cannot be read. Silent, because it runs inside a command
# substitution.
process_group_of() {
  local table pgid deadline="" ps_once_armed=0
  deadline="$(transient_retry_deadline_us)" || return 1
  if [[ "${S1_FAULT_INJECT:-}" == "ps-once" && "$FAULT_ACTIVE" == "1" &&
    -n "$FAULT_ONCE_MARKER" && ! -e "$FAULT_ONCE_MARKER" ]]; then
    ps_once_armed=1
  fi
  while :; do
    table="$(ps_table)" || table=""
    if [[ -n "$table" ]]; then
      pgid="$(printf '%s' "$table" | awk -v want="$1" '$1 == want { print $3; exit }')"
      if [[ "$pgid" =~ ^[0-9]+$ ]]; then
        printf '%s' "$pgid"
        return 0
      fi
    fi
    # Preserve only the pass that began with the one-shot table fault armed.
    # Once the marker was consumed, a later cleanup pass must get ordinary
    # bounded retries for unrelated transient inspection failures.
    ((ps_once_armed == 0)) || return 1
    transient_retry_deadline_elapsed "$deadline" && break
    sleep 0.02
  done
  return 1
}

# True only when `pid` provably leads its own process group and that group is not
# this script's own. Ownership must be established *before* any group signal:
# `kill -- -PID` on a pid that is not a group leader either names no group at all
# or, if job control did not take effect, names the group this runner is in — so
# an unchecked group TERM is how a runner kills its own parent shell, or a
# stranger's process once the pid has been reaped and the id reused.
owns_process_group() {
  local pid="$1" pgid mine
  pgid="$(process_group_of "$pid")" || return 1
  [[ "$pgid" == "$pid" ]] || return 1
  mine="$(process_group_of "$$")" || return 1
  [[ "$pgid" != "$mine" ]]
}

# Live (non-zombie) members of a process group. Non-zero means *unknown*, which is
# never the same answer as an empty list.
#
# Zombies must be excluded, and that is the other half of this check: an
# exited-but-unreaped leader still answers `kill -0`, so a liveness test built on
# signals reports a group as alive because of a corpse, and — worse — reports the
# leader as alive while saying nothing about the descendants that actually hold
# the port. `stat` is the only thing that distinguishes the two.
live_group_members() {
  local table
  table="$(ps_table)" || return 1
  printf '%s' "$table" | awk -v want="$1" '$3 == want && $4 !~ /Z/ { print $1 }'
}

# A real `ps` snapshot can fail transiently under concurrent process churn. The
# production pre-signal gate retries that unknown for a small fixed bound. The
# planted `ps-once` mode intentionally represents a whole failed cleanup pass,
# so it remains single-attempt and continues to exercise EXIT ownership retry.
live_group_members_bounded() {
  local pgid="$1" members="" deadline="" ps_once_armed=0
  deadline="$(transient_retry_deadline_us)" || return 1
  if [[ "${S1_FAULT_INJECT:-}" == "ps-once" && "$FAULT_ACTIVE" == "1" &&
    -n "$FAULT_ONCE_MARKER" && ! -e "$FAULT_ONCE_MARKER" ]]; then
    ps_once_armed=1
  fi
  while :; do
    if members="$(live_group_members "$pgid")"; then
      printf '%s' "$members"
      return 0
    fi
    # See process_group_of: a consumed `ps-once` fault is no longer a reason to
    # turn later cleanup observation into a one-shot fail-early path.
    ((ps_once_armed == 0)) || return 1
    transient_retry_deadline_elapsed "$deadline" && break
    sleep 0.02
  done
  return 1
}

# The subset of a pid list that is alive and not a zombie, from one validated
# snapshot. Non-zero means unknown, not empty.
live_pids() {
  local table
  table="$(ps_table)" || return 1
  printf '%s' "$table" | awk -v list="$1" '
    BEGIN {
      count = split(list, wanted, /[ \t\n]+/)
      for (index_ = 1; index_ <= count; index_ += 1) if (wanted[index_] != "") want[wanted[index_]] = 1
    }
    ($1 in want) && $4 !~ /Z/ { printf "%s ", $1 }'
}

# Live and not a zombie. Returns 2 when inspection is unavailable, so callers can
# refuse rather than guess in either direction.
pid_is_live() {
  local live
  live="$(live_pids "$1")" || return 2
  [[ -n "${live// /}" ]]
}

# A just-reaped process can race one process-table snapshot. Preserve the three
# liveness states while giving a transiently unavailable table a small bounded
# retry window; absence is never inferred from an unreadable snapshot.
wait_for_pid_live() {
  local pid="$1" deadline="" status=0
  deadline="$(transient_retry_deadline_us)" || return 2
  while :; do
    status=0
    pid_is_live "$pid" || status=$?
    ((status == 0)) && return 0
    ((status == 1)) && return 1
    transient_retry_deadline_elapsed "$deadline" && break
    sleep 0.02
  done
  return 2
}

wait_for_pid_absence() {
  local pid="$1" deadline="" status=0 saw_live=0
  deadline="$(transient_retry_deadline_us)" || return 2
  while :; do
    status=0
    pid_is_live "$pid" || status=$?
    # Preserve pid_is_live's tri-state contract: 1 is the only confirmed
    # absence, 0 means still live, and 2 remains inspection-unknown.
    ((status == 1)) && return 1
    ((status == 0)) && saw_live=1
    transient_retry_deadline_elapsed "$deadline" && break
    sleep 0.02
  done
  ((saw_live == 1)) && return 0
  return 2
}

# The pre-exec supervisor intentionally stops itself before it can launch the
# real client. A CONT sent before this positive observation could be lost to the
# later STOP, so release is gated on an actual stopped row in a valid table.
supervisor_is_stopped() {
  local table
  fault_active supervisor-not-stopped && return 1
  table="$(ps_table)" || return 2
  printf '%s' "$table" | awk -v want="$1" '$1 == want && $4 ~ /T/ { found = 1 } END { exit(found ? 0 : 1) }'
}

commas() {
  printf '%s' "$1" | tr '\n' ' ' | tr -s ' ' ',' | sed 's/^,//; s/,$//'
}

# Whether a specific pid is a live member of a group. 2 means unknown.
group_contains() {
  local pgid="$1"
  local wanted="$2"
  local members pid
  members="$(live_group_members_bounded "$pgid")" || return 2
  for pid in $members; do
    if [[ "$pid" == "$wanted" ]]; then return 0; fi
  done
  return 1
}

# Whether a process group can still be attributed to the *live pinned supervisor*
# proved at spawn. A recorded numeric PGID is never sufficient: once the leader
# exits, the old group can empty and that number can be recycled between a table
# lookup and `kill -- -PGID`. Leader absence is therefore an authorization failure,
# not evidence that a remnant is still ours.
group_is_ours() {
  local pgid="$1"
  local expected="$2"
  local marker="${3:-}"
  local identity status=0 deadline=""
  [[ -n "$pgid" ]] || return 1
  [[ -n "$marker" ]] || return 1
  [[ -n "$expected" ]] || return 1
  deadline="$(transient_retry_deadline_us)" || return 1
  while :; do
    status=0
    identity="$(process_identity "$pgid" "$marker")" || status=$?
    if ((status == 0)); then
      [[ "$identity" == "$expected" ]]
      return
    fi
    if ((status == 1)); then return 1; fi
    transient_retry_deadline_elapsed "$deadline" && break
    sleep 0.02
  done
  return 1
}

# `ps` reports observations, not a kernel guarantee that a process group is
# empty. Signal 0 to a group is the independent kernel-side check. Return 0 for
# present, 1 for positively absent (ESRCH), and 2 for EPERM or another unknown
# condition; only 1 may satisfy an absence gate.
kernel_group_state() {
  local pgid="$1"
  [[ "$pgid" =~ ^[1-9][0-9]*$ ]] || return 2
  kernel_signal_zero_state "-$pgid"
}

kernel_group_absent() {
  local state=0
  kernel_group_state "$1" || state=$?
  ((state == 1))
}

# Reap the direct supervisor and then require both independent views to agree:
# the validated process table has no live member and the kernel has no group.
# This is deliberately bounded; a KILL that cannot be observed as gone is not a
# successful cleanup claim.
wait_for_group_absence() {
  local leader="$1"
  local pgid="$2"
  local label="$3"
  local deadline=$((SECONDS + TERMINATION_GRACE_SECONDS)) members=""
  local inspection_failures=0 observed_table=0 kernel_state=2 kernel_detail="unknown"

  wait "$leader" 2>/dev/null || true
  while ((SECONDS < deadline)); do
    if ! members="$(live_group_members_bounded "$pgid")"; then
      # Process exit can race a full `ps` snapshot and make that one snapshot
      # structurally incomplete. Unknown is still not empty: keep the bounded
      # absence gate open for a later valid observation, and fail closed if no
      # valid table arrives before the deadline.
      inspection_failures=$((inspection_failures + 1))
      sleep 0.1
      continue
    fi
    observed_table=1
    kernel_state=0
    kernel_group_state "$pgid" || kernel_state=$?
    case "$kernel_state" in
      0) kernel_detail="present" ;;
      1) kernel_detail="absent" ;;
      *) kernel_detail="unknown" ;;
    esac
    if [[ -z "$members" && "$kernel_state" == "1" ]]; then
      return 0
    fi
    sleep 0.1
  done
  if ((observed_table == 0)); then
    log_phase "${label}-inspection-unavailable" \
      "pgid=$pgid phase=post-kill attempts=$inspection_failures"
    return 1
  fi
  log_phase "${label}-uncleaned" \
    "pgid=$pgid pids=$(commas "$members") phase=post-kill kernel_group=$kernel_detail"
  return 1
}

# Terminate a pinned child's whole process group: TERM, a bounded grace period,
# then KILL, then reap. The numeric group id routes a signal only after the live
# supervisor's recorded identity authorizes it; a vanished leader is never
# treated as ownership. Completion needs both a positively observed empty table
# and a missing kernel group, not merely that the payload returned.
terminate_group() {
  local leader="$1"
  local pgid="$2"
  local identity="$3"
  local marker="$4"
  local label="$5"
  local deadline
  local members kernel_state=2

  # A table can be valid but incomplete. An apparently empty group while the
  # kernel still has the group is therefore an escalation case, not success.
  if ! members="$(live_group_members_bounded "$pgid")"; then
    log_phase "${label}-inspection-unavailable" "pgid=$pgid phase=pre-signal"
    return 1
  fi
  kernel_state=0
  kernel_group_state "$pgid" || kernel_state=$?
  if [[ -z "$members" && "$kernel_state" == "1" ]]; then
    wait "$leader" 2>/dev/null || true
    return 0
  fi
  # Any group that may still exist is signalled only after its original, identity-pinned
  # supervisor is live. `group_is_ours` intentionally refuses a leaderless
  # group; do not weaken this to a PGID-only authorization.
  if ! group_is_ours "$pgid" "$identity" "$marker"; then
    log_phase "${label}-group-unattributable" "pgid=$pgid action=not-signalled"
    return 1
  fi

  # The pinned supervisor traps TERM and stops itself. That keeps its stable
  # identity alive while ordinary payload members drain, so a stubborn descendant
  # can be escalated through an owned group instead of a leaderless numeric PGID.
  kill -TERM -- -"$pgid" 2>/dev/null || {
    log_phase "${label}-signal-failed" "pgid=$pgid signal=TERM"
    return 1
  }
  deadline=$((SECONDS + TERMINATION_GRACE_SECONDS))
  while ((SECONDS < deadline)); do
    if ! members="$(live_group_members_bounded "$pgid")"; then
      log_phase "${label}-inspection-unavailable" "pgid=$pgid phase=post-term"
      return 1
    fi
    kernel_state=0
    kernel_group_state "$pgid" || kernel_state=$?
    if [[ -z "$members" && "$kernel_state" == "1" ]]; then
      wait "$leader" 2>/dev/null || true
      log_phase "${label}-terminated" "signal=TERM pgid=$pgid scope=group"
      return 0
    fi
    # A sole visible leader does not prove it is the sole *actual* member: a
    # syntactically valid truncated table may have omitted a TERM-proof
    # descendant. Never direct-KILL the leader in that state, because the live
    # pinned identity is what still authorizes a bounded KILL of the whole group.
    if [[ "$members" == "$leader" ]]; then
      if [[ -n "$PS_PARTIAL_OMISSION_MARKER" && -f "$PS_PARTIAL_OMISSION_MARKER" ]]; then
        log_phase "${label}-omitted-descendant-suspected" \
          "pgid=$pgid visible=leader evidence=synthetic-row-omission action=group-kill"
      else
        log_phase "${label}-sole-visible-leader" \
          "pgid=$pgid visible=leader table=complete action=group-kill"
      fi
      break
    fi
    sleep 0.1
  done

  if [[ "$members" != "$leader" ]]; then
    log_phase "${label}-survivors" \
      "pgid=$pgid pids=$(commas "$members") after_signal=TERM after_s=$TERMINATION_GRACE_SECONDS"
  fi
  # Group escalation remains safe only while the original supervisor is live and
  # has exactly the identity captured before any payload could start.
  if ! group_is_ours "$pgid" "$identity" "$marker"; then
    log_phase "${label}-group-unattributable" "pgid=$pgid action=escalation-withheld"
    return 1
  fi
  kill -KILL -- -"$pgid" 2>/dev/null || {
    log_phase "${label}-signal-failed" "pgid=$pgid signal=KILL"
    return 1
  }
  # The partial-table fault has already forced the conservative group-KILL
  # decision. Absence proof must now use a genuine snapshot; continuing to
  # delete the known descendant after it was killed would make the independent
  # post-KILL observation synthetic rather than evidence.
  if [[ -n "$PS_PARTIAL_OMISSION_MARKER" && -f "$PS_PARTIAL_OMISSION_MARKER" ]]; then
    FAULT_ACTIVE=0
  fi
  if wait_for_group_absence "$leader" "$pgid" "$label"; then
    log_phase "${label}-killed" \
      "signal=KILL pgid=$pgid scope=group grace_s=$TERMINATION_GRACE_SECONDS"
    return 0
  fi
  return 1
}

# Terminate a child only through the process group proven at spawn. A pid-tree
# fallback cannot be complete once its leader exits (descendants are reparented),
# and per-pid signals can land on recycled strangers. Refusing is the only honest
# outcome when group containment was not established.
terminate_child() {
  local pid="${1:-}"
  local pgid="${2:-}"
  local identity="${3:-}"
  local marker="${4:-}"
  local label="${5:-child}"
  [[ -n "$pid" ]] || return 0
  if [[ -z "$pgid" || -z "$identity" || -z "$marker" ]]; then
    log_phase "${label}-group-unproven" "pid=$pid action=not-signalled"
    return 1
  fi
  terminate_group "$pid" "$pgid" "$identity" "$marker" "$label"
}

# Prove the marker and complete birth identity captured for the provisional
# direct child. Inspection-unavailable is retried for a small fixed bound;
# absence, marker mismatch, and identity mismatch refuse immediately. Returns 2
# for persistent unknown so the caller can report that separately from reuse.
prove_provisional_identity() {
  local observed="" status=0 deadline=""
  [[ "$PROVISIONAL_PID" =~ ^[0-9]+$ ]] || return 1
  [[ -n "$PROVISIONAL_MARKER" && -n "$PROVISIONAL_IDENTITY" ]] || return 1
  deadline="$(transient_retry_deadline_us)" || return 2
  while :; do
    status=0
    if fault_active provisional-inspection-unknown; then
      status=2
    else
      observed="$(process_identity "$PROVISIONAL_PID" "$PROVISIONAL_MARKER")" || status=$?
    fi
    if ((status == 0)); then
      [[ "$observed" == "$PROVISIONAL_IDENTITY" ]]
      return
    fi
    if ((status == 1)); then return 1; fi
    transient_retry_deadline_elapsed "$deadline" && break
    sleep 0.02
  done
  return 2
}

clear_provisional_state() {
  PROVISIONAL_PID=""
  PROVISIONAL_PGID=""
  PROVISIONAL_IDENTITY=""
  PROVISIONAL_MARKER=""
  PROVISIONAL_LABEL=""
  PROVISIONAL_STATUS_FILE=""
  PROVISIONAL_STATUS_AUTH=""
}

# The shell owns `$!` directly until it calls wait. A direct signal is permitted
# only after the random argv marker and exact recorded birth identity have both
# been re-proved immediately before that signal. A numeric PID alone never
# authorizes KILL, including on launch failure and in EXIT cleanup.
reap_provisional_direct_child() {
  local pid="${PROVISIONAL_PID:-}"
  local label="${PROVISIONAL_LABEL:-supervisor}"
  local wait_status=0 proof_status=0
  [[ -n "$pid" ]] || return 0
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1

  prove_provisional_identity || proof_status=$?
  if ((proof_status == 1)); then
    log_phase "${label}-preexec-identity-mismatch" \
      "pid=$pid action=not-signalled marker=required birth_identity=required"
    return 1
  fi
  if ((proof_status == 2)); then
    log_phase "${label}-preexec-inspection-unknown" \
      "pid=$pid action=not-signalled deadline_s=$TRANSIENT_INSPECTION_DEADLINE_SECONDS"
    return 1
  fi
  # No command that can yield or inspect the process belongs between the exact
  # proof above and this one direct signal.
  kill -KILL -- "$pid" 2>/dev/null || {
    log_phase "${label}-preexec-signal-failed" "pid=$pid signal=KILL scope=direct-exact"
    return 1
  }
  log_phase "${label}-preexec-kill" "pid=$pid signal=KILL scope=direct"
  # This shell created the direct child and has not waited for it elsewhere.
  # A non-zero status is the killed child's status, not an excuse to drop
  # ownership before wait has reaped it.
  wait "$pid" 2>/dev/null || wait_status=$?
  clear_provisional_state
  log_phase "${label}-preexec-reaped" "pid=$pid scope=direct exit=$wait_status"
  return 0
}

begin_lifecycle_critical() {
  [[ "$LIFECYCLE_CRITICAL" == "0" && -z "$PENDING_INTERRUPT" && -z "$PROVISIONAL_PID" ]] || return 1
  LIFECYCLE_CRITICAL=1
}

# Fault checkpoints send a real TERM to this runner. The ordinary trap handles
# it; test code does not call lifecycle internals or synthesize trap state.
lifecycle_checkpoint() {
  local window="$1"
  if [[ -n "$SELF_TEST_MODE" && "${S1_INTERRUPT_WINDOW:-}" == "$window" ]]; then
    log_phase "lifecycle-critical-window" "window=$window provisional=${PROVISIONAL_PID:-none}"
    kill -TERM "$$"
  fi
}

finish_lifecycle_critical() {
  local pending="$PENDING_INTERRUPT"
  LIFECYCLE_CRITICAL=0
  PENDING_INTERRUPT=""
  if [[ -n "$pending" ]]; then
    log_phase "lifecycle-critical-dispatch" "signal=$pending ownership=stable"
    on_interrupt "$pending"
  fi
}

# Every live child this run owns, in dependency order: the timed client first,
# because it is talking to the server, then the server itself. The client runs in
# its own process group, so an interrupt that only knew about the server would
# leave that group behind — holding connections, and in the local-D1 case a D1
# handle — while the run reported itself finished.
#
# Non-zero means something could not be proven gone. No caller may turn that into
# a pass.
cleanup_all() {
  local status=0
  if [[ -n "$PROVISIONAL_PID" ]]; then
    reap_provisional_direct_child || status=1
  fi
  if [[ -n "$CLIENT_PID" ]]; then
    if terminate_child "$CLIENT_PID" "$CLIENT_PGID" "$CLIENT_IDENTITY" "$CLIENT_MARKER" "client"; then
      clear_client_state
    else
      status=1
    fi
  fi
  if [[ -n "$SERVER_PID" ]]; then
    if terminate_child "$SERVER_PID" "$SERVER_PGID" "$SERVER_IDENTITY" "$SERVER_MARKER" "child"; then
      clear_server_state
    else
      status=1
    fi
  fi
  return "$status"
}

clear_client_state() {
  CLIENT_PID=""
  CLIENT_PGID=""
  CLIENT_IDENTITY=""
  CLIENT_MARKER=""
  CLIENT_STATUS_FILE=""
  CLIENT_STATUS_AUTH=""
}

clear_server_state() {
  SERVER_PID=""
  SERVER_PGID=""
  SERVER_IDENTITY=""
  SERVER_MARKER=""
  SERVER_STATUS_FILE=""
  SERVER_STATUS_AUTH=""
}

on_interrupt() {
  local signal="$1"
  local code="INTERRUPTED_${signal}"
  if [[ "$LIFECYCLE_CRITICAL" == "1" ]]; then
    if [[ -z "$PENDING_INTERRUPT" ]]; then PENDING_INTERRUPT="$signal"; fi
    log_phase "lifecycle-interrupt-deferred" \
      "signal=$signal provisional=${PROVISIONAL_PID:-none} pending=$PENDING_INTERRUPT"
    return 0
  fi
  # Leave EXIT armed. If the first cleanup cannot inspect or attribute a group,
  # ownership stays recorded and the EXIT trap gets one bounded retry.
  # A second signal must not restore default handling half way through bounded
  # cleanup. Ignore it while EXIT remains armed as the retry gate.
  trap '' HUP INT TERM
  log_phase "interrupted" \
    "signal=$signal child=${SERVER_PID:-none} client=${CLIENT_PID:-none}"
  log_phase "cleanup-begin" "signal=$signal"
  if ! cleanup_all; then
    # Do not publish a terminal cleanup failure yet. EXIT owns the second,
    # bounded cleanup attempt; if that recovers, the honest terminal record is
    # the interrupt, not a stale assertion that cleanup stayed incomplete.
    INTERRUPT_TERMINAL_CODE="$code"
    log_phase "interrupted-cleanup-pending" "signal=$signal exit_retry=armed"
  else
    emit "fail" "$code"
  fi
  # State is retained on purpose, including here: an interrupted run is the one
  # whose logs a human most wants afterwards.
  printf 'INTERRUPTED %s: signal=%s state_retained=%s\n' "$SUITE" "$signal" "${STATE_DIR:-none}" >&2
  exit 1
}

# The last line of defence, and never a mask. A body that already emitted a pass
# record does not get to keep it if this trap cannot prove the children are gone:
# the later record and the non-zero status are what the dispatcher and the tests
# read. Success paths are expected to have cleaned up *before* claiming anything,
# which is why reaching here with work left to do is itself reportable.
on_exit() {
  local status="$?"
  local attempt=1
  trap - EXIT
  trap '' HUP INT TERM
  LIFECYCLE_CRITICAL=0
  while ((attempt <= EXIT_CLEANUP_ATTEMPTS)); do
    if cleanup_all; then
      if ((attempt > 1)); then
        log_phase "exit-cleanup-recovered" "attempt=$attempt exit_status=$status"
      fi
      if [[ -n "$INTERRUPT_TERMINAL_CODE" ]]; then
        log_phase "interrupted-cleanup-recovered" "code=$INTERRUPT_TERMINAL_CODE attempt=$attempt"
        emit "fail" "$INTERRUPT_TERMINAL_CODE"
      fi
      return "$status"
    fi
    if ((attempt < EXIT_CLEANUP_ATTEMPTS)); then
      log_phase "exit-cleanup-retry" "attempt=$attempt exit_status=$status"
    fi
    attempt=$((attempt + 1))
  done
  log_phase "cleanup-incomplete" "exit_status=$status"
  printf 'FAILED %s: %s body_exit=%s\n' "$SUITE" "CLEANUP_INCOMPLETE" "$status" >&2
  emit "fail" "CLEANUP_INCOMPLETE"
  exit 1
}

require_tooling() {
  command -v bun >/dev/null 2>&1 || blocked "BUN_REQUIRED"
  command -v curl >/dev/null 2>&1 || blocked "CURL_REQUIRED"
}

valid_secret() {
  [[ "$1" =~ ^v1\.[A-Za-z0-9_-]{43}$ ]]
}

valid_flow_handle() {
  [[ "$1" =~ ^flow_v1\.[A-Za-z0-9_-]{43}$ ]]
}

valid_token() {
  [[ "$1" =~ ^asimp_ag_[0-9A-HJKMNP-TV-Z]{26}_[A-Za-z0-9_-]{43}$ ]]
}

supported_harness() {
  local harness="$1"
  local candidate
  for candidate in "${HARNESS_IDENTITIES[@]}"; do
    [[ "$candidate" == "$harness" ]] && return 0
  done
  return 1
}

# An unprivileged, in-range TCP port. Ports below 1024 need privileges this
# runner must never have, and a pinned one of those is a configuration error
# rather than something to discover as a bind failure.
valid_port() {
  local port="$1"
  [[ "$port" =~ ^[0-9]{1,5}$ ]] || return 1
  ((port >= 1024 && port <= 65535))
}

# True when nothing is listening. Uses bash's own /dev/tcp so the check needs no
# lsof, ss or nc, which differ across the platforms this runs on.
port_is_free() {
  local port="$1"
  ! (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null
}

# Prints a free port, or returns non-zero when it cannot find one.
#
# Deliberately silent on failure: this runs inside a command substitution, where
# a `blocked` call would print its JSON record *into the caller's variable* and
# exit only the subshell. Refusals therefore belong to `resolve_port` below,
# which runs in the script's own shell. The same rule applies to every helper
# invoked as `$(...)` in this file.
allocate_port() {
  local attempt port
  for ((attempt = 0; attempt < PORT_ALLOCATION_ATTEMPTS; attempt += 1)); do
    port=$((EPHEMERAL_PORT_FLOOR + RANDOM % EPHEMERAL_PORT_SPAN))
    if port_is_free "$port"; then
      printf '%s' "$port"
      return 0
    fi
  done
  return 1
}

# Sets RESOLVED_PORT. Runs in the script's shell so a refusal really refuses.
resolve_port() {
  if [[ -n "${S1_LOCAL_PORT:-}" ]]; then
    valid_port "${S1_LOCAL_PORT}" || blocked "PINNED_PORT_INVALID"
    port_is_free "${S1_LOCAL_PORT}" || blocked "PINNED_PORT_BUSY"
    RESOLVED_PORT="${S1_LOCAL_PORT}"
    return 0
  fi
  local port
  port="$(allocate_port)" || blocked "LOCAL_PORT_UNAVAILABLE"
  RESOLVED_PORT="$port"
}

# Sets RUN_TOKEN: a per-run synthetic sponsor id. Deliberately not a secret, and
# deliberately SQL- and shell-safe, because it is interpolated into the local D1
# ownership query below: lowercase, digits and hyphens only.
resolve_run_token() {
  local token
  token="s1-$$-${RANDOM}${RANDOM}"
  [[ "$token" =~ ^[a-z0-9-]+$ ]] || failed "RUN_TOKEN_INVALID"
  RUN_TOKEN="$token"
}

# Make an opaque, per-supervisor status authenticator. It is never logged and is
# only a freshness/attribution guard for a retained local file; it is not an API
# credential or a substitute for the pinned live-process identity used for
# signals.
new_status_authenticator() {
  local entropy
  entropy="$(LC_ALL=C od -An -N16 -tx1 /dev/urandom 2>/dev/null | tr -d '[:space:]')" || return 1
  [[ "$entropy" =~ ^[a-f0-9]{32}$ ]] || return 1
  printf 's1status-%s' "$entropy"
}

# This is an ownership marker, not a credential: it is generated from system
# entropy, placed in the stopped supervisor's argv, and checked together with
# lstart before every normal group signal. It is never logged or persisted.
new_supervisor_marker() {
  local entropy
  entropy="$(LC_ALL=C od -An -N16 -tx1 /dev/urandom 2>/dev/null | tr -d '[:space:]')" || return 1
  [[ "$entropy" =~ ^[a-f0-9]{32}$ ]] || return 1
  printf 's1-supervisor-%s' "$entropy"
}

# Read a status written only by the exact pinned supervisor into its private,
# retained state directory. Return 1 only when the expected status is absent and
# the payload may still be running. Return 2 for a symlink, directory, foreign
# owner, malformed record, stale supervisor PID, or wrong authenticator; none of
# those is a running payload and none may become a success.
recorded_child_status() {
  local status_file="$1"
  local expected_pid="$2"
  local expected_auth="$3"
  local record actual_auth actual_pid status
  [[ -n "$status_file" && "$expected_pid" =~ ^[0-9]+$ && -n "$expected_auth" ]] || return 2
  private_state_directory || return 2
  [[ "$(dirname "$status_file")" == "$STATE_DIR" ]] || return 2
  [[ -L "$status_file" ]] && return 2
  [[ ! -e "$status_file" ]] && return 1
  [[ -f "$status_file" && -O "$status_file" && -r "$status_file" ]] || return 2
  record="$(<"$status_file")" || return 2
  [[ "$record" =~ ^(s1status-[a-f0-9]{32})\ ([0-9]+)\ (0|[1-9][0-9]{0,2})$ ]] || return 2
  actual_auth="${BASH_REMATCH[1]}"
  actual_pid="${BASH_REMATCH[2]}"
  status="${BASH_REMATCH[3]}"
  [[ "$actual_auth" == "$expected_auth" && "$actual_pid" == "$expected_pid" ]] || return 2
  ((10#$status <= 255)) || return 2
  printf '%s' "$status"
}

# Starts a permanent, identity-pinned group leader without allowing its payload
# to run first. The supervisor records the payload's bounded numeric status in a
# private retained file, then remains alive until controller cleanup. On TERM it
# stops rather than exits; that live identity authorizes a later group KILL only
# if a descendant survived the grace period.
start_pinned_supervisor() {
  local status_file="$1"
  local label="$2"
  shift 2
  local stopped_deadline=0 stopped_status=0 identity_status=0 status_auth="" marker=""
  local capture_deadline="" proof_status=0

  private_state_directory || return 1
  [[ "$(dirname "$status_file")" == "$STATE_DIR" && ! -e "$status_file" && ! -L "$status_file" ]] || return 1
  capture_deadline="$(transient_retry_deadline_us)" || return 1
  status_auth="$(new_status_authenticator)" || return 1
  marker="$(new_supervisor_marker)" || return 1
  begin_lifecycle_critical || return 1
  PROVISIONAL_LABEL="$label"
  PROVISIONAL_MARKER="$marker"
  PROVISIONAL_STATUS_FILE="$status_file"
  PROVISIONAL_STATUS_AUTH="$status_auth"

  lifecycle_checkpoint "before-background-spawn"
  # No child exists yet, so a deferred interrupt can be dispatched without
  # starting work merely to acquire cleanup authority.
  if [[ -n "$PENDING_INTERRUPT" ]]; then
    clear_provisional_state
    finish_lifecycle_critical
    return 130
  fi

  set -m
  # shellcheck disable=SC2016
  bash -c '
    status_file="$1"
    status_auth="$2"
    shift 2
    # A group TERM kills normal payload members but pins this leader. The
    # controller can still prove its identity before any escalation; the final
    # direct KILL is only used when it is the sole remaining group member.
    trap "kill -STOP \"$$\"" TERM
    kill -STOP "$$"
    "$@" &
    child="$!"
    child_status=0
    wait "$child" || child_status=$?
    [[ "$child_status" =~ ^[0-9]+$ ]] || exit 125
    ((child_status >= 0 && child_status <= 255)) || exit 125
    status_parent="$(dirname "$status_file")"
    # The parent checked this before launch. Repeat it in the supervisor so a
    # retained-path swap cannot turn status publication into a symlink-following
    # overwrite. Noclobber makes the final component a fresh file only.
    [[ -d "$status_parent" && ! -L "$status_parent" && -O "$status_parent" && -r "$status_parent" && -w "$status_parent" && -x "$status_parent" ]] || exit 125
    [[ ! -e "$status_file" && ! -L "$status_file" ]] || exit 125
    set -C
    if ! printf "%s %s %s\n" "$status_auth" "$$" "$child_status" >"$status_file"; then
      exit 125
    fi
    set +C
    # Hold without returning. A TERM wakes the foreground wait and the trap
    # stops this shell, leaving a live, identity-pinned leader for cleanup.
    while :; do
      sleep 300 &
      hold="$!"
      wait "$hold" || true
    done
  ' "$marker" "$status_file" "$status_auth" "$@" &
  # The trap is still deferred across the unavoidable `&` -> `$!` boundary.
  # From this first possible assignment onward, cleanup reads globally owned
  # provisional state rather than caller-local scratch variables.
  PROVISIONAL_PID="$!"
  set +m
  lifecycle_checkpoint "after-background-spawn"

  # Capture the exact birth identity while the random marker proves this is the
  # shell just forked by us. A first process-table observation can race process
  # creation, so both absence and unavailable inspection are retried here. No
  # signal is authorized if the bounded capture never succeeds.
  while :; do
    identity_status=0
    PROVISIONAL_IDENTITY="$(process_identity "$PROVISIONAL_PID" "$PROVISIONAL_MARKER")" || identity_status=$?
    if ((identity_status == 0)); then break; fi
    PROVISIONAL_IDENTITY=""
    transient_retry_deadline_elapsed "$capture_deadline" && break
    sleep 0.02
  done
  if ((identity_status != 0)) || [[ -z "$PROVISIONAL_IDENTITY" ]]; then
    log_phase "${label}-group-unproven" \
      "pid=$PROVISIONAL_PID reason=birth-identity-unavailable action=not-signalled"
    finish_lifecycle_critical
    return 1
  fi

  # A freshly forked shell may not be scheduled within one second when the full
  # S-1 file is starting and reaping several process trees. Give the positive
  # STOP observation its own bounded startup deadline. The injected negative is
  # kept immediate so that test still proves the exact pre-exec reap path rather
  # than merely exercising a slow timeout.
  if fault_active supervisor-not-stopped; then
    stopped_status=1
  else
    stopped_deadline=$((SECONDS + SUPERVISOR_STOP_DEADLINE_SECONDS))
    while :; do
      stopped_status=0
      supervisor_is_stopped "$PROVISIONAL_PID" || stopped_status=$?
      if ((stopped_status == 0)); then break; fi
      if ((SECONDS >= stopped_deadline)); then break; fi
      sleep 0.02
    done
  fi
  if ((stopped_status != 0)); then
    log_phase "${label}-group-unproven" "pid=$PROVISIONAL_PID reason=supervisor-not-stopped"
    reap_provisional_direct_child || true
    finish_lifecycle_critical
    return 1
  fi
  lifecycle_checkpoint "after-stop-proof"

  proof_status=0
  prove_provisional_identity || proof_status=$?
  if ((proof_status != 0)); then
    log_phase "${label}-group-unproven" "pid=$PROVISIONAL_PID reason=identity-unavailable"
    # The named fault plants a failure in this proof, not in cleanup. Remove it
    # so the real reaper must still re-prove the recorded identity for itself.
    if [[ "${S1_FAULT_INJECT:-}" == "identity-unavailable" ]]; then FAULT_ACTIVE=0; fi
    reap_provisional_direct_child || true
    finish_lifecycle_critical
    return 1
  fi
  if ! owns_process_group "$PROVISIONAL_PID"; then
    log_phase "${label}-group-unproven" "pid=$PROVISIONAL_PID reason=not-owned"
    reap_provisional_direct_child || true
    finish_lifecycle_critical
    return 1
  fi
  PROVISIONAL_PGID="$PROVISIONAL_PID"
  lifecycle_checkpoint "after-identity-proof"
  # These two planted modes need the production direct reaper while the payload
  # is still genuinely behind STOP. Holding here is self-test-only; normal
  # launches always continue through the exact CONT re-proof below.
  if [[ "$SELF_TEST_MODE" == "provisional-pid-reuse" || "$SELF_TEST_MODE" == "provisional-inspection-unknown" ]]; then
    log_phase "${label}-held-before-cont" "pid=$PROVISIONAL_PID payload=not-started"
    return 0
  fi
  lifecycle_checkpoint "before-cont-reproof"

  # CONT is itself a workload signal. Re-prove marker plus exact birth identity
  # immediately before it, under the same critical deferral that prevents an
  # interrupt cleanup from racing this authorization.
  proof_status=0
  prove_provisional_identity || proof_status=$?
  if ((proof_status != 0)); then
    log_phase "${label}-group-unproven" "pid=$PROVISIONAL_PID reason=cont-identity-unavailable"
    reap_provisional_direct_child || true
    finish_lifecycle_critical
    return 1
  fi
  if ! kill -CONT -- "$PROVISIONAL_PID" 2>/dev/null; then
    log_phase "${label}-group-unproven" "pid=$PROVISIONAL_PID reason=release-failed"
    reap_provisional_direct_child || true
    finish_lifecycle_critical
    return 1
  fi
  log_phase "${label}-cont-authorized" "pid=$PROVISIONAL_PID identity=exact marker=exact"
  lifecycle_checkpoint "after-cont-release"
  # Deliberately return with the critical section and provisional slot intact.
  # The caller must atomically adopt it into CLIENT or SERVER before interrupts
  # can dispatch cleanup.
  lifecycle_checkpoint "function-return"
  return 0
}

adopt_provisional_supervisor() {
  local owner="$1"
  [[ "$LIFECYCLE_CRITICAL" == "1" ]] || return 1
  [[ "$PROVISIONAL_PID" =~ ^[0-9]+$ && "$PROVISIONAL_PGID" == "$PROVISIONAL_PID" ]] || return 1
  [[ -n "$PROVISIONAL_IDENTITY" && -n "$PROVISIONAL_MARKER" ]] || return 1
  lifecycle_checkpoint "caller-adoption-${owner}"
  case "$owner" in
    client)
      CLIENT_PID="$PROVISIONAL_PID"
      CLIENT_PGID="$PROVISIONAL_PGID"
      CLIENT_IDENTITY="$PROVISIONAL_IDENTITY"
      CLIENT_MARKER="$PROVISIONAL_MARKER"
      CLIENT_STATUS_FILE="$PROVISIONAL_STATUS_FILE"
      CLIENT_STATUS_AUTH="$PROVISIONAL_STATUS_AUTH"
      ;;
    server)
      SERVER_PID="$PROVISIONAL_PID"
      SERVER_PGID="$PROVISIONAL_PGID"
      SERVER_IDENTITY="$PROVISIONAL_IDENTITY"
      SERVER_MARKER="$PROVISIONAL_MARKER"
      SERVER_STATUS_FILE="$PROVISIONAL_STATUS_FILE"
      SERVER_STATUS_AUTH="$PROVISIONAL_STATUS_AUTH"
      ;;
    *) return 1 ;;
  esac
  log_phase "${PROVISIONAL_LABEL}-adopted" "owner=$owner pid=$PROVISIONAL_PID identity=exact"
  clear_provisional_state
  lifecycle_checkpoint "caller-adopted-${owner}"
  finish_lifecycle_critical
}

# Prove that a normally returned client did not leave work in its owned group.
# Its payload's exit status is known only through the retained supervisor status
# file; success still requires retiring the live supervisor and proving the group
# empty before client ownership is cleared.
settle_completed_client_group() {
  local members
  if ! group_is_ours "$CLIENT_PGID" "$CLIENT_IDENTITY" "$CLIENT_MARKER"; then
    log_phase "client-complete-supervisor-unavailable" "pgid=$CLIENT_PGID"
    return 1
  fi
  if ! members="$(live_group_members_bounded "$CLIENT_PGID")"; then
    log_phase "client-complete-inspection-unavailable" "pgid=$CLIENT_PGID"
    return 1
  fi
  log_phase "client-complete-pinned" "pgid=$CLIENT_PGID pids=$(commas "$members")"
  terminate_child "$CLIENT_PID" "$CLIENT_PGID" "$CLIENT_IDENTITY" "$CLIENT_MARKER" "client-complete"
}

# Run a command with an overall deadline. The real command is held behind a
# stopped direct-child supervisor, so no workload effect occurs before the group
# and identity are proven. Returns 124 on timeout, the command's status otherwise.
# 125 means group ownership or post-exit containment could not be proven.
# `timeout(1)` is not portable to every machine this runs on.
#
# The deadline is bounded in both directions: the command is started in its own
# process group so a timeout can be cleaned up as a group, and the timeout path
# escalates TERM to KILL and reaps, rather than sending one signal and hoping.
run_with_deadline() {
  local seconds="$1"
  shift
  local child_status="" status_read=0 status_file=""
  [[ -n "$STATE_DIR" ]] || return 125
  status_file="$STATE_DIR/.client-exit-status"
  start_pinned_supervisor "$status_file" "client" "$@" || return 125
  if ! adopt_provisional_supervisor client; then
    finish_lifecycle_critical
    return 125
  fi
  log_phase "client-started" "pid=$CLIENT_PID scope=group supervisor=pinned-before-exec"

  local deadline=$((SECONDS + seconds))
  while ((SECONDS < deadline)); do
    status_read=0
    child_status="$(recorded_child_status "$CLIENT_STATUS_FILE" "$CLIENT_PID" "$CLIENT_STATUS_AUTH")" || status_read=$?
    if ((status_read == 0)); then
      log_phase "client-status-recorded" "status=$child_status"
      if ! settle_completed_client_group; then return 125; fi
      clear_client_state
      return "$child_status"
    fi
    if ((status_read == 2)); then
      log_phase "client-status-invalid" "file=$CLIENT_STATUS_FILE"
      return 125
    fi
    if ! group_is_ours "$CLIENT_PGID" "$CLIENT_IDENTITY" "$CLIENT_MARKER"; then
      log_phase "client-supervisor-unavailable" "pid=$CLIENT_PID"
      return 125
    fi
    sleep 0.1
  done
  terminate_child "$CLIENT_PID" "$CLIENT_PGID" "$CLIENT_IDENTITY" "$CLIENT_MARKER" "deadline" || return 125
  clear_client_state
  return 124
}

json_field() {
  local body="$1"
  local field="$2"
  local value
  if ! value="$(printf '%s' "$body" | bun -e '
const field = process.argv[1];
const value = JSON.parse(await Bun.stdin.text())[field];
if (typeof value !== "string") process.exit(1);
process.stdout.write(value);
' "$field" 2>/dev/null)"; then
    return 1
  fi
  printf '%s' "$value"
}

json_status() {
  json_field "$1" "status"
}

curl_body() {
  local method="$1"
  local endpoint="$2"
  local body="${3:-}"
  local result

  # Curl diagnostics can echo a caller-supplied origin or credentials. The
  # runner deliberately retains neither: failures become fixed typed records.
  if [[ "$method" == "GET" ]]; then
    if ! result="$(curl --silent --fail-with-body --request GET \
      --connect-timeout "$CONNECT_TIMEOUT_SECONDS" --max-time "$REQUEST_TIMEOUT_SECONDS" \
      --header 'Accept: application/json' "$endpoint" 2>/dev/null)"; then
      return 20
    fi
  elif [[ "$method" == "POST" ]]; then
    if ! result="$(printf '%s' "$body" | curl --silent --fail-with-body \
      --request POST --connect-timeout "$CONNECT_TIMEOUT_SECONDS" \
      --max-time "$REQUEST_TIMEOUT_SECONDS" \
      --header 'Accept: application/json' --header 'Content-Type: application/json' \
      --data-binary @- "$endpoint" 2>/dev/null)"; then
      return 21
    fi
  else
    return 64
  fi

  printf '%s' "$result"
}

make_registration_body() {
  local enrollment_id="$1"
  local secret="$2"
  ASIMP_S1_ENROLLMENT_ID="$enrollment_id" \
    ASIMP_S1_SECRET="$secret" \
    ASIMP_S1_FELLOW_NAME="$ASIMP_S1_FELLOW_NAME" \
    ASIMP_S1_MODEL="$ASIMP_S1_MODEL" \
    ASIMP_S1_HARNESS="$ASIMP_S1_HARNESS" \
    bun -e '
const required = ["ASIMP_S1_ENROLLMENT_ID", "ASIMP_S1_SECRET", "ASIMP_S1_FELLOW_NAME", "ASIMP_S1_MODEL", "ASIMP_S1_HARNESS"];
for (const name of required) if (!process.env[name]) process.exit(1);
process.stdout.write(JSON.stringify({
  enrollment_id: process.env.ASIMP_S1_ENROLLMENT_ID,
  secret: process.env.ASIMP_S1_SECRET,
  name: process.env.ASIMP_S1_FELLOW_NAME,
  model: process.env.ASIMP_S1_MODEL,
  harness: process.env.ASIMP_S1_HARNESS,
}));
' 2>/dev/null
}

make_poll_body() {
  local flow_handle="$1"
  # Narrow black-box regression hook. It is admitted only with the loopback
  # transport switch below, so a live enrollment cannot inherit it.
  [[ "${S1_TEST_BODY_FAULT:-}" != "poll-body-construction" ]] || return 1
  ASIMP_S1_FLOW_HANDLE="$flow_handle" bun -e '
if (!process.env.ASIMP_S1_FLOW_HANDLE) process.exit(1);
process.stdout.write(JSON.stringify({ flow_handle: process.env.ASIMP_S1_FLOW_HANDLE }));
' 2>/dev/null
}

# A helper invoked in a command substitution must never own a terminal result:
# `exit` in that subshell can otherwise leave a preceding progress record as the
# final NDJSON record. Capture failures in the main shell and issue exactly one
# typed terminal failure there.
capture_helper_or_fail() {
  local destination="$1"
  local failure_code="$2"
  local result=""
  shift 2
  if ! result="$("$@")"; then
    failed "$failure_code"
  fi
  printf -v "$destination" '%s' "$result"
}

run_helper_or_fail() {
  local failure_code="$1"
  shift
  "$@" >/dev/null || failed "$failure_code"
}

self_test() {
  local fragment_sentinel="v1.S1FRAGMENT_SENTINEL_0123456789abcdefghijklm"
  local synthetic_url="https://a.example.test/join/ASIMP-EN-7F3K9M2Q8R#${fragment_sentinel}"
  local without_fragment="${synthetic_url%%#*}"
  local fragment="${synthetic_url#*#}"
  local diagnostic

  lifecycle_state_dir "self-test-redaction"
  printf 'self-test artifact: fixed lifecycle facts only\n' >"$STATE_DIR/self-test-artifact.log"

  [[ "$without_fragment" != *"#"* && "$without_fragment" != *"?"* ]] || failed "SELF_TEST_PATH_CONTAINMENT_FAILED"
  [[ "$without_fragment" == "https://a.example.test/join/ASIMP-EN-7F3K9M2Q8R" ]] || failed "SELF_TEST_PATH_CONTAINMENT_FAILED"
  valid_secret "$fragment" || failed "SELF_TEST_FRAGMENT_VALIDATION_FAILED"

  local harness
  for harness in "${HARNESS_IDENTITIES[@]}"; do
    supported_harness "$harness" || failed "SELF_TEST_HARNESS_IDENTITIES_FAILED"
  done
  supported_harness "unrecognized-harness" && failed "SELF_TEST_HARNESS_IDENTITIES_FAILED"

  # Lifecycle helpers are part of the contract, so the self-test exercises them
  # rather than trusting them: port validation, and a token that is safe to
  # interpolate into the local D1 ownership query.
  local acceptable_port rejected_port
  for acceptable_port in 1024 8792 65535; do
    valid_port "$acceptable_port" || failed "SELF_TEST_PORT_VALIDATION_FAILED"
  done
  for rejected_port in 0 80 1023 65536 70000 "" "not-a-port" "80 80" "-1"; do
    if valid_port "$rejected_port"; then failed "SELF_TEST_PORT_VALIDATION_FAILED"; fi
  done
  resolve_run_token
  [[ "$RUN_TOKEN" =~ ^[a-z0-9-]+$ ]] || failed "SELF_TEST_RUN_TOKEN_FAILED"

  # The group-ownership gate that stands in front of every group signal. Both
  # directions matter: a pid that owns no group must be refused, and this
  # runner's own group must never qualify — otherwise a cleanup TERM would be
  # delivered to the shell that invoked us.
  if process_group_of "not-a-pid"; then failed "SELF_TEST_GROUP_OWNERSHIP_FAILED"; fi
  [[ "$(process_group_of "$$")" =~ ^[0-9]+$ ]] || failed "SELF_TEST_GROUP_OWNERSHIP_FAILED"
  if owns_process_group "$$"; then failed "SELF_TEST_GROUP_OWNERSHIP_FAILED"; fi
  if owns_process_group ""; then failed "SELF_TEST_GROUP_OWNERSHIP_FAILED"; fi

  # Process inspection must fail closed. Every liveness answer in this runner is
  # used to decide whether cleanup may stop, so "the table could not be read" must
  # be an error and never an empty list. The runner must also be able to see itself
  # in a valid table — that is what makes a truncated table detectable at all.
  local own_group parser_fault probe_state=0
  own_group="$(process_group_of "$$")"
  FAULT_ACTIVE=1
  if S1_FAULT_INJECT=ps-unreadable ps_table >/dev/null 2>&1; then failed "SELF_TEST_FAIL_CLOSED_FAILED"; fi
  if S1_FAULT_INJECT=ps-unreadable live_pids "$$" >/dev/null 2>&1; then failed "SELF_TEST_FAIL_CLOSED_FAILED"; fi
  if S1_FAULT_INJECT=ps-unreadable live_group_members "$own_group" >/dev/null 2>&1; then
    failed "SELF_TEST_FAIL_CLOSED_FAILED"
  fi
  if S1_FAULT_INJECT=ps-unreadable pid_is_live "$$"; then failed "SELF_TEST_FAIL_CLOSED_FAILED"; fi
  local injected_liveness=0
  S1_FAULT_INJECT=ps-unreadable pid_is_live "$$" || injected_liveness=$?
  ((injected_liveness == 2)) || failed "SELF_TEST_FAIL_CLOSED_FAILED"
  # A plain Bun exit 1 is not ESRCH. The probe must carry an explicit private
  # state marker before a kernel absence gate may accept it.
  S1_KERNEL_PROBE_FAULT=bun-exit-1 kernel_signal_zero_state "$$" || probe_state=$?
  ((probe_state == 2)) || failed "SELF_TEST_KERNEL_PROBE_FAIL_OPEN"
  log_phase "self-test-kernel-probe-refused" "fault=bun-exit-1 state=unknown"
  # And an unattributable group is never signalled: with inspection unavailable,
  # `group_is_ours` must refuse rather than fall through to "no such pid, go ahead".
  if S1_FAULT_INJECT=ps-unreadable group_is_ours "$own_group" "any-identity" "s1-marker"; then
    failed "SELF_TEST_FAIL_CLOSED_FAILED"
  fi
  # Exercise both malformed-row shapes through the production parser. In
  # particular, the malformed row is emitted after this shell's valid row so an
  # early per-record awk exit cannot be rescued by a later END action.
  for parser_fault in ps-malformed-after-self ps-truncated-tail ps-truncated-before-self; do
    if S1_FAULT_INJECT="$parser_fault" ps_table >/dev/null 2>&1; then
      failed "SELF_TEST_PARSER_FAIL_OPEN"
    fi
    log_phase "self-test-parser-refused" "fault=$parser_fault action=not-accepted"
  done
  FAULT_ACTIVE=0
  # A busy host can lose an unrelated process between ps selecting and
  # formatting its row, making one otherwise-valid global snapshot unknown.
  # Reuse the production tri-state retry: only a positive live observation
  # passes, while confirmed absence or persistent inspection failure remains a
  # hard refusal.
  wait_for_pid_live "$$" || failed "SELF_TEST_SELF_INVISIBLE"

  diagnostic="$(emit "pass" "SELF_TEST_PASSED")"
  [[ "$diagnostic" != *"$fragment_sentinel"* && "$diagnostic" != *"v1."* ]] || failed "SELF_TEST_REDACTION_FAILED"
  printf '%s\n' "$diagnostic"
}

# The cleanup contract is exercised through production `terminate_child`, not a
# copy. The payload may exit before its descendant, but the *pinned supervisor*
# stays alive and authorizes cleanup. Leaderless groups are tested only as refusal
# paths below; they are never treated as owned cleanup targets.
self_test_lifecycle() {
  local mode="${1:-group}"
  local leader descendant members="" survivors pid_file child_status="" status_read=0
  local descendant_deadline status_deadline observation_deadline
  local liveness=0

  STATE_DIR="$(mktemp -d -t asimposium-s1-lifecycle)"
  [[ -d "$STATE_DIR" && ! -L "$STATE_DIR" ]] || failed "LIFECYCLE_STATE_DIR_INVALID"
  PHASE_LOG="$STATE_DIR/phases.log"
  : >"$PHASE_LOG"
  pid_file="$STATE_DIR/descendant.pid"
  log_phase "lifecycle-state-retained" "dir=$STATE_DIR mode=$mode"

  if [[ "$mode" == "group-kill" ]]; then
    start_owned_fixture "$pid_file" "exit-kill"
  else
    start_owned_fixture "$pid_file" "exit"
  fi
  leader="$SERVER_PID"

  descendant_deadline=$((SECONDS + FIXTURE_START_DEADLINE_SECONDS))
  while ((SECONDS < descendant_deadline)); do
    if [[ -s "$pid_file" ]]; then break; fi
    sleep 0.1
  done
  descendant="$(tr -d '[:space:]' <"$pid_file" 2>/dev/null || true)"
  [[ "$descendant" =~ ^[0-9]+$ ]] || failed "LIFECYCLE_DESCENDANT_UNKNOWN"
  wait_for_pid_live "$descendant" || failed "LIFECYCLE_DESCENDANT_NOT_STARTED"
  log_phase "lifecycle-descendant" "pid=$descendant leader=$leader mode=$mode"

  [[ "$(process_group_of "$descendant")" == "$leader" ]] || failed "LIFECYCLE_DESCENDANT_OUTSIDE_GROUP"
  status_deadline=$((SECONDS + FIXTURE_START_DEADLINE_SECONDS))
  while ((SECONDS < status_deadline)); do
    status_read=0
    child_status="$(recorded_child_status "$SERVER_STATUS_FILE" "$SERVER_PID" "$SERVER_STATUS_AUTH")" || status_read=$?
    ((status_read == 0)) && break
    ((status_read == 2)) && failed "LIFECYCLE_STATUS_INVALID"
    sleep 0.1
  done
  [[ "$child_status" == "0" ]] || failed "LIFECYCLE_STATUS_MISSING"
  group_is_ours "$SERVER_PGID" "$SERVER_IDENTITY" "$SERVER_MARKER" || failed "LIFECYCLE_SUPERVISOR_UNAVAILABLE"
  [[ "$SERVER_MARKER" =~ ^s1-supervisor-[a-f0-9]{32}$ ]] || failed "LIFECYCLE_MARKER_INVALID"

  # Scope the planted omission to the observation under test. Earlier process-
  # group and ownership checks need genuine snapshots or this fixture would be
  # testing a different fail-closed boundary.
  if [[ "$mode" == "group-observation-partial" ]]; then
    [[ "${S1_FAULT_INJECT:-}" == "ps-partial" ]] || failed "LIFECYCLE_OBSERVATION_FAULT_REQUIRED"
    PS_PARTIAL_OMIT_PID="$descendant"
    PS_PARTIAL_OMISSION_MARKER="$STATE_DIR/lifecycle-observation-partial"
    FAULT_ACTIVE=1
  fi

  # Membership proof and the survivor record must come from the same validated
  # process-table snapshot. A second independent read can be syntactically
  # valid yet omit the descendant, producing a false empty-success diagnostic
  # immediately after `group_contains` observed it. Retry any snapshot that
  # does not contain the required live descendant, but keep the retry bounded.
  observation_deadline=$((SECONDS + FIXTURE_START_DEADLINE_SECONDS))
  while ((SECONDS < observation_deadline)); do
    members=""
    if members="$(live_group_members "$leader")" &&
      printf '%s\n' "$members" | awk -v wanted="$descendant" '$1 == wanted { found = 1 } END { exit(found ? 0 : 1) }'; then
      break
    fi
    if [[ "$mode" == "group-observation-partial" && "$FAULT_ACTIVE" == "1" &&
      -f "$PS_PARTIAL_OMISSION_MARKER" ]]; then
      FAULT_ACTIVE=0
      log_phase "lifecycle-observation-retried" \
        "leader=$leader required=$descendant reason=validated-snapshot-omitted-required-pid"
    fi
    members=""
    sleep 0.1
  done
  [[ -n "$members" ]] || failed "LIFECYCLE_DESCENDANT_ALREADY_GONE"
  if [[ "$mode" == "group-observation-partial" ]]; then
    [[ -f "$PS_PARTIAL_OMISSION_MARKER" ]] || failed "LIFECYCLE_OBSERVATION_OMISSION_NOT_DETECTED"
    FAULT_ACTIVE=0
    PS_PARTIAL_OMIT_PID=""
    PS_PARTIAL_OMISSION_MARKER=""
  fi
  survivors="$(commas "$members")"
  log_phase "lifecycle-pinned-supervisor" "leader=$leader status=$child_status survivors=$survivors"

  terminate_child "$SERVER_PID" "$SERVER_PGID" "$SERVER_IDENTITY" "$SERVER_MARKER" "lifecycle" ||
    failed "LIFECYCLE_CLEANUP_INCOMPLETE"
  clear_server_state

  # "Gone" must be a positive observation. An unreadable process table answers
  # neither way, so it is a failure here rather than an absence of survivors.
  liveness=0
  wait_for_pid_absence "$descendant" || liveness=$?
  ((liveness == 1)) || failed "LIFECYCLE_DESCENDANT_SURVIVED"
  # terminate_child already returned only after its bounded post-KILL gate saw
  # both an empty validated table and ESRCH for the owned group. Re-reading one
  # transient table here cannot strengthen that proof and can only convert a
  # completed cleanup into an unrelated inspection failure.
  if [[ "$mode" == "group-kill" ]]; then
    # The escalation is the point of this mode: a TERM-proof descendant must be
    # reported as a survivor and then actually killed, not quietly left behind.
    grep -q "lifecycle-survivors" "$PHASE_LOG" || failed "LIFECYCLE_ESCALATION_UNREPORTED"
    grep -q "lifecycle-killed" "$PHASE_LOG" || failed "LIFECYCLE_ESCALATION_MISSING"
  fi
  # The ordinary fixture's payload has exited, but its supervisor is retired by
  # the group's KILL/absence proof. Calling this a "drained" group would falsely
  # describe the final supervisor retirement as a normal payload exit.
  log_phase "lifecycle-group-retired" \
    "mode=$mode supervisor=$leader descendant=$descendant cleanup=post-kill-absence-proven"

  emit "pass" "LIFECYCLE_SELF_TEST_PASSED"
}

# These faults happen after `$!` is owned by this shell but before CONT may
# release the payload. Both failures must use only the unreaped direct-child
# authority, wait it, and leave neither a supervisor nor a process group behind.
self_test_preexec_failure() {
  local kind="$1"
  local label="preexec-${kind}"
  local status_file="$STATE_DIR/.${label}-status"
  local payload_sentinel="$STATE_DIR/${label}-payload-ran"
  local reaped_pid="" kind_code="" liveness=0

  lifecycle_state_dir "$label"
  status_file="$STATE_DIR/.${label}-status"
  payload_sentinel="$STATE_DIR/${label}-payload-ran"
  FAULT_ACTIVE=1
  # shellcheck disable=SC2016
  if start_pinned_supervisor "$status_file" "$label" \
    bash -c 'printf payload-ran >"$1"' bash "$payload_sentinel"; then
    failed "PREEXEC_FAULT_NOT_OBSERVED"
  fi
  FAULT_ACTIVE=0
  [[ ! -e "$payload_sentinel" ]] || failed "PREEXEC_PAYLOAD_RAN"
  [[ -z "$PROVISIONAL_PID$PROVISIONAL_PGID$PROVISIONAL_IDENTITY$PROVISIONAL_MARKER" ]] ||
    failed "PREEXEC_PROVISIONAL_OWNERSHIP_RETAINED"
  [[ "$LIFECYCLE_CRITICAL" == "0" ]] || failed "PREEXEC_CRITICAL_SECTION_RETAINED"

  reaped_pid="$(awk -v phase="${label}-preexec-reaped" '
    $2 == phase {
      for (field_index = 3; field_index <= NF; field_index += 1) {
        if ($field_index ~ /^pid=/) {
          sub(/^pid=/, "", $field_index)
          print $field_index
          exit
        }
      }
    }
  ' "$PHASE_LOG")"
  [[ "$reaped_pid" =~ ^[0-9]+$ ]] || failed "PREEXEC_REAP_PID_UNKNOWN"
  wait_for_pid_absence "$reaped_pid" || liveness=$?
  ((liveness == 1)) || failed "PREEXEC_DIRECT_CHILD_SURVIVED"
  if ! kernel_group_absent "$reaped_pid"; then failed "PREEXEC_GROUP_SURVIVED"; fi
  grep -q "${label}-preexec-kill.*scope=direct" "$PHASE_LOG" || failed "PREEXEC_GROUP_SIGNALLED"
  log_phase "preexec-failure-cleaned" "kind=$kind pid=$reaped_pid group_empty=yes payload=not-started"
  kind_code="${kind//-/_}"
  emit "pass" "PREEXEC_${kind_code^^}_SELF_TEST_PASSED"
}

# Plant a wrong exact birth identity for a real, marker-bound provisional child.
# The first call must reach the production direct-reap branch and refuse to
# signal; restoring the captured identity then lets that same branch retire it.
self_test_provisional_pid_reuse() {
  local status_file saved_identity pid liveness=0
  lifecycle_state_dir "provisional-pid-reuse"
  status_file="$STATE_DIR/.provisional-pid-reuse-status"
  start_pinned_supervisor "$status_file" "provisional-reuse" bash -c 'sleep 300' ||
    failed "PROVISIONAL_REUSE_START_FAILED"
  LIFECYCLE_CRITICAL=0
  saved_identity="$PROVISIONAL_IDENTITY"
  pid="$PROVISIONAL_PID"
  PROVISIONAL_IDENTITY="${saved_identity} planted-recycled-birth"
  if reap_provisional_direct_child; then failed "PROVISIONAL_REUSE_SIGNALLED"; fi
  grep -q "provisional-reuse-preexec-identity-mismatch.*action=not-signalled" "$PHASE_LOG" ||
    failed "PROVISIONAL_REUSE_REFUSAL_MISSING"
  if grep -q "provisional-reuse-preexec-kill" "$PHASE_LOG"; then
    failed "PROVISIONAL_REUSE_KILL_RECORDED"
  fi
  PROVISIONAL_IDENTITY="$saved_identity"
  group_is_ours "$pid" "$saved_identity" "$PROVISIONAL_MARKER" ||
    failed "PROVISIONAL_REUSE_VICTIM_CHANGED"
  log_phase "provisional-reuse-refused" "pid=$pid survived=yes action=not-signalled"
  reap_provisional_direct_child || failed "PROVISIONAL_REUSE_FINAL_REAP_FAILED"
  wait_for_pid_absence "$pid" || liveness=$?
  ((liveness == 1)) || failed "PROVISIONAL_REUSE_CHILD_SURVIVED"
  if ! kernel_group_absent "$pid"; then failed "PROVISIONAL_REUSE_GROUP_SURVIVED"; fi
  emit "pass" "PROVISIONAL_PID_REUSE_SELF_TEST_PASSED"
}

# Keep every bounded exact-identity observation unknown, prove that no signal is
# sent, then remove only the planted inspection fault and safely retire the same
# still-live provisional child.
self_test_provisional_inspection_unknown() {
  local status_file pid liveness=0
  [[ "${S1_FAULT_INJECT:-}" == "provisional-inspection-unknown" ]] ||
    failed "PROVISIONAL_INSPECTION_FAULT_REQUIRED"
  lifecycle_state_dir "provisional-inspection-unknown"
  status_file="$STATE_DIR/.provisional-inspection-unknown-status"
  start_pinned_supervisor "$status_file" "provisional-unknown" bash -c 'sleep 300' ||
    failed "PROVISIONAL_INSPECTION_START_FAILED"
  LIFECYCLE_CRITICAL=0
  pid="$PROVISIONAL_PID"
  FAULT_ACTIVE=1
  if reap_provisional_direct_child; then failed "PROVISIONAL_INSPECTION_SIGNALLED"; fi
  FAULT_ACTIVE=0
  grep -q "provisional-unknown-preexec-inspection-unknown.*action=not-signalled.*deadline_s=${TRANSIENT_INSPECTION_DEADLINE_SECONDS}" "$PHASE_LOG" ||
    failed "PROVISIONAL_INSPECTION_REFUSAL_MISSING"
  if grep -q "provisional-unknown-preexec-kill" "$PHASE_LOG"; then
    failed "PROVISIONAL_INSPECTION_KILL_RECORDED"
  fi
  group_is_ours "$pid" "$PROVISIONAL_IDENTITY" "$PROVISIONAL_MARKER" ||
    failed "PROVISIONAL_INSPECTION_VICTIM_CHANGED"
  log_phase "provisional-inspection-refused" "pid=$pid survived=yes action=not-signalled"
  reap_provisional_direct_child || failed "PROVISIONAL_INSPECTION_FINAL_REAP_FAILED"
  wait_for_pid_absence "$pid" || liveness=$?
  ((liveness == 1)) || failed "PROVISIONAL_INSPECTION_CHILD_SURVIVED"
  if ! kernel_group_absent "$pid"; then failed "PROVISIONAL_INSPECTION_GROUP_SURVIVED"; fi
  emit "pass" "PROVISIONAL_INSPECTION_UNKNOWN_SELF_TEST_PASSED"
}

# Every named checkpoint sends a real TERM while launch/adoption state is
# critical. The trap must defer it, and the critical-section closer must dispatch
# it only after either no child exists or the child is atomically in CLIENT/SERVER.
self_test_lifecycle_critical_window() {
  local owner="${S1_INTERRUPT_OWNER:-}" status_file
  [[ -n "${S1_INTERRUPT_WINDOW:-}" ]] || failed "LIFECYCLE_WINDOW_REQUIRED"
  [[ "$owner" == "client" || "$owner" == "server" ]] || failed "LIFECYCLE_OWNER_REQUIRED"
  case "$S1_INTERRUPT_WINDOW" in
    before-background-spawn|after-background-spawn|after-stop-proof|after-identity-proof|before-cont-reproof|after-cont-release|function-return) ;;
    caller-adoption-client|caller-adopted-client) [[ "$owner" == "client" ]] || failed "LIFECYCLE_WINDOW_OWNER_MISMATCH" ;;
    caller-adoption-server|caller-adopted-server) [[ "$owner" == "server" ]] || failed "LIFECYCLE_WINDOW_OWNER_MISMATCH" ;;
    *) failed "LIFECYCLE_WINDOW_INVALID" ;;
  esac
  lifecycle_state_dir "critical-${S1_INTERRUPT_WINDOW}"
  if [[ "$owner" == "client" ]]; then
    run_with_deadline 300 bash -c 'sleep 300'
  else
    status_file="$STATE_DIR/.critical-server-status"
    start_pinned_supervisor "$status_file" "critical-server" bash -c 'sleep 300' ||
      failed "LIFECYCLE_WINDOW_START_FAILED"
    if ! adopt_provisional_supervisor server; then
      finish_lifecycle_critical
      failed "LIFECYCLE_WINDOW_ADOPTION_FAILED"
    fi
  fi
  failed "LIFECYCLE_WINDOW_INTERRUPT_NOT_DISPATCHED"
}

# The body emits a typed non-zero failure while a short-lived owned group remains.
# Persistent inspection failure makes both EXIT cleanup attempts incomplete. The
# final record must therefore be CLEANUP_INCOMPLETE even though the body was
# already non-zero; the fixture exits naturally so this proof leaves no survivor.
self_test_cleanup_terminal_order() {
  local marker identity="" identity_status=0 identity_deadline
  [[ "${S1_FAULT_INJECT:-}" == "ps-unreadable" ]] || failed "CLEANUP_TERMINAL_FAULT_REQUIRED"
  lifecycle_state_dir "cleanup-terminal-order"
  marker="$(new_supervisor_marker)" || failed "CLEANUP_TERMINAL_MARKER_UNAVAILABLE"
  set -m
  bash -c 'sleep 2; :' "$marker" &
  SERVER_PID="$!"
  set +m
  identity_deadline="$(transient_retry_deadline_us)" || failed "CLEANUP_TERMINAL_CLOCK_UNAVAILABLE"
  while :; do
    identity_status=0
    identity="$(process_identity "$SERVER_PID" "$marker")" || identity_status=$?
    if ((identity_status == 0)); then break; fi
    transient_retry_deadline_elapsed "$identity_deadline" && break
    sleep 0.02
  done
  ((identity_status == 0)) || failed "CLEANUP_TERMINAL_IDENTITY_UNAVAILABLE"
  SERVER_PGID="$SERVER_PID"
  SERVER_IDENTITY="$identity"
  SERVER_MARKER="$marker"
  log_phase "cleanup-terminal-child" "leader=$SERVER_PID body_exit=1 natural_exit=yes"
  FAULT_ACTIVE=1
  failed "BODY_FAILURE_EXPECTED"
}

# A state directory for the self-test modes. Retained like every other one.
lifecycle_state_dir() {
  local suffix="$1"
  STATE_DIR="$(mktemp -d -t "asimposium-s1-${suffix}")"
  [[ -d "$STATE_DIR" && ! -L "$STATE_DIR" ]] || failed "LIFECYCLE_STATE_DIR_INVALID"
  PHASE_LOG="$STATE_DIR/phases.log"
  FAULT_ONCE_MARKER="$STATE_DIR/fault-once-consumed"
  : >"$PHASE_LOG"
  log_phase "state-retained" "dir=$STATE_DIR mode=$suffix"
}

# Start an owned fixture beneath the same pinned supervisor used by client and
# worker paths. `exit` means the payload exits after writing its descendant PID;
# the supervisor's retained status becomes the proof that cleanup must still
# retire the whole pinned group.
start_owned_fixture() {
  local pid_file="$1"
  local leader_mode="$2"
  local status_file="$STATE_DIR/.fixture-exit-status" deadline
  # shellcheck disable=SC2016
  if ! start_pinned_supervisor "$status_file" "fixture" \
    bash -c '
      pid_file="$1"
      mode="$2"
      if [[ "$mode" == *-kill ]]; then
        bash -c "trap \"\" TERM; sleep 300" &
      else
        sleep 300 &
      fi
      printf "%s\n" "$!" >"$pid_file"
      sleep 0.3
      case "$mode" in
        exit|exit-kill) exit 0 ;;
      esac
      sleep 300
  ' bash "$pid_file" "$leader_mode"; then
    failed "FIXTURE_GROUP_UNOWNED"
  fi
  if ! adopt_provisional_supervisor server; then
    finish_lifecycle_critical
    failed "FIXTURE_GROUP_UNOWNED"
  fi

  deadline=$((SECONDS + FIXTURE_START_DEADLINE_SECONDS))
  while ((SECONDS < deadline)); do
    if [[ -s "$pid_file" ]]; then break; fi
    sleep 0.1
  done
  FIXTURE_DESCENDANT="$(tr -d '[:space:]' <"$pid_file" 2>/dev/null || true)"
  [[ "$FIXTURE_DESCENDANT" =~ ^[0-9]+$ ]] || failed "FIXTURE_DESCENDANT_UNKNOWN"
  wait_for_pid_live "$FIXTURE_DESCENDANT" || failed "FIXTURE_DESCENDANT_NOT_STARTED"
  [[ "$(process_group_of "$FIXTURE_DESCENDANT")" == "$SERVER_PGID" ]] ||
    failed "FIXTURE_DESCENDANT_OUTSIDE_GROUP"
  log_phase "fixture-started" "leader=$SERVER_PID pgid=$SERVER_PGID descendant=$FIXTURE_DESCENDANT mode=$leader_mode"
}

# A leaderless recorded group is never authorized: this test first proves that
# absence refuses even with the former identity, then proves a blank/unowned
# group field sends no signal to a real pinned-supervisor descendant.
self_test_unowned_refusal() {
  local pid_file liveness=0 dead_leader="" dead_identity="" dead_marker=""
  lifecycle_state_dir "unowned-refusal"
  pid_file="$STATE_DIR/descendant.pid"
  dead_marker="$(new_supervisor_marker)" || failed "UNOWNED_DEAD_MARKER_UNAVAILABLE"
  set -m
  bash -c 'sleep 0.3; exit 0' "$dead_marker" &
  dead_leader="$!"
  set +m
  dead_identity="$(process_identity "$dead_leader" "$dead_marker")" || failed "UNOWNED_DEAD_IDENTITY_UNAVAILABLE"
  wait "$dead_leader" 2>/dev/null || true
  if group_is_ours "$dead_leader" "$dead_identity" "$dead_marker"; then
    failed "UNOWNED_LEADERLESS_GROUP_ACCEPTED"
  fi
  log_phase "leader-absent-refused" \
    "pid=$dead_leader marker=exact reason=leader-absent action=not-signalled"

  start_owned_fixture "$pid_file" "linger"
  wait_for_pid_live "$FIXTURE_DESCENDANT" || failed "UNOWNED_DESCENDANT_NOT_LIVE"
  group_contains "$SERVER_PGID" "$FIXTURE_DESCENDANT" || failed "UNOWNED_GROUP_NOT_RETAINED"

  if terminate_child "$SERVER_PID" "" "$SERVER_IDENTITY" "$SERVER_MARKER" "unowned"; then
    failed "UNOWNED_GROUP_ACCEPTED"
  fi
  wait_for_pid_live "$FIXTURE_DESCENDANT" || failed "UNOWNED_REFUSAL_SIGNALLED"
  group_contains "$SERVER_PGID" "$FIXTURE_DESCENDANT" || failed "UNOWNED_REFUSAL_GROUP_CHANGED"
  log_phase "unowned-refused" "leader=$SERVER_PID descendant=$FIXTURE_DESCENDANT action=not-signalled"

  terminate_child "$SERVER_PID" "$SERVER_PGID" "$SERVER_IDENTITY" "$SERVER_MARKER" "unowned-fixture" ||
    failed "UNOWNED_FIXTURE_CLEANUP_INCOMPLETE"
  clear_server_state
  wait_for_pid_absence "$FIXTURE_DESCENDANT" || liveness=$?
  ((liveness == 1)) || failed "UNOWNED_FIXTURE_DESCENDANT_SURVIVED"
  emit "pass" "UNOWNED_REFUSAL_SELF_TEST_PASSED"
}

# A successful client supervisor whose real command leaves a descendant must not
# clear CLIENT_* just because the supervisor itself exited 0. The completion
# path must observe and remove the remnant group before it returns success.
self_test_client_success_descendant() {
  local pid_file client_exit=0 liveness=0
  lifecycle_state_dir "client-success-descendant"
  pid_file="$STATE_DIR/descendant.pid"
  # shellcheck disable=SC2016
  run_with_deadline 20 env S1_LIFECYCLE_PID_FILE="$pid_file" bash -c '
    sleep 300 &
    printf "%s\n" "$!" >"$S1_LIFECYCLE_PID_FILE"
    sleep 0.3
    exit 0
  ' || client_exit=$?
  ((client_exit == 0)) || failed "CLIENT_SUCCESS_FIXTURE_FAILED"
  FIXTURE_DESCENDANT="$(tr -d '[:space:]' <"$pid_file" 2>/dev/null || true)"
  [[ "$FIXTURE_DESCENDANT" =~ ^[0-9]+$ ]] || failed "CLIENT_SUCCESS_DESCENDANT_UNKNOWN"
  [[ -z "$CLIENT_PID$CLIENT_PGID$CLIENT_IDENTITY" ]] || failed "CLIENT_SUCCESS_OWNERSHIP_NOT_CLEARED"
  wait_for_pid_absence "$FIXTURE_DESCENDANT" || liveness=$?
  ((liveness == 1)) || failed "CLIENT_SUCCESS_DESCENDANT_SURVIVED"
  log_phase "client-success-cleaned" "descendant=$FIXTURE_DESCENDANT group_empty=yes"
  emit "pass" "CLIENT_SUCCESS_DESCENDANT_SELF_TEST_PASSED"
}

# A valid partial table is not a complete table. This plants an actual omission
# of a TERM-proof descendant from an otherwise validated snapshot. Cleanup must
# not call the visible supervisor an empty/sole-member success: while the pinned
# identity is live it KILLs the owned group, then requires kernel-group absence.
self_test_partial_ps() {
  local pid_file liveness=0
  [[ "${S1_FAULT_INJECT:-}" == "ps-partial" ]] || failed "PARTIAL_PS_FAULT_REQUIRED"
  lifecycle_state_dir "partial-ps"
  pid_file="$STATE_DIR/descendant.pid"
  start_owned_fixture "$pid_file" "linger-kill"
  PS_PARTIAL_OMIT_PID="$FIXTURE_DESCENDANT"
  PS_PARTIAL_OMISSION_MARKER="$STATE_DIR/partial-ps-omission-observed"
  FAULT_ACTIVE=1
  cleanup_all || failed "PARTIAL_PS_CLEANUP_INCOMPLETE"
  [[ -z "$SERVER_PID$SERVER_PGID$SERVER_IDENTITY" ]] || failed "PARTIAL_PS_OWNERSHIP_RETAINED"
  FAULT_ACTIVE=0
  wait_for_pid_absence "$FIXTURE_DESCENDANT" || liveness=$?
  ((liveness == 1)) || failed "PARTIAL_PS_DESCENDANT_SURVIVED"
  [[ -f "$PS_PARTIAL_OMISSION_MARKER" ]] || failed "PARTIAL_PS_OMISSION_NOT_DETECTED"
  grep -q "child-omitted-descendant-suspected" "$PHASE_LOG" || failed "PARTIAL_PS_OMISSION_NOT_DETECTED"
  grep -q "child-killed" "$PHASE_LOG" || failed "PARTIAL_PS_GROUP_KILL_MISSING"
  log_phase "partial-ps-killed" "descendant=$FIXTURE_DESCENDANT omission=observed kernel_group=absent"
  emit "pass" "PARTIAL_PS_SELF_TEST_PASSED"
}

# The no-fault control has the same TERM-proof descendant, but no synthetic row
# omission. Its ordinary survivor path must not be mislabeled as detection of a
# validated snapshot omission.
self_test_partial_ps_negative_control() {
  local pid_file liveness=0
  lifecycle_state_dir "partial-ps-negative-control"
  pid_file="$STATE_DIR/descendant.pid"
  start_owned_fixture "$pid_file" "linger-kill"
  cleanup_all || failed "PARTIAL_PS_CONTROL_CLEANUP_INCOMPLETE"
  wait_for_pid_absence "$FIXTURE_DESCENDANT" || liveness=$?
  ((liveness == 1)) || failed "PARTIAL_PS_CONTROL_DESCENDANT_SURVIVED"
  if grep -q "child-omitted-descendant-suspected" "$PHASE_LOG"; then
    failed "PARTIAL_PS_CONTROL_FALSE_OMISSION"
  fi
  grep -q "child-survivors" "$PHASE_LOG" || failed "PARTIAL_PS_CONTROL_SURVIVOR_UNREPORTED"
  log_phase "partial-ps-control-cleaned" "descendant=$FIXTURE_DESCENDANT omission=not-observed"
  emit "pass" "PARTIAL_PS_NEGATIVE_CONTROL_SELF_TEST_PASSED"
}

# Exercise the exact terminal mapper used by the local-D1 main path. Code 125
# is internal containment evidence, never an untyped process exit.
self_test_client_containment_terminal() {
  terminal_local_client_failure 125
}

# The first interrupt cleanup is deliberately unable to inspect its owned group.
# EXIT consumes the one-shot fault and must correct the terminal outcome to the
# original interrupt once that second bounded cleanup succeeds.
self_test_interrupt_cleanup_retry() {
  local pid_file controller_deadline
  [[ "${S1_FAULT_INJECT:-}" == "ps-once" ]] || failed "INTERRUPT_RETRY_FAULT_REQUIRED"
  lifecycle_state_dir "interrupt-cleanup-retry"
  pid_file="$STATE_DIR/descendant.pid"
  start_owned_fixture "$pid_file" "linger-kill"
  FAULT_ACTIVE=1
  log_phase "interrupt-retry-ready" "leader=$SERVER_PID descendant=$FIXTURE_DESCENDANT"
  # Keep returning to bash between short sleeps so its TERM trap can run; this
  # mode waits for the test controller, but is also self-bounded. If the
  # controller dies without delivering TERM, the typed failure reaches EXIT,
  # which consumes the planted first-inspection fault and retires the exact
  # owned group on its bounded retry.
  controller_deadline=$((SECONDS + SELF_TEST_CONTROLLER_DEADLINE_SECONDS))
  while ((SECONDS < controller_deadline)); do sleep 0.1; done
  failed "INTERRUPT_RETRY_CONTROLLER_DEADLINE"
}

# Feed genuinely invalid snapshots through the production parser while an owned
# fixture is live. Cleanup must refuse without a signal and retain ownership;
# after removing only the planted table corruption, the same owned group must be
# retired and independently observed absent.
self_test_ps_parser_refusal() {
  local fault="${S1_FAULT_INJECT:-}" pid_file leader liveness=0
  [[ "$fault" == "ps-malformed-after-self" || "$fault" == "ps-truncated-tail" || "$fault" == "ps-truncated-before-self" ]] ||
    failed "PS_PARSER_FAULT_REQUIRED"
  lifecycle_state_dir "${fault}"
  pid_file="$STATE_DIR/descendant.pid"
  start_owned_fixture "$pid_file" "linger"
  leader="$SERVER_PGID"
  FAULT_ACTIVE=1
  if cleanup_all; then failed "PS_PARSER_INVALID_TABLE_ACCEPTED"; fi
  FAULT_ACTIVE=0
  [[ -n "$SERVER_PID$SERVER_PGID$SERVER_IDENTITY$SERVER_MARKER" ]] ||
    failed "PS_PARSER_OWNERSHIP_DROPPED"
  wait_for_pid_live "$FIXTURE_DESCENDANT" || failed "PS_PARSER_SURVIVOR_LOST"
  group_contains "$SERVER_PGID" "$FIXTURE_DESCENDANT" || failed "PS_PARSER_GROUP_CHANGED"
  grep -q "child-inspection-unavailable.*phase=pre-signal" "$PHASE_LOG" ||
    failed "PS_PARSER_REFUSAL_UNREPORTED"
  if grep -Eq "child-(terminated|survivors|killed|signal-failed)" "$PHASE_LOG"; then
    failed "PS_PARSER_REFUSAL_SIGNALLED"
  fi
  log_phase "ps-parser-refused" \
    "fault=$fault descendant=$FIXTURE_DESCENDANT survived=yes action=not-signalled"
  cleanup_all || failed "PS_PARSER_SURVIVOR_CLEANUP_INCOMPLETE"
  wait_for_pid_absence "$FIXTURE_DESCENDANT" || liveness=$?
  ((liveness == 1)) || failed "PS_PARSER_DESCENDANT_SURVIVED"
  if ! kernel_group_absent "$leader"; then failed "PS_PARSER_GROUP_SURVIVED"; fi
  log_phase "ps-parser-survivor-cleaned" \
    "fault=$fault descendant=$FIXTURE_DESCENDANT group_empty=yes"
  emit "pass" "PS_TABLE_PARSER_REFUSAL_SELF_TEST_PASSED"
}

# The first cleanup sees a deliberately unavailable table and leaves ownership
# intact. `failed` then reaches EXIT, whose retry consumes the one-shot fault and
# proves the same group empty. The test intentionally exits non-zero: its proof is
# the later cleanup record and the absence of its recorded descendant.
self_test_cleanup_retry() {
  local pid_file
  [[ "${S1_FAULT_INJECT:-}" == "ps-once" ]] || failed "CLEANUP_RETRY_FAULT_REQUIRED"
  lifecycle_state_dir "cleanup-retry"
  pid_file="$STATE_DIR/descendant.pid"
  start_owned_fixture "$pid_file" "linger"
  FAULT_ACTIVE=1
  if cleanup_all; then failed "CLEANUP_RETRY_FAULT_NOT_OBSERVED"; fi
  [[ -n "$SERVER_PID$SERVER_PGID$SERVER_IDENTITY" ]] || failed "CLEANUP_RETRY_OWNERSHIP_DROPPED"
  wait_for_pid_live "$FIXTURE_DESCENDANT" || failed "CLEANUP_RETRY_FIXTURE_LOST"
  log_phase "cleanup-retry-first-failure" "leader=$SERVER_PID descendant=$FIXTURE_DESCENDANT ownership=retained"
  failed "CLEANUP_RETRY_EXPECTED"
}

# The EXIT trap as a gate rather than a mask.
#
# This mode deliberately does the wrong thing: it emits a pass record while a child
# of its own is still running, and returns successfully. The trap is then the only
# thing between that and a false green, which is the point of the mode.
#
#   * with inspection working, the trap cleans the group up and the run stays 0 —
#     the pass is true by the time the process exits;
self_test_exit_gate() {
  local descendant pid_file deadline
  lifecycle_state_dir "exit-gate"
  pid_file="$STATE_DIR/descendant.pid"
  start_owned_fixture "$pid_file" "linger-kill"

  deadline=$((SECONDS + FIXTURE_START_DEADLINE_SECONDS))
  while ((SECONDS < deadline)); do
    if [[ -s "$pid_file" ]]; then break; fi
    sleep 0.1
  done
  descendant="$(tr -d '[:space:]' <"$pid_file" 2>/dev/null || true)"
  [[ "$descendant" =~ ^[0-9]+$ ]] || failed "EXIT_GATE_DESCENDANT_UNKNOWN"
  log_phase "exit-gate-child" "pid=$SERVER_PID pgid=$SERVER_PGID descendant=$descendant"

  # Arm a one-shot table failure only after the fixture's launch proof. The
  # first cleanup is in EXIT, so the second bounded EXIT attempt is the authority
  # for recovering rather than leaving a stopped group behind a pre-emitted pass.
  if [[ "${S1_FAULT_INJECT:-}" == "ps-once" ]]; then
    FAULT_ACTIVE=1
  fi

  # Deliberately out of order, and deliberately without cleaning up first.
  emit "pass" "EXIT_GATE_SELF_TEST_PASSED"
  log_phase "result-emitted" "status=pass code=EXIT_GATE_SELF_TEST_PASSED"

}

# Status records have three deliberately different outcomes: absent means the
# payload can still be running; a symlink/directory/stale record is untrusted and
# must fail the caller instead of extending readiness or minting an exit status.
self_test_status_integrity() {
  local missing malformed directory link stale foreign_auth root_link original_state_dir auth status_read=0
  lifecycle_state_dir "status-integrity"
  auth="$(new_status_authenticator)" || failed "STATUS_AUTH_UNAVAILABLE"
  missing="$STATE_DIR/absent-status"
  recorded_child_status "$missing" "123" "$auth" || status_read=$?
  ((status_read == 1)) || failed "STATUS_ABSENT_NOT_RUNNING"

  malformed="$STATE_DIR/status-malformed"
  printf 'this is not a status record\n' >"$malformed"
  status_read=0
  recorded_child_status "$malformed" "123" "$auth" || status_read=$?
  ((status_read == 2)) || failed "STATUS_MALFORMED_ACCEPTED"

  directory="$STATE_DIR/status-directory"
  mkdir "$directory"
  status_read=0
  recorded_child_status "$directory" "123" "$auth" || status_read=$?
  ((status_read == 2)) || failed "STATUS_DIRECTORY_ACCEPTED"

  link="$STATE_DIR/status-link"
  ln -s "$directory" "$link"
  status_read=0
  recorded_child_status "$link" "123" "$auth" || status_read=$?
  ((status_read == 2)) || failed "STATUS_SYMLINK_ACCEPTED"

  stale="$STATE_DIR/status-stale"
  printf '%s %s %s\n' "$auth" "999" "0" >"$stale"
  status_read=0
  recorded_child_status "$stale" "123" "$auth" || status_read=$?
  ((status_read == 2)) || failed "STATUS_STALE_ACCEPTED"

  foreign_auth="$STATE_DIR/status-foreign-auth"
  printf '%s %s %s\n' "s1status-00000000000000000000000000000000" "123" "0" >"$foreign_auth"
  status_read=0
  recorded_child_status "$foreign_auth" "123" "$auth" || status_read=$?
  ((status_read == 2)) || failed "STATUS_FOREIGN_AUTH_ACCEPTED"

  # An ordinary missing final component below a symlinked state root is not the
  # benign "payload still running" case. Restore the real root before emitting
  # so retained phase logging remains private and authentically attributable.
  original_state_dir="$STATE_DIR"
  root_link="$STATE_DIR/state-root-link"
  ln -s "$STATE_DIR" "$root_link"
  STATE_DIR="$root_link"
  status_read=0
  recorded_child_status "$STATE_DIR/absent-status" "123" "$auth" || status_read=$?
  STATE_DIR="$original_state_dir"
  ((status_read == 2)) || failed "STATUS_PARENT_SYMLINK_ACCEPTED"
  log_phase "status-integrity-refused" "absent=running malformed=tested-and-untrusted stale=untrusted"
  emit "pass" "STATUS_INTEGRITY_SELF_TEST_PASSED"
}

# A real timed client has an ordinary payload plus a TERM-proof descendant. The
# deadline must return 124 only after the same bounded group cleanup proves both
# are gone; an elapsed wall clock by itself is not enough.
self_test_deadline() {
  local pid_file client_exit=0 liveness=0
  lifecycle_state_dir "deadline"
  pid_file="$STATE_DIR/descendant.pid"
  # shellcheck disable=SC2016
  run_with_deadline 1 env S1_LIFECYCLE_PID_FILE="$pid_file" bash -c '
    bash -c "trap \"\" TERM; sleep 300" &
    printf "%s\n" "$!" >"$S1_LIFECYCLE_PID_FILE"
    sleep 300
  ' || client_exit=$?
  ((client_exit == 124)) || failed "DEADLINE_STATUS_INVALID"
  FIXTURE_DESCENDANT="$(tr -d '[:space:]' <"$pid_file" 2>/dev/null || true)"
  [[ "$FIXTURE_DESCENDANT" =~ ^[0-9]+$ ]] || failed "DEADLINE_DESCENDANT_UNKNOWN"
  [[ -z "$CLIENT_PID$CLIENT_PGID$CLIENT_IDENTITY" ]] || failed "DEADLINE_OWNERSHIP_RETAINED"
  wait_for_pid_absence "$FIXTURE_DESCENDANT" || liveness=$?
  ((liveness == 1)) || failed "DEADLINE_DESCENDANT_SURVIVED"
  log_phase "deadline-cleaned" "descendant=$FIXTURE_DESCENDANT exit=124 group_empty=yes"
  emit "pass" "DEADLINE_SELF_TEST_PASSED"
}

# An interrupt arriving during the timed client phase.
#
# The client runs in its own process group and has a descendant of its own, which is
# what the real local-D1 client looks like from the outside. This mode blocks in
# that phase on purpose and never passes by itself: the test signals it, and the
# assertion is that the interrupt terminated *the client's* group as well as the
# server's, rather than leaving it holding connections.
self_test_client_group() {
  local pid_file client_exit=0
  lifecycle_state_dir "client-group"
  pid_file="$STATE_DIR/descendant.pid"

  log_phase "client-phase-start" "deadline_s=$CLIENT_DEADLINE_SECONDS"
  # Deliberate: `env` sets S1_LIFECYCLE_PID_FILE in the inner shell's environment,
  # and the inner shell is the one that must expand it.
  # shellcheck disable=SC2016
  run_with_deadline "$CLIENT_DEADLINE_SECONDS" \
    env S1_LIFECYCLE_PID_FILE="$pid_file" bash -c '
      sleep 300 &
      printf "%s\n" "$!" >"$S1_LIFECYCLE_PID_FILE"
      sleep 300
    ' || client_exit=$?
  log_phase "client-phase-end" "exit=$client_exit"
  if ((client_exit == 124)); then failed "CLIENT_DEADLINE_REACHED"; fi
  # Reaching here means the phase was never interrupted, so the mode proved
  # nothing. That is a failure, not a pass.
  failed "CLIENT_PHASE_NOT_INTERRUPTED"
}

# Prove the server answering our port is the child we started, by round-tripping
# this run's token through the worker and then finding it in this run's own
# persisted D1 state. A foreign process holding the port cannot satisfy both.
assert_port_ownership() {
  local origin="$1"
  local state_dir="$2"
  local token="$3"
  local mint_body mint_status count

  mint_body="$(printf '{"sponsor_id":"%s","request":{"requested_scopes":["review"]}}' "$token")"
  if ! mint_status="$(printf '%s' "$mint_body" | curl --silent --output /dev/null \
    --write-out '%{http_code}' --request POST \
    --connect-timeout "$CONNECT_TIMEOUT_SECONDS" --max-time "$REQUEST_TIMEOUT_SECONDS" \
    --header 'Content-Type: application/json' --data-binary @- "$origin/__s1/mint" 2>/dev/null)"; then
    failed "LOCAL_PORT_OWNERSHIP_UNPROVEN"
  fi
  [[ "$mint_status" == "201" ]] || failed "LOCAL_PORT_OWNERSHIP_UNPROVEN"

  if ! count="$("$LOCAL_WRANGLER" d1 execute DB --config infra/wrangler.toml --local \
    --persist-to "$state_dir" --json \
    --command "SELECT COUNT(*) AS n FROM enrollment_records WHERE sponsor_id = '${token}'" \
    2>>"$state_dir/ownership.log" | bun -e '
const text = await Bun.stdin.text();
const parsed = JSON.parse(text.slice(text.indexOf("[")));
const rows = Array.isArray(parsed) ? (parsed[0]?.results ?? []) : [];
process.stdout.write(String(rows[0]?.n ?? 0));
' 2>/dev/null)"; then
    failed "LOCAL_PORT_OWNERSHIP_UNPROVEN"
  fi
  [[ "$count" =~ ^[0-9]+$ ]] || failed "LOCAL_PORT_OWNERSHIP_UNPROVEN"
  ((count >= 1)) || failed "LOCAL_PORT_OWNERSHIP_UNPROVEN"
  log_phase "port-ownership-proven" "rows=$count"
}

# `run_with_deadline` reserves 125 for an ownership/containment proof failure.
# That internal status must never escape as a bare process exit: callers need a
# terminal typed record, and a later EXIT cleanup must be allowed to supersede it
# only if that cleanup itself remains unproven.
terminal_local_client_failure() {
  local client_exit="$1"
  log_phase "client-failed" "exit=$client_exit"
  case "$client_exit" in
    124) failed "LOCAL_D1_CLIENT_TIMEOUT" ;;
    125) failed "LOCAL_D1_CLIENT_CONTAINMENT_UNPROVEN" ;;
    *) failed "LOCAL_D1_CLIENT_FAILED" ;;
  esac
}

run_local_d1() {
  [[ -x "$LOCAL_WRANGLER" ]] || blocked "WRANGLER_REQUIRED"

  local local_port origin token server_log server_status_file ready readiness_deadline client_exit scope
  local server_status="" server_status_read=0
  # Both resolvers refuse in this shell, so a pinned port that is invalid or busy
  # ends the run here — before mktemp, before migrations, before any child.
  resolve_port
  local_port="$RESOLVED_PORT"
  resolve_run_token
  token="$RUN_TOKEN"
  origin="http://127.0.0.1:${local_port}"

  STATE_DIR="$(mktemp -d -t asimposium-s1-enrollment)"
  # The state directory is intentionally retained on every exit path. It holds
  # local workerd state and phase logs; AGENTS.md forbids cleanup-by-deletion.
  [[ -d "$STATE_DIR" && ! -L "$STATE_DIR" ]] || failed "LOCAL_PERSIST_DIR_INVALID"
  PHASE_LOG="$STATE_DIR/phases.log"
  : >"$PHASE_LOG"
  server_log="$STATE_DIR/wrangler.log"
  log_phase "state-retained" "dir=$STATE_DIR"
  log_phase "port-allocated" "port=$local_port pinned=$([[ -n "${S1_LOCAL_PORT:-}" ]] && printf 'yes' || printf 'no')"

  if ! "$LOCAL_WRANGLER" d1 migrations apply DB --config infra/wrangler.toml --local \
    --persist-to "$STATE_DIR" >"$STATE_DIR/migrations.log" 2>&1; then
    failed "LOCAL_D1_MIGRATION_FAILED"
  fi
  log_phase "migrations-applied" "log=$STATE_DIR/migrations.log"

  # Workerd starts only beneath a stopped, identity-pinned supervisor. Its group
  # is proven before the wrapper can invoke wrangler; the wrapper remains leader
  # even if wrangler later exits before workerd, so cleanup never authorizes a
  # leaderless/recycled numeric PGID.
  server_status_file="$STATE_DIR/.server-exit-status"
  # shellcheck disable=SC2016
  if ! start_pinned_supervisor "$server_status_file" "child" \
    bash -c 'log="$1"; shift; "$@" >>"$log" 2>&1' bash "$server_log" \
    "$LOCAL_WRANGLER" dev apps/wire/src/enrollment/local-d1-worker.ts \
      --config infra/wrangler.toml --local --persist-to "$STATE_DIR" --port "$local_port" \
      --inspector-port 0 \
      --var "ENROLLMENT_REPLAY_KEY:${LOCAL_REPLAY_KEY}" \
      --log-level error --show-interactive-dev-session=false; then
    failed "LOCAL_CHILD_GROUP_UNPROVEN"
  fi
  if ! adopt_provisional_supervisor server; then
    finish_lifecycle_critical
    failed "LOCAL_CHILD_GROUP_UNPROVEN"
  fi
  scope="group"
  log_phase "child-started" \
    "pid=$SERVER_PID port=$local_port scope=$scope supervisor=pinned-before-exec"

  ready=0
  readiness_deadline=$((SECONDS + READINESS_DEADLINE_SECONDS))
  while ((SECONDS < readiness_deadline)); do
    # A pinned supervisor is the liveness proof; the worker's own completion is
    # reported separately through its private status file. Neither a dead worker
    # nor a dead/reused supervisor is allowed to look like "not ready yet".
    server_status_read=0
    server_status="$(recorded_child_status "$SERVER_STATUS_FILE" "$SERVER_PID" "$SERVER_STATUS_AUTH")" || server_status_read=$?
    if ((server_status_read == 0)); then
      log_phase "child-exited-early" "pid=$SERVER_PID status=$server_status log=$server_log"
      failed "LOCAL_WORKER_EXITED"
    fi
    if ((server_status_read == 2)); then failed "LOCAL_WORKER_STATUS_INVALID"; fi
    if ! group_is_ours "$SERVER_PGID" "$SERVER_IDENTITY" "$SERVER_MARKER"; then
      log_phase "child-supervisor-unavailable" "pid=$SERVER_PID"
      failed "LOCAL_CHILD_GROUP_UNPROVEN"
    fi
    if curl --silent --output /dev/null --connect-timeout "$CONNECT_TIMEOUT_SECONDS" \
      --max-time "$REQUEST_TIMEOUT_SECONDS" "$origin/join/ASIMP-EN-INVALID"; then
      ready=1
      break
    fi
    sleep 0.2
  done
  if [[ "$ready" -ne 1 ]]; then
    log_phase "readiness-timeout" "deadline_s=$READINESS_DEADLINE_SECONDS"
    failed "LOCAL_WORKER_UNAVAILABLE"
  fi
  log_phase "server-answering" "port=$local_port"

  assert_port_ownership "$origin" "$STATE_DIR" "$token"

  client_exit=0
  run_with_deadline "$CLIENT_DEADLINE_SECONDS" \
    env S1_LOCAL_ORIGIN="$origin" bun apps/wire/src/enrollment/local-d1-client.ts || client_exit=$?
  if ((client_exit != 0)); then
    ((client_exit == 124)) && log_phase "client-deadline" "deadline_s=$CLIENT_DEADLINE_SECONDS"
    terminal_local_client_failure "$client_exit"
  fi
  log_phase "client-passed" "exit=0"

  # Cleanup is a gate in front of success, not a courtesy behind it. A pass record
  # emitted first and cleaned up afterwards is a record the EXIT trap can only
  # contradict, and for a run whose whole subject is process lifecycle that is the
  # wrong order: the claim is that nothing of ours is left, so prove it, then claim
  # it. The port is the independent half of the proof — if anything still holds it,
  # something of ours is still running whatever the process table says.
  cleanup_all || failed "LOCAL_CLEANUP_INCOMPLETE"
  port_is_free "$local_port" || failed "LOCAL_PORT_STILL_HELD"
  log_phase "cleanup-verified" "port=$local_port port_free=yes children=none"

  emit "pass" "LOCAL_D1_ENROLLMENT_PASSED"
  log_phase "result-emitted" "status=pass code=LOCAL_D1_ENROLLMENT_PASSED"
}

begin_self_test() {
  SELF_TEST_MODE="$1"
  case "${S1_FAULT_INJECT:-}" in
    ""|ps-unreadable|ps-partial|ps-once|ps-malformed-after-self|ps-truncated-tail|ps-truncated-before-self|supervisor-not-stopped|identity-unavailable|provisional-inspection-unknown) ;;
    *) blocked "FAULT_INJECTION_INVALID" ;;
  esac
  case "${S1_KERNEL_PROBE_FAULT:-}" in
    ""|bun-exit-1) ;;
    *) blocked "KERNEL_PROBE_FAULT_INVALID" ;;
  esac
  if [[ -n "${S1_KERNEL_PROBE_FAULT:-}" && "$SELF_TEST_MODE" != "self-test" ]]; then
    blocked "KERNEL_PROBE_FAULT_SCOPE_INVALID"
  fi
}

reject_unscoped_fault_injection() {
  [[ -z "${S1_FAULT_INJECT:-}" && -z "${S1_KERNEL_PROBE_FAULT:-}" && -z "${S1_INTERRUPT_WINDOW:-}" && -z "${S1_INTERRUPT_OWNER:-}" ]] ||
    blocked "FAULT_INJECTION_TEST_ONLY"
}

validate_enrollment_test_hooks() {
  [[ -z "${S1_TEST_BODY_FAULT:-}" ]] && return 0
  [[ "${ASIMP_S1_TEST_ALLOW_HTTP:-}" == "1" ]] || blocked "TEST_BODY_FAULT_TEST_ONLY"
  [[ "${S1_TEST_BODY_FAULT}" == "poll-body-construction" ]] || blocked "TEST_BODY_FAULT_INVALID"
}

main() {
  trap 'on_interrupt INT' INT
  trap 'on_interrupt TERM' TERM
  trap 'on_interrupt HUP' HUP
  trap 'on_exit' EXIT

  require_tooling
  (($# <= 1)) || failed "ARGUMENT_COUNT_INVALID"
  if [[ "${1:-}" == "--self-test" ]]; then
    begin_self_test "self-test"
    self_test
    return
  fi
  if [[ "${1:-}" == "--self-test-lifecycle" ]]; then
    begin_self_test "lifecycle"
    self_test_lifecycle "group"
    return
  fi
  if [[ "${1:-}" == "--self-test-lifecycle-kill" ]]; then
    begin_self_test "lifecycle-kill"
    self_test_lifecycle "group-kill"
    return
  fi
  if [[ "${1:-}" == "--self-test-lifecycle-observation-partial" ]]; then
    begin_self_test "lifecycle-observation-partial"
    self_test_lifecycle "group-observation-partial"
    return
  fi
  if [[ "${1:-}" == "--self-test-preexec-not-stopped" ]]; then
    begin_self_test "preexec-not-stopped"
    [[ "${S1_FAULT_INJECT:-}" == "supervisor-not-stopped" ]] || blocked "PREEXEC_FAULT_REQUIRED"
    self_test_preexec_failure "not-stopped"
    return
  fi
  if [[ "${1:-}" == "--self-test-preexec-identity-unavailable" ]]; then
    begin_self_test "preexec-identity-unavailable"
    [[ "${S1_FAULT_INJECT:-}" == "identity-unavailable" ]] || blocked "PREEXEC_FAULT_REQUIRED"
    self_test_preexec_failure "identity-unavailable"
    return
  fi
  if [[ "${1:-}" == "--self-test-provisional-pid-reuse" ]]; then
    begin_self_test "provisional-pid-reuse"
    self_test_provisional_pid_reuse
    return
  fi
  if [[ "${1:-}" == "--self-test-provisional-inspection-unknown" ]]; then
    begin_self_test "provisional-inspection-unknown"
    self_test_provisional_inspection_unknown
    return
  fi
  if [[ "${1:-}" == "--self-test-lifecycle-critical-window" ]]; then
    begin_self_test "lifecycle-critical-window"
    self_test_lifecycle_critical_window
    # Every valid mode dispatches a deferred signal and exits in the trap.
    # shellcheck disable=SC2317
    return
  fi
  if [[ "${1:-}" == "--self-test-unowned-refusal" ]]; then
    begin_self_test "unowned-refusal"
    self_test_unowned_refusal
    return
  fi
  if [[ "${1:-}" == "--self-test-exit-gate" ]]; then
    begin_self_test "exit-gate"
    self_test_exit_gate
    return
  fi
  if [[ "${1:-}" == "--self-test-status-integrity" ]]; then
    begin_self_test "status-integrity"
    self_test_status_integrity
    return
  fi
  if [[ "${1:-}" == "--self-test-deadline" ]]; then
    begin_self_test "deadline"
    self_test_deadline
    return
  fi
  if [[ "${1:-}" == "--self-test-client-group" ]]; then
    begin_self_test "client-group"
    self_test_client_group
    # The mode exists to be interrupted from outside and never returns on its own:
    # every path through it ends in `failed`. This `return` is therefore
    # unreachable, and kept only so the dispatch reads uniformly.
    # shellcheck disable=SC2317
    return
  fi
  if [[ "${1:-}" == "--self-test-client-success-descendant" ]]; then
    begin_self_test "client-success-descendant"
    self_test_client_success_descendant
    return
  fi
  if [[ "${1:-}" == "--self-test-partial-ps" ]]; then
    begin_self_test "partial-ps"
    self_test_partial_ps
    return
  fi
  if [[ "${1:-}" == "--self-test-partial-ps-negative-control" ]]; then
    begin_self_test "partial-ps-negative-control"
    self_test_partial_ps_negative_control
    return
  fi
  if [[ "${1:-}" == "--self-test-ps-parser-refusal" ]]; then
    begin_self_test "ps-parser-refusal"
    self_test_ps_parser_refusal
    return
  fi
  if [[ "${1:-}" == "--self-test-cleanup-retry" ]]; then
    begin_self_test "cleanup-retry"
    self_test_cleanup_retry
    # shellcheck disable=SC2317
    return
  fi
  if [[ "${1:-}" == "--self-test-cleanup-terminal-order" ]]; then
    begin_self_test "cleanup-terminal-order"
    self_test_cleanup_terminal_order
    # shellcheck disable=SC2317
    return
  fi
  if [[ "${1:-}" == "--self-test-client-containment-terminal" ]]; then
    begin_self_test "client-containment-terminal"
    self_test_client_containment_terminal
    # terminal_local_client_failure exits with the typed result.
    # shellcheck disable=SC2317
    return
  fi
  if [[ "${1:-}" == "--self-test-interrupt-cleanup-retry" ]]; then
    begin_self_test "interrupt-cleanup-retry"
    self_test_interrupt_cleanup_retry
    # The test controller delivers TERM after the ready phase.
    # shellcheck disable=SC2317
    return
  fi
  if [[ "${1:-}" == "--local-d1" ]]; then
    reject_unscoped_fault_injection
    run_local_d1
    return
  fi

  [[ -z "${1:-}" ]] || failed "UNKNOWN_ARGUMENT"

  reject_unscoped_fault_injection
  validate_enrollment_test_hooks

  # The external three-harness / OAuth / staging proof is deliberately blocked
  # rather than simulated: no fixture mode exists for it, and a local run must
  # never be read as that evidence.
  [[ -n "${ASIMP_S1_JOIN_URL:-}" ]] || blocked "STAGING_JOIN_URL_REQUIRED"
  [[ -n "${ASIMP_S1_FELLOW_NAME:-}" ]] || blocked "FELLOW_NAME_REQUIRED"
  [[ -n "${ASIMP_S1_MODEL:-}" ]] || blocked "MODEL_REQUIRED"
  [[ -n "${ASIMP_S1_HARNESS:-}" ]] || blocked "HARNESS_REQUIRED"
  supported_harness "$ASIMP_S1_HARNESS" || blocked "HARNESS_IDENTITY_UNSUPPORTED"

  local join_path="${ASIMP_S1_JOIN_URL%%#*}"
  local secret="${ASIMP_S1_JOIN_URL#*#}"
  local origin enrollment_id claim_endpoint poll_endpoint registration_body claim_response flow_handle
  local poll_body poll_response status token allow_http_test=0

  [[ "$ASIMP_S1_JOIN_URL" == *"#"* ]] || failed "FRAGMENT_SECRET_REQUIRED"
  [[ "${ASIMP_S1_TEST_ALLOW_HTTP:-}" == "1" ]] && allow_http_test=1
  if ((allow_http_test == 1)); then
    # This exists solely for the black-box terminal-record test's loopback
    # server. Ordinary enrollment remains HTTPS-only and this switch is never
    # used by the staged three-harness proof.
    [[ "$join_path" != *"?"* && "$join_path" == http://127.0.0.1:*/join/ASIMP-EN-* ]] ||
      failed "JOIN_URL_INVALID"
  else
    [[ "$join_path" != *"?"* && "$join_path" == https://*/join/ASIMP-EN-* ]] || failed "JOIN_URL_INVALID"
  fi
  valid_secret "$secret" || failed "FRAGMENT_SECRET_INVALID"

  origin="${join_path%%/join/*}"
  enrollment_id="${join_path##*/join/}"
  [[ "$enrollment_id" =~ ^ASIMP-EN-[A-HJKMNP-TV-Z0-9]{10,32}$ ]] || failed "ENROLLMENT_ID_INVALID"

  # Content negotiation precedes registration. The response is retained only
  # in memory and is never copied to an artifact or diagnostic.
  run_helper_or_fail "CAPSULE_REQUEST_FAILED" curl_body GET "$join_path"

  capture_helper_or_fail registration_body "REGISTRATION_BODY_INVALID" \
    make_registration_body "$enrollment_id" "$secret"
  claim_endpoint="$origin/v1/fellows"
  capture_helper_or_fail claim_response "ENROLLMENT_REQUEST_FAILED" \
    curl_body POST "$claim_endpoint" "$registration_body"
  capture_helper_or_fail flow_handle "UNEXPECTED_RESPONSE_SHAPE" \
    json_field "$claim_response" "flow_handle"
  valid_flow_handle "$flow_handle" || failed "FLOW_HANDLE_INVALID"
  emit "pass" "PROPOSAL_CREATED"

  poll_endpoint="$origin/v1/fellows/flow"
  capture_helper_or_fail poll_body "POLL_BODY_INVALID" make_poll_body "$flow_handle"
  capture_helper_or_fail poll_response "ENROLLMENT_REQUEST_FAILED" \
    curl_body POST "$poll_endpoint" "$poll_body"
  capture_helper_or_fail status "UNEXPECTED_RESPONSE_SHAPE" json_status "$poll_response"
  case "$status" in
    authorization_pending)
      blocked "SPONSOR_APPROVAL_REQUIRED"
      ;;
    approved)
      capture_helper_or_fail token "TOKEN_SHAPE_INVALID" json_field "$poll_response" "token"
      valid_token "$token" || failed "TOKEN_SHAPE_INVALID"
      emit "pass" "TOKEN_ISSUED"
      ;;
    access_denied)
      failed "SPONSOR_DENIED"
      ;;
    expired_token)
      failed "FLOW_EXPIRED"
      ;;
    *)
      failed "UNEXPECTED_FLOW_STATUS"
      ;;
  esac
}

main "$@"
