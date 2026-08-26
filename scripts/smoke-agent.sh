#!/usr/bin/env bash
set -euo pipefail
set +x

# Capture the credential into shell memory, then remove its exported name
# before even repository discovery can start a child process. Authenticated
# curl calls later receive it over stdin, never through argv or environment.
smoke_fellow_token="${ASIMPOSIUM_SMOKE_FELLOW_TOKEN:-}"
unset ASIMPOSIUM_SMOKE_FELLOW_TOKEN

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
#   4. full product loop         open → pack → workshop → promote → cursor
#      delta → close, exercised against the deployed surface. Without a
#      Fellow credential (ASIMPOSIUM_SMOKE_FELLOW_TOKEN) the loop is
#      unprovable and the run blocks with
#      exit 75 AGENT_LOOP_CREDENTIAL_ABSENT; with it, a passing run ends
#      exit 0 AGENT_LOOP_COMPLETE.
#
# Other exits: 64 usage/run-id, 78 staging origin missing/invalid,
# 90 AGENT_LOOP_CREDENTIAL_INVALID.
#
# Secret discipline: the device-flow response carries a flow handle. The body
# is held only in shell variables, asserted structurally, and never printed,
# logged, or written to artifacts. Diagnostics carry suite/status/code only.

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=e2e/lib/run-diagnostics.sh
source "$repository_root/e2e/lib/run-diagnostics.sh"
trap 'e2e_close_artifact_writer_leases_on_exit' EXIT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 130' INT
trap 'e2e_leave_artifact_writer_leases_open_on_signal 143' TERM
trap 'e2e_leave_artifact_writer_leases_open_on_signal 129' HUP

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

smoke_agent_check_problem_index_shape() {
  # stdin: the anonymous /problems.json face. This mirrors the closed
  # ProblemsIndexResponseSchema by importing the contracts source of truth.
  # It prints nothing and deliberately does not inspect problem values for
  # workshop-looking words: those are valid untrusted public data.
  (
    cd "$repository_root"
    bun -e '
import { ProblemsIndexResponseSchema } from "@asimposium/contracts";

let value;
try {
  value = JSON.parse(await Bun.stdin.text());
} catch {
  process.exit(1);
}
process.exit(ProblemsIndexResponseSchema.safeParse(value).success ? 0 : 1);
' 2>/dev/null
  )
}

smoke_agent_check_unauthorized_problem() {
  # stdin: the sponsor route refusal. Opaque authorization problems have one
  # exact strict RFC 7807 shape; requiring all six fields prevents a generic
  # WAF or wrong-principal response from impersonating the mounted boundary.
  python3 -c '
import json
import sys

try:
    doc = json.loads(sys.stdin.read())
except Exception:
    sys.exit(1)

expected = {
    "type": "https://asimposium.org/errors/UNAUTHORIZED",
    "title": "Authorization was not accepted",
    "status": 401,
    "code": "UNAUTHORIZED",
    "detail": "The request did not include an authorization accepted by this route.",
    "fix_hint": "Obtain a fresh sponsor authorization and retry the request.",
}
if doc != expected:
    sys.exit(1)
'
}

smoke_agent_fetch_cursor() {
  local origin="$1"
  local response
  local http_status
  local cursor

  response="$(e2e_curl --silent --max-time 15 --write-out $'\n%{http_code}' "$origin/cursor" 2>/dev/null)" || return 1
  http_status="${response##*$'\n'}"
  cursor="${response%$'\n'*}"
  [[ "$http_status" == "200" ]] || return 2
  [[ "$cursor" =~ ^[0-9]+$ ]] || return 3
  printf '%s\n' "$cursor"
}

# Bounded Retry-After honoring for public preflight GETs. A 429 whose
# Retry-After header is absent, non-numeric, non-positive, or above the bound
# refuses immediately: the smoke gate never sleeps on an unbounded or forged
# value, and it retries exactly once before reporting the surface as
# rate-limited.
smoke_agent_retry_after_bound_seconds() {
  local bound="${ASIMPOSIUM_SMOKE_MAX_RETRY_AFTER_SECONDS:-10}"
  [[ "$bound" =~ ^[1-9][0-9]{0,3}$ ]] || return 1
  printf '%s' "$bound"
}

