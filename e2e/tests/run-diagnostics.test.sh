#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=e2e/lib/run-diagnostics.sh
source "$repository_root/e2e/lib/run-diagnostics.sh"

suite="run-diagnostics-unit"
started_ms="$(e2e_now_ms)"
reproduce="bash e2e/tests/run-diagnostics.test.sh"

fail() {
  e2e_emit_diagnostic "$suite" "$started_ms" "fail" "$1" "$reproduce"
  exit 1
}

if ! e2e_run_harness_self_test "$suite" "$started_ms" "$reproduce"; then
  fail "HARNESS_SELF_TEST_FAILED"
fi

for valid_run_id in "a" "OPS.1-20260813" "run_42"; do
  e2e_validate_run_id "$valid_run_id" || {
    fail "VALID_RUN_ID_REJECTED"
  }
done

for invalid_run_id in "../traversal" "nested/path" "-leading-dash" "contains space"; do
  if e2e_validate_run_id "$invalid_run_id"; then
    fail "INVALID_RUN_ID_ACCEPTED"
  fi
done

export ASIMPOSIUM_TEST_STAGING_ORIGIN="https://agent-preview.example:443"
e2e_validate_staging_origin "ASIMPOSIUM_TEST_STAGING_ORIGIN" \
  || fail "VALID_STAGING_ORIGIN_REJECTED"
for production_origin in \
  "https://asimposium.org" \
  "https://www.asimposium.org.:443" \
  "https://A.ASIMPOSIUM.ORG:8443" \
  "https://artifacts.asimposium.org"; do
  export ASIMPOSIUM_TEST_STAGING_ORIGIN="$production_origin"
  if e2e_validate_staging_origin "ASIMPOSIUM_TEST_STAGING_ORIGIN"; then
    fail "PRODUCTION_ORIGIN_ACCEPTED_AS_STAGING"
  fi
done
unset ASIMPOSIUM_TEST_STAGING_ORIGIN

temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/asimposium-e2e-artifact.XXXXXX")" || fail "TEMPORARY_FIXTURE_UNAVAILABLE"
mkdir -p "$temporary_root/e2e/artifacts" "$temporary_root/outside" || fail "TEMPORARY_FIXTURE_LAYOUT_FAILED"

e2e_claim_artifact_run_at_root "$temporary_root" "claimed-run" \
  || fail "UNIQUE_ARTIFACT_RUN_REJECTED"
if second_claim_output="$(e2e_claim_artifact_run_at_root "$temporary_root" "claimed-run" 2>&1)"; then
  fail "REUSED_ARTIFACT_RUN_ACCEPTED"
fi
if [[ -n "$second_claim_output" ]]; then
  fail "REUSED_ARTIFACT_RUN_LEAKED"
fi

if ! regular_artifact_path="$(e2e_write_artifact_diagnostic_at_root "$temporary_root" "regular-run" "$suite" "$started_ms" "fail" "REGULAR_ARTIFACT_TEST" "$reproduce")"; then
  fail "REGULAR_ARTIFACT_WRITE_REJECTED"
fi

if [[ "$regular_artifact_path" != "e2e/artifacts/regular-run/diagnostics.jsonl" ]]; then
  fail "REGULAR_ARTIFACT_RELATIVE_PATH_INVALID"
fi

regular_diagnostic="$(<"$temporary_root/e2e/artifacts/regular-run/diagnostics.jsonl")"
if [[ "$regular_diagnostic" != *'"code":"REGULAR_ARTIFACT_TEST"'* ]] || [[ "$regular_diagnostic" == *"$temporary_root"* ]]; then
  fail "REGULAR_ARTIFACT_DIAGNOSTIC_UNSAFE"
fi

safe_step='{"tool":"curl","status":"pass","code":"SAFE_STEP","device_digest":"0123456789ab"}'
if ! safe_step_path="$(e2e_append_artifact_jsonl_at_root "$temporary_root" "regular-run" "steps.jsonl" "$safe_step")"; then
  fail "REGULAR_STEP_ARTIFACT_WRITE_REJECTED"
fi
if [[ "$safe_step_path" != "e2e/artifacts/regular-run/steps.jsonl" \
  || "$(<"$temporary_root/e2e/artifacts/regular-run/steps.jsonl")" != "$safe_step" ]]; then
  fail "REGULAR_STEP_ARTIFACT_INVALID"
fi

for unsafe_step in \
  '{"flow_handle":"flow_v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}' \
  '{"token":"asimp_ag_SECRET"}' \
  '{"email":"sponsor@example.invalid"}' \
  $'{"status":"pass"}\n{"status":"forged"}'; do
  if e2e_append_artifact_jsonl_at_root "$temporary_root" "regular-run" "steps.jsonl" "$unsafe_step" >/dev/null; then
    fail "UNSAFE_STEP_ARTIFACT_ACCEPTED"
  fi
