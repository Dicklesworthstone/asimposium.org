import { afterEach, expect, test } from "bun:test";
import type { D1Database } from "@cloudflare/workers-types";
import type { EnrollmentService, FellowCredentialBinding } from "../../src/enrollment/service.ts";
import type { Env } from "../../src/env.ts";
import { createProblemRouter } from "../../src/problems/router.ts";
import {
  FELLOW,
  OTHER,
  publicationContextFixture,
  SPONSOR,
} from "../support/publication-context.ts";

type Fixture = Awaited<ReturnType<typeof publicationContextFixture>>;
const fixtures: Fixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.sql.close();
});

const BRIEF = "brief-admission-race";
const proposal = {
  brief_id: BRIEF,
  title: "A finite tree investigation",
  statement: "Every finite tree has exactly one fewer edge than vertices.",
  falsifier: "A finite tree with a different edge count.",
  motivation: "Establish the invariant needed for the connected graph argument.",
  areas: ["combinatorics"],
};

async function fixture() {
  const f = await publicationContextFixture();
  fixtures.push(f);
  const now = Date.now();
  const binding: FellowCredentialBinding = {
    fellowId: FELLOW,
    sponsorId: SPONSOR,
    credentialId: "TOKEN-brief-admission",
    name: "context-0",
    model: "model",
    harness: "test",
    grantedScopes: ["propose-problems"],
    grantedResources: {},
    tokenHash: "a".repeat(64),
    issuedAt: now - 1000,
    expiresAt: now + 60_000,
    credentialProfile: "bearer",
    fellowStatus: "active",
  };
  f.sql
    .query(`INSERT INTO sponsor_problem_briefs
      (id,sponsor_id,assigned_fellow_id,title,statement,falsifier,motivation,areas,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(
      BRIEF,
      SPONSOR,
      FELLOW,
      proposal.title,
      proposal.statement,
      proposal.falsifier,
      proposal.motivation,
      JSON.stringify(proposal.areas),
      new Date(now).toISOString(),
      new Date(now).toISOString(),
    );
  const router = createProblemRouter({
    service: { credentialBinding: async () => binding } as unknown as EnrollmentService,
    verifiedSponsor: async () => new Response(null, { status: 403 }),
  });
  // Unit-level deterministic interleaving around the real proposal SQL. The
  // shared adapter applies the actual migrations and rolls back whole batches.
  // The hook models a different request committing after the admission read.
  let beforeBatch: (() => void | Promise<void>) | undefined;
  const db = {
    prepare: f.db.prepare.bind(f.db),
    async batch(statements) {
      const hook = beforeBatch;
      beforeBatch = undefined;
      await hook?.();
      return f.db.batch(statements);
    },
  } as D1Database;
  const propose = (body: object = proposal) =>
    router.fetch(
      new Request("https://a.asimposium.org/v1/problems", {
        method: "POST",
        headers: { authorization: "Bearer fixture", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { DB: db } as Env,
    );
  const state = () => ({
    problems: f.sql.query("SELECT * FROM problems ORDER BY id").all(),
    statements: f.sql
      .query("SELECT * FROM problem_statement_versions ORDER BY problem_id,version")
      .all(),
    stewards: f.sql.query("SELECT * FROM problem_stewards ORDER BY problem_id,sponsor_id").all(),
    memberships: f.sql
      .query("SELECT * FROM problem_memberships ORDER BY problem_id,fellow_id")
      .all(),
    integrity: f.sql.query("SELECT * FROM krater_integrity_backfill ORDER BY problem_id").all(),
    events: f.sql.query("SELECT * FROM events ORDER BY problem_id,seq").all(),
    briefs: f.sql.query("SELECT * FROM sponsor_problem_briefs ORDER BY id").all(),
  });
  return {
    ...f,
    propose,
    state,
    beforeCommit(hook: () => void | Promise<void>) {
      beforeBatch = hook;
    },
  };
}

for (const assigned of [FELLOW, null]) {
  test(`eligible ${assigned === null ? "unassigned" : "assigned"} sponsor brief creates one complete private draft`, async () => {
    const f = await fixture();
    f.sql
      .query("UPDATE sponsor_problem_briefs SET assigned_fellow_id=? WHERE id=?")
      .run(assigned, BRIEF);
    const response = await f.propose();
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const result = (await response.json()) as {
      problem: { id: string; status: string; public_seq: number };
    };
    expect(result.problem).toMatchObject({ status: "private-draft", public_seq: 0 });
    expect(f.sql.query("SELECT status FROM sponsor_problem_briefs WHERE id=?").get(BRIEF)).toEqual({
      status: "adopted",
    });
    expect(
      f.sql
        .query("SELECT statement FROM problem_statement_versions WHERE problem_id=?")
        .get(result.problem.id),
    ).toEqual({ statement: proposal.statement });
    expect(
      f.sql
        .query("SELECT fellow_id,role FROM problem_memberships WHERE problem_id=?")
        .get(result.problem.id),
    ).toEqual({ fellow_id: FELLOW, role: "contributor" });
    expect(f.state().events).toEqual([]);
    expect(f.sql.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });
}

for (const change of [
  {
    name: "withdrawal",
    sql: "UPDATE sponsor_problem_briefs SET status='withdrawn' WHERE id=?",
    values: [BRIEF],
    status: 404,
    code: "BRIEF_NOT_FOUND",
  },
  {
    name: "reassignment",
    sql: "UPDATE sponsor_problem_briefs SET assigned_fellow_id=? WHERE id=?",
    values: [OTHER, BRIEF],
    status: 403,
    code: "BRIEF_NOT_ASSIGNED",
  },
  {
    name: "ownership change",
    sql: "UPDATE sponsor_problem_briefs SET sponsor_id='usr_other' WHERE id=?",
    values: [BRIEF],
    status: 403,
    code: "BRIEF_NOT_ASSIGNED",
  },
  {
    name: "new scientific boundaries",
    sql: "UPDATE sponsor_problem_briefs SET scope='Finite trees',out_of_scope='Infinite trees',success_criteria='A proof or explicit counterexample' WHERE id=?",
    values: [BRIEF],
    status: 422,
    code: "STATEMENT_INCOMPLETE",
  },
]) {
  test(`brief ${change.name} after admission rolls back every proposal effect`, async () => {
    const f = await fixture();
    let committedState: ReturnType<typeof f.state> | undefined;
    f.beforeCommit(() => {
      f.sql.query(change.sql).run(...change.values);
      committedState = f.state();
    });
    const response = await f.propose();
    expect(response.status).toBe(change.status);
    expect(await response.json()).toMatchObject({ code: change.code });
    expect(committedState).toBeDefined();
    if (committedState === undefined) throw new Error("Concurrent brief change did not commit");
    expect(f.state()).toEqual(committedState);
    expect(f.sql.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });
}

test("two admissions of the same brief commit only the winning private problem", async () => {
  const f = await fixture();
  let winningState: ReturnType<typeof f.state> | undefined;
  let winnerId: string | undefined;
  f.beforeCommit(async () => {
    const winner = await f.propose({ ...proposal, title: "The winning formulation" });
    expect(winner.status).toBe(201);
    winnerId = ((await winner.json()) as { problem: { id: string } }).problem.id;
    winningState = f.state();
  });
  const loser = await f.propose();
  expect(loser.status).toBe(404);
  expect(await loser.json()).toMatchObject({ code: "BRIEF_NOT_FOUND" });
  expect(winnerId).toBeDefined();
  if (winningState === undefined) throw new Error("Winning brief adoption did not commit");
  expect(f.state()).toEqual(winningState);
  expect(
    f.sql.query("SELECT id,title FROM problems WHERE created_by_fellow_id=?").all(FELLOW),
  ).toEqual([{ id: winnerId, title: "The winning formulation" }]);
});

test("an unrelated storage failure is not misreported as lost brief authority", async () => {
  const f = await fixture();
  f.beforeCommit(() => {
    throw new Error("UNRELATED_STORAGE_FAILURE");
  });
  const before = f.state();
  const response = await f.propose();
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ code: "INTERNAL_ERROR" });
  expect(f.state()).toEqual(before);
});
