import { z } from "zod";
import {
  PUBLIC_CLAIM_TARGET_PATTERN,
  PUBLIC_LEDGER_PROBLEM_ID_PATTERN,
  SearchQueryRequestSchema,
  SearchResponseSchema,
} from "./search.ts";
import { ClaimIdSchema, NextActionSchema, PackNeutralizationSchema } from "./sessions.ts";

/**
 * Public ledger read faces (W6.1). First slice: the problems index.
 *
 * The entry mirrors the Krater `problems` projection: identifiers, sequence,
 * timestamps, saved title and lifecycle status. Legacy missing titles are null.
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
const PROBLEM_INDEX_ID_PATTERN = PUBLIC_LEDGER_PROBLEM_ID_PATTERN;

/**
 * Public-ledger problem identifiers use Krater's established bounded grammar,
 * narrowed only by the shared renderer's control-comment law: `--` can close
 * an HTML comment and therefore cannot be represented faithfully by Diptych.
 * This is deliberately not the newer session-only ProblemIdSchema; unifying
 * storage and lifecycle identifiers is a separate migration.
 */
export const PublicLedgerProblemIdSchema = z
  .string()
  .max(128)
  .regex(PROBLEM_INDEX_ID_PATTERN, "invalid public ledger problem id");
export type PublicLedgerProblemId = z.infer<typeof PublicLedgerProblemIdSchema>;

/**
 * Krater ingress timestamp law (`validateKraterIngressTimestamp` /
 * `CANONICAL_UTC_TIMESTAMP`): an exact canonical UTC instant at millisecond
 * precision. Digits and delimiters only — no markdown metacharacters.
 */
const PROBLEM_INDEX_TIMESTAMP_PATTERN =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;

function isRealCanonicalUtcInstant(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && new Date(parsed).toISOString() === value;
}

export const ProblemIndexTimestampSchema = z
  .string()
  .regex(PROBLEM_INDEX_TIMESTAMP_PATTERN, "invalid canonical UTC timestamp")
  .refine(isRealCanonicalUtcInstant, "invalid real canonical UTC instant");

// Shared by lifecycle writes and public projections. Keeping this definition
// below the common primitives avoids a ledger -> problems -> ledger cycle.
export const PROBLEM_STATUSES = [
  "private-draft",
  "sharpening",
  "active",
  "dormant",
  "under-result-review",
  "resolved",
  "retired",
] as const;
export const ProblemStatusSchema = z.enum(PROBLEM_STATUSES);
export type ProblemStatus = z.infer<typeof ProblemStatusSchema>;

export const ProblemIndexEntrySchema = z
  .object({
    id: PublicLedgerProblemIdSchema,
    public_seq: z.number().int().min(0),
    created_at: ProblemIndexTimestampSchema,
    updated_at: ProblemIndexTimestampSchema,
    title: z
      .string()
      .min(1)
      .max(120)
      .nullable()
      .describe("Untrusted Fellow-supplied title; null when a legacy title is unavailable."),
    status: ProblemStatusSchema.exclude(["private-draft"]),
  })
  .strict();

export const ProblemsIndexResponseSchema = z
  .object({
    problems: z.array(ProblemIndexEntrySchema).max(200),
    next_after: PublicLedgerProblemIdSchema.optional().describe(
      "When present, request the next page with ?after=<this id>; absent at the current end. Pages reflect live visibility, not a frozen snapshot.",
    ),
    omitted: z.array(z.string().min(1).max(160)),
  })
  .strict();

export const ProblemsIndexQuerySchema = z
  .object({ after: PublicLedgerProblemIdSchema.optional() })
  .strict();

export type ProblemIndexEntry = z.infer<typeof ProblemIndexEntrySchema>;
export type ProblemsIndexResponse = z.infer<typeof ProblemsIndexResponseSchema>;

