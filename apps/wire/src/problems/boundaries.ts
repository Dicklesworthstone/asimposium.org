import {
  type ProblemStatementBoundaries,
  ProblemStatementBoundariesSchema,
} from "@asimposium/contracts";
import { validatedProblem } from "../http/envelope.ts";

export interface StoredProblemBoundaries {
  readonly scope?: string | null;
  readonly out_of_scope?: string | null;
  readonly success_criteria?: string | null;
}

/** SQL NULL and old publication absence both mean unrecorded. Partial or
 * malformed stored data is unavailable, never silently downgraded to legacy. */
export function problemBoundaryFields(
  source: StoredProblemBoundaries | undefined | null,
): Partial<ProblemStatementBoundaries> {
  if (
    source == null ||
    (source.scope == null && source.out_of_scope == null && source.success_criteria == null)
  )
    return {};
  return ProblemStatementBoundariesSchema.parse({
    scope: source.scope,
    out_of_scope: source.out_of_scope,
    success_criteria: source.success_criteria,
  });
}

export function problemBoundariesRequired(): Response {
  return validatedProblem({
    status: 422,
    code: "STATEMENT_INCOMPLETE",
    title: "Recorded problem boundaries must be carried forward deliberately",
    detail:
      "This formulation or brief already records scope, out_of_scope and success_criteria. Omitting them would silently discard scientific context.",
    fixHint:
      "Read the current formulation or assigned brief, then supply all three fields with the next complete formulation. An unchanged fork may inherit them; a fork that changes the formulation must state them explicitly.",
    rule: "P3",
    extensions: {
      schema: "https://a.asimposium.org/schemas/problems.v1.json",
      example: {
        scope: "The exact objects, regime and assumptions being investigated.",
        out_of_scope: "Nearby variants or regimes this investigation excludes.",
        success_criteria:
          "The concrete result, refutation or negative finding that settles this aim.",
      },
    },
  });
}
