import { z } from "zod";
import { FellowIdSchema, SponsorIdSchema } from "./enrollment.ts";
import { PublicLedgerProblemIdSchema } from "./ledger.ts";
import { ReportResponseSchema } from "./moderation.ts";

/** Restricted human investigation; no case action is a scientific verdict. */
export const INTEGRITY_CASES_SCHEMA_ID = "https://a.asimposium.org/schemas/integrity-cases.v1.json";
export const INTEGRITY_CASE_STEP_UP_SECONDS = 15 * 60;
export const INTEGRITY_CASE_PAGE_LIMIT = 20;
export const INTEGRITY_CASE_MAX_CORRECTIONS = 8;
// Twenty 8,000-code-unit responses may expand to 960 KiB as escaped JSON.
export const INTEGRITY_CASE_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const INTEGRITY_CASE_PUBLIC_NOTICE =
  "This record has a scientific-integrity review notice. A notice is not a finding of misconduct and does not change scientific standing.";
export const INTEGRITY_CASE_ID_PATTERN = /^IC-[0-9A-HJKMNP-TV-Z]{26}$/;
export const IntegrityCaseIdSchema = z.string().length(29).regex(INTEGRITY_CASE_ID_PATTERN);
export const IntegrityCaseActionIdSchema = z
  .string()
  .length(29)
  .regex(/^IA-[0-9A-HJKMNP-TV-Z]{26}$/);
export const INTEGRITY_CONCERNS = [
  "fabricated-source",
  "fabricated-verification",
  "plagiarism",
  "declaration-mismatch",
  "coordinated-manipulation",
] as const;
export const INTEGRITY_OUTCOMES = [
  "unsubstantiated",
  "honest-error",
  "inconclusive",
  "confirmed",
] as const;
export const IntegrityConcernSchema = z.enum(INTEGRITY_CONCERNS);
export const IntegrityOutcomeSchema = z.enum(INTEGRITY_OUTCOMES);
export const IntegrityCaseStateSchema = z.enum(["open", "resolved"]);
export const IntegrityCaseActionKindSchema = z.enum(["opened", "response", "appealed", "resolved"]);

const SequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const RevisionSchema = SequenceSchema.min(1);
const TimestampSchema = z.string().datetime({ precision: 3 });
const PrincipalSchema = z.string().min(1).max(128);
const SummarySchema = z.string().trim().min(10).max(4000);
const ResponseSchema = z.string().trim().min(10).max(8000);
const RationaleSchema = z.string().trim().min(10).max(4000);
const AppealCountSchema = z.union([z.literal(0), z.literal(1)]);
const ConflictDeclarationSchema = z.literal("no-conflict");
const AuthIssuedAtSchema = SequenceSchema;

/**
 * References are resolved against the retained publication on the server.
 * Claims require their exact version; no mutable "latest" correction link.
 */
export const IntegrityTargetRefSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(
    /^(?:problem|C-[0-9]+@[1-9][0-9]{0,8}|(?:H|E|R|G|L|DE|Q|CF|SYNTH)-[0-9A-Za-z-]{1,78})$(?![\s\S])/,
  );
export const IntegrityCorrectionRefSchema = z
  .object({
    problem_id: PublicLedgerProblemIdSchema,
    target_ref: IntegrityTargetRefSchema,
  })
  .strict();

/** Server-derived immutable pin. No allegation or source body is copied here. */
export const IntegrityPublicationPinSchema = z
  .object({
    problem_id: PublicLedgerProblemIdSchema,
    target_ref: IntegrityTargetRefSchema,
    event_id: z.string().min(1).max(128),
    payload_sha256: z
      .string()
      .length(64)
      .regex(/^[0-9a-f]{64}$/),
    seq: RevisionSchema,
  })
  .strict();

const CorrectionRefsSchema = z
  .array(IntegrityCorrectionRefSchema)
  .max(INTEGRITY_CASE_MAX_CORRECTIONS)
  .superRefine((refs, ctx) => {
    const seen = new Set<string>();
    for (const [index, ref] of refs.entries()) {
      const key = JSON.stringify([ref.problem_id, ref.target_ref]);
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: [index],
          message: "A correction reference may appear only once.",
        });
      }
      seen.add(key);
    }
  });
const CorrectionPinsSchema = z
  .array(IntegrityPublicationPinSchema)
  .max(INTEGRITY_CASE_MAX_CORRECTIONS);

export const IntegrityCaseOpenRequestSchema = z
  .object({
    report_id: ReportResponseSchema.shape.report_id,
    concern: IntegrityConcernSchema,
    summary: SummarySchema,
    conflict_declaration: ConflictDeclarationSchema,
    public_notice: z.boolean(),
    auth_issued_at: AuthIssuedAtSchema,
  })
  .strict();

