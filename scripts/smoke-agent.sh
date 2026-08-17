#!/usr/bin/env bash
set -euo pipefail

# smoke-agent — G0 agent-surface smoke gate (asimposiumorg-7ft).
#
# Stages, in order, each with a precise refusal code:
#   1. handbook probe            GET /                 (exit 69 AGENT_HANDBOOK_UNAVAILABLE)
#   2. capabilities probe        GET /capabilities     (exit 69 AGENT_CAPABILITIES_UNAVAILABLE)
#   3. device-flow start         POST /v1/device-code  (exit 71 AGENT_DEVICE_FLOW_START_REFUSED)
#      contract shape + trusted verification origin    (exit 72 AGENT_DEVICE_FLOW_CONTRACT_VIOLATION)
#      idempotent replay, same Idempotency-Key         (exit 73 AGENT_DEVICE_FLOW_REPLAY_REFUSED
#                                                        exit 74 AGENT_DEVICE_FLOW_IDEMPOTENCY_VIOLATION)
#   4. pairing/session/pack/workshop/promote/delta/close: not yet implemented
#      on any deployed surface                         (exit 70 AGENT_PRODUCT_FLOW_NOT_IMPLEMENTED)
#
# Other exits: 64 usage/run-id, 78 staging origin missing/invalid.
#
# Secret discipline: the device-flow response carries a flow handle. The body
# is held only in shell variables, asserted structurally, and never printed,
# logged, or written to artifacts. Diagnostics carry suite/status/code only.

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=e2e/lib/run-diagnostics.sh
source "$repository_root/e2e/lib/run-diagnostics.sh"

suite="smoke-agent"
reproduce="scripts/smoke-agent.sh --self-test"
started_ms="$(e2e_now_ms)"
self_test=0
write_artifacts=0
explicit_run_id=""

smoke_agent_check_device_flow_shape() {
  # stdin: a device-flow start response body. Exits 0 iff it matches the
  # published DeviceCodeStartResponse contract exactly: the five fields, the
  # flow_v1 handle grammar, the user-code alphabet, a verification_url pinned
  # to a trusted Agora origin (never request-derived), and the documented
  # integer bounds. Prints nothing.
  python3 -c '
import json
import sys

try:
    doc = json.loads(sys.stdin.read())
except Exception:
    sys.exit(1)

if not isinstance(doc, dict):
    sys.exit(1)
if set(doc) != {"device_code", "user_code", "verification_url", "interval_seconds", "expires_in_seconds"}:
    sys.exit(1)

import re

device_code = doc["device_code"]
if not isinstance(device_code, str) or not re.fullmatch(r"flow_v1\.[A-Za-z0-9_-]{43}", device_code):
    sys.exit(1)

user_code = doc["user_code"]
if not isinstance(user_code, str) or not re.fullmatch(
    r"[ABCDEFGHJKMNPQRSTVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTVWXYZ23456789]{4}", user_code
):
    sys.exit(1)

# Exact membership mirrors the contract alternation: literal trusted origins,
# no pattern-escaping slack for attacker-shaped hosts to slip through.
if doc["verification_url"] not in (
    "https://asimposium.org/approve",
    "https://staging.asimposium.org/approve",
):
    sys.exit(1)

interval = doc["interval_seconds"]
if not isinstance(interval, int) or isinstance(interval, bool) or not 0 < interval <= 60:
    sys.exit(1)

expires = doc["expires_in_seconds"]
if not isinstance(expires, int) or isinstance(expires, bool) or not 0 < expires <= 3600:
    sys.exit(1)
'
}

smoke_agent_check_device_flow_replay() {
  # stdin: two lines — the first start body, then the replay body (the Worker
  # serializes compact JSON, one line each). Exits 0 iff the replay preserved
  # the identity fields. TTL fields are deliberately not compared: a service
  # may legitimately recompute remaining lifetimes on a replay.
  python3 -c '
import json
import sys

lines = sys.stdin.read().splitlines()
if len(lines) != 2:
    sys.exit(1)
try:
    first = json.loads(lines[0])
    replay = json.loads(lines[1])
except Exception:
    sys.exit(1)
if not isinstance(first, dict) or not isinstance(replay, dict):
    sys.exit(1)
for key in ("device_code", "user_code", "verification_url"):
    if first.get(key) != replay.get(key):
        sys.exit(1)
'
}

