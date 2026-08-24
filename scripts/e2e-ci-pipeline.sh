#!/usr/bin/env bash
set -u -o pipefail

# OPS.2b review pipeline. Cloudflare Workers Builds is the selected hosted-runner
# design; this entry point remains provider-neutral at the command boundary and
# delegates product assertions to their existing suites.

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source=e2e/lib/run-diagnostics.sh
source "$repository_root/e2e/lib/run-diagnostics.sh"

readonly SUITE="ci-pipeline"
readonly USER_AGENT="OpenAI File Downloader, XaiImageApiFetch/1.0"
readonly STAGING_WORKER_ORIGIN="https://a-staging.asimposium.org"
readonly VERCEL_CLI_VERSION="59.5.0"
readonly PIPELINE_TEST_MODE="${ASIMP_CI_PROCESS_TEST:-0}"
readonly -a STAGES=(
  "root-gate"
  "worker-deploy"
  "worker-readiness"
  "web-deploy"
  "smoke-agent"
  "smoke-gallery"
)

RUN_ID=""
REVISION=""
RUNNER="manual"
RUNNER_BUILD_ID=""
ARTIFACT_DIRECTORY=""
CURRENT_STAGE=""
CURRENT_STAGE_STARTED=""
CURRENT_WRAPPER_PID=""
CURRENT_STAGE_RECORDED=0

usage() {
  printf 'usage: scripts/e2e-ci-pipeline.sh [--run-id <safe-id>]\n' >&2
}

now_iso() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

stage_index() {
  local wanted="$1" index
  for ((index = 0; index < ${#STAGES[@]}; index += 1)); do
    if [[ "${STAGES[$index]}" == "$wanted" ]]; then
      printf '%s\n' "$index"
      return 0
    fi
  done
  return 1
}

append_evidence() {
  local record="$1"
  if [[ "$PIPELINE_TEST_MODE" == "1" ]]; then
    [[ -n "$ARTIFACT_DIRECTORY" && -d "$ARTIFACT_DIRECTORY" && ! -L "$ARTIFACT_DIRECTORY" ]] || return 1
    [[ ! -L "$ARTIFACT_DIRECTORY/ci-pipeline.jsonl" ]] || return 1
    printf '%s\n' "$record" >> "$ARTIFACT_DIRECTORY/ci-pipeline.jsonl"
    return $?
  fi
  e2e_append_artifact_jsonl_at_root \
    "$repository_root" "$RUN_ID" "ci-pipeline.jsonl" "$record" >/dev/null
}

record_stage() {
  local stage="$1" status="$2" exit_code="$3" started_at="$4" finished_at="$5"
  local record
  record="{\"tool\":\"bash\",\"package\":\"e2e\",\"suite\":\"$SUITE\",\"run_id\":\"$RUN_ID\",\"revision\":\"$REVISION\",\"runner\":\"$RUNNER\",\"stage\":\"$stage\",\"status\":\"$status\",\"exit_code\":$exit_code,\"started_at\":\"$started_at\",\"finished_at\":\"$finished_at\"}"
  append_evidence "$record" || return 1
  printf '%s\n' "$record"
}

record_deployment() {
  local provider="$1" deployment_id="$2" observed_at="$3" status="$4"
  local record
  record="{\"tool\":\"bash\",\"package\":\"e2e\",\"suite\":\"$SUITE\",\"run_id\":\"$RUN_ID\",\"revision\":\"$REVISION\",\"runner\":\"$RUNNER\",\"record\":\"deployment\",\"provider\":\"$provider\",\"deployment_id\":\"$deployment_id\",\"status\":\"$status\",\"observed_at\":\"$observed_at\"}"
  append_evidence "$record" || return 1
  printf '%s\n' "$record"
}

delegated_value() {
  case "$1:$2" in
    cold-agent-gauntlet:status) printf '%s\n' "${ASIMP_CI_GAUNTLET_STATUS:-not-run}" ;;
    cold-agent-gauntlet:observed) printf '%s\n' "${ASIMP_CI_GAUNTLET_OBSERVED_AT:-}" ;;
    human-playwright:status) printf '%s\n' "${ASIMP_CI_PLAYWRIGHT_STATUS:-not-run}" ;;
    human-playwright:observed) printf '%s\n' "${ASIMP_CI_PLAYWRIGHT_OBSERVED_AT:-}" ;;
    load:status) printf '%s\n' "${ASIMP_CI_LOAD_STATUS:-not-run}" ;;
    load:observed) printf '%s\n' "${ASIMP_CI_LOAD_OBSERVED_AT:-}" ;;
    restore:status) printf '%s\n' "${ASIMP_CI_RESTORE_STATUS:-not-run}" ;;
    restore:observed) printf '%s\n' "${ASIMP_CI_RESTORE_OBSERVED_AT:-}" ;;
    launch:status) printf '%s\n' "${ASIMP_CI_LAUNCH_STATUS:-not-run}" ;;
    launch:observed) printf '%s\n' "${ASIMP_CI_LAUNCH_OBSERVED_AT:-}" ;;
    release:status) printf '%s\n' "${ASIMP_CI_RELEASE_STATUS:-not-run}" ;;
    release:observed) printf '%s\n' "${ASIMP_CI_RELEASE_OBSERVED_AT:-}" ;;
    *) return 64 ;;
  esac
}

