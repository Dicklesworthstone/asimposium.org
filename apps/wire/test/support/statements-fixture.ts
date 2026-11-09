import type { ProblemLifecycleActionRequest } from "@asimposium/contracts";
import { createApp } from "../../src/app.ts";
import type { Env } from "../../src/env.ts";
import { applyPublicProblemGovernance } from "../../src/problems/lifecycle-ledger.ts";
import { readProblemPublicationPreview } from "../../src/problems/publication-preview.ts";
import { normHash } from "../../src/split/policy.ts";
import { FELLOW, PROBLEM, publicationContextFixture, SPONSOR } from "./publication-context.ts";

export { PROBLEM };
export const STATEMENT_BOUNDARIES = {
  scope: "  Finite labelled trees.\n",
  out_of_scope: "Infinite graphs and disconnected forests.",
  success_criteria: "An independently reviewable proof or an explicit finite counterexample.",
};
export const STATEMENT_TEXT = {
  statement: "Every finite tree has one fewer edge than vertices.",
  falsifier: "A finite tree with a different edge count.",
  motivation: "Establish a connected-graph invariant. <script>unsafe()</script>",
};

export async function statementsFixture() {
  const f = await publicationContextFixture();
  f.sql
    .query(
      `UPDATE problems SET status='private-draft',created_by_fellow_id=?,current_statement_version=2,areas='["combinatorics"]' WHERE id=?`,
    )
    .run(FELLOW, PROBLEM);
  f.sql
    .query(`INSERT INTO problem_statement_versions
    (problem_id,version,statement,norm_hash,falsifier,motivation,scope,out_of_scope,success_criteria,created_at)
    VALUES(?,2,?,?,?,?,?,?,?,?)`)
    .run(
      PROBLEM,
      STATEMENT_TEXT.statement,
      `sha256:${await normHash(STATEMENT_TEXT.statement)}`,
      STATEMENT_TEXT.falsifier,
      STATEMENT_TEXT.motivation,
      STATEMENT_BOUNDARIES.scope,
      STATEMENT_BOUNDARIES.out_of_scope,
      STATEMENT_BOUNDARIES.success_criteria,
      new Date().toISOString(),
    );
  let serial = 0;
  const govern = async (command: ProblemLifecycleActionRequest) => {
    const problem = await f.db
      .prepare("SELECT * FROM problems WHERE id=?")
      .bind(PROBLEM)
      .first<Parameters<typeof applyPublicProblemGovernance>[1]>();
    if (!problem) throw new Error("Missing statement fixture problem");
    const response = await applyPublicProblemGovernance(
      f.db,
      problem,
      SPONSOR,
      command,
      new Request(`https://a.asimposium.org/v1/sponsors/problems/${PROBLEM}/lifecycle`, {
        method: "POST",
        headers: { "idempotency-key": `statement-fixture-${++serial}` },
      }),
    );
    if (response.status !== 200)
      throw new Error(`Statement fixture governance: ${response.status} ${await response.text()}`);
    return response;
  };
  const preview = await readProblemPublicationPreview(f.db, PROBLEM, SPONSOR);
  if (!preview) throw new Error("Missing statement fixture preview");
  await govern({
    action: "publish",
    reviewed_statement_version: preview.problem.current_statement_version,
    reviewed_digest: preview.review_digest,
  });
  const revise = (scope: string) =>
    govern({ action: "revise-statement", ...STATEMENT_TEXT, ...STATEMENT_BOUNDARIES, scope });
  await revise("Finite rooted trees.");
  const app = createApp();
  return {
    ...f,
    govern,
    revise,
    read: (path: string, init?: RequestInit) =>
      app.fetch(new Request(`https://a.asimposium.org${path}`, init), { DB: f.db } as Env),
  };
}
