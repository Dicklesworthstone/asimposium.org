import assert from "node:assert/strict";
import {
  ContractProblemSchema,
  encodeNowPageCursor,
  NowStripResponseSchema,
} from "@asimposium/contracts";
import {
  canonicalRevisionPayload,
  ensureProblem,
  writeLedgerEvent,
} from "../../src/krater/krater.ts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Production publication plus explicit ordering/visibility fixtures on actual D1.
// Fixture rows prove read semantics; they are not evidence of scientific validation,
// real sponsor enrollment, Google login, deployed caching, or model screening.
async function nowPaginationJourney({
  call,
  enroll,
  sponsorCall,
  reviseStatement,
  worker,
  env,
  origin,
  userAgent,
}) {
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
  let fixtureEvents = 0;
  async function insert(problem, seq, type = "claim.created", options = {}) {
    const result = await writeLedgerEvent(
      env.DB,
      {
        problemId: problem,
        eventId: `EV-${problem}-${seq}`,
        idempotencyKey: `now-${problem}-${seq}`,
        requestDigest: "0".repeat(64),
        eventType: type,
        objectKind: options.objectKind ?? "claim",
        objectId: options.objectId ?? `C-${seq}`,
        objectVersion: options.objectVersion ?? 1,
        payloadJson:
          options.payloadJson ??
          JSON.stringify(options.payload ?? { fixture: "Now ordering", seq }),
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
    fixtureEvents++;
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

  // Real Fellow-authored proposal -> sponsor review -> statement publication.
  // Activation must not retroactively turn that sharpening work into process.
  await reviseStatement(actualProblem, sponsor, token, {
    statement: "Every finite simple path with n edges has exactly n + 1 distinct vertices.",
    falsifier: "A finite simple path whose vertex count differs from its edge count plus one.",
    motivation: "Make the finite domain explicit before scientific review.",
  });
  const revised = await env.DB.prepare(
    "SELECT id,seq FROM events WHERE problem_id=? AND type='problem.statement-revised' AND object_version=2",
  )
    .bind(actualProblem)
    .first();
  assert.ok(revised);
  const reviewer = await enroll("now-page-reviewer", "usr_now_reviewer");
  const session = await call(
    "/v1/sessions",
    { problem_id: actualProblem, intent: "review" },
    reviewer,
    201,
  );
  await call(
    `/v1/problems/${actualProblem}/statement-review`,
    {
      session_id: session.session_id,
      statement_version: 2,
      verdict: "statement-clear",
      basis: "The finite simple-path domain and vertex-count counterexample are explicit.",
    },
    reviewer,
  );
  const activated = NowStripResponseSchema.parse(await call("/now.json"));
  const sharpening = activated.events.find((event) => event.event_id === revised.id);
  assert.equal(sharpening?.type, "problem.statement-revised");
  assert.ok(sharpening.summary.includes("S@2 during sharpening"));
  assert.ok(!sharpening.summary.includes("A Fellow"));
  await reviseStatement(actualProblem, sponsor, token, {
    statement:
      "For every finite simple path, its distinct-vertex count equals its edge count plus one.",
    falsifier: "A finite simple path with unequal vertex and edge-plus-one counts.",
    motivation: "Restate the same finite condition after activation.",
  });
  const afterRevision = NowStripResponseSchema.parse(await call("/now.json"));
  assert.ok(afterRevision.events.some((event) => event.event_id === revised.id));
  assert.equal(
    afterRevision.events.filter((event) => event.type === "problem.statement-revised").length,
    1,
  );
  const linked = await call(
    `/p/${actualProblem}/events.json?since=${revised.seq - 1}&limit=1&through=${revised.seq}`,
  );
  assert.equal(linked.events[0].event.id, revised.id);
  assert.equal(linked.events[0].event.object_version, 2);
  assert.equal(linked.events.length, 1);
  for (const face of ["md", "html"]) {
    const response = await worker.fetch(`${origin}/now.${face}`, {
      headers: { "User-Agent": userAgent },
    });
    const text = await response.text();
    const link =
      face === "md"
        ? `/p/${actualProblem}/events.md?since=${revised.seq - 1}&limit=1&through=${revised.seq}`
        : `/p/${actualProblem}/events.md?since=${revised.seq - 1}&amp;limit=1&amp;through=${revised.seq}`;
    assert.ok(text.includes(link));
    const followed = await worker.fetch(`${origin}${link.replaceAll("&amp;", "&")}`, {
      headers: { "User-Agent": userAgent },
    });
    assert.equal(followed.status, 200);
    assert.ok((await followed.text()).includes(revised.id));
  }

  // Explicit malformed/low-substance read fixtures sit ahead of real material
  // rows. Filtering and source validation cannot strand those older rows.
  const materialProblem = "P-NOW-MATERIAL";
  await ensureProblem(env.DB, materialProblem, time);
  await env.DB.prepare("UPDATE problems SET status='active' WHERE id=?")
    .bind(materialProblem)
    .run();
  await insert(materialProblem, 1, "claim.created", {
    payload: {
      claim_id: "C-1",
      kind: "conjecture",
      statement: "Every finite simple path with n edges has n + 1 vertices.",
      falsifier: "A finite simple path with a different vertex count.",
    },
  });
  await insert(materialProblem, 2, "claim.revised", {
    objectId: "C-1",
    objectVersion: 2,
    payloadJson: canonicalRevisionPayload({
      claimId: "C-1",
      baseVersion: 1,
      kind: "conjecture",
      statement: "Every finite simple path with n edges has exactly n + 1 distinct vertices.",
      falsifier: "A finite simple path with a different distinct-vertex count.",
    }),
  });
  for (let seq = 3; seq <= 28; seq++)
    await insert(materialProblem, seq, "dead_end.recorded", {
      objectKind: "dead_end",
      objectId: `DE-${seq}`,
      payload: { approach: "Thin fixture", flags: ["low-substance-dead-end"] },
    });
  for (let seq = 29; seq <= 53; seq++)
    await insert(materialProblem, seq, "problem.statement-revised", {
      objectKind: "problem",
      objectId: materialProblem,
      objectVersion: seq,
      payload: {
        previous_status: "sharpening",
        fixture: "Missing exact governance source identity",
      },
    });
  const materialSeen = [];
  let materialBefore;
  for (let pageNumber = 0; pageNumber < 8; pageNumber++) {
    const page = NowStripResponseSchema.parse(
      await call(
        `/now.json${materialBefore === undefined ? "" : `?before=${encodeURIComponent(materialBefore)}`}`,
      ),
    );
    materialSeen.push(...page.events);
    materialBefore = page.next_before;
    if (materialBefore === undefined) break;
  }
  assert.equal(materialBefore, undefined, "Filtered traversal must terminate");
  assert.equal(new Set(materialSeen.map((event) => event.event_id)).size, materialSeen.length);
  assert.deepEqual(
    materialSeen
      .filter((event) => event.problem_id === materialProblem)
      .map((event) => [event.seq, event.type]),
    [
      [2, "claim.revised"],
      [1, "claim.promoted"],
    ],
  );
  return {
    kind: "now-pagination-real-bindings",
    status: "pass",
    pages,
    traversed_events: seen.length,
    real_publications: 2,
    fixture_events: fixtureEvents,
    visible_fixture_events: 45,
    private_unlisted_unpublished_excluded: true,
    live_inserts: true,
    conditional_faces: paths.length,
    malformed_queries: paths.length * 5,
    historical_sharpening_after_activation: true,
    active_statement_revisions_excluded: true,
    claim_revisions_discoverable: true,
    low_substance_and_invalid_sources_do_not_strand_older_work: true,
    publication_links_followed: 2,
  };
}

// Seeds P-NOW-* problems with ledger rows the parity sweep skips (pagination
// fixtures); every other problem is compared. "session.closed" is a fixture
// type the Worker never writes (the strip must skip it).
runLocalWorkerJourney(nowPaginationJourney, {
  projectionParitySeeded: (id) => id.startsWith("P-NOW-"),
  laneEventTypes: ["session.closed"],
})
  .then((receipt) => console.log(JSON.stringify(receipt)))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