validate_delegated_statuses() {
  local name status observed
  for name in cold-agent-gauntlet human-playwright load restore launch release; do
    status="$(delegated_value "$name" status)" || return 64
    observed="$(delegated_value "$name" observed)" || return 64
    case "$status" in
      not-run)
        [[ -z "$observed" ]] || return 64
        ;;
      pass | blocked | stale)
        [[ "$observed" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || return 64
        ;;
      *) return 64 ;;
    esac
  done
}

record_delegated_statuses() {
  local force_not_run="${1:-0}" name status observed observed_json record
  for name in cold-agent-gauntlet human-playwright load restore launch release; do
    if [[ "$force_not_run" == "1" ]]; then
      status="not-run"
      observed=""
    else
      status="$(delegated_value "$name" status)" || return 64
      observed="$(delegated_value "$name" observed)" || return 64
    fi
    observed_json="null"
    if [[ -n "$observed" ]]; then
      observed_json="\"$observed\""
    fi
    record="{\"tool\":\"bash\",\"package\":\"e2e\",\"suite\":\"$SUITE\",\"run_id\":\"$RUN_ID\",\"revision\":\"$REVISION\",\"runner\":\"$RUNNER\",\"record\":\"delegated-suite\",\"delegated_suite\":\"$name\",\"status\":\"$status\",\"observed_at\":$observed_json}"
    append_evidence "$record" || return 1
    printf '%s\n' "$record"
  done
}

record_remaining_not_run() {
  local completed_stage="$1" completed_index index timestamp
  completed_index="$(stage_index "$completed_stage")" || return 1
  timestamp="$(now_iso)"
  for ((index = completed_index + 1; index < ${#STAGES[@]}; index += 1)); do
    record_stage "${STAGES[$index]}" "not-run" "null" "$timestamp" "$timestamp" || return 1
  done
}

assert_revision_unchanged() {
  local checkout_status
  [[ "$(git -C "$repository_root" rev-parse HEAD 2>/dev/null)" == "$REVISION" ]] || return 65
  if [[ "$PIPELINE_TEST_MODE" != "1" ]]; then
    checkout_status="$(git -C "$repository_root" status --porcelain=v1 --untracked-files=normal 2>/dev/null)" || return 65
    [[ -z "$checkout_status" ]] || return 65
  fi
}

validate_runner_context() {
  case "$RUNNER" in
    manual)
      [[ "${WORKERS_CI:-0}" != "1" ]] || return 78
      ;;
    cloudflare-workers-builds)
      [[ "${CI:-}" == "true" && "${WORKERS_CI:-}" == "1" ]] || return 78
      [[ "${WORKERS_CI_COMMIT_SHA:-}" == "$REVISION" ]] || return 65
      [[ "${WORKERS_CI_BUILD_UUID:-}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || return 78
      RUNNER_BUILD_ID="$WORKERS_CI_BUILD_UUID"
      ;;
    *) return 64 ;;
  esac
}

record_runner_context() {
  local build_id_json="null" observed_at record
  if [[ -n "$RUNNER_BUILD_ID" ]]; then
    build_id_json="\"$RUNNER_BUILD_ID\""
  fi
  observed_at="$(now_iso)"
  record="{\"tool\":\"bash\",\"package\":\"e2e\",\"suite\":\"$SUITE\",\"run_id\":\"$RUN_ID\",\"revision\":\"$REVISION\",\"runner\":\"$RUNNER\",\"record\":\"runner\",\"status\":\"observed\",\"runner_build_id\":$build_id_json,\"observed_at\":\"$observed_at\"}"
  append_evidence "$record" || return 1
  printf '%s\n' "$record"
}

timeout_for_stage() {
  local stage="$1" value
  case "$stage" in
    root-gate) value="${ASIMP_CI_ROOT_GATE_TIMEOUT_SECONDS:-3600}" ;;
    worker-deploy) value="${ASIMP_CI_WORKER_DEPLOY_TIMEOUT_SECONDS:-900}" ;;
    worker-readiness) value="${ASIMP_CI_WORKER_READINESS_TIMEOUT_SECONDS:-1800}" ;;
    web-deploy) value="${ASIMP_CI_WEB_DEPLOY_TIMEOUT_SECONDS:-1800}" ;;
    smoke-agent) value="${ASIMP_CI_SMOKE_AGENT_TIMEOUT_SECONDS:-900}" ;;
    smoke-gallery) value="${ASIMP_CI_SMOKE_GALLERY_TIMEOUT_SECONDS:-900}" ;;
    *) return 64 ;;
  esac
  [[ "$value" =~ ^[0-9]+$ ]] || return 64
  ((value >= 1 && value <= 7200)) || return 64
  printf '%s\n' "$value"
}

on_signal() {
  local signal_name="$1" exit_code="$2" finished_at
  trap - INT TERM HUP
  if [[ -n "$CURRENT_WRAPPER_PID" ]]; then
    kill -s "$signal_name" "$CURRENT_WRAPPER_PID" 2>/dev/null || true
    wait "$CURRENT_WRAPPER_PID" 2>/dev/null || true
  fi
  if [[ -n "$CURRENT_STAGE" && "$CURRENT_STAGE_RECORDED" == "0" ]]; then
    finished_at="$(now_iso)"
    record_stage "$CURRENT_STAGE" "cancelled" "$exit_code" "$CURRENT_STAGE_STARTED" "$finished_at" || true
    CURRENT_STAGE_RECORDED=1
    record_remaining_not_run "$CURRENT_STAGE" || true
    record_delegated_statuses 1 || true
  fi
  exit "$exit_code"
}

