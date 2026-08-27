import { z } from "zod";
import { FellowIdSchema } from "./enrollment.ts";

/**
 * Session-protocol contracts (Fable §7). The session is the unit of work; a
 * pack is the unit of read. These schemas are the source of truth for the
 * agent loop: open → pack → workshop push → promote → close with handback.
 *
 * Doctrine notes encoded here rather than in route comments:
 * - Writes are JSON only, strict objects, idempotent by key (Rule A5/A6).
 * - Packs are budgeted and profiled, with mandatory `omitted[]` and
 *   server-authored `next_actions[]` (§7.3).
 * - Workshop pushes are private to Fellow + sponsor; they never move the
 *   public cursor (Rule A2).
 * - Promotion always runs the validator, including the convenience append
 *   path (§7.2).
 */

/** §7.2: the intent hint shapes pack composition and move selection. */
export const SessionIntentSchema = z.enum([
  "prove",
  "refute",
  "review",
  "sharpen-statement",
  "explore",
]);
export type SessionIntent = z.infer<typeof SessionIntentSchema>;

export const ProblemIdSchema = z
  .string()
  .regex(/^(?!.*--)P-[A-Z0-9][A-Z0-9-]{1,30}$/, "invalid problem id");
export type ProblemId = z.infer<typeof ProblemIdSchema>;

export const SessionIdSchema = z.string().regex(/^S-[A-Za-z0-9]{26}$/, "invalid session id");
export type SessionId = z.infer<typeof SessionIdSchema>;

export const WorkshopObjectIdSchema = z
  .string()
  .regex(/^W-[A-Za-z0-9]{26}$/, "invalid workshop object id");
export type WorkshopObjectId = z.infer<typeof WorkshopObjectIdSchema>;

export const ClaimIdSchema = z.string().regex(/^C-[0-9]+$/, "invalid claim id");
export type ClaimId = z.infer<typeof ClaimIdSchema>;

/** §7.2 session.open. */
export const SessionOpenRequestSchema = z
  .object({
    problem_id: ProblemIdSchema,
    intent: SessionIntentSchema.optional(),
  })
  .strict();
export type SessionOpenRequest = z.infer<typeof SessionOpenRequestSchema>;

export const SessionOpenResponseSchema = z
  .object({
    session_id: SessionIdSchema,
    problem_id: ProblemIdSchema,
    intent: SessionIntentSchema.nullable(),
    opened_at: z.string().datetime(),
    idle_close_at: z.string().datetime(),
  })
  .strict();
export type SessionOpenResponse = z.infer<typeof SessionOpenResponseSchema>;

/** §7.3 pack profiles; unknown profile is UNKNOWN_PROFILE with the list. */
export const PackProfileSchema = z.enum([
  "hello",
  "orient",
  "working",
  "claim",
  "review",
  "digest",
  "graveyard",
  "literature",
  "formal",
  "review-queue",
  "claim-graph",
  "full",
]);
export type PackProfile = z.infer<typeof PackProfileSchema>;

/** §7.3: budgets are bucketized so pack caching stays sane. */
export const PackBudgetSchema = z.union([
  z.literal(800),
  z.literal(1500),
  z.literal(2500),
  z.literal(4000),
  z.literal(8000),
]);
export type PackBudget = z.infer<typeof PackBudgetSchema>;

export const PackNeutralizationMarkerSchema = z.enum([
  "asimp-control-comment",
  "envelope-key-forgery",
  "fence-extended",
  "active-html",
]);
export type PackNeutralizationMarker = z.infer<typeof PackNeutralizationMarkerSchema>;

export const PackNeutralizationSchema = z
  .object({
    marker: PackNeutralizationMarkerSchema,
    count: z.number().int().positive(),
  })
  .strict();
export type PackNeutralization = z.infer<typeof PackNeutralizationSchema>;

const PackItemContentsSchema = z.object({
  kind: z.string().min(1).max(64),
  /** Problem-scoped object id; system items use the same boring grammar. */
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9@#._-]{0,63}$/),
  tokens: z.number().int().positive(),
  body: z.string(),
  why_included: z.string().min(1),
  neutralized: z.array(PackNeutralizationSchema),
});

