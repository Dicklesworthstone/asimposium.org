import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  EventBatchResponseSchema,
  ScreeningPromotionDeniedResponseSchema,
  ScreeningPromotionHoldResponseSchema,
} from "@asimposium/contracts";
import { EventTailResponseSchema } from "../../../../packages/contracts/src/event-tail.ts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

assert.equal(process.versions.bun, undefined, "This lane requires genuine Node");

await runLocalWorkerJourney(
  async ({ call, enroll, sponsorCall, env, fixtures, worker, origin, userAgent }) => {
    const sponsor = "usr_atomic_batch_author";
    const author = await enroll("atomic-batch-author", sponsor);
    const reviewer = await enroll("atomic-batch-reviewer", "usr_atomic_batch_reviewer");
    const problem = (
      await call(
        "/v1/problems",
        {
          title: "Atomic hypothesis and evidence checkpoints",
          statement: "Every integer in zero through one hundred has a square of the same parity.",
          falsifier: "An integer in the stated interval whose square has the opposite parity.",
          motivation:
            "A hypothesis and its observations must publish together or leave no public prefix.",
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
      { action: "publish" },
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
        route: `Enumerate the two parity residues for ${tag}.`,
        mechanism: `Squaring preserves each residue modulo two for ${tag}.`,
        falsifier: `A squared residue with opposite parity for ${tag}.`,
        origin: "proposed",
        body_md: `Check both residue classes for ${tag}.`,
      },
    });
    const evidence = (tempId, target) => ({
      tempId,
      action: "evidence",
      data: {
        bears_on_kind: "hypothesis",
        bears_on_id: target,
        direction: "informs",
        kind: "argument",
        source: { kind: "model_memory" },
        mode: "exploratory",
        body_md: "Even squares are divisible by two and odd squares have residue one.",
      },
    });
    const checkpoint = (tag) => [
      hypothesis("tmp:route", tag),
      evidence("tmp:observation", "tmp:route"),
    ];
    const attempt = async (token, key, members) => {
      const res = await worker.fetch(`${origin}/v1/p/${problem}/events:batch`, {
        method: "POST",
        headers: {
          "User-Agent": userAgent,
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: JSON.stringify({ members }),
      });
      const raw = await res.text();
      const body = JSON.parse(raw);
      if (res.status === 200 || res.status === 201) {
        assert.equal(res.headers.get("cache-control"), "private, no-store");
        EventBatchResponseSchema.parse(body);
      } else if (res.status === 403 && body.code === "POLICY_DENIED") {
        ScreeningPromotionDeniedResponseSchema.parse(body);
        assert.match(res.headers.get("content-type") ?? "", /^application\/json\b/);
        assert.equal(res.headers.get("cache-control"), "private, no-store");
      } else if (res.status === 202 && body.code === "SCREENING_HOLD") {
        ScreeningPromotionHoldResponseSchema.parse(body);
        assert.match(res.headers.get("content-type") ?? "", /^application\/json\b/);
        assert.equal(res.headers.get("cache-control"), "private, no-store");
      } else {
        assert.match(res.headers.get("content-type") ?? "", /^application\/problem\+json\b/);
        assert.ok(res.headers.get("cache-control")?.includes("no-store"));
        assert.ok(
          !raw.includes("events-batch-pending-v1"),
          "pending intent is never a public receipt",
        );
        console.log(
          JSON.stringify({ stage: "atomic-batch-refusal", status: res.status, code: body.code }),
        );
      }
      return { status: res.status, raw, body };
    };
    const scalar = async (sql, ...bindings) =>
      (
        await env.DB.prepare(sql)
          .bind(...bindings)
          .first()
      ).n;
    const snapshot = async () => {
      const tables = {};
      for (const table of [
        "events",
        "hypotheses",
        "evidence",
        "integrity_checkpoints",
        "idempotency",
      ])
        tables[table] = await scalar(
          `SELECT COUNT(*) AS n FROM ${table} WHERE problem_id = ?`,
          problem,
        );
      tables.event_content = await scalar(
        "SELECT COUNT(*) AS n FROM event_content c JOIN events e ON e.id = c.event_id WHERE e.problem_id = ?",
        problem,
      );
      tables.screening_publications = await scalar(
        "SELECT COUNT(*) AS n FROM screening_publications p JOIN events e ON e.id = p.event_id WHERE e.problem_id = ?",
        problem,
      );
      tables.public_cursor = await scalar(
        "SELECT cursor AS n FROM public_cursor WHERE singleton = 1",
      );
      return {
        tables,
        head: await env.DB.prepare("SELECT public_seq, chain_digest FROM problems WHERE id = ?")
          .bind(problem)
          .first(),
      };
    };
    const waitForScreens = async (target) => {
      const deadline = Date.now() + 15_000;
      while ((await fixtures.screeningCalls()) < target && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(
        await fixtures.screeningCalls(),
        target,
        "the intended screening boundary was reached",
      );
    };

    // A reversed declaration resolves only typed references. Public prose that
    // happens to equal a temporary ID is untouched; the parent is hash-bound.
    const authorSession = (
      await call("/v1/sessions", { problem_id: problem, intent: "prove" }, author, 201)
    ).session_id;
    const members = checkpoint("linked checkpoint").reverse();
    members[1].data.body_md = "tmp:route";
    const firstBefore = await snapshot();
    const firstScreens = await fixtures.screeningCalls();
    const first = await attempt(author, "atomic-linked", members);
    assert.equal(first.status, 201);
    assert.deepEqual(
      first.body.results.map((item) => item.tempId),
      ["tmp:route", "tmp:observation"],
    );
    assert.deepEqual(
      first.body.results.map((item) => item.seq),
      [firstBefore.head.public_seq + 1, firstBefore.head.public_seq + 2],
    );
    assert.equal(await fixtures.screeningCalls(), firstScreens + 2);
    const rows = (
      await env.DB.prepare(`SELECT e.id, e.seq, e.object_id, e.payload_sha256, e.created_at,
    e.actor_fellow_id, e.actor_sponsor_id, e.actor_session_id, c.payload_json
    FROM events e JOIN event_content c ON c.event_id = e.id
    WHERE e.problem_id = ? AND e.seq > ? ORDER BY e.seq`)
        .bind(problem, firstBefore.head.public_seq)
        .all()
    ).results;
    assert.equal(rows.length, 2, "one event per member and no wrapper event");
    assert.equal(JSON.parse(rows[0].payload_json).body_md, "tmp:route");
    assert.deepEqual(JSON.parse(rows[0].payload_json).caused_by, []);
    const expectedCause = {
      scope: "problem",
      scope_id: problem,
      event_id: rows[0].id,
      seq: rows[0].seq,
    };
    assert.deepEqual(JSON.parse(rows[1].payload_json).caused_by, [expectedCause]);
    assert.equal(JSON.parse(rows[1].payload_json).bears_on_id, rows[0].object_id);
    assert.equal(rows[0].actor_sponsor_id, sponsor);
    assert.equal(rows[0].actor_fellow_id, rows[1].actor_fellow_id);
    assert.equal(rows[0].actor_session_id, rows[1].actor_session_id);
    assert.equal(rows[0].actor_session_id, authorSession);
    assert.equal(rows[0].created_at, rows[1].created_at);
    for (const row of rows)
      assert.equal(createHash("sha256").update(row.payload_json).digest("hex"), row.payload_sha256);
    const firstAfter = await snapshot();
    assert.equal(firstAfter.tables.public_cursor, firstBefore.tables.public_cursor + 2);
    assert.equal(firstAfter.tables.hypotheses, firstBefore.tables.hypotheses + 1);
    assert.equal(firstAfter.tables.evidence, firstBefore.tables.evidence + 1);
    assert.equal(
      firstAfter.tables.screening_publications,
      firstBefore.tables.screening_publications + 2,
    );
    const tail = EventTailResponseSchema.parse(
      await call(`/p/${problem}/events.json?since=${firstBefore.head.public_seq}&limit=16`),
    );
    assert.deepEqual(
      tail.events.map((entry) => entry.event.caused_by),
      [[], [expectedCause]],
    );
    assert.ok(tail.events.every((entry) => entry.event.causality_omitted === null));
    const publicHypotheses = await call(`/p/${problem}/hypotheses.json`);
    assert.ok(
      JSON.stringify(publicHypotheses).includes(rows[0].object_id),
      "the new hypothesis has its public face",
    );

    // A response lost by the caller is recovered from the committed outer
    // receipt after the attributed session closes, before any new session work.
    await call(
      `/v1/sessions/${rows[0].actor_session_id}/close`,
      { handback: "The checkpoint is published." },
      author,
      201,
    );
    const afterClose = await snapshot();
    const sessionsBeforeReplay = await scalar(
      "SELECT COUNT(*) AS n FROM sessions WHERE problem_id = ?",
      problem,
    );
    const replay = await attempt(author, "atomic-linked", members);
    assert.equal(replay.status, 200);
    assert.equal(replay.raw, first.raw);
    assert.deepEqual(await snapshot(), afterClose);
    assert.equal(
      await scalar("SELECT COUNT(*) AS n FROM sessions WHERE problem_id = ?", problem),
      sessionsBeforeReplay,
    );
    assert.equal(await fixtures.screeningCalls(), firstScreens + 2);

    const conflictBefore = await snapshot();
    for (const changed of [
      [
        { tempId: "tmp:claim", action: "claim", data: {} },
        { tempId: "tmp:other", action: "claim", data: {} },
      ],
      [
        { ...hypothesis("tmp:one", "cycle"), causedBy: ["tmp:two"] },
        { ...hypothesis("tmp:two", "cycle"), causedBy: ["tmp:one"] },
      ],
    ]) {
      const conflict = await attempt(author, "atomic-linked", changed);
      assert.equal(
        conflict.status,
        409,
        "stored outer identity precedes changed action/DAG validation",
      );
      assert.equal(conflict.body.code, "IDEMPOTENCY_CONFLICT");
    }
    assert.deepEqual(await snapshot(), conflictBefore);
    assert.equal(await fixtures.screeningCalls(), firstScreens + 2);

    // Both identical contenders share one screening reservation. A request
    // that sees a still-running owner may teach retry, then reads exact bytes.
    const concurrentBefore = await snapshot();
    const concurrentScreens = await fixtures.screeningCalls();
    const identicalMembers = checkpoint("identical contenders");
    const identical = await Promise.all([
      attempt(author, "atomic-identical", identicalMembers),
      attempt(author, "atomic-identical", identicalMembers),
    ]);
    assert.equal(identical.filter((item) => item.status === 201).length, 1);
    assert.ok(identical.every((item) => [200, 201, 409].includes(item.status)));
    for (const item of identical.filter((item) => item.status === 409))
      assert.equal(item.body.code, "IDEMPOTENCY_CONFLICT");
    const exact = await attempt(author, "atomic-identical", identicalMembers);
    assert.equal(exact.status, 200);
    assert.equal(exact.raw, identical.find((item) => item.status === 201).raw);
    assert.equal((await snapshot()).tables.events, concurrentBefore.tables.events + 2);
    assert.equal(
      await fixtures.screeningCalls(),
      concurrentScreens + 2,
      "one paid screen for each published member",
    );

    for (const variant of ["temp-id", "action"]) {
      const before = await snapshot();
      const screens = await fixtures.screeningCalls();
      const original = checkpoint(`changed ${variant}`);
      const changed =
        variant === "temp-id"
          ? [hypothesis("tmp:other", variant), evidence("tmp:observation", "tmp:other")]
          : [hypothesis("tmp:route", variant), hypothesis("tmp:observation", variant)];
      const outcomes = await Promise.all([
        attempt(author, `atomic-race-${variant}`, original),
        attempt(author, `atomic-race-${variant}`, changed),
      ]);
      assert.deepEqual(outcomes.map((item) => item.status).sort(), [201, 409]);
      assert.equal(outcomes.find((item) => item.status === 409).body.code, "IDEMPOTENCY_CONFLICT");
      assert.equal((await snapshot()).tables.events, before.tables.events + 2);
      assert.equal(
        await fixtures.screeningCalls(),
        screens + 2,
        "changed outer identity refuses before screening",
      );
    }

    const faultAuthor = await enroll("atomic-batch-faults", "usr_atomic_batch_faults");
    for (const kind of ["projection", "outer-receipt"]) {
      const before = await snapshot();
      const condition =
        kind === "projection"
          ? "BEFORE INSERT ON evidence"
          : "BEFORE UPDATE ON session_write_replays WHEN NEW.scope = 'events_batch' AND NEW.claim_token IS NULL";
      await env.DB.prepare(`CREATE TRIGGER atomic_lane_fault ${condition}
      BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_ATOMIC_CHECKPOINT_FAILURE'); END`).run();
      const faultMembers = checkpoint(`late ${kind} fault`);
      const failed = await attempt(faultAuthor, `atomic-fault-${kind}`, faultMembers);
      assert.equal(failed.status, 500);
      assert.deepEqual(
        await snapshot(),
        before,
        `${kind}: D1 rolled back every event and projection`,
      );
      const hello = await call("/v1/hello", undefined, faultAuthor);
      assert.equal(
        await scalar(
          "SELECT COUNT(*) AS n FROM session_write_replays WHERE principal_scope = ? AND scope IN ('hypotheses', 'evidence')",
          hello.fellow.fellow_id,
        ),
        kind === "projection" ? 0 : 2,
      );
      await env.DB.prepare("DROP TRIGGER atomic_lane_fault").run();
      const retried = await attempt(faultAuthor, `atomic-fault-${kind}`, faultMembers);
      assert.equal(retried.status, 201);
      assert.deepEqual(
        retried.body.results.map((item) => item.seq),
        [before.head.public_seq + 1, before.head.public_seq + 2],
      );
    }

    const refusalBefore = await snapshot();
    const refusalScreens = await fixtures.screeningCalls();
    const invalid = await attempt(faultAuthor, "atomic-invalid-late", [
      hypothesis("tmp:valid", "invalid later member"),
      { tempId: "tmp:invalid", action: "hypothesis", data: {} },
    ]);
    assert.equal(invalid.status, 422);
    assert.equal(
      await fixtures.screeningCalls(),
      refusalScreens,
      "validate every member before paid screening",
    );
    assert.deepEqual(await snapshot(), refusalBefore);
    const cyclic = await attempt(faultAuthor, "atomic-implicit-cycle", [
      { ...hypothesis("tmp:route", "cycle"), causedBy: ["tmp:observation"] },
      evidence("tmp:observation", "tmp:route"),
    ]);
    assert.equal(cyclic.status, 422);
    assert.equal(cyclic.body.code, "BATCH_CAUSAL_CYCLE");
    assert.equal(await fixtures.screeningCalls(), refusalScreens);
    assert.deepEqual(await snapshot(), refusalBefore);

    // The first screen passes, the second refuses. No event, publication
    // provenance, chain advance or projection from the first member survives.
    await fixtures.pauseScreening(2000);
    let refused;
    try {
      const pending = attempt(
        faultAuthor,
        "atomic-screen-late",
        checkpoint("second screen refuses"),
      );
      await waitForScreens(refusalScreens + 2);
      await fixtures.setScreenMode("reject");
      refused = await pending;
    } finally {
      await fixtures.setScreenMode("pass");
      await fixtures.resumeScreening();
    }
    assert.equal(refused.status, 403);
    assert.deepEqual(await snapshot(), refusalBefore);

    const boundaryAuthor = await enroll("atomic-batch-sixteen", "usr_atomic_batch_sixteen");
    const sixteen = Array.from({ length: 16 }, (_, index) => ({
      ...hypothesis(`tmp:h${index}`, `literal sixteen ${index}`),
      caused_by: index === 0 ? [] : [`tmp:h${index - 1}`],
    }));
    const boundaryBefore = await snapshot();
    const boundaryScreens = await fixtures.screeningCalls();
    const boundary = await attempt(boundaryAuthor, "atomic-sixteen", sixteen);
    assert.equal(boundary.status, 201);
    assert.deepEqual(
      boundary.body.results.map((item) => item.seq),
      Array.from({ length: 16 }, (_, index) => boundaryBefore.head.public_seq + index + 1),
    );
    assert.equal(await fixtures.screeningCalls(), boundaryScreens + 16);
    const boundaryAfter = await snapshot();
    for (const table of [
      "events",
      "event_content",
      "hypotheses",
      "integrity_checkpoints",
      "screening_publications",
      "public_cursor",
    ])
      assert.equal(boundaryAfter.tables[table], boundaryBefore.tables[table] + 16, table);
    const boundaryTail = EventTailResponseSchema.parse(
      await call(`/p/${problem}/events.json?since=${boundaryBefore.head.public_seq}&limit=16`),
    );
    assert.equal(boundaryTail.events.length, 16);
    for (const [index, entry] of boundaryTail.events.entries()) {
      assert.equal(entry.event.causality_omitted, null);
      assert.deepEqual(
        entry.event.caused_by,
        index === 0
          ? []
          : [
              {
                scope: "problem",
                scope_id: problem,
                event_id: boundaryTail.events[index - 1].event.id,
                seq: entry.seq - 1,
              },
            ],
      );
    }

    // Aggregate admission must reject two members when only one hourly slot
    // remains. Prior attempts use the real reservation implementation, not
    // fabricated classifier calls or direct edits of quota state.
    const limitedSponsor = "usr_atomic_batch_limited";
    const limited = await enroll("atomic-batch-limited", limitedSponsor);
    const limitedFellow = (await call("/v1/hello", undefined, limited)).fellow.fellow_id;
    const limitedSession = (
      await call("/v1/sessions", { problem_id: problem, intent: "prove" }, limited, 201)
    ).session_id;
    for (let index = 0; index < 19; index++) {
      const key = `atomic-prior-attempt-${index}`;
      const reserved = await fixtures.reserveQuota({
        fellowId: limitedFellow,
        problemId: problem,
        sponsorId: limitedSponsor,
        sessionId: limitedSession,
        route: "hypotheses",
        idempotencyKey: key,
        requestDigest: createHash("sha256").update(key).digest("hex"),
      });
      assert.equal(reserved.allowed, true);
    }
    const limitedBefore = await snapshot();
    const limitedScreens = await fixtures.screeningCalls();
    const limitedResponse = await attempt(
      limited,
      "atomic-last-one",
      checkpoint("needs two slots"),
    );
    assert.equal(limitedResponse.status, 429);
    assert.equal(limitedResponse.body.code, "PROMOTION_RATE_LIMITED");
    assert.equal(await fixtures.screeningCalls(), limitedScreens);
    assert.deepEqual(await snapshot(), limitedBefore);

    // Broader scientific prefixes still fail explicitly until their own folds
    // can join the same transaction; no sequential public emulation is used.
    const unsupported = await attempt(author, "atomic-unsupported", [
      {
        tempId: "tmp:claim",
        action: "claim",
        data: {
          kind: "conjecture",
          statement: "Every square keeps parity.",
          falsifier: "An opposite parity square.",
        },
      },
      {
        ...evidence("tmp:evidence", "tmp:claim"),
        data: {
          ...evidence("tmp:evidence", "tmp:claim").data,
          bears_on_kind: "claim",
          bears_on_version: 1,
        },
      },
    ]);
    assert.equal(unsupported.status, 503);
    assert.equal(unsupported.body.code, "BATCH_ATOMICITY_UNAVAILABLE");
    assert.deepEqual(await snapshot(), limitedBefore);

    // Real sponsor governance changes authority while the second screen is
    // waiting. Its own event remains; no scientific member follows it.
    const authorityAuthor = await enroll("atomic-batch-authority", "usr_atomic_batch_authority");
    const authorityFellow = (await call("/v1/hello", undefined, authorityAuthor)).fellow.fellow_id;
    for (const change of ["role", "retirement"]) {
      const token = change === "role" ? authorityAuthor : author;
      const beforeScreens = await fixtures.screeningCalls();
      await fixtures.pauseScreening(2000);
      try {
        const pending = attempt(
          token,
          `atomic-authority-${change}`,
          checkpoint(`authority ${change}`),
        );
        await waitForScreens(beforeScreens + 2);
        await sponsorCall(
          sponsor,
          "POST",
          `/v1/sponsors/problems/${problem}/lifecycle`,
          "problem-lifecycle",
          change === "role"
            ? {
                action: "manage-member",
                operation: "set-role",
                target_fellow_id: authorityFellow,
                role: "observer",
              }
            : { action: "retire", reason: "The bounded checkpoint investigation is complete." },
        );
        const afterGovernance = await snapshot();
        const refused = await pending;
        assert.equal(refused.status, 403);
        assert.equal(refused.body.code, "WRITE_REFUSED");
        assert.deepEqual(
          await snapshot(),
          afterGovernance,
          `${change}: no batch prefix after authority changed`,
        );
      } finally {
        await fixtures.resumeScreening();
      }
    }
    const retiredReplay = await attempt(author, "atomic-linked", members);
    assert.equal(retiredReplay.status, 200);
    assert.equal(retiredReplay.raw, first.raw, "retirement does not revoke a successful replay");
    console.log(
      JSON.stringify({
        stage: "atomic-batch-journey-passed",
        status: "pass",
        members: "2-16",
        temporary_hypothesis_targets: true,
        hash_bound_causality: true,
        exact_replay_after_session_close: true,
        concurrent_outer_identity: true,
        late_projection_and_receipt_rollback: true,
        whole_batch_screening_and_quota: true,
        current_authority_at_commit: true,
      }),
    );
  },
);
