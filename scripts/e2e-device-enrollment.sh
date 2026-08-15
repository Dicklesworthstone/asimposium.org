#!/usr/bin/env bash
# Mock-free W3.5 device enrollment: curl is the unaffiliated agent and a real
# Playwright browser is the sponsor. Secret-bearing values stay in shell memory
# or stdin pipes; diagnostics contain only short SHA-256 correlation digests.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=e2e/lib/run-diagnostics.sh
source "$repository_root/e2e/lib/run-diagnostics.sh"
cd "$repository_root"

suite="device-enrollment-e2e"
reproduce="bash scripts/e2e-device-enrollment.sh"
readonly runner="$repository_root/e2e/playwright/device-enrollment-runner.ts"
readonly max_response_bytes=131072
proposal_ttl_seconds=0
started_ms="$(e2e_now_ms)"
self_test=0
write_artifacts=0
explicit_run_id=""
scenario="approve"
run_id=""
run_digest=""

HTTP_BODY=""
HTTP_STATUS=""
HTTP_DURATION_MS=0
START_DEVICE_CODE=""
START_USER_CODE=""
START_INTERVAL_SECONDS=0
START_EXPIRES_SECONDS=0
POLL_STATUS=""
POLL_RETRY_SECONDS=""
POLL_TOKEN=""

usage_failure() {
  e2e_emit_diagnostic "$suite" "$started_ms" "fail" "$1" "$reproduce"
  exit 64
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --self-test)
      self_test=1
      ;;
    --write-artifacts)
      write_artifacts=1
      ;;
    --run-id)
      [[ "$#" -ge 2 ]] || usage_failure "RUN_ID_MISSING"
      explicit_run_id="$2"
      shift
      ;;
    --scenario)
      [[ "$#" -ge 2 ]] || usage_failure "SCENARIO_MISSING"
      scenario="$2"
      shift
      ;;
    *)
      usage_failure "UNKNOWN_ARGUMENT"
      ;;
  esac
  shift
done

case "$scenario" in
  all | approve | code-expired | deny | fast-poll | proposal-expired | reduce | wrong-code | wrong-sponsor) ;;
  *) usage_failure "SCENARIO_INVALID" ;;
esac
if [[ "$self_test" -eq 1 ]]; then
  reproduce="bash scripts/e2e-device-enrollment.sh --self-test"
else
  reproduce="bash scripts/e2e-device-enrollment.sh --scenario $scenario"
fi

run_id="$(e2e_resolve_run_id "$suite" "$explicit_run_id")" || usage_failure "RUN_ID_INVALID"
if [[ "$write_artifacts" -eq 1 ]] \
  && ! e2e_claim_artifact_run_at_root "$repository_root" "$run_id"; then
  e2e_emit_diagnostic "$suite" "$started_ms" "blocked" "ARTIFACT_RUN_ALREADY_EXISTS" "$reproduce"
  exit 78
fi

final_record() {
  local status="$1"
  local code="$2"
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "$status" "$code" "$reproduce"
}

fail() {
  final_record "fail" "$1"
  exit 1
}

blocked() {
  final_record "blocked" "$1"
  exit 78
}

persist_safe_step() {
  local record="$1"
  if [[ "$write_artifacts" -eq 1 ]]; then
    e2e_append_artifact_jsonl_at_root "$repository_root" "$run_id" "steps.jsonl" "$record" >/dev/null \
      || fail "ARTIFACT_STEP_WRITE_FAILED"
  fi
}

