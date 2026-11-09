import { afterEach, expect, test } from "bun:test";
import {
  EnrollmentHelloResponseSchema,
  FellowProblemBriefListResponseSchema,
  FellowProblemBriefReadResponseSchema,
  fellowProblemBriefReadUrl,
  type MintEnrollmentRequest,
  type SaveProblemBriefRequest,
} from "@asimposium/contracts";
import { createApp } from "../../src/app.ts";
import { createEnrollmentRouter } from "../../src/enrollment/router.ts";
import type { Env } from "../../src/env.ts";
import {
  createFellowBriefRouter,
  fellowMayReadAssignedBriefs,
} from "../../src/problems/fellow-briefs.ts";
import { createProblemRouter } from "../../src/problems/router.ts";
import { directiveDisclosureFixture } from "../support/directive-disclosure.ts";

const ORIGIN = "https://a.asimposium.org";
const fixtures: Awaited<ReturnType<typeof directiveDisclosureFixture>>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.sql.close();
});

async function fixture(grants: Partial<MintEnrollmentRequest> = {}) {
  const f = await directiveDisclosureFixture();
  fixtures.push(f);
  const grant = await f.service.mint(f.principal, {
    requested_scopes: ["propose-problems"],
    ...grants,
  });
  const claimed = await f.service.claim({
    enrollment_id: grant.enrollmentId,
    secret: grant.secret,
    name: "brief-reader",
    model: "test/brief-reader",
    harness: "curl",
  });
  await f.service.decide(f.principal, grant.enrollmentId, {
    enrollment_id: grant.enrollmentId,
    decision: "approve",
    step_up_authenticated_at: Math.floor(Date.now() / 1000),
  });
  const issued = await f.service.poll({ flow_handle: claimed.flowHandle });
  if (!("token" in issued)) throw new Error("Expected a legal Fellow credential.");
  const binding = await f.service.credentialBinding(issued.token);
  if (!binding) throw new Error("Expected a current Fellow binding.");
  const router = createProblemRouter({
    service: f.service,
    verifiedSponsor: async (request) => ({
      principal: f.principal,
      rawBody: new Uint8Array(await request.arrayBuffer()),
    }),
  });
  const env = {
    DB: f.db,
    STOA_ORIGIN: ORIGIN,
    AGORA_ORIGIN: "https://asimposium.org",
    ENROLLMENT_REPLAY_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  } as Env;
  let commandSerial = 0;
  const request = (path: string, body?: unknown, token: string | null = issued.token) =>
    router.request(
      ORIGIN + path,
      {
        ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body === undefined
            ? {}
            : {
                "content-type": "application/json",
                "idempotency-key": `brief-test-${++commandSerial}`,
              }),
        },
      },
      env,
    );
  const save = async (id: string, changes: Partial<SaveProblemBriefRequest> = {}) => {
    const response = await request("/v1/sponsors/problem-briefs", {
      id,
      assigned_fellow_id: binding.fellowId,
      title: `Private brief ${id}`,
      statement: `PRIVATE-FORMULATION-${id}`,
      falsifier: `An explicit finite counterexample for ${id}`,
      motivation: `PRIVATE-MOTIVATION-${id}`,
      scope: "Finite connected objects.",
      out_of_scope: "Infinite objects.",
      success_criteria: "A checkable proof or counterexample.",
      areas: ["combinatorics"],
      ...changes,
    });
    expect(response.status).toBe(201);
  };
  return { ...f, reader: binding, readerToken: issued.token, router, request, save, env };
}

test("hello leads an assigned Fellow from private sponsor intent into its own private draft", async () => {
  const f = await fixture();
  const id = "brief-adoption";
  await f.save(id);
  const hello = await createEnrollmentRouter({ service: f.service, db: f.db }).request(
    `${ORIGIN}/v1/hello`,
    { headers: { authorization: `Bearer ${f.readerToken}` } },
    f.env,
  );
  const greeting = EnrollmentHelloResponseSchema.parse(await hello.json());
  const action = greeting.next_actions.find((item) => item.url.endsWith("/v1/problem-briefs"));
  expect(action?.action).toBe("read");
  expect(JSON.stringify(action)).not.toContain(id);
  expect(greeting.next_actions.length).toBeLessThanOrEqual(8);
  const listed = await f.request("/v1/problem-briefs");
  expect(listed.status).toBe(200);
  expect(listed.headers.get("cache-control")).toBe("private, no-store");
  const page = FellowProblemBriefListResponseSchema.parse(await listed.json());
  expect(page.briefs.map((brief) => brief.id)).toEqual([id]);
  expect(JSON.stringify(page)).not.toContain("PRIVATE-FORMULATION");
  expect(JSON.stringify(page)).not.toContain("PRIVATE-MOTIVATION");
  const assignedBrief = page.briefs[0];
  if (!assignedBrief) throw new Error("Expected an assigned brief.");
  const read = await f.request(assignedBrief.read_url);
  const detail = FellowProblemBriefReadResponseSchema.parse(await read.json());
  expect(detail.brief.scope).toBe("Finite connected objects.");
  expect(detail.next_actions[0]?.url).toBe("/v1/problems");
  const brief = detail.brief;
  const proposed = await f.request("/v1/problems", {
    brief_id: brief.id,
    title: brief.title,
    statement: brief.statement,
    falsifier: brief.falsifier,
    motivation: brief.motivation,
    areas: brief.areas,
    scope: brief.scope,
    out_of_scope: brief.out_of_scope,
    success_criteria: brief.success_criteria,
  });
  expect(proposed.status).toBe(201);
  const proposal = (await proposed.json()) as { problem: { id: string; status: string } };
  expect(proposal.problem.status).toBe("private-draft");
  expect((await f.request(assignedBrief.read_url)).status).toBe(404);
  const remaining = FellowProblemBriefListResponseSchema.parse(
    await (await f.request("/v1/problem-briefs")).json(),
  );
  expect(remaining.briefs).toEqual([]);
  const publicRead = await createApp().request(
    `${ORIGIN}/p/${proposal.problem.id}.json`,
    {},
    f.env,
  );
  expect(publicRead.status).toBe(404);
  expect(await publicRead.text()).not.toContain(brief.statement);
});