export const IntegrityCaseRespondRequestSchema = z
  .object({
    case_id: IntegrityCaseIdSchema,
    expected_revision: RevisionSchema,
    response: ResponseSchema,
  })
  .strict();

export const IntegrityCaseResolveRequestSchema = z
  .object({
    case_id: IntegrityCaseIdSchema,
    expected_revision: RevisionSchema,
    outcome: IntegrityOutcomeSchema,
    rationale: RationaleSchema,
    correction_refs: CorrectionRefsSchema,
    conflict_declaration: ConflictDeclarationSchema,
    auth_issued_at: AuthIssuedAtSchema,
  })
  .strict();

export const IntegrityCaseCursorSchema = z
  .object({ opened_at: TimestampSchema, case_id: IntegrityCaseIdSchema })
  .strict();
export const IntegrityCaseQuerySchema = z
  .object({
    before: IntegrityCaseCursorSchema.optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(INTEGRITY_CASE_PAGE_LIMIT)
      .default(INTEGRITY_CASE_PAGE_LIMIT),
  })
  .strict();
export const IntegrityCaseQueryRequestSchema = IntegrityCaseQuerySchema;
export const IntegrityCaseReadRequestSchema = z
  .object({
    case_id: IntegrityCaseIdSchema,
    after_revision: SequenceSchema.default(0),
    limit: z
      .number()
      .int()
      .min(1)
      .max(INTEGRITY_CASE_PAGE_LIMIT)
      .default(INTEGRITY_CASE_PAGE_LIMIT),
  })
  .strict();

const IntegrityCaseRecordSchema = z
  .object({
    case_id: IntegrityCaseIdSchema,
    source: IntegrityPublicationPinSchema,
    subject_sponsor_id: SponsorIdSchema,
    subject_fellow_id: FellowIdSchema.nullable(),
    concern: IntegrityConcernSchema,
    summary: SummarySchema,
    public_notice: z.boolean(),
    state: IntegrityCaseStateSchema,
    revision: RevisionSchema,
    appeals_used: AppealCountSchema,
    opened_at: TimestampSchema,
    resolved_at: TimestampSchema.nullable(),
    outcome: IntegrityOutcomeSchema.nullable(),
    rationale: RationaleSchema.nullable(),
    corrections: CorrectionPinsSchema,
  })
  .strict();
export const IntegrityCaseSchema = IntegrityCaseRecordSchema.superRefine((value, ctx) => {
  const resolved = value.state === "resolved";
  if (
    resolved !== (value.resolved_at !== null) ||
    resolved !== (value.outcome !== null) ||
    resolved !== (value.rationale !== null) ||
    (!resolved && value.corrections.length !== 0)
  ) {
    ctx.addIssue({
      code: "custom",
      message: "A current outcome belongs only to a resolved case.",
    });
  }
  if (value.resolved_at !== null && value.resolved_at < value.opened_at) {
    ctx.addIssue({
      code: "custom",
      path: ["resolved_at"],
      message: "A case cannot be resolved before it was opened.",
    });
  }
});
export const IntegrityCaseSummarySchema = IntegrityCaseRecordSchema.omit({
  summary: true,
  rationale: true,
  corrections: true,
  outcome: true,
}).superRefine((value, ctx) => {
  if ((value.state === "resolved") !== (value.resolved_at !== null)) {
    ctx.addIssue({ code: "custom", message: "Resolved state requires its decision time." });
  }
});

const ActionEnvelope = {
  action_id: IntegrityCaseActionIdSchema,
  revision: RevisionSchema,
  actor_id: PrincipalSchema,
  created_at: TimestampSchema,
};
export const IntegrityCaseActionSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        ...ActionEnvelope,
        kind: z.literal("opened"),
        actor_class: z.literal("operator"),
        body: z
          .object({
            summary: SummarySchema,
            concern: IntegrityConcernSchema,
            public_notice: z.boolean(),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...ActionEnvelope,
        kind: z.literal("response"),
        actor_class: z.literal("sponsor"),
        body: z.object({ response: ResponseSchema }).strict(),
      })
      .strict(),
    z
      .object({
        ...ActionEnvelope,
        kind: z.literal("appealed"),
        actor_class: z.literal("sponsor"),
        body: z.object({ response: ResponseSchema }).strict(),
      })
      .strict(),
    z
      .object({
        ...ActionEnvelope,
        kind: z.literal("resolved"),
        actor_class: z.literal("operator"),
        body: z
          .object({
            outcome: IntegrityOutcomeSchema,
            rationale: RationaleSchema,
            corrections: CorrectionPinsSchema,
          })
          .strict(),
      })
      .strict(),
  ])
  .superRefine((value, ctx) => {
    if ((value.kind === "opened") !== (value.revision === 1)) {
      ctx.addIssue({
        code: "custom",
        message: "The first case action opens the case; later actions cannot reopen its identity.",
      });
    }
  });

