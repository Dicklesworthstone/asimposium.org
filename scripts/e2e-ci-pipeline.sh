#!/usr/bin/env bash
set -u -o pipefail

# OPS.2b review pipeline. Cloudflare Workers Builds is the selected hosted-runner
# design; this entry point remains provider-neutral at the command boundary and
# delegates product assertions to their existing suites.

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source=e2e/lib/run-diagnostics.sh
source "$repository_root/e2e/lib/run-diagnostics.sh"

# The ordinary common closer is correct only after every owned stage process
# group has been proved absent. Keep the lease durably open when the bounded
# wrapper cannot establish that terminal fact; maintenance must prefer a false
# refusal to moving the root beneath a surviving descendant.
PIPELINE_ARTIFACT_PROCESS_GROUP_SETTLED=1
PIPELINE_ARTIFACT_DESCENDANT_SETTLEMENT_PROVEN=1
ci_pipeline_artifact_writer_leases_on_exit() {
  local original_status=$?

  if ((BASH_SUBSHELL > 0)); then
    return "$original_status"
  fi
  trap - EXIT
  if [[ "$PIPELINE_ARTIFACT_PROCESS_GROUP_SETTLED" != "1" \
    || "$PIPELINE_ARTIFACT_DESCENDANT_SETTLEMENT_PROVEN" != "1" ]]; then
    exit "$original_status"
  fi
  if ! e2e_close_artifact_writer_leases; then
    [[ "$original_status" -ne 0 ]] || original_status=76
  fi
  exit "$original_status"
}
trap 'ci_pipeline_artifact_writer_leases_on_exit' EXIT

readonly SUITE="ci-pipeline"
readonly USER_AGENT="OpenAI File Downloader, XaiImageApiFetch/1.0"
readonly STAGING_WORKER_ORIGIN="https://a-staging.asimposium.org"
readonly STAGING_AGORA_ORIGIN="https://staging.asimposium.org"
readonly VERCEL_CLI_VERSION="59.5.0"
readonly PIPELINE_TEST_MODE="${ASIMP_CI_PROCESS_TEST:-0}"
readonly -a STAGES=(
  "root-gate"
  "smoke-agent"
  "smoke-gallery"
  "worker-deploy"
  "worker-readiness"
  "web-deploy"
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
NEXT_STAGE_INDEX=0
SIGNAL_RECORD_CRITICAL=0
DEFERRED_SIGNAL_NAME=""
DEFERRED_SIGNAL_EXIT_CODE=""

case "$PIPELINE_TEST_MODE" in
  0 | 1) ;;
  *) printf 'ci-pipeline: ASIMP_CI_PROCESS_TEST must be 0 or 1\n' >&2; exit 64 ;;
esac

usage() {
  printf 'usage: scripts/e2e-ci-pipeline.sh [--run-id <safe-id>]\n' >&2
}

# Resolve one top-level run only while its inherited artifact capability still
# names the exact physical root epoch, run inode, and open matching-epoch lease.
# This is deliberately read-only and prints only the already-contained run
# directory. Recursive deployment children inherit the values from their live
# parent; they never acquire or close the parent's lease.
ci_artifact_capability_directory_at_root() {
  local capability_root="$1"
  local capability_run_id="$2"
  local expected_root_identity="$3"
  local expected_run_identity="$4"
  local lease_directory="$5"
  local lease_identity="$6"
  local physical_artifacts_root
  local run_directory
  local physical_run_directory
  local epoch_directory

  e2e_validate_run_id "$capability_run_id" || return 1
  e2e_artifact_maintenance_absent_at_root "$capability_root" || return 1
  physical_artifacts_root="$(e2e_artifacts_root_at_root "$capability_root")" || return 1
  [[ "$(e2e_artifact_directory_identity "$physical_artifacts_root")" == \
    "$expected_root_identity" ]] || return 1
  run_directory="$physical_artifacts_root/$capability_run_id"
  physical_run_directory="$(e2e_physical_directory "$run_directory")" || return 1
  [[ "$physical_run_directory" == "$run_directory" \
    && "$(e2e_artifact_directory_identity "$physical_run_directory")" == \
      "$expected_run_identity" ]] || return 1
  epoch_directory="$(e2e_artifact_writer_lease_epoch_at_root \
    "$capability_root" "$expected_root_identity")" || return 1
  [[ "${lease_directory%/*}" == "$epoch_directory" ]] || return 1
  e2e_artifact_writer_lease_is_open "$lease_directory" "$lease_identity" || return 1
  e2e_artifact_maintenance_absent_at_root "$capability_root" || return 1
  printf '%s\n' "$physical_run_directory"
}

ci_artifact_capability_is_current() {
  local verified_directory
  verified_directory="$(ci_artifact_capability_directory_at_root \
    "$repository_root" "$RUN_ID" \
    "${ASIMP_CI_INTERNAL_ARTIFACT_ROOT_IDENTITY:-}" \
    "${ASIMP_CI_INTERNAL_RUN_IDENTITY:-}" \
    "${ASIMP_CI_INTERNAL_LEASE_DIRECTORY:-}" \
    "${ASIMP_CI_INTERNAL_LEASE_IDENTITY:-}")" || return 64
  [[ -z "$ARTIFACT_DIRECTORY" || "$ARTIFACT_DIRECTORY" == "$verified_directory" ]] || return 64
  ARTIFACT_DIRECTORY="$verified_directory"
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
  local record subject_revision_json="\"$REVISION\""
  # The two preview smokes run before publication and therefore observe the
  # revision already serving on the canonical staging origins, not this
  # checkout. Process plants execute no product revision at all. Keep those
  # distinctions machine-readable instead of letting the run revision imply a
  # causal claim the stage did not establish.
  if [[ "$PIPELINE_TEST_MODE" == "1" || "$status" != "pass" || "$stage" == smoke-agent || "$stage" == smoke-gallery ]]; then
    subject_revision_json="null"
  fi
  record="{\"tool\":\"bash\",\"package\":\"e2e\",\"suite\":\"$SUITE\",\"run_id\":\"$RUN_ID\",\"revision\":\"$REVISION\",\"subject_revision\":$subject_revision_json,\"runner\":\"$RUNNER\",\"stage\":\"$stage\",\"status\":\"$status\",\"exit_code\":$exit_code,\"started_at\":\"$started_at\",\"finished_at\":\"$finished_at\"}"
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
    cold-agent-gauntlet:revision) printf '%s\n' "${ASIMP_CI_GAUNTLET_REVISION:-}" ;;
    human-playwright:status) printf '%s\n' "${ASIMP_CI_PLAYWRIGHT_STATUS:-not-run}" ;;
    human-playwright:observed) printf '%s\n' "${ASIMP_CI_PLAYWRIGHT_OBSERVED_AT:-}" ;;
    human-playwright:revision) printf '%s\n' "${ASIMP_CI_PLAYWRIGHT_REVISION:-}" ;;
    load:status) printf '%s\n' "${ASIMP_CI_LOAD_STATUS:-not-run}" ;;
    load:observed) printf '%s\n' "${ASIMP_CI_LOAD_OBSERVED_AT:-}" ;;
    load:revision) printf '%s\n' "${ASIMP_CI_LOAD_REVISION:-}" ;;
    restore:status) printf '%s\n' "${ASIMP_CI_RESTORE_STATUS:-not-run}" ;;
    restore:observed) printf '%s\n' "${ASIMP_CI_RESTORE_OBSERVED_AT:-}" ;;
    restore:revision) printf '%s\n' "${ASIMP_CI_RESTORE_REVISION:-}" ;;
    launch:status) printf '%s\n' "${ASIMP_CI_LAUNCH_STATUS:-not-run}" ;;
    launch:observed) printf '%s\n' "${ASIMP_CI_LAUNCH_OBSERVED_AT:-}" ;;
    launch:revision) printf '%s\n' "${ASIMP_CI_LAUNCH_REVISION:-}" ;;
    release:status) printf '%s\n' "${ASIMP_CI_RELEASE_STATUS:-not-run}" ;;
    release:observed) printf '%s\n' "${ASIMP_CI_RELEASE_OBSERVED_AT:-}" ;;
    release:revision) printf '%s\n' "${ASIMP_CI_RELEASE_REVISION:-}" ;;
    *) return 64 ;;
  esac
}

