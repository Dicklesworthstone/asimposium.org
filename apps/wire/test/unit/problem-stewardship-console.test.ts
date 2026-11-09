import { afterEach, expect, test } from "bun:test";
import {
  type ProblemLifecycleActionRequest,
  ProblemStewardshipActionReceiptSchema,
} from "@asimposium/contracts";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import {
  applyPrivateProblemAccessAction,
  replayPrivateProblemAccessAction,
} from "../../src/problems/access-actions.ts";
import { readSponsorProblemGovernance } from "../../src/problems/governance-read.ts";
import { applyPublicProblemGovernance } from "../../src/problems/lifecycle-ledger.ts";
import { readProblemPublicationPreview } from "../../src/problems/publication-preview.ts";
import {
  FELLOW,
  PROBLEM,
  publicationContextFixture,
  SPONSOR,
} from "../support/publication-context.ts";

type Fixture = Awaited<ReturnType<typeof publicationContextFixture>>;
type Command = Extract<ProblemLifecycleActionRequest, { action: "manage-steward" }>;
const OTHER_SPONSOR = "usr_steward_other";
const THIRD = "usr_steward_third";
const fixtures: Fixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.sql.close();
});
async function fixture() {
  const f = await publicationContextFixture();
  fixtures.push(f);
  f.sql
    .query("UPDATE problems SET status='private-draft',created_by_fellow_id=? WHERE id=?")
    .run(FELLOW, PROBLEM);
  for (const sponsor of [OTHER_SPONSOR, THIRD])
    f.sql
      .query("INSERT INTO sponsors(sponsor_id,created_at,last_seen_at) VALUES(?,?,?)")
      .run(sponsor, Date.now(), Date.now());
  f.sql
    .query(
      "INSERT INTO problem_stewards(problem_id,sponsor_id,is_founding,created_at) VALUES(?,?,1,?)",
    )
    .run(PROBLEM, SPONSOR, new Date().toISOString());
  return f;
}
const request = (key: string) =>
  new Request(`https://a.asimposium.org/v1/sponsors/problems/${PROBLEM}/lifecycle`, {
    method: "POST",
    headers: { "idempotency-key": key },
  });
const snapshot = (f: Fixture) =>
  f.sql.query("SELECT * FROM problems WHERE id=?").get(PROBLEM) as Parameters<
    typeof applyPublicProblemGovernance
  >[1];
async function reviewed(
  f: Fixture,
  operation: Command["operation"],
  target = OTHER_SPONSOR,
  actor = SPONSOR,
): Promise<Command> {
  const page = await readSponsorProblemGovernance(f.db, PROBLEM, actor);
  if (page?.stewardship === undefined) throw new Error("Missing current stewardship");
  return {
    action: "manage-steward",
    operation,
    target_sponsor_id: target,
    expected_stewardship_version: page.stewardship.version,
  };
}
async function receipt(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const body = (await response.json()) as { governance_action?: unknown };
  return ProblemStewardshipActionReceiptSchema.parse(body.governance_action);
}
async function publish(f: Fixture) {
  const preview = await readProblemPublicationPreview(f.db, PROBLEM, SPONSOR);
  if (!preview) throw new Error("Missing publication preview");
  expect(
    (
      await applyPublicProblemGovernance(
        f.db,
        snapshot(f),
        SPONSOR,
        {
          action: "publish",
          reviewed_statement_version: preview.problem.current_statement_version,
          reviewed_digest: preview.review_digest,
        },
        request("publish-stewardship"),
      )
    ).status,
  ).toBe(200);
}