smoke_agent_run_fixture_self_test() {
  # Exercises both check functions against fixtures: acceptance cases must
  # pass, every violation class must refuse. No network; no real handles.
  local valid_handle="flow_v1.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq"
  local valid_body="{\"device_code\":\"${valid_handle}\",\"user_code\":\"ABCD-EFGH\",\"verification_url\":\"https://staging.asimposium.org/approve\",\"interval_seconds\":5,\"expires_in_seconds\":900}"

  # Acceptance: staging origin, then production origin.
  if ! printf '%s' "$valid_body" | smoke_agent_check_device_flow_shape; then
    return 1
  fi
  local production_body="${valid_body/https:\/\/staging.asimposium.org/https:\/\/asimposium.org}"
  if ! printf '%s' "$production_body" | smoke_agent_check_device_flow_shape; then
    return 1
  fi

  # Refusals: one fixture per violation class.
  local refusal
  for refusal in \
    "${valid_body/ABCD-EFGH/ABCD-EFGI}" \
    "${valid_body/https:\/\/staging.asimposium.org\/approve/https:\/\/evil.example\/approve}" \
    "${valid_body/https:\/\/staging.asimposium.org\/approve/https:\/\/asimposium.org.evil.example\/approve}" \
    "${valid_body/\"interval_seconds\":5/\"interval_seconds\":61}" \
    "${valid_body/\"interval_seconds\":5/\"interval_seconds\":true}" \
    "${valid_body/\"expires_in_seconds\":900/\"expires_in_seconds\":3601}" \
    "${valid_body/flow_v1\./flow_v2.}" \
    "${valid_body/,\"expires_in_seconds\":900/}" \
    "${valid_body/\"user_code\":\"ABCD-EFGH\"/\"user_code\":\"ABCD-EFGH\",\"extra\":1}" \
    "not json"; do
    if printf '%s' "$refusal" | smoke_agent_check_device_flow_shape; then
      return 1
    fi
  done

  # Replay: identical identity fields pass even with a recomputed TTL…
  local replay_different_ttl="{\"device_code\":\"${valid_handle}\",\"user_code\":\"ABCD-EFGH\",\"verification_url\":\"https://staging.asimposium.org/approve\",\"interval_seconds\":5,\"expires_in_seconds\":899}"
  if ! printf '%s\n%s\n' "$valid_body" "$replay_different_ttl" | smoke_agent_check_device_flow_replay; then
    return 1
  fi
  # …and any identity drift refuses.
  local replay_new_code="${valid_body/ABCD-EFGH/WXYZ-2345}"
  if printf '%s\n%s\n' "$valid_body" "$replay_new_code" | smoke_agent_check_device_flow_replay; then
    return 1
  fi
  local replay_new_handle="${valid_body/flow_v1\.A/flow_v1.B}"
  if printf '%s\n%s\n' "$valid_body" "$replay_new_handle" | smoke_agent_check_device_flow_replay; then
    return 1
  fi

  return 0
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
      [[ "$#" -ge 2 ]] || {
        e2e_emit_diagnostic "$suite" "$started_ms" "fail" "RUN_ID_MISSING" "$reproduce"
        exit 64
      }
      explicit_run_id="$2"
      shift
      ;;
    *)
      e2e_emit_diagnostic "$suite" "$started_ms" "fail" "UNKNOWN_ARGUMENT" "$reproduce"
      exit 64
      ;;
  esac
  shift
done

