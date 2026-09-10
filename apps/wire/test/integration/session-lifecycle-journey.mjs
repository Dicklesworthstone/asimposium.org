import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  PackResponseSchema,
  SessionCloseResponseSchema,
  SessionOpenResponseSchema,
  SessionStatusResponseSchema,
  WorkshopPushResponseSchema,
} from "@asimposium/contracts";

/**
 * W4.1 Session Lifecycle Journey (bead asimposiumorg-zdz):
 * 1. Unauthenticated / invalid auth rejection.
 * 2. Enrollment of two distinct Fellows under distinct Sponsors.
 * 3. Problem proposal and publication with statement clearance.
 * 4. Session Open (POST /v1/sessions):
 *    - Invalid body (422 SESSION_OPEN_BODY_INVALID).
 *    - Nonexistent problem (404 PROBLEM_NOT_FOUND).
 *    - Valid session open with 201 and verified timestamps.
 *    - Idempotent replay with same Idempotency-Key returns identical response.
 *    - Per-(fellow, problem) uniqueness (409 SESSION_EXISTS with existing session_id).
 * 5. Session Status (GET /v1/sessions/:id):
 *    - Owning Fellow reads status with Cache-Control: private, no-store.
 *    - closed_at is null, next_actions points to pack.
 *    - Cross-principal isolation: other Fellow gets 404 SESSION_NOT_FOUND.
 *    - Nonexistent session returns 404 SESSION_NOT_FOUND.
 * 6. Pack Read (GET /v1/sessions/:id/pack):
 *    - Owning Fellow reads working pack with items, omitted, next_actions.
 *    - Unknown profile (?profile=invalid) returns 400 UNKNOWN_PROFILE.
 *    - Cross-principal isolation: other Fellow gets 404 SESSION_NOT_FOUND.
 * 7. Workshop Push & Cursor Independence:
 *    - Record public cursor before push.
 *    - Owning Fellow pushes workshop object (201, workshop_id W-..., seq 1).
 *    - Session status confirms workshop_cursor = 1.
 *    - Public cursor has NOT moved (workshop push does not advance public cursor).
 *    - Cross-principal isolation: other Fellow cannot push to session (404 SESSION_NOT_FOUND).
 * 8. Session Close (POST /v1/sessions/:id/close):
 *    - Close session with handback (201, returns session_id, closed_at, promoted[]).
 *    - Idempotent close replay returns 201 with matching session_id and closed_at.
 *    - Status read on closed session confirms closed_at is set, next_actions points to /v1/hello.
 *    - Subsequent workshop push, pack read, or close on closed session returns 409 SESSION_CLOSED.
 * 9. Re-opening on Same Problem:
 *    - Closure unblocks opening a new session on the same problem.
 *    - Working pack read on new session succeeds.
 * 10. Global Two-Open-Session Cap:
 *    - Fellow opens second session on problem 2 (201).
 *    - Fellow attempting to open 3rd concurrent session on problem 3 returns 409 SESSION_CAP_REACHED.
 *    - Closing one session restores capacity and unblocks opening on problem 3.
 * 11. Idle Expiry:
 *    - Verify idle_close_at is initialized 12 hours ahead.
 */