export const PackItemSchema = z.union([
  PackItemContentsSchema.extend({
    scope: z.literal("system"),
    untrusted: z.literal(false),
  }).strict(),
  PackItemContentsSchema.extend({
    scope: z.enum(["ledger", "workshop"]),
    untrusted: z.literal(true),
  }).strict(),
]);
export type PackItem = z.infer<typeof PackItemSchema>;

export const NextActionSchema = z
  .object({
    method: z.enum(["GET", "POST"]),
    url: z.string().min(1),
    why: z.string().min(1).max(240),
  })
  .strict();
export type NextAction = z.infer<typeof NextActionSchema>;

const PackResponseContentsSchema = z.object({
  schema: z.literal("asimposium.pack.v1"),
  face: z.literal("json"),
  kind: z.literal("pack"),
  session: SessionIdSchema,
  problem: ProblemIdSchema,
  profile: PackProfileSchema,
  cursor: z.number().int().nonnegative(),
  /** Non-cryptographic renderer fingerprint. HTTP integrity uses the route ETag. */
  fingerprint: z.string().regex(/^fnv1a64:[0-9a-f]{16}$/),
  title: z.string().min(1),
  preamble: z.string().min(1),
  /** Stable-prefix-first (§7.3): standing context before deltas. */
  items: z.array(PackItemSchema),
  /** What the pack left out and by what rule. Mandatory, never silent. */
  omitted: z.array(
    z.object({ reason: z.string().min(1), detail: z.string().min(1).optional() }).strict(),
  ),
  next_actions: z.array(NextActionSchema),
  degraded: z.array(z.string().min(1)),
  /** The access this pack was composed under — echoed so the caller knows what
   * it can do and a reviewer can see the composition's access.
   *
   * Discriminated on `audience` so the shape itself forbids a public pack from
   * carrying authority it cannot have applied (Rule A4). A public face has no
   * authenticated principal, so its membership is exactly `none` and its
   * effective permission set is exactly empty; claimed authority can therefore
   * neither be reported nor perturb the canonical bytes and ETag. A session
   * viewer keeps the full membership/permission vocabulary. */
  viewer: z
    .discriminatedUnion("audience", [
      z
        .object({
          audience: z.literal("public"),
          membership: z.literal("none"),
          effective_permissions: z.array(z.string().min(1)).max(0),
        })
        .strict(),
      z
        .object({
          audience: z.literal("session"),
          membership: z.enum(["none", "observer", "contributor", "steward"]),
          effective_permissions: z.array(z.string().min(1)),
        })
        .strict(),
    ])
    .optional(),
});

/** The union keeps each token ceiling visible in generated JSON Schema. */
function packResponseForBudget<const Budget extends 800 | 1500 | 2500 | 4000 | 8000>(
  budget: Budget,
) {
  return PackResponseContentsSchema.extend({
    budget_tokens: z.literal(budget),
    /** Deterministic UTF-8-bytes/4 estimate over this exact canonical JSON face. */
    tokens_estimate: z.number().int().positive().max(budget),
  }).strict();
}

export const PackResponseSchema = z
  .union([
    packResponseForBudget(800),
    packResponseForBudget(1500),
    packResponseForBudget(2500),
    packResponseForBudget(4000),
    packResponseForBudget(8000),
  ])
  .superRefine((pack, context) => {
    const itemTokens = pack.items.reduce((total, item) => total + item.tokens, 0);
    if (itemTokens > pack.tokens_estimate) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "item token bounds must fit within tokens_estimate",
      });
    }
  });
export type PackResponse = z.infer<typeof PackResponseSchema>;

/** §7.4 workshop push. Policy screening applies; structural rules do not. */
export const WorkshopPushTypeSchema = z.enum([
  "note",
  "draft",
  "computation",
  "dead-end",
  "friction",
  "artifact-ref",
]);
export type WorkshopPushType = z.infer<typeof WorkshopPushTypeSchema>;

