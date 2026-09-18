import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { FellowCardResponseSchema } from "../../../../packages/contracts/src/fellow-card.ts";
import { writeLedgerEvent } from "../../src/krater/krater.ts";

/** Historical compatibility fixture, separate from the unseeded scientific
 * journey: enrollment/session/claim use HTTP; old review publications use the
 * real Krater writer because today's HTTP validator cannot mint old policy. */
export async function fellowCardHistory({
  call,
  enroll,
  fixtures,
  env,
  worker,
  origin,
  userAgent,
}) {
  const problem = "P-CARD-HISTORY";
  const historicalBasis = "Historical publication basis. T3 is not established.";
  await fixtures.seedProblem(problem);
  const authorToken = await enroll("card-history-author", "usr_cardhistoryauthor");
  const reviewerToken = await enroll("card-history-reader", "usr_cardhistoryreader");
  const sharedToken = await enroll("card-history-shared", "usr_cardhistoryauthor");
  const author = await call("/v1/hello", undefined, authorToken);
  const reviewer = await call("/v1/hello", undefined, reviewerToken);
  const shared = await call("/v1/hello", undefined, sharedToken);
  const session = await call(
    "/v1/sessions",
    { problem_id: problem, intent: "prove" },
    authorToken,
    201,
  );
  const reviewSession = await call(
    "/v1/sessions",
    { problem_id: problem, intent: "review" },
    reviewerToken,
    201,
  );
  const sharedSession = await call(
    "/v1/sessions",
    { problem_id: problem, intent: "review" },
    sharedToken,
    201,
  );
  const path = `/v1/sessions/${session.session_id}`;
  const draft = await call(
    `${path}/workshop`,
    {
      type: "claim-draft",
      title: "Historical review input",
      body_md: "CARD_PRIVATE_HISTORY_CANARY",
      relates_to: [],
    },
    authorToken,
    201,
  );
  const statement = "Every integer divisible by four is even.";
  const claim = await call(
    `${path}/promote`,
    {
      workshop_id: draft.workshop_id,
      kind: "conjecture",
      statement,
      falsifier: "An odd integer divisible by four.",
      relates_to: [],
    },
    authorToken,
    201,
  );

  for (const [id, sponsor, fellow, sessionId, payload] of [
    [
      "R-HISTORICAL",
      "usr_cardhistoryreader",
      reviewer.fellow.fellow_id,
      reviewSession.session_id,
      JSON.stringify({
        target_claim_id: claim.claim_id,
        target_version: 1,
        tier: "T3",
        verdict: "inform",
        basis: historicalBasis,
      }),
    ],
    [
      "R-SHARED-SPONSOR",
      "usr_cardhistoryauthor",
      shared.fellow.fellow_id,
      sharedSession.session_id,
      JSON.stringify({
        target_claim_id: claim.claim_id,
        target_version: 1,
        tier: "T3",
        verdict: "inform",
        basis: "Historical same-sponsor fixture.",
      }),
    ],
    [
      "R-INVALID-LEGACY",
      "usr_cardhistoryreader",
      reviewer.fellow.fellow_id,
      reviewSession.session_id,
      JSON.stringify({
        target_claim_id: "C-WRONG",
        target_version: 1,
        tier: "T3",
        verdict: "confirm",
        basis: "INVALID_PIN_PRIVATE_DIAGNOSTIC",
      }),
    ],
  ]) {
    await writeLedgerEvent(
      env.DB,
      {
        problemId: problem,
        eventId: `E-${id}`,
        idempotencyKey: `card-history-${id}`,
        requestDigest: createHash("sha256").update(payload).digest("hex"),
        eventType: "review.created",
        objectKind: "review",
        objectId: id,
        objectVersion: 1,
        payloadJson: payload,
        createdAt: new Date().toISOString(),
        attribution: {
          fellowId: fellow,
          sponsorId: sponsor,
          sessionId,
          modelSelfDeclared: "historical-fixture",
          harness: "local-workerd",
        },
      },
      {
        statementsAfterEvent: ({ sequence, eventId }) => [
          env.DB.prepare(`
        INSERT INTO reviews (review_id, problem_id, target_claim_id, target_version,
          reviewer_fellow_id, tier, verdict, basis, body_md, created_at, source_event_id, source_seq)
        VALUES (?, ?, ?, 1, ?, 'T3', 'confirm', 'WRONG_PROJECTION_BASIS', 'Retained legacy fixture', ?, ?, ?)
      `).bind(id, problem, claim.claim_id, fellow, new Date().toISOString(), eventId, sequence),
        ],
      },
    );
  }
  const card = FellowCardResponseSchema.parse(await call("/a/card-history-reader.json"));
  assert.equal(card.reviews.length, 1);
  assert.equal(card.reviews[0].tier, "T1", "Legacy T3 cannot imply cross-family provenance");
  assert.equal(card.reviews[0].verdict, "inform", "The log wins over the retained projection");
  assert.equal(card.reviews[0].basis, historicalBasis);
  assert.ok(card.omitted.some((item) => item.includes("1 legacy reviews")));
  assert.ok(card.omitted.some((item) => item.includes("version-pin verification")));
  assert.equal(card.calibration.reviews_verified_survival, null);
  const authorCard = FellowCardResponseSchema.parse(await call("/a/card-history-author.json"));
  assert.equal(authorCard.fellow_id, author.fellow.fellow_id);
  const sharedCard = FellowCardResponseSchema.parse(await call("/a/card-history-shared.json"));
  assert.equal(sharedCard.reviews[0].tier, "T0");
  assert.equal(authorCard.promoted_contributions[0].statement, statement);
  const publicClaim = await call(`/p/${problem}/claims/${claim.claim_id}@1.json`);
  const historicalRecord = publicClaim.items.find((item) => item.id === "R-HISTORICAL");
  assert.ok(historicalRecord);
  assert.equal(JSON.parse(historicalRecord.body).tier, "T1");
  assert.equal(JSON.parse(historicalRecord.body).basis, card.reviews[0].basis);
  assert.equal(JSON.parse(historicalRecord.body).verdict, card.reviews[0].verdict);
  assert.ok(!publicClaim.items.some((item) => item.id === "R-INVALID-LEGACY"));
  assert.ok(!JSON.stringify(publicClaim).includes("WRONG_PROJECTION_BASIS"));
  assert.ok(!JSON.stringify(publicClaim).includes("INVALID_PIN_PRIVATE_DIAGNOSTIC"));

  const etags = new Map();
  for (const suffix of ["json", "md", "html"]) {
    const url = `${origin}/a/card-history-reader.${suffix}`;
    const response = await worker.fetch(url, { headers: { "user-agent": userAgent } });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(
      !text.includes("dead_ends_recorded"),
      "The machine face must not publish a dead-end tally",
    );
    assert.ok(
      !text.includes("Checked Dead Ends"),
      "The readable face must not turn dead ends into a counter",
    );
    for (const privateValue of [
      "CARD_PRIVATE_HISTORY_CANARY",
      "WRONG_PROJECTION_BASIS",
      "INVALID_PIN_PRIVATE_DIAGNOSTIC",
      authorToken,
      reviewerToken,
      sharedToken,
    ]) {
      assert.ok(!text.includes(privateValue));
    }
    assert.ok(text.includes(historicalBasis));
    // T3 may appear as quoted work or in a random identifier. Assert the
    // published review tiers, not a whole-document substring ban. The basis
    // deliberately mentions T3 so the distinction is exercised every run.
    const tiers =
      suffix === "json"
        ? FellowCardResponseSchema.parse(JSON.parse(text)).reviews.map((review) => review.tier)
        : [
            ...text.matchAll(
              suffix === "md"
                ? /^- \*\*Review [^\n]+\(tier (T[0-3]),/gm
                : /<h4>[^\n]+\(tier (T[0-3])\)<\/h4>/g,
            ),
          ].map((match) => match[1]);
    assert.deepEqual(tiers, ["T1"]);
    const cache = "public, max-age=0, must-revalidate";
    assert.equal(response.headers.get("cache-control"), cache);
    const etag = response.headers.get("etag");
    assert.ok(etag);
    etags.set(suffix, etag);
    const head = await worker.fetch(url, { method: "HEAD", headers: { "user-agent": userAgent } });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("etag"), etag);
    assert.equal(await head.text(), "");
    const unchanged = await worker.fetch(url, {
      headers: { "user-agent": userAgent, "if-none-match": etag },
    });
    assert.equal(unchanged.status, 304);
    assert.equal(unchanged.headers.get("cache-control"), cache);
  }
  await fixtures.redactPublicContent("E-R-HISTORICAL");
  for (const suffix of ["json", "md", "html"]) {
    const response = await worker.fetch(`${origin}/a/card-history-reader.${suffix}`, {
      headers: { "user-agent": userAgent, "if-none-match": etags.get(suffix) },
    });
    assert.equal(response.status, 200, "Withdrawal invalidates the cached representation");
    assert.notEqual(response.headers.get("etag"), etags.get(suffix));
    const body = await response.text();
    assert.ok(!body.includes(historicalBasis));
    assert.ok(!body.includes("WRONG_PROJECTION_BASIS"));
    if (suffix === "json")
      assert.deepEqual(FellowCardResponseSchema.parse(JSON.parse(body)).reviews, []);
  }
  // The prior scientific journey used C-1 on another problem. This independent
  // HTTP promotion must still export its own statement and historical author.
  const citation = await call(`/p/${problem}/claims/${claim.claim_id}@1.csl.json`);
  assert.equal(citation.title, statement);
  assert.equal(citation.URL, `https://asimposium.org/p/${problem}/claims/${claim.claim_id}@1`);
  assert.deepEqual(citation.author, [{ literal: `ASImposium Fellow ${author.fellow.fellow_id}` }]);
  const claimEvent = JSON.parse(
    publicClaim.items.find((item) => item.kind === "claim-detail").body,
  ).event;
  // The real schema refuses arbitrary content rewrites. Do not disable that
  // trigger to manufacture a corruption case; hash-mismatch defense also has
  // an explicitly unit-level route test.
  await assert.rejects(
    env.DB.prepare("UPDATE event_content SET payload_json = ? WHERE event_id = ?")
      .bind("CORRUPT_CITATION_BODY_CANARY", claimEvent)
      .run(),
    /KRATER_CONTENT_REDACTION_INVALID/,
  );
  const preservedCitation = await call(`/p/${problem}/claims/${claim.claim_id}@1.csl.json`);
  assert.deepEqual(preservedCitation, citation);
  await fixtures.redactPublicContent(claimEvent);
  for (const suffix of ["bib", "csl.json"]) {
    const response = await worker.fetch(
      `${origin}/p/${problem}/claims/${claim.claim_id}@1.${suffix}`,
      {
        headers: { "user-agent": userAgent },
      },
    );
    assert.equal(response.status, 404);
    const body = await response.text();
    assert.equal(JSON.parse(body).code, "CLAIM_NOT_FOUND");
    assert.ok(!body.includes("CORRUPT_CITATION_BODY_CANARY"));
    assert.ok(!body.includes(statement));
  }
  console.log(
    JSON.stringify({
      stage: "fellow-card-retained-history",
      status: "pass",
      review_fixtures: 3,
      faces: 3,
      boundary:
        "real Workerd/D1 and HTTP reads; historical review events are explicit Krater fixtures, not current HTTP admission or sponsor-transfer proof",
    }),
  );
}
