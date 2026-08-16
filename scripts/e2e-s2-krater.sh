#!/usr/bin/env bash
# Local real-D1 + Durable Object S-2 harness. This never contacts a remote
# Cloudflare resource. Its unique persistence directory is intentionally
# retained: cleanup terminates only child workerd processes, never files.
# Successful local DO proof is reported green; deployed DO and edge-load proof
# remain external blockers and cause the final exit 78.

set -euo pipefail

readonly S2_WRANGLER="apps/wire/node_modules/.bin/wrangler"
readonly S2_WRANGLER_CONFIG="apps/wire/src/krater/wrangler.s2.toml"
# The legacy fixture stack: an exact pre-integrity 0001 schema and nothing else.
# Its own `migrations_dir` is what makes "old database" mean the schema that
# actually shipped, rather than the current one with columns hidden.
readonly S2_LEGACY_CONFIG="apps/wire/src/krater/wrangler.s2-legacy.toml"
readonly S2_UPGRADE_CONFIG="apps/wire/src/krater/wrangler.s2-upgrade.toml"
readonly S2_LEGACY_EXISTING_FIXTURE="apps/wire/src/krater/fixtures/legacy-existing-event.sql"
readonly S2_FORWARD_MIGRATION="db/migrations/0004_krater_integrity_v1.sql"
# Applied as a second, separate step so the legacy lane observes the database at exactly 0004
# and then at exactly 0005. Folding both into one apply would prove neither: the phase run
# between them is what establishes that the index is absent before 0005 and chosen after it.
readonly S2_INDEX_MIGRATION="db/migrations/0005_krater_undigested_index.sql"
readonly S2_BIND_IP="127.0.0.1"
readonly S2_READY_DEADLINE_SECONDS=15
# Bash internally backs off fork(EAGAIN) for roughly 1+2+4+8 seconds before an
# asynchronous child launch returns control. Watchdog publication therefore
# needs a distinct envelope that cannot race that mandatory runtime retry.
readonly S2_WATCHDOG_PUBLICATION_DEADLINE_SECONDS=25
readonly S2_SUPERVISOR_GATE_MISMATCH_STATUS=65
readonly S2_SUPERVISOR_STARTUP_CREATE_STATUS=73
readonly S2_SUPERVISOR_CHECKPOINT_IO_STATUS=74
readonly S2_PHASE_DEADLINE_SECONDS=75
readonly S2_TERMINATE_WAIT_TICKS=20
# A pre-release abort is consumed by the already-open private FIFO, never by a
# numeric controller-side signal. This envelope dominates Bash's roughly
# 15-second async-fork retry plus the 16-second causal delay plant.
readonly S2_PRE_RELEASE_ABORT_WAIT_TICKS=400
readonly S2_LEGACY_STOP_INSPECTION_TICKS=10
# The legacy controller gets a one-second bounded window to observe the exact
# watchdog after TERM removes the leader. The watchdog must remain available
# materially longer than that observer window or scheduler delay can retire the
# only residual-group authority just before the controller inspects it. Fifty
# 100ms uncertainty ticks still self-retire the orphan in about five seconds.
readonly S2_WATCHDOG_MAX_UNCERTAIN_TICKS=50
readonly S2_MAX_RETAINED_BYTES=67108864
readonly S2_MAX_RETAINED_FILES=1024
readonly S2_EVIDENCE_ROOT="e2e/artifacts/s2-krater"
readonly S2_COST_RECEIPT_RELATIVE_PATH="s2-cost-input.json"
readonly S2_COST_MANIFEST_RELATIVE_PATH="manifest.json"
readonly S2_COST_PUBLICATION_RELATIVE_PATH="s2-cost-publication.json"
readonly S2_COST_PUBLICATION_COMMIT_RELATIVE_PATH="s2-cost-publication-commit.json"
# A parallel child runs the full local D1 suite, including two real migration-journal lanes.
# Keep the test bounded, but allow its documented work rather than converting a healthy child
# into a synthetic TERM result before the journal is finished.
# The outer lifecycle test can deliberately lower this only for its bounded
# timeout regression. Production/default runs retain the documented 300s cap.
S2_LIFECYCLE_DEADLINE_SECONDS="${S2_LIFECYCLE_DEADLINE_SECONDS:-300}"
if ! [[ "${S2_LIFECYCLE_DEADLINE_SECONDS}" =~ ^[1-9][0-9]*$ ]]; then
  printf '%s\n' '{"tool":"bash","package":"apps/wire","suite":"s2-krater-lifecycle","status":"fail","code":"S2_LIFECYCLE_DEADLINE_INVALID","reproduce":"scripts/e2e-s2-krater.sh"}'
  exit 1
fi
readonly S2_LIFECYCLE_DEADLINE_SECONDS
readonly -a S2_SOURCE_PATHS=(
  apps/wire/src/krater/krater.ts
  apps/wire/src/krater/worker.ts
  apps/wire/src/krater/outbox-do.ts
  apps/wire/src/krater/s2-client.ts
  apps/wire/src/krater/worker.test.ts
  apps/wire/test/unit/s2-krater-harness.test.ts
  apps/wire/test/integration/s2-krater-real-bindings.test.ts
  apps/wire/src/krater/wrangler.s2.toml
  apps/wire/src/krater/wrangler.s2-legacy.toml
  apps/wire/src/krater/wrangler.s2-upgrade.toml
  apps/wire/src/krater/fixtures/legacy-existing-event.sql
  apps/wire/src/krater/fixtures/legacy-migrations/0001_krater_v0.sql
  db/migrations/0001_krater_v0.sql
  db/migrations/0002_enrollment_g0.sql
  db/migrations/0003_auth_nonce_replay.sql
  db/migrations/0004_krater_integrity_v1.sql
  db/migrations/0005_krater_undigested_index.sql
  db/migrations/0006_fellow_credential_lifecycle.sql
  db/migrations/0007_outbox_quarantine_state.sql
  db/migrations/0008_sponsors_bootstrap.sql
  db/migrations/0009_device_flow.sql
  db/migrations/0010_device_flow_hardening.sql
  db/migrations/0011_fellow_credential_hardening.sql
  scripts/verify-cost-model.ts
  scripts/verify-cost-model.test.ts
  packages/contracts/src/artifacts.ts
  packages/contracts/src/s2-cost-receipt.ts
  packages/contracts/test/unit/schema.test.ts
  packages/contracts/generated/s2-cost-receipt.schema.json
  packages/contracts/generated/s2-cost-receipt.types.ts
  scripts/e2e-s2-krater.sh
)
readonly -a S2_EXPECTED_MIGRATION_JOURNAL=(
  0001_krater_v0.sql
  0002_enrollment_g0.sql
  0003_auth_nonce_replay.sql
  0004_krater_integrity_v1.sql
  0005_krater_undigested_index.sql
  0006_fellow_credential_lifecycle.sql
  0007_outbox_quarantine_state.sql
  0008_sponsors_bootstrap.sql
  0009_device_flow.sql
  0010_device_flow_hardening.sql
  0011_fellow_credential_hardening.sql
)

random_hex() {
  local bytes="$1" value
  value="$(LC_ALL=C od -An -N "${bytes}" -tx1 /dev/urandom | tr -d '[:space:]')" || return 1
  [[ "${value}" =~ ^[a-f0-9]+$ && ${#value} -eq $((bytes * 2)) ]] || return 1
  printf '%s\n' "${value}"
}

# A caller-provided main port must belong to this run. Otherwise a listener
# from an interrupted run can satisfy readiness while this Wrangler process
# failed to bind. This is deliberately a TCP check rather than HTTP: before
# this run owns the listener, an arbitrary HTTP response is not meaningful.
port_is_busy() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && exec 3<&- && return 0
  return 1
}

choose_available_port() {
  local candidate offset
  for offset in {0..79}; do
    candidate=$((8700 + (($$ + offset) % 1100)))
    if ! port_is_busy "${candidate}"; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done
  return 1
}

if [[ -n "${S2_PORT:-}" ]]; then
  if [[ ! "${S2_PORT}" =~ ^[0-9]{2,5}$ ]] || (( S2_PORT < 1024 || S2_PORT > 65535 )); then
    printf '%s\n' '{"tool":"bash","package":"apps/wire","suite":"s2-krater-local-do","status":"fail","code":"S2_PORT_INVALID","reproduce":"scripts/e2e-s2-krater.sh"}'
    exit 1
  fi
else
  if ! S2_PORT="$(choose_available_port)"; then
    printf '%s\n' '{"tool":"bash","package":"apps/wire","suite":"s2-krater-local-do","status":"fail","code":"S2_PORT_UNAVAILABLE","reproduce":"scripts/e2e-s2-krater.sh"}'
    exit 1
  fi
fi
if port_is_busy "${S2_PORT}"; then
  printf '%s\n' '{"tool":"bash","package":"apps/wire","suite":"s2-krater-local-do","status":"fail","code":"S2_PORT_OCCUPIED","reproduce":"scripts/e2e-s2-krater.sh"}'
  exit 1
fi
readonly S2_PORT
S2_GIT_HEAD="$(git rev-parse HEAD)"
readonly S2_GIT_HEAD
if [[ -n "$(git status --porcelain=v1 --untracked-files=all -- "${S2_SOURCE_PATHS[@]}")" ]]; then
  readonly S2_GIT_DIRTY="dirty"
else
  readonly S2_GIT_DIRTY="clean"
fi
S2_SOURCE_DIGEST="$(shasum -a 256 "${S2_SOURCE_PATHS[@]}" | shasum -a 256 | awk '{print $1}')"
readonly S2_SOURCE_DIGEST
if [[ ! -d e2e || -L e2e ]]; then
  printf '%s\n' '{"tool":"bash","package":"apps/wire","suite":"s2-krater-evidence","status":"fail","code":"S2_EVIDENCE_PARENT_INVALID","reproduce":"scripts/e2e-s2-krater.sh"}'
  exit 1
fi
for evidence_dir in e2e/artifacts "${S2_EVIDENCE_ROOT}"; do
  if [[ -e "${evidence_dir}" || -L "${evidence_dir}" ]]; then
    if [[ ! -d "${evidence_dir}" || -L "${evidence_dir}" ]]; then
      printf '%s\n' '{"tool":"bash","package":"apps/wire","suite":"s2-krater-evidence","status":"fail","code":"S2_EVIDENCE_ROOT_INVALID","reproduce":"scripts/e2e-s2-krater.sh"}'
      exit 1
    fi
  elif ! mkdir "${evidence_dir}" 2>/dev/null; then
    # Another isolated run may have won the same parent-directory creation race. Accept only the
    # exact safe postcondition; a symlink or non-directory still fails closed.
    if [[ ! -d "${evidence_dir}" || -L "${evidence_dir}" ]]; then
      printf '%s\n' '{"tool":"bash","package":"apps/wire","suite":"s2-krater-evidence","status":"fail","code":"S2_EVIDENCE_ROOT_CREATE_FAILED","reproduce":"scripts/e2e-s2-krater.sh"}'
      exit 1
    fi
  fi
done
# Callers may provide a stable evidence handle, but it remains a path component rather than an
# opaque pathname.  An absent handle gets a collision-resistant generated one; an empty or
# malformed explicit handle is refused before it can select an artifact directory.
if [[ "${S2_RUN_ID+x}" != x ]]; then
  S2_RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(random_hex 8)"
fi
if [[ ! "${S2_RUN_ID}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$ ]]; then
  printf '%s\n' '{"tool":"bash","package":"apps/wire","suite":"s2-krater-evidence","status":"fail","code":"S2_EVIDENCE_RUN_ID_INVALID","reproduce":"scripts/e2e-s2-krater.sh"}'
  exit 1
fi
# A caller-supplied handle arrives exported, unlike the generated branch above.
# Recursive lifecycle children need their own evidence roots; sharing this one
# makes them collide with the parent's already-created main directory. Remove
# only the export attribute. Deliberate shared-handle handoffs pass S2_RUN_ID
# explicitly at the exact child invocation that consumes it.
export -n S2_RUN_ID
readonly S2_RUN_ID
readonly S2_RUN_DIR="${S2_EVIDENCE_ROOT}/${S2_RUN_ID}"
if ! mkdir "${S2_RUN_DIR}" || ! mkdir "${S2_RUN_DIR}/main"; then
  printf '%s\n' '{"tool":"bash","package":"apps/wire","suite":"s2-krater-evidence","status":"fail","code":"S2_EVIDENCE_RUN_CREATE_FAILED","reproduce":"scripts/e2e-s2-krater.sh"}'
  exit 1
fi
readonly S2_COST_RECEIPT_PATH="${S2_RUN_DIR}/${S2_COST_RECEIPT_RELATIVE_PATH}"
readonly S2_COST_MANIFEST_PATH="${S2_RUN_DIR}/${S2_COST_MANIFEST_RELATIVE_PATH}"
readonly S2_COST_PUBLICATION_PATH="${S2_RUN_DIR}/${S2_COST_PUBLICATION_RELATIVE_PATH}"
readonly S2_COST_PUBLICATION_COMMIT_PATH="${S2_RUN_DIR}/${S2_COST_PUBLICATION_COMMIT_RELATIVE_PATH}"
S2_STATE_DIR="${S2_RUN_DIR}/main"
readonly S2_STATE_DIR
readonly S2_SERVER_LOG="${S2_STATE_DIR}/wrangler.log"
readonly S2_ORIGIN="http://127.0.0.1:${S2_PORT}"
S2_SERVER_PID=""
S2_SERVER_PGID=""
S2_SERVER_MARKER=""
S2_SERVER_WATCHDOG_PID=""
S2_SERVER_WATCHDOG_HEALTH=""
S2_SERVER_PERSIST=""
S2_SERVER_PORT=""
S2_ACTIVE_HARNESS_TOKEN=""
S2_ACTIVE_HARNESS_RUN_ID=""
S2_COST_PHASE_EXERCISE="not-run"
S2_COST_PHASE_RESTART_VERIFY="not-run"
S2_COST_PHASE_UPGRADE_EXISTING="not-run"
S2_COST_PHASE_UPGRADE_EMPTY="not-run"
S2_COST_PHASE_UPGRADE_JOURNAL_EXISTING="not-run"
S2_COST_PHASE_UPGRADE_JOURNAL_EMPTY="not-run"
S2_COST_LOCAL_PHASES_COMPLETE=0
S2_LIFECYCLE_CHILD_PID=""
S2_LIFECYCLE_CHILD_PGID=""
S2_LIFECYCLE_CHILD_MARKER=""
S2_LIFECYCLE_CHILD_STATUS_FILE=""
S2_LIFECYCLE_CHILD_WATCHDOG_PID=""
S2_LIFECYCLE_CHILD_WATCHDOG_HEALTH=""
declare -a S2_LIFECYCLE_OWNED_PIDS=()
declare -a S2_LIFECYCLE_OWNED_PGIDS=()
declare -a S2_LIFECYCLE_OWNED_MARKERS=()
declare -a S2_LIFECYCLE_OWNED_STATUS_FILES=()
declare -a S2_LIFECYCLE_OWNED_WATCHDOG_PIDS=()
declare -a S2_LIFECYCLE_OWNED_WATCHDOG_HEALTH_FILES=()
declare -a S2_LIFECYCLE_OWNED_STATE_DIRS=()
declare -a S2_LIFECYCLE_OWNED_PORTS=()
# The origin the next phase talks to. The legacy upgrade stages run their own
# Worker on their own owned port, so a phase must never assume the main one.
S2_ACTIVE_ORIGIN="${S2_ORIGIN}"
# Legacy state directories are retained like every other: cleanup terminates
# processes, never files, so an upgrade failure keeps the database that caused it.
declare -a S2_LEGACY_STATE_DIRS=()

# Passed as data to the nested Bash process so the outer single-quoted supervisor program never
# has to nest shell quotes. This program contains no authority beyond its pinned process group:
# inspection uncertainty is published and retried, and only an exact leader proof permits a
# group signal after controller loss.
# shellcheck disable=SC2089,SC2016
readonly S2_WATCHDOG_PROGRAM='
supervisor_pid="$1"
owner_pid="$2"
marker="$3"
health_file="$4"
plant_uncertainty="$5"
max_uncertain_ticks="$6"
exit_on_term="$7"
plant_ps_hang="$8"
scan_hang_armed="$9"
watchdog_pid="$$"
last_health=""
uncertain_ticks=0
force_uncertainty=0
[[ "${max_uncertain_ticks}" =~ ^[1-9][0-9]*$ ]] || exit 125
[[ "${exit_on_term}" =~ ^[01]$ ]] || exit 125
[[ "${plant_ps_hang}" =~ ^[01]$ ]] || exit 125
trap "exit 0" USR1
if [[ "${plant_uncertainty}" == 1 ]]; then
  # Regression-only handshake. The controller first proves this exact
  # watchdog healthy, then sends USR2 to enter the uncertainty path. A timed
  # transition here would make the pre-release proof race the scheduler.
  trap "force_uncertainty=1" USR2
fi
if [[ "${exit_on_term}" == 1 ]]; then
  # Regression-only: expose the leader-plus-TERM-resistant-payload interleaving.
  # Normal watchdogs ignore group TERM until the leader dismisses them with USR1.
  trap "exit 0" TERM HUP INT
else
  trap : TERM HUP INT
fi
publish_health() {
  [[ "$1" == "${last_health}" ]] && return 0
  printf "%s %s\n" "$1" "${watchdog_pid}" >>"${health_file}" || exit 125
  last_health="$1"
}
snapshot_supervisor() {
  local line seen_pid seen_pgid seen_ppid seen_stat seen_command
  if [[ "${plant_ps_hang}" == 1 ]]; then
    # The marker is created by the same process that owns the alarm, after the
    # deadline is armed and immediately before exec. A controller cannot use
    # this fixture to signal the watchdog before the bounded scan is causal.
    line="$(LC_ALL=C perl -MFcntl=:DEFAULT -e '\''
      $SIG{ALRM}="DEFAULT";
      alarm 1;
      my ($marker_path, $expected_pid, @command) = @ARGV;
      umask 0077;
      sysopen(my $marker_file, $marker_path, O_WRONLY | O_CREAT | O_EXCL, 0600) or exit 125;
      print {$marker_file} "scan-hang-armed $expected_pid\n" or exit 125;
      close($marker_file) or exit 125;
      exec @command;
      exit 125;
    '\'' -- "${scan_hang_armed}" "${watchdog_pid}" perl -e '\''sleep 30'\'' 2>/dev/null)" || return 1
  else
    # The inherited alarm survives exec and bounds a kernel-stalled ps. Bash
    # can therefore service its pending USR1 dismissal trap within one second.
    line="$(LC_ALL=C perl -e '\''$SIG{ALRM}="DEFAULT"; alarm 1; exec @ARGV; exit 125'\'' -- \
      ps -o pid=,pgid=,ppid=,stat=,command= -p "${supervisor_pid}" 2>/dev/null)" || return 1
  fi
  [[ -n "${line}" ]] || return 1
  read -r seen_pid seen_pgid seen_ppid seen_stat seen_command <<<"${line}"
  [[ "${seen_pid}" =~ ^[0-9]+$ && "${seen_pgid}" =~ ^[0-9]+$ && "${seen_ppid}" =~ ^[0-9]+$ ]] || return 1
  [[ "${seen_pid}" == "${supervisor_pid}" && "${seen_pgid}" == "${supervisor_pid}" ]] || return 1
  [[ "${seen_command}" == *"s2-pinned-supervisor-${marker}"* ]] || return 1
  kill -0 "${supervisor_pid}" 2>/dev/null && kill -0 -- "-${supervisor_pid}" 2>/dev/null || return 1
  owner_ppid="${seen_ppid}"
}
terminate_after_owner_loss() {
  local proved_ticks=0
  # The caller just observed this exact supervisor with a changed controller parent. Publish the
  # controller-loss transition before TERM, because TERM can legitimately remove the leader
  # before the next process-table inspection.
  publish_health owner-lost
  kill -TERM -- "-${supervisor_pid}" 2>/dev/null || return 0
  while (( proved_ticks < 20 )); do
    kill -0 -- "-${supervisor_pid}" 2>/dev/null || return 0
    if snapshot_supervisor; then
      proved_ticks=$((proved_ticks + 1))
    else
      # A TERM-resistant member can keep the group alive after TERM removes its leader. Do not
      # let that make this owner-loss branch immortal: the same bounded uncertainty accounting as
      # the main watchdog loop publishes fail-closed state and self-retires without a PID fallback.
      record_uncertainty
    fi
    sleep 0.1
  done
  snapshot_supervisor || return 1
  publish_health owner-lost
  kill -KILL -- "-${supervisor_pid}" 2>/dev/null || :
}
record_uncertainty() {
  uncertain_ticks=$((uncertain_ticks + 1))
  publish_health inspection-uncertain
  # When the leader has exited or process inspection remains unusable, this watcher no longer
  # has authority to signal a group. It must self-retire rather than become an immortal orphan.
  if (( uncertain_ticks >= max_uncertain_ticks )); then
    publish_health inspection-timeout
    exit 125
  fi
}
while :; do
  if [[ "${force_uncertainty}" == 1 ]]; then
    record_uncertainty
  elif snapshot_supervisor; then
    uncertain_ticks=0
    publish_health healthy
    if [[ "${owner_ppid}" != "${owner_pid}" ]]; then
      terminate_after_owner_loss && exit 0
    fi
  else
    record_uncertainty
  fi
  sleep 0.2
done
'
# shellcheck disable=SC2090
export S2_WATCHDOG_PROGRAM

emit() {
  printf '%s\n' "$1"
}

json_decimal_or_null() {
  if is_decimal "$1"; then
    printf '%s' "$1"
  else
    printf 'null'
  fi
}

json_bool() {
  if [[ "$1" == true ]]; then
    printf 'true'
  else
    printf 'false'
  fi
}

emit_release_race_failure() {
  local code="$1" group_survives=false leader_is_exact=false marker_present=false
  if is_decimal "${S2_PLANTED_RELEASE_PGID}" && \
    kill -0 -- "-${S2_PLANTED_RELEASE_PGID}" 2>/dev/null; then
    group_survives=true
  fi
  if [[ -n "${S2_PLANTED_RELEASE_PID}" && \
    "${S2_PLANTED_RELEASE_PID}" == "${S2_PLANTED_RELEASE_PGID}" ]]; then
    leader_is_exact=true
  fi
  [[ -n "${S2_PLANTED_RELEASE_MARKER}" ]] && marker_present=true
  emit "{\"tool\":\"bash\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-shell\",\"status\":\"fail\",\"terminal\":true,\"scenario\":\"release-race\",\"code\":\"${code}\",\"planted_release_pid\":$(json_decimal_or_null "${S2_PLANTED_RELEASE_PID}"),\"planted_release_pgid\":$(json_decimal_or_null "${S2_PLANTED_RELEASE_PGID}"),\"planted_release_is_group_leader\":$(json_bool "${leader_is_exact}"),\"planted_release_marker_present\":$(json_bool "${marker_present}"),\"exact_group_survives\":$(json_bool "${group_survives}"),\"reproduce\":\"S2_SHELL_REGRESSION_TEST=release-race scripts/e2e-s2-krater.sh\"}"
}

emit_owner_loss_uncertain_failure() {
  local code="$1" group_survives=false watchdog_survives=false
  local record_available=false health_file_available=false
  if is_decimal "${supervisor_pgid:-}" && \
    kill -0 -- "-${supervisor_pgid}" 2>/dev/null; then
    group_survives=true
  fi
  if is_decimal "${supervisor_watchdog_pid:-}" && \
    kill -0 "${supervisor_watchdog_pid}" 2>/dev/null; then
    watchdog_survives=true
  fi
  if [[ -n "${parent_loss_record:-}" && -f "${parent_loss_record}" && \
    ! -L "${parent_loss_record}" ]]; then
    record_available=true
  fi
  if [[ -n "${supervisor_watchdog_health:-}" && -f "${supervisor_watchdog_health}" && \
    ! -L "${supervisor_watchdog_health}" ]]; then
    health_file_available=true
  fi
  emit "{\"tool\":\"bash\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-shell\",\"status\":\"fail\",\"terminal\":true,\"scenario\":\"owner-loss-uncertain\",\"code\":\"${code}\",\"child_exit_code\":$(json_decimal_or_null "${parent_loss_status:-}"),\"record_available\":$(json_bool "${record_available}"),\"health_file_available\":$(json_bool "${health_file_available}"),\"exact_group_survives\":$(json_bool "${group_survives}"),\"watchdog_survives\":$(json_bool "${watchdog_survives}"),\"reproduce\":\"S2_SHELL_REGRESSION_TEST=owner-loss-uncertain scripts/e2e-s2-krater.sh\"}"
}

emit_persistent_pre_release_helper_failure() {
  local code="$1" payload_started="$2" group_survives=false exact_reap_recorded=false
  local most_recent_supervisor_empty=false planted_helper_survives=false
  if is_decimal "${S2_LAST_SUPERVISOR_PGID}" && \
    kill -0 -- "-${S2_LAST_SUPERVISOR_PGID}" 2>/dev/null; then
    group_survives=true
  fi
  if [[ -n "${S2_PRE_RELEASE_REAPED_PGID}" && \
    "${S2_PRE_RELEASE_REAPED_PGID}" == "${S2_LAST_SUPERVISOR_PGID}" ]]; then
    exact_reap_recorded=true
  fi
  [[ -z "${S2_MOST_RECENT_SUPERVISOR}" ]] && most_recent_supervisor_empty=true
  if is_decimal "${S2_PRE_RELEASE_EXPECTED_HELPER_PID}" && \
    kill -0 "${S2_PRE_RELEASE_EXPECTED_HELPER_PID}" 2>/dev/null; then
    planted_helper_survives=true
  fi
  emit "{\"tool\":\"bash\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-shell\",\"status\":\"fail\",\"terminal\":true,\"scenario\":\"persistent-pre-release-helper\",\"code\":\"${code}\",\"pre_release_resample_attempts\":$(json_decimal_or_null "${S2_PRE_RELEASE_RESAMPLE_ATTEMPTS}"),\"pre_release_accepted_samples\":$(json_decimal_or_null "${S2_PRE_RELEASE_ACCEPTED_SAMPLES}"),\"pre_release_rejected_samples\":$(json_decimal_or_null "${S2_PRE_RELEASE_REJECTED_SAMPLES}"),\"pre_release_max_group_members\":$(json_decimal_or_null "${S2_PRE_RELEASE_MAX_GROUP_MEMBER_COUNT}"),\"planted_persistent_helper_pid\":$(json_decimal_or_null "${S2_PRE_RELEASE_EXPECTED_HELPER_PID}"),\"planted_persistent_helper_rejected_samples\":$(json_decimal_or_null "${S2_PRE_RELEASE_EXPECTED_HELPER_REJECTED_SAMPLES}"),\"planted_persistent_helper_survives\":$(json_bool "${planted_helper_survives}"),\"payload_started\":$(json_bool "${payload_started}"),\"exact_pinned_group_reap_recorded\":$(json_bool "${exact_reap_recorded}"),\"most_recent_supervisor_empty\":$(json_bool "${most_recent_supervisor_empty}"),\"exact_group_survives\":$(json_bool "${group_survives}"),\"reproduce\":\"S2_SHELL_REGRESSION_TEST=persistent-pre-release-helper scripts/e2e-s2-krater.sh\"}"
}

redacted_wrangler_cause() {
  local log_path="${1:-${S2_SERVER_LOG}}"
  # shellcheck disable=SC2016
  S2_LOG_PATH="${log_path}" bun --eval '
    const file = Bun.file(process.env.S2_LOG_PATH ?? "");
    const text = await file.text().catch(() => "wrangler log unavailable");
    const redacted = text
      .replace(/(?:[A-Za-z]+:)?\/(?:Users|var|tmp)\/[^\s"'\''`]+/g, "<path>")
      .replace(
        /(["\x27]?(?:authorization|proxy-authorization)["\x27]?\s*:\s*["\x27]?)(?:bearer|basic|token)\s+[^"\x27,;}\s]+/gi,
        "$1<redacted>",
      )
      .replace(
        /(["\x27]?(?:access[_-]?token|token|secret|password|authorization|signature|sig|fragment|credential|api[_-]?key)["\x27]?\s*[:=]\s*)(?:"[^"]*"|\x27[^\x27]*\x27|[^\s,;}\]]+)/gi,
        "$1<redacted>",
      )
      .replace(/\b(bearer|basic|token)\s+[A-Za-z0-9._~+\/-]{12,}/gi, "$1 <redacted>")
      .replace(/(#(?:v[0-9]+\.)?)[A-Za-z0-9_-]{16,}/g, "$1<redacted>")
      .replace(/\b(fragment|signature|token|secret)\s+['\'']?[A-Za-z0-9._~+\/-]{12,}/gi, "$1 <redacted>")
      .replace(/[^\x20-\x7E]+/g, " ")
      .slice(-2_000);
    console.log(JSON.stringify(redacted));
  '
}

emit_wrangler_failure() {
  local code="$1"
  local cause
  cause="$(redacted_wrangler_cause)"
  emit "{\"tool\":\"wrangler\",\"tool_version\":\"${S2_WRANGLER_VERSION}\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-local-do\",\"status\":\"fail\",\"code\":\"${code}\",\"cause\":${cause},\"reproduce\":\"scripts/e2e-s2-krater.sh\"}"
}

if [[ ! -x "${S2_WRANGLER}" ]]; then
  emit '{"tool":"wrangler","package":"apps/wire","suite":"s2-krater-local-d1","status":"fail","code":"WRANGLER_UNAVAILABLE","reproduce":"scripts/e2e-s2-krater.sh"}'
  exit 1
fi
S2_WRANGLER_VERSION="$("${S2_WRANGLER}" --version)"
readonly S2_WRANGLER_VERSION

if [[ ! -d "${S2_STATE_DIR}" || -L "${S2_STATE_DIR}" ]]; then
  emit '{"tool":"wrangler","package":"apps/wire","suite":"s2-krater-local-d1","status":"fail","code":"LOCAL_PERSIST_DIR_INVALID","reproduce":"scripts/e2e-s2-krater.sh"}'
  exit 1
fi

S2_PARENT_PID="$$"
S2_STARTED_PID=""
S2_STARTED_PGID=""
S2_STARTED_MARKER=""
S2_STARTED_STATUS_FILE=""
S2_STARTED_WATCHDOG_PID=""
S2_STARTED_WATCHDOG_HEALTH=""
S2_CHILD_STATUS=""
S2_GROUP_MEMBER_COUNT=0
declare -a S2_GROUP_MEMBER_PIDS=()
S2_PLANTED_RELEASE_PID=""
S2_PLANTED_RELEASE_PGID=""
S2_PLANTED_RELEASE_MARKER=""
S2_LAST_SUPERVISOR_PGID=""
S2_LAST_SUPERVISOR_MARKER=""
S2_START_FAILURE_STAGE=""
S2_START_SUPERVISOR_EXIT_STATUS=""
S2_STARTUP_JOURNAL_PHASE=""
S2_STARTUP_JOURNAL_ARM_ACK=0
S2_PRE_RELEASE_RESAMPLE_ATTEMPTS=0
S2_PRE_RELEASE_ACCEPTED_SAMPLES=0
S2_PRE_RELEASE_REJECTED_SAMPLES=0
S2_PRE_RELEASE_CAPTURE_UNCERTAIN_SAMPLES=0
S2_POST_ARM_INSPECTION_UNCERTAIN_SAMPLES=0
S2_PRE_RELEASE_MAX_GROUP_MEMBER_COUNT=0
S2_PRE_RELEASE_REAPED_PGID=""
S2_PRE_RELEASE_EXPECTED_HELPER_PID=""
S2_PRE_RELEASE_EXPECTED_HELPER_REJECTED_SAMPLES=0
S2_DETACHED_PROCESS_TABLE=""
S2_DETACHED_SCAN_PHASE=""
# This packed record is published before any release write. It closes the caller-assignment
# gap: an EXIT trap can still prove and release the exact newest supervisor while a caller is
# between start_pinned_supervisor and its Worker/lifecycle bookkeeping. Fields are PID, PGID,
# expected PPID, marker, watchdog PID, watchdog health path, persistence directory, port, and
# proof scope. Every path is generated beneath the safe S2 run directory and contains no space.
S2_MOST_RECENT_SUPERVISOR=""

is_decimal() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

# A process-table scanner must leave the pinned supervisor's session before it samples it.
# Bash gives a command-substitution/process-substitution child its caller's process group, so
# this function immediately execs Perl, whose first action is `setsid()`. Only then does it exec
# `ps`; the scanner is therefore never counted as a member of the group it observes.
detached_process_table_read() {
  [[ "${S2_PLANT_DETACHED_PS_FAILURE:-0}" == "1" ]] && return 97
  if [[ "${S2_PLANT_DETACHED_PS_FAILURE_ONCE:-0}" == "1" ]]; then
    local one_shot_marker="${S2_STATE_DIR}/.detached-ps-failure-once"
    local one_shot_stage="${S2_PLANT_DETACHED_PS_FAILURE_ONCE_STAGE:-pre-arm}"
    local one_shot_stage_matches=0
    case "${one_shot_stage}" in
      pre-arm)
        [[ "${S2_START_FAILURE_STAGE}" == "pre-arm-ownership" ]] && \
          one_shot_stage_matches=1
        ;;
      post-arm)
        [[ "${S2_START_FAILURE_STAGE}" == "watchdog-publication" && \
          "${S2_DETACHED_SCAN_PHASE}" == "watchdog" ]] && \
          one_shot_stage_matches=1
        ;;
      *) return 98 ;;
    esac
    if [[ ${one_shot_stage_matches} -eq 1 ]]; then
      if (set -o noclobber; : >"${one_shot_marker}") 2>/dev/null; then
        return 97
      fi
      [[ -f "${one_shot_marker}" && ! -L "${one_shot_marker}" ]] || return 98
    fi
  fi
  command -v perl >/dev/null 2>&1 || return 1
  LC_ALL=C exec perl -MPOSIX=setsid -e 'setsid() or exit 125; exec @ARGV' -- ps "$@"
}

# Capture both bytes and exit status. A bare process substitution hides its producer's status,
# which could accept a partial `ps` result after the scanner itself failed. Command substitution
# is safe here because the child immediately execs the same detached scanner; it never joins the
# separately-created supervisor session.
capture_detached_process_table() {
  local output
  S2_DETACHED_PROCESS_TABLE=""
  output="$(detached_process_table_read "$@")" || return 1
  S2_DETACHED_PROCESS_TABLE="${output}"
}

# Read exactly one detached process-table row. Scanner failure, no row, or multiple rows is
# unsafe for an ownership proof and fails closed.
read_detached_process_snapshot() {
  local line rows=0
  S2_DETACHED_PROCESS_SNAPSHOT=""
  capture_detached_process_table "$@" || return 1
  while IFS= read -r line; do
    [[ -n "${line}" ]] || continue
    rows=$((rows + 1))
    [[ ${rows} -eq 1 ]] || return 1
    S2_DETACHED_PROCESS_SNAPSHOT="${line}"
  done <<<"${S2_DETACHED_PROCESS_TABLE}"
  [[ ${rows} -eq 1 ]]
}

# Inspect the direct supervisor without printing its command line: it contains the per-run
# correlation token while Wrangler is starting. That token is visible to same-UID process
# inspection and is not claimed as a secrecy boundary. A missing or malformed process-table
# record is unsafe, never interpreted as an empty process group.
supervisor_snapshot() {
  local pid="$1" pgid="$2" marker="$3" line
  line="$(LC_ALL=C ps -o pid=,pgid=,ppid=,stat=,command= -p "${pid}" 2>/dev/null)" || return 1
  [[ -n "${line}" ]] || return 1
  read -r S2_PS_PID S2_PS_PGID S2_PS_PPID S2_PS_STAT S2_PS_COMMAND <<<"${line}"
  is_decimal "${S2_PS_PID}" && is_decimal "${S2_PS_PGID}" && is_decimal "${S2_PS_PPID}" || return 1
  [[ "${S2_PS_PID}" == "${pid}" && "${S2_PS_PGID}" == "${pgid}" ]] || return 1
  [[ "${S2_PS_PPID}" == "${S2_PARENT_PID}" ]] || return 1
  [[ "${S2_PS_COMMAND}" == *"s2-pinned-supervisor-${marker}"* ]] || return 1
  kill -0 "${pid}" 2>/dev/null && kill -0 -- "-${pgid}" 2>/dev/null
}

supervisor_is_owned() {
  supervisor_snapshot "$1" "$2" "$3" && [[ "${S2_PS_STAT}" != T* ]]
}

watchdog_snapshot() {
  local watchdog_pid="$1" supervisor_pid="$2" pgid="$3" marker="$4" health_file="$5"
  local line health_state health_pid
  [[ -f "${health_file}" && ! -L "${health_file}" ]] || return 1
  line="$(tail -n 1 "${health_file}" 2>/dev/null)" || return 1
  read -r health_state health_pid <<<"${line}"
  [[ "${health_state}" == "healthy" && "${health_pid}" == "${watchdog_pid}" ]] || return 1
  line="$(LC_ALL=C ps -o pid=,pgid=,ppid=,stat=,command= -p "${watchdog_pid}" 2>/dev/null)" || return 1
  [[ -n "${line}" ]] || return 1
  read -r S2_WATCHDOG_PS_PID S2_WATCHDOG_PS_PGID S2_WATCHDOG_PS_PPID \
    S2_WATCHDOG_PS_STAT S2_WATCHDOG_PS_COMMAND <<<"${line}"
  is_decimal "${S2_WATCHDOG_PS_PID}" && is_decimal "${S2_WATCHDOG_PS_PGID}" && \
    is_decimal "${S2_WATCHDOG_PS_PPID}" || return 1
  [[ "${S2_WATCHDOG_PS_PID}" == "${watchdog_pid}" && \
    "${S2_WATCHDOG_PS_PGID}" == "${pgid}" && \
    "${S2_WATCHDOG_PS_PPID}" == "${supervisor_pid}" ]] || return 1
  [[ "${S2_WATCHDOG_PS_STAT}" != T* && "${S2_WATCHDOG_PS_STAT}" != Z* && \
    "${S2_WATCHDOG_PS_COMMAND}" == *"s2-parent-watchdog-${marker}"* ]] || return 1
  kill -0 "${watchdog_pid}" 2>/dev/null && kill -0 -- "-${pgid}" 2>/dev/null
}

watchdog_is_healthy() {
  watchdog_snapshot "$1" "$2" "$3" "$4" "$5"
}

# The pre-release proof must not create an observer in the very group it is
# accepting. These are deliberately separate from the ordinary lifecycle
# classifiers below: only the release gate needs a session-detached scanner.
pre_release_supervisor_is_owned() {
  local pid="$1" pgid="$2" marker="$3" line
  S2_DETACHED_SCAN_PHASE="supervisor"
  read_detached_process_snapshot -o pid=,pgid=,ppid=,stat=,command= -p "${pid}" || return 1
  line="${S2_DETACHED_PROCESS_SNAPSHOT}"
  read -r seen_pid seen_pgid seen_ppid seen_stat seen_command <<<"${line}"
  is_decimal "${seen_pid}" && is_decimal "${seen_pgid}" && is_decimal "${seen_ppid}" || return 1
  [[ "${seen_pid}" == "${pid}" && "${seen_pgid}" == "${pgid}" && \
    "${seen_ppid}" == "${S2_PARENT_PID}" && "${seen_stat}" != T* && \
    "${seen_command}" == *"s2-pinned-supervisor-${marker}"* ]] || return 1
  kill -0 "${pid}" 2>/dev/null && kill -0 -- "-${pgid}" 2>/dev/null
}

pre_release_watchdog_is_healthy() {
  local watchdog_pid="$1" supervisor_pid="$2" pgid="$3" marker="$4" health_file="$5"
  local line health_line health_state health_pid
  [[ -f "${health_file}" && ! -L "${health_file}" ]] || return 1
  line=""
  while IFS= read -r health_line; do
    line="${health_line}"
  done <"${health_file}"
  [[ -n "${line}" ]] || return 1
  read -r health_state health_pid <<<"${line}"
  [[ "${health_state}" == "healthy" && "${health_pid}" == "${watchdog_pid}" ]] || return 1
  S2_DETACHED_SCAN_PHASE="watchdog"
  read_detached_process_snapshot -o pid=,pgid=,ppid=,stat=,command= -p "${watchdog_pid}" || return 2
  line="${S2_DETACHED_PROCESS_SNAPSHOT}"
  read -r seen_pid seen_pgid seen_ppid seen_stat seen_command <<<"${line}"
  is_decimal "${seen_pid}" && is_decimal "${seen_pgid}" && is_decimal "${seen_ppid}" || return 1
  [[ "${seen_pid}" == "${watchdog_pid}" && "${seen_pgid}" == "${pgid}" && \
    "${seen_ppid}" == "${supervisor_pid}" && "${seen_stat}" != T* && \
    "${seen_stat}" != Z* && "${seen_command}" == *"s2-parent-watchdog-${marker}"* ]] || return 1
  kill -0 "${watchdog_pid}" 2>/dev/null && kill -0 -- "-${pgid}" 2>/dev/null
}

checkpoint_file_matches() {
  local file="$1" checkpoint="$2" expected_pid="$3" line extra
  [[ -f "${file}" && ! -L "${file}" ]] || return 1
  {
    IFS= read -r line || return 1
    if IFS= read -r extra; then return 1; fi
  } <"${file}"
  [[ "${line}" == "${checkpoint} ${expected_pid}" ]]
}

single_decimal_file() {
  local file="$1" line extra
  [[ -f "${file}" && ! -L "${file}" ]] || return 1
  {
    IFS= read -r line || return 1
    if IFS= read -r extra; then return 1; fi
  } <"${file}"
  is_decimal "${line}"
}

startup_journal_last_phase() {
  local file="$1" expected_pid="$2" line phase seen_pid extra state=0
  S2_STARTUP_JOURNAL_PHASE=""
  S2_STARTUP_JOURNAL_ARM_ACK=0
  [[ -f "${file}" && ! -L "${file}" ]] || return 1
  while :; do
    line=""
    if ! IFS= read -r line; then
      [[ -z "${line}" ]] || return 1
      break
    fi
    read -r phase seen_pid extra <<<"${line}"
    [[ -z "${extra:-}" && "${seen_pid}" == "${expected_pid}" ]] || return 1
    case "${state}:${phase}" in
      0:supervisor-started) state=1 ;;
      1:await-arm) state=2 ;;
      2:arm-gate-consumed) state=3 ;;
      3:arm-checkpoint-attempt) state=4 ;;
      4:arm-checkpoint-published)
        state=5
        S2_STARTUP_JOURNAL_ARM_ACK=1
        ;;
      5:launch-checkpoint-attempt) state=6 ;;
      6:launch-checkpoint-published) state=7 ;;
      7:watchdog-pid-published) state=8 ;;
      8:await-release) state=9 ;;
      9:release-gate-consumed) state=10 ;;
      2:arm-gate-mismatch|2:arm-abort-consumed|2:arm-owner-lost|\
      4:arm-checkpoint-write-failed|6:launch-checkpoint-corrupt|\
      9:release-gate-mismatch|9:release-abort-consumed|9:release-owner-lost)
        state=99
        ;;
      [1-9]:signal-term|[1-9]:signal-hup|[1-9]:signal-int|\
      10:signal-term|10:signal-hup|10:signal-int)
        state=99
        ;;
      *) return 1 ;;
    esac
    S2_STARTUP_JOURNAL_PHASE="${phase}"
  done <"${file}"
  [[ -n "${S2_STARTUP_JOURNAL_PHASE}" ]]
}

