/**
 * Shared, local test-harness runner for OPS.2a.
 *
 * This is deliberately a harness substrate, not a product-flow claim. It executes
 * explicitly supplied synthetic steps, emits a redacted JSONL ledger plus JUnit, and
 * uses a repository-contained, validated run directory for its artifacts. Product
 * workstreams opt into it later; a green self-test means only that this runner works.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  containsCredentialShape,
  redactCredentials,
} from "@asimposium/contracts/diagnostic-safety";

export const HARNESS_SCHEMA_VERSION = "1.0";
export const HARNESS_BLOCKED_EXIT_CODE = 78;
export const MAX_CAPTURED_OUTPUT_CHARS = 4_096;
export const MAX_DIFF_CHARS = 1_024;
export const MAX_FAILURE_ARTIFACT_CHARS = 8_192;
export const MAX_FAILURE_DETAIL_CHARS = 1_024;
export const MAX_RESUME_HISTORY_BYTES = 64 * 1024;
export const MAX_EVENT_BYTES = 8 * 1024;
export const MAX_EVENT_LEDGER_BYTES = 2 * 1024 * 1024;
export const MAX_FAILURE_ARTIFACTS_PER_RUN = 32;
export const MAX_JUNIT_ARTIFACTS_PER_RUN = 8;
/** The single retained parent for explicit real-filesystem OPS.2a evidence. */
export const DEFAULT_RETAINED_INTEGRATION_NAMESPACE = "ops2a-retention-integration";
export const SELF_TEST_REPRODUCTION = `scripts/e2e-test-harness.sh --self-test --integration-namespace ${DEFAULT_RETAINED_INTEGRATION_NAMESPACE}`;
/**
 * The opt-in integration parent has a second, recursive cap.
 *
 * The top-level namespace backstop only sees `ops2a-retention-integration` as
 * one directory. That is deliberately insufficient: a self-test run id, its
 * resume run id, direct fixture case directories, D1 state, blob staging, and
 * their bytes all sit below that one parent. These limits account for that
 * nested evidence before an operation creates another retained path.
 */
export const MAX_RETAINED_INTEGRATION_DIRECTORIES = 512;
export const MAX_RETAINED_INTEGRATION_BYTES = 16 * 1024 * 1024;
/** Conservative reservation for one real D1 adapter state tree. */
export const MAX_D1_ADAPTER_STATE_BYTES = 2 * 1024 * 1024;
/**
 * Ceiling on artifact namespaces (run directories plus fixture scratch) under
 * `e2e/artifacts`.
 *
 * Per-run output is already bounded by the limits above, but the *number* of
 * runs was not, so the directory grew without end. This is a backstop, not a
 * retention policy: it sits far above any working range, and reaching it means
 * something is wrong rather than that a contributor has been busy. It never
 * deletes or prunes anything — it refuses to create the next namespace and says
 * what to do, because silently removing retained failure evidence would be the
 * worse failure.
 */
export const MAX_ARTIFACT_NAMESPACES = 5_000;
/** Reserved sibling fence that closes artifact claims and publications. */
export const ARTIFACT_MAINTENANCE_FENCE_NAME = ".artifact-maintenance";
/** Append-only sibling registry shared with the shell artifact writers. */
export const ARTIFACT_WRITER_LEASES_NAME = ".artifact-writer-leases";
/** A directory marker closes one lease without deleting its history. */
export const ARTIFACT_WRITER_LEASE_CLOSED_NAME = "closed";
/** Reserved directory holding content-addressed failure blobs; never a run. */
export const ARTIFACT_BLOB_DIRECTORY = "blobs";
/** Per-run manifest naming the blobs a run produced. */
export const FAILURE_MANIFEST_NAME = "failures.jsonl";
/**
 * Where a blob is assembled before it is published.
 *
 * Publication has to be atomic. `writeFileSync(path, …, {flag:"wx"})` is an
 * open followed by a write, so a concurrent reader can observe the name after
 * the create and before the bytes — an empty file that compares unequal to its
 * own digest. The reader then concludes the store contradicts itself and halts
 * a run over a write that was always going to produce identical bytes.
 *
 * So bytes are written here first, under a name no reader looks for, and only a
 * complete file is linked into the store.
 */
const ARTIFACT_BLOB_STAGING_DIRECTORY = "incoming";
const SHA256_HEX = /^[0-9a-f]{64}$/;
/**
 * Manifest record kinds.
 *
 * `intent` is appended *before* the blob is published and `stored` after. The
 * pair is what makes the per-run budget survive a crash: a slot is spent when
 * the attempt begins, not when it succeeds, so a run that dies mid-publish
 * cannot resume and spend the same slot again. Counting only completions let a
 * repeatedly-crashing run publish unbounded distinct blobs across resumes.
 */
export const FAILURE_RECORD_INTENT = "failure_artifact_intent";
export const FAILURE_RECORD_STORED = "failure_artifact";
/** Immutable identity of a run, written once and checked on every resume. */
export const RUN_IDENTITY_NAME = "run-identity.json";
export const MAX_STEPS_PER_RUN = 64;
export const MAX_RETRIES_PER_STEP = 3;
export const MAX_TIMEOUT_MS = 60_000;
/**
 * Milliseconds a legitimately-timed-out step may exceed its own deadline before
 * the event schema calls it impossible.
 *
 * A step that times out at exactly `MAX_TIMEOUT_MS` does not finish there. The
 * runner sends SIGTERM, waits `FORCE_KILL_GRACE_MS` before SIGKILL, then drains
 * both output pipes; on a loaded machine the timer callback itself can be late.
 * The old allowance was the force-kill delay alone, which left nothing for
 * reader drain or scheduling jitter — so a *correct* 60s timeout could throw
 * `EVENT_SCHEMA_INVALID` and destroy the very evidence of the timeout.
 *
 * This grace is deliberately generous. Its only job is to keep an honest
 * measurement representable; every real bound (the step deadline, the retention
 * caps, the watchdogs) is enforced elsewhere and unaffected by it.
 */
export const FORCE_KILL_GRACE_MS = 250;
export const HARD_READER_GRACE_MS = 5_000;
/** Largest duration an event may report and still be schema-valid. */
export const MAX_EVENT_DURATION_MS = MAX_TIMEOUT_MS + FORCE_KILL_GRACE_MS + HARD_READER_GRACE_MS;
export const MAX_COMMAND_ARGUMENTS = 16;
export const MAX_COMMAND_ARGUMENT_CHARS = 4_096;
export const MAX_COMMAND_CHARS = 8_192;
export const MAX_METADATA_CHARS = 256;
export const MAX_ROUTE_TEMPLATE_CHARS = 256;
export const MAX_DIFF_INPUT_CHARS = 16 * 1024;

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const STEP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const XML_ESCAPE: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

export type StepStatus = "pass" | "fail" | "blocked" | "timeout" | "cancelled" | "skipped";
export type HarnessAdapter = "process" | "d1" | "http" | "browser";
export type HarnessStorageAuthority = "real-filesystem" | "simulation";

/**
 * The one probe each non-process adapter is allowed to execute.
 *
 * Registering a probe here is what turns an adapter from "withheld" into
 * "runnable". It is an allowlist rather than a convention so that an adapter
 * label — which is what a reader trusts when deciding whether D1 really ran —
 * cannot be attached to some other executable.
 */
export const ADAPTER_PROBES: Readonly<Record<Exclude<HarnessAdapter, "process">, string>> = {
  d1: "d1-rollback.ts",
  http: "http-fault.ts",
  browser: "browser-assert.ts",
};

export function adapterProbePath(adapter: Exclude<HarnessAdapter, "process">): string {
  return resolve(import.meta.dir, "adapters", ADAPTER_PROBES[adapter]);
}

/** Build the only repository-contained state path the real D1 probe accepts. */
export function retainedD1StateDirectory(
  root: string,
  artifactNamespace: string,
  runId: string,
  stateName: string,
): string {
  if (
    !validateRunId(artifactNamespace) ||
    !validateRunId(runId) ||
    !/^d1-state-[A-Za-z0-9][A-Za-z0-9._-]{0,70}$/.test(stateName)
  ) {
    throw new HarnessError(
      "D1_STATE_DIRECTORY_INVALID",
      "D1 state must use safe integration namespace, run id, and d1-state path components.",
    );
  }
  return join(resolve(root), "e2e", "artifacts", artifactNamespace, runId, stateName);
}

/**
 * Validate an explicit D1 state path without creating it.
 *
 * Its three components are deliberately exact: integration namespace, run id,
 * and one `d1-state-*` leaf. Thus an adapter cannot escape to OS temp or hide
 * arbitrary retained state under a run directory.
 */
export function assertRetainedD1StateDirectory(root: string, stateDirectory: string): string {
  if (!isAbsolute(stateDirectory)) {
    throw new HarnessError(
      "D1_STATE_DIRECTORY_INVALID",
      "D1 state directory must be an absolute retained integration path.",
    );
  }
  const physicalRoot = assertContainedRoot(root);
  const base = join(physicalRoot, "e2e", "artifacts");
  // The leaf does not exist yet, but any existing parent must be an exact real
  // directory under this checkout. A symlinked artifacts ancestor otherwise
  // turns a lexical `<repo>/e2e/artifacts/...` string into an outside write.
  let checked = physicalRoot;
  for (const component of ["e2e", "artifacts"] as const) {
    checked = join(checked, component);
    if (!existsSync(checked)) break;
    if (lstatSync(checked).isSymbolicLink() || !lstatSync(checked).isDirectory()) {
      throw new HarnessError(
        "D1_STATE_DIRECTORY_INVALID",
        "D1 state requires real e2e/artifacts parents inside this checkout.",
      );
    }
    if (realpathSync(checked) !== checked) {
      throw new HarnessError(
        "D1_STATE_DIRECTORY_INVALID",
        "D1 state requires an unredirected e2e/artifacts path inside this checkout.",
      );
    }
  }
  const target = resolve(stateDirectory);
  const relation = relative(base, target);
  const parts = relation === "" ? [] : relation.split(sep);
  if (
    parts.length !== 3 ||
    !validateRunId(parts[0] ?? "") ||
    !validateRunId(parts[1] ?? "") ||
    !/^d1-state-[A-Za-z0-9][A-Za-z0-9._-]{0,70}$/.test(parts[2] ?? "")
  ) {
    throw new HarnessError(
      "D1_STATE_DIRECTORY_INVALID",
      "D1 state directory must be <repo>/e2e/artifacts/<integration>/<run>/d1-state-<name>.",
    );
  }
  return target;
}

export interface HttpContext {
  method: string;
  routeTemplate: string;
  cursor?: number;
  seq?: number;
}

export interface HarnessStep {
  /** Stable, path-safe identifier. Steps are sorted by scenario then id before execution. */
  id: string;
  scenario: string;
  /** OPS.2a executes only direct process steps. Other adapter kinds are explicitly withheld. */
  adapter?: HarnessAdapter;
  command?: readonly string[];
  /** A run can retry or resume this operation only when this is true. */
  replaySafe: boolean;
  retries?: number;
  timeoutMs?: number;
  expected?: string;
  actual?: string;
  assertion?: string;
  requestId?: string;
  eventId?: string;
  http?: HttpContext;
}

export interface HarnessRunOptions {
  root: string;
  runId: string;
  suite: string;
  steps: readonly HarnessStep[];
  /** Supplying a seed makes fixture selection reproducible; omitted derives from suite + run id. */
  seed?: number;
  resume?: boolean;
  /** A real revision if supplied by the caller; unavailable is recorded rather than guessed. */
  gitRevision?: string;
  /** Binding versions are caller supplied metadata only; they are never inherited into children. */
  bindingVersions?: Readonly<Record<string, string>>;
  /** Only a registered CLI scenario may be represented as executable reproduction. */
  reproduction?: "self-test";
  /**
   * Optional retained parent under `e2e/artifacts` for an explicitly enabled
   * real-filesystem integration run. Ordinary production and unit runs omit it.
   */
  artifactNamespace?: string;
  signal?: AbortSignal;
  /** Called with redacted child output. Defaults to visible stderr. */
  onOutput?: (text: string) => void;
  /** Called with every already-redacted JSONL record. Defaults to stdout. */
  onEvent?: (record: HarnessEvent) => void;
  /**
   * Where artifacts are written. Defaults to the real filesystem.
   *
   * The root is still validated against this checkout either way, so supplying
   * an in-memory store does not loosen containment — it only diverts the
   * writes, which is what lets ordinary tests exercise real store behaviour
   * without growing e2e/artifacts.
   */
  storage?: HarnessArtifactStorage;
}

export interface HarnessEvent {
  schema_version: typeof HARNESS_SCHEMA_VERSION;
  record: "step" | "summary" | "self_test";
  run_id: string;
  /** Binds every receipt row to the immutable plan recorded for this run. */
  run_identity_digest: string;
  suite: string;
  scenario: string;
  step: string;
  seed: number;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  attempt: number;
  retry: number;
  replay_safe: boolean;
  /** The storage authority that produced this record. */
  storage_authority: HarnessStorageAuthority;
  adapter: HarnessAdapter;
  status: StepStatus | "pass" | "fail" | "blocked";
  code: string;
  reproduce: string;
  git_revision: string;
  environment: {
    runtime: "bun";
    runtime_version: string;
    platform: string;
    binding_versions: Record<string, string>;
  };
  http_method: string | null;
  route_template: string | null;
  cursor: number | null;
  seq: number | null;
  argv?: string[];
  exit_code?: number;
  request_id?: string;
  event_id?: string;
  assertion?: string;
  diff?: string;
  output_chars?: number;
  output_truncated?: boolean;
  artifact_digest?: string;
  detail?: string;
}

export interface HarnessArtifacts {
  directory: string;
  jsonl: string;
  junit: string;
  failureLogs: string[];
}

export interface HarnessRunResult {
  exitCode: 0 | 1 | typeof HARNESS_BLOCKED_EXIT_CODE;
  events: HarnessEvent[];
  artifacts: HarnessArtifacts;
  seed: number;
  /** Simulation exercises control flow; it is not filesystem evidence. */
  storageAuthority: HarnessStorageAuthority;
}

export class HarnessError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HarnessError";
  }
}

/** Internal sentinel: closing the writer lease would overclaim child quiescence. */
class UnsettledChildProcessError extends HarnessError {
  constructor() {
    super(
      "CHILD_SETTLEMENT_UNPROVEN",
      "child process settlement could not be proved; the artifact writer lease remains open.",
    );
  }
}

export class ArtifactStore {
  readonly directory: string;
  readonly jsonl: string;
  readonly failureLogs: string[] = [];
  private readonly physicalRoot: string;
  private failureArtifactCount: number;
  /** `<root>/e2e/artifacts`, parent of both run namespaces and the blob store. */
  private readonly artifactsDirectory: string;
  /** Physical top-level artifact root whose device/inode this writer claimed. */
  private readonly topLevelArtifactsDirectory: string;
  private readonly artifactRootIdentity: string;
  /** Present only for the explicit retained integration lane. */
  private readonly retainedIntegrationDirectory: string | undefined;
  /** Manifest-relative base for the selected artifact namespace. */
  private readonly artifactRelativeRoot: string;
  /** `<run>/failures.jsonl`: digests this run produced, in order. */
  readonly manifest: string;
  /**
   * Digests this run recorded an intent for whose blob is not in the store.
   *
   * Reported rather than repaired: the bytes died with the process that held
   * them, and nothing here may delete the record that says so. A retry that
   * produces the same output republishes the same digest and clears it.
   */
  readonly danglingFailureDigests: readonly string[];

  private readonly storage: HarnessArtifactStorage;
  private readonly identityDigest: string;
  private writerLease: ArtifactWriterLease | undefined;

