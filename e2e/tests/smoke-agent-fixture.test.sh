#!/usr/bin/env bash
# Table tests for scripts/smoke-agent-fixture-origin.py -- the seeded fake Stoa
# origin driving scripts/smoke-agent.sh. The default fixture behavior is a
# fully conforming surface that must drive the whole agent journey to
# AGENT_LOOP_COMPLETE without any preview deployment or real credential; every
# defect value flips exactly one stage response, so the matching smoke
# assertion is proven to FIRE with its named refusal code and exit status.
#
# Retry-After bounds are exercised at the first preflight GET (the handbook
# probe, where smoke_agent_fetch_with_rate_limit is shared by every public
# GET): an honorable header delays one bounded retry and the run still
# completes; missing, non-numeric, zero/negative, above-default-bound, and
# narrowed-bound values must refuse immediately with AGENT_HANDBOOK_RATE_LIMITED.
#
# RED check: reverting the rate-limit helpers to unconditional success makes
# every RATE_LIMITED row below sleep-or-honor its way to a later stage instead
# of refusing, so this table fails RED against that regression.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
suite="smoke-agent-fixture"
smoke_script="$repository_root/scripts/smoke-agent.sh"
fixture_origin="$repository_root/scripts/smoke-agent-fixture-origin.py"
failures=0
scratch="$(mktemp -d "${TMPDIR:-/tmp}/smoke-agent-fixture.XXXXXX")"
cleanup() {
  if [[ -s "$scratch/server.pid" ]]; then
    kill "$(cat "$scratch/server.pid")" 2>/dev/null || true
  fi
  rm -rf "$scratch"
}
trap cleanup EXIT

emit() {
  printf '{"suite":"%s","status":"%s","code":"%s"}\n' "$suite" "$1" "$2"
}

# A grammar-valid synthetic Fellow credential (never a real one): the fixture
# accepts exactly this value; redaction assertions below prove it can never
# leak into smoke output even when private-shaped bytes are planted in a
# public face.
fellow_token="asimp_ag_0123456789ABCDEFGHJKMNPQRS_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
  -subj "/CN=smoke-agent-fixture" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -keyout "$scratch/ca.key" -out "$scratch/ca.pem" >/dev/null 2>&1
printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\n' > "$scratch/ext.cnf"
openssl req -newkey rsa:2048 -nodes \
  -subj "/CN=localhost" \
  -keyout "$scratch/leaf.key" -out "$scratch/leaf.csr" >/dev/null 2>&1
openssl x509 -req -in "$scratch/leaf.csr" -CA "$scratch/ca.pem" -CAkey "$scratch/ca.key" \
  -CAcreateserial -out "$scratch/leaf.pem" -extfile "$scratch/ext.cnf" -days 2 >/dev/null 2>&1

start_server() { # $1 = defect name -> echoes base URL; pid lands in server.pid
  local defect="$1"
  local url=""
  : > "$scratch/ready"
  SMOKE_FIXTURE_DEFECT="$defect" \
  SMOKE_FIXTURE_READY_FILE="$scratch/ready" \
  SMOKE_FIXTURE_FELLOW_TOKEN="$fellow_token" \
  SMOKE_FIXTURE_CERT="$scratch/leaf.pem" \
  SMOKE_FIXTURE_KEY="$scratch/leaf.key" \
    python3 "$fixture_origin" 0 >>"$scratch/server.log" 2>&1 &
  echo "$!" > "$scratch/server.pid"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if [[ -s "$scratch/ready" ]]; then
      url="$(cat "$scratch/ready")"
      if [[ -n "$url" ]]; then
        printf '%s\n' "$url"
        return 0
      fi
    fi
    if ! kill -0 "$(cat "$scratch/server.pid")" 2>/dev/null; then
      return 1
    fi
    sleep 0.2
  done
  return 1
}

stop_server() {
  local pid
  if [[ -s "$scratch/server.pid" ]]; then
    pid="$(cat "$scratch/server.pid")"
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  : > "$scratch/server.pid"
}

