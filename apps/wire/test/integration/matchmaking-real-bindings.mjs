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
// Fable §7 delivers review requests through the recipient's inbox (asserted
// here); hello and triage do not carry them by design.
// Not covered: live multi-sponsor behaviour.

await runLocalWorkerJourney(
  async ({ call, enroll, sponsorCall, operatorCall, worker, origin, userAgent, env }) => {
    const OWNER = "usr_match_owner";
    const author = await enroll("match-author", OWNER);
    // Enrolled first so it sorts first by Fellow ID among the candidates.
    const sameSponsor = await enroll("match-same-sponsor", OWNER);
    const sameFamily = await enroll("match-same-family", "usr_match_same_family");
    const eligible = await enroll("match-eligible", "usr_match_eligible");
    const outsider = await enroll("match-outsider", "usr_match_outsider");
    const hello = async (token) =>
      (await call("/v1/hello", undefined, token, 200)).fellow.fellow_id;
    const eligibleId = await hello(eligible);

    for (const unlisted of [false, true]) {
      const created = await call(
        "/v1/problems",
        {
          title: unlisted ? "Scoped review coordination" : "Matchmaking problem",
          statement: unlisted
            ? "For every integer n, n + 2 = 2 + n."
            : "For all natural numbers n, n + 0 = n.",
          falsifier: unlisted
            ? "An integer n for which n + 2 differs from 2 + n."
            : "A natural number n such that n + 0 !== n.",
          motivation: "Exercise review matchmaking.",
          areas: ["number-theory"],
          unlisted,
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
      if (unlisted) {
        // Existing sponsor-approved Fellows receive explicit scoped membership.
        // Merely knowing this problem URL must not create a reviewer admission.
        for (const token of [sameSponsor, sameFamily, eligible]) {
          await sponsorCall(
            OWNER,
            "POST",
            `/v1/sponsors/problems/${problem}/lifecycle`,
            "problem-lifecycle",
            {
              action: "manage-member",
              operation: "set-role",
              target_fellow_id: await hello(token),
              role: "contributor",
            },
          );
        }
        await call(`/v1/p/${problem}/review-requests`, undefined, outsider, 404);
        const globalReviews = await call("/reviews.json");
        assert.ok(
          !JSON.stringify(globalReviews).includes(problem),
          "unlisted work stays out of global discovery",
        );
      }
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
      let authorSession;
      const declare = async (token, family, statement, existing) => {
        const session =
          existing ??
          (await call("/v1/sessions", { problem_id: problem, intent: "prove" }, token, 201))
            .session_id;
        if (token === author) authorSession = session;
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
      assert.equal(
        requested.reviewer_id,
        eligibleId,
        "the one different-family, other-sponsor member",
      );
      assert.notEqual(
        requested.reviewer_id,
        await hello(sameSponsor),
        "never the author's sponsor",
      );
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
          (notice) =>
            (notice.notice_type ?? notice.type) === "review_request" &&
            notice.problem_id === problem,
        );
      };
      const delivered = await inboxOf(eligible);
      assert.equal(
        delivered.length,
        1,
        `recipient inbox: ${JSON.stringify(delivered).slice(0, 300)}`,
      );
      assert.ok(
        JSON.stringify(delivered[0]).includes(requested.request_id),
        "the notice links the exact request",
      );
      assert.equal((await inboxOf(sameFamily)).length, 0);
      assert.equal((await inboxOf(sameSponsor)).length, 0);

      // A decline reaches the author as its own notice type, linking the exact
      // request, and nobody else (1e7 review_decline).
      await call(
        `/v1/p/${problem}/review-requests/${requested.request_id}/respond`,
        { action: "decline", expected_version: requested.version },
        eligible,
        200,
      );
      const declinesOf = async (token) =>
        (await call("/v1/inbox", undefined, token, 200)).items.filter(
          (notice) => notice.type === "review_decline" && notice.problem_id === problem,
        );
      const declines = await declinesOf(author);
      assert.equal(declines.length, 1, "the author is told once that the reviewer declined");
      assert.ok(JSON.stringify(declines[0]).includes(requested.request_id));
      assert.ok(declines[0].next_actions?.[0]?.url.includes(requested.request_id));
      for (const other of [eligible, sameFamily, sameSponsor]) {
        assert.equal((await declinesOf(other)).length, 0, "no one else hears of the decline");
      }

      if (unlisted) {
        const nextTarget = await declare(
          author,
          "gpt",
          "For every integer n, n + 2 equals 2 + n.",
          authorSession,
        );
        const path = `/v1/p/${problem}/review-requests`;
        const offerBody = { claim_id: nextTarget, claim_version: 1, match: "different-family" };
        const invitation = await call(path, offerBody, author, 201, "unlisted-match-offer");
        assert.equal(invitation.reviewer_id, eligibleId);
        const requestPath = `${path}/${invitation.request_id}`;
        await call(requestPath, undefined, outsider, 404);
        await call(requestPath, undefined, sameFamily, 404);
        const response = await worker.fetch(`${origin}${requestPath}`, {
          headers: { authorization: `Bearer ${eligible}`, "User-Agent": userAgent },
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "private, no-store");
        assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
        await response.arrayBuffer();

        const privateCanary = "PRIVATE_AUTHOR_REVIEW_ISOLATION_CANARY";
        await call(
          `/v1/sessions/${authorSession}/workshop`,
          {
            type: "note",
            title: "Private author reasoning",
            body_md: privateCanary,
          },
          author,
          201,
        );
        const incomingPack = await call(
          `/v1/sessions/${reviewSession}/pack?profile=review-queue&max_tokens=8000`,
          undefined,
          eligible,
        );
        assert.ok(
          incomingPack.items.some(
            (item) => item.kind === "review-invitation" && item.id === invitation.request_id,
          ),
        );
        assert.ok(!JSON.stringify(incomingPack).includes(privateCanary));

        const controlTarget = (action) =>
          operatorCall("POST", "/v1/operators/content-control", "operator.content.control", {
            target_id: `${problem}/${nextTarget}`,
            target_kind: "claim",
            action,
            reason:
              "Scoped review lane: verify current claim controls before accepting an invitation.",
          });
        await controlTarget("hide");
        const hidden = await call(requestPath, undefined, eligible);
        assert.equal(hidden.effective_status, "target-unavailable");
        assert.ok(!hidden.next_actions.some((action) => action.url.includes("/claims/")));
        await call(
          `${requestPath}/respond`,
          { action: "accept", expected_version: 1 },
          eligible,
          401,
          "hidden-unlisted-accept",
        );
        assert.deepEqual(
          await call(path, offerBody, author, 201, "unlisted-match-offer"),
          invitation,
        );
        await controlTarget("restore");
        const accepted = await call(
          `${requestPath}/respond`,
          { action: "accept", expected_version: 1 },
          eligible,
          200,
          "unlisted-accept",
        );
        assert.equal(accepted.status, "accepted");
        const isolatedPack = await call(
          `/v1/sessions/${reviewSession}/pack?profile=review&target=${nextTarget}@1&max_tokens=8000`,
          undefined,
          eligible,
        );
        assert.ok(!JSON.stringify(isolatedPack).includes(privateCanary));
        const review = await call(
          `/v1/sessions/${reviewSession}/review`,
          {
            target_claim_id: nextTarget,
            target_version: 1,
            verdict: "cannot-verify",
            basis:
              "The scoped review considered this exact statement but does not establish a full proof.",
            capable_of_failure: "An integer for which the two sums differ.",
            scientific_provenance: {
              model_family_self_declared: "claude",
              method: {
                category: "deductive",
                procedure: "Checked the statement and its available argument.",
                evidence: [],
              },
            },
            body_md:
              "The invitation supplies coordination only; the evidence available here is insufficient for a verified result.",
          },
          eligible,
          201,
        );
        assert.equal(review.tier, "T2", "independence comes from the actual review pipeline");
        const completionBody = {
          action: "complete",
          expected_version: accepted.version,
          review_id: review.review_id,
        };
        const completed = await call(
          `${requestPath}/respond`,
          completionBody,
          eligible,
          200,
          "unlisted-complete",
        );
        assert.equal(completed.status, "completed");
        const committedReview = await env.DB.prepare(
          "SELECT source_event_id FROM reviews WHERE problem_id=? AND review_id=?",
        )
          .bind(problem, review.review_id)
          .first();
        assert.equal(completed.review_event_id, committedReview.source_event_id);

        // A new invitation remains withdrawable after the steward removes the
        // recipient. Old successful receipts remain exact, but no new acceptance
        // or unlisted read is granted by the old request URL.
        const lastTarget = await declare(
          author,
          "gpt",
          "For every integer n, n + 3 equals 3 + n.",
          authorSession,
        );
        const pending = await call(
          path,
          { claim_id: lastTarget, claim_version: 1, reviewer_id: eligibleId },
          author,
          201,
        );
        await sponsorCall(
          OWNER,
          "POST",
          `/v1/sponsors/problems/${problem}/lifecycle`,
          "problem-lifecycle",
          {
            action: "manage-member",
            operation: "remove",
            target_fellow_id: eligibleId,
          },
        );
        await call(`${path}/${pending.request_id}`, undefined, eligible, 404);
        await call(
          `${path}/${pending.request_id}/respond`,
          { action: "accept", expected_version: 1 },
          eligible,
          404,
        );
        assert.deepEqual(
          await call(`${requestPath}/respond`, completionBody, eligible, 200, "unlisted-complete"),
          completed,
        );
        const declinedAfterRemoval = await call(
          `${path}/${pending.request_id}/respond`,
          { action: "decline", expected_version: 1 },
          eligible,
        );
        assert.equal(declinedAfterRemoval.status, "declined");
        assert.ok(!JSON.stringify(await call("/reviews.json")).includes(problem));
      }
    }

    console.log(
      JSON.stringify({
        stage: "matchmaking-journey-passed",
        kind: "matchmaking-real-bindings",
        status: "pass",
        boundary:
          "real local Workerd/D1; listed and unlisted matching, scoped membership, private inbox and pack, hide/restore, screened review and completion, immutable replay and decline after membership removal; no live production claim",
      }),
    );
  },
);
