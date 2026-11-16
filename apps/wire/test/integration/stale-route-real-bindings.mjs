import assert from "node:assert/strict";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Fable §7.2 (Rev 3.1) stale-route check on real local Workerd HTTP and D1.
// A write that builds on a closed route — a retracted claim, a superseded
// claim version, a killed hypothesis — is refused 409 STALE_ROUTE carrying the
// public event that closed the route, and commits nothing: the problem's
// public cursor does not move. The same writes against live objects succeed.
// Not covered: a live screening provider (the harness screener passes).

await runLocalWorkerJourney(async (context) => {
  const { call, enroll, sponsorCall, env } = context;
  const OWNER = "usr_stale_owner";
  const author = await enroll("stale-author", OWNER);
  const reviewer = await enroll("stale-reviewer", "usr_stale_reviewer");

  const created = await call(
    "/v1/problems",
    {
      title: "Stale route problem",
      statement: "For all natural numbers n, n + 0 = n.",
      falsifier: "A natural number n such that n + 0 !== n.",
      motivation: "Exercise the stale-route check.",
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

  const session = (
    await call("/v1/sessions", { problem_id: problem, intent: "prove" }, author, 201)
  ).session_id;
  const promote = async (statement, extra, expected) => {
    const draft = await call(
      `/v1/sessions/${session}/workshop`,
      { type: "claim-draft", title: "Draft", body_md: "Private." },
      author,
      201,
    );
    return call(
      `/v1/sessions/${session}/promote`,
      {
        workshop_id: draft.workshop_id,
        kind: "conjecture",
        statement,
        falsifier: "A counterexample.",
        ...extra,
      },
      author,
      expected,
    );
  };
  const cursor = async () =>
    (
      await env.DB.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE problem_id = ?")
        .bind(problem)
        .first()
    ).seq;
  const assertStale = (refusal, ref, state) => {
    assert.equal(refusal.code, "STALE_ROUTE", JSON.stringify(refusal).slice(0, 400));
    assert.equal(refusal.status, 409);
    assert.equal(refusal.rule, "P10");
    assert.equal(refusal.suggested_action, "re_anchor_or_challenge");
    assert.equal(refusal.problem_id, problem);
    const entry = refusal.stale_routes.find((candidate) => candidate.ref === ref);
    assert.ok(entry, `stale_routes names ${ref}: ${JSON.stringify(refusal.stale_routes)}`);
    assert.equal(entry.state, state);
    assert.match(entry.closed_by_event_id, /^E-/, "the closing public event is named");
    assert.ok(Number.isInteger(entry.closed_at_seq) && entry.closed_at_seq > 0);
    return entry;
  };

  // Live baseline: a claim may build on a live claim.
  const base = (await promote("For all natural n, n + 0 = n exactly.", {}, 201)).claim_id;
  const sibling = (await promote("For all natural n, 0 + n = n.", { depends_on: [base] }, 201))
    .claim_id;

  // 1. Retract the base claim; building on it is now a closed route.
  await call(
    `/v1/sessions/${session}/retract`,
    {
      target_object: base,
      reason: "Author self-correction: found counterexample in 2-adic valuations at depth 12.",
    },
    author,
    201,
  );
  const retractionEvent = await env.DB.prepare(
    "SELECT e.id, e.seq FROM events e JOIN retractions r ON r.problem_id = e.problem_id AND e.object_id = r.retraction_id WHERE r.problem_id = ? AND r.target_object = ?",
  )
    .bind(problem, base)
    .first();
  assert.ok(retractionEvent, "the retraction is a public event");

  let before = await cursor();
  const onRetracted = await promote("For all natural n, n * 1 = n.", { depends_on: [base] }, 409);
  const retracted = assertStale(onRetracted, base, "claim-retracted");
  assert.equal(retracted.closed_by_event_id, retractionEvent.id);
  assert.equal(retracted.closed_at_seq, retractionEvent.seq);
  assert.deepEqual(onRetracted.example.depends_on, [], "the example drops the closed route");
  assert.equal(await cursor(), before, "a stale-route refusal commits nothing");

  // relates_to a retracted claim is the same closed route.
  assertStale(
    await promote("For all natural n, 1 * n = n.", { relates_to: [base] }, 409),
    base,
    "claim-retracted",
  );

  // Evidence bearing on the retracted claim is refused too.
  before = await cursor();
  assertStale(
    await call(
      `/v1/sessions/${session}/evidence`,
      {
        bears_on_kind: "claim",
        bears_on_id: base,
        bears_on_version: 1,
        direction: "supports",
        kind: "argument",
        source: { kind: "model_memory" },
        mode: "confirmatory",
        body_md: "This would support a retracted claim.",
      },
      author,
      409,
    ),
    `${base}@1`,
    "claim-retracted",
  );
  assert.equal(await cursor(), before);

  // 2. A superseded claim version: evidence must pin the live head.
  const revised = await call(
    `/v1/sessions/${session}/revise`,
    {
      claim_id: sibling,
      base_version: 1,
      kind: "conjecture",
      statement: "For all natural n, 0 + n = n, by induction on n.",
      falsifier: "A natural number n with 0 + n !== n.",
      depends_on: [],
    },
    author,
    201,
  );
  assert.equal(revised.version, 2);
  const evidenceOn = (version, expected) =>
    call(
      `/v1/sessions/${session}/evidence`,
      {
        bears_on_kind: "claim",
        bears_on_id: sibling,
        bears_on_version: version,
        direction: "informs",
        kind: "argument",
        source: { kind: "model_memory" },
        mode: "exploratory",
        body_md: `Observation about version ${version}.`,
      },
      author,
      expected,
    );
  before = await cursor();
  const superseded = assertStale(
    await evidenceOn(1, 409),
    `${sibling}@1`,
    "claim-version-superseded",
  );
  assert.equal(superseded.current_version, 2, "the refusal names the live head");
  assert.equal(await cursor(), before);
  await evidenceOn(2, 201);

  // relates_to a superseded pin on a new claim is refused; the live pin is not.
  assertStale(
    await promote("For all natural n, n - 0 = n.", { relates_to: [`${sibling}@1`] }, 409),
    `${sibling}@1`,
    "claim-version-superseded",
  );
  await promote("For all natural n, n - 0 = n.", { relates_to: [`${sibling}@2`] }, 201);

  // 3. A killed hypothesis is a closed route for claims relating to it.
  const hypothesis = (
    await call(
      `/v1/sessions/${session}/hypotheses`,
      {
        route: "induction on the successor",
        mechanism: "prove the successor case from the predecessor case",
        falsifier: "a successor case that does not follow",
        origin: "proposed",
        body_md: "Attack route by induction.",
      },
      author,
      201,
    )
  ).hypothesis_id;
  await promote("For all natural n, n + 0 + 0 = n.", { relates_to: [hypothesis] }, 201);

  const refuting = await call(
    `/v1/sessions/${session}/evidence`,
    {
      bears_on_kind: "hypothesis",
      bears_on_id: hypothesis,
      direction: "refutes",
      kind: "negative-result",
      source: { kind: "model_memory" },
      mode: "confirmatory",
      body_md: "The successor case needs an axiom the route never states.",
    },
    author,
    201,
  );
  await call(
    `/v1/sessions/${session}/hypotheses/${hypothesis}/kill`,
    {
      hypothesis_id: hypothesis,
      killed_by_evidence_id: refuting.evidence_id,
      reason: "The successor step requires an unstated axiom.",
    },
    author,
    200,
  );
  const killEvent = await env.DB.prepare(
    "SELECT id, seq FROM events WHERE problem_id = ? AND object_kind = 'hypothesis' AND object_id = ? AND type = 'hypothesis.killed'",
  )
    .bind(problem, hypothesis)
    .first();
  before = await cursor();
  const killed = assertStale(
    await promote("For all natural n, 0 + n + 0 = n.", { relates_to: [hypothesis] }, 409),
    hypothesis,
    "hypothesis-killed",
  );
  assert.equal(killed.closed_by_event_id, killEvent.id);
  assert.equal(await cursor(), before);

  // Several closed routes are reported together, in request order.
  const both = await promote(
    "For all natural n, n + 0 = 0 + n.",
    { depends_on: [base], relates_to: [hypothesis] },
    409,
  );
  assert.deepEqual(
    both.stale_routes.map((entry) => entry.state),
    ["claim-retracted", "hypothesis-killed"],
  );

  // The live route still works after every refusal above.
  await promote("For all natural n, n + 0 = n + 0.", { depends_on: [revised.claim_id] }, 201);
  await staleRoutePublicationRaces(context);
});

/** Every concurrent closure below uses its mounted writer and produces the
 * ordinary immutable event. Only read scheduling and the classifier are
 * fixture-controlled; no hypothesis/claim projections are edited by the test. */
async function staleRoutePublicationRaces({ call, enroll, sponsorCall, env, fixtures }) {
  const sponsor = "usr_stale_race_author";
  const author = await enroll("stale-race-author", sponsor);
  const reviewer = await enroll("stale-race-reviewer", "usr_stale_race_reviewer");
  const problem = (
    await call(
      "/v1/problems",
      {
        title: "Finite arithmetic route admission",
        statement: "For each integer n from zero to nine, n plus zero equals n.",
        falsifier: "An integer in the stated range whose sum differs.",
        motivation: "Retain only current routes when concurrent work closes an earlier approach.",
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
  const reviewerSession = (
    await call("/v1/sessions", { problem_id: problem, intent: "review" }, reviewer, 201)
  ).session_id;
  await call(
    `/v1/problems/${problem}/statement-review`,
    {
      session_id: reviewerSession,
      statement_version: 1,
      verdict: "statement-clear",
      basis: "Exact finite range and equality.",
    },
    reviewer,
  );
  const session = (
    await call("/v1/sessions", { problem_id: problem, intent: "prove" }, author, 201)
  ).session_id;
  const path = `/v1/sessions/${session}`;
  const claim = (statement, relatesTo = []) => ({
    kind: "conjecture",
    statement,
    falsifier: "An integer in the stated finite range that violates the equality.",
    relates_to: relatesTo,
  });
  const create = (statement) => call(`/v1/p/${problem}/claims`, claim(statement), author, 201);
  const pinned = await create("For each integer n from zero to nine, n + 0 = n.");
  const withdrawn = await create("For each integer n from zero to nine, 0 + n = n.");
  const closeTarget = await create("For each integer n from zero to nine, n - 0 = n.");
  const hypothesis = (
    await call(
      `${path}/hypotheses`,
      {
        route: "Induction on the finite range",
        mechanism: "Infer each successor equality from its predecessor.",
        falsifier: "A successor step requiring an unstated premise.",
        origin: "proposed",
        body_md: "Inspect the induction step explicitly.",
      },
      author,
      201,
    )
  ).hypothesis_id;
  const counterevidence = await call(
    `${path}/evidence`,
    {
      bears_on_kind: "hypothesis",
      bears_on_id: hypothesis,
      direction: "refutes",
      kind: "negative-result",
      source: { kind: "model_memory" },
      mode: "exploratory",
      body_md: "The proposed step uses a premise absent from this route.",
    },
    author,
    201,
  );
  const draft = (publication) =>
    call(
      `${path}/workshop`,
      {
        type: "claim-draft",
        title: "Saved route check",
        body_md: "Private derivation.",
        publication,
      },
      author,
      201,
    );
  const snapshot = async () => ({
    public: await env.DB.prepare(`SELECT public_seq,
      (SELECT COUNT(*) FROM events WHERE problem_id = p.id) AS events,
      (SELECT COUNT(*) FROM claims WHERE problem_id = p.id) AS claims,
      (SELECT COUNT(*) FROM claim_versions WHERE problem_id = p.id) AS versions,
      (SELECT COUNT(*) FROM idempotency WHERE problem_id = p.id AND event_id IS NOT NULL) AS receipts,
      (SELECT COUNT(*) FROM screening_publications s JOIN events e ON e.id = s.event_id WHERE e.problem_id = p.id) AS screened,
      (SELECT cursor FROM public_cursor WHERE singleton = 1) AS invalidation
      FROM problems p WHERE id = ?`)
      .bind(problem)
      .first(),
    session: await env.DB.prepare("SELECT closed_at, handback FROM sessions WHERE session_id = ?")
      .bind(session)
      .first(),
    workshop: (
      await env.DB.prepare(
        "SELECT workshop_id, current_version, state FROM workshop_objects WHERE problem_id = ? ORDER BY workshop_id",
      )
        .bind(problem)
        .all()
    ).results,
  });
  const race = async ({ attempt, change, reference, state }) => {
    await fixtures.holdNextRead("SELECT ref, closure_json FROM closures");
    const pending = attempt();
    // The original promise is still awaited below; this only prevents a
    // setup assertion from turning its later rejection into an unhandled one.
    void pending.catch(() => {});
    try {
      const deadline = Date.now() + 5_000;
      while (!(await fixtures.readBlocked()) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(
        await fixtures.readBlocked(),
        true,
        "the publication holds its original route read",
      );
      await change();
      const afterClosure = await snapshot();
      await fixtures.releaseRead();
      const refusal = await pending;
      assert.equal(refusal.code, "STALE_ROUTE");
      assert.equal(refusal.suggested_action, "re_anchor_or_challenge");
      const closure = refusal.stale_routes.find((route) => route.ref === reference);
      assert.equal(closure?.state, state);
      const event = await env.DB.prepare(
        "SELECT id, seq FROM events WHERE id = ? AND problem_id = ?",
      )
        .bind(closure.closed_by_event_id, problem)
        .first();
      assert.equal(
        event?.seq,
        closure.closed_at_seq,
        "the refusal names the actual competing event",
      );
      assert.deepEqual(
        await snapshot(),
        afterClosure,
        "the refused write adds no publication, success receipt, workshop transition or session close",
      );
    } finally {
      await fixtures.releaseRead();
      await pending;
    }
  };
  const revise = (target, statement) =>
    call(
      `${path}/revise`,
      {
        claim_id: target.claim_id,
        base_version: 1,
        ...claim(statement),
        relates_to: undefined,
        depends_on: [],
      },
      author,
      201,
    );

  const promotion = await draft(
    claim("For each integer n from zero to nine, (n + 0) + 0 = n.", [`${pinned.claim_id}@1`]),
  );
  await race({
    attempt: () =>
      call(
        `${path}/promote`,
        { workshop_id: promotion.workshop_id },
        author,
        409,
        "stale-race-promote",
      ),
    change: () =>
      revise(pinned, "For each integer n from zero to nine, n + 0 = n by the addition definition."),
    reference: `${pinned.claim_id}@1`,
    state: "claim-version-superseded",
  });
  const directData = claim("For each integer n from zero to nine, 0 + (n + 0) = n.", [hypothesis]);
  const directDraft = await draft(directData);
  await race({
    attempt: () =>
      call(
        `/v1/p/${problem}/claims`,
        { ...directData, workshop_id: directDraft.workshop_id, expected_workshop_version: 1 },
        author,
        409,
        "stale-race-direct",
      ),
    change: () =>
      call(
        `${path}/hypotheses/${hypothesis}/kill`,
        {
          hypothesis_id: hypothesis,
          killed_by_evidence_id: counterevidence.evidence_id,
          reason: "The recorded missing premise fires the route's falsifier.",
        },
        author,
        200,
      ),
    reference: hypothesis,
    state: "hypothesis-killed",
  });
  await race({
    attempt: () =>
      call(
        `/v1/p/${problem}/events:batch`,
        {
          members: [
            {
              tempId: "tmp:first",
              action: "claim",
              data: claim("For each integer n from zero to nine, n + (0 + 0) = n."),
            },
            {
              tempId: "tmp:second",
              action: "claim",
              causedBy: ["tmp:first"],
              data: claim("For each integer n from zero to nine, (0 + 0) + n = n.", [
                withdrawn.claim_id,
              ]),
            },
          ],
        },
        author,
        409,
        "stale-race-batch",
      ),
    change: () =>
      call(
        `${path}/retract`,
        {
          target_object: withdrawn.claim_id,
          reason: "Withdraw this formulation before further work uses it.",
        },
        author,
        201,
      ),
    reference: withdrawn.claim_id,
    state: "claim-retracted",
  });
  const firstCloseDraft = await draft(
    claim("For each integer n from zero to nine, n + 0 + 0 + 0 = n."),
  );
  const secondCloseDraft = await draft(
    claim("For each integer n from zero to nine, 0 + 0 + n + 0 = n.", [
      `${closeTarget.claim_id}@1`,
    ]),
  );
  await race({
    attempt: () =>
      call(
        `${path}/close`,
        {
          handback: "Publish the two checked identities together.",
          promote: [firstCloseDraft.workshop_id, secondCloseDraft.workshop_id],
        },
        author,
        409,
        "stale-race-close",
      ),
    change: () =>
      revise(
        closeTarget,
        "For each integer n from zero to nine, n - 0 = n under integer subtraction.",
      ),
    reference: `${closeTarget.claim_id}@1`,
    state: "claim-version-superseded",
  });

  // A failed close leaves the working session usable. A current reference
  // publishes once; the completed receipt remains replayable after closure.
  const liveData = claim("For each integer n from zero to nine, n + 0 = n + 0.", [
    `${closeTarget.claim_id}@2`,
  ]);
  const live = await call(`/v1/p/${problem}/claims`, liveData, author, 201, "stale-race-live");
  await call(
    `${path}/retract`,
    {
      target_object: closeTarget.claim_id,
      reason: "Retire this claim after the earlier dependent publication was accepted.",
    },
    author,
    201,
  );
  const beforeReplay = await snapshot();
  assert.deepEqual(
    await call(`/v1/p/${problem}/claims`, liveData, author, 200, "stale-race-live"),
    live,
  );
  assert.deepEqual(await snapshot(), beforeReplay);
}

console.log(
  JSON.stringify({
    stage: "stale-route-journey-passed",
    kind: "stale-route-real-bindings",
    status: "pass",
    boundary:
      "real local Workerd/D1; promote/evidence refusals and atomic claim admission across concurrent mounted revise/kill/retract writes; harness screener",
  }),
);
