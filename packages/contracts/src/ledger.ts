import { z } from "zod";

/**
 * Public ledger read faces (W6.1). First slice: the problems index.
 *
 * The entry mirrors the Krater `problems` projection exactly — identifiers,
 * sequence, timestamps. Titles, statements, and statuses arrive with the
 * problem lifecycle (W5.1) and extend this entry; they are never simulated.
 * `omitted[]` is mandatory on the response so every reader can see what the
 * face deliberately left out.
 */
/**
 * Krater ingress identifier law (krater.ts `IDENTIFIER`), established here so
 * the face contract — not storage trust — bounds every value the markdown
 * face interpolates into `- \`${id}\``. The charset excludes backticks,
 * whitespace, and control characters, so a row cannot escape its code span,
 * gain listing lines, or forge renderer structure (asimposiumorg-gfbc).
 */
const PROBLEM_INDEX_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Krater ingress timestamp law (`validateKraterIngressTimestamp` /
 * `CANONICAL_UTC_TIMESTAMP`): an exact canonical UTC instant at millisecond
 * precision. Digits and delimiters only — no markdown metacharacters.
 */
const PROBLEM_INDEX_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const ProblemIndexTimestampSchema = z
  .string()
  .regex(PROBLEM_INDEX_TIMESTAMP_PATTERN, "invalid canonical UTC timestamp");

export const ProblemIndexEntrySchema = z
  .object({
    id: z.string().max(128).regex(PROBLEM_INDEX_ID_PATTERN, "invalid problem index id"),
    public_seq: z.number().int().min(0),
    created_at: ProblemIndexTimestampSchema,
    updated_at: ProblemIndexTimestampSchema,
  })
  .strict();

export const ProblemsIndexResponseSchema = z
  .object({
    problems: z.array(ProblemIndexEntrySchema).max(200),
    omitted: z.array(z.string().min(1).max(160)),
  })
  .strict();

export type ProblemIndexEntry = z.infer<typeof ProblemIndexEntrySchema>;
export type ProblemsIndexResponse = z.infer<typeof ProblemsIndexResponseSchema>;

/**
 * The per-problem read face (W6.1): the JSON face of a problem-face projection
 * rendered through `@asimposium/render`. This is the contract the quarantined
 * `/p/<id>.json` route must satisfy before it un-quarantines — every field the
 * renderer emits, pinned. Untrusted item bodies are neutralized before render;
 * the face is the agent-canonical read of the public problem.
 */
const FaceNeutralizationSchema = z
  .object({
    marker: z.string().min(1),
    count: z.number().int().min(0),
  })
  .strict();

const FaceItemSchema = z
  .object({
    kind: z.string().min(1),
    id: z.string().min(1).max(80),
    scope: z.enum(["system", "ledger", "workshop"]),
    untrusted: z.boolean(),
    why_included: z.string().min(1),
    tokens: z.number().int().min(0).optional(),
    body: z.string(),
    neutralized: z.array(FaceNeutralizationSchema),
  })
  .strict();

const FaceNextActionSchema = z
  .object({
    method: z.enum(["GET", "POST"]),
    url: z.string().min(1),
    why: z.string().min(1),
  })
  .strict();

export const ProblemFaceResponseSchema = z
  .object({
    schema: z.literal("asimposium.problem-face.v1"),
    face: z.literal("json"),
    kind: z.literal("problem-face"),
    problem: z.string().min(1).max(80),
    profile: z.literal("face"),
    cursor: z.number().int().min(0),
    fingerprint: z.string().regex(/^fnv1a64:[0-9a-f]{16}$/),
    title: z.string().min(1),
    preamble: z.string().min(1),
    items: z.array(FaceItemSchema),
    omitted: z.array(
      z.object({ reason: z.string().min(1), detail: z.string().min(1).optional() }).strict(),
    ),
    next_actions: z.array(FaceNextActionSchema),
    degraded: z.array(z.string().min(1)),
  })
  .strict();
export type ProblemFaceResponse = z.infer<typeof ProblemFaceResponseSchema>;

/** The single generated JSON-Schema root for the public ledger read faces. */
export const LedgerContractsSchema = z
  .object({
    problem_index_entry: ProblemIndexEntrySchema,
    problems_index_response: ProblemsIndexResponseSchema,
    problem_face_response: ProblemFaceResponseSchema,
  })
  .strict();
