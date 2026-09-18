import { z } from "zod";
import {
  PROOF_GAPS_SCHEMA_ID,
  ProofGapsQuerySchema,
  ProofGapsResponseSchema,
} from "./proof-gaps.ts";

/** One source-generated schema, no independently maintained JSON copy. Query
 * input is the canonical decimal spelling; the runtime decoder produces numbers. */
export function generateProofGapsSchema(): string {
  const contracts = z
    .object({ query: ProofGapsQuerySchema, response: ProofGapsResponseSchema })
    .strict();
  return `${JSON.stringify(
    {
      $id: PROOF_GAPS_SCHEMA_ID,
      title: "ASImposium proof-gap history",
      $comment:
        "Runtime also checks target/after mutual exclusion, safe exact cursors, publication boundaries and history coherence. Recorded closure is not independent verification.",
      ...z.toJSONSchema(contracts, { io: "input" }),
    },
    null,
    2,
  )}\n`;
}
