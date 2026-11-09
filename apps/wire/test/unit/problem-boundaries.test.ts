import { afterEach, expect, test } from "bun:test";
import {
  type ProblemLifecycleActionRequest,
  PublicLedgerProblemIdSchema,
} from "@asimposium/contracts";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { redactEventContent } from "../../src/krater/krater.ts";
import { diffProjections } from "../../src/krater/projection-replay.ts";
import { hardDeletePrivateDraft } from "../../src/krater/retention.ts";
import { applyPublicProblemGovernance } from "../../src/problems/lifecycle-ledger.ts";
import { readProblemPublicationPreview } from "../../src/problems/publication-preview.ts";
import { normHash } from "../../src/split/policy.ts";
import {
  FELLOW,
  PROBLEM,
  publicationContextFixture,
  SPONSOR,
} from "../support/publication-context.ts";
import {
  reviewedStatementRevisionFixture,
  submitStatementRevisionFixture,
} from "../support/statement-proposal.ts";

type Fixture = Awaited<ReturnType<typeof publicationContextFixture>>;
type Problem = Parameters<typeof applyPublicProblemGovernance>[1];
const fixtures: Fixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.sql.close();
});
const boundaries = {
  scope: "  Finite labelled trees.\n",
  out_of_scope: "Infinite graphs and disconnected forests.",
  success_criteria: "A reviewable proof or a counterexample with explicit edges.",
};
const formulation = {
  statement: "Every finite tree has one fewer edge than vertices.",
  falsifier: "A finite tree with a different edge count.",
  motivation: "Provide the invariant for the connected-graph argument.",
};
async function fixture() {
  const f = await publicationContextFixture();
  fixtures.push(f);
  f.sql
    .query(
      "UPDATE problems SET status='private-draft',created_by_fellow_id=?,current_statement_version=2,areas='[\"combinatorics\"]' WHERE id=?",
    )
    .run(FELLOW, PROBLEM);
  await version(f, 2, boundaries);
  return f;
}
async function version(f: Fixture, number: number, bundle: typeof boundaries) {
  f.sql
    .query(`INSERT INTO problem_statement_versions
    (problem_id,version,statement,norm_hash,falsifier,motivation,scope,out_of_scope,success_criteria,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(
      PROBLEM,
      number,
      formulation.statement,
      `sha256:${await normHash(formulation.statement)}`,
      formulation.falsifier,
      formulation.motivation,
      bundle.scope,
      bundle.out_of_scope,
      bundle.success_criteria,
      new Date().toISOString(),
    );
}
const problem = (f: Fixture) =>
  f.sql.query("SELECT * FROM problems WHERE id=?").get(PROBLEM) as Problem;
const apply = (f: Fixture, command: ProblemLifecycleActionRequest, key: string) =>
  applyPublicProblemGovernance(
    f.db,
    problem(f),
    SPONSOR,
    command,
    new Request(`https://a.asimposium.org/v1/sponsors/problems/${PROBLEM}/lifecycle`, {
      method: "POST",
      headers: { "idempotency-key": key },
    }),
  );
async function receiptFrom(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a governance receipt object");
  return value as Record<string, unknown>;
}
async function publish(f: Fixture) {
  const preview = await readProblemPublicationPreview(f.db, PROBLEM, SPONSOR);
  if (!preview) throw new Error("Expected a reviewable draft");
  expect(preview.problem).toMatchObject(boundaries);
  const response = await apply(
    f,
    {
      action: "publish",
      reviewed_statement_version: preview.problem.current_statement_version,
      reviewed_digest: preview.review_digest,
    },
    "boundary-publish",
  );
  expect(response.status).toBe(200);
  expect((await receiptFrom(response)).problem).toMatchObject(boundaries);
}

