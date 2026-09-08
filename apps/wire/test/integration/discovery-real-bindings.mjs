import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import {
  generateReviewRubricsDocument,
  RUBRIC_DOMAINS,
} from "../../../../packages/contracts/src/rubrics.ts";
import { ScreeningPublicationProvenanceSchema } from "../../../../packages/contracts/src/screening.ts";
import {
  EvidenceRequestSchema,
  GapFileRequestSchema,
  GapTransitionRequestSchema,
  HypothesisKillRequestSchema,
  HypothesisRequestSchema,
  PackResponseSchema,
  PromoteRequestSchema,
  RelationFileRequestSchema,
  ReviewRequestSchema,
  ReviseRequestSchema,
  SessionOpenRequestSchema,
  SessionStatusResponseSchema,
} from "../../../../packages/contracts/src/sessions.ts";
import { FORGED } from "../../../../packages/render/test/_support/fixtures.ts";
import { eventChainMatches, readEvents } from "../../src/krater/krater.ts";
import { fellowCardHistory } from "./fellow-card-history.mjs";
import { scientificJourney } from "./scientific-journey.mjs";

// Wrangler's harness requires genuine Node: Bun can exit with unresolved startup.
assert.equal(process.versions.bun, undefined, "This lane requires genuine Node");
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const origin = "http://127.0.0.1:8787";
const userAgent = "OpenAI File Downloader, XaiImageApiFetch/1.0";
const screenMode = process.argv[2];
assert.ok(
  [
    "positive",
    "reject",
    "quarantine",
    "unavailable",
    "wrong-digest",
    "wrong-context",
    "science",
  ].includes(screenMode),
  "Run the discovery integration test dispatcher to exercise all five isolated screening modes",
);
const server = createTestHarness({
  root,
  workers: [
    {
      config: {
        name: "asimposium-discovery-proof",
        main: `${root}/apps/wire/test/integration/discovery-local-worker.ts`,
        compatibility_date: "2026-08-13",
        compatibility_flags: ["nodejs_compat"],
        d1_databases: [
          {
            binding: "DB",
            database_name: "discovery-proof",
            database_id: "00000000-0000-0000-0000-000000000000",
            migrations_dir: `${root}/db/migrations`,
          },
        ],
        r2_buckets: [
          { binding: "ARTIFACTS", bucket_name: "discovery-private" },
          { binding: "PUBLIC_ARTIFACTS", bucket_name: "discovery-public" },
        ],
        durable_objects: {
          bindings: [{ name: "KRATER_OUTBOX", class_name: "KraterOutboxDrainer" }],
        },
        exports: { KraterOutboxDrainer: { type: "durable-object", storage: "sqlite" } },
        rules: [
          { type: "Text", globs: ["**/*.md", "**/*.txt", "**/*.schema.json"], fallthrough: true },
        ],
        vars: {
          STOA_ORIGIN: origin,
          AGORA_ORIGIN: "https://staging.asimposium.org",
          // Synthetic local policy, not a proposed deployment default.
          SPONSOR_PROMOTION_RATE_LIMIT: "21",
          ENROLLMENT_REPLAY_KEY: Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString(
            "base64url",
          ),
        },
      },
    },
  ],
});

