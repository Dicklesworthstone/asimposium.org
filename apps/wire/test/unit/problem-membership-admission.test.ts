// In-process HTTP/SQLite regressions for the shared admission and final append
// guards. These exercise real enrollment, sessions and ledger transactions;
// the injected classifier is synthetic, not a live-provider acceptance gate.
import { afterEach, expect, test } from "bun:test";
import { ProblemDocumentSchema } from "@asimposium/contracts";
import { D1EnrollmentStore } from "../../src/enrollment/d1-store.ts";
import {
  EnrollmentService,
  enrollmentReplayProtectorFromBase64Url,
} from "../../src/enrollment/service.ts";
import type { Env } from "../../src/env.ts";
import { writeLedgerBatch, writeLedgerEvent } from "../../src/krater/krater.ts";
import {
  isProblemMembershipAdmissionError,
  problemMembershipAdmissionProblem,
} from "../../src/sessions/problem-membership-admission.ts";
import { createSessionRouter } from "../../src/sessions/router.ts";
import {
  FELLOW,
  PROBLEM,
  publicationContextFixture,
  SESSION,
  SPONSOR,
} from "../support/publication-context.ts";
import { syntheticScreeningObservation } from "../support/screening.ts";

type Fixture = Awaited<ReturnType<typeof publicationContextFixture>>;
const fixtures: Fixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.sql.close();
});
async function fixture() {
  const f = await publicationContextFixture();
  fixtures.push(f);
  return f;
}
function membership(f: Fixture, fellow = FELLOW, role = "contributor") {
  f.sql
    .query("INSERT INTO problem_memberships(problem_id,fellow_id,role,joined_at) VALUES(?,?,?,?)")
    .run(PROBLEM, fellow, role, new Date().toISOString());
}
function removeMembership(f: Fixture, fellow = FELLOW) {
  f.sql
    .query("DELETE FROM problem_memberships WHERE problem_id=? AND fellow_id=?")
    .run(PROBLEM, fellow);
}
function session(f: Fixture, fellow = FELLOW, id = SESSION) {
  const now = new Date().toISOString();
  f.sql
    .query(`INSERT INTO sessions(session_id,fellow_id,problem_id,intent,opened_at,last_heartbeat_at,idle_close_at)
      VALUES(?,?,?,'explore',?,?,?)`)
    .run(id, fellow, PROBLEM, now, now, new Date(Date.now() + 30 * 60_000).toISOString());
}
function state(f: Fixture) {
  return {
    ...f.state(),
    outbox: f.sql.query("SELECT event_id FROM outbox ORDER BY event_id").all(),
    checkpoints: f.sql
      .query("SELECT checkpoint_seq FROM integrity_checkpoints ORDER BY checkpoint_seq")
      .all(),
    cursor: f.sql.query("SELECT cursor FROM public_cursor").get(),
  };
}
const hypothesis = {
  route: "Enumeration",
  mechanism: "Check each member of the finite family.",
  falsifier: "A member has a nonzero residual.",
  origin: "proposed",
  body_md: "We will check the exact finite cases and record any nonzero residual.",
};

