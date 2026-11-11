import { expect, test } from "bun:test";
import { sha256Hex } from "../../src/krater/krater.ts";
import { reviewStateFromRecordedReviews } from "../../src/ledger/dispositions.ts";
import { SCIENTIFIC_INDEPENDENCE_POLICY } from "../../src/ledger/scientific-checks.ts";
import { foldScientificRows } from "../../src/ledger/scientific-disposition.ts";

type Row = Parameters<typeof foldScientificRows>[0][number];
const targetDigest = `sha256:${"a".repeat(64)}`;
const statement = "Two equals two.";
async function row(
  sequence: number,
  type: string,
  payload: unknown,
  overrides: Partial<Row> = {},
): Promise<Row> {
  const text = JSON.stringify(payload);
  return {
    claim_id: "C-1",
    event_id: `EVENT-${sequence}`,
    seq: sequence,
    type,
    object_id: `OBJECT-${sequence}`,
    object_version: 1,
    target_version: 1,
    payload_json: text,
    payload_sha256: await sha256Hex(text),
    created_at: new Date(Date.UTC(2026, 8, 1, 0, sequence)).toISOString(),
    fellow_id: "F-author",
    sponsor_id: "S-author",
    content_digest: null,
    statement: null,
    direction: null,
    ...overrides,
  };
}

async function refutationCorpus(hours = 72): Promise<[Row, Row, Row]> {
  const creation = await row(
    1,
    "claim.created",
    { scientific_provenance: { model_family_self_declared: "gpt" } },
    {
      object_id: "C-1",
      content_digest: targetDigest,
      statement,
      created_at: "2026-09-01T00:00:00.000Z",
    },
  );
  const evidence = await row(
    2,
    "evidence.created",
    {
      bears_on_kind: "claim",
      bears_on_id: "C-1",
      bears_on_version: 1,
      kind: "computation",
      direction: "refutes",
      mode: "confirmatory",
      computed_class: "computation",
      body_md: "The recorded computation exhibits the exact counterexample.",
    },
    {
      object_id: "E-2",
      direction: "refutes",
      fellow_id: "F-counterexample",
      sponsor_id: "S-counterexample",
      created_at: "2026-09-01T01:00:00.000Z",
    },
  );
  const review = await row(
    3,
    "review.created",
    {
      verdict: "refute",
      basis: "Checked that the witness satisfies each hypothesis and violates the conclusion.",
      body_md: "The recorded witness is a counterexample to this exact statement.",
      capable_of_failure: "The counterexample fails the statement's hypotheses.",
      tier: "T2",
      independence_policy: SCIENTIFIC_INDEPENDENCE_POLICY,
      verification: {
        kind: "refutation",
        target_digest: targetDigest,
        evidence: { evidence_id: "E-2", digest: `sha256:${evidence.payload_sha256}` },
        coverage: ["Hypotheses hold", "The conclusion fails at the recorded witness"],
        result: "verified",
      },
    },
    {
      object_id: "R-3",
      fellow_id: "F-independent",
      sponsor_id: "S-independent",
      weighted_refutation: 1,
      created_at: new Date(
        Date.parse("2026-09-01T01:00:00.000Z") + hours * 3_600_000,
      ).toISOString(),
    },
  );
  return [creation, evidence, review];
}

async function changedPayload(source: Row, change: Record<string, unknown>): Promise<Row> {
  if (source.payload_json === null) throw new Error("Expected a fixture payload");
  const payload = JSON.stringify({ ...JSON.parse(source.payload_json), ...change });
  return { ...source, payload_json: payload, payload_sha256: await sha256Hex(payload) };
}

test("status step identity comes from its verified envelope, never payload-supplied explanation", async () => {
  const rows = await refutationCorpus(72);
  rows[2] = await changedPayload(rows[2], {
    status_basis: { event_id: "EVT-FORGED", cause: "claim-created" },
  });
  const fold = await foldScientificRows(rows);
  expect(fold.disposition).toBe("refuted");
  expect(fold.lastTransition).toEqual({
    sequence: 3,
    from: "disputed",
    to: "refuted",
    cause: "review-created",
    eventId: "EVENT-3",
  });
  const missing = await foldScientificRows([rows[0], { ...rows[2], payload_json: null }]);
  expect(missing.stale).toBe(true);
  expect(missing.lastTransition?.eventId).toBeUndefined();
});

async function noveltyClaim(version = 1, sequence = 1): Promise<Row> {
  return row(
    sequence,
    version === 1 ? "claim.created" : "claim.revised",
    { claim_id: "C-1", kind: "novelty-claim", statement, dependency_pins: [] },
    {
      object_id: "C-1",
      object_version: version,
      target_version: version,
      content_digest: targetDigest,
      statement,
    },
  );
}

async function noveltyReview(
  sequence: number,
  verdict: "new" | "rediscovery" | "reformulation" | "special-case" | "unresolved",
  version = 1,
): Promise<Row> {
  return row(
    sequence,
    "review.created",
    {
      target_claim_id: "C-1",
      target_version: version,
      verdict: "inform",
      basis: "Searched the literature index and compared the exact bound with its prior form.",
      body_md: "The search and semantic comparison are recorded in the novelty block.",
      capable_of_failure: "An earlier equivalent statement would refute novelty.",
      tier: "T2",
      independence_policy: SCIENTIFIC_INDEPENDENCE_POLICY,
      novelty: {
        verdict,
        searches: [{ source: "Literature index", searched_on: "2026-09-01", terms: ["bound"] }],
        nearest_prior_art: [{ locator: "doi:10.0000/prior", relation: "A weaker bound" }],
        semantic_difference: "Compare the exact bound and domain of the prior statement.",
      },
    },
    {
      object_id: `R-${sequence}`,
      fellow_id: `F-reviewer-${sequence}`,
      sponsor_id: `S-reviewer-${sequence}`,
      target_version: version,
    },
  );
}

