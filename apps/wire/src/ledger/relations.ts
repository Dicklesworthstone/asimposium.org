/**
 * W5.5 typed claim relations (Fable §6.4a, ADR-21): pure helpers for the
 * edge model. An edge is an assertion, not a fact — it is version-pinned at
 * BOTH ends and its pins are checked against current heads at read time, so a
 * material revision never silently carries an old edge forward.
 *
 * The dispute lifecycle (asserted → disputed via review-gate events) lands
 * with the review-gate extension; this module owns the parts that are already
 * mechanical: canonical target refs, composite event ids, and pin staleness.
 */

export const CLAIM_RELATION_KINDS = [
  "implies",
  "equivalent-to",
  "contradicts",
  "narrows",
  "generalizes",
  "uses-definition",
  "addresses-gap",
] as const;

export type ClaimRelationKindName = (typeof CLAIM_RELATION_KINDS)[number];

export function isClaimRelationKind(value: string): value is ClaimRelationKindName {
  return (CLAIM_RELATION_KINDS as readonly string[]).includes(value);
}

/** Canonical pinned target refs: "C-7@2" (claim) or "G-2" (proof gap). */
export interface ParsedRelationTarget {
  readonly kind: "claim" | "gap";
  readonly claimId?: string;
  readonly version?: number;
  readonly gapId?: string;
}

export function parseRelationTarget(ref: string): ParsedRelationTarget | null {
  if (ref.startsWith("G-")) {
    if (!/^G-[0-9]+$/.test(ref)) return null;
    return { kind: "gap", gapId: ref };
  }
  const match = /^(C-[A-Za-z0-9][A-Za-z0-9._:-]*)@([0-9]+)$/.exec(ref);
  if (match === null) return null;
  const version = Number(match[2]);
  if (!Number.isSafeInteger(version) || version < 1) return null;
  return { kind: "claim", claimId: match[1], version };
}

/**
 * The deterministic ledger object id for one asserted edge. This is storage
 * identity only — the public cite for an edge is its assertion event (#seq).
 */
export function relationObjectId(input: {
  readonly sourceClaimId: string;
  readonly sourceVersion: number;
  readonly kind: ClaimRelationKindName;
  readonly targetRef: string;
}): string {
  return `${input.sourceClaimId}@${input.sourceVersion}-${input.kind}-${input.targetRef}`;
}

/**
 * Pin staleness at read time: an edge is `superseded` when either pinned
 * endpoint has a newer head on the problem — the assertion was made about
 * those exact statements, and Fable §6.4a forbids an edge from silently
 * surviving a material revision. Gap targets have no versions to drift.
 */
export function relationPinState(input: {
  readonly sourceVersion: number;
  readonly targetRef: string;
  readonly sourceHead: number;
  readonly targetHead?: number;
}): "current" | "superseded" {
  if (input.sourceVersion !== input.sourceHead) return "superseded";
  const target = parseRelationTarget(input.targetRef);
  if (target === null || target.kind === "gap") return "current";
  if (input.targetHead === undefined) return "current";
  return (target.version ?? 0) === input.targetHead ? "current" : "superseded";
}
