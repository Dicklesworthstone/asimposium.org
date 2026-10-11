import assert from "node:assert/strict";
import { EventBatchResponseSchema } from "@asimposium/contracts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

assert.equal(process.versions.bun, undefined, "This lane requires genuine Node");

await runLocalWorkerJourney(
  async ({ call, enroll, sponsorCall, env, worker, origin, userAgent }) => {
    const sponsor = "usr_batch_replay_author";
    const author = await enroll("batch-replay-author", sponsor);
    const reviewer = await enroll("batch-replay-reviewer", "usr_batch_replay_reviewer");
    const problem = (
      await call(
        "/v1/problems",
        {
          title: "Recoverable single-event batch publications",
          statement: "Every integer in zero through one hundred has a square of the same parity.",
          falsifier: "An integer in the stated interval whose square has the opposite parity.",
          motivation: "A public scientific write must survive a lost batch acknowledgement.",
          areas: ["number-theory"],
        },
        author,
        201,
      )
    ).problem.id;
    await sponsorCall(
      sponsor,
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
        basis: "A finite interval and exact parity predicate.",
      },
      reviewer,
    );
    await call(
      `/v1/sessions/${reviewSession}/close`,
      { handback: "The statement is exact." },
      reviewer,
      201,
    );

    const hypothesis = (tempId, tag) => ({
      tempId,
      action: "hypothesis",
      data: {
        route: `Enumerate parity residues for ${tag}.`,
        mechanism: `Each residue modulo two retains parity when squared for ${tag}.`,
        falsifier: `A squared residue with opposite parity for ${tag}.`,
        origin: "proposed",
        body_md: `Check both residue classes for ${tag}.`,
      },
    });
    const deadEnd = (tempId, tag) => ({
      tempId,
      action: "dead-end",
      data: {
        approach: `Sample only even inputs for ${tag}.`,
        why_it_fails: `The odd residue is untested for ${tag}.`,
        retry_predicate: `A complete odd-residue check for ${tag}.`,
      },
    });
    const attempt = async (key, member) => {
      const response = await worker.fetch(`${origin}/v1/p/${problem}/events:batch`, {
        method: "POST",
        headers: {
          "User-Agent": userAgent,
          authorization: `Bearer ${author}`,
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: JSON.stringify({ members: [member] }),
      });
      const raw = await response.text();
      const body = JSON.parse(raw);
      // The shared typed conflict is a no-store problem response. Successful
      // receipts and internal-failure retry guidance retain private, no-store.
      const isConflict = response.status === 409 && body.code === "IDEMPOTENCY_CONFLICT";
      assert.equal(
        response.headers.get("cache-control"),
        isConflict ? "no-store" : "private, no-store",
      );
      if (response.status >= 400) {
        assert.match(response.headers.get("content-type") ?? "", /^application\/problem\+json\b/);
        console.log(
          JSON.stringify({
            stage: "batch-replay-refusal",
            status: response.status,
            code: body.code,
          }),
        );
      }
      return { status: response.status, raw, body };
    };
    const eventCount = async () =>
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE problem_id = ?")
          .bind(problem)
          .first()
      ).n;

    for (const variant of ["temp-id", "action"]) {
      const before = await eventCount();
      const first = hypothesis("tmp:first", variant);
      const second =
        variant === "temp-id" ? hypothesis("tmp:second", variant) : deadEnd("tmp:second", variant);
      const outcomes = await Promise.all([
        attempt(`batch-race-${variant}`, first),
        attempt(`batch-race-${variant}`, second),
      ]);
      assert.deepEqual(outcomes.map(({ status }) => status).sort(), [201, 409]);
      assert.equal(outcomes.find(({ status }) => status === 409).body.code, "IDEMPOTENCY_CONFLICT");
      EventBatchResponseSchema.parse(outcomes.find(({ status }) => status === 201).body);
      assert.equal(await eventCount(), before + 1, `${variant}: one public event`);
    }

    const identicalBefore = await eventCount();
    const identicalMember = hypothesis("tmp:same", "identical contenders");
    const identical = await Promise.all([
      attempt("batch-identical", identicalMember),
      attempt("batch-identical", identicalMember),
    ]);
    assert.deepEqual(identical.map(({ status }) => status).sort(), [200, 201]);
    assert.equal(
      identical[0].raw,
      identical[1].raw,
      "identical contenders receive exact wrapper bytes",
    );
    EventBatchResponseSchema.parse(identical[0].body);
    assert.equal(await eventCount(), identicalBefore + 1);

    // Both old INSERT-based receipts and the new CAS finalizer would fail this
    // storage fault after member commit. An internal pending reservation passes.
    for (const operation of ["INSERT", "UPDATE"]) {
      await env.DB.prepare(`CREATE TRIGGER batch_receipt_fail_${operation.toLowerCase()}
      BEFORE ${operation} ON session_write_replays
      WHEN NEW.scope = 'events_batch' AND NEW.claim_token IS NULL
      BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_BATCH_RECEIPT_FAILURE'); END`).run();
    }
    const session = (
      await call("/v1/sessions", { problem_id: problem, intent: "prove" }, author, 201)
    ).session_id;
    const member = {
      tempId: "tmp:durable-claim",
      action: "claim",
      data: {
        kind: "conjecture",
        statement: "A square retains the residue of its integer base modulo two.",
        falsifier: "An integer whose square and base have different residues modulo two.",
      },
    };
    const beforeFailure = await eventCount();
    const failed = await attempt("batch-recovery", member);
    assert.equal(failed.status, 500);
    assert.equal(failed.body.code, "INTERNAL_ERROR");
    assert.ok(
      !failed.raw.includes("events-batch-pending-v1"),
      "pending state is never a public receipt",
    );
    assert.equal(
      await eventCount(),
      beforeFailure + 1,
      "the member committed before the receipt fault",
    );
    const publication = await env.DB.prepare(
      "SELECT object_id, seq FROM events WHERE problem_id = ? AND type = 'claim.created' ORDER BY seq DESC LIMIT 1",
    )
      .bind(problem)
      .first();
    assert.ok(publication);
    // Simulate an older pending admission whose clock expired after this
    // later member committed. The member's own 24h replay must still own it.
    await env.DB.prepare(
      "UPDATE session_write_replays SET expires_at = 0 WHERE scope = 'events_batch' AND idempotency_key = 'batch-recovery'",
    ).run();
    for (const changed of [
      { ...member, tempId: "tmp:other" },
      deadEnd(member.tempId, "pending identity"),
    ]) {
      const refused = await attempt("batch-recovery", changed);
      assert.equal(refused.status, 409);
      assert.equal(refused.body.code, "IDEMPOTENCY_CONFLICT");
      assert.equal(
        await eventCount(),
        beforeFailure + 1,
        "a pending invocation still owns its whole request",
      );
    }
    await call(
      `/v1/sessions/${session}/close`,
      { handback: "The public member committed; only its wrapper receipt needs recovery." },
      author,
      201,
    );
    const sessionsBeforeRecovery = (
      await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first()
    ).n;
    for (const operation of ["insert", "update"]) {
      await env.DB.prepare(`DROP TRIGGER batch_receipt_fail_${operation}`).run();
    }
    const recovered = await attempt("batch-recovery", member);
    assert.equal(recovered.status, 200);
    assert.deepEqual(EventBatchResponseSchema.parse(recovered.body).results, [
      {
        tempId: member.tempId,
        action: "claim",
        id: publication.object_id,
        seq: publication.seq,
        version: 1,
      },
    ]);
    assert.equal(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first()).n,
      sessionsBeforeRecovery,
      "recovery does not open a new session",
    );
    assert.equal(await eventCount(), beforeFailure + 1);
    assert.equal((await attempt("batch-recovery", member)).raw, recovered.raw);

    // Expiry releases only the observed outer invocation. The new invocation
    // must receive a fresh opaque member key, despite the old member's receipt.
    await env.DB.prepare(
      "UPDATE session_write_replays SET expires_at = 0 WHERE scope = 'events_batch' AND idempotency_key = 'batch-recovery'",
    ).run();
    const freshMember = hypothesis("tmp:after-expiry", "expired outer key");
    const fresh = await attempt("batch-recovery", freshMember);
    assert.equal(fresh.status, 201);
    EventBatchResponseSchema.parse(fresh.body);
    assert.equal(await eventCount(), beforeFailure + 2);
    assert.equal((await attempt("batch-recovery", freshMember)).raw, fresh.raw);
    assert.equal((await attempt("batch-recovery", member)).status, 409);

    console.log(
      JSON.stringify({
        stage: "single-member-batch-replay",
        status: "pass",
        boundaries: [
          "full-outer-identity",
          "one-member-effect",
          "closed-session-recovery",
          "24h-reuse",
        ],
        proof:
          "local Workerd and real D1; outer receipt storage failure after a real member transaction",
      }),
    );
  },
);
