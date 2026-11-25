import {
  type ClaimFaceResponse,
  type ProblemLifecycleActionRequest,
  PublicClaimTargetSchema,
} from "@asimposium/contracts";
import {
  type ClaimsListQuery,
  ClaimsListQuerySchema,
} from "@asimposium/contracts/claims-list";

export interface ResultClaimPreview {
  readonly problemId: string;
  readonly cursor: number;
  readonly origin: string;
  readonly state: ClaimFaceResponse["claim_state"];
  readonly publication: ClaimFaceResponse["items"][number];
  readonly command: Extract<ProblemLifecycleActionRequest, { action: "enter-result-review" }>;
}

export function parseResultClaimConsoleQuery(value: Readonly<Record<string, unknown>>): {
  readonly selected?: string;
  readonly list: ClaimsListQuery;
} | null {
  const { claim, claim_through, claim_after, ...unknown } = value;
  if (Object.keys(unknown).length > 0 || (claim !== undefined &&
    (typeof claim !== "string" || claim.trim() !== claim || !claim.includes("@") ||
     !PublicClaimTargetSchema.safeParse(claim).success))) return null;
  const parsed = ClaimsListQuerySchema.safeParse({ through: claim_through, after: claim_after });
  if (!parsed.success) return null;
  return { ...(claim === undefined ? {} : { selected: claim }), list: parsed.data };
}

/** Navigation retains the collection cut; the exact preview always rechecks the current record. */
export function resultClaimConsolePath(
  problemId: string,
  selected?: string,
  query: ClaimsListQuery = {},
): string {
  const params = new URLSearchParams();
  if (selected !== undefined) params.set("claim", selected);
  if (query.through !== undefined) params.set("claim_through", String(query.through));
  if (query.after !== undefined) params.set("claim_after", String(query.after));
  return `/console/problems/${encodeURIComponent(problemId)}${params.size === 0 ? "" : `?${params}`}`;
}