async function withdrawNoveltyReview(source: Row, sequence: number): Promise<Row> {
  return row(
    sequence,
    "object.retracted",
    {
      target_object: source.object_id,
      target_event_id: source.event_id,
      target_kind: "review",
      target_digest: `sha256:${source.payload_sha256}`,
      claim_id: source.claim_id,
      claim_version: source.target_version,
    },
    {
      object_id: `RT-${sequence}`,
      fellow_id: source.fellow_id,
      sponsor_id: source.sponsor_id,
      target_version: source.target_version,
      withdrawn_event_id: source.event_id,
      withdrawn_kind: "review",
      withdrawn_sha256: source.payload_sha256,
    },
  );
}

test("novelty standing includes the adverse twenty-first review outside the display page", async () => {
  const claim = await noveltyClaim();
  const reviews = await Promise.all(
    Array.from({ length: 20 }, (_, index) => noveltyReview(index + 2, "new")),
  );
  expect(await foldScientificRows([claim, ...reviews])).toMatchObject({ novelty: "new" });
  const adverse = await noveltyReview(22, "rediscovery");
  expect(await foldScientificRows([claim, ...reviews, adverse])).toMatchObject({
    novelty: "contested",
    disposition: "open",
  });
});

test("novelty withdrawal removes positive authority without erasing negative knowledge", async () => {
  const claim = await noveltyClaim();
  const positive = await noveltyReview(2, "new");
  const withdrawal = await withdrawNoveltyReview(positive, 3);
  for (const payload_json of [withdrawal.payload_json, null]) {
    expect(
      await foldScientificRows([claim, positive, { ...withdrawal, payload_json }]),
    ).toMatchObject({
      novelty: "unreviewed",
      stale: true,
    });
  }
  for (const verdict of ["rediscovery", "reformulation", "special-case"] as const) {
    const adverse = await noveltyReview(4, verdict);
    const retracted = await withdrawNoveltyReview(adverse, 5);
    expect(await foldScientificRows([claim, adverse, retracted])).toMatchObject({
      novelty: "not-new",
      stale: true,
    });
    expect(await foldScientificRows([claim, positive, adverse, retracted])).toMatchObject({
      novelty: "contested",
    });
  }
});

test("unavailable novelty reviews cannot let a remaining positive review manufacture new", async () => {
  const claim = await noveltyClaim();
  const positive = await noveltyReview(2, "new");
  const adverse = await noveltyReview(3, "rediscovery");
  for (const payload_json of [null, `${adverse.payload_json} `]) {
    const unavailable = { ...adverse, payload_json };
    expect(await foldScientificRows([claim, positive, unavailable])).toMatchObject({
      novelty: "unresolved",
      stale: true,
    });
    expect(await foldScientificRows([claim, unavailable])).toMatchObject({
      novelty: "unresolved",
    });
  }
  expect(
    await foldScientificRows([claim, { ...positive, payload_json: null }, adverse]),
  ).toMatchObject({
    novelty: "not-new",
    stale: true,
  });
});

test("novelty standing is exact-version and earlier cursor reviews never establish a revision", async () => {
  const claim = await noveltyClaim();
  const positive = await noveltyReview(2, "new");
  const revised = await noveltyClaim(2, 3);
  const oldAdverse = await noveltyReview(4, "rediscovery");
  expect(await foldScientificRows([claim, positive])).toMatchObject({ novelty: "new" });
  expect(await foldScientificRows([claim, positive, revised, oldAdverse])).toMatchObject({
    currentVersion: 2,
    novelty: "unreviewed",
  });
  const newReview = await noveltyReview(5, "new", 2);
  expect(await foldScientificRows([claim, positive, revised, oldAdverse, newReview])).toMatchObject(
    {
      novelty: "new",
    },
  );
  const lemma = await changedPayload(revised, { kind: "lemma" });
  expect(await foldScientificRows([claim, positive, lemma, oldAdverse])).not.toHaveProperty(
    "novelty",
  );
});

test("novelty requires an exact valid search record and a weighted independent review", async () => {
  const claim = await noveltyClaim();
  const positive = await noveltyReview(2, "new");
  for (const change of [{ tier: "T0" }, { capable_of_failure: "" }, { capable_of_failure: null }]) {
    expect(await foldScientificRows([claim, await changedPayload(positive, change)])).toMatchObject(
      {
        novelty: "unreviewed",
      },
    );
  }
  for (const sameIdentity of [{ fellow_id: claim.fellow_id }, { sponsor_id: claim.sponsor_id }]) {
    expect(await foldScientificRows([claim, { ...positive, ...sameIdentity }])).toMatchObject({
      novelty: "unreviewed",
    });
  }
  for (const change of [
    { target_claim_id: "C-2" },
    { target_version: 2 },
    { verdict: "confirm" },
    { novelty: { verdict: "new" } },
  ]) {
    expect(await foldScientificRows([claim, await changedPayload(positive, change)])).toMatchObject(
      {
        novelty: "unresolved",
        stale: true,
      },
    );
  }
});

test("reduction standing comes from the exact publication's immutable dependency pins", async () => {
  const publication = await row(
    1,
    "claim.created",
    {
      kind: "reduction",
      statement,
      dependency_pins: [
        {
          claim_id: "C-2",
          version: 1,
          event_id: "EV-PREMISE",
          payload_digest: "b".repeat(64),
          content_digest: `sha256:${"c".repeat(64)}`,
        },
      ],
    },
    { object_id: "C-1", statement, content_digest: targetDigest },
  );
  expect(await foldScientificRows([publication])).toMatchObject({
    disposition: "reduced-to",
    stale: false,
    currentVersion: 1,
  });

  const empty = await changedPayload(publication, {
    dependency_pins: [],
    relates_to: ["C-2"],
  });
  const laterProjection = { ...empty, reduced_to_claim_id: "C-3" };
  expect(await foldScientificRows([laterProjection])).toMatchObject({
    disposition: "open",
    stale: false,
  });
});

