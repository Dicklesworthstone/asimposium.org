import { afterEach, expect, test } from "bun:test";
import {
  type SaveProblemBriefRequest,
  SaveProblemBriefRequestSchema,
  SaveProblemBriefResponseSchema,
  type SponsorProblemBrief,
} from "@asimposium/contracts";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import {
  runSponsorBriefCommand,
  type SponsorBriefCommand,
} from "../../src/problems/brief-commands.ts";
import { directiveDisclosureFixture } from "../support/directive-disclosure.ts";

type Fixture = Awaited<ReturnType<typeof directiveDisclosureFixture>>;
const fixtures: Fixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.sql.close();
});

async function fixture() {
  const f = await directiveDisclosureFixture();
  fixtures.push(f);
  const now = Date.now();
  let beforeBatch: (() => Promise<void> | void) | undefined;
  let beforeState: (() => Promise<void> | void) | undefined;
  let loseBatchResponse = false;
  const db = {
    prepare(text: string) {
      const statement = f.db.prepare(text);
      const wrapped = {
        ...statement,
        bind(...values: unknown[]) {
          statement.bind(...values);
          return wrapped;
        },
        async first() {
          if (text.startsWith("SELECT sponsor_id,status,version,scope")) {
            const hook = beforeState;
            beforeState = undefined;
            await hook?.();
          }
          return statement.first();
        },
      };
      return wrapped as D1PreparedStatement;
    },
    async batch(statements: D1PreparedStatement[]) {
      const hook = beforeBatch;
      beforeBatch = undefined;
      await hook?.();
      const result = await f.db.batch(statements);
      if (loseBatchResponse) {
        loseBatchResponse = false;
        throw new Error("SIMULATED_LOST_BATCH_RESPONSE");
      }
      return result;
    },
  } as D1Database;
  const formulation: SaveProblemBriefRequest = {
    title: "Investigate a finite graph invariant",
    statement: "PRIVATE-BRIEF: every finite tree has one fewer edge than vertices.",
    falsifier: "A finite tree whose edge count differs.",
    motivation: "PRIVATE-MOTIVATION: determine the connected case.",
    scope: "Finite trees.",
    out_of_scope: "Infinite graphs.",
    success_criteria: "A checkable proof or explicit counterexample.",
    areas: ["combinatorics"],
    assigned_fellow_id: f.binding.fellowId,
  };
  const save = (key: string | null, changes: Partial<SaveProblemBriefRequest> = {}, at = now) =>
    runSponsorBriefCommand(
      db,
      f.principal.sponsorId,
      key,
      {
        operation: "save",
        request: SaveProblemBriefRequestSchema.parse({ ...formulation, ...changes }),
      },
      at,
    );
  const withdraw = (brief: SponsorProblemBrief, key: string, at = now) =>
    runSponsorBriefCommand(
      db,
      f.principal.sponsorId,
      key,
      {
        operation: "withdraw",
        id: brief.id,
        request: { expected_version: brief.version },
      },
      at,
    );
  const state = () => ({
    briefs: f.sql.query("SELECT * FROM sponsor_problem_briefs ORDER BY id").all(),
    receipts: f.sql
      .query("SELECT * FROM sponsor_brief_command_receipts ORDER BY sponsor_id,key_digest")
      .all(),
    public: f.sql.query("SELECT id,public_seq FROM problems ORDER BY id").all(),
  });
  return {
    ...f,
    db,
    now,
    formulation,
    save,
    withdraw,
    state,
    beforeBatch(hook: () => Promise<void> | void) {
      beforeBatch = hook;
    },
    beforeState(hook: () => Promise<void> | void) {
      beforeState = hook;
    },
    loseResponse() {
      loseBatchResponse = true;
    },
  };
}

async function saved(response: Response): Promise<SponsorProblemBrief> {
  expect(response.status, await response.clone().text()).toBe(201);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  return SaveProblemBriefResponseSchema.parse(await response.json()).brief;
}

