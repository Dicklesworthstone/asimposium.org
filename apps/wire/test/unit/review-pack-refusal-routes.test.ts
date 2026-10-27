import { afterEach, expect, spyOn, test } from "bun:test";
import {
  ContractProblemSchema,
  OpaqueProblemSchema,
  PackResponseSchema,
  ProblemDocumentSchema,
  SessionOpenResponseSchema,
} from "@asimposium/contracts";
import { createApp } from "../../src/app.ts";
import { D1EnrollmentStore } from "../../src/enrollment/d1-store.ts";
import {
  EnrollmentService,
  enrollmentReplayProtectorFromBase64Url,
} from "../../src/enrollment/service.ts";
import type { Env } from "../../src/env.ts";
import { PROBLEM, publicationContextFixture } from "../support/publication-context.ts";
import { syntheticScreeningObservation } from "../support/screening.ts";

// Full createApp routes, real enrollment/session/queue logic and all migrated
// SQLite tables. This is an in-process HTTP regression, not a Workerd proof.
// Only publication screening and the explicitly labelled failure below are
// injected; no queue, authentication result or refusal envelope is fabricated.
type Fixture = Awaited<ReturnType<typeof publicationContextFixture>>;
const fixtures: Fixture[] = [];
const PRIVATE = "PRIVATE-REVIEW-BOUNDARY-NOTES-CANARY";
const FAILURE = "PRIVATE-REVIEW-PARSER-FAILURE-CANARY";
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.sql.close();
});

