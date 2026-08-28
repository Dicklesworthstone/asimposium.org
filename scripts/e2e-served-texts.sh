#!/usr/bin/env bash
set -euo pipefail
set +x

# e2e-served-texts — advertised served-text GET matrix (asimposiumorg-3bq).
#
# Proves every Worker served-text face answers 200 with ETag + canonical Link,
# honors If-None-Match, and that apex 308s protocol/policy/inoculation to Stoa
# without leaking bodies, fragments, or credentials into diagnostics.
#
# --self-test drives scripts/e2e-served-texts-fixture.py (loopback HTTP).
# Live mode requires ASIMPOSIUM_STAGING_AGENT_BASE_URL (https, non-production)
# and optional ASIMPOSIUM_STAGING_AGORA_BASE_URL for apex 308s.
#
# Does NOT run the session write loop; that remains scripts/smoke-agent.sh.
# Does NOT generate review-rubric or move-template resources (no registry yet).

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=e2e/lib/run-diagnostics.sh
source "$repository_root/e2e/lib/run-diagnostics.sh"

suite="e2e-served-texts"
reproduce="scripts/e2e-served-texts.sh --self-test"
started_ms="$(e2e_now_ms)"
self_test=0

WORKER_PATHS=(
  /
  /AGENTS.md
  /llms.txt
  /protocol
  /protocol.md
  /protocol.json
  /policy.md
  /skill.md
  /inoculation.md
  /capabilities
  /.well-known/asimposium.json
  /openapi.json
  /schemas/index.json
)

APEX_REDIRECTS=(
  /protocol
  /protocol.md
  /protocol.json
  /policy.md
  /inoculation.md
)

served_texts_header() { # $1=headers file $2=name -> value or empty
  LC_ALL=C grep -i "^$2:" "$1" 2>/dev/null | tail -n 1 | cut -d: -f2- | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | tr -d '\r'
}

served_texts_probe_worker() { # $1=origin
  local origin="$1"
  local path headers body http_status etag link content_type
  local tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/served-texts.XXXXXX")"
  headers="${tmp}.h"
  body="${tmp}.b"
  for path in "${WORKER_PATHS[@]}"; do
    rm -f "$headers" "$body"
    http_status="$(e2e_curl --silent --max-time 15 --connect-timeout 5 \
      --dump-header "$headers" --output "$body" --write-out '%{http_code}' \
      "${origin}${path}" 2>/dev/null)" || {
      rm -f "$headers" "$body" "$tmp"
      return 2
    }
    if [[ "$http_status" != "200" ]]; then
      rm -f "$headers" "$body" "$tmp"
      return 3
    fi
    content_type="$(served_texts_header "$headers" "content-type")"
    etag="$(served_texts_header "$headers" "etag")"
    link="$(served_texts_header "$headers" "link")"
    [[ -n "$content_type" ]] || {
      rm -f "$headers" "$body" "$tmp"
      return 4
    }
    [[ -n "$etag" ]] || {
      rm -f "$headers" "$body" "$tmp"
      return 5
    }
    [[ "$link" == *'rel="canonical"'* ]] || {
      rm -f "$headers" "$body" "$tmp"
      return 6
    }
    http_status="$(e2e_curl --silent --max-time 15 --connect-timeout 5 \
      --header "If-None-Match: ${etag}" --output /dev/null --write-out '%{http_code}' \
      "${origin}${path}" 2>/dev/null)" || {
      rm -f "$headers" "$body" "$tmp"
      return 2
    }
    if [[ "$http_status" != "304" ]]; then
      rm -f "$headers" "$body" "$tmp"
      return 7
    fi
  done
  rm -f "$headers" "$body" "$tmp"
  return 0
}

served_texts_probe_apex() { # $1=apex origin $2=worker origin
  local apex="$1"
  local worker="$2"
  local path http_status location
  local tmp headers
  tmp="$(mktemp "${TMPDIR:-/tmp}/served-texts-apex.XXXXXX")"
  headers="${tmp}.h"
  for path in "${APEX_REDIRECTS[@]}"; do
    rm -f "$headers"
    http_status="$(e2e_curl --silent --max-time 15 --connect-timeout 5 \
      --dump-header "$headers" --output /dev/null --write-out '%{http_code}' \
      "${apex}${path}" 2>/dev/null)" || {
      rm -f "$headers" "$tmp"
      return 2
    }
    if [[ "$http_status" != "308" ]]; then
      rm -f "$headers" "$tmp"
      return 8
    fi
    location="$(served_texts_header "$headers" "location")"
    if [[ "$location" != "${worker}${path}" ]]; then
      rm -f "$headers" "$tmp"
      return 9
    fi
  done
  rm -f "$headers" "$tmp"
  return 0
}

served_texts_map_probe_status() {
  case "$1" in
    0) printf '%s' "SERVED_TEXT_MATRIX_OK" ;;
    2) printf '%s' "SERVED_TEXT_ORIGIN_UNAVAILABLE" ;;
    3) printf '%s' "SERVED_TEXT_ROUTE_UNSERVED" ;;
    4) printf '%s' "SERVED_TEXT_MEDIA_TYPE_MISSING" ;;
    5) printf '%s' "SERVED_TEXT_ETAG_MISSING" ;;
    6) printf '%s' "SERVED_TEXT_CANONICAL_LINK_MISSING" ;;
    7) printf '%s' "SERVED_TEXT_CONDITIONAL_GET_UNHONORED" ;;
    8) printf '%s' "SERVED_TEXT_APEX_REDIRECT_MISSING" ;;
    9) printf '%s' "SERVED_TEXT_APEX_REDIRECT_TARGET_INVALID" ;;
    *) printf '%s' "SERVED_TEXT_PROBE_FAILED" ;;
  esac
}

