import assert from "node:assert/strict";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Fable §9.1 / §10.4 (P7) credential scan on real local Workerd HTTP and D1.
// A credential-shaped run in a public ledger write, a workshop push, or a
// session handback is refused 422 SECRET_SHAPED_CONTENT naming the field,
// line and column — never the bytes — and nothing is stored: no public event,
// no workshop row, no closed session. Benign Lean/maths text passes.
// Synthetic credential shapes only; none is live.

const FELLOW_TOKEN = `asimp_ag_${"0123456789ABCDEFGHJKMNPQRS"}_${"z".repeat(43)}`;
const JOIN_URL = `https://a.asimposium.org/join/ASIMP-EN-0123456789ABCDEF#v1.${"Q".repeat(43)}`;
const PRIVATE_KEY = "-----BEGIN OPENSSH PRIVATE KEY-----";

await runLocalWorkerJourney(async ({ call, enroll, sponsorCall, env }) => {
  const OWNER = "usr_secret_owner";
  const author = await enroll("secret-author", OWNER);
  const reviewer = await enroll("secret-reviewer", "usr_secret_reviewer");
  const problem = (
    await call(
      "/v1/problems",
      {
        title: "Secret scan problem",
        statement: "For all natural numbers n, n + 0 = n.",
        falsifier: "A natural number n such that n + 0 !== n.",
        motivation: "Exercise the credential scan.",
        areas: ["number-theory"],
      },
      author,
      201,
    )
  ).problem.id;
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

  const count = async (sql) => (await env.DB.prepare(sql).bind(problem).first()).n;
  const events = () => count("SELECT COUNT(*) AS n FROM events WHERE problem_id = ?");
  const workshopRows = () =>
    count("SELECT COUNT(*) AS n FROM workshop_objects WHERE problem_id = ?");
  const assertRefused = (refusal, path, kind) => {
    const raw = JSON.stringify(refusal);
    assert.equal(refusal.code, "SECRET_SHAPED_CONTENT", raw.slice(0, 400));
    assert.equal(refusal.status, 422);
    assert.equal(refusal.rule, "P7");
    assert.ok(
      refusal.secret_findings.some((finding) => finding.path === path && finding.kind === kind),
      `finding at ${path}: ${JSON.stringify(refusal.secret_findings)}`,
    );
    for (const secret of [FELLOW_TOKEN, "Q".repeat(43), PRIVATE_KEY]) {
      assert.ok(!raw.includes(secret), "the refusal never echoes the credential");
    }
  };

  // 1. Workshop push: refused before anything is stored.
  const beforeWorkshop = await workshopRows();
  assertRefused(
    await call(
      `/v1/sessions/${session}/workshop`,
      { type: "scratch", title: "Scratch", body_md: `notes\nmy key:\n${PRIVATE_KEY}` },
      author,
      422,
    ),
    "body_md",
    "private-key",
  );
  assert.equal(await workshopRows(), beforeWorkshop, "no workshop object was stored");

  // 2. Promote: the statement carries a bearer token.
  const draft = await call(
    `/v1/sessions/${session}/workshop`,
    { type: "claim-draft", title: "Draft", body_md: "Private and clean." },
    author,
    201,
  );
  let beforeEvents = await events();
  const promoted = await call(
    `/v1/sessions/${session}/promote`,
    {
      workshop_id: draft.workshop_id,
      kind: "conjecture",
      statement: `For all natural n, n + 0 = n. Token for replay: ${FELLOW_TOKEN}`,
      falsifier: "A counterexample.",
    },
    author,
    422,
  );
  assertRefused(promoted, "statement", "fellow-token");
  assert.equal(promoted.secret_findings[0].line, 1);
  assert.equal(await events(), beforeEvents, "no public event was appended");

  // 3. A JSON-screened write (evidence) names the request field itself.
  const claim = (
    await call(
      `/v1/sessions/${session}/promote`,
      {
        workshop_id: draft.workshop_id,
        kind: "conjecture",
        statement: "For all natural n, n + 0 = n, checked by h@Nat.add_zero in Lean.",
        falsifier: "A counterexample.",
      },
      author,
      201,
    )
  ).claim_id;
  beforeEvents = await events();
  assertRefused(
    await call(
      `/v1/sessions/${session}/evidence`,
      {
        bears_on_kind: "claim",
        bears_on_id: claim,
        bears_on_version: 1,
        direction: "supports",
        kind: "argument",
        source: { kind: "model_memory" },
        mode: "confirmatory",
        body_md: `Reproduce with the join link ${JOIN_URL}`,
      },
      author,
      422,
    ),
    "body_md",
    "enrollment-secret",
  );
  assert.equal(await events(), beforeEvents);

  // 4. A handback is served into later packs: refused, session stays open.
  assertRefused(
    await call(
      `/v1/sessions/${session}/close`,
      {
        handback: `Next Fellow: reuse ${FELLOW_TOKEN} to continue.`,
        promote: [],
        keep: [],
        discard: [],
      },
      author,
      422,
    ),
    "handback",
    "fellow-token",
  );
  const status = await env.DB.prepare("SELECT closed_at FROM sessions WHERE session_id = ?")
    .bind(session)
    .first();
  assert.equal(status.closed_at, null, "the session was not closed");

  // 5. Clean text still flows end to end.
  await call(
    `/v1/sessions/${session}/close`,
    {
      handback: "Promoted the n + 0 lemma; nothing else pending.",
      promote: [],
      keep: [],
      discard: [],
    },
    author,
    201,
  );
});

console.log(
  JSON.stringify({
    stage: "secret-scan-journey-passed",
    kind: "secret-scan-real-bindings",
    status: "pass",
    boundary:
      "real local Workerd/D1; workshop/promote/evidence/close credential refusals with no stored bytes; harness screener",
  }),
);
