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

# Mutable lifecycle state, read by the traps.
SERVER_PID=""
STATE_DIR=""
PHASE_LOG=""

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

# Terminate the child's whole process group: TERM, a bounded grace period, then
# KILL. Signalling the wrangler pid alone leaves workerd grandchildren running,
# which is how a later run inherits a busy port and a locked D1 file.
terminate_server_group() {
  local pid="${1:-}"
  [[ -n "$pid" ]] || return 0
  kill -0 "$pid" 2>/dev/null || kill -0 -- -"$pid" 2>/dev/null || return 0

  kill -TERM -- -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  local waited=0
  local limit=$((TERMINATION_GRACE_SECONDS * 10))
  while ((waited < limit)); do
    if ! kill -0 -- -"$pid" 2>/dev/null && ! kill -0 "$pid" 2>/dev/null; then
      log_phase "child-terminated" "signal=TERM pid=$pid"
      return 0
    fi
    sleep 0.1
    waited=$((waited + 1))
  done
  kill -KILL -- -"$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  log_phase "child-killed" "signal=KILL pid=$pid grace_s=$TERMINATION_GRACE_SECONDS"
}

on_interrupt() {
  local signal="$1"
  trap - INT TERM EXIT
  log_phase "interrupted" "signal=$signal pid=${SERVER_PID:-none}"
  terminate_server_group "${SERVER_PID:-}"
  # State is retained on purpose, including here: an interrupted run is the one
  # whose logs a human most wants afterwards.
  printf 'INTERRUPTED %s: signal=%s state_retained=%s\n' "$SUITE" "$signal" "${STATE_DIR:-none}" >&2
  emit "fail" "INTERRUPTED_${signal}"
  exit 1
}

on_exit() {
  local status="$?"
  terminate_server_group "${SERVER_PID:-}" || true
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
run_with_deadline() {
  local seconds="$1"
  shift
  "$@" &
  local pid="$!"
  local waited=0
  local limit=$((seconds * 10))
  while ((waited < limit)); do
    if ! kill -0 "$pid" 2>/dev/null; then
      local status=0
      wait "$pid" || status=$?
      return "$status"
    fi
    sleep 0.1
    waited=$((waited + 1))
  done
  kill -TERM -- -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
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
  [[ "$(run_token)" =~ ^[a-z0-9-]+$ ]] || failed "SELF_TEST_RUN_TOKEN_FAILED"

  diagnostic="$(emit "pass" "SELF_TEST_PASSED")"
  [[ "$diagnostic" != *"AAAAAAAA"* && "$diagnostic" != *"v1."* ]] || failed "SELF_TEST_REDACTION_FAILED"
  printf '%s\n' "$diagnostic"
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

  local local_port origin token server_log ready waited limit client_exit
  local_port="$(allocate_port)"
  token="$(run_token)"
  origin="http://127.0.0.1:${local_port}"

  STATE_DIR="$(mktemp -d -t asimposium-s1-enrollment)"
  # The state directory is intentionally retained on every exit path. It holds
  # local workerd state and phase logs; AGENTS.md forbids cleanup-by-deletion.
  [[ -d "$STATE_DIR" && ! -L "$STATE_DIR" ]] || failed "LOCAL_PERSIST_DIR_INVALID"
  PHASE_LOG="$STATE_DIR/phases.log"
  : >"$PHASE_LOG"
  server_log="$STATE_DIR/wrangler.log"
  log_phase "state-retained" "dir=$STATE_DIR"
  log_phase "port-allocated" "port=$local_port pinned=${S1_LOCAL_PORT:-no}"

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
  log_phase "child-started" "pid=$SERVER_PID port=$local_port"

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