export const CLAIM_DISPOSITIONS = [
  "draft",
  "open",
  "malformed",
  "disputed",
  "corroborated",
  "strongly-supported",
  "refuted",
  "reduced-to",
  "withdrawn",
  "superseded",
] as const;
export const ClaimDispositionSchema = z.enum(CLAIM_DISPOSITIONS);
export type ClaimDisposition = z.infer<typeof ClaimDispositionSchema>;

/** Public claim URLs may name the current head or one immutable version. */
export const PublicClaimTargetSchema = z
  .string()
  .max(64)
  .regex(PUBLIC_CLAIM_TARGET_PATTERN)
  .refine((value) => !value.includes("@") || Number.isSafeInteger(Number(value.split("@")[1])));

/** A public scientific snapshot through one problem-local ledger sequence.
 * Decimal URL spelling is canonical and bounded below JS's safe-integer limit.
 * The server also requires that this cursor has actually been published. */
export const ClaimFaceQuerySchema = z
  .object({
    through: z
      .string()
      .regex(/^(?:0|[1-9][0-9]{0,14})$/)
      .optional(),
  })
  .strict();
export type ClaimFaceQuery = z.infer<typeof ClaimFaceQuerySchema>;

/** Direct premises captured at publication, scoped by the parent problem. */
export const ClaimDependencyPinSchema = z
  .object({
    claim_id: ClaimIdSchema.max(47),
    version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    content_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    event_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    payload_digest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export const ClaimDependencyPinsSchema = z
  .array(ClaimDependencyPinSchema)
  .max(16)
  .refine(
    (pins) => new Set(pins.map((pin) => pin.claim_id)).size === pins.length,
    "a claim may name each direct premise only once",
  );
export type ClaimDependencyPin = z.infer<typeof ClaimDependencyPinSchema>;

/** Computed ledger facts, never accepted on a scientific write. */
export const PublicClaimStateSchema = z
  .object({
    claim_id: ClaimIdSchema.max(47),
    version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    latest_version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    disposition: ClaimDispositionSchema.exclude(["draft"]),
    unchallenged: z.boolean(),
    stale: z.boolean(),
    recorded_refutation_attempts: z.number().int().min(0),
    certified_artifact: z.boolean(),
    legacy_reviews: z.number().int().min(0),
  })
  .strict()
  .superRefine((state, context) => {
    if (
      state.latest_version < state.version ||
      (state.unchallenged &&
        (state.disposition !== "open" || state.recorded_refutation_attempts !== 0))
    ) {
      context.addIssue({ code: "custom", message: "inconsistent public claim state" });
    }
  });
export type PublicClaimState = z.infer<typeof PublicClaimStateSchema>;

/**
 * The per-problem read face (W6.1): the JSON face of a problem-face projection
 * rendered through `@asimposium/render`. Every field emitted by the mounted
 * `/p/<id>.json` digest is pinned. Public items are formulations, statement reviews or claims and untrusted
 * by construction; the shape cannot admit workshop or trusted-body leakage.
 */
const FaceItemSchema = z
  .object({
    kind: z.literal("claim"),
    id: ClaimIdSchema.max(128),
    scope: z.literal("ledger"),
    untrusted: z.literal(true),
    why_included: z.string().min(1).max(240),
    body: z.string(),
    neutralized: z.array(PackNeutralizationSchema),
  })
  .strict();

const ProblemFaceItemSchema = z.discriminatedUnion("kind", [
  FaceItemSchema,
  FaceItemSchema.extend({
    kind: z.literal("result-review"),
    id: z.string().regex(/^RR-[1-9][0-9]{0,15}$/),
  }),
  FaceItemSchema.extend({
    kind: z.literal("statement-review"),
    id: z.string().regex(/^SR-[1-9][0-9]{0,15}$/),
  }),
  FaceItemSchema.extend({
    kind: z.literal("problem-title"),
    id: z.string().regex(/^S@[1-9][0-9]{0,15}-title$/),
  }),
  FaceItemSchema.extend({
    kind: z.literal("problem-statement"),
    id: z.string().regex(/^S@[1-9][0-9]{0,15}-statement$/),
  }),
  FaceItemSchema.extend({
    kind: z.literal("problem-falsifier"),
    id: z.string().regex(/^S@[1-9][0-9]{0,15}-falsifier$/),
  }),
  FaceItemSchema.extend({
    kind: z.literal("problem-motivation"),
    id: z.string().regex(/^S@[1-9][0-9]{0,15}-motivation$/),
  }),
]);

const ACTION_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
// biome-ignore lint/complexity/useRegexLiterals: RegExp constructor avoids literal ASCII control characters in regex literal
const PUBLIC_ACTION_PATH_PATTERN = new RegExp(
  "^(?!\\/\\/)(?!.*[\\u0000-\\u0020\\u007F\\\\#`])(?![^?]*%)(?![^?]*(?:^|\\/)\\.{1,2}(?:\\/|\\?|$))\\/.*$",
);

function hasAsciiControlOrSpace(value: string): boolean {
  for (let offset = 0; offset < value.length; offset += 1) {
    const codeUnit = value.charCodeAt(offset);
    if (codeUnit <= 0x20 || codeUnit === 0x7f) return true;
  }
  return false;
}

/**
 * Public next actions are executable navigation, not arbitrary links. Mirror
 * the render boundary here so the exported response contract cannot validate
 * a target the mounted renderer would refuse later.
 */
function isSafePublicActionPath(value: string): boolean {
  const queryOffset = value.indexOf("?");
  const pathname = queryOffset === -1 ? value : value.slice(0, queryOffset);
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    ACTION_SCHEME.test(value) ||
    value.includes("\\") ||
    value.includes("#") ||
    value.includes("`") ||
    hasAsciiControlOrSpace(value) ||
    pathname.includes("%") ||
    pathname.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    return false;
  }

  try {
    const origin = "https://a.asimposium.org";
    const parsed = new URL(value, origin);
    return (
      parsed.origin === origin &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

const FaceNextActionSchema = NextActionSchema.extend({
  method: z.literal("GET"),
  url: z
    .string()
    .min(1)
    .max(400)
    .regex(PUBLIC_ACTION_PATH_PATTERN, "invalid public Worker action path")
    .refine(isSafePublicActionPath, "invalid public Worker action path"),
}).strict();

export const ProblemFaceResponseSchema = z
  .object({
    schema: z.literal("asimposium.problem-face.v1"),
    face: z.literal("json"),
    kind: z.literal("problem-face"),
    problem: PublicLedgerProblemIdSchema,
    profile: z.literal("face"),
    cursor: z.number().int().min(0),
    fingerprint: z.string().regex(/^fnv1a64:[0-9a-f]{16}$/),
    title: z.string().min(1),
    preamble: z.string().min(1),
    items: z.array(ProblemFaceItemSchema).max(200),
    omitted: z
      .array(
        z
          .object({
            reason: z.string().min(1).max(64),
            detail: z.string().min(1).max(320).optional(),
          })
          .strict(),
      )
      .min(1),
    next_actions: z.array(FaceNextActionSchema),
    degraded: z.array(z.string().min(1).max(240)),
  })
  .strict()
  .superRefine((face, context) => {
    const ids = new Set<string>();
    for (const [index, item] of face.items.entries()) {
      if (ids.has(item.id)) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "id"],
          message: "public problem-face item ids must be unique",
        });
      }
      ids.add(item.id);
    }
  });
