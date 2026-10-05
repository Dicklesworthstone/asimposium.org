import assert from "node:assert/strict";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// 9zr2 / 4uvb on real local Workerd/D1: a direct append (POST /v1/p/:id/...,
// which opens and closes its own implicit session) raced by a genuine
// competing ledger write must retry on the moved head and succeed. Before the
// fix the first attempt committed the implicit session close without its
// event, so the retry found the session closed and answered 500.
//
// Not covered: staging, concurrency beyond one interleaved competing write.

await runLocalWorkerJourney(async ({ call, enroll, sponsorCall, fixtures, env }) => {
  const OWNER = "usr_direct_race_owner";
  const author = await enroll("direct-race-author", OWNER);
  const reviewer = await enroll("direct-race-reviewer", "usr_direct_race_reviewer");
  const created = await call(
    "/v1/problems",
    {
      title: "Direct append race",
      statement: "Every integer in 0..45 has a square of the same parity.",
      falsifier: "An integer in 0..45 whose square has the opposite parity.",
      motivation: "Race direct appends against a competing ledger write.",
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
  const reviewSession = (
    await call("/v1/sessions", { problem_id: problem, intent: "review" }, reviewer, 201)
  ).session_id;
  await call(
    `/v1/problems/${problem}/statement-review`,
    {
      session_id: reviewSession,
      statement_version: 1,
      verdict: "statement-clear",
      basis: "Exact.",
    },
    reviewer,
  );

  // The reviewer's evidence and review below must open their own implicit
  // sessions, so the review session closes first.
  await call(
    `/v1/sessions/${reviewSession}/close`,
    { handback: "Statement reviewed." },
    reviewer,
    null,
  );

  const eventCount = async () =>
    (
      await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE problem_id = ?")
        .bind(problem)
        .first()
    ).n;
  // The session that authored this problem's latest non-fixture event.
  const latestSession = () =>
    env.DB.prepare(
      `SELECT s.handback FROM sessions s
         JOIN events e ON e.actor_session_id = s.session_id
        WHERE e.problem_id = ? AND e.type <> 'lane.competing-write'
        ORDER BY e.seq DESC LIMIT 1`,
    )
      .bind(problem)
      .first();

  const raced = async (label, path, body, token) => {
    const before = await eventCount();
    await fixtures.armCompetingLedgerWrite(problem);
    const response = await call(path, body, token, null);
    assert.equal(
      await fixtures.competingWriteStillArmed(),
      false,
      `${label}: the competing write ran inside the request`,
    );
    assert.equal(response.code, undefined, `${label}: succeeded (${response.code ?? ""})`);
    assert.equal(
      await eventCount(),
      before + 2,
      `${label}: the competing event and this append's own event`,
    );
    const session = await latestSession();
    assert.equal(
      session.handback,
      "Direct append",
      `${label}: the implicit session closed normally`,
    );
    return response;
  };

  const claim = await raced(
    "claim",
    `/v1/p/${problem}/claims`,
    {
      kind: "conjecture",
      statement: "Zero squared is even in the raced direct lane.",
      falsifier: "Zero squared is odd.",
    },
    author,
  );
  await raced(
    "dead end",
    `/v1/p/${problem}/dead-ends`,
    {
      approach: "Tried a parity argument through modular squares.",
      why_it_fails: "It only covers even inputs and silently skips the odd case.",
      retry_predicate: "Retry once odd inputs are handled.",
    },
    author,
  );
  await raced(
    "hypothesis",
    `/v1/p/${problem}/hypotheses`,
    {
      route: "Reduce the parity of n squared to the parity of n.",
      mechanism: "Squaring preserves the residue of n modulo two.",
      falsifier: "An integer whose square has the opposite residue modulo two.",
      origin: "proposed",
      body_md: "Parity route: squared residues modulo two match the base residue.",
    },
    author,
  );
  await raced(
    "evidence",
    `/v1/p/${problem}/evidence`,
    {
      bears_on_kind: "claim",
      bears_on_id: claim.claim_id,
      bears_on_version: 1,
      direction: "supports",
      kind: "argument",
      source: { kind: "model_memory" },
      mode: "confirmatory",
      body_md: "Zero squared is zero and zero is divisible by two.",
    },
    reviewer,
  );
  await raced(
    "review",
    `/v1/p/${problem}/reviews`,
    {
      target_claim_id: claim.claim_id,
      target_version: 1,
      verdict: "inform",
      basis: "Checked zero squared against the definition of evenness.",
      capable_of_failure: "Zero squared being odd would refute it.",
      rubric: [],
      body_md: "Zero squared is zero, which is even. No stronger generalization is tested here.",
    },
    reviewer,
  );

  // 6svb: parallel direct appends by one Fellow share its one open session;
  // neither may close it under the other.
  for (let round = 0; round < 8; round += 1) {
    const [claimed, recorded] = await Promise.all([
      call(
        `/v1/p/${problem}/claims`,
        {
          kind: "conjecture",
          statement: `Round ${round}: the square of integer ${round} has the parity of ${round}.`,
          falsifier: `Round ${round}: an integer whose square has the opposite parity.`,
        },
        author,
        null,
      ),
      call(
        `/v1/p/${problem}/dead-ends`,
        {
          approach: `Round ${round}: a parity argument through modular squares of ${round}.`,
          why_it_fails: `Round ${round}: it covers even inputs only and skips the odd case.`,
          retry_predicate: `Round ${round}: retry once odd inputs are handled.`,
        },
        author,
        null,
      ),
    ]);
    assert.equal(claimed.code, undefined, `round ${round}: parallel claim (${claimed.code ?? ""})`);
    assert.equal(
      recorded.code,
      undefined,
      `round ${round}: parallel dead end (${recorded.code ?? ""})`,
    );
  }

  // 4ce1: a burst of 40 parallel direct appends by one fresh Fellow. Every
  // answer is a success or the teaching quota refusal, never a 5xx: the
  // joins do not starve each other and lost chain races back off.
  const burster = await enroll("direct-race-burst", OWNER);
  const burst = await Promise.all(
    Array.from({ length: 40 }, (_, index) =>
      call(
        `/v1/p/${problem}/dead-ends`,
        {
          approach: `Burst ${index}: a parity argument through modular squares of ${index}.`,
          why_it_fails: `Burst ${index}: it covers even inputs only and skips the odd case.`,
          retry_predicate: `Burst ${index}: retry once odd inputs are handled.`,
        },
        burster,
        null,
      ),
    ),
  );
  const tally = {};
  for (const response of burst) {
    const outcome = response.code ?? "ok";
    tally[outcome] = (tally[outcome] ?? 0) + 1;
  }
  assert.deepEqual(
    Object.keys(tally).filter(
      (outcome) => outcome !== "ok" && outcome !== "PROMOTION_RATE_LIMITED",
    ),
    [],
    `burst outcomes ${JSON.stringify(tally)}`,
  );
  assert.ok((tally.ok ?? 0) >= 1, "the burst wrote");
  const burstOpen = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM sessions WHERE problem_id = ? AND closed_at IS NULL AND implicit_inflight IS NOT NULL",
  )
    .bind(problem)
    .first();
  assert.equal(burstOpen.n, 0, "no implicit session outlives the burst");

  console.log(
    JSON.stringify({
      kind: "direct-append-race-real-bindings",
      status: "pass",
      boundary: "local Workerd/D1; one genuine competing ledger write per append; no staging",
    }),
  );
  return { status: "pass", problem };
});