served_texts_run_fixture_self_test() {
  local scratch ready pid worker_origin apex_origin status code
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/served-texts-selftest.XXXXXX")"
  ready="$scratch/ready"
  : >"$ready"

  start_fixture() {
    local defect="$1"
    : >"$ready"
    SERVED_TEXT_FIXTURE_DEFECT="$defect" \
      SERVED_TEXT_FIXTURE_READY_FILE="$ready" \
      python3 "$repository_root/scripts/e2e-served-texts-fixture.py" \
      >>"$scratch/server.log" 2>&1 &
    pid="$!"
    local _i
    for _i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
      if [[ -s "$ready" ]]; then
        read -r worker_origin apex_origin <"$ready"
        [[ -n "$worker_origin" && -n "$apex_origin" ]] && return 0
      fi
      if ! kill -0 "$pid" 2>/dev/null; then
        return 1
      fi
      sleep 0.1
    done
    return 1
  }

  stop_fixture() {
    if [[ -n "${pid:-}" ]]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      pid=""
    fi
  }

  start_fixture "" || {
    stop_fixture
    rm -rf "$scratch"
    return 1
  }
  served_texts_probe_worker "$worker_origin"
  status=$?
  served_texts_probe_apex "$apex_origin" "$worker_origin" || status=$?
  stop_fixture
  [[ "$status" -eq 0 ]] || {
    rm -rf "$scratch"
    return 1
  }

  local defect expected
  for defect in missing-inoculation no-etag no-canonical apex-not-308; do
    start_fixture "$defect" || {
      stop_fixture
      rm -rf "$scratch"
      return 1
    }
    status=0
    served_texts_probe_worker "$worker_origin" || status=$?
    if [[ "$status" -eq 0 ]]; then
      served_texts_probe_apex "$apex_origin" "$worker_origin" || status=$?
    fi
    stop_fixture
    case "$defect" in
      missing-inoculation) expected=3 ;;
      no-etag) expected=5 ;;
      no-canonical) expected=6 ;;
      apex-not-308) expected=8 ;;
    esac
    [[ "$status" -eq "$expected" ]] || {
      rm -rf "$scratch"
      return 1
    }
  done

  rm -rf "$scratch"
  return 0
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --self-test) self_test=1 ;;
    *)
      e2e_emit_diagnostic "$suite" "$started_ms" "fail" "UNKNOWN_ARGUMENT" "$reproduce"
      exit 64
      ;;
  esac
  shift
done

if [[ "$self_test" -eq 1 ]]; then
  e2e_run_harness_self_test "$suite" "$started_ms" "$reproduce"
  if ! served_texts_run_fixture_self_test; then
    e2e_emit_diagnostic "$suite" "$started_ms" "fail" "SERVED_TEXT_FIXTURE_SELF_TEST_FAILED" "$reproduce"
    exit 1
  fi
  e2e_emit_diagnostic "$suite" "$started_ms" "pass" "SERVED_TEXT_FIXTURE_SELF_TEST_OK" "$reproduce"
  exit 0
fi

if e2e_validate_staging_origin "ASIMPOSIUM_STAGING_AGENT_BASE_URL"; then
  :
else
  origin_status=$?
  case "$origin_status" in
    2) code="STAGING_AGENT_BASE_URL_MISSING" ;;
    *) code="STAGING_AGENT_BASE_URL_INVALID" ;;
  esac
  e2e_emit_diagnostic "$suite" "$started_ms" "fail" "$code" "$reproduce"
  exit 78
fi

probe_status=0
served_texts_probe_worker "$ASIMPOSIUM_STAGING_AGENT_BASE_URL" || probe_status=$?
if [[ "$probe_status" -ne 0 ]]; then
  e2e_emit_diagnostic "$suite" "$started_ms" "fail" "$(served_texts_map_probe_status "$probe_status")" "$reproduce"
  exit 69
fi

if [[ -n "${ASIMPOSIUM_STAGING_AGORA_BASE_URL:-}" ]]; then
  if ! e2e_validate_staging_origin "ASIMPOSIUM_STAGING_AGORA_BASE_URL"; then
    e2e_emit_diagnostic "$suite" "$started_ms" "fail" "STAGING_AGORA_BASE_URL_INVALID" "$reproduce"
    exit 78
  fi
  probe_status=0
  served_texts_probe_apex "$ASIMPOSIUM_STAGING_AGORA_BASE_URL" "$ASIMPOSIUM_STAGING_AGENT_BASE_URL" || probe_status=$?
  if [[ "$probe_status" -ne 0 ]]; then
    e2e_emit_diagnostic "$suite" "$started_ms" "fail" "$(served_texts_map_probe_status "$probe_status")" "$reproduce"
    exit 69
  fi
fi

e2e_emit_diagnostic "$suite" "$started_ms" "pass" "SERVED_TEXT_MATRIX_OK" "$reproduce"
exit 0
