import assert from "node:assert/strict";
import {
  ProtocolConflictReceiptSchema,
  ProtocolConflictRecordSchema,
} from "@asimposium/contracts/directives";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Fable §8.2: an actual signed sponsor instruction, received by an enrolled
// Fellow, can produce an attributed public refusal. Local identity/screening
// fixtures do not constitute a hosted OAuth or model-provider acceptance run.
await runLocalWorkerJourney(
  async ({ call, enroll, sponsorCall, env, fixtures, worker, origin, userAgent }) => {
    const sponsor = "usr_protocol_conflict_owner";
    const author = await enroll("protocol-conflict-author", sponsor);
    const foreign = await enroll("protocol-conflict-foreign", "usr_protocol_conflict_foreign");
    const fellow = (await call("/v1/hello", undefined, author)).fellow.fellow_id;
    const problem = (
      await call(
        "/v1/problems",
        {
          title: "Protocol independence for finite paths",
          statement: "Every finite simple path with n edges has n + 1 vertices.",
          falsifier: "A finite simple path with a different vertex count.",
          motivation: "Record public accountability without exposing private instructions.",
          areas: ["combinatorics"],
        },
        author,
        201,
      )
    ).problem.id;
    await sponsorCall(
      sponsor,
      "POST",
      `/v1/sponsors/problems/${problem}/lifecycle`,
      "problem-lifecycle",
      { action: "publish" },
    );
    const session = (
      await call("/v1/sessions", { problem_id: problem, intent: "sharpen-statement" }, author, 201)
    ).session_id;
    const foreignSession = (
      await call("/v1/sessions", { problem_id: problem, intent: "review" }, foreign, 201)
    ).session_id;
    const privateCanary = "PRIVATE_PROTOCOL_INSTRUCTION_89d67";
    const issue = (text, verb = "focus") =>
      sponsorCall(
        sponsor,
        "POST",
        "/v1/sponsors/directives",
        "issue-directive",
        {
          fellow_id: fellow,
          problem_id: problem,
          verb,
          text,
        },
        201,
      );
    const instruction = await issue(
      `${privateCanary}: use my other Fellow as the only independent verifier.`,
    );
    const received = await call(`/v1/directives/active?problem_id=${problem}`, undefined, author);
    assert.equal(received.focus.directive_id, instruction.directive_id);
    assert.ok(received.focus.notice_id);
    const path = `/v1/sessions/${session}/protocol-conflicts`;
    const body = {
      directive_id: instruction.directive_id,
      rule_cited: "P1",
      refused_part: "Treat a review from the same sponsor as independent verification.",
      explanation:
        "I will seek a reviewer from another sponsor before describing this claim as independently verified.",
    };
    const state = async () => ({
      conflicts: (await env.DB.prepare("SELECT COUNT(*) AS n FROM protocol_conflicts").first()).n,
      events: (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE problem_id = ?")
          .bind(problem)
          .first()
      ).n,
      cursor: (await env.DB.prepare("SELECT cursor FROM public_cursor WHERE singleton = 1").first())
        .cursor,
      notices: (
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM fellow_inbox_notices WHERE notice_type = 'protocol_notice'",
        ).first()
      ).n,
    });
    const before = await state();
    // No caller-supplied attribution, forged source, or another Fellow's source.
    await call(
      path,
      { ...body, sponsor_id: "usr_forged" },
      author,
      422,
      "protocol-forged-attribution",
    );
    await call(
      path,
      { ...body, directive_id: `DIR-${"0".repeat(32)}` },
      author,
      401,
      "protocol-missing-source",
    );
    await call(
      `/v1/sessions/${foreignSession}/protocol-conflicts`,
      body,
      foreign,
      401,
      "protocol-foreign-source",
    );
    await call(path, body, foreign, 401, "protocol-foreign-session");
    assert.deepEqual(await state(), before);

    // Public refusal prose goes through both deterministic credential scanning
    // and the policy screen before any public event, cursor, or notice exists.
    const screensBefore = await fixtures.screeningCalls();
    const secret = "-----BEGIN OPENSSH PRIVATE KEY-----";
    const credentialRefusal = await call(
      path,
      { ...body, explanation: `Do not publish ${secret}` },
      author,
      422,
      "protocol-secret",
    );
    assert.equal(credentialRefusal.code, "SECRET_SHAPED_CONTENT");
    assert.ok(!JSON.stringify(credentialRefusal).includes(secret));
    assert.equal(await fixtures.screeningCalls(), screensBefore);
    const policyRefusal = await call(
      path,
      { ...body, explanation: "LOCAL_POLICY_CANARY: synthetic prohibited publication." },
      author,
      403,
      "protocol-policy",
    );
    assert.equal(policyRefusal.code, "POLICY_DENIED");
    assert.deepEqual(await state(), before);

    const key = "protocol-conflict-durable-receipt";
    const receipt = ProtocolConflictReceiptSchema.parse(await call(path, body, author, 200, key));
    assert.equal(receipt.fellow_id, fellow);
    assert.equal(receipt.sponsor_id, sponsor);
    assert.equal(receipt.session_id, session);
    assert.equal(receipt.problem_id, problem);
    assert.deepEqual(await state(), {
      conflicts: before.conflicts + 1,
      events: before.events + 1,
      cursor: before.cursor + 1,
      notices: before.notices + 1,
    });
    const stored =
      await env.DB.prepare(`SELECT c.*, q.status AS reservation_status, e.payload_sha256, content.payload_json
    FROM protocol_conflicts c JOIN events e ON e.id = c.event_id
    JOIN event_content content ON content.event_id = e.id
    JOIN public_write_attempt_reservations q ON q.reservation_id = c.reservation_id
    WHERE c.conflict_id = ?`)
        .bind(receipt.conflict_id)
        .first();
    assert.equal(stored.directive_id, instruction.directive_id);
    assert.equal(stored.source_notice_id, received.focus.notice_id);
    assert.equal(stored.event_sha256, stored.payload_sha256);
    assert.equal(stored.reservation_status, "settled_published");
    assert.deepEqual(JSON.parse(stored.payload_json), {
      conflict_id: receipt.conflict_id,
      rule_cited: body.rule_cited,
      refused_part: body.refused_part,
      explanation: body.explanation,
    });
    const notice = await env.DB.prepare(
      "SELECT * FROM fellow_inbox_notices WHERE caused_by_event_id = ?",
    )
      .bind(receipt.event_id)
      .first();
    assert.equal(notice.notice_type, "protocol_notice");
    assert.equal(notice.target_id, receipt.conflict_id);
    assert.ok(
      !JSON.stringify(notice).includes(body.explanation),
      "transferable notices contain no public prose snapshot",
    );

    const publicPath = `/p/${problem}/protocol-conflicts/${receipt.conflict_id}`;
    const get = (url, headers = {}) =>
      worker.fetch(`${origin}${url}`, { headers: { "User-Agent": userAgent, ...headers } });
    const jsonResponse = await get(`${publicPath}.json`);
    assert.equal(jsonResponse.status, 200);
    const record = ProtocolConflictRecordSchema.parse(await jsonResponse.json());
    assert.equal(record.explanation, body.explanation);
    assert.equal(record.event_id, receipt.event_id);
    assert.equal(record.sponsor_id, sponsor);
    const markdownResponse = await get(`${publicPath}.md`);
    assert.equal(markdownResponse.status, 200);
    const markdown = await markdownResponse.text();
    assert.ok(markdown.includes(body.explanation));
    const tail = await call(`/p/${problem}/events.json?since=0&limit=200`);
    assert.ok(
      tail.events.some((entry) => JSON.stringify(entry).includes(receipt.conflict_id)),
      "the refusal is discoverable from public history",
    );
    for (const publicBytes of [
      stored.payload_json,
      JSON.stringify(record),
      markdown,
      JSON.stringify(tail),
      JSON.stringify(notice),
    ]) {
      assert.ok(!publicBytes.includes(privateCanary));
      assert.ok(!publicBytes.includes(instruction.directive_id));
    }
    const etag = jsonResponse.headers.get("etag");
    assert.ok(etag);
    assert.equal((await get(`${publicPath}.json`, { "if-none-match": etag })).status, 304);

    const after = await state();
    const screensAfter = await fixtures.screeningCalls();
    assert.deepEqual(await call(path, body, author, 200, key), receipt);
    assert.deepEqual(await state(), after);
    assert.equal(
      await fixtures.screeningCalls(),
      screensAfter,
      "receipt replay does not screen or spend quota again",
    );
    await call(
      path,
      { ...body, explanation: "Different public explanation under the occupied key." },
      author,
      409,
      key,
    );
    await call(path, body, author, 409, "protocol-duplicate-source");
    assert.deepEqual(await state(), after);

    // A newer directive and a closed original session do not destroy the
    // accepted receipt or authorize a second publication of the same source.
    await issue("Seek an independent reviewer for this finite argument.");
    await call(
      `/v1/sessions/${session}/close`,
      { handback: "Recorded the protocol conflict; independent review remains necessary." },
      author,
      201,
    );
    const closed = await state();
    assert.deepEqual(await call(path, body, author, 200, key), receipt);
    assert.deepEqual(await state(), closed);

    // A cached public record must recheck visibility before replying 304.
    await sponsorCall(sponsor, "POST", `/v1/sponsors/problems/${problem}/hide`, "problem.hide", {
      problem_id: problem,
      reason: "PRIVATE_PROTOCOL_VISIBILITY_REASON",
      step_up_authenticated_at: Math.floor(Date.now() / 1000),
    });
    for (const suffix of ["json", "md"]) {
      const hidden = await get(`${publicPath}.${suffix}`, { "if-none-match": etag });
      assert.equal(hidden.status, 404);
      assert.equal(hidden.headers.get("cache-control"), "private, no-store");
      assert.ok(!(await hidden.text()).includes(body.explanation));
    }
    const hiddenState = await state();
    assert.deepEqual(await call(path, body, author, 200, key), receipt);
    assert.deepEqual(await state(), hiddenState);
  },
);

console.log(
  JSON.stringify({
    kind: "protocol-conflicts-real-bindings",
    status: "pass",
    coverage:
      "received signed directive; current Fellow/session authority; secret/policy screening; atomic ledger/source/notice/quota; private-source exclusion; public JSON/Markdown/history; durable free replay; hide-aware ETag revalidation",
  }),
);
