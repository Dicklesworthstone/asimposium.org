import assert from "node:assert/strict";
import { IMPLICIT_SESSION_RELEASE_SQL } from "../../src/sessions/implicit-session.ts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Direct appends and their implicit sessions on real local Workerd/D1:
// - 6svb: parallel direct appends share one implicit session, counted in
//   implicit_inflight (0085). An opener that finishes first gives its count
//   back with the production release; that must not close the session under
//   a request that joined (the release runs, as a race, after the joiner
//   joined and before its ledger batch). The last request to finish closes
//   it, so no joined session is left open for the idle sweep.
// - rp4s: a direct append that would open a third session answers the
//   teaching 409 SESSION_CAP_REACHED, like POST /v1/sessions, never 500.
// - A session past its idle deadline is retired before a direct append looks
//   for one to join, so it is neither revived nor counted against the cap.

await runLocalWorkerJourney(async ({ call, enroll, sponsorCall, fixtures, env }) => {
  const OWNER = "usr_direct_sessions_owner";
  const author = await enroll("direct-sessions-author", OWNER);
  const reviewer = await enroll("direct-sessions-reviewer", "usr_direct_sessions_reviewer");
  const problems = [];
  for (let index = 0; index < 3; index += 1) {
    const problem = (
      await call(
        "/v1/problems",
        {
          title: `Direct session problem ${index}`,
          statement: `Every integer in 0..${80 + index} has a square of the same parity.`,
          falsifier: `An integer in 0..${80 + index} whose square has the opposite parity.`,
          motivation: "Implicit sessions of direct appends.",
          areas: ["number-theory"],
        },
        author,
        201,
      )
    ).problem.id;
    await sponsorCall(
      OWNER,
      "POST",
      `/v1/sponsors/problems/${problem}/lifecycle`,
      "problem-lifecycle",
      {
        action: "publish",
      },
    );
    const review = (
      await call("/v1/sessions", { problem_id: problem, intent: "review" }, reviewer, 201)
    ).session_id;
    await call(
      `/v1/problems/${problem}/statement-review`,
      { session_id: review, statement_version: 1, verdict: "statement-clear", basis: "Exact." },
      reviewer,
    );
    await call(`/v1/sessions/${review}/close`, { handback: "Statement reviewed." }, reviewer, null);
    problems.push(problem);
  }
  const deadEnd = (tag) => ({
    approach: `Tried a parity argument variant ${tag} through modular squares.`,
    why_it_fails: `Variant ${tag} only covers even inputs and skips the odd case.`,
    retry_predicate: `Retry variant ${tag} once odd inputs are handled.`,
  });

  // 1. 6svb: an opener that finishes first never closes under a joiner, and
  // the last request to finish closes the session.
  const [problem] = problems;
  const setup = await call(`/v1/p/${problem}/dead-ends`, deadEnd("setup"), author, null);
  assert.equal(setup.code, undefined, `setup (${setup.code ?? ""})`);
  const setupSession = await env.DB.prepare(
    "SELECT fellow_id, closed_at, handback FROM sessions WHERE problem_id = ? AND intent = 'explore'",
  )
    .bind(problem)
    .first();
  assert.ok(setupSession, "the direct append opened an implicit session");
  assert.notEqual(setupSession.closed_at, null, "a lone direct append closes its session");
  assert.equal(setupSession.handback, "Direct append");
  const fellowId = setupSession.fellow_id;
  // An opener's implicit session, as the opener's own request created it
  // (counted once, for the opener).
  const openerSession = "S-DIRECTSESSIONOPENER";
  const openedAt = new Date(Date.now() - 50).toISOString();
  await env.DB.prepare(
    `INSERT INTO sessions (session_id, fellow_id, problem_id, intent, opened_at, last_heartbeat_at, idle_close_at, implicit_inflight)
     VALUES (?, ?, ?, 'explore', ?, ?, ?, 1)`,
  )
    .bind(
      openerSession,
      fellowId,
      problem,
      openedAt,
      openedAt,
      new Date(Date.now() + 1_800_000).toISOString(),
    )
    .run();
  // The opener finishes (its write failed) while the joiner is in flight: the
  // production release runs after the joiner joined and before its batch.
  await fixtures.armRaceBeforeNextBatch(
    IMPLICIT_SESSION_RELEASE_SQL,
    [new Date().toISOString(), openerSession, fellowId],
    "INSERT INTO events",
  );
  const joined = await call(`/v1/p/${problem}/dead-ends`, deadEnd("joined"), author, null);
  assert.equal(await fixtures.raceStillArmed(), false, "the opener's release ran");
  assert.equal(joined.code, undefined, `the joiner succeeded (${joined.code ?? ""})`);
  const sessionState = (sessionId) =>
    env.DB.prepare(
      `SELECT closed_at, handback, implicit_inflight,
         (SELECT COUNT(*) FROM events WHERE actor_session_id = ?) AS events
       FROM sessions WHERE session_id = ?`,
    )
      .bind(sessionId, sessionId)
      .first();
  const opener = await sessionState(openerSession);
  assert.equal(opener.events, 1, "the joiner's event was written in the shared session");
  assert.notEqual(opener.closed_at, null, "the last request to finish closed the session");
  assert.equal(opener.handback, "Direct append", "closed as a session that wrote");
  assert.equal(opener.implicit_inflight, 0, "every count was given back");

  // A direct append refused after its implicit session opened closes it as
  // failed: nothing was written, and no slot is left open.
  const refusedClaim = await call(
    `/v1/p/${problem}/claims`,
    {
      kind: "conjecture",
      statement: "Refused claim: squaring preserves parity below eighty.",
      falsifier: "An integer below eighty whose square has the other parity.",
      workshop_id: "W-01ARZ3NDEKTSV4RRFFQ69G5FAV",
    },
    author,
    404,
  );
  assert.equal(refusedClaim.code, "WORKSHOP_OBJECT_NOT_FOUND");
  const refusedSession = await env.DB.prepare(
    "SELECT session_id FROM sessions WHERE problem_id = ? AND fellow_id = ? ORDER BY opened_at DESC, rowid DESC LIMIT 1",
  )
    .bind(problem, fellowId)
    .first();
  const failed = await sessionState(refusedSession.session_id);
  assert.notEqual(failed.closed_at, null, "the refused append's session closed");
  assert.equal(failed.handback, "Direct append failed", "closed as a session that wrote nothing");
  assert.equal(failed.events, 0);

  // Parallel direct appends: every one succeeds, and once all have answered
  // no implicit session of this Fellow is left open.
  const parallel = await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      call(`/v1/p/${problem}/dead-ends`, deadEnd(`parallel-${index}`), author, null),
    ),
  );
  assert.deepEqual(
    parallel.map((response) => response.code ?? "ok"),
    Array(6).fill("ok"),
    "all parallel appends succeeded",
  );
  const lingering = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM sessions WHERE fellow_id = ? AND closed_at IS NULL AND implicit_inflight IS NOT NULL",
  )
    .bind(fellowId)
    .first();
  assert.equal(lingering.n, 0, "no implicit session outlives its last request");

  const closeOpenSessions = async () => {
    await env.DB.prepare(
      "UPDATE sessions SET closed_at = ?, handback = 'Lane reset' WHERE fellow_id = ? AND closed_at IS NULL",
    )
      .bind(new Date().toISOString(), fellowId)
      .run();
  };
  const eventsOf = async (type) =>
    (
      await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE problem_id = ? AND type = ?")
        .bind(problem, type)
        .first()
    ).n;

  // 3. 6svb: the Fellow's own close lands while its direct append is using
  // the (joined) session: a teaching 409 SESSION_CLOSED, never a 500.
  for (const [route, body, eventType] of [
    ["dead-ends", deadEnd("closed-mid-request"), "dead_end.recorded"],
    [
      "claims",
      {
        kind: "conjecture",
        statement: "Closed mid-request: squaring preserves parity below eighty.",
        falsifier: "An integer below eighty whose square has the other parity.",
      },
      "claim.created",
    ],
    [
      "hypotheses",
      {
        route: "Reduce the parity of n squared to the parity of n, closed mid-request.",
        mechanism: "Squaring preserves the residue of n modulo two.",
        falsifier: "An integer whose square has the opposite residue modulo two.",
        origin: "proposed",
        body_md: "Parity route, closed while the append was in flight.",
      },
      "hypothesis.created",
    ],
  ]) {
    await closeOpenSessions();
    const explicit = (
      await call("/v1/sessions", { problem_id: problem, intent: "explore" }, author, 201)
    ).session_id;
    const before = await eventsOf(eventType);
    await fixtures.armRaceBeforeNextBatch(
      "UPDATE sessions SET closed_at = ?, handback = 'Closed mid-request' WHERE session_id = ?",
      [new Date().toISOString(), explicit],
      "INSERT INTO events",
    );
    const refused = await call(`/v1/p/${problem}/${route}`, body, author, 409);
    assert.equal(refused.code, "SESSION_CLOSED", `${route}: closed mid-request`);
    assert.equal(await fixtures.raceStillArmed(), false, `${route}: the close ran`);
    assert.equal(await eventsOf(eventType), before, `${route}: nothing was written`);
  }
  await closeOpenSessions();

  // 4. rp4s: with one other session open, a request that loses the race to
  // open this problem's session joins the winner instead of hitting the cap.
  await call("/v1/sessions", { problem_id: problems[1], intent: "explore" }, author, 201);
  const winner = "S-DIRECTSESSIONWINNER";
  const winnerAt = new Date().toISOString();
  await fixtures.armRaceBeforeNextBatch(
    `INSERT INTO sessions (session_id, fellow_id, problem_id, intent, opened_at, last_heartbeat_at, idle_close_at)
     VALUES (?, ?, ?, 'explore', ?, ?, ?)`,
    [winner, fellowId, problem, winnerAt, winnerAt, new Date(Date.now() + 1_800_000).toISOString()],
    "INSERT INTO sessions",
  );
  const loser = await call(
    `/v1/p/${problem}/dead-ends`,
    deadEnd("lost-creation-race"),
    author,
    null,
  );
  assert.equal(await fixtures.raceStillArmed(), false, "the winning session was inserted first");
  assert.equal(loser.code, undefined, `the loser joined the winner (${loser.code ?? ""})`);
  const joinedWinner = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM events WHERE problem_id = ? AND actor_session_id = ?",
  )
    .bind(problem, winner)
    .first();
  assert.equal(joinedWinner.n, 1, "the append was written in the winner's session");
  await closeOpenSessions();

  const hypothesis = (tag) => ({
    route: `Reduce the parity of n squared to the parity of n (${tag}).`,
    mechanism: `Squaring preserves the residue modulo two (${tag}).`,
    falsifier: `An integer whose square has the opposite residue (${tag}).`,
    origin: "proposed",
    body_md: `Parity route ${tag}.`,
  });
  const conjecture = (tag) => ({
    kind: "conjecture",
    statement: `Claim ${tag}: squaring preserves parity below one hundred.`,
    falsifier: `An integer below one hundred breaking ${tag}.`,
  });
  const allEvents = async () =>
    (
      await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE problem_id = ?")
        .bind(problem)
        .first()
    ).n;

  // 5. 6svb: events:batch members on a joined session closed mid-request.
  for (const [action, body] of [
    ["dead-end", deadEnd],
    ["hypothesis", hypothesis],
    ["claim", conjecture],
  ]) {
    await closeOpenSessions();
    const explicit = (
      await call("/v1/sessions", { problem_id: problem, intent: "explore" }, author, 201)
    ).session_id;
    const before = await allEvents();
    await fixtures.armRaceBeforeNextBatch(
      "UPDATE sessions SET closed_at = ?, handback = 'Closed under the batch' WHERE session_id = ? AND closed_at IS NULL",
      [new Date().toISOString(), explicit],
      "INSERT INTO events",
    );
    const refused = await call(
      `/v1/p/${problem}/events:batch`,
      { members: [{ tempId: "tmp:m1", causedBy: [], action, data: body(`batch-${action}`) }] },
      author,
      409,
    );
    assert.equal(refused.code, "SESSION_CLOSED", `batch ${action}: closed mid-request`);
    assert.equal(await fixtures.raceStillArmed(), false, `batch ${action}: the close ran`);
    assert.equal(await allEvents(), before, `batch ${action}: nothing was written`);
  }
  await closeOpenSessions();

  // 6. huvl: the request's OWN implicit session closed elsewhere mid-request.
  for (const [route, body] of [
    ["dead-ends", deadEnd],
    ["claims", conjecture],
    ["hypotheses", hypothesis],
  ]) {
    const before = await allEvents();
    // closed_at from the database clock at the moment the close runs: the
    // implicit session opens after this is armed, and closed_at >= opened_at.
    await fixtures.armRaceBeforeNextBatch(
      "UPDATE sessions SET closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), handback = 'Closed by the Fellow' WHERE problem_id = ? AND fellow_id = ? AND closed_at IS NULL",
      [problem, fellowId],
      "INSERT INTO events",
    );
    const refused = await call(`/v1/p/${problem}/${route}`, body(`own-${route}`), author, 409);
    assert.equal(refused.code, "SESSION_CLOSED", `${route}: own implicit session closed`);
    assert.equal(await fixtures.raceStillArmed(), false, `${route}: the close ran`);
    assert.equal(await allEvents(), before, `${route}: nothing was written`);
    await closeOpenSessions();
  }

  // 2. rp4s: the two-open-session cap on a direct append.
  for (const open of problems.slice(0, 2)) {
    await call("/v1/sessions", { problem_id: open, intent: "explore" }, author, 201);
  }
  const explicit = await call(
    "/v1/sessions",
    { problem_id: problems[2], intent: "explore" },
    author,
    409,
  );
  assert.equal(explicit.code, "SESSION_CAP_REACHED");
  const cappedDeadEnd = await call(
    `/v1/p/${problems[2]}/dead-ends`,
    deadEnd("capped"),
    author,
    409,
  );
  assert.equal(cappedDeadEnd.code, "SESSION_CAP_REACHED");
  assert.equal(cappedDeadEnd.open_session_ids.length, 2);
  const cappedClaim = await call(
    `/v1/p/${problems[2]}/claims`,
    {
      kind: "conjecture",
      statement: "Capped claim: squaring preserves parity below eighty-two.",
      falsifier: "An integer below eighty-two whose square has the other parity.",
    },
    author,
    409,
  );
  assert.equal(cappedClaim.code, "SESSION_CAP_REACHED");

  // 7. A session past its idle deadline is retired, never joined or revived,
  // and no longer holds a cap slot (as at POST /v1/sessions admission).
  const sessionOn = async (onProblem) =>
    (
      await env.DB.prepare(
        "SELECT session_id FROM sessions WHERE problem_id = ? AND fellow_id = ? AND closed_at IS NULL",
      )
        .bind(onProblem, fellowId)
        .first()
    ).session_id;
  const expire = (sessionId) =>
    env.DB.prepare("UPDATE sessions SET idle_close_at = ? WHERE session_id = ?")
      .bind(new Date(Date.now() - 1_000).toISOString(), sessionId)
      .run();
  const idleClosed = async (sessionId) =>
    env.DB.prepare(
      `SELECT closed_at, handback, last_heartbeat_at, opened_at,
         (SELECT COUNT(*) FROM events WHERE actor_session_id = ?) AS events,
         (SELECT COUNT(*) FROM fellow_inbox_notices WHERE target_id = ?) AS notices
       FROM sessions WHERE session_id = ?`,
    )
      .bind(sessionId, sessionId, sessionId)
      .first();
  const stale = await sessionOn(problems[0]);
  await expire(stale);
  const afterIdle = await call(
    `/v1/p/${problems[0]}/dead-ends`,
    deadEnd("after-idle"),
    author,
    null,
  );
  assert.equal(afterIdle.code, undefined, "an append after the idle deadline succeeds");
  const retired = await idleClosed(stale);
  assert.notEqual(retired.closed_at, null, "the idle session was retired");
  assert.equal(retired.handback, null, "retired as the idle sweep does, without a handback");
  assert.equal(retired.events, 0, "the append was not written into the idle session");
  assert.equal(retired.last_heartbeat_at, retired.opened_at, "the idle session was not revived");
  assert.equal(retired.notices, 1, "the Fellow is told the idle session closed");
  // The other cap slot goes idle: a direct append on a third problem fits.
  await expire(await sessionOn(problems[1]));
  const freed = await call(`/v1/p/${problems[2]}/dead-ends`, deadEnd("freed-slot"), author, null);
  assert.equal(freed.code, undefined, "an idle session no longer holds a cap slot");

  console.log(
    JSON.stringify({
      kind: "direct-append-sessions-real-bindings",
      status: "pass",
      boundary:
        "local Workerd/D1; the opener's release injected at the joiner's ledger batch; no staging",
    }),
  );
  return { status: "pass" };
});
