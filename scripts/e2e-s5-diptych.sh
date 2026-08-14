#!/usr/bin/env bash
# S-5 Diptych spike, end to end (bead asimposiumorg-6jo).
#
# Phase 1 (local): render one projection to all three faces through @asimposium/render,
# compare semantic digests, assert the markdown control header, and seed a private workshop
# canary that must be absent from every public face.
#
# Phase 1b: the checked-in golden faces, which are the byte-level drift backstop.
#
# Phase 2 (Worker-served): start real local wrangler/workerd on the unmounted harness
# entrypoint apps/wire/src/render-face/worker.ts and compare the *served* bytes against a
# local render — media type, ETag, If-None-Match 304, and the canary's absence on public
# faces. No binding is touched, so nothing is mocked; the harness is not the W4-W6 public
# surface and answers 404 on product routes, which phase 2 asserts.
#
# Evidence discipline: a failing gate prints the tool's own stdout and stderr, redacted for
# absolute paths and credential shapes. A record that says "a gate failed" without the
# tool's output is not evidence (this script used to do exactly that).
#
# Usage:
#   bash scripts/e2e-s5-diptych.sh
#   S5_PORT=8799 bash scripts/e2e-s5-diptych.sh
#
# Exit codes: 0 every phase ran and passed · 1 an assertion failed · 78 a phase is blocked
# on named future work.

set -uo pipefail

readonly BLOCKED_EXIT=78
readonly REPRO="bash scripts/e2e-s5-diptych.sh"
# Not readonly: when the caller does not pin S5_PORT, phase 2 picks a free port so two runs
# never fight over one listener.
PORT="${S5_PORT:-8793}"
ORIGIN="http://127.0.0.1:${PORT}"
readonly WRANGLER="apps/wire/node_modules/.bin/wrangler"

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
readonly ROOT="$PWD"
readonly RUN_DIR="$(mktemp -d -t asimposium-s5)"
if [[ -z "${RUN_DIR}" || ! -d "${RUN_DIR}" ]]; then
  printf '{"spike":"s5-diptych","assertion":"scratch_dir","status":"fail","detail":"mktemp failed"}\n'
  exit 1
fi

SECONDS=0

# The seed is caller-supplied (`ASIMP_S5_SEED`) and lands in a JSON record. Invoke the one
# renderer-owned boundary rather than duplicating a grammar or credential scanner in shell.
seed_is_safe() {
  ASIMP_S5_SEED_TO_VALIDATE="$1" bun -e '
    import { assertSafeS5Seed } from "./packages/render/scripts/diagnostics.ts";
    try {
      assertSafeS5Seed(process.env.ASIMP_S5_SEED_TO_VALIDATE ?? "");
    } catch {
      process.exit(1);
    }
  ' >/dev/null 2>&1
}

seed_rejection() {
  # Deliberately describes the rule without echoing the value: a rejected seed may be
  # credential-shaped, and the diagnostic that reports a secret is the same leak with extra
  # steps. The value never reaches stdout, stderr, argv or a log.
  printf '{"assertion":"seed_accepted","detail":"%s","duration_ms":0,"repro":"%s","seed":"<rejected>","spike":"s5-diptych","status":"fail"}\n' \
    "$1" "${REPRO}"
}

if [[ -n "${ASIMP_S5_SEED:-}" ]]; then
  if ! seed_is_safe "${ASIMP_S5_SEED}"; then
    seed_rejection "ASIMP_S5_SEED was refused by the S-5 seed boundary"
    exit 64
  fi
fi
readonly SEED="${ASIMP_S5_SEED:-s5-fixed-seed-v1}"
readonly RUN_ID="s5-${SEED}-${$}"
readonly RUN_ID_PATTERN='^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'
if ! [[ "${RUN_ID}" =~ ${RUN_ID_PATTERN} ]]; then
  # This should be unreachable after the seed guard, but keeping it explicit makes the
  # one identifier shared by phase 1, shell records and phase 2 a checked boundary.
  printf '{"assertion":"run_id_accepted","detail":"generated S-5 run identifier was refused","spike":"s5-diptych","status":"fail"}\n'
  exit 64
