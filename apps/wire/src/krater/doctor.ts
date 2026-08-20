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
 */

import type { ClaimProjection, KraterEvent } from "./krater.ts";
import { replayClaimProjections } from "./krater.ts";

export class ProjectionDoctorInputError extends Error {
  readonly code = "PROJECTION_DOCTOR_INPUT_INVALID";

  constructor(detail: string) {
    super(`PROJECTION_DOCTOR_INPUT_INVALID: ${detail}`);
    this.name = "ProjectionDoctorInputError";
  }
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
      readonly expected: false;
      readonly actual: true;
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
    if (current.stale) {
      drift.push({
        kind: "stale_projection",
        claimId: projection.claimId,
        expected: false,
        actual: true,
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
  for (const projection of stored) {
    if (!replayedById.has(projection.claimId)) {
      drift.push({
        kind: "orphan_projection",
        claimId: projection.claimId,
        detail: "a projection row exists with no backing log event — fabricated state",
      });
    }
  }

  // The rebuild set: every claim whose stored state diverges from the replay.
  const rebuildSet = [...new Set(drift.map((item) => item.claimId))].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );

  return {
    problemId,
    replayedCount: replayed.length,
    storedCount: stored.length,
    sound: drift.length === 0,
    drift,
    rebuildSet,
  };
}
