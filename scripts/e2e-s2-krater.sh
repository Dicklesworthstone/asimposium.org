#!/usr/bin/env bash
# Local real-D1 + Durable Object S-2 harness. This never contacts a remote
# Cloudflare resource. Its unique persistence directory is intentionally
# retained: cleanup terminates only child workerd processes, never files.
# Successful local DO proof is reported green; deployed DO and edge-load proof
# remain external blockers and cause the final exit 78.

set -euo pipefail

readonly S2_WRANGLER="apps/wire/node_modules/.bin/wrangler"
readonly S2_WRANGLER_CONFIG="apps/wire/src/krater/wrangler.s2.toml"
# The legacy fixture stack: an exact pre-integrity 0001 schema and nothing else.
# Its own `migrations_dir` is what makes "old database" mean the schema that
# actually shipped, rather than the current one with columns hidden.
readonly S2_LEGACY_CONFIG="apps/wire/src/krater/wrangler.s2-legacy.toml"
readonly S2_UPGRADE_CONFIG="apps/wire/src/krater/wrangler.s2-upgrade.toml"
readonly S2_LEGACY_EXISTING_FIXTURE="apps/wire/src/krater/fixtures/legacy-existing-event.sql"
readonly S2_FORWARD_MIGRATION="db/migrations/0004_krater_integrity_v1.sql"
# Applied as a second, separate step so the legacy lane observes the database at exactly 0004
# and then at exactly 0005. Folding both into one apply would prove neither: the phase run
# between them is what establishes that the index is absent before 0005 and chosen after it.
readonly S2_INDEX_MIGRATION="db/migrations/0005_krater_undigested_index.sql"
readonly S2_BIND_IP="127.0.0.1"
readonly S2_READY_DEADLINE_SECONDS=15
readonly S2_PHASE_DEADLINE_SECONDS=75
readonly S2_TERMINATE_WAIT_TICKS=20
readonly S2_LEGACY_STOP_INSPECTION_TICKS=10
readonly S2_WATCHDOG_MAX_UNCERTAIN_TICKS=10
readonly S2_MAX_RETAINED_BYTES=67108864
readonly S2_MAX_RETAINED_FILES=1024
readonly S2_EVIDENCE_ROOT="e2e/artifacts/s2-krater"
readonly S2_COST_RECEIPT_RELATIVE_PATH="s2-cost-input.json"
# A parallel child runs the full local D1 suite, including two real migration-journal lanes.
# Keep the test bounded, but allow its documented work rather than converting a healthy child
# into a synthetic TERM result before the journal is finished.
readonly S2_LIFECYCLE_DEADLINE_SECONDS=300
readonly -a S2_SOURCE_PATHS=(
  apps/wire/src/krater/krater.ts
  apps/wire/src/krater/worker.ts
  apps/wire/src/krater/outbox-do.ts
  apps/wire/src/krater/s2-client.ts
  apps/wire/src/krater/worker.test.ts
  apps/wire/test/unit/s2-krater-harness.test.ts
  apps/wire/test/integration/s2-krater-real-bindings.test.ts
  apps/wire/src/krater/wrangler.s2.toml
  apps/wire/src/krater/wrangler.s2-legacy.toml
  apps/wire/src/krater/wrangler.s2-upgrade.toml
  apps/wire/src/krater/fixtures/legacy-existing-event.sql
  apps/wire/src/krater/fixtures/legacy-migrations/0001_krater_v0.sql
  db/migrations/0001_krater_v0.sql
  db/migrations/0002_enrollment_g0.sql
  db/migrations/0003_auth_nonce_replay.sql
  db/migrations/0004_krater_integrity_v1.sql
  db/migrations/0005_krater_undigested_index.sql
  scripts/verify-cost-model.ts
  scripts/e2e-s2-krater.sh
)
readonly -a S2_EXPECTED_MIGRATION_JOURNAL=(
  0001_krater_v0.sql
  0002_enrollment_g0.sql
  0003_auth_nonce_replay.sql
  0004_krater_integrity_v1.sql
  0005_krater_undigested_index.sql
)