validate_browser_record() {
  local record="$1"
  local expected_scenario="$2"
  local expected_code="$3"
  local process_status="$4"
  printf '%s\n%s\n%s\n%s' "$expected_scenario" "$expected_code" "$process_status" "$record" \
    | bun -e '
      try {
        const lines = (await Bun.stdin.text()).split("\n");
        if (lines.length !== 4) process.exit(1);
        const [scenario, expectedCode, processStatus, json] = lines;
        const value = JSON.parse(json);
        const keys = Object.keys(value).sort().join(",");
        const expectedKeys = ["code", "console_error_count", "device_digest", "duration_ms", "event_id", "flow_digest", "package", "page_error_count", "proposal_digest", "request_id", "scenario", "screenshot_policy", "status", "suite", "tool", "trace_policy", "ts"].sort().join(",");
        const expectedStatus = processStatus === "0" ? "pass" : processStatus === "78" ? "blocked" : "fail";
        const digestValid = (digest) => digest === null || (typeof digest === "string" && /^[0-9a-f]{12}$/.test(digest));
        if (keys !== expectedKeys || typeof value.ts !== "string" || Number.isNaN(Date.parse(value.ts)) || value.tool !== "playwright" || value.package !== "e2e" || value.suite !== "device-enrollment-browser" || value.scenario !== scenario || value.status !== expectedStatus || typeof value.code !== "string" || !/^[A-Z0-9_]+$/.test(value.code) || !Number.isSafeInteger(value.duration_ms) || value.duration_ms < 0 || value.request_id !== null || value.event_id !== null || value.device_digest !== null || !digestValid(value.proposal_digest) || value.flow_digest !== null || !Number.isSafeInteger(value.console_error_count) || value.console_error_count < 0 || !Number.isSafeInteger(value.page_error_count) || value.page_error_count < 0 || value.screenshot_policy !== "disabled" || value.trace_policy !== "disabled") process.exit(1);
        if (processStatus === "0" && value.code !== expectedCode) process.exit(1);
      } catch { process.exit(1); }
    '
}

sha256_prefix() {
  bun -e 'const value = await Bun.stdin.text(); const hash = new Bun.CryptoHasher("sha256").update(value).digest("hex"); process.stdout.write(hash.slice(0, 12));'
}

storage_state_safe() {
  printf '%s' "$1" | bun -e '
    import { lstatSync, readFileSync } from "node:fs";
    try {
      const path = await Bun.stdin.text();
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 1_048_576 || (stat.mode & 0o077) !== 0) process.exit(1);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || !Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins)) process.exit(1);
    } catch { process.exit(1); }
  '
}

command -v bun >/dev/null 2>&1 || blocked "E2E_DEPENDENCY_UNAVAILABLE"
proposal_ttl_seconds="$(
  bun -e 'import { PENDING_PROPOSAL_TTL_MS } from "@asimposium/contracts"; process.stdout.write(String(PENDING_PROPOSAL_TTL_MS / 1_000));'
)" || blocked "E2E_CONTRACT_UNAVAILABLE"
[[ "$proposal_ttl_seconds" =~ ^[1-9][0-9]*$ ]] || blocked "E2E_CONTRACT_INVALID"
readonly proposal_ttl_seconds
run_digest="$(printf '%s' "$run_id" | sha256_prefix)" || usage_failure "RUN_ID_DIGEST_FAILED"

emit_step() {
  local step_scenario="$1"
  local step="$2"
  local status="$3"
  local code="$4"
  local http_status="$5"
  local duration_ms="$6"
  local request_id="$7"
  local device_digest="$8"
  local flow_digest="$9"
  local event_id="null"
  local record

  [[ "$step_scenario" =~ ^[a-z-]+$ ]] || fail "DIAGNOSTIC_FIELD_INVALID"
  [[ "$step" =~ ^[a-z-]+$ ]] || fail "DIAGNOSTIC_FIELD_INVALID"
  [[ "$status" =~ ^(pass|fail|blocked|start)$ ]] || fail "DIAGNOSTIC_FIELD_INVALID"
  [[ "$code" =~ ^[A-Z0-9_]+$ ]] || fail "DIAGNOSTIC_FIELD_INVALID"
  [[ "$http_status" =~ ^([0-9]{3}|null)$ ]] || fail "DIAGNOSTIC_FIELD_INVALID"
  [[ "$duration_ms" =~ ^[0-9]+$ ]] || fail "DIAGNOSTIC_FIELD_INVALID"
  [[ "$request_id" =~ ^[A-Za-z0-9._-]{1,160}$ ]] || fail "DIAGNOSTIC_FIELD_INVALID"
  [[ "$device_digest" == "null" ]] || fail "DIAGNOSTIC_FIELD_INVALID"
  [[ "$flow_digest" =~ ^([0-9a-f]{12}|null)$ ]] || fail "DIAGNOSTIC_FIELD_INVALID"

  printf -v record '{"ts":"%s","tool":"curl","package":"e2e","suite":"%s","scenario":"%s","step":"%s","status":"%s","code":"%s","http_status":%s,"duration_ms":%s,"request_id":"%s","event_id":%s,"device_digest":%s,"flow_digest":%s}' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$suite" "$step_scenario" "$step" "$status" "$code" \
    "$http_status" "$duration_ms" "$request_id" "$event_id" \
    "$([[ "$device_digest" == "null" ]] && printf 'null' || printf '"%s"' "$device_digest")" \
    "$([[ "$flow_digest" == "null" ]] && printf 'null' || printf '"%s"' "$flow_digest")"
  printf '%s\n' "$record"
  persist_safe_step "$record"
}

