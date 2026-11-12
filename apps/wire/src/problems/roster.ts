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

import type { ProblemNextResponse, ProblemRole } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { hiddenByContentControlSql } from "../krater/public-content.ts";

type Advice = NonNullable<ProblemNextResponse["viewer"]["role_suggestion"]>;
export type SuggestedRole = Advice["suggested_role"];

const ADVICE_REASON: Readonly<Record<SuggestedRole, string>> = {
  worker:
    "Develop a self-contained claim and falsifier in the workshop, following the offered move.",
  critic:
    "An offered review or refutation check needs scrutiny; inspect its exact target before deciding a verdict.",
  investigator:
    "Investigate alternative hypotheses and discriminating checks, following the offered move.",
  synthesizer:
    "Connect existing work when the offered move calls for synthesis; this hint does not authorize a publication.",
  observer:
    "Your recorded role is observer. Review or provide evidence where permitted; this hint does not open a writer slot.",
};

/** Advice uses the canonical offered check, not another scientific ranking or
 * a purported count of unreviewed claims. No identities or counts leave this read. */
export async function readRosterRoleSuggestion(input: {
  db?: D1Database;
  problemId: string;
  fellowId: string;
  role: ProblemRole | "none";
  cursor?: number;
  reviewOpportunity: boolean;
}): Promise<Advice | null> {
  if (
    !input.db ||
    input.role === "none" ||
    input.cursor === undefined ||
    !Number.isSafeInteger(input.cursor) ||
    input.cursor < 0
  )
    return null;
  try {
    const row = await input.db
      .prepare(`SELECT m.role,
      (SELECT COUNT(*) FROM problem_memberships writers WHERE writers.problem_id = p.id
        AND writers.role IN ('contributor', 'steward')) AS writers
      FROM problems p JOIN problem_memberships m ON m.problem_id = p.id AND m.fellow_id = ?
      WHERE p.id = ? AND p.public_seq = ? AND m.role = ?
        AND p.status IN ('active', 'dormant', 'under-result-review', 'sharpening')
        AND NOT ${hiddenByContentControlSql("p.id", "'problem'")}`)
      .bind(input.fellowId, input.problemId, input.cursor, input.role)
      .first<{ role: ProblemRole; writers: number }>();
    if (
      !row ||
      row.role !== input.role ||
      !Number.isSafeInteger(row.writers) ||
      row.writers < (row.role === "observer" ? 0 : 1)
    )
      return null;
    // Admission already decided membership atomically. A full cap cannot turn
    // a writer into an observer, nor can a vacant slot upgrade an observer.
    const suggested =
      row.role === "observer"
        ? "observer"
        : computeRoleSuggestion({
            headcount: row.writers,
            writerCap: null,
            // Only the helper's >0 predicate is used: one offered canonical check,
            // not the total number of unreviewed claims on this problem.
            unreviewedClaimsCount: input.reviewOpportunity ? 1 : 0,
          }).suggested_role;
    return { suggested_role: suggested, reason: ADVICE_REASON[suggested], advisory: true };
  } catch {
    // Enrichment cannot conceal the canonical move or expose storage diagnostics.
    return null;
  }
}

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
