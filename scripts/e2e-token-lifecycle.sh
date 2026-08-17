#!/usr/bin/env bash
# W3.7 local Fellow-token lifecycle proof (bead asimposiumorg-9p4).
#
# This starts the production Worker entrypoint through Wrangler's local workerd
# runtime with the real D1 migration chain. It intentionally uses HTTP routes
# and the production service-envelope and Zod contracts, never an in-process
# store, a local refusal scaffold, or mocked bindings.
#
# Evidence boundary: this proves one local workerd/D1 process. It does not
# establish deployed D1, Google-authenticated Agora, or cross-colo behavior.

set -euo pipefail
set -m

SELF_TEST=0
case "$#" in
  0) ;;
  1)
    [[ "$1" == "--self-test" ]] || {
      printf '%s\n' '{"suite":"token-lifecycle-local","status":"fail","code":"TOKEN_LIFECYCLE_USAGE"}'
      exit 64
    }
    SELF_TEST=1
    ;;
  *)
    printf '%s\n' '{"suite":"token-lifecycle-local","status":"fail","code":"TOKEN_LIFECYCLE_USAGE"}'
    exit 64
    ;;
esac

readonly SUITE="token-lifecycle-local"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1
readonly ROOT
readonly WRANGLER="${ROOT}/apps/wire/node_modules/.bin/wrangler"
readonly CONFIG="${ROOT}/apps/wire/test/integration/wrangler.token-lifecycle.toml"
readonly REPRODUCE="TMPDIR=/Volumes/USB_NVME bash scripts/e2e-token-lifecycle.sh"
readonly TOTAL_DEADLINE_SECONDS=150
readonly READY_DEADLINE_SECONDS=35
readonly CLEANUP_GRACE_SECONDS=10
readonly SCRIPT_DEADLINE=$((SECONDS + TOTAL_DEADLINE_SECONDS))
readonly HTTP_TIMEOUT_MS=3000
readonly -a EXPECTED_MIGRATIONS=(
  "0001_krater_v0.sql"
  "0002_enrollment_g0.sql"
  "0003_auth_nonce_replay.sql"
  "0004_krater_integrity_v1.sql"
  "0005_krater_undigested_index.sql"
  "0006_fellow_credential_lifecycle.sql"
  "0007_outbox_quarantine_state.sql"
  "0008_sponsors_bootstrap.sql"
  "0009_device_flow.sql"
  "0010_device_flow_hardening.sql"
  "0011_fellow_credential_hardening.sql"
  "0012_fellow_lifecycle_commands.sql"
  "0013_sponsor_fellow_cap.sql"
  "0014_sponsor_enrollment_rate_limit.sql"
  "0015_sponsor_enrollment_bootstrap_invariant.sql"
  "0016_operator_fellow_cap_override.sql"
)

STATE_DIR=""
SERVER_PID=""
SERVER_PGID=""
CONTROLLER_PGID=""
SERVER_LEADER_IDENTITY=""
SERVER_IDENTITY_STATE=""
SERVER_SUPERVISOR_NONCE=""
SERVER_SUPERVISOR_MARKER=""
SERVER_SUPERVISOR_READY=""
SERVER_SUPERVISOR_GO=""
SERVER_SUPERVISOR_CHALLENGE=""
SERVER_SUPERVISOR_RESPONSE=""
SERVER_SUPERVISOR_STARTED=""
SERVER_TARGET_GATE_OPENED=0
RESPONDER_PID=""
RESPONDER_IDENTITY=""
RESPONDER_DESCENDANTS=""
BUSY_PORT_PID=""
PLANTED_DETACHED_PID=""
SOURCE_CLOSURE_BEFORE=""
SOURCE_CLOSURE_AFTER=""
LOG_CANARY_BEARER=""
LOG_CANARY_FRAGMENT=""
BARRIER_CAPABILITY=""

emit() {
  printf '%s\n' "$1"
}

fail() {
  emit "{\"suite\":\"${SUITE}\",\"status\":\"fail\",\"code\":\"$1\",\"reproduce\":\"${REPRODUCE}\"}"
  return 1
}

remaining_seconds() {
  local remaining=$((SCRIPT_DEADLINE - SECONDS))
  (( remaining > 0 )) || return 1
  printf '%s\n' "${remaining}"
}

require_remaining() {
  remaining_seconds >/dev/null || fail "TOKEN_LIFECYCLE_DEADLINE_EXHAUSTED"
}

source_closure_manifest() {
  # shellcheck disable=SC2016
  TOKEN_LIFECYCLE_CLOSURE_ROOT="${ROOT}" \
    "${BUN}" --eval '
      import { existsSync, readdirSync, readFileSync } from "node:fs";
      import { dirname, extname, relative, resolve } from "node:path";

      const root = process.env.TOKEN_LIFECYCLE_CLOSURE_ROOT;
      if (root === undefined) throw new Error("closure root unavailable");
      const migrations = [
        "0001_krater_v0.sql",
        "0002_enrollment_g0.sql",
        "0003_auth_nonce_replay.sql",
        "0004_krater_integrity_v1.sql",
        "0005_krater_undigested_index.sql",
        "0006_fellow_credential_lifecycle.sql",
        "0007_outbox_quarantine_state.sql",
        "0008_sponsors_bootstrap.sql",
        "0009_device_flow.sql",
        "0010_device_flow_hardening.sql",
        "0011_fellow_credential_hardening.sql",
        "0012_fellow_lifecycle_commands.sql",
        "0013_sponsor_fellow_cap.sql",
        "0014_sponsor_enrollment_rate_limit.sql",
        "0015_sponsor_enrollment_bootstrap_invariant.sql",
        "0016_operator_fellow_cap_override.sql",
      ];
      const migrationDirectory = resolve(root, "db/migrations");
      const discovered = readdirSync(migrationDirectory)
        .filter((name) => /^\d{4}_.+\.sql$/.test(name))
        .sort();
      if (JSON.stringify(discovered) !== JSON.stringify(migrations)) {
        throw new Error("migration closure is not exactly 0001 through 0016");
      }
      const extensions = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".json"];
      const fileFor = (candidate) => {
        for (const extension of extensions) {
          const file = `${candidate}${extension}`;
          if (existsSync(file)) return file;
        }
        for (const extension of extensions.slice(1)) {
          const file = resolve(candidate, `index${extension}`);
          if (existsSync(file)) return file;
        }
        return undefined;
      };
      const resolveSpecifier = (specifier, from) => {
        if (specifier.startsWith(".")) return fileFor(resolve(dirname(from), specifier));
        if (specifier.startsWith("@/")) return fileFor(resolve(root, "apps/web", specifier.slice(2)));
        if (specifier.startsWith("@asimposium/")) {
          const [packageName, ...rest] = specifier.slice("@asimposium/".length).split("/");
          const base = resolve(root, "packages", packageName, "src", ...rest);
          return fileFor(rest.length === 0 ? resolve(base, "index") : base);
        }
        return undefined;
      };
      const sourcePaths = new Set();
      const visit = (file) => {
        const canonical = resolve(file);
        if (sourcePaths.has(canonical)) return;
        const repoPath = relative(root, canonical);
        if (repoPath.startsWith("..")) throw new Error("closure escaped repository");
        sourcePaths.add(canonical);
        if (![".ts", ".tsx", ".mts", ".cts", ".js", ".mjs"].includes(extname(canonical))) return;
        const contents = readFileSync(canonical, "utf8");
        const matcher = /(?:import|export)\s+(?:[^"\x27\n]*?\s+from\s+)?["\x27]([^"\x27]+)["\x27]|import\(\s*["\x27]([^"\x27]+)["\x27]\s*\)/g;
        for (const match of contents.matchAll(matcher)) {
          const specifier = match[1] ?? match[2];
          if (specifier === undefined) continue;
          const local = resolveSpecifier(specifier, canonical);
          if (local !== undefined) {
            visit(local);
            continue;
          }
          if (specifier.startsWith(".") || specifier.startsWith("@/") || specifier.startsWith("@asimposium/")) {
            throw new Error(`unresolved local closure import: ${specifier}`);
          }
        }
      };
      for (const entrypoint of [
        "scripts/e2e-token-lifecycle.sh",
        "apps/wire/src/index.ts",
        "apps/wire/test/integration/token-lifecycle-local-worker.ts",
        "apps/wire/test/integration/wrangler.token-lifecycle.toml",
        "apps/web/lib/service-envelope.ts",
        "infra/wrangler.toml",
        "apps/wire/package.json",
        "package.json",
        "db/bootstrap/manifest.json",
        ...migrations.map((name) => `db/migrations/${name}`),
      ]) {
        visit(resolve(root, entrypoint));
      }
      const entries = [];
      for (const file of [...sourcePaths].sort()) {
        const bytes = await Bun.file(file).arrayBuffer();
        const hash = Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
          (value) => value.toString(16).padStart(2, "0"),
        ).join("");
        entries.push(`${relative(root, file)}\\0${hash}`);
      }
      const digest = Array.from(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(entries.join("\\n"))),
        ),
        (value) => value.toString(16).padStart(2, "0"),
      ).join("");
      console.log(`${digest}\\t${entries.length}`);
    '
}

