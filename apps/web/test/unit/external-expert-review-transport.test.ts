import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { PRODUCTION_STOA_ORIGIN } from "@asimposium/contracts";
import { payloadDigest, SERVICE_ENVELOPE_HEADER } from "../../lib/service-envelope";
import {
  externalReviewInput, externalReviewOperator, externalReviewProblem, externalReviewRecord,
} from "../fixtures/external-expert-review";

mock.module("server-only", () => ({}));
const { stoaExternalExpertReviews, stoaRecordExternalExpertReview } = await import("../../lib/external-expert-reviews");
const envKeys = ["STOA_ORIGIN", "SERVICE_ENVELOPE_PRIVATE_KEY_HEX", "SERVICE_ENVELOPE_KID", "OPERATOR_PRINCIPAL_IDS"] as const;
const realFetch = globalThis.fetch;
let previous: Map<string, string | undefined>;
beforeEach(() => {
  previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  process.env.STOA_ORIGIN = PRODUCTION_STOA_ORIGIN;
  process.env.SERVICE_ENVELOPE_PRIVATE_KEY_HEX = "24".repeat(32);
  process.env.SERVICE_ENVELOPE_KID = "external-review-test";
  process.env.OPERATOR_PRINCIPAL_IDS = externalReviewOperator;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of envKeys) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test("operator records and retries the exact signed attestation with one retained key", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Response.json(externalReviewRecord, { status: 201 });
  }) as unknown as typeof fetch;
  for (let retry = 0; retry < 2; retry++)
    expect(await stoaRecordExternalExpertReview(externalReviewOperator, externalReviewProblem, externalReviewInput, "record-same-key"))
      .toEqual({ ok: true, data: externalReviewRecord });
  expect(calls).toHaveLength(2);
  const path = "/v1/operators/problems/" + externalReviewProblem + "/external-expert-reviews";
  for (const call of calls) {
    expect(call.url).toBe(PRODUCTION_STOA_ORIGIN + path);
    expect(call.init).toMatchObject({ method: "POST", credentials: "omit", cache: "no-store", redirect: "error", body: JSON.stringify(externalReviewInput) });
    const headers = new Headers(call.init.headers);
    expect(headers.get("idempotency-key")).toBe("record-same-key");
    expect(headers.has("cookie")).toBe(false);
    expect(JSON.parse(headers.get(SERVICE_ENVELOPE_HEADER) ?? "{}").claims).toMatchObject({
      principal_type: "operator", principal_id: externalReviewOperator, route: path,
      action: "operator.external-expert-reviews.create", payload_sha256: await payloadDigest(JSON.stringify(externalReviewInput)),
    });
  }
});

test("a 2xx receipt cannot substitute claim, operator, attribution, scope, source, verdict or review date", async () => {
  let body: unknown;
  globalThis.fetch = mock(async () => Response.json(body)) as unknown as typeof fetch;
  for (const changed of [
    { problem_id: "P-OTHER" }, { claim_id: "C-4" }, { claim_version: 3 },
    { verified_by_operator_id: "usr_fedcba0987654321" },
    { reviewer: { ...externalReviewRecord.reviewer, name: "Another reviewer" } },
    { attestation_locator: "https://example.org/other" }, { attestation_sha256: "c".repeat(64) },
    { verdict: "withheld" }, { reviewed_at: "2026-11-25T12:00:00.000Z" },
    { no_claim_boundary: { ...externalReviewRecord.no_claim_boundary, verified: ["A stronger assertion."] } },
  ]) {
    body = { ...externalReviewRecord, ...changed };
    expect(await stoaRecordExternalExpertReview(externalReviewOperator, externalReviewProblem, externalReviewInput, "key"))
      .toEqual({ ok: false, reason: "unreachable" });
  }
});

