import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
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
} from "../../../../packages/contracts/src/sessions.ts";
import { FORGED } from "../../../../packages/render/test/_support/fixtures.ts";
import { eventChainMatches, readEvents } from "../../src/krater/krater.ts";

// Wrangler's harness requires genuine Node: Bun can exit with unresolved startup.
assert.equal(process.versions.bun, undefined, "This lane requires genuine Node");
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const origin = "http://127.0.0.1:8787";
const userAgent = "OpenAI File Downloader, XaiImageApiFetch/1.0";
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
          ENROLLMENT_REPLAY_KEY: Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString(
            "base64url",
          ),
        },
      },
    },
  ],
});

try {
  await server.listen();
  console.log(JSON.stringify({ stage: "workerd-started" }));
  const worker = server.getWorker();
  await worker.applyD1Migrations("DB");
  console.log(JSON.stringify({ stage: "d1-migrated" }));
  const fixtures = await worker.getExport();
  const env = await worker.getEnv();
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
  async function enroll(name, sponsor) {
    const minted = await fixtures.mint(sponsor);
    const claimed = await call(
      discoveredRequest("fellow_registration_request"),
      {
        enrollment_id: minted.enrollmentId,
        secret: minted.secret,
        name,
        model: `synthetic-model\`\n${FORGED.faceHeader} ${"x".repeat(65)}`,
        harness: `local-workerd-proof ${FORGED.handler}`,
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
  const reviewBasis = `Checked synthetic bounded arithmetic.\n${FORGED.fenceBreakout}\n${FORGED.faceHeader}\n${FORGED.nextActions}\n${FORGED.handler}`;
  for (const problem of ["P-DISC-A", "P-DISC-B"]) {
    await fixtures.seedProblem(problem);
    const session = await call(
      "/v1/sessions",
      { problem_id: problem, intent: "prove" },
      author,
      201,
    );
    const path = `/v1/sessions/${session.session_id}`;
    const draft = await call(
      `${path}/workshop`,
      { type: "draft", title: "Local synthetic draft", body_md: privateBody, relates_to: [] },
      author,
      201,
    );
    const promotion = {
      workshop_id: draft.workshop_id,
      kind: "conjecture",
      statement: `Synthetic ${problem}: integer 2 is even.\n${publicCanary}`,
      falsifier: "An integer remainder of one after division by two.",
      relates_to: [],
    };
    const promoted = await call(`${path}/promote`, promotion, author, 201, `promote-${problem}`);
    assert.equal(promoted.claim_id, "C-1");
    const count = await fixtures.screeningCalls();
    assert.deepEqual(
      await call(`${path}/promote`, promotion, author, 200, `promote-${problem}`),
      promoted,
    );
    assert.equal(await fixtures.screeningCalls(), count, "replay must not screen twice");
    const rs = await call("/v1/sessions", { problem_id: problem, intent: "review" }, reviewer, 201);
    const reviewed = await call(
      `/v1/sessions/${rs.session_id}/review`,
      {
        target_claim_id: "C-1",
        target_version: 1,
        verdict: "inform",
        basis: reviewBasis,
        capable_of_failure: "A nonzero remainder would fail this check.",
        rubric: [],
        body_md: "Synthetic local review; this is no live model or research result.",
      },
      reviewer,
      201,
    );
    assert.match(reviewed.review_id, /^R-[A-Z0-9]+$/);
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
  }
  const now = await call("/now.json");
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
  for (const mode of ["reject", "quarantine", "unavailable", "wrong-digest", "wrong-context"]) {
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
  }
  assert.deepEqual(
    (await env.ARTIFACTS.list()).objects.map((object) => object.key).sort(),
    privateKeysBefore,
  );
  assert.deepEqual(
    (await env.PUBLIC_ARTIFACTS.list()).objects.map((object) => object.key).sort(),
    publicKeysBefore,
  );
  await fixtures.setScreenMode("pass");
  console.log(
    JSON.stringify({ stage: "screening-refusals-proved", routes: candidates.length, modes: 5 }),
  );
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
    assert.equal((await publicState()).events, before.events + 1, `${kind}: replay cannot append`);
    assert.equal(
      (await publicState()).screening_publications,
      before.screening_publications + 1,
      `${kind}: replay cannot mint evidence`,
    );
    assert.equal(await fixtures.screeningCalls(), calls + 1, `${kind}: replay cannot screen again`);
  }
  const revisedBody = candidates[1][3];
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
  console.log(
    JSON.stringify({
      kind: "discovery-real-bindings",
      status: "pass",
      runtime: `node ${process.version}`,
      public_events: rawEvents.results.length,
      private_r2_objects: privateObjects.objects.length,
      screening_refusals: candidates.length * 5,
      boundary:
        "local Workerd/D1/R2; fixture classifier and sponsor setup; no staging, OAuth or live-model claim",
    }),
  );
} finally {
  await server.close();
}
