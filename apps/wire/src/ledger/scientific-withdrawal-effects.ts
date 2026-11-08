import {
  EvidenceResponseSchema,
  GroundedFalsificationCheckSchema,
  type ScientificEvidenceReference,
  ScientificProvenanceSchema,
} from "@asimposium/contracts";
import { scientificEvidenceClassEligible } from "./evidence-grounding.ts";

/** Withdrawal or unavailable grounding removes positive authority, not history
 * or negative knowledge. The caller supplies one cursor-bounded snapshot and
 * only its digest-checked, currently readable payloads in `contents`. */
export interface WithdrawalInputRow {
  readonly claim_id: string;
  readonly event_id: string;
  readonly seq: number;
  readonly type: string;
  readonly object_id: string;
  readonly object_version: number;
  readonly target_version: number;
  readonly payload_sha256: string;
  readonly fellow_id: string;
  readonly withdrawn_event_id?: string | null;
  readonly withdrawn_kind?: string | null;
  readonly withdrawn_sha256?: string | null;
}

export function scientificInputEffects(
  rows: readonly WithdrawalInputRow[],
  contents: ReadonlyMap<string, Record<string, unknown>>,
): { withdrawnEvents: ReadonlySet<string>; invalidatedEvidence: ReadonlySet<string> } {
  const byEvent = new Map(rows.map((row) => [row.event_id, row]));
  const withdrawnEvents = new Set<string>();
  const invalidatedEvidence = new Set<string>();
  for (const row of rows) {
    if (row.type !== "object.retracted" || !row.withdrawn_event_id) continue;
    const original = byEvent.get(row.withdrawn_event_id);
    if (
      !original ||
      original.seq >= row.seq ||
      original.claim_id !== row.claim_id ||
      original.fellow_id !== row.fellow_id ||
      original.target_version !== row.target_version ||
      original.object_version !== 1 ||
      original.payload_sha256 !== row.withdrawn_sha256 ||
      !["evidence", "review"].includes(row.withdrawn_kind ?? "") ||
      original.type !== `${row.withdrawn_kind}.created`
    )
      continue;
    const payload = contents.get(row.event_id);
    // Missing/redacted explanation cannot resurrect support: the immutable
    // withdrawal index and author-attributed envelopes retain the withdrawal.
    // An available but contradictory payload, however, is not a valid witness.
    if (
      payload &&
      (payload.target_object !== original.object_id ||
        payload.target_event_id !== original.event_id ||
        payload.target_kind !== row.withdrawn_kind ||
        payload.target_digest !== `sha256:${original.payload_sha256}` ||
        payload.claim_id !== row.claim_id ||
        payload.claim_version !== row.target_version)
    )
      continue;
    withdrawnEvents.add(original.event_id);
    if (original.type === "evidence.created") invalidatedEvidence.add(original.object_id);
  }

  // Exact evidence dependencies form a graph. A surviving check derived from
  // withdrawn, hidden, redacted or corrupt evidence cannot become a fresh
  // independent basis merely because it has another evidence id. Current
  // content controls apply even to an earlier cursor's scientific standing.
  const evidence = new Map(
    rows.filter((row) => row.type === "evidence.created").map((row) => [row.object_id, row]),
  );
  const dependents = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.type !== "evidence.created") continue;
    const payload = contents.get(row.event_id);
    const references = payload ? evidenceDependencies(payload) : null;
    if (
      references === null ||
      !EvidenceResponseSchema.shape.computed_class.safeParse(payload?.computed_class).success
    ) {
      invalidatedEvidence.add(row.object_id);
      continue;
    }
    for (const reference of references) {
      const values = dependents.get(reference.evidence_id) ?? new Set<string>();
      values.add(row.object_id);
      dependents.set(reference.evidence_id, values);
      const source = evidence.get(reference.evidence_id);
      const body = source && contents.get(source.event_id);
      if (
        !source ||
        !body ||
        reference.digest !== `sha256:${source.payload_sha256}` ||
        source.seq >= row.seq ||
        source.claim_id !== row.claim_id ||
        source.target_version !== row.target_version ||
        body.bears_on_kind !== "claim" ||
        body.bears_on_id !== row.claim_id ||
        body.bears_on_version !== row.target_version ||
        body.mode !== "confirmatory" ||
        body.selected_hypothesis_id != null ||
        !scientificEvidenceClassEligible(body) ||
        typeof body.kind !== "string" ||
        typeof body.direction !== "string" ||
        typeof body.body_md !== "string" ||
        body.body_md.trim().length === 0
      )
        invalidatedEvidence.add(row.object_id);
    }
  }
  // Traverse once, not a repeated fixed-point scan. Free-form references are
  // not grounding pins and cannot invalidate unrelated scientific work.
  const pending = [...invalidatedEvidence];
  for (let index = 0; index < pending.length; index++) {
    for (const dependent of dependents.get(pending[index]!) ?? []) {
      if (invalidatedEvidence.has(dependent)) continue;
      invalidatedEvidence.add(dependent);
      pending.push(dependent);
    }
  }
  return { withdrawnEvents, invalidatedEvidence };
}

function evidenceDependencies(
  payload: Record<string, unknown>,
): ScientificEvidenceReference[] | null {
  const references: ScientificEvidenceReference[] = [];
  if (payload.falsification_check != null) {
    const check = GroundedFalsificationCheckSchema.safeParse(payload.falsification_check);
    if (
      !check.success ||
      new Set(check.data.evidence.map((ref) => ref.evidence_id)).size !== check.data.evidence.length
    )
      return null;
    references.push(...check.data.evidence);
  }
  if (payload.scientific_provenance != null) {
    const provenance = ScientificProvenanceSchema.safeParse(payload.scientific_provenance);
    if (!provenance.success) return null;
    const methodEvidence = provenance.data.method?.evidence ?? [];
    if (new Set(methodEvidence.map((ref) => ref.evidence_id)).size !== methodEvidence.length)
      return null;
    references.push(...methodEvidence);
  }
  return references;
}

/** A withdrawal is not a resolution of an adverse finding. Keep its original
 * recorded weight; do not grant weight to a previously weightless review. */
export function isNegativeReview(payload: Record<string, unknown> | undefined): boolean {
  return (
    payload?.verdict === "refute" ||
    payload?.verdict === "fails-to-reproduce" ||
    (Array.isArray(payload?.rubric) &&
      payload.rubric.some(
        (value) => value === "statement-defect" || value === "statement-fails-review",
      ))
  );
}