  constructor(
    root: string,
    readonly runId: string,
    resume: boolean,
    identity: RunIdentity,
    storage: HarnessArtifactStorage = nodeArtifactStorage,
    artifactNamespace?: string,
  ) {
    this.storage = storage;
    this.identityDigest = runIdentityDigest(identity);
    if (!validateRunId(runId)) {
      throw new HarnessError("RUN_ID_INVALID", "run_id must be one safe path component.");
    }

    const resolvedRoot = resolve(root);
    this.physicalRoot = realDirectory(resolvedRoot, "REPOSITORY_ROOT_INVALID", storage);
    assertArtifactMaintenanceAbsent(this.physicalRoot, storage);
    const e2e = ensureDirectDirectory(this.physicalRoot, "e2e", storage);
    const topLevelArtifacts = ensureDirectDirectory(e2e, "artifacts", storage);
    this.topLevelArtifactsDirectory = topLevelArtifacts;
    this.artifactRootIdentity = storage.directoryIdentity(topLevelArtifacts);
    this.writerLease = acquireArtifactWriterLease(
      this.physicalRoot,
      this.topLevelArtifactsDirectory,
      this.artifactRootIdentity,
      this.storage,
    );
    try {
      this.assertWritableArtifactRoot();
      const artifacts =
        artifactNamespace === undefined
          ? topLevelArtifacts
          : reserveArtifactNamespace(
              this.physicalRoot,
              topLevelArtifacts,
              artifactNamespace,
              MAX_ARTIFACT_NAMESPACES,
              storage,
              this.artifactRootIdentity,
            );
      this.artifactsDirectory = artifacts;
      this.retainedIntegrationDirectory = artifactNamespace === undefined ? undefined : artifacts;
      this.artifactRelativeRoot =
        artifactNamespace === undefined ? "e2e/artifacts" : `e2e/artifacts/${artifactNamespace}`;
      /**
       * A new run refuses a namespace that already exists — at all.
       *
       * Testing only for `events.jsonl` meant a directory holding a failure
       * manifest, a JUnit file, or anything else was silently adopted: the new
       * run inherited another run's evidence directory and appended to it, and
       * the resulting artifacts described two runs as one. Existence of the
       * namespace is the check, because the namespace is the unit of ownership.
       */
      // A symlink where the namespace belongs is a containment failure, not an
      // ownership one, and it is checked first so it keeps its own sharper error
      // rather than being reported as "this run_id is taken".
      if (storage.isSymlink(join(artifacts, runId))) {
        throw new HarnessError(
          "ARTIFACT_PATH_UNSAFE",
          "the run namespace is a symlink; artifacts must not be redirected out of the artifact area.",
        );
      }
      const namespaceExisted = storage.exists(join(artifacts, runId));
      if (!resume && namespaceExisted) {
        throw new HarnessError(
          "RUN_ID_EXISTS",
          "run_id already owns an artifact namespace; choose a new run_id or resume that run.",
        );
      }
      // A resume never creates or adopts a namespace. In particular, do this
      // before creating events.jsonl: a missing identity is a retained-evidence
      // defect, not permission to add a blank ledger beside it.
      const existingIdentityPath = join(artifacts, runId, RUN_IDENTITY_NAME);
      if (resume && (!namespaceExisted || !storage.exists(existingIdentityPath))) {
        throw new HarnessError(
          "RUN_IDENTITY_MISSING",
          "the retained run has no identity record; refusing to append unverifiable resume evidence.",
        );
      }
      // Counted and created together. Two separate calls left a window in which
      // another run could create the namespace that took the checkout over the
      // limit after this one had already counted; narrowing it to a single
      // reservation cannot make the backstop exact under concurrency, but it does
      // remove the avoidable part of the gap.
      this.directory = resume
        ? realDirectory(join(artifacts, runId), "ARTIFACT_PATH_UNSAFE", storage)
        : artifactNamespace === undefined
          ? reserveNewArtifactNamespace(
              this.physicalRoot,
              artifacts,
              runId,
              MAX_ARTIFACT_NAMESPACES,
              storage,
              this.artifactRootIdentity,
            )
          : reserveNewRetainedIntegrationDirectory(
              artifacts,
              runId,
              storage,
              1,
              this.artifactRootIdentity,
            );
      this.assertWritableArtifactRoot();
      this.jsonl = join(this.directory, "events.jsonl");
      assertRegularOrAbsent(this.jsonl, "ARTIFACT_PATH_UNSAFE", storage);
      this.identityPath = join(this.directory, RUN_IDENTITY_NAME);
      assertRegularOrAbsent(this.identityPath, "ARTIFACT_PATH_UNSAFE", storage);
      // Written once, verified on every resume: a resumed run that changed its
      // suite, seed, or step set is a different run wearing the same id, and its
      // appended events would describe work the earlier events never did.
      if (!storage.exists(this.identityPath)) this.assertRetainedCapacity(MAX_EVENT_BYTES);
      this.assertWritableArtifactRoot();
      reconcileRunIdentity(this.identityPath, identity, resume && namespaceExisted, storage);
      if (!storage.exists(this.jsonl)) {
        this.assertWritableArtifactRoot();
        storage.writeExclusive(this.jsonl, "");
      }

      this.manifest = join(this.directory, FAILURE_MANIFEST_NAME);
      assertRegularOrAbsent(this.manifest, "ARTIFACT_PATH_UNSAFE", storage);
      // A resumed run continues the same bounded budget it already spent, counted
      // per attempt rather than per digest so a crashed attempt stays spent.
      const reconciled = reconcileFailureManifest(
        this.manifest,
        this.artifactsDirectory,
        runId,
        storage,
        this.artifactRelativeRoot,
      );
      this.failureArtifactCount = reconciled.attemptCount;
      this.danglingFailureDigests = reconciled.dangling;
      for (const digest of reconciled.stored) {
        this.failureLogs.push(
          join(this.artifactsDirectory, ARTIFACT_BLOB_DIRECTORY, "sha256", digest),
        );
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }

  private readonly identityPath: string;

  append(event: HarnessEvent): void {
    if (event.run_id !== this.runId || event.run_identity_digest !== this.identityDigest) {
      throw new HarnessError(
        "RUN_EVENT_IDENTITY_MISMATCH",
        "an event is not bound to this run's immutable identity; retained evidence was left untouched.",
      );
    }
    const serialized = `${JSON.stringify(event)}\n`;
    const eventBytes = Buffer.byteLength(serialized, "utf8");
    if (eventBytes > MAX_EVENT_BYTES) {
      throw new HarnessError("EVENT_TOO_LARGE", "a redacted event exceeds the fixed event size.");
    }
    if (this.storage.size(this.jsonl) + eventBytes > MAX_EVENT_LEDGER_BYTES) {
      throw new HarnessError(
        "EVENT_LEDGER_LIMIT",
        "the bounded event ledger is full; retain the existing evidence without deletion.",
      );
    }
    this.assertRetainedCapacity(eventBytes);
    this.assertWritableArtifactRoot();
    this.storage.append(this.jsonl, serialized);
  }

  /**
   * Store one failure payload as a content-addressed blob and record it in the
   * run's manifest.
   *
   * The digest covers the *clipped* bytes actually stored, so the name always
   * describes the file's real content rather than an input that was truncated
   * on the way in. Identical output — the common case, since a planted failure
   * emits the same bytes on every run — resolves to one blob that is written
   * once and thereafter only referenced.
   *
   * Blobs are written with `wx` and are never overwritten. If a blob already
   * exists with different bytes, that is not a duplicate to be reconciled: it
   * means the store disagrees with itself, so the run stops rather than
   * silently replacing retained evidence.
   */
  writeFailureLog(step: HarnessStep, attempt: number, output: string): string | undefined {
    if (output.length === 0) return undefined;
    if (this.failureArtifactCount >= MAX_FAILURE_ARTIFACTS_PER_RUN) return undefined;
    const safeStep = validateStepId(step.id) ? step.id : "invalid-step";
    const stored = clip(output, MAX_FAILURE_ARTIFACT_CHARS);
    const digest = createHash("sha256").update(stored, "utf8").digest("hex");
    const bytes = Buffer.byteLength(stored, "utf8");
    // The recursive cap sees the blob and its retained staging link as two
    // names. Reserve both, the two manifest records, and the three store
    // directories before the intent makes an attempt durable.
    this.assertRetainedCapacity(bytes * 2 + MAX_EVENT_BYTES, 3);
    this.assertWritableArtifactRoot();
    const path = this.blobPath(digest);

    const describe = (record: string) => ({
      schema_version: HARNESS_SCHEMA_VERSION,
      record,
      run_id: this.runId,
      step: safeStep,
      attempt,
      digest,
      bytes,
      blob: `${this.artifactRelativeRoot}/${ARTIFACT_BLOB_DIRECTORY}/sha256/${digest}`,
    });

    // The slot is spent here, before the blob exists. A crash after this line
    // and before publication leaves a dangling intent, which the next
    // construction reports and which keeps the budget honest; counting only
    // completed blobs let a crash loop spend one slot arbitrarily often.
    this.assertWritableArtifactRoot();
    this.storage.append(this.manifest, `${JSON.stringify(describe(FAILURE_RECORD_INTENT))}\n`);
    this.failureArtifactCount += 1;

    this.publishBlob(digest, stored);

    this.assertWritableArtifactRoot();
    this.storage.append(this.manifest, `${JSON.stringify(describe(FAILURE_RECORD_STORED))}\n`);
    // One blob is one entry. Identical output from two steps resolves to the
    // same path, and a list that repeated it would report one file as several
    // pieces of evidence.
    if (!this.failureLogs.includes(path)) this.failureLogs.push(path);
    return path;
  }

  /**
   * Publish one blob atomically, without deleting, overwriting, or moving.
   *
   * Bytes are assembled under a staging name and then `link`ed into the store.
   * `link` is the primitive that makes all three properties hold at once: it is
   * atomic, so a reader never observes a half-written blob; it refuses when the
   * target exists, so a divergent blob is never silently replaced the way
   * `rename` would replace it; and it publishes a *second name for the same
   * inode* rather than relocating the first, so nothing is moved.
   *
   * The staging entry is therefore retained rather than cleaned up — and
   * retaining it costs no data, because after the link both names refer to one
   * inode holding one copy of the bytes. Staging is bounded by construction: a
   * blob that already exists returns before any staging file is created, so at
   * most one entry appears per *distinct* blob first published here, plus one
   * per lost publication race. `countBlobStagingArtifacts` makes that number
   * observable instead of a matter of trust.
   */
  private publishBlob(digest: string, stored: string): void {
    this.stagingCounter += 1;
    publishFailureBlob({
      containmentRoot: this.physicalRoot,
      artifactsDirectory: this.artifactsDirectory,
      digest,
      stored,
      attempt: this.stagingCounter,
      storage: this.storage,
      retainedIntegrationDirectory: this.retainedIntegrationDirectory,
      artifactRootDirectory: this.topLevelArtifactsDirectory,
      expectedArtifactRootIdentity: this.artifactRootIdentity,
    });
  }

  private stagingCounter = 0;

  private assertRetainedCapacity(additionalBytes: number, additionalDirectories = 0): void {
    if (this.retainedIntegrationDirectory === undefined) return;
    assertRetainedIntegrationCapacity(
      this.retainedIntegrationDirectory,
      { additionalBytes, additionalDirectories },
      this.storage,
    );
  }

  private assertWritableArtifactRoot(): void {
    const lease = this.writerLease;
    if (lease === undefined) {
      throw new HarnessError(
        "ARTIFACT_WRITER_LEASE_CLOSED",
        "artifact writer lease is closed; retained evidence was left untouched.",
      );
    }
    assertArtifactWriterLeaseOpen(lease);
  }

  close(): void {
    const lease = this.writerLease;
    if (lease === undefined) return;
    closeArtifactWriterLease(lease);
    this.writerLease = undefined;
  }

  /** Resolve and contain the path for one digest. */
  private blobPath(digest: string): string {
    if (!SHA256_HEX.test(digest)) {
      throw new HarnessError("ARTIFACT_PATH_UNSAFE", "a blob name must be a sha256 hex digest.");
    }
    const path = join(blobStoreDirectory(this.artifactsDirectory, this.storage), digest);
    assertContained(this.physicalRoot, path, "ARTIFACT_PATH_UNSAFE");
    return path;
  }

  /** Read an artifact this store wrote, through the same storage it wrote with. */
  readArtifact(path: string): string {
    return this.storage.readFile(path);
  }

  writeJUnit(events: readonly HarnessEvent[]): string {
    let attempt = 0;
    while (attempt < MAX_JUNIT_ARTIFACTS_PER_RUN) {
      const name = attempt === 0 ? "junit.xml" : `junit.${attempt}.xml`;
      const path = join(this.directory, name);
      assertContained(this.physicalRoot, path, "ARTIFACT_PATH_UNSAFE");
      if (this.storage.exists(path) || this.storage.isSymlink(path)) {
        attempt += 1;
        continue;
      }
      const body = junitXml(events);
      this.assertRetainedCapacity(Buffer.byteLength(body, "utf8"));
      this.assertWritableArtifactRoot();
      this.storage.writeExclusive(path, body);
      return path;
    }
    throw new HarnessError(
      "JUNIT_ARTIFACT_LIMIT",
      "no bounded JUnit artifact slot remains; existing retained artifacts are not deleted.",
    );
  }

  loadResumeStates(): Map<string, StepStatus> {
    const text = this.storage.readFile(this.jsonl);
    if (Buffer.byteLength(text, "utf8") > MAX_RESUME_HISTORY_BYTES) {
      throw new HarnessError(
        "RUN_HISTORY_TOO_LARGE",
        "run history exceeds the bounded resume ledger size.",
      );
    }
    const states = new Map<string, StepStatus>();
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const event = JSON.parse(line) as HarnessEvent;
        validateHarnessEvent(event);
        if (event.run_id !== this.runId || event.run_identity_digest !== this.identityDigest) {
          throw new HarnessError(
            "RUN_EVENT_IDENTITY_MISMATCH",
            "run history contains an event bound to a different immutable run identity.",
          );
        }
        if (event.record === "step") states.set(event.step, event.status);
      } catch (error) {
        if (error instanceof HarnessError && error.code === "RUN_EVENT_IDENTITY_MISMATCH") {
          throw error;
        }
        throw new HarnessError(
          "RUN_HISTORY_INVALID",
          "run history contains an invalid JSONL record.",
        );
      }
    }
    return states;
  }
}

export function validateRunId(runId: string): boolean {
  return RUN_ID_PATTERN.test(runId);
}

export function validateStepId(stepId: string): boolean {
  return STEP_ID_PATTERN.test(stepId);
}

