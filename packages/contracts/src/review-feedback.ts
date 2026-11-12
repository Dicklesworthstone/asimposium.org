import { z } from "zod";

export const REVIEW_FEEDBACK_SAMPLE_LIMIT = 128;
export const REVIEW_FEEDBACK_OMISSION_REASONS = [
  "sample_limit",
  "content_unavailable",
  "invalid_timestamp",
] as const;
const ReviewFeedbackBaseSchema = z
  .object({
    basis: z.literal("first-readable-non-author-review-on-version"),
    through_seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    sample_limit: z.literal(REVIEW_FEEDBACK_SAMPLE_LIMIT),
    sampled_versions: z.number().int().nonnegative().max(REVIEW_FEEDBACK_SAMPLE_LIMIT),
    unreviewed_versions: z.number().int().nonnegative().max(REVIEW_FEEDBACK_SAMPLE_LIMIT),
    unmeasurable_versions: z.number().int().nonnegative().max(REVIEW_FEEDBACK_SAMPLE_LIMIT),
    omitted: z.array(z.enum(REVIEW_FEEDBACK_OMISSION_REASONS)).max(3),
  })
  .strict();

/** Descriptive history, never a forecast or scientific rating. Standard JSON
 * Schema describes the shape/null branches; Zod also checks counter arithmetic. */
export const ReviewFeedbackSchema = z
  .union([
    ReviewFeedbackBaseSchema.extend({
      reviewed_versions: z.literal(0),
      median_first_review_seconds: z.null(),
    }),
    ReviewFeedbackBaseSchema.extend({
      reviewed_versions: z.number().int().positive().max(REVIEW_FEEDBACK_SAMPLE_LIMIT),
      median_first_review_seconds: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER),
    }),
  ])
  .superRefine((value, context) => {
    if (
      value.sampled_versions !==
      value.reviewed_versions + value.unreviewed_versions + value.unmeasurable_versions
    )
      context.addIssue({
        code: "custom",
        path: ["sampled_versions"],
        message: "sampled versions must equal measured, waiting and unmeasurable versions",
      });
    const indices = value.omitted.map((reason) => REVIEW_FEEDBACK_OMISSION_REASONS.indexOf(reason));
    if (indices.some((index, position) => index <= (indices[position - 1] ?? -1)))
      context.addIssue({
        code: "custom",
        path: ["omitted"],
        message: "omissions must be unique and in canonical order",
      });
    const hasUnmeasurable = value.unmeasurable_versions > 0;
    if (value.omitted.includes("invalid_timestamp") !== hasUnmeasurable)
      context.addIssue({
        code: "custom",
        path: ["omitted"],
        message: "invalid clocks must be disclosed exactly when a reviewed version is unmeasurable",
      });
  })
  .describe(
    "Historical observation, not a forecast. sampled_versions equals reviewed_versions + unreviewed_versions + unmeasurable_versions; counter arithmetic and canonical omissions are enforced by the Zod consumer.",
  );
export type ReviewFeedback = z.infer<typeof ReviewFeedbackSchema>;
