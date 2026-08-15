import { z } from "zod";

/**
 * The canonical refusal face (Fable Rule A5, RFC 7807).
 *
 * Every enrollment 4xx and 5xx is one of these documents. This package does
 * not yet claim to enumerate failures from unfinished session, ledger, or
 * screening surfaces. The enrollment code set is closed here rather than at
 * each route, so a new refusal is a contract change with a regenerated schema
 * and a golden fixture, not an untracked literal in a handler.
 *
 * ## Two transparency classes
 *
 * Rule A5 splits refusals, and the split is structural here rather than
 * advisory. **Contract** failures teach: they carry `rule`, `schema`, and a
 * copy-pasteable `example`, because the caller's next attempt should succeed.
 * **Policy** and **authorization** failures do not: explaining which check
 * failed hands an attacker a grinding oracle, so those documents carry the
 * teaching fields not at all.
 *
 * ## What a problem document may never contain
 *
 * The never-log list (Fable §14.3) applies to response bodies as surely as to
 * logs. No enrollment secret, flow handle, bearer token, cookie, signed
 * envelope, raw request body, or exception text may appear in any field. The
 * `example` field is site-authored and synthetic; it is never an echo of what
 * the caller sent.
 */

/** `https://asimposium.org/errors/<code>`; the `type` URI is derived from `code`. */
export const PROBLEM_TYPE_PREFIX = "https://asimposium.org/errors/";

/**
 * Refusals whose cause is fully described by the request, so naming it lets
 * the caller fix the request. These carry the teaching fields.
 */
const GENERAL_CONTRACT_PROBLEM_CODES = [
  "BODY_ONLY_REQUIRED",
  "DECISION_BODY_INVALID",
  "DECISION_TARGET_MISMATCH",
  "DEVICE_CODE_BODY_INVALID",
  "DEVICE_LOOKUP_BODY_INVALID",
  "ENROLLMENT_ID_INVALID",
  "HARNESS_AS_NAME",
  "IDEMPOTENCY_CONFLICT",
  "IDEMPOTENCY_KEY_INVALID",
  "MINT_BODY_INVALID",
  "MODEL_AS_NAME",
  "NAME_INVALID",
  "NAME_RESERVED",
  "NAME_TAKEN",
  "PATH_ONLY_REQUIRED",
  "SCOPE_ESCALATION",
  "SCOPE_NOT_REDUCED",
] as const;

export const CONTRACT_PROBLEM_CODES = [
  ...GENERAL_CONTRACT_PROBLEM_CODES,
  "UNKNOWN_FORMAT",
] as const;

/**
 * Refusals that deliberately teach nothing. An absent capsule, a rejected
 * credential, and an unavailable dependency all present one flat face so that
 * probing cannot distinguish "wrong" from "does not exist" from "try later".
 */
export const OPAQUE_PROBLEM_CODES = [
  "AUTH_REPLAY_STORE_UNAVAILABLE",
  "CAPSULE_UNAVAILABLE",
  "DEVICE_CODE_UNKNOWN",
  "DEVICE_LOOKUP_LOCKED",
  "DEVICE_START_RATE_LIMITED",
  "ENROLLMENT_UNAVAILABLE",
  "FELLOW_TOKEN_INVALID",
  "FLOW_INVALID",
  "INTERNAL_ERROR",
  "PAIRING_INVALID",
  "PROPOSAL_EXPIRED",
  "PROPOSAL_NOT_PENDING",
  "ROUTE_NOT_FOUND",
  "SPONSOR_AUTH_UNAVAILABLE",
  "UNAUTHORIZED",
  "WRONG_PRINCIPAL",
] as const;

export const ProblemCodeSchema = z.enum([...CONTRACT_PROBLEM_CODES, ...OPAQUE_PROBLEM_CODES]);

/** Rule ids a teaching refusal may cite. Each resolves to published text. */
export const ProblemRuleSchema = z.enum(["A5", "ADR-20", "P-EN-NAME"]);

/**
 * Fields present only on contract refusals. `example` is a synthetic,
 * site-authored request shape the caller can copy; it never reflects caller
 * input, and it never carries a live credential.
 */
const teachingFields = {
  rule: ProblemRuleSchema,
  schema: z.url().max(200),
  example: z.record(z.string(), z.unknown()),
} as const;

const problemBase = {
  type: z.string().startsWith(PROBLEM_TYPE_PREFIX).max(200),
  title: z.string().min(1).max(160),
  status: z.number().int().min(400).max(599),
  code: ProblemCodeSchema,
  detail: z.string().min(1).max(400),
  fix_hint: z.string().min(1).max(400),
} as const;

/**
 * A teaching refusal: a contract code plus the three fields that let the
 * caller repair the request without a second round trip.
 */
const generalContractProblem = z
  .object({
    ...problemBase,
    code: z.enum(GENERAL_CONTRACT_PROBLEM_CODES),
    ...teachingFields,
    /** Available Fellow names, present only on name-policy refusals. */
    suggestions: z.array(z.string().min(1).max(32)).max(3).optional(),
  })
  .strict();

const unknownFormatProblem = z
  .object({
    ...problemBase,
    code: z.literal("UNKNOWN_FORMAT"),
    ...teachingFields,
    /** Formats accepted by the route. Required only for UNKNOWN_FORMAT. */
    allowed: z.array(z.string().min(1).max(32)).min(1).max(12),
  })
  .strict();

export const ContractProblemSchema = z.discriminatedUnion("code", [
  generalContractProblem,
  unknownFormatProblem,
]);

/**
 * An opaque refusal. The teaching fields are forbidden rather than optional:
 * a policy refusal that acquires a `schema` and an `example` has become an
 * oracle, and that regression should fail the contract, not review.
 */
export const OpaqueProblemSchema = z
  .object({
    ...problemBase,
    code: z.enum(OPAQUE_PROBLEM_CODES),
  })
  .strict();

/**
 * Any refusal this platform emits. The `type` URI must agree with `code`:
 * two documents that disagree about what went wrong are one document lying.
 */
export const ProblemDocumentSchema = z
  .union([ContractProblemSchema, OpaqueProblemSchema])
  .refine(
    (value) => value.type === `${PROBLEM_TYPE_PREFIX}${value.code}`,
    "problem `type` must be the errors URI for its own `code`",
  );

/** The single generated JSON-Schema root for the refusal contract. */
export const ProblemContractsSchema = z
  .object({
    problem_document: ProblemDocumentSchema,
    contract_problem: ContractProblemSchema,
    opaque_problem: OpaqueProblemSchema,
    problem_code: ProblemCodeSchema,
  })
  .strict();

export type ProblemCode = z.infer<typeof ProblemCodeSchema>;
export type ProblemRule = z.infer<typeof ProblemRuleSchema>;
export type ContractProblem = z.infer<typeof ContractProblemSchema>;
export type OpaqueProblem = z.infer<typeof OpaqueProblemSchema>;
export type ProblemDocument = z.infer<typeof ProblemDocumentSchema>;