export const IntegrityCaseReceiptSchema = z
  .object({
    case_id: IntegrityCaseIdSchema,
    action_id: IntegrityCaseActionIdSchema,
    revision: RevisionSchema,
    state: IntegrityCaseStateSchema,
    action: IntegrityCaseActionKindSchema,
    created_at: TimestampSchema,
    appeals_used: AppealCountSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.action === "resolved") !== (value.state === "resolved") ||
      (value.action === "opened" && (value.revision !== 1 || value.appeals_used !== 0)) ||
      (value.action !== "opened" && value.revision < 2) ||
      (value.action === "appealed" && value.appeals_used !== 1)
    ) {
      ctx.addIssue({ code: "custom", message: "The receipt must describe its recorded action." });
    }
  });
export const IntegrityCaseListResponseSchema = z
  .object({
    schema: z.literal(INTEGRITY_CASES_SCHEMA_ID),
    cases: z.array(IntegrityCaseSummarySchema).max(INTEGRITY_CASE_PAGE_LIMIT),
    has_more: z.boolean(),
    next_cursor: IntegrityCaseCursorSchema.nullable(),
  })
  .strict();
export const IntegrityCaseDetailResponseSchema = z
  .object({
    schema: z.literal(INTEGRITY_CASES_SCHEMA_ID),
    case: IntegrityCaseSchema,
    actions: z.array(IntegrityCaseActionSchema).max(INTEGRITY_CASE_PAGE_LIMIT),
    has_more: z.boolean(),
    next_after_revision: RevisionSchema.nullable(),
  })
  .strict();
export const OperatorIntegrityCaseDetailResponseSchema = IntegrityCaseDetailResponseSchema.extend({
  report_id: ReportResponseSchema.shape.report_id,
}).strict();

/** The only public case projection: neutral status and readable source pins. */
export const PublicIntegrityNoticeSchema = z
  .object({
    case_id: IntegrityCaseIdSchema,
    source: IntegrityPublicationPinSchema,
    state: IntegrityCaseStateSchema,
    opened_at: TimestampSchema,
    updated_at: TimestampSchema,
    corrections: CorrectionPinsSchema,
  })
  .strict();
export const PublicIntegrityNoticesQuerySchema = z
  .object({ after: IntegrityCaseIdSchema.optional() })
  .strict();
export const PublicIntegrityNoticesResponseSchema = z
  .object({
    schema: z.literal(INTEGRITY_CASES_SCHEMA_ID),
    problem_id: PublicLedgerProblemIdSchema,
    notices: z.array(PublicIntegrityNoticeSchema).max(INTEGRITY_CASE_PAGE_LIMIT),
    has_more: z.boolean(),
    next_after: IntegrityCaseIdSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.has_more !== (value.next_after !== null)) {
      ctx.addIssue({ code: "custom", message: "Continuation must agree with has_more." });
    }
    let previous: string | undefined;
    for (const [index, notice] of value.notices.entries()) {
      if (
        notice.source.problem_id !== value.problem_id ||
        (previous !== undefined && notice.case_id <= previous) ||
        (value.next_after !== null && notice.case_id > value.next_after)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["notices", index],
          message: "Public notices must belong to this problem in increasing case order.",
        });
      }
      previous = notice.case_id;
    }
  });

/** Bind a private page to its request; following cursors must not skip cases. */
export function integrityCaseListMatchesQuery(
  query: IntegrityCaseQuery,
  page: IntegrityCaseListResponse,
): boolean {
  if (
    page.cases.length > query.limit ||
    page.has_more !== (page.next_cursor !== null) ||
    (page.has_more && page.cases.length !== query.limit)
  )
    return false;
  let previous = query.before;
  const seen = new Set<string>();
  for (const item of page.cases) {
    if (
      seen.has(item.case_id) ||
      (previous !== undefined &&
        (item.opened_at > previous.opened_at ||
          (item.opened_at === previous.opened_at && item.case_id >= previous.case_id)))
    )
      return false;
    seen.add(item.case_id);
    previous = item;
  }
  const last = page.cases.at(-1);
  return (
    page.next_cursor === null ||
    (last !== undefined &&
      page.next_cursor.opened_at === last.opened_at &&
      page.next_cursor.case_id === last.case_id)
  );
}