done

ln -s "$temporary_root/outside" "$temporary_root/e2e/artifacts/escaped-run" || fail "SYMLINK_FIXTURE_UNAVAILABLE"
if symlink_output="$(e2e_write_artifact_diagnostic_at_root "$temporary_root" "escaped-run" "$suite" "$started_ms" "fail" "SYMLINK_ESCAPE_TEST" "$reproduce" 2>&1)"; then
  fail "SYMLINK_RUN_DIRECTORY_ACCEPTED"
fi

if [[ -n "$symlink_output" ]] || [[ -e "$temporary_root/outside/diagnostics.jsonl" ]]; then
  fail "SYMLINK_RUN_DIRECTORY_LEAKED"
fi

mkdir "$temporary_root/e2e/artifacts/leaf-run" || fail "LEAF_FIXTURE_LAYOUT_FAILED"
ln -s "$temporary_root/outside/diagnostics.jsonl" "$temporary_root/e2e/artifacts/leaf-run/diagnostics.jsonl" || fail "LEAF_SYMLINK_FIXTURE_UNAVAILABLE"
if leaf_symlink_output="$(e2e_write_artifact_diagnostic_at_root "$temporary_root" "leaf-run" "$suite" "$started_ms" "fail" "LEAF_SYMLINK_ESCAPE_TEST" "$reproduce" 2>&1)"; then
  fail "SYMLINK_DIAGNOSTIC_FILE_ACCEPTED"
fi

if [[ -n "$leaf_symlink_output" ]] || [[ -e "$temporary_root/outside/diagnostics.jsonl" ]]; then
  fail "SYMLINK_DIAGNOSTIC_FILE_LEAKED"
fi

mkdir "$temporary_root/e2e/artifacts/step-leaf-run" || fail "STEP_LEAF_FIXTURE_LAYOUT_FAILED"
ln -s "$temporary_root/outside/steps.jsonl" "$temporary_root/e2e/artifacts/step-leaf-run/steps.jsonl" \
  || fail "STEP_LEAF_SYMLINK_FIXTURE_UNAVAILABLE"
if step_symlink_output="$(e2e_append_artifact_jsonl_at_root "$temporary_root" "step-leaf-run" "steps.jsonl" "$safe_step" 2>&1)"; then
  fail "SYMLINK_STEP_FILE_ACCEPTED"
fi
if [[ -n "$step_symlink_output" ]] || [[ -e "$temporary_root/outside/steps.jsonl" ]]; then
  fail "SYMLINK_STEP_FILE_LEAKED"
fi

if ! emitted_stdout="$(e2e_emit_and_optionally_record_at_root "$temporary_root" "1" "escaped-run" "$suite" "$started_ms" "fail" "ORIGINAL_PRODUCT_FAILURE" "$reproduce" 2>"$temporary_root/artifact-write.stderr")"; then
  fail "ORIGINAL_PRODUCT_FAILURE_STATUS_NOT_RETAINED"
fi

emitted_stderr="$(<"$temporary_root/artifact-write.stderr")"
if [[ -n "$emitted_stdout" ]] || [[ "$emitted_stderr" != *'"code":"ORIGINAL_PRODUCT_FAILURE"'* ]] || [[ "$emitted_stderr" != *'"code":"ARTIFACT_DIAGNOSTIC_WRITE_FAILED"'* ]]; then
  fail "ARTIFACT_WRITE_FAILURE_DIAGNOSTIC_MISSING"
fi

if [[ "$emitted_stderr" == *"$temporary_root"* ]] || [[ "$emitted_stderr" == *"https://"* ]] || [[ "$emitted_stderr" == *"asimp_ag_"* ]]; then
  fail "ARTIFACT_WRITE_FAILURE_DIAGNOSTIC_UNSAFE"
fi

if ! command -v curl >/dev/null 2>&1; then
  fail "CURL_UNAVAILABLE"
fi

if probe_output="$(e2e_probe_public_path "https://127.0.0.1:1" "/" 2>&1)"; then
  fail "UNREACHABLE_PROBE_ACCEPTED"
fi

if [[ -n "$probe_output" ]] || [[ "$probe_output" == *"127.0.0.1:1"* ]] || [[ "$probe_output" == *"https://"* ]]; then
  fail "RAW_PROBE_DIAGNOSTIC_LEAKED"
fi

e2e_emit_diagnostic "$suite" "$started_ms" "pass" "RUN_ID_AND_DIAGNOSTIC_CONTRACT_OK" "$reproduce"
