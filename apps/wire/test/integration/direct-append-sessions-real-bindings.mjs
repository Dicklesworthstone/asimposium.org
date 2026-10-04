import assert from "node:assert/strict";
import { IMPLICIT_SESSION_FAILURE_CLOSE_SQL } from "../../src/sessions/implicit-session.ts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Direct appends and their implicit sessions on real local Workerd/D1:
// - 6svb: an opener whose own write fails closes its implicit session with
//   the production failure close; it must not close it under a request that
//   joined. The close runs (as a race) after the joiner joined and before its
//   ledger batch; the joiner must still succeed.
// - rp4s: a direct append that would open a third session answers the
//   teaching 409 SESSION_CAP_REACHED, like POST /v1/sessions, never 500.

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

  // 1. 6svb: a failed opener's close never lands under a joiner.
  const [problem] = problems;
  const setup = await call(`/v1/p/${problem}/dead-ends`, deadEnd("setup"), author, null);
  assert.equal(setup.code, undefined, `setup (${setup.code ?? ""})`);
  const { fellow_id: fellowId } = await env.DB.prepare(
    "SELECT fellow_id FROM sessions WHERE problem_id = ? AND handback = 'Direct append' LIMIT 1",
  )
    .bind(problem)
    .first();
  // An opener's implicit session, as the opener's own request created it.
  const openerSession = "S-DIRECTSESSIONOPENER";
  const openedAt = new Date(Date.now() - 50).toISOString();
  await env.DB.prepare(
    `INSERT INTO sessions (session_id, fellow_id, problem_id, intent, opened_at, last_heartbeat_at, idle_close_at)
     VALUES (?, ?, ?, 'explore', ?, ?, ?)`,
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
  // The opener's write fails while the joiner is in flight: the production
  // failure close runs after the joiner joined and before its ledger batch.
  await fixtures.armRaceBeforeNextBatch(
    IMPLICIT_SESSION_FAILURE_CLOSE_SQL,
    [new Date().toISOString(), openerSession, fellowId, openedAt],
    "INSERT INTO events",
  );
  const joined = await call(`/v1/p/${problem}/dead-ends`, deadEnd("joined"), author, null);
  assert.equal(await fixtures.raceStillArmed(), false, "the opener's failure close ran");
  assert.equal(joined.code, undefined, `the joiner succeeded (${joined.code ?? ""})`);
  const opener = await env.DB.prepare(
    "SELECT closed_at, (SELECT COUNT(*) FROM events WHERE actor_session_id = ?) AS events FROM sessions WHERE session_id = ?",
  )
    .bind(openerSession, openerSession)
    .first();
  assert.equal(opener.closed_at, null, "the joined session stayed open");
  assert.equal(opener.events, 1, "the joiner's event was written in the shared session");
  await env.DB.prepare(
    "UPDATE sessions SET closed_at = ?, handback = 'Lane reset' WHERE session_id = ?",
  )
    .bind(new Date().toISOString(), openerSession)
    .run();

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

  console.log(
    JSON.stringify({
      kind: "direct-append-sessions-real-bindings",
      status: "pass",
      boundary: "local Workerd/D1; failure close injected at the joiner's ledger batch; no staging",
    }),
  );
  return { status: "pass" };
});