/** The ordered investigation record is complete up to its advertised revision. */
export function integrityCaseDetailMatchesRequest(
  request: IntegrityCaseReadRequest,
  page: IntegrityCaseDetailResponse,
): boolean {
  if (
    page.case.case_id !== request.case_id ||
    request.after_revision > page.case.revision ||
    page.actions.length > request.limit ||
    page.has_more !== (page.next_after_revision !== null)
  )
    return false;
  let revision = request.after_revision;
  const ids = new Set<string>();
  for (const action of page.actions) {
    if (
      action.revision !== revision + 1 ||
      action.revision > page.case.revision ||
      ids.has(action.action_id) ||
      (action.revision === 1) !== (action.kind === "opened")
    )
      return false;
    revision = action.revision;
    ids.add(action.action_id);
  }
  if (page.has_more) {
    return (
      page.actions.length === request.limit &&
      revision < page.case.revision &&
      page.next_after_revision === revision
    );
  }
  return revision === page.case.revision;
}

export const IntegrityCasesContractsSchema = z
  .object({
    open: IntegrityCaseOpenRequestSchema,
    respond: IntegrityCaseRespondRequestSchema,
    resolve: IntegrityCaseResolveRequestSchema,
    query: IntegrityCaseQuerySchema,
    read: IntegrityCaseReadRequestSchema,
    receipt: IntegrityCaseReceiptSchema,
    list: IntegrityCaseListResponseSchema,
    detail: IntegrityCaseDetailResponseSchema,
    operator_detail: OperatorIntegrityCaseDetailResponseSchema,
    public_query: PublicIntegrityNoticesQuerySchema,
    public_notices: PublicIntegrityNoticesResponseSchema,
  })
  .strict();
export function generateIntegrityCasesSchema(): string {
  return `${JSON.stringify(
    {
      $id: INTEGRITY_CASES_SCHEMA_ID,
      ...z.toJSONSchema(IntegrityCasesContractsSchema, { io: "input" }),
    },
    null,
    2,
  )}\n`;
}

export type IntegrityCaseId = z.infer<typeof IntegrityCaseIdSchema>;
export type IntegrityCaseActionId = z.infer<typeof IntegrityCaseActionIdSchema>;
export type IntegrityConcern = z.infer<typeof IntegrityConcernSchema>;
export type IntegrityOutcome = z.infer<typeof IntegrityOutcomeSchema>;
export type IntegrityCaseState = z.infer<typeof IntegrityCaseStateSchema>;
export type IntegrityCaseActionKind = z.infer<typeof IntegrityCaseActionKindSchema>;
export type IntegrityTargetRef = z.infer<typeof IntegrityTargetRefSchema>;
export type IntegrityCorrectionRef = z.infer<typeof IntegrityCorrectionRefSchema>;
export type IntegrityPublicationPin = z.infer<typeof IntegrityPublicationPinSchema>;
export type IntegrityCaseOpenRequest = z.infer<typeof IntegrityCaseOpenRequestSchema>;
export type IntegrityCaseRespondRequest = z.infer<typeof IntegrityCaseRespondRequestSchema>;
export type IntegrityCaseResolveRequest = z.infer<typeof IntegrityCaseResolveRequestSchema>;
export type IntegrityCaseCursor = z.infer<typeof IntegrityCaseCursorSchema>;
export type IntegrityCaseQuery = z.infer<typeof IntegrityCaseQuerySchema>;
export type IntegrityCaseQueryRequest = IntegrityCaseQuery;
export type IntegrityCaseReadRequest = z.infer<typeof IntegrityCaseReadRequestSchema>;
export type IntegrityCase = z.infer<typeof IntegrityCaseSchema>;
export type IntegrityCaseSummary = z.infer<typeof IntegrityCaseSummarySchema>;
export type IntegrityCaseAction = z.infer<typeof IntegrityCaseActionSchema>;
export type IntegrityCaseReceipt = z.infer<typeof IntegrityCaseReceiptSchema>;
export type IntegrityCaseListResponse = z.infer<typeof IntegrityCaseListResponseSchema>;
export type IntegrityCaseDetailResponse = z.infer<typeof IntegrityCaseDetailResponseSchema>;
export type OperatorIntegrityCaseDetailResponse = z.infer<
  typeof OperatorIntegrityCaseDetailResponseSchema
>;
export type PublicIntegrityNotice = z.infer<typeof PublicIntegrityNoticeSchema>;
export type PublicIntegrityNoticesQuery = z.infer<typeof PublicIntegrityNoticesQuerySchema>;
export type PublicIntegrityNoticesResponse = z.infer<typeof PublicIntegrityNoticesResponseSchema>;
export type IntegrityCasesContracts = z.infer<typeof IntegrityCasesContractsSchema>;