test("a lost create response recovers one exact brief without retaining its prose or replay key", async () => {
  const f = await fixture();
  f.loseResponse();
  const first = await saved(await f.save("create-private-intent"));
  const committed = f.state();
  expect(await saved(await f.save("create-private-intent", {}, f.now + 1000))).toEqual(first);
  expect(f.state()).toEqual(committed);
  expect(committed.briefs).toHaveLength(1);
  expect(committed.receipts).toHaveLength(1);
  const metadata = JSON.stringify(committed.receipts);
  expect(metadata).not.toContain(f.formulation.statement);
  expect(metadata).not.toContain(f.formulation.motivation);
  expect(metadata).not.toContain("create-private-intent");
});

test("same key with different text or a different command conflicts without mutation", async () => {
  const f = await fixture();
  const first = await saved(await f.save("shared-key"));
  const before = f.state();
  for (const response of [
    await f.save("shared-key", { title: "A different intent" }),
    await f.withdraw(first, "shared-key"),
  ]) {
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(f.state()).toEqual(before);
  }
});

test("editing preserves creation time and advances the version even within one millisecond", async () => {
  const f = await fixture();
  const first = await saved(await f.save("create"));
  const second = await saved(
    await f.save("edit", {
      id: first.id,
      expected_version: first.version,
      title: "A revised private aim",
    }),
  );
  expect(second).toMatchObject({
    version: 2,
    created_at: first.created_at,
    updated_at: first.updated_at,
  });
  const before = f.state();
  for (const expected_version of [undefined, first.version]) {
    const response = await f.save(`stale-${String(expected_version)}`, {
      id: first.id,
      expected_version,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "BRIEF_VERSION_CONFLICT",
      current_version: 2,
      suggested_action: "refetch_and_reapply",
    });
    expect(f.state()).toEqual(before);
  }
});

for (const point of ["state", "batch"] as const) {
  test(`same-key concurrent edit replays the winner committed before the ${point} check`, async () => {
    const f = await fixture();
    const first = await saved(await f.save("create"));
    const edit = { id: first.id, expected_version: first.version, title: "Winning edit" };
    let winner: SponsorProblemBrief | undefined;
    const overlap = async () => {
      winner = await saved(await f.save("same-edit", edit));
    };
    if (point === "state") f.beforeState(overlap);
    else f.beforeBatch(overlap);
    const repeated = await saved(await f.save("same-edit", edit));
    expect(winner).toBeDefined();
    if (winner === undefined) throw new Error("Concurrent command did not commit");
    expect(repeated).toEqual(winner);
    expect(repeated.version).toBe(2);
    expect(f.state().briefs).toHaveLength(1);
    expect(f.state().receipts).toHaveLength(2);
  });
}

test("different-key competing edit returns a fresh pin and leaves no loser receipt", async () => {
  const f = await fixture();
  const first = await saved(await f.save("create"));
  let winningState: ReturnType<typeof f.state> | undefined;
  f.beforeBatch(async () => {
    await saved(
      await f.save("winner", { id: first.id, expected_version: 1, title: "Winning edit" }),
    );
    winningState = f.state();
  });
  const response = await f.save("loser", {
    id: first.id,
    expected_version: 1,
    title: "Losing edit",
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    code: "BRIEF_VERSION_CONFLICT",
    current_version: 2,
  });
  if (winningState === undefined) throw new Error("Concurrent command did not commit");
  expect(f.state()).toEqual(winningState);
});

test("concurrent generated-ID creates elect one receipt and roll back the losing brief", async () => {
  const f = await fixture();
  let winner: SponsorProblemBrief | undefined;
  f.beforeBatch(async () => {
    winner = await saved(await f.save("one-create"));
  });
  const response = await saved(await f.save("one-create"));
  if (winner === undefined) throw new Error("Concurrent create did not commit");
  expect(response).toEqual(winner);
  expect(f.state().briefs).toHaveLength(1);
  expect(f.state().receipts).toHaveLength(1);
});

test("withdrawal is versioned and exact retries never reapply historical saves", async () => {
  const f = await fixture();
  const first = await saved(await f.save("create"));
  const response = await f.withdraw(first, "withdraw");
  expect(response.status).toBe(200);
  const receipt: unknown = await response.json();
  expect(receipt).toEqual({ withdrawn: true, id: first.id, version: 2 });
  const committed = f.state();
  expect(await (await f.withdraw(first, "withdraw", f.now + 1000)).json()).toEqual(receipt);
  expect(await saved(await f.save("create", {}, f.now + 1000))).toEqual(first);
  expect(f.state()).toEqual(committed);
  expect((await f.save("late-edit", { id: first.id, expected_version: 2 })).status).toBe(404);
});