safe_request_id() {
  local step_scenario="$1"
  local step="$2"
  printf 'req-e2e-%s-%s-%s\n' "$run_digest" "$step_scenario" "$step"
}

http_post_json() {
  local origin="$1"
  local path="$2"
  local body="$3"
  local request_id="$4"
  local idempotency_key="${5:-}"
  local request_started
  local combined
  local curl_status
  local -a headers

  headers=(--header "content-type: application/json" --header "x-request-id: $request_id")
  if [[ -n "$idempotency_key" ]]; then
    headers+=(--header "idempotency-key: $idempotency_key")
  fi
  request_started="$(e2e_now_ms)"
  set +e
  combined="$(
    printf '%s' "$body" | curl --disable --silent --show-error \
      --connect-timeout 5 --max-time 20 --max-filesize "$max_response_bytes" --request POST \
      "${headers[@]}" --data-binary @- --write-out $'\n%{http_code}' \
      "$origin$path" 2>/dev/null
  )"
  curl_status=$?
  set -e
  HTTP_DURATION_MS="$(e2e_elapsed_ms "$request_started")"
  [[ "$curl_status" -eq 0 ]] || return 1
  [[ "$combined" == *$'\n'* ]] || return 1
  HTTP_STATUS="${combined##*$'\n'}"
  HTTP_BODY="${combined%$'\n'*}"
  [[ "$HTTP_STATUS" =~ ^[0-9]{3}$ ]] || return 1
  [[ "${#HTTP_BODY}" -le "$max_response_bytes" ]] || return 1
}

http_hello() {
  local origin="$1"
  local token="$2"
  local request_id="$3"
  local request_started
  local combined
  local curl_status

  request_started="$(e2e_now_ms)"
  set +e
  combined="$(
    printf 'header = "Authorization: Bearer %s"\nheader = "x-request-id: %s"\n' "$token" "$request_id" \
      | curl --disable --silent --show-error --config - \
        --connect-timeout 5 --max-time 20 --max-filesize "$max_response_bytes" \
        --write-out $'\n%{http_code}' \
        "$origin/v1/hello" 2>/dev/null
  )"
  curl_status=$?
  set -e
  HTTP_DURATION_MS="$(e2e_elapsed_ms "$request_started")"
  [[ "$curl_status" -eq 0 ]] || return 1
  [[ "$combined" == *$'\n'* ]] || return 1
  HTTP_STATUS="${combined##*$'\n'}"
  HTTP_BODY="${combined%$'\n'*}"
  [[ "$HTTP_STATUS" =~ ^[0-9]{3}$ ]] || return 1
  [[ "${#HTTP_BODY}" -le "$max_response_bytes" ]] || return 1
}

parse_start_response() {
  local parsed
  parsed="$(
    printf '%s' "$HTTP_BODY" | bun -e '
      import { DeviceCodeStartResponseSchema } from "@asimposium/contracts";
      try {
        const value = DeviceCodeStartResponseSchema.parse(JSON.parse(await Bun.stdin.text()));
        process.stdout.write([value.device_code, value.user_code, value.interval_seconds, value.expires_in_seconds].join("|"));
      } catch { process.exit(1); }
    '
  )" || return 1
  IFS='|' read -r START_DEVICE_CODE START_USER_CODE START_INTERVAL_SECONDS START_EXPIRES_SECONDS <<< "$parsed"
  [[ "$START_DEVICE_CODE" =~ ^flow_v1\.[A-Za-z0-9_-]{43}$ ]]
  [[ "$START_USER_CODE" =~ ^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTVWXYZ23456789]{4}$ ]]
  [[ "$START_INTERVAL_SECONDS" =~ ^[1-9][0-9]*$ ]]
  [[ "$START_EXPIRES_SECONDS" =~ ^[1-9][0-9]*$ ]]
}

