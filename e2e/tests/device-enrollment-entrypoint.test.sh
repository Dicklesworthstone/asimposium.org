#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=e2e/lib/run-diagnostics.sh
source "$repository_root/e2e/lib/run-diagnostics.sh"

suite="device-enrollment-entrypoint-contract"
started_ms="$(e2e_now_ms)"
reproduce="bash e2e/tests/device-enrollment-entrypoint.test.sh"
entrypoint="$repository_root/scripts/e2e-device-enrollment.sh"
browser_runner="$repository_root/e2e/playwright/device-enrollment-runner.ts"

fail() {
  e2e_emit_diagnostic "$suite" "$started_ms" "fail" "$1" "$reproduce"
  exit 1
}

self_test_output="$(bash "$entrypoint" --self-test 2>&1)" || fail "DEVICE_E2E_SELF_TEST_FAILED"
if [[ "$self_test_output" != *'"code":"BROWSER_RUNNER_SELF_TEST_OK"'* \
  || "$self_test_output" != *'"code":"DEVICE_ENROLLMENT_HARNESS_SELF_TEST_OK"'* ]]; then
  fail "DEVICE_E2E_SELF_TEST_DIAGNOSTIC_MISSING"
fi
for forbidden in "flow_v1." "asimp_ag_" "#v1." "https://" "/Users/"; do
  [[ "$self_test_output" != *"$forbidden"* ]] || fail "DEVICE_E2E_SELF_TEST_LEAKED"
done

set +e
missing_origin_output="$(
  env -u ASIMPOSIUM_STAGING_AGENT_BASE_URL \
    -u ASIMPOSIUM_STAGING_AGORA_BASE_URL \
    -u ASIMPOSIUM_DEVICE_E2E_STORAGE_STATE \
    bash "$entrypoint" 2>&1
)"
missing_origin_status=$?
invalid_run_id_output="$(ASIMPOSIUM_E2E_RUN_ID="../escape" bash "$entrypoint" --self-test 2>&1)"
invalid_run_id_status=$?
invalid_scenario_output="$(bash "$entrypoint" --scenario fabricated --self-test 2>&1)"
invalid_scenario_status=$?
set -e

if [[ "$missing_origin_status" -ne 78 \
  || "$missing_origin_output" != *'"code":"STAGING_SURFACE_BASE_URL_MISSING"'* \
  || "$missing_origin_output" != *'"status":"blocked"'* ]]; then
  fail "DEVICE_E2E_MISSING_ORIGIN_NOT_BLOCKED"
fi
if [[ "$invalid_run_id_status" -ne 64 \
  || "$invalid_run_id_output" != *'"code":"RUN_ID_INVALID"'* ]]; then
  fail "DEVICE_E2E_INVALID_RUN_ID_ACCEPTED"
fi
if [[ "$invalid_scenario_status" -ne 64 \
  || "$invalid_scenario_output" != *'"code":"SCENARIO_INVALID"'* ]]; then
  fail "DEVICE_E2E_INVALID_SCENARIO_ACCEPTED"
fi

temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/asimposium-device-entry.XXXXXX")" \
  || fail "DEVICE_E2E_TEMPORARY_FIXTURE_UNAVAILABLE"
storage_state="$temporary_root/storage-state.json"
printf '{"cookies":[],"origins":[]}\n' > "$storage_state" \
  || fail "DEVICE_E2E_STORAGE_FIXTURE_FAILED"
chmod 600 "$storage_state" || fail "DEVICE_E2E_STORAGE_FIXTURE_FAILED"
storage_directory="$temporary_root/storage-directory"
storage_symlink="$temporary_root/storage-symlink.json"
storage_malformed="$temporary_root/storage-malformed.json"
storage_oversized="$temporary_root/storage-oversized.json"
mkdir "$storage_directory" || fail "DEVICE_E2E_STORAGE_FIXTURE_FAILED"
ln -s "$storage_state" "$storage_symlink" || fail "DEVICE_E2E_STORAGE_FIXTURE_FAILED"
printf '{not-json}\n' > "$storage_malformed" || fail "DEVICE_E2E_STORAGE_FIXTURE_FAILED"
dd if=/dev/zero of="$storage_oversized" bs=1048577 count=1 2>/dev/null \
  || fail "DEVICE_E2E_STORAGE_FIXTURE_FAILED"
