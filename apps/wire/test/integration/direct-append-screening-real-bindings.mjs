import assert from "node:assert/strict";
import { opsRecords, runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// P7 on the direct-append routes (beads asimposiumorg-kqz5 / b9y9) on real
// local Workerd HTTP and D1. POST /v1/p/:id/claims and /v1/p/:id/dead-ends
// open an implicit session and reuse the session executors; a rejected
// screening decision must refuse with the coarse policy response and leave
// the public sequence unchanged, and a pass must commit exactly once.
// Fixture screening decisions stand in for Workers AI.
//
// Also exercised: /v1/p/:id/reviews, /v1/p/:id/events:batch and
// /v1/sessions/:id/friction (independent verification 3 found the census
// named them screened while no lane called them), and /v1/p/:id/hypotheses,
// /v1/p/:id/evidence and the /v1/p/:id/review alias (verification 4 found
// them proven only through their session forms).

await runLocalWorkerJourney(
  async ({
    call,
    enroll,
    sponsorCall,
    fixtures,
    env,
    clearScreeningPosture,
    workerLogs,
    clearWorkerLogs,
  }) => {
    const OWNER = "usr_direct_owner";
    const author = await enroll("direct-author", OWNER);
    const reviewer = await enroll("direct-reviewer", "usr_direct_reviewer");
    const secondReviewer = await enroll("direct-reviewer-two", "usr_direct_reviewer_two");
    const created = await call(
      "/v1/problems",
      {
        title: "Direct append screening",
        statement: "Every integer in 0..45 has a square of the same parity.",
        falsifier: "An integer in 0..45 whose square has the opposite parity.",
        motivation: "Exercise screening on direct-append routes.",
        areas: ["number-theory"],
      },
      author,
      201,
    );
    const problem = created.problem.id;
    await sponsorCall(
      OWNER,
      "POST",
      `/v1/sponsors/problems/${problem}/lifecycle`,
      "problem-lifecycle",
      {
        action: "publish",
      },
    );
    const rs = (
      await call("/v1/sessions", { problem_id: problem, intent: "review" }, reviewer, 201)
    ).session_id;
    await call(
      `/v1/problems/${problem}/statement-review`,
      { session_id: rs, statement_version: 1, verdict: "statement-clear", basis: "Exact." },
      reviewer,
    );
    const publicSeq = async () =>
      Number(
        (await env.DB.prepare("SELECT public_seq FROM problems WHERE id = ?").bind(problem).first())
          .public_seq,
      );

    const claimBody = {
      kind: "conjecture",
      statement: "Zero squared is even in the direct lane.",
      falsifier: "Zero squared is odd.",
    };
    const deadEndBody = {
      approach: "Tried a parity argument through modular squares.",
      why_it_fails: "It only covers even inputs and silently skips the odd case.",
      retry_predicate: "Retry once odd inputs are handled.",
    };

    await fixtures.setScreenMode("reject");
    const before = await publicSeq();
    const screensBefore = await fixtures.screeningCalls();
    const deniedClaim = await call(`/v1/p/${problem}/claims`, claimBody, author, 403);
    const deniedDeadEnd = await call(`/v1/p/${problem}/dead-ends`, deadEndBody, author, 403);
    await fixtures.setScreenMode("pass");
    for (const denied of [deniedClaim, deniedDeadEnd]) {
      assert.equal(denied.code, "POLICY_DENIED");
      assert.ok(!JSON.stringify(denied).includes("parity"), "no candidate text echoes back");
    }
    assert.equal(await fixtures.screeningCalls(), screensBefore + 2, "both crossed screening");
    assert.equal(await publicSeq(), before, "a refused direct append commits nothing");

    const passed = await call(`/v1/p/${problem}/claims`, claimBody, author, 201);
    assert.ok(typeof passed.claim_id === "string");
    assert.equal(await publicSeq(), before + 1, "a passed direct append commits exactly once");

    // Review alias, event batch and friction carry public Fellow text too.
    const reviewBody = {
      target_claim_id: passed.claim_id,
      target_version: 1,
      verdict: "inform",
      basis: "Checked zero squared against the definition of evenness.",
      capable_of_failure: "Zero squared being odd would refute it.",
      rubric: [],
      body_md: "Zero squared is zero, which is even. No stronger generalization is tested here.",
    };
    const batchBody = {
      members: [
        {
          tempId: "tmp:c1",
          action: "claim",
          data: {
            kind: "conjecture",
            statement: "Two squared is even in the batch lane.",
            falsifier: "Two squared is odd.",
          },
        },
      ],
    };
    const frictionSession = (
      await call("/v1/sessions", { problem_id: problem, intent: "prove" }, author, 201)
    ).session_id;
    const frictionBody = {
      bears_on_id: passed.claim_id,
      bears_on_version: 1,
      source: { kind: "model_memory" },
      work: {
        format: "asimposium.formalization-friction.v1",
        blocker: "tactic-only",
        toolchain: "Lean 4 with Mathlib",
        blocked_obligation: "Show that 0 ^ 2 % 2 = 0 by decide inside the parity lemma.",
        analysis: "The goal is closed by norm_num; decide times out on the unfolded power.",
      },
    };
    const hypothesisBody = {
      route: "Reduce the parity of n squared to the parity of n.",
      mechanism: "Squaring preserves the residue of n modulo two.",
      falsifier: "An integer whose square has the opposite residue modulo two.",
      origin: "proposed",
      body_md: "Parity route: squared residues modulo two match the base residue.",
    };
    const evidenceBody = {
      bears_on_kind: "claim",
      bears_on_id: passed.claim_id,
      bears_on_version: 1,
      direction: "supports",
      kind: "argument",
      source: { kind: "model_memory" },
      mode: "confirmatory",
      body_md: "Zero squared is zero and zero is divisible by two.",
    };
    const surfaces = [
      [`/v1/p/${problem}/hypotheses`, hypothesisBody, author],
      [`/v1/p/${problem}/evidence`, evidenceBody, reviewer],
      [`/v1/p/${problem}/review`, reviewBody, secondReviewer],
      [`/v1/p/${problem}/reviews`, reviewBody, reviewer],
      [`/v1/p/${problem}/events:batch`, batchBody, author],
      [`/v1/sessions/${frictionSession}/friction`, frictionBody, author],
    ];
    await fixtures.setScreenMode("reject");
    const seqBeforeSurfaces = await publicSeq();
    const screensBeforeSurfaces = await fixtures.screeningCalls();
    clearWorkerLogs();
    for (const [path, body, token] of surfaces) {
      const denied = await call(path, body, token, 403);
      assert.equal(denied.code, "POLICY_DENIED", path);
      assert.ok(
        !/squared|residue/.test(JSON.stringify(denied)),
        `${path}: no candidate text echoes back`,
      );
    }
    // OPS.2a (rvi): one fellow-write record per refused write, carrying the
    // coarse code and never the candidate text.
    const refusedRecords = opsRecords(workerLogs(), "fellow-write");
    assert.equal(refusedRecords.length, surfaces.length, "one record per refused write");
    for (const record of refusedRecords) {
      assert.equal(record.status, 403);
      assert.equal(record.outcome, "refused");
      assert.equal(record.code, "POLICY_DENIED");
      assert.equal(record.event_id, null);
      assert.match(record.idempotency_key_digest, /^[0-9a-f]{64}$/);
    }
    await fixtures.setScreenMode("pass");
    // The canary refusals put Fellows in quarantine-first; their sponsors clear
    // them (the screening-call count below covers only the refused attempts).
    const cleared =
      (await clearScreeningPosture(OWNER)) +
      (await clearScreeningPosture("usr_direct_reviewer")) +
      (await clearScreeningPosture("usr_direct_reviewer_two"));
    assert.ok(cleared >= 1, "at least one Fellow was quarantine-first");
    assert.equal(
      await fixtures.screeningCalls(),
      screensBeforeSurfaces + surfaces.length,
      "every surface crossed screening exactly once",
    );
    assert.equal(await publicSeq(), seqBeforeSurfaces, "refused surfaces commit nothing");
    clearWorkerLogs();
    for (const [path, body, token] of surfaces) {
      const accepted = await call(path, body, token, null);
      assert.ok(accepted.code === undefined, `${path} commits after a pass: ${accepted.code}`);
    }
    assert.equal(
      await publicSeq(),
      seqBeforeSurfaces + surfaces.length,
      "each passed surface commits once",
    );
    const committedRecords = opsRecords(workerLogs(), "fellow-write");
    assert.equal(committedRecords.length, surfaces.length, "one record per committed write");
    assert.deepEqual(committedRecords.map((record) => record.route).sort(), [
      "/v1/p/:id/events:batch",
      "/v1/p/:id/evidence",
      "/v1/p/:id/hypotheses",
      "/v1/p/:id/review",
      "/v1/p/:id/reviews",
      // friction forwards to the evidence handler that ran
      "/v1/sessions/:id/evidence",
    ]);
    for (const record of committedRecords) {
      assert.equal(record.outcome, "committed-or-replayed", record.route);
      assert.equal(record.code, null, record.route);
      if (record.event_id !== null) {
        const row = await env.DB.prepare("SELECT seq FROM events WHERE id = ?")
          .bind(record.event_id)
          .first();
        assert.ok(row, `${record.route}: the logged event exists`);
        if (record.seq !== null) assert.equal(row.seq, record.seq, record.route);
      }
    }
    const logText = workerLogs()
      .map((log) => log.message)
      .join("\n");
    for (const [, body] of surfaces) {
      for (const text of Object.values(body).filter((v) => typeof v === "string" && v.length > 24))
        assert.ok(!logText.includes(text), "no write body reaches the Worker log");
    }

    console.log(
      JSON.stringify({
        stage: "direct-append-screening-journey-passed",
        kind: "direct-append-screening-real-bindings",
        status: "pass",
        boundary:
          "local Workerd/D1; fixture screening; claims, dead-ends, hypotheses, evidence, review, reviews, events:batch and friction routes",
      }),
    );
  },
);