assert_source_closure_unchanged() {
  SOURCE_CLOSURE_AFTER="$(source_closure_manifest)" || {
    fail "TOKEN_LIFECYCLE_SOURCE_CLOSURE_UNAVAILABLE"
    return 1
  }
  [[ "${SOURCE_CLOSURE_AFTER}" == "${SOURCE_CLOSURE_BEFORE}" ]] || {
    fail "TOKEN_LIFECYCLE_SOURCE_CLOSURE_DRIFT"
    return 1
  }
  emit "{\"suite\":\"${SUITE}\",\"assertion\":\"transitive_source_config_migration_closure\",\"status\":\"pass\"}"
}

group_members() {
  local pgid="$1"
  ps -eo pid=,pgid= 2>/dev/null | awk -v wanted="${pgid}" '$2 == wanted { print $1 }'
}

group_is_empty() {
  local members
  members="$(group_members "$1")" || return 1
  [[ -z "${members}" ]]
}

raw_process_identity() {
  local pid="$1" raw
  raw="$(LC_ALL=C ps -o pid= -o pgid= -o lstart= -o command= -p "${pid}" 2>/dev/null)" || return 1
  [[ -n "${raw}" ]] || return 1
  awk '
    NF >= 8 {
      start = $3 " " $4 " " $5 " " $6 " " $7
      command = ""
      for (position = 8; position <= NF; position += 1) command = command (position == 8 ? "" : " ") $position
      print $1 "\t" $2 "\t" start "\t" command
    }
  ' <<<"${raw}"
}

process_identity() {
  [[ "${TOKEN_LIFECYCLE_TEST_PARTIAL_PS:-0}" != "1" ]] || return 1
  raw_process_identity "$1"
}

listener_pids() {
  "${LSOF}" -nP -iTCP:"${PORT}" -sTCP:LISTEN -t 2>/dev/null | awk 'NF { print }' | sort -n -u
}

state_owned_processes() {
  [[ -n "${STATE_DIR}" ]] || return 0
  ps -eo pid=,pgid=,command= 2>/dev/null | TOKEN_LIFECYCLE_STATE_SCAN="${STATE_DIR}" awk '
    BEGIN { state = ENVIRON["TOKEN_LIFECYCLE_STATE_SCAN"] }
    index($0, state) { print $1 " " $2 }
  '
}

state_fds_are_closed() {
  [[ -n "${STATE_DIR}" ]] || return 0
  local opened
  opened="$("${LSOF}" +D "${STATE_DIR}" 2>/dev/null || true)"
  [[ -z "${opened}" ]]
}

port_is_free() {
  [[ -z "$(listener_pids)" ]]
}

capture_responder_identity() {
  local listeners responder command identity pgid
  listeners="$(listener_pids)" || return 1
  [[ "$(printf '%s\n' "${listeners}" | awk 'NF { count += 1 } END { print count + 0 }')" == "1" ]] || return 1
  responder="${listeners}"
  identity="$(process_identity "${responder}")" || return 1
  IFS=$'\t' read -r _ pgid _ _ <<<"${identity}"
  [[ "${pgid}" == "${SERVER_PGID}" ]] || return 1
  command="$(LC_ALL=C ps -o command= -p "${responder}" 2>/dev/null)" || return 1
  [[ "${command}" == *workerd* ]] || return 1
  RESPONDER_PID="${responder}"
  RESPONDER_IDENTITY="${identity}"
  RESPONDER_DESCENDANTS="$(group_members "${SERVER_PGID}")"
}

responder_identity_is_current() {
  [[ -n "${RESPONDER_PID}" && -n "${RESPONDER_IDENTITY}" ]] || return 1
  [[ "$(process_identity "${RESPONDER_PID}")" == "${RESPONDER_IDENTITY}" ]] || return 1
  [[ "$(listener_pids)" == "${RESPONDER_PID}" ]] || return 1
  [[ "$(process_identity "${SERVER_PID}")" == "${SERVER_LEADER_IDENTITY}" ]]
}

challenge_server_supervisor() {
  local challenge deadline seen_challenge seen_pid seen_pgid seen_nonce
  [[ -n "${SERVER_SUPERVISOR_NONCE}" \
    && -n "${SERVER_SUPERVISOR_CHALLENGE}" \
    && -n "${SERVER_SUPERVISOR_RESPONSE}" ]] || return 1
  challenge="$(${BUN} --eval 'console.log(crypto.randomUUID())')" || return 1
  [[ -n "${challenge}" ]] || return 1
  printf '%s\n' "${challenge}" >"${SERVER_SUPERVISOR_CHALLENGE}" || return 1
  deadline=$((SECONDS + 2))
  (( deadline > SCRIPT_DEADLINE )) && deadline="${SCRIPT_DEADLINE}"
  while (( SECONDS < deadline )); do
    if [[ -f "${SERVER_SUPERVISOR_RESPONSE}" ]] &&
      IFS=$'\t' read -r seen_challenge seen_pid seen_pgid seen_nonce \
        <"${SERVER_SUPERVISOR_RESPONSE}" &&
      [[ "${seen_challenge}" == "${challenge}" \
        && "${seen_pid}" == "${SERVER_PID}" \
        && "${seen_pgid}" == "${SERVER_PGID}" \
        && "${seen_nonce}" == "${SERVER_SUPERVISOR_NONCE}" ]]; then
      return 0
    fi
    sleep 0.01
  done
  return 1
}

server_group_signal_is_authorized() {
  case "${SERVER_IDENTITY_STATE}" in
    pinned)
      [[ -n "${SERVER_LEADER_IDENTITY}" ]] || return 1
      [[ "$(raw_process_identity "${SERVER_PID}")" == "${SERVER_LEADER_IDENTITY}" ]] || return 1
      challenge_server_supervisor
      ;;
    supervisor)
      # Before the private ready record is published, the random marker in the
      # direct child's argv is the only signal anchor. It cannot be inherited
      # by an unrelated PID-reuse target.
      [[ "${SERVER_PGID}" == "${SERVER_PID}" ]] || return 1
      [[ "$(raw_process_identity "${SERVER_PID}")" == *"${SERVER_SUPERVISOR_MARKER}"* ]]
      ;;
    supervisor-ready)
      challenge_server_supervisor
      ;;
    *) return 1 ;;
  esac
}

assert_responder_identity() {
  responder_identity_is_current || {
    fail "TOKEN_LIFECYCLE_RESPONDER_IDENTITY_DRIFT"
    return 1
  }
}

stop_auxiliary_child() {
  local pid="$1" label="$2"
  [[ -n "${pid}" ]] || return 0
  if kill -0 "${pid}" 2>/dev/null; then
    kill -TERM "${pid}" 2>/dev/null || {
      fail "TOKEN_LIFECYCLE_${label}_TERM_UNDELIVERED"
      return 1
    }
  fi
  local deadline=$((SECONDS + CLEANUP_GRACE_SECONDS))
  (( deadline > SCRIPT_DEADLINE )) && deadline="${SCRIPT_DEADLINE}"
  while (( SECONDS < deadline )); do
    if ! kill -0 "${pid}" 2>/dev/null; then
      wait "${pid}" 2>/dev/null || true
      return 0
    fi
    sleep 0.1
  done
  fail "TOKEN_LIFECYCLE_${label}_SURVIVOR"
  return 1
}

assert_migration_journal() {
  "${WRANGLER}" d1 execute DB --config "${CONFIG}" --local --persist-to "${STATE_DIR}" \
    --command 'SELECT id, name FROM d1_migrations ORDER BY id' --json \
    >"${MIGRATION_JOURNAL_LOG}" 2>"${MIGRATION_JOURNAL_ERROR_LOG}" || {
    fail "TOKEN_LIFECYCLE_MIGRATION_JOURNAL_UNREADABLE"
    return 1
  }
  TOKEN_LIFECYCLE_JOURNAL_PATH="${MIGRATION_JOURNAL_LOG}" \
    TOKEN_LIFECYCLE_EXPECTED_MIGRATIONS="${EXPECTED_MIGRATIONS[*]}" \
    "${BUN}" --eval '
      import { readFileSync } from "node:fs";
      const payload = JSON.parse(readFileSync(process.env.TOKEN_LIFECYCLE_JOURNAL_PATH, "utf8"));
      const expected = (process.env.TOKEN_LIFECYCLE_EXPECTED_MIGRATIONS ?? "").split(" ");
      const entries = Array.isArray(payload)
        ? payload.flatMap((entry) => Array.isArray(entry?.results) ? entry.results : [])
        : Array.isArray(payload?.results) ? payload.results : [];
      if (entries.length !== expected.length) process.exit(1);
      for (let index = 0; index < expected.length; index += 1) {
        const entry = entries[index];
        if (entry?.id !== index + 1 || entry?.name !== expected[index]) process.exit(1);
      }
    ' || {
      fail "TOKEN_LIFECYCLE_MIGRATION_JOURNAL_MISMATCH"
      return 1
    }
  emit "{\"suite\":\"${SUITE}\",\"assertion\":\"d1_migrations_exact_0001_through_0016\",\"status\":\"pass\"}"
}

