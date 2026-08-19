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
      readonly detail: string;
    }
  | {
      readonly kind: "version_divergence";
      readonly claimId: string;
      readonly expected: number;
      readonly actual: number;
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
  const replayed = replayClaimProjections(events);
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
        detail: "the stored projection is flagged stale and must be rebuilt from the log",
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
  const rebuildSet = drift.map((d) => d.claimId).sort();

  return {
    problemId,
    replayedCount: replayed.length,
    storedCount: stored.length,
    sound: drift.length === 0,
    drift,
    rebuildSet,
  };
}
