import assert from "node:assert/strict";
import { normHash } from "../../src/split/policy.ts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// The normal HTTP writers run on Workerd and migrated D1. The one-shot
// competing fixture commits a chained statement revision after admission but
// before the server's screening snapshot. A newer screening context cannot
// stand in for the author's older context. No deployed authority is exercised.
await runLocalWorkerJourney(async ({ call, enroll, sponsorCall, fixtures, env }) => {
  const owner = "usr_statement_context_owner";
  const author = await enroll("statement-context-author", owner);
  const reviewer = await enroll("statement-context-reviewer", "usr_statement_context_reviewer");
  const created = await call(
    "/v1/problems",
    {
      title: "Statement context publication race",
      statement: "Every integer n in 0..40 has the same parity as n squared.",
      falsifier: "An integer in that range whose square changes its parity.",
      motivation: "Keep every public result tied to the formulation its author read.",
      areas: ["number-theory"],
    },
    author,
    201,
  );
  const problemId = created.problem.id;
  await sponsorCall(
    owner,
    "POST",
    `/v1/sponsors/problems/${problemId}/lifecycle`,
    "problem-lifecycle",
    { action: "publish" },
  );
  const reviewSession = await call(
    "/v1/sessions",
    { problem_id: problemId, intent: "review" },
    reviewer,
    201,
  );
  await call(
    `/v1/problems/${problemId}/statement-review`,
    {
      session_id: reviewSession.session_id,
      statement_version: 1,
      verdict: "statement-clear",
      basis: "The finite range and parity test are exact.",
    },
    reviewer,
  );
  await call(
    `/v1/sessions/${reviewSession.session_id}/close`,
    { handback: "Statement reviewed." },
    reviewer,
    201,
  );
  const session = await call(
    "/v1/sessions",
    { problem_id: problemId, intent: "explore" },
    author,
    201,
  );
  const path = `/v1/sessions/${session.session_id}`;
  const head = () =>
    env.DB.prepare("SELECT public_seq, current_statement_version FROM problems WHERE id = ?")
      .bind(problemId)
      .first();
  const count = async (table) =>
    (
      await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE problem_id = ?`)
        .bind(problemId)
        .first()
    ).n;
  const draft = (publication, sessionId = session.session_id) =>
    call(
      `/v1/sessions/${sessionId}/workshop`,
      {
        type: "claim-draft",
        title: "Private draft for the current formulation",
        body_md: "Keep these working notes private.",
        ...(publication === undefined ? {} : { publication }),
      },
      author,
      201,
    );
  const claim = {
    kind: "conjecture",
    statement: "Every even integer in the stated range has an even square.",
    falsifier: "An even input in the range has an odd square.",
  };

  async function armRevision(createdAt = new Date().toISOString()) {
    const current = await head();
    const version = current.current_statement_version + 1;
    const statement = `Every integer n in 0..${40 + version} has the same parity as n squared.`;
    const falsifier = "An integer in that range whose square changes its parity.";
    const motivation = "Keep each claim and review tied to the author's read formulation.";
    // Stage the immutable formulation row. It is not current/public until the
    // competing ledger batch commits its event and advances the problem head.
    await env.DB.prepare(`INSERT INTO problem_statement_versions
      (problem_id, version, statement, norm_hash, falsifier, motivation, steward_accepted_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        problemId,
        version,
        statement,
        `sha256:${await normHash(statement)}`,
        falsifier,
        motivation,
        owner,
        createdAt,
      )
      .run();
    await fixtures.armCompetingLedgerWrite(
      problemId,
      "UPDATE problems SET current_statement_version = ?, updated_at = ? WHERE id = ?",
      [version, createdAt, problemId],
      {
        eventType: "problem.statement-revised",
        objectKind: "problem",
        objectId: problemId,
        objectVersion: version,
        createdAt,
        payload: {
          action: "revise-statement",
          acting_principal: { type: "sponsor", id: owner },
          previous_statement_version: current.current_statement_version,
          previous_status: "active",
          problem: {
            id: problemId,
            title: created.problem.title,
            status: "active",
            current_statement_version: version,
            statement,
            falsifier,
            motivation,
            updated_at: createdAt,
          },
        },
      },
      "SELECT p.id, p.status, p.public_seq",
    );
    return current.public_seq;
  }

  async function refusedByRevision(route, body, key) {
    const before = await count("events");
    const cursor = await armRevision();
    const result = await call(route, body(cursor), author, 409, key);
    assert.equal(
      await fixtures.competingWriteStillArmed(),
      false,
      "the competing revision committed before screening",
    );
    assert.equal(result.code, "STATEMENT_REVISED_SINCE");
    assert.equal(result.client_context_cursor, cursor);
    assert.equal(result.revised_at_cursor, (await head()).public_seq);
    assert.equal(result.delta_pointer, `/p/${problemId}.md`);
    assert.equal(await count("events"), before + 1, "only the competing statement event commits");
    return result.revised_at_cursor;
  }

  const saved = await draft();
  const beforeFutureContext = await head();
  const eventsBeforeFutureContext = await count("events");
  const screensBeforeFutureContext = await fixtures.screeningCalls();
  const attemptsBeforeFutureContext = await count("public_write_attempt_reservations");
  for (const cursor of [beforeFutureContext.public_seq + 1, Number.MAX_SAFE_INTEGER]) {
    const refused = await call(
      `${path}/promote`,
      { ...claim, workshop_id: saved.workshop_id, client_context_cursor: cursor },
      author,
      400,
      `native-future-context-${cursor}`,
    );
    assert.equal(refused.code, "SCHEMA_INVALID");
    assert.equal(refused.example.client_context_cursor, beforeFutureContext.public_seq);
  }
  assert.deepEqual(await head(), beforeFutureContext);
  assert.equal(await count("events"), eventsBeforeFutureContext);
  assert.equal(await count("claims"), 0);
  assert.equal(await fixtures.screeningCalls(), screensBeforeFutureContext);
  assert.equal(await count("public_write_attempt_reservations"), attemptsBeforeFutureContext);
  const refreshedCursor = await refusedByRevision(
    `${path}/promote`,
    (cursor) => ({
      ...claim,
      workshop_id: saved.workshop_id,
      client_context_cursor: cursor,
    }),
    "native-stale-promotion",
  );
  assert.equal(await count("claims"), 0);
  const refreshedBody = {
    ...claim,
    workshop_id: saved.workshop_id,
    client_context_cursor: refreshedCursor,
  };
  const accepted = await call(
    `${path}/promote`,
    refreshedBody,
    author,
    201,
    "native-refreshed-promotion",
  );
  assert.equal(await count("claims"), 1);

  const closeDraft = await draft({
    ...claim,
    statement: "Every odd integer in the stated range has an odd square.",
    falsifier: "An odd input in the range has an even square.",
    client_context_cursor: (await head()).public_seq,
  });
  await refusedByRevision(
    `${path}/close`,
    () => ({
      handback: "Publish the selected result and close the session.",
      promote: [closeDraft.workshop_id],
    }),
    "native-stale-close",
  );
  assert.equal(await count("claims"), 1);
  assert.deepEqual(
    await env.DB.prepare("SELECT closed_at, handback FROM sessions WHERE session_id = ?")
      .bind(session.session_id)
      .first(),
    { closed_at: null, handback: null },
  );
  assert.deepEqual(
    await env.DB.prepare("SELECT state FROM workshop_objects WHERE workshop_id = ?")
      .bind(closeDraft.workshop_id)
      .first(),
    { state: "open" },
  );
  const screens = await fixtures.screeningCalls();
  assert.deepEqual(
    await call(`${path}/promote`, refreshedBody, author, 200, "native-refreshed-promotion"),
    accepted,
  );
  assert.equal(
    await fixtures.screeningCalls(),
    screens,
    "committed promotion replays after another statement revision without rescreening",
  );

  await refusedByRevision(
    `${path}/revise`,
    (cursor) => ({
      ...claim,
      claim_id: accepted.claim_id,
      base_version: 1,
      statement: "Every nonnegative even integer in the stated range has an even square.",
      client_context_cursor: cursor,
    }),
    "native-stale-revision",
  );
  assert.equal(await count("claim_versions"), 1);
  await call(
    `${path}/close`,
    { handback: "Retain the private draft and continue after reorientation." },
    author,
    201,
  );
  await refusedByRevision(
    `/v1/p/${problemId}/claims`,
    (cursor) => ({
      ...claim,
      statement: "Zero has an even square within the stated domain.",
      client_context_cursor: cursor,
    }),
    "native-stale-direct",
  );
  assert.equal(await count("claims"), 1);
  assert.equal(
    (
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM sessions WHERE problem_id = ? AND closed_at IS NULL",
      )
        .bind(problemId)
        .first()
    ).n,
    0,
  );
  const attempts =
    await env.DB.prepare(`SELECT status, COUNT(*) AS n FROM public_write_attempt_reservations
    WHERE problem_id = ? AND idempotency_key LIKE 'native-%' GROUP BY status ORDER BY status`)
      .bind(problemId)
      .all();
  assert.deepEqual(attempts.results, [
    { status: "settled_failed", n: 3 },
    { status: "settled_published", n: 1 },
  ]);

  // A revision request may have captured its event timestamp before this
  // session existed, yet win the ledger after the session opens. D1 must use
  // the durable session cut, never that backdated wall-clock value.
  const beforeBackdated = await head();
  const backdatedSession = await call("/v1/sessions", { problem_id: problemId }, author, 201);
  assert.deepEqual(
    await env.DB.prepare("SELECT opened_public_cursor FROM sessions WHERE session_id = ?")
      .bind(backdatedSession.session_id)
      .first(),
    { opened_public_cursor: beforeBackdated.public_seq },
  );
  const backdated = new Date(Date.parse(backdatedSession.opened_at) - 60_000).toISOString();
  const backdatedDraft = await draft(undefined, backdatedSession.session_id);
  const backdatedBody = {
    ...claim,
    workshop_id: backdatedDraft.workshop_id,
    statement: "The square of two is even within the stated domain.",
  };
  const eventsBeforeBackdated = await count("events");
  await armRevision(backdated);
  const backdatedRefusal = await call(
    `/v1/sessions/${backdatedSession.session_id}/promote`,
    backdatedBody,
    author,
    409,
    "native-backdated-session-context",
  );
  assert.equal(await fixtures.competingWriteStillArmed(), false);
  assert.equal(backdatedRefusal.code, "STATEMENT_REVISED_SINCE");
  assert.equal(backdatedRefusal.client_context_cursor, beforeBackdated.public_seq);
  assert.equal(backdatedRefusal.revised_at_cursor, (await head()).public_seq);
  assert.equal(await count("events"), eventsBeforeBackdated + 1);
  assert.equal(await count("claims"), 1);
  assert.deepEqual(
    await env.DB.prepare("SELECT created_at FROM events WHERE problem_id = ? AND seq = ?")
      .bind(problemId, backdatedRefusal.revised_at_cursor)
      .first(),
    { created_at: backdated },
  );
  await call(
    `/v1/sessions/${backdatedSession.session_id}/close`,
    { handback: "Reopen after reading the revised statement." },
    author,
    201,
  );
  const freshSession = await call("/v1/sessions", { problem_id: problemId }, author, 201);
  assert.deepEqual(
    await env.DB.prepare("SELECT opened_public_cursor FROM sessions WHERE session_id = ?")
      .bind(freshSession.session_id)
      .first(),
    { opened_public_cursor: backdatedRefusal.revised_at_cursor },
  );
  const freshDraft = await draft(undefined, freshSession.session_id);
  const freshBody = { ...backdatedBody, workshop_id: freshDraft.workshop_id };
  const freshPath = `/v1/sessions/${freshSession.session_id}`;
  const freshPublication = await call(
    `${freshPath}/promote`,
    freshBody,
    author,
    201,
    "native-session-cut-publication",
  );
  await armRevision(backdated);
  const revisionRefusal = await call(
    `${freshPath}/revise`,
    {
      ...claim,
      claim_id: freshPublication.claim_id,
      base_version: 1,
      statement: "The square of two equals four, which is even in the stated domain.",
    },
    author,
    409,
    "native-backdated-revision-context",
  );
  assert.equal(await fixtures.competingWriteStillArmed(), false);
  assert.equal(revisionRefusal.code, "STATEMENT_REVISED_SINCE");
  assert.equal(revisionRefusal.client_context_cursor, backdatedRefusal.revised_at_cursor);
  assert.equal(await count("claim_versions"), 2);
  const screensBeforeReplay = await fixtures.screeningCalls();
  assert.deepEqual(
    await call(`${freshPath}/promote`, freshBody, author, 200, "native-session-cut-publication"),
    freshPublication,
  );
  assert.equal(await fixtures.screeningCalls(), screensBeforeReplay);
  assert.equal(await count("claims"), 2);
  console.log(
    JSON.stringify({
      stage: "statement-context-atomicity",
      stale_writes_refused: 6,
      fresh_write_committed: 2,
      future_cursors_refused: 2,
      backdated_revision_refused: true,
      durable_session_cut_verified: true,
      replay_preserved: true,
    }),
  );
});

console.log(JSON.stringify({ kind: "statement-context-real-bindings", status: "pass" }));
