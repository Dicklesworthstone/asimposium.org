#!/usr/bin/env bash
# Fable §5.2 / S-1 cold-enrollment runner.
#
# This script deliberately keeps credentials in process memory and JSON POST
# bodies. It does not write artifacts: a token, fragment secret, or flow handle
# must never become a path, query string, log, or retained test result.
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
readonly TERMINATION_GRACE_SECONDS=5
readonly PORT_ALLOCATION_ATTEMPTS=40
readonly EPHEMERAL_PORT_FLOOR=20000
readonly EPHEMERAL_PORT_SPAN=20000

# Mutable lifecycle state, read by the traps. SERVER_PGID is the process group
# *proven* to belong to the child at spawn time; it stays set after the leader
# exits, because that is exactly when cleanup still has descendants to reach and
# can no longer derive the group from the leader.
SERVER_PID=""
SERVER_PGID=""
STATE_DIR=""
PHASE_LOG=""
# Resolved by `resolve_port` / `resolve_run_token`, which refuse in this shell
# rather than inside a command substitution. See the comment on `allocate_port`.
RESOLVED_PORT=""
RUN_TOKEN=""

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

process_alive() {
  kill -0 "$1" 2>/dev/null
}

# The process group id of a pid; non-zero when the process is gone or the pid is
# not a pid. Silent, because it runs inside a command substitution.
process_group_of() {
  local pgid
  pgid="$(ps -o pgid= -p "$1" 2>/dev/null | tr -d '[:space:]')"
  [[ "$pgid" =~ ^[0-9]+$ ]] || return 1
  printf '%s' "$pgid"
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

# Live (non-zombie) members of a process group, from one ps snapshot.
#
# Zombies must be excluded, and that is the whole difficulty of this check: an
# exited-but-unreaped leader still answers `kill -0`, so a liveness test built on
# signals reports a group as alive because of a corpse, and — worse — reports the
# leader as alive while saying nothing about the descendants that actually hold
# the port. `stat` is the only thing that distinguishes the two.
live_group_members() {
  ps -A -o pid=,pgid=,stat= 2>/dev/null | awk -v want="$1" '$2 == want && $3 !~ /Z/ { print $1 }'
}

# Every descendant of `pid`, from one ps snapshot, computed as a transitive
# closure over ppid. Only used when no group could be proven.
descendant_pids() {
  ps -A -o pid=,ppid= 2>/dev/null | awk -v root="$1" '
    { row_pid[NR] = $1; row_ppid[NR] = $2; rows = NR }
    END {
      selected[root] = 1
      do {
        added = 0
        for (row = 1; row <= rows; row += 1) {
          if (!(row_pid[row] in selected) && (row_ppid[row] in selected)) {
            selected[row_pid[row]] = 1
            added = 1
          }
        }
      } while (added)
      for (pid in selected) if (pid != root) print pid
    }'
}

# The subset of a pid list that is alive and not a zombie.
live_pids() {
  local pid live=""
  for pid in $1; do
    if ps -p "$pid" -o stat= 2>/dev/null | awk 'NR == 1 && $1 !~ /Z/ { alive = 1 } END { exit(alive ? 0 : 1) }'; then
      live="$live $pid"
    fi
  done
  printf '%s' "${live# }"
}

commas() {
  printf '%s' "$1" | tr '\n' ' ' | tr -s ' ' ',' | sed 's/^,//; s/,$//'
}

# Whether a specific pid is a live member of a group.
group_contains() {
  local pgid="$1"
  local wanted="$2"
  local pid
  for pid in $(live_group_members "$pgid"); do
    if [[ "$pid" == "$wanted" ]]; then return 0; fi
  done
  return 1
}

# Terminate the child's whole process group: TERM, a bounded grace period, then
# KILL, then reap. Two properties are deliberate:
#
#   * the group id is the one *proven at spawn time* and passed in, never
#     re-derived here. Re-deriving it is unsound precisely when it matters: once
#     the leader has exited, `ps -o pgid= -p <leader>` fails, ownership looks
#     unproven, and cleanup silently degrades to the leader alone while workerd
#     descendants keep the port and the D1 lock;
#   * completion means the group is empty, not that the leader is gone. Wrangler
#     exiting first is the normal shape of this failure, so KILL must still run
#     for descendants that outlive their leader.
terminate_group() {
  local leader="$1"
  local pgid="$2"
  local label="$3"
  local waited=0
  local limit=$((TERMINATION_GRACE_SECONDS * 10))
  local members

  members="$(live_group_members "$pgid")"
  if [[ -z "$members" ]]; then
    wait "$leader" 2>/dev/null || true
    return 0
  fi

  kill -TERM -- -"$pgid" 2>/dev/null || true
  while ((waited < limit)); do
    members="$(live_group_members "$pgid")"
    if [[ -z "$members" ]]; then
      wait "$leader" 2>/dev/null || true
      log_phase "${label}-terminated" "signal=TERM pgid=$pgid scope=group"
      return 0
    fi
    sleep 0.1
    waited=$((waited + 1))
  done

  log_phase "${label}-survivors" "pgid=$pgid pids=$(commas "$members") after_s=$TERMINATION_GRACE_SECONDS"
  kill -KILL -- -"$pgid" 2>/dev/null || true
  wait "$leader" 2>/dev/null || true
  waited=0
  while ((waited < limit)); do
    members="$(live_group_members "$pgid")"
    [[ -n "$members" ]] || break
    sleep 0.1
    waited=$((waited + 1))
  done
  if [[ -n "$members" ]]; then
    log_phase "${label}-uncleaned" "pgid=$pgid pids=$(commas "$members")"
    return 1
  fi
  log_phase "${label}-killed" "signal=KILL pgid=$pgid scope=group grace_s=$TERMINATION_GRACE_SECONDS"
}

# The fallback for a child whose group could not be proven. It must still not
# orphan grandchildren, so it signals the pid *and* its descendants. The
# descendant snapshot is taken before the first signal: a dead parent cannot be
# walked, because its children are reparented and the relationship is lost.
terminate_pid_tree() {
  local root="$1"
  local label="$2"
  local waited=0
  local limit=$((TERMINATION_GRACE_SECONDS * 10))
  local targets live signal

  targets="$root $(descendant_pids "$root" | tr '\n' ' ')"
  live="$(live_pids "$targets")"
  if [[ -z "$live" ]]; then
    wait "$root" 2>/dev/null || true
    # "No targets" is not the same claim as "nothing was running": once the root
    # has exited, its children are reparented and are no longer enumerable from
    # it. Say which of the two this was, so an orphan is reported rather than
    # assumed away. The runner refuses an unowned child while it is still alive
    # precisely so this branch is the exception.
    log_phase "${label}-cleanup-scope" \
      "scope=pid-tree root=$root targets=none note=descendants-unenumerable-after-root-exit"
    return 0
  fi
  log_phase "${label}-cleanup-scope" "scope=pid-tree root=$root targets=$(commas "$live")"

  for signal in TERM KILL; do
    local pid
    for pid in $targets; do
      kill "-${signal}" "$pid" 2>/dev/null || true
    done
    waited=0
    while ((waited < limit)); do
      live="$(live_pids "$targets")"
      if [[ -z "$live" ]]; then
        wait "$root" 2>/dev/null || true
        log_phase "${label}-terminated" "signal=$signal scope=pid-tree root=$root"
        return 0
      fi
      sleep 0.1
      waited=$((waited + 1))
    done
    log_phase "${label}-survivors" "scope=pid-tree pids=$(commas "$live") after_signal=$signal"
  done
  wait "$root" 2>/dev/null || true
  log_phase "${label}-uncleaned" "scope=pid-tree pids=$(commas "$live")"
  return 1
}

# Terminate a child. `pgid` is the group proven at spawn time, or empty when no
# group could be proven — the two cases are handled above, and neither is allowed
# to leave a descendant behind.
terminate_child() {
  local pid="${1:-}"
  local pgid="${2:-}"
  local label="${3:-child}"
  [[ -n "$pid" ]] || return 0
  if [[ -n "$pgid" ]]; then
    terminate_group "$pid" "$pgid" "$label"
    return
  fi
  terminate_pid_tree "$pid" "$label"
}

on_interrupt() {
  local signal="$1"
  trap - INT TERM EXIT
  log_phase "interrupted" "signal=$signal pid=${SERVER_PID:-none} pgid=${SERVER_PGID:-none}"
  terminate_child "${SERVER_PID:-}" "${SERVER_PGID:-}" || log_phase "cleanup-incomplete" "signal=$signal"
  # State is retained on purpose, including here: an interrupted run is the one
  # whose logs a human most wants afterwards.
  printf 'INTERRUPTED %s: signal=%s state_retained=%s\n' "$SUITE" "$signal" "${STATE_DIR:-none}" >&2
  emit "fail" "INTERRUPTED_${signal}"
  exit 1
}

on_exit() {
  local status="$?"
  terminate_child "${SERVER_PID:-}" "${SERVER_PGID:-}" || true
  return "$status"
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

# Run a command with an overall deadline. Returns 124 on timeout, the command's
# status otherwise. `timeout(1)` is not portable to every machine this runs on.
#
# The deadline is bounded in both directions: the command is started in its own
# process group so a timeout can be cleaned up as a group, and the timeout path
# escalates TERM to KILL and reaps, rather than sending one signal and hoping.
run_with_deadline() {
  local seconds="$1"
  shift
  set -m
  "$@" &
  local pid="$!"
  set +m
  # Proven now, while the child is certainly alive; after it exits the group can
  # no longer be derived from it, and a timeout cleanup would lose its children.
  local pgid=""
  if owns_process_group "$pid"; then pgid="$pid"; fi
  local waited=0
  local limit=$((seconds * 10))
  while ((waited < limit)); do
    if ! process_alive "$pid"; then
      local status=0
      wait "$pid" || status=$?
      return "$status"
    fi
    sleep 0.1
    waited=$((waited + 1))
  done
  terminate_child "$pid" "$pgid" "deadline" || true
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
    failed "UNEXPECTED_RESPONSE_SHAPE"
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
      failed "CAPSULE_REQUEST_FAILED"
    fi
  elif ! result="$(printf '%s' "$body" | curl --silent --fail-with-body \
    --request POST --connect-timeout "$CONNECT_TIMEOUT_SECONDS" \
    --max-time "$REQUEST_TIMEOUT_SECONDS" \
    --header 'Accept: application/json' --header 'Content-Type: application/json' \
    --data-binary @- "$endpoint" 2>/dev/null)"; then
    failed "ENROLLMENT_REQUEST_FAILED"
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
' 2>/dev/null || failed "REGISTRATION_BODY_INVALID"
}

make_poll_body() {
  local flow_handle="$1"
  ASIMP_S1_FLOW_HANDLE="$flow_handle" bun -e '
if (!process.env.ASIMP_S1_FLOW_HANDLE) process.exit(1);
process.stdout.write(JSON.stringify({ flow_handle: process.env.ASIMP_S1_FLOW_HANDLE }));
' 2>/dev/null || failed "POLL_BODY_INVALID"
}

self_test() {
  local synthetic_url="https://a.example.test/join/ASIMP-EN-7F3K9M2Q8R#v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  local without_fragment="${synthetic_url%%#*}"
  local fragment="${synthetic_url#*#}"
  local diagnostic

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

  diagnostic="$(emit "pass" "SELF_TEST_PASSED")"
  [[ "$diagnostic" != *"AAAAAAAA"* && "$diagnostic" != *"v1."* ]] || failed "SELF_TEST_REDACTION_FAILED"
  printf '%s\n' "$diagnostic"
}

# The cleanup contract, exercised against real processes through the production
# `terminate_child` path — not a copy of it. Three modes, one per branch of that
# path, and each one is the case its branch exists for:
#
#   group       a group whose leader exits and is reaped while a descendant
#               survives. This is the shape wrangler + workerd takes when wrangler
#               dies first, and it is what defeats a cleanup that polls the leader
#               or re-derives the group at terminate time: the leader is gone, so
#               such a cleanup reports success while the descendant still holds
#               the port and the D1 lock.
#
#   group-kill  the same, with a descendant that ignores TERM. The grace period
#               must expire and KILL must still be delivered to the group, or a
#               process that declines to leave outlives every run.
#
#   pid-tree    a child that never became a group leader, which is the state
#               behind `LOCAL_CHILD_GROUP_UNOWNED`. Its group is *this runner's*
#               group, so cleanup must reach the child and its grandchild without
#               ever signalling a group — the run surviving to make its own
#               assertions is the proof that it did not signal itself.
self_test_lifecycle() {
  local mode="${1:-group}"
  local leader descendant survivors waited pid_file
  local limit=100
  local stubborn=""
  if [[ "$mode" == "group-kill" ]]; then stubborn="1"; fi

  STATE_DIR="$(mktemp -d -t asimposium-s1-lifecycle)"
  [[ -d "$STATE_DIR" && ! -L "$STATE_DIR" ]] || failed "LIFECYCLE_STATE_DIR_INVALID"
  PHASE_LOG="$STATE_DIR/phases.log"
  : >"$PHASE_LOG"
  pid_file="$STATE_DIR/descendant.pid"
  log_phase "lifecycle-state-retained" "dir=$STATE_DIR mode=$mode"

  if [[ "$mode" == "group" ]]; then
    # Job control: the child leads its own group, and exits immediately.
    set -m
    S1_LIFECYCLE_PID_FILE="$pid_file" bash -c '
      sleep 300 &
      printf "%s\n" "$!" >"$S1_LIFECYCLE_PID_FILE"
      exit 0
    ' &
    leader="$!"
    set +m
    owns_process_group "$leader" || failed "LIFECYCLE_GROUP_UNOWNED"
    SERVER_PID="$leader"
    SERVER_PGID="$leader"
  else
    # No job control: the child shares this runner's group, so no group can be
    # proven and the fallback must handle it. The child stays alive, which is the
    # real ordering — the runner refuses `LOCAL_CHILD_GROUP_UNOWNED` while the
    # child is still walkable, because a dead parent's children are reparented and
    # can no longer be found.
    S1_LIFECYCLE_PID_FILE="$pid_file" bash -c '
      sleep 300 &
      printf "%s\n" "$!" >"$S1_LIFECYCLE_PID_FILE"
      sleep 300
    ' &
    leader="$!"
    if owns_process_group "$leader"; then failed "LIFECYCLE_GROUP_UNEXPECTEDLY_OWNED"; fi
    SERVER_PID="$leader"
    SERVER_PGID=""
  fi

  waited=0
  while ((waited < limit)); do
    if [[ -s "$pid_file" ]]; then break; fi
    sleep 0.1
    waited=$((waited + 1))
  done
  descendant="$(tr -d '[:space:]' <"$pid_file" 2>/dev/null || true)"
  [[ "$descendant" =~ ^[0-9]+$ ]] || failed "LIFECYCLE_DESCENDANT_UNKNOWN"
  [[ -n "$(live_pids "$descendant")" ]] || failed "LIFECYCLE_DESCENDANT_NOT_STARTED"
  log_phase "lifecycle-descendant" "pid=$descendant leader=$leader mode=$mode"

  if [[ "$mode" == "group" ]]; then
    [[ "$(process_group_of "$descendant")" == "$leader" ]] || failed "LIFECYCLE_DESCENDANT_OUTSIDE_GROUP"
    # Let the leader exit and reap it. The reap is not tidiness — it is the exact
    # state that defeats a cleanup which re-derives the group or polls the leader:
    # the pid is gone, so `ps -o pgid=` has nothing to report and `kill -0` says
    # "already finished", while the descendant holds everything the child held.
    wait "$leader" 2>/dev/null || true
    if process_alive "$leader"; then failed "LIFECYCLE_LEADER_STILL_LIVE"; fi
    if owns_process_group "$leader"; then failed "LIFECYCLE_OWNERSHIP_STILL_DERIVABLE"; fi
    group_contains "$leader" "$descendant" || failed "LIFECYCLE_DESCENDANT_ALREADY_GONE"
    survivors="$(commas "$(live_group_members "$leader")")"
    log_phase "lifecycle-leader-exited" "leader=$leader reaped=yes survivors=$survivors"
  else
    [[ "$(process_group_of "$descendant")" == "$(process_group_of "$$")" ]] ||
      failed "LIFECYCLE_DESCENDANT_OUTSIDE_GROUP"
    [[ -n "$(live_pids "$leader")" ]] || failed "LIFECYCLE_LEADER_NOT_LIVE"
    log_phase "lifecycle-unowned" "leader=$leader shared_pgid=$(process_group_of "$$")"
  fi

  terminate_child "$SERVER_PID" "$SERVER_PGID" "lifecycle" || failed "LIFECYCLE_CLEANUP_INCOMPLETE"
  SERVER_PID=""
  SERVER_PGID=""

  [[ -z "$(live_pids "$descendant")" ]] || failed "LIFECYCLE_DESCENDANT_SURVIVED"
  [[ -z "$(live_pids "$leader")" ]] || failed "LIFECYCLE_LEADER_SURVIVED"
  if [[ "$mode" == "group" ]]; then
    [[ -z "$(live_group_members "$leader")" ]] || failed "LIFECYCLE_GROUP_SURVIVED"
  else
    # Still here, and still a live member of the group the child shared with us.
    group_contains "$(process_group_of "$$")" "$$" || failed "LIFECYCLE_SELF_SIGNALLED"
  fi
  log_phase "lifecycle-cleaned" "mode=$mode leader=$leader descendant=$descendant"

  emit "pass" "LIFECYCLE_SELF_TEST_PASSED"
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

run_local_d1() {
  [[ -x "$LOCAL_WRANGLER" ]] || blocked "WRANGLER_REQUIRED"

  local local_port origin token server_log ready waited limit client_exit scope ownership_wait
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

  # Job control puts the child in its own process group, so the group id equals
  # the child pid and every descendant can be signalled together.
  set -m
  "$LOCAL_WRANGLER" dev apps/wire/src/enrollment/local-d1-worker.ts \
    --config infra/wrangler.toml --local --persist-to "$STATE_DIR" --port "$local_port" \
    --inspector-port 0 \
    --var "ENROLLMENT_REPLAY_KEY:${LOCAL_REPLAY_KEY}" \
    --log-level error --show-interactive-dev-session=false >>"$server_log" 2>&1 &
  SERVER_PID="$!"
  set +m

  # Prove the group once, here, and keep it for the rest of the run. Cleanup
  # signals that group, so a child that did not become its own group leader is
  # reported rather than discovered later as an orphaned workerd holding the
  # port. A child that has already exited is left to the readiness loop, which
  # names that failure exactly.
  scope="pid-tree"
  ownership_wait=0
  while ((ownership_wait < 20)); do
    if owns_process_group "$SERVER_PID"; then
      SERVER_PGID="$SERVER_PID"
      scope="group"
      break
    fi
    process_alive "$SERVER_PID" || break
    sleep 0.1
    ownership_wait=$((ownership_wait + 1))
  done
  log_phase "child-started" "pid=$SERVER_PID port=$local_port scope=$scope"
  if [[ "$scope" != "group" ]] && process_alive "$SERVER_PID"; then
    # The EXIT trap still cleans up: with no proven group it walks the pid tree,
    # so wrangler's workerd children are not orphaned by this refusal.
    failed "LOCAL_CHILD_GROUP_UNOWNED"
  fi

  ready=0
  waited=0
  limit=$((READINESS_DEADLINE_SECONDS * 5))
  while ((waited < limit)); do
    # Readiness is tied to the child: a dead child is never "not ready yet".
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      log_phase "child-exited-early" "pid=$SERVER_PID log=$server_log"
      failed "LOCAL_WORKER_EXITED"
    fi
    if curl --silent --output /dev/null --connect-timeout "$CONNECT_TIMEOUT_SECONDS" \
      --max-time "$REQUEST_TIMEOUT_SECONDS" "$origin/join/ASIMP-EN-INVALID"; then
      ready=1
      break
    fi
    sleep 0.2
    waited=$((waited + 1))
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
  if ((client_exit == 124)); then
    log_phase "client-deadline" "deadline_s=$CLIENT_DEADLINE_SECONDS"
    failed "LOCAL_D1_CLIENT_TIMEOUT"
  fi
  if ((client_exit != 0)); then
    log_phase "client-failed" "exit=$client_exit"
    exit "$client_exit"
  fi
  log_phase "client-passed" "exit=0"

  emit "pass" "LOCAL_D1_ENROLLMENT_PASSED"
}

main() {
  trap 'on_interrupt INT' INT
  trap 'on_interrupt TERM' TERM
  trap 'on_exit' EXIT

  require_tooling
  if [[ "${1:-}" == "--self-test" ]]; then
    self_test
    return
  fi
  if [[ "${1:-}" == "--self-test-lifecycle" ]]; then
    self_test_lifecycle "group"
    return
  fi
  if [[ "${1:-}" == "--self-test-lifecycle-unowned" ]]; then
    self_test_lifecycle "pid-tree"
    return
  fi
  if [[ "${1:-}" == "--local-d1" ]]; then
    run_local_d1
    return
  fi

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
  local poll_body poll_response status token

  [[ "$ASIMP_S1_JOIN_URL" == *"#"* ]] || failed "FRAGMENT_SECRET_REQUIRED"
  [[ "$join_path" != *"?"* && "$join_path" == https://*/join/ASIMP-EN-* ]] || failed "JOIN_URL_INVALID"
  valid_secret "$secret" || failed "FRAGMENT_SECRET_INVALID"

  origin="${join_path%%/join/*}"
  enrollment_id="${join_path##*/join/}"
  [[ "$enrollment_id" =~ ^ASIMP-EN-[A-HJKMNP-TV-Z0-9]{10,32}$ ]] || failed "ENROLLMENT_ID_INVALID"

  # Content negotiation precedes registration. The response is retained only
  # in memory and is never copied to an artifact or diagnostic.
  curl_body GET "$join_path" >/dev/null

  registration_body="$(make_registration_body "$enrollment_id" "$secret")"
  claim_endpoint="$origin/v1/fellows"
  claim_response="$(curl_body POST "$claim_endpoint" "$registration_body")"
  flow_handle="$(json_field "$claim_response" "flow_handle")"
  valid_flow_handle "$flow_handle" || failed "FLOW_HANDLE_INVALID"
  emit "pass" "PROPOSAL_CREATED"

  poll_endpoint="$origin/v1/fellows/flow"
  poll_body="$(make_poll_body "$flow_handle")"
  poll_response="$(curl_body POST "$poll_endpoint" "$poll_body")"
  status="$(json_status "$poll_response")"
  case "$status" in
    authorization_pending)
      blocked "SPONSOR_APPROVAL_REQUIRED"
      ;;
    approved)
      token="$(json_field "$poll_response" "token")"
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
