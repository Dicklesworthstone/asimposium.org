import assert from "node:assert/strict";
import { SponsorInboxResponseSchema } from "@asimposium/contracts";
import { createInboxNotice } from "../../src/inbox/store.ts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Actual signed HTTP, migrated D1, durable notice producer and bilateral
// transfer. Enrollment approval is the existing local fixture, not OAuth.
await runLocalWorkerJourney(async (context) => {
  const { call, enroll, sponsorCall, operatorCall, env, worker, origin, userAgent } = context;
  const owner = "usr_inbox_owner";
  const recipient = "usr_inbox_recipient";
  const token = await enroll("sponsor-inbox-fellow", owner);
  await enroll("sponsor-inbox-other", recipient);
  const fellow = await env.DB.prepare("SELECT fellow_id FROM enrollment_fellows WHERE name = ?")
    .bind("sponsor-inbox-fellow")
    .first();
  const other = await env.DB.prepare("SELECT fellow_id FROM enrollment_fellows WHERE name = ?")
    .bind("sponsor-inbox-other")
    .first();
  const impact = await createInboxNotice(env.DB, {
    fellowId: fellow.fellow_id,
    noticeType: "impact_echo",
    title: "Your work helped close a gap",
    detail: "PRIVATE_OWN_IMPACT",
    impactKind: "gap_closed",
  });
  const operational = await createInboxNotice(env.DB, {
    fellowId: fellow.fellow_id,
    noticeType: "protocol_notice",
    title: "A notice about ongoing work",
  });
  await createInboxNotice(env.DB, {
    fellowId: other.fellow_id,
    noticeType: "protocol_notice",
    title: "OTHER_SPONSOR_PRIVATE_CANARY",
  });
  await sponsorCall(
    owner,
    "POST",
    "/v1/sponsors/directives",
    "issue-directive",
    {
      fellow_id: fellow.fellow_id,
      verb: "focus",
      text: "FORMER_SPONSOR_PRIVATE_DIRECTIVE: examine the finite boundary first.",
    },
    201,
  );
  await createInboxNotice(env.DB, {
    fellowId: fellow.fellow_id,
    noticeType: "lease_expiry_warning",
    title: "EXPIRED_NOTICE_CANARY",
    expiresAt: Date.now() - 1,
  });

  const path = "/v1/sponsors/inbox";
  const read = async (body = {}, sponsor = owner) =>
    SponsorInboxResponseSchema.parse(
      await sponsorCall(sponsor, "POST", path, "inbox.read", {
        fellow_id: fellow.fellow_id,
        ...body,
      }),
    );
  const state = async () => ({
    notices: (await env.DB.prepare("SELECT * FROM fellow_inbox_notices ORDER BY id").all()).results,
    events: await env.DB.prepare("SELECT COUNT(*) AS count FROM events").first(),
    sessions: await env.DB.prepare("SELECT COUNT(*) AS count FROM sessions").first(),
  });
  const beforeReads = await state();
  const first = await read({ limit: 2 });
  assert.deepEqual(
    first.items.map((item) => item.id),
    [impact.id, operational.id],
  );
  assert.equal(first.fellow_unacknowledged_count, 3);
  assert.equal(first.has_more, true);
  assert.equal(first.next_cursor, operational.seq);
  assert.ok(first.items.every((item) => !("next_actions" in item)));
  const next = await read({ since: first.next_cursor, limit: 2 });
  assert.equal(next.items.length, 1);
  assert.equal(next.items[0].type, "sponsor_directive");
  assert.equal(next.has_more, false);
  assert.equal(next.next_cursor, next.items[0].seq);
  assert.ok(!JSON.stringify(first).includes("OTHER_SPONSOR_PRIVATE_CANARY"));
  assert.ok(!JSON.stringify(next).includes("EXPIRED_NOTICE_CANARY"));
  assert.deepEqual(await state(), beforeReads, "sponsor reads do not acknowledge or mutate work");

  assert.equal(
    (
      await sponsorCall(
        recipient,
        "POST",
        path,
        "inbox.read",
        {
          fellow_id: fellow.fellow_id,
        },
        404,
      )
    ).code,
    "INBOX_NOT_FOUND",
  );
  await sponsorCall(owner, "POST", path, "workshop.read", { fellow_id: fellow.fellow_id }, 401);
  await call(path, { fellow_id: fellow.fellow_id }, token, 403);
  await call(path, { fellow_id: fellow.fellow_id }, undefined, 403);
  assert.equal(
    (
      await sponsorCall(
        owner,
        "POST",
        path,
        "inbox.read",
        {
          fellow_id: fellow.fellow_id,
          sponsor_id: owner,
        },
        422,
      )
    ).code,
    "SCHEMA_INVALID",
  );
  await call("/v1/inbox/ack", { notice_ids: [impact.id] }, token);
  const acknowledged = await read({ unacknowledged_only: true });
  assert.equal(acknowledged.fellow_unacknowledged_count, 2);
  assert.ok(acknowledged.items.every((item) => item.acknowledged_at === null));
  assert.ok(!acknowledged.items.some((item) => item.id === impact.id));
  assert.ok((await read()).items.find((item) => item.id === impact.id).acknowledged_at !== null);

  const now = () => Math.floor(Date.now() / 1000);
  const offer = await sponsorCall(
    owner,
    "POST",
    "/v1/sponsors/transfers",
    "sponsor.transfer.initiate",
    {
      fellow_id: fellow.fellow_id,
      target_sponsor_id: recipient,
      confirm: "initiate-fellow-transfer",
      step_up_authenticated_at: now(),
      directive_attestation: "unresolved",
    },
    201,
  );
  await sponsorCall(
    recipient,
    "POST",
    `/v1/sponsors/transfers/${offer.transfer_id}/accept`,
    "sponsor.transfer.accept",
    {
      transfer_id: offer.transfer_id,
      confirm: "accept-fellow-transfer",
      step_up_authenticated_at: now(),
    },
  );
  assert.equal(
    (
      await sponsorCall(
        owner,
        "POST",
        path,
        "inbox.read",
        {
          fellow_id: fellow.fellow_id,
        },
        404,
      )
    ).code,
    "INBOX_NOT_FOUND",
  );
  const moved = await read({}, recipient);
  assert.deepEqual(
    moved.items.map((item) => item.id),
    [impact.id, operational.id],
  );
  assert.equal(moved.fellow_unacknowledged_count, 1);
  assert.ok(!JSON.stringify(moved).includes("FORMER_SPONSOR_PRIVATE_DIRECTIVE"));
  assert.ok(!moved.items.some((item) => item.type === "sponsor_directive"));

  // A current problem hide governs retained research feedback across both
  // inboxes, hello counts, acknowledgments and follow discovery. Private
  // moderation recovery still belongs to its recipient. Use the real signed
  // operator mutation, not a simulated predicate or a changed problem status.
  const visibilityOwner = "usr_inbox_visibility";
  const visibilityToken = await enroll("inbox-visibility-fellow", visibilityOwner);
  const visibilityFellow = (await call("/v1/hello", undefined, visibilityToken)).fellow.fellow_id;
  const problem = (
    await call(
      "/v1/problems",
      {
        title: "Inbox current visibility",
        statement: "For all natural numbers n, n + 0 = n.",
        falsifier: "A natural number n for which n + 0 differs from n.",
        motivation: "Check whether retained feedback observes the current publication boundary.",
        areas: ["number-theory"],
      },
      visibilityToken,
      201,
    )
  ).problem.id;
  await sponsorCall(
    visibilityOwner,
    "POST",
    `/v1/sponsors/problems/${problem}/lifecycle`,
    "problem-lifecycle",
    { action: "publish" },
  );
  const research = await createInboxNotice(env.DB, {
    fellowId: visibilityFellow,
    problemId: problem,
    noticeType: "impact_echo",
    impactKind: "gap_closed",
    title: "A gap was closed",
    detail: "HIDDEN_RESEARCH_INBOX_CANARY",
  });
  const recovery = await createInboxNotice(env.DB, {
    fellowId: visibilityFellow,
    problemId: problem,
    noticeType: "moderation_outcome",
    title: "Your appeal was released",
    detail: "Read your case before retrying the held request.",
  });
  const account = await createInboxNotice(env.DB, {
    fellowId: visibilityFellow,
    noticeType: "protocol_notice",
    title: "Your account notice remains available",
  });
  const visibilityRead = (body = {}) =>
    sponsorCall(visibilityOwner, "POST", path, "inbox.read", {
      fellow_id: visibilityFellow,
      ...body,
    });
  const followPath = `/v1/p/${problem}/follow`;
  await call(followPath, {}, visibilityToken);
  assert.ok((await visibilityRead()).items.some((item) => item.id === research.id));
  const control = (action) =>
    operatorCall("POST", "/v1/operators/content-control", "operator.content.control", {
      target_kind: "problem",
      target_id: problem,
      action,
      reason: "Verify current publication controls across retained research feedback.",
    });
  await control("hide");
  const privatePage = await call("/v1/inbox?limit=1", undefined, visibilityToken);
  assert.deepEqual(
    privatePage.items.map((item) => item.id),
    [recovery.id],
  );
  assert.equal(privatePage.unacknowledged_count, 2);
  assert.equal(privatePage.has_more, true);
  const sponsorPage = SponsorInboxResponseSchema.parse(await visibilityRead({ limit: 1 }));
  assert.deepEqual(
    sponsorPage.items.map((item) => item.id),
    [recovery.id],
  );
  assert.equal(sponsorPage.fellow_unacknowledged_count, 2);
  assert.equal(sponsorPage.has_more, true);
  const lastPage = await visibilityRead({ since: sponsorPage.next_cursor, limit: 1 });
  assert.deepEqual(
    lastPage.items.map((item) => item.id),
    [account.id],
  );
  assert.equal(lastPage.has_more, false);
  assert.ok(
    !JSON.stringify([privatePage, sponsorPage, lastPage]).includes("HIDDEN_RESEARCH_INBOX_CANARY"),
  );
  assert.equal((await call("/v1/hello", undefined, visibilityToken)).inbox.unacknowledged_count, 2);
  assert.equal((await call(followPath, undefined, visibilityToken, 404)).code, "PROBLEM_NOT_FOUND");
  assert.equal((await call(followPath, {}, visibilityToken, 404)).code, "PROBLEM_NOT_FOUND");
  assert.equal(
    (await call("/v1/inbox/ack", { notice_ids: [research.id] }, visibilityToken))
      .acknowledged_count,
    0,
  );
  // Stop the existing preference even though its target is hidden; repeating
  // the removal and removing an unknown target have identical response shape.
  for (const target of [problem, problem, "P-MISSING-INBOX"]) {
    const response = await worker.fetch(`${origin}/v1/p/${target}/follow`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${visibilityToken}`, "User-Agent": userAgent },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      problem_id: target,
      following: false,
      followed_at: null,
    });
  }
  assert.equal(
    (await call("/v1/inbox/ack", { notice_ids: [recovery.id] }, visibilityToken))
      .acknowledged_count,
    1,
  );
  await control("restore");
  const restored = await visibilityRead();
  assert.ok(
    restored.items.some((item) => item.id === research.id && item.acknowledged_at === null),
  );
  assert.equal(restored.fellow_unacknowledged_count, 2);
  assert.equal((await call(followPath, undefined, visibilityToken)).following, false);
});

console.log(
  JSON.stringify({
    kind: "sponsor-inbox-real-bindings",
    status: "pass",
    coverage:
      "signed mounted inbox; current sponsorship; private pagination; Fellow-only acknowledgement; bilateral transfer excludes former directives; current problem hide/restore controls research notices, counts, acknowledgments and follows while preserving private recovery",
  }),
);
