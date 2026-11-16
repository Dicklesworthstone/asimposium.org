import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { ProblemCodeSchema, SearchResponseSchema } from "@asimposium/contracts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Production proposal, publication, review and promotion routes on Workerd/D1.
// Enrollment approval and benign screening are explicit local harness fixtures;
// this lane does not assert staging, Google authentication or provider screening.
async function searchFiltersJourney({ call, enroll, sponsorCall, worker, origin, userAgent }) {
  // Each attempt owns distinct identities and formulations. An interrupted
  // local run must not consume this attempt's creation quota or satisfy its
  // result assertions, and deliberate duplicate proposals remain refused.
  const run = randomUUID().replaceAll("-", "").slice(0, 12);
  const term = `pathsearch${run}`;
  const sponsor = `usr_search_${run}`;
  const author = await enroll(`filters-${run}-author`, sponsor);
  const privateSponsor = `usr_private_${run}`;
  const privateAuthor = await enroll(`filters-${run}-private`, privateSponsor);
  const reviewer = await enroll(`filters-${run}-review`, `usr_review_${run}`);
  console.log(JSON.stringify({ stage: "search-identities-ready" }));
  const proposal = {
    title: `Finite path vertex count ${term}`,
    statement: `In the finite path family ${term}, every simple path with n edges has n + 1 vertices.`,
    falsifier: "A simple finite path with a different vertex count.",
    motivation: "Make the finite path convention independently searchable.",
    areas: ["combinatorics", "other-search-paths"],
  };
  const active = (await call("/v1/problems", proposal, author, 201)).problem.id;
  const sharpening = (
    await call(
      "/v1/problems",
      {
        ...proposal,
        statement: `The incidence matrix of a finite path in ${term} with n edges has rank n.`,
        falsifier: "A path incidence matrix whose rank differs from its edge count.",
        areas: ["algebra"],
      },
      author,
      201,
    )
  ).problem.id;
  const hidden = (
    await call(
      "/v1/problems",
      {
        ...proposal,
        statement: `The two-edge finite path in ${term} has three vertices.`,
      },
      privateAuthor,
      201,
    )
  ).problem.id;
  const unlisted = (
    await call(
      "/v1/problems",
      {
        ...proposal,
        statement: `The three-edge finite path in ${term} has four vertices.`,
        unlisted: true,
      },
      privateAuthor,
      201,
    )
  ).problem.id;
  console.log(JSON.stringify({ stage: "search-proposals-created" }));
  for (const [id, owner] of [
    [active, sponsor],
    [sharpening, sponsor],
    [unlisted, privateSponsor],
  ]) {
    await sponsorCall(owner, "POST", `/v1/sponsors/problems/${id}/lifecycle`, "problem-lifecycle", {
      action: "publish",
    });
  }
  console.log(JSON.stringify({ stage: "search-problems-published" }));
  const reviewSession = await call(
    "/v1/sessions",
    { problem_id: active, intent: "review" },
    reviewer,
    201,
  );
  await call(
    `/v1/problems/${active}/statement-review`,
    {
      session_id: reviewSession.session_id,
      statement_version: 1,
      verdict: "statement-clear",
      basis: "The simple finite path domain and counterexample are explicit.",
    },
    reviewer,
  );
  const session = await call("/v1/sessions", { problem_id: active, intent: "prove" }, author, 201);
  const claims = [];
  for (const edges of [2, 3]) {
    const draft = await call(
      `/v1/sessions/${session.session_id}/workshop`,
      {
        type: "claim-draft",
        title: "Finite path calculation",
        body_md: "PRIVATE_FILTER_WORKSHOP_CANARY",
      },
      author,
      201,
    );
    const promoted = await call(
      `/v1/sessions/${session.session_id}/promote`,
      {
        workshop_id: draft.workshop_id,
        kind: "conjecture",
        statement: `In ${term}, a simple finite path with ${edges} edges has ${edges + 1} vertices.`,
        falsifier: `A simple ${edges}-edge path with a different vertex count.`,
      },
      author,
      201,
    );
    claims.push(promoted.claim_id);
  }
  console.log(JSON.stringify({ stage: "search-claims-promoted" }));

  const read = (path, etag) =>
    worker.fetch(`${origin}${path}`, {
      headers: { "User-Agent": userAgent, ...(etag ? { "If-None-Match": etag } : {}) },
    });
  const path = (query, face = "json") => `/search.${face}?${new URLSearchParams(query)}`;
  async function search(query) {
    const response = await read(path(query));
    assert.equal(response.status, 200);
    return SearchResponseSchema.parse(await response.json());
  }
  const query = {
    q: term,
    kind: "claim",
    area: "combinatorics",
    status: "active",
    limit: "1",
  };
  let first;
  for (let attempt = 0; ; attempt++) {
    const response = await read(path(query));
    const data = await response.json();
    if (response.status === 409) assert.equal(data.code, "SEARCH_RESULTS_CHANGED");
    else {
      assert.equal(response.status, 200);
      first = SearchResponseSchema.parse(data);
      if (first.total_matches === 2 && first.cursor) break;
      assert.ok(first.omitted.some((item) => item.reason === "index_pending"));
    }
    assert.ok(attempt < 50, "Both promoted claims must reach the FTS outbox projection");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  console.log(JSON.stringify({ stage: "search-fts-ready" }));
  const second = await search({ ...query, cursor: first.cursor });
  assert.deepEqual(
    new Set([...first.items, ...second.items].map((item) => item.id)),
    new Set(claims),
  );
  assert.equal(second.cursor, undefined);
  assert.ok(
    first.next_actions.some((action) => {
      const next = new URL(action.href, origin);
      return (
        action.label === "Next page" &&
        next.searchParams.get("area") === query.area &&
        next.searchParams.get("status") === query.status &&
        next.searchParams.get("cursor") === first.cursor
      );
    }),
  );
  const custom = await search({ ...query, area: "other-search-paths", limit: "20" });
  assert.equal(custom.items.length, 2);
  const titles = await search({
    q: term,
    kind: "problem",
    area: "algebra",
    status: "sharpening",
  });
  assert.deepEqual(
    titles.items.map((item) => item.id),
    [sharpening],
  );
  const pinned = `https://a.asimposium.org/p/${active}/claims/${claims[0]}@1.json`;
  assert.equal((await search({ ...query, q: pinned })).items[0]?.match_type, "exact_reference");
  assert.equal((await search({ ...query, q: pinned, status: "sharpening" })).items.length, 0);
  assert.equal((await search({ ...query, q: pinned, area: "algebra" })).items.length, 0);
  for (const id of [hidden, unlisted]) {
    const face = await search({ q: id, area: "combinatorics" });
    assert.equal(face.items.length, 0, "Known private and unlisted IDs stay undiscoverable");
    assert.equal(face.total_matches, 0);
  }
  const fellowQuery = { q: `filters-${run}`, kind: "fellow" };
  assert.equal((await search(fellowQuery)).items.length, 3);
  const fellows = await search({ ...fellowQuery, status: "active" });
  assert.equal(fellows.items.length, 0);
  assert.ok(fellows.omitted.some((item) => item.reason === "problem_filters_applied"));
  for (const changed of [
    { ...query, area: "algebra" },
    { ...query, status: "sharpening" },
    { ...query, area: undefined },
  ]) {
    const params = Object.fromEntries(
      Object.entries(changed).filter(([, value]) => value !== undefined),
    );
    const response = await read(path({ ...params, cursor: first.cursor }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "SEARCH_CURSOR_INVALID");
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  for (const invalid of [
    "area=invalid-area",
    "status=private-draft",
    "area=algebra&area=combinatorics",
    "status=active&status=resolved",
  ]) {
    const response = await read(`/search.json?q=finite&${invalid}`);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "SCHEMA_INVALID");
  }
  const json = await read(path(query));
  assert.equal((await read(path(query), json.headers.get("etag"))).status, 304);
  const markdown = await read(path(query, "md"));
  assert.equal(markdown.status, 200);
  const text = await markdown.text();
  assert.ok(text.includes(claims[0]) || text.includes(claims[1]));
  assert.ok(!text.includes("PRIVATE_FILTER_WORKSHOP_CANARY"));
  assert.ok(text.includes("area=combinatorics") && text.includes("status=active"));
  console.log(JSON.stringify({ stage: "search-filter-reads-verified" }));

  await sponsorCall(
    sponsor,
    "POST",
    `/v1/sponsors/problems/${active}/lifecycle`,
    "problem-lifecycle",
    {
      action: "retire",
      reason: "This exact finite path formulation is no longer an active research question.",
    },
  );
  const stale = await read(path({ ...query, cursor: first.cursor }));
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, "SEARCH_RESULTS_CHANGED");
  assert.equal((await search({ ...query, q: pinned })).items.length, 0);
  assert.equal((await search({ ...query, q: pinned, status: "retired" })).items[0]?.id, claims[0]);
  return {
    kind: "search-filters-real-bindings",
    status: "pass",
    claims: claims.length,
    undiscoverable_problems_checked: 2,
  };
}

await runLocalWorkerJourney(searchFiltersJourney)
  .then((receipt) => console.log(JSON.stringify(receipt)))
  .catch((error) => {
    const refusal = ProblemCodeSchema.safeParse(error?.message?.match(/code=([A-Z_]+)/)?.[1]);
    console.error(
      JSON.stringify({
        stage: "search-filters",
        error_location:
          error?.stack?.match(/search-filters-real-bindings\.mjs:\d+:\d+/)?.[0] ?? null,
        observed_code: refusal.success ? refusal.data : null,
        observed_status: Number.isInteger(error?.actual) ? error.actual : null,
        expected_status: Number.isInteger(error?.expected) ? error.expected : null,
        status: "fail",
        error_code: typeof error?.code === "string" ? error.code : (error?.name ?? null),
        error_sha256: createHash("sha256")
          .update(error instanceof Error ? error.message : typeof error)
          .digest("hex"),
      }),
    );
    process.exitCode = 1;
  });
