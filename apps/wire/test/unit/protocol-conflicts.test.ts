import { expect, test } from "bun:test";
import { ProtocolConflictReceiptSchema } from "@asimposium/contracts/directives";
import { recordProtocolConflict } from "../../src/directives/protocol-conflicts.ts";
import { isObjectLevelEvent } from "../../src/mega-commands/materiality.ts";
import { NOW, protocolConflictFixture, SESSION } from "./protocol-conflict-fixture.ts";

type Fixture = ReturnType<typeof protocolConflictFixture>;
const run = (f: Fixture, input = f.directive(), key = "refusal-1") =>
  recordProtocolConflict(f.options, f.actor, SESSION, input, key);
const count = (f: Fixture, table: string) =>
  (f.sql.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
async function using(fn: (f: Fixture) => Promise<void>) {
  const f = protocolConflictFixture();
  try {
    await fn(f);
  } finally {
    f.close();
  }
}

test("records one attributable screened refusal while keeping received directive private", () =>
  using(async (f) => {
    const input = f.directive();
    const sourceBefore = f.sql.query("SELECT * FROM sponsor_directives").all();
    const before = count(f, "events");
    const saved = ProtocolConflictReceiptSchema.parse(
      await recordProtocolConflict(
        {
          ...f.options,
          screen: async (candidate) => {
            expect(candidate.statement).not.toContain(input.directive_id);
            expect(candidate.statement).not.toContain("PRIVATE DIRECTIVE CANARY");
            return f.options.screen(candidate);
          },
        },
        f.actor,
        SESSION,
        input,
        "refusal-1",
      ),
    );
    expect(saved).toMatchObject({
      ok: true,
      fellow_id: f.actor.fellowId,
      sponsor_id: f.actor.sponsorId,
      session_id: SESSION,
      problem_id: "P-DEMO",
    });
    expect(count(f, "events")).toBe(before + 1);
    const event = f.sql.query("SELECT * FROM events WHERE id=?").get(saved.event_id) as Record<
      string,
      unknown
    >;
    expect(event).toMatchObject({
      type: "protocol_conflict.recorded",
      object_kind: "protocol-conflict",
      actor_fellow_id: f.actor.fellowId,
      actor_sponsor_id: f.actor.sponsorId,
      actor_session_id: SESSION,
      writer_credential_id: f.actor.credentialId,
    });
    const content = f.sql
      .query("SELECT payload_json FROM event_content WHERE event_id=?")
      .get(saved.event_id) as { payload_json: string };
    expect(JSON.parse(content.payload_json)).toEqual({
      conflict_id: saved.conflict_id,
      rule_cited: input.rule_cited,
      refused_part: input.refused_part,
      explanation: input.explanation,
    });
    expect(content.payload_json).not.toContain(input.directive_id);
    expect(content.payload_json).not.toContain("PRIVATE DIRECTIVE CANARY");
    expect(f.sql.query("SELECT * FROM sponsor_directives").all()).toEqual(sourceBefore);
    const notice = f.sql
      .query("SELECT * FROM fellow_inbox_notices WHERE caused_by_event_id=?")
      .get(saved.event_id);
    expect(notice).toMatchObject({
      fellow_id: f.actor.fellowId,
      notice_type: "protocol_notice",
      target_id: saved.conflict_id,
    });
    expect(JSON.stringify(notice)).not.toContain(input.directive_id);
    expect(JSON.stringify(notice)).not.toContain(input.refused_part);
    expect(f.sql.query("SELECT status FROM public_write_attempt_reservations").get()).toEqual({
      status: "settled_published",
    });
    expect(f.sql.query("SELECT cursor FROM public_cursor").get()).toEqual({ cursor: 1 });
    expect(isObjectLevelEvent({ type: "protocol_conflict.recorded" })).toBe(false);
    expect(f.counts.screens).toBe(1);
  }));

test("exact receipt retry is free after session closure and a later replacement directive", () =>
  using(async (f) => {
    const input = f.directive();
    const first = await run(f, input);
    f.directive({ verb: "unfocus" });
    f.sql.query("UPDATE sessions SET closed_at=?").run(new Date(NOW).toISOString());
    const counters = { ...f.counts };
    expect(await run(f, input)).toEqual(first);
    expect(f.counts).toEqual(counters);
    expect(count(f, "protocol_conflicts")).toBe(1);
    expect(f.sql.query("SELECT cursor FROM public_cursor").get()).toEqual({ cursor: 1 });
  }));

test("a lost committed acknowledgment recovers the same receipt and one notice", () =>
  using(async (f) => {
    const input = f.directive();
    f.loseAcknowledgment();
    const saved = await run(f, input);
    expect(await run(f, input)).toEqual(saved);
    expect(count(f, "protocol_conflicts")).toBe(1);
    expect(
      f.sql
        .query("SELECT COUNT(*) AS n FROM fellow_inbox_notices WHERE notice_type='protocol_notice'")
        .get(),
    ).toEqual({ n: 1 });
    expect(f.counts.settlements).toBe(0);
  }));

test("changed-key payload and a second key for the same source cannot append twice", () =>
  using(async (f) => {
    const input = f.directive();
    await run(f, input);
    await expect(
      run(f, { ...input, explanation: "A deliberately changed public explanation." }),
    ).rejects.toThrow("PROTOCOL_CONFLICT_CONFLICT");
    await expect(run(f, input, "another-key")).rejects.toThrow("PROTOCOL_CONFLICT_CONFLICT");
    expect(count(f, "protocol_conflicts")).toBe(1);
    expect(f.counts.screens).toBe(1);
  }));

for (const [label, source] of [
  ["other sponsor", { sponsor: "usr_other_sponsor" }],
  ["other problem", { problem: "P-OTHER" }],
  ["unfocus", { verb: "unfocus" as const }],
  ["future instruction", { timestamp: NOW + 1000 }],
] as const)
  test(`refuses a ${label} source before quota or screening`, () =>
    using(async (f) => {
      await expect(run(f, f.directive(source))).rejects.toThrow("PROTOCOL_CONFLICT_NOT_ALLOWED");
      expect(f.counts.reservations).toBe(0);
      expect(f.counts.screens).toBe(0);
      expect(count(f, "protocol_conflicts")).toBe(0);
    }));

test("a guessed or fabricated directive pin has the same opaque refusal", () =>
  using(async (f) => {
    const input = { ...f.directive(), directive_id: `DIR-${"f".repeat(32)}` };
    await expect(run(f, input)).rejects.toThrow("PROTOCOL_CONFLICT_NOT_ALLOWED");
    expect(f.counts.screens).toBe(0);
  }));

test("a sibling Fellow's received instruction cannot be used as the caller's source", () =>
  using(async (f) => {
    f.sql
      .query("INSERT INTO enrollment_fellows VALUES(?,?,'active')")
      .run("FEL-87654321", f.actor.sponsorId);
    const input = f.directive({ fellow: "FEL-87654321" });
    await expect(run(f, input)).rejects.toThrow("PROTOCOL_CONFLICT_NOT_ALLOWED");
    expect(f.counts.screens).toBe(0);
    expect(f.counts.reservations).toBe(0);
  }));

test("global received instructions can be refused by an observer with review authority", () =>
  using(async (f) => {
    const actor = { ...f.actor, grantedScopes: ["review" as const] };
    f.sql.exec(
      "UPDATE enrollment_grants SET granted_scopes_json='[\"review\"]'; UPDATE fellow_tokens SET granted_scopes_json='[\"review\"]'; UPDATE problem_memberships SET role='observer';",
    );
    const saved = await recordProtocolConflict(
      f.options,
      actor,
      SESSION,
      f.directive({ problem: null, verb: "forbid" }),
      "observer-refusal",
    );
    expect(saved.fellow_id).toBe(actor.fellowId);
  }));

for (const [label, mutation] of [
  ["session closes", "UPDATE sessions SET closed_at='2026-09-17T12:00:00.000Z'"],
  ["membership is removed", "DELETE FROM problem_memberships"],
  ["Fellow changes sponsor", "UPDATE enrollment_fellows SET sponsor_id='usr_transferred'"],
  ["sponsor is erased", "UPDATE sponsors SET tombstoned_at='2026-09-17T12:00:00.000Z'"],
  ["credential is revoked", `UPDATE fellow_tokens SET revoked_at=${NOW}`],
  ["credential expires", `UPDATE fellow_tokens SET expires_at=${NOW}`],
  ["grant changes", "UPDATE enrollment_grants SET granted_scopes_json='[]'"],
  [
    "grant event budget is exhausted",
    "UPDATE enrollment_grants SET granted_resources_json='{\"eventBudget\":0}'; UPDATE fellow_tokens SET granted_resources_json='{\"eventBudget\":0}'",
  ],
  [
    "directive receipt no longer matches",
    "UPDATE fellow_inbox_notices SET target_id='DIR-missing'",
  ],
] as const)
  test(`rolls back event, receipt, notice and cursor if ${label} while screening`, () =>
    using(async (f) => {
      const input = f.directive(),
        events = count(f, "events"),
        notices = count(f, "fellow_inbox_notices");
      f.before(() => f.sql.exec(mutation));
      await expect(run(f, input)).rejects.toThrow("PROTOCOL_CONFLICT_NOT_ALLOWED");
      expect(count(f, "events")).toBe(events);
      expect(count(f, "protocol_conflicts")).toBe(0);
      expect(count(f, "fellow_inbox_notices")).toBe(notices);
      expect(f.sql.query("SELECT cursor FROM public_cursor").get()).toEqual({ cursor: 0 });
      expect(f.sql.query("SELECT status FROM public_write_attempt_reservations").get()).toEqual({
        status: "settled_failed",
      });
    }));

test("screening provider failure holds public prose without a ledger or protocol notice", () =>
  using(async (f) => {
    const input = f.directive();
    const options = {
      ...f.options,
      screen: async () => {
        throw new Error("provider down");
      },
    };
    const before = count(f, "events");
    await expect(
      recordProtocolConflict(options, f.actor, SESSION, input, "held-refusal"),
    ).rejects.toThrow();
    expect(count(f, "events")).toBe(before);
    expect(count(f, "protocol_conflicts")).toBe(0);
    expect(
      f.sql
        .query("SELECT COUNT(*) AS n FROM fellow_inbox_notices WHERE notice_type='protocol_notice'")
        .get(),
    ).toEqual({ n: 0 });
  }));

test("notice failure rolls the complete public append and receipt back", () =>
  using(async (f) => {
    const input = f.directive(),
      events = count(f, "events"),
      head = f.sql.query("SELECT public_seq FROM problems WHERE id='P-DEMO'").get();
    f.before(() =>
      f.sql.exec(
        "CREATE TRIGGER reject_protocol_notice BEFORE INSERT ON fellow_inbox_notices WHEN NEW.notice_type='protocol_notice' BEGIN SELECT RAISE(ABORT,'test notice failure'); END;",
      ),
    );
    await expect(run(f, input)).rejects.toThrow("PROTOCOL_CONFLICT_UNAVAILABLE");
    expect(count(f, "events")).toBe(events);
    expect(count(f, "protocol_conflicts")).toBe(0);
    expect(f.sql.query("SELECT public_seq FROM problems WHERE id='P-DEMO'").get()).toEqual(head);
    expect(f.sql.query("SELECT cursor FROM public_cursor").get()).toEqual({ cursor: 0 });
    expect(f.sql.query("SELECT status FROM public_write_attempt_reservations").get()).toEqual({
      status: "settled_failed",
    });
  }));

test("immutable source bindings cannot be updated or deleted after publication", () =>
  using(async (f) => {
    await run(f);
    expect(() => f.sql.exec("UPDATE protocol_conflicts SET directive_id=directive_id")).toThrow(
      "PROTOCOL_CONFLICT_IMMUTABLE",
    );
    expect(() => f.sql.exec("DELETE FROM protocol_conflicts")).toThrow(
      "PROTOCOL_CONFLICT_IMMUTABLE",
    );
  }));
