import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ExternalExpertReviewRecord } from "@asimposium/contracts";
import type { OperatorSessionResult } from "../../lib/admin";
import type { StoaCall } from "../../lib/stoa";
import { externalReviewOperator, externalReviewProblem, externalReviewRecord } from "../fixtures/external-expert-review";

mock.module("server-only", () => ({}));
let session: OperatorSessionResult;
let reply: StoaCall<readonly ExternalExpertReviewRecord[]>;
const reads: unknown[][] = [];
let realAdmin: typeof import("../../lib/admin");
let realTransport: typeof import("../../lib/external-expert-reviews");
let page: typeof import("../../app/admin/external-reviews/page");
beforeAll(async () => {
  realAdmin = { ...(await import("../../lib/admin")) };
  realTransport = { ...(await import("../../lib/external-expert-reviews")) };
  mock.module("@/lib/admin", () => ({ ...realAdmin, requireOperatorSession: async () => session }));
  mock.module("@/lib/external-expert-reviews", () => ({ ...realTransport,
    stoaExternalExpertReviews: async (...args: unknown[]) => { reads.push(args); return reply; },
  }));
  const path: string = "../../app/admin/external-reviews/page?isolated-external-review-page";
  page = await import(path) as typeof page;
});
beforeEach(() => {
  session = { state: "authorized", operatorId: externalReviewOperator, authIssuedAt: Math.floor(Date.now() / 1000) };
  reply = { ok: true, data: [externalReviewRecord] };
  reads.length = 0;
});
afterAll(() => {
  mock.module("@/lib/admin", () => realAdmin);
  mock.module("@/lib/external-expert-reviews", () => realTransport);
});

test("anonymous and non-operator pages neither read nor expose private external review records", async () => {
  for (const state of [
    { state: "unauthenticated" },
    { state: "forbidden", principalId: "usr_fedcba0987654321" },
  ] as const) {
    session = state;
    const html = renderToStaticMarkup(await page.default({ searchParams: Promise.resolve({ problem: externalReviewProblem }) }));
    expect(html).not.toContain(externalReviewRecord.review_record_id);
    expect(html).not.toContain(externalReviewRecord.reviewer.name);
    expect(html).not.toContain(externalReviewRecord.attestation_sha256);
  }
  expect(reads).toHaveLength(0);
  expect(page.metadata.robots).toEqual({ index: false, follow: false });
  expect(page.dynamic).toBe("force-dynamic");
});

test("operator inspection is exact and malformed/repeated query values never fan out", async () => {
  for (const query of [
    { problem: [externalReviewProblem, "P-OTHER"] },
    { problem: externalReviewProblem, extra: "private" },
    { problem: externalReviewProblem + "\n" },
  ]) {
    const html = renderToStaticMarkup(await page.default({ searchParams: Promise.resolve(query) }));
    expect(html).toContain("Choose one canonical problem identifier");
    expect(html).not.toContain(externalReviewRecord.review_record_id);
  }
  expect(reads).toHaveLength(0);
  const html = renderToStaticMarkup(await page.default({ searchParams: Promise.resolve({ problem: externalReviewProblem }) }));
  expect(reads).toEqual([[externalReviewOperator, externalReviewProblem]]);
  expect(html).toContain(externalReviewRecord.review_record_id);
  expect(html).toContain("up to 50 recent records");
});

test("an interrupted history preserves the recovery control and never fabricates an empty history", async () => {
  reply = { ok: false, reason: "unreachable" };
  const html = renderToStaticMarkup(await page.default({ searchParams: Promise.resolve({ problem: externalReviewProblem }) }));
  expect(html).toContain("External review history unavailable");
  expect(html).toContain("record-external-review");
  expect(html).not.toContain("No external review records were returned");
});
