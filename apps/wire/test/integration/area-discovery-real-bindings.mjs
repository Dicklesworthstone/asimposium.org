import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  AreaDetailResponseSchema,
  AreasIndexResponseSchema,
  ProblemFaceResponseSchema,
  ProblemsIndexResponseSchema,
} from "@asimposium/contracts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Actual proposal -> signed sponsor publication -> public discovery on Workerd/D1.
// No Google/browser/staging completion is implied by this local lane.
async function areaDiscoveryJourney({ call, enroll, sponsorCall, worker, origin, userAgent, env }) {
  const sponsor = "usr_area_discovery";
  const token = await enroll("area-discovery-author", sponsor);
  const proposal = {
    title: "Finite area discovery formulation",
    statement: "Every simple path with n edges has n + 1 vertices.",
    falsifier: "A simple path whose vertex count differs from n + 1.",
    motivation: "Make the exact path convention available to independent reviewers.",
    areas: ["combinatorics", "other-path-enumeration"],
  };
  async function face(path, etag) {
    return worker.fetch(`${origin}${path}`, {
      headers: { "User-Agent": userAgent, ...(etag ? { "if-none-match": etag } : {}) },
    });
  }
  const initial = await face("/areas.json");
  const initialEtag = initial.headers.get("etag");
  const empty = AreasIndexResponseSchema.parse(await initial.json());
  assert.equal(empty.total_problems, 0);

  const created = await call("/v1/problems", proposal, token, 201);
  const problemId = created.problem.id;
  const draft = await call(`/v1/problems/${problemId}`, undefined, token);
  console.log(
    JSON.stringify({ stage: "area-assignment-roundtrip", saved: draft.problem.areas.length }),
  );
  assert.deepEqual(draft.problem.areas, proposal.areas, "Saved assignments must survive a new GET");
  assert.equal(
    (await face("/areas.json", initialEtag)).status,
    304,
    "Private drafts cannot alter public counts or ETags",
  );
  await call("/area/other-path-enumeration.json", undefined, undefined, 404);
  for (const suffix of ["json", "md"]) {
    const hidden = await face(`/p/${problemId}.${suffix}`);
    const unknown = await face(`/p/P-UNKNOWN.${suffix}`);
    assert.equal(hidden.status, 404);
    assert.equal(await hidden.text(), await unknown.text());
    const publicIndex = await (await face(`/problems.${suffix}`)).text();
    assert.ok(!publicIndex.includes(problemId) && !publicIndex.includes(proposal.title));
  }

  const invalid = await call(
    "/v1/problems",
    { ...proposal, areas: ["not-a-canonical-area"] },
    token,
    422,
  );
  assert.equal(invalid.code, "PROBLEM_PROPOSE_BODY_INVALID");
  assert.equal(invalid.rule, "P3");
  assert.ok(invalid.fix_hint && invalid.schema && invalid.example);
  const schemaPath = new URL(invalid.schema).pathname;
  const schemaResponse = await face(schemaPath);
  assert.equal(schemaResponse.status, 200, "Contract errors must link to a served schema");
  const schema = await schemaResponse.json();
  assert.equal(schema.$id, invalid.schema);
  assert.ok(schema.properties.propose_request && schema.examples.length > 0);

  await sponsorCall(
    sponsor,
    "POST",
    `/v1/sponsors/problems/${problemId}/lifecycle`,
    "problem-lifecycle",
    { action: "publish" },
  );
  const publishedIndex = ProblemsIndexResponseSchema.parse(await call("/problems.json"));
  const indexedProblem = publishedIndex.problems.find((problem) => problem.id === problemId);
  assert.equal(
    indexedProblem.title,
    proposal.title,
    "The public index must return the saved title",
  );
  assert.equal(indexedProblem.status, "sharpening");
  assert.ok(!publishedIndex.omitted.some((note) => note.includes("land with")));
  const indexEtags = new Map();
  for (const suffix of ["json", "md"]) {
    const response = await face(`/problems.${suffix}`);
    const body = await response.text();
    assert.ok(body.includes(proposal.title) && body.includes("sharpening"));
    indexEtags.set(suffix, response.headers.get("etag"));
    assert.equal((await face(`/problems.${suffix}`, indexEtags.get(suffix))).status, 304);
  }
  const reviewer = await enroll("index-independent-reviewer", "usr_index_reviewer");
  const reviewSession = await call(
    "/v1/sessions",
    { problem_id: problemId, intent: "review" },
    reviewer,
    201,
  );
  await call(
    `/v1/problems/${problemId}/statement-review`,
    {
      verdict: "statement-clear",
      basis: "The finite path domain and vertex-count counterexample are explicit.",
      session_id: reviewSession.session_id,
      statement_version: 1,
    },
    reviewer,
  );
  for (const suffix of ["json", "md"]) {
    const path = `/problems.${suffix}`;
    const response = await face(path, indexEtags.get(suffix));
    assert.equal(response.status, 200, "An independent review must invalidate the lifecycle index");
    assert.ok((await response.text()).includes("active"));
    const currentTag = response.headers.get("etag");
    assert.ok(currentTag && currentTag !== indexEtags.get(suffix));
    assert.equal((await face(path, currentTag)).status, 304);
    const head = await worker.fetch(`${origin}${path}`, {
      method: "HEAD",
      headers: { "User-Agent": userAgent },
    });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("etag"), currentTag);
    assert.equal(await head.text(), "");
  }
  const index = AreasIndexResponseSchema.parse(await call("/areas.json"));
  assert.equal(index.total_problems, 1);
  assert.equal(index.total_areas, 17);
  assert.equal(index.areas.find((area) => area.slug === "combinatorics").problem_count, 1);
  assert.equal(index.areas.find((area) => area.slug === "other-path-enumeration").problem_count, 1);
  assert.ok(index.areas.every((area) => area.active_needs.length === 0));
  assert.equal((await face("/areas.json", initialEtag)).status, 200);
  const detail = AreaDetailResponseSchema.parse(await call("/area/combinatorics.json"));
  assert.equal(detail.area.problem_count, 1);
  assert.equal(detail.problems[0].id, problemId);
  assert.equal(detail.problems[0].title, proposal.title);
  assert.equal(detail.problems[0].preamble, proposal.statement);
  assert.equal(detail.problems[0].falsifier_present, true);
  assert.deepEqual(detail.problems[0].needs, []);
  assert.ok(detail.omitted.some((item) => item.includes("eligibility are unavailable")));
  assert.deepEqual((await call(`/v1/problems/${problemId}`)).problem.areas, proposal.areas);

  async function assertFormulation(version, statement) {
    const digest = ProblemFaceResponseSchema.parse(await call(`/p/${problemId}.json`));
    const fields = {
      title: proposal.title,
      statement,
      falsifier: proposal.falsifier,
      motivation: proposal.motivation,
    };
    assert.equal(digest.items.filter((item) => item.kind === "claim").length, 0);
    for (const [field, body] of Object.entries(fields)) {
      const item = digest.items.find((entry) => entry.kind === `problem-${field}`);
      assert.ok(item, `Published problem digest must contain ${field}`);
      assert.equal(item.id, `S@${version}-${field}`);
      assert.equal(item.body, body);
      assert.equal(item.untrusted, true);
    }
    assert.ok(digest.next_actions.some((action) => action.url === `/v1/problems/${problemId}`));
    return digest;
  }
  await assertFormulation(1, proposal.statement);
  const digestEtags = new Map();
  for (const suffix of ["json", "md"]) {
    const response = await face(`/p/${problemId}.${suffix}`);
    const body = await response.text();
    assert.ok(Buffer.byteLength(body) <= 16_000);
    assert.ok(body.includes(proposal.statement) && body.includes(proposal.falsifier));
    digestEtags.set(suffix, response.headers.get("etag"));
    assert.equal((await face(`/p/${problemId}.${suffix}`, digestEtags.get(suffix))).status, 304);
  }

  const etags = new Map();
  for (const suffix of ["json", "md", "html"]) {
    const path = `/area/combinatorics.${suffix}`;
    const response = await face(path);
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.ok(body.includes(proposal.statement) && body.includes(proposal.title));
    assert.ok(!body.includes(token));
    const etag = response.headers.get("etag");
    assert.ok(etag);
    etags.set(suffix, etag);
    assert.equal((await face(path, etag)).status, 304);
  }
  assert.equal(new Set(etags.values()).size, 3);

  const revisedStatement =
    "Every nonempty simple path with n edges has exactly n + 1 distinct vertices.";
  await sponsorCall(
    sponsor,
    "POST",
    `/v1/sponsors/problems/${problemId}/lifecycle`,
    "problem-lifecycle",
    {
      action: "revise-statement",
      statement: revisedStatement,
      falsifier: proposal.falsifier,
      motivation: proposal.motivation,
    },
  );
  for (const suffix of ["json", "md", "html"]) {
    const response = await face(`/area/combinatorics.${suffix}`, etags.get(suffix));
    assert.equal(response.status, 200, "Statement revisions invalidate every face");
    assert.ok((await response.text()).includes(revisedStatement));
  }
  await assertFormulation(2, revisedStatement);
  for (const suffix of ["json", "md"]) {
    const response = await face(`/p/${problemId}.${suffix}`, digestEtags.get(suffix));
    assert.equal(response.status, 200, "Formulation revisions invalidate the problem digest");
    const body = await response.text();
    assert.ok(body.includes(revisedStatement));
    assert.ok(!body.includes(proposal.statement));
  }

  const unlisted = await call(
    "/v1/problems",
    {
      ...proposal,
      title: "Unlisted path study",
      statement: "An unlisted finite path has two endpoints.",
      areas: ["other-unlisted-canary"],
      unlisted: true,
    },
    token,
    201,
  );
  await sponsorCall(
    sponsor,
    "POST",
    `/v1/sponsors/problems/${unlisted.problem.id}/lifecycle`,
    "problem-lifecycle",
    { action: "publish" },
  );
  assert.equal((await call(`/v1/problems/${unlisted.problem.id}`)).problem.unlisted, true);
  for (const suffix of ["json", "md"]) {
    const publicIndex = await (await face(`/problems.${suffix}`)).text();
    assert.ok(
      !publicIndex.includes(unlisted.problem.id) && !publicIndex.includes("Unlisted path study"),
    );
  }
  const afterUnlisted = AreasIndexResponseSchema.parse(await call("/areas.json"));
  assert.deepEqual(
    afterUnlisted,
    index,
    "Unlisted publication must not change public taxonomy or counts",
  );
  await call("/area/other-unlisted-canary.json", undefined, undefined, 404);

  // Explicit historical-state fixture: the dormant scheduler is a separate gate.
  await env.DB.prepare("UPDATE problems SET status = 'dormant' WHERE id = ?").bind(problemId).run();
  assert.equal(
    (await call("/problems.json")).problems.find((problem) => problem.id === problemId).status,
    "dormant",
  );
  const dormantIndex = await call("/areas.json");
  assert.equal(dormantIndex.total_problems, 0);
  assert.equal(dormantIndex.total_areas, 16);
  assert.equal((await call("/area/combinatorics.json")).problems.length, 0);
  await call("/area/other-path-enumeration.json", undefined, undefined, 404);
  // Legacy titles were not populated by the original schema. This is a storage
  // fixture, not an assertion that a modern proposal can omit its title.
  await env.DB.prepare("UPDATE problems SET title = '' WHERE id = ?").bind(problemId).run();
  const legacyIndex = ProblemsIndexResponseSchema.parse(await call("/problems.json"));
  assert.equal(legacyIndex.problems.find((problem) => problem.id === problemId).title, null);
  assert.ok(legacyIndex.omitted.includes("some legacy problems have no saved title"));
  assert.ok((await (await face("/problems.md")).text()).includes("title unavailable"));
  // Explicit scale fixtures on real D1; the problem above was proposed and
  // published through production routes. No synthetic write is claimed as a
  // sponsor enrollment or a lifecycle transition.
  const ids = Array.from({ length: 405 }, (_, i) => `P-IDX-${String(i).padStart(3, "0")}`);
  const insert = (id, status = "active", unlisted = 0) =>
    env.DB.prepare(
      "INSERT INTO problems (id, title, status, unlisted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(
      id,
      "Index scale fixture",
      status,
      unlisted,
      "2026-09-09T00:00:00.000Z",
      "2026-09-09T00:00:00.000Z",
    );
  for (let start = 0; start < ids.length; start += 50) {
    await env.DB.batch(ids.slice(start, start + 50).map((id) => insert(id)));
  }
  await env.DB.batch([
    insert("P-IDX-199-private", "private-draft"),
    insert("P-IDX-199-unlisted", "active", 1),
  ]);
  const expected = [...ids, problemId].sort();
  const api = await call("/openapi.json");
  const ledgerSchema = await call("/schemas/ledger.v1.json");
  for (const path of ["/problems.json", "/problems.md"]) {
    const parameter = api.paths[path].get.parameters.find((item) => item.name === "after");
    assert.equal(parameter.in, "query");
    assert.ok(parameter.schema.$ref.endsWith("/properties/problems_index_query/properties/after"));
  }
  assert.equal(ledgerSchema.properties.problems_index_query.additionalProperties, false);
  assert.equal(ledgerSchema.properties.problems_index_query.properties.after.maxLength, 128);
  const firstPage = ProblemsIndexResponseSchema.parse(await call("/problems.json"));
  assert.deepEqual(
    firstPage.problems.map((problem) => problem.id),
    expected.slice(0, 200),
  );
  assert.equal(
    firstPage.next_after,
    expected[199],
    "Overflow must supply the last returned id for continuation",
  );
  // A new id on either side of the current boundary cannot shift or repeat
  // already returned entries. The earlier insertion is found on a fresh scan.
  const before = "P-IDX-000-before";
  const after = "P-IDX-300-after";
  await env.DB.batch([insert(before), insert(after)]);
  const seen = firstPage.problems.map((problem) => problem.id);
  let position = firstPage.next_after;
  let pages = 1;
  while (position !== undefined) {
    assert.ok(pages < 5, "Continuation must terminate");
    const query = `?after=${encodeURIComponent(position)}`;
    const response = await face(`/problems.json${query}`);
    const page = ProblemsIndexResponseSchema.parse(await response.json());
    assert.ok(page.problems.every((problem) => problem.id > position));
    assert.ok(page.problems.length <= 200);
    seen.push(...page.problems.map((problem) => problem.id));
    for (const suffix of ["json", "md"]) {
      const path = `/problems.${suffix}${query}`;
      const current = await face(path);
      const body = await current.text();
      for (const entry of page.problems) assert.ok(body.includes(entry.id));
      assert.ok(!body.includes("P-IDX-199-private") && !body.includes("P-IDX-199-unlisted"));
      if (page.next_after) assert.ok(body.includes(encodeURIComponent(page.next_after)));
      assert.equal((await face(path, current.headers.get("etag"))).status, 304);
      const head = await worker.fetch(`${origin}${path}`, {
        method: "HEAD",
        headers: { "User-Agent": userAgent },
      });
      assert.equal(head.status, 200);
      assert.equal(head.headers.get("etag"), current.headers.get("etag"));
      assert.equal(await head.text(), "");
    }
    position = page.next_after;
    pages += 1;
  }
  assert.equal(pages, 3);
  assert.deepEqual(seen, [...expected, after].sort());
  assert.equal(new Set(seen).size, seen.length);
  assert.ok((await call("/problems.json")).problems.some((problem) => problem.id === before));
  const exhausted = await call("/problems.json?after=zzzz");
  assert.equal(exhausted.problems.length, 0);
  assert.equal(exhausted.next_after, undefined);
  assert.ok(
    (await (await face("/problems.md?after=zzzz")).text()).includes(
      "No public problems after this position.",
    ),
  );
  for (const query of [
    "?after=",
    "?after=P-A&after=P-B",
    "?limit=100000",
    "?after=../PRIVATE_QUERY_CANARY",
    `?after=${"x".repeat(129)}`,
  ]) {
    for (const suffix of ["json", "md"]) {
      const response = await face(`/problems.${suffix}${query}`);
      assert.equal(response.status, 400);
      const raw = await response.text();
      assert.ok(!raw.includes("PRIVATE_QUERY_CANARY"));
      const error = JSON.parse(raw);
      assert.equal(error.code, "CURSOR_INVALID");
      assert.ok(error.rule && error.fix_hint && error.schema && error.example);
      const head = await worker.fetch(`${origin}/problems.${suffix}${query}`, {
        method: "HEAD",
        headers: { "User-Agent": userAgent },
      });
      assert.equal(head.status, 400);
      assert.equal(await head.text(), "");
    }
  }
  console.log(
    JSON.stringify({
      stage: "index-continuation",
      pages,
      returned: seen.length,
      distinct: new Set(seen).size,
      private_excluded: true,
    }),
  );
  console.log(
    JSON.stringify({
      kind: "area-discovery-real-bindings",
      status: "pass",
      proof: "local production writes and public reads; dormant state separately seeded",
    }),
  );
}

await runLocalWorkerJourney(areaDiscoveryJourney).catch((error) => {
  console.error(
    JSON.stringify({
      stage: "area-discovery",
      status: "fail",
      error_sha256: createHash("sha256")
        .update(error instanceof Error ? error.message : typeof error)
        .digest("hex"),
    }),
  );
  process.exitCode = 1;
});
