import { afterEach, expect, test } from "bun:test";
import { ProblemDocumentSchema } from "@asimposium/contracts";
import { createIntegrityCaseRouter } from "../../src/moderation/integrity-http.ts";
import { openIntegrityCase } from "../../src/moderation/integrity-store.ts";
import {
  integrityCaseFixture, INTEGRITY_OPERATOR, INTEGRITY_RESPONSE,
  openRequest, SPONSOR,
} from "../support/integrity-cases.ts";

type Fixture = Awaited<ReturnType<typeof integrityCaseFixture>>;
const fixtures: Fixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.sql.close(); });
async function setup() {
  const f = await integrityCaseFixture();
  fixtures.push(f);
  await f.publish();
  const reported = await f.report();
  return { ...f, reportId: reported.report_id };
}
const OPERATOR_PATH = "/v1/operators/integrity/cases";
const SPONSOR_PATH = "/v1/sponsors/integrity/cases";

test("private integrity HTTP binds each signed action and preserves sponsor-only history access", async () => {
  const f = await setup();
  let sponsorId = SPONSOR;
  const verified: string[] = [];
  const app = createIntegrityCaseRouter({
    db: f.db,
    verifiedOperator: async (request, route, action) => {
      verified.push(`${route} ${action}`);
      return {
        principal: { type: "operator", operatorId: INTEGRITY_OPERATOR, serviceEnvelopeKid: "fixture" },
        rawBody: new Uint8Array(await request.arrayBuffer()),
      };
    },
    verifiedSponsor: async (request, route, action) => {
      verified.push(`${route} ${action}`);
      return {
        principal: { type: "sponsor", sponsorId },
        rawBody: new Uint8Array(await request.arrayBuffer()),
      };
    },
  });
  async function post(path: string, body: unknown, expected: number, key = "http-integrity") {
    const response = await app.request(`https://a.asimposium.org${path}`, {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(expected);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const data = await response.json() as Record<string, unknown>;
    if (expected >= 400) expect(ProblemDocumentSchema.safeParse(data).success).toBe(true);
    return data;
  }
  const opened = await post(`${OPERATOR_PATH}/open`, openRequest(f.reportId), 200);
  const read = { case_id: opened.case_id };
  const detail = await post(`${SPONSOR_PATH}/read`, read, 200);
  expect(detail.report_id).toBeUndefined();
  sponsorId = "usr_integrity_other";
  await post(`${SPONSOR_PATH}/read`, read, 404);
  const responseBody = { case_id: opened.case_id, expected_revision: 1, response: INTEGRITY_RESPONSE };
  await post(`${SPONSOR_PATH}/respond`, responseBody, 404, "foreign");
  sponsorId = SPONSOR;
  const replied = await post(`${SPONSOR_PATH}/respond`, responseBody, 200, "own");
  expect(replied.revision).toBe(2);
  expect(await post(`${SPONSOR_PATH}/respond`, responseBody, 200, "own")).toEqual(replied);
  const stale = await post(`${SPONSOR_PATH}/respond`, responseBody, 409, "new-key-stale-version");
  expect(stale.code).toBe("OBJECT_VERSION_CONFLICT");
  await post(`${SPONSOR_PATH}/query`, {}, 200);
  await post(`${OPERATOR_PATH}/read`, read, 200);
  await post(`${OPERATOR_PATH}/query`, {}, 200);
  expect(verified).toContain(`${OPERATOR_PATH}/open operator.integrity.cases.open`);
  expect(verified).toContain(`${SPONSOR_PATH}/respond sponsor.integrity.cases.respond`);
  expect(verified).toContain(`${SPONSOR_PATH}/read sponsor.integrity.cases.read`);
});

test("only authenticated signed bytes are parsed, never the unsigned transport body", async () => {
  const f = await setup();
  const opened = await openIntegrityCase(f.db, INTEGRITY_OPERATOR, openRequest(f.reportId), "seed");
  const app = createIntegrityCaseRouter({
    db: f.db,
    verifiedSponsor: async () => ({
      principal: { type: "sponsor", sponsorId: SPONSOR },
      rawBody: new TextEncoder().encode(JSON.stringify({ case_id: opened.case_id })),
    }),
  });
  const response = await app.request(`https://a.asimposium.org${SPONSOR_PATH}/read`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ case_id: `IC-${"0".repeat(26)}`, sponsor_id: "usr_foreign" }),
  });
  expect(response.status).toBe(200);
  expect((await response.json() as { case: { case_id: string } }).case.case_id).toBe(opened.case_id);
});

test("missing authority, wrong human role, schema drift and stale operator auth fail privately", async () => {
  const f = await setup();
  const unavailable = createIntegrityCaseRouter({ db: f.db });
  const send = (app: ReturnType<typeof createIntegrityCaseRouter>, path: string, body: unknown) =>
    app.request(`https://a.asimposium.org${path}`, {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": "refusal" },
      body: JSON.stringify(body),
    });
  const missing = await send(unavailable, `${OPERATOR_PATH}/open`, openRequest(f.reportId));
  expect(missing.status).toBe(503);
  expect(missing.headers.get("cache-control")).toBe("private, no-store");
  const app = createIntegrityCaseRouter({
    db: f.db,
    verifiedOperator: async (request) => ({
      principal: { type: "operator", operatorId: INTEGRITY_OPERATOR, serviceEnvelopeKid: "fixture" },
      rawBody: new Uint8Array(await request.arrayBuffer()),
    }),
    verifiedSponsor: async (request) => ({
      principal: { type: "operator", operatorId: INTEGRITY_OPERATOR, serviceEnvelopeKid: "fixture" },
      rawBody: new Uint8Array(await request.arrayBuffer()),
    }),
  });
  for (const [path, body, status, code] of [
    [`${SPONSOR_PATH}/query`, {}, 403, "WRONG_PRINCIPAL"],
    [`${OPERATOR_PATH}/query?limit=20`, {}, 422, "SCHEMA_INVALID"],
    [`${OPERATOR_PATH}/open`, { ...openRequest(f.reportId), subject_sponsor_id: SPONSOR }, 422, "SCHEMA_INVALID"],
    [`${OPERATOR_PATH}/open`, { ...openRequest(f.reportId), auth_issued_at: 0 }, 403, "STEP_UP_REQUIRED"],
  ] as const) {
    const response = await send(app, path, body);
    expect(response.status).toBe(status);
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(ProblemDocumentSchema.parse(await response.json()).code).toBe(code);
  }
  expect(f.sql.query("SELECT COUNT(*) AS n FROM integrity_cases").get()).toEqual({ n: 0 });
});

test("fresh operator authentication can renew a retry without replacing its accepted intent", async () => {
  const f = await setup();
  const app = createIntegrityCaseRouter({
    db: f.db,
    verifiedOperator: async (request) => ({
      principal: { type: "operator", operatorId: INTEGRITY_OPERATOR, serviceEnvelopeKid: "fixture" },
      rawBody: new Uint8Array(await request.arrayBuffer()),
    }),
  });
  const send = (body: unknown) => app.request(`https://a.asimposium.org${OPERATOR_PATH}/open`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": "fresh-retry" },
    body: JSON.stringify(body),
  });
  const request = openRequest(f.reportId);
  const first = await send({ ...request, auth_issued_at: request.auth_issued_at - 1 });
  expect(first.status).toBe(200);
  const receipt = await first.json();
  const replay = await send(request);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(receipt);
  const changed = await send({ ...request, concern: "plagiarism" });
  expect(changed.status).toBe(409);
  expect(ProblemDocumentSchema.parse(await changed.json()).code).toBe("IDEMPOTENCY_CONFLICT");
});
