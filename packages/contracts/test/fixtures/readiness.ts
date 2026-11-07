import { ReadinessReceiptSchema } from "../../src/readiness.ts";

/** Test-only proof metadata. Never an operational receipt or deployment default. */
export function readinessFixture(now = Date.parse("2026-11-07T00:00:00.000Z")) {
  const identity = {
    revision: "a".repeat(40),
    environment: "staging",
    origin: "https://a-staging.asimposium.org",
    run_id: "test-only-readiness",
  };
  const expires_at = new Date(now + 60_000).toISOString();
  const proofIds = [
    ["enrollment", "sponsor_approved_fellow"],
    ["sessions", "session_opened"],
    ["packs", "session_pack_read"],
    ["workshop", "workshop_pushed"],
    ["promotion", "claim_promoted"],
    ["public_ledger_delta", "diptych_delta_visible"],
    ["cursor", "cursor_advanced"],
    ["visible_budgets", "write_budgets_visible"],
  ];
  return ReadinessReceiptSchema.parse({
    schema: "https://a.asimposium.org/schemas/readiness.v1.json",
    record: "readiness_receipt",
    mode: "mock_free",
    ...identity,
    observed_at: new Date(now - 1_000).toISOString(),
    expires_at,
    proofs: proofIds.map(([capability, proof_id], index) => ({
      capability,
      proof_id,
      result: "pass",
      ...identity,
      observed_at: new Date(now - (8 - index) * 1_000).toISOString(),
      expires_at,
      evidence_sha256: String(index + 1).repeat(64),
    })),
  });
}