smoke_agent_sleep_retry_after() { # $1 = response headers file; rc 0 = slept
  local raw bound
  raw="$(LC_ALL=C grep -i '^retry-after:' "$1" 2>/dev/null | tail -n 1 | cut -d: -f2- | tr -d ' \t\r')" || return 1
  [[ -n "$raw" && "$raw" =~ ^[0-9]+$ ]] || return 1
  (( 10#$raw > 0 )) || return 1
  bound="$(smoke_agent_retry_after_bound_seconds)" || return 1
  (( 10#$raw <= 10#$bound )) || return 1
  sleep "$raw"
}

# Runs one GET and prints curl's body+write-out blob unchanged. On a 429 with
# an honorable Retry-After it sleeps once and retries once. Returns 29 when
# the surface stays rate-limited or the header is not honorably bounded;
# returns the transport failure code otherwise. Headers never outlive this
# function and are written only to a private file under TMPDIR.
smoke_agent_fetch_with_rate_limit() { # $1 = write-out, $2 = url, rest = extra args
  local write_out="$1" url="$2" attempt headers response status status_line curl_status
  shift 2
  for attempt in 1 2; do
    headers="$(mktemp "${TMPDIR:-/tmp}/smoke-agent-headers.XXXXXX")" || return 99
    curl_status=0
    response="$(e2e_curl --silent --max-time 15 --connect-timeout 5 \
      --dump-header "$headers" --write-out "$write_out" "$@" "$url" 2>/dev/null)" || curl_status=$?
    if (( curl_status != 0 )); then
      rm -f "$headers"
      return "$curl_status"
    fi
    status_line="${response##*$'\n'}"
    status="${status_line%%$'\t'*}"
    if [[ "$status" == "429" ]]; then
      if [[ "$attempt" -eq 1 ]] && smoke_agent_sleep_retry_after "$headers"; then
        rm -f "$headers"
        continue
      fi
      rm -f "$headers"
      return 29
    fi
    rm -f "$headers"
    printf '%s' "$response"
    return 0
  done
}

# e2e_probe_public_path semantics (2xx without redirect) plus rate-limiting.
smoke_agent_probe_with_rate_limit() { # $1 = origin, $2 = path; rc 29 = rate-limited
  local origin="$1" path="$2" probe_result http_status redirect_url fetch_status
  fetch_status=0
  probe_result="$(smoke_agent_fetch_with_rate_limit $'%{http_code}\t%{redirect_url}' "$origin$path" --output /dev/null)" || fetch_status=$?
  if (( fetch_status != 0 )); then
    if (( fetch_status == 29 )); then
      return 29
    fi
    return 1
  fi
  [[ "$probe_result" == *$'\t'* && "$probe_result" != *$'\n'* ]] || return 1
  http_status="${probe_result%%$'\t'*}"
  redirect_url="${probe_result#*$'\t'}"
  [[ "$redirect_url" != *$'\t'* ]] || return 1
  [[ "$http_status" =~ ^2[0-9][0-9]$ && -z "$redirect_url" ]]
}

smoke_agent_run_fixture_self_test() {
  # Exercises the response check functions against fixtures: acceptance must
  # pass, every violation class must refuse. No network; no real handles.
  local valid_handle="flow_v1.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq"
  local valid_body="{\"device_code\":\"${valid_handle}\",\"user_code\":\"ABCD-EFGH\",\"verification_url\":\"https://staging.asimposium.org/approve\",\"interval_seconds\":5,\"expires_in_seconds\":900}"

  # The entrypoint must scrub the exported credential before this function's
  # Python children run. The helper mirrors FellowTokenSchema's exact grammar.
  if [[ "${ASIMPOSIUM_SMOKE_FELLOW_TOKEN+present}" == "present" ]]; then
    return 1
  fi
  local valid_fellow_token="asimp_ag_0123456789ABCDEFGHJKMNPQRS_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  e2e_validate_fellow_token "$valid_fellow_token" || return 1
  local invalid_fellow_token
  for invalid_fellow_token in \
    "${valid_fellow_token/asimp_ag_/asimp_ax_}" \
    "${valid_fellow_token/A/I}" \
    "${valid_fellow_token%?}" \
    "${valid_fellow_token}_" \
    $'asimp_ag_0123456789ABCDEFGHJKMNPQRS_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\nforged'; do
    if e2e_validate_fellow_token "$invalid_fellow_token"; then
      return 1
    fi
  done

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

  local valid_problem_index='{"problems":[{"id":"P-private-workshop","public_seq":0,"created_at":"2024-02-29T00:00:00.000Z","updated_at":"2026-01-01T00:00:00.000Z"}],"omitted":["bodies"]}'
  if ! printf '%s' "$valid_problem_index" | smoke_agent_check_problem_index_shape; then
    return 1
  fi
  local boundary_problem_index="${valid_problem_index/\"public_seq\":0/\"public_seq\":9007199254740991}"
  if ! printf '%s' "$boundary_problem_index" | smoke_agent_check_problem_index_shape; then
    return 1
  fi
  for refusal in \
    '{}' \
    '[]' \
    '{"problems":[],"omitted":[],"extra":true}' \
    '{"problems":[{"id":"P--BAD","public_seq":0,"created_at":"2026-01-01T00:00:00.000Z","updated_at":"2026-01-01T00:00:00.000Z"}],"omitted":[]}' \
    '{"problems":[{"id":"P-GOOD","public_seq":true,"created_at":"2026-01-01T00:00:00.000Z","updated_at":"2026-01-01T00:00:00.000Z"}],"omitted":[]}' \
    '{"problems":[{"id":"P-GOOD","public_seq":9007199254740992,"created_at":"2026-01-01T00:00:00.000Z","updated_at":"2026-01-01T00:00:00.000Z"}],"omitted":[]}' \
    '{"problems":[{"id":"P-GOOD","public_seq":0,"created_at":"2026-02-30T00:00:00.000Z","updated_at":"2026-01-01T00:00:00.000Z"}],"omitted":[]}' \
    '{"problems":[{"id":"P-GOOD","public_seq":0,"created_at":"2026-01-01T00:00:00.000Z","updated_at":"2026-02-30T00:00:00.000Z"}],"omitted":[]}' \
    '{"problems":[{"id":"P-GOOD","public_seq":0,"created_at":"2026-01-01T00:00:00.000Z","updated_at":"2026-01-01T00:00:00.000Z","extra":true}],"omitted":[]}' \
    '{"problems":[],"omitted":[""]}' \
    '{"problems":[],"omitted":["xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"]}'; do
    if printf '%s' "$refusal" | smoke_agent_check_problem_index_shape; then
      return 1
    fi
  done

  local oversized_problem_index
  oversized_problem_index="$(python3 -c '
import json
entry = {
    "id": "P-GOOD",
    "public_seq": 0,
    "created_at": "2026-01-01T00:00:00.000Z",
    "updated_at": "2026-01-01T00:00:00.000Z",
}
print(json.dumps({"problems": [entry] * 201, "omitted": []}, separators=(",", ":")))
')" || return 1
  if printf '%s' "$oversized_problem_index" | smoke_agent_check_problem_index_shape; then
    return 1
  fi

  local valid_unauthorized_problem='{"type":"https://asimposium.org/errors/UNAUTHORIZED","title":"Authorization was not accepted","status":401,"code":"UNAUTHORIZED","detail":"The request did not include an authorization accepted by this route.","fix_hint":"Obtain a fresh sponsor authorization and retry the request."}'
  if ! printf '%s' "$valid_unauthorized_problem" | smoke_agent_check_unauthorized_problem; then
    return 1
  fi
  for refusal in \
    '{}' \
    "${valid_unauthorized_problem/\"code\":\"UNAUTHORIZED\"/\"code\":\"WRONG_PRINCIPAL\"}" \
    "${valid_unauthorized_problem/\"status\":401/\"status\":403}" \
    "${valid_unauthorized_problem/Authorization was not accepted/Generic denial}" \
    "${valid_unauthorized_problem/The request did not include an authorization accepted by this route./Generic detail.}" \
    "${valid_unauthorized_problem/Obtain a fresh sponsor authorization and retry the request./Retry later.}" \
    '{"type":"https://asimposium.org/errors/UNAUTHORIZED","title":"Authorization was not accepted","status":401,"code":"UNAUTHORIZED","detail":"The request did not include an authorization accepted by this route.","fix_hint":"Retry.","extra":true}'; do
    if printf '%s' "$refusal" | smoke_agent_check_unauthorized_problem; then
      return 1
    fi
  done

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
      if [[ "$2" == --* || -z "$2" ]]; then
        e2e_emit_diagnostic "$suite" "$started_ms" "fail" "RUN_ID_MISSING" "$reproduce"
        exit 64
      fi
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

if [[ -n "$explicit_run_id" ]]; then
  e2e_validate_run_id "$explicit_run_id" || {
    e2e_emit_diagnostic "$suite" "$started_ms" "fail" "RUN_ID_INVALID" "$reproduce"
    exit 64
  }
fi

if [[ "$self_test" -eq 1 ]]; then
  e2e_run_harness_self_test "$suite" "$started_ms" "$reproduce"
  if ! smoke_agent_run_fixture_self_test; then
    e2e_emit_diagnostic "$suite" "$started_ms" "fail" "SMOKE_RESPONSE_FIXTURE_SELF_TEST_FAILED" "$reproduce"
    exit 1
  fi
  exit 0
fi

run_id="$(e2e_resolve_run_id "$suite" "$explicit_run_id")" || {
  e2e_emit_diagnostic "$suite" "$started_ms" "fail" "RUN_ID_INVALID" "$reproduce"
  exit 64
}
if [[ "$write_artifacts" -eq 1 ]] \
  && ! e2e_claim_artifact_run_at_root "$repository_root" "$run_id"; then
  e2e_emit_diagnostic "$suite" "$started_ms" "blocked" "ARTIFACT_RUN_ALREADY_EXISTS" "$reproduce"
  exit 78
fi

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

if [[ -n "$smoke_fellow_token" ]] && ! e2e_validate_fellow_token "$smoke_fellow_token"; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_LOOP_CREDENTIAL_INVALID" "$reproduce"
  exit 90
fi

handbook_status=0
smoke_agent_probe_with_rate_limit "$ASIMPOSIUM_STAGING_AGENT_BASE_URL" "/" || handbook_status=$?
if (( handbook_status != 0 )); then
  if (( handbook_status == 29 )); then
    e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_HANDBOOK_RATE_LIMITED" "$reproduce"
  else
    e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_HANDBOOK_UNAVAILABLE" "$reproduce"
  fi
  exit 69
fi

capabilities_status=0
smoke_agent_probe_with_rate_limit "$ASIMPOSIUM_STAGING_AGENT_BASE_URL" "/capabilities" || capabilities_status=$?
if (( capabilities_status != 0 )); then
  if (( capabilities_status == 29 )); then
    e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_CAPABILITIES_RATE_LIMITED" "$reproduce"
  else
    e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_CAPABILITIES_UNAVAILABLE" "$reproduce"
  fi
  exit 69
fi

# S-3 split visibility (anonymous side): the public problem index must satisfy
# its complete closed contract and carry no workshop-shaped field names. This
# check cannot prove absence of private bytes without a seeded canary; that
# stronger deployed pair remains an S-3 evidence boundary. The sponsor route
# must also return its exact anonymous authorization face before body parsing.
split_index_fetch_status=0
split_index_response="$(smoke_agent_fetch_with_rate_limit $'\n%{http_code}\t%{content_type}' "$ASIMPOSIUM_STAGING_AGENT_BASE_URL/problems.json")" || split_index_fetch_status=$?
if (( split_index_fetch_status == 29 )); then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_PROBLEM_INDEX_RATE_LIMITED" "$reproduce"
  exit 87
elif (( split_index_fetch_status != 0 )); then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_PROBLEM_INDEX_UNAVAILABLE" "$reproduce"
  exit 87
fi
split_index_meta="${split_index_response##*$'\n'}"
split_index="${split_index_response%$'\n'*}"
[[ "$split_index_meta" == *$'\t'* && "$split_index_meta" != *$'\n'* && "$split_index_meta" != *$'\r'* ]] || {
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_PROBLEM_INDEX_HTTP_FAILURE" "$reproduce"
  exit 87
}
split_index_status="${split_index_meta%%$'\t'*}"
split_index_content_type="${split_index_meta#*$'\t'}"
[[ "$split_index_content_type" != *$'\t'* ]] || {
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_PROBLEM_INDEX_HTTP_FAILURE" "$reproduce"
  exit 87
}
if [[ "$split_index_status" != "200" ]]; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_PROBLEM_INDEX_HTTP_FAILURE" "$reproduce"
  exit 87
fi
if [[ "$(printf '%s' "$split_index_content_type" | e2e_ascii_lower)" != "application/json; charset=utf-8" ]]; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_PROBLEM_INDEX_MEDIA_TYPE_INVALID" "$reproduce"
  exit 87
fi
if ! printf '%s' "$split_index" | python3 -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_PROBLEM_INDEX_MALFORMED" "$reproduce"
  exit 87
fi
if ! printf '%s' "$split_index" | python3 -c '
import json,sys
d = json.load(sys.stdin)
forbidden = {"workshop", "private", "draft_body", "handback", "session_id"}

def keys(value):
    if isinstance(value, dict):
        for key, child in value.items():
            yield str(key).lower()
            yield from keys(child)
    elif isinstance(value, list):
        for child in value:
            yield from keys(child)

leaks = {key for key in keys(d) if any(marker in key for marker in forbidden)}
sys.exit(0 if not leaks else 1)
' 2>/dev/null; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_PUBLIC_FACE_EXPOSES_FORBIDDEN_FIELDS" "$reproduce"
  exit 87
fi
if ! printf '%s' "$split_index" | smoke_agent_check_problem_index_shape 2>/dev/null; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_PROBLEM_INDEX_CONTRACT_VIOLATION" "$reproduce"
  exit 87
fi
# Deliberately invalid request-contract shape: a mounted sponsor-auth boundary
# must refuse the absent service envelope before it consults the contract. A 4xx
# parser response therefore proves the ordering regressed without needing a
# real private Fellow id in this anonymous lane.
if ! workshop_anonymous_response="$(e2e_curl --silent --max-time 15 --write-out $'\n%{http_code}\t%{content_type}' --request POST --header 'content-type: application/json' --data '{}' "$ASIMPOSIUM_STAGING_AGENT_BASE_URL/v1/sponsors/workshop" 2>/dev/null)"; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_SPONSOR_READ_PROBE_UNAVAILABLE" "$reproduce"
  exit 87
fi
workshop_anonymous_meta="${workshop_anonymous_response##*$'\n'}"
workshop_anonymous_body="${workshop_anonymous_response%$'\n'*}"
[[ "$workshop_anonymous_meta" == *$'\t'* && "$workshop_anonymous_meta" != *$'\n'* && "$workshop_anonymous_meta" != *$'\r'* ]] || {
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_SPONSOR_AUTH_BOUNDARY_UNPROVEN" "$reproduce"
  exit 87
}
workshop_anonymous_status="${workshop_anonymous_meta%%$'\t'*}"
workshop_anonymous_content_type="${workshop_anonymous_meta#*$'\t'}"
[[ "$workshop_anonymous_content_type" != *$'\t'* ]] || {
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_SPONSOR_AUTH_BOUNDARY_UNPROVEN" "$reproduce"
  exit 87
}
case "$workshop_anonymous_status" in
  401)
    if [[ "$(printf '%s' "$workshop_anonymous_content_type" | e2e_ascii_lower)" != "application/problem+json; charset=utf-8" ]] \
      || ! printf '%s' "$workshop_anonymous_body" | smoke_agent_check_unauthorized_problem 2>/dev/null; then
      e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_SPONSOR_AUTH_BOUNDARY_UNPROVEN" "$reproduce"
      exit 87
    fi
    ;;
  2[0-9][0-9])
    e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_SPONSOR_READ_REACHABLE_ANONYMOUSLY" "$reproduce"
    exit 87
    ;;
  400 | 415 | 422)
    e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_SPONSOR_AUTHENTICATION_BYPASSED" "$reproduce"
    exit 87
    ;;
  *)
    e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_SPONSOR_AUTH_BOUNDARY_UNPROVEN" "$reproduce"
    exit 87
    ;;
esac

# The public cursor is a bare integer and edge-cacheable for five seconds. An
# origin miss performs one bounded D1 read; agents never poll a Vercel surface.
if smoke_agent_fetch_cursor "$ASIMPOSIUM_STAGING_AGENT_BASE_URL" >/dev/null; then
  :
else
  cursor_read_status=$?
  case "$cursor_read_status" in
    1) cursor_code="AGENT_CURSOR_UNAVAILABLE" ;;
    2) cursor_code="AGENT_CURSOR_HTTP_FAILURE" ;;
    *) cursor_code="AGENT_CURSOR_NOT_BARE_INTEGER" ;;
  esac
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "$cursor_code" "$reproduce"
  exit 88
