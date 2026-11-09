import { afterEach, expect, test } from "bun:test";
import {
  ProblemGovernanceEventSchema,
  ProblemLifecycleActionRequestSchema,
  type ProblemStatementProposalRequest,
  ProblemStatementProposalSchema,
  ProblemStatementRevisionPreviewSchema,
} from "@asimposium/contracts";
import { hardDeletePrivateDraft } from "../../src/krater/retention.ts";
import { readPublishedProblemFormulation } from "../../src/ledger/problem-formulation-read.ts";
import { applyPrivateProblemAccessAction } from "../../src/problems/access-actions.ts";
import { applyPublicProblemGovernance } from "../../src/problems/lifecycle-ledger.ts";
import { readProblemPublicationPreview } from "../../src/problems/publication-preview.ts";
import {
  acceptPrivateStatementProposal,
  listStatementProposals,
  loadStatementRevisionSnapshot,
  readOwnStatementProposal,
  replayPrivateStatementAcceptance,
  submitStatementProposal,
} from "../../src/problems/statement-revision-proposals.ts";
import { problemProposalFixture } from "../support/problem-proposal.ts";
import { statementRevisionSourceFixture } from "../support/statement-proposal.ts";

const fixtures: Awaited<ReturnType<typeof problemProposalFixture>>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.sql.close();
});
const initial = {
  title: "Exact finite tree invariant",
  statement: "Every finite nonempty tree has one fewer edge than vertices.",
  falsifier: "An in-scope finite tree with a different count.",
  motivation: "State an exact graph invariant.",
  scope: "Finite undirected simple trees.",
  out_of_scope: "Infinite graphs and disconnected forests.",
  success_criteria: "A checkable proof or finite counterexample.",
  areas: ["combinatorics"],
};
async function fixture(published = false) {
  const f = await problemProposalFixture({
    grants: { requested_scopes: ["propose-problems", "promote", "review"] },
  });
  fixtures.push(f);
  const created = (await (await f.propose(initial)).json()) as { problem: { id: string } };
  const id = created.problem.id;
  const sessionId = `S-${"R".repeat(26)}`;
  const now = new Date().toISOString();
  f.sql
    .query(`INSERT INTO sessions(session_id,fellow_id,problem_id,opened_at,last_heartbeat_at,idle_close_at)
    VALUES(?,?,?,?,?,?)`)
    .run(sessionId, f.binding.fellowId, id, now, now, new Date(Date.now() + 3600000).toISOString());
  const head = () =>
    f.sql.query("SELECT * FROM problems WHERE id=?").get(id) as Parameters<
      typeof applyPublicProblemGovernance
    >[1];
  const publish = async (key = "publish") => {
    const preview = await readProblemPublicationPreview(f.db, id, f.principal.sponsorId);
    if (!preview) throw new Error("Expected a publication preview");
    return applyPublicProblemGovernance(
      f.db,
      head(),
      f.principal.sponsorId,
      {
        action: "publish",
        reviewed_statement_version: preview.problem.current_statement_version,
        reviewed_digest: preview.review_digest,
      },
      new Request("https://a.asimposium.org/lifecycle", { headers: { "Idempotency-Key": key } }),
    );
  };
  if (published) expect((await publish()).status).toBe(200);
  const body: ProblemStatementProposalRequest = {
    session_id: sessionId,
    base_statement_version: 1,
    statement: "Every finite rooted tree has one fewer edge than vertices.",
    falsifier: "An explicit finite rooted tree with another count.",
    motivation: "PRIVATE_STATEMENT_PROPOSAL_CANARY: make the root convention explicit.",
    scope: "Finite rooted undirected simple trees.",
    out_of_scope: initial.out_of_scope,
    success_criteria: initial.success_criteria,
  };
  const submit = (request = body, key = "proposal") =>
    submitStatementProposal(f.db, f.binding, id, request, key);
  const propose = async () => {
    const response = await submit();
    expect(response.status).toBe(201);
    return ((await response.json()) as { proposal: { proposal_id: string } }).proposal.proposal_id;
  };
  const review = async (proposalId: string) => {
    const snapshot = await loadStatementRevisionSnapshot(
      f.db,
      id,
      proposalId,
      f.principal.sponsorId,
    );
    if (!snapshot) throw new Error("Expected exact proposal preview");
    return {
      action: "revise-statement" as const,
      proposal_id: proposalId,
      reviewed_statement_version: snapshot.preview.proposal.base_statement_version,
      reviewed_digest: snapshot.preview.review_digest,
    };
  };
  const accept = async (action: Awaited<ReturnType<typeof review>>, key = "accept") =>
    published
      ? applyPublicProblemGovernance(
          f.db,
          head(),
          f.principal.sponsorId,
          action,
          new Request("https://a.asimposium.org/lifecycle", {
            headers: { "Idempotency-Key": key },
          }),
        )
      : acceptPrivateStatementProposal(f.db, id, f.principal.sponsorId, action, key);
  return { ...f, id, sessionId, head, publish, body, submit, propose, review, accept };
}