validate_utc_timestamp() {
  python3 - "$1" <<'PY'
import datetime
import sys

try:
    parsed = datetime.datetime.strptime(sys.argv[1], "%Y-%m-%dT%H:%M:%SZ").replace(
        tzinfo=datetime.timezone.utc
    )
except ValueError:
    sys.exit(1)
if parsed > datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=5):
    sys.exit(1)
PY
}

validate_delegated_statuses() {
  local name status observed revision
  for name in cold-agent-gauntlet human-playwright load restore launch release; do
    status="$(delegated_value "$name" status)" || return 64
    observed="$(delegated_value "$name" observed)" || return 64
    revision="$(delegated_value "$name" revision)" || return 64
    case "$status" in
      not-run)
        [[ -z "$observed" && -z "$revision" ]] || return 64
        ;;
      pass | blocked)
        validate_utc_timestamp "$observed" || return 64
        [[ "$revision" == "$REVISION" ]] || return 64
        ;;
      stale)
        validate_utc_timestamp "$observed" || return 64
        [[ "$revision" =~ ^[0-9a-f]{40}$ ]] || return 64
        ;;
      *) return 64 ;;
    esac
  done
}

record_delegated_statuses() {
  local force_not_run="${1:-0}" name status observed revision observed_json revision_json record
  for name in cold-agent-gauntlet human-playwright load restore launch release; do
    if [[ "$force_not_run" == "1" ]]; then
      status="not-run"
      observed=""
      revision=""
    else
      status="$(delegated_value "$name" status)" || return 64
      observed="$(delegated_value "$name" observed)" || return 64
      revision="$(delegated_value "$name" revision)" || return 64
    fi
    observed_json="null"
    revision_json="null"
    if [[ -n "$observed" ]]; then
      observed_json="\"$observed\""
    fi
    if [[ -n "$revision" ]]; then
      revision_json="\"$revision\""
    fi
    record="{\"tool\":\"bash\",\"package\":\"e2e\",\"suite\":\"$SUITE\",\"run_id\":\"$RUN_ID\",\"revision\":\"$REVISION\",\"runner\":\"$RUNNER\",\"record\":\"delegated-suite\",\"delegated_suite\":\"$name\",\"status\":\"$status\",\"delegated_revision\":$revision_json,\"observed_at\":$observed_json}"
    append_evidence "$record" || return 1
    printf '%s\n' "$record"
  done
}

