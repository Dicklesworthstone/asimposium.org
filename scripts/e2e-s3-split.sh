#!/usr/bin/env bash
#
# S-3 local binding gate. The positive phase starts a real local workerd with
# Wrangler's D1 and R2 bindings, writes a private workshop spill, reads it
# back only through its D1-bound private route, and renders public faces from
# D1 events. It intentionally leaves its unique workerd state directory
# behind; no test cleanup deletes data.
#
# The final staging record remains blocked with exit 78. Local proof cannot
# establish production routes, Propylon/OAuth identity, a paired browser view,
# or a deployed R2 namespace.

set -u -o pipefail
# shellcheck disable=SC2016 # Embedded child programs expand only inside their child shells.

readonly BLOCKED_EXIT=78
readonly REPRODUCE="bash scripts/e2e-s3-split.sh"
readonly WRANGLER="apps/wire/node_modules/.bin/wrangler"
readonly CONFIG="apps/wire/src/split/wrangler.s3.toml"
readonly ENTRYPOINT="apps/wire/src/split/local-worker.ts"
readonly CHECKER="apps/wire/src/split/local-check.ts"
readonly STARTED_SECONDS="${SECONDS}"
readonly CHECKER_DEADLINE_SECONDS=90

emit() {
  printf '%s\n' "$1"
}

json_string() {
  S3_JSON_VALUE="$1" bun --eval 'process.stdout.write(JSON.stringify(process.env.S3_JSON_VALUE));'
}

duration_ms() {
  printf '%s' "$(( (SECONDS - STARTED_SECONDS) * 1000 ))"
}

is_retained_signal_status() {
  [[ "$1" == "129" || "$1" == "130" || "$1" == "143" ]]
}

mint_hex_token() {
  local byte_count="$1"
  [[ "${byte_count}" =~ ^([1-9]|[1-9][0-9]|1[0-2][0-8])$ ]] || return 1
  S3_TOKEN_BYTE_COUNT="${byte_count}" bun --eval '
    const byteCount = Number(process.env.S3_TOKEN_BYTE_COUNT);
    if (!Number.isSafeInteger(byteCount) || byteCount < 1 || byteCount > 128) process.exit(1);
    const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
    console.log(Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(""));
  '
}

allocate_port() {
  bun --eval 'const server = Bun.serve({ port: 0, fetch() { return new Response("ready"); } }); console.log(server.port); server.stop(true);'
}

port_is_busy() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && exec 3<&- && return 0
  return 1
}

if [[ -n "${S3_PORT:-}" ]]; then
  if ! [[ "${S3_PORT}" =~ ^[0-9]{2,5}$ ]] || (( S3_PORT < 1024 || S3_PORT > 65535 )); then
    emit '{"tool":"bash","package":"@asimposium/wire","suite":"s3-local-bindings","status":"fail","code":"S3_PORT_INVALID","reproduce":"bash scripts/e2e-s3-split.sh"}'
    exit 1
  fi
else
  S3_PORT="$(allocate_port)"
fi
readonly S3_PORT
readonly ORIGIN="http://127.0.0.1:${S3_PORT}"
S3_RUN_TOKEN="$(mint_hex_token 32)" || {
  emit '{"tool":"bash","package":"@asimposium/wire","suite":"s3-local-bindings","status":"fail","code":"S3_AUTHORITY_TOKEN_UNAVAILABLE","reproduce":"bash scripts/e2e-s3-split.sh"}'
  exit 1
}
S3_READINESS_NONCE="s3-ready-$(mint_hex_token 16)" || {
  emit '{"tool":"bash","package":"@asimposium/wire","suite":"s3-local-bindings","status":"fail","code":"S3_READINESS_NONCE_UNAVAILABLE","reproduce":"bash scripts/e2e-s3-split.sh"}'
  exit 1
}
if ! [[ "${S3_RUN_TOKEN}" =~ ^[a-f0-9]{64}$ && "${S3_READINESS_NONCE}" =~ ^s3-ready-[a-f0-9]{32}$ ]]; then
  emit '{"tool":"bash","package":"@asimposium/wire","suite":"s3-local-bindings","status":"fail","code":"S3_LOCAL_TOKEN_FORMAT_INVALID","reproduce":"bash scripts/e2e-s3-split.sh"}'
  exit 1
fi
readonly S3_RUN_TOKEN S3_READINESS_NONCE

if port_is_busy "${S3_PORT}"; then
  emit '{"tool":"bash","package":"@asimposium/wire","suite":"s3-local-bindings","status":"fail","code":"S3_PORT_OCCUPIED","reproduce":"bash scripts/e2e-s3-split.sh"}'
  exit 1
fi

if [[ ! -x "${WRANGLER}" ]]; then
  emit '{"tool":"wrangler","package":"@asimposium/wire","suite":"s3-local-bindings","status":"fail","code":"WRANGLER_UNAVAILABLE","reproduce":"bash scripts/e2e-s3-split.sh"}'
  exit 1
fi
WRANGLER_VERSION="$("${WRANGLER}" --version)"
readonly WRANGLER_VERSION
WRANGLER_VERSION_JSON="$(json_string "${WRANGLER_VERSION}")" || {
  emit '{"tool":"bash","package":"@asimposium/wire","suite":"s3-local-bindings","status":"fail","code":"WRANGLER_VERSION_ENCODING_FAILED","reproduce":"bash scripts/e2e-s3-split.sh"}'
  exit 1
}
readonly WRANGLER_VERSION_JSON

STATE_DIR="$(mktemp -d -t asimposium-s3-local)"
readonly STATE_DIR
readonly SERVER_LOG="${STATE_DIR}/wrangler.log"
readonly CHECK_LOG="${STATE_DIR}/check.log"
readonly TERM_RESISTANT_STATE_FILE="${STATE_DIR}/term-resistant-held-open"
readonly CHECKER_RESISTANT_STATE_FILE="${STATE_DIR}/checker-resistant-held-open"
if [[ ! -d "${STATE_DIR}" || -L "${STATE_DIR}" ]]; then
  emit '{"tool":"bash","package":"@asimposium/wire","suite":"s3-local-bindings","status":"fail","code":"LOCAL_PERSIST_DIR_INVALID","reproduce":"bash scripts/e2e-s3-split.sh"}'
  exit 1
fi

SERVER_SUPERVISOR_PID=""
SERVER_PGID=""
SERVER_SUPERVISOR_STARTED_AT=""
SERVER_SUPERVISOR_TOKEN=""
SERVER_PAYLOAD_PID=""
SERVER_PAYLOAD_PID_FILE=""
SERVER_PAYLOAD_STATUS_FILE=""
SERVER_SUPERVISOR_REAPED=0
CLEANUP_PENDING_PGID=""
CHECKER_SUPERVISOR_PID=""
CHECKER_PGID=""
CHECKER_SUPERVISOR_STARTED_AT=""
CHECKER_SUPERVISOR_TOKEN=""
CHECKER_PAYLOAD_PID=""
CHECKER_PAYLOAD_PID_FILE=""
CHECKER_PAYLOAD_STATUS_FILE=""
CHECKER_SUPERVISOR_REAPED=0
CHECKER_CLEANUP_PENDING_PGID=""
CHECKER_RESOURCE_PORT=""
CONTROLLER_PGID=""
SUPERVISOR_PID=""
SUPERVISOR_PGID=""
SUPERVISOR_STARTED_AT=""
SUPERVISOR_TOKEN=""
SUPERVISOR_PAYLOAD_PID_FILE=""
SUPERVISOR_PAYLOAD_STATUS_FILE=""
SUPERVISOR_DIRECT_CHILD=0
SUPERVISOR_READY=0
STARTUP_SIGNAL_STATUS=0
STARTUP_SIGNAL_NAME=""
TEST_STARTUP_SIGNAL_WINDOW=""
TEST_STARTUP_SIGNAL_TRIGGERED=0
TEST_DISPATCH_STARTUP_SIGNAL_OWNER=""
TEST_GROUP_INSPECTION_FAILURES_REMAINING=0
TEST_REPEAT_SIGNAL_DURING_CLEANUP=0
TEST_REPEATED_SIGNALS_SENT=0
TEST_EXPECT_PAYLOAD_LEADER_EXIT=0
TEST_PAYLOAD_LEADER_EXIT_OBSERVED=0
TEST_KILLED_SUPERVISOR_REAPED_BEFORE_SCAN=0
TEST_POST_REAP_GROUP_INSPECTION_FAILURES_REMAINING=0
TEST_POST_REAP_GROUP_INSPECTION_FAILURE_OBSERVED=0
TEST_POST_REAP_INSPECTION_ONLY_RETRY_OBSERVED=0
TEST_POST_REAP_SIGNAL_ATTEMPTS=0
REAPED_GROUP_MEMBERS=""
TEST_IDENTITY_RECOVERY=0
TEST_IDENTITY_REAL_STARTED_AT=""
TEST_IDENTITY_REAL_TOKEN=""
TEST_PROVISIONAL_REAL_STARTED_AT=""
TEST_PROVISIONAL_REAL_TOKEN=""
TEST_PROVISIONAL_RECOVERY=0
TEST_EXACT_CHECK_FAILURES_REMAINING=0
TEST_STATE_HOLDER_RELEASE_AFTER_BROAD_PID=""
TEST_STATE_HOLDER_RELEASE_AFTER_BROAD_FILE=""
TEST_STATE_HOLDER_RELEASED_AFTER_BROAD_FILE=""
TEST_STATE_HOLDER_BROAD_ERROR_PLANT=""
CLEANUP_ATTEMPTS_USED=0
SERVER_SUPERVISOR_LIFECYCLE_STATUS="not_started"
SERVER_PAYLOAD_LIFECYCLE_STATUS="not_started"
CHECKER_SUPERVISOR_LIFECYCLE_STATUS="not_started"
CHECKER_PAYLOAD_LIFECYCLE_STATUS="not_started"
readonly CLEANUP_TERM_ATTEMPTS=30
readonly CLEANUP_KILL_ATTEMPTS=20
readonly CLEANUP_RETRY_ATTEMPTS=2
readonly DIRECT_IDENTITY_ATTEMPTS=20

process_group_of() {
  local pid="$1" pgid status
  [[ "${pid}" =~ ^[0-9]+$ ]] || return 2
  pgid="$(ps -o pgid= -p "${pid}" 2>/dev/null)"
  status=$?
  (( status == 0 )) || return 2
  pgid="${pgid//[[:space:]]/}"
  [[ "${pgid}" =~ ^[0-9]+$ ]] || return 2
  printf '%s\n' "${pgid}"
}

mint_supervisor_token() {
  bun --eval 'console.log(crypto.randomUUID().replace(/-/g, ""));'
}

supervisor_identity_is_exact() {
  local pid="$1" pgid="$2" started_at="$3" token="$4"
  local observed_pid observed_pgid observed_started observed_command status
  [[ "${pid}" =~ ^[0-9]+$ && "${pgid}" =~ ^[0-9]+$ ]] || return 1
  [[ -n "${started_at}" && "${token}" =~ ^[A-Za-z0-9]{32}$ ]] || return 1
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
  [[ "${observed_command}" == *"s3-pinned-supervisor:${token}"* ]]
}

supervisor_direct_child_is_exact() {
  local pid="$1" started_at="$2" token="$3"
  local observed_pid observed_started observed_command status
  [[ "${pid}" =~ ^[0-9]+$ && -n "${started_at}" ]] || return 1
  [[ "${token}" =~ ^[A-Za-z0-9]{32}$ ]] || return 1
  if (( TEST_EXACT_CHECK_FAILURES_REMAINING > 0 )); then
    TEST_EXACT_CHECK_FAILURES_REMAINING=$((TEST_EXACT_CHECK_FAILURES_REMAINING - 1))
    return 1
  fi
  observed_pid="$(ps -o pid= -p "${pid}" 2>/dev/null)"; status=$?
  (( status == 0 )) || return 1
  observed_started="$(ps -o lstart= -p "${pid}" 2>/dev/null)"; status=$?
  (( status == 0 )) || return 1
  observed_command="$(ps -ww -o command= -p "${pid}" 2>/dev/null)"; status=$?
  (( status == 0 )) || return 1
  observed_pid="${observed_pid//[[:space:]]/}"
  [[ "${observed_pid}" == "${pid}" ]] || return 1
  [[ "${observed_started}" == "${started_at}" ]] || return 1
  [[ "${observed_command}" == *"s3-pinned-supervisor:${token}"* ]]
}

