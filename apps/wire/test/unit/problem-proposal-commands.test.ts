import { afterEach, expect, test } from "bun:test";
import {
  ProposeProblemResponseSchema,
  SaveProblemBriefResponseSchema,
} from "@asimposium/contracts";
import type { D1PreparedStatement } from "@cloudflare/workers-types";
import { expireSecurityRecords, hardDeletePrivateDraft } from "../../src/krater/retention.ts";
import { runSponsorBriefCommand } from "../../src/problems/brief-commands.ts";
import { runProblemProposalCommand } from "../../src/problems/proposal-commands.ts";
import { problemProposalFixture } from "../support/problem-proposal.ts";

const fixtures: Awaited<ReturnType<typeof problemProposalFixture>>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.sql.close();
});
async function fixture() {
  const f = await problemProposalFixture();
  fixtures.push(f);
  return f;
}
const formulation = {
  title: "Private finite graph investigation",
  statement: "Every finite nonempty tree has one fewer edge than vertices.",
  falsifier: "A finite nonempty tree with a different edge count.",
  motivation: "PRIVATE-PROPOSAL-CANARY: establish the invariant for a later graph argument.",
  scope: "Finite nonempty simple undirected trees.",
  out_of_scope: "Infinite graphs, loops, and disconnected forests.",
  success_criteria: "A checkable argument or counterexample under the stated definitions.",
  areas: ["combinatorics"],
};
const drafts = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.sql.query("SELECT id FROM problems WHERE created_by_fellow_id=?").all(f.binding.fellowId);
async function saveBrief(f: Awaited<ReturnType<typeof fixture>>, version?: number) {
  const response = await runSponsorBriefCommand(
    f.baseDb,
    f.principal.sponsorId,
    `brief-${version ?? "create"}`,
    {
      operation: "save",
      request: {
        ...formulation,
        id: "brief-proposal-command",
        assigned_fellow_id: f.binding.fellowId,
        ...(version === undefined
          ? {}
          : {
              expected_version: version,
              motivation: "Reconsider this newly edited sponsor intent.",
            }),
      },
    },
  );
  expect(response.status).toBe(201);
  return SaveProblemBriefResponseSchema.parse(await response.json()).brief;
}