record_not_run_from_index() {
  local first_index="$1" index timestamp
  [[ "$first_index" =~ ^[0-9]+$ ]] || return 1
  ((first_index >= 0 && first_index <= ${#STAGES[@]})) || return 1
  timestamp="$(now_iso)"
  for ((index = first_index; index < ${#STAGES[@]}; index += 1)); do
    record_stage "${STAGES[$index]}" "not-run" "null" "$timestamp" "$timestamp" || return 1
  done
}

record_remaining_not_run() {
  local completed_stage="$1" completed_index
  completed_index="$(stage_index "$completed_stage")" || return 1
  record_not_run_from_index "$((completed_index + 1))"
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
  if [[ "$SIGNAL_RECORD_CRITICAL" == "1" ]]; then
    # The stage command has already reached a terminal outcome while its one
    # durable record is being committed. Defer delivery across that tiny
    # boundary so a signal cannot append a contradictory cancellation record.
    if [[ -z "$DEFERRED_SIGNAL_NAME" ]]; then
      DEFERRED_SIGNAL_NAME="$signal_name"
      DEFERRED_SIGNAL_EXIT_CODE="$exit_code"
    fi
    return 0
  fi
  trap - INT TERM HUP
  if [[ -n "$CURRENT_WRAPPER_PID" ]]; then
    kill -s "$signal_name" "$CURRENT_WRAPPER_PID" 2>/dev/null || true
    wait "$CURRENT_WRAPPER_PID" 2>/dev/null || true
  fi
  if [[ -n "$CURRENT_STAGE" ]]; then
    if [[ "$CURRENT_STAGE_RECORDED" == "0" ]]; then
      finished_at="$(now_iso)"
      record_stage "$CURRENT_STAGE" "cancelled" "$exit_code" "$CURRENT_STAGE_STARTED" "$finished_at" || true
      CURRENT_STAGE_RECORDED=1
    fi
    # A signal can arrive after the current stage record is durable but before
    # run_stage clears its bookkeeping. The prior shape skipped these records
    # in that window and left downstream state ambiguous.
    record_remaining_not_run "$CURRENT_STAGE" || true
    record_delegated_statuses 1 || true
  elif ((NEXT_STAGE_INDEX < ${#STAGES[@]})) && [[ -n "$RUN_ID" && -n "$ARTIFACT_DIRECTORY" ]]; then
    # A signal can also land after one stage clears its bookkeeping but before
    # the next stage begins. Preserve the same explicit terminal state in that
    # inter-stage window instead of leaving every remaining stage absent.
    record_not_run_from_index "$NEXT_STAGE_INDEX" || true
    record_delegated_statuses 1 || true
  fi
  exit "$exit_code"
}

trap 'on_signal INT 130' INT
trap 'on_signal TERM 143' TERM
trap 'on_signal HUP 129' HUP

record_current_stage_result() {
  local stage_status="$1" exit_code="$2" finished_at="$3" record_status=0
  local deferred_name deferred_exit_code pause_deadline

  SIGNAL_RECORD_CRITICAL=1
  record_stage "$CURRENT_STAGE" "$stage_status" "$exit_code" \
    "$CURRENT_STAGE_STARTED" "$finished_at" || record_status=$?

  # Causal process plant for the exact post-append/pre-bookkeeping signal seam.
  # It is unreachable in live mode and stops waiting as soon as the deferred
  # trap records delivery.
  if [[ "$record_status" -eq 0 && "$PIPELINE_TEST_MODE" == "1" &&
    "${ASIMP_CI_PROCESS_PAUSE_AFTER_STAGE_RECORD:-}" == "$CURRENT_STAGE" ]]; then
    printf 'recorded:%s\n' "$CURRENT_STAGE" >> "$ASIMP_CI_PROCESS_TRACE"
    pause_deadline=$((SECONDS + 10))
    while [[ -z "$DEFERRED_SIGNAL_NAME" && "$SECONDS" -lt "$pause_deadline" ]]; do
      sleep 0.02
    done
    [[ -n "$DEFERRED_SIGNAL_NAME" ]] || record_status=99
  fi
  if [[ "$record_status" -eq 0 ]]; then
    CURRENT_STAGE_RECORDED=1
  fi

  SIGNAL_RECORD_CRITICAL=0
  if [[ -n "$DEFERRED_SIGNAL_NAME" ]]; then
    deferred_name="$DEFERRED_SIGNAL_NAME"
    deferred_exit_code="$DEFERRED_SIGNAL_EXIT_CODE"
    DEFERRED_SIGNAL_NAME=""
    DEFERRED_SIGNAL_EXIT_CODE=""
    on_signal "$deferred_name" "$deferred_exit_code"
  fi
  return "$record_status"
}

run_bounded() {
  local timeout_seconds="$1" termination_grace_seconds=10
  local force_unsettled=0 kill_wrapper_after_spawn=0 settlement_ack="" status
  shift
  # Process controls use a short grace so the planted matrix stays fast. Live
  # stages get enough bounded time for their own failure traps to retire remote
  # canaries and local descendants before group-wide escalation.
  if [[ "$PIPELINE_TEST_MODE" == "1" ]]; then
    termination_grace_seconds=1
  fi
  case "${ASIMP_CI_PROCESS_FORCE_UNSETTLED:-0}" in
    0) ;;
    1)
      [[ "$PIPELINE_TEST_MODE" == "1" ]] || return 64
      force_unsettled=1
      ;;
    *) return 64 ;;
  esac
  case "${ASIMP_CI_PROCESS_KILL_WRAPPER_AFTER_SPAWN:-0}" in
    0) ;;
    1)
      [[ "$PIPELINE_TEST_MODE" == "1" ]] || return 64
      kill_wrapper_after_spawn=1
      ;;
    *) return 64 ;;
  esac
  PIPELINE_ARTIFACT_PROCESS_GROUP_SETTLED=0
  # fd 9 is a private settlement acknowledgement pipe. fd 3 is made
  # non-inheritable before the stage starts, while ordinary stage output stays
  # on the caller's stdout through fd 8. A wrapper crash therefore closes the
  # pipe without a token; no descendant can forge settlement.
  exec 8>&1
  exec 9< <(
    exec python3 - \
      "$timeout_seconds" "$termination_grace_seconds" \
      "$force_unsettled" "$kill_wrapper_after_spawn" "$@" \
      3>&1 1>&8 <<'PY'
import ctypes
import os
import signal
import subprocess
import sys
import time

timeout_seconds = int(sys.argv[1])
termination_grace_seconds = int(sys.argv[2])
force_unsettled = sys.argv[3] == "1"
kill_wrapper_after_spawn = sys.argv[4] == "1"
command = sys.argv[5:]
unsettled_exit = 125

def acknowledged_exit(status: int, acknowledgement: bytes) -> None:
    try:
        os.write(3, acknowledgement + b"\n")
    except OSError:
        sys.exit(unsettled_exit)
    sys.exit(status)

def settled_exit(status: int) -> None:
    acknowledged_exit(status, b"settled")

def unproven_exit(status: int) -> None:
    acknowledged_exit(status, b"unproven")

def enable_descendant_proof() -> bool:
    if not sys.platform.startswith("linux"):
        return False
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        raise OSError("Linux descendant proof requires pidfd support")
    libc = ctypes.CDLL(None, use_errno=True)
    pr_set_child_subreaper = 36
    if libc.prctl(pr_set_child_subreaper, 1, 0, 0, 0) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    return True

try:
    os.set_inheritable(3, False)
    descendant_proof_supported = enable_descendant_proof()
    child = subprocess.Popen(command, start_new_session=True)
except BaseException:
    # No stage process exists, so even a launch refusal has a positive empty-set
    # proof. Preserve a distinct wrapper failure without stranding the lease.
    settled_exit(126)
if kill_wrapper_after_spawn:
    os.kill(os.getpid(), signal.SIGKILL)
caught = None
settlement_proven = True

def reap_exited_children() -> bool:
    while True:
        try:
            pid, _status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return True
        except OSError:
            return False
        if pid == 0:
            return True

def direct_children():
    try:
        with open(
            f"/proc/self/task/{os.getpid()}/children",
            "r",
            encoding="ascii",
        ) as handle:
            fields = handle.read().split()
    except (OSError, UnicodeError):
        return None
    if any(not field.isdecimal() for field in fields):
        return None
    return [int(field) for field in fields]

def signal_exact_children(children, signum: int) -> bool:
    for pid in children:
        try:
            pidfd = os.pidfd_open(pid, 0)
        except ProcessLookupError:
            continue
        except OSError:
            return False
        try:
            signal.pidfd_send_signal(pidfd, signum, None, 0)
        except ProcessLookupError:
            pass
        except OSError:
            return False
        finally:
            os.close(pidfd)
    return True

def retire_adopted_descendants() -> bool:
    if not descendant_proof_supported:
        return False
    if not reap_exited_children():
        return False
    term_deadline = time.monotonic() + termination_grace_seconds
    while time.monotonic() < term_deadline:
        children = direct_children()
        if children is None:
            return False
        if not children:
            return reap_exited_children() and direct_children() == []
        if not signal_exact_children(children, signal.SIGTERM):
            return False
        time.sleep(0.02)
        if not reap_exited_children():
            return False
    kill_deadline = time.monotonic() + termination_grace_seconds
    while time.monotonic() < kill_deadline:
        children = direct_children()
        if children is None:
            return False
        if not children:
            return reap_exited_children() and direct_children() == []
        if not signal_exact_children(children, signal.SIGKILL):
            return False
        time.sleep(0.02)
        if not reap_exited_children():
            return False
    return False

def finish_after_group(status: int) -> None:
    if not descendant_proof_supported:
        # The original group is absent, but this host has no exact descendant
        # authority. Preserve the stage result while forcing the Bash owner to
        # retain its append-only lease.
        unproven_exit(status)
    if not retire_adopted_descendants():
        sys.exit(unsettled_exit)
    settled_exit(status)

def group_absent() -> bool:
    try:
        # Reap an exited group leader before probing the process group. A live
        # ignoring descendant keeps the group addressable after that reap.
        child.poll()
        os.killpg(child.pid, 0)
    except ProcessLookupError:
        return True
    except OSError:
        return False
    return False

def wait_for_group_absence() -> bool:
    deadline = time.monotonic() + termination_grace_seconds
    while not group_absent() and time.monotonic() < deadline:
        time.sleep(0.02)
    return group_absent()

def terminate_group(first_signal: int) -> bool:
    try:
        os.killpg(child.pid, first_signal)
    except ProcessLookupError:
        return not force_unsettled
    except OSError:
        return False
    if wait_for_group_absence():
        return not force_unsettled
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        return not force_unsettled
    except OSError:
        return False
    return wait_for_group_absence() and not force_unsettled

def wait_for_leader() -> bool:
    try:
        child.wait(timeout=termination_grace_seconds + 1)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return True

def cancelled(signum: int, _frame: object) -> None:
    global caught, settlement_proven
    caught = signum
    settlement_proven = terminate_group(signum)

for forwarded in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
    signal.signal(forwarded, cancelled)

deadline = time.monotonic() + timeout_seconds
while child.poll() is None and caught is None and time.monotonic() < deadline:
    time.sleep(0.02)

if caught is not None:
    if not wait_for_leader() or not settlement_proven:
        sys.exit(unsettled_exit)
    finish_after_group(128 + caught)
if child.poll() is None:
    settlement_proven = terminate_group(signal.SIGTERM)
    if not wait_for_leader() or not settlement_proven:
        sys.exit(unsettled_exit)
    finish_after_group(124)

status = child.returncode
# A terminal group leader does not prove its stage is quiescent: failed tools
# can leave background descendants behind. Retire any surviving process-group
# members on every outcome before returning the leader's exact status.
if not terminate_group(signal.SIGTERM):
    sys.exit(unsettled_exit)
finish_after_group(128 - status if status < 0 else status)
PY
  )
  CURRENT_WRAPPER_PID=$!
  wait "$CURRENT_WRAPPER_PID"
  status=$?
  CURRENT_WRAPPER_PID=""
  if IFS= read -r settlement_ack <&9; then
    case "$settlement_ack" in
      settled)
        PIPELINE_ARTIFACT_PROCESS_GROUP_SETTLED=1
        ;;
      unproven)
        PIPELINE_ARTIFACT_PROCESS_GROUP_SETTLED=1
        PIPELINE_ARTIFACT_DESCENDANT_SETTLEMENT_PROVEN=0
        ;;
      *)
        PIPELINE_ARTIFACT_DESCENDANT_SETTLEMENT_PROVEN=0
        status=125
        ;;
    esac
  else
    PIPELINE_ARTIFACT_DESCENDANT_SETTLEMENT_PROVEN=0
    status=125
  fi
  exec 9<&-
  exec 8>&-
  return "$status"
}

