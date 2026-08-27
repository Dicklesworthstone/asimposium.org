#!/usr/bin/env bash
# W3.7 Fellow-token lifecycle plus W4 session replay atomicity proof
# (beads asimposiumorg-9p4 and asimposiumorg-zdz.2).
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
readonly CLEANUP_GRACE_SECONDS=15
readonly SCRIPT_DEADLINE=$((SECONDS + TOTAL_DEADLINE_SECONDS))
readonly HTTP_TIMEOUT_MS=8000
readonly SESSION_PROBLEM_ID="P-TOKENLIFECYCLE"
readonly PACK_MEASUREMENT_PROBLEM_ID="P-PACKMEASURE"
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
  "0017_sessions_workshop_cursor.sql"
  "0018_session_write_replays.sql"
  "0019_problem_memberships.sql"
  "0020_session_replay_atomic_claim.sql"
  "0021_problem_scoped_claim_identity.sql"
  "0022_workshop_cas_spill.sql"
  "0023_claim_versions_deps.sql"
  "0024_reviews.sql"
  "0025_hypotheses.sql"
  "0026_evidence.sql"
  "0027_w58_remaining_objects.sql"
  "0028_event_attribution.sql"
  "0029_claim_norm_hash.sql"
  "0030_claim_dep_fk_parent_repair.sql"
  "0031_revise_replay_scope.sql"
  "0032_claim_deps_anchor_claims.sql"
  "0033_proof_gaps_fable_shape.sql"
  "0034_gaps_replay_scope.sql"
  "0035_claim_relations.sql"
  "0036_relations_replay_scope.sql"
  "0037_session_open_cap.sql"
  "0038_events_writer_credential.sql"
  "0039_krater_chain_v2.sql"
  "0040_krater_chain_v2_contiguity.sql"
  "0041_ledger_write_atomicity.sql"
)

STATE_DIR=""
PROBE_DIR=""
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
SERVER_SUPERVISOR_FAULT=""
SERVER_SUPERVISOR_RETIREMENT=""
SERVER_SUPERVISOR_LEASE=""
SERVER_SUPERVISOR_LEASE_FD=""
SERVER_TARGET_GATE_OPENED=0
SUPERVISOR_PLANT_DIRECT_PID=""
SUPERVISOR_PLANT_DESCENDANT_PID=""
SUPERVISOR_PLANT_DIRECT_IDENTITY=""
SUPERVISOR_PLANT_DESCENDANT_IDENTITY=""
RESPONDER_PID=""
RESPONDER_IDENTITY=""
BUSY_PORT_PID=""
BUSY_PORT_IDENTITY=""
BUSY_PORT_MARKER=""
PLANTED_DETACHED_PID=""
PLANTED_DETACHED_IDENTITY=""
PLANTED_DETACHED_MARKER=""
AUX_REUSE_PID=""
AUX_REUSE_IDENTITY=""
AUX_REUSE_MARKER=""
STATE_CENSUS_NONCE=""
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

# This verifier is intentionally dependency-free so the ordinary unit
# self-test can exercise exactly the same post-panic completeness and token
# rejection seam as the local Workerd/D1 client. Its callbacks carry all I/O;
# the returned terminal record is count-only.
PANIC_COVERAGE_VERIFIER_SOURCE=""
read -r -d '' PANIC_COVERAGE_VERIFIER_SOURCE <<'BUN' || true
type PanicCoverageFellow = {
  readonly fellow_id: string;
  readonly credentials: readonly {
    readonly credential_id: string;
    readonly active: boolean;
  }[];
};

type PanicCoverageRegistryEntry = {
  readonly label: string;
  readonly fellowId: string;
  /** Sponsor inventory hides individually revoked and expired credentials. */
  readonly beforePanicCredentialCardinality: 0 | 1;
};

type PanicCoverageCredentialExpectation = PanicCoverageRegistryEntry & {
  readonly credentialId: string;
};

type PanicCoverageActiveToken = {
  readonly label: string;
  readonly fellowId: string;
  readonly credentialId: string;
  readonly token: string;
};

type PanicCoverageTokenRejection = {
  readonly label: string;
  readonly status: number;
  readonly code: string;
};

function panicCoverageAssert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

function exactPanicCoverageFellow(
  fellows: readonly PanicCoverageFellow[],
  expected: PanicCoverageRegistryEntry,
  phase: "before" | "after",
): PanicCoverageFellow {
  const matches = fellows.filter((candidate) => candidate.fellow_id === expected.fellowId);
  panicCoverageAssert(matches.length === 1, `panic-${phase}-fellow-present-once-${expected.label}`);
  const fellow = matches[0];
  panicCoverageAssert(fellow !== undefined, `panic-${phase}-fellow-present-${expected.label}`);
  return fellow;
}

async function verifyPanicCoverage(input: {
  readonly registry: readonly PanicCoverageRegistryEntry[];
  readonly beforePanicFellows: readonly PanicCoverageFellow[];
  readonly prePanicActiveTokens: readonly PanicCoverageActiveToken[];
  readonly assertTokenActive: (token: PanicCoverageActiveToken) => Promise<{ readonly fellowId: string }>;
  readonly runPanic: () => Promise<void>;
  readonly readAfterPanicFellows: () => Promise<readonly PanicCoverageFellow[]>;
  readonly assertTokenRejected: (
    token: PanicCoverageActiveToken,
  ) => Promise<PanicCoverageTokenRejection>;
}): Promise<{
  readonly known_fellows: number;
  /** One credential was minted for each registry flow; this is not a current listing count. */
  readonly known_credentials: number;
  readonly pre_panic_visible_credentials: number;
  readonly pre_panic_active_tokens: number;
  readonly post_panic_rejected_tokens: number;
}> {
  panicCoverageAssert(input.registry.length === 5, "panic-registry-exactly-five-fellows");
  panicCoverageAssert(
    new Set(input.registry.map((entry) => entry.label)).size === input.registry.length,
    "panic-registry-labels-unique",
  );
  panicCoverageAssert(
    new Set(input.registry.map((entry) => entry.fellowId)).size === input.registry.length,
    "panic-registry-fellows-unique",
  );
  const expectedCredentials: PanicCoverageCredentialExpectation[] = [];
  for (const expected of input.registry) {
    const fellow = exactPanicCoverageFellow(input.beforePanicFellows, expected, "before");
    panicCoverageAssert(
      fellow.credentials.length === expected.beforePanicCredentialCardinality,
      `panic-before-credential-cardinality-${expected.label}`,
    );
    if (expected.beforePanicCredentialCardinality === 0) continue;
    const credential = fellow.credentials[0];
    panicCoverageAssert(credential !== undefined, `panic-before-credential-present-${expected.label}`);
    expectedCredentials.push({ ...expected, credentialId: credential.credential_id });
  }
  panicCoverageAssert(
    new Set(expectedCredentials.map((entry) => entry.credentialId)).size === expectedCredentials.length,
    "panic-registry-credentials-unique",
  );
  panicCoverageAssert(
    input.prePanicActiveTokens.length === expectedCredentials.length,
    "panic-pre-active-token-count-equals-visible-credentials",
  );
  panicCoverageAssert(
    new Set(input.prePanicActiveTokens.map((token) => token.fellowId)).size ===
      input.prePanicActiveTokens.length,
    "panic-pre-active-token-fellows-unique",
  );
  panicCoverageAssert(
    new Set(input.prePanicActiveTokens.map((token) => token.credentialId)).size ===
      input.prePanicActiveTokens.length,
    "panic-pre-active-token-credentials-unique",
  );
  for (const expectedCredential of expectedCredentials) {
    const matchingTokens = input.prePanicActiveTokens.filter(
      (token) =>
        token.fellowId === expectedCredential.fellowId &&
        token.credentialId === expectedCredential.credentialId,
    );
    panicCoverageAssert(
      matchingTokens.length === 1,
      `panic-pre-active-token-exact-visible-credential-${expectedCredential.label}`,
    );
  }

  const prePanicConfirmedTokens: PanicCoverageActiveToken[] = [];
  for (const token of input.prePanicActiveTokens) {
    const registryMatches = input.registry.filter((entry) => entry.fellowId === token.fellowId);
    panicCoverageAssert(
      registryMatches.length === 1,
      `panic-pre-active-fellow-present-once-${token.label}`,
    );
    const active = await input.assertTokenActive(token);
    panicCoverageAssert(
      active.fellowId === token.fellowId,
      `panic-token-active-subject-before-panic-${token.label}`,
    );
    prePanicConfirmedTokens.push(token);
  }

  await input.runPanic();
  const afterPanicFellows = await input.readAfterPanicFellows();
  panicCoverageAssert(
    afterPanicFellows.flatMap((fellow) => fellow.credentials).every((credential) => !credential.active),
    "panic-leaves-no-active-listed-credential",
  );

  const matchedFellows: PanicCoverageFellow[] = [];
  for (const expected of input.registry) {
    const fellow = exactPanicCoverageFellow(afterPanicFellows, expected, "after");
    panicCoverageAssert(
      fellow.credentials.length === 0,
      `panic-after-credential-cardinality-${expected.label}`,
    );
    matchedFellows.push(fellow);
  }

  const rejectedTokens: PanicCoverageTokenRejection[] = [];
  for (const token of prePanicConfirmedTokens) {
    const rejection = await input.assertTokenRejected(token);
    panicCoverageAssert(rejection.label === token.label, `panic-token-rejection-label-${token.label}`);
    panicCoverageAssert(rejection.status === 401, `panic-token-rejection-status-${token.label}`);
    panicCoverageAssert(
      rejection.code === "FELLOW_TOKEN_INVALID",
      `panic-token-rejection-code-${token.label}`,
    );
    rejectedTokens.push(rejection);
  }

  return {
    known_fellows: matchedFellows.length,
    known_credentials: input.registry.length,
    pre_panic_visible_credentials: expectedCredentials.length,
    pre_panic_active_tokens: prePanicConfirmedTokens.length,
    post_panic_rejected_tokens: rejectedTokens.length,
  };
}

function emitPanicCoverage(
  panicCoverage: Awaited<ReturnType<typeof verifyPanicCoverage>>,
): void {
  const { pre_panic_visible_credentials, ...credentialCoverage } = panicCoverage;
  console.log(JSON.stringify({
    suite: "token-lifecycle-local",
    record: "panic-pre-panic-visible-credential-count",
    assertion: "pre_panic_visible_credentials_exactly_equals_active_token_coverage",
    pre_panic_visible_credentials,
    pre_panic_active_tokens: panicCoverage.pre_panic_active_tokens,
    status: "pass",
  }));
  console.log(JSON.stringify({
    suite: "token-lifecycle-local",
    record: "panic-credential-coverage",
    assertion: "panic_complete_known_minted_fellow_credential_coverage_and_pre_panic_active_token_rejection",
    ...credentialCoverage,
    status: "pass",
  }));
}
BUN
readonly PANIC_COVERAGE_VERIFIER_SOURCE

PANIC_COVERAGE_VERIFIER_SELF_TEST_SOURCE=""
read -r -d '' PANIC_COVERAGE_VERIFIER_SELF_TEST_SOURCE <<'BUN' || true
const selfTestRegistry = [
  { label: "alpha", fellowId: "self-fellow-alpha", beforePanicCredentialCardinality: 0 },
  { label: "expiring", fellowId: "self-fellow-expiring", beforePanicCredentialCardinality: 0 },
  { label: "charlie", fellowId: "self-fellow-charlie", beforePanicCredentialCardinality: 0 },
  { label: "delta", fellowId: "self-fellow-delta", beforePanicCredentialCardinality: 1 },
  { label: "echo", fellowId: "self-fellow-echo", beforePanicCredentialCardinality: 1 },
] as const satisfies readonly PanicCoverageRegistryEntry[];
const selfTestBefore = selfTestRegistry.map((entry) => ({
  fellow_id: entry.fellowId,
  credentials:
    entry.beforePanicCredentialCardinality === 0
      ? []
      : [{ credential_id: `self-credential-${entry.label}`, active: true }],
}));
const selfTestAfterPanic = selfTestBefore.map((fellow) => ({
  fellow_id: fellow.fellow_id,
  credentials: [],
}));
const selfTestAfterPanicWithVisibleCredential = selfTestAfterPanic.map((fellow) =>
  fellow.fellow_id === "self-fellow-delta"
    ? {
        ...fellow,
        credentials: [{ credential_id: "self-unsafe-visible-after-panic", active: false }],
      }
    : fellow,
);
const selfTestPrePanicActiveTokens = [
  {
    label: "echo",
    fellowId: "self-fellow-echo",
    credentialId: "self-credential-echo",
    token: "self-test-token-echo",
  },
  {
    label: "delta",
    fellowId: "self-fellow-delta",
    credentialId: "self-credential-delta",
    token: "self-test-token-delta",
  },
] as const satisfies readonly PanicCoverageActiveToken[];
const selfTestControl = process.env.TOKEN_LIFECYCLE_TEST_PANIC_OMIT_AFTER_ROW === "1"
  ? "omit-after-row"
  : process.env.TOKEN_LIFECYCLE_TEST_PANIC_REJECTION_NOOP === "1"
    ? "token-rejection-noop"
    : "none";