test("storage admits only complete bundles, preserves immutable bytes and permits lawful draft erasure", async () => {
  const f = await fixture();
  expect(() =>
    f.sql
      .query("UPDATE problem_statement_versions SET scope='changed' WHERE problem_id=?")
      .run(PROBLEM),
  ).toThrow("PROBLEM_STATEMENT_VERSION_IMMUTABLE");
  expect(() =>
    f.sql
      .query(`INSERT INTO problem_statement_versions
    (problem_id,version,statement,norm_hash,falsifier,motivation,scope,created_at)
    VALUES(?,3,'statement','hash','falsifier','motivation','only scope',?)`)
      .run(PROBLEM, new Date().toISOString()),
  ).toThrow("PROBLEM_BOUNDARY_BUNDLE_INCOMPLETE");
  expect(() =>
    f.sql
      .query(`INSERT INTO problem_statement_versions
    (problem_id,version,statement,norm_hash,falsifier,motivation,created_at)
    VALUES(?,3,'statement','hash','falsifier','motivation',?)`)
      .run(PROBLEM, new Date().toISOString()),
  ).toThrow("PROBLEM_BOUNDARIES_REQUIRED");
  const removed = await hardDeletePrivateDraft(f.db, PROBLEM, SPONSOR);
  expect(removed.receipt.targetId).toBe(PROBLEM);
  expect(
    f.sql
      .query("SELECT COUNT(*) AS n FROM problem_statement_versions WHERE problem_id=?")
      .get(PROBLEM),
  ).toEqual({ n: 0 });
});

test("publication review binds the complete boundary-bearing version", async () => {
  const f = await fixture();
  const preview = await readProblemPublicationPreview(f.db, PROBLEM, SPONSOR);
  if (!preview) throw new Error("Expected preview");
  await version(f, 3, { ...boundaries, scope: "Finite rooted trees." });
  f.sql.query("UPDATE problems SET current_statement_version=3 WHERE id=?").run(PROBLEM);
  const changed = await readProblemPublicationPreview(f.db, PROBLEM, SPONSOR);
  expect(changed?.review_digest).not.toBe(preview.review_digest);
  expect(
    (
      await apply(
        f,
        {
          action: "publish",
          reviewed_statement_version: 2,
          reviewed_digest: preview.review_digest,
        },
        "stale-boundaries",
      )
    ).status,
  ).toBe(409);
  expect(f.sql.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 });
});

test("boundary-only revision mints an immutable version and omission cannot erase recorded context", async () => {
  const f = await fixture();
  await publish(f);
  const before = problem(f);
  const omitted = await submitStatementRevisionFixture(
    f.db,
    SPONSOR,
    PROBLEM,
    formulation,
    "omit-boundaries",
  );
  expect(omitted.status).toBe(422);
  expect(await omitted.text()).toContain("success_criteria");
  expect(problem(f)).toEqual(before);
  const revised = {
    ...boundaries,
    success_criteria: "A proof covering the one-vertex tree as well.",
  };
  const command = await reviewedStatementRevisionFixture(
    f.db,
    SPONSOR,
    PROBLEM,
    { ...formulation, ...revised },
    "boundary-proposal",
  );
  const response = await apply(f, command, "revise-boundaries");
  expect(response.status).toBe(200);
  const receipt = await receiptFrom(response);
  expect(receipt.problem).toMatchObject({ current_statement_version: 3 });
  expect(
    f.sql
      .query(`SELECT scope,out_of_scope,success_criteria FROM problem_statement_versions
    WHERE problem_id=? AND version=3`)
      .get(PROBLEM),
  ).toEqual(revised);
  expect(problem(f).public_seq).toBe(before.public_seq + 1);
  expect(
    f.sql
      .query(
        "SELECT scope,out_of_scope,success_criteria FROM problem_statement_versions WHERE problem_id=? AND version=2",
      )
      .get(PROBLEM),
  ).toEqual(boundaries);
  expect(await (await apply(f, command, "revise-boundaries")).json()).toEqual(receipt);
  expect((await diffProjections(f.db, PROBLEM)).drift).toEqual([]);
});

