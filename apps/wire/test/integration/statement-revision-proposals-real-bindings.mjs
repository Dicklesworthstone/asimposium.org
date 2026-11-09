import assert from "node:assert/strict";
import {
  ProblemStatementProposalListResponseSchema,
  ProblemStatementProposalResponseSchema,
  ProblemStatementRevisionPreviewSchema,
  ProblemStatementRevisionResponseSchema,
} from "@asimposium/contracts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Genuine local HTTP, signed sponsor envelopes, Workerd/D1/R2. Identity and
// screening observations are synthetic fixtures, not deployed/OAuth evidence.
await runLocalWorkerJourney(
  async ({ call, enroll, sponsorCall, env, worker, origin, userAgent }) => {
    const owner = "usr_revision_owner",
      sourceSponsor = "usr_revision_source",
      publishingSteward = "usr_revision_independent";
    const creator = await enroll("revision-problem-creator", owner);
    const creatorPeer = await enroll("revision-creator-peer", owner);
    const source = await enroll("revision-source-fellow", sourceSponsor);
    const independent = await enroll("revision-independent-fellow", publishingSteward);
    const sameSponsor = await enroll("revision-same-sponsor", sourceSponsor);
    const fellow = (await call("/v1/hello", undefined, source)).fellow.fellow_id;
    const original = {
      title: "Exact finite rooted tree formulation",
      statement: "Every finite tree has one fewer edge than vertices.",
      falsifier: "An explicit finite tree with a different edge count.",
      motivation: "Record an exact graph invariant.",
      areas: ["combinatorics"],
    };
    const created = await call("/v1/problems", original, creator, 201);
    const id = created.problem.id,
      lifecycle = `/v1/sponsors/problems/${id}/lifecycle`;
    const govern = (body, key, expected = 200, sponsor = owner) =>
      sponsorCall(sponsor, "POST", lifecycle, "problem-lifecycle", body, expected, lifecycle, key);
    await govern(
      { action: "manage-steward", operation: "add", target_sponsor_id: publishingSteward },
      "revision-add-publishing-steward",
    );
    await govern({ action: "publish" }, "revision-publish", 200, publishingSteward);
    const initialStatement = await call(`/p/${id}/statements/1.json`);
    assert.equal(initialStatement.statement.scientific_author.sponsor_id, owner);
    assert.equal(initialStatement.statement.scientific_author.session_id, null);
    const session = (
      await call("/v1/sessions", { problem_id: id, intent: "sharpen-statement" }, source, 201)
    ).session_id;
    const creatorPeerSession = (
      await call("/v1/sessions", { problem_id: id, intent: "review" }, creatorPeer, 201)
    ).session_id;
    const initialReview = {
      statement_version: 1,
      verdict: "statement-clear",
      basis: "The finite domain and in-scope falsifier identify an exact graph statement.",
    };
    assert.equal(
      (
        await call(
          `/v1/problems/${id}/statement-review`,
          { ...initialReview, session_id: creatorPeerSession },
          creatorPeer,
          422,
        )
      ).code,
      "REVIEWER_IS_AUTHOR",
    );
    await call(
      `/v1/problems/${id}/statement-review`,
      { ...initialReview, session_id: session },
      source,
    );
    const proposalPath = `/v1/problems/${id}/statement-proposals`;
    const listPath = `/v1/sponsors/problems/${id}/statement-proposals`;
    const body = {
      session_id: session,
      base_statement_version: 1,
      statement: "Every finite rooted tree has one fewer edge than vertices.",
      falsifier: "A finite rooted tree whose counts violate the asserted equality.",
      motivation: "PRIVATE_STATEMENT_REVISION_913a: make the rooting convention explicit.",
      scope: "Finite rooted undirected simple trees, including a single vertex.",
      out_of_scope: "Infinite graphs and disconnected forests.",
      success_criteria: "A checkable finite proof or an in-scope counterexample.",
    };
    const initialHead = await env.DB.prepare(
      "SELECT public_seq,current_statement_version FROM problems WHERE id=?",
    )
      .bind(id)
      .first();
    const [one, two] = await Promise.all([
      call(proposalPath, body, source, 201, "revision-proposal"),
      call(proposalPath, body, source, 201, "revision-proposal"),
    ]);
    const submitted = ProblemStatementProposalResponseSchema.parse(one);
    assert.deepEqual(two, one);
    assert.equal(submitted.proposal.author.fellow_id, fellow);
    assert.equal(submitted.proposal.author.sponsor_id, sourceSponsor);
    assert.equal(submitted.proposal.author.session_id, session);
    assert.deepEqual(
      await env.DB.prepare("SELECT public_seq,current_statement_version FROM problems WHERE id=?")
        .bind(id)
        .first(),
      initialHead,
    );
    const proposalId = submitted.proposal.proposal_id,
      previewPath = `${listPath}/${proposalId}`;
    assert.equal(
      (
        await call(
          proposalPath,
          { ...body, statement: "A different request." },
          source,
          409,
          "revision-proposal",
        )
      ).code,
      "IDEMPOTENCY_CONFLICT",
    );
    await call(`${proposalPath}/${proposalId}`, undefined, independent, 404);
    await call(`${proposalPath}/${proposalId}`, undefined, undefined, 401);
    await sponsorCall(
      sourceSponsor,
      "GET",
      listPath,
      "problem-statement-proposals",
      undefined,
      404,
    );
    const own = await call(`${proposalPath}/${proposalId}`, undefined, source);
    assert.deepEqual(own, submitted);
    const list = ProblemStatementProposalListResponseSchema.parse(
      await sponsorCall(owner, "GET", listPath, "problem-statement-proposals"),
    );
    assert.equal(list.proposals.length, 1);
    assert.equal(list.proposals[0].proposal_id, proposalId);
    const preview = ProblemStatementRevisionPreviewSchema.parse(
      await sponsorCall(owner, "GET", previewPath, "problem-statement-proposal-preview"),
    );
    assert.equal(preview.can_accept, true);
    assert.deepEqual(preview.proposal, submitted.proposal);
    for (const path of [`/p/${id}.json`, `/p/${id}.md`, `/p/${id}/statements.json`]) {
      const response = await worker.fetch(`${origin}${path}`, {
        headers: { "user-agent": userAgent },
      });
      assert.equal(response.status, 200);
      assert.equal((await response.text()).includes(body.motivation), false);
    }
    const action = {
      action: "revise-statement",
      proposal_id: proposalId,
      reviewed_statement_version: 1,
      reviewed_digest: preview.review_digest,
    };
    assert.equal(
      (await govern({ ...action, reviewed_digest: "0".repeat(64) }, "revision-stale-digest", 409))
        .code,
      "OBJECT_VERSION_CONFLICT",
    );
    const concurrent = await Promise.all([
      govern(action, "revision-accept", [200, 429]),
      govern(action, "revision-accept", [200, 429]),
    ]);
    // Paid-screen reservations may make an overlapping attempt retryable.
    // Recover that same immutable command after its winner has completed.
    const [accepted, recovered] = await Promise.all(
      concurrent.map(async (response) => {
        if (ProblemStatementRevisionResponseSchema.safeParse(response).success) return response;
        assert.equal(response.code, "WRITE_REFUSED");
        return govern(action, "revision-accept");
      }),
    );
    const receipt = ProblemStatementRevisionResponseSchema.parse(accepted);
    assert.deepEqual(recovered, accepted);
    assert.equal(receipt.problem.current_statement_version, 2);
    assert.equal(receipt.statement_revision.source_fellow_id, fellow);
    assert.equal(receipt.statement_revision.proposal_id, proposalId);
    assert.equal(JSON.stringify(receipt).includes(body.motivation), false);
    const head = await env.DB.prepare(
      "SELECT public_seq,current_statement_version FROM problems WHERE id=?",
    )
      .bind(id)
      .first();
    assert.equal(head.public_seq, initialHead.public_seq + 1);
    const events = await env.DB.prepare(
      "SELECT id,actor_fellow_id,actor_sponsor_id,actor_session_id FROM events WHERE problem_id=? AND type='problem.statement-revised'",
    )
      .bind(id)
      .all();
    assert.equal(events.results.length, 1);
    assert.equal(events.results[0].actor_fellow_id, null);
    assert.equal(events.results[0].actor_session_id, null);
    assert.equal(events.results[0].actor_sponsor_id, owner);
    assert.equal(events.results[0].id, receipt.statement_revision.event_id);
    const statement = await call(`/p/${id}/statements/2.json`);
    assert.equal(statement.statement.statement, body.statement);
    assert.deepEqual(statement.statement.scientific_author, submitted.proposal.author);
    const oldStatement = await call(`/p/${id}/statements/1.json`);
    assert.equal(oldStatement.statement.statement, original.statement);
    const reviewBody = {
      session_id: session,
      statement_version: 2,
      verdict: "statement-clear",
      basis: "The exact finite domain, rooting convention and falsifier are explicit.",
    };
    assert.equal(
      (await call(`/v1/problems/${id}/statement-review`, reviewBody, source, 422)).code,
      "REVIEWER_IS_AUTHOR",
    );
    const sameSession = (
      await call("/v1/sessions", { problem_id: id, intent: "review" }, sameSponsor, 201)
    ).session_id;
    assert.equal(
      (
        await call(
          `/v1/problems/${id}/statement-review`,
          { ...reviewBody, session_id: sameSession },
          sameSponsor,
          422,
        )
      ).code,
      "REVIEWER_IS_AUTHOR",
    );
    const independentSession = (
      await call("/v1/sessions", { problem_id: id, intent: "review" }, independent, 201)
    ).session_id;
    await call(
      `/v1/problems/${id}/statement-review`,
      { ...reviewBody, session_id: independentSession },
      independent,
    );
    assert.deepEqual(await govern(action, "revision-accept"), accepted);
    assert.equal(
      (await govern(action, "revision-accept-anew", 409)).code,
      "OBJECT_VERSION_CONFLICT",
    );
    const changed = ProblemStatementRevisionPreviewSchema.parse(
      await sponsorCall(owner, "GET", previewPath, "problem-statement-proposal-preview"),
    );
    assert.equal(changed.can_accept, false);
    assert.equal(changed.proposal.status, "accepted");
    const next = ProblemStatementProposalResponseSchema.parse(
      await call(
        proposalPath,
        { ...body, base_statement_version: 2 },
        source,
        201,
        "revision-next-proposal",
      ),
    );
    const nextPreview = ProblemStatementRevisionPreviewSchema.parse(
      await sponsorCall(
        owner,
        "GET",
        `${listPath}/${next.proposal.proposal_id}`,
        "problem-statement-proposal-preview",
      ),
    );
    const beforeRefusal = await env.DB.prepare(
      "SELECT public_seq,current_statement_version FROM problems WHERE id=?",
    )
      .bind(id)
      .first();
    await sponsorCall(
      sourceSponsor,
      "POST",
      "/v1/fellows/lifecycle",
      "fellow.lifecycle.change",
      {
        fellow_id: fellow,
        status: "paused",
        confirm: "change-fellow-lifecycle",
        step_up_authenticated_at: Math.floor(Date.now() / 1000),
      },
      200,
    );
    await govern(
      {
        action: "revise-statement",
        proposal_id: next.proposal.proposal_id,
        reviewed_statement_version: 2,
        reviewed_digest: nextPreview.review_digest,
      },
      "revision-paused-source",
      409,
    );
    assert.deepEqual(
      await env.DB.prepare("SELECT public_seq,current_statement_version FROM problems WHERE id=?")
        .bind(id)
        .first(),
      beforeRefusal,
    );
    console.log(
      JSON.stringify({
        kind: "statement-revision-proposals-real-bindings",
        status: "pass",
        proof:
          "Fellow-authored private proposal, exact steward acceptance, immutable provenance, replay, source-author independence and revoked-source refusal",
      }),
    );
  },
);
