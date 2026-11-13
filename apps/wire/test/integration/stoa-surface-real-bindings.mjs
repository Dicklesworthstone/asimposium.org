import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  ClaimFaceResponseSchema,
  EnrollmentHelloResponseSchema,
  InboxAckResponseSchema,
  InboxResponseSchema,
  ProblemCodeSchema,
  ProblemFollowResponseSchema,
  ProblemNextResponseSchema,
  PromoteRequestSchema,
  PromoteResponseSchema,
  TriageResponseSchema,
} from "@asimposium/contracts";
import { EventTailResponseSchema } from "../../../../packages/contracts/src/event-tail.ts";
import { ProblemDocumentSchema } from "../../../../packages/contracts/src/problem.ts";
import {
  CursorResponseSchema,
  SessionOpenRequestSchema,
  SessionOpenResponseSchema,
  SessionStatusResponseSchema,
  WorkshopObjectResponseSchema,
} from "../../../../packages/contracts/src/sessions.ts";
import { createInboxNotice } from "../../src/inbox/store.ts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// W6 Stoa surface on real Workerd HTTP, D1 and R2 (bead asimposiumorg-lu59):
// inbox notices CAUSED by committed ledger writes (delivered by one tick of the
// production cron consumer), acknowledgement, follows, event tails paged over
// concurrently committed events, and triage/next. Synthetic screening and
// sponsor approval come from the shared harness; no deployment claim.
await runLocalWorkerJourney(
  async ({
    call,
    enroll,
    sponsorCall,
    reviseStatement,
    fixtures,
    env,
    worker,
    origin,
    userAgent,
  }) => {
    const protocolSource = await readFile(
      new URL("../../../../packages/protocol/assets/protocol.md", import.meta.url),
      "utf8",
    );
    const protocolMd = await worker.fetch(`${origin}/protocol.md`, {
      headers: { "User-Agent": userAgent },
    });
    assert.equal(protocolMd.status, 200);
    assert.equal(await protocolMd.text(), protocolSource, "native protocol Markdown is canonical");
    const protocolJson = await worker.fetch(`${origin}/protocol.json`, {
      headers: { "User-Agent": userAgent },
    });
    assert.equal(protocolJson.status, 200);
    const protocol = await protocolJson.json();
    const protocolDigest = createHash("sha256").update(protocolSource).digest("hex");
    assert.equal(protocol.version, "0.1.2-draft");
    assert.equal(protocol.digest, protocolDigest);
    assert.deepEqual(
      protocol.hard_rules.map((rule) => rule.code),
      Array.from({ length: 13 }, (_, index) => `P${index + 1}`),
    );
    assert.equal(protocol.hard_rules[0].title, "Keep reviews independent.");
    assert.equal(protocol.hard_rules[12].title, "Anchor syntheses in the ledger.");
    assert.match(
      protocol.preamble,
      /An unlisted problem is public and may be named in a duplicate-proposal refusal/,
    );
    assert.match(
      protocol.preamble,
      /Never-published wording from\s+another sponsor's draft is excluded/,
    );
    assert.match(protocol.hard_rules[3].rule, /review state contested/);
    assert.match(protocol.hard_rules[3].rule, /same sponsor or without verification weight/);
    assert.match(protocol.hard_rules[3].rule, /Disposition follows the weighted\s+record/);
    for (const [path, response] of [
      ["/protocol.md", protocolMd],
      ["/protocol.json", protocolJson],
    ]) {
      const etag = response.headers.get("etag");
      assert.ok(etag, `${path} has an ETag`);
      const cached = await worker.fetch(`${origin}${path}`, {
        headers: { "User-Agent": userAgent, "If-None-Match": etag },
      });
      assert.equal(cached.status, 304, `${path} conditional GET`);
      assert.equal(await cached.text(), "");
    }
    const author = await enroll("stoa-surface-author", "usr_stoa_author");
    const reviewer = await enroll("stoa-surface-reviewer", "usr_stoa_reviewer");
    const second = await enroll("stoa-surface-second", "usr_stoa_second");
    const expiryReader = await enroll("stoa-expiry-reader", "usr_stoa_expiry");
    const expiryFellow = (await call("/v1/hello", undefined, expiryReader)).fellow.fellow_id;
    const noticeTime = Date.now();
    const expiredInput = {
      id: "NOT-stoa-expired",
      fellowId: expiryFellow,
      noticeType: "protocol_notice",
      title: "Expired inbox action canary",
      createdAt: noticeTime - 2000,
      expiresAt: noticeTime - 1000,
    };
    const expiredNotice = await createInboxNotice(env.DB, expiredInput);
    const liveNotice = await createInboxNotice(env.DB, {
      ...expiredInput,
      id: "NOT-stoa-live",
      title: "Current inbox action canary",
      expiresAt: noticeTime + 3600000,
    });
    const permanentNotice = await createInboxNotice(env.DB, {
      ...expiredInput,
      id: "NOT-stoa-permanent",
      title: "Persistent inbox update canary",
      expiresAt: null,
    });
    const expiryPage = InboxResponseSchema.parse(
      await call("/v1/inbox?limit=1", undefined, expiryReader),
    );
    assert.deepEqual(
      expiryPage.items.map((item) => item.id),
      [liveNotice.id],
    );
    assert.equal(expiryPage.unacknowledged_count, 2);
    assert.equal(expiryPage.next_cursor, liveNotice.seq);
    assert.equal(expiryPage.has_more, true, "expiry is filtered before pagination");
    const expiryNext = await call(`/v1/inbox?since=${liveNotice.seq}`, undefined, expiryReader);
    assert.deepEqual(
      expiryNext.items.map((item) => item.id),
      [permanentNotice.id],
    );
    const expiredAck = await call(
      "/v1/inbox/ack",
      { notice_ids: [expiredNotice.id] },
      expiryReader,
    );
    assert.deepEqual(expiredAck, { acknowledged_count: 0, unacknowledged_count: 2 });
    const expiryBulkAck = await call(
      "/v1/inbox/ack",
      { until_seq: permanentNotice.seq },
      expiryReader,
    );
    assert.deepEqual(expiryBulkAck, { acknowledged_count: 2, unacknowledged_count: 0 });
    assert.deepEqual(
      await env.DB.prepare("SELECT acknowledged_at FROM fellow_inbox_notices WHERE id = ?")
        .bind(expiredNotice.id)
        .first(),
      { acknowledged_at: null },
    );
    assert.deepEqual(
      await createInboxNotice(env.DB, {
        ...expiredInput,
        createdAt: noticeTime + 1,
        expiresAt: noticeTime + 3600000,
      }),
      expiredNotice,
      "an original expired receipt is not renewed by a delivery retry",
    );
    const expiryMarkdown = await worker.fetch(`${origin}/v1/inbox.md`, {
      headers: { "User-Agent": userAgent, authorization: `Bearer ${expiryReader}` },
    });
    assert.equal(expiryMarkdown.status, 200);
    assert.equal(expiryMarkdown.headers.get("cache-control"), "private, no-store");
    assert.ok(!(await expiryMarkdown.text()).includes(expiredInput.title));
    const laterNotice = await createInboxNotice(env.DB, {
      ...expiredInput,
      id: "NOT-stoa-later",
      title: "Later inbox update canary",
      expiresAt: null,
    });
    assert.equal(laterNotice.seq, permanentNotice.seq + 1, "expired history retains its cursor");
    assert.equal(
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM fellow_inbox_notices WHERE fellow_id = ?")
          .bind(expiryFellow)
          .first()
      ).n,
      4,
      "expiry does not delete notice history",
    );
    console.log(JSON.stringify({ stage: "inbox-expiry", retained: 4, expired: 1 }));
    // The existing scheduler returns the actual D1 notice page, then commits
    // credential revocation before the route can release the selected page.
    // No fabricated row, authentication response or production switch is used.
    for (const [index, path] of ["/v1/inbox", "/v1/inbox.md"].entries()) {
      const reader = await enroll(`stoa-revoked-reader-${index}`, `usr_stoa_revoked_${index}`);
      const fellowId = (await call("/v1/hello", undefined, reader)).fellow.fellow_id;
      const notice = await createInboxNotice(env.DB, {
        fellowId,
        noticeType: "protocol_notice",
        title: `PRIVATE_INBOX_REVOKED_CANARY_${index}`,
      });
      const read = () =>
        worker.fetch(`${origin}${path}`, {
          headers: { "User-Agent": userAgent, authorization: `Bearer ${reader}` },
        });
      const control = await read();
      assert.equal(control.status, 200);
      assert.ok((await control.text()).includes(notice.title));
      await fixtures.armRaceAfterNextRead(
        "UPDATE fellow_tokens SET revoked_at = ? WHERE fellow_id = ? AND revoked_at IS NULL",
        [Date.now(), fellowId],
        "FROM fellow_inbox_notices",
      );
      const raced = await read();
      assert.equal(await fixtures.raceStillArmed(), false, "real credential revocation fired");
      assert.ok(
        (
          await env.DB.prepare("SELECT revoked_at FROM fellow_tokens WHERE fellow_id = ?")
            .bind(fellowId)
            .first()
        ).revoked_at !== null,
      );
      assert.equal(raced.status, 401, "an in-flight inbox read loses revoked authority");
      assert.equal(raced.headers.get("cache-control"), "private, no-store");
      assert.equal(raced.headers.get("etag"), null);
      const text = await raced.text();
      assert.ok(!text.includes(notice.title));
      assert.ok(!text.includes(notice.id));
      assert.ok(!text.includes("unacknowledged_count"));
      assert.equal(ProblemDocumentSchema.parse(JSON.parse(text)).code, "FELLOW_TOKEN_INVALID");
      assert.equal((await read()).status, 401, "the revoked credential stays rejected");
    }
    console.log(JSON.stringify({ stage: "inbox-current-authority", formats: 2, revoked: 2 }));
    for (const [index, path] of ["/v1/inbox", "/v1/inbox.md"].entries()) {
      const reader = await enroll(`stoa-private-reader-${index}`, `usr_stoa_private_${index}`);
      const fellowId = (await call("/v1/hello", undefined, reader)).fellow.fellow_id;
      const problemId = `P-INBOX-PRIVATE-${index}`;
      await fixtures.seedProblem(problemId);
      await env.DB.prepare("UPDATE problems SET status = 'private-draft' WHERE id = ?")
        .bind(problemId)
        .run();
      const accountNotice = await createInboxNotice(env.DB, {
        fellowId,
        noticeType: "protocol_notice",
        title: "A current account notice",
      });
      const privateNotice = await createInboxNotice(env.DB, {
        fellowId,
        problemId,
        noticeType: "protocol_notice",
        title: `PRIVATE_INBOX_MEMBERSHIP_CANARY_${index}`,
      });
      for (const location of ["lookahead", "selected notice"]) {
        await env.DB.prepare(
          "INSERT INTO problem_memberships(problem_id, fellow_id, role, joined_at) VALUES (?, ?, 'contributor', ?)",
        )
          .bind(problemId, fellowId, new Date().toISOString())
          .run();
        const query = location === "lookahead" ? "?limit=1" : `?limit=1&since=${accountNotice.seq}`;
        const read = () =>
          worker.fetch(`${origin}${path}${query}`, {
            headers: { "User-Agent": userAgent, authorization: `Bearer ${reader}` },
          });
        const control = await read();
        assert.equal(control.status, 200);
        if (location === "selected notice") {
          assert.ok((await control.text()).includes(privateNotice.title));
        } else if (index === 0) {
          assert.equal((await control.json()).has_more, true);
        }
        await fixtures.armRaceAfterNextRead(
          "DELETE FROM problem_memberships WHERE problem_id = ? AND fellow_id = ?",
          [problemId, fellowId],
          "FROM fellow_inbox_notices",
        );
        const raced = await read();
        assert.equal(await fixtures.raceStillArmed(), false, "real membership loss fired");
        assert.equal(raced.status, 503, `${location} loses current private visibility`);
        assert.equal(raced.headers.get("cache-control"), "private, no-store");
        assert.equal(raced.headers.get("etag"), null);
        const text = await raced.text();
        assert.ok(!text.includes(privateNotice.title));
        assert.ok(!text.includes(privateNotice.id));
        assert.ok(!text.includes("has_more"));
        assert.ok(!text.includes("unacknowledged_count"));
        assert.equal(ProblemDocumentSchema.parse(JSON.parse(text)).code, "INTERNAL_ERROR");
        const fresh = await read();
        assert.equal(fresh.status, 200);
        assert.ok(!(await fresh.text()).includes(privateNotice.title));
      }
    }
    console.log(JSON.stringify({ stage: "inbox-current-visibility", formats: 2, raced: 4 }));
    // Follow routes consume the same problem grammar as sessions and public
    // faces, including short IDs, internal hyphens and the maximum length.
    for (const problemId of ["P-AB", "P-FOLLOW-1", `P-${"A".repeat(31)}`]) {
      await fixtures.seedProblem(problemId);
      for (const prefix of ["/v1/p", "/v1/problems"]) {
        const path = `${prefix}/${problemId}/follow`;
        const read = async (token = second) =>
          ProblemFollowResponseSchema.parse(await call(path, undefined, token));
        assert.equal((await read()).following, false);
        const followed = ProblemFollowResponseSchema.parse(await call(path, {}, second));
        assert.equal(followed.problem_id, problemId);
        assert.equal(followed.following, true);
        assert.ok(followed.followed_at > 0);
        assert.deepEqual(await read(), followed);
        assert.deepEqual(
          ProblemFollowResponseSchema.parse(await call(path, {}, second)),
          followed,
          "repeated follows retain their original preference timestamp",
        );
        assert.equal((await read(author)).following, false, "preferences remain private");
        assert.equal(
          (
            await env.DB.prepare(
              "SELECT COUNT(*) AS n FROM problem_memberships WHERE problem_id = ?",
            )
              .bind(problemId)
              .first()
          ).n,
          0,
          "an active follow grants no problem membership",
        );
        const removed = await worker.fetch(`${origin}${path}`, {
          method: "DELETE",
          headers: { "User-Agent": userAgent, authorization: `Bearer ${second}` },
        });
        assert.equal(removed.status, 200, `${path}: unfollow`);
        assert.equal(removed.headers.get("cache-control"), "private, no-store");
        const unfollowed = ProblemFollowResponseSchema.parse(await removed.json());
        assert.equal(unfollowed.problem_id, problemId);
        assert.equal(unfollowed.following, false);
        assert.equal(unfollowed.followed_at, null);
        assert.deepEqual(await read(), unfollowed);
      }
      const membership = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM problem_memberships WHERE problem_id = ?",
      )
        .bind(problemId)
        .first();
      assert.equal(membership.n, 0, "following grants no problem membership");
    }
    await fixtures.seedProblem("P-FOLLOW-PRIVATE");
    await env.DB.prepare("UPDATE problems SET status = 'private-draft' WHERE id = ?")
      .bind("P-FOLLOW-PRIVATE")
      .run();
    for (const problemId of [
      "P-FOLLOW-PRIVATE",
      "P-FOLLOW-MISSING",
      "P-A",
      "P-abcd",
      "P-BAD--ID",
      `P-${"A".repeat(32)}`,
    ]) {
      for (const prefix of ["/v1/p", "/v1/problems"]) {
        for (const method of ["GET", "POST", "DELETE"]) {
          const response = await worker.fetch(`${origin}${prefix}/${problemId}/follow`, {
            method,
            headers: { "User-Agent": userAgent, authorization: `Bearer ${second}` },
          });
          assert.equal(response.status, 404, `${method} ${prefix}/${problemId}/follow`);
          assert.equal((await response.json()).code, "PROBLEM_NOT_FOUND");
        }
      }
    }
    assert.equal(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM problem_follows").first()).n,
      0,
      "invalid, missing and private targets create no follow preferences",
    );
    console.log(JSON.stringify({ stage: "canonical-problem-follow-ids", problems: 3, aliases: 2 }));
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
      { action: "publish" },
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
    const terms = SessionStatusResponseSchema.parse(
      await call(`/v1/sessions/${authorSession}`, undefined, author),
    );
    assert.deepEqual(
      terms.provenance?.documents.protocol,
      {
        version: "0.1.2-draft",
        digest: protocolDigest,
      },
      "a new native session pins the exact protocol served to agents",
    );
    const secondSession = await open(second, "prove");
    const promote = async (token, sessionId, statement) => {
      const draft = await call(
        `/v1/sessions/${sessionId}/workshop`,
        { type: "claim-draft", title: "Draft", body_md: "Private." },
        token,
        201,
      );
      const path = `/v1/sessions/${sessionId}/promote`;
      const candidate = PromoteRequestSchema.parse({
        workshop_id: draft.workshop_id,
        kind: "conjecture",
        statement,
        falsifier: "An integer in the stated range violating the relation.",
      });
      const raw = JSON.stringify(candidate);
      const key = `stoa-promote-${randomUUID()}`;
      // Keep the concurrent publications below. A changed screening context
      // aborts this candidate; recover only that refusal with the same bytes
      // and request identity, as its server-authored fix_hint directs.
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await worker.fetch(`${origin}${path}`, {
          method: "POST",
          headers: {
            "user-agent": userAgent,
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "idempotency-key": key,
          },
          body: raw,
        });
        const body = await response.json();
        if (response.status === 409 && body?.code === "SCREENING_CONTEXT_STALE") {
          const refusal = ProblemDocumentSchema.parse(body);
          assert.equal(refusal.rule, "A5");
          assert.equal(response.headers.get("cache-control"), "private, no-store");
          assert.ok(attempt < 2, "stale-context recovery has a finite attempt limit");
          await call(`/v1/sessions/${sessionId}/pack?profile=working`, undefined, token);
          continue;
        }
        const code = ProblemCodeSchema.safeParse(body?.code);
        assert.equal(
          response.status,
          201,
          `${path}: unexpected promotion refusal code=${code.success ? code.data : "unrecognized"}`,
        );
        const receipt = PromoteResponseSchema.parse(body);
        assert.equal(receipt.problem_id, problem);
        assert.deepEqual(await call(path, candidate, token, 200, key), receipt);
        assert.equal(
          (
            await env.DB.prepare(
              "SELECT COUNT(*) AS n FROM events WHERE problem_id = ? AND object_id = ? AND type = 'claim.created'",
            )
              .bind(problem, receipt.claim_id)
              .first()
          ).n,
          1,
          "recovery and accepted replay produce exactly one publication",
        );
        return receipt;
      }
      assert.fail("a promotion must commit within its bounded recovery loop");
    };
    const claim = await promote(author, authorSession, "Zero squared is even, like zero.");

    // --- Inbox: a review caused by another Fellow reaches the claim's author. ---
    const inbox = async (token, query = "") =>
      InboxResponseSchema.parse(await call(`/v1/inbox${query}`, undefined, token));
    const before = await inbox(author);
    const recordedReview = await call(
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
    const reviewPath = `/p/${problem}/reviews/${recordedReview.review_id}.json`;
    assert.ok(
      fresh[0].next_actions?.some((action) => action.url === reviewPath),
      "a claim critique links to the exact review that caused it",
    );
    const reviewFace = ClaimFaceResponseSchema.parse(await call(reviewPath));
    assert.equal(reviewFace.claim_state.claim_id, claim.claim_id);
    assert.equal(reviewFace.claim_state.version, 1);
    assert.ok(reviewFace.items.some((item) => item.id === recordedReview.review_id));
    const reviewerInbox = await inbox(reviewer);
    assert.ok(
      !reviewerInbox.items.some((item) => item.caused_by_event_id === fresh[0].caused_by_event_id),
      "the actor is not notified of their own write",
    );
    const again = await fixtures.deliverInboxTick();
    assert.equal(again.failed, 0);
    assert.equal((await inbox(author)).items.length, after.items.length, "delivery is idempotent");
    // Replay: a crash after the notice insert but before the job completed
    // leaves the job pending with its cursor rewound. Redelivery must not
    // duplicate the notice.
    const rewound = await env.DB.prepare(
      `UPDATE inbox_event_deliveries SET state = 'pending', after_fellow_id = ''
       WHERE event_id = ?`,
    )
      .bind(fresh[0].caused_by_event_id)
      .run();
    assert.equal(rewound.meta.changes, 1, "the delivered job is rewound");
    assert.equal((await fixtures.deliverInboxTick()).failed, 0);
    assert.equal(
      (await inbox(author)).items.filter(
        (item) => item.caused_by_event_id === fresh[0].caused_by_event_id,
      ).length,
      1,
      "a replayed job delivers the notice exactly once",
    );
    // Two ticks racing over one pending job deliver exactly one notice.
    const evidence = await call(
      `/v1/sessions/${secondSession}/evidence`,
      {
        bears_on_kind: "claim",
        bears_on_id: claim.claim_id,
        bears_on_version: 1,
        direction: "supports",
        kind: "argument",
        source: { kind: "model_memory" },
        mode: "confirmatory",
        body_md: "Zero times zero is zero, an even number.",
      },
      second,
      201,
    );
    assert.ok(evidence.evidence_id);
    const raced = await Promise.all([fixtures.deliverInboxTick(), fixtures.deliverInboxTick()]);
    assert.deepEqual(
      raced.map((result) => result.failed),
      [0, 0],
    );
    const evidenceNotices = (await inbox(author)).items.filter(
      (item) => !after.items.some((old) => old.id === item.id),
    );
    assert.equal(evidenceNotices.length, 1, "racing ticks deliver one notice for one evidence");
    const evidencePath = `/p/${problem}/evidence/${evidence.evidence_id}.json`;
    assert.ok(
      evidenceNotices[0].next_actions?.some((action) => action.url === evidencePath),
      "a claim critique links to the exact evidence that caused it",
    );
    const evidenceFace = ClaimFaceResponseSchema.parse(await call(evidencePath));
    assert.equal(evidenceFace.claim_state.claim_id, claim.claim_id);
    assert.equal(evidenceFace.claim_state.version, 1);
    assert.ok(evidenceFace.items.some((item) => item.id === evidence.evidence_id));
    const inboxMarkdown = await worker.fetch(`${origin}/v1/inbox`, {
      headers: {
        "User-Agent": userAgent,
        authorization: `Bearer ${author}`,
        accept: "text/markdown",
      },
    });
    assert.equal(inboxMarkdown.status, 200);
    assert.equal(inboxMarkdown.headers.get("cache-control"), "private, no-store");
    const inboxText = await inboxMarkdown.text();
    assert.ok(inboxText.includes(`](${reviewPath})`));
    assert.ok(inboxText.includes(`](${evidencePath})`));

    // PLANTED stored-notice probes, not additional production causes: the
    // actual review/evidence writes above establish the positive path.
    const claimEvent = await env.DB.prepare(
      "SELECT id FROM events WHERE problem_id = ? AND object_id = ? AND type = 'claim.created'",
    )
      .bind(problem, claim.claim_id)
      .first();
    assert.ok(claimEvent?.id);
    const sourceProbes = [
      ["review-pin", problem, `${claim.claim_id}@2`, fresh[0].caused_by_event_id],
      ["review-problem", "P-AB", `${claim.claim_id}@1`, fresh[0].caused_by_event_id],
      ["evidence-pin", problem, `${claim.claim_id}@2`, evidenceNotices[0].caused_by_event_id],
      ["evidence-problem", "P-AB", `${claim.claim_id}@1`, evidenceNotices[0].caused_by_event_id],
      ["wrong-cause-kind", problem, `${claim.claim_id}@1`, claimEvent.id],
    ];
    const sourceProbeIds = [];
    for (const [name, problemId, targetId, cause] of sourceProbes) {
      const probe = await createInboxNotice(env.DB, {
        id: `NOT-source-${name}`,
        fellowId: before.fellow_id,
        problemId,
        noticeType: "object_critique",
        targetId,
        causedByEventId: cause,
        title: "PLANTED mismatched source binding",
      });
      sourceProbeIds.push(probe.id);
      const item = (await inbox(author)).items.find((notice) => notice.id === probe.id);
      assert.ok(item);
      assert.deepEqual(
        item.next_actions?.map((action) => action.url),
        [`/p/${problemId}/claims/${targetId}.json`],
        `${name}: a mismatched cause cannot author an exact source link`,
      );
    }
    for (const token of [reviewer, second]) {
      assert.ok(
        (await inbox(token)).items.every((notice) => !sourceProbeIds.includes(notice.id)),
        "source probes stay private to their recipient",
      );
    }
    console.log(
      JSON.stringify({ stage: "claim-critique-source-links", causes: 2, planted_probes: 5 }),
    );

    // Reordered delivery: two queued jobs processed in reverse order still
    // yield exactly one notice per causal event.
    const evidenceBody = (body_md) => ({
      bears_on_kind: "claim",
      bears_on_id: claim.claim_id,
      bears_on_version: 1,
      direction: "informs",
      kind: "argument",
      source: { kind: "model_memory" },
      mode: "exploratory",
      body_md,
    });
    const firstEvidence = await call(
      `/v1/sessions/${secondSession}/evidence`,
      evidenceBody("Zero is divisible by two, so its square is too."),
      second,
      201,
    );
    const secondEvidence = await call(
      `/v1/sessions/${secondSession}/evidence`,
      evidenceBody("The square of an even integer is even; zero is even."),
      second,
      201,
    );
    const queued = await env.DB.prepare(
      `SELECT q.id, q.event_id FROM inbox_event_deliveries q WHERE q.state = 'pending'
       ORDER BY q.updated_at, q.id`,
    ).all();
    assert.equal(queued.results.length, 2, "both evidence writes queued");
    // Push the older job behind the newer one.
    await env.DB.prepare(
      "UPDATE inbox_event_deliveries SET updated_at = updated_at + 60000 WHERE id = ?",
    )
      .bind(queued.results[0].id)
      .run();
    assert.equal((await fixtures.deliverInboxTick()).failed, 0);
    assert.equal((await fixtures.deliverInboxTick()).failed, 0);
    const byCause = (await inbox(author, "?limit=100")).items.filter((item) =>
      queued.results.some((job) => job.event_id === item.caused_by_event_id),
    );
    assert.deepEqual(
      byCause.map((item) => item.caused_by_event_id).sort(),
      queued.results.map((job) => job.event_id).sort(),
      "reordered jobs deliver exactly one notice per event",
    );
    assert.ok(firstEvidence.evidence_id && secondEvidence.evidence_id);

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
    await reviseStatement(problem, "usr_stoa_author", author, {
      action: "revise-statement",
      statement: "Every integer in 0..600 has a square of the same parity.",
      falsifier: "An integer in 0..600 whose square has the opposite parity.",
      motivation: "A widened range for followers.",
    });
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

    // A write addressed to the superseded statement is refused (Fable 7.x
    // rule 15): the session predates the revision, so promotion answers 409
    // STATEMENT_REVISED_SINCE with a delta pointer and commits nothing; a
    // promotion pinned at the revised cursor lands.
    const publicSeqNow = async () =>
      EventTailResponseSchema.parse(await call(`/p/${problem}/events.json?since=0&limit=200`))
        .page_end.through;
    const revisedCursor = await publicSeqNow();
    const staleDraft = await call(
      `/v1/sessions/${authorSession}/workshop`,
      { type: "claim-draft", title: "Stale", body_md: "Addressed to the old range." },
      author,
      201,
    );
    const staleBody = {
      workshop_id: staleDraft.workshop_id,
      kind: "conjecture",
      statement: "Five squared is odd, like five.",
      falsifier: "Five squared is even.",
    };
    const refused = await call(`/v1/sessions/${authorSession}/promote`, staleBody, author, 409);
    assert.equal(refused.code, "STATEMENT_REVISED_SINCE");
    assert.equal(refused.delta_pointer, `/p/${problem}.md`);
    assert.ok(refused.fix_hint && refused.revised_at_cursor >= 1);
    assert.equal(await publicSeqNow(), revisedCursor, "a refused stale write commits nothing");
    const reanchored = await call(
      `/v1/sessions/${authorSession}/promote`,
      { ...staleBody, client_context_cursor: refused.revised_at_cursor },
      author,
      201,
    );
    assert.ok(reanchored.claim_id, "a write at the revised cursor lands");
    const staleCursor = await call(
      `/v1/sessions/${authorSession}/promote`,
      {
        ...staleBody,
        workshop_id: (
          await call(
            `/v1/sessions/${authorSession}/workshop`,
            { type: "claim-draft", title: "Old cursor", body_md: "Pinned before the revision." },
            author,
            201,
          )
        ).workshop_id,
        statement: "Seven squared is odd, like seven.",
        falsifier: "Seven squared is even.",
        client_context_cursor: refused.revised_at_cursor - 1,
      },
      author,
      409,
    );
    assert.equal(
      staleCursor.code,
      "STATEMENT_REVISED_SINCE",
      "an explicit pre-revision cursor too",
    );

    // Unfollow stops optional notices at once; the public face carries no
    // follower graph or count; a sponsor directive reaches only its own
    // Fellow's inbox with its text, and acknowledgement clears it.
    const followerOnlyId = (await call("/v1/hello", undefined, followerOnly)).fellow.fellow_id;
    const secondFellowId = (await call("/v1/hello", undefined, second)).fellow.fellow_id;
    const unfollowed = await worker.fetch(`${origin}/v1/p/${problem}/follow`, {
      method: "DELETE",
      headers: { "User-Agent": userAgent, authorization: `Bearer ${followerOnly}` },
    });
    assert.equal(unfollowed.status, 200, "unfollow succeeds");
    await unfollowed.arrayBuffer();
    assert.equal(
      ProblemFollowResponseSchema.parse(
        await call(`/v1/p/${problem}/follow`, undefined, followerOnly),
      ).following,
      false,
    );
    await reviseStatement(problem, "usr_stoa_author", author, {
      action: "revise-statement",
      statement: "Every integer in 0..700 has a square of the same parity.",
      falsifier: "An integer in 0..700 whose square has the opposite parity.",
      motivation: "A second widening after the unfollow.",
    });
    assert.equal((await fixtures.deliverInboxTick()).failed, 0);
    assert.equal(
      (await inbox(followerOnly)).items.filter(
        (item) => item.type === "statement_revision" && item.problem_id === problem,
      ).length,
      1,
      "no revision notice reaches a Fellow after it unfollowed",
    );
    // Follow and unfollow racing: the stored state is one of the two, and the
    // next revision notifies exactly when that final state is 'following'.
    const followRequest = async (method) => {
      const response = await worker.fetch(`${origin}/v1/p/${problem}/follow`, {
        method,
        headers: {
          "User-Agent": userAgent,
          authorization: `Bearer ${stranger}`,
          ...(method === "POST"
            ? { "content-type": "application/json", "idempotency-key": randomUUID() }
            : {}),
        },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      await response.arrayBuffer();
      return response.status;
    };
    for (let round = 0; round < 4; round++) {
      const statuses = await Promise.all([followRequest("POST"), followRequest("DELETE")]);
      assert.ok(
        statuses.every((status) => status === 200 || status === 201),
        `racing follow/unfollow both succeed: ${statuses}`,
      );
    }
    const raceFinal = ProblemFollowResponseSchema.parse(
      await call(`/v1/p/${problem}/follow`, undefined, stranger),
    ).following;
    const strangerRevisionsBefore = (await inbox(stranger)).items.filter(
      (item) => item.type === "statement_revision",
    ).length;
    await reviseStatement(problem, "usr_stoa_author", author, {
      action: "revise-statement",
      statement: "Every integer in 0..800 has a square of the same parity.",
      falsifier: "An integer in 0..800 whose square has the opposite parity.",
      motivation: "A third widening after the follow race.",
    });
    assert.equal((await fixtures.deliverInboxTick()).failed, 0);
    assert.equal(
      (await inbox(stranger)).items.filter((item) => item.type === "statement_revision").length -
        strangerRevisionsBefore,
      raceFinal ? 1 : 0,
      "the revision notice matches the follow state the race left",
    );
    // Keys, not text: the public motivation itself mentions followers.
    const keys = (value) =>
      value && typeof value === "object"
        ? Object.entries(value).flatMap(([key, child]) => [key, ...keys(child)])
        : [];
    for (const face of [`/p/${problem}.json`, `/v1/problems/${problem}`]) {
      const followKeys = keys(await call(face)).filter((key) => /follow/i.test(key));
      assert.deepEqual(followKeys, [], `${face} carries no follower graph or count`);
    }
    const directive = {
      problem_id: problem,
      verb: "focus",
      text: "Focus on the odd residues first.",
    };
    for (const [sponsor, fellowId] of [
      ["usr_stoa_follower", followerOnlyId],
      ["usr_stoa_author", secondFellowId],
    ]) {
      const refused = await sponsorCall(
        sponsor,
        "POST",
        "/v1/sponsors/directives",
        "issue-directive",
        { ...directive, fellow_id: fellowId },
        404,
      );
      assert.equal(refused.code, "DIRECTIVE_TARGET_NOT_FOUND", `${sponsor}: refused, not a 500`);
    }
    await sponsorCall(
      "usr_stoa_second",
      "POST",
      "/v1/sponsors/directives",
      "issue-directive",
      { ...directive, fellow_id: secondFellowId },
      201,
    );
    const directives = (await inbox(second)).items.filter(
      (item) => item.type === "sponsor_directive",
    );
    assert.equal(directives.length, 1, "the directive reaches its own Fellow once");
    assert.ok(JSON.stringify(directives[0]).includes("odd residues"));
    for (const other of [author, followerOnly, stranger]) {
      assert.ok(
        !JSON.stringify(await inbox(other)).includes("odd residues"),
        "a directive reaches no other Fellow",
      );
    }
    assert.ok(!JSON.stringify(await call(`/p/${problem}.json`)).includes("odd residues"));
    InboxAckResponseSchema.parse(
      await call("/v1/inbox/ack", { notice_ids: [directives[0].id] }, second),
    );
    assert.ok(
      !(await inbox(second, "?unread_only=true")).items.some(
        (item) => item.id === directives[0].id,
      ),
      "an acknowledged directive leaves the unread inbox",
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

    // --- Unassigned and multi-problem Fellows (bbx), following next_actions. ---
    const loner = await enroll("stoa-surface-loner", "usr_stoa_loner");
    const lonerHello = await call("/v1/hello", undefined, loner);
    assert.deepEqual(lonerHello.assignments, [], "an unassigned Fellow has no assignments");
    assert.deepEqual(lonerHello.open_sessions, [], "an unassigned Fellow has no sessions");
    const lonerTriage = TriageResponseSchema.parse(await call("/v1/triage", undefined, loner));
    assert.equal(lonerTriage.move, null, "triage invents no move without assignments");
    const lonerNext = ProblemNextResponseSchema.parse(
      await call(`/v1/p/${problem}/next`, undefined, loner),
    );
    assert.equal(lonerNext.viewer.role, "none");
    assert.deepEqual(
      lonerNext.viewer.effective_permissions,
      {
        read: true,
        session_open: true,
        workshop_push: false,
        promote: false,
        evidence: false,
        dead_end: false,
        review: false,
      },
      "a non-member may join by opening a session and holds no write affordance yet",
    );
    assert.equal(lonerNext.primary_move, null);
    assert.deepEqual(lonerNext.alternatives, []);
    // Follow every hello next_action on its stated method.
    const actionsFollowed = [];
    for (const action of lonerHello.next_actions) {
      const url = new URL(action.url);
      assert.equal(url.origin, origin, `${action.action} stays on the Worker origin`);
      const path = `${url.pathname}${url.search}`;
      if (action.action === "protocol.ack") {
        assert.equal(action.request.method, "POST");
        assert.deepEqual(action.request.body_prefill, {
          protocol_digest: lonerHello.protocol_digest,
        });
        await call(path, action.request.body_prefill, loner);
      } else if (action.action === "session.open") {
        assert.equal(action.request.method, "POST");
        assert.ok(!Object.hasOwn(action.request, "body_prefill"), "unbound selection is explicit");
        await call(path, { problem_id: problem, intent: "prove" }, loner, 201);
      } else {
        const response = await worker.fetch(`${origin}${path}`, {
          headers: { "User-Agent": userAgent, authorization: `Bearer ${loner}` },
        });
        assert.equal(response.status, 200, `${action.action} ${path}`);
        await response.arrayBuffer();
      }
      actionsFollowed.push(action.action);
    }
    assert.ok(actionsFollowed.includes("session.open") && actionsFollowed.includes("protocol.ack"));
    assert.equal((await call("/v1/hello", undefined, loner)).protocol_acknowledged, true);
    const joinedNext = ProblemNextResponseSchema.parse(
      await call(`/v1/p/${problem}/next`, undefined, loner),
    );
    assert.equal(joinedNext.viewer.role, "contributor", "opening a session joined the problem");
    assert.equal(joinedNext.viewer.effective_permissions.promote, true);

    const otherProblem = (
      await call(
        "/v1/problems",
        {
          title: "Odd sums on a bounded range",
          statement: "For every n in 1..600 the sum of the first n odd numbers equals n times n.",
          falsifier: "Some n in 1..600 whose first n odd numbers sum to anything but n times n.",
          motivation: "Give one Fellow two assignments.",
          areas: ["number-theory"],
        },
        author,
        201,
      )
    ).problem.id;
    await sponsorCall(
      "usr_stoa_author",
      "POST",
      `/v1/sponsors/problems/${otherProblem}/lifecycle`,
      "problem-lifecycle",
      { action: "publish" },
    );
    await call("/v1/sessions", { problem_id: otherProblem, intent: "prove" }, loner, 201);
    const multiHello = await call("/v1/hello", undefined, loner);
    assert.deepEqual(
      multiHello.assignments.map((assignment) => assignment.problem_id).sort(),
      [problem, otherProblem].sort(),
      "a multi-problem Fellow sees every assignment",
    );
    assert.equal(multiHello.open_sessions.length, 2);
    for (const id of [problem, otherProblem]) {
      const perProblem = ProblemNextResponseSchema.parse(
        await call(`/v1/p/${id}/next`, undefined, loner),
      );
      assert.equal(perProblem.problem_id, id);
      assert.equal(perProblem.viewer.role, "contributor");
      for (const move of [perProblem.primary_move, ...perProblem.alternatives].filter(Boolean)) {
        assert.ok(move.refs.includes(id), `${id}: ${move.move} cites its own problem`);
      }
    }
    const multiTriage = TriageResponseSchema.parse(await call("/v1/triage", undefined, loner));
    assert.ok(multiTriage.move !== null, "triage picks a move across assignments");
    assert.ok(
      multiTriage.move.refs.some((ref) => ref === problem || ref === otherProblem),
      "the triage move belongs to an assigned problem",
    );

    // Follow every returned move contract (bbx): read_first paths answer, and
    // each declared request reaches a live route that teaches a bare call
    // (4xx with code and fix_hint), never 404/405/500.
    const lonerSessions = new Map(
      (await call("/v1/hello", undefined, loner)).open_sessions.map((open) => [
        open.problem_id,
        open.session_id,
      ]),
    );
    const followedContracts = [];
    for (const id of [problem, otherProblem]) {
      const perProblem = ProblemNextResponseSchema.parse(
        await call(`/v1/p/${id}/next`, undefined, loner),
      );
      const moves = [perProblem.primary_move, ...perProblem.alternatives, multiTriage.move];
      for (const move of moves.filter(Boolean)) {
        const contract = move.contract;
        const readFirst = contract.preparation?.read_first;
        if (readFirst?.method === "GET") {
          const read = await worker.fetch(`${origin}${readFirst.path}`, {
            headers: { "User-Agent": userAgent, authorization: `Bearer ${loner}` },
          });
          assert.equal(read.status, 200, `${move.move} read_first ${readFirst.path}`);
          await read.arrayBuffer();
          followedContracts.push(`${move.move}:read_first`);
        }
        const request = contract.request;
        if (request?.path) {
          const ownedProblemRefs = move.refs.filter((ref) => lonerSessions.has(ref));
          const selectedProblem =
            contract.preparation?.problem_id ??
            (ownedProblemRefs.length === 1 ? ownedProblemRefs[0] : undefined);
          assert.ok(
            selectedProblem &&
              move.refs.includes(selectedProblem) &&
              lonerSessions.has(selectedProblem),
            `${move.move}: selected problem is an explicit owned reference`,
          );
          const path = request.path
            .replaceAll("{id}", lonerSessions.get(selectedProblem))
            .replaceAll("{problem_id}", encodeURIComponent(selectedProblem));
          assert.ok(!path.includes("{"), `${move.move}: every template slot is fillable (${path})`);
          const bare = await worker.fetch(`${origin}${path}`, {
            method: request.method,
            headers: {
              "User-Agent": userAgent,
              authorization: `Bearer ${loner}`,
              "content-type": "application/json",
              "idempotency-key": randomUUID(),
            },
            ...(request.method === "GET" ? {} : { body: "{}" }),
          });
          const taught = await bare.json();
          assert.ok(
            bare.status >= 400 && bare.status < 500 && ![404, 405].includes(bare.status),
            `${move.move} ${request.method} ${path}: live route, got ${bare.status} ${taught.code}`,
          );
          assert.ok(taught.code && taught.fix_hint, `${move.move}: the refusal teaches`);
          followedContracts.push(`${move.move}:request`);
        }
      }
    }
    assert.ok(followedContracts.length >= 2, `move contracts followed: ${followedContracts}`);

    // The Markdown faces state the same snapshot as the JSON faces for a
    // contributor: role, permissions and degraded flag.
    const frontmatterOf = async (path) => {
      const response = await worker.fetch(`${origin}${path}`, {
        headers: { "User-Agent": userAgent, authorization: `Bearer ${loner}` },
      });
      assert.equal(response.status, 200, path);
      const markdown = await response.text();
      assert.ok(markdown.startsWith("---\n"), `${path} has frontmatter`);
      return markdown.split("\n---")[0];
    };
    const contributorJson = ProblemNextResponseSchema.parse(
      await call(`/v1/p/${problem}/next`, undefined, loner),
    );
    const contributorFront = `${await frontmatterOf(`/v1/p/${problem}/next.md`)}\n`;
    const expectedLines = [
      `role: ${contributorJson.viewer.role}\n`,
      ...Object.entries(contributorJson.viewer.effective_permissions).map(
        ([permission, value]) => `  ${permission}: ${value}\n`,
      ),
      `degraded: ${contributorJson.degraded}\n`,
    ];
    for (const line of expectedLines) {
      assert.ok(contributorFront.includes(line), `next.md frontmatter states ${line.trim()}`);
    }
    const triageJson = TriageResponseSchema.parse(await call("/v1/triage", undefined, loner));
    assert.ok(
      `${await frontmatterOf("/v1/triage.md")}\n`.includes(`degraded: ${triageJson.degraded}\n`),
      "triage.md frontmatter states the JSON degraded flag",
    );

    // An observer (admitted past the writer cap) may review but never promote
    // (Fable 9.3, ADR-14): no promote permission and no move that promotes.
    await sponsorCall(
      "usr_stoa_author",
      "POST",
      `/v1/sponsors/problems/${otherProblem}/lifecycle`,
      "problem-lifecycle",
      { action: "set-writer-cap", writer_cap: 1 },
    );
    await call("/v1/sessions", { problem_id: otherProblem, intent: "review" }, second, 201);
    const observerNext = ProblemNextResponseSchema.parse(
      await call(`/v1/p/${otherProblem}/next`, undefined, second),
    );
    assert.equal(observerNext.viewer.role, "observer", "past the writer cap a joiner observes");
    assert.equal(
      observerNext.viewer.effective_permissions.promote,
      false,
      "observers never promote",
    );
    assert.equal(observerNext.viewer.effective_permissions.review, true, "observers still review");
    for (const move of [observerNext.primary_move, ...observerNext.alternatives].filter(Boolean)) {
      assert.ok(
        !JSON.stringify(move.contract).includes("/promote"),
        `observer move ${move.move} offers no promotion`,
      );
    }
    // The Markdown faces carry the same permissions in YAML frontmatter
    // (Fable 7.x rule 14), on the .md suffix and by Accept negotiation.
    for (const [path, accept] of [
      [`/v1/p/${otherProblem}/next.md`, "*/*"],
      [`/v1/p/${otherProblem}/next`, "text/markdown"],
    ]) {
      const response = await worker.fetch(`${origin}${path}`, {
        headers: { "User-Agent": userAgent, authorization: `Bearer ${second}`, accept },
      });
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get("content-type") ?? "", /^text\/markdown/, path);
      const markdown = await response.text();
      const frontmatter = markdown.startsWith("---\n") ? markdown.split("\n---")[0] : "";
      assert.match(frontmatter, /promote: false/, `${path}: observer frontmatter`);
      assert.match(frontmatter, /review: true/, `${path}: observer frontmatter`);
    }
    const triageMarkdown = await worker.fetch(`${origin}/v1/triage.md`, {
      headers: { "User-Agent": userAgent, authorization: `Bearer ${second}` },
    });
    assert.equal(triageMarkdown.status, 200);
    assert.ok((await triageMarkdown.text()).startsWith("---\n"), "triage.md has frontmatter");
    const observerHello = await call("/v1/hello", undefined, second);
    assert.equal(
      observerHello.assignments.find((assignment) => assignment.problem_id === otherProblem)?.role,
      "observer",
    );

    // Mega-commands lifecycle matrix on real routes: a paused Fellow is refused
    // hello/triage/next, resuming restores access, and revocation is final.
    const secondId = (await call("/v1/hello", undefined, second)).fellow.fellow_id;
    const setStatus = (status) =>
      sponsorCall("usr_stoa_second", "POST", "/v1/fellows/lifecycle", "fellow.lifecycle.change", {
        fellow_id: secondId,
        status,
        confirm: "change-fellow-lifecycle",
        step_up_authenticated_at: Math.floor(Date.now() / 1000),
      });
    const megaStatuses = async () => [
      (
        await worker.fetch(`${origin}/v1/hello`, {
          headers: { "User-Agent": userAgent, authorization: `Bearer ${second}` },
        })
      ).status,
      (
        await worker.fetch(`${origin}/v1/triage`, {
          headers: { "User-Agent": userAgent, authorization: `Bearer ${second}` },
        })
      ).status,
      (
        await worker.fetch(`${origin}/v1/p/${problem}/next`, {
          headers: { "User-Agent": userAgent, authorization: `Bearer ${second}` },
        })
      ).status,
    ];
    assert.deepEqual(await megaStatuses(), [200, 200, 200], "an active Fellow reads");
    await setStatus("paused");
    assert.deepEqual(await megaStatuses(), [401, 401, 401], "a paused Fellow is refused");
    await setStatus("active");
    assert.deepEqual(await megaStatuses(), [200, 200, 200], "resuming restores access");
    await setStatus("revoked");
    assert.deepEqual(await megaStatuses(), [401, 401, 401], "a revoked Fellow is refused");

    // Idle close (1e7/lu59): the production sweep closes a session idle past
    // its deadline and tells its Fellow once with a protocol_notice; the
    // session leaves hello's open sessions and a repeat sweep adds nothing.
    const idler = await enroll("stoa-surface-idler", "usr_stoa_idler");
    const idlerId = (await call("/v1/hello", undefined, idler)).fellow.fellow_id;
    const idleSession = (
      await call("/v1/sessions", { problem_id: problem, intent: "explore" }, idler, 201)
    ).session_id;
    const idleDraftBody = "IDLE-RECOVERY-PRIVATE-DRAFT: unfinished parity notes.";
    const idleDraft = await call(
      `/v1/sessions/${idleSession}/workshop`,
      { type: "scratch", title: "Retained working notes", body_md: idleDraftBody },
      idler,
      201,
    );
    const publicCursorBeforeResponse = await worker.fetch(`${origin}/cursor`, {
      headers: { "User-Agent": userAgent },
    });
    assert.equal(publicCursorBeforeResponse.status, 200);
    const publicCursorBeforeIdle = await publicCursorBeforeResponse.text();
    CursorResponseSchema.parse(JSON.parse(publicCursorBeforeIdle));
    const later = Date.now() + 13 * 3600 * 1000;
    assert.equal(
      (await fixtures.expireIdleTick(later, idlerId)).closed,
      1,
      "the idle session closes",
    );
    assert.equal((await fixtures.expireIdleTick(later, idlerId)).closed, 0, "closing is once");
    const idleInboxResponse = await worker.fetch(`${origin}/v1/inbox`, {
      headers: { "User-Agent": userAgent, authorization: `Bearer ${idler}` },
    });
    assert.equal(idleInboxResponse.status, 200);
    assert.equal(idleInboxResponse.headers.get("cache-control"), "private, no-store");
    const idleNotices = InboxResponseSchema.parse(await idleInboxResponse.json()).items.filter(
      (item) => item.type === "protocol_notice" && item.target_id === idleSession,
    );
    assert.equal(idleNotices.length, 1, "one idle-close notice");
    assert.equal(idleNotices[0].title, "Idle session closed");
    const idleStatusPath = `/v1/sessions/${idleSession}`;
    assert.deepEqual(
      idleNotices[0].next_actions?.map((action) => action.url),
      [idleStatusPath],
      "an actual idle notice points to its owned closed-session recovery read",
    );
    const idleStatusResponse = await worker.fetch(`${origin}${idleStatusPath}`, {
      headers: { "User-Agent": userAgent, authorization: `Bearer ${idler}` },
    });
    assert.equal(idleStatusResponse.status, 200);
    assert.equal(idleStatusResponse.headers.get("cache-control"), "private, no-store");
    const idleStatus = SessionStatusResponseSchema.parse(await idleStatusResponse.json());
    assert.equal(idleStatus.session_id, idleSession);
    assert.notEqual(idleStatus.closed_at, null);
    assert.ok(idleStatus.workshop_cursor >= idleDraft.workshop_seq);
    assert.ok(!JSON.stringify(idleStatus).includes(idleDraftBody), "status omits private bodies");
    const idleMarkdown = await worker.fetch(`${origin}/v1/inbox.md`, {
      headers: { "User-Agent": userAgent, authorization: `Bearer ${idler}` },
    });
    assert.equal(idleMarkdown.status, 200);
    assert.equal(idleMarkdown.headers.get("cache-control"), "private, no-store");
    const idleMarkdownBody = await idleMarkdown.text();
    assert.ok(idleMarkdownBody.includes(idleStatusPath), "Markdown exposes the same recovery read");
    assert.ok(!idleMarkdownBody.includes(idleDraftBody), "notices omit private draft bodies");
    const orientAction = idleStatus.next_actions.find(
      (action) => action.method === "GET" && action.url === "/v1/hello",
    );
    assert.ok(orientAction, "closed status teaches the next orientation read");
    const resumedHello = await call(orientAction.url, undefined, idler);
    const openAction = resumedHello.next_actions.find((action) => action.action === "session.open");
    assert.ok(openAction, "orientation offers an authorized new session");
    const openUrl = new URL(openAction.url);
    assert.equal(openUrl.origin, origin);
    const resumedSession = (
      await call(openUrl.pathname, { problem_id: problem, intent: "explore" }, idler, 201)
    ).session_id;
    assert.notEqual(resumedSession, idleSession);
    const workingAction = SessionStatusResponseSchema.parse(
      await call(`/v1/sessions/${resumedSession}`, undefined, idler),
    ).next_actions.find(
      (action) => action.method === "GET" && action.url.endsWith("?profile=working"),
    );
    assert.ok(workingAction, "the new session offers its working pack");
    const recoveryPack = await call(workingAction.url, undefined, idler);
    const preservedHead = recoveryPack.items.find((item) => item.kind === "workshop-head");
    assert.ok(preservedHead, "the working pack discovers the retained draft");
    assert.equal(preservedHead.scope, "workshop");
    assert.equal(preservedHead.id, idleDraft.workshop_id);
    const recoveryPath = preservedHead.body.match(
      /Private work product: (\/v1\/sessions\/S-[A-Za-z0-9]{26}\/workshop\/W-[A-Za-z0-9]{26})/,
    )?.[1];
    assert.equal(recoveryPath, `/v1/sessions/${resumedSession}/workshop/${preservedHead.id}`);
    const recoveredResponse = await worker.fetch(`${origin}${recoveryPath}`, {
      headers: { "User-Agent": userAgent, authorization: `Bearer ${idler}` },
    });
    assert.equal(recoveredResponse.status, 200);
    assert.equal(recoveredResponse.headers.get("cache-control"), "private, no-store");
    const recovered = WorkshopObjectResponseSchema.parse(await recoveredResponse.json());
    assert.equal(recovered.object.body_md, idleDraftBody);
    assert.equal(recovered.object.version, 1);
    await call(
      `/v1/sessions/${resumedSession}/workshop`,
      {
        workshop_id: idleDraft.workshop_id,
        base_version: 1,
        body_md: `${idleDraftBody} Continued.`,
      },
      idler,
      201,
    );
    const continued = await call(recoveryPath, undefined, idler);
    assert.equal(continued.object.body_md, `${idleDraftBody} Continued.`);
    assert.equal(continued.object.version, 2, "the same preserved draft can be revised");
    for (const path of [idleStatusPath, recoveryPath]) {
      const denied = await worker.fetch(`${origin}${path}`, {
        headers: { "User-Agent": userAgent, authorization: `Bearer ${author}` },
      });
      assert.equal(denied.status, 404, "a foreign Fellow cannot use a recovery URL");
      assert.equal(denied.headers.get("cache-control"), "private, no-store");
      assert.ok(!(await denied.text()).includes(idleDraftBody));
    }
    const publicCursorAfterResponse = await worker.fetch(`${origin}/cursor`, {
      headers: { "User-Agent": userAgent },
    });
    assert.equal(publicCursorAfterResponse.status, 200);
    const publicCursorAfterIdle = await publicCursorAfterResponse.text();
    CursorResponseSchema.parse(JSON.parse(publicCursorAfterIdle));
    assert.equal(
      publicCursorAfterIdle,
      publicCursorBeforeIdle,
      "idle closure, recovery reads and draft continuation never move the public cursor",
    );
    const publicProblem = await worker.fetch(`${origin}/p/${problem}.json`, {
      headers: { "User-Agent": userAgent },
    });
    assert.equal(publicProblem.status, 200);
    const publicProblemBody = await publicProblem.text();
    assert.ok(
      !publicProblemBody.includes(idleDraftBody),
      "private recovery bytes stay off the public face",
    );
    assert.ok(
      !publicProblemBody.includes(idleDraft.workshop_id),
      "the public face omits private draft IDs",
    );
    // Explicitly PLANTED notice-context probes, distinct from the genuine
    // idle producer above. Text and a session-shaped target grant no recovery
    // affordance without matching recipient, problem and closed session state.
    const authorId = (await call("/v1/hello", undefined, author)).fellow.fellow_id;
    const recoveryProbes = [
      { name: "foreign-recipient", fellowId: authorId, problemId: problem, targetId: idleSession },
      { name: "wrong-problem", fellowId: idlerId, problemId: otherProblem, targetId: idleSession },
      { name: "open-session", fellowId: idlerId, problemId: problem, targetId: resumedSession },
      {
        name: "missing-session",
        fellowId: idlerId,
        problemId: problem,
        targetId: `S-${"Z".repeat(26)}`,
      },
      {
        name: "noncanonical-session",
        fellowId: idlerId,
        problemId: problem,
        targetId: `${idleSession}\n`,
      },
    ];
    for (const probe of recoveryProbes) {
      await createInboxNotice(env.DB, {
        id: `NOT-idle-recovery-${probe.name}`,
        fellowId: probe.fellowId,
        problemId: probe.problemId,
        targetId: probe.targetId,
        noticeType: "protocol_notice",
        title: "Idle session closed",
      });
    }
    const recoveryPages = [await inbox(author), await inbox(idler)];
    for (const probe of recoveryProbes) {
      const item = recoveryPages
        .flatMap((page) => page.items)
        .find((item) => item.id === `NOT-idle-recovery-${probe.name}`);
      assert.ok(item, `${probe.name} probe reaches its recipient's private inbox`);
      assert.deepEqual(item.next_actions ?? [], [], `${probe.name} cannot mint a recovery action`);
    }
    assert.ok(
      !(await call("/v1/hello", undefined, idler)).open_sessions.some(
        (open) => open.session_id === idleSession,
      ),
      "the closed session leaves hello",
    );

    // Follow the actual first-write descriptors, without filling a bound
    // Fellow's request from harness knowledge of the endpoint or body shape.
    const bound = await enroll("stoa-action-bound", "usr_stoa_action_bound", {
      problem_binding: problem,
    });
    const boundHello = EnrollmentHelloResponseSchema.parse(
      await call("/v1/hello", undefined, bound),
    );
    const boundOpenAction = boundHello.next_actions.find(
      (action) => action.action === "session.open",
    );
    assert.ok(
      boundOpenAction?.request?.body_prefill,
      "bound hello supplies its first-session body",
    );
    assert.equal(
      boundOpenAction.request.body_prefill.problem_id,
      problem,
      "prefill uses the actual grant",
    );
    SessionOpenRequestSchema.parse(boundOpenAction.request.body_prefill);
    const directiveIndex = boundHello.next_actions.findIndex((action) =>
      action.url.includes("/v1/directives/active"),
    );
    assert.ok(
      directiveIndex >= 0 && directiveIndex < boundHello.next_actions.indexOf(boundOpenAction),
    );
    for (const write of boundHello.next_actions.filter((action) => action.request)) {
      assert.ok(
        directiveIndex < boundHello.next_actions.indexOf(write),
        "directives precede each write",
      );
    }

    async function followWrite(action, expected, requestKey, body = action.request.body_prefill) {
      assert.equal(action.request.method, "POST");
      const response = await worker.fetch(action.url, {
        method: action.request.method,
        headers: {
          "User-Agent": userAgent,
          authorization: `Bearer ${bound}`,
          "content-type": "application/json",
          "idempotency-key": requestKey,
        },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, expected, `advertised ${action.action} status`);
      return response.json();
    }

    let advertisedSession;
    for (const action of boundHello.next_actions) {
      assert.equal(new URL(action.url).origin, origin, "action stays on the configured origin");
      if (action.request) {
        assert.equal(new URL(action.request.schema).origin, origin, "schema uses the same origin");
        const schemaResponse = await worker.fetch(action.request.schema, {
          headers: { "User-Agent": userAgent },
        });
        assert.equal(schemaResponse.status, 200, "advertised request schema is served");
        const schema = await schemaResponse.json();
        assert.equal(schema.type, "object");
        assert.ok(action.request.body_prefill, "a bound first write is ready to submit");
        if (action.action === "session.open") {
          const invalid = await followWrite(action, 422, "hello-action-invalid", {
            ...action.request.body_prefill,
            unknown_field: true,
          });
          assert.equal(
            invalid.code,
            "SESSION_OPEN_BODY_INVALID",
            "the strict write contract remains",
          );
          const opened = await followWrite(action, 201, "hello-action-open");
          advertisedSession = SessionOpenResponseSchema.parse(opened);
          assert.equal(advertisedSession.problem_id, problem);
          const replayed = await followWrite(action, 200, "hello-action-open");
          assert.equal(
            replayed.session_id,
            advertisedSession.session_id,
            "same key replays the session",
          );
        } else {
          await followWrite(action, 200, "hello-action-ack");
        }
      } else {
        const response = await worker.fetch(action.url, {
          headers: { "User-Agent": userAgent, authorization: `Bearer ${bound}` },
        });
        assert.equal(response.status, 200);
        await response.arrayBuffer();
      }
    }
    assert.ok(advertisedSession, "the advertised session action actually opens a session");
    assert.equal((await call("/v1/hello", undefined, bound)).protocol_acknowledged, true);
    const unboundAction = lonerHello.next_actions.find(
      (action) => action.action === "session.open",
    );
    assert.ok(
      !JSON.stringify(unboundAction).includes(problem),
      "an unbound action does not guess a target",
    );

    console.log(
      JSON.stringify({
        stage: "stoa-surface-journey-passed",
        kind: "stoa-surface-real-bindings",
        status: "pass",
        inbox_notice: fresh[0].type,
        tail_events: seen.length,
        advertised_first_session: true,
        move_contracts_followed: followedContracts,
        idle_recovery: {
          resumed_original_draft: true,
          planted_binding_probes: recoveryProbes.length,
        },
        boundary: "local Workerd/D1/R2; inbox delivery by one cron-tick call; fixture screening",
      }),
    );
  },
);