assert_post_stop_d1_counts() {
  "${WRANGLER}" d1 execute DB --config "${CONFIG}" --local --persist-to "${STATE_DIR}" \
    --command "SELECT (SELECT COUNT(*) FROM fellow_lifecycle_events WHERE action = 'credential-revoked') AS credential_revoked_events, (SELECT COUNT(*) FROM enrollment_idempotency WHERE scope = 'credential-revoke') AS credential_replays" \
    --json >"${POST_STOP_D1_LOG}" 2>"${POST_STOP_D1_ERROR_LOG}" || {
      fail "TOKEN_LIFECYCLE_POST_STOP_D1_UNREADABLE"
      return 1
    }
  TOKEN_LIFECYCLE_COUNTS_PATH="${POST_STOP_D1_LOG}" "${BUN}" --eval '
    import { readFileSync } from "node:fs";
    const payload = JSON.parse(readFileSync(process.env.TOKEN_LIFECYCLE_COUNTS_PATH, "utf8"));
    const rows = Array.isArray(payload)
      ? payload.flatMap((entry) => Array.isArray(entry?.results) ? entry.results : [])
      : Array.isArray(payload?.results) ? payload.results : [];
    const row = rows[0];
    if (rows.length !== 1 || row?.credential_revoked_events !== 2 || row?.credential_replays !== 2) {
      process.exit(1);
    }
  ' || {
    fail "TOKEN_LIFECYCLE_POST_STOP_D1_COUNTS_MISMATCH"
    return 1
  }
  emit "{\"suite\":\"${SUITE}\",\"assertion\":\"post_stop_d1_two_barrier_revoke_events_and_replays\",\"status\":\"pass\"}"
}

scan_retained_logs() {
  local log
  for log in "${MIGRATION_LOG}" "${MIGRATION_JOURNAL_LOG}" "${MIGRATION_JOURNAL_ERROR_LOG}" \
    "${SERVER_LOG}" "${CLIENT_LOG}" "${CLIENT_ERROR_LOG}" "${POST_STOP_D1_LOG}" "${POST_STOP_D1_ERROR_LOG}"; do
    [[ -f "${log}" ]] || continue
    if grep -Fq -- "${LOG_CANARY_BEARER}" "${log}" || \
      grep -Fq -- "${LOG_CANARY_FRAGMENT}" "${log}" || \
      grep -Fq -- "${BARRIER_CAPABILITY}" "${log}" || \
      grep -Eq 'asimp_ag_[A-Za-z0-9_-]{8,}|#v1\.[A-Za-z0-9_-]{8,}' "${log}"; then
      fail "TOKEN_LIFECYCLE_SECRET_LOG_LEAK"
      return 1
    fi
  done
  emit "{\"suite\":\"${SUITE}\",\"assertion\":\"retained_migration_workerd_and_client_logs_secret_clean\",\"status\":\"pass\"}"
}

start_busy_port_plant() {
  [[ "${TOKEN_LIFECYCLE_TEST_BUSY_PORT:-0}" == "1" ]] || return 0
  TOKEN_LIFECYCLE_BUSY_PORT="${PORT}" "${BUN}" --eval '
    const port = Number(process.env.TOKEN_LIFECYCLE_BUSY_PORT);
    Bun.serve({ port, fetch: () => new Response("plant") });
    await Bun.sleep(600_000);
  ' >/dev/null 2>&1 &
  BUSY_PORT_PID=$!
  local deadline=$((SECONDS + CLEANUP_GRACE_SECONDS))
  (( deadline > SCRIPT_DEADLINE )) && deadline="${SCRIPT_DEADLINE}"
  while (( SECONDS < deadline )); do
    [[ -n "$(listener_pids)" ]] && return 0
    sleep 0.1
  done
  fail "TOKEN_LIFECYCLE_BUSY_PORT_PLANT_UNAVAILABLE"
  return 1
}

start_detached_state_plant() {
  [[ "${TOKEN_LIFECYCLE_TEST_DETACHED:-0}" == "1" ]] || return 0
  perl -MPOSIX=setsid -e 'setsid() or die "setsid"; sleep 600' \
    "TOKEN_LIFECYCLE_STATE=${STATE_DIR}" >/dev/null 2>&1 &
  PLANTED_DETACHED_PID=$!
  local deadline=$((SECONDS + CLEANUP_GRACE_SECONDS))
  (( deadline > SCRIPT_DEADLINE )) && deadline="${SCRIPT_DEADLINE}"
  while (( SECONDS < deadline )); do
    if [[ -n "$(state_owned_processes)" ]]; then
      fail "TOKEN_LIFECYCLE_DETACHED_STATE_PROCESS_DETECTED"
      return 1
    fi
    sleep 0.1
  done
  fail "TOKEN_LIFECYCLE_DETACHED_PLANT_UNOBSERVED"
  return 1
}

stop_worker() {
  local members cleanup_deadline worker_pgid
  [[ -n "${SERVER_PID}" ]] || return 0
  [[ -n "${SERVER_PGID}" ]] || {
    fail "TOKEN_LIFECYCLE_WORKER_GROUP_UNKNOWN"
    return 1
  }
  [[ "${SERVER_PGID}" != "${CONTROLLER_PGID}" ]] || {
    fail "TOKEN_LIFECYCLE_REFUSED_CONTROLLER_GROUP"
    return 1
  }
  worker_pgid="${SERVER_PGID}"

  members="$(group_members "${SERVER_PGID}")" || {
    fail "TOKEN_LIFECYCLE_GROUP_INSPECTION_UNAVAILABLE"
    return 1
  }
  if [[ -n "${members}" ]]; then
    # The group signal is authorized only by the original direct-child identity,
    # not a numeric PID/PGID that could have been recycled after readiness.
    if ! server_group_signal_is_authorized; then
      fail "TOKEN_LIFECYCLE_GROUP_LEADER_REAP_UNPROVEN"
      return 1
    fi
    kill -TERM "-${SERVER_PGID}" 2>/dev/null || {
      fail "TOKEN_LIFECYCLE_TERM_UNDELIVERED"
      return 1
    }
  fi

  cleanup_deadline=$((SECONDS + CLEANUP_GRACE_SECONDS))
  (( cleanup_deadline > SCRIPT_DEADLINE )) && cleanup_deadline="${SCRIPT_DEADLINE}"
  while (( SECONDS < cleanup_deadline )); do
    if group_is_empty "${SERVER_PGID}"; then
      wait "${SERVER_PID}" 2>/dev/null || true
      break
    fi
    sleep 0.1
  done

  if ! group_is_empty "${SERVER_PGID}"; then
    # KILL remains safe only while the original direct-child identity still
    # names this group. A responder mismatch alone does not remove that anchor.
    if ! server_group_signal_is_authorized; then
      fail "TOKEN_LIFECYCLE_GROUP_LEADER_REAP_UNPROVEN"
      return 1
    fi
    kill -KILL "-${SERVER_PGID}" 2>/dev/null || {
      fail "TOKEN_LIFECYCLE_KILL_UNDELIVERED"
      return 1
    }
    cleanup_deadline=$((SECONDS + CLEANUP_GRACE_SECONDS))
    (( cleanup_deadline > SCRIPT_DEADLINE )) && cleanup_deadline="${SCRIPT_DEADLINE}"
    while (( SECONDS < cleanup_deadline )); do
      if group_is_empty "${SERVER_PGID}"; then
        wait "${SERVER_PID}" 2>/dev/null || true
        break
      fi
      sleep 0.1
    done
  fi

  group_is_empty "${SERVER_PGID}" || {
    fail "TOKEN_LIFECYCLE_WORKER_SURVIVOR"
    return 1
  }
  port_is_free || {
    fail "TOKEN_LIFECYCLE_LISTENER_SURVIVOR"
    return 1
  }
  [[ -z "$(state_owned_processes)" ]] || {
    fail "TOKEN_LIFECYCLE_STATE_PROCESS_SURVIVOR"
    return 1
  }
  state_fds_are_closed || {
    fail "TOKEN_LIFECYCLE_STATE_FD_SURVIVOR"
    return 1
  }
  for member in ${RESPONDER_DESCENDANTS}; do
    if kill -0 "${member}" 2>/dev/null; then
      fail "TOKEN_LIFECYCLE_DESCENDANT_SURVIVOR"
      return 1
    fi
  done
  if (( SERVER_TARGET_GATE_OPENED == 0 )); then
    emit "{\"suite\":\"${SUITE}\",\"assertion\":\"startup_gate_supervisor_reaped_before_target_launch\",\"status\":\"pass\",\"wrangler_started\":false}"
  fi
  SERVER_PID=""
  SERVER_PGID=""
  SERVER_LEADER_IDENTITY=""
  SERVER_IDENTITY_STATE=""
  emit "{\"suite\":\"${SUITE}\",\"assertion\":\"workerd_group_descendants_listener_and_state_fds_reaped\",\"status\":\"pass\",\"pgid\":\"${worker_pgid}\"}"
}

finalize() {
  local status=$?
  trap - EXIT INT TERM HUP
  if ! stop_auxiliary_child "${PLANTED_DETACHED_PID}" "PLANTED_DETACHED"; then status=1; fi
  if ! stop_auxiliary_child "${BUSY_PORT_PID}" "BUSY_PORT"; then status=1; fi
  if ! stop_worker; then status=1; fi
  exit "${status}"
}