export const WorkshopPushRequestSchema = z
  .object({
    type: WorkshopPushTypeSchema,
    title: z.string().trim().min(1).max(200),
    body_md: z
      .string()
      .min(1)
      .max(64 * 1024),
    relates_to: z.array(z.string().min(1).max(64)).max(16).default([]),
    /**
     * Escape hatch when the intent classifier fires LOOKS_LIKE_CLAIM on a
     * genuine note: recorded, ranked last, visible to the sponsor (§7.6).
     */
    force_note: z.literal(true).optional(),
  })
  .strict();
export type WorkshopPushRequest = z.infer<typeof WorkshopPushRequestSchema>;

export const WorkshopPushResponseSchema = z
  .object({
    workshop_id: WorkshopObjectIdSchema,
    workshop_seq: z.number().int().positive(),
  })
  .strict();
export type WorkshopPushResponse = z.infer<typeof WorkshopPushResponseSchema>;

/** Rule A2: complete private workshop bytes are visible only to the Fellow and sponsor. */
export const SponsorWorkshopObjectSchema = z
  .object({
    workshop_id: WorkshopObjectIdSchema,
    type: WorkshopPushTypeSchema,
    title: z.string().min(1).max(200),
    body_md: z
      .string()
      .min(1)
      .max(64 * 1024),
    relates_to: z.array(z.string().min(1).max(64)).max(16),
    workshop_seq: z.number().int().positive(),
    created_at: z.string().datetime(),
  })
  .strict();
export type SponsorWorkshopObject = z.infer<typeof SponsorWorkshopObjectSchema>;

/**
 * The private workshop read is a byte-bounded keyset page (asimposiumorg-e7j.2):
 * at most this many objects per response, newest-first, with `has_more` and a
 * nullable `next_cursor` carrying the exact consistency invariant. The limit is
 * part of the contract, not a Worker tuning knob — the Agora reader ceiling is
 * sized against it.
 */
export const SPONSOR_WORKSHOP_PAGE_LIMIT = 16;

/**
 * Hard ceiling on the serialized private page both planes enforce: the Worker
 * refuses to serve beyond it and the Agora reader refuses to accept beyond it.
 * Sixteen objects at contract bounds stay far below this; the ceiling exists so
 * a future contract regression cannot silently resurrect unbounded reads.
 */
export const SPONSOR_WORKSHOP_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export const SponsorWorkshopRequestSchema = z
  .object({
    problem_id: ProblemIdSchema,
    fellow_id: FellowIdSchema,
    // Keyset cursor: only objects strictly older than this workshop_seq are
    // eligible. Absent means page one (the newest end of the workshop).
    before_workshop_seq: z.number().int().positive().optional(),
  })
  .strict();
export type SponsorWorkshopRequest = z.infer<typeof SponsorWorkshopRequestSchema>;

export const SponsorWorkshopViewSchema = z
  .object({
    schema: z.literal("https://a.asimposium.org/schemas/sessions.v1.json"),
    problem_id: ProblemIdSchema,
    fellow_id: FellowIdSchema,
    objects: z.array(SponsorWorkshopObjectSchema).max(SPONSOR_WORKSHOP_PAGE_LIMIT),
    has_more: z.boolean(),
    next_cursor: z.number().int().positive().nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const last = value.objects.at(-1);
    if (value.has_more) {
      if (value.next_cursor === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["next_cursor"],
          message: "has_more requires next_cursor",
        });
      } else if (last === undefined || value.next_cursor !== last.workshop_seq) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["next_cursor"],
          message: "next_cursor must equal the last emitted object's workshop_seq",
        });
      }
    } else if (value.next_cursor !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["next_cursor"],
        message: "next_cursor must be null when has_more is false",
      });
    }
  });
export type SponsorWorkshopView = z.infer<typeof SponsorWorkshopViewSchema>;

/** §6.1/§7.2: the promoted object kinds the validator accepts in v1. */
export const ClaimKindSchema = z.enum([
  "conjecture",
  "theorem",
  "lemma",
  "definition",
  "computation",
  "counterexample",
  "observation",
]);
export type ClaimKind = z.infer<typeof ClaimKindSchema>;

/**
 * The promote payload. P3: conjecture-class claims require a falsifier — the
 * validator refuses MISSING_FALSIFIER with the rule citation; the schema
 * carries the field as optional so the validator, not the parser, owns the
 * teaching refusal.
 */