trap 'on_signal INT 130' INT
trap 'on_signal TERM 143' TERM
trap 'on_signal HUP 129' HUP

run_bounded() {
  local timeout_seconds="$1" status
  shift
  python3 - "$timeout_seconds" "$@" <<'PY' &
import os
import signal
import subprocess
import sys
import time

timeout_seconds = int(sys.argv[1])
command = sys.argv[2:]
child = subprocess.Popen(command, start_new_session=True)
caught = None

def terminate_group(first_signal: int) -> None:
    def group_exists() -> bool:
        # Reap an exited group leader before probing the process group. A live
        # ignoring descendant keeps the group addressable after that reap.
        child.poll()
        try:
            os.killpg(child.pid, 0)
        except ProcessLookupError:
            return False
        return True

    try:
        os.killpg(child.pid, first_signal)
    except ProcessLookupError:
        return
    deadline = time.monotonic() + 1.0
    while group_exists() and time.monotonic() < deadline:
        time.sleep(0.02)
    if group_exists():
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

def cancelled(signum: int, _frame: object) -> None:
    global caught
    caught = signum
    terminate_group(signum)

for forwarded in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
    signal.signal(forwarded, cancelled)

deadline = time.monotonic() + timeout_seconds
while child.poll() is None and caught is None and time.monotonic() < deadline:
    time.sleep(0.02)

if caught is not None:
    child.wait()
    sys.exit(128 + caught)
if child.poll() is None:
    terminate_group(signal.SIGTERM)
    child.wait()
    sys.exit(124)

status = child.returncode
sys.exit(128 - status if status < 0 else status)
PY
  CURRENT_WRAPPER_PID=$!
  wait "$CURRENT_WRAPPER_PID"
  status=$?
  CURRENT_WRAPPER_PID=""
  return "$status"
}

plant_stage() {
  local stage="$1" planted_stage outcome
  [[ "$PIPELINE_TEST_MODE" == "1" ]] || return 64
  planted_stage="${ASIMP_CI_PROCESS_PLANT_STAGE:-}"
  outcome="${ASIMP_CI_PROCESS_PLANT_OUTCOME:-pass}"
  if [[ -n "${ASIMP_CI_PROCESS_TRACE:-}" ]]; then
    printf 'begin:%s\n' "$stage" >> "$ASIMP_CI_PROCESS_TRACE"
  fi
  if [[ "$stage" != "$planted_stage" ]]; then
    return 0
  fi
  case "$outcome" in
    pass) return 0 ;;
    hang | hang-orphan)
      if [[ "$outcome" == "hang-orphan" ]]; then
        trap 'exit 143' TERM
      else
        trap '' TERM
      fi
      trap '' INT HUP
      if [[ -n "${ASIMP_CI_PROCESS_TRACE:-}" ]]; then
        (
          trap '' INT TERM HUP
          sleep 3
          printf 'descendant-survived:%s\n' "$stage" >> "$ASIMP_CI_PROCESS_TRACE"
        ) &
      fi
      sleep 30
      ;;
    *)
      [[ "$outcome" =~ ^[0-9]+$ ]] || return 64
      ((outcome >= 1 && outcome <= 255)) || return 64
      return "$outcome"
      ;;
  esac
}

require_live_variable() {
  [[ -n "${!1:-}" ]] || {
    printf 'ci-pipeline: required hosted variable is missing: %s\n' "$1" >&2
    return 78
  }
}

require_bearer_token() {
  local name="$1" value="${!1:-}"
  require_live_variable "$name" || return $?
  [[ "$value" =~ ^[A-Za-z0-9._~-]{20,512}$ ]] || {
    printf 'ci-pipeline: hosted bearer token has an unsafe shape: %s\n' "$name" >&2
    return 78
  }
}

curl_with_bearer() {
  local token="$1"
  shift
  # Supplying the header through curl's stdin config keeps the credential out
  # of process argv and therefore out of routine process-table diagnostics.
  printf 'header = "Authorization: Bearer %s"\n' "$token" | curl --config - "$@"
}