run_smoke() { # $1 = defect name, $2 = optional extra env (NAME=VAL)
  local defect="$1"
  local extra="${2:-}"
  local base_url
  base_url="$(start_server "$defect")" || { emit "fail" "FIXTURE_SERVER_UNAVAILABLE"; return 1; }
  local env_extra=()
  [[ -n "$extra" ]] && env_extra=("$extra")
  set +e
  env -u ASIMPOSIUM_SMOKE_FELLOW_TOKEN \
    CURL_CA_BUNDLE="$scratch/ca.pem" \
    ASIMPOSIUM_STAGING_AGENT_BASE_URL="$base_url" \
    ASIMPOSIUM_SMOKE_FELLOW_TOKEN="$fellow_token" \
    ${env_extra[@]+"${env_extra[@]}"} \
    SMOKE_AGENT_LANE_LABEL="fixture-seeded-origin" \
    timeout 60 bash "$smoke_script" >"$scratch/out" 2>"$scratch/err"
  run_status=$?
  set -e
  stop_server
}

expect_run() { # $1 label, $2 expected exit, $3 expected code, $4 defect, $5 extra env
  local label="$1" expected_exit="$2" expected_code="$3" defect="$4" extra="${5:-}"
  if ! run_smoke "$defect" "$extra"; then
    emit "fail" "${label}_RUN_ABORTED"
    failures=$((failures + 1))
    return 0
  fi
  if [[ "$run_status" -ne "$expected_exit" ]]; then
    emit "fail" "${label}_EXIT_${expected_exit}_GOT_${run_status}"
    if [[ -n "${SMOKE_FIXTURE_DEBUG:-}" ]]; then
      printf -- '--- out ---\n' >&2
      head -5 "$scratch/out" >&2
      printf -- '--- err ---\n' >&2
      head -5 "$scratch/err" >&2
      printf -- '--- server.log ---\n' >&2
      head -10 "$scratch/server.log" >&2
    fi
    if [[ -n "${SMOKE_FIXTURE_KEEP:-}" ]]; then
      local keep="$scratch.keep.${label}"
      cp -R "$scratch" "$keep"
      printf 'kept=%s\n' "$keep" >&2
    fi
    failures=$((failures + 1))
    return 0
  fi
  if ! grep -q "\"code\":\"$expected_code\"" "$scratch/out" "$scratch/err"; then
    emit "fail" "${label}_CODE_${expected_code}_MISSING"
    failures=$((failures + 1))
    return 0
  fi
}

# --- Happy path: the conforming fixture drives the full journey to completion.
# Codes arrive lane-prefixed (see smoke_agent_lane_code in smoke-agent.sh) so a
# fixture green can never be quoted as a staging or product green.
expect_run HAPPY 0 "fixture-seeded-origin:AGENT_LOOP_COMPLETE" ""
expect_run HAPPY_REPEAT 0 "fixture-seeded-origin:AGENT_LOOP_COMPLETE" ""