test("forks inherit unchanged boundaries and require explicit ones for a changed formulation", async () => {
  const f = await fixture();
  await publish(f);
  const inherited = await apply(
    f,
    { action: "fork", title: "Independent tree investigation" },
    "inherit-boundaries",
  );
  expect(inherited.status).toBe(200);
  const child = PublicLedgerProblemIdSchema.parse((await receiptFrom(inherited)).forked_problem_id);
  expect(
    f.sql
      .query(
        "SELECT scope,out_of_scope,success_criteria FROM problem_statement_versions WHERE problem_id=?",
      )
      .get(child),
  ).toEqual(boundaries);
  const before = problem(f);
  expect(
    (
      await apply(
        f,
        {
          action: "fork",
          title: "A changed tree question",
          statement: "Every finite rooted tree has a unique root.",
        },
        "incomplete-fork",
      )
    ).status,
  ).toBe(422);
  expect(problem(f)).toEqual(before);
  const changed = { ...boundaries, scope: "Finite rooted trees with exactly one marked vertex." };
  const explicit = await apply(
    f,
    {
      action: "fork",
      title: "Rooted trees",
      statement: "Every finite rooted tree has a unique root.",
      ...changed,
    },
    "explicit-fork",
  );
  expect(explicit.status).toBe(200);
  const explicitChild = PublicLedgerProblemIdSchema.parse(
    (await receiptFrom(explicit)).forked_problem_id,
  );
  expect(
    f.sql
      .query(
        "SELECT scope,out_of_scope,success_criteria FROM problem_statement_versions WHERE problem_id=?",
      )
      .get(explicitChild),
  ).toEqual(changed);
});

test("ordinary governance cannot republish a withdrawn formulation from retained projection bytes", async () => {
  const f = await fixture();
  await publish(f);
  const command = { action: "set-writer-cap" as const, writer_cap: 3 };
  const committed = await apply(f, command, "committed-governance");
  expect(committed.status).toBe(200);
  const sealed = await receiptFrom(committed);
  expect(sealed.problem).toMatchObject(boundaries);
  const source = f.sql
    .query("SELECT id FROM events WHERE problem_id=? AND type='problem.admitted'")
    .get(PROBLEM) as { id: string };
  await redactEventContent(f.db, source.id, "privacy", new Date().toISOString());
  const before = problem(f);
  const response = await apply(
    f,
    { action: "set-writer-cap", writer_cap: 4 },
    "withdrawn-governance",
  );
  expect(response.status).toBe(409);
  const body = await response.text();
  for (const text of [...Object.values(boundaries), ...Object.values(formulation)])
    expect(body).not.toContain(text);
  const replay = await apply(f, command, "committed-governance");
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(sealed);
  expect(problem(f)).toEqual(before);
  expect(f.sql.query("SELECT COUNT(*) AS n FROM events WHERE problem_id=?").get(PROBLEM)).toEqual({
    n: 2,
  });
});

test("ordinary governance fences source availability at the actual event transaction", async () => {
  const f = await fixture();
  await publish(f);
  const source = f.sql
    .query("SELECT id FROM events WHERE problem_id=? AND type='problem.admitted'")
    .get(PROBLEM) as { id: string };
  let raced = false;
  const db = Object.assign(Object.create(f.db) as D1Database, {
    async batch<T = unknown>(statements: D1PreparedStatement[]) {
      if (
        !raced &&
        statements.some((statement) =>
          (statement as D1PreparedStatement & { text: string }).text.includes("INSERT INTO events"),
        )
      ) {
        raced = true;
        await redactEventContent(f.db, source.id, "privacy", new Date().toISOString());
      }
      return f.db.batch<T>(statements);
    },
  });
  const before = problem(f);
  const response = await applyPublicProblemGovernance(
    db,
    before,
    SPONSOR,
    { action: "set-writer-cap", writer_cap: 4 },
    new Request("https://a.asimposium.org/lifecycle", {
      method: "POST",
      headers: { "idempotency-key": "raced-withdrawal" },
    }),
  );
  expect(raced).toBe(true);
  expect(response.status).toBe(409);
  expect(problem(f)).toEqual(before);
  expect(f.sql.query("SELECT COUNT(*) AS n FROM events WHERE problem_id=?").get(PROBLEM)).toEqual({
    n: 1,
  });
});