observe_active_worker_deployment() {
  local raw_receipt="$1" expected_version_id="$2" expected_deployment_id="$3" safe_receipt="$4"
  local status

  curl_with_bearer "$CLOUDFLARE_API_TOKEN" \
    --fail --silent --show-error \
    --user-agent "$USER_AGENT" \
    --connect-timeout 5 --max-time 20 \
    --output "$raw_receipt" \
    "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/asimposium-stoa-staging/deployments"
  status=$?
  [[ "$status" -eq 0 ]] || return "$status"

  python3 - "$raw_receipt" "$expected_version_id" "$expected_deployment_id" "$REVISION" <<'PY' > "$safe_receipt"
import datetime
import json
import re
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    document = json.load(stream)
if not isinstance(document, dict) or document.get("success") is not True:
    sys.exit(1)
payload = document.get("result")
if isinstance(payload, dict):
    deployments = payload.get("deployments")
else:
    deployments = payload
if not isinstance(deployments, list) or not deployments:
    sys.exit(1)
if any(not isinstance(value, dict) for value in deployments):
    sys.exit(1)

def timestamp(value: object) -> datetime.datetime:
    if not isinstance(value, str):
        raise ValueError
    parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError
    return parsed.astimezone(datetime.timezone.utc)

try:
    active = max(deployments, key=lambda value: timestamp(value.get("created_on")))
except (OverflowError, TypeError, ValueError):
    sys.exit(1)
deployment_id = active.get("id")
if not isinstance(deployment_id, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", deployment_id):
    sys.exit(1)
if sys.argv[3] and deployment_id != sys.argv[3]:
    sys.exit(1)
versions = active.get("versions")
if not isinstance(versions, list) or len(versions) != 1 or not isinstance(versions[0], dict):
    sys.exit(1)
version = versions[0]
if version.get("version_id") != sys.argv[2] or version.get("percentage") != 100:
    sys.exit(1)
annotations = active.get("annotations")
if not isinstance(annotations, dict) or annotations.get("workers/message") != "asimposium revision " + sys.argv[4]:
    sys.exit(1)
observed_at = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
print(json.dumps({
    "deployment_id": deployment_id,
    "version_id": sys.argv[2],
    "observed_at": observed_at,
    "status": "ready",
}, separators=(",", ":")))
PY
}

worker_deploy() {
  local config="$repository_root/infra/deploy-resolved/staging.wrangler.toml"
  local raw_receipt="$ARTIFACT_DIRECTORY/wrangler-output.jsonl"
  local version_receipt="$ARTIFACT_DIRECTORY/worker-version.json"
  local deployments_receipt="$ARTIFACT_DIRECTORY/cloudflare-deployments-after-publish.json"
  local safe_receipt="$ARTIFACT_DIRECTORY/worker-deployment.json"
  local status version_id

  require_bearer_token CLOUDFLARE_API_TOKEN || return $?
  require_live_variable CLOUDFLARE_ACCOUNT_ID || return $?
  require_live_variable ASIMP_D1_DATABASE_ID_STAGING || return $?
  require_live_variable ASIMP_STAGING_SERVICE_ENVELOPE_KEYS || return $?

  ASIMP_ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID" \
    bun "$repository_root/infra/resolve-wrangler-deploy.mjs" --env staging --write
  status=$?
  [[ "$status" -eq 0 ]] || return "$status"

  (
    cd "$repository_root/apps/wire" || exit 1
    FORCE_COLOR=0 \
      WRANGLER_LOG_SANITIZE=true \
      WRANGLER_OUTPUT_FILE_PATH="$raw_receipt" \
      bunx --bun wrangler deploy \
        --config "$config" \
        --tag "rev-${REVISION:0:16}" \
        --message "asimposium revision $REVISION"
  )
  status=$?
  [[ "$status" -eq 0 ]] || return "$status"

  python3 - "$raw_receipt" <<'PY' > "$version_receipt"
import json
import re
import sys

selected = None
with open(sys.argv[1], encoding="utf-8") as stream:
    for line in stream:
        value = json.loads(line)
        if value.get("type") == "deploy" and value.get("worker_name") == "asimposium-stoa-staging":
            selected = value
if selected is None:
    sys.exit(1)
version_id = selected.get("version_id")
observed_at = selected.get("timestamp")
if not isinstance(version_id, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", version_id):
    sys.exit(1)
if not isinstance(observed_at, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z", observed_at):
    sys.exit(1)
print(json.dumps({"version_id": version_id, "observed_at": observed_at}, separators=(",", ":")))
PY
  status=$?
  [[ "$status" -eq 0 ]] || return "$status"
  version_id="$(safe_receipt_field "$version_receipt" version_id)" || return 1
  observe_active_worker_deployment "$deployments_receipt" "$version_id" "" "$safe_receipt"
}

worker_readiness() {
  local capabilities="$ARTIFACT_DIRECTORY/capabilities.json"
  local schema_paths="$ARTIFACT_DIRECTORY/schema-paths.txt"
  local deployments_receipt="$ARTIFACT_DIRECTORY/cloudflare-deployments-after-readiness.json"
  local attestation_receipt="$ARTIFACT_DIRECTORY/worker-readiness-deployment.json"
  local deployment_id schema_path version_id index=0 status

  bash "$repository_root/scripts/e2e-environments.sh" staging
  status=$?
  [[ "$status" -eq 0 ]] || return "$status"

  curl --fail --silent --show-error --location \
    --user-agent "$USER_AGENT" \
    --connect-timeout 5 --max-time 20 \
    --output "$capabilities" \
    "$STAGING_WORKER_ORIGIN/capabilities"
  status=$?
  [[ "$status" -eq 0 ]] || return "$status"

  python3 - "$capabilities" <<'PY' > "$schema_paths"
import json
import re
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    document = json.load(stream)
if document.get("origin") != "https://a-staging.asimposium.org":
    sys.exit(1)
reads = document.get("reads")
if not isinstance(reads, list) or any(not isinstance(value, str) for value in reads):
    sys.exit(1)
paths = [value for value in reads if value.startswith("/schemas/")]
if not paths or len(paths) != len(set(paths)):
    sys.exit(1)
if any(not re.fullmatch(r"/schemas/[a-z0-9.-]+\.v1\.json", value) for value in paths):
    sys.exit(1)
print("\n".join(paths))
PY
  status=$?
  [[ "$status" -eq 0 ]] || return "$status"

  while IFS= read -r schema_path; do
    [[ -n "$schema_path" ]] || continue
    index=$((index + 1))
    curl --fail --silent --show-error --location \
      --user-agent "$USER_AGENT" \
      --connect-timeout 5 --max-time 20 \
      --output "$ARTIFACT_DIRECTORY/schema-$index.json" \
      "$STAGING_WORKER_ORIGIN$schema_path"
    status=$?
    [[ "$status" -eq 0 ]] || return "$status"
    python3 - "$ARTIFACT_DIRECTORY/schema-$index.json" "$schema_path" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    document = json.load(stream)
expected = "https://a.asimposium.org" + sys.argv[2]
if document.get("$id") != expected:
    sys.exit(1)
PY
    status=$?
    [[ "$status" -eq 0 ]] || return "$status"
  done < "$schema_paths"
  ((index > 0)) || return 1

  deployment_id="$(safe_receipt_field "$ARTIFACT_DIRECTORY/worker-deployment.json" deployment_id)" || return 1
  version_id="$(safe_receipt_field "$ARTIFACT_DIRECTORY/worker-deployment.json" version_id)" || return 1
  observe_active_worker_deployment \
    "$deployments_receipt" "$version_id" "$deployment_id" "$attestation_receipt"
}

web_deploy() {
  local project_receipt="$ARTIFACT_DIRECTORY/vercel-project.json"
  local deployment_url_file="$ARTIFACT_DIRECTORY/vercel-deployment-url.txt"
  local raw_receipt="$ARTIFACT_DIRECTORY/vercel-inspect.json"
  local api_receipt="$ARTIFACT_DIRECTORY/vercel-deployment-api.json"
  local worker_deployments_receipt="$ARTIFACT_DIRECTORY/cloudflare-deployments-after-web-ready.json"
  local worker_attestation_receipt="$ARTIFACT_DIRECTORY/worker-web-ready-deployment.json"
  local safe_receipt="$ARTIFACT_DIRECTORY/web-deployment.json"
  local deployment_host deployment_id deployment_origin status version_id

  require_bearer_token VERCEL_TOKEN || return $?
  require_live_variable VERCEL_ORG_ID || return $?
  require_live_variable VERCEL_PROJECT_ID || return $?
  [[ "$VERCEL_ORG_ID" =~ ^(team|user)_[A-Za-z0-9]+$ ]] || return 78
  [[ "$VERCEL_PROJECT_ID" =~ ^prj_[A-Za-z0-9]+$ ]] || return 78

  curl_with_bearer "$VERCEL_TOKEN" \
    --fail --silent --show-error \
    --user-agent "$USER_AGENT" \
    --connect-timeout 5 --max-time 20 \
    --output "$project_receipt" \
    "https://api.vercel.com/v9/projects/$VERCEL_PROJECT_ID?teamId=$VERCEL_ORG_ID"
  status=$?
  [[ "$status" -eq 0 ]] || return "$status"
  python3 - "$project_receipt" "$VERCEL_PROJECT_ID" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    document = json.load(stream)
if not isinstance(document, dict) or document.get("id") != sys.argv[2]:
    sys.exit(1)
# A connected Git provider can deploy the web revision concurrently with this
# ordered pipeline. Absence is the only provider state this gate treats as safe.
if document.get("link") is not None:
    sys.exit(78)
PY
  status=$?
  [[ "$status" -eq 0 ]] || return "$status"

  bunx --bun "vercel@$VERCEL_CLI_VERSION" deploy "$repository_root" \
    --yes \
    --target preview \
    --meta "asimposiumRevision=$REVISION" \
    --build-env "STOA_ORIGIN=$STAGING_WORKER_ORIGIN" \
    --env "STOA_ORIGIN=$STAGING_WORKER_ORIGIN" \
    > "$deployment_url_file"
  status=$?
  [[ "$status" -eq 0 ]] || return "$status"

  deployment_origin="$(python3 - "$deployment_url_file" <<'PY'
import sys
from urllib.parse import urlsplit

with open(sys.argv[1], encoding="utf-8") as stream:
    value = stream.read().strip()
parts = urlsplit(value if "://" in value else "https://" + value)
if parts.scheme != "https" or not parts.hostname or parts.port is not None or parts.path not in ("", "/") or parts.query or parts.fragment:
    sys.exit(1)
if not parts.hostname.endswith(".vercel.app"):
    sys.exit(1)
print("https://" + parts.hostname)
PY
)" || return 1

  bunx --bun "vercel@$VERCEL_CLI_VERSION" inspect "$deployment_origin" --wait --timeout 25m --json > "$raw_receipt"
  status=$?
  [[ "$status" -eq 0 ]] || return "$status"

  deployment_host="${deployment_origin#https://}"
  curl_with_bearer "$VERCEL_TOKEN" \
    --fail --silent --show-error \
    --user-agent "$USER_AGENT" \
    --connect-timeout 5 --max-time 20 \
    --output "$api_receipt" \
    "https://api.vercel.com/v13/deployments/$deployment_host?teamId=$VERCEL_ORG_ID"
  status=$?
  [[ "$status" -eq 0 ]] || return "$status"

  deployment_id="$(safe_receipt_field "$ARTIFACT_DIRECTORY/worker-deployment.json" deployment_id)" || return 1
  version_id="$(safe_receipt_field "$ARTIFACT_DIRECTORY/worker-deployment.json" version_id)" || return 1
  observe_active_worker_deployment \
    "$worker_deployments_receipt" "$version_id" "$deployment_id" "$worker_attestation_receipt"
  status=$?
  [[ "$status" -eq 0 ]] || return "$status"

  python3 - "$raw_receipt" "$api_receipt" "$REVISION" "$VERCEL_PROJECT_ID" <<'PY' > "$safe_receipt"
import datetime
import json
import re
import sys
from urllib.parse import urlsplit

with open(sys.argv[1], encoding="utf-8") as stream:
    document = json.load(stream)
with open(sys.argv[2], encoding="utf-8") as stream:
    api_document = json.load(stream)
if not isinstance(document, dict):
    sys.exit(1)
if not isinstance(api_document, dict):
    sys.exit(1)
deployment_id = document.get("id") or document.get("uid") or document.get("deploymentId")
url = document.get("url")
state = document.get("readyState") or document.get("state") or document.get("status")
target = document.get("target")
if not isinstance(deployment_id, str) or not re.fullmatch(r"dpl_[A-Za-z0-9]{8,128}", deployment_id):
    sys.exit(1)
if not isinstance(url, str):
    sys.exit(1)
parts = urlsplit(url if "://" in url else "https://" + url)
if parts.scheme != "https" or not parts.hostname or parts.port is not None or parts.path not in ("", "/") or parts.query or parts.fragment:
    sys.exit(1)
if not parts.hostname.endswith(".vercel.app"):
    sys.exit(1)
if not isinstance(state, str) or state.upper() != "READY":
    sys.exit(1)
if target != "preview":
    sys.exit(1)
if api_document.get("id") != deployment_id:
    sys.exit(1)
api_url = api_document.get("url")
if api_url != parts.hostname:
    sys.exit(1)
api_state = api_document.get("readyState") or api_document.get("state") or api_document.get("status")
if not isinstance(api_state, str) or api_state.upper() != "READY":
    sys.exit(1)
if api_document.get("target") not in (None, "preview"):
    sys.exit(1)
project_id = api_document.get("projectId")
if project_id is None and isinstance(api_document.get("project"), dict):
    project_id = api_document["project"].get("id")
if project_id != sys.argv[4]:
    sys.exit(1)
metadata = api_document.get("meta")
if not isinstance(metadata, dict) or metadata.get("asimposiumRevision") != sys.argv[3]:
    sys.exit(1)
observed_at = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
print(json.dumps({"deployment_id": deployment_id, "observed_at": observed_at, "status": "ready", "origin": "https://" + parts.hostname}, separators=(",", ":")))
PY
}

safe_receipt_field() {
  local receipt="$1" field="$2"
  python3 - "$receipt" "$field" <<'PY'
import json
import re
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    document = json.load(stream)
value = document.get(sys.argv[2])
if not isinstance(value, str):
    sys.exit(1)
patterns = {
    "deployment_id": r"[A-Za-z0-9._-]{1,128}",
    "version_id": r"[A-Za-z0-9._-]{1,128}",
    "observed_at": r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z",
    "status": r"ready",
    "origin": r"https://[a-z0-9-]+(?:\.[a-z0-9-]+)+",
}
pattern = patterns.get(sys.argv[2])
if pattern is None or not re.fullmatch(pattern, value):
    sys.exit(1)
print(value)
PY
}

require_stage_prefix() {
  local expected_csv="$1"
  local evidence="$ARTIFACT_DIRECTORY/ci-pipeline.jsonl"
  [[ -f "$evidence" && ! -L "$evidence" ]] || return 64
  python3 - "$evidence" "$RUN_ID" "$REVISION" "$expected_csv" "$RUNNER" "$RUNNER_BUILD_ID" <<'PY'
import json
import sys

records = []
with open(sys.argv[1], encoding="utf-8") as stream:
    for line in stream:
        value = json.loads(line)
        if value.get("run_id") != sys.argv[2] or value.get("revision") != sys.argv[3]:
            sys.exit(64)
        records.append(value)
runner_records = [value for value in records if value.get("record") == "runner"]
if any(value.get("suite") != "ci-pipeline" for value in records):
    sys.exit(64)
if (
    len(runner_records) != 1
    or runner_records[0].get("status") != "observed"
    or runner_records[0].get("runner") != sys.argv[5]
    or runner_records[0].get("runner_build_id") != (sys.argv[6] or None)
):
    sys.exit(64)
observed = [
    value.get("stage")
    for value in records
    if isinstance(value.get("stage"), str)
]
expected = [] if not sys.argv[4] else sys.argv[4].split(",")
if observed != expected:
    sys.exit(64)
if any(
    value.get("status") != "pass" or value.get("exit_code") != 0
    for value in records
    if isinstance(value.get("stage"), str)
):
    sys.exit(64)
PY
}

stage_command() {
  local stage="$1" web_origin
  if [[ "$PIPELINE_TEST_MODE" == "1" ]]; then
    printf '%s\0' bash "$repository_root/scripts/e2e-ci-pipeline.sh" __plant "$stage"
    return 0
  fi
  case "$stage" in
    root-gate)
      printf '%s\0' bash "$repository_root/scripts/gates.sh" --all
      ;;
    worker-deploy)
      printf '%s\0' env ASIMP_CI_INTERNAL=1 ASIMP_CI_INTERNAL_RUN_ID="$RUN_ID" \
        bash "$repository_root/scripts/e2e-ci-pipeline.sh" __worker_deploy
      ;;
    worker-readiness)
      printf '%s\0' env ASIMP_CI_INTERNAL=1 ASIMP_CI_INTERNAL_RUN_ID="$RUN_ID" \
        bash "$repository_root/scripts/e2e-ci-pipeline.sh" __worker_readiness
      ;;
    web-deploy)
      printf '%s\0' env ASIMP_CI_INTERNAL=1 ASIMP_CI_INTERNAL_RUN_ID="$RUN_ID" \
        bash "$repository_root/scripts/e2e-ci-pipeline.sh" __web_deploy
      ;;
    smoke-agent)
      printf '%s\0' env \
        ASIMPOSIUM_STAGING_AGENT_BASE_URL="$STAGING_WORKER_ORIGIN" \
        bash "$repository_root/scripts/smoke-agent.sh" --write-artifacts --run-id "smoke-agent-${REVISION:0:12}-$$"
      ;;
    smoke-gallery)
      web_origin="$(safe_receipt_field "$ARTIFACT_DIRECTORY/web-deployment.json" origin)" || return 1
      printf '%s\0' env \
        ASIMPOSIUM_STAGING_AGORA_BASE_URL="$web_origin" \
        bash "$repository_root/scripts/smoke-gallery.sh" --write-artifacts --run-id "smoke-gallery-${REVISION:0:12}-$$"
      ;;
    *) return 64 ;;
  esac
}

