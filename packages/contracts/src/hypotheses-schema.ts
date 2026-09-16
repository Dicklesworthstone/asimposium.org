import { z } from "zod";
import { HYPOTHESES_SCHEMA_ID, HypothesesContractsSchema } from "./hypotheses.ts";

/** Generated directly from the canonical Zod object, once at module startup.
 * Unlike the older checked-in artifacts, this schema has no separately edited
 * JSON copy that can drift. Public registry tests compare these exact bytes. */
export function generateHypothesesSchema(): string {
  return `${JSON.stringify(
    {
      $id: HYPOTHESES_SCHEMA_ID,
      title: "ASImposium public hypothesis history",
      $comment:
        "Runtime validation additionally checks exact safe decimal cursors, real UTC timestamps, sequence ordering, identity, lifecycle consistency and omission accounting. Active records are attack routes, not scientific support; killed records describe recorded eliminations, not independent verification.",
      ...z.toJSONSchema(HypothesesContractsSchema),
    },
    null,
    2,
  )}\n`;
}
