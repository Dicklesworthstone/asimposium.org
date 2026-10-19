import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  ClaimFaceResponseSchema,
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
        "claims",
        "claim_versions",
        "claim_deps",
        "claim_projections",
        "hypotheses",
        "evidence",
        "reviews",
        "dead_end_fired_triggers",
        "integrity_checkpoints",
        "idempotency",
      ])
        tables[table] = await scalar(
          `SELECT COUNT(*) AS n FROM ${table} WHERE problem_id = ?`,
          problem,
        );
      tables.outbox = await scalar(
        "SELECT COUNT(*) AS n FROM outbox o JOIN events e ON e.id = o.event_id WHERE e.problem_id = ?",
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
    const publicHypothesis = publicHypotheses.hypotheses.find(
      (item) => item.hypothesis_id === rows[0].object_id,
    );
    assert.ok(publicHypothesis?.content, "batch metadata must not hide the hypothesis content");
    assert.equal(publicHypothesis.content.body_md, JSON.parse(rows[0].payload_json).body_md);

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

    // The same real writers now prepare claim-target evidence and reviews.
    // Their combined prefix, rather than either member viewed alone, crosses
    // a scientific threshold and fires the recorded retry predicate once.
    const scientificClaim = await call(
      `/v1/p/${problem}/claims`,
      {
        kind: "conjecture",
        statement: "Every integer from zero through one hundred preserves parity when squared.",
        falsifier: "An integer in this interval whose square has opposite parity.",
        scientific_provenance: { model_family_self_declared: "gpt" },
      },
      author,
      201,
    );
    const claimFace = ClaimFaceResponseSchema.parse(
      await call(`/p/${problem}/claims/${scientificClaim.claim_id}.json`),
    );
    assert.equal(claimFace.claim_state.disposition, "open");
    const claimVersionPin = await env.DB.prepare(
      "SELECT content_digest FROM claim_versions WHERE problem_id = ? AND claim_id = ? AND version = 1",
    )
      .bind(problem, scientificClaim.claim_id)
      .first();
    const scientificEvidenceData = {
      bears_on_kind: "claim",
      bears_on_id: scientificClaim.claim_id,
      bears_on_version: 1,
      direction: "supports",
      kind: "argument",
      source: {
        kind: "locator",
        locator: "https://example.org/parity-proof",
        excerpt: "The two residues remain unchanged by squaring.",
      },
      mode: "confirmatory",
      body_md: "For n=2k, the square is even; for n=2k+1, the square is odd.",
    };
    const scientificSource = await call(
      `/v1/p/${problem}/evidence`,
      scientificEvidenceData,
      author,
      201,
    );
    const sourcePin = await env.DB.prepare(
      "SELECT id, payload_sha256 FROM events WHERE problem_id = ? AND object_id = ? AND type = 'evidence.created'",
    )
      .bind(problem, scientificSource.evidence_id)
      .first();
    const scientificReference = {
      evidence_id: scientificSource.evidence_id,
      digest: `sha256:${sourcePin.payload_sha256}`,
    };
    const retryWatch = await call(
      `/v1/p/${problem}/dead-ends`,
      {
        approach: "Rely on the parity claim before a bounded attempt and independent check exist.",
        why_it_fails: "The route has no reviewed boundary check yet.",
        retry_predicate:
          "An independent review and a surviving falsification attempt corroborate this exact claim.",
        retry_when: {
          kind: "claim-reaches",
          claim_id: scientificClaim.claim_id,
          reaches: "corroborated",
        },
      },
      author,
      201,
    );
    const scientificReviewerSponsor = "usr_atomic_scientific_reviewer";
    const scientificReviewer = await enroll(
      "atomic-scientific-reviewer",
      scientificReviewerSponsor,
    );
    const scientificFellow = (await call("/v1/hello", undefined, scientificReviewer)).fellow
      .fellow_id;
    const scientificReviewData = {
      target_claim_id: scientificClaim.claim_id,
      target_version: 1,
      verdict: "confirm",
      basis: "Checked both parity cases in the exact published proof.",
      capable_of_failure: "A mistaken parity expansion could falsify the claim.",
      rubric: ["soundness-of-inference"],
      body_md: "The two algebraic cases exhaust the integer domain.",
      scientific_provenance: { model_family_self_declared: "gpt" },
      verification: {
        kind: "full-write-up",
        target_digest: claimVersionPin.content_digest,
        evidence: scientificReference,
        coverage: ["the exact finite statement and both parity cases"],
        result: "verified",
      },
    };
    const scientificCheckData = {
      ...scientificEvidenceData,
      direction: "informs",
      body_md: "The lower and upper boundary cases preserve parity.",
      falsification_check: {
        target_digest: claimVersionPin.content_digest,
        attempted_falsifier: "Try the lower and upper boundary cases for opposite parity.",
        capable_of_failure: "Either boundary could violate the proposed parity statement.",
        result: "survived",
        evidence: [scientificReference],
      },
    };
    const scientificMembers = [
      {
        tempId: "tmp:review",
        action: "review",
        caused_by: ["tmp:check"],
        data: scientificReviewData,
      },
      hypothesis("tmp:route", "mixed scientific checkpoint"),
      {
        tempId: "tmp:check",
        action: "evidence",
        caused_by: ["tmp:route"],
        data: scientificCheckData,
      },
    ];
    const scienceBefore = await snapshot();
    const scienceScreens = await fixtures.screeningCalls();
    const mixed = await attempt(scientificReviewer, "atomic-mixed-science", scientificMembers);
    assert.equal(mixed.status, 201);
    assert.deepEqual(
      mixed.body.results.map((item) => item.action),
      ["hypothesis", "evidence", "review"],
    );
    assert.deepEqual(
      mixed.body.results.map((item) => item.seq),
      [1, 2, 3].map((n) => scienceBefore.head.public_seq + n),
    );
    assert.equal(await fixtures.screeningCalls(), scienceScreens + 3);
    const mixedReview = mixed.body.results[2];
    assert.deepEqual(
      await env.DB.prepare(
        "SELECT target_version, tier, reviewer_fellow_id FROM reviews WHERE review_id = ?",
      )
        .bind(mixedReview.id)
        .first(),
      { target_version: 1, tier: "T1", reviewer_fellow_id: scientificFellow },
    );
    const fired = await env.DB.prepare(
      "SELECT t.event_id, e.object_id FROM dead_end_fired_triggers t JOIN events e ON e.id = t.event_id WHERE t.problem_id = ? AND t.dead_end_id = ?",
    )
      .bind(problem, retryWatch.dead_end_id)
      .all();
    assert.equal(fired.results.length, 1);
    assert.equal(fired.results[0].object_id, mixedReview.id);
    assert.equal(
      ClaimFaceResponseSchema.parse(
        await call(`/p/${problem}/claims/${scientificClaim.claim_id}.json`),
      ).claim_state.disposition,
      "corroborated",
    );
    const mixedTail = EventTailResponseSchema.parse(
      await call(`/p/${problem}/events.json?since=${scienceBefore.head.public_seq}&limit=16`),
    );
    assert.equal(mixedTail.events.length, 3);
    assert.deepEqual(mixedTail.events[2].event.caused_by, [
      {
        scope: "problem",
        scope_id: problem,
        event_id: mixedTail.events[1].event.id,
        seq: mixedTail.events[1].seq,
      },
    ]);
    assert.equal(
      (await attempt(scientificReviewer, "atomic-mixed-science", scientificMembers)).raw,
      mixed.raw,
    );

    // Observers retain the Fable evidence/review permissions at admission and
    // inside the final transaction, with no promotion-rights impersonation.
    await sponsorCall(
      sponsor,
      "POST",
      `/v1/sponsors/problems/${problem}/lifecycle`,
      "problem-lifecycle",
      {
        action: "manage-member",
        operation: "set-role",
        target_fellow_id: scientificFellow,
        role: "observer",
      },
    );
    const evidenceReviewMembers = [
      { tempId: "tmp:check", action: "evidence", data: scientificCheckData },
      { tempId: "tmp:review", action: "review", data: scientificReviewData },
    ];
    assert.equal(
      (await attempt(scientificReviewer, "atomic-observer-science", evidenceReviewMembers)).status,
      201,
    );
    assert.equal(
      await scalar(
        "SELECT COUNT(*) AS n FROM dead_end_fired_triggers WHERE problem_id = ? AND dead_end_id = ?",
        problem,
        retryWatch.dead_end_id,
      ),
      1,
    );
    const selfSource = await call(
      `/v1/p/${problem}/evidence`,
      scientificEvidenceData,
      scientificReviewer,
      201,
    );
    const selfPin = await env.DB.prepare(
      "SELECT payload_sha256 FROM events WHERE problem_id = ? AND object_id = ? AND type = 'evidence.created'",
    )
      .bind(problem, selfSource.evidence_id)
      .first();
    const independenceBefore = await snapshot();
    const independenceScreens = await fixtures.screeningCalls();
    const notIndependent = await attempt(scientificReviewer, "atomic-self-evidence-verification", [
      evidenceReviewMembers[0],
      {
        tempId: "tmp:review",
        action: "review",
        data: {
          ...scientificReviewData,
          verification: {
            ...scientificReviewData.verification,
            evidence: {
              evidence_id: selfSource.evidence_id,
              digest: `sha256:${selfPin.payload_sha256}`,
            },
          },
        },
      },
    ]);
    assert.equal(notIndependent.status, 422);
    assert.equal(notIndependent.body.code, "REVIEW_BODY_INVALID");
    assert.equal(await fixtures.screeningCalls(), independenceScreens);
    assert.deepEqual(await snapshot(), independenceBefore);

    await env.DB.prepare(`CREATE TRIGGER atomic_science_late_fault BEFORE INSERT ON reviews
      WHEN NEW.reviewer_fellow_id = '${scientificFellow}'
      BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_REVIEW_PROJECTION_FAILURE'); END`).run();
    const failedScience = await attempt(
      scientificReviewer,
      "atomic-review-projection-fault",
      evidenceReviewMembers,
    );
    assert.equal(failedScience.status, 500);
    assert.deepEqual(
      await snapshot(),
      independenceBefore,
      "a late review fault cannot leave the evidence member",
    );
    await env.DB.prepare("DROP TRIGGER atomic_science_late_fault").run();
    assert.equal(
      (await attempt(scientificReviewer, "atomic-review-projection-fault", evidenceReviewMembers))
        .status,
      201,
    );

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
    const limitedResponse = await attempt(limited, "atomic-last-one", [
      { tempId: "tmp:first-review", action: "review", data: scientificReviewData },
      {
        tempId: "tmp:second-review",
        action: "review",
        data: {
          ...scientificReviewData,
          body_md: "Rechecked the two expansions against the published statement.",
        },
      },
    ]);
    assert.equal(limitedResponse.status, 429);
    assert.equal(limitedResponse.body.code, "PROMOTION_RATE_LIMITED");
    assert.equal(await fixtures.screeningCalls(), limitedScreens);
    assert.deepEqual(await snapshot(), limitedBefore);

    const claimCheckpoint = (tag) => [
      {
        tempId: "tmp:claim",
        action: "claim",
        data: {
          kind: "conjecture",
          statement: `The upper-bound parity checkpoint ${tag} follows from the two residues.`,
          falsifier: `An upper-bound residue violating checkpoint ${tag}.`,
          depends_on: [scientificClaim.claim_id],
        },
      },
      {
        ...evidence("tmp:evidence", "tmp:claim"),
        data: {
          ...evidence("tmp:evidence", "tmp:claim").data,
          bears_on_kind: "claim",
          bears_on_version: 1,
          body_md: "tmp:claim",
        },
      },
    ];
    const limitedClaim = await attempt(limited, "atomic-last-claim-one", claimCheckpoint("quota"));
    assert.equal(limitedClaim.status, 429);
    assert.equal(limitedClaim.body.code, "PROMOTION_RATE_LIMITED");
    assert.equal(await fixtures.screeningCalls(), limitedScreens);
    assert.deepEqual(await snapshot(), limitedBefore);

    // Claim IDs come from their actual public sequence. The ordinary claim
    // validator, version/dependency projections, index outbox and the new
    // claim's exact evidence all join this one migrated D1 transaction.
    const claimAuthor = await enroll("atomic-batch-claim-author", "usr_atomic_batch_claims");
    const claimSession = (
      await call("/v1/sessions", { problem_id: problem, intent: "prove" }, claimAuthor, 201)
    ).session_id;
    const newClaims = claimCheckpoint("new atomic publication").reverse();
    const claimBefore = await snapshot();
    const claimScreens = await fixtures.screeningCalls();
    const claimResult = await attempt(claimAuthor, "atomic-create-claim", newClaims);
    assert.equal(claimResult.status, 201);
    assert.deepEqual(claimResult.body.results.map((item) => item.action), ["claim", "evidence"]);
    const createdClaim = claimResult.body.results[0];
    assert.equal(createdClaim.seq, claimBefore.head.public_seq + 1);
    assert.equal(createdClaim.id, `C-${createdClaim.seq}`);
    assert.equal(createdClaim.version, 1);
    const createdEvidence = claimResult.body.results[1];
    assert.equal(createdEvidence.seq, createdClaim.seq + 1);
    assert.equal(await fixtures.screeningCalls(), claimScreens + 2);
    const claimRows = (
      await env.DB.prepare(`SELECT e.id, e.seq, e.type, e.object_id, e.payload_sha256,
        e.actor_fellow_id, e.actor_sponsor_id, e.actor_session_id, e.created_at, c.payload_json
        FROM events e JOIN event_content c ON c.event_id = e.id
        WHERE e.problem_id = ? AND e.seq > ? ORDER BY e.seq`)
        .bind(problem, claimBefore.head.public_seq).all()
    ).results;
    assert.equal(claimRows.length, 2);
    assert.equal(claimRows[0].type, "claim.created");
    assert.equal(claimRows[0].actor_session_id, claimSession);
    assert.equal(claimRows[1].actor_session_id, claimSession);
    assert.equal(claimRows[0].created_at, claimRows[1].created_at);
    const newClaimPayload = JSON.parse(claimRows[0].payload_json);
    const newEvidencePayload = JSON.parse(claimRows[1].payload_json);
    assert.equal(newClaimPayload.claim_id, createdClaim.id);
    assert.equal(newClaimPayload.statement, newClaims[1].data.statement);
    assert.equal(newEvidencePayload.bears_on_id, createdClaim.id);
    assert.equal(newEvidencePayload.bears_on_version, 1);
    assert.equal(newEvidencePayload.body_md, "tmp:claim", "only typed references are resolved");
    assert.deepEqual(newEvidencePayload.caused_by, [{
      scope: "problem", scope_id: problem, event_id: claimRows[0].id, seq: createdClaim.seq,
    }]);
    for (const row of claimRows)
      assert.equal(createHash("sha256").update(row.payload_json).digest("hex"), row.payload_sha256);
    const newClaimFace = ClaimFaceResponseSchema.parse(
      await call(`/p/${problem}/claims/${createdClaim.id}.json`),
    );
    assert.equal(newClaimFace.claim_state.claim_id, createdClaim.id);
    assert.equal(newClaimFace.claim_state.version, 1);
    const detail = newClaimFace.items.find((item) => item.kind === "claim-detail");
    assert.ok(detail, "caused_by metadata must preserve the exact public claim face");
    assert.ok(JSON.stringify(detail).includes(newClaimPayload.statement));
    assert.ok(newClaimFace.items.some((item) => item.kind === "claim-evidence"));
    const claimAfter = await snapshot();
    for (const table of ["claims", "claim_versions", "claim_deps", "claim_projections", "outbox"])
      assert.equal(claimAfter.tables[table], claimBefore.tables[table] + 1, table);
    assert.equal(claimAfter.tables.evidence, claimBefore.tables.evidence + 1);
    assert.equal(claimAfter.tables.public_cursor, claimBefore.tables.public_cursor + 2);
    assert.equal(claimAfter.tables.screening_publications, claimBefore.tables.screening_publications + 2);
    assert.equal(await scalar(
      "SELECT COUNT(*) AS n FROM claim_deps WHERE problem_id = ? AND claim_id = ? AND depends_on_claim_id = ?",
      problem, createdClaim.id, scientificClaim.claim_id,
    ), 1);
    const newClaimTail = EventTailResponseSchema.parse(
      await call(`/p/${problem}/events.json?since=${claimBefore.head.public_seq}&limit=16`),
    );
    assert.deepEqual(newClaimTail.events.map((entry) => entry.event.caused_by),
      [[], newEvidencePayload.caused_by]);

    await call(`/v1/sessions/${claimSession}/close`,
      { handback: "The claim and its evidence are published together." }, claimAuthor, 201);
    const claimReplayBefore = await snapshot();
    const exactClaimReplay = await attempt(claimAuthor, "atomic-create-claim", newClaims);
    assert.equal(exactClaimReplay.status, 200);
    assert.equal(exactClaimReplay.raw, claimResult.raw);
    assert.deepEqual(await snapshot(), claimReplayBefore);
    assert.equal(await fixtures.screeningCalls(), claimScreens + 2);

    // The prepared candidate C-<next> loses a real chain race. Its evidence,
    // hash-bound parent and projection must all use the retried sequence.
    const raceMembers = claimCheckpoint("actual competing sequence");
    const raceBefore = await snapshot();
    await fixtures.armCompetingLedgerWrite(problem);
    const racedClaim = await attempt(claimAuthor, "atomic-claim-chain-race", raceMembers);
    assert.equal(racedClaim.status, 201);
    assert.equal(await fixtures.competingWriteStillArmed(), false);
    const raceClaim = racedClaim.body.results[0];
    assert.equal(raceClaim.seq, raceBefore.head.public_seq + 2);
    assert.equal(raceClaim.id, `C-${raceClaim.seq}`);
    assert.equal(racedClaim.body.results[1].seq, raceClaim.seq + 1);
    const raceEvidence = await env.DB.prepare(
      "SELECT bears_on_id, bears_on_version FROM evidence WHERE evidence_id = ?",
    ).bind(racedClaim.body.results[1].id).first();
    assert.equal(raceEvidence.bears_on_id, raceClaim.id);
    assert.equal(raceEvidence.bears_on_version, 1);
    assert.equal(await scalar(
      "SELECT COUNT(*) AS n FROM claims WHERE problem_id = ? AND id = ?",
      problem, `C-${raceBefore.head.public_seq + 1}`,
    ), 0, "the abandoned candidate sequence created no claim");
    assert.ok(ClaimFaceResponseSchema.parse(
      await call(`/p/${problem}/claims/${raceClaim.id}.json`),
    ).items.some((item) => item.kind === "claim-detail"));

    const invalidClaimBefore = await snapshot();
    const invalidClaimScreens = await fixtures.screeningCalls();
    const duplicateMembers = claimCheckpoint("duplicate prepared statement");
    const duplicateClaim = await attempt(claimAuthor, "atomic-duplicate-new-claims", [
      duplicateMembers[0], { ...duplicateMembers[0], tempId: "tmp:duplicate" },
    ]);
    assert.equal(duplicateClaim.status, 409);
    assert.equal(duplicateClaim.body.code, "DUPLICATE_CLAIM");
    const futureMembers = claimCheckpoint("future temporary version");
    futureMembers[1].data.bears_on_version = 2;
    const futureClaim = await attempt(claimAuthor, "atomic-future-new-claim", futureMembers);
    assert.equal(futureClaim.status, 422);
    assert.equal(futureClaim.body.code, "BATCH_DANGLING_CAUSAL_REF");
    assert.equal(await fixtures.screeningCalls(), invalidClaimScreens);
    assert.deepEqual(await snapshot(), invalidClaimBefore);

    // A fault after the claim, version, dependency and index work rolls back
    // every public effect. The same outer identity remains safely retryable.
    const failedClaimMembers = claimCheckpoint("late evidence projection failure");
    await env.DB.prepare(`CREATE TRIGGER atomic_claim_late_fault BEFORE INSERT ON evidence
      BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_CLAIM_EVIDENCE_FAILURE'); END`).run();
    const failedClaimBefore = await snapshot();
    const failedClaim = await attempt(claimAuthor, "atomic-new-claim-fault", failedClaimMembers);
    assert.equal(failedClaim.status, 500);
    assert.deepEqual(await snapshot(), failedClaimBefore);
    await env.DB.prepare("DROP TRIGGER atomic_claim_late_fault").run();
    const fixedClaim = await attempt(claimAuthor, "atomic-new-claim-fault", failedClaimMembers);
    assert.equal(fixedClaim.status, 201);
    assert.equal(fixedClaim.body.results[0].seq, failedClaimBefore.head.public_seq + 1);

    const heldClaimMembers = claimCheckpoint("held complete claim checkpoint");
    const heldClaimBefore = await snapshot();
    const heldClaimScreens = await fixtures.screeningCalls();
    let heldClaim;
    let heldCandidate;
    await fixtures.pauseScreening(2000);
    try {
      const pending = attempt(claimAuthor, "atomic-new-claim-held", heldClaimMembers);
      await waitForScreens(heldClaimScreens + 2);
      await fixtures.setScreenMode("quarantine");
      heldClaim = await pending;
      heldCandidate = await fixtures.lastScreening();
    } finally {
      await fixtures.setScreenMode("pass");
      await fixtures.resumeScreening();
    }
    assert.equal(heldClaim.status, 202);
    assert.deepEqual(await snapshot(), heldClaimBefore);
    assert.equal(JSON.parse(heldCandidate.statement).bears_on_id, "tmp:claim");
    const releasedClaim = await attempt(claimAuthor, "atomic-new-claim-held", heldClaimMembers);
    assert.equal(releasedClaim.status, 201);
    assert.equal((await fixtures.lastScreening()).statement, heldCandidate.statement);

    // Negative knowledge can share a checkpoint with its new retry target.
    // The projection must bind the allocated claim id, while explanatory text
    // stays literal and a failed last member leaves neither object behind.
    const negativeMember = (tag) => ({
      tempId: "tmp:negative",
      action: "dead-end",
      data: {
        approach: "Enumerated bounded exceptional residue classes for " + tag + ".",
        why_it_fails: "The uniform estimate misses a boundary family; tmp:claim is literal prose.",
        retry_predicate: "Retry when the new uniform estimate has independent corroboration.",
        retry_when: { kind: "claim-reaches", claim_id: "tmp:claim", reaches: "corroborated" },
      },
    });
    const negativeSnapshot = async () => ({
      public: await snapshot(),
      negative: await scalar("SELECT COUNT(*) AS n FROM dead_ends WHERE problem_id = ?", problem),
    });
    const negativeMembers = [
      negativeMember("atomic negative publication"),
      claimCheckpoint("atomic negative retry target")[0],
    ];
    const negativeBefore = await negativeSnapshot();
    const negativeScreens = await fixtures.screeningCalls();
    const negativeResult = await attempt(claimAuthor, "atomic-negative", negativeMembers);
    assert.equal(negativeResult.status, 201, negativeResult.raw);
    assert.deepEqual(negativeResult.body.results.map((item) => item.action), ["claim", "dead-end"]);
    const negativeClaim = negativeResult.body.results[0];
    const negativeId = negativeResult.body.results[1].id;
    const negativeRow = await env.DB.prepare(
      "SELECT retry_when_json, why_it_fails FROM dead_ends WHERE problem_id = ? AND dead_end_id = ?",
    ).bind(problem, negativeId).first();
    assert.equal(JSON.parse(negativeRow.retry_when_json).claim_id, negativeClaim.id);
    assert.equal(negativeRow.why_it_fails, negativeMembers[0].data.why_it_fails);
    const negativeEvent = await env.DB.prepare(
      "SELECT e.payload_sha256, c.payload_json FROM events e JOIN event_content c ON c.event_id = e.id WHERE e.problem_id = ? AND e.object_id = ? AND e.type = 'dead_end.recorded'",
    ).bind(problem, negativeId).first();
    assert.equal(createHash("sha256").update(negativeEvent.payload_json).digest("hex"), negativeEvent.payload_sha256);
    const negativePayload = JSON.parse(negativeEvent.payload_json);
    assert.equal(negativePayload.retry_when.claim_id, negativeClaim.id);
    assert.equal(negativePayload.caused_by[0].seq, negativeClaim.seq);
    const negativeAfter = await negativeSnapshot();
    assert.equal(negativeAfter.negative, negativeBefore.negative + 1);
    assert.equal(negativeAfter.public.tables.events, negativeBefore.public.tables.events + 2);
    const replayedNegative = await attempt(claimAuthor, "atomic-negative", negativeMembers);
    assert.equal(replayedNegative.status, 200);
    assert.equal(replayedNegative.raw, negativeResult.raw);
    assert.equal(await fixtures.screeningCalls(), negativeScreens + 2);
    assert.deepEqual(await negativeSnapshot(), negativeAfter);

    await env.DB.prepare("CREATE TRIGGER atomic_negative_fault BEFORE INSERT ON dead_ends BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_NEGATIVE_PROJECTION_FAILURE'); END").run();
    try {
      const negativeFault = await attempt(claimAuthor, "atomic-negative-fault", [
        claimCheckpoint("negative failure rollback")[0],
        negativeMember("negative failure rollback"),
      ]);
      assert.equal(negativeFault.status, 500);
      assert.deepEqual(await negativeSnapshot(), negativeAfter);
    } finally {
      await env.DB.prepare("DROP TRIGGER atomic_negative_fault").run();
    }

    // Workshop-reference revisions still require the ordinary publication
    // path; direct revisions have a transactional preparer below.
    const unsupportedBefore = await snapshot();
    const unsupported = await attempt(author, "atomic-unsupported", [
      { tempId: "tmp:revision", action: "revise", data: { workshop_id: "W-abcdefghijklmnopqrstuvwxyz" } },
      { tempId: "tmp:other-revision", action: "revise", data: { workshop_id: "W-bcdefghijklmnopqrstuvwxyza" } },
    ]);
    assert.equal(unsupported.status, 503);
    assert.equal(unsupported.body.code, "BATCH_ATOMICITY_UNAVAILABLE");
    assert.deepEqual(await snapshot(), unsupportedBefore);

    // An actual revision from the claim's author wins while screening waits.
    // Evidence on version one cannot publish as if that route were still live.
    const revisionSession = (
      await call("/v1/sessions", { problem_id: problem, intent: "prove" }, author, 201)
    ).session_id;
    const revisionScreens = await fixtures.screeningCalls();
    await fixtures.pauseScreening(2000);
    try {
      const pending = attempt(
        scientificReviewer,
        "atomic-target-revision-race",
        evidenceReviewMembers,
      );
      await waitForScreens(revisionScreens + 1);
      const revised = await call(
        `/v1/sessions/${revisionSession}/revise`,
        {
          claim_id: scientificClaim.claim_id,
          base_version: 1,
          kind: "conjecture",
          statement: "Every integer from zero through two hundred preserves parity when squared.",
          falsifier: "An integer in the expanded interval whose square has opposite parity.",
          scientific_provenance: { model_family_self_declared: "gpt" },
        },
        author,
        201,
      );
      assert.equal(revised.version, 2);
      const afterRevision = await snapshot();
      const refused = await pending;
      assert.equal(refused.status, 422);
      assert.equal(refused.body.code, "EVIDENCE_BODY_INVALID");
      assert.deepEqual(
        await snapshot(),
        afterRevision,
        "no scientific member follows the intervening revision",
      );
    } finally {
      await fixtures.resumeScreening();
    }

    // Historical reviews keep their original pin and recorded tier. Accepting
    // them in a later checkpoint cannot strengthen the current second version.
    const historical = await attempt(scientificReviewer, "atomic-historical-reviews", [
      { tempId: "tmp:historic-one", action: "review", data: scientificReviewData },
      {
        tempId: "tmp:historic-two",
        action: "review",
        data: {
          ...scientificReviewData,
          body_md: "A second recorded check still concerns only the original interval.",
        },
      },
    ]);
    assert.equal(historical.status, 201);
    for (const row of historical.body.results)
      assert.deepEqual(
        await env.DB.prepare("SELECT target_version, tier FROM reviews WHERE review_id = ?")
          .bind(row.id)
          .first(),
        { target_version: 1, tier: "T1" },
      );
    const revisedFace = ClaimFaceResponseSchema.parse(
      await call(`/p/${problem}/claims/${scientificClaim.claim_id}.json`),
    );
    assert.equal(revisedFace.claim_state.disposition, "open");
    assert.equal(revisedFace.claim_state.review_state, "unreviewed");

    // Source visibility is authority too: a later moderation control on the
    // consumed proof invalidates both new members at the transaction boundary.
    const secondPin = await env.DB.prepare(
      "SELECT content_digest FROM claim_versions WHERE problem_id = ? AND claim_id = ? AND version = 2",
    )
      .bind(problem, scientificClaim.claim_id)
      .first();
    const secondEvidenceData = { ...scientificEvidenceData, bears_on_version: 2 };
    const secondSource = await call(
      `/v1/sessions/${revisionSession}/evidence`,
      secondEvidenceData,
      author,
      201,
    );
    const secondSourcePin = await env.DB.prepare(
      "SELECT payload_sha256 FROM events WHERE problem_id = ? AND object_id = ? AND type = 'evidence.created'",
    )
      .bind(problem, secondSource.evidence_id)
      .first();
    const sourceRaceScreens = await fixtures.screeningCalls();
    await fixtures.pauseScreening(2000);
    try {
      const pending = attempt(scientificReviewer, "atomic-source-hide-race", [
        { tempId: "tmp:evidence", action: "evidence", data: secondEvidenceData },
        {
          tempId: "tmp:review",
          action: "review",
          data: {
            ...scientificReviewData,
            target_version: 2,
            verification: {
              ...scientificReviewData.verification,
              target_digest: secondPin.content_digest,
              evidence: {
                evidence_id: secondSource.evidence_id,
                digest: `sha256:${secondSourcePin.payload_sha256}`,
              },
            },
          },
        },
      ]);
      await waitForScreens(sourceRaceScreens + 1);
      await env.DB.prepare(`INSERT INTO content_controls
        (control_id, problem_id, target_kind, target_ref, visibility, source, reason_category, actor, reason, version, created_at)
        VALUES('CC-atomic-proof-hide', ?, 'evidence', ?, 'hidden', 'operator', 'privacy', 'atomic-lane-operator', 'Withdraw the proof from public visibility.', 1, ?)`)
        .bind(problem, secondSource.evidence_id, new Date().toISOString())
        .run();
      const afterHide = await snapshot();
      const refused = await pending;
      assert.equal(refused.status, 422);
      assert.equal(refused.body.code, "REVIEW_BODY_INVALID");
      assert.deepEqual(
        await snapshot(),
        afterHide,
        "a hidden proof cannot leave an evidence/review prefix",
      );
    } finally {
      await fixtures.resumeScreening();
    }


    // The existing claim ID and immutable first version survive a checkpoint
    // that replaces its head and publishes evidence on exactly the new version.
    const revisionAuthor = await enroll("atomic-batch-revisions", "usr_atomic_batch_revisions");
    const revisionSeed = await call(`/v1/p/${problem}/claims`, {
      kind: "conjecture",
      statement: "The initial revision checkpoint enumerates the first two parity residues.",
      falsifier: "An initial residue absent from the checkpoint.",
    }, revisionAuthor, 201);
    const revisionMembers = (baseVersion, tag) => [
      {
        tempId: "tmp:revision-evidence", action: "evidence",
        data: {
          bears_on_kind: "claim", bears_on_id: "tmp:revision",
          bears_on_version: baseVersion + 1,
          direction: "informs", kind: "argument",
          source: { kind: "model_memory" }, mode: "exploratory",
          body_md: tag === "exact replacement" ? "tmp:revision" : tag,
        },
      },
      {
        tempId: "tmp:revision", action: "revise",
        data: {
          claim_id: revisionSeed.claim_id, base_version: baseVersion,
          kind: "conjecture",
          statement: `The replacement checkpoint enumerates every residue for ${tag}.`,
          falsifier: `A residue excluded from the replacement for ${tag}.`,
          depends_on: [],
          scientific_provenance: { model_family_self_declared: "gpt" },
        },
      },
    ];
    const originalRevisionVersion = await env.DB.prepare(
      "SELECT * FROM claim_versions WHERE problem_id = ? AND claim_id = ? AND version = 1",
    ).bind(problem, revisionSeed.claim_id).first();
    const replacement = revisionMembers(1, "exact replacement");
    const replacementBefore = await snapshot();
    const replacementScreens = await fixtures.screeningCalls();
    const replacementResult = await attempt(revisionAuthor, "atomic-replace-claim", replacement);
    assert.equal(replacementResult.status, 201);
    assert.deepEqual(replacementResult.body.results.map((item) => item.action), ["revise", "evidence"]);
    const replacementReceipt = replacementResult.body.results[0];
    assert.equal(replacementReceipt.id, revisionSeed.claim_id);
    assert.equal(replacementReceipt.version, 2);
    assert.equal(replacementReceipt.seq, replacementBefore.head.public_seq + 1);
    assert.equal(replacementResult.body.results[1].seq, replacementReceipt.seq + 1);
    assert.equal(await fixtures.screeningCalls(), replacementScreens + 2);
    const replacementRows = (await env.DB.prepare(
      `SELECT e.id, e.seq, e.type, e.object_id, e.object_version, e.payload_sha256,
        e.actor_fellow_id, e.actor_sponsor_id, e.actor_session_id, e.created_at, c.payload_json
        FROM events e JOIN event_content c ON c.event_id = e.id
        WHERE e.problem_id = ? AND e.seq > ? ORDER BY e.seq`,
    ).bind(problem, replacementBefore.head.public_seq).all()).results;
    assert.equal(replacementRows.length, 2);
    assert.equal(replacementRows[0].type, "claim.revised");
    const replacementPayload = JSON.parse(replacementRows[0].payload_json);
    assert.equal(replacementPayload.claim_id, revisionSeed.claim_id);
    assert.equal(replacementPayload.base_version, 1);
    assert.deepEqual(replacementPayload.caused_by, []);
    const replacementEvidencePayload = JSON.parse(replacementRows[1].payload_json);
    assert.equal(replacementEvidencePayload.bears_on_id, revisionSeed.claim_id);
    assert.equal(replacementEvidencePayload.bears_on_version, 2);
    assert.equal(replacementEvidencePayload.body_md, "tmp:revision");
    assert.deepEqual(replacementEvidencePayload.caused_by, [{
      scope: "problem", scope_id: problem,
      event_id: replacementRows[0].id, seq: replacementRows[0].seq,
    }]);
    for (const row of replacementRows) {
      assert.equal(createHash("sha256").update(row.payload_json).digest("hex"), row.payload_sha256);
      assert.equal(row.actor_session_id, replacementRows[0].actor_session_id);
      assert.equal(row.created_at, replacementRows[0].created_at);
      assert.equal(row.actor_sponsor_id, "usr_atomic_batch_revisions");
    }
    assert.deepEqual(await env.DB.prepare(
      "SELECT bears_on_id, bears_on_version FROM evidence WHERE evidence_id = ?",
    ).bind(replacementResult.body.results[1].id).first(), {
      bears_on_id: revisionSeed.claim_id, bears_on_version: 2,
    });
    assert.deepEqual(await env.DB.prepare(
      "SELECT * FROM claim_versions WHERE problem_id = ? AND claim_id = ? AND version = 1",
    ).bind(problem, revisionSeed.claim_id).first(), originalRevisionVersion);
    const replacementFace = ClaimFaceResponseSchema.parse(
      await call(`/p/${problem}/claims/${revisionSeed.claim_id}.json`),
    );
    assert.equal(replacementFace.claim_state.version, 2);
    assert.equal(replacementFace.claim_state.disposition, "open");
    assert.equal(replacementFace.claim_state.review_state, "unreviewed");
    assert.ok(JSON.stringify(replacementFace.items).includes(replacementPayload.statement));
    const replacementAfter = await snapshot();
    assert.equal(replacementAfter.tables.claims, replacementBefore.tables.claims);
    assert.equal(replacementAfter.tables.claim_versions, replacementBefore.tables.claim_versions + 1);
    assert.equal(replacementAfter.tables.claim_projections, replacementBefore.tables.claim_projections);
    assert.equal(replacementAfter.tables.outbox, replacementBefore.tables.outbox + 1);
    assert.equal(replacementAfter.tables.evidence, replacementBefore.tables.evidence + 1);
    assert.equal(replacementAfter.tables.public_cursor, replacementBefore.tables.public_cursor + 2);
    await call(`/v1/sessions/${replacementRows[0].actor_session_id}/close`, {
      handback: "The replacement and evidence retain their exact version history.",
    }, revisionAuthor, 201);
    const replacementReplayBefore = await snapshot();
    const replacementReplay = await attempt(revisionAuthor, "atomic-replace-claim", replacement);
    assert.equal(replacementReplay.status, 200);
    assert.equal(replacementReplay.raw, replacementResult.raw);
    assert.deepEqual(await snapshot(), replacementReplayBefore);
    assert.equal(await fixtures.screeningCalls(), replacementScreens + 2);

    const staleReplacement = await attempt(
      revisionAuthor, "atomic-stale-replacement", revisionMembers(1, "stale replacement"),
    );
    assert.equal(staleReplacement.status, 409);
    assert.equal(staleReplacement.body.code, "OBJECT_VERSION_CONFLICT");
    const wrongVersionMembers = revisionMembers(2, "wrong temporary version");
    wrongVersionMembers[0].data.bears_on_version = 2;
    const wrongVersionResult = await attempt(
      revisionAuthor, "atomic-replacement-wrong-version", wrongVersionMembers,
    );
    assert.equal(wrongVersionResult.status, 422);
    assert.equal(wrongVersionResult.body.code, "BATCH_DANGLING_CAUSAL_REF");
    assert.deepEqual(await snapshot(), replacementReplayBefore);
    assert.equal(await fixtures.screeningCalls(), replacementScreens + 2);

    // A real D1 fault after the head replacement restores the complete prior
    // version and permits an exact retry of the same outer checkpoint identity.
    const failedReplacementMembers = revisionMembers(2, "atomic revision fault");
    const failedReplacementBefore = await snapshot();
    const replacementHeadBefore = await env.DB.prepare(
      "SELECT * FROM claims WHERE problem_id = ? AND id = ?",
    ).bind(problem, revisionSeed.claim_id).first();
    const replacementProjectionBefore = await env.DB.prepare(
      "SELECT * FROM claim_projections WHERE problem_id = ? AND claim_id = ?",
    ).bind(problem, revisionSeed.claim_id).first();
    await env.DB.prepare(`CREATE TRIGGER atomic_revision_late_fault BEFORE INSERT ON evidence
      WHEN NEW.body_md = 'atomic revision fault'
      BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_REVISION_EVIDENCE_FAILURE'); END`).run();
    try {
      const failedReplacement = await attempt(
        revisionAuthor, "atomic-revision-late-fault", failedReplacementMembers,
      );
      assert.equal(failedReplacement.status, 500);
      assert.deepEqual(await snapshot(), failedReplacementBefore);
      assert.deepEqual(await env.DB.prepare(
        "SELECT * FROM claims WHERE problem_id = ? AND id = ?",
      ).bind(problem, revisionSeed.claim_id).first(), replacementHeadBefore);
      assert.deepEqual(await env.DB.prepare(
        "SELECT * FROM claim_projections WHERE problem_id = ? AND claim_id = ?",
      ).bind(problem, revisionSeed.claim_id).first(), replacementProjectionBefore);
    } finally {
      await env.DB.prepare("DROP TRIGGER atomic_revision_late_fault").run();
    }
    const recoveredReplacement = await attempt(
      revisionAuthor, "atomic-revision-late-fault", failedReplacementMembers,
    );
    assert.equal(recoveredReplacement.status, 201);
    assert.equal(recoveredReplacement.body.results[0].id, revisionSeed.claim_id);
    assert.equal(recoveredReplacement.body.results[0].version, 3);
    assert.equal(recoveredReplacement.body.results[0].seq, failedReplacementBefore.head.public_seq + 1);
    assert.deepEqual(await env.DB.prepare(
      "SELECT * FROM claim_versions WHERE problem_id = ? AND claim_id = ? AND version = 1",
    ).bind(problem, revisionSeed.claim_id).first(), originalRevisionVersion);

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
        temporary_claim_version_targets: true,
        claim_sequence_retry: true,
        atomic_claim_revisions: true,
        revision_version_pins: true,
        revision_rollback: true,
        claim_dependency_and_outbox_atomicity: true,
        hash_bound_causality: true,
        exact_replay_after_session_close: true,
        concurrent_outer_identity: true,
        late_projection_and_receipt_rollback: true,
        whole_batch_screening_and_quota: true,
        current_authority_at_commit: true,
        mixed_claim_evidence_and_reviews: true,
        prefix_derived_retry_trigger: true,
        independent_verification: true,
        observer_evidence_and_reviews: true,
        exact_target_revision_guard: true,
        historical_review_pins: true,
        source_visibility_guard: true,
      }),
    );
  },
);