test("a Fellow hands off immutable private formulation with exact replay and no public effect", async () => {
  const f = await fixture(true),
    before = f.head().public_seq;
  const [one, two] = await Promise.all([f.submit(), f.submit()]);
  expect([one.status, two.status]).toEqual([201, 201]);
  const first = await one.json();
  expect(await two.json()).toEqual(first);
  const proposal = (first as { proposal: { proposal_id: string } }).proposal.proposal_id;
  expect(f.head().public_seq).toBe(before);
  expect(
    f.sql
      .query("SELECT COUNT(*) AS n FROM problem_statement_proposals WHERE problem_id=?")
      .get(f.id),
  ).toEqual({ n: 1 });
  expect(JSON.stringify(f.sql.query("SELECT payload_json FROM event_content").all())).not.toContain(
    f.body.motivation,
  );
  expect(
    JSON.stringify(f.sql.query("SELECT * FROM problem_statement_proposal_receipts").all()),
  ).not.toContain(f.body.motivation);
  expect((await f.submit({ ...f.body, statement: "Changed prose." })).status).toBe(409);
  expect((await readOwnStatementProposal(f.db, f.peerBinding, f.id, proposal)).status).toBe(404);
  expect((await listStatementProposals(f.db, f.id, "usr_wrong_sponsor")).status).toBe(404);
  expect(() =>
    f.sql
      .query("UPDATE problem_statement_proposals SET payload_json='{}' WHERE proposal_id=?")
      .run(proposal),
  ).toThrow();
});

test("public acceptance carries the Fellow tuple and replays without duplicate effects after later state changes", async () => {
  const f = await fixture(true),
    proposal = await f.propose(),
    action = await f.review(proposal),
    before = f.head().public_seq;
  const [one, two] = await Promise.all([f.accept(action), f.accept(action)]);
  expect([one.status, two.status]).toEqual([200, 200]);
  const response = await one.json();
  expect(await two.json()).toEqual(response);
  expect(f.head().current_statement_version).toBe(2);
  expect(f.head().public_seq).toBe(before + 1);
  const source = await readPublishedProblemFormulation(f.db, f.id, f.head().public_seq);
  expect(source?.scientific_author).toEqual({
    fellow_id: f.binding.fellowId,
    sponsor_id: f.binding.sponsorId,
    session_id: f.sessionId,
    model_self_declared: f.binding.model,
    harness: f.binding.harness,
  });
  expect(source?.source_sponsor_id).toBe(f.binding.sponsorId);
  expect(() =>
    f.sql
      .query(
        "UPDATE problem_statement_versions SET scientific_author_json='{}' WHERE problem_id=? AND version=2",
      )
      .run(f.id),
  ).toThrow("PROBLEM_STATEMENT_VERSION_IMMUTABLE");
  expect(
    f.sql
      .query(
        "SELECT caused_by_event_id FROM fellow_inbox_notices WHERE problem_id=? AND notice_type='statement_revision'",
      )
      .all(f.id),
  ).toEqual([{ caused_by_event_id: source?.publication.event_id }]);
  f.sql
    .query("UPDATE sessions SET closed_at=? WHERE session_id=?")
    .run(new Date().toISOString(), f.sessionId);
  expect(
    (
      await applyPublicProblemGovernance(
        f.db,
        f.head(),
        f.principal.sponsorId,
        { action: "set-writer-cap", writer_cap: 3 },
        new Request("https://a.asimposium.org/lifecycle", {
          headers: { "Idempotency-Key": "later-governance" },
        }),
      )
    ).status,
  ).toBe(200);
  expect(await (await f.accept(action)).json()).toEqual(response);
  expect((await f.accept({ ...action, reviewed_digest: "0".repeat(64) })).status).toBe(409);
  expect((await f.accept(action, "new-key")).status).toBe(409);
  expect((await f.submit()).status).toBe(201);
});

