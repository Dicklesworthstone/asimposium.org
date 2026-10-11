import { expect, test } from "bun:test";
import { sha256Hex } from "../../src/krater/krater.ts";
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
      { verdict: "confirm", capable_of_failure: "A failed assumption check.", tier: "T1" },
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
    { verdict: "refute", capable_of_failure: "A precise statement", rubric: ["statement-defect"] },
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
    { object_id: "C-1", content_digest: targetDigest, statement },
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
