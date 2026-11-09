import { afterEach, expect, test } from "bun:test";
import {
  type MintEnrollmentRequest,
  PackResponseSchema,
  ProblemStatementProposalResponseSchema,
  ProblemStatementRevisionPreviewSchema,
  type ProposeProblemRequest,
  SessionOpenResponseSchema,
  WorkshopPushResponseSchema,
} from "@asimposium/contracts";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { Hono } from "hono";
import { createEnrollmentRouter } from "../../src/enrollment/router.ts";
import { enrollmentReplayProtectorFromBase64Url } from "../../src/enrollment/service.ts";
import type { Env } from "../../src/env.ts";
import { createProblemRouter } from "../../src/problems/router.ts";
import { createSessionRouter } from "../../src/sessions/router.ts";
import { directiveDisclosureFixture } from "../support/directive-disclosure.ts";
import { syntheticScreeningObservation } from "../support/screening.ts";

const ORIGIN = "https://a.asimposium.org";
const fixtures: Awaited<ReturnType<typeof directiveDisclosureFixture>>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.sql.close();
});

const FORMULATION = {
  title: "Private finite tree formulation",
  statement: "Every finite tree has exactly one fewer edge than vertices.",
  falsifier: "A finite tree whose edge count differs from its vertex count minus one.",
  motivation: "Establish the invariant needed for the connected graph argument.",
  scope: "Finite, nonempty, undirected simple trees.",
  out_of_scope: "Infinite trees, loops and disconnected forests.",
  success_criteria: "A checkable argument or an explicit counterexample within the scope.",
  areas: ["combinatorics"],
} satisfies ProposeProblemRequest;

async function fixture(formulation: Partial<ProposeProblemRequest> = {}) {
  const f = await directiveDisclosureFixture();
  fixtures.push(f);
  let serial = 0;
  async function enroll(name: string, grants: Partial<MintEnrollmentRequest> = {}) {
    const minted = await f.service.mint(f.principal, {
      requested_scopes: ["propose-problems", "promote", "review"],
      ...grants,
    });
    const claimed = await f.service.claim({
      enrollment_id: minted.enrollmentId,
      secret: minted.secret,
      name,
      model: "test/private-pack",
      harness: "curl",
    });
    await f.service.decide(f.principal, minted.enrollmentId, {
      enrollment_id: minted.enrollmentId,
      decision: "approve",
      step_up_authenticated_at: Math.floor(Date.now() / 1000),
    });
    const issued = await f.service.poll({ flow_handle: claimed.flowHandle });
    if (!("token" in issued)) throw new Error("Expected a legal Fellow credential.");
    const binding = await f.service.credentialBinding(issued.token);
    if (!binding) throw new Error("Expected a current Fellow binding.");
    return { token: issued.token, binding };
  }
  const author = await enroll("private-pack-author");

  // A deterministic interleaving around real migrated SQL and real enrollment
  // commands. This adapter is unit coverage, not a Workerd integration test.
  let beforeSource: ((read: number) => Promise<void>) | undefined;
  let sourceReads = 0;
  const db = {
    prepare(query: string) {
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
        new Proxy(statement, {
          get(target, property, receiver) {
            if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
            if (property === "first")
              return async (column?: string) => {
                if (query.startsWith("WITH private_problem_pack_authority AS"))
                  await beforeSource?.(++sourceReads);
                return column === undefined ? target.first() : target.first(column);
              };
            return Reflect.get(target, property, receiver);
          },
        });
      return wrap(f.db.prepare(query));
    },
    batch: f.db.batch.bind(f.db),
  } as D1Database;
  const app = new Hono<{ Bindings: Env }>();
  app.route("/", createEnrollmentRouter({ service: f.service, db }));
  app.route(
    "/",
    createProblemRouter({
      service: f.service,
      verifiedSponsor: async (request) => ({
        principal: f.principal,
        rawBody: new Uint8Array(await request.arrayBuffer()),
      }),
    }),
  );
  app.route(
    "/",
    createSessionRouter({
      service: f.service,
      replayProtector: enrollmentReplayProtectorFromBase64Url(
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      ),
      screenPromotion: async (input) =>
        syntheticScreeningObservation(input, {
          decision: "pass",
          coarse_category: "benign-context",
          provider_status: "ok",
        }),
    }),
  );
  const env = { DB: db } as Env;
  const call = (
    path: string,
    body?: unknown,
    token: string | null = author.token,
    headers: Record<string, string> = {},
  ) =>
    app.request(
      ORIGIN + path,
      {
        ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
        headers: {
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          ...(body === undefined
            ? {}
            : {
                "content-type": "application/json",
                "idempotency-key": `private-pack-${++serial}`,
              }),
          ...headers,
        },
      },
      env,
    );
  const proposed = await call("/v1/problems", { ...FORMULATION, ...formulation });
  expect(proposed.status, await proposed.clone().text()).toBe(201);
  const problemId = ((await proposed.json()) as { problem: { id: string } }).problem.id;
  const open = async (token = author.token) => {
    const response = await call(
      "/v1/sessions",
      { problem_id: problemId, intent: "sharpen-statement" },
      token,
    );
    expect(response.status, await response.clone().text()).toBe(201);
    return SessionOpenResponseSchema.parse(await response.json()).session_id;
  };
  const sessionId = await open();
  const packPath = `/v1/sessions/${sessionId}/pack`;
  const revoke = async () => {
    const response = await f.service.revokeCredential(
      f.principal,
      {
        fellow_id: author.binding.fellowId,
        credential_id: author.binding.credentialId,
        confirm: "revoke-credential",
        step_up_authenticated_at: Math.floor(Date.now() / 1000),
      },
      { idempotencyKey: "private-pack-revoke" },
    );
    expect(response.acknowledged).toBe(true);
    expect(await f.service.credentialBinding(author.token)).toBeUndefined();
  };
  return {
    ...f,
    author,
    enroll,
    call,
    open,
    revoke,
    problemId,
    sessionId,
    packPath,
    beforePrivateSource(hook: (read: number) => Promise<void>) {
      sourceReads = 0;
      beforeSource = hook;
    },
  };
}