fi

# This private test seam is deliberately fail-closed. Its three values are all required and
# must equal these exact constants; ordinary S-5 runs leave all three unset. The authority
# and capability never reach stdout, stderr, argv, or a diagnostic record.
readonly S5_TEST_PROVENANCE_AUTHORITY_VALUE="s5-private-provenance-authority-v1"
readonly S5_TEST_PROVENANCE_CAPABILITY_VALUE="s5-private-provenance-capability-v1"
readonly S5_TEST_PROVENANCE_DIFFERENT_DIGEST="sha256:0000000000000000000000000000000000000000000000000000000000000000"
TEST_PROVENANCE_DRIFT_CHECKPOINT=""

configure_provenance_drift_seam() {
  local authority_set=0 capability_set=0 checkpoint_set=0 configured=0
  [[ "${ASIMP_S5_TEST_PROVENANCE_AUTHORITY+x}" == "x" ]] && authority_set=1
  [[ "${ASIMP_S5_TEST_PROVENANCE_CAPABILITY+x}" == "x" ]] && capability_set=1
  [[ "${ASIMP_S5_TEST_PROVENANCE_DRIFT_AT+x}" == "x" ]] && checkpoint_set=1
  configured=$((authority_set + capability_set + checkpoint_set))

  if [[ ${configured} -eq 0 ]]; then
    return 0
  fi
  if [[ ${configured} -ne 3 ]] ||
    [[ "${ASIMP_S5_TEST_PROVENANCE_AUTHORITY:-}" != "${S5_TEST_PROVENANCE_AUTHORITY_VALUE}" ]] ||
    [[ "${ASIMP_S5_TEST_PROVENANCE_CAPABILITY:-}" != "${S5_TEST_PROVENANCE_CAPABILITY_VALUE}" ]]; then
    return 1
  fi

  case "${ASIMP_S5_TEST_PROVENANCE_DRIFT_AT}" in
    before_worker_launch|after_worker_ready_before_checker|after_checker)
      TEST_PROVENANCE_DRIFT_CHECKPOINT="${ASIMP_S5_TEST_PROVENANCE_DRIFT_AT}"
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

# The shell consumes the renderer's single provenance contract rather than reimplementing
# its file traversal or digest. These defaults exist only so an unavailable provenance probe
# can still emit a structured failed record without leaking its tool error.
PROVENANCE_REVISION="unknown"
PROVENANCE_REVISION_STATE="unknown"
PROVENANCE_SOURCE_DIGEST="unavailable"
PROVENANCE_SOURCE_FILES=0

load_provenance() {
  local checkpoint="${1:-initial}" raw fields
  raw="$(bun packages/render/scripts/s5-spike.ts --provenance 2>/dev/null)" || return 1
  fields="$(bun -e '
    const value = JSON.parse(process.argv[1]);
    const valid =
      (value.revision === "unknown" || /^[0-9a-f]{7,40}$/.test(value.revision)) &&
      ["clean", "dirty", "unknown"].includes(value.revision_state) &&
      /^sha256:[0-9a-f]{64}$/.test(value.source_digest) &&
      Number.isSafeInteger(value.source_files) && value.source_files >= 1;
    if (!valid) process.exit(1);
    process.stdout.write([value.revision, value.revision_state, value.source_digest, value.source_files].join(" "));
  ' "${raw}" 2>/dev/null)" || return 1
  read -r PROVENANCE_REVISION PROVENANCE_REVISION_STATE PROVENANCE_SOURCE_DIGEST PROVENANCE_SOURCE_FILES <<<"${fields}"

  # Test-only and fail-only: after exact authority, capability and enum validation, the seam
  # can substitute one fixed valid digest and only when it differs from the real provenance.
  if [[ "${TEST_PROVENANCE_DRIFT_CHECKPOINT}" == "${checkpoint}" ]]; then
    [[ "${PROVENANCE_SOURCE_DIGEST}" != "${S5_TEST_PROVENANCE_DIFFERENT_DIGEST}" ]] || return 1
    PROVENANCE_SOURCE_DIGEST="${S5_TEST_PROVENANCE_DIFFERENT_DIGEST}"
  fi
}