pin_provisional_supervisor_identity() {
  local observed_started observed_command status
  (( SUPERVISOR_DIRECT_CHILD == 1 )) || return 1
  [[ "${SUPERVISOR_PID}" =~ ^[0-9]+$ ]] || return 1
  [[ "${SUPERVISOR_TOKEN}" =~ ^[A-Za-z0-9]{32}$ ]] || return 1
  for _attempt in $(seq 1 "${DIRECT_IDENTITY_ATTEMPTS}"); do
    observed_started="$(ps -o lstart= -p "${SUPERVISOR_PID}" 2>/dev/null)"; status=$?
    (( status == 0 )) || { sleep 0.05; continue; }
    observed_command="$(ps -ww -o command= -p "${SUPERVISOR_PID}" 2>/dev/null)"; status=$?
    (( status == 0 )) || { sleep 0.05; continue; }
    if [[ -n "${observed_started}" && \
      "${observed_command}" == *"s3-pinned-supervisor:${SUPERVISOR_TOKEN}"* ]]; then
      if [[ -z "${SUPERVISOR_STARTED_AT}" ]]; then
        SUPERVISOR_STARTED_AT="${observed_started}"
      fi
      supervisor_direct_child_is_exact \
        "${SUPERVISOR_PID}" "${SUPERVISOR_STARTED_AT}" "${SUPERVISOR_TOKEN}" && return 0
      return 1
    fi
    sleep 0.05
  done
  return 1
}

signal_exact_direct_supervisor() {
  local signal="$1" pid="$2" started_at="$3" token="$4"
  supervisor_direct_child_is_exact "${pid}" "${started_at}" "${token}" || return 1
  kill -"${signal}" "${pid}" 2>/dev/null
}

signal_exact_group() {
  local signal="$1" pid="$2" pgid="$3" started_at="$4" token="$5"
  # Once an owned supervisor has been killed and reaped, its remembered PGID is
  # observation state only. It is no longer a live identity anchor that can
  # authorize another group signal, even if a retry reaches this helper.
  if { (( SERVER_SUPERVISOR_REAPED == 1 )) && [[ "${pid}" == "${SERVER_SUPERVISOR_PID}" && "${pgid}" == "${SERVER_PGID}" ]]; } || \
    { (( CHECKER_SUPERVISOR_REAPED == 1 )) && [[ "${pid}" == "${CHECKER_SUPERVISOR_PID}" && "${pgid}" == "${CHECKER_PGID}" ]]; }; then
    TEST_POST_REAP_SIGNAL_ATTEMPTS=$((TEST_POST_REAP_SIGNAL_ATTEMPTS + 1))
    return 1
  fi
  supervisor_identity_is_exact "${pid}" "${pgid}" "${started_at}" "${token}" || return 1
  kill -"${signal}" -- "-${pgid}" 2>/dev/null
}

signal_exact_group_supervisor() {
  local signal="$1" pid="$2" pgid="$3" started_at="$4" token="$5"
  supervisor_identity_is_exact "${pid}" "${pgid}" "${started_at}" "${token}" || return 1
  kill -"${signal}" "${pid}" 2>/dev/null
}

wait_supports_full_completion() {
  LC_ALL=C help wait 2>/dev/null | LC_ALL=C grep -Eq '^wait: wait \[-[^]]*f'
}

wait_for_killed_direct_child_reap() {
  local pid="$1" state status wait_status
  [[ "${pid}" =~ ^[0-9]+$ ]] || return 1
  # `wait` is a reap only after the kernel has observed death. In particular,
  # plain `wait PID` can return for a stopped job on Bash versions without -f.
  # Polling first also keeps this cleanup bounded if an assumed SIGKILL ever did
  # not terminate the exact direct child.
  for _wait in $(seq 1 "${CLEANUP_KILL_ATTEMPTS}"); do
    state="$(ps -o stat= -p "${pid}" 2>/dev/null)"; status=$?
    if (( status == 1 )) && [[ -z "${state}" ]]; then
      :
    elif (( status != 0 )); then
      return 1
    elif [[ "${state}" != *Z* ]]; then
      sleep 0.05
      continue
    fi
    if wait_supports_full_completion; then
      if wait -f "${pid}" 2>/dev/null; then wait_status=0; else wait_status=$?; fi
    else
      if wait "${pid}" 2>/dev/null; then wait_status=0; else wait_status=$?; fi
    fi
    (( wait_status != 127 ))
    return
  done
  return 1
}

clear_supervisor_scratch() {
  SUPERVISOR_PID=""
  SUPERVISOR_PGID=""
  SUPERVISOR_STARTED_AT=""
  SUPERVISOR_TOKEN=""
  SUPERVISOR_PAYLOAD_PID_FILE=""
  SUPERVISOR_PAYLOAD_STATUS_FILE=""
  SUPERVISOR_DIRECT_CHILD=0
  SUPERVISOR_READY=0
}

reap_provisional_supervisor() {
  local pid="${SUPERVISOR_PID}"
  (( SUPERVISOR_DIRECT_CHILD == 1 )) || return 0
  [[ "${pid}" =~ ^[0-9]+$ ]] || return 1
  # An unreaped child relationship is not identity authority: the numeric PID
  # can be stale or planted. Unknown or mismatched marker+lstart retains these
  # ownership fields for the next bounded cleanup attempt and sends no signal.
  pin_provisional_supervisor_identity || return 1
  signal_exact_direct_supervisor KILL \
    "${pid}" "${SUPERVISOR_STARTED_AT}" "${SUPERVISOR_TOKEN}" || return 1
  wait_for_killed_direct_child_reap "${pid}" || return 1
  clear_supervisor_scratch
}

# shellcheck disable=SC2329 # Runtime traps invoke this signal deferral handler.
remember_startup_signal() {
  local status="$1" name="$2"
  if (( STARTUP_SIGNAL_STATUS == 0 )); then
    STARTUP_SIGNAL_STATUS="${status}"
    STARTUP_SIGNAL_NAME="${name}"
  fi
}

begin_startup_ownership_transition() {
  STARTUP_SIGNAL_STATUS=0
  STARTUP_SIGNAL_NAME=""
  trap 'remember_startup_signal 129 HUP' HUP
  trap 'remember_startup_signal 130 INT' INT
  trap 'remember_startup_signal 143 TERM' TERM
}

install_runtime_signal_traps() {
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
}

plant_startup_window_signal() {
  local window="$1"
  [[ "${TEST_STARTUP_SIGNAL_WINDOW}" == "${window}" ]] || return 0
  TEST_STARTUP_SIGNAL_TRIGGERED=1
  kill -HUP "${BASHPID:-$$}" 2>/dev/null
}

launch_pinned_supervisor() {
  local log_file="$1"
  shift
  local deadline state status
  (( SUPERVISOR_DIRECT_CHILD == 0 )) || return 1
  [[ -z "${SUPERVISOR_PID}" ]] || return 1
  SUPERVISOR_TOKEN="$(mint_supervisor_token)" || SUPERVISOR_TOKEN=""
  [[ "${SUPERVISOR_TOKEN}" =~ ^[A-Za-z0-9]{32}$ ]] || return 1
  SUPERVISOR_PAYLOAD_PID_FILE="${STATE_DIR}/supervisor-${SUPERVISOR_TOKEN}.payload-pid"
  SUPERVISOR_PAYLOAD_STATUS_FILE="${STATE_DIR}/supervisor-${SUPERVISOR_TOKEN}.status"

  # The direct child stops before it can execute the payload. Only after the
  # controller pins pid + pgid + lstart + the random argv marker is it resumed.
  # After its payload leader exits, it records that fact and remains stopped in
  # the same group so a later escalation still has an exact live identity.
  set -m
  bash -c '
    token="$1"
    payload_pid_file="$2"
    payload_status_file="$3"
    shift 3
    kill -STOP "$$"
    set +m
    trap ":" TERM INT HUP
    trap "exit 0" USR1
    "$@" &
    child="$!"
    printf "%s\\n" "${child}" >"${payload_pid_file}"
    child_status=0
    while kill -0 "${child}" 2>/dev/null; do
      if wait "${child}"; then child_status=0; else child_status=$?; fi
    done
    printf "payload_exited:%s:%s\\n" "${child}" "${child_status}" >"${payload_status_file}"
    while :; do kill -STOP "$$"; done
  ' "s3-pinned-supervisor:${SUPERVISOR_TOKEN}" "${SUPERVISOR_TOKEN}" \
    "${SUPERVISOR_PAYLOAD_PID_FILE}" "${SUPERVISOR_PAYLOAD_STATUS_FILE}" "$@" \
    >>"${log_file}" 2>&1 &
  plant_startup_window_signal background_spawn
  SUPERVISOR_PID=$!
  SUPERVISOR_DIRECT_CHILD=1
  plant_startup_window_signal scratch_assignment
  set +m

  pin_provisional_supervisor_identity || return 1
  SUPERVISOR_PGID="$(process_group_of "${SUPERVISOR_PID}")"; status=$?
  if (( status != 0 )) || [[ "${SUPERVISOR_PID}" != "${SUPERVISOR_PGID}" ]] || \
    [[ "${SUPERVISOR_PGID}" == "${CONTROLLER_PGID}" ]]; then
    reap_provisional_supervisor || return 1
    return 1
  fi

  deadline=$((SECONDS + 10))
  while (( SECONDS < deadline )); do
    state="$(ps -o stat= -p "${SUPERVISOR_PID}" 2>/dev/null)"; status=$?
    if (( status == 0 )) && [[ "${state}" == *T* ]] && \
      supervisor_identity_is_exact "${SUPERVISOR_PID}" "${SUPERVISOR_PGID}" \
        "${SUPERVISOR_STARTED_AT}" "${SUPERVISOR_TOKEN}" && \
      [[ ! -e "${SUPERVISOR_PAYLOAD_PID_FILE}" && ! -e "${SUPERVISOR_PAYLOAD_STATUS_FILE}" ]]; then
      SUPERVISOR_READY=1
      plant_startup_window_signal stop_proof
      return 0
    fi
    ps -o pid= -p "${SUPERVISOR_PID}" >/dev/null 2>&1 || break
    sleep 0.05
  done
  return 1
}

adopt_supervisor() {
  local owner="$1"
  (( SUPERVISOR_READY == 1 && SUPERVISOR_DIRECT_CHILD == 1 )) || return 1
  case "${owner}" in
    server)
      [[ -z "${SERVER_SUPERVISOR_PID}" ]] || return 1
      SERVER_SUPERVISOR_PID="${SUPERVISOR_PID}"
      SERVER_PGID="${SUPERVISOR_PGID}"
      SERVER_SUPERVISOR_STARTED_AT="${SUPERVISOR_STARTED_AT}"
      SERVER_SUPERVISOR_TOKEN="${SUPERVISOR_TOKEN}"
      SERVER_PAYLOAD_PID_FILE="${SUPERVISOR_PAYLOAD_PID_FILE}"
      SERVER_PAYLOAD_STATUS_FILE="${SUPERVISOR_PAYLOAD_STATUS_FILE}"
      SERVER_SUPERVISOR_REAPED=0
      CLEANUP_PENDING_PGID="${SERVER_PGID}"
      ;;
    checker)
      [[ -z "${CHECKER_SUPERVISOR_PID}" ]] || return 1
      CHECKER_SUPERVISOR_PID="${SUPERVISOR_PID}"
      CHECKER_PGID="${SUPERVISOR_PGID}"
      CHECKER_SUPERVISOR_STARTED_AT="${SUPERVISOR_STARTED_AT}"
      CHECKER_SUPERVISOR_TOKEN="${SUPERVISOR_TOKEN}"
      CHECKER_PAYLOAD_PID_FILE="${SUPERVISOR_PAYLOAD_PID_FILE}"
      CHECKER_PAYLOAD_STATUS_FILE="${SUPERVISOR_PAYLOAD_STATUS_FILE}"
      CHECKER_SUPERVISOR_REAPED=0
      CHECKER_CLEANUP_PENDING_PGID="${CHECKER_PGID}"
      ;;
    *) return 1 ;;
  esac
  clear_supervisor_scratch
  plant_startup_window_signal adoption
}