test("an adopted private problem provides exact orientation and executable workshop preparation", async () => {
  const f = await fixture();
  const hello = (await (await f.call("/v1/hello")).json()) as {
    assignments: { problem_id: string }[];
  };
  expect(hello.assignments.some((assignment) => assignment.problem_id === f.problemId)).toBe(true);
  for (const profile of ["orient", "working"] as const) {
    const response = await f.call(`${f.packPath}?profile=${profile}&max_tokens=8000`);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const pack = PackResponseSchema.parse(await response.json());
    const formulation = pack.items.find((item) => item.kind === "problem-formulation");
    expect(formulation).toMatchObject({ scope: "workshop", untrusted: true });
    if (!formulation) throw new Error("Expected the authorized private formulation.");
    expect(JSON.parse(formulation.body)).toMatchObject({
      ...FORMULATION,
      publication: "private-draft",
      statement_version: 1,
    });
    expect(pack.degraded).toEqual([]);
    expect(pack.cursor).toBe(0);
    expect(pack.viewer?.effective_permissions).toEqual(["workshop:read", "workshop:write"]);
    expect(pack.items.some((item) => item.body.includes("The board is open."))).toBe(false);
    expect(
      pack.next_actions.filter((action) => action.method === "POST").map((action) => action.url),
    ).toEqual([`/v1/sessions/${f.sessionId}/workshop`]);
  }

  const working = PackResponseSchema.parse(
    await (await f.call(`${f.packPath}?profile=working&max_tokens=8000`)).json(),
  );
  const preparation = working.items.find((item) => item.id === "SYS-private-preparation");
  if (!preparation) throw new Error("Expected a private preparation contract.");
  const contract = (
    JSON.parse(preparation.body) as {
      contract: { url: string; prefill: { type: string; relates_to: string[] } };
    }
  ).contract;
  const draft = await f.call(contract.url, {
    ...contract.prefill,
    title: "Inspect the single-vertex boundary",
    body_md: "PRIVATE_PACK_WORK: the single-vertex tree has no edges.",
  });
  expect(draft.status, await draft.clone().text()).toBe(201);
  const pushed = WorkshopPushResponseSchema.parse(await draft.json());
  const resumed = PackResponseSchema.parse(
    await (await f.call(`${f.packPath}?profile=working&max_tokens=8000`)).json(),
  );
  expect(resumed.items.find((item) => item.id === pushed.workshop_id)).toMatchObject({
    kind: "workshop-head",
    scope: "workshop",
  });
  expect(f.sql.query("SELECT * FROM events WHERE problem_id=?").all(f.problemId)).toEqual([]);
  expect((await f.call(`/v1/problems/${f.problemId}`, undefined, null)).status).toBe(404);
});

