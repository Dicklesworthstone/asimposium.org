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

# The seed is caller-supplied (`ASIMP_S5_SEED`) and lands in a JSON record, so it is the one
# untrusted string in this script. `printf` into a JSON template cannot escape it: a quote
# forges keys, a newline forges a whole record, and credential-shaped text lands in a build
# log unredacted. Rather than escape, restrict: a seed is a short, boring identifier or the
# run refuses to start. That keeps the emitter provably total — every value it can ever
# receive is already JSON-safe — instead of correct-looking.
readonly SEED_PATTERN='^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'

# A JSON-safe alphabet is not the whole story: `asimp_ag_01J…` is letters, digits and
# underscores, so the shape check above accepts it while it is exactly a Fellow token. The
# never-log classes are refused by shape as well, before the value can reach a record.
readonly SEED_CREDENTIAL_SHAPES='asimp_ag_[A-Za-z0-9_-]{4,}|(sk|rk|pk)-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{20,}|[A-Za-z0-9]{32,}'

seed_rejection() {
  # Deliberately describes the rule without echoing the value: a rejected seed may be
  # credential-shaped, and the diagnostic that reports a secret is the same leak with extra
  # steps. The value never reaches stdout, stderr, argv or a log.
  printf '{"assertion":"seed_accepted","detail":"%s","duration_ms":0,"repro":"%s","seed":"<rejected>","spike":"s5-diptych","status":"fail"}\n' \
    "$1" "${REPRO}"
}

if [[ -n "${ASIMP_S5_SEED:-}" ]]; then
  if ! [[ "${ASIMP_S5_SEED}" =~ ${SEED_PATTERN} ]]; then
    seed_rejection "ASIMP_S5_SEED must match ${SEED_PATTERN} (letters, digits, dot, underscore, hyphen; <= 64 chars)"
    exit 64
  fi
  if [[ "${ASIMP_S5_SEED}" =~ ${SEED_CREDENTIAL_SHAPES} ]]; then
    seed_rejection "ASIMP_S5_SEED is credential-shaped; a seed is an identifier, never a secret"
    exit 64
  fi
fi
readonly SEED="${ASIMP_S5_SEED:-s5-fixed-seed-v1}"

# Every field below is either a literal owned by this file or SEED, which the guard above
# has already restricted to a JSON-safe alphabet. There is no path by which an unvalidated
# string reaches this printf.
phase_record() {
  local assertion="$1" status="$2" detail="$3" duration="$4"
  printf '{"assertion":"%s","detail":"%s","duration_ms":%s,"repro":"%s","seed":"%s","spike":"s5-diptych","status":"%s"}\n' \
    "$assertion" "$detail" "$duration" "$REPRO" "$SEED" "$status"
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
if ! bun packages/render/scripts/s5-spike.ts --seed "$SEED"; then
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

# `SERVER_PID` is set the instant the server exists, and the cleanup that reads it is
# defined *before* the spawn, so there is never a window where a server is running and
# nothing knows how to stop it. It is idempotent: the trap and the happy path both call it.
SERVER_PID=""
stop_server() {
  [[ -n "${SERVER_PID}" ]] || return 0
  if kill -0 "${SERVER_PID}" 2>/dev/null; then
    # Signal the process group: wrangler supervises a workerd child, and killing only the
    # supervisor leaves that child holding the port.
    kill -TERM "-${SERVER_PID}" 2>/dev/null || kill -TERM "${SERVER_PID}" 2>/dev/null
    for _wait in {1..20}; do
      kill -0 "${SERVER_PID}" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL "-${SERVER_PID}" 2>/dev/null || kill -KILL "${SERVER_PID}" 2>/dev/null
    wait "${SERVER_PID}" 2>/dev/null
  fi
  SERVER_PID=""
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
#
# Job control in a non-interactive shell, purely so the next background job becomes its own
# process-group leader. Without it `kill -- -PID` has no group to signal and wrangler's
# workerd child outlives the supervisor, still holding the port.
set -m
"${WRANGLER}" dev apps/wire/src/render-face/worker.ts \
  --config infra/wrangler.toml \
  --local \
  --persist-to "${RUN_DIR}" \
  --port "${PORT}" \
  --inspector-port 0 \
  --log-level error \
  --show-interactive-dev-session=false \
  >"${SERVER_LOG}" 2>&1 &
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

readonly CHECK_LOG="${RUN_DIR}/check.log"
S5_ORIGIN="${ORIGIN}" bun apps/wire/src/render-face/check.ts 2>"${CHECK_LOG}"
readonly CHECK_EXIT=$?
if [[ -s "${CHECK_LOG}" ]]; then
  show_redacted "phase 2 stderr" "${CHECK_LOG}" 40
fi
stop_server

if [[ ${CHECK_EXIT} -ne 0 ]]; then
  show_redacted "wrangler" "${SERVER_LOG}" 40
  phase_record "phase2_worker_served" "fail" "served faces disagreed with the local render; records and logs are above" "$((SECONDS * 1000))"
  exit 1
fi

phase_record "phase2_worker_served" "pass" "served bytes, media types, ETags, 304s and canary absence all match the local render" "$((SECONDS * 1000))"
phase_record "spike_summary" "pass" "local render, goldens and the workerd-served faces agree" "$((SECONDS * 1000))"
