import assert from "node:assert/strict";
import {
  ClaimFaceResponseSchema,
  ProblemFaceResponseSchema,
  SearchResponseSchema,
} from "@asimposium/contracts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Production routes on local Workerd/D1/R2. Enrollment approvals and the benign
// classifier are local fixtures; this is not Google, staging or screening proof.
export async function unlistedJourney({
  call,
  enroll,
  sponsorCall,
  worker,
  origin,
  userAgent,
  env,
  fixtures,
}) {
  const sponsor = "usr_unlisted_read";
  const author = await enroll("unlisted-reader-author", sponsor);
  const reviewer = await enroll("unlisted-reader-reviewer", "usr_unlisted_reviewer");
  const privateCanary = "PRIVATE_WORKSHOP_UNLISTED_CANARY";
  const proposal = {
    title: "Unlisted finite path convention",
    statement: "Every simple finite path with n edges has n + 1 vertices.",
    falsifier: "A simple finite path with a different vertex count.",
    motivation: "Fix the path convention before broader discovery.",
    areas: ["other-unlisted-reading"],
    unlisted: true,
  };
  const created = await call("/v1/problems", proposal, author, 201);
  const id = created.problem.id;
  const fetch = (path, method = "GET", etag) =>
    worker.fetch(`${origin}${path}`, {
      method,
      headers: { "User-Agent": userAgent, ...(etag ? { "If-None-Match": etag } : {}) },
    });
  for (const suffix of ["json", "md"]) {
    assert.equal((await fetch(`/p/${id}.${suffix}`)).status, 404);
  }
  await sponsorCall(sponsor, "POST", `/v1/sponsors/problems/${id}/lifecycle`, "problem-lifecycle", {
    action: "publish",
  });
  // Causal negative on the old source: detail succeeds while the digest 404s.
  assert.equal((await call(`/v1/problems/${id}`)).problem.unlisted, true);
  const digest = await fetch(`/p/${id}.json`);
  assert.equal(digest.status, 200, "A published unlisted problem must have a readable known URL");
  ProblemFaceResponseSchema.parse(await digest.json());

  const reviewSession = await call(
    "/v1/sessions",
    { problem_id: id, intent: "review" },
    reviewer,
    201,
  );
  await call(
    `/v1/problems/${id}/statement-review`,
    {
      session_id: reviewSession.session_id,
      statement_version: 1,
      verdict: "statement-clear",
      basis: "The finite domain and counterexample are explicit.",
    },
    reviewer,
  );
  const session = await call("/v1/sessions", { problem_id: id, intent: "prove" }, author, 201);
  const reviewFaceResponse = await fetch(`/p/${id}.json`);
  assert.equal(reviewFaceResponse.headers.get("x-robots-tag"), "noindex, nofollow");
  const statementReview = (await reviewFaceResponse.json()).items.find(
    (item) => item.kind === "statement-review",
  );
  assert.ok(statementReview);
  assert.equal(JSON.parse(statementReview.body).session, reviewSession.session_id);
  assert.equal(JSON.parse(statementReview.body).verdict, "statement-clear");
  assert.equal(
    JSON.parse(statementReview.body).basis,
    "The finite domain and counterexample are explicit.",
  );
  const scratch = await call(
    `/v1/sessions/${session.session_id}/workshop`,
    {
      type: "draft",
      title: "Private derivation",
      body_md: privateCanary,
      relates_to: [],
    },
    author,
    201,
  );
  const claim = await call(
    `/v1/sessions/${session.session_id}/promote`,
    {
      workshop_id: scratch.workshop_id,
      kind: "conjecture",
      statement: "UNLISTED_CLAIM_CANARY: A simple path on three vertices has two edges.",
      falsifier: "A simple three-vertex path with a different number of edges.",
    },
    author,
    201,
  );
  const pack = await call(
    `/v1/sessions/${reviewSession.session_id}/pack?profile=review&target=${claim.claim_id}@1`,
    undefined,
    reviewer,
  );
  assert.ok(JSON.stringify(pack).includes("UNLISTED_CLAIM_CANARY"));
  assert.ok(!JSON.stringify(pack).includes(privateCanary));
  await call(
    `/v1/sessions/${reviewSession.session_id}/review`,
    {
      target_claim_id: claim.claim_id,
      target_version: 1,
      verdict: "inform",
      basis: "UNLISTED_REVIEW_CANARY: No independent refutation attempt is offered.",
      body_md: "This review records the scope of the path convention only.",
    },
    reviewer,
    201,
  );

  const paths = [
    `/p/${id}.json`,
    `/p/${id}.md`,
    ...[claim.claim_id, `${claim.claim_id}@1`].flatMap((target) =>
      ["json", "md", "html", "bib", "csl.json"].map(
        (suffix) => `/p/${id}/claims/${target}.${suffix}`,
      ),
    ),
  ];
  const etags = new Map();
  for (const path of paths) {
    const response = await fetch(path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow", path);
    const body = await response.text();
    assert.ok(body.includes("A simple path on three vertices has two edges."), path);
    assert.ok(
      !body.includes(privateCanary) && !body.includes(author) && !body.includes(reviewer),
      path,
    );
    if (path.endsWith(".json") && !path.endsWith(".csl.json")) {
      (path.includes("/claims/") ? ClaimFaceResponseSchema : ProblemFaceResponseSchema).parse(
        JSON.parse(body),
      );
    }
    const etag = response.headers.get("etag");
    assert.ok(etag);
    etags.set(path, etag);
    for (const [method, conditional, status] of [
      ["HEAD", false, 200],
      ["GET", true, 304],
      ["HEAD", true, 304],
    ]) {
      const check = await fetch(path, method, conditional ? etag : undefined);
      assert.equal(check.status, status, path);
      assert.equal(await check.text(), "");
      assert.equal(check.headers.get("etag"), etag);
      assert.equal(check.headers.get("x-robots-tag"), "noindex, nofollow");
    }
  }
  assert.equal(
    (await fetch(`/v1/problems/${id}`)).headers.get("x-robots-tag"),
    "noindex, nofollow",
  );
  for (const path of [
    "/problems.json",
    "/problems.md",
    "/areas.json",
    "/now.json",
    `/search.json?q=${id}`,
    "/search.json?q=UNLISTED_CLAIM_CANARY",
    "/a/unlisted-reader-author.json",
    "/a/unlisted-reader-reviewer.json",
  ]) {
    const response = await fetch(path);
    assert.equal(response.status, 200, path);
    const body = await response.text();
    // Search may echo its caller-supplied query; inspect returned results only.
    const content = path.startsWith("/search")
      ? JSON.stringify(SearchResponseSchema.parse(JSON.parse(body)).items)
      : body;
    assert.ok(
      !content.includes(id) &&
        !content.includes("UNLISTED_CLAIM_CANARY") &&
        !content.includes("UNLISTED_REVIEW_CANARY") &&
        !content.includes(privateCanary),
      path,
    );
  }
  const authorCard = await call("/a/unlisted-reader-author.json");
  assert.equal(authorCard.calibration.conjectures_promoted, 0);
  assert.equal(authorCard.sessions_count, 0);
  await call("/area/other-unlisted-reading.json", undefined, undefined, 404);

  // Listed work by the same author remains discoverable and counted exactly.
  const listed = await call(
    "/v1/problems",
    {
      ...proposal,
      title: "Listed cycle convention",
      statement: "A simple cycle has equally many vertices and edges.",
      falsifier: "A simple cycle with unequal vertex and edge counts.",
      unlisted: false,
      areas: ["combinatorics"],
    },
    author,
    201,
  );
  const listedId = listed.problem.id;
  await sponsorCall(
    sponsor,
    "POST",
    `/v1/sponsors/problems/${listedId}/lifecycle`,
    "problem-lifecycle",
    { action: "publish" },
  );
  const listedReviewSession = await call(
    "/v1/sessions",
    { problem_id: listedId, intent: "review" },
    reviewer,
    201,
  );
  await call(
    `/v1/problems/${listedId}/statement-review`,
    {
      session_id: listedReviewSession.session_id,
      statement_version: 1,
      verdict: "statement-clear",
      basis: "The simple cycle domain is explicit.",
    },
    reviewer,
  );
  const listedSession = await call(
    "/v1/sessions",
    { problem_id: listedId, intent: "prove" },
    author,
    201,
  );
  const listedDraft = await call(
    `/v1/sessions/${listedSession.session_id}/workshop`,
    {
      type: "draft",
      title: "Cycle work",
      body_md: privateCanary,
      relates_to: [],
    },
    author,
    201,
  );
  const listedClaim = await call(
    `/v1/sessions/${listedSession.session_id}/promote`,
    {
      workshop_id: listedDraft.workshop_id,
      kind: "conjecture",
      statement: "LISTED_CLAIM_CONTROL: A simple cycle on three vertices has three edges.",
      falsifier: "A three-vertex simple cycle without exactly three edges.",
    },
    author,
    201,
  );
  for (const path of [
    `/p/${listedId}.json`,
    `/p/${listedId}/claims/${listedClaim.claim_id}.html`,
    `/p/${listedId}/claims/${listedClaim.claim_id}.bib`,
  ]) {
    const response = await fetch(path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-robots-tag"), null);
    assert.ok(
      (await response.text()).includes("A simple cycle on three vertices has three edges."),
    );
  }
  const listedCard = await call("/a/unlisted-reader-author.json");
  assert.equal(listedCard.calibration.conjectures_promoted, 1);
  assert.equal(listedCard.sessions_count, 1);
  assert.equal(listedCard.promoted_contributions.length, 1);
  assert.equal(listedCard.promoted_contributions[0].problem_id, listedId);
  assert.ok((await call("/problems.json")).problems.some((problem) => problem.id === listedId));

  // Present-day content withdrawal must win over a cached successful response,
  // including an exact historical citation. This fixture only changes the control.
  const event = await env.DB.prepare(
    "SELECT id FROM events WHERE problem_id = ? AND type = 'claim.created'",
  )
    .bind(id)
    .first();
  await fixtures.redactPublicContent(event.id);
  for (const path of paths) {
    const response = await fetch(path, "GET", etags.get(path));
    const citation = path.endsWith(".bib") || path.endsWith(".csl.json");
    assert.equal(response.status, citation ? 404 : 200, path);
    assert.ok(!(await response.text()).includes("UNLISTED_CLAIM_CANARY"), path);
  }

  // A separate never-published draft stays invisible even when its URL is known.
  const draft = await call(
    "/v1/problems",
    {
      ...proposal,
      title: "Private unknown convention",
      statement: "PRIVATE_FORMULATION_CANARY: A triangle has three vertices.",
      distinct_because: "The triangle domain differs from finite paths.",
    },
    author,
    201,
  );
  for (const suffix of ["json", "md"]) {
    const hidden = await fetch(`/p/${draft.problem.id}.${suffix}`);
    const unknown = await fetch(`/p/P-UNKNOWN.${suffix}`);
    assert.equal(hidden.status, 404);
    assert.equal(await hidden.text(), await unknown.text());
  }
  console.log(
    JSON.stringify({
      kind: "unlisted-real-bindings",
      status: "pass",
      direct_faces: paths.length,
      proof: "local production publication, packs, reads, robots, discovery and withdrawal",
    }),
  );
}

await runLocalWorkerJourney(unlistedJourney);
