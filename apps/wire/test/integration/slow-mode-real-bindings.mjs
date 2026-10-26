import assert from "node:assert/strict";
import {
  PackResponseSchema,
  ProblemSlowModeReceiptSchema,
  ProblemSlowModeStateSchema,
} from "@asimposium/contracts";
import { LOCAL_OPERATOR_ID, runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Fable §9.1 / cm5: genuine Workerd HTTP and migrated D1 prove that a
// temporary publication cap is an admission control, not a private-work ban.
// Enrollment and the screening decision use the shared fixture; controls,
// authorization, quotas, replay, batches, expiry and ledger writes are real.
assert.equal(process.versions.bun, undefined, "This lane requires genuine Node");

await runLocalWorkerJourney(
  async ({
    call,
    enroll,
    sponsorCall,
    operatorCall,
    fixtures,
    env,
    worker,
    origin,
    userAgent,
    workerLogs,
  }) => {
    const owner = "usr_slow_mode_owner";
    const outsider = "usr_slow_mode_outsider";
    const creator = await enroll("slow-mode-creator", owner);
    const author = await enroll("slow-mode-author", owner);
    const reviewer = await enroll("slow-mode-reviewer", outsider);
    const authorId = (await call("/v1/hello", undefined, author)).fellow.fellow_id;
    const privateReason =
      "SLOW_MODE_PRIVATE_REASON: allow time to examine the rapidly growing frontier.";
    const template = (kind) => `/v1/${kind}s/problems/:problemId/slow-mode`;
    const path = (kind, problemId) => `/v1/${kind}s/problems/${problemId}/slow-mode`;
    const readPolicy = async (problemId) =>
      ProblemSlowModeStateSchema.parse(
        await operatorCall(
          "GET",
          path("operator", problemId),
          "operator.problem.slow-mode.read",
          undefined,
          200,
          template("operator"),
        ),
      );
    const control = (problemId, body, key, expected = 200, kind = "sponsor", actor = owner) =>
      sponsorCall(
        kind === "operator" ? LOCAL_OPERATOR_ID : actor,
        "POST",
        path(kind, problemId),
        `${kind}.problem.slow-mode.set`,
        { problem_id: problemId, ...body },
        expected,
        template(kind),
        key,
        kind,
      );
    const setBody = (revision, limit, duration = 900_000) => ({
      action: "set",
      expected_revision: revision,
      limit_per_hour: limit,
      expires_at: new Date(Date.now() + duration).toISOString(),
      reason: privateReason,
      step_up_authenticated_at: Math.floor(Date.now() / 1000),
    });
    const request = async (route, body, token, key) => {
      const response = await worker.fetch(`${origin}${route}`, {
        method: "POST",
        headers: {
          "User-Agent": userAgent,
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, headers: response.headers, body: await response.json() };
    };
    const scalar = async (sql, ...bindings) =>
      (
        await env.DB.prepare(sql)
          .bind(...bindings)
          .first()
      ).n;
    const attempts = (problemId) =>
      scalar(
        "SELECT COUNT(*) AS n FROM public_write_attempt_reservations WHERE fellow_id = ? AND problem_id = ?",
        authorId,
        problemId,
      );
    const events = (problemId) =>
      scalar("SELECT COUNT(*) AS n FROM events WHERE problem_id = ?", problemId);
    const historyCount = (problemId) =>
      scalar("SELECT COUNT(*) AS n FROM problem_slow_mode_events WHERE problem_id = ?", problemId);
    const snapshot = async (problemId) => ({
      events: await events(problemId),
      attempts: await attempts(problemId),
      screens: await fixtures.screeningCalls(),
    });
    const limited = (response, limit, remaining) => {
      assert.equal(response.status, 429);
      assert.equal(response.body.code, "PROMOTION_RATE_LIMITED");
      assert.equal(response.body.limit, limit);
      assert.equal(response.body.remaining, remaining);
      assert.equal(response.headers.get("ratelimit-limit"), String(limit));
      assert.equal(response.headers.get("ratelimit-remaining"), String(remaining));
      assert.equal(response.headers.get("retry-after"), String(response.body.retry_after_seconds));
      assert.ok(response.body.retry_after_seconds > 0);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.ok(!JSON.stringify(response.body).includes(privateReason));
    };
    const createProblem = async (upper) => {
      const problemId = (
        await call(
          "/v1/problems",
          {
            title: `Parity on the interval zero through ${upper}`,
            statement: `For every integer n from zero through ${upper}, n squared has the same parity as n.`,
            falsifier: `An integer in zero through ${upper} whose square has the opposite parity.`,
            motivation: "Test the two residue classes with a bounded, explicit statement.",
            areas: ["number-theory"],
          },
          creator,
          201,
        )
      ).problem.id;
      await sponsorCall(
        owner,
        "POST",
        `/v1/sponsors/problems/${problemId}/lifecycle`,
        "problem-lifecycle",
        { action: "publish" },
      );
      const sessionId = (
        await call(
          "/v1/sessions",
          {
            problem_id: problemId,
            intent: "review",
          },
          reviewer,
          201,
        )
      ).session_id;
      await call(
        `/v1/problems/${problemId}/statement-review`,
        {
          session_id: sessionId,
          statement_version: 1,
          verdict: "statement-clear",
          basis: "The finite integer domain and exact parity predicate are explicit.",
        },
        reviewer,
      );
      await call(
        `/v1/sessions/${sessionId}/close`,
        { handback: "The statement is exact." },
        reviewer,
        201,
      );
      return problemId;
    };
    const problem = await createProblem(50);
    const otherProblem = await createProblem(80);
    const session = (
      await call(
        "/v1/sessions",
        {
          problem_id: problem,
          intent: "prove",
        },
        author,
        201,
      )
    ).session_id;
    const pack = async () =>
      PackResponseSchema.parse(
        await call(
          `/v1/sessions/${session}/pack?profile=working&max_tokens=8000`,
          undefined,
          author,
        ),
      );
    const publication = (number) => ({
      kind: "conjecture",
      statement: `${number} squared is even.`,
      falsifier: `${number} squared being odd.`,
      depends_on: [],
      relates_to: [],
    });
    const push = (number) =>
      call(
        `/v1/sessions/${session}/workshop`,
        {
          type: "claim-draft",
          title: `Private calculation for ${number}`,
          body_md: "Private calculations remain writable while public admissions are limited.",
          ledger_intent: { kind: "create", target_kind: "claim" },
          publication: publication(number),
        },
        author,
        201,
      );

    // Signed steward authority, a fresh step-up, a bounded expiry and the
    // current revision are all necessary before a control becomes authoritative.
    assert.deepEqual(await readPolicy(problem), {
      problem_id: problem,
      revision: 0,
      effective_limit_per_hour: 20,
      slow_mode: null,
    });
    const initial = setBody(0, 2);
    const bearerOnly = await request(
      path("sponsor", problem),
      { problem_id: problem, ...initial },
      author,
      "slow-bearer-only",
    );
    assert.ok(
      [401, 403].includes(bearerOnly.status),
      "a Fellow bearer cannot sign a steward control",
    );
    const foreignRead = await sponsorCall(
      outsider,
      "GET",
      path("sponsor", problem),
      "sponsor.problem.slow-mode.read",
      undefined,
      404,
      template("sponsor"),
    );
    assert.equal(foreignRead.code, "MODERATION_TARGET_NOT_FOUND");
    assert.equal(
      (await control(problem, initial, "slow-foreign", 404, "sponsor", outsider)).code,
      "MODERATION_TARGET_NOT_FOUND",
    );
    assert.equal(
      (
        await control(
          problem,
          {
            ...initial,
            problem_id: otherProblem,
          },
          "slow-mismatched-signed-target",
          422,
        )
      ).code,
      "SCHEMA_INVALID",
    );
    assert.equal(
      (
        await control(
          problem,
          {
            ...initial,
            step_up_authenticated_at: initial.step_up_authenticated_at - 901,
          },
          "slow-stale-step-up",
          403,
        )
      ).code,
      "STEP_UP_REQUIRED",
    );
    assert.equal(
      (
        await control(
          problem,
          {
            ...initial,
            expires_at: new Date(Date.now() - 1000).toISOString(),
          },
          "slow-expired-input",
          422,
        )
      ).code,
      "SCHEMA_INVALID",
    );
    assert.equal(
      (await control(problem, setBody(0, 2, 86_460_000), "slow-unbounded", 422)).code,
      "SCHEMA_INVALID",
    );
    assert.equal(await historyCount(problem), 0, "refused controls create no policy history");
    const firstControl = ProblemSlowModeReceiptSchema.parse(
      await control(problem, initial, "slow-steward-set"),
    );
    assert.equal(firstControl.revision, 1);
    assert.equal(firstControl.limit_per_hour, 2);
    assert.deepEqual(await control(problem, initial, "slow-steward-set"), firstControl);
    assert.equal(
      (await control(problem, { ...initial, limit_per_hour: 3 }, "slow-steward-set", 409)).code,
      "IDEMPOTENCY_CONFLICT",
    );
    assert.equal(
      (await control(problem, setBody(0, 3), "slow-obsolete-revision", 409)).code,
      "MODERATION_STATE_CONFLICT",
    );
    assert.equal(await historyCount(problem), 1, "a retried control is one immutable event");
    const activeState = await readPolicy(problem);
    assert.equal(activeState.slow_mode.reason, privateReason);
    assert.equal(activeState.slow_mode.event_id, firstControl.event_id);
    const startingBudget = (await pack()).promotion_budget;
    assert.equal(startingBudget.limit, 2);
    assert.equal(startingBudget.remaining, 2);
    assert.deepEqual(startingBudget.slow_mode, {
      event_id: firstControl.event_id,
      revision: 1,
      expires_at: firstControl.expires_at,
    });
    assert.ok(
      !JSON.stringify(await pack()).includes(privateReason),
      "Fellow packs omit the private reason",
    );

    const firstDraft = await push(2);
    const firstBody = { workshop_id: firstDraft.workshop_id, ...publication(2) };
    const promoted = await request(
      `/v1/sessions/${session}/promote`,
      firstBody,
      author,
      "slow-first-promotion",
    );
    assert.equal(promoted.status, 201);
    assert.equal(await attempts(problem), 1);
    assert.equal((await pack()).promotion_budget.remaining, 1);

    // A two-member batch cannot claim one remaining slot. Session.close's
    // promotion list has the same atomic admission rule and stays open on denial.
    const batchBody = {
      members: [4, 6].map((number, index) => ({
        tempId: `tmp:claim-${index}`,
        action: "claim",
        data: publication(number),
      })),
    };
    let before = await snapshot(problem);
    limited(
      await request(`/v1/p/${problem}/events:batch`, batchBody, author, "slow-batch-too-large"),
      2,
      1,
    );
    assert.deepEqual(await snapshot(problem), before, "batch denial spends no attempt or screen");
    const closeDrafts = [await push(8), await push(10)];
    before = await snapshot(problem);
    limited(
      await request(
        `/v1/sessions/${session}/close`,
        {
          handback: "Continue the private residue calculations later.",
          promote: closeDrafts.map((draft) => draft.workshop_id),
        },
        author,
        "slow-close-too-large",
      ),
      2,
      1,
    );
    assert.deepEqual(
      await snapshot(problem),
      before,
      "close denial has no public prefix or paid work",
    );
    assert.equal(
      (
        await env.DB.prepare("SELECT closed_at FROM sessions WHERE session_id = ?")
          .bind(session)
          .first()
      ).closed_at,
      null,
    );

    // Two real concurrent requests compete for the last slot. The slower
    // classifier makes their overlap observable without fabricating quota rows.
    await fixtures.pauseScreening(1500);
    before = await snapshot(problem);
    const raced = await Promise.all(
      [0, 1].map((index) =>
        request(
          `/v1/p/${problem}/dead-ends`,
          {
            approach: `Race ${index}: infer all integer parities from even inputs.`,
            why_it_fails: `Race ${index}: odd inputs were omitted from the argument.`,
            retry_predicate: `Race ${index}: retry when the odd residue is covered.`,
          },
          author,
          `slow-last-slot-${index}`,
        ),
      ),
    );
    await fixtures.resumeScreening();
    assert.deepEqual(raced.map((response) => response.status).sort(), [201, 429]);
    limited(
      raced.find((response) => response.status === 429),
      2,
      0,
    );
    assert.deepEqual(await snapshot(problem), {
      events: before.events + 1,
      attempts: before.attempts + 1,
      screens: before.screens + 1,
    });
    // The database independently rejects a bypass of application preflight.
    await assert.rejects(
      env.DB.prepare(`
    INSERT INTO public_write_attempt_reservations (
      reservation_id, fellow_id, problem_id, sponsor_id, session_id, route,
      idempotency_key, request_digest, reserved_at, expires_at, sponsor_limit, status
    ) SELECT 'slow-mode-trigger-probe', fellow_id, problem_id, sponsor_id, session_id, route,
        'slow-mode-trigger-probe', request_digest, ?, ?, sponsor_limit, 'reserved'
      FROM public_write_attempt_reservations WHERE fellow_id = ? AND problem_id = ? LIMIT 1
  `)
        .bind(Date.now(), Date.now() + 60_000, authorId, problem)
        .run(),
      /PROMOTION_RATE_LIMIT_EXCEEDED/,
    );
    assert.equal(await attempts(problem), 2);

    // Exhaustion changes executable advice, but not a successful replay,
    // private workshop work, presence, other Fellows, or other problems.
    before = await snapshot(problem);
    const replayed = await request(
      `/v1/sessions/${session}/promote`,
      firstBody,
      author,
      "slow-first-promotion",
    );
    assert.equal(replayed.status, 200);
    assert.deepEqual(replayed.body, promoted.body);
    limited(
      await request(`/v1/p/${problem}/claims`, publication(12), author, "slow-exhausted"),
      2,
      0,
    );
    await call(
      `/v1/sessions/${session}/workshop`,
      {
        type: "scratch",
        title: "Keep investigating",
        body_md: "Test the odd residue privately.",
      },
      author,
      201,
    );
    await call(`/v1/sessions/${session}/heartbeat`, {}, author);
    assert.deepEqual(await snapshot(problem), before);
    const exhaustedPack = await pack();
    assert.equal(exhaustedPack.promotion_budget.remaining, 0);
    const next = await call(`/v1/p/${problem}/next`, undefined, author);
    assert.ok(
      ![next.primary_move, ...(next.alternatives ?? [])].some(
        (move) => move?.move === "state-claim",
      ),
      "exhausted advice does not offer a public claim",
    );
    const otherWrite = await request(
      `/v1/p/${otherProblem}/claims`,
      publication(14),
      author,
      "slow-other-problem",
    );
    assert.equal(otherWrite.status, 201, "a slow problem does not cap another problem");
    const sibling = await enroll("slow-mode-sibling", owner);
    assert.equal(
      (await request(`/v1/p/${problem}/claims`, publication(16), sibling, "slow-other-fellow"))
        .status,
      201,
      "another Fellow has its own allowance under the same sponsor",
    );

    // Admission is durable. Tightening during the paid screen affects the next
    // admission, while this already charged request finishes exactly once.
    const wider = ProblemSlowModeReceiptSchema.parse(
      await control(problem, setBody(1, 3), "slow-operator-wider", 200, "operator"),
    );
    assert.equal(wider.revision, 2);
    before = await snapshot(problem);
    await fixtures.pauseScreening(2000);
    const pending = request(
      `/v1/p/${problem}/claims`,
      publication(18),
      author,
      "slow-already-admitted",
    );
    const screenDeadline = Date.now() + 10_000;
    while ((await fixtures.screeningCalls()) === before.screens && Date.now() < screenDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(
      await fixtures.screeningCalls(),
      before.screens + 1,
      "the admitted request reached screening",
    );
    const tighter = ProblemSlowModeReceiptSchema.parse(
      await control(problem, setBody(2, 1), "slow-tighten-during-screen"),
    );
    assert.equal(tighter.revision, 3);
    const completed = await pending;
    await fixtures.resumeScreening();
    assert.equal(
      completed.status,
      201,
      "a tighter control does not retroactively cancel an admitted write",
    );
    assert.equal(await attempts(problem), 3);
    limited(
      await request(`/v1/p/${problem}/claims`, publication(20), author, "slow-tightened-denial"),
      1,
      0,
    );

    // Expiry is enforced by the read/admission itself, without a cleanup cron.
    // A batch larger than the active limit can recover when the default cap
    // returns; Retry-After must not incorrectly promise an hour-long wait.
    const shortBody = setBody(3, 1, 8000);
    const shortControl = ProblemSlowModeReceiptSchema.parse(
      await control(problem, shortBody, "slow-short-expiry", 200, "operator"),
    );
    before = await snapshot(problem);
    const expiringBatch = await request(
      `/v1/p/${problem}/events:batch`,
      batchBody,
      author,
      "slow-expiring-batch",
    );
    limited(expiringBatch, 1, 0);
    assert.ok(
      expiringBatch.body.retry_after_seconds <= 8,
      "batch recovery honors the policy expiry",
    );
    assert.deepEqual(await snapshot(problem), before);
    const waitMs = Math.max(0, Date.parse(shortControl.expires_at) - Date.now() + 100);
    assert.ok(waitMs <= 8100);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    const expired = await readPolicy(problem);
    assert.equal(expired.revision, 4);
    assert.equal(expired.effective_limit_per_hour, 20);
    assert.equal(expired.slow_mode, null);
    const restored = (await pack()).promotion_budget;
    assert.equal(restored.limit, 20);
    assert.equal(restored.remaining, 17, "expiry retains all prior attempts in the hourly window");
    assert.equal(restored.slow_mode, undefined);
    assert.deepEqual(
      await control(problem, shortBody, "slow-short-expiry", 200, "operator"),
      shortControl,
      "the latest expired receipt replays without renewing its expiry",
    );
    assert.deepEqual(
      await control(problem, initial, "slow-steward-set"),
      firstControl,
      "an old receipt replays without reactivating its superseded policy",
    );
    assert.deepEqual(await readPolicy(problem), expired);
    assert.equal(
      (await request(`/v1/p/${problem}/claims`, publication(22), author, "slow-after-expiry"))
        .status,
      201,
    );
    assert.equal(await attempts(problem), 4);

    const cleared = ProblemSlowModeReceiptSchema.parse(
      await control(
        problem,
        {
          action: "clear",
          expected_revision: 4,
          reason: "The temporary publication pacing has finished.",
          step_up_authenticated_at: Math.floor(Date.now() / 1000),
        },
        "slow-clear",
      ),
    );
    assert.equal(cleared.revision, 5);
    assert.equal(cleared.limit_per_hour, null);
    assert.equal(cleared.expires_at, null);
    assert.equal(await historyCount(problem), 5);
    const audit = (
      await env.DB.prepare(
        "SELECT action, target_id, operator_id FROM operator_audit WHERE target_id = ? ORDER BY seq",
      )
        .bind(problem)
        .all()
    ).results;
    assert.deepEqual(
      audit,
      [
        { action: "problem.slow-mode.set", target_id: problem, operator_id: LOCAL_OPERATOR_ID },
        { action: "problem.slow-mode.set", target_id: problem, operator_id: LOCAL_OPERATOR_ID },
      ],
      "operator controls commit their audit history atomically",
    );
    assert.ok(
      !JSON.stringify(workerLogs()).includes(privateReason),
      "runtime logs never include private rationale",
    );
    await call(
      `/v1/sessions/${session}/close`,
      { handback: "The private calculations are saved." },
      author,
      201,
    );

    console.log(
      JSON.stringify({
        kind: "slow-mode-real-bindings",
        status: "pass",
        signed_steward_and_operator_controls: true,
        bounded_expiry_and_revision_replay: true,
        visible_private_budgets: true,
        concurrent_last_slot_and_database_guard: true,
        atomic_batch_and_close_admission: true,
        admitted_publication_survives_tightening: true,
        private_work_and_other_problem_unchanged: true,
        automatic_expiry_without_attempt_reset: true,
        boundary: "local Workerd/D1/R2; fixture screening and enrollment approval",
      }),
    );
  },
);