# These cleanup paths run before any release token is written. They reuse the detached proof
# rather than the ordinary lifecycle classifier, whose command substitution is intentionally
# outside the pre-release acceptance boundary.
signal_pre_release_owned_group() {
  local signal="$1" pid="$2" pgid="$3" marker="$4"
  pre_release_supervisor_is_owned "${pid}" "${pgid}" "${marker}" || return 1
  kill "-${signal}" -- "-${pgid}" 2>/dev/null
}

kill_pre_release_owned_group_to_zero() {
  local pid="$1" pgid="$2" marker="$3" persist="$4" port="$5" proof_scope="$6" tick
  signal_pre_release_owned_group KILL "${pid}" "${pgid}" "${marker}" || return 1
  for ((tick = 0; tick < S2_TERMINATE_WAIT_TICKS; tick += 1)); do
    if ! kill -0 -- "-${pgid}" 2>/dev/null; then
      wait "${pid}" 2>/dev/null || :
      if [[ "${proof_scope}" == "server" ]]; then
        assert_no_run_survivors "${persist}" "${port}" "${marker}" || return 1
      fi
      return 0
    fi
    sleep 0.1
  done
  # A first KILL can still take time to become observable while a process is in
  # kernel state. The unreaped direct child still owns PID == PGID, so retrying
  # this exact group cannot target a recycled identity. ESRCH is acceptable only
  # when a fresh kernel check proves the group already disappeared.
  if ! kill -KILL -- "-${pgid}" 2>/dev/null && kill -0 -- "-${pgid}" 2>/dev/null; then
    return 1
  fi
  for ((tick = 0; tick < S2_TERMINATE_WAIT_TICKS; tick += 1)); do
    if ! kill -0 -- "-${pgid}" 2>/dev/null; then
      if wait "${pid}" 2>/dev/null; then
        S2_START_SUPERVISOR_EXIT_STATUS=0
      else
        S2_START_SUPERVISOR_EXIT_STATUS=$?
      fi
      if [[ "${proof_scope}" == "server" ]]; then
        assert_no_run_survivors "${persist}" "${port}" "${marker}" || return 1
      fi
      S2_PRE_RELEASE_REAPED_PGID="${pgid}"
      return 0
    fi
    sleep 0.1
  done
  return 1
}

# Before release, the group leader is still a direct child blocked on its private FIFO. An abort
# token lets that exact child kill its own session without asking a failed process-table scanner to
# authorize a controller-side group signal. This is the fail-closed cleanup path for inspection
# uncertainty: no payload token is sent, and success requires the known child and group to vanish.
abort_pre_release_supervisor_to_zero() {
  local pid="$1" pgid="$2" marker="$3" abort_token="$4" persist="$5" port="$6" proof_scope="$7" tick
  # Bash may asynchronously reap a background child and cache its status before
  # an explicit `wait`, so neither the numeric PID nor PGID is durable signal
  # authority here. Write only to the already-open private FIFO. The child
  # recognizes the unguessable abort token at either gate and kills its own
  # exact group; if it is between gates, the token remains queued until the
  # bounded launch/backoff section completes.
  printf '%s\n' "${abort_token}" >&7 || {
    exec 7>&-
    return 1
  }
  exec 7>&-
  for ((tick = 0; tick < S2_PRE_RELEASE_ABORT_WAIT_TICKS; tick += 1)); do
    if ! kill -0 -- "-${pgid}" 2>/dev/null; then
      if wait "${pid}" 2>/dev/null; then
        S2_START_SUPERVISOR_EXIT_STATUS=0
      else
        S2_START_SUPERVISOR_EXIT_STATUS=$?
      fi
      if [[ "${proof_scope}" == "server" ]]; then
        assert_no_run_survivors "${persist}" "${port}" "${marker}" || return 1
      fi
      S2_PRE_RELEASE_REAPED_PGID="${pgid}"
      return 0
    fi
    sleep 0.1
  done
  return 1
}

# The supervisor is the group leader and remains alive after its child exits. It blocks on a
# private release FIFO before invoking the real command, so no Wrangler/workerd descendant can
# exist until identity and kernel group ownership have been proved by the parent.
start_pinned_supervisor() {
  local status_file="$1" label="$2" persist="$3" port="$4" proof_scope="$5"
  local marker pid deadline control_fifo release_fifo release_token arm_token abort_token persistent_helper_pid_file
  local persistent_helper_pid=""
  local watchdog_pid_file watchdog_health watchdog_startup watchdog_scan_hang_armed arm_fragment_observed watchdog_pid watchdog_snapshot_status tick release_sent=0 watchdog_proved=0
  local plant_watchdog_exit_on_term="${S2_PLANT_WATCHDOG_EXIT_ON_TERM:-0}"
  local plant_supervisor_exit_on_term="${S2_PLANT_SUPERVISOR_EXIT_ON_TERM:-0}"
  local plant_persistent_pre_release_helper="${S2_PLANT_PERSISTENT_PRE_RELEASE_HELPER:-0}"
  local plant_watchdog_publication_delay="${S2_PLANT_WATCHDOG_PUBLICATION_DELAY_SECONDS:-0}"
  local plant_supervisor_exit_before_watchdog_publication="${S2_PLANT_SUPERVISOR_EXIT_BEFORE_WATCHDOG_PUBLICATION:-0}"
  local plant_abort_after_watchdog_launch="${S2_PLANT_ABORT_AFTER_WATCHDOG_LAUNCH:-0}"
  local plant_watchdog_checkpoint_corruption="${S2_PLANT_WATCHDOG_CHECKPOINT_CORRUPTION:-none}"
  local plant_supervisor_signal_after_arm="${S2_PLANT_SUPERVISOR_SIGNAL_AFTER_ARM:-none}"
  local plant_watchdog_checkpoint_open_failure="${S2_PLANT_WATCHDOG_CHECKPOINT_OPEN_FAILURE:-0}"
  local plant_wrong_arm_token="${S2_PLANT_WRONG_ARM_TOKEN:-0}"
  local plant_startup_journal_preexisting="${S2_PLANT_STARTUP_JOURNAL_PREEXISTING:-0}"
  local plant_startup_journal_append_failure="${S2_PLANT_STARTUP_JOURNAL_APPEND_FAILURE_AFTER_ARM:-0}"
  local plant_watchdog_ps_hang="${S2_PLANT_WATCHDOG_PS_HANG:-0}"
  local plant_supervisor_signal_after_watchdog="${S2_PLANT_SUPERVISOR_SIGNAL_AFTER_WATCHDOG:-none}"
  local plant_fragmented_arm_token="${S2_PLANT_FRAGMENTED_ARM_TOKEN:-0}"
  shift 5
  S2_START_FAILURE_STAGE="input-validation"
  S2_LAST_SUPERVISOR_PGID=""
  S2_LAST_SUPERVISOR_MARKER=""
  S2_START_SUPERVISOR_EXIT_STATUS=""
  S2_STARTUP_JOURNAL_PHASE=""
  case "${plant_watchdog_publication_delay}" in
    0|16) ;;
    *) return 1 ;;
  esac
  case "${plant_supervisor_exit_before_watchdog_publication}" in
    0|1) ;;
    *) return 1 ;;
  esac
  case "${plant_abort_after_watchdog_launch}" in
    0|1) ;;
    *) return 1 ;;
  esac
  case "${plant_supervisor_signal_after_arm}" in
    none|HUP|INT|TERM) ;;
    *) return 1 ;;
  esac
  case "${plant_watchdog_checkpoint_open_failure}" in
    0|1) ;;
    *) return 1 ;;
  esac
  case "${plant_wrong_arm_token}" in
    0|1) ;;
    *) return 1 ;;
  esac
  case "${plant_startup_journal_preexisting}" in
    0|1) ;;
    *) return 1 ;;
  esac
  case "${plant_startup_journal_append_failure}" in
    0|1) ;;
    *) return 1 ;;
  esac
  case "${plant_watchdog_ps_hang}" in
    0|1) ;;
    *) return 1 ;;
  esac
  case "${plant_supervisor_signal_after_watchdog}" in
    none|HUP|INT|TERM) ;;
    *) return 1 ;;
  esac
  case "${plant_fragmented_arm_token}" in
    0|1) ;;
    *) return 1 ;;
  esac
  [[ -d "${persist}" && ! -L "${persist}" && "${port}" =~ ^[0-9]+$ ]] || return 1
  case "${proof_scope}" in
    server|client) ;;
    *) return 1 ;;
  esac
  marker="${label}-$(random_hex 16)" || return 1
  S2_PRE_RELEASE_RESAMPLE_ATTEMPTS=0
  S2_PRE_RELEASE_ACCEPTED_SAMPLES=0
  S2_PRE_RELEASE_REJECTED_SAMPLES=0
  S2_PRE_RELEASE_CAPTURE_UNCERTAIN_SAMPLES=0
  S2_POST_ARM_INSPECTION_UNCERTAIN_SAMPLES=0
  S2_PRE_RELEASE_MAX_GROUP_MEMBER_COUNT=0
  S2_PRE_RELEASE_REAPED_PGID=""
  S2_PRE_RELEASE_EXPECTED_HELPER_PID=""
  S2_PRE_RELEASE_EXPECTED_HELPER_REJECTED_SAMPLES=0
  [[ ! -e "${status_file}" && ! -L "${status_file}" ]] || return 1
  control_fifo="${status_file}.control"
  [[ ! -e "${control_fifo}" && ! -L "${control_fifo}" ]] || return 1
  release_fifo="${status_file}.release"
  [[ ! -e "${release_fifo}" && ! -L "${release_fifo}" ]] || return 1
  persistent_helper_pid_file="${status_file}.persistent-helper.pid"
  [[ ! -e "${persistent_helper_pid_file}" && ! -L "${persistent_helper_pid_file}" ]] || return 1
  watchdog_pid_file="${status_file}.watchdog.pid"
  [[ ! -e "${watchdog_pid_file}" && ! -L "${watchdog_pid_file}" ]] || return 1
  watchdog_health="${status_file}.watchdog.health"
  [[ ! -e "${watchdog_health}" && ! -L "${watchdog_health}" ]] || return 1
  watchdog_startup="${status_file}.watchdog.startup"
  [[ ! -e "${watchdog_startup}" && ! -L "${watchdog_startup}" ]] || return 1
  watchdog_scan_hang_armed="${status_file}.watchdog.scan-hang-armed"
  [[ ! -e "${watchdog_scan_hang_armed}" && ! -L "${watchdog_scan_hang_armed}" ]] || return 1
  arm_fragment_observed="${status_file}.watchdog.arm-fragment-observed"
  [[ ! -e "${arm_fragment_observed}" && ! -L "${arm_fragment_observed}" ]] || return 1
  release_token="$(random_hex 16)" || return 1
  arm_token="$(random_hex 16)" || return 1
  abort_token="$(random_hex 16)" || return 1
  if [[ "${plant_startup_journal_preexisting}" == 1 ]]; then
    (umask 077; set -o noclobber; printf '%s\n' startup-sentinel >"${watchdog_startup}") \
      2>/dev/null || return 1
  fi

  # macOS does not ship a `setsid` executable. POSIX::setsid is part of the system Perl and
  # creates a fresh session/process group without Bash job-control mode, which otherwise can
  # detach background jobs from the harness runner and leave their parent identity unusable.
  command -v perl >/dev/null 2>&1 || return 1
  perl -MPOSIX=setsid,dup2 -MFcntl=:DEFAULT -e '
    setsid() or exit 125;
    $SIG{HUP} = $SIG{INT} = $SIG{TERM} = "DEFAULT";
    my $journal_path = shift @ARGV;
    umask 0077;
    sysopen(my $journal, $journal_path, O_WRONLY | O_CREAT | O_EXCL, 0600) or exit 73;
    dup2(fileno($journal), 6) == 6 or exit 73;
    $^F = 6;
    exec @ARGV;
    exit 125;
  ' -- "${watchdog_startup}" bash -c '
    marker="$1"
    status_file="$2"
    owner_pid="$3"
    release_token="$4"
    arm_token="$5"
    plant_watchdog_uncertainty="$6"
    max_watchdog_uncertain_ticks="$7"
    plant_watchdog_exit_on_term="$8"
    plant_supervisor_exit_on_term="$9"
    plant_persistent_pre_release_helper="${10}"
    persistent_helper_pid_file="${11}"
    plant_watchdog_publication_delay="${12}"
    plant_supervisor_exit_before_watchdog_publication="${13}"
    abort_token="${14}"
    plant_watchdog_checkpoint_corruption="${15}"
    plant_supervisor_signal_after_arm="${16}"
    plant_watchdog_checkpoint_open_failure="${17}"
    gate_mismatch_status="${18}"
    checkpoint_io_status="${19}"
    plant_startup_journal_append_failure="${20}"
    plant_watchdog_ps_hang="${21}"
    plant_supervisor_signal_after_watchdog="${22}"
    watchdog_scan_hang_armed="${23}"
    plant_fragmented_arm_token="${24}"
    shift 24
    supervisor_pid="$$"
    arm_fragment_observed="${status_file}.watchdog.arm-fragment-observed"
    record_startup_phase() {
      printf "%s %s\n" "$1" "${supervisor_pid}" >&6
    }
    pre_release_signal() {
      local signal_name="$1" signal_status="$2"
      record_startup_phase "signal-${signal_name}" || :
      trap - TERM HUP INT
      exec 6>&-
      exit "${signal_status}"
    }
    record_startup_phase supervisor-started || exit "${checkpoint_io_status}"
    trap "pre_release_signal term 143" TERM
    trap "pre_release_signal hup 129" HUP
    trap "pre_release_signal int 130" INT
    release_fifo="${status_file}.release"
    [[ ! -e "${release_fifo}" && ! -L "${release_fifo}" ]] || exit 125
    mkfifo -m 600 "${release_fifo}" || exit 125
    exec 8<>"${release_fifo}" || exit 125
    wait_for_gate_value() {
      local expected="$1" gate_name="$2" value="" fragment=""
      # Gate reads are builtins and never create a group member. Controller-side
      # process-table observations run through a detached `setsid` scanner, so
      # they cannot turn their own sampling process into a second descendant of
      # this blocked supervisor.
      while :; do
        fragment=""
        if IFS= read -r -t 0.2 fragment <&8; then
          value="${value}${fragment}"
          if [[ "${value}" == "${abort_token}" ]]; then
            record_startup_phase "${gate_name}-abort-consumed" || :
            trap - TERM HUP INT
            kill -KILL -- "-${supervisor_pid}" 2>/dev/null || exit 125
            exit 125
          fi
          if [[ "${value}" != "${expected}" ]]; then
            record_startup_phase "${gate_name}-gate-mismatch" || :
            exit "${gate_mismatch_status}"
          fi
          record_startup_phase "${gate_name}-gate-consumed" || exit "${checkpoint_io_status}"
          return 0
        fi
        # Bash can return a timeout after consuming only part of a FIFO line;
        # the partial bytes remain in the destination variable but are no
        # longer in the FIFO. Preserve them across samples so scheduler delay
        # cannot turn one atomic controller write into a false gate mismatch.
        value="${value}${fragment}"
        if [[ "${plant_fragmented_arm_token}" == 1 && "${gate_name}" == arm && \
          -n "${fragment}" && ! -e "${arm_fragment_observed}" && \
          ! -L "${arm_fragment_observed}" ]]; then
          (umask 077; set -o noclobber; \
            printf "arm-fragment-observed %s\n" "${supervisor_pid}" >"${arm_fragment_observed}") \
            2>/dev/null || exit "${checkpoint_io_status}"
        fi
        if (( ${#value} > 160 )); then
          record_startup_phase "${gate_name}-gate-mismatch" || :
          exit "${gate_mismatch_status}"
        fi
        if ! kill -0 "${owner_pid}" 2>/dev/null; then
          # Before the watchdog exists, this supervisor is the only process
          # able to retire its private group. Killing the exact group, rather
          # than merely exiting, also reaps any planted pre-release helper.
          record_startup_phase "${gate_name}-owner-lost" || :
          trap - TERM HUP INT
          kill -KILL -- "-${supervisor_pid}" 2>/dev/null || exit 125
          exit 125
        fi
      done
    }
    if [[ "${plant_persistent_pre_release_helper}" == 1 ]]; then
      # Regression-only: this one-process helper has no child of its own, but
      # its argv deliberately carries the supervisor marker. Publish its exact
      # PID before the controller samples the group so a process-table observer
      # cannot impersonate the planted helper in the proof.
      [[ ! -e "${persistent_helper_pid_file}" && ! -L "${persistent_helper_pid_file}" ]] || exit 125
      bash -c "exec -a s2-persistent-pre-release-helper-s2-pinned-supervisor-${marker} tail -f /dev/null" 6>&- &
      persistent_helper_pid="$!"
      [[ "${persistent_helper_pid}" =~ ^[0-9]+$ ]] || exit 125
      printf "%s\\n" "${persistent_helper_pid}" >"${persistent_helper_pid_file}" || exit 125
    fi
    # The controller first arms the parent-loss watchdog while this supervisor remains blocked.
    # Only after it proves the watchdog exact healthy identity does it send the separate
    # release value.  Thus parent death cannot fall into the old release-to-watchdog gap.
    [[ ! -e "${arm_fragment_observed}" && ! -L "${arm_fragment_observed}" ]] || exit 125
    record_startup_phase await-arm || exit "${checkpoint_io_status}"
    wait_for_gate_value "${arm_token}" arm
    if [[ "${plant_supervisor_signal_after_arm}" != none ]]; then
      kill "-${plant_supervisor_signal_after_arm}" "${supervisor_pid}" || exit 125
      exit 125
    fi
    if [[ "${plant_startup_journal_append_failure}" == 1 ]]; then
      exec 6>&-
    fi
    # Keep FD 8 open across both gates. Closing then reopening after watchdog publication gives
    # a concurrent controller write an interval in which its release value can be lost. The
    # watchdog receives an explicit closed FD below, and the payload inherits none.
    watchdog_pid_file="${status_file}.watchdog.pid"
    watchdog_health="${status_file}.watchdog.health"
    watchdog_arm_consumed="${status_file}.watchdog.arm-consumed"
    watchdog_launch_status="${status_file}.watchdog.launch"
    [[ ! -e "${watchdog_pid_file}" && ! -L "${watchdog_pid_file}" ]] || exit 125
    [[ ! -e "${watchdog_health}" && ! -L "${watchdog_health}" ]] || exit 125
    [[ ! -e "${watchdog_scan_hang_armed}" && ! -L "${watchdog_scan_hang_armed}" ]] || exit 125
    [[ ! -e "${watchdog_arm_consumed}" && ! -L "${watchdog_arm_consumed}" ]] || exit 125
    [[ ! -e "${watchdog_launch_status}" && ! -L "${watchdog_launch_status}" ]] || exit 125
    if [[ "${plant_watchdog_checkpoint_open_failure}" == 1 ]]; then
      watchdog_arm_consumed="${status_file}.missing-checkpoint-dir/arm-consumed"
    fi
    record_startup_phase arm-checkpoint-attempt || exit "${checkpoint_io_status}"
    if ! printf "arm-consumed %s\n" "${supervisor_pid}" >"${watchdog_arm_consumed}"; then
      record_startup_phase arm-checkpoint-write-failed || :
      exit "${checkpoint_io_status}"
    fi
    record_startup_phase arm-checkpoint-published || exit "${checkpoint_io_status}"
    record_startup_phase launch-checkpoint-attempt || exit "${checkpoint_io_status}"
    case "${plant_watchdog_checkpoint_corruption}" in
      none)
        printf "spawn-attempted %s\n" "${supervisor_pid}" >"${watchdog_launch_status}" || \
          exit "${checkpoint_io_status}"
        record_startup_phase launch-checkpoint-published || exit "${checkpoint_io_status}"
        ;;
      empty)
        : >"${watchdog_launch_status}" || exit 125
        record_startup_phase launch-checkpoint-corrupt || :
        exit 125
        ;;
      malformed)
        printf "not-a-checkpoint\n" >"${watchdog_launch_status}" || exit 125
        record_startup_phase launch-checkpoint-corrupt || :
        exit 125
        ;;
      extra-line)
        printf "spawn-attempted %s\nextra\n" "${supervisor_pid}" >"${watchdog_launch_status}" || exit 125
        record_startup_phase launch-checkpoint-corrupt || :
        exit 125
        ;;
      wrong-pid)
        printf "spawn-attempted %s\n" "$((supervisor_pid + 1))" >"${watchdog_launch_status}" || exit 125
        record_startup_phase launch-checkpoint-corrupt || :
        exit 125
        ;;
      *) exit 125 ;;
    esac
    if [[ "${plant_supervisor_exit_before_watchdog_publication}" == 1 ]]; then
      exit 125
    fi
    if [[ "${plant_watchdog_publication_delay}" == 16 ]]; then
      sleep 16 || exit 125
    fi
    # This is a separate Bash process so its `$$` is its real process-table PID. It remains in
    # the pinned group. Inspection uncertainty is published and retried; it never makes the
    # watchdog silently disappear, and it never authorizes a signal.
    bash -c "${S2_WATCHDOG_PROGRAM}" "s2-parent-watchdog-${marker}" \
      "${supervisor_pid}" "${owner_pid}" "${marker}" \
      "${watchdog_health}" "${plant_watchdog_uncertainty}" \
      "${max_watchdog_uncertain_ticks}" "${plant_watchdog_exit_on_term}" \
      "${plant_watchdog_ps_hang}" "${watchdog_scan_hang_armed}" \
      6>&- 8>&- >/dev/null 2>&1 &
    watchdog_pid="$!"
    [[ "${watchdog_pid}" =~ ^[0-9]+$ ]] || exit 125
    printf "%s\n" "${watchdog_pid}" >"${watchdog_pid_file}" || exit 125
    record_startup_phase watchdog-pid-published || exit "${checkpoint_io_status}"
    if [[ "${S2_PLANT_SUPERVISOR_EXIT_AFTER_WATCHDOG:-0}" == 1 ]]; then
      exit 125
    fi
    # While still blocked, TERM must also dismiss the watchdog.  This covers both controller
    # cancellation and the watchdog own parent-loss TERM without stranding an orphan helper.
    post_watchdog_signal() {
      local signal_name="$1" signal_status="$2"
      record_startup_phase "signal-${signal_name}" || :
      trap - TERM HUP INT
      exec 6>&-
      kill -USR1 "${watchdog_pid}" 2>/dev/null || :
      wait "${watchdog_pid}" 2>/dev/null || :
      exit "${signal_status}"
    }
    trap "post_watchdog_signal term 143" TERM
    trap "post_watchdog_signal hup 129" HUP
    trap "post_watchdog_signal int 130" INT
    record_startup_phase await-release || exit "${checkpoint_io_status}"
    if [[ "${plant_supervisor_signal_after_watchdog}" != none ]]; then
      if [[ "${plant_watchdog_ps_hang}" == 1 ]]; then
        scan_hang_deadline=$((SECONDS + 5))
        scan_hang_proved=0
        while (( SECONDS < scan_hang_deadline )); do
          if [[ -f "${watchdog_scan_hang_armed}" && ! -L "${watchdog_scan_hang_armed}" ]]; then
            {
              IFS= read -r scan_hang_line || scan_hang_line=""
              if IFS= read -r scan_hang_extra; then scan_hang_line=""; fi
            } <"${watchdog_scan_hang_armed}"
            if [[ "${scan_hang_line}" == "scan-hang-armed ${watchdog_pid}" ]]; then
              scan_hang_proved=1
              break
            fi
          fi
          sleep 0.05
        done
        [[ ${scan_hang_proved} -eq 1 ]] || exit 125
      fi
      kill "-${plant_supervisor_signal_after_watchdog}" "${supervisor_pid}" || exit 125
      exit 125
    fi
    wait_for_gate_value "${release_token}" release
    exec 8>&-
    exec 6>&-
    if [[ "${plant_supervisor_exit_on_term}" == 1 ]]; then
      # Regression-only: make the post-release leader leave on group TERM so the legacy stop
      # branch must prove or refuse the remaining TERM-resistant group without a PID fallback.
      trap "exit 0" TERM HUP INT
    else
      trap ":" TERM HUP INT
    fi
    trap "exit 0" USR1
    # One leader signal closes the controller-loss window: the still-pinned leader releases and
    # reaps its own exact watchdog before exiting. The controller never dismisses the watchdog
    # first and then hopes to reach the leader with a second signal.
    trap "kill -USR1 ${watchdog_pid} 2>/dev/null || :; wait ${watchdog_pid} 2>/dev/null || :; exit 0" USR1
    "$@" &
    child="$!"
    if wait "${child}"; then child_status=0; else child_status="$?"; fi
    case "${child_status}" in
      ""|*[!0-9]*) exit 125 ;;
    esac
    printf "%s\\n" "${child_status}" >"${status_file}"
    control_fifo="${status_file}.control"
    [[ ! -e "${control_fifo}" && ! -L "${control_fifo}" ]] || exit 125
    mkfifo -m 600 "${control_fifo}" || exit 125
    # The controller boundedly TERM then KILLs this still-pinned group. The release FIFO keeps
    # the leader alive with no extra helper after its real child has recorded a numeric status.
    exec 9<>"${control_fifo}" || exit 125
    while :; do
      read -r -t 60 _ <&9 || :
    done
  ' "s2-pinned-supervisor-${marker}" "${marker}" "${status_file}" "${S2_PARENT_PID}" \
    "${release_token}" "${arm_token}" "${S2_PLANT_WATCHDOG_INSPECTION_UNCERTAIN:-0}" \
    "${S2_WATCHDOG_MAX_UNCERTAIN_TICKS}" "${plant_watchdog_exit_on_term}" \
    "${plant_supervisor_exit_on_term}" \
    "${plant_persistent_pre_release_helper}" \
    "${persistent_helper_pid_file}" \
    "${plant_watchdog_publication_delay}" \
    "${plant_supervisor_exit_before_watchdog_publication}" \
    "${abort_token}" \
    "${plant_watchdog_checkpoint_corruption}" \
    "${plant_supervisor_signal_after_arm}" \
    "${plant_watchdog_checkpoint_open_failure}" \
    "${S2_SUPERVISOR_GATE_MISMATCH_STATUS}" \
    "${S2_SUPERVISOR_CHECKPOINT_IO_STATUS}" \
    "${plant_startup_journal_append_failure}" \
    "${plant_watchdog_ps_hang}" \
    "${plant_supervisor_signal_after_watchdog}" \
    "${watchdog_scan_hang_armed}" \
    "${plant_fragmented_arm_token}" \
    "$@" &
  pid=$!
  S2_LAST_SUPERVISOR_PGID="${pid}"
  S2_LAST_SUPERVISOR_MARKER="${marker}"
  S2_START_FAILURE_STAGE="pre-arm-release-fifo"

  deadline=$((SECONDS + S2_READY_DEADLINE_SECONDS))
  while (( SECONDS < deadline )); do
    if [[ -p "${release_fifo}" && ! -L "${release_fifo}" ]]; then
      S2_START_FAILURE_STAGE="pre-arm-ownership"
      # Open the parent side read/write before the final proof. A later write uses this already-open
      # descriptor, so a child exit in the proof-to-release window cannot turn pathname open into
      # an unbounded FIFO wait. The parent-held read end also prevents SIGPIPE on that planted race.
      exec 7<>"${release_fifo}" || return 1
      if [[ "${plant_persistent_pre_release_helper}" == 1 ]]; then
        deadline=$((SECONDS + S2_READY_DEADLINE_SECONDS))
        while (( SECONDS < deadline )); do
          if [[ -f "${persistent_helper_pid_file}" && ! -L "${persistent_helper_pid_file}" ]] && \
            IFS= read -r persistent_helper_pid <"${persistent_helper_pid_file}" && \
            is_decimal "${persistent_helper_pid}"; then
            S2_PRE_RELEASE_EXPECTED_HELPER_PID="${persistent_helper_pid}"
            break
          fi
          sleep 0.05
        done
        if ! is_decimal "${S2_PRE_RELEASE_EXPECTED_HELPER_PID}"; then
          exec 7>&-
          if pre_release_supervisor_is_owned "${pid}" "${pid}" "${marker}"; then
            kill_pre_release_owned_group_to_zero "${pid}" "${pid}" "${marker}" "${persist}" "${port}" \
              "${proof_scope}" || return 1
            S2_PRE_RELEASE_REAPED_PGID="${pid}"
          fi
          return 1
        fi
      fi
      if [[ "${S2_PLANT_OWNER_LOSS_BEFORE_ARM:-0}" == 1 ]]; then
        local owner_loss_record="${S2_PRE_ARM_OWNER_LOSS_RECORD:-}"
        if ! [[ "${S2_SHELL_REGRESSION_TEST:-}" == "pre-arm-owner-loss-child" && \
          -n "${owner_loss_record}" && \
          "${owner_loss_record}" == "${S2_EVIDENCE_ROOT}/"* && \
          ! -e "${owner_loss_record}" && ! -L "${owner_loss_record}" && \
          "${plant_persistent_pre_release_helper}" == 1 ]] && \
          is_decimal "${S2_PRE_RELEASE_EXPECTED_HELPER_PID}"; then
          exec 7>&-
          return 1
        fi
        printf '%s %s %s %s %s %s\n' \
          "${pid}" "${pid}" "${marker}" "${S2_PRE_RELEASE_EXPECTED_HELPER_PID}" \
          "${persist}" "${port}" >"${owner_loss_record}" || {
          exec 7>&-
          return 1
        }
        # Test-only: die while the supervisor is still waiting for its first
        # gate. This is a builtin timed read on the already-open FIFO, so the
        # plant creates no controller child that could become unrelated residue.
        while :; do
          IFS= read -r -t 1 _ <&7 || :
        done
      fi
      if ! pre_release_group_is_stably_pinned "${pid}" "${marker}"; then
        abort_pre_release_supervisor_to_zero "${pid}" "${pid}" "${marker}" "${abort_token}" \
          "${persist}" "${port}" "${proof_scope}" || return 1
        return 1
      fi
      # Arm the watchdog over the already-open descriptor, then prove its parent/supervisor
      # identity before release.  The child command is still blocked, so no workerd descendant
      # can exist in this interval.
      S2_START_FAILURE_STAGE="watchdog-arm-write"
      if [[ "${plant_wrong_arm_token}" == 1 ]]; then
        if ! printf '%s\n' wrong-arm-token >&7; then exec 7>&-; return 1; fi
      elif [[ "${plant_fragmented_arm_token}" == 1 ]]; then
        if ! printf '%s' "${arm_token:0:16}" >&7; then exec 7>&-; return 1; fi
        deadline=$((SECONDS + 5))
        while ! checkpoint_file_matches \
          "${arm_fragment_observed}" arm-fragment-observed "${pid}"; do
          if (( SECONDS >= deadline )); then exec 7>&-; return 1; fi
          sleep 0.05
        done
        if ! printf '%s\n' "${arm_token:16}" >&7; then exec 7>&-; return 1; fi
      elif ! printf '%s\n' "${arm_token}" >&7; then
        exec 7>&-
        return 1
      fi
      # Publication work is not considered to have started until the child has
      # durably acknowledged the exact arm gate. This separates a gate/signal/
      # checkpoint failure from a watchdog launch or PID-publication failure.
      S2_START_FAILURE_STAGE="watchdog-arm-ack"
      deadline=$((SECONDS + S2_WATCHDOG_PUBLICATION_DEADLINE_SECONDS))
      while (( SECONDS < deadline )); do
        if startup_journal_last_phase "${watchdog_startup}" "${pid}" && \
          [[ ${S2_STARTUP_JOURNAL_ARM_ACK} -eq 1 ]]; then
          break
        fi
        kill -0 -- "-${pid}" 2>/dev/null || break
        sleep 0.05
      done
      if ! startup_journal_last_phase "${watchdog_startup}" "${pid}" || \
        [[ ${S2_STARTUP_JOURNAL_ARM_ACK} -ne 1 ]]; then
        abort_pre_release_supervisor_to_zero "${pid}" "${pid}" "${marker}" "${abort_token}" \
          "${persist}" "${port}" "${proof_scope}" || return 1
        return 1
      fi
      S2_START_FAILURE_STAGE="watchdog-publication"
      deadline=$((SECONDS + S2_WATCHDOG_PUBLICATION_DEADLINE_SECONDS))
      watchdog_pid=""
      while (( SECONDS < deadline )); do
        if ! pre_release_supervisor_is_owned "${pid}" "${pid}" "${marker}"; then
          S2_POST_ARM_INSPECTION_UNCERTAIN_SAMPLES=$((
            S2_POST_ARM_INSPECTION_UNCERTAIN_SAMPLES + 1
          ))
          if ! kill -0 -- "-${pid}" 2>/dev/null; then
            break
          fi
          sleep 0.2
          continue
        fi
        if [[ "${plant_abort_after_watchdog_launch}" == 1 && \
          -f "${status_file}.watchdog.launch" && ! -L "${status_file}.watchdog.launch" ]]; then
          S2_START_FAILURE_STAGE="watchdog-publication-abort-plant"
          abort_pre_release_supervisor_to_zero "${pid}" "${pid}" "${marker}" "${abort_token}" \
            "${persist}" "${port}" "${proof_scope}" || return 1
          return 1
        fi
        if [[ -f "${watchdog_pid_file}" && ! -L "${watchdog_pid_file}" ]] && \
          IFS= read -r watchdog_pid <"${watchdog_pid_file}" && is_decimal "${watchdog_pid}"; then
          if pre_release_watchdog_is_healthy \
            "${watchdog_pid}" "${pid}" "${pid}" "${marker}" "${watchdog_health}"; then
            watchdog_proved=1
            break
          else
            watchdog_snapshot_status=$?
            if [[ ${watchdog_snapshot_status} -eq 2 ]]; then
              S2_POST_ARM_INSPECTION_UNCERTAIN_SAMPLES=$((
                S2_POST_ARM_INSPECTION_UNCERTAIN_SAMPLES + 1
              ))
            fi
          fi
        fi
        sleep 0.2
      done
      if [[ ${watchdog_proved} -ne 1 ]]; then
        abort_pre_release_supervisor_to_zero "${pid}" "${pid}" "${marker}" "${abort_token}" \
          "${persist}" "${port}" "${proof_scope}" || return 1
        return 1
      fi
      # This assignment precedes every release write. An EXIT trap can therefore use the same
      # exact persistence, port, and proof scope that the eventual owner would use, even if a
      # signal lands between this line and the caller recording its own ownership fields.
      S2_MOST_RECENT_SUPERVISOR="${pid} ${pid} ${S2_PARENT_PID} ${marker} ${watchdog_pid} ${watchdog_health} ${persist} ${port} ${proof_scope}"
      S2_START_FAILURE_STAGE="payload-release"
      if [[ "${S2_PLANT_RELEASE_INTERLEAVING:-0}" == 1 ]]; then
        # FD 8 remains continuously open across watchdog publication and this release write;
        # the exact cleanup record above removes the former release-to-owner gap.
        if ! printf '%s\n' "${release_token}" >&7; then
          exec 7>&-
          return 1
        fi
        release_sent=1
      fi
      if [[ "${S2_PLANT_RELEASE_CHILD_EXIT_AFTER_REPROOF:-0}" == 1 ]]; then
        S2_PLANTED_RELEASE_PID="${pid}"
        S2_PLANTED_RELEASE_PGID="${pid}"
        S2_PLANTED_RELEASE_MARKER="${marker}"
        if ! signal_owned_group TERM "${pid}" "${pid}" "${marker}"; then
          exec 7>&-
          return 1
        fi
        for ((tick = 0; tick < S2_TERMINATE_WAIT_TICKS; tick += 1)); do
          kill -0 -- "-${pid}" 2>/dev/null || break
          sleep 0.1
        done
        # This write is deliberately after the planted child exit. It must complete immediately
        # because fd 7 already owns both ends; a pathname FIFO open here would hang forever.
        if ! printf '%s\n' "${release_token}" >&7; then exec 7>&-; return 1; fi
        exec 7>&-
        if kill -0 -- "-${pid}" 2>/dev/null; then return 1; fi
        wait "${pid}" 2>/dev/null || :
        return 1
      fi
      if [[ ${release_sent} -eq 0 ]] && ! printf '%s\n' "${release_token}" >&7; then
        exec 7>&-
        return 1
      fi
      exec 7>&-

      # The release is not considered successful until the parent can observe the separately
      # identified watchdog in a healthy state. A missing, malformed, dead, or uncertainty state
      # fails closed and the still-pinned exact group is killed before this function returns.
      deadline=$((SECONDS + S2_READY_DEADLINE_SECONDS))
      S2_START_FAILURE_STAGE="post-release-health"
      while (( SECONDS < deadline )); do
        supervisor_is_owned "${pid}" "${pid}" "${marker}" || break
        if [[ -f "${watchdog_pid_file}" && ! -L "${watchdog_pid_file}" ]] && \
          IFS= read -r watchdog_pid <"${watchdog_pid_file}" && is_decimal "${watchdog_pid}" && \
          watchdog_is_healthy "${watchdog_pid}" "${pid}" "${pid}" "${marker}" "${watchdog_health}"; then
          S2_STARTED_PID="${pid}"
          S2_STARTED_PGID="${pid}"
          S2_STARTED_MARKER="${marker}"
          S2_STARTED_STATUS_FILE="${status_file}"
          S2_STARTED_WATCHDOG_PID="${watchdog_pid}"
          S2_STARTED_WATCHDOG_HEALTH="${watchdog_health}"
          S2_START_FAILURE_STAGE="ready"
          return 0
        fi
        sleep 0.05
      done
      if supervisor_is_owned "${pid}" "${pid}" "${marker}"; then
        signal_owned_group KILL "${pid}" "${pid}" "${marker}" || return 1
        for ((tick = 0; tick < S2_TERMINATE_WAIT_TICKS; tick += 1)); do
          kill -0 -- "-${pid}" 2>/dev/null || break
          sleep 0.1
        done
      fi
      kill -0 -- "-${pid}" 2>/dev/null && return 1
      wait "${pid}" 2>/dev/null || :
      return 1
    fi
    if ! kill -0 "${pid}" 2>/dev/null; then
      if wait "${pid}" 2>/dev/null; then
        S2_START_SUPERVISOR_EXIT_STATUS=0
      else
        S2_START_SUPERVISOR_EXIT_STATUS=$?
      fi
      return 1
    fi
    sleep 0.05
  done

  # Before release the direct supervisor has no real child. A fresh exact group proof permits
  # bounded group cleanup; an unclear process table is left for the blocked child to self-retire
  # when it observes the lost parent rather than risking an unrelated PID or PGID.
  if pre_release_supervisor_is_owned "${pid}" "${pid}" "${marker}"; then
    signal_pre_release_owned_group TERM "${pid}" "${pid}" "${marker}" || return 1
    for ((deadline = 0; deadline < S2_TERMINATE_WAIT_TICKS; deadline += 1)); do
      if ! kill -0 -- "-${pid}" 2>/dev/null; then
        wait "${pid}" 2>/dev/null || :
        return 1
      fi
      pre_release_supervisor_is_owned "${pid}" "${pid}" "${marker}" || return 1
      sleep 0.1
    done
    signal_pre_release_owned_group KILL "${pid}" "${pid}" "${marker}" || return 1
  fi
  return 1
}

