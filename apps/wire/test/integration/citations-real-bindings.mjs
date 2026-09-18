import assert from "node:assert/strict";
import {
  CitationsListResponseSchema,
  CorrectCitationResponseSchema,
  RecordCitationResponseSchema,
  SingleCitationResponseSchema,
} from "@asimposium/contracts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

assert.equal(process.versions.bun, undefined, "This lane requires genuine Node");

await runLocalWorkerJourney(async (context) => {
  const { call, enroll, sponsorCall, worker, origin, env } = context;
  const sponsorA = "usr_cit_sponsor_a";
  const authorA = await enroll("cit-author-a", sponsorA);
  const helloA = await call("/v1/hello", undefined, authorA);
  const _fellowIdA = helloA.fellow.fellow_id;

  const sponsorB = "usr_cit_sponsor_b";
  const reviewerB = await enroll("cit-reviewer-b", sponsorB);
  const helloB = await call("/v1/hello", undefined, reviewerB);
  const _fellowIdB = helloB.fellow.fellow_id;

  // 1. Propose and publish problem
  const created = await call(
    "/v1/problems",
    {
      title: "Citations and literature test problem",
      statement: "Every non-trivial modular cycle has bounded prime factors.",
      falsifier: "An unbounded prime factor in a non-trivial modular cycle.",
      motivation: "Testing W5.8c citations (L-n), provenance, versioning, and Diptych faces.",
      areas: ["number-theory"],
    },
    authorA,
    201,
  );
  const problemId = created.problem.id;

  const govern = (body, key) =>
    sponsorCall(
      sponsorA,
      "POST",
      `/v1/sponsors/problems/${problemId}/lifecycle`,
      "problem-lifecycle",
      body,
      200,
      `/v1/sponsors/problems/${problemId}/lifecycle`,
      key,
    );
  await govern({ action: "publish" }, "publish-cit-problem");

  // Statement-clear review to unlock sharpening -> active
  const reviewSession = await call(
    "/v1/sessions",
    { problem_id: problemId, intent: "review" },
    reviewerB,
    201,
  );
  await call(
    `/v1/problems/${problemId}/statement-review`,
    {
      session_id: reviewSession.session_id,
      statement_version: 1,
      verdict: "statement-clear",
      basis: "Problem statement formulation is clear and testable.",
    },
    reviewerB,
    200,
  );
  await call(
    `/v1/sessions/${reviewSession.session_id}/close`,
    {
      handback: "Statement review complete.",
      promote: [],
      keep: [],
      discard: [],
    },
    reviewerB,
    201,
  );

  // 2. Open author session A
  const sessionA = await call(
    "/v1/sessions",
    { problem_id: problemId, intent: "prove" },
    authorA,
    201,
  );
  const sessionIdA = sessionA.session_id;

  // --------------------------------------------------------------------------
  // CITATION RECORDING & REFUSAL TESTS
  // --------------------------------------------------------------------------

  const validDoiPayload = {
    locator_kind: "doi",
    locator: "https://doi.org/10.1007/s00222-020-00980-8",
    title: "Bounded gaps between primes",
    authors: ["Yitang Zhang"],
    year: 2014,
    excerpt: "Establishes that lim inf (p_{n+1} - p_n) < 70000000 unconditionally.",
    retrieved_at: "2026-09-01T12:00:00.000Z",
  };

  // 3. Validation: Low substance placeholder refusal (422 CITATION_LOW_SUBSTANCE)
  const lowSubstanceRes = await call(
    `/v1/sessions/${sessionIdA}/citations`,
    {
      ...validDoiPayload,
      title: "TODO",
    },
    authorA,
    422,
  );
  assert.equal(lowSubstanceRes.code, "CITATION_LOW_SUBSTANCE");
  assert.equal(lowSubstanceRes.rule, "P8");

  // 4. Validation: Invalid locator format refusal (422 CITATION_BODY_INVALID)
  const invalidDoiRes = await call(
    `/v1/sessions/${sessionIdA}/citations`,
    {
      ...validDoiPayload,
      locator: "invalid-doi-format",
    },
    authorA,
    422,
  );
  assert.equal(invalidDoiRes.code, "CITATION_BODY_INVALID");
  assert.equal(invalidDoiRes.rule, "P8");

  // 5. Successful DOI recording (201)
  const recordedDoi = await call(
    `/v1/sessions/${sessionIdA}/citations`,
    validDoiPayload,
    authorA,
    201,
    "idempotent-cit-doi-key-1",
  );
  RecordCitationResponseSchema.parse(recordedDoi);
  const cit1Id = recordedDoi.citation_id;
  assert.ok(cit1Id.startsWith("L-"));
  assert.equal(recordedDoi.version, 1);
  assert.equal(recordedDoi.canonical_locator, "10.1007/s00222-020-00980-8");
  assert.equal(recordedDoi.source_provenance, "retrieved");
  assert.equal(recordedDoi.problem_id, problemId);

  // Replay idempotency check
  const replayedDoi = await call(
    `/v1/sessions/${sessionIdA}/citations`,
    validDoiPayload,
    authorA,
    200,
    "idempotent-cit-doi-key-1",
  );
  assert.equal(replayedDoi.citation_id, cit1Id);

  // 6. Duplicate citation prevention (409 DUPLICATE_CITATION)
  const duplicateDoi = await call(
    `/v1/sessions/${sessionIdA}/citations`,
    {
      ...validDoiPayload,
      locator: "10.1007/s00222-020-00980-8", // Same canonical DOI
    },
    authorA,
    409,
    "different-key-for-duplicate",
  );
  assert.equal(duplicateDoi.code, "DUPLICATE_CITATION");
  assert.equal(duplicateDoi.rule, "P8");

  // 7. Successful arXiv recording (201)
  const validArxivPayload = {
    locator_kind: "arxiv",
    locator: "https://arxiv.org/abs/1301.0001",
    title: "Sieve methods and prime gaps",
    authors: ["Jane Doe"],
    year: 2013,
    excerpt: "Overview of sieve inequalities for bounded difference questions.",
    retrieved_at: "2026-09-02T10:00:00.000Z",
  };
  const recordedArxiv = await call(
    `/v1/sessions/${sessionIdA}/citations`,
    validArxivPayload,
    authorA,
    201,
  );
  const cit2Id = recordedArxiv.citation_id;
  assert.equal(recordedArxiv.canonical_locator, "1301.0001");

  // 8. Rule P8: model_memory citation (201)
  const validMemoryPayload = {
    locator_kind: "model_memory",
    title: "Cramer probabilistic model on prime gaps",
    excerpt: "Standard heuristic predicting maximal prime gaps of order log squared p.",
    source_provenance: "model_memory",
  };
  const recordedMemory = await call(
    `/v1/sessions/${sessionIdA}/citations`,
    validMemoryPayload,
    authorA,
    201,
  );
  const cit3Id = recordedMemory.citation_id;
  assert.equal(recordedMemory.source_provenance, "model_memory");
  assert.equal(recordedMemory.canonical_locator, null);

  // 9. Rule P8 enforcement: model_memory with external locator refused (422)
  const badMemoryRes = await call(
    `/v1/sessions/${sessionIdA}/citations`,
    {
      ...validMemoryPayload,
      locator: "https://example.org/bad",
    },
    authorA,
    422,
  );
  assert.equal(badMemoryRes.code, "CITATION_BODY_INVALID");

  // --------------------------------------------------------------------------
  // CITATION CORRECTIONS JOURNEY
  // --------------------------------------------------------------------------

  // 10. Correction on non-existent citation (404 CITATION_NOT_FOUND)
  const notFoundCorrection = await call(
    `/v1/sessions/${sessionIdA}/citations/correct`,
    {
      citation_id: "L-99999",
      base_version: 1,
      title: "Nonexistent paper title",
      locator_kind: "doi",
      locator: "10.1007/s00222-020-00980-8",
      retrieved_at: "2026-09-01T12:00:00.000Z",
    },
    authorA,
    404,
  );
  assert.equal(notFoundCorrection.code, "CITATION_NOT_FOUND");

  // 11. Stale base_version conflict (409 OBJECT_VERSION_CONFLICT)
  const staleBaseCorrection = await call(
    `/v1/sessions/${sessionIdA}/citations/correct`,
    {
      citation_id: cit1Id,
      base_version: 42, // Head is 1
      title: "Updated Bounded gaps title",
      locator_kind: "doi",
      locator: "10.1007/s00222-020-00980-8",
      retrieved_at: "2026-09-01T12:00:00.000Z",
    },
    authorA,
    409,
  );
  assert.equal(staleBaseCorrection.code, "OBJECT_VERSION_CONFLICT");

  // 12. Non-author correction refusal (403 NOT_CITATION_AUTHOR)
  const sessionB = await call(
    "/v1/sessions",
    { problem_id: problemId, intent: "explore" },
    reviewerB,
    201,
  );
  const nonAuthorCorrection = await call(
    `/v1/sessions/${sessionB.session_id}/citations/correct`,
    {
      citation_id: cit1Id,
      base_version: 1,
      title: "Reviewer attempting to modify Fellow A citation",
      locator_kind: "doi",
      locator: "10.1007/s00222-020-00980-8",
      retrieved_at: "2026-09-01T12:00:00.000Z",
    },
    reviewerB,
    403,
  );
  assert.equal(nonAuthorCorrection.code, "NOT_CITATION_AUTHOR");

  // 13. Successful correction by author Fellow A (200)
  const correctPayload = {
    citation_id: cit1Id,
    base_version: 1,
    title: "Bounded gaps between primes (Annals of Mathematics)",
    authors: ["Yitang Zhang"],
    year: 2014,
    locator_kind: "doi",
    locator: "10.1007/s00222-020-00980-8",
    excerpt: "Refined excerpt: establishes bounded prime gaps unconditionally below 70M.",
    retrieved_at: "2026-09-01T12:00:00.000Z",
    correction_rationale: "Updated journal title and refined excerpt note.",
  };
  const corrected = await call(
    `/v1/sessions/${sessionIdA}/citations/correct`,
    correctPayload,
    authorA,
    200,
    "idempotent-cit-correct-key-1",
  );
  CorrectCitationResponseSchema.parse(corrected);
  assert.equal(corrected.citation_id, cit1Id);
  assert.equal(corrected.version, 2);
  assert.equal(corrected.base_version, 1);

  // Replay idempotency on correction
  const replayedCorrect = await call(
    `/v1/sessions/${sessionIdA}/citations/correct`,
    correctPayload,
    authorA,
    200,
    "idempotent-cit-correct-key-1",
  );
  assert.equal(replayedCorrect.citation_id, cit1Id);
  assert.equal(replayedCorrect.version, 2);

  // --------------------------------------------------------------------------
  // DIPTYCH PUBLIC FACES & EXPORTS
  // --------------------------------------------------------------------------

  // List face: .json
  const listJsonRes = await worker.fetch(`${origin}/p/${problemId}/citations.json`);
  assert.equal(listJsonRes.status, 200);
  assert.equal(listJsonRes.headers.get("content-type"), "application/json; charset=utf-8");
  const listJson = CitationsListResponseSchema.parse(await listJsonRes.json());
  assert.equal(listJson.citations.length, 3);
  assert.equal(listJson.citations[0].citation_id, cit1Id);
  assert.equal(listJson.citations[0].version, 2); // Head version 2
  assert.equal(listJson.citations[0].title, correctPayload.title);

  // Literature alias: .json
  const litAliasRes = await worker.fetch(`${origin}/p/${problemId}/literature.json`);
  assert.equal(litAliasRes.status, 200);
  const litAliasJson = CitationsListResponseSchema.parse(await litAliasRes.json());
  assert.equal(litAliasJson.citations.length, 3);

  // List face: .md
  const listMdRes = await worker.fetch(`${origin}/p/${problemId}/citations.md`);
  assert.equal(listMdRes.status, 200);
  assert.equal(listMdRes.headers.get("content-type"), "text/markdown; charset=utf-8");
  const listMd = await listMdRes.text();
  assert.ok(listMd.includes(cit1Id));
  assert.ok(listMd.includes(cit2Id));
  assert.ok(listMd.includes(cit3Id));
  assert.ok(listMd.includes(correctPayload.title.replace(/\(/g, "\\(").replace(/\)/g, "\\)")));

  // List face: .html
  const listHtmlRes = await worker.fetch(`${origin}/p/${problemId}/citations.html`);
  assert.equal(listHtmlRes.status, 200);
  assert.equal(listHtmlRes.headers.get("content-type"), "text/html; charset=utf-8");
  const listHtml = await listHtmlRes.text();
  assert.ok(listHtml.includes(cit1Id));
  assert.ok(listHtml.includes(correctPayload.title));

  // Single citation face: .json (head)
  const singleJsonRes = await worker.fetch(`${origin}/p/${problemId}/citations/${cit1Id}.json`);
  assert.equal(singleJsonRes.status, 200);
  const singleJson = SingleCitationResponseSchema.parse(await singleJsonRes.json());
  assert.equal(singleJson.citation.citation_id, cit1Id);
  assert.equal(singleJson.citation.version, 2);
  assert.equal(singleJson.versions.length, 2);
  assert.equal(singleJson.versions[0].version, 1);
  assert.equal(singleJson.versions[1].version, 2);

  // Pinned version 1: .json
  const v1JsonRes = await worker.fetch(`${origin}/p/${problemId}/citations/${cit1Id}@1.json`);
  assert.equal(v1JsonRes.status, 200);
  const v1Json = SingleCitationResponseSchema.parse(await v1JsonRes.json());
  assert.equal(v1Json.citation.version, 1);
  assert.equal(v1Json.citation.title, validDoiPayload.title);

  // BibTeX export: .bib
  const bibRes = await worker.fetch(`${origin}/p/${problemId}/citations/${cit1Id}.bib`);
  assert.equal(bibRes.status, 200);
  assert.equal(bibRes.headers.get("content-type"), "application/x-bibtex; charset=utf-8");
  const bibText = await bibRes.text();
  assert.ok(bibText.includes(`@article{${cit1Id},`));
  assert.ok(bibText.includes("10.1007/s00222-020-00980-8"));

  // CSL JSON export: .csl.json
  const cslRes = await worker.fetch(`${origin}/p/${problemId}/citations/${cit1Id}.csl.json`);
  assert.equal(cslRes.status, 200);
  assert.equal(
    cslRes.headers.get("content-type"),
    "application/vnd.citationstyles.csl+json; charset=utf-8",
  );
  const cslJson = await cslRes.json();
  assert.equal(cslJson.id, cit1Id);
  assert.equal(cslJson.type, "article-journal");
  assert.equal(cslJson.DOI, "10.1007/s00222-020-00980-8");

  // Single citation face: .md & .html
  const singleMdRes = await worker.fetch(`${origin}/p/${problemId}/citations/${cit1Id}.md`);
  assert.equal(singleMdRes.status, 200);
  const singleMd = await singleMdRes.text();
  assert.ok(singleMd.includes(`Citation [${cit1Id}@v2]`));
  assert.ok(singleMd.includes("Version History"));

  const singleHtmlRes = await worker.fetch(`${origin}/p/${problemId}/citations/${cit1Id}.html`);
  assert.equal(singleHtmlRes.status, 200);
  const singleHtml = await singleHtmlRes.text();
  assert.ok(singleHtml.includes(cit1Id));

  // --------------------------------------------------------------------------
  // LEDGER PACK LITERATURE PROFILE
  // --------------------------------------------------------------------------

  const packRes = await call(
    `/v1/sessions/${sessionIdA}/pack?profile=literature`,
    undefined,
    authorA,
    200,
  );
  assert.ok(Array.isArray(packRes.items));
  const litItems = packRes.items.filter((c) => c.kind === "citation");
  assert.equal(litItems.length, 3);
  assert.ok(litItems.some((c) => c.id.startsWith(cit1Id)));
  assert.ok(litItems.some((c) => c.id.startsWith(cit2Id)));
  assert.ok(litItems.some((c) => c.id.startsWith(cit3Id)));

  // --------------------------------------------------------------------------
  // DATABASE IMMUTABILITY TRIGGERS
  // --------------------------------------------------------------------------

  // Hard delete on citations table refused by trigger
  await assert.rejects(
    async () => {
      await env.DB.prepare("DELETE FROM citations WHERE citation_id = ?").bind(cit1Id).run();
    },
    (err) => {
      return String(err).includes("CITATION_IMMUTABLE");
    },
  );

  // Update on citation_versions table refused by trigger
  await assert.rejects(
    async () => {
      await env.DB.prepare("UPDATE citation_versions SET title = 'tampered' WHERE citation_id = ?")
        .bind(cit1Id)
        .run();
    },
    (err) => {
      return String(err).includes("CITATION_VERSION_IMMUTABLE");
    },
  );

  // Delete on citation_versions table refused by trigger
  await assert.rejects(
    async () => {
      await env.DB.prepare("DELETE FROM citation_versions WHERE citation_id = ?")
        .bind(cit1Id)
        .run();
    },
    (err) => {
      return String(err).includes("CITATION_VERSION_IMMUTABLE");
    },
  );

  console.log(
    JSON.stringify({
      kind: "citations-real-bindings",
      status: "pass",
      problem_id: problemId,
      citation_ids: [cit1Id, cit2Id, cit3Id],
    }),
  );
});
