import { z } from "zod";

/** Fable §6.1: authored research boundaries travel with the exact formulation.
 * The optional wire bundle preserves historical records without inventing
 * missing context; a partial bundle is never a complete formulation. */
export const PROBLEM_STATEMENT_BOUNDARY_MAX_LENGTH = 4096;
const ProblemBoundaryTextSchema = z
  .string()
  .min(1)
  .max(PROBLEM_STATEMENT_BOUNDARY_MAX_LENGTH)
  .regex(/\S/, "A problem boundary must contain non-whitespace text");
export const ProblemStatementBoundariesSchema = z
  .object({
    scope: ProblemBoundaryTextSchema,
    out_of_scope: ProblemBoundaryTextSchema,
    success_criteria: ProblemBoundaryTextSchema,
  })
  .strict();
export type ProblemStatementBoundaries = z.infer<typeof ProblemStatementBoundariesSchema>;
export const OptionalProblemBoundaryFields = ProblemStatementBoundariesSchema.partial().shape;
const ProblemBoundaryRequirements = {
  dependentRequired: {
    scope: ["out_of_scope", "success_criteria"],
    out_of_scope: ["scope", "success_criteria"],
    success_criteria: ["scope", "out_of_scope"],
  },
};

// This refinement checks presence only; the field schemas validate the text.
// Unknown includes explicit undefined from Zod's optional output, and also
// permits generic object shapes without widening their concrete schema type.
type BoundaryPresence = Partial<Record<keyof ProblemStatementBoundaries, unknown>>;

export function completeProblemBoundaries<T extends z.ZodType<BoundaryPresence>>(schema: T): T {
  return (
    schema
      .superRefine((value, context) => {
        const fields = ["scope", "out_of_scope", "success_criteria"] as const;
        const present = fields.filter((field) => value[field] !== undefined);
        if (present.length !== 0 && present.length !== fields.length)
          for (const field of fields)
            if (value[field] === undefined)
              context.addIssue({
                code: "custom",
                path: [field],
                message: "Provide scope, out_of_scope and success_criteria together",
              });
      })
      // Preserve the same dependency in published JSON Schema, where a custom
      // Zod refinement alone would otherwise disappear.
      .meta(ProblemBoundaryRequirements)
  );
}