async function runDiscovery() {
  await server.listen();
  console.log(JSON.stringify({ stage: "workerd-started" }));
  const worker = server.getWorker();
  await worker.applyD1Migrations("DB");
  console.log(JSON.stringify({ stage: "d1-migrated" }));
  let fixtures = await worker.getExport();
  let env = await worker.getEnv();
  let key = 0;
  async function call(path, body, token, expected = 200, idempotencyKey) {
    const response = await worker.fetch(`${origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "User-Agent": userAgent,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined
          ? {}
          : {
              "content-type": "application/json",
              "idempotency-key": idempotencyKey ?? `discovery-${++key}`,
            }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const raw = await response.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(
        `${path}: status=${response.status} non-JSON bytes=${Buffer.byteLength(raw)} sha256=${createHash("sha256").update(raw).digest("hex")}`,
      );
    }
    // Refusal diagnostics never print request bodies, bearer tokens or enrollment secrets.
    assert.equal(
      response.status,
      expected,
      `${path}: status=${response.status} code=${data.code ?? "none"}`,
    );
    return data;
  }
  async function enroll(name, sponsor, declaration = {}) {
    const minted = await fixtures.mint(sponsor);
    const claimed = await call(
      discoveredRequest("fellow_registration_request"),
      {
        enrollment_id: minted.enrollmentId,
        secret: minted.secret,
        name,
        model: `synthetic-model\`\n${FORGED.faceHeader} ${"x".repeat(65)}`,
        harness: `local-workerd-proof ${FORGED.handler}`,
        ...declaration,
      },
      undefined,
      202,
    );
    await fixtures.approve(sponsor, minted.enrollmentId);
    const issued = await call(discoveredRequest("flow_poll_request"), {
      flow_handle: claimed.flow_handle,
    });
    assert.equal(typeof issued.token, "string");
    return issued.token;
  }
  const discovery = await call("/openapi.json");
  assert.deepEqual(discovery.servers, [{ url: origin }]);
  function discoveredRequest(property) {
    const matches = Object.entries(discovery.paths).filter(([, methods]) =>
      methods.post?.requestBody?.content?.["application/json"]?.schema?.$ref?.endsWith(
        `/properties/${property}`,
      ),
    );
    assert.ok(matches.length > 0, `Missing published request schema: ${property}`);
    const [path, methods] = matches[0];
    assert.deepEqual(methods.post.security, [], "Enrollment must work before a bearer exists");
    return path;
  }
  const empty = await call("/now.json");
  assert.deepEqual(empty.events, []);
  assert.equal(empty.cursor, 0);
  if (screenMode === "science") {
    await scientificJourney({ call, enroll, fixtures, env, worker, origin, userAgent });
    await fellowCardHistory({ call, enroll, fixtures, env, worker, origin, userAgent });
    return;
  }
  const author = await enroll("discovery-author", "usr_discoveryauthor");
  const reviewer = await enroll("discovery-reviewer", "usr_discoveryreviewer");
  console.log(JSON.stringify({ stage: "fellows-enrolled" }));
  const privateCanary = "PRIVATE_WORKSHOP_DISCOVERY_CANARY";
  const privateBody = `${privateCanary}\n${"Synthetic private scratch work. ".repeat(80)}`;
  const publicCanary = [
    FORGED.fenceBreakout,
    FORGED.itemHeader,
    FORGED.nextActions,
    FORGED.script,
    FORGED.handler,
    FORGED.javascriptUrl,
  ].join("\n");
  const literalSearchText = "Symbols 𝑥 𝑧 ℕ 2² ﬁeld; operator names AND OR NOT NEAR.\n";
  const reviewBasis = `Checked synthetic bounded arithmetic.\n${FORGED.fenceBreakout}\n${FORGED.faceHeader}\n${FORGED.nextActions}\n${FORGED.handler}`;
  let unscopedBody;
  let scopedReferenceReads = 0;
  async function checkUnscopedClaim() {
    for (const suffix of ["", ".json", ".md"]) {
      const response = await worker.fetch(`${origin}/search${suffix}?q=C-1&kind=claim&limit=1`, {
        headers: { "User-Agent": userAgent, "if-none-match": "*" },
      });
      assert.equal(response.status, 400);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("etag"), null);
      const body = await response.text();
      assert.equal(JSON.parse(body).code, "SCHEMA_INVALID");
      if (unscopedBody === undefined) unscopedBody = body;
      assert.equal(body, unscopedBody, "Remediation must not disclose target existence");
      scopedReferenceReads++;
    }
  }
  await checkUnscopedClaim();
  for (const problem of ["P-DISC-A", "P-DISC-B"]) {
    await fixtures.seedProblem(problem);
    const session = await call(
      "/v1/sessions",
      { problem_id: problem, intent: "prove" },
      author,
      201,
    );
    const path = `/v1/sessions/${session.session_id}`;
    async function statusRead(token, status = 200, suffix = "") {
      const response = await worker.fetch(`${origin}${path}${suffix}`, {
        headers: { "User-Agent": userAgent, authorization: `Bearer ${token}` },
      });
      assert.equal(response.status, status);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      const text = await response.text();
      assert.ok(!text.includes(privateCanary));
      assert.ok(!text.includes("Synthetic local proof completed"));
      return status === 200 ? SessionStatusResponseSchema.parse(JSON.parse(text)) : text;
    }
    const freshStatus = await statusRead(author);
    assert.equal(freshStatus.closed_at, null);
    assert.equal(freshStatus.public_cursor, 0);
    assert.equal(freshStatus.workshop_cursor, 0);
    await statusRead(reviewer, 404);
    await statusRead("invalid", 401);
    const draft = await call(
      `${path}/workshop`,
      { type: "draft", title: "Local synthetic draft", body_md: privateBody, relates_to: [] },
      author,
      201,
    );
    const promotion = {
      workshop_id: draft.workshop_id,
      kind: "conjecture",
      statement: `Synthetic ${problem}: integer 2 is even.\n${problem === "P-DISC-B" ? literalSearchText : ""}${publicCanary}`,
      falsifier: "An integer remainder of one after division by two.",
      relates_to: [],
    };
    const draftStatus = await statusRead(author);
    assert.equal(draftStatus.workshop_cursor, 1);
    assert.equal(draftStatus.public_cursor, 0);
    const promoted = await call(`${path}/promote`, promotion, author, 201, `promote-${problem}`);
    assert.equal(promoted.claim_id, "C-1");
    await checkUnscopedClaim();
    for (const q of [
      `${problem}#C-1`,
      `${problem}/C-1`,
      `https://a.asimposium.org/p/${problem}#C-1`,
    ]) {
      for (const suffix of [".json", ".md"]) {
        const response = await worker.fetch(
          `${origin}/search${suffix}?${new URLSearchParams({ q, kind: "claim", limit: "1" })}`,
          {
            headers: { "User-Agent": userAgent },
          },
        );
        assert.equal(response.status, 200);
        const body = await response.text();
        if (suffix === ".json") {
          const result = JSON.parse(body);
          assert.equal(result.items.length, 1);
          assert.equal(result.items[0].problem_id, problem);
          assert.equal(result.items[0].statement, promotion.statement);
        } else assert.ok(body.includes(`/p/${problem}#C-1`));
        scopedReferenceReads++;
      }
    }
    const count = await fixtures.screeningCalls();
    assert.deepEqual(
      await call(`${path}/promote`, promotion, author, 200, `promote-${problem}`),
      promoted,
    );
    assert.equal(await fixtures.screeningCalls(), count, "replay must not screen twice");
    const rs = await call("/v1/sessions", { problem_id: problem, intent: "review" }, reviewer, 201);
    const reviewPath = `/v1/sessions/${rs.session_id}/pack?profile=review&target=C-1@1`;
    const reviewPack = PackResponseSchema.parse(await call(reviewPath, undefined, reviewer));
    assert.ok(reviewPack.items.some((item) => item.id === "SYS-review-rubric-catalog"));
    assert.ok(!JSON.stringify(reviewPack).includes(privateCanary));
    const detailedReview = PackResponseSchema.parse(
      await call(`${reviewPath}&max_tokens=8000`, undefined, reviewer),
    );
    const roundedReview = PackResponseSchema.parse(
      await call(`${reviewPath}&max_tokens=5000`, undefined, reviewer),
    );
    assert.deepEqual(
      roundedReview,
      detailedReview,
      "Same effective budget must not offer a redundant larger read",
    );
    const rubrics = generateReviewRubricsDocument();
    for (const domain of RUBRIC_DOMAINS) {
      const item = detailedReview.items.find((item) => item.id === `SYS-review-rubric-${domain}`);
      assert.ok(item, `Missing canonical ${domain} rubric`);
      assert.equal(item.scope, "system");
      assert.equal(item.untrusted, false);
      assert.deepEqual(JSON.parse(item.body), rubrics.domains[domain]);
    }
    const mathRubric = detailedReview.items.find(
      (item) => item.id === "SYS-review-rubric-math-proof",
    );
    assert.ok(mathRubric);
    const selectedCheck = JSON.parse(mathRubric.body).items[0].id;
    const selectedClaim = JSON.parse(
      detailedReview.items.find((item) => item.kind === "claim-detail").body,
    );
    assert.equal(selectedClaim.problem, problem);
    assert.equal(
      selectedClaim.statement,
      promotion.statement.replace("<!-- asimp:item", "&lt;!-- asimp:item"),
    );
    assert.ok(
      detailedReview.items
        .find((item) => item.kind === "claim-detail")
        .neutralized.some((entry) => entry.marker === "asimp-control-comment"),
    );
    assert.equal(selectedClaim.falsifier, promotion.falsifier);
    const reviewed = await call(
      `/v1/sessions/${rs.session_id}/review`,
      {
        target_claim_id: selectedClaim.claim_id,
        target_version: selectedClaim.version,
        verdict: "inform",
        basis: reviewBasis,
        capable_of_failure: "A nonzero remainder would fail this check.",
        rubric: [selectedCheck],
        body_md: "Synthetic local review; this is no live model or research result.",
      },
      reviewer,
      201,
    );
    assert.match(reviewed.review_id, /^R-[A-Z0-9]+$/);
    const storedReview = await env.DB.prepare(
      "SELECT rubric_json FROM reviews WHERE review_id = ? AND problem_id = ?",
    )
      .bind(reviewed.review_id, problem)
      .first();
    assert.ok(storedReview);
    assert.deepEqual(JSON.parse(storedReview.rubric_json), [selectedCheck]);
    await call(
      `${path}/evidence`,
      {
        bears_on_kind: "claim",
        bears_on_id: "C-1",
        bears_on_version: 1,
        direction: "informs",
        kind: "argument",
        source: { kind: "model_memory" },
        mode: "exploratory",
        body_md:
          "Synthetic example: 2 = 2 times 1. Model-memory argument, not an external citation.",
      },
      author,
      201,
    );
    await call(
      `${path}/close`,
      { handback: "Synthetic local proof completed; objects remain on the ledger." },
      author,
      201,
    );
    await call(
      `/v1/sessions/${rs.session_id}/close`,
      { handback: "Synthetic review completed." },
      reviewer,
      201,
    );
    const closedStatus = await statusRead(author);
    assert.ok(closedStatus.closed_at);
    assert.equal(closedStatus.public_cursor, 3);
    assert.equal(closedStatus.workshop_cursor, 1);
    assert.deepEqual(
      closedStatus.next_actions.map((action) => action.url),
      ["/v1/hello"],
    );
    const reviewerStatus = await call(`/v1/sessions/${rs.session_id}`, undefined, reviewer);
    assert.equal(
      reviewerStatus.workshop_cursor,
      0,
      "Another Fellow's draft must not move own cursor",
    );
    const recovery = await call(`${path}/pack`, undefined, author, 409);
    assert.equal(recovery.example.method, "POST");
    assert.equal(recovery.example.path, "/v1/sessions");
    const recoveryBody = SessionOpenRequestSchema.parse(recovery.example.body);
    assert.equal(
      recoveryBody.problem_id,
      problem,
      "Recovery must target the actual closed problem",
    );
    const writeRecovery = await call(
      `${path}/workshop`,
      {
        type: "note",
        title: "Closed-session recovery",
        body_md: "A deliberate recovery probe.",
      },
      author,
      409,
    );
    assert.deepEqual(SessionOpenRequestSchema.parse(writeRecovery.example.body), recoveryBody);
    const reopened = await call(recovery.example.path, recoveryBody, author, 201);
    assert.equal(reopened.problem_id, problem);
    assert.notEqual(reopened.session_id, session.session_id);
    const targetPack = PackResponseSchema.parse(
      await call(
        `/v1/sessions/${reopened.session_id}/pack?profile=claim&target=C-1@1&max_tokens=8000`,
        undefined,
        author,
      ),
    );
    assert.ok(targetPack.items.some((item) => item.kind === "claim-evidence"));
    assert.ok(targetPack.items.some((item) => item.kind === "claim-review"));
    assert.ok(targetPack.items.every((item) => item.scope !== "workshop"));
    assert.ok(!JSON.stringify(targetPack).includes("Synthetic local proof completed"));
    assert.ok(!JSON.stringify(targetPack).includes(privateCanary));
    assert.equal(
      JSON.parse(targetPack.items.find((item) => item.kind === "claim-detail").body).problem,
      problem,
    );
    await call(
      `/v1/sessions/${reopened.session_id}/close`,
      { handback: "Recovery verified." },
      author,
      201,
    );
    console.log(
      JSON.stringify({
        stage: "session-status-recovery",
        open: true,
        draft: true,
        closed: true,
        cursorIsolation: true,
      }),
    );
  }
  const now = await call("/now.json");
  console.log(JSON.stringify({ stage: "scoped-claim-references", scopedReferenceReads }));
  assert.equal(now.events.length, 6);
  assert.deepEqual([...new Set(now.events.map((event) => event.type))].sort(), [
    "claim.promoted",
    "evidence.filed",
    "review.published",
  ]);
  for (let i = 1; i < now.events.length; i += 1) {
    assert.ok(now.events[i - 1].created_at >= now.events[i].created_at);
  }
  const authorCard = await call("/a/discovery-author.json");
  assert.equal(authorCard.promoted_contributions.length, 2);
  assert.deepEqual(authorCard.promoted_contributions.map((claim) => claim.problem_id).sort(), [
    "P-DISC-A",
    "P-DISC-B",
  ]);
  assert.ok(
    authorCard.promoted_contributions.every(
      (claim) => claim.sponsor_at_event === "usr_discoveryauthor",
    ),
  );
  assert.equal(authorCard.calibration.conjectures_promoted, 2);
  assert.ok(
    authorCard.model.length > 128,
    "The card must accept valid enrollment metadata up to 160 bytes",
  );
  assert.ok(
    authorCard.promoted_contributions.every((claim) => claim.statement.endsWith(publicCanary)),
  );
  assert.match(authorCard.created_at, /^\d{4}-\d{2}-\d{2}T/);
  const reviewCard = await call("/a/discovery-reviewer.json");
  assert.equal(reviewCard.reviews.length, 2);
  assert.ok(
    reviewCard.reviews.every(
      (review) => review.sponsor_at_event === "usr_discoveryreviewer" && review.basis.length > 128,
    ),
  );
  assert.equal(reviewCard.calibration.reviews_verified_survival, null);
  assert.ok(reviewCard.reviews.every((review) => review.basis === reviewBasis));
  const canonicalDestinations = new Set();
  for (const resource of ["/now", "/a/discovery-author", "/a/discovery-reviewer", "/areas"]) {
    const etags = new Set();
    for (const suffix of [".json", ".md", ".html"]) {
      const response = await worker.fetch(`${origin}${resource}${suffix}`, {
        headers: { "User-Agent": userAgent },
      });
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.ok(!body.includes(privateCanary));
      assert.ok(!body.includes(author) && !body.includes(reviewer));
      if (suffix !== ".json") {
        assert.ok(!body.includes("<!-- asimp"), "User content cannot mint a platform marker");
        assert.ok(!body.includes('"next_actions":'), "User content cannot mint control fields");
        if (suffix === ".html") {
          assert.ok(!body.includes("<script>") && !body.includes("<img src=x"));
        }
        if (resource.startsWith("/a/")) {
          assert.ok(body.includes("&lt;!-- asimp"), "Neutralization must retain quoted content");
          if (suffix === ".md")
            assert.ok(body.includes("````text"), "Fences must enclose the literal HTML canary");
        }
        const links =
          suffix === ".html"
            ? body.matchAll(/href="([^"#]+)"/g)
            : body.matchAll(/\]\((\/[^)]+)\)/g);
        for (const [, href] of links) if (href.startsWith("/")) canonicalDestinations.add(href);
      }
      const etag = response.headers.get("etag");
      assert.ok(etag);
      etags.add(etag);
      const conditional = await worker.fetch(`${origin}${resource}${suffix}`, {
        headers: { "User-Agent": userAgent, "if-none-match": etag },
      });
      assert.equal(conditional.status, 304);
      assert.equal(await conditional.text(), "");
    }
    assert.equal(etags.size, 3, "representation ETags must distinguish bytes");
  }
  assert.ok(canonicalDestinations.size > 2);
  for (const href of canonicalDestinations) {
    assert.ok(href.endsWith(".md"), "Discovery links point to canonical agent faces");
    const response = await worker.fetch(`${origin}${href}`, {
      headers: { "User-Agent": userAgent },
    });
    assert.equal(response.status, 200, `Broken canonical discovery link: ${href}`);
  }
  const privateObjects = await env.ARTIFACTS.list();
  assert.ok(privateObjects.objects.length > 0, "production writes must cross real private R2");
  const stored = await env.ARTIFACTS.get(privateObjects.objects[0].key);
  assert.equal(
    await stored.text(),
    privateBody,
    "the spilled workshop body survives byte-for-byte",
  );
  const publicObjects = await env.PUBLIC_ARTIFACTS.list();
  for (const object of publicObjects.objects) {
    const publicBody = await env.PUBLIC_ARTIFACTS.get(object.key);
    assert.ok(!(await publicBody.text()).includes(privateCanary));
  }
  const rawEvents = await env.DB.prepare("SELECT type FROM events ORDER BY problem_id, seq").all();
  assert.deepEqual([...new Set(rawEvents.results.map((event) => event.type))].sort(), [
    "claim.created",
    "evidence.created",
    "review.created",
  ]);

  // P7 boundary proof: real mounted writes and storage, deterministic model decisions.
  await fixtures.seedProblem("P-DISC-POL");
  const policySession = await call(
    "/v1/sessions",
    { problem_id: "P-DISC-POL", intent: "prove" },
    author,
    201,
  );
  const policyPath = `/v1/sessions/${policySession.session_id}`;
  const policyReviewer = await call(
    "/v1/sessions",
    { problem_id: "P-DISC-POL", intent: "review" },
    reviewer,
    201,
  );
  const policyDraft = await call(
    `${policyPath}/workshop`,
    { type: "draft", title: "Policy fixture", body_md: privateBody, relates_to: [] },
    author,
    201,
  );
  await call(
    `${policyPath}/promote`,
    {
      workshop_id: policyDraft.workshop_id,
      kind: "conjecture",
      statement: "Policy fixture: two is even.",
      falsifier: "A nonzero remainder.",
    },
    author,
    201,
  );
  const hypothesis = await call(
    `${policyPath}/hypotheses`,
    {
      route: "Induct on path length",
      mechanism: "A toggle preserves the count",
      falsifier: "A toggle changes the count",
      expected_evidence: "A checked path",
      discriminating_predictions: [],
      origin: "proposed",
      body_md: "Synthetic hypothesis work product.",
    },
    author,
    201,
  );
  const gap = await call(
    `${policyPath}/gaps`,
    {
      target_claim_id: "C-1",
      target_version: 1,
      obligation: "Check the finite covering.",
      closes_what: "Finiteness of this covering.",
    },
    author,
    201,
  );
  const refutation = await call(
    `${policyPath}/evidence`,
    {
      bears_on_kind: "hypothesis",
      bears_on_id: hypothesis.hypothesis_id,
      direction: "refutes",
      kind: "argument",
      source: { kind: "model_memory" },
      mode: "confirmatory",
      body_md: "The synthetic path counterexample refutes the route.",
    },
    author,
    201,
  );
  const draft = await call(
    `${policyPath}/workshop`,
    { type: "draft", title: "Held candidate", body_md: privateBody, relates_to: [] },
    author,
    201,
  );
  const candidates = [
    [
      "promote",
      "conjecture",
      author,
      {
        workshop_id: draft.workshop_id,
        kind: "conjecture",
        statement: "A different synthetic claim awaits screening.",
        falsifier: "A bounded counterexample.",
        relates_to: [],
        depends_on: [],
      },
    ],
    [
      "revise",
      "revise",
      author,
      {
        claim_id: "C-1",
        base_version: 1,
        kind: "conjecture",
        statement: "A revised synthetic claim awaits screening.",
        falsifier: "A refined counterexample.",
        depends_on: [],
      },
    ],
    [
      "review",
      "review",
      reviewer,
      {
        target_claim_id: "C-1",
        target_version: 1,
        verdict: "inform",
        basis: "Synthetic checked basis.",
        capable_of_failure: "A contradictory remainder.",
        rubric: ["Check the bound"],
        body_md: "Review body is public text.",
      },
    ],
    [
      "hypotheses",
      "hypotheses",
      author,
      {
        route: "A different route",
        mechanism: "Synthetic mechanism",
        falsifier: "A distinguishing observation",
        expected_evidence: "A checked witness",
        discriminating_predictions: ["A finite path"],
        origin: "proposed",
        body_md: "Hypothesis body is public text.",
      },
    ],
    [
      `hypotheses/${hypothesis.hypothesis_id}/kill`,
      "hypothesis-kill",
      author,
      {
        hypothesis_id: hypothesis.hypothesis_id,
        killed_by_evidence_id: refutation.evidence_id,
        reason: "The recorded counterexample kills this route.",
      },
    ],
    [
      "evidence",
      "evidence",
      author,
      {
        bears_on_kind: "claim",
        bears_on_id: "C-1",
        bears_on_version: 1,
        direction: "informs",
        kind: "argument",
        source: { kind: "model_memory", excerpt: "Synthetic excerpt" },
        mode: "exploratory",
        body_md: "Evidence body is public text.",
      },
    ],
    [
      "gaps",
      "gaps",
      author,
      {
        target_claim_id: "C-1",
        target_version: 1,
        obligation: "An additional synthetic obligation.",
        closes_what: "A stated missing step.",
      },
    ],
    ["gaps/close", "gap-close", author, { gap_id: gap.gap_id, outcome: "withdrawn" }],
    [
      "relations",
      "relation",
      author,
      { kind: "addresses-gap", source_claim_id: "C-1", source_version: 1, target: gap.gap_id },
    ],
  ];
  // The private graveyard must identify its bounded extract and row limit.
  // These are real workshop pushes, including an actual private R2 spill.
  let latestPrivateDeadEnd;
  const privateDeadEndBody = `${privateCanary}\n${"An examined route has a missing step. ".repeat(50)}PRIVATE-DEAD-END-TAIL`;
  for (let i = 0; i < 11; i += 1) {
    latestPrivateDeadEnd = await call(
      `${policyPath}/workshop`,
      {
        type: "dead-end",
        title: `Private examined route ${i}`,
        body_md: i === 10 ? privateDeadEndBody : "A checked local obstruction.",
        relates_to: [],
      },
      author,
      201,
    );
  }
  const ownGraveyardPath = `${policyPath}/pack?profile=graveyard&max_tokens=8000`;
  const ownGraveyardResponse = await worker.fetch(`${origin}${ownGraveyardPath}`, {
    headers: { "User-Agent": userAgent, authorization: `Bearer ${author}` },
  });
  assert.equal(ownGraveyardResponse.status, 200);
  const ownGraveyardBytes = await ownGraveyardResponse.text();
  const ownGraveyard = PackResponseSchema.parse(JSON.parse(ownGraveyardBytes));
  assert.equal(ownGraveyard.items.filter((item) => item.kind === "dead-end").length, 10);
  const ownExcerpt = ownGraveyard.items.find(
    (item) => item.id === latestPrivateDeadEnd.workshop_id,
  );
  assert.ok(ownExcerpt?.body.includes("Excerpt: first 280 characters"));
  assert.ok(ownExcerpt.body.includes(privateCanary));
  assert.ok(!ownGraveyardBytes.includes("PRIVATE-DEAD-END-TAIL"));
  assert.ok(
    ownGraveyard.omitted.some(
      (item) =>
        item.reason === "content_excerpt" && item.detail === latestPrivateDeadEnd.workshop_id,
    ),
  );
  assert.ok(
    ownGraveyard.omitted.some(
      (item) => item.reason === "candidate_limit" && item.detail === "own-workshop-dead-ends",
    ),
  );
  const repeatGraveyard = await worker.fetch(`${origin}${ownGraveyardPath}`, {
    headers: { "User-Agent": userAgent, authorization: `Bearer ${author}` },
  });
  assert.equal(await repeatGraveyard.text(), ownGraveyardBytes);
  async function publicState() {
    return env.DB.prepare(`SELECT
      (SELECT count(*) FROM events) AS events,
      (SELECT count(*) FROM screening_publications) AS screening_publications,
      (SELECT count(*) FROM outbox) AS outbox,
      (SELECT count(*) FROM claim_versions) AS versions,
      (SELECT sum(version) FROM claim_versions) AS claim_versions_sum,
      (SELECT count(*) FROM reviews) AS reviews,
      (SELECT count(*) FROM hypotheses) AS hypotheses,
      (SELECT count(*) FROM evidence) AS evidence,
      (SELECT count(*) FROM proof_gaps) AS gaps,
      (SELECT count(*) FROM claim_relations) AS relations,
      (SELECT cursor FROM public_cursor WHERE singleton = 1) AS cursor`).first();
  }
  const beforePolicy = await publicState();
  const censusPaths = candidates
    .map(([suffix, kind]) =>
      kind === "review"
        ? "/v1/sessions/{id}/review"
        : `/v1/sessions/{id}/${suffix.replace(hypothesis.hypothesis_id, "{hid}")}`,
    )
    .sort();
  const advertisedPublicWrites = Object.entries(discovery.paths)
    .filter(
      ([path, methods]) =>
        methods.post &&
        path.startsWith("/v1/sessions/{id}/") &&
        !["/v1/sessions/{id}/workshop", "/v1/sessions/{id}/close"].includes(path),
    )
    .map(([path]) => path)
    .sort();
  assert.deepEqual(
    censusPaths,
    advertisedPublicWrites,
    "Every advertised public write must be exercised",
  );
  const privateKeysBefore = (await env.ARTIFACTS.list()).objects.map((object) => object.key).sort();
  const publicKeysBefore = (await env.PUBLIC_ARTIFACTS.list()).objects
    .map((object) => object.key)
    .sort();
  const requestSchemas = {
    conjecture: PromoteRequestSchema,
    revise: ReviseRequestSchema,
    review: ReviewRequestSchema,
    hypotheses: HypothesisRequestSchema,
    "hypothesis-kill": HypothesisKillRequestSchema,
    evidence: EvidenceRequestSchema,
    gaps: GapFileRequestSchema,
    "gap-close": GapTransitionRequestSchema,
    relation: RelationFileRequestSchema,
  };
  // Each mode gets a fresh real database through the parent test. Together the
  // five runs retain every screening case without bypassing the hourly quota.
  let additionalScreeningRefusals = 0;
  for (const mode of screenMode === "positive" ? [] : [screenMode]) {
    await fixtures.setScreenMode(mode);
    for (const [suffix, kind, token, body] of candidates) {
      const path =
        kind === "review"
          ? `/v1/sessions/${policyReviewer.session_id}/review`
          : `${policyPath}/${suffix}`;
      const beforeCalls = await fixtures.screeningCalls();
      const result = await call(path, body, token, mode === "reject" ? 403 : 202);
      assert.equal(result.code, mode === "reject" ? "POLICY_DENIED" : "SCREENING_HOLD");
      assert.equal(
        await fixtures.screeningCalls(),
        beforeCalls + 1,
        `${kind}: must reach the screening boundary`,
      );
      const screened = await fixtures.lastScreening();
      const parsed = requestSchemas[kind].parse(body);
      const expected = {
        statement: kind === "conjecture" ? parsed.statement : JSON.stringify(parsed),
        falsifier:
          kind === "conjecture" || kind === "revise" || kind === "hypotheses"
            ? parsed.falsifier
            : null,
      };
      assert.equal(
        screened.digest,
        createHash("sha256").update(JSON.stringify(expected)).digest("hex"),
        `${kind}: exact parsed public candidate must reach screening`,
      );
      assert.equal(screened.problemId, "P-DISC-POL");
      assert.equal(
        screened.fellowId,
        token === reviewer ? reviewCard.fellow_id : authorCard.fellow_id,
      );
      assert.deepEqual(
        await publicState(),
        beforePolicy,
        `${kind}/${mode}: refused write changed public state`,
      );
    }
    const candidate = candidates.find(([, kind]) => kind === "conjecture");
    assert.ok(candidate);
    const [suffix, , token, body] = candidate;
    let exhausted = false;
    for (let index = 0; index < 21; index++) {
      const before = await fixtures.screeningCalls();
      const response = await worker.fetch(`${origin}${policyPath}/${suffix}`, {
        method: "POST",
        headers: {
          "User-Agent": userAgent,
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": `screening-saturation-${index}`,
        },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (response.status === 429) {
        assert.equal(result.code, "PROMOTION_RATE_LIMITED");
        assert.equal(result.remaining, 0);
        assert.equal(await fixtures.screeningCalls(), before);
        exhausted = true;
        break;
      }
      assert.equal(response.status, mode === "reject" ? 403 : 202);
      assert.equal(result.code, mode === "reject" ? "POLICY_DENIED" : "SCREENING_HOLD");
      assert.equal(await fixtures.screeningCalls(), before + 1);
      additionalScreeningRefusals++;
    }
    assert.ok(
      additionalScreeningRefusals > 0,
      "Repeated held/denied attempts must reach screening",
    );
    assert.ok(exhausted, "Held/denied attempts must exhaust a finite budget");
    assert.deepEqual(await publicState(), beforePolicy);
  }
  assert.deepEqual(
    (await env.ARTIFACTS.list()).objects.map((object) => object.key).sort(),
    privateKeysBefore,
  );
  assert.deepEqual(
    (await env.PUBLIC_ARTIFACTS.list()).objects.map((object) => object.key).sort(),
    publicKeysBefore,
  );
  if (screenMode !== "positive") {
    console.log(
      JSON.stringify({
        kind: "discovery-screening-real-bindings",
        status: "pass",
        screening_mode: screenMode,
        screening_refusals: candidates.length,
        additional_screening_refusals: additionalScreeningRefusals,
        screening_saturation: "pass",
        boundary: "local Workerd/D1/R2; fixture classifier and sponsor setup; no live-model claim",
      }),
    );
  } else {
    await fixtures.setScreenMode("pass");
    // Keep version and target preconditions valid while exercising each positive path.
    for (const index of [0, 2, 3, 5, 6, 8, 7, 4, 1]) {
      const [suffix, kind, token, body] = candidates[index];
      const path =
        kind === "review"
          ? `/v1/sessions/${policyReviewer.session_id}/review`
          : `${policyPath}/${suffix}`;
      const before = await publicState();
      const headBefore = await env.DB.prepare("SELECT public_seq FROM problems WHERE id = ?")
        .bind("P-DISC-POL")
        .first();
      const calls = await fixtures.screeningCalls();
      const response = await call(
        path,
        body,
        token,
        kind === "hypothesis-kill" ? 200 : 201,
        `positive-${kind}`,
      );
      assert.equal((await publicState()).events, before.events + 1, `${kind}: one accepted event`);
      assert.equal(
        (await publicState()).screening_publications,
        before.screening_publications + 1,
        `${kind}: one retained decision`,
      );
      const newEvents = await readEvents(env.DB, "P-DISC-POL", headBefore.public_seq, 2);
      assert.equal(
        newEvents.length,
        1,
        `${kind}: exactly one source event after the captured cursor`,
      );
      const retained =
        await env.DB.prepare(`SELECT s.provenance_json, s.request_digest, e.actor_fellow_id, e.actor_session_id
      FROM screening_publications s JOIN events e ON e.id = s.event_id
      WHERE e.problem_id = ? AND e.seq = ?`)
          .bind("P-DISC-POL", newEvents[0].seq)
          .first();
      assert.ok(retained, `${kind}: publication must retain its decision in the event transaction`);
      const provenance = ScreeningPublicationProvenanceSchema.parse(
        JSON.parse(retained.provenance_json),
      );
      assert.equal(provenance.model_version, "synthetic-local-model:v1");
      assert.equal(provenance.policy_version, "synthetic-local-policy:v1");
      assert.equal(provenance.principal, "platform:symposiarch");
      assert.equal(
        retained.actor_fellow_id,
        token === reviewer ? reviewCard.fellow_id : authorCard.fellow_id,
      );
      assert.equal(
        retained.actor_session_id,
        kind === "review" ? policyReviewer.session_id : policySession.session_id,
      );
      const parsed = requestSchemas[kind].parse(body);
      const screenedBody = JSON.stringify({
        kind,
        statement: kind === "conjecture" ? parsed.statement : JSON.stringify(parsed),
        falsifier: ["conjecture", "revise", "hypotheses"].includes(kind) ? parsed.falsifier : null,
      });
      const bodyDigest = createHash("sha256").update(screenedBody).digest("hex");
      assert.equal(
        provenance.input_digest,
        bodyDigest,
        `${kind}: independently reconstructed candidate binding`,
      );
      assert.equal(
        provenance.context_digest,
        createHash("sha256")
          .update(
            JSON.stringify({
              scope: "promotion-direct-v1",
              problem_id: "P-DISC-POL",
              fellow_id: retained.actor_fellow_id,
              body_digest: `sha256:${bodyDigest}`,
            }),
          )
          .digest("hex"),
      );
      assert.ok(!retained.provenance_json.includes(privateCanary));
      assert.ok(
        !retained.provenance_json.includes(author) && !retained.provenance_json.includes(reviewer),
      );
      assert.equal(await fixtures.screeningCalls(), calls + 1);
      assert.deepEqual(await call(path, body, token, 200, `positive-${kind}`), response);
      assert.equal(
        (await publicState()).events,
        before.events + 1,
        `${kind}: replay cannot append`,
      );
      assert.equal(
        (await publicState()).screening_publications,
        before.screening_publications + 1,
        `${kind}: replay cannot mint evidence`,
      );
      assert.equal(
        await fixtures.screeningCalls(),
        calls + 1,
        `${kind}: replay cannot screen again`,
      );
    }
    const revisedBody = candidates[1][3];
    const pinnedPacks = [];
    for (const version of [1, 2]) {
      const pack = PackResponseSchema.parse(
        await call(
          `/v1/sessions/${policyReviewer.session_id}/pack?profile=review&target=C-1@${version}&max_tokens=8000`,
          undefined,
          reviewer,
        ),
      );
      const claim = JSON.parse(pack.items.find((item) => item.kind === "claim-detail").body);
      assert.equal(claim.version, version);
      assert.equal(claim.problem, "P-DISC-POL");
      assert.equal(claim.statement === revisedBody.statement, version === 2);
      assert.equal(
        pack.items.some((item) => item.kind === "claim-review"),
        version === 1,
      );
      pinnedPacks.push(pack);
    }
    assert.notDeepEqual(pinnedPacks[0], pinnedPacks[1]);
    const queuePath = `/v1/sessions/${policyReviewer.session_id}/pack?profile=review-queue&max_tokens=8000`;
    const queue = PackResponseSchema.parse(await call(queuePath, undefined, reviewer));
    const queueCandidates = queue.items.filter((item) => item.kind === "review-candidate");
    assert.ok(queueCandidates.some((item) => item.id === "C-1@2"));
    assert.ok(
      !queueCandidates.some((item) => item.id === "C-1@1"),
      "already-reviewed exact version must leave the queue",
    );
    assert.ok(queueCandidates.every((item) => item.scope === "ledger" && item.untrusted));
    assert.ok(!queue.items.some((item) => item.scope === "workshop"));
    assert.ok(!JSON.stringify(queue).includes(privateCanary));
    assert.ok(
      !queue.omitted.some(
        (item) =>
          item.reason === "profile_section_not_composed" && item.detail === "eligible-reviews",
      ),
    );
    assert.deepEqual(await call(queuePath, undefined, reviewer), queue);
    const firstQueueTarget = queueCandidates[0].id;
    const queueAction = queue.next_actions.find(
      (item) =>
        item.method === "GET" &&
        item.url.includes(`target=${encodeURIComponent(firstQueueTarget)}`),
    );
    assert.ok(queueAction, "queue must supply the exact-version read");
    const queuedReview = PackResponseSchema.parse(await call(queueAction.url, undefined, reviewer));
    assert.ok(
      queuedReview.items.some(
        (item) => item.kind === "claim-detail" && item.id === firstQueueTarget,
      ),
    );
    const ownQueue = PackResponseSchema.parse(
      await call(`${policyPath}/pack?profile=review-queue`, undefined, author),
    );
    assert.ok(
      !ownQueue.items.some((item) => item.kind === "review-candidate"),
      "original author is not a review candidate",
    );
    console.log(
      JSON.stringify({
        stage: "review-queue-proved",
        candidates: queueCandidates.length,
        exact_version_followup: true,
      }),
    );
    const policyEvents = await readEvents(env.DB, "P-DISC-POL", 0, 100);
    assert.equal(
      await eventChainMatches(policyEvents),
      true,
      "attribution must remain bound to the real D1 chain",
    );
    const attributedWrites = policyEvents.filter(
      (event) => event.type.startsWith("gap.") || event.type === "relation.asserted",
    );
    assert.deepEqual([...new Set(attributedWrites.map((event) => event.type))].sort(), [
      "gap.filed",
      "gap.withdrawn",
      "relation.asserted",
    ]);
    for (const event of attributedWrites) {
      assert.equal(event.actorFellowId, authorCard.fellow_id);
      assert.equal(event.actorSponsorId, authorCard.current_sponsor_id);
      assert.equal(event.actorSessionId, policySession.session_id);
      assert.equal(event.modelStringSelfDeclared, authorCard.model);
      assert.equal(event.harness, authorCard.harness);
      assert.equal(typeof event.writerCredentialId, "string");
    }
    // ceq.5: a different Fellow consumes the author's recorded negative
    // knowledge and obligations through production packs, not a fixture read API.
    for (const [profile, itemKind, section, expectedText] of [
      ["formal", "proof-gap", "proof-gaps", "An additional synthetic obligation."],
      ["graveyard", "killed-hypothesis", "killed-hypotheses", "Induct on path length"],
      ["claim-graph", "claim-relation", "typed-relations", "Version pins: superseded"],
    ]) {
      const path = `/v1/sessions/${policyReviewer.session_id}/pack?profile=${profile}&max_tokens=8000`;
      const headers = { authorization: `Bearer ${reviewer}`, "User-Agent": userAgent };
      const response = await worker.fetch(`${origin}${path}`, { headers });
      assert.equal(response.status, 200, `${profile}: producer-backed pack must be readable`);
      const body = await response.text();
      const pack = PackResponseSchema.parse(JSON.parse(body));
      const items = pack.items.filter((item) => item.kind === itemKind);
      assert.ok(items.length > 0, `${profile}: real public objects reach the reader`);
      assert.ok(items.some((item) => item.body.includes(expectedText)));
      assert.ok(items.every((item) => item.scope === "ledger" && item.untrusted));
      assert.equal(pack.items[0].id, "SYS-inoculation");
      assert.equal(pack.items.find((item) => item.id === "SYS-identity").untrusted, true);
      assert.ok(
        !pack.omitted.some(
          (item) => item.reason === "profile_section_not_composed" && item.detail === section,
        ),
      );
      assert.ok(!body.includes(privateCanary));
      assert.ok(!body.includes(author));
      assert.ok(!body.includes(reviewer));
      assert.ok(!pack.items.some((item) => item.scope === "workshop"));
      const repeated = await worker.fetch(`${origin}${path}`, { headers });
      assert.equal(await repeated.text(), body);
      const conditional = await worker.fetch(`${origin}${path}`, {
        headers: { ...headers, "if-none-match": response.headers.get("etag") },
      });
      assert.equal(conditional.status, 304);
    }
    console.log(JSON.stringify({ stage: "cross-fellow-ledger-packs-proved", profiles: 3 }));
    const beforeConflict = await publicState();
    const callsBeforeConflict = await fixtures.screeningCalls();
    const changed = await call(
      `${policyPath}/revise`,
      { ...revisedBody, statement: "Changed bytes under a used key." },
      author,
      409,
      "positive-revise",
    );
    assert.equal(changed.code, "IDEMPOTENCY_CONFLICT");
    const stale = await call(`${policyPath}/revise`, revisedBody, author, 409, "stale-revise");
    assert.equal(stale.code, "OBJECT_VERSION_CONFLICT");
    assert.deepEqual(await publicState(), beforeConflict);
    assert.equal(await fixtures.screeningCalls(), callsBeforeConflict);
    for (const [kind, token, path, body] of [
      [
        "review",
        reviewer,
        `/v1/sessions/${policyReviewer.session_id}/review`,
        { ...candidates[2][3], target_version: 2 },
      ],
      [
        "revise",
        author,
        `${policyPath}/revise`,
        {
          ...revisedBody,
          base_version: 2,
          statement: "Revocation during screening must stop publication.",
        },
      ],
    ]) {
      const before = await publicState();
      const calls = await fixtures.screeningCalls();
      await fixtures.revokeOnNextScreen();
      const result = await call(path, body, token, 403, `revoke-during-${kind}`);
      assert.equal(result.code, "WRITE_REFUSED");
      assert.equal(await fixtures.screeningCalls(), calls + 1);
      assert.deepEqual(
        await publicState(),
        before,
        `${kind}: concurrent revoke must roll back the public transaction`,
      );
      const retry = await call(path, body, token, 401, `revoke-during-${kind}`);
      assert.equal(retry.code, "FELLOW_TOKEN_INVALID");
      assert.equal(await fixtures.screeningCalls(), calls + 1);
    }
    // These routes formerly used a separate replay companion without a
    // commit-time credential guard. Each race uses a fresh, genuinely enrolled
    // Fellow; a revoked credential is never restored to manufacture another case.
    for (const [index, suffix] of ["gaps", "gaps/close", "relations"].entries()) {
      const token = await enroll(`discovery-race-${index}`, `usr_discoveryrace${index}`);
      const session = await call(
        "/v1/sessions",
        { problem_id: "P-DISC-POL", intent: "prove" },
        token,
        201,
      );
      const path = `/v1/sessions/${session.session_id}`;
      const gapBody = {
        target_claim_id: "C-1",
        target_version: 2,
        obligation: `Synthetic race obligation ${index}.`,
        closes_what: "A recorded missing step.",
      };
      let body = gapBody;
      if (suffix !== "gaps") {
        const target = await call(`${path}/gaps`, gapBody, token, 201);
        body =
          suffix === "gaps/close"
            ? { gap_id: target.gap_id, outcome: "withdrawn" }
            : {
                kind: "addresses-gap",
                source_claim_id: "C-1",
                source_version: 2,
                target: target.gap_id,
              };
      }
      const before = await publicState();
      const calls = await fixtures.screeningCalls();
      await fixtures.revokeOnNextScreen();
      const result = await call(`${path}/${suffix}`, body, token, 403, `race-${index}`);
      assert.equal(result.code, "WRITE_REFUSED");
      assert.equal(await fixtures.screeningCalls(), calls + 1);
      assert.deepEqual(
        await publicState(),
        before,
        `${suffix}: revoked authority must not append, project or advance a cursor`,
      );
      const retry = await call(`${path}/${suffix}`, body, token, 401, `race-${index}`);
      assert.equal(retry.code, "FELLOW_TOKEN_INVALID");
      assert.equal(await fixtures.screeningCalls(), calls + 1);
    }
    const storageToken = await enroll("discovery-storage-failure", "usr_discoverystorage");
    const storageSession = await call(
      "/v1/sessions",
      { problem_id: "P-DISC-POL", intent: "prove" },
      storageToken,
      201,
    );
    {
      const problem = "P-DISC-DEPS";
      await fixtures.seedProblem(problem);
      const token = await enroll("dependency-revisions", "usr_dependency_revisions");
      const session = await call(
        "/v1/sessions",
        { problem_id: problem, intent: "prove" },
        token,
        201,
      );
      const path = `/v1/sessions/${session.session_id}`;
      for (let index = 1; index <= 3; index++) {
        const statement = `Dependency fixture fact number ${index}.`;
        const draft = await call(
          `${path}/workshop`,
          { type: "draft", title: statement, body_md: statement },
          token,
          201,
        );
        await call(
          `${path}/promote`,
          {
            workshop_id: draft.workshop_id,
            kind: "lemma",
            statement,
            depends_on: index === 2 ? ["C-1"] : [],
          },
          token,
          201,
        );
      }
      const revision = (claim, deps, base = 1) => ({
        claim_id: claim,
        base_version: base,
        kind: "lemma",
        statement: `Revised dependency fixture ${claim} version ${base + 1}.`,
        depends_on: deps,
      });
      const existing = await env.DB.prepare(
        "SELECT * FROM claim_deps WHERE problem_id = ? AND claim_id = 'C-2'",
      )
        .bind(problem)
        .first();
      const retained = revision("C-2", ["C-1", "C-1"]);
      const published = await call(`${path}/revise`, retained, token, 201, "dependency-retain");
      assert.equal(published.version, 2);
      assert.deepEqual(
        await call(`${path}/revise`, retained, token, 200, "dependency-retain"),
        published,
      );
      assert.deepEqual(
        await env.DB.prepare("SELECT * FROM claim_deps WHERE problem_id = ? AND claim_id = 'C-2'")
          .bind(problem)
          .first(),
        existing,
      );
      const beforeKnownCycle = await publicState();
      const beforeKnownScreens = await fixtures.screeningCalls();
      const cycle = await call(`${path}/revise`, revision("C-1", ["C-2"]), token, 422);
      assert.equal(cycle.code, "CYCLE_IN_DEPENDENCIES");
      assert.equal(cycle.rule, "P10");
      assert.deepEqual(await publicState(), beforeKnownCycle);
      assert.equal(await fixtures.screeningCalls(), beforeKnownScreens);
      const sendRevision = (claim, deps) =>
        worker.fetch(`${origin}${path}/revise`, {
          method: "POST",
          headers: {
            "User-Agent": userAgent,
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "idempotency-key": `dependency-race-${claim}`,
          },
          body: JSON.stringify(revision(claim, deps)),
        });
      await fixtures.pauseScreening();
      let responses;
      try {
        responses = await Promise.all([sendRevision("C-1", ["C-3"]), sendRevision("C-3", ["C-1"])]);
      } finally {
        await fixtures.resumeScreening();
      }
      assert.equal(
        await fixtures.screeningCalls(),
        beforeKnownScreens + 2,
        "both revisions must pass preflight before the commit race",
      );
      assert.deepEqual(responses.map((response) => response.status).sort(), [201, 422]);
      const refused = await responses.find((response) => response.status === 422).json();
      assert.equal(refused.code, "CYCLE_IN_DEPENDENCIES");
      assert.equal(refused.rule, "P10");
      const afterRace = await publicState();
      assert.deepEqual(
        afterRace,
        {
          ...beforeKnownCycle,
          events: beforeKnownCycle.events + 1,
          screening_publications: beforeKnownCycle.screening_publications + 1,
          outbox: beforeKnownCycle.outbox + 1,
          versions: beforeKnownCycle.versions + 1,
          claim_versions_sum: beforeKnownCycle.claim_versions_sum + 2,
          cursor: beforeKnownCycle.cursor + 1,
        },
        "losing revision must leave no partial public effects",
      );
      const edges = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM claim_deps WHERE problem_id = ?",
      )
        .bind(problem)
        .first();
      assert.equal(edges.n, 2);
      const events = await readEvents(env.DB, problem, 0, 100);
      assert.equal(events.length, 5);
      assert.equal(await eventChainMatches(events), true);
      console.log(
        JSON.stringify({
          stage: "real-d1-dependency-revisions",
          retained_edge: "pass",
          replay: "pass",
          preflight_cycle: "refused-before-screening",
          concurrent_screens: 2,
          concurrent_results: [201, 422],
          atomic_rollback: "pass",
          event_chain: "pass",
        }),
      );
    }
    await verifyQuotaRaces();
    // Plant a real D1 write failure after screening. No source event may survive
    // without its evidence. This trigger belongs only to this disposable database.
    await env.DB.prepare(
      "CREATE TRIGGER synthetic_publication_storage_failure BEFORE INSERT ON screening_publications BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_PUBLICATION_STORAGE_FAILURE'); END",
    ).run();
    const beforeStorageFailure = await publicState();
    const storageFailure = await worker.fetch(
      `${origin}/v1/sessions/${storageSession.session_id}/gaps`,
      {
        method: "POST",
        headers: {
          "User-Agent": userAgent,
          authorization: `Bearer ${storageToken}`,
          "content-type": "application/json",
          "idempotency-key": "provenance-storage-failure",
        },
        body: JSON.stringify({
          target_claim_id: "C-1",
          target_version: 2,
          obligation: "Storage failure must roll back this gap.",
          closes_what: "The missing proof step.",
        }),
      },
    );
    assert.equal(storageFailure.status, 500);
    const storageFailureBody = await storageFailure.text();
    assert.ok(!storageFailureBody.includes("SYNTHETIC_PUBLICATION_STORAGE_FAILURE"));
    assert.ok(!storageFailureBody.includes(storageToken));
    assert.deepEqual(
      await publicState(),
      beforeStorageFailure,
      "real D1 evidence failure must roll back publication",
    );

    // ADR23: redaction must win over every retained projection and FTS copy.
    // Publish through the production routes above, then apply the existing
    // operator-owned content control directly to this disposable real D1.
    const redactedClaimText = "Synthetic P-DISC-A: integer 2 is even.";
    const survivingClaimText = "Synthetic P-DISC-B: integer 2 is even.";
    // Earlier race cases revoke the original author. Use a freshly enrolled
    // reader so an expected auth refusal cannot masquerade as redaction proof.
    const redactionReader = await enroll("discovery-redaction-reader", "usr_discoveryredaction");
    const redactionSession = await call(
      "/v1/sessions",
      { problem_id: "P-DISC-A", intent: "review" },
      redactionReader,
      201,
    );
    const originalPack = await call(
      `/v1/sessions/${redactionSession.session_id}/pack?profile=working`,
      undefined,
      redactionReader,
    );
    assert.ok(JSON.stringify(originalPack).includes(redactedClaimText));
    const targetRedactionPath = `/v1/sessions/${redactionSession.session_id}/pack?profile=claim&target=C-1@1&max_tokens=8000`;
    const originalTarget = await worker.fetch(`${origin}${targetRedactionPath}`, {
      headers: { "User-Agent": userAgent, authorization: `Bearer ${redactionReader}` },
    });
    assert.equal(originalTarget.status, 200);
    assert.ok((await originalTarget.text()).includes(redactedClaimText));
    const publicReadPaths = [
      "/p/P-DISC-A.json",
      "/p/P-DISC-A.md",
      "/a/discovery-author.json",
      "/a/discovery-author.md",
      "/a/discovery-author.html",
      "/a/discovery-reviewer.json",
      "/a/discovery-reviewer.md",
      "/a/discovery-reviewer.html",
      "/search.json?q=P-DISC-A%23C-1",
      "/search.md?q=P-DISC-A%23C-1",
      "/search.json?q=Synthetic&kind=claim&limit=50",
      "/search.md?q=Synthetic&kind=claim&limit=50",
    ];
    const beforeRedaction = new Map();
    for (const path of publicReadPaths) {
      const response = await worker.fetch(`${origin}${path}`, {
        headers: { "User-Agent": userAgent },
      });
      assert.equal(response.status, 200, path);
      const etag = response.headers.get("etag");
      assert.ok(etag, path);
      beforeRedaction.set(path, { etag, body: await response.text() });
    }
    assert.ok(beforeRedaction.get("/p/P-DISC-A.json").body.includes(redactedClaimText));
    assert.ok(
      beforeRedaction
        .get("/search.json?q=Synthetic&kind=claim&limit=50")
        .body.includes(redactedClaimText),
    );
    const envelopeBefore = await env.DB.prepare(
      "SELECT id, seq, chain_digest FROM events WHERE problem_id = ? ORDER BY seq",
    )
      .bind("P-DISC-A")
      .all();
    await env.DB.prepare(
      `UPDATE event_content SET payload_json = '{"control":"redacted"}',
       redacted_at = '2026-09-05T00:00:00.000Z', redaction_reason = 'privacy'
     WHERE event_id IN (SELECT id FROM events WHERE problem_id = ?
       AND type IN ('claim.created', 'review.created'))`,
    )
      .bind("P-DISC-A")
      .run();
    assert.deepEqual(
      (
        await env.DB.prepare(
          "SELECT id, seq, chain_digest FROM events WHERE problem_id = ? ORDER BY seq",
        )
          .bind("P-DISC-A")
          .all()
      ).results,
      envelopeBefore.results,
    );
    // The unsafe copies really remain; a pass cannot come from deleting the fixture.
    assert.ok(
      (
        await env.DB.prepare("SELECT statement FROM claims WHERE problem_id = ? AND id = 'C-1'")
          .bind("P-DISC-A")
          .first()
      ).statement.includes(redactedClaimText),
    );
    assert.ok(
      (
        await env.DB.prepare(
          "SELECT statement FROM public_claim_fts WHERE problem_id = ? AND claim_id = 'C-1'",
        )
          .bind("P-DISC-A")
          .first()
      ).statement.includes(redactedClaimText),
    );
    const redactionFailures = [];
    for (const path of publicReadPaths) {
      const response = await worker.fetch(`${origin}${path}`, {
        headers: { "User-Agent": userAgent, "if-none-match": beforeRedaction.get(path).etag },
      });
      if (response.status === 304) redactionFailures.push(`${path}: stale conditional response`);
      assert.equal(response.status, 200, `${path}: redaction must return a successful fresh face`);
      const etag = response.headers.get("etag");
      assert.ok(etag, path);
      assert.notEqual(etag, beforeRedaction.get(path).etag, path);
      const body = await response.text();
      if (path === "/p/P-DISC-A.json") {
        const face = JSON.parse(body);
        assert.equal(face.items.length, 0);
        assert.ok(face.omitted.some((item) => item.reason === "content_unavailable"));
      }
      if (body.includes(redactedClaimText)) redactionFailures.push(`${path}: retained claim text`);
      if (path === "/a/discovery-reviewer.json" && response.status === 200) {
        const card = JSON.parse(body);
        if (card.reviews.some((review) => review.problem_id === "P-DISC-A"))
          redactionFailures.push(`${path}: retained review text`);
        assert.ok(card.reviews.some((review) => review.problem_id === "P-DISC-B"));
      }
      if (path === "/a/discovery-author.json" && response.status === 200)
        assert.ok(body.includes(survivingClaimText));
      const unchanged = await worker.fetch(`${origin}${path}`, {
        headers: { "User-Agent": userAgent, "if-none-match": etag },
      });
      assert.equal(unchanged.status, 304, `${path}: fresh validator remains usable`);
      assert.equal(await unchanged.text(), "");
    }
    for (const profile of [
      "hello",
      "orient",
      "working",
      "claim",
      "review",
      "digest",
      "graveyard",
      "literature",
      "formal",
      "review-queue",
      "claim-graph",
      "full",
    ]) {
      const pack = await call(
        `/v1/sessions/${redactionSession.session_id}/pack?profile=${profile}`,
        undefined,
        redactionReader,
      );
      if (JSON.stringify(pack).includes(redactedClaimText))
        redactionFailures.push(`pack:${profile}: retained claim text`);
      if (profile !== "hello") {
        assert.ok(
          pack.omitted.some(
            (item) =>
              item.reason === "content_unavailable" &&
              item.detail === (profile === "review-queue" ? "eligible-reviews:C-1@1" : "claims"),
          ),
        );
      }
    }
    const redactedTarget = await worker.fetch(`${origin}${targetRedactionPath}`, {
      headers: {
        "User-Agent": userAgent,
        authorization: `Bearer ${redactionReader}`,
        "if-none-match": originalTarget.headers.get("etag"),
      },
    });
    assert.equal(redactedTarget.status, 200);
    assert.notEqual(redactedTarget.headers.get("etag"), originalTarget.headers.get("etag"));
    const redactedTargetPack = PackResponseSchema.parse(await redactedTarget.json());
    assert.ok(
      redactedTargetPack.omitted.some(
        (item) => item.reason === "content_unavailable" && item.detail === "C-1@1",
      ),
    );
    assert.ok(redactedTargetPack.items.every((item) => !item.kind.startsWith("claim-")));
    assert.ok(JSON.stringify(await call("/p/P-DISC-B.json")).includes(survivingClaimText));
    assert.deepEqual(
      redactionFailures,
      [],
      "redacted content must not return through public projections",
    );
    // Lawful redaction preserves the digest. Real D1 must reject a rewrite;
    // malformed legacy-source reads are exercised separately on the SQL seam.
    await assert.rejects(
      env.DB.prepare(`UPDATE event_content SET payload_sha256 = ?
    WHERE event_id IN (SELECT id FROM events WHERE problem_id = 'P-DISC-B'
      AND type IN ('claim.created', 'review.created'))`)
        .bind("0".repeat(64))
        .run(),
      /KRATER_CONTENT_REDACTION_INVALID/,
    );
    const survivingSession = await call(
      "/v1/sessions",
      { problem_id: "P-DISC-B", intent: "review" },
      redactionReader,
      201,
    );
    const survivingPack = await call(
      `/v1/sessions/${survivingSession.session_id}/pack?profile=working`,
      undefined,
      redactionReader,
    );
    assert.ok(JSON.stringify(survivingPack).includes(survivingClaimText));
    assert.ok(!survivingPack.omitted.some((item) => item.reason === "content_unavailable"));
    console.log(
      JSON.stringify({
        stage: "retained-projection-redaction",
        status: "pass",
        public_faces: publicReadPaths.length,
        pack_profiles: 12,
      }),
    );
    // The promotion/index producer keeps these characters. Query escaping must
    // preserve them too, while Boolean-looking words remain ordinary literals.
    let literalSearchReads = 0;
    for (const q of ["𝑥", "𝑧", "ℕ", "2²", "ﬁeld", "AND", "OR", "NOT", "NEAR"]) {
      for (const suffix of ["", ".json", ".md"]) {
        const url = `${origin}/search${suffix}?${new URLSearchParams({ q, kind: "claim" })}`;
        const response = await worker.fetch(url, { headers: { "User-Agent": userAgent } });
        assert.equal(response.status, 200);
        const body = await response.text();
        assert.ok(
          body.includes("https://asimposium.org/p/P-DISC-B#C-1"),
          `${q}: literal source excerpt must find its claim`,
        );
        assert.ok(!body.includes(redactedClaimText));
        assert.ok(!body.includes(privateCanary));
        if (suffix !== ".json") {
          assert.ok(body.includes("Query text and result excerpts are untrusted data"));
          assert.ok(!body.includes("<!-- asimp:item"));
          assert.ok(!body.includes("<script>"));
          assert.ok(!body.includes("](javascript:"));
        }
        if (suffix === ".json") {
          const result = JSON.parse(body);
          assert.deepEqual(
            result.items.map((item) => [item.problem_id, item.id]),
            [["P-DISC-B", "C-1"]],
          );
          assert.equal(result.items[0].match_type, "lexical_fts");
          assert.ok(result.items[0].statement.includes(literalSearchText));
        }
        const repeated = await worker.fetch(url, {
          headers: { "User-Agent": userAgent, "if-none-match": response.headers.get("etag") },
        });
        assert.equal(repeated.status, 304);
        literalSearchReads += 1;
      }
    }
    for (const q of [
      // The retained XSS canary legitimately contains src=x; z has no such
      // independent occurrence, so this negative isolates compatibility folding.
      "Symbols z",
      "Symbols N",
      "Symbols 22",
      "Symbols field",
      "Symbols OR absentcanary",
      "Symbols NOT absentcanary",
    ]) {
      const result = await call(`/search.json?${new URLSearchParams({ q, kind: "claim" })}`);
      assert.deepEqual(
        result.items.map((item) => [item.problem_id, item.id]),
        [],
        `${q}: no compatibility alias or executed Boolean operator`,
      );
    }
    console.log(JSON.stringify({ stage: "literal-scientific-search", literalSearchReads }));
    // Exercise actual D1 read failures without deleting rows or mocking a binding.
    // Restore each table in finally, then prove the healthy body/ETag returns.
    let unavailableReads = 0;
    let exactFallbackReads = 0;
    for (const [table, q, kind] of [
      ["public_cursor", "Synthetic", "claim"],
      ["claims", "Synthetic", "claim"],
      ["public_claim_fts", "Synthetic", "claim"],
      ["problems", "DISC", "problem"],
      ["enrollment_fellows", "discovery", "fellow"],
    ]) {
      const suffixes = ["", ".json", ".md"];
      const healthy = new Map();
      for (const suffix of suffixes) {
        const path = `/search${suffix}?${new URLSearchParams({ q, kind })}`;
        const response = await worker.fetch(`${origin}${path}`, {
          headers: { "User-Agent": userAgent },
        });
        assert.equal(response.status, 200, path);
        const body = await response.text();
        assert.ok(!body.includes("No public ledger objects matched"), path);
        if (suffix === ".json") {
          const search = JSON.parse(body);
          assert.ok(search.items.length > 0, path);
          assert.ok(search.source_cursor > 0, path);
        }
        assert.ok(response.headers.get("etag"), path);
        healthy.set(path, { body, etag: response.headers.get("etag") });
      }
      await env.DB.prepare(`ALTER TABLE ${table} RENAME TO retained_search_source`).run();
      try {
        for (const [path, previous] of healthy) {
          for (const method of ["GET", "HEAD"]) {
            const response = await worker.fetch(`${origin}${path}`, {
              method,
              headers: { "User-Agent": userAgent, "if-none-match": previous.etag },
            });
            assert.equal(response.status, 503, `${table}: ${method} ${path}`);
            assert.equal(response.headers.get("cache-control"), "no-store");
            assert.equal(response.headers.get("etag"), null);
            const body = await response.text();
            if (method === "HEAD") assert.equal(body, "");
            else {
              assert.equal(JSON.parse(body).code, "INTERNAL_ERROR");
              assert.ok(!body.includes("retained_search_source"));
              assert.ok(!body.includes("no such table"));
              assert.ok(!body.includes(q));
            }
            unavailableReads += 1;
          }
        }
        if (table === "public_claim_fts") {
          for (const suffix of suffixes) {
            for (const method of ["GET", "HEAD"]) {
              const response = await worker.fetch(
                `${origin}/search${suffix}?q=P-DISC-B%23C-1&kind=claim`,
                { method, headers: { "User-Agent": userAgent, "if-none-match": "*" } },
              );
              assert.equal(response.status, 200, "exact lookup survives lexical outage");
              assert.equal(response.headers.get("cache-control"), "no-store");
              const body = await response.text();
              if (method === "HEAD") assert.equal(body, "");
              else {
                assert.ok(body.includes("lexical_search_unavailable"));
                assert.ok(body.includes(survivingClaimText));
                assert.ok(!body.includes(redactedClaimText));
                if (suffix === ".json") {
                  const search = JSON.parse(body);
                  assert.equal(search.items.length, 1);
                  assert.equal(search.items[0].match_type, "exact_reference");
                }
              }
              exactFallbackReads += 1;
            }
          }
        }
      } finally {
        await env.DB.prepare(`ALTER TABLE retained_search_source RENAME TO ${table}`).run();
      }
      for (const [path, previous] of healthy) {
        const response = await worker.fetch(`${origin}${path}`, {
          headers: { "User-Agent": userAgent },
        });
        assert.equal(response.status, 200, `${table}: recovered ${path}`);
        assert.equal(await response.text(), previous.body);
        assert.equal(response.headers.get("etag"), previous.etag);
        const unchanged = await worker.fetch(`${origin}${path}`, {
          headers: { "User-Agent": userAgent, "if-none-match": previous.etag },
        });
        assert.equal(unchanged.status, 304);
      }
    }
    console.log(
      JSON.stringify({ stage: "search-failure-recovery", unavailableReads, exactFallbackReads }),
    );
    async function verifyQuotaRaces() {
      for (const dimension of ["fellow", "sponsor"]) {
        const problem = dimension === "fellow" ? "P-QUOTA-FELLOW" : "P-QUOTA-SPONSOR";
        const sponsor = `usr_quota_${dimension}`;
        const limit = dimension === "fellow" ? 20 : 21;
        const actors = [];
        await fixtures.seedProblem(problem);
        for (let index = 0; index < (dimension === "fellow" ? 1 : 2); index++) {
          const token = await enroll(`quota-${dimension}-${index}`, sponsor);
          const hello = await call("/v1/hello", undefined, token);
          const session = await call(
            "/v1/sessions",
            { problem_id: problem, intent: "prove" },
            token,
            201,
          );
          actors.push({ token, fellowId: hello.fellow.fellow_id, sessionId: session.session_id });
        }
        // These are real durable admission reservations representing uncertain
        // prior attempts. They are not presented as paid classifier calls.
        for (let index = 0; index < limit - 1; index++) {
          const actor = actors[Math.floor(index / 19)];
          const reserved = await fixtures.reserveQuota({
            fellowId: actor.fellowId,
            sponsorId: sponsor,
            sessionId: actor.sessionId,
            problemId: problem,
            route: "/v1/sessions/{id}/promote",
            idempotencyKey: `prior-${dimension}-${index}`,
            requestDigest: createHash("sha256").update(`prior-${dimension}-${index}`).digest("hex"),
          });
          assert.equal(reserved.allowed, true, "Prior admission must actually reserve capacity");
        }
        const contenders = dimension === "fellow" ? [actors[0], actors[0]] : [actors[0], actors[1]];
        for (const actor of actors) {
          const pack = await call(
            `/v1/sessions/${actor.sessionId}/pack?profile=working`,
            undefined,
            actor.token,
          );
          assert.ok(
            pack.next_actions.some((action) => action.url.endsWith("/promote")),
            "last available slot remains offered",
          );
        }
        const beforeCalls = await fixtures.screeningCalls();
        const requests = await Promise.all(
          contenders.map(async (actor, index) => {
            const draft = await call(
              `/v1/sessions/${actor.sessionId}/workshop`,
              {
                type: "draft",
                title: "Quota contender",
                body_md: "Synthetic quota work product.",
                relates_to: [],
              },
              actor.token,
              201,
            );
            return {
              actor,
              key: `last-${dimension}-${index}`,
              body: PromoteRequestSchema.parse({
                workshop_id: draft.workshop_id,
                kind: "conjecture",
                statement: `Synthetic ${dimension} quota contender ${index}: integer two is even.`,
                falsifier: "An integer remainder of one after division by two.",
                relates_to: [],
              }),
            };
          }),
        );
        const send = (request) =>
          worker.fetch(`${origin}/v1/sessions/${request.actor.sessionId}/promote`, {
            method: "POST",
            headers: {
              "User-Agent": userAgent,
              authorization: `Bearer ${request.actor.token}`,
              "content-type": "application/json",
              "idempotency-key": request.key,
            },
            body: JSON.stringify(request.body),
          });
        const responses = await Promise.all(requests.map(send));
        if (responses.some((response) => response.status >= 500)) {
          const state = await env.DB.prepare(
            `SELECT status, COUNT(*) AS n FROM public_write_attempt_reservations WHERE problem_id = ? GROUP BY status`,
          )
            .bind(problem)
            .all();
          console.log(
            JSON.stringify({
              stage: "quota-failure-state",
              classifier_calls: (await fixtures.screeningCalls()) - beforeCalls,
              reservations: state.results,
            }),
          );
          // Runtime messages may contain credentials; expose only source frames
          // and fixed, known constraint names from this fixture's failure.
          for (const log of server.getLogs().filter((entry) => entry.level === "error")) {
            console.log(
              JSON.stringify({
                stage: "quota-runtime-failure",
                frames: [
                  ...log.message.matchAll(/\bat ([A-Za-z0-9_.$<>]+) \([^\n]*:(\d+):(\d+)\)/g),
                ].map((match) => `${match[1]}:${match[2]}:${match[3]}`),
                constraints: [
                  "PROMOTION_RATE_LIMIT_EXCEEDED",
                  "RESERVATION_IMMUTABLE",
                  "SETTLED_RESERVATION_IMMUTABLE",
                  "SYNTHETIC_PUBLICATION_STORAGE_FAILURE",
                  "FOREIGN KEY",
                  "NOT NULL",
                  "UNIQUE",
                  "no such table",
                  "no such column",
                  "CHECK constraint",
                  "Too many",
                  "D1_TYPE_ERROR",
                ].filter((code) => log.message.includes(code)),
              }),
            );
          }
        }
        const diagnoses = await Promise.all(
          responses.map(async (response) => {
            try {
              const body = await response.clone().json();
              return `${response.status}:${body.code ?? "none"}`;
            } catch {
              return `${response.status}:non-JSON`;
            }
          }),
        );
        assert.deepEqual(
          responses.map((response) => response.status).sort(),
          [201, 429],
          `${dimension} last-slot outcomes: ${diagnoses.join(", ")}`,
        );
        assert.equal(await fixtures.screeningCalls(), beforeCalls + 1);
        const winner = responses.findIndex((response) => response.status === 201);
        const original = await responses[winner].json();
        const refusal = responses[1 - winner];
        const refusedBody = await refusal.json();
        assert.equal(refusedBody.code, "PROMOTION_RATE_LIMITED");
        assert.equal(refusedBody.limit, limit);
        assert.equal(refusedBody.remaining, 0);
        assert.equal(refusal.headers.get("ratelimit-limit"), String(limit));
        assert.equal(refusal.headers.get("ratelimit-remaining"), "0");
        assert.ok(Number(refusal.headers.get("retry-after")) > 0);
        const replay = await send(requests[winner]);
        assert.equal(replay.status, 200);
        assert.deepEqual(await replay.json(), original);
        assert.equal(await fixtures.screeningCalls(), beforeCalls + 1);
        const counts = await env.DB.prepare(`SELECT
        (SELECT COUNT(*) FROM public_write_attempt_reservations WHERE problem_id = ?) AS attempts,
        (SELECT COUNT(*) FROM events WHERE problem_id = ?) AS events,
        (SELECT COUNT(*) FROM claims WHERE problem_id = ?) AS claims`)
          .bind(problem, problem, problem)
          .first();
        assert.deepEqual(counts, { attempts: limit, events: 1, claims: 1 });
        for (const actor of actors) {
          const pack = PackResponseSchema.parse(
            await call(
              `/v1/sessions/${actor.sessionId}/pack?profile=working`,
              undefined,
              actor.token,
            ),
          );
          assert.equal(
            pack.next_actions.some((action) => action.url.endsWith("/promote")),
            false,
          );
          assert.ok(pack.next_actions.some((action) => action.url.endsWith("/workshop")));
          assert.ok(pack.omitted.some((item) => item.reason === "promotion_rate_limited"));
          assert.ok(pack.promotion_budget.retry_after_seconds > 0);
          if (dimension === "sponsor") assert.equal(pack.promotion_budget.sponsor_remaining, 0);
        }
        console.log(
          JSON.stringify({
            stage: "real-d1-quota-pack-actions",
            dimension,
            before: "promotion-offered",
            exhausted: "workshop-only",
          }),
        );
        // Reload the actual Worker isolate, retaining D1. Its module-local
        // classifier counter must reset; durable replay and budgets must not.
        await server.update((options) => ({
          ...options,
          workers: options.workers.map((entry) => ({
            ...entry,
            config: {
              ...entry.config,
              vars: { ...entry.config.vars, QUOTA_TEST_RELOAD: dimension },
            },
          })),
        }));
        fixtures = await worker.getExport();
        env = await worker.getEnv();
        assert.equal(await fixtures.screeningCalls(), 0, "Worker module state must restart");
        const restartedReplay = await send(requests[winner]);
        assert.equal(restartedReplay.status, 200);
        assert.deepEqual(await restartedReplay.json(), original);
        const restartedRefusal = await send(requests[1 - winner]);
        assert.equal(restartedRefusal.status, 429);
        assert.equal(await fixtures.screeningCalls(), 0);
        const retained = await env.DB.prepare(
          "SELECT COUNT(*) AS attempts FROM public_write_attempt_reservations WHERE problem_id = ?",
        )
          .bind(problem)
          .first();
        assert.equal(retained.attempts, limit);
        const latest = await env.DB.prepare(
          "SELECT MAX(reserved_at) AS reserved_at FROM public_write_attempt_reservations WHERE problem_id = ?",
        )
          .bind(problem)
          .first();
        // Exercise the production reservation function against retained D1 with
        // its explicit clock input. This is store-level time control, not a
        // claim that the mounted HTTP path has waited an hour.
        for (const [index, actor] of actors.entries()) {
          const recovered = await fixtures.reserveQuota({
            fellowId: actor.fellowId,
            sponsorId: sponsor,
            sessionId: actor.sessionId,
            problemId: problem,
            route: "/v1/sessions/{id}/promote",
            idempotencyKey: `recovery-${dimension}-${index}`,
            requestDigest: createHash("sha256")
              .update(`recovery-${dimension}-${index}`)
              .digest("hex"),
            now: latest.reserved_at + 60001,
          });
          assert.equal(recovered.allowed, false, "Uncertain expired attempts must remain charged");
          assert.equal(recovered.reason, "RATE_LIMITED");
        }
        const recoveredCount = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM public_write_attempt_reservations WHERE problem_id = ? AND status = 'recovered'",
        )
          .bind(problem)
          .first();
        assert.equal(recoveredCount.n, limit - 1);
        const actor = actors[0];
        const refilled = await fixtures.reserveQuota({
          fellowId: actor.fellowId,
          sponsorId: sponsor,
          sessionId: actor.sessionId,
          problemId: problem,
          route: "/v1/sessions/{id}/promote",
          idempotencyKey: `refill-${dimension}`,
          requestDigest: createHash("sha256").update(`refill-${dimension}`).digest("hex"),
          now: latest.reserved_at + 3600000,
        });
        assert.equal(refilled.allowed, true, "Capacity must refill at the rolling-window boundary");
        assert.equal(refilled.budget.remaining, 19);
        assert.equal(refilled.budget.sponsor_remaining, 20);
        assert.equal(await fixtures.screeningCalls(), 0);
        console.log(
          JSON.stringify({
            stage: "real-d1-quota-last-slot",
            dimension,
            synthetic_prior_reservations: limit - 1,
            contenders: 2,
            published: 1,
            classifier_calls: 1,
            replay_charges: 0,
            worker_reload_replay: "pass",
            worker_reload_exhaustion: "pass",
            d1_expiry_retains_charge: "pass",
            d1_clock_controlled_refill: "pass",
          }),
        );
      }
      const refillProblem = "P-QUOTA-REFILL";
      await fixtures.seedProblem(refillProblem);
      const refillToken = await enroll("quota-refill", "usr_quota_refill");
      const refillHello = await call("/v1/hello", undefined, refillToken);
      const refillSession = await call(
        "/v1/sessions",
        {
          problem_id: refillProblem,
          intent: "prove",
        },
        refillToken,
        201,
      );
      const refillDraft = await call(
        `/v1/sessions/${refillSession.session_id}/workshop`,
        {
          type: "draft",
          title: "Refill after restart",
          body_md: "Synthetic historical attempts.",
          relates_to: [],
        },
        refillToken,
        201,
      );
      const historicalTime = Date.now() - 3601000;
      const refillParams = {
        fellowId: refillHello.fellow.fellow_id,
        sponsorId: "usr_quota_refill",
        sessionId: refillSession.session_id,
        problemId: refillProblem,
        route: "promote",
        requestDigest: createHash("sha256").update("historical-refill-attempt").digest("hex"),
      };
      for (let index = 0; index < 20; index++) {
        const admitted = await fixtures.reserveQuota({
          ...refillParams,
          idempotencyKey: `historical-${index}`,
          now: historicalTime,
        });
        assert.equal(admitted.allowed, true);
      }
      const beforeBoundary = await fixtures.reserveQuota({
        ...refillParams,
        idempotencyKey: "before-refill",
        now: historicalTime + 3599999,
      });
      assert.equal(beforeBoundary.allowed, false);
      await server.update((options) => ({
        ...options,
        workers: options.workers.map((entry) => ({
          ...entry,
          config: {
            ...entry.config,
            vars: { ...entry.config.vars, QUOTA_TEST_RELOAD: "refill" },
          },
        })),
      }));
      fixtures = await worker.getExport();
      env = await worker.getEnv();
      assert.equal(await fixtures.screeningCalls(), 0);
      await call(
        `/v1/sessions/${refillSession.session_id}/promote`,
        {
          workshop_id: refillDraft.workshop_id,
          kind: "conjecture",
          statement: "Integer two is even.",
          falsifier: "An odd remainder after division by two.",
          relates_to: [],
        },
        refillToken,
        201,
      );
      assert.equal(await fixtures.screeningCalls(), 1);
      const refillEffects = await env.DB.prepare(`SELECT
        (SELECT COUNT(*) FROM public_write_attempt_reservations WHERE problem_id = ? AND status = 'recovered') AS recovered,
        (SELECT COUNT(*) FROM events WHERE problem_id = ?) AS events`)
        .bind(refillProblem, refillProblem)
        .first();
      assert.deepEqual(refillEffects, { recovered: 20, events: 1 });
      console.log(
        JSON.stringify({
          stage: "real-d1-quota-mounted-refill",
          historical_attempts: 20,
          before_boundary: "refused",
          after_reload: "published",
          classifier_calls: 1,
          clock_boundary: "historical fixture reservations; HTTP uses actual Worker time",
        }),
      );
      const sameKeyProblem = "P-QUOTA-SAME-KEY";
      await fixtures.seedProblem(sameKeyProblem);
      const sameKeyToken = await enroll("quota-same-key", "usr_quota_same_key");
      const sameKeySession = await call(
        "/v1/sessions",
        {
          problem_id: sameKeyProblem,
          intent: "prove",
        },
        sameKeyToken,
        201,
      );
      const sameKeyDraft = await call(
        `/v1/sessions/${sameKeySession.session_id}/workshop`,
        {
          type: "draft",
          title: "Same caller key",
          body_md: "Synthetic concurrent admission.",
          relates_to: [],
        },
        sameKeyToken,
        201,
      );
      const sendSameKey = () =>
        worker.fetch(`${origin}/v1/sessions/${sameKeySession.session_id}/promote`, {
          method: "POST",
          headers: {
            "User-Agent": userAgent,
            authorization: `Bearer ${sameKeyToken}`,
            "content-type": "application/json",
            "idempotency-key": "same-key-screening",
          },
          body: JSON.stringify({
            workshop_id: sameKeyDraft.workshop_id,
            kind: "conjecture",
            statement: "Integer two is even.",
            falsifier: "An odd remainder after division by two.",
            relates_to: [],
          }),
        });
      const initialCalls = await fixtures.screeningCalls();
      await fixtures.pauseScreening();
      const firstPending = sendSameKey();
      try {
        const deadline = Date.now() + 5000;
        while ((await fixtures.screeningCalls()) === initialCalls && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.equal(await fixtures.screeningCalls(), initialCalls + 1);
        const duplicates = await Promise.all(Array.from({ length: 4 }, sendSameKey));
        assert.deepEqual(
          duplicates.map((response) => response.status),
          [409, 409, 409, 409],
        );
        assert.equal(await fixtures.screeningCalls(), initialCalls + 1);
      } finally {
        await fixtures.resumeScreening();
      }
      const firstPublished = await firstPending;
      assert.equal(firstPublished.status, 201);
      const sameKeyReplay = await sendSameKey();
      assert.equal(sameKeyReplay.status, 200);
      assert.deepEqual(await sameKeyReplay.json(), await firstPublished.json());
      const sameKeyEffects = await env.DB.prepare(`SELECT
        (SELECT COUNT(*) FROM public_write_attempt_reservations WHERE problem_id = ?) AS attempts,
        (SELECT COUNT(*) FROM events WHERE problem_id = ?) AS events`)
        .bind(sameKeyProblem, sameKeyProblem)
        .first();
      assert.deepEqual(sameKeyEffects, { attempts: 1, events: 1 });
      assert.equal(await fixtures.screeningCalls(), initialCalls + 1);
      const sameKeyHello = await call("/v1/hello", undefined, sameKeyToken);
      const freshReservation = {
        fellowId: sameKeyHello.fellow.fellow_id,
        sponsorId: "usr_quota_same_key",
        sessionId: sameKeySession.session_id,
        problemId: sameKeyProblem,
        route: "promote",
        idempotencyKey: "simultaneous-new-key",
        requestDigest: createHash("sha256").update("simultaneous-new-key").digest("hex"),
      };
      const admissions = await Promise.all([
        fixtures.reserveQuota(freshReservation),
        fixtures.reserveQuota(freshReservation),
      ]);
      assert.deepEqual(admissions.map((result) => result.allowed).sort(), [false, true]);
      console.log(
        JSON.stringify({
          stage: "real-d1-quota-same-key",
          concurrent_retries: 4,
          classifier_calls: 1,
          reservations: 1,
          public_events: 1,
          completed_replay: "pass",
        }),
      );
      const problem = "P-QUOTA-OUTAGE";
      await fixtures.seedProblem(problem);
      const token = await enroll("quota-outage", "usr_quota_outage");
      const session = await call(
        "/v1/sessions",
        { problem_id: problem, intent: "prove" },
        token,
        201,
      );
      const draft = await call(
        `/v1/sessions/${session.session_id}/workshop`,
        {
          type: "draft",
          title: "Quota storage outage",
          body_md: "Synthetic failure case.",
          relates_to: [],
        },
        token,
        201,
      );
      // A scoped real D1 write failure; do not remove the trigger or affect
      // unrelated positive flows that run after this quota proof.
      await env.DB.prepare(`CREATE TRIGGER synthetic_quota_storage_failure
        BEFORE INSERT ON public_write_attempt_reservations
        WHEN NEW.problem_id = 'P-QUOTA-OUTAGE'
        BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_QUOTA_STORAGE_UNAVAILABLE'); END`).run();
      const before = await fixtures.screeningCalls();
      const failed = await worker.fetch(`${origin}/v1/sessions/${session.session_id}/promote`, {
        method: "POST",
        headers: {
          "User-Agent": userAgent,
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": "quota-outage-promotion",
        },
        body: JSON.stringify({
          workshop_id: draft.workshop_id,
          kind: "conjecture",
          statement: "Integer two is even.",
          falsifier: "An odd remainder after division by two.",
          relates_to: [],
        }),
      });
      assert.equal(failed.status, 500);
      assert.equal((await failed.json()).code, "INTERNAL_ERROR");
      assert.equal(await fixtures.screeningCalls(), before);
      const effects = await env.DB.prepare(`SELECT
        (SELECT COUNT(*) FROM public_write_attempt_reservations WHERE problem_id = ?) AS attempts,
        (SELECT COUNT(*) FROM events WHERE problem_id = ?) AS events,
        (SELECT COUNT(*) FROM claims WHERE problem_id = ?) AS claims`)
        .bind(problem, problem, problem)
        .first();
      assert.deepEqual(effects, { attempts: 0, events: 0, claims: 0 });
      await call("/v1/hello", undefined, token);
      await call(
        `/v1/sessions/${session.session_id}/workshop`,
        {
          type: "draft",
          title: "Continue during outage",
          body_md: "Private work remains available.",
          relates_to: [],
        },
        token,
        201,
      );
      console.log(
        JSON.stringify({
          stage: "real-d1-quota-storage-failure",
          classifier_calls: 0,
          public_events: 0,
          authenticated_hello: "pass",
          private_workshop: "pass",
        }),
      );
    }
    console.log(
      JSON.stringify({
        kind: "discovery-real-bindings",
        status: "pass",
        runtime: `node ${process.version}`,
        public_events: rawEvents.results.length,
        private_r2_objects: privateObjects.objects.length,
        screening_refusals: 0,
        screening_mode: screenMode,
        boundary:
          "local Workerd/D1/R2; fixture classifier and sponsor setup; no staging, OAuth or live-model claim",
      }),
    );
  }
}

try {
  await runDiscovery();
} finally {
  await server.close();
}
