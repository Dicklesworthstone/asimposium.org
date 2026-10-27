import {
  type ProofGapsQuery,
  ProofGapsQuerySchema,
  type ProofGapsResponse,
} from "@asimposium/contracts/proof-gaps";

/** The canonical query schema owns syntax; the snapshot also bounds its continuation. */
export function parseProofGapQuery(value: unknown): ProofGapsQuery | null {
  const parsed = ProofGapsQuerySchema.safeParse(value);
  if (!parsed.success || (parsed.data.through !== undefined &&
    (parsed.data.after ?? 0) > parsed.data.through)) return null;
  return parsed.data;
}

export function proofGapQueryString(query: ProofGapsQuery): string {
  const params = new URLSearchParams();
  if (query.through !== undefined) params.set("through", String(query.through));
  if (query.after !== undefined) params.set("after", String(query.after));
  if (query.target !== undefined) params.set("target", query.target);
  return params.size === 0 ? "" : `?${params}`;
}

export function proofGapPagePath(problem: string, query: ProofGapsQuery = {}): string {
  return `/p/${encodeURIComponent(problem)}/gaps${proofGapQueryString(query)}`;
}

/** Do not display another problem, target, or cursor under this page's heading.
 * Nor may a malformed continuation skip or repeat obligations. */
export function proofGapsMatchQuery(
  problem: string,
  query: ProofGapsQuery,
  face: ProofGapsResponse,
): boolean {
  if (face.problem_id !== problem || face.target !== (query.target ?? null) ||
    face.after !== (query.after ?? 0) || face.after > face.cursor ||
    (query.through !== undefined && face.cursor !== query.through) ||
    (face.target !== null && (face.gaps.length > 1 || face.next_after !== null)) ||
    (face.next_after !== null && (face.next_after <= face.after ||
      face.next_after > face.cursor || face.next_after !== face.gaps.at(-1)?.filing.seq)) ||
    face.omitted.includes("page_limit") !== (face.next_after !== null)) return false;
  let previous = face.after;
  for (const gap of face.gaps) {
    if (gap.gap_id !== `G-${gap.filing.seq}` || gap.filing.seq <= previous ||
      gap.filing.seq > face.cursor || gap.last_event.seq < gap.filing.seq ||
      gap.last_event.seq > face.cursor ||
      (face.target !== null && gap.gap_id !== face.target) ||
      (gap.content === null && gap.status !== "unavailable") ||
      (gap.status === "closed-by" ? gap.closed_by === null : gap.closed_by !== null)) return false;
    previous = gap.filing.seq;
  }
  return true;
}

/** Closing references are rendered as text unless they identify an existing public route. */
export function proofGapClosingPath(problem: string, reference: string, cursor: number): string | null {
  const problemPath = `/p/${encodeURIComponent(problem)}`;
  if (/^C-[1-9][0-9]*(?:@[1-9][0-9]*)?$/.test(reference))
    return `${problemPath}/claims/${encodeURIComponent(reference)}?through=${cursor}`;
  if (/^E-[0-9A-HJKMNP-TV-Z]{1,78}$/.test(reference))
    return `/r${problemPath}/evidence/${encodeURIComponent(reference)}`;
  return null;
}