export function deterministicSeed(suite: string, runId: string): number {
  let hash = 2_166_136_261;
  for (const character of `${suite}\u0000${runId}`) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export function orderSteps(steps: readonly HarnessStep[]): HarnessStep[] {
  return [...steps].sort((left, right) => {
    const scenarioOrder = asciiCompare(left.scenario, right.scenario);
    return scenarioOrder === 0 ? asciiCompare(left.id, right.id) : scenarioOrder;
  });
}

/** Redact all never-log classes before data is emitted, shown, or retained. */
export function redactNeverLog(text: string, root: string): string {
  let output = text;
  const temporary = tmpdir();
  const temporaryAliases = new Set([
    temporary,
    "/tmp",
    "/private/tmp",
    temporary.startsWith("/private/") ? temporary.slice("/private".length) : `/private${temporary}`,
  ]);
  // `/tmp` is a suffix of `/private/tmp`; replacing it first leaves the
  // Darwin-only `/private` prefix behind. Longest first makes aliases atomic.
  const redactionRoots = [resolve(root), homedir(), ...temporaryAliases].sort(
    (left, right) => right.length - left.length,
  );
  for (const absolute of redactionRoots) {
    if (absolute.length > 1) output = output.split(absolute).join("<path>");
  }
  // A generic opaque-token redactor must not corrupt an integrity value the
  // harness itself has already validated. Preserve only explicitly labelled
  // SHA-256 evidence, then restore it after secret-shaped values are removed.
  const protectedDigests: { marker: string; digest: string }[] = [];
  // A per-call cryptographic nonce prevents untrusted output from predicting
  // an integrity marker. A marker is restored only when its one protected
  // occurrence remains; any collision stays redacted rather than fabricating
  // a digest into an attacker-selected field.
  const markerNonce = randomBytes(16).toString("hex");
  output = output.replace(
    /((?:sha256|sha-256|digest)\s*["']?\s*(?:=|:)\s*["']?)([0-9a-f]{64})(?=["']?\b)/gi,
    (_whole, prefix: string, digest: string) => {
      const marker = `\u0000HARNESS_SHA256_${markerNonce}_${protectedDigests.length}\u0000`;
      protectedDigests.push({ marker, digest: digest.toLowerCase() });
      return `${prefix}${marker}`;
    },
  );
  // Credential shapes and labelled values have one canonical owner. Keep this
  // before the harness-only opaque pass so line-valued headers and bodies retain
  // their labels while losing their full value.
  output = redactCredentials(output);
  output = output.replace(/\b[A-Za-z0-9]{32,}\b/g, "<redacted>");
  output = output.replace(/\/(?:private\/)?tmp(?:\/[A-Za-z0-9._-]+)+/g, "<redacted>");
  for (const { marker, digest } of protectedDigests) {
    output = restoreProtectedSha256Marker(output, marker, digest);
  }
  return output;
}

/**
 * Restore exactly one private SHA-256 marker, or redact every occurrence.
 *
 * This is pure so the collision behavior can be proven without predicting the
 * per-call cryptographic marker produced by `redactNeverLog`.
 */
export function restoreProtectedSha256Marker(
  output: string,
  marker: string,
  digest: string,
): string {
  const first = output.indexOf(marker);
  const second = first < 0 ? -1 : output.indexOf(marker, first + marker.length);
  if (first < 0 || second >= 0) {
    // Fail closed on a collision or unexpected transformation: never perform
    // a global digest replacement that could fabricate evidence in another field.
    return output.replaceAll(marker, "<redacted>");
  }
  return `${output.slice(0, first)}${digest}${output.slice(first + marker.length)}`;
}

export function boundedDiff(expected: string, actual: string, root: string): string {
  const safeExpected = redactNeverLog(expected, root);
  const safeActual = redactNeverLog(actual, root);
  const prefix = commonPrefix(safeExpected, safeActual);
  const head = prefix.length > 80 ? `…${prefix.slice(-80)}` : prefix;
  return clip(
    `common_prefix=${JSON.stringify(head)}\nexpected=${JSON.stringify(safeExpected.slice(prefix.length))}\nactual=${JSON.stringify(safeActual.slice(prefix.length))}`,
    MAX_DIFF_CHARS,
  );
}

export function selfTestReproduction(
  artifactNamespace = DEFAULT_RETAINED_INTEGRATION_NAMESPACE,
): string {
  if (!validateRunId(artifactNamespace)) {
    throw new HarnessError(
      "ARTIFACT_NAMESPACE_INVALID",
      "a self-test reproduction must name one safe retained integration namespace.",
    );
  }
  return `scripts/e2e-test-harness.sh --self-test --integration-namespace ${artifactNamespace}`;
}

export function safeReproductionCommand(
  reproduction?: HarnessRunOptions["reproduction"],
  artifactNamespace?: string,
): string {
  if (reproduction === "self-test") return selfTestReproduction(artifactNamespace);
  return "unavailable: no registered CLI scenario";
}

/** Validate the public runner input before any artifact directory or child process is created. */
/** Files that must exist for a directory to be this checkout. */
const REPOSITORY_SENTINELS = ["package.json", join("scripts", "harness", "runner.ts")] as const;

/**
 * The checkout this runner physically belongs to.
 *
 * Anchoring identity to `import.meta.dir` rather than to `git rev-parse
 * --show-toplevel` is deliberate and, for this purpose, stronger: it is the
 * directory the executing code actually came from, it needs no subprocess, it
 * still works in a worktree or an exported tarball with no `.git`, and it
 * cannot be redirected by a nested or planted `.git`. The sentinels below then
 * confirm the directory really is an ASImposium checkout rather than a
 * coincidence of layout.
 */
export function repositoryRoot(): string {
  const candidate = realpathSync(resolve(import.meta.dir, "..", ".."));
  for (const sentinel of REPOSITORY_SENTINELS) {
    if (!existsSync(join(candidate, sentinel))) {
      throw new HarnessError(
        "ROOT_IDENTITY_UNVERIFIABLE",
        "the harness cannot identify its own checkout; a project sentinel is missing.",
      );
    }
  }
  return candidate;
}

/**
 * Read-only filesystem facts needed to establish a harness root's identity.
 *
 * The runner never accepts this through `HarnessRunOptions`: production always
 * uses `nodeRootFilesystem`. The seam exists so root-identity negatives can be
 * exercised without manufacturing temp directories, lookalike sentinels, or
 * symlinks that this repository is forbidden to clean up.
 */
export interface HarnessRootFilesystem {
  exists(path: string): boolean;
  isSymlink(path: string): boolean;
  isDirectory(path: string): boolean;
  realpath(path: string): string;
  repositoryRoot(): string;
  homeDirectory(): string;
  temporaryDirectory(): string;
}

export const nodeRootFilesystem: HarnessRootFilesystem = {
  exists: (path) => existsSync(path),
  isSymlink: (path) => lstatSync(path).isSymbolicLink(),
  isDirectory: (path) => statSync(path).isDirectory(),
  realpath: (path) => realpathSync(path),
  repositoryRoot,
  homeDirectory: () => homedir(),
  temporaryDirectory: () => tmpdir(),
};

/**
 * Establish the run root, by identity — not merely by shape.
 *
 * Everything the harness writes lands under this path and every child runs with
 * it as the working directory, so "any absolute directory" is far too generous:
 * it would let a stray `--root` scatter an `e2e/artifacts` tree into a home
 * directory, an unrelated repository, or the parent of this one, and the
 * mistake would look like a successful run.
 *
 * Exactly one root is accepted: **this checkout**, compared by realpath against
 * `repositoryRoot()`. AGENTS.md is unconditional — "artifact roots stay under
 * the repository" — so there is no opt-in, no marker file, and no flag that
 * relaxes it. An earlier revision of this function offered a consent marker so
 * disposable temp roots could be used by tests; that was an escape hatch this
 * rule does not permit. Ordinary tests isolate artifact writes in memory, and
 * the explicit real-filesystem proof retains evidence below its one approved
 * namespace in this checkout.
 *
 * Symlinked roots are refused outright rather than silently resolved. Following
 * one would mean the caller named one directory and the harness wrote to
 * another, which is precisely the confusion this function exists to prevent.
 */
export function assertContainedRoot(
  root: unknown,
  filesystem: HarnessRootFilesystem = nodeRootFilesystem,
): string {
  if (typeof root !== "string" || root.length === 0) {
    throw new HarnessError("ROOT_INVALID", "root must be a non-empty absolute path.");
  }
  if (!isAbsolute(root)) {
    throw new HarnessError("ROOT_INVALID", "root must be absolute, not relative to a caller cwd.");
  }
  if (!filesystem.exists(root)) {
    throw new HarnessError("ROOT_INVALID", "root does not exist.");
  }
  // Refuse rather than resolve: a symlinked root means the path the caller
  // named and the path the harness writes to are two different places.
  //
  // Only the final component is tested. An ancestor symlink is a platform fact
  // — macOS resolves `/var` to `/private/var`, so every `mkdtemp` directory has
  // one — and refusing those would ban temp roots on an entire operating system
  // while catching no actual caller confusion.
  if (filesystem.isSymlink(root)) {
    throw new HarnessError(
      "ROOT_SYMLINK_REFUSED",
      "root must not be a symlink; name the real directory so artifacts land where the caller believes.",
    );
  }
  const real = filesystem.realpath(root);
  if (!filesystem.isDirectory(real)) {
    throw new HarnessError("ROOT_INVALID", "root must be a directory.");
  }
  if (real === sep) {
    throw new HarnessError("ROOT_INVALID", "the filesystem root is never a valid artifact base.");
  }
  // Named explicitly so these two very common mistakes get their own message
  // instead of the generic identity refusal.
  if (real === filesystem.realpath(filesystem.homeDirectory())) {
    throw new HarnessError("ROOT_NOT_REPOSITORY", "a home directory is never a harness root.");
  }
  if (real === filesystem.realpath(filesystem.temporaryDirectory())) {
    throw new HarnessError(
      "ROOT_NOT_REPOSITORY",
      "the shared temp directory is never a harness root.",
    );
  }

  /**
   * Checkout-only, with no escape hatch.
   *
   * A marker file briefly lived here so tests could isolate. That was a bad
   * trade: it weakened a *production* guard for a test convenience, and the
   * unlock was reachable by anything able to write a file. Test ergonomics are
   * solved below by injecting storage, not by loosening what production
   * accepts. AGENTS.md keeps artifact roots under the repository, and this is
   * the assertion that enforces it.
   */
  if (real !== filesystem.repositoryRoot()) {
    throw new HarnessError(
      "ROOT_NOT_REPOSITORY",
      "root is not this checkout; refusing to write artifacts into an unrelated directory.",
    );
  }
  return real;
}

/**
 * The filesystem operations the artifact tree performs.
 *
 * Narrow on purpose: this is the storage layer that creates run namespaces and
 * writes blobs and manifests — the part that made the checkout's `e2e/artifacts`
 * grow without bound — and nothing else in this module routes through it.
 *
 * Injecting it is what lets ordinary unit tests exercise real store behaviour
 * without writing anything. The alternative attempts were both worse: a marker
 * file that loosened production containment, and `mkdtemp` roots that put
 * artifact data outside the repository and, because nothing here may delete,
 * simply moved the unbounded growth into the system temp directory.
 */
export interface HarnessArtifactStorage {
  /**
   * What this storage can attest to.
   *
   * Required rather than optional, so every implementation states it and no
   * result can be produced without one. A simulation exercises control flow —
   * which branch ran, which error was raised — and proves nothing about the
   * kernel behaviour this store depends on: hard-link atomicity, EEXIST under
   * real contention, inode identity. Only "real-filesystem" evidences those.
   */
  readonly authority: HarnessStorageAuthority;
  exists(path: string): boolean;
  isSymlink(path: string): boolean;
  isFile(path: string): boolean;
  isDirectory(path: string): boolean;
  /** Stable device/inode identity for one real directory. */
  directoryIdentity(path: string): string;
  realpath(path: string): string;
  mkdir(path: string): void;
  readdir(path: string): readonly string[];
  readFile(path: string): string;
  /** Fails with `EEXIST` when the path is taken; never truncates. */
  writeExclusive(path: string, data: string): void;
  append(path: string, data: string): void;
  /** Atomic publish that refuses an existing target, as POSIX `link` does. */
  link(existing: string, target: string): void;
  size(path: string): number;
}

/**
 * Refuse to treat a simulated run as evidence.
 *
 * Anything that emits a receipt, a gate result, or a retention claim calls this
 * first. A simulation can show which branch executed; it cannot witness kernel
 * hard-link semantics, so a receipt derived from one would assert something
 * nobody observed.
 */
export function assertRealStorageAuthority(storage: HarnessArtifactStorage): void {
  if (storage !== nodeArtifactStorageCapability) {
    throw new HarnessError(
      "STORAGE_AUTHORITY_UNTRUSTED",
      "only the exact node artifact storage capability can produce a retention receipt or stand as filesystem evidence.",
    );
  }
}

/** Labels are derived from the unforgeable adapter identity, never its string field. */
function storageAuthority(storage: HarnessArtifactStorage): HarnessStorageAuthority {
  return storage === nodeArtifactStorageCapability ? "real-filesystem" : "simulation";
}

/**
 * Inspect the production artifact root without creating an artifact.
 *
 * The preflight intentionally has a narrower claim than a run: it attests
 * that the caller selected real filesystem authority and reports whether the
 * retention backstop permits a run. A blocked preflight does not imply that
 * hard-link publication or any shell step was exercised.
 */
export function realFilesystemRetentionPreflight(
  root: string,
  storage: HarnessArtifactStorage = nodeArtifactStorage,
  artifactNamespace?: string,
): ArtifactCapacityReport {
  assertContainedRoot(root);
  assertRealStorageAuthority(storage);
  return artifactCapacityReport(root, MAX_ARTIFACT_NAMESPACES, storage, artifactNamespace);
}

/**
 * The real-filesystem authority capability.
 *
 * It is intentionally private and frozen. The exported reference is useful as
 * an adapter, but callers cannot replace a method or its label and keep the
 * capability identity that receipt/preflight code trusts. All authority checks
 * compare against this private object, never against `authority` text.
 */
const nodeArtifactStorageCapability = Object.freeze<HarnessArtifactStorage>({
  authority: "real-filesystem",
  exists: (path) => existsSync(path),
  isSymlink: (path) => {
    try {
      return lstatSync(path).isSymbolicLink();
    } catch {
      return false;
    }
  },
  isFile: (path) => {
    try {
      return lstatSync(path).isFile();
    } catch {
      return false;
    }
  },
  isDirectory: (path) => {
    try {
      return lstatSync(path).isDirectory();
    } catch {
      return false;
    }
  },
  directoryIdentity: (path) => {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe directory");
    return `${stat.dev}:${stat.ino}`;
  },
  realpath: (path) => realpathSync(path),
  mkdir: (path) => mkdirSync(path),
  readdir: (path) => readdirSync(path),
  readFile: (path) => readFileSync(path, "utf8"),
  writeExclusive: (path, data) => writeFileSync(path, data, { encoding: "utf8", flag: "wx" }),
  append: (path, data) => appendFileSync(path, data, "utf8"),
  link: (existing, target) => linkSync(existing, target),
  size: (path) => statSync(path).size,
});

/**
 * The immutable real filesystem adapter. Its identity is not the authority
 * proof; the private capability above is. Exposing the frozen inferred type
 * also prevents TypeScript callers from treating this as a mutable test seam.
 */
export const nodeArtifactStorage = nodeArtifactStorageCapability;

class MemoryStorageError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/**
 * An in-memory artifact tree.
 *
 * Models the properties the store depends on rather than a filesystem in
 * general: exclusive creation, `link` refusing an existing target, and
 * directories that must exist before their children. Symlinks are representable
 * so containment tests can plant one, but nothing here follows them — the store
 * only ever asks whether a path *is* a link, and then refuses.
 *
 * `runHarness` still validates its root against the real checkout, so a test
 * using this seam proves the same containment rules; only the writes are
 * diverted.
 */
export function createMemoryArtifactStorage(): HarnessArtifactStorage & {
  readonly files: Map<string, string>;
  readonly directories: Set<string>;
  symlink(path: string): void;
  seedDirectory(path: string): void;
} {
  const files = new Map<string, string>();
  const directories = new Set<string>();
  const symlinks = new Set<string>();
  const directoryIdentities = new Map<string, number>();
  let nextDirectoryIdentity = 1;
  /** Inode identity, so `link` shares content rather than copying it. */
  const inodes = new Map<string, string>();

  const seedDirectory = (path: string): void => {
    let current = resolve(path);
    while (current !== sep && current.length > 1) {
      directories.add(current);
      if (!directoryIdentities.has(current)) {
        directoryIdentities.set(current, nextDirectoryIdentity);
        nextDirectoryIdentity += 1;
      }
      current = resolve(current, "..");
    }
    directories.add(sep);
    if (!directoryIdentities.has(sep)) {
      directoryIdentities.set(sep, nextDirectoryIdentity);
      nextDirectoryIdentity += 1;
    }
  };

  return {
    authority: "simulation",
    files,
    directories,
    seedDirectory,
    symlink: (path) => symlinks.add(resolve(path)),
    exists: (path) => {
      const key = resolve(path);
      return files.has(key) || directories.has(key) || symlinks.has(key);
    },
    isSymlink: (path) => symlinks.has(resolve(path)),
    isFile: (path) => files.has(resolve(path)),
    isDirectory: (path) => directories.has(resolve(path)),
    directoryIdentity: (path) => {
      const key = resolve(path);
      const identity = directoryIdentities.get(key);
      if (!directories.has(key) || symlinks.has(key) || identity === undefined) {
        throw new MemoryStorageError("ENOENT");
      }
      return `memory:${identity}`;
    },
    realpath: (path) => {
      const key = resolve(path);
      if (!files.has(key) && !directories.has(key)) throw new MemoryStorageError("ENOENT");
      return key;
    },
    mkdir: (path) => {
      const key = resolve(path);
      if (files.has(key) || directories.has(key)) throw new MemoryStorageError("EEXIST");
      directories.add(key);
      directoryIdentities.set(key, nextDirectoryIdentity);
      nextDirectoryIdentity += 1;
    },
    readdir: (path) => {
      const key = resolve(path);
      const prefix = `${key}${sep}`;
      const names = new Set<string>();
      for (const candidate of [...files.keys(), ...directories]) {
        if (!candidate.startsWith(prefix)) continue;
        const rest = candidate.slice(prefix.length);
        if (rest.length === 0) continue;
        names.add(rest.split(sep)[0] as string);
      }
      return [...names].sort();
    },
    readFile: (path) => {
      const key = resolve(path);
      const inode = inodes.get(key);
      const value = inode === undefined ? files.get(key) : files.get(inode);
      if (value === undefined) throw new MemoryStorageError("ENOENT");
      return value;
    },
    writeExclusive: (path, data) => {
      const key = resolve(path);
      if (files.has(key) || directories.has(key)) throw new MemoryStorageError("EEXIST");
      files.set(key, data);
    },
    append: (path, data) => {
      const key = resolve(path);
      files.set(key, `${files.get(key) ?? ""}${data}`);
    },
    link: (existing, target) => {
      const from = resolve(existing);
      const to = resolve(target);
      if (files.has(to) || directories.has(to)) {
        const error = new MemoryStorageError("EEXIST");
        (error as NodeJS.ErrnoException).code = "EEXIST";
        throw error;
      }
      const source = inodes.get(from) ?? from;
      const value = files.get(source);
      if (value === undefined) throw new MemoryStorageError("ENOENT");
      // A second name for one inode, exactly as the real store relies upon.
      files.set(to, value);
      inodes.set(to, source);
    },
    size: (path) => Buffer.byteLength(files.get(resolve(path)) ?? "", "utf8"),
  };
}

/** True when `target` stays inside `root` once both are fully resolved. */
export function isContainedPath(root: string, target: string): boolean {
  const relation = relative(root, target);
  return relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
}

/**
 * Every key `HarnessRunOptions` accepts. An option outside this set is a
 * caller error, not something to ignore: a misspelled or invented option that
 * is silently dropped reads to the caller as "honoured", which is how a run
 * ends up doing the opposite of what it was asked.
 */
/**
 * Keyed by `keyof HarnessRunOptions`, so the compiler — not a reviewer —
 * enforces that the set stays complete. A `readonly string[]` accepted a list
 * that had silently fallen behind the interface, which turns adding an option
 * into a runtime refusal of the option that was just added.
 */
const HARNESS_RUN_OPTION_COVERAGE: Readonly<Record<keyof HarnessRunOptions, true>> = {
  root: true,
  runId: true,
  suite: true,
  steps: true,
  seed: true,
  resume: true,
  gitRevision: true,
  bindingVersions: true,
  reproduction: true,
  signal: true,
  onOutput: true,
  onEvent: true,
  storage: true,
  artifactNamespace: true,
};

export const HARNESS_RUN_OPTION_KEYS: readonly string[] = Object.keys(HARNESS_RUN_OPTION_COVERAGE);

export function validateHarnessRunOptions(options: HarnessRunOptions): void {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new HarnessError("RUN_OPTIONS_INVALID", "run options must be an object.");
  }
  for (const key of Object.keys(options)) {
    if (!HARNESS_RUN_OPTION_KEYS.includes(key)) {
      throw new HarnessError(
        "RUN_OPTIONS_INVALID",
        `unknown run option "${key}"; an ignored option would misreport what the run did.`,
      );
    }
  }
  assertContainedRoot(options.root);
  if (!validateRunId(options.runId)) {
    throw new HarnessError("RUN_ID_INVALID", "run_id must be one safe path component.");
  }
  assertSafeMetadata(options.suite, "SUITE_INVALID", "suite");
  if (!Array.isArray(options.steps) || options.steps.length > MAX_STEPS_PER_RUN) {
    throw new HarnessError(
      "RUN_STEP_LIMIT",
      "harness runs may contain at most the bounded step limit.",
    );
  }
  if (
    options.seed !== undefined &&
    (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff)
  ) {
    throw new HarnessError("SEED_INVALID", "seed must be an unsigned 32-bit integer.");
  }
  if (options.gitRevision !== undefined && !isGitRevision(options.gitRevision)) {
    throw new HarnessError(
      "GIT_REVISION_INVALID",
      "git revision must be a commit hash or unavailable.",
    );
  }
  if (options.reproduction !== undefined && options.reproduction !== "self-test") {
    throw new HarnessError("REPRODUCTION_INVALID", "only registered CLI reproduction is allowed.");
  }
  if (options.artifactNamespace !== undefined && !validateRunId(options.artifactNamespace)) {
    throw new HarnessError(
      "ARTIFACT_NAMESPACE_INVALID",
      "artifact_namespace must be one safe, bounded path component.",
    );
  }
  if (options.reproduction === "self-test" && options.artifactNamespace === undefined) {
    throw new HarnessError(
      "INTEGRATION_NAMESPACE_REQUIRED",
      "a self-test receipt must name its retained integration artifact namespace.",
    );
  }
  if (options.artifactNamespace !== undefined && options.reproduction !== "self-test") {
    throw new HarnessError(
      "ARTIFACT_NAMESPACE_CONTEXT_INVALID",
      "a retained integration artifact namespace is only valid for the registered self-test.",
    );
  }
  validateBindingVersions(options.bindingVersions);
  const seenStepIds = new Set<string>();
  for (const step of options.steps) {
    validateHarnessStep(step);
    if (step.adapter === "d1" && step.command !== undefined) {
      if (options.reproduction !== "self-test" || options.artifactNamespace === undefined) {
        throw new HarnessError(
          "D1_INTEGRATION_CONTEXT_REQUIRED",
          "the real D1 adapter is only executable through the retained self-test integration lane.",
        );
      }
      const stateDirectory = d1StateDirectoryArgument(step.command);
      const declaredNamespace = d1IntegrationNamespaceArgument(step.command);
      if (declaredNamespace !== options.artifactNamespace) {
        throw new HarnessError(
          "D1_INTEGRATION_NAMESPACE_MISMATCH",
          "the real D1 adapter namespace must match this retained self-test receipt.",
        );
      }
      const expectedRunDirectory = join(
        resolve(options.root),
        "e2e",
        "artifacts",
        options.artifactNamespace,
        options.runId,
      );
      const state = assertRetainedD1StateDirectory(options.root, stateDirectory);
      if (
        !isContainedPath(expectedRunDirectory, state) ||
        relative(expectedRunDirectory, state).split(sep).length !== 1
      ) {
        throw new HarnessError(
          "D1_STATE_DIRECTORY_INVALID",
          "the real D1 state directory must belong directly to this retained self-test run id.",
        );
      }
    }
    if (seenStepIds.has(step.id)) {
      throw new HarnessError(
        "STEP_ID_DUPLICATE",
        "step ids must be unique within one harness run.",
      );
    }
    seenStepIds.add(step.id);
  }
}

/** Validate the step contract, including bounded command inputs that can reach a process table. */
export function validateHarnessStep(step: HarnessStep): void {
  if (typeof step !== "object" || step === null || Array.isArray(step)) {
    throw new HarnessError("STEP_SCHEMA_INVALID", "step must be an object.");
  }
  if (!validateStepId(step.id)) {
    throw new HarnessError("STEP_ID_INVALID", "step id must be one safe path component.");
  }
  assertSafeMetadata(step.scenario, "SCENARIO_INVALID", "scenario");
  if (typeof step.replaySafe !== "boolean") {
    throw new HarnessError("REPLAY_SAFETY_INVALID", "replay_safe must be explicit.");
  }
  const adapter = step.adapter ?? "process";
  if (!isHarnessAdapter(adapter)) {
    throw new HarnessError("ADAPTER_INVALID", "adapter must be process, d1, http, or browser.");
  }
  if (adapter === "process") {
    validateCommand(step.command);
  } else if (step.command !== undefined) {
    // A non-process adapter may execute, but only through its own registered
    // probe. The original rule forbade any command so a placeholder could not
    // pretend to run; the same intent now survives as an allowlist, so an
    // adapter label can never be pinned onto an arbitrary process.
    validateCommand(step.command);
    const expected = adapterProbePath(adapter);
    if (step.command[1] !== expected) {
      throw new HarnessError(
        "ADAPTER_COMMAND_FORBIDDEN",
        "an adapter step may only execute its own registered probe.",
      );
    }
    if (adapter === "d1") {
      d1StateDirectoryArgument(step.command);
      d1IntegrationNamespaceArgument(step.command);
    }
  }
  if (!isBoundedInteger(step.retries ?? 0, 0, MAX_RETRIES_PER_STEP)) {
    throw new HarnessError("RETRY_LIMIT", "retries must be a bounded non-negative integer.");
  }
  if (step.timeoutMs !== undefined && !isBoundedInteger(step.timeoutMs, 1, MAX_TIMEOUT_MS)) {
    throw new HarnessError("TIMEOUT_LIMIT", "timeout_ms must be within the fixed harness bound.");
  }
  for (const [field, value] of Object.entries({
    assertion: step.assertion,
    request_id: step.requestId,
    event_id: step.eventId,
  })) {
    if (value !== undefined) assertSafeMetadata(value, "METADATA_INVALID", field);
  }
  if ((step.expected === undefined) !== (step.actual === undefined)) {
    throw new HarnessError("DIFF_INVALID", "expected and actual must be supplied together.");
  }
  if (step.expected !== undefined) assertBoundedInputText(step.expected, "expected");
  if (step.actual !== undefined) assertBoundedInputText(step.actual, "actual");
  if (step.http !== undefined) validateHttpContext(step.http);
}

function d1StateDirectoryArgument(command: readonly string[]): string {
  const modeIndex = command.indexOf("--mode");
  const stateIndex = command.indexOf("--state-dir");
  if (
    modeIndex !== 2 ||
    (command[modeIndex + 1] !== "ok" && command[modeIndex + 1] !== "planted-fail") ||
    stateIndex !== 4 ||
    typeof command[stateIndex + 1] !== "string" ||
    command.length !== 8
  ) {
    throw new HarnessError(
      "D1_STATE_DIRECTORY_REQUIRED",
      "the real D1 adapter requires exactly --mode <ok|planted-fail> --state-dir <retained path> --integration-namespace <safe-component>.",
    );
  }
  return command[stateIndex + 1] as string;
}

function d1IntegrationNamespaceArgument(command: readonly string[]): string {
  const namespaceIndex = command.indexOf("--integration-namespace");
  const namespace = namespaceIndex >= 0 ? command[namespaceIndex + 1] : undefined;
  if (namespaceIndex !== 6 || typeof namespace !== "string" || !validateRunId(namespace)) {
    throw new HarnessError(
      "D1_INTEGRATION_NAMESPACE_REQUIRED",
      "the real D1 adapter requires a safe explicit retained integration namespace.",
    );
  }
  return namespace;
}

/** Runtime schema guard for every JSONL/JUnit-facing event, not only TypeScript callers. */
export function validateHarnessEvent(event: HarnessEvent): void {
  if (typeof event !== "object" || event === null || Array.isArray(event)) {
    throw new HarnessError("EVENT_SCHEMA_INVALID", "event must be an object.");
  }
  if (
    event.schema_version !== HARNESS_SCHEMA_VERSION ||
    !["step", "summary", "self_test"].includes(event.record)
  ) {
    throw new HarnessError("EVENT_SCHEMA_INVALID", "event record is not recognized.");
  }
  if (
    !validateRunId(event.run_id) ||
    !validateStepId(event.step) ||
    !SHA256_HEX.test(event.run_identity_digest)
  ) {
    throw new HarnessError("EVENT_SCHEMA_INVALID", "event identifiers are invalid.");
  }
  for (const [field, value] of Object.entries({
    suite: event.suite,
    scenario: event.scenario,
    code: event.code,
    reproduce: event.reproduce,
    git_revision: event.git_revision,
  })) {
    assertSafeMetadata(value, "EVENT_SCHEMA_INVALID", field);
  }
  if (
    !isBoundedInteger(event.seed, 0, 0xffffffff) ||
    !isBoundedInteger(event.duration_ms, 0, MAX_EVENT_DURATION_MS) ||
    Number.isNaN(Date.parse(event.started_at)) ||
    Number.isNaN(Date.parse(event.finished_at))
  ) {
    throw new HarnessError("EVENT_SCHEMA_INVALID", "event numeric fields are out of bounds.");
  }
  if (
    !isBoundedInteger(event.attempt, 0, MAX_RETRIES_PER_STEP + 1) ||
    !isBoundedInteger(event.retry, 0, MAX_RETRIES_PER_STEP)
  ) {
    throw new HarnessError("EVENT_SCHEMA_INVALID", "event retry fields are out of bounds.");
  }
  if (
    !isStepStatus(event.status) ||
    !isHarnessAdapter(event.adapter) ||
    !isGitRevision(event.git_revision)
  ) {
    throw new HarnessError(
      "EVENT_SCHEMA_INVALID",
      "event status, adapter, or revision is invalid.",
    );
  }
  if (event.storage_authority !== "real-filesystem" && event.storage_authority !== "simulation") {
    throw new HarnessError("EVENT_SCHEMA_INVALID", "event storage authority is invalid.");
  }
  if (!isValidReproduction(event.reproduce)) {
    throw new HarnessError("EVENT_SCHEMA_INVALID", "event reproduction is not truthful.");
  }
  validateEnvironment(event.environment);
  validateNullableHttpContext(event.http_method, event.route_template, event.cursor, event.seq);
  for (const [field, value] of Object.entries({
    request_id: event.request_id,
    event_id: event.event_id,
    assertion: event.assertion,
  })) {
    if (value !== undefined) assertSafeMetadata(value, "EVENT_SCHEMA_INVALID", field);
  }
  if (event.detail !== undefined)
    assertSafeEventText(event.detail, MAX_FAILURE_DETAIL_CHARS, "detail");
  if (event.diff !== undefined && event.diff.length > MAX_DIFF_CHARS) {
    throw new HarnessError("EVENT_SCHEMA_INVALID", "event diff exceeds its fixed bound.");
  }
  if (
    event.output_chars !== undefined &&
    !isBoundedInteger(event.output_chars, 0, MAX_CAPTURED_OUTPUT_CHARS * 2)
  ) {
    throw new HarnessError(
      "EVENT_SCHEMA_INVALID",
      "event output metadata exceeds its fixed bound.",
    );
  }
  if (
    event.argv !== undefined &&
    (!Array.isArray(event.argv) ||
      event.argv.some(
        (argument) => typeof argument !== "string" || argument.length > MAX_COMMAND_ARGUMENT_CHARS,
      ))
  ) {
    throw new HarnessError("EVENT_SCHEMA_INVALID", "event argv metadata exceeds its fixed bound.");
  }
  if (event.output_truncated !== undefined && typeof event.output_truncated !== "boolean") {
    throw new HarnessError("EVENT_SCHEMA_INVALID", "event output truncation metadata is invalid.");
  }
  if (event.exit_code !== undefined && !isBoundedInteger(event.exit_code, -255, 255)) {
    throw new HarnessError("EVENT_SCHEMA_INVALID", "event exit code is out of bounds.");
  }
}