run_stage() {
  local stage="$1" timeout_seconds status finished_at deployment_id observed_at deployment_status
  local -a command=()
  timeout_seconds="$(timeout_for_stage "$stage")" || return 64
  while IFS= read -r -d '' value; do
    command+=("$value")
  done < <(stage_command "$stage")
  ((${#command[@]} > 0)) || return 64

  CURRENT_STAGE="$stage"
  CURRENT_STAGE_STARTED="$(now_iso)"
  CURRENT_STAGE_RECORDED=0
  run_bounded "$timeout_seconds" "${command[@]}"
  status=$?
  finished_at="$(now_iso)"

  if [[ "$status" -eq 0 ]]; then
    assert_revision_unchanged || status=$?
  fi

  if [[ "$status" -eq 0 && "$PIPELINE_TEST_MODE" != "1" ]]; then
    case "$stage" in
      worker-deploy)
        deployment_id="$(safe_receipt_field "$ARTIFACT_DIRECTORY/worker-deployment.json" deployment_id)" || status=1
        if [[ "$status" -eq 0 ]]; then
          observed_at="$(safe_receipt_field "$ARTIFACT_DIRECTORY/worker-deployment.json" observed_at)" || status=1
        fi
        if [[ "$status" -eq 0 ]]; then
          deployment_status="$(safe_receipt_field "$ARTIFACT_DIRECTORY/worker-deployment.json" status)" || status=1
        fi
        if [[ "$status" -eq 0 ]]; then
          record_deployment cloudflare "$deployment_id" "$observed_at" "$deployment_status" || status=1
        fi
        ;;
      web-deploy)
        deployment_id="$(safe_receipt_field "$ARTIFACT_DIRECTORY/web-deployment.json" deployment_id)" || status=1
        if [[ "$status" -eq 0 ]]; then
          observed_at="$(safe_receipt_field "$ARTIFACT_DIRECTORY/web-deployment.json" observed_at)" || status=1
        fi
        if [[ "$status" -eq 0 ]]; then
          deployment_status="$(safe_receipt_field "$ARTIFACT_DIRECTORY/web-deployment.json" status)" || status=1
        fi
        if [[ "$status" -eq 0 ]]; then
          record_deployment vercel "$deployment_id" "$observed_at" "$deployment_status" || status=1
        fi
        ;;
    esac
  fi

  case "$status" in
    0) record_stage "$stage" "pass" 0 "$CURRENT_STAGE_STARTED" "$finished_at" || return 1 ;;
    75 | 78) record_stage "$stage" "blocked" "$status" "$CURRENT_STAGE_STARTED" "$finished_at" || true ;;
    124) record_stage "$stage" "timeout" 124 "$CURRENT_STAGE_STARTED" "$finished_at" || true ;;
    129 | 130 | 143) record_stage "$stage" "cancelled" "$status" "$CURRENT_STAGE_STARTED" "$finished_at" || true ;;
    *) record_stage "$stage" "fail" "$status" "$CURRENT_STAGE_STARTED" "$finished_at" || true ;;
  esac
  CURRENT_STAGE_RECORDED=1

  CURRENT_STAGE=""
  CURRENT_STAGE_STARTED=""
  return "$status"
}