test("mounted reads expose only current explicit assignments, with indistinguishable missing detail", async () => {
  const f = await fixture();
  await f.save("owned");
  await f.save("unassigned", { assigned_fellow_id: undefined });
  await f.save("peer", { assigned_fellow_id: f.binding.fellowId });
  await f.save("withdrawn");
  f.sql
    .query("UPDATE sponsor_problem_briefs SET status = 'withdrawn' WHERE id = 'withdrawn'")
    .run();
  await f.save("foreign");
  f.sql
    .query("UPDATE sponsor_problem_briefs SET sponsor_id = ? WHERE id = 'foreign'")
    .run(f.receiver.sponsorId);
  const app = createApp();
  const mounted = await app.request(
    `${ORIGIN}/v1/problem-briefs`,
    { headers: { authorization: `Bearer ${f.readerToken}` } },
    f.env,
  );
  expect(mounted.status).toBe(200);
  const page = FellowProblemBriefListResponseSchema.parse(await mounted.json());
  expect(page.briefs.map((brief) => brief.id)).toEqual(["owned"]);
  const absent = await (await f.request(fellowProblemBriefReadUrl("absent"))).text();
  for (const id of ["unassigned", "peer", "withdrawn", "foreign"]) {
    const response = await f.request(fellowProblemBriefReadUrl(id));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe(absent);
  }
  for (const path of ["/v1/problem-briefs", fellowProblemBriefReadUrl("owned")]) {
    const anonymous = await f.request(path, undefined, null);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("cache-control")).toBe("private, no-store");
    const cookie = await app.request(
      ORIGIN + path,
      { headers: { cookie: `fellow=${f.readerToken}` } },
      f.env,
    );
    expect(cookie.status).toBe(401);
    expect(await cookie.text()).not.toContain("PRIVATE-FORMULATION");
  }
});

test("bounded live pagination preserves exact opaque IDs and reports its omitted tail", async () => {
  const f = await fixture();
  const ids = Array.from({ length: 23 }, (_, index) => `brief-${String(index).padStart(3, "0")}`);
  for (const id of ids) await f.save(id);
  const first = FellowProblemBriefListResponseSchema.parse(
    await (await f.request("/v1/problem-briefs")).json(),
  );
  expect(first.briefs).toHaveLength(20);
  expect(first.omitted).toEqual(["page_limit"]);
  expect(first.next_after).toBe("brief-019");
  // Continuation is an ID boundary, so withdrawal of its anchor cannot break it.
  f.sql
    .query("UPDATE sponsor_problem_briefs SET status = 'withdrawn' WHERE id = ?")
    .run(first.next_after);
  if (!first.next_url) throw new Error("Expected an assigned-brief continuation.");
  const last = FellowProblemBriefListResponseSchema.parse(
    await (await f.request(first.next_url)).json(),
  );
  expect(last.briefs.map((brief) => brief.id)).toEqual(ids.slice(20));
  expect(last.next_url).toBeNull();
  expect(last.omitted).toEqual([]);
  const special = "../private brief/λ?#%";
  await f.save(special);
  const read = await f.request(fellowProblemBriefReadUrl(special));
  expect(read.status).toBe(200);
  expect(FellowProblemBriefReadResponseSchema.parse(await read.json()).brief.id).toBe(special);
});

test("query rejection is bounded, taught and does not echo private selectors", async () => {
  const f = await fixture();
  await f.save("valid");
  for (const path of [
    "/v1/problem-briefs?after=private-selector&after=other",
    "/v1/problem-briefs?sponsor_id=private-selector",
    `/v1/problem-briefs?after=${"x".repeat(129)}`,
    "/v1/problem-briefs/read",
    "/v1/problem-briefs/read?brief_id=private-selector&brief_id=other",
    "/v1/problem-briefs/read?brief_id=private-selector&token=secret",
  ]) {
    const response = await f.request(path);
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain("fix_hint");
    expect(text).toContain("schema");
    expect(text).not.toContain("private-selector");
    expect(text).not.toContain("PRIVATE-FORMULATION");
  }
});

