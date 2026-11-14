import { afterEach, expect, test } from "bun:test";
import {
  ProposeProblemResponseSchema,
  SaveProblemBriefResponseSchema,
} from "@asimposium/contracts";
import type { D1PreparedStatement } from "@cloudflare/workers-types";
import { redactEventContent } from "../../src/krater/krater.ts";
import { expireSecurityRecords, hardDeletePrivateDraft } from "../../src/krater/retention.ts";
import { PUBLIC_EVENT_CONTENT_MAX_BYTES } from "../../src/ledger/citation-read-integrity.ts";
import { applyOperatorControl } from "../../src/moderation/store.ts";
import { runSponsorBriefCommand } from "../../src/problems/brief-commands.ts";
import { getProblemCreationBudget } from "../../src/problems/creation-quota.ts";
import { applyPublicProblemGovernance } from "../../src/problems/lifecycle-ledger.ts";
import { runProblemProposalCommand } from "../../src/problems/proposal-commands.ts";
import { readProblemPublicationPreview } from "../../src/problems/publication-preview.ts";
import { normHash } from "../../src/split/policy.ts";
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
    expect(f.sql.query("SELECT * FROM problem_creation_admissions").all()).toEqual([]);
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
  expect(f.sql.query("SELECT * FROM problem_creation_admissions").all()).toEqual([]);
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