plant_stage() {
  local stage="$1" planted_stage outcome
  [[ "$PIPELINE_TEST_MODE" == "1" ]] || return 64
  # The parent test process supplies this canary only to prove stage_command's
  # clean-environment boundary. Seeing it here means an ambient value crossed
  # that boundary and the plant must fail closed.
  [[ -z "${ASIMP_CI_PROCESS_AMBIENT_CANARY:-}" ]] || return 97
  if [[ "${ASIMP_CI_PROCESS_SCOPE_PLANT:-0}" == "1" ]]; then
    case "$stage" in
      root-gate | smoke-gallery)
        [[ "${CLOUDFLARE_API_TOKEN+present}" != present ]] || return 98
        [[ "${CLOUDFLARE_ACCOUNT_ID+present}" != present ]] || return 98
        [[ "${ASIMP_D1_DATABASE_ID_STAGING+present}" != present ]] || return 98
        [[ "${ASIMP_STAGING_SERVICE_ENVELOPE_KEYS+present}" != present ]] || return 98
        [[ "${VERCEL_TOKEN+present}" != present ]] || return 98
        [[ "${VERCEL_ORG_ID+present}" != present ]] || return 98
        [[ "${VERCEL_PROJECT_ID+present}" != present ]] || return 98
        [[ "${ASIMPOSIUM_SMOKE_FELLOW_TOKEN+present}" != present ]] || return 98
        ;;
      smoke-agent)
        [[ "${ASIMPOSIUM_SMOKE_FELLOW_TOKEN:-}" == scope-fellow-token ]] || return 98
        [[ "${CLOUDFLARE_API_TOKEN+present}" != present ]] || return 98
        [[ "${CLOUDFLARE_ACCOUNT_ID+present}" != present ]] || return 98
        [[ "${ASIMP_D1_DATABASE_ID_STAGING+present}" != present ]] || return 98
        [[ "${ASIMP_STAGING_SERVICE_ENVELOPE_KEYS+present}" != present ]] || return 98
        [[ "${VERCEL_TOKEN+present}" != present ]] || return 98
        [[ "${VERCEL_ORG_ID+present}" != present ]] || return 98
        [[ "${VERCEL_PROJECT_ID+present}" != present ]] || return 98
        ;;
      worker-deploy | worker-readiness)
        [[ "${CLOUDFLARE_API_TOKEN:-}" == scope-cloudflare-token ]] || return 98
        [[ "${CLOUDFLARE_ACCOUNT_ID:-}" == scope-cloudflare-account ]] || return 98
        [[ "${ASIMP_D1_DATABASE_ID_STAGING:-}" == scope-d1-id ]] || return 98
        [[ "${ASIMP_STAGING_SERVICE_ENVELOPE_KEYS:-}" == scope-service-keys ]] || return 98
        [[ "${VERCEL_TOKEN+present}" != present ]] || return 98
        [[ "${VERCEL_ORG_ID+present}" != present ]] || return 98
        [[ "${VERCEL_PROJECT_ID+present}" != present ]] || return 98
        [[ "${ASIMPOSIUM_SMOKE_FELLOW_TOKEN+present}" != present ]] || return 98
        ;;
      web-deploy)
        [[ "${CLOUDFLARE_API_TOKEN:-}" == scope-cloudflare-token ]] || return 98
        [[ "${CLOUDFLARE_ACCOUNT_ID:-}" == scope-cloudflare-account ]] || return 98
        [[ "${VERCEL_TOKEN:-}" == scope-vercel-token ]] || return 98
        [[ "${VERCEL_ORG_ID:-}" == scope-vercel-org ]] || return 98
        [[ "${VERCEL_PROJECT_ID:-}" == scope-vercel-project ]] || return 98
        [[ "${ASIMP_D1_DATABASE_ID_STAGING+present}" != present ]] || return 98
        [[ "${ASIMP_STAGING_SERVICE_ENVELOPE_KEYS+present}" != present ]] || return 98
        [[ "${ASIMPOSIUM_SMOKE_FELLOW_TOKEN+present}" != present ]] || return 98
        ;;
      *) return 98 ;;
    esac
  fi
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
      while true; do
        sleep 1
      done
      ;;
    fail-orphan)
      if [[ -n "${ASIMP_CI_PROCESS_TRACE:-}" ]]; then
        (
          trap '' INT TERM HUP
          sleep 3
          printf 'descendant-survived:%s\n' "$stage" >> "$ASIMP_CI_PROCESS_TRACE"
        ) &
      fi
      return 17
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
  local expected_version_id="$1" expected_deployment_id="$2" safe_receipt="$3"
  local status
  local -a pipeline_statuses=()

  ci_artifact_capability_is_current || return 64
  curl_with_bearer "$CLOUDFLARE_API_TOKEN" \
    --fail --silent --show-error \
    --user-agent "$USER_AGENT" \
    --connect-timeout 5 --max-time 20 \
    "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/asimposium-stoa-staging/deployments" | \
    python3 -c '