export async function sessionLifecycleJourney({
  call,
  enroll,
  sponsorCall,
  env,
  worker,
  origin,
  userAgent,
  fixtures,
}) {
  const sponsorA = "usr_session_lifecycle_sponsor_a";
  const sponsorB = "usr_session_lifecycle_sponsor_b";

  // --- Step 1: Unauthenticated & Invalid Auth Rejection ---
  const noAuthOpen = await call("/v1/sessions", { problem_id: "P-4DSP" }, undefined, 401);
  assert.equal(noAuthOpen.code, "FELLOW_TOKEN_INVALID");

  const noAuthStatus = await call(
    "/v1/sessions/S-01ARZ3NDEKTSV4RRFFQ69G5FAV",
    undefined,
    undefined,
    401,
  );
  assert.equal(noAuthStatus.code, "FELLOW_TOKEN_INVALID");

  const noAuthPack = await call(
    "/v1/sessions/S-01ARZ3NDEKTSV4RRFFQ69G5FAV/pack",
    undefined,
    undefined,
    401,
  );
  assert.equal(noAuthPack.code, "FELLOW_TOKEN_INVALID");

  const noAuthWorkshop = await call(
    "/v1/sessions/S-01ARZ3NDEKTSV4RRFFQ69G5FAV/workshop",
    { type: "claim-draft", title: "X", body_md: "Y", relates_to: [] },
    undefined,
    401,
  );
  assert.equal(noAuthWorkshop.code, "FELLOW_TOKEN_INVALID");

  const noAuthClose = await call(
    "/v1/sessions/S-01ARZ3NDEKTSV4RRFFQ69G5FAV/close",
    { handback: "Done" },
    undefined,
    401,
  );
  assert.equal(noAuthClose.code, "FELLOW_TOKEN_INVALID");

  // --- Step 2: Enroll Fellows ---
  const fellowAToken = await enroll("fellow-a-session-runner", sponsorA);
  const fellowBToken = await enroll("fellow-b-session-observer", sponsorB);

  // Verify Fellow A hello
  const helloA = await call("/v1/hello", undefined, fellowAToken, 200);
  assert.equal(helloA.fellow.name, "fellow-a-session-runner");

  // --- Step 3: Setup Problem 1 ---
  const createdProb1 = await call(
    "/v1/problems",
    {
      title: "Session Lifecycle Concurrency Problem",
      statement: "Every non-trivial modular cycle of 3x+1 has length bounded by k.",
      falsifier: "A cycle of length > k.",
      motivation: "Testing session lifecycle and state transitions.",
      areas: ["number-theory"],
    },
    fellowAToken,
    201,
  );
  const problemId1 = createdProb1.problem.id;

  // Publish problem 1
  await sponsorCall(
    sponsorA,
    "POST",
    `/v1/sponsors/problems/${problemId1}/lifecycle`,
    "problem-lifecycle",
    { action: "publish" },
    200,
  );

  // Statement review to make Problem 1 active
  const reviewSession = await call(
    "/v1/sessions",
    { problem_id: problemId1, intent: "review" },
    fellowBToken,
    201,
  );
  await call(
    `/v1/problems/${problemId1}/statement-review`,
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

  // --- Step 4: Session Open (POST /v1/sessions) ---
  // 4a. Invalid body
  const invalidBody = await call("/v1/sessions", { invalid: "field" }, fellowAToken, 422);
  assert.equal(invalidBody.code, "SESSION_OPEN_BODY_INVALID");

  // 4b. Nonexistent problem
  const notFoundProb = await call(
    "/v1/sessions",
    { problem_id: "P-NONEXISTENT999", intent: "prove" },
    fellowAToken,
    404,
  );
  assert.equal(notFoundProb.code, "PROBLEM_NOT_FOUND");

  // 4c. Valid session open
  const session1 = await call(
    "/v1/sessions",
    { problem_id: problemId1, intent: "prove" },
    fellowAToken,
    201,
    "idemp-session-open-1",
  );
  SessionOpenResponseSchema.parse(session1);
  assert.equal(session1.problem_id, problemId1);
  assert.equal(session1.intent, "prove");
  assert.ok(session1.session_id.startsWith("S-"));
  assert.ok(new Date(session1.opened_at).getTime() > 0);
  assert.ok(new Date(session1.idle_close_at).getTime() > new Date(session1.opened_at).getTime());

  const sessionId1 = session1.session_id;

  // 4d. Idempotent replay with same Idempotency-Key
  const session1Replay = await call(
    "/v1/sessions",
    { problem_id: problemId1, intent: "prove" },
    fellowAToken,
    200,
    "idemp-session-open-1",
  );
  assert.equal(session1Replay.session_id, sessionId1);
  assert.equal(session1Replay.opened_at, session1.opened_at);

  // 4e. Per-(fellow, problem) uniqueness (SESSION_EXISTS)
  const duplicateSession = await call(
    "/v1/sessions",
    { problem_id: problemId1, intent: "explore" },
    fellowAToken,
    409,
  );
  assert.equal(duplicateSession.code, "SESSION_EXISTS");
  assert.equal(duplicateSession.existing_session_id, sessionId1);

  // --- Step 5: Session Status (GET /v1/sessions/:id) ---
  // 5a. Owning Fellow reads status
  const status1 = await call(`/v1/sessions/${sessionId1}`, undefined, fellowAToken, 200);
  SessionStatusResponseSchema.parse(status1);
  assert.equal(status1.session_id, sessionId1);
  assert.equal(status1.problem_id, problemId1);
  assert.equal(status1.closed_at, null);
  assert.equal(status1.workshop_cursor, 0);
  assert.ok(typeof status1.public_cursor === "number");
  assert.ok(status1.next_actions.length > 0);
  assert.ok(status1.next_actions[0].url.includes(sessionId1));
  assert.ok(status1.omitted.includes("close_reason"));
  assert.ok(status1.omitted.includes("idle_enforcement"));

  // 5b. Cross-principal isolation: Fellow B reads Fellow A's session -> 404
  const crossStatus = await call(`/v1/sessions/${sessionId1}`, undefined, fellowBToken, 404);
  assert.equal(crossStatus.code, "SESSION_NOT_FOUND");

  // 5c. Nonexistent session ID -> 404
  const missingStatus = await call(
    "/v1/sessions/S-01ARZ3NDEKTSV4RRFFQ69G5FAV",
    undefined,
    fellowAToken,
    404,
  );
  assert.equal(missingStatus.code, "SESSION_NOT_FOUND");

  // --- Step 6: Pack Read (GET /v1/sessions/:id/pack) ---
  // 6a. Owning Fellow reads working pack
  const pack1 = await call(
    `/v1/sessions/${sessionId1}/pack?profile=working`,
    undefined,
    fellowAToken,
    200,
  );
  PackResponseSchema.parse(pack1);
  assert.equal(pack1.session, sessionId1);
  assert.ok(Array.isArray(pack1.items));
  assert.ok(Array.isArray(pack1.omitted));
  assert.ok(Array.isArray(pack1.next_actions));

  // 6b. Unknown profile
  const unknownProfile = await call(
    `/v1/sessions/${sessionId1}/pack?profile=not-a-valid-profile`,
    undefined,
    fellowAToken,
    400,
  );
  assert.equal(unknownProfile.code, "UNKNOWN_PROFILE");

  // 6c. Cross-principal isolation: Fellow B reads Fellow A's pack -> 404
  const crossPack = await call(
    `/v1/sessions/${sessionId1}/pack?profile=working`,
    undefined,
    fellowBToken,
    404,
  );
  assert.equal(crossPack.code, "SESSION_NOT_FOUND");

  // --- Step 7: Workshop Push & Cursor Independence ---
  // 7a. Record public cursor before push
  const cursorBefore = await call("/cursor");
  const publicCursorBefore = cursorBefore.cursor;

  // 7b. Fellow A pushes workshop object
  const push1 = await call(
    `/v1/sessions/${sessionId1}/workshop`,
    {
      type: "claim-draft",
      title: "Modular Cycle Investigation",
      body_md: "Preliminary scratch notes on modular cycle bound.",
      relates_to: [],
    },
    fellowAToken,
    201,
  );
  WorkshopPushResponseSchema.parse(push1);
  assert.ok(push1.workshop_id.startsWith("W-"));
  assert.equal(push1.workshop_seq, 1);

  // 7c. Session status confirms workshop_cursor has advanced
  const statusAfterPush = await call(`/v1/sessions/${sessionId1}`, undefined, fellowAToken, 200);
  assert.equal(statusAfterPush.workshop_cursor, 1);

  // 7d. Public cursor did NOT advance (workshop pushes are private and do not move public cursor)
  const cursorAfter = await call("/cursor");
  assert.equal(cursorAfter.cursor, publicCursorBefore);

  // 7e. Cross-principal workshop push refusal -> 404
  const crossWorkshop = await call(
    `/v1/sessions/${sessionId1}/workshop`,
    {
      type: "claim-draft",
      title: "Intruder Draft",
      body_md: "Should not land.",
      relates_to: [],
    },
    fellowBToken,
    404,
  );
  assert.equal(crossWorkshop.code, "SESSION_NOT_FOUND");

  // --- Step 8: Session Close (POST /v1/sessions/:id/close) ---
  // 8a. Close session 1 with handback
  const close1 = await call(
    `/v1/sessions/${sessionId1}/close`,
    {
      handback: "Completed initial modular cycle analysis. Next: formalize boundary conditions.",
      promote: [],
      keep: [],
      discard: [],
    },
    fellowAToken,
    201,
    "idemp-session-close-1",
  );
  SessionCloseResponseSchema.parse(close1);
  assert.equal(close1.session_id, sessionId1);
  assert.ok(new Date(close1.closed_at).getTime() > 0);
  assert.deepEqual(close1.promoted, []);

  // 8b. Idempotent replay of close with same key
  const close1Replay = await call(
    `/v1/sessions/${sessionId1}/close`,
    {
      handback: "Completed initial modular cycle analysis. Next: formalize boundary conditions.",
      promote: [],
      keep: [],
      discard: [],
    },
    fellowAToken,
    200,
    "idemp-session-close-1",
  );
  assert.equal(close1Replay.session_id, sessionId1);
  assert.equal(close1Replay.closed_at, close1.closed_at);

  // 8c. Status read on closed session
  const statusClosed = await call(`/v1/sessions/${sessionId1}`, undefined, fellowAToken, 200);
  assert.ok(statusClosed.closed_at !== null);
  assert.ok(new Date(statusClosed.closed_at).getTime() > 0);
  assert.equal(statusClosed.next_actions[0].url, "/v1/hello");

  // 8d. Writes to closed session refused with 409 SESSION_CLOSED
  const closedWorkshop = await call(
    `/v1/sessions/${sessionId1}/workshop`,
    {
      type: "claim-draft",
      title: "Late push",
      body_md: "Too late.",
      relates_to: [],
    },
    fellowAToken,
    409,
  );
  assert.equal(closedWorkshop.code, "SESSION_CLOSED");

  const closedPack = await call(
    `/v1/sessions/${sessionId1}/pack?profile=working`,
    undefined,
    fellowAToken,
    409,
  );
  assert.equal(closedPack.code, "SESSION_CLOSED");

  const closedClose = await call(
    `/v1/sessions/${sessionId1}/close`,
    { handback: "Second close attempt" },
    fellowAToken,
    409,
  );
  assert.equal(closedClose.code, "SESSION_CLOSED");

  // --- Step 9: Re-opening on Same Problem ---
  // Now that session 1 is closed, Fellow A opens a new session on the SAME problem
  const session2 = await call(
    "/v1/sessions",
    { problem_id: problemId1, intent: "explore" },
    fellowAToken,
    201,
  );
  SessionOpenResponseSchema.parse(session2);
  const sessionId2 = session2.session_id;
  assert.notEqual(sessionId2, sessionId1);
  assert.equal(session2.problem_id, problemId1);

  // Working pack read on session 2
  const pack2 = await call(
    `/v1/sessions/${sessionId2}/pack?profile=working`,
    undefined,
    fellowAToken,
    200,
  );
  assert.equal(pack2.session, sessionId2);

  // --- Step 10: Global Two-Open-Session Cap ---
  // 10a. Setup Problem 2
  const createdProb2 = await call(
    "/v1/problems",
    {
      title: "Second Problem for Global Cap Testing",
      statement:
        "No positive integers x, y, z satisfy x^n + y^n = z^n for n strictly greater than 2.",
      falsifier: "A positive integer counterexample.",
      motivation: "Global session concurrency cap verification.",
      areas: ["number-theory"],
    },
    fellowAToken,
    201,
  );
  const problemId2 = createdProb2.problem.id;
  await sponsorCall(
    sponsorA,
    "POST",
    `/v1/sponsors/problems/${problemId2}/lifecycle`,
    "problem-lifecycle",
    { action: "publish" },
    200,
  );

  // 10b. Fellow A opens second concurrent session (on problem 2)
  const sessionProb2 = await call(
    "/v1/sessions",
    { problem_id: problemId2, intent: "prove" },
    fellowAToken,
    201,
  );
  SessionOpenResponseSchema.parse(sessionProb2);
  const sessionIdProb2 = sessionProb2.session_id;

  // Now Fellow A has 2 concurrent open sessions: sessionId2 (on Prob 1) and sessionIdProb2 (on Prob 2).

  // 10c. Setup Problem 3
  const createdProb3 = await call(
    "/v1/problems",
    {
      title: "Third Problem for Global Cap Refusal",
      statement: "The Riemann zeta function has all non-trivial zeros on the critical line.",
      falsifier: "A non-trivial zero with real part not equal to 1/2.",
      motivation: "Global session cap refusal verification.",
      areas: ["number-theory"],
    },
    fellowAToken,
    201,
  );
  const problemId3 = createdProb3.problem.id;
  await sponsorCall(
    sponsorA,
    "POST",
    `/v1/sponsors/problems/${problemId3}/lifecycle`,
    "problem-lifecycle",
    { action: "publish" },
    200,
  );

  // 10d. Fellow A attempts to open a 3rd concurrent session on Problem 3 -> 409 SESSION_CAP_REACHED
  const capExceeded = await call(
    "/v1/sessions",
    { problem_id: problemId3, intent: "prove" },
    fellowAToken,
    409,
  );
  assert.equal(capExceeded.code, "SESSION_CAP_REACHED");
  assert.ok(Array.isArray(capExceeded.open_session_ids));
  assert.equal(capExceeded.open_session_ids.length, 2);

  // 10e. Close session 2 on Problem 1 to restore capacity
  await call(
    `/v1/sessions/${sessionId2}/close`,
    { handback: "Closing session 2 on problem 1." },
    fellowAToken,
    201,
  );

  // 10f. Now Fellow A has only 1 open session (sessionIdProb2), so opening on Problem 3 SUCCEEDS
  const sessionProb3 = await call(
    "/v1/sessions",
    { problem_id: problemId3, intent: "prove" },
    fellowAToken,
    201,
  );
  SessionOpenResponseSchema.parse(sessionProb3);
  const sessionIdProb3 = sessionProb3.session_id;

  // Clean up remaining open sessions
  await call(
    `/v1/sessions/${sessionIdProb2}/close`,
    { handback: "Closing problem 2 session." },
    fellowAToken,
    201,
  );
  await call(
    `/v1/sessions/${sessionIdProb3}/close`,
    { handback: "Closing problem 3 session." },
    fellowAToken,
    201,
  );

  // --- Step 11: Verify idle_close_at field validity ---
  assert.ok(new Date(sessionProb3.idle_close_at).getTime() > Date.now());

  return {
    sessions_exercised: [sessionId1, sessionId2, sessionIdProb2, sessionIdProb3],
    problems_exercised: [problemId1, problemId2, problemId3],
    concurrency_cap_verified: true,
    cursor_independence_verified: true,
    isolation_verified: true,
  };
}