resume_pinned_supervisor() {
  local owner="$1" pid pgid started_at token payload_pid_file payload_status_file
  local deadline payload_pid payload_pgid status
  case "${owner}" in
    server)
      pid="${SERVER_SUPERVISOR_PID}"; pgid="${SERVER_PGID}"
      started_at="${SERVER_SUPERVISOR_STARTED_AT}"; token="${SERVER_SUPERVISOR_TOKEN}"
      payload_pid_file="${SERVER_PAYLOAD_PID_FILE}"; payload_status_file="${SERVER_PAYLOAD_STATUS_FILE}"
      ;;
    checker)
      pid="${CHECKER_SUPERVISOR_PID}"; pgid="${CHECKER_PGID}"
      started_at="${CHECKER_SUPERVISOR_STARTED_AT}"; token="${CHECKER_SUPERVISOR_TOKEN}"
      payload_pid_file="${CHECKER_PAYLOAD_PID_FILE}"; payload_status_file="${CHECKER_PAYLOAD_STATUS_FILE}"
      ;;
    *) return 1 ;;
  esac
  [[ ! -e "${payload_pid_file}" && ! -e "${payload_status_file}" ]] || return 1
  signal_exact_group_supervisor CONT "${pid}" "${pgid}" "${started_at}" "${token}" || return 1
  plant_startup_window_signal cont_release
  deadline=$((SECONDS + 10))
  while (( SECONDS < deadline )); do
    if [[ -f "${payload_pid_file}" ]]; then
      IFS= read -r payload_pid <"${payload_pid_file}" || return 1
      [[ "${payload_pid}" =~ ^[0-9]+$ ]] || return 1
      payload_pgid="$(process_group_of "${payload_pid}")"; status=$?
      (( status == 0 )) && [[ "${payload_pgid}" == "${pgid}" ]] || return 1
      if [[ "${owner}" == "server" ]]; then SERVER_PAYLOAD_PID="${payload_pid}"; else CHECKER_PAYLOAD_PID="${payload_pid}"; fi
      return 0
    fi
    supervisor_identity_is_exact "${pid}" "${pgid}" "${started_at}" "${token}" || return 1
    sleep 0.05
  done
  return 1
}

start_supervised_payload() {
  local owner="$1" log_file="$2" launch_status=0
  shift 2
  begin_startup_ownership_transition
  launch_pinned_supervisor "${log_file}" "$@" || launch_status=$?
  if (( launch_status == 0 )); then adopt_supervisor "${owner}" || launch_status=$?; fi
  if (( launch_status == 0 )); then resume_pinned_supervisor "${owner}" || launch_status=$?; fi
  plant_startup_window_signal return
  if [[ "${TEST_DISPATCH_STARTUP_SIGNAL_OWNER}" == "${owner}" ]]; then
    TEST_STARTUP_SIGNAL_TRIGGERED=1
    kill -HUP "${BASHPID:-$$}" 2>/dev/null || return 1
  fi
  install_runtime_signal_traps
  if (( STARTUP_SIGNAL_STATUS != 0 )); then return "${STARTUP_SIGNAL_STATUS}"; fi
  return "${launch_status}"
}

# A blank answer means the kernel and a complete, parsable process table agree
# that the group is gone. An unreadable or partial table is never an empty group.
group_members() {
  local pgid="$1" table row members status
  [[ "${pgid}" =~ ^[0-9]+$ ]] || return 2
  table="$(ps -eo pid=,pgid= 2>/dev/null)"
  status=$?
  (( status == 0 )) || return 2
  [[ -n "${table}" ]] || return 2
  while IFS= read -r row; do
    [[ -z "${row//[[:space:]]/}" ]] && continue
    [[ "${row}" =~ ^[[:space:]]*[0-9]+[[:space:]]+[0-9]+[[:space:]]*$ ]] || return 2
  done <<<"${table}"
  members="$(printf '%s\n' "${table}" | awk -v group="${pgid}" '$2 == group { print $1 }')"
  if [[ -n "${members}" ]]; then
    printf '%s\n' "${members}"
    return 0
  fi
  # `ps` can be syntactically valid but omit the whole worker group. Ask the
  # kernel independently before accepting the table's zero as a real zero.
  if kill -0 -- "-${pgid}" 2>/dev/null; then return 2; fi
  return 0
}

listener_pids() {
  local port="$1" pids pid status
  command -v lsof >/dev/null 2>&1 || return 2
  pids="$(lsof -ti "tcp:${port}" 2>/dev/null)"
  status=$?
  if (( status > 1 )) || { (( status == 1 )) && [[ -n "${pids}" ]]; }; then return 2; fi
  while IFS= read -r pid; do
    [[ -z "${pid}" ]] && continue
    [[ "${pid}" =~ ^[0-9]+$ ]] || return 2
  done <<<"${pids}"
  if [[ -n "${pids}" ]]; then printf '%s\n' "${pids}"; fi
  return 0
}

listener_pids_are_in_group() {
  local port="$1" expected_pgid="$2" pids pid observed_pgid status
  [[ "${expected_pgid}" =~ ^[0-9]+$ ]] || return 1
  pids="$(listener_pids "${port}")"; status=$?
  (( status == 0 )) || return 1
  [[ -n "${pids}" ]] || return 1
  while IFS= read -r pid; do
    [[ -z "${pid}" ]] && continue
    observed_pgid="$(process_group_of "${pid}")"; status=$?
    (( status == 0 && observed_pgid == expected_pgid )) || return 1
  done <<<"${pids}"
}

state_holder_pids() {
  local pids pid status rechecked recheck_status confirmed="" released_line=""
  local -a candidates=()
  command -v lsof >/dev/null 2>&1 || return 2
  case "${TEST_STATE_HOLDER_BROAD_ERROR_PLANT}" in
    "") pids="$(lsof -nP -t +w +D "${STATE_DIR}" 2>&1)"; status=$? ;;
    warning) pids="planted lsof traversal warning"; status=1 ;;
    malformed) pids="not-a-pid"; status=0 ;;
    *) return 2 ;;
  esac
  # macOS lsof may return 1 while still printing numeric matches when warnings
  # are enabled. Numeric-only output is therefore a candidate set for either
  # documented status; only status 1 with empty output proves no match.
  if (( status == 1 )) && [[ -z "${pids}" ]]; then return 0; fi
  (( status == 0 || status == 1 )) && [[ -n "${pids}" ]] || return 2
  while IFS= read -r pid; do
    [[ -z "${pid}" ]] && continue
    [[ "${pid}" =~ ^[0-9]+$ ]] || return 2
    candidates+=("${pid}")
  done <<<"${pids}"
  (( ${#candidates[@]} > 0 )) || return 2

  if [[ -n "${TEST_STATE_HOLDER_RELEASE_AFTER_BROAD_PID}" ]]; then
    [[ "${TEST_STATE_HOLDER_RELEASE_AFTER_BROAD_PID}" =~ ^[0-9]+$ && \
      " ${candidates[*]} " == *" ${TEST_STATE_HOLDER_RELEASE_AFTER_BROAD_PID} "* && \
      -n "${TEST_STATE_HOLDER_RELEASE_AFTER_BROAD_FILE}" && \
      -n "${TEST_STATE_HOLDER_RELEASED_AFTER_BROAD_FILE}" && \
      ! -e "${TEST_STATE_HOLDER_RELEASE_AFTER_BROAD_FILE}" && \
      ! -L "${TEST_STATE_HOLDER_RELEASE_AFTER_BROAD_FILE}" ]] || return 2
    (umask 077; set -o noclobber; \
      printf 'release %s\n' "${TEST_STATE_HOLDER_RELEASE_AFTER_BROAD_PID}" \
        >"${TEST_STATE_HOLDER_RELEASE_AFTER_BROAD_FILE}") 2>/dev/null || return 2
    for _ in $(seq 1 100); do
      if [[ -f "${TEST_STATE_HOLDER_RELEASED_AFTER_BROAD_FILE}" && \
        ! -L "${TEST_STATE_HOLDER_RELEASED_AFTER_BROAD_FILE}" ]]; then
        {
          IFS= read -r released_line || released_line=""
          if IFS= read -r _; then released_line=""; fi
        } <"${TEST_STATE_HOLDER_RELEASED_AFTER_BROAD_FILE}"
        [[ "${released_line}" == \
          "released ${TEST_STATE_HOLDER_RELEASE_AFTER_BROAD_PID}" ]] && break
      fi
      sleep 0.05
    done
    [[ "${released_line}" == \
      "released ${TEST_STATE_HOLDER_RELEASE_AFTER_BROAD_PID}" ]] || return 2
  elif [[ -n "${TEST_STATE_HOLDER_RELEASE_AFTER_BROAD_FILE}" || \
    -n "${TEST_STATE_HOLDER_RELEASED_AFTER_BROAD_FILE}" ]]; then
    return 2
  fi

  for pid in "${candidates[@]}"; do
    rechecked="$(lsof -nP -t +w -a -p "${pid}" +D "${STATE_DIR}" 2>&1)"
    recheck_status=$?
    if (( recheck_status == 1 )) && [[ -z "${rechecked}" ]]; then
      continue
    fi
    (( recheck_status == 0 || recheck_status == 1 )) && \
      [[ "${rechecked}" == "${pid}" ]] || return 2
    confirmed="${confirmed}${confirmed:+$'\n'}${pid}"
  done
  if [[ -n "${confirmed}" ]]; then printf '%s\n' "${confirmed}"; fi
  return 0
}

fixture_state_holder_pids() {
  local pids pid status
  command -v lsof >/dev/null 2>&1 || return 2
  pids="$(lsof -t -- "${TERM_RESISTANT_STATE_FILE}" 2>/dev/null)"
  status=$?
  if (( status > 1 )) || { (( status == 1 )) && [[ -n "${pids}" ]]; }; then return 2; fi
  while IFS= read -r pid; do
    [[ -z "${pid}" ]] && continue
    [[ "${pid}" =~ ^[0-9]+$ ]] || return 2
  done <<<"${pids}"
  if [[ -n "${pids}" ]]; then printf '%s\n' "${pids}"; fi
  return 0
}

checker_state_holder_pids() {
  local pids pid status path
  command -v lsof >/dev/null 2>&1 || return 2
  pids=""
  for path in "${CHECK_LOG}" "${CHECKER_RESISTANT_STATE_FILE}"; do
    [[ -e "${path}" ]] || continue
    local observed
    observed="$(lsof -t -- "${path}" 2>/dev/null)"
    status=$?
    if (( status > 1 )) || { (( status == 1 )) && [[ -n "${observed}" ]]; }; then return 2; fi
    if [[ -n "${observed}" ]]; then pids="${pids}${pids:+$'\n'}${observed}"; fi
  done
  while IFS= read -r pid; do
    [[ -z "${pid}" ]] && continue
    [[ "${pid}" =~ ^[0-9]+$ ]] || return 2
  done <<<"${pids}"
  if [[ -n "${pids}" ]]; then printf '%s\n' "${pids}" | sort -u; fi
  return 0
}

port_accepts_bind() {
  local port="$1"
  S3_BIND_PORT="${port}" bun --eval '
    const port = Number(process.env.S3_BIND_PORT);
    if (!Number.isSafeInteger(port)) process.exit(1);
    const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response() });
    server.stop(true);
  ' >/dev/null 2>&1
}

assert_group_empty() {
  local pgid="$1" members status
  members="$(group_members "${pgid}")"
  status=$?
  (( status == 0 )) || return 1
  [[ -z "${members}" ]]
}

assert_listener_empty() {
  local listeners status
  listeners="$(listener_pids "${S3_PORT}")"
  status=$?
  (( status == 0 )) || return 1
  [[ -z "${listeners}" ]] || return 1
  port_accepts_bind "${S3_PORT}"
}

assert_state_holders_empty() {
  local holders status
  holders="$(state_holder_pids)"
  status=$?
  (( status == 0 )) || return 1
  [[ -z "${holders}" ]]
}

assert_checker_listener_empty() {
  local listeners status
  [[ "${CHECKER_RESOURCE_PORT}" =~ ^[0-9]+$ ]] || return 0
  listeners="$(listener_pids "${CHECKER_RESOURCE_PORT}")"
  status=$?
  (( status == 0 )) || return 1
  [[ -z "${listeners}" ]] || return 1
  port_accepts_bind "${CHECKER_RESOURCE_PORT}"
}

assert_checker_state_holders_empty() {
  local holders status
  holders="$(checker_state_holder_pids)"
  status=$?
  (( status == 0 )) || return 1
  [[ -z "${holders}" ]]
}

assert_no_survivors() {
  local pgid="$1"
  assert_group_empty "${pgid}" || return 1
  assert_listener_empty || return 1
  assert_state_holders_empty
}

supervisor_reports_payload_exit() {
  local payload_pid="$1" status_line
  supervisor_identity_is_exact "${SERVER_SUPERVISOR_PID}" "${SERVER_PGID}" \
    "${SERVER_SUPERVISOR_STARTED_AT}" "${SERVER_SUPERVISOR_TOKEN}" || return 1
  [[ -f "${SERVER_PAYLOAD_STATUS_FILE}" ]] || return 1
  IFS= read -r status_line <"${SERVER_PAYLOAD_STATUS_FILE}" || return 1
  [[ "${status_line}" == "payload_exited:${payload_pid}:"* ]]
}