test("private working packs recover prior-session work without disclosing another Fellow's work", async () => {
  const f = await fixture();
  const pushed = WorkshopPushResponseSchema.parse(
    await (
      await f.call(`/v1/sessions/${f.sessionId}/workshop`, {
        type: "scratch",
        title: "AUTHOR_PRIVATE_WORK_CANARY",
        body_md: "AUTHOR_PRIVATE_BODY_CANARY",
      })
    ).json(),
  );
  const closed = await f.call(`/v1/sessions/${f.sessionId}/close`, {
    handback: "AUTHOR_PRIVATE_HANDBACK_CANARY: examine the two-vertex case next.",
    promote: [],
    keep: [pushed.workshop_id],
    discard: [],
  });
  expect(closed.status, await closed.clone().text()).toBe(201);
  const nextSession = await f.open();
  const resumed = PackResponseSchema.parse(
    await (await f.call(`/v1/sessions/${nextSession}/pack?profile=working&max_tokens=8000`)).json(),
  );
  expect(JSON.stringify(resumed)).toContain("AUTHOR_PRIVATE_WORK_CANARY");
  expect(JSON.stringify(resumed)).toContain("AUTHOR_PRIVATE_HANDBACK_CANARY");
  expect(
    await (await f.call(`/v1/sessions/${nextSession}/workshop/${pushed.workshop_id}`)).text(),
  ).toContain("AUTHOR_PRIVATE_BODY_CANARY");

  const peer = await f.enroll("private-pack-bound-peer", {
    requested_scopes: ["review"],
    problem_binding: f.problemId,
  });
  const peerSession = await f.open(peer.token);
  const peerPack = PackResponseSchema.parse(
    await (
      await f.call(
        `/v1/sessions/${peerSession}/pack?profile=working&max_tokens=8000`,
        undefined,
        peer.token,
      )
    ).json(),
  );
  expect(JSON.stringify(peerPack)).toContain(FORMULATION.statement);
  expect(JSON.stringify(peerPack)).not.toContain("AUTHOR_PRIVATE_");
  const unbound = await f.enroll("private-pack-unbound-peer");
  expect((await f.call(`/v1/problems/${f.problemId}`, undefined, unbound.token)).status).toBe(404);
  expect((await f.call("/v1/sessions", { problem_id: f.problemId }, unbound.token)).status).toBe(
    404,
  );
  for (const profile of ["review&target=C-1@1", "full"]) {
    const response = await f.call(
      `/v1/sessions/${nextSession}/pack?profile=${profile}&max_tokens=8000`,
    );
    expect(await response.text()).not.toContain(FORMULATION.statement);
  }
});