import datetime
import json
import re
import sys

try:
    document = json.load(sys.stdin)
except (json.JSONDecodeError, UnicodeDecodeError):
    sys.exit(1)
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
if sys.argv[2] and deployment_id != sys.argv[2]:
    sys.exit(1)
versions = active.get("versions")
if not isinstance(versions, list) or len(versions) != 1 or not isinstance(versions[0], dict):
    sys.exit(1)
version = versions[0]
if version.get("version_id") != sys.argv[1] or version.get("percentage") != 100:
    sys.exit(1)
annotations = active.get("annotations")
if not isinstance(annotations, dict) or annotations.get("workers/message") != "asimposium revision " + sys.argv[3]:
    sys.exit(1)
observed_at = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
print(json.dumps({
    "deployment_id": deployment_id,
    "version_id": sys.argv[1],
    "observed_at": observed_at,
    "status": "ready",
}, separators=(",", ":")))
' "$expected_version_id" "$expected_deployment_id" "$REVISION" > "$safe_receipt"
  pipeline_statuses=("${PIPESTATUS[@]}")
  status="${pipeline_statuses[0]}"
  [[ "$status" -eq 0 ]] || return "$status"
  status="${pipeline_statuses[1]}"
  [[ "$status" -eq 0 ]] || return "$status"
}