random_hex() {
  local bytes="$1" value
  value="$(LC_ALL=C od -An -N "${bytes}" -tx1 /dev/urandom | tr -d '[:space:]')" || return 1
  [[ "${value}" =~ ^[a-f0-9]+$ && ${#value} -eq $((bytes * 2)) ]] || return 1
  printf '%s\n' "${value}"
}

# A caller-provided main port must belong to this run. Otherwise a listener
# from an interrupted run can satisfy readiness while this Wrangler process
# failed to bind. This is deliberately a TCP check rather than HTTP: before
# this run owns the listener, an arbitrary HTTP response is not meaningful.
port_is_busy() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && exec 3<&- && return 0
  return 1
}

choose_available_port() {
  local candidate offset
  for offset in {0..79}; do
    candidate=$((8700 + (($$ + offset) % 1100)))
    if ! port_is_busy "${candidate}"; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done
  return 1
}

if [[ -n "${S2_PORT:-}" ]]; then
  if [[ ! "${S2_PORT}" =~ ^[0-9]{2,5}$ ]] || (( S2_PORT < 1024 || S2_PORT > 65535 )); then
    printf '%s\n' '{"tool":"bash","package":"apps/wire","suite":"s2-krater-local-do","status":"fail","code":"S2_PORT_INVALID","reproduce":"scripts/e2e-s2-krater.sh"}'
    exit 1
  fi
else
  if ! S2_PORT="$(choose_available_port)"; then
    printf '%s\n' '{"tool":"bash","package":"apps/wire","suite":"s2-krater-local-do","status":"fail","code":"S2_PORT_UNAVAILABLE","reproduce":"scripts/e2e-s2-krater.sh"}'
    exit 1
  fi
fi
if port_is_busy "${S2_PORT}"; then
  printf '%s\n' '{"tool":"bash","package":"apps/wire","suite":"s2-krater-local-do","status":"fail","code":"S2_PORT_OCCUPIED","reproduce":"scripts/e2e-s2-krater.sh"}'
  exit 1
fi
readonly S2_PORT
S2_GIT_HEAD="$(git rev-parse HEAD)"
readonly S2_GIT_HEAD
if [[ -n "$(git status --porcelain=v1 --untracked-files=all -- "${S2_SOURCE_PATHS[@]}")" ]]; then
  readonly S2_GIT_DIRTY="dirty"
else
  readonly S2_GIT_DIRTY="clean"
fi
S2_SOURCE_DIGEST="$(shasum -a 256 "${S2_SOURCE_PATHS[@]}" | shasum -a 256 | awk '{print $1}')"
readonly S2_SOURCE_DIGEST
if [[ ! -d e2e || -L e2e ]]; then
  printf '%s\n' '{"tool":"bash","package":"apps/wire","suite":"s2-krater-evidence","status":"fail","code":"S2_EVIDENCE_PARENT_INVALID","reproduce":"scripts/e2e-s2-krater.sh"}'
  exit 1
fi
for evidence_dir in e2e/artifacts "${S2_EVIDENCE_ROOT}"; do
  if [[ -e "${evidence_dir}" || -L "${evidence_dir}" ]]; then
    if [[ ! -d "${evidence_dir}" || -L "${evidence_dir}" ]]; then
      printf '%s\n' '{"tool":"bash","package":"apps/wire","suite":"s2-krater-evidence","status":"fail","code":"S2_EVIDENCE_ROOT_INVALID","reproduce":"scripts/e2e-s2-krater.sh"}'
      exit 1
    fi
  elif ! mkdir "${evidence_dir}" 2>/dev/null; then
    # Another isolated run may have won the same parent-directory creation race. Accept only the
    # exact safe postcondition; a symlink or non-directory still fails closed.
    if [[ ! -d "${evidence_dir}" || -L "${evidence_dir}" ]]; then
      printf '%s\n' '{"tool":"bash","package":"apps/wire","suite":"s2-krater-evidence","status":"fail","code":"S2_EVIDENCE_ROOT_CREATE_FAILED","reproduce":"scripts/e2e-s2-krater.sh"}'
      exit 1
    fi
  fi
done
# Callers may provide a stable evidence handle, but it remains a path component rather than an
# opaque pathname.  An absent handle gets a collision-resistant generated one; an empty or
# malformed explicit handle is refused before it can select an artifact directory.
if [[ "${S2_RUN_ID+x}" != x ]]; then
  S2_RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(random_hex 8)"
fi
if [[ ! "${S2_RUN_ID}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$ ]]; then
  printf '%s\n' '{"tool":"bash","package":"apps/wire","suite":"s2-krater-evidence","status":"fail","code":"S2_EVIDENCE_RUN_ID_INVALID","reproduce":"scripts/e2e-s2-krater.sh"}'
  exit 1
fi
readonly S2_RUN_ID
readonly S2_RUN_DIR="${S2_EVIDENCE_ROOT}/${S2_RUN_ID}"
if ! mkdir "${S2_RUN_DIR}" || ! mkdir "${S2_RUN_DIR}/main"; then
  printf '%s\n' '{"tool":"bash","package":"apps/wire","suite":"s2-krater-evidence","status":"fail","code":"S2_EVIDENCE_RUN_CREATE_FAILED","reproduce":"scripts/e2e-s2-krater.sh"}'
  exit 1
fi
readonly S2_COST_RECEIPT_PATH="${S2_RUN_DIR}/${S2_COST_RECEIPT_RELATIVE_PATH}"
S2_STATE_DIR="${S2_RUN_DIR}/main"
readonly S2_STATE_DIR
readonly S2_SERVER_LOG="${S2_STATE_DIR}/wrangler.log"
readonly S2_ORIGIN="http://127.0.0.1:${S2_PORT}"
S2_SERVER_PID=""
S2_SERVER_PGID=""
S2_SERVER_MARKER=""
S2_SERVER_WATCHDOG_PID=""
S2_SERVER_WATCHDOG_HEALTH=""
S2_SERVER_PERSIST=""
S2_SERVER_PORT=""
S2_ACTIVE_HARNESS_TOKEN=""
S2_ACTIVE_HARNESS_RUN_ID=""
S2_LIFECYCLE_CHILD_PID=""
S2_LIFECYCLE_CHILD_PGID=""
S2_LIFECYCLE_CHILD_MARKER=""
S2_LIFECYCLE_CHILD_STATUS_FILE=""
S2_LIFECYCLE_CHILD_WATCHDOG_PID=""
S2_LIFECYCLE_CHILD_WATCHDOG_HEALTH=""
declare -a S2_LIFECYCLE_OWNED_PIDS=()
declare -a S2_LIFECYCLE_OWNED_PGIDS=()
declare -a S2_LIFECYCLE_OWNED_MARKERS=()
declare -a S2_LIFECYCLE_OWNED_STATUS_FILES=()
declare -a S2_LIFECYCLE_OWNED_WATCHDOG_PIDS=()
declare -a S2_LIFECYCLE_OWNED_WATCHDOG_HEALTH_FILES=()
declare -a S2_LIFECYCLE_OWNED_STATE_DIRS=()
declare -a S2_LIFECYCLE_OWNED_PORTS=()
# The origin the next phase talks to. The legacy upgrade stages run their own
# Worker on their own owned port, so a phase must never assume the main one.
S2_ACTIVE_ORIGIN="${S2_ORIGIN}"
# Legacy state directories are retained like every other: cleanup terminates
# processes, never files, so an upgrade failure keeps the database that caused it.
declare -a S2_LEGACY_STATE_DIRS=()

# Passed as data to the nested Bash process so the outer single-quoted supervisor program never
# has to nest shell quotes. This program contains no authority beyond its pinned process group:
# inspection uncertainty is published and retried, and only an exact leader proof permits a
# group signal after controller loss.
# shellcheck disable=SC2089,SC2016
readonly S2_WATCHDOG_PROGRAM='
supervisor_pid="$1"
owner_pid="$2"
marker="$3"
health_file="$4"
plant_uncertainty="$5"
max_uncertain_ticks="$6"
exit_on_term="$7"
watchdog_pid="$$"
last_health=""
uncertain_ticks=0
force_uncertainty=0
[[ "${max_uncertain_ticks}" =~ ^[1-9][0-9]*$ ]] || exit 125
[[ "${exit_on_term}" =~ ^[01]$ ]] || exit 125
trap "exit 0" USR1
if [[ "${exit_on_term}" == 1 ]]; then
  # Regression-only: expose the leader-plus-TERM-resistant-payload interleaving.
  # Normal watchdogs ignore group TERM until the leader dismisses them with USR1.
  trap "exit 0" TERM HUP INT
else
  trap : TERM HUP INT
fi
publish_health() {
  [[ "$1" == "${last_health}" ]] && return 0
  printf "%s %s\n" "$1" "${watchdog_pid}" >>"${health_file}" || exit 125
  last_health="$1"
}
snapshot_supervisor() {
  local line seen_pid seen_pgid seen_ppid seen_stat seen_command
  line="$(LC_ALL=C ps -o pid=,pgid=,ppid=,stat=,command= -p "${supervisor_pid}" 2>/dev/null)" || return 1
  [[ -n "${line}" ]] || return 1
  read -r seen_pid seen_pgid seen_ppid seen_stat seen_command <<<"${line}"
  [[ "${seen_pid}" =~ ^[0-9]+$ && "${seen_pgid}" =~ ^[0-9]+$ && "${seen_ppid}" =~ ^[0-9]+$ ]] || return 1
  [[ "${seen_pid}" == "${supervisor_pid}" && "${seen_pgid}" == "${supervisor_pid}" ]] || return 1
  [[ "${seen_command}" == *"s2-pinned-supervisor-${marker}"* ]] || return 1
  kill -0 "${supervisor_pid}" 2>/dev/null && kill -0 -- "-${supervisor_pid}" 2>/dev/null || return 1
  owner_ppid="${seen_ppid}"
}
terminate_after_owner_loss() {
  local proved_ticks=0
  # The caller just observed this exact supervisor with a changed controller parent. Publish the
  # controller-loss transition before TERM, because TERM can legitimately remove the leader
  # before the next process-table inspection.
  publish_health owner-lost
  kill -TERM -- "-${supervisor_pid}" 2>/dev/null || return 0
  while (( proved_ticks < 20 )); do
    kill -0 -- "-${supervisor_pid}" 2>/dev/null || return 0
    if snapshot_supervisor; then
      proved_ticks=$((proved_ticks + 1))
    else
      # A TERM-resistant member can keep the group alive after TERM removes its leader. Do not
      # let that make this owner-loss branch immortal: the same bounded uncertainty accounting as
      # the main watchdog loop publishes fail-closed state and self-retires without a PID fallback.
      record_uncertainty
    fi
    sleep 0.1
  done
  snapshot_supervisor || return 1
  publish_health owner-lost
  kill -KILL -- "-${supervisor_pid}" 2>/dev/null || :
}
record_uncertainty() {
  uncertain_ticks=$((uncertain_ticks + 1))
  publish_health inspection-uncertain
  # When the leader has exited or process inspection remains unusable, this watcher no longer
  # has authority to signal a group. It must self-retire rather than become an immortal orphan.
  if (( uncertain_ticks >= max_uncertain_ticks )); then
    publish_health inspection-timeout
    exit 125
  fi
}
while :; do
  if [[ "${force_uncertainty}" == 1 ]]; then
    record_uncertainty
  elif snapshot_supervisor; then
    uncertain_ticks=0
    publish_health healthy
    if [[ "${plant_uncertainty}" == 1 ]]; then
      plant_uncertainty=0
      sleep 1
      force_uncertainty=1
      continue
    fi
    if [[ "${owner_ppid}" != "${owner_pid}" ]]; then
      terminate_after_owner_loss && exit 0
    fi
  else
    record_uncertainty
  fi
  sleep 0.2
done
'
# shellcheck disable=SC2090
export S2_WATCHDOG_PROGRAM

emit() {
  printf '%s\n' "$1"
}

redacted_wrangler_cause() {
  local log_path="${1:-${S2_SERVER_LOG}}"
  # shellcheck disable=SC2016
  S2_LOG_PATH="${log_path}" bun --eval '
    const file = Bun.file(process.env.S2_LOG_PATH ?? "");
    const text = await file.text().catch(() => "wrangler log unavailable");
    const redacted = text
      .replace(/(?:[A-Za-z]+:)?\/(?:Users|var|tmp)\/[^\s"'\''`]+/g, "<path>")
      .replace(
        /(["\x27]?(?:authorization|proxy-authorization)["\x27]?\s*:\s*["\x27]?)(?:bearer|basic|token)\s+[^"\x27,;}\s]+/gi,
        "$1<redacted>",
      )
      .replace(
        /(["\x27]?(?:access[_-]?token|token|secret|password|authorization|signature|sig|fragment|credential|api[_-]?key)["\x27]?\s*[:=]\s*)(?:"[^"]*"|\x27[^\x27]*\x27|[^\s,;}\]]+)/gi,
        "$1<redacted>",
      )
      .replace(/\b(bearer|basic|token)\s+[A-Za-z0-9._~+\/-]{12,}/gi, "$1 <redacted>")
      .replace(/(#(?:v[0-9]+\.)?)[A-Za-z0-9_-]{16,}/g, "$1<redacted>")
      .replace(/\b(fragment|signature|token|secret)\s+['\'']?[A-Za-z0-9._~+\/-]{12,}/gi, "$1 <redacted>")
      .replace(/[^\x20-\x7E]+/g, " ")
      .slice(-2_000);
    console.log(JSON.stringify(redacted));
  '
}

emit_wrangler_failure() {
  local code="$1"
  local cause
  cause="$(redacted_wrangler_cause)"
  emit "{\"tool\":\"wrangler\",\"tool_version\":\"${S2_WRANGLER_VERSION}\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-local-do\",\"status\":\"fail\",\"code\":\"${code}\",\"cause\":${cause},\"reproduce\":\"scripts/e2e-s2-krater.sh\"}"
}

if [[ ! -x "${S2_WRANGLER}" ]]; then
  emit '{"tool":"wrangler","package":"apps/wire","suite":"s2-krater-local-d1","status":"fail","code":"WRANGLER_UNAVAILABLE","reproduce":"scripts/e2e-s2-krater.sh"}'
  exit 1
fi
S2_WRANGLER_VERSION="$("${S2_WRANGLER}" --version)"
readonly S2_WRANGLER_VERSION

if [[ ! -d "${S2_STATE_DIR}" || -L "${S2_STATE_DIR}" ]]; then
  emit '{"tool":"wrangler","package":"apps/wire","suite":"s2-krater-local-d1","status":"fail","code":"LOCAL_PERSIST_DIR_INVALID","reproduce":"scripts/e2e-s2-krater.sh"}'
  exit 1
fi

S2_PARENT_PID="$$"
S2_STARTED_PID=""
S2_STARTED_PGID=""
S2_STARTED_MARKER=""
S2_STARTED_STATUS_FILE=""
S2_STARTED_WATCHDOG_PID=""
S2_STARTED_WATCHDOG_HEALTH=""
S2_CHILD_STATUS=""
S2_GROUP_MEMBER_COUNT=0
declare -a S2_GROUP_MEMBER_PIDS=()
S2_PLANTED_RELEASE_PID=""
S2_PLANTED_RELEASE_PGID=""
S2_PLANTED_RELEASE_MARKER=""
S2_LAST_SUPERVISOR_PGID=""
# This packed record is published before any release write. It closes the caller-assignment
# gap: an EXIT trap can still prove and release the exact newest supervisor while a caller is
# between start_pinned_supervisor and its Worker/lifecycle bookkeeping. Fields are PID, PGID,
# expected PPID, marker, watchdog PID, watchdog health path, persistence directory, port, and
# proof scope. Every path is generated beneath the safe S2 run directory and contains no space.
S2_MOST_RECENT_SUPERVISOR=""

is_decimal() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

# Inspect the direct supervisor without printing its command line: it contains the per-run
# correlation token while Wrangler is starting. That token is visible to same-UID process
# inspection and is not claimed as a secrecy boundary. A missing or malformed process-table
# record is unsafe, never interpreted as an empty process group.
supervisor_snapshot() {
  local pid="$1" pgid="$2" marker="$3" line
  line="$(LC_ALL=C ps -o pid=,pgid=,ppid=,stat=,command= -p "${pid}" 2>/dev/null)" || return 1
  [[ -n "${line}" ]] || return 1
  read -r S2_PS_PID S2_PS_PGID S2_PS_PPID S2_PS_STAT S2_PS_COMMAND <<<"${line}"
  is_decimal "${S2_PS_PID}" && is_decimal "${S2_PS_PGID}" && is_decimal "${S2_PS_PPID}" || return 1
  [[ "${S2_PS_PID}" == "${pid}" && "${S2_PS_PGID}" == "${pgid}" ]] || return 1
  [[ "${S2_PS_PPID}" == "${S2_PARENT_PID}" ]] || return 1
  [[ "${S2_PS_COMMAND}" == *"s2-pinned-supervisor-${marker}"* ]] || return 1
  kill -0 "${pid}" 2>/dev/null && kill -0 -- "-${pgid}" 2>/dev/null
}

supervisor_is_owned() {
  supervisor_snapshot "$1" "$2" "$3" && [[ "${S2_PS_STAT}" != T* ]]
}

watchdog_snapshot() {
  local watchdog_pid="$1" supervisor_pid="$2" pgid="$3" marker="$4" health_file="$5"
  local line health_state health_pid
  [[ -f "${health_file}" && ! -L "${health_file}" ]] || return 1
  line="$(tail -n 1 "${health_file}" 2>/dev/null)" || return 1
  read -r health_state health_pid <<<"${line}"
  [[ "${health_state}" == "healthy" && "${health_pid}" == "${watchdog_pid}" ]] || return 1
  line="$(LC_ALL=C ps -o pid=,pgid=,ppid=,stat=,command= -p "${watchdog_pid}" 2>/dev/null)" || return 1
  [[ -n "${line}" ]] || return 1
  read -r S2_WATCHDOG_PS_PID S2_WATCHDOG_PS_PGID S2_WATCHDOG_PS_PPID \
    S2_WATCHDOG_PS_STAT S2_WATCHDOG_PS_COMMAND <<<"${line}"
  is_decimal "${S2_WATCHDOG_PS_PID}" && is_decimal "${S2_WATCHDOG_PS_PGID}" && \
    is_decimal "${S2_WATCHDOG_PS_PPID}" || return 1
  [[ "${S2_WATCHDOG_PS_PID}" == "${watchdog_pid}" && \
    "${S2_WATCHDOG_PS_PGID}" == "${pgid}" && \
    "${S2_WATCHDOG_PS_PPID}" == "${supervisor_pid}" ]] || return 1
  [[ "${S2_WATCHDOG_PS_STAT}" != T* && "${S2_WATCHDOG_PS_STAT}" != Z* && \
    "${S2_WATCHDOG_PS_COMMAND}" == *"s2-parent-watchdog-${marker}"* ]] || return 1
  kill -0 "${watchdog_pid}" 2>/dev/null && kill -0 -- "-${pgid}" 2>/dev/null
}

watchdog_is_healthy() {
  watchdog_snapshot "$1" "$2" "$3" "$4" "$5"
}

# The supervisor is the group leader and remains alive after its child exits. It blocks on a
# private release FIFO before invoking the real command, so no Wrangler/workerd descendant can
# exist until identity and kernel group ownership have been proved by the parent.
start_pinned_supervisor() {
  local status_file="$1" label="$2" persist="$3" port="$4" proof_scope="$5"
  local marker pid deadline control_fifo release_fifo release_token arm_token
  local watchdog_pid_file watchdog_health watchdog_pid tick release_sent=0
  local plant_watchdog_exit_on_term="${S2_PLANT_WATCHDOG_EXIT_ON_TERM:-0}"
  local plant_supervisor_exit_on_term="${S2_PLANT_SUPERVISOR_EXIT_ON_TERM:-0}"
  shift 5
  [[ -d "${persist}" && ! -L "${persist}" && "${port}" =~ ^[0-9]+$ ]] || return 1
  case "${proof_scope}" in
    server|client) ;;
    *) return 1 ;;
  esac
  marker="${label}-$(random_hex 16)" || return 1
  [[ ! -e "${status_file}" && ! -L "${status_file}" ]] || return 1
  control_fifo="${status_file}.control"
  [[ ! -e "${control_fifo}" && ! -L "${control_fifo}" ]] || return 1
  release_fifo="${status_file}.release"
  [[ ! -e "${release_fifo}" && ! -L "${release_fifo}" ]] || return 1
  watchdog_pid_file="${status_file}.watchdog.pid"
  [[ ! -e "${watchdog_pid_file}" && ! -L "${watchdog_pid_file}" ]] || return 1
  watchdog_health="${status_file}.watchdog.health"
  [[ ! -e "${watchdog_health}" && ! -L "${watchdog_health}" ]] || return 1
  release_token="$(random_hex 16)" || return 1
  arm_token="$(random_hex 16)" || return 1

  # macOS does not ship a `setsid` executable. POSIX::setsid is part of the system Perl and
  # creates a fresh session/process group without Bash job-control mode, which otherwise can
  # detach background jobs from the harness runner and leave their parent identity unusable.
  command -v perl >/dev/null 2>&1 || return 1
  perl -MPOSIX=setsid -e 'setsid() or die "setsid: $!"; exec @ARGV' -- bash -c '
    marker="$1"
    status_file="$2"
    owner_pid="$3"
    release_token="$4"
    arm_token="$5"
    plant_watchdog_uncertainty="$6"
    max_watchdog_uncertain_ticks="$7"
    plant_watchdog_exit_on_term="$8"
    plant_supervisor_exit_on_term="$9"
    shift 9
    supervisor_pid="$$"
    release_fifo="${status_file}.release"
    [[ ! -e "${release_fifo}" && ! -L "${release_fifo}" ]] || exit 125
    mkfifo -m 600 "${release_fifo}" || exit 125
    exec 8<>"${release_fifo}" || exit 125
    blocked_snapshot() {
      local line seen_pid seen_pgid seen_ppid seen_stat seen_command
      line="$(LC_ALL=C ps -o pid=,pgid=,ppid=,stat=,command= -p "${supervisor_pid}" 2>/dev/null)" || return 1
      [[ -n "${line}" ]] || return 1
      read -r seen_pid seen_pgid seen_ppid seen_stat seen_command <<<"${line}"
      [[ "${seen_pid}" =~ ^[0-9]+$ && "${seen_pgid}" =~ ^[0-9]+$ && "${seen_ppid}" =~ ^[0-9]+$ ]] || return 1
      [[ "${seen_pid}" == "${supervisor_pid}" && "${seen_pgid}" == "${supervisor_pid}" ]] || return 1
      [[ "${seen_ppid}" == "${owner_pid}" && "${seen_command}" == *"s2-pinned-supervisor-${marker}"* ]] || return 1
      kill -0 "${supervisor_pid}" 2>/dev/null && kill -0 -- "-${supervisor_pid}" 2>/dev/null
    }
    wait_for_gate_value() {
      local expected="$1" value
      while :; do
        blocked_snapshot || exit 125
        if IFS= read -r -t 0.2 value <&8; then
          [[ "${value}" == "${expected}" ]] || exit 125
          return 0
        fi
      done
    }
    trap "exit 125" TERM HUP INT
    # The controller first arms the parent-loss watchdog while this supervisor remains blocked.
    # Only after it proves the watchdog exact healthy identity does it send the separate
    # release value.  Thus parent death cannot fall into the old release-to-watchdog gap.
    wait_for_gate_value "${arm_token}"
    # Keep FD 8 open across both gates. Closing then reopening after watchdog publication gives
    # a concurrent controller write an interval in which its release value can be lost. The
    # watchdog receives an explicit closed FD below, and the payload inherits none.
    watchdog_pid_file="${status_file}.watchdog.pid"
    watchdog_health="${status_file}.watchdog.health"
    [[ ! -e "${watchdog_pid_file}" && ! -L "${watchdog_pid_file}" ]] || exit 125
    [[ ! -e "${watchdog_health}" && ! -L "${watchdog_health}" ]] || exit 125
    # This is a separate Bash process so its `$$` is its real process-table PID. It remains in
    # the pinned group. Inspection uncertainty is published and retried; it never makes the
    # watchdog silently disappear, and it never authorizes a signal.
    bash -c "${S2_WATCHDOG_PROGRAM}" "s2-parent-watchdog-${marker}" \
      "${supervisor_pid}" "${owner_pid}" "${marker}" \
      "${watchdog_health}" "${plant_watchdog_uncertainty}" \
      "${max_watchdog_uncertain_ticks}" "${plant_watchdog_exit_on_term}" \
      8>&- >/dev/null 2>&1 &
    watchdog_pid="$!"
    printf "%s\n" "${watchdog_pid}" >"${watchdog_pid_file}" || exit 125
    if [[ "${S2_PLANT_SUPERVISOR_EXIT_AFTER_WATCHDOG:-0}" == 1 ]]; then
      exit 125
    fi
    # While still blocked, TERM must also dismiss the watchdog.  This covers both controller
    # cancellation and the watchdog own parent-loss TERM without stranding an orphan helper.
    trap "kill -USR1 ${watchdog_pid} 2>/dev/null || :; wait ${watchdog_pid} 2>/dev/null || :; exit 125" TERM HUP INT
    wait_for_gate_value "${release_token}"
    exec 8>&-
    if [[ "${plant_supervisor_exit_on_term}" == 1 ]]; then
      # Regression-only: make the post-release leader leave on group TERM so the legacy stop
      # branch must prove or refuse the remaining TERM-resistant group without a PID fallback.
      trap "exit 0" TERM HUP INT
    else
      trap ":" TERM HUP INT
    fi
    trap "exit 0" USR1
    # One leader signal closes the controller-loss window: the still-pinned leader releases and
    # reaps its own exact watchdog before exiting. The controller never dismisses the watchdog
    # first and then hopes to reach the leader with a second signal.
    trap "kill -USR1 ${watchdog_pid} 2>/dev/null || :; wait ${watchdog_pid} 2>/dev/null || :; exit 0" USR1
    "$@" &
    child="$!"
    if wait "${child}"; then child_status=0; else child_status="$?"; fi
    case "${child_status}" in
      ""|*[!0-9]*) exit 125 ;;
    esac
    printf "%s\\n" "${child_status}" >"${status_file}"
    control_fifo="${status_file}.control"
    [[ ! -e "${control_fifo}" && ! -L "${control_fifo}" ]] || exit 125
    mkfifo -m 600 "${control_fifo}" || exit 125
    # The controller boundedly TERM then KILLs this still-pinned group. The release FIFO keeps
    # the leader alive with no extra helper after its real child has recorded a numeric status.
    exec 9<>"${control_fifo}" || exit 125
    while :; do
      read -r -t 60 _ <&9 || :
    done
  ' "s2-pinned-supervisor-${marker}" "${marker}" "${status_file}" "${S2_PARENT_PID}" \
    "${release_token}" "${arm_token}" "${S2_PLANT_WATCHDOG_INSPECTION_UNCERTAIN:-0}" \
    "${S2_WATCHDOG_MAX_UNCERTAIN_TICKS}" "${plant_watchdog_exit_on_term}" \
    "${plant_supervisor_exit_on_term}" \
    "$@" &
  pid=$!
  S2_LAST_SUPERVISOR_PGID="${pid}"

  deadline=$((SECONDS + S2_READY_DEADLINE_SECONDS))
  while (( SECONDS < deadline )); do
    if supervisor_is_owned "${pid}" "${pid}" "${marker}" && [[ -p "${release_fifo}" && ! -L "${release_fifo}" ]]; then
      # Open the parent side read/write before the final proof. A later write uses this already-open
      # descriptor, so a child exit in the proof-to-release window cannot turn pathname open into
      # an unbounded FIFO wait. The parent-held read end also prevents SIGPIPE on that planted race.
      exec 7<>"${release_fifo}" || return 1
      if ! supervisor_is_owned "${pid}" "${pid}" "${marker}"; then exec 7>&-; return 1; fi
      if ! group_members "${pid}"; then exec 7>&-; return 1; fi
      if [[ ${S2_GROUP_MEMBER_COUNT} -ne 1 ]]; then exec 7>&-; return 1; fi
      # Arm the watchdog over the already-open descriptor, then prove its parent/supervisor
      # identity before release.  The child command is still blocked, so no workerd descendant
      # can exist in this interval.
      if ! printf '%s\n' "${arm_token}" >&7; then exec 7>&-; return 1; fi
      deadline=$((SECONDS + S2_READY_DEADLINE_SECONDS))
      watchdog_pid=""
      while (( SECONDS < deadline )); do
        supervisor_is_owned "${pid}" "${pid}" "${marker}" || break
        if [[ -f "${watchdog_pid_file}" && ! -L "${watchdog_pid_file}" ]] && \
          IFS= read -r watchdog_pid <"${watchdog_pid_file}" && is_decimal "${watchdog_pid}" && \
          watchdog_is_healthy "${watchdog_pid}" "${pid}" "${pid}" "${marker}" "${watchdog_health}"; then
          break
        fi
        sleep 0.05
      done
      if ! supervisor_is_owned "${pid}" "${pid}" "${marker}" || \
        [[ -z "${watchdog_pid}" ]] || \
        ! watchdog_is_healthy "${watchdog_pid}" "${pid}" "${pid}" "${marker}" "${watchdog_health}"; then
        exec 7>&-
        if supervisor_is_owned "${pid}" "${pid}" "${marker}"; then
          signal_owned_group KILL "${pid}" "${pid}" "${marker}" || return 1
          for ((tick = 0; tick < S2_TERMINATE_WAIT_TICKS; tick += 1)); do
            kill -0 -- "-${pid}" 2>/dev/null || break
            sleep 0.1
          done
        fi
        kill -0 -- "-${pid}" 2>/dev/null && return 1
        wait "${pid}" 2>/dev/null || :
        return 1
      fi
      # This assignment precedes every release write. An EXIT trap can therefore use the same
      # exact persistence, port, and proof scope that the eventual owner would use, even if a
      # signal lands between this line and the caller recording its own ownership fields.
      S2_MOST_RECENT_SUPERVISOR="${pid} ${pid} ${S2_PARENT_PID} ${marker} ${watchdog_pid} ${watchdog_health} ${persist} ${port} ${proof_scope}"
      if [[ "${S2_PLANT_RELEASE_INTERLEAVING:-0}" == 1 ]]; then
        # FD 8 remains continuously open across watchdog publication and this release write;
        # the exact cleanup record above removes the former release-to-owner gap.
        if ! printf '%s\n' "${release_token}" >&7; then
          exec 7>&-
          return 1
        fi
        release_sent=1
      fi
      if [[ "${S2_PLANT_RELEASE_CHILD_EXIT_AFTER_REPROOF:-0}" == 1 ]]; then
        S2_PLANTED_RELEASE_PID="${pid}"
        S2_PLANTED_RELEASE_PGID="${pid}"
        S2_PLANTED_RELEASE_MARKER="${marker}"
        if ! signal_owned_group TERM "${pid}" "${pid}" "${marker}"; then
          exec 7>&-
          return 1
        fi
        for ((tick = 0; tick < S2_TERMINATE_WAIT_TICKS; tick += 1)); do
          kill -0 -- "-${pid}" 2>/dev/null || break
          sleep 0.1
        done
        # This write is deliberately after the planted child exit. It must complete immediately
        # because fd 7 already owns both ends; a pathname FIFO open here would hang forever.
        if ! printf '%s\n' "${release_token}" >&7; then exec 7>&-; return 1; fi
        exec 7>&-
        if kill -0 -- "-${pid}" 2>/dev/null; then return 1; fi
        wait "${pid}" 2>/dev/null || :
        return 1
      fi
      if [[ ${release_sent} -eq 0 ]] && ! printf '%s\n' "${release_token}" >&7; then
        exec 7>&-
        return 1
      fi
      exec 7>&-

      # The release is not considered successful until the parent can observe the separately
      # identified watchdog in a healthy state. A missing, malformed, dead, or uncertainty state
      # fails closed and the still-pinned exact group is killed before this function returns.
      deadline=$((SECONDS + S2_READY_DEADLINE_SECONDS))
      while (( SECONDS < deadline )); do
        supervisor_is_owned "${pid}" "${pid}" "${marker}" || break
        if [[ -f "${watchdog_pid_file}" && ! -L "${watchdog_pid_file}" ]] && \
          IFS= read -r watchdog_pid <"${watchdog_pid_file}" && is_decimal "${watchdog_pid}" && \
          watchdog_is_healthy "${watchdog_pid}" "${pid}" "${pid}" "${marker}" "${watchdog_health}"; then
          S2_STARTED_PID="${pid}"
          S2_STARTED_PGID="${pid}"
          S2_STARTED_MARKER="${marker}"
          S2_STARTED_STATUS_FILE="${status_file}"
          S2_STARTED_WATCHDOG_PID="${watchdog_pid}"
          S2_STARTED_WATCHDOG_HEALTH="${watchdog_health}"
          return 0
        fi
        sleep 0.05
      done
      if supervisor_is_owned "${pid}" "${pid}" "${marker}"; then
        signal_owned_group KILL "${pid}" "${pid}" "${marker}" || return 1
        for ((tick = 0; tick < S2_TERMINATE_WAIT_TICKS; tick += 1)); do
          kill -0 -- "-${pid}" 2>/dev/null || break
          sleep 0.1
        done
      fi
      kill -0 -- "-${pid}" 2>/dev/null && return 1
      wait "${pid}" 2>/dev/null || :
      return 1
    fi
    sleep 0.05
  done

  # Before release the direct supervisor has no real child. A fresh exact group proof permits
  # bounded group cleanup; an unclear process table is left for the blocked child to self-retire
  # when it observes the lost parent rather than risking an unrelated PID or PGID.
  if supervisor_is_owned "${pid}" "${pid}" "${marker}"; then
    signal_owned_group TERM "${pid}" "${pid}" "${marker}" || return 1
    for ((deadline = 0; deadline < S2_TERMINATE_WAIT_TICKS; deadline += 1)); do
      if ! kill -0 -- "-${pid}" 2>/dev/null; then
        wait "${pid}" 2>/dev/null || :
        return 1
      fi
      supervisor_is_owned "${pid}" "${pid}" "${marker}" || return 1
      sleep 0.1
    done
    signal_owned_group KILL "${pid}" "${pid}" "${marker}" || return 1
  fi
  return 1
}

read_child_status() {
  local status_file="$1" value
  [[ -f "${status_file}" && ! -L "${status_file}" ]] || return 1
  IFS= read -r value <"${status_file}" || return 1
  [[ "${value}" =~ ^([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$ ]] || return 2
  S2_CHILD_STATUS="${value}"
}

group_members() {
  local pgid="$1" rows line pid seen_pgid ppid
  rows="$(LC_ALL=C ps -axo pid=,pgid=,ppid=,stat=,command=)" || return 2
  S2_GROUP_MEMBER_COUNT=0
  S2_GROUP_MEMBER_PIDS=()
  while IFS= read -r line; do
    [[ -n "${line}" ]] || continue
    read -r pid seen_pgid ppid _ _ <<<"${line}"
    is_decimal "${pid}" && is_decimal "${seen_pgid}" && is_decimal "${ppid}" || return 2
    if [[ "${seen_pgid}" == "${pgid}" ]]; then
      S2_GROUP_MEMBER_COUNT=$((S2_GROUP_MEMBER_COUNT + 1))
      S2_GROUP_MEMBER_PIDS+=("${pid}")
    fi
  done <<<"${rows}"
}

group_contains_pid() {
  local expected="$1" member
  for member in "${S2_GROUP_MEMBER_PIDS[@]}"; do
    [[ "${member}" == "${expected}" ]] && return 0
  done
  return 1
}

signal_owned_group() {
  local signal="$1" pid="$2" pgid="$3" marker="$4"
  supervisor_is_owned "${pid}" "${pgid}" "${marker}" || return 1
  kill "-${signal}" -- "-${pgid}" 2>/dev/null
}

release_owned_supervisor() {
  local pid="$1" pgid="$2" marker="$3"
  supervisor_is_owned "${pid}" "${pgid}" "${marker}" || return 1
  kill -USR1 "${pid}" 2>/dev/null
}

lsof_scanner_is_healthy() {
  local output status
  command -v lsof >/dev/null 2>&1 || return 1
  if output="$(lsof -nP -Fp -p "$$" 2>&1)"; then
    status=0
  else
    status=$?
  fi
  S2_LSOF_LAST_OUTPUT="${output}"
  S2_LSOF_LAST_STATUS="${status}"
  [[ ${status} -eq 0 ]] || return 1
  [[ "${output}" == *"p$$"* ]]
}

lsof_scan_has_no_matches() {
  local output status
  output="$(lsof "$@" 2>&1)"
  status=$?
  S2_LSOF_LAST_OUTPUT="${output}"
  S2_LSOF_LAST_STATUS="${status}"
  case "${status}" in
    0) return 1 ;; # A successful scan printed at least one matching open descriptor/listener.
    1) [[ -z "${output}" ]] ;; # The documented lsof no-match result; any diagnostic is failure.
    *) return 1 ;; # Permission, path, or scanner failure is never evidence of zero survivors.
  esac
}

assert_no_run_survivors() {
  local persist="$1" port="$2" marker="$3" rows line
  lsof_scanner_is_healthy || return 1
  [[ -d "${persist}" && ! -L "${persist}" ]] || return 1
  port_is_busy "${port}" && return 1
  rows="$(LC_ALL=C ps -axo pid=,pgid=,ppid=,stat=,command=)" || return 1
  while IFS= read -r line; do
    [[ "${line}" == *"${persist}"* || "${line}" == *"s2-pinned-supervisor-${marker}"* || \
      "${line}" == *"s2-parent-watchdog-${marker}"* ]] && return 1
  done <<<"${rows}"
  lsof_scan_has_no_matches -nP +D "${persist}" || return 1
  lsof_scan_has_no_matches -nP -iTCP:"${port}" -sTCP:LISTEN || return 1
  return 0
}

kill_owned_group_to_zero() {
  local pid="$1" pgid="$2" marker="$3" persist="$4" port="$5" proof_scope="$6" tick
  signal_owned_group KILL "${pid}" "${pgid}" "${marker}" || return 1
  for ((tick = 0; tick < S2_TERMINATE_WAIT_TICKS; tick += 1)); do
    if ! kill -0 -- "-${pgid}" 2>/dev/null; then
      wait "${pid}" 2>/dev/null || :
      if [[ "${proof_scope}" == "server" ]]; then
        assert_no_run_survivors "${persist}" "${port}" "${marker}" || return 1
      fi
      return 0
    fi
    sleep 0.1
  done
  return 1
}

# The legacy raw-SQL lanes can lose their leader to TERM while a deliberately TERM-resistant
# child remains. At that point normal leader-pinned signalling has correctly become unavailable.
# This bounded fallback is narrower: it accepts only the still-visible watchdog command carrying
# both this run's unique marker and its retained evidence path, emits the uncertainty before KILL,
# and never falls back to a PID or a bare/recycled process group.
legacy_residual_group_is_exact() {
  local pgid="$1" marker="$2" persist="$3" rows line pid seen_pgid ppid stat command
  rows="$(LC_ALL=C ps -axo pid=,pgid=,ppid=,stat=,command=)" || return 1
  while IFS= read -r line; do
    [[ -n "${line}" ]] || continue
    read -r pid seen_pgid ppid stat command <<<"${line}"
    is_decimal "${pid}" && is_decimal "${seen_pgid}" && is_decimal "${ppid}" || return 1
    [[ "${seen_pgid}" == "${pgid}" && "${stat}" != Z* && \
      "${command}" == *"s2-parent-watchdog-${marker}"* && \
      "${command}" == *"${persist}"* ]] && return 0
  done <<<"${rows}"
  return 1
}

legacy_reap_leader_lost_group() {
  local pid="$1" pgid="$2" marker="$3" persist="$4" port="$5" tick kill_tick
  for ((tick = 0; tick < S2_LEGACY_STOP_INSPECTION_TICKS; tick += 1)); do
    if ! kill -0 -- "-${pgid}" 2>/dev/null; then
      wait "${pid}" 2>/dev/null || :
      assert_no_run_survivors "${persist}" "${port}" "${marker}" || return 1
      S2_LEGACY_STOP_REAPED_UNCERTAIN=1
      return 1
    fi
    if legacy_residual_group_is_exact "${pgid}" "${marker}" "${persist}"; then
      emit "{\"tool\":\"bash\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-local-d1-upgrade\",\"status\":\"fail\",\"code\":\"S2_LEGACY_SUPERVISOR_INSPECTION_UNCERTAIN\",\"state\":\"inspection-uncertain\",\"action\":\"kill-exact-residual-group\",\"reproduce\":\"scripts/e2e-s2-krater.sh\"}"
      # We reached this branch only after TERM was sent with a fresh exact-leader proof, and the
      # bounded scan above still sees the same run's watchdog marker in the same group. This is
      # the sole post-leader-loss KILL authority; anything less exact remains a hard refusal.
      kill -KILL -- "-${pgid}" 2>/dev/null || return 1
      for ((kill_tick = 0; kill_tick < S2_TERMINATE_WAIT_TICKS; kill_tick += 1)); do
        if ! kill -0 -- "-${pgid}" 2>/dev/null; then
          wait "${pid}" 2>/dev/null || :
          assert_no_run_survivors "${persist}" "${port}" "${marker}" || return 1
          S2_LEGACY_STOP_REAPED_UNCERTAIN=1
          return 1
        fi
        sleep 0.1
      done
      return 1
    fi
    sleep 0.1
  done
  emit "{\"tool\":\"bash\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-local-d1-upgrade\",\"status\":\"fail\",\"code\":\"S2_LEGACY_SUPERVISOR_INSPECTION_UNCERTAIN\",\"state\":\"inspection-uncertain\",\"action\":\"refuse-unproven-residual-group\",\"reproduce\":\"scripts/e2e-s2-krater.sh\"}"
  return 1
}

# A shell-regression child can deliberately model the retired pre-publication hook: its parent
# has already exited, so supervisor_is_owned correctly refuses it because PPID is now 1. This
# bounded reaper is narrower than normal cleanup. It requires the original PID/PGID plus the
# randomized supervisor marker in the live leader command before one KILL of that exact group;
# it never authorizes a bare numeric group or prints command text.
reap_parent_terminated_supervisor_residual() {
  local pid="$1" pgid="$2" marker="$3" persist="$4" port="$5"
  local rows line seen_pid seen_pgid seen_ppid seen_stat seen_command tick leader_seen=0
  is_decimal "${pid}" && is_decimal "${pgid}" && is_decimal "${port}" && \
    [[ "${pid}" == "${pgid}" && -n "${marker}" && -d "${persist}" && ! -L "${persist}" ]] || return 1
  rows="$(LC_ALL=C ps -axo pid=,pgid=,ppid=,stat=,command=)" || return 1
  while IFS= read -r line; do
    [[ -n "${line}" ]] || continue
    read -r seen_pid seen_pgid seen_ppid seen_stat seen_command <<<"${line}"
    is_decimal "${seen_pid}" && is_decimal "${seen_pgid}" && is_decimal "${seen_ppid}" || return 1
    if [[ "${seen_pid}" == "${pid}" && "${seen_pgid}" == "${pgid}" && \
      "${seen_ppid}" == "1" && "${seen_stat}" != Z* && \
      "${seen_command}" == *"s2-pinned-supervisor-${marker}"* ]]; then
      leader_seen=1
    fi
  done <<<"${rows}"
  [[ ${leader_seen} -eq 1 ]] || return 1
  kill -KILL -- "-${pgid}" 2>/dev/null || return 1
  for ((tick = 0; tick < S2_TERMINATE_WAIT_TICKS; tick += 1)); do
    if ! kill -0 -- "-${pgid}" 2>/dev/null; then
      wait "${pid}" 2>/dev/null || :
      assert_no_run_survivors "${persist}" "${port}" "${marker}"
      return $?
    fi
    sleep 0.1
  done
  return 1
}

clear_most_recent_supervisor_if_pid() {
  local pid="$1" latest_pid
  [[ -n "${S2_MOST_RECENT_SUPERVISOR}" ]] || return 0
  latest_pid="${S2_MOST_RECENT_SUPERVISOR%% *}"
  [[ "${pid}" == "${latest_pid}" ]] || return 0
  S2_MOST_RECENT_SUPERVISOR=""
}

stop_pinned_supervisor() {
  local pid="$1" pgid="$2" marker="$3" watchdog_pid="$4" watchdog_health="$5"
  local persist="$6" port="$7" proof_scope="${8:-server}" tick release_tick
  [[ -n "${pid}" ]] || return 0
  if ! watchdog_is_healthy "${watchdog_pid}" "${pid}" "${pgid}" "${marker}" \
    "${watchdog_health}"; then
    # The watchdog's exact healthy identity is part of the lifecycle contract. Its absence or
    # published inspection uncertainty is a hard failure, but the still-proved group leader is
    # sufficient authority to kill this exact group and establish zero survivors.
    if kill_owned_group_to_zero "${pid}" "${pgid}" "${marker}" "${persist}" "${port}" \
      "${proof_scope}"; then
      clear_most_recent_supervisor_if_pid "${pid}"
    else
      return 1
    fi
    return 1
  fi
  signal_owned_group TERM "${pid}" "${pgid}" "${marker}" || return 1

  for ((tick = 0; tick < S2_TERMINATE_WAIT_TICKS; tick += 1)); do
    if ! supervisor_is_owned "${pid}" "${pgid}" "${marker}"; then
      if ! kill -0 -- "-${pgid}" 2>/dev/null; then
        wait "${pid}" 2>/dev/null || :
        # The TERM was sent only after proving this exact group. If that signal has already
        # removed the complete group, accepting the observed zero-survivor postcondition avoids
        # turning a clean, bounded release race into an ownership error. A live but unprovable
        # group still fails closed below.
        if [[ "${proof_scope}" == "server" ]]; then
          assert_no_run_survivors "${persist}" "${port}" "${marker}" || return 1
        fi
        clear_most_recent_supervisor_if_pid "${pid}"
        return 0
      fi
      if [[ "${S2_LEGACY_STOP_CONTEXT:-0}" == 1 && "${proof_scope}" == "server" ]]; then
        legacy_reap_leader_lost_group "${pid}" "${pgid}" "${marker}" "${persist}" "${port}"
        return 1
      fi
      return 1
    fi
    if ! group_members "${pgid}"; then
      if kill_owned_group_to_zero "${pid}" "${pgid}" "${marker}" "${persist}" "${port}" \
        "${proof_scope}"; then
        clear_most_recent_supervisor_if_pid "${pid}"
      else
        return 1
      fi
      return 1
    fi
    if [[ ${S2_GROUP_MEMBER_COUNT} -le 2 ]]; then
      # The watchdog was proved before the group TERM. It may legitimately observe that TERM and
      # exit before this next inspection. If the other member is not that watchdog, it is an
      # unexpected TERM-resistant payload: keep the leader alive and KILL this still-proved exact
      # group. Releasing the leader first would make that survivor uninspectable and losable.
      if [[ ${S2_GROUP_MEMBER_COUNT} -eq 2 ]] && ! group_contains_pid "${watchdog_pid}"; then
        if kill_owned_group_to_zero "${pid}" "${pgid}" "${marker}" "${persist}" "${port}" \
          "${proof_scope}"; then
          clear_most_recent_supervisor_if_pid "${pid}"
          return 0
        fi
        return 1
      fi
      # At this point the group is only the leader, or the leader plus its exact watchdog. The
      # group is in terminal teardown, so release only that exact leader.
      release_owned_supervisor "${pid}" "${pgid}" "${marker}" || return 1
      for ((release_tick = 0; release_tick < S2_TERMINATE_WAIT_TICKS; release_tick += 1)); do
        if ! kill -0 -- "-${pgid}" 2>/dev/null; then
          wait "${pid}" 2>/dev/null || :
          if [[ "${proof_scope}" == "server" ]]; then
            assert_no_run_survivors "${persist}" "${port}" "${marker}" || return 1
          fi
          clear_most_recent_supervisor_if_pid "${pid}"
          return 0
        fi
        sleep 0.1
      done
      # The leader was released only after we observed no non-watchdog peer. A later survivor is
      # no longer signal-authorized because the leader is gone, so this remains a hard failure.
      return 1
    fi
    sleep 0.1
  done

  # A TERM-resistant descendant is still inside the exact leader-pinned group. The fresh leader
  # proof in this helper authorizes KILL of that group only; there is no PID fallback.
  if kill_owned_group_to_zero "${pid}" "${pgid}" "${marker}" "${persist}" "${port}" \
    "${proof_scope}"; then
    clear_most_recent_supervisor_if_pid "${pid}"
    return 0
  fi
  return 1
}

server_is_owned() {
  supervisor_is_owned "${S2_SERVER_PID}" "${S2_SERVER_PGID}" "${S2_SERVER_MARKER}" && \
    watchdog_is_healthy "${S2_SERVER_WATCHDOG_PID}" "${S2_SERVER_PID}" \
      "${S2_SERVER_PGID}" "${S2_SERVER_MARKER}" "${S2_SERVER_WATCHDOG_HEALTH}"
}

stop_worker() {
  local stopped_pid
  if [[ "${S2_PLANT_STOP_WORKER_FAILURE:-0}" == 1 ]]; then
    # Regression-only in-process mutation. The legacy wrapper must return failure before it
    # restores the origin, so this mutation is intentionally observable by its caller.
    S2_ACTIVE_ORIGIN="${S2_PLANT_STOP_WORKER_MUTATED_ORIGIN:-}"
    return 91
  fi
  [[ -n "${S2_SERVER_PID}" ]] || return 0
  stopped_pid="${S2_SERVER_PID}"
  stop_pinned_supervisor \
    "${S2_SERVER_PID}" "${S2_SERVER_PGID}" "${S2_SERVER_MARKER}" \
    "${S2_SERVER_WATCHDOG_PID}" "${S2_SERVER_WATCHDOG_HEALTH}" \
    "${S2_SERVER_PERSIST}" "${S2_SERVER_PORT}" || return 1
  S2_SERVER_PID=""
  S2_SERVER_PGID=""
  S2_SERVER_MARKER=""
  S2_SERVER_WATCHDOG_PID=""
  S2_SERVER_WATCHDOG_HEALTH=""
  S2_SERVER_PERSIST=""
  S2_SERVER_PORT=""
  S2_ACTIVE_HARNESS_TOKEN=""
  S2_ACTIVE_HARNESS_RUN_ID=""
  clear_most_recent_supervisor_if_pid "${stopped_pid}"
}

remember_lifecycle_supervisor() {
  S2_LIFECYCLE_OWNED_PIDS+=("$1")
  S2_LIFECYCLE_OWNED_PGIDS+=("$2")
  S2_LIFECYCLE_OWNED_MARKERS+=("$3")
  S2_LIFECYCLE_OWNED_STATUS_FILES+=("$4")
  S2_LIFECYCLE_OWNED_WATCHDOG_PIDS+=("$5")
  S2_LIFECYCLE_OWNED_WATCHDOG_HEALTH_FILES+=("$6")
  S2_LIFECYCLE_OWNED_STATE_DIRS+=("$7")
  S2_LIFECYCLE_OWNED_PORTS+=("$8")
}

forget_lifecycle_supervisor() {
  local pid="$1" index
  for index in "${!S2_LIFECYCLE_OWNED_PIDS[@]}"; do
    if [[ "${S2_LIFECYCLE_OWNED_PIDS[index]}" == "${pid}" ]]; then
      # Preserve the slot so Bash 3's indexed-array behavior stays simple; blank means its
      # supervisor was released and must not be signalled again by EXIT cleanup.
      S2_LIFECYCLE_OWNED_PIDS[index]=""
      S2_LIFECYCLE_OWNED_PGIDS[index]=""
      S2_LIFECYCLE_OWNED_MARKERS[index]=""
      S2_LIFECYCLE_OWNED_STATUS_FILES[index]=""
      S2_LIFECYCLE_OWNED_WATCHDOG_PIDS[index]=""
      S2_LIFECYCLE_OWNED_WATCHDOG_HEALTH_FILES[index]=""
      S2_LIFECYCLE_OWNED_STATE_DIRS[index]=""
      S2_LIFECYCLE_OWNED_PORTS[index]=""
      clear_most_recent_supervisor_if_pid "${pid}"
      return 0
    fi
  done
  return 1
}

# shellcheck disable=SC2329
stop_lifecycle_supervisors() {
  local index pid result=0
  for index in "${!S2_LIFECYCLE_OWNED_PIDS[@]}"; do
    pid="${S2_LIFECYCLE_OWNED_PIDS[index]}"
    [[ -n "${pid}" ]] || continue
    if stop_pinned_supervisor \
      "${pid}" \
      "${S2_LIFECYCLE_OWNED_PGIDS[index]}" \
      "${S2_LIFECYCLE_OWNED_MARKERS[index]}" \
      "${S2_LIFECYCLE_OWNED_WATCHDOG_PIDS[index]}" \
      "${S2_LIFECYCLE_OWNED_WATCHDOG_HEALTH_FILES[index]}" \
      "${S2_LIFECYCLE_OWNED_STATE_DIRS[index]}" \
      "${S2_LIFECYCLE_OWNED_PORTS[index]}" client; then
      forget_lifecycle_supervisor "${pid}" || return 1
    else
      result=1
    fi
  done
  return "${result}"
}

# shellcheck disable=SC2329
most_recent_supervisor_is_tracked() {
  local pid="$1" index
  [[ -n "${S2_SERVER_PID}" && "${pid}" == "${S2_SERVER_PID}" ]] && return 0
  for index in "${!S2_LIFECYCLE_OWNED_PIDS[@]}"; do
    [[ -n "${S2_LIFECYCLE_OWNED_PIDS[index]}" && \
      "${pid}" == "${S2_LIFECYCLE_OWNED_PIDS[index]}" ]] && return 0
  done
  return 1
}

# The ordinary Worker and explicit lifecycle arrays own their own release paths. This covers
# only the short, otherwise-unowned interval after the newest pinned supervisor reports ready
# and before its caller records that ownership. It never signals a bare numeric group:
# supervisor_is_owned proves PID, PGID, PPID, and randomized marker immediately before cleanup.
# shellcheck disable=SC2329
stop_most_recent_untracked_supervisor() {
  local pid pgid expected_ppid marker watchdog_pid watchdog_health persist port proof_scope
  [[ -n "${S2_MOST_RECENT_SUPERVISOR}" ]] || return 0
  read -r pid pgid expected_ppid marker watchdog_pid watchdog_health persist port proof_scope \
    <<<"${S2_MOST_RECENT_SUPERVISOR}"
  is_decimal "${pid}" && is_decimal "${pgid}" && is_decimal "${expected_ppid}" && \
    is_decimal "${watchdog_pid}" && [[ "${pid}" == "${pgid}" && \
    "${expected_ppid}" == "${S2_PARENT_PID}" && -n "${marker}" && -n "${watchdog_health}" && \
    -d "${persist}" && ! -L "${persist}" && "${port}" =~ ^[0-9]+$ ]] || return 1
  case "${proof_scope}" in
    server|client) ;;
    *) return 1 ;;
  esac
  if most_recent_supervisor_is_tracked "${pid}"; then
    clear_most_recent_supervisor_if_pid "${pid}"
    return 0
  fi

  if ! supervisor_is_owned "${pid}" "${pgid}" "${marker}"; then
    # A previously completed/explicitly released exact supervisor is not an error, but prove
    # that no marker or run-owned survivor remains. This is inspection, not a numeric group
    # signal; without the fresh identity proof above no signal is attempted.
    if ! kill -0 -- "-${pgid}" 2>/dev/null; then
      wait "${pid}" 2>/dev/null || :
      if [[ "${proof_scope}" != "server" ]] || \
        assert_no_run_survivors "${persist}" "${port}" "${marker}"; then
        clear_most_recent_supervisor_if_pid "${pid}"
        return 0
      fi
      return 1
    fi
    if [[ "${proof_scope}" == "server" ]] && \
      assert_no_run_survivors "${persist}" "${port}" "${marker}"; then
      clear_most_recent_supervisor_if_pid "${pid}"
      return 0
    fi
    return 1
  fi
  if stop_pinned_supervisor \
    "${pid}" "${pgid}" "${marker}" "${watchdog_pid}" "${watchdog_health}" \
    "${persist}" "${port}" "${proof_scope}"; then
    clear_most_recent_supervisor_if_pid "${pid}"
    return 0
  fi
  # stop_pinned_supervisor deliberately reports a missing/stale watchdog as failure even after
  # it has KILLed the freshly proved exact group. For EXIT cleanup that zero-survivor result is
  # complete: preserve the parent’s original signal status instead of converting it to 125.
  if [[ "${proof_scope}" == "client" ]] && ! kill -0 -- "-${pgid}" 2>/dev/null; then
    clear_most_recent_supervisor_if_pid "${pid}"
    return 0
  fi
  if [[ "${proof_scope}" == "server" ]] && \
    assert_no_run_survivors "${persist}" "${port}" "${marker}"; then
    clear_most_recent_supervisor_if_pid "${pid}"
    return 0
  fi
  return 1
}

# shellcheck disable=SC2329
cleanup_workers() {
  local result=0
  stop_most_recent_untracked_supervisor || result=1
  stop_lifecycle_supervisors || result=1
  stop_worker || result=1
  if [[ ${result} -ne 0 ]]; then
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-lifecycle","status":"fail","code":"S2_CLEANUP_OWNERSHIP_UNPROVEN","reproduce":"scripts/e2e-s2-krater.sh"}'
    return 1
  fi
}

# shellcheck disable=SC2329
write_evidence_receipt() {
  local exit_code="$1"
  # Environment is the typed input boundary for the Bun receipt writer below.
  # shellcheck disable=SC2034,SC2016
  S2_RECEIPT_ROOT="${S2_RUN_DIR}" \
  S2_RECEIPT_PATH="${S2_RUN_DIR}/manifest.json" \
  S2_RECEIPT_RELATIVE_PATH="${S2_RUN_DIR#./}/manifest.json" \
  S2_RECEIPT_RUN_ID="${S2_RUN_ID}" \
  S2_RECEIPT_REVISION="${S2_GIT_HEAD}" \
  S2_RECEIPT_DIRTY_STATE="${S2_GIT_DIRTY}" \
  S2_RECEIPT_SOURCE_DIGEST="${S2_SOURCE_DIGEST}" \
  S2_RECEIPT_EXIT_CODE="${exit_code}" \
  S2_RECEIPT_MAX_BYTES="${S2_MAX_RETAINED_BYTES}" \
  S2_RECEIPT_MAX_FILES="${S2_MAX_RETAINED_FILES}" \
  S2_RECEIPT_COST_RELATIVE_PATH="${S2_COST_RECEIPT_RELATIVE_PATH}" \
  bun --eval '
    import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
    import { createHash } from "node:crypto";
    import { relative, resolve } from "node:path";

    const root = process.env.S2_RECEIPT_ROOT ?? "";
    const receiptPath = process.env.S2_RECEIPT_PATH ?? "";
    const relativeReceiptPath = process.env.S2_RECEIPT_RELATIVE_PATH ?? "";
    const costReceiptRelativePath = process.env.S2_RECEIPT_COST_RELATIVE_PATH ?? "";
    const maxBytes = Number(process.env.S2_RECEIPT_MAX_BYTES);
    const maxFiles = Number(process.env.S2_RECEIPT_MAX_FILES);
    const files = [];
    const visit = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const pathname = resolve(directory, entry.name);
        const stat = lstatSync(pathname);
        if (stat.isSymbolicLink()) throw new Error("symlink");
        if (stat.isDirectory()) {
          visit(pathname);
          continue;
        }
        files.push({
          path: relative(root, pathname).split("\\\\").join("/"),
          bytes: stat.size,
          kind: stat.isFile() ? "file" : stat.isFIFO() ? "fifo" : "special",
        });
      }
    };

    try {
      if (!root || !receiptPath || lstatSync(root).isSymbolicLink()) throw new Error("root");
      visit(root);
      files.sort((left, right) => left.path.localeCompare(right.path));
      const retainedBytes = files.reduce((sum, file) => sum + file.bytes, 0);
      if (files.length + 1 > maxFiles || retainedBytes > maxBytes) throw new Error("bound");
      if (costReceiptRelativePath !== "s2-cost-input.json") throw new Error("cost-receipt-path");
      const costReceipt = files.find((file) => file.path === costReceiptRelativePath);
      const costReceiptSummary =
        costReceipt === undefined
          ? null
          : (() => {
              if (costReceipt.kind !== "file") throw new Error("cost-receipt-kind");
              const bytes = readFileSync(resolve(root, costReceiptRelativePath));
              if (bytes.byteLength !== costReceipt.bytes) throw new Error("cost-receipt-size");
              return {
                path: costReceiptRelativePath,
                digest: createHash("sha256").update(bytes).digest("hex"),
                bytes: costReceipt.bytes,
              };
            })();
      const manifest = {
        manifest_version: "s2-krater-evidence-v1",
        run_id: process.env.S2_RECEIPT_RUN_ID,
        revision: process.env.S2_RECEIPT_REVISION,
        dirty_state: process.env.S2_RECEIPT_DIRTY_STATE,
        source_digest: process.env.S2_RECEIPT_SOURCE_DIGEST,
        exit_code: Number(process.env.S2_RECEIPT_EXIT_CODE),
        retention: {
          retained: true,
          deletion_performed: false,
          max_bytes_per_run: maxBytes,
          max_files_per_run: maxFiles,
          retained_bytes_before_manifest: retainedBytes,
          retained_files_before_manifest: files.length,
        },
        s2_cost_receipt: costReceiptSummary,
        files,
      };
      const body = `${JSON.stringify(manifest)}\n`;
      if (retainedBytes + Buffer.byteLength(body) > maxBytes) throw new Error("bound");
      writeFileSync(receiptPath, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
      const manifestDigest = new Bun.CryptoHasher("sha256").update(body).digest("hex");
      console.log(JSON.stringify({
        tool: "bash+bun",
        package: "apps/wire",
        suite: "s2-krater-evidence",
        status: "pass",
        run_id: process.env.S2_RECEIPT_RUN_ID,
        manifest: relativeReceiptPath,
        manifest_digest: manifestDigest,
        retained_bytes: retainedBytes + Buffer.byteLength(body),
        retained_files: files.length + 1,
        max_retained_bytes: maxBytes,
        max_retained_files: maxFiles,
        deletion_performed: false,
        reproduce: "scripts/e2e-s2-krater.sh",
      }));
    } catch {
      console.log(JSON.stringify({
        tool: "bash+bun",
        package: "apps/wire",
        suite: "s2-krater-evidence",
        status: "fail",
        code: "S2_EVIDENCE_RECEIPT_FAILED",
        run_id: process.env.S2_RECEIPT_RUN_ID,
        reproduce: "scripts/e2e-s2-krater.sh",
      }));
      process.exit(1);
    }
  '
}

create_evidence_subdir() {
  local label="$1" path
  [[ "${label}" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || return 1
  path="${S2_RUN_DIR}/${label}-$(random_hex 8)"
  mkdir "${path}" || return 1
  [[ -d "${path}" && ! -L "${path}" ]] || return 1
  printf '%s\n' "${path}"
}

# shellcheck disable=SC2329
on_exit() {
  local original_status="$?" final_status
  trap - EXIT
  final_status="${original_status}"
  if ! cleanup_workers; then
    final_status=125
  fi
  if ! write_evidence_receipt "${final_status}"; then
    final_status=125
  fi
  exit "${final_status}"
}

trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

start_worker() {
  # Defaults keep the primary run's call sites unchanged; the upgrade stages pass their own
  # config, persistence directory and owned port.
  local config="${1:-${S2_WRANGLER_CONFIG}}"
  local persist="${2:-${S2_STATE_DIR}}"
  local port="${3:-${S2_PORT}}"
  local log="${4:-${S2_SERVER_LOG}}"
  local token run_id ready_response deadline
  port_is_busy "${port}" && return 2
  token="$(random_hex 32)" || return 1
  run_id="$(random_hex 16)" || return 1
  S2_ACTIVE_ORIGIN="http://127.0.0.1:${port}"

  start_pinned_supervisor "${persist}/server-${run_id}.status" "worker-${port}" \
    "${persist}" "${port}" server \
    env "${S2_WRANGLER}" dev apps/wire/src/krater/worker.ts \
      --config "${config}" \
      --local \
      --persist-to "${persist}" \
      --ip "${S2_BIND_IP}" \
      --port "${port}" \
      --inspector-port 0 \
      --var "S2_HARNESS_TOKEN:${token}" \
      --var "S2_HARNESS_RUN_ID:${run_id}" \
      --log-level error \
      --show-interactive-dev-session=false \
      >>"${log}" 2>&1 || return 1
  S2_SERVER_PID="${S2_STARTED_PID}"
  S2_SERVER_PGID="${S2_STARTED_PGID}"
  S2_SERVER_MARKER="${S2_STARTED_MARKER}"
  S2_SERVER_WATCHDOG_PID="${S2_STARTED_WATCHDOG_PID}"
  S2_SERVER_WATCHDOG_HEALTH="${S2_STARTED_WATCHDOG_HEALTH}"
  S2_SERVER_PERSIST="${persist}"
  S2_SERVER_PORT="${port}"
  S2_ACTIVE_HARNESS_TOKEN="${token}"
  S2_ACTIVE_HARNESS_RUN_ID="${run_id}"
  # Transfer is complete only after every Worker handle is visible to EXIT cleanup.
  clear_most_recent_supervisor_if_pid "${S2_SERVER_PID}"

  deadline=$((SECONDS + S2_READY_DEADLINE_SECONDS))
  while (( SECONDS < deadline )); do
    server_is_owned || break
    if ready_response="$(curl --fail --silent --show-error --connect-timeout 1 --max-time 1 \
      -H "x-s2-harness-token: ${S2_ACTIVE_HARNESS_TOKEN}" \
      "${S2_ACTIVE_ORIGIN}/__s2/ready" 2>/dev/null)" && \
      [[ "${ready_response}" == "{\"status\":\"ready\",\"run_id\":\"${S2_ACTIVE_HARNESS_RUN_ID}\"}" ]] && \
      server_is_owned; then
      return 0
    fi
    sleep 0.2
  done
  stop_worker || :
  return 1
}

run_phase() {
  local phase="$1" phase_pid phase_pgid phase_marker phase_status deadline
  local phase_watchdog_pid phase_watchdog_health
  local -a receipt_environment=()
  if [[ "${phase}" == "exercise" ]]; then
    if [[ -e "${S2_COST_RECEIPT_PATH}" || -L "${S2_COST_RECEIPT_PATH}" ]]; then
      emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-local-d1","status":"fail","code":"S2_COST_RECEIPT_EXISTS","reproduce":"scripts/e2e-s2-krater.sh"}'
      return 125
    fi
    receipt_environment=(
      "S2_RUN_ID=${S2_RUN_ID}"
      "S2_COST_RECEIPT_ROOT=${S2_RUN_DIR}"
      "S2_COST_RECEIPT_PATH=${S2_COST_RECEIPT_PATH}"
    )
  fi
  # A phase client is deliberately not a Worker/lifecycle-array owner. Its local handles can be
  # untracked by those arrays for up to S2_PHASE_DEADLINE_SECONDS (75s), so the most-recent
  # record remains live until its exact supervisor has stopped.
  start_pinned_supervisor "${S2_STATE_DIR}/client-${phase}-$(random_hex 8).status" "client-${phase}" \
    "${S2_SERVER_PERSIST}" "${S2_SERVER_PORT}" client \
    env \
      S2_ORIGIN="${S2_ACTIVE_ORIGIN}" \
      S2_PHASE="${phase}" \
      S2_HARNESS_TOKEN="${S2_ACTIVE_HARNESS_TOKEN}" \
      S2_GIT_HEAD="${S2_GIT_HEAD}" \
      S2_GIT_DIRTY="${S2_GIT_DIRTY}" \
      S2_SOURCE_DIGEST="${S2_SOURCE_DIGEST}" \
      "${receipt_environment[@]}" \
      bun apps/wire/src/krater/s2-client.ts || return 125
  phase_pid="${S2_STARTED_PID}"
  phase_pgid="${S2_STARTED_PGID}"
  phase_marker="${S2_STARTED_MARKER}"
  phase_status="${S2_STARTED_STATUS_FILE}"
  phase_watchdog_pid="${S2_STARTED_WATCHDOG_PID}"
  phase_watchdog_health="${S2_STARTED_WATCHDOG_HEALTH}"
  deadline=$((SECONDS + S2_PHASE_DEADLINE_SECONDS))
  while :; do
    if read_child_status "${phase_status}"; then
      if ! stop_pinned_supervisor "${phase_pid}" "${phase_pgid}" "${phase_marker}" \
        "${phase_watchdog_pid}" "${phase_watchdog_health}" \
        "${S2_SERVER_PERSIST}" "${S2_SERVER_PORT}" client; then
        emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-lifecycle","status":"fail","code":"S2_CLIENT_CLEANUP_OWNERSHIP_UNPROVEN","reproduce":"scripts/e2e-s2-krater.sh"}'
        return 125
      fi
      return "${S2_CHILD_STATUS}"
    fi
    if ! server_is_owned; then
      stop_pinned_supervisor "${phase_pid}" "${phase_pgid}" "${phase_marker}" \
        "${phase_watchdog_pid}" "${phase_watchdog_health}" \
        "${S2_SERVER_PERSIST}" "${S2_SERVER_PORT}" client || :
      return 125
    fi
    if (( SECONDS >= deadline )); then
      stop_pinned_supervisor "${phase_pid}" "${phase_pgid}" "${phase_marker}" \
        "${phase_watchdog_pid}" "${phase_watchdog_health}" \
        "${S2_SERVER_PERSIST}" "${S2_SERVER_PORT}" client || :
      return 124
    fi
    sleep 0.2
  done
}

emit_legacy_failure() {
  local phase="$1" code="$2" log="$3"
  local cause
  cause="$(redacted_wrangler_cause "${log}")"
  emit "{\"tool\":\"wrangler\",\"tool_version\":\"${S2_WRANGLER_VERSION}\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-local-d1-upgrade\",\"scenario\":\"${phase}\",\"status\":\"fail\",\"code\":\"${code}\",\"cause\":${cause},\"reproduce\":\"scripts/e2e-s2-krater.sh\"}"
}

run_legacy_phase() {
  local phase="$1" log="$2" phase_status
  if run_phase "${phase}"; then
    return 0
  else
    phase_status=$?
  fi
  emit_legacy_failure "${phase}" "S2_LEGACY_UPGRADE_SCENARIO_FAILED" "${log}"
  return "${phase_status}"
}

stop_legacy_worker_or_fail() {
  local stop_status
  S2_LEGACY_STOP_CONTEXT=1
  if stop_worker; then
    stop_status=0
  else
    stop_status=$?
  fi
  unset S2_LEGACY_STOP_CONTEXT
  if [[ ${stop_status} -ne 0 ]]; then
    # The bounded residual branch proved zero survivors but intentionally reports failure: the
    # upgrade phase cannot call that teardown clean. Forget its dead handles so EXIT cleanup does
    # not re-inspect an already-reaped group and turn a precise failure into a stale one.
    if [[ "${S2_LEGACY_STOP_REAPED_UNCERTAIN:-0}" == 1 ]]; then
      S2_SERVER_PID=""
      S2_SERVER_PGID=""
      S2_SERVER_MARKER=""
      S2_SERVER_WATCHDOG_PID=""
      S2_SERVER_WATCHDOG_HEALTH=""
      S2_SERVER_PERSIST=""
      S2_SERVER_PORT=""
      S2_ACTIVE_HARNESS_TOKEN=""
      S2_ACTIVE_HARNESS_RUN_ID=""
      unset S2_LEGACY_STOP_REAPED_UNCERTAIN
    fi
    return 1
  fi
  S2_ACTIVE_ORIGIN="${S2_ORIGIN}"
}

# ── raw-SQL schema stages ────────────────────────────────────────────────────
# Build a genuinely old database and apply the named SQL files directly. This is retained to
# observe the exact 0004-only and 0005-only schema states; it is deliberately not presented as
# migration-runner evidence. `run_migration_journal_upgrade` below proves that separate lane.
#
# The order is the whole point. `wrangler.s2-legacy.toml` carries its own
# `migrations_dir` holding the exact pre-integrity 0001 and nothing else, so the
# database is first created without any integrity column, optionally given the
# retained legacy row, and only then given the named raw SQL file. A database born with 0004
# already applied would exercise none of this: the backfill would have nothing legacy to refuse.
#
# Each stage owns its own persistence directory and its own dynamically chosen
# port, so it can neither read nor collide with the primary run's state.
run_legacy_upgrade() {
  local phase="$1" fixture="$2" index_phase="${3:-}"
  local dir port log status

  dir="$(create_evidence_subdir legacy)"
  if [[ ! -d "${dir}" || -L "${dir}" ]]; then
    emit "{\"tool\":\"bash\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-local-d1-upgrade\",\"scenario\":\"${phase}\",\"status\":\"fail\",\"code\":\"S2_LEGACY_PERSIST_DIR_INVALID\",\"reproduce\":\"scripts/e2e-s2-krater.sh\"}"
    return 1
  fi
  # Retained, never removed: an upgrade failure keeps the database that caused it.
  S2_LEGACY_STATE_DIRS+=("${dir}")
  log="${dir}/wrangler.log"

  if ! "${S2_WRANGLER}" d1 migrations apply DB --config "${S2_LEGACY_CONFIG}" --local \
    --persist-to "${dir}" >"${dir}/legacy-migration.log" 2>&1; then
    emit_legacy_failure "${phase}" "S2_LEGACY_BASE_MIGRATION_FAILED" "${dir}/legacy-migration.log"
    return 1
  fi

  if [[ -n "${fixture}" ]]; then
    if ! "${S2_WRANGLER}" d1 execute DB --config "${S2_LEGACY_CONFIG}" --local \
      --persist-to "${dir}" --file "${fixture}" >"${dir}/legacy-fixture.log" 2>&1; then
      emit_legacy_failure "${phase}" "S2_LEGACY_FIXTURE_LOAD_FAILED" "${dir}/legacy-fixture.log"
      return 1
    fi
  fi

  # This is intentionally raw SQL, not `d1 migrations apply`; the JSONL emitted by the client
  # labels it `raw-sql-0004`. The migration-journal lane below covers the deploy mechanism.
  if ! "${S2_WRANGLER}" d1 execute DB --config "${S2_LEGACY_CONFIG}" --local \
    --persist-to "${dir}" --file "${S2_FORWARD_MIGRATION}" >"${dir}/forward-migration.log" 2>&1; then
    emit_legacy_failure "${phase}" "S2_LEGACY_FORWARD_MIGRATION_FAILED" "${dir}/forward-migration.log"
    return 1
  fi

  if ! port="$(choose_available_port)"; then
    emit "{\"tool\":\"bash\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-local-d1-upgrade\",\"scenario\":\"${phase}\",\"status\":\"fail\",\"code\":\"S2_LEGACY_PORT_UNAVAILABLE\",\"reproduce\":\"scripts/e2e-s2-krater.sh\"}"
    return 1
  fi

  if ! start_worker "${S2_LEGACY_CONFIG}" "${dir}" "${port}" "${log}"; then
    emit_legacy_failure "${phase}" "S2_LEGACY_WORKER_UNAVAILABLE" "${log}"
    S2_ACTIVE_ORIGIN="${S2_ORIGIN}"
    return 1
  fi

  if run_legacy_phase "${phase}" "${log}"; then
    status=0
  else
    status=$?
  fi
  stop_legacy_worker_or_fail || return 1

  # Second raw schema stage: 0004 -> 0005 on the database the first stage just used, rows and all.
  #
  # This is the only 0004-era database in the run. Without this the forward-migration evidence
  # stopped at 0004 and the index was only ever seen on a database born with it, so nothing
  # here observes the index transition without claiming it exercised the deployed migration
  # runner. The Worker is restarted because the first stage must observe the schema before the
  # index exists.
  if [[ "${status}" -eq 0 && -n "${index_phase}" ]]; then
    if ! "${S2_WRANGLER}" d1 execute DB --config "${S2_LEGACY_CONFIG}" --local \
      --persist-to "${dir}" --file "${S2_INDEX_MIGRATION}" >"${dir}/index-migration.log" 2>&1; then
      emit_legacy_failure "${index_phase}" "S2_LEGACY_INDEX_MIGRATION_FAILED" "${dir}/index-migration.log"
      return 1
    fi

    if ! port="$(choose_available_port)"; then
      emit "{\"tool\":\"bash\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-local-d1-upgrade\",\"scenario\":\"${index_phase}\",\"status\":\"fail\",\"code\":\"S2_LEGACY_PORT_UNAVAILABLE\",\"reproduce\":\"scripts/e2e-s2-krater.sh\"}"
      return 1
    fi

    log="${dir}/wrangler-indexed.log"
    if ! start_worker "${S2_LEGACY_CONFIG}" "${dir}" "${port}" "${log}"; then
      emit_legacy_failure "${index_phase}" "S2_LEGACY_WORKER_UNAVAILABLE" "${log}"
      S2_ACTIVE_ORIGIN="${S2_ORIGIN}"
      return 1
    fi

    if run_legacy_phase "${index_phase}" "${log}"; then
      :
    else
      status=$?
    fi
    stop_legacy_worker_or_fail || return 1
  fi
  return "${status}"
}

assert_current_migration_journal() {
  local dir="$1" phase="$2" journal_path journal_stderr
  journal_path="${dir}/migration-journal.json"
  journal_stderr="${dir}/migration-journal.stderr"
  if ! "${S2_WRANGLER}" d1 execute DB --config "${S2_UPGRADE_CONFIG}" --local \
    --persist-to "${dir}" \
    --command 'SELECT id, name, applied_at FROM d1_migrations ORDER BY id' \
    --json >"${journal_path}" 2>"${journal_stderr}"; then
    emit_legacy_failure "${phase}" "S2_MIGRATION_JOURNAL_UNREADABLE" "${journal_stderr}"
    return 1
  fi
  validate_current_migration_journal "${journal_path}" "${phase}"
}

# Keep the parser as an executable boundary distinct from the Wrangler query. The shell
# regressions feed this exact program valid and malformed D1-shaped journal JSON without
# pretending a synthetic fixture is migration-runner evidence.
validate_current_migration_journal() {
  local journal_path="$1" phase="$2"
  S2_JOURNAL_PATH="${journal_path}" \
  S2_JOURNAL_PHASE="${phase}" \
  S2_JOURNAL_EXPECTED="${S2_EXPECTED_MIGRATION_JOURNAL[*]}" \
  S2_JOURNAL_REVISION="${S2_GIT_HEAD}" \
  S2_JOURNAL_DIRTY_STATE="${S2_GIT_DIRTY}" \
  S2_JOURNAL_SOURCE_DIGEST="${S2_SOURCE_DIGEST}" \
  S2_JOURNAL_WRANGLER_VERSION="${S2_WRANGLER_VERSION}" \
  bun --eval '
    const fail = (code) => {
      console.log(JSON.stringify({
        tool: "wrangler+bun",
        tool_version: process.env.S2_JOURNAL_WRANGLER_VERSION,
        package: "apps/wire",
        suite: "s2-krater-local-d1-upgrade",
        scenario: process.env.S2_JOURNAL_PHASE,
        revision: process.env.S2_JOURNAL_REVISION,
        dirty_state: process.env.S2_JOURNAL_DIRTY_STATE,
        source_digest: process.env.S2_JOURNAL_SOURCE_DIGEST,
        status: "fail",
        code,
        reproduce: "scripts/e2e-s2-krater.sh",
      }));
      process.exit(1);
    };

    try {
      const payload = JSON.parse(await Bun.file(process.env.S2_JOURNAL_PATH ?? "").text());
      if (!Array.isArray(payload) || payload.length !== 1) fail("S2_MIGRATION_JOURNAL_SHAPE_INVALID");
      const envelope = payload[0];
      if (typeof envelope !== "object" || envelope === null || envelope.success !== true ||
        !Array.isArray(envelope.results)) fail("S2_MIGRATION_JOURNAL_SHAPE_INVALID");
      const expected = (process.env.S2_JOURNAL_EXPECTED ?? "").split(" ").filter(Boolean);
      const journal = envelope.results.map((entry) => {
        if (typeof entry !== "object" || entry === null || !Number.isInteger(entry.id) ||
          typeof entry.name !== "string" || typeof entry.applied_at !== "string" ||
          !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(entry.applied_at)) {
          fail("S2_MIGRATION_JOURNAL_ENTRY_INVALID");
        }
        return { id: entry.id, name: entry.name, applied_at: entry.applied_at };
      });
      if (journal.length !== expected.length || journal.some((entry, index) =>
        entry.id !== index + 1 || entry.name !== expected[index])) {
        fail("S2_MIGRATION_JOURNAL_EXACT_ORDER_INVALID");
      }
      // Applied timestamps are valid provenance evidence, but not migration identity: two
      // equivalent journal replays happen at different wall-clock times. Digest only the
      // canonical ordered id/name identity so equal migration histories hash identically.
      const journalIdentity = journal.map(({ id, name }) => ({ id, name }));
      const canonicalJournal = JSON.stringify(journalIdentity);
      const journalDigest = new Bun.CryptoHasher("sha256")
        .update(canonicalJournal)
        .digest("hex");
      console.log(JSON.stringify({
        tool: "wrangler+bun",
        tool_version: process.env.S2_JOURNAL_WRANGLER_VERSION,
        package: "apps/wire",
        suite: "s2-krater-local-d1-upgrade",
        scenario: process.env.S2_JOURNAL_PHASE,
        revision: process.env.S2_JOURNAL_REVISION,
        dirty_state: process.env.S2_JOURNAL_DIRTY_STATE,
        source_digest: process.env.S2_JOURNAL_SOURCE_DIGEST,
        journal_identity: journalIdentity,
        applied_at_evidence: journal.map(({ id, applied_at }) => ({ id, applied_at })),
        journal_digest: journalDigest,
        status: "pass",
        reproduce: "scripts/e2e-s2-krater.sh",
      }));
    } catch {
      fail("S2_MIGRATION_JOURNAL_PARSE_FAILED");
    }
  '
}

# Create the exact 0001 database with the legacy config, then switch to a configuration with
# the same local D1 identity and the real repository migration directory. Unlike the raw lane,
# this invokes Wrangler's migration journal end to end and verifies every current migration name
# before the Worker is allowed to serve the test phase.
run_migration_journal_upgrade() {
  local phase="$1" fixture="$2" dir port log status
  dir="$(create_evidence_subdir journal)"
  if [[ ! -d "${dir}" || -L "${dir}" ]]; then
    emit "{\"tool\":\"bash\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-local-d1-upgrade\",\"scenario\":\"${phase}\",\"status\":\"fail\",\"code\":\"S2_JOURNAL_PERSIST_DIR_INVALID\",\"reproduce\":\"scripts/e2e-s2-krater.sh\"}"
    return 1
  fi
  S2_LEGACY_STATE_DIRS+=("${dir}")
  log="${dir}/wrangler.log"
  if ! "${S2_WRANGLER}" d1 migrations apply DB --config "${S2_LEGACY_CONFIG}" --local \
    --persist-to "${dir}" >"${dir}/legacy-migration.log" 2>&1; then
    emit_legacy_failure "${phase}" "S2_JOURNAL_LEGACY_BASE_FAILED" "${dir}/legacy-migration.log"
    return 1
  fi
  if [[ -n "${fixture}" ]] && ! "${S2_WRANGLER}" d1 execute DB --config "${S2_LEGACY_CONFIG}" --local \
    --persist-to "${dir}" --file "${fixture}" >"${dir}/legacy-fixture.log" 2>&1; then
    emit_legacy_failure "${phase}" "S2_JOURNAL_FIXTURE_LOAD_FAILED" "${dir}/legacy-fixture.log"
    return 1
  fi
  if ! "${S2_WRANGLER}" d1 migrations apply DB --config "${S2_UPGRADE_CONFIG}" --local \
    --persist-to "${dir}" >"${dir}/current-migrations.log" 2>&1; then
    emit_legacy_failure "${phase}" "S2_JOURNAL_CURRENT_APPLY_FAILED" "${dir}/current-migrations.log"
    return 1
  fi
  assert_current_migration_journal "${dir}" "${phase}" || return 1
  if ! port="$(choose_available_port)"; then
    emit "{\"tool\":\"bash\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-local-d1-upgrade\",\"scenario\":\"${phase}\",\"status\":\"fail\",\"code\":\"S2_JOURNAL_PORT_UNAVAILABLE\",\"reproduce\":\"scripts/e2e-s2-krater.sh\"}"
    return 1
  fi
  if ! start_worker "${S2_UPGRADE_CONFIG}" "${dir}" "${port}" "${log}"; then
    emit_legacy_failure "${phase}" "S2_JOURNAL_WORKER_UNAVAILABLE" "${log}"
    S2_ACTIVE_ORIGIN="${S2_ORIGIN}"
    return 1
  fi
  if run_legacy_phase "${phase}" "${log}"; then status=0; else status=$?; fi
  stop_worker || return 1
  S2_ACTIVE_ORIGIN="${S2_ORIGIN}"
  return "${status}"
}

run_legacy_upgrade_checked() {
  local upgrade_status
  if run_legacy_upgrade "$@"; then
    return 0
  else
    upgrade_status=$?
  fi
  return "${upgrade_status}"
}

assert_legacy_fixture_bytes() {
  local fixture_digest migration_path migration_name expected_index=0
  # The journal expectation is intentionally closed: a new migration must update both the
  # observed journal and the bounded provenance input list in the same review, rather than
  # silently making this upgrade proof describe only an old prefix.
  while IFS= read -r migration_path; do
    migration_name="${migration_path##*/}"
    if (( expected_index >= ${#S2_EXPECTED_MIGRATION_JOURNAL[@]} )) || \
      [[ "${migration_name}" != "${S2_EXPECTED_MIGRATION_JOURNAL[expected_index]}" ]] || \
      [[ " ${S2_SOURCE_PATHS[*]} " != *" db/migrations/${migration_name} "* ]]; then
      emit '{"tool":"find","package":"apps/wire","suite":"s2-krater-migration-provenance","status":"fail","code":"S2_MIGRATION_SOURCE_JOURNAL_DRIFT","reproduce":"scripts/e2e-s2-krater.sh"}'
      return 1
    fi
    expected_index=$((expected_index + 1))
  done < <(LC_ALL=C find db/migrations -maxdepth 1 -type f -name '*.sql' -print | LC_ALL=C sort)
  if (( expected_index != ${#S2_EXPECTED_MIGRATION_JOURNAL[@]} )); then
    emit '{"tool":"find","package":"apps/wire","suite":"s2-krater-migration-provenance","status":"fail","code":"S2_MIGRATION_SOURCE_JOURNAL_DRIFT","reproduce":"scripts/e2e-s2-krater.sh"}'
    return 1
  fi
  if ! cmp -s apps/wire/src/krater/fixtures/legacy-migrations/0001_krater_v0.sql \
    db/migrations/0001_krater_v0.sql; then
    emit '{"tool":"cmp","package":"apps/wire","suite":"s2-krater-migration-provenance","status":"fail","code":"S2_LEGACY_FIXTURE_BYTE_DRIFT","reproduce":"scripts/e2e-s2-krater.sh"}'
    return 1
  fi
  fixture_digest="$(shasum -a 256 db/migrations/0001_krater_v0.sql | awk '{print $1}')" || return 1
  [[ "${fixture_digest}" =~ ^[a-f0-9]{64}$ ]] || return 1
  emit "{\"tool\":\"cmp+shasum\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-migration-provenance\",\"revision\":\"${S2_GIT_HEAD}\",\"dirty_state\":\"${S2_GIT_DIRTY}\",\"source_digest\":\"${S2_SOURCE_DIGEST}\",\"fixture_digest\":\"${fixture_digest}\",\"byte_equal\":true,\"status\":\"pass\",\"reproduce\":\"scripts/e2e-s2-krater.sh\"}"
}

run_s2_shell_regression_test() {
  local mode="$1" phase_status upgrade_status emitted_phase="" status_file deadline
  local supervisor_pid supervisor_pgid supervisor_marker supervisor_status redaction_log redaction_cause
  local supervisor_watchdog_pid supervisor_watchdog_health watchdog_state watchdog_health_pid stop_status
  local source_path signal_called=0 parent_loss_record parent_loss_child parent_loss_status
  local journal_valid journal_alternate journal_invalid valid_output alternate_output invalid_output
  local valid_digest alternate_digest cleanup_status
  local interrupt_record interrupt_child interrupt_status interrupt_secret child_persist child_port
  local child_run child_status_file child_diagnostic diagnostic_body manifest_body

  if [[ "${mode}" == "parent-loss-child" ]]; then
    parent_loss_record="${S2_PARENT_LOSS_RECORD:-}"
    [[ -n "${parent_loss_record}" && ! -e "${parent_loss_record}" && ! -L "${parent_loss_record}" ]] || return 2
    status_file="${S2_STATE_DIR}/parent-loss-$(random_hex 8).status"
    start_pinned_supervisor "${status_file}" parent-loss "${S2_STATE_DIR}" "${S2_PORT}" client \
      bash -c 'sleep 30' || return 1
    printf '%s %s %s %s %s\n' \
      "${S2_STARTED_PID}" "${S2_STARTED_PGID}" "${S2_STARTED_MARKER}" \
      "${S2_STARTED_WATCHDOG_PID}" "${S2_STARTED_WATCHDOG_HEALTH}" >"${parent_loss_record}"
    # Deliberately bypass the controller EXIT trap: the watchdog in the already-proved group is
    # the subject under test and must TERM/KILL its own group without any parent PID fallback.
    kill -KILL "$$"
    return 125
  fi

  if [[ "${mode}" == "parent-loss" ]]; then
    parent_loss_record="${S2_STATE_DIR}/parent-loss-record-$(random_hex 8)"
    env \
      S2_SHELL_REGRESSION_TEST=parent-loss-child \
      S2_PARENT_LOSS_RECORD="${parent_loss_record}" \
      bash "${BASH_SOURCE[0]}" >/dev/null 2>&1 &
    parent_loss_child=$!
    if wait "${parent_loss_child}" 2>/dev/null; then
      parent_loss_status=0
    else
      parent_loss_status=$?
    fi
    [[ ${parent_loss_status} -eq 137 ]] || return 1
    [[ -f "${parent_loss_record}" && ! -L "${parent_loss_record}" ]] || return 1
    read -r supervisor_pid supervisor_pgid supervisor_marker supervisor_watchdog_pid \
      supervisor_watchdog_health supervisor_status <"${parent_loss_record}" || return 1
    is_decimal "${supervisor_pid}" && is_decimal "${supervisor_pgid}" || return 1
    is_decimal "${supervisor_watchdog_pid}" || return 1
    [[ "${supervisor_pid}" == "${supervisor_pgid}" && -n "${supervisor_marker}" && \
      -f "${supervisor_watchdog_health}" && ! -L "${supervisor_watchdog_health}" ]] || return 1
    deadline=$((SECONDS + S2_TERMINATE_WAIT_TICKS + 5))
    while kill -0 -- "-${supervisor_pgid}" 2>/dev/null; do
      if (( SECONDS >= deadline )); then
        # The current hook must never reach this branch. If a deliberately failing old-hook
        # shape does, reap only its still-provable PPID-1 marker leader and then fail the plant
        # after proving zero residue, so the regression cannot leave an immortal supervisor.
        if reap_parent_terminated_supervisor_residual \
          "${supervisor_pid}" "${supervisor_pgid}" "${supervisor_marker}" \
          "${child_persist}" "${child_port}"; then
          emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"fail","code":"S2_PARENT_TERM_OLD_HOOK_RESIDUAL_REAPED","reproduce":"S2_SHELL_REGRESSION_TEST=term-interrupt-cleanup scripts/e2e-s2-krater.sh"}'
        fi
        return 1
      fi
      sleep 0.1
    done
    read -r watchdog_state watchdog_health_pid < <(tail -n 1 "${supervisor_watchdog_health}") || return 1
    [[ "${watchdog_state}" == "owner-lost" && \
      "${watchdog_health_pid}" == "${supervisor_watchdog_pid}" ]] || return 1
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"pass","scenario":"planted-controller-loss-terminates-its-own-pinned-group-without-parent-pid-fallback","reproduce":"S2_SHELL_REGRESSION_TEST=parent-loss scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  if [[ "${mode}" == "owner-loss-uncertain-child" ]]; then
    parent_loss_record="${S2_PARENT_LOSS_RECORD:-}"
    [[ -n "${parent_loss_record}" && ! -e "${parent_loss_record}" && ! -L "${parent_loss_record}" ]] || return 2
    status_file="${S2_STATE_DIR}/owner-loss-uncertain-$(random_hex 8).status"
    # This exact plant combines controller loss, a leader that exits when the watchdog sends
    # group TERM, and a payload that ignores TERM. The post-TERM group remains live while the
    # watchdog's supervisor inspection is necessarily uncertain.
    # The child Bash, not this harness, must expand its SECONDS-based deadline.
    # shellcheck disable=SC2016
    S2_PLANT_SUPERVISOR_EXIT_ON_TERM=1 \
      start_pinned_supervisor "${status_file}" owner-loss-uncertain "${S2_STATE_DIR}" "${S2_PORT}" client \
        bash -c 'trap "" TERM; deadline=$((SECONDS + 4)); while (( SECONDS < deadline )); do read -r -t 1 ignored || :; done' || return 1
    deadline=$((SECONDS + S2_READY_DEADLINE_SECONDS))
    while :; do
      group_members "${S2_STARTED_PGID}" || return 1
      [[ ${S2_GROUP_MEMBER_COUNT} -ge 3 ]] && break
      (( SECONDS < deadline )) || return 1
      sleep 0.05
    done
    printf '%s %s %s %s %s %s %s\n' \
      "${S2_STARTED_PID}" "${S2_STARTED_PGID}" "${S2_STARTED_MARKER}" \
      "${S2_STARTED_WATCHDOG_PID}" "${S2_STARTED_WATCHDOG_HEALTH}" \
      "${S2_STATE_DIR}" "${S2_PORT}" >"${parent_loss_record}"
    # Bypass this controller's EXIT trap. The independently identified watchdog is the subject:
    # it must observe controller loss, bound its now-uncertain inspection, and self-retire.
    kill -KILL "$$"
    return 125
  fi

  if [[ "${mode}" == "owner-loss-uncertain" ]]; then
    local child_persist child_port
    parent_loss_record="${S2_STATE_DIR}/owner-loss-uncertain-record-$(random_hex 8)"
    env \
      S2_SHELL_REGRESSION_TEST=owner-loss-uncertain-child \
      S2_PARENT_LOSS_RECORD="${parent_loss_record}" \
      bash "${BASH_SOURCE[0]}" >/dev/null 2>&1 &
    parent_loss_child=$!
    if wait "${parent_loss_child}" 2>/dev/null; then
      parent_loss_status=0
    else
      parent_loss_status=$?
    fi
    [[ ${parent_loss_status} -eq 137 ]] || return 1
    [[ -f "${parent_loss_record}" && ! -L "${parent_loss_record}" ]] || return 1
    read -r supervisor_pid supervisor_pgid supervisor_marker supervisor_watchdog_pid \
      supervisor_watchdog_health child_persist child_port <"${parent_loss_record}" || return 1
    is_decimal "${supervisor_pid}" && is_decimal "${supervisor_pgid}" && \
      is_decimal "${supervisor_watchdog_pid}" && is_decimal "${child_port}" || return 1
    [[ "${supervisor_pid}" == "${supervisor_pgid}" && -n "${supervisor_marker}" && \
      -d "${child_persist}" && ! -L "${child_persist}" && \
      "${supervisor_watchdog_health}" == "${child_persist}/"* && \
      -f "${supervisor_watchdog_health}" && ! -L "${supervisor_watchdog_health}" ]] || return 1
    deadline=$((SECONDS + S2_WATCHDOG_MAX_UNCERTAIN_TICKS + 8))
    while kill -0 -- "-${supervisor_pgid}" 2>/dev/null; do
      (( SECONDS < deadline )) || return 1
      sleep 0.1
    done
    grep -Fqx "owner-lost ${supervisor_watchdog_pid}" "${supervisor_watchdog_health}" || return 1
    grep -Fqx "inspection-uncertain ${supervisor_watchdog_pid}" "${supervisor_watchdog_health}" || return 1
    grep -Fqx "inspection-timeout ${supervisor_watchdog_pid}" "${supervisor_watchdog_health}" || return 1
    if kill -0 "${supervisor_watchdog_pid}" 2>/dev/null; then return 1; fi
    assert_no_run_survivors "${child_persist}" "${child_port}" "${supervisor_marker}" || return 1
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"pass","scenario":"controller-loss-plus-leader-loss-plus-term-resistant-member-bounds-owner-loss-inspection-and-watchdog-self-retires","reproduce":"S2_SHELL_REGRESSION_TEST=owner-loss-uncertain scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  if [[ "${mode}" == "release-race" ]]; then
    status_file="${S2_STATE_DIR}/release-race-$(random_hex 8).status"
    if S2_PLANT_RELEASE_CHILD_EXIT_AFTER_REPROOF=1 \
      start_pinned_supervisor "${status_file}" release-race "${S2_STATE_DIR}" "${S2_PORT}" client \
        bash -c 'sleep 30'; then
      return 1
    fi
    is_decimal "${S2_PLANTED_RELEASE_PID}" && \
      [[ "${S2_PLANTED_RELEASE_PID}" == "${S2_PLANTED_RELEASE_PGID}" && \
        -n "${S2_PLANTED_RELEASE_MARKER}" ]] || return 1
    if kill -0 -- "-${S2_PLANTED_RELEASE_PGID}" 2>/dev/null; then return 1; fi
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"pass","scenario":"planted-child-exits-between-reproof-and-already-open-release-write-is-bounded","reproduce":"S2_SHELL_REGRESSION_TEST=release-race scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  if [[ "${mode}" == "release-interleaving" ]]; then
    status_file="${S2_STATE_DIR}/release-interleaving-$(random_hex 8).status"
    S2_PLANT_RELEASE_INTERLEAVING=1 \
      start_pinned_supervisor "${status_file}" release-interleaving "${S2_STATE_DIR}" "${S2_PORT}" client \
        bash -c 'exit 0' || {
        emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"fail","code":"S2_RELEASE_INTERLEAVING_START_FAILED","reproduce":"S2_SHELL_REGRESSION_TEST=release-interleaving scripts/e2e-s2-krater.sh"}'
        return 1
      }
    supervisor_pid="${S2_STARTED_PID}"
    supervisor_pgid="${S2_STARTED_PGID}"
    supervisor_marker="${S2_STARTED_MARKER}"
    supervisor_status="${S2_STARTED_STATUS_FILE}"
    supervisor_watchdog_pid="${S2_STARTED_WATCHDOG_PID}"
    supervisor_watchdog_health="${S2_STARTED_WATCHDOG_HEALTH}"
    deadline=$((SECONDS + S2_READY_DEADLINE_SECONDS))
    while ! read_child_status "${supervisor_status}"; do
      supervisor_is_owned "${supervisor_pid}" "${supervisor_pgid}" "${supervisor_marker}" || {
        emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"fail","code":"S2_RELEASE_INTERLEAVING_OWNERSHIP_LOST","reproduce":"S2_SHELL_REGRESSION_TEST=release-interleaving scripts/e2e-s2-krater.sh"}'
        return 1
      }
      (( SECONDS < deadline )) || {
        emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"fail","code":"S2_RELEASE_INTERLEAVING_STATUS_TIMEOUT","reproduce":"S2_SHELL_REGRESSION_TEST=release-interleaving scripts/e2e-s2-krater.sh"}'
        return 1
      }
      sleep 0.05
    done
    [[ "${S2_CHILD_STATUS}" == "0" ]] || {
      emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"fail","code":"S2_RELEASE_INTERLEAVING_CHILD_STATUS_INVALID","reproduce":"S2_SHELL_REGRESSION_TEST=release-interleaving scripts/e2e-s2-krater.sh"}'
      return 1
    }
    stop_pinned_supervisor "${supervisor_pid}" "${supervisor_pgid}" "${supervisor_marker}" \
      "${supervisor_watchdog_pid}" "${supervisor_watchdog_health}" \
      "${S2_STATE_DIR}" "${S2_PORT}" client || {
        emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"fail","code":"S2_RELEASE_INTERLEAVING_STOP_FAILED","reproduce":"S2_SHELL_REGRESSION_TEST=release-interleaving scripts/e2e-s2-krater.sh"}'
        return 1
      }
    if kill -0 -- "-${supervisor_pgid}" 2>/dev/null; then
      emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"fail","code":"S2_RELEASE_INTERLEAVING_SURVIVOR","reproduce":"S2_SHELL_REGRESSION_TEST=release-interleaving scripts/e2e-s2-krater.sh"}'
      return 1
    fi
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"pass","scenario":"release-written-at-watchdog-publication-crosses-continuously-open-supervisor-fd8","reproduce":"S2_SHELL_REGRESSION_TEST=release-interleaving scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  if [[ "${mode}" == "term-interrupt-cleanup-child" ]]; then
    interrupt_record="${S2_PARENT_INTERRUPT_RECORD:-}"
    interrupt_secret="${S2_PARENT_INTERRUPT_SECRET:-}"
    [[ -n "${interrupt_record}" && -n "${interrupt_secret}" && \
      ! -e "${interrupt_record}" && ! -L "${interrupt_record}" ]] || return 2
    status_file="${S2_STATE_DIR}/parent-term-control-$(random_hex 8).status"
    # This is the exact former orphan shape: the payload resists group TERM, its status/control
    # phase is observed, then the controlling parent receives TERM before it can assign the
    # start result to the Worker or lifecycle ownership tables.
    # shellcheck disable=SC2016
    S2_PLANT_WATCHDOG_EXIT_ON_TERM=1 \
      start_pinned_supervisor "${status_file}" parent-term-control "${S2_STATE_DIR}" "${S2_PORT}" client \
        bash -c 'trap "" TERM; deadline=$((SECONDS + 4)); while (( SECONDS < deadline )); do read -r -t 1 ignored || :; done' || return 1
    supervisor_pid="${S2_STARTED_PID}"
    supervisor_pgid="${S2_STARTED_PGID}"
    supervisor_marker="${S2_STARTED_MARKER}"
    supervisor_status="${S2_STARTED_STATUS_FILE}"
    supervisor_watchdog_pid="${S2_STARTED_WATCHDOG_PID}"
    supervisor_watchdog_health="${S2_STARTED_WATCHDOG_HEALTH}"
    deadline=$((SECONDS + S2_READY_DEADLINE_SECONDS))
    while :; do
      group_members "${supervisor_pgid}" || return 1
      [[ ${S2_GROUP_MEMBER_COUNT} -ge 3 ]] && break
      (( SECONDS < deadline )) || return 1
      sleep 0.05
    done
    signal_owned_group TERM "${supervisor_pid}" "${supervisor_pgid}" "${supervisor_marker}" || return 1
    deadline=$((SECONDS + S2_READY_DEADLINE_SECONDS))
    while :; do
      if read_child_status "${supervisor_status}" && [[ "${S2_CHILD_STATUS}" == "143" && \
        -p "${supervisor_status}.control" ]] && \
        supervisor_is_owned "${supervisor_pid}" "${supervisor_pgid}" "${supervisor_marker}"; then
        break
      fi
      (( SECONDS < deadline )) || return 1
      sleep 0.05
    done
    child_diagnostic="${S2_STATE_DIR}/parent-term-control-diagnostic-$(random_hex 8).json"
    [[ ! -e "${child_diagnostic}" && ! -L "${child_diagnostic}" ]] || return 1
    printf '%s\n' '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"interrupted","code":"S2_PARENT_TERM_AFTER_CONTROL","child_status":143,"exact_group":true}' >"${child_diagnostic}"
    printf '%s %s %s %s %s %s %s %s\n' \
      "${supervisor_pid}" "${supervisor_pgid}" "${supervisor_marker}" "${S2_STATE_DIR}" \
      "${S2_PORT}" "${S2_RUN_DIR}" "${supervisor_status}" "${child_diagnostic}" >"${interrupt_record}"
    # Invoke the ordinary TERM -> EXIT cleanup path. It must consume S2_MOST_RECENT_SUPERVISOR
    # before this caller can ever enroll it in a narrower owner slot.
    kill -TERM "$$"
    return 125
  fi

  if [[ "${mode}" == "term-interrupt-cleanup" ]]; then
    interrupt_record="${S2_STATE_DIR}/parent-term-control-record-$(random_hex 8)"
    interrupt_secret="s2-parent-term-secret-must-not-appear"
    env \
      S2_SHELL_REGRESSION_TEST=term-interrupt-cleanup-child \
      S2_PARENT_INTERRUPT_RECORD="${interrupt_record}" \
      S2_PARENT_INTERRUPT_SECRET="${interrupt_secret}" \
      bash "${BASH_SOURCE[0]}" >/dev/null 2>&1 &
    interrupt_child=$!
    if wait "${interrupt_child}" 2>/dev/null; then
      interrupt_status=0
    else
      interrupt_status=$?
    fi
    [[ ${interrupt_status} -eq 143 && -f "${interrupt_record}" && ! -L "${interrupt_record}" ]] || return 1
    read -r supervisor_pid supervisor_pgid supervisor_marker child_persist child_port child_run \
      child_status_file child_diagnostic <"${interrupt_record}" || return 1
    is_decimal "${supervisor_pid}" && is_decimal "${supervisor_pgid}" && is_decimal "${child_port}" && \
      [[ "${supervisor_pid}" == "${supervisor_pgid}" && -n "${supervisor_marker}" && \
      "${child_persist}" == "${child_run}/main" && -d "${child_persist}" && ! -L "${child_persist}" && \
      -f "${child_status_file}" && ! -L "${child_status_file}" && \
      -p "${child_status_file}.control" && -f "${child_diagnostic}" && ! -L "${child_diagnostic}" ]] || return 1
    [[ "$(<"${child_status_file}")" == "143" ]] || return 1
    deadline=$((SECONDS + S2_TERMINATE_WAIT_TICKS + 5))
    while kill -0 -- "-${supervisor_pgid}" 2>/dev/null; do
      (( SECONDS < deadline )) || return 1
      sleep 0.1
    done
    assert_no_run_survivors "${child_persist}" "${child_port}" "${supervisor_marker}" || return 1
    diagnostic_body="$(<"${child_diagnostic}")"
    manifest_body="$(<"${child_run}/manifest.json")"
    [[ "${diagnostic_body}" == *'"code":"S2_PARENT_TERM_AFTER_CONTROL"'* && \
      "${diagnostic_body}" == *'"child_status":143'* && \
      "${manifest_body}" == *'"exit_code":143'* && \
      "${diagnostic_body}" != *"${interrupt_secret}"* && \
      "${manifest_body}" != *"${interrupt_secret}"* ]] || return 1
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"pass","scenario":"term-interrupted-parent-after-term-resistant-payload-control-status-cleans-most-recent-untracked-exact-supervisor","reproduce":"S2_SHELL_REGRESSION_TEST=term-interrupt-cleanup scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  if [[ "${mode}" == "term-resistant-release" ]]; then
    status_file="${S2_STATE_DIR}/term-resistant-release-$(random_hex 8).status"
    # The child Bash, not this harness, must expand its SECONDS-based deadline.
    # shellcheck disable=SC2016
    S2_PLANT_WATCHDOG_EXIT_ON_TERM=1 \
      start_pinned_supervisor "${status_file}" term-resistant-release "${S2_STATE_DIR}" "${S2_PORT}" client \
        bash -c 'trap "" TERM; deadline=$((SECONDS + 4)); while (( SECONDS < deadline )); do read -r -t 1 ignored || :; done' || return 1
    supervisor_pid="${S2_STARTED_PID}"
    supervisor_pgid="${S2_STARTED_PGID}"
    supervisor_marker="${S2_STARTED_MARKER}"
    supervisor_watchdog_pid="${S2_STARTED_WATCHDOG_PID}"
    supervisor_watchdog_health="${S2_STARTED_WATCHDOG_HEALTH}"
    # This plant is leader + watchdog + TERM-resistant payload. The test watchdog exits on
    # group TERM, so the release branch must KILL the remaining exact leader/payload pair before
    # it releases the leader and loses the authority to clean up the payload. The payload has a
    # four-second self-expiry solely to prevent a deliberately failing old implementation from
    # leaving a test process behind after the regression reports failure.
    deadline=$((SECONDS + S2_READY_DEADLINE_SECONDS))
    while :; do
      group_members "${supervisor_pgid}" || return 1
      # The watchdog briefly runs `sleep`, so there may be a fourth process while it publishes.
      # At least three proves that the TERM-resistant payload has actually started.
      [[ ${S2_GROUP_MEMBER_COUNT} -ge 3 ]] && break
      (( SECONDS < deadline )) || return 1
      sleep 0.05
    done
    [[ ${S2_GROUP_MEMBER_COUNT} -ge 3 ]] || return 1
    stop_pinned_supervisor "${supervisor_pid}" "${supervisor_pgid}" "${supervisor_marker}" \
      "${supervisor_watchdog_pid}" "${supervisor_watchdog_health}" \
      "${S2_STATE_DIR}" "${S2_PORT}" client || return 1
    if kill -0 -- "-${supervisor_pgid}" 2>/dev/null; then return 1; fi
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"pass","scenario":"term-resistant-payload-after-watchdog-term-exit-is-killed-before-leader-release","reproduce":"S2_SHELL_REGRESSION_TEST=term-resistant-release scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  if [[ "${mode}" == "watchdog-self-retire" ]]; then
    status_file="${S2_STATE_DIR}/watchdog-self-retire-$(random_hex 8).status"
    if S2_PLANT_SUPERVISOR_EXIT_AFTER_WATCHDOG=1 \
      start_pinned_supervisor "${status_file}" watchdog-self-retire "${S2_STATE_DIR}" "${S2_PORT}" client \
        bash -c 'sleep 30'; then
      return 1
    fi
    deadline=$((SECONDS + S2_READY_DEADLINE_SECONDS + S2_WATCHDOG_MAX_UNCERTAIN_TICKS))
    is_decimal "${S2_LAST_SUPERVISOR_PGID}" || return 1
    while kill -0 -- "-${S2_LAST_SUPERVISOR_PGID}" 2>/dev/null; do
      (( SECONDS < deadline )) || return 1
      sleep 0.1
    done
    # No supervisor marker nor watchdog marker may outlive a supervisor that exited before
    # release. This exercises the bounded uncertain-inspection self-retirement branch.
    assert_no_run_survivors "${S2_STATE_DIR}" "${S2_PORT}" watchdog-self-retire || return 1
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"pass","scenario":"supervisor-exit125-leaves-no-bounded-uncertainty-watchdog-survivor","reproduce":"S2_SHELL_REGRESSION_TEST=watchdog-self-retire scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  if [[ "${mode}" == "journal-timestamps" ]]; then
    journal_valid="${S2_STATE_DIR}/journal-valid-$(random_hex 8).json"
    journal_alternate="${S2_STATE_DIR}/journal-alternate-$(random_hex 8).json"
    journal_invalid="${S2_STATE_DIR}/journal-invalid-$(random_hex 8).json"
    printf '%s\n' '[{"success":true,"results":[{"id":1,"name":"0001_krater_v0.sql","applied_at":"2026-08-14 09:25:35.123456"},{"id":2,"name":"0002_enrollment_g0.sql","applied_at":"2026-08-14 09:25:37"},{"id":3,"name":"0003_auth_nonce_replay.sql","applied_at":"2026-08-14 09:25:37"},{"id":4,"name":"0004_krater_integrity_v1.sql","applied_at":"2026-08-14 09:25:37"},{"id":5,"name":"0005_krater_undigested_index.sql","applied_at":"2026-08-14 09:25:37"}]}]' >"${journal_valid}"
    printf '%s\n' '[{"success":true,"results":[{"id":1,"name":"0001_krater_v0.sql","applied_at":"2026-08-14 10:25:35"},{"id":2,"name":"0002_enrollment_g0.sql","applied_at":"2026-08-14 10:25:37"},{"id":3,"name":"0003_auth_nonce_replay.sql","applied_at":"2026-08-14 10:25:37"},{"id":4,"name":"0004_krater_integrity_v1.sql","applied_at":"2026-08-14 10:25:37"},{"id":5,"name":"0005_krater_undigested_index.sql","applied_at":"2026-08-14 10:25:37"}]}]' >"${journal_alternate}"
    printf '%s\n' '[{"success":true,"results":[{"id":1,"name":"0001_krater_v0.sql","applied_at":"2026/08/14 09:25:35"},{"id":2,"name":"0002_enrollment_g0.sql","applied_at":"2026-08-14 09:25:37"},{"id":3,"name":"0003_auth_nonce_replay.sql","applied_at":"2026-08-14 09:25:37"},{"id":4,"name":"0004_krater_integrity_v1.sql","applied_at":"2026-08-14 09:25:37"},{"id":5,"name":"0005_krater_undigested_index.sql","applied_at":"2026-08-14 09:25:37"}]}]' >"${journal_invalid}"
    if valid_output="$(validate_current_migration_journal "${journal_valid}" journal-timestamp-valid)"; then :; else return 1; fi
    if alternate_output="$(validate_current_migration_journal "${journal_alternate}" journal-timestamp-alternate)"; then :; else return 1; fi
    if invalid_output="$(validate_current_migration_journal "${journal_invalid}" journal-timestamp-invalid)"; then return 1; fi
    [[ "${valid_output}" == *'"status":"pass"'* && \
      "${alternate_output}" == *'"status":"pass"'* && \
      "${invalid_output}" == *'"code":"S2_MIGRATION_JOURNAL_ENTRY_INVALID"'* ]] || return 1
    valid_digest="$(printf '%s\n' "${valid_output}" | sed -n 's/.*"journal_digest":"\([a-f0-9]*\)".*/\1/p')"
    alternate_digest="$(printf '%s\n' "${alternate_output}" | sed -n 's/.*"journal_digest":"\([a-f0-9]*\)".*/\1/p')"
    [[ "${valid_digest}" =~ ^[a-f0-9]{64}$ && "${valid_digest}" == "${alternate_digest}" ]] || return 1
    emit '{"tool":"bash+bun","package":"apps/wire","suite":"s2-krater-shell","status":"pass","scenario":"actual-journal-validator-accepts-d1-timestamp-refuses-malformed-and-digests-only-identity","reproduce":"S2_SHELL_REGRESSION_TEST=journal-timestamps scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  if [[ "${mode}" == "lsof-scan-failure" ]]; then
    lsof() {
      local arg
      for arg in "$@"; do
        [[ "${arg}" == "-p" ]] && { printf 'p%s\n' "$$"; return 0; }
      done
      return 1
    }
    # lsof's no-match result is precisely exit 1 with no output; accept that narrow case only.
    lsof_scan_has_no_matches -nP +D "${S2_STATE_DIR}" || return 1
    [[ "${S2_LSOF_LAST_STATUS}" == "1" && -z "${S2_LSOF_LAST_OUTPUT}" ]] || return 1
    lsof() {
      local arg
      for arg in "$@"; do
        [[ "${arg}" == "-p" ]] && { printf 'p%s\n' "$$"; return 0; }
      done
      printf '%s\n' 'planted lsof scanner failure' >&2
      return 2
    }
    if assert_no_run_survivors "${S2_STATE_DIR}" "${S2_PORT}" planted-lsof-scan; then return 1; fi
    [[ "${S2_LSOF_LAST_STATUS}" == "2" && \
      "${S2_LSOF_LAST_OUTPUT}" == *'planted lsof scanner failure'* ]] || return 1
    lsof() { printf '%s\n' 'planted lsof health failure' >&2; return 2; }
    if lsof_scanner_is_healthy; then return 1; fi
    [[ "${S2_LSOF_LAST_STATUS}" == "2" && \
      "${S2_LSOF_LAST_OUTPUT}" == *'planted lsof health failure'* ]] || return 1
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"pass","scenario":"lsof-empty-no-match-is-distinct-from-captured-scan-and-health-failure","reproduce":"S2_SHELL_REGRESSION_TEST=lsof-scan-failure scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  if [[ "${mode}" == "legacy-cleanup-failure" ]]; then
    S2_ACTIVE_ORIGIN="http://127.0.0.1:1"
    S2_PLANT_STOP_WORKER_FAILURE=1
    S2_PLANT_STOP_WORKER_MUTATED_ORIGIN="http://127.0.0.1:2"
    if stop_legacy_worker_or_fail; then
      return 1
    else
      cleanup_status=$?
    fi
    unset S2_PLANT_STOP_WORKER_FAILURE S2_PLANT_STOP_WORKER_MUTATED_ORIGIN
    [[ ${cleanup_status} -eq 1 && "${S2_ACTIVE_ORIGIN}" == "http://127.0.0.1:2" ]] || return 1
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"pass","scenario":"raw-legacy-cleanup-failure-propagates-and-preserves-observable-in-process-origin-mutation","reproduce":"S2_SHELL_REGRESSION_TEST=legacy-cleanup-failure scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  if [[ "${mode}" == "legacy-leader-loss" ]]; then
    status_file="${S2_STATE_DIR}/legacy-leader-loss-$(random_hex 8).status"
    # The child Bash, not this harness, must expand its SECONDS-based deadline.
    # shellcheck disable=SC2016
    S2_PLANT_SUPERVISOR_EXIT_ON_TERM=1 \
      start_pinned_supervisor "${status_file}" legacy-leader-loss "${S2_STATE_DIR}" "${S2_PORT}" server \
        bash -c 'trap "" TERM; deadline=$((SECONDS + 4)); while (( SECONDS < deadline )); do read -r -t 1 ignored || :; done' || return 1
    S2_SERVER_PID="${S2_STARTED_PID}"
    S2_SERVER_PGID="${S2_STARTED_PGID}"
    S2_SERVER_MARKER="${S2_STARTED_MARKER}"
    S2_SERVER_WATCHDOG_PID="${S2_STARTED_WATCHDOG_PID}"
    S2_SERVER_WATCHDOG_HEALTH="${S2_STARTED_WATCHDOG_HEALTH}"
    S2_SERVER_PERSIST="${S2_STATE_DIR}"
    S2_SERVER_PORT="${S2_PORT}"
    S2_ACTIVE_ORIGIN="http://127.0.0.1:1"
    deadline=$((SECONDS + S2_READY_DEADLINE_SECONDS))
    while :; do
      group_members "${S2_SERVER_PGID}" || return 1
      [[ ${S2_GROUP_MEMBER_COUNT} -ge 3 ]] && break
      (( SECONDS < deadline )) || return 1
      sleep 0.05
    done
    if stop_legacy_worker_or_fail; then
      stop_status=0
    else
      stop_status=$?
    fi
    [[ ${stop_status} -eq 1 && "${S2_ACTIVE_ORIGIN}" == "http://127.0.0.1:1" && \
      -z "${S2_SERVER_PID}" ]] || return 1
    if kill -0 -- "-${S2_STARTED_PGID}" 2>/dev/null; then return 1; fi
    assert_no_run_survivors "${S2_STATE_DIR}" "${S2_PORT}" legacy-leader-loss || return 1
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"pass","scenario":"legacy-term-leader-loss-bounds-inspection-publishes-uncertainty-and-kills-only-exact-residual-group","reproduce":"S2_SHELL_REGRESSION_TEST=legacy-leader-loss scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  if [[ "${mode}" == "watchdog-uncertainty" ]]; then
    status_file="${S2_STATE_DIR}/watchdog-uncertainty-$(random_hex 8).status"
    S2_PLANT_WATCHDOG_INSPECTION_UNCERTAIN=1 \
      start_pinned_supervisor "${status_file}" watchdog-uncertainty "${S2_STATE_DIR}" "${S2_PORT}" client \
        bash -c 'sleep 30' || return 1
    supervisor_pid="${S2_STARTED_PID}"
    supervisor_pgid="${S2_STARTED_PGID}"
    supervisor_marker="${S2_STARTED_MARKER}"
    supervisor_watchdog_pid="${S2_STARTED_WATCHDOG_PID}"
    supervisor_watchdog_health="${S2_STARTED_WATCHDOG_HEALTH}"
    deadline=$((SECONDS + S2_READY_DEADLINE_SECONDS))
    while (( SECONDS < deadline )); do
      read -r watchdog_state watchdog_health_pid < <(tail -n 1 "${supervisor_watchdog_health}") || return 1
      if [[ "${watchdog_state}" == "inspection-uncertain" && \
        "${watchdog_health_pid}" == "${supervisor_watchdog_pid}" ]]; then
        break
      fi
      sleep 0.05
    done
    [[ "${watchdog_state}" == "inspection-uncertain" ]] || return 1
    if stop_pinned_supervisor "${supervisor_pid}" "${supervisor_pgid}" "${supervisor_marker}" \
      "${supervisor_watchdog_pid}" "${supervisor_watchdog_health}" \
      "${S2_STATE_DIR}" "${S2_PORT}" client; then
      stop_status=0
    else
      stop_status=$?
    fi
    [[ ${stop_status} -eq 1 ]] || return 1
    if kill -0 -- "-${supervisor_pgid}" 2>/dev/null; then return 1; fi
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"pass","scenario":"planted-watchdog-inspection-uncertainty-is-observable-fails-closed-and-leaves-zero-survivors","reproduce":"S2_SHELL_REGRESSION_TEST=watchdog-uncertainty scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  if [[ "${mode}" == "unowned-refusal" ]]; then
    # Plant a missing identity proof. `signal_owned_group` must refuse before it attempts even
    # the otherwise harmless test-double kill, so a recycled PID/PGID can never be signalled.
    supervisor_is_owned() { return 1; }
    kill() { signal_called=$((signal_called + 1)); return 0; }
    if signal_owned_group TERM 4242 4242 planted-unowned; then
      emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"fail","code":"S2_UNOWNED_GROUP_SIGNALLED","reproduce":"S2_SHELL_REGRESSION_TEST=unowned-refusal scripts/e2e-s2-krater.sh"}'
      return 1
    fi
    if [[ ${signal_called} -ne 0 ]]; then
      emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"fail","code":"S2_UNOWNED_GROUP_KILL_ATTEMPTED","reproduce":"S2_SHELL_REGRESSION_TEST=unowned-refusal scripts/e2e-s2-krater.sh"}'
      return 1
    fi
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"pass","scenario":"planted-unowned-or-uninspectable-group-refuses-before-signal","reproduce":"S2_SHELL_REGRESSION_TEST=unowned-refusal scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  if [[ "${mode}" == "pinned-supervisor" ]]; then
    status_file="${S2_STATE_DIR}/shell-pinned-$(random_hex 8).status"
    start_pinned_supervisor "${status_file}" shell-pinned "${S2_STATE_DIR}" "${S2_PORT}" client \
      bash -c 'exit 0' || return 1
    supervisor_pid="${S2_STARTED_PID}"
    supervisor_pgid="${S2_STARTED_PGID}"
    supervisor_marker="${S2_STARTED_MARKER}"
    supervisor_status="${S2_STARTED_STATUS_FILE}"
    supervisor_watchdog_pid="${S2_STARTED_WATCHDOG_PID}"
    supervisor_watchdog_health="${S2_STARTED_WATCHDOG_HEALTH}"
    deadline=$((SECONDS + S2_READY_DEADLINE_SECONDS))
    while ! read_child_status "${supervisor_status}"; do
      supervisor_is_owned "${supervisor_pid}" "${supervisor_pgid}" "${supervisor_marker}" || return 1
      (( SECONDS < deadline )) || return 1
      sleep 0.05
    done
    [[ "${S2_CHILD_STATUS}" == "0" ]] || return 1
    supervisor_is_owned "${supervisor_pid}" "${supervisor_pgid}" "${supervisor_marker}" || return 1
    group_members "${supervisor_pgid}" || return 1
    # The controller is holding a live supervisor plus its parent-loss watchdog. The stop path
    # must TERM that owned group, observe the watchdog leave, then release the final leader.
    [[ ${S2_GROUP_MEMBER_COUNT} -ge 2 ]] || return 1
    stop_pinned_supervisor "${supervisor_pid}" "${supervisor_pgid}" "${supervisor_marker}" \
      "${supervisor_watchdog_pid}" "${supervisor_watchdog_health}" \
      "${S2_STATE_DIR}" "${S2_PORT}" client || return 1
    if kill -0 -- "-${supervisor_pgid}" 2>/dev/null; then return 1; fi
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"pass","scenario":"planted-stopped-before-exec-pinned-supervisor-records-exit-and-releases-owned-empty-group","reproduce":"S2_SHELL_REGRESSION_TEST=pinned-supervisor scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  if [[ "${mode}" == "redaction" ]]; then
    redaction_log="${S2_STATE_DIR}/planted-redaction-$(random_hex 8).log"
    {
      printf '%s\n' \
        'Authorization: Bearer S2BearerSecretValue0123456789' \
        '{"token":"S2JsonTokenValue0123456789","signature":"S2SignatureValue0123456789","fragment":"#v1.S2FragmentSecretValue0123456789"}' \
        'token=S2PartialTokenValue0123456789 signature S2PartialSignature0123456789'
      # Put this bearer value across the final 2K clipping boundary. If clipping happened first,
      # the surviving token suffix would no longer be preceded by `Bearer` and would leak.
      printf '%*s' 1000 '' | tr ' ' x
      printf ' '
      printf '%s' 'Bearer S2BoundaryBearerSecret0123456789'
      printf '%*s\n' 1965 '' | tr ' ' x
    } >"${redaction_log}"
    redaction_cause="$(redacted_wrangler_cause "${redaction_log}")"
    for source_path in \
      S2BearerSecretValue0123456789 \
      S2JsonTokenValue0123456789 \
      S2SignatureValue0123456789 \
      S2FragmentSecretValue0123456789 \
      S2PartialTokenValue0123456789 \
      S2PartialSignature0123456789 \
      S2BoundaryBearerSecret0123456789; do
      [[ "${redaction_cause}" != *"${source_path}"* ]] || return 1
    done
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"pass","scenario":"planted-bearer-json-fragment-and-partial-log-secrets-redacted-before-clipping","reproduce":"S2_SHELL_REGRESSION_TEST=redaction scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  if [[ "${mode}" == "provenance" ]]; then
    for source_path in \
      apps/wire/src/krater/wrangler.s2-legacy.toml \
      apps/wire/src/krater/wrangler.s2-upgrade.toml \
      apps/wire/src/krater/fixtures/legacy-existing-event.sql \
      apps/wire/src/krater/fixtures/legacy-migrations/0001_krater_v0.sql; do
      [[ " ${S2_SOURCE_PATHS[*]} " == *" ${source_path} "* ]] || return 1
    done
    assert_legacy_fixture_bytes || return 1
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"pass","scenario":"legacy-config-fixture-and-exact-0001-are-in-provenance-and-dirty-inputs","reproduce":"S2_SHELL_REGRESSION_TEST=provenance scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  [[ "${mode}" == "indexed-phase-status" ]] || return 2

  # This deliberately never starts a Wrangler dev server. It plants the exact indexed-phase
  # failure that used to be inverted by `if ! run_phase`; both helper boundaries must preserve
  # exit 91.
  run_phase() { return 91; }
  emit_legacy_failure() { emitted_phase="$1"; }
  if run_legacy_phase "upgrade-indexed" "/dev/null"; then
    phase_status=0
  else
    phase_status=$?
  fi
  if [[ ${phase_status} -ne 91 || "${emitted_phase}" != "upgrade-indexed" ]]; then
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"fail","code":"S2_INDEXED_FAILURE_STATUS_MASKED","reproduce":"S2_SHELL_REGRESSION_TEST=indexed-phase-status scripts/e2e-s2-krater.sh"}'
    return 1
  fi

  run_legacy_upgrade() { return "${phase_status}"; }
  if run_legacy_upgrade_checked "upgrade-existing" "" "upgrade-indexed"; then
    upgrade_status=0
  else
    upgrade_status=$?
  fi
  if [[ ${upgrade_status} -ne 91 ]]; then
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"fail","code":"S2_UPGRADE_FAILURE_STATUS_MASKED","reproduce":"S2_SHELL_REGRESSION_TEST=indexed-phase-status scripts/e2e-s2-krater.sh"}'
    return 1
  fi
  emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"pass","scenario":"planted-indexed-phase-failure-preserves-nonzero-status","reproduce":"S2_SHELL_REGRESSION_TEST=indexed-phase-status scripts/e2e-s2-krater.sh"}'
}