# Parse the real process table before applying the one planted failure seam.
# Output travels through a parent-shell global so the countdown and observation
# markers cannot disappear inside command substitution.
inspect_reaped_group_members() {
  local pgid="$1" parsed status
  REAPED_GROUP_MEMBERS=""
  parsed="$(group_members "${pgid}")"; status=$?
  (( status == 0 )) || return "${status}"
  REAPED_GROUP_MEMBERS="${parsed}"
  if (( TEST_POST_REAP_GROUP_INSPECTION_FAILURES_REMAINING > 0 )); then
    TEST_POST_REAP_GROUP_INSPECTION_FAILURES_REMAINING=$((TEST_POST_REAP_GROUP_INSPECTION_FAILURES_REMAINING - 1))
    TEST_POST_REAP_GROUP_INSPECTION_FAILURE_OBSERVED=1
    return 1
  fi
}

# SIGKILL has already been delivered while the exact supervisor was live, and
# that direct child has been reaped. A retry may only inspect the remembered
# group until it is empty; it must never signal a bare, recyclable PGID.
wait_for_reaped_group_empty() {
  local pgid="$1" status
  if (( TEST_POST_REAP_GROUP_INSPECTION_FAILURE_OBSERVED == 1 )); then
    TEST_POST_REAP_INSPECTION_ONLY_RETRY_OBSERVED=1
  fi
  for _wait in $(seq 1 "${CLEANUP_KILL_ATTEMPTS}"); do
    inspect_reaped_group_members "${pgid}"; status=$?
    (( status == 0 )) || return 1
    [[ -z "${REAPED_GROUP_MEMBERS}" ]] && return 0
    sleep 0.1
  done
  return 1
}

stop_group() {
  local pgid="$1" supervisor_pid="$2" started_at="$3" token="$4" owner="$5"
  local members status compact listeners holders release_sent=0 supervisor_reaped
  [[ "${pgid}" =~ ^[0-9]+$ ]] || return 1
  [[ "${pgid}" != "${CONTROLLER_PGID}" ]] || return 1

  case "${owner}" in
    server) supervisor_reaped="${SERVER_SUPERVISOR_REAPED}" ;;
    checker) supervisor_reaped="${CHECKER_SUPERVISOR_REAPED}" ;;
    *) return 1 ;;
  esac
  [[ "${supervisor_reaped}" =~ ^[01]$ ]] || return 1
  if (( supervisor_reaped == 1 )); then
    wait_for_reaped_group_empty "${pgid}"
    return
  fi

  if (( TEST_GROUP_INSPECTION_FAILURES_REMAINING > 0 )); then
    TEST_GROUP_INSPECTION_FAILURES_REMAINING=$((TEST_GROUP_INSPECTION_FAILURES_REMAINING - 1))
    return 1
  fi
  members="$(group_members "${pgid}")"; status=$?
  (( status == 0 )) || return 1
  [[ -n "${members}" ]] || return 0
  signal_exact_group TERM "${supervisor_pid}" "${pgid}" "${started_at}" "${token}" || return 1

  for _wait in $(seq 1 "${CLEANUP_TERM_ATTEMPTS}"); do
    members="$(group_members "${pgid}")"; status=$?
    (( status == 0 )) || return 1
    [[ -n "${members}" ]] || return 0
    compact="${members//$'\n'/}"
    if [[ "${compact}" == "${supervisor_pid}" && ${release_sent} -eq 0 ]]; then
      signal_exact_group_supervisor USR1 \
        "${supervisor_pid}" "${pgid}" "${started_at}" "${token}" || return 1
      signal_exact_group_supervisor CONT \
        "${supervisor_pid}" "${pgid}" "${started_at}" "${token}" || return 1
      release_sent=1
    fi
    if [[ "${owner}" == "server" ]] && (( TEST_EXPECT_PAYLOAD_LEADER_EXIT == 1 )) && \
      supervisor_reports_payload_exit "${SERVER_PAYLOAD_PID}" && \
      [[ "${compact}" != "${supervisor_pid}" ]]; then
      listeners="$(listener_pids "${S3_PORT}")"; status=$?
      (( status == 0 )) || return 1
      holders="$(fixture_state_holder_pids)"; status=$?
      (( status == 0 )) || return 1
      [[ -n "${listeners}" && -n "${holders}" ]] || return 1
      TEST_PAYLOAD_LEADER_EXIT_OBSERVED=1
      break
    fi
    sleep 0.1
  done

  members="$(group_members "${pgid}")"; status=$?
  (( status == 0 )) || return 1
  if [[ -n "${members}" ]]; then
    # The exact supervisor deliberately survives TERM, so it pins the group id
    # until the escalation decision. A remembered numeric PGID is never enough.
    signal_exact_group KILL "${supervisor_pid}" "${pgid}" "${started_at}" "${token}" || return 1
    # Reap the direct supervisor before asking `ps` for an empty group. Waiting
    # only after stop_group returned made the post-KILL scan depend on Bash's
    # asynchronous child reaper and could exhaust the bounded scan under load.
    wait_for_killed_direct_child_reap "${supervisor_pid}" || return 1
    case "${owner}" in
      server) SERVER_SUPERVISOR_REAPED=1 ;;
      checker) CHECKER_SUPERVISOR_REAPED=1 ;;
      *) return 1 ;;
    esac
    if [[ "${owner}" == "server" ]] && (( TEST_EXPECT_PAYLOAD_LEADER_EXIT == 1 )); then
      TEST_KILLED_SUPERVISOR_REAPED_BEFORE_SCAN=1
    fi
    wait_for_reaped_group_empty "${pgid}"
    return
  fi
}

stop_worker() {
  local cleanup_status=0
  if [[ -z "${SERVER_PGID}" ]]; then
    [[ -z "${SERVER_SUPERVISOR_PID}" ]] && return 0
    return 1
  fi
  stop_group "${SERVER_PGID}" "${SERVER_SUPERVISOR_PID}" \
    "${SERVER_SUPERVISOR_STARTED_AT}" "${SERVER_SUPERVISOR_TOKEN}" server || cleanup_status=$?
  # Ownership is cleared only after successful cleanup. Before reaping, a
  # transient failure retains exact signal identity; after reaping, the same
  # fields authorize bounded inspection only and can never authorize a signal.
  (( cleanup_status == 0 )) || return "${cleanup_status}"
  if [[ -n "${SERVER_SUPERVISOR_PID}" ]] && (( SERVER_SUPERVISOR_REAPED == 0 )); then
    if ! wait "${SERVER_SUPERVISOR_PID}" 2>/dev/null; then :; fi
  fi
  SERVER_SUPERVISOR_PID=""
  SERVER_PGID=""
  SERVER_SUPERVISOR_STARTED_AT=""
  SERVER_SUPERVISOR_TOKEN=""
  SERVER_PAYLOAD_PID=""
  SERVER_PAYLOAD_PID_FILE=""
  SERVER_PAYLOAD_STATUS_FILE=""
  SERVER_SUPERVISOR_REAPED=0
  SUPERVISOR_DIRECT_CHILD=0
  SUPERVISOR_READY=0
}

stop_checker() {
  local cleanup_status=0
  if [[ -z "${CHECKER_PGID}" ]]; then
    [[ -z "${CHECKER_SUPERVISOR_PID}" ]] && return 0
    return 1
  fi
  stop_group "${CHECKER_PGID}" "${CHECKER_SUPERVISOR_PID}" \
    "${CHECKER_SUPERVISOR_STARTED_AT}" "${CHECKER_SUPERVISOR_TOKEN}" checker || cleanup_status=$?
  (( cleanup_status == 0 )) || return "${cleanup_status}"
  if [[ -n "${CHECKER_SUPERVISOR_PID}" ]] && (( CHECKER_SUPERVISOR_REAPED == 0 )); then
    if ! wait "${CHECKER_SUPERVISOR_PID}" 2>/dev/null; then :; fi
  fi
  CHECKER_SUPERVISOR_PID=""
  CHECKER_PGID=""
  CHECKER_SUPERVISOR_STARTED_AT=""
  CHECKER_SUPERVISOR_TOKEN=""
  CHECKER_PAYLOAD_PID=""
  CHECKER_PAYLOAD_PID_FILE=""
  CHECKER_PAYLOAD_STATUS_FILE=""
  CHECKER_SUPERVISOR_REAPED=0
}

cleanup_checker_and_verify() {
  local pgid="${CHECKER_PGID:-${CHECKER_CLEANUP_PENDING_PGID}}"
  [[ -n "${pgid}" ]] || return 0
  stop_checker || return 1
  assert_group_empty "${pgid}" || return 1
  assert_checker_listener_empty || return 1
  assert_checker_state_holders_empty || return 1
  CHECKER_CLEANUP_PENDING_PGID=""
}

cleanup_and_verify() {
  local pgid="${SERVER_PGID:-${CLEANUP_PENDING_PGID}}"
  reap_provisional_supervisor || return 1
  cleanup_checker_and_verify || return 1
  [[ -n "${pgid}" ]] || return 0
  stop_worker || return 1
  assert_no_survivors "${pgid}" || return 1
  CLEANUP_PENDING_PGID=""
}

cleanup_with_retry() {
  local attempt
  CLEANUP_ATTEMPTS_USED=0
  for attempt in $(seq 1 "${CLEANUP_RETRY_ATTEMPTS}"); do
    CLEANUP_ATTEMPTS_USED="${attempt}"
    cleanup_and_verify && return 0
    if (( TEST_REPEAT_SIGNAL_DURING_CLEANUP == 1 && attempt == 1 )); then
      # These are synchronous self-signals while EXIT has all three masked; no
      # background sender or recyclable foreign PID is involved.
      kill -HUP "${BASHPID:-$$}" 2>/dev/null || return 1
      kill -INT "${BASHPID:-$$}" 2>/dev/null || return 1
      kill -TERM "${BASHPID:-$$}" 2>/dev/null || return 1
      TEST_REPEATED_SIGNALS_SENT=1
    fi
    (( attempt < CLEANUP_RETRY_ATTEMPTS )) && sleep 0.1
  done
  return 1
}

checker_payload_result() {
  local status_line label payload_pid payload_status extra
  supervisor_identity_is_exact "${CHECKER_SUPERVISOR_PID}" "${CHECKER_PGID}" \
    "${CHECKER_SUPERVISOR_STARTED_AT}" "${CHECKER_SUPERVISOR_TOKEN}" || return 1
  [[ -f "${CHECKER_PAYLOAD_STATUS_FILE}" ]] || return 1
  IFS= read -r status_line <"${CHECKER_PAYLOAD_STATUS_FILE}" || return 1
  IFS=: read -r label payload_pid payload_status extra <<<"${status_line}"
  [[ "${label}" == "payload_exited" && "${payload_pid}" == "${CHECKER_PAYLOAD_PID}" ]] || return 1
  [[ "${payload_status}" =~ ^[0-9]+$ && -z "${extra}" ]] || return 1
  printf '%s\n' "${payload_status}"
}

wait_for_checker_completion() {
  local deadline="$1" checker_status status
  while (( SECONDS < deadline )); do
    if [[ -f "${CHECKER_PAYLOAD_STATUS_FILE}" ]]; then
      checker_status="$(checker_payload_result)"; status=$?
      if (( status != 0 )); then
        CHECKER_SUPERVISOR_LIFECYCLE_STATUS="status_file_invalid"
        CHECKER_PAYLOAD_LIFECYCLE_STATUS="unreadable"
        return 125
      fi
      CHECKER_SUPERVISOR_LIFECYCLE_STATUS="exact_before_cleanup"
      CHECKER_PAYLOAD_LIFECYCLE_STATUS="exited_${checker_status}"
      cleanup_checker_and_verify || {
        CHECKER_SUPERVISOR_LIFECYCLE_STATUS="cleanup_unproven"
        return 125
      }
      CHECKER_SUPERVISOR_LIFECYCLE_STATUS="reaped"
      return "${checker_status}"
    fi
    supervisor_identity_is_exact "${CHECKER_SUPERVISOR_PID}" "${CHECKER_PGID}" \
      "${CHECKER_SUPERVISOR_STARTED_AT}" "${CHECKER_SUPERVISOR_TOKEN}" || {
        CHECKER_SUPERVISOR_LIFECYCLE_STATUS="identity_unproven"
        CHECKER_PAYLOAD_LIFECYCLE_STATUS="not_observed"
        return 125
      }
    sleep 0.1
  done
  CHECKER_SUPERVISOR_LIFECYCLE_STATUS="deadline_cleanup"
  CHECKER_PAYLOAD_LIFECYCLE_STATUS="timeout"
  cleanup_checker_and_verify || {
    CHECKER_SUPERVISOR_LIFECYCLE_STATUS="cleanup_unproven"
    return 125
  }
  CHECKER_SUPERVISOR_LIFECYCLE_STATUS="reaped"
  return 124
}