read_child_status() {
  local status_file="$1" value
  [[ -f "${status_file}" && ! -L "${status_file}" ]] || return 1
  IFS= read -r value <"${status_file}" || return 1
  [[ "${value}" =~ ^([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$ ]] || return 2
  S2_CHILD_STATUS="${value}"
}

group_members() {
  local pgid="$1" rows line pid seen_pgid ppid
  # Query only the owned process group. A host-wide process-table walk here made
  # the pre-release proof contend with every agent on the machine and widened
  # the fork/exec observation race this function is meant to classify.
  rows="$(LC_ALL=C ps -o pid=,pgid=,ppid=,stat=,command= -g "${pgid}" 2>/dev/null)" || return 2
  S2_GROUP_MEMBER_COUNT=0
  S2_GROUP_MEMBER_PIDS=()
  while IFS= read -r line; do
    [[ -n "${line}" ]] || continue
    read -r pid seen_pgid ppid _ _ <<<"${line}"
    is_decimal "${pid}" && is_decimal "${seen_pgid}" && is_decimal "${ppid}" || return 2
    if [[ "${seen_pgid}" == "${pgid}" ]]; then
      S2_GROUP_MEMBER_COUNT=$((S2_GROUP_MEMBER_COUNT + 1))
      S2_GROUP_MEMBER_PIDS+=("${pid}")
    fi
  done <<<"${rows}"
}

group_contains_pid() {
  local expected="$1" member
  for member in "${S2_GROUP_MEMBER_PIDS[@]}"; do
    [[ "${member}" == "${expected}" ]] && return 0
  done
  return 1
}

pre_release_snapshot_line_kind() {
  local line="$1" helper_pid="$2" supervisor_pid="$3" marker="$4"
  local seen_pid seen_pgid seen_ppid seen_stat seen_command expected_arguments
  # The marker is a correlation proof, not decoration. An empty value would
  # weaken the forged-supervisor check to a broad prefix match.
  [[ -n "${marker}" ]] || return 1
  read -r seen_pid seen_pgid seen_ppid seen_stat seen_command <<<"${line}"
  is_decimal "${seen_pid}" && is_decimal "${seen_pgid}" && is_decimal "${seen_ppid}" || return 1
  [[ "${seen_pid}" == "${helper_pid}" && "${seen_pgid}" == "${supervisor_pid}" && \
    "${seen_ppid}" == "${supervisor_pid}" && "${seen_stat}" != T* ]] || return 1
  # An argv marker is not an identity proof. macOS can expose a child between
  # fork and exec with its parent's argv, and a persistent non-ps helper can
  # deliberately carry the same marker. Either case is ambiguous, never
  # accepted: bounded resampling must refuse release on persistent ambiguity.
  if [[ "${seen_stat}" == Z* || \
    "${seen_command}" == *"s2-pinned-supervisor-${marker}"* ]]; then
    return 2
  fi
  expected_arguments="-o pid=,pgid=,ppid=,stat=,command= -p ${supervisor_pid}"
  case "${seen_command}" in
    "ps ${expected_arguments}"|"/bin/ps ${expected_arguments}"|"/usr/bin/ps ${expected_arguments}")
      return 0
      ;;
    *) return 1 ;;
  esac
}

# Before release the fresh session contains only the pinned supervisor. One detached process-table
# scan supplies each complete sample, so an observer never appears as the helper it classifies.
# Two accepted bounded samples prove the leader remains pinned. A marker-bearing helper is
# ambiguous and resampled; a live non-ps helper is refused immediately; and persistent ambiguity
# exhausts the same finite resample budget before release is refused.
pre_release_group_is_stably_pinned() {
  local pid="$1" marker="$2" attempts=0 accepted=0 line member helper="" helper_line=""
  local supervisor_line="" helper_status expected_helper
  local seen_pid seen_pgid seen_ppid seen_stat seen_command
  S2_PRE_RELEASE_RESAMPLE_ATTEMPTS=0
  S2_PRE_RELEASE_ACCEPTED_SAMPLES=0
  S2_PRE_RELEASE_REJECTED_SAMPLES=0
  S2_PRE_RELEASE_MAX_GROUP_MEMBER_COUNT=0
  S2_PRE_RELEASE_EXPECTED_HELPER_REJECTED_SAMPLES=0
  expected_helper="${S2_PRE_RELEASE_EXPECTED_HELPER_PID}"
  [[ -z "${expected_helper}" ]] || is_decimal "${expected_helper}" || return 1
  while (( attempts < 40 && accepted < 2 )); do
    attempts=$((attempts + 1))
    S2_PRE_RELEASE_RESAMPLE_ATTEMPTS="${attempts}"
    S2_GROUP_MEMBER_COUNT=0
    S2_GROUP_MEMBER_PIDS=()
    supervisor_line=""
    helper_line=""
    # One detached scan is the complete sample. It sees the supervisor and any
    # helper in one process-table instant, after the scanner has left this
    # group; no command-substitution child can manufacture the second member.
    if ! capture_detached_process_table \
      -o pid=,pgid=,ppid=,stat=,command= -g "${pid}"; then
      # A failed scan proves neither absence nor ownership loss. Refuse to
      # accept this sample, but keep the retry inside the existing finite
      # pre-release budget so transient host fork/ps pressure cannot turn a
      # healthy pinned group into a false terminal failure.
      S2_PRE_RELEASE_CAPTURE_UNCERTAIN_SAMPLES=$((
        S2_PRE_RELEASE_CAPTURE_UNCERTAIN_SAMPLES + 1
      ))
      (( attempts == 40 )) || sleep 0.05
      continue
    fi
    while IFS= read -r line; do
      [[ -n "${line}" ]] || continue
      read -r seen_pid seen_pgid seen_ppid seen_stat seen_command <<<"${line}"
      is_decimal "${seen_pid}" && is_decimal "${seen_pgid}" && is_decimal "${seen_ppid}" || return 1
      [[ "${seen_pgid}" == "${pid}" ]] || continue
      S2_GROUP_MEMBER_COUNT=$((S2_GROUP_MEMBER_COUNT + 1))
      S2_GROUP_MEMBER_PIDS+=("${seen_pid}")
      if [[ "${seen_pid}" == "${pid}" ]]; then
        supervisor_line="${line}"
      else
        helper_line="${line}"
      fi
    done <<<"${S2_DETACHED_PROCESS_TABLE}"
    if (( S2_GROUP_MEMBER_COUNT > S2_PRE_RELEASE_MAX_GROUP_MEMBER_COUNT )); then
      S2_PRE_RELEASE_MAX_GROUP_MEMBER_COUNT="${S2_GROUP_MEMBER_COUNT}"
    fi
    [[ ${S2_GROUP_MEMBER_COUNT} -ge 1 && ${S2_GROUP_MEMBER_COUNT} -le 2 ]] || return 1
    group_contains_pid "${pid}" || return 1
    [[ -n "${supervisor_line}" ]] || return 1
    read -r seen_pid seen_pgid seen_ppid seen_stat seen_command <<<"${supervisor_line}"
    [[ "${seen_pid}" == "${pid}" && "${seen_pgid}" == "${pid}" && \
      "${seen_ppid}" == "${S2_PARENT_PID}" && "${seen_stat}" != T* && \
      "${seen_command}" == *"s2-pinned-supervisor-${marker}"* ]] || return 1
    kill -0 "${pid}" 2>/dev/null && kill -0 -- "-${pid}" 2>/dev/null || return 1
    if [[ ${S2_GROUP_MEMBER_COUNT} -eq 2 ]]; then
      helper=""
      for member in "${S2_GROUP_MEMBER_PIDS[@]}"; do
        [[ "${member}" == "${pid}" ]] || helper="${member}"
      done
      [[ -n "${helper}" ]] || return 1
      # The plant records its exact helper PID before the controller samples the
      # group. If an observer ever entered this group, it would be a third member
      # or replace the recorded helper here, both fail-closed rather than making
      # the plant's rejection counters look real.
      [[ -z "${expected_helper}" || "${helper}" == "${expected_helper}" ]] || return 1
      [[ -n "${helper_line}" ]] || return 1
      if pre_release_snapshot_line_kind "${helper_line}" "${helper}" "${pid}" "${marker}"; then
        accepted=$((accepted + 1))
        S2_PRE_RELEASE_ACCEPTED_SAMPLES="${accepted}"
      else
        helper_status=$?
        [[ ${helper_status} -eq 2 ]] || return 1
        S2_PRE_RELEASE_REJECTED_SAMPLES=$((S2_PRE_RELEASE_REJECTED_SAMPLES + 1))
        if [[ -n "${expected_helper}" ]]; then
          S2_PRE_RELEASE_EXPECTED_HELPER_REJECTED_SAMPLES=$((
            S2_PRE_RELEASE_EXPECTED_HELPER_REJECTED_SAMPLES + 1
          ))
        fi
      fi
    else
      accepted=$((accepted + 1))
      S2_PRE_RELEASE_ACCEPTED_SAMPLES="${accepted}"
    fi
    (( accepted == 2 )) || sleep 0.05
  done
  [[ ${accepted} -eq 2 ]]
}

signal_owned_group() {
  local signal="$1" pid="$2" pgid="$3" marker="$4"
  supervisor_is_owned "${pid}" "${pgid}" "${marker}" || return 1
  kill "-${signal}" -- "-${pgid}" 2>/dev/null
}

release_owned_supervisor() {
  local pid="$1" pgid="$2" marker="$3"
  supervisor_is_owned "${pid}" "${pgid}" "${marker}" || return 1
  kill -USR1 "${pid}" 2>/dev/null
}

lsof_scanner_is_healthy() {
  local output status
  command -v lsof >/dev/null 2>&1 || return 1
  if output="$(lsof -nP -Fp -p "$$" 2>&1)"; then
    status=0
  else
    status=$?
  fi
  S2_LSOF_LAST_OUTPUT="${output}"
  S2_LSOF_LAST_STATUS="${status}"
  [[ ${status} -eq 0 ]] || return 1
  [[ "${output}" == *"p$$"* ]]
}

lsof_scan_has_no_matches() {
  local output status
  output="$(lsof "$@" 2>&1)"
  status=$?
  S2_LSOF_LAST_OUTPUT="${output}"
  S2_LSOF_LAST_STATUS="${status}"
  case "${status}" in
    0) return 1 ;; # A successful scan printed at least one matching open descriptor/listener.
    1) [[ -z "${output}" ]] ;; # The documented lsof no-match result; any diagnostic is failure.
    *) return 1 ;; # Permission, path, or scanner failure is never evidence of zero survivors.
  esac
}

# Recursive lsof scans can briefly observe their own directory-traversal process under load.
# Never exempt a PID class: instead, retry only well-formed machine-mode PID matches and require
# a later actual zero-holder observation. Malformed rows, diagnostics, and scanner errors remain
# immediate failures; a real persistent holder remains visible through the whole bounded sample.
lsof_scan_reaches_no_matches() {
  local attempt line machine_pids
  for attempt in 1 2 3; do
    if lsof_scan_has_no_matches "$@"; then return 0; fi
    [[ "${S2_LSOF_LAST_STATUS}" == 0 || "${S2_LSOF_LAST_STATUS}" == 1 ]] || return 1
    [[ -n "${S2_LSOF_LAST_OUTPUT}" ]] || return 1
    machine_pids=1
    while IFS= read -r line; do
      [[ "${line}" =~ ^[0-9]+$ ]] || { machine_pids=0; break; }
    done <<<"${S2_LSOF_LAST_OUTPUT}"
    [[ ${machine_pids} -eq 1 ]] || return 1
    [[ ${attempt} -lt 3 ]] || return 1
    sleep 0.05
  done
  return 1
}

assert_no_run_survivors() {
  local persist="$1" port="$2" marker="$3" rows line
  S2_SURVIVOR_ASSERTION_FAILURE=""
  lsof_scanner_is_healthy || { S2_SURVIVOR_ASSERTION_FAILURE="lsof-health"; return 1; }
  [[ -d "${persist}" && ! -L "${persist}" ]] || {
    S2_SURVIVOR_ASSERTION_FAILURE="persist-path"
    return 1
  }
  if port_is_busy "${port}"; then
    S2_SURVIVOR_ASSERTION_FAILURE="port-busy"
    return 1
  fi
  rows="$(LC_ALL=C ps -axo pid=,pgid=,ppid=,stat=,command=)" || {
    S2_SURVIVOR_ASSERTION_FAILURE="process-scan"
    return 1
  }
  while IFS= read -r line; do
    [[ "${line}" == *"${persist}"* || "${line}" == *"s2-pinned-supervisor-${marker}"* || \
      "${line}" == *"s2-parent-watchdog-${marker}"* ]] && {
      S2_SURVIVOR_ASSERTION_FAILURE="process-match"
      return 1
    }
  done <<<"${rows}"
  # lsof -t implicitly selects -w (suppress warnings). Re-enable warnings after -t so an
  # inaccessible recursive path cannot collapse to the same exit-1/empty result as no matches.
  lsof_scan_reaches_no_matches -nP -t +w +D "${persist}" || {
    S2_SURVIVOR_ASSERTION_FAILURE="state-fd-scan"
    return 1
  }
  lsof_scan_reaches_no_matches -nP -t +w -iTCP:"${port}" -sTCP:LISTEN || {
    S2_SURVIVOR_ASSERTION_FAILURE="listener-scan"
    return 1
  }
  return 0
}

kill_owned_group_to_zero() {
  local pid="$1" pgid="$2" marker="$3" persist="$4" port="$5" proof_scope="$6" tick
  signal_owned_group KILL "${pid}" "${pgid}" "${marker}" || return 1
  for ((tick = 0; tick < S2_TERMINATE_WAIT_TICKS; tick += 1)); do
    if ! kill -0 -- "-${pgid}" 2>/dev/null; then
      wait "${pid}" 2>/dev/null || :
      if [[ "${proof_scope}" == "server" ]]; then
        assert_no_run_survivors "${persist}" "${port}" "${marker}" || return 1
      fi
      return 0
    fi
    sleep 0.1
  done
  return 1
}

# The legacy raw-SQL lanes can lose their leader to TERM while a deliberately TERM-resistant
# child remains. At that point normal leader-pinned signalling has correctly become unavailable.
# This bounded fallback is narrower: it accepts only the still-visible watchdog command carrying
# both this run's unique marker and its retained evidence path, emits the uncertainty before KILL,
# and never falls back to a PID or a bare/recycled process group.
legacy_residual_group_is_exact() {
  local pgid="$1" marker="$2" persist="$3" rows line pid seen_pgid ppid stat command
  local held_file="${S2_LEGACY_REQUIRED_HELD_FILE:-}" holder_output holder_status holder_pid
  local holder_pgid holder_count=0 watchdog_seen=0
  rows="$(LC_ALL=C ps -axo pid=,pgid=,ppid=,stat=,command=)" || return 1
  while IFS= read -r line; do
    [[ -n "${line}" ]] || continue
    read -r pid seen_pgid ppid stat command <<<"${line}"
    is_decimal "${pid}" && is_decimal "${seen_pgid}" && is_decimal "${ppid}" || return 1
    [[ "${seen_pgid}" == "${pgid}" && "${stat}" != Z* && \
      "${command}" == *"s2-parent-watchdog-${marker}"* && \
      "${command}" == *"${persist}"* ]] && watchdog_seen=1
  done <<<"${rows}"
  [[ ${watchdog_seen} -eq 1 ]] || return 1
  [[ -n "${held_file}" ]] || return 0
  [[ -f "${held_file}" && ! -L "${held_file}" ]] || return 1
  if holder_output="$(lsof -nP -t +w -- "${held_file}" 2>&1)"; then
    holder_status=0
  else
    holder_status=$?
  fi
  [[ ${holder_status} -eq 0 || ${holder_status} -eq 1 ]] || return 1
  [[ -n "${holder_output}" ]] || return 1
  while IFS= read -r holder_pid; do
    is_decimal "${holder_pid}" || return 1
    holder_pgid="$(LC_ALL=C ps -o pgid= -p "${holder_pid}" 2>/dev/null | tr -d '[:space:]')" || return 1
    [[ "${holder_pgid}" == "${pgid}" ]] || return 1
    holder_count=$((holder_count + 1))
  done <<<"${holder_output}"
  [[ ${holder_count} -eq 1 ]]
}

legacy_reap_leader_lost_group() {
  local pid="$1" pgid="$2" marker="$3" persist="$4" port="$5" tick kill_tick
  local holder_line holder_pid observed_holder_pgid holder_count=0
  local controller_holds_state=false exact_group_holds_state=false
  for ((tick = 0; tick < S2_LEGACY_STOP_INSPECTION_TICKS; tick += 1)); do
    if ! kill -0 -- "-${pgid}" 2>/dev/null; then
      wait "${pid}" 2>/dev/null || :
      assert_no_run_survivors "${persist}" "${port}" "${marker}" || return 1
      S2_LEGACY_STOP_REAPED_UNCERTAIN=1
      return 1
    fi
    if legacy_residual_group_is_exact "${pgid}" "${marker}" "${persist}"; then
      emit "{\"tool\":\"bash\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-local-d1-upgrade\",\"status\":\"fail\",\"code\":\"S2_LEGACY_SUPERVISOR_INSPECTION_UNCERTAIN\",\"state\":\"inspection-uncertain\",\"action\":\"kill-exact-residual-group\",\"reproduce\":\"scripts/e2e-s2-krater.sh\"}"
      # We reached this branch only after TERM was sent with a fresh exact-leader proof, and the
      # bounded scan above still sees the same run's watchdog marker in the same group. This is
      # the sole post-leader-loss KILL authority; anything less exact remains a hard refusal.
      if ! kill -KILL -- "-${pgid}" 2>/dev/null; then
        emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-local-d1-upgrade","status":"fail","code":"S2_LEGACY_EXACT_RESIDUAL_KILL_FAILED","reproduce":"scripts/e2e-s2-krater.sh"}'
        return 1
      fi
      for ((kill_tick = 0; kill_tick < S2_TERMINATE_WAIT_TICKS; kill_tick += 1)); do
        if ! kill -0 -- "-${pgid}" 2>/dev/null; then
          wait "${pid}" 2>/dev/null || :
          if ! assert_no_run_survivors "${persist}" "${port}" "${marker}"; then
            if [[ "${S2_SURVIVOR_ASSERTION_FAILURE:-}" == "state-fd-scan" ]]; then
              while IFS= read -r holder_line; do
                [[ -n "${holder_line}" ]] || continue
                if [[ ! "${holder_line}" =~ ^([0-9]+)$ ]]; then
                  holder_count=-1
                  break
                fi
                holder_pid="${BASH_REMATCH[1]}"
                holder_count=$((holder_count + 1))
                [[ "${holder_pid}" == "$$" ]] && controller_holds_state=true
                observed_holder_pgid="$(LC_ALL=C ps -o pgid= -p "${holder_pid}" 2>/dev/null | tr -d '[:space:]')" || observed_holder_pgid=""
                [[ "${observed_holder_pgid}" == "${pgid}" ]] && exact_group_holds_state=true
              done <<<"${S2_LSOF_LAST_OUTPUT}"
            fi
            emit "{\"tool\":\"bash+lsof+ps\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-local-d1-upgrade\",\"status\":\"fail\",\"code\":\"S2_LEGACY_EXACT_RESIDUAL_POSTCONDITION_UNPROVEN\",\"check\":\"${S2_SURVIVOR_ASSERTION_FAILURE:-unknown}\",\"state_holder_count\":$(json_decimal_or_null "${holder_count}"),\"controller_holds_state\":$(json_bool "${controller_holds_state}"),\"exact_group_holds_state\":$(json_bool "${exact_group_holds_state}"),\"reproduce\":\"scripts/e2e-s2-krater.sh\"}"
            return 1
          fi
          S2_LEGACY_STOP_REAPED_UNCERTAIN=1
          return 1
        fi
        sleep 0.1
      done
      emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-local-d1-upgrade","status":"fail","code":"S2_LEGACY_EXACT_RESIDUAL_GROUP_SURVIVED","reproduce":"scripts/e2e-s2-krater.sh"}'
      return 1
    fi
    sleep 0.1
  done
  emit "{\"tool\":\"bash\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-local-d1-upgrade\",\"status\":\"fail\",\"code\":\"S2_LEGACY_SUPERVISOR_INSPECTION_UNCERTAIN\",\"state\":\"inspection-uncertain\",\"action\":\"refuse-unproven-residual-group\",\"reproduce\":\"scripts/e2e-s2-krater.sh\"}"
  return 1
}

# A shell-regression child can deliberately model the retired pre-publication hook: its parent
# has already exited, so supervisor_is_owned correctly refuses it because PPID is now 1. This
# bounded reaper is narrower than normal cleanup. It requires the original PID/PGID plus the
# randomized supervisor marker in the live leader command before one KILL of that exact group;
# it never authorizes a bare numeric group or prints command text.
reap_parent_terminated_supervisor_residual() {
  local pid="$1" pgid="$2" marker="$3" persist="$4" port="$5"
  local rows line seen_pid seen_pgid seen_ppid seen_stat seen_command tick leader_seen=0
  is_decimal "${pid}" && is_decimal "${pgid}" && is_decimal "${port}" && \
    [[ "${pid}" == "${pgid}" && -n "${marker}" && -d "${persist}" && ! -L "${persist}" ]] || return 1
  rows="$(LC_ALL=C ps -axo pid=,pgid=,ppid=,stat=,command=)" || return 1
  while IFS= read -r line; do
    [[ -n "${line}" ]] || continue
    read -r seen_pid seen_pgid seen_ppid seen_stat seen_command <<<"${line}"
    is_decimal "${seen_pid}" && is_decimal "${seen_pgid}" && is_decimal "${seen_ppid}" || return 1
    if [[ "${seen_pid}" == "${pid}" && "${seen_pgid}" == "${pgid}" && \
      "${seen_ppid}" == "1" && "${seen_stat}" != Z* && \
      "${seen_command}" == *"s2-pinned-supervisor-${marker}"* ]]; then
      leader_seen=1
    fi
  done <<<"${rows}"
  [[ ${leader_seen} -eq 1 ]] || return 1
  kill -KILL -- "-${pgid}" 2>/dev/null || return 1
  for ((tick = 0; tick < S2_TERMINATE_WAIT_TICKS; tick += 1)); do
    if ! kill -0 -- "-${pgid}" 2>/dev/null; then
      wait "${pid}" 2>/dev/null || :
      assert_no_run_survivors "${persist}" "${port}" "${marker}"
      return $?
    fi
    sleep 0.1
  done
  return 1
}

clear_most_recent_supervisor_if_marker() {
  local marker="$1" latest_marker
  [[ -n "${S2_MOST_RECENT_SUPERVISOR}" ]] || return 0
  read -r _ _ _ latest_marker _ <<<"${S2_MOST_RECENT_SUPERVISOR}"
  [[ -n "${marker}" && "${marker}" == "${latest_marker}" ]] || return 0
  S2_MOST_RECENT_SUPERVISOR=""
}

