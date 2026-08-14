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
readonly S2_LIFECYCLE_DEADLINE_SECONDS=100
readonly -a S2_SOURCE_PATHS=(
  apps/wire/src/krater/krater.ts
  apps/wire/src/krater/worker.ts
  apps/wire/src/krater/outbox-do.ts
  apps/wire/src/krater/s2-client.ts
  apps/wire/src/krater/wrangler.s2.toml
  db/migrations/0001_krater_v0.sql
  db/migrations/0004_krater_integrity_v1.sql
  db/migrations/0005_krater_undigested_index.sql
  scripts/e2e-s2-krater.sh
)

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
S2_STATE_DIR="$(mktemp -d -t asimposium-s2-krater)"
readonly S2_STATE_DIR
readonly S2_SERVER_LOG="${S2_STATE_DIR}/wrangler.log"
readonly S2_ORIGIN="http://127.0.0.1:${S2_PORT}"
S2_SERVER_PID=""
declare -a S2_SERVER_PIDS=()
S2_LIFECYCLE_CHILD_PID=""
# The origin the next phase talks to. The legacy upgrade stages run their own
# Worker on their own owned port, so a phase must never assume the main one.
S2_ACTIVE_ORIGIN="${S2_ORIGIN}"
# Legacy state directories are retained like every other: cleanup terminates
# processes, never files, so an upgrade failure keeps the database that caused it.
declare -a S2_LEGACY_STATE_DIRS=()

emit() {
  printf '%s\n' "$1"
}

