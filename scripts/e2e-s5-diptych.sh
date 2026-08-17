#!/usr/bin/env bash
# S-5 Diptych spike, end to end (bead asimposiumorg-6jo).
#
# Phase 1 (local): render one projection to all three faces through @asimposium/render,
# compare semantic digests, assert the markdown control header, and seed a private workshop
# canary that must be absent from every public face.
#
# Phase 1b: the checked-in golden faces, which are the byte-level drift backstop.
#
# Phase 1c: pack determinism, the second half of this spike's exit criterion (Fable §17.1
# S-5, operationalized in §16.2). Goldens cannot reach it: they pin one rendering, while the
# claim has three parts — two independently composed profile="orient" packs at the same cursor
# byte-compare through the real composePack seam (the literal §16.2 sentence, held falsifiable
# by a changed-cursor control), a larger budget *extends* a pack rather than reshuffling it,
# and a fresh process reproduces the same bytes. The proof exists as an ordinary integration
# test; running it here is what lets this spike's own receipt establish the criterion instead
# of leaving it to a separate suite, and the proof file is a provenance input so weakening it
# moves this receipt's source digest.
#
# Phase 2 (Worker-served): start real local wrangler/workerd on the unmounted harness
# entrypoint apps/wire/src/render-face/worker.ts and compare the *served* bytes against a
# local render — media type, ETag, If-None-Match 304, and the canary's absence on public
# faces. No binding is touched, so nothing is mocked; the harness is not the W4-W6 public
# surface and answers 404 on product routes, which phase 2 asserts.
#
# Evidence discipline: captured tool output is never replayed. A local Worker or checker can
# return arbitrary bytes, so even a redactor is not a safe authority for a build log; fixed
# records preserve the result and reproduction command without creating a second secret sink.
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
readonly GROUP_EMPTY_RETRY_LIMIT=50
# Not readonly: when the caller does not pin S5_PORT, phase 2 picks a free port so two runs
# never fight over one listener.
PORT="${S5_PORT:-8793}"
ORIGIN="http://127.0.0.1:${PORT}"
readonly WRANGLER="apps/wire/node_modules/.bin/wrangler"

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
# Callers may set TMPDIR to an external volume (this swarm does). When it is unset, resolve the
# host's conventional temporary directory physically: /tmp is a symlink on macOS but a real
# directory on most Linux CI hosts. An explicit caller value is never canonicalized because a
# symlink supplied at that trust boundary must be refused, not silently followed.
if [[ "${TMPDIR+x}" == "x" ]]; then
  SCRATCH_ROOT="${TMPDIR}"
else
  if ! SCRATCH_ROOT="$(cd -P -- /tmp 2>/dev/null && pwd -P)"; then
    SCRATCH_ROOT=""
  fi
