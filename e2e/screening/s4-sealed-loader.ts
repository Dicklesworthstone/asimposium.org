import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  type ConfusionMetric,
  type PolicyCategory,
  type RateMetric,
  type ScreeningAggregateReport,
  type ScreeningCorpusExample,
  type ScreeningObservation,
  wilson95,
} from "../../apps/wire/src/screening/index";
import { WORKERS_AI_MAX_BODY_BYTES } from "../../apps/wire/src/screening/workers-ai";
import {
  assertS4CorpusShape,
  assertS4ManifestReadyForLiveRun,
  createS4Corpus,
  deriveS4EvaluatedCorpusIdentity,
  S4_CORPUS_REVISION,
  type S4EvaluatedCorpusIdentity,
  TIER_B_HARD_REJECT_RESERVATIONS,
  TIER_B_SEALED_DIGESTS,
} from "./s4-corpus";

const DEFAULT_REPO_ROOT = resolve(import.meta.dir, "../..");
const MAX_SEALED_FILE_BYTES = 512 * 1024;
const SHA256_RE = /^sha256:[a-f0-9]{64}$/;

export type SealedCorpusErrorCode =
  | "SEALED_CORPUS_PATH_MISSING"
  | "SEALED_CORPUS_UNREADABLE"
  | "SEALED_CORPUS_NOT_REGULAR_FILE"
  | "SEALED_CORPUS_INSIDE_REPO"
  | "SEALED_CORPUS_INSECURE_PERMISSIONS"
  | "SEALED_CORPUS_TOO_LARGE"
  | "SEALED_CORPUS_DECRYPT_FAILED"
  | "SEALED_CORPUS_MALFORMED"
  | "SEALED_CORPUS_INCOMPLETE"
  | "TIER_B_MANIFEST_DIGESTS_UNPINNED"
  | "CORPUS_DIGEST_MISMATCH";

/**
 * Fail-closed error carrying ONLY safe error codes and opaque corpus IDs —
 * never a file excerpt, body substring, or plaintext line from the sealed file.
 */
export class SealedCorpusError extends Error {
  constructor(
    readonly code: SealedCorpusErrorCode,
    readonly example_id?: string,
  ) {
    super(example_id ? `${code}:${example_id}` : code);
    this.name = "SealedCorpusError";
  }
}

export interface SealedFileOptions {
  /** Override repo root for tests; defaults to this workspace root. */
  readonly repo_root?: string;
  /** Override age identity file path when decrypting `.age` files. */
  readonly age_identity_file?: string;
}

export interface LoadSealedCorpusOptions extends SealedFileOptions {
  /**
   * Pinned SHA-256 digest map for Tier-B entries (`hard-021`..`hard-040`).
   * Defaults to the committed `TIER_B_SEALED_DIGESTS` table in `s4-corpus.ts`.
   */
  readonly pinned_digests?: Readonly<Record<string, string | null>>;
}

export interface SealedCorpusHashSummary {
  readonly corpus_revision: typeof S4_CORPUS_REVISION;
  readonly sealed_entry_count: number;
  readonly tier_b_manifest_digest: string;
  readonly digests: Readonly<Record<string, string>>;
}

export interface HydratedS4Corpus {
  /**
   * Complete 200-entry manifest with all Tier-B entries marked `available` and
   * digest-bound. Tier-B entries keep `body: undefined` on the manifest object
   * so serialization of `corpus` can never accidentally leak sealed text.
   */
  readonly corpus: readonly ScreeningCorpusExample[];
  /**
   * Ephemeral in-memory map of `example_id -> body` for all 200 entries
   * (150 legitimate + 30 Tier-A + 20 Tier-B). Never serialize or log this map.
   */
  readonly resolved_bodies: ReadonlyMap<string, string>;
  readonly corpus_identity: S4EvaluatedCorpusIdentity;
  readonly tier_b_count: number;
}

export interface LatencyPercentiles {
  readonly p50_ms: number | null;
  readonly p95_ms: number | null;
}

export interface S4ScorecardRecord {
  readonly record_type: "s4-scorecard";
  readonly corpus_revision: string;
  readonly corpus_digest: string;
  readonly evidence_class: "provider-measured" | "fixture-not-model-evidence";
  readonly scope: "full-200" | "partial";
  readonly verdict: "pass" | "fail" | "blocked";
  readonly evaluated_count: number;
  readonly reserved_count: number;
  readonly legitimate_fp_rate: RateMetric;
  readonly injection_recall: RateMetric;
  readonly hard_reject_fn_count: number;
  readonly hard_reject_observed_count: number;
  readonly by_policy_category: readonly ConfusionMetric[];
  readonly latency_p50_ms: number | null;
  readonly latency_p95_ms: number | null;
  readonly failures: readonly string[];
}