if [[ "${S2_SHELL_REGRESSION_TEST:-none}" != "none" ]]; then
  run_s2_shell_regression_test "${S2_SHELL_REGRESSION_TEST}"
  exit $?
fi

launch_lifecycle_child() {
  local port="$1" log="$2" interrupt_after_ready="$3" state_dir="$4" ready_file
  ready_file="${state_dir}/ready-${port}-$(random_hex 8)"
  start_pinned_supervisor "${state_dir}/child-${port}-$(random_hex 8).status" "lifecycle-${port}" \
    "${state_dir}" "${port}" client \
    env \
      S2_PORT="${port}" \
      S2_LIFECYCLE_TEST="none" \
      S2_INTERRUPT_AFTER_READY="${interrupt_after_ready}" \
      S2_LIFECYCLE_READY_FILE="${ready_file}" \
      bash "${BASH_SOURCE[0]}" >"${log}" 2>&1 || return 1
  S2_LIFECYCLE_CHILD_PID="${S2_STARTED_PID}"
  S2_LIFECYCLE_CHILD_PGID="${S2_STARTED_PGID}"
  S2_LIFECYCLE_CHILD_MARKER="${S2_STARTED_MARKER}"
  S2_LIFECYCLE_CHILD_STATUS_FILE="${S2_STARTED_STATUS_FILE}"
  S2_LIFECYCLE_CHILD_WATCHDOG_PID="${S2_STARTED_WATCHDOG_PID}"
  S2_LIFECYCLE_CHILD_WATCHDOG_HEALTH="${S2_STARTED_WATCHDOG_HEALTH}"
  S2_LIFECYCLE_READY_FILE="${ready_file}"
  remember_lifecycle_supervisor \
    "${S2_LIFECYCLE_CHILD_PID}" \
    "${S2_LIFECYCLE_CHILD_PGID}" \
    "${S2_LIFECYCLE_CHILD_MARKER}" \
    "${S2_LIFECYCLE_CHILD_STATUS_FILE}" \
    "${S2_LIFECYCLE_CHILD_WATCHDOG_PID}" \
    "${S2_LIFECYCLE_CHILD_WATCHDOG_HEALTH}" \
    "${state_dir}" \
    "${port}"
  clear_most_recent_supervisor_if_pid "${S2_LIFECYCLE_CHILD_PID}"
}