test("adoption cannot be undone by withdrawal or an old save replay", async () => {
  const f = await fixture();
  const first = await saved(await f.save("create"));
  f.sql
    .query("UPDATE sponsor_problem_briefs SET status='adopted',version=version+1 WHERE id=?")
    .run(first.id);
  const adopted = f.state();
  expect((await f.withdraw(first, "late-withdraw")).status).toBe(404);
  expect(await saved(await f.save("create"))).toEqual(first);
  expect(f.state()).toEqual(adopted);
});

test("receipt failure rolls back the brief and leaves the key available for retry", async () => {
  const f = await fixture();
  f.sql.exec(
    "CREATE TRIGGER refuse_brief_receipt BEFORE INSERT ON sponsor_brief_command_receipts BEGIN SELECT RAISE(ABORT,'injected-receipt-failure'); END",
  );
  const before = f.state();
  expect((await f.save("recoverable-create")).status).toBe(503);
  expect(f.state()).toEqual(before);
  f.sql.exec("DROP TRIGGER refuse_brief_receipt");
  expect((await saved(await f.save("recoverable-create"))).version).toBe(1);
});

test("a mismatched committed-head receipt pin aborts every effect", async () => {
  const f = await fixture();
  f.sql.exec(
    "CREATE TRIGGER alter_brief_head AFTER INSERT ON sponsor_problem_briefs BEGIN UPDATE sponsor_problem_briefs SET version=version+1 WHERE id=NEW.id; END",
  );
  const before = f.state();
  expect((await f.save("guarded-create")).status).toBe(503);
  expect(f.state()).toEqual(before);
});

test("assignee retirement between validation and commitment refuses the write", async () => {
  const f = await fixture();
  f.beforeBatch(async () => {
    await f.service.transitionFellow(
      f.principal,
      {
        fellow_id: f.binding.fellowId,
        status: "paused",
        confirm: "change-fellow-lifecycle",
        step_up_authenticated_at: Math.floor(Date.now() / 1000),
      },
      { idempotencyKey: "pause-assignee-before-brief" },
    );
  });
  const response = await f.save("racing-assignee");
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: "BRIEF_NOT_ASSIGNED" });
  expect(f.state().briefs).toEqual([]);
  expect(f.state().receipts).toEqual([]);
});

test("replays require a living current sponsor and are isolated from other sponsors", async () => {
  const f = await fixture();
  const first = await saved(await f.save("private-create"));
  const other: SponsorBriefCommand = {
    operation: "save",
    request: { ...f.formulation, id: first.id, expected_version: first.version },
  };
  const before = f.state();
  expect(
    (await runSponsorBriefCommand(f.db, f.receiver.sponsorId, "private-create", other)).status,
  ).toBe(404);
  expect(f.state()).toEqual(before);
  f.sql
    .query("UPDATE sponsors SET tombstoned_at=? WHERE sponsor_id=?")
    .run(f.now, f.principal.sponsorId);
  expect((await f.save("private-create")).status).toBe(403);
  expect(f.state()).toEqual(before);
});

test("a replay does not extend the original 24-hour deadline", async () => {
  const f = await fixture();
  const first = await saved(await f.save("expires"));
  expect(await saved(await f.save("expires", {}, f.now + 86_399_999))).toEqual(first);
  const next = await saved(await f.save("expires", {}, f.now + 86_400_000));
  expect(next.id).not.toBe(first.id);
  expect(f.state().briefs).toHaveLength(2);
  expect(f.state().receipts).toHaveLength(1);
});

test("missing replay keys and omitted recorded boundaries never mutate the brief", async () => {
  const f = await fixture();
  expect((await f.save(null)).status).toBe(400);
  expect(f.state().briefs).toEqual([]);
  const first = await saved(await f.save("create"));
  const before = f.state();
  const response = await f.save("boundary-drop", {
    id: first.id,
    expected_version: 1,
    scope: undefined,
    out_of_scope: undefined,
    success_criteria: undefined,
  });
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({ code: "STATEMENT_INCOMPLETE" });
  expect(f.state()).toEqual(before);
});