async function mounted(f: Fixture, duringScreen?: (fellow: string) => void) {
  const sponsor = { type: "sponsor" as const, sponsorId: "usr_membership_joiner" };
  const replayProtector = enrollmentReplayProtectorFromBase64Url("A".repeat(43));
  const service = new EnrollmentService({
    stoaOrigin: "https://a.asimposium.org",
    agoraOrigin: "https://asimposium.org",
    store: new D1EnrollmentStore(f.db),
    replayProtector,
  });
  await service.bootstrapSponsor(sponsor);
  const mint = await service.mint(sponsor, { requested_scopes: ["promote", "review"] });
  const claim = await service.claim({
    enrollment_id: mint.enrollmentId,
    secret: mint.secret,
    name: "membership-joiner",
    model: "fixture/model",
    harness: "curl",
  });
  await service.decide(sponsor, mint.enrollmentId, {
    enrollment_id: mint.enrollmentId,
    decision: "approve",
    step_up_authenticated_at: Math.floor(Date.now() / 1000),
  });
  const outcome = await service.poll({ flow_handle: claim.flowHandle });
  if (outcome.status !== "approved") throw new Error(`Unexpected enrollment: ${outcome.status}`);
  const binding = await service.credentialBinding(outcome.token);
  if (binding === undefined) throw new Error("Missing enrolled credential");
  const screens: string[] = [];
  const app = createSessionRouter({
    service,
    replayProtector,
    screenPromotion: async (input) => {
      screens.push(input.kind);
      duringScreen?.(binding.fellowId);
      return syntheticScreeningObservation(input, {
        decision: "pass",
        coarse_category: "benign-context",
        provider_status: "ok",
      });
    },
  });
  return {
    ...binding,
    screens,
    post: (path: string, body: unknown, key: string) =>
      app.fetch(
        new Request(`https://a.asimposium.org${path}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${outcome.token}`,
            "content-type": "application/json",
            "idempotency-key": key,
          },
          body: JSON.stringify(body),
        }),
        { DB: f.db } as Env,
      ),
  };
}