fi

# Device-flow start: the enrollment loop's first executable step. One unique
# Idempotency-Key per run; the replay below reuses it to prove the 24h
# idempotency contract without relying on a previous run's state.
device_flow_idem_key="smoke-agent-$(e2e_now_ms)-$$"
device_flow_payload='{"name":"smoke-agent-probe","model":"g0-smoke/probe","harness":"g0-smoke","requested_scopes":["review"]}'

device_flow_start="$(e2e_curl --silent --max-time 15 --connect-timeout 5 \
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

device_flow_replay="$(e2e_curl --silent --max-time 15 --connect-timeout 5 \
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
if [[ -z "$smoke_fellow_token" ]]; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "blocked" "AGENT_LOOP_CREDENTIAL_ABSENT" "$reproduce"
  exit 75
fi

smoke_loop() {
  local method="$1" path="$2" body="${3:-}" key="$4"
  if [[ "$method" == "GET" ]]; then
    e2e_curl_with_fellow_token "$smoke_fellow_token" \
      --silent --max-time 15 --write-out $'\n%{http_code}' \
      "$ASIMPOSIUM_STAGING_AGENT_BASE_URL$path" 2>/dev/null
  else
    e2e_curl_with_fellow_token "$smoke_fellow_token" \
      --silent --max-time 15 --write-out $'\n%{http_code}' \
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
loop_session_id="$(printf '%s' "$loop_open_body" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("session_id",""))' 2>/dev/null)" || loop_session_id=""
if [[ ! "$loop_session_id" =~ ^S-[A-Za-z0-9]{26}$ ]]; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_SESSION_ID_MALFORMED" "$reproduce"
  exit 76
fi

# Stage: working pack with the mandatory omitted[] and server next_actions.
# A direct read: the nested smoke_loop_read -> smoke_loop command substitution
# dropped the GET body, so the pack reads directly.
loop_pack="$(e2e_curl_with_fellow_token "$smoke_fellow_token" --silent --max-time 15 --write-out $'\n%{http_code}' "$ASIMPOSIUM_STAGING_AGENT_BASE_URL/v1/sessions/$loop_session_id/pack?profile=working")" || loop_pack=""
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
cursor_before="$(smoke_agent_fetch_cursor "$ASIMPOSIUM_STAGING_AGENT_BASE_URL")" || {
  cursor_read_status=$?
  case "$cursor_read_status" in
    1) cursor_code="AGENT_CURSOR_UNAVAILABLE" ;;
    2) cursor_code="AGENT_CURSOR_HTTP_FAILURE" ;;
    *) cursor_code="AGENT_CURSOR_NOT_BARE_INTEGER" ;;
  esac
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "$cursor_code" "$reproduce"
  exit 88
}
loop_push="$(smoke_loop POST "/v1/sessions/$loop_session_id/workshop" '{"type":"note","title":"smoke loop note","body_md":"The smoke gate walks the loop.","relates_to":[]}' push)" || loop_push=""
if [[ "${loop_push##*$'\n'}" != "201" ]]; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_WORKSHOP_PUSH_FAILED" "$reproduce"
  exit 79
