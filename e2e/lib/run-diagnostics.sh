#!/usr/bin/env bash
# Shared, secret-safe diagnostics for executable E2E entry points.
# This file is sourced by the runners; it intentionally never prints input
# values, origins, credentials, artifact roots, or local absolute paths.

ASIMPOSIUM_E2E_HARNESS_VERSION="0.1.0"

e2e_now_ms() {
  local candidate
  candidate="$(date +%s%3N 2>/dev/null || true)"
  if [[ "$candidate" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  printf '%s000\n' "$(date +%s)"
}

e2e_elapsed_ms() {
  local started_ms="$1"
  local now_ms
  now_ms="$(e2e_now_ms)"
  printf '%s\n' "$((now_ms - started_ms))"
}

e2e_validate_run_id() {
  local run_id="$1"
  [[ "$run_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$ ]]
}

e2e_artifact_relpath() {
  local run_id="$1"
  e2e_validate_run_id "$run_id" || return 1
  printf 'e2e/artifacts/%s\n' "$run_id"
}

e2e_generated_run_id() {
  local suite="$1"
  printf '%s-%s-%s\n' "$suite" "$(date -u +%Y%m%dT%H%M%S)" "$$"
}

e2e_resolve_run_id() {
  local suite="$1"
  local explicit_run_id="${2:-}"
  local environment_run_id="${ASIMPOSIUM_E2E_RUN_ID:-}"
  local run_id

  if [[ -n "$explicit_run_id" && -n "$environment_run_id" && "$explicit_run_id" != "$environment_run_id" ]]; then
    return 1
  fi

  run_id="${explicit_run_id:-${environment_run_id:-$(e2e_generated_run_id "$suite")}}"
  e2e_validate_run_id "$run_id" || return 1
  printf '%s\n' "$run_id"
}

e2e_validate_staging_origin() {
  local variable_name="$1"
  local origin="${!variable_name:-}"
  local authority

  [[ -n "$origin" ]] || return 2
  [[ "$origin" == https://* ]] || return 1

  authority="${origin#https://}"
  [[ -n "$authority" ]] || return 1
  [[ "$authority" != */* ]] || return 1
  [[ "$authority" != *"?"* ]] || return 1
  [[ "$authority" != *"#"* ]] || return 1
  [[ "$authority" != *"@"* ]] || return 1
  [[ "$authority" != *[[:space:]]* ]] || return 1
}

e2e_format_diagnostic() {
  local suite="$1"
  local started_ms="$2"
  local status="$3"
  local code="$4"
  local reproduce="$5"
  local duration_ms

  duration_ms="$(e2e_elapsed_ms "$started_ms")"
  printf '{"tool":"bash","tool_version":"%s","package":"e2e","suite":"%s","version":"%s","duration_ms":%s,"status":"%s","code":"%s","reproduce":"%s"}\n' \
    "${BASH_VERSION%% *}" \
    "$suite" \
    "$ASIMPOSIUM_E2E_HARNESS_VERSION" \
    "$duration_ms" \
    "$status" \
    "$code" \
    "$reproduce"
}

e2e_emit_diagnostic() {
  e2e_format_diagnostic "$@"
}

e2e_write_artifact_diagnostic() {
  local run_id="$1"
  local suite="$2"
  local started_ms="$3"
  local status="$4"
  local code="$5"
  local reproduce="$6"
  local repository_root
  local artifact_relpath
  local artifact_directory

  repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  artifact_relpath="$(e2e_artifact_relpath "$run_id")" || return 1
  artifact_directory="$repository_root/$artifact_relpath"

  case "$artifact_directory" in
    "$repository_root"/e2e/artifacts/*) ;;
    *) return 1 ;;
  esac

  mkdir -p "$artifact_directory"
  e2e_format_diagnostic "$suite" "$started_ms" "$status" "$code" "$reproduce" >> "$artifact_directory/diagnostics.jsonl"
  printf '%s/diagnostics.jsonl\n' "$artifact_relpath"
}

e2e_emit_and_optionally_record() {
  local write_artifacts="$1"
  local run_id="$2"
  local suite="$3"
  local started_ms="$4"
  local status="$5"
  local code="$6"
  local reproduce="$7"

  if [[ "$write_artifacts" == "1" ]]; then
    e2e_write_artifact_diagnostic "$run_id" "$suite" "$started_ms" "$status" "$code" "$reproduce" >/dev/null || return 1
  fi

  e2e_emit_diagnostic "$suite" "$started_ms" "$status" "$code" "$reproduce"
}

e2e_probe_public_path() {
  local origin="$1"
  local path="$2"
  local http_status
  local curl_status

  http_status="$(curl --silent --show-error --location --max-time 15 --connect-timeout 5 --output /dev/null --write-out '%{http_code}' "$origin$path")"
  curl_status=$?
  [[ "$curl_status" -eq 0 ]] || return 1
  [[ "$http_status" =~ ^2[0-9][0-9]$ ]]
}

e2e_run_harness_self_test() {
  local suite="$1"
  local started_ms="$2"
  local reproduce="$3"
  local artifact_path
  local invalid_run_id
  local diagnostic

  artifact_path="$(e2e_artifact_relpath "ops.1-selftest")" || return 1
  [[ "$artifact_path" == "e2e/artifacts/ops.1-selftest" ]] || return 1

  for invalid_run_id in "../escape" "bad/path" "-starts-with-dash" "has space" ""; do
    if e2e_artifact_relpath "$invalid_run_id" >/dev/null; then
      return 1
    fi
  done

  diagnostic="$(e2e_format_diagnostic "$suite" "$started_ms" "pass" "HARNESS_SELF_TEST_OK" "$reproduce")"
  [[ "$diagnostic" == *'"tool":"bash"'* ]] || return 1
  [[ "$diagnostic" == *'"package":"e2e"'* ]] || return 1
  [[ "$diagnostic" == *'"suite":"'* ]] || return 1
  [[ "$diagnostic" == *'"duration_ms":'* ]] || return 1
  [[ "$diagnostic" != *"/Users/"* ]] || return 1
  [[ "$diagnostic" != *"asimp_ag_"* ]] || return 1
  [[ "$diagnostic" != *"#v1."* ]] || return 1

  e2e_emit_diagnostic "$suite" "$started_ms" "pass" "HARNESS_SELF_TEST_OK" "$reproduce"
}