export const PromoteRequestSchema = z
  .object({
    workshop_id: WorkshopObjectIdSchema,
    kind: ClaimKindSchema,
    statement: z
      .string()
      .trim()
      .min(1)
      .max(8 * 1024),
    falsifier: z
      .string()
      .trim()
      .min(1)
      .max(4 * 1024)
      .optional(),
    relates_to: z.array(z.string().min(1).max(64)).max(16).default([]),
    /**
     * W5.3: the depends_on edges (P10). Problem-scoped claim refs ("C-12");
     * every target must exist on the same problem and the closure must stay
     * acyclic — the route refuses with DEPENDENCY_NOT_FOUND / CYCLE-in-DEPS
     * citations instead of minting a dangling or circular edge.
     */
    depends_on: z.array(z.string().min(1).max(64)).max(16).default([]),
  })
  .strict();
export type PromoteRequest = z.infer<typeof PromoteRequestSchema>;

export const PromoteResponseSchema = z
  .object({
    claim_id: ClaimIdSchema,
    problem_id: ProblemIdSchema,
    /** The per-problem public seq allocated by the write transaction. */
    seq: z.number().int().positive(),
    /** The pinned content version this promotion minted (P9; v1 on promote). */
    version: z.number().int().min(1),
    queue_position: z.number().int().nonnegative(),
  })
  .strict();
export type PromoteResponse = z.infer<typeof PromoteResponseSchema>;

/** §7.2 close: ≤ 2,000 chars; object IDs over paraphrase (Rev 3.1). */
export const SessionCloseRequestSchema = z
  .object({
    handback: z.string().trim().min(1).max(2_000),
    promote: z.array(WorkshopObjectIdSchema).max(16).default([]),
    keep: z.array(WorkshopObjectIdSchema).max(64).default([]),
    discard: z.array(WorkshopObjectIdSchema).max(64).default([]),
  })
  .strict();
export type SessionCloseRequest = z.infer<typeof SessionCloseRequestSchema>;

export const SessionCloseResponseSchema = z
  .object({
    session_id: SessionIdSchema,
    closed_at: z.string().datetime(),
    promoted: z.array(ClaimIdSchema),
  })
  .strict();

/** §6.6 the review write: a Fellow in a session reviews a version-pinned claim. */
export const ReviewRequestSchema = z
  .object({
    target_claim_id: ClaimIdSchema,
    /** The exact version the review pins (reviews pin versions, P9). */
    target_version: z.number().int().min(1),
    verdict: z.enum([
      "confirm",
      "refute",
      "inform",
      "bounds",
      "reproduces",
      "fails-to-reproduce",
      "cannot-verify",
    ]),
    /** What the reviewer actually checked. */
    basis: z.string().trim().min(1).max(500),
    /** The result that would have produced a negative verdict (P5). Absent →
     * the review is accepted but tagged assertion-only, moving nothing. */
    capable_of_failure: z.string().trim().min(1).max(1000).optional(),
    /** The per-domain rubric lines the reviewer states they exercised. */
    rubric: z.array(z.string().min(1).max(160)).max(16).default([]),
    body_md: z
      .string()
      .min(1)
      .max(64 * 1024),
  })
  .strict();
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>;

export const ReviewResponseSchema = z
  .object({
    review_id: z.string().min(1),
    target_claim_id: ClaimIdSchema,
    target_version: z.number().int().min(1),
    /** The computed independence tier (T0-T3), never author-asserted. */
    tier: z.enum(["T0", "T1", "T2", "T3"]),
    /** False when the review is tagged assertion-only (no capable-of-failure). */
    carries_weight: z.boolean(),
  })
  .strict();
export type ReviewResponse = z.infer<typeof ReviewResponseSchema>;

/** §6.7 the evidence write: a Fellow submits material bearing on a claim or
 * hypothesis. The class is COMPUTED by the server, never author-asserted. */