run_owned_checker() {
  local deadline_seconds="$1" start_status
  shift
  start_supervised_payload checker "${CHECK_LOG}" "$@"
  start_status=$?
  if (( start_status != 0 )); then
    CHECKER_SUPERVISOR_LIFECYCLE_STATUS="start_exit_${start_status}"
    CHECKER_PAYLOAD_LIFECYCLE_STATUS="not_started"
    cleanup_checker_and_verify || {
      CHECKER_SUPERVISOR_LIFECYCLE_STATUS="cleanup_unproven"
      return 125
    }
    return "${start_status}"
  fi
  CHECKER_SUPERVISOR_LIFECYCLE_STATUS="running"
  CHECKER_PAYLOAD_LIFECYCLE_STATUS="running"
  wait_for_checker_completion "$((SECONDS + deadline_seconds))"
}

emit_checked_checker_jsonl() {
  # The embedded Bun program must remain literal; shell expansion here would corrupt the evidence boundary.
  # shellcheck disable=SC2016
  S3_CHECKER_LOG="${CHECK_LOG}" bun --eval '
    const text = await Bun.file(process.env.S3_CHECKER_LOG ?? "").text();
    const lines = text.split("\n").filter((line) => line.length > 0);
    if (lines.length === 0) process.exit(1);
    const seen = new Set();
    for (const line of lines) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        process.exit(1);
      }
      if (
        record === null ||
        typeof record !== "object" ||
        Array.isArray(record) ||
        record.suite !== "e2e-s3-split-local" ||
        record.reproduce !== "bash scripts/e2e-s3-split.sh" ||
        typeof record.assertion !== "string" ||
        !["pass", "fail"].includes(record.status) ||
        seen.has(record.assertion)
      ) {
        process.exit(1);
      }
      seen.add(record.assertion);
      // Evidence fields are re-published only after being validated here. The
      // allowlist is exhaustive and the shapes are narrow — identifiers, route
      // templates, non-negative integers, and one fixed word — so a body,
      // token, cookie, fragment, extract, or raw query cannot pass through a
      // field that is only supposed to carry an id. A record that carries an
      // unknown key, or a known key with the wrong shape, fails the run rather
      // than being quietly dropped: silently stripping evidence is how the
      // retained log stopped being evidence in the first place.
      const STRING_EVIDENCE = [
        "principal",
        "counter_principal",
        "problem_id",
        "workshop_id",
        "session_id",
        "counter_session_id",
        "route",
        "request_id",
        "event_id",
        "code",
      ];
      const INTEGER_EVIDENCE = [
        "public_seq_before",
        "public_seq_after",
        "workshop_seq_before",
        "workshop_seq_after",
        "counter_own_workshop_count_before",
        "counter_own_workshop_count_after",
        "counter_workshop_seq_before",
        "counter_workshop_seq_after",
        "duration_ms",
      ];
      const SAFE_EVIDENCE_STRING = /^[A-Za-z0-9][A-Za-z0-9._:/ -]{0,127}$/u;
      const published = {
        suite: record.suite,
        reproduce: record.reproduce,
        assertion: record.assertion,
        status: record.status,
      };
      for (const [key, value] of Object.entries(record)) {
        // `detail` and `scope` are prose. They were never republished and still
        // are not: only shaped evidence crosses this boundary.
        if (["suite", "reproduce", "assertion", "status", "detail", "scope"].includes(key)) {
          continue;
        }
        if (STRING_EVIDENCE.includes(key)) {
          if (typeof value !== "string" || !SAFE_EVIDENCE_STRING.test(value)) process.exit(1);
          published[key] = value;
          continue;
        }
        if (INTEGER_EVIDENCE.includes(key)) {
          if (!Number.isSafeInteger(value) || value < 0) process.exit(1);
          published[key] = value;
          continue;
        }
        if (key === "cache_search_export") {
          if (
            ![
              "absent",
              "present",
              "not-probed",
              "public-digest-404-before-after",
            ].includes(value)
          ) {
            process.exit(1);
          }
          published[key] = value;
          continue;
        }
        process.exit(1);
      }
      process.stdout.write(JSON.stringify(published) + "\n");
    }
  '
}

checker_exit_diagnostics() {
  S3_CHECKER_LOG="${CHECK_LOG}" bun --eval '
    const text = await Bun.file(process.env.S3_CHECKER_LOG ?? "").text();
    const lines = text.split("\n").filter((line) => line.length > 0);
    const summary = { kind: "empty", records: 0, failed_records: 0 };
    for (const line of lines) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        summary.kind = "non_jsonl";
        break;
      }
      if (
        record === null ||
        typeof record !== "object" ||
        Array.isArray(record) ||
        record.suite !== "e2e-s3-split-local" ||
        record.reproduce !== "bash scripts/e2e-s3-split.sh" ||
        typeof record.assertion !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(record.assertion) ||
        !["pass", "fail"].includes(record.status)
      ) {
        summary.kind = "invalid_jsonl";
        break;
      }
      summary.records += 1;
      if (record.status === "fail") summary.failed_records += 1;
    }
    if (summary.kind === "empty" && summary.records > 0) {
      summary.kind = summary.failed_records > 0 ? "reported_failure" : "no_failure_record";
    }
    process.stdout.write(JSON.stringify(summary));
  ' 2>/dev/null
}

emit_checker_failure() {
  local checker_status="$1" checker_diagnostics supervisor_status payload_status
  [[ "${checker_status}" =~ ^[1-9][0-9]*$ ]] || return 1
  supervisor_status="${CHECKER_SUPERVISOR_LIFECYCLE_STATUS}"
  payload_status="${CHECKER_PAYLOAD_LIFECYCLE_STATUS}"
  [[ "${supervisor_status}" =~ ^[a-z0-9_-]{1,64}$ ]] || supervisor_status="unavailable"
  [[ "${payload_status}" =~ ^[a-z0-9_-]{1,64}$ ]] || payload_status="unavailable"
  checker_diagnostics="$(checker_exit_diagnostics)" || \
    checker_diagnostics='{"kind":"unavailable","records":0,"failed_records":0}'
  emit "{\"tool\":\"wrangler+bun\",\"tool_version\":${WRANGLER_VERSION_JSON},\"package\":\"@asimposium/wire\",\"suite\":\"s3-local-bindings\",\"duration_ms\":$(duration_ms),\"status\":\"fail\",\"code\":\"LOCAL_SPLIT_ASSERTION_FAILED\",\"checker_exit_status\":${checker_status},\"checker_lifecycle\":{\"supervisor\":\"${supervisor_status}\",\"payload\":\"${payload_status}\"},\"checker_diagnostics\":${checker_diagnostics},\"reproduce\":\"${REPRODUCE}\"}"
}

show_redacted() {
  local label="$1" file="$2"
  local line_count
  line_count="$(wc -l <"${file}" 2>/dev/null)" || line_count="0"
  line_count="${line_count//[[:space:]]/}"
  [[ "${line_count}" =~ ^[0-9]+$ ]] || line_count="0"
  # Raw worker/checker logs can carry untrusted exception text. Report only a
  # bounded count; structured failure code and checker summary stay on stdout.
  printf '%s\n' "--- ${label} diagnostic withheld (${line_count} log lines) ---" >&2
}

CONTROLLER_PGID="$(process_group_of "$$")" || {
  emit '{"tool":"bash","package":"@asimposium/wire","suite":"s3-local-bindings","status":"fail","code":"LOCAL_CONTROLLER_GROUP_UNAVAILABLE","reproduce":"bash scripts/e2e-s3-split.sh"}'
  exit 1
}
readonly CONTROLLER_PGID

start_term_resistant_fixture() {
  TEST_EXPECT_PAYLOAD_LEADER_EXIT=1
  TEST_PAYLOAD_LEADER_EXIT_OBSERVED=0
  # shellcheck disable=SC2016 # This program expands only in the payload shell.
  start_supervised_payload server "${SERVER_LOG}" bash -c '
    state_file="$1"
    port="$2"
    trap "exit 0" TERM
    (
      trap "" TERM INT HUP
      exec 9>"${state_file}"
      S3_FIXTURE_PORT="${port}" exec bun --eval '\''
        const port = Number(process.env.S3_FIXTURE_PORT);
        Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("fixture") });
      '\''
    ) &
    child="$!"
    while kill -0 "${child}" 2>/dev/null; do
      if ! wait "${child}"; then :; fi
    done
  ' s3-term-resistant-payload "${TERM_RESISTANT_STATE_FILE}" "${S3_PORT}" || return 1

  local members listeners holders status
  for _wait in {1..60}; do
    members="$(group_members "${SERVER_PGID}")"; status=$?
    (( status == 0 )) || return 1
    listeners="$(listener_pids "${S3_PORT}")"; status=$?
    (( status == 0 )) || return 1
    holders="$(fixture_state_holder_pids)"; status=$?
    (( status == 0 )) || return 1
    if [[ "${members}" == *$'\n'* && -n "${listeners}" && -n "${holders}" ]]; then return 0; fi
    sleep 0.05
  done
  return 1
}

run_provisional_exact_check_self_test() {
  local cleanup_status
  begin_startup_ownership_transition
  launch_pinned_supervisor "${SERVER_LOG}" bash -c 'exit 0' s3-provisional-exact-fixture || {
    install_runtime_signal_traps
    return 1
  }
  install_runtime_signal_traps
  TEST_PROVISIONAL_REAL_STARTED_AT="${SUPERVISOR_STARTED_AT}"
  TEST_PROVISIONAL_REAL_TOKEN="${SUPERVISOR_TOKEN}"
  TEST_PROVISIONAL_RECOVERY=1
  TEST_EXACT_CHECK_FAILURES_REMAINING="${CLEANUP_RETRY_ATTEMPTS}"
  cleanup_with_retry; cleanup_status=$?
  (( cleanup_status != 0 && SUPERVISOR_DIRECT_CHILD == 1 )) || return 1
  supervisor_direct_child_is_exact "${SUPERVISOR_PID}" \
    "${TEST_PROVISIONAL_REAL_STARTED_AT}" "${TEST_PROVISIONAL_REAL_TOKEN}" || return 1
  cleanup_with_retry || return 1
  TEST_PROVISIONAL_RECOVERY=0
  emit '{"tool":"bash","package":"@asimposium/wire","suite":"s3-local-bindings","assertion":"provisional_exact_check_failure_sent_no_signal_retained_ownership_and_retried","status":"pass","reproduce":"bash scripts/e2e-s3-split.sh"}'
}

run_pid_reuse_self_test() {
  local cleanup_status
  begin_startup_ownership_transition
  launch_pinned_supervisor "${SERVER_LOG}" bash -c 'exit 0' s3-pid-reuse-fixture || {
    install_runtime_signal_traps
    return 1
  }
  install_runtime_signal_traps
  TEST_PROVISIONAL_REAL_STARTED_AT="${SUPERVISOR_STARTED_AT}"
  TEST_PROVISIONAL_REAL_TOKEN="${SUPERVISOR_TOKEN}"
  TEST_PROVISIONAL_RECOVERY=1
  # Keep the marker valid: this case must reach the lstart comparison rather
  # than merely failing an argv-token check.
  SUPERVISOR_STARTED_AT="${SUPERVISOR_STARTED_AT} planted-recycled-lstart"
  cleanup_with_retry; cleanup_status=$?
  (( cleanup_status != 0 && SUPERVISOR_DIRECT_CHILD == 1 )) || return 1
  supervisor_direct_child_is_exact "${SUPERVISOR_PID}" \
    "${TEST_PROVISIONAL_REAL_STARTED_AT}" "${TEST_PROVISIONAL_REAL_TOKEN}" || return 1
  SUPERVISOR_STARTED_AT="${TEST_PROVISIONAL_REAL_STARTED_AT}"
  cleanup_with_retry || return 1
  TEST_PROVISIONAL_RECOVERY=0
  emit '{"tool":"bash","package":"@asimposium/wire","suite":"s3-local-bindings","assertion":"planted_pid_reuse_lstart_mismatch_sent_no_signal","status":"pass","reproduce":"bash scripts/e2e-s3-split.sh"}'
}

run_startup_signal_window_self_test() {
  local start_status
  start_supervised_payload server "${SERVER_LOG}" bash -c \
    'trap "exit 0" TERM; while :; do sleep 1; done' s3-startup-window-fixture
  start_status=$?
  (( start_status == 129 && TEST_STARTUP_SIGNAL_TRIGGERED == 1 )) || return 1
  exit "${start_status}"
}

