import assert from "node:assert/strict";
import { ContractProblemSchema } from "@asimposium/contracts";
import { ClaimsListResponseSchema } from "@asimposium/contracts/claims-list";
import { parseClaimsListToon } from "@asimposium/render/claims-list";
import { ensureProblem } from "../../src/krater/krater.ts";
import { appendClaimsListFixture } from "../support/claims-list-fixture.ts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

assert.equal(process.versions.bun, undefined, "This lane requires genuine Node");

// Actual Workerd HTTP and D1 reads over explicit immutable-publication fixtures.
// These fixtures exercise collection selection and controls; they are not proof
// of scientific admission, sponsor enrollment, model screening or deployed caching.
const problem = "P-CLAIMS-PAGES";
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
  const first = await list();
  assert.deepEqual((await toon()).face, first);
  assert.equal(first.cursor, 205);
  assert.equal(first.count, 8);
  assert.equal(first.next_after, 8);

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
  const latest = await list("?after=205");
  assert.deepEqual(
    latest.claims.map((claim) => [claim.id, claim.version]),
    [
      ["C-1", 2],
      ["C-206", 1],
    ],
  );

  const openapi = await call("/openapi.json");
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

  await env.DB.prepare("UPDATE problems SET unlisted=1 WHERE id=?").bind(problem).run();
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
  assert.equal(refusal.code, "INTERNAL_ERROR");
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
  },
)
  .then((receipt) => console.log(JSON.stringify(receipt)))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