test("the private governance read bounds sponsor stewards independently and refuses foreign authority", async () => {
  const f = await fixture();
  for (let index = 0; index < 52; index++) {
    const id = `usr_roster_${String(index).padStart(3, "0")}`;
    f.sql
      .query("INSERT INTO sponsors(sponsor_id,created_at,last_seen_at) VALUES(?,?,?)")
      .run(id, Date.now(), Date.now());
    f.sql
      .query("INSERT INTO problem_stewards VALUES(?,?,0,?)")
      .run(PROBLEM, id, new Date().toISOString());
  }
  const first = await readSponsorProblemGovernance(f.db, PROBLEM, SPONSOR);
  expect(first?.stewardship).toMatchObject({
    total_count: 53,
    has_more: true,
    accountable_sponsor_id: SPONSOR,
  });
  expect(first?.stewardship?.stewards).toHaveLength(50);
  expect(first?.stewardship?.stewards[0]).toMatchObject({ sponsor_id: SPONSOR, is_founding: true });
  const after = first?.stewardship?.next_after;
  if (!after) throw new Error("Missing bounded continuation");
  const second = await readSponsorProblemGovernance(f.db, PROBLEM, SPONSOR, {
    steward_after: after,
  });
  expect(second?.stewardship?.stewards).toHaveLength(3);
  expect(second?.stewardship).toMatchObject({ total_count: 53, has_more: false, next_after: null });
  expect(await readSponsorProblemGovernance(f.db, PROBLEM, OTHER_SPONSOR)).toBeUndefined();
});

test("a private transfer retains its exact metadata receipt after the acting sponsor loses authority", async () => {
  const f = await fixture(),
    command = await reviewed(f, "transfer");
  const first = await receipt(
    await applyPrivateProblemAccessAction(f.db, PROBLEM, SPONSOR, command, request("transfer")),
  );
  expect(first).toMatchObject({
    operation: "transfer",
    target_sponsor_id: OTHER_SPONSOR,
    expected_stewardship_version: command.expected_stewardship_version,
    event_id: null,
  });
  expect(await readSponsorProblemGovernance(f.db, PROBLEM, SPONSOR)).toBeUndefined();
  const replay = await replayPrivateProblemAccessAction(
    f.db,
    PROBLEM,
    SPONSOR,
    command,
    request("transfer"),
  );
  if (!replay) throw new Error("Lost-authority transfer receipt is unavailable");
  expect(await receipt(replay)).toEqual(first);
  expect(
    (
      await applyPrivateProblemAccessAction(
        f.db,
        PROBLEM,
        SPONSOR,
        { ...command, target_sponsor_id: THIRD },
        request("transfer"),
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await applyPrivateProblemAccessAction(
        f.db,
        PROBLEM,
        SPONSOR,
        { ...command, operation: "add", target_sponsor_id: THIRD },
        request("new-command"),
      )
    ).status,
  ).toBe(409);
  expect(
    f.sql.query("SELECT sponsor_id FROM problem_stewards WHERE problem_id=?").all(PROBLEM),
  ).toEqual([{ sponsor_id: OTHER_SPONSOR }]);
  expect(f.sql.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 });
  expect(f.sql.query("SELECT COUNT(*) AS n FROM private_problem_access_replays").get()).toEqual({
    n: 1,
  });
});

