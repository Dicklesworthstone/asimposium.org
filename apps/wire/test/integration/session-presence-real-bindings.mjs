import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  SessionHeartbeatResponseSchema,
  SessionOpenResponseSchema,
  SessionStatusResponseSchema,
  SponsorLeaseListResponseSchema,
  SponsorLeaseReleaseResponseSchema,
} from "@asimposium/contracts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";
import { assertRacedWriteLeavesNoTrace } from "./raced-ledger-write.mjs";

assert.equal(process.versions.bun, undefined, "This lane requires genuine Node");

export async function sessionPresenceJourney({ call, enroll, sponsorCall, env, fixtures }) {
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
  await assertRacedWriteLeavesNoTrace({
    env,
    fixtures,
    problemId,
    label: "object lease acquire",
    attempt: () =>
      call(
        `/v1/sessions/${sessionIdA}/leases`,
        {
          object: questionId,
          objective: "Check the boundary case",
          deliverable: "A scoped review",
          ttl_seconds: 1800,
        },
        fellowAToken,
        null,
        "lease-raced-key-1",
      ),
    observe: () =>
      env.DB.prepare(
        "SELECT lease_id, status, leased_until FROM leases WHERE problem_id = ? ORDER BY lease_id",
      )
        .bind(problemId)
        .all()
        .then((result) => result.results),
  });
  const objectLease = await call(
    `/v1/sessions/${sessionIdA}/leases`,
    {
      object: questionId,
      objective: "Check the boundary case",
      deliverable: "A scoped review",
      ttl_seconds: 1800,
    },
    fellowAToken,
    201,
  );
  // uwr8: a sponsor release without a reason is not screened, so only the
  // event guard keeps a raced release from releasing the lease with no event.
  await assertRacedWriteLeavesNoTrace({
    env,
    fixtures,
    problemId,
    label: "sponsor lease release",
    attempt: () =>
      sponsorCall(
        sponsorA,
        "POST",
        "/v1/sponsors/leases/release",
        "lease.release",
        { problem_id: problemId, object: questionId },
        [409, 500],
      ),
    observe: () =>
      env.DB.prepare(
        "SELECT lease_id, status, released_by FROM leases WHERE problem_id = ? ORDER BY lease_id",
      )
        .bind(problemId)
        .all()
        .then((result) => result.results),
  });

  const snapshot = async (sessionId, problem) => {
    const [session, questions, leases, cursor] = await env.DB.batch([
      env.DB.prepare(
        "SELECT last_heartbeat_at, idle_close_at FROM sessions WHERE session_id = ?",
      ).bind(sessionId),
      env.DB.prepare(
        "SELECT question_id, leased_until FROM questions WHERE problem_id = ? ORDER BY question_id",
      ).bind(problem),
      env.DB.prepare(
        "SELECT lease_id, leased_until FROM leases WHERE session_id = ? ORDER BY lease_id",
      ).bind(sessionId),
      env.DB.prepare("SELECT public_seq FROM problems WHERE id = ?").bind(problem),
    ]);
    return [session.results, questions.results, leases.results, cursor.results];
  };

  // Fellow A pulses heartbeat -> active lease should be renewed
  const hb2 = await call(
    `/v1/sessions/${sessionIdA}/heartbeat`,
    {},
    fellowAToken,
    200,
    "presence-pulse-2",
  );
  const parsedHb2 = SessionHeartbeatResponseSchema.parse(hb2);
  assert.equal(parsedHb2.session_id, sessionIdA);
  assert.deepEqual(parsedHb2.renewed_leases, [questionId, objectLease.lease.object].sort());

  // Lease-expiry warning (1e7): the production sweep warns the holder once per
  // lease term, inside the window only, privately, and a repeat adds nothing.
  {
    assert.equal(typeof fixtures.warnLeasesTick, "function", "the production sweep is wired");
    const { leased_until: leasedUntil } = await env.DB.prepare(
      "SELECT leased_until FROM leases WHERE lease_id = ?",
    )
      .bind(objectLease.lease.lease_id)
      .first();
    const deadline = Date.parse(leasedUntil);
    const warnings = async () =>
      (await call("/v1/inbox", undefined, fellowAToken)).items.filter(
        (item) =>
          item.type === "lease_expiry_warning" && item.target_id === objectLease.lease.lease_id,
      );
    assert.equal((await fixtures.warnLeasesTick(deadline - 30 * 60_000)).warned, 0, "not yet");
    assert.deepEqual(await warnings(), []);
    const inside = deadline - 10 * 60_000;
    const [first, raced] = await Promise.all([
      fixtures.warnLeasesTick(inside),
      fixtures.warnLeasesTick(inside),
    ]);
    assert.equal(first.warned + raced.warned >= 1, true);
    assert.equal((await fixtures.warnLeasesTick(inside + 60_000)).warned, 0, "one per term");
    const warned = await warnings();
    assert.equal(warned.length, 1, "exactly one warning for the lease term");
    assert.equal(warned[0].expires_at, deadline, "the warning expires with the lease");
    assert.ok(warned[0].next_actions?.every((action) => !action.url.includes("/release")));
  }
  assert.ok(
    new Date(parsedHb2.last_heartbeat_at).getTime() >=
      new Date(parsedHb1.last_heartbeat_at).getTime(),
  );
  const afterPulse = await snapshot(sessionIdA, problemId);
  const duplicates = await Promise.all(
    Array.from({ length: 3 }, () =>
      call(`/v1/sessions/${sessionIdA}/heartbeat`, {}, fellowAToken, 200, "presence-pulse-2"),
    ),
  );
  for (const duplicate of duplicates) assert.deepEqual(duplicate, hb2);
  assert.deepEqual(await snapshot(sessionIdA, problemId), afterPulse);
  const concurrent = await Promise.all(
    Array.from({ length: 3 }, () =>
      call(
        `/v1/sessions/${sessionIdA}/heartbeat`,
        {},
        fellowAToken,
        200,
        "presence-concurrent-pulse",
      ),
    ),
  );
  for (const response of concurrent) assert.deepEqual(response, concurrent[0]);
  const afterConcurrent = await snapshot(sessionIdA, problemId);
  assert.deepEqual(afterConcurrent[0], [
    {
      last_heartbeat_at: concurrent[0].last_heartbeat_at,
      idle_close_at: concurrent[0].idle_close_at,
    },
  ]);
  assert.deepEqual(afterConcurrent[3], afterPulse[3]);

  // An expired lease remains unchanged while screening holds the challenge.
  const challenger = await call(
    "/v1/sessions",
    { problem_id: problemId, intent: "explore" },
    fellowBToken,
    201,
  );
  await env.DB.prepare("UPDATE leases SET leased_until = ? WHERE lease_id = ?")
    .bind("2000-01-01T00:00:00.000Z", objectLease.lease.lease_id)
    .run();
  const challengePath = `/v1/sessions/${challenger.session_id}/leases/${questionId}/challenge`;
  const challengeBody = { reason: "The lease expired without a completed boundary check." };
  const challengeSnapshot = async () => {
    const results = await env.DB.batch([
      env.DB.prepare("SELECT status, challenge_reason FROM leases WHERE lease_id = ?").bind(
        objectLease.lease.lease_id,
      ),
      env.DB.prepare("SELECT id, type FROM events WHERE problem_id = ? ORDER BY seq").bind(
        problemId,
      ),
      env.DB.prepare("SELECT public_seq FROM problems WHERE id = ?").bind(problemId),
      env.DB.prepare(
        "SELECT s.event_id FROM screening_publications s JOIN events e ON e.id = s.event_id WHERE e.problem_id = ? ORDER BY e.seq",
      ).bind(problemId),
    ]);
    return results.map((result) => result.results);
  };
  const beforeChallenge = await challengeSnapshot();
  const beforeChallengeScreens = await fixtures.screeningCalls();
  await fixtures.setScreenMode("quarantine");
  const held = await call(
    challengePath,
    challengeBody,
    fellowBToken,
    202,
    "presence-challenge-held",
  );
  assert.equal(held.code, "SCREENING_HOLD");
  assert.deepEqual(await challengeSnapshot(), beforeChallenge);
  assert.equal(await fixtures.screeningCalls(), beforeChallengeScreens + 1);

  await fixtures.setScreenMode("pass");
  const challenged = await call(
    challengePath,
    challengeBody,
    fellowBToken,
    200,
    "presence-challenge-pass",
  );
  assert.equal(challenged.status, "challenged");
  assert.equal(challenged.lease_id, objectLease.lease.lease_id);
  assert.equal(challenged.ok, true);
  const afterChallenge = await challengeSnapshot();
  assert.deepEqual(afterChallenge[0], [
    { status: "challenged", challenge_reason: challengeBody.reason },
  ]);
  assert.deepEqual(afterChallenge[1].slice(0, -1), beforeChallenge[1]);
  const challengeEvent = afterChallenge[1].at(-1);
  assert.equal(challengeEvent.type, "lease.challenged");
  assert.deepEqual(afterChallenge[2], [{ public_seq: beforeChallenge[2][0].public_seq + 1 }]);
  assert.deepEqual(afterChallenge[3], [...beforeChallenge[3], { event_id: challengeEvent.id }]);
  assert.equal(await fixtures.screeningCalls(), beforeChallengeScreens + 2);
  assert.deepEqual(
    await call(challengePath, challengeBody, fellowBToken, 200, "presence-challenge-pass"),
    challenged,
  );
  assert.deepEqual(await challengeSnapshot(), afterChallenge);
  assert.equal(await fixtures.screeningCalls(), beforeChallengeScreens + 2);

  // A challenge is a recorded concern, never an early transfer of an
  // unexpired reservation. Exercise the idle-holder path through real HTTP.
  const protectedRequest = {
    object: questionId,
    objective: "Independently check the boundary while retaining coordination.",
    deliverable: "A scoped boundary calculation.",
  };
  const protectedLease = (
    await call(`/v1/sessions/${challenger.session_id}/leases`, protectedRequest, fellowBToken, 201)
  ).lease;
  await env.DB.prepare("UPDATE sessions SET last_heartbeat_at = ? WHERE session_id = ?")
    .bind(new Date(Date.now() - 31 * 60_000).toISOString(), challenger.session_id)
    .run();
  const challengedUnexpired = await call(
    `/v1/sessions/${sessionIdA}/leases/${protectedLease.lease_id}/challenge`,
    { reason: "The holder is idle; request coordination without taking the reservation." },
    fellowAToken,
    200,
    "presence-unexpired-challenge",
  );
  const conflict = await call(
    `/v1/sessions/${sessionIdA}/leases`,
    protectedRequest,
    fellowAToken,
    409,
  );
  assert.equal(conflict.code, "LEASED", "a challenge never transfers an unexpired lease");
  const challengedList = await call(
    `/v1/sessions/${challenger.session_id}/leases`,
    undefined,
    fellowBToken,
  );
  assert.equal(challengedList.leases.length, 1);
  assert.equal(challengedList.leases[0].lease_id, protectedLease.lease_id);
  assert.equal(challengedList.leases[0].status, "challenged");
  assert.equal(challengedList.leases[0].challenge_reason, challengedUnexpired.reason);
  const challengedPack = await call(
    `/v1/sessions/${challenger.session_id}/pack?profile=working&max_tokens=8000`,
    undefined,
    fellowBToken,
  );
  assert.equal(
    JSON.parse(challengedPack.items.find((item) => item.id === protectedLease.lease_id).body)
      .status,
    "challenged",
  );
  const renewedChallenge = SessionHeartbeatResponseSchema.parse(
    await call(`/v1/sessions/${challenger.session_id}/heartbeat`, {}, fellowBToken),
  );
  assert.ok(renewedChallenge.renewed_leases.includes(questionId));
  const retainedChallenge = await env.DB.prepare(
    "SELECT status, leased_until, challenge_reason FROM leases WHERE lease_id = ?",
  )
    .bind(protectedLease.lease_id)
    .first();
  assert.equal(retainedChallenge.status, "challenged");
  assert.equal(retainedChallenge.challenge_reason, challengedUnexpired.reason);
  assert.ok(Date.parse(retainedChallenge.leased_until) >= Date.parse(protectedLease.leased_until));
  const challengedOwnerPage = SponsorLeaseListResponseSchema.parse(
    await sponsorCall(sponsorB, "POST", "/v1/sponsors/leases", "lease.list", {}),
  );
  assert.deepEqual(
    challengedOwnerPage.leases.map((lease) => [lease.lease_id, lease.status]),
    [[protectedLease.lease_id, "challenged"]],
  );
  const sponsorReleasedChallenge = await sponsorCall(
    sponsorB,
    "POST",
    "/v1/sponsors/leases/release",
    "lease.release",
    { problem_id: problemId, object: protectedLease.lease_id },
    200,
  );
  assert.equal(sponsorReleasedChallenge.status, "released");
  const closingLease = (
    await call(`/v1/sessions/${sessionIdA}/leases`, protectedRequest, fellowAToken, 201)
  ).lease;
  await env.DB.prepare("UPDATE sessions SET last_heartbeat_at = ? WHERE session_id = ?")
    .bind(new Date(Date.now() - 31 * 60_000).toISOString(), sessionIdA)
    .run();
  await call(
    `/v1/sessions/${challenger.session_id}/leases/${closingLease.lease_id}/challenge`,
    { reason: "The replacement holder is idle; its session close must release this reservation." },
    fellowBToken,
    200,
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
  assert.deepEqual(
    await env.DB.prepare("SELECT status FROM leases WHERE lease_id = ?")
      .bind(closingLease.lease_id)
      .first(),
    { status: "released" },
    "closing the holder's session releases challenged reservations",
  );

  const closedHeartbeat = await call(`/v1/sessions/${sessionIdA}/heartbeat`, {}, fellowAToken, 409);
  assert.equal(closedHeartbeat.code, "SESSION_CLOSED");
  const afterClose = await snapshot(sessionIdA, problemId);
  assert.deepEqual(
    await call(`/v1/sessions/${sessionIdA}/heartbeat`, {}, fellowAToken, 200, "presence-pulse-2"),
    hb2,
  );
  assert.deepEqual(await snapshot(sessionIdA, problemId), afterClose);

  for (const mutation of ["close", "revoke", "pause", "release"]) {
    const sponsor = `usr_heartbeat_race_${mutation}`;
    const token = await enroll(`heartbeat-race-${mutation}`, sponsor);
    const problem = `P-HB-${mutation.toUpperCase()}`;
    await fixtures.seedProblem(problem, sponsor);
    const session = await call(
      "/v1/sessions",
      { problem_id: problem, intent: "explore" },
      token,
      201,
    );
    const id = session.session_id;
    const question = await call(
      `/v1/sessions/${id}/questions`,
      {
        body_md: "Does this boundary case need an independent check?",
        target_refs: [],
      },
      token,
      201,
    );
    await call(
      `/v1/sessions/${id}/questions/${question.question_id}/lease`,
      { ttl_seconds: 1800 },
      token,
      200,
    );
    await call(
      `/v1/sessions/${id}/leases`,
      {
        object: question.question_id,
        objective: "Check the boundary",
        deliverable: "A scoped review",
        ttl_seconds: 1800,
      },
      token,
      201,
    );
    const before = await snapshot(id, problem);
    const key = `presence-race-${mutation}`;
    const result = await fixtures.heartbeatAfterPrecheck(token, id, key, mutation);
    assert.equal(result.changed, true, "race must occur after route reads and before its batch");
    assert.equal(
      result.status,
      mutation === "close" ? 409 : 403,
      JSON.stringify({ mutation, diagnosis: result.body }),
    );
    assert.deepEqual(await snapshot(id, problem), before, "losing pulse must renew nothing");
    const replay = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM session_write_replays WHERE scope = 'session_heartbeat' AND idempotency_key = ?",
    )
      .bind(key)
      .first();
    assert.equal(replay.n, 0, "refused pulse must not retain a successful replay");
  }

  // Sponsor recovery is a real signed administrative path, including a paused
  // Fellow. Retrying the old exact lease must never release a new reservation
  // acquired on the same object after that first command committed.
  const recoverySponsor = "usr_sponsor_lease_recovery";
  const recoveryToken = await enroll("sponsor-lease-recovery-fellow", recoverySponsor);
  const recoveryProblem = "P-SPONSOR-LEASE-RECOVERY";
  await fixtures.seedProblem(recoveryProblem, recoverySponsor);
  const recoverySession = await call(
    "/v1/sessions",
    { problem_id: recoveryProblem, intent: "explore" },
    recoveryToken,
    201,
  );
  const recoveryQuestion = await call(
    `/v1/sessions/${recoverySession.session_id}/questions`,
    { body_md: "Which boundary cases need an independent check?", target_refs: [] },
    recoveryToken,
    201,
  );
  const acquireRecoveryLease = () =>
    call(
      `/v1/sessions/${recoverySession.session_id}/leases`,
      {
        object: recoveryQuestion.question_id,
        objective: "Check the boundary cases",
        deliverable: "A scoped review with a counterexample attempt",
      },
      recoveryToken,
      201,
    );
  const recoveryLease = (await acquireRecoveryLease()).lease;
  const listPath = "/v1/sponsors/leases";
  const releasePath = "/v1/sponsors/leases/release";
  const list = async (sponsor = recoverySponsor) =>
    SponsorLeaseListResponseSchema.parse(
      await sponsorCall(sponsor, "POST", listPath, "lease.list", {}),
    );
  const releaseExact = (lease, sponsor = recoverySponsor, expected = 200) =>
    sponsorCall(
      sponsor,
      "POST",
      releasePath,
      "lease.release",
      { problem_id: recoveryProblem, object: lease.lease_id },
      expected,
      releasePath,
      `console-lease-release-${lease.lease_id}`,
    );
  const publicState = () =>
    env.DB.prepare("SELECT public_seq FROM problems WHERE id = ?").bind(recoveryProblem).first();
  const beforeReads = await publicState();
  const ownerPage = await list();
  assert.equal(ownerPage.sponsor_id, recoverySponsor);
  assert.equal(ownerPage.leases.length, 1);
  assert.equal(ownerPage.leases[0].lease_id, recoveryLease.lease_id);
  assert.equal(ownerPage.leases[0].object, recoveryLease.object);
  assert.equal(ownerPage.next_cursor, null);
  assert.ok(!JSON.stringify(ownerPage).includes(recoveryLease.objective));
  assert.deepEqual((await list(sponsorB)).leases, []);
  assert.deepEqual(await publicState(), beforeReads, "private discovery appends no public event");
  const denied = await releaseExact(recoveryLease, sponsorB, 403);
  assert.equal(denied.code, "NOT_LESSEE_SPONSOR");
  const firstRelease = SponsorLeaseReleaseResponseSchema.parse(await releaseExact(recoveryLease));
  assert.equal(firstRelease.lease_id, recoveryLease.lease_id);
  assert.equal(firstRelease.released_by, recoverySponsor);
  assert.deepEqual((await list()).leases, []);

  const replacementLease = (await acquireRecoveryLease()).lease;
  assert.notEqual(replacementLease.lease_id, recoveryLease.lease_id);
  assert.equal(replacementLease.object, recoveryLease.object);
  const beforeRetry = await publicState();
  assert.deepEqual(await releaseExact(recoveryLease), firstRelease);
  assert.deepEqual(
    await publicState(),
    beforeRetry,
    "an old retry appends no second release event",
  );
  const replacementPage = await list();
  assert.deepEqual(
    replacementPage.leases.map((lease) => lease.lease_id),
    [replacementLease.lease_id],
  );
  const releaseEvents = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM events WHERE problem_id = ? AND type = 'lease.released'",
  )
    .bind(recoveryProblem)
    .first();
  assert.equal(releaseEvents.n, 1);

  await sponsorCall(recoverySponsor, "POST", "/v1/fellows/lifecycle", "fellow.lifecycle.change", {
    fellow_id: recoveryLease.fellow_id,
    status: "paused",
    confirm: "change-fellow-lifecycle",
    step_up_authenticated_at: Math.floor(Date.now() / 1000),
  });
  assert.deepEqual(
    (await list()).leases.map((lease) => lease.lease_id),
    [replacementLease.lease_id],
  );
  const pausedRelease = SponsorLeaseReleaseResponseSchema.parse(
    await releaseExact(replacementLease),
  );
  assert.equal(pausedRelease.lease_id, replacementLease.lease_id);
  assert.deepEqual(await releaseExact(replacementLease), pausedRelease);
  assert.deepEqual((await list()).leases, []);
  const replacementSession = await call(
    "/v1/sessions",
    { problem_id: recoveryProblem, intent: "explore" },
    fellowBToken,
    201,
  );
  const resumedWork = await call(
    `/v1/sessions/${replacementSession.session_id}/leases`,
    {
      object: recoveryQuestion.question_id,
      objective: "Independently check the boundary cases",
      deliverable: "A scoped independent review",
    },
    fellowBToken,
    201,
  );
  assert.equal(resumedWork.lease.sponsor_id, sponsorB);
  assert.equal(resumedWork.lease.object, recoveryLease.object);
  assert.equal(resumedWork.lease.status, "active");

  return {
    kind: "session-presence-journey",
    status: "pass",
    exact_replays: 4,
    concurrent_same_key_requests: 3,
    atomic_races: ["close", "revoke", "pause", "release"],
    lease_challenge_screening: ["held-without-publication", "pass-with-provenance", "exact-replay"],
    challenged_lease_coordination: [
      "no-force-steal",
      "holder-and-sponsor-visibility",
      "pack-status",
      "heartbeat-preserves-challenge",
      "sponsor-release",
      "session-close-release",
    ],
    sponsor_lease_recovery: [
      "private-owner-list",
      "other-sponsor-refused",
      "exact-id-replay",
      "replacement-preserved",
      "paused-fellow-release",
      "work-reserved-by-another-fellow",
    ],
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
        // The error class tells an assertion failure from a broken harness.
        error_code: typeof err?.code === "string" ? err.code : (err?.name ?? null),
        error: err instanceof Error ? err.message : String(err),
        error_sha256: createHash("sha256")
          .update(err instanceof Error ? err.message : typeof err)
          .digest("hex"),
      }),
    );
    process.exit(1);
  });
