import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  OwnedCommandResult,
  OwnedSessionFailurePhase,
} from "../../../../scripts/suite/cli.ts";
import {
  assertS3PublicProjectionShape,
  assertS3PublicValueSafe,
  assertS3RenderedFaceShape,
  normalizeS3ClaimStatement,
} from "../../src/split/local-worker.ts";

const root = resolve(import.meta.dir, "../../../..");

/**
 * Exact semantic manifest for the local Workerd proof. A count alone can stay
 * green when one assertion disappears and an unrelated assertion is added.
 * Keeping the names sorted makes a failure identify the missing or unexpected
 * product guarantee directly in Bun's bounded diff.
 */
const EXPECTED_LOCAL_BINDING_ASSERTIONS: string[] = [
  "R2_put_then_D1_failure_leaves_an_unreachable_orphan_and_retry_binds_without_a_cursor_burn",
  "S3_sequence_1_session_open_allocates_a_server_owned_id_and_reports_both_cursors",
  "S3_sequence_1b_caller_cannot_choose_a_session_identifier",
  "S3_sequence_2_working_pack_is_authenticated_and_carries_no_private_material",
  "S3_sequence_3a_a_push_requires_a_session_this_fellow_opened_on_this_problem",
  "S3_sequence_3b_workshop_push_moves_only_the_workshop_cursor_and_stays_invisible_publicly",
  "S3_sequence_3c_known_workshop_promotion_requires_owning_fellow_and_sponsor_without_candidate_or_public_side_effects",
  "S3_sequence_4_promotion_moves_the_public_cursor_exactly_once_and_the_public_delta_appears",
  "S4_allow_with_warning_publishes_a_safe_category_action_notice_without_provider_detail",
  "S4_authorized_benign_outage_fixture_degrades_to_a_public_warning_notice_not_a_silent_pass",
  "S4_concurrent_same_key_publishing_replays_the_exact_201_and_commits_one_event_action_and_receipt",
  "S4_contextual_aggregation_reads_all_four_D1_authorized_public_fields_and_holds_without_public_effect",
  "S4_direct_content_reject_is_not_downgraded_by_contextual_screening",
  "S4_extract_history_field_reaches_contextual_provider_without_public_effect",
  "S4_forged_detached_action_projection_never_reaches_the_public_face_and_reflects_nothing",
  "S4_forged_hard_category_published_clean_never_reaches_the_public_face_and_reflects_nothing",
  "S4_forged_quarantine_published_never_reaches_the_public_face_and_reflects_nothing",
  "S4_forged_status_code_from_another_outcome_never_reaches_the_public_face_and_reflects_nothing",
  "S4_frontier_receipts_revalidate_same_fellow_history_but_do_not_spuriously_invalidate_another_fellow",
  "S4_negative_content_context_dedup_is_expiring_receipted_and_never_leaks_into_public_projection",
  "S4_oversized_context_fails_closed_without_response_R2_event_or_export_canary_leakage",
  "S4_oversized_historical_artifact_is_omitted_before_materialization_and_later_benign_promotion_records_the_exact_omission",
  "S4_problem_statement_is_server_owned_and_caller_material_never_reflects",
  "S4_promotion_requires_an_explicit_idempotency_key_before_screening_or_public_effect",
  "S4_provider_exception_message_and_stack_are_a_coarse_private_hold_without_response_R2_event_or_export_leakage",
  "S4_provider_timeout_fails_closed_to_a_private_appealable_hold_without_public_cursor_or_artifact",
  "S4_public_artifact_md_history_field_reaches_contextual_provider_without_public_effect",
  "S4_replay_map_expires_after_24_hours_without_erasing_immutable_decision_history",
  "S4_statement_history_field_reaches_contextual_provider_without_public_effect",
  "S4_title_history_field_reaches_contextual_provider_without_public_effect",
  "all_fourteen_async_route_entry_faults_return_one_exact_nonreflective_binding_failure",
  "anonymous_or_stale_private_authority_is_not_found_without_a_private_cache_entry",
  "async_route_poison_roster_is_the_exact_ordered_unique_descriptor_signature_list",
  "authenticated_cross_sponsor_private_authority_is_indistinguishable_from_anonymous",
  "caller_cannot_choose_a_claim_identifier",
  "caller_cannot_choose_a_workshop_identifier",
  "concurrent_promotions_allocate_server_claim_ids_and_D1_RETURNING_public_sequences_without_burns",
  "concurrent_workshop_pushes_use_D1_RETURNING_sequences_without_duplicates_or_burns",
  "duplicate_and_P2_P4_refusals_leave_the_public_projection_at_its_original_cursor",
  "forged_receipt_route_poison_gate_precedes_both_fixture_authority_and_body_read",
  "forged_receipt_route_poison_outranks_the_body_read_under_valid_fixture_authority",
  "large_workshop_body_spills_to_R2_and_gets_a_server_owned_workshop_id",
  "local_workerd_reports_D1_and_R2_bindings_with_a_public_readiness_nonce_but_never_authority",
  "missing_private_id_cross_sponsor_authority_is_indistinguishable_from_anonymous",
  "missing_private_id_same_sponsor_authority_is_indistinguishable_from_anonymous",
  "missing_problem_never_fabricates_an_empty_public_projection",
  "near_duplicate_promotion_is_refused_citing_P11_without_a_cursor_burn",
  "one_promotion_atomically_allocates_the_first_public_claim_and_binds_its_public_artifact",
  "only_the_explicitly_published_public_artifact_is_readable_after_complete_D1_binding",
  "owner_private_read_crosses_R2_and_revalidates_the_D1_binding",
  "poisoned_results_are_produced_from_that_roster_one_result_per_descriptor",
  "post_promotion_face_validators_are_representation_specific",
  "post_promotion_html-fragment_is_a_private-free_rendered_face_with_a_representation_etag",
  "post_promotion_html-fragment_matching_validator_returns_a_private-free_304",
  "post_promotion_json_is_a_private-free_rendered_face_with_a_representation_etag",
  "post_promotion_json_matching_validator_returns_a_private-free_304",
  "post_promotion_md_is_a_private-free_rendered_face_with_a_representation_etag",
  "post_promotion_md_matching_validator_returns_a_private-free_304",
  "post_promotion_public_projection_search_and_export_apply_shape_guards",
  "private_not_found_response_is_invariant_across_existence_classes_for_each_principal",
  "private_only_problem_is_byte_indistinguishable_from_unknown_on_every_public_route",
  "public_errors_search_and_export_never_reflect_private_probe_material",
  "public_faces_begin_only_after_a_committed_ledger_event",
  "raw_C0_controls_cannot_collide_with_protected_math_tokens",
  "readiness_nonce_or_nonempty_route_binding_poison_headers_are_byte_for_byte_inert_on_every_async_route",
  "rendered_json_contains_only_one_public_ledger_item",
  "reused_idempotency_key_with_a_different_promotion_preserves_the_one_promotion_invariant",
  "self_certified_status_is_refused_citing_P2_P4",
  "sponsor_can_read_own_fellow_workshop_while_public_routes_disclose_nothing",
  "staged_private_digest_is_not_publicly_readable_before_promotion",
  "top_level_authoritative_fields_and_status_upgrades_are_refused_citing_P2_P4",
];

const LOCAL_WORKER_BUNDLE_SENTINELS = [
  "s3_local_workshops",
  "/__s3/workshops",
  "s3-local/private/staged/sha256/",
  "s3_local_fellow_workshop_ids",
] as const;

const S3_OWNED_COMMAND_TIMEOUT_MS = 100_000;
const S3_BUNDLE_TIMEOUT_MS = 10_000;
const S3_OWNED_TERM_GRACE_MS = 500;
const S3_OWNED_KILL_REAP_MS = 500;
const S3_OWNED_PIPE_DRAIN_MS = 500;
const S3_OWNED_STREAM_BYTES = 1_000_000;
const S3_OWNED_OUTPUT_BYTES = 1_000_000;
/**
 * The raw bundle is evidence, not a diagnostic. A one-command measurement of
 * the exact production/counterfactual build on 2026-08-20 observed maxima of
 * 1,186,765 raw canonical-evidence bytes and 1,291,325 nested-result bytes.
 *
 * Keep the ordinary owned-command diagnostics at 1 MB. This narrowly gives
 * the isolated graph proof 13,235 bytes above its measured raw maximum. Its
 * canonical fresh result remains below the existing 3 MB pinned-result cap:
 * strict canonical JSON cannot contain a literal control byte, and nesting it
 * in the result JSON expands only quote/backslash bytes, at most twofold. The
 * derived bound below verifies that relationship. A future larger bundle fails
 * closed at the isolated limit rather than widening any other transport.
 */
const S3_ISOLATED_BUILD_OUTPUT_EVIDENCE_MAX_BYTES = 1_350_000;
const S3_FRESH_RUNTIME_FIXED_GRACE_MS = 5_000;
const S3_FRESH_RUNTIME_RESULT_MAX_BYTES = 3 * S3_OWNED_OUTPUT_BYTES;
const S3_FRESH_RUNTIME_DIAGNOSTIC_MAX_BYTES = 1_024;
const S3_FRESH_RUNTIME_BOOTSTRAP_MAX_BYTES = 64 * 1024;
const S3_FRESH_RUNTIME_BOOTSTRAP_NAME = "bootstrap.json";
const S3_FRESH_RUNTIME_BOOTSTRAP_EXIT_CODE = 97;
const S3_FRESH_RUNTIME_RESULT_AUTHORITY_EXIT_CODE = 98;
const S3_FRESH_RUNTIME_RUNNER_AUTHORITY_EXIT_CODE = 99;
const S3_FRESH_RUNTIME_RUNNER_EXECUTION_EXIT_CODE = 100;
const S3_FRESH_RUNTIME_RESULT_SCHEMA_EXIT_CODE = 101;
const S3_FRESH_RUNTIME_RESULT_PUBLICATION_EXIT_CODE = 102;
const S3_FRESH_RUNTIME_RETAINED_COLLISION_EXIT_CODE = 92;
// The outer fresh helper has one monotonic deadline. It is never detached: on
// expiry the harness kills and reaps that exact helper before refusing its
// pinned result inode. The helper itself is only a lease holder; the imported
// runOwnedCommand remains the sole owner of the target process group.
const S3_FRESH_RUNTIME_DIRECT_REAP_MS = 1_000;
const S3_OUTER_DEADLINE_PLANT_MS = 2_000;
const S3_OUTER_LEASE_RETIRE_WAIT_MS = 5_000;
const S3_MARKER_INSPECTION_TIMEOUT_MS = 1_000;
const S3_MARKER_CENSUS_MAX_BYTES = 1_000_000;
const S3_MARKER_CENSUS_MAX_ATTEMPTS = 3;
const S3_OWNED_COMMAND_RUNNER_PATH = resolve(root, "scripts/suite/cli.ts");
const S3_OWNED_COMMAND_RUNNER_URL = pathToFileURL(S3_OWNED_COMMAND_RUNNER_PATH).href;

const OWNED_COMMAND_OUTCOMES = {
  exited: true,
  timeout: true,
  "output-overrun": true,
  "descendant-leaked": true,
  "pipe-drain-unproven": true,
  "inspection-unproven": true,
  "ownership-unproven": true,
  "spawn-failed": true,
} as const satisfies Record<OwnedCommandResult["outcome"], true>;

const OWNED_SESSION_FAILURE_PHASES = {
  "ready-record": true,
  "supervisor-pid": true,
  "terminal-record": true,
  "control-stream": true,
  "initial-census": true,
  "term-signal": true,
  "cleanup-deadline": true,
  "post-term-census": true,
  "kill-signal": true,
  "kill-reap": true,
  "final-census": true,
  "leader-release": true,
  "leader-reap": true,
} as const satisfies Record<OwnedSessionFailurePhase, true>;

interface S3OwnedCommandOptions {
  readonly timeoutMs: number;
  readonly retainedStreamBytes?: number;
  readonly retainedOutputBytes?: number;
  /** Test-only plant: proves a dispatcher deadline retires the inner owned group by lease EOF. */
  readonly outerTimeoutMs?: number;
  /** Test-only plant: target starts in the helper's private pinned result directory. */
  readonly targetCwd?: "private";
  /** Test-only plant: the post-run runner digest must fail after causal target execution. */
  readonly runnerDigestPlant?: "after";
  /** Test-only bootstrap refusal plants; all must leave the original inode authoritative. */
  readonly bootstrapPlant?:
    | "malformed"
    | "invalid-utf8"
    | "noncanonical"
    | "extra-record"
    | "partial"
    | "overrun"
    | "eof"
    | "runner-digest"
    | "tamper"
    | "symlink"
    | "path-swap";
}

function s3OwnedEnvironment(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TMPDIR: validatedFixtureRoot(),
  };
}

interface FreshRuntimeInvocation {
  readonly directory: string;
  readonly directoryFd: number;
  readonly directoryIdentity: ExactInodeIdentity;
  directoryFdClosed: boolean;
  readonly bootstrapPath: string;
  readonly bootstrapFd: number;
  readonly bootstrapIdentity: ExactFileIdentity;
  bootstrapFdClosed: boolean;
  readonly resultPath: string;
  readonly resultFd: number;
  readonly resultIdentity: ExactInodeIdentity;
  resultFdClosed: boolean;
  readonly nonce: string;
  readonly timeoutMs: number;
  readonly retainedStreamBytes: number;
  readonly retainedOutputBytes: number;
  readonly deadlineAt: number;
  readonly terminateAt: number;
  readonly helper: ReturnType<typeof Bun.spawn>;
  readonly stdoutCapture: FreshRuntimePipeCapture;
  readonly stderrCapture: FreshRuntimePipeCapture;
  helperKillRequested: boolean;
  timeoutWon: boolean;
  helperReaped: boolean;
  exitCode: number | undefined;
}

interface FreshRuntimePipeCapture {
  readonly complete: Promise<Buffer>;
  /** Resolves only after the helper has consumed and retired its bootstrap lease. */
  readonly startupReady?: Promise<void>;
  readonly cancellationRequested: () => boolean;
  readonly cancellationIsSettled: () => boolean;
  readonly cancellationSettled: () => Promise<void>;
  readonly byteLength: () => number;
  readonly cancel: () => Promise<void>;
}

interface FreshOwnedS3Result {
  readonly result: OwnedCommandResult;
  /** Normal exited releases are census-proven by runOwnedCommand; forced cleanup reports explicitly. */
  readonly cleanupProven: boolean;
}

interface ExactBigIntStat {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly isFile: () => boolean;
  readonly isDirectory: () => boolean;
}

interface ExactInodeIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly mode: string;
  readonly nlink: string;
}

interface ExactFileIdentity extends ExactInodeIdentity {
  readonly size: string;
}

interface FreshRuntimeBootstrap {
  readonly nonce: string;
  readonly result: ExactInodeIdentity;
  readonly directory: ExactInodeIdentity;
  readonly directoryPath: string;
  readonly runnerUrl: string;
  readonly runnerSha256: string;
  readonly options: {
    readonly command: readonly string[];
    readonly cwd: string;
    readonly env: Record<string, string>;
    readonly timeoutMs: number;
    readonly termGraceMs: number;
    readonly killReapMs: number;
    readonly pipeDrainMs: number;
    readonly retainedStreamBytes: number;
    readonly retainedOutputBytes: number;
  };
}

function s3OwnedCommandTimeout(options: S3OwnedCommandOptions): number {
  return (
    options.timeoutMs +
    S3_OWNED_TERM_GRACE_MS +
    S3_OWNED_KILL_REAP_MS +
    S3_OWNED_PIPE_DRAIN_MS +
    S3_FRESH_RUNTIME_FIXED_GRACE_MS
  );
}

function validatedFixtureRoot(): string {
  const candidates = [process.env.TMPDIR, tmpdir()];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.length === 0 || !isAbsolute(candidate)) continue;
    try {
      const canonical = realpathSync(candidate);
      if (!isAbsolute(canonical) || resolve(canonical) !== canonical) continue;
      const stat = lstatSync(canonical, { bigint: true }) as ExactBigIntStat;
      if (stat.isDirectory()) return canonical;
    } catch {
      // Try the portable platform fallback below.
    }
  }
  throw new Error("S3_FRESH_RUNTIME_TEMP_ROOT_UNAVAILABLE");
}

function makePrivateFixtureDirectory(): string {
  const created = mkdtempSync(join(validatedFixtureRoot(), "asimposium-s3-owned-command-"));
  chmodSync(created, 0o700);
  const directory = realpathSync(created);
  const stat = lstatSync(directory, { bigint: true }) as ExactBigIntStat;
  if (!stat.isDirectory() || (stat.mode & 0o777n) !== 0o700n) {
    throw new Error("S3_FRESH_RUNTIME_DIRECTORY_CREATE_UNPROVEN");
  }
  if (!isAbsolute(directory) || resolve(directory) !== directory) {
    throw new Error("S3_FRESH_RUNTIME_DIRECTORY_NOT_CANONICAL_ABSOLUTE");
  }
  return directory;
}

function exactInodeIdentity(stat: ExactBigIntStat): ExactInodeIdentity {
  return {
    dev: stat.dev.toString(10),
    ino: stat.ino.toString(10),
    mode: stat.mode.toString(10),
    nlink: stat.nlink.toString(10),
  };
}

function exactFileIdentity(stat: ExactBigIntStat): ExactFileIdentity {
  return {
    ...exactInodeIdentity(stat),
    size: stat.size.toString(10),
  };
}

function isCanonicalDecimal(value: string): boolean {
  return /^(?:0|[1-9][0-9]*)$/u.test(value);
}

function assertCanonicalIdentity(identity: ExactInodeIdentity, label: string): void {
  for (const [field, value] of Object.entries(identity)) {
    if (!isCanonicalDecimal(value)) {
      throw new Error(`${label}_IDENTITY_${field.toUpperCase()}_NOT_DECIMAL`);
    }
  }
}

function sameExactIdentity(stat: ExactBigIntStat, identity: ExactInodeIdentity): boolean {
  return (
    stat.dev.toString(10) === identity.dev &&
    stat.ino.toString(10) === identity.ino &&
    stat.mode.toString(10) === identity.mode &&
    stat.nlink.toString(10) === identity.nlink
  );
}

function sameExactFileIdentity(stat: ExactBigIntStat, identity: ExactFileIdentity): boolean {
  return sameExactIdentity(stat, identity) && stat.size.toString(10) === identity.size;
}

function sameIdentityExceptNlink(
  stat: ExactBigIntStat,
  identity: ExactInodeIdentity,
  nlink: bigint,
): boolean {
  return (
    stat.dev.toString(10) === identity.dev &&
    stat.ino.toString(10) === identity.ino &&
    stat.mode.toString(10) === identity.mode &&
    stat.nlink === nlink
  );
}

function samePinnedDirectoryIdentity(stat: ExactBigIntStat, identity: ExactInodeIdentity): boolean {
  return (
    stat.dev.toString(10) === identity.dev &&
    stat.ino.toString(10) === identity.ino &&
    stat.mode.toString(10) === identity.mode
  );
}

function assertPinnedFreshRuntimeDirectory(
  invocation: FreshRuntimeInvocation,
  label: string,
): ExactBigIntStat {
  const held = fstatSync(invocation.directoryFd, { bigint: true }) as ExactBigIntStat;
  const named = lstatSync(invocation.directory, { bigint: true }) as ExactBigIntStat;
  if (
    !held.isDirectory() ||
    !named.isDirectory() ||
    !samePinnedDirectoryIdentity(held, invocation.directoryIdentity) ||
    !samePinnedDirectoryIdentity(named, invocation.directoryIdentity)
  ) {
    throw new Error(`${label}_FRESH_RUNTIME_DIRECTORY_IDENTITY_MISMATCH`);
  }
  return held;
}

function makeFreshRuntimeDirectory(): {
  readonly directory: string;
  readonly directoryFd: number;
  readonly directoryIdentity: ExactInodeIdentity;
  readonly bootstrapPath: string;
  readonly bootstrapFd: number;
  readonly bootstrapCreationIdentity: ExactInodeIdentity;
  readonly resultPath: string;
  readonly resultFd: number;
  readonly resultIdentity: ExactInodeIdentity;
} {
  const directory = makePrivateFixtureDirectory();
  let directoryFd: number | undefined;
  let directoryOwned = false;
  try {
    directoryFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    directoryOwned = true;
    const directoryStat = fstatSync(directoryFd, { bigint: true }) as ExactBigIntStat;
    if (!directoryStat.isDirectory() || (directoryStat.mode & 0o777n) !== 0o700n) {
      throw new Error("S3_FRESH_RUNTIME_DIRECTORY_OPEN_UNPROVEN");
    }
    const directoryIdentity = exactInodeIdentity(directoryStat);
    assertCanonicalIdentity(directoryIdentity, "S3_FRESH_RUNTIME_DIRECTORY");
    const bootstrapPath = join(directory, S3_FRESH_RUNTIME_BOOTSTRAP_NAME);
    let bootstrapFd: number | undefined;
    let bootstrapOwned = false;
    try {
      bootstrapFd = openSync(
        bootstrapPath,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      bootstrapOwned = true;
      fchmodSync(bootstrapFd, 0o600);
      const bootstrap = fstatSync(bootstrapFd, { bigint: true }) as ExactBigIntStat;
      if (
        !bootstrap.isFile() ||
        (bootstrap.mode & 0o777n) !== 0o600n ||
        bootstrap.size !== 0n ||
        bootstrap.nlink !== 1n
      ) {
        throw new Error("S3_FRESH_RUNTIME_BOOTSTRAP_CREATE_UNPROVEN");
      }
      const bootstrapCreationIdentity = exactInodeIdentity(bootstrap);
      assertCanonicalIdentity(bootstrapCreationIdentity, "S3_FRESH_RUNTIME_BOOTSTRAP");

      const resultPath = join(directory, "result.json");
      let resultFd: number | undefined;
      let resultOwned = false;
      try {
        resultFd = openSync(
          resultPath,
          constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        resultOwned = true;
        fchmodSync(resultFd, 0o600);
        const result = fstatSync(resultFd, { bigint: true }) as ExactBigIntStat;
        if (
          !result.isFile() ||
          (result.mode & 0o777n) !== 0o600n ||
          result.size !== 0n ||
          result.nlink !== 1n
        ) {
          throw new Error("S3_FRESH_RUNTIME_RESULT_CREATE_UNPROVEN");
        }
        const resultIdentity = exactInodeIdentity(result);
        assertCanonicalIdentity(resultIdentity, "S3_FRESH_RUNTIME_RESULT");
        const created = {
          directory,
          directoryFd,
          directoryIdentity,
          bootstrapPath,
          bootstrapFd,
          bootstrapCreationIdentity,
          resultPath,
          resultFd,
          resultIdentity,
        };
        resultOwned = false;
        bootstrapOwned = false;
        directoryOwned = false;
        return created;
      } finally {
        if (resultOwned && resultFd !== undefined) {
          closeSync(resultFd);
        }
      }
    } finally {
      if (bootstrapOwned && bootstrapFd !== undefined) {
        closeSync(bootstrapFd);
      }
    }
  } finally {
    if (directoryOwned && directoryFd !== undefined) {
      closeSync(directoryFd);
    }
  }
}

function writeAllAt(fd: number, bytes: Buffer, label: string): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(fd, bytes, offset, bytes.byteLength - offset, offset);
    if (written <= 0) throw new Error(`${label}_PARTIAL_WRITE:${offset}`);
    offset += written;
  }
}

function pinFreshRuntimeBootstrap(
  bootstrapFd: number,
  creationIdentity: ExactInodeIdentity,
  bytes: Buffer,
): ExactFileIdentity {
  writeAllAt(bootstrapFd, bytes, "S3_FRESH_RUNTIME_BOOTSTRAP");
  fsyncSync(bootstrapFd);
  const pinned = fstatSync(bootstrapFd, { bigint: true }) as ExactBigIntStat;
  if (
    !pinned.isFile() ||
    !sameExactIdentity(pinned, creationIdentity) ||
    (pinned.mode & 0o777n) !== 0o600n ||
    pinned.nlink !== 1n ||
    pinned.size !== BigInt(bytes.byteLength)
  ) {
    throw new Error("S3_FRESH_RUNTIME_BOOTSTRAP_PIN_UNPROVEN");
  }
  const identity = exactFileIdentity(pinned);
  assertCanonicalIdentity(identity, "S3_FRESH_RUNTIME_BOOTSTRAP");
  return identity;
}

function freshRuntimeBootstrapDigest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function applyFreshRuntimeBootstrapPlant(
  path: string,
  fd: number,
  identity: ExactFileIdentity,
  canonicalBytes: Buffer,
  plant: S3OwnedCommandOptions["bootstrapPlant"],
): void {
  if (plant === "tamper") {
    const noncePrefix = Buffer.from('"nonce":"', "utf8");
    const nonceOffset = canonicalBytes.indexOf(noncePrefix) + noncePrefix.byteLength;
    if (nonceOffset < noncePrefix.byteLength || nonceOffset >= canonicalBytes.byteLength) {
      throw new Error("S3_FRESH_RUNTIME_BOOTSTRAP_TAMPER_SETUP_UNPROVEN");
    }
    const replacement = Buffer.from([canonicalBytes[nonceOffset] === 0x61 ? 0x62 : 0x61]);
    if (writeSync(fd, replacement, 0, replacement.byteLength, nonceOffset) !== 1) {
      throw new Error("S3_FRESH_RUNTIME_BOOTSTRAP_TAMPER_WRITE_UNPROVEN");
    }
    fsyncSync(fd);
    const tampered = fstatSync(fd, { bigint: true }) as ExactBigIntStat;
    if (!sameExactFileIdentity(tampered, identity)) {
      throw new Error("S3_FRESH_RUNTIME_BOOTSTRAP_TAMPER_IDENTITY_CHANGED");
    }
    return;
  }
  if (plant !== "symlink" && plant !== "path-swap") return;

  unlinkSync(path);
  if (plant === "symlink") {
    symlinkSync("result.json", path);
  } else {
    const replacementFd = openSync(
      path,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fchmodSync(replacementFd, 0o600);
      writeAllAt(replacementFd, canonicalBytes, "S3_FRESH_RUNTIME_BOOTSTRAP_PATH_SWAP");
      fsyncSync(replacementFd);
    } finally {
      closeSync(replacementFd);
    }
  }
  const original = fstatSync(fd, { bigint: true }) as ExactBigIntStat;
  if (
    !sameIdentityExceptNlink(original, identity, 0n) ||
    original.size.toString(10) !== identity.size
  ) {
    throw new Error("S3_FRESH_RUNTIME_BOOTSTRAP_PATH_SWAP_SETUP_UNPROVEN");
  }
}

function freshRuntimeDispatcherEnvironment(
  identity: ExactFileIdentity,
  digest: string,
  runnerDigestPlant: S3OwnedCommandOptions["runnerDigestPlant"],
): Record<string, string> {
  return {
    ...s3OwnedEnvironment(),
    S3_FRESH_RUNTIME_BOOTSTRAP_DEV: identity.dev,
    S3_FRESH_RUNTIME_BOOTSTRAP_INO: identity.ino,
    S3_FRESH_RUNTIME_BOOTSTRAP_MODE: identity.mode,
    S3_FRESH_RUNTIME_BOOTSTRAP_NLINK: identity.nlink,
    S3_FRESH_RUNTIME_BOOTSTRAP_SIZE: identity.size,
    S3_FRESH_RUNTIME_BOOTSTRAP_SHA256: digest,
    ...(runnerDigestPlant === "after"
      ? { S3_FRESH_RUNTIME_RUNNER_AFTER_SHA256: "0".repeat(64) }
      : {}),
  };
}