chmod 600 "$storage_malformed" "$storage_oversized" \
  || fail "DEVICE_E2E_STORAGE_FIXTURE_FAILED"

direct_user_code="ABCD-2345"
direct_name="device-test"
direct_model="e2e/device-contract"
direct_harness="curl-playwright"
direct_code_digest="$(
  printf '%s' "$direct_user_code" \
    | bun -e 'const value = await Bun.stdin.text(); process.stdout.write(new Bun.CryptoHasher("sha256").update(value).digest("hex").slice(0, 12));'
)" || fail "DEVICE_E2E_CANARY_DIGEST_FAILED"

set +e
runtime_error_output="$(bun "$browser_runner" --self-test-runtime-error 2>&1)"
runtime_error_status=$?
declare -a direct_production_outputs=()
declare -a direct_production_statuses=()
for production_origin in \
  "https://A.ASIMPOSIUM.ORG.:443" \
  "https://artifacts.asimposium.org" \
  "https://asimposium.org:8443" \
  "https://www.asimposium.org"; do
  direct_production_outputs+=("$(
    printf '%s\n' "$direct_user_code" "$direct_name" "$direct_model" "$direct_harness" "review" \
      | ASIMPOSIUM_STAGING_AGORA_BASE_URL="$production_origin" \
        ASIMPOSIUM_DEVICE_E2E_STORAGE_STATE="$storage_state" \
        bun "$browser_runner" approve 2>&1
  )")
  direct_production_statuses+=("$?")
done
production_output="$(
  ASIMPOSIUM_STAGING_AGENT_BASE_URL="https://a.asimposium.org" \
    ASIMPOSIUM_STAGING_AGORA_BASE_URL="https://asimposium.org" \
    ASIMPOSIUM_DEVICE_E2E_STORAGE_STATE="$storage_state" \
    bash "$entrypoint" 2>&1
)"
production_status=$?
production_alias_output="$(
  ASIMPOSIUM_STAGING_AGENT_BASE_URL="https://a.asimposium.org:443" \
    ASIMPOSIUM_STAGING_AGORA_BASE_URL="https://agora.staging.invalid" \
    ASIMPOSIUM_DEVICE_E2E_STORAGE_STATE="$storage_state" \
    bash "$entrypoint" 2>&1
)"
production_alias_status=$?
missing_state_output="$(
  ASIMPOSIUM_STAGING_AGENT_BASE_URL="https://agent.staging.invalid" \
    ASIMPOSIUM_STAGING_AGORA_BASE_URL="https://agora.staging.invalid" \
    env -u ASIMPOSIUM_DEVICE_E2E_STORAGE_STATE bash "$entrypoint" 2>&1
)"
missing_state_status=$?
declare -a invalid_state_outputs=()
declare -a invalid_state_statuses=()
for invalid_state in "$storage_directory" "$storage_symlink" "$storage_malformed" "$storage_oversized"; do
  invalid_state_outputs+=("$(
    ASIMPOSIUM_STAGING_AGENT_BASE_URL="https://agent.staging.invalid" \
      ASIMPOSIUM_STAGING_AGORA_BASE_URL="https://agora.staging.invalid" \
      ASIMPOSIUM_DEVICE_E2E_STORAGE_STATE="$invalid_state" \
      bash "$entrypoint" 2>&1
  )")
  invalid_state_statuses+=("$?")
  invalid_state_outputs+=("$(
    printf '%s\n' "$direct_user_code" "$direct_name" "$direct_model" "$direct_harness" "review" \
      | ASIMPOSIUM_STAGING_AGORA_BASE_URL="https://agora.staging.invalid" \
        ASIMPOSIUM_DEVICE_E2E_STORAGE_STATE="$invalid_state" \
        bun "$browser_runner" approve 2>&1
  )")
  invalid_state_statuses+=("$?")
done
chmod 644 "$storage_state" || fail "DEVICE_E2E_STORAGE_FIXTURE_FAILED"
insecure_state_output="$(
  ASIMPOSIUM_STAGING_AGENT_BASE_URL="https://agent.staging.invalid" \
    ASIMPOSIUM_STAGING_AGORA_BASE_URL="https://agora.staging.invalid" \
    ASIMPOSIUM_DEVICE_E2E_STORAGE_STATE="$storage_state" \
    bash "$entrypoint" 2>&1
)"
insecure_state_status=$?
set -e

