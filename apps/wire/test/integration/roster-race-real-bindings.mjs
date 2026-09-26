import assert from "node:assert/strict";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// W9.5 writer slots (beads asimposiumorg-1ar / asimposiumorg-codz) on real
// local Workerd HTTP and D1. Fellows open sessions on one capped problem
// CONCURRENTLY through the Worker; exactly `cap` of them may become
// contributors, the rest observers, and an observer's promote is refused with
// ROSTER_FULL while a contributor's succeeds.
//
// Not covered: provider D1 latency or multi-region write ordering.

const RACERS = 8;
const OPEN_SLOTS = 3;

await runLocalWorkerJourney(async ({ call, enroll, sponsorCall, env }) => {
  const OWNER = "usr_roster_owner";
  const author = await enroll("roster-author", OWNER);
  const reviewer = await enroll("roster-reviewer", "usr_roster_reviewer");
  const created = await call(
    "/v1/problems",
    {
      title: "Capped parity problem",
      statement: "Every integer in 0..60 has a square of the same parity.",
      falsifier: "An integer in 0..60 whose square has the opposite parity.",
      motivation: "Exercise writer slots under concurrent joins.",
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
      basis: "Exact range.",
    },
    reviewer,
  );

  const contributors = async () =>
    Number(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM problem_memberships WHERE problem_id = ? AND role = 'contributor'",
        )
          .bind(problem)
          .first()
      ).n,
    );
  const before = await contributors();
  const cap = before + OPEN_SLOTS;
  await sponsorCall(
    OWNER,
    "POST",
    `/v1/sponsors/problems/${problem}/lifecycle`,
    "problem-lifecycle",
    {
      action: "set-writer-cap",
      writer_cap: cap,
    },
  );

  const racers = [];
  for (let i = 0; i < RACERS; i++) {
    racers.push(await enroll(`roster-racer-${i}`, `usr_roster_racer_${i}`));
  }

  // All joins in flight at once through the Worker.
  const opened = await Promise.all(
    racers.map((token) =>
      call("/v1/sessions", { problem_id: problem, intent: "prove" }, token, 201),
    ),
  );
  assert.equal(opened.length, RACERS);

  const roles = (
    await env.DB.prepare(
      "SELECT fellow_id, role FROM problem_memberships WHERE problem_id = ? ORDER BY joined_at",
    )
      .bind(problem)
      .all()
  ).results;
  const after = await contributors();
  assert.equal(after, cap, `exactly ${cap} contributors after the race (got ${after})`);
  const observers = roles.filter((row) => row.role === "observer").length;
  assert.equal(observers, RACERS - OPEN_SLOTS, "every loser of the race is an observer");

  // /v1/p/:id/next reads the same membership: each racer's viewer role and
  // permissions come from its row, never a default (independent verification
  // 4 found this read uncovered by any lane).
  const nextRoles = [];
  for (const token of racers) {
    const next = await call(`/v1/p/${problem}/next`, undefined, token);
    nextRoles.push(next.viewer.role);
  }
  assert.deepEqual(
    [...nextRoles].sort(),
    roles
      .filter((row) => row.role === "observer" || row.role === "contributor")
      .slice(-RACERS)
      .map((row) => row.role)
      .sort(),
    "/next reports each racer's recorded role",
  );
  assert.equal(
    nextRoles.filter((role) => role === "observer").length,
    RACERS - OPEN_SLOTS,
    "/next shows every race loser as an observer",
  );

  // Each racer learns its role from the Worker, and the invariant holds on promote.
  let promoted = 0;
  let refused = 0;
  for (const [i, token] of racers.entries()) {
    const session = opened[i].session_id;
    const draft = await call(
      `/v1/sessions/${session}/workshop`,
      { type: "claim-draft", title: "Draft", body_md: "Private." },
      token,
      201,
    );
    const result = await call(
      `/v1/sessions/${session}/promote`,
      {
        workshop_id: draft.workshop_id,
        kind: "conjecture",
        statement: `Integer ${i} squared keeps its parity.`,
        falsifier: `Integer ${i} squared has the opposite parity.`,
      },
      token,
      null,
    );
    if (result.code === "ROSTER_FULL") refused += 1;
    else {
      assert.ok(typeof result.claim_id === "string", `promote ${i}: ${result.code ?? "no claim"}`);
      promoted += 1;
    }
  }
  assert.equal(promoted, OPEN_SLOTS, "only slot holders may promote");
  assert.equal(refused, RACERS - OPEN_SLOTS, "every observer promote is ROSTER_FULL");

  console.log(
    JSON.stringify({
      stage: "roster-race-journey-passed",
      kind: "roster-race-real-bindings",
      status: "pass",
      racers: RACERS,
      cap,
      contributors: after,
      observers,
      boundary: "real local Workerd/D1; concurrent HTTP joins; no provider latency",
    }),
  );
});