test("a source revocation between reviewed snapshot and commit publishes nothing", async () => {
  const f = await fixture(true),
    proposal = await f.propose(),
    action = await f.review(proposal),
    before = f.head().public_seq;
  f.beforeCommit(async () => {
    await f.service.transitionFellow(
      f.principal,
      {
        fellow_id: f.binding.fellowId,
        status: "paused",
        confirm: "change-fellow-lifecycle",
        step_up_authenticated_at: Math.floor(Date.now() / 1000),
      },
      { idempotencyKey: "source-pause-race" },
    );
  });
  expect((await f.accept(action)).status).toBe(409);
  expect(f.head().public_seq).toBe(before);
  expect(f.head().current_statement_version).toBe(1);
  expect(
    f.sql
      .query("SELECT accepted_at FROM problem_statement_proposals WHERE proposal_id=?")
      .get(proposal),
  ).toEqual({ accepted_at: null });
  expect(
    f.sql
      .query("SELECT COUNT(*) AS n FROM problem_statement_versions WHERE problem_id=?")
      .get(f.id),
  ).toEqual({ n: 1 });
});

test("late credential expiry and same-key conflicts cannot leave orphaned proposals", async () => {
  const f = await fixture(true);
  f.beforeCommit(async () => {
    await f.service.revokeCredential(
      f.principal,
      {
        fellow_id: f.binding.fellowId,
        credential_id: f.binding.credentialId,
        confirm: "revoke-credential",
        step_up_authenticated_at: Math.floor(Date.now() / 1000),
      },
      { idempotencyKey: "source-credential-race" },
    );
  });
  expect((await f.submit()).status).toBe(409);
  expect(
    f.sql
      .query("SELECT COUNT(*) AS n FROM problem_statement_proposals WHERE problem_id=?")
      .get(f.id),
  ).toEqual({ n: 0 });
  expect(
    f.sql
      .query("SELECT COUNT(*) AS n FROM problem_statement_proposal_receipts WHERE problem_id=?")
      .get(f.id),
  ).toEqual({ n: 0 });
});

test("private acceptance survives publication as exact provenance without changing its original receipt", async () => {
  const f = await fixture();
  const actualAuthor = await statementRevisionSourceFixture(f.db, f.principal.sponsorId, f.id);
  const submitted = await submitStatementProposal(
    f.db,
    actualAuthor.binding,
    f.id,
    { ...f.body, session_id: actualAuthor.sessionId },
    "distinct-source-author",
  );
  expect(submitted.status).toBe(201);
  const proposal = ((await submitted.json()) as { proposal: { proposal_id: string } }).proposal
    .proposal_id;
  const action = await f.review(proposal);
  const accepted = await f.accept(action);
  expect(accepted.status).toBe(200);
  const body = await accepted.json();
  expect(f.head().public_seq).toBe(0);
  const preview = await readProblemPublicationPreview(f.db, f.id, f.principal.sponsorId);
  expect(preview?.scientific_author?.session_id).toBe(actualAuthor.sessionId);
  expect(preview?.author.fellow_id).toBe(actualAuthor.binding.fellowId);
  expect((await f.publish()).status).toBe(200);
  const source = await readPublishedProblemFormulation(f.db, f.id, f.head().public_seq);
  expect(source?.scientific_author?.session_id).toBe(actualAuthor.sessionId);
  expect(source?.source_fellow_id).toBe(actualAuthor.binding.fellowId);
  expect(
    (
      await applyPublicProblemGovernance(
        f.db,
        f.head(),
        f.principal.sponsorId,
        { action: "set-writer-cap", writer_cap: 3 },
        new Request("https://a.asimposium.org/lifecycle", {
          headers: { "Idempotency-Key": "govern-revised-formulation" },
        }),
      )
    ).status,
  ).toBe(200);
  const later = f.sql
    .query(`SELECT c.payload_json FROM event_content c JOIN events e ON e.id=c.event_id
    WHERE e.problem_id=? AND e.type='problem.writer-cap-changed'`)
    .get(f.id) as { payload_json: string };
  expect(JSON.parse(later.payload_json)).toMatchObject({
    source_fellow_id: actualAuthor.binding.fellowId,
    scientific_author: source?.scientific_author,
  });
  const replay = await replayPrivateStatementAcceptance(
    f.db,
    f.id,
    f.principal.sponsorId,
    action,
    "accept",
  );
  expect(await replay?.json()).toEqual(body);
});

