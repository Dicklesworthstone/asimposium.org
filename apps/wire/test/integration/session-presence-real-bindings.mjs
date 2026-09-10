import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  SessionHeartbeatResponseSchema,
  SessionOpenResponseSchema,
  SessionStatusResponseSchema,
} from "@asimposium/contracts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

assert.equal(process.versions.bun, undefined, "This lane requires genuine Node");

export async function sessionPresenceJourney({ call, enroll, sponsorCall }) {
  const sponsorA = "usr_presence_sponsor_a";
  const sponsorB = "usr_presence_sponsor_b";

  // 1. Unauthenticated heartbeat rejection (401 FELLOW_TOKEN_INVALID)
  const noAuth = await call(
    "/v1/sessions/S-01ARZ3NDEKTSV4RRFFQ69G5FAV/heartbeat",
    {},
    undefined,
    401,
  );
  assert.equal(noAuth.code, "FELLOW_TOKEN_INVALID");

  // 2. Enroll two distinct Fellows under distinct Sponsors
  const fellowAToken = await enroll("fellow-presence-runner-a", sponsorA);
  const fellowBToken = await enroll("fellow-presence-runner-b", sponsorB);

  // 3. Missing session heartbeat rejection (404 SESSION_NOT_FOUND)
  const missingSession = await call(
    "/v1/sessions/S-01ARZ3NDEKTSV4RRFFQ69G5FAV/heartbeat",
    {},
    fellowAToken,
    404,
  );
  assert.equal(missingSession.code, "SESSION_NOT_FOUND");

  // 4. Propose and publish problem P-PRESENCE
  const createdProb = await call(
    "/v1/problems",
    {
      title: "Presence and Heartbeat Test Problem",
      statement: "Testing heartbeat presence renewal and leases.",
      falsifier: "A falsification condition for presence.",
      motivation: "Testing session heartbeat and leases.",
      areas: ["number-theory"],
    },
    fellowAToken,
    201,
  );
  const problemId = createdProb.problem.id;
  assert.ok(problemId);

  // Sponsor publish problem
  await sponsorCall(
    sponsorA,
    "POST",
    `/v1/sponsors/problems/${problemId}/lifecycle`,
    "problem-lifecycle",
    { action: "publish" },
    200,
  );

  // Statement review to clear problem
  const reviewSession = await call(
    "/v1/sessions",
    { problem_id: problemId, intent: "review" },
    fellowBToken,
    201,
  );
  await call(
    `/v1/problems/${problemId}/statement-review`,
    {
      session_id: reviewSession.session_id,
      statement_version: 1,
      verdict: "statement-clear",
      basis: "Valid formulation.",
    },
    fellowBToken,
    200,
  );
  await call(
    `/v1/sessions/${reviewSession.session_id}/close`,
    { handback: "Review complete." },
    fellowBToken,
    201,
  );

  // 5. Open session for Fellow A
  const sessionA = await call(
    "/v1/sessions",
    { problem_id: problemId, intent: "explore" },
    fellowAToken,
    201,
    "presence-open-session-key",
  );
  const parsedOpen = SessionOpenResponseSchema.parse(sessionA);
  const sessionIdA = parsedOpen.session_id;
  assert.ok(sessionIdA);

  // Check initial status
  const initialStatus = await call(`/v1/sessions/${sessionIdA}`, undefined, fellowAToken, 200);
  const parsedStatus = SessionStatusResponseSchema.parse(initialStatus);
  const initialPublicCursor = parsedStatus.public_cursor;

  // 6. Cross-principal isolation: Fellow B cannot heartbeat Fellow A's session (404)
  const crossPrincipal = await call(`/v1/sessions/${sessionIdA}/heartbeat`, {}, fellowBToken, 404);
  assert.equal(crossPrincipal.code, "SESSION_NOT_FOUND");

  // 7. Invalid request body with extra fields (422 SESSION_HEARTBEAT_BODY_INVALID)
  const invalidBody = await call(
    `/v1/sessions/${sessionIdA}/heartbeat`,
    { unexpected_field: true },
    fellowAToken,
    422,
  );
  assert.equal(invalidBody.code, "SESSION_HEARTBEAT_BODY_INVALID");
  assert.equal(invalidBody.rule, "A5");

  // 8. Valid heartbeat from Fellow A with empty body ({})
  const hb1 = await call(`/v1/sessions/${sessionIdA}/heartbeat`, {}, fellowAToken, 200);
  const parsedHb1 = SessionHeartbeatResponseSchema.parse(hb1);
  assert.equal(parsedHb1.session_id, sessionIdA);
  assert.equal(parsedHb1.renewed_leases.length, 0);
  assert.ok(
    new Date(parsedHb1.last_heartbeat_at).getTime() >= new Date(parsedOpen.opened_at).getTime(),
  );
  assert.ok(new Date(parsedHb1.idle_close_at).getTime() > Date.now() + 11 * 3600 * 1000);

  // Check public cursor has NOT moved
  const statusAfterHb1 = await call(`/v1/sessions/${sessionIdA}`, undefined, fellowAToken, 200);
  const parsedStatusAfterHb1 = SessionStatusResponseSchema.parse(statusAfterHb1);
  assert.equal(parsedStatusAfterHb1.public_cursor, initialPublicCursor);

  // 9. Lease renewal via heartbeat
  // Fellow A asks a question
  const questionRes = await call(
    `/v1/sessions/${sessionIdA}/questions`,
    {
      body_md: "Is the presence lease renewed automatically by the session heartbeat?",
      target_refs: [],
    },
    fellowAToken,
    201,
    "presence-q-1",
  );
  assert.equal(questionRes.ok, true);
  const questionId = questionRes.question_id;

  // Fellow A leases the question
  const leaseRes = await call(
    `/v1/sessions/${sessionIdA}/questions/${questionId}/lease`,
    {
      ttl_seconds: 1800,
    },
    fellowAToken,
    200,
    "presence-lease-1",
  );
  assert.equal(leaseRes.ok, true);
  assert.equal(leaseRes.question_id, questionId);

  // Fellow A pulses heartbeat -> active lease should be renewed
  const hb2 = await call(`/v1/sessions/${sessionIdA}/heartbeat`, {}, fellowAToken, 200);
  const parsedHb2 = SessionHeartbeatResponseSchema.parse(hb2);
  assert.equal(parsedHb2.session_id, sessionIdA);
  assert.deepEqual(parsedHb2.renewed_leases, [questionId]);
  assert.ok(
    new Date(parsedHb2.last_heartbeat_at).getTime() >=
      new Date(parsedHb1.last_heartbeat_at).getTime(),
  );

  // 10. Close session and verify subsequent heartbeat rejection (409 SESSION_CLOSED)
  const closeRes = await call(
    `/v1/sessions/${sessionIdA}/close`,
    {
      handback: "Completed presence and lease testing.",
      promote: [],
      keep: [],
      discard: [],
    },
    fellowAToken,
    201,
    "presence-close-key",
  );
  assert.equal(closeRes.session_id, sessionIdA);

  const closedHeartbeat = await call(`/v1/sessions/${sessionIdA}/heartbeat`, {}, fellowAToken, 409);
  assert.equal(closedHeartbeat.code, "SESSION_CLOSED");

  return {
    kind: "session-presence-journey",
    status: "pass",
    session_id: sessionIdA,
    problem_id: problemId,
    question_id: questionId,
    last_heartbeat_at: parsedHb2.last_heartbeat_at,
  };
}

await runLocalWorkerJourney(sessionPresenceJourney)
  .then((receipt) => {
    console.log(
      JSON.stringify({
        kind: "session-presence-real-bindings-complete",
        status: "pass",
        receipt,
      }),
    );
    process.exit(0);
  })
  .catch((err) => {
    console.error(
      JSON.stringify({
        kind: "session-presence-real-bindings-complete",
        status: "fail",
        error: err instanceof Error ? err.message : String(err),
        error_sha256: createHash("sha256")
          .update(err instanceof Error ? err.message : typeof err)
          .digest("hex"),
      }),
    );
    process.exit(1);
  });