const FRESH_OWNED_COMMAND_DISPATCHER = String.raw`
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const BOOTSTRAP_MAX_BYTES = 65536;
const RESULT_MAX_BYTES = ${S3_FRESH_RUNTIME_RESULT_MAX_BYTES};
const BOOTSTRAP_EXIT_CODE = ${S3_FRESH_RUNTIME_BOOTSTRAP_EXIT_CODE};
const RESULT_AUTHORITY_EXIT_CODE = ${S3_FRESH_RUNTIME_RESULT_AUTHORITY_EXIT_CODE};
const RUNNER_AUTHORITY_EXIT_CODE = ${S3_FRESH_RUNTIME_RUNNER_AUTHORITY_EXIT_CODE};
const RUNNER_EXECUTION_EXIT_CODE = ${S3_FRESH_RUNTIME_RUNNER_EXECUTION_EXIT_CODE};
const RESULT_SCHEMA_EXIT_CODE = ${S3_FRESH_RUNTIME_RESULT_SCHEMA_EXIT_CODE};
const RESULT_PUBLICATION_EXIT_CODE = ${S3_FRESH_RUNTIME_RESULT_PUBLICATION_EXIT_CODE};
const RETAINED_COLLISION_EXIT_CODE = 92;
const BOOTSTRAP_NAME = "${S3_FRESH_RUNTIME_BOOTSTRAP_NAME}";
const RESULT_NAME = "result.json";
const RUNNER_URL = ${JSON.stringify(S3_OWNED_COMMAND_RUNNER_URL)};
const OWNED_OUTCOMES = new Set(${JSON.stringify(Object.keys(OWNED_COMMAND_OUTCOMES))});
const OWNED_FAILURE_PHASES = new Set(${JSON.stringify(Object.keys(OWNED_SESSION_FAILURE_PHASES))});
const decimal = /^(?:0|[1-9][0-9]*)$/u;
const sha256 = /^[0-9a-f]{64}$/u;
let bootstrapFd;
let resultFd;
let retainedFd;
let failureCode = BOOTSTRAP_EXIT_CODE;
const closeQuietly = (fd) => {
  if (fd === undefined) return;
  try { closeSync(fd); } catch {}
};
const failClosed = (code = failureCode) => {
  closeQuietly(retainedFd);
  closeQuietly(resultFd);
  closeQuietly(bootstrapFd);
  process.exit(code);
};
const writeAllAt = (fd, bytes) => {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(fd, bytes, offset, bytes.byteLength - offset, offset);
    if (written <= 0) throw new Error("fresh owned-command record write was partial");
    offset += written;
  }
};
const verifiesNamedDirectory = (directoryPath, identity) => {
  let directoryFd;
  try {
    if (!isAbsolute(directoryPath)) failClosed();
    const named = lstatSync(directoryPath, { bigint: true });
    if (
      !named.isDirectory() ||
      named.dev.toString(10) !== identity.dev ||
      named.ino.toString(10) !== identity.ino ||
      named.mode.toString(10) !== identity.mode
    ) {
      failClosed();
    }
    directoryFd = openSync(
      directoryPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const opened = fstatSync(directoryFd, { bigint: true });
    if (
      !opened.isDirectory() ||
      opened.dev.toString(10) !== identity.dev ||
      opened.ino.toString(10) !== identity.ino ||
      opened.mode.toString(10) !== identity.mode
    ) {
      failClosed();
    }
  } catch {
    failClosed();
  } finally {
    closeQuietly(directoryFd);
  }
};
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const hasExactKeys = (value, keys) =>
  isRecord(value) &&
  Object.keys(value).sort().join("\u0000") === [...keys].sort().join("\u0000");
const isIdentity = (value) =>
  hasExactKeys(value, ["dev", "ino", "mode", "nlink"]) &&
  ["dev", "ino", "mode", "nlink"].every((field) => decimal.test(value[field]));
const isStringRecord = (value) =>
  isRecord(value) &&
  Object.entries(value).every(
    ([key, entry]) =>
      key.length > 0 && !key.includes("\u0000") && !key.includes("=") && typeof entry === "string",
  );
const isSafeIntegerAtLeast = (value, floor) =>
  Number.isSafeInteger(value) && value >= floor;
const ownedOutcomeFieldsValid = ${ownedOutcomeFieldsValid.toString()};
const ownedCommandResultIsExact = ${ownedCommandResultIsExact.toString()};
const isOwnedResult = (value, options) =>
  ownedCommandResultIsExact(
    value,
    options.retainedStreamBytes,
    options.retainedOutputBytes,
    [...OWNED_OUTCOMES],
    [...OWNED_FAILURE_PHASES],
  );
const isBootstrap = (value) => {
  if (
    !hasExactKeys(value, ["nonce", "result", "directory", "directoryPath", "runnerUrl", "runnerSha256", "options"]) ||
    typeof value.nonce !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.nonce) ||
    value.runnerUrl !== RUNNER_URL ||
    typeof value.runnerSha256 !== "string" ||
    !sha256.test(value.runnerSha256) ||
    typeof value.directoryPath !== "string" ||
    !isAbsolute(value.directoryPath) ||
    !isIdentity(value.result) ||
    !isIdentity(value.directory) ||
    !hasExactKeys(value.options, [
      "command",
      "cwd",
      "env",
      "timeoutMs",
      "termGraceMs",
      "killReapMs",
      "pipeDrainMs",
      "retainedStreamBytes",
      "retainedOutputBytes",
    ])
  ) {
    return false;
  }
  const options = value.options;
  return (
    Array.isArray(options.command) &&
    options.command.length > 0 &&
    options.command.every((part) => typeof part === "string" && !part.includes("\u0000")) &&
    typeof options.cwd === "string" &&
    isAbsolute(options.cwd) &&
    isStringRecord(options.env) &&
    isSafeIntegerAtLeast(options.timeoutMs, 1) &&
    isSafeIntegerAtLeast(options.termGraceMs, 0) &&
    isSafeIntegerAtLeast(options.killReapMs, 0) &&
    isSafeIntegerAtLeast(options.pipeDrainMs, 0) &&
    isSafeIntegerAtLeast(options.retainedStreamBytes, 1) &&
    isSafeIntegerAtLeast(options.retainedOutputBytes, 1)
  );
};
const runnerDigestMatches = (bootstrap, expected = bootstrap.runnerSha256) => {
  try {
    const runnerPath = fileURLToPath(bootstrap.runnerUrl);
    return (
      isAbsolute(runnerPath) &&
      createHash("sha256").update(readFileSync(runnerPath)).digest("hex") === expected
    );
  } catch {
    return false;
  }
};
const expectedBootstrapIdentity = () => {
  const identity = {
    dev: process.env.S3_FRESH_RUNTIME_BOOTSTRAP_DEV,
    ino: process.env.S3_FRESH_RUNTIME_BOOTSTRAP_INO,
    mode: process.env.S3_FRESH_RUNTIME_BOOTSTRAP_MODE,
    nlink: process.env.S3_FRESH_RUNTIME_BOOTSTRAP_NLINK,
    size: process.env.S3_FRESH_RUNTIME_BOOTSTRAP_SIZE,
  };
  const digest = process.env.S3_FRESH_RUNTIME_BOOTSTRAP_SHA256;
  if (
    !["dev", "ino", "mode", "nlink", "size"].every((field) => decimal.test(identity[field])) ||
    !sha256.test(digest ?? "")
  ) {
    failClosed(BOOTSTRAP_EXIT_CODE);
  }
  return { identity, digest };
};
const readBootstrap = () => {
  const expected = expectedBootstrapIdentity();
  try {
    bootstrapFd = openSync(BOOTSTRAP_NAME, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    failClosed(BOOTSTRAP_EXIT_CODE);
  }
  const opened = fstatSync(bootstrapFd, { bigint: true });
  if (
    !opened.isFile() ||
    opened.dev.toString(10) !== expected.identity.dev ||
    opened.ino.toString(10) !== expected.identity.ino ||
    opened.mode.toString(10) !== expected.identity.mode ||
    opened.nlink.toString(10) !== expected.identity.nlink ||
    opened.size.toString(10) !== expected.identity.size ||
    (opened.mode & 0o777n) !== 0o600n ||
    opened.nlink !== 1n ||
    opened.size <= 0n ||
    opened.size > BigInt(BOOTSTRAP_MAX_BYTES)
  ) {
    failClosed(BOOTSTRAP_EXIT_CODE);
  }
  const size = Number(opened.size);
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const read = readSync(bootstrapFd, bytes, offset, size - offset, offset);
    if (read <= 0) failClosed(BOOTSTRAP_EXIT_CODE);
    offset += read;
  }
  const reread = fstatSync(bootstrapFd, { bigint: true });
  if (
    !reread.isFile() ||
    reread.dev !== opened.dev ||
    reread.ino !== opened.ino ||
    reread.mode !== opened.mode ||
    reread.nlink !== opened.nlink ||
    reread.size !== opened.size
  ) {
    failClosed(BOOTSTRAP_EXIT_CODE);
  }
  unlinkSync(BOOTSTRAP_NAME);
  const unlinked = fstatSync(bootstrapFd, { bigint: true });
  if (
    !unlinked.isFile() ||
    unlinked.dev !== opened.dev ||
    unlinked.ino !== opened.ino ||
    unlinked.mode !== opened.mode ||
    unlinked.nlink !== 0n ||
    unlinked.size !== opened.size
  ) {
    failClosed(BOOTSTRAP_EXIT_CODE);
  }
  closeQuietly(bootstrapFd);
  bootstrapFd = undefined;
  if (createHash("sha256").update(bytes).digest("hex") !== expected.digest) {
    failClosed(BOOTSTRAP_EXIT_CODE);
  }
  if (bytes.at(-1) !== 0x0a || bytes.subarray(0, -1).includes(0x0a) || bytes.includes(0x0d)) {
    failClosed(BOOTSTRAP_EXIT_CODE);
  }
  let value;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    failClosed(BOOTSTRAP_EXIT_CODE);
  }
  const canonical = Buffer.from(JSON.stringify(value) + "\n", "utf8");
  if (!canonical.equals(bytes) || !isBootstrap(value)) failClosed(BOOTSTRAP_EXIT_CODE);
  return value;
};
try {
  const bootstrap = readBootstrap();
  failureCode = RESULT_AUTHORITY_EXIT_CODE;
  const identity = bootstrap?.result;
  const directory = bootstrap?.directory;
  const directoryPath = bootstrap?.directoryPath;
  resultFd = openSync(RESULT_NAME, constants.O_RDWR | constants.O_NOFOLLOW);
  const opened = fstatSync(resultFd, { bigint: true });
  if (
    !opened.isFile() ||
    opened.dev.toString(10) !== identity.dev ||
    opened.ino.toString(10) !== identity.ino ||
    opened.mode.toString(10) !== identity.mode ||
    opened.nlink.toString(10) !== identity.nlink ||
    opened.size !== 0n ||
    opened.nlink !== 1n
  ) {
    failClosed(BOOTSTRAP_EXIT_CODE);
  }
  verifiesNamedDirectory(directoryPath, directory);
  unlinkSync(RESULT_NAME);
  const unlinked = fstatSync(resultFd, { bigint: true });
  if (
    !unlinked.isFile() ||
    unlinked.dev.toString(10) !== identity.dev ||
    unlinked.ino.toString(10) !== identity.ino ||
    unlinked.mode.toString(10) !== identity.mode ||
    unlinked.nlink !== 0n ||
    unlinked.size !== 0n
  ) {
    failClosed(BOOTSTRAP_EXIT_CODE);
  }
  // The fixed result name is gone, and the held inode has nlink zero, before
  // this dynamic import can execute target code.
  failureCode = RUNNER_AUTHORITY_EXIT_CODE;
  if (!runnerDigestMatches(bootstrap)) failClosed();
  const module = await import(bootstrap.runnerUrl);
  failureCode = RUNNER_EXECUTION_EXIT_CODE;
  const result = await module.runOwnedCommand(bootstrap.options);
  failureCode = RUNNER_AUTHORITY_EXIT_CODE;
  const runnerAfterSha256 = process.env.S3_FRESH_RUNTIME_RUNNER_AFTER_SHA256;
  if (
    (runnerAfterSha256 !== undefined && !sha256.test(runnerAfterSha256)) ||
    !runnerDigestMatches(bootstrap, runnerAfterSha256 ?? bootstrap.runnerSha256)
  ) {
    failClosed();
  }
  failureCode = RESULT_SCHEMA_EXIT_CODE;
  if (!isOwnedResult(result, bootstrap.options)) failClosed();
  failureCode = RESULT_PUBLICATION_EXIT_CODE;
  const cleanupProven = result.outcome === "exited" ? true : result.cleanupProven === true;
  const publication = Buffer.from(JSON.stringify({
    nonce: bootstrap.nonce,
    kind: "result",
    result,
    cleanupProven,
  }) + "\n", "utf8");
  if (publication.byteLength === 0 || publication.byteLength > RESULT_MAX_BYTES) {
    throw new Error("result overrun");
  }
  writeAllAt(resultFd, publication);
  fsyncSync(resultFd);
  const published = fstatSync(resultFd, { bigint: true });
  if (
    !published.isFile() ||
    published.dev.toString(10) !== identity.dev ||
    published.ino.toString(10) !== identity.ino ||
    published.mode.toString(10) !== identity.mode ||
    published.nlink !== 0n ||
    published.size !== BigInt(publication.byteLength)
  ) {
    throw new Error("result publication changed");
  }
  if (cleanupProven) {
    // This is evidence only. The original unlinked inode above remains the
    // authority channel; any replacement collision is an unparseable refusal.
    // The target is gone. Rebind the canonical parent name and exact identity
    // before deriving the retained path; a renamed cwd cannot redirect this.
    verifiesNamedDirectory(directoryPath, directory);
    try {
      retainedFd = openSync(
        join(directoryPath, RESULT_NAME),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    } catch {
      failClosed(RETAINED_COLLISION_EXIT_CODE);
    }
    fchmodSync(retainedFd, 0o600);
    writeAllAt(retainedFd, publication);
    fsyncSync(retainedFd);
    const retained = fstatSync(retainedFd, { bigint: true });
    if (
      !retained.isFile() ||
      (retained.mode & 0o777n) !== 0o600n ||
      retained.nlink !== 1n ||
      retained.size !== BigInt(publication.byteLength)
    ) {
      failClosed(RETAINED_COLLISION_EXIT_CODE);
    }
    closeQuietly(retainedFd);
    retainedFd = undefined;
  }
  closeQuietly(resultFd);
  resultFd = undefined;
} catch {
  failClosed();
}
`;

function beginFreshRuntimePipeCapture(
  stream: ReadableStream<Uint8Array>,
  byteCeiling: number,
  label: string,
  startupRecord?: Buffer,
): FreshRuntimePipeCapture {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let readerReleased = false;
  let startupSettled = startupRecord === undefined;
  let startupObserved = Buffer.alloc(0);
  let resolveStartup: (() => void) | undefined;
  let rejectStartup: ((error: Error) => void) | undefined;
  let cancellation: Promise<void> | undefined;
  let cancellationComplete = false;
  const startupReady =
    startupRecord === undefined
      ? undefined
      : new Promise<void>((resolve, reject) => {
          resolveStartup = resolve;
          rejectStartup = reject;
        });
  const rejectStartupOnce = (detail: string) => {
    if (startupSettled) return;
    startupSettled = true;
    rejectStartup?.(new Error(`${label}_${detail}`));
  };
  const cancel = (): Promise<void> => {
    if (cancellation !== undefined) return cancellation;
    if (readerReleased) {
      cancellation = Promise.resolve();
      cancellationComplete = true;
      return cancellation;
    }
    try {
      cancellation = reader.cancel().then(
        () => {
          cancellationComplete = true;
        },
        (error: unknown) => {
          cancellationComplete = true;
          throw error;
        },
      );
    } catch (error) {
      cancellation = Promise.reject(error);
      cancellationComplete = true;
    }
    void cancellation.catch(() => undefined);
    return cancellation;
  };
  const complete = (async (): Promise<Buffer> => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const bytes = Buffer.from(value);
        totalBytes += bytes.byteLength;
        if (totalBytes > byteCeiling) {
          void cancel();
          throw new Error(`${label}_FRESH_RUNTIME_PIPE_OVERRUN:${totalBytes}`);
        }
        if (startupRecord !== undefined && !startupSettled) {
          startupObserved = Buffer.concat(
            [startupObserved, bytes],
            startupObserved.byteLength + bytes.byteLength,
          );
          if (
            startupObserved.byteLength > startupRecord.byteLength ||
            !startupRecord.subarray(0, startupObserved.byteLength).equals(startupObserved)
          ) {
            rejectStartupOnce("FRESH_RUNTIME_STARTUP_RECORD_INVALID");
            void cancel();
            throw new Error(`${label}_FRESH_RUNTIME_STARTUP_RECORD_INVALID`);
          }
          if (startupObserved.byteLength === startupRecord.byteLength) {
            startupSettled = true;
            resolveStartup?.();
          }
        }
        chunks.push(bytes);
      }
      return Buffer.concat(chunks, totalBytes);
    } finally {
      if (startupRecord !== undefined && !startupSettled) {
        rejectStartupOnce("FRESH_RUNTIME_STARTUP_RECORD_MISSING");
      }
      readerReleased = true;
      reader.releaseLock();
    }
  })();
  void complete.catch(() => undefined);
  void startupReady?.catch(() => undefined);
  return {
    complete,
    startupReady,
    cancellationRequested: () => cancellation !== undefined,
    cancellationIsSettled: () => cancellationComplete,
    cancellationSettled: () => cancellation ?? Promise.resolve(),
    byteLength: () => totalBytes,
    cancel,
  };
}

function closeFreshRuntimeCreationFds(
  bootstrapFd: number,
  resultFd: number,
  directoryFd: number,
): void {
  try {
    closeSync(bootstrapFd);
  } finally {
    try {
      closeSync(resultFd);
    } finally {
      closeSync(directoryFd);
    }
  }
}

