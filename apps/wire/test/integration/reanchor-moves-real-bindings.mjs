import assert from "node:assert/strict";
import { ClaimReanchorRequestSchema, PackResponseSchema } from "@asimposium/contracts";
import { selectReanchorMove } from "../../src/mega-commands/reanchor-moves.ts";
import { normHash } from "../../src/split/policy.ts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Fable §§6.2/7.1/9.4: statement drift must hand the original author usable
// current pins, and a metadata re-anchor must not masquerade as a scientific
// revision. Ordinary writes enter via real local Workerd HTTP and D1/R2;
// one chained fixture revision interleaves immediately before the write batch.
// Identity and screening are harness fixtures, not deployed/OAuth/model proof.
await runLocalWorkerJourney(async (context) => {
  const { call, enroll, sponsorCall, operatorCall, env, fixtures, worker, origin, userAgent } =
    context;
  const owner = "usr_reanchor_owner";
  const author = await enroll("reanchor-author", owner);
  const reviewer = await enroll("reanchor-reviewer", "usr_reanchor_reviewer");
  const created = await call(
    "/v1/problems",
    {
      title: "Coherent formulation recommendations",
      statement: "Every integer in 0..20 has a square of the same parity.",
      falsifier: "An integer in 0..20 whose square has the opposite parity.",
      motivation: "Keep scientific work attached to the formulation its author inspected.",
      areas: ["number-theory"],
    },
    author,
    201,
  );
  const problem = created.problem.id;
  await sponsorCall(
    owner,
    "POST",
    `/v1/sponsors/problems/${problem}/lifecycle`,
    "problem-lifecycle",
    { action: "publish" },
  );
  const next = (token = author) => call(`/v1/p/${problem}/next`, undefined, token);
  const selected = (result) =>
    [result.primary_move, ...result.alternatives].find((move) => move?.move === "re-anchor");
  const sharpening = (await next()).primary_move;
  assert.equal(sharpening.move, "sharpen-statement");
  assert.equal(sharpening.contract.preparation.statement_version, 1);
  assert.ok(sharpening.contract.preparation.statement_pin.event_id);
  assert.equal(sharpening.contract.preparation.read_first.path, `/p/${problem}.md`);
  assert.equal(
    (
      await worker.fetch(`${origin}${sharpening.contract.preparation.read_first.path}`, {
        headers: { "User-Agent": userAgent },
      })
    ).status,
    200,
    "the sharpening recommendation names a real published formulation",
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
      basis: "The finite range, parity predicate and counterexample are explicit.",
    },
    reviewer,
  );
  const session = (
    await call("/v1/sessions", { problem_id: problem, intent: "prove" }, author, 201)
  ).session_id;
  const path = `/v1/sessions/${session}`;
  const canary = "AUTHORED-CLAIM-TEXT-MUST-NOT-BECOME-MOVE-INSTRUCTIONS";
  const cursor = async () =>
    (await env.DB.prepare("SELECT public_seq FROM problems WHERE id=?").bind(problem).first())
      .public_seq;
  const reanchorState = (claimId) =>
    env.DB.prepare(`SELECT p.public_seq, p.current_statement_version,
      c.statement_version, c.statement_drift,
      (SELECT COUNT(*) FROM events e WHERE e.problem_id = p.id AND e.type = 'claim.reanchored') AS reanchors,
      (SELECT COUNT(*) FROM session_write_replays WHERE scope = 'reanchor') AS receipts
      FROM problems p JOIN claims c ON c.problem_id = p.id WHERE p.id = ? AND c.id = ?`)
      .bind(problem, claimId)
      .first();
  const promote = async (statement) => {
    const draft = await call(
      `${path}/workshop`,
      { type: "claim-draft", title: "Finite parity claim", body_md: "Private scientific draft." },
      author,
      201,
    );
    return call(
      `${path}/promote`,
      {
        workshop_id: draft.workshop_id,
        kind: "conjecture",
        statement,
        falsifier: "A direct computation of the stated integer with opposite parity.",
        client_context_cursor: await cursor(),
      },
      author,
      201,
    );
  };
  const claim = (await promote(`Zero squared is even. ${canary}`)).claim_id;
  const authorId = (
    await env.DB.prepare(
      "SELECT actor_fellow_id FROM events WHERE problem_id=? AND object_id=? AND type='claim.created'",
    )
      .bind(problem, claim)
      .first()
  ).actor_fellow_id;
  const revision = (upper) =>
    context.reviseStatement(problem, owner, author, {
      action: "revise-statement",
      statement: `Every integer in 0..${upper} has a square of the same parity.`,
      falsifier: `An integer in 0..${upper} whose square has the opposite parity.`,
      motivation: `Recheck earlier scientific work against the expanded range 0..${upper}.`,
    });
  const verifyNext = async (expectedRefs) => {
    const result = await next();
    const move = selected(result);
    const direct = await selectReanchorMove(env.DB, problem, authorId, await cursor());
    assert.deepEqual(move, direct.move ?? undefined, "the production HTTP selector is canonical");
    if (expectedRefs === null) assert.equal(move, undefined);
    else {
      assert.deepEqual(move?.refs, [problem, ...expectedRefs]);
      assert.equal(direct.degraded, false);
      assert.equal(result.degraded, false, "all production selectors execute on the real schema");
      assert.ok(!JSON.stringify(move).includes(canary));
      assert.ok(ClaimReanchorRequestSchema.safeParse(move.contract.prefilled_hints).success);
      assert.equal(move.contract.prefilled_hints.client_context_cursor, await cursor());
      assert.equal(move.contract.preparation.read_first.path, `/p/${problem}.md`);
      const currentFormulation = await call(`/v1/problems/${problem}`);
      assert.equal(
        currentFormulation.problem.current_statement_version,
        move.contract.preparation.current_statement_version,
        "the current formulation read matches the selected version before acting",
      );
      for (const read of [
        move.contract.preparation.read_first,
        ...move.contract.preparation.additional_reads,
      ]) {
        const response = await worker.fetch(`${origin}${read.path}`, {
          headers: { "User-Agent": userAgent },
        });
        assert.equal(
          response.status,
          200,
          "every exact scientific source is a mounted public read",
        );
        assert.ok((await response.text()).length > 0);
      }
    }
    return move;
  };
  await verifyNext(null);
  const beforeRevision = await cursor();
  await revision(30);
  const offered = await verifyNext([`${claim}@1`, "S@2"]);
  assert.equal(
    selected(await next(reviewer)),
    undefined,
    "a reviewer cannot re-anchor the author's claim",
  );
  assert.deepEqual(await selectReanchorMove(env.DB, problem, authorId, beforeRevision), {
    move: null,
    degraded: true,
  });
  const pack = PackResponseSchema.parse(
    await call(`${path}/pack?profile=working&max_tokens=8000`, undefined, author),
  );
  const item = pack.items.find((item) => item.id === "SYS-working-moves");
  assert.ok(item);
  const packMoves = JSON.parse(item.body);
  assert.equal(packMoves.captured_cursor, pack.cursor);
  assert.deepEqual(selected(packMoves), offered, "working packs use the same coherent move");

  const control = (action) =>
    operatorCall("POST", "/v1/operators/content-control", "operator.content.control", {
      target_id: `${problem}/${claim}`,
      target_kind: "claim",
      action,
      reason: "Exercise current source visibility before a statement re-anchor.",
    });
  await control("hide");
  await verifyNext(null);
  await control("restore");
  const restored = await verifyNext([`${claim}@1`, "S@2"]);
  const endpoint = restored.contract.request.path.replace("{id}", session);
  const receipt = await call(
    endpoint,
    restored.contract.prefilled_hints,
    author,
    200,
    "reanchor-exact",
  );
  assert.equal(receipt.reanchored, true);
  assert.equal(receipt.statement_version, 2);
  const afterReanchor = await cursor();
  assert.deepEqual(
    await call(endpoint, restored.contract.prefilled_hints, author, 200, "reanchor-exact"),
    receipt,
  );
  assert.equal(await cursor(), afterReanchor, "retry does not append another re-anchor");
  await verifyNext(null);

  await revision(40);
  const later = await verifyNext([`${claim}@1`, "S@3"]);
  assert.equal(later.contract.preparation.anchored_statement_version, 2);
  const beforeStaleRequest = await reanchorState(claim);
  assert.equal(beforeStaleRequest.statement_drift, 1);
  const stale = await call(
    endpoint,
    offered.contract.prefilled_hints,
    author,
    409,
    "reanchor-old-formulation",
  );
  assert.equal(stale.code, "STATEMENT_REVISED_SINCE");
  assert.equal(stale.statement_version, 3);
  assert.equal(stale.client_context_cursor, offered.contract.prefilled_hints.client_context_cursor);
  assert.equal(stale.delta_pointer, `/p/${problem}.md`);
  assert.deepEqual(
    await reanchorState(claim),
    beforeStaleRequest,
    "a stale request cannot clear drift or append an event/receipt",
  );
  assert.deepEqual(
    await call(endpoint, restored.contract.prefilled_hints, author, 200, "reanchor-exact"),
    receipt,
    "an exact replay still returns its original sealed receipt after a statement revision",
  );
  assert.deepEqual(
    await reanchorState(claim),
    beforeStaleRequest,
    "replaying the old receipt does not re-anchor against the new statement",
  );
  await call(
    `${path}/revise`,
    {
      claim_id: claim,
      base_version: 1,
      kind: "conjecture",
      statement: "Every even integer in 0..40 has an even square.",
      falsifier: "An even integer in 0..40 whose square is odd.",
      client_context_cursor: await cursor(),
    },
    author,
    201,
  );
  await verifyNext(null);
  await revision(50);
  await verifyNext([`${claim}@2`, "S@4"]);
  await call(
    `${path}/retract`,
    { target_object: claim, reason: "Withdraw this route while its scope is being reconsidered." },
    author,
    201,
  );
  await verifyNext(null);

  const remaining = (await promote("One squared is odd.")).claim_id;
  await revision(60);
  const final = await verifyNext([`${remaining}@1`, "S@5"]);
  const beforeRace = await reanchorState(remaining);
  const racingVersion = beforeRace.current_statement_version + 1;
  const racingAt = new Date().toISOString();
  const racingStatement = "Every integer in 0..70 has a square of the same parity.";
  const racingFalsifier = "An integer in 0..70 whose square has the opposite parity.";
  const racingMotivation =
    "Require the author to inspect a formulation that changed during re-anchor admission.";
  // The staged immutable row becomes current only when the competing Krater
  // event advances the head. This is the existing real-binding race fixture.
  await env.DB.prepare(`INSERT INTO problem_statement_versions
    (problem_id, version, statement, norm_hash, falsifier, motivation, steward_accepted_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      problem,
      racingVersion,
      racingStatement,
      `sha256:${await normHash(racingStatement)}`,
      racingFalsifier,
      racingMotivation,
      owner,
      racingAt,
    )
    .run();
  await fixtures.armCompetingLedgerWrite(
    problem,
    "UPDATE problems SET current_statement_version = ?, updated_at = ? WHERE id = ?",
    [racingVersion, racingAt, problem],
    {
      eventType: "problem.statement-revised",
      objectKind: "problem",
      objectId: problem,
      objectVersion: racingVersion,
      createdAt: racingAt,
      payload: {
        action: "revise-statement",
        acting_principal: { type: "sponsor", id: owner },
        source_fellow_id: authorId,
        previous_statement_version: beforeRace.current_statement_version,
        previous_status: "active",
        problem: {
          id: problem,
          title: created.problem.title,
          status: "active",
          current_statement_version: racingVersion,
          statement: racingStatement,
          falsifier: racingFalsifier,
          motivation: racingMotivation,
          updated_at: racingAt,
        },
      },
    },
    "INSERT INTO events",
  );
  const raced = await call(
    endpoint,
    final.contract.prefilled_hints,
    author,
    409,
    "reanchor-commit-race",
  );
  assert.equal(
    await fixtures.competingWriteStillArmed(),
    false,
    "the competing revision committed before the re-anchor batch",
  );
  assert.equal(raced.code, "STATEMENT_REVISED_SINCE");
  assert.equal(raced.client_context_cursor, final.contract.prefilled_hints.client_context_cursor);
  assert.equal(raced.statement_version, racingVersion);
  assert.deepEqual(
    await reanchorState(remaining),
    {
      ...beforeRace,
      public_seq: beforeRace.public_seq + 1,
      current_statement_version: racingVersion,
    },
    "only the competing statement revision commits; drift, claim anchor and replay receipts stay unchanged",
  );
  const refreshed = await verifyNext([`${remaining}@1`, `S@${racingVersion}`]);
  await fixtures.redactPublicContent(refreshed.contract.preparation.claim_pin.event_id);
  await verifyNext(null);
  console.log(
    JSON.stringify({
      kind: "reanchor-moves-real-bindings",
      status: "pass",
      scope:
        "real local Workerd/D1/R2; fixture identity and screening; no deployed or live-model proof",
      probes: [
        "verified-sharpening-formulation",
        "executable-current-reanchor",
        "original-author-only",
        "exact-public-reads",
        "working-pack-parity",
        "stale-cut-refusal",
        "hide-restore",
        "idempotent-reanchor",
        "stale-write-refusal",
        "exact-replay-after-revision",
        "statement-revision-at-commit",
        "second-formulation-revision",
        "claim-revision",
        "claim-withdrawal",
        "source-redaction",
      ],
    }),
  );
});