fi
loop_workshop_id="$(printf '%s' "${loop_push%$'\n'*}" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("workshop_id",""))' 2>/dev/null)" || loop_workshop_id=""
if [[ ! "$loop_workshop_id" =~ ^W-[A-Za-z0-9]{26}$ ]]; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_WORKSHOP_ID_MALFORMED" "$reproduce"
  exit 79
fi

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

# Stage: a valid falsifiable promotion lands and the global public cursor
# advances. Other staging writers may promote concurrently, so an increase
# greater than one is valid; the following P11 lookup independently proves
# that this run's exact claim committed.
loop_promote="$(smoke_loop POST "/v1/sessions/$loop_session_id/promote" "{\"workshop_id\":\"$loop_workshop_id\",\"kind\":\"conjecture\",\"statement\":\"The smoke gate's $run_id loop completes on staging.\",\"falsifier\":\"This run failing to complete would refute it.\",\"relates_to\":[]}" promote)" || loop_promote=""
if [[ "${loop_promote##*$'\n'}" != "201" ]]; then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_PROMOTE_FAILED" "$reproduce"
  exit 81
fi
cursor_after="$(smoke_agent_fetch_cursor "$ASIMPOSIUM_STAGING_AGENT_BASE_URL")" || {
  cursor_read_status=$?
  case "$cursor_read_status" in
    1) cursor_code="AGENT_CURSOR_UNAVAILABLE" ;;
    2) cursor_code="AGENT_CURSOR_HTTP_FAILURE" ;;
    *) cursor_code="AGENT_CURSOR_NOT_BARE_INTEGER" ;;
  esac
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "$cursor_code" "$reproduce"
  exit 88
}
if (( cursor_after < cursor_before + 1 )); then
  e2e_emit_and_optionally_record "$write_artifacts" "$run_id" "$suite" "$started_ms" "fail" "AGENT_CURSOR_LAW_VIOLATION" "$reproduce"
  exit 82
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