stop_pinned_supervisor() {
  local pid="$1" pgid="$2" marker="$3" watchdog_pid="$4" watchdog_health="$5"
  local persist="$6" port="$7" proof_scope="${8:-server}" tick release_tick
  [[ -n "${pid}" ]] || return 0
  if ! watchdog_is_healthy "${watchdog_pid}" "${pid}" "${pgid}" "${marker}" \
    "${watchdog_health}"; then
    # The watchdog's exact healthy identity is part of the lifecycle contract. Its absence or
    # published inspection uncertainty is a hard failure, but the still-proved group leader is
    # sufficient authority to kill this exact group and establish zero survivors.
    if kill_owned_group_to_zero "${pid}" "${pgid}" "${marker}" "${persist}" "${port}" \
      "${proof_scope}"; then
      clear_most_recent_supervisor_if_marker "${marker}"
    else
      return 1
    fi
    return 1
  fi
  signal_owned_group TERM "${pid}" "${pgid}" "${marker}" || return 1

  for ((tick = 0; tick < S2_TERMINATE_WAIT_TICKS; tick += 1)); do
    if ! supervisor_is_owned "${pid}" "${pgid}" "${marker}"; then
      if ! kill -0 -- "-${pgid}" 2>/dev/null; then
        wait "${pid}" 2>/dev/null || :
        # The TERM was sent only after proving this exact group. If that signal has already
        # removed the complete group, accepting the observed zero-survivor postcondition avoids
        # turning a clean, bounded release race into an ownership error. A live but unprovable
        # group still fails closed below.
        if [[ "${proof_scope}" == "server" ]]; then
          assert_no_run_survivors "${persist}" "${port}" "${marker}" || return 1
        fi
        clear_most_recent_supervisor_if_marker "${marker}"
        return 0
      fi
      if [[ "${S2_LEGACY_STOP_CONTEXT:-0}" == 1 && "${proof_scope}" == "server" ]]; then
        legacy_reap_leader_lost_group "${pid}" "${pgid}" "${marker}" "${persist}" "${port}"
        return 1
      fi
      return 1
    fi
    if ! group_members "${pgid}"; then
      if kill_owned_group_to_zero "${pid}" "${pgid}" "${marker}" "${persist}" "${port}" \
        "${proof_scope}"; then
        clear_most_recent_supervisor_if_marker "${marker}"
      else
        return 1
      fi
      return 1
    fi
    if [[ ${S2_GROUP_MEMBER_COUNT} -le 2 ]]; then
      # The watchdog was proved before the group TERM. It may legitimately observe that TERM and
      # exit before this next inspection. If the other member is not that watchdog, it is an
      # unexpected TERM-resistant payload: keep the leader alive and KILL this still-proved exact
      # group. Releasing the leader first would make that survivor uninspectable and losable.
      if [[ ${S2_GROUP_MEMBER_COUNT} -eq 2 ]] && ! group_contains_pid "${watchdog_pid}"; then
        if kill_owned_group_to_zero "${pid}" "${pgid}" "${marker}" "${persist}" "${port}" \
          "${proof_scope}"; then
          clear_most_recent_supervisor_if_marker "${marker}"
          return 0
        fi
        return 1
      fi
      # At this point the group is only the leader, or the leader plus its exact watchdog. The
      # group is in terminal teardown, so release only that exact leader.
      release_owned_supervisor "${pid}" "${pgid}" "${marker}" || return 1
      for ((release_tick = 0; release_tick < S2_TERMINATE_WAIT_TICKS; release_tick += 1)); do
        if ! kill -0 -- "-${pgid}" 2>/dev/null; then
          wait "${pid}" 2>/dev/null || :
          if [[ "${proof_scope}" == "server" ]]; then
            assert_no_run_survivors "${persist}" "${port}" "${marker}" || return 1
          fi
          clear_most_recent_supervisor_if_marker "${marker}"
          return 0
        fi
        sleep 0.1
      done
      # The leader was released only after we observed no non-watchdog peer. A later survivor is
      # no longer signal-authorized because the leader is gone, so this remains a hard failure.
      return 1
    fi
    sleep 0.1
  done

  # A TERM-resistant descendant is still inside the exact leader-pinned group. The fresh leader
  # proof in this helper authorizes KILL of that group only; there is no PID fallback.
  if kill_owned_group_to_zero "${pid}" "${pgid}" "${marker}" "${persist}" "${port}" \
    "${proof_scope}"; then
    clear_most_recent_supervisor_if_marker "${marker}"
    return 0
  fi
  return 1
}

server_is_owned() {
  supervisor_is_owned "${S2_SERVER_PID}" "${S2_SERVER_PGID}" "${S2_SERVER_MARKER}" && \
    watchdog_is_healthy "${S2_SERVER_WATCHDOG_PID}" "${S2_SERVER_PID}" \
      "${S2_SERVER_PGID}" "${S2_SERVER_MARKER}" "${S2_SERVER_WATCHDOG_HEALTH}"
}

stop_worker() {
  local stopped_marker
  if [[ "${S2_PLANT_STOP_WORKER_FAILURE:-0}" == 1 ]]; then
    # Regression-only in-process mutation. The legacy wrapper must return failure before it
    # restores the origin, so this mutation is intentionally observable by its caller.
    S2_ACTIVE_ORIGIN="${S2_PLANT_STOP_WORKER_MUTATED_ORIGIN:-}"
    return 91
  fi
  [[ -n "${S2_SERVER_PID}" ]] || return 0
  stopped_marker="${S2_SERVER_MARKER}"
  stop_pinned_supervisor \
    "${S2_SERVER_PID}" "${S2_SERVER_PGID}" "${S2_SERVER_MARKER}" \
    "${S2_SERVER_WATCHDOG_PID}" "${S2_SERVER_WATCHDOG_HEALTH}" \
    "${S2_SERVER_PERSIST}" "${S2_SERVER_PORT}" || return 1
  S2_SERVER_PID=""
  S2_SERVER_PGID=""
  S2_SERVER_MARKER=""
  S2_SERVER_WATCHDOG_PID=""
  S2_SERVER_WATCHDOG_HEALTH=""
  S2_SERVER_PERSIST=""
  S2_SERVER_PORT=""
  S2_ACTIVE_HARNESS_TOKEN=""
  S2_ACTIVE_HARNESS_RUN_ID=""
  clear_most_recent_supervisor_if_marker "${stopped_marker}"
}

remember_lifecycle_supervisor() {
  S2_LIFECYCLE_OWNED_PIDS+=("$1")
  S2_LIFECYCLE_OWNED_PGIDS+=("$2")
  S2_LIFECYCLE_OWNED_MARKERS+=("$3")
  S2_LIFECYCLE_OWNED_STATUS_FILES+=("$4")
  S2_LIFECYCLE_OWNED_WATCHDOG_PIDS+=("$5")
  S2_LIFECYCLE_OWNED_WATCHDOG_HEALTH_FILES+=("$6")
  S2_LIFECYCLE_OWNED_STATE_DIRS+=("$7")
  S2_LIFECYCLE_OWNED_PORTS+=("$8")
}

forget_lifecycle_supervisor() {
  local marker="$1" index
  for index in "${!S2_LIFECYCLE_OWNED_MARKERS[@]}"; do
    if [[ -n "${marker}" && "${S2_LIFECYCLE_OWNED_MARKERS[index]}" == "${marker}" ]]; then
      # Preserve the slot so Bash 3's indexed-array behavior stays simple; blank means its
      # supervisor was released and must not be signalled again by EXIT cleanup.
      S2_LIFECYCLE_OWNED_PIDS[index]=""
      S2_LIFECYCLE_OWNED_PGIDS[index]=""
      S2_LIFECYCLE_OWNED_MARKERS[index]=""
      S2_LIFECYCLE_OWNED_STATUS_FILES[index]=""
      S2_LIFECYCLE_OWNED_WATCHDOG_PIDS[index]=""
      S2_LIFECYCLE_OWNED_WATCHDOG_HEALTH_FILES[index]=""
      S2_LIFECYCLE_OWNED_STATE_DIRS[index]=""
      S2_LIFECYCLE_OWNED_PORTS[index]=""
      clear_most_recent_supervisor_if_marker "${marker}"
      return 0
    fi
  done
  return 1
}

# shellcheck disable=SC2329
stop_lifecycle_supervisors() {
  local index pid marker result=0
  for index in "${!S2_LIFECYCLE_OWNED_PIDS[@]}"; do
    pid="${S2_LIFECYCLE_OWNED_PIDS[index]}"
    [[ -n "${pid}" ]] || continue
    marker="${S2_LIFECYCLE_OWNED_MARKERS[index]}"
    if stop_pinned_supervisor \
      "${pid}" \
      "${S2_LIFECYCLE_OWNED_PGIDS[index]}" \
      "${S2_LIFECYCLE_OWNED_MARKERS[index]}" \
      "${S2_LIFECYCLE_OWNED_WATCHDOG_PIDS[index]}" \
      "${S2_LIFECYCLE_OWNED_WATCHDOG_HEALTH_FILES[index]}" \
      "${S2_LIFECYCLE_OWNED_STATE_DIRS[index]}" \
      "${S2_LIFECYCLE_OWNED_PORTS[index]}" client; then
      forget_lifecycle_supervisor "${marker}" || return 1
    else
      result=1
    fi
  done
  return "${result}"
}

# shellcheck disable=SC2329
most_recent_supervisor_is_tracked() {
  local marker="$1" index
  [[ -n "${S2_SERVER_MARKER}" && "${marker}" == "${S2_SERVER_MARKER}" ]] && return 0
  for index in "${!S2_LIFECYCLE_OWNED_MARKERS[@]}"; do
    [[ -n "${S2_LIFECYCLE_OWNED_MARKERS[index]}" && \
      "${marker}" == "${S2_LIFECYCLE_OWNED_MARKERS[index]}" ]] && return 0
  done
  return 1
}

# The ordinary Worker and explicit lifecycle arrays own their own release paths. This covers
# only the short, otherwise-unowned interval after the newest pinned supervisor reports ready
# and before its caller records that ownership. It never signals a bare numeric group:
# supervisor_is_owned proves PID, PGID, PPID, and randomized marker immediately before cleanup.
# shellcheck disable=SC2329
stop_most_recent_untracked_supervisor() {
  local pid pgid expected_ppid marker watchdog_pid watchdog_health persist port proof_scope
  [[ -n "${S2_MOST_RECENT_SUPERVISOR}" ]] || return 0
  read -r pid pgid expected_ppid marker watchdog_pid watchdog_health persist port proof_scope \
    <<<"${S2_MOST_RECENT_SUPERVISOR}"
  is_decimal "${pid}" && is_decimal "${pgid}" && is_decimal "${expected_ppid}" && \
    is_decimal "${watchdog_pid}" && [[ "${pid}" == "${pgid}" && \
    "${expected_ppid}" == "${S2_PARENT_PID}" && -n "${marker}" && -n "${watchdog_health}" && \
    -d "${persist}" && ! -L "${persist}" && "${port}" =~ ^[0-9]+$ ]] || return 1
  case "${proof_scope}" in
    server|client) ;;
    *) return 1 ;;
  esac
  if most_recent_supervisor_is_tracked "${marker}"; then
    clear_most_recent_supervisor_if_marker "${marker}"
    return 0
  fi

  if ! supervisor_is_owned "${pid}" "${pgid}" "${marker}"; then
    # A previously completed/explicitly released exact supervisor is not an error, but prove
    # that no marker or run-owned survivor remains. This is inspection, not a numeric group
    # signal; without the fresh identity proof above no signal is attempted.
    if ! kill -0 -- "-${pgid}" 2>/dev/null; then
      wait "${pid}" 2>/dev/null || :
      if [[ "${proof_scope}" != "server" ]] || \
        assert_no_run_survivors "${persist}" "${port}" "${marker}"; then
        clear_most_recent_supervisor_if_marker "${marker}"
        return 0
      fi
      return 1
    fi
    if [[ "${proof_scope}" == "server" ]] && \
      assert_no_run_survivors "${persist}" "${port}" "${marker}"; then
      clear_most_recent_supervisor_if_marker "${marker}"
      return 0
    fi
    return 1
  fi
  if stop_pinned_supervisor \
    "${pid}" "${pgid}" "${marker}" "${watchdog_pid}" "${watchdog_health}" \
    "${persist}" "${port}" "${proof_scope}"; then
    clear_most_recent_supervisor_if_marker "${marker}"
    return 0
  fi
  # stop_pinned_supervisor deliberately reports a missing/stale watchdog as failure even after
  # it has KILLed the freshly proved exact group. For EXIT cleanup that zero-survivor result is
  # complete: preserve the parent’s original signal status instead of converting it to 125.
  if [[ "${proof_scope}" == "client" ]] && ! kill -0 -- "-${pgid}" 2>/dev/null; then
    clear_most_recent_supervisor_if_marker "${marker}"
    return 0
  fi
  if [[ "${proof_scope}" == "server" ]] && \
    assert_no_run_survivors "${persist}" "${port}" "${marker}"; then
    clear_most_recent_supervisor_if_marker "${marker}"
    return 0
  fi
  return 1
}

# shellcheck disable=SC2329
cleanup_workers() {
  local result=0
  stop_most_recent_untracked_supervisor || result=1
  stop_lifecycle_supervisors || result=1
  stop_worker || result=1
  if [[ ${result} -ne 0 ]]; then
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-lifecycle","status":"fail","code":"S2_CLEANUP_OWNERSHIP_UNPROVEN","reproduce":"scripts/e2e-s2-krater.sh"}'
    return 1
  fi
}

# shellcheck disable=SC2329
write_evidence_receipt() {
  local exit_code="$1" publish_cost_receipt="${2:-0}"
  # Environment is the typed input boundary for the Bun receipt writer below.
  # shellcheck disable=SC2034,SC2016
  S2_RECEIPT_ROOT="${S2_RUN_DIR}" \
  S2_RECEIPT_PATH="${S2_COST_MANIFEST_PATH}" \
  S2_RECEIPT_RELATIVE_PATH="${S2_RUN_DIR#./}/${S2_COST_MANIFEST_RELATIVE_PATH}" \
  S2_RECEIPT_RUN_ID="${S2_RUN_ID}" \
  S2_RECEIPT_REVISION="${S2_GIT_HEAD}" \
  S2_RECEIPT_DIRTY_STATE="${S2_GIT_DIRTY}" \
  S2_RECEIPT_SOURCE_DIGEST="${S2_SOURCE_DIGEST}" \
  S2_RECEIPT_EXIT_CODE="${exit_code}" \
  S2_RECEIPT_MAX_BYTES="${S2_MAX_RETAINED_BYTES}" \
  S2_RECEIPT_MAX_FILES="${S2_MAX_RETAINED_FILES}" \
  S2_RECEIPT_COST_RELATIVE_PATH="${S2_COST_RECEIPT_RELATIVE_PATH}" \
  S2_RECEIPT_PUBLISH_COST_RECEIPT="${publish_cost_receipt}" \
  S2_RECEIPT_PHASE_EXERCISE="${S2_COST_PHASE_EXERCISE}" \
  S2_RECEIPT_PHASE_RESTART_VERIFY="${S2_COST_PHASE_RESTART_VERIFY}" \
  S2_RECEIPT_PHASE_UPGRADE_EXISTING="${S2_COST_PHASE_UPGRADE_EXISTING}" \
  S2_RECEIPT_PHASE_UPGRADE_EMPTY="${S2_COST_PHASE_UPGRADE_EMPTY}" \
  S2_RECEIPT_PHASE_UPGRADE_JOURNAL_EXISTING="${S2_COST_PHASE_UPGRADE_JOURNAL_EXISTING}" \
  S2_RECEIPT_PHASE_UPGRADE_JOURNAL_EMPTY="${S2_COST_PHASE_UPGRADE_JOURNAL_EMPTY}" \
  bun --eval '
    import { createHash } from "node:crypto";
    import {
      parseS2CostEvidenceManifestBytes,
      S2_COST_DURABLE_PUBLICATION_RESERVED_BYTES,
      S2_COST_DURABLE_PUBLICATION_RESERVED_NAMES,
      S2_COST_EVIDENCE_MANIFEST_VERSION,
      S2_COST_MANIFEST_PENDING_RELATIVE_PATH,
      S2_COST_MANIFEST_RELATIVE_PATH,
      S2_COST_RECEIPT_RELATIVE_PATH,
    } from "@asimposium/contracts";
    import {
      closeSync,
      constants,
      fstatSync,
      fsyncSync,
      linkSync,
      lstatSync,
      openSync,
      readFileSync,
      readdirSync,
      writeSync,
    } from "node:fs";
    import { basename, dirname, relative, resolve } from "node:path";

    const root = process.env.S2_RECEIPT_ROOT ?? "";
    const receiptPath = process.env.S2_RECEIPT_PATH ?? "";
    const relativeReceiptPath = process.env.S2_RECEIPT_RELATIVE_PATH ?? "";
    const costReceiptRelativePath = process.env.S2_RECEIPT_COST_RELATIVE_PATH ?? "";
    const maxBytes = Number(process.env.S2_RECEIPT_MAX_BYTES);
    const maxFiles = Number(process.env.S2_RECEIPT_MAX_FILES);
    const capturedExitCode = Number(process.env.S2_RECEIPT_EXIT_CODE);
    const capturedRunStatus =
      capturedExitCode === 0 ? "pass" : capturedExitCode === 78 ? "blocked" : "fail";
    const publishCostReceipt = process.env.S2_RECEIPT_PUBLISH_COST_RECEIPT === "1";
    const localPhaseStatus = {
      exercise: process.env.S2_RECEIPT_PHASE_EXERCISE,
      restart_verify: process.env.S2_RECEIPT_PHASE_RESTART_VERIFY,
      upgrade_existing: process.env.S2_RECEIPT_PHASE_UPGRADE_EXISTING,
      upgrade_empty: process.env.S2_RECEIPT_PHASE_UPGRADE_EMPTY,
      upgrade_journal_existing: process.env.S2_RECEIPT_PHASE_UPGRADE_JOURNAL_EXISTING,
      upgrade_journal_empty: process.env.S2_RECEIPT_PHASE_UPGRADE_JOURNAL_EMPTY,
    };
    // A successful call leaves an immutable final name only after the private
    // sibling has been completely written, fsynced, validated, hard-linked
    // without replacement, read back, and the owned directory fsynced. The
    // sibling is intentionally retained on every path: evidence is never
    // deleted by this harness.
    const writeExclusiveDurably = (destination, pendingRelativePath, body) => {
      const directory = dirname(destination);
      const privateSibling = resolve(directory, pendingRelativePath);
      if (
        basename(privateSibling) !== pendingRelativePath ||
        dirname(privateSibling) !== resolve(directory)
      ) throw new Error("pending-path");
      const bytes = Buffer.from(body, "utf8");
      let descriptor;
      let directoryDescriptor;
      try {
        const directoryStat = lstatSync(directory);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("directory");
        descriptor = openSync(
          privateSibling,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          0o600,
        );
        let offset = 0;
        while (offset < bytes.byteLength) {
          const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
          if (!Number.isSafeInteger(written) || written <= 0) throw new Error("short-write");
          offset += written;
        }
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        const privateStat = lstatSync(privateSibling);
        if (!privateStat.isFile() || privateStat.isSymbolicLink() || (privateStat.mode & 0o777) !== 0o600) {
          throw new Error("private-sibling");
        }
        if (Buffer.compare(readFileSync(privateSibling), bytes) !== 0) throw new Error("private-readback");
        // link(2) creates destination only when absent, unlike rename which can replace it.
        linkSync(privateSibling, destination);
        directoryDescriptor = openSync(directory, constants.O_RDONLY);
        fsyncSync(directoryDescriptor);
        closeSync(directoryDescriptor);
        directoryDescriptor = undefined;
        const finalStat = lstatSync(destination);
        if (!finalStat.isFile() || finalStat.isSymbolicLink() || (finalStat.mode & 0o777) !== 0o600) {
          throw new Error("final");
        }
        if (Buffer.compare(readFileSync(destination), bytes) !== 0) throw new Error("final-readback");
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
        if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
      }
    };
    const files = [];
    const visit = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const pathname = resolve(directory, entry.name);
        const stat = lstatSync(pathname);
        if (stat.isSymbolicLink()) throw new Error("symlink");
        if (stat.isDirectory()) {
          visit(pathname);
          continue;
        }
        files.push({
          path: relative(root, pathname).split("\\\\").join("/"),
          bytes: stat.size,
          kind: stat.isFile() ? "file" : stat.isFIFO() ? "fifo" : "special",
        });
      }
    };

    try {
      if (!root || !receiptPath) throw new Error("root");
      const rootStat = lstatSync(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("root");
      visit(root);
      files.sort((left, right) => left.path.localeCompare(right.path));
      const retainedBytes = files.reduce((sum, file) => sum + file.bytes, 0);
      const reservedNames = [...S2_COST_DURABLE_PUBLICATION_RESERVED_NAMES];
      if (files.some((file) => reservedNames.includes(file.path))) throw new Error("reservation-name");
      if (
        files.length + reservedNames.length > maxFiles ||
        retainedBytes + S2_COST_DURABLE_PUBLICATION_RESERVED_BYTES > maxBytes
      ) throw new Error("reservation-bound");
      if (costReceiptRelativePath !== S2_COST_RECEIPT_RELATIVE_PATH) throw new Error("cost-receipt-path");
      const costReceipt = files.find((file) => file.path === costReceiptRelativePath);
      const costReceiptSummary =
        !publishCostReceipt || costReceipt === undefined
          ? null
          : (() => {
              if (costReceipt.kind !== "file") throw new Error("cost-receipt-kind");
              const bytes = readFileSync(resolve(root, costReceiptRelativePath));
              if (bytes.byteLength !== costReceipt.bytes) throw new Error("cost-receipt-size");
              return {
                path: costReceiptRelativePath,
                digest: createHash("sha256").update(bytes).digest("hex"),
                bytes: costReceipt.bytes,
              };
            })();
      const manifest = {
        manifest_version: S2_COST_EVIDENCE_MANIFEST_VERSION,
        run_id: process.env.S2_RECEIPT_RUN_ID,
        revision: process.env.S2_RECEIPT_REVISION,
        dirty_state: process.env.S2_RECEIPT_DIRTY_STATE,
        source_digest: process.env.S2_RECEIPT_SOURCE_DIGEST,
        exit_code: capturedExitCode,
        local_phase_status: localPhaseStatus,
        retention: {
          retained: true,
          deletion_performed: false,
          max_bytes_per_run: maxBytes,
          max_files_per_run: maxFiles,
          retained_bytes_before_manifest: retainedBytes,
          retained_files_before_manifest: files.length,
          durable_publication_reservation: {
            retained_names: reservedNames,
            reserved_bytes_upper_bound: S2_COST_DURABLE_PUBLICATION_RESERVED_BYTES,
          },
        },
        s2_cost_receipt: costReceiptSummary,
        files,
      };
      const body = `${JSON.stringify(manifest)}\n`;
      if (relative(root, receiptPath) !== S2_COST_MANIFEST_RELATIVE_PATH) {
        throw new Error("manifest-path");
      }
      parseS2CostEvidenceManifestBytes(Buffer.from(body, "utf8"));
      writeExclusiveDurably(receiptPath, S2_COST_MANIFEST_PENDING_RELATIVE_PATH, body);
      const manifestDigest = new Bun.CryptoHasher("sha256").update(body).digest("hex");
      console.log(JSON.stringify({
        tool: "bash+bun",
        package: "apps/wire",
        suite: "s2-krater-evidence",
        // This is a terminal record for the run whose bytes were retained, so
        // its top-level status must never turn a failed or blocked run green.
        // Retention has its own explicit status below.
        status: capturedRunStatus,
        evidence_retention_status: "pass",
        captured_exit_code: capturedExitCode,
        captured_run_status: capturedRunStatus,
        run_id: process.env.S2_RECEIPT_RUN_ID,
        manifest: relativeReceiptPath,
        manifest_digest: manifestDigest,
        retained_bytes_before_manifest: retainedBytes,
        retained_files_before_manifest: files.length,
        durable_publication_reserved_bytes: S2_COST_DURABLE_PUBLICATION_RESERVED_BYTES,
        durable_publication_reserved_names: reservedNames,
        max_retained_bytes: maxBytes,
        max_retained_files: maxFiles,
        deletion_performed: false,
        reproduce: "scripts/e2e-s2-krater.sh",
      }));
    } catch {
      console.log(JSON.stringify({
        tool: "bash+bun",
        package: "apps/wire",
        suite: "s2-krater-evidence",
        status: "fail",
        code: "S2_EVIDENCE_RECEIPT_FAILED",
        run_id: process.env.S2_RECEIPT_RUN_ID,
        reproduce: "scripts/e2e-s2-krater.sh",
      }));
      process.exit(1);
    }
  '
}

# A receipt is merely a candidate until every required local phase has passed and this immutable
# sidecar binds the final generic manifest digest, receipt digest, and exact provenance. A
# partial/failed sidecar is never accepted by the S-7 CLI; this harness never removes it.
# shellcheck disable=SC2329
write_s2_cost_publication() {
  # shellcheck disable=SC2034,SC2016
  S2_PUBLICATION_ROOT="${S2_RUN_DIR}" \
  S2_PUBLICATION_MANIFEST="${S2_COST_MANIFEST_PATH}" \
  S2_PUBLICATION_RECEIPT="${S2_COST_RECEIPT_PATH}" \
  S2_PUBLICATION_PATH="${S2_COST_PUBLICATION_PATH}" \
  bun --eval '
    import { createHash } from "node:crypto";
    import {
      parseS2CostEvidenceManifestBytes,
      parseS2CostReceiptPublicationBytes,
      S2_COST_EVIDENCE_MANIFEST_VERSION,
      S2_COST_MANIFEST_RELATIVE_PATH,
      S2_COST_PUBLICATION_PENDING_RELATIVE_PATH,
      S2_COST_PUBLICATION_RECORD,
      S2_COST_PUBLICATION_RELATIVE_PATH,
      S2_COST_PUBLICATION_SCHEMA_VERSION,
      S2_COST_RECEIPT_RELATIVE_PATH,
    } from "@asimposium/contracts";
    import {
      closeSync,
      constants,
      fsyncSync,
      linkSync,
      lstatSync,
      openSync,
      readFileSync,
      writeSync,
    } from "node:fs";
    import { basename, dirname, resolve } from "node:path";

    const root = process.env.S2_PUBLICATION_ROOT ?? "";
    const manifestPath = process.env.S2_PUBLICATION_MANIFEST ?? "";
    const receiptPath = process.env.S2_PUBLICATION_RECEIPT ?? "";
    const publicationPath = process.env.S2_PUBLICATION_PATH ?? "";
    const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
    const writeExclusiveDurably = (destination, pendingRelativePath, body) => {
      const directory = dirname(destination);
      const privateSibling = resolve(directory, pendingRelativePath);
      if (
        basename(privateSibling) !== pendingRelativePath ||
        dirname(privateSibling) !== resolve(directory)
      ) throw new Error("pending-path");
      const bytes = Buffer.from(body, "utf8");
      let descriptor;
      let directoryDescriptor;
      try {
        const directoryStat = lstatSync(directory);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("directory");
        descriptor = openSync(
          privateSibling,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          0o600,
        );
        let offset = 0;
        while (offset < bytes.byteLength) {
          const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
          if (!Number.isSafeInteger(written) || written <= 0) throw new Error("short-write");
          offset += written;
        }
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        const privateStat = lstatSync(privateSibling);
        if (!privateStat.isFile() || privateStat.isSymbolicLink() || (privateStat.mode & 0o777) !== 0o600) {
          throw new Error("private-sibling");
        }
        if (Buffer.compare(readFileSync(privateSibling), bytes) !== 0) throw new Error("private-readback");
        linkSync(privateSibling, destination);
        directoryDescriptor = openSync(directory, constants.O_RDONLY);
        fsyncSync(directoryDescriptor);
        closeSync(directoryDescriptor);
        directoryDescriptor = undefined;
        const finalStat = lstatSync(destination);
        if (!finalStat.isFile() || finalStat.isSymbolicLink() || (finalStat.mode & 0o777) !== 0o600) {
          throw new Error("final");
        }
        if (Buffer.compare(readFileSync(destination), bytes) !== 0) throw new Error("final-readback");
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
        if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
      }
    };
    try {
      if (!root) throw new Error("root");
      const rootStat = lstatSync(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("root");
      if (
        resolve(manifestPath) !== resolve(root, S2_COST_MANIFEST_RELATIVE_PATH) ||
        resolve(receiptPath) !== resolve(root, S2_COST_RECEIPT_RELATIVE_PATH) ||
        resolve(publicationPath) !== resolve(root, S2_COST_PUBLICATION_RELATIVE_PATH)
      ) throw new Error("path");
      for (const pathname of [manifestPath, receiptPath]) {
        const stat = lstatSync(pathname);
        if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) throw new Error("artifact");
      }
      const manifestBytes = readFileSync(manifestPath);
      const receiptBytes = readFileSync(receiptPath);
      const manifest = parseS2CostEvidenceManifestBytes(manifestBytes);
      const phases = manifest.local_phase_status;
      if (
        manifest.manifest_version !== S2_COST_EVIDENCE_MANIFEST_VERSION || manifest.exit_code !== 78 ||
        !manifest.s2_cost_receipt || manifest.s2_cost_receipt.path !== S2_COST_RECEIPT_RELATIVE_PATH ||
        manifest.s2_cost_receipt.digest !== digest(receiptBytes) ||
        manifest.s2_cost_receipt.bytes !== receiptBytes.byteLength ||
        !phases || Object.values(phases).some((value) => value !== "pass")
      ) throw new Error("attestation");
      const publication = {
        schema_version: S2_COST_PUBLICATION_SCHEMA_VERSION,
        record: S2_COST_PUBLICATION_RECORD,
        manifest: { path: S2_COST_MANIFEST_RELATIVE_PATH, digest: digest(manifestBytes) },
        receipt: { path: S2_COST_RECEIPT_RELATIVE_PATH, digest: digest(receiptBytes), bytes: receiptBytes.byteLength },
        provenance: {
          run_id: manifest.run_id,
          revision: manifest.revision,
          dirty_state: manifest.dirty_state,
          source_digest: manifest.source_digest,
        },
        local_phase_status: phases,
      };
      const body = `${JSON.stringify(publication)}\n`;
      parseS2CostReceiptPublicationBytes(Buffer.from(body, "utf8"));
      writeExclusiveDurably(publicationPath, S2_COST_PUBLICATION_PENDING_RELATIVE_PATH, body);
      console.log(JSON.stringify({ tool: "bash+bun", package: "apps/wire", suite: "s2-cost-publication", status: "pass", reproduce: "scripts/e2e-s2-krater.sh" }));
    } catch {
      console.log(JSON.stringify({ tool: "bash+bun", package: "apps/wire", suite: "s2-cost-publication", status: "fail", code: "S2_COST_PUBLICATION_FAILED", reproduce: "scripts/e2e-s2-krater.sh" }));
      process.exit(1);
    }
  '
}

# Publication itself is still an incomplete statement: this final immutable record binds the
# receipt, manifest, and publication together after every local phase has passed. The final
# name and its retained pending sibling are both reserved by the manifest written beforehand.
# shellcheck disable=SC2329
write_s2_cost_publication_commit() {
  # shellcheck disable=SC2034,SC2016
  S2_COMMIT_ROOT="${S2_RUN_DIR}" \
  S2_COMMIT_MANIFEST="${S2_COST_MANIFEST_PATH}" \
  S2_COMMIT_RECEIPT="${S2_COST_RECEIPT_PATH}" \
  S2_COMMIT_PUBLICATION="${S2_COST_PUBLICATION_PATH}" \
  S2_COMMIT_PATH="${S2_COST_PUBLICATION_COMMIT_PATH}" \
  bun --eval '
    import { createHash } from "node:crypto";
    import {
      parseS2CostEvidenceManifestBytes,
      parseS2CostReceiptPublicationBytes,
      parseS2CostReceiptPublicationCommitBytes,
      S2_COST_EVIDENCE_MANIFEST_VERSION,
      S2_COST_MANIFEST_RELATIVE_PATH,
      S2_COST_PUBLICATION_COMMIT_PENDING_RELATIVE_PATH,
      S2_COST_PUBLICATION_COMMIT_RECORD,
      S2_COST_PUBLICATION_COMMIT_RELATIVE_PATH,
      S2_COST_PUBLICATION_COMMIT_SCHEMA_VERSION,
      S2_COST_PUBLICATION_RELATIVE_PATH,
      S2_COST_RECEIPT_RELATIVE_PATH,
    } from "@asimposium/contracts";
    import {
      closeSync,
      constants,
      fsyncSync,
      linkSync,
      lstatSync,
      openSync,
      readFileSync,
      writeSync,
    } from "node:fs";
    import { basename, dirname, resolve } from "node:path";

    const root = process.env.S2_COMMIT_ROOT ?? "";
    const manifestPath = process.env.S2_COMMIT_MANIFEST ?? "";
    const receiptPath = process.env.S2_COMMIT_RECEIPT ?? "";
    const publicationPath = process.env.S2_COMMIT_PUBLICATION ?? "";
    const commitPath = process.env.S2_COMMIT_PATH ?? "";
    const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
    const writeExclusiveDurably = (destination, pendingRelativePath, body) => {
      const directory = dirname(destination);
      const privateSibling = resolve(directory, pendingRelativePath);
      if (
        basename(privateSibling) !== pendingRelativePath ||
        dirname(privateSibling) !== resolve(directory)
      ) throw new Error("pending-path");
      const bytes = Buffer.from(body, "utf8");
      let descriptor;
      let directoryDescriptor;
      try {
        const directoryStat = lstatSync(directory);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("directory");
        descriptor = openSync(
          privateSibling,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          0o600,
        );
        let offset = 0;
        while (offset < bytes.byteLength) {
          const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
          if (!Number.isSafeInteger(written) || written <= 0) throw new Error("short-write");
          offset += written;
        }
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        const privateStat = lstatSync(privateSibling);
        if (!privateStat.isFile() || privateStat.isSymbolicLink() || (privateStat.mode & 0o777) !== 0o600) {
          throw new Error("private-sibling");
        }
        if (Buffer.compare(readFileSync(privateSibling), bytes) !== 0) throw new Error("private-readback");
        linkSync(privateSibling, destination);
        directoryDescriptor = openSync(directory, constants.O_RDONLY);
        fsyncSync(directoryDescriptor);
        closeSync(directoryDescriptor);
        directoryDescriptor = undefined;
        const finalStat = lstatSync(destination);
        if (!finalStat.isFile() || finalStat.isSymbolicLink() || (finalStat.mode & 0o777) !== 0o600) {
          throw new Error("final");
        }
        if (Buffer.compare(readFileSync(destination), bytes) !== 0) throw new Error("final-readback");
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
        if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
      }
    };
    try {
      if (!root) throw new Error("root");
      const rootStat = lstatSync(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("root");
      if (
        resolve(manifestPath) !== resolve(root, S2_COST_MANIFEST_RELATIVE_PATH) ||
        resolve(receiptPath) !== resolve(root, S2_COST_RECEIPT_RELATIVE_PATH) ||
        resolve(publicationPath) !== resolve(root, S2_COST_PUBLICATION_RELATIVE_PATH) ||
        resolve(commitPath) !== resolve(root, S2_COST_PUBLICATION_COMMIT_RELATIVE_PATH)
      ) throw new Error("path");
      for (const pathname of [manifestPath, receiptPath, publicationPath]) {
        const stat = lstatSync(pathname);
        if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) throw new Error("artifact");
      }
      const manifestBytes = readFileSync(manifestPath);
      const receiptBytes = readFileSync(receiptPath);
      const publicationBytes = readFileSync(publicationPath);
      const manifest = parseS2CostEvidenceManifestBytes(manifestBytes);
      const publication = parseS2CostReceiptPublicationBytes(publicationBytes);
      const phases = manifest.local_phase_status;
      if (
        manifest.manifest_version !== S2_COST_EVIDENCE_MANIFEST_VERSION || manifest.exit_code !== 78 ||
        !manifest.s2_cost_receipt || manifest.s2_cost_receipt.path !== S2_COST_RECEIPT_RELATIVE_PATH ||
        manifest.s2_cost_receipt.digest !== digest(receiptBytes) ||
        manifest.s2_cost_receipt.bytes !== receiptBytes.byteLength ||
        publication.manifest.digest !== digest(manifestBytes) ||
        publication.receipt.digest !== digest(receiptBytes) ||
        publication.receipt.bytes !== receiptBytes.byteLength ||
        publication.provenance.run_id !== manifest.run_id ||
        publication.provenance.revision !== manifest.revision ||
        publication.provenance.dirty_state !== manifest.dirty_state ||
        publication.provenance.source_digest !== manifest.source_digest ||
        Object.values(phases).some((value) => value !== "pass")
      ) throw new Error("attestation");
      const commit = {
        schema_version: S2_COST_PUBLICATION_COMMIT_SCHEMA_VERSION,
        record: S2_COST_PUBLICATION_COMMIT_RECORD,
        manifest: { path: S2_COST_MANIFEST_RELATIVE_PATH, digest: digest(manifestBytes) },
        receipt: { path: S2_COST_RECEIPT_RELATIVE_PATH, digest: digest(receiptBytes), bytes: receiptBytes.byteLength },
        publication: { path: S2_COST_PUBLICATION_RELATIVE_PATH, digest: digest(publicationBytes) },
      };
      const body = `${JSON.stringify(commit)}\n`;
      parseS2CostReceiptPublicationCommitBytes(Buffer.from(body, "utf8"));
      writeExclusiveDurably(commitPath, S2_COST_PUBLICATION_COMMIT_PENDING_RELATIVE_PATH, body);
      console.log(JSON.stringify({ tool: "bash+bun", package: "apps/wire", suite: "s2-cost-publication-commit", status: "pass", reproduce: "scripts/e2e-s2-krater.sh" }));
    } catch {
      console.log(JSON.stringify({ tool: "bash+bun", package: "apps/wire", suite: "s2-cost-publication-commit", status: "fail", code: "S2_COST_PUBLICATION_COMMIT_FAILED", reproduce: "scripts/e2e-s2-krater.sh" }));
      process.exit(1);
    }
  '
}

