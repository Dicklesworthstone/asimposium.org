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

await runLocalWorkerJourney(async (context) => {
  const { call, enroll, sponsorCall, env, worker, fixtures, origin, userAgent } = context;
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
  const unjoined = await call(`/v1/p/${problem}/next`, undefined, author);
  assert.equal(
    unjoined.viewer.role_suggestion,
    null,
    "an unjoined Fellow receives no membership advice",
  );
  const authorSession = (await call("/v1/sessions", { problem_id: problem }, author, 201))
    .session_id;
  const rosterSponsors = await env.DB.prepare(`SELECT f.sponsor_id FROM problem_memberships m
    JOIN enrollment_fellows f ON f.fellow_id=m.fellow_id WHERE m.problem_id=?`)
    .bind(problem)
    .all();
  assert.deepEqual(rosterSponsors.results, [{ sponsor_id: OWNER }]);
  const oneSponsorResponse = await worker.fetch(`${origin}/p/${problem}.json`, {
    headers: { "user-agent": userAgent },
  });
  assert.equal(oneSponsorResponse.status, 200);
  const oneSponsorFace = await oneSponsorResponse.json();
  assert.ok(
    oneSponsorFace.omitted.some((item) => item.reason === "single_team"),
    "the canonical problem face must disclose its recorded one-sponsor roster",
  );
  const oneSponsorMarkdown = await worker.fetch(`${origin}/p/${problem}.md`, {
    headers: { "user-agent": userAgent },
  });
  assert.equal(oneSponsorMarkdown.status, 200);
  const singleTeamDetail = oneSponsorFace.omitted.find(
    (item) => item.reason === "single_team",
  ).detail;
  assert.ok((await oneSponsorMarkdown.text()).includes(singleTeamDetail));
  assert.ok(!singleTeamDetail.includes(OWNER), "no sponsor identity is exposed by the notice");
  assert.match(singleTeamDetail, /Historical review independence/);
  const sharpeningNext = await call(`/v1/p/${problem}/next`, undefined, author);
  assert.equal(sharpeningNext.degraded, true);
  assert.equal(
    sharpeningNext.viewer.role_suggestion,
    null,
    "partial move discovery withholds roster advice",
  );
  const reviewSession = (
    await call("/v1/sessions", { problem_id: problem, intent: "review" }, reviewer, 201)
  ).session_id;
  const twoSponsorResponse = await worker.fetch(`${origin}/p/${problem}.json`, {
    headers: { "user-agent": userAgent, "if-none-match": oneSponsorResponse.headers.get("etag") },
  });
  assert.equal(twoSponsorResponse.status, 200, "a roster join invalidates the old face ETag");
  const twoSponsorFace = await twoSponsorResponse.json();
  assert.equal(twoSponsorFace.cursor, oneSponsorFace.cursor, "a join need not advance the ledger");
  assert.ok(!twoSponsorFace.omitted.some((item) => item.reason === "single_team"));
  assert.notEqual(twoSponsorResponse.headers.get("etag"), oneSponsorResponse.headers.get("etag"));
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

  const reviewedFace = await call(`/p/${problem}.json`);
  const recordedReviews = reviewedFace.items.filter((item) => item.kind === "statement-review");
  assert.equal(recordedReviews.length, 1, "a real cross-sponsor statement review is readable");
  const reviewFellow = (await call("/v1/hello", undefined, reviewer)).fellow.fellow_id;
  await sponsorCall(
    OWNER,
    "POST",
    `/v1/sponsors/problems/${problem}/lifecycle`,
    "problem-lifecycle",
    { action: "manage-member", operation: "remove", target_fellow_id: reviewFellow },
  );
  const currentSingleTeam = await call(`/p/${problem}.json`);
  assert.ok(currentSingleTeam.omitted.some((item) => item.reason === "single_team"));
  assert.deepEqual(
    currentSingleTeam.items.filter((item) => item.kind === "statement-review"),
    recordedReviews,
    "current membership cannot rewrite a committed review's attribution",
  );
  assert.ok(
    !JSON.stringify(currentSingleTeam.omitted).includes("nothing has been independently reviewed"),
  );
  await sponsorCall(
    OWNER,
    "POST",
    `/v1/sponsors/problems/${problem}/lifecycle`,
    "problem-lifecycle",
    {
      action: "manage-member",
      operation: "set-role",
      target_fellow_id: reviewFellow,
      role: "contributor",
    },
  );
  const restoredTeams = await call(`/p/${problem}.json`);
  assert.ok(!restoredTeams.omitted.some((item) => item.reason === "single_team"));

  const firstNext = await call(`/v1/p/${problem}/next`, undefined, author);
  assert.equal(
    firstNext.viewer.role_suggestion?.suggested_role,
    "worker",
    `first writer receives roster advice: ${JSON.stringify({ role: firstNext.viewer.role, degraded: firstNext.degraded, reason: firstNext.degraded_reason, move: firstNext.primary_move?.move })}`,
  );
  assert.equal(firstNext.viewer.role_suggestion.advisory, true);
  const authorDraft = await call(
    `/v1/sessions/${authorSession}/workshop`,
    {
      type: "claim-draft",
      title: "Parity check",
      body_md: "Private roster advice canary.",
    },
    author,
    201,
  );
  await call(
    `/v1/sessions/${authorSession}/promote`,
    {
      workshop_id: authorDraft.workshop_id,
      kind: "conjecture",
      statement: "The square of each integer from zero through sixty shares the integer's parity.",
      falsifier: "An integer in the stated range whose square has different parity.",
    },
    author,
    201,
  );
  const secondNext = await call(`/v1/p/${problem}/next`, undefined, reviewer);
  assert.ok(
    [secondNext.primary_move, ...secondNext.alternatives].some((move) => move?.move === "review"),
    "a real exact-version review is offered",
  );
  assert.equal(
    secondNext.viewer.role_suggestion?.suggested_role,
    "critic",
    "second writer sees the offered review role",
  );
  const markdown = await worker.fetch(`${origin}/v1/p/${problem}/next.md`, {
    headers: { authorization: `Bearer ${reviewer}`, "user-agent": userAgent },
  });
  assert.equal(markdown.status, 200);
  assert.equal(markdown.headers.get("cache-control"), "private, no-store");
  const text = await markdown.text();
  assert.ok(text.includes("Suggested role: critic (advisory)"));
  assert.ok(
    text.includes(secondNext.viewer.role_suggestion.reason),
    "Markdown preserves the JSON advice",
  );
  assert.ok(text.includes("grants no permission or reservation"));
  assert.ok(!text.includes("Private roster advice canary"));

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
    assert.equal(
      next.viewer.role_suggestion?.suggested_role,
      next.viewer.role === "observer" ? "observer" : "synthesizer",
      "full cap does not demote an admitted writer's advice",
    );
    assert.equal(next.viewer.role_suggestion.advisory, true);
    assert.equal(
      next.viewer.effective_permissions.promote,
      next.viewer.role !== "observer",
      "advice does not grant publication",
    );
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

  await sponsorCall(
    OWNER,
    "POST",
    `/v1/sponsors/problems/${problem}/lifecycle`,
    "problem-lifecycle",
    {
      action: "set-writer-cap",
      writer_cap: null,
    },
  );
  const observerIndex = nextRoles.indexOf("observer");
  assert.ok(observerIndex >= 0);
  const vacant = await call(`/v1/p/${problem}/next`, undefined, racers[observerIndex]);
  assert.equal(
    vacant.viewer.role_suggestion?.suggested_role,
    "observer",
    "uncapping alone does not change recorded membership",
  );
  assert.equal(vacant.viewer.effective_permissions.promote, false);

  // Control only the interleaving: return the actual initial membership row,
  // then commit a real membership change before the canonical selector reads.
  const changingToken = racers[observerIndex];
  const changingId = (await call("/v1/hello", undefined, changingToken)).fellow.fellow_id;
  const initialRoleRead =
    "SELECT role FROM problem_memberships WHERE problem_id = ? AND fellow_id = ?";
  const changeRole = async (role) => {
    await fixtures.armRaceAfterNextRead(
      "UPDATE problem_memberships SET role=? WHERE problem_id=? AND fellow_id=?",
      [role, problem, changingId],
      initialRoleRead,
    );
  };
  await changeRole("contributor");
  const upgraded = await call(`/v1/p/${problem}/next`, undefined, changingToken);
  assert.equal(
    await fixtures.raceStillArmed(),
    false,
    "the real competing membership commit fired",
  );
  assert.equal(
    (
      await env.DB.prepare(
        "SELECT role FROM problem_memberships WHERE problem_id=? AND fellow_id=?",
      )
        .bind(problem, changingId)
        .first()
    ).role,
    "contributor",
  );
  assert.equal(
    upgraded.viewer.effective_permissions.promote,
    true,
    "canonical authorization already sees the upgraded member",
  );
  assert.equal(
    upgraded.viewer.role,
    "contributor",
    "next role must match the canonical permissions after an upgrade",
  );
  assert.ok(upgraded.viewer.role_suggestion);
  assert.notEqual(upgraded.viewer.role_suggestion.suggested_role, "observer");
  const roleSession = opened[observerIndex].session_id;
  const roleDraft = await call(
    `/v1/sessions/${roleSession}/workshop`,
    {
      type: "claim-draft",
      title: "Consecutive parity",
      body_md: "Private changed-role canary.",
    },
    changingToken,
    201,
  );
  const roleClaim = await call(
    `/v1/sessions/${roleSession}/promote`,
    {
      workshop_id: roleDraft.workshop_id,
      kind: "conjecture",
      statement: "Among integers from zero through sixty, every odd integer has an even successor.",
      falsifier: "An odd integer in this range whose successor is also odd.",
    },
    changingToken,
    201,
  );
  assert.equal(
    typeof roleClaim.claim_id,
    "string",
    "the upgraded recorded member can actually publish",
  );
  const committedRoleClaim =
    await env.DB.prepare(`SELECT c.id, c.source_seq, e.type, e.actor_fellow_id
    FROM claims c JOIN events e ON e.problem_id=c.problem_id AND e.seq=c.source_seq
      AND e.object_id=c.id AND e.object_kind='claim'
    WHERE c.problem_id=? AND c.id=? AND c.source_seq=?`)
      .bind(problem, roleClaim.claim_id, roleClaim.seq)
      .first();
  assert.deepEqual(
    committedRoleClaim,
    {
      id: roleClaim.claim_id,
      source_seq: roleClaim.seq,
      type: "claim.created",
      actor_fellow_id: changingId,
    },
    "the upgraded publication is stored and attributed in the real ledger",
  );

  await changeRole("observer");
  const downgraded = await call(`/v1/p/${problem}/next`, undefined, changingToken);
  assert.equal(await fixtures.raceStillArmed(), false);
  assert.equal(
    downgraded.viewer.role,
    "observer",
    "next role must match denied permissions after a downgrade",
  );
  assert.equal(downgraded.viewer.effective_permissions.promote, false);
  assert.equal(downgraded.viewer.role_suggestion?.suggested_role, "observer");
  const deniedDraft = await call(
    `/v1/sessions/${roleSession}/workshop`,
    {
      type: "claim-draft",
      title: "Observer check",
      body_md: "Private observer work remains possible.",
    },
    changingToken,
    201,
  );
  const publicationState = () =>
    env.DB.prepare(`SELECT p.public_seq,
    (SELECT COUNT(*) FROM claims c WHERE c.problem_id=p.id) AS claims
    FROM problems p WHERE p.id=?`)
      .bind(problem)
      .first();
  const beforeDenied = await publicationState();
  const deniedClaim = await call(
    `/v1/sessions/${roleSession}/promote`,
    {
      workshop_id: deniedDraft.workshop_id,
      kind: "conjecture",
      statement: "Every even integer from two through sixty has an odd predecessor.",
      falsifier: "An even integer in the range with an even predecessor.",
    },
    changingToken,
    422,
  );
  assert.equal(deniedClaim.code, "ROSTER_FULL", "the downgraded member cannot actually publish");
  assert.deepEqual(
    await publicationState(),
    beforeDenied,
    "a refused promotion appends no public claim or event",
  );

  await changeRole("contributor");
  const changedMarkdown = await worker.fetch(`${origin}/v1/p/${problem}/next.md`, {
    headers: { authorization: `Bearer ${changingToken}`, "user-agent": userAgent },
  });
  assert.equal(changedMarkdown.status, 200);
  assert.equal(await fixtures.raceStillArmed(), false);
  const changedText = await changedMarkdown.text();
  assert.match(changedText, /^role: contributor$/m);
  assert.match(changedText, /^ {2}promote: true$/m);
  assert.ok(!changedText.includes("Suggested role: observer"));

  // Restore controlled operational membership; its genuine publication stays
  // in history and the original projection/search/log assertions still run.
  await env.DB.prepare(
    "UPDATE problem_memberships SET role='observer' WHERE problem_id=? AND fellow_id=?",
  )
    .bind(problem, changingId)
    .run();

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