if [[ "$self_test" -eq 1 ]]; then
  e2e_run_harness_self_test "$suite" "$started_ms" "$reproduce"
  if ! smoke_agent_run_fixture_self_test; then
    e2e_emit_diagnostic "$suite" "$started_ms" "fail" "DEVICE_FLOW_FIXTURE_SELF_TEST_FAILED" "$reproduce"
    exit 1
  fi
  exit 0
fi

run_id="$(e2e_resolve_run_id "$suite" "$explicit_run_id")" || {
  e2e_emit_diagnostic "$suite" "$started_ms" "fail" "RUN_ID_INVALID" "$reproduce"
  exit 64
}

if e2e_validate_staging_origin "ASIMPOSIUM_STAGING_AGENT_BASE_URL"; then
  :
else
  origin_status=$?
  case "$origin_status" in
    2) code="STAGING_AGENT_BASE_URL_MISSING" ;;
    *) code="STAGING_AGENT_BASE_URL_INVALID" ;;
  esac
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "$code" "$reproduce"
  exit 78
fi

if ! e2e_probe_public_path "$ASIMPOSIUM_STAGING_AGENT_BASE_URL" "/"; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_HANDBOOK_UNAVAILABLE" "$reproduce"
  exit 69
fi

if ! e2e_probe_public_path "$ASIMPOSIUM_STAGING_AGENT_BASE_URL" "/capabilities"; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_CAPABILITIES_UNAVAILABLE" "$reproduce"
  exit 69
fi

# Device-flow start: the enrollment loop's first executable step. One unique
# Idempotency-Key per run; the replay below reuses it to prove the 24h
# idempotency contract without relying on a previous run's state.
device_flow_idem_key="smoke-agent-$(e2e_now_ms)-$$"
device_flow_payload='{"name":"smoke-agent-probe","model":"g0-smoke/probe","harness":"g0-smoke","requested_scopes":["review"]}'

device_flow_start="$(curl --silent --max-time 15 --connect-timeout 5 \
  --write-out $'\n%{http_code}' \
  --header 'content-type: application/json' \
  --header "Idempotency-Key: $device_flow_idem_key" \
  --data "$device_flow_payload" \
  "$ASIMPOSIUM_STAGING_AGENT_BASE_URL/v1/device-code" 2>/dev/null)" || device_flow_start=""
device_flow_status="${device_flow_start##*$'\n'}"
device_flow_body="${device_flow_start%$'\n'*}"

if [[ "$device_flow_status" != "201" ]]; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_DEVICE_FLOW_START_REFUSED" "$reproduce"
  exit 71
fi

if ! printf '%s' "$device_flow_body" | smoke_agent_check_device_flow_shape; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_DEVICE_FLOW_CONTRACT_VIOLATION" "$reproduce"
  exit 72
fi

device_flow_replay="$(curl --silent --max-time 15 --connect-timeout 5 \
  --write-out $'\n%{http_code}' \
  --header 'content-type: application/json' \
  --header "Idempotency-Key: $device_flow_idem_key" \
  --data "$device_flow_payload" \
  "$ASIMPOSIUM_STAGING_AGENT_BASE_URL/v1/device-code" 2>/dev/null)" || device_flow_replay=""
device_flow_replay_status="${device_flow_replay##*$'\n'}"
device_flow_replay_body="${device_flow_replay%$'\n'*}"

if [[ "$device_flow_replay_status" != "201" ]]; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_DEVICE_FLOW_REPLAY_REFUSED" "$reproduce"
  exit 73
fi

if ! printf '%s\n%s\n' "$device_flow_body" "$device_flow_replay_body" | smoke_agent_check_device_flow_replay; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_DEVICE_FLOW_IDEMPOTENCY_VIOLATION" "$reproduce"
  exit 74
fi

# Pairing approval, sessions, packs, workshop push, refused self-cert (P2/P4),
# refused duplicate (P11), promotion, delta, and close-with-handback are not
# yet implemented on any deployed surface. The preflight and the device-flow
# stage above are real evidence; this gate must not turn them into a
# fabricated G0 result for the loop beyond.
e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_PRODUCT_FLOW_NOT_IMPLEMENTED" "$reproduce"
exit 70