test("malformed or unavailable reduction pins cannot fall back to unrelated projected edges", async () => {
  for (const pins of [null, {}, [{ claim_id: "C-2" }]]) {
    const publication = await row(
      1,
      "claim.created",
      { kind: "reduction", statement, dependency_pins: pins, relates_to: ["C-2"] },
      { object_id: "C-1", statement, content_digest: targetDigest },
    );
    const misleadingProjection = { ...publication, reduced_to_claim_id: "C-3" };
    expect(await foldScientificRows([misleadingProjection])).toMatchObject({
      disposition: "open",
      stale: true,
    });
  }
  const publication = await row(
    1,
    "claim.created",
    { kind: "reduction", statement, relates_to: ["C-2"] },
    { object_id: "C-1", statement, content_digest: targetDigest },
  );
  for (const payload_json of [null, `${publication.payload_json} `]) {
    const unavailable = {
      ...publication,
      payload_json,
      claim_kind: "reduction",
      reduced_to_claim_id: "C-3",
    };
    expect(await foldScientificRows([unavailable])).toMatchObject({
      disposition: "open",
      stale: true,
    });
  }
});

test("legacy reductions use their own recorded claim relation only when pins are absent", async () => {
  const publication = await row(
    1,
    "claim.created",
    { kind: "reduction", statement, relates_to: ["C-2"] },
    { object_id: "C-1", statement, content_digest: targetDigest },
  );
  expect((await foldScientificRows([publication])).disposition).toBe("reduced-to");
  const versioned = await changedPayload(publication, { relates_to: ["C-2@3"] });
  expect((await foldScientificRows([versioned])).disposition).toBe("reduced-to");
  for (const target of ["C-1@2", "C-2@0", "C-2@9007199254740992", "H-2"]) {
    const invalid = await changedPayload(publication, { relates_to: [target] });
    expect(await foldScientificRows([invalid])).toMatchObject({
      disposition: "open",
      stale: true,
    });
  }
  const noRecordedTarget = await changedPayload(publication, { relates_to: [] });
  const laterProjection = { ...noRecordedTarget, reduced_to_claim_id: "C-3" };
  expect((await foldScientificRows([laterProjection])).disposition).toBe("open");
});

test("an explicit independent refutation settles exactly at the immutable 72-hour review cut", async () => {
  for (const [hours, expected] of [
    [0, "disputed"],
    [72 - 1 / 3_600_000, "disputed"],
    [72, "refuted"],
    [96, "refuted"],
  ] as const) {
    const rows = await refutationCorpus(hours);
    const serialized = JSON.stringify(rows);
    expect((await foldScientificRows(rows)).disposition).toBe(expected);
    expect(await foldScientificRows(rows)).toEqual(await foldScientificRows(rows));
    expect(JSON.stringify(rows)).toBe(serialized);
    // The exact earlier cursor stays disputed even after the later review.
    expect((await foldScientificRows(rows.slice(0, 2))).disposition).toBe("disputed");
  }
});

test("counterevidence flags and method citations cannot manufacture a settled refutation", async () => {
  const [creation, evidence, review] = await refutationCorpus();
  const forged = await changedPayload(evidence, {
    concession: true,
    confirmed_by_independent_review: true,
    unanswered_hours: 100000,
  });
  expect((await foldScientificRows([creation, forged])).disposition).toBe("disputed");
  for (const change of [
    { verification: null },
    { capable_of_failure: null },
    { tier: "T0" },
    {
      verification: null,
      scientific_provenance: {
        model_family_self_declared: "claude",
        method: {
          category: "counterexample",
          procedure: "The method cites the witness without an explicit verification.",
          evidence: [{ evidence_id: "E-2", digest: `sha256:${evidence.payload_sha256}` }],
        },
      },
    },
  ])
    expect(
      (await foldScientificRows([creation, evidence, await changedPayload(review, change)]))
        .disposition,
    ).toBe("disputed");
});

test("refutation verification requires independence from both immutable author identities", async () => {
  const [creation, evidence, review] = await refutationCorpus();
  for (const identity of [
    { fellow_id: creation.fellow_id },
    { sponsor_id: creation.sponsor_id },
    { fellow_id: evidence.fellow_id },
    { sponsor_id: evidence.sponsor_id },
  ])
    expect(
      (await foldScientificRows([creation, evidence, { ...review, ...identity }])).disposition,
    ).toBe("disputed");
});

test("missing content, bad pins, inconclusive checks and invalid chronology cannot settle", async () => {
  const [creation, evidence, review] = await refutationCorpus();
  if (review.payload_json === null) throw new Error("Expected a review fixture");
  const verification = JSON.parse(review.payload_json).verification;
  for (const selected of [
    [creation, { ...evidence, payload_json: null }, review],
    [creation, evidence, { ...review, payload_json: null }],
    [creation, evidence, { ...review, created_at: undefined }],
    [creation, { ...evidence, created_at: "not-a-timestamp" }, review],
    [creation, { ...evidence, created_at: "2026-08-01T00:00:00.000Z" }, review],
    [creation, evidence, { ...review, created_at: evidence.created_at }],
    [
      creation,
      evidence,
      await changedPayload(review, {
        verification: { ...verification, target_digest: `sha256:${"c".repeat(64)}` },
      }),
    ],
    [
      creation,
      evidence,
      await changedPayload(review, { verification: { ...verification, result: "cannot-verify" } }),
    ],
    [
      creation,
      evidence,
      await changedPayload(review, { verification: { ...verification, result: "mismatch" } }),
    ],
  ])
    expect((await foldScientificRows(selected)).disposition).toBe("disputed");
});

