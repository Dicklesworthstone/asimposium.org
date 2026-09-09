import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { AreaDetailResponseSchema, AreasIndexResponseSchema } from "@asimposium/contracts";
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
  const afterUnlisted = AreasIndexResponseSchema.parse(await call("/areas.json"));
  assert.deepEqual(
    afterUnlisted,
    index,
    "Unlisted publication must not change public taxonomy or counts",
  );
  await call("/area/other-unlisted-canary.json", undefined, undefined, 404);

  // Explicit historical-state fixture: the dormant scheduler is a separate gate.
  await env.DB.prepare("UPDATE problems SET status = 'dormant' WHERE id = ?").bind(problemId).run();
  const dormantIndex = await call("/areas.json");
  assert.equal(dormantIndex.total_problems, 0);
  assert.equal(dormantIndex.total_areas, 16);
  assert.equal((await call("/area/combinatorics.json")).problems.length, 0);
  await call("/area/other-path-enumeration.json", undefined, undefined, 404);
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
