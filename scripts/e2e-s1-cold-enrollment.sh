#!/usr/bin/env bash
# Fable §5.2 / S-1 cold-enrollment runner.
#
# This script deliberately keeps credentials in process memory and JSON POST
# bodies. It does not write artifacts: a token, fragment secret, or flow handle
# must never become a path, query string, log, or retained test result.
set -euo pipefail

readonly SUITE="s1-cold-enrollment"
readonly VERSION="1"
readonly REPRODUCE="scripts/e2e-s1-cold-enrollment.sh"
readonly BLOCKED_EXIT_CODE=78
readonly HARNESS_IDENTITIES=("claude-code" "codex" "gemini-cli")
readonly LOCAL_WRANGLER="apps/wire/node_modules/.bin/wrangler"
readonly LOCAL_PORT="${S1_LOCAL_PORT:-8792}"

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
      --header 'Accept: application/json' "$endpoint" 2>/dev/null)"; then
      failed "CAPSULE_REQUEST_FAILED"
    fi
  elif ! result="$(printf '%s' "$body" | curl --silent --fail-with-body \
    --request POST --header 'Accept: application/json' --header 'Content-Type: application/json' \
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

  diagnostic="$(emit "pass" "SELF_TEST_PASSED")"
  [[ "$diagnostic" != *"AAAAAAAA"* && "$diagnostic" != *"v1."* ]] || failed "SELF_TEST_REDACTION_FAILED"
  printf '%s\n' "$diagnostic"
}

run_local_d1() {
  [[ -x "$LOCAL_WRANGLER" ]] || blocked "WRANGLER_REQUIRED"
  local state_dir server_log server_pid origin ready client_exit
  state_dir="$(mktemp -d -t asimposium-s1-enrollment)"
  server_log="$state_dir/wrangler.log"
  server_pid=""
  origin="http://127.0.0.1:${LOCAL_PORT}"

  # The state directory is intentionally retained. It contains only local
  # workerd state and diagnostics; AGENTS.md forbids cleanup-by-deletion.
  [[ -d "$state_dir" && ! -L "$state_dir" ]] || failed "LOCAL_PERSIST_DIR_INVALID"
  if ! "$LOCAL_WRANGLER" d1 migrations apply DB --config infra/wrangler.toml --local \
    --persist-to "$state_dir" >"$state_dir/migrations.log" 2>&1; then
    failed "LOCAL_D1_MIGRATION_FAILED"
  fi

  "$LOCAL_WRANGLER" dev apps/wire/src/enrollment/local-d1-worker.ts \
    --config infra/wrangler.toml --local --persist-to "$state_dir" --port "$LOCAL_PORT" \
    --log-level error --show-interactive-dev-session=false >>"$server_log" 2>&1 &
  server_pid="$!"
  ready=0
  for _attempt in {1..30}; do
    if curl --silent --output /dev/null "$origin/join/ASIMP-EN-INVALID"; then
      ready=1
      break
    fi
    sleep 0.2
  done
  if [[ "$ready" -ne 1 ]]; then
    if kill -0 "$server_pid" 2>/dev/null; then kill "$server_pid"; fi
    failed "LOCAL_WORKER_UNAVAILABLE"
  fi

  if env S1_LOCAL_ORIGIN="$origin" bun apps/wire/src/enrollment/local-d1-client.ts; then
    :
  else
    client_exit=$?
    if kill -0 "$server_pid" 2>/dev/null; then kill "$server_pid"; fi
    if ! wait "$server_pid"; then :; fi
    exit "$client_exit"
  fi
  if kill -0 "$server_pid" 2>/dev/null; then kill "$server_pid"; fi
  if ! wait "$server_pid"; then :; fi
  emit "pass" "LOCAL_D1_ENROLLMENT_PASSED"
}

main() {
  require_tooling
  if [[ "${1:-}" == "--self-test" ]]; then
    self_test
    return
  fi
  if [[ "${1:-}" == "--local-d1" ]]; then
    run_local_d1
    return
  fi

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