test("an intervening answer blocks settlement; a second explicit refutation can confirm an older check", async () => {
  const [creation, evidence, review] = await refutationCorpus(96);
  const later = { ...review, seq: 4, event_id: "EVENT-4", object_id: "R-4" };
  const early = { ...review, created_at: "2026-09-01T02:00:00.000Z" };
  expect((await foldScientificRows([creation, evidence, early, later])).disposition).toBe(
    "refuted",
  );
  for (const response of [
    await row(
      3,
      "review.created",
      {
        verdict: "confirm",
        basis: "Checked the assumptions of the proposed witness.",
        body_md: "The witness does not satisfy the statement's hypotheses.",
        capable_of_failure: "A failed assumption check.",
        tier: "T1",
      },
      { created_at: "2026-09-01T02:00:00.000Z", fellow_id: "F-answer", sponsor_id: "S-answer" },
    ),
    await row(
      3,
      "evidence.created",
      {
        bears_on_kind: "claim",
        bears_on_id: "C-1",
        bears_on_version: 1,
        direction: "informs",
        kind: "argument",
        mode: "exploratory",
        computed_class: "assertion",
        body_md: "The proposed witness does not satisfy a stated hypothesis.",
      },
      { object_id: "E-ANSWER", created_at: "2026-09-01T02:00:00.000Z", direction: "informs" },
    ),
    { ...early, payload_json: null },
  ])
    expect((await foldScientificRows([creation, evidence, response, later])).disposition).toBe(
      "disputed",
    );
});

test("settlement cannot revive withdrawn or malformed statements or cross a version reset", async () => {
  const [creation, evidence, review] = await refutationCorpus();
  const later = { ...review, seq: 4, event_id: "EVENT-4", object_id: "R-4" };
  const withdrawn = await row(
    3,
    "object.retracted",
    { target_object: "C-1", reason: "The author withdraws the target." },
    { created_at: "2026-09-01T02:00:00.000Z" },
  );
  expect((await foldScientificRows([creation, evidence, withdrawn, later])).disposition).toBe(
    "withdrawn",
  );
  const malformed = await row(
    3,
    "review.created",
    {
      verdict: "refute",
      basis: "Checked the quantifier scope and found an unbound variable.",
      body_md: "The statement uses n without quantifying it.",
      capable_of_failure: "A precise statement",
      rubric: ["statement-defect"],
    },
    { created_at: "2026-09-01T02:00:00.000Z", fellow_id: "F-defect", sponsor_id: "S-defect" },
  );
  expect((await foldScientificRows([creation, evidence, malformed, later])).disposition).toBe(
    "malformed",
  );
  const revised = await row(
    3,
    "claim.revised",
    { base_version: 1, statement: "A corrected second version." },
    {
      object_id: "C-1",
      object_version: 2,
      target_version: 2,
      content_digest: `sha256:${"d".repeat(64)}`,
      statement: "A corrected second version.",
      created_at: "2026-09-01T02:00:00.000Z",
    },
  );
  expect((await foldScientificRows([creation, evidence, revised, later])).disposition).toBe("open");
});

test("withdrawing the checked evidence or verifying review removes its settlement authority", async () => {
  const rows = await refutationCorpus();
  for (const source of [rows[1], rows[2]]) {
    const kind = source.type === "evidence.created" ? "evidence" : "review";
    const withdrawal = await row(
      4,
      "object.retracted",
      {
        target_object: source.object_id,
        target_event_id: source.event_id,
        target_kind: kind,
        target_digest: `sha256:${source.payload_sha256}`,
        claim_id: "C-1",
        claim_version: 1,
      },
      {
        object_id: "RT-4",
        fellow_id: source.fellow_id,
        sponsor_id: source.sponsor_id,
        withdrawn_event_id: source.event_id,
        withdrawn_kind: kind,
        withdrawn_sha256: source.payload_sha256,
        created_at: "2026-09-05T00:00:00.000Z",
      },
    );
    const folded = await foldScientificRows([...rows, withdrawal]);
    expect(folded.disposition).toBe("disputed");
    expect(folded.stale).toBe(true);
  }
});

async function corpus(legacy = false): Promise<Row[]> {
  const claim = await row(
    1,
    "claim.created",
    {
      scientific_provenance: { model_family_self_declared: "gpt" },
    },
    {
      object_id: "C-1",
      content_digest: targetDigest,
      statement,
      directive_disclosure: "satisfied",
    },
  );
  const proof = await row(
    2,
    "evidence.created",
    {
      bears_on_kind: "claim",
      bears_on_id: "C-1",
      bears_on_version: 1,
      kind: "argument",
      direction: "supports",
      mode: "confirmatory",
      computed_class: "citation",
      body_md: "Equality is reflexive.",
    },
    { object_id: "E-1", direction: "supports" },
  );
  const reference = { evidence_id: "E-1", digest: `sha256:${proof.payload_sha256}` };
  const check = await row(
    3,
    "evidence.created",
    {
      bears_on_kind: "claim",
      bears_on_id: "C-1",
      bears_on_version: 1,
      kind: "argument",
      direction: "informs",
      mode: "confirmatory",
      computed_class: "citation",
      body_md: "The proposed unequal result does not occur.",
      falsification_check: {
        target_digest: targetDigest,
        attempted_falsifier: "Compare two with itself.",
        capable_of_failure: "An unequal result.",
        result: "survived",
        evidence: [reference],
      },
    },
    { object_id: "E-2", direction: "informs" },
  );
  const reviews = await Promise.all(
    [4, 5].map(async (sequence) =>
      row(
        sequence,
        "review.created",
        {
          tier: legacy ? "T3" : "T2",
          basis: "Checked that reflexivity applies to the exact integer in the statement.",
          body_md: "The statement follows from reflexivity of equality.",
          capable_of_failure: "An unequal result.",
          verdict: "confirm",
          ...(legacy
            ? { full_write_up: true, artifact_compilation: true, statement_equivalence: true }
            : {
                independence_policy: SCIENTIFIC_INDEPENDENCE_POLICY,
                scientific_provenance: {
                  model_family_self_declared: sequence === 4 ? "claude" : "gemini",
                },
                verification: {
                  kind: "full-write-up",
                  target_digest: targetDigest,
                  evidence: reference,
                  coverage: ["exact reflexive target"],
                  result: "verified",
                },
              }),
        },
        { fellow_id: `F-${sequence}`, sponsor_id: `S-${sequence}` },
      ),
    ),
  );
  return [claim, proof, check, ...reviews];
}

