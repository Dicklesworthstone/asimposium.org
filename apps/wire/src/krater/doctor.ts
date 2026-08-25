/**
 * W2.6 doctor-projections core: the drift report between the event log (the
 * truth, Rule A6) and the stored projections. This is the testable heart of
 * the `ops:projection-rebuild` command — it answers "does the log, replayed,
 * equal the stored state?" and names every divergence, so a rebuild is a
 * reported decision, never a blind overwrite.
 *
 * The law it enforces: projections are DERIVED. If one drifts, the log wins,
 * and serving fabricated-empty state is forbidden — a drifted projection must
 * be flagged `stale` and rebuilt, never silently trusted.
 *
 * The same read-only doctor boundary also reports durable problem identifiers
 * that violate the renderer-safe contract; it never repairs identifiers.
 */

import type { D1Database } from "@cloudflare/workers-types";

import type { ClaimProjection, KraterEvent } from "./krater.ts";
import { eventChainMatches, KRATER_CHAIN_VERSION, replayClaimProjections } from "./krater.ts";

/**
 * The doctor is a whole-problem, dry-run comparison. Refuse a larger request
 * rather than emit a partial report that could drive an incomplete rebuild.
 * With at most this many input rows, drift is bounded by four diagnostics per
 * replayed row plus one per stored row, and rebuildSet by this same row cap.
 */
export const MAX_PROJECTION_DOCTOR_INPUT_ROWS = 512;
export const MAX_PROBLEM_ID_AUDIT_FINDINGS = 200;

export class ProjectionDoctorInputError extends Error {
  readonly code = "PROJECTION_DOCTOR_INPUT_INVALID";

  constructor(detail: string) {
    super(`PROJECTION_DOCTOR_INPUT_INVALID: ${detail}`);
    this.name = "ProjectionDoctorInputError";
  }
}

function compareBinaryClaimIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export type ProjectionDrift =
  | {
      readonly kind: "missing_projection";
      readonly claimId: string;
      readonly detail: string;
    }
  | {
      readonly kind: "orphan_projection";
      readonly claimId: string;
      readonly detail: string;
    }
  | {
      readonly kind: "stale_projection";
      readonly claimId: string;
      readonly expected: boolean;
      readonly actual: boolean;
    }
  | {
      readonly kind: "invalid_stale_shape";
      readonly claimId: string;
      readonly expected: "boolean";
      /** The runtime `typeof` classification; never reflect an untrusted value. */
      readonly actualType: string;
    }
  | {
      readonly kind: "version_divergence";
      readonly claimId: string;
      readonly expected: number;
      readonly actual: number;
    }
  | {
      readonly kind: "source_sequence_divergence";
      readonly claimId: string;
      readonly expected: number;
      readonly actual: number;
    }
  | {
      readonly kind: "build_digest_divergence";
      readonly claimId: string;
      readonly expected: string;
      readonly actual: string;
    };

export interface ProjectionDoctorReport {
  readonly problemId: string;
  readonly replayedCount: number;
  readonly storedCount: number;
  /** True exactly when the stored state equals the log replay. */
  readonly sound: boolean;
  readonly drift: readonly ProjectionDrift[];
  /** The claim ids a rebuild would rewrite (dry-run output). */
  readonly rebuildSet: readonly string[];
}

export interface IntegrityDoctorPin {
  readonly problemId: string;
  readonly checkpointSeq: number;
  readonly rootChainDigest: string;
}

export interface IntegrityDoctorReport {
  readonly problemId: string;
  readonly chainVersion: typeof KRATER_CHAIN_VERSION;
  readonly eventCount: number;
  readonly sound: boolean;
  readonly detail: string;
}

export interface ProblemIdentifierDoctorReport {
  readonly sound: boolean;
  /** Renderer-invalid durable problem ids, in bytewise SQLite order. */
  readonly invalidProblemIds: readonly string[];
  /** More invalid rows exist than this bounded report can safely return. */
  readonly truncated: boolean;
}

/**
 * Audit the durable problem registry for ids admitted by the former session
 * contract but rejected by renderer control comments. This is intentionally a
 * read-only report: existing ids are never rewritten or silently filtered.
 */
export async function doctorProblemIdentifiers(
  db: D1Database,
): Promise<ProblemIdentifierDoctorReport> {
  const rows = await db
    .prepare(
      `SELECT id FROM problems
       WHERE instr(id, '--') > 0
       ORDER BY id
       LIMIT ?`,
    )
    .bind(MAX_PROBLEM_ID_AUDIT_FINDINGS + 1)
    .all<{ id: string }>();
  const invalidProblemIds = (rows.results ?? [])
    .slice(0, MAX_PROBLEM_ID_AUDIT_FINDINGS)
    .map((row) => row.id);
  return {
    sound: invalidProblemIds.length === 0,
    invalidProblemIds,
    truncated: (rows.results?.length ?? 0) > MAX_PROBLEM_ID_AUDIT_FINDINGS,
  };
}

/**
 * Verify the exact v2 event stream against a checkpoint root held outside the
 * supplied rows. This proves structural consistency with that pin; unsigned
 * roots are not authentication and must not be described as signatures.
 */