internal_entrypoint() {
  local action="$1" stage="${2:-}"
  case "$action" in
    __plant)
      plant_stage "$stage"
      ;;
    __worker_deploy | __worker_readiness | __web_deploy)
      [[ "${ASIMP_CI_INTERNAL:-0}" == "1" ]] || return 64
      RUN_ID="${ASIMP_CI_INTERNAL_RUN_ID:-}"
      e2e_validate_run_id "$RUN_ID" || return 64
      ARTIFACT_DIRECTORY="$(e2e_artifact_directory_at_root "$repository_root" "$RUN_ID")" || return 64
      [[ -d "$ARTIFACT_DIRECTORY" && ! -L "$ARTIFACT_DIRECTORY" ]] || return 64
      REVISION="$(git -C "$repository_root" rev-parse HEAD 2>/dev/null)" || return 65
      [[ "$REVISION" =~ ^[0-9a-f]{40}$ ]] || return 65
      RUNNER="${ASIMP_CI_RUNNER:-manual}"
      validate_runner_context || return $?
      assert_revision_unchanged || return $?
      case "$action" in
        __worker_deploy)
          require_stage_prefix "root-gate" || return $?
          worker_deploy
          ;;
        __worker_readiness)
          require_stage_prefix "root-gate,worker-deploy" || return $?
          worker_readiness
          ;;
        __web_deploy)
          require_stage_prefix "root-gate,worker-deploy,worker-readiness" || return $?
          web_deploy
          ;;
      esac
      ;;
    *) return 64 ;;
  esac
}