worker_deploy() {
  local config="$repository_root/infra/deploy-resolved/staging.wrangler.toml"
  local raw_receipt="$ARTIFACT_DIRECTORY/wrangler-output.jsonl"
  local version_receipt="$ARTIFACT_DIRECTORY/worker-version.json"
  local safe_receipt="$ARTIFACT_DIRECTORY/worker-deployment.json"
  local status version_id

  ci_artifact_capability_is_current || return 64
  require_bearer_token CLOUDFLARE_API_TOKEN || return $?
  require_live_variable CLOUDFLARE_ACCOUNT_ID || return $?
  require_live_variable ASIMP_D1_DATABASE_ID_STAGING || return $?
  require_live_variable ASIMP_STAGING_SERVICE_ENVELOPE_KEYS || return $?
  # The resolver and receipt parsers do not need deployment authority. Keep the
  # token as a shell variable for stdin-config API calls, exporting it only for
  # Wrangler's authenticated deploy process.
  export -n CLOUDFLARE_API_TOKEN

  ASIMP_ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID" \
    bun "$repository_root/infra/resolve-wrangler-deploy.mjs" --env staging --write
  status=$?
  [[ "$status" -eq 0 ]] || return "$status"

  ci_artifact_capability_is_current || return 64
  (
    cd "$repository_root/apps/wire" || exit 1
    export CLOUDFLARE_API_TOKEN
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

  ci_artifact_capability_is_current || return 64
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
  observe_active_worker_deployment "$version_id" "" "$safe_receipt"
}

worker_readiness() {
  local capabilities="$ARTIFACT_DIRECTORY/capabilities.json"
  local schema_paths="$ARTIFACT_DIRECTORY/schema-paths.txt"
  local attestation_receipt="$ARTIFACT_DIRECTORY/worker-readiness-deployment.json"
  local deployment_id schema_path version_id index=0 status

  ci_artifact_capability_is_current || return 64
  bash "$repository_root/scripts/e2e-environments.sh" staging
  status=$?
  [[ "$status" -eq 0 ]] || return "$status"

  ci_artifact_capability_is_current || return 64
  curl --fail --silent --show-error --location \
    --user-agent "$USER_AGENT" \
    --connect-timeout 5 --max-time 20 \
    --output "$capabilities" \
    "$STAGING_WORKER_ORIGIN/capabilities"
  status=$?
  [[ "$status" -eq 0 ]] || return "$status"

  ci_artifact_capability_is_current || return 64
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
    ci_artifact_capability_is_current || return 64
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
    "$version_id" "$deployment_id" "$attestation_receipt"
}

web_deploy() {
  local project_receipt="$ARTIFACT_DIRECTORY/vercel-project.json"
  local preview_baseline_receipt="$ARTIFACT_DIRECTORY/vercel-preview-baseline.json"
  local deployment_url_file="$ARTIFACT_DIRECTORY/vercel-deployment-url.txt"
  local inspect_receipt="$ARTIFACT_DIRECTORY/vercel-inspect.json"
  local api_receipt="$ARTIFACT_DIRECTORY/vercel-deployment-api.json"
  local worker_attestation_receipt="$ARTIFACT_DIRECTORY/worker-web-ready-deployment.json"
  local safe_receipt="$ARTIFACT_DIRECTORY/web-deployment.json"
  local deployment_host deployment_id deployment_origin deployment_output inspect_output status version_id
  local -a pipeline_statuses=()

  ci_artifact_capability_is_current || return 64
  require_bearer_token VERCEL_TOKEN || return $?
  require_live_variable VERCEL_ORG_ID || return $?
  require_live_variable VERCEL_PROJECT_ID || return $?
  require_bearer_token CLOUDFLARE_API_TOKEN || return $?
  require_live_variable CLOUDFLARE_ACCOUNT_ID || return $?
  [[ "$VERCEL_ORG_ID" =~ ^(team|user)_[A-Za-z0-9]+$ ]] || return 78
  [[ "$VERCEL_PROJECT_ID" =~ ^prj_[A-Za-z0-9]+$ ]] || return 78
  # API credentials travel through curl's stdin config. Do not also export them
  # to unrelated curl/parser children; Vercel authority is exported only for
  # the two Vercel CLI invocations below, and Cloudflare authority never is.
  export -n CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
  export -n VERCEL_TOKEN VERCEL_ORG_ID VERCEL_PROJECT_ID

  ci_artifact_capability_is_current || return 64
  curl_with_bearer "$VERCEL_TOKEN" \
    --fail --silent --show-error \
    --user-agent "$USER_AGENT" \
    --connect-timeout 5 --max-time 20 \
    "https://api.vercel.com/v9/projects/$VERCEL_PROJECT_ID?teamId=$VERCEL_ORG_ID" | \
    python3 -c '
import json
import sys

try:
    document = json.load(sys.stdin)
except (json.JSONDecodeError, UnicodeDecodeError):
    sys.exit(1)
if not isinstance(document, dict) or document.get("id") != sys.argv[1]:
    sys.exit(1)
# A connected Git provider can deploy the web revision concurrently with this
# ordered pipeline. Absence is the only provider state this gate treats as safe.
if "link" in document:
    sys.exit(78)
print(json.dumps({"project_id": sys.argv[1], "git_linked": False}, separators=(",", ":")))
' "$VERCEL_PROJECT_ID" > "$project_receipt"
  pipeline_statuses=("${PIPESTATUS[@]}")
  status="${pipeline_statuses[0]}"
  [[ "$status" -eq 0 ]] || return "$status"
  status="${pipeline_statuses[1]}"
  [[ "$status" -eq 0 ]] || return "$status"

  # Post-deploy target validation cannot undo an accidentally production-
  # classified first deployment. Require an existing Preview record for this
  # exact project before mutation, so a new or ambiguously initialized project
  # stops at a read-only provider check.
  ci_artifact_capability_is_current || return 64
  curl_with_bearer "$VERCEL_TOKEN" \
    --fail --silent --show-error \
    --user-agent "$USER_AGENT" \
    --connect-timeout 5 --max-time 20 \
    "https://api.vercel.com/v7/deployments?projectId=$VERCEL_PROJECT_ID&teamId=$VERCEL_ORG_ID&target=preview&limit=1" | \
    python3 -c '
import json
import re
import sys

try:
    document = json.load(sys.stdin)
except (json.JSONDecodeError, UnicodeDecodeError):
    sys.exit(1)
if not isinstance(document, dict):
    sys.exit(1)
deployments = document.get("deployments")
if not isinstance(deployments, list):
    sys.exit(1)
if not deployments:
    sys.exit(78)
if len(deployments) != 1:
    sys.exit(1)
baseline = deployments[0]
# The Vercel API encodes Preview as a null target; production and custom staging
# have named targets. Normalize only after proving the provider value is null.
if not isinstance(baseline, dict) or "target" not in baseline or baseline["target"] is not None:
    sys.exit(1)
project_id = baseline.get("projectId")
if project_id is None and isinstance(baseline.get("project"), dict):
    project_id = baseline["project"].get("id")
deployment_id = baseline.get("id") or baseline.get("uid")
if project_id != sys.argv[1]:
    sys.exit(1)
if not isinstance(deployment_id, str) or not re.fullmatch(r"dpl_[A-Za-z0-9]{8,128}", deployment_id):
    sys.exit(1)
print(json.dumps({
    "deployment_id": deployment_id,
    "project_id": project_id,
    "target": "preview",
}, separators=(",", ":")))
' "$VERCEL_PROJECT_ID" > "$preview_baseline_receipt"
  pipeline_statuses=("${PIPESTATUS[@]}")
  status="${pipeline_statuses[0]}"
  [[ "$status" -eq 0 ]] || return "$status"
  status="${pipeline_statuses[1]}"
  [[ "$status" -eq 0 ]] || return "$status"

  ci_artifact_capability_is_current || return 64
  export VERCEL_TOKEN VERCEL_ORG_ID VERCEL_PROJECT_ID
  deployment_output="$(bunx --bun "vercel@$VERCEL_CLI_VERSION" deploy "$repository_root" \
    --yes \
    --target preview \
    --skip-domain \
    --meta "asimposiumRevision=$REVISION" \
    --build-env "STOA_ORIGIN=$STAGING_WORKER_ORIGIN" \
    --env "STOA_ORIGIN=$STAGING_WORKER_ORIGIN")"
  status=$?
  export -n VERCEL_TOKEN VERCEL_ORG_ID VERCEL_PROJECT_ID
  [[ "$status" -eq 0 ]] || return "$status"

  ci_artifact_capability_is_current || return 64
  printf '%s' "$deployment_output" | python3 -c '
import sys
from urllib.parse import urlsplit

value = sys.stdin.read().strip()
parts = urlsplit(value if "://" in value else "https://" + value)
if parts.scheme != "https" or not parts.hostname or parts.port is not None or parts.path not in ("", "/") or parts.query or parts.fragment:
    sys.exit(1)
if not parts.hostname.endswith(".vercel.app"):
    sys.exit(1)
print("https://" + parts.hostname)
' > "$deployment_url_file"
  status=$?
  deployment_output=""
  [[ "$status" -eq 0 ]] || return "$status"
  deployment_origin="$(<"$deployment_url_file")"

  ci_artifact_capability_is_current || return 64
  export VERCEL_TOKEN VERCEL_ORG_ID VERCEL_PROJECT_ID
  inspect_output="$(bunx --bun "vercel@$VERCEL_CLI_VERSION" inspect "$deployment_origin" --wait --timeout 25m --json)"
  status=$?
  export -n VERCEL_TOKEN VERCEL_ORG_ID VERCEL_PROJECT_ID
  [[ "$status" -eq 0 ]] || return "$status"
  ci_artifact_capability_is_current || return 64
  printf '%s' "$inspect_output" | python3 -c '
import json
import re
import sys
from urllib.parse import urlsplit

try:
    document = json.load(sys.stdin)
except (json.JSONDecodeError, UnicodeDecodeError):
    sys.exit(1)
if not isinstance(document, dict):
    sys.exit(1)
deployment_id = document.get("id") or document.get("uid") or document.get("deploymentId")
url = document.get("url")
state = document.get("readyState")
if not isinstance(deployment_id, str) or not re.fullmatch(r"dpl_[A-Za-z0-9]{8,128}", deployment_id):
    sys.exit(1)
if not isinstance(url, str):
    sys.exit(1)
parts = urlsplit(url if "://" in url else "https://" + url)
if parts.scheme != "https" or not parts.hostname or parts.port is not None or parts.path not in ("", "/") or parts.query or parts.fragment:
    sys.exit(1)
if not parts.hostname.endswith(".vercel.app"):
    sys.exit(1)
if state != "READY" or document.get("target") != "preview":
    sys.exit(1)
print(json.dumps({
    "deployment_id": deployment_id,
    "origin": "https://" + parts.hostname,
    "status": "ready",
    "target": "preview",
}, separators=(",", ":")))
' > "$inspect_receipt"
  status=$?
  inspect_output=""
  [[ "$status" -eq 0 ]] || return "$status"

  deployment_host="${deployment_origin#https://}"
  ci_artifact_capability_is_current || return 64
  curl_with_bearer "$VERCEL_TOKEN" \
    --fail --silent --show-error \
    --user-agent "$USER_AGENT" \
    --connect-timeout 5 --max-time 20 \
    "https://api.vercel.com/v13/deployments/$deployment_host?teamId=$VERCEL_ORG_ID" | \
    python3 -c '
import json
import re
import sys
from urllib.parse import urlsplit

try:
    document = json.load(sys.stdin)
except (json.JSONDecodeError, UnicodeDecodeError):
    sys.exit(1)
if not isinstance(document, dict):
    sys.exit(1)
deployment_id = document.get("id")
url = document.get("url")
state = document.get("readyState")
if not isinstance(deployment_id, str) or not re.fullmatch(r"dpl_[A-Za-z0-9]{8,128}", deployment_id):
    sys.exit(1)
if not isinstance(url, str):
    sys.exit(1)
parts = urlsplit(url if "://" in url else "https://" + url)
if parts.scheme != "https" or not parts.hostname or parts.port is not None or parts.path not in ("", "/") or parts.query or parts.fragment:
    sys.exit(1)
if not parts.hostname.endswith(".vercel.app"):
    sys.exit(1)
if state != "READY" or "target" not in document or document["target"] is not None:
    sys.exit(1)
project_id = document.get("projectId")
if project_id is None and isinstance(document.get("project"), dict):
    project_id = document["project"].get("id")
metadata = document.get("meta")
if project_id != sys.argv[1] or not isinstance(metadata, dict) or metadata.get("asimposiumRevision") != sys.argv[2]:
    sys.exit(1)
print(json.dumps({
    "deployment_id": deployment_id,
    "origin": "https://" + parts.hostname,
    "project_id": project_id,
    "revision": sys.argv[2],
    "status": "ready",
    "target": "preview",
}, separators=(",", ":")))
' "$VERCEL_PROJECT_ID" "$REVISION" > "$api_receipt"
  pipeline_statuses=("${PIPESTATUS[@]}")
  status="${pipeline_statuses[0]}"
  [[ "$status" -eq 0 ]] || return "$status"
  status="${pipeline_statuses[1]}"
  [[ "$status" -eq 0 ]] || return "$status"

  ci_artifact_capability_is_current || return 64
  deployment_id="$(safe_receipt_field "$ARTIFACT_DIRECTORY/worker-deployment.json" deployment_id)" || return 1
  version_id="$(safe_receipt_field "$ARTIFACT_DIRECTORY/worker-deployment.json" version_id)" || return 1
  observe_active_worker_deployment \
    "$version_id" "$deployment_id" "$worker_attestation_receipt"
  status=$?
  [[ "$status" -eq 0 ]] || return "$status"

  ci_artifact_capability_is_current || return 64
  python3 - "$inspect_receipt" "$api_receipt" "$REVISION" "$VERCEL_PROJECT_ID" "$deployment_origin" <<'PY' > "$safe_receipt"
import datetime
import json
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    document = json.load(stream)
with open(sys.argv[2], encoding="utf-8") as stream:
    api_document = json.load(stream)
if not isinstance(document, dict) or set(document) != {"deployment_id", "origin", "status", "target"}:
    sys.exit(1)
if not isinstance(api_document, dict) or set(api_document) != {
    "deployment_id", "origin", "project_id", "revision", "status", "target"
}:
    sys.exit(1)
if document != {
    "deployment_id": api_document["deployment_id"],
    "origin": api_document["origin"],
    "status": "ready",
    "target": "preview",
}:
    sys.exit(1)
if (
    api_document["status"] != "ready"
    or api_document["target"] != "preview"
    or api_document["project_id"] != sys.argv[4]
    or api_document["revision"] != sys.argv[3]
    or document["origin"] != sys.argv[5]
):
    sys.exit(1)
observed_at = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
print(json.dumps({
    "deployment_id": document["deployment_id"],
    "observed_at": observed_at,
    "status": "ready",
    "origin": document["origin"],
}, separators=(",", ":")))
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

stage_environment_prefix() {
  # Stages run third-party tools and remote probes. Start each one from a small
  # operational allowlist so a root gate or smoke cannot inherit unrelated
  # provider credentials from the hosted runner. Stage-specific authority is
  # retained only where it is actually needed. The wrapper inherits secrets as
  # environment variables and unsets them before exec; putting secret
  # assignments in an `env -i` argv would merely move the disclosure into the
  # process table.
  local stage="$1"
  printf '%s\0' /usr/bin/env -u BASH_ENV -u ENV -u SHELLOPTS -u BASHOPTS /bin/bash --noprofile --norc -c '
for function_name in $(builtin compgen -A function); do
  builtin unset -f "$function_name"
done
for name in $(builtin compgen -e); do
  case "$name" in
    PATH|HOME|TMPDIR|LANG|LC_ALL|TZ|CURL_HOME|BUN_VERSION|CI|WORKERS_CI|WORKERS_CI_BUILD_UUID|WORKERS_CI_COMMIT_SHA|USER|LOGNAME|SHELL|CARGO_HOME|RUSTUP_HOME|CARGO_TARGET_DIR|BUN_INSTALL|SSL_CERT_FILE|SSL_CERT_DIR)
      ;;
    ASIMP_CI_PROCESS_TEST|ASIMP_CI_PROCESS_PLANT_STAGE|ASIMP_CI_PROCESS_PLANT_OUTCOME|ASIMP_CI_PROCESS_TRACE|ASIMP_CI_PROCESS_ARTIFACT_DIRECTORY|ASIMP_CI_PROCESS_SCOPE_PLANT)
      ;;
    CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID)
      [[ "$1" == worker-deploy || "$1" == worker-readiness || "$1" == web-deploy ]] || builtin unset "$name"
      ;;
    ASIMP_D1_DATABASE_ID_STAGING|ASIMP_STAGING_SERVICE_ENVELOPE_KEYS)
      [[ "$1" == worker-deploy || "$1" == worker-readiness ]] || builtin unset "$name"
      ;;
    VERCEL_TOKEN|VERCEL_ORG_ID|VERCEL_PROJECT_ID)
      [[ "$1" == web-deploy ]] || builtin unset "$name"
      ;;
    ASIMPOSIUM_SMOKE_FELLOW_TOKEN)
      [[ "$1" == smoke-agent ]] || builtin unset "$name"
      ;;
    *) builtin unset "$name" ;;
  esac