export async function doctorIntegrity(
  problemId: string,
  events: readonly KraterEvent[],
  pin: IntegrityDoctorPin,
): Promise<IntegrityDoctorReport> {
  if (
    events.length > MAX_PROJECTION_DOCTOR_INPUT_ROWS ||
    pin.problemId !== problemId ||
    !Number.isSafeInteger(pin.checkpointSeq) ||
    pin.checkpointSeq < 1 ||
    !/^[a-f0-9]{64}$/.test(pin.rootChainDigest) ||
    events.some((event) => event.problemId !== problemId)
  ) {
    throw new ProjectionDoctorInputError("integrity doctor input or checkpoint pin is invalid");
  }
  if (!(await eventChainMatches(events))) {
    return {
      problemId,
      chainVersion: KRATER_CHAIN_VERSION,
      eventCount: events.length,
      sound: false,
      detail: "the event stream is not one complete canonical v2 chain",
    };
  }
  const terminal = events[events.length - 1];
  if (
    terminal === undefined ||
    terminal.seq !== pin.checkpointSeq ||
    terminal.chainDigest !== pin.rootChainDigest
  ) {
    return {
      problemId,
      chainVersion: KRATER_CHAIN_VERSION,
      eventCount: events.length,
      sound: false,
      detail: "the verified stream does not end at the independently supplied checkpoint root",
    };
  }
  return {
    problemId,
    chainVersion: KRATER_CHAIN_VERSION,
    eventCount: events.length,
    sound: true,
    detail: "the canonical v2 stream matches the supplied unsigned checkpoint root",
  };
}

/**
 * Diff the stored projections against the log replay. Pure over the two
 * inputs — the caller reads the log and the projection table; this owns only
 * the comparison, so the doctor's verdict is reproducible offline.
 */
export function doctorProjections(
  problemId: string,
  events: readonly KraterEvent[],
  stored: readonly ClaimProjection[],
): ProjectionDoctorReport {
  if (events.length + stored.length > MAX_PROJECTION_DOCTOR_INPUT_ROWS) {
    throw new ProjectionDoctorInputError(
      `combined input exceeds the ${MAX_PROJECTION_DOCTOR_INPUT_ROWS}-row report cap`,
    );
  }

  if (
    events.some((event) => event.problemId !== problemId) ||
    stored.some((projection) => projection.problemId !== problemId)
  ) {
    throw new ProjectionDoctorInputError("every row must belong to the requested problem");
  }

  const replayed = replayClaimProjections(events);

  if (new Set(replayed.map((projection) => projection.claimId)).size !== replayed.length) {
    throw new ProjectionDoctorInputError("replayed claim ids must be unique");
  }
  if (new Set(stored.map((projection) => projection.claimId)).size !== stored.length) {
    throw new ProjectionDoctorInputError("stored claim ids must be unique");
  }

  const replayedById = new Map(replayed.map((p) => [p.claimId, p]));
  const storedById = new Map(stored.map((p) => [p.claimId, p]));

  const drift: ProjectionDrift[] = [];

  // A claim in the log with no stored projection is a missing projection.
  for (const projection of replayed) {
    const current = storedById.get(projection.claimId);
    if (current === undefined) {
      drift.push({
        kind: "missing_projection",
        claimId: projection.claimId,
        detail: "the log carries this claim but no projection row exists",
      });
      continue;
    }
    const actualStale: unknown = current.stale;
    if (typeof actualStale !== "boolean") {
      drift.push({
        kind: "invalid_stale_shape",
        claimId: projection.claimId,
        expected: "boolean",
        actualType: typeof actualStale,
      });
    } else if (actualStale !== projection.stale) {
      drift.push({
        kind: "stale_projection",
        claimId: projection.claimId,
        expected: projection.stale,
        actual: actualStale,
      });
    }
    if (current.sourceSeq !== projection.sourceSeq) {
      drift.push({
        kind: "source_sequence_divergence",
        claimId: projection.claimId,
        expected: projection.sourceSeq,
        actual: current.sourceSeq,
      });
    }
    if (current.projectionVersion !== projection.projectionVersion) {
      drift.push({
        kind: "version_divergence",
        claimId: projection.claimId,
        expected: projection.projectionVersion,
        actual: current.projectionVersion,
      });
    }
    if (current.buildDigest !== projection.buildDigest) {
      drift.push({
        kind: "build_digest_divergence",
        claimId: projection.claimId,
        expected: projection.buildDigest,
        actual: current.buildDigest,
      });
    }
  }

  // A stored projection with no log claim is an orphan — fabricated state.
  // Keep the replay-derived diagnostics above in their existing field order,
  // then make this caller-order-independent suffix deterministic.
  const orphanDrift: ProjectionDrift[] = [];
  for (const projection of stored) {
    if (!replayedById.has(projection.claimId)) {
      orphanDrift.push({
        kind: "orphan_projection",
        claimId: projection.claimId,
        detail: "a projection row exists with no backing log event — fabricated state",
      });
    }
  }
  orphanDrift.sort((left, right) => compareBinaryClaimIds(left.claimId, right.claimId));
  drift.push(...orphanDrift);

  // The rebuild set: every claim whose stored state diverges from the replay.
  const rebuildSet = [...new Set(drift.map((item) => item.claimId))].sort(compareBinaryClaimIds);

  return {
    problemId,
    replayedCount: replayed.length,
    storedCount: stored.length,
    sound: drift.length === 0,
    drift,
    rebuildSet,
  };
}
