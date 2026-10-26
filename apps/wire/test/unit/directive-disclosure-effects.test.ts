import { afterEach, expect, test } from "bun:test";
import type { D1Database } from "@cloudflare/workers-types";
import { recordDirectiveDisclosure } from "../../src/directives/disclosure-store.ts";
import { deliverDispositionChanges } from "../../src/inbox/disposition-change.ts";
import {
  type KraterAtomicCompanion,
  sha256Hex,
  writeLedgerEvent,
} from "../../src/krater/krater.ts";
import { prepareDeadEndTriggers } from "../../src/ledger/dead-ends.ts";
import { readScientificDispositions } from "../../src/ledger/scientific-disposition.ts";
import {
  DISCLOSURE_PROBLEM,
  DISCLOSURE_SPONSOR,
  directiveDisclosureFixture,
} from "../support/directive-disclosure.ts";

type Fixture = Awaited<ReturnType<typeof directiveDisclosureFixture>>;
const fixtures: Fixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.sql.close();
});

// All migrations, legal enrollment and disclosure commands, and the actual
// atomic ledger writer. Scientific publications below supply already admitted
// review/evidence payloads; this fixture does not test their HTTP admission.
async function publish(
  f: Fixture,
  kind: "evidence" | "review" | "dead_end",
  id: string,
  payload: Record<string, unknown>,
  options: { reviewer?: string; db?: D1Database; companion?: KraterAtomicCompanion } = {},
) {
  const db = options.db ?? f.db;
  const fellow = options.reviewer ?? f.binding.fellowId;
  const sponsor = options.reviewer ? `usr_${options.reviewer}` : DISCLOSURE_SPONSOR;
  const payloadJson = JSON.stringify(payload);
  return writeLedgerEvent(
    db,
    {
      problemId: DISCLOSURE_PROBLEM,
      eventId: `event-${id}`,
      idempotencyKey: `effects-${id}`,
      requestDigest: await sha256Hex(payloadJson),
      eventType: kind === "dead_end" ? "dead_end.recorded" : `${kind}.created`,
      objectKind: kind,
      objectId: id,
      objectVersion: 1,
      payloadJson,
      createdAt: new Date().toISOString(),
      attribution: {
        fellowId: fellow,
        sponsorId: sponsor,
        sessionId: "S-effects",
        modelSelfDeclared: "test/independent",
        harness: "curl",
      },
    },
    {
      statementsAfterEvent: ({ eventId, sequence, createdAt }) => {
        if (kind === "evidence")
          return [
            db
              .prepare(`INSERT INTO evidence
        (problem_id,evidence_id,bears_on_kind,bears_on_id,bears_on_version,direction,
          kind,source_kind,locator,mode,computed_class,author_fellow_id,body_md,
          created_at,source_event_id,source_seq)
        VALUES (?,?,'claim','C-1',1,?,'argument','locator','https://example.test/argument',
          'confirmatory','citation',?,?,?,?,?)`)
              .bind(
                DISCLOSURE_PROBLEM,
                id,
                String(payload.direction),
                fellow,
                String(payload.body_md),
                createdAt,
                eventId,
                sequence,
              ),
          ];
        if (kind === "review")
          return [
            db
              .prepare(`INSERT INTO reviews
        (problem_id,review_id,target_claim_id,target_version,reviewer_fellow_id,tier,
          verdict,basis,capable_of_failure,body_md,created_at,source_event_id,source_seq)
        VALUES (?,?,'C-1',1,?,'T2','confirm','checked-argument',?,?,?,?,?)`)
              .bind(
                DISCLOSURE_PROBLEM,
                id,
                fellow,
                String(payload.capable_of_failure),
                String(payload.body_md),
                createdAt,
                eventId,
                sequence,
              ),
          ];
        return [
          db
            .prepare(`INSERT INTO dead_ends
        (problem_id,dead_end_id,approach,why_it_fails,retry_predicate,retry_when_json,
          author_fellow_id,created_at,seq)
        VALUES (?,?,'Use the finite bound.','The bound needs independent support.',
          'Retry after strong standing.',?,?,?,?)`)
            .bind(
              DISCLOSURE_PROBLEM,
              id,
              JSON.stringify(payload.retry_when),
              fellow,
              createdAt,
              sequence,
            ),
        ];
      },
    },
    {},
    options.companion,
  );
}

