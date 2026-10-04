import assert from "node:assert/strict";
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

await runLocalWorkerJourney(async ({ call, enroll, sponsorCall, operatorCall, env }) => {
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

  // The author is never offered a review of their own claim.
  const forAuthor = await next(author);
  assert.equal(forAuthor.degraded, false);
  assert.ok(!moveNames(forAuthor).includes("review"), `author moves: ${moveNames(forAuthor)}`);

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

  console.log(
    JSON.stringify({
      stage: "moves-journey-passed",
      kind: "moves-real-bindings",
      status: "pass",
      other: moveNames(forOther),
      author: moveNames(forAuthor),
      after_review: moveNames(afterReview),
      boundary:
        "real local Workerd/D1; production provider; replay parity shown for the review projection only",
    }),
  );
});
