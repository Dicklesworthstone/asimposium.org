import assert from "node:assert/strict";
import { PackResponseSchema, TriageResponseSchema } from "@asimposium/contracts";
import { FormalRecordsResponseSchema } from "@asimposium/contracts/formal-records";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Cursor-aware orientation, review-queue and formal pack profiles (beads asimposiumorg-lu59 /
// asimposiumorg-codz) on real local Workerd HTTP and D1. The review-queue pack
// must agree with /v1/p/:id/next for an independent reviewer (same first
// target), and must never present a same-sponsor candidate as more than T0.
// The formal profile carries open proof gaps and verification records.
//
// Not covered: formal-artifact evidence uploads, TOON faces.

function json(text) {
  return JSON.parse(text);
}

await runLocalWorkerJourney(async ({ call, enroll, sponsorCall, operatorCall, worker, origin, userAgent }) => {
  const OWNER = "usr_packs_owner";
  const author = await enroll("packs-author", OWNER);
  const sibling = await enroll("packs-sibling", OWNER);
  const outsider = await enroll("packs-outsider", "usr_packs_outsider");
  const created = await call(
    "/v1/problems",
    {
      title: "Pack selection problem",
      statement: "For all natural numbers n, n + 0 = n in the pack lane.",
      falsifier: "A natural number n such that n + 0 !== n.",
      motivation: "Exercise review-queue and formal packs.",
      areas: ["number-theory"],
    },
    author,
    201,
  );
  const problem = created.problem.id;
  const ownedDraft = await call(`/v1/problems/${problem}`, undefined, author);
  assert.equal(ownedDraft.problem.statement, created.problem.statement, "owned draft reads remain available");
  await call(`/v1/problems/${problem}`, undefined, undefined, 404);
  await sponsorCall(
    OWNER,
    "POST",
    `/v1/sponsors/problems/${problem}/lifecycle`,
    "problem-lifecycle",
    {
      action: "publish",
    },
  );
  const sessionOf = async (token, intent) =>
    (await call("/v1/sessions", { problem_id: problem, intent }, token, 201)).session_id;
  const outsiderSession = await sessionOf(outsider, "review");
  await call(
    `/v1/problems/${problem}/statement-review`,
    {
      session_id: outsiderSession,
      statement_version: 1,
      verdict: "statement-clear",
      basis: "Exact.",
    },
    outsider,
  );
  const authorSession = await sessionOf(author, "prove");
  const initialOrientation = PackResponseSchema.parse(
    await call(
      `/v1/sessions/${authorSession}/pack?profile=working&max_tokens=8000`,
      undefined,
      author,
    ),
  );
  const initialFormulation = initialOrientation.items.find(
    (item) => item.kind === "problem-formulation",
  );
  assert.ok(initialFormulation, "a working pack carries its committed problem formulation");
  const formulation = json(initialFormulation.body);
  assert.equal(formulation.statement, created.problem.statement);
  assert.equal(formulation.falsifier, created.problem.falsifier);
  assert.equal(formulation.motivation, created.problem.motivation);
  assert.equal(formulation.statement_version, 1);
  assert.equal(initialFormulation.untrusted, true);
  const orientationCursor = initialOrientation.cursor;
  const completeFormulation = await call(`/v1/problems/${problem}`);
  assert.equal(completeFormulation.problem.statement, formulation.statement);
  // Visibility restoration appends a later operator control; committed
  // event content and its irreversible redaction state are never rewritten.
  const controlFormulation = (action) =>
    operatorCall("POST", "/v1/operators/content-control", "operator.content.control", {
      target_id: problem,
      target_kind: "problem",
      action,
      reason: "Pack lane: operator review of the problem formulation.",
    });
  await controlFormulation("hide");
  try {
    const unavailableDetail = await call(`/v1/problems/${problem}`, undefined, undefined, 404);
    assert.equal(unavailableDetail.code, "PROBLEM_NOT_FOUND");
    assert.ok(!JSON.stringify(unavailableDetail).includes(formulation.statement));
    const unavailablePack = PackResponseSchema.parse(
      await call(
        `/v1/sessions/${authorSession}/pack?profile=orient&max_tokens=8000`,
        undefined,
        author,
      ),
    );
    assert.ok(
      !unavailablePack.items.some((item) => item.kind === "problem-formulation"),
      "withdrawn formulation text is absent from the pack",
    );
    assert.ok(!JSON.stringify(unavailablePack).includes(formulation.statement));
  } finally {
    await controlFormulation("restore");
  }
  assert.equal(
    (await call(`/v1/problems/${problem}`)).problem.statement,
    formulation.statement,
    "committed formulation bytes return unchanged after visibility restoration",
  );
  const draft = await call(
    `/v1/sessions/${authorSession}/workshop`,
    { type: "claim-draft", title: "Draft", body_md: "Private." },
    author,
    201,
  );
  const claim = (
    await call(
      `/v1/sessions/${authorSession}/promote`,
      {
        workshop_id: draft.workshop_id,
        kind: "conjecture",
        statement: "For all natural n, n + 0 = n.",
        falsifier: "A natural n such that n + 0 !== n.",
        scientific_provenance: {
          model_family_self_declared: "gpt",
          method: { category: "deductive", procedure: "Peano axioms.", evidence: [] },
        },
      },
      author,
      201,
    )
  ).claim_id;
  const pack = async (session, token, profile) =>
    PackResponseSchema.parse(
      await call(
        `/v1/sessions/${session}/pack?profile=${profile}&max_tokens=8000`,
        undefined,
        token,
      ),
    );
  const candidates = (p) =>
    p.items.filter((item) => item.kind === "review-candidate").map((item) => item.id);

  const changed = PackResponseSchema.parse(
    await call(
      `/v1/sessions/${authorSession}/pack?profile=orient&max_tokens=8000&since=${orientationCursor}`,
      undefined,
      author,
    ),
  );
  const changes = changed.items
    .filter((item) => item.kind === "orientation-event")
    .map((item) => json(item.body));
  assert.ok(
    changes.some(
      (event) => event.event?.type === "claim.created" && event.event.object_id === claim,
    ),
    "the next orientation contains the newly published claim",
  );
  assert.ok(
    changes.every((event) => event.seq > orientationCursor && event.seq <= changed.cursor),
    "the material delta stays in the requested captured cursor window",
  );
  assert.equal(
    changed.items.find((item) => item.kind === "problem-formulation").body,
    initialFormulation.body,
    "standing formulation bytes are stable while ledger changes arrive",
  );
  assert.ok(!JSON.stringify(changes).includes("Private."), "delta envelopes have no workshop body");
  const completeTailAction = changed.next_actions.find((action) =>
    action.url.includes("/events.json?"),
  );
  assert.ok(completeTailAction, "a bounded summary links to its complete canonical tail");
  const completeTail = await call(completeTailAction.url);
  assert.equal(completeTail.page_end.since, orientationCursor);
  assert.equal(completeTail.page_end.through, changed.cursor);
  const caughtUp = PackResponseSchema.parse(
    await call(
      `/v1/sessions/${authorSession}/pack?profile=working&since=${changed.cursor}`,
      undefined,
      author,
    ),
  );
  assert.equal(
    caughtUp.items.filter((item) => item.kind === "orientation-event").length,
    0,
    "an already observed cursor has no repeated event delta",
  );
  for (const since of [
    "-1",
    "01",
    "1e1",
    "9007199254740992",
    String(changed.cursor + 100),
    "0&since=1",
  ]) {
    const refusal = await call(
      `/v1/sessions/${authorSession}/pack?profile=working&since=${since}`,
      undefined,
      author,
      400,
    );
    assert.equal(refusal.code, "CURSOR_INVALID");
    assert.ok(refusal.fix_hint && refusal.schema && refusal.example, "cursor refusal teaches repair");
  }

  // Same sponsor as the author: if offered, the candidate discloses T0 and
  // never claims independence (a same-sponsor review carries no weight).
  const siblingSession = await sessionOf(sibling, "review");
  const siblingPack = await pack(siblingSession, sibling, "review-queue");
  for (const item of siblingPack.items.filter((i) => i.kind === "review-candidate")) {
    if (item.id.startsWith(`${claim}@`)) {
      assert.equal(json(item.body).prospective_independence_tier, "T0");
    }
  }

  // Independent reviewer: the pack's first target is /next's review target.
  const outsiderQueue = candidates(await pack(outsiderSession, outsider, "review-queue"));
  assert.ok(outsiderQueue.includes(`${claim}@1`), `outsider queue: ${outsiderQueue}`);
  const next = await call(`/v1/p/${problem}/next`, undefined, outsider, 200);
  assert.equal(next.primary_move?.move, "review");
  assert.equal(outsiderQueue[0], next.primary_move.refs[1], "pack and /next agree");
  // Triage (one assigned problem) recommends the same move, non-degraded.
  const triage = TriageResponseSchema.parse(await call("/v1/triage", undefined, outsider, 200));
  assert.equal(triage.degraded, false);
  assert.equal(triage.move?.move, "review");
  assert.deepEqual(triage.move?.refs.slice(0, 2), next.primary_move.refs.slice(0, 2));

  // Same-cursor Diptych: the event tail's JSON and TOON faces carry the same
  // events, and the TOON face revalidates with its ETag.
  const tailJson = await call(`/p/${problem}/events.json?since=0`);
  const eventIds = (tailJson.events ?? []).map((e) => e.event?.id ?? e.id);
  assert.ok(eventIds.length >= 3, `event tail lists events: ${Object.keys(tailJson)}`);
  const toon = await worker.fetch(`${origin}/p/${problem}/events.toon?since=0`, {
    headers: { "User-Agent": userAgent },
  });
  assert.equal(toon.status, 200);
  const toonText = await toon.text();
  for (const id of eventIds) assert.ok(toonText.includes(id), `TOON face carries ${id}`);
  const toonEtag = toon.headers.get("etag");
  assert.ok(toonEtag);
  const revalidated = await worker.fetch(`${origin}/p/${problem}/events.toon?since=0`, {
    headers: { "User-Agent": userAgent, "If-None-Match": toonEtag },
  });
  assert.equal(revalidated.status, 304);

  // Formal profile: a verification report and an open proof gap.
  const proof = (
    await call(
      `/v1/sessions/${authorSession}/evidence`,
      {
        bears_on_kind: "claim",
        bears_on_id: claim,
        bears_on_version: 1,
        direction: "supports",
        kind: "argument",
        mode: "confirmatory",
        source: { kind: "locator", locator: "https://example.invalid/peano", excerpt: "Peano." },
        body_md: "By the Peano axioms.",
      },
      author,
      201,
    )
  ).evidence_id;
  const reviewPack = await call(
    `/v1/sessions/${outsiderSession}/pack?${new URLSearchParams({ profile: "review", target: `${claim}@1` })}`,
    undefined,
    outsider,
  );
  assert.ok(
    reviewPack.items.every(
      (item) => item.kind !== "orientation-event" && item.kind !== "problem-formulation",
    ),
    "P12: explicit review packs retain their separate target-only context selection",
  );
  const claimDigest = json(
    reviewPack.items.find((item) => item.kind === "claim-detail").body,
  ).content_digest;
  const proofRef = {
    evidence_id: proof,
    digest: json(reviewPack.items.find((item) => item.id === proof).body).content_digest,
  };
  await call(
    `/v1/sessions/${outsiderSession}/review`,
    {
      target_claim_id: claim,
      target_version: 1,
      verdict: "confirm",
      basis: "Full write-up verification.",
      capable_of_failure: "A flaw in the argument.",
      verification: {
        kind: "full-write-up",
        target_digest: claimDigest,
        evidence: proofRef,
        coverage: ["all n"],
        result: "verified",
      },
      scientific_provenance: {
        model_family_self_declared: "claude",
        method: { category: "deductive", procedure: "Direct check.", evidence: [proofRef] },
      },
      body_md: "Verified.",
    },
    outsider,
    201,
  );
  await call(
    `/v1/sessions/${authorSession}/gaps`,
    {
      target_claim_id: claim,
      target_version: 1,
      obligation: "Show the successor case explicitly.",
      closes_what: "The inductive step of the identity.",
    },
    author,
    null,
  );
  const formal = await pack(authorSession, author, "formal");
  const kinds = new Set(formal.items.map((item) => item.kind));
  assert.ok(kinds.has("proof-gap"), `formal pack carries the open proof gap: ${[...kinds]}`);
  // Fable §7.3: formal records ride beside the gaps (kw85).
  assert.ok(
    kinds.has("verification-report"),
    `formal pack carries the verification: ${[...kinds]}`,
  );
  const verification = formal.items.find((item) => item.kind === "verification-report");
  assert.equal(verification.untrusted, true);
  assert.ok(!verification.body.includes("Private."), "no workshop bytes in formal records");

  // The public formal-records face (Rule A1): the same record, anonymously, in
  // every format, with paging/exact-target contracts that teach on refusal.
  const face = async (path, headers = {}) =>
    worker.fetch(`${origin}${path}`, { headers: { "user-agent": userAgent, ...headers } });
  const listed = await face(`/p/${problem}/formal.json`);
  assert.equal(listed.status, 200, "the formal-records JSON face is mounted");
  const listedText = await listed.text();
  assert.ok(!listedText.includes("Private."), "formal.json carries no workshop bytes");
  const formalFace = FormalRecordsResponseSchema.parse(JSON.parse(listedText));
  const report = formalFace.records.find((record) => record.kind === "verification-report");
  assert.ok(report, "the public face carries the verification report");
  assert.equal(report.target.claim_id, claim);
  for (const [format, media] of [
    ["md", "text/markdown"],
    ["html", "text/html"],
  ]) {
    const rendered = await face(`/p/${problem}/formal.${format}`);
    assert.equal(rendered.status, 200, `formal.${format} is mounted`);
    assert.ok(rendered.headers.get("content-type").startsWith(media));
    const text = await rendered.text();
    assert.ok(text.includes(report.publication.object_id), `formal.${format} names the record`);
    assert.ok(!text.includes("Private."), `formal.${format} carries no workshop bytes`);
  }
  const exact = await face(
    `/p/${problem}/formal.json?through=${formalFace.cursor}&target=${report.publication.object_id}`,
  );
  assert.equal(exact.status, 200);
  const exactFace = FormalRecordsResponseSchema.parse(await exact.json());
  assert.deepEqual(
    exactFace.records.map((record) => record.publication.object_id),
    [report.publication.object_id],
  );
  const etag = listed.headers.get("etag");
  assert.equal((await face(`/p/${problem}/formal.json`, { "if-none-match": etag })).status, 304);
  const badQuery = await face(
    `/p/${problem}/formal.json?after=0&target=${report.publication.object_id}`,
  );
  assert.equal(badQuery.status, 400);
  assert.equal((await badQuery.json()).code, "FORMAL_RECORDS_QUERY_INVALID");
  assert.equal((await face(`/p/${problem}/formal.json?after=0&after=1`)).status, 400);
  const unknownTarget = await face(`/p/${problem}/formal.json?target=R-NOSUCHRECORD`);
  assert.equal(unknownTarget.status, 404);
  assert.equal((await unknownTarget.json()).code, "FORMAL_RECORD_NOT_FOUND");
  assert.equal((await face("/schemas/formal-records.v1.json")).status, 200, "its schema is served");

  console.log(
    JSON.stringify({
      stage: "packs-journey-passed",
      kind: "packs-real-bindings",
      status: "pass",
      formal_kinds: [...kinds],
      boundary:
        "real local Workerd/D1; cursor-aware orientation/formulation, review-queue, formal, triage, event-tail JSON/TOON faces",
    }),
  );
});
