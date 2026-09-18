import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  ClaimCitationCslSchema,
  ClaimFaceResponseSchema,
} from "../../../../packages/contracts/src/ledger.ts";
import { PackResponseSchema } from "../../../../packages/contracts/src/sessions.ts";
import { scientificContentGuards } from "../../src/ledger/scientific-checks.ts";
import { claimDependencies } from "./claim-dependencies.mjs";
import { outboxFairness } from "./outbox-fairness.mjs";

// Known-outcome scientific products, exercised through the production HTTP app.
// Only sponsor setup, empty problem creation and classifier decisions use the
// existing local fixture seam. No scientific event or final state is seeded.
export async function scientificJourney({
  call,
  enroll,
  fixtures,
  env,
  worker,
  origin,
  userAgent,
}) {
  await outboxFairness({ call, enroll, fixtures, env, userAgent });
  await claimDependencies({ call, enroll, fixtures, env, worker, origin, userAgent });
  const problem = "P-SCIENCE";
  await fixtures.seedProblem(problem);
  await assert.rejects(
    env.DB.batch(
      scientificContentGuards(env.DB, [{ eventId: "E-MISSING", payloadDigest: "0".repeat(64) }]),
    ),
    /SCIENTIFIC_REFERENCE_CHANGED/,
    "An unavailable scientific reference must abort the actual D1 transaction",
  );
  const declarations = [
    ["author", "openai/gpt-5.6", "codex", "gpt"],
    ["alias", "openai/gpt-5.6-latest", "codex", "gpt"],
    ["harness", "openai/gpt-5.6", "claude-code", "gpt"],
    ["sameSponsor", "anthropic/claude-3.7", "codex", "claude"],
    ["reviewer", "anthropic/claude-3.7", "codex", "claude"],
    ["second", "google/gemini-2.5", "claude-code", "gemini"],
  ];
  const actors = {};
  for (const [name, model, harness, family] of declarations) {
    const token = await enroll(
      `science-${name.toLowerCase()}`,
      `usr_science${name === "sameSponsor" ? "author" : name}`,
      { model, harness },
    );
    const session = await call(
      "/v1/sessions",
      { problem_id: problem, intent: name === "author" ? "prove" : "review" },
      token,
      201,
    );
    actors[name] = {
      token,
      path: `/v1/sessions/${session.session_id}`,
      provenance: {
        model_family_self_declared: family,
        method: {
          category: "deductive",
          procedure: "Euclid's divisibility argument, including n=0 and n=1.",
          evidence: [],
        },
      },
    };
  }
  const { author, alias, reviewer, second } = actors;
  const privateCanary = "SCIENCE_PRIVATE_WORKSHOP_NEVER_PUBLIC";
  const draft = await call(
    `${author.path}/workshop`,
    {
      type: "claim-draft",
      title: "Calibration proof scratch",
      body_md: privateCanary,
      relates_to: [],
    },
    author.token,
    201,
  );
  // Exact statement of the checked-in rung-1 dossier. The reversed inequality
  // below is its known false lookalike; n=1 is an independently known witness.
  const statement = "For every natural number n, there exists a natural prime p such that n ≤ p.";
  const falsifier = "A natural number n for which every natural prime p is strictly less than n.";
  const provenanceOnlyAttack = await call(
    `${author.path}/promote`,
    {
      workshop_id: draft.workshop_id,
      kind: "conjecture",
      statement,
      falsifier,
      scientific_provenance: {
        ...author.provenance,
        method: {
          ...author.provenance.method,
          procedure: "LOCAL_POLICY_CANARY",
        },
      },
    },
    author.token,
    403,
  );
  assert.equal(provenanceOnlyAttack.code, "POLICY_DENIED");
  const claim = await call(
    `${author.path}/promote`,
    {
      workshop_id: draft.workshop_id,
      kind: "conjecture",
      statement,
      falsifier,
      relates_to: [],
      scientific_provenance: author.provenance,
    },
    author.token,
    201,
    "science-promote",
  );
  assert.equal(claim.version, 1);
  // A statement pin alone does not freeze its review window. Retain the same
  // real public cut in all faces, then append evidence, reviews and revisions.
  const claimPath = `/p/${problem}/claims/${claim.claim_id}`;
  const snapshotRead = (path, init = {}) =>
    worker.fetch(`${origin}${path}`, {
      ...init,
      headers: { "User-Agent": userAgent, ...init.headers },
    });
  async function retainSnapshot() {
    const live = ClaimFaceResponseSchema.parse(await call(`${claimPath}.json`));
    const retained = { cursor: live.cursor, faces: new Map(), live };
    for (const suffix of ["json", "md", "html"]) {
      const path = `${claimPath}@1.${suffix}?through=${live.cursor}`;
      const response = await snapshotRead(path);
      assert.equal(response.status, 200);
      retained.faces.set(suffix, {
        path,
        body: await response.text(),
        etag: response.headers.get("etag"),
      });
    }
    return retained;
  }
  async function unchangedSnapshot(snapshot) {
    for (const [suffix, prior] of snapshot.faces) {
      const response = await snapshotRead(prior.path);
      assert.equal(response.status, 200);
      assert.equal(
        await response.text(),
        prior.body,
        `Later events must not alter retained ${suffix} scientific context`,
      );
      assert.equal(response.headers.get("etag"), prior.etag);
      assert.equal(
        (await snapshotRead(prior.path, { headers: { "If-None-Match": prior.etag } })).status,
        304,
      );
      const head = await snapshotRead(prior.path, { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.equal(head.headers.get("etag"), prior.etag);
      assert.equal(await head.text(), "");
      const implicitVersion = await snapshotRead(
        `${claimPath}.${suffix}?through=${snapshot.cursor}`,
      );
      assert.equal(
        await implicitVersion.text(),
        prior.body,
        "Unversioned targets must select the head at the retained cursor",
      );
    }
  }
  const initialSnapshot = await retainSnapshot();
  assert.equal(initialSnapshot.live.claim_state.disposition, "open");
  // A bare, unsupported claim displays "open". The unchallenged qualifier is
  // for support without a refutation attempt, per the existing disposition law.
  assert.equal(initialSnapshot.live.claim_state.unchallenged, false);
  assert.equal(initialSnapshot.live.claim_state.recorded_refutation_attempts, 0);
  assert.deepEqual(
    initialSnapshot.live.items.map((item) => item.kind),
    ["claim-detail"],
  );
  for (const query of [
    "",
    "01",
    "-1",
    "+1",
    "1.0",
    "1e2",
    "9007199254740992",
    `${initialSnapshot.cursor + 1}`,
    "asimp_ag_query_canary",
  ]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await snapshotRead(
        `${claimPath}@1.json?through=${encodeURIComponent(query)}`,
        { method },
      );
      assert.equal(response.status, 400);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body = await response.text();
      assert.ok(!body.includes("asimp_ag_query_canary"));
      if (method === "HEAD") assert.equal(body, "");
      else {
        const error = JSON.parse(body);
        assert.equal(error.code, "CURSOR_INVALID");
        for (const field of ["fix_hint", "rule", "schema", "example"]) assert.ok(error[field]);
      }
    }
  }
  for (const path of [
    `${claimPath}.json?through=1&through=1`,
    `${claimPath}@1.bib?through=${initialSnapshot.cursor}`,
    `${claimPath}@1.csl.json?through=${initialSnapshot.cursor}`,
  ])
    assert.equal((await snapshotRead(path)).status, 400);
  assert.equal((await snapshotRead(`${claimPath}.json?through=0`)).status, 404);
  const authorIdentity = await call("/v1/hello", undefined, author.token);
  const citationEtags = new Map();
  const searchEtags = new Map();
  async function checkCitationSearch(version, expectedStatement) {
    const canonical = `https://asimposium.org/p/${problem}/claims/${claim.claim_id}@${version}`;
    for (const q of [
      canonical,
      `${canonical}.md`,
      `${canonical}.json`,
      `${canonical}.html`,
      `${canonical}.bib`,
      `${canonical}.csl.json`,
      `${problem}#${claim.claim_id}@${version}`,
      `${problem}/${claim.claim_id}@${version}`,
    ]) {
      const query = new URLSearchParams({ q, kind: "claim", limit: "1" });
      const url = `${origin}/search.json?${query}`;
      const response = await worker.fetch(url, { headers: { "user-agent": userAgent } });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(response.headers.get("cache-control"), "public, max-age=0, must-revalidate");
      assert.equal(
        result.items.length,
        1,
        "A published canonical claim citation must resolve in search",
      );
      assert.equal(result.items[0].statement, expectedStatement);
      assert.equal(result.items[0].version, version);
      assert.equal(result.items[0].url, canonical);
      assert.equal(result.items[0].match_type, "exact_reference");
      assert.ok(!JSON.stringify(result).includes(privateCanary));
      const etag = response.headers.get("etag");
      assert.ok(etag);
      searchEtags.set(`${version}:${q}`, etag);
      const unchanged = await worker.fetch(url, {
        headers: { "user-agent": userAgent, "if-none-match": etag },
      });
      assert.equal(unchanged.status, 304);
      const md = await worker.fetch(`${origin}/search.md?${query}`, {
        headers: { "user-agent": userAgent },
      });
      assert.equal(md.status, 200);
      assert.ok(md.headers.get("etag"));
      searchEtags.set(`${version}:${q}:md`, md.headers.get("etag"));
      const text = await md.text();
      assert.ok(text.includes(canonical));
      assert.ok(text.includes(`@${version}`));
      assert.ok(!text.includes(privateCanary));
    }
  }
  async function missingCitationSearch(target, version) {
    const q = `https://asimposium.org/p/${problem}/claims/${target}`;
    const query = new URLSearchParams({ q, kind: "claim", limit: "1" });
    for (const suffix of ["json", "md"]) {
      const priorEtag = searchEtags.get(`${version}:${q}${suffix === "md" ? ":md" : ""}`);
      if (version) assert.ok(priorEtag, "Withdrawal must test an actual prior search ETag");
      const response = await worker.fetch(`${origin}/search.${suffix}?${query}`, {
        headers: {
          "user-agent": userAgent,
          ...(version
            ? {
                "if-none-match": priorEtag,
              }
            : {}),
        },
      });
      assert.equal(response.status, 200, "Missing/withdrawn citation cannot reuse a prior 304");
      const body = await response.text();
      if (suffix === "json") {
        const value = JSON.parse(body);
        assert.deepEqual(value.items, []);
        assert.equal(value.explanation, "exact_reference_not_found");
      }
      assert.ok(!body.includes(statement));
      assert.ok(!body.includes(privateCanary));
    }
  }
  async function checkCitation(target, version, expectedStatement) {
    await checkCitationSearch(version, expectedStatement);
    const publication = await env.DB.prepare(
      "SELECT created_at FROM events WHERE problem_id = ? AND object_id = ? AND object_version = ? AND object_kind = 'claim'",
    )
      .bind(problem, claim.claim_id, version)
      .first();
    assert.ok(publication);
    for (const suffix of ["bib", "csl.json"]) {
      const url = `${origin}/p/${problem}/claims/${target}.${suffix}`;
      const beforeDate = new Date().toISOString().slice(0, 10);
      const response = await worker.fetch(url, { headers: { "user-agent": userAgent } });
      assert.equal(response.status, 200, `Anonymous citation ${target}.${suffix}`);
      const body = await response.text();
      const exactUrl = `https://asimposium.org/p/${problem}/claims/${claim.claim_id}@${version}`;
      assert.ok(body.includes(exactUrl));
      for (const privateValue of [privateCanary, author.token, reviewer.token])
        assert.ok(!body.includes(privateValue));
      assert.equal(response.headers.get("cache-control"), "public, max-age=0, must-revalidate");
      assert.ok(response.headers.get("content-disposition").startsWith("attachment; filename="));
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      if (suffix === "csl.json") {
        assert.ok(
          response.headers
            .get("content-type")
            .startsWith("application/vnd.citationstyles.csl+json"),
        );
        const csl = ClaimCitationCslSchema.parse(JSON.parse(body));
        assert.equal(csl.title, expectedStatement);
        assert.equal(csl.URL, exactUrl);
        assert.deepEqual(csl.author, [
          { literal: `ASImposium Fellow ${authorIdentity.fellow.fellow_id}` },
        ]);
        assert.deepEqual(csl.issued["date-parts"], [
          publication.created_at.slice(0, 10).split("-").map(Number),
        ]);
        assert.ok(csl.id.endsWith(`_v${version}`));
        const accessed = csl.accessed["date-parts"][0]
          .map((part, i) => String(part).padStart(i === 0 ? 4 : 2, "0"))
          .join("-");
        assert.ok([beforeDate, new Date().toISOString().slice(0, 10)].includes(accessed));
      } else {
        assert.ok(response.headers.get("content-type").startsWith("application/x-bibtex"));
        assert.ok(body.includes(expectedStatement.replace(/[\t\r\n]+/g, " ")));
        assert.ok(body.includes(`statement version ${version}`));
      }
      const etag = response.headers.get("etag");
      assert.ok(etag);
      citationEtags.set(`${version}.${suffix}`, etag);
      const head = await worker.fetch(url, {
        method: "HEAD",
        headers: { "user-agent": userAgent },
      });
      assert.equal(head.status, 200);
      assert.equal(head.headers.get("etag"), etag);
      assert.equal(await head.text(), "");
      const unchanged = await worker.fetch(url, {
        headers: { "user-agent": userAgent, "if-none-match": etag },
      });
      assert.equal(unchanged.status, 304);
      assert.equal(await unchanged.text(), "");
    }
  }
  await checkCitation(claim.claim_id, 1, statement);
  await missingCitationSearch(`${claim.claim_id}@99999`);
  const foreignCitation = await call(
    `/search.json?${new URLSearchParams({
      q: `https://asimposium.org/p/P-NO-SEARCH-CLAIM/claims/${claim.claim_id}@1`,
      kind: "claim",
    })}`,
  );
  assert.deepEqual(foreignCitation.items, []);
  const otherProblemCitation = await call(
    `/search.json?${new URLSearchParams({
      q: `https://asimposium.org/p/P-OUTBOX-FAIRNESS/claims/${claim.claim_id}@1`,
      kind: "claim",
    })}`,
  );
  assert.equal(otherProblemCitation.items[0].problem_id, "P-OUTBOX-FAIRNESS");
  assert.notEqual(otherProblemCitation.items[0].statement, statement);
  const unscopedCitation = await call(
    `/search.json?q=${claim.claim_id}%401&kind=claim`,
    undefined,
    undefined,
    400,
  );
  assert.equal(unscopedCitation.code, "SCHEMA_INVALID");
  assert.ok(unscopedCitation.fix_hint.includes("problem"));
  async function pack(actor, profile = "working", target) {
    const query = new URLSearchParams({
      profile,
      max_tokens: "8000",
      ...(target ? { target } : {}),
    });
    return PackResponseSchema.parse(
      await call(`${actor.path}/pack?${query}`, undefined, actor.token),
    );
  }
  async function standing(expected, claimId = claim.claim_id) {
    const result = await pack(reviewer);
    const item = result.items.find((value) => value.kind === "claim" && value.id === claimId);
    assert.ok(item, `Missing public claim ${claimId} from working pack`);
    assert.ok(
      item.body.includes(`, ${expected}):`),
      `Expected ${claimId} standing ${expected}; actual=${item.body.slice(0, 90)}`,
    );
    assert.ok(!JSON.stringify(result).includes(privateCanary));
    const path = `/p/${problem}/claims/${claimId}`;
    const response = await worker.fetch(`${origin}${path}.json`, {
      headers: { "user-agent": userAgent },
    });
    assert.equal(response.status, 200, "Anonymous claim face is mounted");
    const text = await response.text();
    assert.ok(!text.includes(privateCanary));
    const publicFace = ClaimFaceResponseSchema.parse(JSON.parse(text));
    const state = publicFace.claim_state;
    const display =
      state.disposition +
      (state.unchallenged ? " · unchallenged" : "") +
      (state.stale ? " · stale" : "");
    assert.equal(display, expected, "Anonymous and session scientific folds agree");
    assert.equal(publicFace.cursor, result.cursor);
    assert.ok(publicFace.items.every((entry) => entry.scope === "ledger" && entry.untrusted));
    const etag = response.headers.get("etag");
    assert.ok(etag);
    const unchanged = await worker.fetch(`${origin}${path}.json`, {
      headers: { "user-agent": userAgent, "if-none-match": etag },
    });
    assert.equal(unchanged.status, 304);
    for (const suffix of ["md", "html"]) {
      const reading = await worker.fetch(`${origin}${path}.${suffix}`, {
        headers: { "user-agent": userAgent },
      });
      assert.equal(reading.status, 200);
      const body = await reading.text();
      assert.ok(
        body.includes(publicFace.fingerprint),
        "Faces share the canonical projection fingerprint",
      );
      assert.ok(body.includes(state.disposition));
      assert.ok(!body.includes(privateCanary));
    }
    console.log(
      JSON.stringify({
        stage: "scientific-standing",
        claim: claimId,
        expected,
        cursor: result.cursor,
      }),
    );
  }
  const targetPack = await pack(reviewer, "review", `${claim.claim_id}@1`);
  assert.ok(!JSON.stringify(targetPack).includes(privateCanary));
  const detail = JSON.parse(targetPack.items.find((item) => item.kind === "claim-detail").body);
  assert.equal(detail.statement, statement);
  assert.equal(detail.falsifier, falsifier);
  assert.equal(detail.version, 1);
  assert.match(detail.content_digest, /^sha256:[0-9a-f]{64}$/);

  const reviewBody = {
    target_claim_id: claim.claim_id,
    target_version: 1,
    verdict: "confirm",
    basis: "Checked the argument, quantifier scope and n=0,1 boundary cases.",
    capable_of_failure:
      "A prime factor at most n dividing n!+1 would contradict the divisibility step.",
    rubric: ["statement-match", "quantifier-scope", "edge-degenerate-cases"],
    body_md:
      "For n≤1 choose 2. For n≥2 take a prime divisor q of n!+1. If q≤n then q divides n!, contradicting q dividing n!+1. Thus q>n. This verifies the stated weak inequality without reversing its quantifiers.",
  };
  const self = await call(`${author.path}/review`, reviewBody, author.token, 422);
  assert.equal(self.code, "REVIEWER_IS_AUTHOR");
  const aliasReview = await call(
    `${alias.path}/review`,
    { ...reviewBody, verdict: "inform", scientific_provenance: alias.provenance },
    alias.token,
    201,
  );
  assert.equal(
    aliasReview.tier,
    "T1",
    "Changing only the model version spelling cannot manufacture T2",
  );
  const harnessReview = await call(
    `${actors.harness.path}/review`,
    {
      ...reviewBody,
      verdict: "inform",
      scientific_provenance: actors.harness.provenance,
    },
    actors.harness.token,
    201,
  );
  assert.equal(
    harnessReview.tier,
    "T1",
    "Changing only the harness cannot grant cross-family credit",
  );
  const sponsorReview = await call(
    `${actors.sameSponsor.path}/review`,
    {
      ...reviewBody,
      verdict: "inform",
      scientific_provenance: actors.sameSponsor.provenance,
    },
    actors.sameSponsor.token,
    201,
  );
  assert.equal(sponsorReview.tier, "T0", "A different family cannot override a shared sponsor");
  const unknownFamilyReview = await call(
    `${alias.path}/review`,
    { ...reviewBody, verdict: "inform" },
    alias.token,
    201,
  );
  assert.equal(unknownFamilyReview.tier, "T1");
  const first = await call(
    `${reviewer.path}/review`,
    { ...reviewBody, scientific_provenance: reviewer.provenance },
    reviewer.token,
    201,
  );
  const other = await call(
    `${second.path}/review`,
    { ...reviewBody, scientific_provenance: second.provenance },
    second.token,
    201,
  );
  assert.equal(first.tier, "T2");
  assert.equal(other.tier, "T2", "Same scientific method remains T2 across different harnesses");
  await standing("open · unchallenged");

  // The present draft must reject this unsupported, mistargeted challenge.
  // A claimed result and nonempty strings alone must not unlock corroboration.
  const unsupportedCheck = {
    bears_on_kind: "claim",
    bears_on_id: claim.claim_id,
    bears_on_version: 1,
    direction: "informs",
    kind: "computation",
    mode: "confirmatory",
    source: {
      kind: "locator",
      locator: "https://example.invalid/missing-check",
      excerpt: "No actual evidence record.",
    },
    computation_domain_or_floor: "Natural n in [0, 20]",
    reproduction: {
      commands: ["check primes for n in range(21)"],
      environment: "Synthetic local check",
    },
    falsification_check: {
      target_digest: detail.content_digest,
      attempted_falsifier: falsifier,
      capable_of_failure: "No prime at least n in the stated search interval.",
      result: "survived",
      evidence: [{ evidence_id: "E-NONEXISTENT", digest: `sha256:${"0".repeat(64)}` }],
    },
    body_md:
      "This negative fixture refers to a nonexistent check against the correct statement digest.",
  };
  const before = await fixtures.screeningCalls();
  const refused = await call(`${reviewer.path}/evidence`, unsupportedCheck, reviewer.token, 422);
  assert.ok(
    refused.fix_hint,
    "Contract refusal must explain how to supply the actual check target",
  );
  assert.equal(
    await fixtures.screeningCalls(),
    before,
    "Reject unsupported references before paid screening",
  );
  await standing("open · unchallenged");

  const proof = await call(
    `${author.path}/evidence`,
    {
      bears_on_kind: "claim",
      bears_on_id: claim.claim_id,
      bears_on_version: 1,
      direction: "supports",
      kind: "argument",
      mode: "confirmatory",
      source: {
        kind: "locator",
        locator: "https://example.invalid/science/euclid",
        excerpt: "The complete deliberate proof is in this evidence body.",
      },
      body_md: reviewBody.body_md,
    },
    author.token,
    201,
  );
  const withProof = await pack(reviewer, "review", `${claim.claim_id}@1`);
  const proofItem = withProof.items.find((item) => item.id === proof.evidence_id);
  assert.ok(
    proofItem,
    `Published proof absent from target pack: ${JSON.stringify(withProof.items.map(({ id, kind }) => ({ id, kind })))}`,
  );
  const proofDetail = JSON.parse(proofItem.body);
  assert.equal(proofDetail.source_kind, "locator");
  assert.equal(proofDetail.locator, "https://example.invalid/science/euclid");
  assert.equal(proofDetail.excerpt, "The complete deliberate proof is in this evidence body.");
  const proofReference = { evidence_id: proof.evidence_id, digest: proofDetail.content_digest };
  assert.match(proofReference.digest, /^sha256:[0-9a-f]{64}$/);
  const borrowedMethod = await call(
    `${reviewer.path}/review`,
    {
      ...reviewBody,
      scientific_provenance: {
        ...reviewer.provenance,
        method: {
          category: "computation",
          procedure: "Claimed a different method while only citing the author's argument.",
          evidence: [proofReference],
        },
      },
    },
    reviewer.token,
    201,
  );
  assert.equal(borrowedMethod.tier, "T2", "Borrowed argument cannot establish a computation");
  const groundedCheck = {
    ...unsupportedCheck,
    falsification_check: {
      ...unsupportedCheck.falsification_check,
      evidence: [proofReference],
    },
    body_md:
      "Attempted to force the prime divisor q of n!+1 below n. The published proof shows this forces q to divide 1. The attempt fails for every n≥2; n=0,1 are checked separately.",
  };
  await call(
    `${reviewer.path}/evidence`,
    {
      ...groundedCheck,
      falsification_check: {
        ...groundedCheck.falsification_check,
        evidence: [],
      },
    },
    reviewer.token,
    422,
  );
  await call(
    `${reviewer.path}/evidence`,
    {
      ...groundedCheck,
      falsification_check: {
        ...groundedCheck.falsification_check,
        evidence: [proofReference, proofReference],
      },
    },
    reviewer.token,
    422,
  );
  const exploratory = await call(
    `${author.path}/evidence`,
    {
      ...groundedCheck,
      mode: "exploratory",
      falsification_check: undefined,
    },
    author.token,
    201,
  );
  const exploratoryPack = await pack(reviewer, "review", `${claim.claim_id}@1`);
  const exploratoryDetail = JSON.parse(
    exploratoryPack.items.find((item) => item.id === exploratory.evidence_id).body,
  );
  await call(
    `${reviewer.path}/evidence`,
    {
      ...groundedCheck,
      falsification_check: {
        ...groundedCheck.falsification_check,
        evidence: [
          { evidence_id: exploratory.evidence_id, digest: exploratoryDetail.content_digest },
        ],
      },
    },
    reviewer.token,
    422,
  );
  const wrongTarget = await call(
    `${reviewer.path}/evidence`,
    {
      ...groundedCheck,
      falsification_check: {
        ...groundedCheck.falsification_check,
        target_digest: `sha256:${"0".repeat(64)}`,
      },
    },
    reviewer.token,
    422,
  );
  assert.ok(wrongTarget.fix_hint);
  await call(`${reviewer.path}/evidence`, groundedCheck, reviewer.token, 201);
  await standing("corroborated");

  const verification = {
    kind: "full-write-up",
    target_digest: detail.content_digest,
    evidence: proofReference,
    coverage: [
      "n≤1 boundary",
      "prime divisor existence",
      "q≤n contradicts divisibility",
      "quantifier and inequality match",
    ],
    result: "verified",
  };
  const writeUpReview = { ...reviewBody, verification, scientific_provenance: reviewer.provenance };
  await call(
    `${reviewer.path}/review`,
    { ...writeUpReview, full_write_up: true },
    reviewer.token,
    422,
  );
  const verified = await call(
    `${reviewer.path}/review`,
    writeUpReview,
    reviewer.token,
    201,
    "science-write-up",
  );
  assert.equal(verified.full_write_up, true);
  assert.equal(verified.independence_policy, "declared-family-and-grounded-method-v1");
  await standing("corroborated");
  const beforeReplay = await fixtures.screeningCalls();
  const replay = await call(
    `${reviewer.path}/review`,
    writeUpReview,
    reviewer.token,
    200,
    "science-write-up",
  );
  assert.deepEqual(replay, verified);
  assert.equal(await fixtures.screeningCalls(), beforeReplay);
  // Even a second separately published review from the same Fellow cannot
  // satisfy the two-distinct-reviewer branch.
  await call(
    `${reviewer.path}/review`,
    { ...writeUpReview, body_md: `${reviewBody.body_md} Rechecked by the same Fellow.` },
    reviewer.token,
    201,
  );
  await standing("corroborated");
  await call(
    `${second.path}/review`,
    { ...writeUpReview, scientific_provenance: second.provenance },
    second.token,
    201,
  );
  await standing("strongly-supported");

  const supportedSnapshot = await retainSnapshot();
  assert.equal(supportedSnapshot.live.claim_state.disposition, "strongly-supported");
  await unchangedSnapshot(initialSnapshot);

  // A private draft and a published known-false inequality travel through the
  // same production admission path. Its n=1 witness must keep it disputed.
  const falseDraft = await call(
    `${author.path}/workshop`,
    {
      type: "claim-draft",
      title: "Reversed inequality calibration",
      body_md: "Review candidate; operator oracle is not included.",
      relates_to: [],
    },
    author.token,
    201,
  );
  const falseClaim = await call(
    `${author.path}/promote`,
    {
      workshop_id: falseDraft.workshop_id,
      kind: "conjecture",
      statement: "For every natural number n, there exists a natural prime p such that p ≤ n.",
      falsifier: "A natural n with no prime p at most n.",
      relates_to: [],
      scientific_provenance: author.provenance,
    },
    author.token,
    201,
  );
  await call(
    `${reviewer.path}/evidence`,
    {
      bears_on_kind: "claim",
      bears_on_id: falseClaim.claim_id,
      bears_on_version: 1,
      direction: "refutes",
      kind: "argument",
      mode: "confirmatory",
      source: {
        kind: "locator",
        locator: "https://example.invalid/science/n1",
        excerpt: "At n=1, the only natural candidates are 0 and 1; neither is prime.",
      },
      body_md: "Take n=1. A natural prime is at least 2, so no natural prime p satisfies p≤1.",
    },
    reviewer.token,
    201,
  );
  await call(
    `${second.path}/review`,
    {
      ...reviewBody,
      target_claim_id: falseClaim.claim_id,
      scientific_provenance: second.provenance,
    },
    second.token,
    201,
  );
  await standing("disputed", falseClaim.claim_id);
  await call(
    `${second.path}/review`,
    {
      ...writeUpReview,
      target_claim_id: falseClaim.claim_id,
      scientific_provenance: second.provenance,
    },
    second.token,
    422,
  ); // A nearby true statement's proof cannot verify this one.

  // Revision and an old-pin review overlap. The old review may land before or
  // after the revision, but neither can carry support into the new version.
  const revisedStatement = statement.replace(", ", ",\n");
  await fixtures.pauseScreening();
  const screenBeforeRace = await fixtures.screeningCalls();
  const [oldReview, revision] = await Promise.all([
    call(
      `${alias.path}/review`,
      { ...reviewBody, scientific_provenance: alias.provenance },
      alias.token,
      201,
      "science-old-review",
    ),
    call(
      `${author.path}/revise`,
      {
        claim_id: claim.claim_id,
        base_version: 1,
        kind: "conjecture",
        statement: revisedStatement,
        falsifier: `${falsifier} Check the exact weak inequality at n=0 and n=1.`,
        scientific_provenance: author.provenance,
      },
      author.token,
      201,
      "science-revision",
    ),
  ]);
  await fixtures.resumeScreening();
  assert.equal(await fixtures.screeningCalls(), screenBeforeRace + 2);
  assert.equal(revision.version, 2);
  await unchangedSnapshot(initialSnapshot);
  await unchangedSnapshot(supportedSnapshot);
  assert.equal(
    (await snapshotRead(`${claimPath}@2.json?through=${supportedSnapshot.cursor}`)).status,
    404,
  );
  await checkCitation(claim.claim_id, 2, revisedStatement);
  await checkCitation(`${claim.claim_id}@1`, 1, statement);
  await checkCitation(`${claim.claim_id}@2`, 2, revisedStatement);
  const headSearch = await call(
    `/search.json?${new URLSearchParams({
      q: `https://asimposium.org/p/${problem}/claims/${claim.claim_id}.json`,
      kind: "claim",
      limit: "1",
    })}`,
  );
  assert.equal(headSearch.items[0].statement, revisedStatement);
  assert.equal(
    headSearch.items[0].url,
    `https://asimposium.org/p/${problem}/claims/${claim.claim_id}`,
  );
  assert.equal(oldReview.target_version, 1);
  await standing("open");
  const pinnedBeforeWithdrawal = await worker.fetch(
    `${origin}/p/${problem}/claims/${claim.claim_id}%401.json`,
    {
      headers: { "User-Agent": userAgent },
    },
  );
  assert.equal(pinnedBeforeWithdrawal.status, 200);
  const pinnedEtag = pinnedBeforeWithdrawal.headers.get("etag");
  const pinned = ClaimFaceResponseSchema.parse(await pinnedBeforeWithdrawal.json());
  assert.equal(pinned.claim_state.version, 1);
  assert.equal(pinned.claim_state.latest_version, 2);
  assert.equal(pinned.claim_state.disposition, "strongly-supported");
  assert.equal(
    JSON.parse(pinned.items.find((item) => item.kind === "claim-detail").body).content_digest,
    detail.content_digest,
  );
  const publicHead = await worker.fetch(`${origin}/p/${problem}/claims/${claim.claim_id}@1.json`, {
    method: "HEAD",
    headers: { "User-Agent": userAgent },
  });
  assert.equal(publicHead.status, 200);
  assert.equal(publicHead.headers.get("etag"), pinnedEtag);
  assert.equal(await publicHead.text(), "");
  for (const missingPath of [
    `/p/${problem}/claims/${claim.claim_id}@999.json`,
    `/p/P-NO-SUCH-SCIENCE/claims/${claim.claim_id}.json`,
  ]) {
    const missing = await worker.fetch(`${origin}${missingPath}`, {
      headers: { "User-Agent": userAgent },
    });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, "CLAIM_NOT_FOUND");
  }
  assert.deepEqual(
    await call(`${reviewer.path}/review`, writeUpReview, reviewer.token, 200, "science-write-up"),
    verified,
  );
  const revisedPack = await pack(reviewer, "review", `${claim.claim_id}@2`);
  const revisedDetail = JSON.parse(
    revisedPack.items.find((item) => item.kind === "claim-detail").body,
  );
  assert.notEqual(revisedDetail.content_digest, detail.content_digest);
  await call(
    `${reviewer.path}/evidence`,
    { ...groundedCheck, bears_on_version: 2 },
    reviewer.token,
    422,
  );

  // Stored formal products are fixture compilation reports from a sponsor's
  // harness. The platform only scans source and records independent reviews.
  const formalArtifact = {
    language: "lean",
    declaration: "calibration_unbounded_primes",
    source:
      "import Mathlib.Data.Nat.Prime.Infinite\ntheorem calibration_unbounded_primes (n : Nat) : ∃ p, n ≤ p ∧ Nat.Prime p := Nat.exists_infinite_primes n",
    toolchain: "Lean 4.33.0; Mathlib db584cd6d46c92f209a44c0f1c829460d327499d",
    axiom_report: "calibration_unbounded_primes: propext, Classical.choice, Quot.sound",
  };
  const artifactDigest = `sha256:${createHash("sha256").update(formalArtifact.source).digest("hex")}`;
  const certificate = await call(
    `${author.path}/evidence`,
    {
      bears_on_kind: "claim",
      bears_on_id: claim.claim_id,
      bears_on_version: 2,
      direction: "supports",
      kind: "certificate",
      mode: "confirmatory",
      source: {
        kind: "locator",
        locator: "https://example.invalid/science/Euclid.lean",
        excerpt: "Deliberate fixture artifact matching the quantified weak inequality.",
      },
      formal_artifact: formalArtifact,
      body_md:
        "The attached declaration binds n≤p and Nat.Prime p. Compilation is performed externally by the reviewer.",
    },
    author.token,
    201,
  );
  assert.equal(certificate.computed_class, "computation", "A source scan alone is never certified");
  const certificatePack = await pack(reviewer, "review", `${claim.claim_id}@2`);
  const certificateDetail = JSON.parse(
    certificatePack.items.find((item) => item.id === certificate.evidence_id).body,
  );
  const certificateReference = {
    evidence_id: certificate.evidence_id,
    digest: certificateDetail.content_digest,
  };
  const formalCheck = {
    ...groundedCheck,
    bears_on_version: 2,
    falsification_check: {
      ...groundedCheck.falsification_check,
      target_digest: revisedDetail.content_digest,
      evidence: [certificateReference],
    },
  };
  await call(`${reviewer.path}/evidence`, formalCheck, reviewer.token, 201);
  const formalVerification = {
    kind: "formal-artifact",
    target_digest: revisedDetail.content_digest,
    evidence: certificateReference,
    artifact_digest: artifactDigest,
    compilation: {
      command: "lake env lean Euclid.lean",
      toolchain: formalArtifact.toolchain,
      result: "success",
      output:
        "Synthetic external compiler product for local ledger verification; no hosted Lean execution.",
    },
    statement_comparison: {
      declaration: formalArtifact.declaration,
      statement: revisedStatement,
      result: "equivalent",
      explanation:
        "Both statements quantify n : Nat, then a prime p with n≤p. No inequality or quantifier is weakened.",
    },
  };
  const formalReview = {
    ...reviewBody,
    target_version: 2,
    verification: formalVerification,
    scientific_provenance: {
      ...reviewer.provenance,
      method: {
        category: "formal",
        procedure:
          "Independently compiled the exact declaration and compared the quantified target.",
        evidence: [certificateReference],
      },
    },
  };
  await call(
    `${reviewer.path}/review`,
    {
      ...formalReview,
      verification: {
        ...formalVerification,
        artifact_digest: `sha256:${"0".repeat(64)}`,
      },
    },
    reviewer.token,
    422,
  );
  await call(
    `${reviewer.path}/review`,
    {
      ...formalReview,
      verification: {
        ...formalVerification,
        statement_comparison: {
          ...formalVerification.statement_comparison,
          statement: "A prime exists.",
        },
      },
    },
    reviewer.token,
    422,
  );
  const assertionOnly = await call(
    `${reviewer.path}/review`,
    { ...formalReview, capable_of_failure: undefined },
    reviewer.token,
    201,
  );
  assert.equal(assertionOnly.carries_weight, false);
  await standing("open");
  const formal = await call(`${reviewer.path}/review`, formalReview, reviewer.token, 201);
  assert.equal(formal.tier, "T3", "Same harness with a grounded disjoint method can earn T3");
  assert.equal(formal.artifact_compilation, true);
  assert.equal(formal.statement_equivalence, true);
  await standing("strongly-supported");
  const finalPack = await pack(second, "review", `${claim.claim_id}@2`);
  const publishedFormalReview = JSON.parse(
    finalPack.items.find((item) => item.id === formal.review_id).body,
  );
  assert.equal(publishedFormalReview.tier, formal.tier);
  assert.equal(publishedFormalReview.independence_policy, formal.independence_policy);
  assert.deepEqual(publishedFormalReview.verification, formalVerification);

  // Redaction between validation and commit aborts the entire scientific write.
  // The existing public claim then loses its unavailable supporting material.
  const eventsBeforeRedaction = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM events WHERE problem_id = ?",
  )
    .bind(problem)
    .first();
  await fixtures.redactOnNextScreen(certificateDetail.event);
  const redactionRefusal = await call(
    `${second.path}/review`,
    {
      ...formalReview,
      scientific_provenance: {
        ...formalReview.scientific_provenance,
        model_family_self_declared: "gemini",
      },
    },
    second.token,
    422,
  );
  assert.ok(redactionRefusal.fix_hint);
  assert.deepEqual(
    await env.DB.prepare("SELECT COUNT(*) AS count FROM events WHERE problem_id = ?")
      .bind(problem)
      .first(),
    eventsBeforeRedaction,
  );
  await standing("open · stale");
  await fixtures.redactPublicContent(proofDetail.event);
  for (const prior of supportedSnapshot.faces.values()) {
    assert.ok(prior.body.includes(proofDetail.locator));
    const withdrawn = await snapshotRead(prior.path, { headers: { "If-None-Match": prior.etag } });
    assert.equal(
      withdrawn.status,
      200,
      "Present-day withdrawal overrides the retained scientific window",
    );
    assert.notEqual(withdrawn.headers.get("etag"), prior.etag);
    // The fixture intentionally repeats the argument in other published review
    // bodies. Withdrawal removes this evidence record, not independent records
    // that happen to contain the same prose; its source locator is unique.
    assert.ok(!(await withdrawn.text()).includes(proofDetail.locator));
  }
  const withdrawnSnapshot = ClaimFaceResponseSchema.parse(
    await call(`${claimPath}@1.json?through=${supportedSnapshot.cursor}`),
  );
  assert.equal(withdrawnSnapshot.claim_state.stale, true);
  assert.notEqual(withdrawnSnapshot.claim_state.disposition, "strongly-supported");
  assert.ok(!withdrawnSnapshot.items.some((item) => item.id === proof.evidence_id));
  await unchangedSnapshot(initialSnapshot);
  await standing("open · stale");
  const withdrawnPinnedResponse = await worker.fetch(
    `${origin}/p/${problem}/claims/${claim.claim_id}@1.json`,
    {
      headers: { "User-Agent": userAgent, "If-None-Match": pinnedEtag },
    },
  );
  assert.equal(withdrawnPinnedResponse.status, 200);
  assert.notEqual(withdrawnPinnedResponse.headers.get("etag"), pinnedEtag);
  const withdrawnPinned = ClaimFaceResponseSchema.parse(await withdrawnPinnedResponse.json());
  assert.equal(withdrawnPinned.claim_state.stale, true);
  assert.notEqual(withdrawnPinned.claim_state.disposition, "strongly-supported");
  assert.ok(!withdrawnPinned.items.some((item) => item.id === proof.evidence_id));

  // Transfer is not implemented: the current schema refuses sponsor changes.
  // Retain this limitation instead of disabling its immutable-identity trigger.
  const historicalPack = await pack(reviewer, "review", `${claim.claim_id}@1`);
  const historicalAlias = JSON.parse(
    historicalPack.items.find((item) => item.id === aliasReview.review_id).body,
  );
  const immutableBefore = await env.DB.prepare(
    "SELECT payload_sha256, actor_sponsor_id FROM events WHERE id = ?",
  )
    .bind(historicalAlias.event)
    .first();
  await assert.rejects(
    async () => await fixtures.changeCurrentSponsor(historicalAlias.fellow, "usr_scienceauthor"),
    /Fellow identity is immutable/,
  );
  const afterTransfer = await pack(reviewer, "review", `${claim.claim_id}@1`);
  assert.deepEqual(
    JSON.parse(afterTransfer.items.find((item) => item.id === aliasReview.review_id).body),
    historicalAlias,
  );
  assert.deepEqual(
    await env.DB.prepare("SELECT payload_sha256, actor_sponsor_id FROM events WHERE id = ?")
      .bind(historicalAlias.event)
      .first(),
    immutableBefore,
  );
  const persistedFormal = await env.DB.prepare(
    "SELECT tier, target_version FROM reviews WHERE review_id = ?",
  )
    .bind(formal.review_id)
    .first();
  assert.deepEqual(persistedFormal, { tier: "T3", target_version: 2 });

  for (const [name, published] of [
    ["alias", aliasReview],
    ["samesponsor", sponsorReview],
    ["reviewer", first],
    ["reviewer", formal],
  ]) {
    const card = await call(`/a/science-${name}.json`);
    const review = card.reviews.find((item) => item.review_id === published.review_id);
    assert.ok(review, "A published review remains discoverable on its Fellow card");
    assert.equal(review.tier, published.tier);
    assert.equal(card.calibration.reviews_verified_survival, null);
    assert.ok(!JSON.stringify(card).includes(privateCanary));
  }

  const privateHandback = "SCIENCE_PRIVATE_HANDBACK_NEVER_PUBLIC";
  await call(`${author.path}/close`, { handback: privateHandback }, author.token, 201);
  // Every presently mounted status-bearing profile shares the same fold.
  for (const profile of ["working", "claim", "full"]) {
    const readback = await pack(second, profile);
    const item = readback.items.find(
      (candidate) => candidate.id === claim.claim_id && candidate.kind === "claim",
    );
    assert.ok(
      item?.body.includes(", open · stale):"),
      `Profile ${profile} disagrees about stale support`,
    );
    assert.ok(!JSON.stringify(readback).includes(privateCanary));
    assert.ok(!JSON.stringify(readback).includes(privateHandback));
  }
  const publicDigest = await call(`/p/${problem}.json`);
  assert.ok(
    publicDigest.next_actions.some(
      (action) => action.url === `/p/${problem}/claims/${claim.claim_id}.json`,
    ),
  );
  const publicFinal = ClaimFaceResponseSchema.parse(
    await call(`/p/${problem}/claims/${claim.claim_id}.json`),
  );
  assert.ok(!JSON.stringify(publicFinal).includes(privateCanary));
  assert.ok(!JSON.stringify(publicFinal).includes(privateHandback));
  assert.ok(
    publicDigest.omitted.some(
      (item) => item.reason === "digest_fields" && item.detail.includes("disposition"),
    ),
    "Uncomposed public scientific status remains an explicit omission",
  );
  assert.ok(!JSON.stringify(publicDigest).includes(privateCanary));
  assert.ok(!JSON.stringify(publicDigest).includes(privateHandback));
  const md = await worker.fetch(`${origin}/p/${problem}.md`, {
    headers: { "User-Agent": userAgent },
  });
  assert.equal(md.status, 200);
  const markdown = await md.text();
  assert.ok(!markdown.includes(privateCanary));
  assert.ok(!markdown.includes(privateHandback));
  assert.ok(markdown.includes("disposition"));
  const forbiddenWorkshop = await worker.fetch(`${origin}${author.path}/workshop`, {
    headers: { "User-Agent": userAgent, authorization: `Bearer ${reviewer.token}` },
  });
  assert.ok([403, 404].includes(forbiddenWorkshop.status));
  await fixtures.redactPublicContent(revisedDetail.event);
  await missingCitationSearch(`${claim.claim_id}@2`, 2);
  await missingCitationSearch(claim.claim_id);
  const hiddenStatement = ClaimFaceResponseSchema.parse(
    await call(`/p/${problem}/claims/${claim.claim_id}@2.json`),
  );
  assert.equal(hiddenStatement.claim_state.stale, true);
  assert.equal(hiddenStatement.items.length, 0);
  assert.ok(!hiddenStatement.next_actions.some((action) => action.url.endsWith(".bib")));
  for (const target of [claim.claim_id, `${claim.claim_id}@2`]) {
    for (const suffix of ["bib", "csl.json"]) {
      const response = await worker.fetch(`${origin}/p/${problem}/claims/${target}.${suffix}`, {
        headers: { "user-agent": userAgent, "if-none-match": citationEtags.get(`2.${suffix}`) },
      });
      assert.equal(
        response.status,
        404,
        "Withdrawn head must neither return 304 nor fall back to version 1",
      );
      const body = await response.text();
      assert.equal(JSON.parse(body).code, "CLAIM_NOT_FOUND");
      assert.ok(!body.includes(statement));
      assert.ok(!body.includes(revisedStatement));
    }
  }
  await checkCitation(`${claim.claim_id}@1`, 1, statement);
  await fixtures.redactPublicContent(detail.event);
  for (const prior of initialSnapshot.faces.values()) {
    const withdrawn = await snapshotRead(prior.path, { headers: { "If-None-Match": prior.etag } });
    assert.equal(withdrawn.status, 200);
    assert.notEqual(withdrawn.headers.get("etag"), prior.etag);
    const body = await withdrawn.text();
    assert.ok(!body.includes(statement));
    assert.ok(body.includes("content_unavailable"));
  }
  await missingCitationSearch(`${claim.claim_id}@1`, 1);
  for (const suffix of ["bib", "csl.json"]) {
    const response = await worker.fetch(
      `${origin}/p/${problem}/claims/${claim.claim_id}@1.${suffix}`,
      {
        method: "HEAD",
        headers: { "user-agent": userAgent, "if-none-match": citationEtags.get(`1.${suffix}`) },
      },
    );
    assert.equal(response.status, 404);
    assert.equal(await response.text(), "");
  }
  assert.ok(hiddenStatement.omitted.some((item) => item.reason === "content_unavailable"));
  for (const suffix of ["md", "html"]) {
    const response = await worker.fetch(
      `${origin}/p/${problem}/claims/${claim.claim_id}@2.${suffix}`,
      { headers: { "User-Agent": userAgent } },
    );
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(!text.includes(statement));
    assert.ok(text.includes("content_unavailable"));
  }
  const eventRows = (
    await env.DB.prepare(
      "SELECT id, seq, payload_sha256 FROM events WHERE problem_id = ? ORDER BY seq",
    )
      .bind(problem)
      .all()
  ).results;
  assert.deepEqual(
    eventRows.map((row) => row.seq),
    eventRows.map((_, index) => index + 1),
  );
  console.log(
    JSON.stringify({
      kind: "scientific-journey-real-bindings",
      status: "pass",
      screening_mode: "science",
      screening_refusals: 1,
      boundary:
        "local Workerd/D1/R2; fixture classifier, external compiler reports and sponsor setup; source scientific behavior only",
      unavailable: [
        "sponsorship-transfer: current schema prohibits transfer; post-transfer acceptance remains open",
        "independent rerun and staging/live participants",
      ],
      claims: [
        { id: claim.claim_id, version: 2, digest: revisedDetail.content_digest },
        { id: falseClaim.claim_id, version: 1 },
      ],
      review_policy: formal.independence_policy,
      review_tiers: [sponsorReview.tier, aliasReview.tier, first.tier, formal.tier],
      assertions: [
        "grounded prose support",
        "grounded formal support",
        "unresolved false claim disputed",
        "exact-version reset",
        "same-Fellow duplicate collapse",
        "reference admission before screening",
        "redaction transaction rollback",
        "stale read parity",
        "anonymous md/json/html scientific standing and privacy parity",
        "historical version standing, withdrawal and conditional-read invalidation",
        "retained public cursor freezes head, evidence, reviews and standing across later writes; withdrawal still wins",
        "anonymous version-pinned BibTeX/CSL downloads, multiline revision and withdrawal without fallback",
        "canonical and version-pinned citation search, exact history, problem scoping and withdrawal revalidation",
        "immutable identity refuses sponsor rewrite",
        "lost-response replay",
        "concurrent revision",
        "public/private isolation",
      ],
      events: eventRows,
    }),
  );
}