export async function runHarness(options: HarnessRunOptions): Promise<HarnessRunResult> {
  validateHarnessRunOptions(options);
  const storage = options.storage ?? nodeArtifactStorage;
  // `self-test` is a production receipt label. Letting a simulated run emit
  // it would make a branch-coverage fixture indistinguishable from a real CLI
  // result to a reader that only saw the event ledger.
  if (options.reproduction !== undefined) {
    // This is intentionally before ArtifactStore: an opt-in receipt first
    // learns whether it may write, and a full checkout creates neither a
    // retained integration namespace nor an artifact file.
    realFilesystemRetentionPreflight(options.root, storage, options.artifactNamespace);
  }
  const seed = options.seed ?? deterministicSeed(options.suite, options.runId);
  const identity = runIdentityFor(options, seed);
  const store = new ArtifactStore(
    options.root,
    options.runId,
    options.resume === true,
    identity,
    storage,
    options.artifactNamespace,
  );
  let closeWriterLease = true;
  try {
    const output = options.onOutput ?? ((text: string) => process.stderr.write(text));
    const eventSink =
      options.onEvent ??
      ((event: HarnessEvent) => process.stdout.write(`${JSON.stringify(event)}\n`));
    const priorStates =
      options.resume === true ? store.loadResumeStates() : new Map<string, StepStatus>();
    const events: HarnessEvent[] = [];

    const seenStepIds = new Set<string>();
    for (const step of orderSteps(options.steps)) {
      validateHarnessStep(step);
      if (seenStepIds.has(step.id)) {
        throw new HarnessError(
          "STEP_ID_DUPLICATE",
          "step ids must be unique within one harness run.",
        );
      }
      seenStepIds.add(step.id);
      // A non-process adapter is only "unavailable" when nothing can drive it.
      // Once an adapter ships an executable probe, the step runs through the same
      // bounded process path as everything else and keeps its adapter label, so
      // one termination, redaction and retention story covers every adapter.
      if ((step.adapter ?? "process") !== "process" && step.command === undefined) {
        const event = unavailableAdapterEvent(options, step, seed);
        recordEvent(store, events, eventSink, event);
        continue;
      }
      const prior = priorStates.get(step.id);
      if (options.resume === true && prior !== undefined) {
        if (prior === "pass") {
          const event = skippedEvent(
            options,
            step,
            seed,
            "RESUME_ALREADY_COMPLETED",
            "already completed",
          );
          recordEvent(store, events, eventSink, event);
          continue;
        }
        if (!step.replaySafe) {
          const event = skippedEvent(
            options,
            step,
            seed,
            "UNSAFE_REPLAY_WITHHELD",
            "previous incomplete operation is not replay-safe",
            "blocked",
          );
          recordEvent(store, events, eventSink, event);
          continue;
        }
      }

      const retries = step.replaySafe ? (step.retries ?? 0) : 0;
      let finalEvent: HarnessEvent | undefined;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        finalEvent = await runAttempt(options, step, seed, attempt, retries, output);
        if (finalEvent.status !== "pass" && finalEvent.status !== "blocked") {
          const mergedOutput = finalEvent.detail ?? "";
          store.writeFailureLog(step, attempt + 1, mergedOutput);
        }
        recordEvent(store, events, eventSink, finalEvent);
        if (finalEvent.status === "pass" || finalEvent.status === "blocked") break;
      }
    }

    const junit = store.writeJUnit(events);
    const digest = createHash("sha256").update(store.readArtifact(junit), "utf8").digest("hex");
    const finishedAt = new Date().toISOString();
    const summary = summaryEvent(options, seed, events, finishedAt, digest);
    recordEvent(store, events, eventSink, summary);

    const statuses = finalStepEvents(events).map((event) => event.status);
    const exitCode: HarnessRunResult["exitCode"] = statuses.some(
      (status) => status === "fail" || status === "timeout" || status === "cancelled",
    )
      ? 1
      : statuses.some((status) => status === "blocked")
        ? HARNESS_BLOCKED_EXIT_CODE
        : 0;
    return {
      exitCode,
      events,
      artifacts: {
        directory: store.directory,
        jsonl: store.jsonl,
        junit,
        failureLogs: store.failureLogs,
      },
      seed,
      storageAuthority: storageAuthority(storage),
    };
  } catch (error) {
    if (error instanceof UnsettledChildProcessError) closeWriterLease = false;
    throw error;
  } finally {
    if (closeWriterLease) store.close();
  }
}