# Every field below is either a literal owned by this file or SEED, which the guard above
# has already restricted to a JSON-safe alphabet. There is no path by which an unvalidated
# string reaches this printf.
phase_record() {
  local assertion="$1" status="$2" detail="$3" duration="$4"
  printf '{"assertion":"%s","detail":"%s","duration_ms":%s,"repro":"%s","revision":"%s","revision_state":"%s","run_id":"%s","seed":"%s","source_digest":"%s","source_files":%s,"spike":"s5-diptych","status":"%s"}\n' \
    "$assertion" "$detail" "$duration" "$REPRO" "$PROVENANCE_REVISION" "$PROVENANCE_REVISION_STATE" "$RUN_ID" "$SEED" "$PROVENANCE_SOURCE_DIGEST" "$PROVENANCE_SOURCE_FILES" "$status"
}

if ! load_provenance "initial"; then
  phase_record "provenance_drift" "fail" "source provenance could not be read before the spike" 0
  phase_record "spike_summary" "fail" "S-5 evidence is incomplete because source provenance is unavailable" 0
  exit 1
fi
if ! configure_provenance_drift_seam; then
  phase_record "provenance_test_seam_configuration" "fail" \
    "provenance test seam configuration was refused" 0
  phase_record "spike_summary" "fail" \
    "S-5 evidence was refused because test seam configuration was invalid" 0
  exit 64
fi
readonly BASELINE_REVISION="${PROVENANCE_REVISION}"
readonly BASELINE_REVISION_STATE="${PROVENANCE_REVISION_STATE}"
readonly BASELINE_SOURCE_DIGEST="${PROVENANCE_SOURCE_DIGEST}"
readonly BASELINE_SOURCE_FILES="${PROVENANCE_SOURCE_FILES}"

# Revision is useful context, but byte provenance is authority: another shared-main commit
# must not fail a run that used the same executable input set and digest.
assert_provenance_stable() {
  local checkpoint="$1"
  if ! load_provenance "${checkpoint}" || [[ "${PROVENANCE_SOURCE_DIGEST}" != "${BASELINE_SOURCE_DIGEST}" ]] ||
    [[ "${PROVENANCE_SOURCE_FILES}" != "${BASELINE_SOURCE_FILES}" ]]; then
    PROVENANCE_REVISION="${BASELINE_REVISION}"
    PROVENANCE_REVISION_STATE="${BASELINE_REVISION_STATE}"
    PROVENANCE_SOURCE_DIGEST="${BASELINE_SOURCE_DIGEST}"
    PROVENANCE_SOURCE_FILES="${BASELINE_SOURCE_FILES}"
    phase_record "provenance_drift" "fail" "source digest or input count changed at ${checkpoint}; refusing mixed evidence" "$((SECONDS * 1000))"
    phase_record "spike_summary" "fail" "S-5 evidence was refused after source provenance drift" "$((SECONDS * 1000))"
    return 1
  fi
  PROVENANCE_REVISION="${BASELINE_REVISION}"
  PROVENANCE_REVISION_STATE="${BASELINE_REVISION_STATE}"
  PROVENANCE_SOURCE_DIGEST="${BASELINE_SOURCE_DIGEST}"
  PROVENANCE_SOURCE_FILES="${BASELINE_SOURCE_FILES}"
}