async function originalWriteUpCorpus(kind = "argument"): Promise<[Row, Row, Row, Row, ...Row[]]> {
  const [claim, material, attempt, ...reviews] = await corpus();
  if (!claim || !material || !attempt) throw new Error("Expected the complete scientific corpus");
  const computation = await changedPayload(material, {
    kind: "computation",
    computed_class: "computation",
    body_md: "The exact integer comparison returns equality; an unequal value would refute it.",
  });
  const check = await changedPayload(attempt, {
    falsification_check: {
      target_digest: targetDigest,
      attempted_falsifier: "Compare two with itself.",
      capable_of_failure: "An unequal result.",
      result: "survived",
      evidence: [{ evidence_id: "E-1", digest: `sha256:${computation.payload_sha256}` }],
    },
  });
  const proof = await row(
    4,
    "evidence.created",
    {
      bears_on_kind: "claim",
      bears_on_id: "C-1",
      bears_on_version: 1,
      kind,
      direction: "supports",
      mode: "confirmatory",
      source: { kind: "model_memory" },
      computed_class: "assertion",
      body_md: "The relation is reflexive, so two equals two.",
    },
    { object_id: "E-original", direction: "supports" },
  );
  const checked = await Promise.all(
    reviews.map((review) =>
      changedPayload(
        { ...review, seq: review.seq + 1, event_id: `EVENT-${review.seq + 1}` },
        {
          verification: {
            kind: "full-write-up",
            target_digest: targetDigest,
            evidence: { evidence_id: "E-original", digest: `sha256:${proof.payload_sha256}` },
            coverage: ["The exact reflexive target and the complete deliberate argument."],
            result: "verified",
          },
        },
      ),
    ),
  );
  return [claim, computation, check, proof, ...checked];
}

test("assertion-only reviews cannot upgrade standing or the positive review facet", async () => {
  const rows = await corpus();
  for (const basis of ["Looks right.", "**Looks correct!**", "I agree.", " ", undefined]) {
    const reviews = await Promise.all(
      rows.slice(3).map((review) => changedPayload(review, { basis, body_md: "Looks right." })),
    );
    const folded = await foldScientificRows([...rows.slice(0, 3), ...reviews]);
    expect(folded.disposition).toBe("open");
    expect(folded.context.verified_reviews).toHaveLength(0);
    expect(reviewStateFromRecordedReviews(folded.reviewFacets)).toBe("unreviewed");
  }
  const substantive = await changedPayload(rows[3] as Row, {
    basis: "The equality looks right because reflexivity applies to this exact integer.",
    body_md: "Verified.",
  });
  const checked = await foldScientificRows([...rows.slice(0, 3), substantive]);
  expect(checked.disposition).toBe("corroborated");
  expect(reviewStateFromRecordedReviews(checked.reviewFacets)).toBe("independently-checked");
});

test("an assertion-only negative review contests its version without weighted disposition", async () => {
  const rows = await corpus();
  const review = await changedPayload(rows[3] as Row, {
    basis: "Looks wrong.",
    body_md: "I disagree.",
    verdict: "refute",
    verification: undefined,
  });
  const folded = await foldScientificRows([...rows.slice(0, 3), review]);
  expect(folded.disposition).toBe("open");
  expect(folded.context.verified_reviews).toHaveLength(0);
  expect(reviewStateFromRecordedReviews(folded.reviewFacets)).toBe("contested");
});

test("original arguments and constructions gain standing through review, not a higher class", async () => {
  for (const kind of ["argument", "construction"]) {
    const rows = await originalWriteUpCorpus(kind);
    const before = rows[3].payload_json;
    if (before === null) throw new Error("Expected the original proof payload");
    expect((await foldScientificRows(rows.slice(0, 4))).disposition).toBe("open");
    expect((await foldScientificRows(rows.slice(0, 5))).disposition).toBe("corroborated");
    const fold = await foldScientificRows(rows);
    expect(fold.disposition).toBe("strongly-supported");
    expect(fold.stale).toBe(false);
    expect(fold.context.has_certified_artifact).toBe(false);
    expect(rows[3].payload_json).toBe(before);
    expect(JSON.parse(before).computed_class).toBe("assertion");
    expect((await foldScientificRows(rows.filter((source) => source.seq !== 3))).disposition).toBe(
      "open",
    );
  }
});

test("original write-up reviews retain weight, independence and exact-content requirements", async () => {
  const rows = await originalWriteUpCorpus();
  const reviews = rows.slice(4);
  for (const change of [
    { capable_of_failure: undefined },
    { tier: "T0" },
    {
      verification: {
        kind: "full-write-up",
        target_digest: targetDigest,
        evidence: { evidence_id: "E-original", digest: `sha256:${"0".repeat(64)}` },
        coverage: ["Complete write-up."],
        result: "verified",
      },
    },
  ]) {
    const changed = await Promise.all(reviews.map((review) => changedPayload(review, change)));
    expect((await foldScientificRows([...rows.slice(0, 4), ...changed])).disposition).toBe("open");
  }
  const hidden = rows.map((source) =>
    source.object_id === "E-original" ? { ...source, payload_json: null } : source,
  );
  const fold = await foldScientificRows(hidden);
  expect(fold.disposition).toBe("open");
  expect(fold.stale).toBe(true);
  const proof = rows[3];
  const withdrawal = await row(
    7,
    "object.retracted",
    {
      target_object: proof.object_id,
      target_event_id: proof.event_id,
      target_kind: "evidence",
      target_digest: `sha256:${proof.payload_sha256}`,
      claim_id: "C-1",
      claim_version: 1,
    },
    {
      object_id: "RT-7",
      withdrawn_event_id: proof.event_id,
      withdrawn_kind: "evidence",
      withdrawn_sha256: proof.payload_sha256,
    },
  );
  expect((await foldScientificRows([...rows, withdrawal])).disposition).toBe("open");
});