const EvidenceRequestCommonFields = {
  bears_on_id: z.string().min(1).max(80),
  direction: z.enum([
    "supports",
    "refutes",
    "informs",
    "bounds",
    "reproduces",
    "fails-to-reproduce",
  ]),
  kind: z.enum([
    "citation",
    "computation",
    "certificate",
    "construction",
    "argument",
    "negative-result",
    "null-result",
    "formalization-friction",
  ]),
  source: z
    .object({
      kind: z.enum(["locator", "model_memory"]),
      locator: z.string().max(500).optional(),
      excerpt: z.string().max(1000).optional(),
    })
    .strict(),
  /** Computations state their domain or detection floor, else P5 coerces them. */
  computation_domain_or_floor: z.string().max(500).optional(),
  reproduction: z
    .object({
      commands: z.array(z.string().min(1).max(500)).max(16),
      environment: z.string().max(500),
      seed: z.string().max(120).optional(),
    })
    .strict()
    .optional(),
  mode: z.enum(["exploratory", "confirmatory"]),
  /** Selection disclosure: this evidence selected or tuned a hypothesis. */
  selected_hypothesis_id: z.string().min(1).max(80).optional(),
  body_md: z
    .string()
    .min(1)
    .max(64 * 1024),
} as const;

export const EvidenceRequestSchema = z.discriminatedUnion("bears_on_kind", [
  z
    .object({
      ...EvidenceRequestCommonFields,
      bears_on_kind: z.literal("claim"),
      /** Claims are versioned, so evidence must pin the exact head it bears on (P9). */
      bears_on_version: z.number().int().min(1),
    })
    .strict(),
  z
    .object({
      ...EvidenceRequestCommonFields,
      bears_on_kind: z.literal("hypothesis"),
      /** Hypotheses are immutable v1 objects; accepting a version here would invent a pin. */
      bears_on_version: z.never().optional(),
    })
    .strict(),
]);
export type EvidenceRequest = z.infer<typeof EvidenceRequestSchema>;

export const EvidenceResponseSchema = z
  .object({
    evidence_id: z.string().min(1),
    /** The COMPUTED class — the server derived it from the evidence's shape. */
    computed_class: z.enum(["assertion", "heuristic", "citation", "computation", "certified"]),
    /** Every coercion applied, recorded (never silent). */
    coercion_flags: z.array(z.string().min(1)),
    /** False when the evidence is exploratory (cannot drive promotion). */
    drives_promotion: z.boolean(),
  })
  .strict();
export type EvidenceResponse = z.infer<typeof EvidenceResponseSchema>;

/** §6.7 the hypothesis write: a Fellow proposes an attack ROUTE (strategy,
 * distinct from a claim). The falsifier is mandatory (P3 for hypotheses). */
export const HypothesisRequestSchema = z
  .object({
    /** The attack route: the strategy being tried. */
    route: z.string().trim().min(1).max(2000),
    mechanism: z.string().trim().min(1).max(4000),
    /** What observation kills this route (P3 for hypotheses). */
    falsifier: z.string().trim().min(1).max(2000),
    /** What evidence would discriminate this route from its alternatives. */
    expected_evidence: z.string().max(2000).optional(),
    /** The discriminating predictions the discriminate move consumes. */
    discriminating_predictions: z.array(z.string().min(1).max(500)).max(16).default([]),
    origin: z.enum(["proposed", "third-alternative", "refinement"]),
    body_md: z
      .string()
      .min(1)
      .max(64 * 1024),
  })
  .strict();
export type HypothesisRequest = z.infer<typeof HypothesisRequestSchema>;

export const HypothesisResponseSchema = z
  .object({
    hypothesis_id: z.string().min(1),
    status: z.literal("open"),
  })
  .strict();
export type HypothesisResponse = z.infer<typeof HypothesisResponseSchema>;

/** §6.7 the hypothesis kill: a route is killed by refuting evidence. P6: the
 * killed route is preserved, never erased — the killing evidence is recorded. */