parse_poll_response() {
  local parsed
  parsed="$(
    printf '%s' "$HTTP_BODY" | bun -e '
      import {
        EnrollmentApprovedResponseSchema,
        EnrollmentDeniedResponseSchema,
        EnrollmentExpiredResponseSchema,
        EnrollmentPendingResponseSchema,
        EnrollmentSlowDownResponseSchema,
      } from "@asimposium/contracts";
      try {
        const raw = JSON.parse(await Bun.stdin.text());
        const schemas = [EnrollmentApprovedResponseSchema, EnrollmentDeniedResponseSchema, EnrollmentExpiredResponseSchema, EnrollmentPendingResponseSchema, EnrollmentSlowDownResponseSchema];
        const parsed = schemas.map((schema) => schema.safeParse(raw)).find((result) => result.success);
        if (parsed === undefined || !parsed.success) process.exit(1);
        const value = parsed.data;
        const retry = "retry_after_seconds" in value ? String(value.retry_after_seconds) : "";
        const token = "token" in value ? value.token : "";
        process.stdout.write([value.status, retry, token].join("|"));
      } catch { process.exit(1); }
    '
  )" || return 1
  IFS='|' read -r POLL_STATUS POLL_RETRY_SECONDS POLL_TOKEN <<< "$parsed"
}

validate_hello_response() {
  local expected_name="$1"
  local expected_model="$2"
  local expected_harness="$3"
  local expected_scopes="$4"
  printf '%s\n%s\n%s\n%s\n%s' "$expected_name" "$expected_model" "$expected_harness" "$expected_scopes" "$HTTP_BODY" \
    | bun -e '
      import { EnrollmentHelloResponseSchema } from "@asimposium/contracts";
      try {
        const lines = (await Bun.stdin.text()).split("\n");
        if (lines.length < 5) process.exit(1);
        const [name, model, harness, scopes, ...jsonLines] = lines;
        const value = EnrollmentHelloResponseSchema.parse(JSON.parse(jsonLines.join("\n")));
        if (value.fellow.name !== name || value.fellow.model !== model || value.fellow.harness !== harness) process.exit(1);
        if (value.granted_scopes.join(",") !== scopes) process.exit(1);
      } catch { process.exit(1); }
    '
}

next_name() {
  local step_scenario="$1"
  local suffix
  suffix="$(bun -e 'process.stdout.write(crypto.randomUUID().replaceAll("-", "").slice(0, 8))')" || fail "RANDOM_ID_UNAVAILABLE"
  printf 'device-%s-%s\n' "${step_scenario:0:8}" "$suffix"
}

start_device() {
  local step_scenario="$1"
  local name="$2"
  local scopes="$3"
  local request_id
  local request_body
  local flow_digest
  local observed_code

  request_id="$(safe_request_id "$step_scenario" "start")"
  request_body="$(printf '{"name":"%s","model":"e2e/device-contract","harness":"curl-playwright","requested_scopes":[%s]}' "$name" "$scopes")"
  http_post_json "$ASIMPOSIUM_STAGING_AGENT_BASE_URL" "/v1/device-code" "$request_body" "$request_id" \
    || fail "DEVICE_START_UNREACHABLE"
  if [[ "$HTTP_STATUS" != "201" ]] || ! parse_start_response; then
    emit_step "$step_scenario" "device-start" "fail" "DEVICE_START_CONTRACT_FAILED" "$HTTP_STATUS" "$HTTP_DURATION_MS" "$request_id" "null" "null"
    fail "DEVICE_START_CONTRACT_FAILED"
  fi
  flow_digest="$(printf '%s' "$START_DEVICE_CODE" | sha256_prefix)" || fail "DIGEST_FAILED"
  emit_step "$step_scenario" "device-start" "pass" "DEVICE_CODE_ISSUED" "$HTTP_STATUS" "$HTTP_DURATION_MS" "$request_id" "null" "$flow_digest"
}

