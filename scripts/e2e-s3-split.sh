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

duration_ms() {
  printf '%s' "$(( (SECONDS - STARTED_SECONDS) * 1000 ))"
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
readonly S3_RUN_TOKEN="s3-$$-${RANDOM}-${RANDOM}"

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

STATE_DIR="$(mktemp -d -t asimposium-s3-local)"
readonly STATE_DIR
readonly SERVER_LOG="${STATE_DIR}/wrangler.log"
readonly CHECK_LOG="${STATE_DIR}/check.log"
if [[ ! -d "${STATE_DIR}" || -L "${STATE_DIR}" ]]; then
  emit '{"tool":"bash","package":"@asimposium/wire","suite":"s3-local-bindings","status":"fail","code":"LOCAL_PERSIST_DIR_INVALID","reproduce":"bash scripts/e2e-s3-split.sh"}'
  exit 1
fi

SERVER_PID=""
stop_worker() {
  [[ -n "${SERVER_PID}" ]] || return 0
  if kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill -TERM "-${SERVER_PID}" 2>/dev/null || kill -TERM "${SERVER_PID}" 2>/dev/null
    for _wait in {1..30}; do
      kill -0 "${SERVER_PID}" 2>/dev/null || break
      sleep 0.1
    done
  fi
  if kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill -KILL "-${SERVER_PID}" 2>/dev/null || kill -KILL "${SERVER_PID}" 2>/dev/null
  fi
  if ! wait "${SERVER_PID}" 2>/dev/null; then :; fi
  SERVER_PID=""
}

show_redacted() {
  local label="$1" file="$2"
  local -a expressions=(-e "s|${PWD}|<repo>|g")
  if [[ -n "${HOME:-}" ]]; then expressions+=(-e "s|${HOME}|<home>|g"); fi
  printf '%s\n' "--- ${label} (redacted) ---" >&2
  sed "${expressions[@]}" \
      -e 's|asimp_ag_[A-Za-z0-9_-]\{4,\}|<redacted>|g' \
      -e 's|#v1\.[A-Za-z0-9._~-]\{8,\}|<redacted>|g' \
      "${file}" | head -n 80 >&2
  printf '%s\n' "--- end ${label} ---" >&2
}

trap stop_worker EXIT
trap 'stop_worker; exit 130' INT
trap 'stop_worker; exit 143' TERM
trap 'stop_worker; exit 129' HUP

set -m
"${WRANGLER}" dev "${ENTRYPOINT}" \
  --config "${CONFIG}" \
  --local \
  --persist-to "${STATE_DIR}" \
  --port "${S3_PORT}" \
  --inspector-port 0 \
  --log-level error \
  --show-interactive-dev-session=false \
  --var "S3_RUN_TOKEN:${S3_RUN_TOKEN}" \
  >"${SERVER_LOG}" 2>&1 &
SERVER_PID=$!
set +m

ready=0
for _attempt in {1..60}; do
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then break; fi
  health="$(curl --silent --fail --connect-timeout 1 --max-time 1 "${ORIGIN}/__s3/health" 2>/dev/null || true)"
  if [[ "${health}" == *"\"run_token\":\"${S3_RUN_TOKEN}\""* ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    ready=1
    break
  fi
  sleep 0.25
done
if [[ ${ready} -ne 1 ]]; then
  show_redacted "wrangler" "${SERVER_LOG}"
  emit "{\"tool\":\"wrangler\",\"tool_version\":\"${WRANGLER_VERSION}\",\"package\":\"@asimposium/wire\",\"suite\":\"s3-local-bindings\",\"duration_ms\":$(duration_ms),\"status\":\"fail\",\"code\":\"LOCAL_WORKER_UNAVAILABLE\",\"reproduce\":\"${REPRODUCE}\"}"
  exit 1
fi

S3_LOCAL_ORIGIN="${ORIGIN}" bun "${CHECKER}" >"${CHECK_LOG}" 2>&1 &
CHECKER_PID=$!
checker_deadline=$((SECONDS + CHECKER_DEADLINE_SECONDS))
while kill -0 "${CHECKER_PID}" 2>/dev/null; do
  if (( SECONDS >= checker_deadline )); then
    kill -TERM "${CHECKER_PID}" 2>/dev/null || true
    if ! wait "${CHECKER_PID}" 2>/dev/null; then :; fi
    show_redacted "local binding checker" "${CHECK_LOG}"
    show_redacted "wrangler" "${SERVER_LOG}"
    emit "{\"tool\":\"wrangler+bun\",\"tool_version\":\"${WRANGLER_VERSION}\",\"package\":\"@asimposium/wire\",\"suite\":\"s3-local-bindings\",\"duration_ms\":$(duration_ms),\"status\":\"fail\",\"code\":\"LOCAL_SPLIT_CHECKER_TIMEOUT\",\"reproduce\":\"${REPRODUCE}\"}"
    exit 1
  fi
  sleep 0.1
done
if ! wait "${CHECKER_PID}" 2>/dev/null; then
  show_redacted "local binding checker" "${CHECK_LOG}"
  show_redacted "wrangler" "${SERVER_LOG}"
  emit "{\"tool\":\"wrangler+bun\",\"tool_version\":\"${WRANGLER_VERSION}\",\"package\":\"@asimposium/wire\",\"suite\":\"s3-local-bindings\",\"duration_ms\":$(duration_ms),\"status\":\"fail\",\"code\":\"LOCAL_SPLIT_ASSERTION_FAILED\",\"reproduce\":\"${REPRODUCE}\"}"
  exit 1
fi
cat "${CHECK_LOG}"
stop_worker

emit "{\"tool\":\"wrangler+bun\",\"tool_version\":\"${WRANGLER_VERSION}\",\"package\":\"@asimposium/wire\",\"suite\":\"s3-local-bindings\",\"duration_ms\":$(duration_ms),\"status\":\"pass\",\"bindings\":{\"d1\":\"DB\",\"r2\":\"ARTIFACTS\"},\"reproduce\":\"${REPRODUCE}\"}"
emit "{\"tool\":\"wrangler\",\"tool_version\":\"${WRANGLER_VERSION}\",\"package\":\"@asimposium/wire\",\"suite\":\"s3-staging-paired-principal\",\"duration_ms\":$(duration_ms),\"status\":\"blocked\",\"exit_code\":78,\"code\":\"S3_STAGING_ENVIRONMENT_ABSENT\",\"blocked_on\":\"a deployed staging Worker with Propylon authentication, a configured R2 namespace, and a paired sponsor plus anonymous browser proof\",\"forbidden_substitutes\":\"local-workerd behavior presented as staging proof, test headers as OAuth proof, or in-memory SplitService tests as D1/R2 evidence\",\"reproduce\":\"${REPRODUCE}\"}"
printf '%s\n' 'BLOCKED s3-staging-paired-principal (exit 78): staging identity and paired-browser proof are not configured' >&2
exit "${BLOCKED_EXIT}"
