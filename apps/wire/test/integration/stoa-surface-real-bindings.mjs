import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  InboxAckResponseSchema,
  InboxResponseSchema,
  ProblemFollowResponseSchema,
  ProblemNextResponseSchema,
  TriageResponseSchema,
} from "@asimposium/contracts";
import { EventTailResponseSchema } from "../../../../packages/contracts/src/event-tail.ts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// W6 Stoa surface on real Workerd HTTP, D1 and R2 (bead asimposiumorg-lu59):
// inbox notices CAUSED by committed ledger writes (delivered by one tick of the
// production cron consumer), acknowledgement, follows, event tails paged over
// concurrently committed events, and triage/next. Synthetic screening and
// sponsor approval come from the shared harness; no deployment claim.
await runLocalWorkerJourney(
  async ({ call, enroll, sponsorCall, fixtures, env, worker, origin, userAgent }) => {
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
    await sponsorCall(
      "usr_stoa_author",
      "POST",
      `/v1/sponsors/problems/${problem}/lifecycle`,
      "problem-lifecycle",
      {
        action: "revise-statement",
        statement: "Every integer in 0..700 has a square of the same parity.",
        falsifier: "An integer in 0..700 whose square has the opposite parity.",
        motivation: "A second widening after the unfollow.",
      },
    );
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
    await sponsorCall(
      "usr_stoa_author",
      "POST",
      `/v1/sponsors/problems/${problem}/lifecycle`,
      "problem-lifecycle",
      {
        action: "revise-statement",
        statement: "Every integer in 0..800 has a square of the same parity.",
        falsifier: "An integer in 0..800 whose square has the opposite parity.",
        motivation: "A third widening after the follow race.",
      },
    );
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
      { read: true, session_open: true, workshop_push: false, promote: false, review: false },
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
        await call(path, { protocol_digest: lonerHello.protocol_digest }, loner);
      } else if (action.action === "session.open") {
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
          const path = request.path.replace("{id}", lonerSessions.get(id) ?? "S-none");
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
    const later = Date.now() + 13 * 3600 * 1000;
    assert.equal(
      (await fixtures.expireIdleTick(later, idlerId)).closed,
      1,
      "the idle session closes",
    );
    assert.equal((await fixtures.expireIdleTick(later, idlerId)).closed, 0, "closing is once");
    const idleNotices = (await inbox(idler)).items.filter(
      (item) => item.type === "protocol_notice" && item.target_id === idleSession,
    );
    assert.equal(idleNotices.length, 1, "one idle-close notice");
    assert.equal(idleNotices[0].title, "Idle session closed");
    assert.ok(
      !(await call("/v1/hello", undefined, idler)).open_sessions.some(
        (open) => open.session_id === idleSession,
      ),
      "the closed session leaves hello",
    );

    console.log(
      JSON.stringify({
        stage: "stoa-surface-journey-passed",
        kind: "stoa-surface-real-bindings",
        status: "pass",
        inbox_notice: fresh[0].type,
        tail_events: seen.length,
        move_contracts_followed: followedContracts,
        boundary: "local Workerd/D1/R2; inbox delivery by one cron-tick call; fixture screening",
      }),
    );
  },
);
