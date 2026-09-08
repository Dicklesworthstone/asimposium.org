import assert from "node:assert/strict";

// All scientific objects use production HTTP writes. The only restored rows
// are legacy derived outbox handoffs, copied from those real event envelopes.
export async function outboxFairness({ call, enroll, fixtures, env, userAgent }) {
  const problem = "P-OUTBOX-FAIRNESS";
  await fixtures.seedProblem(problem);
  const token = await enroll("outbox-author", "usr_outbox_author");
  const session = await call("/v1/sessions", { problem_id: problem, intent: "prove" }, token, 201);
  const path = `/v1/sessions/${session.session_id}`;
  const privateCanary = "OUTBOX_PRIVATE_SCRATCH_MUST_NOT_BE_INDEXED";
  const draft = await call(
    `${path}/workshop`,
    { type: "draft", title: "Divisibility scratch", body_md: privateCanary, relates_to: [] },
    token,
    201,
  );
  const publish = (statement) =>
    call(
      `${path}/promote`,
      {
        workshop_id: draft.workshop_id,
        kind: "conjecture",
        statement,
        falsifier: "An integer n whose stated multiple is not divisible by two.",
      },
      token,
      201,
    );
  const first = await publish("For every integer n, the integer 2n is divisible by two.");
  const gaps = [];
  // Nine unsupported events exceed one eight-row drain page.
  for (const [index, outcome] of ["closed-by", "withdrawn", "closed-by", "withdrawn"].entries()) {
    const body = {
      target_claim_id: first.claim_id,
      target_version: 1,
      obligation: `Check divisibility for negative integers before ${outcome}.`,
      closes_what: "The unrestricted integer domain of this claim.",
    };
    const key = `outbox-gap-${index}-${outcome}`;
    const gap = await call(`${path}/gaps`, body, token, 201, key);
    assert.deepEqual(await call(`${path}/gaps`, body, token, 200, key), gap);
    const transition = {
      gap_id: gap.gap_id,
      outcome,
      ...(outcome === "closed-by" ? { closed_by: `${first.claim_id}@1` } : {}),
    };
    const closed = await call(`${path}/gaps/close`, transition, token, 201, `${key}-close`);
    assert.deepEqual(
      await call(`${path}/gaps/close`, transition, token, 200, `${key}-close`),
      closed,
    );
    gaps.push(gap);
  }
  const relationBody = {
    kind: "addresses-gap",
    source_claim_id: first.claim_id,
    source_version: 1,
    target: gaps[0].gap_id,
  };
  const relation = await call(`${path}/relations`, relationBody, token, 201, "outbox-relation");
  assert.deepEqual(
    await call(`${path}/relations`, relationBody, token, 200, "outbox-relation"),
    relation,
  );
  const unsupported = (
    await env.DB.prepare(
      "SELECT id, type FROM events WHERE problem_id = ? AND object_kind IN ('gap', 'relation') ORDER BY seq",
    )
      .bind(problem)
      .all()
  ).results;
  assert.deepEqual(
    unsupported.map((event) => event.type),
    [
      "gap.filed",
      "gap.closed-by",
      "gap.filed",
      "gap.withdrawn",
      "gap.filed",
      "gap.closed-by",
      "gap.filed",
      "gap.withdrawn",
      "relation.asserted",
    ],
  );
  const freshJobs = (
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM outbox o JOIN events e ON e.id = o.event_id WHERE e.problem_id = ? AND e.object_kind IN ('gap', 'relation')",
    )
      .bind(problem)
      .first()
  ).n;

  // Restore exactly the unsupported search handoffs emitted by older writers.
  // INSERT OR IGNORE also makes the pre-fix production queue a valid reproduction.
  for (const event of unsupported) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO outbox (event_id, problem_id, kind, dedupe_key, payload_sha256, created_at)
       SELECT id, problem_id, 'search.index', 'search.index:' || id, payload_sha256, ?
       FROM events WHERE id = ?`,
    )
      .bind(new Date().toISOString(), event.id)
      .run();
  }
  const later = await publish("For every integer n, the integer 6n is divisible by two.");
  const outbox = env.KRATER_OUTBOX.get(env.KRATER_OUTBOX.idFromName("krater-outbox-v0"));
  const drain = () =>
    outbox.fetch("https://krater-outbox.internal/drain-now", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": userAgent },
      body: JSON.stringify({ fault_mode: "none" }),
    });
  let response;
  try {
    response = await drain();
  } catch (error) {
    const queue = (
      await env.DB.prepare(
        `SELECT e.type, o.state, o.quarantine_code FROM outbox o JOIN events e ON e.id = o.event_id
       WHERE e.problem_id = ? ORDER BY o.id`,
      )
        .bind(problem)
        .all()
    ).results;
    console.log(JSON.stringify({ kind: "outbox-fairness-blocked", queue }));
    throw error;
  }
  const drained = await response.json();
  console.log(
    JSON.stringify({ kind: "outbox-fairness-drain", status: response.status, ...drained }),
  );
  assert.equal(
    response.status,
    200,
    "Unsupported source must be quarantined without blocking valid work",
  );
  assert.equal(freshJobs, 0, "Gap and relation writes must not enqueue claim-only search work");

  // Reconciliation may need the next page; every direct drain remains bounded.
  for (let page = 0; page < 4; page++) {
    const pending = (
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM outbox WHERE problem_id = ? AND state = 'pending' AND quarantined_at IS NULL",
      )
        .bind(problem)
        .first()
    ).n;
    if (pending === 0) break;
    const next = await drain();
    assert.equal(next.status, 200);
    const counts = await next.json();
    assert.ok(counts.delivered + counts.quarantined <= 8, "A drain must keep its page bound");
  }

  for (const event of unsupported) {
    const row = await env.DB.prepare(
      "SELECT state, delivered_at, quarantined_at, quarantine_code FROM outbox WHERE event_id = ?",
    )
      .bind(event.id)
      .first();
    assert.equal(row.state, "pending");
    assert.equal(row.delivered_at, null, "Quarantine must never claim a successful effect");
    assert.ok(row.quarantined_at);
    assert.equal(row.quarantine_code, "OUTBOX_PAYLOAD_INVALID");
  }
  const documents = async () =>
    (
      await env.DB.prepare(
        "SELECT claim_id, statement FROM public_claim_fts WHERE problem_id = ? ORDER BY claim_id",
      )
        .bind(problem)
        .all()
    ).results;
  const indexed = await documents();
  assert.deepEqual(
    indexed.map((row) => row.claim_id).sort(),
    [first.claim_id, later.claim_id].sort(),
  );
  assert.ok(!JSON.stringify(indexed).includes(privateCanary));
  assert.equal(
    (
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM outbox WHERE problem_id = ? AND state = 'delivered'",
      )
        .bind(problem)
        .first()
    ).n,
    2,
  );
  const search = await call("/search.json?q=divisible&kind=claim&limit=50");
  assert.ok(search.items.some((item) => item.problem_id === problem && item.id === later.claim_id));
  assert.equal((await drain()).status, 200);
  assert.deepEqual(
    await documents(),
    indexed,
    "A duplicate drain must retain exactly one document per claim",
  );
  console.log(
    JSON.stringify({
      kind: "outbox-fairness-real-bindings",
      status: "pass",
      unsupported_events: unsupported.length,
      fresh_unsupported_jobs: freshJobs,
      indexed_claims: indexed.length,
      fixtures:
        "sponsor enrollment, empty problem, classifier decisions, restored legacy outbox handoffs",
    }),
  );
}
