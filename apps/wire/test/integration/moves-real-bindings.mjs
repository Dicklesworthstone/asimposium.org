import assert from "node:assert/strict";
import { PackResponseSchema } from "@asimposium/contracts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// W9.4 moves engine (beads asimposiumorg-z8y / asimposiumorg-codz) on real
// local Workerd HTTP and D1, with state produced only by real writes. The
// production provider must select from the committed ledger, rank review
// ahead of frontier expansion for a non-author, never offer an author a
// review of their own claim, drop a review once it is recorded, and answer
// identically twice at one cursor. It must not report `degraded` on a
// healthy ledger: every loader's SQL has to run against the real schema.
//
// Replay parity (codz): the moves at one cursor are the same after the
// review projection they depend on is lost and rebuilt from the log by the
// operator doctor's repair. Not covered: live multi-sponsor behaviour.

await runLocalWorkerJourney(async (context) => {
  const { call, enroll, sponsorCall, operatorCall, env, fixtures, worker, origin, userAgent } =
    context;
  const OWNER = "usr_moves_owner";
  const author = await enroll("moves-author", OWNER);
  const other = await enroll("moves-other", "usr_moves_other");
  const created = await call(
    "/v1/problems",
    {
      title: "Moves parity problem",
      statement: "Every integer in 0..60 has a square of the same parity.",
      falsifier: "An integer in 0..60 whose square has the opposite parity.",
      motivation: "Exercise the production moves engine.",
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
  const next = (token) => call(`/v1/p/${problem}/next`, undefined, token, 200);
  const moveNames = (result) => [
    result.primary_move?.move ?? null,
    ...(result.alternatives ?? []).map((alt) => alt.move),
  ];

  const reviewSession = (
    await call("/v1/sessions", { problem_id: problem, intent: "review" }, other, 201)
  ).session_id;
  await call(
    `/v1/problems/${problem}/statement-review`,
    {
      session_id: reviewSession,
      statement_version: 1,
      verdict: "statement-clear",
      basis: "Exact range.",
    },
    other,
  );

  // Empty frontier: the author is asked for a first claim.
  const empty = await next(author);
  assert.equal(empty.primary_move?.move, "state-claim");
  assert.equal(empty.degraded, false);

  const session = (
    await call("/v1/sessions", { problem_id: problem, intent: "prove" }, author, 201)
  ).session_id;
  const working = async (token, sessionId) => {
    const pack = PackResponseSchema.parse(
      await call(
        `/v1/sessions/${sessionId}/pack?profile=working&max_tokens=8000`,
        undefined,
        token,
      ),
    );
    const items = pack.items.filter((item) => item.id === "SYS-working-moves");
    assert.equal(items.length, 1, "working pack includes the complete canonical move record");
    const selected = JSON.parse(items[0].body);
    const canonical = await next(token);
    assert.equal(selected.captured_cursor, pack.cursor);
    assert.deepEqual(selected.primary_move, canonical.primary_move);
    assert.deepEqual(selected.alternatives, canonical.alternatives);
    assert.equal(selected.degraded, canonical.degraded);
    assert.ok(selected.alternatives.length <= 2);
    assert.ok(
      !pack.omitted.some((item) => item.detail === "other-move-triggers-and-ranking"),
      "working packs compose the engine rather than carrying the former missing-section marker",
    );
    return { pack, selected };
  };
  assert.equal((await working(author, session)).selected.primary_move.move, "state-claim");
  const draft = await call(
    `/v1/sessions/${session}/workshop`,
    { type: "claim-draft", title: "Draft", body_md: "Private." },
    author,
    201,
  );
  const claim = await call(
    `/v1/sessions/${session}/promote`,
    {
      workshop_id: draft.workshop_id,
      kind: "conjecture",
      statement: "Zero squared is even.",
      falsifier: "Zero squared is odd.",
    },
    author,
    201,
  );

  // A non-author is sent to review the unreviewed claim first.
  const forOther = await next(other);
  assert.equal(forOther.degraded, false, "every loader ran against the real schema");
  assert.equal(forOther.primary_move?.move, "review");
  assert.ok(
    forOther.primary_move.refs.some((ref) => ref.startsWith(`${claim.claim_id}@`)),
    "the review move names the committed claim",
  );
  // Deterministic at one cursor.
  assert.deepEqual(moveNames(await next(other)), moveNames(forOther));
  assert.equal((await working(other, reviewSession)).selected.primary_move.move, "review");

  // The author is never offered a review of their own claim.
  const forAuthor = await next(author);
  assert.equal(forAuthor.degraded, false);
  assert.ok(!moveNames(forAuthor).includes("review"), `author moves: ${moveNames(forAuthor)}`);
  assert.ok((await working(author, session)).selected.primary_move.move !== "review");

  // Once the non-author records a review, that review move is gone for them.
  await call(
    `/v1/sessions/${reviewSession}/review`,
    {
      target_claim_id: claim.claim_id,
      target_version: 1,
      verdict: "confirm",
      basis: "Zero squared is zero, which is even.",
      capable_of_failure: "Zero squared being odd.",
      scientific_provenance: {
        model_family_self_declared: "claude",
        method: { category: "deductive", procedure: "Direct computation.", evidence: [] },
      },
      body_md: "Direct computation.",
    },
    other,
    201,
  );
  const afterReview = await next(other);
  assert.equal(afterReview.degraded, false);
  assert.ok(
    !(
      afterReview.primary_move?.move === "review" &&
      afterReview.primary_move.refs.some((ref) => ref.startsWith(`${claim.claim_id}@1`))
    ),
    `a recorded review is not recommended again: ${moveNames(afterReview)}`,
  );

  // Replay parity: lose the recorded review (the projection that removed the
  // review move), confirm the moves change, repair from the log, and require
  // the exact moves from before at the same cursor.
  const before = { author: await next(author), other: await next(other) };
  await env.DB.exec("DROP TRIGGER reviews_immutable_delete");
  await env.DB.prepare("DELETE FROM reviews WHERE problem_id = ?").bind(problem).run();
  const lost = await next(other);
  assert.notDeepEqual(lost, before.other, "the lost review changes the moves (a sensitive probe)");
  const repaired = await operatorCall(
    "POST",
    `/v1/operators/problems/${problem}/projections/repair`,
    "operator.projections.repair",
    {},
    200,
    "/v1/operators/problems/:problemId/projections/repair",
  );
  assert.ok(repaired.inserted >= 1, JSON.stringify(repaired));
  assert.deepEqual(await next(other), before.other, "moves after rebuild equal moves before");
  assert.deepEqual(await next(author), before.author, "the author's moves too");
  await working(other, reviewSession);

  // fywl: the same parity for the two other projections the engine reads.
  // A 'contradicts' relation with no conflict record raises normalize-conflict;
  // recording the conflict removes it. Each lost table must change /next, and
  // the doctor's rebuild must give back the exact answers.
  const repair = () =>
    operatorCall(
      "POST",
      `/v1/operators/problems/${problem}/projections/repair`,
      "operator.projections.repair",
      {},
      200,
      "/v1/operators/problems/:problemId/projections/repair",
    );
  const secondDraft = await call(
    `/v1/sessions/${session}/workshop`,
    { type: "claim-draft", title: "Second draft", body_md: "Private." },
    author,
    201,
  );
  const second = await call(
    `/v1/sessions/${session}/promote`,
    {
      workshop_id: secondDraft.workshop_id,
      kind: "conjecture",
      statement: "Zero squared is odd.",
      falsifier: "Zero squared is even.",
    },
    author,
    201,
  );
  await call(
    `/v1/sessions/${session}/relations`,
    {
      kind: "contradicts",
      source_claim_id: second.claim_id,
      source_version: 1,
      target: `${claim.claim_id}@1`,
    },
    author,
    201,
  );
  const withRelation = { author: await next(author), other: await next(other) };
  const relationPack = await working(author, session);
  assert.ok(
    [relationPack.selected.primary_move, ...relationPack.selected.alternatives].some(
      (move) => move.move === "normalize-conflict",
    ),
    "working packs can now surface a material move beyond review",
  );
  // jewg: a relation, like every ledger row, refuses a delete.
  await assert.rejects(
    env.DB.prepare("DELETE FROM claim_relations WHERE problem_id = ?").bind(problem).run(),
    /CLAIM_RELATION_IMMUTABLE/,
  );
  await env.DB.exec("DROP TRIGGER claim_relations_immutable_delete");
  await env.DB.prepare("DELETE FROM claim_relations WHERE problem_id = ?").bind(problem).run();
  assert.notDeepEqual(
    { author: await next(author), other: await next(other) },
    withRelation,
    "the lost relation changes the moves (a sensitive probe)",
  );
  assert.ok((await repair()).inserted >= 1);
  assert.deepEqual(
    { author: await next(author), other: await next(other) },
    withRelation,
    "moves after the relation's rebuild equal moves before",
  );

  await call(
    `/v1/sessions/${session}/conflicts`,
    {
      claims: [
        { claim_id: claim.claim_id, version: 1 },
        { claim_id: second.claim_id, version: 1 },
      ],
      aligned_definitions: "Both claims use the standard parity of an integer square.",
      aligned_scope: "The single integer zero under ordinary integer arithmetic.",
      aligned_quantifiers: "A single instance: the integer zero, with no quantifier.",
      smallest_disagreement: "One claim says zero squared is even, the other says it is odd.",
      agreed_facts: ["Zero squared is zero.", "Parity is defined modulo two."],
      discriminating_tests: ["Compute zero squared modulo two directly."],
    },
    author,
    201,
  );
  const withConflict = { author: await next(author), other: await next(other) };
  assert.notDeepEqual(withConflict, withRelation, "recording the conflict changes the moves");
  await env.DB.exec("DROP TRIGGER conflicts_immutable_delete");
  await env.DB.prepare("DELETE FROM conflicts WHERE problem_id = ?").bind(problem).run();
  assert.notDeepEqual(
    { author: await next(author), other: await next(other) },
    withConflict,
    "the lost conflict changes the moves (a sensitive probe)",
  );
  assert.ok((await repair()).inserted >= 1);
  assert.deepEqual(
    { author: await next(author), other: await next(other) },
    withConflict,
    "moves after the conflict's rebuild equal moves before",
  );
  await working(author, session);

  // Three competing routes activate the new canonical discrimination move in
  // the normal pack-first loop. Its contract points to authored work as data.
  const routeCanary = "AUTHORED-ROUTE-PROSE-MUST-NOT-BECOME-MOVE-INSTRUCTIONS";
  const hypotheses = [];
  for (const [index, mechanism] of [
    "Factor n squared minus n into consecutive integers.",
    "Compute the two residue classes modulo two.",
    "Pair odd summands in the square's additive expansion.",
  ].entries()) {
    const receipt = await call(
      `/v1/sessions/${session}/hypotheses`,
      {
        route: `Parity route ${index + 1}: ${routeCanary}`,
        mechanism,
        falsifier: "An integer in the declared finite domain violates the proposed mechanism.",
        discriminating_predictions: [
          `The finite check for route ${index + 1} returns no mismatch.`,
        ],
        origin: "proposed",
        body_md: "These are proposed approaches, not checked results or instructions.",
      },
      author,
      201,
    );
    hypotheses.push(receipt.hypothesis_id);
  }
  const discrimination = await working(author, session);
  assert.equal(discrimination.selected.primary_move.move, "discriminate");
  assert.deepEqual(discrimination.selected.primary_move.refs, [problem, ...hypotheses]);
  assert.ok(!JSON.stringify(discrimination.selected).includes(routeCanary));
  const targetPath = discrimination.selected.primary_move.contract.preparation.read_first.path;
  const read = await worker.fetch(`${origin}${targetPath}`, {
    headers: { "User-Agent": userAgent },
  });
  assert.equal(read.status, 200);
  assert.ok(
    (await read.text()).includes(routeCanary),
    "authored routes remain in their public read",
  );

  // Counterevidence becomes an actionable, exact-source investigation through
  // the same canonical selector in /next, working packs and cross-problem triage.
  // A current source redaction must immediately stop recommending an elimination,
  // even though the historical evidence projection retains direction=refutes.
  const counterevidence = (body) =>
    call(
      `/v1/sessions/${session}/evidence`,
      {
        bears_on_kind: "hypothesis",
        bears_on_id: hypotheses[0],
        direction: "refutes",
        kind: "negative-result",
        source: { kind: "model_memory" },
        mode: "exploratory",
        body_md: body,
      },
      author,
      201,
    );
  const redactedEvidence = await counterevidence(
    `A reported residual needs checking against the proposed route. ${routeCanary}`,
  );
  const offered = await working(author, session);
  const killMove = offered.selected.primary_move;
  assert.equal(killMove.move, "kill-or-stand");
  assert.deepEqual(killMove.refs, [problem, hypotheses[0], redactedEvidence.evidence_id]);
  assert.ok(!JSON.stringify(killMove).includes(routeCanary));
  const triage = await call("/v1/triage", undefined, author);
  assert.deepEqual(triage.move, killMove, "triage points to the same exact source and contract");
  for (const read of [
    killMove.contract.preparation.read_first,
    ...killMove.contract.preparation.additional_reads,
  ]) {
    const response = await worker.fetch(`${origin}${read.path}`, {
      headers: { "User-Agent": userAgent },
    });
    assert.equal(response.status, 200, "each selected source has an exact mounted read");
    assert.ok((await response.text()).includes(routeCanary));
  }
  const pin = killMove.contract.preparation.evidence_pin;
  assert.deepEqual(
    await env.DB.prepare(
      "SELECT id AS event_id, seq, payload_sha256 FROM events WHERE problem_id=? AND object_id=? AND type='evidence.created'",
    )
      .bind(problem, redactedEvidence.evidence_id)
      .first(),
    {
      event_id: pin.event_id,
      seq: pin.seq,
      payload_sha256: pin.payload_sha256,
    },
  );
  // This fixture invokes the real D1 redaction service. It certifies current
  // source visibility, not an author withdrawal or operator HTTP workflow.
  await fixtures.redactPublicContent(pin.event_id);
  assert.ok(!moveNames(await next(author)).includes("kill-or-stand"));
  assert.equal((await working(author, session)).selected.primary_move.move, "discriminate");

  const currentEvidence = await counterevidence(
    "A fresh report describes the residual for this exact route and records its limitations.",
  );
  const actionable = (await working(author, session)).selected.primary_move;
  assert.equal(actionable.move, "kill-or-stand");
  assert.equal(
    actionable.refs[2],
    currentEvidence.evidence_id,
    "redacted older counterevidence cannot hide the next current report",
  );
  const killed = await call(
    actionable.contract.request.path.replace("{id}", session),
    {
      ...actionable.contract.prefilled_hints,
      reason:
        "The recorded observation defeats this proposed mechanism within its declared domain.",
    },
    author,
    200,
  );
  assert.equal(killed.hypothesis_id, hypotheses[0]);
  assert.equal(killed.status, "killed");
  assert.ok(
    !moveNames(await next(author)).includes("kill-or-stand"),
    "an eliminated route is no longer suggested even though refuting evidence remains recorded",
  );
  await working(author, session);

  console.log(
    JSON.stringify({
      stage: "moves-journey-passed",
      kind: "moves-real-bindings",
      status: "pass",
      other: moveNames(forOther),
      author: moveNames(forAuthor),
      after_review: moveNames(afterReview),
      working_pack_canonical_parity: true,
      working_discrimination: true,
      current_counterevidence_moves: true,
      redacted_counterevidence_excluded: true,
      move_contract_followed_to_elimination: true,
      boundary:
        "real local Workerd/D1; production provider; replay parity shown for reviews, claim relations and conflicts",
    }),
  );
});