test("private acceptance replays only metadata after stewardship transfer", async () => {
  const f = await fixture(),
    proposal = await f.propose(),
    action = await f.review(proposal);
  const accepted = await (await f.accept(action)).json();
  const transferred = await applyPrivateProblemAccessAction(
    f.db,
    f.id,
    f.principal.sponsorId,
    {
      action: "manage-steward",
      operation: "transfer",
      target_sponsor_id: "usr_disclosure_receiver",
    },
    new Request("https://a.asimposium.org/lifecycle", {
      headers: { "Idempotency-Key": "transfer-after-acceptance" },
    }),
  );
  expect(transferred.status).toBe(200);
  expect(
    await loadStatementRevisionSnapshot(f.db, f.id, proposal, f.principal.sponsorId),
  ).toBeUndefined();
  const recovered = await replayPrivateStatementAcceptance(
    f.db,
    f.id,
    f.principal.sponsorId,
    action,
    "accept",
  );
  const body = await recovered?.json();
  expect(body).toEqual(accepted);
  for (const bytes of [f.body.statement, f.body.motivation, f.body.scope, initial.title])
    expect(JSON.stringify(body)).not.toContain(bytes as string);
});

test("an accepting co-steward cannot replace the initial proposal's frozen scientific sponsor", async () => {
  const f = await fixture();
  const added = await applyPrivateProblemAccessAction(
    f.db,
    f.id,
    f.principal.sponsorId,
    { action: "manage-steward", operation: "add", target_sponsor_id: f.receiver.sponsorId },
    new Request("https://a.asimposium.org/lifecycle", {
      headers: { "Idempotency-Key": "add-publishing-steward" },
    }),
  );
  expect(added.status).toBe(200);
  const preview = await readProblemPublicationPreview(f.db, f.id, f.receiver.sponsorId);
  expect(preview?.scientific_author).toEqual({
    fellow_id: f.binding.fellowId,
    sponsor_id: f.principal.sponsorId,
    session_id: null,
    model_self_declared: f.binding.model,
    harness: f.binding.harness,
  });
  if (!preview) throw new Error("Expected co-steward preview");
  expect(preview.acting_sponsor_id).toBe(f.receiver.sponsorId);
  const published = await applyPublicProblemGovernance(
    f.db,
    f.head(),
    f.receiver.sponsorId,
    { action: "publish", reviewed_statement_version: 1, reviewed_digest: preview.review_digest },
    new Request("https://a.asimposium.org/lifecycle", {
      headers: { "Idempotency-Key": "co-steward-publish" },
    }),
  );
  expect(published.status).toBe(200);
  const source = await readPublishedProblemFormulation(f.db, f.id, f.head().public_seq);
  expect(source?.scientific_author).toEqual(preview.scientific_author);
  expect(source?.source_sponsor_id).toBe(f.principal.sponsorId);
  expect(source?.acting_principal.id).toBe(f.receiver.sponsorId);
});