trap finalize EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

cd "${ROOT}"
BUN="$(command -v bun || true)"
[[ "${BUN}" == /* && -x "${BUN}" ]] || { fail "TOKEN_LIFECYCLE_BUN_UNAVAILABLE"; exit 1; }
readonly BUN
SOURCE_CLOSURE_BEFORE="$(source_closure_manifest)" || {
  fail "TOKEN_LIFECYCLE_SOURCE_CLOSURE_UNAVAILABLE"
  exit 1
}
if (( SELF_TEST == 1 )); then
  emit "{\"suite\":\"${SUITE}\",\"assertion\":\"self_test_transitive_source_config_migration_closure\",\"status\":\"pass\",\"wrangler_started\":false}"
  exit 0
fi
[[ -x "${WRANGLER}" ]] || { fail "TOKEN_LIFECYCLE_WRANGLER_UNAVAILABLE"; exit 1; }
[[ -f "${CONFIG}" ]] || { fail "TOKEN_LIFECYCLE_CONFIG_UNAVAILABLE"; exit 1; }
LSOF="$(command -v lsof || true)"
[[ "${LSOF}" == /* && -x "${LSOF}" ]] || { fail "TOKEN_LIFECYCLE_LSOF_UNAVAILABLE"; exit 1; }
readonly LSOF

STATE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/asimposium-token-lifecycle.XXXXXX")"
readonly STATE_DIR
readonly MIGRATION_LOG="${STATE_DIR}/migrations.log"
readonly MIGRATION_JOURNAL_LOG="${STATE_DIR}/migration-journal.json"
readonly MIGRATION_JOURNAL_ERROR_LOG="${STATE_DIR}/migration-journal.stderr"
readonly SERVER_LOG="${STATE_DIR}/workerd.log"
readonly CLIENT_LOG="${STATE_DIR}/client.jsonl"
readonly CLIENT_ERROR_LOG="${STATE_DIR}/client.stderr"
readonly POST_STOP_D1_LOG="${STATE_DIR}/post-stop-d1.json"
readonly POST_STOP_D1_ERROR_LOG="${STATE_DIR}/post-stop-d1.stderr"
SERVER_SUPERVISOR_READY="${STATE_DIR}/supervisor.ready"
SERVER_SUPERVISOR_GO="${STATE_DIR}/supervisor.go"
SERVER_SUPERVISOR_CHALLENGE="${STATE_DIR}/supervisor.challenge"
SERVER_SUPERVISOR_RESPONSE="${STATE_DIR}/supervisor.response"
SERVER_SUPERVISOR_STARTED="${STATE_DIR}/supervisor.started"

CONTROLLER_PGID="$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')"
[[ "${CONTROLLER_PGID}" =~ ^[0-9]+$ ]] || { fail "TOKEN_LIFECYCLE_CONTROLLER_GROUP_UNKNOWN"; exit 1; }

PORT="$(${BUN} --eval '
const server = Bun.serve({ port: 0, fetch: () => new Response("unused") });
console.log(server.port);
server.stop();
')"
[[ "${PORT}" =~ ^[0-9]+$ ]] || { fail "TOKEN_LIFECYCLE_PORT_UNAVAILABLE"; exit 1; }
readonly ORIGIN="http://127.0.0.1:${PORT}"

start_busy_port_plant || exit 1
port_is_free || { fail "TOKEN_LIFECYCLE_PORT_ALREADY_BOUND"; exit 1; }

KEY_MATERIAL="$(${BUN} --eval '
const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
const publicKeyHex = Array.from(publicKey, (value) => value.toString(16).padStart(2, "0")).join("");
const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
console.log(JSON.stringify({ publicKeyHex, privateJwk }));
')"
KEYRING_JSON="$(printf '%s' "${KEY_MATERIAL}" | ${BUN} --eval '
let raw = "";
for await (const chunk of Bun.stdin.stream()) raw += new TextDecoder().decode(chunk);
const material = JSON.parse(raw);
console.log(JSON.stringify([{ kid: "token-lifecycle-local", publicKeyHex: material.publicKeyHex, notBefore: 0 }]));
')"
PRIVATE_JWK="$(printf '%s' "${KEY_MATERIAL}" | ${BUN} --eval '
let raw = "";
for await (const chunk of Bun.stdin.stream()) raw += new TextDecoder().decode(chunk);
console.log(JSON.stringify(JSON.parse(raw).privateJwk));
')"
REPLAY_KEY="$(${BUN} --eval '
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  console.log(Buffer.from(bytes).toString("base64url"));
')"
# shellcheck disable=SC2016
LOG_CANARY_BEARER="$(${BUN} --eval '
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  console.log(`asimp_ag_${Buffer.from(bytes).toString("base64url")}`);
')"
# shellcheck disable=SC2016
LOG_CANARY_FRAGMENT="$(${BUN} --eval '
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  console.log(`https://a.invalid/join/ASIMP-EN-CANARY#v1.${Buffer.from(bytes).toString("base64url")}`);
')"
BARRIER_CAPABILITY="$(${BUN} --eval '
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  console.log(Buffer.from(bytes).toString("hex"));
')"
SERVER_SUPERVISOR_NONCE="$(${BUN} --eval '
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  console.log(Buffer.from(bytes).toString("hex"));
')"
SERVER_SUPERVISOR_MARKER="token-lifecycle-supervisor-${SERVER_SUPERVISOR_NONCE}"

require_remaining
"${WRANGLER}" d1 migrations apply DB --config "${CONFIG}" --local --persist-to "${STATE_DIR}" \
  --env-file /dev/null >"${MIGRATION_LOG}" 2>&1 || { fail "TOKEN_LIFECYCLE_MIGRATIONS_FAILED"; exit 1; }
assert_migration_journal || exit 1

# The nonce-bearing supervisor is the stable process-group leader. It cannot
# launch Wrangler until the parent validates its private ready record and opens
# the go gate, and it continues answering fresh challenges while the Worker is
# live. Secret bindings remain environment-only and never enter argv.
(
  AGORA_ORIGIN="https://asimposium.org" ENROLLMENT_REPLAY_KEY="${REPLAY_KEY}" \
    STOA_ORIGIN="${ORIGIN}" \
    TOKEN_LIFECYCLE_BARRIER_CAP="${BARRIER_CAPABILITY}" \
    SERVICE_ENVELOPE_KEYS="${KEYRING_JSON}" CLOUDFLARE_INCLUDE_PROCESS_ENV=true \
    TOKEN_LIFECYCLE_SUPERVISOR_NONCE="${SERVER_SUPERVISOR_NONCE}" \
    TOKEN_LIFECYCLE_SUPERVISOR_MARKER="${SERVER_SUPERVISOR_MARKER}" \
    TOKEN_LIFECYCLE_SUPERVISOR_READY="${SERVER_SUPERVISOR_READY}" \
    TOKEN_LIFECYCLE_SUPERVISOR_GO="${SERVER_SUPERVISOR_GO}" \
    TOKEN_LIFECYCLE_SUPERVISOR_CHALLENGE="${SERVER_SUPERVISOR_CHALLENGE}" \
    TOKEN_LIFECYCLE_SUPERVISOR_RESPONSE="${SERVER_SUPERVISOR_RESPONSE}" \
    TOKEN_LIFECYCLE_SUPERVISOR_STARTED="${SERVER_SUPERVISOR_STARTED}" \
    exec perl -MPOSIX=WNOHANG -e '
      my $marker = shift @ARGV;
      die "marker" unless $marker eq $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_MARKER"};
      my $leader = $$;
      my $group = getpgrp(0);
      die "group" unless $leader == $group;
      $SIG{"TERM"} = sub {};
      open(my $ready, ">", $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_READY"}) or die "ready";
      print $ready join("\t", $leader, $group, $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_NONCE"}) . "\n";
      close($ready);
      my $last_challenge = "";
      my $answer_challenge = sub {
        return unless -e $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_CHALLENGE"};
        open(my $challenge_file, "<", $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_CHALLENGE"}) or die "challenge";
        my $challenge = <$challenge_file> // "";
        close($challenge_file);
        $challenge =~ s/\s+$//;
        return if $challenge eq "" || $challenge eq $last_challenge;
        open(my $response, ">", $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_RESPONSE"}) or die "response";
        print $response join("\t", $challenge, $leader, $group, $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_NONCE"}) . "\n";
        close($response);
        $last_challenge = $challenge;
      };
      until (-e $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_GO"}) {
        $answer_challenge->();
        select(undef, undef, undef, 0.01);
      }
      my $worker = fork();
      die "fork" unless defined($worker);
      if ($worker == 0) {
        $SIG{"TERM"} = "DEFAULT";
        exec @ARGV or die "exec";
      }
      open(my $started, ">", $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_STARTED"}) or die "started";
      print $started "$worker\n";
      close($started);
      my $status;
      while (1) {
        $answer_challenge->();
        my $done = waitpid($worker, WNOHANG);
        if ($done == $worker) { $status = $?; last; }
        die "waitpid" if $done < 0;
        select(undef, undef, undef, 0.01);
      }
      my $code = ($status & 127) ? 128 + ($status & 127) : $status >> 8;
      exit($code);
    ' "${SERVER_SUPERVISOR_MARKER}" "${WRANGLER}" dev --config "${CONFIG}" --local \
      --persist-to "${STATE_DIR}" --port "${PORT}" --inspector-port 0 --log-level error \
      --env-file /dev/null
) >"${SERVER_LOG}" 2>&1 &
SERVER_PID=$!
SERVER_PGID="${SERVER_PID}"
SERVER_IDENTITY_STATE="supervisor"

supervisor_ready_deadline=$((SECONDS + 5))
(( supervisor_ready_deadline > SCRIPT_DEADLINE )) && supervisor_ready_deadline="${SCRIPT_DEADLINE}"
supervisor_ready_pid=""
supervisor_ready_pgid=""
supervisor_ready_nonce=""
while (( SECONDS < supervisor_ready_deadline )); do
  if [[ -f "${SERVER_SUPERVISOR_READY}" ]] &&
    IFS=$'\t' read -r supervisor_ready_pid supervisor_ready_pgid supervisor_ready_nonce \
      <"${SERVER_SUPERVISOR_READY}" &&
    [[ "${supervisor_ready_pid}" == "${SERVER_PID}" \
      && "${supervisor_ready_pgid}" == "${SERVER_PGID}" \
      && "${supervisor_ready_nonce}" == "${SERVER_SUPERVISOR_NONCE}" ]]; then
    break
  fi
  sleep 0.01
done
[[ "${supervisor_ready_pid}" == "${SERVER_PID}" \
  && "${supervisor_ready_pgid}" == "${SERVER_PGID}" \
  && "${supervisor_ready_nonce}" == "${SERVER_SUPERVISOR_NONCE}" ]] || {
  fail "TOKEN_LIFECYCLE_SUPERVISOR_IDENTITY_UNPROVEN"
  exit 1
}
SERVER_IDENTITY_STATE="supervisor-ready"
if [[ "${TOKEN_LIFECYCLE_TEST_PRE_GO_FAILURE:-0}" == "1" ]]; then
  [[ ! -e "${SERVER_SUPERVISOR_STARTED}" ]] || {
    fail "TOKEN_LIFECYCLE_PRE_GO_TARGET_STARTED"
    exit 1
  }
  fail "TOKEN_LIFECYCLE_PRE_GO_FAILURE_PLANT"
  exit 1
fi
SERVER_LEADER_IDENTITY="$(raw_process_identity "${SERVER_PID}")" || {
  fail "TOKEN_LIFECYCLE_GROUP_LEADER_IDENTITY_UNAVAILABLE"
  exit 1
}
SERVER_IDENTITY_STATE="pinned"
SERVER_TARGET_GATE_OPENED=1
printf '%s\n' "go" >"${SERVER_SUPERVISOR_GO}" || {
  fail "TOKEN_LIFECYCLE_SUPERVISOR_GO_UNPUBLISHED"
  exit 1
}
supervisor_start_deadline=$((SECONDS + 5))
(( supervisor_start_deadline > SCRIPT_DEADLINE )) && supervisor_start_deadline="${SCRIPT_DEADLINE}"
while (( SECONDS < supervisor_start_deadline )); do
  [[ -s "${SERVER_SUPERVISOR_STARTED}" ]] && break
  sleep 0.01
done
[[ -s "${SERVER_SUPERVISOR_STARTED}" ]] || {
  fail "TOKEN_LIFECYCLE_WRANGLER_LAUNCH_UNPROVEN"
  exit 1
}

ready_deadline=$((SECONDS + READY_DEADLINE_SECONDS))
(( ready_deadline > SCRIPT_DEADLINE )) && ready_deadline="${SCRIPT_DEADLINE}"
while (( SECONDS < ready_deadline )); do
  if curl --noproxy '*' --silent --fail --connect-timeout 1 --max-time 1 --output /dev/null \
    "${ORIGIN}/internal/health"; then
    break
  fi
  sleep 0.2
done
curl --noproxy '*' --silent --fail --connect-timeout 1 --max-time 1 --output /dev/null \
  "${ORIGIN}/internal/health" || { fail "TOKEN_LIFECYCLE_WORKER_NOT_READY"; exit 1; }
capture_responder_identity || { fail "TOKEN_LIFECYCLE_RESPONDER_IDENTITY_UNPROVEN"; exit 1; }
if [[ "${TOKEN_LIFECYCLE_TEST_PID_REUSE:-0}" == "1" ]]; then
  RESPONDER_IDENTITY="${RESPONDER_IDENTITY} planted-start-time-mismatch"
fi
assert_responder_identity || exit 1
emit "{\"suite\":\"${SUITE}\",\"assertion\":\"ready_workerd_responder_pid_pgid_start_and_argv_pinned\",\"status\":\"pass\"}"
start_detached_state_plant || exit 1

read -r -d '' CLIENT_SOURCE <<'BUN' || true
import {
  EnrollmentApprovedResponseSchema,
  EnrollmentClaimResponseSchema,
  EnrollmentHelloResponseSchema,
  MintEnrollmentResponseSchema,
  ProblemDocumentSchema,
  SponsorCredentialRevokeResponseSchema,
  SponsorFellowListResponseSchema,
  SponsorPanicResponseSchema,
} from "@asimposium/contracts";
import { REDACTED_TOKEN, redactCredentials } from "@asimposium/contracts/diagnostic-safety";
import { mintServiceEnvelope, serviceEnvelopeHeaders } from "./apps/web/lib/service-envelope.ts";
import {
  fellowAuthorizationResponse,
  inspectFellowWriteAuthorization,
} from "./apps/wire/src/enrollment/service.ts";

const origin = process.env.TOKEN_LIFECYCLE_ORIGIN;
const privateJwk = process.env.TOKEN_LIFECYCLE_PRIVATE_JWK;
const barrierCapability = process.env.TOKEN_LIFECYCLE_BARRIER_CAPABILITY;
const authorizationEvidenceCanary = process.env.TOKEN_LIFECYCLE_AUTHZ_EVIDENCE_CANARY;
if (
  origin === undefined ||
  privateJwk === undefined ||
  barrierCapability === undefined ||
  authorizationEvidenceCanary === undefined
) {
  throw new Error("local configuration unavailable");
}
if (!/^[a-f0-9]{64}$/.test(barrierCapability)) throw new Error("local barrier capability unavailable");
const httpTimeoutMs = Number(process.env.TOKEN_LIFECYCLE_HTTP_TIMEOUT_MS ?? "3000");
if (!Number.isSafeInteger(httpTimeoutMs) || httpTimeoutMs < 1) {
  throw new Error("invalid local HTTP timeout");
}

const privateKey = await crypto.subtle.importKey(
  "jwk",
  JSON.parse(privateJwk),
  { name: "Ed25519" },
  false,
  ["sign"],
);
const kid = "token-lifecycle-local";
const sponsorA = "usr_token_lifecycle_a";
const sponsorB = "usr_token_lifecycle_b";

function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

function json(response: Response, text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`non-json-${response.status}`);
  }
}

async function boundedFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  return await fetch(input, { ...init, signal: AbortSignal.timeout(httpTimeoutMs) });
}

async function barrierControl(
  method: "GET" | "POST",
  path: "arm" | "release" | "status",
  payload?: Record<string, unknown>,
): Promise<{ readonly response: Response; readonly payload: unknown }> {
  const response = await boundedFetch(`${origin}/__token-lifecycle/${path}`, {
    method,
    headers: {
      connection: "close",
      "content-type": "application/json",
      "x-token-lifecycle-barrier-cap": barrierCapability,
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  return { response, payload: json(response, await response.text()) };
}

async function armRevokeBarrier(label: string): Promise<void> {
  const armed = await barrierControl("POST", "arm", { expected: 2 });
  assert(armed.response.status === 200, `${label}-barrier-arm`);
  assert(
    typeof armed.payload === "object" &&
      armed.payload !== null &&
      (armed.payload as Record<string, unknown>).expected === 2 &&
      (armed.payload as Record<string, unknown>).arrivals === 0,
    `${label}-barrier-armed-exactly-two`,
  );
}

async function awaitBothRevokeArrivals(label: string): Promise<void> {
  const deadline = Date.now() + httpTimeoutMs;
  while (Date.now() < deadline) {
    const status = await barrierControl("GET", "status");
    assert(status.response.status === 200, `${label}-barrier-status`);
    if (
      typeof status.payload === "object" &&
      status.payload !== null &&
      (status.payload as Record<string, unknown>).expected === 2 &&
      (status.payload as Record<string, unknown>).arrivals === 2 &&
      (status.payload as Record<string, unknown>).released === false
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${label}-barrier-did-not-observe-both-replay-preflights`);
}

async function releaseRevokeBarrier(label: string): Promise<void> {
  const released = await barrierControl("POST", "release");
  assert(released.response.status === 200, `${label}-barrier-release`);
  assert(
    typeof released.payload === "object" &&
      released.payload !== null &&
      (released.payload as Record<string, unknown>).expected === 2 &&
      (released.payload as Record<string, unknown>).arrivals === 2 &&
      (released.payload as Record<string, unknown>).released === true,
    `${label}-barrier-release-after-both-arrivals`,
  );
}

function responseHeaders(response: Response): string {
  return JSON.stringify([...response.headers].sort(([left], [right]) => left.localeCompare(right)));
}

async function sponsorRequest(
  principalId: string,
  method: "GET" | "POST",
  path: string,
  route: string,
  action: string,
  body?: Record<string, unknown>,
  idempotencyKey?: string,
) {
  const rawBody = body === undefined ? "" : JSON.stringify(body);
  const envelope = await mintServiceEnvelope({
    privateKey,
    kid,
    now: Math.floor(Date.now() / 1_000),
    method,
    route,
    action,
    principalId,
    body: rawBody,
  });
  const headers = new Headers(serviceEnvelopeHeaders(envelope));
  // The local barrier holds one HTTP response deliberately. Separate sockets
  // prevent a client connection pool from serializing the second contender
  // behind that held response and turning a true two-request race into a wait.
  headers.set("connection", "close");
  if (idempotencyKey !== undefined) headers.set("idempotency-key", idempotencyKey);
  const response = await boundedFetch(`${origin}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: rawBody }),
  });
  const text = await response.text();
  return { response, payload: json(response, text), text };
}

const RACE_REQUEST_SOURCE = `
  import { mintServiceEnvelope, serviceEnvelopeHeaders } from "./apps/web/lib/service-envelope.ts";
  const origin = process.env.TOKEN_LIFECYCLE_RACE_ORIGIN;
  const privateJwk = process.env.TOKEN_LIFECYCLE_RACE_PRIVATE_JWK;
  const rawBody = process.env.TOKEN_LIFECYCLE_RACE_BODY;
  const idempotencyKey = process.env.TOKEN_LIFECYCLE_RACE_IDEMPOTENCY_KEY;
  if (origin === undefined || privateJwk === undefined || rawBody === undefined || idempotencyKey === undefined) {
    throw new Error("race configuration unavailable");
  }
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    JSON.parse(privateJwk),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const envelope = await mintServiceEnvelope({
    privateKey,
    kid: "token-lifecycle-local",
    now: Math.floor(Date.now() / 1_000),
    method: "POST",
    route: "/v1/fellows/credentials/revoke",
    action: "fellow.credential.revoke",
    principalId: "usr_token_lifecycle_a",
    body: rawBody,
  });
  const headers = new Headers(serviceEnvelopeHeaders(envelope));
  headers.set("connection", "close");
  headers.set("idempotency-key", idempotencyKey);
  const response = await fetch(origin + "/v1/fellows/credentials/revoke", {
    method: "POST",
    headers,
    body: rawBody,
    signal: AbortSignal.timeout(Number(process.env.TOKEN_LIFECYCLE_RACE_TIMEOUT_MS ?? "3000")),
  });
  process.stdout.write(JSON.stringify({ status: response.status, text: await response.text() }));
`;

async function barrierRaceRequest(
  body: Record<string, unknown>,
  idempotencyKey: string,
  label: string,
) {
  const child = Bun.spawn({
    cmd: [process.execPath, "--eval", RACE_REQUEST_SOURCE],
    cwd: process.cwd(),
    env: {
      TOKEN_LIFECYCLE_RACE_BODY: JSON.stringify(body),
      TOKEN_LIFECYCLE_RACE_IDEMPOTENCY_KEY: idempotencyKey,
      TOKEN_LIFECYCLE_RACE_ORIGIN: origin,
      TOKEN_LIFECYCLE_RACE_PRIVATE_JWK: privateJwk,
      TOKEN_LIFECYCLE_RACE_TIMEOUT_MS: String(httpTimeoutMs),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const exitCode = await Promise.race([
    child.exited,
    Bun.sleep(httpTimeoutMs + 1_000).then(async () => {
      child.kill("SIGKILL");
      await child.exited;
      throw new Error(`${label}-race-child-timeout`);
    }),
  ]);
  const [text, error] = await Promise.all([stdout, stderr]);
  if (exitCode !== 0 || error !== "") {
    const diagnostic = error
      .replaceAll(privateJwk, "[redacted-private-key]")
      .replaceAll(JSON.stringify(body), "[redacted-request-body]")
      .replaceAll(idempotencyKey, "[redacted-idempotency-key]")
      .replaceAll(origin, "[redacted-origin]")
      .slice(0, 512)
      .replaceAll("\n", " ");
    throw new Error(`${label}-race-child-exit-${exitCode}-${diagnostic}`);
  }
  const parsed: unknown = JSON.parse(text);
  assert(
    typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).status === "number" &&
      typeof (parsed as Record<string, unknown>).text === "string",
    `${label}-race-child-response`,
  );
  const status = (parsed as Record<string, unknown>).status as number;
  const responseText = (parsed as Record<string, unknown>).text as string;
  const response = new Response(responseText, { status });
  return { response, payload: json(response, responseText), text: responseText };
}

async function fellowPost(path: string, body: Record<string, unknown>, idempotencyKey: string) {
  const response = await boundedFetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { response, payload: json(response, text) };
}

function expectProblem(result: { response: Response; payload: unknown }, status: number, code: string) {
  assert(result.response.status === status, `problem-status-${code}`);
  const problem = ProblemDocumentSchema.parse(result.payload);
  assert(problem.code === code, `problem-code-${code}`);
}

function stepUp() {
  return Math.floor(Date.now() / 1_000);
}

let serial = 0;
function key(label: string) {
  serial += 1;
  return `token-lifecycle-${label}-${serial}`;
}

const AUTHORIZATION_EVIDENCE_FIELD_LIMIT = 160;
const AUTHORIZATION_EVIDENCE_DIFF_LIMIT = 240;
const AUTHORIZATION_EVIDENCE_RECORD_LIMIT = 2_048;
const AUTHORIZATION_EVIDENCE_LATENCY_LIMIT_MS = 60_000;

function boundedEvidenceField(value: string, limit = AUTHORIZATION_EVIDENCE_FIELD_LIMIT): string {
  return redactCredentials(value).slice(0, limit);
}

function boundedEvidenceLatency(value: number): number {
  assert(Number.isFinite(value) && value >= 0, "authz-evidence-latency-finite");
  return Math.min(value, AUTHORIZATION_EVIDENCE_LATENCY_LIMIT_MS);
}

function authorizationEvidence(input: {
  assertion: string;
  credentialId: string;
  sponsorId: string;
  fellowId: string;
  scopeOrGrant: string;
  authState: string;
  decision: "allow" | "quarantine" | "refuse";
  code: string;
  requestId: string;
  eventId: string;
  latencyMs: number;
  assertionDiff: string;
}): string {
  const record = {
    suite: boundedEvidenceField("token-lifecycle-local"),
    record: boundedEvidenceField("authorization-decision"),
    assertion: boundedEvidenceField(input.assertion),
    credential_id: boundedEvidenceField(input.credentialId),
    sponsor_id: boundedEvidenceField(input.sponsorId),
    fellow_id: boundedEvidenceField(input.fellowId),
    scope_or_grant: boundedEvidenceField(input.scopeOrGrant),
    auth_state: boundedEvidenceField(input.authState),
    authorization_decision: boundedEvidenceField(input.decision),
    code: boundedEvidenceField(input.code),
    request_id: boundedEvidenceField(input.requestId),
    event_id: boundedEvidenceField(input.eventId),
    latency_ms: boundedEvidenceLatency(input.latencyMs),
    assertion_diff: boundedEvidenceField(input.assertionDiff, AUTHORIZATION_EVIDENCE_DIFF_LIMIT),
    status: boundedEvidenceField("pass"),
  };
  const encoded = JSON.stringify(record);
  assert(Buffer.byteLength(encoded, "utf8") <= AUTHORIZATION_EVIDENCE_RECORD_LIMIT, "authz-evidence-bounded");
  return encoded;
}

async function bootstrap(principalId: string) {
  const result = await sponsorRequest(
    principalId,
    "POST",
    "/v1/sponsors/bootstrap",
    "/v1/sponsors/bootstrap",
    "sponsor.bootstrap",
    {},
  );
  if (result.response.status !== 201 && result.response.status !== 200) {
    const code =
      typeof result.payload === "object" &&
      result.payload !== null &&
      typeof (result.payload as Record<string, unknown>).code === "string"
        ? (result.payload as Record<string, unknown>).code
        : "non-problem";
    throw new Error(`bootstrap-status-${result.response.status}-code-${code}`);
  }
}

type Flow = { enrollmentId: string; fellowId: string; token: string };

async function mintClaimApprove(
  name: string,
  options: { expiresInMs?: number; proveScopeRefusal?: boolean } = {},
): Promise<Flow> {
  const mintBody: Record<string, unknown> = {
    requested_scopes: ["review"],
    ...(options.expiresInMs === undefined
      ? {}
      : { fellow_grant_expires_in_ms: options.expiresInMs }),
  };
  const mintedResult = await sponsorRequest(
    sponsorA,
    "POST",
    "/v1/enrollments",
    "/v1/enrollments",
    "enrollment.mint",
    mintBody,
    key(`mint-${name}`),
  );
  assert(mintedResult.response.status === 201, `mint-${name}`);
  const minted = MintEnrollmentResponseSchema.parse(mintedResult.payload);

  const claimResult = await fellowPost(
    "/v1/fellows",
    {
      enrollment_id: minted.enrollment_id,
      secret: minted.secret,
      name,
      model: "local/lifecycle-proof",
      harness: "workerd-d1",
    },
    key(`claim-${name}`),
  );
  assert(claimResult.response.status === 202, `claim-${name}`);
  const claim = EnrollmentClaimResponseSchema.parse(claimResult.payload);

  if (options.proveScopeRefusal === true) {
    const escalationRequestId = key(`scope-escalation-${name}`);
    const escalation = await sponsorRequest(
      sponsorA,
      "POST",
      `/v1/enrollments/${minted.enrollment_id}/decision`,
      "/v1/enrollments/:enrollmentId/decision",
      "enrollment.decide",
      {
        enrollment_id: minted.enrollment_id,
        decision: "reduce",
        reduction: { scopes: ["promote"] },
        step_up_authenticated_at: stepUp(),
      },
      escalationRequestId,
    );
    expectProblem(escalation, 422, "SCOPE_ESCALATION");
  }

  const approved = await sponsorRequest(
    sponsorA,
    "POST",
    `/v1/enrollments/${minted.enrollment_id}/decision`,
    "/v1/enrollments/:enrollmentId/decision",
    "enrollment.decide",
    {
      enrollment_id: minted.enrollment_id,
      decision: "approve",
      step_up_authenticated_at: stepUp(),
    },
    key(`approve-${name}`),
  );
  assert(approved.response.status === 200, `approve-${name}`);

  const polled = await fellowPost(
    "/v1/fellows/flow",
    { flow_handle: claim.flow_handle },
    key(`poll-${name}`),
  );
  assert(polled.response.status === 200, `poll-${name}`);
  const granted = EnrollmentApprovedResponseSchema.parse(polled.payload);

  const hello = await boundedFetch(`${origin}/v1/hello`, {
    headers: { authorization: `Bearer ${granted.token}` },
  });
  assert(hello.status === 200, `hello-${name}`);
  const helloPayload = EnrollmentHelloResponseSchema.parse(await hello.json());
  return { enrollmentId: minted.enrollment_id, fellowId: helloPayload.fellow.fellow_id, token: granted.token };
}

async function assertTokenRejected(token: string, label: string) {
  const response = await boundedFetch(`${origin}/v1/hello`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert(response.status === 401, `token-invalid-${label}`);
  const payload = ProblemDocumentSchema.parse(await response.json());
  assert(payload.code === "FELLOW_TOKEN_INVALID", `token-code-${label}`);
}

await bootstrap(sponsorA);
await bootstrap(sponsorB);

const alpha = await mintClaimApprove("lifecycle-alpha", { proveScopeRefusal: true });
const expiring = await mintClaimApprove("lifecycle-expiring", { expiresInMs: 10_000 });
await new Promise((resolve) => setTimeout(resolve, 11_000));
await assertTokenRejected(expiring.token, "grant-expiry");

const charlie = await mintClaimApprove("lifecycle-charlie");
const delta = await mintClaimApprove("lifecycle-delta");
const echo = await mintClaimApprove("lifecycle-echo");

const capMint = await sponsorRequest(
  sponsorA,
  "POST",
  "/v1/enrollments",
  "/v1/enrollments",
  "enrollment.mint",
  { requested_scopes: ["review"] },
  key("mint-cap"),
);
assert(capMint.response.status === 201, "mint-cap");
const capEnrollment = MintEnrollmentResponseSchema.parse(capMint.payload);
const capClaim = await fellowPost(
  "/v1/fellows",
  {
    enrollment_id: capEnrollment.enrollment_id,
    secret: capEnrollment.secret,
    name: "lifecycle-cap",
    model: "local/lifecycle-proof",
    harness: "workerd-d1",
  },
  key("claim-cap"),
);
assert(capClaim.response.status === 202, "claim-cap");
const capDecision = await sponsorRequest(
  sponsorA,
  "POST",
  `/v1/enrollments/${capEnrollment.enrollment_id}/decision`,
  "/v1/enrollments/:enrollmentId/decision",
  "enrollment.decide",
  {
    enrollment_id: capEnrollment.enrollment_id,
    decision: "approve",
    step_up_authenticated_at: stepUp(),
  },
  key("approve-cap"),
);
expectProblem(capDecision, 409, "FELLOW_CAP_REACHED");

const fellowsResult = await sponsorRequest(
  sponsorA,
  "GET",
  "/v1/fellows",
  "/v1/fellows",
  "fellows.list",
);
assert(fellowsResult.response.status === 200, "fellows-list");
const fellows = SponsorFellowListResponseSchema.parse(fellowsResult.payload);
const alphaRecord = fellows.fellows.find((fellow) => fellow.fellow_id === alpha.fellowId);
assert(alphaRecord !== undefined, "alpha-listed");
const alphaCredential = alphaRecord.credentials.find((credential) => credential.active);
assert(alphaCredential !== undefined, "alpha-active-credential");

function missingId(value: string): string {
  const tail = value.at(-1);
  if (tail === undefined) throw new Error("missing-id-shape");
  return `${value.slice(0, -1)}${tail === "A" ? "B" : "A"}`;
}

const foreignBody = {
  fellow_id: alpha.fellowId,
  credential_id: alphaCredential.credential_id,
  confirm: "revoke-credential" as const,
  step_up_authenticated_at: stepUp(),
};
const missingBody = {
  fellow_id: missingId(alpha.fellowId),
  credential_id: missingId(alphaCredential.credential_id),
  confirm: "revoke-credential" as const,
  step_up_authenticated_at: foreignBody.step_up_authenticated_at,
};
const foreignRevoke = await sponsorRequest(
  sponsorB,
  "POST",
  "/v1/fellows/credentials/revoke",
  "/v1/fellows/credentials/revoke",
  "fellow.credential.revoke",
  foreignBody,
  key("foreign-revoke"),
);
expectProblem(foreignRevoke, 404, "FELLOW_LIFECYCLE_NOT_CURRENT");
const missingRevoke = await sponsorRequest(
  sponsorB,
  "POST",
  "/v1/fellows/credentials/revoke",
  "/v1/fellows/credentials/revoke",
  "fellow.credential.revoke",
  missingBody,
  key("missing-revoke"),
);
expectProblem(missingRevoke, 404, "FELLOW_LIFECYCLE_NOT_CURRENT");
assert(foreignRevoke.text === missingRevoke.text, "foreign-missing-404-body-equality");
assert(
  responseHeaders(foreignRevoke.response) === responseHeaders(missingRevoke.response),
  "foreign-missing-404-header-equality",
);
for (const target of [
  alpha.fellowId,
  alphaCredential.credential_id,
  missingBody.fellow_id,
  missingBody.credential_id,
]) {
  assert(!foreignRevoke.text.includes(target), "foreign-404-target-redaction");
  assert(!missingRevoke.text.includes(target), "missing-404-target-redaction");
}

const revokeBody = {
  fellow_id: alpha.fellowId,
  credential_id: alphaCredential.credential_id,
  confirm: "revoke-credential" as const,
  step_up_authenticated_at: stepUp(),
};
const revokeKey = key("revoke-alpha");
await armRevokeBarrier("same-body");
const sameBodyRequests = Promise.all([
  barrierRaceRequest(revokeBody, revokeKey, "same-body-first"),
  barrierRaceRequest(revokeBody, revokeKey, "same-body-second"),
]);
await awaitBothRevokeArrivals("same-body");
await releaseRevokeBarrier("same-body");
const [revoked, replayed] = await sameBodyRequests;
assert(revoked.response.status === 200, "revoke-alpha");
const revokedReceipt = SponsorCredentialRevokeResponseSchema.parse(revoked.payload);
assert(replayed.response.status === 200, "revoke-alpha-replay");
SponsorCredentialRevokeResponseSchema.parse(replayed.payload);
assert(replayed.text === revoked.text, "revoke-alpha-exact-replay");
console.log('{"suite":"token-lifecycle-local","assertion":"concurrent_http_same_key_revoke_exact_replay","deterministic_barrier":true,"store_gate":"after_replay_preflight_before_d1_revoke","status":"pass"}');
await assertTokenRejected(alpha.token, "individual-revoke");

// OPS.2a source/local boundary: no Fellow effectful-write route is mounted yet,
// so this cannot claim an HTTP refusal. It does invoke the one central policy
// evaluator with identities and the durable event returned by the real D1
// revoke above. The request id is the exact idempotency key that caused that
// event, not a second correlation id generated for the log line.
const postRevokeNow = revokedReceipt.effective_at;
const postRevokeCredential = {
  fellowId: alpha.fellowId,
  credentialId: alphaCredential.credential_id,
  sponsorId: sponsorA,
  name: alphaRecord.name,
  model: alphaRecord.model,
  harness: alphaRecord.harness,
  grantedScopes: alphaRecord.granted_scopes,
  grantedResources: {
    ...(alphaRecord.granted_resources.problem_binding === undefined
      ? {}
      : { problemBinding: alphaRecord.granted_resources.problem_binding }),
    ...(alphaRecord.granted_resources.event_budget === undefined
      ? {}
      : { eventBudget: alphaRecord.granted_resources.event_budget }),
    ...(alphaRecord.granted_resources.artifact_budget_bytes === undefined
      ? {}
      : { artifactBudgetBytes: alphaRecord.granted_resources.artifact_budget_bytes }),
    ...(alphaRecord.granted_resources.fellow_grant_expires_at === undefined
      ? {}
      : { fellowGrantExpiresAt: alphaRecord.granted_resources.fellow_grant_expires_at }),
  },
  // Authorization never reads credential material; this diagnostic binding
  // intentionally has none available from the sponsor-safe list response.
  tokenHash: "not-observed-by-authorization",
  issuedAt: alphaCredential.issued_at,
  expiresAt: alphaCredential.expires_at,
  revokedAt: revokedReceipt.effective_at,
  credentialProfile: alphaCredential.profile,
  fellowStatus: alphaRecord.status,
};
const postRevokeAuthState =
  postRevokeCredential.revokedAt <= postRevokeNow ? "revoked" : postRevokeCredential.fellowStatus;
assert(postRevokeAuthState === "revoked", "central-authz-state-revoked");
const authorizationStartedAt = performance.now();
const postRevokeAuthorization = inspectFellowWriteAuthorization({
  effect: "review",
  credential: postRevokeCredential,
  target: {
    kind: "existing-problem",
    problemId: "P-TOKEN-LIFECYCLE",
    publication: "published",
    unlisted: false,
    membershipRole: "observer",
  },
  usage: { eventsRecorded: 0, artifactBytesRecorded: 0 },
  now: postRevokeNow,
});
const authorizationLatencyMs = performance.now() - authorizationStartedAt;
assert(postRevokeAuthorization.decision.decision === "refuse", "central-authz-post-revoke-refuse");
assert(postRevokeAuthorization.operatorReason === "credential_revoked", "central-authz-post-revoke-reason");
const postRevokeCallerProblem = fellowAuthorizationResponse(postRevokeAuthorization.decision);
assert(postRevokeCallerProblem?.code === "UNAUTHORIZED", "central-authz-caller-code");
assert(
  !JSON.stringify(postRevokeCallerProblem).includes(postRevokeAuthorization.operatorReason),
  "central-authz-caller-problem-opaque",
);
const authorizationLine = authorizationEvidence({
  assertion: "central_policy_post_revoke_refusal_no_mounted_effectful_route",
  credentialId: alphaCredential.credential_id,
  sponsorId: sponsorA,
  fellowId: alpha.fellowId,
  scopeOrGrant: "review",
  authState: postRevokeAuthState,
  decision: "refuse",
  code: postRevokeCallerProblem.code,
  requestId: revokeKey,
  eventId: revokedReceipt.event_id,
  latencyMs: authorizationLatencyMs,
  assertionDiff: `expected=refuse observed=${postRevokeAuthorization.decision.decision} operator=${postRevokeAuthorization.operatorReason} canary=${authorizationEvidenceCanary}`,
});
assert(!authorizationLine.includes(authorizationEvidenceCanary), "authz-evidence-canary-redacted");
assert(authorizationLine.includes(REDACTED_TOKEN), "authz-evidence-canary-plant-fired");
process.stdout.write(`${authorizationLine}\n`);

function activeCredentialFor(fellowId: string) {
  const record = fellows.fellows.find((fellow) => fellow.fellow_id === fellowId);
  assert(record !== undefined, `fellow-listed-${fellowId}`);
  const credential = record.credentials.find((candidate) => candidate.active);
  assert(credential !== undefined, `fellow-active-credential-${fellowId}`);
  return credential;
}

const differentBodies = [
  {
    flow: charlie,
    body: {
      fellow_id: charlie.fellowId,
      credential_id: activeCredentialFor(charlie.fellowId).credential_id,
      confirm: "revoke-credential" as const,
      step_up_authenticated_at: stepUp(),
    },
  },
  {
    flow: delta,
    body: {
      fellow_id: delta.fellowId,
      credential_id: activeCredentialFor(delta.fellowId).credential_id,
      confirm: "revoke-credential" as const,
      step_up_authenticated_at: stepUp(),
    },
  },
] as const;
const differentKey = key("revoke-different-body");
await armRevokeBarrier("different-body");
const differentBodyRequests = Promise.all(
  differentBodies.map(({ body }, index) =>
    barrierRaceRequest(body, differentKey, `different-body-${index + 1}`),
  ),
);
await awaitBothRevokeArrivals("different-body");
await releaseRevokeBarrier("different-body");
const differentResults = await differentBodyRequests;
const winnerIndex = differentResults.findIndex((result) => result.response.status === 200);
const loserIndex = differentResults.findIndex((result) => result.response.status === 409);
assert(winnerIndex >= 0 && loserIndex >= 0 && winnerIndex !== loserIndex, "different-body-one-winner-one-conflict");
const winner = differentResults[winnerIndex];
const loser = differentResults[loserIndex];
SponsorCredentialRevokeResponseSchema.parse(winner.payload);
expectProblem(loser, 409, "IDEMPOTENCY_CONFLICT");
const winnerReplay = await sponsorRequest(
  sponsorA,
  "POST",
  "/v1/fellows/credentials/revoke",
  "/v1/fellows/credentials/revoke",
  "fellow.credential.revoke",
  differentBodies[winnerIndex].body,
  differentKey,
);
assert(winnerReplay.response.status === 200, "different-body-winner-replay-status");
assert(winnerReplay.text === winner.text, "different-body-winner-exact-replay");
const loserReplay = await sponsorRequest(
  sponsorA,
  "POST",
  "/v1/fellows/credentials/revoke",
  "/v1/fellows/credentials/revoke",
  "fellow.credential.revoke",
  differentBodies[loserIndex].body,
  differentKey,
);
expectProblem(loserReplay, 409, "IDEMPOTENCY_CONFLICT");
await assertTokenRejected(differentBodies[winnerIndex].flow.token, "different-body-winner-revoked");
const survivingHello = await boundedFetch(`${origin}/v1/hello`, {
  headers: { authorization: `Bearer ${differentBodies[loserIndex].flow.token}` },
});
assert(survivingHello.status === 200, "different-body-loser-remains-active");
console.log('{"suite":"token-lifecycle-local","assertion":"concurrent_http_same_key_different_body_one_commit_one_conflict","deterministic_barrier":true,"store_gate":"after_replay_preflight_before_d1_revoke","status":"pass"}');

const panic = await sponsorRequest(
  sponsorA,
  "POST",
  "/v1/sponsors/panic",
  "/v1/sponsors/panic",
  "sponsor.panic",
  { confirm: "revoke-all-fellow-credentials", step_up_authenticated_at: stepUp() },
  key("panic"),
);
assert(panic.response.status === 200, "panic");
SponsorPanicResponseSchema.parse(panic.payload);
const afterPanic = await sponsorRequest(
  sponsorA,
  "GET",
  "/v1/fellows",
  "/v1/fellows",
  "fellows.list",
);
assert(afterPanic.response.status === 200, "fellows-after-panic");
const afterPanicFellows = SponsorFellowListResponseSchema.parse(afterPanic.payload);
assert(
  afterPanicFellows.fellows.flatMap((fellow) => fellow.credentials).every((credential) => !credential.active),
  "panic-leaves-no-active-minted-credential",
);

console.log('{"suite":"token-lifecycle-local","assertion":"mint_use_scope_refusal_active_cap_expiry_individual_revoke_panic_zero_active_credentials_cross_principal_exact_replay","status":"pass"}');
console.log('{"suite":"token-lifecycle-local","assertion":"revoke_vs_effectful_domain_write","status":"blocked","code":"W4_FELLOW_MUTATION_NOT_IMPLEMENTED","detail":"No production Fellow mutation is mounted; hello only proves after-revoke opaque 401."}');
BUN

require_remaining
TOKEN_LIFECYCLE_ORIGIN="${ORIGIN}" TOKEN_LIFECYCLE_PRIVATE_JWK="${PRIVATE_JWK}" \
  TOKEN_LIFECYCLE_BARRIER_CAPABILITY="${BARRIER_CAPABILITY}" \
  TOKEN_LIFECYCLE_AUTHZ_EVIDENCE_CANARY="${LOG_CANARY_BEARER}" \
  TOKEN_LIFECYCLE_HTTP_TIMEOUT_MS="${HTTP_TIMEOUT_MS}" \
  "${BUN}" --eval "${CLIENT_SOURCE}" \
  >"${CLIENT_LOG}" 2>"${CLIENT_ERROR_LOG}" || { fail "TOKEN_LIFECYCLE_HTTP_PROOF_FAILED"; exit 1; }
cat "${CLIENT_LOG}"
if [[ "${TOKEN_LIFECYCLE_TEST_LOG_LEAK:-0}" == "1" ]]; then
  printf '%s\n' "${LOG_CANARY_BEARER}" >>"${CLIENT_ERROR_LOG}"
fi
assert_responder_identity || exit 1

stop_worker || exit 1
assert_post_stop_d1_counts || exit 1
scan_retained_logs || exit 1
assert_source_closure_unchanged || exit 1
emit "{\"suite\":\"${SUITE}\",\"status\":\"pass\",\"code\":\"TOKEN_LIFECYCLE_LOCAL_PASSED\",\"reproduce\":\"${REPRODUCE}\"}"