async function invokeFreshOwnedS3Command(
  command: readonly string[],
  options: S3OwnedCommandOptions,
): Promise<FreshRuntimeInvocation> {
  const timeoutMs = options.outerTimeoutMs ?? s3OwnedCommandTimeout(options);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= S3_FRESH_RUNTIME_DIRECT_REAP_MS) {
    throw new Error(`S3_FRESH_RUNTIME_TIMEOUT_INVALID:${timeoutMs}`);
  }
  const deadlineAt = performance.now() + timeoutMs;
  const terminateAt = deadlineAt - S3_FRESH_RUNTIME_DIRECT_REAP_MS;
  const {
    directory,
    directoryFd,
    directoryIdentity,
    bootstrapPath,
    bootstrapFd,
    bootstrapCreationIdentity,
    resultPath,
    resultFd,
    resultIdentity,
  } = makeFreshRuntimeDirectory();
  const nonce = crypto.randomUUID();
  const retainedStreamBytes = options.retainedStreamBytes ?? S3_OWNED_STREAM_BYTES;
  const retainedOutputBytes = options.retainedOutputBytes ?? S3_OWNED_OUTPUT_BYTES;
  const runnerSha256 = freshRuntimeBootstrapDigest(readFileSync(S3_OWNED_COMMAND_RUNNER_PATH));
  const serializable = {
    command,
    cwd: options.targetCwd === "private" ? directory : root,
    env: {
      ...s3OwnedEnvironment(),
      S3_FRESH_RUNTIME_BOOTSTRAP_DEV: bootstrapCreationIdentity.dev,
      S3_FRESH_RUNTIME_BOOTSTRAP_INO: bootstrapCreationIdentity.ino,
      S3_FRESH_RUNTIME_RESULT_DEV: resultIdentity.dev,
      S3_FRESH_RUNTIME_RESULT_INO: resultIdentity.ino,
    },
    timeoutMs: options.timeoutMs,
    termGraceMs: S3_OWNED_TERM_GRACE_MS,
    killReapMs: S3_OWNED_KILL_REAP_MS,
    pipeDrainMs: S3_OWNED_PIPE_DRAIN_MS,
    retainedStreamBytes,
    retainedOutputBytes,
  };
  let helper: ReturnType<typeof Bun.spawn> | undefined;
  let stdoutCapture: FreshRuntimePipeCapture | undefined;
  let stderrCapture: FreshRuntimePipeCapture | undefined;
  try {
    const bootstrap = freshRuntimeBootstrapBytes(
      {
        nonce,
        result: resultIdentity,
        directory: directoryIdentity,
        directoryPath: directory,
        runnerUrl: S3_OWNED_COMMAND_RUNNER_URL,
        runnerSha256,
        options: serializable,
      },
      options.bootstrapPlant,
    );
    const bootstrapIdentity = pinFreshRuntimeBootstrap(
      bootstrapFd,
      bootstrapCreationIdentity,
      bootstrap,
    );
    const bootstrapDigest = freshRuntimeBootstrapDigest(bootstrap);
    applyFreshRuntimeBootstrapPlant(
      bootstrapPath,
      bootstrapFd,
      bootstrapIdentity,
      bootstrap,
      options.bootstrapPlant,
    );
    if (terminateAt <= performance.now()) {
      throw new Error("S3_FRESH_RUNTIME_STARTUP_RESERVE_UNAVAILABLE");
    }
    helper = Bun.spawn({
      cmd: [process.execPath, "-e", FRESH_OWNED_COMMAND_DISPATCHER],
      cwd: directory,
      env: freshRuntimeDispatcherEnvironment(
        bootstrapIdentity,
        bootstrapDigest,
        options.runnerDigestPlant,
      ),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (!(helper.stdout instanceof ReadableStream) || !(helper.stderr instanceof ReadableStream)) {
      throw new Error("S3_FRESH_RUNTIME_CAPTURE_INIT_UNAVAILABLE");
    }
    stdoutCapture = beginFreshRuntimePipeCapture(
      helper.stdout,
      S3_FRESH_RUNTIME_RESULT_MAX_BYTES,
      "S3_FRESH_RUNTIME_STDOUT",
    );
    stderrCapture = beginFreshRuntimePipeCapture(
      helper.stderr,
      S3_FRESH_RUNTIME_DIAGNOSTIC_MAX_BYTES,
      "S3_FRESH_RUNTIME_STDERR",
    );
    return {
      directory,
      directoryFd,
      directoryIdentity,
      directoryFdClosed: false,
      bootstrapPath,
      bootstrapFd,
      bootstrapIdentity,
      bootstrapFdClosed: false,
      resultPath,
      resultFd,
      resultIdentity,
      resultFdClosed: false,
      nonce,
      timeoutMs,
      retainedStreamBytes,
      retainedOutputBytes,
      deadlineAt,
      terminateAt,
      helper,
      stdoutCapture,
      stderrCapture,
      helperKillRequested: false,
      timeoutWon: false,
      helperReaped: false,
      exitCode: undefined,
    };
  } catch (error) {
    if (helper !== undefined) {
      try {
        if (helper.exitCode === null && helper.signalCode === null) helper.kill("SIGKILL");
      } catch {
        // Bounded reap below remains authoritative.
      }
      const reaped = await freshRuntimeExitBefore(helper.exited, deadlineAt);
      if (reaped === undefined) {
        void stdoutCapture?.cancel();
        void stderrCapture?.cancel();
        closeFreshRuntimeCreationFds(bootstrapFd, resultFd, directoryFd);
        throw new Error("S3_FRESH_RUNTIME_CAPTURE_INIT_REAP_UNPROVEN");
      }
    }
    try {
      await settleFreshRuntimeCaptureCancellation(
        [stdoutCapture, stderrCapture],
        deadlineAt,
        "S3_FRESH_RUNTIME_STARTUP_CAPTURE_CANCEL",
      );
    } catch {
      closeFreshRuntimeCreationFds(bootstrapFd, resultFd, directoryFd);
      throw new Error("S3_FRESH_RUNTIME_STARTUP_CAPTURE_CANCEL_UNPROVEN");
    }
    closeFreshRuntimeCreationFds(bootstrapFd, resultFd, directoryFd);
    throw error;
  }
}

function freshRuntimeBootstrapBytes(
  bootstrap: FreshRuntimeBootstrap,
  plant: S3OwnedCommandOptions["bootstrapPlant"],
): Buffer {
  const canonical = Buffer.from(`${JSON.stringify(bootstrap)}\n`, "utf8");
  if (canonical.byteLength === 0 || canonical.byteLength > S3_FRESH_RUNTIME_BOOTSTRAP_MAX_BYTES) {
    throw new Error("S3_FRESH_RUNTIME_BOOTSTRAP_OVERRUN");
  }
  switch (plant) {
    case undefined:
      return canonical;
    case "malformed":
      return Buffer.from(`{"nonce":${JSON.stringify(bootstrap.nonce)}}\n`, "utf8");
    case "invalid-utf8":
      return Buffer.from([0xff, 0x0a]);
    case "noncanonical":
      return Buffer.from(`${JSON.stringify(bootstrap)} \n`, "utf8");
    case "extra-record":
      return Buffer.concat([canonical, canonical]);
    case "partial":
      return canonical.subarray(0, -1);
    case "overrun":
      return Buffer.concat([canonical, Buffer.alloc(S3_FRESH_RUNTIME_BOOTSTRAP_MAX_BYTES, 0x20)]);
    case "eof":
      return Buffer.alloc(0);
    case "runner-digest":
      return Buffer.from(
        `${JSON.stringify({ ...bootstrap, runnerSha256: "0".repeat(64) })}\n`,
        "utf8",
      );
    case "tamper":
    case "symlink":
    case "path-swap":
      return canonical;
  }
}

async function freshRuntimeValueBefore<T>(
  value: Promise<T>,
  deadlineAt: number,
  label: string,
): Promise<T> {
  const remainingMs = deadlineAt - performance.now();
  if (remainingMs <= 0) throw new Error(`${label}_DEADLINE`);
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}_DEADLINE`)), remainingMs);
    void value.then(
      (resolved) => {
        clearTimeout(timer);
        resolve(resolved);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function settleFreshRuntimeCaptureCancellation(
  captures: readonly (FreshRuntimePipeCapture | undefined)[],
  deadlineAt: number,
  label: string,
): Promise<void> {
  const cancellation = Promise.all(
    captures.map((capture) => capture?.cancel() ?? Promise.resolve()),
  ).then(() => undefined);
  if (performance.now() >= deadlineAt) {
    if (captures.every((capture) => capture === undefined || capture.cancellationIsSettled())) {
      await cancellation;
      return;
    }
    throw new Error(`${label}_DEADLINE`);
  }
  await freshRuntimeValueBefore(cancellation, deadlineAt, label);
}

function closeFreshRuntimeBootstrap(invocation: FreshRuntimeInvocation): void {
  if (invocation.bootstrapFdClosed) return;
  invocation.bootstrapFdClosed = true;
  closeSync(invocation.bootstrapFd);
}

function closeFreshRuntimeResult(invocation: FreshRuntimeInvocation): void {
  if (invocation.resultFdClosed) return;
  invocation.resultFdClosed = true;
  closeSync(invocation.resultFd);
}

function closeFreshRuntimeDirectory(invocation: FreshRuntimeInvocation): void {
  if (invocation.directoryFdClosed) return;
  invocation.directoryFdClosed = true;
  closeSync(invocation.directoryFd);
}

function freshRuntimePublicationDiagnostic(invocation: FreshRuntimeInvocation): string {
  try {
    const stat = fstatSync(invocation.resultFd, { bigint: true }) as ExactBigIntStat;
    return (
      ":RESULT_HELPER_EXIT:" +
      (invocation.exitCode ?? invocation.helper.exitCode ?? "unavailable") +
      ":RESULT_HELPER_SIGNAL:" +
      (invocation.helper.signalCode ?? "none") +
      ":RESULT_MODE:" +
      (stat.mode & 0o777n).toString(8) +
      ":RESULT_SIZE:" +
      stat.size +
      ":RESULT_DEV:" +
      stat.dev +
      ":RESULT_INO:" +
      stat.ino
    );
  } catch (error) {
    return `:RESULT_DIAGNOSTIC_FAILED:${error instanceof Error ? error.name : "unknown"}`;
  }
}

async function freshRuntimeExitBefore(
  exited: Promise<number>,
  deadlineAt: number,
): Promise<number | undefined> {
  const remainingMs = deadlineAt - performance.now();
  if (remainingMs <= 0) return undefined;
  return await new Promise<number | undefined>((resolve) => {
    let completed = false;
    const complete = (exitCode: number | undefined) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      resolve(exitCode);
    };
    const timer = setTimeout(() => complete(undefined), remainingMs);
    void exited.then(
      (exitCode) => complete(exitCode),
      () => complete(undefined),
    );
  });
}

async function freshRuntimePipeBefore(
  capture: FreshRuntimePipeCapture,
  deadlineAt: number,
  label: string,
): Promise<Buffer> {
  const remainingMs = deadlineAt - performance.now();
  if (remainingMs <= 0) {
    void capture.cancel();
    throw new Error(`${label}_FRESH_RUNTIME_PIPE_DRAIN_UNPROVEN`);
  }
  return await new Promise<Buffer>((resolve, reject) => {
    let completed = false;
    const finish = (action: () => void) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      action();
    };
    const timer = setTimeout(() => {
      void capture.cancel();
      finish(() => reject(new Error(`${label}_FRESH_RUNTIME_PIPE_DRAIN_UNPROVEN`)));
    }, remainingMs);
    void capture.complete.then(
      (content) => finish(() => resolve(content)),
      (error) => finish(() => reject(error)),
    );
  });
}

type FreshRuntimeSettlement = "exited" | "timed-out" | "reap-unproven";

async function settleFreshRuntime(
  invocation: FreshRuntimeInvocation,
): Promise<FreshRuntimeSettlement> {
  if (invocation.helperReaped) return invocation.timeoutWon ? "timed-out" : "exited";
  const directExit = await freshRuntimeExitBefore(invocation.helper.exited, invocation.terminateAt);
  if (directExit !== undefined) {
    invocation.exitCode = directExit;
    invocation.helperReaped = true;
    return "exited";
  }

  // The timeout wins even if a late exit races this branch: after this point no
  // result bytes are parsed, including a late status-0 publication.
  invocation.timeoutWon = true;
  try {
    if (invocation.helper.exitCode === null && invocation.helper.signalCode === null) {
      invocation.helperKillRequested = true;
      invocation.helper.kill("SIGKILL");
    }
  } catch {
    // A concurrent direct exit is reconciled by the bounded reap below.
  }
  const reapedExit = await freshRuntimeExitBefore(invocation.helper.exited, invocation.deadlineAt);
  if (reapedExit === undefined) return "reap-unproven";
  invocation.exitCode = reapedExit;
  invocation.helperReaped = true;
  return "timed-out";
}

async function retireFreshRuntime(invocation: FreshRuntimeInvocation): Promise<void> {
  try {
    if (!invocation.helperReaped) {
      try {
        if (invocation.helper.exitCode === null && invocation.helper.signalCode === null) {
          invocation.helperKillRequested = true;
          invocation.helper.kill("SIGKILL");
        }
      } catch {
        // The bounded reap below is authoritative.
      }
      const reapedExit = await freshRuntimeExitBefore(
        invocation.helper.exited,
        invocation.deadlineAt,
      );
      if (reapedExit !== undefined) {
        invocation.exitCode = reapedExit;
        invocation.helperReaped = true;
      }
    }
    if (!invocation.helperReaped) throw new Error("S3_FRESH_RUNTIME_REAP_UNPROVEN");
  } finally {
    await settleFreshRuntimeCaptureCancellation(
      [invocation.stdoutCapture, invocation.stderrCapture],
      invocation.deadlineAt,
      "S3_FRESH_RUNTIME_RETIRE_CAPTURE_CANCEL",
    );
  }
}

async function retireAndCloseFreshRuntime(
  invocation: FreshRuntimeInvocation,
  retire: (current: FreshRuntimeInvocation) => Promise<void> = retireFreshRuntime,
): Promise<void> {
  try {
    await retire(invocation);
  } finally {
    try {
      closeFreshRuntimeBootstrap(invocation);
    } finally {
      try {
        closeFreshRuntimeResult(invocation);
      } finally {
        closeFreshRuntimeDirectory(invocation);
      }
    }
  }
}

async function assertFreshRuntimeExited(
  invocation: FreshRuntimeInvocation,
  label: string,
): Promise<void> {
  const settlement = await settleFreshRuntime(invocation);
  const failure = (detail: string): never => {
    throw new Error(`${label}_${detail}${freshRuntimePublicationDiagnostic(invocation)}`);
  };
  if (invocation.timeoutWon || settlement === "timed-out") {
    failure(`FRESH_RUNTIME_DEADLINE:${invocation.timeoutMs}`);
  }
  if (settlement === "reap-unproven") failure("FRESH_RUNTIME_REAP_UNPROVEN");
  if (!invocation.helperReaped) failure("FRESH_RUNTIME_REAP_UNPROVEN");
  if (invocation.helper.signalCode !== null) {
    failure(`FRESH_RUNTIME_SIGNAL:${invocation.helper.signalCode}`);
  }
  if (invocation.exitCode !== 0) {
    if (invocation.exitCode === S3_FRESH_RUNTIME_RETAINED_COLLISION_EXIT_CODE) {
      failure("FRESH_RUNTIME_RETAINED_REPUBLISH_REFUSED");
    }
    const typedFailure = new Map<number, string>([
      [S3_FRESH_RUNTIME_BOOTSTRAP_EXIT_CODE, "FRESH_RUNTIME_BOOTSTRAP_AUTHORITY_REFUSED"],
      [S3_FRESH_RUNTIME_RESULT_AUTHORITY_EXIT_CODE, "FRESH_RUNTIME_RESULT_AUTHORITY_REFUSED"],
      [S3_FRESH_RUNTIME_RUNNER_AUTHORITY_EXIT_CODE, "FRESH_RUNTIME_RUNNER_AUTHORITY_REFUSED"],
      [S3_FRESH_RUNTIME_RUNNER_EXECUTION_EXIT_CODE, "FRESH_RUNTIME_RUNNER_EXECUTION_REFUSED"],
      [S3_FRESH_RUNTIME_RESULT_SCHEMA_EXIT_CODE, "FRESH_RUNTIME_RESULT_SCHEMA_REFUSED"],
      [S3_FRESH_RUNTIME_RESULT_PUBLICATION_EXIT_CODE, "FRESH_RUNTIME_RESULT_PUBLICATION_REFUSED"],
    ]).get(invocation.exitCode ?? -1);
    if (typedFailure !== undefined) failure(typedFailure);
    failure(`FRESH_RUNTIME_STATUS:${invocation.exitCode ?? "unavailable"}`);
  }
  const stdout = await freshRuntimePipeBefore(
    invocation.stdoutCapture,
    invocation.deadlineAt,
    label,
  );
  const stderr = await freshRuntimePipeBefore(
    invocation.stderrCapture,
    invocation.deadlineAt,
    label,
  );
  if (stderr.byteLength !== 0 || stdout.byteLength !== 0) {
    failure(`FRESH_RUNTIME_DIAGNOSTIC_UNEXPECTED:${stderr.byteLength}:STDOUT:${stdout.byteLength}`);
  }
  const bootstrap = fstatSync(invocation.bootstrapFd, { bigint: true }) as ExactBigIntStat;
  if (
    !sameIdentityExceptNlink(bootstrap, invocation.bootstrapIdentity, 0n) ||
    bootstrap.size.toString(10) !== invocation.bootstrapIdentity.size
  ) {
    failure("FRESH_RUNTIME_BOOTSTRAP_RETIREMENT_UNPROVEN");
  }
  assertPinnedFreshRuntimeDirectory(invocation, label);
}

function readFreshRuntimeAuthorityInode(invocation: FreshRuntimeInvocation, label: string): Buffer {
  const opened = fstatSync(invocation.resultFd, { bigint: true }) as ExactBigIntStat;
  if (
    !opened.isFile() ||
    !sameIdentityExceptNlink(opened, invocation.resultIdentity, 0n) ||
    (opened.mode & 0o777n) !== 0o600n
  ) {
    throw new Error(`${label}_FRESH_RUNTIME_RESULT_INODE_MISMATCH`);
  }
  if (opened.size === 0n) {
    throw new Error(
      `${label}_FRESH_RUNTIME_RESULT_EMPTY${freshRuntimePublicationDiagnostic(invocation)}`,
    );
  }
  if (opened.size > BigInt(S3_FRESH_RUNTIME_RESULT_MAX_BYTES)) {
    throw new Error(`${label}_FRESH_RUNTIME_RESULT_OVERRUN:${opened.size}`);
  }
  const content = Buffer.alloc(Number(opened.size));
  let offset = 0;
  while (offset < content.byteLength) {
    const read = readSync(
      invocation.resultFd,
      content,
      offset,
      content.byteLength - offset,
      offset,
    );
    if (read <= 0) throw new Error(`${label}_FRESH_RUNTIME_RESULT_PARTIAL`);
    offset += read;
  }
  const completed = fstatSync(invocation.resultFd, { bigint: true }) as ExactBigIntStat;
  if (
    !completed.isFile() ||
    !sameIdentityExceptNlink(completed, invocation.resultIdentity, 0n) ||
    (completed.mode & 0o777n) !== 0o600n ||
    completed.size !== BigInt(content.byteLength)
  ) {
    throw new Error(`${label}_FRESH_RUNTIME_RESULT_CHANGED`);
  }
  return content;
}

function rereadRetainedFreshRuntimeResult(
  invocation: FreshRuntimeInvocation,
  content: Buffer,
  label: string,
): void {
  assertPinnedFreshRuntimeDirectory(invocation, label);
  const named = lstatSync(invocation.resultPath, { bigint: true }) as ExactBigIntStat;
  if (
    !named.isFile() ||
    (named.mode & 0o777n) !== 0o600n ||
    named.nlink !== 1n ||
    named.size !== BigInt(content.byteLength) ||
    named.dev.toString(10) !== invocation.resultIdentity.dev ||
    named.ino.toString(10) === invocation.resultIdentity.ino
  ) {
    throw new Error(`${label}_FRESH_RUNTIME_RETAINED_RESULT_UNPROVEN`);
  }
  const retainedIdentity = exactInodeIdentity(named);
  const retainedFd = openSync(invocation.resultPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(retainedFd, { bigint: true }) as ExactBigIntStat;
    if (
      !opened.isFile() ||
      !sameExactIdentity(opened, retainedIdentity) ||
      opened.size !== BigInt(content.byteLength)
    ) {
      throw new Error(`${label}_FRESH_RUNTIME_RETAINED_RESULT_CHANGED`);
    }
    const reread = Buffer.alloc(content.byteLength);
    let offset = 0;
    while (offset < reread.byteLength) {
      const read = readSync(retainedFd, reread, offset, reread.byteLength - offset, offset);
      if (read <= 0) throw new Error(`${label}_FRESH_RUNTIME_RETAINED_RESULT_PARTIAL`);
      offset += read;
    }
    const completed = fstatSync(retainedFd, { bigint: true }) as ExactBigIntStat;
    if (
      !sameExactIdentity(completed, retainedIdentity) ||
      completed.size !== BigInt(content.byteLength) ||
      !reread.equals(content)
    ) {
      throw new Error(`${label}_FRESH_RUNTIME_RETAINED_RESULT_REREAD_MISMATCH`);
    }
  } finally {
    closeSync(retainedFd);
  }
  assertPinnedFreshRuntimeDirectory(invocation, label);
}

function hasExactRecordKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function ownedOutcomeFieldsValid(
  result: Record<string, unknown>,
  hasExitCode: boolean,
  hasCleanup: boolean,
): boolean {
  switch (result.outcome) {
    case "exited":
      return hasExitCode && !hasCleanup;
    case "timeout":
      return (
        !hasExitCode &&
        !Object.hasOwn(result, "signal") &&
        hasCleanup &&
        result.cleanupProven === true
      );
    case "output-overrun":
      return hasCleanup && result.cleanupProven === true;
    case "descendant-leaked":
    case "pipe-drain-unproven":
      return hasExitCode && !hasCleanup;
    case "inspection-unproven":
      return hasExitCode
        ? !hasCleanup || result.cleanupProven === false
        : hasCleanup && result.cleanupProven === false;
    case "ownership-unproven":
      // Cleanup and ownership are separate claims, but a pre-completion
      // ownership refusal always reports the cleanup observation it obtained.
      return hasExitCode || hasCleanup;
    case "spawn-failed":
      return hasExitCode
        ? result.exitCode === 125 && !Object.hasOwn(result, "signal") && hasCleanup
        : !Object.hasOwn(result, "signal");
    default:
      return false;
  }
}

function ownedCommandResultIsExact(
  value: unknown,
  retainedStreamBytes: number,
  retainedOutputBytes: number,
  outcomes: readonly string[],
  ownershipFailurePhases: readonly string[],
): boolean {
  const required = [
    "outcome",
    "stdout",
    "stderr",
    "retainedStdoutBytes",
    "retainedStderrBytes",
    "retainedOutputBytes",
  ];
  const allowed = [...required, "exitCode", "signal", "cleanupProven", "ownershipFailurePhase"];
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Number.isSafeInteger(retainedStreamBytes) ||
    retainedStreamBytes < 1 ||
    !Number.isSafeInteger(retainedOutputBytes) ||
    retainedOutputBytes < 1
  ) {
    return false;
  }
  const result = value as Record<string, unknown>;
  if (
    !required.every((key) => Object.hasOwn(result, key)) ||
    !Object.keys(result).every((key) => allowed.includes(key)) ||
    typeof result.outcome !== "string" ||
    !outcomes.includes(result.outcome)
  ) {
    return false;
  }
  const hasExitCode = Object.hasOwn(result, "exitCode");
  const hasSignal = Object.hasOwn(result, "signal");
  const hasCleanup = Object.hasOwn(result, "cleanupProven");
  const hasOwnershipFailurePhase = Object.hasOwn(result, "ownershipFailurePhase");
  const signalMatch =
    hasSignal && typeof result.signal === "string"
      ? /^SIG([1-9][0-9]{0,2})$/u.exec(result.signal)
      : null;
  const signalNumber = Number(signalMatch?.[1]);
  const stdoutBytes = Number(result.retainedStdoutBytes);
  const stderrBytes = Number(result.retainedStderrBytes);
  const outputBytes = Number(result.retainedOutputBytes);
  const exactUtf8Text = (text: unknown, retainedBytes: number): boolean => {
    if (typeof text !== "string") return false;
    const bytes = Buffer.from(text, "utf8");
    if (bytes.byteLength !== retainedBytes) return false;
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes) === text;
    } catch {
      return false;
    }
  };
  return (
    Number.isSafeInteger(result.retainedStdoutBytes) &&
    stdoutBytes >= 0 &&
    stdoutBytes <= retainedStreamBytes &&
    Number.isSafeInteger(result.retainedStderrBytes) &&
    stderrBytes >= 0 &&
    stderrBytes <= retainedStreamBytes &&
    Number.isSafeInteger(result.retainedOutputBytes) &&
    outputBytes >= 0 &&
    outputBytes <= retainedOutputBytes &&
    Number.isSafeInteger(stdoutBytes + stderrBytes) &&
    outputBytes === stdoutBytes + stderrBytes &&
    exactUtf8Text(result.stdout, stdoutBytes) &&
    exactUtf8Text(result.stderr, stderrBytes) &&
    (!hasExitCode ||
      (Number.isSafeInteger(result.exitCode) &&
        Number(result.exitCode) >= 0 &&
        Number(result.exitCode) <= 255)) &&
    (!hasSignal ||
      (hasExitCode &&
        signalMatch !== null &&
        signalNumber <= 127 &&
        result.exitCode === 128 + signalNumber)) &&
    (!hasCleanup || typeof result.cleanupProven === "boolean") &&
    hasOwnershipFailurePhase === (result.outcome === "ownership-unproven") &&
    (!hasOwnershipFailurePhase ||
      (typeof result.ownershipFailurePhase === "string" &&
        ownershipFailurePhases.includes(result.ownershipFailurePhase))) &&
    ownedOutcomeFieldsValid(result, hasExitCode, hasCleanup)
  );
}

function isOwnedCommandResult(
  value: unknown,
  retainedStreamBytes = S3_OWNED_STREAM_BYTES,
  retainedOutputBytes = S3_OWNED_OUTPUT_BYTES,
): value is OwnedCommandResult {
  return ownedCommandResultIsExact(
    value,
    retainedStreamBytes,
    retainedOutputBytes,
    Object.keys(OWNED_COMMAND_OUTCOMES),
    Object.keys(OWNED_SESSION_FAILURE_PHASES),
  );
}

function isFreshDispatcherOwnedResultForTest(value: unknown): boolean {
  return ownedCommandResultIsExact(
    value,
    S3_OWNED_STREAM_BYTES,
    S3_OWNED_OUTPUT_BYTES,
    Object.keys(OWNED_COMMAND_OUTCOMES),
    Object.keys(OWNED_SESSION_FAILURE_PHASES),
  );
}

function isFreshOwnedS3ResultPayload(
  value: unknown,
  retainedStreamBytes = S3_OWNED_STREAM_BYTES,
  retainedOutputBytes = S3_OWNED_OUTPUT_BYTES,
): value is {
  readonly nonce: string;
  readonly kind: "result";
  readonly result: OwnedCommandResult;
  readonly cleanupProven: boolean;
} {
  if (!hasExactRecordKeys(value, ["nonce", "kind", "result", "cleanupProven"])) return false;
  const record = value;
  if (
    typeof record.nonce !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(record.nonce) ||
    record.kind !== "result" ||
    !isOwnedCommandResult(record.result, retainedStreamBytes, retainedOutputBytes) ||
    typeof record.cleanupProven !== "boolean"
  ) {
    return false;
  }
  return (
    record.cleanupProven ===
    (record.result.outcome === "exited" || record.result.cleanupProven === true)
  );
}

async function readFreshOwnedS3Result(
  invocation: FreshRuntimeInvocation,
  label: string,
): Promise<FreshOwnedS3Result> {
  const content = readFreshRuntimeAuthorityInode(invocation, label);
  if (content.byteLength > S3_FRESH_RUNTIME_RESULT_MAX_BYTES) {
    throw new Error(`${label}_FRESH_RUNTIME_RESULT_OVERRUN:${content.byteLength}`);
  }
  if (content.at(-1) !== 0x0a || content.subarray(0, -1).includes(0x0a) || content.includes(0x0d)) {
    throw new Error(`${label}_FRESH_RUNTIME_RESULT_NONCANONICAL`);
  }

  let payload: string;
  try {
    payload = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new Error(`${label}_FRESH_RUNTIME_RESULT_INVALID_UTF8`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error(`${label}_FRESH_RUNTIME_RESULT_INVALID_JSON`);
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`${label}_FRESH_RUNTIME_RESULT_SHAPE`);
  }
  const record = parsed as Record<string, unknown>;
  if (record.nonce !== invocation.nonce) {
    throw new Error(`${label}_FRESH_RUNTIME_RESULT_NONCE_MISMATCH`);
  }
  if (
    !isFreshOwnedS3ResultPayload(
      record,
      invocation.retainedStreamBytes,
      invocation.retainedOutputBytes,
    )
  ) {
    const result =
      record.result !== null && typeof record.result === "object" && !Array.isArray(record.result)
        ? (record.result as Record<string, unknown>)
        : undefined;
    throw new Error(
      `${label}_FRESH_RUNTIME_RESULT_SHAPE:${JSON.stringify({
        topLevelKeys: Object.keys(record).sort(),
        resultKeys: result === undefined ? [] : Object.keys(result).sort(),
        outcome: result?.outcome,
        exitCode: result?.exitCode,
        signal: result?.signal,
        cleanupProven: result?.cleanupProven,
        ownershipFailurePhase: result?.ownershipFailurePhase,
        stdoutType: typeof result?.stdout,
        stderrType: typeof result?.stderr,
        stdoutReplacementCount:
          typeof result?.stdout === "string" ? result.stdout.split("\uFFFD").length - 1 : undefined,
        stderrReplacementCount:
          typeof result?.stderr === "string" ? result.stderr.split("\uFFFD").length - 1 : undefined,
        retainedStdoutBytes: result?.retainedStdoutBytes,
        retainedStderrBytes: result?.retainedStderrBytes,
        retainedOutputBytes: result?.retainedOutputBytes,
      })}`,
    );
  }
  const canonical = Buffer.from(`${JSON.stringify(parsed)}\n`, "utf8");
  if (!canonical.equals(content)) {
    throw new Error(`${label}_FRESH_RUNTIME_RESULT_NONCANONICAL`);
  }
  // The retained name is only reread evidence after the unlinked authority
  // inode has passed every UTF-8, nonce, schema, and canonicality check.
  rereadRetainedFreshRuntimeResult(invocation, content, label);
  return { result: record.result, cleanupProven: record.cleanupProven };
}

async function runFreshOwnedS3Command(
  command: readonly string[],
  label: string,
  options: S3OwnedCommandOptions,
): Promise<FreshOwnedS3Result> {
  const invocation = await invokeFreshOwnedS3Command(command, options);
  try {
    await assertFreshRuntimeExited(invocation, label);
    return await readFreshOwnedS3Result(invocation, label);
  } finally {
    await retireAndCloseFreshRuntime(invocation);
  }
}

interface BoundedS3ChildResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

interface BoundedS3ChildExitMismatch {
  readonly code: "S3_CHILD_EXIT_CODE_MISMATCH";
  readonly label: string;
  readonly expected_exit_code: number;
  readonly actual_exit_code: number;
  readonly stdout_bytes: number;
  readonly stderr_bytes: number;
  readonly reported_codes: readonly string[];
}

function boundedS3ReportedCodes(stdout: string): readonly string[] {
  const reportedCodes = new Set<string>();
  for (const line of stdout.split("\n")) {
    if (reportedCodes.size >= 8) break;
    if (line.length === 0 || line.length > 4_096 || !line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as { readonly code?: unknown };
      if (typeof parsed.code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/u.test(parsed.code)) {
        reportedCodes.add(parsed.code);
      }
    } catch {
      // Non-JSON product output is asserted by the caller, never reflected here.
    }
  }
  return [...reportedCodes];
}

function boundedS3ChildExitMismatch(
  result: BoundedS3ChildResult,
  label: string,
  expectedExitCode: number,
): BoundedS3ChildExitMismatch | undefined {
  if (result.exitCode === expectedExitCode) return undefined;
  return {
    code: "S3_CHILD_EXIT_CODE_MISMATCH",
    label,
    expected_exit_code: expectedExitCode,
    actual_exit_code: result.exitCode,
    stdout_bytes: Buffer.byteLength(result.stdout, "utf8"),
    stderr_bytes: Buffer.byteLength(result.stderr, "utf8"),
    reported_codes: boundedS3ReportedCodes(result.stdout),
  };
}

function expectBoundedS3ChildExit(
  result: BoundedS3ChildResult,
  label: string,
  expectedExitCode: number,
): void {
  // Bun prints only this bounded structured summary on mismatch. The caller
  // retains the typed stdout/stderr for exact assertions without reflecting
  // arbitrary child bytes into the test failure.
  expect(boundedS3ChildExitMismatch(result, label, expectedExitCode)).toBeUndefined();
}

async function runBoundedS3Child(
  command: readonly string[],
  label: string,
  options: S3OwnedCommandOptions,
): Promise<BoundedS3ChildResult> {
  const { result, cleanupProven } = await runFreshOwnedS3Command(command, label, options);
  if (result.outcome !== "exited") {
    throw new Error(
      `${label}_OUTCOME:${result.outcome}:CLEANUP:${result.cleanupProven === true}:STDOUT_BYTES:${result.retainedStdoutBytes}:STDERR_BYTES:${result.retainedStderrBytes}`,
    );
  }
  if (cleanupProven !== true) throw new Error(`${label}_CLEANUP_UNPROVEN`);
  if (typeof result.exitCode !== "number") {
    throw new Error(`${label}_EXIT_CODE:${result.exitCode ?? "UNAVAILABLE"}`);
  }
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
}

function s3OwnedTimeoutWithin(deadlineMs: number): number {
  const transportMs = s3OwnedCommandTimeout({ timeoutMs: 1 }) - 1;
  const testRunnerSettlementReserveMs = 1_000;
  const timeoutMs = deadlineMs - transportMs - testRunnerSettlementReserveMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(`S3_OWNED_TEST_DEADLINE_TOO_SMALL:${deadlineMs}`);
  }
  return timeoutMs;
}

function s3HarnessPlantCommand(
  environmentName: string,
  environmentValue: string,
): readonly string[] {
  if (
    !/^S3_(?:PORT|SELF_TEST_[A-Z0-9_]+)$/u.test(environmentName) ||
    environmentValue.includes("\0")
  ) {
    throw new Error("S3_HARNESS_PLANT_ENVIRONMENT_INVALID");
  }
  return ["env", `${environmentName}=${environmentValue}`, "bash", "scripts/e2e-s3-split.sh"];
}

async function runS3HarnessPlant(
  environmentName: string,
  environmentValue: string,
  label: string,
  deadlineMs: number,
): Promise<BoundedS3ChildResult> {
  return await runBoundedS3Child(s3HarnessPlantCommand(environmentName, environmentValue), label, {
    timeoutMs: s3OwnedTimeoutWithin(deadlineMs),
  });
}

type IsolatedProductionBuildMode = "production" | "counterfactual";

interface IsolatedProductionBuildReceipt {
  readonly mode: IsolatedProductionBuildMode;
  readonly output_count: number;
  readonly output_bytes: number;
  readonly matched_local_worker_sentinels: readonly string[];
}

function expectedLocalWorkerBundleSentinels(mode: IsolatedProductionBuildMode): readonly string[] {
  return mode === "production" ? [] : LOCAL_WORKER_BUNDLE_SENTINELS;
}

function decodeIsolatedProductionBuildOutputEvidence(stdout: string): readonly string[] {
  const evidenceBytes = Buffer.byteLength(stdout, "utf8");
  if (evidenceBytes > S3_ISOLATED_BUILD_OUTPUT_EVIDENCE_MAX_BYTES) {
    throw new Error(`S3_ISOLATED_BUILD_OUTPUT_EVIDENCE_OVERRUN:${evidenceBytes}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("S3_ISOLATED_BUILD_OUTPUT_EVIDENCE_MALFORMED");
  }
  if (!Array.isArray(parsed)) {
    // The child may supply only actual output text strings. In particular, a
    // child-provided mode, count, byte total, or sentinel list is not evidence.
    throw new Error("S3_ISOLATED_BUILD_OUTPUT_EVIDENCE_SHAPE");
  }
  if (parsed.length === 0) throw new Error("S3_ISOLATED_BUILD_OUTPUT_EVIDENCE_EMPTY");
  if (!parsed.every((output) => typeof output === "string")) {
    throw new Error("S3_ISOLATED_BUILD_OUTPUT_EVIDENCE_STRING_REQUIRED");
  }
  const outputTexts = parsed as string[];
  // `ISOLATED_BUILD_SCRIPT` and the owned-command transport both decode bytes
  // fatally. U+FFFD is therefore ordinary valid Unicode here, never evidence
  // that malformed pipe bytes were silently replaced.
  if (stdout !== JSON.stringify(outputTexts)) {
    throw new Error("S3_ISOLATED_BUILD_OUTPUT_EVIDENCE_NONCANONICAL");
  }
  return outputTexts;
}

function isolatedBuildFreshResultUpperBound(rawEvidenceBytes: number): number {
  if (!Number.isSafeInteger(rawEvidenceBytes) || rawEvidenceBytes < 0) {
    throw new Error("S3_ISOLATED_BUILD_RESULT_BOUND_INVALID");
  }
  // `stdout` is the strict `JSON.stringify(outputTexts)` value above. Nested
  // JSON can therefore add at most one byte per raw byte (only `"` and `\\`
  // require escaping); the rest of the result record is measured exactly.
  const fixedPublicationBytes = Buffer.byteLength(
    `${JSON.stringify({
      nonce: "00000000-0000-4000-8000-000000000000",
      kind: "result",
      result: {
        outcome: "exited",
        exitCode: 0,
        stdout: "",
        stderr: "",
        retainedStdoutBytes: rawEvidenceBytes,
        retainedStderrBytes: 0,
        retainedOutputBytes: rawEvidenceBytes,
      },
      cleanupProven: true,
    })}\n`,
    "utf8",
  );
  const bound = fixedPublicationBytes + 2 * rawEvidenceBytes;
  if (!Number.isSafeInteger(bound)) throw new Error("S3_ISOLATED_BUILD_RESULT_BOUND_INVALID");
  return bound;
}

function isolatedProductionBuildReceiptFromOutputEvidence(
  mode: IsolatedProductionBuildMode,
  outputTexts: readonly string[],
): IsolatedProductionBuildReceipt {
  let outputBytes = 0;
  for (const output of outputTexts) {
    const next = outputBytes + Buffer.byteLength(output, "utf8");
    if (!Number.isSafeInteger(next)) {
      throw new Error("S3_ISOLATED_BUILD_OUTPUT_EVIDENCE_BYTES_INVALID");
    }
    outputBytes = next;
  }
  if (outputTexts.length === 0 || outputBytes === 0) {
    throw new Error("S3_ISOLATED_BUILD_OUTPUT_EVIDENCE_EMPTY");
  }

  const matchedSentinels = LOCAL_WORKER_BUNDLE_SENTINELS.filter((sentinel) =>
    outputTexts.some((output) => output.includes(sentinel)),
  );
  const expectedSentinels = expectedLocalWorkerBundleSentinels(mode);
  if (
    matchedSentinels.length !== expectedSentinels.length ||
    matchedSentinels.some((sentinel, index) => sentinel !== expectedSentinels[index])
  ) {
    throw new Error("S3_ISOLATED_BUILD_OUTPUT_EVIDENCE_SENTINELS_INVALID");
  }
  return {
    mode,
    output_count: outputTexts.length,
    output_bytes: outputBytes,
    matched_local_worker_sentinels: matchedSentinels,
  };
}

function sourceRegion(source: string, start: string, nextStart: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(nextStart, startIndex + start.length);
  if (startIndex === -1 || endIndex === -1) {
    throw new Error(`S3_SOURCE_REGION_NOT_FOUND:${start}`);
  }
  return source.slice(startIndex, endIndex);
}

function occurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

const ISOLATED_BUILD_SCRIPT = String.raw`
const mode = process.argv[1];
const productionEntrypoint = process.argv[2];
const localWorkerEntrypoint = process.argv[3];
const entrypoint = "s3-production-counterfactual-entry";
const namespace = "s3-production-counterfactual";
if (mode !== "production" && mode !== "counterfactual") {
  console.error("S3_ISOLATED_BUILD_MODE_INVALID:" + mode);
  process.exit(2);
}
const options = {
  entrypoints: mode === "production" ? [productionEntrypoint] : [entrypoint],
  format: "esm",
  target: "browser",
  minify: true,
  external: ["zod"],
};

if (mode === "counterfactual") {
  options.plugins = [{
    name: namespace,
    setup(build) {
      build.onResolve({ filter: /^s3-production-counterfactual-entry$/u }, () => ({
        path: entrypoint,
        namespace,
      }));
      build.onLoad({ filter: /^s3-production-counterfactual-entry$/u, namespace }, () => ({
        loader: "ts",
        contents: [
          "import productionWorker from " + JSON.stringify(productionEntrypoint) + ";",
          "import localWorker from " + JSON.stringify(localWorkerEntrypoint) + ";",
          "export default {",
          "  fetch(request: Request, env: unknown, ctx: unknown) {",
          "    if (request.headers.get(\"x-s3-counterfactual\") === \"1\") {",
          "      return localWorker.fetch(request, env as never, ctx as never);",
          "    }",
          "    return productionWorker.fetch(request, env as never, ctx as never);",
          "  },",
          "};",
        ].join("\n"),
      }));
    },
  }];
}

const result = await Bun.build(options);
if (!result.success) {
  for (const log of result.logs) console.error(String(log));
  process.exit(1);
}
const outputTexts = [];
let outputBytes = 0;
for (const output of result.outputs) {
  const bytes = await output.arrayBuffer();
  outputBytes += bytes.byteLength;
  outputTexts.push(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
if (result.outputs.length === 0 || outputBytes === 0) {
  console.error("S3_ISOLATED_BUILD_OUTPUT_EMPTY:" + mode);
  process.exit(1);
}
process.stdout.write(JSON.stringify(outputTexts));
`;
const ISOLATED_BUILD_SCRIPT_SHA256 =
  "c1c3ee7f42920f3f0dd204ab03c9883abe9d50b7e003e6be43ec51fb2a0e7370";

