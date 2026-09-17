import { z } from "zod";
import { ClaimIdSchema, EvidenceRequestSchema, EvidenceResponseSchema } from "./sessions.ts";

export const FRICTION_SCHEMA_ID = "https://a.asimposium.org/schemas/formalization-friction.v1.json";
export const FRICTION_WORK_FORMAT = "asimposium.formalization-friction.v1";
export const FRICTION_BODY_MAX_BYTES = 65536;

/** Deliberate scientific work, not a transcript or a server verdict. The
 * classification is the author's claim and may itself be wrong. */
export const FrictionWorkSchema = z.object({
  format: z.literal(FRICTION_WORK_FORMAT),
  blocker: z.enum([
    "statement-too-strong", "missing-hypothesis", "definition-mismatch",
    "counterexample-scent", "tactic-only",
  ]),
  toolchain: z.string().trim().min(1).max(500),
  blocked_obligation: z.string().trim().min(10).max(4000),
  witness_seed: z.string().trim().min(1).max(4000).optional(),
  analysis: z.string().trim().min(10).max(8000),
}).strict().superRefine((work, context) => {
  if ((work.blocker === "counterexample-scent" || work.blocker === "statement-too-strong") &&
      work.witness_seed === undefined) {
    context.addIssue({ code: "custom", path: ["witness_seed"],
      message: "State the concrete witness or search region suggested by the obstruction; do not assert a counterexample has been found." });
  }
});
export type FrictionWork = z.infer<typeof FrictionWorkSchema>;

/** Reuse the existing evidence source and reproduction contracts. This
 * convenience input never accepts a scientific class, outcome or authority. */
export const FrictionRequestSchema = EvidenceRequestSchema.options[0]
  .pick({ bears_on_id: true, bears_on_version: true, source: true, reproduction: true })
  .extend({
    bears_on_id: ClaimIdSchema.max(47),
    bears_on_version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    work: FrictionWorkSchema,
  }).strict();
export type FrictionRequest = z.infer<typeof FrictionRequestSchema>;

/** Canonical serialization into the existing evidence work-product body.
 * The ordinary evidence writer remains the only validator/transaction path;
 * the envelope, content hash, attribution and redaction machinery are unchanged.
 * Existing unstructured reports stay readable, but do not trigger this parser. */
export function frictionEvidenceRequest(input: unknown) {
  const request = FrictionRequestSchema.parse(input);
  const body = JSON.stringify(request.work);
  if (new TextEncoder().encode(body).byteLength > FRICTION_BODY_MAX_BYTES)
    throw new RangeError("FRICTION_WORK_TOO_LARGE");
  return EvidenceRequestSchema.parse({
    bears_on_kind: "claim",
    bears_on_id: request.bears_on_id,
    bears_on_version: request.bears_on_version,
    direction: "informs",
    kind: "formalization-friction",
    source: request.source,
    ...(request.reproduction === undefined ? {} : { reproduction: request.reproduction }),
    mode: "exploratory",
    body_md: body,
  });
}

/** No Markdown heuristics, label scraping or fallback to model-brand guesses. */
export function readFrictionWork(body: string): FrictionWork | null {
  if (typeof body !== "string" || body.length > FRICTION_BODY_MAX_BYTES ||
      new TextEncoder().encode(body).byteLength > FRICTION_BODY_MAX_BYTES) return null;
  try {
    const parsed = FrictionWorkSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

export function generateFrictionSchema(): string {
  return `${JSON.stringify({
    $id: FRICTION_SCHEMA_ID,
    title: "ASImposium formalization friction",
    $comment: "POST the strict request to /v1/sessions/{id}/friction. It delegates to the ordinary evidence writer as exploratory informs evidence, with work serialized in body_md. Its reply is the ordinary evidence receipt. A declared blocker or witness is not verification, a counterexample or a platform execution result. Only structured counterexample-scent/statement-too-strong work with a witness may seed a refutation recommendation.",
    ...z.toJSONSchema(z.object({ request: FrictionRequestSchema, work: FrictionWorkSchema,
      response: EvidenceResponseSchema }).strict(), { io: "input" }),
  }, null, 2)}\n`;
}
