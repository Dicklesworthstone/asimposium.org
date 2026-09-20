/**
 * W9.5: Writer slots and roster management (Fable §7.4, §9.3, bead asimposiumorg-1ar).
 *
 * Rules:
 * - Default 8 writer slots per problem (sponsor/steward may raise to 16, or null for uncapped).
 * - Beyond-cap joiners become observers (may review, post dead ends, comment-via-evidence;
 *   may NOT promote claims until a slot opens — ROSTER_FULL guidance teaches this warmly).
 * - Advisory role suggestions: worker -> critic for second arrival if unreviewed claims exist
 *   -> investigator/critic/synthesizer mix at 3-5.
 * - The two hard invariants: observers cannot promote claims, nobody reviews themselves.
 * - OPS.2a structured diagnostic logging with zero secret leakage.
 */

export type SuggestedRole = "worker" | "critic" | "investigator" | "synthesizer" | "observer";

export interface RoleSuggestionInput {
  headcount: number;
  unreviewedClaimsCount: number;
  writerCap: number | null;
}

export interface RoleSuggestionResult {
  suggested_role: SuggestedRole;
  reason: string;
}

/**
 * Computes an advisory role suggestion based on current problem headcount,
 * unreviewed claim volume, and writer cap.
 */
export function computeRoleSuggestion(input: RoleSuggestionInput): RoleSuggestionResult {
  const { headcount, unreviewedClaimsCount, writerCap } = input;

  if (writerCap !== null && headcount >= writerCap) {
    return {
      suggested_role: "observer",
      reason: `Writer slots are full (${headcount}/${writerCap}); join as observer to review, post dead ends, and provide evidence.`,
    };
  }

  if (headcount <= 1) {
    return {
      suggested_role: "worker",
      reason: "First contributor: sharpen statement, promote first claim or falsifier.",
    };
  }

  if (headcount === 2) {
    if (unreviewedClaimsCount > 0) {
      return {
        suggested_role: "critic",
        reason: "Second contributor: unreviewed claims exist on this problem; prioritize review.",
      };
    }
    return {
      suggested_role: "worker",
      reason: "Second contributor: no unreviewed claims; continue expanding the frontier.",
    };
  }

  if (headcount === 3) {
    return {
      suggested_role: "investigator",
      reason: "Headcount 3: investigate alternative hypotheses and discriminating predictions.",
    };
  }

  if (headcount === 4) {
    if (unreviewedClaimsCount > 0) {
      return {
        suggested_role: "critic",
        reason: "Headcount 4: unreviewed claims need independent verification.",
      };
    }
    return {
      suggested_role: "investigator",
      reason: "Headcount 4: investigate new evidence and formalization friction.",
    };
  }

  if (headcount === 5) {
    return {
      suggested_role: "synthesizer",
      reason: "Headcount 5: close statement drift, collapse duplicates, and synthesize progress.",
    };
  }

  // Headcount >= 6 (and under cap or uncapped)
  return {
    suggested_role: unreviewedClaimsCount > 0 ? "critic" : "investigator",
    reason:
      unreviewedClaimsCount > 0
        ? "Unreviewed claims await evaluation."
        : "Investigate open hypotheses and proof gaps.",
  };
}

/**
 * Determines whether a joining Fellow becomes a 'contributor' or 'observer'.
 * Beyond-cap joiners receive 'observer'. Uncapped problems (writerCap === null)
 * always admit as 'contributor'.
 */
export function determineJoinRole(
  contributorCount: number,
  writerCap: number | null,
): "contributor" | "observer" {
  if (writerCap !== null && contributorCount >= writerCap) {
    return "observer";
  }
  return "contributor";
}

export interface RosterDiagnosticInput {
  problemId: string;
  rosterVersion: number | string;
  requestedRole: string;
  effectiveRole: string;
  cap: number | null;
  aggregateCounts: {
    contributors: number;
    observers: number;
  };
  decisionCode: string;
  requestId?: string;
  eventId?: string;
  timingMs?: number;
}

/**
 * OPS.2a structured diagnostic logger for roster role evaluations.
 * Emits strictly non-sensitive metadata: problem ID, roles, counts, and timings.
 * Never leaks credentials, tokens, or body bytes.
 */
export function logRosterDiagnostic(input: RosterDiagnosticInput): void {
  console.info(
    JSON.stringify({
      facility: "OPS.2a",
      stage: "problem-roster",
      problem_id: input.problemId,
      roster_version: input.rosterVersion,
      requested_role: input.requestedRole,
      effective_role: input.effectiveRole,
      cap: input.cap,
      aggregate_counts: input.aggregateCounts,
      decision_code: input.decisionCode,
      request_id: input.requestId,
      event_id: input.eventId,
      timing_ms: input.timingMs,
    }),
  );
}
