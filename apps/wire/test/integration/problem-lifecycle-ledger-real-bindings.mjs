import assert from "node:assert/strict";
import { ProblemDocumentSchema } from "@asimposium/contracts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

await runLocalWorkerJourney(
  async ({ call, enroll, sponsorCall, env, fixtures, worker, origin, userAgent }) => {
    const sponsor = "usr_governance";
    const token = await enroll("governance-author", sponsor);
    const proposal = {
      title: "Governance finite path formulation",
      statement: "Every simple path with n edges has n + 1 distinct vertices.",
      falsifier: "A simple path whose number of distinct vertices differs from n + 1.",
      motivation: "Track exact formulation changes for polling agents.",
      areas: ["combinatorics"],
    };
    const created = await call("/v1/problems", proposal, token, 201);
    const id = created.problem.id;
    const path = `/v1/sponsors/problems/${id}/lifecycle`;
    const govern = (body, key, expected = 200, problemId = id, actor = sponsor) => {
      const route = `/v1/sponsors/problems/${problemId}/lifecycle`;
      return sponsorCall(actor, "POST", route, "problem-lifecycle", body, expected, route, key);
    };
    async function state(problemId = id) {
      const result = {};
      for (const [name, query] of Object.entries({
        problem: "SELECT * FROM problems WHERE id = ?",
        events: "SELECT * FROM events WHERE problem_id = ? ORDER BY seq",
        content:
          "SELECT * FROM event_content WHERE event_id IN (SELECT id FROM events WHERE problem_id = ?) ORDER BY event_id",
        versions: "SELECT * FROM problem_statement_versions WHERE problem_id = ? ORDER BY version",
        checkpoints:
          "SELECT * FROM integrity_checkpoints WHERE problem_id = ? ORDER BY checkpoint_seq",
        keys: "SELECT * FROM idempotency WHERE problem_id = ? ORDER BY idempotency_key",
      }))
        result[name] = (await env.DB.prepare(query).bind(problemId).all()).results;
      result.cursor = await call("/cursor");
      return result;
    }
    const globalBefore = await call("/cursor");
    const published = await sponsorCall(
      sponsor,
      "POST",
      path,
      "problem-lifecycle",
      { action: "publish" },
      200,
      path,
      "publish-stable-key",
    );
    const publishedFace = await worker.fetch(`${origin}/p/${id}.json`, {
      headers: { "User-Agent": userAgent },
    });
    const firstEtag = publishedFace.headers.get("etag");
    assert.ok(firstEtag);
    await publishedFace.arrayBuffer();
    const events = (
      await env.DB.prepare("SELECT * FROM events WHERE problem_id = ? ORDER BY seq").bind(id).all()
    ).results;
    assert.equal(events.length, 1, "Publication must append exactly one governance event");
    assert.equal(events[0].type, "problem.admitted");
    assert.equal(events[0].actor_sponsor_id, sponsor);
    for (const field of [
      "actor_fellow_id",
      "actor_session_id",
      "model_string_self_declared",
      "harness",
      "writer_credential_id",
    ])
      assert.equal(events[0][field], null);
    assert.equal((await call(`/p/${id}.json`)).cursor, 1);
    assert.equal(await call("/cursor"), globalBefore + 1);
    const sourceFellow = created.problem.created_by_fellow_id;
    assert.equal((await state()).problem[0].created_by_fellow_id, sourceFellow);
    const admission = (await call("/now.json")).events.find((item) => item.problem_id === id);
    assert.equal(admission.type, "problem.admitted");
    assert.equal(admission.actor_fellow_id, null);
    assert.equal(
      JSON.parse((await state()).content[0].payload_json).source_fellow_id,
      sourceFellow,
    );

    const revision = {
      action: "revise-statement",
      statement: "Every finite simple path with n edges has exactly n + 1 distinct vertices.",
      falsifier: "A finite simple path with n edges and a different vertex count.",
      motivation: "Make finiteness explicit in the published formulation.",
    };
    const revised = await govern(revision, "revision-key");
    assert.equal(revised.problem.current_statement_version, 2);
    const afterRevision = await state();
    const changedFace = await worker.fetch(`${origin}/p/${id}.json`, {
      headers: { "User-Agent": userAgent, "If-None-Match": firstEtag },
    });
    assert.equal(changedFace.status, 200);
    assert.notEqual(changedFace.headers.get("etag"), firstEtag);
    await changedFace.arrayBuffer();
    assert.equal(afterRevision.events.length, 2);
    assert.equal(afterRevision.events[1].type, "problem.statement-revised");
    assert.equal(afterRevision.events[1].object_version, 2);
    assert.equal(afterRevision.cursor, globalBefore + 2);
    assert.equal(afterRevision.problem[0].public_seq, 2);
    assert.equal(afterRevision.versions[0].statement, proposal.statement);
    assert.equal(afterRevision.versions[1].statement, revision.statement);
    assert.equal(afterRevision.versions[1].steward_accepted_by, sponsor);
    const detail = await call(`/v1/problems/${id}`);
    assert.equal(detail.problem.statement, revision.statement);
    const digest = await call(`/p/${id}.json`);
    assert.equal(digest.cursor, 2);
    assert.ok(
      digest.items.some(
        (item) => item.kind === "problem-statement" && item.body.includes(revision.statement),
      ),
    );
    const revisionContent = afterRevision.content.find(
      (item) => item.event_id === afterRevision.events[1].id,
    );
    assert.deepEqual(JSON.parse(revisionContent.payload_json).problem, revised.problem);
    assert.deepEqual(await govern(revision, "revision-key"), revised);
    assert.deepEqual(await govern({ action: "publish" }, "publish-stable-key"), published);
    assert.equal(
      (await govern({ ...revision, motivation: "Changed request" }, "revision-key", 409)).code,
      "IDEMPOTENCY_CONFLICT",
    );
    assert.equal((await govern(revision, "publish-stable-key", 409)).code, "IDEMPOTENCY_CONFLICT");
    assert.equal((await govern(revision, "invalid/key", 400)).code, "IDEMPOTENCY_KEY_INVALID");
    assert.equal(
      (await govern(revision, "another-sponsor", 403, id, "usr_other_sponsor")).code,
      "WRITE_REFUSED",
    );
    assert.deepEqual(
      await state(),
      afterRevision,
      "Replays and refused writes preserve all ledger state",
    );
    const stale = await fixtures.governanceFromSnapshot(
      { ...afterRevision.problem[0], current_statement_version: 1 },
      sponsor,
      revision,
      "stale-version-key",
    );
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "OBJECT_VERSION_CONFLICT");
    assert.deepEqual(
      await state(),
      afterRevision,
      "A stale snapshot cannot append an event or retain its key",
    );

    const sameKey = await Promise.all(
      Array.from({ length: 4 }, () => govern(revision, "concurrent-key")),
    );
    for (const outcome of sameKey) assert.deepEqual(outcome, sameKey[0]);
    assert.equal((await state()).events.length, 3);
    assert.equal(await call("/cursor"), globalBefore + 3);
    const beforeRace = await state();
    const raced = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        govern({ ...revision, motivation: `Concurrent formulation ${i}` }, `race-${i}`, [200, 409]),
      ),
    );
    const winners = raced.filter((outcome) => outcome.problem);
    const losers = raced.filter((outcome) => !outcome.problem);
    for (const loser of losers) assert.equal(loser.code, "OBJECT_VERSION_CONFLICT");
    const afterRace = await state();
    assert.ok(winners.length >= 1);
    assert.equal(afterRace.events.length, beforeRace.events.length + winners.length);
    assert.equal(afterRace.cursor, beforeRace.cursor + winners.length);
    assert.equal(afterRace.versions.length, beforeRace.versions.length + winners.length);
    assert.equal(afterRace.keys.length, beforeRace.keys.length + winners.length);
    assert.deepEqual(
      afterRace.events.map((event) => event.seq),
      Array.from({ length: afterRace.events.length }, (_, i) => i + 1),
    );

    // A real SQLite constraint failure after event insertion must roll back the entire batch.
    await env.DB.prepare(`CREATE TRIGGER governance_forced_failure BEFORE INSERT ON problem_statement_versions
    WHEN NEW.statement = 'forced-transaction-failure' BEGIN SELECT RAISE(ABORT, 'governance-rollback-proof'); END`).run();
    const beforeFailure = await state();
    const failure = await govern(
      { ...revision, statement: "forced-transaction-failure" },
      "rollback-key",
      500,
    );
    assert.ok(ProblemDocumentSchema.safeParse(failure).success);
    assert.equal(failure.code, "INTERNAL_ERROR");
    assert.match(failure.fix_hint, /same Idempotency-Key/);
    assert.ok(!JSON.stringify(failure).includes("governance-rollback-proof"));
    assert.ok(!JSON.stringify(failure).includes("forced-transaction-failure"));
    assert.deepEqual(
      await state(),
      beforeFailure,
      "Failed projection rolls back events, chain, versions, keys and both cursors",
    );
    await govern(revision, "rollback-key");
    assert.equal((await state()).events.length, beforeFailure.events.length + 1);

    // Age the mutable replay key, never the immutable event, to exercise the 24-hour boundary.
    await env.DB.prepare("UPDATE idempotency SET created_at = ? WHERE problem_id = ?")
      .bind(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), id)
      .run();
    const beforeExpired = await state();
    const reused = await govern(revision, "revision-key");
    assert.ok(reused.problem.current_statement_version > revised.problem.current_statement_version);
    assert.equal((await state()).events.length, beforeExpired.events.length + 1);

    const privateCreated = await call(
      "/v1/problems",
      { ...proposal, title: "Private governance", statement: "Private unique formulation" },
      token,
      201,
    );
    const privateId = privateCreated.problem.id;
    const privateCursor = await call("/cursor");
    await govern(
      { ...revision, statement: "Private revised formulation" },
      "private-revision",
      200,
      privateId,
    );
    assert.equal((await state(privateId)).events.length, 0);
    assert.equal(await call("/cursor"), privateCursor);
    await call(`/p/${privateId}.json`, undefined, undefined, 404);
    assert.ok(!(await call("/now.json")).events.some((item) => item.problem_id === privateId));
    await sponsorCall(sponsor, "POST", "/v1/fellows/lifecycle", "fellow.lifecycle.change", {
      fellow_id: sourceFellow,
      status: "revoked",
      confirm: "change-fellow-lifecycle",
      step_up_authenticated_at: Math.floor(Date.now() / 1000),
    });
    const beforeRevoked = await state(privateId);
    assert.equal(
      (await govern({ action: "publish" }, "revoked-publication", 403, privateId)).code,
      "WRITE_REFUSED",
    );
    assert.deepEqual(await state(privateId), beforeRevoked);

    const unlistedToken = await enroll("unlisted-governance", "usr_unlisted_governance");
    const unlisted = await call(
      "/v1/problems",
      {
        ...proposal,
        title: "Unlisted governance",
        statement: "Unlisted unique formulation",
        unlisted: true,
      },
      unlistedToken,
      201,
    );
    await govern(
      { action: "publish" },
      "unlisted-publication",
      200,
      unlisted.problem.id,
      "usr_unlisted_governance",
    );
    assert.equal((await call(`/v1/problems/${unlisted.problem.id}`)).problem.public_seq, 1);
    assert.ok(
      !(await call("/now.json")).events.some((item) => item.problem_id === unlisted.problem.id),
    );
    const beforeExpiredPublish = await state();
    assert.equal(
      (await govern({ action: "publish" }, "publish-stable-key", 409)).code,
      "OBJECT_VERSION_CONFLICT",
    );
    assert.deepEqual(await state(), beforeExpiredPublish);
    // The same nested error boundary also covers a Fellow proposal failure.
    await env.DB.prepare(`CREATE TRIGGER governance_proposal_failure BEFORE INSERT ON problems
      WHEN NEW.title = 'Forced proposal failure' BEGIN SELECT RAISE(ABORT, 'private-proposal-failure'); END`).run();
    const beforeProposalFailure = await env.DB.prepare(
      "SELECT count(*) AS n FROM problems",
    ).first();
    const failedProposal = await call(
      "/v1/problems",
      {
        ...proposal,
        title: "Forced proposal failure",
        statement: "Private failing proposal statement",
      },
      unlistedToken,
      500,
    );
    assert.ok(ProblemDocumentSchema.safeParse(failedProposal).success);
    assert.equal(failedProposal.code, "INTERNAL_ERROR");
    assert.ok(!JSON.stringify(failedProposal).includes("Private failing proposal statement"));
    assert.ok(!JSON.stringify(failedProposal).includes("private-proposal-failure"));
    assert.deepEqual(
      await env.DB.prepare("SELECT count(*) AS n FROM problems").first(),
      beforeProposalFailure,
    );
    assert.deepEqual(await state(), beforeExpiredPublish);
    console.log(
      JSON.stringify({
        kind: "problem-lifecycle-ledger",
        status: "pass",
        proof:
          "real local D1 publication, revision, replay, concurrency, rollback, expiry and discovery isolation",
        concurrent_successes: winners.length,
        concurrent_stale_refusals: losers.length,
      }),
    );
  },
);