poll_device() {
  local step_scenario="$1"
  local step="$2"
  local expected_status="$3"
  local request_id
  local request_body
  local flow_digest

  request_id="$(safe_request_id "$step_scenario" "$step")"
  request_body="$(printf '{"flow_handle":"%s"}' "$START_DEVICE_CODE")"
  http_post_json "$ASIMPOSIUM_STAGING_AGENT_BASE_URL" "/v1/device-token" "$request_body" "$request_id" "idem-$request_id" \
    || fail "DEVICE_POLL_UNREACHABLE"
  flow_digest="$(printf '%s' "$START_DEVICE_CODE" | sha256_prefix)" || fail "DIGEST_FAILED"
  if [[ "$HTTP_STATUS" != "200" ]] || ! parse_poll_response || [[ "$POLL_STATUS" != "$expected_status" ]]; then
    emit_step "$step_scenario" "$step" "fail" "DEVICE_POLL_CONTRACT_FAILED" "$HTTP_STATUS" "$HTTP_DURATION_MS" "$request_id" "null" "$flow_digest"
    fail "DEVICE_POLL_CONTRACT_FAILED"
  fi
  if [[ "$POLL_STATUS" == "authorization_pending" || "$POLL_STATUS" == "slow_down" ]]; then
    [[ "$POLL_RETRY_SECONDS" =~ ^[1-9][0-9]*$ ]] || fail "DEVICE_POLL_CONTRACT_FAILED"
  elif [[ -n "$POLL_RETRY_SECONDS" ]]; then
    fail "DEVICE_POLL_CONTRACT_FAILED"
  fi
  observed_code="DEVICE_POLL_${POLL_STATUS^^}"
  emit_step "$step_scenario" "$step" "pass" "$observed_code" "$HTTP_STATUS" "$HTTP_DURATION_MS" "$request_id" "null" "$flow_digest"
}

run_browser() {
  local step_scenario="$1"
  local mode="$2"
  local storage_path="$3"
  local name="$4"
  local scopes_csv="$5"
  local browser_output
  local browser_status

  set +e
  browser_output="$(
    printf '%s\n%s\n%s\n%s\n%s\n' "$START_USER_CODE" "$name" "e2e/device-contract" "curl-playwright" "$scopes_csv" \
      | ASIMPOSIUM_DEVICE_E2E_STORAGE_STATE="$storage_path" \
        bun "$runner" "$mode" 2>/dev/null
  )"
  browser_status=$?
  set -e
  if [[ "$browser_output" == *"$START_USER_CODE"* \
    || "$browser_output" == *"$START_DEVICE_CODE"* \
    || "$browser_output" == *"$name"* \
    || "$browser_output" == *"e2e/device-contract"* \
    || "$browser_output" == *"curl-playwright"* \
    || "$browser_output" == *"asimp_ag_"* \
    || "$browser_output" == *"https://"* ]]; then
    fail "BROWSER_DIAGNOSTIC_LEAK"
  fi
  [[ -n "$browser_output" && "$browser_output" != *$'\n'* ]] || fail "BROWSER_DIAGNOSTIC_MISSING"
  validate_browser_record \
    "$browser_output" \
    "$mode" \
    "$([[ "$mode" == "lookup-rejected" ]] && printf 'DEVICE_LOOKUP_REJECTED' || printf 'DEVICE_DECISION_UI_CONFIRMED')" \
    "$browser_status" \
    || fail "BROWSER_DIAGNOSTIC_INVALID"
  printf '%s\n' "$browser_output"
  persist_safe_step "$browser_output"
  case "$browser_status" in
    0) return 0 ;;
    78) blocked "BROWSER_DEVICE_FLOW_BLOCKED" ;;
    *) fail "BROWSER_DEVICE_FLOW_FAILED" ;;
  esac
}

