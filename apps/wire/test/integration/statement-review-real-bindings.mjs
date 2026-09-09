import assert from "node:assert/strict";
import {
  ProblemDocumentSchema,
  ProblemStatementReviewEventSchema,
  ScreeningPromotionDeniedResponseSchema,
} from "@asimposium/contracts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

await runLocalWorkerJourney(
  async ({ call, enroll, sponsorCall, env, fixtures, worker, origin, userAgent }) => {
    const sponsor = "usr_statement_author";
    const author = await enroll("statement-author", sponsor);
    const created = await call(
      "/v1/problems",
      {
        title: "Independent finite path formulation",
        statement: "Every finite simple path with n edges has n + 1 distinct vertices.",
        falsifier: "A finite simple path with another number of distinct vertices.",
        motivation: "Record which formulation an independent Fellow actually checked.",
        areas: ["combinatorics"],
      },
      author,
      201,
    );
    const id = created.problem.id;
    const openapi = await call("/openapi.json");
    assert.equal(
      openapi.paths["/v1/problems/{id}/statement-review"].post.requestBody.content[
        "application/json"
      ].schema.$ref,
      `${origin}/schemas/problems.v1.json#/properties/statement_review_request`,
    );
    const route = `/v1/problems/${id}/statement-review`;
    const govern = (body, key) =>
      sponsorCall(
        sponsor,
        "POST",
        `/v1/sponsors/problems/${id}/lifecycle`,
        "problem-lifecycle",
        body,
        200,
        `/v1/sponsors/problems/${id}/lifecycle`,
        key,
      );
    await govern({ action: "publish" }, "publish");
    let reviewerNumber = 0;
    async function reviewer(actor = `usr_statement_reviewer_${reviewerNumber + 1}`) {
      const token = await enroll(`statement-reviewer-${++reviewerNumber}`, actor);
      const session = await call("/v1/sessions", { problem_id: id, intent: "review" }, token, 201);
      return { token, session: session.session_id, sponsor: actor };
    }
    const body = (r, verdict = "statement-clear", version = 1) => ({
      session_id: r.session,
      statement_version: version,
      verdict,
      basis: "The finite domain and the proposed counterexample are explicit.",
    });
    async function state() {
      const result = {};
      for (const [name, sql] of Object.entries({
        problem: "SELECT * FROM problems WHERE id = ?",
        reviews:
          "SELECT * FROM problem_statement_reviews WHERE problem_id = ? ORDER BY version, reviewer_fellow_id",
        events: "SELECT * FROM events WHERE problem_id = ? ORDER BY seq",
        content:
          "SELECT * FROM event_content WHERE event_id IN (SELECT id FROM events WHERE problem_id = ?) ORDER BY event_id",
        keys: "SELECT * FROM idempotency WHERE problem_id = ? ORDER BY idempotency_key",
        checkpoints:
          "SELECT * FROM integrity_checkpoints WHERE problem_id = ? ORDER BY checkpoint_seq",
      }))
        result[name] = (await env.DB.prepare(sql).bind(id).all()).results;
      result.cursor = await call("/cursor");
      return result;
    }
    const unclearReviewer = await reviewer();
    const before = await state();
    const unclear = await call(
      route,
      body(unclearReviewer, "statement-unclear"),
      unclearReviewer.token,
    );
    assert.equal(unclear.status, "sharpening");
    assert.equal((await state()).events.length, before.events.length + 1);
    assert.equal(await call("/cursor"), before.cursor + 1);
    const clearReviewer = await reviewer();
    const preClear = await state();
    const response = await worker.fetch(`${origin}${route}`, {
      method: "POST",
      headers: {
        "User-Agent": userAgent,
        authorization: `Bearer ${clearReviewer.token}`,
        "content-type": "application/json",
        "Idempotency-Key": "clear-stable-key",
      },
      body: JSON.stringify(body(clearReviewer)),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const exact = await response.text();
    assert.equal(JSON.parse(exact).status, "active");
    const postClear = await state();
    assert.equal(postClear.events.length, preClear.events.length + 1);
    assert.equal(postClear.reviews.length, preClear.reviews.length + 1);
    assert.equal(postClear.problem[0].public_seq, preClear.problem[0].public_seq + 1);
    assert.equal(postClear.cursor, preClear.cursor + 1);
    const event = postClear.events.at(-1);
    assert.equal(event.type, "problem.statement-reviewed");
    assert.equal(event.object_version, 1);
    assert.equal(event.actor_sponsor_id, clearReviewer.sponsor);
    assert.equal(event.actor_session_id, clearReviewer.session);
    assert.equal(event.model_string_self_declared, "synthetic-problem-model");
    assert.equal(event.harness, "local-problem-lifecycle-proof");
    assert.ok(event.writer_credential_id);
    assert.equal(
      event.actor_fellow_id,
      postClear.reviews.find((r) => r.verdict === "statement-clear").reviewer_fellow_id,
    );
    const payload = ProblemStatementReviewEventSchema.parse(
      JSON.parse(postClear.content.find((c) => c.event_id === event.id).payload_json),
    );
    assert.equal(payload.status, "active");
    assert.equal(payload.previous_status, "sharpening");
    assert.equal(payload.basis, body(clearReviewer).basis);
    assert.equal((await call(`/p/${id}.json`)).cursor, postClear.problem[0].public_seq);
    const nowReview = (await call("/now.json")).events.find((e) => e.event_id === event.id);
    assert.equal(nowReview?.type, "review.published");
    assert.match(nowReview.summary, /reviewed the statement/);
    const screeningCount = await fixtures.screeningCalls();
    assert.deepEqual(
      await call(route, body(clearReviewer), clearReviewer.token, 200, "clear-stable-key"),
      JSON.parse(exact),
    );
    assert.equal(await fixtures.screeningCalls(), screeningCount);
    assert.deepEqual(await state(), postClear);
    const fresh = await reviewer();
    for (const [candidate, token, expected, code] of [
      [
        { ...body(clearReviewer), basis: "Changed body" },
        clearReviewer.token,
        409,
        "IDEMPOTENCY_CONFLICT",
      ],
      [body(fresh, "statement-clear", 2), fresh.token, 409, "OBJECT_VERSION_CONFLICT"],
      [body(clearReviewer), fresh.token, 404, "SESSION_NOT_FOUND"],
      [body(clearReviewer), clearReviewer.token, 409, "REVIEWER_ALREADY_REVIEWED"],
    ]) {
      const result = await call(
        route,
        candidate,
        token,
        expected,
        candidate.basis === "Changed body" ? "clear-stable-key" : undefined,
      );
      assert.equal(result.code, code);
      assert.ok(ProblemDocumentSchema.safeParse(result).success);
    }
    assert.deepEqual(await state(), postClear);
    const sameSponsor = await reviewer(sponsor);
    assert.equal(
      (await call(route, body(sameSponsor), sameSponsor.token, 422)).code,
      "REVIEWER_IS_AUTHOR",
    );
    const screenBeforeRefusals = await fixtures.screeningCalls();
    const authorSession = await call(
      "/v1/sessions",
      { problem_id: id, intent: "sharpen-statement" },
      author,
      201,
    );
    assert.equal(
      (await call(route, { ...body(fresh), session_id: authorSession.session_id }, author, 422))
        .code,
      "REVIEWER_IS_AUTHOR",
    );
    assert.equal(await fixtures.screeningCalls(), screenBeforeRefusals);
    assert.deepEqual(await state(), postClear);

    // The screening record is part of the same transaction as the public review.
    const provenance = await env.DB.prepare(
      "SELECT * FROM screening_publications WHERE event_id = ?",
    )
      .bind(event.id)
      .first();
    assert.ok(provenance);
    assert.equal(JSON.parse(provenance.provenance_json).principal, "platform:symposiarch");
    await fixtures.setScreenMode("reject");
    const rejected = await call(route, body(fresh), fresh.token, 403, "rejected-review");
    assert.ok(ScreeningPromotionDeniedResponseSchema.safeParse(rejected).success);
    assert.deepEqual(await state(), postClear);
    await fixtures.setScreenMode("pass");

    const revision = {
      action: "revise-statement",
      statement: "A nonempty finite simple path with n edges has exactly n + 1 distinct vertices.",
      falsifier: "A nonempty finite simple path with another vertex count.",
      motivation: "Explicitly name nonemptiness.",
    };
    await govern(revision, "revision");
    await call(
      `/v1/sessions/${clearReviewer.session}/close`,
      { handback: "The review of statement version one is recorded." },
      clearReviewer.token,
      201,
    );
    const afterRevision = await state();
    const repeat = await worker.fetch(`${origin}${route}`, {
      method: "POST",
      headers: {
        "User-Agent": userAgent,
        authorization: `Bearer ${clearReviewer.token}`,
        "content-type": "application/json",
        "Idempotency-Key": "clear-stable-key",
      },
      body: JSON.stringify(body(clearReviewer)),
    });
    assert.equal(repeat.status, 200);
    assert.equal(
      await repeat.text(),
      exact,
      "Lost-response retry survives later revision and session close byte-for-byte",
    );
    assert.equal(
      (await call(route, body(clearReviewer, "statement-clear", 2), clearReviewer.token, 409)).code,
      "SESSION_CLOSED",
    );
    assert.deepEqual(await state(), afterRevision);

    // A real SQLite constraint failure after event insertion rolls back the complete public write.
    await env.DB.prepare(
      "CREATE TABLE statement_review_failure_switch (enabled INTEGER NOT NULL)",
    ).run();
    await env.DB.prepare("INSERT INTO statement_review_failure_switch VALUES (1)").run();
    await env.DB.prepare(`CREATE TRIGGER statement_review_forced_failure BEFORE INSERT ON problem_statement_reviews
    WHEN NEW.basis = 'forced projection failure' AND (SELECT enabled FROM statement_review_failure_switch) = 1
    BEGIN SELECT RAISE(ABORT, 'statement-review-rollback-proof'); END`).run();
    const rollbackBody = {
      ...body(fresh, "statement-clear", 2),
      basis: "forced projection failure",
    };
    const rollbackBefore = await state();
    const failed = await call(route, rollbackBody, fresh.token, 500, "rollback-key");
    assert.equal(failed.code, "INTERNAL_ERROR");
    assert.ok(!JSON.stringify(failed).includes("statement-review-rollback-proof"));
    assert.deepEqual(await state(), rollbackBefore);
    await env.DB.prepare("UPDATE statement_review_failure_switch SET enabled = 0").run();
    assert.equal(
      (await call(route, rollbackBody, fresh.token, 200, "rollback-key")).status,
      "active",
    );
    const afterRollbackRetry = await state();
    assert.equal(afterRollbackRetry.events.length, rollbackBefore.events.length + 1);
    assert.equal(afterRollbackRetry.cursor, rollbackBefore.cursor + 1);
    assert.ok(
      !(await call("/now.json")).events.some(
        (e) => e.event_id === afterRollbackRetry.events.at(-1).id,
      ),
      "Statement reviews after sharpening remain process events outside Now",
    );

    const racer = await reviewer();
    const beforeRace = await state();
    const raced = await Promise.all(
      Array.from({ length: 4 }, () =>
        call(route, body(racer, "statement-clear", 2), racer.token, null, "race-key"),
      ),
    );
    assert.ok(raced.some((r) => r.reviewed));
    for (const result of raced)
      assert.ok(result.reviewed || result.code === "IDEMPOTENCY_CONFLICT");
    const settled = await call(
      route,
      body(racer, "statement-clear", 2),
      racer.token,
      200,
      "race-key",
    );
    for (const result of raced.filter((r) => r.reviewed)) assert.deepEqual(result, settled);
    const afterRace = await state();
    assert.equal(afterRace.events.length, beforeRace.events.length + 1);
    assert.equal(afterRace.cursor, beforeRace.cursor + 1);
    assert.equal(afterRace.reviews.length, beforeRace.reviews.length + 1);

    const revoked = await reviewer();
    const beforeRevoke = await state();
    await fixtures.revokeOnNextScreen();
    assert.equal(
      (await call(route, body(revoked, "statement-clear", 2), revoked.token, 403)).code,
      "WRITE_REFUSED",
    );
    assert.deepEqual(await state(), beforeRevoke);

    // Revise through the real signed route while screening is paused after its authorization read.
    const staleReviewer = await reviewer();
    const callsBeforeRace = await fixtures.screeningCalls();
    await fixtures.pauseScreening();
    const pending = call(
      route,
      body(staleReviewer, "statement-clear", 2),
      staleReviewer.token,
      null,
      "stale-during-screen",
    );
    for (let i = 0; i < 100 && (await fixtures.screeningCalls()) === callsBeforeRace; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(await fixtures.screeningCalls(), callsBeforeRace + 1);
    await govern(
      { ...revision, motivation: "Clarify the exact version while an older review is in flight." },
      "concurrent-revision",
    );
    const afterConcurrentRevision = await state();
    const staleResult = await pending;
    await fixtures.resumeScreening();
    assert.equal(staleResult.code, "OBJECT_VERSION_CONFLICT");
    assert.deepEqual(await state(), afterConcurrentRevision);

    // Twenty actual denied attempts exhaust the public-write quota before another classifier call.
    const limited = await reviewer();
    await fixtures.setScreenMode("reject");
    for (let i = 0; i < 20; i++)
      await call(route, body(limited, "statement-clear", 3), limited.token, 403, `limited-${i}`);
    const beforeLimited = await state();
    const screensAtLimit = await fixtures.screeningCalls();
    const limitedResult = await call(
      route,
      body(limited, "statement-clear", 3),
      limited.token,
      429,
      "limited-overflow",
    );
    assert.equal(limitedResult.code, "PROMOTION_RATE_LIMITED");
    assert.equal(await fixtures.screeningCalls(), screensAtLimit);
    assert.deepEqual(await state(), beforeLimited);
    await fixtures.setScreenMode("pass");
    const scopedSponsor = "usr_statement_scope";
    const invitation = await fixtures.mint(scopedSponsor, ["promote"]);
    const claimed = await call(
      "/v1/fellows",
      {
        enrollment_id: invitation.enrollmentId,
        secret: invitation.secret,
        name: "statement-no-review-scope",
        model: "scope-proof",
        harness: "local-proof",
      },
      undefined,
      202,
    );
    await fixtures.approve(scopedSponsor, invitation.enrollmentId);
    const issued = await call("/v1/fellows/flow", { flow_handle: claimed.flow_handle });
    const scopedSession = await call(
      "/v1/sessions",
      { problem_id: id, intent: "explore" },
      issued.token,
      201,
    );
    const scopeScreens = await fixtures.screeningCalls();
    assert.equal(
      (
        await call(
          route,
          { ...body(fresh, "statement-clear", 3), session_id: scopedSession.session_id },
          issued.token,
          403,
        )
      ).code,
      "WRITE_REFUSED",
    );
    assert.equal(await fixtures.screeningCalls(), scopeScreens);
    assert.deepEqual(await state(), beforeLimited);
    const paused = await reviewer();
    const pausedFellow = (
      await env.DB.prepare("SELECT fellow_id FROM sessions WHERE session_id = ?")
        .bind(paused.session)
        .first()
    ).fellow_id;
    const pauseScreenCount = await fixtures.screeningCalls();
    await fixtures.pauseScreening();
    const pausePending = call(
      route,
      body(paused, "statement-clear", 3),
      paused.token,
      null,
      "pause-during-screen",
    );
    for (let i = 0; i < 100 && (await fixtures.screeningCalls()) === pauseScreenCount; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(await fixtures.screeningCalls(), pauseScreenCount + 1);
    await sponsorCall(paused.sponsor, "POST", "/v1/fellows/lifecycle", "fellow.lifecycle.change", {
      fellow_id: pausedFellow,
      status: "paused",
      confirm: "change-fellow-lifecycle",
      step_up_authenticated_at: Math.floor(Date.now() / 1000),
    });
    const afterPause = await state();
    const pauseResult = await pausePending;
    await fixtures.resumeScreening();
    assert.equal(
      pauseResult.code,
      "WRITE_REFUSED",
      "A sponsor pause during screening must stop the pending public review",
    );
    assert.deepEqual(await state(), afterPause);
    const expiringInvitation = await sponsorCall(
      scopedSponsor,
      "POST",
      "/v1/enrollments",
      "enrollment.mint",
      {
        requested_scopes: ["review"],
        fellow_grant_expires_in_ms: 5000,
      },
      201,
    );
    const expiryClaimed = await call(
      "/v1/fellows",
      {
        enrollment_id: expiringInvitation.enrollment_id,
        secret: expiringInvitation.secret,
        name: "statement-expiring-grant",
        model: "expiry-proof",
        harness: "local-proof",
      },
      undefined,
      202,
    );
    await fixtures.approve(scopedSponsor, expiringInvitation.enrollment_id);
    const expiryToken = (await call("/v1/fellows/flow", { flow_handle: expiryClaimed.flow_handle }))
      .token;
    const expirySession = await call(
      "/v1/sessions",
      { problem_id: id, intent: "review" },
      expiryToken,
      201,
    );
    const beforeExpiry = await state();
    const expiryScreens = await fixtures.screeningCalls();
    await fixtures.pauseScreening(6000);
    assert.equal(
      (
        await call(
          route,
          { ...body(fresh, "statement-clear", 3), session_id: expirySession.session_id },
          expiryToken,
          403,
        )
      ).code,
      "WRITE_REFUSED",
    );
    await fixtures.resumeScreening();
    assert.equal(
      await fixtures.screeningCalls(),
      expiryScreens + 1,
      "The grant expires during screening, not before authentication",
    );
    assert.deepEqual(await state(), beforeExpiry);
    // Exercise terminal admission without claiming the separate retirement write is already atomic.
    await govern({ action: "retire", reason: "Statement review test has completed." }, "retire");
    const terminal = await state();
    assert.equal(
      (await call(route, body(staleReviewer, "statement-clear", 3), staleReviewer.token, 409)).code,
      "OBJECT_VERSION_CONFLICT",
    );
    assert.deepEqual(await state(), terminal);
    const privateCreated = await call(
      "/v1/problems",
      {
        title: "Private statement work",
        statement: "A private finite graph statement awaiting publication.",
        falsifier: "A finite graph with the proposed property absent.",
        motivation: "Keep draft sharpening private.",
        areas: ["combinatorics"],
      },
      author,
      201,
    );
    const privateId = privateCreated.problem.id;
    const privateSession = await call(
      "/v1/sessions",
      { problem_id: privateId, intent: "sharpen-statement" },
      author,
      201,
    );
    const privateCursor = await call("/cursor");
    assert.equal(
      (
        await call(
          `/v1/problems/${privateId}/statement-review`,
          {
            ...body(fresh),
            session_id: privateSession.session_id,
          },
          author,
          404,
        )
      ).code,
      "PROBLEM_NOT_FOUND",
    );
    assert.equal(
      (await call(route, { ...body(fresh), session_id: privateSession.session_id }, author, 404))
        .code,
      "SESSION_NOT_FOUND",
    );
    assert.equal(await call("/cursor"), privateCursor);
    assert.equal(
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE problem_id = ?")
          .bind(privateId)
          .first()
      ).n,
      0,
    );

    console.log(
      JSON.stringify({
        kind: "statement-review-real-bindings",
        status: "pass",
        boundary:
          "Actual local Workerd/D1/R2 and signed sponsor requests; synthetic classifier, no OAuth or deployment claim",
      }),
    );
  },
);