wait_for_lifecycle_port() {
  local port="$1" pid="$2" pgid="$3" marker="$4" ready_file="$5" ready_id
  local deadline=$((SECONDS + S2_READY_DEADLINE_SECONDS))
  while (( SECONDS < deadline )); do
    supervisor_is_owned "${pid}" "${pgid}" "${marker}" || return 1
    if [[ -f "${ready_file}" && ! -L "${ready_file}" ]] && \
      IFS= read -r ready_id <"${ready_file}" && \
      [[ "${ready_id}" =~ ^[a-f0-9]{32}$ ]] && port_is_busy "${port}"; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

wait_for_lifecycle_child() {
  local pid="$1" pgid="$2" marker="$3" status_file="$4" watchdog_pid="$5"
  local watchdog_health="$6" state_dir="$7" port="$8" tick
  local deadline=$((SECONDS + S2_LIFECYCLE_DEADLINE_SECONDS))
  while :; do
    if read_child_status "${status_file}"; then
      stop_pinned_supervisor "${pid}" "${pgid}" "${marker}" \
        "${watchdog_pid}" "${watchdog_health}" "${state_dir}" "${port}" client || return 125
      forget_lifecycle_supervisor "${pid}" || return 125
      return "${S2_CHILD_STATUS}"
    fi
    supervisor_is_owned "${pid}" "${pgid}" "${marker}" || return 125
    if (( SECONDS >= deadline )); then
      signal_owned_group TERM "${pid}" "${pgid}" "${marker}" || return 125
      for ((tick = 0; tick < S2_TERMINATE_WAIT_TICKS; tick += 1)); do
        if read_child_status "${status_file}"; then
          stop_pinned_supervisor "${pid}" "${pgid}" "${marker}" \
            "${watchdog_pid}" "${watchdog_health}" "${state_dir}" "${port}" client || return 125
          return "${S2_CHILD_STATUS}"
        fi
        supervisor_is_owned "${pid}" "${pgid}" "${marker}" || return 125
        sleep 0.1
      done
      stop_pinned_supervisor "${pid}" "${pgid}" "${marker}" \
        "${watchdog_pid}" "${watchdog_health}" "${state_dir}" "${port}" client || return 125
      return 124
    fi
    sleep 0.1
  done
}

run_lifecycle_self_test() {
  local mode="$1" state_dir first_port second_port first_pid second_pid first_pgid second_pgid
  local first_marker second_marker first_status_file second_status_file first_ready_file second_ready_file
  local first_watchdog_pid second_watchdog_pid first_watchdog_health second_watchdog_health
  local first_status second_status
  state_dir="$(create_evidence_subdir lifecycle)"
  if [[ ! -d "${state_dir}" || -L "${state_dir}" ]]; then
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-lifecycle","status":"fail","code":"S2_LIFECYCLE_PERSIST_DIR_INVALID","reproduce":"S2_LIFECYCLE_TEST=parallel scripts/e2e-s2-krater.sh"}'
    return 1
  fi
  if ! first_port="$(choose_available_port)"; then
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-lifecycle","status":"fail","code":"S2_LIFECYCLE_PORT_UNAVAILABLE","reproduce":"S2_LIFECYCLE_TEST=parallel scripts/e2e-s2-krater.sh"}'
    return 1
  fi

  if [[ "${mode}" == "parallel" ]]; then
    launch_lifecycle_child "${first_port}" "${state_dir}/parallel-one.log" 0 "${state_dir}"
    first_pid="${S2_LIFECYCLE_CHILD_PID}"
    first_pgid="${S2_LIFECYCLE_CHILD_PGID}"
    first_marker="${S2_LIFECYCLE_CHILD_MARKER}"
    first_status_file="${S2_LIFECYCLE_CHILD_STATUS_FILE}"
    first_watchdog_pid="${S2_LIFECYCLE_CHILD_WATCHDOG_PID}"
    first_watchdog_health="${S2_LIFECYCLE_CHILD_WATCHDOG_HEALTH}"
    first_ready_file="${S2_LIFECYCLE_READY_FILE}"
    if ! wait_for_lifecycle_port "${first_port}" "${first_pid}" "${first_pgid}" \
      "${first_marker}" "${first_ready_file}"; then
      wait_for_lifecycle_child "${first_pid}" "${first_pgid}" \
        "${first_marker}" "${first_status_file}" "${first_watchdog_pid}" \
        "${first_watchdog_health}" "${state_dir}" "${first_port}" || :
      emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-lifecycle","status":"fail","code":"S2_PARALLEL_FIRST_NOT_READY","reproduce":"S2_LIFECYCLE_TEST=parallel scripts/e2e-s2-krater.sh"}'
      return 1
    fi
    if ! second_port="$(choose_available_port)"; then
      wait_for_lifecycle_child "${first_pid}" "${first_pgid}" \
        "${first_marker}" "${first_status_file}" "${first_watchdog_pid}" \
        "${first_watchdog_health}" "${state_dir}" "${first_port}" || :
      emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-lifecycle","status":"fail","code":"S2_PARALLEL_SECOND_PORT_UNAVAILABLE","reproduce":"S2_LIFECYCLE_TEST=parallel scripts/e2e-s2-krater.sh"}'
      return 1
    fi
    launch_lifecycle_child "${second_port}" "${state_dir}/parallel-two.log" 0 "${state_dir}"
    second_pid="${S2_LIFECYCLE_CHILD_PID}"
    second_pgid="${S2_LIFECYCLE_CHILD_PGID}"
    second_marker="${S2_LIFECYCLE_CHILD_MARKER}"
    second_status_file="${S2_LIFECYCLE_CHILD_STATUS_FILE}"
    second_watchdog_pid="${S2_LIFECYCLE_CHILD_WATCHDOG_PID}"
    second_watchdog_health="${S2_LIFECYCLE_CHILD_WATCHDOG_HEALTH}"
    second_ready_file="${S2_LIFECYCLE_READY_FILE}"
    if ! wait_for_lifecycle_port "${second_port}" "${second_pid}" "${second_pgid}" \
      "${second_marker}" "${second_ready_file}"; then
      wait_for_lifecycle_child "${first_pid}" "${first_pgid}" \
        "${first_marker}" "${first_status_file}" "${first_watchdog_pid}" \
        "${first_watchdog_health}" "${state_dir}" "${first_port}" || :
      wait_for_lifecycle_child "${second_pid}" "${second_pgid}" \
        "${second_marker}" "${second_status_file}" "${second_watchdog_pid}" \
        "${second_watchdog_health}" "${state_dir}" "${second_port}" || :
      emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-lifecycle","status":"fail","code":"S2_PARALLEL_SECOND_NOT_READY","reproduce":"S2_LIFECYCLE_TEST=parallel scripts/e2e-s2-krater.sh"}'
      return 1
    fi
    # Each child is self-contained: the recorded status comes from its own pinned supervisor,
    # while this parent retains and proves the outer lifecycle supervisor before releasing it.
    if wait_for_lifecycle_child "${first_pid}" "${first_pgid}" \
      "${first_marker}" "${first_status_file}" "${first_watchdog_pid}" \
      "${first_watchdog_health}" "${state_dir}" "${first_port}"; then first_status=0; else first_status=$?; fi
    if wait_for_lifecycle_child "${second_pid}" "${second_pgid}" \
      "${second_marker}" "${second_status_file}" "${second_watchdog_pid}" \
      "${second_watchdog_health}" "${state_dir}" "${second_port}"; then second_status=0; else second_status=$?; fi
    if [[ ${first_status} -ne 78 || ${second_status} -ne 78 ]] || \
      port_is_busy "${first_port}" || port_is_busy "${second_port}"; then
      emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-lifecycle","status":"fail","code":"S2_PARALLEL_ISOLATION_FAILED","reproduce":"S2_LIFECYCLE_TEST=parallel scripts/e2e-s2-krater.sh"}'
      return 1
    fi
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-lifecycle","status":"pass","scenario":"two-concurrent-local-workerd-runs-use-isolated-main-and-inspector-ports","reproduce":"S2_LIFECYCLE_TEST=parallel scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  if [[ "${mode}" == "sigterm" ]]; then
    launch_lifecycle_child "${first_port}" "${state_dir}/sigterm.log" 0 "${state_dir}"
    first_pid="${S2_LIFECYCLE_CHILD_PID}"
    first_pgid="${S2_LIFECYCLE_CHILD_PGID}"
    first_marker="${S2_LIFECYCLE_CHILD_MARKER}"
    first_status_file="${S2_LIFECYCLE_CHILD_STATUS_FILE}"
    first_watchdog_pid="${S2_LIFECYCLE_CHILD_WATCHDOG_PID}"
    first_watchdog_health="${S2_LIFECYCLE_CHILD_WATCHDOG_HEALTH}"
    first_ready_file="${S2_LIFECYCLE_READY_FILE}"
    if ! wait_for_lifecycle_port "${first_port}" "${first_pid}" "${first_pgid}" \
      "${first_marker}" "${first_ready_file}"; then
      wait_for_lifecycle_child "${first_pid}" "${first_pgid}" \
        "${first_marker}" "${first_status_file}" "${first_watchdog_pid}" \
        "${first_watchdog_health}" "${state_dir}" "${first_port}" || :
      emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-lifecycle","status":"fail","code":"S2_SIGTERM_FIXTURE_NOT_READY","reproduce":"S2_LIFECYCLE_TEST=sigterm scripts/e2e-s2-krater.sh"}'
      return 1
    fi
    # The parent has just proved the outer supervisor, the randomized readiness response, and
    # the owned listener. Signal only that exact live group; the nested script receives TERM,
    # runs its EXIT cleanup, and records 143 for the still-pinned outer supervisor to release.
    if ! signal_owned_group TERM "${first_pid}" "${first_pgid}" "${first_marker}"; then
      emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-lifecycle","status":"fail","code":"S2_SIGTERM_OWNERSHIP_UNPROVEN","reproduce":"S2_LIFECYCLE_TEST=sigterm scripts/e2e-s2-krater.sh"}'
      return 1
    fi
    if wait_for_lifecycle_child "${first_pid}" "${first_pgid}" \
      "${first_marker}" "${first_status_file}" "${first_watchdog_pid}" \
      "${first_watchdog_health}" "${state_dir}" "${first_port}"; then first_status=0; else first_status=$?; fi
    if [[ ${first_status} -ne 143 ]] || port_is_busy "${first_port}"; then
      emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-lifecycle","status":"fail","code":"S2_SIGTERM_SURVIVOR","reproduce":"S2_LIFECYCLE_TEST=sigterm scripts/e2e-s2-krater.sh"}'
      return 1
    fi
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-lifecycle","status":"pass","scenario":"planted-sigterm-leaves-no-wrangler-or-workerd-listener","reproduce":"S2_LIFECYCLE_TEST=sigterm scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-lifecycle","status":"fail","code":"S2_LIFECYCLE_TEST_INVALID","reproduce":"S2_LIFECYCLE_TEST=parallel scripts/e2e-s2-krater.sh"}'
  return 1
}

if [[ "${S2_LIFECYCLE_TEST:-none}" == "parallel" || "${S2_LIFECYCLE_TEST:-none}" == "sigterm" ]]; then
  run_lifecycle_self_test "${S2_LIFECYCLE_TEST}"
  exit $?
fi

if ! assert_legacy_fixture_bytes; then
  exit 1
fi

if ! "${S2_WRANGLER}" d1 migrations apply DB --config "${S2_WRANGLER_CONFIG}" --local --persist-to "${S2_STATE_DIR}" >"${S2_STATE_DIR}/migration.log" 2>&1; then
  emit_wrangler_failure "LOCAL_D1_MIGRATION_FAILED"
  exit 1
fi

if ! start_worker; then
  emit_wrangler_failure "LOCAL_WORKER_UNAVAILABLE"
  exit 1
fi

if [[ -n "${S2_LIFECYCLE_READY_FILE:-}" ]]; then
  if [[ -e "${S2_LIFECYCLE_READY_FILE}" || -L "${S2_LIFECYCLE_READY_FILE}" ]]; then
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-lifecycle","status":"fail","code":"S2_LIFECYCLE_READY_FILE_UNSAFE","reproduce":"S2_LIFECYCLE_TEST=parallel scripts/e2e-s2-krater.sh"}'
    exit 1
  fi
  printf '%s\n' "${S2_ACTIVE_HARNESS_RUN_ID}" >"${S2_LIFECYCLE_READY_FILE}"
fi

if [[ "${S2_INTERRUPT_AFTER_READY:-0}" == "1" ]]; then
  emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-local-do","status":"interrupted","code":"S2_PLANTED_INTERRUPTED_RUN","reproduce":"S2_INTERRUPT_AFTER_READY=1 scripts/e2e-s2-krater.sh"}'
  kill -TERM "$$"
fi

if run_phase "exercise"; then
  :
else
  S2_CLIENT_EXIT=$?
  stop_worker
  emit_wrangler_failure "LOCAL_D1_SCENARIO_FAILED"
  exit "${S2_CLIENT_EXIT}"
fi

stop_worker

if ! start_worker; then
  emit_wrangler_failure "LOCAL_WORKER_RESTART_UNAVAILABLE"
  exit 1
fi
if run_phase "restart-verify"; then
  :
else
  S2_CLIENT_EXIT=$?
  stop_worker
  emit_wrangler_failure "LOCAL_D1_RESTART_SCENARIO_FAILED"
  exit "${S2_CLIENT_EXIT}"
fi
stop_worker

# ── the upgrade path, on real old databases ──────────────────────────────────
# These run after the primary proof and before the blocked records, because a
# broken upgrade must fail the run rather than be reported alongside a green
# local proof. Each owns its own port and persistence directory.
if run_legacy_upgrade_checked "upgrade-existing" "${S2_LEGACY_EXISTING_FIXTURE}" "upgrade-indexed"; then
  :
else
  S2_CLIENT_EXIT=$?
  exit "${S2_CLIENT_EXIT}"
fi
if run_legacy_upgrade_checked "upgrade-empty" ""; then
  :
else
  S2_CLIENT_EXIT=$?
  exit "${S2_CLIENT_EXIT}"
fi

# This is distinct from the raw 0004/0005 schema lane above: it begins at the exact 0001
# fixture and proves the current repository migration journal can advance it in place.
if run_migration_journal_upgrade "upgrade-journal-existing" "${S2_LEGACY_EXISTING_FIXTURE}"; then
  :
else
  S2_CLIENT_EXIT=$?
  exit "${S2_CLIENT_EXIT}"
fi
if run_migration_journal_upgrade "upgrade-journal-empty" ""; then
  :
else
  S2_CLIENT_EXIT=$?
  exit "${S2_CLIENT_EXIT}"
fi

emit "{\"tool\":\"wrangler\",\"tool_version\":\"${S2_WRANGLER_VERSION}\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-local-do-alarm\",\"status\":\"pass\",\"bindings\":{\"d1\":\"DB\",\"durable_object\":\"KRATER_OUTBOX\"},\"reproduce\":\"scripts/e2e-s2-krater.sh\"}"
emit "{\"tool\":\"wrangler\",\"tool_version\":\"${S2_WRANGLER_VERSION}\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-deployed-do\",\"status\":\"blocked\",\"exit_code\":78,\"code\":\"DEPLOYED_DO_ENVIRONMENT_ABSENT\",\"blocked_on\":\"a deployed Worker with a configured Durable Object namespace and alarm telemetry\",\"forbidden_substitutes\":\"local-workerd behavior presented as deployed Durable Object proof\",\"reproduce\":\"scripts/e2e-s2-krater.sh\"}"
emit "{\"tool\":\"wrangler\",\"tool_version\":\"${S2_WRANGLER_VERSION}\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-edge-load\",\"status\":\"blocked\",\"exit_code\":78,\"code\":\"EDGE_CACHE_ENVIRONMENT_ABSENT\",\"blocked_on\":\"a staging edge-cache environment with D1 row-read and Worker CPU telemetry\",\"forbidden_substitutes\":\"a local curl loop, an in-process handler benchmark, or local-workerd timing presented as edge-load proof\",\"reproduce\":\"scripts/e2e-s2-krater.sh\"}"
exit 78