test("read authority excludes unrelated problem grants, missing scope and invalid credential lifetime", async () => {
  const f = await fixture();
  const now = Date.now();
  expect(fellowMayReadAssignedBriefs(f.reader, now)).toBe(true);
  for (const binding of [
    { ...f.reader, grantedScopes: [] },
    { ...f.reader, revokedAt: now },
    { ...f.reader, expiresAt: now },
    { ...f.reader, issuedAt: now + 1 },
    { ...f.reader, fellowStatus: "paused" as const },
    { ...f.reader, grantedResources: { problemBinding: "P-DISCLOSE" } },
    { ...f.reader, grantedResources: { fellowGrantExpiresAt: now } },
  ])
    expect(fellowMayReadAssignedBriefs(binding, now)).toBe(false);
  const restricted = await fixture({ requested_scopes: ["review"] });
  const wrongScope = await createEnrollmentRouter({
    service: restricted.service,
    db: restricted.db,
  }).request(
    `${ORIGIN}/v1/hello`,
    { headers: { authorization: `Bearer ${restricted.readerToken}` } },
    restricted.env,
  );
  expect(
    EnrollmentHelloResponseSchema.parse(await wrongScope.json()).next_actions.some((action) =>
      action.url.endsWith("/v1/problem-briefs"),
    ),
  ).toBe(false);
  const denied = await restricted.request("/v1/problem-briefs");
  expect(denied.status).toBe(401);
});

test("same-statement read authority catches revocation and sponsor/Fellow changes after authentication", async () => {
  const f = await fixture();
  await f.save("race");
  const cachedAuth = createFellowBriefRouter({
    db: f.db,
    service: { credentialBinding: async () => f.reader },
  });
  const read = () =>
    cachedAuth.request(
      ORIGIN + fellowProblemBriefReadUrl("race"),
      {
        headers: { authorization: `Bearer ${f.readerToken}` },
      },
      f.env,
    );
  await f.service.transitionFellow(
    f.principal,
    {
      fellow_id: f.reader.fellowId,
      status: "paused",
      confirm: "change-fellow-lifecycle",
      step_up_authenticated_at: Math.floor(Date.now() / 1000),
    },
    { idempotencyKey: "pause-brief-reader" },
  );
  expect((await read()).status).toBe(401);
  await f.service.transitionFellow(
    f.principal,
    {
      fellow_id: f.reader.fellowId,
      status: "active",
      confirm: "change-fellow-lifecycle",
      step_up_authenticated_at: Math.floor(Date.now() / 1000),
    },
    { idempotencyKey: "resume-brief-reader" },
  );
  f.sql
    .query("UPDATE sponsor_problem_briefs SET assigned_fellow_id = ? WHERE id = 'race'")
    .run(f.binding.fellowId);
  expect((await read()).status).toBe(404);
  f.sql
    .query("UPDATE sponsor_problem_briefs SET assigned_fellow_id = ? WHERE id = 'race'")
    .run(f.reader.fellowId);
  await f.service.revokeCredential(
    f.principal,
    {
      fellow_id: f.reader.fellowId,
      credential_id: f.reader.credentialId,
      confirm: "revoke-credential",
      step_up_authenticated_at: Math.floor(Date.now() / 1000),
    },
    { idempotencyKey: "revoke-brief-reader" },
  );
  expect((await read()).status).toBe(401);
});

test("suspicious-review Fellows retain assigned reads without a proposal action", async () => {
  const f = await fixture();
  await f.save("diagnostic");
  await f.service.transitionFellow(
    f.principal,
    {
      fellow_id: f.reader.fellowId,
      status: "suspicious_review",
      confirm: "change-fellow-lifecycle",
      step_up_authenticated_at: Math.floor(Date.now() / 1000),
    },
    { idempotencyKey: "quarantine-brief-reader" },
  );
  const response = await f.request(fellowProblemBriefReadUrl("diagnostic"));
  expect(response.status).toBe(200);
  const detail = FellowProblemBriefReadResponseSchema.parse(await response.json());
  expect(detail.brief.id).toBe("diagnostic");
  expect(detail.next_actions).toEqual([]);
});

test("database failure never turns into an empty successful assignment list", async () => {
  const f = await fixture();
  const broken = createFellowBriefRouter({
    service: f.service,
    db: {
      prepare() {
        throw new Error("PRIVATE-DB-DIAGNOSTIC");
      },
    } as unknown as Env["DB"],
  });
  const response = await broken.request(
    `${ORIGIN}/v1/problem-briefs`,
    {
      headers: { authorization: `Bearer ${f.readerToken}` },
    },
    f.env,
  );
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const body = await response.text();
  expect(body).not.toContain("PRIVATE-DB-DIAGNOSTIC");
  expect(body).not.toContain('"briefs":[]');
});
