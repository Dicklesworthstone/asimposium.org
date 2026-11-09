import type { ProblemLifecycleActionRequest } from "@asimposium/contracts";
import { createApp } from "../../src/app.ts";
import { D1EnrollmentStore } from "../../src/enrollment/d1-store.ts";
import {
  EnrollmentService,
  enrollmentReplayProtectorFromBase64Url,
} from "../../src/enrollment/service.ts";
import type { Env } from "../../src/env.ts";
import { applyPublicProblemGovernance } from "../../src/problems/lifecycle-ledger.ts";
import { readProblemPublicationPreview } from "../../src/problems/publication-preview.ts";
import {
  loadStatementRevisionSnapshot,
  submitStatementProposal,
} from "../../src/problems/statement-revision-proposals.ts";
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
  const service = new EnrollmentService({
    stoaOrigin: "https://a.asimposium.org",
    agoraOrigin: "https://asimposium.org",
    store: new D1EnrollmentStore(f.db),
    replayProtector: enrollmentReplayProtectorFromBase64Url(
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ),
  });
  const principal = { type: "sponsor" as const, sponsorId: SPONSOR };
  const grant = await service.mint(principal, { requested_scopes: ["promote"] });
  const claimed = await service.claim({
    enrollment_id: grant.enrollmentId,
    secret: grant.secret,
    name: "statement-revision-author",
    model: "model",
    harness: "harness",
  });
  await service.decide(principal, grant.enrollmentId, {
    enrollment_id: grant.enrollmentId,
    decision: "approve",
    step_up_authenticated_at: Math.floor(Date.now() / 1000),
  });
  const issued = await service.poll({ flow_handle: claimed.flowHandle });
  if (!("token" in issued)) throw new Error("Statement fixture credential not issued");
  const binding = await service.credentialBinding(issued.token);
  if (!binding) throw new Error("Statement fixture credential unavailable");
  const sessionId = `S-${"P".repeat(26)}`,
    sessionAt = new Date().toISOString();
  f.sql
    .query(`INSERT INTO sessions(session_id,fellow_id,problem_id,opened_at,last_heartbeat_at,idle_close_at)
    VALUES(?,?,?,?,?,?)`)
    .run(
      sessionId,
      binding.fellowId,
      PROBLEM,
      sessionAt,
      sessionAt,
      new Date(Date.now() + 3600000).toISOString(),
    );
  f.sql
    .query(
      "INSERT INTO problem_memberships(problem_id,fellow_id,role,joined_at) VALUES(?,?,'contributor',?)",
    )
    .run(PROBLEM, binding.fellowId, sessionAt);
  const revise = async (scope: string) => {
    const base = f.sql
      .query("SELECT current_statement_version FROM problems WHERE id=?")
      .get(PROBLEM) as { current_statement_version: number };
    const proposed = await submitStatementProposal(
      f.db,
      binding,
      PROBLEM,
      {
        session_id: sessionId,
        base_statement_version: base.current_statement_version,
        ...STATEMENT_TEXT,
        ...STATEMENT_BOUNDARIES,
        scope,
      },
      `fixture-proposal-${++serial}`,
    );
    if (proposed.status !== 201)
      throw new Error(`Statement fixture proposal: ${proposed.status} ${await proposed.text()}`);
    const proposal = (await proposed.json()) as { proposal: { proposal_id: string } };
    const reviewed = await loadStatementRevisionSnapshot(
      f.db,
      PROBLEM,
      proposal.proposal.proposal_id,
      SPONSOR,
    );
    if (!reviewed) throw new Error("Statement fixture revision preview unavailable");
    return govern({
      action: "revise-statement",
      proposal_id: proposal.proposal.proposal_id,
      reviewed_statement_version: base.current_statement_version,
      reviewed_digest: reviewed.preview.review_digest,
    });
  };
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