test("a reviewed original proof cannot rely on assertion or unknown-class ancestors", async () => {
  for (const computed_class of ["assertion", "heuristic", undefined, null, "invented"]) {
    const rows = await originalWriteUpCorpus();
    const ancestor = await row(
      4,
      "evidence.created",
      {
        bears_on_kind: "claim",
        bears_on_id: "C-1",
        bears_on_version: 1,
        kind: "argument",
        direction: "supports",
        mode: "confirmatory",
        computed_class,
        body_md: "An unestablished premise cannot become authority through another proof.",
      },
      { object_id: "E-ancestor", direction: "supports" },
    );
    const proof = await changedPayload(
      { ...rows[3], seq: 5, event_id: "EVENT-5" },
      {
        falsification_check: {
          target_digest: targetDigest,
          attempted_falsifier: "The asserted premise is false.",
          capable_of_failure: "A counterexample to the premise.",
          result: "survived",
          evidence: [{ evidence_id: "E-ancestor", digest: `sha256:${ancestor.payload_sha256}` }],
        },
      },
    );
    const reviews = await Promise.all(
      rows.slice(4).map((review) =>
        changedPayload(
          { ...review, seq: review.seq + 1, event_id: `EVENT-${review.seq + 1}` },
          {
            verification: {
              kind: "full-write-up",
              target_digest: targetDigest,
              evidence: { evidence_id: "E-original", digest: `sha256:${proof.payload_sha256}` },
              coverage: ["Full argument including its declared dependency."],
              result: "verified",
            },
          },
        ),
      ),
    );
    const fold = await foldScientificRows([...rows.slice(0, 3), ancestor, proof, ...reviews]);
    expect(fold.disposition).toBe("open");
    expect(fold.context.recorded_refutation_attempts).toBe(1);
    expect(fold.context.verified_reviews).toHaveLength(0);
    expect(fold.stale).toBe(true);
  }
});

test("strong support requires the exact publication's verified disclosure coverage", async () => {
  const rows = await corpus();
  expect((await foldScientificRows(rows)).disposition).toBe("strongly-supported");
  for (const status of ["missing", "unresolved", "unavailable", "invented", null, undefined]) {
    const withheld = await foldScientificRows([
      { ...rows[0]!, directive_disclosure: status },
      ...rows.slice(1),
    ]);
    expect(withheld.disposition).toBe("corroborated");
    expect(withheld.context.verified_reviews).toHaveLength(2);
    expect(withheld.directiveDisclosure).toBe(
      status === "missing" || status === "unresolved" ? status : "unavailable",
    );
  }
});

test("caller text and a review's metadata cannot substitute for sponsor disclosure", async () => {
  const rows = await corpus();
  const forged = await changedPayload(rows[0]!, {
    directive_disclosure: "satisfied",
    attested_no_undisclosed_directives: true,
  });
  const folded = await foldScientificRows([
    { ...forged, directive_disclosure: undefined },
    ...rows.slice(1).map((entry) => ({ ...entry, directive_disclosure: "satisfied" })),
  ]);
  expect(folded.disposition).toBe("corroborated");
  expect(folded.directiveDisclosure).toBe("unavailable");
});

test("legacy tiers and checkbox verification are disclosed but cannot create strong support", async () => {
  const rows = await corpus(true);
  const original = JSON.stringify(rows);
  const fold = await foldScientificRows(rows);
  expect(fold.disposition).toBe("corroborated");
  expect(fold.legacyReviews).toBe(2);
  expect(fold.context.verified_reviews.map((review) => review.tier)).toEqual(["T1", "T1"]);
  expect(fold.context.has_certified_artifact).toBe(false);
  expect(JSON.stringify(rows)).toBe(original);
  const sameSponsor = rows.map((item) => ({ ...item, sponsor_id: "S-author" }));
  expect((await foldScientificRows(sameSponsor)).disposition).toBe("open");
});

test("grounded current-policy reviews earn support and redacted proof revokes it", async () => {
  const rows = await corpus();
  expect((await foldScientificRows(rows)).disposition).toBe("strongly-supported");
  const redacted = rows.map((item) =>
    item.object_id === "E-1" ? { ...item, payload_json: null } : item,
  );
  const fold = await foldScientificRows(redacted);
  expect(fold.disposition).toBe("open");
  expect(fold.stale).toBe(true);
  expect(fold.context.has_certified_artifact).toBe(false);
});

test("unavailable evidence ancestors remove derived checks and positive verification weight", async () => {
  const original = await corpus();
  const ancestor = await row(
    2,
    "evidence.created",
    {
      bears_on_kind: "claim",
      bears_on_id: "C-1",
      bears_on_version: 1,
      kind: "argument",
      direction: "supports",
      mode: "confirmatory",
      computed_class: "citation",
      body_md: "The underlying equality law is the premise of the proof.",
    },
    { object_id: "E-ancestor", direction: "supports" },
  );
  const proof = await changedPayload(
    { ...original[1]!, seq: 3, event_id: "EVENT-3" },
    {
      falsification_check: {
        target_digest: targetDigest,
        attempted_falsifier: "The underlying equality law fails for this instance.",
        capable_of_failure: "The values would be unequal.",
        result: "survived",
        evidence: [
          { evidence_id: ancestor.object_id, digest: `sha256:${ancestor.payload_sha256}` },
        ],
      },
    },
  );
  const reference = { evidence_id: proof.object_id, digest: `sha256:${proof.payload_sha256}` };
  const check = await changedPayload(
    { ...original[2]!, seq: 4, event_id: "EVENT-4" },
    {
      falsification_check: {
        ...JSON.parse(original[2]!.payload_json!).falsification_check,
        evidence: [reference],
      },
    },
  );
  const reviews = await Promise.all(
    original.slice(3).map((review) =>
      changedPayload(
        { ...review, seq: review.seq + 1, event_id: `EVENT-${review.seq + 1}` },
        {
          verification: { ...JSON.parse(review.payload_json!).verification, evidence: reference },
        },
      ),
    ),
  );
  const rows = [original[0]!, ancestor, proof, check, ...reviews];
  expect((await foldScientificRows(rows)).disposition).toBe("strongly-supported");
  for (const unavailable of [
    [{ ...ancestor, payload_json: null }],
    [{ ...ancestor, payload_sha256: "0".repeat(64) }],
    [],
  ]) {
    const selected = [rows[0]!, ...unavailable, ...rows.slice(2)];
    const folded = await foldScientificRows(selected);
    expect(folded.disposition).toBe("open");
    expect(folded.stale).toBe(true);
    expect(folded.context.recorded_refutation_attempts).toBe(0);
    expect(folded.context.verified_reviews).toHaveLength(0);
    expect(folded.context.has_certified_artifact).toBe(false);
    const defect = await changedPayload(reviews[0]!, { rubric: ["statement-defect"] });
    expect((await foldScientificRows([...selected.slice(0, -2), defect])).disposition).toBe(
      "malformed",
    );
    const objection = await changedPayload(reviews[0]!, { verdict: "refute" });
    expect((await foldScientificRows([...selected.slice(0, -2), objection])).disposition).toBe(
      "disputed",
    );
  }
  expect((await foldScientificRows(rows)).disposition).toBe("strongly-supported");
});

