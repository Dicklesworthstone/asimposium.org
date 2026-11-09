import { afterEach, expect, test } from "bun:test";
import type { FellowCredentialBinding } from "../../src/enrollment/service.ts";
import { writeLedgerEvent } from "../../src/krater/krater.ts";
import { problemProposalFixture } from "../support/problem-proposal.ts";

type Fixture = Awaited<ReturnType<typeof problemProposalFixture>>;
const fixtures: Fixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.sql.close();
});

const BRIEF = "brief-admission-race";
const proposal = {
  brief_id: BRIEF,
  expected_brief_version: 1,
  title: "A finite tree investigation",
  statement: "Every finite tree has exactly one fewer edge than vertices.",
  falsifier: "A finite tree with a different edge count.",
  motivation: "Establish the invariant needed for the connected graph argument.",
  areas: ["combinatorics"],
};

async function fixture(options: Parameters<typeof problemProposalFixture>[0] = {}) {
  const f = await problemProposalFixture(options);
  fixtures.push(f);
  const now = Date.now();
  f.sql
    .query(`INSERT INTO sponsor_problem_briefs
      (id,sponsor_id,assigned_fellow_id,title,statement,falsifier,motivation,areas,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(
      BRIEF,
      f.principal.sponsorId,
      f.binding.fellowId,
      proposal.title,
      proposal.statement,
      proposal.falsifier,
      proposal.motivation,
      JSON.stringify(proposal.areas),
      new Date(now).toISOString(),
      new Date(now).toISOString(),
    );
  const propose = (body: object = proposal, key?: string | null) => f.propose(body, key);
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
    receipts: f.sql
      .query("SELECT * FROM problem_proposal_command_receipts ORDER BY fellow_id,key_digest")
      .all(),
  });
  return {
    ...f,
    propose,
    state,
  };
}

for (const assigned of [true, false]) {
  test(`eligible ${assigned ? "assigned" : "unassigned"} sponsor brief creates one complete private draft`, async () => {
    const f = await fixture();
    const originalEvents = f.state().events;
    f.sql
      .query("UPDATE sponsor_problem_briefs SET assigned_fellow_id=? WHERE id=?")
      .run(assigned ? f.binding.fellowId : null, BRIEF);
    const response = await f.propose();
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const result = (await response.json()) as {
      problem: { id: string; status: string; public_seq: number };
    };
    expect(result.problem).toMatchObject({ status: "private-draft", public_seq: 0 });
    expect(
      f.sql.query("SELECT status,version FROM sponsor_problem_briefs WHERE id=?").get(BRIEF),
    ).toEqual({
      status: "adopted",
      version: 2,
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
    ).toEqual({ fellow_id: f.binding.fellowId, role: "contributor" });
    expect(f.state().events).toEqual(originalEvents);
    expect(f.state().receipts).toHaveLength(1);
    expect(f.sql.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });
}

for (const change of [
  {
    name: "withdrawal",
    sql: "UPDATE sponsor_problem_briefs SET status='withdrawn' WHERE id=?",
    values: (_f: Fixture) => [BRIEF],
    status: 404,
    code: "BRIEF_NOT_FOUND",
  },
  {
    name: "reassignment",
    sql: "UPDATE sponsor_problem_briefs SET assigned_fellow_id=? WHERE id=?",
    values: (f: Fixture) => [f.peerBinding.fellowId, BRIEF],
    status: 403,
    code: "BRIEF_NOT_ASSIGNED",
  },
  {
    name: "ownership change",
    sql: "UPDATE sponsor_problem_briefs SET sponsor_id=? WHERE id=?",
    values: (f: Fixture) => [f.receiver.sponsorId, BRIEF],
    status: 403,
    code: "BRIEF_NOT_ASSIGNED",
  },
  {
    name: "new scientific boundaries",
    sql: "UPDATE sponsor_problem_briefs SET scope='Finite trees',out_of_scope='Infinite trees',success_criteria='A proof or explicit counterexample' WHERE id=?",
    values: (_f: Fixture) => [BRIEF],
    status: 422,
    code: "STATEMENT_INCOMPLETE",
  },
]) {
  test(`brief ${change.name} after admission rolls back every proposal effect`, async () => {
    const f = await fixture();
    let committedState: ReturnType<typeof f.state> | undefined;
    f.beforeCommit(() => {
      f.sql.query(change.sql).run(...change.values(f));
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
    f.sql
      .query("SELECT id,title FROM problems WHERE created_by_fellow_id=?")
      .all(f.binding.fellowId),
  ).toEqual([{ id: winnerId, title: "The winning formulation" }]);
});

test("an unrelated storage failure is not misreported as lost brief authority", async () => {
  const f = await fixture();
  f.beforeCommit(() => {
    throw new Error("UNRELATED_STORAGE_FAILURE");
  });
  const before = f.state();
  const response = await f.propose();
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: "INTERNAL_ERROR" });
  expect(f.state()).toEqual(before);
});

test("problem proposals enforce resource grants with the same coarse refusal and no draft effects", async () => {
  let refusal: unknown;
  for (const overrides of [
    { grantedScopes: [] },
    { grantedResources: { problemBinding: "P-DISCLOSE" } },
    { grantedResources: { eventBudget: 0 } },
    { grantedResources: { fellowGrantExpiresAt: Date.now() - 1 } },
  ] satisfies Partial<FellowCredentialBinding>[]) {
    const f = await fixture({ bindingOverride: overrides });
    const before = f.state();
    const response = await f.propose();
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body: unknown = await response.json();
    expect(body).toMatchObject({ code: "WRITE_REFUSED" });
    refusal ??= body;
    expect(body).toEqual(refusal);
    expect(f.state()).toEqual(before);
  }
});

test("an unbound Fellow with remaining event budget can still adopt its brief", async () => {
  const f = await fixture({ grants: { event_budget: 1 } });
  const originalEvents = f.state().events;
  expect((await f.propose()).status).toBe(201);
  expect(f.state().events).toEqual(originalEvents);
});

test("a credential with its positive event budget exhausted cannot adopt a brief", async () => {
  const f = await fixture({
    grants: { requested_scopes: ["propose-problems", "promote"], event_budget: 1 },
  });
  const credentialId = f.binding.credentialId;
  await writeLedgerEvent(
    f.baseDb,
    {
      problemId: f.target.problemId,
      eventId: "E-proposal-prior-work",
      idempotencyKey: "proposal-prior-work",
      requestDigest: "a".repeat(64),
      eventType: "hypothesis.created",
      objectKind: "hypothesis",
      objectId: "H-proposal-prior-work",
      objectVersion: 1,
      payloadJson: JSON.stringify({
        body_md: "Previously recorded work.",
        falsifier: "A counterexample.",
      }),
      createdAt: new Date().toISOString(),
      attribution: {
        fellowId: f.binding.fellowId,
        sponsorId: f.binding.sponsorId,
        credentialId,
        sessionId: "S-proposal-prior-work",
        modelSelfDeclared: f.binding.model,
        harness: f.binding.harness,
      },
    },
    { statementsAfterEvent: () => [] },
  );
  expect(
    f.sql
      .query("SELECT writer_credential_id FROM events WHERE writer_credential_id=?")
      .all(credentialId),
  ).toEqual([{ writer_credential_id: credentialId }]);

  const before = f.state();
  const response = await f.propose();
  expect(response.status).toBe(403);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toMatchObject({ code: "WRITE_REFUSED" });
  expect(f.state()).toEqual(before);
  expect(f.sql.query("PRAGMA foreign_key_check").all()).toEqual([]);
});
