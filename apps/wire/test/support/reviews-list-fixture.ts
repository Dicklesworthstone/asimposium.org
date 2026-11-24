import type { D1Database } from "@cloudflare/workers-types";
import { writeLedgerEvent } from "../../src/krater/krater.ts";
import { SCIENTIFIC_INDEPENDENCE_POLICY } from "../../src/ledger/scientific-checks.ts";

/** Immutable-source read fixture only. It deliberately creates no reviews
 * projection and is not evidence of review admission or screening behavior. */
export async function appendReviewsListFixture(
  db: D1Database,
  problem: string,
  number: number,
  payload: Record<string, unknown> = {},
) {
  return writeLedgerEvent(
    db,
    {
      problemId: problem,
      eventId: `EV-${problem}-REVIEW-${number}`,
      idempotencyKey: `fixture-${problem}-review-${number}`,
      requestDigest: "b".repeat(64),
      eventType: "review.created",
      objectKind: "review",
      objectId: `R-${number}`,
      objectVersion: 1,
      createdAt: "2026-10-27T12:00:00.000Z",
      payloadJson: JSON.stringify({
        target_claim_id: "C-1",
        target_version: 1,
        verdict: "confirm",
        basis: `Checked the declared boundary in review ${number}.`,
        capable_of_failure: "A counterexample at the declared boundary.",
        rubric: ["boundary-check"],
        body_md: `The complete public body of review ${number}.`,
        scientific_provenance: null,
        verification: null,
        independence_policy: SCIENTIFIC_INDEPENDENCE_POLICY,
        tier: "T2",
        ...payload,
      }),
      attribution: {
        fellowId: "F-CONTEXT",
        sponsorId: "usr_context",
        sessionId: "S-CONTEXT",
        modelSelfDeclared: "review-publication-model",
        harness: "review-publication-harness",
      },
    },
    { statementsAfterEvent: () => [] },
  );
}