const EXPECTED_ISOLATED_BUILD_OPTIONS_SOURCE = `const options = {
  entrypoints: mode === "production" ? [productionEntrypoint] : [entrypoint],
  format: "esm",
  target: "browser",
  minify: true,
  external: ["zod"],
};`;

const EXPECTED_ISOLATED_BUILD_COUNTERFACTUAL_ENTRY_SOURCE = String.raw`        contents: [
          "import productionWorker from " + JSON.stringify(productionEntrypoint) + ";",
          "import localWorker from " + JSON.stringify(localWorkerEntrypoint) + ";",
          "export default {",
          "  fetch(request: Request, env: unknown, ctx: unknown) {",
          "    if (request.headers.get(\"x-s3-counterfactual\") === \"1\") {",
          "      return localWorker.fetch(request, env as never, ctx as never);",
          "    }",
          "    return productionWorker.fetch(request, env as never, ctx as never);",
          "  },",
          "};",
        ].join("\n"),`;

const EXPECTED_ISOLATED_BUILD_OUTPUT_EVIDENCE_SOURCE = `const outputTexts = [];
let outputBytes = 0;
for (const output of result.outputs) {
  const bytes = await output.arrayBuffer();
  outputBytes += bytes.byteLength;
  outputTexts.push(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
if (result.outputs.length === 0 || outputBytes === 0) {
  console.error("S3_ISOLATED_BUILD_OUTPUT_EMPTY:" + mode);
  process.exit(1);
}
process.stdout.write(JSON.stringify(outputTexts));`;

function exactScriptSlice(source: string, start: string, end: string): string | undefined {
  const startIndex = source.indexOf(start);
  if (startIndex === -1) return undefined;
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (endIndex === -1) return undefined;
  return source.slice(startIndex, endIndex + end.length);
}

function isolatedBuildScriptSliceFailures(script: string): string[] {
  const failures: string[] = [];
  const buildOptions = exactScriptSlice(script, "const options = {", "};");
  if (buildOptions !== EXPECTED_ISOLATED_BUILD_OPTIONS_SOURCE) {
    failures.push("BUILD_OPTIONS");
  }
  const counterfactualEntry = exactScriptSlice(
    script,
    "        contents: [",
    '        ].join("\\n"),',
  );
  if (counterfactualEntry !== EXPECTED_ISOLATED_BUILD_COUNTERFACTUAL_ENTRY_SOURCE) {
    failures.push("COUNTERFACTUAL_ENTRY");
  }
  const outputEvidenceStart = script.indexOf("const outputTexts = [];");
  const outputEvidence = outputEvidenceStart === -1 ? undefined : script.slice(outputEvidenceStart);
  if (outputEvidence !== `${EXPECTED_ISOLATED_BUILD_OUTPUT_EVIDENCE_SOURCE}\n`) {
    failures.push("OUTPUT_EVIDENCE_FLOW");
  }
  if (occurrences(script, "outputTexts =") !== 1) failures.push("OUTPUT_TEXTS_WRITE_COUNT");
  if (occurrences(script, "outputTexts.push(") !== 1) failures.push("OUTPUT_TEXTS_PUSH_COUNT");
  if (occurrences(script, "process.stdout.write(") !== 1) failures.push("OUTPUT_TEXTS_EMIT_COUNT");
  if (occurrences(script, "JSON.stringify(outputTexts)") !== 1) {
    failures.push("OUTPUT_TEXTS_JSON_COUNT");
  }
  if (occurrences(script, 'new TextDecoder("utf-8", { fatal: true }).decode(bytes)') !== 1) {
    failures.push("OUTPUT_TEXTS_FATAL_DECODER_COUNT");
  }
  for (const sentinel of LOCAL_WORKER_BUNDLE_SENTINELS) {
    if (script.includes(sentinel)) failures.push(`SENTINEL_LITERAL:${sentinel}`);
  }
  return failures;
}

function assertIsolatedBuildScriptDataflow(script: string): void {
  const failures = isolatedBuildScriptSliceFailures(script);
  if (createHash("sha256").update(script, "utf8").digest("hex") !== ISOLATED_BUILD_SCRIPT_SHA256) {
    failures.push("SCRIPT_SHA256");
  }
  if (failures.length > 0) {
    throw new Error(`S3_ISOLATED_BUILD_SOURCE_DATAFLOW:${failures.join(",")}`);
  }
}

function isolatedBuildCommand(
  mode: IsolatedProductionBuildMode,
  productionEntrypoint: string,
  localWorkerEntrypoint: string,
): readonly string[] {
  return ["bun", "-e", ISOLATED_BUILD_SCRIPT, mode, productionEntrypoint, localWorkerEntrypoint];
}

function assertIsolatedBuildChildArguments(
  command: readonly string[],
  mode: IsolatedProductionBuildMode,
  productionEntrypoint: string,
  localWorkerEntrypoint: string,
): void {
  const expected = [
    "bun",
    "-e",
    ISOLATED_BUILD_SCRIPT,
    mode,
    productionEntrypoint,
    localWorkerEntrypoint,
  ];
  if (
    command.length !== expected.length ||
    command.some((argument, index) => argument !== expected[index])
  ) {
    throw new Error("S3_ISOLATED_BUILD_SOURCE_CHILD_ARGUMENTS");
  }
  for (const sentinel of LOCAL_WORKER_BUNDLE_SENTINELS) {
    if (command.includes(sentinel)) {
      throw new Error(`S3_ISOLATED_BUILD_SOURCE_CHILD_SENTINEL_ARGUMENT:${sentinel}`);
    }
  }
}

async function isolatedProductionBundle(
  mode: IsolatedProductionBuildMode,
  productionEntrypoint: string,
  localWorkerEntrypoint: string,
): Promise<IsolatedProductionBuildReceipt> {
  // Keep the graph proof outside Bun's long-lived test process. Actual build
  // output crosses only the existing fresh-owned, pinned-result authority;
  // the parent derives every receipt field after strictly decoding that output.
  if (
    isolatedBuildFreshResultUpperBound(S3_ISOLATED_BUILD_OUTPUT_EVIDENCE_MAX_BYTES) >
    S3_FRESH_RUNTIME_RESULT_MAX_BYTES
  ) {
    throw new Error("S3_ISOLATED_BUILD_RESULT_CAP_INVALID");
  }
  const { result, cleanupProven } = await runFreshOwnedS3Command(
    isolatedBuildCommand(mode, productionEntrypoint, localWorkerEntrypoint),
    "S3_ISOLATED_BUILD",
    {
      timeoutMs: S3_BUNDLE_TIMEOUT_MS,
      retainedStreamBytes: S3_ISOLATED_BUILD_OUTPUT_EVIDENCE_MAX_BYTES,
      retainedOutputBytes: S3_ISOLATED_BUILD_OUTPUT_EVIDENCE_MAX_BYTES,
    },
  );
  if (result.outcome !== "exited") {
    throw new Error(
      `S3_ISOLATED_BUILD_${mode}_OUTCOME:${result.outcome}:CLEANUP:${result.cleanupProven === true}:STDOUT_BYTES:${result.retainedStdoutBytes}:STDERR_BYTES:${result.retainedStderrBytes}`,
    );
  }
  if (cleanupProven !== true) throw new Error(`S3_ISOLATED_BUILD_${mode}_CLEANUP_UNPROVEN`);
  if (result.exitCode !== 0) {
    throw new Error(`S3_ISOLATED_BUILD_${mode}_EXIT_CODE:${result.exitCode ?? "UNAVAILABLE"}`);
  }
  if (result.stderr.length !== 0 || result.retainedStderrBytes !== 0) {
    throw new Error(`S3_ISOLATED_BUILD_${mode}_STDERR_UNEXPECTED:${result.retainedStderrBytes}`);
  }
  const evidenceBytes = Buffer.byteLength(result.stdout, "utf8");
  if (
    result.retainedStdoutBytes !== evidenceBytes ||
    result.retainedOutputBytes !== evidenceBytes
  ) {
    throw new Error(`S3_ISOLATED_BUILD_${mode}_OUTPUT_NON_UTF8_OR_ACCOUNTING_MISMATCH`);
  }
  return isolatedProductionBuildReceiptFromOutputEvidence(
    mode,
    decodeIsolatedProductionBuildOutputEvidence(result.stdout),
  );
}

test("isolated build output evidence refuses fake fields, malformed, empty, noncanonical, and oversized evidence", () => {
  const validProductionEvidence = JSON.stringify(["export default {};"]);
  const childSuppliedFakeReceipt = JSON.stringify({
    mode: "counterfactual",
    output_count: 1,
    output_bytes: 1,
    matched_local_worker_sentinels: LOCAL_WORKER_BUNDLE_SENTINELS,
  });
  const childSuppliedFakeFieldsInOutputText = JSON.stringify({
    mode: "counterfactual",
    output_count: 999,
    output_bytes: 999,
    matched_local_worker_sentinels: ["not-a-local-worker-sentinel"],
  });
  expect(() => decodeIsolatedProductionBuildOutputEvidence("{")).toThrow(
    "S3_ISOLATED_BUILD_OUTPUT_EVIDENCE_MALFORMED",
  );
  // Causal mutation: every old child-supplied receipt field is rejected before
  // a parent can use it. The schema admits raw output strings only.
  expect(() => decodeIsolatedProductionBuildOutputEvidence(childSuppliedFakeReceipt)).toThrow(
    "S3_ISOLATED_BUILD_OUTPUT_EVIDENCE_SHAPE",
  );
  expect(() =>
    decodeIsolatedProductionBuildOutputEvidence(
      JSON.stringify([JSON.parse(childSuppliedFakeReceipt)]),
    ),
  ).toThrow("S3_ISOLATED_BUILD_OUTPUT_EVIDENCE_STRING_REQUIRED");
  expect(() => decodeIsolatedProductionBuildOutputEvidence("[]")).toThrow(
    "S3_ISOLATED_BUILD_OUTPUT_EVIDENCE_EMPTY",
  );
  expect(decodeIsolatedProductionBuildOutputEvidence(JSON.stringify(["\uFFFD"]))).toEqual([
    "\uFFFD",
  ]);
  const oneByteOverEvidence = JSON.stringify([
    "x".repeat(S3_ISOLATED_BUILD_OUTPUT_EVIDENCE_MAX_BYTES + 1 - Buffer.byteLength('[""]', "utf8")),
  ]);
  expect(Buffer.byteLength(oneByteOverEvidence, "utf8")).toBe(
    S3_ISOLATED_BUILD_OUTPUT_EVIDENCE_MAX_BYTES + 1,
  );
  expect(() => decodeIsolatedProductionBuildOutputEvidence(oneByteOverEvidence)).toThrow(
    "S3_ISOLATED_BUILD_OUTPUT_EVIDENCE_OVERRUN",
  );
  expect(
    isolatedBuildFreshResultUpperBound(S3_ISOLATED_BUILD_OUTPUT_EVIDENCE_MAX_BYTES),
  ).toBeLessThanOrEqual(S3_FRESH_RUNTIME_RESULT_MAX_BYTES);
  expect(() => decodeIsolatedProductionBuildOutputEvidence('["export default {};" ]')).toThrow(
    "S3_ISOLATED_BUILD_OUTPUT_EVIDENCE_NONCANONICAL",
  );
  const productionEvidence = decodeIsolatedProductionBuildOutputEvidence(validProductionEvidence);
  expect(
    isolatedProductionBuildReceiptFromOutputEvidence("production", productionEvidence),
  ).toEqual({
    mode: "production",
    output_count: 1,
    output_bytes: Buffer.byteLength("export default {};", "utf8"),
    matched_local_worker_sentinels: [],
  });
  // A receipt-shaped string is merely bundle text: its forged fields cannot
  // choose the parent mode, count, byte total, or sentinel verdict.
  const fakeFieldsEvidence = decodeIsolatedProductionBuildOutputEvidence(
    JSON.stringify([childSuppliedFakeFieldsInOutputText]),
  );
  expect(
    isolatedProductionBuildReceiptFromOutputEvidence("production", fakeFieldsEvidence),
  ).toEqual({
    mode: "production",
    output_count: 1,
    output_bytes: Buffer.byteLength(childSuppliedFakeFieldsInOutputText, "utf8"),
    matched_local_worker_sentinels: [],
  });
  expect(() =>
    isolatedProductionBuildReceiptFromOutputEvidence("production", [
      LOCAL_WORKER_BUNDLE_SENTINELS.join("\n"),
    ]),
  ).toThrow("S3_ISOLATED_BUILD_OUTPUT_EVIDENCE_SENTINELS_INVALID");
  expect(() =>
    isolatedProductionBuildReceiptFromOutputEvidence("counterfactual", productionEvidence),
  ).toThrow("S3_ISOLATED_BUILD_OUTPUT_EVIDENCE_SENTINELS_INVALID");
});

test("PLANTED: shipped isolated build source binds real counterfactual output dataflow", () => {
  expect(isolatedBuildScriptSliceFailures(ISOLATED_BUILD_SCRIPT)).toEqual([]);
  expect(() => assertIsolatedBuildScriptDataflow(ISOLATED_BUILD_SCRIPT)).not.toThrow();
  const childCommand = isolatedBuildCommand(
    "counterfactual",
    "/s3-production-entry.ts",
    "/s3-local-worker-entry.ts",
  );
  expect(childCommand).toEqual([
    "bun",
    "-e",
    ISOLATED_BUILD_SCRIPT,
    "counterfactual",
    "/s3-production-entry.ts",
    "/s3-local-worker-entry.ts",
  ]);
  expect(childCommand).toHaveLength(6);
  expect(() =>
    assertIsolatedBuildChildArguments(
      childCommand,
      "counterfactual",
      "/s3-production-entry.ts",
      "/s3-local-worker-entry.ts",
    ),
  ).not.toThrow();

  // The evidence channel is deliberately bounded. Removing production
  // minification makes the canonical JSON bundle exceed that authority on the
  // current graph, so the exact build option is part of the source contract.
  const unminifiedBuildMutation = ISOLATED_BUILD_SCRIPT.replace("  minify: true,\n", "");
  expect(isolatedBuildScriptSliceFailures(unminifiedBuildMutation)).toContain("BUILD_OPTIONS");
  expect(() => assertIsolatedBuildScriptDataflow(unminifiedBuildMutation)).toThrow(
    "S3_ISOLATED_BUILD_SOURCE_DATAFLOW:BUILD_OPTIONS",
  );

  // One-axis valid source mutation: removing the local counterfactual import
  // and use leaves a valid virtual entry, but it is no longer the exact entry
  // whose bundled output establishes the counterfactual.
  const missingLocalWorkerCounterfactualMutation = ISOLATED_BUILD_SCRIPT.replace(
    '          "import localWorker from " + JSON.stringify(localWorkerEntrypoint) + ";",\n',
    "",
  ).replace(
    '          "      return localWorker.fetch(request, env as never, ctx as never);",\n',
    "",
  );
  expect(() => assertIsolatedBuildScriptDataflow(missingLocalWorkerCounterfactualMutation)).toThrow(
    "S3_ISOLATED_BUILD_SOURCE_DATAFLOW:COUNTERFACTUAL_ENTRY",
  );
  // A separate valid source mutation appends a literal without altering the
  // counterfactual entry or output loop, so it reaches the sentinel-only guard.
  const syntheticSentinelLiteralMutation = ISOLATED_BUILD_SCRIPT.replace(
    'const namespace = "s3-production-counterfactual";',
    'const namespace = "s3-production-counterfactual";\nconst syntheticSentinel = "s3_local_workshops";',
  );
  expect(() => assertIsolatedBuildScriptDataflow(syntheticSentinelLiteralMutation)).toThrow(
    "S3_ISOLATED_BUILD_SOURCE_DATAFLOW:SENTINEL_LITERAL:s3_local_workshops",
  );
  // This valid middle mutation used to preserve every slice/count/literal
  // check: it wraps the actual fatal decoder call and dynamically appends the
  // sentinel without putting its full literal in the child source. The
  // whole-script digest now refuses it.
  const dynamicSentinelMiddleMutation = ISOLATED_BUILD_SCRIPT.replace(
    "const options = {",
    `const originalTextDecoderDecode = TextDecoder.prototype.decode;
TextDecoder.prototype.decode = function (...args) {
  const decoded = originalTextDecoderDecode.apply(this, args);
  return decoded + ["s3", "local", "workshops"].join("_");
};
const options = {`,
  );
  expect(isolatedBuildScriptSliceFailures(dynamicSentinelMiddleMutation)).toEqual([]);
  expect(() => assertIsolatedBuildScriptDataflow(dynamicSentinelMiddleMutation)).toThrow(
    "S3_ISOLATED_BUILD_SOURCE_DATAFLOW:SCRIPT_SHA256",
  );
});

function createPrivateFixtureFile(directory: string, name: string): string {
  const path = join(directory, name);
  closeSync(
    openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    ),
  );
  chmodSync(path, 0o600);
  return path;
}

function writePrivateFixtureFile(directory: string, name: string, content: Buffer): string {
  const path = createPrivateFixtureFile(directory, name);
  const fd = openSync(path, constants.O_WRONLY | constants.O_NOFOLLOW);
  try {
    let offset = 0;
    while (offset < content.byteLength) {
      const written = writeSync(fd, content, offset, content.byteLength - offset, offset);
      if (written <= 0) throw new Error("S3_PRIVATE_FIXTURE_WRITE_PARTIAL");
      offset += written;
    }
  } finally {
    closeSync(fd);
  }
  return path;
}

function decodeExactMarkerCensusCapture(
  stdout: unknown,
  stderr: unknown,
): { readonly stdout: string; readonly stderr: string } {
  if (!Buffer.isBuffer(stdout) || !Buffer.isBuffer(stderr)) {
    throw new Error("S3_EXACT_MARKER_INSPECTION_CAPTURE_TYPE");
  }
  if (stdout.byteLength === 0) {
    throw new Error("S3_EXACT_MARKER_INSPECTION_EMPTY");
  }
  if (
    stdout.byteLength > S3_MARKER_CENSUS_MAX_BYTES ||
    stderr.byteLength > S3_MARKER_CENSUS_MAX_BYTES
  ) {
    throw new Error(`S3_EXACT_MARKER_INSPECTION_OVERRUN:${stdout.byteLength}:${stderr.byteLength}`);
  }
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    return {
      stdout: decoder.decode(stdout),
      stderr: decoder.decode(stderr),
    };
  } catch {
    throw new Error("S3_EXACT_MARKER_INSPECTION_INVALID_UTF8");
  }
}

interface ExactMarkerProcessRow {
  readonly pid: number;
  readonly command: string;
}

function parseExactMarkerCensusRows(stdout: string, stderr: string): ExactMarkerProcessRow[] {
  if (stderr !== "") throw new Error("S3_EXACT_MARKER_INSPECTION_STDERR");
  if (!stdout.endsWith("\n")) throw new Error("S3_EXACT_MARKER_INSPECTION_TRUNCATED");
  const lines = stdout.slice(0, -1).split("\n");
  const rows: ExactMarkerProcessRow[] = [];
  const seenPids = new Set<number>();
  let runnerPresent = false;
  for (const line of lines) {
    const match = /^\s*([1-9][0-9]*)\s+(.+)$/u.exec(line);
    const pid = Number(match?.[1]);
    const command = match?.[2];
    if (
      match === null ||
      typeof command !== "string" ||
      !Number.isSafeInteger(pid) ||
      seenPids.has(pid)
    ) {
      throw new Error("S3_EXACT_MARKER_INSPECTION_MALFORMED");
    }
    seenPids.add(pid);
    if (pid === process.pid) runnerPresent = true;
    rows.push({ pid, command });
  }
  if (!runnerPresent) throw new Error("S3_EXACT_MARKER_INSPECTION_NONVACUOUS");
  return rows;
}

function parseExactMarkerCensus(stdout: string, stderr: string, marker: string): number[] {
  return parseExactMarkerCensusRows(stdout, stderr)
    .filter((row) => row.command.includes(marker))
    .map((row) => row.pid);
}

function parseExactMarkerRunnerCensus(stdout: string, stderr: string): void {
  const rows = parseExactMarkerCensusRows(stdout, stderr);
  if (rows.length !== 1 || rows[0]?.pid !== process.pid) {
    throw new Error("S3_EXACT_MARKER_INSPECTION_RUNNER_SHAPE");
  }
}

function parseExactMarkerTargetCensus(
  stdout: string,
  stderr: string,
  marker: string,
  targetPid: number,
): number[] {
  const rows = parseExactMarkerCensusRows(stdout, stderr);
  if (
    rows.length !== 2 ||
    rows[0]?.pid !== process.pid ||
    rows[1]?.pid !== targetPid ||
    !rows[1].command.includes(marker)
  ) {
    throw new Error("S3_EXACT_MARKER_INSPECTION_IDENTITY_MISMATCH");
  }
  return [targetPid];
}