assert_distinct_sponsors() {
  local browser_output
  local browser_status

  set +e
  browser_output="$(
    ASIMPOSIUM_DEVICE_E2E_STORAGE_STATE="$ASIMPOSIUM_DEVICE_E2E_STORAGE_STATE" \
      ASIMPOSIUM_DEVICE_E2E_SECOND_STORAGE_STATE="$ASIMPOSIUM_DEVICE_E2E_SECOND_STORAGE_STATE" \
      bun "$runner" assert-distinct-sponsors 2>/dev/null
  )"
  browser_status=$?
  set -e
  if [[ "$browser_output" == *"asimp_ag_"* \
    || "$browser_output" == *"https://"* \
    || "$browser_output" == *"@"* \
    || "$browser_output" == *"/Users/"* ]]; then
    fail "SPONSOR_PREFLIGHT_DIAGNOSTIC_LEAK"
  fi
  [[ -n "$browser_output" && "$browser_output" != *$'\n'* ]] || fail "SPONSOR_PREFLIGHT_DIAGNOSTIC_MISSING"
  validate_browser_record \
    "$browser_output" \
    "sponsor-preflight" \
    "DISTINCT_SPONSOR_SESSIONS_VERIFIED" \
    "$browser_status" \
    || fail "SPONSOR_PREFLIGHT_DIAGNOSTIC_INVALID"
  printf '%s\n' "$browser_output"
  persist_safe_step "$browser_output"
  case "$browser_status" in
    0) return 0 ;;
    78) blocked "SPONSOR_PREFLIGHT_BLOCKED" ;;
    *) fail "SPONSOR_PREFLIGHT_FAILED" ;;
  esac
}

hello_with_token() {
  local step_scenario="$1"
  local name="$2"
  local expected_scopes="$3"
  local request_id
  local flow_digest

  [[ "$POLL_TOKEN" =~ ^asimp_ag_[0-9A-HJKMNP-TV-Z]{26}_[A-Za-z0-9_-]{43}$ ]] \
    || fail "APPROVED_TOKEN_CONTRACT_FAILED"
  request_id="$(safe_request_id "$step_scenario" "hello")"
  http_hello "$ASIMPOSIUM_STAGING_AGENT_BASE_URL" "$POLL_TOKEN" "$request_id" \
    || fail "FELLOW_HELLO_UNREACHABLE"
  flow_digest="$(printf '%s' "$START_DEVICE_CODE" | sha256_prefix)" || fail "DIGEST_FAILED"
  if [[ "$HTTP_STATUS" != "200" ]] \
    || ! validate_hello_response "$name" "e2e/device-contract" "curl-playwright" "$expected_scopes"; then
    emit_step "$step_scenario" "hello" "fail" "FELLOW_HELLO_CONTRACT_FAILED" "$HTTP_STATUS" "$HTTP_DURATION_MS" "$request_id" "null" "$flow_digest"
    fail "FELLOW_HELLO_CONTRACT_FAILED"
  fi
  emit_step "$step_scenario" "hello" "pass" "FELLOW_HELLO_VERIFIED" "$HTTP_STATUS" "$HTTP_DURATION_MS" "$request_id" "null" "$flow_digest"
  POLL_TOKEN=""
}

run_decision_scenario() {
  local step_scenario="$1"
  local decision_mode="$2"
  local scopes_json='"review"'
  local scopes_csv="review"
  local expected_scopes="review"
  local name

  if [[ "$decision_mode" == "reduce" ]]; then
    scopes_json='"review","promote"'
    scopes_csv="review,promote"
  fi
  name="$(next_name "$step_scenario")"
  start_device "$step_scenario" "$name" "$scopes_json"
  poll_device "$step_scenario" "pending-poll" "authorization_pending"
  run_browser "$step_scenario" "$decision_mode" "$ASIMPOSIUM_DEVICE_E2E_STORAGE_STATE" "$name" "$scopes_csv"
  if [[ "$decision_mode" == "deny" ]]; then
    poll_device "$step_scenario" "terminal-poll" "access_denied"
  else
    poll_device "$step_scenario" "terminal-poll" "approved"
    hello_with_token "$step_scenario" "$name" "$expected_scopes"
  fi
}

