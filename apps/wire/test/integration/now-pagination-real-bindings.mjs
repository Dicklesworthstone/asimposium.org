import assert from "node:assert/strict";
import {
  ContractProblemSchema,
  encodeNowPageCursor,
  NowStripResponseSchema,
} from "@asimposium/contracts";
import { ensureProblem, writeLedgerEvent } from "../../src/krater/krater.ts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Production publication plus explicit ordering/visibility fixtures on actual D1.
// Fixture rows prove read semantics; they are not evidence of scientific validation,
// real sponsor enrollment, Google login, deployed caching, or model screening.
async function nowPaginationJourney({ call, enroll, sponsorCall, worker, env, origin, userAgent }) {
  const sponsor = "usr_now_pages";
  const token = await enroll("now-page-author", sponsor);
  async function publish(title, statement, falsifier) {
    const created = await call(
      "/v1/problems",
      {
        title,
        statement,
        falsifier,
        motivation: "Specify the finite domain for independent review.",
        areas: ["combinatorics"],
      },
      token,
      201,
    );
    await sponsorCall(
      sponsor,
      "POST",
      `/v1/sponsors/problems/${created.problem.id}/lifecycle`,
      "problem-lifecycle",
      { action: "publish" },
    );
    return created.problem.id;
  }
  const actualProblem = await publish(
    "Finite path vertices",
    "Every simple path with n edges has n + 1 vertices.",
    "A simple path with a different vertex count.",
  );
  const actual = NowStripResponseSchema.parse(await call("/now.json"));
  assert.equal(actual.events.length, 1);
  assert.equal(actual.events[0].problem_id, actualProblem);
  assert.equal(actual.events[0].type, "problem.admitted");
  const time = "2020-01-01T00:00:00.000Z";
  const problems = ["P-NOW-A", "P-NOW-B", "P-NOW-PRIVATE", "P-NOW-UNLISTED", "P-NOW-UNPUBLISHED"];
  for (const id of problems) {
    await ensureProblem(env.DB, id, time);
    await env.DB.prepare("UPDATE problems SET title = ?, status = ?, unlisted = ? WHERE id = ?")
      .bind(
        "Now ordering fixture",
        id.endsWith("PRIVATE") ? "private-draft" : "active",
        id.endsWith("UNLISTED") ? 1 : 0,
        id,
      )
      .run();
  }
  async function insert(problem, seq, type = "claim.created") {
    const result = await writeLedgerEvent(
      env.DB,
      {
        problemId: problem,
        eventId: `EV-${problem}-${seq}`,
        idempotencyKey: `now-${problem}-${seq}`,
        requestDigest: "0".repeat(64),
        eventType: type,
        objectKind: "claim",
        objectId: `C-${seq}`,
        objectVersion: 1,
        payloadJson: JSON.stringify({ fixture: "Now ordering", seq }),
        createdAt: time,
        attribution: {
          fellowId: "F-NOW-FIXTURE",
          sponsorId: sponsor,
          sessionId: "SES-NOW-FIXTURE",
          modelSelfDeclared: "synthetic",
          harness: "local-ordering-fixture",
        },
      },
      { statementsAfterEvent: () => [] },
    );
    assert.equal(result.seq, seq);
  }
  const expected = [...actual.events];
  for (const problem of problems.slice(0, 2)) {
    for (let seq = 1; seq <= 22; seq++) await insert(problem, seq);
    for (let seq = 22; seq >= 1; seq--)
      expected.push({
        event_id: `EV-${problem}-${seq}`,
        problem_id: problem,
        seq,
        created_at: time,
      });
  }
  await insert("P-NOW-PRIVATE", 1);
  await insert("P-NOW-UNLISTED", 1);
  await insert("P-NOW-UNPUBLISHED", 1);
  // Deliberate projection lag fixture; immutable event/chain bytes stay intact.
  await env.DB.prepare("UPDATE problems SET public_seq = 0 WHERE id = 'P-NOW-UNPUBLISHED'").run();
  await insert("P-NOW-A", 23, "session.closed");
  const first = NowStripResponseSchema.parse(await call("/now.json"));
  assert.equal(first.events.length, 20);
  assert.ok(first.next_before);
  assert.deepEqual(
    first.events.map((e) => e.event_id),
    expected.slice(0, 20).map((e) => e.event_id),
  );
  assert.ok(first.omitted.some((note) => note.includes("live traversal")));

  // A real publication ahead of the boundary must not displace an older page.
  const newerProblem = await publish(
    "Integer square parity",
    "The square of every odd integer is odd.",
    "An odd integer whose square is divisible by two.",
  );
  // An explicitly backfilled fixture after the boundary may appear during live traversal.
  await insert("P-NOW-B", 23);
  expected.splice(23, 0, {
    event_id: "EV-P-NOW-B-23",
    problem_id: "P-NOW-B",
    seq: 23,
    created_at: time,
  });
  const seen = [...first.events];
  let before = first.next_before;
  let pages = 1;
  while (before !== undefined) {
    const page = NowStripResponseSchema.parse(
      await call(`/now.json?before=${encodeURIComponent(before)}`),
    );
    assert.ok(page.events.length <= 20);
    if (page.next_before !== undefined)
      assert.equal(page.next_before, encodeNowPageCursor(page.events.at(-1)));
    seen.push(...page.events);
    before = page.next_before;
    assert.ok(++pages <= 3, "Traversal must terminate within the known fixture bound");
  }
  assert.equal(pages, 3);
  assert.deepEqual(
    seen.map((e) => e.event_id),
    expected.map((e) => e.event_id),
  );
  assert.equal(new Set(seen.map((e) => e.event_id)).size, seen.length);
  assert.ok(!seen.some((e) => e.problem_id === newerProblem));
  assert.ok((await call("/now.json")).events.some((e) => e.problem_id === newerProblem));

  // A valid boundary need not identify an extant event. The fourth ordering key
  // must compare strictly, even when the caller chooses a boundary before its id.
  const boundaryEvent = first.events.at(-1);
  const fabricated = encodeNowPageCursor({ ...boundaryEvent, event_id: "A" });
  const afterFabricated = await call(`/now.json?before=${encodeURIComponent(fabricated)}`);
  assert.equal(afterFabricated.events[0].event_id, boundaryEvent.event_id);

  const paths = ["/now", "/now.json", "/now.md", "/now.html"];
  const openapi = await call("/openapi.json");
  const schema = await call("/schemas/discovery.v1.json");
  assert.ok(schema.properties.now_query.properties.before);
  const suffix = `?before=${encodeURIComponent(first.next_before)}`;
  for (const path of paths) {
    assert.ok(
      openapi.paths[path].get.parameters.some(
        (p) =>
          p.name === "before" && p.schema.$ref.endsWith("/properties/now_query/properties/before"),
      ),
    );
    const response = await worker.fetch(`${origin}${path}${suffix}`, {
      headers: { "User-Agent": userAgent },
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    const etag = response.headers.get("etag");
    assert.ok(etag);
    const conditional = await worker.fetch(`${origin}${path}${suffix}`, {
      headers: { "User-Agent": userAgent, "If-None-Match": etag },
    });
    assert.equal(conditional.status, 304);
    assert.equal(await conditional.text(), "");
    const head = await worker.fetch(`${origin}${path}${suffix}`, {
      method: "HEAD",
      headers: { "User-Agent": userAgent },
    });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("etag"), etag);
    assert.equal(await head.text(), "");
    if (path.endsWith(".html") || path.endsWith(".md")) {
      const matched = text.match(
        path.endsWith(".html") ? /href="([^"]+)"[^>]*>Older events/ : /\[Older events\]\(([^)]+)\)/,
      );
      assert.ok(matched, "The actual shared face must expose a native continuation");
      const follow = await worker.fetch(new URL(matched[1], origin), {
        headers: { "User-Agent": userAgent },
      });
      assert.equal(follow.status, 200);
      const last = await follow.text();
      assert.ok(last.includes("C-1"));
      assert.ok(!last.includes("Older events"));
    }
    for (const query of [
      "?before=invalid-secret-marker",
      `${suffix}&before=x`,
      `${suffix}&unknown=x`,
      "?before=",
      "?cursor=1",
    ]) {
      const error = await call(`${path}${query}`, undefined, undefined, 400);
      ContractProblemSchema.parse(error);
      assert.equal(error.code, "CURSOR_INVALID");
      assert.equal(error.rule, "A5");
      assert.ok(!JSON.stringify(error).includes("invalid-secret-marker"));
    }
  }
  const end = encodeNowPageCursor(seen.at(-1));
  const empty = await call(`/now.json?before=${encodeURIComponent(end)}`);
  assert.deepEqual(empty.events, []);
  assert.equal(empty.next_before, undefined);

  // Reusing an old boundary after withdrawal must check current visibility.
  await env.DB.prepare("UPDATE problems SET unlisted = 1 WHERE id = 'P-NOW-B'").run();
  const hidden = await call(`/now.json${suffix}`);
  assert.ok(hidden.events.every((e) => e.problem_id === "P-NOW-A"));
  assert.equal(hidden.next_before, undefined);
  return {
    kind: "now-pagination-real-bindings",
    status: "pass",
    pages,
    traversed_events: seen.length,
    real_publications: 2,
    fixture_events: 49,
    visible_fixture_events: 45,
    private_unlisted_unpublished_excluded: true,
    live_inserts: true,
    conditional_faces: paths.length,
    malformed_queries: paths.length * 5,
  };
}

runLocalWorkerJourney(nowPaginationJourney)
  .then((receipt) => console.log(JSON.stringify(receipt)))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
