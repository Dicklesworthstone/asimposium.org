import assert from "node:assert/strict";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// rg73 on real local Workerd/D1: a state transition raced by a genuine
// competing write that changes the same object (a real chained event plus its
// state change, committed after the route's checks and before its batch) must
// not commit a second, contradictory transition. Lease releases answer 409; a
// tombstone that loses to another tombstone gets the idempotent outcome.
// Question withdraw is raced in questions-retractions-real-bindings.mjs.
//
// Not covered: staging; more than one interleaved write.

await runLocalWorkerJourney(async ({ call, enroll, sponsorCall, fixtures, env }) => {
  const OWNER = "usr_transition_race_owner";
  const fellow = await enroll("transition-race-author", OWNER);
  const reviewer = await enroll("transition-race-reviewer", "usr_transition_race_reviewer");
  const problem = (
    await call(
      "/v1/problems",
      {
        title: "Transition race",
        statement: "Every integer in 0..47 has a square of the same parity.",
        falsifier: "An integer in 0..47 whose square has the opposite parity.",
        motivation: "Race state transitions against competing writes.",
        areas: ["number-theory"],
      },
      fellow,
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
  const reviewSession = (
    await call("/v1/sessions", { problem_id: problem, intent: "review" }, reviewer, 201)
  ).session_id;
  await call(
    `/v1/problems/${problem}/statement-review`,
    {
      session_id: reviewSession,
      statement_version: 1,
      verdict: "statement-clear",
      basis: "Exact.",
    },
    reviewer,
  );
  const session = (
    await call("/v1/sessions", { problem_id: problem, intent: "explore" }, fellow, 201)
  ).session_id;

  const eventsOfType = async (type) =>
    (
      await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE problem_id = ? AND type = ?")
        .bind(problem, type)
        .first()
    ).n;
  const releaseCompetitor = (object) => [
    "UPDATE leases SET status = 'released' WHERE problem_id = ? AND status = 'active' AND (object_id = ? OR object_ref = ?)",
    [problem, object, object],
  ];
  const leaseOn = async (body_md) => {
    const question = await call(`/v1/sessions/${session}/questions`, { body_md }, fellow, 201);
    await call(
      `/v1/sessions/${session}/leases`,
      {
        object: question.question_id,
        objective: "Check the boundary case",
        deliverable: "A scoped review",
        ttl_seconds: 1800,
      },
      fellow,
      201,
    );
    return question.question_id;
  };

  // 1. A Fellow's release raced by a competing release of the same lease.
  const fellowObject = await leaseOn(
    "Which residues modulo eight leave the parity of the square undetermined in this range?",
  );
  const releasedBefore = await eventsOfType("lease.released");
  await fixtures.armCompetingLedgerWrite(problem, ...releaseCompetitor(fellowObject));
  const fellowRelease = await call(
    `/v1/sessions/${session}/leases/${fellowObject}/release`,
    {},
    fellow,
    409,
  );
  assert.equal(fellowRelease.code, "OBJECT_VERSION_CONFLICT");
  assert.equal(await fixtures.competingWriteStillArmed(), false, "fellow release: race ran");
  assert.equal(await eventsOfType("lease.released"), releasedBefore, "no second release event");

  // 2. A sponsor's release (no reason, so unscreened) raced the same way.
  const sponsorObject = await leaseOn(
    "Does the residue argument extend to cubes without changing the parity bound in this range?",
  );
  await fixtures.armCompetingLedgerWrite(problem, ...releaseCompetitor(sponsorObject));
  const sponsorRelease = await sponsorCall(
    OWNER,
    "POST",
    "/v1/sponsors/leases/release",
    "lease.release",
    { problem_id: problem, object: sponsorObject },
    409,
  );
  assert.equal(sponsorRelease.code, "OBJECT_VERSION_CONFLICT");
  assert.equal(await fixtures.competingWriteStillArmed(), false, "sponsor release: race ran");
  assert.equal(await eventsOfType("lease.released"), releasedBefore, "no second release event");

  // 3. A tombstone raced by a competing tombstone of the same commentary.
  const commentary = await sponsorCall(
    OWNER,
    "POST",
    `/v1/problems/${problem}/commentary`,
    "post-commentary",
    { problem_id: problem, body: "A sponsor note on the parity range used in this problem." },
    201,
    `/v1/problems/${problem}/commentary`,
  );
  const tombstonesBefore = await eventsOfType("commentary.tombstoned");
  await fixtures.armCompetingLedgerWrite(
    problem,
    "UPDATE problem_commentaries SET tombstoned = 1, tombstone_reason = 'author_request', body = NULL WHERE id = ?",
    [commentary.commentary_id],
  );
  const tombstoned = await sponsorCall(
    OWNER,
    "POST",
    `/v1/problems/${problem}/commentary/${commentary.commentary_id}/tombstone`,
    "tombstone-commentary",
    { problem_id: problem, commentary_id: commentary.commentary_id, reason: "author_request" },
    200,
    `/v1/problems/${problem}/commentary/${commentary.commentary_id}/tombstone`,
  );
  assert.equal(tombstoned.tombstoned, true, "the idempotent outcome");
  assert.equal(await fixtures.competingWriteStillArmed(), false, "tombstone: race ran");
  assert.equal(
    await eventsOfType("commentary.tombstoned"),
    tombstonesBefore,
    "no tombstone event for an already-tombstoned commentary",
  );

  console.log(
    JSON.stringify({
      kind: "transition-race-real-bindings",
      status: "pass",
      boundary:
        "local Workerd/D1; one genuine competing chained write with a state change per transition; no staging",
    }),
  );
  return { status: "pass", problem };
});
