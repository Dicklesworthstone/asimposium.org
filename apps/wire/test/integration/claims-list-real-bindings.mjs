import assert from "node:assert/strict";
import { ContractProblemSchema, FullPackPageSchema } from "@asimposium/contracts";
import { ClaimsListResponseSchema } from "@asimposium/contracts/claims-list";
import { parseClaimsListToon } from "@asimposium/render/claims-list";
import { ensureProblem, writeLedgerEvent } from "../../src/krater/krater.ts";
import { appendClaimsListFixture } from "../support/claims-list-fixture.ts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

assert.equal(process.versions.bun, undefined, "This lane requires genuine Node");

// Actual Workerd HTTP and D1 reads over explicit immutable-publication fixtures.
// These fixtures exercise collection selection and controls; they are not proof
// of scientific admission, sponsor enrollment, model screening or deployed caching.
const problem = "P-CLAIMS-PAGES";

/** Consume served Markdown controls, not an internal composition object.
 * The renderer prevents public source bodies from forging these delimiters. */
function publicFullPage(body) {
  const items = [
    ...body.matchAll(
      /^<!-- asimp:item id=(\S+) kind=(\S+) scope=\S+ untrusted=(?:true|false)(?: tokens=\d+)? -->\n([\s\S]*?)^<!-- asimp:item-end id=\1 -->$/gm,
    ),
  ];
  const controls = items.filter((item) => item[2] === "full-page");
  assert.equal(controls.length, 1, "Full Markdown supplies exactly one page control");
  const decode = (item) => JSON.parse(item[3].match(/^\{.*\}$/m)?.[0] ?? "null");
  const control = FullPackPageSchema.parse(decode(controls[0]));
  const records = items
    .filter((item) => item[2] === "full-event")
    .map((item) => {
      const record = decode(item);
      assert.equal(item[1], `FULL-${record.seq}`);
      return record;
    });
  assert.equal(records.length, control.records);
  assert.ok(records.length <= 20);
  assert.deepEqual(
    records.map((record) => record.seq),
    Array.from({ length: control.records }, (_, index) => control.after + index + 1),
    "Continuation advances only across contiguous represented event sequences",
  );
  assert.ok(body.includes(`profile=full cursor=${control.through}`));
  assert.ok(
    Buffer.byteLength(body, "utf8") <= 32_000,
    "The rendered full page respects its 8,000-token byte estimate",
  );
  return { control, records };
}

