import { test, expect } from "bun:test";
import {
  CreateReviewRequestSchema, RespondReviewRequestSchema, ReviewRequestsQuerySchema,
  ReviewRequestViewSchema, ReviewRequestsResponseSchema,
} from "@asimposium/contracts/review-requests";
import type { EnrollmentService, FellowCredentialBinding } from "../../src/enrollment/service.ts";
import type { Env } from "../../src/env.ts";
import { createReviewRequestRouter } from "../../src/review-requests/router.ts";
import { createSessionRouter } from "../../src/sessions/router.ts";
import { reviewRequestView } from "../../src/review-requests/service.ts";
import { hashText, type RequestRecord } from "../../src/review-requests/store.ts";

const AUTHOR = `F-${"A".repeat(26)}`, REVIEWER = `F-${"B".repeat(26)}`, ID = `RR-${"a".repeat(32)}`;
test("invitation contracts cannot set scientific status or delegate authority", () => {
  const request = { claim_id: "C-1", claim_version: 1, reviewer_id: REVIEWER };
  expect(CreateReviewRequestSchema.safeParse(request).success).toBe(true);
  for (const extra of [{ status: "completed" }, { tier: "T3" }, { author_id: AUTHOR }, { role: "steward" }]) {
    expect(CreateReviewRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false);
  }
  expect(RespondReviewRequestSchema.safeParse({ action: "complete", expected_version: 2 }).success).toBe(false);
  expect(RespondReviewRequestSchema.safeParse({ action: "complete", expected_version: 2, review_id: "R-1" }).success).toBe(true);
  expect(RespondReviewRequestSchema.safeParse({ action: "accept", expected_version: 1, review_id: "R-1" }).success).toBe(false);
  expect(ReviewRequestsQuerySchema.safeParse({ after: "123" }).success).toBe(false);
  expect(ReviewRequestsQuerySchema.safeParse({ after: ID }).success).toBe(true);
});
test("private views omit raw work products and global private sequence counters", async () => {
  const target = JSON.stringify({ statement: "PRIVATE-TEST-BODY-MUST-NOT-APPEAR" });
  const row: RequestRecord = {
    schema: "https://a.asimposium.org/schemas/review-requests.v1.json", request_id: ID,
    problem_id: "P-DEMO", claim_id: "C-1", claim_version: 1, claim_event_id: "EV-1",
    claim_payload_sha256: await hashText(target), author_id: AUTHOR, reviewer_id: REVIEWER,
    version: 1, status: "offered", created_at: 1000, updated_at: 1000, expires_at: 2000,
    review_event_id: null, seq: 987, author_sponsor_id: "usr_author", reviewer_sponsor_id: "usr_reviewer", target_json: target,
  };
  const view = await reviewRequestView(row, 1500);
  expect(view.effective_status).toBe("offered");
  expect(JSON.stringify(view)).not.toContain("PRIVATE-TEST-BODY");
  expect("seq" in view).toBe(false);
  expect(ReviewRequestViewSchema.safeParse({ ...view, seq: 987 }).success).toBe(false);
  expect((await reviewRequestView(row, 2000)).effective_status).toBe("expired");
  expect((await reviewRequestView({ ...row, target_json: "altered" }, 1500)).effective_status).toBe("target-unavailable");
  expect((await reviewRequestView({ ...row, status: "completed", version: 3, review_event_id: "EV-review", target_json: null }, 1500)).effective_status).toBe("completed");
});

/** Routing/contract fixture only. Scientific writes are never stubbed as
 * successful here; actual transactions and guards have their SQLite suite. */
for (const composed of [false, true]) {
  test(`invitation routes preserve authentication and strict queries (session composition=${composed})`, async () => {
    let authorized = false, reads = 0;
    const binding = { fellowId: AUTHOR, grantedResources: {}, fellowStatus: "active" } as FellowCredentialBinding;
    const service = { credentialBinding: async () => authorized ? binding : undefined } as unknown as EnrollmentService;
    const replayProtector = {
      async seal(): Promise<never> { throw new Error("Unexpected write"); },
      async open(): Promise<never> { throw new Error("Unexpected replay"); },
    };
    const db = { prepare() { reads++; return { bind() { return {
      async first() { return { id: "P-DEMO" }; }, async all() { return { results: [] }; },
    }; } }; } } as unknown as Env["DB"];
    const env = { DB: db } as Env;
    const options = { service, replayProtector };
    const app = composed ? createSessionRouter(options) : createReviewRequestRouter(options);
    const root = "/v1/p/P-DEMO/review-requests";
    const send = (path: string, init?: RequestInit) => app.fetch(new Request(`https://a.asimposium.org${path}`, init), env);
    for (const path of [root, `${root}/${ID}`, `${root}/${ID}/respond`]) {
      const response = await send(path, { method: path.endsWith("respond") ? "POST" : "GET" });
      expect(response.status).toBe(401); expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(reads).toBe(0);
    authorized = true;
    const headers = { authorization: "Bearer unit-test-binding" };
    const list = await send(root, { headers });
    expect(list.status).toBe(200); expect(ReviewRequestsResponseSchema.parse(await list.json()).requests).toEqual([]);
    const head = await send(root, { headers, method: "HEAD" });
    expect(head.status).toBe(200); expect(await head.text()).toBe("");
    for (const query of ["?after=1", `?after=${ID}&after=${ID}`, "?fellow_id=someone-else"]) {
      expect((await send(root + query, { headers })).status).toBe(400);
    }
    expect((await send(root, { method: "POST", headers, body: "{}" })).status).toBe(400);
    expect((await send(root, { method: "POST", headers: { ...headers, "content-type": "application/json", "idempotency-key": "invalid-body" }, body: JSON.stringify({ disposition: "proved" }) })).status).toBe(400);
  });
}