done
builtin exec "${@:2}"
' bash "$stage"
}

stage_command() {
  local stage="$1"
  stage_environment_prefix "$stage"
  if [[ "$PIPELINE_TEST_MODE" == "1" ]]; then
    printf '%s\0' bash "$repository_root/scripts/e2e-ci-pipeline.sh" __plant "$stage"
    return 0
  fi
  case "$stage" in
    root-gate)
      printf '%s\0' bash "$repository_root/scripts/gates.sh" --all
      ;;
    worker-deploy)
      printf '%s\0' /usr/bin/env \
        ASIMP_CI_INTERNAL=1 \
        ASIMP_CI_INTERNAL_RUN_ID="$RUN_ID" \
        ASIMP_CI_INTERNAL_ARTIFACT_ROOT_IDENTITY="$ASIMP_CI_INTERNAL_ARTIFACT_ROOT_IDENTITY" \
        ASIMP_CI_INTERNAL_RUN_IDENTITY="$ASIMP_CI_INTERNAL_RUN_IDENTITY" \
        ASIMP_CI_INTERNAL_LEASE_DIRECTORY="$ASIMP_CI_INTERNAL_LEASE_DIRECTORY" \
        ASIMP_CI_INTERNAL_LEASE_IDENTITY="$ASIMP_CI_INTERNAL_LEASE_IDENTITY" \
        ASIMP_CI_RUNNER="$RUNNER" \
        bash "$repository_root/scripts/e2e-ci-pipeline.sh" __worker_deploy
      ;;
    worker-readiness)
      printf '%s\0' /usr/bin/env \
        ASIMP_CI_INTERNAL=1 \
        ASIMP_CI_INTERNAL_RUN_ID="$RUN_ID" \
        ASIMP_CI_INTERNAL_ARTIFACT_ROOT_IDENTITY="$ASIMP_CI_INTERNAL_ARTIFACT_ROOT_IDENTITY" \
        ASIMP_CI_INTERNAL_RUN_IDENTITY="$ASIMP_CI_INTERNAL_RUN_IDENTITY" \
        ASIMP_CI_INTERNAL_LEASE_DIRECTORY="$ASIMP_CI_INTERNAL_LEASE_DIRECTORY" \
        ASIMP_CI_INTERNAL_LEASE_IDENTITY="$ASIMP_CI_INTERNAL_LEASE_IDENTITY" \
        ASIMP_CI_RUNNER="$RUNNER" \
        bash "$repository_root/scripts/e2e-ci-pipeline.sh" __worker_readiness
      ;;
    web-deploy)
      printf '%s\0' /usr/bin/env \
        ASIMP_CI_INTERNAL=1 \
        ASIMP_CI_INTERNAL_RUN_ID="$RUN_ID" \
        ASIMP_CI_INTERNAL_ARTIFACT_ROOT_IDENTITY="$ASIMP_CI_INTERNAL_ARTIFACT_ROOT_IDENTITY" \
        ASIMP_CI_INTERNAL_RUN_IDENTITY="$ASIMP_CI_INTERNAL_RUN_IDENTITY" \
        ASIMP_CI_INTERNAL_LEASE_DIRECTORY="$ASIMP_CI_INTERNAL_LEASE_DIRECTORY" \
        ASIMP_CI_INTERNAL_LEASE_IDENTITY="$ASIMP_CI_INTERNAL_LEASE_IDENTITY" \
        ASIMP_CI_RUNNER="$RUNNER" \
        bash "$repository_root/scripts/e2e-ci-pipeline.sh" __web_deploy
      ;;
    smoke-agent)
      printf '%s\0' /usr/bin/env \
        ASIMPOSIUM_STAGING_AGENT_BASE_URL="$STAGING_WORKER_ORIGIN" \
        bash "$repository_root/scripts/smoke-agent.sh" --write-artifacts --run-id "smoke-agent-${REVISION:0:12}-$$"
      ;;
    smoke-gallery)
      printf '%s\0' /usr/bin/env \
        ASIMPOSIUM_STAGING_AGORA_BASE_URL="$STAGING_AGORA_ORIGIN" \
        bash "$repository_root/scripts/smoke-gallery.sh" --write-artifacts --run-id "smoke-gallery-${REVISION:0:12}-$$"
      ;;
    *) return 64 ;;
  esac
}

