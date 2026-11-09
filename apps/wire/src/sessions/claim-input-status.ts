import { eventTailPath } from "@asimposium/contracts/event-tail";
import { ScientificWithdrawalRequestSchema } from "@asimposium/contracts/scientific-withdrawals";
import {
  DEPENDENCY_SCIENCE_ROW_LIMIT,
  type DependencyScientificRow,
} from "../ledger/claim-dependency-assessment.ts";
import { checkedScientificPayload, ScientificInputError } from "../ledger/scientific-checks.ts";
import { scientificInputEffects } from "../ledger/scientific-withdrawal-effects.ts";

export interface ClaimInputStatus {
  withdrawal: "withdrawn" | "not-recorded" | "unavailable";
  positive_authority: "removed" | "not-assessed" | "unavailable";
  grounding?: "invalidated";
  withdrawal_event?: {
    id: string;
    seq: number;
    digest: string;
    reason: string | null;
    read_url: string;
  };
  context?: string;
  standing_url?: string;
}

/** The displayed records share the bounded scientific snapshot already read
 * for premise assessment. A display-page limit must never hide a later
 * withdrawal, and missing explanation bytes must never resurrect support.
 * This annotates retained history; the canonical fold still decides standing.
 */
export async function claimInputStatuses(
  sources: readonly DependencyScientificRow[],
  problem: string,
  target: string,
  through: number,
): Promise<{
  forRecord: (
    event: string,
    object: string,
    kind: "evidence" | "review",
    digest: string,
  ) => ClaimInputStatus;
}> {
  const [claim, version] = target.split("@");
  const rows = sources.filter(
    (row) =>
      row.problem_id === problem &&
      row.claim_id === claim &&
      row.target_version === Number(version) &&
      Number.isSafeInteger(row.seq) &&
      row.seq > 0 &&
      row.seq <= through,
  );
  const complete =
    sources.length <= DEPENDENCY_SCIENCE_ROW_LIMIT &&
    sources.every((row) => row.scan_complete === 1) &&
    rows.some(
      (row) =>
        row.object_id === claim &&
        row.object_version === Number(version) &&
        (row.type === "claim.created" || row.type === "claim.revised"),
    );
  const contents = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (row.payload_json === null) continue;
    try {
      contents.set(
        row.event_id,
        await checkedScientificPayload({ ...row, payload_json: row.payload_json }),
      );
    } catch (error) {
      if (!(error instanceof ScientificInputError)) throw error;
    }
  }
  const effects = scientificInputEffects(rows, contents);
  const byEvent = new Map(rows.map((row) => [row.event_id, row]));
  const withdrawals = new Map<string, DependencyScientificRow>();
  for (const row of rows) {
    if (!row.withdrawn_event_id || !effects.withdrawnEvents.has(row.withdrawn_event_id)) continue;
    const original = byEvent.get(row.withdrawn_event_id);
    // Validate this exact witness with the canonical policy, including a
    // readable but contradictory explanation. No second withdrawal policy.
    if (
      original &&
      scientificInputEffects([original, row], contents).withdrawnEvents.has(original.event_id)
    )
      withdrawals.set(original.event_id, row);
  }
  const standing_url = `/p/${problem}/claims/${target}.json?through=${through}`;
  const unavailable = (): ClaimInputStatus => ({
    withdrawal: "unavailable",
    positive_authority: "unavailable",
    context:
      "The bounded scientific history is incomplete; this retained record is not current supporting authority.",
    standing_url,
  });
  return {
    forRecord(event, object, kind, digest) {
      const original = byEvent.get(event);
      if (
        !original ||
        original.object_id !== object ||
        original.type !== `${kind}.created` ||
        original.payload_sha256 !== digest
      )
        return unavailable();
      const withdrawal = withdrawals.get(event);
      if (withdrawal) {
        const reason = ScientificWithdrawalRequestSchema.shape.reason.safeParse(
          contents.get(withdrawal.event_id)?.reason,
        );
        return {
          withdrawal: "withdrawn",
          positive_authority: "removed",
          ...(kind === "evidence" ? { grounding: "invalidated" as const } : {}),
          withdrawal_event: {
            id: withdrawal.event_id,
            seq: withdrawal.seq,
            digest: `sha256:${withdrawal.payload_sha256}`,
            reason: reason.success ? reason.data : null,
            read_url: eventTailPath(problem, "json", {
              since: withdrawal.seq - 1,
              through: withdrawal.seq,
              limit: 1,
            }),
          },
          context:
            "Retained history: withdrawal removes positive authority. It does not resolve adverse findings or erase the original record.",
          standing_url,
        };
      }
      if (!complete) return unavailable();
      if (kind === "evidence" && effects.invalidatedEvidence.has(object))
        return {
          withdrawal: "not-recorded",
          positive_authority: "removed",
          grounding: "invalidated",
          context:
            "This record's grounding is withdrawn, unavailable or invalid. Its original content is retained as history, not current supporting authority.",
          standing_url,
        };
      return { withdrawal: "not-recorded", positive_authority: "not-assessed" };
    },
  };
}