run_fast_poll() {
  local name
  name="$(next_name "fast-poll")"
  start_device "fast-poll" "$name" '"review"'
  poll_device "fast-poll" "pending-poll" "authorization_pending"
  poll_device "fast-poll" "immediate-repoll" "slow_down"
  run_browser "fast-poll" "deny" "$ASIMPOSIUM_DEVICE_E2E_STORAGE_STATE" "$name" "review"
  poll_device "fast-poll" "terminal-poll" "access_denied"
}

run_wrong_code() {
  local name
  local real_code
  local first
  local replacement
  name="$(next_name "wrong-code")"
  start_device "wrong-code" "$name" '"review"'
  real_code="$START_USER_CODE"
  first="${real_code:0:1}"
  replacement="A"
  [[ "$first" != "A" ]] || replacement="B"
  START_USER_CODE="$replacement${real_code:1}"
  run_browser "wrong-code" "lookup-rejected" "$ASIMPOSIUM_DEVICE_E2E_STORAGE_STATE" "$name" "review"
  START_USER_CODE="$real_code"
  run_browser "wrong-code" "deny" "$ASIMPOSIUM_DEVICE_E2E_STORAGE_STATE" "$name" "review"
  poll_device "wrong-code" "terminal-poll" "access_denied"
}

run_wrong_sponsor() {
  local name
  name="$(next_name "wrong-sponsor")"
  start_device "wrong-sponsor" "$name" '"review"'
  run_browser "wrong-sponsor" "approve" "$ASIMPOSIUM_DEVICE_E2E_STORAGE_STATE" "$name" "review"
  # Exercise the ownership boundary after the first decision binds the sponsor,
  # while no credential has yet been issued to the agent.
  run_browser "wrong-sponsor" "lookup-rejected" "$ASIMPOSIUM_DEVICE_E2E_SECOND_STORAGE_STATE" "$name" "review"
  poll_device "wrong-sponsor" "terminal-poll" "approved"
  hello_with_token "wrong-sponsor" "$name" "review"
}

run_code_expired() {
  local name
  local request_id
  name="$(next_name "code-expired")"
  start_device "code-expired" "$name" '"review"'
  poll_device "code-expired" "pending-poll" "authorization_pending"
  request_id="$(safe_request_id "code-expired" "expiry-wait")"
  emit_step "code-expired" "expiry-wait" "start" "REAL_CODE_TTL_WAIT_STARTED" "null" "0" "$request_id" \
    "null" "$(printf '%s' "$START_DEVICE_CODE" | sha256_prefix)"
  sleep "$((START_EXPIRES_SECONDS + 1))"
  run_browser "code-expired" "lookup-rejected" "$ASIMPOSIUM_DEVICE_E2E_STORAGE_STATE" "$name" "review"
  poll_device "code-expired" "terminal-poll" "expired_token"
}

run_proposal_expired() {
  local name
  local request_id
  name="$(next_name "proposal-expired")"
  start_device "proposal-expired" "$name" '"review"'
  poll_device "proposal-expired" "pending-poll" "authorization_pending"
  request_id="$(safe_request_id "proposal-expired" "expiry-wait")"
  emit_step "proposal-expired" "expiry-wait" "start" "REAL_PROPOSAL_RETENTION_SOAK_STARTED" "null" "0" "$request_id" \
    "null" "$(printf '%s' "$START_DEVICE_CODE" | sha256_prefix)"
  sleep "$((proposal_ttl_seconds + 1))"
  run_browser "proposal-expired" "lookup-rejected" "$ASIMPOSIUM_DEVICE_E2E_STORAGE_STATE" "$name" "review"
  poll_device "proposal-expired" "terminal-poll" "expired_token"
}