async function fixture() {
  const f = await directiveDisclosureFixture();
  fixtures.push(f);
  const { content_digest } = f.sql
    .query(`SELECT content_digest FROM claim_versions
    WHERE problem_id = ? AND claim_id = 'C-1' AND version = 1`)
    .get(DISCLOSURE_PROBLEM) as { content_digest: string };
  const argument = {
    bears_on_kind: "claim",
    bears_on_id: "C-1",
    bears_on_version: 1,
    kind: "argument",
    direction: "supports",
    mode: "confirmatory",
    computed_class: "citation",
    body_md: "The published argument checks every member of the finite set.",
  };
  await publish(f, "evidence", "E-argument", argument);
  const reference = {
    evidence_id: "E-argument",
    digest: `sha256:${await sha256Hex(JSON.stringify(argument))}`,
  };
  await publish(f, "evidence", "E-check", {
    ...argument,
    direction: "informs",
    falsification_check: {
      target_digest: content_digest,
      attempted_falsifier: "Search the boundary members for a violation.",
      capable_of_failure: "A member could violate the bound.",
      result: "survived",
      evidence: [reference],
    },
  });
  await publish(f, "dead_end", "DE-route", {
    dead_end_id: "DE-route",
    retry_when: { kind: "claim-reaches", claim_id: "C-1", reaches: "strongly-supported" },
  });
  const review = {
    target_claim_id: "C-1",
    target_version: 1,
    verdict: "confirm",
    tier: "T2",
    capable_of_failure: "An omitted member could violate the claimed bound.",
    body_md: "Checked each step of the published finite argument independently.",
    independence_policy: "declared-family-and-grounded-method-v1",
    verification: {
      kind: "full-write-up",
      target_digest: content_digest,
      evidence: reference,
      coverage: ["Every case in the finite set."],
      result: "verified",
    },
  };
  await publish(f, "review", "R-first", review, { reviewer: "reviewer-one" });
  return { ...f, review };
}

async function attest(
  f: Fixture,
  key: string,
  decision: "no-undisclosed" | "withdraw" = "no-undisclosed",
) {
  const command = await f.command(DISCLOSURE_SPONSOR, decision);
  const receipt = await recordDirectiveDisclosure(f.db, f.target, DISCLOSURE_SPONSOR, command, key);
  if (receipt instanceof Response) throw new Error(await receipt.text());
  return { receipt, command };
}

async function standing(f: Fixture) {
  return (
    await readScientificDispositions(f.db, DISCLOSURE_PROBLEM, Number.MAX_SAFE_INTEGER, 1, {
      claimId: "C-1",
      version: 1,
    })
  ).get("C-1");
}

for (const changed of [false, true]) {
  test(`strong retry transition ${changed ? "rolls back after new private steering" : "commits with current exact disclosure"}`, async () => {
    const f = await fixture();
    await attest(f, "before-review");
    expect(await standing(f)).toMatchObject({
      disposition: "corroborated",
      directiveDisclosure: "satisfied",
    });
    const before = f.sql
      .query("SELECT public_seq,chain_digest FROM problems WHERE id = ?")
      .get(DISCLOSURE_PROBLEM);
    let prepared = false;
    let raced = false;
    const db = {
      prepare: f.db.prepare.bind(f.db),
      async batch(statements: Parameters<D1Database["batch"]>[0]) {
        if (changed && prepared && !raced) {
          raced = true;
          await f.issueDirective("after-strong-transition-read");
        }
        return f.db.batch(statements);
      },
    } as D1Database;
    const write = publish(f, "review", "R-second", f.review, {
      reviewer: "reviewer-two",
      db,
      companion: {
        async statementsAfterIdempotencySettlement(settlement) {
          const guards = await prepareDeadEndTriggers(db, DISCLOSURE_PROBLEM, settlement);
          expect(guards.length).toBeGreaterThan(0);
          prepared = true;
          return guards;
        },
      },
    });
    if (changed) {
      await expect(write).rejects.toThrow("SCIENTIFIC_REFERENCE_CHANGED");
      expect(raced).toBe(true);
      expect(
        f.sql
          .query("SELECT public_seq,chain_digest FROM problems WHERE id = ?")
          .get(DISCLOSURE_PROBLEM),
      ).toEqual(before);
      expect(f.sql.query("SELECT id FROM events WHERE id = 'event-R-second'").all()).toEqual([]);
      expect(
        f.sql.query("SELECT review_id FROM reviews WHERE review_id = 'R-second'").all(),
      ).toEqual([]);
      expect(f.sql.query("SELECT * FROM dead_end_fired_triggers").all()).toEqual([]);
      expect(await standing(f)).toMatchObject({
        disposition: "corroborated",
        directiveDisclosure: "unresolved",
      });
    } else {
      await write;
      expect(await standing(f)).toMatchObject({
        disposition: "strongly-supported",
        directiveDisclosure: "satisfied",
      });
      expect(f.sql.query("SELECT dead_end_id,event_id FROM dead_end_fired_triggers").all()).toEqual(
        [{ dead_end_id: "DE-route", event_id: "event-R-second" }],
      );
    }
  });
}