if [[ "${1:-}" == __* ]]; then
  internal_entrypoint "$@"
  exit $?
fi

explicit_run_id=""
while (($# > 0)); do
  case "$1" in
    --run-id)
      (($# >= 2)) || { usage; exit 64; }
      explicit_run_id="$2"
      shift 2
      ;;
    *) usage; exit 64 ;;
  esac
done

REVISION="$(git -C "$repository_root" rev-parse HEAD 2>/dev/null)" || exit 65
[[ "$REVISION" =~ ^[0-9a-f]{40}$ ]] || exit 65
RUNNER="${ASIMP_CI_RUNNER:-manual}"
case "$RUNNER" in
  cloudflare-workers-builds | manual) ;;
  *) printf 'ci-pipeline: unsupported runner label\n' >&2; exit 64 ;;
esac
if [[ "$PIPELINE_TEST_MODE" == "1" ]]; then
  RUNNER="process-test"
  [[ -n "${ASIMP_CI_PROCESS_TRACE:-}" ]] || exit 64
else
  validate_runner_context
  runner_status=$?
  if [[ "$runner_status" -ne 0 ]]; then
    printf 'ci-pipeline: runner identity or revision binding is invalid\n' >&2
    exit "$runner_status"
  fi
fi

RUN_ID="${explicit_run_id:-ci-${REVISION:0:12}-$(date -u +%Y%m%dT%H%M%S)-$$}"
e2e_validate_run_id "$RUN_ID" || { usage; exit 64; }
((${#RUN_ID} <= 72)) || { usage; exit 64; }
validate_delegated_statuses || {
  printf 'ci-pipeline: delegated suite status is invalid\n' >&2
  exit 64
}
assert_revision_unchanged || {
  printf 'ci-pipeline: checkout is dirty or revision drifted\n' >&2
  exit 65
}
if [[ "$PIPELINE_TEST_MODE" == "1" ]]; then
  ARTIFACT_DIRECTORY="${ASIMP_CI_PROCESS_ARTIFACT_DIRECTORY:-}"
  [[ -n "$ARTIFACT_DIRECTORY" && "$ARTIFACT_DIRECTORY" == /* ]] || exit 64
  [[ -d "$ARTIFACT_DIRECTORY" && ! -L "$ARTIFACT_DIRECTORY" ]] || exit 64
else
  e2e_claim_artifact_run_at_root "$repository_root" "$RUN_ID" || {
    printf 'ci-pipeline: artifact run id is already claimed or unsafe\n' >&2
    exit 64
  }
  ARTIFACT_DIRECTORY="$(e2e_artifact_directory_at_root "$repository_root" "$RUN_ID")" || exit 64
fi
mkdir "$ARTIFACT_DIRECTORY/curl-home" || exit 64
printf 'user-agent = "%s"\n' "$USER_AGENT" > "$ARTIFACT_DIRECTORY/curl-home/.curlrc" || exit 64
export CURL_HOME="$ARTIFACT_DIRECTORY/curl-home"
record_runner_context || exit 1

for stage in "${STAGES[@]}"; do
  run_stage "$stage"
  stage_status=$?
  if [[ "$stage_status" -ne 0 ]]; then
    record_remaining_not_run "$stage" || true
    record_delegated_statuses 1 || true
    exit "$stage_status"
  fi
done

record_delegated_statuses 0 || exit 1
completion_code="PIPELINE_COMPLETE"
if [[ "$PIPELINE_TEST_MODE" == "1" ]]; then
  completion_code="PROCESS_TEST_COMPLETE"
fi
completion_time="$(now_iso)"
completion="{\"tool\":\"bash\",\"package\":\"e2e\",\"suite\":\"$SUITE\",\"run_id\":\"$RUN_ID\",\"revision\":\"$REVISION\",\"runner\":\"$RUNNER\",\"record\":\"summary\",\"status\":\"pass\",\"code\":\"$completion_code\",\"observed_at\":\"$completion_time\"}"
append_evidence "$completion" || exit 1
printf '%s\n' "$completion"