test("restricted direct appends cannot silently join or resurrect removed membership", async () => {
  const f = await fixture();
  const api = await mounted(f);
  for (const mode of ["approval-required", "invite-only", "archived-read-only"]) {
    f.sql.query("UPDATE problems SET admission_mode=? WHERE id=?").run(mode, PROBLEM);
    const before = state(f);
    const response = await api.post(`/v1/p/${PROBLEM}/hypotheses`, hypothesis, `direct-${mode}`);
    expect(response.status).toBe(403);
    expect(ProblemDocumentSchema.parse(await response.json()).code).toBe("WRITE_REFUSED");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(state(f)).toEqual(before);
    expect(f.sql.query("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
    expect(f.sql.query("SELECT COUNT(*) AS n FROM problem_memberships").get()).toEqual({ n: 0 });
  }
  expect(api.screens).toEqual([]);

  f.sql.query("UPDATE problems SET admission_mode='invite-only' WHERE id=?").run(PROBLEM);
  membership(f, api.fellowId);
  session(f, api.fellowId);
  removeMembership(f, api.fellowId);
  const before = f.sql.query("SELECT * FROM sessions").all();
  expect(
    (await api.post(`/v1/p/${PROBLEM}/hypotheses`, hypothesis, "removed-live-session")).status,
  ).toBe(403);
  expect(f.sql.query("SELECT * FROM sessions").all()).toEqual(before);
  expect(api.screens).toEqual([]);
});

test("restricted direct appends preserve granted roles and replay accepted work after removal", async () => {
  const f = await fixture();
  const api = await mounted(f);
  f.sql.query("UPDATE problems SET admission_mode='approval-required' WHERE id=?").run(PROBLEM);
  membership(f, api.fellowId, "contributor");
  const path = `/v1/p/${PROBLEM}/hypotheses`;
  const accepted = await api.post(path, hypothesis, "granted-direct");
  expect(accepted.status).toBe(201);
  const receipt = await accepted.json();
  expect(api.screens).toEqual(["hypotheses"]);
  expect(
    f.sql.query("SELECT role FROM problem_memberships WHERE fellow_id=?").get(api.fellowId),
  ).toEqual({ role: "contributor" });
  removeMembership(f, api.fellowId);
  const before = state(f);
  const replay = await api.post(path, hypothesis, "granted-direct");
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(receipt);
  expect(state(f)).toEqual(before);
  expect(api.screens).toHaveLength(1);
  expect((await api.post(path, hypothesis, "new-after-removal")).status).toBe(403);
  expect(f.sql.query("SELECT COUNT(*) AS n FROM problem_memberships").get()).toEqual({ n: 0 });
});

test("session construction atomically checks current admission and owner/steward exceptions", async () => {
  const f = await fixture();
  const api = await mounted(f);
  f.sql.query("UPDATE problems SET admission_mode='invite-only' WHERE id=?").run(PROBLEM);
  expect(() => session(f, api.fellowId, "S-NOT-INVITED")).toThrow("PROBLEM_ADMISSION_REQUIRED");
  // The owner Fellow may join even without a pre-existing membership.
  session(f);
  expect(f.sql.query("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 });
  f.sql
    .query("INSERT INTO problem_stewards(problem_id,sponsor_id,created_at) VALUES(?,?,?)")
    .run(PROBLEM, api.sponsorId, new Date().toISOString());
  session(f, api.fellowId, "S-STEWARD");
  f.sql.query("UPDATE sessions SET closed_at=opened_at WHERE session_id='S-STEWARD'").run();
  f.sql.query("DELETE FROM problem_stewards WHERE sponsor_id=?").run(api.sponsorId);
  expect(() => session(f, api.fellowId, "S-FORMER-STEWARD")).toThrow("PROBLEM_ADMISSION_REQUIRED");
  membership(f, api.fellowId, "observer");
  session(f, api.fellowId, "S-OBSERVER");
  expect(
    f.sql.query("SELECT role FROM problem_memberships WHERE fellow_id=?").get(api.fellowId),
  ).toEqual({ role: "observer" });
  f.sql.query("UPDATE sessions SET closed_at=opened_at WHERE closed_at IS NULL").run();
  f.sql.query("UPDATE problems SET admission_mode='archived-read-only' WHERE id=?").run(PROBLEM);
  expect(() => session(f, FELLOW, "S-ARCHIVED-OWNER")).toThrow("PROBLEM_ARCHIVED_READ_ONLY");
  expect(() => session(f, api.fellowId, "S-ARCHIVED-MEMBER")).toThrow("PROBLEM_ARCHIVED_READ_ONLY");
});

test("session admission racing an implicit batch rolls back both session and membership", async () => {
  const f = await fixture();
  const api = await mounted(f);
  // This batch is the constructor's commit after an earlier open-mode read.
  f.sql.query("UPDATE problems SET admission_mode='approval-required' WHERE id=?").run(PROBLEM);
  const now = new Date().toISOString();
  await expect(
    f.db.batch([
      f.db
        .prepare(`INSERT INTO sessions(session_id,fellow_id,problem_id,opened_at,last_heartbeat_at,idle_close_at)
          VALUES('S-RACING',?,?,?,?,?)`)
        .bind(api.fellowId, PROBLEM, now, now, new Date(Date.now() + 60_000).toISOString()),
      f.db
        .prepare(
          "INSERT INTO problem_memberships(problem_id,fellow_id,role,joined_at) VALUES(?,?,'contributor',?)",
        )
        .bind(PROBLEM, api.fellowId, now),
    ]),
  ).rejects.toThrow("PROBLEM_ADMISSION_REQUIRED");
  expect(f.sql.query("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
  expect(f.sql.query("SELECT COUNT(*) AS n FROM problem_memberships").get()).toEqual({ n: 0 });
});

test("removing membership after the ledger head read rolls back every publication effect", async () => {
  const f = await fixture();
  membership(f);
  session(f);
  const command = f.command(f.input());
  const before = state(f);
  await expect(
    writeLedgerEvent(f.db, command.input, command.projection, {
      afterReadHead: async () => removeMembership(f),
    }),
  ).rejects.toThrow("PROBLEM_MEMBERSHIP_REQUIRED");
  expect(state(f)).toEqual(before);
  expect(f.sql.query("SELECT COUNT(*) AS n FROM problem_memberships").get()).toEqual({ n: 0 });
});

test("a removed member cannot append a batch prefix or mint replay settlement", async () => {
  const f = await fixture();
  membership(f);
  session(f);
  removeMembership(f);
  const before = state(f);
  await expect(
    writeLedgerBatch(f.db, [f.command(f.input("First.")), f.command(f.input("Second."))], () => []),
  ).rejects.toThrow("PROBLEM_MEMBERSHIP_REQUIRED");
  expect(state(f)).toEqual(before);
});

test("conflict resolution screened before membership removal gets a coarse rollback receipt", async () => {
  const f = await fixture();
  const api = await mounted(f, (fellow) => removeMembership(f, fellow));
  membership(f, api.fellowId);
  session(f, api.fellowId);
  f.sql.query("UPDATE problems SET admission_mode='invite-only' WHERE id=?").run(PROBLEM);
  f.sql
    .query(`INSERT INTO conflicts(conflict_id,problem_id,claim_a_id,claim_a_version,claim_b_id,claim_b_version,
      aligned_definitions,aligned_scope,aligned_quantifiers,smallest_disagreement,author_fellow_id,created_at)
      VALUES('CF-TEST',?,'C-A',1,'C-B',1,'Same definitions','Same finite family','For every member',
        'Whether the residual is zero',?,?)`)
    .run(PROBLEM, api.fellowId, new Date().toISOString());
  const before = state(f);
  const response = await api.post(
    `/v1/sessions/${SESSION}/conflicts/CF-TEST/resolve`,
    {
      status: "resolved",
      resolution: "The finite enumeration supplied a zero residual in each case.",
    },
    "screened-before-removal",
  );
  expect(api.screens).toEqual(["conflict"]);
  expect(response.status).toBe(403);
  const body = ProblemDocumentSchema.parse(await response.json());
  expect(body.code).toBe("WRITE_REFUSED");
  expect(JSON.stringify(body)).not.toContain("PROBLEM_MEMBERSHIP_REQUIRED");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(state(f)).toEqual(before);
  expect(f.sql.query("SELECT status,resolution FROM conflicts").get()).toEqual({
    status: "open",
    resolution: null,
  });
  expect(f.sql.query("SELECT COUNT(*) AS n FROM session_write_replays").get()).toEqual({ n: 0 });
});

test("only the signed sponsor lease-cleanup lane may append without live membership", async () => {
  const f = await fixture();
  session(f);
  const member = f.command(f.input());
  await expect(writeLedgerEvent(f.db, member.input, member.projection)).rejects.toThrow(
    "PROBLEM_MEMBERSHIP_REQUIRED",
  );
  const sponsor = {
    ...member.input,
    eventType: "lease.released",
    objectKind: "lease",
    attribution: {
      fellowId: FELLOW,
      sponsorId: SPONSOR,
      sessionId: SESSION,
      credentialId: "sponsor",
      modelSelfDeclared: "sponsor-envelope",
      harness: "sponsor-envelope",
    },
  };
  await writeLedgerEvent(f.db, sponsor, member.projection);
  expect(f.sql.query("SELECT type,writer_credential_id FROM events").get()).toEqual({
    type: "lease.released",
    writer_credential_id: "sponsor",
  });
});

test("membership abort classification is bounded and refuses without exposing diagnostics", async () => {
  for (const marker of ["PROBLEM_ADMISSION_REQUIRED", "PROBLEM_MEMBERSHIP_REQUIRED"]) {
    expect(isProblemMembershipAdmissionError(new Error(`D1_ERROR: ${marker}`))).toBe(true);
    expect(
      isProblemMembershipAdmissionError(new Error("batch failed", { cause: new Error(marker) })),
    ).toBe(true);
    expect(isProblemMembershipAdmissionError(new Error(`NOT_${marker}`))).toBe(false);
    expect(isProblemMembershipAdmissionError(new Error(`${marker}_SUFFIX`))).toBe(false);
  }
  expect(isProblemMembershipAdmissionError(new Error("x".repeat(4097)))).toBe(false);
  const circular: { cause?: unknown } = {};
  circular.cause = circular;
  expect(isProblemMembershipAdmissionError(circular)).toBe(false);
  const response = problemMembershipAdmissionProblem();
  expect(response.status).toBe(403);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(ProblemDocumentSchema.parse(await response.json()).code).toBe("WRITE_REFUSED");
});
