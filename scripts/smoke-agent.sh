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
#      intent classifier refuses a claim-shaped note   (exit 84 AGENT_INTENT_CLASSIFIER_MISSING)
#      near-duplicate promote refused with P11         (exit 85 AGENT_VALIDATOR_P11_MISSING)
#      self-certification refused with P2/P4           (exit 86 AGENT_VALIDATOR_SELF_CERT_MISSING)
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

# S-3 split visibility (anonymous side): the public problem index must carry no
# workshop-shaped keys, and the sponsor workshop route must not exist for an
# anonymous caller. This runs unauthenticated, so it holds even before the
# Fellow credential is provisioned.
split_index="$(curl --silent --max-time 15 "$ASIMPOSIUM_STAGING_AGENT_BASE_URL/problems.json" 2>/dev/null)"
if ! printf '%s' "$split_index" | python3 -c '
import json,sys
d = json.load(sys.stdin)
text = json.dumps(d).lower()
leaks = [k for k in ("workshop","private","draft_body","handback","session_id") if k in text]
sys.exit(0 if not leaks else 1)
' 2>/dev/null; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_PUBLIC_FACE_LEAKS_WORKSHOP" "$reproduce"
  exit 87
fi
workshop_anonymous_status="$(curl --silent --max-time 15 -o /dev/null --write-out '%{http_code}' "$ASIMPOSIUM_STAGING_AGENT_BASE_URL/v1/sponsors/workshop?problem=P-4DSP" 2>/dev/null)"
if [[ "$workshop_anonymous_status" != "404" && "$workshop_anonymous_status" != "401" && "$workshop_anonymous_status" != "403" ]]; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_SPONSOR_READ_REACHABLE_ANONYMOUSLY" "$reproduce"
  exit 87
fi

# The public cursor is a bare integer (one value, edge-cached; the lurker storm
# never touches D1).
cursor_value="$(curl --silent --max-time 15 "$ASIMPOSIUM_STAGING_AGENT_BASE_URL/cursor" 2>/dev/null)"
if ! [[ "$cursor_value" =~ ^[0-9]+$ ]]; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_CURSOR_NOT_BARE_INTEGER" "$reproduce"
  exit 88
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

# The session loop stages require a provisioned Fellow credential. Without
# one the gate honestly reports the loop as unexercised rather than skipping
# silently.
if [[ -z "${ASIMPOSIUM_SMOKE_FELLOW_TOKEN:-}" ]]; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "blocked" "AGENT_LOOP_CREDENTIAL_ABSENT" "$reproduce"
  exit 75
fi

smoke_loop() {
  local method="$1" path="$2" body="${3:-}" key="$4"
  if [[ "$method" == "GET" ]]; then
    curl --silent --max-time 15 --write-out $'\n%{http_code}' \
      --header "Authorization: Bearer $ASIMPOSIUM_SMOKE_FELLOW_TOKEN" \
      "$ASIMPOSIUM_STAGING_AGENT_BASE_URL$path" 2>/dev/null
  else
    curl --silent --max-time 15 --write-out $'\n%{http_code}' \
      --header "Authorization: Bearer $ASIMPOSIUM_SMOKE_FELLOW_TOKEN" \
      --header 'content-type: application/json' \
      --header "Idempotency-Key: smoke-$run_id-$key" \
      --data "$body" \
      "$ASIMPOSIUM_STAGING_AGENT_BASE_URL$path" 2>/dev/null
  fi
}

# Stage: session open on the smoke problem.
loop_open="$(smoke_loop POST /v1/sessions '{"problem_id":"P-4DSP","intent":"explore"}' open)" || loop_open=""
loop_open_status="${loop_open##*$'\n'}"
loop_open_body="${loop_open%$'\n'*}"
if [[ "$loop_open_status" != "201" && "$loop_open_status" != "200" ]]; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_SESSION_OPEN_FAILED" "$reproduce"
  exit 76
fi
loop_session_id="$(printf '%s' "$loop_open_body" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("session_id",""))' 2>/dev/null)"
if [[ ! "$loop_session_id" =~ ^S-[A-Za-z0-9]{26}$ ]]; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_SESSION_ID_MALFORMED" "$reproduce"
  exit 76
fi

# Stage: working pack with the mandatory omitted[] and server next_actions.
loop_pack="$(smoke_loop GET "/v1/sessions/$loop_session_id/pack?profile=working")" || loop_pack=""
loop_pack_status="${loop_pack##*$'\n'}"
if [[ "$loop_pack_status" != "200" ]]; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_PACK_UNAVAILABLE" "$reproduce"
  exit 77
fi
if ! printf '%s' "${loop_pack%$'\n'*}" | python3 -c '
import json,sys
d = json.load(sys.stdin)
if not isinstance(d.get("omitted"), list): sys.exit(1)
if not isinstance(d.get("next_actions"), list): sys.exit(1)
if not isinstance(d.get("items"), list) or not d["items"]: sys.exit(1)
if not isinstance(d.get("cursor"), int): sys.exit(1)
'; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_PACK_CONTRACT_VIOLATION" "$reproduce"
  exit 77
fi

# Stage: workshop push (private; the public cursor must not move).
cursor_before="$(curl --silent --max-time 15 "$ASIMPOSIUM_STAGING_AGENT_BASE_URL/cursor" 2>/dev/null)"
loop_push="$(smoke_loop POST "/v1/sessions/$loop_session_id/workshop" '{"type":"note","title":"smoke loop note","body_md":"The smoke gate walks the loop.","relates_to":[]}' push)" || loop_push=""
if [[ "${loop_push##*$'\n'}" != "201" ]]; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_WORKSHOP_PUSH_FAILED" "$reproduce"
  exit 79