async function runAttempt(
  options: HarnessRunOptions,
  step: HarnessStep,
  seed: number,
  attempt: number,
  retries: number,
  emitOutput: (text: string) => void,
): Promise<HarnessEvent> {
  const started = new Date();
  const startedAt = performance.now();
  let termination: "timeout" | "cancelled" | undefined;
  const commandLine = step.command;
  if (commandLine === undefined) {
    throw new HarnessError("COMMAND_MISSING", "a process step requires a validated command.");
  }
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn({
      cmd: [...commandLine],
      cwd: resolve(options.root),
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      detached: true,
      env: scrubbedChildEnvironment(),
    });
  } catch (error) {
    const denied =
      (error as NodeJS.ErrnoException | undefined)?.code === "EACCES" ||
      (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
    const finished = new Date();
    return {
      schema_version: HARNESS_SCHEMA_VERSION,
      record: "step",
      run_id: options.runId,
      suite: safeMetadata(options.suite, options.root),
      scenario: safeMetadata(step.scenario, options.root),
      step: step.id,
      seed,
      started_at: started.toISOString(),
      finished_at: finished.toISOString(),
      duration_ms: Math.round(performance.now() - startedAt),
      attempt: attempt + 1,
      retry: retries === 0 ? 0 : attempt,
      replay_safe: step.replaySafe,
      status: "blocked",
      code: denied ? "STEP_SPAWN_DENIED" : "STEP_SPAWN_UNAVAILABLE",
      reproduce: safeReproductionCommand(options.reproduction, options.artifactNamespace),
      argv: safeArgv(commandLine, options.root),
      detail: denied
        ? "Child spawn was denied by the operating system; no raw syscall diagnostic was retained."
        : "Child spawn was unavailable; no raw syscall diagnostic was retained.",
      ...eventContext(options, seed, step),
    };
  }
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  const terminate = (reason: "timeout" | "cancelled") => {
    if (termination !== undefined) return;
    termination = reason;
    killChildGroup(child, "SIGTERM");
    forceKill = setTimeout(() => {
      killChildGroup(child, "SIGKILL");
    }, FORCE_KILL_GRACE_MS);
  };
  const timeout = setTimeout(() => terminate("timeout"), Math.max(1, step.timeoutMs ?? 30_000));
  const abort = () => terminate("cancelled");
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();

  const stdoutPromise = readBounded(child.stdout, MAX_CAPTURED_OUTPUT_CHARS);
  const stderrPromise = readBounded(child.stderr, MAX_CAPTURED_OUTPUT_CHARS);
  const exitPromise = child.exited;
  const exitAndGroupKillPromise = exitPromise.then(
    (code) => {
      signalOwnedProcessGroupOnly(child.pid, "SIGKILL");
      return code;
    },
    (error: unknown) => {
      signalOwnedProcessGroupOnly(child.pid, "SIGKILL");
      throw error;
    },
  );
  let stdout: Awaited<typeof stdoutPromise>;
  let stderr: Awaited<typeof stderrPromise>;
  let exitCode: number;
  try {
    [stdout, stderr, exitCode] = await Promise.all([
      stdoutPromise,
      stderrPromise,
      exitAndGroupKillPromise,
    ]);
  } catch (error) {
    // A pipe/read/exit rejection must not let the caller close its artifact
    // writer lease while this detached process group can still mutate the
    // checkout. Terminate, bound the leader receipt and group proof, then drain
    // both read promises before propagating the infrastructure failure.
    killChildGroup(child, "SIGTERM");
    if (forceKill === undefined) {
      forceKill = setTimeout(() => killChildGroup(child, "SIGKILL"), FORCE_KILL_GRACE_MS);
    }
    const [leaderSettlementProven, groupQuiescent] = await Promise.all([
      proveChildLeaderSettlement(exitPromise),
      killAndProveChildGroupQuiescent(child.pid),
    ]);
    clearTimeout(forceKill);
    forceKill = undefined;
    if (!groupQuiescent) {
      throw new UnsettledChildProcessError();
    }
    await Promise.allSettled([stdoutPromise, stderrPromise]);
    if (!leaderSettlementProven) throw new UnsettledChildProcessError();
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
  if (forceKill !== undefined) {
    clearTimeout(forceKill);
    forceKill = undefined;
  }
  // The leader can exit successfully after spawning a background descendant.
  // A harness step never transfers daemon ownership, so prove the POSIX group
  // is absent before callbacks run and before an outer artifact lease closes.
  if (!(await killAndProveChildGroupQuiescent(child.pid))) {
    throw new UnsettledChildProcessError();
  }

  const visibleOutput = redactNeverLog(`${stdout.text}${stderr.text}`, options.root);
  if (visibleOutput.length > 0) emitOutput(visibleOutput);
  const finished = new Date();
  const duration = Math.round(performance.now() - startedAt);
  const status: StepStatus =
    termination === "timeout"
      ? "timeout"
      : termination === "cancelled"
        ? "cancelled"
        : exitCode === 0
          ? "pass"
          : exitCode === HARNESS_BLOCKED_EXIT_CODE
            ? "blocked"
            : "fail";
  const code =
    status === "pass"
      ? "STEP_PASSED"
      : status === "blocked"
        ? "STEP_BLOCKED"
        : status === "timeout"
          ? "STEP_TIMEOUT"
          : status === "cancelled"
            ? "STEP_CANCELLED"
            : "STEP_FAILED";
  const outputChars = stdout.text.length + stderr.text.length;
  const detail =
    status === "pass"
      ? undefined
      : redactNeverLog(
          clip(
            `${stdout.text.length > 0 ? `stdout:\n${stdout.text}\n` : ""}${stderr.text.length > 0 ? `stderr:\n${stderr.text}` : ""}`,
            MAX_FAILURE_DETAIL_CHARS,
          ),
          options.root,
        );
  return {
    schema_version: HARNESS_SCHEMA_VERSION,
    record: "step",
    run_id: options.runId,
    suite: safeMetadata(options.suite, options.root),
    scenario: safeMetadata(step.scenario, options.root),
    step: step.id,
    seed,
    started_at: started.toISOString(),
    finished_at: finished.toISOString(),
    duration_ms: duration,
    attempt: attempt + 1,
    retry: retries === 0 ? 0 : attempt,
    replay_safe: step.replaySafe,
    status,
    code,
    reproduce: safeReproductionCommand(options.reproduction, options.artifactNamespace),
    argv: safeArgv(commandLine, options.root),
    exit_code: exitCode,
    ...(step.requestId === undefined
      ? {}
      : { request_id: safeMetadata(step.requestId, options.root) }),
    ...(step.eventId === undefined ? {} : { event_id: safeMetadata(step.eventId, options.root) }),
    ...(step.assertion === undefined
      ? {}
      : { assertion: safeMetadata(step.assertion, options.root) }),
    ...(step.expected === undefined || step.actual === undefined
      ? {}
      : { diff: boundedDiff(step.expected, step.actual, options.root) }),
    output_chars: outputChars,
    output_truncated: stdout.truncated || stderr.truncated,
    ...(detail === undefined ? {} : { detail }),
    ...eventContext(options, seed, step),
  };
}

function skippedEvent(
  options: HarnessRunOptions,
  step: HarnessStep,
  seed: number,
  code: string,
  detail: string,
  status: "skipped" | "blocked" = "skipped",
): HarnessEvent {
  const now = new Date().toISOString();
  return {
    schema_version: HARNESS_SCHEMA_VERSION,
    record: "step",
    run_id: options.runId,
    suite: safeMetadata(options.suite, options.root),
    scenario: safeMetadata(step.scenario, options.root),
    step: step.id,
    seed,
    started_at: now,
    finished_at: now,
    duration_ms: 0,
    attempt: 0,
    retry: 0,
    replay_safe: step.replaySafe,
    status,
    code,
    reproduce: safeReproductionCommand(options.reproduction, options.artifactNamespace),
    detail,
    ...eventContext(options, seed, step),
  };
}

function summaryEvent(
  options: HarnessRunOptions,
  seed: number,
  events: readonly HarnessEvent[],
  finishedAt: string,
  junitDigest: string,
): HarnessEvent {
  const steps = finalStepEvents(events);
  const hasFailure = steps.some(
    (event) =>
      event.status === "fail" || event.status === "timeout" || event.status === "cancelled",
  );
  const hasBlocked = steps.some((event) => event.status === "blocked");
  return {
    schema_version: HARNESS_SCHEMA_VERSION,
    record: "summary",
    run_id: options.runId,
    suite: safeMetadata(options.suite, options.root),
    scenario: "run",
    step: "summary",
    seed,
    started_at: finishedAt,
    finished_at: finishedAt,
    duration_ms: steps.reduce((total, event) => total + event.duration_ms, 0),
    attempt: 1,
    retry: 0,
    replay_safe: true,
    status: hasFailure ? "fail" : hasBlocked ? "blocked" : "pass",
    code: hasFailure ? "RUN_FAILED" : hasBlocked ? "RUN_BLOCKED" : "RUN_PASSED",
    reproduce: safeReproductionCommand(options.reproduction, options.artifactNamespace),
    artifact_digest: junitDigest,
    detail:
      "Harness output is redacted and bounded; a passing harness run is not product correctness.",
    ...eventContext(options, seed),
  };
}

function recordEvent(
  store: ArtifactStore,
  events: HarnessEvent[],
  sink: (event: HarnessEvent) => void,
  event: HarnessEvent,
): void {
  validateHarnessEvent(event);
  store.append(event);
  events.push(event);
  sink(event);
}

function unavailableAdapterEvent(
  options: HarnessRunOptions,
  step: HarnessStep,
  seed: number,
): HarnessEvent {
  const now = new Date().toISOString();
  const adapter = step.adapter ?? "process";
  return {
    schema_version: HARNESS_SCHEMA_VERSION,
    record: "step",
    run_id: options.runId,
    suite: safeMetadata(options.suite, options.root),
    scenario: safeMetadata(step.scenario, options.root),
    step: step.id,
    seed,
    started_at: now,
    finished_at: now,
    duration_ms: 0,
    attempt: 0,
    retry: 0,
    replay_safe: step.replaySafe,
    status: "blocked",
    code: "ADAPTER_UNAVAILABLE",
    reproduce: safeReproductionCommand(options.reproduction, options.artifactNamespace),
    detail: `${adapter} adapter is not registered in OPS.2a; no ${adapter} behavior was exercised.`,
    ...eventContext(options, seed, step),
  };
}

function eventContext(
  options: HarnessRunOptions,
  seed: number,
  step?: HarnessStep,
): Pick<
  HarnessEvent,
  | "storage_authority"
  | "run_identity_digest"
  | "adapter"
  | "git_revision"
  | "environment"
  | "http_method"
  | "route_template"
  | "cursor"
  | "seq"
> {
  const http = step?.http;
  return {
    storage_authority: storageAuthority(options.storage ?? nodeArtifactStorage),
    run_identity_digest: runIdentityDigest(runIdentityFor(options, seed)),
    adapter: step?.adapter ?? "process",
    git_revision: options.gitRevision ?? "unavailable",
    environment: {
      runtime: "bun",
      runtime_version: Bun.version,
      platform: process.platform,
      binding_versions: orderedBindingVersions(options.bindingVersions),
    },
    http_method: http?.method ?? null,
    route_template: http?.routeTemplate ?? null,
    cursor: http?.cursor ?? null,
    seq: http?.seq ?? null,
  };
}

function scrubbedChildEnvironment(): Record<string, string> {
  // Do not inherit process.env: any unlabelled value might be sensitive. These fixed values
  // are sufficient for absolute executables and the standard system command search path.
  return process.platform === "win32"
    ? { PATH: "C:\\Windows\\System32", LANG: "C", TZ: "UTC" }
    : { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC" };
}

function killChildGroup(
  child: { pid: number; kill(signal?: string | number): void },
  signal: string,
): void {
  if (process.platform === "win32") {
    try {
      child.kill(signal);
    } catch {
      // Exit between a timeout tick and signal delivery is an expected race.
    }
    return;
  }
  // Bun detached=true calls setsid() on POSIX, making the leader PID its
  // process-group ID. Never fall back to a positive PID: after leader exit it
  // may already identify an unrelated process.
  signalOwnedProcessGroupOnly(child.pid, signal);
}

type ProcessGroupProbe = "absent" | "present" | "unknown";

/** Signal only the detached POSIX group; never fall back to a reused leader PID. */
function signalOwnedProcessGroupOnly(
  processGroupId: number,
  signal: string | number,
): ProcessGroupProbe {
  if (process.platform === "win32") return "unknown";
  try {
    process.kill(-processGroupId, signal);
    return "present";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "absent" : "unknown";
  }
}

/** Probe only the detached POSIX group; never fall back to a possibly reused leader PID. */
function probeOwnedProcessGroup(processGroupId: number): ProcessGroupProbe {
  return signalOwnedProcessGroupOnly(processGroupId, 0);
}

/**
 * Kill the owned POSIX process group and prove it reached ESRCH.
 *
 * A signal delivery alone proves neither descendant exit nor reaping. Windows
 * has no equivalent group probe in this adapter, so it returns false and the
 * caller retains the writer lease rather than making a false quiescence claim.
 */
async function killAndProveChildGroupQuiescent(processGroupId: number): Promise<boolean> {
  if (process.platform === "win32") return false;
  const initial = probeOwnedProcessGroup(processGroupId);
  if (initial === "absent") return true;
  if (initial === "unknown") return false;
  const signalled = signalOwnedProcessGroupOnly(processGroupId, "SIGKILL");
  if (signalled === "absent") return true;
  if (signalled === "unknown") return false;
  const deadline = performance.now() + HARD_READER_GRACE_MS;
  while (performance.now() < deadline) {
    const state = probeOwnedProcessGroup(processGroupId);
    if (state === "absent") return true;
    if (state === "unknown") return false;
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  return probeOwnedProcessGroup(processGroupId) === "absent";
}

/**
 * Bound the runtime settlement receipt independently of OS process-group proof.
 * A rejected or late `child.exited` promise cannot justify closing the writer
 * lease, but it must not prevent the bounded group kill/probe from completing.
 */
async function proveChildLeaderSettlement(exitPromise: Promise<number>): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exitPromise.then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout(false), HARD_READER_GRACE_MS);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function junitXml(events: readonly HarnessEvent[]): string {
  const steps = finalStepEvents(events);
  const failures = steps.filter(
    (event) =>
      event.status === "fail" || event.status === "timeout" || event.status === "cancelled",
  );
  const blocked = steps.filter((event) => event.status === "blocked");
  const body = steps
    .map((event) => {
      const attributes = `classname="${xml(event.scenario)}" name="${xml(event.step)}" time="${(event.duration_ms / 1000).toFixed(3)}"`;
      if (event.status === "pass" || event.status === "skipped")
        return `  <testcase ${attributes}/>`;
      if (event.status === "blocked") {
        return `  <testcase ${attributes}><skipped message="${xml(event.code)}">${xml(event.detail ?? "")}</skipped></testcase>`;
      }
      return `  <testcase ${attributes}><failure message="${xml(event.code)}">${xml(event.detail ?? "")}</failure></testcase>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="asimposium-harness" tests="${steps.length}" failures="${failures.length}" skipped="${blocked.length}">\n${body}\n</testsuite>\n`;
}

/** Intermediate retry failures remain in JSONL for diagnosis, but only the last attempt decides a run. */
function finalStepEvents(events: readonly HarnessEvent[]): HarnessEvent[] {
  const final = new Map<string, HarnessEvent>();
  for (const event of events) {
    if (event.record === "step") final.set(event.step, event);
  }
  return [...final.values()];
}

function xml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => XML_ESCAPE[character] ?? character);
}

function clip(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 15))}\n…<truncated>`;
}

function commonPrefix(left: string, right: string): string {
  let index = 0;
  const bound = Math.min(left.length, right.length);
  while (index < bound && left[index] === right[index]) index += 1;
  return left.slice(0, index);
}

/**
 * A command line can itself embed a request body or a token. The executable name is enough
 * to identify the tool; every argument is intentionally withheld from JSONL and artifacts.
 */
function safeArgv(commandLine: readonly string[], root: string): string[] {
  return commandLine.map((argument, index) =>
    index === 0 ? redactNeverLog(basename(argument), root) : "<redacted-argument>",
  );
}

function safeMetadata(value: string, root: string): string {
  return clip(redactNeverLog(value, root), MAX_METADATA_CHARS);
}

function validateCommand(command: readonly string[] | undefined): void {
  if (!Array.isArray(command) || command.length === 0 || command.length > MAX_COMMAND_ARGUMENTS) {
    throw new HarnessError("COMMAND_LIMIT", "command must have a bounded non-empty argv.");
  }
  const totalLength = command.reduce((total, argument) => total + argument.length, 0);
  if (totalLength > MAX_COMMAND_CHARS) {
    throw new HarnessError("COMMAND_LIMIT", "command exceeds the fixed argv character bound.");
  }
  for (const argument of command) {
    if (
      typeof argument !== "string" ||
      argument.length === 0 ||
      argument.length > MAX_COMMAND_ARGUMENT_CHARS
    ) {
      throw new HarnessError(
        "COMMAND_LIMIT",
        "each command argument must be a bounded non-empty string.",
      );
    }
    if (containsForbiddenCommandSecret(argument)) {
      throw new HarnessError(
        "COMMAND_SECRET_FORBIDDEN",
        "secret-bearing argv is forbidden because process tables are not redactable.",
      );
    }
  }
}

function containsForbiddenCommandSecret(value: string): boolean {
  return containsCredentialShape(value) || /\b[A-Za-z0-9]{32,}\b/.test(value);
}

function assertSafeMetadata(value: unknown, code: string, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_METADATA_CHARS) {
    throw new HarnessError(code, `${field} must be a bounded non-empty string.`);
  }
  if (/\p{Cc}/u.test(value) || containsForbiddenCommandSecret(value)) {
    throw new HarnessError(code, `${field} contains unsafe metadata.`);
  }
}

function assertSafeEventText(
  value: unknown,
  maximum: number,
  field: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    containsForbiddenCommandSecret(value)
  ) {
    throw new HarnessError(
      "EVENT_SCHEMA_INVALID",
      `${field} is unsafe or exceeds its fixed bound.`,
    );
  }
}

function assertBoundedInputText(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length > MAX_DIFF_INPUT_CHARS) {
    throw new HarnessError("DIFF_INPUT_LIMIT", `${field} exceeds the fixed diff-input bound.`);
  }
}

function validateBindingVersions(bindingVersions: unknown): void {
  if (bindingVersions === undefined) return;
  if (
    typeof bindingVersions !== "object" ||
    bindingVersions === null ||
    Array.isArray(bindingVersions)
  ) {
    throw new HarnessError("BINDING_VERSION_INVALID", "binding versions must be an object.");
  }
  const entries = Object.entries(bindingVersions);
  if (entries.length > 16) {
    throw new HarnessError(
      "BINDING_VERSION_LIMIT",
      "binding version metadata has a fixed entry limit.",
    );
  }
  for (const [key, value] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) {
      throw new HarnessError("BINDING_VERSION_INVALID", "binding version key is invalid.");
    }
    assertSafeMetadata(value, "BINDING_VERSION_INVALID", "binding version");
  }
}

function orderedBindingVersions(
  bindingVersions: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(bindingVersions ?? {}).sort(([left], [right]) => asciiCompare(left, right)),
  );
}

function validateHttpContext(http: HttpContext): void {
  if (typeof http !== "object" || http === null || Array.isArray(http)) {
    throw new HarnessError("HTTP_CONTEXT_INVALID", "HTTP context must be an object.");
  }
  if (!/^[A-Z]{3,10}$/.test(http.method)) {
    throw new HarnessError("HTTP_CONTEXT_INVALID", "HTTP method must be an uppercase token.");
  }
  if (
    http.routeTemplate.length === 0 ||
    http.routeTemplate.length > MAX_ROUTE_TEMPLATE_CHARS ||
    !http.routeTemplate.startsWith("/") ||
    /[?#\s]/.test(http.routeTemplate)
  ) {
    throw new HarnessError(
      "HTTP_CONTEXT_INVALID",
      "route template must be a bounded path without query data.",
    );
  }
  if (http.cursor !== undefined && !isBoundedInteger(http.cursor, 0, Number.MAX_SAFE_INTEGER)) {
    throw new HarnessError("HTTP_CONTEXT_INVALID", "cursor must be a non-negative integer.");
  }
  if (http.seq !== undefined && !isBoundedInteger(http.seq, 0, Number.MAX_SAFE_INTEGER)) {
    throw new HarnessError("HTTP_CONTEXT_INVALID", "seq must be a non-negative integer.");
  }
}

function validateNullableHttpContext(
  method: string | null,
  routeTemplate: string | null,
  cursor: number | null,
  seq: number | null,
): void {
  if (
    (method !== null && typeof method !== "string") ||
    (routeTemplate !== null && typeof routeTemplate !== "string") ||
    (cursor !== null && typeof cursor !== "number") ||
    (seq !== null && typeof seq !== "number")
  ) {
    throw new HarnessError("EVENT_SCHEMA_INVALID", "event HTTP context has invalid field types.");
  }
  if ((method === null) !== (routeTemplate === null)) {
    throw new HarnessError(
      "EVENT_SCHEMA_INVALID",
      "HTTP method and route template must appear together.",
    );
  }
  if (method !== null && routeTemplate !== null)
    validateHttpContext({
      method,
      routeTemplate,
      cursor: cursor ?? undefined,
      seq: seq ?? undefined,
    });
  if (cursor !== null && !isBoundedInteger(cursor, 0, Number.MAX_SAFE_INTEGER)) {
    throw new HarnessError("EVENT_SCHEMA_INVALID", "event cursor is invalid.");
  }
  if (seq !== null && !isBoundedInteger(seq, 0, Number.MAX_SAFE_INTEGER)) {
    throw new HarnessError("EVENT_SCHEMA_INVALID", "event seq is invalid.");
  }
}

function validateEnvironment(environment: HarnessEvent["environment"]): void {
  if (typeof environment !== "object" || environment === null || Array.isArray(environment)) {
    throw new HarnessError("EVENT_SCHEMA_INVALID", "event environment must be an object.");
  }
  if (
    environment.runtime !== "bun" ||
    !/^\d+\.\d+\.\d+/.test(environment.runtime_version) ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(environment.platform)
  ) {
    throw new HarnessError("EVENT_SCHEMA_INVALID", "event environment is invalid.");
  }
  validateBindingVersions(environment.binding_versions);
}

function isGitRevision(value: string): boolean {
  return value === "unavailable" || /^[0-9a-f]{7,64}$/i.test(value);
}

function isValidReproduction(value: string): boolean {
  if (value === "unavailable: no registered CLI scenario") return true;
  const match =
    /^scripts\/e2e-test-harness\.sh --self-test --integration-namespace ([A-Za-z0-9][A-Za-z0-9._-]{0,79})$/.exec(
      value,
    );
  return match !== null && validateRunId(match[1] ?? "");
}

function isHarnessAdapter(value: unknown): value is HarnessAdapter {
  return ["process", "d1", "http", "browser"].includes(String(value));
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
  );
}

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isStepStatus(value: unknown): value is StepStatus {
  return ["pass", "fail", "blocked", "timeout", "cancelled", "skipped"].includes(String(value));
}

function isOutside(root: string, target: string): boolean {
  const relation = relative(root, target);
  return relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation);
}

/**
 * Count the artifact namespaces already present under `<root>/e2e/artifacts`.
 *
 * Both run directories and fixture scratch directories count. Scratch is
 * deliberately included: if it were exempt, a test could mint unbounded
 * directories through the exempt path and the backstop would guard nothing.
 * The reserved blob store is excluded because it is one directory whose
 * contents are content-addressed and deduplicated, not a per-run namespace.
 */
export interface PublishFailureBlobInput {
  /** Path everything must resolve inside. */
  readonly containmentRoot: string;
  /** `<root>/e2e/artifacts`. */
  readonly artifactsDirectory: string;
  readonly digest: string;
  readonly stored: string;
  /** Distinguishes staging names within one process. */
  readonly attempt: number;
  /** Defaults to the real filesystem. */
  readonly storage?: HarnessArtifactStorage;
  /** Top-level `<root>/e2e/artifacts`; defaults to `artifactsDirectory`. */
  readonly artifactRootDirectory?: string;
  /**
   * Device/inode identity captured by the owning run.
   *
   * Direct atomic-publication probes may omit it and bind to the root they
   * observe at call entry. ArtifactStore always supplies its earlier claim so
   * a root swapped between run creation and blob publication is refused.
   */
  readonly expectedArtifactRootIdentity?: string;
  /**
   * The bounded retained integration parent when this is real proof.
   *
   * Ordinary memory tests intentionally omit it. Opt-in direct filesystem
   * probes supply it so blob staging and bytes are part of the same recursive
   * cap as run ids and fixture cases.
   */
  readonly retainedIntegrationDirectory?: string;
  /** Deterministic test seam for the exact EEXIST window; never an authority capability. */
  readonly beforeLink?: (path: string) => void;
}

/**
 * Publish one blob atomically, without deleting, overwriting, or moving.
 *
 * Bytes are assembled under a staging name and then `link`ed into the store.
 * `link` is the primitive that makes all three properties hold at once: it is
 * atomic, so a reader never observes a half-written blob; it refuses when the
 * target exists, so a divergent blob is never silently replaced the way
 * `rename` would replace it; and it publishes a *second name for the same
 * inode* rather than relocating the first, so nothing is moved.
 *
 * The staging entry is therefore retained rather than cleaned up — and
 * retaining it costs no data, because after the link both names refer to one
 * inode holding one copy of the bytes. Staging is bounded by construction: a
 * blob that already exists returns before any staging file is created, so at
 * most one entry appears per *distinct* blob first published here, plus one per
 * lost publication race. `countBlobStagingArtifacts` makes that number
 * observable instead of a matter of trust.
 *
 * Exported because `runHarness` refuses any root that is not this checkout, so
 * a test that could only reach publication through a full run would have to
 * write into the repository's own artifact area to exercise it.
 */
export function publishFailureBlob(input: PublishFailureBlobInput): string {
  const storage = input.storage ?? nodeArtifactStorage;
  if (!SHA256_HEX.test(input.digest)) {
    throw new HarnessError("ARTIFACT_PATH_UNSAFE", "a blob name must be a sha256 hex digest.");
  }
  /**
   * The digest must describe the bytes, checked here rather than trusted.
   *
   * A caller that computed the digest before clipping — or from a different
   * buffer entirely — would otherwise publish content under a name that does
   * not address it, and every later reader would compare the wrong bytes and
   * report `ARTIFACT_BLOB_MISMATCH` against a store that is behaving exactly as
   * told. Content-addressing that does not verify its own address is a naming
   * convention, not an integrity property.
   */
  const actual = createHash("sha256").update(input.stored, "utf8").digest("hex");
  if (actual !== input.digest) {
    throw new HarnessError(
      "ARTIFACT_BLOB_DIGEST_MISMATCH",
      "the supplied digest does not address the bytes being published.",
    );
  }
  /**
   * Containment is proved before anything is created.
   *
   * `blobStoreDirectory` calls `ensureDirectDirectory`, which *makes*
   * directories. Running it first meant an `artifactsDirectory` outside the
   * containment root had already had `blobs/sha256` created inside it by the
   * time the check ran — the check reported the violation after committing it.
   * AGENTS.md is explicit that artifact roots stay under the repository, so the
   * canonical path is resolved and tested while it is still only a string.
   */
  const artifactsDirectory = realDirectory(
    resolve(input.artifactsDirectory),
    "ARTIFACT_PATH_UNSAFE",
    storage,
  );
  const containmentRoot = realDirectory(
    resolve(input.containmentRoot),
    "ARTIFACT_PATH_UNSAFE",
    storage,
  );
  assertContained(containmentRoot, artifactsDirectory, "ARTIFACT_PATH_UNSAFE");
  let retainedIntegrationDirectory: string | undefined;
  if (input.retainedIntegrationDirectory !== undefined) {
    retainedIntegrationDirectory = realDirectory(
      resolve(input.retainedIntegrationDirectory),
      "ARTIFACT_PATH_UNSAFE",
      storage,
    );
    // A full run uses the checkout as its containment root and the retained
    // integration below it. Direct filesystem publication probes invert those
    // two levels: their case root is below the retained integration. Requiring
    // the retained parent to sit below the byte-containment root made every
    // direct real-filesystem publication probe fail before it could publish.
    // The artifact directory must be inside both boundaries; that is the
    // shared containment property for the two valid shapes.
    assertContained(retainedIntegrationDirectory, artifactsDirectory, "ARTIFACT_PATH_UNSAFE");
  }
  // Direct real-filesystem publication fixtures use a case directory as their
  // byte-containment root, but that case lives below the checkout's retained
  // integration namespace. Derive the shared writer boundary from that parent
  // so those writers observe the same global fence and root epoch as a run.
  const writerRoot = realDirectory(
    retainedIntegrationDirectory === undefined
      ? containmentRoot
      : resolve(retainedIntegrationDirectory, "..", "..", ".."),
    "ARTIFACT_PATH_UNSAFE",
    storage,
  );
  const artifactRootDirectory = realDirectory(
    resolve(
      input.artifactRootDirectory ??
        (retainedIntegrationDirectory === undefined
          ? input.artifactsDirectory
          : join(retainedIntegrationDirectory, "..")),
    ),
    "ARTIFACT_PATH_UNSAFE",
    storage,
  );
  assertContained(artifactRootDirectory, artifactsDirectory, "ARTIFACT_PATH_UNSAFE");
  const expectedArtifactRootIdentity =
    input.expectedArtifactRootIdentity ?? storage.directoryIdentity(artifactRootDirectory);
  const assertWriterBoundary = (): void =>
    assertArtifactWriterBoundary(
      writerRoot,
      artifactRootDirectory,
      expectedArtifactRootIdentity,
      storage,
    );
  assertWriterBoundary();

  // Deduplication is a read-only operation and remains valid at the retention
  // ceiling. Checking capacity first made a resume fail even when the exact
  // content-addressed blob was already present and no staging name, directory,
  // or byte would be added.
  const existing = existingFailureBlobPath(
    containmentRoot,
    artifactsDirectory,
    input.digest,
    storage,
  );
  if (existing !== undefined) {
    assertBlobAgrees(existing, input.stored, storage);
    return existing;
  }

  if (retainedIntegrationDirectory !== undefined) {
    // The completed blob and retained staging name both count in a recursive
    // census, and publication may need blobs/sha256/incoming the first time.
    assertRetainedIntegrationCapacity(
      retainedIntegrationDirectory,
      {
        additionalBytes: Buffer.byteLength(input.stored, "utf8") * 2,
        additionalDirectories: 3,
      },
      storage,
    );
  }

  assertWriterBoundary();
  const store = blobStoreDirectory(artifactsDirectory, storage);
  const path = join(store, input.digest);
  assertContained(containmentRoot, path, "ARTIFACT_PATH_UNSAFE");
  assertRegularOrAbsent(path, "ARTIFACT_PATH_UNSAFE", storage);
  if (storage.exists(path)) {
    assertBlobAgrees(path, input.stored, storage);
    return path;
  }
  const staging = join(
    ensureDirectDirectory(store, ARTIFACT_BLOB_STAGING_DIRECTORY, storage),
    `${input.digest}.${process.pid}.${input.attempt}`,
  );
  assertContained(containmentRoot, staging, "ARTIFACT_PATH_UNSAFE");
  assertRegularOrAbsent(staging, "ARTIFACT_PATH_UNSAFE", storage);
  assertWriterBoundary();
  storage.writeExclusive(staging, input.stored);
  // The contended window: this publisher has seen no blob and is about to claim
  // the name. A test hooks here to let another publisher win first.
  input.beforeLink?.(path);
  assertWriterBoundary();
  try {
    storage.link(staging, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // A concurrent writer published first. Benign when the bytes agree; the
    // staging entry stays as the retained record that the race happened.
    assertBlobAgrees(path, input.stored, storage);
  }
  return path;
}

/** Locate an existing blob without creating any part of its directory tree. */
function existingFailureBlobPath(
  containmentRoot: string,
  artifactsDirectory: string,
  digest: string,
  storage: HarnessArtifactStorage,
): string | undefined {
  let parent = artifactsDirectory;
  for (const component of [ARTIFACT_BLOB_DIRECTORY, "sha256"] as const) {
    const candidate = join(parent, component);
    assertContained(containmentRoot, candidate, "ARTIFACT_PATH_UNSAFE");
    if (!storage.exists(candidate) && !storage.isSymlink(candidate)) return undefined;
    const physical = realDirectory(candidate, "ARTIFACT_PATH_UNSAFE", storage);
    assertContained(parent, physical, "ARTIFACT_PATH_UNSAFE");
    parent = physical;
  }
  const path = join(parent, digest);
  assertContained(containmentRoot, path, "ARTIFACT_PATH_UNSAFE");
  assertRegularOrAbsent(path, "ARTIFACT_PATH_UNSAFE", storage);
  return storage.exists(path) ? path : undefined;
}

function assertBlobAgrees(
  path: string,
  stored: string,
  storage: HarnessArtifactStorage = nodeArtifactStorage,
): void {
  if (storage.readFile(path) !== stored) {
    throw new HarnessError(
      "ARTIFACT_BLOB_MISMATCH",
      "a stored blob does not match its digest; retained evidence was left untouched.",
    );
  }
}

/** `<artifacts>/blobs/sha256`, created on demand. */
function blobStoreDirectory(
  artifactsDirectory: string,
  storage: HarnessArtifactStorage = nodeArtifactStorage,
): string {
  return ensureDirectDirectory(
    ensureDirectDirectory(artifactsDirectory, ARTIFACT_BLOB_DIRECTORY, storage),
    "sha256",
    storage,
  );
}

/**
 * How many staging entries the blob store retains.
 *
 * Nothing here removes them, so the number is part of the store's contract
 * rather than an implementation detail: it should track the count of distinct
 * blobs first published by this checkout, and grow only on a lost race.
 */
export function countBlobStagingArtifacts(
  root: string,
  storage: HarnessArtifactStorage = nodeArtifactStorage,
): number {
  const staging = join(
    resolve(root),
    "e2e",
    "artifacts",
    ARTIFACT_BLOB_DIRECTORY,
    "sha256",
    ARTIFACT_BLOB_STAGING_DIRECTORY,
  );
  if (!storage.exists(staging)) return 0;
  return storage.readdir(staging).filter((entry) => storage.isFile(join(staging, entry))).length;
}

export interface RunIdentity {
  readonly runId: string;
  readonly suite: string;
  readonly seed: number;
  /** Ordered step ids. Order is part of the identity: the seed derives from it. */
  readonly stepIds: readonly string[];
  /** SHA-256 of each complete, validated step contract in execution order. */
  readonly stepContractDigests: readonly string[];
  /** Receipt semantics affect what the evidence asserts and are therefore immutable. */
  readonly reproduction: string;
  readonly artifactNamespace: string | null;
  readonly gitRevision: string;
  /** The exact fixed environment contract used for every child process. */
  readonly childEnvironmentDigest: string;
  readonly bindingVersions: Readonly<Record<string, string>>;
}

/** The identity digest, so a comparison is one value rather than many mutable fields. */
export function runIdentityDigest(identity: RunIdentity): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        run_id: identity.runId,
        suite: identity.suite,
        seed: identity.seed,
        step_ids: identity.stepIds,
        step_contract_digests: identity.stepContractDigests,
        reproduction: identity.reproduction,
        artifact_namespace: identity.artifactNamespace,
        git_revision: identity.gitRevision,
        child_environment_digest: identity.childEnvironmentDigest,
        binding_versions: orderedBindingVersions(identity.bindingVersions),
      }),
      "utf8",
    )
    .digest("hex");
}

/**
 * Build the exact plan an event ledger is allowed to describe.
 *
 * Step ids alone are not an identity: reusing `promote` with a different
 * executable, replay policy, assertion, or request context would otherwise
 * append incompatible work to the old ledger. The contracts are hashed so the
 * retained identity is compact and does not duplicate argv or other metadata.
 */
function runIdentityFor(options: HarnessRunOptions, seed: number): RunIdentity {
  const steps = orderSteps(options.steps);
  return {
    runId: options.runId,
    suite: options.suite,
    seed,
    stepIds: steps.map((step) => step.id),
    stepContractDigests: steps.map(stepContractDigest),
    reproduction: safeReproductionCommand(options.reproduction, options.artifactNamespace),
    artifactNamespace: options.artifactNamespace ?? null,
    gitRevision: options.gitRevision ?? "unavailable",
    childEnvironmentDigest: environmentContractDigest(),
    bindingVersions: orderedBindingVersions(options.bindingVersions),
  };
}

/**
 * Children receive no ambient environment. Hash the fixed allowlist into the
 * run identity so a change to that contract cannot silently resume old work.
 */
function environmentContractDigest(): string {
  return createHash("sha256")
    .update(JSON.stringify(orderedBindingVersions(scrubbedChildEnvironment())), "utf8")
    .digest("hex");
}

function stepContractDigest(step: HarnessStep): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: step.id,
        scenario: step.scenario,
        adapter: step.adapter ?? "process",
        command: step.command ?? null,
        replay_safe: step.replaySafe,
        retries: step.retries ?? 0,
        timeout_ms: step.timeoutMs ?? 30_000,
        expected: step.expected ?? null,
        actual: step.actual ?? null,
        assertion: step.assertion ?? null,
        request_id: step.requestId ?? null,
        event_id: step.eventId ?? null,
        http: step.http ?? null,
      }),
      "utf8",
    )
    .digest("hex");
}

/**
 * Write the run's identity on first creation; verify it on resume.
 *
 * A resume is a continuation, not a fresh start with a familiar name. If the
 * suite, seed, or step set changed, the events already on disk describe work
 * that this invocation is not doing, and appending to them produces one ledger
 * that misreports both halves. Refusing is the only honest option: nothing here
 * may rewrite or remove the earlier evidence to make it agree.
 */
export function reconcileRunIdentity(
  path: string,
  identity: RunIdentity,
  resuming: boolean,
  storage: HarnessArtifactStorage = nodeArtifactStorage,
): void {
  const digest = runIdentityDigest(identity);
  const body = `${JSON.stringify({
    schema_version: HARNESS_SCHEMA_VERSION,
    record: "run_identity",
    run_id: identity.runId,
    suite: identity.suite,
    seed: identity.seed,
    step_ids: identity.stepIds,
    step_contract_digests: identity.stepContractDigests,
    reproduction: identity.reproduction,
    artifact_namespace: identity.artifactNamespace,
    git_revision: identity.gitRevision,
    child_environment_digest: identity.childEnvironmentDigest,
    binding_versions: orderedBindingVersions(identity.bindingVersions),
    identity_digest: digest,
  })}\n`;

  if (!storage.exists(path)) {
    if (resuming) {
      throw new HarnessError(
        "RUN_IDENTITY_MISSING",
        "the retained run has no identity record; refusing to append unverifiable resume evidence.",
      );
    }
    storage.writeExclusive(path, body);
    return;
  }
  let recorded: Record<string, unknown>;
  try {
    recorded = JSON.parse(storage.readFile(path)) as typeof recorded;
  } catch {
    throw new HarnessError(
      "RUN_IDENTITY_UNREADABLE",
      "the run identity record is unreadable; refusing to resume against evidence that cannot be matched.",
    );
  }
  const recordedIdentity = parseRunIdentityRecord(recorded);
  const recordShapeValid =
    recorded.schema_version === HARNESS_SCHEMA_VERSION &&
    recorded.record === "run_identity" &&
    recordedIdentity !== undefined &&
    recordedIdentity.runId === identity.runId &&
    recorded.identity_digest === runIdentityDigest(recordedIdentity);
  if (!recordShapeValid || recorded.identity_digest !== digest) {
    throw new HarnessError(
      "RUN_IDENTITY_MISMATCH",
      resuming
        ? "this resume changes its bound plan or cannot verify the recorded plan; the retained evidence describes a different run."
        : "an artifact namespace already records a different run identity.",
    );
  }
}

/** Strictly decode the entire identity record before trusting its digest. */
function parseRunIdentityRecord(recorded: Record<string, unknown>): RunIdentity | undefined {
  const stepIds = recorded.step_ids;
  const stepContractDigests = recorded.step_contract_digests;
  const bindingVersions = recorded.binding_versions;
  if (
    typeof recorded.run_id !== "string" ||
    !validateRunId(recorded.run_id) ||
    typeof recorded.suite !== "string" ||
    !Number.isInteger(recorded.seed) ||
    (recorded.seed as number) < 0 ||
    (recorded.seed as number) > 0xffffffff ||
    !Array.isArray(stepIds) ||
    !stepIds.every((value) => typeof value === "string" && validateStepId(value)) ||
    !Array.isArray(stepContractDigests) ||
    !stepContractDigests.every((value) => typeof value === "string" && SHA256_HEX.test(value)) ||
    stepIds.length !== stepContractDigests.length ||
    typeof recorded.reproduction !== "string" ||
    (recorded.artifact_namespace !== null &&
      (typeof recorded.artifact_namespace !== "string" ||
        !validateRunId(recorded.artifact_namespace))) ||
    typeof recorded.git_revision !== "string" ||
    typeof recorded.child_environment_digest !== "string" ||
    !SHA256_HEX.test(recorded.child_environment_digest) ||
    typeof bindingVersions !== "object" ||
    bindingVersions === null ||
    Array.isArray(bindingVersions)
  ) {
    return undefined;
  }
  const typedBindings: Record<string, string> = {};
  for (const [key, value] of Object.entries(bindingVersions)) {
    if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) return undefined;
    typedBindings[key] = value;
  }
  try {
    validateBindingVersions(typedBindings);
  } catch {
    return undefined;
  }
  return {
    runId: recorded.run_id,
    suite: recorded.suite,
    // Narrowed by the strict integer/range gate above; TypeScript does not
    // retain that refinement through Record<string, unknown> indexing.
    seed: recorded.seed as number,
    stepIds,
    stepContractDigests,
    reproduction: recorded.reproduction,
    artifactNamespace: recorded.artifact_namespace,
    gitRevision: recorded.git_revision,
    childEnvironmentDigest: recorded.child_environment_digest,
    bindingVersions: orderedBindingVersions(typedBindings),
  };
}

export interface FailureManifestReconciliation {
  /**
   * Slots spent: one per publication *attempt*, successful or not.
   *
   * Keyed by `(step, attempt)`, not by digest. Counting distinct digests made
   * two different steps that happened to emit identical bytes cost one slot
   * between them, so a run could exceed its per-run ceiling simply by failing
   * repetitively — which is the common case, not an exotic one.
   */
  readonly attemptCount: number;
  /** Digests whose blob is present in the store. */
  readonly stored: readonly string[];
  /** Digests an intent claimed whose blob never arrived. */
  readonly dangling: readonly string[];
  /**
   * `step attempt` keys whose intent was never followed by a completion.
   *
   * Distinct from `dangling`: the blob may well be present, published by
   * another run producing identical bytes, while *this* run died before it
   * could record that it had finished.
   */
  readonly unfinishedAttempts: readonly string[];
}

/** One publication attempt, identified the way the budget counts it. */
interface FailureManifestRecord {
  readonly kind: typeof FAILURE_RECORD_INTENT | typeof FAILURE_RECORD_STORED;
  readonly step: string;
  readonly attempt: number;
  readonly digest: string;
  /** UTF-8 byte length of the retained content addressed by `digest`. */
  readonly bytes: number;
}

const MAX_MANIFEST_ATTEMPT = MAX_RETRIES_PER_STEP + 1;

function manifestInvalid(detail: string): never {
  throw new HarnessError("FAILURE_MANIFEST_INVALID", `the failure manifest is unusable: ${detail}`);
}

/**
 * Parse one manifest line, refusing anything it cannot fully account for.
 *
 * Every field is checked, including the ones a reader does not strictly need.
 * A manifest is the record of what a run spent and what evidence exists; a line
 * that is malformed, belongs to another run, or carries an out-of-range attempt
 * is a statement this function cannot evaluate, and skipping it silently would
 * quietly under-count the budget on exactly the corrupted manifest where the
 * budget matters most.
 */
function parseManifestRecord(
  line: string,
  runId: string,
  artifactRelativeRoot = "e2e/artifacts",
): FailureManifestRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return manifestInvalid("a line is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return manifestInvalid("a line is not a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  if (record.schema_version !== HARNESS_SCHEMA_VERSION) {
    return manifestInvalid("a line declares an unknown schema version");
  }
  if (record.record !== FAILURE_RECORD_INTENT && record.record !== FAILURE_RECORD_STORED) {
    return manifestInvalid("a line declares an unknown record kind");
  }
  if (record.run_id !== runId) {
    return manifestInvalid("a line belongs to a different run");
  }
  // `invalid-step` is what the writer substitutes for a step id it would not
  // publish, so it is a legitimate recorded value even though it is not one.
  if (
    typeof record.step !== "string" ||
    (record.step !== "invalid-step" && !validateStepId(record.step))
  ) {
    return manifestInvalid("a line carries an unusable step label");
  }
  if (
    typeof record.attempt !== "number" ||
    !Number.isInteger(record.attempt) ||
    record.attempt < 1 ||
    record.attempt > MAX_MANIFEST_ATTEMPT
  ) {
    return manifestInvalid("a line carries an attempt outside the bounded range");
  }
  if (typeof record.digest !== "string" || !SHA256_HEX.test(record.digest)) {
    return manifestInvalid("a line carries a malformed digest");
  }
  if (
    typeof record.bytes !== "number" ||
    !Number.isInteger(record.bytes) ||
    record.bytes < 0 ||
    record.bytes > MAX_FAILURE_ARTIFACT_CHARS * 4
  ) {
    return manifestInvalid("a line carries a byte count outside the bounded range");
  }
  if (
    record.blob !== `${artifactRelativeRoot}/${ARTIFACT_BLOB_DIRECTORY}/sha256/${record.digest}`
  ) {
    return manifestInvalid("a line's blob path does not address its own digest");
  }
  return {
    kind: record.record,
    step: record.step,
    attempt: record.attempt,
    digest: record.digest,
    bytes: record.bytes,
  };
}

/**
 * Read a run's failure manifest back into a budget and a recovery report.
 *
 * A crash between the intent line and the published blob is the case this
 * exists for. The intent still counts against the per-run budget — otherwise a
 * repeatedly-crashing run resumes with a full budget every time and can publish
 * unbounded distinct blobs — while the missing blob is reported as dangling
 * rather than repaired or removed. A malformed line is counted as neither: it
 * cannot be trusted to describe a slot, and discarding it silently would be a
 * quieter failure than saying the manifest is unreadable at that point.
 */
export function reconcileFailureManifest(
  manifest: string,
  artifactsDirectory: string,
  runId: string,
  storage: HarnessArtifactStorage = nodeArtifactStorage,
  artifactRelativeRoot = "e2e/artifacts",
): FailureManifestReconciliation {
  if (!storage.exists(manifest)) {
    return { attemptCount: 0, stored: [], dangling: [], unfinishedAttempts: [] };
  }
  const store = join(artifactsDirectory, ARTIFACT_BLOB_DIRECTORY, "sha256");
  /** Slot key. Two steps emitting identical bytes are two attempts, not one. */
  const slot = (record: FailureManifestRecord): string => `${record.step} ${record.attempt}`;
  const intents = new Map<string, FailureManifestRecord>();
  const completions = new Map<string, FailureManifestRecord>();

  for (const line of storage.readFile(manifest).split("\n")) {
    if (line.trim() === "") continue;
    const record = parseManifestRecord(line, runId, artifactRelativeRoot);
    const key = slot(record);
    if (record.kind === FAILURE_RECORD_INTENT) {
      const existing = intents.get(key);
      // A repeated intent for one slot is the resume path rewriting its own
      // attempt; it must not describe different bytes than the first claim.
      if (
        existing !== undefined &&
        (existing.digest !== record.digest || existing.bytes !== record.bytes)
      ) {
        manifestInvalid("two intents for one attempt disagree about the digest");
      }
      intents.set(key, record);
      continue;
    }
    const claimed = intents.get(key);
    if (claimed === undefined) {
      manifestInvalid("a completion has no matching intent");
    }
    if (claimed.digest !== record.digest || claimed.bytes !== record.bytes) {
      manifestInvalid("a completion does not match the digest its intent claimed");
    }
    if (completions.has(key)) {
      manifestInvalid("an attempt was completed twice");
    }
    completions.set(key, record);
  }

  const stored = new Set<string>();
  const dangling = new Set<string>();
  const unfinished: string[] = [];
  for (const [key, intent] of intents) {
    const digest = intent.digest;
    // Presence in the store decides, not the completion line: a completion
    // written before a crash that lost the blob is still missing evidence, and
    // a blob published by another run satisfies this one's reference.
    const blob = join(store, digest);
    if (storage.exists(blob)) {
      if (
        storage.isSymlink(blob) ||
        !storage.isFile(blob) ||
        storage.size(blob) !== intent.bytes ||
        createHash("sha256").update(storage.readFile(blob), "utf8").digest("hex") !== digest
      ) {
        manifestInvalid("a stored blob does not match the byte metadata its intent recorded");
      }
      stored.add(digest);
    } else dangling.add(digest);
    // An intent with no completion is where the process died. Distinct from a
    // dangling digest: the blob can be present (another run published the same
    // bytes) while this run never got to record that it finished.
    if (!completions.has(key)) unfinished.push(key);
  }
  return {
    attemptCount: intents.size,
    // Sorted so a resumed run's reported state does not depend on line order.
    stored: [...stored].sort(),
    dangling: [...dangling].sort(),
    unfinishedAttempts: unfinished.sort(),
  };
}

export function countArtifactNamespaces(
  root: string,
  storage: HarnessArtifactStorage = nodeArtifactStorage,
): number {
  const physicalRoot = realDirectory(resolve(root), "ARTIFACT_PATH_UNSAFE", storage);
  const e2e = join(physicalRoot, "e2e");
  if (!storage.exists(e2e)) return 0;
  const physicalE2e = realDirectory(e2e, "ARTIFACT_PATH_UNSAFE", storage);
  if (physicalE2e !== e2e) {
    throw new HarnessError("ARTIFACT_PATH_UNSAFE", "e2e must be an unredirected real directory.");
  }
  const artifacts = join(physicalE2e, "artifacts");
  if (!storage.exists(artifacts)) return 0;
  const physicalArtifacts = realDirectory(artifacts, "ARTIFACT_PATH_UNSAFE", storage);
  if (physicalArtifacts !== artifacts) {
    throw new HarnessError(
      "ARTIFACT_PATH_UNSAFE",
      "artifact namespace census requires an unredirected real artifacts directory.",
    );
  }
  let count = 0;
  for (const name of storage.readdir(physicalArtifacts)) {
    if (!isSafeRetainedEvidenceName(name)) {
      throw new HarnessError(
        "ARTIFACT_PATH_UNSAFE",
        "artifact namespace census found an unsafe path component.",
      );
    }
    const entry = join(physicalArtifacts, name);
    if (storage.isSymlink(entry)) {
      throw new HarnessError(
        "ARTIFACT_PATH_UNSAFE",
        "artifact namespace census must not follow a symlink.",
      );
    }
    if (!storage.isDirectory(entry)) continue;
    assertContained(
      physicalArtifacts,
      realDirectory(entry, "ARTIFACT_PATH_UNSAFE", storage),
      "ARTIFACT_PATH_UNSAFE",
    );
    if (name === ARTIFACT_BLOB_DIRECTORY) continue;
    count += 1;
  }
  return count;
}

/**
 * Refuse to create a new artifact namespace once the backstop is reached.
 *
 * Reusing an existing namespace is always allowed — a resume must not be
 * blocked by a ceiling on *new* directories.
 */
/**
 * The budget decision, as a pure function of two numbers.
 *
 * Split out so the boundary is testable in O(1). A test that proved this by
 * creating `MAX_ARTIFACT_NAMESPACES` real directories would be manufacturing
 * exactly the proliferation the backstop exists to bound — and because nothing
 * here may delete, every such run would retain another five thousand
 * directories forever.
 */
export function exceedsArtifactNamespaceBudget(
  used: number,
  limit = MAX_ARTIFACT_NAMESPACES,
): boolean {
  return used >= limit;
}

/**
 * Check the budget and create the namespace in one step.
 *
 * Returns the existing directory untouched when the namespace is already there,
 * so a resume is never refused by a ceiling on *new* directories. The check
 * still precedes creation: at the limit, nothing is created at all.
 *
 * This narrows but cannot close the concurrent window — two runs can both count
 * `limit - 1` and both create — so the backstop overshoots by at most the number
 * of writers racing at the boundary. It is a backstop, not a quota, and that
 * bound is stated rather than implied.
 */
export interface ArtifactCapacityReport {
  /** A simulated count is control-flow input, not production evidence. */
  readonly storageAuthority: HarnessStorageAuthority;
  readonly used: number;
  readonly limit: number;
  readonly exceeded: boolean;
  /** Optional recursive census for the exact retained namespace requested. */
  readonly retainedIntegration: RetainedIntegrationCapacityReport | null;
  /** The operator action, which is never deletion. */
  readonly remedy: string;
}

/**
 * Structured capacity preflight.
 *
 * A value rather than an assertion, so a caller decides what to do with it: a
 * CLI can refuse, an operator can read it, and a unit test can check its shape
 * without making a green suite depend on ambient disk state. The hard refusal
 * still lives in `assertArtifactNamespaceBudget`, which fires when a run
 * actually tries to create a namespace.
 */
export function artifactCapacityReport(
  root: string,
  limit = MAX_ARTIFACT_NAMESPACES,
  storage: HarnessArtifactStorage = nodeArtifactStorage,
  artifactNamespace?: string,
): ArtifactCapacityReport {
  if (artifactNamespace !== undefined && !validateRunId(artifactNamespace)) {
    throw new HarnessError(
      "ARTIFACT_NAMESPACE_INVALID",
      "artifact_namespace must be one safe, bounded path component.",
    );
  }
  const used = countArtifactNamespaces(root, storage);
  const artifacts = join(resolve(root), "e2e", "artifacts");
  const integration =
    artifactNamespace === undefined
      ? null
      : storage.exists(join(artifacts, artifactNamespace))
        ? retainedIntegrationCapacityReport(join(artifacts, artifactNamespace), storage)
        : emptyRetainedIntegrationCapacityReport(storage);
  const topLevelExceeded = exceedsArtifactNamespaceBudget(used, limit);
  return {
    storageAuthority: storageAuthority(storage),
    used,
    limit,
    exceeded: topLevelExceeded || integration?.exceeded === true,
    retainedIntegration: integration,
    remedy:
      integration?.exceeded === true
        ? "Nothing may be deleted. Inspect the requested retained integration namespace recursively, then archive or move its evidence elsewhere."
        : "Nothing may be deleted. Inspect e2e/artifacts — every directory counts, " +
          "including fixture scratch no run created — then archive or move them elsewhere.",
  };
}

/** A missing selected namespace has a precise recursive census of zero. */
function emptyRetainedIntegrationCapacityReport(
  storage: HarnessArtifactStorage,
): RetainedIntegrationCapacityReport {
  return {
    storageAuthority: storageAuthority(storage),
    directories: 0,
    bytes: 0,
    stagingEntries: 0,
    directoryLimit: MAX_RETAINED_INTEGRATION_DIRECTORIES,
    byteLimit: MAX_RETAINED_INTEGRATION_BYTES,
    truncated: false,
    exceeded: false,
  };
}

export function reserveArtifactNamespace(
  root: string,
  artifactsDirectory: string,
  namespace: string,
  limit = MAX_ARTIFACT_NAMESPACES,
  storage: HarnessArtifactStorage = nodeArtifactStorage,
  expectedArtifactRootIdentity?: string,
): string {
  assertExactArtifactsDirectory(root, artifactsDirectory, storage);
  const rootDirectory = realDirectory(resolve(root), "ARTIFACT_PATH_UNSAFE", storage);
  const artifactRoot = realDirectory(
    resolve(artifactsDirectory),
    "ARTIFACT_PATH_UNSAFE",
    storage,
  );
  const expectedIdentity =
    expectedArtifactRootIdentity ?? storage.directoryIdentity(artifactRoot);
  assertArtifactWriterBoundary(rootDirectory, artifactRoot, expectedIdentity, storage);
  assertArtifactNamespaceBudget(root, namespace, limit, storage);
  assertArtifactWriterBoundary(rootDirectory, artifactRoot, expectedIdentity, storage);
  const reserved = ensureDirectDirectory(artifactsDirectory, namespace, storage);
  assertArtifactWriterBoundary(rootDirectory, artifactRoot, expectedIdentity, storage);
  return reserved;
}

/**
 * Atomically claim a top-level namespace for a new run.
 *
 * `reserveArtifactNamespace` deliberately permits an existing directory so a
 * retained integration parent can be reused. A new run has the opposite
 * contract: after the earlier existence observation, another process can win
 * the mkdir race, and this writer must receive EEXIST rather than adopt the
 * winner's evidence directory.
 */
function reserveNewArtifactNamespace(
  root: string,
  artifactsDirectory: string,
  namespace: string,
  limit = MAX_ARTIFACT_NAMESPACES,
  storage: HarnessArtifactStorage = nodeArtifactStorage,
  expectedArtifactRootIdentity?: string,
): string {
  assertExactArtifactsDirectory(root, artifactsDirectory, storage);
  const rootDirectory = realDirectory(resolve(root), "ARTIFACT_PATH_UNSAFE", storage);
  const artifactRoot = realDirectory(
    resolve(artifactsDirectory),
    "ARTIFACT_PATH_UNSAFE",
    storage,
  );
  const expectedIdentity =
    expectedArtifactRootIdentity ?? storage.directoryIdentity(artifactRoot);
  assertArtifactWriterBoundary(rootDirectory, artifactRoot, expectedIdentity, storage);
  if (!validateRunId(namespace)) {
    throw new HarnessError(
      "ARTIFACT_NAMESPACE_INVALID",
      "artifact namespace names must be safe bounded path components.",
    );
  }
  assertArtifactNamespaceBudget(root, namespace, limit, storage);
  assertArtifactWriterBoundary(rootDirectory, artifactRoot, expectedIdentity, storage);
  const reserved = createNewRunDirectory(artifactsDirectory, namespace, storage);
  assertArtifactWriterBoundary(rootDirectory, artifactRoot, expectedIdentity, storage);
  return reserved;
}

export function assertArtifactNamespaceBudget(
  root: string,
  namespace: string,
  limit = MAX_ARTIFACT_NAMESPACES,
  storage: HarnessArtifactStorage = nodeArtifactStorage,
): void {
  const artifacts = join(resolve(root), "e2e", "artifacts");
  if (storage.exists(join(artifacts, namespace))) return;
  const used = countArtifactNamespaces(root, storage);
  if (exceedsArtifactNamespaceBudget(used, limit)) {
    throw new HarnessError(
      "ARTIFACT_RETENTION_EXCEEDED",
      `e2e/artifacts holds ${used} directories, at the ${limit} backstop. ` +
        "Every directory there counts, not only harness run directories: fixture " +
        "scratch and anything else placed under e2e/artifacts counts too, so the " +
        "number may be dominated by directories no run created. Nothing was " +
        "deleted. Inspect what is there, then archive or move it elsewhere (any " +
        "harness run directory among them is retained evidence) and re-run.",
    );
  }
}

/** A recursive accounting of all retained evidence below the one integration parent. */
export interface RetainedIntegrationCapacityReport {
  /** Derived from adapter identity; never copied from a public string field. */
  readonly storageAuthority: HarnessStorageAuthority;
  /** Every nested directory except the retained parent itself. */
  readonly directories: number;
  /** Bytes by pathname, including retained staging links. */
  readonly bytes: number;
  /** The retained `incoming` entries, reported rather than cleaned up. */
  readonly stagingEntries: number;
  readonly directoryLimit: number;
  readonly byteLimit: number;
  /** The scan stopped at a cap; counts are safe lower bounds, not an estimate. */
  readonly truncated: boolean;
  readonly exceeded: boolean;
}

/**
 * Count the nested evidence the top-level namespace backstop cannot see.
 *
 * This intentionally walks through `HarnessArtifactStorage`; the simulation
 * can prove the accounting contract, while only the exact node adapter can
 * make a real-filesystem receipt. Symlinks and unknown entries fail closed so
 * a redirected or unaccounted path cannot escape the cap.
 */
export function retainedIntegrationCapacityReport(
  integrationDirectory: string,
  storage: HarnessArtifactStorage = nodeArtifactStorage,
): RetainedIntegrationCapacityReport {
  const root = realDirectory(resolve(integrationDirectory), "ARTIFACT_PATH_UNSAFE", storage);
  let directories = 0;
  let bytes = 0;
  let stagingEntries = 0;
  let truncated = false;
  const walk = (directory: string): void => {
    for (const name of storage.readdir(directory)) {
      if (
        directories >= MAX_RETAINED_INTEGRATION_DIRECTORIES ||
        bytes >= MAX_RETAINED_INTEGRATION_BYTES
      ) {
        truncated = true;
        return;
      }
      if (!isSafeRetainedEvidenceName(name)) {
        throw new HarnessError(
          "ARTIFACT_PATH_UNSAFE",
          "retained integration evidence has an unsafe path component.",
        );
      }
      const path = join(directory, name);
      if (storage.isSymlink(path)) {
        throw new HarnessError(
          "ARTIFACT_PATH_UNSAFE",
          "retained integration evidence must not traverse a symlink.",
        );
      }
      if (storage.isDirectory(path)) {
        const physical = realDirectory(path, "ARTIFACT_PATH_UNSAFE", storage);
        assertContained(root, physical, "ARTIFACT_PATH_UNSAFE");
        directories += 1;
        if (directories >= MAX_RETAINED_INTEGRATION_DIRECTORIES) {
          truncated = true;
          return;
        }
        walk(physical);
        if (truncated) return;
        continue;
      }
      if (storage.isFile(path)) {
        bytes += storage.size(path);
        if (basename(directory) === ARTIFACT_BLOB_STAGING_DIRECTORY) stagingEntries += 1;
        if (bytes >= MAX_RETAINED_INTEGRATION_BYTES) {
          truncated = true;
          return;
        }
        continue;
      }
      throw new HarnessError(
        "ARTIFACT_PATH_UNSAFE",
        "retained integration evidence has an unaccountable path entry.",
      );
    }
  };
  walk(root);
  return {
    storageAuthority: storageAuthority(storage),
    directories,
    bytes,
    stagingEntries,
    directoryLimit: MAX_RETAINED_INTEGRATION_DIRECTORIES,
    byteLimit: MAX_RETAINED_INTEGRATION_BYTES,
    truncated,
    exceeded:
      directories >= MAX_RETAINED_INTEGRATION_DIRECTORIES ||
      bytes >= MAX_RETAINED_INTEGRATION_BYTES,
  };
}

function isSafeRetainedEvidenceName(name: string): boolean {
  return name !== "." && name !== ".." && /^[.A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name);
}

/** Refuse before a nested retained directory or byte-bearing file is created. */
export function assertRetainedIntegrationCapacity(
  integrationDirectory: string,
  projected: { readonly additionalDirectories?: number; readonly additionalBytes?: number } = {},
  storage: HarnessArtifactStorage = nodeArtifactStorage,
): void {
  const additionalDirectories = projected.additionalDirectories ?? 0;
  const additionalBytes = projected.additionalBytes ?? 0;
  if (
    !Number.isSafeInteger(additionalDirectories) ||
    additionalDirectories < 0 ||
    !Number.isSafeInteger(additionalBytes) ||
    additionalBytes < 0
  ) {
    throw new HarnessError(
      "INTEGRATION_RETENTION_INVALID",
      "retained integration capacity projections must be bounded non-negative integers.",
    );
  }
  const report = retainedIntegrationCapacityReport(integrationDirectory, storage);
  if (
    report.directories + additionalDirectories >= report.directoryLimit ||
    report.bytes + additionalBytes >= report.byteLimit
  ) {
    throw new HarnessError(
      "INTEGRATION_RETENTION_EXCEEDED",
      `retained integration evidence holds ${report.directories}/${report.directoryLimit} directories and ${report.bytes}/${report.byteLimit} bytes before this operation. ` +
        "Nothing was created, deleted, or moved. Retain the existing evidence and archive or move it by an explicit operator action before retrying.",
    );
  }
}

/**
 * Reserve one direct run/case directory beneath the explicit integration
 * parent. Unlike the top-level cap, this sees all nested self-test, resume,
 * case, staging, and D1-state growth.
 */
export function reserveRetainedIntegrationDirectory(
  integrationDirectory: string,
  name: string,
  storage: HarnessArtifactStorage = nodeArtifactStorage,
  projectedDirectories = 1,
): string {
  if (!validateRunId(name)) {
    throw new HarnessError(
      "ARTIFACT_NAMESPACE_INVALID",
      "retained integration directory names must be safe bounded path components.",
    );
  }
  const root = realDirectory(resolve(integrationDirectory), "ARTIFACT_PATH_UNSAFE", storage);
  const artifactRoot = realDirectory(resolve(root, ".."), "ARTIFACT_PATH_UNSAFE", storage);
  const writerRoot = realDirectory(
    resolve(artifactRoot, "..", ".."),
    "ARTIFACT_PATH_UNSAFE",
    storage,
  );
  const expectedArtifactRootIdentity = storage.directoryIdentity(artifactRoot);
  assertArtifactWriterBoundary(
    writerRoot,
    artifactRoot,
    expectedArtifactRootIdentity,
    storage,
  );
  const target = join(root, name);
  if (!storage.exists(target)) {
    assertRetainedIntegrationCapacity(
      root,
      { additionalDirectories: projectedDirectories },
      storage,
    );
  }
  assertArtifactWriterBoundary(
    writerRoot,
    artifactRoot,
    expectedArtifactRootIdentity,
    storage,
  );
  const reserved = ensureDirectDirectory(root, name, storage);
  assertArtifactWriterBoundary(
    writerRoot,
    artifactRoot,
    expectedArtifactRootIdentity,
    storage,
  );
  return reserved;
}

/** The retained-integration form of the same exclusive new-run claim. */
function reserveNewRetainedIntegrationDirectory(
  integrationDirectory: string,
  name: string,
  storage: HarnessArtifactStorage = nodeArtifactStorage,
  projectedDirectories = 1,
  expectedArtifactRootIdentity?: string,
): string {
  if (!validateRunId(name)) {
    throw new HarnessError(
      "ARTIFACT_NAMESPACE_INVALID",
      "retained integration directory names must be safe bounded path components.",
    );
  }
  const root = realDirectory(resolve(integrationDirectory), "ARTIFACT_PATH_UNSAFE", storage);
  const artifactRoot = realDirectory(resolve(root, ".."), "ARTIFACT_PATH_UNSAFE", storage);
  const writerRoot = realDirectory(
    resolve(artifactRoot, "..", ".."),
    "ARTIFACT_PATH_UNSAFE",
    storage,
  );
  const expectedIdentity =
    expectedArtifactRootIdentity ?? storage.directoryIdentity(artifactRoot);
  assertArtifactWriterBoundary(writerRoot, artifactRoot, expectedIdentity, storage);
  assertRetainedIntegrationCapacity(
    root,
    { additionalDirectories: projectedDirectories },
    storage,
  );
  assertArtifactWriterBoundary(writerRoot, artifactRoot, expectedIdentity, storage);
  const reserved = createNewRunDirectory(root, name, storage);
  assertArtifactWriterBoundary(writerRoot, artifactRoot, expectedIdentity, storage);
  return reserved;
}

/** Exclusive mkdir plus post-create containment, shared by both new-run paths. */
function createNewRunDirectory(
  parent: string,
  name: string,
  storage: HarnessArtifactStorage,
): string {
  const target = join(parent, name);
  assertContained(parent, target, "ARTIFACT_PATH_UNSAFE");
  try {
    storage.mkdir(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (storage.isSymlink(target)) {
      throw new HarnessError(
        "ARTIFACT_PATH_UNSAFE",
        "the run namespace is a symlink; artifacts must not be redirected out of the artifact area.",
      );
    }
    throw new HarnessError(
      "RUN_ID_EXISTS",
      "run_id already owns an artifact namespace; choose a new run_id or resume that run.",
    );
  }
  const physical = realDirectory(target, "ARTIFACT_PATH_UNSAFE", storage);
  assertContained(parent, physical, "ARTIFACT_PATH_UNSAFE");
  return physical;
}

function assertContained(root: string, target: string, code: string): void {
  if (isOutside(root, target))
    throw new HarnessError(code, "artifact path resolves outside the repository.");
}

/**
 * The top-level artifact directory is an authority boundary, not a caller
 * preference. A public reservation helper that accepted an arbitrary sibling
 * could create a new retained tree outside this checkout before its budget
 * check noticed anything. Require the one exact `<root>/e2e/artifacts` path.
 */
function assertExactArtifactsDirectory(
  root: string,
  artifactsDirectory: string,
  storage: HarnessArtifactStorage,
): void {
  const rootDirectory = realDirectory(resolve(root), "ARTIFACT_PATH_UNSAFE", storage);
  const e2e = realDirectory(join(rootDirectory, "e2e"), "ARTIFACT_PATH_UNSAFE", storage);
  const expected = join(e2e, "artifacts");
  if (resolve(artifactsDirectory) !== expected) {
    throw new HarnessError(
      "ARTIFACT_PATH_UNSAFE",
      "artifact namespace reservation requires exactly this checkout's e2e/artifacts directory.",
    );
  }
  const actual = realDirectory(expected, "ARTIFACT_PATH_UNSAFE", storage);
  if (actual !== expected) {
    throw new HarnessError(
      "ARTIFACT_PATH_UNSAFE",
      "artifact namespace directory must be a direct real directory, not a redirected path.",
    );
  }
}

/** Refuse all writer activity while an operator-owned maintenance fence exists. */
function assertArtifactMaintenanceAbsent(
  root: string,
  storage: HarnessArtifactStorage,
): void {
  const fence = join(root, "e2e", ARTIFACT_MAINTENANCE_FENCE_NAME);
  assertContained(root, fence, "ARTIFACT_PATH_UNSAFE");
  // Any filesystem node at the reserved name closes the gate. A symlink or
  // directory must not be able to turn a malformed fence into an open one.
  if (storage.exists(fence) || storage.isSymlink(fence)) {
    throw new HarnessError(
      "ARTIFACT_MAINTENANCE_ACTIVE",
      "artifact maintenance is active; no run may claim or publish evidence.",
    );
  }
}

/**
 * Revalidate the physical artifact-root epoch immediately before a write.
 *
 * This predicate alone narrows pathname replacement races but is not a
 * lifetime lease. `ArtifactStore` pairs it with the append-only lease below;
 * direct helpers and raw integration writers must do the same before
 * whole-root maintenance can be allowed.
 */
function assertArtifactWriterBoundary(
  root: string,
  artifactsDirectory: string,
  expectedIdentity: string,
  storage: HarnessArtifactStorage,
): void {
  assertArtifactMaintenanceAbsent(root, storage);
  const expectedPath = join(root, "e2e", "artifacts");
  try {
    if (
      artifactsDirectory !== expectedPath ||
      storage.isSymlink(expectedPath) ||
      !storage.isDirectory(expectedPath) ||
      storage.realpath(expectedPath) !== expectedPath ||
      storage.directoryIdentity(expectedPath) !== expectedIdentity
    ) {
      throw new Error("artifact root changed");
    }
  } catch {
    throw new HarnessError(
      "ARTIFACT_ROOT_CHANGED",
      "the physical artifact root changed after this writer claimed it; retained evidence was left untouched.",
    );
  }
  assertArtifactMaintenanceAbsent(root, storage);
}

interface ArtifactWriterLease {
  readonly root: string;
  readonly artifactsDirectory: string;
  readonly artifactRootIdentity: string;
  readonly directory: string;
  readonly identity: string;
  readonly storage: HarnessArtifactStorage;
}

function artifactWriterLeaseEpochName(rootIdentity: string): string {
  const real = /^(\d+):(\d+)$/.exec(rootIdentity);
  if (real !== null) return `dev-${real[1]}-ino-${real[2]}`;
  const simulated = /^memory:(\d+)$/.exec(rootIdentity);
  if (simulated !== null) return `sim-memory-${simulated[1]}`;
  throw new HarnessError(
    "ARTIFACT_WRITER_LEASE_INVALID",
    "artifact root identity cannot name an append-only writer lease epoch.",
  );
}

function assertArtifactWriterLeaseOpen(lease: ArtifactWriterLease): void {
  assertArtifactWriterBoundary(
    lease.root,
    lease.artifactsDirectory,
    lease.artifactRootIdentity,
    lease.storage,
  );
  const actual = realDirectory(
    lease.directory,
    "ARTIFACT_WRITER_LEASE_INVALID",
    lease.storage,
  );
  const closed = join(actual, ARTIFACT_WRITER_LEASE_CLOSED_NAME);
  if (
    actual !== lease.directory ||
    lease.storage.directoryIdentity(actual) !== lease.identity ||
    lease.storage.exists(closed) ||
    lease.storage.isSymlink(closed)
  ) {
    throw new HarnessError(
      "ARTIFACT_WRITER_LEASE_CLOSED",
      "artifact writer lease is absent, replaced, or closed; retained evidence was left untouched.",
    );
  }
  assertArtifactWriterBoundary(
    lease.root,
    lease.artifactsDirectory,
    lease.artifactRootIdentity,
    lease.storage,
  );
}

function closeArtifactWriterLease(lease: ArtifactWriterLease): void {
  const actual = realDirectory(
    lease.directory,
    "ARTIFACT_WRITER_LEASE_INVALID",
    lease.storage,
  );
  if (actual !== lease.directory || lease.storage.directoryIdentity(actual) !== lease.identity) {
    throw new HarnessError(
      "ARTIFACT_WRITER_LEASE_INVALID",
      "artifact writer lease was replaced and cannot be closed safely.",
    );
  }
  const closed = join(actual, ARTIFACT_WRITER_LEASE_CLOSED_NAME);
  if (lease.storage.exists(closed) || lease.storage.isSymlink(closed)) {
    const physicalClosed = realDirectory(
      closed,
      "ARTIFACT_WRITER_LEASE_INVALID",
      lease.storage,
    );
    if (physicalClosed !== closed || lease.storage.readdir(physicalClosed).length !== 0) {
      throw new HarnessError(
        "ARTIFACT_WRITER_LEASE_INVALID",
        "artifact writer lease has a malformed closed marker.",
      );
    }
    return;
  }
  lease.storage.mkdir(closed);
  const physicalClosed = realDirectory(
    closed,
    "ARTIFACT_WRITER_LEASE_INVALID",
    lease.storage,
  );
  if (physicalClosed !== closed || lease.storage.readdir(physicalClosed).length !== 0) {
    throw new HarnessError(
      "ARTIFACT_WRITER_LEASE_INVALID",
      "artifact writer lease closed marker is not one empty direct directory.",
    );
  }
}

function acquireArtifactWriterLease(
  root: string,
  artifactsDirectory: string,
  artifactRootIdentity: string,
  storage: HarnessArtifactStorage,
): ArtifactWriterLease {
  assertArtifactWriterBoundary(root, artifactsDirectory, artifactRootIdentity, storage);
  const e2e = realDirectory(join(root, "e2e"), "ARTIFACT_WRITER_LEASE_INVALID", storage);
  const registry = ensureSharedLeaseDirectory(e2e, ARTIFACT_WRITER_LEASES_NAME, storage);
  const epoch = ensureSharedLeaseDirectory(
    registry,
    artifactWriterLeaseEpochName(artifactRootIdentity),
    storage,
  );
  const openedAt = Math.floor(Date.now() / 1_000);
  for (let counter = 0; counter < 100; counter += 1) {
    const random = randomBytes(4).readUInt32BE(0);
    const directory = join(epoch, `lease-${process.pid}-${openedAt}-${counter}-${random}`);
    try {
      storage.mkdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    const physicalDirectory = realDirectory(
      directory,
      "ARTIFACT_WRITER_LEASE_INVALID",
      storage,
    );
    if (physicalDirectory !== directory) {
      throw new HarnessError(
        "ARTIFACT_WRITER_LEASE_INVALID",
        "artifact writer lease must remain inside its exact registry epoch.",
      );
    }
    const lease: ArtifactWriterLease = {
      root,
      artifactsDirectory,
      artifactRootIdentity,
      directory,
      identity: storage.directoryIdentity(physicalDirectory),
      storage,
    };
    try {
      assertArtifactWriterLeaseOpen(lease);
      return lease;
    } catch (error) {
      closeArtifactWriterLease(lease);
      throw error;
    }
  }
  throw new HarnessError(
    "ARTIFACT_WRITER_LEASE_UNAVAILABLE",
    "could not claim a unique append-only artifact writer lease.",
  );
}

/** Accept only an exact direct directory when another writer wins shared mkdir. */
function ensureSharedLeaseDirectory(
  parent: string,
  child: string,
  storage: HarnessArtifactStorage,
): string {
  const target = join(parent, child);
  assertContained(parent, target, "ARTIFACT_WRITER_LEASE_INVALID");
  if (!storage.exists(target) && !storage.isSymlink(target)) {
    try {
      storage.mkdir(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const physical = realDirectory(target, "ARTIFACT_WRITER_LEASE_INVALID", storage);
  if (physical !== target) {
    throw new HarnessError(
      "ARTIFACT_WRITER_LEASE_INVALID",
      "artifact writer lease registry must be an exact direct directory.",
    );
  }
  return physical;
}

function realDirectory(
  path: string,
  code: string,
  storage: HarnessArtifactStorage = nodeArtifactStorage,
): string {
  try {
    if (storage.isSymlink(path) || !storage.isDirectory(path)) {
      throw new Error("unsafe directory");
    }
    return storage.realpath(path);
  } catch {
    throw new HarnessError(code, "expected a real repository directory.");
  }
}

function ensureDirectDirectory(
  parent: string,
  child: string,
  storage: HarnessArtifactStorage = nodeArtifactStorage,
): string {
  const target = join(parent, child);
  assertContained(parent, target, "ARTIFACT_PATH_UNSAFE");
  if (storage.exists(target) || storage.isSymlink(target)) {
    if (storage.isSymlink(target) || !storage.isDirectory(target)) {
      throw new HarnessError(
        "ARTIFACT_PATH_UNSAFE",
        "artifact directory is not a direct real directory.",
      );
    }
  } else {
    storage.mkdir(target);
  }
  const physical = realDirectory(target, "ARTIFACT_PATH_UNSAFE", storage);
  assertContained(parent, physical, "ARTIFACT_PATH_UNSAFE");
  return physical;
}

function assertRegularOrAbsent(
  path: string,
  code: string,
  storage: HarnessArtifactStorage = nodeArtifactStorage,
): void {
  if (!storage.exists(path) && !storage.isSymlink(path)) return;
  if (storage.isSymlink(path) || !storage.isFile(path)) {
    throw new HarnessError(code, "artifact file path is not a regular file.");
  }
}

async function readBounded(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<{ text: string; truncated: boolean }> {
  if (stream === null) return { text: "", truncated: false };
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let truncated = false;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    const decoded = decoder.decode(result.value, { stream: true });
    if (text.length < limit) {
      const remaining = limit - text.length;
      text += decoded.slice(0, remaining);
      truncated ||= decoded.length > remaining;
    } else {
      truncated = true;
    }
  }
  const ending = decoder.decode();
  if (text.length < limit) {
    const remaining = limit - text.length;
    text += ending.slice(0, remaining);
    truncated ||= ending.length > remaining;
  } else if (ending.length > 0) {
    truncated = true;
  }
  return { text, truncated };
}

function command(code: string): readonly string[] {
  return [process.execPath, "-e", code];
}

function secretEmitterCommand(): readonly string[] {
  return [process.execPath, resolve(import.meta.dir, "self-test-secret-emitter.ts")];
}

/** Absolute path to a real adapter probe, plus its bounded mode and state contract. */
function adapterCommand(
  file: string,
  mode: "ok" | "planted-fail",
  stateDirectory?: string,
  artifactNamespace?: string,
): readonly string[] {
  const command = [process.execPath, resolve(import.meta.dir, "adapters", file), "--mode", mode];
  if (file !== ADAPTER_PROBES.d1) return command;
  if (stateDirectory === undefined || artifactNamespace === undefined) {
    throw new HarnessError(
      "D1_STATE_DIRECTORY_REQUIRED",
      "the real D1 adapter requires retained integration state and namespace arguments.",
    );
  }
  return [...command, "--state-dir", stateDirectory, "--integration-namespace", artifactNamespace];
}

/**
 * Classify one real-adapter step for the self-test verdict.
 *
 * The three adapters are not interchangeable: D1 and HTTP have hard local
 * dependencies that are present, while the browser adapter depends on a package
 * this workspace may not install. So `blocked` is an accepted outcome *only*
 * when the adapter reported a named blocker — never as a way to pass without
 * running anything.
 */
function adapterOutcome(
  events: readonly HarnessEvent[],
  stepId: string,
): "pass" | "fail" | "blocked" | "missing" {
  const event = [...events].reverse().find((item) => item.step === stepId);
  if (event === undefined) return "missing";
  if (event.status === "pass") return "pass";
  if (event.status === "blocked") return "blocked";
  return "fail";
}

export async function runHarnessSelfTest(
  root: string,
  onEvent?: (event: HarnessEvent) => void,
  storage: HarnessArtifactStorage = nodeArtifactStorage,
  artifactNamespace = DEFAULT_RETAINED_INTEGRATION_NAMESPACE,
): Promise<0 | 1> {
  const capacity = realFilesystemRetentionPreflight(root, storage, artifactNamespace);
  if (capacity.exceeded) {
    throw new HarnessError(
      "ARTIFACT_RETENTION_EXCEEDED",
      `real-filesystem preflight is blocked before self-test; ${capacity.used} namespaces reach the ${capacity.limit} backstop. ${capacity.remedy}`,
    );
  }
  const runId = `ops.2a-selftest-${Date.now()}-${process.pid}`;
  const reproduction = selfTestReproduction(artifactNamespace);
  const secret = ["asimp", "ag", "01JXYZ", "selftest", "neverlog", "canary"].join("_");
  const sink =
    onEvent ?? ((record: HarnessEvent) => process.stdout.write(`${JSON.stringify(record)}\n`));
  const result = await runHarness({
    root,
    runId,
    suite: "ops.2a-harness-self-test",
    reproduction: "self-test",
    onEvent: sink,
    storage,
    artifactNamespace,
    steps: [
      {
        id: "unit-assertion",
        scenario: "unit",
        command: command("console.error('assertion failed'); process.exit(1)"),
        replaySafe: true,
        assertion: "seeded unit assertion",
        expected: "promotion accepted",
        actual: "MISSING_FALSIFIER",
        requestId: "req-selftest-unit",
        eventId: "evt-selftest-unit",
      },
      // Real adapters. Each contributes a positive step that can only pass by
      // exercising the real dependency, and a planted-fail step that proves the
      // same assertion is capable of failing. A self-test whose checks cannot
      // fail proves nothing, so both halves are required.
      {
        id: "d1-rollback-verified",
        scenario: "integration",
        adapter: "d1",
        command: adapterCommand(
          "d1-rollback.ts",
          "ok",
          retainedD1StateDirectory(root, artifactNamespace, runId, "d1-state-rollback-ok"),
          artifactNamespace,
        ),
        replaySafe: false,
        timeoutMs: 55_000,
        assertion: "a late failure in a real local D1 batch rolls back the earlier write",
      },
      {
        id: "d1-rollback-planted-fail",
        scenario: "integration",
        adapter: "d1",
        command: adapterCommand(
          "d1-rollback.ts",
          "planted-fail",
          retainedD1StateDirectory(
            root,
            artifactNamespace,
            runId,
            "d1-state-rollback-planted-fail",
          ),
          artifactNamespace,
        ),
        replaySafe: false,
        timeoutMs: 55_000,
        assertion: "planted: the rollback assertion must fail when nothing rolled back",
        expected: "D1_TRANSACTION_ROLLED_BACK",
        actual: "D1_TRANSACTION_LEAKED",
      },
      {
        id: "http-fault-verified",
        scenario: "integration",
        adapter: "http",
        command: adapterCommand("http-fault.ts", "ok"),
        replaySafe: false,
        timeoutMs: 30_000,
        assertion: "a real loopback fault carries status and a correlatable request id",
        http: { method: "GET", routeTemplate: "/fault" },
      },
      {
        id: "http-fault-planted-fail",
        scenario: "integration",
        adapter: "http",
        command: adapterCommand("http-fault.ts", "planted-fail"),
        replaySafe: false,
        timeoutMs: 30_000,
        assertion: "planted: asserting 200 on a route that answers 500 must fail",
        expected: "200",
        actual: "500",
        http: { method: "GET", routeTemplate: "/fault" },
      },
      {
        id: "browser-assertion-verified",
        scenario: "e2e",
        adapter: "browser",
        command: adapterCommand("browser-assert.ts", "ok"),
        replaySafe: false,
        timeoutMs: 55_000,
        assertion: "real Chromium renders a local page and the asserted DOM text matches",
      },
      {
        id: "browser-assertion-planted-fail",
        scenario: "e2e",
        adapter: "browser",
        command: adapterCommand("browser-assert.ts", "planted-fail"),
        replaySafe: false,
        timeoutMs: 55_000,
        assertion: "planted: asserting text the page never renders must fail",
      },
      {
        id: "interrupted-safe",
        scenario: "e2e",
        command: command("setTimeout(() => process.exit(0), 500)"),
        replaySafe: true,
        timeoutMs: 20,
        assertion: "interrupted replay-safe step",
        requestId: "req-selftest-interrupt",
        eventId: "evt-selftest-interrupt",
      },
      {
        id: "secret-canary",
        scenario: "security",
        command: secretEmitterCommand(),
        replaySafe: true,
        assertion: "never-log canary",
        requestId: "req-selftest-secret",
        eventId: "evt-selftest-secret",
      },
    ],
  });
  const resumeRunId = `${runId}-resume`;
  const resumeSteps: HarnessStep[] = [
    {
      id: "safe-retry",
      scenario: "resume",
      command: command("console.error('synthetic replay-safe interruption'); process.exit(1)"),
      replaySafe: true,
    },
    {
      id: "unsafe-withheld",
      scenario: "resume",
      command: command("console.error('synthetic non-replay-safe interruption'); process.exit(1)"),
      replaySafe: false,
    },
  ];
  const interrupted = await runHarness({
    root,
    runId: resumeRunId,
    suite: "ops.2a-harness-self-test",
    reproduction: "self-test",
    steps: resumeSteps,
    onEvent: sink,
    storage,
    artifactNamespace,
  });
  const resumed = await runHarness({
    root,
    runId: resumeRunId,
    suite: "ops.2a-harness-self-test",
    reproduction: "self-test",
    steps: resumeSteps,
    resume: true,
    onEvent: sink,
    storage,
    artifactNamespace,
  });
  const artifacts = [
    result.artifacts.jsonl,
    result.artifacts.junit,
    ...result.artifacts.failureLogs,
  ]
    .map((path) => storage.readFile(path))
    .join("\n");
  const identifiers = result.events
    .map((event) => `${event.request_id ?? ""}${event.event_id ?? ""}`)
    .join(" ");
  /**
   * Adapter verdicts.
   *
   * A positive step must `pass` (the dependency really ran) or `blocked` (the
   * adapter named a missing dependency). Its planted twin must `fail` — or be
   * `blocked` for the same reason, since an adapter that cannot launch cannot
   * fail an assertion either. The pairing is what makes this honest: `pass`
   * alone could come from an assertion that never fails, and `fail` alone could
   * come from an adapter that never works.
   */
  const adapterPairs = [
    ["d1-rollback-verified", "d1-rollback-planted-fail"],
    ["http-fault-verified", "http-fault-planted-fail"],
    ["browser-assertion-verified", "browser-assertion-planted-fail"],
  ] as const;
  const adaptersClassified = adapterPairs.every(([positiveId, negativeId]) => {
    const positive = adapterOutcome(result.events, positiveId);
    const negative = adapterOutcome(result.events, negativeId);
    if (positive === "blocked" && negative === "blocked") return true;
    return positive === "pass" && negative === "fail";
  });
  // At least one adapter must have genuinely executed. If every adapter were
  // blocked, this self-test would be reporting on nothing.
  const someAdapterExecuted = adapterPairs.some(
    ([positiveId]) => adapterOutcome(result.events, positiveId) === "pass",
  );

  const pass =
    result.exitCode === 1 &&
    !artifacts.includes(secret) &&
    artifacts.includes("<redacted>") &&
    identifiers.includes("req-selftest-unit") &&
    result.events.every((event) => event.reproduce === reproduction) &&
    adaptersClassified &&
    someAdapterExecuted &&
    interrupted.exitCode === 1 &&
    resumed.events.some((event) => event.step === "safe-retry" && event.status === "fail") &&
    resumed.events.some(
      (event) => event.step === "unsafe-withheld" && event.code === "UNSAFE_REPLAY_WITHHELD",
    );
  const now = new Date().toISOString();
  const selfTestIdentity = result.events[0]?.run_identity_digest;
  if (selfTestIdentity === undefined) {
    throw new HarnessError(
      "SELF_TEST_IDENTITY_MISSING",
      "the self-test produced no identity-bound event; no summary receipt can be attributed safely.",
    );
  }
  const event: HarnessEvent = {
    schema_version: HARNESS_SCHEMA_VERSION,
    record: "self_test",
    run_id: runId,
    run_identity_digest: selfTestIdentity,
    suite: "ops.2a-harness-self-test",
    scenario: "harness",
    step: "self-test",
    seed: result.seed,
    started_at: now,
    finished_at: now,
    duration_ms: 0,
    attempt: 1,
    retry: 0,
    replay_safe: true,
    storage_authority: storageAuthority(storage),
    adapter: "process",
    status: pass ? "pass" : "fail",
    code: pass ? "HARNESS_SELF_TEST_HARNESS_ONLY" : "HARNESS_SELF_TEST_FAILED",
    reproduce: reproduction,
    git_revision: "unavailable",
    environment: {
      runtime: "bun",
      runtime_version: Bun.version,
      platform: process.platform,
      binding_versions: {},
    },
    http_method: null,
    route_template: null,
    cursor: null,
    seq: null,
    detail: pass
      ? "Harness-only validation passed: every registered adapter exercised its real dependency and its planted negative failed as required, or named a missing dependency. This proves the runner classifies and preserves evidence correctly; it proves nothing about product behavior."
      : "Harness self-test invariants failed.",
  };
  validateHarnessEvent(event);
  sink(event);
  return pass ? 0 : 1;
}

/**
 * Child cases and run ids stay below the one retained top-level namespace, so
 * an opt-in proof never resumes manufacturing disposable roots in system temp.
 */
export interface HarnessReproductionCommand {
  readonly command: "bash";
  readonly arguments: readonly string[];
  readonly copy_paste: string;
}

export interface HarnessReproductionContract {
  /** The write-free authority/capacity check that must run first. */
  readonly preflight: HarnessReproductionCommand;
  /** The retained integration invocation that is permitted only after preflight. */
  readonly execute: HarnessReproductionCommand;
  readonly storage_authority: "real-filesystem";
  readonly retained_namespace: string;
}

export function harnessIntegrationReproduction(
  root: string,
  artifactNamespace = DEFAULT_RETAINED_INTEGRATION_NAMESPACE,
): HarnessReproductionContract {
  if (!validateRunId(artifactNamespace)) {
    throw new HarnessError(
      "ARTIFACT_NAMESPACE_INVALID",
      "artifact_namespace must be one safe, bounded path component.",
    );
  }
  const preflightArguments = [
    "scripts/e2e-test-harness.sh",
    "--preflight",
    "--root",
    resolve(root),
    "--integration-namespace",
    artifactNamespace,
  ];
  const executeArguments = [
    "scripts/e2e-test-harness.sh",
    "--self-test",
    "--root",
    resolve(root),
    "--integration-namespace",
    artifactNamespace,
  ];
  return {
    preflight: {
      command: "bash",
      arguments: preflightArguments,
      copy_paste: ["bash", ...preflightArguments]
        .map((argument) => JSON.stringify(argument))
        .join(" "),
    },
    execute: {
      command: "bash",
      arguments: executeArguments,
      copy_paste: ["bash", ...executeArguments]
        .map((argument) => JSON.stringify(argument))
        .join(" "),
    },
    storage_authority: "real-filesystem",
    retained_namespace: artifactNamespace,
  };
}

interface HarnessCliOptions {
  readonly preflight: boolean;
  readonly selfTest: boolean;
  readonly root: string;
  readonly artifactNamespace: string;
}

function parseCli(argv: readonly string[]): HarnessCliOptions {
  let preflight = false;
  let selfTest = false;
  let root = resolve(import.meta.dir, "..", "..");
  let artifactNamespace = DEFAULT_RETAINED_INTEGRATION_NAMESPACE;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--self-test") {
      selfTest = true;
      continue;
    }
    if (argument === "--preflight") {
      preflight = true;
      continue;
    }
    if (argument === "--root") {
      const value = argv[++index];
      if (value === undefined)
        throw new HarnessError("ROOT_MISSING", "--root requires a directory.");
      root = resolve(value);
      continue;
    }
    if (argument === "--integration-namespace") {
      const value = argv[++index];
      if (value === undefined) {
        throw new HarnessError(
          "ARTIFACT_NAMESPACE_MISSING",
          "--integration-namespace requires one safe path component.",
        );
      }
      if (!validateRunId(value)) {
        throw new HarnessError(
          "ARTIFACT_NAMESPACE_INVALID",
          "--integration-namespace must be one safe, bounded path component.",
        );
      }
      artifactNamespace = value;
      continue;
    }
    throw new HarnessError(
      "UNKNOWN_ARGUMENT",
      "usage: scripts/e2e-test-harness.sh (--preflight | --self-test) [--root <dir>] [--integration-namespace <safe-component>]",
    );
  }
  if (preflight === selfTest) {
    throw new HarnessError("MODE_REQUIRED", "choose exactly one of --preflight or --self-test.");
  }
  return { preflight, selfTest, root, artifactNamespace };
}

if (import.meta.main) {
  let failureReproduction = SELF_TEST_REPRODUCTION;
  try {
    const options = parseCli(process.argv.slice(2));
    failureReproduction = selfTestReproduction(options.artifactNamespace);
    const report = realFilesystemRetentionPreflight(
      options.root,
      nodeArtifactStorage,
      options.artifactNamespace,
    );
    const reproduce = harnessIntegrationReproduction(options.root, options.artifactNamespace);
    if (report.exceeded) {
      process.stdout.write(
        `${JSON.stringify({
          tool: "bun",
          suite: "ops.2a-harness",
          record: "retention_preflight",
          storage_authority: report.storageAuthority,
          status: "blocked",
          code: "ARTIFACT_RETENTION_EXCEEDED",
          used: report.used,
          limit: report.limit,
          detail:
            "No shell step or artifact publication was attempted because the real filesystem retention backstop is already reached.",
          reproduce,
          remedy: report.remedy,
        })}\n`,
      );
      process.exitCode = HARNESS_BLOCKED_EXIT_CODE;
    } else if (options.preflight) {
      process.stdout.write(
        `${JSON.stringify({
          tool: "bun",
          suite: "ops.2a-harness",
          record: "retention_preflight",
          storage_authority: report.storageAuthority,
          status: "pass",
          code: "ARTIFACT_CAPACITY_AVAILABLE",
          used: report.used,
          limit: report.limit,
          detail:
            "Real filesystem authority is available and the retention backstop permits a separately requested shell self-test.",
          reproduce,
        })}\n`,
      );
      process.exitCode = 0;
    } else {
      process.exitCode = await runHarnessSelfTest(
        options.root,
        undefined,
        nodeArtifactStorage,
        options.artifactNamespace,
      );
    }
  } catch (error) {
    const code = error instanceof HarnessError ? error.code : "HARNESS_UNEXPECTED";
    process.stderr.write(
      `${JSON.stringify({ tool: "bun", suite: "ops.2a-harness-self-test", status: "fail", code, reproduce: failureReproduction })}\n`,
    );
    process.exitCode = 1;
  }
}