test("parallel same-key proposals elect one exact private draft and retain only command metadata", async () => {
  const f = await fixture();
  const responses = await Promise.all([
    f.propose(formulation, "parallel"),
    f.propose(formulation, "parallel"),
  ]);
  expect(responses.map((response) => response.status)).toEqual([201, 201]);
  const bodies = await Promise.all(
    responses.map(async (response) => ProposeProblemResponseSchema.parse(await response.json())),
  );
  expect(bodies[0]).toEqual(bodies[1]);
  const created = bodies[0];
  if (!created) throw new Error("Creation did not return a receipt.");
  expect(drafts(f)).toEqual([{ id: created.problem.id }]);
  expect(f.sql.query("SELECT id FROM events WHERE problem_id=?").all(created.problem.id)).toEqual(
    [],
  );
  expect(
    f.sql.query("SELECT public_seq,status FROM problems WHERE id=?").get(created.problem.id),
  ).toEqual({ public_seq: 0, status: "private-draft" });
  const receipts = f.sql.query("SELECT * FROM problem_proposal_command_receipts").all();
  expect(receipts).toHaveLength(1);
  for (const privateText of [formulation.statement, formulation.motivation, f.token, "parallel"])
    expect(JSON.stringify(receipts)).not.toContain(privateText);
  expect(f.sql.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("an accepted key cannot identify changed prose, and an ordinary new-key duplicate is still refused", async () => {
  const f = await fixture();
  const first = await f.propose(formulation, "accepted");
  expect(first.status).toBe(201);
  const accepted = await first.json();
  const different = await f.propose({ ...formulation, title: "A changed command" }, "accepted");
  expect(different.status).toBe(409);
  expect(await different.json()).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  const duplicate = await f.propose(formulation, "different-key");
  expect(duplicate.status).toBe(409);
  expect(await duplicate.json()).toMatchObject({ code: "POSSIBLE_DUPLICATE" });
  expect(await (await f.propose(formulation, "accepted")).json()).toEqual(accepted);
  expect(drafts(f)).toHaveLength(1);
});

test("a different command winning the same key rolls back every losing creation effect", async () => {
  const f = await fixture();
  let winner: unknown;
  f.beforeCommit(async () => {
    const response = await f.propose({ ...formulation, title: "Concurrent winner" }, "race");
    expect(response.status).toBe(201);
    winner = await response.json();
  });
  const losing = await f.propose(formulation, "race");
  expect(losing.status).toBe(409);
  expect(await losing.json()).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  expect(
    await (await f.propose({ ...formulation, title: "Concurrent winner" }, "race")).json(),
  ).toEqual(winner);
  expect(drafts(f)).toHaveLength(1);
  expect(f.sql.query("SELECT * FROM problem_proposal_command_receipts").all()).toHaveLength(1);
  expect(f.sql.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("committed creation recovers from a lost batch response, including a temporarily unreadable receipt", async () => {
  for (const loseRead of [false, true]) {
    const f = await fixture();
    let committed = false;
    const db = new Proxy(f.baseDb, {
      get(target, property) {
        if (property === "prepare")
          return (query: string) => {
            if (
              committed &&
              loseRead &&
              query.includes("FROM authority LEFT JOIN problem_proposal_command_receipts")
            )
              throw new Error("RECEIPT_TRANSPORT_UNAVAILABLE");
            return target.prepare(query);
          };
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) => {
            await target.batch(statements);
            committed = true;
            throw new Error("COMMITTED_BATCH_RESPONSE_LOST");
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const uncertain = await runProblemProposalCommand(db, f.binding, "lost-response", formulation);
    expect(uncertain.status).toBe(loseRead ? 503 : 201);
    const recovered = await f.propose(formulation, "lost-response");
    expect(recovered.status).toBe(201);
    if (!loseRead) expect(await recovered.json()).toEqual(await uncertain.json());
    else expect(await uncertain.json()).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(drafts(f)).toHaveLength(1);
  }
});

test("brief adoption pins the reviewed intent both before and inside the creation transaction", async () => {
  for (const race of [false, true]) {
    const f = await fixture();
    const initial = await saveBrief(f);
    if (race)
      f.beforeCommit(async () => {
        await saveBrief(f, initial.version);
      });
    else await saveBrief(f, initial.version);
    const stale = await f.propose(
      { ...formulation, brief_id: initial.id, expected_brief_version: initial.version },
      "stale-adoption",
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      code: "BRIEF_VERSION_CONFLICT",
      current_version: 2,
    });
    expect(drafts(f)).toEqual([]);
    expect(f.sql.query("SELECT * FROM problem_proposal_command_receipts").all()).toEqual([]);
    const current = {
      ...formulation,
      motivation: "I reconsidered the newly edited sponsor intent.",
      brief_id: initial.id,
      expected_brief_version: 2,
    };
    const accepted = await f.propose(current, "current-adoption");
    expect(accepted.status).toBe(201);
    const body = await accepted.json();
    expect(await (await f.propose(current, "current-adoption")).json()).toEqual(body);
    expect(
      f.sql.query("SELECT version,status FROM sponsor_problem_briefs WHERE id=?").get(initial.id),
    ).toEqual({ version: 3, status: "adopted" });
    expect(drafts(f)).toHaveLength(1);
  }
});

test("a revoked credential between admission and commit leaves neither draft nor receipt", async () => {
  const f = await fixture();
  f.beforeCommit(async () => {
    const revoked = await f.service.revokeCredential(
      f.principal,
      {
        fellow_id: f.binding.fellowId,
        credential_id: f.binding.credentialId,
        confirm: "revoke-credential",
        step_up_authenticated_at: Math.floor(Date.now() / 1000),
      },
      { idempotencyKey: "proposal-race-revoke" },
    );
    expect(revoked.acknowledged).toBe(true);
    expect(await f.service.credentialBinding(f.token)).toBeUndefined();
  });
  const response = await f.propose(formulation, "revoked-in-flight");
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: "WRITE_REFUSED" });
  expect(drafts(f)).toEqual([]);
  expect(f.sql.query("SELECT * FROM problem_proposal_command_receipts").all()).toEqual([]);
});

test("erasure keeps the command identity but never reconstructs erased private content", async () => {
  const f = await fixture();
  const accepted = await f.propose(formulation, "erased-draft");
  const { problem } = ProposeProblemResponseSchema.parse(await accepted.json());
  await hardDeletePrivateDraft(f.baseDb, problem.id, f.principal.sponsorId);
  const replay = await f.propose(formulation, "erased-draft");
  expect(replay.status).toBe(404);
  const body = await replay.text();
  expect(JSON.parse(body)).toMatchObject({ code: "PROBLEM_NOT_FOUND" });
  expect(body).not.toContain(formulation.statement);
  expect(
    f.sql.query("SELECT * FROM problem_statement_versions WHERE problem_id=?").all(problem.id),
  ).toEqual([]);
  expect(f.sql.query("SELECT problem_id FROM problem_proposal_command_receipts").all()).toEqual([
    { problem_id: problem.id },
  ]);
});

test("proposal replay metadata expires at 24 hours through the existing security sweep", async () => {
  const f = await fixture();
  const now = Date.now();
  expect(
    (await runProblemProposalCommand(f.baseDb, f.binding, "expiry", formulation, now)).status,
  ).toBe(201);
  expect(
    (await expireSecurityRecords(f.baseDb, { nowMs: now + 86_400_000 - 1 }))
      .expiredProblemProposalReceipts,
  ).toBe(0);
  expect(
    (await expireSecurityRecords(f.baseDb, { nowMs: now + 86_400_000 }))
      .expiredProblemProposalReceipts,
  ).toBe(1);
  expect(drafts(f)).toHaveLength(1);
});

test("missing or malformed keys and unpinned brief bodies produce no private draft", async () => {
  const f = await fixture();
  for (const key of [null, "", "with/slash", "a".repeat(161)]) {
    const response = await f.propose(formulation, key);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_INVALID" });
  }
  for (const patch of [{ brief_id: "brief-unpinned" }, { expected_brief_version: 1 }]) {
    const response = await f.propose({ ...formulation, ...patch });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "PROBLEM_PROPOSE_BODY_INVALID" });
  }
  expect(drafts(f)).toEqual([]);
});