start_checker_resource_fixture() {
  local resist_signals="$1" members listeners holders status
  [[ "${resist_signals}" =~ ^[01]$ ]] || return 1
  CHECKER_RESOURCE_PORT="$(allocate_port)" || return 1
  [[ "${CHECKER_RESOURCE_PORT}" =~ ^[0-9]+$ && "${CHECKER_RESOURCE_PORT}" != "${S3_PORT}" ]] || return 1
  port_is_busy "${CHECKER_RESOURCE_PORT}" && return 1
  S3_CHECKER_FIXTURE_STATE="${CHECKER_RESISTANT_STATE_FILE}" \
    S3_CHECKER_FIXTURE_PORT="${CHECKER_RESOURCE_PORT}" \
    S3_CHECKER_FIXTURE_RESIST="${resist_signals}" \
    start_supervised_payload checker "${CHECK_LOG}" bun --eval '
      import { openSync } from "node:fs";
      const stateFile = process.env.S3_CHECKER_FIXTURE_STATE;
      const port = Number(process.env.S3_CHECKER_FIXTURE_PORT);
      const resist = process.env.S3_CHECKER_FIXTURE_RESIST;
      if (!stateFile || !Number.isSafeInteger(port) || !["0", "1"].includes(resist ?? "")) {
        process.exit(2);
      }
      openSync(stateFile, "w");
      if (resist === "1") {
        for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => {});
      }
      Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("checker-fixture") });
    ' || return 1
  for _wait in {1..60}; do
    members="$(group_members "${CHECKER_PGID}")"; status=$?
    (( status == 0 )) || return 1
    listeners="$(listener_pids "${CHECKER_RESOURCE_PORT}")"; status=$?
    (( status == 0 )) || return 1
    holders="$(checker_state_holder_pids)"; status=$?
    (( status == 0 )) || return 1
    if [[ "${members}" == *$'\n'* && -n "${listeners}" && -n "${holders}" ]] && \
      listener_pids_are_in_group "${CHECKER_RESOURCE_PORT}" "${CHECKER_PGID}"; then
      return 0
    fi
    sleep 0.05
  done
  return 1
}

run_checker_timeout_self_test() {
  local checker_pgid checker_status
  start_checker_resource_fixture 1 || return 1
  checker_pgid="${CHECKER_PGID}"
  wait_for_checker_completion "$((SECONDS + 1))"; checker_status=$?
  (( checker_status == 124 )) || return 1
  emit '{"tool":"bash","package":"@asimposium/wire","suite":"s3-local-bindings","assertion":"checker_timeout_uses_exact_bounded_term_kill_and_wait","status":"pass","reproduce":"bash scripts/e2e-s3-split.sh"}'
  assert_group_empty "${checker_pgid}" || return 1
  emit '{"tool":"bash","package":"@asimposium/wire","suite":"s3-local-bindings","assertion":"checker_timeout_has_zero_group_or_descendant_survivors","status":"pass","reproduce":"bash scripts/e2e-s3-split.sh"}'
  assert_checker_listener_empty || return 1
  emit '{"tool":"bash","package":"@asimposium/wire","suite":"s3-local-bindings","assertion":"checker_timeout_releases_its_test_port","status":"pass","reproduce":"bash scripts/e2e-s3-split.sh"}'
  assert_checker_state_holders_empty || return 1
  emit '{"tool":"bash","package":"@asimposium/wire","suite":"s3-local-bindings","assertion":"checker_timeout_has_zero_state_fd_survivors","status":"pass","reproduce":"bash scripts/e2e-s3-split.sh"}'
}

run_checker_containment_self_test() {
  local checker_pgid cleanup_status members listeners holders status
  start_checker_resource_fixture 0 || return 1
  checker_pgid="${CHECKER_PGID}"
  emit '{"tool":"bash","package":"@asimposium/wire","suite":"s3-local-bindings","assertion":"checker_containment_fixture_has_owned_group_listener_and_state_fd","status":"pass","reproduce":"bash scripts/e2e-s3-split.sh"}'

  # This first refusal sends no signal. Arm only the fault it is about to
  # consume: if an outer watchdog interrupts this phase, EXIT cleanup must not
  # inherit two planted failures and exhaust both of its bounded attempts.
  TEST_GROUP_INSPECTION_FAILURES_REMAINING=1
  CHECKER_SUPERVISOR_LIFECYCLE_STATUS="injected_inspection_failure"
  CHECKER_PAYLOAD_LIFECYCLE_STATUS="not_observed"
  cleanup_checker_and_verify; cleanup_status=$?
  (( cleanup_status != 0 && TEST_GROUP_INSPECTION_FAILURES_REMAINING == 0 )) || return 1
  [[ "${CHECKER_PGID}" == "${checker_pgid}" ]] || return 1
  supervisor_identity_is_exact "${CHECKER_SUPERVISOR_PID}" "${CHECKER_PGID}" \
    "${CHECKER_SUPERVISOR_STARTED_AT}" "${CHECKER_SUPERVISOR_TOKEN}" || return 1
  members="$(group_members "${checker_pgid}")"; status=$?
  (( status == 0 )) && [[ "${members}" == *$'\n'* ]] || return 1
  listeners="$(listener_pids "${CHECKER_RESOURCE_PORT}")"; status=$?
  (( status == 0 )) && [[ -n "${listeners}" ]] || return 1
  listener_pids_are_in_group "${CHECKER_RESOURCE_PORT}" "${checker_pgid}" || return 1
  holders="$(checker_state_holder_pids)"; status=$?
  (( status == 0 )) && [[ -n "${holders}" ]] || return 1
  emit '{"tool":"bash","package":"@asimposium/wire","suite":"s3-local-bindings","assertion":"checker_containment_refusal_sends_no_signal_and_retains_exact_ownership","status":"pass","reproduce":"bash scripts/e2e-s3-split.sh"}'
  # Plant exactly one EXIT-attempt uncertainty only after the foreground
  # refusal has been observed. The second bounded cleanup attempt must then
  # reclaim the same exact group.
  TEST_GROUP_INSPECTION_FAILURES_REMAINING=1
  CHECKER_SUPERVISOR_LIFECYCLE_STATUS="cleanup_unproven"
  return 125
}

run_checker_exit_one_self_test() {
  local checker_status
  run_owned_checker "${CHECKER_DEADLINE_SECONDS}" bash -c 'sleep 0.25; exit 1'
  checker_status=$?
  (( checker_status == 1 )) || return 1
  emit_checker_failure "${checker_status}" || return 1
  return 1
}

# shellcheck disable=SC2329 # The shell invokes this function through the EXIT trap.
on_exit() {
  local original_status=$?
  # Mask every terminal signal before doing any cleanup work. A second HUP,
  # INT, or TERM cannot interrupt the bounded retry or bypass survivor checks.
  trap '' HUP INT TERM
  trap - EXIT
  if ! cleanup_with_retry; then
    emit "{\"tool\":\"bash\",\"package\":\"@asimposium/wire\",\"suite\":\"s3-local-bindings\",\"status\":\"fail\",\"code\":\"LOCAL_WORKER_CLEANUP_FAILED\",\"original_status\":${original_status},\"reproduce\":\"${REPRODUCE}\"}"
    if (( TEST_IDENTITY_RECOVERY == 1 )); then
      local members listeners holders status preserved=0
      members="$(group_members "${SERVER_PGID}")"; status=$?
      if (( status == 0 )) && [[ -n "${members}" ]] && \
        supervisor_identity_is_exact "${SERVER_SUPERVISOR_PID}" "${SERVER_PGID}" \
          "${TEST_IDENTITY_REAL_STARTED_AT}" "${TEST_IDENTITY_REAL_TOKEN}"; then
        listeners="$(listener_pids "${S3_PORT}")"; status=$?
        if (( status == 0 )) && [[ -n "${listeners}" ]]; then
          holders="$(fixture_state_holder_pids)"; status=$?
          if (( status == 0 )) && [[ -n "${holders}" ]]; then preserved=1; fi
        fi
      fi
      SERVER_SUPERVISOR_STARTED_AT="${TEST_IDENTITY_REAL_STARTED_AT}"
      SERVER_SUPERVISOR_TOKEN="${TEST_IDENTITY_REAL_TOKEN}"
      if (( preserved == 1 )) && cleanup_with_retry; then
        emit '{"tool":"bash","package":"@asimposium/wire","suite":"s3-local-bindings","assertion":"marker_only_mismatch_refuses_group_signals_and_preserves_ownership","status":"pass","reproduce":"bash scripts/e2e-s3-split.sh"}'
        exit "${original_status}"
      fi
    fi
    if (( TEST_PROVISIONAL_RECOVERY == 1 )); then
      local provisional_preserved=0
      TEST_EXACT_CHECK_FAILURES_REMAINING=0
      if (( SUPERVISOR_DIRECT_CHILD == 1 )) && supervisor_direct_child_is_exact \
        "${SUPERVISOR_PID}" "${TEST_PROVISIONAL_REAL_STARTED_AT}" \
        "${TEST_PROVISIONAL_REAL_TOKEN}"; then
        provisional_preserved=1
      fi
      SUPERVISOR_STARTED_AT="${TEST_PROVISIONAL_REAL_STARTED_AT}"
      SUPERVISOR_TOKEN="${TEST_PROVISIONAL_REAL_TOKEN}"
      if (( provisional_preserved == 1 )) && cleanup_with_retry; then
        emit '{"tool":"bash","package":"@asimposium/wire","suite":"s3-local-bindings","assertion":"provisional_identity_mismatch_sent_no_signal_and_recovered","status":"pass","reproduce":"bash scripts/e2e-s3-split.sh"}'
        exit "${original_status}"
      fi
    fi
    exit 1
  fi

  if (( checker_containment_mode == 1 )); then
    if (( CLEANUP_ATTEMPTS_USED != CLEANUP_RETRY_ATTEMPTS )); then
      emit "{\"tool\":\"bash\",\"package\":\"@asimposium/wire\",\"suite\":\"s3-local-bindings\",\"status\":\"fail\",\"code\":\"CHECKER_CONTAINMENT_EXIT_RETRY_NOT_EXERCISED\",\"original_status\":${original_status},\"reproduce\":\"${REPRODUCE}\"}"
      exit 1
    fi
    emit '{"tool":"bash","package":"@asimposium/wire","suite":"s3-local-bindings","assertion":"checker_containment_exit_retry_reclaims_exact_group","status":"pass","reproduce":"bash scripts/e2e-s3-split.sh"}'
    emit '{"tool":"bash","package":"@asimposium/wire","suite":"s3-local-bindings","assertion":"checker_containment_exit_retry_releases_listener","status":"pass","reproduce":"bash scripts/e2e-s3-split.sh"}'
    emit '{"tool":"bash","package":"@asimposium/wire","suite":"s3-local-bindings","assertion":"checker_containment_exit_retry_releases_state_fd","status":"pass","reproduce":"bash scripts/e2e-s3-split.sh"}'
  fi

  if (( TEST_REPEAT_SIGNAL_DURING_CLEANUP == 1 )); then
    if (( TEST_REPEATED_SIGNALS_SENT != 1 || CLEANUP_ATTEMPTS_USED != CLEANUP_RETRY_ATTEMPTS )); then
      emit "{\"tool\":\"bash\",\"package\":\"@asimposium/wire\",\"suite\":\"s3-local-bindings\",\"status\":\"fail\",\"code\":\"SECOND_SIGNAL_CLEANUP_BYPASS\",\"original_status\":${original_status},\"reproduce\":\"${REPRODUCE}\"}"
      exit 1
    fi
    emit '{"tool":"bash","package":"@asimposium/wire","suite":"s3-local-bindings","assertion":"second_signals_are_masked_during_bounded_exit_cleanup_retry","status":"pass","reproduce":"bash scripts/e2e-s3-split.sh"}'
  fi
  if [[ -n "${TEST_STARTUP_SIGNAL_WINDOW}" ]]; then
    if (( TEST_STARTUP_SIGNAL_TRIGGERED != 1 )) || [[ "${STARTUP_SIGNAL_NAME}" != "HUP" ]]; then
      emit "{\"tool\":\"bash\",\"package\":\"@asimposium/wire\",\"suite\":\"s3-local-bindings\",\"status\":\"fail\",\"code\":\"STARTUP_SIGNAL_WINDOW_NOT_EXERCISED\",\"window\":\"${TEST_STARTUP_SIGNAL_WINDOW}\",\"reproduce\":\"${REPRODUCE}\"}"
      exit 1
    fi
    emit "{\"tool\":\"bash\",\"package\":\"@asimposium/wire\",\"suite\":\"s3-local-bindings\",\"assertion\":\"startup_signal_window_${TEST_STARTUP_SIGNAL_WINDOW}_retained_exact_ownership\",\"status\":\"pass\",\"reproduce\":\"${REPRODUCE}\"}"
  fi
  if [[ -n "${TEST_DISPATCH_STARTUP_SIGNAL_OWNER}" ]]; then
    if (( TEST_STARTUP_SIGNAL_TRIGGERED != 1 )) || [[ "${STARTUP_SIGNAL_NAME}" != "HUP" ]]; then
      emit "{\"tool\":\"bash\",\"package\":\"@asimposium/wire\",\"suite\":\"s3-local-bindings\",\"status\":\"fail\",\"code\":\"DISPATCH_STARTUP_SIGNAL_NOT_EXERCISED\",\"owner\":\"${TEST_DISPATCH_STARTUP_SIGNAL_OWNER}\",\"reproduce\":\"${REPRODUCE}\"}"
      exit 1
    fi
    emit "{\"tool\":\"bash\",\"package\":\"@asimposium/wire\",\"suite\":\"s3-local-bindings\",\"assertion\":\"dispatch_startup_signal_${TEST_DISPATCH_STARTUP_SIGNAL_OWNER}_preserves_exit_129\",\"status\":\"pass\",\"reproduce\":\"${REPRODUCE}\"}"
  fi
  exit "${original_status}"
}

