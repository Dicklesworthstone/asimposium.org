import assert from "node:assert/strict";
import {
  WORKSHOP_SEARCH_PAGE_LIMIT,
  WORKSHOP_SEARCH_SCHEMA_ID,
  WorkshopSearchResponseSchema,
} from "@asimposium/contracts/workshop-search";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Production routes, signed envelopes, D1 FTS5 triggers and private R2 are real.
// Enrollment approval and screening output are explicit harness fixtures;
// this lane does not claim live Google authentication or deployment evidence.
await runLocalWorkerJourney(async ({ call, enroll, env, sponsorCall, workerLogs }) => {
  const owner = "usr_private_search_owner";
  const other = "usr_private_search_other";
  const token = await enroll("private-search-author", owner);
  const otherToken = await enroll("private-search-other", other);
  const searchPath = "/v1/sponsors/workshops/search";
  const search = async (input = { query: "searchneedle" }, sponsor = owner) =>
    WorkshopSearchResponseSchema.parse(
      await sponsorCall(sponsor, "POST", searchPath, "workshop.search", input),
    );
  const propose = async (credential, title, distinct) => {
    const created = await call(
      "/v1/problems",
      {
        title,
        statement: "Every finite simple path with n edges has n plus one vertices.",
        falsifier: "A finite simple path with a different number of vertices.",
        motivation: "Investigate the endpoint boundary before offering a public formulation.",
        areas: ["combinatorics"],
        ...(distinct ? { distinct_because: distinct } : {}),
      },
      credential,
      201,
    );
    const session = await call("/v1/sessions", { problem_id: created.problem.id }, credential, 201);
    return { problem: created.problem.id, session: session.session_id };
  };
  const here = await propose(token, "Private endpoint boundary exploration");
  const there = await propose(
    otherToken,
    "Another sponsor's private path exploration",
    "Keep this sponsor's independent endpoint construction private while checking its own boundary assumptions.",
  );
  const fellow = await env.DB.prepare("SELECT fellow_id FROM sessions WHERE session_id=?")
    .bind(here.session)
    .first();
  const otherFellow = await env.DB.prepare("SELECT fellow_id FROM sessions WHERE session_id=?")
    .bind(there.session)
    .first();
  assert.ok(fellow?.fellow_id);
  assert.ok(otherFellow?.fellow_id);
  const push = (context, credential, body) =>
    call(`/v1/sessions/${context.session}/workshop`, body, credential, 201);
  const privateCanary = "SEARCH_PRIVATE_CANARY_BODY";
  const otherCanary = "SEARCH_OTHER_SPONSOR_CANARY";
  const drafts = [];
  for (let i = 0; i < WORKSHOP_SEARCH_PAGE_LIMIT + 3; i += 1) {
    drafts.push(
      await push(here, token, {
        type: "scratch",
        title: `Private indexed draft ${i}`,
        body_md: `${privateCanary} searchneedle ${i === 0 ? "oldneedle " : ""}${"endpoint ".repeat(40)}deepneedle`,
      }),
    );
  }
  const spilledBody = `${privateCanary} searchneedle savedneedle ${"deliberate endpoint work product ".repeat(200)}casbodytailneedle`;
  const spilled = await push(here, token, {
    type: "scratch",
    title: "Long private draft",
    body_md: spilledBody,
  });
  drafts.push(spilled);
  const spilledRow = await env.DB.prepare(
    "SELECT body_md,cas_hash FROM workshop_objects WHERE workshop_id=?",
  )
    .bind(spilled.workshop_id)
    .first();
  assert.ok(spilledRow.cas_hash, "this draft actually spills through the production R2 path");
  assert.ok(spilledRow.body_md.length <= 280);
  const storedBody = await env.ARTIFACTS.get(`cas/sha256/${spilledRow.cas_hash.slice(7)}`);
  assert.ok(storedBody, "the private CAS object exists in real local R2");
  assert.equal(await storedBody.text(), spilledBody);
  const foreign = await push(there, otherToken, {
    type: "scratch",
    title: "Foreign searchneedle title",
    body_md: `${otherCanary} searchneedle deepneedle`,
  });

  const beforeSearch = await env.DB.prepare(
    "SELECT cursor FROM public_cursor WHERE singleton=1",
  ).first();
  const first = await search();
  assert.equal(first.items.length, WORKSHOP_SEARCH_PAGE_LIMIT);
  assert.ok(first.next_cursor);
  assert.ok(
    first.items.every(
      (item) => item.fellow_id === fellow.fellow_id && item.problem_id === here.problem,
    ),
  );
  assert.ok(!JSON.stringify(first).includes(otherCanary));
  assert.ok(!JSON.stringify(first).includes(foreign.workshop_id));
  assert.ok(!JSON.stringify(first).includes(spilledRow.cas_hash));
  assert.equal(first.next_cursor, first.items.at(-1).workshop_id);
  assert.deepEqual(Object.keys(first).sort(), [
    "coverage",
    "items",
    "next_cursor",
    "query",
    "schema",
    "sponsor_id",
  ]);

  const edited = drafts.find((draft) => draft.workshop_id === first.items[0].workshop_id);
  await push(here, token, {
    workshop_id: edited.workshop_id,
    base_version: 1,
    title: "Revised private indexed title",
    body_md: `${privateCanary} searchneedle revisedneedle endpoint`,
  });
  const second = await search({ query: "searchneedle", after: first.next_cursor });
  assert.equal(second.next_cursor, null);
  assert.deepEqual(
    [...first.items, ...second.items].map((item) => item.workshop_id),
    drafts.map((draft) => draft.workshop_id).sort(),
    "editing a previous hit cannot reorder unseen drafts",
  );
  assert.equal((await search({ query: "revisedneedle" })).items[0].version, 2);
  if (edited.workshop_id === drafts[0].workshop_id)
    assert.deepEqual(
      (await search({ query: "oldneedle" })).items,
      [],
      "the trigger removes old terms",
    );
  const inline = await search({ query: "deepneedle" });
  assert.ok(inline.items.every((item) => item.body_coverage === "inline-body"));
  assert.ok(
    inline.items.every((item) => !item.excerpt.includes("deepneedle")),
    "search reaches beyond the returned excerpt",
  );
  const saved = await search({ query: "savedneedle" });
  assert.equal(saved.items[0].workshop_id, spilled.workshop_id);
  assert.equal(saved.items[0].body_coverage, "stored-extract");
  assert.deepEqual(
    (await search({ query: "casbodytailneedle" })).items,
    [],
    "unindexed R2 tail is never falsely advertised as searchable",
  );
  assert.deepEqual(
    (await search({ query: "searchneedle OR deepneedle" })).items,
    [],
    "OR remains a literal word",
  );

  await sponsorCall(
    owner,
    "POST",
    "/v1/sponsors/workshop/action",
    "workshop.action",
    {
      fellow_id: fellow.fellow_id,
      problem_id: here.problem,
      workshop_id: edited.workshop_id,
      expected_workshop_version: 2,
      action: "discard",
    },
    201,
  );
  const discarded = await search({ query: "searchneedle", state: "discarded" });
  assert.deepEqual(
    discarded.items.map((item) => item.workshop_id),
    [edited.workshop_id],
  );
  assert.equal(discarded.items[0].version, 3);
  const foreignFilter = await search({ query: "searchneedle", fellow_id: otherFellow.fellow_id });
  const absentFilter = await search({ query: "searchneedle", fellow_id: "fellow-does-not-exist" });
  assert.deepEqual(
    foreignFilter,
    absentFilter,
    "a foreign Fellow filter reveals no existence metadata",
  );
  assert.deepEqual((await search({ query: "searchneedle", problem_id: there.problem })).items, []);
  assert.deepEqual(
    (await search({ query: "searchneedle" }, other)).items.map((item) => item.workshop_id),
    [foreign.workshop_id],
  );
  await call(searchPath, { query: "searchneedle" }, token, 403);
  await call(searchPath, { query: "searchneedle" }, undefined, 403);
  await sponsorCall(owner, "POST", searchPath, "workshop.read", { query: "searchneedle" }, 401);
  const invalid = await sponsorCall(
    owner,
    "POST",
    searchPath,
    "workshop.search",
    {
      query: "PRIVATE_QUERY_VALIDATION_CANARY",
      sponsor_id: other,
    },
    422,
  );
  assert.equal(invalid.code, "WORKSHOP_READ_BODY_INVALID");
  assert.ok(!JSON.stringify(invalid).includes("PRIVATE_QUERY_VALIDATION_CANARY"));
  await sponsorCall(
    owner,
    "POST",
    `${searchPath}?query=private`,
    "workshop.search",
    { query: "searchneedle" },
    400,
    searchPath,
  );

  const publicSearch = await call("/search.json?q=searchneedle");
  assert.ok(!JSON.stringify(publicSearch).includes(privateCanary));
  assert.ok(!JSON.stringify(publicSearch).includes(otherCanary));
  assert.equal((await call(`/p/${here.problem}.json`, undefined, undefined, 404)).status, 404);
  const schema = await call("/schemas/workshop-search.v1.json");
  assert.equal(schema.$id, WORKSHOP_SEARCH_SCHEMA_ID);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(
    await env.DB.prepare("SELECT cursor FROM public_cursor WHERE singleton=1").first(),
    beforeSearch,
    "private searching and discarding do not emit public activity",
  );

  const erase = await propose(
    token,
    "Private deletion boundary probe",
    "This draft isolates the zero-edge case for a disposable prepublication check.",
  );
  const erased = await push(erase, token, {
    type: "scratch",
    title: "Erase private index",
    body_md: "eraseneedle searchneedle",
  });
  assert.deepEqual(
    (await search({ query: "eraseneedle" })).items.map((item) => item.workshop_id),
    [erased.workshop_id],
  );
  await sponsorCall(
    owner,
    "DELETE",
    `/v1/sponsors/problems/${erase.problem}`,
    "delete-problem-draft",
  );
  assert.deepEqual((await search({ query: "eraseneedle" })).items, []);
  assert.equal(
    (
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM private_workshop_search WHERE private_workshop_search MATCH 'eraseneedle'",
      ).first()
    ).count,
    0,
    "draft erasure removes FTS postings in the same D1 transaction",
  );

  const now = () => Math.floor(Date.now() / 1000);
  const offer = await sponsorCall(
    owner,
    "POST",
    "/v1/sponsors/transfers",
    "sponsor.transfer.initiate",
    {
      fellow_id: fellow.fellow_id,
      target_sponsor_id: other,
      confirm: "initiate-fellow-transfer",
      step_up_authenticated_at: now(),
      directive_attestation: "no_directives",
    },
    201,
  );
  await sponsorCall(
    other,
    "POST",
    `/v1/sponsors/transfers/${offer.transfer_id}/accept`,
    "sponsor.transfer.accept",
    {
      transfer_id: offer.transfer_id,
      confirm: "accept-fellow-transfer",
      step_up_authenticated_at: now(),
    },
  );
  assert.deepEqual(
    (await search()).items,
    [],
    "former sponsor loses all search access immediately",
  );
  const transferred = await search({ query: "savedneedle", fellow_id: fellow.fellow_id }, other);
  assert.equal(transferred.items[0].workshop_id, spilled.workshop_id);
  assert.equal(transferred.sponsor_id, other);
  assert.ok(!workerLogs().join("\n").includes(privateCanary));
  assert.ok(!workerLogs().join("\n").includes("PRIVATE_QUERY_VALIDATION_CANARY"));
  console.log(
    JSON.stringify({
      kind: "workshop-search-real-bindings",
      status: "pass",
      drafts: drafts.length,
      coverage:
        "real local Workerd/D1 FTS5/private R2; signed scoped reads, edits, pagination, transfer and erasure",
    }),
  );
});