function exactMarkerResultBytes(text: string, retainedBytes: number, label: string): Buffer {
  if (
    !Number.isSafeInteger(retainedBytes) ||
    retainedBytes < 0 ||
    retainedBytes > S3_MARKER_CENSUS_MAX_BYTES ||
    text.includes("\uFFFD")
  ) {
    throw new Error(`${label}_INVALID_UTF8`);
  }
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength !== retainedBytes) throw new Error(`${label}_INVALID_UTF8`);
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label}_INVALID_UTF8`);
  }
  if (decoded !== text) throw new Error(`${label}_INVALID_UTF8`);
  return bytes;
}

async function exactMarkerPs(
  pid: number,
  deadlineAt: number,
): Promise<{
  readonly status: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}> {
  // Direct spawnSync pipes are forbidden here: Bun 1.3.8 under bun test can
  // report status 0 with two empty in-memory pipes. Reuse the authenticated,
  // pinned, unlinked fresh-runtime result inode instead of adding a raw file or
  // numeric-fd fallback.
  const remainingOuterMs = Math.floor(deadlineAt - performance.now());
  const commandTimeoutMs = Math.min(
    S3_MARKER_INSPECTION_TIMEOUT_MS,
    remainingOuterMs - S3_FRESH_RUNTIME_DIRECT_REAP_MS - 1,
  );
  if (commandTimeoutMs < 1) {
    throw new Error("S3_EXACT_MARKER_INSPECTION_DEADLINE");
  }
  const observation = await runFreshOwnedS3Command(
    ["/bin/ps", "-ww", "-p", String(pid), "-o", "pid=,command="],
    "S3_EXACT_MARKER_PS",
    {
      timeoutMs: commandTimeoutMs,
      outerTimeoutMs: remainingOuterMs,
      retainedStreamBytes: S3_MARKER_CENSUS_MAX_BYTES,
      retainedOutputBytes: S3_MARKER_CENSUS_MAX_BYTES,
    },
  );
  if (performance.now() > deadlineAt) {
    throw new Error("S3_EXACT_MARKER_INSPECTION_DEADLINE");
  }
  const result = observation.result;
  const status = result.exitCode;
  if (
    !observation.cleanupProven ||
    result.outcome !== "exited" ||
    typeof status !== "number" ||
    !Number.isSafeInteger(status) ||
    !Number.isSafeInteger(result.retainedOutputBytes) ||
    result.retainedOutputBytes !== result.retainedStdoutBytes + result.retainedStderrBytes ||
    result.retainedOutputBytes > S3_MARKER_CENSUS_MAX_BYTES
  ) {
    throw new Error("S3_EXACT_MARKER_INSPECTION_UNPROVEN");
  }
  return {
    status,
    stdout: exactMarkerResultBytes(
      result.stdout,
      result.retainedStdoutBytes,
      "S3_EXACT_MARKER_STDOUT",
    ),
    stderr: exactMarkerResultBytes(
      result.stderr,
      result.retainedStderrBytes,
      "S3_EXACT_MARKER_STDERR",
    ),
  };
}

interface ExactMarkerTarget {
  readonly pid: number;
  readonly marker: string;
}

async function observeExactMarkerTargets(
  targets: readonly ExactMarkerTarget[],
  deadlineAt: number,
): Promise<number[]> {
  if (
    targets.length === 0 ||
    targets.length > 2 ||
    new Set(targets.map((target) => target.pid)).size !== targets.length ||
    targets.some(
      (target) =>
        !Number.isSafeInteger(target.pid) ||
        target.pid <= 1 ||
        target.pid === process.pid ||
        target.marker.length === 0,
    )
  ) {
    throw new Error("S3_EXACT_MARKER_TARGET_PID_INVALID");
  }
  const runnerInspection = await exactMarkerPs(process.pid, deadlineAt);
  if (runnerInspection.status !== 0) {
    throw new Error("S3_EXACT_MARKER_INSPECTION_UNPROVEN");
  }
  const runner = decodeExactMarkerCensusCapture(runnerInspection.stdout, runnerInspection.stderr);
  parseExactMarkerRunnerCensus(runner.stdout, runner.stderr);
  const survivors: number[] = [];
  for (const target of targets) {
    const targetInspection = await exactMarkerPs(target.pid, deadlineAt);
    if (targetInspection.status !== 0 && targetInspection.status !== 1) {
      throw new Error("S3_EXACT_MARKER_INSPECTION_UNPROVEN");
    }
    if (targetInspection.status === 1) {
      if (targetInspection.stdout.byteLength !== 0 || targetInspection.stderr.byteLength !== 0) {
        throw new Error("S3_EXACT_MARKER_INSPECTION_NO_MATCH_SHAPE");
      }
      continue;
    }
    const captured = decodeExactMarkerCensusCapture(
      targetInspection.stdout,
      targetInspection.stderr,
    );
    survivors.push(
      ...parseExactMarkerTargetCensus(
        runner.stdout + captured.stdout,
        runner.stderr + captured.stderr,
        target.marker,
        target.pid,
      ),
    );
  }
  return survivors;
}

async function exactMarkerProcessIds(
  targetPid: number,
  marker: string,
  deadlineAt: number,
): Promise<number[]> {
  return await observeExactMarkerTargets([{ pid: targetPid, marker }], deadlineAt);
}

type ExactMarkerObserver = (
  targets: readonly ExactMarkerTarget[],
  deadlineAt: number,
) => Promise<number[]>;

async function waitForExactMarkerAbsences(
  targets: readonly ExactMarkerTarget[],
  observe: ExactMarkerObserver = observeExactMarkerTargets,
): Promise<void> {
  const deadline = performance.now() + S3_OUTER_LEASE_RETIRE_WAIT_MS;
  let pending = [...targets];
  let lastPids = pending.map((target) => target.pid);
  // Reusing an evidence inode would commingle observations. With deletion out
  // of scope, the explicit cap retains at most attempts * (runner + targets):
  // six private invocation directories for one PID, nine for the two-PID plant.
  for (
    let attempt = 0;
    attempt < S3_MARKER_CENSUS_MAX_ATTEMPTS && performance.now() < deadline;
    attempt += 1
  ) {
    const soleTarget = pending[0];
    lastPids =
      pending.length === 1 && soleTarget !== undefined
        ? observe === observeExactMarkerTargets
          ? await exactMarkerProcessIds(soleTarget.pid, soleTarget.marker, deadline)
          : await observe(pending, deadline)
        : await observe(pending, deadline);
    if (lastPids.length === 0) return;
    pending = pending.filter((target) => lastPids.includes(target.pid));
    if (attempt + 1 < S3_MARKER_CENSUS_MAX_ATTEMPTS && performance.now() < deadline) {
      await Bun.sleep(20);
    }
  }
  throw new Error(
    `S3_OUTER_DEADLINE_MARKER_SURVIVED:${pending.map((target) => target.marker).join(",")}:${lastPids.join(",")}`,
  );
}

async function waitForExactMarkerAbsence(targetPid: number, marker: string): Promise<void> {
  await waitForExactMarkerAbsences([{ pid: targetPid, marker }]);
}

async function waitForExactReadyMarker(path: string, marker: string): Promise<number> {
  const deadline = performance.now() + S3_OUTER_DEADLINE_PLANT_MS;
  let observed = "";
  while (performance.now() < deadline) {
    observed = readFileSync(path, "utf8");
    const match = new RegExp(`^${marker} ([1-9][0-9]*)\\n$`, "u").exec(observed);
    const targetPid = Number(match?.[1]);
    if (match !== null && Number.isSafeInteger(targetPid)) return targetPid;
    await Bun.sleep(20);
  }
  throw new Error(`S3_OUTER_DEADLINE_TARGET_NOT_READY:${JSON.stringify(observed)}`);
}

interface ExactReadyProcessGroup {
  readonly leaderPid: number;
  readonly leaderPgid: number;
  readonly descendantPid: number;
  readonly descendantPgid: number;
}

function parseExactReadyProcessGroup(
  observed: string,
  nonce: string,
): ExactReadyProcessGroup | undefined {
  const match = new RegExp(
    `^${nonce} ([1-9][0-9]*) ([1-9][0-9]*) ([1-9][0-9]*) ([1-9][0-9]*)\\n$`,
    "u",
  ).exec(observed);
  if (match === null) return undefined;
  const leaderPid = Number(match[1]);
  const leaderPgid = Number(match[2]);
  const descendantPid = Number(match[3]);
  const descendantPgid = Number(match[4]);
  if (
    ![leaderPid, leaderPgid, descendantPid, descendantPgid].every((value) =>
      Number.isSafeInteger(value),
    ) ||
    leaderPid <= 1 ||
    descendantPid <= 1 ||
    leaderPid === descendantPid ||
    leaderPid === process.pid ||
    descendantPid === process.pid ||
    leaderPgid !== descendantPgid
  ) {
    return undefined;
  }
  return { leaderPid, leaderPgid, descendantPid, descendantPgid };
}

async function waitForExactReadyProcessGroup(
  path: string,
  nonce: string,
): Promise<ExactReadyProcessGroup> {
  const deadline = performance.now() + S3_OUTER_DEADLINE_PLANT_MS;
  let observed = "";
  while (performance.now() < deadline) {
    observed = readFileSync(path, "utf8");
    const group = parseExactReadyProcessGroup(observed, nonce);
    if (group !== undefined) return group;
    await Bun.sleep(20);
  }
  throw new Error(`S3_OUTER_DEADLINE_GROUP_NOT_READY:${JSON.stringify(observed)}`);
}

test("PLANTED: fresh result parser enforces exact schema bytes and cleanup correlations", () => {
  const nonce = crypto.randomUUID();
  const exited = {
    outcome: "exited",
    exitCode: 0,
    stdout: "",
    stderr: "",
    retainedStdoutBytes: 0,
    retainedStderrBytes: 0,
    retainedOutputBytes: 0,
  };
  expect(
    isFreshOwnedS3ResultPayload({ nonce, kind: "result", result: exited, cleanupProven: true }),
  ).toBe(true);
  expect(
    isOwnedCommandResult({
      outcome: "toString",
      stdout: "",
      stderr: "",
      retainedStdoutBytes: 0,
      retainedStderrBytes: 0,
      retainedOutputBytes: 0,
    }),
  ).toBe(false);
  expect(
    isFreshOwnedS3ResultPayload({ nonce, kind: "result", result: exited, cleanupProven: false }),
  ).toBe(false);
  expect(
    isFreshOwnedS3ResultPayload({
      nonce,
      kind: "result",
      result: { ...exited, cleanupProven: false },
      cleanupProven: true,
    }),
  ).toBe(false);
  expect(
    isFreshOwnedS3ResultPayload({
      nonce,
      kind: "result",
      result: { ...exited, injected: true },
      cleanupProven: true,
    }),
  ).toBe(false);
  expect(
    isFreshOwnedS3ResultPayload({
      nonce,
      kind: "result",
      result: exited,
      cleanupProven: true,
      injected: true,
    }),
  ).toBe(false);
  expect(
    isOwnedCommandResult({
      ...exited,
      stdout: "x",
      retainedStdoutBytes: 0,
    }),
  ).toBe(false);
  expect(
    isOwnedCommandResult({
      ...exited,
      retainedStdoutBytes: 1,
      retainedOutputBytes: 0,
    }),
  ).toBe(false);
  expect(
    isOwnedCommandResult({
      outcome: "timeout",
      signal: "SIG9",
      stdout: "",
      stderr: "",
      retainedStdoutBytes: 0,
      retainedStderrBytes: 0,
      retainedOutputBytes: 0,
      cleanupProven: false,
    }),
  ).toBe(false);
  expect(isOwnedCommandResult({ ...exited, exitCode: 137, signal: "SIG9" })).toBe(true);
  expect(isOwnedCommandResult({ ...exited, exitCode: 138, signal: "SIG9" })).toBe(false);
  expect(isOwnedCommandResult({ ...exited, exitCode: 128, signal: "SIG0" })).toBe(false);
  expect(
    isOwnedCommandResult({
      outcome: "timeout",
      exitCode: 0,
      stdout: "",
      stderr: "",
      retainedStdoutBytes: 0,
      retainedStderrBytes: 0,
      retainedOutputBytes: 0,
      cleanupProven: true,
    }),
  ).toBe(false);
  expect(
    isFreshOwnedS3ResultPayload({
      nonce,
      kind: "result",
      result: {
        outcome: "ownership-unproven",
        ownershipFailurePhase: "initial-census",
        stdout: "",
        stderr: "",
        retainedStdoutBytes: 0,
        retainedStderrBytes: 0,
        retainedOutputBytes: 0,
        cleanupProven: false,
      },
      cleanupProven: false,
    }),
  ).toBe(true);
  expect(
    isFreshOwnedS3ResultPayload({
      nonce,
      kind: "result",
      result: {
        outcome: "ownership-unproven",
        ownershipFailurePhase: "leader-reap",
        stdout: "",
        stderr: "",
        retainedStdoutBytes: 0,
        retainedStderrBytes: 0,
        retainedOutputBytes: 0,
        cleanupProven: true,
      },
      cleanupProven: true,
    }),
  ).toBe(true);
});

test("PLANTED: helper and parent reject every forbidden outcome optional-field mutation", () => {
  const base = {
    stdout: "",
    stderr: "",
    retainedStdoutBytes: 0,
    retainedStderrBytes: 0,
    retainedOutputBytes: 0,
  };
  const accepted: readonly Record<string, unknown>[] = [
    { ...base, outcome: "exited", exitCode: 0 },
    { ...base, outcome: "exited", exitCode: 137, signal: "SIG9" },
    { ...base, outcome: "timeout", cleanupProven: true },
    { ...base, outcome: "output-overrun", cleanupProven: true },
    { ...base, outcome: "output-overrun", exitCode: 137, signal: "SIG9", cleanupProven: true },
    { ...base, outcome: "descendant-leaked", exitCode: 0 },
    { ...base, outcome: "descendant-leaked", exitCode: 137, signal: "SIG9" },
    { ...base, outcome: "pipe-drain-unproven", exitCode: 0 },
    { ...base, outcome: "inspection-unproven", cleanupProven: false },
    { ...base, outcome: "inspection-unproven", exitCode: 0 },
    { ...base, outcome: "inspection-unproven", exitCode: 0, cleanupProven: false },
    {
      ...base,
      outcome: "ownership-unproven",
      ownershipFailurePhase: "initial-census",
      cleanupProven: false,
    },
    {
      ...base,
      outcome: "ownership-unproven",
      ownershipFailurePhase: "control-stream",
      cleanupProven: true,
    },
    {
      ...base,
      outcome: "ownership-unproven",
      ownershipFailurePhase: "terminal-record",
      exitCode: 0,
    },
    {
      ...base,
      outcome: "ownership-unproven",
      ownershipFailurePhase: "leader-reap",
      exitCode: 0,
      cleanupProven: true,
    },
    { ...base, outcome: "spawn-failed" },
    { ...base, outcome: "spawn-failed", cleanupProven: false },
    { ...base, outcome: "spawn-failed", cleanupProven: true },
    { ...base, outcome: "spawn-failed", exitCode: 125, cleanupProven: false },
    { ...base, outcome: "spawn-failed", exitCode: 125, cleanupProven: true },
  ];
  const forbidden: readonly Record<string, unknown>[] = [
    { ...base, outcome: "exited" },
    { ...base, outcome: "exited", exitCode: 0, cleanupProven: false },
    { ...base, outcome: "exited", exitCode: 256 },
    { ...base, outcome: "exited", exitCode: 138, signal: "SIG9" },
    { ...base, outcome: "timeout" },
    { ...base, outcome: "timeout", cleanupProven: false },
    { ...base, outcome: "timeout", exitCode: 0, cleanupProven: true },
    { ...base, outcome: "output-overrun" },
    { ...base, outcome: "output-overrun", cleanupProven: false },
    { ...base, outcome: "output-overrun", signal: "SIG9", cleanupProven: true },
    { ...base, outcome: "descendant-leaked" },
    { ...base, outcome: "descendant-leaked", exitCode: 0, cleanupProven: false },
    { ...base, outcome: "pipe-drain-unproven" },
    { ...base, outcome: "pipe-drain-unproven", exitCode: 0, cleanupProven: true },
    { ...base, outcome: "inspection-unproven" },
    { ...base, outcome: "inspection-unproven", cleanupProven: true },
    { ...base, outcome: "inspection-unproven", exitCode: 0, cleanupProven: true },
    { ...base, outcome: "ownership-unproven" },
    {
      ...base,
      outcome: "ownership-unproven",
      ownershipFailurePhase: "not-a-production-phase",
      cleanupProven: true,
    },
    {
      ...base,
      outcome: "ownership-unproven",
      ownershipFailurePhase: "term-signal",
      signal: "SIG9",
      cleanupProven: true,
    },
    {
      ...base,
      outcome: "exited",
      ownershipFailurePhase: "ready-record",
      exitCode: 0,
    },
    {
      ...base,
      outcome: "spawn-failed",
      exitCode: 137,
      signal: "SIG9",
      cleanupProven: true,
    },
    { ...base, outcome: "spawn-failed", exitCode: 125 },
    { ...base, outcome: "spawn-failed", exitCode: 125, signal: "SIG125", cleanupProven: true },
    { ...base, outcome: "spawn-failed", exitCode: 0, cleanupProven: true },
    { ...base, outcome: "spawn-failed", signal: "SIG9", cleanupProven: false },
  ];
  for (const result of accepted) {
    expect(isOwnedCommandResult(result)).toBe(true);
    expect(isFreshDispatcherOwnedResultForTest(result)).toBe(true);
  }
  for (const result of forbidden) {
    expect(isOwnedCommandResult(result)).toBe(false);
    expect(isFreshDispatcherOwnedResultForTest(result)).toBe(false);
  }
  for (const ownershipFailurePhase of Object.keys(OWNED_SESSION_FAILURE_PHASES)) {
    const result = {
      ...base,
      outcome: "ownership-unproven",
      ownershipFailurePhase,
      cleanupProven: false,
    };
    expect(isOwnedCommandResult(result)).toBe(true);
    expect(isFreshDispatcherOwnedResultForTest(result)).toBe(true);
  }
  expect(FRESH_OWNED_COMMAND_DISPATCHER).toContain(
    `const OWNED_FAILURE_PHASES = new Set(${JSON.stringify(Object.keys(OWNED_SESSION_FAILURE_PHASES))});`,
  );
  expect(FRESH_OWNED_COMMAND_DISPATCHER).toContain(
    `const ownedOutcomeFieldsValid = ${ownedOutcomeFieldsValid.toString()};`,
  );
  expect(FRESH_OWNED_COMMAND_DISPATCHER).toContain(
    `const ownedCommandResultIsExact = ${ownedCommandResultIsExact.toString()};`,
  );
});

test("PLANTED: exact marker census refuses empty and truncated snapshots", () => {
  const marker = `s3-census-negative-${crypto.randomUUID()}`;
  expect(() => parseExactMarkerCensus("", "", marker)).toThrow(
    "S3_EXACT_MARKER_INSPECTION_TRUNCATED",
  );
  expect(() => parseExactMarkerCensus(`${process.pid} runner`, "", marker)).toThrow(
    "S3_EXACT_MARKER_INSPECTION_TRUNCATED",
  );
});

test("PLANTED: pair-aware absence cannot pass when only the leader retires", async () => {
  const leader = { pid: process.pid + 100_000, marker: `leader-${crypto.randomUUID()}` };
  const descendant = {
    pid: process.pid + 100_001,
    marker: `descendant-${crypto.randomUUID()}`,
  };
  const observations: number[][] = [];
  await expect(
    waitForExactMarkerAbsences([leader, descendant], async (targets) => {
      observations.push(targets.map((target) => target.pid));
      return targets.filter((target) => target.pid === descendant.pid).map((target) => target.pid);
    }),
  ).rejects.toThrow(`S3_OUTER_DEADLINE_MARKER_SURVIVED:${descendant.marker}:${descendant.pid}`);
  expect(observations).toEqual([[leader.pid, descendant.pid], [descendant.pid], [descendant.pid]]);
});

test("PLANTED: direct status-zero empty pipes and unsafe exact-marker captures always refuse", () => {
  const marker = `s3-census-capture-${crypto.randomUUID()}`;
  const anchored = Buffer.from(`${process.pid} bun-test-census-anchor\n`, "utf8");
  const decoded = decodeExactMarkerCensusCapture(anchored, Buffer.alloc(0));
  expect(parseExactMarkerCensus(decoded.stdout, decoded.stderr, marker)).toEqual([]);
  expect(() => decodeExactMarkerCensusCapture("not-a-buffer", Buffer.alloc(0))).toThrow(
    "S3_EXACT_MARKER_INSPECTION_CAPTURE_TYPE",
  );
  expect(() => decodeExactMarkerCensusCapture(Buffer.alloc(0), Buffer.alloc(0))).toThrow(
    "S3_EXACT_MARKER_INSPECTION_EMPTY",
  );
  expect(() =>
    decodeExactMarkerCensusCapture(Buffer.alloc(S3_MARKER_CENSUS_MAX_BYTES + 1), Buffer.alloc(0)),
  ).toThrow("S3_EXACT_MARKER_INSPECTION_OVERRUN");
  expect(() => decodeExactMarkerCensusCapture(Buffer.from([0xff, 0x0a]), Buffer.alloc(0))).toThrow(
    "S3_EXACT_MARKER_INSPECTION_INVALID_UTF8",
  );

  const targetPid = process.pid + 1;
  expect(
    parseExactMarkerTargetCensus(
      `${process.pid} runner\n${targetPid} target ${marker}\n`,
      "",
      marker,
      targetPid,
    ),
  ).toEqual([targetPid]);
  expect(() =>
    parseExactMarkerTargetCensus(
      `${process.pid} runner\n${targetPid} reused-without-marker\n`,
      "",
      marker,
      targetPid,
    ),
  ).toThrow("S3_EXACT_MARKER_INSPECTION_IDENTITY_MISMATCH");
});

test("PLANTED: fresh pinned /bin/ps capture is nonempty and anchored to the live test runner", async () => {
  const marker = `s3-census-live-${crypto.randomUUID()}`;
  const deadline = performance.now() + S3_OUTER_LEASE_RETIRE_WAIT_MS;
  const inspection = await exactMarkerPs(process.pid, deadline);
  expect(inspection.status).toBe(0);
  const capture = decodeExactMarkerCensusCapture(inspection.stdout, inspection.stderr);
  expect(parseExactMarkerCensus(capture.stdout, capture.stderr, marker)).toEqual([]);
  expect(performance.now()).toBeLessThanOrEqual(deadline);
  await expect(
    exactMarkerPs(process.pid, performance.now() + S3_FRESH_RUNTIME_DIRECT_REAP_MS),
  ).rejects.toThrow("S3_EXACT_MARKER_INSPECTION_DEADLINE");
});

for (const bootstrapPlant of [
  "malformed",
  "invalid-utf8",
  "noncanonical",
  "extra-record",
  "partial",
  "overrun",
  "eof",
  "runner-digest",
  "tamper",
  "symlink",
  "path-swap",
] as const) {
  test(
    `PLANTED: ${bootstrapPlant} bootstrap record fails closed without target import or authority parsing`,
    async () => {
      const markerDirectory = makePrivateFixtureDirectory();
      const markerPath = join(
        markerDirectory,
        `bootstrap-target-ran-${bootstrapPlant}-${crypto.randomUUID()}`,
      );
      const invocation = await invokeFreshOwnedS3Command(
        [
          "perl",
          "-e",
          'open(my $marker, ">", $ARGV[0]) or exit 111; print {$marker} "target-ran\\n" or exit 112; close($marker) or exit 113;',
          markerPath,
        ],
        {
          timeoutMs: 2_000,
          bootstrapPlant,
        },
      );
      try {
        expect(await settleFreshRuntime(invocation)).toBe("exited");
        expect(invocation.helperReaped).toBe(true);
        expect(invocation.timeoutWon).toBe(false);
        expect(invocation.helper.signalCode).toBeNull();
        expect(invocation.exitCode).not.toBe(0);
        expect(
          await freshRuntimePipeBefore(
            invocation.stdoutCapture,
            invocation.deadlineAt,
            "S3_FRESH_BOOTSTRAP_STDOUT",
          ),
        ).toEqual(Buffer.alloc(0));
        expect(
          await freshRuntimePipeBefore(
            invocation.stderrCapture,
            invocation.deadlineAt,
            "S3_FRESH_BOOTSTRAP_STDERR",
          ),
        ).toEqual(Buffer.alloc(0));
        const original = fstatSync(invocation.resultFd, { bigint: true }) as ExactBigIntStat;
        if (bootstrapPlant === "runner-digest") {
          expect(sameIdentityExceptNlink(original, invocation.resultIdentity, 0n)).toBe(true);
          expect(() => lstatSync(invocation.resultPath)).toThrow();
        } else {
          const named = lstatSync(invocation.resultPath, { bigint: true }) as ExactBigIntStat;
          expect(sameExactIdentity(original, invocation.resultIdentity)).toBe(true);
          expect(sameExactIdentity(named, invocation.resultIdentity)).toBe(true);
        }
        expect(original.size).toBe(0n);
        const bootstrapOriginal = fstatSync(invocation.bootstrapFd, {
          bigint: true,
        }) as ExactBigIntStat;
        if (bootstrapPlant === "overrun" || bootstrapPlant === "eof") {
          expect(sameExactFileIdentity(bootstrapOriginal, invocation.bootstrapIdentity)).toBe(true);
          expect(
            sameExactFileIdentity(
              lstatSync(invocation.bootstrapPath, { bigint: true }) as ExactBigIntStat,
              invocation.bootstrapIdentity,
            ),
          ).toBe(true);
        } else {
          expect(sameIdentityExceptNlink(bootstrapOriginal, invocation.bootstrapIdentity, 0n)).toBe(
            true,
          );
          expect(bootstrapOriginal.size.toString(10)).toBe(invocation.bootstrapIdentity.size);
          if (bootstrapPlant === "symlink") {
            expect(lstatSync(invocation.bootstrapPath).isSymbolicLink()).toBe(true);
          } else if (bootstrapPlant === "path-swap") {
            const replacement = lstatSync(invocation.bootstrapPath, {
              bigint: true,
            }) as ExactBigIntStat;
            expect(replacement.isFile()).toBe(true);
            expect(sameExactFileIdentity(replacement, invocation.bootstrapIdentity)).toBe(false);
          } else {
            expect(() => lstatSync(invocation.bootstrapPath)).toThrow();
          }
        }
        assertPinnedFreshRuntimeDirectory(invocation, "S3_FRESH_BOOTSTRAP");
        expect(() => lstatSync(markerPath)).toThrow();
      } finally {
        await retireAndCloseFreshRuntime(invocation);
      }
      expect(invocation.bootstrapFdClosed).toBe(true);
      expect(invocation.resultFdClosed).toBe(true);
      expect(invocation.directoryFdClosed).toBe(true);
    },
    { timeout: 20_000 },
  );
}

test(
  "PLANTED: post-run runner digest mismatch refuses publication after causal target execution",
  async () => {
    const markerDirectory = makePrivateFixtureDirectory();
    const markerPath = join(markerDirectory, `runner-after-${crypto.randomUUID()}`);
    const invocation = await invokeFreshOwnedS3Command(
      [
        "perl",
        "-e",
        'open(my $marker, ">", $ARGV[0]) or exit 111; print {$marker} "target-ran-before-after-digest-check\\n" or exit 112; close($marker) or exit 113;',
        markerPath,
      ],
      { timeoutMs: 2_000, runnerDigestPlant: "after" },
    );
    try {
      expect(await settleFreshRuntime(invocation)).toBe("exited");
      expect(invocation.exitCode).toBe(S3_FRESH_RUNTIME_RUNNER_AUTHORITY_EXIT_CODE);
      expect(invocation.helper.signalCode).toBeNull();
      expect(readFileSync(markerPath, "utf8")).toBe("target-ran-before-after-digest-check\n");
      const result = fstatSync(invocation.resultFd, { bigint: true }) as ExactBigIntStat;
      expect(sameIdentityExceptNlink(result, invocation.resultIdentity, 0n)).toBe(true);
      expect(result.size).toBe(0n);
      expect(() => lstatSync(invocation.resultPath)).toThrow();
    } finally {
      await retireAndCloseFreshRuntime(invocation);
    }
  },
  { timeout: 10_000 },
);

test("PLANTED: an overrun pipe requests and settles cancellation exactly once", async () => {
  let cancellations = 0;
  let cancellationSettled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(129));
    },
    cancel() {
      cancellations += 1;
      cancellationSettled = true;
    },
  });
  const capture = beginFreshRuntimePipeCapture(stream, 128, "S3_FRESH_RUNTIME_CANCEL");
  await expect(capture.complete).rejects.toThrow(
    "S3_FRESH_RUNTIME_CANCEL_FRESH_RUNTIME_PIPE_OVERRUN",
  );
  expect(capture.cancellationRequested()).toBe(true);
  await expect(capture.cancellationSettled()).resolves.toBeUndefined();
  expect(capture.cancellationIsSettled()).toBe(true);
  expect(cancellations).toBe(1);
  expect(cancellationSettled).toBe(true);
});

test("PLANTED: a hanging pipe cancellation refuses at the absolute deadline", async () => {
  let cancellationRequested = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancellationRequested = true;
      return new Promise<void>(() => undefined);
    },
  });
  const capture = beginFreshRuntimePipeCapture(stream, 128, "S3_FRESH_RUNTIME_CANCEL_HANG");
  await expect(
    settleFreshRuntimeCaptureCancellation(
      [capture],
      performance.now() + 25,
      "S3_FRESH_RUNTIME_CANCEL_HANG",
    ),
  ).rejects.toThrow("S3_FRESH_RUNTIME_CANCEL_HANG_DEADLINE");
  expect(capture.cancellationRequested()).toBe(true);
  expect(capture.cancellationIsSettled()).toBe(false);
  expect(cancellationRequested).toBe(true);
});

test(
  "PLANTED: fresh runtime closes its held bootstrap result and directory fds when retirement refuses",
  async () => {
    const invocation = await invokeFreshOwnedS3Command(["perl", "-e", 'print "fd-close";'], {
      timeoutMs: 2_000,
    });
    try {
      await assertFreshRuntimeExited(invocation, "S3_FRESH_FD_CLOSE");
      await readFreshOwnedS3Result(invocation, "S3_FRESH_FD_CLOSE");
      let cancellationRequested = false;
      const hangingCapture = beginFreshRuntimePipeCapture(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancellationRequested = true;
            return new Promise<void>(() => undefined);
          },
        }),
        128,
        "S3_FRESH_FD_CLOSE_HANG",
      );
      await expect(
        retireAndCloseFreshRuntime(invocation, async () => {
          await settleFreshRuntimeCaptureCancellation(
            [hangingCapture],
            performance.now() + 25,
            "S3_FRESH_FD_CLOSE_HANG",
          );
        }),
      ).rejects.toThrow("S3_FRESH_FD_CLOSE_HANG_DEADLINE");
      expect(cancellationRequested).toBe(true);
      expect(invocation.bootstrapFdClosed).toBe(true);
      expect(invocation.resultFdClosed).toBe(true);
      expect(invocation.directoryFdClosed).toBe(true);
      expect(() => fstatSync(invocation.bootstrapFd)).toThrow();
      expect(() => fstatSync(invocation.resultFd)).toThrow();
      expect(() => fstatSync(invocation.directoryFd)).toThrow();
    } finally {
      await retireAndCloseFreshRuntime(invocation);
    }
  },
  { timeout: 10_000 },
);

test(
  "PLANTED: isolated S-3 build receipts preserve the production/counterfactual sentinel split",
  async () => {
    const productionEntrypoint = resolve(root, "apps/wire/src/index.ts");
    const localWorkerEntrypoint = resolve(root, "apps/wire/src/split/local-worker.ts");
    const productionReceipt = await isolatedProductionBundle(
      "production",
      productionEntrypoint,
      localWorkerEntrypoint,
    );
    const counterfactualReceipt = await isolatedProductionBundle(
      "counterfactual",
      productionEntrypoint,
      localWorkerEntrypoint,
    );

    expect(productionReceipt.mode).toBe("production");
    expect(productionReceipt.output_count).toBeGreaterThan(0);
    expect(productionReceipt.output_bytes).toBeGreaterThan(0);
    expect(productionReceipt.matched_local_worker_sentinels).toEqual([]);
    expect(counterfactualReceipt.mode).toBe("counterfactual");
    expect(counterfactualReceipt.output_count).toBeGreaterThan(0);
    expect(counterfactualReceipt.output_bytes).toBeGreaterThan(0);
    expect(counterfactualReceipt.matched_local_worker_sentinels).toEqual(
      LOCAL_WORKER_BUNDLE_SENTINELS,
    );
    assertIsolatedBuildScriptDataflow(ISOLATED_BUILD_SCRIPT);
    assertIsolatedBuildChildArguments(
      isolatedBuildCommand("production", productionEntrypoint, localWorkerEntrypoint),
      "production",
      productionEntrypoint,
      localWorkerEntrypoint,
    );
    expect(FRESH_OWNED_COMMAND_DISPATCHER).toContain('const BOOTSTRAP_NAME = "bootstrap.json";');
    expect(FRESH_OWNED_COMMAND_DISPATCHER).toContain('const RESULT_NAME = "result.json";');
    expect(FRESH_OWNED_COMMAND_DISPATCHER).toContain("const bootstrap = readBootstrap();");
    expect(FRESH_OWNED_COMMAND_DISPATCHER).toContain("unlinkSync(BOOTSTRAP_NAME);");
    expect(FRESH_OWNED_COMMAND_DISPATCHER).toContain("unlinkSync(RESULT_NAME);");
    expect(FRESH_OWNED_COMMAND_DISPATCHER).toContain(
      "const result = await module.runOwnedCommand(bootstrap.options);",
    );
    expect(FRESH_OWNED_COMMAND_DISPATCHER).toContain(
      "writeSync(fd, bytes, offset, bytes.byteLength - offset, offset)",
    );
    expect(FRESH_OWNED_COMMAND_DISPATCHER).toContain(
      "constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW",
    );
    expect(FRESH_OWNED_COMMAND_DISPATCHER).not.toContain("process.argv");
    expect(FRESH_OWNED_COMMAND_DISPATCHER).not.toContain("process.stdin");
    const bootstrapUnlink = FRESH_OWNED_COMMAND_DISPATCHER.indexOf("unlinkSync(BOOTSTRAP_NAME);");
    const bootstrapClose = FRESH_OWNED_COMMAND_DISPATCHER.indexOf(
      "closeQuietly(bootstrapFd);",
      bootstrapUnlink,
    );
    expect(bootstrapUnlink).toBeGreaterThan(-1);
    expect(bootstrapClose).toBeGreaterThan(bootstrapUnlink);
    expect(bootstrapClose).toBeLessThan(FRESH_OWNED_COMMAND_DISPATCHER.indexOf("JSON.parse(text)"));
    expect(FRESH_OWNED_COMMAND_DISPATCHER.indexOf("unlinkSync(RESULT_NAME);")).toBeLessThan(
      FRESH_OWNED_COMMAND_DISPATCHER.indexOf("await import(bootstrap.runnerUrl)"),
    );
    const importAt = FRESH_OWNED_COMMAND_DISPATCHER.indexOf("await import(bootstrap.runnerUrl)");
    const resultAt = FRESH_OWNED_COMMAND_DISPATCHER.indexOf(
      "const result = await module.runOwnedCommand(bootstrap.options);",
    );
    const digestBeforeImport = FRESH_OWNED_COMMAND_DISPATCHER.lastIndexOf(
      "runnerDigestMatches(bootstrap)",
      importAt,
    );
    const digestAfterResult = FRESH_OWNED_COMMAND_DISPATCHER.indexOf(
      "runnerDigestMatches(bootstrap,",
      resultAt,
    );
    expect(digestBeforeImport).toBeGreaterThan(
      FRESH_OWNED_COMMAND_DISPATCHER.indexOf("unlinkSync(RESULT_NAME);"),
    );
    expect(digestBeforeImport).toBeLessThan(importAt);
    expect(digestAfterResult).toBeGreaterThan(resultAt);
    expect(digestAfterResult).toBeLessThan(
      FRESH_OWNED_COMMAND_DISPATCHER.indexOf("const publication = Buffer.from"),
    );
    expect(importAt).toBeLessThan(resultAt);
  },
  { timeout: 20_000 },
);

test(
  "PLANTED: target fd scan is nonvacuous and sees bootstrap and result authority absent",
  async () => {
    const invocation = await invokeFreshOwnedS3Command(
      [
        "perl",
        "-e",
        String.raw`use strict;
	use warnings;
	use Errno qw(ENOENT);
	use Fcntl qw(:DEFAULT);
	for my $name ("bootstrap.json", "result.json") {
	  sysopen(my $missing, $name, O_RDONLY | O_NOFOLLOW) and exit 91;
	  exit 92 unless $! == ENOENT;
	}
	sysopen(my $decoy, "target-fd-decoy", O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW, 0600) or exit 93;
	print {$decoy} "decoy" or exit 94;
	my @decoy = stat($decoy);
	my $lsof = -x "/usr/bin/lsof" ? "/usr/bin/lsof" : (-x "/usr/sbin/lsof" ? "/usr/sbin/lsof" : "lsof");
	open(my $fds, "-|", $lsof, "-n", "-P", "-FfDi", "-p", "$$") or exit 95;
	my ($decoy_seen, $bootstrap_seen, $result_seen) = (0, 0, 0);
	my ($device, $inode);
	my $finish = sub {
	  return unless defined $device && defined $inode;
	  $decoy_seen++ if $device == $decoy[0] && $inode == $decoy[1];
	  $bootstrap_seen++ if $device == $ENV{S3_FRESH_RUNTIME_BOOTSTRAP_DEV} && $inode == $ENV{S3_FRESH_RUNTIME_BOOTSTRAP_INO};
	  $result_seen++ if $device == $ENV{S3_FRESH_RUNTIME_RESULT_DEV} && $inode == $ENV{S3_FRESH_RUNTIME_RESULT_INO};
};
while (my $line = <$fds>) {
  chomp $line;
  if ($line =~ /^f/) {
    $finish->();
    ($device, $inode) = (undef, undef);
  } elsif ($line =~ /^D0x([0-9a-fA-F]+)$/) {
    $device = hex($1);
  } elsif ($line =~ /^i([0-9]+)$/) {
    $inode = $1;
  }
	}
	close($fds) or exit 96;
	$finish->();
	exit 97 unless $decoy_seen >= 1 && $bootstrap_seen == 0 && $result_seen == 0;
	print "S3_TARGET_FD_SCAN_BOTH_ENOENT_DECOY_PRESENT_AUTHORITY_ABSENT\n";`,
      ],
      { timeoutMs: 2_000, targetCwd: "private" },
    );
    try {
      await assertFreshRuntimeExited(invocation, "S3_FRESH_TARGET_FD_SCAN");
      const freshResult = await readFreshOwnedS3Result(invocation, "S3_FRESH_TARGET_FD_SCAN");
      expect(freshResult.result.outcome).toBe("exited");
      expect(freshResult.cleanupProven).toBe(true);
      expect(freshResult.result.stdout).toBe(
        ["S3_TARGET_FD_SCAN_BOTH_ENOENT_DECOY_PRESENT_AUTHORITY_ABSENT", ""].join("\n"),
      );
      const bootstrapOriginal = fstatSync(invocation.bootstrapFd, {
        bigint: true,
      }) as ExactBigIntStat;
      expect(sameIdentityExceptNlink(bootstrapOriginal, invocation.bootstrapIdentity, 0n)).toBe(
        true,
      );
      expect(bootstrapOriginal.size.toString(10)).toBe(invocation.bootstrapIdentity.size);
      const original = fstatSync(invocation.resultFd, { bigint: true }) as ExactBigIntStat;
      expect(sameIdentityExceptNlink(original, invocation.resultIdentity, 0n)).toBe(true);
    } finally {
      await retireAndCloseFreshRuntime(invocation);
    }
  },
  { timeout: 10_000 },
);

test(
  "PLANTED: target stdout cannot forge the fresh helper result record",
  async () => {
    const targetRecord = JSON.stringify({
      nonce: `target-forgery-${crypto.randomUUID()}`,
      kind: "result",
      result: {
        outcome: "exited",
        exitCode: 0,
        stdout: "target-controlled",
        stderr: "",
        retainedStdoutBytes: 0,
        retainedStderrBytes: 0,
        retainedOutputBytes: 0,
      },
      cleanupProven: true,
    });
    const invocation = await invokeFreshOwnedS3Command(
      ["perl", "-e", "print $ARGV[0]", `${targetRecord}\n`],
      { timeoutMs: 2_000 },
    );
    try {
      await assertFreshRuntimeExited(invocation, "S3_FRESH_TARGET_FORGERY");
      const freshResult = await readFreshOwnedS3Result(invocation, "S3_FRESH_TARGET_FORGERY");
      const outerBytes = readFreshRuntimeAuthorityInode(invocation, "S3_FRESH_TARGET_FORGERY");
      expect(outerBytes.includes(Buffer.from(JSON.stringify(`${targetRecord}\n`), "utf8"))).toBe(
        true,
      );
      expect(outerBytes.includes(Buffer.from(`${targetRecord}\n`, "utf8"))).toBe(false);
      expect(freshResult.result.outcome).toBe("exited");
      expect(freshResult.result.exitCode).toBe(0);
      expect(freshResult.result.stdout).toBe(`${targetRecord}\n`);
      expect(freshResult.cleanupProven).toBe(true);
    } finally {
      await retireAndCloseFreshRuntime(invocation);
    }

    const suiteCli = readFileSync(resolve(root, "scripts/suite/cli.ts"), "utf8");
    const ownedCommandSource = sourceRegion(
      suiteCli,
      "export async function runOwnedCommand(",
      "async function runToolchainIntegrationStep(",
    );
    expect(ownedCommandSource).not.toContain("process.stdout.write");
    expect(FRESH_OWNED_COMMAND_DISPATCHER).toContain(
      "const result = await module.runOwnedCommand(bootstrap.options);",
    );
    expect(FRESH_OWNED_COMMAND_DISPATCHER).not.toContain("process.stdout.write(result.stdout)");
  },
  { timeout: 10_000 },
);

test(
  "PLANTED: result-name symlink recreation refuses retained publication without touching its sentinel",
  async () => {
    const outsideDirectory = makePrivateFixtureDirectory();
    const sentinelBytes = Buffer.from("outside-sentinel-must-not-change\n", "utf8");
    const sentinelPath = writePrivateFixtureFile(
      outsideDirectory,
      "outside-sentinel",
      sentinelBytes,
    );
    const invocation = await invokeFreshOwnedS3Command(
      [
        "perl",
        "-e",
        String.raw`use strict;