# Print a captured log so a failure is diagnosable, with absolute paths and credential
# shapes removed. Bounded: a runaway log must not bury the record that explains it.
show_redacted() {
  local label="$1" file="$2" limit="${3:-60}"
  printf '%s\n' "--- ${label} (redacted, first ${limit} lines) ---" >&2
  # `|` as the delimiter throughout: an enrollment fragment pattern starts with `#`, and
  # reusing `#` as the delimiter makes sed fail exactly when a failure needs to be shown.
  sed -e "s|${ROOT}|<repo>|g" -e "s|${HOME}|<home>|g" \
      -e 's|asimp_ag_[A-Za-z0-9_-]\{4,\}|<redacted>|g' \
      -e 's|Bearer [A-Za-z0-9._~+/-]\{8,\}|<redacted>|g' \
      -e 's|#v1\.[A-Za-z0-9._~-]\{8,\}|<redacted>|g' \
      "$file" | head -n "$limit" >&2
  printf '%s\n' "--- end ${label} ---" >&2
}

# ── phase 1: local render ───────────────────────────────────────────────────
if ! bun packages/render/scripts/s5-spike.ts --seed "$SEED" --run-id "$RUN_ID"; then
  phase_record "phase1_local_render" "fail" "the local spike driver reported a failed assertion" 0
  exit 1
fi

# ── phase 1b: golden faces ──────────────────────────────────────────────────
readonly GOLDEN_LOG="${RUN_DIR}/golden.log"
golden_status=0
( cd packages/render && bun test test/contract/golden.test.ts ) >"${GOLDEN_LOG}" 2>&1 || golden_status=$?
if [[ ${golden_status} -ne 0 ]]; then
  # The suite prints the face, the line number and both sides. Suppressing that and saying
  # "run the suite to see the line" wastes the one output that makes the gate actionable.
  show_redacted "golden faces" "${GOLDEN_LOG}"
  phase_record "phase1_golden_faces" "fail" "checked-in golden faces no longer match; the suite output is above" 0
  exit 1
fi
phase_record "phase1_golden_faces" "pass" "checked-in md/json/html goldens match byte for byte" 0

# ── phase 2: Worker-served ──────────────────────────────────────────────────
if [[ ! -x "${WRANGLER}" ]]; then
  phase_record "phase2_worker_served" "blocked" "wrangler is not installed under apps/wire; run bun install" 0
  phase_record "spike_summary" "blocked" "phase 1 passed; phase 2 blocked on the local toolchain" 0
  exit "${BLOCKED_EXIT}"
fi

readonly SERVER_LOG="${RUN_DIR}/wrangler.log"

# The Worker runs in a dedicated job-control group, but a numeric PGID is not ownership: a
# process can exit and its PID can be reused. A sidecar carries this run's unguessable-in-
# practice marker in its argv and stays alive through TERM. We re-read both its current PGID
# and command immediately before every signal, so cleanup never targets a bare or reused
# numeric group. If the direct wrangler leader disappears, the marker still proves the group
# belongs to this run and lets the trap reap its children.
SERVER_PID=""
SERVER_PGID=""
SERVER_MARKER_PID=""
SERVER_GROUP_VERIFIED=0
readonly CONTROLLER_PID="$$"
readonly SERVER_PROCESS_MARKER="s5-diptych-owner-${RUN_ID}"
readonly SERVER_OWNER_FILE="${RUN_DIR}/server-owner"
readonly SERVER_OWNER_ACK="${RUN_DIR}/server-owner-ack"

positive_pid() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

marker_matches_owned_group() {
  local current_pgid command
  positive_pid "${SERVER_MARKER_PID}" && positive_pid "${SERVER_PGID}" || return 1
  current_pgid="$(ps -o pgid= -p "${SERVER_MARKER_PID}" 2>/dev/null | tr -d '[:space:]')" || return 1
  [[ "${current_pgid}" == "${SERVER_PGID}" ]] || return 1
  command="$(ps -o command= -p "${SERVER_MARKER_PID}" 2>/dev/null)" || return 1
  [[ "${command}" == *"--s5-owned-marker=${SERVER_PROCESS_MARKER}"* ]]
}