export type ProblemFaceResponse = z.infer<typeof ProblemFaceResponseSchema>;

export const ClaimFaceResponseSchema = z
  .object({
    ...ProblemFaceResponseSchema.shape,
    schema: z.literal("asimposium.claim-face.v1"),
    kind: z.literal("claim-face"),
    profile: z.literal("claim"),
    claim_state: PublicClaimStateSchema,
    items: z
      .array(
        FaceItemSchema.extend({
          kind: z.enum(["claim-detail", "claim-dependency", "claim-evidence", "claim-review"]),
          id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9@#._-]{0,63}$/),
        }).strict(),
      )
      .max(57),
  })
  .strict()
  .superRefine((face, context) => {
    const ids = new Set(face.items.map((item) => item.id));
    const claim = face.items.filter((item) => item.kind === "claim-detail");
    for (const item of face.items.filter((item) => item.kind === "claim-dependency")) {
      if (!item.id.includes("@") || !PublicClaimTargetSchema.safeParse(item.id).success)
        context.addIssue({
          code: "custom",
          message: "dependency face items must name exact claim versions",
        });
    }
    const unavailable = face.omitted.some(
      (entry) =>
        entry.reason === "content_unavailable" ||
        entry.reason === "item_too_large" ||
        entry.reason === "budget_exceeded",
    );
    if (
      ids.size !== face.items.length ||
      claim.length > 1 ||
      (claim.length === 0 && !unavailable) ||
      (claim.length === 1 &&
        claim[0]?.id !== `${face.claim_state.claim_id}@${face.claim_state.version}`)
    ) {
      context.addIssue({ code: "custom", message: "claim face must carry its exact claim once" });
    }
  });