create_evidence_subdir() {
  local label="$1" path
  [[ "${label}" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || return 1
  path="${S2_RUN_DIR}/${label}-$(random_hex 8)"
  mkdir "${path}" || return 1
  [[ -d "${path}" && ! -L "${path}" ]] || return 1
  printf '%s\n' "${path}"
}

# shellcheck disable=SC2329
on_exit() {
  local original_status="$?" final_status
  trap - EXIT
  # A first signal has already selected the preserved status. Ignore follow-up
  # termination signals while exact cleanup and immutable evidence publication run.
  trap '' INT TERM HUP
  if [[ "${S2_PLANT_ON_EXIT_SECOND_SIGNAL:-0}" == "1" ]]; then
    kill -TERM "$$"
  fi
  final_status="${original_status}"
  if ! cleanup_workers; then
    final_status=125
  fi
  if [[ ${final_status} -eq 78 && ${S2_COST_LOCAL_PHASES_COMPLETE} -eq 1 ]]; then
    if ! write_evidence_receipt "${final_status}" 1 || ! write_s2_cost_publication || \
      ! write_s2_cost_publication_commit; then
      final_status=125
    fi
  elif ! write_evidence_receipt "${final_status}" 0; then
    final_status=125
  fi
  exit "${final_status}"
}

trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

start_worker() {
  # Defaults keep the primary run's call sites unchanged; the upgrade stages pass their own
  # config, persistence directory and owned port.
  local config="${1:-${S2_WRANGLER_CONFIG}}"
  local persist="${2:-${S2_STATE_DIR}}"
  local port="${3:-${S2_PORT}}"
  local log="${4:-${S2_SERVER_LOG}}"
  local token run_id ready_response deadline
  port_is_busy "${port}" && return 2
  token="$(random_hex 32)" || return 1
  run_id="$(random_hex 16)" || return 1
  S2_ACTIVE_ORIGIN="http://127.0.0.1:${port}"

  start_pinned_supervisor "${persist}/server-${run_id}.status" "worker-${port}" \
    "${persist}" "${port}" server \
    env "${S2_WRANGLER}" dev apps/wire/src/krater/worker.ts \
      --config "${config}" \
      --local \
      --test-scheduled \
      --persist-to "${persist}" \
      --ip "${S2_BIND_IP}" \
      --port "${port}" \
      --inspector-port 0 \
      --var "S2_HARNESS_TOKEN:${token}" \
      --var "S2_HARNESS_RUN_ID:${run_id}" \
      --log-level error \
      --show-interactive-dev-session=false \
      >>"${log}" 2>&1 || return 1
  S2_SERVER_PID="${S2_STARTED_PID}"
  S2_SERVER_PGID="${S2_STARTED_PGID}"
  S2_SERVER_MARKER="${S2_STARTED_MARKER}"
  S2_SERVER_WATCHDOG_PID="${S2_STARTED_WATCHDOG_PID}"
  S2_SERVER_WATCHDOG_HEALTH="${S2_STARTED_WATCHDOG_HEALTH}"
  S2_SERVER_PERSIST="${persist}"
  S2_SERVER_PORT="${port}"
  S2_ACTIVE_HARNESS_TOKEN="${token}"
  S2_ACTIVE_HARNESS_RUN_ID="${run_id}"
  # Transfer is complete only after every Worker handle is visible to EXIT cleanup.
  clear_most_recent_supervisor_if_marker "${S2_SERVER_MARKER}"

  deadline=$((SECONDS + S2_READY_DEADLINE_SECONDS))
  while (( SECONDS < deadline )); do
    server_is_owned || break
    if ready_response="$(curl --fail --silent --show-error --connect-timeout 1 --max-time 1 \
      -H "x-s2-harness-token: ${S2_ACTIVE_HARNESS_TOKEN}" \
      "${S2_ACTIVE_ORIGIN}/__s2/ready" 2>/dev/null)" && \
      [[ "${ready_response}" == "{\"status\":\"ready\",\"run_id\":\"${S2_ACTIVE_HARNESS_RUN_ID}\"}" ]] && \
      server_is_owned; then
      return 0
    fi
    sleep 0.2
  done
  stop_worker || :
  return 1
}

run_phase() {
  local phase="$1" phase_pid phase_pgid phase_marker phase_status deadline
  local phase_watchdog_pid phase_watchdog_health
  local -a receipt_environment=()
  if [[ "${phase}" == "exercise" ]]; then
    if [[ -e "${S2_COST_RECEIPT_PATH}" || -L "${S2_COST_RECEIPT_PATH}" ]]; then
      emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-local-d1","status":"fail","code":"S2_COST_RECEIPT_EXISTS","reproduce":"scripts/e2e-s2-krater.sh"}'
      return 125
    fi
    receipt_environment=(
      "S2_RUN_ID=${S2_RUN_ID}"
      "S2_COST_RECEIPT_ROOT=${S2_RUN_DIR}"
      "S2_COST_RECEIPT_PATH=${S2_COST_RECEIPT_PATH}"
    )
  fi
  # A phase client is deliberately not a Worker/lifecycle-array owner. Its local handles can be
  # untracked by those arrays for up to S2_PHASE_DEADLINE_SECONDS (75s), so the most-recent
  # record remains live until its exact supervisor has stopped.
  start_pinned_supervisor "${S2_STATE_DIR}/client-${phase}-$(random_hex 8).status" "client-${phase}" \
    "${S2_SERVER_PERSIST}" "${S2_SERVER_PORT}" client \
    env \
      S2_ORIGIN="${S2_ACTIVE_ORIGIN}" \
      S2_PHASE="${phase}" \
      S2_HARNESS_TOKEN="${S2_ACTIVE_HARNESS_TOKEN}" \
      S2_GIT_HEAD="${S2_GIT_HEAD}" \
      S2_GIT_DIRTY="${S2_GIT_DIRTY}" \
      S2_SOURCE_DIGEST="${S2_SOURCE_DIGEST}" \
      "${receipt_environment[@]}" \
      bun apps/wire/src/krater/s2-client.ts || return 125
  phase_pid="${S2_STARTED_PID}"
  phase_pgid="${S2_STARTED_PGID}"
  phase_marker="${S2_STARTED_MARKER}"
  phase_status="${S2_STARTED_STATUS_FILE}"
  phase_watchdog_pid="${S2_STARTED_WATCHDOG_PID}"
  phase_watchdog_health="${S2_STARTED_WATCHDOG_HEALTH}"
  deadline=$((SECONDS + S2_PHASE_DEADLINE_SECONDS))
  while :; do
    if read_child_status "${phase_status}"; then
      if ! stop_pinned_supervisor "${phase_pid}" "${phase_pgid}" "${phase_marker}" \
        "${phase_watchdog_pid}" "${phase_watchdog_health}" \
        "${S2_SERVER_PERSIST}" "${S2_SERVER_PORT}" client; then
        emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-lifecycle","status":"fail","code":"S2_CLIENT_CLEANUP_OWNERSHIP_UNPROVEN","reproduce":"scripts/e2e-s2-krater.sh"}'
        return 125
      fi
      return "${S2_CHILD_STATUS}"
    fi
    if ! server_is_owned; then
      stop_pinned_supervisor "${phase_pid}" "${phase_pgid}" "${phase_marker}" \
        "${phase_watchdog_pid}" "${phase_watchdog_health}" \
        "${S2_SERVER_PERSIST}" "${S2_SERVER_PORT}" client || :
      return 125
    fi
    if (( SECONDS >= deadline )); then
      stop_pinned_supervisor "${phase_pid}" "${phase_pgid}" "${phase_marker}" \
        "${phase_watchdog_pid}" "${phase_watchdog_health}" \
        "${S2_SERVER_PERSIST}" "${S2_SERVER_PORT}" client || :
      return 124
    fi
    sleep 0.2
  done
}

emit_legacy_failure() {
  local phase="$1" code="$2" log="$3"
  local cause
  cause="$(redacted_wrangler_cause "${log}")"
  emit "{\"tool\":\"wrangler\",\"tool_version\":\"${S2_WRANGLER_VERSION}\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-local-d1-upgrade\",\"scenario\":\"${phase}\",\"status\":\"fail\",\"code\":\"${code}\",\"cause\":${cause},\"reproduce\":\"scripts/e2e-s2-krater.sh\"}"
}

run_legacy_phase() {
  local phase="$1" log="$2" phase_status
  if run_phase "${phase}"; then
    return 0
  else
    phase_status=$?
  fi
  emit_legacy_failure "${phase}" "S2_LEGACY_UPGRADE_SCENARIO_FAILED" "${log}"
  return "${phase_status}"
}

stop_legacy_worker_or_fail() {
  local stop_status
  S2_LEGACY_STOP_CONTEXT=1
  if stop_worker; then
    stop_status=0
  else
    stop_status=$?
  fi
  unset S2_LEGACY_STOP_CONTEXT
  if [[ ${stop_status} -ne 0 ]]; then
    # The bounded residual branch proved zero survivors but intentionally reports failure: the
    # upgrade phase cannot call that teardown clean. Forget its dead handles so EXIT cleanup does
    # not re-inspect an already-reaped group and turn a precise failure into a stale one.
    if [[ "${S2_LEGACY_STOP_REAPED_UNCERTAIN:-0}" == 1 ]]; then
      S2_SERVER_PID=""
      S2_SERVER_PGID=""
      S2_SERVER_MARKER=""
      S2_SERVER_WATCHDOG_PID=""
      S2_SERVER_WATCHDOG_HEALTH=""
      S2_SERVER_PERSIST=""
      S2_SERVER_PORT=""
      S2_ACTIVE_HARNESS_TOKEN=""
      S2_ACTIVE_HARNESS_RUN_ID=""
      unset S2_LEGACY_STOP_REAPED_UNCERTAIN
    fi
    return 1
  fi
  S2_ACTIVE_ORIGIN="${S2_ORIGIN}"
}

# ── raw-SQL schema stages ────────────────────────────────────────────────────
# Build a genuinely old database and apply the named SQL files directly. This is retained to
# observe the exact 0004-only and 0005-only schema states; it is deliberately not presented as
# migration-runner evidence. `run_migration_journal_upgrade` below proves that separate lane.
#
# The order is the whole point. `wrangler.s2-legacy.toml` carries its own
# `migrations_dir` holding the exact pre-integrity 0001 and nothing else, so the
# database is first created without any integrity column, optionally given the
# retained legacy row, and only then given the named raw SQL file. A database born with 0004
# already applied would exercise none of this: the backfill would have nothing legacy to refuse.
#
# Each stage owns its own persistence directory and its own dynamically chosen
# port, so it can neither read nor collide with the primary run's state.
run_legacy_upgrade() {
  local phase="$1" fixture="$2" index_phase="${3:-}"
  local dir port log status

  dir="$(create_evidence_subdir legacy)"
  if [[ ! -d "${dir}" || -L "${dir}" ]]; then
    emit "{\"tool\":\"bash\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-local-d1-upgrade\",\"scenario\":\"${phase}\",\"status\":\"fail\",\"code\":\"S2_LEGACY_PERSIST_DIR_INVALID\",\"reproduce\":\"scripts/e2e-s2-krater.sh\"}"
    return 1
  fi
  # Retained, never removed: an upgrade failure keeps the database that caused it.
  S2_LEGACY_STATE_DIRS+=("${dir}")
  log="${dir}/wrangler.log"

  if ! "${S2_WRANGLER}" d1 migrations apply DB --config "${S2_LEGACY_CONFIG}" --local \
    --persist-to "${dir}" >"${dir}/legacy-migration.log" 2>&1; then
    emit_legacy_failure "${phase}" "S2_LEGACY_BASE_MIGRATION_FAILED" "${dir}/legacy-migration.log"
    return 1
  fi

  if [[ -n "${fixture}" ]]; then
    if ! "${S2_WRANGLER}" d1 execute DB --config "${S2_LEGACY_CONFIG}" --local \
      --persist-to "${dir}" --file "${fixture}" >"${dir}/legacy-fixture.log" 2>&1; then
      emit_legacy_failure "${phase}" "S2_LEGACY_FIXTURE_LOAD_FAILED" "${dir}/legacy-fixture.log"
      return 1
    fi
  fi

  # This is intentionally raw SQL, not `d1 migrations apply`; the JSONL emitted by the client
  # labels it `raw-sql-0004`. The migration-journal lane below covers the deploy mechanism.
  if ! "${S2_WRANGLER}" d1 execute DB --config "${S2_LEGACY_CONFIG}" --local \
    --persist-to "${dir}" --file "${S2_FORWARD_MIGRATION}" >"${dir}/forward-migration.log" 2>&1; then
    emit_legacy_failure "${phase}" "S2_LEGACY_FORWARD_MIGRATION_FAILED" "${dir}/forward-migration.log"
    return 1
  fi

  if ! port="$(choose_available_port)"; then
    emit "{\"tool\":\"bash\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-local-d1-upgrade\",\"scenario\":\"${phase}\",\"status\":\"fail\",\"code\":\"S2_LEGACY_PORT_UNAVAILABLE\",\"reproduce\":\"scripts/e2e-s2-krater.sh\"}"
    return 1
  fi

  if ! start_worker "${S2_LEGACY_CONFIG}" "${dir}" "${port}" "${log}"; then
    emit_legacy_failure "${phase}" "S2_LEGACY_WORKER_UNAVAILABLE" "${log}"
    S2_ACTIVE_ORIGIN="${S2_ORIGIN}"
    return 1
  fi

  if run_legacy_phase "${phase}" "${log}"; then
    status=0
  else
    status=$?
  fi
  stop_legacy_worker_or_fail || return 1

  # Second raw schema stage: 0004 -> 0005 on the database the first stage just used, rows and all.
  #
  # This is the only 0004-era database in the run. Without this the forward-migration evidence
  # stopped at 0004 and the index was only ever seen on a database born with it, so nothing
  # here observes the index transition without claiming it exercised the deployed migration
  # runner. The Worker is restarted because the first stage must observe the schema before the
  # index exists.
  if [[ "${status}" -eq 0 && -n "${index_phase}" ]]; then
    if ! "${S2_WRANGLER}" d1 execute DB --config "${S2_LEGACY_CONFIG}" --local \
      --persist-to "${dir}" --file "${S2_INDEX_MIGRATION}" >"${dir}/index-migration.log" 2>&1; then
      emit_legacy_failure "${index_phase}" "S2_LEGACY_INDEX_MIGRATION_FAILED" "${dir}/index-migration.log"
      return 1
    fi

    if ! port="$(choose_available_port)"; then
      emit "{\"tool\":\"bash\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-local-d1-upgrade\",\"scenario\":\"${index_phase}\",\"status\":\"fail\",\"code\":\"S2_LEGACY_PORT_UNAVAILABLE\",\"reproduce\":\"scripts/e2e-s2-krater.sh\"}"
      return 1
    fi

    log="${dir}/wrangler-indexed.log"
    if ! start_worker "${S2_LEGACY_CONFIG}" "${dir}" "${port}" "${log}"; then
      emit_legacy_failure "${index_phase}" "S2_LEGACY_WORKER_UNAVAILABLE" "${log}"
      S2_ACTIVE_ORIGIN="${S2_ORIGIN}"
      return 1
    fi

    if run_legacy_phase "${index_phase}" "${log}"; then
      :
    else
      status=$?
    fi
    stop_legacy_worker_or_fail || return 1
  fi
  return "${status}"
}

assert_current_migration_journal() {
  local dir="$1" phase="$2" journal_path journal_stderr
  journal_path="${dir}/migration-journal.json"
  journal_stderr="${dir}/migration-journal.stderr"
  if ! "${S2_WRANGLER}" d1 execute DB --config "${S2_UPGRADE_CONFIG}" --local \
    --persist-to "${dir}" \
    --command 'SELECT id, name, applied_at FROM d1_migrations ORDER BY id' \
    --json >"${journal_path}" 2>"${journal_stderr}"; then
    emit_legacy_failure "${phase}" "S2_MIGRATION_JOURNAL_UNREADABLE" "${journal_stderr}"
    return 1
  fi
  validate_current_migration_journal "${journal_path}" "${phase}"
}

# Keep the parser as an executable boundary distinct from the Wrangler query. The shell
# regressions feed this exact program valid and malformed D1-shaped journal JSON without
# pretending a synthetic fixture is migration-runner evidence.
validate_current_migration_journal() {
  local journal_path="$1" phase="$2"
  S2_JOURNAL_PATH="${journal_path}" \
  S2_JOURNAL_PHASE="${phase}" \
  S2_JOURNAL_EXPECTED="${S2_EXPECTED_MIGRATION_JOURNAL[*]}" \
  S2_JOURNAL_REVISION="${S2_GIT_HEAD}" \
  S2_JOURNAL_DIRTY_STATE="${S2_GIT_DIRTY}" \
  S2_JOURNAL_SOURCE_DIGEST="${S2_SOURCE_DIGEST}" \
  S2_JOURNAL_WRANGLER_VERSION="${S2_WRANGLER_VERSION}" \
  bun --eval '
    const fail = (code) => {
      console.log(JSON.stringify({
        tool: "wrangler+bun",
        tool_version: process.env.S2_JOURNAL_WRANGLER_VERSION,
        package: "apps/wire",
        suite: "s2-krater-local-d1-upgrade",
        scenario: process.env.S2_JOURNAL_PHASE,
        revision: process.env.S2_JOURNAL_REVISION,
        dirty_state: process.env.S2_JOURNAL_DIRTY_STATE,
        source_digest: process.env.S2_JOURNAL_SOURCE_DIGEST,
        status: "fail",
        code,
        reproduce: "scripts/e2e-s2-krater.sh",
      }));
      process.exit(1);
    };

    try {
      const payload = JSON.parse(await Bun.file(process.env.S2_JOURNAL_PATH ?? "").text());
      if (!Array.isArray(payload) || payload.length !== 1) fail("S2_MIGRATION_JOURNAL_SHAPE_INVALID");
      const envelope = payload[0];
      if (typeof envelope !== "object" || envelope === null || envelope.success !== true ||
        !Array.isArray(envelope.results)) fail("S2_MIGRATION_JOURNAL_SHAPE_INVALID");
      const expected = (process.env.S2_JOURNAL_EXPECTED ?? "").split(" ").filter(Boolean);
      const journal = envelope.results.map((entry) => {
        if (typeof entry !== "object" || entry === null || !Number.isInteger(entry.id) ||
          typeof entry.name !== "string" || typeof entry.applied_at !== "string" ||
          !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(entry.applied_at)) {
          fail("S2_MIGRATION_JOURNAL_ENTRY_INVALID");
        }
        return { id: entry.id, name: entry.name, applied_at: entry.applied_at };
      });
      if (journal.length !== expected.length || journal.some((entry, index) =>
        entry.id !== index + 1 || entry.name !== expected[index])) {
        fail("S2_MIGRATION_JOURNAL_EXACT_ORDER_INVALID");
      }
      // Applied timestamps are valid provenance evidence, but not migration identity: two
      // equivalent journal replays happen at different wall-clock times. Digest only the
      // canonical ordered id/name identity so equal migration histories hash identically.
      const journalIdentity = journal.map(({ id, name }) => ({ id, name }));
      const canonicalJournal = JSON.stringify(journalIdentity);
      const journalDigest = new Bun.CryptoHasher("sha256")
        .update(canonicalJournal)
        .digest("hex");
      console.log(JSON.stringify({
        tool: "wrangler+bun",
        tool_version: process.env.S2_JOURNAL_WRANGLER_VERSION,
        package: "apps/wire",
        suite: "s2-krater-local-d1-upgrade",
        scenario: process.env.S2_JOURNAL_PHASE,
        revision: process.env.S2_JOURNAL_REVISION,
        dirty_state: process.env.S2_JOURNAL_DIRTY_STATE,
        source_digest: process.env.S2_JOURNAL_SOURCE_DIGEST,
        journal_identity: journalIdentity,
        applied_at_evidence: journal.map(({ id, applied_at }) => ({ id, applied_at })),
        journal_digest: journalDigest,
        status: "pass",
        reproduce: "scripts/e2e-s2-krater.sh",
      }));
    } catch {
      fail("S2_MIGRATION_JOURNAL_PARSE_FAILED");
    }
  '
}

# Create the exact 0001 database with the legacy config, then switch to a configuration with
# the same local D1 identity and the real repository migration directory. Unlike the raw lane,
# this invokes Wrangler's migration journal end to end and verifies every current migration name
# before the Worker is allowed to serve the test phase.
run_migration_journal_upgrade() {
  local phase="$1" fixture="$2" dir port log status
  dir="$(create_evidence_subdir journal)"
  if [[ ! -d "${dir}" || -L "${dir}" ]]; then
    emit "{\"tool\":\"bash\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-local-d1-upgrade\",\"scenario\":\"${phase}\",\"status\":\"fail\",\"code\":\"S2_JOURNAL_PERSIST_DIR_INVALID\",\"reproduce\":\"scripts/e2e-s2-krater.sh\"}"
    return 1
  fi
  S2_LEGACY_STATE_DIRS+=("${dir}")
  log="${dir}/wrangler.log"
  if ! "${S2_WRANGLER}" d1 migrations apply DB --config "${S2_LEGACY_CONFIG}" --local \
    --persist-to "${dir}" >"${dir}/legacy-migration.log" 2>&1; then
    emit_legacy_failure "${phase}" "S2_JOURNAL_LEGACY_BASE_FAILED" "${dir}/legacy-migration.log"
    return 1
  fi
  if [[ -n "${fixture}" ]] && ! "${S2_WRANGLER}" d1 execute DB --config "${S2_LEGACY_CONFIG}" --local \
    --persist-to "${dir}" --file "${fixture}" >"${dir}/legacy-fixture.log" 2>&1; then
    emit_legacy_failure "${phase}" "S2_JOURNAL_FIXTURE_LOAD_FAILED" "${dir}/legacy-fixture.log"
    return 1
  fi
  if ! "${S2_WRANGLER}" d1 migrations apply DB --config "${S2_UPGRADE_CONFIG}" --local \
    --persist-to "${dir}" >"${dir}/current-migrations.log" 2>&1; then
    emit_legacy_failure "${phase}" "S2_JOURNAL_CURRENT_APPLY_FAILED" "${dir}/current-migrations.log"
    return 1
  fi
  assert_current_migration_journal "${dir}" "${phase}" || return 1
  if ! port="$(choose_available_port)"; then
    emit "{\"tool\":\"bash\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-local-d1-upgrade\",\"scenario\":\"${phase}\",\"status\":\"fail\",\"code\":\"S2_JOURNAL_PORT_UNAVAILABLE\",\"reproduce\":\"scripts/e2e-s2-krater.sh\"}"
    return 1
  fi
  if ! start_worker "${S2_UPGRADE_CONFIG}" "${dir}" "${port}" "${log}"; then
    emit_legacy_failure "${phase}" "S2_JOURNAL_WORKER_UNAVAILABLE" "${log}"
    S2_ACTIVE_ORIGIN="${S2_ORIGIN}"
    return 1
  fi
  if run_legacy_phase "${phase}" "${log}"; then status=0; else status=$?; fi
  stop_worker || return 1
  S2_ACTIVE_ORIGIN="${S2_ORIGIN}"
  return "${status}"
}

run_legacy_upgrade_checked() {
  local upgrade_status
  if run_legacy_upgrade "$@"; then
    return 0
  else
    upgrade_status=$?
  fi
  return "${upgrade_status}"
}

assert_legacy_fixture_bytes() {
  local fixture_digest migration_path migration_name expected_index=0
  # The journal expectation is intentionally closed: a new migration must update both the
  # observed journal and the bounded provenance input list in the same review, rather than
  # silently making this upgrade proof describe only an old prefix.
  while IFS= read -r migration_path; do
    migration_name="${migration_path##*/}"
    if (( expected_index >= ${#S2_EXPECTED_MIGRATION_JOURNAL[@]} )) || \
      [[ "${migration_name}" != "${S2_EXPECTED_MIGRATION_JOURNAL[expected_index]}" ]] || \
      [[ " ${S2_SOURCE_PATHS[*]} " != *" db/migrations/${migration_name} "* ]]; then
      emit '{"tool":"find","package":"apps/wire","suite":"s2-krater-migration-provenance","status":"fail","code":"S2_MIGRATION_SOURCE_JOURNAL_DRIFT","reproduce":"scripts/e2e-s2-krater.sh"}'
      return 1
    fi
    expected_index=$((expected_index + 1))
  done < <(LC_ALL=C find db/migrations -maxdepth 1 -type f -name '*.sql' -print | LC_ALL=C sort)
  if (( expected_index != ${#S2_EXPECTED_MIGRATION_JOURNAL[@]} )); then
    emit '{"tool":"find","package":"apps/wire","suite":"s2-krater-migration-provenance","status":"fail","code":"S2_MIGRATION_SOURCE_JOURNAL_DRIFT","reproduce":"scripts/e2e-s2-krater.sh"}'
    return 1
  fi
  if ! cmp -s apps/wire/src/krater/fixtures/legacy-migrations/0001_krater_v0.sql \
    db/migrations/0001_krater_v0.sql; then
    emit '{"tool":"cmp","package":"apps/wire","suite":"s2-krater-migration-provenance","status":"fail","code":"S2_LEGACY_FIXTURE_BYTE_DRIFT","reproduce":"scripts/e2e-s2-krater.sh"}'
    return 1
  fi
  fixture_digest="$(shasum -a 256 db/migrations/0001_krater_v0.sql | awk '{print $1}')" || return 1
  [[ "${fixture_digest}" =~ ^[a-f0-9]{64}$ ]] || return 1
  emit "{\"tool\":\"cmp+shasum\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-migration-provenance\",\"revision\":\"${S2_GIT_HEAD}\",\"dirty_state\":\"${S2_GIT_DIRTY}\",\"source_digest\":\"${S2_SOURCE_DIGEST}\",\"fixture_digest\":\"${fixture_digest}\",\"byte_equal\":true,\"status\":\"pass\",\"reproduce\":\"scripts/e2e-s2-krater.sh\"}"
}

run_s2_shell_regression_test() {
  local mode="$1" phase_status upgrade_status emitted_phase="" status_file deadline
  local supervisor_pid supervisor_pgid supervisor_marker supervisor_status redaction_log redaction_cause
  local supervisor_watchdog_pid supervisor_watchdog_health watchdog_state watchdog_health_pid stop_status
  local source_path signal_called=0 parent_loss_record parent_loss_child parent_loss_status
  local journal_valid journal_alternate journal_invalid valid_output alternate_output invalid_output
  local valid_digest alternate_digest cleanup_status
  local interrupt_record interrupt_child interrupt_status interrupt_secret child_persist child_port
  local child_run child_status_file child_diagnostic diagnostic_body manifest_body
  local plant_clean_stop_bypass payload_behavior payload_ready_file payload_state_file
  local payload_pid state_holders holder_status lsof_held_file lsof_transient_marker
  local payload_ready_seen payload_state_regular payload_pid_valid state_holder_exact
  local group_sufficient payload_in_group lsof_observation
  local arm_consumed spawn_attempted watchdog_pid_published supervisor_exit_status_json startup_phase_json

  if [[ ! "${mode}" =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]]; then
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"fail","code":"S2_SHELL_REGRESSION_TEST_INVALID","reproduce":"scripts/e2e-s2-krater.sh"}'
    return 2
  fi

  if [[ "${mode}" == "pre-release-helper-classification" ]]; then
    pre_release_snapshot_line_kind \
      '123 456 456 S ps -o pid=,pgid=,ppid=,stat=,command= -p 456' 123 456 marker || return 1
    pre_release_snapshot_line_kind \
      '124 456 456 S /bin/ps -o pid=,pgid=,ppid=,stat=,command= -p 456' 124 456 marker || return 1
    if pre_release_snapshot_line_kind \
      '125 456 456 S bash s2-pinned-supervisor-marker' 125 456 marker; then return 1; \
    else [[ $? -eq 2 ]] || return 1; fi
    if pre_release_snapshot_line_kind \
      '126 456 456 Z ps -o pid=,pgid=,ppid=,stat=,command= -p 456' 126 456 marker; then \
      return 1; else [[ $? -eq 2 ]] || return 1; fi
    if pre_release_snapshot_line_kind \
      '127 456 456 S bash s2-persistent-pre-release-helper-marker' 127 456 marker; then \
      return 1; else [[ $? -eq 1 ]] || return 1; fi
    if pre_release_snapshot_line_kind \
      '128 456 999 S ps -o pid=,pgid=,ppid=,stat=,command= -p 456' 128 456 marker; then \
      return 1; else [[ $? -eq 1 ]] || return 1; fi
    if pre_release_snapshot_line_kind \
      '129 456 456 S ps -o pid=,pgid=,ppid=,stat=,command= -p 456' 129 456 ''; then \
      return 1; else [[ $? -eq 1 ]] || return 1; fi
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"pass","scenario":"pre-release-helper-classifier-accepts-only-the-supervisors-exact-live-ps-child","reproduce":"S2_SHELL_REGRESSION_TEST=pre-release-helper-classification scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  if [[ "${mode}" == "detached-ps-failure" ]]; then
    local payload_release_file status_file
    S2_DETACHED_PROCESS_TABLE="stale-result-must-not-survive"
    if S2_PLANT_DETACHED_PS_FAILURE=1 \
      capture_detached_process_table -o pid=,pgid=,ppid=,stat=,command= -p "$$"; then
      return 1
    fi
    [[ -z "${S2_DETACHED_PROCESS_TABLE}" ]] || return 1
    status_file="${S2_STATE_DIR}/detached-ps-failure-$(random_hex 8).status"
    payload_release_file="${S2_STATE_DIR}/detached-ps-failure-$(random_hex 8).released"
    if S2_PLANT_DETACHED_PS_FAILURE=1 \
      start_pinned_supervisor "${status_file}" detached-ps-failure \
        "${S2_STATE_DIR}" "${S2_PORT}" client \
        bash -c 'printf released >"$1"; sleep 30' s2-detached-ps-failure-payload \
          "${payload_release_file}"; then
      return 1
    fi
    [[ "${S2_START_FAILURE_STAGE}" == "pre-arm-ownership" && \
      ${S2_PRE_RELEASE_RESAMPLE_ATTEMPTS} -eq 40 && \
      ${S2_PRE_RELEASE_ACCEPTED_SAMPLES} -eq 0 && \
      ${S2_PRE_RELEASE_CAPTURE_UNCERTAIN_SAMPLES} -eq 40 && \
      ! -e "${payload_release_file}" && ! -L "${payload_release_file}" ]] || return 1
    is_decimal "${S2_LAST_SUPERVISOR_PGID}" && \
      [[ -n "${S2_LAST_SUPERVISOR_MARKER}" ]] || return 1
    [[ "${S2_PRE_RELEASE_REAPED_PGID}" == "${S2_LAST_SUPERVISOR_PGID}" && \
      "${S2_START_SUPERVISOR_EXIT_STATUS}" == 137 ]] || return 1
    kill -0 -- "-${S2_LAST_SUPERVISOR_PGID}" 2>/dev/null && return 1
    emit '{"tool":"bash+fifo","package":"apps/wire","suite":"s2-krater-shell","status":"pass","scenario":"detached-ps-failure-propagates-remains-bounded-refuses-release-and-aborts-the-exact-child-owned-group","start_failure_stage":"pre-arm-ownership","pre_release_capture_uncertain_samples":40,"payload_release_refused":true,"abort_token_consumed":true,"supervisor_exit_status":137,"no_exact_group_survivor":true,"reproduce":"S2_SHELL_REGRESSION_TEST=detached-ps-failure scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  if [[ "${mode}" == "pre-arm-owner-loss-child" ]]; then
    parent_loss_record="${S2_PRE_ARM_OWNER_LOSS_RECORD:-}"
    [[ -n "${parent_loss_record}" && "${parent_loss_record}" == "${S2_EVIDENCE_ROOT}/"* && \
      ! -e "${parent_loss_record}" && ! -L "${parent_loss_record}" ]] || return 2
    status_file="${S2_STATE_DIR}/pre-arm-owner-loss-$(random_hex 8).status"
    S2_PLANT_PERSISTENT_PRE_RELEASE_HELPER=1 \
      S2_PLANT_OWNER_LOSS_BEFORE_ARM=1 \
      start_pinned_supervisor "${status_file}" pre-arm-owner-loss \
        "${S2_STATE_DIR}" "${S2_PORT}" client bash -c 'sleep 30'
    return 125
  fi

  if [[ "${mode}" == "pre-arm-owner-loss" ]]; then
    local planted_helper_pid child_persist child_port
    parent_loss_record="${S2_STATE_DIR}/pre-arm-owner-loss-record-$(random_hex 8)"
    env \
      S2_SHELL_REGRESSION_TEST=pre-arm-owner-loss-child \
      S2_PRE_ARM_OWNER_LOSS_RECORD="${parent_loss_record}" \
      bash "${BASH_SOURCE[0]}" >/dev/null 2>&1 &
    parent_loss_child=$!
    deadline=$((SECONDS + S2_READY_DEADLINE_SECONDS))
    while [[ ! -f "${parent_loss_record}" || -L "${parent_loss_record}" ]]; do
      if (( SECONDS >= deadline )); then
        kill -KILL "${parent_loss_child}" 2>/dev/null || :
        wait "${parent_loss_child}" 2>/dev/null || :
        return 1
      fi
      sleep 0.05
    done
    read -r supervisor_pid supervisor_pgid supervisor_marker planted_helper_pid \
      child_persist child_port <"${parent_loss_record}" || return 1
    is_decimal "${supervisor_pid}" && is_decimal "${supervisor_pgid}" && \
      is_decimal "${planted_helper_pid}" && is_decimal "${child_port}" || return 1
    [[ "${supervisor_pid}" == "${supervisor_pgid}" && -n "${supervisor_marker}" && \
      -d "${child_persist}" && ! -L "${child_persist}" ]] || return 1
    kill -0 "${planted_helper_pid}" 2>/dev/null || return 1
    kill -KILL "${parent_loss_child}" 2>/dev/null || return 1
    if wait "${parent_loss_child}" 2>/dev/null; then
      parent_loss_status=0
    else
      parent_loss_status=$?
    fi
    [[ ${parent_loss_status} -eq 137 ]] || return 1
    deadline=$((SECONDS + 5))
    while kill -0 -- "-${supervisor_pgid}" 2>/dev/null; do
      if (( SECONDS >= deadline )); then
        reap_parent_terminated_supervisor_residual \
          "${supervisor_pid}" "${supervisor_pgid}" "${supervisor_marker}" \
          "${child_persist}" "${child_port}" || :
        return 1
      fi
      sleep 0.1
    done
    if kill -0 "${planted_helper_pid}" 2>/dev/null; then return 1; fi
    assert_no_run_survivors \
      "${child_persist}" "${child_port}" "${supervisor_marker}" || return 1
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"pass","scenario":"controller-death-before-first-gate-reaps-supervisor-and-planted-helper","reproduce":"S2_SHELL_REGRESSION_TEST=pre-arm-owner-loss scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  if [[ "${mode}" == "parent-loss-child" ]]; then
    parent_loss_record="${S2_PARENT_LOSS_RECORD:-}"
    [[ -n "${parent_loss_record}" && ! -e "${parent_loss_record}" && ! -L "${parent_loss_record}" ]] || return 2
    status_file="${S2_STATE_DIR}/parent-loss-$(random_hex 8).status"
    start_pinned_supervisor "${status_file}" parent-loss "${S2_STATE_DIR}" "${S2_PORT}" client \
      bash -c 'sleep 30' || {
        emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"fail","code":"S2_PARENT_LOSS_START_FAILED","reproduce":"S2_SHELL_REGRESSION_TEST=parent-loss scripts/e2e-s2-krater.sh"}'
        return 1
      }
    printf '%s %s %s %s %s %s %s\n' \
      "${S2_STARTED_PID}" "${S2_STARTED_PGID}" "${S2_STARTED_MARKER}" \
      "${S2_STARTED_WATCHDOG_PID}" "${S2_STARTED_WATCHDOG_HEALTH}" \
      "${S2_STATE_DIR}" "${S2_PORT}" >"${parent_loss_record}"
    # Deliberately bypass the controller EXIT trap: the watchdog in the already-proved group is
    # the subject under test and must TERM/KILL its own group without any parent PID fallback.
    kill -KILL "$$"
    return 125
  fi

  if [[ "${mode}" == "parent-loss" ]]; then
    parent_loss_record="${S2_STATE_DIR}/parent-loss-record-$(random_hex 8)"
    env \
      S2_SHELL_REGRESSION_TEST=parent-loss-child \
      S2_PARENT_LOSS_RECORD="${parent_loss_record}" \
      bash "${BASH_SOURCE[0]}" >/dev/null 2>&1 &
    parent_loss_child=$!
    if wait "${parent_loss_child}" 2>/dev/null; then
      parent_loss_status=0
    else
      parent_loss_status=$?
    fi
    [[ ${parent_loss_status} -eq 137 ]] || return 1
    [[ -f "${parent_loss_record}" && ! -L "${parent_loss_record}" ]] || return 1
    read -r supervisor_pid supervisor_pgid supervisor_marker supervisor_watchdog_pid \
      supervisor_watchdog_health child_persist child_port <"${parent_loss_record}" || return 1
    is_decimal "${supervisor_pid}" && is_decimal "${supervisor_pgid}" && \
      is_decimal "${supervisor_watchdog_pid}" && is_decimal "${child_port}" || return 1
    [[ "${supervisor_pid}" == "${supervisor_pgid}" && -n "${supervisor_marker}" && \
      -d "${child_persist}" && ! -L "${child_persist}" && \
      -f "${supervisor_watchdog_health}" && ! -L "${supervisor_watchdog_health}" ]] || return 1
    # The payload has a four-second self-expiry. If the retired hook nevertheless leaves its
    # PPID-1 supervisor alive, reach the exact-marker residual reaper promptly rather than
    # spending the whole parent test deadline in an unproductive poll.
    deadline=$((SECONDS + 5))
    while kill -0 -- "-${supervisor_pgid}" 2>/dev/null; do
      if (( SECONDS >= deadline )); then
        # The current hook must never reach this branch. If a deliberately failing old-hook
        # shape does, reap only its still-provable PPID-1 marker leader and then fail the plant
        # after proving zero residue, so the regression cannot leave an immortal supervisor.
        if reap_parent_terminated_supervisor_residual \
          "${supervisor_pid}" "${supervisor_pgid}" "${supervisor_marker}" \
          "${child_persist}" "${child_port}"; then
          emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"fail","code":"S2_PARENT_LOSS_RESIDUAL_REAPED","reproduce":"S2_SHELL_REGRESSION_TEST=parent-loss scripts/e2e-s2-krater.sh"}'
        else
          emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"fail","code":"S2_PARENT_LOSS_RESIDUAL_UNPROVEN","reproduce":"S2_SHELL_REGRESSION_TEST=parent-loss scripts/e2e-s2-krater.sh"}'
        fi
        return 1
      fi
      sleep 0.1
    done
    read -r watchdog_state watchdog_health_pid < <(tail -n 1 "${supervisor_watchdog_health}") || return 1
    [[ "${watchdog_state}" == "owner-lost" && \
      "${watchdog_health_pid}" == "${supervisor_watchdog_pid}" ]] || return 1
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"pass","scenario":"planted-controller-loss-terminates-its-own-pinned-group-without-parent-pid-fallback","reproduce":"S2_SHELL_REGRESSION_TEST=parent-loss scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  if [[ "${mode}" == "owner-loss-uncertain-child" ]]; then
    parent_loss_record="${S2_PARENT_LOSS_RECORD:-}"
    [[ -n "${parent_loss_record}" && ! -e "${parent_loss_record}" && ! -L "${parent_loss_record}" ]] || return 2
    status_file="${S2_STATE_DIR}/owner-loss-uncertain-$(random_hex 8).status"
    # This exact plant combines controller loss, a leader that exits when the watchdog sends
    # group TERM, and a payload that ignores TERM. The post-TERM group remains live while the
    # watchdog's supervisor inspection is necessarily uncertain.
    # The child Bash, not this harness, must expand its SECONDS-based deadline.
    # shellcheck disable=SC2016
    S2_PLANT_SUPERVISOR_EXIT_ON_TERM=1 \
      start_pinned_supervisor "${status_file}" owner-loss-uncertain "${S2_STATE_DIR}" "${S2_PORT}" client \
        bash -c 'trap "" TERM; deadline=$((SECONDS + 4)); while (( SECONDS < deadline )); do read -r -t 1 ignored || :; done' || {
          emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"fail","code":"S2_OWNER_LOSS_UNCERTAIN_START_FAILED","reproduce":"S2_SHELL_REGRESSION_TEST=owner-loss-uncertain scripts/e2e-s2-krater.sh"}'
          return 1
        }
    deadline=$((SECONDS + S2_READY_DEADLINE_SECONDS))
    while :; do
      group_members "${S2_STARTED_PGID}" || return 1
      [[ ${S2_GROUP_MEMBER_COUNT} -ge 3 ]] && break
      (( SECONDS < deadline )) || return 1
      sleep 0.05
    done
    printf '%s %s %s %s %s %s %s\n' \
      "${S2_STARTED_PID}" "${S2_STARTED_PGID}" "${S2_STARTED_MARKER}" \
      "${S2_STARTED_WATCHDOG_PID}" "${S2_STARTED_WATCHDOG_HEALTH}" \
      "${S2_STATE_DIR}" "${S2_PORT}" >"${parent_loss_record}"
    # Bypass this controller's EXIT trap. The independently identified watchdog is the subject:
    # it must observe controller loss, bound its now-uncertain inspection, and self-retire.
    kill -KILL "$$"
    return 125
  fi

  if [[ "${mode}" == "owner-loss-uncertain" ]]; then
    local child_persist child_port
    parent_loss_record="${S2_STATE_DIR}/owner-loss-uncertain-record-$(random_hex 8)"
    env \
      S2_SHELL_REGRESSION_TEST=owner-loss-uncertain-child \
      S2_PARENT_LOSS_RECORD="${parent_loss_record}" \
      bash "${BASH_SOURCE[0]}" >/dev/null 2>&1 &
    parent_loss_child=$!
    if wait "${parent_loss_child}" 2>/dev/null; then
      parent_loss_status=0
    else
      parent_loss_status=$?
    fi
    [[ ${parent_loss_status} -eq 137 ]] || {
      emit_owner_loss_uncertain_failure "S2_OWNER_LOSS_UNCERTAIN_CHILD_EXIT_INVALID"
      return 1
    }
    [[ -f "${parent_loss_record}" && ! -L "${parent_loss_record}" ]] || {
      emit_owner_loss_uncertain_failure "S2_OWNER_LOSS_UNCERTAIN_RECORD_UNAVAILABLE"
      return 1
    }
    read -r supervisor_pid supervisor_pgid supervisor_marker supervisor_watchdog_pid \
      supervisor_watchdog_health child_persist child_port <"${parent_loss_record}" || {
        emit_owner_loss_uncertain_failure "S2_OWNER_LOSS_UNCERTAIN_RECORD_UNREADABLE"
        return 1
      }
    if ! { is_decimal "${supervisor_pid}" && is_decimal "${supervisor_pgid}" && \
      is_decimal "${supervisor_watchdog_pid}" && is_decimal "${child_port}"; }; then
        emit_owner_loss_uncertain_failure "S2_OWNER_LOSS_UNCERTAIN_IDENTITY_INVALID"
        return 1
    fi
    [[ "${supervisor_pid}" == "${supervisor_pgid}" && -n "${supervisor_marker}" && \
      -d "${child_persist}" && ! -L "${child_persist}" && \
      "${supervisor_watchdog_health}" == "${child_persist}/"* && \
      -f "${supervisor_watchdog_health}" && ! -L "${supervisor_watchdog_health}" ]] || {
        emit_owner_loss_uncertain_failure "S2_OWNER_LOSS_UNCERTAIN_RECORD_INVALID"
        return 1
      }
    deadline=$((SECONDS + S2_WATCHDOG_MAX_UNCERTAIN_TICKS + 8))
    while kill -0 -- "-${supervisor_pgid}" 2>/dev/null; do
      (( SECONDS < deadline )) || {
        emit_owner_loss_uncertain_failure "S2_OWNER_LOSS_UNCERTAIN_GROUP_TIMEOUT"
        return 1
      }
      sleep 0.1
    done
    grep -Fqx "owner-lost ${supervisor_watchdog_pid}" "${supervisor_watchdog_health}" || {
      emit_owner_loss_uncertain_failure "S2_OWNER_LOSS_UNCERTAIN_OWNER_LOSS_UNOBSERVED"
      return 1
    }
    grep -Fqx "inspection-uncertain ${supervisor_watchdog_pid}" "${supervisor_watchdog_health}" || {
      emit_owner_loss_uncertain_failure "S2_OWNER_LOSS_UNCERTAIN_INSPECTION_UNOBSERVED"
      return 1
    }
    grep -Fqx "inspection-timeout ${supervisor_watchdog_pid}" "${supervisor_watchdog_health}" || {
      emit_owner_loss_uncertain_failure "S2_OWNER_LOSS_UNCERTAIN_TIMEOUT_UNOBSERVED"
      return 1
    }
    if kill -0 "${supervisor_watchdog_pid}" 2>/dev/null; then
      emit_owner_loss_uncertain_failure "S2_OWNER_LOSS_UNCERTAIN_WATCHDOG_SURVIVOR"
      return 1
    fi
    assert_no_run_survivors "${child_persist}" "${child_port}" "${supervisor_marker}" || {
      emit_owner_loss_uncertain_failure "S2_OWNER_LOSS_UNCERTAIN_SURVIVOR_SCAN_FAILED"
      return 1
    }
    if [[ "${S2_PLANT_OWNER_LOSS_POST_PROOF_FAILURE:-0}" == 1 ]]; then
      emit_owner_loss_uncertain_failure "S2_OWNER_LOSS_UNCERTAIN_PLANTED_CHECKPOINT"
      return 91
    fi
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"pass","scenario":"controller-loss-plus-leader-loss-plus-term-resistant-member-bounds-owner-loss-inspection-and-watchdog-self-retires","reproduce":"S2_SHELL_REGRESSION_TEST=owner-loss-uncertain scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  if [[ "${mode}" == "release-race" ]]; then
    status_file="${S2_STATE_DIR}/release-race-$(random_hex 8).status"
    if S2_PLANT_RELEASE_CHILD_EXIT_AFTER_REPROOF=1 \
      start_pinned_supervisor "${status_file}" release-race "${S2_STATE_DIR}" "${S2_PORT}" client \
        bash -c 'sleep 30'; then
      emit_release_race_failure "S2_RELEASE_RACE_UNEXPECTEDLY_RELEASED"
      return 1
    fi
    if ! is_decimal "${S2_PLANTED_RELEASE_PID}" || \
      [[ "${S2_PLANTED_RELEASE_PID}" != "${S2_PLANTED_RELEASE_PGID}" || \
        -z "${S2_PLANTED_RELEASE_MARKER}" ]]; then
      emit_release_race_failure "S2_RELEASE_RACE_PLANTED_IDENTITY_INVALID"
      return 1
    fi
    if kill -0 -- "-${S2_PLANTED_RELEASE_PGID}" 2>/dev/null; then
      emit_release_race_failure "S2_RELEASE_RACE_EXACT_GROUP_SURVIVOR"
      return 1
    fi
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"pass","scenario":"planted-child-exits-between-reproof-and-already-open-release-write-is-bounded","reproduce":"S2_SHELL_REGRESSION_TEST=release-race scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  if [[ "${mode}" == "persistent-pre-release-helper" ]]; then
    local payload_started payload_started_bool=false
    status_file="${S2_STATE_DIR}/persistent-pre-release-helper-$(random_hex 8).status"
    payload_started="${S2_STATE_DIR}/persistent-pre-release-payload-$(random_hex 8).started"
    if [[ -e "${payload_started}" || -L "${payload_started}" ]]; then
      emit_persistent_pre_release_helper_failure "S2_PERSISTENT_PRE_RELEASE_HELPER_PAYLOAD_PATH_UNSAFE" true
      return 1
    fi
    # shellcheck disable=SC2016 # The payload's child Bash, not this harness, expands "$1".
    if S2_PLANT_PERSISTENT_PRE_RELEASE_HELPER=1 \
      start_pinned_supervisor "${status_file}" persistent-pre-release-helper \
        "${S2_STATE_DIR}" "${S2_PORT}" client bash -c 'printf released >"$1"' bash "${payload_started}"; then
      if [[ -e "${payload_started}" || -L "${payload_started}" ]]; then
        payload_started_bool=true
      fi
      emit_persistent_pre_release_helper_failure "S2_PERSISTENT_PRE_RELEASE_HELPER_ACCEPTED" "${payload_started_bool}"
      return 1
    fi
    if ! is_decimal "${S2_PRE_RELEASE_EXPECTED_HELPER_PID}"; then
      emit_persistent_pre_release_helper_failure "S2_PERSISTENT_PRE_RELEASE_HELPER_PLANTED_IDENTITY_INVALID" false
      return 1
    fi
    [[ ${S2_PRE_RELEASE_RESAMPLE_ATTEMPTS} -eq 40 && \
      ${S2_PRE_RELEASE_ACCEPTED_SAMPLES} -eq 0 && \
      ${S2_PRE_RELEASE_REJECTED_SAMPLES} -eq 40 && \
      ${S2_PRE_RELEASE_MAX_GROUP_MEMBER_COUNT} -eq 2 && \
      "${S2_PRE_RELEASE_EXPECTED_HELPER_PID}" != "${S2_LAST_SUPERVISOR_PGID}" && \
      ${S2_PRE_RELEASE_EXPECTED_HELPER_REJECTED_SAMPLES} -eq 40 && \
      "${S2_PRE_RELEASE_REAPED_PGID}" == "${S2_LAST_SUPERVISOR_PGID}" && \
      -z "${S2_MOST_RECENT_SUPERVISOR}" && \
      ! -e "${payload_started}" && ! -L "${payload_started}" ]] || {
      if [[ -e "${payload_started}" || -L "${payload_started}" ]]; then
        payload_started_bool=true
      fi
      emit_persistent_pre_release_helper_failure "S2_PERSISTENT_PRE_RELEASE_HELPER_RESAMPLE_OR_RELEASE_PROOF_FAILED" "${payload_started_bool}"
      return 1
    }
    if ! is_decimal "${S2_LAST_SUPERVISOR_PGID}"; then
      emit_persistent_pre_release_helper_failure "S2_PERSISTENT_PRE_RELEASE_HELPER_PGID_INVALID" false
      return 1
    fi
    if kill -0 -- "-${S2_LAST_SUPERVISOR_PGID}" 2>/dev/null; then
      emit_persistent_pre_release_helper_failure "S2_PERSISTENT_PRE_RELEASE_HELPER_SURVIVOR" false
      return 1
    fi
    if kill -0 "${S2_PRE_RELEASE_EXPECTED_HELPER_PID}" 2>/dev/null; then
      emit_persistent_pre_release_helper_failure "S2_PERSISTENT_PRE_RELEASE_HELPER_PLANTED_HELPER_SURVIVOR" false
      return 1
    fi
    emit "{\"tool\":\"bash\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-shell\",\"status\":\"pass\",\"scenario\":\"persistent-marker-bearing-pre-release-helper-exhausts-resamples-refuses-payload-release-and-reaps-exact-pinned-group\",\"pre_release_resample_attempts\":40,\"pre_release_accepted_samples\":0,\"pre_release_rejected_samples\":40,\"pre_release_max_group_members\":2,\"planted_persistent_helper_pid\":${S2_PRE_RELEASE_EXPECTED_HELPER_PID},\"planted_persistent_helper_rejected_samples\":40,\"payload_release_refused\":true,\"exact_pinned_group_reaped\":true,\"no_exact_group_survivor\":true,\"no_planted_persistent_helper_survivor\":true,\"reproduce\":\"S2_SHELL_REGRESSION_TEST=persistent-pre-release-helper scripts/e2e-s2-krater.sh\"}"
    return 0
  fi

  if [[ "${mode}" == "release-interleaving" ]]; then
    status_file="${S2_STATE_DIR}/release-interleaving-$(random_hex 8).status"
    S2_PLANT_RELEASE_INTERLEAVING=1 \
      start_pinned_supervisor "${status_file}" release-interleaving "${S2_STATE_DIR}" "${S2_PORT}" client \
        bash -c 'exit 0' || {
        emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"fail","code":"S2_RELEASE_INTERLEAVING_START_FAILED","reproduce":"S2_SHELL_REGRESSION_TEST=release-interleaving scripts/e2e-s2-krater.sh"}'
        return 1
      }
    supervisor_pid="${S2_STARTED_PID}"
    supervisor_pgid="${S2_STARTED_PGID}"
    supervisor_marker="${S2_STARTED_MARKER}"
    supervisor_status="${S2_STARTED_STATUS_FILE}"
    supervisor_watchdog_pid="${S2_STARTED_WATCHDOG_PID}"
    supervisor_watchdog_health="${S2_STARTED_WATCHDOG_HEALTH}"
    deadline=$((SECONDS + S2_READY_DEADLINE_SECONDS))
    while ! read_child_status "${supervisor_status}"; do
      supervisor_is_owned "${supervisor_pid}" "${supervisor_pgid}" "${supervisor_marker}" || {
        emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"fail","code":"S2_RELEASE_INTERLEAVING_OWNERSHIP_LOST","reproduce":"S2_SHELL_REGRESSION_TEST=release-interleaving scripts/e2e-s2-krater.sh"}'
        return 1
      }
      (( SECONDS < deadline )) || {
        emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"fail","code":"S2_RELEASE_INTERLEAVING_STATUS_TIMEOUT","reproduce":"S2_SHELL_REGRESSION_TEST=release-interleaving scripts/e2e-s2-krater.sh"}'
        return 1
      }
      sleep 0.05
    done
    [[ "${S2_CHILD_STATUS}" == "0" ]] || {
      emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"fail","code":"S2_RELEASE_INTERLEAVING_CHILD_STATUS_INVALID","reproduce":"S2_SHELL_REGRESSION_TEST=release-interleaving scripts/e2e-s2-krater.sh"}'
      return 1
    }
    stop_pinned_supervisor "${supervisor_pid}" "${supervisor_pgid}" "${supervisor_marker}" \
      "${supervisor_watchdog_pid}" "${supervisor_watchdog_health}" \
      "${S2_STATE_DIR}" "${S2_PORT}" client || {
        emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"fail","code":"S2_RELEASE_INTERLEAVING_STOP_FAILED","reproduce":"S2_SHELL_REGRESSION_TEST=release-interleaving scripts/e2e-s2-krater.sh"}'
        return 1
      }
    if kill -0 -- "-${supervisor_pgid}" 2>/dev/null; then
      emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"fail","code":"S2_RELEASE_INTERLEAVING_SURVIVOR","reproduce":"S2_SHELL_REGRESSION_TEST=release-interleaving scripts/e2e-s2-krater.sh"}'
      return 1
    fi
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"pass","scenario":"release-written-at-watchdog-publication-crosses-continuously-open-supervisor-fd8","reproduce":"S2_SHELL_REGRESSION_TEST=release-interleaving scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  if [[ "${mode}" == "term-interrupt-cleanup-child" ]]; then
    interrupt_record="${S2_PARENT_INTERRUPT_RECORD:-}"
    interrupt_secret="${S2_PARENT_INTERRUPT_SECRET:-}"
    [[ -n "${interrupt_record}" && -n "${interrupt_secret}" && \
      ! -e "${interrupt_record}" && ! -L "${interrupt_record}" ]] || return 2
    status_file="${S2_STATE_DIR}/parent-term-control-$(random_hex 8).status"
    # This is the exact former orphan shape: the payload resists group TERM, its status/control
    # phase is observed, then the controlling parent receives TERM before it can assign the
    # start result to the Worker or lifecycle ownership tables.
    # shellcheck disable=SC2016
    S2_PLANT_WATCHDOG_EXIT_ON_TERM=1 \
      start_pinned_supervisor "${status_file}" parent-term-control "${S2_STATE_DIR}" "${S2_PORT}" client \
        bash -c 'trap "" TERM; deadline=$((SECONDS + 4)); while (( SECONDS < deadline )); do read -r -t 1 ignored || :; done' || return 1
    supervisor_pid="${S2_STARTED_PID}"
    supervisor_pgid="${S2_STARTED_PGID}"
    supervisor_marker="${S2_STARTED_MARKER}"
    supervisor_status="${S2_STARTED_STATUS_FILE}"
    supervisor_watchdog_pid="${S2_STARTED_WATCHDOG_PID}"
    supervisor_watchdog_health="${S2_STARTED_WATCHDOG_HEALTH}"
    deadline=$((SECONDS + S2_READY_DEADLINE_SECONDS))
    while :; do
      group_members "${supervisor_pgid}" || return 1
      [[ ${S2_GROUP_MEMBER_COUNT} -ge 3 ]] && break
      (( SECONDS < deadline )) || return 1
      sleep 0.05
    done
    signal_owned_group TERM "${supervisor_pid}" "${supervisor_pgid}" "${supervisor_marker}" || return 1
    deadline=$((SECONDS + S2_READY_DEADLINE_SECONDS))
    while :; do
      if read_child_status "${supervisor_status}" && [[ "${S2_CHILD_STATUS}" == "143" && \
        -p "${supervisor_status}.control" ]] && \
        supervisor_is_owned "${supervisor_pid}" "${supervisor_pgid}" "${supervisor_marker}"; then
        break
      fi
      (( SECONDS < deadline )) || return 1
      sleep 0.05
    done
    child_diagnostic="${S2_STATE_DIR}/parent-term-control-diagnostic-$(random_hex 8).json"
    [[ ! -e "${child_diagnostic}" && ! -L "${child_diagnostic}" ]] || return 1
    printf '%s\n' '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"interrupted","code":"S2_PARENT_TERM_AFTER_CONTROL","child_status":143,"exact_group":true}' >"${child_diagnostic}"
    printf '%s %s %s %s %s %s %s %s\n' \
      "${supervisor_pid}" "${supervisor_pgid}" "${supervisor_marker}" "${S2_STATE_DIR}" \
      "${S2_PORT}" "${S2_RUN_DIR}" "${supervisor_status}" "${child_diagnostic}" >"${interrupt_record}"
    # Invoke the ordinary TERM -> EXIT cleanup path. It must consume S2_MOST_RECENT_SUPERVISOR
    # before this caller can ever enroll it in a narrower owner slot.
    kill -TERM "$$"
    return 125
  fi

  if [[ "${mode}" == "term-interrupt-cleanup" ]]; then
    interrupt_record="${S2_STATE_DIR}/parent-term-control-record-$(random_hex 8)"
    interrupt_secret="s2-parent-term-secret-must-not-appear"
    env \
      S2_SHELL_REGRESSION_TEST=term-interrupt-cleanup-child \
      S2_PARENT_INTERRUPT_RECORD="${interrupt_record}" \
      S2_PARENT_INTERRUPT_SECRET="${interrupt_secret}" \
      bash "${BASH_SOURCE[0]}" >/dev/null 2>&1 &
    interrupt_child=$!
    if wait "${interrupt_child}" 2>/dev/null; then
      interrupt_status=0
    else
      interrupt_status=$?
    fi
    [[ ${interrupt_status} -eq 143 && -f "${interrupt_record}" && ! -L "${interrupt_record}" ]] || return 1
    read -r supervisor_pid supervisor_pgid supervisor_marker child_persist child_port child_run \
      child_status_file child_diagnostic <"${interrupt_record}" || return 1
    is_decimal "${supervisor_pid}" && is_decimal "${supervisor_pgid}" && is_decimal "${child_port}" && \
      [[ "${supervisor_pid}" == "${supervisor_pgid}" && -n "${supervisor_marker}" && \
      "${child_persist}" == "${child_run}/main" && -d "${child_persist}" && ! -L "${child_persist}" && \
      -f "${child_status_file}" && ! -L "${child_status_file}" && \
      -p "${child_status_file}.control" && -f "${child_diagnostic}" && ! -L "${child_diagnostic}" ]] || return 1
    [[ "$(<"${child_status_file}")" == "143" ]] || return 1
    # A current cleanup reaches zero before this bound. A deliberately failing
    # old hook leaves a PPID-1 leader, which must be reaped only by its exact
    # PID/PGID/marker/persist/port identity rather than merely timing out.
    deadline=$((SECONDS + 5))
    while kill -0 -- "-${supervisor_pgid}" 2>/dev/null; do
      if (( SECONDS >= deadline )); then
        if reap_parent_terminated_supervisor_residual \
          "${supervisor_pid}" "${supervisor_pgid}" "${supervisor_marker}" \
          "${child_persist}" "${child_port}"; then
          emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"fail","code":"S2_PARENT_TERM_OLD_HOOK_RESIDUAL_REAPED","reproduce":"S2_SHELL_REGRESSION_TEST=term-interrupt-cleanup scripts/e2e-s2-krater.sh"}'
        else
          emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"fail","code":"S2_PARENT_TERM_RESIDUAL_UNPROVEN","reproduce":"S2_SHELL_REGRESSION_TEST=term-interrupt-cleanup scripts/e2e-s2-krater.sh"}'
        fi
        return 1
      fi
      sleep 0.1
    done
    assert_no_run_survivors "${child_persist}" "${child_port}" "${supervisor_marker}" || return 1
    diagnostic_body="$(<"${child_diagnostic}")"
    manifest_body="$(<"${child_run}/manifest.json")"
    [[ "${diagnostic_body}" == *'"code":"S2_PARENT_TERM_AFTER_CONTROL"'* && \
      "${diagnostic_body}" == *'"child_status":143'* && \
      "${manifest_body}" == *'"exit_code":143'* && \
      "${diagnostic_body}" != *"${interrupt_secret}"* && \
      "${manifest_body}" != *"${interrupt_secret}"* ]] || return 1
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"pass","scenario":"term-interrupted-parent-after-term-resistant-payload-control-status-cleans-most-recent-untracked-exact-supervisor","reproduce":"S2_SHELL_REGRESSION_TEST=term-interrupt-cleanup scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  if [[ "${mode}" == "term-resistant-release" ]]; then
    status_file="${S2_STATE_DIR}/term-resistant-release-$(random_hex 8).status"
    # The child Bash, not this harness, must expand its SECONDS-based deadline.
    # shellcheck disable=SC2016
    S2_PLANT_WATCHDOG_EXIT_ON_TERM=1 \
      start_pinned_supervisor "${status_file}" term-resistant-release "${S2_STATE_DIR}" "${S2_PORT}" client \
        bash -c 'trap "" TERM; deadline=$((SECONDS + 4)); while (( SECONDS < deadline )); do read -r -t 1 ignored || :; done' || {
          emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"fail","code":"S2_TERM_RESISTANT_START_FAILED","reproduce":"S2_SHELL_REGRESSION_TEST=term-resistant-release scripts/e2e-s2-krater.sh"}'
          return 1
        }
    supervisor_pid="${S2_STARTED_PID}"
    supervisor_pgid="${S2_STARTED_PGID}"
    supervisor_marker="${S2_STARTED_MARKER}"
    supervisor_watchdog_pid="${S2_STARTED_WATCHDOG_PID}"
    supervisor_watchdog_health="${S2_STARTED_WATCHDOG_HEALTH}"
    # This plant is leader + watchdog + TERM-resistant payload. The test watchdog exits on
    # group TERM, so the release branch must KILL the remaining exact leader/payload pair before
    # it releases the leader and loses the authority to clean up the payload. The payload has a
    # four-second self-expiry solely to prevent a deliberately failing old implementation from
    # leaving a test process behind after the regression reports failure.
    deadline=$((SECONDS + S2_READY_DEADLINE_SECONDS))
    while :; do
      group_members "${supervisor_pgid}" || {
        emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"fail","code":"S2_TERM_RESISTANT_GROUP_SCAN_FAILED","reproduce":"S2_SHELL_REGRESSION_TEST=term-resistant-release scripts/e2e-s2-krater.sh"}'
        return 1
      }
      # The watchdog briefly runs `sleep`, so there may be a fourth process while it publishes.
      # At least three proves that the TERM-resistant payload has actually started.
      [[ ${S2_GROUP_MEMBER_COUNT} -ge 3 ]] && break
      if (( SECONDS >= deadline )); then
        emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"fail","code":"S2_TERM_RESISTANT_PAYLOAD_NOT_READY","reproduce":"S2_SHELL_REGRESSION_TEST=term-resistant-release scripts/e2e-s2-krater.sh"}'
        return 1
      fi
      sleep 0.05
    done
    if [[ ${S2_GROUP_MEMBER_COUNT} -lt 3 ]]; then
      emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"fail","code":"S2_TERM_RESISTANT_PAYLOAD_GROUP_INVALID","reproduce":"S2_SHELL_REGRESSION_TEST=term-resistant-release scripts/e2e-s2-krater.sh"}'
      return 1
    fi
    stop_pinned_supervisor "${supervisor_pid}" "${supervisor_pgid}" "${supervisor_marker}" \
      "${supervisor_watchdog_pid}" "${supervisor_watchdog_health}" \
      "${S2_STATE_DIR}" "${S2_PORT}" client || return 1
    if kill -0 -- "-${supervisor_pgid}" 2>/dev/null; then return 1; fi
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"pass","scenario":"term-resistant-payload-after-watchdog-term-exit-is-killed-before-leader-release","reproduce":"S2_SHELL_REGRESSION_TEST=term-resistant-release scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  if [[ "${mode}" == "watchdog-self-retire" ]]; then
    status_file="${S2_STATE_DIR}/watchdog-self-retire-$(random_hex 8).status"
    if S2_PLANT_SUPERVISOR_EXIT_AFTER_WATCHDOG=1 \
      start_pinned_supervisor "${status_file}" watchdog-self-retire "${S2_STATE_DIR}" "${S2_PORT}" client \
        bash -c 'sleep 30'; then
      return 1
    fi
    deadline=$((SECONDS + S2_READY_DEADLINE_SECONDS + S2_WATCHDOG_MAX_UNCERTAIN_TICKS))
    is_decimal "${S2_LAST_SUPERVISOR_PGID}" || return 1
    while kill -0 -- "-${S2_LAST_SUPERVISOR_PGID}" 2>/dev/null; do
      (( SECONDS < deadline )) || return 1
      sleep 0.1
    done
    # No supervisor marker nor watchdog marker may outlive a supervisor that exited before
    # release. This exercises the bounded uncertain-inspection self-retirement branch.
    assert_no_run_survivors "${S2_STATE_DIR}" "${S2_PORT}" watchdog-self-retire || return 1
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"pass","scenario":"supervisor-exit125-leaves-no-bounded-uncertainty-watchdog-survivor","reproduce":"S2_SHELL_REGRESSION_TEST=watchdog-self-retire scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  if [[ "${mode}" == "watchdog-publication-delay" ]]; then
    local publication_started_at publication_elapsed
    status_file="${S2_STATE_DIR}/watchdog-publication-delay-$(random_hex 8).status"
    publication_started_at="${SECONDS}"
    S2_PLANT_WATCHDOG_PUBLICATION_DELAY_SECONDS=16 \
      start_pinned_supervisor "${status_file}" watchdog-publication-delay \
        "${S2_STATE_DIR}" "${S2_PORT}" client bash -c 'sleep 30' || return 1
    publication_elapsed=$((SECONDS - publication_started_at))
    [[ ${publication_elapsed} -ge 16 && "${S2_START_FAILURE_STAGE}" == "ready" ]] || return 1
    stop_pinned_supervisor \
      "${S2_STARTED_PID}" "${S2_STARTED_PGID}" "${S2_STARTED_MARKER}" \
      "${S2_STARTED_WATCHDOG_PID}" "${S2_STARTED_WATCHDOG_HEALTH}" \
      "${S2_STATE_DIR}" "${S2_PORT}" client || return 1
    kill -0 -- "-${S2_STARTED_PGID}" 2>/dev/null && return 1
    emit '{"tool":"bash+ps","package":"apps/wire","suite":"s2-krater-shell","status":"pass","scenario":"watchdog-publication-deadline-exceeds-runtime-fork-backoff-envelope","publication_delay_seconds":16,"payload_released_after_watchdog_proof":true,"no_exact_group_survivor":true,"reproduce":"S2_SHELL_REGRESSION_TEST=watchdog-publication-delay scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  if [[ "${mode}" == "watchdog-startup-diagnostics" ]]; then
    local fixture expected_status expected_phase expected_stage payload_started_file signal_name fixture_started_at fixture_elapsed
    for fixture in \
      preexisting-journal wrong-arm signal-hup signal-int signal-term \
      append-failure checkpoint-open-failure signal-term-hung-watchdog-scan; do
      status_file="${S2_STATE_DIR}/watchdog-startup-${fixture}-$(random_hex 8).status"
      payload_started_file="${S2_STATE_DIR}/watchdog-startup-${fixture}-$(random_hex 8).payload"
      expected_phase=""
      expected_stage=watchdog-arm-ack
      case "${fixture}" in
        preexisting-journal)
          expected_status="${S2_SUPERVISOR_STARTUP_CREATE_STATUS}"
          if S2_PLANT_STARTUP_JOURNAL_PREEXISTING=1 \
            start_pinned_supervisor "${status_file}" "watchdog-startup-${fixture}" \
              "${S2_STATE_DIR}" "${S2_PORT}" client \
              bash -c 'printf started >"$1"' s2-watchdog-startup-payload \
                "${payload_started_file}"; then
            return 1
          fi
          [[ "${S2_START_FAILURE_STAGE}" == "pre-arm-release-fifo" && \
            "${S2_START_SUPERVISOR_EXIT_STATUS}" == "${expected_status}" && \
            ! -e "${status_file}.release" && ! -L "${status_file}.release" && \
            "$(<"${status_file}.watchdog.startup")" == startup-sentinel ]] || return 1
          ;;
        wrong-arm)
          expected_status="${S2_SUPERVISOR_GATE_MISMATCH_STATUS}"
          expected_phase=arm-gate-mismatch
          if S2_PLANT_WRONG_ARM_TOKEN=1 \
            start_pinned_supervisor "${status_file}" "watchdog-startup-${fixture}" \
              "${S2_STATE_DIR}" "${S2_PORT}" client \
              bash -c 'printf started >"$1"' s2-watchdog-startup-payload \
                "${payload_started_file}"; then
            return 1
          fi
          ;;
        signal-hup|signal-int|signal-term)
          case "${fixture}" in
            signal-hup) signal_name=HUP; expected_status=129 ;;
            signal-int) signal_name=INT; expected_status=130 ;;
            signal-term) signal_name=TERM; expected_status=143 ;;
            *) return 1 ;;
          esac
          expected_phase="${fixture}"
          if S2_PLANT_SUPERVISOR_SIGNAL_AFTER_ARM="${signal_name}" \
            start_pinned_supervisor "${status_file}" "watchdog-startup-${fixture}" \
              "${S2_STATE_DIR}" "${S2_PORT}" client \
              bash -c 'printf started >"$1"' s2-watchdog-startup-payload \
                "${payload_started_file}"; then
            return 1
          fi
          ;;
        signal-term-hung-watchdog-scan)
          expected_status=143
          expected_phase=signal-term
          expected_stage=watchdog-publication
          fixture_started_at="${SECONDS}"
          if S2_PLANT_WATCHDOG_PS_HANG=1 \
            S2_PLANT_SUPERVISOR_SIGNAL_AFTER_WATCHDOG=TERM \
            start_pinned_supervisor "${status_file}" "watchdog-startup-${fixture}" \
              "${S2_STATE_DIR}" "${S2_PORT}" client \
              bash -c 'printf started >"$1"' s2-watchdog-startup-payload \
                "${payload_started_file}"; then
            return 1
          fi
          fixture_elapsed=$((SECONDS - fixture_started_at))
          [[ -f "${status_file}.watchdog.pid" && \
            ! -L "${status_file}.watchdog.pid" && \
            ${fixture_elapsed} -ge 1 && \
            ${fixture_elapsed} -lt ${S2_WATCHDOG_PUBLICATION_DEADLINE_SECONDS} ]] || return 1
          IFS= read -r watchdog_pid <"${status_file}.watchdog.pid" || return 1
          is_decimal "${watchdog_pid}" || return 1
          checkpoint_file_matches \
            "${status_file}.watchdog.scan-hang-armed" scan-hang-armed "${watchdog_pid}" || return 1
          ;;
        append-failure)
          expected_status="${S2_SUPERVISOR_CHECKPOINT_IO_STATUS}"
          expected_phase=arm-gate-consumed
          if S2_PLANT_STARTUP_JOURNAL_APPEND_FAILURE_AFTER_ARM=1 \
            start_pinned_supervisor "${status_file}" "watchdog-startup-${fixture}" \
              "${S2_STATE_DIR}" "${S2_PORT}" client \
              bash -c 'printf started >"$1"' s2-watchdog-startup-payload \
                "${payload_started_file}"; then
            return 1
          fi
          ;;
        checkpoint-open-failure)
          expected_status="${S2_SUPERVISOR_CHECKPOINT_IO_STATUS}"
          expected_phase=arm-checkpoint-write-failed
          if S2_PLANT_WATCHDOG_CHECKPOINT_OPEN_FAILURE=1 \
            start_pinned_supervisor "${status_file}" "watchdog-startup-${fixture}" \
              "${S2_STATE_DIR}" "${S2_PORT}" client \
              bash -c 'printf started >"$1"' s2-watchdog-startup-payload \
                "${payload_started_file}"; then
            return 1
          fi
          ;;
        *) return 1 ;;
      esac
      [[ "${S2_START_SUPERVISOR_EXIT_STATUS}" == "${expected_status}" && \
        ! -e "${payload_started_file}" && ! -L "${payload_started_file}" && \
        "$(stat -f '%Lp' "${status_file}.watchdog.startup")" == 600 ]] || return 1
      if [[ -n "${expected_phase}" ]]; then
        [[ "${S2_START_FAILURE_STAGE}" == "${expected_stage}" ]] || return 1
        startup_journal_last_phase \
          "${status_file}.watchdog.startup" "${S2_LAST_SUPERVISOR_PGID}" || return 1
        [[ "${S2_STARTUP_JOURNAL_PHASE}" == "${expected_phase}" ]] || return 1
      fi
      kill -0 -- "-${S2_LAST_SUPERVISOR_PGID}" 2>/dev/null && return 1
      assert_no_run_survivors \
        "${S2_STATE_DIR}" "${S2_PORT}" "${S2_LAST_SUPERVISOR_MARKER}" || return 1
    done
    status_file="${S2_STATE_DIR}/watchdog-startup-fragmented-arm-$(random_hex 8).status"
    payload_started_file="${S2_STATE_DIR}/watchdog-startup-fragmented-arm-$(random_hex 8).payload"
    S2_PLANT_FRAGMENTED_ARM_TOKEN=1 \
      start_pinned_supervisor "${status_file}" watchdog-startup-fragmented-arm \
        "${S2_STATE_DIR}" "${S2_PORT}" client \
        bash -c 'printf started >"$1"; sleep 30' s2-watchdog-startup-payload \
          "${payload_started_file}" || return 1
    checkpoint_file_matches \
      "${status_file}.watchdog.arm-fragment-observed" \
      arm-fragment-observed "${S2_STARTED_PID}" || return 1
    deadline=$((SECONDS + 5))
    while [[ ! -f "${payload_started_file}" ]]; do
      (( SECONDS < deadline )) || return 1
      sleep 0.05
    done
    [[ ! -L "${payload_started_file}" && \
      "$(stat -f '%z' "${payload_started_file}")" == 7 ]] || return 1
    stop_pinned_supervisor \
      "${S2_STARTED_PID}" "${S2_STARTED_PGID}" "${S2_STARTED_MARKER}" \
      "${S2_STARTED_WATCHDOG_PID}" "${S2_STARTED_WATCHDOG_HEALTH}" \
      "${S2_STATE_DIR}" "${S2_PORT}" client || return 1
    kill -0 -- "-${S2_STARTED_PGID}" 2>/dev/null && return 1
    emit '{"tool":"bash+fifo","package":"apps/wire","suite":"s2-krater-shell","status":"pass","scenario":"preopened-startup-journal-types-create-gate-signal-append-and-fragmented-read-outcomes","journal_mode":"0600","startup_create_status":73,"gate_mismatch_status":65,"signal_hup_status":129,"signal_int_status":130,"signal_term_status":143,"append_failure_status":74,"watchdog_scan_deadline_seconds":1,"fragmented_arm_token_accepted":true,"payload_release_refused_for_failures":true,"no_exact_group_survivor":true,"reproduce":"S2_SHELL_REGRESSION_TEST=watchdog-startup-diagnostics scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  if [[ "${mode}" == "watchdog-post-arm-abort" ]]; then
    local abort_started_at abort_elapsed payload_started_file
    status_file="${S2_STATE_DIR}/watchdog-post-arm-abort-$(random_hex 8).status"
    payload_started_file="${S2_STATE_DIR}/watchdog-post-arm-abort-$(random_hex 8).payload"
    abort_started_at="${SECONDS}"
    if S2_PLANT_WATCHDOG_PUBLICATION_DELAY_SECONDS=16 \
      S2_PLANT_ABORT_AFTER_WATCHDOG_LAUNCH=1 \
      start_pinned_supervisor "${status_file}" watchdog-post-arm-abort \
        "${S2_STATE_DIR}" "${S2_PORT}" client \
        bash -c 'printf started >"$1"' s2-watchdog-post-arm-abort-payload \
          "${payload_started_file}"; then
      return 1
    fi
    abort_elapsed=$((SECONDS - abort_started_at))
    [[ "${S2_START_FAILURE_STAGE}" == "watchdog-publication-abort-plant" && \
      "${S2_START_SUPERVISOR_EXIT_STATUS}" == 137 && \
      ${abort_elapsed} -ge 16 && ${abort_elapsed} -lt 40 && \
      -f "${status_file}.watchdog.arm-consumed" && \
      ! -L "${status_file}.watchdog.arm-consumed" && \
      -f "${status_file}.watchdog.launch" && ! -L "${status_file}.watchdog.launch" && \
      -f "${status_file}.watchdog.pid" && ! -L "${status_file}.watchdog.pid" && \
      ! -e "${payload_started_file}" && ! -L "${payload_started_file}" ]] || return 1
    checkpoint_file_matches \
      "${status_file}.watchdog.arm-consumed" arm-consumed \
      "${S2_LAST_SUPERVISOR_PGID}" || return 1
    checkpoint_file_matches \
      "${status_file}.watchdog.launch" spawn-attempted \
      "${S2_LAST_SUPERVISOR_PGID}" || return 1
    single_decimal_file "${status_file}.watchdog.pid" || return 1
    kill -0 -- "-${S2_LAST_SUPERVISOR_PGID}" 2>/dev/null && return 1
    assert_no_run_survivors \
      "${S2_STATE_DIR}" "${S2_PORT}" "${S2_LAST_SUPERVISOR_MARKER}" || return 1
    emit "{\"tool\":\"bash+fifo\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-shell\",\"status\":\"pass\",\"scenario\":\"post-arm-abort-remains-queued-across-publication-delay-and-kills-the-exact-child-owned-group\",\"arm_consumed\":true,\"spawn_attempted\":true,\"watchdog_pid_published\":true,\"supervisor_exit_status\":137,\"payload_release_refused\":true,\"no_exact_group_survivor\":true,\"reproduce\":\"S2_SHELL_REGRESSION_TEST=watchdog-post-arm-abort scripts/e2e-s2-krater.sh\"}"
    return 0
  fi

  if [[ "${mode}" == "watchdog-pre-publication-exit" ]]; then
    local payload_started_file
    status_file="${S2_STATE_DIR}/watchdog-pre-publication-exit-$(random_hex 8).status"
    payload_started_file="${S2_STATE_DIR}/watchdog-pre-publication-exit-$(random_hex 8).payload"
    if S2_PLANT_SUPERVISOR_EXIT_BEFORE_WATCHDOG_PUBLICATION=1 \
      start_pinned_supervisor "${status_file}" watchdog-pre-publication-exit \
        "${S2_STATE_DIR}" "${S2_PORT}" client \
        bash -c 'printf started >"$1"' s2-watchdog-pre-publication-payload \
          "${payload_started_file}"; then
      return 1
    fi
    [[ "${S2_START_FAILURE_STAGE}" == "watchdog-publication" && \
      "${S2_START_SUPERVISOR_EXIT_STATUS}" == 125 && \
      -f "${status_file}.watchdog.launch" && ! -L "${status_file}.watchdog.launch" && \
      ! -e "${status_file}.watchdog.pid" && ! -L "${status_file}.watchdog.pid" && \
      ! -e "${payload_started_file}" && ! -L "${payload_started_file}" ]] || return 1
    checkpoint_file_matches \
      "${status_file}.watchdog.launch" spawn-attempted \
      "${S2_LAST_SUPERVISOR_PGID}" || return 1
    kill -0 -- "-${S2_LAST_SUPERVISOR_PGID}" 2>/dev/null && return 1
    assert_no_run_survivors \
      "${S2_STATE_DIR}" "${S2_PORT}" "${S2_LAST_SUPERVISOR_MARKER}" || return 1
    emit '{"tool":"bash+ps","package":"apps/wire","suite":"s2-krater-shell","status":"pass","scenario":"supervisor-exit-before-watchdog-pid-publication-is-typed-bounded-and-never-releases-payload","start_failure_stage":"watchdog-publication","supervisor_exit_status":125,"payload_release_refused":true,"no_exact_group_survivor":true,"reproduce":"S2_SHELL_REGRESSION_TEST=watchdog-pre-publication-exit scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  if [[ "${mode}" == "watchdog-checkpoint-corruption" ]]; then
    local checkpoint_shape payload_started_file
    for checkpoint_shape in empty malformed extra-line wrong-pid; do
      status_file="${S2_STATE_DIR}/watchdog-checkpoint-${checkpoint_shape}-$(random_hex 8).status"
      payload_started_file="${S2_STATE_DIR}/watchdog-checkpoint-${checkpoint_shape}-$(random_hex 8).payload"
      if S2_PLANT_WATCHDOG_CHECKPOINT_CORRUPTION="${checkpoint_shape}" \
        start_pinned_supervisor "${status_file}" "watchdog-checkpoint-${checkpoint_shape}" \
          "${S2_STATE_DIR}" "${S2_PORT}" client \
          bash -c 'printf started >"$1"' s2-watchdog-checkpoint-payload \
            "${payload_started_file}"; then
        return 1
      fi
      [[ "${S2_START_FAILURE_STAGE}" == "watchdog-publication" && \
        "${S2_START_SUPERVISOR_EXIT_STATUS}" == 125 && \
        ! -e "${payload_started_file}" && ! -L "${payload_started_file}" ]] || return 1
      checkpoint_file_matches \
        "${status_file}.watchdog.arm-consumed" arm-consumed \
        "${S2_LAST_SUPERVISOR_PGID}" || return 1
      if checkpoint_file_matches \
        "${status_file}.watchdog.launch" spawn-attempted \
        "${S2_LAST_SUPERVISOR_PGID}"; then
        return 1
      fi
      kill -0 -- "-${S2_LAST_SUPERVISOR_PGID}" 2>/dev/null && return 1
      assert_no_run_survivors \
        "${S2_STATE_DIR}" "${S2_PORT}" "${S2_LAST_SUPERVISOR_MARKER}" || return 1
    done
    emit '{"tool":"bash+fifo","package":"apps/wire","suite":"s2-krater-shell","status":"pass","scenario":"malformed-watchdog-checkpoints-never-count-as-publication","empty_refused":true,"malformed_refused":true,"extra_line_refused":true,"wrong_pid_refused":true,"payload_release_refused":true,"no_exact_group_survivor":true,"reproduce":"S2_SHELL_REGRESSION_TEST=watchdog-checkpoint-corruption scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  if [[ "${mode}" == "journal-timestamps" ]]; then
    journal_valid="${S2_STATE_DIR}/journal-valid-$(random_hex 8).json"
    journal_alternate="${S2_STATE_DIR}/journal-alternate-$(random_hex 8).json"
    journal_invalid="${S2_STATE_DIR}/journal-invalid-$(random_hex 8).json"
    printf '%s\n' '[{"success":true,"results":[{"id":1,"name":"0001_krater_v0.sql","applied_at":"2026-08-14 09:25:35.123456"},{"id":2,"name":"0002_enrollment_g0.sql","applied_at":"2026-08-14 09:25:37"},{"id":3,"name":"0003_auth_nonce_replay.sql","applied_at":"2026-08-14 09:25:37"},{"id":4,"name":"0004_krater_integrity_v1.sql","applied_at":"2026-08-14 09:25:37"},{"id":5,"name":"0005_krater_undigested_index.sql","applied_at":"2026-08-14 09:25:37"},{"id":6,"name":"0006_fellow_credential_lifecycle.sql","applied_at":"2026-08-14 09:25:37"},{"id":7,"name":"0007_outbox_quarantine_state.sql","applied_at":"2026-08-14 09:25:37"},{"id":8,"name":"0008_sponsors_bootstrap.sql","applied_at":"2026-08-14 09:25:37"},{"id":9,"name":"0009_device_flow.sql","applied_at":"2026-08-14 09:25:37"},{"id":10,"name":"0010_device_flow_hardening.sql","applied_at":"2026-08-14 09:25:37"},{"id":11,"name":"0011_fellow_credential_hardening.sql","applied_at":"2026-08-14 09:25:37"}]}]' >"${journal_valid}"
    printf '%s\n' '[{"success":true,"results":[{"id":1,"name":"0001_krater_v0.sql","applied_at":"2026-08-14 10:25:35"},{"id":2,"name":"0002_enrollment_g0.sql","applied_at":"2026-08-14 10:25:37"},{"id":3,"name":"0003_auth_nonce_replay.sql","applied_at":"2026-08-14 10:25:37"},{"id":4,"name":"0004_krater_integrity_v1.sql","applied_at":"2026-08-14 10:25:37"},{"id":5,"name":"0005_krater_undigested_index.sql","applied_at":"2026-08-14 10:25:37"},{"id":6,"name":"0006_fellow_credential_lifecycle.sql","applied_at":"2026-08-14 10:25:37"},{"id":7,"name":"0007_outbox_quarantine_state.sql","applied_at":"2026-08-14 10:25:37"},{"id":8,"name":"0008_sponsors_bootstrap.sql","applied_at":"2026-08-14 10:25:37"},{"id":9,"name":"0009_device_flow.sql","applied_at":"2026-08-14 10:25:37"},{"id":10,"name":"0010_device_flow_hardening.sql","applied_at":"2026-08-14 10:25:37"},{"id":11,"name":"0011_fellow_credential_hardening.sql","applied_at":"2026-08-14 10:25:37"}]}]' >"${journal_alternate}"
    printf '%s\n' '[{"success":true,"results":[{"id":1,"name":"0001_krater_v0.sql","applied_at":"2026/08/14 09:25:35"},{"id":2,"name":"0002_enrollment_g0.sql","applied_at":"2026-08-14 09:25:37"},{"id":3,"name":"0003_auth_nonce_replay.sql","applied_at":"2026-08-14 09:25:37"},{"id":4,"name":"0004_krater_integrity_v1.sql","applied_at":"2026-08-14 09:25:37"},{"id":5,"name":"0005_krater_undigested_index.sql","applied_at":"2026-08-14 09:25:37"},{"id":6,"name":"0006_fellow_credential_lifecycle.sql","applied_at":"2026-08-14 09:25:37"},{"id":7,"name":"0007_outbox_quarantine_state.sql","applied_at":"2026-08-14 09:25:37"},{"id":8,"name":"0008_sponsors_bootstrap.sql","applied_at":"2026-08-14 09:25:37"},{"id":9,"name":"0009_device_flow.sql","applied_at":"2026-08-14 09:25:37"},{"id":10,"name":"0010_device_flow_hardening.sql","applied_at":"2026-08-14 09:25:37"},{"id":11,"name":"0011_fellow_credential_hardening.sql","applied_at":"2026-08-14 09:25:37"}]}]' >"${journal_invalid}"
    if valid_output="$(validate_current_migration_journal "${journal_valid}" journal-timestamp-valid)"; then :; else return 1; fi
    if alternate_output="$(validate_current_migration_journal "${journal_alternate}" journal-timestamp-alternate)"; then :; else return 1; fi
    if invalid_output="$(validate_current_migration_journal "${journal_invalid}" journal-timestamp-invalid)"; then return 1; fi
    [[ "${valid_output}" == *'"status":"pass"'* && \
      "${alternate_output}" == *'"status":"pass"'* && \
      "${invalid_output}" == *'"code":"S2_MIGRATION_JOURNAL_ENTRY_INVALID"'* ]] || return 1
    valid_digest="$(printf '%s\n' "${valid_output}" | sed -n 's/.*"journal_digest":"\([a-f0-9]*\)".*/\1/p')"
    alternate_digest="$(printf '%s\n' "${alternate_output}" | sed -n 's/.*"journal_digest":"\([a-f0-9]*\)".*/\1/p')"
    [[ "${valid_digest}" =~ ^[a-f0-9]{64}$ && "${valid_digest}" == "${alternate_digest}" ]] || return 1
    emit '{"tool":"bash+bun","package":"apps/wire","suite":"s2-krater-shell","status":"pass","scenario":"actual-journal-validator-accepts-d1-timestamp-refuses-malformed-and-digests-only-identity","reproduce":"S2_SHELL_REGRESSION_TEST=journal-timestamps scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  if [[ "${mode}" == "lsof-scan-failure" ]]; then
    lsof() {
      local arg
      for arg in "$@"; do
        [[ "${arg}" == "-p" ]] && { printf 'p%s\n' "$$"; return 0; }
      done
      return 1
    }
    # lsof's no-match result is precisely exit 1 with no output; accept that narrow case only.
    lsof_scan_has_no_matches -nP +D "${S2_STATE_DIR}" || return 1
    [[ "${S2_LSOF_LAST_STATUS}" == "1" && -z "${S2_LSOF_LAST_OUTPUT}" ]] || return 1
    lsof() {
      local arg warnings_enabled=0
      for arg in "$@"; do
        [[ "${arg}" == "-p" ]] && { printf 'p%s\n' "$$"; return 0; }
        [[ "${arg}" == "+w" ]] && warnings_enabled=1
      done
      if [[ ${warnings_enabled} -eq 1 ]]; then
        printf '%s\n' 'planted lsof traversal warning' >&2
      fi
      return 1
    }
    if assert_no_run_survivors "${S2_STATE_DIR}" "${S2_PORT}" planted-lsof-warning; then
      return 1
    fi
    [[ "${S2_SURVIVOR_ASSERTION_FAILURE}" == "state-fd-scan" && \
      "${S2_LSOF_LAST_STATUS}" == "1" && \
      "${S2_LSOF_LAST_OUTPUT}" == *'planted lsof traversal warning'* ]] || return 1
    lsof_transient_marker="${S2_STATE_DIR}/planted-lsof-transient-match-$(random_hex 8)"
    lsof() {
      local arg
      for arg in "$@"; do
        [[ "${arg}" == "-p" ]] && { printf 'p%s\n' "$$"; return 0; }
      done
      if [[ ! -e "${lsof_transient_marker}" && ! -L "${lsof_transient_marker}" ]]; then
        printf '%s\n' transient >"${lsof_transient_marker}" || return 2
        printf '%s\n' "$$"
        return 1
      fi
      return 1
    }
    assert_no_run_survivors "${S2_STATE_DIR}" "${S2_PORT}" planted-lsof-transient-match || return 1
    [[ -f "${lsof_transient_marker}" && ! -L "${lsof_transient_marker}" ]] || return 1
    lsof() {
      local arg
      for arg in "$@"; do
        [[ "${arg}" == "-p" ]] && { printf 'p%s\n' "$$"; return 0; }
      done
      printf '%s\n' 'planted lsof scanner failure' >&2
      return 2
    }
    if assert_no_run_survivors "${S2_STATE_DIR}" "${S2_PORT}" planted-lsof-scan; then return 1; fi
    [[ "${S2_LSOF_LAST_STATUS}" == "2" && \
      "${S2_LSOF_LAST_OUTPUT}" == *'planted lsof scanner failure'* ]] || return 1
    unset -f lsof
    lsof_held_file="${S2_STATE_DIR}/planted-lsof-held-open-$(random_hex 8)"
    [[ ! -e "${lsof_held_file}" && ! -L "${lsof_held_file}" ]] || return 1
    exec 6>"${lsof_held_file}" || return 1
    if assert_no_run_survivors "${S2_STATE_DIR}" "${S2_PORT}" planted-lsof-real-holder; then
      exec 6>&-
      emit '{"tool":"bash+lsof","package":"apps/wire","suite":"s2-krater-shell","status":"fail","code":"S2_LSOF_REAL_HOLDER_NOT_DETECTED","reproduce":"S2_SHELL_REGRESSION_TEST=lsof-scan-failure scripts/e2e-s2-krater.sh"}'
      return 1
    fi
    holder_status=1
    while IFS= read -r state_holders; do
      [[ "${state_holders}" == "$$" ]] && holder_status=0
    done <<<"${S2_LSOF_LAST_OUTPUT}"
    if [[ "${S2_SURVIVOR_ASSERTION_FAILURE}" != "state-fd-scan" || ${holder_status} -ne 0 ]]; then
      exec 6>&-
      emit "{\"tool\":\"bash+lsof\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-shell\",\"status\":\"fail\",\"code\":\"S2_LSOF_REAL_HOLDER_PROOF_MISMATCH\",\"check\":\"${S2_SURVIVOR_ASSERTION_FAILURE:-unknown}\",\"holder_includes_controller\":$(json_bool "$([[ ${holder_status} -eq 0 ]] && printf true || printf false)"),\"reproduce\":\"S2_SHELL_REGRESSION_TEST=lsof-scan-failure scripts/e2e-s2-krater.sh\"}"
      return 1
    fi
    exec 6>&-
    # With the real controller-held FD closed, a transient numeric observer match must converge
    # to an actual zero-holder sample rather than becoming a circular false positive.
    if ! assert_no_run_survivors "${S2_STATE_DIR}" "${S2_PORT}" planted-lsof-self-scan; then
      emit "{\"tool\":\"bash+lsof\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-shell\",\"status\":\"fail\",\"code\":\"S2_LSOF_SELF_SCAN_NOT_EXCLUDED\",\"check\":\"${S2_SURVIVOR_ASSERTION_FAILURE:-unknown}\",\"reproduce\":\"S2_SHELL_REGRESSION_TEST=lsof-scan-failure scripts/e2e-s2-krater.sh\"}"
      return 1
    fi
    # shellcheck disable=SC2329 # invoked indirectly by lsof_scanner_is_healthy below
    lsof() { printf '%s\n' 'planted lsof health failure' >&2; return 2; }
    if lsof_scanner_is_healthy; then return 1; fi
    [[ "${S2_LSOF_LAST_STATUS}" == "2" && \
      "${S2_LSOF_LAST_OUTPUT}" == *'planted lsof health failure'* ]] || return 1
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"pass","scenario":"lsof-empty-warning-transient-numeric-real-holder-captured-scan-and-health-failure-remain-distinct","reproduce":"S2_SHELL_REGRESSION_TEST=lsof-scan-failure scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  if [[ "${mode}" == "legacy-cleanup-failure" ]]; then
    S2_ACTIVE_ORIGIN="http://127.0.0.1:1"
    S2_PLANT_STOP_WORKER_FAILURE=1
    S2_PLANT_STOP_WORKER_MUTATED_ORIGIN="http://127.0.0.1:2"
    if stop_legacy_worker_or_fail; then
      return 1
    else
      cleanup_status=$?
    fi
    unset S2_PLANT_STOP_WORKER_FAILURE S2_PLANT_STOP_WORKER_MUTATED_ORIGIN
    [[ ${cleanup_status} -eq 1 && "${S2_ACTIVE_ORIGIN}" == "http://127.0.0.1:2" ]] || return 1
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"pass","scenario":"raw-legacy-cleanup-failure-propagates-and-preserves-observable-in-process-origin-mutation","reproduce":"S2_SHELL_REGRESSION_TEST=legacy-cleanup-failure scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  if [[ "${mode}" == "legacy-leader-loss" || \
    "${mode}" == "legacy-leader-loss-transient-ps" || \
    "${mode}" == "legacy-leader-loss-transient-post-arm-ps" ]]; then
    status_file="${S2_STATE_DIR}/legacy-leader-loss-$(random_hex 8).status"
    payload_ready_file="${S2_STATE_DIR}/legacy-leader-loss-$(random_hex 8).ready"
    payload_state_file="${S2_STATE_DIR}/legacy-leader-loss-$(random_hex 8).held-open"
    plant_clean_stop_bypass="${S2_PLANT_LEGACY_CLEAN_STOP_BYPASS:-0}"
    if [[ "${plant_clean_stop_bypass}" != 0 && "${plant_clean_stop_bypass}" != 1 ]]; then
      emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"fail","code":"S2_LEGACY_LEADER_LOSS_PLANT_INVALID","reproduce":"S2_SHELL_REGRESSION_TEST=legacy-leader-loss scripts/e2e-s2-krater.sh"}'
      return 2
    fi
    [[ ! -e "${payload_ready_file}" && ! -L "${payload_ready_file}" && \
      ! -e "${payload_state_file}" && ! -L "${payload_state_file}" ]] || return 1
    payload_behavior="resist-term"
    if [[ "${plant_clean_stop_bypass}" == 1 ]]; then payload_behavior="clean-stop"; fi
    # The plant first installs its signal behavior, then opens one retained state file and
    # publishes its exact PID. The controller does not send TERM until it has observed that PID
    # in the exact pinned group and through lsof on the open file. Unlike the former four-second
    # payload, this process has no independent expiry that can race an aggregate test scheduler.
    # shellcheck disable=SC2016
    local detached_ps_failure_once=0 detached_ps_failure_once_stage=pre-arm
    local detached_ps_one_shot_consumed=false
    if [[ "${mode}" == "legacy-leader-loss-transient-ps" || \
      "${mode}" == "legacy-leader-loss-transient-post-arm-ps" ]]; then
      detached_ps_failure_once=1
    fi
    if [[ "${mode}" == "legacy-leader-loss-transient-post-arm-ps" ]]; then
      detached_ps_failure_once_stage=post-arm
    fi
    if ! S2_PLANT_DETACHED_PS_FAILURE_ONCE="${detached_ps_failure_once}" \
      S2_PLANT_DETACHED_PS_FAILURE_ONCE_STAGE="${detached_ps_failure_once_stage}" \
      S2_PLANT_WATCHDOG_EXIT_ON_TERM="${plant_clean_stop_bypass}" \
      S2_PLANT_SUPERVISOR_EXIT_ON_TERM=1 \
      start_pinned_supervisor "${status_file}" legacy-leader-loss "${S2_STATE_DIR}" "${S2_PORT}" server \
        bash -c '
          ready_file="$1"
          state_file="$2"
          behavior="$3"
          if [[ "${behavior}" == "resist-term" ]]; then
            trap "" TERM HUP INT
          elif [[ "${behavior}" == "clean-stop" ]]; then
            trap "exit 0" TERM HUP INT
          else
            exit 125
          fi
          exec 9>"${state_file}" || exit 125
          printf "%s\n" "$$" >"${ready_file}" || exit 125
          while :; do read -r -t 1 ignored || :; done
        ' s2-legacy-leader-loss-payload \
          "${payload_ready_file}" "${payload_state_file}" "${payload_behavior}"; then
      arm_consumed=false
      spawn_attempted=false
      watchdog_pid_published=false
      supervisor_exit_status_json=null
      startup_phase_json=null
      checkpoint_file_matches \
        "${status_file}.watchdog.arm-consumed" arm-consumed \
        "${S2_LAST_SUPERVISOR_PGID}" && arm_consumed=true
      checkpoint_file_matches \
        "${status_file}.watchdog.launch" spawn-attempted \
        "${S2_LAST_SUPERVISOR_PGID}" && spawn_attempted=true
      single_decimal_file "${status_file}.watchdog.pid" && watchdog_pid_published=true
      if is_decimal "${S2_START_SUPERVISOR_EXIT_STATUS}"; then
        supervisor_exit_status_json="${S2_START_SUPERVISOR_EXIT_STATUS}"
      fi
      if startup_journal_last_phase \
        "${status_file}.watchdog.startup" "${S2_LAST_SUPERVISOR_PGID}"; then
        startup_phase_json="\"${S2_STARTUP_JOURNAL_PHASE}\""
      fi
      emit "{\"tool\":\"bash+ps\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-shell\",\"status\":\"fail\",\"code\":\"S2_LEGACY_LEADER_LOSS_START_FAILED\",\"start_failure_stage\":\"${S2_START_FAILURE_STAGE}\",\"startup_phase\":${startup_phase_json},\"arm_consumed\":${arm_consumed},\"spawn_attempted\":${spawn_attempted},\"watchdog_pid_published\":${watchdog_pid_published},\"supervisor_exit_status\":${supervisor_exit_status_json},\"pre_release_capture_uncertain_samples\":${S2_PRE_RELEASE_CAPTURE_UNCERTAIN_SAMPLES},\"post_arm_inspection_uncertain_samples\":${S2_POST_ARM_INSPECTION_UNCERTAIN_SAMPLES},\"reproduce\":\"S2_SHELL_REGRESSION_TEST=${mode} scripts/e2e-s2-krater.sh\"}"
      return 1
    fi
    if [[ "${detached_ps_failure_once}" == 1 ]]; then
      [[ -f "${S2_STATE_DIR}/.detached-ps-failure-once" && \
        ! -L "${S2_STATE_DIR}/.detached-ps-failure-once" ]] || return 1
      detached_ps_one_shot_consumed=true
      if [[ "${detached_ps_failure_once_stage}" == "pre-arm" ]]; then
        [[ ${S2_PRE_RELEASE_CAPTURE_UNCERTAIN_SAMPLES} -ge 1 ]] || return 1
      else
        [[ ${S2_POST_ARM_INSPECTION_UNCERTAIN_SAMPLES} -ge 1 ]] || return 1
      fi
    fi
    S2_SERVER_PID="${S2_STARTED_PID}"
    S2_SERVER_PGID="${S2_STARTED_PGID}"
    S2_SERVER_MARKER="${S2_STARTED_MARKER}"
    S2_SERVER_WATCHDOG_PID="${S2_STARTED_WATCHDOG_PID}"
    S2_SERVER_WATCHDOG_HEALTH="${S2_STARTED_WATCHDOG_HEALTH}"
    S2_SERVER_PERSIST="${S2_STATE_DIR}"
    S2_SERVER_PORT="${S2_PORT}"
    S2_ACTIVE_ORIGIN="http://127.0.0.1:1"
    deadline=$((SECONDS + S2_READY_DEADLINE_SECONDS))
    while :; do
      payload_ready_seen=false
      payload_state_regular=false
      payload_pid_valid=false
      state_holder_exact=false
      group_sufficient=false
      payload_in_group=false
      lsof_observation="not-run"
      if [[ -f "${payload_ready_file}" && ! -L "${payload_ready_file}" ]] && \
        IFS= read -r payload_pid <"${payload_ready_file}"; then
        payload_ready_seen=true
        if is_decimal "${payload_pid}"; then payload_pid_valid=true; fi
        if [[ -f "${payload_state_file}" && ! -L "${payload_state_file}" ]]; then
          payload_state_regular=true
          if state_holders="$(lsof -t +w -- "${payload_state_file}" 2>&1)"; then
            holder_status=0
          else
            holder_status=$?
          fi
          if [[ ${holder_status} -eq 0 ]]; then
            lsof_observation="match"
          elif [[ ${holder_status} -eq 1 && -z "${state_holders}" ]]; then
            lsof_observation="no-match"
          else
            lsof_observation="scan-failure"
          fi
          if [[ ${holder_status} -eq 0 && "${state_holders}" == "${payload_pid}" ]]; then
            state_holder_exact=true
          fi
        fi
      else
        payload_pid=""
        state_holders=""
        holder_status=1
      fi
      if ! group_members "${S2_SERVER_PGID}"; then
        emit '{"tool":"bash+ps","package":"apps/wire","suite":"s2-krater-shell","status":"fail","code":"S2_LEGACY_LEADER_LOSS_PAYLOAD_NOT_READY","reason":"process-group-scan","reproduce":"S2_SHELL_REGRESSION_TEST=legacy-leader-loss scripts/e2e-s2-krater.sh"}'
        return 1
      fi
      if [[ ${S2_GROUP_MEMBER_COUNT} -ge 3 ]]; then group_sufficient=true; fi
      if [[ "${payload_pid_valid}" == true ]] && group_contains_pid "${payload_pid}"; then
        payload_in_group=true
      fi
      if [[ "${group_sufficient}" == true && "${state_holder_exact}" == true && \
        "${payload_in_group}" == true ]]; then
        break
      fi
      if (( SECONDS >= deadline )); then
        emit "{\"tool\":\"bash+lsof+ps\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-shell\",\"status\":\"fail\",\"code\":\"S2_LEGACY_LEADER_LOSS_PAYLOAD_NOT_READY\",\"reason\":\"deadline\",\"ready_record\":${payload_ready_seen},\"state_file_regular\":${payload_state_regular},\"payload_pid_valid\":${payload_pid_valid},\"state_holder_exact\":${state_holder_exact},\"group_sufficient\":${group_sufficient},\"payload_in_exact_group\":${payload_in_group},\"lsof_observation\":\"${lsof_observation}\",\"reproduce\":\"S2_SHELL_REGRESSION_TEST=legacy-leader-loss scripts/e2e-s2-krater.sh\"}"
        return 1
      fi
      sleep 0.05
    done
    emit "{\"tool\":\"bash+lsof+ps\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-shell\",\"status\":\"pass\",\"scenario\":\"legacy-leader-loss\",\"assertion\":\"payload-ready-in-exact-group-with-retained-state-fd\",\"payload_in_exact_group\":true,\"state_fd_held\":true,\"detached_ps_one_shot_consumed\":${detached_ps_one_shot_consumed},\"detached_ps_one_shot_stage\":\"${detached_ps_failure_once_stage}\",\"pre_release_capture_uncertain_samples\":${S2_PRE_RELEASE_CAPTURE_UNCERTAIN_SAMPLES},\"post_arm_inspection_uncertain_samples\":${S2_POST_ARM_INSPECTION_UNCERTAIN_SAMPLES},\"reproduce\":\"S2_SHELL_REGRESSION_TEST=${mode} scripts/e2e-s2-krater.sh\"}"
    S2_LEGACY_REQUIRED_HELD_FILE="${payload_state_file}"
    if stop_legacy_worker_or_fail; then
      stop_status=0
    else
      stop_status=$?
    fi
    unset S2_LEGACY_REQUIRED_HELD_FILE
    if [[ ${stop_status} -eq 0 ]]; then
      assert_no_run_survivors "${S2_STATE_DIR}" "${S2_PORT}" "${S2_STARTED_MARKER}" || return 1
      emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"fail","code":"S2_LEGACY_LEADER_LOSS_BRANCH_NOT_REACHED","observed":"ordinary-clean-stop","expected":"inspection-uncertain-exact-residual-group","reproduce":"S2_SHELL_REGRESSION_TEST=legacy-leader-loss scripts/e2e-s2-krater.sh"}'
      return 1
    fi
    [[ ${stop_status} -eq 1 && "${S2_ACTIVE_ORIGIN}" == "http://127.0.0.1:1" && \
      -z "${S2_SERVER_PID}" ]] || return 1
    if kill -0 -- "-${S2_STARTED_PGID}" 2>/dev/null; then return 1; fi
    assert_no_run_survivors "${S2_STATE_DIR}" "${S2_PORT}" "${S2_STARTED_MARKER}" || return 1
    emit "{\"tool\":\"bash\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-shell\",\"status\":\"pass\",\"scenario\":\"legacy-term-leader-loss-bounds-inspection-publishes-uncertainty-and-kills-only-exact-residual-group\",\"detached_ps_one_shot_consumed\":${detached_ps_one_shot_consumed},\"detached_ps_one_shot_stage\":\"${detached_ps_failure_once_stage}\",\"pre_release_capture_uncertain_samples\":${S2_PRE_RELEASE_CAPTURE_UNCERTAIN_SAMPLES},\"post_arm_inspection_uncertain_samples\":${S2_POST_ARM_INSPECTION_UNCERTAIN_SAMPLES},\"cleanup_action\":\"kill-exact-residual-group\",\"reproduce\":\"S2_SHELL_REGRESSION_TEST=${mode} scripts/e2e-s2-krater.sh\"}"
    return 0
  fi

  if [[ "${mode}" == "watchdog-uncertainty" ]]; then
    status_file="${S2_STATE_DIR}/watchdog-uncertainty-$(random_hex 8).status"
    S2_PLANT_WATCHDOG_INSPECTION_UNCERTAIN=1 \
      start_pinned_supervisor "${status_file}" watchdog-uncertainty "${S2_STATE_DIR}" "${S2_PORT}" client \
        bash -c 'sleep 30' || return 1
    supervisor_pid="${S2_STARTED_PID}"
    supervisor_pgid="${S2_STARTED_PGID}"
    supervisor_marker="${S2_STARTED_MARKER}"
    supervisor_watchdog_pid="${S2_STARTED_WATCHDOG_PID}"
    supervisor_watchdog_health="${S2_STARTED_WATCHDOG_HEALTH}"
    # Trigger only after start_pinned_supervisor has completed both healthy
    # identity proofs. This makes the uncertainty plant causal, not timed.
    watchdog_is_healthy "${supervisor_watchdog_pid}" "${supervisor_pid}" \
      "${supervisor_pgid}" "${supervisor_marker}" "${supervisor_watchdog_health}" || return 1
    kill -USR2 "${supervisor_watchdog_pid}" 2>/dev/null || return 1
    deadline=$((SECONDS + S2_READY_DEADLINE_SECONDS))
    while (( SECONDS < deadline )); do
      read -r watchdog_state watchdog_health_pid < <(tail -n 1 "${supervisor_watchdog_health}") || return 1
      if [[ "${watchdog_state}" == "inspection-uncertain" && \
        "${watchdog_health_pid}" == "${supervisor_watchdog_pid}" ]]; then
        break
      fi
      sleep 0.05
    done
    [[ "${watchdog_state}" == "inspection-uncertain" ]] || return 1
    if stop_pinned_supervisor "${supervisor_pid}" "${supervisor_pgid}" "${supervisor_marker}" \
      "${supervisor_watchdog_pid}" "${supervisor_watchdog_health}" \
      "${S2_STATE_DIR}" "${S2_PORT}" client; then
      stop_status=0
    else
      stop_status=$?
    fi
    [[ ${stop_status} -eq 1 ]] || return 1
    if kill -0 -- "-${supervisor_pgid}" 2>/dev/null; then return 1; fi
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"pass","scenario":"planted-watchdog-inspection-uncertainty-is-observable-fails-closed-and-leaves-zero-survivors","reproduce":"S2_SHELL_REGRESSION_TEST=watchdog-uncertainty scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  if [[ "${mode}" == "unowned-refusal" ]]; then
    # Plant a missing identity proof. `signal_owned_group` must refuse before it attempts even
    # the otherwise harmless test-double kill, so a recycled PID/PGID can never be signalled.
    supervisor_is_owned() { return 1; }
    kill() { signal_called=$((signal_called + 1)); return 0; }
    if signal_owned_group TERM 4242 4242 planted-unowned; then
      emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"fail","code":"S2_UNOWNED_GROUP_SIGNALLED","reproduce":"S2_SHELL_REGRESSION_TEST=unowned-refusal scripts/e2e-s2-krater.sh"}'
      return 1
    fi
    if [[ ${signal_called} -ne 0 ]]; then
      emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"fail","code":"S2_UNOWNED_GROUP_KILL_ATTEMPTED","reproduce":"S2_SHELL_REGRESSION_TEST=unowned-refusal scripts/e2e-s2-krater.sh"}'
      return 1
    fi
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"pass","scenario":"planted-unowned-or-uninspectable-group-refuses-before-signal","reproduce":"S2_SHELL_REGRESSION_TEST=unowned-refusal scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  if [[ "${mode}" == "pinned-supervisor" ]]; then
    status_file="${S2_STATE_DIR}/shell-pinned-$(random_hex 8).status"
    start_pinned_supervisor "${status_file}" shell-pinned "${S2_STATE_DIR}" "${S2_PORT}" client \
      bash -c 'exit 0' || return 1
    supervisor_pid="${S2_STARTED_PID}"
    supervisor_pgid="${S2_STARTED_PGID}"
    supervisor_marker="${S2_STARTED_MARKER}"
    supervisor_status="${S2_STARTED_STATUS_FILE}"
    supervisor_watchdog_pid="${S2_STARTED_WATCHDOG_PID}"
    supervisor_watchdog_health="${S2_STARTED_WATCHDOG_HEALTH}"
    deadline=$((SECONDS + S2_READY_DEADLINE_SECONDS))
    while ! read_child_status "${supervisor_status}"; do
      supervisor_is_owned "${supervisor_pid}" "${supervisor_pgid}" "${supervisor_marker}" || return 1
      (( SECONDS < deadline )) || return 1
      sleep 0.05
    done
    [[ "${S2_CHILD_STATUS}" == "0" ]] || return 1
    supervisor_is_owned "${supervisor_pid}" "${supervisor_pgid}" "${supervisor_marker}" || return 1
    group_members "${supervisor_pgid}" || return 1
    # The controller is holding a live supervisor plus its parent-loss watchdog. The stop path
    # must TERM that owned group, observe the watchdog leave, then release the final leader.
    [[ ${S2_GROUP_MEMBER_COUNT} -ge 2 ]] || return 1
    stop_pinned_supervisor "${supervisor_pid}" "${supervisor_pgid}" "${supervisor_marker}" \
      "${supervisor_watchdog_pid}" "${supervisor_watchdog_health}" \
      "${S2_STATE_DIR}" "${S2_PORT}" client || return 1
    if kill -0 -- "-${supervisor_pgid}" 2>/dev/null; then return 1; fi
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"pass","scenario":"planted-stopped-before-exec-pinned-supervisor-records-exit-and-releases-owned-empty-group","reproduce":"S2_SHELL_REGRESSION_TEST=pinned-supervisor scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  if [[ "${mode}" == "redaction" ]]; then
    redaction_log="${S2_STATE_DIR}/planted-redaction-$(random_hex 8).log"
    {
      printf '%s\n' \
        'Authorization: Bearer S2BearerSecretValue0123456789' \
        '{"token":"S2JsonTokenValue0123456789","signature":"S2SignatureValue0123456789","fragment":"#v1.S2FragmentSecretValue0123456789"}' \
        'token=S2PartialTokenValue0123456789 signature S2PartialSignature0123456789'
      # Put this bearer value across the final 2K clipping boundary. If clipping happened first,
      # the surviving token suffix would no longer be preceded by `Bearer` and would leak.
      printf '%*s' 1000 '' | tr ' ' x
      printf ' '
      printf '%s' 'Bearer S2BoundaryBearerSecret0123456789'
      printf '%*s\n' 1965 '' | tr ' ' x
    } >"${redaction_log}"
    redaction_cause="$(redacted_wrangler_cause "${redaction_log}")"
    for source_path in \
      S2BearerSecretValue0123456789 \
      S2JsonTokenValue0123456789 \
      S2SignatureValue0123456789 \
      S2FragmentSecretValue0123456789 \
      S2PartialTokenValue0123456789 \
      S2PartialSignature0123456789 \
      S2BoundaryBearerSecret0123456789; do
      [[ "${redaction_cause}" != *"${source_path}"* ]] || return 1
    done
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"pass","scenario":"planted-bearer-json-fragment-and-partial-log-secrets-redacted-before-clipping","reproduce":"S2_SHELL_REGRESSION_TEST=redaction scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  if [[ "${mode}" == "provenance" ]]; then
    for source_path in \
      apps/wire/src/krater/wrangler.s2-legacy.toml \
      apps/wire/src/krater/wrangler.s2-upgrade.toml \
      apps/wire/src/krater/fixtures/legacy-existing-event.sql \
      apps/wire/src/krater/fixtures/legacy-migrations/0001_krater_v0.sql; do
      [[ " ${S2_SOURCE_PATHS[*]} " == *" ${source_path} "* ]] || return 1
    done
    assert_legacy_fixture_bytes || return 1
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"pass","scenario":"legacy-config-fixture-and-exact-0001-are-in-provenance-and-dirty-inputs","reproduce":"S2_SHELL_REGRESSION_TEST=provenance scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  [[ "${mode}" == "indexed-phase-status" ]] || return 2

  # This deliberately never starts a Wrangler dev server. It plants the exact indexed-phase
  # failure that used to be inverted by `if ! run_phase`; both helper boundaries must preserve
  # exit 91.
  run_phase() { return 91; }
  emit_legacy_failure() { emitted_phase="$1"; }
  if run_legacy_phase "upgrade-indexed" "/dev/null"; then
    phase_status=0
  else
    phase_status=$?
  fi
  if [[ ${phase_status} -ne 91 || "${emitted_phase}" != "upgrade-indexed" ]]; then
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"fail","code":"S2_INDEXED_FAILURE_STATUS_MASKED","reproduce":"S2_SHELL_REGRESSION_TEST=indexed-phase-status scripts/e2e-s2-krater.sh"}'
    return 1
  fi

  run_legacy_upgrade() { return "${phase_status}"; }
  if run_legacy_upgrade_checked "upgrade-existing" "" "upgrade-indexed"; then
    upgrade_status=0
  else
    upgrade_status=$?
  fi
  if [[ ${upgrade_status} -ne 91 ]]; then
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"fail","code":"S2_UPGRADE_FAILURE_STATUS_MASKED","reproduce":"S2_SHELL_REGRESSION_TEST=indexed-phase-status scripts/e2e-s2-krater.sh"}'
    return 1
  fi
  emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-shell","status":"pass","scenario":"planted-indexed-phase-failure-preserves-nonzero-status","reproduce":"S2_SHELL_REGRESSION_TEST=indexed-phase-status scripts/e2e-s2-krater.sh"}'
}

