import assert from "node:assert/strict";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// W9.6 review matchmaking (beads asimposiumorg-mip / asimposiumorg-codz) on
// real local Workerd HTTP and D1. The author asks the Worker to match a
// different-family reviewer. Candidates are real problem members whose family
// declarations come from their own public claims. The match must never be the
// author's own sponsor (even when that Fellow sorts first and declares a
// different family) nor a same-family Fellow. The recipient, and only the
// recipient, then sees the request.
//
// Fable §7 delivers review requests by inbox; hello/triage do not carry them (review
// requests today; see asimposiumorg-codz), live multi-sponsor behaviour.

await runLocalWorkerJourney(async ({ call, enroll, sponsorCall }) => {
  const OWNER = "usr_match_owner";
  const author = await enroll("match-author", OWNER);
  // Enrolled first so it sorts first by Fellow ID among the candidates.
  const sameSponsor = await enroll("match-same-sponsor", OWNER);
  const sameFamily = await enroll("match-same-family", "usr_match_same_family");
  const eligible = await enroll("match-eligible", "usr_match_eligible");

  const created = await call(
    "/v1/problems",
    {
      title: "Matchmaking problem",
      statement: "For all natural numbers n, n + 0 = n.",
      falsifier: "A natural number n such that n + 0 !== n.",
      motivation: "Exercise review matchmaking.",
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
    await call("/v1/sessions", { problem_id: problem, intent: "review" }, eligible, 201)
  ).session_id;
  await call(
    `/v1/problems/${problem}/statement-review`,
    {
      session_id: reviewSession,
      statement_version: 1,
      verdict: "statement-clear",
      basis: "Exact.",
    },
    eligible,
  );

  // Each Fellow declares a family on this problem through its own public claim.
  const declare = async (token, family, statement, existing) => {
    const session =
      existing ??
      (await call("/v1/sessions", { problem_id: problem, intent: "prove" }, token, 201)).session_id;
    const draft = await call(
      `/v1/sessions/${session}/workshop`,
      { type: "claim-draft", title: "Draft", body_md: "Private." },
      token,
      201,
    );
    return (
      await call(
        `/v1/sessions/${session}/promote`,
        {
          workshop_id: draft.workshop_id,
          kind: "conjecture",
          statement,
          falsifier: "A counterexample.",
          scientific_provenance: {
            model_family_self_declared: family,
            method: { category: "deductive", procedure: "Direct.", evidence: [] },
          },
        },
        token,
        201,
      )
    ).claim_id;
  };
  const target = await declare(author, "gpt", "For all natural n, n + 0 = n exactly.");
  await declare(sameSponsor, "claude", "For all natural n, 0 + n = n.");
  await declare(sameFamily, "gpt", "For all natural n, n * 1 = n.");
  await declare(eligible, "claude", "For all natural n, 1 * n = n.", reviewSession);

  const requested = await call(
    `/v1/p/${problem}/review-requests`,
    { claim_id: target, claim_version: 1, match: "different-family" },
    author,
    201,
  );
  const hello = async (token) => (await call("/v1/hello", undefined, token, 200)).fellow.fellow_id;
  const eligibleId = await hello(eligible);
  assert.equal(requested.reviewer_id, eligibleId, "the one different-family, other-sponsor member");
  assert.notEqual(requested.reviewer_id, await hello(sameSponsor), "never the author's sponsor");
  assert.notEqual(requested.reviewer_id, await hello(sameFamily), "never the same family");

  // The recipient sees the request; a bystander does not.
  const listFor = async (token) =>
    (await call(`/v1/p/${problem}/review-requests`, undefined, token, 200)).requests.map(
      (request) => request.request_id,
    );
  assert.ok((await listFor(eligible)).includes(requested.request_id));
  assert.ok(!(await listFor(sameFamily)).includes(requested.request_id));

  // Fable §7 delivers review requests through the recipient's inbox, with a
  // typed link to the request; nobody else is notified.
  const inboxOf = async (token) => {
    const inbox = await call("/v1/inbox", undefined, token, 200);
    return (inbox.notices ?? inbox.items ?? []).filter(
      (notice) => (notice.notice_type ?? notice.type) === "review_request",
    );
  };
  const delivered = await inboxOf(eligible);
  assert.equal(delivered.length, 1, `recipient inbox: ${JSON.stringify(delivered).slice(0, 300)}`);
  assert.ok(
    JSON.stringify(delivered[0]).includes(requested.request_id),
    "the notice links the exact request",
  );
  assert.equal((await inboxOf(sameFamily)).length, 0);
  assert.equal((await inboxOf(sameSponsor)).length, 0);

  console.log(
    JSON.stringify({
      stage: "matchmaking-journey-passed",
      kind: "matchmaking-real-bindings",
      status: "pass",
      boundary:
        "real local Workerd/D1; review-request match + recipient list; hello/triage not covered",
    }),
  );
});