owned_group_members() {
  positive_pid "${SERVER_PGID}" || return 1
  ps -axo pid=,pgid= 2>/dev/null | awk -v group="${SERVER_PGID}" '$2 == group { print $1 }'
}

owned_group_has_non_marker_member() {
  local member
  while IFS= read -r member; do
    [[ -n "${member}" && "${member}" != "${SERVER_MARKER_PID}" ]] && return 0
  done < <(owned_group_members)
  return 1
}

wait_for_owned_group_empty() {
  for _wait in {1..20}; do
    [[ -z "$(owned_group_members)" ]] && return 0
    sleep 0.1
  done
  return 1
}

stop_server() {
  [[ ${SERVER_GROUP_VERIFIED} -eq 1 ]] || return 0
  # The marker is the authorization to signal this group. Do not fall back to SERVER_PID or
  # SERVER_PGID alone: the former may already be gone, and either number may have been reused.
  marker_matches_owned_group || return 1
  kill -TERM -- "-${SERVER_PGID}" 2>/dev/null || return 1
  for _wait in {1..20}; do
    if ! owned_group_has_non_marker_member; then
      break
    fi
    sleep 0.1
  done

  # The marker ignores TERM so it remains a fresh ownership proof for the escalation. If a
  # workerd child remains, signal the *verified* group; otherwise kill only the verified
  # marker. There is never a signal based solely on an old numeric PID/PGID.
  marker_matches_owned_group || return 1
  if owned_group_has_non_marker_member; then
    kill -KILL -- "-${SERVER_PGID}" 2>/dev/null || return 1
  else
    kill -KILL "${SERVER_MARKER_PID}" 2>/dev/null || return 1
  fi
  wait_for_owned_group_empty || return 1
  wait "${SERVER_PID}" 2>/dev/null || true
  SERVER_PID=""
  SERVER_PGID=""
  SERVER_MARKER_PID=""
  SERVER_GROUP_VERIFIED=0
}

# True when something already answers on the port. Uses bash's own /dev/tcp so the check
# needs no extra tool and cannot be confused by an HTTP status.
port_is_busy() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && exec 3<&- && return 0
  return 1
}

# A fixed port makes two concurrent runs collide, and — worse — lets a server left over from
# an interrupted run satisfy this run's readiness probe, so fresh local renders get compared
# against stale served bytes and the spike reports green. Refusing a busy port closes both:
# either this run owns the listener or it does not start.
if [[ -n "${S5_PORT:-}" ]]; then
  if port_is_busy "${PORT}"; then
    phase_record "phase2_worker_served" "fail" \
      "S5_PORT is already in use; refusing to test against a server this run did not start" 0
    exit 1
  fi
else
  chosen=""
  for offset in {0..39}; do
    candidate=$((8793 + (($$ + offset) % 200)))
    if ! port_is_busy "${candidate}"; then
      chosen="${candidate}"
      break
    fi
  done
  if [[ -z "${chosen}" ]]; then
    phase_record "phase2_worker_served" "fail" "no free local port in 8793-8992 for the harness" 0
    exit 1
  fi
  PORT="${chosen}"
  ORIGIN="http://127.0.0.1:${PORT}"
fi

# `--inspector-port 0` lets the kernel pick the devtools port. Choosing a free *main* port is
# not enough: wrangler also binds an inspector, whose default (9231) is fixed, so two runs
# with different main ports still collided there — one died with
# "Address already in use 127.0.0.1:9231" while the other passed, which is the worst shape of
# flake because the survivor reports green. 0 is race-free where probe-then-bind is not.
# The first safe checkpoint is immediately before this run launches workerd. If the renderer,
# checker, diagnostics policy, or harness script changed while phase 1 was running, the
# resulting evidence would mix two source sets and must not be called green.
if ! assert_provenance_stable "before_worker_launch"; then
  exit 1
fi