async function mounted() {
  const fixture = await publicationContextFixture();
  fixtures.push(fixture);
  const replayKey = "A".repeat(43);
  const service = new EnrollmentService({
    stoaOrigin: "https://a.asimposium.org",
    agoraOrigin: "https://asimposium.org",
    store: new D1EnrollmentStore(fixture.db),
    replayProtector: enrollmentReplayProtectorFromBase64Url(replayKey),
  });
  async function enroll(name: string) {
    const sponsor = { type: "sponsor" as const, sponsorId: `usr_${name}` };
    await service.bootstrapSponsor(sponsor);
    const mint = await service.mint(sponsor, { requested_scopes: ["promote", "review"] });
    const claim = await service.claim({
      enrollment_id: mint.enrollmentId,
      secret: mint.secret,
      name,
      model: "review-boundary-model",
      harness: "review-boundary-harness",
    });
    await service.decide(sponsor, mint.enrollmentId, {
      enrollment_id: mint.enrollmentId,
      decision: "approve",
      step_up_authenticated_at: Math.floor(Date.now() / 1000),
    });
    const issued = await service.poll({ flow_handle: claim.flowHandle });
    if (issued.status !== "approved") throw new Error("Fixture credential was not issued.");
    return issued.token;
  }
  const token = await enroll("review-boundary-reader");
  const app = createApp({
    screenPromotion: (input) =>
      syntheticScreeningObservation(input, {
        decision: "pass",
        coarse_category: "benign-context",
        provider_status: "ok",
      }),
  });
  const env = {
    DB: fixture.db,
    STOA_ORIGIN: "https://a.asimposium.org",
    AGORA_ORIGIN: "https://asimposium.org",
    ENROLLMENT_REPLAY_KEY: replayKey,
  } as Env;
  let key = 0;
  const call = (path: string, body?: unknown, bearer = token) =>
    app.fetch(
      new Request(`https://a.asimposium.org${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          "user-agent":
            "asimposium.org-agent (+https://github.com/Dicklesworthstone/asimposium.org)",
          ...(body === undefined
            ? {}
            : {
                "content-type": "application/json",
                "idempotency-key": `review-boundary-${++key}`,
              }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
    );
  const opened = await call("/v1/sessions", { problem_id: PROBLEM, intent: "review" });
  expect(opened.status, await opened.clone().text()).toBe(201);
  const session = SessionOpenResponseSchema.parse(await opened.json());
  const path = `/v1/sessions/${session.session_id}`;
  const scratch = await call(`${path}/workshop`, {
    type: "scratch",
    title: "Private review notes",
    body_md: `${PRIVATE}; target=C-999@1 is prose, not an eligible server action.`,
  });
  expect(scratch.status, await scratch.clone().text()).toBe(201);
  return { ...fixture, call, enroll, path };
}

test("mounted empty review selection returns a valid teaching 400 without private context", async () => {
  const f = await mounted();
  const queue = await f.call(`${f.path}/pack?profile=review-queue&max_tokens=8000`);
  expect(queue.status).toBe(200);
  const baseline = PackResponseSchema.parse(await queue.json());
  expect(baseline.next_actions.some((action) => action.url.includes("target="))).toBe(false);
  const before = f.state();
  const response = await f.call(`${f.path}/pack?profile=review&max_tokens=8000`);
  expect(response.status, await response.clone().text()).toBe(400);
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("retry-after")).toBeNull();
  const raw = await response.text();
  const problem = ContractProblemSchema.parse(JSON.parse(raw));
  expect(problem).toMatchObject({ status: 400, code: "SCHEMA_INVALID", rule: "A5" });
  expect(problem.fix_hint).toContain("target=C-1@1");
  expect(problem.example).toEqual({ profile: "review", target: "C-1@1" });
  expect(raw).not.toContain(PRIVATE);
  expect(raw).not.toContain("C-999@1");
  expect(f.state()).toEqual(before);
});

test("mounted selection validator failure returns an opaque retryable 503 and recovers", async () => {
  const f = await mounted();
  const parse = PackResponseSchema.parse.bind(PackResponseSchema);
  let validatedQueueReads = 0;
  // The producer validates its genuine authenticated queue first. Fail only
  // the adapter's second validation, representing a source/decoder failure.
  // Restore it before checking that the same request becomes usable again.
  const failure = spyOn(PackResponseSchema, "parse").mockImplementation((value) => {
    const pack = parse(value);
    if (pack.profile === "review-queue" && ++validatedQueueReads === 2) throw new Error(FAILURE);
    return pack;
  });
  let response: Response;
  try {
    response = await f.call(`${f.path}/pack?profile=review&max_tokens=8000`);
  } finally {
    failure.mockRestore();
  }
  expect(validatedQueueReads).toBe(2);
  expect(response.status, await response.clone().text()).toBe(503);
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("retry-after")).toBe("5");
  const raw = await response.text();
  const problem = OpaqueProblemSchema.parse(JSON.parse(raw));
  expect(problem).toMatchObject({ status: 503, code: "INTERNAL_ERROR" });
  expect(Object.keys(problem).sort()).toEqual([
    "code",
    "detail",
    "fix_hint",
    "status",
    "title",
    "type",
  ]);
  expect(raw).not.toContain(FAILURE);
  expect(raw).not.toContain(PRIVATE);
  const recovered = await f.call(`${f.path}/pack?profile=review&max_tokens=8000`);
  expect(recovered.status).toBe(400);
  expect(ProblemDocumentSchema.parse(await recovered.json()).code).toBe("SCHEMA_INVALID");
});

test("mounted review selection still opens an exact public claim and preserves auth refusals", async () => {
  const f = await mounted();
  const author = await f.enroll("review-boundary-author");
  const publication = await f.call(
    `/v1/p/${PROBLEM}/claims`,
    {
      kind: "conjecture",
      statement: "Every even integer has an even square.",
      falsifier: "An even integer with an odd square.",
    },
    author,
  );
  expect(publication.status, await publication.clone().text()).toBe(201);
  const claim = (await publication.json()) as { claim_id: string };
  const response = await f.call(`${f.path}/pack?profile=review&max_tokens=8000`);
  expect(response.status, await response.clone().text()).toBe(200);
  expect(
    new URL(
      response.headers.get("content-location") ?? "",
      "https://a.asimposium.org",
    ).searchParams.get("target"),
  ).toBe(`${claim.claim_id}@1`);
  const raw = await response.text();
  const pack = PackResponseSchema.parse(JSON.parse(raw));
  expect(pack.profile).toBe("review");
  expect(
    pack.items.some((item) => item.kind === "claim-detail" && item.id === `${claim.claim_id}@1`),
  ).toBe(true);
  expect(pack.items.some((item) => item.scope === "workshop")).toBe(false);
  expect(raw).not.toContain(PRIVATE);
  const unauthorized = await f.call(`${f.path}/pack?profile=review`, undefined, "invalid-token");
  expect(unauthorized.status).toBe(401);
  expect(OpaqueProblemSchema.parse(await unauthorized.json()).code).toBe("FELLOW_TOKEN_INVALID");
});