test("two creations are shared by a sponsor's Fellows; replays remain free and erasure cannot refund a slot", async () => {
  const f = await fixture();
  const grant = await f.service.mint(f.principal, { requested_scopes: ["propose-problems"] });
  const claimed = await f.service.claim({
    enrollment_id: grant.enrollmentId,
    secret: grant.secret,
    name: "second-proposer",
    model: "test/second-proposer",
    harness: "curl",
  });
  await f.service.decide(f.principal, grant.enrollmentId, {
    enrollment_id: grant.enrollmentId,
    decision: "approve",
    step_up_authenticated_at: Math.floor(Date.now() / 1000),
  });
  const issued = await f.service.poll({ flow_handle: claimed.flowHandle });
  if (!("token" in issued)) throw new Error("Second proposer was not legally enrolled.");

  const first = await f.propose(formulation, "quota-first");
  expect(first.status).toBe(201);
  const firstBody = ProposeProblemResponseSchema.parse(await first.json());
  expect(await getProblemCreationBudget(f.baseDb, f.principal.sponsorId)).toEqual({
    limit: 2,
    remaining: 1,
    window_seconds: 86_400,
  });
  const second = await f.propose(
    {
      ...formulation,
      title: "Independent second proposal",
      statement: "Every finite simple cycle has equally many edges and vertices.",
    },
    "quota-second",
    issued.token,
  );
  expect(second.status).toBe(201);
  expect(await (await f.propose(formulation, "quota-first")).json()).toEqual(firstBody);

  await hardDeletePrivateDraft(f.baseDb, firstBody.problem.id, f.principal.sponsorId);
  const refused = await f.propose(
    {
      ...formulation,
      title: "No replacement slot after erasure",
      statement: "Each vertex of a finite rooted tree has a unique simple path to its root.",
    },
    "quota-third",
  );
  expect(refused.status).toBe(429);
  expect(refused.headers.get("cache-control")).toBe("private, no-store");
  expect(refused.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(refused.headers.get("ratelimit-limit")).toBe("2");
  expect(refused.headers.get("ratelimit-remaining")).toBe("0");
  expect(await refused.json()).toMatchObject({
    code: "RATE_LIMITED",
    limit: 2,
    remaining: 0,
    window_seconds: 86_400,
  });
  expect(f.sql.query("SELECT COUNT(*) AS n FROM problem_creation_admissions").get()).toEqual({
    n: 2,
  });
  expect(f.sql.query("SELECT * FROM problem_proposal_command_receipts").all()).toHaveLength(2);
  expect((await f.propose(formulation, "quota-first")).status).toBe(404);
  expect(await getProblemCreationBudget(f.baseDb, f.receiver.sponsorId)).toEqual({
    limit: 2,
    remaining: 2,
    window_seconds: 86_400,
  });
});

test("a concurrent final-slot winner rolls back the losing proposal and leaves its brief unadopted", async () => {
  const f = await fixture();
  const first = await f.propose(
    {
      ...formulation,
      title: "First slot",
      statement: "Every finite simple path has one fewer edge than vertices.",
    },
    "slot-first",
  );
  expect(first.status).toBe(201);
  const brief = await saveBrief(f);
  const beforeBrief = f.sql.query("SELECT * FROM sponsor_problem_briefs WHERE id=?").get(brief.id);
  let winnerId: string | undefined;
  f.beforeCommit(async () => {
    const winner = await f.propose(
      {
        ...formulation,
        title: "Concurrent final slot",
        statement: "Every finite simple cycle has equally many edges and vertices.",
      },
      "slot-winner",
    );
    expect(winner.status).toBe(201);
    winnerId = ProposeProblemResponseSchema.parse(await winner.json()).problem.id;
  });
  const loser = await f.propose(
    { ...formulation, brief_id: brief.id, expected_brief_version: brief.version },
    "slot-loser",
  );
  expect(loser.status).toBe(429);
  expect(await loser.json()).toMatchObject({ code: "RATE_LIMITED", remaining: 0 });
  expect(winnerId).toBeDefined();
  expect(drafts(f)).toHaveLength(2);
  expect(f.sql.query("SELECT * FROM sponsor_problem_briefs WHERE id=?").get(brief.id)).toEqual(
    beforeBrief,
  );
  expect(f.sql.query("SELECT * FROM problem_proposal_command_receipts").all()).toHaveLength(2);
  expect(f.sql.query("SELECT * FROM problem_creation_admissions").all()).toHaveLength(2);
  expect(f.sql.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("rolling capacity recovers exactly at expiry and backwards clocks remain conservative", async () => {
  const f = await fixture();
  const now = Date.now();
  for (const [offset, key] of [
    [0, "window-first"],
    [1_100, "window-second"],
  ] as const) {
    expect(
      (
        await runProblemProposalCommand(
          f.baseDb,
          f.binding,
          key,
          {
            ...formulation,
            title: key,
            statement:
              offset === 0
                ? formulation.statement
                : "Every finite simple cycle has equally many edges and vertices.",
          },
          now + offset,
        )
      ).status,
    ).toBe(201);
  }
  expect(
    await getProblemCreationBudget(f.baseDb, f.principal.sponsorId, now - 1_000),
  ).toMatchObject({ remaining: 0, retry_after_seconds: 86_401 });
  expect(
    await getProblemCreationBudget(f.baseDb, f.principal.sponsorId, now + 86_400_000 - 1),
  ).toMatchObject({ remaining: 0, retry_after_seconds: 1 });
  expect(await getProblemCreationBudget(f.baseDb, f.principal.sponsorId, now + 86_400_000)).toEqual(
    { limit: 2, remaining: 1, window_seconds: 86_400 },
  );
  expect(await getProblemCreationBudget(f.baseDb, f.principal.sponsorId, now + 86_401_100)).toEqual(
    { limit: 2, remaining: 2, window_seconds: 86_400 },
  );
});

test("an unreadable creation allowance fails closed without writing a draft", async () => {
  const f = await fixture();
  const db = new Proxy(f.baseDb, {
    get(target, property) {
      if (property === "prepare")
        return (query: string) => {
          if (query.includes("FROM problem_creation_admissions"))
            throw new Error("QUOTA_READ_TRANSPORT_UNAVAILABLE");
          return target.prepare(query);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const response = await runProblemProposalCommand(
    db,
    f.binding,
    "quota-read-failure",
    formulation,
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: "INTERNAL_ERROR" });
  expect(drafts(f)).toEqual([]);
  expect(f.sql.query("SELECT * FROM problem_creation_admissions").all()).toEqual([]);
  expect(f.sql.query("SELECT * FROM problem_proposal_command_receipts").all()).toEqual([]);
});

async function publishedDuplicateSource(f: Awaited<ReturnType<typeof fixture>>) {
  const response = await f.propose({ ...formulation, unlisted: true }, "duplicate-source");
  expect(response.status).toBe(201);
  const problemId = ProposeProblemResponseSchema.parse(await response.json()).problem.id;
  const preview = await readProblemPublicationPreview(f.baseDb, problemId, f.principal.sponsorId);
  const problem = await f.baseDb
    .prepare("SELECT * FROM problems WHERE id=?")
    .bind(problemId)
    .first<Parameters<typeof applyPublicProblemGovernance>[1]>();
  if (!preview || !problem) throw new Error("Duplicate fixture publication is unavailable.");
  const published = await applyPublicProblemGovernance(
    f.baseDb,
    problem,
    f.principal.sponsorId,
    {
      action: "publish",
      reviewed_statement_version: preview.problem.current_statement_version,
      reviewed_digest: preview.review_digest,
    },
    new Request("https://a.asimposium.org/v1/sponsors/problems/" + problemId + "/lifecycle", {
      method: "POST",
      headers: { "idempotency-key": "duplicate-source-publish" },
    }),
  );
  expect(published.status).toBe(200);
  const event = await f.baseDb
    .prepare(
      "SELECT id,seq,object_version FROM events WHERE problem_id=? AND type='problem.admitted'",
    )
    .bind(problemId)
    .first<{ id: string; seq: number; object_version: number }>();
  if (!event) throw new Error("Duplicate fixture has no publication event.");
  return { problemId, ...event };
}

async function foreignProposalToken(f: Awaited<ReturnType<typeof fixture>>) {
  const grant = await f.service.mint(f.receiver, { requested_scopes: ["propose-problems"] });
  const claimed = await f.service.claim({
    enrollment_id: grant.enrollmentId,
    secret: grant.secret,
    name: "foreign-duplicate-proposer",
    model: "test/foreign-duplicate-proposer",
    harness: "curl",
  });
  await f.service.decide(f.receiver, grant.enrollmentId, {
    enrollment_id: grant.enrollmentId,
    decision: "approve",
    step_up_authenticated_at: Math.floor(Date.now() / 1000),
  });
  const issued = await f.service.poll({ flow_handle: claimed.flowHandle });
  if (!("token" in issued)) throw new Error("Foreign duplicate proposer has no credential.");
  return issued.token;
}

for (const target of ["problem", "object", "version", "event"] as const) {
  test("duplicate feedback respects current " + target + " controls and restoration", async () => {
    const f = await fixture();
    const source = await publishedDuplicateSource(f);
    const token = await foreignProposalToken(f);
    const targetRef =
      target === "problem"
        ? "problem"
        : target === "object"
          ? source.problemId
          : target === "version"
            ? source.problemId + "@" + source.object_version
            : "#" + source.seq;
    const control = (visibility: "hidden" | "visible") =>
      applyOperatorControl(f.baseDb, "usr_duplicate_operator", {
        problemId: source.problemId,
        targetKind: "problem",
        targetRef,
        visibility,
        reason: "Review the exact duplicate-source publication.",
      });
    expect((await control("hidden")).ok).toBe(true);
    expect((await control("visible")).ok).toBe(true);
    const restored = await f.propose(formulation, "restored-source", token);
    expect(restored.status).toBe(409);
    expect(await restored.json()).toMatchObject({
      code: "POSSIBLE_DUPLICATE",
      existing_problem_id: source.problemId,
    });
    expect((await control("hidden")).ok).toBe(true);
    const fresh = await f.propose(formulation, "hidden-source", token);
    expect(fresh.status).toBe(201);
    const body = ProposeProblemResponseSchema.parse(await fresh.json());
    expect(body.problem.id).not.toBe(source.problemId);
    expect(JSON.stringify(body)).not.toContain(source.problemId);
    expect(
      f.sql
        .query("SELECT * FROM problem_creation_admissions WHERE sponsor_id=?")
        .all(f.receiver.sponsorId),
    ).toHaveLength(1);
  });
}

for (const unavailable of ["redacted", "corrupt-bytes", "wrong-digest", "oversize"] as const) {
  test("duplicate feedback ignores " + unavailable + " publication content", async () => {
    const f = await fixture();
    const source = await publishedDuplicateSource(f);
    const token = await foreignProposalToken(f);
    if (unavailable === "redacted") {
      await redactEventContent(f.baseDb, source.id, "privacy", new Date().toISOString());
    } else {
      // Fault injection only: production storage rejects these mutations.
      // The retained statement and immutable event must never substitute for
      // unavailable or unverified publication bytes.
      f.sql.exec("DROP TRIGGER event_content_lawful_redaction_only");
      if (unavailable === "wrong-digest")
        f.sql
          .query("UPDATE event_content SET payload_sha256=? WHERE event_id=?")
          .run("0".repeat(64), source.id);
      else
        f.sql
          .query("UPDATE event_content SET payload_json=? WHERE event_id=?")
          .run(
            unavailable === "oversize"
              ? "X".repeat(PUBLIC_EVENT_CONTENT_MAX_BYTES + 1)
              : '{"corrupt":true}',
            source.id,
          );
    }
    const fresh = await f.propose(formulation, "unavailable-source", token);
    expect(fresh.status).toBe(201);
    const body = ProposeProblemResponseSchema.parse(await fresh.json());
    expect(body.problem.id).not.toBe(source.problemId);
    expect(JSON.stringify(body)).not.toContain(source.problemId);
  });
}

test("a retained projection hash cannot manufacture a public statement match", async () => {
  const f = await fixture();
  const source = await publishedDuplicateSource(f);
  const token = await foreignProposalToken(f);
  const different = {
    ...formulation,
    statement: "Every finite cycle has equally many edges and vertices.",
  };
  // Fault injection only: the immutable publication still contains the tree
  // statement, so a forged candidate hash cannot authorize duplicate feedback.
  f.sql.exec("DROP TRIGGER problem_statement_versions_immutable_update");
  f.sql
    .query("UPDATE problem_statement_versions SET norm_hash=? WHERE problem_id=?")
    .run("sha256:" + (await normHash(different.statement)), source.problemId);
  const fresh = await f.propose(different, "forged-source-hash", token);
  expect(fresh.status).toBe(201);
  expect(ProposeProblemResponseSchema.parse(await fresh.json()).problem.id).not.toBe(
    source.problemId,
  );
});

test("a source hidden after candidate selection cannot appear in duplicate feedback", async () => {
  const f = await fixture();
  const source = await publishedDuplicateSource(f);
  let hidden = false;
  const db = new Proxy(f.baseDb, {
    get(target, property) {
      if (property === "prepare")
        return (query: string) => {
          const statement = target.prepare(query);
          if (!query.includes("AND e.id > ?")) return statement;
          const wrapped: D1PreparedStatement = new Proxy(statement, {
            get(prepared, method) {
              if (method === "bind")
                return (...values: unknown[]) => {
                  prepared.bind(...values);
                  return wrapped;
                };
              if (method === "all")
                return async () => {
                  const result = await prepared.all();
                  if (!hidden) {
                    hidden = true;
                    const changed = await applyOperatorControl(f.baseDb, "usr_duplicate_operator", {
                      problemId: source.problemId,
                      targetKind: "problem",
                      targetRef: "#" + source.seq,
                      visibility: "hidden",
                      reason: "Withdraw the source while duplicate verification is in flight.",
                    });
                    expect(changed.ok).toBe(true);
                  }
                  return result;
                };
              const value = Reflect.get(prepared, method);
              return typeof value === "function" ? value.bind(prepared) : value;
            },
          });
          return wrapped;
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const fresh = await runProblemProposalCommand(
    db,
    f.binding,
    "hide-during-verification",
    formulation,
  );
  expect(hidden).toBe(true);
  expect(fresh.status).toBe(201);
  expect(ProposeProblemResponseSchema.parse(await fresh.json()).problem.id).not.toBe(
    source.problemId,
  );
});
