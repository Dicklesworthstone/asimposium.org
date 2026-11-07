import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import {
  canonicalReadinessReceipt,
  generateReadinessSchema,
  ReadinessReceiptSchema,
  ReadinessStatusSchema,
  readinessEnvironmentForOrigin,
  readinessReceiptProblem,
} from "../../src/readiness.ts";
import { readinessFixture } from "../fixtures/readiness.ts";

const now = Date.parse("2026-11-07T00:00:00.000Z");
const fixture = readinessFixture(now);
const expected = { origin: fixture.origin, revision: fixture.revision, now };

describe("revision-bound readiness evidence", () => {
  test("the generated contract accepts the complete receipt and the public status", () => {
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    const validate = ajv.compile(JSON.parse(generateReadinessSchema()));
    expect(validate(fixture)).toBe(true);
    const status = {
      schema: fixture.schema,
      status: "ready",
      receipt_sha256: "f".repeat(64),
      receipt: fixture,
    };
    expect(ReadinessStatusSchema.safeParse(status).success).toBe(true);
    expect(validate(status)).toBe(true);
    expect(readinessReceiptProblem(fixture, expected)).toBeUndefined();
    expect(JSON.parse(canonicalReadinessReceipt(fixture))).toEqual(fixture);
  });

  test("both schema validators reject incomplete, duplicate, unknown, fake, and private evidence", () => {
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    const validate = ajv.compile(JSON.parse(generateReadinessSchema()));
    const negatives = [
      {},
      { ...fixture, proofs: [] },
      { ...fixture, proofs: [fixture.proofs[0]] },
      { ...fixture, proofs: [...fixture.proofs.slice(0, 7), fixture.proofs[0]] },
      { ...fixture, proofs: [...fixture.proofs, fixture.proofs[0]] },
      {
        ...fixture,
        proofs: [
          { ...fixture.proofs[0], proof_id: "endpoint_reachable" },
          ...fixture.proofs.slice(1),
        ],
      },
      { ...fixture, mode: "local_fixture" },
      { ...fixture, secret: "must-not-be-public" },
      {
        ...fixture,
        proofs: [{ ...fixture.proofs[0], private_body: "workshop" }, ...fixture.proofs.slice(1)],
      },
      { ...fixture, expires_at: "tomorrow" },
      { ...fixture, observed_at: `${fixture.observed_at}\n` },
      { ...fixture, revision: `${fixture.revision}\n` },
      { ...fixture, run_id: `${fixture.run_id}\n` },
      {
        ...fixture,
        proofs: [
          { ...fixture.proofs[0], evidence_sha256: `${fixture.proofs[0].evidence_sha256}\n` },
          ...fixture.proofs.slice(1),
        ],
      },
    ];
    for (const value of negatives) {
      expect(ReadinessReceiptSchema.safeParse(value).success).toBe(false);
      expect(validate(value)).toBe(false);
    }
  });

  test("coherence and freshness never borrow proof from another revision, run, origin, or time", () => {
    expect(readinessEnvironmentForOrigin("http://127.0.0.1:8787")).toBeUndefined();
    expect(readinessReceiptProblem(fixture, { ...expected, revision: "b".repeat(40) })).toBe(
      "revision_mismatch",
    );
    expect(
      readinessReceiptProblem(fixture, { ...expected, origin: "https://a.asimposium.org" }),
    ).toBe("origin_mismatch");
    expect(readinessReceiptProblem({ ...fixture, environment: "production" }, expected)).toBe(
      "environment_mismatch",
    );
    expect(readinessReceiptProblem(fixture, { ...expected, now: now - 2_000 })).toBe(
      "future_evidence",
    );
    expect(readinessReceiptProblem(fixture, { ...expected, now: now + 60_000 })).toBe(
      "expired_evidence",
    );
    for (const mismatch of [
      { revision: "b".repeat(40) },
      { environment: "production" },
      { origin: "https://a.asimposium.org" },
      { run_id: "another-run" },
      { observed_at: new Date(now - 20_000).toISOString() },
    ]) {
      const mixed = structuredClone(fixture);
      Object.assign(mixed.proofs[3], mismatch);
      expect(readinessReceiptProblem(mixed, expected)).toBe("mixed_evidence");
    }
    const relabeled = structuredClone(fixture);
    relabeled.expires_at = new Date(now + 120_000).toISOString();
    expect(readinessReceiptProblem(relabeled, expected)).toBe("invalid_evidence");
  });
});
