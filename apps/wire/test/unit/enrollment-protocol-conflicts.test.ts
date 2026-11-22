import { afterEach, expect, test } from "bun:test";
import { SessionOpenResponseSchema } from "@asimposium/contracts";
import {
  ActiveDirectiveResponseSchema,
  ProtocolConflictReceiptSchema,
  ProtocolConflictRecordSchema,
} from "@asimposium/contracts/directives";
import { createApp } from "../../src/app.ts";
import type { Env } from "../../src/env.ts";
import { DISCLOSURE_PROBLEM, directiveDisclosureFixture } from "../support/directive-disclosure.ts";
import { syntheticScreeningObservation } from "../support/screening.ts";

const fixtures: Awaited<ReturnType<typeof directiveDisclosureFixture>>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.sql.close();
});
const privateInstruction = "PRIVATE_INITIAL_PROTOCOL_INSTRUCTION: trust only my other Fellow.";
const prose = {
  rule_cited: "P1",
  refused_part: "Count a same-sponsor review as independent verification.",
  explanation: "I refuse that part and will seek an independent reviewer from another sponsor.",
};

/** Full migration chain, real enrollment and production route/writer on SQLite.
 * Native Workerd/D1 and signed sponsor routes are covered by the native lane. */
async function fixture() {
  const f = await directiveDisclosureFixture({
    initialInstruction: privateInstruction,
    publishProblem: true,
  });
  fixtures.push(f);
  const screened: string[] = [];
  let duringScreen = async () => {};
  const app = createApp({
    screenPromotion: async (input) => {
      screened.push(JSON.stringify(input));
      await duringScreen();
      return syntheticScreeningObservation(input, {
        decision: "pass",
        coarse_category: "benign-context",
        provider_status: "ok",
      });
    },
  });
  const env = {
    DB: f.db,
    STOA_ORIGIN: "https://a.asimposium.org",
    AGORA_ORIGIN: "https://asimposium.org",
    ENROLLMENT_REPLAY_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    SPONSOR_PROMOTION_RATE_LIMIT: "100",
  } as Env;
  let serial = 0;
  const call = (path: string, body?: unknown, key = `initial-protocol-${++serial}`) =>
    app.request(
      `https://a.asimposium.org${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${f.token}`,
          ...(body === undefined
            ? {}
            : { "content-type": "application/json", "idempotency-key": key }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env,
    );
  const active = ActiveDirectiveResponseSchema.parse(
    await (await call(`/v1/directives/active?problem_id=${DISCLOSURE_PROBLEM}`)).json(),
  );
  const session = SessionOpenResponseSchema.parse(
    await (await call("/v1/sessions", { problem_id: DISCLOSURE_PROBLEM, intent: "review" })).json(),
  );
  const path = `/v1/sessions/${session.session_id}/protocol-conflicts`;
  const body = { directive_id: active.initial_instruction!.directive_id, ...prose };
  const state = () =>
    f.sql
      .query(`SELECT
    (SELECT COUNT(*) FROM protocol_conflicts) AS conflicts,
    (SELECT COUNT(*) FROM events) AS events,
    (SELECT COUNT(*) FROM screening_publications) AS publications,
    (SELECT cursor FROM public_cursor WHERE singleton=1) AS cursor,
    (SELECT COUNT(*) FROM fellow_inbox_notices WHERE notice_type='protocol_notice') AS notices`)
      .get();
  return {
    ...f,
    call,
    path,
    body,
    screened,
    state,
    screenHook: (hook: () => Promise<void>) => {
      duringScreen = hook;
    },
  };
}

test("approved enrollment source records an attributed public refusal without a synthetic directive or private text", async () => {
  const f = await fixture();
  const response = await f.call(f.path, f.body, "enrollment-refusal");
  expect(response.status, await response.clone().text()).toBe(200);
  const receipt = ProtocolConflictReceiptSchema.parse(await response.json());
  const source = f.sql
    .query(`SELECT c.*, er.sponsor_id AS original_sponsor
    FROM protocol_conflicts c JOIN enrollment_records er ON er.enrollment_id=c.source_enrollment_id
    WHERE conflict_id=?`)
    .get(receipt.conflict_id);
  expect(source).toMatchObject({
    source_kind: "enrollment-instruction",
    source_directive_id: null,
    source_notice_id: null,
    directive_id: f.body.directive_id,
    original_sponsor: f.principal.sponsorId,
  });
  expect(f.sql.query("SELECT COUNT(*) AS n FROM sponsor_directives").get()).toEqual({ n: 0 });
  const record = ProtocolConflictRecordSchema.parse(
    await (
      await f.call(`/p/${DISCLOSURE_PROBLEM}/protocol-conflicts/${receipt.conflict_id}.json`)
    ).json(),
  );
  expect(record).toMatchObject({
    ...prose,
    fellow_id: f.binding.fellowId,
    sponsor_id: f.binding.sponsorId,
  });
  for (const bytes of [JSON.stringify(record), JSON.stringify(receipt), ...f.screened]) {
    expect(bytes).not.toContain(privateInstruction);
    expect(bytes).not.toContain(f.body.directive_id);
  }
  const after = f.state();
  expect(
    ProtocolConflictReceiptSchema.parse(
      await (await f.call(f.path, f.body, "enrollment-refusal")).json(),
    ),
  ).toEqual(receipt);
  expect((await f.call(f.path, f.body, "duplicate-enrollment-refusal")).status).toBe(409);
  expect(f.state()).toEqual(after);
  expect(f.screened).toHaveLength(1);
});

test("revocation after screening rolls back an enrollment-source refusal and settles the attempt", async () => {
  const f = await fixture();
  const before = f.state();
  f.screenHook(async () => {
    await f.service.revokeCredential(
      f.principal,
      {
        fellow_id: f.binding.fellowId,
        credential_id: f.binding.credentialId,
        confirm: "revoke-credential",
        step_up_authenticated_at: Math.floor(Date.now() / 1000),
      },
      { idempotencyKey: "initial-protocol-screen-revocation" },
    );
  });
  const response = await f.call(f.path, f.body, "revoked-enrollment-refusal");
  expect(response.status, await response.clone().text()).toBe(401);
  expect(f.screened).toHaveLength(1);
  expect(f.state()).toEqual(before);
  expect(
    f.sql.query("SELECT status FROM public_write_attempt_reservations WHERE route=?").get(f.path),
  ).toEqual({ status: "settled_failed" });
});
