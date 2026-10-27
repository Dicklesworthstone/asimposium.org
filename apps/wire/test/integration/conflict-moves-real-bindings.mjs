import assert from "node:assert/strict";
import { PackResponseSchema } from "@asimposium/contracts";
import { selectNormalizeConflictMove } from "../../src/mega-commands/conflict-moves.ts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Fable §§6.4a/9.4: a relation is an assertion about exact versions, not a
// permanent fact. All scientific state below is produced through real HTTP
// writes on local Workerd/D1/R2. The fixture screener does not prove live AI
// screening. The final redaction probe invokes the real D1 redaction service.
await runLocalWorkerJourney(async (context) => {
  const { call, enroll, sponsorCall, operatorCall, env, fixtures, worker, origin, userAgent } =
    context;
  const owner = "usr_conflict_moves_owner";
  const author = await enroll("conflict-moves-author", owner);
  const reviewer = await enroll("conflict-moves-reviewer", "usr_conflict_moves_reviewer");
  const created = await call(
    "/v1/problems",
    {
      title: "Current contradiction normalization",
      statement: "Every integer in 0..20 has a square of the same parity.",
      falsifier: "An integer in 0..20 whose square has the opposite parity.",
      motivation: "Keep normalization attached to visible current statements.",
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
  const reviewSession = (
    await call("/v1/sessions", { problem_id: problem, intent: "review" }, reviewer, 201)
  ).session_id;
  await call(
    `/v1/problems/${problem}/statement-review`,
    {
      session_id: reviewSession,
      statement_version: 1,
      verdict: "statement-clear",
      basis: "The finite domain and parity predicate are explicit.",
    },
    reviewer,
  );
  const session = (
    await call("/v1/sessions", { problem_id: problem, intent: "prove" }, author, 201)
  ).session_id;
  const path = `/v1/sessions/${session}`;
  const promote = async (statement) => {
    const draft = await call(
      `${path}/workshop`,
      {
        type: "claim-draft",
        title: "Exact parity statement",
        body_md: "Private draft.",
      },
      author,
      201,
    );
    return (
      await call(
        `${path}/promote`,
        {
          workshop_id: draft.workshop_id,
          kind: "conjecture",
          statement,
          falsifier: "A direct calculation of this integer with the opposite parity.",
        },
        author,
        201,
      )
    ).claim_id;
  };
  const a = await promote("Zero squared is even.");
  const b = await promote("Zero squared is odd.");
  const c = await promote("One squared is odd.");
  const assertRelation = (source, version, target, targetVersion = 1) =>
    call(
      `${path}/relations`,
      {
        kind: "contradicts",
        source_claim_id: source,
        source_version: version,
        target: `${target}@${targetVersion}`,
      },
      author,
      201,
    );
  const next = () => call(`/v1/p/${problem}/next`, undefined, author);
  const normalization = (result) =>
    [result.primary_move, ...result.alternatives].find(
      (move) => move?.move === "normalize-conflict",
    );
  const expectMove = async (pins) => {
    const result = await next();
    const move = normalization(result);
    const head = await env.DB.prepare("SELECT public_seq FROM problems WHERE id=?")
      .bind(problem)
      .first();
    const exact = await selectNormalizeConflictMove(env.DB, problem, head.public_seq);
    assert.equal(exact.degraded, false, "the conflict selector executes against real D1");
    assert.deepEqual(exact.move ?? undefined, move, "HTTP uses the canonical selector");
    if (pins === null) assert.equal(move, undefined, "no retired contradiction is recommended");
    else {
      assert.equal(result.degraded, false, "all selectors are healthy with visible source data");
      assert.deepEqual(move?.refs, [problem, ...pins]);
    }
    return move;
  };
  const workingMove = async () => {
    const pack = PackResponseSchema.parse(
      await call(`${path}/pack?profile=working&max_tokens=8000`, undefined, author),
    );
    const record = pack.items.find((item) => item.id === "SYS-working-moves");
    assert.ok(record, "the working pack includes the canonical move record");
    const selected = JSON.parse(record.body);
    assert.equal(selected.captured_cursor, pack.cursor);
    assert.deepEqual(normalization(selected), normalization(await next()));
    return normalization(selected);
  };

  const first = await assertRelation(a, 1, b);
  const offered = await expectMove([`${a}@1`, `${b}@1`]);
  assert.deepEqual(await workingMove(), offered);
  assert.deepEqual(
    offered.contract.prefilled_hints,
    {
      claims: [
        { claim_id: a, version: 1 },
        { claim_id: b, version: 1 },
      ],
    },
    "the contract supplies executable pins, leaving scientific alignment to the Fellow",
  );
  for (const read of [
    offered.contract.preparation.read_first,
    ...offered.contract.preparation.additional_reads,
  ]) {
    const response = await worker.fetch(`${origin}${read.path}`, {
      headers: { "User-Agent": userAgent },
    });
    assert.equal(response.status, 200, "every advertised exact source is a mounted public read");
    assert.ok((await response.text()).length > 0);
  }
  const historical = (cut) => selectNormalizeConflictMove(env.DB, problem, cut);
  assert.equal(
    (await historical(first.seq - 1)).move,
    null,
    "future assertions cannot cross the cut",
  );

  const control = (action) =>
    operatorCall("POST", "/v1/operators/content-control", "operator.content.control", {
      target_id: `${problem}/${a}`,
      target_kind: "claim",
      action,
      reason: "Exercise current visibility on the scientific source.",
    });
  await control("hide");
  await expectMove(null);
  assert.equal(
    (await historical(first.seq)).move,
    null,
    "current hide also protects the historical cut",
  );
  await control("restore");
  await expectMove([`${a}@1`, `${b}@1`]);
  const normalized = await call(
    offered.contract.request.path.replace("{id}", session),
    {
      ...offered.contract.prefilled_hints,
      aligned_definitions: "Both statements use ordinary integer parity modulo two.",
      aligned_scope: "Both concern the square of the single integer zero.",
      aligned_quantifiers: "Both assert one instance with no varying quantified variable.",
      smallest_disagreement: "The two assertions disagree on the parity of zero squared.",
      agreed_facts: ["Zero squared equals zero."],
      discriminating_tests: ["Evaluate zero squared modulo two directly."],
    },
    author,
    201,
  );
  assert.match(normalized.conflict_id, /^CF-/);
  await expectMove(null);
  assert.deepEqual(
    (await historical(first.seq)).move?.refs,
    offered.refs,
    "later normalization does not rewrite the captured recommendation",
  );

  const beforeRevision = await assertRelation(a, 1, c);
  await expectMove([`${a}@1`, `${c}@1`]);
  await call(
    `${path}/revise`,
    {
      claim_id: a,
      base_version: 1,
      kind: "conjecture",
      statement: "Every even integer in 0..20 has an even square.",
      falsifier: "An even integer in 0..20 whose square is odd.",
    },
    author,
    201,
  );
  await expectMove(null);
  assert.deepEqual(
    (await historical(beforeRevision.seq)).move?.refs,
    [problem, `${a}@1`, `${c}@1`],
    "a later revision leaves the old cut intact",
  );
  const beforeDispute = await assertRelation(a, 2, c);
  await expectMove([`${a}@2`, `${c}@1`]);
  await call(
    `/v1/sessions/${reviewSession}/relations/dispute`,
    {
      kind: "contradicts",
      source_claim_id: a,
      source_version: 2,
      target: `${c}@1`,
      reason: "These statements concern different inputs and can both hold.",
    },
    reviewer,
    201,
  );
  await expectMove(null);
  assert.deepEqual(
    (await historical(beforeDispute.seq)).move?.refs,
    [problem, `${a}@2`, `${c}@1`],
    "a later dispute leaves the old cut intact",
  );

  const beforeWithdrawal = await assertRelation(b, 1, c);
  await expectMove([`${b}@1`, `${c}@1`]);
  await call(
    `${path}/retract`,
    {
      target_object: b,
      reason: "Direct calculation contradicts the proposed parity of zero.",
    },
    author,
    201,
  );
  await expectMove(null);
  assert.deepEqual(
    (await historical(beforeWithdrawal.seq)).move?.refs,
    [problem, `${b}@1`, `${c}@1`],
    "a later withdrawal leaves the old cut intact",
  );

  await call(
    `${path}/revise`,
    {
      claim_id: c,
      base_version: 1,
      kind: "conjecture",
      statement: "Every odd integer in 0..20 has an odd square.",
      falsifier: "An odd integer in 0..20 whose square is even.",
    },
    author,
    201,
  );
  const last = await assertRelation(a, 2, c, 2);
  await expectMove([`${a}@2`, `${c}@2`]);
  const assertion = await env.DB.prepare(
    "SELECT id FROM events WHERE problem_id=? AND type='relation.asserted' AND seq=?",
  )
    .bind(problem, last.seq)
    .first();
  assert.ok(assertion);
  await fixtures.redactPublicContent(assertion.id);
  await expectMove(null);
  assert.equal(await workingMove(), undefined);
  assert.equal(
    (await historical(last.seq)).move,
    null,
    "redacted sources do not reappear historically",
  );
  const retained = await env.DB.prepare(
    "SELECT asserted_by_event FROM claim_relations WHERE problem_id=? AND kind='contradicts' AND source_claim_id=? AND source_version=2 AND target_ref=?",
  )
    .bind(problem, a, `${c}@2`)
    .first();
  assert.equal(
    retained.asserted_by_event,
    assertion.id,
    "the immutable index remains, so the missing move depends on the redacted source",
  );
  console.log(
    JSON.stringify({
      kind: "conflict-moves-real-bindings",
      status: "pass",
      scope: "real local Workerd/D1/R2; fixture screening; no deployed or live-model claim",
      probes: [
        "executable-current-pins",
        "working-pack-parity",
        "exact-public-reads",
        "normalization",
        "revision",
        "dispute",
        "withdrawal",
        "hide-restore",
        "redaction",
        "historical-cuts",
      ],
    }),
  );
  // This exact row is intentionally unreplayable once its assertion bytes
  // are lawfully erased. Relation keys have embedded @ characters, outside
  // the shared harness's generic object@version redaction exception. Require
  // precisely this source-bound orphan; every other drift remains a failure.
  return {
    projectionParityExpect: {
      [problem]: {
        status: "unreplayable",
        drift: [`claim_relations:orphan_row:contradicts@${a}@2@${c}@2`],
      },
    },
  };
});