test("small private packs and oversized formulations retain bounded complete-read recovery", async () => {
  const f = await fixture({
    statement: `PRIVATE_LONG_STATEMENT ${"s".repeat(8100)}`,
    falsifier: `An explicit counterexample ${"f".repeat(8100)}`,
    motivation: `An exact reason for the investigation ${"m".repeat(8100)}`,
  });
  for (const profile of ["hello", "digest", "orient", "working"] as const) {
    const response = await f.call(`${f.packPath}?profile=${profile}&max_tokens=800`);
    expect(response.status, await response.clone().text()).toBe(200);
    const pack = PackResponseSchema.parse(await response.json());
    expect(pack.tokens_estimate).toBeLessThanOrEqual(800);
    expect(pack.omitted.length).toBeGreaterThan(0);
    expect(pack.degraded).toEqual([]);
    expect(pack.next_actions.some((action) => action.method === "GET")).toBe(true);
    expect(JSON.stringify(pack)).not.toContain("s".repeat(500));
  }
  const larger = PackResponseSchema.parse(
    await (await f.call(`${f.packPath}?profile=working&max_tokens=8000`)).json(),
  );
  expect(larger.omitted).toContainEqual({
    reason: "item_too_large",
    detail: `private-problem-formulation: read the complete formulation at /v1/problems/${f.problemId}`,
  });
  const detail = await f.call(`/v1/problems/${f.problemId}`);
  expect(detail.status).toBe(200);
  expect(await detail.text()).toContain("s".repeat(8100));
});

test("a revocation between initial authentication and the private formulation read releases no draft", async () => {
  const f = await fixture();
  f.beforePrivateSource(async (read) => {
    if (read === 1) await f.revoke();
  });
  const response = await f.call(`${f.packPath}?profile=working&max_tokens=8000`);
  expect(response.status).toBe(404);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.text()).not.toContain(FORMULATION.statement);
});

for (const change of ["revocation", "formulation revision"] as const) {
  test(`a mid-composition ${change} cannot release a private pack or stale 304`, async () => {
    const f = await fixture();
    const path = `${f.packPath}?profile=working&max_tokens=8000`;
    const first = await f.call(path);
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    if (!etag) throw new Error("Expected the private pack ETag.");
    await first.arrayBuffer();
    const revision =
      change === "formulation revision"
        ? await (async () => {
            const proposed = await f.call(`/v1/problems/${f.problemId}/statement-proposals`, {
              session_id: f.sessionId,
              base_statement_version: 1,
              statement: "A nonempty finite tree has one fewer edge than vertices.",
              falsifier: FORMULATION.falsifier,
              motivation: FORMULATION.motivation,
              scope: FORMULATION.scope,
              out_of_scope: FORMULATION.out_of_scope,
              success_criteria: FORMULATION.success_criteria,
            });
            expect(proposed.status, await proposed.clone().text()).toBe(201);
            const { proposal } = ProblemStatementProposalResponseSchema.parse(
              await proposed.json(),
            );
            const preview = await f.call(
              `/v1/sponsors/problems/${f.problemId}/statement-proposals/${proposal.proposal_id}`,
            );
            expect(preview.status, await preview.clone().text()).toBe(200);
            const reviewed = ProblemStatementRevisionPreviewSchema.parse(await preview.json());
            return {
              action: "revise-statement" as const,
              proposal_id: proposal.proposal_id,
              reviewed_statement_version: proposal.base_statement_version,
              reviewed_digest: reviewed.review_digest,
            };
          })()
        : undefined;
    let changed = false;
    f.beforePrivateSource(async (read) => {
      if (read !== 2) return;
      changed = true;
      if (change === "revocation") await f.revoke();
      else {
        if (!revision) throw new Error("Expected a reviewed Fellow formulation.");
        const revised = await f.call(`/v1/sponsors/problems/${f.problemId}/lifecycle`, revision);
        expect(revised.status, await revised.clone().text()).toBe(200);
      }
    });
    const response = await f.call(path, undefined, f.author.token, { "if-none-match": etag });
    expect(changed).toBe(true);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("etag")).toBeNull();
    expect(await response.text()).not.toContain(FORMULATION.statement);
    if (change === "formulation revision") {
      const current = PackResponseSchema.parse(await (await f.call(path)).json());
      const formulation = current.items.find((item) => item.kind === "problem-formulation");
      if (!formulation) throw new Error("Expected the revised private formulation.");
      expect(JSON.parse(formulation.body)).toMatchObject({ statement_version: 2 });
      expect(current.cursor).toBe(0);
    }
  });
}