const panicCoverage = await verifyPanicCoverage({
  registry: selfTestRegistry,
  beforePanicFellows: selfTestBefore,
  prePanicActiveTokens: selfTestPrePanicActiveTokens,
  assertTokenActive: async (token) => ({ fellowId: token.fellowId }),
  runPanic: async () => {},
  readAfterPanicFellows: async () => {
    const rows = selfTestAfterPanic;
    if (selfTestControl === "omit-after-row") {
      const omitted = selfTestRegistry.at(-1);
      if (omitted === undefined) throw new Error("panic-self-test-registry-empty");
      return rows.filter((fellow) => fellow.fellow_id !== omitted.fellowId);
    }
    return rows;
  },
  assertTokenRejected: async (token) => {
    if (selfTestControl === "token-rejection-noop") {
      return undefined as unknown as PanicCoverageTokenRejection;
    }
    return { label: token.label, status: 401, code: "FELLOW_TOKEN_INVALID" };
  },
});
let afterVisibleCredentialControlRejected = false;
try {
  await verifyPanicCoverage({
    registry: selfTestRegistry,
    beforePanicFellows: selfTestBefore,
    prePanicActiveTokens: selfTestPrePanicActiveTokens,
    assertTokenActive: async (token) => ({ fellowId: token.fellowId }),
    runPanic: async () => {},
    readAfterPanicFellows: async () => selfTestAfterPanicWithVisibleCredential,
    assertTokenRejected: async (token) => ({
      label: token.label,
      status: 401,
      code: "FELLOW_TOKEN_INVALID",
    }),
  });
} catch (error) {
  afterVisibleCredentialControlRejected =
    error instanceof Error && error.message === "panic-after-credential-cardinality-delta";
}
panicCoverageAssert(
  afterVisibleCredentialControlRejected,
  "panic-self-test-after-visible-credential-control-rejected",
);
let omittedActiveTokenControlRejected = false;
try {
  await verifyPanicCoverage({
    registry: selfTestRegistry,
    beforePanicFellows: selfTestBefore,
    prePanicActiveTokens: selfTestPrePanicActiveTokens.filter((token) => token.label !== "delta"),
    assertTokenActive: async (token) => ({ fellowId: token.fellowId }),
    runPanic: async () => {},
    readAfterPanicFellows: async () => selfTestAfterPanic,
    assertTokenRejected: async (token) => ({
      label: token.label,
      status: 401,
      code: "FELLOW_TOKEN_INVALID",
    }),
  });
} catch (error) {
  omittedActiveTokenControlRejected =
    error instanceof Error &&
    error.message === "panic-pre-active-token-count-equals-visible-credentials";
}
panicCoverageAssert(
  omittedActiveTokenControlRejected,
  "panic-self-test-omitted-active-token-control-rejected",
);
emitPanicCoverage(panicCoverage);
BUN
readonly PANIC_COVERAGE_VERIFIER_SELF_TEST_SOURCE