test("parallel private decisions on one reviewed roster cannot overwrite each other, and no retry reapplies a removal", async () => {
  const f = await fixture(),
    command = await reviewed(f, "add");
  const replies = await Promise.all([
    applyPrivateProblemAccessAction(f.db, PROBLEM, SPONSOR, command, request("add-one")),
    applyPrivateProblemAccessAction(
      f.db,
      PROBLEM,
      SPONSOR,
      { ...command, target_sponsor_id: THIRD },
      request("add-two"),
    ),
  ]);
  expect(replies.map((value) => value.status).sort()).toEqual([200, 409]);
  const winner = replies[0]?.status === 200 ? OTHER_SPONSOR : THIRD;
  const remove = await reviewed(f, "remove", SPONSOR, winner);
  const removed = await receipt(
    await applyPrivateProblemAccessAction(f.db, PROBLEM, winner, remove, request("remove-founder")),
  );
  expect(snapshot(f).sponsor_id).toBe(winner);
  expect(
    f.sql
      .query("SELECT sponsor_id,is_founding FROM problem_stewards WHERE problem_id=?")
      .all(PROBLEM),
  ).toEqual([{ sponsor_id: winner, is_founding: 0 }]);
  expect(
    await receipt(
      await applyPrivateProblemAccessAction(
        f.db,
        PROBLEM,
        winner,
        remove,
        request("remove-founder"),
      ),
    ),
  ).toEqual(removed);
  const last = await reviewed(f, "remove", winner, winner);
  expect(
    (await applyPrivateProblemAccessAction(f.db, PROBLEM, winner, last, request("remove-final")))
      .status,
  ).toBe(422);
  expect(
    f.sql.query("SELECT COUNT(*) AS n FROM problem_stewards WHERE problem_id=?").get(PROBLEM),
  ).toEqual({ n: 1 });
});

test("the private transaction rejects lost authority and inactive transfer targets after preflight", async () => {
  const f = await fixture(),
    command = await reviewed(f, "transfer");
  let fired = false;
  const racingDb: D1Database = new Proxy(f.db, {
    get(target, property, receiver) {
      if (property === "batch")
        return async <T = unknown>(statements: D1PreparedStatement[]) => {
          if (!fired) {
            fired = true;
            f.sql
              .query("UPDATE sponsors SET tombstoned_at=? WHERE sponsor_id=?")
              .run(new Date().toISOString(), OTHER_SPONSOR);
          }
          return target.batch<T>(statements);
        };
      return Reflect.get(target, property, receiver);
    },
  });
  expect(
    (
      await applyPrivateProblemAccessAction(
        racingDb,
        PROBLEM,
        SPONSOR,
        command,
        request("inactive-target"),
      )
    ).status,
  ).toBe(409);
  expect(snapshot(f).sponsor_id).toBe(SPONSOR);
  expect(f.sql.query("SELECT COUNT(*) AS n FROM private_problem_access_replays").get()).toEqual({
    n: 0,
  });
  f.sql
    .query("DELETE FROM problem_stewards WHERE problem_id=? AND sponsor_id=?")
    .run(PROBLEM, SPONSOR);
  f.sql.query("UPDATE problems SET sponsor_id=? WHERE id=?").run(THIRD, PROBLEM);
  expect(
    (
      await applyPrivateProblemAccessAction(
        f.db,
        PROBLEM,
        SPONSOR,
        { ...command, target_sponsor_id: THIRD },
        request("lost-authority"),
      )
    ).status,
  ).toBe(409);
  expect(f.sql.query("SELECT COUNT(*) AS n FROM private_problem_access_replays").get()).toEqual({
    n: 0,
  });
});

test("public transfer receipts recover after authority loss without returning formulation or reapplying state", async () => {
  const f = await fixture();
  await publish(f);
  const command = await reviewed(f, "transfer");
  const firstResponse = await applyPublicProblemGovernance(
    f.db,
    snapshot(f),
    SPONSOR,
    command,
    request("public-transfer"),
  );
  const first = await receipt(firstResponse);
  expect(first.event_id).not.toBeNull();
  const replay = await applyPublicProblemGovernance(
    f.db,
    snapshot(f),
    SPONSOR,
    command,
    request("public-transfer"),
  );
  const replayText = await replay.text();
  expect(
    ProblemStewardshipActionReceiptSchema.parse(JSON.parse(replayText).governance_action),
  ).toEqual(first);
  expect(replayText).not.toContain("statement");
  expect(replayText).not.toContain("falsifier");
  expect(
    (
      await applyPublicProblemGovernance(
        f.db,
        snapshot(f),
        SPONSOR,
        { ...command, operation: "add", target_sponsor_id: THIRD },
        request("new-public-command"),
      )
    ).status,
  ).toBe(403);
  expect(
    f.sql.query("SELECT COUNT(*) AS n FROM events WHERE type='problem.steward-updated'").get(),
  ).toEqual({ n: 1 });
});