use warnings;
use Errno qw(ENOENT);
use Fcntl qw(:DEFAULT);
sysopen(my $missing, "result.json", O_RDONLY | O_NOFOLLOW) and exit 91;
exit 92 unless $! == ENOENT;
symlink($ARGV[0], "result.json") or exit 96;
print "S3_TARGET_RESULT_RECREATED_AS_SYMLINK\\n";`,
        sentinelPath,
      ],
      { timeoutMs: 2_000, targetCwd: "private" },
    );
    try {
      await expect(
        assertFreshRuntimeExited(invocation, "S3_FRESH_RETAINED_COLLISION"),
      ).rejects.toThrow("S3_FRESH_RETAINED_COLLISION_FRESH_RUNTIME_RETAINED_REPUBLISH_REFUSED");
      expect(invocation.helperReaped).toBe(true);
      expect(invocation.timeoutWon).toBe(false);
      expect(invocation.helper.signalCode).toBeNull();
      const original = fstatSync(invocation.resultFd, { bigint: true }) as ExactBigIntStat;
      expect(sameIdentityExceptNlink(original, invocation.resultIdentity, 0n)).toBe(true);
      expect(original.size).toBeGreaterThan(0n);
      expect(lstatSync(invocation.resultPath).isSymbolicLink()).toBe(true);
      expect(readFileSync(sentinelPath)).toEqual(sentinelBytes);
    } finally {
      await retireAndCloseFreshRuntime(invocation);
    }
  },
  { timeout: 10_000 },
);

test(
  "PLANTED: regular result-name recreation refuses retained publication without touching external bytes",
  async () => {
    const outsideDirectory = makePrivateFixtureDirectory();
    const sentinelBytes = Buffer.from("outside-sentinel-regular-must-not-change\n", "utf8");
    const sentinelPath = writePrivateFixtureFile(
      outsideDirectory,
      "outside-sentinel",
      sentinelBytes,
    );
    const collisionBytes = Buffer.from("target-regular-collision-must-not-change\n", "utf8");
    const invocation = await invokeFreshOwnedS3Command(
      [
        "perl",
        "-e",
        'use strict; use warnings; use Errno qw(ENOENT); use Fcntl qw(:DEFAULT); sysopen(my $missing, "result.json", O_RDONLY | O_NOFOLLOW) and exit 91; exit 92 unless $! == ENOENT; sysopen(my $collision, "result.json", O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW, 0600) or exit 93; print {$collision} "target-regular-collision-must-not-change\\n" or exit 94; close($collision) or exit 95; print "S3_TARGET_RESULT_RECREATED_AS_FILE\\n";',
      ],
      { timeoutMs: 2_000, targetCwd: "private" },
    );
    try {
      await expect(
        assertFreshRuntimeExited(invocation, "S3_FRESH_RETAINED_REGULAR_COLLISION"),
      ).rejects.toThrow(
        "S3_FRESH_RETAINED_REGULAR_COLLISION_FRESH_RUNTIME_RETAINED_REPUBLISH_REFUSED",
      );
      expect(invocation.helperReaped).toBe(true);
      expect(invocation.timeoutWon).toBe(false);
      expect(invocation.helper.signalCode).toBeNull();
      const original = fstatSync(invocation.resultFd, { bigint: true }) as ExactBigIntStat;
      expect(sameIdentityExceptNlink(original, invocation.resultIdentity, 0n)).toBe(true);
      expect(original.size).toBeGreaterThan(0n);
      expect(lstatSync(invocation.resultPath).isFile()).toBe(true);
      expect(readFileSync(invocation.resultPath)).toEqual(collisionBytes);
      expect(readFileSync(sentinelPath)).toEqual(sentinelBytes);
    } finally {
      await retireAndCloseFreshRuntime(invocation);
    }
  },
  { timeout: 10_000 },
);

test(
  "PLANTED: target cwd relocation cannot redirect retained evidence outside the pinned parent",
  async () => {
    const outsideDirectory = makePrivateFixtureDirectory();
    const movedDirectory = join(outsideDirectory, "moved-private");
    const sentinelBytes = Buffer.from("outside-relocation-sentinel-must-not-change\n", "utf8");
    const sentinelPath = writePrivateFixtureFile(
      outsideDirectory,
      "outside-sentinel",
      sentinelBytes,
    );
    const invocation = await invokeFreshOwnedS3Command(
      [
        "perl",
        "-e",
        'use strict; use warnings; use Cwd qw(getcwd); use Errno qw(ENOENT); use Fcntl qw(:DEFAULT); my $original = getcwd(); sysopen(my $missing, "result.json", O_RDONLY | O_NOFOLLOW) and exit 91; exit 92 unless $! == ENOENT; rename($original, $ARGV[0]) or exit 93; mkdir($original, 0700) or exit 94; print "S3_TARGET_CWD_RELOCATED\\n";',
        movedDirectory,
      ],
      { timeoutMs: 2_000, targetCwd: "private" },
    );
    try {
      await expect(
        assertFreshRuntimeExited(invocation, "S3_FRESH_RETAINED_RELOCATION"),
      ).rejects.toThrow("S3_FRESH_RETAINED_RELOCATION_FRESH_RUNTIME_RESULT_PUBLICATION_REFUSED");
      expect(invocation.helperReaped).toBe(true);
      expect(invocation.timeoutWon).toBe(false);
      expect(invocation.helper.signalCode).toBeNull();
      const original = fstatSync(invocation.resultFd, { bigint: true }) as ExactBigIntStat;
      expect(sameIdentityExceptNlink(original, invocation.resultIdentity, 0n)).toBe(true);
      expect(original.size).toBeGreaterThan(0n);
      expect(lstatSync(movedDirectory).isDirectory()).toBe(true);
      expect(lstatSync(invocation.directory).isDirectory()).toBe(true);
      expect(() => lstatSync(join(movedDirectory, "result.json"))).toThrow();
      expect(() => lstatSync(join(invocation.directory, "result.json"))).toThrow();
      expect(readFileSync(sentinelPath)).toEqual(sentinelBytes);
    } finally {
      await retireAndCloseFreshRuntime(invocation);
    }
  },
  { timeout: 10_000 },
);

test(
  "PLANTED: fresh runtime proves TERM-resistant inner timeout cleanup",
  async () => {
    const marker = `s3-fresh-term-resistant-${crypto.randomUUID()}`;
    const readyNonce = crypto.randomUUID();
    const fixtureDirectory = makePrivateFixtureDirectory();
    const readyPath = createPrivateFixtureFile(fixtureDirectory, "term-resistant.ready");
    const invocation = await invokeFreshOwnedS3Command(
      [
        "perl",
        "-e",
        `my $marker = ${JSON.stringify(marker)}; my $nonce = ${JSON.stringify(readyNonce)}; my $ready_path = ${JSON.stringify(readyPath)}; $SIG{TERM} = sub {}; $SIG{HUP} = sub {}; open(my $ready, ">", $ready_path) or exit 125; print {$ready} "$nonce $$\\n" or exit 125; close($ready) or exit 125; while (1) { sleep 1; }`,
      ],
      { timeoutMs: 1_000 },
    );
    try {
      // The target must be live with TERM/HUP handlers installed before the
      // owned timeout starts its cleanup proof; a pre-ready timeout is not a
      // causal TERM-resistant cleanup test.
      const targetPid = await waitForExactReadyMarker(readyPath, readyNonce);
      expect(readFileSync(readyPath, "utf8")).toBe(`${readyNonce} ${targetPid}\n`);
      await assertFreshRuntimeExited(invocation, "S3_FRESH_TERM_RESISTANT");
      const freshResult = await readFreshOwnedS3Result(invocation, "S3_FRESH_TERM_RESISTANT");

      expect(freshResult.result.outcome).toBe("timeout");
      expect(freshResult.cleanupProven).toBe(true);
      await waitForExactMarkerAbsence(targetPid, marker);
    } finally {
      await retireAndCloseFreshRuntime(invocation);
    }
  },
  { timeout: 15_000 },
);

test(
  "PLANTED: fresh runtime preserves inner output-overrun cleanup proof",
  async () => {
    const marker = `s3-fresh-output-overrun-${crypto.randomUUID()}`;
    const readyNonce = crypto.randomUUID();
    const fixtureDirectory = makePrivateFixtureDirectory();
    const readyPath = createPrivateFixtureFile(fixtureDirectory, "output-overrun.ready");
    const invocation = await invokeFreshOwnedS3Command(
      [
        "perl",
        "-e",
        `my $marker = ${JSON.stringify(marker)}; my $nonce = ${JSON.stringify(readyNonce)}; my $ready_path = ${JSON.stringify(readyPath)}; $SIG{TERM} = sub {}; $SIG{HUP} = sub {}; open(my $ready, ">", $ready_path) or exit 125; print {$ready} "$nonce $$\\n" or exit 125; close($ready) or exit 125; syswrite(STDOUT, "x" x 129); while (1) { sleep 1; }`,
      ],
      { timeoutMs: 2_000, retainedStreamBytes: 128, retainedOutputBytes: 128 },
    );
    try {
      const targetPid = await waitForExactReadyMarker(readyPath, readyNonce);
      expect(readFileSync(readyPath, "utf8")).toBe(`${readyNonce} ${targetPid}\n`);
      await assertFreshRuntimeExited(invocation, "S3_FRESH_OUTPUT_OVERRUN");
      const freshResult = await readFreshOwnedS3Result(invocation, "S3_FRESH_OUTPUT_OVERRUN");

      expect(freshResult.result.outcome).toBe("output-overrun");
      expect(freshResult.cleanupProven).toBe(true);
      expect(freshResult.result.retainedStdoutBytes).toBe(128);
      await waitForExactMarkerAbsence(targetPid, marker);
    } finally {
      await retireAndCloseFreshRuntime(invocation);
    }
  },
  { timeout: 15_000 },
);

test(
  "PLANTED: outer fresh-runtime deadline retires a live marked target through lease EOF",
  async () => {
    const fixtureDirectory = makePrivateFixtureDirectory();
    const marker = `s3-fresh-outer-deadline-${crypto.randomUUID()}`;
    const readyNonce = crypto.randomUUID();
    const readyPath = createPrivateFixtureFile(fixtureDirectory, "target.ready");
    const descendantStatePath = createPrivateFixtureFile(
      fixtureDirectory,
      "target-descendant.ready",
    );
    const invocation = await invokeFreshOwnedS3Command(
      [
        "perl",
        "-e",
        // The leader publishes only after its durable child has reported the
        // exact same PGID. Both ignore TERM/HUP and remain independently live;
        // no short-lived sleep subprocess can satisfy this readiness record.
        String.raw`use strict; use warnings; use POSIX qw(getpgrp); my ($marker, $nonce, $ready_path, $child_path) = @ARGV; $SIG{TERM} = sub {}; $SIG{HUP} = sub {}; my $leader_pid = $$; my $leader_pgid = getpgrp(); my $child = fork(); exit 125 unless defined $child; if ($child == 0) { $SIG{TERM} = sub {}; $SIG{HUP} = sub {}; my $child_pgid = getpgrp(); open(my $state, ">", $child_path) or exit 126; print {$state} "$nonce $$ $child_pgid\n" or exit 126; close($state) or exit 126; while (1) { select undef, undef, undef, 0.05; } } my $child_record = ""; for (1 .. 200) { if (open(my $state, "<", $child_path)) { local $/; $child_record = <$state> // ""; close($state) or exit 127; last if $child_record =~ /^\Q$nonce\E [1-9][0-9]* [1-9][0-9]*\n$/; } select undef, undef, undef, 0.005; } my ($observed_nonce, $child_pid, $child_pgid) = $child_record =~ /^(\S+) ([1-9][0-9]*) ([1-9][0-9]*)\n$/; exit 127 unless defined $child_pgid && $observed_nonce eq $nonce && $child_pid == $child && $child_pgid == $leader_pgid; open(my $ready, ">", $ready_path) or exit 128; print {$ready} "$nonce $leader_pid $leader_pgid $child_pid $child_pgid\n" or exit 128; close($ready) or exit 128; while (1) { select undef, undef, undef, 0.05; }`,
        marker,
        readyNonce,
        readyPath,
        descendantStatePath,
      ],
      { timeoutMs: 20_000, outerTimeoutMs: S3_OUTER_DEADLINE_PLANT_MS },
    );

    try {
      const group = await waitForExactReadyProcessGroup(readyPath, readyNonce);
      expect(readFileSync(readyPath, "utf8")).toBe(
        `${readyNonce} ${group.leaderPid} ${group.leaderPgid} ${group.descendantPid} ${group.descendantPgid}\n`,
      );
      expect(group.leaderPgid).toBe(group.descendantPgid);
      const settlement = await settleFreshRuntime(invocation);
      expect(settlement).toBe("timed-out");
      expect(invocation.timeoutWon).toBe(true);
      expect(invocation.helperReaped).toBe(true);
      expect(invocation.helperKillRequested).toBe(true);
      expect(invocation.helper.signalCode).toBe("SIGKILL");
      // A second settlement must retain the original timeout winner even if
      // helper.exited has resolved by now; no late status-0 record is parsed.
      expect(await settleFreshRuntime(invocation)).toBe("timed-out");
      await expect(
        assertFreshRuntimeExited(invocation, "S3_FRESH_OUTER_LATE_EXIT"),
      ).rejects.toThrow("S3_FRESH_OUTER_LATE_EXIT_FRESH_RUNTIME_DEADLINE");
      // A timeout wins even if the direct helper reaches status 0 late. No
      // partial outer record is parsed or persisted on this branch. The helper
      // has no stdout authority or startup-control protocol.
      expect(invocation.stdoutCapture.byteLength()).toBe(0);
      await expect(invocation.stdoutCapture.complete).resolves.toEqual(Buffer.alloc(0));
      await expect(invocation.stderrCapture.complete).resolves.toEqual(Buffer.alloc(0));
      const original = fstatSync(invocation.resultFd, { bigint: true }) as ExactBigIntStat;
      expect(sameIdentityExceptNlink(original, invocation.resultIdentity, 0n)).toBe(true);
      expect(original.size).toBe(0n);
      expect(() => lstatSync(invocation.resultPath)).toThrow();
      // One leader-only observation cannot green this plant: the same absolute
      // census deadline must independently prove both published PIDs absent.
      await waitForExactMarkerAbsences([
        { pid: group.leaderPid, marker },
        { pid: group.descendantPid, marker },
      ]);
    } finally {
      await retireAndCloseFreshRuntime(invocation);
    }
  },
  { timeout: 15_000 },
);