run_stage() {
  local stage="$1" timeout_seconds status finished_at deployment_id observed_at deployment_status completed_index
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
    0) record_current_stage_result "pass" 0 "$finished_at" || return 1 ;;
    75 | 78) record_current_stage_result "blocked" "$status" "$finished_at" || return 1 ;;
    124) record_current_stage_result "timeout" 124 "$finished_at" || return 1 ;;
    129 | 130 | 143) record_current_stage_result "cancelled" "$status" "$finished_at" || return 1 ;;
    *) record_current_stage_result "fail" "$status" "$finished_at" || return 1 ;;
  esac

  completed_index="$(stage_index "$stage")" || return 64
  NEXT_STAGE_INDEX=$((completed_index + 1))
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
      local inherited_root_identity inherited_run_identity
      local inherited_lease_directory inherited_lease_identity inherited_runner
      [[ "$PIPELINE_TEST_MODE" != "1" ]] || return 64
      [[ "${ASIMP_CI_INTERNAL:-0}" == "1" ]] || return 64
      RUN_ID="${ASIMP_CI_INTERNAL_RUN_ID:-}"
      inherited_root_identity="${ASIMP_CI_INTERNAL_ARTIFACT_ROOT_IDENTITY:-}"
      inherited_run_identity="${ASIMP_CI_INTERNAL_RUN_IDENTITY:-}"
      inherited_lease_directory="${ASIMP_CI_INTERNAL_LEASE_DIRECTORY:-}"
      inherited_lease_identity="${ASIMP_CI_INTERNAL_LEASE_IDENTITY:-}"
      inherited_runner="${ASIMP_CI_RUNNER:-manual}"
      # Keep the inherited handoff out of every nested process. The child uses
      # unexported shell copies for its repeated filesystem proof.
      unset ASIMP_CI_INTERNAL ASIMP_CI_INTERNAL_RUN_ID ASIMP_CI_RUNNER \
        ASIMP_CI_INTERNAL_ARTIFACT_ROOT_IDENTITY ASIMP_CI_INTERNAL_RUN_IDENTITY \
        ASIMP_CI_INTERNAL_LEASE_DIRECTORY ASIMP_CI_INTERNAL_LEASE_IDENTITY
      ASIMP_CI_INTERNAL_ARTIFACT_ROOT_IDENTITY="$inherited_root_identity"
      ASIMP_CI_INTERNAL_RUN_IDENTITY="$inherited_run_identity"
      ASIMP_CI_INTERNAL_LEASE_DIRECTORY="$inherited_lease_directory"
      ASIMP_CI_INTERNAL_LEASE_IDENTITY="$inherited_lease_identity"
      RUNNER="$inherited_runner"
      e2e_validate_run_id "$RUN_ID" || return 64
      # The child may consume only the exact still-leased parent run. A run id,
      # directory, or stage-prefix ledger alone is forgeable and authorizes no
      # provider call or retained receipt.
      ARTIFACT_DIRECTORY=""
      ci_artifact_capability_is_current || return 64
      REVISION="$(git -C "$repository_root" rev-parse HEAD 2>/dev/null)" || return 65
      [[ "$REVISION" =~ ^[0-9a-f]{40}$ ]] || return 65
      validate_runner_context || return $?
      assert_revision_unchanged || return $?
      case "$action" in
        __worker_deploy)
          require_stage_prefix "root-gate,smoke-agent,smoke-gallery" || return $?
          worker_deploy
          ;;
        __worker_readiness)
          require_stage_prefix "root-gate,smoke-agent,smoke-gallery,worker-deploy" || return $?
          worker_readiness
          ;;
        __web_deploy)
          require_stage_prefix "root-gate,smoke-agent,smoke-gallery,worker-deploy,worker-readiness" || return $?
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
  if [[ "${CI:-}" == "true" || "${WORKERS_CI:-0}" == "1" ]]; then
    printf 'ci-pipeline: process-test mode is forbidden under hosted CI markers\n' >&2
    exit 78
  fi
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
  e2e_select_artifact_claim_at_root "$repository_root" "$RUN_ID" || exit 64
  ARTIFACT_DIRECTORY="$ASIMPOSIUM_E2E_SELECTED_RUN_DIRECTORY"
  ASIMP_CI_INTERNAL_ARTIFACT_ROOT_IDENTITY="$ASIMPOSIUM_E2E_SELECTED_ARTIFACT_ROOT_IDENTITY"
  ASIMP_CI_INTERNAL_RUN_IDENTITY="$ASIMPOSIUM_E2E_SELECTED_RUN_IDENTITY"
  ASIMP_CI_INTERNAL_LEASE_DIRECTORY="$ASIMPOSIUM_E2E_SELECTED_LEASE_DIRECTORY"
  ASIMP_CI_INTERNAL_LEASE_IDENTITY="$ASIMPOSIUM_E2E_SELECTED_LEASE_IDENTITY"
  ci_artifact_capability_is_current || exit 64
fi
if [[ "$PIPELINE_TEST_MODE" != "1" ]]; then
  ci_artifact_capability_is_current || exit 64
fi
mkdir "$ARTIFACT_DIRECTORY/curl-home" || exit 64
if [[ "$PIPELINE_TEST_MODE" != "1" ]]; then
  ci_artifact_capability_is_current || exit 64
fi
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