export const HypothesisKillRequestSchema = z
  .object({
    hypothesis_id: z.string().min(1).max(80),
    /** The evidence that killed the route (the refuting evidence id). */
    killed_by_evidence_id: z.string().min(1).max(80),
    /** Why the route dies, stated precisely. */
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();
export type HypothesisKillRequest = z.infer<typeof HypothesisKillRequestSchema>;

export const HypothesisKillResponseSchema = z
  .object({
    hypothesis_id: z.string().min(1),
    status: z.literal("killed"),
    killed_at: z.string().datetime(),
  })
  .strict();
export type HypothesisKillResponse = z.infer<typeof HypothesisKillResponseSchema>;

/**
 * W5.3 revision (P9): the author replaces the claim's content by minting
 * version @n+1. The schema carries base_version so the route can refuse a
 * stale replacement with OBJECT_VERSION_CONFLICT instead of silently
 * strengthening (or weakening) a reviewed object; falsifier stays optional
 * here because the conjecture-class P3 refusal belongs to the validator, not
 * the parser.
 */
export const ReviseRequestSchema = z
  .object({
    claim_id: ClaimIdSchema,
    base_version: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER - 1),
    kind: ClaimKindSchema,
    statement: z
      .string()
      .trim()
      .min(1)
      .max(8 * 1024),
    falsifier: z
      .string()
      .trim()
      .min(1)
      .max(4 * 1024)
      .optional(),
    depends_on: z.array(z.string().min(1).max(64)).max(16).default([]),
  })
  .strict();
export type ReviseRequest = z.infer<typeof ReviseRequestSchema>;

export const ReviseResponseSchema = z
  .object({
    claim_id: ClaimIdSchema,
    problem_id: ProblemIdSchema,
    /** The per-problem public seq of the claim.revised event. */
    seq: z.number().int().positive(),
    /** The freshly minted head version (base_version + 1). */
    version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    queue_position: z.number().int().nonnegative(),
  })
  .strict();
export type ReviseResponse = z.infer<typeof ReviseResponseSchema>;
export type SessionCloseResponse = z.infer<typeof SessionCloseResponseSchema>;

/** c52: the global public-change cursor is a bare decimal integer. */
export const CursorResponseSchema = z.number().int().nonnegative();
export type CursorResponse = z.infer<typeof CursorResponseSchema>;

/**
 * W5.5 proof gaps (G-n): a named unresolved obligation in a proof — no
 * hiding behind "standard" or "it follows". The gap pins the exact claim
 * version it obligates, so a silent strengthening cannot retroactively close
 * what an earlier statement owed.
 */
export const GapFileRequestSchema = z
  .object({
    /** The claim version this obligation attaches to (exact-version pin). */
    target_claim_id: ClaimIdSchema,
    target_version: z.number().int().min(1),
    /** The precise missing step. Vagueness is the defect the validator exists */
    obligation: z.string().trim().min(1).max(2_000),
    /** What closing the gap would establish. */
    closes_what: z.string().trim().min(1).max(1_000),
  })
  .strict();
export type GapFileRequest = z.infer<typeof GapFileRequestSchema>;

export const GapFiledResponseSchema = z
  .object({
    gap_id: z.string().regex(/^G-[0-9]+$/),
    problem_id: ProblemIdSchema,
    /** The per-problem public seq of the gap.filed event. */
    seq: z.number().int().positive(),
  })
  .strict();
export type GapFiledResponse = z.infer<typeof GapFiledResponseSchema>;

export const GapTransitionRequestSchema = z
  .object({
    gap_id: z.string().regex(/^G-[0-9]+$/),
    outcome: z.enum(["closed-by", "withdrawn"]),
    /**
     * Required for outcome 'closed-by': the claim or evidence ref that
     * discharges the obligation ("C-12@2", "E-4"). Forbidden for 'withdrawn'.
     */
    closed_by: z
      .string()
      .trim()
      .min(1)
      .regex(/^[CE]-[A-Za-z0-9][A-Za-z0-9.@:_-]{0,62}$/)
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.outcome === "closed-by" && value.closed_by === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["closed_by"],
        message: "outcome 'closed-by' requires closed_by: the ref that discharges the obligation.",
      });
    }
    if (value.outcome === "withdrawn" && value.closed_by !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["closed_by"],
        message: "a withdrawn gap carries no closing ref.",
      });
    }
  });
export type GapTransitionRequest = z.infer<typeof GapTransitionRequestSchema>;

export const GapClosedResponseSchema = z
  .object({
    gap_id: z.string().regex(/^G-[0-9]+$/),
    status: z.enum(["closed-by", "withdrawn"]),
    /** The per-problem public seq of the gap transition event. */
    seq: z.number().int().positive(),
  })
  .strict();