if [[ "${S2_SHELL_REGRESSION_TEST:-none}" != "none" ]]; then
  if run_s2_shell_regression_test "${S2_SHELL_REGRESSION_TEST}"; then
    exit 0
  else
    S2_SHELL_REGRESSION_STATUS=$?
    if [[ "${S2_SHELL_REGRESSION_TEST}" =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]]; then
      S2_SHELL_REGRESSION_DIAGNOSTIC="${S2_SHELL_REGRESSION_TEST}"
    else
      S2_SHELL_REGRESSION_DIAGNOSTIC="invalid"
    fi
    emit "{\"tool\":\"bash\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-shell\",\"status\":\"fail\",\"code\":\"S2_SHELL_REGRESSION_FAILED\",\"scenario\":\"${S2_SHELL_REGRESSION_DIAGNOSTIC}\",\"exit_code\":${S2_SHELL_REGRESSION_STATUS},\"reproduce\":\"scripts/e2e-s2-krater.sh\"}"
    exit "${S2_SHELL_REGRESSION_STATUS}"
  fi
fi

launch_lifecycle_child() {
  local port="$1" log="$2" interrupt_after_ready="$3" state_dir="$4" block_after_ready="${5:-0}"
  local on_exit_second_signal="${6:-0}" ready_file
  [[ "${block_after_ready}" == 0 || "${block_after_ready}" == 1 ]] || return 1
  [[ "${on_exit_second_signal}" == 0 || "${on_exit_second_signal}" == 1 ]] || return 1
  ready_file="${state_dir}/ready-${port}-$(random_hex 8)"
  start_pinned_supervisor "${state_dir}/child-${port}-$(random_hex 8).status" "lifecycle-${port}" \
    "${state_dir}" "${port}" client \
    env \
      S2_PORT="${port}" \
      S2_LIFECYCLE_TEST="none" \
      S2_INTERRUPT_AFTER_READY="${interrupt_after_ready}" \
      S2_LIFECYCLE_BLOCK_AFTER_READY="${block_after_ready}" \
      S2_PLANT_ON_EXIT_SECOND_SIGNAL="${on_exit_second_signal}" \
      S2_LIFECYCLE_READY_FILE="${ready_file}" \
      bash "${BASH_SOURCE[0]}" >"${log}" 2>&1 || return 1
  S2_LIFECYCLE_CHILD_PID="${S2_STARTED_PID}"
  S2_LIFECYCLE_CHILD_PGID="${S2_STARTED_PGID}"
  S2_LIFECYCLE_CHILD_MARKER="${S2_STARTED_MARKER}"
  S2_LIFECYCLE_CHILD_STATUS_FILE="${S2_STARTED_STATUS_FILE}"
  S2_LIFECYCLE_CHILD_WATCHDOG_PID="${S2_STARTED_WATCHDOG_PID}"
  S2_LIFECYCLE_CHILD_WATCHDOG_HEALTH="${S2_STARTED_WATCHDOG_HEALTH}"
  S2_LIFECYCLE_READY_FILE="${ready_file}"
  remember_lifecycle_supervisor \
    "${S2_LIFECYCLE_CHILD_PID}" \
    "${S2_LIFECYCLE_CHILD_PGID}" \
    "${S2_LIFECYCLE_CHILD_MARKER}" \
    "${S2_LIFECYCLE_CHILD_STATUS_FILE}" \
    "${S2_LIFECYCLE_CHILD_WATCHDOG_PID}" \
    "${S2_LIFECYCLE_CHILD_WATCHDOG_HEALTH}" \
    "${state_dir}" \
    "${port}"
  clear_most_recent_supervisor_if_marker "${S2_LIFECYCLE_CHILD_MARKER}"
}

