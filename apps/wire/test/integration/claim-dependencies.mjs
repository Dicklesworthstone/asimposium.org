import assert from "node:assert/strict";
import { ClaimFaceResponseSchema } from "../../../../packages/contracts/src/ledger.ts";
import { PackResponseSchema } from "../../../../packages/contracts/src/sessions.ts";

// Production HTTP writes and actual local D1/R2. Existing fixture seams provide
// sponsor enrollment, empty problems, classifier decisions and content withdrawal.
export async function claimDependencies({
  call,
  enroll,
  fixtures,
  env,
  worker,
  origin,
  userAgent,
}) {
  const problem = "P-DEPENDENCIES";
  await fixtures.seedProblem(problem);
  const token = await enroll("dependency-author", "usr_dependency_author");
  const reviewer = await enroll("dependency-reviewer", "usr_dependency_reviewer");
  const session = await call("/v1/sessions", { problem_id: problem, intent: "prove" }, token, 201);
  const review = await call(
    "/v1/sessions",
    { problem_id: problem, intent: "review" },
    reviewer,
    201,
  );
  const path = `/v1/sessions/${session.session_id}`;
  const privateCanary = "DEPENDENCY_PRIVATE_SCRATCH_DO_NOT_PUBLISH";
  const draft = await call(
    `${path}/workshop`,
    { type: "draft", title: "Premise work", body_md: privateCanary, relates_to: [] },
    token,
    201,
  );
  const falsifier =
    "An integer in the stated domain that violates the stated divisibility relation.";
  const publish = (statement, depends_on = [], key) =>
    call(
      `${path}/promote`,
      {
        workshop_id: draft.workshop_id,
        kind: "conjecture",
        statement,
        falsifier,
        depends_on,
      },
      token,
      201,
      key,
    );
  const revise = (claim, statement, depends_on = []) =>
    call(
      `${path}/revise`,
      {
        claim_id: claim.claim_id,
        base_version: claim.version,
        kind: "conjecture",
        statement,
        falsifier,
        depends_on,
      },
      token,
      201,
    );
  const face = async (target, etag) => {
    const response = await worker.fetch(`${origin}/p/${problem}/claims/${target}.json`, {
      headers: { "user-agent": userAgent, ...(etag ? { "if-none-match": etag } : {}) },
    });
    assert.equal(response.status, 200);
    const value = ClaimFaceResponseSchema.parse(await response.json());
    assert.ok(!JSON.stringify(value).includes(privateCanary));
    return { value, etag: response.headers.get("etag") };
  };
  const count = async () =>
    (
      await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE problem_id = ?")
        .bind(problem)
        .first()
    ).n;
  const premise = await publish("For every integer n, the integer 2n is divisible by two.");
  const premise1 = (await face(`${premise.claim_id}@1`)).value;
  const detail1 = JSON.parse(premise1.items.find((item) => item.kind === "claim-detail").body);
  assert.deepEqual(detail1.dependency_pins, []);
  const parentStatement = "For every integer n, the sum 2n + 2n is divisible by two.";
  const parent = await publish(parentStatement, [premise.claim_id], "dependency-parent");
  const target = `${parent.claim_id}@1`;
  const original = await face(target);
  const dependency = original.value.items.find((item) => item.kind === "claim-dependency");
  assert.equal(dependency.id, `${premise.claim_id}@1`);
  assert.equal(JSON.parse(dependency.body).statement, detail1.statement);
  assert.equal(JSON.parse(dependency.body).fellow, detail1.fellow);
  const parentDetail = JSON.parse(
    original.value.items.find((item) => item.kind === "claim-detail").body,
  );
  assert.equal(parentDetail.dependency_pins[0].event_id, detail1.event);
  assert.equal(parentDetail.dependency_pins[0].content_digest, detail1.content_digest);
  assert.ok(
    original.value.next_actions.some(
      (action) =>
        action.url ===
        `/p/${problem}/claims/${premise.claim_id}@1.md?through=${original.value.cursor}`,
    ),
  );
  const originalDependency = JSON.parse(dependency.body);
  assert.equal(
    originalDependency.read_url,
    `/p/${problem}/claims/${premise.claim_id}@1.md?through=${original.value.cursor}`,
  );
  async function assertPremiseUnchanged() {
    const current = (await face(target)).value;
    assert.deepEqual(
      JSON.parse(current.items.find((item) => item.kind === "claim-dependency").body),
      {
        ...originalDependency,
        // The publication and all its provenance stay identical; navigating its
        // scientific context now retains the cursor of the face just read.
        read_url: `/p/${problem}/claims/${premise.claim_id}@1.md?through=${current.cursor}`,
      },
    );
  }
  const premise2 = await revise(
    premise,
    "For every nonnegative integer n, the integer 2n is divisible by two.",
  );
  await assertPremiseUnchanged();
  const beforeReplay = await count();
  const replay = await call(
    `${path}/promote`,
    {
      workshop_id: draft.workshop_id,
      kind: "conjecture",
      statement: parentStatement,
      falsifier,
      depends_on: [premise.claim_id],
    },
    token,
    200,
    "dependency-parent",
  );
  assert.equal(replay.claim_id, parent.claim_id);
  assert.equal(await count(), beforeReplay);
  const parent2 = await revise(
    parent,
    "For every nonnegative integer n, the sum 2n + 2n is divisible by two.",
    [premise.claim_id],
  );
  const revised = await face(`${parent2.claim_id}@2`);
  assert.equal(
    revised.value.items.find((item) => item.kind === "claim-dependency").id,
    `${premise.claim_id}@2`,
  );
  // Search indexing is asynchronous. Both revised statements, including the
  // parent's dependency-bearing payload, must reach the real FTS consumer.
  let indexed = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    const search = await call("/search.json?q=nonnegative&kind=claim&limit=50");
    const local = search.items.filter((item) => item.problem_id === problem);
    indexed = [premise.claim_id, parent.claim_id].every((id) =>
      local.some((item) => item.id === id && item.statement.includes("nonnegative")),
    );
    if (indexed) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(
    indexed,
    "Revision and dependency payloads must be indexed from their actual publication bytes",
  );
  await assertPremiseUnchanged();
  for (const budget of [800, 1500, 4000, 8000]) {
    const url = `/v1/sessions/${review.session_id}/pack?profile=review&target=${target}&max_tokens=${budget}`;
    const pack = PackResponseSchema.parse(await call(url, undefined, reviewer));
    assert.deepEqual(await call(url, undefined, reviewer), pack);
    assert.ok(!JSON.stringify(pack).includes(privateCanary));
    assert.ok(pack.items.every((item) => item.scope !== "workshop"));
    const entry = pack.items.find((item) => item.kind === "claim-dependency");
    if (budget === 8000) {
      assert.equal(entry?.id, `${premise.claim_id}@1`);
      assert.ok(
        pack.next_actions.some((action) => action.url.endsWith(`/${premise.claim_id}@1.md`)),
      );
    }
    if (!entry) assert.ok(pack.omitted.some((item) => item.reason === "budget_exceeded"));
  }
  // Current content controls beat historical pins and invalidate conditional GETs.
  await fixtures.redactPublicContent(detail1.event);
  const withdrawn = await face(target, original.etag);
  assert.notEqual(withdrawn.etag, original.etag);
  assert.ok(!withdrawn.value.items.some((item) => item.kind === "claim-dependency"));
  assert.ok(
    withdrawn.value.omitted.some(
      (item) => item.reason === "content_unavailable" && item.detail === `${premise.claim_id}@1`,
    ),
  );
  for (const suffix of ["md", "html"]) {
    const response = await worker.fetch(`${origin}/p/${problem}/claims/${target}.${suffix}`, {
      headers: { "user-agent": userAgent },
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(!text.includes(detail1.statement));
    assert.ok(!text.includes(privateCanary));
  }
  const premise2Detail = JSON.parse(
    (await face(`${premise2.claim_id}@2`)).value.items.find((item) => item.kind === "claim-detail")
      .body,
  );
  await fixtures.redactOnNextScreen(premise2Detail.event);
  const beforeRace = await count();
  const refused = await call(
    `${path}/promote`,
    {
      workshop_id: draft.workshop_id,
      kind: "conjecture",
      statement: "For every integer n, the sum 2n + 4n is divisible by two.",
      falsifier,
      depends_on: [premise.claim_id],
    },
    token,
    422,
  );
  assert.equal(refused.code, "DEPENDENCY_NOT_FOUND");
  assert.ok(refused.fix_hint);
  assert.equal(await count(), beforeRace);
  const unavailable = await call(
    `${path}/revise`,
    {
      claim_id: parent.claim_id,
      base_version: 2,
      kind: "conjecture",
      statement: "For every positive integer n, the sum 2n + 2n is divisible by two.",
      falsifier,
      depends_on: [premise.claim_id],
    },
    token,
    422,
  );
  assert.equal(unavailable.code, "DEPENDENCY_NOT_FOUND");
  assert.equal(await count(), beforeRace);
  // An explicit empty dependency set on a revision does not inherit old edges.
  // Explicit derived-queue replay fixture: simulate a lost acknowledgement for
  // an already indexed version that is now withdrawn. Scientific rows are untouched.
  const queuedAgain = await env.DB.prepare(
    "UPDATE outbox SET state = 'pending', delivered_at = NULL WHERE event_id = ? AND state = 'delivered'",
  )
    .bind(premise2Detail.event)
    .run();
  assert.equal(queuedAgain.meta.changes, 1);
  const outbox = env.KRATER_OUTBOX.get(env.KRATER_OUTBOX.idFromName("krater-outbox-v0"));
  const drain = await outbox.fetch("https://krater-outbox.internal/drain-now", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": userAgent },
    body: JSON.stringify({ fault_mode: "none" }),
  });
  assert.equal(drain.status, 200);
  assert.equal(
    (
      await env.DB.prepare("SELECT state FROM outbox WHERE event_id = ?")
        .bind(premise2Detail.event)
        .first()
    ).state,
    "delivered",
  );
  const without = await revise(parent2, "For n = 0, the integer 2n + 2n equals zero.");
  assert.ok(
    !(await face(`${without.claim_id}@3`)).value.items.some(
      (item) => item.kind === "claim-dependency",
    ),
  );
  // C-n is local to a problem. The other problem must resolve its own C-1
  // even though this problem's C-1 has been withdrawn.
  const otherProblem = "P-DEPENDENCIES-OTHER";
  await fixtures.seedProblem(otherProblem);
  const otherSession = await call(
    "/v1/sessions",
    { problem_id: otherProblem, intent: "prove" },
    token,
    201,
  );
  const otherPath = `/v1/sessions/${otherSession.session_id}`;
  const otherDraft = await call(
    `${otherPath}/workshop`,
    { type: "draft", title: "Other premises", body_md: privateCanary, relates_to: [] },
    token,
    201,
  );
  const otherPublish = (statement, depends_on = []) =>
    call(
      `${otherPath}/promote`,
      { workshop_id: otherDraft.workshop_id, kind: "conjecture", statement, falsifier, depends_on },
      token,
      201,
    );
  const otherPremise = await otherPublish(
    "For every integer n, the integer 3n is divisible by three.",
  );
  assert.equal(otherPremise.claim_id, premise.claim_id);
  const otherParent = await otherPublish(
    "For every integer n, the sum 3n + 3n is divisible by three.",
    [otherPremise.claim_id],
  );
  const otherResponse = await worker.fetch(
    `${origin}/p/${otherProblem}/claims/${otherParent.claim_id}@1.json`,
    { headers: { "user-agent": userAgent } },
  );
  assert.equal(otherResponse.status, 200);
  const otherFace = ClaimFaceResponseSchema.parse(await otherResponse.json());
  const otherDependency = JSON.parse(
    otherFace.items.find((item) => item.kind === "claim-dependency").body,
  );
  assert.equal(otherDependency.problem, otherProblem);
  assert.ok(otherDependency.statement.includes("3n"));
  assert.notEqual(otherDependency.event, detail1.event);
  const foreignOnly = await otherPublish("For n = 1, the integer 3n equals three.");
  const beforeForeign = await count();
  const foreignRefusal = await call(
    `${path}/revise`,
    {
      claim_id: parent.claim_id,
      base_version: 3,
      kind: "conjecture",
      statement: "For n = 2, the integer 2n + 2n equals eight.",
      falsifier,
      depends_on: [foreignOnly.claim_id],
    },
    token,
    422,
  );
  assert.equal(foreignRefusal.code, "DEPENDENCY_NOT_FOUND");
  assert.equal(await count(), beforeForeign);
  const otherCount = async () =>
    (
      await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE problem_id = ?")
        .bind(otherProblem)
        .first()
    ).n;
  const beforeRevisionRace = await otherCount();
  await fixtures.redactOnNextScreen(otherDependency.event);
  const revisionRace = await call(
    `${otherPath}/revise`,
    {
      claim_id: otherParent.claim_id,
      base_version: 1,
      kind: "conjecture",
      statement: "For every positive integer n, the sum 3n + 3n is divisible by three.",
      falsifier,
      depends_on: [otherPremise.claim_id],
    },
    token,
    422,
  );
  assert.equal(revisionRace.code, "DEPENDENCY_NOT_FOUND");
  assert.equal(await otherCount(), beforeRevisionRace);
  const manyProblem = "P-DEPENDENCIES-MAX";
  await fixtures.seedProblem(manyProblem);
  const manyToken = await enroll("dependency-max", "usr_dependency_max");
  const manySession = await call(
    "/v1/sessions",
    { problem_id: manyProblem, intent: "prove" },
    manyToken,
    201,
  );
  const manyPath = `/v1/sessions/${manySession.session_id}`;
  const manyDraft = await call(
    `${manyPath}/workshop`,
    { type: "draft", title: "Sixteen premises", body_md: privateCanary, relates_to: [] },
    manyToken,
    201,
  );
  const manyIds = [];
  for (let index = 2; index <= 17; index++) {
    const next = await call(
      `${manyPath}/promote`,
      {
        workshop_id: manyDraft.workshop_id,
        kind: "conjecture",
        statement: `For every integer n, ${index}n is divisible by ${index}.`,
        falsifier,
      },
      manyToken,
      201,
    );
    manyIds.push(next.claim_id);
  }
  const manyParent = await call(
    `${manyPath}/promote`,
    {
      workshop_id: manyDraft.workshop_id,
      kind: "conjecture",
      statement:
        "For every integer n, the sum of the sixteen specified integer multiples is an integer.",
      falsifier,
      depends_on: manyIds,
    },
    manyToken,
    201,
  );
  for (const budget of [800, 1500, 4000, 8000]) {
    const pack = PackResponseSchema.parse(
      await call(
        `${manyPath}/pack?profile=claim&target=${manyParent.claim_id}@1&max_tokens=${budget}`,
        undefined,
        manyToken,
      ),
    );
    assert.ok(pack.tokens_estimate <= pack.budget_tokens);
    const premises = pack.items.filter((item) => item.kind === "claim-dependency");
    if (budget === 8000) assert.ok(premises.length > 0);
    for (const item of premises)
      assert.equal(JSON.parse(item.body).read_url, `/p/${manyProblem}/claims/${item.id}.md`);
    if (premises.length < manyIds.length)
      assert.ok(pack.omitted.some((item) => item.reason === "budget_exceeded"));
    assert.ok(!JSON.stringify(pack).includes(privateCanary));
  }
  const manyResponse = await worker.fetch(
    `${origin}/p/${manyProblem}/claims/${manyParent.claim_id}@1.json`,
    { headers: { "user-agent": userAgent } },
  );
  assert.equal(manyResponse.status, 200);
  assert.equal(
    ClaimFaceResponseSchema.parse(await manyResponse.json()).items.filter(
      (item) => item.kind === "claim-dependency",
    ).length,
    16,
  );
  console.log(
    JSON.stringify({
      kind: "claim-dependencies-real-bindings",
      status: "pass",
      boundary: "local Workerd/D1/R2; fixture sponsor setup, classifier and content controls",
      assertions: [
        "immutable premise versions",
        "extended publication and revision search indexing",
        "withdrawn index job replay retires without blocking later jobs",
        "explicit revision dependency set",
        "public and isolated review faces",
        "replay preserves pins",
        "withdrawal invalidates ETags",
        "create and revise screening race rollback",
        "problem-local identity and foreign-only reference rejection",
        "no unavailable-head fallback",
        "deterministic budgets and private exclusion",
        "maximum sixteen premises across all pack budget buckets",
      ],
    }),
  );
}
