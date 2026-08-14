#!/usr/bin/env bash
# Local real-D1 + Durable Object S-2 harness. This never contacts a remote
# Cloudflare resource. Its unique persistence directory is intentionally
# retained: cleanup terminates only child workerd processes, never files.
# Successful local DO proof is reported green; deployed DO and edge-load proof
# remain external blockers and cause the final exit 78.

set -euo pipefail

readonly S2_WRANGLER="apps/wire/node_modules/.bin/wrangler"
readonly S2_WRANGLER_CONFIG="apps/wire/src/krater/wrangler.s2.toml"
readonly S2_READY_DEADLINE_SECONDS=15
readonly S2_PHASE_DEADLINE_SECONDS=75
readonly -a S2_SOURCE_PATHS=(
  apps/wire/src/krater/krater.ts
  apps/wire/src/krater/worker.ts
  apps/wire/src/krater/outbox-do.ts
  apps/wire/src/krater/s2-client.ts
  apps/wire/src/krater/wrangler.s2.toml
  db/migrations/0001_krater_v0.sql
  db/migrations/0004_krater_integrity_v1.sql
  scripts/e2e-s2-krater.sh
)

allocate_port() {
  bun --eval 'const server = Bun.serve({ port: 0, fetch() { return new Response("ready"); } }); console.log(server.port); server.stop(true);'
}

if [[ -n "${S2_PORT:-}" ]]; then
  if [[ ! "${S2_PORT}" =~ ^[0-9]{2,5}$ ]] || (( S2_PORT < 1024 || S2_PORT > 65535 )); then
    printf '%s\n' '{"tool":"bash","package":"apps/wire","suite":"s2-krater-local-do","status":"fail","code":"S2_PORT_INVALID","reproduce":"scripts/e2e-s2-krater.sh"}'
    exit 1
  fi
else
  S2_PORT="$(allocate_port)"
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

stop_worker() {
  if [[ -n "${S2_SERVER_PID}" ]] && kill -0 "${S2_SERVER_PID}" 2>/dev/null; then
    kill "${S2_SERVER_PID}"
    if ! wait "${S2_SERVER_PID}"; then
      :
    fi
  fi
  S2_SERVER_PID=""
}

# shellcheck disable=SC2329
cleanup_workers() {
  local pid
  for pid in "${S2_SERVER_PIDS[@]}"; do
    if kill -0 "${pid}" 2>/dev/null; then
      kill "${pid}"
      if ! wait "${pid}"; then
        :
      fi
    fi
  done
  S2_SERVER_PID=""
}

trap cleanup_workers EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

start_worker() {
  "${S2_WRANGLER}" dev apps/wire/src/krater/worker.ts \
    --config "${S2_WRANGLER_CONFIG}" \
    --local \
    --persist-to "${S2_STATE_DIR}" \
    --port "${S2_PORT}" \
    --log-level error \
    --show-interactive-dev-session=false \
    >>"${S2_SERVER_LOG}" 2>&1 &
  S2_SERVER_PID=$!
  S2_SERVER_PIDS+=("${S2_SERVER_PID}")

  local ready=0
  local deadline=$((SECONDS + S2_READY_DEADLINE_SECONDS))
  while (( SECONDS < deadline )); do
    if curl --silent --connect-timeout 1 --max-time 1 --output /dev/null "${S2_ORIGIN}/__s2/cursor?problem_id=P-s2"; then
      ready=1
      break
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
    S2_ORIGIN="${S2_ORIGIN}" \
    S2_PHASE="${phase}" \
    S2_GIT_HEAD="${S2_GIT_HEAD}" \
    S2_GIT_DIRTY="${S2_GIT_DIRTY}" \
    S2_SOURCE_DIGEST="${S2_SOURCE_DIGEST}" \
    bun apps/wire/src/krater/s2-client.ts &
  local phase_pid=$!
  local deadline=$((SECONDS + S2_PHASE_DEADLINE_SECONDS))
  while kill -0 "${phase_pid}" 2>/dev/null; do
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

if ! "${S2_WRANGLER}" d1 migrations apply DB --config "${S2_WRANGLER_CONFIG}" --local --persist-to "${S2_STATE_DIR}" >"${S2_STATE_DIR}/migration.log" 2>&1; then
  emit_wrangler_failure "LOCAL_D1_MIGRATION_FAILED"
  exit 1
fi

if ! start_worker; then
  emit_wrangler_failure "LOCAL_WORKER_UNAVAILABLE"
  exit 1
fi

if run_phase "exercise"; then
  :
else
  S2_CLIENT_EXIT=$?
  stop_worker
  emit_wrangler_failure "LOCAL_D1_SCENARIO_FAILED"
  exit "${S2_CLIENT_EXIT}"
fi

if [[ "${S2_INTERRUPT_AFTER_READY:-0}" == "1" ]]; then
  emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-local-do","status":"interrupted","code":"S2_PLANTED_INTERRUPTED_RUN","reproduce":"S2_INTERRUPT_AFTER_READY=1 scripts/e2e-s2-krater.sh"}'
  kill -TERM "$$"
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

emit "{\"tool\":\"wrangler\",\"tool_version\":\"${S2_WRANGLER_VERSION}\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-local-do-alarm\",\"status\":\"pass\",\"bindings\":{\"d1\":\"DB\",\"durable_object\":\"KRATER_OUTBOX\"},\"reproduce\":\"scripts/e2e-s2-krater.sh\"}"
emit "{\"tool\":\"wrangler\",\"tool_version\":\"${S2_WRANGLER_VERSION}\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-deployed-do\",\"status\":\"blocked\",\"exit_code\":78,\"code\":\"DEPLOYED_DO_ENVIRONMENT_ABSENT\",\"blocked_on\":\"a deployed Worker with a configured Durable Object namespace and alarm telemetry\",\"forbidden_substitutes\":\"local-workerd behavior presented as deployed Durable Object proof\",\"reproduce\":\"scripts/e2e-s2-krater.sh\"}"
emit "{\"tool\":\"wrangler\",\"tool_version\":\"${S2_WRANGLER_VERSION}\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-edge-load\",\"status\":\"blocked\",\"exit_code\":78,\"code\":\"EDGE_CACHE_ENVIRONMENT_ABSENT\",\"blocked_on\":\"a staging edge-cache environment with D1 row-read and Worker CPU telemetry\",\"forbidden_substitutes\":\"a local curl loop, an in-process handler benchmark, or local-workerd timing presented as edge-load proof\",\"reproduce\":\"scripts/e2e-s2-krater.sh\"}"
exit 78