trap on_exit EXIT
install_runtime_signal_traps

run_term_resistant_descendant_self_test() {
  local pgid
  start_term_resistant_fixture || return 1
  pgid="${SERVER_PGID}"
  stop_worker || return 1
  (( TEST_PAYLOAD_LEADER_EXIT_OBSERVED == 1 )) || return 1
  (( TEST_KILLED_SUPERVISOR_REAPED_BEFORE_SCAN == 1 )) || return 1
  emit '{"tool":"bash","package":"@asimposium/wire","suite":"s3-local-bindings","assertion":"payload_leader_exits_while_pinned_supervisor_and_resistant_descendant_remain","status":"pass","reproduce":"bash scripts/e2e-s3-split.sh"}'
  emit '{"tool":"bash","package":"@asimposium/wire","suite":"s3-local-bindings","assertion":"term_resistant_supervisor_reaped_before_group_zero_scan","status":"pass","reproduce":"bash scripts/e2e-s3-split.sh"}'
  assert_group_empty "${pgid}" || return 1
  emit '{"tool":"bash","package":"@asimposium/wire","suite":"s3-local-bindings","assertion":"term_resistant_group_has_zero_survivors","status":"pass","reproduce":"bash scripts/e2e-s3-split.sh"}'
  assert_listener_empty || return 1
  emit '{"tool":"bash","package":"@asimposium/wire","suite":"s3-local-bindings","assertion":"term_resistant_fixture_releases_its_test_port","status":"pass","reproduce":"bash scripts/e2e-s3-split.sh"}'
  assert_state_holders_empty || return 1
  emit '{"tool":"bash","package":"@asimposium/wire","suite":"s3-local-bindings","assertion":"term_resistant_state_fd_has_zero_survivors","status":"pass","reproduce":"bash scripts/e2e-s3-split.sh"}'
  CLEANUP_PENDING_PGID=""
}

run_identity_mismatch_self_test() {
  start_term_resistant_fixture || return 1
  TEST_IDENTITY_REAL_STARTED_AT="${SERVER_SUPERVISOR_STARTED_AT}"
  TEST_IDENTITY_REAL_TOKEN="${SERVER_SUPERVISOR_TOKEN}"
  TEST_IDENTITY_RECOVERY=1
  # Keep lstart unchanged so `supervisor_identity_is_exact` reaches the argv
  # marker comparison. This is distinct from the PID-reuse lstart mismatch.
  SERVER_SUPERVISOR_TOKEN="00000000000000000000000000000000"
  exit 19
}

run_second_signal_cleanup_self_test() {
  start_term_resistant_fixture || return 1
  TEST_GROUP_INSPECTION_FAILURES_REMAINING=1
  TEST_REPEAT_SIGNAL_DURING_CLEANUP=1
  exit 0
}

run_post_reap_inspection_failure_self_test() {
  local pgid cleanup_status
  start_term_resistant_fixture || return 1
  pgid="${SERVER_PGID}"
  TEST_POST_REAP_GROUP_INSPECTION_FAILURES_REMAINING=1
  stop_worker; cleanup_status=$?
  (( cleanup_status != 0 )) || return 1
  (( SERVER_SUPERVISOR_REAPED == 1 )) || return 1
  (( TEST_POST_REAP_GROUP_INSPECTION_FAILURE_OBSERVED == 1 )) || return 1
  (( TEST_POST_REAP_GROUP_INSPECTION_FAILURES_REMAINING == 0 )) || return 1
  (( TEST_POST_REAP_SIGNAL_ATTEMPTS == 0 )) || return 1
  emit '{"tool":"bash","package":"@asimposium/wire","suite":"s3-local-bindings","assertion":"post_reap_inspection_failure_retains_inspection_only_ownership","status":"pass","reproduce":"bash scripts/e2e-s3-split.sh"}'

  cleanup_with_retry || return 1
  (( TEST_POST_REAP_INSPECTION_ONLY_RETRY_OBSERVED == 1 )) || return 1
  (( TEST_POST_REAP_SIGNAL_ATTEMPTS == 0 )) || return 1
  emit '{"tool":"bash","package":"@asimposium/wire","suite":"s3-local-bindings","assertion":"post_reap_retry_inspects_without_resignalling_remembered_pgid","status":"pass","reproduce":"bash scripts/e2e-s3-split.sh"}'
  assert_group_empty "${pgid}" || return 1
  emit '{"tool":"bash","package":"@asimposium/wire","suite":"s3-local-bindings","assertion":"post_reap_retry_has_zero_group_survivors","status":"pass","reproduce":"bash scripts/e2e-s3-split.sh"}'
  assert_listener_empty || return 1
  emit '{"tool":"bash","package":"@asimposium/wire","suite":"s3-local-bindings","assertion":"post_reap_retry_releases_its_test_port","status":"pass","reproduce":"bash scripts/e2e-s3-split.sh"}'
  assert_state_holders_empty || return 1
  emit '{"tool":"bash","package":"@asimposium/wire","suite":"s3-local-bindings","assertion":"post_reap_retry_has_zero_state_fd_survivors","status":"pass","reproduce":"bash scripts/e2e-s3-split.sh"}'
}

run_state_holder_recheck_self_test() {
  local holders status holder_pid ready_line holder_status
  local held_file ready_file release_file released_file prefix

  start_state_holder_recheck_child() {
    prefix="$1"
    held_file="${STATE_DIR}/state-holder-recheck-${prefix}.held"
    ready_file="${STATE_DIR}/state-holder-recheck-${prefix}.ready"
    release_file="${STATE_DIR}/state-holder-recheck-${prefix}.release"
    released_file="${STATE_DIR}/state-holder-recheck-${prefix}.released"
    [[ ! -e "${held_file}" && ! -L "${held_file}" && \
      ! -e "${ready_file}" && ! -L "${ready_file}" && \
      ! -e "${release_file}" && ! -L "${release_file}" && \
      ! -e "${released_file}" && ! -L "${released_file}" ]] || return 1
    bash -c '
    held_file="$1"
    ready_file="$2"
    release_file="$3"
    released_file="$4"
    exec 9>"${held_file}" || exit 125
    printf "ready %s\n" "$$" >"${ready_file}" || exit 125
    deadline=$((SECONDS + 10))
    while (( SECONDS < deadline )); do
      if [[ -f "${release_file}" && ! -L "${release_file}" ]] && \
        IFS= read -r release_line <"${release_file}" && \
        [[ "${release_line}" == "release $$" ]]; then
        exec 9>&-
        printf "released %s\n" "$$" >"${released_file}" || exit 125
        exit 0
      fi
      sleep 0.05
    done
    exit 124
    ' s3-state-holder-recheck "${held_file}" "${ready_file}" "${release_file}" \
      "${released_file}" &
    holder_pid=$!
    ready_line=""
    for _ in $(seq 1 100); do
      if [[ -f "${ready_file}" && ! -L "${ready_file}" ]]; then
        {
          IFS= read -r ready_line || ready_line=""
          if IFS= read -r _; then ready_line=""; fi
        } <"${ready_file}"
        [[ "${ready_line}" == "ready ${holder_pid}" ]] && return 0
      fi
      sleep 0.05
    done
    return 1
  }

  release_state_holder_recheck_child() {
    if [[ ! -e "${release_file}" && ! -L "${release_file}" ]]; then
      (umask 077; set -o noclobber; printf 'release %s\n' "${holder_pid}" \
        >"${release_file}") 2>/dev/null || :
    fi
    if wait "${holder_pid}" 2>/dev/null; then holder_status=0; else holder_status=$?; fi
    (( holder_status == 0 ))
  }

  start_state_holder_recheck_child transient || {
    [[ -n "${holder_pid:-}" ]] && release_state_holder_recheck_child || :
    return 1
  }
  TEST_STATE_HOLDER_RELEASE_AFTER_BROAD_PID="${holder_pid}"
  TEST_STATE_HOLDER_RELEASE_AFTER_BROAD_FILE="${release_file}"
  TEST_STATE_HOLDER_RELEASED_AFTER_BROAD_FILE="${released_file}"
  holders="$(state_holder_pids)"; status=$?
  if ! release_state_holder_recheck_child || (( status != 0 )) || [[ -n "${holders}" ]]; then
    return 1
  fi
  TEST_STATE_HOLDER_RELEASE_AFTER_BROAD_PID=""
  TEST_STATE_HOLDER_RELEASE_AFTER_BROAD_FILE=""
  TEST_STATE_HOLDER_RELEASED_AFTER_BROAD_FILE=""
  emit '{"tool":"bash+lsof","package":"@asimposium/wire","suite":"s3-local-bindings","assertion":"live_recursive_lsof_holder_released_after_broad_scan_is_rechecked_to_no_match","status":"pass","reproduce":"bash scripts/e2e-s3-split.sh"}'

  start_state_holder_recheck_child persistent || {
    [[ -n "${holder_pid:-}" ]] && release_state_holder_recheck_child || :
    return 1
  }
  holders="$(state_holder_pids)"; status=$?
  if (( status != 0 )) || [[ "${holders}" != "${holder_pid}" ]] || \
    assert_state_holders_empty; then
    release_state_holder_recheck_child || :
    return 1
  fi
  emit '{"tool":"bash+lsof","package":"@asimposium/wire","suite":"s3-local-bindings","assertion":"confirmed_recursive_lsof_holder_remains_a_cleanup_refusal","status":"pass","reproduce":"bash scripts/e2e-s3-split.sh"}'

  release_state_holder_recheck_child || return 1
  holders="$(state_holder_pids)"; status=$?
  if (( status != 0 )) || [[ -n "${holders}" ]]; then return 1; fi
  emit '{"tool":"bash+lsof","package":"@asimposium/wire","suite":"s3-local-bindings","assertion":"released_recursive_lsof_holder_converges_to_no_match","status":"pass","reproduce":"bash scripts/e2e-s3-split.sh"}'

  TEST_STATE_HOLDER_BROAD_ERROR_PLANT=warning
  if state_holder_pids >/dev/null; then return 1; else status=$?; fi
  (( status == 2 )) || return 1
  TEST_STATE_HOLDER_BROAD_ERROR_PLANT=malformed
  if state_holder_pids >/dev/null; then return 1; else status=$?; fi
  (( status == 2 )) || return 1
  TEST_STATE_HOLDER_BROAD_ERROR_PLANT=""
  emit '{"tool":"bash+lsof","package":"@asimposium/wire","suite":"s3-local-bindings","assertion":"recursive_lsof_warning_and_malformed_output_fail_closed","status":"pass","reproduce":"bash scripts/e2e-s3-split.sh"}'
}

