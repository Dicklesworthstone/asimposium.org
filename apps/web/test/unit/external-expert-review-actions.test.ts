import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import type { OperatorSessionResult } from "../../lib/admin";
import type { StoaCall } from "../../lib/stoa";
import type { ExternalExpertReviewRecord } from "@asimposium/contracts";
import { externalReviewInput, externalReviewOperator, externalReviewProblem, externalReviewRecord } from "../fixtures/external-expert-review";

mock.module("server-only", () => ({}));
let session: OperatorSessionResult;
// Model older or unrecognized error codes returned by the mocked transport.
let response: StoaCall<ExternalExpertReviewRecord> | {
  ok: false; reason: "refused"; status: 404; problemCode?: "NOT_FOUND" | "UNKNOWN_ROUTE";
};
let fail: boolean;
const writes: unknown[][] = [];
let actualAdmin: typeof import("../../lib/admin");
let actualTransport: typeof import("../../lib/external-expert-reviews");
let actions: typeof import("../../app/admin/external-reviews/actions");
beforeAll(async () => {
  actualAdmin = { ...(await import("../../lib/admin")) };
  actualTransport = { ...(await import("../../lib/external-expert-reviews")) };
  mock.module("@/lib/admin", () => ({ ...actualAdmin, requireOperatorSession: async () => session }));
  mock.module("@/lib/external-expert-reviews", () => ({ ...actualTransport,
    stoaRecordExternalExpertReview: async (...args: unknown[]) => {
      writes.push(args);
      if (fail) throw new Error("PRIVATE_OPERATOR_FAILURE");
      return response;
    },
  }));
  const path: string = "../../app/admin/external-reviews/actions?isolated-external-review-test";
  actions = await import(path) as typeof actions;
});
beforeEach(() => {
  session = { state: "authorized", operatorId: externalReviewOperator, authIssuedAt: Math.floor(Date.now() / 1000) };
  response = { ok: true, data: externalReviewRecord };
  fail = false;
  writes.length = 0;
});
afterAll(() => {
  mock.module("@/lib/admin", () => actualAdmin);
  mock.module("@/lib/external-expert-reviews", () => actualTransport);
});

test("each record attempt requires current matching operator, recent authentication and explicit confirmation", async () => {
  for (const state of [
    { state: "unauthenticated" },
    { state: "forbidden", principalId: externalReviewOperator },
    { state: "step_up_required", operatorId: externalReviewOperator, authIssuedAt: undefined },
    { state: "authorized", operatorId: "usr_fedcba0987654321", authIssuedAt: Math.floor(Date.now() / 1000) },
  ] as const) {
    session = state;
    expect(await actions.recordExternalReviewAction(externalReviewOperator, externalReviewProblem, externalReviewInput, "key", true))
      .toMatchObject({ ok: false, retainAttempt: true, reauthenticate: true });
  }
  session = { state: "authorized", operatorId: externalReviewOperator, authIssuedAt: Math.floor(Date.now() / 1000) };
  expect(await actions.recordExternalReviewAction(externalReviewOperator, externalReviewProblem, externalReviewInput, "key", false))
    .toMatchObject({ ok: false, retainAttempt: true });
  expect(await actions.recordExternalReviewAction(externalReviewOperator, externalReviewProblem, { ...externalReviewInput, claim_version: 0 }, "key", true))
    .toMatchObject({ ok: false, retainAttempt: true });
  expect(await actions.recordExternalReviewAction(externalReviewOperator, externalReviewProblem, externalReviewInput, "key\n", true))
    .toMatchObject({ ok: false, retainAttempt: true });
  expect(writes).toHaveLength(0);
});

test("lost replies preserve the same attestation and key for direct recovery without fresh inspection", async () => {
  response = { ok: false, reason: "unreachable" };
  const missing = await actions.recordExternalReviewAction(externalReviewOperator, externalReviewProblem, externalReviewInput, "retained-key", true);
  expect(missing).toMatchObject({ ok: false, retainAttempt: true });
  fail = true;
  const thrown = await actions.recordExternalReviewAction(externalReviewOperator, externalReviewProblem, externalReviewInput, "retained-key", true);
  expect(thrown).toMatchObject({ ok: false, retainAttempt: true });
  expect(JSON.stringify(thrown)).not.toContain("PRIVATE_OPERATOR_FAILURE");
  fail = false;
  response = { ok: true, data: externalReviewRecord };
  expect(await actions.recordExternalReviewAction(externalReviewOperator, externalReviewProblem, externalReviewInput, "retained-key", true))
    .toEqual({ ok: true, record: externalReviewRecord });
  expect(writes).toEqual(Array.from({ length: 3 }, () => [externalReviewOperator, externalReviewProblem, externalReviewInput, "retained-key"]));
});

test("only a typed contract refusal settles the attempt; lost authority and ambiguous replies preserve it", async () => {
  response = { ok: false, reason: "refused", status: 422, problemCode: "SECRET_SHAPED_CONTENT", detail: "PRIVATE_DETAILS" };
  const rejected = await actions.recordExternalReviewAction(externalReviewOperator, externalReviewProblem, externalReviewInput, "key", true);
  expect(rejected).toMatchObject({ ok: false, retainAttempt: false });
  expect(JSON.stringify(rejected)).not.toContain("PRIVATE_DETAILS");
  for (const refusal of [
    { ok: false, reason: "unreachable" }, { ok: false, reason: "unconfigured" },
    { ok: false, reason: "refused", status: 422 },
    { ok: false, reason: "refused", status: 409, problemCode: "IDEMPOTENCY_CONFLICT" },
    { ok: false, reason: "refused", status: 404 },
    { ok: false, reason: "refused", status: 403 },
  ] as const) {
    response = refusal;
    expect(await actions.recordExternalReviewAction(externalReviewOperator, externalReviewProblem, externalReviewInput, "key", true))
      .toMatchObject({ ok: false, retainAttempt: true });
  }
});

test("only the backend's typed missing-target 404s settle an unrecorded attestation", async () => {
  for (const problemCode of ["CLAIM_NOT_FOUND", "PROBLEM_NOT_FOUND"] as const) {
    response = { ok: false, reason: "refused", status: 404, problemCode, detail: "PRIVATE_TARGET_DETAILS" };
    const result = await actions.recordExternalReviewAction(externalReviewOperator, externalReviewProblem, externalReviewInput, "missing-target-key", true);
    expect(result).toMatchObject({ ok: false, retainAttempt: false });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_TARGET_DETAILS");
  }
  for (const problemCode of [undefined, "NOT_FOUND", "UNKNOWN_ROUTE"] as const) {
    response = { ok: false, reason: "refused", status: 404, ...(problemCode === undefined ? {} : { problemCode }) };
    expect(await actions.recordExternalReviewAction(externalReviewOperator, externalReviewProblem, externalReviewInput, "uncertain-key", true))
      .toMatchObject({ ok: false, retainAttempt: true });
  }
});

test("oversized UTF-8 requests never dispatch and old pending identity remains intact", async () => {
  const input = { ...externalReviewInput, no_claim_boundary: {
    ...externalReviewInput.no_claim_boundary, verified: Array.from({ length: 140 }, () => "é".repeat(250)),
  } };
  const result = await actions.recordExternalReviewAction(externalReviewOperator, externalReviewProblem, input, "original-oversize-key", true);
  expect(result).toMatchObject({ ok: false, retainAttempt: true });
  if (!result.ok) expect(result.message).toContain("64 KiB");
  expect(writes).toHaveLength(0);
});