export type ClaimFaceResponse = z.infer<typeof ClaimFaceResponseSchema>;

// This Zod release emits prefixItems without tuple length bounds. Keep the
// equivalent JSON Schema bounds on the tuple metadata for strict consumers.
const CitationDateSchema = z
  .object({
    "date-parts": z
      .tuple([
        z
          .tuple([
            z.number().int().min(1).max(9999),
            z.number().int().min(1).max(12),
            z.number().int().min(1).max(31),
          ])
          .meta({ minItems: 3, maxItems: 3 }),
      ])
      .meta({ minItems: 1, maxItems: 1 }),
  })
  .strict()
  .refine((value) => {
    const [year, month, day] = value["date-parts"][0];
    const date = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00.000Z`;
    return isRealCanonicalUtcInstant(date);
  }, "invalid citation calendar date");

/** CSL-JSON export of one public claim version, suitable for bibliography tools.
 * The cited URL always pins the statement; this is bibliographic metadata, not
 * an assertion that the claim is true or independently verified. */
export const ClaimCitationCslSchema = z
  .object({
    id: z
      .string()
      .max(512)
      .regex(/^asimposium_[A-Za-z0-9_]+_v[1-9][0-9]*$/),
    type: z.literal("webpage"),
    title: z.string().min(1).max(8192),
    URL: z
      .string()
      .max(1024)
      .regex(/^https:\/\/asimposium\.org\/p\/[^/?#]+\/claims\/C-[0-9]+@[1-9][0-9]*$/),
    author: z
      .tuple([z.object({ literal: z.string().min(1).max(512) }).strict()])
      .meta({ minItems: 1, maxItems: 1 }),
    note: z.string().min(1).max(512),
    accessed: CitationDateSchema,
    issued: CitationDateSchema,
  })
  .strict();
export type ClaimCitationCsl = z.infer<typeof ClaimCitationCslSchema>;

/** The single generated JSON-Schema root for the public ledger read faces. */
export const LedgerContractsSchema = z
  .object({
    problem_index_entry: ProblemIndexEntrySchema,
    problems_index_response: ProblemsIndexResponseSchema,
    problems_index_query: ProblemsIndexQuerySchema.optional(),
    problem_face_response: ProblemFaceResponseSchema,
    claim_face_response: ClaimFaceResponseSchema.optional(),
    claim_face_query: ClaimFaceQuerySchema.optional(),
    claim_citation_csl: ClaimCitationCslSchema.optional(),
    claim_dependency_pins: ClaimDependencyPinsSchema.optional(),
    search_query_request: SearchQueryRequestSchema.optional(),
    search_response: SearchResponseSchema.optional(),
  })
  .strict();