async function claimsListJourney({ call, worker, env, origin, userAgent }) {
  await ensureProblem(env.DB, problem, "2026-10-27T12:00:00.000Z");
  await env.DB.prepare(
    "UPDATE problems SET title='Claims pagination fixture',status='active' WHERE id=?",
  )
    .bind(problem)
    .run();
  for (let number = 1; number <= 205; number++) {
    await appendClaimsListFixture(env.DB, problem, number);
  }
  const list = async (query = "") =>
    ClaimsListResponseSchema.parse(await call(`/p/${problem}/claims.json${query}`));
  const toon = async (query = "") => {
    const params = new URLSearchParams(query);
    params.set("format", "toon");
    const url = `${origin}/p/${problem}/claims?${params}`;
    const response = await worker.fetch(url, { headers: { "User-Agent": userAgent } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/toon; charset=utf-8");
    const body = await response.text();
    return { url, response, body, face: parseClaimsListToon(body) };
  };
  const full = async (path, headers = {}) => {
    const url = new URL(path, origin);
    const response = await worker.fetch(url, {
      headers: { "User-Agent": userAgent, ...headers },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/markdown; charset=utf-8");
    const body = await response.text();
    const page = publicFullPage(body);
    const nextMatch = response.headers.get("link")?.match(/<([^>]+)>; rel="next"/);
    const next = nextMatch ? new URL(nextMatch[1], origin) : null;
    assert.equal(next !== null, page.control.has_more);
    if (next !== null) {
      assert.equal(next.origin, origin);
      assert.equal(next.pathname, `/p/${problem}/full.md`);
      assert.equal(next.searchParams.get("through"), String(page.control.through));
      assert.equal(next.searchParams.get("after"), String(page.control.next_after));
      assert.ok(
        body.includes(`${next.pathname}${next.search}`),
        "The same continuation is in next_actions",
      );
    }
    return { ...page, response, body, next };
  };
  const first = await list();
  assert.deepEqual((await toon()).face, first);
  assert.equal(first.cursor, 205);
  assert.equal(first.count, 8);
  assert.equal(first.next_after, 8);
  const firstFullPath = `/p/${problem}/full.md?through=${first.cursor}&after=0`;
  const firstFull = await full(firstFullPath);
  assert.equal(firstFull.control.through, first.cursor);
  assert.ok(firstFull.control.records > 0);
  assert.equal(firstFull.control.has_more, true);
  const fullEtag = firstFull.response.headers.get("etag");
  assert.ok(fullEtag);

  // A later mutable head cannot reorder or replace the captured publications.
  await appendClaimsListFixture(env.DB, problem, 1, 2);
  await appendClaimsListFixture(env.DB, problem, 206);
  const seen = [...first.claims];
  let after = first.next_after;
  let pages = 1;
  while (after !== null) {
    const page = await list(`?through=${first.cursor}&after=${after}`);
    assert.deepEqual((await toon(`?through=${first.cursor}&after=${after}`)).face, page);
    assert.equal(page.cursor, first.cursor);
    assert.ok(page.claims.length <= 8);
    seen.push(...page.claims);
    after = page.next_after;
    assert.ok(++pages <= 26, "The known fixture collection must terminate");
  }
  assert.equal(pages, 26);
  assert.deepEqual(
    seen.map((claim) => claim.id),
    Array.from({ length: 205 }, (_, i) => `C-${i + 1}`),
  );
  assert.equal(new Set(seen.map((claim) => claim.id)).size, 205);
  assert.ok(seen.every((claim) => claim.version === 1));
  const fullRecords = [...firstFull.records];
  let fullNext = firstFull.next;
  let fullPages = 1;
  while (fullNext !== null) {
    const page = await full(fullNext);
    assert.equal(page.control.through, first.cursor);
    assert.ok(page.records.length > 0);
    fullRecords.push(...page.records);
    fullNext = page.next;
    assert.ok(++fullPages <= 205, "The frozen full export must terminate");
  }
  assert.deepEqual(
    fullRecords.map((record) => record.seq),
    Array.from({ length: 205 }, (_, i) => i + 1),
  );
  assert.equal(new Set(fullRecords.map((record) => record.seq)).size, 205);
  for (const [index, record] of fullRecords.entries()) {
    const number = index + 1;
    assert.equal(record.publication.object_id, `C-${number}`);
    assert.equal(record.publication.object_version, 1);
    assert.equal(record.content_omitted, null);
    assert.equal(
      record.content.statement,
      `Let the fixture path ${number} have 1 distinguished endpoints.`,
    );
    assert.equal(record.content_url, `/p/${problem}/claims/C-${number}@1.json?through=205`);
    for (const privateField of ["writer_credential_id", "private_context", "workshop_id"])
      assert.ok(!Object.hasOwn(record.content, privateField));
  }
  const laterFull = await full(`/p/${problem}/full.md?through=207&after=205`);
  assert.deepEqual(
    laterFull.records.map((record) => [
      record.seq,
      record.publication.object_id,
      record.publication.object_version,
    ]),
    [
      [206, "C-1", 2],
      [207, "C-206", 1],
    ],
  );
  assert.equal(laterFull.next, null);
  assert.equal(
    laterFull.records[0].content.statement,
    "Let the fixture path 1 have 2 distinguished endpoints.",
  );
  const latest = await list("?after=205");
  assert.deepEqual(
    latest.claims.map((claim) => [claim.id, claim.version]),
    [
      ["C-1", 2],
      ["C-206", 1],
    ],
  );

  const openapi = await call("/openapi.json");
  for (const name of ["through", "after"])
    assert.ok(
      openapi.paths["/p/{id}/full.md"].get.parameters.some((parameter) => parameter.name === name),
    );
  for (const method of ["GET", "HEAD"]) {
    const conditional = await worker.fetch(new URL(firstFullPath, origin), {
      method,
      headers: { "User-Agent": userAgent, "If-None-Match": fullEtag },
    });
    assert.equal(conditional.status, 304);
    assert.equal(await conditional.text(), "");
  }
  const fullHead = await worker.fetch(new URL(firstFullPath, origin), {
    method: "HEAD",
    headers: { "User-Agent": userAgent },
  });
  assert.equal(fullHead.status, 200);
  assert.equal(fullHead.headers.get("etag"), fullEtag);
  assert.equal(await fullHead.text(), "");
  for (const query of [
    "through=208",
    "through=205&after=206",
    "through=205&through=204",
    "after=1",
    "after=9007199254740992",
    "through=0205",
    "unknown=private-full-query-marker",
  ]) {
    const refused = ContractProblemSchema.parse(
      await call(`/p/${problem}/full.md?${query}`, undefined, undefined, 400),
    );
    assert.equal(refused.code, "CURSOR_INVALID");
    assert.ok(!JSON.stringify(refused).includes("private-full-query-marker"));
  }
  const schema = await call("/schemas/claims-list.v1.json");
  assert.ok(schema.properties.query.properties.through);
  assert.ok(schema.properties.query.properties.after);
  assert.deepEqual(schema.properties.query.properties.format.enum, ["json", "md", "html", "toon"]);
  assert.ok(schema.properties.response.properties.claims);
  const suffix = "?through=205&after=0";
  const paths = ["claims", "claims.json", "claims.md", "claims.html"];
  let jsonEtag;
  for (const path of paths) {
    const operation = openapi.paths[`/p/{id}/${path}`].get;
    for (const name of ["through", "after", "format"]) {
      assert.ok(
        operation.parameters.some(
          (parameter) =>
            parameter.name === name &&
            parameter.schema.$ref.endsWith(`/properties/query/properties/${name}`),
        ),
      );
    }
    if (path === "claims.json") {
      assert.ok(
        operation.responses["200"].content["application/json"].schema.$ref.endsWith(
          "claims-list.v1.json#/properties/response",
        ),
      );
    }
    const url = `${origin}/p/${problem}/${path}${suffix}`;
    const response = await worker.fetch(url, { headers: { "User-Agent": userAgent } });
    assert.equal(response.status, 200);
    const bytes = await response.text();
    const etag = response.headers.get("etag");
    assert.ok(etag);
    if (path === "claims.json") jsonEtag = etag;
    else {
      assert.ok(bytes.includes("C-1%401"), "Exact statement links retain version 1");
      assert.ok(bytes.includes("through=205"));
    }
    const next = response.headers.get("link").match(/<([^>]+)>; rel="next"/);
    assert.ok(next, "Every face supplies a native bounded continuation");
    const nextUrl = new URL(next[1], origin);
    assert.equal(nextUrl.searchParams.get("through"), "205");
    assert.equal(nextUrl.searchParams.get("after"), "8");
    const followed = await worker.fetch(nextUrl, { headers: { "User-Agent": userAgent } });
    assert.equal(followed.status, 200);
    assert.ok((await followed.text()).includes("C-9"));
    const conditional = await worker.fetch(url, {
      headers: { "User-Agent": userAgent, "If-None-Match": etag },
    });
    assert.equal(conditional.status, 304);
    assert.equal(await conditional.text(), "");
    const head = await worker.fetch(url, { method: "HEAD", headers: { "User-Agent": userAgent } });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("etag"), etag);
    assert.equal(await head.text(), "");
    for (const query of [
      "through=208",
      "through=205&after=206",
      "through=205&through=204",
      "after=9007199254740992",
      "through=0205",
      "unknown=private-query-marker",
    ]) {
      const refused = await call(`/p/${problem}/${path}?${query}`, undefined, undefined, 400);
      ContractProblemSchema.parse(refused);
      assert.equal(refused.code, "CURSOR_INVALID");
      assert.ok(!JSON.stringify(refused).includes("private-query-marker"));
    }
  }

  const capturedToon = await toon(suffix);
  assert.deepEqual(capturedToon.face, await list(suffix));
  const toonEtag = capturedToon.response.headers.get("etag");
  assert.ok(toonEtag);
  assert.notEqual(toonEtag, jsonEtag);
  assert.ok(openapi.paths["/p/{id}/claims"].get.responses["200"].content["text/toon"]);
  const location = new URL(capturedToon.response.headers.get("content-location"), origin);
  assert.equal(location.searchParams.get("format"), "toon");
  assert.equal(location.searchParams.get("through"), "205");
  const nextToon = capturedToon.response.headers.get("link").match(/<([^>]+)>; rel="next"/);
  assert.ok(nextToon);
  const nextToonUrl = new URL(nextToon[1], origin);
  assert.equal(nextToonUrl.origin, origin);
  assert.equal(nextToonUrl.searchParams.get("format"), "toon");
  assert.equal(nextToonUrl.searchParams.get("through"), "205");
  assert.equal(nextToonUrl.searchParams.get("after"), "8");
  const followedToon = await worker.fetch(nextToonUrl, { headers: { "User-Agent": userAgent } });
  assert.deepEqual(
    parseClaimsListToon(await followedToon.text()),
    await list("?through=205&after=8"),
  );
  for (const method of ["GET", "HEAD"]) {
    const conditional = await worker.fetch(capturedToon.url, {
      method,
      headers: { "User-Agent": userAgent, "If-None-Match": toonEtag },
    });
    assert.equal(conditional.status, 304);
    assert.equal(await conditional.text(), "");
  }
  const toonHead = await worker.fetch(capturedToon.url, {
    method: "HEAD",
    headers: { "User-Agent": userAgent },
  });
  assert.equal(toonHead.status, 200);
  assert.equal(toonHead.headers.get("etag"), toonEtag);
  assert.equal(await toonHead.text(), "");
  const negotiated = await worker.fetch(`${origin}/p/${problem}/claims${suffix}`, {
    headers: { "User-Agent": userAgent, accept: "text/toon" },
  });
  assert.equal(negotiated.headers.get("content-type"), "text/toon; charset=utf-8");
  assert.equal(await negotiated.text(), capturedToon.body);
  const forcedJson = await call(`/p/${problem}/claims.json${suffix}&format=toon`);
  assert.deepEqual(forcedJson, capturedToon.face);
  const unknownFormat = ContractProblemSchema.parse(
    await call(`/p/${problem}/claims?format=private-format-marker`, undefined, undefined, 400),
  );
  assert.equal(unknownFormat.code, "UNKNOWN_FORMAT");
  assert.deepEqual(unknownFormat.allowed, ["json", "md", "html", "toon"]);
  assert.ok(!JSON.stringify(unknownFormat).includes("private-format-marker"));
  const repeatedFormat = await call(
    `/p/${problem}/claims?format=toon&format=json`,
    undefined,
    undefined,
    400,
  );
  assert.equal(repeatedFormat.code, "CURSOR_INVALID");

  let controlId = 0;
  async function hide(target, kind = "claim") {
    await env.DB.prepare(`INSERT INTO content_controls
      (control_id,problem_id,target_kind,target_ref,visibility,source,reason_category,actor,reason,version,created_at)
      VALUES(?,?,?,?,'hidden','operator','privacy','claims-fixture','Read visibility fixture.',1,?)`)
      .bind(`CC-CLAIMS-${++controlId}`, problem, kind, target, "2026-10-28T12:00:00.000Z")
      .run();
  }
  for (let number = 1; number <= 8; number++) await hide(`C-${number}`);
  const hiddenFull = await full(firstFullPath, { "If-None-Match": fullEtag });
  assert.notEqual(hiddenFull.response.headers.get("etag"), fullEtag);
  assert.equal(hiddenFull.control.after, 0);
  assert.equal(hiddenFull.control.through, first.cursor);
  assert.ok(hiddenFull.body.includes("content_unavailable"));
  const hiddenFullRecords = hiddenFull.records.filter((record) => record.seq <= 8);
  assert.equal(hiddenFullRecords.length, 8);
  for (const record of hiddenFullRecords) {
    // Canonical public-tail policy retains immutable envelopes after hiding
    // public objects; their source bodies and causal ancestry are withheld.
    assert.equal(record.publication.object_id, `C-${record.seq}`);
    assert.equal(record.publication.causality_omitted, "unavailable");
    assert.equal(record.content, null);
    assert.equal(record.content_omitted, "content_unavailable");
    assert.ok(!hiddenFull.body.includes(`Let the fixture path ${record.seq} have`));
  }
  const hiddenResponse = await worker.fetch(`${origin}/p/${problem}/claims.json${suffix}`, {
    headers: { "User-Agent": userAgent, "If-None-Match": jsonEtag },
  });
  assert.equal(hiddenResponse.status, 200, "Conditional history rechecks present-day controls");
  const hidden = ClaimsListResponseSchema.parse(await hiddenResponse.json());
  assert.deepEqual(hidden.claims, []);
  assert.equal(hidden.next_after, 8);
  assert.deepEqual(hidden.omitted, ["content_unavailable", "page_limit"]);
  const hiddenToon = await worker.fetch(capturedToon.url, {
    headers: { "User-Agent": userAgent, "If-None-Match": toonEtag },
  });
  assert.equal(hiddenToon.status, 200);
  assert.deepEqual(parseClaimsListToon(await hiddenToon.text()), hidden);
  assert.ok(!JSON.stringify(hidden).includes("C-1"));
  assert.equal((await list("?through=205&after=8")).claims[0].id, "C-9");

  await appendClaimsListFixture(env.DB, problem, 9, 2);
  await hide("C-9@2");
  const hiddenRevision = await list("?after=207");
  assert.deepEqual((await toon("?after=207")).face, hiddenRevision);
  assert.deepEqual(hiddenRevision.claims, []);
  assert.ok(hiddenRevision.omitted.includes("content_unavailable"));
  assert.equal((await list("?through=205&after=8")).claims[0].version, 1);
  await hide("#10", "event");
  await env.DB.prepare(
    "UPDATE event_content SET redacted_at=?,redaction_reason='privacy' WHERE event_id=?",
  )
    .bind("2026-10-28T12:00:00.000Z", `EV-${problem}-11-1`)
    .run();
  const withheld = await list("?through=205&after=8");
  assert.deepEqual((await toon("?through=205&after=8")).face, withheld);
  assert.ok(withheld.claims.every((claim) => claim.id !== "C-10" && claim.id !== "C-11"));
  assert.ok(withheld.omitted.includes("content_unavailable"));

  // A full export also represents non-claim, oversized and withheld producers.
  // These are explicit immutable-source fixtures, not a scientific-write test.
  const privateMarker = "PRIVATE-FULL-READER-BOOKKEEPING";
  const unsupportedMarker = "UNSUPPORTED-FULL-PUBLICATION-BODY";
  const hypothesis = {
    route: "Inspect a finite path before choosing an attack route.",
    mechanism: "Enumerate its endpoints and compare the exact incidence relation.",
    falsifier: "A path with a third endpoint would reject the proposed route.",
    origin: "proposed",
    body_md: "This is a source-reading fixture, not a scientific result.",
  };
  const recordsToAppend = [
    ["hypothesis.created", "hypothesis", "H-1", { ...hypothesis, private_context: privateMarker }],
    [
      "hypothesis.created",
      "hypothesis",
      "H-2",
      { ...hypothesis, body_md: "Large public body. ".repeat(1500) },
    ],
    ["workshop.updated", "workshop", "W-PRIVATE-FULL", { body_md: privateMarker }],
    ["problem.published", "problem", problem, { body_md: unsupportedMarker }],
  ];
  for (const [index, [eventType, objectKind, objectId, payload]] of recordsToAppend.entries()) {
    await writeLedgerEvent(
      env.DB,
      {
        problemId: problem,
        eventId: `EV-${problem}-FULL-${index}`,
        idempotencyKey: `fixture-${problem}-full-${index}`,
        requestDigest: "b".repeat(64),
        eventType,
        objectKind,
        objectId,
        objectVersion: 1,
        createdAt: "2026-10-27T12:00:00.000Z",
        payloadJson: JSON.stringify(payload),
        attribution: {
          fellowId: "F-CLAIMS-FIXTURE",
          sponsorId: "usr_claims_fixture",
          sessionId: "S-CLAIMS-FIXTURE",
          modelSelfDeclared: "synthetic",
          harness: "read-fixture",
        },
      },
      { statementsAfterEvent: () => [] },
    );
  }
  const mixedFull = await full(`/p/${problem}/full.md?through=212&after=208`);
  assert.deepEqual(
    mixedFull.records.map((record) => record.seq),
    [209, 210, 211, 212],
  );
  assert.equal(mixedFull.next, null);
  assert.equal(mixedFull.records[0].publication.object_kind, "hypothesis");
  assert.deepEqual(mixedFull.records[0].content, hypothesis);
  assert.equal(mixedFull.records[0].content_omitted, null);
  assert.equal(mixedFull.records[1].content, null);
  assert.equal(mixedFull.records[1].content_omitted, "item_size_limit");
  assert.equal(mixedFull.records[1].content_url, `/p/${problem}/hypotheses/H-2.json?through=212`);
  assert.equal(mixedFull.records[2].publication, null);
  assert.equal(mixedFull.records[2].content, null);
  assert.equal(mixedFull.records[2].content_omitted, "undisclosed_event");
  assert.equal(mixedFull.records[3].publication.object_kind, "problem");
  assert.equal(mixedFull.records[3].content, null);
  assert.equal(mixedFull.records[3].content_omitted, "unsupported_record");
  assert.ok(!mixedFull.body.includes(privateMarker));
  assert.ok(!mixedFull.body.includes(unsupportedMarker));
  assert.ok(!mixedFull.body.includes("Large public body."));

  // A completely withheld first window still advances contiguously. Applying
  // these controls after the original page was read never hides a skipped gap.
  for (let number = 9; number <= 20; number++) await hide(`C-${number}`);
  const allHiddenFull = await full(firstFullPath, { "If-None-Match": fullEtag });
  assert.equal(allHiddenFull.control.after, 0);
  assert.equal(allHiddenFull.control.through, first.cursor);
  assert.ok(allHiddenFull.records.length > 0);
  assert.ok(
    allHiddenFull.records.every(
      (record) => record.content === null && record.content_omitted === "content_unavailable",
    ),
  );
  assert.ok(allHiddenFull.body.includes("content_unavailable"));
  assert.ok(!allHiddenFull.body.includes("Let the fixture path"));
  assert.ok(allHiddenFull.next !== null);
  const followingFull = await full(allHiddenFull.next);
  assert.equal(followingFull.records[0].seq, allHiddenFull.control.next_after + 1);
  assert.ok(followingFull.records[0].content !== null);

  await env.DB.prepare("UPDATE problems SET unlisted=1 WHERE id=?").bind(problem).run();
  const unlistedFull = await full(firstFullPath);
  assert.equal(unlistedFull.response.headers.get("cache-control"), "private, no-store");
  assert.ok(unlistedFull.response.headers.get("x-robots-tag").includes("noindex"));
  const unlisted = await worker.fetch(`${origin}/p/${problem}/claims.json${suffix}`, {
    headers: { "User-Agent": userAgent },
  });
  assert.equal(unlisted.status, 200);
  assert.equal(unlisted.headers.get("cache-control"), "private, no-store");
  assert.ok(unlisted.headers.get("x-robots-tag").includes("noindex"));
  const unlistedToon = await toon(suffix);
  assert.equal(unlistedToon.response.headers.get("cache-control"), "private, no-store");
  assert.ok(unlistedToon.response.headers.get("x-robots-tag").includes("noindex"));
  await hide("problem", "problem");
  const hiddenProblemFull = await worker.fetch(new URL(firstFullPath, origin), {
    headers: { "User-Agent": userAgent, "If-None-Match": fullEtag },
  });
  assert.equal(hiddenProblemFull.status, 404);
  assert.equal((await hiddenProblemFull.json()).code, "PROBLEM_NOT_FOUND");
  for (const path of paths) {
    const refused = await call(`/p/${problem}/${path}${suffix}`, undefined, undefined, 404);
    assert.equal(refused.code, "PROBLEM_NOT_FOUND");
  }
  assert.equal(
    (await call(`/p/${problem}/claims${suffix}&format=toon`, undefined, undefined, 404)).code,
    "PROBLEM_NOT_FOUND",
  );
  return {
    kind: "claims-list-real-bindings",
    status: "pass",
    pages,
    traversed_claims: seen.length,
    snapshot_survives_revision_and_append: true,
    withheld_page_advances: true,
    hidden_revision_never_resurrects_predecessor: true,
    current_controls_at_historical_cut: true,
    conditional_faces: paths.length + 1,
    malformed_queries: paths.length * 6 + 2,
    toon_pages_equal_canonical_json: pages,
    public_full_pages: fullPages,
    public_full_sequences: fullRecords.length,
    public_full_frozen_cursor: firstFull.control.through,
    public_full_hidden_window_continuation: true,
    public_full_strict_queries_and_conditional_visibility: true,
    public_full_typed_nonclaim_and_explicit_omissions: true,
  };
}

// An isolated source-fault experiment forces only the formatter to fail.
// Without that fault this mode must fail its expected500 assertion; it never
// substitutes for the ordinary successful TOON journey above.
async function claimsToonRecoveryJourney({ call, env, worker, origin, userAgent }) {
  await ensureProblem(env.DB, problem, "2026-10-27T12:00:00.000Z");
  await env.DB.prepare("UPDATE problems SET status='active' WHERE id=?").bind(problem).run();
  await appendClaimsListFixture(env.DB, problem, 1);
  const captured = ClaimsListResponseSchema.parse(await call(`/p/${problem}/claims.json`));
  const failed = await worker.fetch(`${origin}/p/${problem}/claims?format=toon`, {
    headers: { "User-Agent": userAgent },
  });
  assert.equal(failed.status, 500, "this isolated mode requires the formatter source fault");
  const refusal = ContractProblemSchema.parse(await failed.json());
  assert.equal(refusal.code, "FORMAT_UNAVAILABLE");
  assert.equal(refusal.schema, "https://a.asimposium.org/schemas/claims-list.v1.json");
  const path = refusal.example.path;
  assert.equal(typeof path, "string");
  const recovery = new URL(path, "https://a.asimposium.org");
  assert.equal(recovery.origin, "https://a.asimposium.org");
  assert.equal(recovery.pathname, `/p/${problem}/claims.json`);
  assert.equal(recovery.searchParams.get("through"), String(captured.cursor));
  assert.equal(recovery.searchParams.get("after"), String(captured.after));
  assert.ok(refusal.fix_hint.includes(path));
  await appendClaimsListFixture(env.DB, problem, 2);
  const later = ClaimsListResponseSchema.parse(await call(`/p/${problem}/claims.json`));
  assert.ok(later.cursor > captured.cursor, "a genuine later publication advances the head");
  assert.deepEqual(
    ClaimsListResponseSchema.parse(await call(`${recovery.pathname}${recovery.search}`)),
    captured,
    "the offered JSON recovers the captured page after a later write",
  );
  return {
    kind: "claims-toon-recovery-real-bindings",
    status: "pass",
    scope: "isolated source-forced formatter failure; not a normal TOON success",
    captured_cursor: captured.cursor,
    later_cursor: later.cursor,
  };
}

runLocalWorkerJourney(
  process.argv.includes("--formatter-failure") ? claimsToonRecoveryJourney : claimsListJourney,
  {
    // Explicit source/projection fixtures above bypass the publication writers.
    projectionParitySeeded: (id) => id === problem,
    // These two fixtures exercise undisclosed/private and legacy unsupported
    // envelope policies; neither is emitted by a current public writer.
    laneEventTypes: ["workshop.updated", "problem.published"],
  },
)
  .then((receipt) => console.log(JSON.stringify(receipt)))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
