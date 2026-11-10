import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EnrollmentHelloResponseSchema } from "@asimposium/contracts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Fable §7.10: the private-work admission limit precedes storage, is shared
// across a Fellow's sessions, and does not consume capacity on receipt replay.
// HTTP, Workerd, migrated D1 and R2 are real. Identity approval, active problems
// and the explicit timestamp advance below are local fixtures, not hosted proof.
await runLocalWorkerJourney(
  async ({ call, enroll, fixtures, env, worker, origin, userAgent }) => {
    const sponsor = "usr_workshop_quota";
    const token = await enroll("workshop-quota-author", sponsor);
    const peerToken = await enroll("workshop-quota-peer", sponsor);
    const problems = ["P-WORKSHOP-QUOTA", "P-WORKSHOP-QUOTA-OTHER"];
    for (const problem of problems) await fixtures.seedProblem(problem, sponsor);
    const open = (credential, problem) =>
      call("/v1/sessions", { problem_id: problem, intent: "explore" }, credential, 201);
    const [session, otherSession, peerSession] = await Promise.all([
      open(token, problems[0]),
      open(token, problems[1]),
      open(peerToken, problems[0]),
    ]);
    const path = (context) => `/v1/sessions/${context.session_id}/workshop`;
    const hello = async (credential = token) =>
      EnrollmentHelloResponseSchema.parse(await call("/v1/hello", undefined, credential));
    const initialHello = await hello();
    const fellowId = initialHello.fellow.fellow_id;
    assert.deepEqual(initialHello.workshop_budget, {
      limit: 60,
      remaining: 60,
      window_seconds: 60,
    });
    const request = async (context, body, key, credential = token) => {
      const response = await worker.fetch(`${origin}${path(context)}`, {
        method: "POST",
        headers: {
          "User-Agent": userAgent,
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, headers: response.headers, body: await response.json() };
    };
    const draft = (label, large = false) => ({
      type: "scratch",
      title: `Private workshop calculation ${label}`,
      body_md: large
        ? `${label}\n${"Private finite-case calculation, retained for the next session.\n".repeat(40)}`
        : `Private finite-case notes ${label}.`,
    });
    const stored = async (body) =>
      (await env.ARTIFACTS.head(
        `cas/sha256/${createHash("sha256").update(body).digest("hex")}`,
      )) !== null;
    const count = async (table) =>
      (
        await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE fellow_id = ?`)
          .bind(fellowId)
          .first()
      ).n;
    const persisted = async () => ({
      objects: await count("workshop_objects"),
      revisions: await count("workshop_revisions"),
      admissions: await count("workshop_write_attempts"),
    });
    const limited = (response) => {
      assert.equal(response.status, 429);
      assert.equal(response.body.code, "RATE_LIMITED");
      assert.equal(response.body.limit, 60);
      assert.equal(response.body.remaining, 0);
      assert.equal(response.body.window_seconds, 60);
      assert.ok(response.body.retry_after_seconds >= 1 && response.body.retry_after_seconds <= 60);
      assert.equal(response.headers.get("retry-after"), String(response.body.retry_after_seconds));
      assert.equal(response.headers.get("ratelimit-limit"), "60");
      assert.equal(response.headers.get("ratelimit-remaining"), "0");
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.equal(typeof response.body.fix_hint, "string");
    };

    const original = draft("first", true);
    const first = await request(session, original, "workshop-quota-first");
    assert.equal(first.status, 201);
    assert.equal(await stored(original.body_md), true);
    assert.equal((await hello()).workshop_budget.remaining, 59);
    const firstState = await persisted();
    const replay = await request(session, original, "workshop-quota-first");
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, first.body);
    assert.deepEqual(await persisted(), firstState);
    const changed = draft("changed-replay", true);
    assert.equal((await request(session, changed, "workshop-quota-first")).status, 409);
    assert.equal(await stored(changed.body_md), false);
    assert.deepEqual(await persisted(), firstState);

    const revision = {
      workshop_id: first.body.workshop_id,
      base_version: first.body.version,
      body_md: draft("revision", true).body_md,
    };
    const revised = await request(otherSession, revision, "workshop-quota-wrong-problem");
    assert.equal(revised.status, 404, "authorization and object scope precede admission");
    assert.deepEqual(await persisted(), firstState);
    const acceptedRevision = await request(session, revision, "workshop-quota-revision");
    assert.equal(acceptedRevision.status, 201);
    assert.equal(acceptedRevision.body.version, first.body.version + 1);
    assert.equal((await hello()).workshop_budget.remaining, 58);

    // Fill the same rolling budget through both sessions, then race for its
    // final two slots. Real concurrent D1 admissions must not oversubscribe it.
    for (let index = 0; index < 56; index++) {
      const result = await request(
        index % 2 === 0 ? session : otherSession,
        draft(`fill-${index}`),
        `workshop-quota-fill-${index}`,
      );
      assert.equal(result.status, 201);
    }
    assert.equal((await hello()).workshop_budget.remaining, 2);
    const contenders = Array.from({ length: 8 }, (_, index) => draft(`race-${index}`, true));
    const outcomes = await Promise.all(
      contenders.map((body, index) =>
        request(index % 2 === 0 ? session : otherSession, body, `workshop-quota-race-${index}`),
      ),
    );
    assert.equal(outcomes.filter((response) => response.status === 201).length, 2);
    assert.equal(outcomes.filter((response) => response.status === 429).length, 6);
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status === 429) limited(outcome);
      assert.equal(
        await stored(contenders[index].body_md),
        outcome.status === 201,
        "a refused request does not write its body to R2",
      );
    }
    const exhausted = await persisted();
    assert.deepEqual(exhausted, { objects: 59, revisions: 60, admissions: 60 });
    assert.equal((await hello()).workshop_budget.remaining, 0);
    assert.equal((await hello(peerToken)).workshop_budget.remaining, 60);

    const deniedCreate = draft("denied-create", true);
    limited(await request(otherSession, deniedCreate, "workshop-quota-denied-create"));
    const deniedRevision = {
      ...revision,
      base_version: acceptedRevision.body.version,
      body_md: draft("denied-revision", true).body_md,
    };
    limited(await request(session, deniedRevision, "workshop-quota-denied-revision"));
    for (const body of [deniedCreate, deniedRevision])
      assert.equal(await stored(body.body_md), false);
    assert.deepEqual(await persisted(), exhausted);
    const fullReplay = await request(session, revision, "workshop-quota-revision");
    assert.equal(
      fullReplay.status,
      200,
      "the exhausted budget does not block completed receipt replay",
    );
    assert.deepEqual(fullReplay.body, acceptedRevision.body);
    assert.deepEqual(await persisted(), exhausted);
    assert.equal(
      (await request(peerSession, draft("peer"), "workshop-quota-peer", peerToken)).status,
      201,
      "another Fellow retains its independent private-work budget",
    );

    // An explicit local time fixture expires every admitted attempt without
    // sleeping. The read and subsequent write must apply the same rolling cut.
    await env.DB.prepare(
      "UPDATE workshop_write_attempts SET admitted_at = admitted_at - 60001 WHERE fellow_id = ?",
    )
      .bind(fellowId)
      .run();
    assert.equal((await hello()).workshop_budget.remaining, 60);
    assert.equal((await request(session, deniedCreate, "workshop-quota-after-window")).status, 201);
    assert.equal((await hello()).workshop_budget.remaining, 59);
    assert.equal(await count("workshop_write_attempts"), 1);

    // Storage failure must not turn into an unlimited-write fallback. This
    // trigger exists only in the isolated lane database and intercepts admission.
    await env.DB.prepare(`CREATE TRIGGER workshop_quota_storage_fault
      BEFORE INSERT ON workshop_write_attempts BEGIN
        SELECT RAISE(ABORT, 'local workshop quota storage fault');
      END`).run();
    const beforeFault = await persisted();
    const deniedByFault = draft("quota-storage-fault", true);
    const fault = await request(session, deniedByFault, "workshop-quota-storage-fault");
    assert.equal(fault.status, 503);
    assert.equal(await stored(deniedByFault.body_md), false);
    assert.deepEqual(await persisted(), beforeFault);

    console.log(
      JSON.stringify({
        kind: "workshop-quota-real-bindings",
        status: "pass",
        rolling_limit: 60,
        concurrent_final_slots: { admitted: 2, refused: 6 },
        create_and_revision_refused_before_r2: true,
        completed_replay_free_at_limit: true,
        cross_session_budget_and_peer_isolation: true,
        storage_failure_closed: true,
        proof_scope:
          "local Workerd/D1/R2; fixture approval and explicit timestamp advance; no deployed claim",
      }),
    );
  },
  { projectionParitySeeded: (problem) => problem.startsWith("P-WORKSHOP-QUOTA") },
);