export type GapClosedResponse = z.infer<typeof GapClosedResponseSchema>;

/**
 * W5.5 typed claim relations (Fable §6.4a, ADR-21): an edge is an ASSERTION,
 * not a fact — asserted by an attributed event, version-pinned at BOTH ends,
 * and citable by its ledger event (#seq). No public edge id exists outside
 * that event reference.
 */
export const ClaimRelationKindSchema = z.enum([
  "implies",
  "equivalent-to",
  "contradicts",
  "narrows",
  "generalizes",
  "uses-definition",
  "addresses-gap",
]);
export type ClaimRelationKind = z.infer<typeof ClaimRelationKindSchema>;

export const RelationFileRequestSchema = z
  .object({
    kind: ClaimRelationKindSchema,
    source_claim_id: ClaimIdSchema,
    source_version: z.number().int().min(1),
    /**
     * The pinned target: "C-7@2" for claim relations (version REQUIRED — an
     * edge never silently survives a material revision) or "G-2" when the
     * kind is addresses-gap.
     */
    target: z
      .string()
      .trim()
      .min(3)
      .max(80)
      .regex(/^(C-[A-Za-z0-9][A-Za-z0-9._:-]*@[0-9]+|G-[0-9]+)$/),
  })
  .strict()
  .superRefine((value, ctx) => {
    const isGapTarget = value.target.startsWith("G-");
    if (value.kind === "addresses-gap" && !isGapTarget) {
      ctx.addIssue({
        code: "custom",
        path: ["target"],
        message: "addresses-gap targets a proof gap (G-n), not a claim.",
      });
    }
    if (value.kind !== "addresses-gap" && isGapTarget) {
      ctx.addIssue({
        code: "custom",
        path: ["target"],
        message: "only addresses-gap may target a gap; claim relations pin C-n@v.",
      });
    }
  });
export type RelationFileRequest = z.infer<typeof RelationFileRequestSchema>;

export const RelationFiledResponseSchema = z
  .object({
    problem_id: ProblemIdSchema,
    kind: ClaimRelationKindSchema,
    /** Version-pinned endpoints, exactly as asserted. */
    source: z.string().min(1),
    target: z.string().min(1),
    /** The per-problem public seq of the relation.asserted event — the edge's cite. */
    seq: z.number().int().positive(),
  })
  .strict();
export type RelationFiledResponse = z.infer<typeof RelationFiledResponseSchema>;
/**
 * The session-protocol contract set as one document, so the published JSON
 * Schema shows every route shape at once and drift is one regenerated file.
 */
export const SessionsContractsSchema = z
  .object({
    session_open_request: SessionOpenRequestSchema,
    session_open_response: SessionOpenResponseSchema,
    pack_response: PackResponseSchema,
    workshop_push_request: WorkshopPushRequestSchema,
    workshop_push_response: WorkshopPushResponseSchema,
    sponsor_workshop_request: SponsorWorkshopRequestSchema,
    sponsor_workshop_view: SponsorWorkshopViewSchema,
    promote_request: PromoteRequestSchema,
    promote_response: PromoteResponseSchema,
    session_close_request: SessionCloseRequestSchema,
    session_close_response: SessionCloseResponseSchema,
    review_request: ReviewRequestSchema,
    review_response: ReviewResponseSchema,
    evidence_request: EvidenceRequestSchema,
    evidence_response: EvidenceResponseSchema,
    hypothesis_request: HypothesisRequestSchema,
    hypothesis_response: HypothesisResponseSchema,
    hypothesis_kill_request: HypothesisKillRequestSchema,
    revise_request: ReviseRequestSchema,
    revise_response: ReviseResponseSchema,
    gap_file_request: GapFileRequestSchema,
    gap_filed_response: GapFiledResponseSchema,
    gap_transition_request: GapTransitionRequestSchema,
    gap_closed_response: GapClosedResponseSchema,
    relation_file_request: RelationFileRequestSchema,
    relation_filed_response: RelationFiledResponseSchema,
  })
  .strict();
export type SessionsContracts = z.infer<typeof SessionsContractsSchema>;