run_self_test() {
  local output
  local canary_flow
  local canary_token
  local planted_device_digest
  local planted_wrong_code
  local planted_wrong_status
  canary_flow="flow_v1.$(printf 'A%.0s' {1..43})"
  canary_token="asimp_ag_$(printf 'A%.0s' {1..26})_$(printf 'B%.0s' {1..43})"

  e2e_run_harness_self_test "$suite" "$started_ms" "$reproduce --self-test" >/dev/null \
    || fail "HARNESS_SELF_TEST_FAILED"
  output="$(bun "$runner" --self-test 2>/dev/null)" || fail "BROWSER_RUNNER_SELF_TEST_FAILED"
  if [[ "$output" != *'"code":"BROWSER_RUNNER_SELF_TEST_OK"'* \
    || "$output" == *"$canary_flow"* \
    || "$output" == *"$canary_token"* \
    || "$output" == *"https://"* \
    || "$output" == *"/Users/"* ]]; then
    fail "BROWSER_RUNNER_SELF_TEST_UNSAFE"
  fi
  validate_browser_record "$output" "self-test" "BROWSER_RUNNER_SELF_TEST_OK" "0" \
    || fail "BROWSER_RUNNER_SELF_TEST_INVALID"
  planted_wrong_code="${output/BROWSER_RUNNER_SELF_TEST_OK/FABRICATED_GREEN}"
  planted_wrong_status="${output/\"status\":\"pass\"/\"status\":\"blocked\"}"
  planted_device_digest="${output/\"device_digest\":null/\"device_digest\":\"0123456789ab\"}"
  if validate_browser_record "$planted_wrong_code" "self-test" "BROWSER_RUNNER_SELF_TEST_OK" "0" \
    || validate_browser_record "$planted_wrong_status" "self-test" "BROWSER_RUNNER_SELF_TEST_OK" "0" \
    || validate_browser_record "$planted_device_digest" "self-test" "BROWSER_RUNNER_SELF_TEST_OK" "0"; then
    fail "BROWSER_RUNNER_PLANTED_NEGATIVE_ACCEPTED"
  fi
  printf '%s\n' "$output"
  final_record "pass" "DEVICE_ENROLLMENT_HARNESS_SELF_TEST_OK"
}

if [[ "$self_test" -eq 1 ]]; then
  run_self_test
  exit 0
fi

command -v curl >/dev/null 2>&1 || blocked "E2E_DEPENDENCY_UNAVAILABLE"

for origin_variable in ASIMPOSIUM_STAGING_AGENT_BASE_URL ASIMPOSIUM_STAGING_AGORA_BASE_URL; do
  if e2e_validate_staging_origin "$origin_variable"; then
    :
  else
    origin_status=$?
    [[ "$origin_status" -eq 2 ]] && blocked "STAGING_SURFACE_BASE_URL_MISSING"
    blocked "STAGING_SURFACE_BASE_URL_INVALID"
  fi
done

if [[ -z "${ASIMPOSIUM_DEVICE_E2E_STORAGE_STATE:-}" ]]; then
  blocked "SPONSOR_STORAGE_STATE_MISSING"
fi
if ! storage_state_safe "$ASIMPOSIUM_DEVICE_E2E_STORAGE_STATE"; then
  blocked "SPONSOR_STORAGE_STATE_INVALID"
fi
if [[ "$scenario" == "wrong-sponsor" || "$scenario" == "all" ]]; then
  if [[ -z "${ASIMPOSIUM_DEVICE_E2E_SECOND_STORAGE_STATE:-}" ]]; then
    blocked "SECOND_SPONSOR_STORAGE_STATE_MISSING"
  fi
  if ! storage_state_safe "$ASIMPOSIUM_DEVICE_E2E_SECOND_STORAGE_STATE"; then
    blocked "SECOND_SPONSOR_STORAGE_STATE_INVALID"
  fi
  assert_distinct_sponsors
fi

case "$scenario" in
  approve) run_decision_scenario "approve" "approve" ;;
  deny) run_decision_scenario "deny" "deny" ;;
  code-expired) run_code_expired ;;
  fast-poll) run_fast_poll ;;
  proposal-expired) run_proposal_expired ;;
  reduce) run_decision_scenario "reduce" "reduce" ;;
  wrong-code) run_wrong_code ;;
  wrong-sponsor) run_wrong_sponsor ;;
  all)
    run_wrong_code
    run_fast_poll
    run_decision_scenario "deny" "deny"
    run_decision_scenario "reduce" "reduce"
    run_decision_scenario "approve" "approve"
    run_wrong_sponsor
    run_code_expired
    ;;
esac

final_record "pass" "DEVICE_ENROLLMENT_FLOW_GREEN"