test("operator inspection matches problem scope and refuses malformed or duplicated history", async () => {
  let body: unknown = { problem_id: externalReviewProblem, reviews: [externalReviewRecord] };
  const calls: RequestInit[] = [];
  globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(init ?? {});
    return Response.json(body);
  }) as unknown as typeof fetch;
  expect(await stoaExternalExpertReviews(externalReviewOperator, externalReviewProblem))
    .toEqual({ ok: true, data: [externalReviewRecord] });
  expect(JSON.parse(new Headers(calls[0]!.headers).get(SERVICE_ENVELOPE_HEADER) ?? "{}").claims)
    .toMatchObject({ principal_type: "operator", action: "operator.external-expert-reviews.list" });
  for (const invalid of [
    { problem_id: "P-OTHER", reviews: [] },
    { problem_id: externalReviewProblem, reviews: [{ ...externalReviewRecord, problem_id: "P-OTHER" }] },
    { problem_id: externalReviewProblem, reviews: [externalReviewRecord, externalReviewRecord] },
    { problem_id: externalReviewProblem, reviews: "empty" },
    { problem_id: externalReviewProblem, reviews: [], unexpected: true },
  ]) {
    body = invalid;
    expect(await stoaExternalExpertReviews(externalReviewOperator, externalReviewProblem))
      .toEqual({ ok: false, reason: "unreachable" });
  }
});

test("invalid targets, keys, input and an absent operator allowlist never dispatch", async () => {
  const fetcher = mock(async () => Response.json(externalReviewRecord));
  globalThis.fetch = fetcher as unknown as typeof fetch;
  for (const problem of ["../private", externalReviewProblem + "\n"]) {
    expect((await stoaExternalExpertReviews(externalReviewOperator, problem)).ok).toBe(false);
    expect((await stoaRecordExternalExpertReview(externalReviewOperator, problem, externalReviewInput, "key")).ok).toBe(false);
  }
  for (const key of ["", "bad key", "key\n"])
    expect((await stoaRecordExternalExpertReview(externalReviewOperator, externalReviewProblem, externalReviewInput, key)).ok).toBe(false);
  expect((await stoaRecordExternalExpertReview(externalReviewOperator, externalReviewProblem, { ...externalReviewInput, claim_version: 0 }, "key")).ok).toBe(false);
  delete process.env.OPERATOR_PRINCIPAL_IDS;
  expect((await stoaExternalExpertReviews(externalReviewOperator, externalReviewProblem)).ok).toBe(false);
  expect((await stoaRecordExternalExpertReview(externalReviewOperator, externalReviewProblem, externalReviewInput, "key")).ok).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
});

test("lost-response recovery accepts the matching record's current revocation without restoring authority", async () => {
  const revoked = { ...externalReviewRecord, revoked_at: "2026-11-26T13:00:00.000Z" };
  globalThis.fetch = mock(async () => Response.json(revoked)) as unknown as typeof fetch;
  expect(await stoaRecordExternalExpertReview(externalReviewOperator, externalReviewProblem, externalReviewInput, "old-record-key"))
    .toEqual({ ok: true, data: revoked });
});

test("oversized multibyte attestations are refused before signing or network dispatch", async () => {
  const fetcher = mock(async () => Response.json(externalReviewRecord));
  globalThis.fetch = fetcher as unknown as typeof fetch;
  const input = { ...externalReviewInput, no_claim_boundary: {
    ...externalReviewInput.no_claim_boundary, verified: Array.from({ length: 140 }, () => "é".repeat(250)),
  } };
  expect(JSON.stringify(input).length).toBeLessThan(65_536);
  expect(new TextEncoder().encode(JSON.stringify(input)).byteLength).toBeGreaterThan(65_536);
  expect(await stoaRecordExternalExpertReview(externalReviewOperator, externalReviewProblem, input, "oversize"))
    .toEqual({ ok: false, reason: "refused", status: 413, problemCode: "REQUEST_BODY_TOO_LARGE" });
  expect(fetcher).not.toHaveBeenCalled();
});

test("bounded operator history admits fifty individually valid near-limit UTF-8 records", async () => {
  const input = { ...externalReviewInput, no_claim_boundary: {
    ...externalReviewInput.no_claim_boundary, verified: Array.from({ length: 124 }, () => "é".repeat(250)),
  } };
  expect(new TextEncoder().encode(JSON.stringify(input)).byteLength).toBeLessThanOrEqual(65_536);
  const records = Array.from({ length: 50 }, (_, index) => ({
    ...externalReviewRecord, no_claim_boundary: input.no_claim_boundary,
    review_record_id: "EER-" + String(index + 1).padStart(26, "0"),
  }));
  const body = JSON.stringify({ problem_id: externalReviewProblem, reviews: records });
  expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(1_048_576);
  globalThis.fetch = mock(async () => new Response(body, { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  expect(await stoaExternalExpertReviews(externalReviewOperator, externalReviewProblem))
    .toEqual({ ok: true, data: records });
});
