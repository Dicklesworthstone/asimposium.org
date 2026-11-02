import assert from "node:assert/strict";
import { ScreeningPublicationProvenanceSchema } from "../../../../packages/contracts/src/screening.ts";
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

    // The mounted convenience route must preserve the real atomic writer's
    // screening, attribution, evidence semantics and replay behavior.
    const firstHypothesis = await env.DB.prepare(
      "SELECT hypothesis_id FROM hypotheses WHERE problem_id = ? ORDER BY hypothesis_id LIMIT 1",
    )
      .bind(problem)
      .first();
    assert.ok(firstHypothesis);
    const secondHypothesis = await call(
      `/v1/p/${problem}/hypotheses`,
      {
        ...hypothesisBody,
        route: "Squaring changes zero to an odd residue.",
        mechanism: "The proposed parity flip also applies at zero.",
        falsifier: "Zero squared having an even residue.",
        body_md: "This deliberately competing route predicts an odd residue at zero.",
      },
      author,
      201,
    );
    const experiment = {
      kind: "argument",
      source: { kind: "model_memory" },
      mode: "exploratory",
      work: {
        question: "Two-route parity experiment at zero",
        protocol: "Apply the definition of squaring and evaluate the residue of zero modulo two.",
        observation: "Zero multiplied by zero is zero, which has residue zero modulo two.",
        limitations: "Only the zero boundary is considered; this is no proof over all integers.",
        prediction_timing_self_declared: "after-observation",
        cases: [
          {
            hypothesis_id: firstHypothesis.hypothesis_id,
            prediction: "The residue at zero is even.",
            would_count_against: "An odd residue at zero.",
            direction: "supports",
            interpretation: "The observed boundary is consistent with parity preservation.",
          },
          {
            hypothesis_id: secondHypothesis.hypothesis_id,
            prediction: "The residue at zero is odd.",
            would_count_against: "An even residue at zero.",
            direction: "refutes",
            interpretation: "The observed boundary contradicts the proposed parity flip.",
          },
        ],
      },
    };
    const experimentPath = `/v1/p/${problem}/discrimination`;
    const publicationState = async () => ({
      ledger: await env.DB.prepare(`SELECT public_seq,
        (SELECT COUNT(*) FROM events WHERE problem_id = ?1) AS events,
        (SELECT COUNT(*) FROM evidence WHERE problem_id = ?1) AS evidence,
        (SELECT COUNT(*) FROM outbox) AS outbox,
        (SELECT COUNT(*) FROM screening_publications s JOIN events e ON e.id = s.event_id
          WHERE e.problem_id = ?1) AS screens
        FROM problems WHERE id = ?1`)
        .bind(problem)
        .first(),
      publicObjects: (await env.PUBLIC_ARTIFACTS.list()).objects.map((row) => row.key).sort(),
    });
    const beforeExperiment = await publicationState();
    for (const [mode, status, code] of [
      ["reject", 403, "POLICY_DENIED"],
      ["quarantine", 202, "SCREENING_HOLD"],
      ["unavailable", 202, "SCREENING_HOLD"],
    ]) {
      await clearScreeningPosture(OWNER);
      await fixtures.setScreenMode(mode);
      const callsBefore = await fixtures.screeningCalls();
      const refused = await call(experimentPath, experiment, author, status);
      assert.equal(refused.code, code, `${mode}: ordinary batch screening response`);
      assert.equal(await fixtures.screeningCalls(), callsBefore + 1, `${mode}: reached provider`);
      assert.deepEqual(await publicationState(), beforeExperiment, `${mode}: no public mutation`);
      assert.ok(!JSON.stringify(refused).includes(experiment.work.observation));
    }
    await clearScreeningPosture(OWNER);
    await fixtures.setScreenMode("pass");
    const revokedAuthor = await enroll("discrimination-revoked", "usr_discrimination_revoked");
    const beforeRevocation = await publicationState();
    const callsBeforeRevocation = await fixtures.screeningCalls();
    await fixtures.revokeOnNextScreen();
    const revoked = await call(experimentPath, experiment, revokedAuthor, 403, "experiment-revoke");
    assert.equal(revoked.code, "WRITE_REFUSED", "a completed screen cannot override revocation");
    assert.ok((await fixtures.screeningCalls()) > callsBeforeRevocation, "screening actually ran");
    assert.deepEqual(
      await publicationState(),
      beforeRevocation,
      "revocation rolls back both members",
    );
    const callsAfterRevocation = await fixtures.screeningCalls();
    const revokedRetry = await call(
      experimentPath,
      experiment,
      revokedAuthor,
      401,
      "experiment-revoke",
    );
    assert.equal(revokedRetry.code, "FELLOW_TOKEN_INVALID");
    assert.equal(
      await fixtures.screeningCalls(),
      callsAfterRevocation,
      "revoked retry does not screen",
    );
    assert.deepEqual(await publicationState(), beforeRevocation);
    const callsBeforeExperiment = await fixtures.screeningCalls();
    const experimentKey = "direct-discrimination-experiment";
    const acceptedExperiment = await call(experimentPath, experiment, author, 201, experimentKey);
    assert.equal(acceptedExperiment.ok, true);
    assert.equal(acceptedExperiment.results.length, 2);
    assert.equal(new Set(acceptedExperiment.results.map((row) => row.id)).size, 2);
    assert.equal(await publicSeq(), beforeExperiment.ledger.public_seq + 2);
    assert.equal(await fixtures.screeningCalls(), callsBeforeExperiment + 2);
    const expectedReport = {
      format: "asimposium.discrimination.v1",
      problem_id: problem,
      ...experiment,
    };
    for (const [index, result] of acceptedExperiment.results.entries()) {
      const row = await env.DB.prepare(
        "SELECT bears_on_id, direction, computed_class, mode, body_md FROM evidence WHERE problem_id = ? AND evidence_id = ?",
      )
        .bind(problem, result.id)
        .first();
      assert.ok(row, "each returned evidence id names a committed projection");
      assert.equal(result.action, "evidence");
      assert.equal(row.bears_on_id, experiment.work.cases[index].hypothesis_id);
      assert.equal(row.direction, experiment.work.cases[index].direction);
      assert.equal(row.computed_class, "assertion", "model memory does not mint verification");
      assert.equal(row.mode, "exploratory");
      assert.deepEqual(JSON.parse(row.body_md), expectedReport, "one exact authored report");
      const publication = await env.DB.prepare(`SELECT e.object_id, e.object_kind, s.provenance_json
        FROM events e JOIN event_content c ON c.event_id = e.id
        JOIN screening_publications s ON s.event_id = e.id
        WHERE e.problem_id = ? AND e.seq = ?`)
        .bind(problem, result.seq)
        .first();
      assert.ok(publication, "each returned sequence has immutable screening provenance");
      assert.equal(publication.object_id, result.id, "the event names this evidence");
      assert.equal(publication.object_kind, "evidence");
      ScreeningPublicationProvenanceSchema.parse(JSON.parse(publication.provenance_json));
      const face = await call(`/p/${problem}/evidence/${result.id}.json`);
      assert.ok(JSON.stringify(face).includes(experiment.work.question), "public evidence face");
    }
    const screenedExperiment = await fixtures.lastScreening();
    const screenedCandidate = JSON.stringify(
      JSON.parse(screenedExperiment.publication_body).current_candidate,
    );
    const experimentTexts = [
      experiment.work.question,
      experiment.work.protocol,
      experiment.work.observation,
      experiment.work.limitations,
      ...experiment.work.cases.flatMap((item) => [
        item.prediction,
        item.would_count_against,
        item.interpretation,
      ]),
    ];
    for (const text of experimentTexts) {
      assert.ok(
        screenedCandidate.includes(text),
        "the current screening candidate includes every work field",
      );
    }
    const afterExperiment = await publicationState();
    for (const field of ["events", "evidence", "screens"]) {
      assert.equal(
        afterExperiment.ledger[field],
        beforeExperiment.ledger[field] + 2,
        `exactly two accepted ${field}`,
      );
    }
    const replayedExperiment = await call(experimentPath, experiment, author, 200, experimentKey);
    assert.deepEqual(replayedExperiment, acceptedExperiment, "recover the original batch receipt");
    const changedExperiment = await call(
      experimentPath,
      { ...experiment, work: { ...experiment.work, limitations: "A deliberately changed scope." } },
      author,
      409,
      experimentKey,
    );
    assert.equal(changedExperiment.code, "IDEMPOTENCY_CONFLICT");
    assert.equal(
      await fixtures.screeningCalls(),
      callsBeforeExperiment + 2,
      "replay does not rescreen",
    );
    assert.deepEqual(await publicationState(), afterExperiment, "replay/conflict append nothing");
    const experimentLogs = workerLogs()
      .map((log) => log.message)
      .join("\n");
    for (const text of experimentTexts) {
      assert.ok(!experimentLogs.includes(text), "experiment prose never reaches Worker logs");
    }

    console.log(
      JSON.stringify({
        stage: "direct-append-screening-journey-passed",
        kind: "direct-append-screening-real-bindings",
        status: "pass",
        boundary:
          "local Workerd/D1/R2; fixture screening; direct writes, discrimination, atomic evidence and replay",
      }),
    );
  },
);