redacted_wrangler_cause() {
  # shellcheck disable=SC2016
  S2_LOG_PATH="${S2_SERVER_LOG}" bun --eval '
    const file = Bun.file(process.env.S2_LOG_PATH ?? "");
    const text = await file.text().catch(() => "wrangler log unavailable");
    const redacted = text
      .replace(/(?:[A-Za-z]+:)?\/(?:Users|var|tmp)\/[^\s"'\''`]+/g, "<path>")
      .replace(/\b(token|secret|password|authorization)\s*=\s*[^\s,;]+/gi, "$1=<redacted>")
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

worker_process_group_alive() {
  local pid="$1"
  kill -0 "-${pid}" 2>/dev/null || kill -0 "${pid}" 2>/dev/null
}

stop_worker_process_group() {
  local pid="$1" tick
  [[ -n "${pid}" ]] || return 0

  # Wrangler starts workerd. The job-control group created at spawn lets this
  # script terminate both, including the case where Wrangler exited first.
  kill -TERM "-${pid}" 2>/dev/null || kill -TERM "${pid}" 2>/dev/null || :
  for ((tick = 0; tick < S2_TERMINATE_WAIT_TICKS; tick += 1)); do
    worker_process_group_alive "${pid}" || break
    sleep 0.1
  done
  if worker_process_group_alive "${pid}"; then
    kill -KILL "-${pid}" 2>/dev/null || kill -KILL "${pid}" 2>/dev/null || :
  fi
  if ! wait "${pid}" 2>/dev/null; then
    :
  fi
}

stop_worker() {
  if [[ -n "${S2_SERVER_PID}" ]]; then
    stop_worker_process_group "${S2_SERVER_PID}"
  fi
  S2_SERVER_PID=""
  S2_SERVER_PIDS=()
}

# shellcheck disable=SC2329
cleanup_workers() {
  local pid
  for pid in "${S2_SERVER_PIDS[@]}"; do
    stop_worker_process_group "${pid}"
  done
  S2_SERVER_PID=""
  S2_SERVER_PIDS=()
}

trap cleanup_workers EXIT
trap 'cleanup_workers; exit 130' INT
trap 'cleanup_workers; exit 143' TERM
trap 'cleanup_workers; exit 129' HUP

start_worker() {
  # Defaults keep the primary run's call sites unchanged; the legacy upgrade
  # stages pass their own config, persistence directory and owned port.
  local config="${1:-${S2_WRANGLER_CONFIG}}"
  local persist="${2:-${S2_STATE_DIR}}"
  local port="${3:-${S2_PORT}}"
  local log="${4:-${S2_SERVER_LOG}}"
  if port_is_busy "${port}"; then
    return 2
  fi
  S2_ACTIVE_ORIGIN="http://127.0.0.1:${port}"
  # A separate process group is required for a bounded cleanup to include
  # workerd rather than only Wrangler's supervising process.
  set -m
  "${S2_WRANGLER}" dev apps/wire/src/krater/worker.ts \
    --config "${config}" \
    --local \
    --persist-to "${persist}" \
    --ip "${S2_BIND_IP}" \
    --port "${port}" \
    --inspector-port 0 \
    --log-level error \
    --show-interactive-dev-session=false \
    >>"${log}" 2>&1 &
  S2_SERVER_PID=$!
  S2_SERVER_PIDS+=("${S2_SERVER_PID}")
  set +m

  local ready=0
  local deadline=$((SECONDS + S2_READY_DEADLINE_SECONDS))
  while (( SECONDS < deadline )); do
    if ! worker_process_group_alive "${S2_SERVER_PID}"; then
      break
    fi
    if curl --silent --connect-timeout 1 --max-time 1 --output /dev/null "${S2_ACTIVE_ORIGIN}/__s2/cursor?problem_id=P-s2"; then
      if worker_process_group_alive "${S2_SERVER_PID}"; then
        ready=1
        break
      fi
    fi
    sleep 0.2
  done
  if [[ ${ready} -ne 1 ]]; then
    stop_worker
    return 1
  fi
}

run_phase() {
  local phase="$1"
  env \
    S2_ORIGIN="${S2_ACTIVE_ORIGIN}" \
    S2_PHASE="${phase}" \
    S2_GIT_HEAD="${S2_GIT_HEAD}" \
    S2_GIT_DIRTY="${S2_GIT_DIRTY}" \
    S2_SOURCE_DIGEST="${S2_SOURCE_DIGEST}" \
    bun apps/wire/src/krater/s2-client.ts &
  local phase_pid=$!
  local deadline=$((SECONDS + S2_PHASE_DEADLINE_SECONDS))
  while kill -0 "${phase_pid}" 2>/dev/null; do
    if ! worker_process_group_alive "${S2_SERVER_PID}"; then
      kill "${phase_pid}" 2>/dev/null || :
      if ! wait "${phase_pid}"; then
        :
      fi
      return 125
    fi
    if (( SECONDS >= deadline )); then
      kill "${phase_pid}"
      if ! wait "${phase_pid}"; then
        :
      fi
      return 124
    fi
    sleep 0.2
  done
  wait "${phase_pid}"
}

emit_legacy_failure() {
  local phase="$1" code="$2" log="$3"
  local cause
  cause="$(S2_SERVER_LOG="${log}" redacted_wrangler_cause)"
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

# ── legacy upgrade stages ────────────────────────────────────────────────────
# Build a genuinely old database and then upgrade it in place.
#
# The order is the whole point. `wrangler.s2-legacy.toml` carries its own
# `migrations_dir` holding the exact pre-integrity 0001 and nothing else, so the
# database is first created without any integrity column, optionally given the
# retained legacy row, and only then handed the repository's forward migration.
# A database born with 0004 already applied would exercise none of this: the
# backfill would have nothing legacy to refuse, and the upgrade would be proved
# against a schema that never existed in the field.
#
# Each stage owns its own persistence directory and its own dynamically chosen
# port, so it can neither read nor collide with the primary run's state.
run_legacy_upgrade() {
  local phase="$1" fixture="$2" index_phase="${3:-}"
  local dir port log status

  dir="$(mktemp -d -t asimposium-s2-krater-legacy)"
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

  # The forward migration lands on a database that already held rows (or, for the
  # empty case, already existed) rather than on a fresh one.
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
  stop_worker
  S2_ACTIVE_ORIGIN="${S2_ORIGIN}"

  # Second stage: 0004 -> 0005 on the database the first stage just used, rows and all.
  #
  # This is the only 0004-era database in the run. Without this the forward-migration evidence
  # stopped at 0004 and the index was only ever seen on a database born with it, so nothing
  # here executed the upgrade the deployed fleet will perform. The Worker is restarted because
  # the first stage must observe the schema before the index exists.
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
    stop_worker
    S2_ACTIVE_ORIGIN="${S2_ORIGIN}"
  fi
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

run_s2_shell_regression_test() {
  local phase_status upgrade_status emitted_phase=""

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

if [[ "${S2_SHELL_REGRESSION_TEST:-none}" == "indexed-phase-status" ]]; then
  run_s2_shell_regression_test
  exit $?
fi

launch_lifecycle_child() {
  local port="$1" log="$2" interrupt_after_ready="$3"
  set -m
  env \
    S2_PORT="${port}" \
    S2_LIFECYCLE_TEST="none" \
    S2_INTERRUPT_AFTER_READY="${interrupt_after_ready}" \
    bash "${BASH_SOURCE[0]}" >"${log}" 2>&1 &
  S2_LIFECYCLE_CHILD_PID=$!
  set +m
}

wait_for_lifecycle_port() {
  local port="$1" pid="$2"
  local deadline=$((SECONDS + S2_READY_DEADLINE_SECONDS))
  while (( SECONDS < deadline )); do
    if ! kill -0 "${pid}" 2>/dev/null; then
      return 1
    fi
    if port_is_busy "${port}"; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

wait_for_lifecycle_child() {
  local pid="$1" tick
  local deadline=$((SECONDS + S2_LIFECYCLE_DEADLINE_SECONDS))
  while kill -0 "${pid}" 2>/dev/null; do
    if (( SECONDS >= deadline )); then
      kill -TERM "-${pid}" 2>/dev/null || kill -TERM "${pid}" 2>/dev/null || :
      for ((tick = 0; tick < S2_TERMINATE_WAIT_TICKS; tick += 1)); do
        kill -0 "${pid}" 2>/dev/null || break
        sleep 0.1
      done
      if kill -0 "${pid}" 2>/dev/null; then
        kill -KILL "-${pid}" 2>/dev/null || kill -KILL "${pid}" 2>/dev/null || :
      fi
      break
    fi
    sleep 0.1
  done
  wait "${pid}"
}

run_lifecycle_self_test() {
  local mode="$1" state_dir first_port second_port first_pid second_pid first_status second_status
  state_dir="$(mktemp -d -t asimposium-s2-krater-lifecycle)"
  if [[ ! -d "${state_dir}" || -L "${state_dir}" ]]; then
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-lifecycle","status":"fail","code":"S2_LIFECYCLE_PERSIST_DIR_INVALID","reproduce":"S2_LIFECYCLE_TEST=parallel scripts/e2e-s2-krater.sh"}'
    return 1
  fi
  if ! first_port="$(choose_available_port)"; then
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-lifecycle","status":"fail","code":"S2_LIFECYCLE_PORT_UNAVAILABLE","reproduce":"S2_LIFECYCLE_TEST=parallel scripts/e2e-s2-krater.sh"}'
    return 1
  fi

  if [[ "${mode}" == "parallel" ]]; then
    launch_lifecycle_child "${first_port}" "${state_dir}/parallel-one.log" 0
    first_pid="${S2_LIFECYCLE_CHILD_PID}"
    if ! wait_for_lifecycle_port "${first_port}" "${first_pid}"; then
      wait_for_lifecycle_child "${first_pid}" || :
      emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-lifecycle","status":"fail","code":"S2_PARALLEL_FIRST_NOT_READY","reproduce":"S2_LIFECYCLE_TEST=parallel scripts/e2e-s2-krater.sh"}'
      return 1
    fi
    if ! second_port="$(choose_available_port)"; then
      wait_for_lifecycle_child "${first_pid}" || :
      emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-lifecycle","status":"fail","code":"S2_PARALLEL_SECOND_PORT_UNAVAILABLE","reproduce":"S2_LIFECYCLE_TEST=parallel scripts/e2e-s2-krater.sh"}'
      return 1
    fi
    launch_lifecycle_child "${second_port}" "${state_dir}/parallel-two.log" 0
    second_pid="${S2_LIFECYCLE_CHILD_PID}"
    if ! wait_for_lifecycle_port "${second_port}" "${second_pid}"; then
      wait_for_lifecycle_child "${first_pid}" || :
      wait_for_lifecycle_child "${second_pid}" || :
      emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-lifecycle","status":"fail","code":"S2_PARALLEL_SECOND_NOT_READY","reproduce":"S2_LIFECYCLE_TEST=parallel scripts/e2e-s2-krater.sh"}'
      return 1
    fi
    if wait_for_lifecycle_child "${first_pid}"; then first_status=0; else first_status=$?; fi
    if wait_for_lifecycle_child "${second_pid}"; then second_status=0; else second_status=$?; fi
    if [[ ${first_status} -ne 78 || ${second_status} -ne 78 ]] || \
      port_is_busy "${first_port}" || port_is_busy "${second_port}"; then
      emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-lifecycle","status":"fail","code":"S2_PARALLEL_ISOLATION_FAILED","reproduce":"S2_LIFECYCLE_TEST=parallel scripts/e2e-s2-krater.sh"}'
      return 1
    fi
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-lifecycle","status":"pass","scenario":"two-concurrent-local-workerd-runs-use-isolated-main-and-inspector-ports","reproduce":"S2_LIFECYCLE_TEST=parallel scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  if [[ "${mode}" == "sigterm" ]]; then
    launch_lifecycle_child "${first_port}" "${state_dir}/sigterm.log" 1
    first_pid="${S2_LIFECYCLE_CHILD_PID}"
    if ! wait_for_lifecycle_port "${first_port}" "${first_pid}"; then
      wait_for_lifecycle_child "${first_pid}" || :
      emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-lifecycle","status":"fail","code":"S2_SIGTERM_FIXTURE_NOT_READY","reproduce":"S2_LIFECYCLE_TEST=sigterm scripts/e2e-s2-krater.sh"}'
      return 1
    fi
    if wait_for_lifecycle_child "${first_pid}"; then first_status=0; else first_status=$?; fi
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

if ! "${S2_WRANGLER}" d1 migrations apply DB --config "${S2_WRANGLER_CONFIG}" --local --persist-to "${S2_STATE_DIR}" >"${S2_STATE_DIR}/migration.log" 2>&1; then
  emit_wrangler_failure "LOCAL_D1_MIGRATION_FAILED"
  exit 1
fi

if ! start_worker; then
  emit_wrangler_failure "LOCAL_WORKER_UNAVAILABLE"
  exit 1
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

emit "{\"tool\":\"wrangler\",\"tool_version\":\"${S2_WRANGLER_VERSION}\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-local-do-alarm\",\"status\":\"pass\",\"bindings\":{\"d1\":\"DB\",\"durable_object\":\"KRATER_OUTBOX\"},\"reproduce\":\"scripts/e2e-s2-krater.sh\"}"
emit "{\"tool\":\"wrangler\",\"tool_version\":\"${S2_WRANGLER_VERSION}\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-deployed-do\",\"status\":\"blocked\",\"exit_code\":78,\"code\":\"DEPLOYED_DO_ENVIRONMENT_ABSENT\",\"blocked_on\":\"a deployed Worker with a configured Durable Object namespace and alarm telemetry\",\"forbidden_substitutes\":\"local-workerd behavior presented as deployed Durable Object proof\",\"reproduce\":\"scripts/e2e-s2-krater.sh\"}"
emit "{\"tool\":\"wrangler\",\"tool_version\":\"${S2_WRANGLER_VERSION}\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-edge-load\",\"status\":\"blocked\",\"exit_code\":78,\"code\":\"EDGE_CACHE_ENVIRONMENT_ABSENT\",\"blocked_on\":\"a staging edge-cache environment with D1 row-read and Worker CPU telemetry\",\"forbidden_substitutes\":\"a local curl loop, an in-process handler benchmark, or local-workerd timing presented as edge-load proof\",\"reproduce\":\"scripts/e2e-s2-krater.sh\"}"
exit 78