term_mode="${S3_SELF_TEST_TERM_RESISTANT_CHILD:-0}"
identity_mode="${S3_SELF_TEST_IDENTITY_MISMATCH:-0}"
second_signal_mode="${S3_SELF_TEST_SECOND_SIGNAL_DURING_CLEANUP:-0}"
post_reap_inspection_mode="${S3_SELF_TEST_POST_REAP_INSPECTION_FAILURE:-0}"
provisional_exact_mode="${S3_SELF_TEST_PROVISIONAL_EXACT_FAILURE:-0}"
pid_reuse_mode="${S3_SELF_TEST_PID_REUSE:-0}"
checker_timeout_mode="${S3_SELF_TEST_CHECKER_TIMEOUT:-0}"
checker_containment_mode="${S3_SELF_TEST_CHECKER_CONTAINMENT_FAILURE:-0}"
checker_exit_one_mode="${S3_SELF_TEST_CHECKER_EXIT_1:-0}"
state_holder_recheck_mode="${S3_SELF_TEST_STATE_HOLDER_RECHECK:-0}"
TEST_DISPATCH_STARTUP_SIGNAL_OWNER="${S3_SELF_TEST_DISPATCH_STARTUP_SIGNAL:-}"
TEST_STARTUP_SIGNAL_WINDOW="${S3_SELF_TEST_STARTUP_SIGNAL_WINDOW:-}"
if [[ ! "${term_mode}" =~ ^[01]$ || ! "${identity_mode}" =~ ^[01]$ || \
  ! "${second_signal_mode}" =~ ^[01]$ || ! "${post_reap_inspection_mode}" =~ ^[01]$ || \
  ! "${provisional_exact_mode}" =~ ^[01]$ || \
  ! "${pid_reuse_mode}" =~ ^[01]$ || ! "${checker_timeout_mode}" =~ ^[01]$ || \
  ! "${checker_containment_mode}" =~ ^[01]$ || ! "${checker_exit_one_mode}" =~ ^[01]$ || \
  ! "${state_holder_recheck_mode}" =~ ^[01]$ ]] || \
  { [[ -n "${TEST_DISPATCH_STARTUP_SIGNAL_OWNER}" ]] && [[ ! "${TEST_DISPATCH_STARTUP_SIGNAL_OWNER}" =~ ^(server|checker)$ ]]; } || \
  { [[ -n "${TEST_STARTUP_SIGNAL_WINDOW}" ]] && [[ ! "${TEST_STARTUP_SIGNAL_WINDOW}" =~ ^(background_spawn|scratch_assignment|stop_proof|adoption|cont_release|return)$ ]]; } || \
  (( term_mode + identity_mode + second_signal_mode + post_reap_inspection_mode + provisional_exact_mode + \
    pid_reuse_mode + checker_timeout_mode + checker_containment_mode + checker_exit_one_mode + \
    state_holder_recheck_mode + \
    (${#TEST_STARTUP_SIGNAL_WINDOW} > 0) + (${#TEST_DISPATCH_STARTUP_SIGNAL_OWNER} > 0) > 1 )); then
  emit '{"tool":"bash","package":"@asimposium/wire","suite":"s3-local-bindings","status":"fail","code":"S3_SELF_TEST_MODE_INVALID","reproduce":"bash scripts/e2e-s3-split.sh"}'
  exit 1
fi
if (( term_mode == 1 )); then
  if ! run_term_resistant_descendant_self_test; then
    emit '{"tool":"bash","package":"@asimposium/wire","suite":"s3-local-bindings","assertion":"term_resistant_cleanup","status":"fail","reproduce":"bash scripts/e2e-s3-split.sh"}'
    exit 1
  fi
  exit 0
fi
if (( identity_mode == 1 )); then
  run_identity_mismatch_self_test || exit 1
fi
if (( second_signal_mode == 1 )); then
  run_second_signal_cleanup_self_test || exit 1
fi
if (( post_reap_inspection_mode == 1 )); then
  run_post_reap_inspection_failure_self_test || exit 1
  exit 0
fi
if (( state_holder_recheck_mode == 1 )); then
  run_state_holder_recheck_self_test || exit 1
  exit 0
fi
if (( provisional_exact_mode == 1 )); then
  run_provisional_exact_check_self_test || exit 1
  exit 0
fi
if (( pid_reuse_mode == 1 )); then
  run_pid_reuse_self_test || exit 1
  exit 0
fi
if (( checker_timeout_mode == 1 )); then
  run_checker_timeout_self_test || exit 1
  exit 0
fi
if (( checker_exit_one_mode == 1 )); then
  run_checker_exit_one_self_test || exit 1
fi
if (( checker_containment_mode == 1 )); then
  run_checker_containment_self_test; checker_status=$?
  if (( checker_status != 125 )); then
    emit '{"tool":"bash","package":"@asimposium/wire","suite":"s3-local-bindings","status":"fail","code":"CHECKER_CONTAINMENT_FIXTURE_INVALID","reproduce":"bash scripts/e2e-s3-split.sh"}'
    exit 1
  fi
  emit "{\"tool\":\"wrangler+bun\",\"tool_version\":${WRANGLER_VERSION_JSON},\"package\":\"@asimposium/wire\",\"suite\":\"s3-local-bindings\",\"duration_ms\":$(duration_ms),\"status\":\"fail\",\"code\":\"LOCAL_SPLIT_CHECKER_CONTAINMENT_FAILED\",\"reproduce\":\"${REPRODUCE}\"}"
  exit 1
fi
if [[ -n "${TEST_STARTUP_SIGNAL_WINDOW}" ]]; then
  run_startup_signal_window_self_test || exit 1
fi

start_supervised_payload server "${SERVER_LOG}" "${WRANGLER}" dev "${ENTRYPOINT}" \
  --config "${CONFIG}" \
  --local \
  --persist-to "${STATE_DIR}" \
  --port "${S3_PORT}" \
  --inspector-port 0 \
  --log-level error \
  --show-interactive-dev-session=false \
  --var "S3_RUN_TOKEN:${S3_RUN_TOKEN}" \
  --var "S3_READINESS_NONCE:${S3_READINESS_NONCE}"
server_start_status=$?
if is_retained_signal_status "${server_start_status}"; then
  exit "${server_start_status}"
fi
if (( server_start_status != 0 )); then
  SERVER_SUPERVISOR_LIFECYCLE_STATUS="start_exit_${server_start_status}"
  SERVER_PAYLOAD_LIFECYCLE_STATUS="not_started"
  emit "{\"tool\":\"wrangler\",\"tool_version\":${WRANGLER_VERSION_JSON},\"package\":\"@asimposium/wire\",\"suite\":\"s3-local-bindings\",\"duration_ms\":$(duration_ms),\"status\":\"fail\",\"code\":\"LOCAL_WORKER_SUPERVISOR_UNAVAILABLE\",\"server_start_status\":${server_start_status},\"server_lifecycle\":{\"supervisor\":\"${SERVER_SUPERVISOR_LIFECYCLE_STATUS}\",\"payload\":\"${SERVER_PAYLOAD_LIFECYCLE_STATUS}\"},\"reproduce\":\"${REPRODUCE}\"}"
  exit 1
fi
SERVER_SUPERVISOR_LIFECYCLE_STATUS="started"
SERVER_PAYLOAD_LIFECYCLE_STATUS="released"

ready=0
for _attempt in {1..60}; do
  if ! supervisor_identity_is_exact "${SERVER_SUPERVISOR_PID}" "${SERVER_PGID}" \
    "${SERVER_SUPERVISOR_STARTED_AT}" "${SERVER_SUPERVISOR_TOKEN}"; then break; fi
  health="$(curl --silent --fail --connect-timeout 1 --max-time 1 "${ORIGIN}/__s3/health" 2>/dev/null || true)"
  if [[ "${health}" == *"\"readiness_nonce\":\"${S3_READINESS_NONCE}\""* ]] && \
    supervisor_identity_is_exact "${SERVER_SUPERVISOR_PID}" "${SERVER_PGID}" \
      "${SERVER_SUPERVISOR_STARTED_AT}" "${SERVER_SUPERVISOR_TOKEN}" && \
    listener_pids_are_in_group "${S3_PORT}" "${SERVER_PGID}"; then
    ready=1
    break
  fi
  sleep 0.25
done
if [[ ${ready} -ne 1 ]]; then
  show_redacted "wrangler" "${SERVER_LOG}"
  emit "{\"tool\":\"wrangler\",\"tool_version\":${WRANGLER_VERSION_JSON},\"package\":\"@asimposium/wire\",\"suite\":\"s3-local-bindings\",\"duration_ms\":$(duration_ms),\"status\":\"fail\",\"code\":\"LOCAL_WORKER_UNAVAILABLE\",\"reproduce\":\"${REPRODUCE}\"}"
  exit 1
fi

run_owned_checker "${CHECKER_DEADLINE_SECONDS}" env \
  S3_LOCAL_ORIGIN="${ORIGIN}" S3_LOCAL_RUN_TOKEN="${S3_RUN_TOKEN}" \
  S3_LOCAL_READINESS_NONCE="${S3_READINESS_NONCE}" bun "${CHECKER}"
checker_status=$?
if is_retained_signal_status "${checker_status}"; then
  exit "${checker_status}"
fi
if (( checker_status == 124 )); then
  show_redacted "local binding checker" "${CHECK_LOG}"
  show_redacted "wrangler" "${SERVER_LOG}"
  emit "{\"tool\":\"wrangler+bun\",\"tool_version\":${WRANGLER_VERSION_JSON},\"package\":\"@asimposium/wire\",\"suite\":\"s3-local-bindings\",\"duration_ms\":$(duration_ms),\"status\":\"fail\",\"code\":\"LOCAL_SPLIT_CHECKER_TIMEOUT\",\"reproduce\":\"${REPRODUCE}\"}"
  exit 1
fi
if (( checker_status == 125 )); then
  show_redacted "local binding checker" "${CHECK_LOG}"
  show_redacted "wrangler" "${SERVER_LOG}"
  emit "{\"tool\":\"wrangler+bun\",\"tool_version\":${WRANGLER_VERSION_JSON},\"package\":\"@asimposium/wire\",\"suite\":\"s3-local-bindings\",\"duration_ms\":$(duration_ms),\"status\":\"fail\",\"code\":\"LOCAL_SPLIT_CHECKER_CONTAINMENT_FAILED\",\"reproduce\":\"${REPRODUCE}\"}"
  exit 1
fi
if (( checker_status != 0 )); then
  emit_checker_failure "${checker_status}" || {
    emit "{\"tool\":\"wrangler+bun\",\"tool_version\":${WRANGLER_VERSION_JSON},\"package\":\"@asimposium/wire\",\"suite\":\"s3-local-bindings\",\"duration_ms\":$(duration_ms),\"status\":\"fail\",\"code\":\"LOCAL_SPLIT_ASSERTION_FAILED\",\"checker_exit_status\":${checker_status},\"checker_diagnostics\":{\"kind\":\"unavailable\",\"records\":0,\"failed_records\":0},\"reproduce\":\"${REPRODUCE}\"}"
  }
  exit 1
fi
if ! emit_checked_checker_jsonl; then
  show_redacted "local binding checker" "${CHECK_LOG}"
  show_redacted "wrangler" "${SERVER_LOG}"
  emit "{\"tool\":\"wrangler+bun\",\"tool_version\":${WRANGLER_VERSION_JSON},\"package\":\"@asimposium/wire\",\"suite\":\"s3-local-bindings\",\"duration_ms\":$(duration_ms),\"status\":\"fail\",\"code\":\"LOCAL_SPLIT_CHECKER_OUTPUT_INVALID\",\"reproduce\":\"${REPRODUCE}\"}"
  exit 1
fi
if ! cleanup_with_retry; then
  emit "{\"tool\":\"wrangler+bun\",\"tool_version\":${WRANGLER_VERSION_JSON},\"package\":\"@asimposium/wire\",\"suite\":\"s3-local-bindings\",\"duration_ms\":$(duration_ms),\"status\":\"fail\",\"code\":\"LOCAL_WORKER_CLEANUP_FAILED\",\"reproduce\":\"${REPRODUCE}\"}"
  exit 1
fi

emit "{\"tool\":\"wrangler+bun\",\"tool_version\":${WRANGLER_VERSION_JSON},\"package\":\"@asimposium/wire\",\"suite\":\"s3-local-bindings\",\"duration_ms\":$(duration_ms),\"status\":\"pass\",\"bindings\":{\"d1\":\"DB\",\"r2\":\"ARTIFACTS\"},\"reproduce\":\"${REPRODUCE}\"}"
emit "{\"tool\":\"wrangler\",\"tool_version\":${WRANGLER_VERSION_JSON},\"package\":\"@asimposium/wire\",\"suite\":\"s3-staging-paired-principal\",\"duration_ms\":$(duration_ms),\"status\":\"blocked\",\"exit_code\":78,\"code\":\"S3_STAGING_ENVIRONMENT_ABSENT\",\"blocked_on\":\"a deployed staging Worker with Propylon authentication, a configured R2 namespace, and a paired sponsor plus anonymous browser proof\",\"forbidden_substitutes\":\"local-workerd behavior presented as staging proof, test headers as OAuth proof, or in-memory SplitService tests as D1/R2 evidence\",\"reproduce\":\"${REPRODUCE}\"}"
printf '%s\n' 'BLOCKED s3-staging-paired-principal (exit 78): staging identity and paired-browser proof are not configured' >&2
exit "${BLOCKED_EXIT}"
