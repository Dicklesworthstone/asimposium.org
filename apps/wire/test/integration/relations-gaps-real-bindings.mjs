import assert from "node:assert/strict";
import {
  EvidenceResponseSchema,
  FullPackPageSchema,
  GapClosedResponseSchema,
  GapFiledResponseSchema,
  InboxResponseSchema,
  PackResponseSchema,
  RelationDisputedResponseSchema,
  RelationFiledResponseSchema,
} from "@asimposium/contracts";
import { EventTailResponseSchema } from "@asimposium/contracts/event-tail";
import { ProofGapsResponseSchema } from "@asimposium/contracts/proof-gaps";
import { renderAllFaces } from "@asimposium/render";
import { faceCensus } from "./face-census.mjs";
import { assertFullPackPublication } from "./full-pack-publication.mjs";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";
import { assertProjectionsRebuild } from "./projection-rebuild-check.mjs";

assert.equal(process.versions.bun, undefined, "This lane requires genuine Node");

await runLocalWorkerJourney(async (context) => {
  const { call, enroll, sponsorCall, env, fixtures, worker, origin, userAgent } = context;
  const sponsorA = "usr_rel_sponsor_a";
  const authorA = await enroll("rel-author-a", sponsorA);
  const helloA = await call("/v1/hello", undefined, authorA);
  const _fellowIdA = helloA.fellow.fellow_id;

  const sponsorB = "usr_rel_sponsor_b";
  const reviewerB = await enroll("rel-reviewer-b", sponsorB);
  const helloB = await call("/v1/hello", undefined, reviewerB);
  const _fellowIdB = helloB.fellow.fellow_id;

  // 1. Propose and publish problem
  const created = await call(
    "/v1/problems",
    {
      title: "Claim relations and proof gaps test problem",
      statement: "Every non-trivial modular cycle has bounded residue length.",
      falsifier: "An unbounded residue length under modular transformation.",
      motivation: "Testing W5.5 relations, disputes, and proof gaps.",
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
  await govern({ action: "publish" }, "publish-rel-problem");

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

  // 2. Open author session and promote Claim 1 and Claim 2
  const sessionA = await call(
    "/v1/sessions",
    { problem_id: problemId, intent: "prove" },
    authorA,
    201,
  );
  const sessionIdA = sessionA.session_id;

  const workshop1 = await call(
    `/v1/sessions/${sessionIdA}/workshop`,
    {
      type: "claim-draft",
      title: "Draft 1: Upper Bound",
      body_md: "Analysis supporting upper bound.",
      relates_to: [],
    },
    authorA,
    201,
  );
  const claim1 = await call(
    `/v1/sessions/${sessionIdA}/promote`,
    {
      workshop_id: workshop1.workshop_id,
      kind: "conjecture",
      statement: "The cycle length modulo 2^k is strictly bounded from above by 2k.",
      falsifier: "A cycle of length > 2k modulo 2^k.",
    },
    authorA,
    201,
  );
  const claim1Id = claim1.claim_id;

  const workshop2 = await call(
    `/v1/sessions/${sessionIdA}/workshop`,
    {
      type: "claim-draft",
      title: "Draft 2: Lower Bound",
      body_md: "Analysis supporting lower bound.",
      relates_to: [],
    },
    authorA,
    201,
  );
  const claim2 = await call(
    `/v1/sessions/${sessionIdA}/promote`,
    {
      workshop_id: workshop2.workshop_id,
      kind: "conjecture",
      statement: "The cycle length modulo 2^k is unconditionally bounded from below by 3k.",
      falsifier: "A cycle of length < 3k modulo 2^k.",
    },
    authorA,
    201,
  );
  const claim2Id = claim2.claim_id;

  // Full packs hydrate immutable publication bodies through real D1 and
  // traverse every public sequence at one frozen cut, including references
  // for record kinds whose bodies are not part of the typed full-pack view.
  const packPath = `/v1/sessions/${sessionIdA}/pack`;
  const fullFirst = PackResponseSchema.parse(
    await call(`${packPath}?profile=full&max_tokens=800`, undefined, authorA),
  );
  const fullControl = (pack) =>
    FullPackPageSchema.parse(
      JSON.parse(pack.items.find((item) => item.kind === "full-page")?.body ?? "null"),
    );
  const fullCut = fullControl(fullFirst).through;
  const fullSequences = [];
  let fullPage = fullFirst;
  for (;;) {
    const control = fullControl(fullPage);
    assert.equal(control.through, fullCut);
    assert.equal(control.after, fullSequences.length);
    const records = fullPage.items
      .filter((item) => item.kind === "full-event")
      .map((item) => JSON.parse(item.body));
    assert.equal(records.length, control.records);
    fullSequences.push(...records.map((record) => record.seq));
    assert.ok(fullSequences.length <= fullCut);
    if (!control.has_more) break;
    const next = fullPage.next_actions.find((action) => action.url.includes("profile=full"));
    assert.ok(next);
    fullPage = PackResponseSchema.parse(await call(next.url, undefined, authorA));
  }
  assert.deepEqual(
    fullSequences,
    Array.from({ length: fullCut }, (_, index) => index + 1),
  );
  const fullBodies = PackResponseSchema.parse(
    await call(
      `${packPath}?profile=full&max_tokens=8000&through=${fullCut}&after=0`,
      undefined,
      authorA,
    ),
  );
  const fullClaims = fullBodies.items
    .filter((item) => item.kind === "full-event")
    .map((item) => JSON.parse(item.body))
    .filter((record) => record.publication?.type === "claim.created");
  assert.deepEqual(
    fullClaims.map((record) => record.publication.object_id),
    [claim1Id, claim2Id],
  );
  assert.deepEqual(
    fullClaims.map((record) => record.content.statement),
    [
      "The cycle length modulo 2^k is strictly bounded from above by 2k.",
      "The cycle length modulo 2^k is unconditionally bounded from below by 3k.",
    ],
  );
  assert.ok(!JSON.stringify(fullBodies).includes("Analysis supporting upper bound."));
  assert.ok(!JSON.stringify(fullBodies).includes("Analysis supporting lower bound."));

  // 3. File a proof gap
  const gapFiled = await call(
    `/v1/sessions/${sessionIdA}/gaps`,
    {
      obligation: "Prove that lemma 2 holds for all odd primes",
      closes_what: "Lemma 2 induction step",
      target_claim_id: claim1Id,
      target_version: 1,
    },
    authorA,
    201,
    "gap-file-key-1",
  );
  GapFiledResponseSchema.parse(gapFiled);
  const gapId = gapFiled.gap_id;
  assert.ok(gapId.startsWith("G-"));
  assert.deepEqual(
    await call(
      `${packPath}?profile=full&max_tokens=800&through=${fullCut}&after=0`,
      undefined,
      authorA,
    ),
    fullFirst,
    "new publications cannot shift a frozen full-pack page",
  );

  // 4. Assert relations
  // 4a. Bad relation payload (422)
  const badRel = await call(
    `/v1/sessions/${sessionIdA}/relations`,
    {
      kind: "implies",
      source_claim_id: claim1Id,
      source_version: 1,
      target: gapId, // implies cannot target gap
    },
    authorA,
    422,
  );
  assert.equal(badRel.code, "RELATION_BODY_INVALID");

  // 4b. Valid claim relation: claim1 implies claim2
  const relKey1 = "rel-assert-key-1";
  const filedRel1 = await call(
    `/v1/sessions/${sessionIdA}/relations`,
    {
      kind: "implies",
      source_claim_id: claim1Id,
      source_version: 1,
      target: `${claim1Id === "C-1" ? "C-2" : claim2Id}@1`,
    },
    authorA,
    201,
    relKey1,
  );
  RelationFiledResponseSchema.parse(filedRel1);
  assert.equal(filedRel1.kind, "implies");
  assert.equal(filedRel1.source, `${claim1Id}@1`);
  assert.equal(filedRel1.target, `${claim2Id}@1`);

  // 4c. Idempotent replay with same key returns 200 with identical body
  const replayRel1 = await call(
    `/v1/sessions/${sessionIdA}/relations`,
    {
      kind: "implies",
      source_claim_id: claim1Id,
      source_version: 1,
      target: `${claim2Id}@1`,
    },
    authorA,
    200,
    relKey1,
  );
  assert.deepEqual(replayRel1, filedRel1);

  // 4d. Duplicate assertion with new key returns 409 RELATION_ALREADY_ASSERTED
  const dupRel1 = await call(
    `/v1/sessions/${sessionIdA}/relations`,
    {
      kind: "implies",
      source_claim_id: claim1Id,
      source_version: 1,
      target: `${claim2Id}@1`,
    },
    authorA,
    409,
    "rel-assert-key-dup",
  );
  assert.equal(dupRel1.code, "RELATION_ALREADY_ASSERTED");

  // 4e. Addresses-gap relation: claim2 addresses gap
  const relGapKey = "rel-assert-gap-key";
  const filedRelGap = await call(
    `/v1/sessions/${sessionIdA}/relations`,
    {
      kind: "addresses-gap",
      source_claim_id: claim2Id,
      source_version: 1,
      target: gapId,
    },
    authorA,
    201,
    relGapKey,
  );
  RelationFiledResponseSchema.parse(filedRelGap);
  assert.equal(filedRelGap.kind, "addresses-gap");
  assert.equal(filedRelGap.target, gapId);

  // 5. Reviewer opens session and inspects claim-graph pack
  const sessionB = await call(
    "/v1/sessions",
    { problem_id: problemId, intent: "review" },
    reviewerB,
    201,
  );
  const sessionIdB = sessionB.session_id;

  const packBefore = await call(
    `/v1/sessions/${sessionIdB}/pack?profile=claim-graph`,
    undefined,
    reviewerB,
    200,
  );
  PackResponseSchema.parse(packBefore);
  // Omitted must NOT contain relation-disputes
  assert.ok(!packBefore.omitted.some((o) => o.detail === "relation-disputes"));
  assert.ok(!packBefore.omitted.some((o) => o.detail === "weakest-link-paths"));
  const graphPaths = packBefore.items.filter((item) => item.kind === "claim-graph-path");
  assert.ok(graphPaths.length >= 1);
  const graphContext = packBefore.items.find((item) => item.id === "SYS-claim-graph-selection");
  assert.ok(graphContext);
  assert.match(graphContext.body, /evidence ceiling is not a truth verdict/i);

  // Check that pack returns the asserted relation
  const relRows = packBefore.items.filter((item) => item.kind === "claim-relation");
  assert.ok(relRows.length >= 2);
  const impliesRow = relRows.find(
    (item) => item.body.includes("implies") && item.body.includes(claim1Id),
  );
  assert.ok(impliesRow);
  assert.ok(impliesRow.body.includes("This edge is an assertion, not an established implication."));

  // 6. Dispute Lifecycle
  // 6a. Malformed dispute body (422)
  const badDispute = await call(
    `/v1/sessions/${sessionIdB}/relations/dispute`,
    {
      kind: "implies",
      source_claim_id: claim1Id,
      source_version: 1,
      target: `${claim2Id}@1`,
      reason: "", // empty reason
    },
    reviewerB,
    422,
  );
  assert.equal(badDispute.code, "RELATION_DISPUTE_BODY_INVALID");

  // 6b. Non-existent relation edge (404)
  const notFoundDispute = await call(
    `/v1/sessions/${sessionIdB}/relations/dispute`,
    {
      kind: "contradicts",
      source_claim_id: claim1Id,
      source_version: 1,
      target: `${claim2Id}@1`,
      reason: "Edge does not exist.",
    },
    reviewerB,
    404,
  );
  assert.equal(notFoundDispute.code, "RELATION_NOT_FOUND");

  // 6c. Self-dispute refused under Rule P1 (422 REVIEWER_IS_AUTHOR)
  const selfDispute = await call(
    `/v1/sessions/${sessionIdA}/relations/dispute`,
    {
      kind: "implies",
      source_claim_id: claim1Id,
      source_version: 1,
      target: `${claim2Id}@1`,
      reason: "I want to dispute my own asserted edge.",
    },
    authorA,
    422,
  );
  assert.equal(selfDispute.code, "REVIEWER_IS_AUTHOR");

  // 6d. ReviewerB successfully disputes the relation (201)
  const disputeKey1 = "rel-dispute-key-1";
  const disputedResp = await call(
    `/v1/sessions/${sessionIdB}/relations/dispute`,
    {
      kind: "implies",
      source_claim_id: claim1Id,
      source_version: 1,
      target: `${claim2Id}@1`,
      reason: "Claim 1 upper bound does not imply Claim 2 lower bound for k=4.",
    },
    reviewerB,
    201,
    disputeKey1,
  );
  RelationDisputedResponseSchema.parse(disputedResp);
  assert.equal(disputedResp.kind, "implies");
  assert.equal(disputedResp.source, `${claim1Id}@1`);
  assert.equal(disputedResp.target, `${claim2Id}@1`);
  assert.equal(disputedResp.status, "disputed");

  // 6e. Idempotent replay of dispute returns 200
  const replayDispute = await call(
    `/v1/sessions/${sessionIdB}/relations/dispute`,
    {
      kind: "implies",
      source_claim_id: claim1Id,
      source_version: 1,
      target: `${claim2Id}@1`,
      reason: "Claim 1 upper bound does not imply Claim 2 lower bound for k=4.",
    },
    reviewerB,
    200,
    disputeKey1,
  );
  assert.deepEqual(replayDispute, disputedResp);

  // 6f. Repeat dispute with new key returns 409 RELATION_ALREADY_DISPUTED
  const repeatDispute = await call(
    `/v1/sessions/${sessionIdB}/relations/dispute`,
    {
      kind: "implies",
      source_claim_id: claim1Id,
      source_version: 1,
      target: `${claim2Id}@1`,
      reason: "Claim 1 upper bound does not imply Claim 2 lower bound for k=4.",
    },
    reviewerB,
    409,
    "rel-dispute-key-repeat",
  );
  assert.equal(repeatDispute.code, "RELATION_ALREADY_DISPUTED");

  // 6g. Check pack after dispute: edge is reflected as disputed
  const packAfter = await call(
    `/v1/sessions/${sessionIdB}/pack?profile=claim-graph`,
    undefined,
    reviewerB,
    200,
  );
  PackResponseSchema.parse(packAfter);
  const impliesRowAfter = packAfter.items.find(
    (item) =>
      item.kind === "claim-relation" &&
      item.body.includes("implies") &&
      item.body.includes(claim1Id),
  );
  assert.ok(impliesRowAfter);
  assert.ok(
    impliesRowAfter.body.includes(
      `Status: disputed. A dispute is recorded at #${disputedResp.seq}.`,
    ),
  );
  assert.ok(
    impliesRowAfter.body.includes(
      "Claim 1 upper bound does not imply Claim 2 lower bound for k=4.",
    ),
  );

  // 6h. ReviewerB disputes addresses-gap relation
  const gapDisputeResp = await call(
    `/v1/sessions/${sessionIdB}/relations/dispute`,
    {
      kind: "addresses-gap",
      source_claim_id: claim2Id,
      source_version: 1,
      target: gapId,
      reason: "Claim 2 lower bound does not prove lemma 2 for odd primes.",
    },
    reviewerB,
    201,
  );
  RelationDisputedResponseSchema.parse(gapDisputeResp);
  assert.equal(gapDisputeResp.status, "disputed");
  assert.equal(gapDisputeResp.target, gapId);

  // 7. Transition / Close Proof Gap
  const openGapState = async () => ({
    head: await env.DB.prepare("SELECT public_seq, chain_digest FROM problems WHERE id = ?")
      .bind(problemId)
      .first(),
    events: await env.DB.prepare(
      "SELECT count(*) AS count, max(seq) AS seq FROM events WHERE problem_id = ?",
    )
      .bind(problemId)
      .first(),
    gap: await env.DB.prepare(
      "SELECT status, closed_by, closed_at FROM proof_gaps WHERE problem_id = ? AND gap_id = ?",
    )
      .bind(problemId, gapId)
      .first(),
  });
  const beforeInvalidClosure = await openGapState();
  const unknownVersionClosure = await call(
    `/v1/sessions/${sessionIdA}/gaps/close`,
    { gap_id: gapId, outcome: "closed-by", closed_by: `${claim2Id}@999` },
    authorA,
    422,
    "gap-close-nonexistent-version",
  );
  assert.equal(unknownVersionClosure.code, "GAP_TARGET_UNKNOWN");
  assert.deepEqual(
    await openGapState(),
    beforeInvalidClosure,
    "a nonexistent claim version must not close the gap or advance the ledger",
  );
  const gapCloseResp = await call(
    `/v1/sessions/${sessionIdA}/gaps/close`,
    {
      gap_id: gapId,
      outcome: "closed-by",
      closed_by: `${claim2Id}@1`,
    },
    authorA,
    201,
    "gap-close-key-1",
  );
  GapClosedResponseSchema.parse(gapCloseResp);
  assert.equal(gapCloseResp.gap_id, gapId);
  assert.equal(gapCloseResp.status, "closed-by");

  for (const [type, objectId, expected] of [
    [
      "gap.filed",
      gapId,
      {
        obligation: "Prove that lemma 2 holds for all odd primes",
        closes_what: "Lemma 2 induction step",
        target_claim_id: claim1Id,
        target_version: 1,
      },
    ],
    [
      "relation.asserted",
      `${claim1Id}@1-implies-${claim2Id}@1`,
      {
        kind: "implies",
        source: `${claim1Id}@1`,
        target: `${claim2Id}@1`,
      },
    ],
    [
      "relation.disputed",
      `${claim1Id}@1-implies-${claim2Id}@1`,
      {
        kind: "implies",
        source: `${claim1Id}@1`,
        target: `${claim2Id}@1`,
        reason: "Claim 1 upper bound does not imply Claim 2 lower bound for k=4.",
      },
    ],
    [
      "relation.asserted",
      `${claim2Id}@1-addresses-gap-${gapId}`,
      {
        kind: "addresses-gap",
        source: `${claim2Id}@1`,
        target: gapId,
      },
    ],
    [
      "gap.closed-by",
      gapId,
      {
        gap_id: gapId,
        outcome: "closed-by",
        closed_by: `${claim2Id}@1`,
      },
    ],
  ]) {
    await assertFullPackPublication(
      context,
      {
        problemId,
        sessionId: sessionIdA,
        token: authorA,
        type,
        objectId,
      },
      expected,
    );
  }

  // 7a. gap_closed impact echo (1e7, migration 0081): closing your own gap
  //     echoes nothing; another Fellow closing it echoes once to its author,
  //     privately, with a read-only pointer, and a replayed close adds nothing.
  const gapEchoes = async (token) =>
    InboxResponseSchema.parse(await call("/v1/inbox", undefined, token)).items.filter(
      (item) => item.type === "impact_echo" && item.impact_kind === "gap_closed",
    );
  assert.deepEqual(await gapEchoes(authorA), [], "self-closure echoes nothing");
  const gap2 = await call(
    `/v1/sessions/${sessionIdA}/gaps`,
    {
      obligation: "Bound the error term for primes below one thousand",
      closes_what: "The finite base case of lemma 2",
      target_claim_id: claim1Id,
      target_version: 1,
    },
    authorA,
    201,
    "gap-file-key-2",
  );
  const dischargeEvidence = EvidenceResponseSchema.parse(
    await call(
      `/v1/sessions/${sessionIdB}/evidence`,
      {
        bears_on_kind: "claim",
        bears_on_id: claim1Id,
        bears_on_version: 1,
        direction: "informs",
        kind: "argument",
        source: { kind: "model_memory" },
        mode: "exploratory",
        body_md:
          "For the finite base case, enumerate the residue classes for each prime below one thousand and bound the stated error term in each class.",
      },
      reviewerB,
      201,
      "gap-discharge-evidence",
    ),
  );
  const closeByOther = {
    gap_id: gap2.gap_id,
    outcome: "closed-by",
    closed_by: dischargeEvidence.evidence_id,
  };
  await call(`/v1/sessions/${sessionIdB}/gaps/close`, closeByOther, reviewerB, 201, "gap-close-b");
  await call(`/v1/sessions/${sessionIdB}/gaps/close`, closeByOther, reviewerB, null, "gap-close-b");
  assert.deepEqual(
    await env.DB.prepare(
      "SELECT status, closed_by FROM proof_gaps WHERE problem_id = ? AND gap_id = ?",
    )
      .bind(problemId, gap2.gap_id)
      .first(),
    { status: "closed-by", closed_by: dischargeEvidence.evidence_id },
    "the actual evidence publication is the recorded discharge reference",
  );
  const echoes = await gapEchoes(authorA);
  assert.equal(echoes.length, 1, "one echo to the gap's author, even after a replay");
  assert.equal(echoes[0].target_id, gap2.gap_id);
  assert.equal(echoes[0].problem_id, problemId);
  assert.ok(echoes[0].caused_by_event_id, "the echo names the closing event");
  assert.deepEqual(
    echoes[0].next_actions?.map((action) => action.url),
    [`/p/${problemId}/gaps.json?target=${gap2.gap_id}`],
  );
  assert.deepEqual(await gapEchoes(reviewerB), [], "the closer is not echoed");
  assert.ok(
    !JSON.stringify(await call(`/p/${problemId}.json`)).includes("closed by another Fellow"),
    "an echo is private",
  );

  // A contextual warning publishes a missing proof obligation, preserving
  // the filing's notice on every reading face and collaborator's pack.
  await fixtures.setScreenMode("allow-with-warning");
  const warningBody = {
    target_claim_id: claim1Id,
    target_version: 1,
    obligation:
      "NATIVE-WARNING-GAP: derive the uniform residue bound before the limiting argument.",
    closes_what: "The missing uniform estimate in the claimed upper bound.",
  };
  const warning = GapFiledResponseSchema.parse(
    await call(
      `/v1/sessions/${sessionIdA}/gaps`,
      warningBody,
      authorA,
      201,
      "native-proof-gap-warning",
    ),
  );
  const screenedCalls = await fixtures.screeningCalls();
  assert.deepEqual(
    await call(
      `/v1/sessions/${sessionIdA}/gaps`,
      warningBody,
      authorA,
      200,
      "native-proof-gap-warning",
    ),
    warning,
  );
  assert.equal(
    await fixtures.screeningCalls(),
    screenedCalls,
    "replay reuses the committed screening decision",
  );
  await fixtures.setScreenMode("pass");
  const warningNotice = {
    category: "dual-use-boundary",
    action: "published-with-warning",
    notice: "screening-warning",
  };
  const receiptCount = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM screening_publications s JOIN events e ON e.id = s.event_id
      WHERE e.problem_id = ? AND e.object_id = ? AND e.type = 'gap.filed'`,
  )
    .bind(problemId, warning.gap_id)
    .first();
  assert.equal(receiptCount.n, 1, "one immutable publication receipt per filing");
  const warningFaces = [];
  for (const extension of ["json", "md", "html"]) {
    const url = `${origin}/p/${problemId}/gaps.${extension}?through=${warning.seq}&target=${warning.gap_id}`;
    const response = await worker.fetch(url, { headers: { "User-Agent": userAgent } });
    assert.equal(response.status, 200);
    const bytes = await response.text();
    assert.ok(bytes.includes(warningBody.obligation));
    if (extension === "json") {
      const face = ProofGapsResponseSchema.parse(JSON.parse(bytes));
      assert.deepEqual(face.gaps[0].screening_notice, warningNotice);
      assert.deepEqual(face.gaps[0].content, warningBody);
    } else {
      assert.ok(bytes.includes("Published with a screening context notice:"));
      assert.ok(
        bytes.indexOf("Published with a screening context notice:") <
          bytes.indexOf(warningBody.obligation),
      );
    }
    warningFaces.push({ url, etag: response.headers.get("etag") });
  }
  const warningPackUrls = [
    [`/v1/sessions/${sessionIdA}/pack?profile=formal&max_tokens=8000`, authorA],
    [`/v1/sessions/${sessionIdA}/pack?profile=claim&target=${claim1Id}@1&max_tokens=8000`, authorA],
    [
      `/v1/sessions/${sessionIdB}/pack?profile=review&target=${claim1Id}@1&max_tokens=8000`,
      reviewerB,
    ],
  ];
  for (const [path, token] of warningPackUrls) {
    const pack = PackResponseSchema.parse(await call(path, undefined, token));
    const item = pack.items.find((candidate) => candidate.id === warning.gap_id);
    assert.deepEqual(item?.screening_notice, warningNotice, path);
    assert.ok(item.body.includes(warningBody.obligation));
    assert.ok(
      !item.body.includes("screening_notice"),
      "platform context stays outside authored work",
    );
  }
  const controlWarningGap = async (visibility, version) =>
    env.DB.prepare(
      `INSERT INTO content_controls(control_id,problem_id,target_kind,target_ref,visibility,source,
      reason_category,actor,reason,version,created_at)
      VALUES(?,?,'ledger-object',?,?,'operator','privacy','native-gap-test',
        'Local current-visibility proof.',?,?)`,
    )
      .bind(
        `CC-GAP-WARNING-${version}`,
        problemId,
        `${warning.gap_id}@1`,
        visibility,
        version,
        new Date().toISOString(),
      )
      .run();
  await controlWarningGap("hidden", 1);
  for (const before of warningFaces) {
    const response = await worker.fetch(before.url, {
      headers: { "User-Agent": userAgent, "If-None-Match": before.etag },
    });
    assert.equal(response.status, 200, "current controls precede conditional historical reads");
    const bytes = await response.text();
    assert.ok(!bytes.includes(warningBody.obligation));
    assert.ok(!bytes.includes("screening-warning"));
    assert.ok(!bytes.includes("Published with a screening context notice:"));
  }
  for (const [path, token] of warningPackUrls) {
    const pack = PackResponseSchema.parse(await call(path, undefined, token));
    assert.ok(!JSON.stringify(pack).includes(warningBody.obligation), path);
    assert.ok(!JSON.stringify(pack).includes("screening-warning"), path);
  }
  await controlWarningGap("visible", 2);
  for (const before of warningFaces) {
    const response = await worker.fetch(before.url, {
      headers: { "User-Agent": userAgent, "If-None-Match": before.etag },
    });
    assert.equal(response.status, 304, "restoration returns the identical filing and its notice");
  }

  // Later gap decisions have their own screening context. A fresh Fellow keeps
  // these product writes within the ordinary Fellow/problem promotion budget.
  const settlementAuthor = await enroll("gap-settlement-author", "usr_gap_settlement_sponsor");
  const settlementSession = await call(
    "/v1/sessions",
    {
      problem_id: problemId,
      intent: "explore",
    },
    settlementAuthor,
    201,
  );
  const decisionPath = `/v1/sessions/${settlementSession.session_id}/gaps/close`;
  for (const outcome of ["closed-by", "withdrawn"]) {
    const filing = GapFiledResponseSchema.parse(
      await call(
        `/v1/sessions/${settlementSession.session_id}/gaps`,
        {
          target_claim_id: claim1Id,
          target_version: 1,
          obligation: `NATIVE-SETTLEMENT-${outcome}: establish the uniform bound on each residue class.`,
          closes_what: "The missing boundary estimate.",
        },
        settlementAuthor,
        201,
        `native-settlement-filing-${outcome}`,
      ),
    );
    const transition = {
      gap_id: filing.gap_id,
      outcome,
      ...(outcome === "closed-by" ? { closed_by: `${claim2Id}@1` } : {}),
    };
    const prior = ProofGapsResponseSchema.parse(
      await call(`/p/${problemId}/gaps.json?through=${filing.seq}&target=${filing.gap_id}`),
    );
    assert.equal(prior.gaps[0].screening_notice, undefined);
    assert.equal(prior.gaps[0].last_event_screening_notice, undefined);
    if (outcome === "closed-by") {
      for (const [mode, expected, code] of [
        ["quarantine", 202, "SCREENING_HOLD"],
        ["unavailable", 202, "SCREENING_HOLD"],
        ["reject", 403, "POLICY_DENIED"],
      ]) {
        await fixtures.setScreenMode(mode);
        const refused = await call(
          decisionPath,
          transition,
          settlementAuthor,
          expected,
          `native-settlement-${mode}`,
        );
        assert.equal(refused.code, code);
        assert.equal(
          (
            await env.DB.prepare("SELECT public_seq FROM problems WHERE id=?")
              .bind(problemId)
              .first()
          ).public_seq,
          filing.seq,
          "a held or refused decision cannot close the gap",
        );
      }
    }
    await fixtures.setScreenMode("allow-with-warning");
    const key = `native-settlement-warning-${outcome}`;
    const decision = GapClosedResponseSchema.parse(
      await call(decisionPath, transition, settlementAuthor, 201, key),
    );
    assert.equal(decision.status, outcome);
    assert.equal(decision.seq, filing.seq + 1, "one scientific event per settlement");
    const screenCount = await fixtures.screeningCalls();
    assert.deepEqual(await call(decisionPath, transition, settlementAuthor, 200, key), decision);
    assert.equal(
      await fixtures.screeningCalls(),
      screenCount,
      "settlement replay does not re-screen",
    );
    await fixtures.setScreenMode("pass");
    assert.deepEqual(
      ProofGapsResponseSchema.parse(
        await call(`/p/${problemId}/gaps.json?through=${filing.seq}&target=${filing.gap_id}`),
      ),
      prior,
      "a later warning cannot qualify an earlier open obligation",
    );
    const decisions = [];
    for (const extension of ["json", "md", "html"]) {
      const url = `${origin}/p/${problemId}/gaps.${extension}?through=${decision.seq}&target=${filing.gap_id}`;
      const response = await worker.fetch(url, { headers: { "User-Agent": userAgent } });
      assert.equal(response.status, 200);
      const bytes = await response.text();
      if (extension === "json") {
        const record = ProofGapsResponseSchema.parse(JSON.parse(bytes)).gaps[0];
        assert.equal(record.status, outcome);
        assert.equal(record.screening_notice, undefined);
        assert.deepEqual(record.last_event_screening_notice, warningNotice);
        assert.equal(record.last_event.seq, decision.seq);
      } else {
        assert.ok(
          bytes.includes(
            `Recorded settlement (#${decision.seq}): Published with a screening context notice:`,
          ),
        );
      }
      decisions.push({ url, etag: response.headers.get("etag"), bytes });
    }
    for (const [path, token] of warningPackUrls.slice(1)) {
      const pack = PackResponseSchema.parse(await call(path, undefined, token));
      const item = pack.items.find((candidate) => candidate.id === filing.gap_id);
      assert.ok(item, `the settled obligation remains in ${path}`);
      assert.equal(
        item.screening_notice,
        undefined,
        "settlement context does not qualify the filing",
      );
      assert.deepEqual(JSON.parse(item.body).last_event_screening_notice, warningNotice);
      assert.ok(item.why_included.includes(`Recorded settlement (#${decision.seq}):`));
    }
    const full = PackResponseSchema.parse(
      await call(
        `/v1/sessions/${settlementSession.session_id}/pack?profile=full&max_tokens=8000&through=${decision.seq}&after=${decision.seq - 1}`,
        undefined,
        settlementAuthor,
      ),
    );
    const fullDecision = full.items.find((item) => item.kind === "full-event");
    assert.deepEqual(fullDecision.screening_notice, warningNotice);
    assert.equal(JSON.parse(fullDecision.body).publication.type, `gap.${outcome}`);
    const receipt = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM screening_publications s JOIN events e ON e.id=s.event_id
       WHERE e.problem_id=? AND e.object_id=? AND e.type=?`,
    )
      .bind(problemId, filing.gap_id, `gap.${outcome}`)
      .first();
    assert.equal(receipt.n, 1);
    const controlDecision = (visibility, version) =>
      env.DB.prepare(
        `INSERT INTO content_controls(control_id,problem_id,target_kind,target_ref,visibility,source,
      reason_category,actor,reason,version,created_at)
      VALUES(?,?,'ledger-object',?,?,'operator','privacy','native-gap-test',
      'Local settlement visibility proof.',?,?)`,
      )
        .bind(
          `CC-GAP-SETTLEMENT-${decision.seq}-${version}`,
          problemId,
          `#${decision.seq}`,
          visibility,
          version,
          new Date().toISOString(),
        )
        .run();
    await controlDecision("hidden", 1);
    for (const before of decisions) {
      const response = await worker.fetch(before.url, {
        headers: { "User-Agent": userAgent, "If-None-Match": before.etag },
      });
      assert.equal(response.status, 200);
      const bytes = await response.text();
      assert.ok(!bytes.includes("screening-warning"));
      assert.ok(!bytes.includes("Recorded settlement (#"));
    }
    for (const [path, token] of warningPackUrls.slice(1)) {
      const pack = PackResponseSchema.parse(await call(path, undefined, token));
      const item = pack.items.find((candidate) => candidate.id === filing.gap_id);
      assert.ok(item);
      assert.equal(JSON.parse(item.body).status, "unavailable");
      assert.ok(!JSON.stringify(item).includes("screening-warning"));
    }
    await controlDecision("visible", 2);
    for (const before of decisions) {
      const response = await worker.fetch(before.url, {
        headers: { "User-Agent": userAgent, "If-None-Match": before.etag },
      });
      assert.equal(
        response.status,
        304,
        "restoring the exact decision restores its notice and bytes",
      );
    }
  }

  // Assertions and independent disputes retain separate event-bound notices.
  // Fresh principals exercise normal quotas; only the screening provider is
  // a fixture. Writes, immutable receipts, reads and controls use real D1/R2.
  {
    const relationAuthor = await enroll("rel-warning-author", "usr_rel_warning_author");
    const relationReviewer = await enroll("rel-warning-reviewer", "usr_rel_warning_reviewer");
    const authorSession = await call(
      "/v1/sessions",
      { problem_id: problemId, intent: "explore" },
      relationAuthor,
      201,
    );
    const reviewerSession = await call(
      "/v1/sessions",
      { problem_id: problemId, intent: "review" },
      relationReviewer,
      201,
    );
    const assertionPath = `/v1/sessions/${authorSession.session_id}/relations`;
    const disputePath = `/v1/sessions/${reviewerSession.session_id}/relations/dispute`;
    const graphPath = `/v1/sessions/${reviewerSession.session_id}/pack?profile=claim-graph&max_tokens=8000`;
    const relationBody = {
      kind: "contradicts",
      source_claim_id: claim1Id,
      source_version: 1,
      target: `${claim2Id}@1`,
    };
    const relationLine = `Asserted relation: ${claim1Id}@1 contradicts ${claim2Id}@1`;
    const scientificState = async () => ({
      head: await env.DB.prepare("SELECT public_seq, chain_digest FROM problems WHERE id=?")
        .bind(problemId)
        .first(),
      events: await env.DB.prepare(
        "SELECT COUNT(*) AS count, MAX(seq) AS seq FROM events WHERE problem_id=?",
      )
        .bind(problemId)
        .first(),
    });
    const beforeAssertion = await scientificState();
    await fixtures.setScreenMode("quarantine");
    const heldAssertion = await call(
      assertionPath,
      relationBody,
      relationAuthor,
      202,
      "native-relation-warning-held",
    );
    assert.equal(heldAssertion.code, "SCREENING_HOLD");
    assert.deepEqual(await scientificState(), beforeAssertion);
    const heldGraph = PackResponseSchema.parse(await call(graphPath, undefined, relationReviewer));
    assert.ok(!heldGraph.items.some((item) => item.body.includes(relationLine)));

    await fixtures.setScreenMode("allow-with-warning");
    const assertionKey = "native-relation-warning-assertion";
    const assertion = RelationFiledResponseSchema.parse(
      await call(assertionPath, relationBody, relationAuthor, 201, assertionKey),
    );
    assert.equal(assertion.seq, beforeAssertion.head.public_seq + 1);
    const afterAssertion = await scientificState();
    const assertionScreens = await fixtures.screeningCalls();
    await fixtures.setScreenMode("reject");
    assert.deepEqual(
      await call(assertionPath, relationBody, relationAuthor, 200, assertionKey),
      assertion,
    );
    assert.equal(await fixtures.screeningCalls(), assertionScreens);
    assert.deepEqual(await scientificState(), afterAssertion);

    const disputeBody = {
      ...relationBody,
      reason:
        "NATIVE-RELATION-WARNING: these bounds use different cycle conventions; a shared example is needed before asserting contradiction.",
    };
    const selfRefusal = await call(
      `${assertionPath}/dispute`,
      disputeBody,
      relationAuthor,
      422,
      "native-relation-warning-self-dispute",
    );
    assert.equal(selfRefusal.code, "REVIEWER_IS_AUTHOR");
    assert.equal(await fixtures.screeningCalls(), assertionScreens);
    assert.deepEqual(await scientificState(), afterAssertion);

    const frozenAssertionPath = `/v1/sessions/${authorSession.session_id}/pack?profile=full&max_tokens=8000&through=${assertion.seq}&after=${assertion.seq - 1}`;
    const frozenAssertion = PackResponseSchema.parse(
      await call(frozenAssertionPath, undefined, relationAuthor),
    );
    const assertionItem = frozenAssertion.items.find((item) => item.id === `FULL-${assertion.seq}`);
    assert.ok(assertionItem);
    assert.deepEqual(assertionItem.screening_notice, warningNotice);
    const assertionRecord = JSON.parse(assertionItem.body);
    assert.equal(assertionRecord.publication.type, "relation.asserted");
    assert.equal(assertionRecord.content_omitted, null);
    assert.deepEqual(assertionRecord.content, {
      kind: relationBody.kind,
      source: assertion.source,
      target: assertion.target,
    });

    await fixtures.setScreenMode("unavailable");
    const heldDispute = await call(
      disputePath,
      disputeBody,
      relationReviewer,
      202,
      "native-relation-warning-provider-unavailable",
    );
    assert.equal(heldDispute.code, "SCREENING_HOLD");
    assert.deepEqual(await scientificState(), afterAssertion);
    const graphBeforeDispute = PackResponseSchema.parse(
      await call(graphPath, undefined, relationReviewer),
    );
    const undisputedItem = graphBeforeDispute.items.find(
      (item) => item.id === assertionRecord.publication.id,
    );
    assert.deepEqual(undisputedItem?.screening_notice, warningNotice);
    assert.ok(undisputedItem.body.includes("Status: asserted at this cursor."));
    assert.ok(!undisputedItem.body.includes(disputeBody.reason));

    await fixtures.setScreenMode("allow-with-warning");
    const disputeKey = "native-relation-warning-dispute";
    const dispute = RelationDisputedResponseSchema.parse(
      await call(disputePath, disputeBody, relationReviewer, 201, disputeKey),
    );
    assert.equal(dispute.seq, assertion.seq + 1);
    const afterDispute = await scientificState();
    const disputeScreens = await fixtures.screeningCalls();
    await fixtures.setScreenMode("reject");
    assert.deepEqual(
      await call(disputePath, disputeBody, relationReviewer, 200, disputeKey),
      dispute,
    );
    assert.equal(await fixtures.screeningCalls(), disputeScreens);
    assert.deepEqual(await scientificState(), afterDispute);
    await fixtures.setScreenMode("pass");
    assert.deepEqual(
      PackResponseSchema.parse(await call(frozenAssertionPath, undefined, relationAuthor)),
      frozenAssertion,
      "a later dispute cannot alter an assertion's frozen publication or notice",
    );

    const receipts = await env.DB.prepare(
      `SELECT e.id,e.seq,e.type,e.actor_fellow_id,e.actor_sponsor_id,s.provenance_json
       FROM events e JOIN screening_publications s ON s.event_id=e.id
       WHERE e.problem_id=? AND e.seq IN (?,?) ORDER BY e.seq`,
    )
      .bind(problemId, assertion.seq, dispute.seq)
      .all();
    assert.deepEqual(
      receipts.results.map((row) => [row.seq, row.type]),
      [
        [assertion.seq, "relation.asserted"],
        [dispute.seq, "relation.disputed"],
      ],
      "one independent immutable screening receipt per scientific event",
    );
    const [assertionReceipt, disputeReceipt] = receipts.results;
    assert.notEqual(assertionReceipt.id, disputeReceipt.id);
    assert.notEqual(assertionReceipt.actor_fellow_id, disputeReceipt.actor_fellow_id);
    assert.notEqual(assertionReceipt.actor_sponsor_id, disputeReceipt.actor_sponsor_id);
    for (const row of receipts.results) {
      const receipt = JSON.parse(row.provenance_json);
      assert.equal(receipt.outcome, "allow-with-warning");
      assert.deepEqual(receipt.public_action, warningNotice);
    }

    const disputePrefix = "Recorded dispute (untrusted work product): ";
    const disputeWarning = `Recorded dispute (#${dispute.seq}): Published with a screening context notice:`;
    const assertRelationContext = (item, visible) => {
      assert.ok(item);
      assert.deepEqual(item.screening_notice, warningNotice);
      assert.ok(item.body.includes(relationLine));
      if (visible) {
        assert.ok(
          item.body.includes(`Status: disputed. A dispute is recorded at #${dispute.seq}.`),
        );
        const recorded = item.body.split("\n").find((line) => line.startsWith(disputePrefix));
        assert.ok(recorded);
        const nested = JSON.parse(recorded.slice(disputePrefix.length));
        assert.equal(nested.event, disputeReceipt.id);
        assert.equal(nested.seq, dispute.seq);
        assert.equal(nested.reason, disputeBody.reason);
        assert.equal(nested.provenance.sponsor, "usr_rel_warning_reviewer");
        assert.deepEqual(nested.screening_notice, warningNotice);
        assert.ok(item.why_included.includes(disputeWarning));
      } else {
        assert.ok(item.body.includes("Status: unavailable."));
        assert.ok(!item.body.includes(disputePrefix));
        assert.ok(!item.body.includes(disputeBody.reason));
        assert.ok(!item.why_included.includes("Recorded dispute"));
      }
    };
    const graph = PackResponseSchema.parse(await call(graphPath, undefined, relationReviewer));
    assertRelationContext(
      graph.items.find((item) => item.id === assertionReceipt.id),
      true,
    );
    // The shared renderer consumes the native canonical pack. This checks HTML
    // rendering, without pretending the JSON-only pack has an HTML HTTP route.
    const graphFaces = renderAllFaces(graph);
    for (const format of ["md", "html-fragment"]) {
      const bytes = graphFaces[format].body;
      assert.ok(bytes.includes(disputeWarning));
      assert.ok(bytes.indexOf(disputeWarning) < bytes.indexOf(disputeBody.reason));
    }

    const fullPath = `/v1/sessions/${authorSession.session_id}/pack?profile=full&max_tokens=8000&through=${dispute.seq}&after=${assertion.seq - 1}`;
    const full = PackResponseSchema.parse(await call(fullPath, undefined, relationAuthor));
    assert.equal(fullControl(full).records, 2);
    for (const receipt of receipts.results) {
      const item = full.items.find((candidate) => candidate.id === `FULL-${receipt.seq}`);
      assert.ok(item);
      assert.deepEqual(item.screening_notice, warningNotice);
      const record = JSON.parse(item.body);
      assert.equal(record.publication.id, receipt.id);
      assert.equal(record.publication.type, receipt.type);
      assert.equal(record.content_omitted, null);
    }
    const tailPath = `/p/${problemId}/events.json?since=${assertion.seq - 1}&through=${dispute.seq}&limit=2`;
    const tail = EventTailResponseSchema.parse(await call(tailPath));
    assert.deepEqual(
      tail.events.map((entry) => entry.event.id),
      receipts.results.map((row) => row.id),
    );
    for (const entry of tail.events) assert.deepEqual(entry.event.screening_notice, warningNotice);

    const faces = [];
    for (const extension of ["json", "md"]) {
      const url = `${origin}/p/${problemId}/relations/${assertion.seq}.${extension}`;
      const response = await worker.fetch(url, { headers: { "User-Agent": userAgent } });
      assert.equal(response.status, 200);
      const bytes = await response.text();
      if (extension === "json") assertRelationContext(JSON.parse(bytes).items[0], true);
      else {
        assert.ok(bytes.includes(disputeWarning));
        assert.ok(
          bytes.indexOf("Published with a screening context notice:") < bytes.indexOf(relationLine),
        );
      }
      assert.ok(response.headers.get("etag"));
      faces.push({ url, extension, etag: response.headers.get("etag") });
    }
    const controlDispute = (visibility, version) =>
      env.DB.prepare(
        `INSERT INTO content_controls(control_id,problem_id,target_kind,target_ref,visibility,source,
         reason_category,actor,reason,version,created_at)
         VALUES(?,?,'ledger-object',?,?,'operator','privacy','native-relation-test',
           'Local independent dispute visibility proof.',?,?)`,
      )
        .bind(
          `CC-RELATION-WARNING-${dispute.seq}-${version}`,
          problemId,
          `#${dispute.seq}`,
          visibility,
          version,
          new Date().toISOString(),
        )
        .run();
    await controlDispute("hidden", 1);
    for (const before of faces) {
      const response = await worker.fetch(before.url, {
        headers: { "User-Agent": userAgent, "If-None-Match": before.etag },
      });
      assert.equal(
        response.status,
        200,
        "current visibility precedes a relation's conditional read",
      );
      assert.notEqual(response.headers.get("etag"), before.etag);
      const bytes = await response.text();
      if (before.extension === "json") assertRelationContext(JSON.parse(bytes).items[0], false);
      else {
        assert.ok(bytes.includes("Published with a screening context notice:"));
        assert.ok(bytes.includes(relationLine));
        assert.ok(!bytes.includes(disputeWarning));
        assert.ok(!bytes.includes(disputeBody.reason));
      }
    }
    const hiddenGraph = PackResponseSchema.parse(
      await call(graphPath, undefined, relationReviewer),
    );
    assertRelationContext(
      hiddenGraph.items.find((item) => item.id === assertionReceipt.id),
      false,
    );
    const hiddenFull = PackResponseSchema.parse(await call(fullPath, undefined, relationAuthor));
    const hiddenAssertion = hiddenFull.items.find((item) => item.id === `FULL-${assertion.seq}`);
    const hiddenDispute = hiddenFull.items.find((item) => item.id === `FULL-${dispute.seq}`);
    assert.deepEqual(hiddenAssertion.screening_notice, warningNotice);
    assert.equal(hiddenDispute.screening_notice, undefined);
    assert.equal(JSON.parse(hiddenDispute.body).content, null);
    assert.equal(JSON.parse(hiddenDispute.body).content_omitted, "content_unavailable");
    assert.ok(!hiddenDispute.body.includes(disputeBody.reason));
    const hiddenTail = EventTailResponseSchema.parse(await call(tailPath));
    assert.deepEqual(hiddenTail.events[0].event.screening_notice, warningNotice);
    assert.equal(hiddenTail.events[1].event.screening_notice, undefined);
    assert.equal(hiddenTail.events[1].body_omitted, "content_unavailable");
    await controlDispute("visible", 2);
    for (const before of faces) {
      const response = await worker.fetch(before.url, {
        headers: { "User-Agent": userAgent, "If-None-Match": before.etag },
      });
      assert.equal(response.status, 304, "restoring the dispute restores both exact notices");
    }
    assert.deepEqual(
      PackResponseSchema.parse(await call(fullPath, undefined, relationAuthor)),
      full,
    );
    assert.deepEqual(EventTailResponseSchema.parse(await call(tailPath)), tail);
  }

  // Diptych census over this journey's gap and relation faces (lu59 / 92x /
  // qvzk). A relation is cited by the seq of its relation.asserted event.
  {
    const census = await faceCensus({
      worker: context.worker,
      origin: context.origin,
      userAgent: context.userAgent,
      params: { id: problemId, gid: gapId, relId: String(filedRel1.seq) },
      kinds: ["proof-gap", "relation"],
    });
    assert.deepEqual(census.failures, [], "face census");
    assert.deepEqual(census.covered.sort(), ["proof-gap", "relation"], "both faces resolved");
  }

  // W2.6: every projection row this journey built is reproducible from the log.
  const rebuilt = await assertProjectionsRebuild(context.env.DB, problemId);
  console.log(JSON.stringify({ stage: "projection-rebuild", ...rebuilt }));

  console.log(
    JSON.stringify({
      stage: "relations-gaps-real-bindings-success",
      warning_publication_and_replay_verified: true,
      warning_faces_and_packs_verified: true,
      historical_visibility_before_etag_verified: true,
    }),
  );
});
