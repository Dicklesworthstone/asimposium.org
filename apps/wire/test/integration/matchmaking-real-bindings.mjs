import assert from "node:assert/strict";
import { readProblemReviewFeedback } from "../../src/sessions/review-feedback.ts";
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
      assert.equal(
        delivered[0].expires_at,
        requested.expires_at,
        "an offer expires with its invitation",
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
      assert.equal(
        declines[0].expires_at,
        null,
        "a terminal update outlives the old offer deadline",
      );
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

    // Feedback is a bounded historical observation in an actual NEW receipt,
    // not a forecast or a standing/tier signal. All original journeys above run.
    {
      // Fresh Fellows respect the ordinary global open-session cap; the original
      // unlisted membership-removal story keeps its historical sessions intact.
      const author = await enroll("feedback-author", OWNER);
      const eligible = await enroll("feedback-reviewer", "usr_match_eligible");
      const sameSponsor = await enroll("feedback-same-sponsor", OWNER);
      const feedbackProblem = (
        await call(
          "/v1/problems",
          {
            title: "Observed review timing",
            statement: "For every natural n, n + 0 = n.",
            falsifier: "A natural n with a different sum.",
            motivation: "Observe version-pinned feedback without predicting a wait.",
            areas: ["number-theory"],
          },
          sameFamily,
          201,
        )
      ).problem.id;
      assert.equal(
        await readProblemReviewFeedback(env.DB, feedbackProblem),
        null,
        "private draft has no public observation",
      );
      await sponsorCall(
        "usr_match_same_family",
        "POST",
        `/v1/sponsors/problems/${feedbackProblem}/lifecycle`,
        "problem-lifecycle",
        { action: "publish" },
      );
      const feedbackReviewSession = (
        await call("/v1/sessions", { problem_id: feedbackProblem, intent: "review" }, eligible, 201)
      ).session_id;
      await call(
        `/v1/problems/${feedbackProblem}/statement-review`,
        {
          session_id: feedbackReviewSession,
          statement_version: 1,
          verdict: "statement-clear",
          basis: "Exact natural-number identity.",
        },
        eligible,
      );
      const feedbackSession = (
        await call("/v1/sessions", { problem_id: feedbackProblem, intent: "prove" }, author, 201)
      ).session_id;
      const post = async (path, data, key, token = author, status = 201) => {
        const response = await worker.fetch(`${origin}${path}`, {
          method: "POST",
          headers: {
            "User-Agent": userAgent,
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "idempotency-key": key,
          },
          body: JSON.stringify(data),
        });
        const text = await response.text();
        const value = JSON.parse(text);
        assert.equal(response.status, status, `${path}: ${value.code ?? "receipt"}`);
        assert.equal(response.headers.get("cache-control"), "private, no-store");
        return { text, value };
      };
      let nextDraft = 0;
      const draft = () =>
        call(
          `/v1/sessions/${feedbackSession}/workshop`,
          {
            type: "claim-draft",
            title: `Observed work ${++nextDraft}`,
            body_md: "Private workshop timing canary, excluded from feedback.",
          },
          author,
          201,
        );
      const claim = (statement) => ({
        kind: "conjecture",
        statement,
        falsifier: "A natural number outside the stated equality.",
      });
      const firstData = {
        ...claim("For every natural n, n + 0 = n exactly."),
        workshop_id: (await draft()).workshop_id,
      };
      const firstPath = `/v1/sessions/${feedbackSession}/promote`;
      const first = await post(firstPath, firstData, "feedback-first");
      assert.ok(
        first.value.review_feedback,
        "ordinary promotion carries an observed review-feedback receipt",
      );
      assert.equal(first.value.review_feedback.sampled_versions, 0);
      assert.equal(first.value.review_feedback.median_first_review_seconds, null);
      assert.ok(
        first.value.review_feedback.through_seq < first.value.seq,
        "history cut is persisted D1, not predicted new publication",
      );
      const reviewData = {
        target_claim_id: first.value.claim_id,
        target_version: 1,
        verdict: "cannot-verify",
        basis: "The exact argument remains incomplete.",
        capable_of_failure: "A natural number for which the sum differs.",
        body_md: "The statement is precise; this review does not establish a proof.",
      };
      const selfReview = await call(
        `/v1/sessions/${feedbackSession}/review`,
        reviewData,
        author,
        422,
      );
      assert.equal(selfReview.code, "REVIEWER_IS_AUTHOR");
      const firstReview = await call(
        `/v1/sessions/${feedbackReviewSession}/review`,
        reviewData,
        eligible,
        201,
      );
      const clocks =
        await env.DB.prepare(`SELECT p.created_at AS published_at, r.created_at AS reviewed_at
      FROM events p JOIN events r ON r.problem_id=p.problem_id
      WHERE p.problem_id=? AND p.object_id=? AND p.type='claim.created'
        AND r.object_id=? AND r.type='review.created'`)
          .bind(feedbackProblem, first.value.claim_id, firstReview.review_id)
          .first();
      const expectedSeconds =
        (Date.parse(clocks.reviewed_at) - Date.parse(clocks.published_at)) / 1000;
      assert.ok(Number.isFinite(expectedSeconds) && expectedSeconds >= 0);
      const direct = await post(
        `/v1/p/${feedbackProblem}/claims`,
        claim("For every natural n, 0 + n = n."),
        "feedback-direct",
      );
      assert.ok(
        direct.value.review_feedback,
        "implicit direct claim uses the same feedback consumer",
      );
      assert.equal(direct.value.review_feedback.sampled_versions, 1);
      assert.equal(direct.value.review_feedback.reviewed_versions, 1);
      assert.equal(direct.value.review_feedback.median_first_review_seconds, expectedSeconds);
      assert.equal(
        (await post(firstPath, firstData, "feedback-first", author, 200)).text,
        first.text,
        "later review never recomputes stored replay bytes",
      );

      const sameSponsorSession = (
        await call(
          "/v1/sessions",
          { problem_id: feedbackProblem, intent: "review" },
          sameSponsor,
          201,
        )
      ).session_id;
      const laterReview = await call(
        `/v1/sessions/${sameSponsorSession}/review`,
        {
          ...reviewData,
          body_md: "A later non-author check with no added sponsorship independence.",
        },
        sameSponsor,
        201,
      );
      assert.equal(laterReview.tier, "T0");
      await call(
        `/v1/sessions/${feedbackSession}/revise`,
        {
          ...claim("For every natural n, n + 0 equals n exactly."),
          claim_id: first.value.claim_id,
          base_version: 1,
        },
        author,
        201,
      );
      const members = [
        {
          tempId: "tmp:feedback-a",
          action: "claim",
          data: claim("For every natural n, n times 1 equals n."),
        },
        {
          tempId: "tmp:feedback-b",
          action: "claim",
          data: claim("For every natural n, 1 times n equals n."),
        },
      ];
      const batch = await post(
        `/v1/p/${feedbackProblem}/events:batch`,
        { members },
        "feedback-batch",
      );
      assert.equal(batch.value.results.length, 2);
      for (const member of batch.value.results) {
        assert.ok(
          member.review_feedback,
          "atomic claim member carries its exact ordinary feedback receipt",
        );
        assert.equal(member.review_feedback.median_first_review_seconds, expectedSeconds);
        assert.equal(member.review_feedback.sampled_versions, 3);
      }
      const afterRevision = await post(
        firstPath,
        {
          ...claim("For every natural n, n plus zero equals n."),
          workshop_id: (await draft()).workshop_id,
        },
        "feedback-version-probe",
      );
      assert.equal(afterRevision.value.review_feedback.sampled_versions, 5);
      assert.equal(
        afterRevision.value.review_feedback.reviewed_versions,
        1,
        "v1 review does not credit revised v2",
      );
      assert.equal(afterRevision.value.review_feedback.unreviewed_versions, 4);
      assert.equal(
        afterRevision.value.review_feedback.median_first_review_seconds,
        expectedSeconds,
        "later review does not replace first review by sequence",
      );

      const controlReview = (id, action) =>
        operatorCall("POST", "/v1/operators/content-control", "operator.content.control", {
          target_id: `${feedbackProblem}/${id}`,
          target_kind: "review",
          action,
          reason: "Verify current review visibility before observing feedback.",
        });
      await controlReview(firstReview.review_id, "hide");
      await controlReview(laterReview.review_id, "hide");
      const noReadableReview = await post(
        firstPath,
        {
          ...claim("For every natural n, zero plus n equals n."),
          workshop_id: (await draft()).workshop_id,
        },
        "feedback-hidden-reviews",
      );
      assert.equal(noReadableReview.value.review_feedback.reviewed_versions, 0);
      assert.equal(
        noReadableReview.value.review_feedback.median_first_review_seconds,
        null,
        "hidden reviews do not become public timing evidence",
      );
      assert.ok(noReadableReview.value.review_feedback.omitted.includes("content_unavailable"));
      assert.equal(
        (
          await post(
            `/v1/p/${feedbackProblem}/events:batch`,
            { members },
            "feedback-batch",
            author,
            200,
          )
        ).text,
        batch.text,
      );
      assert.equal(
        (await post(firstPath, firstData, "feedback-first", author, 200)).text,
        first.text,
      );
      await controlReview(firstReview.review_id, "restore");
      await operatorCall("POST", "/v1/operators/content-control", "operator.content.control", {
        target_id: `${feedbackProblem}/${first.value.claim_id}`,
        target_kind: "claim",
        action: "hide",
        reason: "Verify hidden claim versions do not contribute review timing.",
      });
      const hiddenClaim = await post(
        firstPath,
        {
          ...claim("For every natural n, the sum of n and zero equals n."),
          workshop_id: (await draft()).workshop_id,
        },
        "feedback-hidden-claim",
      );
      assert.equal(hiddenClaim.value.review_feedback.reviewed_versions, 0);
      assert.equal(hiddenClaim.value.review_feedback.median_first_review_seconds, null);
      assert.ok(hiddenClaim.value.review_feedback.omitted.includes("content_unavailable"));
      await operatorCall("POST", "/v1/operators/content-control", "operator.content.control", {
        target_id: `${feedbackProblem}/${first.value.claim_id}`,
        target_kind: "claim",
        action: "restore",
        reason: "Restore the observed claim after the timing visibility control.",
      });

      const typedDraft = await call(
        `/v1/sessions/${feedbackSession}/workshop`,
        {
          type: "claim-draft",
          title: "Sponsor promotes stored work",
          ledger_intent: { kind: "create", target_kind: "claim" },
          body_md: "Private sponsor promotion body.",
          publication: {
            kind: "conjecture",
            statement: "For every natural n, n multiplied by one equals n.",
            falsifier: "A natural number with a different product.",
            relates_to: [],
            depends_on: [],
          },
        },
        author,
        201,
      );
      const sponsorReceipt = await sponsorCall(
        OWNER,
        "POST",
        "/v1/sponsors/workshop/action",
        "workshop.action",
        {
          problem_id: feedbackProblem,
          fellow_id: await hello(author),
          workshop_id: typedDraft.workshop_id,
          expected_workshop_version: typedDraft.version,
          action: "promote",
        },
        201,
      );
      assert.ok(
        sponsorReceipt.promotion.review_feedback,
        "sponsor promotion preserves the Fellow receipt observation",
      );
      assert.equal(
        sponsorReceipt.promotion.review_feedback.median_first_review_seconds,
        expectedSeconds,
      );
      console.log(
        JSON.stringify({
          stage: "observed-review-feedback-passed",
          boundary:
            "real local receipts and immutable event clocks; descriptive bounded history, not a forecast or standing change",
        }),
      );
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