# --- Stage refusal matrix: each planted defect fires its named assertion.
expect_run DEF_HANDBOOK 69 "AGENT_HANDBOOK_UNAVAILABLE" "handbook-unavailable"
expect_run DEF_CAPS_DOWN 69 "AGENT_CAPABILITIES_UNAVAILABLE" "capabilities-unavailable"
expect_run DEF_INDEX_STATUS 87 "AGENT_PROBLEM_INDEX_HTTP_FAILURE" "problem-index-status"
expect_run DEF_INDEX_MEDIA 87 "AGENT_PROBLEM_INDEX_MEDIA_TYPE_INVALID" "problem-index-media-type"
expect_run DEF_INDEX_MALFORMED 87 "AGENT_PROBLEM_INDEX_MALFORMED" "problem-index-malformed"
expect_run DEF_FACE_LEAK 87 "AGENT_PUBLIC_FACE_EXPOSES_FORBIDDEN_FIELDS" "public-face-leak"
expect_run DEF_INDEX_CONTRACT 87 "AGENT_PROBLEM_INDEX_CONTRACT_VIOLATION" "problem-index-contract"
expect_run DEF_BOUNDARY_OPEN 87 "AGENT_SPONSOR_READ_REACHABLE_ANONYMOUSLY" "sponsor-boundary-open"
expect_run DEF_BOUNDARY_ORDER 87 "AGENT_SPONSOR_AUTHENTICATION_BYPASSED" "sponsor-boundary-order"
expect_run DEF_BOUNDARY_FACE 87 "AGENT_SPONSOR_AUTH_BOUNDARY_UNPROVEN" "sponsor-boundary-face"
expect_run DEF_CURSOR_TEXT 88 "AGENT_CURSOR_NOT_BARE_INTEGER" "cursor-noninteger"
expect_run DEF_CURSOR_HTTP 88 "AGENT_CURSOR_HTTP_FAILURE" "cursor-http"
expect_run DEF_DEVICE_STATUS 71 "AGENT_DEVICE_FLOW_START_REFUSED" "device-flow-status"
expect_run DEF_DEVICE_SHAPE 72 "AGENT_DEVICE_FLOW_CONTRACT_VIOLATION" "device-flow-shape"
expect_run DEF_REPLAY_STATUS 73 "AGENT_DEVICE_FLOW_REPLAY_REFUSED" "device-flow-replay-status"
expect_run DEF_REPLAY_DRIFT 74 "AGENT_DEVICE_FLOW_IDEMPOTENCY_VIOLATION" "device-flow-replay-drift"
expect_run DEF_SESSION_OPEN 76 "AGENT_SESSION_OPEN_FAILED" "session-open-failed"
expect_run DEF_SESSION_ID 76 "AGENT_SESSION_ID_MALFORMED" "session-id-malformed"
expect_run DEF_PACK_DOWN 77 "AGENT_PACK_UNAVAILABLE" "pack-unavailable"
expect_run DEF_PACK_CONTRACT 77 "AGENT_PACK_CONTRACT_VIOLATION" "pack-contract"
expect_run DEF_PUSH 79 "AGENT_WORKSHOP_PUSH_FAILED" "workshop-push-failed"
expect_run DEF_WORKSHOP_ID 79 "AGENT_WORKSHOP_ID_MALFORMED" "workshop-id-malformed"
expect_run DEF_INTENT 84 "AGENT_INTENT_CLASSIFIER_MISSING" "intent-classifier-missing"
expect_run DEF_SELFCERT 86 "AGENT_VALIDATOR_SELF_CERT_MISSING" "self-cert-missing"
expect_run DEF_P3 80 "AGENT_VALIDATOR_P3_MISSING" "p3-missing"
expect_run DEF_PROMOTE 81 "AGENT_PROMOTE_FAILED" "promote-failed"
expect_run DEF_CURSOR_LAW 82 "AGENT_CURSOR_LAW_VIOLATION" "cursor-law"
expect_run DEF_P11 85 "AGENT_VALIDATOR_P11_MISSING" "p11-missing"
expect_run DEF_CLOSE 83 "AGENT_CLOSE_FAILED" "close-failed"

# --- Retry-After honoring and bounds (all firing on the first GET).
expect_run RETRY_ONCE 0 "fixture-seeded-origin:AGENT_LOOP_COMPLETE" "retry-after-once"
expect_run RETRY_THREE_HONORED 0 "fixture-seeded-origin:AGENT_LOOP_COMPLETE" "retry-after-three"
expect_run RETRY_INVALID 69 "AGENT_HANDBOOK_RATE_LIMITED" "retry-after-invalid"
expect_run RETRY_ZERO 69 "AGENT_HANDBOOK_RATE_LIMITED" "retry-after-zero"
expect_run RETRY_NEGATIVE 69 "AGENT_HANDBOOK_RATE_LIMITED" "retry-after-negative"
expect_run RETRY_ABOVE_DEFAULT_BOUND 69 "AGENT_HANDBOOK_RATE_LIMITED" "retry-after-eleven"
expect_run RETRY_HUGE 69 "AGENT_HANDBOOK_RATE_LIMITED" "retry-after-huge"
expect_run RETRY_NARROWED_BOUND 69 "AGENT_HANDBOOK_RATE_LIMITED" "retry-after-three" "ASIMPOSIUM_SMOKE_MAX_RETRY_AFTER_SECONDS=2"

# --- Secret discipline: the synthetic credential must never surface anywhere.
if grep -rqF "$fellow_token" "$scratch/out" "$scratch/err" "$scratch/server.log" 2>/dev/null; then
  emit "fail" "CREDENTIAL_LEAKED_INTO_SMOKE_OUTPUT"
  failures=$((failures + 1))
fi

if [[ "$failures" -gt 0 ]]; then
  emit "fail" "SMOKE_AGENT_FIXTURE_${failures}_FAILURES"
  exit 1
fi
emit "pass" "SMOKE_AGENT_FIXTURE_GREEN"