run_panic_coverage_verifier_self_test() {
  local output
  output="$("${BUN}" --eval "${PANIC_COVERAGE_VERIFIER_SOURCE}"$'\n'"${PANIC_COVERAGE_VERIFIER_SELF_TEST_SOURCE}")" || {
    fail "TOKEN_LIFECYCLE_PANIC_VERIFIER_SELF_TEST_FAILED"
    return 1
  }
  emit "${output}"
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
    TOKEN_LIFECYCLE_EXPECTED_MIGRATIONS="${EXPECTED_MIGRATIONS[*]}" \
    "${BUN}" --eval '
      import { existsSync, readdirSync, readFileSync } from "node:fs";
      import { dirname, extname, relative, resolve } from "node:path";

      const root = process.env.TOKEN_LIFECYCLE_CLOSURE_ROOT;
      if (root === undefined) throw new Error("closure root unavailable");
      const expectedMigrationRecord = process.env.TOKEN_LIFECYCLE_EXPECTED_MIGRATIONS;
      if (expectedMigrationRecord === undefined) throw new Error("migration closure unavailable");
      const migrations = expectedMigrationRecord.split(" ");
      if (
        migrations.length === 0 ||
        migrations.some((name) => !/^\d{4}_[a-z0-9_]+\.sql$/.test(name)) ||
        new Set(migrations).size !== migrations.length
      ) {
        throw new Error("migration closure invalid");
      }
      const migrationDirectory = resolve(root, "db/migrations");
      const discovered = readdirSync(migrationDirectory)
        .filter((name) => /^\d{4}_.+\.sql$/.test(name))
        .sort();
      if (JSON.stringify(discovered) !== JSON.stringify(migrations)) {
        throw new Error("migration closure does not match the expected journal");
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

cleanup_group_members() {
  # This deliberately fallible census is diagnostic only. The planted empty
  # result proves that cleanup never treats an exit-zero/truncated ps snapshot
  # as evidence that a process group disappeared.
  [[ "${TOKEN_LIFECYCLE_TEST_CLEANUP_CENSUS_PARTIAL:-0}" != "1" ]] || return 0
  group_members "$1"
}

signal_probe_state() {
  local target="$1" diagnostic status
  if diagnostic="$(LC_ALL=C /bin/kill -0 "${target}" 2>&1)"; then
    printf '%s\n' "live"
    return 0
  else
    status=$?
  fi
  if (( status == 1 )) && [[ "${diagnostic}" == *"No such process"* ]]; then
    printf '%s\n' "absent"
    return 0
  fi
  return 1
}

group_liveness() {
  local pgid="$1"
  [[ "${pgid}" =~ ^[0-9]+$ && "${pgid}" != "0" ]] || return 1
  signal_probe_state "-${pgid}"
}

process_liveness() {
  local pid="$1"
  [[ "${pid}" =~ ^[0-9]+$ && "${pid}" != "0" ]] || return 1
  signal_probe_state "${pid}"
}

wait_for_group_absence() {
  local pgid="$1" deadline="$2" state
  while (( SECONDS < deadline )); do
    state="$(group_liveness "${pgid}")" || return 2
    [[ "${state}" != "absent" ]] || return 0
    sleep 0.05
  done
  state="$(group_liveness "${pgid}")" || return 2
  [[ "${state}" == "absent" ]]
}

wait_for_process_absence() {
  local pid="$1" deadline="$2" state
  while (( SECONDS < deadline )); do
    state="$(process_liveness "${pid}")" || return 2
    [[ "${state}" != "absent" ]] || return 0
    sleep 0.05
  done
  state="$(process_liveness "${pid}")" || return 2
  [[ "${state}" == "absent" ]]
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

file_byte_size() {
  local size
  size="$(perl -e 'my $size = -s $ARGV[0]; exit 1 unless defined($size); print $size;' "$1")" || return 1
  [[ "${size}" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "${size}"
}

prepare_probe_files() {
  : >"$1" && : >"$2" && chmod 600 "$1" "$2"
}

listener_pids() {
  local phase="${1:-runtime}" normalized status stderr_bytes stderr_path stdout_bytes stdout_path
  stdout_path="${PROBE_DIR}/listener-probe.stdout"
  stderr_path="${PROBE_DIR}/listener-probe.stderr"
  prepare_probe_files "${stdout_path}" "${stderr_path}" || return 2
  if [[ "${phase}" == "final" \
    && "${TOKEN_LIFECYCLE_TEST_LISTENER_EXIT_ZERO_EMPTY:-0}" == "1" ]]; then
    status=0
  elif [[ "${phase}" == "final" \
    && "${TOKEN_LIFECYCLE_TEST_LISTENER_STDOUT_NEWLINE:-0}" == "1" ]]; then
    printf '\n' >"${stdout_path}"
    status=1
  elif [[ "${phase}" == "final" \
    && "${TOKEN_LIFECYCLE_TEST_LISTENER_STDERR_NEWLINE:-0}" == "1" ]]; then
    printf '\n' >"${stderr_path}"
    status=1
  elif [[ "${phase}" == "final" \
    && "${TOKEN_LIFECYCLE_TEST_LISTENER_DIAGNOSTIC:-0}" == "1" ]]; then
    printf '%s\n' "planted-listener-diagnostic" >"${stderr_path}"
    status=1
  elif "${LSOF}" -nP -iTCP:"${PORT}" -sTCP:LISTEN -t \
    >"${stdout_path}" 2>"${stderr_path}"; then
    status=0
  else
    status=$?
  fi
  stdout_bytes="$(file_byte_size "${stdout_path}")" || return 2
  stderr_bytes="$(file_byte_size "${stderr_path}")" || return 2
  if (( status == 0 )); then
    (( stdout_bytes > 0 && stderr_bytes == 0 )) || return 2
    normalized="$(awk '
      NF != 1 || $1 !~ /^[0-9]+$/ { exit 2 }
      { print $1 }
    ' "${stdout_path}" | sort -n -u)" || return 2
    [[ -n "${normalized}" ]] || return 2
    printf '%s\n' "${normalized}"
    return 0
  fi
  [[ "${status}" == "1" && "${stdout_bytes}" == "0" && "${stderr_bytes}" == "0" ]] || return 2
  return 1
}

bounded_process_snapshot() {
  local budget remaining
  remaining="$(remaining_seconds)" || return 1
  budget=2
  (( remaining < budget )) && budget="${remaining}"
  TOKEN_LIFECYCLE_PS_BUDGET="${budget}" \
    TOKEN_LIFECYCLE_STATE_CENSUS_NONCE="${STATE_CENSUS_NONCE}" \
    TOKEN_LIFECYCLE_CONTROLLER_PID="$$" \
    TOKEN_LIFECYCLE_CONTROLLER_PGID="${CONTROLLER_PGID}" \
    TOKEN_LIFECYCLE_TEST_STATE_CENSUS_PARTIAL="${TOKEN_LIFECYCLE_TEST_STATE_CENSUS_PARTIAL:-0}" \
    perl -MDigest::SHA=sha256_hex -e '
    my $child = open(my $processes, "-|", "/bin/ps", "-eo", "pid=,pgid=,command=");
    exit 2 unless defined($child) && $child > 0;
    my $retire_capture = sub {
      my ($code) = @_;
      kill "KILL", $child;
      waitpid($child, 0);
      exit $code;
    };
    $SIG{"ALRM"} = sub { $retire_capture->(124); };
    alarm(int($ENV{"TOKEN_LIFECYCLE_PS_BUDGET"}));
    my @lines;
    my $bytes = 0;
    while (my $line = <$processes>) {
      $bytes += length($line);
      $retire_capture->(125) if $bytes > 4_194_304 || @lines >= 100_000;
      push @lines, $line;
    }
    close($processes) or exit 3;
    alarm(0);
    my $nonce = $ENV{"TOKEN_LIFECYCLE_STATE_CENSUS_NONCE"};
    print "TOKEN_LIFECYCLE_STATE_CENSUS_V1_BEGIN\t$nonce\n";
    if ($ENV{"TOKEN_LIFECYCLE_TEST_STATE_CENSUS_PARTIAL"} eq "1") {
      my $wanted_pid = $ENV{"TOKEN_LIFECYCLE_CONTROLLER_PID"};
      my $wanted_pgid = $ENV{"TOKEN_LIFECYCLE_CONTROLLER_PGID"};
      for my $line (@lines) {
        if ($line =~ /^\s*(\d+)\s+(\d+)\s+/ && $1 eq $wanted_pid && $2 eq $wanted_pgid) {
          print $line;
          exit 0;
        }
      }
      exit 4;
    }
    print @lines;
    print join("\t", "TOKEN_LIFECYCLE_STATE_CENSUS_V1_END", $nonce, scalar(@lines), sha256_hex(join("", @lines))) . "\n";
  '
}

state_owned_processes() {
  local snapshot
  [[ -n "${STATE_DIR}" ]] || return 0
  snapshot="$(bounded_process_snapshot)" || return 1
  TOKEN_LIFECYCLE_STATE_SCAN="${STATE_DIR}" \
    TOKEN_LIFECYCLE_STATE_CENSUS_NONCE="${STATE_CENSUS_NONCE}" \
    TOKEN_LIFECYCLE_CONTROLLER_PID="$$" \
    TOKEN_LIFECYCLE_CONTROLLER_PGID="${CONTROLLER_PGID}" \
    perl -MDigest::SHA=sha256_hex -e '
      my @framed = <STDIN>;
      exit 2 if @framed < 2;
      my $begin = shift @framed;
      my $end = pop @framed;
      chomp($begin, $end);
      my $nonce = $ENV{"TOKEN_LIFECYCLE_STATE_CENSUS_NONCE"};
      exit 3 unless $begin eq "TOKEN_LIFECYCLE_STATE_CENSUS_V1_BEGIN\t$nonce";
      my ($marker, $seen_nonce, $seen_rows, $seen_digest, @extra) = split(/\t/, $end, -1);
      exit 4 unless $marker eq "TOKEN_LIFECYCLE_STATE_CENSUS_V1_END" &&
        $seen_nonce eq $nonce && $seen_rows =~ /^\d+$/ && $seen_rows == @framed &&
        $seen_digest eq sha256_hex(join("", @framed)) && @extra == 0;
      my $controller_rows = 0;
      my $wanted_pid = $ENV{"TOKEN_LIFECYCLE_CONTROLLER_PID"};
      my $wanted_pgid = $ENV{"TOKEN_LIFECYCLE_CONTROLLER_PGID"};
      for my $line (@framed) {
        next unless $line =~ /^\s*(\d+)\s+(\d+)\s+/;
        $controller_rows += 1 if $1 eq $wanted_pid && $2 eq $wanted_pgid;
        print "$1 $2\n" if index($line, $ENV{"TOKEN_LIFECYCLE_STATE_SCAN"}) >= 0;
      }
      exit 5 unless $controller_rows == 1;
    ' <<<"${snapshot}"
}

state_fds_are_closed() {
  [[ -n "${STATE_DIR}" ]] || return 0
  local status stderr_bytes stderr_path stdout_bytes stdout_path
  stdout_path="${PROBE_DIR}/state-fd.stdout"
  stderr_path="${PROBE_DIR}/state-fd.stderr"
  prepare_probe_files "${stdout_path}" "${stderr_path}" || return 2
  if "${LSOF}" +D "${STATE_DIR}" >"${stdout_path}" 2>"${stderr_path}"; then
    status=0
  else
    status=$?
  fi
  stdout_bytes="$(file_byte_size "${stdout_path}")" || return 2
  stderr_bytes="$(file_byte_size "${stderr_path}")" || return 2
  if (( status == 0 )); then
    (( stdout_bytes > 0 && stderr_bytes == 0 )) || return 2
    return 1
  fi
  [[ "${status}" == "1" && "${stdout_bytes}" == "0" && "${stderr_bytes}" == "0" ]] || return 2
  return 0
}

port_is_free() {
  local phase="${1:-runtime}" status
  if listener_pids "${phase}" >/dev/null; then
    return 1
  else
    status=$?
  fi
  [[ "${status}" == "1" ]] || return 2
  return 0
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
}

responder_identity_is_current() {
  local listeners
  [[ -n "${RESPONDER_PID}" && -n "${RESPONDER_IDENTITY}" ]] || return 1
  [[ "$(process_identity "${RESPONDER_PID}")" == "${RESPONDER_IDENTITY}" ]] || return 1
  listeners="$(listener_pids)" || return 1
  [[ "${listeners}" == "${RESPONDER_PID}" ]] || return 1
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

capture_auxiliary_identity() {
  local pid="$1" marker="$2" deadline identity seen_pid
  deadline=$((SECONDS + 2))
  (( deadline > SCRIPT_DEADLINE )) && deadline="${SCRIPT_DEADLINE}"
  while (( SECONDS < deadline )); do
    identity="$(raw_process_identity "${pid}" 2>/dev/null || true)"
    if [[ -n "${identity}" && "${identity}" == *"${marker}"* ]]; then
      IFS=$'\t' read -r seen_pid _ _ _ <<<"${identity}"
      if [[ "${seen_pid}" == "${pid}" ]]; then
        printf '%s\n' "${identity}"
        return 0
      fi
    fi
    sleep 0.01
  done
  return 1
}

stop_auxiliary_child() {
  local pid="$1" label="$2" expected_identity="$3" marker="$4"
  local current deadline state wait_status
  [[ -n "${pid}" ]] || return 0
  state="$(process_liveness "${pid}")" || {
    fail "TOKEN_LIFECYCLE_${label}_LIVENESS_UNPROVEN"
    return 1
  }
  if [[ "${state}" == "absent" ]]; then
    wait "${pid}" 2>/dev/null || true
    return 0
  fi

  current="$(raw_process_identity "${pid}" 2>/dev/null || true)"
  # A start-up proof failure may reach the trap before the caller publishes
  # the full identity. The private argv nonce is then the only provisional
  # authority; pin the complete identity once and use it for both signals.
  if [[ -z "${expected_identity}" && -n "${current}" && "${current}" == *"${marker}"* ]]; then
    expected_identity="${current}"
  fi
  if [[ -z "${expected_identity}" \
    || "${current}" != "${expected_identity}" \
    || "${current}" != *"${marker}"* ]]; then
    fail "TOKEN_LIFECYCLE_${label}_IDENTITY_DRIFT"
    return 1
  fi

  if ! kill -TERM "${pid}" 2>/dev/null; then
    state="$(process_liveness "${pid}")" || {
      fail "TOKEN_LIFECYCLE_${label}_LIVENESS_UNPROVEN"
      return 1
    }
    [[ "${state}" == "absent" ]] || {
      fail "TOKEN_LIFECYCLE_${label}_TERM_UNDELIVERED"
      return 1
    }
  fi
  deadline=$((SECONDS + CLEANUP_GRACE_SECONDS))
  (( deadline > SCRIPT_DEADLINE )) && deadline="${SCRIPT_DEADLINE}"
  if wait_for_process_absence "${pid}" "${deadline}"; then
    wait "${pid}" 2>/dev/null || true
    return 0
  else
    wait_status=$?
  fi
  (( wait_status != 2 )) || {
    fail "TOKEN_LIFECYCLE_${label}_LIVENESS_UNPROVEN"
    return 1
  }

  current="$(raw_process_identity "${pid}" 2>/dev/null || true)"
  if [[ "${current}" != "${expected_identity}" || "${current}" != *"${marker}"* ]]; then
    fail "TOKEN_LIFECYCLE_${label}_IDENTITY_DRIFT"
    return 1
  fi
  kill -KILL "${pid}" 2>/dev/null || {
    state="$(process_liveness "${pid}")" || {
      fail "TOKEN_LIFECYCLE_${label}_LIVENESS_UNPROVEN"
      return 1
    }
    [[ "${state}" == "absent" ]] || {
      fail "TOKEN_LIFECYCLE_${label}_KILL_UNDELIVERED"
      return 1
    }
  }
  deadline=$((SECONDS + CLEANUP_GRACE_SECONDS))
  (( deadline > SCRIPT_DEADLINE )) && deadline="${SCRIPT_DEADLINE}"
  if wait_for_process_absence "${pid}" "${deadline}"; then
    wait "${pid}" 2>/dev/null || true
    return 0
  else
    wait_status=$?
  fi
  (( wait_status != 2 )) || {
    fail "TOKEN_LIFECYCLE_${label}_LIVENESS_UNPROVEN"
    return 1
  }
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
  emit "{\"suite\":\"${SUITE}\",\"assertion\":\"d1_migrations_exact_0001_through_0041\",\"status\":\"pass\"}"
}

seed_session_problem() {
  local genesis pack_genesis now
  genesis="$(TOKEN_LIFECYCLE_SESSION_PROBLEM_ID="${SESSION_PROBLEM_ID}" "${BUN}" --eval '
    import { genesisChainDigest } from "./apps/wire/src/krater/krater.ts";
    const problemId = process.env.TOKEN_LIFECYCLE_SESSION_PROBLEM_ID;
    if (problemId === undefined) process.exit(1);
    console.log(await genesisChainDigest(problemId));
  ')" || {
    fail "TOKEN_LIFECYCLE_SESSION_GENESIS_UNAVAILABLE"
    return 1
  }
  [[ "${genesis}" =~ ^[a-f0-9]{64}$ ]] || {
    fail "TOKEN_LIFECYCLE_SESSION_GENESIS_INVALID"
    return 1
  }
  pack_genesis="$(TOKEN_LIFECYCLE_SESSION_PROBLEM_ID="${PACK_MEASUREMENT_PROBLEM_ID}" "${BUN}" --eval '
    import { genesisChainDigest } from "./apps/wire/src/krater/krater.ts";
    const problemId = process.env.TOKEN_LIFECYCLE_SESSION_PROBLEM_ID;
    if (problemId === undefined) process.exit(1);
    console.log(await genesisChainDigest(problemId));
  ')" || {
    fail "TOKEN_LIFECYCLE_PACK_MEASUREMENT_GENESIS_UNAVAILABLE"
    return 1
  }
  [[ "${pack_genesis}" =~ ^[a-f0-9]{64}$ ]] || {
    fail "TOKEN_LIFECYCLE_PACK_MEASUREMENT_GENESIS_INVALID"
    return 1
  }
  now="$("${BUN}" --eval 'console.log(new Date().toISOString())')"
  [[ "${now}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$ ]] || {
    fail "TOKEN_LIFECYCLE_SESSION_TIME_INVALID"
    return 1
  }
  "${WRANGLER}" d1 execute DB --config "${CONFIG}" --local --persist-to "${STATE_DIR}" \
    --command "INSERT INTO problems (id, public_seq, created_at, updated_at, chain_digest, chain_version) VALUES ('${SESSION_PROBLEM_ID}', 0, '${now}', '${now}', '${genesis}', 2); INSERT INTO krater_integrity_backfill (problem_id, state, legacy_event_count, completed_at, chain_version) VALUES ('${SESSION_PROBLEM_ID}', 'complete', 0, '${now}', 2); INSERT INTO problems (id, public_seq, created_at, updated_at, chain_digest, chain_version) VALUES ('${PACK_MEASUREMENT_PROBLEM_ID}', 130, '${now}', '${now}', '${pack_genesis}', 2); INSERT INTO krater_integrity_backfill (problem_id, state, legacy_event_count, completed_at, chain_version) VALUES ('${PACK_MEASUREMENT_PROBLEM_ID}', 'complete', 0, '${now}', 2); WITH RECURSIVE claim_numbers(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM claim_numbers WHERE value < 130) INSERT INTO claims (id, problem_id, statement, payload_sha256, source_seq, created_at) SELECT 'C-' || value, '${PACK_MEASUREMENT_PROBLEM_ID}', 'pack-measurement-' || value, printf('%064x', value), value, '${now}' FROM claim_numbers;" \
    --json >"${SESSION_SEED_LOG}" 2>"${SESSION_SEED_ERROR_LOG}" || {
    fail "TOKEN_LIFECYCLE_SESSION_SEED_FAILED"
    return 1
  }
  emit "{\"suite\":\"${SUITE}\",\"assertion\":\"real_d1_session_and_130_claim_pack_measurement_problems_seeded\",\"status\":\"pass\"}"
}

assert_post_stop_d1_counts() {
  "${WRANGLER}" d1 execute DB --config "${CONFIG}" --local --persist-to "${STATE_DIR}" \
    --command "SELECT (SELECT COUNT(*) FROM fellow_lifecycle_events WHERE action = 'credential-revoked') AS credential_revoked_events, (SELECT COUNT(*) FROM enrollment_idempotency WHERE scope = 'credential-revoke') AS credential_replays, (SELECT COUNT(*) FROM sessions WHERE problem_id = '${SESSION_PROBLEM_ID}') AS session_rows, (SELECT COUNT(*) FROM sessions WHERE problem_id = '${SESSION_PROBLEM_ID}' AND closed_at IS NOT NULL) AS closed_session_rows, (SELECT COUNT(*) FROM workshop_objects WHERE problem_id = '${SESSION_PROBLEM_ID}') AS workshop_rows, (SELECT COUNT(*) FROM session_write_replays WHERE scope IN ('session_open', 'workshop_push', 'promote', 'session_close')) AS session_replays, (SELECT COUNT(*) FROM session_write_replays WHERE scope = 'session_open' AND claim_token IS NOT NULL AND principal_scope = (SELECT fellow_id FROM sessions WHERE problem_id = '${SESSION_PROBLEM_ID}')) AS session_open_replays, (SELECT COUNT(*) FROM session_write_replays WHERE scope = 'workshop_push' AND claim_token IS NOT NULL AND principal_scope = (SELECT fellow_id FROM sessions WHERE problem_id = '${SESSION_PROBLEM_ID}')) AS workshop_push_replays, (SELECT COUNT(*) FROM session_write_replays WHERE scope = 'promote' AND claim_token IS NOT NULL AND principal_scope = (SELECT fellow_id FROM sessions WHERE problem_id = '${SESSION_PROBLEM_ID}')) AS promote_replays, (SELECT COUNT(*) FROM session_write_replays WHERE scope = 'session_close' AND claim_token IS NOT NULL AND principal_scope = (SELECT fellow_id FROM sessions WHERE problem_id = '${SESSION_PROBLEM_ID}')) AS session_close_replays, (SELECT COUNT(*) FROM claims WHERE problem_id = '${SESSION_PROBLEM_ID}') AS claim_rows, (SELECT COUNT(*) FROM claim_projections WHERE problem_id = '${SESSION_PROBLEM_ID}') AS claim_projection_rows, (SELECT COUNT(*) FROM events WHERE problem_id = '${SESSION_PROBLEM_ID}') AS event_rows, (SELECT COUNT(*) FROM event_content WHERE event_id IN (SELECT id FROM events WHERE problem_id = '${SESSION_PROBLEM_ID}')) AS event_content_rows, (SELECT COUNT(*) FROM idempotency WHERE problem_id = '${SESSION_PROBLEM_ID}') AS claim_idempotency_rows, (SELECT COUNT(*) FROM outbox WHERE problem_id = '${SESSION_PROBLEM_ID}') AS outbox_rows, (SELECT COUNT(*) FROM integrity_checkpoints WHERE problem_id = '${SESSION_PROBLEM_ID}') AS checkpoint_rows, (SELECT COUNT(*) FROM public_claim_fts WHERE problem_id = '${SESSION_PROBLEM_ID}') AS fts_rows, (SELECT session_id FROM sessions WHERE problem_id = '${SESSION_PROBLEM_ID}') AS session_id, (SELECT workshop_id FROM workshop_objects WHERE problem_id = '${SESSION_PROBLEM_ID}') AS workshop_id, (SELECT id FROM claims WHERE problem_id = '${SESSION_PROBLEM_ID}') AS claim_id, (SELECT source_seq FROM claims WHERE problem_id = '${SESSION_PROBLEM_ID}') AS claim_source_seq, (SELECT claim_id FROM claim_projections WHERE problem_id = '${SESSION_PROBLEM_ID}') AS projection_claim_id, (SELECT source_seq FROM claim_projections WHERE problem_id = '${SESSION_PROBLEM_ID}') AS projection_source_seq, (SELECT id FROM events WHERE problem_id = '${SESSION_PROBLEM_ID}') AS event_id, (SELECT object_id FROM events WHERE problem_id = '${SESSION_PROBLEM_ID}') AS event_claim_id, (SELECT seq FROM events WHERE problem_id = '${SESSION_PROBLEM_ID}') AS event_seq, (SELECT event_id FROM event_content WHERE event_id IN (SELECT id FROM events WHERE problem_id = '${SESSION_PROBLEM_ID}')) AS event_content_event_id, (SELECT event_id FROM idempotency WHERE problem_id = '${SESSION_PROBLEM_ID}') AS idempotency_event_id, (SELECT event_id FROM outbox WHERE problem_id = '${SESSION_PROBLEM_ID}') AS outbox_event_id, (SELECT checkpoint_seq FROM integrity_checkpoints WHERE problem_id = '${SESSION_PROBLEM_ID}') AS checkpoint_seq, (SELECT claim_id FROM public_claim_fts WHERE problem_id = '${SESSION_PROBLEM_ID}') AS fts_claim_id, (SELECT public_seq FROM problems WHERE id = '${SESSION_PROBLEM_ID}') AS public_seq, (SELECT cursor FROM public_cursor WHERE singleton = 1) AS public_cursor" \
    --json >"${POST_STOP_D1_LOG}" 2>"${POST_STOP_D1_ERROR_LOG}" || {
      fail "TOKEN_LIFECYCLE_POST_STOP_D1_UNREADABLE"
      return 1
    }
  TOKEN_LIFECYCLE_COUNTS_PATH="${POST_STOP_D1_LOG}" \
    TOKEN_LIFECYCLE_CLIENT_PATH="${CLIENT_LOG}" "${BUN}" --eval '
    import { readFileSync } from "node:fs";
    const payload = JSON.parse(readFileSync(process.env.TOKEN_LIFECYCLE_COUNTS_PATH, "utf8"));
    const clientRecords = readFileSync(process.env.TOKEN_LIFECYCLE_CLIENT_PATH, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const identities = clientRecords.filter(
      (record) => record?.record === "session-replay-durable-identity",
    );
    const identity = identities[0];
    const rows = Array.isArray(payload)
      ? payload.flatMap((entry) => Array.isArray(entry?.results) ? entry.results : [])
      : Array.isArray(payload?.results) ? payload.results : [];
    const row = rows[0];
    if (
      rows.length !== 1 ||
      identities.length !== 1 ||
      JSON.stringify(Object.keys(identity ?? {}).sort()) !==
        JSON.stringify(["claim_id", "record", "seq", "session_id", "status", "suite", "workshop_id"]) ||
      identity?.suite !== "token-lifecycle-local" ||
      identity?.status !== "pass" ||
      typeof identity?.session_id !== "string" ||
      typeof identity?.workshop_id !== "string" ||
      typeof identity?.claim_id !== "string" ||
      !Number.isSafeInteger(identity?.seq) ||
      row?.credential_revoked_events !== 2 ||
      row?.credential_replays !== 2 ||
      row?.session_rows !== 1 ||
      row?.closed_session_rows !== 1 ||
      row?.workshop_rows !== 1 ||
      row?.session_replays !== 6 ||
      row?.session_open_replays !== 1 ||
      row?.workshop_push_replays !== 1 ||
      row?.promote_replays !== 1 ||
      row?.session_close_replays !== 1 ||
      row?.claim_rows !== 1 ||
      row?.claim_projection_rows !== 1 ||
      row?.event_rows !== 1 ||
      row?.event_content_rows !== 1 ||
      row?.claim_idempotency_rows !== 1 ||
      row?.outbox_rows !== 1 ||
      row?.checkpoint_rows !== 1 ||
      row?.fts_rows !== 1 ||
      row?.session_id !== identity.session_id ||
      row?.workshop_id !== identity.workshop_id ||
      row?.claim_id !== identity.claim_id ||
      row?.projection_claim_id !== identity.claim_id ||
      row?.event_claim_id !== identity.claim_id ||
      row?.fts_claim_id !== identity.claim_id ||
      row?.event_content_event_id !== row?.event_id ||
      row?.idempotency_event_id !== row?.event_id ||
      row?.outbox_event_id !== row?.event_id ||
      row?.claim_source_seq !== identity.seq ||
      row?.projection_source_seq !== identity.seq ||
      row?.event_seq !== identity.seq ||
      row?.checkpoint_seq !== identity.seq ||
      row?.public_seq !== 1 ||
      row?.public_cursor !== 1 ||
      row?.public_seq !== identity.seq ||
      row?.public_cursor !== identity.seq
    ) {
      process.exit(1);
    }
  ' || {
    fail "TOKEN_LIFECYCLE_POST_STOP_D1_COUNTS_MISMATCH"
    return 1
  }
  emit "{\"suite\":\"${SUITE}\",\"assertion\":\"post_stop_d1_exact_revoke_and_session_replay_side_effect_counts\",\"status\":\"pass\"}"
}

scan_retained_logs() {
  local log
  for log in "${MIGRATION_LOG}" "${MIGRATION_JOURNAL_LOG}" "${MIGRATION_JOURNAL_ERROR_LOG}" \
    "${SESSION_SEED_LOG}" "${SESSION_SEED_ERROR_LOG}" \
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
  local deadline listener_status
  [[ "${TOKEN_LIFECYCLE_TEST_BUSY_PORT:-0}" == "1" ]] || return 0
  BUSY_PORT_MARKER="token-lifecycle-busy-port-$(${BUN} --eval 'console.log(crypto.randomUUID())')"
  TOKEN_LIFECYCLE_BUSY_PORT="${PORT}" "${BUN}" --eval '
    const port = Number(process.env.TOKEN_LIFECYCLE_BUSY_PORT);
    Bun.serve({ port, fetch: () => new Response("plant") });
    await Bun.sleep(600_000);
  ' "${BUSY_PORT_MARKER}" >/dev/null 2>&1 &
  BUSY_PORT_PID=$!
  BUSY_PORT_IDENTITY="$(capture_auxiliary_identity "${BUSY_PORT_PID}" "${BUSY_PORT_MARKER}")" || {
    fail "TOKEN_LIFECYCLE_BUSY_PORT_IDENTITY_UNAVAILABLE"
    return 1
  }
  deadline=$((SECONDS + CLEANUP_GRACE_SECONDS))
  (( deadline > SCRIPT_DEADLINE )) && deadline="${SCRIPT_DEADLINE}"
  while (( SECONDS < deadline )); do
    if listener_pids >/dev/null; then
      return 0
    else
      listener_status=$?
      (( listener_status == 1 )) || {
        fail "TOKEN_LIFECYCLE_LISTENER_INSPECTION_UNAVAILABLE"
        return 1
      }
    fi
    sleep 0.1
  done
  fail "TOKEN_LIFECYCLE_BUSY_PORT_PLANT_UNAVAILABLE"
  return 1
}

start_detached_state_plant() {
  local deadline state_processes
  [[ "${TOKEN_LIFECYCLE_TEST_DETACHED:-0}" == "1" ]] || return 0
  PLANTED_DETACHED_MARKER="token-lifecycle-detached-$(${BUN} --eval 'console.log(crypto.randomUUID())')"
  perl -MPOSIX=setsid -e 'setsid() or die "setsid"; sleep 600' \
    "${PLANTED_DETACHED_MARKER}" "TOKEN_LIFECYCLE_STATE=${STATE_DIR}" >/dev/null 2>&1 &
  PLANTED_DETACHED_PID=$!
  PLANTED_DETACHED_IDENTITY="$(capture_auxiliary_identity \
    "${PLANTED_DETACHED_PID}" "${PLANTED_DETACHED_MARKER}")" || {
    fail "TOKEN_LIFECYCLE_DETACHED_IDENTITY_UNAVAILABLE"
    return 1
  }
  deadline=$((SECONDS + CLEANUP_GRACE_SECONDS))
  (( deadline > SCRIPT_DEADLINE )) && deadline="${SCRIPT_DEADLINE}"
  while (( SECONDS < deadline )); do
    state_processes="$(state_owned_processes)" || {
      fail "TOKEN_LIFECYCLE_STATE_PROCESS_INSPECTION_UNAVAILABLE"
      return 1
    }
    if [[ -n "${state_processes}" ]]; then
      fail "TOKEN_LIFECYCLE_DETACHED_STATE_PROCESS_DETECTED"
      return 1
    fi
    sleep 0.1
  done
  fail "TOKEN_LIFECYCLE_DETACHED_PLANT_UNOBSERVED"
  return 1
}

run_auxiliary_pid_reuse_plant() {
  local signal_record deadline wait_status
  [[ "${TOKEN_LIFECYCLE_TEST_AUX_PID_REUSE:-0}" == "1" ]] || return 0
  AUX_REUSE_MARKER="token-lifecycle-aux-reuse-$(${BUN} --eval 'console.log(crypto.randomUUID())')"
  signal_record="${STATE_DIR}/aux-reuse.signal"
  perl -e '
    my ($marker, $signal_record) = @ARGV;
    $SIG{"TERM"} = sub {
      open(my $record, ">", $signal_record) or die "signal-record";
      print $record "TERM\n";
      close($record);
      exit 91;
    };
    select(undef, undef, undef, 1.0);
  ' "${AUX_REUSE_MARKER}" "${signal_record}" >/dev/null 2>&1 &
  AUX_REUSE_PID=$!
  AUX_REUSE_IDENTITY="$(capture_auxiliary_identity \
    "${AUX_REUSE_PID}" "${AUX_REUSE_MARKER}")" || {
    fail "TOKEN_LIFECYCLE_AUX_PID_REUSE_IDENTITY_UNAVAILABLE"
    return 1
  }

  if stop_auxiliary_child "${AUX_REUSE_PID}" "AUX_PID_REUSE" \
    "${AUX_REUSE_IDENTITY} planted-reused-start-time" "${AUX_REUSE_MARKER}"; then
    fail "TOKEN_LIFECYCLE_AUX_PID_REUSE_NOT_REFUSED"
    return 1
  fi

  deadline=$((SECONDS + 3))
  (( deadline > SCRIPT_DEADLINE )) && deadline="${SCRIPT_DEADLINE}"
  if wait_for_process_absence "${AUX_REUSE_PID}" "${deadline}"; then
    if wait "${AUX_REUSE_PID}"; then
      wait_status=0
    else
      wait_status=$?
    fi
  else
    if ! stop_auxiliary_child "${AUX_REUSE_PID}" "AUX_PID_REUSE_RECOVERY" \
      "${AUX_REUSE_IDENTITY}" "${AUX_REUSE_MARKER}"; then
      return 1
    fi
    fail "TOKEN_LIFECYCLE_AUX_PID_REUSE_NATURAL_EXIT_UNPROVEN"
    return 1
  fi
  AUX_REUSE_PID=""
  AUX_REUSE_IDENTITY=""
  AUX_REUSE_MARKER=""
  [[ "${wait_status}" == "0" && ! -e "${signal_record}" ]] || {
    fail "TOKEN_LIFECYCLE_AUX_PID_REUSE_UNRELATED_SIGNALLED"
    return 1
  }
  emit "{\"suite\":\"${SUITE}\",\"assertion\":\"auxiliary_pid_reuse_identity_drift_refused_without_signal\",\"status\":\"pass\"}"
  fail "TOKEN_LIFECYCLE_AUX_PID_REUSE_PLANT"
  return 1
}

stop_worker() {
  local cleanup_census cleanup_deadline fd_status group_state leader_state signal_status state_processes
  local plant_descendant_state plant_direct_state retirement_descendant retirement_descendant_live
  local port_status
  local retirement_direct retirement_extra retirement_line retirement_nonce retirement_pgid retirement_phase
  local retirement_worker_reaped wait_status worker_pgid
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

  cleanup_census="$(cleanup_group_members "${SERVER_PGID}")" || {
    fail "TOKEN_LIFECYCLE_GROUP_INSPECTION_UNAVAILABLE"
    return 1
  }
  if [[ "${TOKEN_LIFECYCLE_TEST_CLEANUP_CENSUS_PARTIAL:-0}" == "1" \
    && -n "${cleanup_census}" ]]; then
    fail "TOKEN_LIFECYCLE_CLEANUP_CENSUS_PLANT_INACTIVE"
    return 1
  fi

  group_state="$(group_liveness "${SERVER_PGID}")" || {
    fail "TOKEN_LIFECYCLE_GROUP_LIVENESS_UNPROVEN"
    return 1
  }
  if [[ "${group_state}" == "live" ]]; then
    # The group signal is authorized only by the original direct-child identity,
    # not a numeric PID/PGID that could have been recycled after readiness.
    if ! server_group_signal_is_authorized; then
      # A post-fork supervisor control failure retires its own exact group. Give
      # that fail-closed path a bounded chance to settle; never signal the bare
      # PGID after its challenge anchor has disappeared.
      cleanup_deadline=$((SECONDS + CLEANUP_GRACE_SECONDS))
      (( cleanup_deadline > SCRIPT_DEADLINE )) && cleanup_deadline="${SCRIPT_DEADLINE}"
      if wait_for_group_absence "${SERVER_PGID}" "${cleanup_deadline}"; then
        group_state="absent"
      else
        wait_status=$?
        if (( wait_status == 2 )); then
          fail "TOKEN_LIFECYCLE_GROUP_LIVENESS_UNPROVEN"
        else
          fail "TOKEN_LIFECYCLE_GROUP_LEADER_REAP_UNPROVEN"
        fi
        return 1
      fi
    else
      signal_status=0
      kill -TERM "-${SERVER_PGID}" 2>/dev/null || signal_status=$?
      if (( signal_status != 0 )); then
        group_state="$(group_liveness "${SERVER_PGID}")" || {
          fail "TOKEN_LIFECYCLE_GROUP_LIVENESS_UNPROVEN"
          return 1
        }
        [[ "${group_state}" == "absent" ]] || {
          fail "TOKEN_LIFECYCLE_TERM_UNDELIVERED"
          return 1
        }
      fi
    fi
  fi

  if [[ "${group_state}" == "live" ]]; then
    cleanup_deadline=$((SECONDS + CLEANUP_GRACE_SECONDS))
    (( cleanup_deadline > SCRIPT_DEADLINE )) && cleanup_deadline="${SCRIPT_DEADLINE}"
    if wait_for_group_absence "${SERVER_PGID}" "${cleanup_deadline}"; then
      group_state="absent"
    else
      wait_status=$?
      (( wait_status != 2 )) || {
        fail "TOKEN_LIFECYCLE_GROUP_LIVENESS_UNPROVEN"
        return 1
      }
    fi
  fi

  if [[ "${group_state}" == "live" ]]; then
    # KILL remains safe only while the original direct-child identity still
    # names this group. A responder mismatch alone does not remove that anchor.
    if ! server_group_signal_is_authorized; then
      cleanup_deadline=$((SECONDS + CLEANUP_GRACE_SECONDS))
      (( cleanup_deadline > SCRIPT_DEADLINE )) && cleanup_deadline="${SCRIPT_DEADLINE}"
      if wait_for_group_absence "${SERVER_PGID}" "${cleanup_deadline}"; then
        group_state="absent"
      else
        wait_status=$?
        if (( wait_status == 2 )); then
          fail "TOKEN_LIFECYCLE_GROUP_LIVENESS_UNPROVEN"
        else
          fail "TOKEN_LIFECYCLE_GROUP_LEADER_REAP_UNPROVEN"
        fi
        return 1
      fi
    else
      signal_status=0
      kill -KILL "-${SERVER_PGID}" 2>/dev/null || signal_status=$?
      if (( signal_status != 0 )); then
        group_state="$(group_liveness "${SERVER_PGID}")" || {
          fail "TOKEN_LIFECYCLE_GROUP_LIVENESS_UNPROVEN"
          return 1
        }
        [[ "${group_state}" == "absent" ]] || {
          fail "TOKEN_LIFECYCLE_KILL_UNDELIVERED"
          return 1
        }
      fi
    fi
  fi

  if [[ "${group_state}" == "live" ]]; then
    cleanup_deadline=$((SECONDS + CLEANUP_GRACE_SECONDS))
    (( cleanup_deadline > SCRIPT_DEADLINE )) && cleanup_deadline="${SCRIPT_DEADLINE}"
    if wait_for_group_absence "${SERVER_PGID}" "${cleanup_deadline}"; then
      group_state="absent"
    else
      wait_status=$?
      if (( wait_status == 2 )); then
        fail "TOKEN_LIFECYCLE_GROUP_LIVENESS_UNPROVEN"
      else
        fail "TOKEN_LIFECYCLE_WORKER_SURVIVOR"
      fi
      return 1
    fi
  fi

  [[ "${group_state}" == "absent" ]] || {
    fail "TOKEN_LIFECYCLE_GROUP_LIVENESS_UNPROVEN"
    return 1
  }
  leader_state="$(process_liveness "${SERVER_PID}")" || {
    fail "TOKEN_LIFECYCLE_GROUP_LEADER_EXIT_UNPROVEN"
    return 1
  }
  [[ "${leader_state}" == "absent" ]] || {
    fail "TOKEN_LIFECYCLE_GROUP_LEADER_EXIT_UNPROVEN"
    return 1
  }
  # The kernel has proved both the group and direct child absent, so Bash's
  # stored child status is now nonblocking to consume.
  wait "${SERVER_PID}" 2>/dev/null || true
  if [[ "${TOKEN_LIFECYCLE_TEST_SUPERVISOR_DESCENDANT_FAILURE:-0}" == "1" ]]; then
    retirement_line="$(sed -n '2p' "${SERVER_SUPERVISOR_RETIREMENT}")" || {
      fail "TOKEN_LIFECYCLE_SUPERVISOR_DESCENDANT_RETIREMENT_UNPROVEN"
      return 1
    }
    IFS=$'\t' read -r retirement_phase retirement_direct retirement_descendant retirement_pgid \
      retirement_nonce retirement_worker_reaped retirement_descendant_live retirement_extra \
      <<<"${retirement_line}" || {
      fail "TOKEN_LIFECYCLE_SUPERVISOR_DESCENDANT_RETIREMENT_UNPROVEN"
      return 1
    }
    [[ "${retirement_phase}" == "term-grace" \
      && "${retirement_direct}" == "${SUPERVISOR_PLANT_DIRECT_PID}" \
      && "${retirement_descendant}" == "${SUPERVISOR_PLANT_DESCENDANT_PID}" \
      && "${retirement_pgid}" == "${worker_pgid}" \
      && "${retirement_nonce}" == "${SERVER_SUPERVISOR_NONCE}" \
      && "${retirement_worker_reaped}" == "1" \
      && "${retirement_descendant_live}" == "1" \
      && -z "${retirement_extra}" ]] || {
      fail "TOKEN_LIFECYCLE_SUPERVISOR_DESCENDANT_RETIREMENT_UNPROVEN"
      return 1
    }
    plant_direct_state="$(process_liveness "${SUPERVISOR_PLANT_DIRECT_PID}")" || {
      fail "TOKEN_LIFECYCLE_SUPERVISOR_DESCENDANT_RETIREMENT_UNPROVEN"
      return 1
    }
    plant_descendant_state="$(process_liveness "${SUPERVISOR_PLANT_DESCENDANT_PID}")" || {
      fail "TOKEN_LIFECYCLE_SUPERVISOR_DESCENDANT_RETIREMENT_UNPROVEN"
      return 1
    }
    [[ "${plant_direct_state}" == "absent" && "${plant_descendant_state}" == "absent" ]] || {
      fail "TOKEN_LIFECYCLE_SUPERVISOR_DESCENDANT_RETIREMENT_UNPROVEN"
      return 1
    }
    emit "{\"suite\":\"${SUITE}\",\"assertion\":\"supervisor_term_reaped_direct_then_killed_same_group_term_ignoring_descendant\",\"status\":\"pass\"}"
  fi
  if port_is_free final; then
    :
  else
    port_status=$?
    if [[ "${TOKEN_LIFECYCLE_TEST_LISTENER_EXIT_ZERO_EMPTY:-0}" == "1" ]]; then
      emit "{\"suite\":\"${SUITE}\",\"assertion\":\"listener_exit_zero_empty_refused_as_absence\",\"status\":\"pass\"}"
    elif [[ "${TOKEN_LIFECYCLE_TEST_LISTENER_STDOUT_NEWLINE:-0}" == "1" ]]; then
      emit "{\"suite\":\"${SUITE}\",\"assertion\":\"listener_status_one_stdout_newline_refused_as_absence\",\"status\":\"pass\"}"
    elif [[ "${TOKEN_LIFECYCLE_TEST_LISTENER_STDERR_NEWLINE:-0}" == "1" ]]; then
      emit "{\"suite\":\"${SUITE}\",\"assertion\":\"listener_status_one_stderr_newline_refused_as_absence\",\"status\":\"pass\"}"
    elif [[ "${TOKEN_LIFECYCLE_TEST_LISTENER_DIAGNOSTIC:-0}" == "1" ]]; then
      emit "{\"suite\":\"${SUITE}\",\"assertion\":\"listener_diagnostic_refused_as_absence\",\"status\":\"pass\"}"
    fi
    if (( port_status == 1 )); then
      fail "TOKEN_LIFECYCLE_LISTENER_SURVIVOR"
    else
      fail "TOKEN_LIFECYCLE_LISTENER_INSPECTION_UNAVAILABLE"
    fi
    return 1
  fi
  state_processes="$(state_owned_processes)" || {
    if [[ "${TOKEN_LIFECYCLE_TEST_STATE_CENSUS_PARTIAL:-0}" == "1" ]]; then
      emit "{\"suite\":\"${SUITE}\",\"assertion\":\"state_census_exit_zero_partial_after_anchor_missing_completion_refused\",\"status\":\"pass\"}"
    fi
    fail "TOKEN_LIFECYCLE_STATE_PROCESS_INSPECTION_UNAVAILABLE"
    return 1
  }
  [[ -z "${state_processes}" ]] || {
    fail "TOKEN_LIFECYCLE_STATE_PROCESS_SURVIVOR"
    return 1
  }
  if state_fds_are_closed; then
    :
  else
    fd_status=$?
    if (( fd_status == 1 )); then
      fail "TOKEN_LIFECYCLE_STATE_FD_SURVIVOR"
    else
      fail "TOKEN_LIFECYCLE_STATE_FD_INSPECTION_UNAVAILABLE"
    fi
    return 1
  fi
  if (( SERVER_TARGET_GATE_OPENED == 0 )); then
    emit "{\"suite\":\"${SUITE}\",\"assertion\":\"startup_gate_supervisor_reaped_before_target_launch\",\"status\":\"pass\",\"wrangler_started\":false}"
  fi
  if [[ "${TOKEN_LIFECYCLE_TEST_CLEANUP_CENSUS_PARTIAL:-0}" == "1" ]]; then
    emit "{\"suite\":\"${SUITE}\",\"assertion\":\"cleanup_census_exit_zero_empty_cannot_false_reap\",\"status\":\"pass\"}"
  fi
  if [[ "${TOKEN_LIFECYCLE_TEST_SUPERVISOR_STARTED_FAILURE:-0}" == "1" \
    || "${TOKEN_LIFECYCLE_TEST_SUPERVISOR_CHALLENGE_FAILURE:-0}" == "1" \
    || "${TOKEN_LIFECYCLE_TEST_SUPERVISOR_WAITPID_FAILURE:-0}" == "1" \
    || "${TOKEN_LIFECYCLE_TEST_SUPERVISOR_DESCENDANT_FAILURE:-0}" == "1" ]]; then
    emit "{\"suite\":\"${SUITE}\",\"assertion\":\"supervisor_postfork_control_failure_retired_exact_group\",\"status\":\"pass\"}"
  fi
  SERVER_PID=""
  SERVER_PGID=""
  SERVER_LEADER_IDENTITY=""
  SERVER_IDENTITY_STATE=""
  close_server_supervisor_lease
  emit "{\"suite\":\"${SUITE}\",\"assertion\":\"workerd_group_descendants_listener_and_state_fds_reaped\",\"status\":\"pass\",\"pgid\":\"${worker_pgid}\"}"
}

close_server_supervisor_lease() {
  [[ -n "${SERVER_SUPERVISOR_LEASE_FD}" ]] || return 0
  exec {SERVER_SUPERVISOR_LEASE_FD}>&-
  SERVER_SUPERVISOR_LEASE_FD=""
}

finalize() {
  local status=$?
  trap - EXIT INT TERM HUP
  if ! stop_auxiliary_child "${AUX_REUSE_PID}" "AUX_PID_REUSE_RECOVERY" \
    "${AUX_REUSE_IDENTITY}" "${AUX_REUSE_MARKER}"; then status=1; fi
  if ! stop_auxiliary_child "${PLANTED_DETACHED_PID}" "PLANTED_DETACHED" \
    "${PLANTED_DETACHED_IDENTITY}" "${PLANTED_DETACHED_MARKER}"; then status=1; fi
  if ! stop_auxiliary_child "${BUSY_PORT_PID}" "BUSY_PORT" \
    "${BUSY_PORT_IDENTITY}" "${BUSY_PORT_MARKER}"; then status=1; fi
  if ! stop_worker; then status=1; fi
  close_server_supervisor_lease
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
  run_panic_coverage_verifier_self_test || exit 1
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
PROBE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/asimposium-token-lifecycle-probes.XXXXXX")"
chmod 700 "${PROBE_DIR}"
readonly PROBE_DIR
readonly MIGRATION_LOG="${STATE_DIR}/migrations.log"
readonly MIGRATION_JOURNAL_LOG="${STATE_DIR}/migration-journal.json"
readonly MIGRATION_JOURNAL_ERROR_LOG="${STATE_DIR}/migration-journal.stderr"
readonly SESSION_SEED_LOG="${STATE_DIR}/session-seed.json"
readonly SESSION_SEED_ERROR_LOG="${STATE_DIR}/session-seed.stderr"
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
SERVER_SUPERVISOR_FAULT="${STATE_DIR}/supervisor.fault"
SERVER_SUPERVISOR_RETIREMENT="${STATE_DIR}/supervisor.retirement"
SERVER_SUPERVISOR_LEASE="${PROBE_DIR}/supervisor-parent.lease"
mkfifo -m 600 "${SERVER_SUPERVISOR_LEASE}" || {
  fail "TOKEN_LIFECYCLE_SUPERVISOR_LEASE_UNAVAILABLE"
  exit 1
}
STATE_CENSUS_NONCE="$(${BUN} --eval 'console.log(crypto.randomUUID())')"
[[ -n "${STATE_CENSUS_NONCE}" ]] || { fail "TOKEN_LIFECYCLE_STATE_CENSUS_NONCE_UNAVAILABLE"; exit 1; }

CONTROLLER_PGID="$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')"
[[ "${CONTROLLER_PGID}" =~ ^[0-9]+$ ]] || { fail "TOKEN_LIFECYCLE_CONTROLLER_GROUP_UNKNOWN"; exit 1; }

PORT="$(${BUN} --eval '
const server = Bun.serve({ port: 0, fetch: () => new Response("unused") });
console.log(server.port);
server.stop(true);
')"
[[ "${PORT}" =~ ^[0-9]+$ ]] || { fail "TOKEN_LIFECYCLE_PORT_UNAVAILABLE"; exit 1; }
readonly ORIGIN="http://127.0.0.1:${PORT}"

start_busy_port_plant || exit 1
if port_is_free preflight; then
  :
else
  port_status=$?
  if (( port_status == 1 )); then
    fail "TOKEN_LIFECYCLE_PORT_ALREADY_BOUND"
  else
    fail "TOKEN_LIFECYCLE_LISTENER_INSPECTION_UNAVAILABLE"
  fi
  exit 1
fi
run_auxiliary_pid_reuse_plant || exit 1

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
seed_session_problem || exit 1

# The nonce-bearing supervisor is the stable process-group leader. It cannot
# launch Wrangler until the parent validates its private ready record and opens
# the go gate, and it continues answering fresh challenges while the Worker is
# live. Secret bindings remain environment-only and never enter argv.
exec {SERVER_SUPERVISOR_LEASE_FD}<>"${SERVER_SUPERVISOR_LEASE}" || {
  fail "TOKEN_LIFECYCLE_SUPERVISOR_LEASE_UNAVAILABLE"
  exit 1
}
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
    TOKEN_LIFECYCLE_SUPERVISOR_FAULT="${SERVER_SUPERVISOR_FAULT}" \
    TOKEN_LIFECYCLE_SUPERVISOR_RETIREMENT="${SERVER_SUPERVISOR_RETIREMENT}" \
    TOKEN_LIFECYCLE_SUPERVISOR_LEASE_FD="${SERVER_SUPERVISOR_LEASE_FD}" \
    TOKEN_LIFECYCLE_TEST_SUPERVISOR_STARTED_FAILURE="${TOKEN_LIFECYCLE_TEST_SUPERVISOR_STARTED_FAILURE:-0}" \
    TOKEN_LIFECYCLE_TEST_SUPERVISOR_CHALLENGE_FAILURE="${TOKEN_LIFECYCLE_TEST_SUPERVISOR_CHALLENGE_FAILURE:-0}" \
    TOKEN_LIFECYCLE_TEST_SUPERVISOR_WAITPID_FAILURE="${TOKEN_LIFECYCLE_TEST_SUPERVISOR_WAITPID_FAILURE:-0}" \
    TOKEN_LIFECYCLE_TEST_SUPERVISOR_DESCENDANT_FAILURE="${TOKEN_LIFECYCLE_TEST_SUPERVISOR_DESCENDANT_FAILURE:-0}" \
    exec perl -MPOSIX=WNOHANG -MIO::Handle -MTime::HiRes=time -e '
      my $marker = shift @ARGV;
      die "marker" unless $marker eq $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_MARKER"};
      my $leader = $$;
      my $group = getpgrp(0);
      die "group" unless $leader == $group;
      my $worker;
      my $planted_descendant;
      my $worker_reaped = 0;
      my $retiring = 0;
      $SIG{"TERM"} = sub { exit 125 unless defined($worker) && $worker > 0; };
      my $lease_anchor_fd = $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_LEASE_FD"};
      die "lease-anchor-fd" unless defined($lease_anchor_fd) && $lease_anchor_fd =~ /^\d+$/;
      open(my $lease_anchor, "<&=", $lease_anchor_fd) or die "lease-anchor-open";
      close($lease_anchor) or die "lease-anchor-close";
      my $lease_nonce = <STDIN>;
      die "lease-nonce" unless defined($lease_nonce);
      chomp($lease_nonce);
      die "lease-nonce" unless $lease_nonce eq $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_NONCE"};
      my $parent_lease_is_open = sub {
        my $readable = "";
        vec($readable, fileno(STDIN), 1) = 1;
        my $selected = select($readable, undef, undef, 0);
        return 0 if !defined($selected);
        return 1 if $selected == 0;
        my $bytes = sysread(STDIN, my $unexpected, 1);
        return 0 if !defined($bytes) || $bytes == 0;
        return 0;
      };
      my $retire_orphaned_group = sub {
        kill "KILL", -$group;
        POSIX::_exit(125);
      };
      open(my $ready, ">", $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_READY"}) or die "ready";
      print $ready join("\t", $leader, $group, $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_NONCE"}) . "\n";
      close($ready);
      my $last_challenge = "";
      my $postfork = 0;
      my $challenge_fault_used = 0;
      my $answer_challenge = sub {
        return unless -e $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_CHALLENGE"};
        open(my $challenge_file, "<", $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_CHALLENGE"}) or die "challenge";
        my $challenge = <$challenge_file> // "";
        close($challenge_file) or die "challenge-close";
        $challenge =~ s/\s+$//;
        return if $challenge eq "" || $challenge eq $last_challenge;
        if ($postfork && ($ENV{"TOKEN_LIFECYCLE_TEST_SUPERVISOR_CHALLENGE_FAILURE"} eq "1" || $ENV{"TOKEN_LIFECYCLE_TEST_SUPERVISOR_DESCENDANT_FAILURE"} eq "1") && !$challenge_fault_used) {
          $challenge_fault_used = 1;
          die "planted-challenge-response";
        }
        open(my $response, ">", $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_RESPONSE"}) or die "response";
        print $response join("\t", $challenge, $leader, $group, $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_NONCE"}) . "\n" or die "response-write";
        close($response) or die "response-close";
        $last_challenge = $challenge;
      };
      until (-e $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_GO"}) {
        $retire_orphaned_group->() unless $parent_lease_is_open->();
        $answer_challenge->();
        select(undef, undef, undef, 0.01);
      }
      open(my $started, ">", $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_STARTED"}) or die "started-open";
      open(my $fault, ">", $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_FAULT"}) or die "fault-open";
      $fault->autoflush(1);
      my $retirement;
      if ($ENV{"TOKEN_LIFECYCLE_TEST_SUPERVISOR_DESCENDANT_FAILURE"} eq "1") {
        open($retirement, ">", $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_RETIREMENT"}) or die "retirement-open";
        $retirement->autoflush(1);
      }
      my $retire_group = sub {
        return if $retiring;
        $retiring = 1;
        kill "TERM", -$group;
        my $retire_deadline = time + 2;
        while (time < $retire_deadline) {
          if (defined($worker) && $worker > 0 && !$worker_reaped) {
            my $done = waitpid($worker, WNOHANG);
            $worker_reaped = 1 if $done == $worker || $done < 0;
          }
          select(undef, undef, undef, 0.01);
        }
        if (defined($retirement)) {
          my $descendant_live = defined($planted_descendant) && kill(0, $planted_descendant) ? 1 : 0;
          print $retirement join("\t", "term-grace", $worker, $planted_descendant, $group, $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_NONCE"}, $worker_reaped, $descendant_live) . "\n";
          close($retirement);
        }
        kill "KILL", -$group;
        POSIX::_exit(125);
      };
      $worker = fork();
      die "fork" unless defined($worker);
      if ($worker == 0) {
        $SIG{"TERM"} = "DEFAULT";
        open STDIN, "<", "/dev/null" or POSIX::_exit(127);
        exit 0 if $ENV{"TOKEN_LIFECYCLE_TEST_SUPERVISOR_WAITPID_FAILURE"} eq "1";
        if ($ENV{"TOKEN_LIFECYCLE_TEST_SUPERVISOR_DESCENDANT_FAILURE"} eq "1") {
          while (1) { select(undef, undef, undef, 1); }
        }
        exec @ARGV or die "exec";
      }
      $postfork = 1;
      if ($ENV{"TOKEN_LIFECYCLE_TEST_SUPERVISOR_DESCENDANT_FAILURE"} eq "1") {
        $planted_descendant = fork();
        $retire_group->() unless defined($planted_descendant);
        if ($planted_descendant == 0) {
          $SIG{"TERM"} = "IGNORE";
          while (1) { select(undef, undef, undef, 1); }
        }
        print $retirement join("\t", "forked", $worker, $planted_descendant, $group, $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_NONCE"}) . "\n" or $retire_group->();
      }
      my $started_ok = eval {
        if ($ENV{"TOKEN_LIFECYCLE_TEST_SUPERVISOR_STARTED_FAILURE"} eq "1") {
          close($started) or die "started-plant-preclose";
        }
        print $started join("\t", "started", $worker) . "\n" or die "started-write";
        close($started) or die "started-close";
        1;
      };
      if (!$started_ok) {
        print $fault join("\t", "started-publication", $worker, $group, $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_NONCE"}) . "\n";
        $retire_group->();
      }
      if ($ENV{"TOKEN_LIFECYCLE_TEST_SUPERVISOR_WAITPID_FAILURE"} eq "1") {
        my $pre_reap_deadline = time + 1;
        while (time < $pre_reap_deadline && !$worker_reaped) {
          my $done = waitpid($worker, WNOHANG);
          $worker_reaped = 1 if $done == $worker;
          select(undef, undef, undef, 0.01) unless $worker_reaped;
        }
        $retire_group->() unless $worker_reaped;
      }
      my $status;
      while (1) {
        $retire_orphaned_group->() unless $parent_lease_is_open->();
        eval { $answer_challenge->(); 1 } or $retire_group->();
        my $done = waitpid($worker, WNOHANG);
        if ($done == $worker) { $status = $?; last; }
        if ($done < 0) {
          print $fault join("\t", "waitpid-negative", $worker, $group, $ENV{"TOKEN_LIFECYCLE_SUPERVISOR_NONCE"}) . "\n";
          $retire_group->();
        }
        select(undef, undef, undef, 0.01);
      }
      my $code = ($status & 127) ? 128 + ($status & 127) : $status >> 8;
      exit($code);
    ' "${SERVER_SUPERVISOR_MARKER}" "${WRANGLER}" dev --config "${CONFIG}" --local \
      --persist-to "${STATE_DIR}" --port "${PORT}" --inspector-port 0 --log-level error \
      --env-file /dev/null
) <"${SERVER_SUPERVISOR_LEASE}" >"${SERVER_LOG}" 2>&1 &
SERVER_PID=$!
SERVER_PGID="${SERVER_PID}"
SERVER_IDENTITY_STATE="supervisor"
printf '%s\n' "${SERVER_SUPERVISOR_NONCE}" >&"${SERVER_SUPERVISOR_LEASE_FD}" || {
  fail "TOKEN_LIFECYCLE_SUPERVISOR_LEASE_UNAVAILABLE"
  exit 1
}

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
supervisor_started_phase=""
supervisor_worker_pid=""
supervisor_started_extra=""
supervisor_fault_phase=""
supervisor_fault_pid=""
supervisor_fault_pgid=""
supervisor_fault_nonce=""
supervisor_fault_extra=""
while (( SECONDS < supervisor_start_deadline )); do
  if [[ "${TOKEN_LIFECYCLE_TEST_SUPERVISOR_STARTED_FAILURE:-0}" == "1" \
    && -s "${SERVER_SUPERVISOR_FAULT}" ]] &&
    IFS=$'\t' read -r supervisor_fault_phase supervisor_fault_pid supervisor_fault_pgid \
      supervisor_fault_nonce supervisor_fault_extra <"${SERVER_SUPERVISOR_FAULT}"; then
    break
  fi
  if [[ "${TOKEN_LIFECYCLE_TEST_SUPERVISOR_STARTED_FAILURE:-0}" != "1" \
    && -s "${SERVER_SUPERVISOR_STARTED}" ]] &&
    IFS=$'\t' read -r supervisor_started_phase supervisor_worker_pid supervisor_started_extra \
      <"${SERVER_SUPERVISOR_STARTED}"; then
    break
  fi
  sleep 0.01
done
if [[ "${TOKEN_LIFECYCLE_TEST_SUPERVISOR_STARTED_FAILURE:-0}" == "1" \
  && "${supervisor_fault_phase}" == "started-publication" \
  && "${supervisor_fault_pid}" =~ ^[0-9]+$ \
  && "${supervisor_fault_pgid}" == "${SERVER_PGID}" \
  && "${supervisor_fault_nonce}" == "${SERVER_SUPERVISOR_NONCE}" \
  && -z "${supervisor_fault_extra}" ]]; then
  fail "TOKEN_LIFECYCLE_SUPERVISOR_STARTED_FAILURE_PLANT"
  exit 1
fi
[[ "${supervisor_started_phase}" == "started" \
  && "${supervisor_worker_pid}" =~ ^[0-9]+$ \
  && -z "${supervisor_started_extra}" ]] || {
  fail "TOKEN_LIFECYCLE_WRANGLER_LAUNCH_UNPROVEN"
  exit 1
}
if [[ "${TOKEN_LIFECYCLE_TEST_SUPERVISOR_WAITPID_FAILURE:-0}" == "1" ]]; then
  supervisor_start_deadline=$((SECONDS + 5))
  (( supervisor_start_deadline > SCRIPT_DEADLINE )) && supervisor_start_deadline="${SCRIPT_DEADLINE}"
  while (( SECONDS < supervisor_start_deadline )); do
    if [[ -s "${SERVER_SUPERVISOR_FAULT}" ]] &&
      IFS=$'\t' read -r supervisor_fault_phase supervisor_fault_pid supervisor_fault_pgid \
        supervisor_fault_nonce supervisor_fault_extra <"${SERVER_SUPERVISOR_FAULT}" &&
      [[ "${supervisor_fault_phase}" == "waitpid-negative" \
        && "${supervisor_fault_pid}" == "${supervisor_worker_pid}" \
        && "${supervisor_fault_pgid}" == "${SERVER_PGID}" \
        && "${supervisor_fault_nonce}" == "${SERVER_SUPERVISOR_NONCE}" \
        && -z "${supervisor_fault_extra}" ]]; then
      fail "TOKEN_LIFECYCLE_SUPERVISOR_WAITPID_FAILURE_PLANT"
      exit 1
    fi
    sleep 0.01
  done
  fail "TOKEN_LIFECYCLE_SUPERVISOR_WAITPID_FAILURE_INACTIVE"
  exit 1
fi
if [[ "${TOKEN_LIFECYCLE_TEST_SUPERVISOR_DESCENDANT_FAILURE:-0}" == "1" ]]; then
  supervisor_start_deadline=$((SECONDS + 5))
  (( supervisor_start_deadline > SCRIPT_DEADLINE )) && supervisor_start_deadline="${SCRIPT_DEADLINE}"
  supervisor_retirement_phase=""
  supervisor_retirement_direct=""
  supervisor_retirement_descendant=""
  supervisor_retirement_pgid=""
  supervisor_retirement_nonce=""
  supervisor_retirement_extra=""
  while (( SECONDS < supervisor_start_deadline )); do
    if [[ -s "${SERVER_SUPERVISOR_RETIREMENT}" ]] &&
      IFS=$'\t' read -r supervisor_retirement_phase supervisor_retirement_direct \
        supervisor_retirement_descendant supervisor_retirement_pgid supervisor_retirement_nonce \
        supervisor_retirement_extra <"${SERVER_SUPERVISOR_RETIREMENT}" &&
      [[ "${supervisor_retirement_phase}" == "forked" \
        && "${supervisor_retirement_direct}" == "${supervisor_worker_pid}" \
        && "${supervisor_retirement_descendant}" =~ ^[0-9]+$ \
        && "${supervisor_retirement_pgid}" == "${SERVER_PGID}" \
        && "${supervisor_retirement_nonce}" == "${SERVER_SUPERVISOR_NONCE}" \
        && -z "${supervisor_retirement_extra}" ]]; then
      break
    fi
    sleep 0.01
  done
  [[ "${supervisor_retirement_phase}" == "forked" \
    && "${supervisor_retirement_direct}" == "${supervisor_worker_pid}" \
    && "${supervisor_retirement_descendant}" =~ ^[0-9]+$ \
    && "${supervisor_retirement_pgid}" == "${SERVER_PGID}" \
    && "${supervisor_retirement_nonce}" == "${SERVER_SUPERVISOR_NONCE}" \
    && -z "${supervisor_retirement_extra}" ]] || {
    fail "TOKEN_LIFECYCLE_SUPERVISOR_DESCENDANT_IDENTITY_UNPROVEN"
    exit 1
  }
  SUPERVISOR_PLANT_DIRECT_PID="${supervisor_retirement_direct}"
  SUPERVISOR_PLANT_DESCENDANT_PID="${supervisor_retirement_descendant}"
  SUPERVISOR_PLANT_DIRECT_IDENTITY="$(raw_process_identity "${SUPERVISOR_PLANT_DIRECT_PID}")" || {
    fail "TOKEN_LIFECYCLE_SUPERVISOR_DESCENDANT_IDENTITY_UNPROVEN"
    exit 1
  }
  SUPERVISOR_PLANT_DESCENDANT_IDENTITY="$(raw_process_identity \
    "${SUPERVISOR_PLANT_DESCENDANT_PID}")" || {
    fail "TOKEN_LIFECYCLE_SUPERVISOR_DESCENDANT_IDENTITY_UNPROVEN"
    exit 1
  }
  [[ "${SUPERVISOR_PLANT_DIRECT_IDENTITY}" == *$'\t'"${SERVER_PGID}"$'\t'* \
    && "${SUPERVISOR_PLANT_DESCENDANT_IDENTITY}" == *$'\t'"${SERVER_PGID}"$'\t'* \
    && "${SUPERVISOR_PLANT_DIRECT_IDENTITY}" == *"${SERVER_SUPERVISOR_MARKER}"* \
    && "${SUPERVISOR_PLANT_DESCENDANT_IDENTITY}" == *"${SERVER_SUPERVISOR_MARKER}"* ]] || {
    fail "TOKEN_LIFECYCLE_SUPERVISOR_DESCENDANT_IDENTITY_UNPROVEN"
    exit 1
  }
  if challenge_server_supervisor; then
    fail "TOKEN_LIFECYCLE_SUPERVISOR_DESCENDANT_FAILURE_INACTIVE"
    exit 1
  fi
  fail "TOKEN_LIFECYCLE_SUPERVISOR_DESCENDANT_FAILURE_PLANT"
  exit 1
fi
if [[ "${TOKEN_LIFECYCLE_TEST_SUPERVISOR_CHALLENGE_FAILURE:-0}" == "1" ]]; then
  if challenge_server_supervisor; then
    fail "TOKEN_LIFECYCLE_SUPERVISOR_CHALLENGE_FAILURE_INACTIVE"
    exit 1
  fi
  fail "TOKEN_LIFECYCLE_SUPERVISOR_CHALLENGE_FAILURE_PLANT"
  exit 1
fi

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
if [[ "${TOKEN_LIFECYCLE_TEST_CLEANUP_CENSUS_PARTIAL:-0}" == "1" ]]; then
  fail "TOKEN_LIFECYCLE_CLEANUP_CENSUS_PARTIAL_PLANT"
  exit 1
fi
if [[ "${TOKEN_LIFECYCLE_TEST_STATE_CENSUS_PARTIAL:-0}" == "1" ]]; then
  fail "TOKEN_LIFECYCLE_STATE_CENSUS_PARTIAL_PLANT"
  exit 1
fi
if [[ "${TOKEN_LIFECYCLE_TEST_LISTENER_EXIT_ZERO_EMPTY:-0}" == "1" ]]; then
  fail "TOKEN_LIFECYCLE_LISTENER_EXIT_ZERO_EMPTY_PLANT"
  exit 1
fi
if [[ "${TOKEN_LIFECYCLE_TEST_LISTENER_STDOUT_NEWLINE:-0}" == "1" ]]; then
  fail "TOKEN_LIFECYCLE_LISTENER_STDOUT_NEWLINE_PLANT"
  exit 1
fi
if [[ "${TOKEN_LIFECYCLE_TEST_LISTENER_STDERR_NEWLINE:-0}" == "1" ]]; then
  fail "TOKEN_LIFECYCLE_LISTENER_STDERR_NEWLINE_PLANT"
  exit 1
fi
if [[ "${TOKEN_LIFECYCLE_TEST_LISTENER_DIAGNOSTIC:-0}" == "1" ]]; then
  fail "TOKEN_LIFECYCLE_LISTENER_DIAGNOSTIC_PLANT"
  exit 1
fi
start_detached_state_plant || exit 1

read -r -d '' CLIENT_SOURCE <<'BUN' || true
import {
  EnrollmentApprovedResponseSchema,
  EnrollmentClaimResponseSchema,
  EnrollmentHelloResponseSchema,
  MintEnrollmentResponseSchema,
  PackResponseSchema,
  ProblemDocumentSchema,
  PromoteResponseSchema,
  type RequestedScope,
  SessionCloseResponseSchema,
  SessionOpenResponseSchema,
  SponsorCredentialRevokeResponseSchema,
  SponsorFellowListResponseSchema,
  SponsorPanicResponseSchema,
  WorkshopPushResponseSchema,
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
const packMeasurementProblemId = process.env.TOKEN_LIFECYCLE_PACK_PROBLEM_ID;
if (
  origin === undefined ||
  privateJwk === undefined ||
  barrierCapability === undefined ||
  authorizationEvidenceCanary === undefined ||
  packMeasurementProblemId === undefined
) {
  throw new Error("local configuration unavailable");
}
if (!/^[a-f0-9]{64}$/.test(barrierCapability)) throw new Error("local barrier capability unavailable");
if (packMeasurementProblemId !== "P-PACKMEASURE") {
  throw new Error("local pack-measurement problem unavailable");
}
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

type SessionReplayScope = "session_open" | "workshop_push" | "promote" | "session_close";

async function sessionReplayBarrierControl(
  method: "GET" | "POST",
  path: "arm" | "release" | "status",
  payload?: Record<string, unknown>,
): Promise<{ readonly response: Response; readonly payload: unknown }> {
  const response = await boundedFetch(`${origin}/__token-lifecycle/session-replay/${path}`, {
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

function sessionReplayBarrierPayload(
  payload: unknown,
  scope: SessionReplayScope,
  arrivals: number,
  released: boolean,
): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    Object.keys(payload).length === 4 &&
    (payload as Record<string, unknown>).scope === scope &&
    (payload as Record<string, unknown>).expected === 2 &&
    (payload as Record<string, unknown>).arrivals === arrivals &&
    (payload as Record<string, unknown>).released === released
  );
}

async function armSessionReplayBarrier(scope: SessionReplayScope): Promise<void> {
  const armed = await sessionReplayBarrierControl("POST", "arm", { scope });
  assert(armed.response.status === 200, `${scope}-session-barrier-arm`);
  assert(
    sessionReplayBarrierPayload(armed.payload, scope, 0, false),
    `${scope}-session-barrier-armed-exactly-two`,
  );
}

async function awaitBothSessionReplayArrivals(scope: SessionReplayScope): Promise<void> {
  const deadline = Date.now() + httpTimeoutMs;
  while (Date.now() < deadline) {
    const status = await sessionReplayBarrierControl("GET", "status");
    assert(status.response.status === 200, `${scope}-session-barrier-status`);
    if (sessionReplayBarrierPayload(status.payload, scope, 2, false)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${scope}-session-barrier-did-not-observe-both-real-d1-batches`);
}

async function releaseSessionReplayBarrier(scope: SessionReplayScope): Promise<void> {
  const released = await sessionReplayBarrierControl("POST", "release");
  assert(released.response.status === 200, `${scope}-session-barrier-release`);
  assert(
    sessionReplayBarrierPayload(released.payload, scope, 2, true),
    `${scope}-session-barrier-release-after-both-arrivals`,
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

async function sessionPost(
  token: string,
  path: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
) {
  const response = await boundedFetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      connection: "close",
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { response, payload: json(response, text), text };
}

async function sessionReplayRace(
  scope: SessionReplayScope,
  token: string,
  path: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
) {
  await armSessionReplayBarrier(scope);
  const requests = Promise.all([
    sessionPost(token, path, body, idempotencyKey),
    sessionPost(token, path, body, idempotencyKey),
  ]);
  await awaitBothSessionReplayArrivals(scope);
  await releaseSessionReplayBarrier(scope);
  const results = await requests;
  const statuses = results.map((result) => result.response.status).sort((left, right) => left - right);
  assert(
    statuses.length === 2 && statuses[0] === 200 && statuses[1] === 201,
    `${scope}-one-commit-one-replay`,
  );
  assert(results[0]?.text === results[1]?.text, `${scope}-exact-response-replay`);
  const committed = results.find((result) => result.response.status === 201);
  assert(committed !== undefined, `${scope}-committed-response-present`);
  process.stdout.write(
    `${JSON.stringify({
      suite: "token-lifecycle-local",
      assertion: `concurrent_http_same_key_${scope}_exact_replay`,
      deterministic_barrier: true,
      store_gate: "immediately_before_real_d1_batch",
      status: "pass",
    })}\n`,
  );
  return committed.payload;
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
  options: {
    expiresInMs?: number;
    proveScopeRefusal?: boolean;
    requestedScopes?: readonly RequestedScope[];
  } = {},
): Promise<Flow> {
  const mintBody: Record<string, unknown> = {
    requested_scopes: options.requestedScopes ?? ["review"],
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

async function assertTokenRejected(
  token: string,
  label: string,
): Promise<{ readonly label: string; readonly status: number; readonly code: string }> {
  if (
    label.startsWith("panic-") &&
    process.env.TOKEN_LIFECYCLE_TEST_PANIC_REJECTION_NOOP === "1"
  ) {
    // Causal unsafe control: the shared verifier must reject a callback that
    // no longer performed the mounted-token refusal assertion.
    return undefined as unknown as { readonly label: string; readonly status: number; readonly code: string };
  }
  const response = await boundedFetch(`${origin}/v1/hello`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert(response.status === 401, `token-invalid-${label}`);
  const payload = ProblemDocumentSchema.parse(await response.json());
  assert(payload.code === "FELLOW_TOKEN_INVALID", `token-code-${label}`);
  return { label, status: response.status, code: payload.code };
}

await bootstrap(sponsorA);
await bootstrap(sponsorB);

const alpha = await mintClaimApprove("lifecycle-alpha", { proveScopeRefusal: true });
const expiring = await mintClaimApprove("lifecycle-expiring", { expiresInMs: 10_000 });
await new Promise((resolve) => setTimeout(resolve, 11_000));
await assertTokenRejected(expiring.token, "grant-expiry");

const charlie = await mintClaimApprove("lifecycle-charlie");
const delta = await mintClaimApprove("lifecycle-delta");
const echo = await mintClaimApprove("lifecycle-echo", {
  requestedScopes: ["promote", "review"],
});

// This fixed registry is the complete set of Fellows that this harness has
// actually minted, claimed, and approved. The separate cap enrollment below
// is intentionally absent because its approval is refused and it creates no
// Fellow credential row to cover.
const knownMintedFlows = [
  { label: "alpha", flow: alpha },
  { label: "expiring", flow: expiring },
  { label: "charlie", flow: charlie },
  { label: "delta", flow: delta },
  { label: "echo", flow: echo },
] as const;
assert(
  new Set(knownMintedFlows.map(({ flow }) => flow.fellowId)).size === knownMintedFlows.length,
  "known-minted-fellows-unique",
);

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

// ye45: measure the actual authenticated production pack route through local
// Workerd and real local D1. Five samples are descriptive local observations,
// not a p95, edge, or deployed performance claim. Contract parsing, stable
// bytes, the 129th-row cap witness, and a large selected prefix keep the timing
// record from going green on an empty or short-circuited response. Causal fault
// runs skip this unrelated wall-clock gate so host timing cannot preempt the
// later refusal each plant is responsible for proving.
const packSessionResult = await sessionPost(
  charlie.token,
  "/v1/sessions",
  { problem_id: packMeasurementProblemId, intent: "review" },
  key("pack-measurement-open"),
);
assert(packSessionResult.response.status === 201, "pack-measurement-session-open");
const packSession = SessionOpenResponseSchema.parse(packSessionResult.payload);
if (process.env.TOKEN_LIFECYCLE_TEST_EXPECTED_FAULT !== "1") {
  const PACK_MEASUREMENT_SAMPLE_COUNT = 5;
  const PACK_MEASUREMENT_PLAN_BUDGET_MS = 600;
  const packSamplesMs: number[] = [];
  let packBody: string | undefined;
  let packSelectedItems = 0;
  for (let sample = 0; sample < PACK_MEASUREMENT_SAMPLE_COUNT; sample += 1) {
    const startedAt = performance.now();
    const response = await boundedFetch(
      `${origin}/v1/sessions/${packSession.session_id}/pack?profile=working&max_tokens=8000`,
      {
        headers: { authorization: `Bearer ${charlie.token}`, connection: "close" },
      },
    );
    const body = await response.text();
    const durationMs = performance.now() - startedAt;
    assert(response.status === 200, `pack-measurement-status-${sample}`);
    assert(
      response.headers.get("cache-control") === "private, no-store",
      `pack-measurement-cache-${sample}`,
    );
    const pack = PackResponseSchema.parse(json(response, body));
    assert(pack.problem === packMeasurementProblemId, `pack-measurement-problem-${sample}`);
    assert(pack.budget_tokens === 8_000, `pack-measurement-budget-${sample}`);
    assert(
      pack.omitted.some(
        (entry) => entry.reason === "candidate_limit" && entry.detail === "claims",
      ),
      `pack-measurement-candidate-cap-${sample}`,
    );
    assert(pack.items.length >= 64, `pack-measurement-selected-prefix-${sample}`);
    if (packBody === undefined) {
      packBody = body;
      packSelectedItems = pack.items.length;
    } else {
      assert(body === packBody, `pack-measurement-deterministic-bytes-${sample}`);
      assert(pack.items.length === packSelectedItems, `pack-measurement-selected-count-${sample}`);
    }
    packSamplesMs.push(Number(durationMs.toFixed(3)));
  }
  const sortedPackSamplesMs = [...packSamplesMs].sort((left, right) => left - right);
  const packMedianMs = sortedPackSamplesMs[Math.floor(sortedPackSamplesMs.length / 2)];
  assert(packMedianMs !== undefined, "pack-measurement-median-present");
  const packMaxMs = Math.max(...packSamplesMs);
  const everyLocalSampleWithinPlanBudget = packMaxMs <= PACK_MEASUREMENT_PLAN_BUDGET_MS;
  console.log(
    JSON.stringify({
      suite: "token-lifecycle-local",
      record: "mounted-pack-performance-observation",
      assertion: "mounted_workerd_d1_pack_candidate_cap_measured",
      scope: "local-workerd-d1-mounted-production-route-not-p95-or-edge",
      candidate_claims: 130,
      selected_items: packSelectedItems,
      sample_count: packSamplesMs.length,
      samples_ms: packSamplesMs,
      median_ms: packMedianMs,
      max_ms: packMaxMs,
      plan_budget_ms: PACK_MEASUREMENT_PLAN_BUDGET_MS,
      status: everyLocalSampleWithinPlanBudget ? "pass" : "fail",
    }),
  );
  assert(everyLocalSampleWithinPlanBudget, "pack-measurement-plan-budget");
}
const packCloseResult = await sessionPost(
  charlie.token,
  `/v1/sessions/${packSession.session_id}/close`,
  {
    handback: "Mounted local Workerd pack measurement complete.",
    promote: [],
    keep: [],
    discard: [],
  },
  key("pack-measurement-close"),
);
assert(packCloseResult.response.status === 201, "pack-measurement-session-close");
const packClosed = SessionCloseResponseSchema.parse(packCloseResult.payload);
assert(packClosed.session_id === packSession.session_id, "pack-measurement-close-target");

const sessionOpen = SessionOpenResponseSchema.parse(
  await sessionReplayRace(
    "session_open",
    echo.token,
    "/v1/sessions",
    { problem_id: "P-TOKENLIFECYCLE", intent: "prove" },
    key("session-open-race"),
  ),
);
const workshopPush = WorkshopPushResponseSchema.parse(
  await sessionReplayRace(
    "workshop_push",
    echo.token,
    `/v1/sessions/${sessionOpen.session_id}/workshop`,
    {
      type: "draft",
      title: "Real D1 replay collision witness",
      body_md: "Two independent HTTP requests reached the same real D1 transaction boundary.",
      relates_to: [],
    },
    key("workshop-push-race"),
  ),
);
const promoted = PromoteResponseSchema.parse(
  await sessionReplayRace(
    "promote",
    echo.token,
    `/v1/sessions/${sessionOpen.session_id}/promote`,
    {
      workshop_id: workshopPush.workshop_id,
      kind: "theorem",
      statement: "The planted same-key real-D1 session mutation commits exactly once.",
      relates_to: [],
    },
    key("promote-race"),
  ),
);
assert(promoted.problem_id === "P-TOKENLIFECYCLE", "promote-race-problem");
assert(promoted.seq === 1, "promote-race-first-sequence");
const closed = SessionCloseResponseSchema.parse(
  await sessionReplayRace(
    "session_close",
    echo.token,
    `/v1/sessions/${sessionOpen.session_id}/close`,
    {
      handback: "Real D1 replay collision proof completed.",
      promote: [],
      keep: [],
      discard: [],
    },
    key("session-close-race"),
  ),
);
assert(closed.session_id === sessionOpen.session_id, "session-close-race-target");
assert(closed.promoted.length === 0, "session-close-race-no-implicit-promotion");
console.log(JSON.stringify({
  suite: "token-lifecycle-local",
  record: "session-replay-durable-identity",
  session_id: sessionOpen.session_id,
  workshop_id: workshopPush.workshop_id,
  claim_id: promoted.claim_id,
  seq: promoted.seq,
  status: "pass",
}));
console.log('{"suite":"token-lifecycle-local","assertion":"real_workerd_d1_session_open_workshop_promote_close_same_key_races","status":"pass"}');

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

const revokedSessionWrite = await sessionPost(
  alpha.token,
  "/v1/sessions",
  { problem_id: "P-TOKENLIFECYCLE", intent: "review" },
  key("post-revoke-session-open"),
);
expectProblem(revokedSessionWrite, 401, "FELLOW_TOKEN_INVALID");
console.log('{"suite":"token-lifecycle-local","assertion":"revoked_credential_refused_before_effectful_session_write","status":"pass"}');

// The HTTP assertion above reaches the mounted Fellow write path. This
// additional central-policy record binds the operator-only refusal reason to
// the durable revoke event without exposing it to the caller. The request id
// is the exact idempotency key that caused that event, not a second correlation
// id generated for the log line.
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
    problemId: "P-TOKENLIFECYCLE",
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
  assertion: "central_policy_post_revoke_refusal_matches_mounted_effectful_route",
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

// Take an authoritative, sponsor-safe row snapshot before panic. The shared
// verifier owns all exact row matching and terminal count derivation, so an
// omitted post-panic Fellow cannot make the zero-active check vacuously pass.
const beforePanic = await sponsorRequest(
  sponsorA,
  "GET",
  "/v1/fellows",
  "/v1/fellows",
  "fellows.list",
);
assert(beforePanic.response.status === 200, "fellows-before-panic");
const beforePanicFellows = SponsorFellowListResponseSchema.parse(beforePanic.payload);
const knownMintedRegistry = [
  { label: "alpha", fellowId: alpha.fellowId, beforePanicCredentialCardinality: 0 },
  { label: "expiring", fellowId: expiring.fellowId, beforePanicCredentialCardinality: 0 },
  {
    label: "charlie",
    fellowId: charlie.fellowId,
    beforePanicCredentialCardinality: winnerIndex === 0 ? 0 : 1,
  },
  {
    label: "delta",
    fellowId: delta.fellowId,
    beforePanicCredentialCardinality: winnerIndex === 1 ? 0 : 1,
  },
  { label: "echo", fellowId: echo.fellowId, beforePanicCredentialCardinality: 1 },
] as const satisfies readonly PanicCoverageRegistryEntry[];

// These are the only harness tokens still known active after expiry, the
// individual revoke, and the same-key different-body race. Recheck their
// identity inside the verifier immediately before it invokes panic.
const prePanicActiveTokens = [
  {
    label: "echo",
    fellowId: echo.fellowId,
    credentialId: activeCredentialFor(echo.fellowId).credential_id,
    token: echo.token,
  },
  {
    label: "different-body-loser",
    fellowId: differentBodies[loserIndex].flow.fellowId,
    credentialId: differentBodies[loserIndex].body.credential_id,
    token: differentBodies[loserIndex].flow.token,
  },
] as const;
const panicCoverage = await verifyPanicCoverage({
  registry: knownMintedRegistry,
  beforePanicFellows: beforePanicFellows.fellows,
  prePanicActiveTokens,
  assertTokenActive: async ({ label, fellowId, token }) => {
    const hello = await boundedFetch(`${origin}/v1/hello`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert(hello.status === 200, `token-active-before-panic-${label}`);
    const helloPayload = EnrollmentHelloResponseSchema.parse(await hello.json());
    assert(
      helloPayload.fellow.fellow_id === fellowId,
      `token-active-subject-before-panic-${label}`,
    );
    return { fellowId: helloPayload.fellow.fellow_id };
  },
  runPanic: async () => {
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
  },
  readAfterPanicFellows: async () => {
    const afterPanic = await sponsorRequest(
      sponsorA,
      "GET",
      "/v1/fellows",
      "/v1/fellows",
      "fellows.list",
    );
    assert(afterPanic.response.status === 200, "fellows-after-panic");
    const rows = SponsorFellowListResponseSchema.parse(afterPanic.payload).fellows;
    if (process.env.TOKEN_LIFECYCLE_TEST_PANIC_OMIT_AFTER_ROW === "1") {
      // Causal unsafe control: exact post-panic matching must fail rather
      // than accepting a vacuous all-inactive projection.
      const omitted = knownMintedRegistry.at(-1);
      assert(omitted !== undefined, "panic-registry-empty");
      return rows.filter((fellow) => fellow.fellow_id !== omitted.fellowId);
    }
    return rows;
  },
  assertTokenRejected: async ({ label, token }) => {
    const rejection = await assertTokenRejected(token, `panic-${label}`);
    return { ...rejection, label };
  },
});
emitPanicCoverage(panicCoverage);

console.log('{"suite":"token-lifecycle-local","assertion":"mint_use_scope_refusal_expiry_individual_revoke_panic_zero_active_credentials_cross_principal_exact_replay","status":"pass"}');
console.log('{"suite":"token-lifecycle-local","assertion":"revoke_vs_effectful_domain_write","status":"pass","route":"POST /v1/sessions","code":"FELLOW_TOKEN_INVALID"}');
BUN

CLIENT_SOURCE="${PANIC_COVERAGE_VERIFIER_SOURCE}"$'\n'"${CLIENT_SOURCE}"
require_remaining
TOKEN_LIFECYCLE_ORIGIN="${ORIGIN}" TOKEN_LIFECYCLE_PRIVATE_JWK="${PRIVATE_JWK}" \
  TOKEN_LIFECYCLE_BARRIER_CAPABILITY="${BARRIER_CAPABILITY}" \
  TOKEN_LIFECYCLE_AUTHZ_EVIDENCE_CANARY="${LOG_CANARY_BEARER}" \
  TOKEN_LIFECYCLE_PACK_PROBLEM_ID="${PACK_MEASUREMENT_PROBLEM_ID}" \
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
