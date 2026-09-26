import assert from "node:assert/strict";
import {
  InboxAckResponseSchema,
  InboxResponseSchema,
  ProblemFollowResponseSchema,
  TriageResponseSchema,
} from "@asimposium/contracts";
import { EventTailResponseSchema } from "../../../../packages/contracts/src/event-tail.ts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// W6 Stoa surface on real Workerd HTTP, D1 and R2 (bead asimposiumorg-lu59):
// inbox notices CAUSED by committed ledger writes (delivered by one tick of the
// production cron consumer), acknowledgement, follows, event tails paged over
// concurrently committed events, and triage/next. Synthetic screening and
// sponsor approval come from the shared harness; no deployment claim.
await runLocalWorkerJourney(async ({ call, enroll, sponsorCall, fixtures }) => {
  const author = await enroll("stoa-surface-author", "usr_stoa_author");
  const reviewer = await enroll("stoa-surface-reviewer", "usr_stoa_reviewer");
  const second = await enroll("stoa-surface-second", "usr_stoa_second");
  const created = await call(
    "/v1/problems",
    {
      title: "Parity on a bounded range",
      statement: "Every integer in 0..500 has a square of the same parity.",
      falsifier: "An integer in 0..500 whose square has the opposite parity.",
      motivation: "Exercise the Stoa surface with causally produced notices.",
      areas: ["number-theory"],
    },
    author,
    201,
  );
  const problem = created.problem.id;
  await sponsorCall(
    "usr_stoa_author",
    "POST",
    `/v1/sponsors/problems/${problem}/lifecycle`,
    "problem-lifecycle",
    {
      action: "publish",
    },
  );
  const open = async (token, intent) =>
    (await call("/v1/sessions", { problem_id: problem, intent }, token, 201)).session_id;
  const reviewSession = await open(reviewer, "review");
  await call(
    `/v1/problems/${problem}/statement-review`,
    {
      session_id: reviewSession,
      statement_version: 1,
      verdict: "statement-clear",
      basis: "The range and parity predicate are exact.",
    },
    reviewer,
  );
  const authorSession = await open(author, "prove");
  const secondSession = await open(second, "prove");
  const promote = async (token, sessionId, statement) => {
    const draft = await call(
      `/v1/sessions/${sessionId}/workshop`,
      { type: "claim-draft", title: "Draft", body_md: "Private." },
      token,
      201,
    );
    return call(
      `/v1/sessions/${sessionId}/promote`,
      {
        workshop_id: draft.workshop_id,
        kind: "conjecture",
        statement,
        falsifier: "An integer in the stated range violating the relation.",
      },
      token,
      201,
    );
  };
  const claim = await promote(author, authorSession, "Zero squared is even, like zero.");

  // --- Inbox: a review caused by another Fellow reaches the claim's author. ---
  const inbox = async (token, query = "") =>
    InboxResponseSchema.parse(await call(`/v1/inbox${query}`, undefined, token));
  const before = await inbox(author);
  await call(
    `/v1/sessions/${reviewSession}/review`,
    {
      target_claim_id: claim.claim_id,
      target_version: 1,
      verdict: "confirm",
      basis: "Checked zero directly.",
      capable_of_failure: "A nonzero square of zero would refute it.",
      body_md: "Direct check.",
    },
    reviewer,
    201,
  );
  assert.equal(
    (await inbox(author)).items.length,
    before.items.length,
    "no notice before delivery runs",
  );
  const tick = await fixtures.deliverInboxTick();
  assert.equal(tick.failed, 0);
  const after = await inbox(author);
  const fresh = after.items.filter((item) => !before.items.some((old) => old.id === item.id));
  assert.equal(fresh.length, 1, "exactly one notice for one review");
  assert.equal(fresh[0].type, "object_critique");
  assert.equal(fresh[0].problem_id, problem);
  assert.equal(fresh[0].target_id, `${claim.claim_id}@1`, "notices pin the exact claim version");
  assert.ok(fresh[0].caused_by_event_id, "the notice names the event that caused it");
  const reviewerInbox = await inbox(reviewer);
  assert.ok(
    !reviewerInbox.items.some((item) => item.caused_by_event_id === fresh[0].caused_by_event_id),
    "the actor is not notified of their own write",
  );
  const again = await fixtures.deliverInboxTick();
  assert.equal(again.failed, 0);
  assert.equal((await inbox(author)).items.length, after.items.length, "delivery is idempotent");

  // Acknowledgement clears the unread view.
  assert.ok(after.unacknowledged_count >= 1);
  const acked = InboxAckResponseSchema.parse(
    await call("/v1/inbox/ack", { notice_ids: [fresh[0].id] }, author),
  );
  assert.equal(acked.acknowledged_count, 1);
  const unread = await inbox(author, "?unread_only=true");
  assert.ok(!unread.items.some((item) => item.id === fresh[0].id));

  // --- Follows: statement revisions reach followers, not strangers. ---
  const followed = ProblemFollowResponseSchema.parse(
    await call(`/v1/problems/${problem}/follow`, {}, second),
  );
  assert.equal(followed.following, true);
  assert.equal(
    ProblemFollowResponseSchema.parse(
      await call(`/v1/problems/${problem}/follow`, undefined, second),
    ).following,
    true,
  );
  // Both documented spellings reach the same per-principal follow state.
  assert.equal(
    ProblemFollowResponseSchema.parse(await call(`/v1/p/${problem}/follow`, undefined, second))
      .following,
    true,
  );
  assert.equal(
    ProblemFollowResponseSchema.parse(
      await call(`/v1/problems/${problem}/follow`, undefined, author),
    ).following,
    false,
    "follow state is per principal",
  );

  // --- Event tails over concurrently committed events. ---
  await Promise.all([
    promote(author, authorSession, "One squared is odd, like one."),
    promote(second, secondSession, "Two squared is even, like two."),
    promote(author, authorSession, "Three squared is odd, like three."),
  ]);
  const seen = [];
  let since = 0;
  let lastThrough = 0;
  for (let page = 0; page < 20; page++) {
    const body = EventTailResponseSchema.parse(
      await call(`/p/${problem}/events.json?since=${since}&limit=2`),
    );
    seen.push(...body.events.map((event) => event.seq));
    since = body.page_end.next_cursor;
    lastThrough = body.page_end.through;
    if (!body.page_end.has_more) break;
  }
  assert.deepEqual(
    seen,
    [...seen].sort((a, b) => a - b),
    "tail pages are ordered",
  );
  assert.equal(new Set(seen).size, seen.length, "no event appears twice across pages");
  assert.deepEqual(
    seen,
    Array.from({ length: seen.length }, (_, i) => i + 1),
    "no gaps",
  );
  // No per-problem /p/:id/cursor route exists yet; the page's `through` is authoritative.
  assert.equal(seen.length, lastThrough, "the tail reaches the problem's public sequence");

  // (Runs after the tail section: sessions opened before a revision refuse
  // promotion with STATEMENT_REVISED_SINCE until they re-anchor.)
  // A real statement revision reaches the follower as a statement_revision
  // notice. Members are recipients too (event-delivery.ts RECIPIENT_SQL), so
  // the negative case is a Fellow that neither follows nor joined.
  const stranger = await enroll("stoa-surface-stranger", "usr_stoa_stranger");
  // A follower that never joined, so only follow routing can reach it.
  const followerOnly = await enroll("stoa-surface-follower", "usr_stoa_follower");
  assert.equal(
    ProblemFollowResponseSchema.parse(await call(`/v1/p/${problem}/follow`, {}, followerOnly))
      .following,
    true,
  );
  await sponsorCall(
    "usr_stoa_author",
    "POST",
    `/v1/sponsors/problems/${problem}/lifecycle`,
    "problem-lifecycle",
    {
      action: "revise-statement",
      statement: "Every integer in 0..600 has a square of the same parity.",
      falsifier: "An integer in 0..600 whose square has the opposite parity.",
      motivation: "A widened range for followers.",
    },
  );
  assert.equal((await fixtures.deliverInboxTick()).failed, 0);
  const revisionNotices = (await inbox(followerOnly)).items.filter(
    (item) => item.type === "statement_revision" && item.problem_id === problem,
  );
  assert.equal(
    revisionNotices.length,
    1,
    "a follower that never joined is told once about the revision",
  );
  assert.ok(
    !(await inbox(stranger)).items.some((item) => item.type === "statement_revision"),
    "a Fellow that neither follows nor joined gets no revision notice",
  );

  // --- Triage and next read real state for the author. ---
  const triage = TriageResponseSchema.parse(await call("/v1/triage", undefined, author));
  assert.ok(triage);
  const next = await call(`/v1/p/${problem}/next`, undefined, author);
  assert.equal(typeof next, "object");
  assert.equal(
    (await call(`/v1/p/${problem}/next`, undefined, "asimp_ag_not_a_real_token", 401)).code,
    "FELLOW_TOKEN_INVALID",
  );

  console.log(
    JSON.stringify({
      stage: "stoa-surface-journey-passed",
      kind: "stoa-surface-real-bindings",
      status: "pass",
      inbox_notice: fresh[0].type,
      tail_events: seen.length,
      boundary: "local Workerd/D1/R2; inbox delivery by one cron-tick call; fixture screening",
    }),
  );
});