if [[ "$runtime_error_status" -ne 1 \
  || "$runtime_error_output" != *'"code":"BROWSER_RUNTIME_ERRORS_OBSERVED"'* \
  || "$runtime_error_output" != *'"console_error_count":1'* \
  || "$runtime_error_output" != *'"page_error_count":2'* ]]; then
  fail "DEVICE_E2E_RUNTIME_ERROR_COUNTS_DROPPED"
fi
for direct_index in "${!direct_production_outputs[@]}"; do
  if [[ "${direct_production_statuses[$direct_index]}" -ne 78 \
    || "${direct_production_outputs[$direct_index]}" != *'"code":"STAGING_AGORA_BASE_URL_INVALID"'* ]]; then
    fail "DEVICE_E2E_DIRECT_BROWSER_PRODUCTION_TARGET_ACCEPTED"
  fi
done
if [[ "$production_status" -ne 78 \
  || "$production_output" != *'"code":"STAGING_SURFACE_BASE_URL_INVALID"'* ]]; then
  fail "DEVICE_E2E_PRODUCTION_TARGET_ACCEPTED"
fi
if [[ "$production_alias_status" -ne 78 \
  || "$production_alias_output" != *'"code":"STAGING_SURFACE_BASE_URL_INVALID"'* ]]; then
  fail "DEVICE_E2E_PRODUCTION_ALIAS_ACCEPTED"
fi
if [[ "$missing_state_status" -ne 78 \
  || "$missing_state_output" != *'"code":"SPONSOR_STORAGE_STATE_MISSING"'* ]]; then
  fail "DEVICE_E2E_MISSING_SPONSOR_STATE_NOT_BLOCKED"
fi
if [[ "$insecure_state_status" -ne 78 \
  || "$insecure_state_output" != *'"code":"SPONSOR_STORAGE_STATE_INVALID"'* ]]; then
  fail "DEVICE_E2E_INSECURE_SPONSOR_STATE_ACCEPTED"
fi
for invalid_index in "${!invalid_state_outputs[@]}"; do
  if [[ "${invalid_state_statuses[$invalid_index]}" -ne 78 \
    || "${invalid_state_outputs[$invalid_index]}" != *'"code":"SPONSOR_STORAGE_STATE_INVALID"'* ]]; then
    fail "DEVICE_E2E_UNSAFE_STORAGE_FORM_ACCEPTED"
  fi
done
for output in "$missing_origin_output" "$runtime_error_output" "${direct_production_outputs[@]}" "$production_output" "$production_alias_output" "$missing_state_output" "$insecure_state_output" "${invalid_state_outputs[@]}"; do
  [[ "$output" != *"https://"* ]] || fail "DEVICE_E2E_ORIGIN_LEAKED"
  [[ "$output" != *"agent.staging.invalid"* ]] || fail "DEVICE_E2E_ORIGIN_LEAKED"
  [[ "$output" != *"agora.staging.invalid"* ]] || fail "DEVICE_E2E_ORIGIN_LEAKED"
  [[ "$output" != *"$temporary_root"* ]] || fail "DEVICE_E2E_STORAGE_PATH_LEAKED"
  [[ "$output" != *"$direct_user_code"* ]] || fail "DEVICE_E2E_CODE_LEAKED"
  [[ "$output" != *"$direct_code_digest"* ]] || fail "DEVICE_E2E_CODE_DIGEST_LEAKED"
  [[ "$output" != *"$direct_name"* ]] || fail "DEVICE_E2E_PROPOSAL_LEAKED"
  [[ "$output" != *"$direct_model"* ]] || fail "DEVICE_E2E_PROPOSAL_LEAKED"
  [[ "$output" != *"$direct_harness"* ]] || fail "DEVICE_E2E_PROPOSAL_LEAKED"
done

runner_source="$(<"$browser_runner")"
entrypoint_source="$(<"$entrypoint")"
if [[ "$runner_source" == *'digestPrefix(input.userCode)'* \
  || "$entrypoint_source" == *'START_USER_CODE" | sha256_prefix'* ]]; then
  fail "DEVICE_E2E_SHORT_CODE_DIGEST_REINTRODUCED"
fi

e2e_emit_diagnostic "$suite" "$started_ms" "pass" "DEVICE_ENROLLMENT_ENTRYPOINT_CONTRACT_OK" "$reproduce"
