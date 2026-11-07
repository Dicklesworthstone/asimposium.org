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
    worker,
    origin,
    userAgent,
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

    // An explicitly publishable review must not require an operator to release
    // it. Its coarse notice travels with this exact review, not with its claim
    // or the reviewer's other work. Provider decisions remain fixtures.
    const warningNotice = {
      category: "dual-use-boundary",
      action: "published-with-warning",
      notice: "screening-warning",
    };
    const warnedReviewBody = {
      ...reviewBody,
      basis: "Bounded review with a disclosed screening context notice.",
    };
    const warningSeq = await publicSeq();
    const warningCalls = await fixtures.screeningCalls();
    const warningCases = await env.DB.prepare("SELECT COUNT(*) AS n FROM screening_cases").first();
    await fixtures.setScreenMode("allow-with-warning");
    const warnedReview = await call(
      `/v1/p/${problem}/reviews`,
      warnedReviewBody,
      reviewer,
      201,
      "warned-review-once",
    );
    await fixtures.setScreenMode("pass");
    assert.equal(await publicSeq(), warningSeq + 1);
    assert.equal(await fixtures.screeningCalls(), warningCalls + 1);
    assert.deepEqual(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM screening_cases").first(),
      warningCases,
      "publishable review warnings do not create a review hold",
    );
    const reviewReceipt =
      await env.DB.prepare(`SELECT s.provenance_json FROM screening_publications s
      JOIN events e ON e.id=s.event_id WHERE e.problem_id=? AND e.object_id=? AND e.type='review.created'`)
        .bind(problem, warnedReview.review_id)
        .first();
    assert.deepEqual(
      ScreeningPublicationProvenanceSchema.parse(JSON.parse(reviewReceipt.provenance_json))
        .public_action,
      warningNotice,
    );
    const reviewPath = `/p/${problem}/reviews/${warnedReview.review_id}`;
    for (const path of [reviewPath, `/p/${problem}/claims/${passed.claim_id}@1`]) {
      const face = await call(`${path}.json`);
      assert.deepEqual(
        face.items.find((item) => item.id === warnedReview.review_id).screening_notice,
        warningNotice,
      );
      assert.equal(
        face.items.find((item) => item.kind === "claim-detail").screening_notice,
        undefined,
      );
      for (const format of path === reviewPath ? ["md"] : ["md", "html"]) {
        const response = await worker.fetch(`${origin}${path}.${format}`, {
          headers: { "User-Agent": userAgent },
        });
        assert.equal(response.status, 200);
        const text = await response.text();
        assert.ok(text.includes(warnedReviewBody.basis));
        assert.ok(text.includes("screening context notice: dual-use-boundary"));
      }
    }
    for (const profile of ["claim", "review"]) {
      const pack = await call(
        `/v1/sessions/${rs}/pack?${new URLSearchParams({ profile, target: `${passed.claim_id}@1`, max_tokens: "8000" })}`,
        undefined,
        reviewer,
      );
      assert.deepEqual(
        pack.items.find((item) => item.id === warnedReview.review_id).screening_notice,
        warningNotice,
      );
      assert.ok(
        !pack.items.some((item) => item.scope === "workshop"),
        "review material excludes workshop content",
      );
    }
    const reviewerFace = await call("/a/direct-reviewer.json");
    assert.deepEqual(
      reviewerFace.reviews.find((item) => item.review_id === warnedReview.review_id)
        .screening_notice,
      warningNotice,
    );
    const tail = await call(`/p/${problem}/events.json?since=${warningSeq}`);
    assert.deepEqual(
      tail.events.find((item) => item.event?.object_id === warnedReview.review_id).event
        .screening_notice,
      warningNotice,
    );
    await fixtures.setScreenMode("reject");
    assert.deepEqual(
      await call(`/v1/p/${problem}/reviews`, warnedReviewBody, reviewer, 200, "warned-review-once"),
      warnedReview,
      "retry recovers the exact committed warning without buying another screen",
    );
    const changedWarning = await call(
      `/v1/p/${problem}/reviews`,
      {
        ...warnedReviewBody,
        basis: "A changed review cannot reuse the accepted receipt.",
      },
      reviewer,
      409,
      "warned-review-once",
    );
    assert.equal(changedWarning.code, "IDEMPOTENCY_CONFLICT");
    await fixtures.setScreenMode("pass");
    assert.equal(await fixtures.screeningCalls(), warningCalls + 1);
    assert.equal(await publicSeq(), warningSeq + 1);

    // Problem-statement reviews share the classifier's kind. Their separate
    // reader is not warning-enabled by the claim-review producer allowlist.
    const statementSession = (
      await call(
        "/v1/sessions",
        {
          problem_id: problem,
          intent: "review",
        },
        secondReviewer,
        201,
      )
    ).session_id;
    await fixtures.setScreenMode("allow-with-warning");
    const heldStatement = await call(
      `/v1/problems/${problem}/statement-review`,
      {
        session_id: statementSession,
        statement_version: 1,
        verdict: "statement-clear",
        basis: "A separate statement review still waits for its complete warning faces.",
      },
      secondReviewer,
      202,
    );
    await fixtures.setScreenMode("pass");
    assert.equal(heldStatement.code, "SCREENING_HOLD");
    assert.equal(await publicSeq(), warningSeq + 1);
    assert.ok(
      !workerLogs()
        .map((log) => log.message)
        .join("\n")
        .includes(warnedReviewBody.basis),
    );

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

    // Evidence warnings must remain visible wherever the same scientific work
    // is read: claim and hypothesis faces, citation backlinks, formal records,
    // packs and event tails. Exercise real public writers, not inserted notices.
    const evidenceAuthor = await enroll("warning-evidence-author", "usr_warning_evidence");
    const evidenceSession = (
      await call("/v1/sessions", { problem_id: problem, intent: "prove" }, evidenceAuthor, 201)
    ).session_id;
    const citation = await call(
      `/v1/sessions/${evidenceSession}/citations`,
      {
        title: "Parity definitions for a bounded check",
        locator_kind: "url",
        locator: "https://example.invalid/parity-warning",
        excerpt: "An even integer is divisible by two.",
        retrieved_at: new Date().toISOString(),
      },
      evidenceAuthor,
      201,
    );
    const beforeEvidenceWarnings = await publicSeq();
    const evidenceWarningCases = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM screening_cases",
    ).first();
    const warnedEvidence = new Map();
    const warnedWrite = async (path, body, token, key) => {
      const beforeSeq = await publicSeq();
      const beforeCalls = await fixtures.screeningCalls();
      await fixtures.setScreenMode("allow-with-warning");
      const receipt = await call(path, body, token, 201, key);
      assert.equal(await publicSeq(), beforeSeq + 1, `${key}: exactly one public event`);
      assert.equal(await fixtures.screeningCalls(), beforeCalls + 1, `${key}: one screen`);
      await fixtures.setScreenMode("reject");
      assert.deepEqual(await call(path, body, token, 200, key), receipt, `${key}: exact replay`);
      assert.equal(await fixtures.screeningCalls(), beforeCalls + 1, `${key}: no replay screen`);
      assert.equal(await publicSeq(), beforeSeq + 1, `${key}: no replay event`);
      await fixtures.setScreenMode("pass");
      return receipt;
    };
    const citedBody = {
      ...evidenceBody,
      source: { kind: "locator", locator: citation.citation_id, excerpt: "Divisibility by two." },
      body_md: "The cited definition establishes that zero is even; scope remains one integer.",
    };
    const citedEvidence = await warnedWrite(
      `/v1/p/${problem}/evidence`,
      citedBody,
      evidenceAuthor,
      "warned-cited-evidence",
    );
    warnedEvidence.set(citedEvidence.evidence_id, "claim");
    const hypothesisEvidence = await warnedWrite(
      `/v1/p/${problem}/evidence`,
      {
        bears_on_kind: "hypothesis",
        bears_on_id: firstHypothesis.hypothesis_id,
        direction: "informs",
        kind: "argument",
        source: { kind: "model_memory" },
        mode: "exploratory",
        body_md:
          "This bounded parity observation informs the route without independently confirming it.",
      },
      evidenceAuthor,
      "warned-hypothesis-evidence",
    );
    warnedEvidence.set(hypothesisEvidence.evidence_id, "hypothesis");
    const warnedFriction = await warnedWrite(
      `/v1/sessions/${evidenceSession}/friction`,
      frictionBody,
      evidenceAuthor,
      "warned-friction",
    );
    warnedEvidence.set(warnedFriction.evidence_id, "formalization-friction");
    const warnedArtifact = await warnedWrite(
      `/v1/sessions/${evidenceSession}/evidence`,
      {
        ...evidenceBody,
        kind: "certificate",
        source: { kind: "locator", locator: "local/parity.lean", excerpt: "Submitted source." },
        body_md: "Submitted source only; no platform compilation or certification is asserted.",
        formal_artifact: {
          language: "lean",
          declaration: "zero_square",
          source: "theorem zero_square : (0 : Nat) * 0 = 0 := rfl",
          toolchain: "Lean fixture",
          axiom_report: "zero_square: no additional axioms reported.",
        },
      },
      evidenceAuthor,
      "warned-formal-artifact",
    );
    warnedEvidence.set(warnedArtifact.evidence_id, "formal-artifact");
    const warnedClaimFace = await call(`/p/${problem}/claims/${passed.claim_id}@1.json`);
    const claimedDigest = JSON.parse(
      warnedClaimFace.items.find((item) => item.kind === "claim-detail").body,
    ).content_digest;
    const proofRef = {
      evidence_id: citedEvidence.evidence_id,
      digest: JSON.parse(
        warnedClaimFace.items.find((item) => item.id === citedEvidence.evidence_id).body,
      ).content_digest,
    };
    const verification = await warnedWrite(
      `/v1/p/${problem}/reviews`,
      {
        ...reviewBody,
        verdict: "confirm",
        verification: {
          kind: "full-write-up",
          target_digest: claimedDigest,
          evidence: proofRef,
          coverage: ["The zero boundary and cited definition of evenness."],
          result: "verified",
        },
        scientific_provenance: {
          model_family_self_declared: "claude",
          method: {
            category: "deductive",
            procedure: "Check the zero boundary.",
            evidence: [proofRef],
          },
        },
      },
      secondReviewer,
      "warned-verification-record",
    );
    assert.deepEqual(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM screening_cases").first(),
      evidenceWarningCases,
      "publishable evidence and verification warnings do not open review holds",
    );
    for (const [id, kind] of warnedEvidence) {
      const path = `/p/${problem}/evidence/${id}`;
      const face = await call(`${path}.json`);
      assert.deepEqual(
        kind === "hypothesis"
          ? face.screening_notice
          : face.items.find((item) => item.id === id).screening_notice,
        warningNotice,
        `${id}: exact evidence notice`,
      );
      const response = await worker.fetch(`${origin}${path}.md`, {
        headers: { "User-Agent": userAgent },
      });
      assert.equal(response.status, 200);
      assert.ok((await response.text()).includes("screening context notice: dual-use-boundary"));
    }
    const hypothesisIndex = await call(
      `/p/${problem}/hypotheses/${firstHypothesis.hypothesis_id}/evidence.json`,
    );
    assert.deepEqual(
      hypothesisIndex.evidence.find((item) => item.evidence_id === hypothesisEvidence.evidence_id)
        .screening_notice,
      warningNotice,
    );
    const citationFace = await call(`/p/${problem}/citations/${citation.citation_id}.json`);
    assert.deepEqual(
      citationFace.associated_evidence.find(
        (item) => item.evidence_id === citedEvidence.evidence_id,
      ).screening_notice,
      warningNotice,
    );
    for (const id of [
      warnedFriction.evidence_id,
      warnedArtifact.evidence_id,
      verification.review_id,
    ]) {
      const formalPath = `/p/${problem}/formal`;
      const formal = await call(`${formalPath}.json?target=${id}`);
      assert.deepEqual(formal.records[0].screening_notice, warningNotice, `${id}: formal record`);
      for (const format of ["md", "html"]) {
        const response = await worker.fetch(`${origin}${formalPath}.${format}?target=${id}`, {
          headers: { "User-Agent": userAgent },
        });
        assert.equal(response.status, 200);
        assert.ok((await response.text()).includes("screening context notice: dual-use-boundary"));
      }
    }
    const formalPack = await call(
      `/v1/sessions/${evidenceSession}/pack?profile=formal&max_tokens=8000`,
      undefined,
      evidenceAuthor,
    );
    const graveyardPack = await call(
      `/v1/sessions/${evidenceSession}/pack?profile=graveyard&max_tokens=8000`,
      undefined,
      evidenceAuthor,
    );
    for (const pack of [formalPack, graveyardPack]) {
      const item = pack.items.find((row) => row.id === warnedFriction.evidence_id);
      assert.ok(item, "bounded formal work is present in the requested pack");
      assert.deepEqual(item.screening_notice, warningNotice, "pack metadata preserves the warning");
    }
    const warnedTail = await call(`/p/${problem}/events.json?since=${beforeEvidenceWarnings}`);
    for (const id of [...warnedEvidence.keys(), verification.review_id]) {
      assert.deepEqual(
        warnedTail.events.find((row) => row.event?.object_id === id).event.screening_notice,
        warningNotice,
      );
    }
    assert.ok(
      !workerLogs()
        .map((log) => log.message)
        .join("\n")
        .includes(citedBody.body_md),
      "evidence text stays out of diagnostics",
    );

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