test("unrelated unavailable evidence does not remove independently grounded support", async () => {
  const rows = await corpus();
  const unrelated = await row(
    6,
    "evidence.created",
    {},
    { object_id: "E-unrelated", direction: "informs", payload_json: null },
  );
  const folded = await foldScientificRows([...rows, unrelated]);
  expect(folded.disposition).toBe("strongly-supported");
  expect(folded.context.verified_reviews).toHaveLength(2);
  expect(folded.context.recorded_refutation_attempts).toBe(1);
  expect(folded.stale).toBe(true);
});

test("missing or unknown recorded evidence classes cannot supply positive authority", async () => {
  for (const computed_class of [undefined, null, "numerical", "invented", 5]) {
    const rows = await corpus();
    const proof = await changedPayload(rows[1]!, { computed_class });
    const reference = { evidence_id: proof.object_id, digest: `sha256:${proof.payload_sha256}` };
    const selected = await Promise.all(
      rows.map(async (source, index) => {
        if (index === 1) return proof;
        if (index < 2) return source;
        const payload = JSON.parse(source.payload_json!);
        return changedPayload(
          source,
          index === 2
            ? { falsification_check: { ...payload.falsification_check, evidence: [reference] } }
            : { verification: { ...payload.verification, evidence: reference } },
        );
      }),
    );
    const folded = await foldScientificRows(selected);
    expect(folded.disposition).toBe("open");
    expect(folded.context.recorded_refutation_attempts).toBe(0);
    expect(folded.context.verified_reviews).toHaveLength(0);
    expect(folded.stale).toBe(true);
  }
});

test("unavailable claim content cannot regain support through retraction authorship lookup", async () => {
  for (const legacy of [false, true]) {
    const rows = await corpus(legacy);
    const creation = rows[0];
    if (!creation) throw new Error("Expected a claim creation");
    for (const unavailable of [
      { ...creation, payload_json: null },
      { ...creation, payload_sha256: "0".repeat(64) },
    ]) {
      const selected = [unavailable, ...rows.slice(1)];
      const folded = await foldScientificRows(selected);
      expect(folded.disposition).toBe("open");
      expect(folded.stale).toBe(true);
      expect(folded.context.recorded_refutation_attempts).toBe(0);
      expect(folded.context.verified_reviews).toEqual([]);
      const retraction = await row(
        10,
        "object.retracted",
        {
          retraction_id: "R-1",
          target_object: "C-1",
          reason: "Original author corrects the record.",
        },
        { object_id: "R-1" },
      );
      expect((await foldScientificRows([...selected, retraction])).disposition).toBe("withdrawn");
      expect(
        (await foldScientificRows([...selected, { ...retraction, fellow_id: "F-imposter" }]))
          .disposition,
      ).toBe("open");
    }
  }
});

test("a retraction payload cannot withdraw a different version from its recorded target", async () => {
  const rows = await corpus();
  const wrongPin = await row(
    10,
    "object.retracted",
    {
      retraction_id: "R-1",
      target_object: "C-1@2",
      reason: "Withdraw only the second version.",
    },
    { object_id: "R-1", target_version: 1 },
  );
  const folded = await foldScientificRows([...rows, wrongPin]);
  expect(folded.disposition).toBe("strongly-supported");
  expect(folded.stale).toBe(true);
});

test("duplicate publications of one check count once; assertion-only checks do not count", async () => {
  const rows = await corpus();
  const check = rows[2];
  if (!check?.payload_json) throw new Error("Expected the published check");
  const duplicate = { ...check, event_id: "EVENT-6", object_id: "E-DUPLICATE", seq: 6 };
  const folded = await foldScientificRows([...rows, duplicate]);
  expect(folded.context.recorded_refutation_attempts).toBe(1);
  const payload = JSON.stringify({
    ...JSON.parse(check.payload_json),
    computed_class: "assertion",
  });
  rows[2] = { ...check, payload_json: payload, payload_sha256: await sha256Hex(payload) };
  const ungrounded = await foldScientificRows(rows);
  expect(ungrounded.disposition).toBe("open");
  expect(ungrounded.context.recorded_refutation_attempts).toBe(0);
});

test("unavailable refutation stays disputed and old-version staleness does not infect a fresh head", async () => {
  const rows = await corpus();
  const refutation = await row(
    6,
    "evidence.created",
    {},
    {
      direction: "refutes",
      object_id: "E-REFUTE",
      payload_json: null,
    },
  );
  const disputed = await foldScientificRows([...rows, refutation]);
  expect(disputed.disposition).toBe("disputed");
  expect(disputed.stale).toBe(true);
  const revision = await row(
    7,
    "claim.revised",
    {},
    {
      object_id: "C-1",
      object_version: 2,
      target_version: 2,
      content_digest: `sha256:${"b".repeat(64)}`,
      statement: "The natural number two equals itself.",
    },
  );
  const fresh = await foldScientificRows([...rows, refutation, revision]);
  expect(fresh.disposition).toBe("open");
  expect(fresh.stale).toBe(false);
  expect(fresh.context.verified_reviews).toHaveLength(0);
});