# Job control makes the next background job its own process-group leader. The launcher first
# publishes a marker sidecar and waits for this parent to validate it; only then can it exec
# wrangler. That removes any unowned-server window and also gives cleanup a live proof when
# the direct wrangler leader has died.
set -m
(
  bash -c '
    marker_argument="$1"
    marker="${marker_argument#--s5-owned-marker=}"
    owner_file="$2"
    owner_ack="$3"
    controller_pid="$4"
    shift 4
    [[ "${marker_argument}" == "--s5-owned-marker=${marker}" && -n "${marker}" && "${controller_pid}" =~ ^[1-9][0-9]*$ ]] || exit 1
    marker_loop() {
      # This marker is TERM-immune and remains inside the exact Worker group. It watches the
      # *live* group leader (`$$`) rather than a historical controller PID: while the script
      # owns the leader, its PPID is `controller_pid`; SIGKILL re-parents the leader to init.
      # On that relationship change, this marker can safely reap only its freshly verified
      # PID/PGID/argv group. That closes the trapless-controller orphan demonstrated in S-5.
      trap "" TERM INT HUP
      marker_matches_own_group() {
        current_pgid="$(ps -o pgid= -p "${BASHPID}" 2>/dev/null | tr -d "[:space:]")" || return 1
        [[ "${current_pgid}" == "$$" ]] || return 1
        command="$(ps -o command= -p "${BASHPID}" 2>/dev/null)" || return 1
        [[ "${command}" == *"--s5-owned-marker=${marker}"* ]]
      }
      group_members() {
        while read -r pid pgid; do
          [[ "${pgid}" == "$$" ]] && printf "%s\\n" "${pid}"
        done < <(ps -axo pid=,pgid= 2>/dev/null)
      }
      group_has_non_marker_member() {
        while IFS= read -r member; do
          [[ -n "${member}" && "${member}" != "${BASHPID}" ]] && return 0
        done < <(group_members)
        return 1
      }
      wait_for_group_empty() {
        for _wait in {1..20}; do
          [[ -z "$(group_members)" ]] && return 0
          sleep 0.1
        done
        return 1
      }
      while :; do
        leader_parent="$(ps -o ppid= -p "$$" 2>/dev/null | tr -d "[:space:]")" || leader_parent=""
        if [[ -n "${leader_parent}" && "${leader_parent}" != "${controller_pid}" ]]; then
          marker_matches_own_group || exit 1
          kill -TERM -- "-$$" 2>/dev/null || exit 1
          for _wait in {1..20}; do
            group_has_non_marker_member || break
            sleep 0.1
          done
          marker_matches_own_group || exit 1
          if group_has_non_marker_member; then
            kill -KILL -- "-$$" 2>/dev/null || exit 1
          else
            kill -KILL "${BASHPID}" 2>/dev/null || exit 1
          fi
          wait_for_group_empty
          exit $?
        fi
        sleep 0.1 &
        wait "$!"
      done
    }
    marker_loop &
    marker_pid=$!
    marker_pgid="$(ps -o pgid= -p "${marker_pid}" 2>/dev/null | tr -d "[:space:]")"
    if ! [[ "${marker_pgid}" =~ ^[1-9][0-9]*$ ]]; then
      kill -KILL "${marker_pid}" 2>/dev/null || true
      exit 1
    fi
    umask 077
    printf "%s %s %s\\n" "${marker_pid}" "${marker_pgid}" "${marker}" >"${owner_file}"
    for _attempt in {1..40}; do
      [[ -f "${owner_ack}" ]] && exec "$@"
      sleep 0.05
    done
    kill -KILL "${marker_pid}" 2>/dev/null || true
    wait "${marker_pid}" 2>/dev/null || true
    exit 1
  ' "s5-server-launcher" "--s5-owned-marker=${SERVER_PROCESS_MARKER}" "${SERVER_OWNER_FILE}" "${SERVER_OWNER_ACK}" "${CONTROLLER_PID}" \
    "${WRANGLER}" dev apps/wire/src/render-face/worker.ts \
    --config infra/wrangler.toml \
    --local \
    --persist-to "${RUN_DIR}" \
    --port "${PORT}" \
    --inspector-port 0 \
    --var "S5_SEED:${SEED}" \
    --log-level error \
    --show-interactive-dev-session=false
) >"${SERVER_LOG}" 2>&1 &
SERVER_PID=$!
# Installed immediately: from here to the end of the run, every exit path — normal, `set -e`,
# Ctrl-C, a CI timeout's SIGTERM, a closed terminal — stops the server.
#
# A signal handler must *exit*, not merely clean up: a bare `trap stop_server TERM` runs the
# handler and then resumes the script, so a killed run would tear its own server down and
# carry on into phase 2 against nothing. Exit codes follow the 128+signal convention, and
# the EXIT trap re-runs stop_server harmlessly because it is idempotent.
trap stop_server EXIT
trap 'stop_server; exit 130' INT
trap 'stop_server; exit 143' TERM
trap 'stop_server; exit 129' HUP
set +m

