/** Canonical publications that a synthesis can summarize at its frozen cut.
 * Keep anchor selection and freshness on the same producer census. */
export const SYNTHESIS_ANCHOR_EVENT_TYPES = {
  claim: ["claim.created", "claim.revised", "claim.reanchored"],
  evidence: ["evidence.created"],
  review: ["review.created"],
  hypothesis: [
    "hypothesis.created",
    "hypothesis.killed",
    "hypothesis.deferred",
    "hypothesis.resumed",
    "hypothesis.narrowed",
    "hypothesis.superseded",
  ],
  "dead-end": ["dead_end.recorded"],
  gap: ["gap.filed", "gap.closed-by", "gap.withdrawn"],
  conflict: ["conflict.normalized", "conflict.resolved"],
  citation: ["citation.recorded", "citation.corrected"],
  statement: ["problem.admitted", "problem.statement-revised"],
} as const;

/** Synthesis freshness describes changes to the state being summarized. It
 * does not grant ranking, activity or dormancy credit under Fable §9.6.
 * In particular, a revised formulation invalidates an older summary even
 * when that revision earns no object-level activity credit. Retractions,
 * disputed relations and problem outcomes can also change its conclusions.
 *
 * Match both the producer and object kind: leases reuse scientific object
 * kinds, but acquiring one does not change the underlying scientific record.
 * No content bodies are needed or returned by this envelope-only predicate. */
export function synthesisMaterialEventSql(alias: string): string {
  const producers: Readonly<Record<string, readonly string[]>> = {
    ...Object.fromEntries(
      Object.entries(SYNTHESIS_ANCHOR_EVENT_TYPES).map(([kind, types]) => [
        kind === "statement" ? "problem" : kind === "dead-end" ? "dead_end" : kind,
        types,
      ]),
    ),
    problem: [
      ...SYNTHESIS_ANCHOR_EVENT_TYPES.statement,
      "problem.statement-reviewed",
      "problem.result-review-started",
      "problem.resolved",
      "problem.retired",
    ],
    relation: ["relation.asserted", "relation.disputed"],
    retraction: ["object.retracted"],
  };
  return `(${Object.entries(producers)
    .map(
      ([kind, types]) =>
        `(${alias}.object_kind = '${kind}' AND ${alias}.type IN (${types.map((type) => `'${type}'`).join(", ")}))`,
    )
    .join(" OR ")})`;
}