test("redacted weight-carrying refuting review cannot silently clear its contest", async () => {
  const rows = await corpus();
  const review = await row(
    6,
    "review.created",
    {},
    {
      weighted_refutation: 1,
      payload_json: null,
      fellow_id: "F-refuter",
      sponsor_id: "S-refuter",
    },
  );
  const folded = await foldScientificRows([...rows, review]);
  expect(folded.disposition).toBe("disputed");
  expect(folded.stale).toBe(true);
});

test("digest corruption, invalid JSON and selection-contaminated proof cannot carry support", async () => {
  for (const mutation of ["wrong-hash", "invalid-json", "selected", "heuristic"]) {
    const rows = await corpus();
    const proof = rows[1];
    if (!proof?.payload_json) throw new Error("Expected the public proof fixture");
    const body = JSON.parse(proof.payload_json);
    const payload =
      mutation === "invalid-json"
        ? "{"
        : JSON.stringify({
            ...body,
            ...(mutation === "selected" ? { selected_hypothesis_id: "H-1" } : {}),
            ...(mutation === "heuristic" ? { computed_class: "heuristic" } : {}),
          });
    rows[1] = {
      ...proof,
      payload_json: payload,
      payload_sha256: mutation === "wrong-hash" ? "0".repeat(64) : await sha256Hex(payload),
    };
    if (mutation === "selected" || mutation === "heuristic") {
      // Rebind every dependent reference to the newly published content so
      // this tests its scientific eligibility, not a coincidental hash miss.
      for (let index = 2; index < rows.length; index++) {
        const dependent = rows[index];
        if (!dependent?.payload_json) throw new Error("Expected a dependent public record");
        const body = JSON.parse(dependent.payload_json);
        const reference = { evidence_id: "E-1", digest: `sha256:${rows[1].payload_sha256}` };
        if (body.falsification_check) body.falsification_check.evidence = [reference];
        if (body.verification) body.verification.evidence = reference;
        const content = JSON.stringify(body);
        rows[index] = {
          ...dependent,
          payload_json: content,
          payload_sha256: await sha256Hex(content),
        };
      }
    }
    const fold = await foldScientificRows(rows);
    expect(fold.disposition, mutation).toBe("open");
    expect(fold.stale, mutation).toBe(true);
  }
});

test("author retraction transitions claim to withdrawn, while non-author retraction is ignored", async () => {
  const baseRows = await corpus();
  // Valid author retraction
  const authorRetraction = await row(
    10,
    "object.retracted",
    {
      retraction_id: "R-1",
      target_object: "C-1",
      retraction_kind: "self-corrected",
      reason: "Calculation error in equality premise.",
    },
    { object_id: "R-1", fellow_id: "F-author" },
  );
  const folded = await foldScientificRows([...baseRows, authorRetraction]);
  expect(folded.disposition).toBe("withdrawn");
  expect(folded.stale).toBe(false);

  // Non-author retraction attempt
  const nonAuthorRetraction = await row(
    10,
    "object.retracted",
    {
      retraction_id: "R-2",
      target_object: "C-1",
      retraction_kind: "self-corrected",
      reason: "Attempt by non-author to retract.",
    },
    { object_id: "R-2", fellow_id: "F-imposter" },
  );
  const foldedNonAuthor = await foldScientificRows([...baseRows, nonAuthorRetraction]);
  // Claim remains supported by the valid reviews
  expect(foldedNonAuthor.disposition).toBe("strongly-supported");
});

test("redacted retraction payload marks stale but never cosmetically restores support", async () => {
  const baseRows = await corpus();
  // Retraction with redacted payload (payload_json is null)
  const redactedRetraction: Row = {
    claim_id: "C-1",
    event_id: "EVENT-10",
    seq: 10,
    type: "object.retracted",
    object_id: "R-REDACTED",
    object_version: 1,
    target_version: 1,
    payload_json: null,
    payload_sha256: "0".repeat(64),
    fellow_id: "F-author",
    sponsor_id: "S-author",
    content_digest: null,
    statement: null,
    direction: null,
  };
  const folded = await foldScientificRows([...baseRows, redactedRetraction]);
  // Stays withdrawn, marked stale
  expect(folded.disposition).toBe("withdrawn");
  expect(folded.stale).toBe(true);
});

test("author retraction transitions disputed claim to withdrawn, and terminal withdrawal resists subsequent reviews", async () => {
  const baseRows = await corpus();
  // Add a refuting evidence row that disputes the claim
  const refutingEvidence = await row(
    6,
    "evidence.created",
    {
      bears_on_kind: "claim",
      bears_on_id: "C-1",
      bears_on_version: 1,
      kind: "counterexample",
      direction: "refutes",
      body_md: "Two does not equal three.",
    },
    { object_id: "E-REFUTE", direction: "refutes" },
  );
  // Author retracts
  const authorRetraction = await row(
    7,
    "object.retracted",
    {
      retraction_id: "R-3",
      target_object: "C-1",
      retraction_kind: "externally-refuted",
      reason: "Conceding after counterexample.",
    },
    { object_id: "R-3", fellow_id: "F-author" },
  );
  // A subsequent review attempts to corroborate
  const lateReview = await row(
    8,
    "review.created",
    {
      tier: "T2",
      basis: "Checked the exact equality statement by reflexivity.",
      body_md: "The exact integer equals itself.",
      capable_of_failure: "An unequal result.",
      verdict: "confirm",
      independence_policy: SCIENTIFIC_INDEPENDENCE_POLICY,
      scientific_provenance: { model_family_self_declared: "claude" },
    },
    { object_id: "R-LATE", fellow_id: "F-reviewer", sponsor_id: "S-other" },
  );

  const folded = await foldScientificRows([
    ...baseRows,
    refutingEvidence,
    authorRetraction,
    lateReview,
  ]);
  // Withdrawn is terminal; subsequent reviews cannot revive it
  expect(folded.disposition).toBe("withdrawn");
});
