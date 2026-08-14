import { expect, test } from "bun:test";

import {
  CONTRACT_PROBLEM_CODES,
  ContractProblemSchema,
  OPAQUE_PROBLEM_CODES,
  OpaqueProblemSchema,
  PROBLEM_TYPE_PREFIX,
  ProblemCodeSchema,
  ProblemDocumentSchema,
} from "../../src/problem.ts";

const VALID_MINT_BODY_INVALID = new URL(
  "../fixtures/valid/problem-mint-body-invalid.json",
  import.meta.url,
);
const INVALID_UNTAUGHT = new URL(
  "../fixtures/invalid/problem-mint-body-invalid-untaught.json",
  import.meta.url,
);
const INVALID_UNKNOWN_CODE = new URL(
  "../fixtures/invalid/problem-unknown-code.json",
  import.meta.url,
);
const INVALID_OPAQUE_WITH_TEACHING_FIELDS = new URL(
  "../fixtures/invalid/problem-opaque-with-teaching-fields.json",
  import.meta.url,
);

const VALID_ADDITIONAL_PROBLEMS = [
  ["problem-unauthorized.json", "UNAUTHORIZED", 401, "opaque"],
  ["problem-auth-replay-store-unavailable.json", "AUTH_REPLAY_STORE_UNAVAILABLE", 503, "opaque"],
  ["problem-route-not-found.json", "ROUTE_NOT_FOUND", 404, "opaque"],
  ["problem-internal-error.json", "INTERNAL_ERROR", 500, "opaque"],
  ["problem-enrollment-id-invalid.json", "ENROLLMENT_ID_INVALID", 422, "contract"],
] as const;

async function fixture(url: URL): Promise<unknown> {
  try {
    return JSON.parse(await Bun.file(url).text()) as unknown;
  } catch {
    throw new Error("synthetic problem fixture is not valid JSON");
  }
}

test("the MINT_BODY_INVALID refusal the Worker emits validates as a contract problem", async () => {
  const parsed = ProblemDocumentSchema.safeParse(await fixture(VALID_MINT_BODY_INVALID));
  expect(parsed.success).toBe(true);
  if (!parsed.success) return;
  expect(parsed.data.code).toBe("MINT_BODY_INVALID");
  expect(parsed.data.type).toBe(`${PROBLEM_TYPE_PREFIX}MINT_BODY_INVALID`);
  expect(parsed.data.status).toBe(422);
});

test("mounted boundary, auth, and enrollment-id problems are in the closed contract", async () => {
  for (const [filename, code, status, transparency] of VALID_ADDITIONAL_PROBLEMS) {
    const document = await fixture(new URL(`../fixtures/valid/${filename}`, import.meta.url));
    const parsed = ProblemDocumentSchema.safeParse(document);
    expect(parsed.success, filename).toBe(true);
    if (!parsed.success) continue;
    expect(parsed.data.code, filename).toBe(code);
    expect(parsed.data.status, filename).toBe(status);
    expect(ContractProblemSchema.safeParse(document).success, filename).toBe(
      transparency === "contract",
    );
    expect(OpaqueProblemSchema.safeParse(document).success, filename).toBe(
      transparency === "opaque",
    );
  }
});

test("a contract refusal that teaches nothing is not a valid contract refusal", async () => {
  // Rule A5: a contract failure must hand back rule, schema, and an example.
  // Dropping them is the regression this fixture exists to fail on.
  expect(ProblemDocumentSchema.safeParse(await fixture(INVALID_UNTAUGHT)).success).toBe(false);
  expect(ContractProblemSchema.safeParse(await fixture(INVALID_UNTAUGHT)).success).toBe(false);
});

test("the refusal code set is closed", async () => {
  expect(ProblemDocumentSchema.safeParse(await fixture(INVALID_UNKNOWN_CODE)).success).toBe(false);
  expect(ProblemCodeSchema.safeParse("MINT_BODY_NOT_A_REAL_CODE").success).toBe(false);
  expect(ProblemCodeSchema.safeParse("MINT_BODY_INVALID").success).toBe(true);
});

test("MINT_BODY_INVALID is a teaching code, not an opaque one", () => {
  expect(CONTRACT_PROBLEM_CODES).toContain("MINT_BODY_INVALID");
  expect(OPAQUE_PROBLEM_CODES).not.toContain("MINT_BODY_INVALID" as never);
  // The two classes must stay disjoint, or a code's transparency is ambiguous.
  const opaque = new Set<string>(OPAQUE_PROBLEM_CODES);
  expect(CONTRACT_PROBLEM_CODES.filter((code) => opaque.has(code))).toEqual([]);
});

test("an opaque refusal may not acquire the teaching fields", async () => {
  const base = {
    type: `${PROBLEM_TYPE_PREFIX}ENROLLMENT_UNAVAILABLE`,
    title: "Enrollment is temporarily unavailable",
    status: 503,
    code: "ENROLLMENT_UNAVAILABLE",
    detail: "The enrollment service could not complete this request safely.",
    fix_hint: "Retry later with the same Idempotency-Key.",
  } as const;
  expect(OpaqueProblemSchema.safeParse(base).success).toBe(true);
  expect(
    OpaqueProblemSchema.safeParse({
      ...base,
      rule: "A5",
      schema: "https://a.asimposium.org/schemas/enrollment.v1.json",
      example: {},
    }).success,
  ).toBe(false);
  expect(
    OpaqueProblemSchema.safeParse(await fixture(INVALID_OPAQUE_WITH_TEACHING_FIELDS)).success,
  ).toBe(false);
});

test("credential and proposal-state refusals stay in the opaque class", () => {
  for (const code of [
    "FELLOW_TOKEN_INVALID",
    "FLOW_INVALID",
    "PAIRING_INVALID",
    "PROPOSAL_EXPIRED",
    "PROPOSAL_NOT_PENDING",
    "WRONG_PRINCIPAL",
  ] as const) {
    const document = {
      type: `${PROBLEM_TYPE_PREFIX}${code}`,
      title: "Request cannot be accepted",
      status: code === "WRONG_PRINCIPAL" ? 403 : 400,
      code,
      detail: "The request was not accepted.",
      fix_hint: "Use a current credential or inspect the sponsor's pending proposal list.",
    };
    expect(OpaqueProblemSchema.safeParse(document).success, code).toBe(true);
    expect(ContractProblemSchema.safeParse(document).success, code).toBe(false);
  }
});

test("`type` must be the errors URI for its own code", () => {
  const mismatched = {
    type: `${PROBLEM_TYPE_PREFIX}NAME_TAKEN`,
    title: "Sponsor mint body is invalid",
    status: 422,
    code: "MINT_BODY_INVALID",
    detail: "The signed JSON body does not match the enrollment mint contract.",
    fix_hint: "Send a strict JSON object with the requested scopes.",
    rule: "A5",
    schema: "https://a.asimposium.org/schemas/enrollment.v1.json",
    example: { requested_scopes: ["promote"] },
  };
  expect(ProblemDocumentSchema.safeParse(mismatched).success).toBe(false);
});