test("a source sponsor transfer racing initial publication cannot substitute current ownership", async () => {
  const f = await fixture();
  const preview = await readProblemPublicationPreview(f.db, f.id, f.principal.sponsorId);
  if (!preview) throw new Error("Expected exact initial source");
  f.beforeCommit(async () => {
    const offer = await f.service.initiateSponsorFellowTransfer(f.principal, {
      fellow_id: f.binding.fellowId,
      target_sponsor_id: f.receiver.sponsorId,
      confirm: "initiate-fellow-transfer",
      step_up_authenticated_at: Math.floor(Date.now() / 1000),
    });
    await f.service.acceptSponsorFellowTransfer(f.receiver, {
      transfer_id: offer.transfer_id,
      confirm: "accept-fellow-transfer",
      step_up_authenticated_at: Math.floor(Date.now() / 1000),
    });
  });
  expect(
    (
      await applyPublicProblemGovernance(
        f.db,
        f.head(),
        f.principal.sponsorId,
        {
          action: "publish",
          reviewed_statement_version: 1,
          reviewed_digest: preview.review_digest,
        },
        new Request("https://a.asimposium.org/lifecycle", {
          headers: { "Idempotency-Key": "source-transfer-race" },
        }),
      )
    ).status,
  ).toBe(409);
  expect(f.head().public_seq).toBe(0);
  expect(await readProblemPublicationPreview(f.db, f.id, f.principal.sponsorId)).toBeUndefined();
  const row = f.sql
    .query(
      "SELECT scientific_author_json FROM problem_statement_versions WHERE problem_id=? AND version=1",
    )
    .get(f.id) as { scientific_author_json: string };
  expect(JSON.parse(row.scientific_author_json)).toEqual(preview.scientific_author);
});

test("erased private proposal bytes are never recreated by a matching lost-response retry", async () => {
  const f = await fixture();
  await f.propose();
  await hardDeletePrivateDraft(f.db, f.id, f.principal.sponsorId);
  expect((await f.submit()).status).toBe(404);
  expect(
    f.sql
      .query("SELECT COUNT(*) AS n FROM problem_statement_proposals WHERE problem_id=?")
      .get(f.id),
  ).toEqual({ n: 0 });
});

test("contracts refuse raw sponsor science, incoherent proposal states, and substituted author provenance", async () => {
  const f = await fixture(true),
    id = await f.propose(),
    action = await f.review(id);
  const snapshot = await loadStatementRevisionSnapshot(f.db, f.id, id, f.principal.sponsorId);
  if (!snapshot) throw new Error("Expected preview");
  expect(
    ProblemLifecycleActionRequestSchema.safeParse({ action: "revise-statement", ...initial })
      .success,
  ).toBe(false);
  expect(
    ProblemStatementProposalSchema.safeParse({
      ...snapshot.preview.proposal,
      status: "accepted",
      accepted_statement_version: null,
    }).success,
  ).toBe(false);
  expect(
    ProblemStatementProposalSchema.safeParse({
      ...snapshot.preview.proposal,
      author: { ...snapshot.preview.proposal.author, session_id: null },
    }).success,
  ).toBe(false);
  expect(
    ProblemStatementRevisionPreviewSchema.safeParse({
      ...snapshot.preview,
      problem: { ...snapshot.preview.problem, current_statement_version: 2 },
    }).success,
  ).toBe(false);
  expect((await f.accept(action)).status).toBe(200);
  const row = f.sql
    .query(`SELECT c.payload_json FROM event_content c JOIN events e ON e.id=c.event_id
    WHERE e.problem_id=? AND e.type='problem.statement-revised'`)
    .get(f.id) as { payload_json: string };
  const event = JSON.parse(row.payload_json);
  expect(
    ProblemGovernanceEventSchema.safeParse({
      ...event,
      scientific_author: { ...event.scientific_author, session_id: null },
    }).success,
  ).toBe(false);
  expect(
    ProblemGovernanceEventSchema.safeParse({ ...event, source_fellow_id: "another-fellow" })
      .success,
  ).toBe(false);
});