test("the S-3 harness binds readiness to its child and excludes the deployed entry graph", async () => {
  const script = readFileSync(resolve(root, "scripts/e2e-s3-split.sh"), "utf8");
  const worker = readFileSync(resolve(root, "apps/wire/src/split/local-worker.ts"), "utf8");
  const checker = readFileSync(resolve(root, "apps/wire/src/split/local-check.ts"), "utf8");
  const productionApp = readFileSync(resolve(root, "apps/wire/src/app.ts"), "utf8");
  const productionIndex = readFileSync(resolve(root, "apps/wire/src/index.ts"), "utf8");
  const wirePackage = JSON.parse(readFileSync(resolve(root, "apps/wire/package.json"), "utf8")) as {
    readonly exports?: { readonly "."?: string };
  };
  const productionConfigs = [
    "infra/wrangler.toml",
    "infra/environments/local.wrangler.toml",
    "infra/environments/staging.wrangler.toml",
    "infra/environments/production.wrangler.toml",
  ].map((path) => readFileSync(resolve(root, path), "utf8"));
  const productionEntrypoint = resolve(root, "apps/wire/src/index.ts");
  const localWorkerEntrypoint = resolve(root, "apps/wire/src/split/local-worker.ts");
  const productionBuildReceipt = await isolatedProductionBundle(
    "production",
    productionEntrypoint,
    localWorkerEntrypoint,
  );
  const counterfactualBuildReceipt = await isolatedProductionBundle(
    "counterfactual",
    productionEntrypoint,
    localWorkerEntrypoint,
  );
  const publicRowInjection =
    "const publicRows = publicRowsForRequest(request, env, events.results);";
  const publicRowGuard = "assertS3PublicEventRows(publicRows);";
  const faultGateSource = sourceRegion(
    worker,
    "function d1FaultRequested(",
    "function publicRowsForRequest(",
  );
  const projectionSource = sourceRegion(
    worker,
    "async function publicProjection(",
    "async function publicFace(",
  );
  const faceSource = sourceRegion(
    worker,
    "async function publicFace(",
    "async function publicSearch(",
  );
  const searchSource = sourceRegion(
    worker,
    "async function publicSearch(",
    "async function publicExport(",
  );
  const exportSource = sourceRegion(
    worker,
    "async function publicExport(",
    "async function publicArtifact(",
  );
  const privateArtifactSource = sourceRegion(
    worker,
    "async function privateArtifact(",
    "async function duplicateClaim(",
  );
  const promoteSource = sourceRegion(
    worker,
    "async function promoteWorkshop(",
    "async function publicProblemExists(",
  );
  const pushSource = sourceRegion(
    worker,
    "async function pushWorkshop(",
    "async function privateArtifact(",
  );
  const fetchSource = worker.slice(worker.indexOf("  async fetch("));
  const exactBindingFailureSource = sourceRegion(
    worker,
    "function localS3BindingFailure()",
    "function notFound()",
  );
  const checkerExactBindingFailureSource = sourceRegion(
    checker,
    "function isExactLocalS3BindingFailure(",
    "async function pushWorkshop(",
  );
  const routePoisonSource = sourceRegion(
    worker,
    "function throwIfRouteBindingPoisoned(",
    "function publicRowsForRequest(",
  );
  const dollar = "$";
  const supervisorPidExpansion = `${dollar}{supervisor_pid}`;
  const pgidExpansion = `${dollar}{pgid}`;
  const stopGroupSource = sourceRegion(script, "stop_group() {", "stop_worker() {");
  const killEscalationSource = stopGroupSource.slice(
    stopGroupSource.indexOf("dispatch_exact_group_kill \\"),
  );
  const groupKillDispatchSource = sourceRegion(
    script,
    "dispatch_exact_group_kill() {",
    "plant_startup_window_signal() {",
  );
  const finishKillDispatchSource = sourceRegion(
    script,
    "finish_kill_dispatch_transition() {",
    "dispatch_exact_direct_supervisor_kill() {",
  );
  const runtimeKillDispatchHandoffSource = finishKillDispatchSource.slice(
    finishKillDispatchSource.indexOf("runtime) install_runtime_signal_traps"),
  );
  const startupTransferCall = "transfer_kill_dispatch_signal_to_startup";
  const firstStartupTransfer = finishKillDispatchSource.indexOf(startupTransferCall);
  const secondStartupTransfer = finishKillDispatchSource.indexOf(
    startupTransferCall,
    firstStartupTransfer + 1,
  );
  const thirdStartupTransfer = finishKillDispatchSource.indexOf(
    startupTransferCall,
    secondStartupTransfer + 1,
  );
  const exitCleanupSource = sourceRegion(
    script,
    "on_exit() {",
    "run_term_resistant_descendant_self_test() {",
  );
  const reapedGroupWaitSource = sourceRegion(
    script,
    "wait_for_reaped_group_empty() {",
    "stop_group() {",
  );
  const checkerResourceSource = sourceRegion(
    script,
    "start_checker_resource_fixture() {",
    "run_checker_timeout_self_test() {",
  );
  const serverResourceSource = sourceRegion(
    script,
    "read_server_resource_port() {",
    "run_provisional_exact_check_self_test() {",
  );
  const ownedListenerRetirementSource = sourceRegion(
    script,
    "assert_owned_server_listener_retired() {",
    "assert_checker_state_holders_empty() {",
  );
  const publicShapePoisonAssertionSource = sourceRegion(
    checker,
    '"post_promotion_public_projection_search_and_export_apply_shape_guards",',
    '  check(\n    "all_fourteen_async_route_entry_faults_return_one_exact_nonreflective_binding_failure",',
  );
  const readinessLoopSource = sourceRegion(script, "ready=0\n", `if [[ \${ready} -ne 1 ]]`);
  const ownedOriginDiscoverySource = sourceRegion(
    script,
    "owned_listener_ports_in_group() {",
    "state_holder_pids() {",
  );
  const healthHandlerSource = sourceRegion(
    worker,
    'if (request.method === "GET" && url.pathname === "/__s3/health") {',
    'if (request.method === "POST" && url.pathname === "/__s3/workshops") {',
  );

  expect(script).toContain("S3_PORT_OCCUPIED");
  expect(script).toMatch(/--var "S3_RUN_TOKEN:\$\{S3_RUN_TOKEN\}"/);
  expect(script).toMatch(/--var "S3_READINESS_NONCE:\$\{S3_READINESS_NONCE\}"/);
  expect(readinessLoopSource).toContain("discover_owned_worker_origin");
  expect(readinessLoopSource).not.toContain("S3_RUN_TOKEN");
  expect(ownedOriginDiscoverySource).toContain("group_members");
  expect(ownedOriginDiscoverySource).toContain("-iTCP@127.0.0.1");
  expect(ownedOriginDiscoverySource).toContain("readiness_nonce");
  expect(ownedOriginDiscoverySource).toContain("S3_READINESS_NONCE");
  const exactHealthComparison = `[[ "${dollar}{health}" == "${dollar}{expected_health}" ]]`;
  expect(ownedOriginDiscoverySource).toContain(exactHealthComparison);
  expect(ownedOriginDiscoverySource).toContain("--noproxy '*'");
  expect(ownedOriginDiscoverySource).toContain("candidate_count <= 32");
  const explicitCandidateFilter = `if (( S3_PORT_EXPLICIT == 1 )) && [[ "${dollar}{candidate}" != "${dollar}{S3_PORT}" ]]`;
  expect(ownedOriginDiscoverySource).toContain(explicitCandidateFilter);
  expect(ownedOriginDiscoverySource.indexOf(explicitCandidateFilter)).toBeLessThan(
    ownedOriginDiscoverySource.indexOf(`"${dollar}{candidate_origin}/__s3/health"`),
  );
  expect(
    ownedOriginDiscoverySource.match(/\[\[ "\$\{health\}" == "\$\{expected_health\}" \]\]/g),
  ).toHaveLength(2);
  const selectedOriginProbe = `candidate_origin="http://127.0.0.1:${dollar}{discovered}"`;
  expect(ownedOriginDiscoverySource).toContain(selectedOriginProbe);
  expect(ownedOriginDiscoverySource.indexOf(selectedOriginProbe)).toBeLessThan(
    ownedOriginDiscoverySource.lastIndexOf(exactHealthComparison),
  );
  expect(ownedOriginDiscoverySource.lastIndexOf(exactHealthComparison)).toBeLessThan(
    ownedOriginDiscoverySource.lastIndexOf("supervisor_identity_is_exact"),
  );
  expect(ownedOriginDiscoverySource).toContain("listener_pids_are_in_group");
  expect(ownedOriginDiscoverySource).toContain("supervisor_identity_is_exact");
  expect(ownedOriginDiscoverySource).toContain("S3_PORT_EXPLICIT");
  expect(ownedOriginDiscoverySource).toContain(`SERVER_RESOURCE_PORT="${dollar}{discovered}"`);
  expect(ownedOriginDiscoverySource).toContain(
    `ORIGIN="http://127.0.0.1:${dollar}{SERVER_RESOURCE_PORT}"`,
  );
  expect(script).not.toContain("allocate_port() {");
  expect(script).toContain("S3_PORT_EXPLICIT=1");
  expect(script).toContain("S3_PORT=0");
  expect(script).toContain("--ip 127.0.0.1");
  expect(script).toContain(`--port "${dollar}{S3_PORT}"`);
  expect(script).toContain(`port_is_busy "${dollar}{S3_PORT}"`);
  expect(script).toContain(`"-iTCP@127.0.0.1:${dollar}{port}" -sTCP:LISTEN`);
  expect(healthHandlerSource).toContain("readiness_nonce: readinessNonce");
  expect(healthHandlerSource).not.toContain("run_token");
  expect(script).toContain("CHECKER_DEADLINE_SECONDS");
  expect(script).toMatch(/S3_LOCAL_RUN_TOKEN="\$\{S3_RUN_TOKEN\}"/);
  expect(script).toContain("S3_SELF_TEST_TERM_RESISTANT_CHILD");
  expect(script).toContain("S3_SELF_TEST_IDENTITY_MISMATCH");
  expect(script).toContain("S3_SELF_TEST_SECOND_SIGNAL_DURING_CLEANUP");
  expect(script).toContain("S3_SELF_TEST_POST_REAP_INSPECTION_FAILURE");
  expect(script).toContain("S3_SELF_TEST_POST_KILL_REAP_UNCERTAINTY");
  expect(script).toContain("S3_SELF_TEST_KILL_DISPATCH_SIGNAL_OWNER");
  expect(script).toContain("S3_SELF_TEST_PROVISIONAL_EXACT_FAILURE");
  expect(script).toContain("S3_SELF_TEST_STARTUP_SIGNAL_WINDOW");
  expect(script).toContain("S3_SELF_TEST_CHECKER_TIMEOUT");
  expect(script).toContain("S3_SELF_TEST_CHECKER_CONTAINMENT_FAILURE");
  expect(script).toContain("S3_SELF_TEST_PID_REUSE");
  expect(script).toContain("s3-pinned-supervisor:");
  // 7pfg.10: the identity anchor still observes lstart through ps, but the
  // fields arrive as one atomic snapshot (pid=,pgid=,lstart=,command=) rather
  // than four staggered spawns, so the pin is the field, not the old flag
  // layout.
  expect(script).toContain("lstart=");
  expect(script).toContain("supervisor_identity_is_exact");
  expect(script).toContain("listener_pids_are_in_group");
  expect(script).toContain("assert_no_survivors");
  expect(script).toContain("signal_exact_group KILL");
  expect(killEscalationSource).toContain("dispatch_exact_group_kill \\");
  expect(groupKillDispatchSource).toContain("signal_exact_group KILL");
  expect(groupKillDispatchSource).toContain("plant_kill_dispatch_window_signal");
  expect(groupKillDispatchSource).toContain("SERVER_SUPERVISOR_KILL_DISPATCHED=1");
  expect(groupKillDispatchSource).toContain("CHECKER_SUPERVISOR_KILL_DISPATCHED=1");
  expect(groupKillDispatchSource).toContain("finish_kill_dispatch_transition");
  expect(
    killEscalationSource.indexOf(`wait_for_killed_direct_child_reap "${supervisorPidExpansion}"`),
  ).toBeGreaterThanOrEqual(0);
  expect(
    killEscalationSource.indexOf(`wait_for_killed_direct_child_reap "${supervisorPidExpansion}"`),
  ).toBeLessThan(killEscalationSource.indexOf(`wait_for_reaped_group_empty "${pgidExpansion}"`));
  expect(groupKillDispatchSource.indexOf("signal_exact_group KILL")).toBeLessThan(
    groupKillDispatchSource.indexOf("plant_kill_dispatch_window_signal"),
  );
  expect(groupKillDispatchSource.indexOf("plant_kill_dispatch_window_signal")).toBeLessThan(
    groupKillDispatchSource.indexOf("SERVER_SUPERVISOR_KILL_DISPATCHED=1"),
  );
  expect(groupKillDispatchSource.indexOf("CHECKER_SUPERVISOR_KILL_DISPATCHED=1")).toBeLessThan(
    groupKillDispatchSource.indexOf("finish_kill_dispatch_transition"),
  );
  expect(firstStartupTransfer).toBeGreaterThanOrEqual(0);
  expect(secondStartupTransfer).toBeGreaterThan(firstStartupTransfer);
  expect(thirdStartupTransfer).toBeGreaterThan(secondStartupTransfer);
  expect(finishKillDispatchSource).toContain("STARTUP_SIGNAL_HANDOFF_ACTIVE=1");
  expect(finishKillDispatchSource).toContain("STARTUP_SIGNAL_HANDOFF_ACTIVE=0");
  expect(finishKillDispatchSource).toContain("install_startup_signal_traps");
  expect(firstStartupTransfer).toBeLessThan(
    finishKillDispatchSource.indexOf("STARTUP_SIGNAL_HANDOFF_ACTIVE=1"),
  );
  expect(finishKillDispatchSource.indexOf("STARTUP_SIGNAL_HANDOFF_ACTIVE=1")).toBeLessThan(
    finishKillDispatchSource.indexOf("install_startup_signal_traps"),
  );
  expect(finishKillDispatchSource.indexOf("install_startup_signal_traps")).toBeLessThan(
    secondStartupTransfer,
  );
  expect(secondStartupTransfer).toBeLessThan(
    finishKillDispatchSource.indexOf("STARTUP_SIGNAL_HANDOFF_ACTIVE=0"),
  );
  expect(finishKillDispatchSource.indexOf("STARTUP_SIGNAL_HANDOFF_ACTIVE=0")).toBeLessThan(
    thirdStartupTransfer,
  );
  expect(thirdStartupTransfer).toBeLessThan(
    finishKillDispatchSource.indexOf("KILL_DISPATCH_SIGNAL_STATUS=0"),
  );
  expect(runtimeKillDispatchHandoffSource).toContain("runtime) install_runtime_signal_traps");
  expect(runtimeKillDispatchHandoffSource).toContain(
    `remembered_status="${dollar}{KILL_DISPATCH_SIGNAL_STATUS}"`,
  );
  expect(runtimeKillDispatchHandoffSource).toContain(
    `kill -"${dollar}{remembered_name}" "${dollar}{BASHPID:-${dollar}${dollar}}"`,
  );
  expect(runtimeKillDispatchHandoffSource).toContain("KILL_DISPATCH_SIGNAL_STATUS=0");
  expect(
    runtimeKillDispatchHandoffSource.indexOf(
      `remembered_status="${dollar}{KILL_DISPATCH_SIGNAL_STATUS}"`,
    ),
  ).toBeLessThan(
    runtimeKillDispatchHandoffSource.indexOf(
      `kill -"${dollar}{remembered_name}" "${dollar}{BASHPID:-${dollar}${dollar}}"`,
    ),
  );
  expect(
    runtimeKillDispatchHandoffSource.indexOf(
      `kill -"${dollar}{remembered_name}" "${dollar}{BASHPID:-${dollar}${dollar}}"`,
    ),
  ).toBeLessThan(runtimeKillDispatchHandoffSource.indexOf("KILL_DISPATCH_SIGNAL_STATUS=0"));
  expect(exitCleanupSource).toContain(`original_status="${dollar}{KILL_DISPATCH_SIGNAL_STATUS}"`);
  expect(exitCleanupSource).toContain("trap '' HUP INT TERM");
  expect(exitCleanupSource).toContain("KILL_DISPATCH_SIGNAL_STATUS=0");
  expect(exitCleanupSource).toContain("cleanup_with_retry");
  expect(
    exitCleanupSource.indexOf(`original_status="${dollar}{KILL_DISPATCH_SIGNAL_STATUS}"`),
  ).toBeLessThan(exitCleanupSource.indexOf("KILL_DISPATCH_SIGNAL_STATUS=0"));
  expect(exitCleanupSource.indexOf("trap '' HUP INT TERM")).toBeLessThan(
    exitCleanupSource.indexOf("KILL_DISPATCH_SIGNAL_STATUS=0"),
  );
  expect(exitCleanupSource.indexOf("KILL_DISPATCH_SIGNAL_STATUS=0")).toBeLessThan(
    exitCleanupSource.indexOf("cleanup_with_retry"),
  );
  expect(reapedGroupWaitSource).toContain(`inspect_reaped_group_members "${pgidExpansion}"`);
  expect(reapedGroupWaitSource).not.toContain("signal_exact");
  expect(reapedGroupWaitSource).not.toMatch(/\bkill\s+-/u);
  expect(stopGroupSource.indexOf("if (( supervisor_reaped == 1 )); then")).toBeLessThan(
    stopGroupSource.indexOf(`signal_exact_group TERM "${supervisorPidExpansion}"`),
  );
  expect(script).toContain("trap '' HUP INT TERM");
  expect(script).toContain("cleanup_with_retry");
  expect(script).toContain("signal_exact_direct_supervisor");
  expect(script).toContain("signal_exact_group_supervisor");
  expect(script).toContain("start_supervised_payload checker");
  expect(script).toContain("S3_NO_WORKER_PORT_PRESTART=1");
  expect(checkerResourceSource).toContain("port: 0,");
  expect(checkerResourceSource).toContain("S3_CHECKER_FIXTURE_PORT_FILE");
  expect(checkerResourceSource).toContain("read_checker_resource_port");
  expect(checkerResourceSource).not.toContain("allocate_port");
  expect(checkerResourceSource).not.toContain("port_is_busy");
  expect(serverResourceSource).toContain("port: 0");
  expect(serverResourceSource).toContain("SERVER_RESOURCE_PORT_FILE");
  expect(serverResourceSource).toContain("read_server_resource_port");
  expect(serverResourceSource).toContain("listener_pids_are_in_group");
  expect(serverResourceSource).not.toContain("allocate_port");
  expect(serverResourceSource).not.toContain("port_is_busy");
  expect(ownedListenerRetirementSource).toContain("SERVER_LISTENER_OWNERSHIP_OBSERVED");
  expect(ownedListenerRetirementSource).toContain("CHECKER_LISTENER_OWNERSHIP_OBSERVED");
  expect(ownedListenerRetirementSource).toContain("assert_group_empty");
  expect(ownedListenerRetirementSource).not.toContain("listener_pids");
  expect(ownedListenerRetirementSource).not.toContain("port_accepts_bind");
  expect(script).toContain("LOCAL_SPLIT_CHECKER_CONTAINMENT_FAILED");
  const containmentDispatch =
    "if (( checker_containment_mode == 1 )); then\n  run_checker_containment_self_test;";
  const productionWorkerDispatch = `start_supervised_payload server "${dollar}{SERVER_LOG}" "${dollar}{WRANGLER}" dev "${dollar}{ENTRYPOINT}"`;
  const productionLifecycleSource = script.slice(script.indexOf(productionWorkerDispatch));
  expect(script.indexOf(containmentDispatch)).toBeGreaterThanOrEqual(0);
  expect(script.indexOf(containmentDispatch)).toBeLessThan(
    script.indexOf(productionWorkerDispatch),
  );
  expect(productionLifecycleSource.indexOf("discover_owned_worker_origin")).toBeGreaterThan(0);
  expect(productionLifecycleSource.indexOf("discover_owned_worker_origin")).toBeLessThan(
    productionLifecycleSource.indexOf("run_owned_checker"),
  );
  expect(script).toContain("checker_exit_diagnostics");
  expect(script).toContain("checker_exit_status");
  expect(script).toContain("S3_SELF_TEST_CHECKER_EXIT_1");
  expect(script).toContain("S3_SELF_TEST_DISPATCH_STARTUP_SIGNAL");
  expect(script).toContain("is_retained_signal_status");
  expect(script).toContain("emit_checked_checker_jsonl");
  expect(script).not.toMatch(/cat "\$\{CHECK_LOG\}"/);
  expect(script).not.toMatch(/kill -TERM .*CHECKER_PID/);
  expect(worker).toContain("const authority = env.S3_RUN_TOKEN");
  expect(worker).toContain("request.headers.get(header) === env.S3_RUN_TOKEN");
  expect(worker).toContain("only `__s3` test routes plus the artifact host shape are mounted");
  expect(occurrences(worker, publicRowGuard)).toBe(3);
  for (const routeSource of [projectionSource, searchSource, exportSource]) {
    expect(occurrences(routeSource, publicRowInjection)).toBe(1);
    expect(occurrences(routeSource, publicRowGuard)).toBe(1);
    expect(routeSource.indexOf(publicRowInjection)).toBeLessThan(
      routeSource.indexOf(publicRowGuard),
    );
  }
  expect(occurrences(projectionSource, "assertS3PublicProjectionShape(projection);")).toBe(1);
  expect(occurrences(faceSource, "assertS3RenderedFaceShape(face, format);")).toBe(1);
  expect(worker).toContain("FROM s3_local_public_cursors");
  expect(worker).toContain('const LOCAL_SPONSOR_ID = "local-sponsor-fixture";');
  expect(worker).toContain(
    'const ANONYMOUS_PRIVATE_LOOKUP_SPONSOR_ID = "_anonymous-private-lookup";',
  );
  expect(worker).not.toContain("function localSponsorId(");
  expect(privateArtifactSource).toContain(
    "? localWorkshopSponsorId(request, env)\n    : ANONYMOUS_PRIVATE_LOOKUP_SPONSOR_ID",
  );
  expect(occurrences(privateArtifactSource, "env.DB.prepare(")).toBe(1);
  expect(privateArtifactSource).toContain("JOIN s3_local_sessions AS session");
  expect(privateArtifactSource).toContain(
    "ON session.id = workshop.session_id AND session.sponsor_id = workshop.sponsor_id",
  );
  expect(privateArtifactSource).toContain("WHERE workshop.id = ?1 AND workshop.sponsor_id = ?2");
  expect(privateArtifactSource).toContain(".bind(workshopId, sponsorId)");
  expect(privateArtifactSource).not.toContain("session_id = ?3");
  expect(privateArtifactSource).not.toContain("LOCAL_SESSION_ID");
  expect(privateArtifactSource.indexOf("if (workshop === null) return notFound();")).toBeLessThan(
    privateArtifactSource.indexOf("await env.ARTIFACTS.get(workshop.body_key)"),
  );
  const promoteOwnershipGate =
    "if (workshop.fellow_id !== fellowId || workshop.sponsor_id !== sponsorId) return notFound();";
  expect(promoteSource).toContain("const fellowId = localWorkshopFellowId(request, env);");
  expect(promoteSource).toContain("const sponsorId = localWorkshopSponsorId(request, env);");
  expect(promoteSource).toContain(promoteOwnershipGate);
  const promoteOwnershipGateIndex = promoteSource.indexOf(promoteOwnershipGate);
  expect(promoteOwnershipGateIndex).toBeGreaterThan(
    promoteSource.indexOf("if (workshop === null) return notFound();"),
  );
  for (const downstreamStep of [
    "const requestDigest = await localScreeningRequestDigest(workshop, currentPromotion);",
    "await replayedScreeningDecision(",
    "const duplicate = await duplicateClaim(env, workshop.problem_id, statementDigest);",
    "await env.ARTIFACTS.put(publicObjectKey, publicArtifactMd, {",
    "const results = await env.DB.batch(statements);",
  ]) {
    expect(promoteOwnershipGateIndex).toBeLessThan(promoteSource.indexOf(downstreamStep));
  }
  const pushSessionOwnershipGate =
    'if (session === null) return json({ code: "LOCAL_SESSION_REQUIRED" }, 400);';
  expect(pushSource).toContain(pushSessionOwnershipGate);
  const pushSessionOwnershipGateIndex = pushSource.indexOf(pushSessionOwnershipGate);
  expect(pushSessionOwnershipGateIndex).toBeGreaterThan(
    pushSource.indexOf("const session = await env.DB.prepare("),
  );
  for (const downstreamStep of [
    "const digest = await sha256Hex(bodyMd);",
    "const bodyKey = stagedPrivateKey(digest);",
    "await env.ARTIFACTS.put(bodyKey, bodyMd, {",
    "const results = await env.DB.batch(statements);",
  ]) {
    expect(pushSessionOwnershipGateIndex).toBeLessThan(pushSource.indexOf(downstreamStep));
  }
  expect(faultGateSource).toContain(
    "request.headers.get(TEST_D1_BIND_FAULT_HEADER) === TEST_D1_BIND_FAULT",
  );
  expect(faultGateSource).toContain(
    "hasLocalHarnessAuthority(request, env, TEST_D1_BIND_FAULT_AUTHORITY_HEADER)",
  );
  expect(worker).toContain("hasLocalHarnessAuthority(request, env, TEST_PUBLIC_ROW_POISON_HEADER)");
  expect(worker).toContain("TEST_ROUTE_BINDING_POISON_HEADER");
  expect(routePoisonSource).toContain(
    "hasLocalHarnessAuthority(request, env, TEST_ROUTE_BINDING_POISON_HEADER)",
  );
  expect(exactBindingFailureSource).toContain(
    'JSON.stringify({ code: "LOCAL_S3_BINDING_FAILURE" })',
  );
  expect(exactBindingFailureSource).toContain("status: 500");
  expect(exactBindingFailureSource).toContain(
    'headers: { "content-type": "application/json; charset=utf-8" }',
  );
  expect(exactBindingFailureSource).not.toContain("cache-control");
  expect(exactBindingFailureSource).not.toContain("x-content-type-options");
  expect(fetchSource).toContain("return localS3BindingFailure();");
  // Mutation guard: replacing exact poison verification with a bare status
  // check, body, or header check must fail before runtime coverage is reached.
  // The direct S-3 command exercises every route against the same contract.
  expect(checkerExactBindingFailureSource).toContain("output.response.status === 500");
  expect(checkerExactBindingFailureSource).toContain(
    'output.body === \'{"code":"LOCAL_S3_BINDING_FAILURE"}\'',
  );
  expect(checkerExactBindingFailureSource).toContain("applicationHeaders.length === 1");
  expect(checkerExactBindingFailureSource).toContain(
    'applicationHeaders[0]?.[0] === "content-type"',
  );
  expect(checkerExactBindingFailureSource).toContain(
    'applicationHeaders[0]?.[1] === "application/json; charset=utf-8"',
  );
  expect(publicShapePoisonAssertionSource).toContain(
    "poisonedPublic.every(\n        (response) =>\n          isExactLocalS3BindingFailure(response) &&",
  );
  expect(publicShapePoisonAssertionSource).not.toContain(
    "response.response.status === 500 &&\n          hasNoPrivateMaterial(response",
  );
  expect(checker).toContain("poisonProbeSnapshots({})");
  expect(checker).toContain("const poisonedProbeForbidden = [");
  expect(checker).toContain("poisonedPrivateLocator,\n    localAuthorityToken");
  expect(publicShapePoisonAssertionSource).toContain(
    "response.response.status === unpoisonedPublic[index]?.response.status",
  );
  expect(publicShapePoisonAssertionSource).toContain(
    "response.body === unpoisonedPublic[index]?.body",
  );
  expect(publicShapePoisonAssertionSource).toContain(
    "response.headers === unpoisonedPublic[index]?.headers",
  );
  expect(publicShapePoisonAssertionSource).toContain(
    "hasNoPrivateMaterial(response, poisonedProbeForbidden)",
  );
  expect(checker).toContain("readinessNonceRouteBindingPoisonHeaders");
  expect(checker).toContain("nonemptyRouteBindingPoisonHeaders");
  expect(checker).toContain(
    "readiness_nonce_or_nonempty_route_binding_poison_headers_are_byte_for_byte_inert_on_every_async_route",
  );
  expect(checker).toContain("routeBindingPoisonSnapshots({})");
  const routeBindingProbesSource = sourceRegion(
    checker,
    "  const routeBindingProbes: readonly RouteBindingProbe[] = [",
    "  /** Derived from the fields the runner actually executes, never from a label alone. */",
  );
  const expectedRouteBindingProbeSignaturesSource = sourceRegion(
    checker,
    "  const EXPECTED_ROUTE_BINDING_PROBE_SIGNATURES: readonly string[] = [",
    "  const routeBindingSignatures = routeBindingProbes.map(routeBindingProbeSignature);",
  );
  const routeBindingRosterCheckSource = sourceRegion(
    checker,
    '  check(\n    "async_route_poison_roster_is_the_exact_ordered_unique_descriptor_signature_list",',
    '  check(\n    "poisoned_results_are_produced_from_that_roster_one_result_per_descriptor",',
  );
  // The poison sweep's coverage is a claim about issued requests, so its
  // declaration regions are pinned separately from later executable uses of
  // the same labels. A duplicate, missing, relabeled, or extra descriptor or
  // expected signature fails here before route behaviour can mask it.
  const routeBindingProbeIds = [
    "sessions.open",
    "sessions.working-pack",
    "workshops.push",
    "promote",
    "private.artifact",
    "recovery.audit",
    "public.artifact",
    "public.search",
    "public.screening-actions",
    "s4.diagnostics",
    "s4.fixtures.oversized-history",
    "s4.fixtures.forged-receipt",
    "public.export",
    "public.face",
  ] as const;
  expect(occurrences(routeBindingProbesSource, "id: ")).toBe(routeBindingProbeIds.length);
  expect(occurrences(expectedRouteBindingProbeSignaturesSource, "\n    `")).toBe(
    routeBindingProbeIds.length,
  );
  for (const probeId of routeBindingProbeIds) {
    expect(occurrences(routeBindingProbesSource, `id: "${probeId}"`)).toBe(1);
    // Anchored on the backtick that opens an expected-signature literal, so
    // later signature use sites cannot make this declaration check stale.
    expect(occurrences(expectedRouteBindingProbeSignaturesSource, `\`${probeId} `)).toBe(1);
  }
  expect(routeBindingRosterCheckSource).toContain(
    "routeBindingSignatures.length === EXPECTED_ROUTE_BINDING_PROBE_SIGNATURES.length",
  );
  expect(routeBindingRosterCheckSource).toContain("routeBindingSignatures.every(");
  expect(routeBindingRosterCheckSource).toContain(
    "signature === EXPECTED_ROUTE_BINDING_PROBE_SIGNATURES[index]",
  );
  expect(routeBindingRosterCheckSource).toContain(
    "new Set(routeBindingSignatures).size === routeBindingSignatures.length",
  );
  expect(routeBindingRosterCheckSource).toContain(
    "new Set(routeBindingProbes.map((probe) => probe.id)).size === routeBindingProbes.length",
  );
  expect(routeBindingRosterCheckSource).toContain(
    "new Set(routeBindingProbes.map((probe) => probe.path)).size === routeBindingProbes.length",
  );
  // The executed path and method of the twelfth route, pinned literally: a
  // descriptor that keeps the id but points somewhere else fails here, and the
  // runtime signature assertion fails in the same direction.
  expect(checker).toContain('id: "s4.fixtures.forged-receipt",');
  // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting on checker source text that literally contains this template.
  expect(checker).toContain("path: `${origin}/__s3/s4/fixtures/forged-receipt/${mainProblemId}`,");
  expect(
    occurrences(
      checker,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: same — this is the checker's literal source, not an interpolation.
      "`s4.fixtures.forged-receipt POST ${origin}/__s3/s4/fixtures/forged-receipt/${mainProblemId} {}`",
    ),
  ).toBe(1);
  // The complete S-3 sequence must be pinned as source structure, not merely
  // present. Each stage is asserted once, in order, so deleting a stage or
  // reordering the walk fails here rather than silently shortening the sequence
  // the bead exists to prove.
  const s3SequenceStages = [
    '"S3_sequence_1_session_open_allocates_a_server_owned_id_and_reports_both_cursors"',
    '"S3_sequence_1b_caller_cannot_choose_a_session_identifier"',
    '"S3_sequence_2_working_pack_is_authenticated_and_carries_no_private_material"',
    '"S3_sequence_3a_a_push_requires_a_session_this_fellow_opened_on_this_problem"',
    '"S3_sequence_3b_workshop_push_moves_only_the_workshop_cursor_and_stays_invisible_publicly"',
    '"S3_sequence_3c_known_workshop_promotion_requires_owning_fellow_and_sponsor_without_candidate_or_public_side_effects"',
    '"S3_sequence_4_promotion_moves_the_public_cursor_exactly_once_and_the_public_delta_appears"',
  ];
  let previousStageIndex = -1;
  for (const stage of s3SequenceStages) {
    expect(occurrences(checker, stage)).toBe(1);
    const stageIndex = checker.indexOf(stage);
    expect(stageIndex).toBeGreaterThan(previousStageIndex);
    previousStageIndex = stageIndex;
  }
  // PLANTED OMISSION: every sequence record must carry the evidence fields.
  // Dropping the cursor pair, the identifiers, or the timing from any stage
  // removes one of these and fails.
  for (const evidenceField of [
    "principal: localSequenceFellowId,",
    "counter_principal: localCounterFellowId,",
    "problem_id: sequenceProblemId,",
    "session_id: sequenceSessionId,",
    "workshop_id: sequenceWorkshopId,",
    "event_id: sequenceEventId,",
    "counter_session_id: counterSessionId,",
    "route: ",
    "public_seq_before: ",
    "public_seq_after: ",
    "workshop_seq_before: ",
    "workshop_seq_after: ",
    "counter_own_workshop_count_before: ",
    "counter_own_workshop_count_after: ",
    "counter_workshop_seq_before: ",
    "counter_workshop_seq_after: ",
    "cache_search_export: ",
    "duration_ms: ",
  ]) {
    expect(checker.includes(evidenceField)).toBe(true);
  }
  // PLANTED SWAPPED IDENTITY: the counter-principal must be a genuinely
  // different synthetic Fellow, and the pack/push refusals must be checked
  // against it. If the two ids were ever made equal, the cross-principal
  // assertions would pass vacuously.
  expect(checker).toContain('const localSequenceFellowId = "s3-sequence-fellow"');
  expect(checker).toContain('const localCounterFellowId = "s3-sequence-counter-fellow"');
  expect(checker).toContain("localS4FellowIdHeader]: localCounterFellowId,");
  expect(checker).toContain("counterFellowHeaders");
  expect(checker).toContain("crossSponsorFellowHeaders");
  expect(checker).toContain("crossFellowPromotion.response.status === 404");
  expect(checker).toContain("crossSponsorPromotion.response.status === 404");
  expect(checker).toContain("deniedCandidatePublicRead.response.status === 404");
  expect(checker).toContain("publicAfterCrossPrincipalRefusals.response.status === 404");
  // Fable §17.1 names this stage as the `working` pack. A generic pack that
  // merely happens to carry omitted[] is not the named gate.
  expect(checker).toContain('recordField(ownPack.body, "profile") === "working"');
  expect(worker).toContain('profile: "working",');
  // The shell must re-publish evidence rather than strip it back to four fields.
  expect(script).toContain("const STRING_EVIDENCE = [");
  expect(script).toContain("const INTEGER_EVIDENCE = [");
  expect(script).toContain("SAFE_EVIDENCE_STRING");
  expect(script).toContain("published[key] = value;");
  for (const republishedCounterEvidence of [
    '"counter_session_id",',
    '"counter_own_workshop_count_before",',
    '"counter_own_workshop_count_after",',
    '"counter_workshop_seq_before",',
    '"counter_workshop_seq_after",',
    '"public-digest-404-before-after",',
  ]) {
    expect(script).toContain(republishedCounterEvidence);
  }
  expect(checker).toContain("const routeBindingSignatures = routeBindingProbes.map(");
  expect(checker).toContain("new Set(routeBindingProbes.map((probe) => probe.path)).size");
  // The roster guards above constrain descriptors only. They stay green if the
  // runner ignores them — hard-coding one request for all twelve descriptors
  // leaves signatures exact, poison universally 500, baselines inert, and the
  // gate-order pairs intact. So the consumption itself is pinned here: the
  // signature must be built from id/method/path/jsonBody, the runner must issue
  // path/method/jsonBody, and the sweep must map the roster through that runner.
  // Assertions are ordered within one compact region, so a mutation that drops
  // or reorders a consumption breaks this guard rather than sliding past it.
  const routeBindingRunnerSource = sourceRegion(
    checker,
    "  /** Derived from the fields the runner actually executes, never from a label alone. */",
    "  const [unpoisonedPublic,",
  );
  const routeBindingConsumptions = [
    // signature consumes all four descriptor fields
    // biome-ignore lint/suspicious/noTemplateCurlyInString: checker source text, not an interpolation.
    '`${probe.id} ${probe.method} ${probe.path}${probe.jsonBody === undefined ? "" : ` ${probe.jsonBody}`}`',
    // runner consumes path, then method, then jsonBody twice (headers and body)
    "await localFetch(probe.path, {",
    "method: probe.method,",
    "probe.jsonBody === undefined\n            ? headers",
    "...(probe.jsonBody === undefined ? {} : { body: probe.jsonBody }),",
    // the sweep executes the roster through that runner
    "routeBindingProbes.map((probe) => runRouteBindingProbe(probe, headers))",
  ];
  let previousConsumptionIndex = -1;
  for (const consumption of routeBindingConsumptions) {
    expect(occurrences(routeBindingRunnerSource, consumption)).toBe(1);
    const consumptionIndex = routeBindingRunnerSource.indexOf(consumption);
    expect(consumptionIndex).toBeGreaterThan(previousConsumptionIndex);
    previousConsumptionIndex = consumptionIndex;
  }
  // Gate order needs both pairs: the unauthorized/valid-body pair only outranks
  // the authority check, so the authorized/malformed-body pair must exist too.
  expect(checker).toContain('body: "{ not-json",');
  expect(checker).toContain('s4FixtureHeaders("IK-forged-gate-order")');
  expect(checker).toContain(
    's4FixtureHeaders("IK-forged-gate-order-poisoned", routeBindingPoisonHeaders)',
  );
  expect(checker).toContain(
    'authorizedMalformedBody.body.includes("LOCAL_S4_FORGED_PLANT_MALFORMED")',
  );
  expect(checker).toContain("response.body === routeBindingBaseline[index]?.body");
  expect(checker).toContain("response.headers === routeBindingBaseline[index]?.headers");
  for (const dispatch of [
    "return await pushWorkshop(request, env);",
    "return await promoteWorkshop(request, env);",
    "return await privateArtifact(request, env, privateMatch[1]);",
    "return await recoveryAudit(request, env, recoveryMatch[1]);",
    "return await publicArtifact(request, env, artifactMatch[1]);",
    "return await publicSearch(request, env, searchMatch[1]);",
    "return await publicScreeningActions(request, env, screeningActionsMatch[1]);",
    "return await localS4Diagnostics(request, env, s4DiagnosticsMatch[1]);",
    "return await seedOversizedS4History(request, env, oversizedHistorySeedMatch[1]);",
    "return await plantForgedLocalS4Receipt(request, env, forgedReceiptPlantMatch[1]);",
    "return await publicExport(request, env, exportMatch[1]);",
    "return await publicFace(request, env, publicMatch[1]);",
    "return await openLocalSession(request, env);",
    "return await localWorkingPack(request, env, workingPackMatch[1]);",
  ]) {
    expect(occurrences(fetchSource, dispatch)).toBe(1);
  }
  expect(occurrences(fetchSource, "return await ")).toBe(14);
  expect(worker).toContain("token-gated\n      // NOT_FOUND existence behavior");
  expect(worker).not.toContain('LOCAL_SPONSOR_ID = "local-sponsor"');
  expect(worker).not.toContain('RECOVERY_AUDIT_HEADER = "local-recovery-audit"');
  expect(productionApp).not.toContain("split/local-worker");
  expect(productionIndex).toContain('import { createApp } from "./app"');
  expect(productionIndex).not.toContain("split/local-worker");
  expect(wirePackage.exports?.["."]).toBe("./src/index.ts");
  expect(productionConfigs.every((config) => config.includes("apps/wire/src/index.ts"))).toBe(true);
  expect(productionBuildReceipt.mode).toBe("production");
  expect(productionBuildReceipt.output_count).toBeGreaterThan(0);
  expect(productionBuildReceipt.output_bytes).toBeGreaterThan(0);
  expect(productionBuildReceipt.matched_local_worker_sentinels).toEqual([]);
  expect(counterfactualBuildReceipt.mode).toBe("counterfactual");
  expect(counterfactualBuildReceipt.output_count).toBeGreaterThan(0);
  expect(counterfactualBuildReceipt.output_bytes).toBeGreaterThan(0);
  expect(counterfactualBuildReceipt.matched_local_worker_sentinels).toEqual(
    LOCAL_WORKER_BUNDLE_SENTINELS,
  );
  expect(checker).toContain("S3_LOCAL_ORIGIN_MUST_BE_LOOPBACK");
  expect(checker).toContain("S3_LOCAL_RUN_TOKEN_REQUIRED");
  expect(checker).toContain("AbortSignal.timeout(FETCH_TIMEOUT_MS)");
});