interface ParsedSealedEntry {
  readonly id: string;
  readonly policy_category: PolicyCategory;
  readonly body: string;
  readonly body_digest: string;
  readonly provenance: string;
}

const EXPECTED_TIER_B_CATEGORIES: ReadonlyMap<string, PolicyCategory> = new Map(
  TIER_B_HARD_REJECT_RESERVATIONS.map(([category, id]) => [id, category]),
);

async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return `sha256:${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function isPathInsideDirectory(candidatePath: string, directoryPath: string): boolean {
  const rel = relative(directoryPath, candidatePath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertPrivateRegularFile(
  filePath: string,
  repoRoot: string,
  checkOutOfRepo: boolean,
): string {
  const trimmed = filePath.trim();
  if (trimmed.length === 0) throw new SealedCorpusError("SEALED_CORPUS_PATH_MISSING");
  const resolvedPath = resolve(trimmed);
  let linkStat: ReturnType<typeof lstatSync>;
  try {
    linkStat = lstatSync(resolvedPath);
  } catch {
    throw new SealedCorpusError("SEALED_CORPUS_UNREADABLE");
  }
  if (linkStat.isSymbolicLink() || !linkStat.isFile()) {
    throw new SealedCorpusError("SEALED_CORPUS_NOT_REGULAR_FILE");
  }
  // Enforce mode <= 0600 BEFORE reading a single byte from the file.
  if (process.platform !== "win32" && (linkStat.mode & 0o077) !== 0) {
    throw new SealedCorpusError("SEALED_CORPUS_INSECURE_PERMISSIONS");
  }
  if (linkStat.size <= 0) {
    throw new SealedCorpusError("SEALED_CORPUS_MALFORMED");
  }
  if (linkStat.size > MAX_SEALED_FILE_BYTES) {
    throw new SealedCorpusError("SEALED_CORPUS_TOO_LARGE");
  }
  if (checkOutOfRepo) {
    let realRepoRoot: string;
    let realParent: string;
    let realFile: string;
    try {
      realRepoRoot = realpathSync(repoRoot);
      realParent = realpathSync(dirname(resolvedPath));
      realFile = realpathSync(resolvedPath);
    } catch {
      throw new SealedCorpusError("SEALED_CORPUS_UNREADABLE");
    }
    if (
      isPathInsideDirectory(realFile, realRepoRoot) ||
      isPathInsideDirectory(realParent, realRepoRoot)
    ) {
      throw new SealedCorpusError("SEALED_CORPUS_INSIDE_REPO");
    }
  }
  return resolvedPath;
}

/**
 * Validates that a sealed corpus path exists outside the repository, is a
 * regular non-symlink file, fits the size ceiling, and has no group/world
 * permission bits (`mode & 0o077 === 0`) BEFORE any bytes are read.
 */
export function assertSafeSealedFilePath(
  filePath: string,
  options: SealedFileOptions = {},
): string {
  const repoRoot = options.repo_root ?? DEFAULT_REPO_ROOT;
  return assertPrivateRegularFile(filePath, repoRoot, true);
}

function readSealedRawText(safePath: string, options: SealedFileOptions): string {
  if (!safePath.endsWith(".age")) {
    let fd: number | undefined;
    try {
      const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
      fd = openSync(safePath, flags);
      const st = fstatSync(fd);
      if (!st.isFile()) {
        throw new SealedCorpusError("SEALED_CORPUS_NOT_REGULAR_FILE");
      }
      if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
        throw new SealedCorpusError("SEALED_CORPUS_INSECURE_PERMISSIONS");
      }
      if (st.size <= 0) {
        throw new SealedCorpusError("SEALED_CORPUS_MALFORMED");
      }
      if (st.size > MAX_SEALED_FILE_BYTES) {
        throw new SealedCorpusError("SEALED_CORPUS_TOO_LARGE");
      }
      return readFileSync(fd, "utf8");
    } catch (error) {
      if (error instanceof SealedCorpusError) throw error;
      throw new SealedCorpusError("SEALED_CORPUS_UNREADABLE");
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // ignore close failure
        }
      }
    }
  }
  const identityFile = options.age_identity_file ?? process.env.ASIMPOSIUM_S4_AGE_IDENTITY_FILE;
  if (!identityFile) throw new SealedCorpusError("SEALED_CORPUS_DECRYPT_FAILED");
  const safeIdentity = assertPrivateRegularFile(
    identityFile,
    options.repo_root ?? DEFAULT_REPO_ROOT,
    true,
  );
  const child = spawnSync("age", ["-d", "-i", safeIdentity, safePath], {
    encoding: "utf8",
    maxBuffer: MAX_SEALED_FILE_BYTES,
    timeout: 15_000,
  });
  if (child.error || child.status !== 0 || typeof child.stdout !== "string") {
    throw new SealedCorpusError("SEALED_CORPUS_DECRYPT_FAILED");
  }
  return child.stdout;
}

async function parseSealedJsonl(rawText: string): Promise<readonly ParsedSealedEntry[]> {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) throw new SealedCorpusError("SEALED_CORPUS_MALFORMED");

  const byId = new Map<string, ParsedSealedEntry>();
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new SealedCorpusError("SEALED_CORPUS_MALFORMED");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new SealedCorpusError("SEALED_CORPUS_MALFORMED");
    }
    const record = parsed as {
      id?: unknown;
      policy_category?: unknown;
      body?: unknown;
      provenance?: unknown;
    };
    if (typeof record.id !== "string" || !EXPECTED_TIER_B_CATEGORIES.has(record.id)) {
      throw new SealedCorpusError("SEALED_CORPUS_MALFORMED");
    }
    if (byId.has(record.id)) {
      throw new SealedCorpusError("SEALED_CORPUS_MALFORMED", record.id);
    }
    const expectedCategory = EXPECTED_TIER_B_CATEGORIES.get(record.id);
    if (expectedCategory === undefined || record.policy_category !== expectedCategory) {
      throw new SealedCorpusError("SEALED_CORPUS_MALFORMED", record.id);
    }
    if (typeof record.body !== "string" || record.body.trim().length === 0) {
      throw new SealedCorpusError("SEALED_CORPUS_MALFORMED", record.id);
    }
    if (new TextEncoder().encode(record.body).byteLength > WORKERS_AI_MAX_BODY_BYTES) {
      throw new SealedCorpusError("SEALED_CORPUS_MALFORMED", record.id);
    }
    const provenance =
      typeof record.provenance === "string" && /^[A-Za-z0-9._:-]{3,96}$/.test(record.provenance)
        ? record.provenance
        : "operator-sealed-tier-b-corpus";
    byId.set(record.id, {
      id: record.id,
      policy_category: expectedCategory,
      body: record.body,
      body_digest: await sha256(record.body),
      provenance,
    });
  }

  if (byId.size !== EXPECTED_TIER_B_CATEGORIES.size) {
    throw new SealedCorpusError("SEALED_CORPUS_INCOMPLETE");
  }

  return [...byId.values()].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
}

/**
 * Operator helper: hashes all 20 Tier-B entries from a private `chmod 0600`
 * out-of-repo file and returns ONLY their SHA-256 digests plus overall manifest
 * digest — never a single byte of body text.
 */
export async function hashSealedCorpusFile(
  filePath: string,
  options: SealedFileOptions = {},
): Promise<SealedCorpusHashSummary> {
  const safePath = assertSafeSealedFilePath(filePath, options);
  const rawText = readSealedRawText(safePath, options);
  const entries = await parseSealedJsonl(rawText);
  const digests: Record<string, string> = {};
  const members: { readonly id: string; readonly body_digest: string }[] = [];
  for (const entry of entries) {
    digests[entry.id] = entry.body_digest;
    members.push({ id: entry.id, body_digest: entry.body_digest });
  }
  return {
    corpus_revision: S4_CORPUS_REVISION,
    sealed_entry_count: entries.length,
    tier_b_manifest_digest: await sha256(JSON.stringify(members)),
    digests,
  };
}

/**
 * Loads the 20 operator-held Tier-B hard-reject entries strictly into memory,
 * enforcing `mode <= 0600`, out-of-repo location, and exact per-entry SHA-256
 * verification against the pinned manifest digests (`CORPUS_DIGEST_MISMATCH`
 * on any 1-byte tamper).
 */
export async function loadS4SealedCorpus(
  filePath: string,
  options: LoadSealedCorpusOptions = {},
): Promise<HydratedS4Corpus> {
  const safePath = assertSafeSealedFilePath(filePath, options);
  const pinnedDigests = options.pinned_digests ?? TIER_B_SEALED_DIGESTS;

  for (const [, id] of TIER_B_HARD_REJECT_RESERVATIONS) {
    const pinned = pinnedDigests[id];
    if (typeof pinned !== "string" || !SHA256_RE.test(pinned)) {
      throw new SealedCorpusError("TIER_B_MANIFEST_DIGESTS_UNPINNED", id);
    }
  }

  const rawText = readSealedRawText(safePath, options);
  const entries = await parseSealedJsonl(rawText);
  const sealedById = new Map<string, ParsedSealedEntry>();
  for (const entry of entries) {
    const expectedDigest = pinnedDigests[entry.id];
    if (entry.body_digest !== expectedDigest) {
      throw new SealedCorpusError("CORPUS_DIGEST_MISMATCH", entry.id);
    }
    sealedById.set(entry.id, entry);
  }

  const baseCorpus = await createS4Corpus();
  const resolvedBodies = new Map<string, string>();
  const hydratedCorpus: ScreeningCorpusExample[] = baseCorpus.map((example) => {
    if (example.source.kind === "inline-safe") {
      if (example.body === undefined)
        throw new SealedCorpusError("SEALED_CORPUS_MALFORMED", example.id);
      resolvedBodies.set(example.id, example.body);
      return example;
    }
    const sealed = sealedById.get(example.id);
    if (sealed === undefined) throw new SealedCorpusError("SEALED_CORPUS_INCOMPLETE", example.id);
    resolvedBodies.set(example.id, sealed.body);
    return {
      ...example,
      body: undefined,
      body_digest: sealed.body_digest,
      source: {
        ...example.source,
        version: S4_CORPUS_REVISION,
        provenance: sealed.provenance,
        availability: "available" as const,
      },
      safe_excerpt:
        "Operator-held sealed Tier-B hard-reject body (withheld from logs and artifacts).",
    };
  });

  assertS4CorpusShape(hydratedCorpus);
  await assertS4ManifestReadyForLiveRun(hydratedCorpus);
  const corpusIdentity = await deriveS4EvaluatedCorpusIdentity(hydratedCorpus);

  return {
    corpus: hydratedCorpus,
    resolved_bodies: resolvedBodies,
    corpus_identity: corpusIdentity,
    tier_b_count: sealedById.size,
  };
}

/** Deterministic nearest-rank latency percentiles across answered observations. */
export function computeLatencyPercentiles(
  observations: readonly ScreeningObservation[],
): LatencyPercentiles {
  if (observations.length === 0) return { p50_ms: null, p95_ms: null };
  const sorted = observations.map((observation) => observation.latency_ms).sort((a, b) => a - b);
  const quantile = (q: number): number => {
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
    return sorted[index] ?? 0;
  };
  return {
    p50_ms: quantile(0.5),
    p95_ms: quantile(0.95),
  };
}

/** Exact recall on provider-ok ACIP prompt-injection controls (`decision === "reject"`). */
export function computeInjectionRecall(
  corpus: readonly ScreeningCorpusExample[],
  observations: readonly ScreeningObservation[],
): RateMetric {
  const byId = new Map(observations.map((obs) => [obs.example_id, obs]));
  let total = 0;
  let rejected = 0;
  for (const example of corpus) {
    if (example.ground_truth !== "hard-reject" || example.policy_category !== "injection") continue;
    const obs = byId.get(example.id);
    if (obs?.provider_status !== "ok") continue;
    total += 1;
    if (obs.decision === "reject") rejected += 1;
  }
  if (total === 0) return { numerator: 0, denominator: 0, rate: null, wilson_95: null };
  return {
    numerator: rejected,
    denominator: total,
    rate: Math.round((rejected / total) * 1_000_000) / 1_000_000,
    wilson_95: wilson95(rejected, total),
  };
}

/**
 * Secret-free scorecard NDJSON record for a complete 200-entry run.
 * Contains ONLY counts, rates, category metrics, and latency percentiles —
 * never body bytes, safe excerpts, prompts, or raw score bands.
 */
export function fullRunScorecardJsonl(
  corpus: readonly ScreeningCorpusExample[],
  observations: readonly ScreeningObservation[],
  report: ScreeningAggregateReport,
  evidenceClass: "provider-measured" | "fixture-not-model-evidence",
): string {
  const latency = computeLatencyPercentiles(observations);
  const record: S4ScorecardRecord = {
    record_type: "s4-scorecard",
    corpus_revision: report.identity.corpus_revision,
    corpus_digest: report.identity.corpus_digest,
    evidence_class: evidenceClass,
    scope: "full-200",
    verdict: report.verdict,
    evaluated_count: report.observation_count,
    reserved_count: 0,
    legitimate_fp_rate: report.legitimate_false_positive_rate,
    injection_recall: computeInjectionRecall(corpus, observations),
    hard_reject_fn_count: report.hard_reject_false_negative_rate.numerator,
    hard_reject_observed_count: report.hard_reject_false_negative_rate.denominator,
    by_policy_category: report.by_policy_category,
    latency_p50_ms: latency.p50_ms,
    latency_p95_ms: latency.p95_ms,
    failures: report.failures,
  };
  return JSON.stringify(record);
}