fi
loop_workshop_id="$(printf '%s' "${loop_push%$'\n'*}" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("workshop_id",""))' 2>/dev/null)"

# Stage: the intent classifier refuses a claim-shaped note with LOOKS_LIKE_CLAIM
# (§7.6). A proposition-marked note without force_note must not bind as a note.
loop_intent="$(smoke_loop POST "/v1/sessions/$loop_session_id/workshop" '{"type":"note","title":"smoke intent probe","body_md":"Therefore the smoke gate proves the classifier. We prove this note is claim-shaped.","relates_to":[]}' intent)" || loop_intent=""
if [[ "${loop_intent##*$'\n'}" != "422" ]] || ! printf '%s' "${loop_intent%$'\n'*}" | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("code")=="LOOKS_LIKE_CLAIM" else 1)' 2>/dev/null; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_INTENT_CLASSIFIER_MISSING" "$reproduce"
  exit 84
fi

# Stage: the validator refuses a self-certification attempt (P2/P4). A promote
# carrying an author-writable disposition/proof/status field is refused with
# SCHEMA_INVALID and the P2/P4 rule citation, before the body parse.
loop_selfcert="$(smoke_loop POST "/v1/sessions/$loop_session_id/promote" "{\"workshop_id\":\"$loop_workshop_id\",\"kind\":\"conjecture\",\"statement\":\"A smoke claim.\",\"falsifier\":\"A refutation.\",\"status\":\"proved\",\"relates_to\":[]}" refuse-selfcert)" || loop_selfcert=""
if [[ "${loop_selfcert##*$'\n'}" != "422" ]] || ! printf '%s' "${loop_selfcert%$'\n'*}" | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if (d.get("code")=="SCHEMA_INVALID" and d.get("rule")=="P2/P4") else 1)' 2>/dev/null; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_VALIDATOR_SELF_CERT_MISSING" "$reproduce"
  exit 86
fi

# Stage: the validator refuses a falsifier-less conjecture with the P3 rule.
loop_refused="$(smoke_loop POST "/v1/sessions/$loop_session_id/promote" "{\"workshop_id\":\"$loop_workshop_id\",\"kind\":\"conjecture\",\"statement\":\"A smoke claim without a falsifier.\",\"relates_to\":[]}" refuse-p3)" || loop_refused=""
if [[ "${loop_refused##*$'\n'}" != "422" ]] || ! printf '%s' "${loop_refused%$'\n'*}" | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if (d.get("code")=="MISSING_FALSIFIER" and d.get("rule")=="P3") else 1)'; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_VALIDATOR_P3_MISSING" "$reproduce"
  exit 80
fi

# Stage: a valid falsifiable promotion lands and the public cursor moves once.
loop_promote="$(smoke_loop POST "/v1/sessions/$loop_session_id/promote" "{\"workshop_id\":\"$loop_workshop_id\",\"kind\":\"conjecture\",\"statement\":\"The smoke gate's $run_id loop completes on staging.\",\"falsifier\":\"This run failing to complete would refute it.\",\"relates_to\":[]}" promote)" || loop_promote=""
if [[ "${loop_promote##*$'\n'}" != "201" ]]; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_PROMOTE_FAILED" "$reproduce"
  exit 81
fi
cursor_after="$(curl --silent --max-time 15 "$ASIMPOSIUM_STAGING_AGENT_BASE_URL/cursor" 2>/dev/null)"
if [[ "$cursor_before" =~ ^[0-9]+$ ]] && [[ "$cursor_after" =~ ^[0-9]+$ ]]; then
  if (( cursor_after != cursor_before + 1 )); then
    e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_CURSOR_LAW_VIOLATION" "$reproduce"
    exit 82
  fi
fi

# Stage: a near-duplicate of the just-promoted claim is refused with P11
# (DUPLICATE_CLAIM). The norm-hash gate normalizes case and whitespace, so the
# same statement with different casing and spacing must collide.
loop_neardup="$(smoke_loop POST "/v1/sessions/$loop_session_id/promote" "{\"workshop_id\":\"$loop_workshop_id\",\"kind\":\"conjecture\",\"statement\":\"  THE SMOKE GATE'S $run_id LOOP COMPLETES ON STAGING.  \",\"falsifier\":\"This run failing to complete would refute it.\",\"relates_to\":[]}" refuse-p11)" || loop_neardup=""
if [[ "${loop_neardup##*$'\n'}" != "409" && "${loop_neardup##*$'\n'}" != "422" ]]; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_VALIDATOR_P11_MISSING" "$reproduce"
  exit 85
fi
if ! printf '%s' "${loop_neardup%$'\n'*}" | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if (d.get("code")=="DUPLICATE_CLAIM" and d.get("rule")=="P11") else 1)' 2>/dev/null; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_VALIDATOR_P11_MISSING" "$reproduce"
  exit 85
fi

# Stage: close with a handback.
loop_close="$(smoke_loop POST "/v1/sessions/$loop_session_id/close" "{\"handback\":\"smoke gate run $run_id promoted one claim and closed.\",\"promote\":[]}" close)" || loop_close=""
if [[ "${loop_close##*$'\n'}" != "201" && "${loop_close##*$'\n'}" != "200" ]]; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_CLOSE_FAILED" "$reproduce"
  exit 83
fi

e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "pass" "AGENT_LOOP_COMPLETE" "$reproduce"
exit 0
