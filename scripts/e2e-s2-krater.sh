#!/usr/bin/env bash
# Local, real-D1 S-2 harness. This never contacts a remote Cloudflare resource.
# Its unique local persistence directory is intentionally retained: AGENTS.md
# forbids deleting test files and this script must not make a green run depend
# on cleanup. It returns 78 after local D1 proof because the required Durable
# Object alarm and edge-cache load environments are not configured at OPS.1.

set -uo pipefail

readonly S2_WRANGLER="apps/wire/node_modules/.bin/wrangler"
readonly S2_PORT="${S2_PORT:-8791}"
readonly S2_STATE_DIR="$(mktemp -d -t asimposium-s2-krater)"
readonly S2_SERVER_LOG="${S2_STATE_DIR}/wrangler.log"
readonly S2_ORIGIN="http://127.0.0.1:${S2_PORT}"

emit() {
  printf '%s\n' "$1"
}

if [[ ! -x "${S2_WRANGLER}" ]]; then
  emit '{"tool":"wrangler","package":"apps/wire","suite":"s2-krater-local-d1","status":"fail","code":"WRANGLER_UNAVAILABLE","reproduce":"scripts/e2e-s2-krater.sh"}'
  exit 1
fi
readonly S2_WRANGLER_VERSION="$("${S2_WRANGLER}" --version)"

if ! "${S2_WRANGLER}" d1 migrations apply DB --config infra/wrangler.toml --local --persist-to "${S2_STATE_DIR}" >"${S2_STATE_DIR}/migration.log" 2>&1; then
  emit "{\"tool\":\"wrangler\",\"tool_version\":\"${S2_WRANGLER_VERSION}\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-local-d1\",\"status\":\"fail\",\"code\":\"LOCAL_D1_MIGRATION_FAILED\",\"reproduce\":\"scripts/e2e-s2-krater.sh\"}"
  exit 1
fi

"${S2_WRANGLER}" dev apps/wire/src/krater/worker.ts \
  --config infra/wrangler.toml \
  --local \
  --persist-to "${S2_STATE_DIR}" \
  --port "${S2_PORT}" \
  --log-level error \
  --show-interactive-dev-session=false \
  >"${S2_SERVER_LOG}" 2>&1 &
readonly S2_SERVER_PID=$!

ready=0
for _attempt in {1..30}; do
  if curl --silent --output /dev/null "${S2_ORIGIN}/__s2/cursor?problem_id=P-s2"; then
    ready=1
    break
  fi
  sleep 0.2
done

if [[ ${ready} -ne 1 ]]; then
  if kill -0 "${S2_SERVER_PID}" 2>/dev/null; then
    kill "${S2_SERVER_PID}"
    wait "${S2_SERVER_PID}"
  fi
  emit "{\"tool\":\"wrangler\",\"tool_version\":\"${S2_WRANGLER_VERSION}\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-local-d1\",\"status\":\"fail\",\"code\":\"LOCAL_WORKER_UNAVAILABLE\",\"reproduce\":\"scripts/e2e-s2-krater.sh\"}"
  exit 1
fi

env S2_ORIGIN="${S2_ORIGIN}" bun apps/wire/src/krater/s2-client.ts
readonly S2_CLIENT_EXIT=$?

if kill -0 "${S2_SERVER_PID}" 2>/dev/null; then
  kill "${S2_SERVER_PID}"
  wait "${S2_SERVER_PID}"
fi

if [[ ${S2_CLIENT_EXIT} -ne 0 ]]; then
  emit "{\"tool\":\"wrangler\",\"tool_version\":\"${S2_WRANGLER_VERSION}\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-local-d1\",\"status\":\"fail\",\"code\":\"LOCAL_D1_SCENARIO_FAILED\",\"reproduce\":\"scripts/e2e-s2-krater.sh\"}"
  exit "${S2_CLIENT_EXIT}"
fi

emit "{\"tool\":\"wrangler\",\"tool_version\":\"${S2_WRANGLER_VERSION}\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-do-alarm\",\"status\":\"blocked\",\"exit_code\":78,\"code\":\"DO_ALARM_BINDING_ABSENT\",\"blocked_on\":\"a configured Durable Object namespace and alarm class in the Worker environment\",\"forbidden_substitutes\":\"a mocked Durable Object, a timer, or a claimed outbox drain without a Durable Object alarm\",\"reproduce\":\"scripts/e2e-s2-krater.sh\"}"
emit "{\"tool\":\"wrangler\",\"tool_version\":\"${S2_WRANGLER_VERSION}\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-edge-load\",\"status\":\"blocked\",\"exit_code\":78,\"code\":\"EDGE_CACHE_ENVIRONMENT_ABSENT\",\"blocked_on\":\"a staging edge-cache environment with D1 row-read and Worker CPU telemetry\",\"forbidden_substitutes\":\"a local curl loop, an in-process handler benchmark, or local-workerd timing presented as edge-load proof\",\"reproduce\":\"scripts/e2e-s2-krater.sh\"}"
exit 78
