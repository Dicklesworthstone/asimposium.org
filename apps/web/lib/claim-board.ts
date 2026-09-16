import type {
  ClaimFaceResponse,
  ProblemFaceResponse,
  PublicClaimState,
} from "@asimposium/contracts";
import type { PublicRead } from "./public-ledger";

/** One parallel batch, never one unbounded request per claim in a problem digest. */
export const CLAIM_BOARD_MAX_STANDING_READS = 8;

type ClaimItem = Extract<ProblemFaceResponse["items"][number], { kind: "claim" }>;

export type ClaimBoardReader = (
  problem: string,
  target: string,
  origin: string,
  query: { through: string },
) => Promise<PublicRead<ClaimFaceResponse>>;

export interface ClaimBoardRow {
  readonly item: ClaimItem;
  readonly href: string;
  readonly standing:
    | {
        readonly state: "ok";
        readonly value: PublicClaimState;
        readonly sourceUnavailable: boolean;
      }
    | { readonly state: "unavailable" | "not_loaded" };
}

/** Links retain the same problem-local cursor even when a standing read fails. */
function snapshotHref(problem: string, target: string, cursor: number): string {
  return `/p/${encodeURIComponent(problem)}/claims/${encodeURIComponent(target)}?through=${cursor}`;
}

/**
 * Reuse Stoa's scientific fold; never infer standing from prose, activity or
 * governance status. All reads use the digest's cursor and deployment. Missing
 * or mismatched responses remain unknown, not "open". Only the first bounded
 * prefix is enriched; failure never starts replacement requests for later rows.
 *
 * The production reader bounds each response to PUBLIC_LEDGER_MAX_BYTES and
 * PUBLIC_LEDGER_TIMEOUT_MS. Eight concurrent reads therefore admit at most
 * eight MiB, with no sequential timeout multiplication or retry fan-out.
 */
export async function loadClaimBoard(
  face: ProblemFaceResponse,
  origin: string,
  readClaim: ClaimBoardReader,
): Promise<readonly ClaimBoardRow[]> {
  const claims = face.items.filter((item) => item.kind === "claim");
  const rows: ClaimBoardRow[] = claims.map((item) => ({
    item,
    href: snapshotHref(face.problem, item.id, face.cursor),
    standing: { state: "not_loaded" },
  }));
  const enriched = await Promise.all(
    rows.slice(0, CLAIM_BOARD_MAX_STANDING_READS).map(async (row): Promise<ClaimBoardRow> => {
      const unavailable: ClaimBoardRow = { ...row, standing: { state: "unavailable" } };
      try {
        const result = await readClaim(face.problem, row.item.id, origin, {
          through: String(face.cursor),
        });
        if (
          result.state !== "ok" ||
          result.origin !== origin ||
          result.data.problem !== face.problem ||
          result.data.cursor !== face.cursor ||
          result.data.claim_state.claim_id !== row.item.id
        ) {
          return unavailable;
        }
        const value = result.data.claim_state;
        const exact = result.data.items.find(
          (item) => item.kind === "claim-detail" && item.id === `${value.claim_id}@${value.version}`,
        );
        // A digest excerpt need not be the statement version whose standing was
        // computed. Never attach new standing to old text, or borrow an excerpt
        // when the exact public statement has been withdrawn or omitted.
        if (exact === undefined) return unavailable;
        return {
          item: {
            ...row.item,
            body: exact.body,
            why_included: exact.why_included,
            neutralized: exact.neutralized,
          },
          href: snapshotHref(face.problem, `${value.claim_id}@${value.version}`, face.cursor),
          standing: {
            state: "ok",
            value,
            sourceUnavailable:
              result.data.degraded.length > 0 ||
              result.data.omitted.some((entry) => entry.reason === "content_unavailable"),
          },
        };
      } catch {
        // A transport failure must not erase the readable problem digest.
        return unavailable;
      }
    }),
  );
  return [...enriched, ...rows.slice(CLAIM_BOARD_MAX_STANDING_READS)];
}