fi
# BSD `mktemp -t` chooses the system temporary directory even when TMPDIR points at the USB
# scratch volume. Validate the supplied root without following a root symlink, then provide
# an explicit template beneath it. The refusal never repeats a caller-controlled path.
if [[ -z "${SCRATCH_ROOT}" ||
  "${SCRATCH_ROOT}" != /* ||
  -L "${SCRATCH_ROOT}" ||
  ! -d "${SCRATCH_ROOT}" ]]; then
  printf '{"assertion":"scratch_dir","bun_version":"unavailable","detail":"scratch root was refused","duration_ms":0,"repro":"bash scripts/e2e-s5-diptych.sh","revision":"unknown","revision_state":"unknown","run_id":"s5-shell-refusal-v1","seed":"<refused>","source_digest":"unavailable","source_files":0,"spike":"s5-diptych","status":"fail","wrangler_version":"unavailable"}\n'
  exit 1
fi
if [[ "${SCRATCH_ROOT}" == "/" ]]; then
  SCRATCH_TEMPLATE="/asimposium-s5.XXXXXXXX"
else
  SCRATCH_TEMPLATE="${SCRATCH_ROOT%/}/asimposium-s5.XXXXXXXX"
fi
RUN_DIR="$(mktemp -d "${SCRATCH_TEMPLATE}" 2>/dev/null)"
if [[ -z "${RUN_DIR}" || -L "${RUN_DIR}" || ! -d "${RUN_DIR}" ]]; then
  printf '{"assertion":"scratch_dir","bun_version":"unavailable","detail":"scratch directory could not be created","duration_ms":0,"repro":"bash scripts/e2e-s5-diptych.sh","revision":"unknown","revision_state":"unknown","run_id":"s5-shell-refusal-v1","seed":"<refused>","source_digest":"unavailable","source_files":0,"spike":"s5-diptych","status":"fail","wrangler_version":"unavailable"}\n'
  exit 1
fi
readonly RUN_DIR

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
  printf '{"assertion":"seed_accepted","bun_version":"unavailable","detail":"%s","duration_ms":0,"repro":"%s","revision":"unknown","revision_state":"unknown","run_id":"s5-shell-refusal-v1","seed":"<rejected>","source_digest":"unavailable","source_files":0,"spike":"s5-diptych","status":"fail","wrangler_version":"unavailable"}\n' \
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
  printf '{"assertion":"run_id_accepted","bun_version":"unavailable","detail":"generated S-5 run identifier was refused","duration_ms":0,"repro":"bash scripts/e2e-s5-diptych.sh","revision":"unknown","revision_state":"unknown","run_id":"s5-shell-refusal-v1","seed":"<refused>","source_digest":"unavailable","source_files":0,"spike":"s5-diptych","status":"fail","wrangler_version":"unavailable"}\n'
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
PROVENANCE_BUN_VERSION="unavailable"
PROVENANCE_WRANGLER_VERSION="unavailable"

load_provenance() {
  local checkpoint="${1:-initial}" raw fields
  raw="$(bun packages/render/scripts/s5-spike.ts --provenance 2>/dev/null)" || return 1
  fields="$(bun -e '
    const value = JSON.parse(process.argv[1]);
    const valid =
      (value.revision === "unknown" || /^[0-9a-f]{7,40}$/.test(value.revision)) &&
      ["clean", "dirty", "unknown"].includes(value.revision_state) &&
      /^sha256:[0-9a-f]{64}$/.test(value.source_digest) &&
      Number.isSafeInteger(value.source_files) && value.source_files >= 1 &&
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.bun_version) &&
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.wrangler_version);
    if (!valid) process.exit(1);
    process.stdout.write([value.revision, value.revision_state, value.source_digest, value.source_files, value.bun_version, value.wrangler_version].join(" "));
  ' "${raw}" 2>/dev/null)" || return 1
  read -r PROVENANCE_REVISION PROVENANCE_REVISION_STATE PROVENANCE_SOURCE_DIGEST PROVENANCE_SOURCE_FILES PROVENANCE_BUN_VERSION PROVENANCE_WRANGLER_VERSION <<<"${fields}"

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
  printf '{"assertion":"%s","bun_version":"%s","detail":"%s","duration_ms":%s,"repro":"%s","revision":"%s","revision_state":"%s","run_id":"%s","seed":"%s","source_digest":"%s","source_files":%s,"spike":"s5-diptych","status":"%s","wrangler_version":"%s"}\n' \
    "$assertion" "$PROVENANCE_BUN_VERSION" "$detail" "$duration" "$REPRO" "$PROVENANCE_REVISION" "$PROVENANCE_REVISION_STATE" "$RUN_ID" "$SEED" "$PROVENANCE_SOURCE_DIGEST" "$PROVENANCE_SOURCE_FILES" "$status" "$PROVENANCE_WRANGLER_VERSION"
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
readonly BASELINE_BUN_VERSION="${PROVENANCE_BUN_VERSION}"
readonly BASELINE_WRANGLER_VERSION="${PROVENANCE_WRANGLER_VERSION}"

# Revision is useful context, but byte provenance is authority: another shared-main commit
# must not fail a run that used the same executable input set and digest.
assert_provenance_stable() {
  local checkpoint="$1"
  if ! load_provenance "${checkpoint}" || [[ "${PROVENANCE_SOURCE_DIGEST}" != "${BASELINE_SOURCE_DIGEST}" ]] ||
    [[ "${PROVENANCE_SOURCE_FILES}" != "${BASELINE_SOURCE_FILES}" ]] ||
    [[ "${PROVENANCE_BUN_VERSION}" != "${BASELINE_BUN_VERSION}" ]] ||
    [[ "${PROVENANCE_WRANGLER_VERSION}" != "${BASELINE_WRANGLER_VERSION}" ]]; then
    PROVENANCE_REVISION="${BASELINE_REVISION}"
    PROVENANCE_REVISION_STATE="${BASELINE_REVISION_STATE}"
    PROVENANCE_SOURCE_DIGEST="${BASELINE_SOURCE_DIGEST}"
    PROVENANCE_SOURCE_FILES="${BASELINE_SOURCE_FILES}"
    PROVENANCE_BUN_VERSION="${BASELINE_BUN_VERSION}"
    PROVENANCE_WRANGLER_VERSION="${BASELINE_WRANGLER_VERSION}"
    phase_record "provenance_drift" "fail" "source digest or input count changed at ${checkpoint}; refusing mixed evidence" "$((SECONDS * 1000))"
    phase_record "spike_summary" "fail" "S-5 evidence was refused after source provenance drift" "$((SECONDS * 1000))"
    return 1
  fi
  PROVENANCE_REVISION="${BASELINE_REVISION}"
  PROVENANCE_REVISION_STATE="${BASELINE_REVISION_STATE}"
  PROVENANCE_SOURCE_DIGEST="${BASELINE_SOURCE_DIGEST}"
  PROVENANCE_SOURCE_FILES="${BASELINE_SOURCE_FILES}"
  PROVENANCE_BUN_VERSION="${BASELINE_BUN_VERSION}"
  PROVENANCE_WRANGLER_VERSION="${BASELINE_WRANGLER_VERSION}"
}

runtime_bun_matches_provenance() {
  local observed
  observed="$(bun --version 2>/dev/null)" || return 1
  [[ "${observed}" == "${PROVENANCE_BUN_VERSION}" ]]
}

runtime_wrangler_matches_provenance() {
  local observed
  observed="$("${WRANGLER}" --version 2>/dev/null)" || return 1
  [[ "${observed}" == "${PROVENANCE_WRANGLER_VERSION}" ]]
}

# Captured logs are untrusted (the Worker may emit request-controlled diagnostics). Their
# contents never cross the S-5 process boundary; the fixed notice is enough to explain why
# the structured phase record failed and keeps every failure stream safe to archive.
show_fixed_log_notice() {
  printf '%s\n' "S-5 captured local tool diagnostics; contents withheld by fixed-log policy." >&2
}

# ── phase 1: local render ───────────────────────────────────────────────────
if ! runtime_bun_matches_provenance; then
  phase_record "phase1_local_render" "fail" "the Bun runtime does not match the exact provenance pin" 0
  phase_record "spike_summary" "fail" "S-5 evidence is incomplete because the Bun runtime is not pinned" 0
  exit 1
fi
if ! bun packages/render/scripts/s5-spike.ts --seed "$SEED" --run-id "$RUN_ID"; then
  phase_record "phase1_local_render" "fail" "the local spike driver reported a failed assertion" 0
  exit 1
fi

# ── phase 1b: golden faces ──────────────────────────────────────────────────
readonly GOLDEN_LOG="${RUN_DIR}/golden.log"
golden_status=0
( cd packages/render && bun test /dev/null --timeout=120000 test/contract/golden.test.ts ) >"${GOLDEN_LOG}" 2>&1 || golden_status=$?
if [[ ${golden_status} -ne 0 ]]; then
  # The suite prints the face, the line number and both sides. Suppressing that and saying
  # "run the suite to see the line" wastes the one output that makes the gate actionable.
  show_fixed_log_notice
  phase_record "phase1_golden_faces" "fail" "checked-in golden faces no longer match; captured diagnostics were withheld" 0
  exit 1
fi
phase_record "phase1_golden_faces" "pass" "checked-in md/json/html goldens match byte for byte" 0

# ── phase 1c: pack determinism ──────────────────────────────────────────────
# The existing proof, run under this spike so the receipt below is not asserting a criterion
# that only some other suite happened to check. No new assertions are introduced here.
readonly DETERMINISM_LOG="${RUN_DIR}/determinism.log"
determinism_status=0
( cd packages/render && bun test /dev/null --timeout=120000 test/integration/determinism.test.ts ) >"${DETERMINISM_LOG}" 2>&1 || determinism_status=$?
if [[ ${determinism_status} -ne 0 ]]; then
  show_fixed_log_notice
  phase_record "phase1_pack_determinism" "fail" "pack determinism no longer holds for two orient packs at one cursor, across budget buckets, or across a process restart; captured diagnostics were withheld" 0
  exit 1
fi
phase_record "phase1_pack_determinism" "pass" "two independently composed profile=orient packs at the same cursor are byte-identical through the real composePack seam and a changed-cursor control differs (Fable 16.2); a larger budget extends the pack prefix instead of reshuffling it; and a fresh process reproduces the same bytes" 0

# ── phase 2: Worker-served ──────────────────────────────────────────────────
if [[ ! -x "${WRANGLER}" ]]; then
  phase_record "phase2_worker_served" "blocked" "wrangler is not installed under apps/wire; run bun install" 0
  phase_record "spike_summary" "blocked" "phase 1 passed; phase 2 blocked on the local toolchain" 0
  exit "${BLOCKED_EXIT}"
fi
if ! runtime_wrangler_matches_provenance; then
  phase_record "phase2_worker_served" "fail" "the Wrangler runtime does not match the exact provenance pin" 0
  phase_record "spike_summary" "fail" "S-5 evidence is incomplete because the Wrangler runtime is not pinned" 0
  exit 1
fi

valid_s5_port() {
  [[ "${PORT}" =~ ^[1-9][0-9]{0,4}$ ]] || return 1
  ((10#${PORT} <= 65535))
}

# Keep the lexical check and the numeric comparison coupled: a nonnumeric caller value must
# never reach an arithmetic context (where bash may interpret it as an identifier).
if ( [[ -n "${S5_PORT:-}" ]] && ! valid_s5_port ); then
  phase_record "phase2_worker_served" "fail" "S5_PORT was refused by the closed local-origin boundary" 0
  phase_record "spike_summary" "fail" "S-5 evidence is incomplete because the local origin is invalid" 0
  exit 64
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
CLEANUP_FAILURE="none"
readonly CONTROLLER_PID="$$"
readonly SERVER_PROCESS_MARKER="s5-diptych-owner-${RUN_ID}"
readonly SERVER_OWNER_FILE="${RUN_DIR}/server-owner"
readonly SERVER_OWNER_ACK="${RUN_DIR}/server-owner-ack"

positive_pid() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

marker_matches_owned_group() {
  local current_pgid controller_pgid command
  positive_pid "${SERVER_MARKER_PID}" && positive_pid "${SERVER_PGID}" || return 1
  current_pgid="$(ps -o pgid= -p "${SERVER_MARKER_PID}" 2>/dev/null | tr -d '[:space:]')" || return 1
  [[ "${current_pgid}" == "${SERVER_PGID}" ]] || return 1
  controller_pgid="$(ps -o pgid= -p "${CONTROLLER_PID}" 2>/dev/null | tr -d '[:space:]')" || return 1
  # A cleanup group must be distinct from the controller's group. Without this proof, a
  # fallback group signal could reach the invoking test runner or CI shell.
  [[ "${SERVER_PGID}" != "${controller_pgid}" ]] || return 1
  command="$(ps -o command= -p "${SERVER_MARKER_PID}" 2>/dev/null)" || return 1
  [[ "${command}" == *"--s5-owned-marker=${SERVER_PROCESS_MARKER}"* ]]
}

owned_group_members() {
  local snapshot
  positive_pid "${SERVER_PGID}" || return 2
  snapshot="$(ps -axo pid=,pgid=,stat= 2>/dev/null)" || return 2
  [[ -n "${snapshot}" ]] || return 2
  # A zombie retains a numeric PGID until its parent reaps it, but cannot listen, execute or
  # survive a signal. Its explicit `Z` state is proven runtime absence, unlike a failed or
  # malformed observation of *this group* which returns 2. Unrelated process-table rows are
  # outside the observed scope and cannot make an exact group appear present or absent.
  awk -v group="${SERVER_PGID}" '
    $2 != group { next }
    NF != 3 || $1 !~ /^[1-9][0-9]*$/ || $3 !~ /^[A-Za-z+<]+$/ { invalid = 1; next }
    $3 !~ /^Z/ { print $1 }
    END { exit invalid }
  ' <<<"${snapshot}" || return 2
}

owned_group_has_non_marker_member() {
  local members member
  members="$(owned_group_members)" || return 2
  while IFS= read -r member; do
    [[ -n "${member}" && "${member}" != "${SERVER_MARKER_PID}" ]] && return 0
  done <<<"${members}"
  return 1
}

wait_for_owned_group_empty() {
  local members observation_failures=0
  for ((_wait = 1; _wait <= GROUP_EMPTY_RETRY_LIMIT; _wait += 1)); do
    if ! members="$(owned_group_members)"; then
      observation_failures=$((observation_failures + 1))
      [[ ${observation_failures} -lt 20 ]] || return 2
      sleep 0.1
      continue
    fi
    observation_failures=0
    [[ -z "${members}" ]] && return 0
    sleep 0.1
  done
  return 1
}

finalize_server_cleanup() {
  # Reap the direct job leader before asking `ps` for a proven-empty group: a dead but
  # unreaped leader is still visible as a zombie with the old PGID, which is neither a live
  # Worker nor evidence that cleanup failed.
  wait "${SERVER_PID}" 2>/dev/null || true
  wait_for_owned_group_empty || return 1
  SERVER_PID=""
  SERVER_PGID=""
  SERVER_MARKER_PID=""
  SERVER_GROUP_VERIFIED=0
}

stop_server() {
  [[ ${SERVER_GROUP_VERIFIED} -eq 1 ]] || return 0
  # The marker is the authorization to signal this group. Do not fall back to SERVER_PID or
  # SERVER_PGID alone: the former may already be gone, and either number may have been reused.
  if ! marker_matches_owned_group; then
    # The sidecar may independently notice the dead leader after our TERM and expire the
    # group first. Missing evidence is acceptable only when a complete, valid observation
    # proves no *live* group member remains; an uncertain or nonempty observation still fails.
    local remaining
    remaining="$(owned_group_members)" || { CLEANUP_FAILURE="sidecar_loss_observation_uncertain"; return 1; }
    [[ -z "${remaining}" ]] || { CLEANUP_FAILURE="group_still_live"; return 1; }
    finalize_server_cleanup || { CLEANUP_FAILURE="empty_group_not_proven"; return 1; }
    return $?
  fi
  kill -TERM -- "-${SERVER_PGID}" 2>/dev/null || { CLEANUP_FAILURE="term_signal_refused"; return 1; }
  local observation_failures=0
  for _wait in {1..20}; do
    owned_group_has_non_marker_member
    case $? in
      0) observation_failures=0; sleep 0.1 ;;
      1) break ;;
      *)
        observation_failures=$((observation_failures + 1))
        if [[ ${observation_failures} -ge 20 ]]; then
          CLEANUP_FAILURE="term_observation_uncertain"
          return 1
        fi
        sleep 0.1
        ;;
    esac
  done

  # The marker ignores TERM so it remains a fresh ownership proof for the escalation. If a
  # workerd child remains, signal the *verified* group; otherwise kill only the verified
  # marker. There is never a signal based solely on an old numeric PID/PGID.
  if ! marker_matches_owned_group; then
    # TERM can race with the sidecar's own parent-loss reaper. Once the marker is gone we do
    # not issue a numeric-group escalation; we only wait for a bounded, valid observation that
    # proves all live members have disappeared.
    finalize_server_cleanup || { CLEANUP_FAILURE="sidecar_reap_not_proven"; return 1; }
    return 0
  fi
  owned_group_has_non_marker_member
  case $? in
    0) kill -KILL -- "-${SERVER_PGID}" 2>/dev/null || { CLEANUP_FAILURE="kill_signal_refused"; return 1; } ;;
    1) kill -KILL "${SERVER_MARKER_PID}" 2>/dev/null || { CLEANUP_FAILURE="marker_kill_refused"; return 1; } ;;
    *) CLEANUP_FAILURE="escalation_observation_uncertain"; return 1 ;;
  esac
  finalize_server_cleanup || { CLEANUP_FAILURE="empty_group_not_proven"; return 1; }
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
      # A proven missing leader is ownership loss; an unreadable process table is uncertainty,
      # not absence. Uncertainty retries a bounded number of times and then self-expires only
      # after proving this marker still belongs to the exact group it will signal.
      trap "" TERM INT HUP
      local marker_group controller_group
      marker_group="$(ps -o pgid= -p "${BASHPID}" 2>/dev/null | tr -d "[:space:]")" || exit 1
      [[ "${marker_group}" =~ ^[1-9][0-9]*$ ]] || exit 1
      controller_group="$(ps -o pgid= -p "${controller_pid}" 2>/dev/null | tr -d "[:space:]")" || exit 1
      [[ "${controller_group}" =~ ^[1-9][0-9]*$ && "${marker_group}" != "${controller_group}" ]] || exit 1
      marker_matches_own_group() {
        current_pgid="$(ps -o pgid= -p "${BASHPID}" 2>/dev/null | tr -d "[:space:]")" || return 1
        [[ "${current_pgid}" == "${marker_group}" ]] || return 1
        command="$(ps -o command= -p "${BASHPID}" 2>/dev/null)" || return 1
        [[ "${command}" == *"--s5-owned-marker=${marker}"* ]]
      }
      group_members() {
        local snapshot
        snapshot="$(ps -axo pid=,pgid=,stat= 2>/dev/null)" || return 2
        [[ -n "${snapshot}" ]] || return 2
        awk -v group="${marker_group}" "
          \$2 != group { next }
          NF != 3 || \$1 !~ /^[1-9][0-9]*\$/ || \$3 !~ /^[A-Za-z+<]+\$/ { invalid = 1; next }
          \$3 !~ /^Z/ { print \$1 }
          END { exit invalid }
        " <<<"${snapshot}" || return 2
      }
      group_has_non_marker_member() {
        local members member
        members="$(group_members)" || return 2
        while IFS= read -r member; do
          [[ -n "${member}" && "${member}" != "${BASHPID}" ]] && return 0
        done <<<"${members}"
        return 1
      }
      observe_leader_parent() {
        local parent
        parent="$(ps -o ppid= -p "$$" 2>/dev/null)" || return 2
        parent="${parent//[[:space:]]/}"
        [[ -n "${parent}" ]] || return 1
        [[ "${parent}" =~ ^[1-9][0-9]*$ ]] || return 2
        printf "%s\\n" "${parent}"
      }
      expire_unobservable_own_group() {
        # This path is reached only after twenty failed observations. The marker is a child of
        # the freshly-created job-control group recorded in `marker_group`, and this marker code never calls
        # setpgid/setsid or execs another program. That construction invariant is the remaining
        # ownership proof when `ps` is permanently unavailable; it expires its own group and
        # cannot select a decoy in another process group by PID or command text.
        # The controller arms this fallback only after it has independently verified the
        # marker PID/argv/PGID and the group is distinct from its own process group.
        # Before that acknowledgement, killing only this marker blocks the launcher from
        # execing workerd and cannot spill into the caller process group.
        if [[ ! -f "${owner_ack}" ]]; then
          kill -KILL "${BASHPID}" 2>/dev/null || return 1
          return 1
        fi
        kill -TERM -- "-${marker_group}" 2>/dev/null || return 1
        sleep 0.1
        kill -KILL -- "-${marker_group}" 2>/dev/null || return 1
        return 1
      }
      reap_exact_owned_group() {
        marker_matches_own_group || return 1
        kill -TERM -- "-${marker_group}" 2>/dev/null || return 1
        for _wait in {1..20}; do
          group_has_non_marker_member
          case $? in
            0) sleep 0.1 ;;
            1) break ;;
            *)
              # We did not prove the group empty. The still-verified marker does prove this
              # exact PGID is ours, so expire it rather than pretending an observation failure
              # is absence or leaving a TERM-immune sidecar behind.
              marker_matches_own_group || return 1
              kill -KILL -- "-${marker_group}" 2>/dev/null || return 1
              return 1
              ;;
          esac
        done
        marker_matches_own_group || return 1
        group_has_non_marker_member
        case $? in
          0) kill -KILL -- "-${marker_group}" 2>/dev/null || return 1 ;;
          1) kill -KILL "${BASHPID}" 2>/dev/null || return 1 ;;
          *)
            marker_matches_own_group || return 1
            kill -KILL -- "-${marker_group}" 2>/dev/null || return 1
            ;;
        esac
        return 1
      }
      observation_failures=0
      while :; do
        if leader_parent="$(observe_leader_parent)"; then
          observation_failures=0
          if [[ "${leader_parent}" != "${controller_pid}" ]]; then
            reap_exact_owned_group
            exit 1
          fi
        else
          observation_status=$?
          if [[ ${observation_status} -eq 1 ]]; then
            # Absence was proven by a successful, syntactically valid process query.
            reap_exact_owned_group
            exit 1
          fi
          observation_failures=$((observation_failures + 1))
          if [[ ${observation_failures} -ge 20 ]]; then
            # Bounded uncertainty: expire the exact marked group, never infer absence.
            expire_unobservable_own_group
            exit 1
          fi
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
# Cleanup is one-shot. The first trap disables EXIT and ignores further termination signals
# before it touches the group, so a SIGTERM during cleanup cannot re-enter a numeric-PGID
# decision or replace the original exit status with a nested handler's status.
CLEANUP_STARTED=0
cleanup_and_exit() {
  local first_status="$1"
  if [[ ${CLEANUP_STARTED} -ne 0 ]]; then
    exit "${first_status}"
  fi
  CLEANUP_STARTED=1
  trap - EXIT
  trap '' INT TERM HUP
  stop_server || true
  exit "${first_status}"
}
trap 'cleanup_and_exit "$?"' EXIT
trap 'cleanup_and_exit 130' INT
trap 'cleanup_and_exit 143' TERM
trap 'cleanup_and_exit 129' HUP
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
  show_fixed_log_notice
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
  show_fixed_log_notice
  phase_record "phase2_worker_served" "fail" "the local Worker did not answer; captured diagnostics were withheld" "$((SECONDS * 1000))"
  exit 1
fi

if ! assert_provenance_stable "after_worker_ready_before_checker"; then
  exit 1
fi

readonly CHECK_LOG="${RUN_DIR}/check.log"
S5_ORIGIN="${ORIGIN}" S5_SEED="${SEED}" S5_RUN_ID="${RUN_ID}" \
  S5_EXPECTED_SOURCE_DIGEST="${BASELINE_SOURCE_DIGEST}" \
  S5_EXPECTED_SOURCE_FILES="${BASELINE_SOURCE_FILES}" \
  S5_EXPECTED_BUN_VERSION="${BASELINE_BUN_VERSION}" \
  S5_EXPECTED_WRANGLER_VERSION="${BASELINE_WRANGLER_VERSION}" \
  bun apps/wire/src/render-face/check.ts 2>"${CHECK_LOG}"
readonly CHECK_EXIT=$?
CHECK_DIAGNOSTICS=0
if [[ -s "${CHECK_LOG}" ]]; then
  show_fixed_log_notice
  phase_record "checker_stderr" "fail" "the checker wrote unexpected diagnostics; contents were withheld" "$((SECONDS * 1000))"
  CHECK_DIAGNOSTICS=1
fi
if ! stop_server; then
  phase_record "phase2_worker_served" "fail" "owned local Worker cleanup could not be verified: ${CLEANUP_FAILURE}" "$((SECONDS * 1000))"
  exit 1
fi

if ! assert_provenance_stable "after_checker"; then
  exit 1
fi

if [[ ${CHECK_EXIT} -ne 0 || ${CHECK_DIAGNOSTICS} -ne 0 ]]; then
  show_fixed_log_notice
  phase_record "phase2_worker_served" "fail" "served faces disagreed with the local render; captured diagnostics were withheld" "$((SECONDS * 1000))"
  exit 1
fi

phase_record "phase2_worker_served" "pass" "served bytes, media types, ETags, 304s and canary absence all match the local render" "$((SECONDS * 1000))"
phase_record "spike_summary" "pass" "local render, goldens, pack determinism and the workerd-served faces agree" "$((SECONDS * 1000))"
