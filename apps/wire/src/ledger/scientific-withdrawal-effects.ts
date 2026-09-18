/** Withdrawal removes positive authority, not history or negative knowledge.
 * The caller supplies one cursor-bounded, digest-checked ledger snapshot. */
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

export function scientificWithdrawalEffects(
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

  // Explicit evidence dependencies form a graph. A surviving check derived
  // from withdrawn evidence cannot become a fresh independent basis merely
  // because it was recorded under another evidence id. Traverse once, not a
  // repeated fixed-point scan, and never search free-form bodies for references.
  const dependents = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.type !== "evidence.created") continue;
    const payload = contents.get(row.event_id);
    if (!payload) continue;
    for (const reference of evidenceDependencies(payload)) {
      const values = dependents.get(reference) ?? new Set<string>();
      values.add(row.object_id);
      dependents.set(reference, values);
    }
  }
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

function evidenceDependencies(payload: Record<string, unknown>): string[] {
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const check = record(payload.falsification_check);
  const method = record(record(payload.scientific_provenance)?.method);
  const refs = [check?.evidence, method?.evidence];
  return refs.flatMap((values) =>
    Array.isArray(values)
      ? values.flatMap((value) => {
          const reference = record(value);
          return typeof reference?.evidence_id === "string" ? [reference.evidence_id] : [];
        })
      : [],
  );
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
