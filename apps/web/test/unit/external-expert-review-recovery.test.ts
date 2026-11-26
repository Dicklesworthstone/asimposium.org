import { expect, test } from "bun:test";
import {
  clearPendingExternalReview, createPendingExternalReview, externalReviewRecoveryKey,
  parseExternalReviewBoundary, parsePendingExternalReview, persistPendingExternalReview,
} from "../../lib/external-expert-review-recovery";
import { externalReviewInput, externalReviewOperator, externalReviewProblem } from "../fixtures/external-expert-review";

const now = 1_793_016_000_000;
function pending() {
  return createPendingExternalReview(externalReviewOperator, externalReviewProblem, externalReviewInput, "review-retry-key", now);
}
function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); } };
}

test("reload retains the exact operator, attestation, boundary, date and key without reconstruction", () => {
  const saved = storage();
  const attempt = pending();
  persistPendingExternalReview(saved, attempt);
  const raw = saved.getItem(externalReviewRecoveryKey(externalReviewOperator, externalReviewProblem)) ?? "";
  expect(parsePendingExternalReview(raw, externalReviewOperator, externalReviewProblem)).toEqual(attempt);
  expect(() => parsePendingExternalReview(raw, "usr_fedcba0987654321", externalReviewProblem)).toThrow();
  expect(() => parsePendingExternalReview(raw, externalReviewOperator, "P-OTHER")).toThrow();
  expect(() => persistPendingExternalReview(saved, { ...attempt, key: "different-key" })).toThrow("still pending");
  expect(() => persistPendingExternalReview(saved, { ...attempt, input: { ...attempt.input, verdict: "withheld" } })).toThrow("still pending");
  expect(() => clearPendingExternalReview(saved, { ...attempt, key: "different-key" })).toThrow("still pending");
  clearPendingExternalReview(saved, attempt);
  expect(saved.getItem(externalReviewRecoveryKey(externalReviewOperator, externalReviewProblem))).toBeNull();
});

test("malformed or unsafe retained attempts fail closed", () => {
  const attempt = pending();
  for (const value of [
    { ...attempt, unexpected: true }, { ...attempt, key: "key\n" }, { ...attempt, startedAt: -1 },
    { ...attempt, startedAt: Number.MAX_SAFE_INTEGER + 1 }, { ...attempt, version: "other" },
    { ...attempt, input: { ...attempt.input, claim_version: 0 } },
    { ...attempt, input: { ...attempt.input, attestation_sha256: "not-a-digest" } },
  ]) expect(() => parsePendingExternalReview(JSON.stringify(value), externalReviewOperator, externalReviewProblem)).toThrow();
  expect(() => parsePendingExternalReview(" ".repeat(262_145), externalReviewOperator, externalReviewProblem)).toThrow();
  expect(() => persistPendingExternalReview({ getItem: () => null, setItem: () => {} }, attempt)).toThrow("not retained");
  expect(attempt.key).toBe("review-retry-key");
});

test("permanent record keys remain recoverable after arbitrary elapsed time without rotation", () => {
  const saved = storage();
  const original = createPendingExternalReview(externalReviewOperator, externalReviewProblem, externalReviewInput, "permanent-key", 0);
  persistPendingExternalReview(saved, original);
  const raw = saved.getItem(externalReviewRecoveryKey(externalReviewOperator, externalReviewProblem)) ?? "";
  const restored = parsePendingExternalReview(raw, externalReviewOperator, externalReviewProblem);
  expect(restored.startedAt).toBe(0);
  expect(restored.key).toBe("permanent-key");
  expect(restored.input).toEqual(externalReviewInput);
  persistPendingExternalReview(saved, restored);
  expect(saved.getItem(externalReviewRecoveryKey(externalReviewOperator, externalReviewProblem))).toBe(raw);
  expect(() => persistPendingExternalReview(saved, { ...restored, key: "replacement-key" })).toThrow("still pending");
});

test("exact boundary JSON preserves multiline strings, whitespace and array ordering", () => {
  const boundary = {
    verified: ["  First assertion\nwith a second line.  ", "Second assertion."],
    mechanisms: ["Method B", "Method A\n\tincluding the edge case"],
    independence_tiers: ["T2", "T1"],
    remaining_external_validation: ["  External replication\nremains outstanding. "],
  };
  const parsed = parseExternalReviewBoundary(JSON.stringify(boundary, null, 4));
  expect(parsed).toEqual(boundary);
  expect(parseExternalReviewBoundary(JSON.stringify(parsed))).toEqual(boundary);
  const attempt = createPendingExternalReview(externalReviewOperator, externalReviewProblem,
    { ...externalReviewInput, no_claim_boundary: boundary }, "multiline-boundary");
  expect(parsePendingExternalReview(JSON.stringify(attempt), externalReviewOperator, externalReviewProblem).input.no_claim_boundary)
    .toEqual(boundary);
  for (const invalid of [
    "{broken", "null", "[]",
    JSON.stringify({ ...boundary, verified: [] }),
    JSON.stringify({ ...boundary, mechanisms: [42] }),
    JSON.stringify({ ...boundary, extra: "not a boundary field" }),
    JSON.stringify({ verified: ["incomplete"] }),
    " ".repeat(128_001),
  ]) expect(parseExternalReviewBoundary(invalid)).toBeNull();
});