test("public changes reject stale roster pins and preserve the remaining steward and founder provenance", async () => {
  const f = await fixture();
  await publish(f);
  const original = await reviewed(f, "add");
  await receipt(
    await applyPublicProblemGovernance(f.db, snapshot(f), SPONSOR, original, request("public-add")),
  );
  expect(
    (
      await applyPublicProblemGovernance(
        f.db,
        snapshot(f),
        SPONSOR,
        { ...original, target_sponsor_id: THIRD },
        request("stale-add"),
      )
    ).status,
  ).toBe(409);
  const remove = await reviewed(f, "remove", SPONSOR, OTHER_SPONSOR);
  await receipt(
    await applyPublicProblemGovernance(
      f.db,
      snapshot(f),
      OTHER_SPONSOR,
      remove,
      request("public-remove-founder"),
    ),
  );
  expect(snapshot(f).sponsor_id).toBe(OTHER_SPONSOR);
  const last = await reviewed(f, "remove", OTHER_SPONSOR, OTHER_SPONSOR);
  expect(
    (
      await applyPublicProblemGovernance(
        f.db,
        snapshot(f),
        OTHER_SPONSOR,
        last,
        request("public-remove-last"),
      )
    ).status,
  ).toBe(422);
  expect(
    f.sql.query("SELECT COUNT(*) AS n FROM problem_stewards WHERE problem_id=?").get(PROBLEM),
  ).toEqual({ n: 1 });
});

test("a duplicate public transfer racing the authority preflight recovers the winning receipt", async () => {
  const f = await fixture();
  await publish(f);
  await receipt(
    await applyPublicProblemGovernance(
      f.db,
      snapshot(f),
      SPONSOR,
      await reviewed(f, "add"),
      request("share-before-race"),
    ),
  );
  const command = await reviewed(f, "transfer", THIRD, OTHER_SPONSOR);
  const original = snapshot(f);
  let armed = true;
  let winningReceipt: Awaited<ReturnType<typeof receipt>> | undefined;
  const racingDb: D1Database = new Proxy(f.db, {
    get(database, property, receiver) {
      if (property !== "prepare") return Reflect.get(database, property, receiver);
      return (sql: string): D1PreparedStatement => {
        const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
          new Proxy(statement, {
            get(target, field, statementReceiver) {
              if (field === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
              if (field === "first")
                return async <T = unknown>(column?: string): Promise<T | null> => {
                  if (
                    armed &&
                    sql === "SELECT 1 FROM problem_stewards WHERE problem_id = ? AND sponsor_id = ?"
                  ) {
                    armed = false;
                    winningReceipt = await receipt(
                      await applyPublicProblemGovernance(
                        f.db,
                        original,
                        OTHER_SPONSOR,
                        command,
                        request("duplicate-transfer"),
                      ),
                    );
                  }
                  return column === undefined ? target.first<T>() : target.first<T>(column);
                };
              return Reflect.get(target, field, statementReceiver);
            },
          });
        return wrap(database.prepare(sql));
      };
    },
  });
  const recovered = await receipt(
    await applyPublicProblemGovernance(
      racingDb,
      original,
      OTHER_SPONSOR,
      command,
      request("duplicate-transfer"),
    ),
  );
  expect(armed).toBe(false);
  if (!winningReceipt) throw new Error("The competing transfer did not commit");
  expect(recovered).toEqual(winningReceipt);
  expect(await readSponsorProblemGovernance(f.db, PROBLEM, OTHER_SPONSOR)).toBeUndefined();
  expect(
    f.sql.query("SELECT COUNT(*) AS n FROM events WHERE type='problem.steward-updated'").get(),
  ).toEqual({ n: 2 });
});