test("local public guards normalize private locator keys and allow renderer body only by exact shape", () => {
  for (const key of [
    "sponsor-id",
    "Sponsor Id",
    "Ｓｐｏｎｓｏｒ　Ｉｄ",
    "body_key",
    "Body Digest",
    "Ｏｂｊｅｃｔ－Ｋｅｙ",
    "fellow_id",
    "Session Id",
    "source-workshop-id",
  ]) {
    expect(() => assertS3PublicValueSafe({ [key]: "private locator canary" })).toThrow(
      "S3_LOCAL_PUBLIC_SHAPE_INVALID",
    );
  }

  const projection = {
    schema: "asimposium.pack.v1",
    kind: "ledger",
    problem: "P-public",
    profile: "public",
    cursor: 1,
    title: "Public ledger",
    preamble: "Untrusted data follows.",
    items: [
      {
        kind: "claim",
        id: "EV-1",
        scope: "ledger",
        untrusted: true,
        body: "Legitimate public renderer body.",
        why_included: "public event 1",
      },
    ],
    omitted: [
      { reason: "workshop_scope_excluded", detail: "private workshop bodies are not public" },
    ],
    next_actions: [{ method: "GET", url: "/v1/hello", why: "public orientation" }],
    degraded: [],
  };
  expect(() => assertS3PublicProjectionShape(projection)).not.toThrow();
  expect(() =>
    assertS3PublicProjectionShape({ ...projection, annotation: "not allowlisted" }),
  ).toThrow("S3_LOCAL_PUBLIC_SHAPE_INVALID");
  expect(() =>
    assertS3RenderedFaceShape(
      {
        format: "md",
        media_type: "text/markdown; charset=utf-8",
        body: "body",
        fingerprint: "fingerprint",
        bytes: 4,
        neutralized: [],
      },
      "md",
    ),
  ).not.toThrow();
  expect(() =>
    assertS3RenderedFaceShape(
      {
        format: "md",
        media_type: "text/markdown; charset=utf-8",
        body: "body",
        fingerprint: "fingerprint",
        bytes: 4,
        neutralized: [],
        sponsor_id: "private locator canary",
      },
      "md",
    ),
  ).toThrow("S3_LOCAL_PUBLIC_SHAPE_INVALID");
});

test("local P11 normalization matches the shared inline-math contract and preserves whitespace collapse", () => {
  const rawControl = normalizeS3ClaimStatement("The relation \u0002x + y\u0003 is recorded.");
  const explicitMath = normalizeS3ClaimStatement("The relation \\(x + y\\) is recorded.");
  const inlineMath = normalizeS3ClaimStatement("The relation $x + y$ is recorded.");

  expect(rawControl).not.toBe(explicitMath);
  expect(rawControl).toContain("~c02;");
  expect(rawControl).toContain("~c03;");
  expect(inlineMath).toBe(explicitMath);
  expect(normalizeS3ClaimStatement("Costs $5. The bound $x + y$ holds.")).toBe(
    normalizeS3ClaimStatement("Costs $5. The bound \\(x + y\\) holds."),
  );
  expect(normalizeS3ClaimStatement("line one\nline two\tline three")).toBe(
    normalizeS3ClaimStatement("line one line two line three"),
  );
});

test(
  "PLANTED: an occupied pinned port is refused before foreign readiness can be borrowed",
  async () => {
    const listener = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response('{"status":"ok"}\n'),
    });
    try {
      const result = await runS3HarnessPlant(
        "S3_PORT",
        String(listener.port),
        "S3_PORT_OCCUPIED_PLANT",
        10_000,
      );
      expectBoundedS3ChildExit(result, "S3_PORT_OCCUPIED_PLANT", 1);
      const { stdout, stderr } = result;
      expect(stdout).toContain('"code":"S3_PORT_OCCUPIED"');
      expect(`${stdout}\n${stderr}`).not.toContain('"status":"pass"');
    } finally {
      listener.stop(true);
    }
  },
  { timeout: 10_000 },
);

test(
  "PLANTED: a failed provisional exact check sends no signal and retains ownership for retry",
  async () => {
    const result = await runS3HarnessPlant(
      "S3_SELF_TEST_PROVISIONAL_EXACT_FAILURE",
      "1",
      "S3_PROVISIONAL_EXACT_PLANT",
      15_000,
    );
    expectBoundedS3ChildExit(result, "S3_PROVISIONAL_EXACT_PLANT", 0);
    const { stdout, stderr } = result;
    expect(stdout).toContain(
      '"assertion":"provisional_exact_check_failure_sent_no_signal_retained_ownership_and_retried"',
    );
    expect(`${stdout}\n${stderr}`).not.toContain('"status":"fail"');
  },
  { timeout: 15_000 },
);

test(
  "PLANTED: a live recursive lsof holder can vanish only between broad and exact recheck",
  async () => {
    const result = await runS3HarnessPlant(
      "S3_SELF_TEST_STATE_HOLDER_RECHECK",
      "1",
      "S3_STATE_HOLDER_RECHECK_PLANT",
      60_000,
    );
    expectBoundedS3ChildExit(result, "S3_STATE_HOLDER_RECHECK_PLANT", 0);
    const { stdout, stderr } = result;
    expect(stdout).toContain(
      '"assertion":"live_recursive_lsof_holder_released_after_broad_scan_is_rechecked_to_no_match"',
    );
    expect(stdout).toContain(
      '"assertion":"confirmed_recursive_lsof_holder_remains_a_cleanup_refusal"',
    );
    expect(stdout).toContain('"assertion":"released_recursive_lsof_holder_converges_to_no_match"');
    expect(stdout).toContain(
      '"assertion":"recursive_lsof_warning_and_malformed_output_fail_closed"',
    );
    expect(`${stdout}\n${stderr}`).not.toContain('"status":"fail"');
  },
  { timeout: 60_000 },
);

for (const window of [
  "background_spawn",
  "scratch_assignment",
  "stop_proof",
  "adoption",
  "cont_release",
  "return",
] as const) {
  test(
    `PLANTED: startup signal window ${window} retains exact ownership`,
    async () => {
      const label = `S3_STARTUP_SIGNAL_${window}`;
      const result = await runS3HarnessPlant(
        "S3_SELF_TEST_STARTUP_SIGNAL_WINDOW",
        window,
        label,
        120_000,
      );
      expectBoundedS3ChildExit(result, label, 129);
      const { stdout, stderr } = result;
      expect(stdout).toContain(
        `"assertion":"startup_signal_window_${window}_retained_exact_ownership"`,
      );
      expect(stdout).toContain(`"assertion":"startup_signal_window_${window}_uses_no_worker_port"`);
      expect(`${stdout}\n${stderr}`).not.toContain('"status":"fail"');
    },
    // Each window starts a real pinned-supervisor lifecycle, but deliberately
    // no Worker listener. A shared deadline makes earlier legal startup consume
    // a later case's proof budget.
    { timeout: 120_000 },
  );
}

for (const owner of ["server", "checker"] as const) {
  test(
    `PLANTED: the production ${owner} dispatch preserves a retained startup HUP`,
    async () => {
      const startedAt = performance.now();
      const label = `S3_DISPATCH_STARTUP_SIGNAL_${owner}`;
      const result = await runS3HarnessPlant(
        "S3_SELF_TEST_DISPATCH_STARTUP_SIGNAL",
        owner,
        label,
        60_000,
      );
      expectBoundedS3ChildExit(result, label, 129);
      const { stdout, stderr } = result;
      const combined = `${stdout}\n${stderr}`;
      expect(performance.now() - startedAt).toBeLessThan(60_000);
      expect(stdout).toContain(`"assertion":"dispatch_startup_signal_${owner}_preserves_exit_129"`);
      expect(stdout).toContain(
        `"assertion":"dispatch_startup_signal_${owner}_uses_no_preallocated_worker_port"`,
      );
      expect(combined).not.toContain('"code":"LOCAL_WORKER_SUPERVISOR_UNAVAILABLE"');
      expect(combined).not.toContain('"code":"LOCAL_SPLIT_ASSERTION_FAILED"');
    },
    // The 60-second assertion above remains the semantic prompt-exit bound;
    // this larger limit is only a leak-safe outer watchdog.
    { timeout: 120_000 },
  );
}

for (const owner of ["server", "checker", "provisional"] as const) {
  test(
    `PLANTED: ${owner} KILL dispatch publishes wait-only state before a pending HUP`,
    async () => {
      const label = `S3_KILL_DISPATCH_SIGNAL_${owner}`;
      const result = await runS3HarnessPlant(
        "S3_SELF_TEST_KILL_DISPATCH_SIGNAL_OWNER",
        owner,
        label,
        60_000,
      );
      expectBoundedS3ChildExit(result, label, 129);
      const { stdout, stderr } = result;
      expect(stdout).toContain(
        `"assertion":"kill_dispatch_window_${owner}_publishes_wait_only_state_before_hup"`,
      );
      expect(stdout).toContain(
        `"assertion":"kill_dispatch_window_${owner}_uses_no_preallocated_worker_port"`,
      );
      expect(`${stdout}\n${stderr}`).not.toContain('"status":"fail"');
    },
    { timeout: 60_000 },
  );
}

test(
  "PLANTED: a restored INT cannot overtake the first deferred KILL-window HUP",
  async () => {
    const label = "S3_KILL_DISPATCH_RESTORE_INT_FIRST_SIGNAL";
    const result = await runS3HarnessPlant(
      "S3_SELF_TEST_KILL_DISPATCH_SIGNAL_OWNER",
      "provisional_restore_int",
      label,
      60_000,
    );
    expectBoundedS3ChildExit(result, label, 129);
    const { stdout, stderr } = result;
    expect(stdout).toContain(
      '"assertion":"kill_dispatch_restore_int_preserves_first_deferred_hup"',
    );
    expect(stdout).toContain(
      '"assertion":"kill_dispatch_window_provisional_publishes_wait_only_state_before_hup"',
    );
    expect(stdout).toContain(
      '"assertion":"kill_dispatch_window_provisional_uses_no_preallocated_worker_port"',
    );
    expect(`${stdout}\n${stderr}`).not.toContain('"status":"fail"');
  },
  { timeout: 60_000 },
);

test(
  "PLANTED: a startup-restored INT cannot overtake the first deferred KILL-window HUP",
  async () => {
    const label = "S3_KILL_DISPATCH_STARTUP_RESTORE_INT_FIRST_SIGNAL";
    const result = await runS3HarnessPlant(
      "S3_SELF_TEST_KILL_DISPATCH_SIGNAL_OWNER",
      "provisional_startup_restore_int",
      label,
      60_000,
    );
    expectBoundedS3ChildExit(result, label, 129);
    const { stdout, stderr } = result;
    expect(stdout).toContain(
      '"assertion":"kill_dispatch_startup_restore_int_preserves_first_deferred_hup"',
    );
    expect(stdout).toContain(
      '"assertion":"kill_dispatch_window_provisional_publishes_wait_only_state_before_hup"',
    );
    expect(stdout).toContain(
      '"assertion":"kill_dispatch_window_provisional_uses_no_preallocated_worker_port"',
    );
    expect(`${stdout}\n${stderr}`).not.toContain('"status":"fail"');
  },
  { timeout: 60_000 },
);

for (const direction of ["runtime_to_startup", "startup_to_runtime"] as const) {
  test(
    `PLANTED: ordinary ${direction} trap restoration preserves the first HUP over a later INT`,
    async () => {
      const label = `S3_ORDINARY_SIGNAL_HANDOFF_${direction}`;
      const result = await runS3HarnessPlant(
        "S3_SELF_TEST_ORDINARY_SIGNAL_HANDOFF",
        direction,
        label,
        60_000,
      );
      expectBoundedS3ChildExit(result, label, 129);
      const { stdout, stderr } = result;
      expect(stdout).toContain(
        `"assertion":"ordinary_signal_handoff_${direction}_preserves_first_hup"`,
      );
      expect(`${stdout}\n${stderr}`).not.toContain('"status":"fail"');
    },
    { timeout: 60_000 },
  );
}

test(
  "PLANTED: checker timeout reaps its exact group, descendants, listener, and state FD",
  async () => {
    const result = await runS3HarnessPlant(
      "S3_SELF_TEST_CHECKER_TIMEOUT",
      "1",
      "S3_CHECKER_TIMEOUT_PLANT",
      120_000,
    );
    expectBoundedS3ChildExit(result, "S3_CHECKER_TIMEOUT_PLANT", 0);
    const { stdout, stderr } = result;
    for (const assertion of [
      "checker_timeout_uses_exact_bounded_term_kill_and_wait",
      "checker_timeout_has_zero_group_or_descendant_survivors",
      "checker_timeout_retires_its_owned_listener",
      "checker_timeout_has_zero_state_fd_survivors",
    ]) {
      expect(stdout).toContain(`"assertion":"${assertion}"`);
    }
    expect(`${stdout}\n${stderr}`).not.toContain('"status":"fail"');
  },
  { timeout: 120_000 },
);

async function runCheckerContainmentPlant(deadlineMs = 60_000): Promise<{
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
}> {
  const startedAt = performance.now();
  const result = await runS3HarnessPlant(
    "S3_SELF_TEST_CHECKER_CONTAINMENT_FAILURE",
    "1",
    "S3_CHECKER_CONTAINMENT_PLANT",
    deadlineMs,
  );
  expectBoundedS3ChildExit(result, "S3_CHECKER_CONTAINMENT_PLANT", 1);
  return { ...result, durationMs: performance.now() - startedAt };
}

function expectCheckerContainmentPlant(
  result: {
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number;
    readonly durationMs: number;
  },
  maxDurationMs = 60_000,
): void {
  expect(result.durationMs).toBeLessThan(maxDurationMs);
  expect(result.stdout).toContain('"code":"LOCAL_SPLIT_CHECKER_CONTAINMENT_FAILED"');
  for (const assertion of [
    "checker_containment_fixture_has_owned_group_listener_and_state_fd",
    "checker_containment_refusal_sends_no_signal_and_retains_exact_ownership",
    "checker_containment_exit_retry_reclaims_exact_group",
    "checker_containment_exit_retry_releases_listener",
    "checker_containment_exit_retry_releases_state_fd",
  ]) {
    expect(result.stdout).toContain(`"assertion":"${assertion}"`);
  }
  const combined = `${result.stdout}\n${result.stderr}`;
  expect(combined).not.toContain('"code":"LOCAL_WORKER_UNAVAILABLE"');
  expect(combined).not.toContain('"code":"LOCAL_WORKER_CLEANUP_FAILED"');
  expect(combined).not.toContain('"code":"CHECKER_CONTAINMENT_FIXTURE_INVALID"');
  expect(combined).not.toContain('"code":"CHECKER_CONTAINMENT_EXIT_RETRY_NOT_EXERCISED"');
}

test(
  "PLANTED: an uninspectable checker group reports containment failure and EXIT reclaims it",
  async () => {
    expectCheckerContainmentPlant(await runCheckerContainmentPlant(90_000), 90_000);
  },
  // The assertion above is the semantic prompt-exit bound; this larger limit
  // is only a leak-safe outer watchdog that leaves room for typed cleanup.
  { timeout: 120_000 },
);

test(
  "PLANTED: concurrent checker-containment plants cannot divert through Worker startup",
  async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => runCheckerContainmentPlant(90_000)),
    );
    for (const result of results) expectCheckerContainmentPlant(result, 90_000);
  },
  // Each result retains its semantic bound. This outer ceiling must
  // not TERM a still-cleaning child before its typed evidence can converge.
  { timeout: 180_000 },
);

test(
  "PLANTED: a real checker exit 1 reports safely without waiting for its 90-second timeout",
  async () => {
    const startedAt = performance.now();
    const result = await runS3HarnessPlant(
      "S3_SELF_TEST_CHECKER_EXIT_1",
      "1",
      "S3_CHECKER_EXIT_ONE_PLANT",
      60_000,
    );
    expectBoundedS3ChildExit(result, "S3_CHECKER_EXIT_ONE_PLANT", 1);
    const { stdout, stderr } = result;
    const combined = `${stdout}\n${stderr}`;
    expect(performance.now() - startedAt).toBeLessThan(60_000);
    expect(stdout).toContain('"code":"LOCAL_SPLIT_ASSERTION_FAILED"');
    expect(stdout).toContain('"checker_exit_status":1');
    expect(stdout).toContain('"checker_lifecycle":{"supervisor":"reaped","payload":"exited_1"}');
    expect(stdout).toContain('"kind":"empty"');
    for (const forbidden of [root, "/Users/", "file:///", "Error:", "local-worker.ts"]) {
      expect(combined).not.toContain(forbidden);
    }
    expect(combined).not.toMatch(/\bat\s+.+:\d+:\d+/u);
  },
  { timeout: 120_000 },
);

test(
  "PLANTED: simulated PID reuse with a different marker and lstart sends no signal",
  async () => {
    const result = await runS3HarnessPlant(
      "S3_SELF_TEST_PID_REUSE",
      "1",
      "S3_PID_REUSE_PLANT",
      60_000,
    );
    expectBoundedS3ChildExit(result, "S3_PID_REUSE_PLANT", 0);
    const { stdout, stderr } = result;
    expect(stdout).toContain('"assertion":"planted_pid_reuse_lstart_mismatch_sent_no_signal"');
    expect(`${stdout}\n${stderr}`).not.toContain('"status":"fail"');
  },
  { timeout: 60_000 },
);

test(
  "PLANTED: a payload leader exits under TERM while the pinned supervisor retains resistant descendants",
  async () => {
    const result = await runS3HarnessPlant(
      "S3_SELF_TEST_TERM_RESISTANT_CHILD",
      "1",
      "S3_TERM_RESISTANT_PLANT",
      60_000,
    );
    expectBoundedS3ChildExit(result, "S3_TERM_RESISTANT_PLANT", 0);
    const { stdout, stderr } = result;
    for (const assertion of [
      "payload_leader_exits_while_pinned_supervisor_and_resistant_descendant_remain",
      "term_resistant_supervisor_reaped_before_group_zero_scan",
      "term_resistant_group_has_zero_survivors",
      "term_resistant_fixture_retires_its_owned_listener",
      "term_resistant_state_fd_has_zero_survivors",
    ]) {
      expect(stdout).toContain(`"assertion":"${assertion}"`);
    }
    expect(`${stdout}\n${stderr}`).not.toContain('"status":"fail"');
  },
  { timeout: 60_000 },
);

test(
  "PLANTED: a post-reap inspection failure retries without re-signalling the remembered PGID",
  async () => {
    const result = await runS3HarnessPlant(
      "S3_SELF_TEST_POST_REAP_INSPECTION_FAILURE",
      "1",
      "S3_POST_REAP_INSPECTION_PLANT",
      60_000,
    );
    expectBoundedS3ChildExit(result, "S3_POST_REAP_INSPECTION_PLANT", 0);
    const { stdout, stderr } = result;
    for (const assertion of [
      "post_reap_inspection_failure_retains_inspection_only_ownership",
      "post_reap_retry_inspects_without_resignalling_remembered_pgid",
      "post_reap_retry_has_zero_group_survivors",
      "post_reap_retry_retires_its_owned_listener",
      "post_reap_retry_has_zero_state_fd_survivors",
    ]) {
      expect(stdout).toContain(`"assertion":"${assertion}"`);
    }
    expect(`${stdout}\n${stderr}`).not.toContain('"status":"fail"');
  },
  { timeout: 60_000 },
);

test(
  "PLANTED: transient post-KILL reap uncertainty retries by waiting without re-signalling",
  async () => {
    const result = await runS3HarnessPlant(
      "S3_SELF_TEST_POST_KILL_REAP_UNCERTAINTY",
      "1",
      "S3_POST_KILL_REAP_UNCERTAINTY_PLANT",
      60_000,
    );
    expectBoundedS3ChildExit(result, "S3_POST_KILL_REAP_UNCERTAINTY_PLANT", 0);
    const { stdout, stderr } = result;
    for (const assertion of [
      "post_kill_reap_uncertainty_server_retries_wait_only",
      "post_kill_reap_uncertainty_checker_retries_wait_only",
      "post_kill_reap_uncertainty_provisional_retries_wait_only",
      "post_kill_reap_retries_never_resignal_remembered_identity",
      "post_kill_reap_retry_has_zero_group_survivors",
      "post_kill_reap_retry_retires_all_owned_listeners",
      "post_kill_reap_retry_has_zero_state_fd_survivors",
    ]) {
      expect(stdout).toContain(`"assertion":"${assertion}"`);
    }
    expect(`${stdout}\n${stderr}`).not.toContain('"status":"fail"');
  },
  { timeout: 60_000 },
);

test(
  "PLANTED: a marker-only mismatch with the real lstart refuses group signals and reports cleanup failure",
  async () => {
    const result = await runS3HarnessPlant(
      "S3_SELF_TEST_IDENTITY_MISMATCH",
      "1",
      "S3_IDENTITY_MISMATCH_PLANT",
      60_000,
    );
    expectBoundedS3ChildExit(result, "S3_IDENTITY_MISMATCH_PLANT", 19);
    const { stdout, stderr } = result;
    expect(stdout).toContain('"code":"LOCAL_WORKER_CLEANUP_FAILED"');
    expect(stdout).toContain('"original_status":19');
    expect(stdout).toContain(
      '"assertion":"marker_only_mismatch_refuses_group_signals_and_preserves_ownership"',
    );
    expect(`${stdout}\n${stderr}`).not.toContain('"code":"SECOND_SIGNAL_CLEANUP_BYPASS"');
  },
  { timeout: 60_000 },
);

test(
  "PLANTED: HUP INT and TERM are masked throughout a retained-identity EXIT cleanup retry",
  async () => {
    const result = await runS3HarnessPlant(
      "S3_SELF_TEST_SECOND_SIGNAL_DURING_CLEANUP",
      "1",
      "S3_SECOND_SIGNAL_CLEANUP_PLANT",
      60_000,
    );
    expectBoundedS3ChildExit(result, "S3_SECOND_SIGNAL_CLEANUP_PLANT", 0);
    const { stdout, stderr } = result;
    expect(stdout).toContain(
      '"assertion":"second_signals_are_masked_during_bounded_exit_cleanup_retry"',
    );
    expect(`${stdout}\n${stderr}`).not.toContain('"status":"fail"');
  },
  { timeout: 60_000 },
);

/**
 * The command must positively exercise local workerd D1/R2 and renderer
 * boundaries before honestly blocking staging-only identity/browser proof.
 */
test(
  "the S-3 command proves local bindings and blocks only staging proof",
  async () => {
    const { stdout, stderr, exitCode } = await runBoundedS3Child(
      ["env", "-u", "S3_PORT", "bash", "scripts/e2e-s3-split.sh"],
      "S3_COMMAND",
      { timeoutMs: S3_OWNED_COMMAND_TIMEOUT_MS },
    );
    expectBoundedS3ChildExit({ stdout, stderr, exitCode }, "S3_COMMAND", 78);
    if (stdout.length === 0) {
      throw new Error("S3_COMMAND_OUTPUT_EMPTY");
    }
    const outputLines = stdout.split("\n").filter((line) => line.length > 0);
    const nonRecordLines = outputLines.filter((line) => !line.startsWith("{"));
    expect(nonRecordLines).toHaveLength(0);
    const diagnosticLines = stderr.split("\n").filter((line) => line.length > 0);
    expect(diagnosticLines).toHaveLength(1);
    expect(diagnosticLines[0]).toContain("BLOCKED s3-staging-paired-principal");
    const records = outputLines
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const local = records.find(
      (record) => record.suite === "s3-local-bindings" && record.status === "pass",
    );
    const staging = records.find((record) => record.suite === "s3-staging-paired-principal");
    if (local === undefined || staging === undefined) {
      throw new Error(
        `S3_COMMAND_SUMMARIES_MISSING:${JSON.stringify(
          records.map((record) => ({
            suite: record.suite,
            status: record.status,
            code: record.code,
          })),
        )}`,
      );
    }
    const assertions = records.filter(
      (record) =>
        record.suite === "e2e-s3-split-local" &&
        typeof record.assertion === "string" &&
        record.assertion !== "local_binding_summary",
    );

    expect(local).toMatchObject({
      tool: "wrangler+bun",
      package: "@asimposium/wire",
      suite: "s3-local-bindings",
      status: "pass",
      bindings: { d1: "DB", r2: "ARTIFACTS" },
      reproduce: "bash scripts/e2e-s3-split.sh",
    });
    expect(staging).toMatchObject({
      tool: "wrangler",
      package: "@asimposium/wire",
      suite: "s3-staging-paired-principal",
      status: "blocked",
      exit_code: 78,
      code: "S3_STAGING_ENVIRONMENT_ABSENT",
      reproduce: "bash scripts/e2e-s3-split.sh",
    });
    expect(String(staging?.blocked_on)).toContain("paired sponsor plus anonymous browser proof");
    expect(String(staging?.forbidden_substitutes)).toContain("local-workerd behavior");
    const assertionNames = assertions.map((record) => record.assertion as string).toSorted();
    expect(new Set(assertionNames).size).toBe(assertionNames.length);
    expect(assertionNames).toEqual(EXPECTED_LOCAL_BINDING_ASSERTIONS);
    expect(assertions.every((record) => record.status === "pass")).toBe(true);
    expect(`${stdout}\n${stderr}`).toContain("BLOCKED s3-staging-paired-principal");
    expect(`${stdout}\n${stderr}`).not.toContain(root);
    expect(`${stdout}\n${stderr}`).not.toContain("/Users/");
    expect(`${stdout}\n${stderr}`).not.toMatch(/asimp_ag_[A-Za-z0-9_-]{4,}/);
    expect(stdout).toContain(
      '"assertion":"default_worker_port_is_child_owned_and_nonce_discovered"',
    );
  },
  { timeout: 120_000 },
);