wait_for_lifecycle_port() {
  local port="$1" pid="$2" pgid="$3" marker="$4" ready_file="$5" ready_id
  local deadline=$((SECONDS + S2_READY_DEADLINE_SECONDS))
  while (( SECONDS < deadline )); do
    supervisor_is_owned "${pid}" "${pgid}" "${marker}" || return 1
    if [[ -f "${ready_file}" && ! -L "${ready_file}" ]] && \
      IFS= read -r ready_id <"${ready_file}" && \
      [[ "${ready_id}" =~ ^[a-f0-9]{32}$ ]] && port_is_busy "${port}"; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

wait_for_lifecycle_child() {
  local pid="$1" pgid="$2" marker="$3" status_file="$4" watchdog_pid="$5"
  local watchdog_health="$6" state_dir="$7" port="$8" deadline_seconds="${9:-${S2_LIFECYCLE_DEADLINE_SECONDS}}" tick
  [[ "${deadline_seconds}" =~ ^[1-9][0-9]*$ ]] || return 125
  local deadline=$((SECONDS + deadline_seconds))
  while :; do
    if read_child_status "${status_file}"; then
      stop_pinned_supervisor "${pid}" "${pgid}" "${marker}" \
        "${watchdog_pid}" "${watchdog_health}" "${state_dir}" "${port}" client || return 125
      forget_lifecycle_supervisor "${marker}" || return 125
      return "${S2_CHILD_STATUS}"
    fi
    supervisor_is_owned "${pid}" "${pgid}" "${marker}" || return 125
    if (( SECONDS >= deadline )); then
      signal_owned_group TERM "${pid}" "${pgid}" "${marker}" || return 125
      for ((tick = 0; tick < S2_TERMINATE_WAIT_TICKS; tick += 1)); do
        if read_child_status "${status_file}"; then
          stop_pinned_supervisor "${pid}" "${pgid}" "${marker}" \
            "${watchdog_pid}" "${watchdog_health}" "${state_dir}" "${port}" client || return 125
          forget_lifecycle_supervisor "${marker}" || return 125
          # A deadline is a typed timeout regardless of the inner script's
          # signal-specific status. The retained child status remains evidence.
          return 124
        fi
        if ! supervisor_is_owned "${pid}" "${pgid}" "${marker}"; then
          if read_child_status "${status_file}"; then
            forget_lifecycle_supervisor "${marker}" || return 125
            return 124
          fi
          return 125
        fi
        sleep 0.1
      done
      stop_pinned_supervisor "${pid}" "${pgid}" "${marker}" \
        "${watchdog_pid}" "${watchdog_health}" "${state_dir}" "${port}" client || return 125
      forget_lifecycle_supervisor "${marker}" || return 125
      return 124
    fi
    sleep 0.1
  done
}

run_lifecycle_self_test() {
  local mode="$1" state_dir first_port second_port first_pid second_pid first_pgid second_pgid
  local first_marker second_marker first_status_file second_status_file first_ready_file second_ready_file
  local first_watchdog_pid second_watchdog_pid first_watchdog_health second_watchdog_health
  local first_status second_status
  state_dir="$(create_evidence_subdir lifecycle)"
  if [[ ! -d "${state_dir}" || -L "${state_dir}" ]]; then
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-lifecycle","status":"fail","code":"S2_LIFECYCLE_PERSIST_DIR_INVALID","reproduce":"S2_LIFECYCLE_TEST=parallel scripts/e2e-s2-krater.sh"}'
    return 1
  fi
  if ! first_port="$(choose_available_port)"; then
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-lifecycle","status":"fail","code":"S2_LIFECYCLE_PORT_UNAVAILABLE","reproduce":"S2_LIFECYCLE_TEST=parallel scripts/e2e-s2-krater.sh"}'
    return 1
  fi

  if [[ "${mode}" == "parallel" ]]; then
    launch_lifecycle_child "${first_port}" "${state_dir}/parallel-one.log" 0 "${state_dir}"
    first_pid="${S2_LIFECYCLE_CHILD_PID}"
    first_pgid="${S2_LIFECYCLE_CHILD_PGID}"
    first_marker="${S2_LIFECYCLE_CHILD_MARKER}"
    first_status_file="${S2_LIFECYCLE_CHILD_STATUS_FILE}"
    first_watchdog_pid="${S2_LIFECYCLE_CHILD_WATCHDOG_PID}"
    first_watchdog_health="${S2_LIFECYCLE_CHILD_WATCHDOG_HEALTH}"
    first_ready_file="${S2_LIFECYCLE_READY_FILE}"
    if ! wait_for_lifecycle_port "${first_port}" "${first_pid}" "${first_pgid}" \
      "${first_marker}" "${first_ready_file}"; then
      wait_for_lifecycle_child "${first_pid}" "${first_pgid}" \
        "${first_marker}" "${first_status_file}" "${first_watchdog_pid}" \
        "${first_watchdog_health}" "${state_dir}" "${first_port}" || :
      emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-lifecycle","status":"fail","code":"S2_PARALLEL_FIRST_NOT_READY","reproduce":"S2_LIFECYCLE_TEST=parallel scripts/e2e-s2-krater.sh"}'
      return 1
    fi
    if ! second_port="$(choose_available_port)"; then
      wait_for_lifecycle_child "${first_pid}" "${first_pgid}" \
        "${first_marker}" "${first_status_file}" "${first_watchdog_pid}" \
        "${first_watchdog_health}" "${state_dir}" "${first_port}" || :
      emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-lifecycle","status":"fail","code":"S2_PARALLEL_SECOND_PORT_UNAVAILABLE","reproduce":"S2_LIFECYCLE_TEST=parallel scripts/e2e-s2-krater.sh"}'
      return 1
    fi
    launch_lifecycle_child "${second_port}" "${state_dir}/parallel-two.log" 0 "${state_dir}"
    second_pid="${S2_LIFECYCLE_CHILD_PID}"
    second_pgid="${S2_LIFECYCLE_CHILD_PGID}"
    second_marker="${S2_LIFECYCLE_CHILD_MARKER}"
    second_status_file="${S2_LIFECYCLE_CHILD_STATUS_FILE}"
    second_watchdog_pid="${S2_LIFECYCLE_CHILD_WATCHDOG_PID}"
    second_watchdog_health="${S2_LIFECYCLE_CHILD_WATCHDOG_HEALTH}"
    second_ready_file="${S2_LIFECYCLE_READY_FILE}"
    if ! wait_for_lifecycle_port "${second_port}" "${second_pid}" "${second_pgid}" \
      "${second_marker}" "${second_ready_file}"; then
      wait_for_lifecycle_child "${first_pid}" "${first_pgid}" \
        "${first_marker}" "${first_status_file}" "${first_watchdog_pid}" \
        "${first_watchdog_health}" "${state_dir}" "${first_port}" || :
      wait_for_lifecycle_child "${second_pid}" "${second_pgid}" \
        "${second_marker}" "${second_status_file}" "${second_watchdog_pid}" \
        "${second_watchdog_health}" "${state_dir}" "${second_port}" || :
      emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-lifecycle","status":"fail","code":"S2_PARALLEL_SECOND_NOT_READY","reproduce":"S2_LIFECYCLE_TEST=parallel scripts/e2e-s2-krater.sh"}'
      return 1
    fi
    # Each child is self-contained: the recorded status comes from its own pinned supervisor,
    # while this parent retains and proves the outer lifecycle supervisor before releasing it.
    if wait_for_lifecycle_child "${first_pid}" "${first_pgid}" \
      "${first_marker}" "${first_status_file}" "${first_watchdog_pid}" \
      "${first_watchdog_health}" "${state_dir}" "${first_port}"; then first_status=0; else first_status=$?; fi
    if wait_for_lifecycle_child "${second_pid}" "${second_pgid}" \
      "${second_marker}" "${second_status_file}" "${second_watchdog_pid}" \
      "${second_watchdog_health}" "${state_dir}" "${second_port}"; then second_status=0; else second_status=$?; fi
    if [[ ${first_status} -ne 78 || ${second_status} -ne 78 ]] || \
      port_is_busy "${first_port}" || port_is_busy "${second_port}"; then
      emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-lifecycle","status":"fail","code":"S2_PARALLEL_ISOLATION_FAILED","reproduce":"S2_LIFECYCLE_TEST=parallel scripts/e2e-s2-krater.sh"}'
      return 1
    fi
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-lifecycle","status":"pass","scenario":"two-concurrent-local-workerd-runs-use-isolated-main-and-inspector-ports","reproduce":"S2_LIFECYCLE_TEST=parallel scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  if [[ "${mode}" == "sigterm" ]]; then
    launch_lifecycle_child "${first_port}" "${state_dir}/sigterm.log" 0 "${state_dir}" 0 1
    first_pid="${S2_LIFECYCLE_CHILD_PID}"
    first_pgid="${S2_LIFECYCLE_CHILD_PGID}"
    first_marker="${S2_LIFECYCLE_CHILD_MARKER}"
    first_status_file="${S2_LIFECYCLE_CHILD_STATUS_FILE}"
    first_watchdog_pid="${S2_LIFECYCLE_CHILD_WATCHDOG_PID}"
    first_watchdog_health="${S2_LIFECYCLE_CHILD_WATCHDOG_HEALTH}"
    first_ready_file="${S2_LIFECYCLE_READY_FILE}"
    if ! wait_for_lifecycle_port "${first_port}" "${first_pid}" "${first_pgid}" \
      "${first_marker}" "${first_ready_file}"; then
      wait_for_lifecycle_child "${first_pid}" "${first_pgid}" \
        "${first_marker}" "${first_status_file}" "${first_watchdog_pid}" \
        "${first_watchdog_health}" "${state_dir}" "${first_port}" || :
      emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-lifecycle","status":"fail","code":"S2_SIGTERM_FIXTURE_NOT_READY","reproduce":"S2_LIFECYCLE_TEST=sigterm scripts/e2e-s2-krater.sh"}'
      return 1
    fi
    # The parent has just proved the outer supervisor, the randomized readiness response, and
    # the owned listener. Signal only that exact live group; the nested script receives TERM,
    # runs its EXIT cleanup, and records 143 for the still-pinned outer supervisor to release.
    if ! signal_owned_group TERM "${first_pid}" "${first_pgid}" "${first_marker}"; then
      emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-lifecycle","status":"fail","code":"S2_SIGTERM_OWNERSHIP_UNPROVEN","reproduce":"S2_LIFECYCLE_TEST=sigterm scripts/e2e-s2-krater.sh"}'
      return 1
    fi
    if wait_for_lifecycle_child "${first_pid}" "${first_pgid}" \
      "${first_marker}" "${first_status_file}" "${first_watchdog_pid}" \
      "${first_watchdog_health}" "${state_dir}" "${first_port}"; then first_status=0; else first_status=$?; fi
    if [[ ${first_status} -ne 143 ]] || port_is_busy "${first_port}"; then
      emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-lifecycle","status":"fail","code":"S2_SIGTERM_SURVIVOR","reproduce":"S2_LIFECYCLE_TEST=sigterm scripts/e2e-s2-krater.sh"}'
      return 1
    fi
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-lifecycle","status":"pass","scenario":"planted-sigterm-with-follow-up-term-keeps-on-exit-cleanup-immune-and-leaves-no-listener","reproduce":"S2_LIFECYCLE_TEST=sigterm scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  if [[ "${mode}" == "deadline" ]]; then
    launch_lifecycle_child "${first_port}" "${state_dir}/deadline.log" 0 "${state_dir}" 1
    first_pid="${S2_LIFECYCLE_CHILD_PID}"
    first_pgid="${S2_LIFECYCLE_CHILD_PGID}"
    first_marker="${S2_LIFECYCLE_CHILD_MARKER}"
    first_status_file="${S2_LIFECYCLE_CHILD_STATUS_FILE}"
    first_watchdog_pid="${S2_LIFECYCLE_CHILD_WATCHDOG_PID}"
    first_watchdog_health="${S2_LIFECYCLE_CHILD_WATCHDOG_HEALTH}"
    first_ready_file="${S2_LIFECYCLE_READY_FILE}"
    if ! wait_for_lifecycle_port "${first_port}" "${first_pid}" "${first_pgid}" \
      "${first_marker}" "${first_ready_file}"; then
      wait_for_lifecycle_child "${first_pid}" "${first_pgid}" \
        "${first_marker}" "${first_status_file}" "${first_watchdog_pid}" \
        "${first_watchdog_health}" "${state_dir}" "${first_port}" 1 || :
      emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-lifecycle","status":"fail","code":"S2_DEADLINE_FIXTURE_NOT_READY","reproduce":"S2_LIFECYCLE_TEST=deadline scripts/e2e-s2-krater.sh"}'
      return 1
    fi
    if wait_for_lifecycle_child "${first_pid}" "${first_pgid}" \
      "${first_marker}" "${first_status_file}" "${first_watchdog_pid}" \
      "${first_watchdog_health}" "${state_dir}" "${first_port}" 1; then
      first_status=0
    else
      first_status=$?
    fi
    if [[ ${first_status} -ne 124 ]] || port_is_busy "${first_port}"; then
      emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-lifecycle","status":"fail","code":"S2_LIFECYCLE_DEADLINE_TYPED_EXIT_FAILED","reproduce":"S2_LIFECYCLE_TEST=deadline scripts/e2e-s2-krater.sh"}'
      return 1
    fi
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-lifecycle","status":"pass","scenario":"deadline-reaps-exact-child-and-returns-typed-124-not-inner-signal-status","reproduce":"S2_LIFECYCLE_TEST=deadline scripts/e2e-s2-krater.sh"}'
    return 0
  fi

  emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-lifecycle","status":"fail","code":"S2_LIFECYCLE_TEST_INVALID","reproduce":"S2_LIFECYCLE_TEST=parallel|sigterm|deadline scripts/e2e-s2-krater.sh"}'
  return 1
}

if [[ "${S2_LIFECYCLE_TEST:-none}" == "parallel" || "${S2_LIFECYCLE_TEST:-none}" == "sigterm" || \
  "${S2_LIFECYCLE_TEST:-none}" == "deadline" ]]; then
  run_lifecycle_self_test "${S2_LIFECYCLE_TEST}"
  exit $?
fi

if ! assert_legacy_fixture_bytes; then
  exit 1
fi

if ! "${S2_WRANGLER}" d1 migrations apply DB --config "${S2_WRANGLER_CONFIG}" --local --persist-to "${S2_STATE_DIR}" >"${S2_STATE_DIR}/migration.log" 2>&1; then
  emit_wrangler_failure "LOCAL_D1_MIGRATION_FAILED"
  exit 1
fi

if ! start_worker; then
  emit_wrangler_failure "LOCAL_WORKER_UNAVAILABLE"
  exit 1
fi

if [[ -n "${S2_LIFECYCLE_READY_FILE:-}" ]]; then
  if [[ -e "${S2_LIFECYCLE_READY_FILE}" || -L "${S2_LIFECYCLE_READY_FILE}" ]]; then
    emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-lifecycle","status":"fail","code":"S2_LIFECYCLE_READY_FILE_UNSAFE","reproduce":"S2_LIFECYCLE_TEST=parallel scripts/e2e-s2-krater.sh"}'
    exit 1
  fi
  printf '%s\n' "${S2_ACTIVE_HARNESS_RUN_ID}" >"${S2_LIFECYCLE_READY_FILE}"
fi

if [[ "${S2_LIFECYCLE_BLOCK_AFTER_READY:-0}" == "1" ]]; then
  # Regression-only: keep a fully initialized nested harness alive so the
  # parent proves its deadline return is typed (124), not a child signal code.
  while :; do sleep 1; done
fi

if [[ "${S2_INTERRUPT_AFTER_READY:-0}" == "1" ]]; then
  emit '{"tool":"bash","package":"apps/wire","suite":"s2-krater-local-do","status":"interrupted","code":"S2_PLANTED_INTERRUPTED_RUN","reproduce":"S2_INTERRUPT_AFTER_READY=1 scripts/e2e-s2-krater.sh"}'
  kill -TERM "$$"
fi

if run_phase "exercise"; then
  S2_COST_PHASE_EXERCISE="pass"
else
  S2_COST_PHASE_EXERCISE="fail"
  S2_CLIENT_EXIT=$?
  stop_worker
  emit_wrangler_failure "LOCAL_D1_SCENARIO_FAILED"
  exit "${S2_CLIENT_EXIT}"
fi

stop_worker

if ! start_worker; then
  emit_wrangler_failure "LOCAL_WORKER_RESTART_UNAVAILABLE"
  exit 1
fi
if run_phase "restart-verify"; then
  S2_COST_PHASE_RESTART_VERIFY="pass"
else
  S2_COST_PHASE_RESTART_VERIFY="fail"
  S2_CLIENT_EXIT=$?
  stop_worker
  emit_wrangler_failure "LOCAL_D1_RESTART_SCENARIO_FAILED"
  exit "${S2_CLIENT_EXIT}"
fi
stop_worker

# ── the upgrade path, on real old databases ──────────────────────────────────
# These run after the primary proof and before the blocked records, because a
# broken upgrade must fail the run rather than be reported alongside a green
# local proof. Each owns its own port and persistence directory.
if run_legacy_upgrade_checked "upgrade-existing" "${S2_LEGACY_EXISTING_FIXTURE}" "upgrade-indexed"; then
  S2_COST_PHASE_UPGRADE_EXISTING="pass"
else
  S2_COST_PHASE_UPGRADE_EXISTING="fail"
  S2_CLIENT_EXIT=$?
  exit "${S2_CLIENT_EXIT}"
fi
if run_legacy_upgrade_checked "upgrade-empty" ""; then
  S2_COST_PHASE_UPGRADE_EMPTY="pass"
else
  S2_COST_PHASE_UPGRADE_EMPTY="fail"
  S2_CLIENT_EXIT=$?
  exit "${S2_CLIENT_EXIT}"
fi

# This is distinct from the raw 0004/0005 schema lane above: it begins at the exact 0001
# fixture and proves the current repository migration journal can advance it in place.
if run_migration_journal_upgrade "upgrade-journal-existing" "${S2_LEGACY_EXISTING_FIXTURE}"; then
  S2_COST_PHASE_UPGRADE_JOURNAL_EXISTING="pass"
else
  S2_COST_PHASE_UPGRADE_JOURNAL_EXISTING="fail"
  S2_CLIENT_EXIT=$?
  exit "${S2_CLIENT_EXIT}"
fi
if run_migration_journal_upgrade "upgrade-journal-empty" ""; then
  S2_COST_PHASE_UPGRADE_JOURNAL_EMPTY="pass"
else
  S2_COST_PHASE_UPGRADE_JOURNAL_EMPTY="fail"
  S2_CLIENT_EXIT=$?
  exit "${S2_CLIENT_EXIT}"
fi
S2_COST_LOCAL_PHASES_COMPLETE=1

emit "{\"tool\":\"wrangler\",\"tool_version\":\"${S2_WRANGLER_VERSION}\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-local-do-alarm\",\"status\":\"pass\",\"bindings\":{\"d1\":\"DB\",\"durable_object\":\"KRATER_OUTBOX\"},\"reproduce\":\"scripts/e2e-s2-krater.sh\"}"
emit "{\"tool\":\"wrangler\",\"tool_version\":\"${S2_WRANGLER_VERSION}\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-deployed-do\",\"status\":\"blocked\",\"exit_code\":78,\"code\":\"DEPLOYED_DO_ENVIRONMENT_ABSENT\",\"blocked_on\":\"a deployed Worker with a configured Durable Object namespace and alarm telemetry\",\"forbidden_substitutes\":\"local-workerd behavior presented as deployed Durable Object proof\",\"reproduce\":\"scripts/e2e-s2-krater.sh\"}"
emit "{\"tool\":\"wrangler\",\"tool_version\":\"${S2_WRANGLER_VERSION}\",\"package\":\"apps/wire\",\"suite\":\"s2-krater-edge-load\",\"status\":\"blocked\",\"exit_code\":78,\"code\":\"EDGE_CACHE_ENVIRONMENT_ABSENT\",\"blocked_on\":\"a staging edge-cache environment with D1 row-read and Worker CPU telemetry\",\"forbidden_substitutes\":\"a local curl loop, an in-process handler benchmark, or local-workerd timing presented as edge-load proof\",\"reproduce\":\"scripts/e2e-s2-krater.sh\"}"
exit 78
