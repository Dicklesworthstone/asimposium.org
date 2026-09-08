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
    fellow_id: "F-author",
    sponsor_id: "S-author",
    content_digest: null,
    statement: null,
    direction: null,
    ...overrides,
  };
}

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