test("accepted disclosure queues its exact claim version once and delivers the newly earned standing", async () => {
  const f = await fixture();
  await publish(f, "review", "R-second", f.review, { reviewer: "reviewer-two" });
  expect(await standing(f)).toMatchObject({
    disposition: "corroborated",
    directiveDisclosure: "missing",
  });
  // Earlier scientific writes have their own jobs; isolate this declaration's effect.
  f.sql.exec("UPDATE disposition_change_deliveries SET state = 'unchanged'");
  const { receipt, command } = await attest(f, "unlock-standing");
  expect(
    await recordDirectiveDisclosure(f.db, f.target, DISCLOSURE_SPONSOR, command, "unlock-standing"),
  ).toEqual(receipt);
  expect(
    f.sql
      .query("SELECT event_id,state FROM disposition_change_deliveries WHERE state = 'pending'")
      .all(),
  ).toEqual([{ event_id: receipt.event_id, state: "pending" }]);
  expect(await deliverDispositionChanges(f.db)).toMatchObject({
    examined: 1,
    changed: 1,
    notices: 1,
    failed: 0,
  });
  expect(
    f.sql
      .query(
        "SELECT notice_type,target_id,title,caused_by_event_id FROM fellow_inbox_notices WHERE notice_type = 'disposition_change'",
      )
      .all(),
  ).toEqual([
    {
      notice_type: "disposition_change",
      target_id: "C-1",
      title: "C-1@1 is now strongly-supported",
      caused_by_event_id: receipt.event_id,
    },
  ]);
  expect(await deliverDispositionChanges(f.db)).toMatchObject({ examined: 0, notices: 0 });
});

test("withdrawal notifies its accepted revision without inventing a historical standing transition", async () => {
  const f = await fixture();
  await publish(f, "review", "R-second", f.review, { reviewer: "reviewer-two" });
  await attest(f, "declared-before-withdrawal");
  expect(await standing(f)).toMatchObject({ disposition: "strongly-supported" });
  f.sql.exec("UPDATE disposition_change_deliveries SET state = 'unchanged'");
  const { receipt } = await attest(f, "withdraw-declaration", "withdraw");
  for (const cursor of [receipt.seq - 1, receipt.seq]) {
    const historical = (
      await readScientificDispositions(f.db, DISCLOSURE_PROBLEM, cursor, 1, {
        claimId: "C-1",
        version: 1,
      })
    ).get("C-1");
    expect(historical).toMatchObject({
      disposition: "corroborated",
      directiveDisclosure: "unresolved",
    });
  }
  expect(await deliverDispositionChanges(f.db)).toMatchObject({
    examined: 1,
    changed: 0,
    unchanged: 1,
    notices: 1,
    failed: 0,
  });
  const notice = f.sql
    .query("SELECT title,detail FROM fellow_inbox_notices WHERE notice_type = 'disposition_change'")
    .get() as { title: string; detail: string };
  expect(notice.title).toBe("C-1@1 disclosure withdrawn");
  expect(notice.detail).toContain("current computed disposition is corroborated");
  expect(notice.detail).not.toContain("moved from");
});

test("private steering after the inbox fold rolls back a strong notice and retries truthfully", async () => {
  const f = await fixture();
  await publish(f, "review", "R-second", f.review, { reviewer: "reviewer-two" });
  f.sql.exec("UPDATE disposition_change_deliveries SET state = 'unchanged'");
  const { receipt } = await attest(f, "before-delivery-race");
  let raced = false;
  const db = {
    prepare: f.db.prepare.bind(f.db),
    async batch(statements: Parameters<D1Database["batch"]>[0]) {
      if (!raced) {
        raced = true;
        await f.issueDirective("after-inbox-standing-read");
      }
      return f.db.batch(statements);
    },
  } as D1Database;
  expect(await deliverDispositionChanges(db)).toMatchObject({
    examined: 1,
    failed: 1,
    changed: 0,
    notices: 0,
  });
  expect(raced).toBe(true);
  expect(
    f.sql
      .query("SELECT state FROM disposition_change_deliveries WHERE event_id = ?")
      .get(receipt.event_id),
  ).toEqual({ state: "pending" });
  expect(
    f.sql
      .query("SELECT id FROM fellow_inbox_notices WHERE notice_type = 'disposition_change'")
      .all(),
  ).toEqual([]);
  expect(await deliverDispositionChanges(f.db)).toMatchObject({
    examined: 1,
    failed: 0,
    changed: 0,
    unchanged: 1,
    notices: 1,
  });
  const notice = f.sql
    .query("SELECT title,detail FROM fellow_inbox_notices WHERE notice_type = 'disposition_change'")
    .get() as { title: string; detail: string };
  expect(notice.title).toBe("C-1@1 disclosure updated");
  expect(notice.detail).toContain("current computed disposition is corroborated");
  expect(notice.detail).not.toContain("strongly-supported");
});