for _attempt in {1..40}; do
  if [[ -s "${SERVER_OWNER_FILE}" ]]; then
    read -r SERVER_MARKER_PID SERVER_PGID _marker_from_file <"${SERVER_OWNER_FILE}" || true
    if [[ "${_marker_from_file:-}" == "${SERVER_PROCESS_MARKER}" ]] && marker_matches_owned_group; then
      : >"${SERVER_OWNER_ACK}"
      SERVER_GROUP_VERIFIED=1
      break
    fi
  fi
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    break
  fi
  sleep 0.05
done

if [[ ${SERVER_GROUP_VERIFIED} -ne 1 ]]; then
  show_redacted "wrangler" "${SERVER_LOG}"
  phase_record "phase2_worker_served" "fail" "the local Worker ownership marker could not be verified" "$((SECONDS * 1000))"
  exit 1
fi
ready=0
for _attempt in {1..40}; do
  # A dead child can never become ready, and continuing to poll would only succeed against
  # somebody else's server. Fail fast instead of waiting out the loop.
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    break
  fi
  if curl --silent --output /dev/null --max-time 2 "${ORIGIN}/__s5/face?format=md"; then
    ready=1
    break
  fi
  sleep 0.25
done

if [[ ${ready} -ne 1 ]]; then
  show_redacted "wrangler" "${SERVER_LOG}"
  phase_record "phase2_worker_served" "fail" "the local Worker did not answer; its log is above" "$((SECONDS * 1000))"
  exit 1
fi

if ! assert_provenance_stable "after_worker_ready_before_checker"; then
  exit 1
fi

readonly CHECK_LOG="${RUN_DIR}/check.log"
S5_ORIGIN="${ORIGIN}" S5_SEED="${SEED}" S5_RUN_ID="${RUN_ID}" bun apps/wire/src/render-face/check.ts 2>"${CHECK_LOG}"
readonly CHECK_EXIT=$?
if [[ -s "${CHECK_LOG}" ]]; then
  show_redacted "phase 2 stderr" "${CHECK_LOG}" 40
fi
if ! stop_server; then
  phase_record "phase2_worker_served" "fail" "owned local Worker cleanup could not be verified" "$((SECONDS * 1000))"
  exit 1
fi

if ! assert_provenance_stable "after_checker"; then
  exit 1
fi

if [[ ${CHECK_EXIT} -ne 0 ]]; then
  show_redacted "wrangler" "${SERVER_LOG}" 40
  phase_record "phase2_worker_served" "fail" "served faces disagreed with the local render; records and logs are above" "$((SECONDS * 1000))"
  exit 1
fi

phase_record "phase2_worker_served" "pass" "served bytes, media types, ETags, 304s and canary absence all match the local render" "$((SECONDS * 1000))"
phase_record "spike_summary" "pass" "local render, goldens and the workerd-served faces agree" "$((SECONDS * 1000))"
