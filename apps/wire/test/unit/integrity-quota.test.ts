import { afterEach, expect, test } from "bun:test";
import { ProblemDocumentSchema } from "@asimposium/contracts";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { createIntegrityCaseRouter } from "../../src/moderation/integrity-http.ts";
import {
  INTEGRITY_WRITE_LIMIT,
  integrityWriteBudget,
} from "../../src/moderation/integrity-quota.ts";
import { readIntegrityCase } from "../../src/moderation/integrity-read.ts";
import {
  openIntegrityCase,
  resolveIntegrityCase,
  respondToIntegrityCase,
} from "../../src/moderation/integrity-store.ts";
import {
  INTEGRITY_APPEAL_OPERATOR,
  INTEGRITY_OPERATOR,
  INTEGRITY_RESPONSE,
  integrityCaseFixture,
  openRequest,
  PROBLEM,
  resolveRequest,
  SPONSOR,
} from "../support/integrity-cases.ts";

type Fixture = Awaited<ReturnType<typeof integrityCaseFixture>>;
const fixtures: Fixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.sql.close();
});

function router(f: Fixture, operatorId = INTEGRITY_OPERATOR) {
  return createIntegrityCaseRouter({
    db: f.db,
    verifiedOperator: async (request) => ({
      principal: { type: "operator", operatorId, serviceEnvelopeKid: "fixture" },
      rawBody: new Uint8Array(await request.arrayBuffer()),
    }),
    verifiedSponsor: async (request) => ({
      principal: { type: "sponsor", sponsorId: SPONSOR },
      rawBody: new Uint8Array(await request.arrayBuffer()),
    }),
  });
}
function post(app: ReturnType<typeof router>, path: string, request: unknown, key: string) {
  return app.request(`https://a.asimposium.org/v1/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(request),
  });
}
async function expectLimited(response: Response) {
  expect(response.status).toBe(429);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  expect(response.headers.get("ratelimit-limit")).toBe(String(INTEGRITY_WRITE_LIMIT));
  expect(response.headers.get("ratelimit-remaining")).toBe("0");
  const retry = Number(response.headers.get("retry-after"));
  expect(retry).toBeGreaterThan(0);
  expect(retry).toBeLessThanOrEqual(60);
  const problem = ProblemDocumentSchema.parse(await response.json());
  expect(problem.code).toBe("RATE_LIMITED");
}
function beforeBatch(db: D1Database, hook: () => Promise<void>): D1Database {
  let pending = true;
  return {
    prepare: db.prepare.bind(db),
    async batch(statements: D1PreparedStatement[]) {
      if (pending) {
        pending = false;
        await hook();
      }
      return db.batch(statements);
    },
  } as D1Database;
}

test("sponsor responses share one atomic rolling budget; accepted replay and reads stay available", async () => {
  const f = await integrityCaseFixture();
  fixtures.push(f);
  const opened = [];
  for (let i = 1; i <= 2; i++) {
    await f.publish(`C-${i}`);
    const report = await f.report(`C-${i}@1`);
    opened.push(
      await openIntegrityCase(f.db, INTEGRITY_OPERATOR, openRequest(report.report_id), `open-${i}`),
    );
  }
  const first = opened[0];
  const second = opened[1];
  if (!first || !second) throw new Error("Expected two cases");
  const initial = { case_id: first.case_id, expected_revision: 1, response: INTEGRITY_RESPONSE };
  const accepted = await respondToIntegrityCase(f.db, SPONSOR, initial, "response-1");
  for (let i = 2; i < INTEGRITY_WRITE_LIMIT; i++)
    await respondToIntegrityCase(
      f.db,
      SPONSOR,
      { ...initial, expected_revision: i },
      `response-${i}`,
    );
  // The first request has already passed its budget read when another case
  // spends the last slot. The D1 trigger must roll its stale mutation back.
  const raced = beforeBatch(f.db, async () => {
    await respondToIntegrityCase(
      f.db,
      SPONSOR,
      {
        case_id: second.case_id,
        expected_revision: 1,
        response: INTEGRITY_RESPONSE,
      },
      "last-slot",
    );
  });
  await expect(
    respondToIntegrityCase(
      raced,
      SPONSOR,
      {
        ...initial,
        expected_revision: INTEGRITY_WRITE_LIMIT,
      },
      "losing-race",
    ),
  ).rejects.toThrow("INTEGRITY_WRITE_RATE_LIMITED");
  const detail = await readIntegrityCase(
    f.db,
    { case_id: first.case_id, after_revision: 0, limit: 20 },
    SPONSOR,
  );
  expect(detail.case.revision).toBe(INTEGRITY_WRITE_LIMIT);
  expect(
    f.sql
      .query(
        "SELECT COUNT(*) AS n FROM integrity_case_actions WHERE actor_class='sponsor' AND actor_id=?",
      )
      .get(SPONSOR),
  ).toEqual({ n: INTEGRITY_WRITE_LIMIT });
  expect(
    f.sql
      .query(
        "SELECT COUNT(*) AS n FROM integrity_command_receipts WHERE actor_class='sponsor' AND actor_id=?",
      )
      .get(SPONSOR),
  ).toEqual({ n: INTEGRITY_WRITE_LIMIT });
  expect(await respondToIntegrityCase(f.db, SPONSOR, initial, "response-1")).toEqual(accepted);
  const app = router(f);
  await expectLimited(
    await post(
      app,
      "sponsors/integrity/cases/respond",
      {
        ...initial,
        expected_revision: INTEGRITY_WRITE_LIMIT,
      },
      "exhausted",
    ),
  );
  expect(
    (await post(app, "sponsors/integrity/cases/read", { case_id: first.case_id }, "read")).status,
  ).toBe(200);
  expect((await post(app, "sponsors/integrity/cases/query", {}, "query")).status).toBe(200);
  // The operator's distinct identity retains capacity to conclude a case.
  await resolveIntegrityCase(
    f.db,
    INTEGRITY_OPERATOR,
    resolveRequest(first.case_id, INTEGRITY_WRITE_LIMIT),
    "operator-outcome",
  );
  expect(
    (await integrityWriteBudget(f.db, "sponsor", SPONSOR, Date.now() + 60_001)).remaining,
  ).toBe(INTEGRITY_WRITE_LIMIT);
});

test("operator opening and resolution share the human-write limit without blocking another operator or receipt replay", async () => {
  const f = await integrityCaseFixture();
  fixtures.push(f);
  const cases: string[] = [];
  for (let i = 1; i < INTEGRITY_WRITE_LIMIT; i++) {
    await f.publish(`C-${i}`);
    const report = await f.report(`C-${i}@1`);
    const opened = await openIntegrityCase(
      f.db,
      INTEGRITY_OPERATOR,
      openRequest(report.report_id),
      `open-${i}`,
    );
    cases.push(opened.case_id);
  }
  const first = cases[0],
    second = cases[1];
  if (!first || !second) throw new Error("Expected independently reviewable cases");
  const decision = resolveRequest(first, 1);
  const resolved = await resolveIntegrityCase(f.db, INTEGRITY_OPERATOR, decision, "decision");
  const app = router(f);
  await f.publish("C-21");
  const unopened = await f.report("C-21@1");
  await expectLimited(
    await post(app, "operators/integrity/cases/open", openRequest(unopened.report_id), "over-open"),
  );
  await expectLimited(
    await post(app, "operators/integrity/cases/resolve", resolveRequest(second, 1), "over-resolve"),
  );
  const replay = await post(app, "operators/integrity/cases/resolve", decision, "decision");
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(resolved);
  expect(
    (
      await post(
        router(f, INTEGRITY_APPEAL_OPERATOR),
        "operators/integrity/cases/resolve",
        resolveRequest(second, 1),
        "independent",
      )
    ).status,
  ).toBe(200);
  expect(
    f.sql
      .query(
        "SELECT COUNT(*) AS n FROM integrity_case_actions WHERE actor_class='operator' AND actor_id=?",
      )
      .get(INTEGRITY_OPERATOR),
  ).toEqual({ n: INTEGRITY_WRITE_LIMIT });
  expect(
    f.sql
      .query("SELECT COUNT(*) AS n FROM integrity_cases WHERE report_id=?")
      .get(unopened.report_id),
  ).toEqual({ n: 0 });
  expect((await integrityWriteBudget(f.db, "operator", INTEGRITY_APPEAL_OPERATOR)).remaining).toBe(
    INTEGRITY_WRITE_LIMIT - 1,
  );
  expect(f.sql.query("SELECT problem_id FROM integrity_cases LIMIT 1").get()).toEqual({
    problem_id: PROBLEM,
  });
});
