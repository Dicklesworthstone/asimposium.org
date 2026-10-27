import { expect, test } from "bun:test";
import type { ProblemResearchCommand } from "../../lib/problem-research";
import {
  clearPendingProblemResearch,
  createPendingProblemResearch,
  PROBLEM_RESEARCH_RETRY_MS,
  parsePendingProblemResearch,
  persistPendingProblemResearch,
  problemResearchAttemptExpired,
  problemResearchRecoveryKey,
} from "../../lib/problem-research-recovery";

const sponsorId = "usr_research_sponsor";
const problemId = "P-RESEARCH";
const now = 1_793_016_000_000;
const resolve: Extract<ProblemResearchCommand, { action: "resolve" }> = {
  action: "resolve",
  direction: "affirmed",
  closing_synthesis: {
    synthesis_id: "SYNTH-CLOSE",
    summary: "Exact published α summary\nwith a second line.",
    no_claim_boundary: {
      verified: ["Finite result only"],
      mechanisms: ["Checked witnesses"],
      independence_tiers: ["T2"],
      remaining_external_validation: ["External replication remains"],
    },
  },
};

function pending(input: ProblemResearchCommand = resolve, key = "console-research-exact-retry") {
  return createPendingProblemResearch(sponsorId, problemId, input, key, now);
}
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

test("reloading retains the exact immutable command, body, boundary and idempotency key", () => {
  const saved = storage();
  const original = structuredClone(resolve);
  const attempt = pending(original);
  persistPendingProblemResearch(saved, attempt);
  original.closing_synthesis.summary = "This later edit must never replace the request";
  original.closing_synthesis.no_claim_boundary.verified[0] = "Changed scope";
  const raw = saved.getItem(problemResearchRecoveryKey(sponsorId, problemId));
  expect(raw).not.toBeNull();
  const restored = parsePendingProblemResearch(raw ?? "", sponsorId, problemId);
  expect(restored).toEqual(attempt);
  expect(restored.input).toEqual(resolve);
  expect(restored.key).toBe("console-research-exact-retry");
  // Re-sending uses this same canonical input; no preview or latest-state reconstruction.
  persistPendingProblemResearch(saved, restored);
  expect(saved.getItem(problemResearchRecoveryKey(sponsorId, problemId))).toBe(raw);
});

test("an unresolved attempt cannot be replaced by a new command, result, body or key", () => {
  const saved = storage();
  const original = pending();
  persistPendingProblemResearch(saved, original);
  for (const replacement of [
    pending(resolve, "console-research-different-key"),
    pending({ ...resolve, direction: "closed-with-negative-result" }),
    pending({
      ...resolve,
      closing_synthesis: { ...resolve.closing_synthesis, summary: "Replacement prose" },
    }),
    pending({ action: "enter-result-review", result_claim: { claim_id: "C-2", version: 2 } }),
    { ...original, startedAt: now + 1 },
  ])
    expect(() => persistPendingProblemResearch(saved, replacement)).toThrow("still pending");
  expect(
    parsePendingProblemResearch(
      saved.getItem(problemResearchRecoveryKey(sponsorId, problemId)) ?? "",
      sponsorId,
      problemId,
    ),
  ).toEqual(original);
});

test("recovery is scoped to the original sponsor and problem, including after reauthentication", () => {
  const raw = JSON.stringify(pending());
  expect(() => parsePendingProblemResearch(raw, "usr_other_sponsor", problemId)).toThrow();
  expect(() => parsePendingProblemResearch(raw, sponsorId, "P-OTHER")).toThrow();
  expect(() => parsePendingProblemResearch(raw, "email@example.invalid", problemId)).toThrow();
  expect(() => parsePendingProblemResearch(raw, sponsorId, `${problemId}\n`)).toThrow();
  expect(problemResearchRecoveryKey(sponsorId, problemId)).not.toBe(
    problemResearchRecoveryKey("usr_other_sponsor", problemId),
  );
  expect(parsePendingProblemResearch(raw, sponsorId, problemId).input).toEqual(resolve);
});

test("malformed retained commands and unpinned or unsupported resolution requests fail closed", () => {
  const base = pending();
  const invalid = [
    { ...base, extra: "untrusted" },
    { ...base, key: "console-research-key\n" },
    { ...base, key: "x".repeat(161) },
    { ...base, startedAt: -1 },
    { ...base, startedAt: Number.MAX_SAFE_INTEGER + 1 },
    { ...base, input: { action: "retire", reason: "unsupported" } },
    {
      ...base,
      input: { action: "enter-result-review", result_claim: { claim_id: "C-1", version: 0 } },
    },
    {
      ...base,
      input: { action: "enter-result-review", result_claim: { claim_id: "C-1\n", version: 2 } },
    },
    {
      ...base,
      input: {
        action: "enter-result-review",
        result_claim: { claim_id: "C-1", version: Number.MAX_SAFE_INTEGER + 1 },
      },
    },
    {
      ...base,
      input: {
        ...resolve,
        closing_synthesis: { ...resolve.closing_synthesis, synthesis_id: undefined },
      },
    },
    {
      ...base,
      input: {
        ...resolve,
        closing_synthesis: { ...resolve.closing_synthesis, synthesis_id: "SYNTH-CLOSE\n" },
      },
    },
    {
      ...base,
      input: { ...resolve, external_expert_review_proof: "This cannot authorize closure" },
    },
    {
      ...base,
      input: { ...resolve, closing_synthesis: { ...resolve.closing_synthesis, summary: "" } },
    },
  ];
  for (const value of invalid)
    expect(() =>
      parsePendingProblemResearch(JSON.stringify(value), sponsorId, problemId),
    ).toThrow();
  expect(() => parsePendingProblemResearch("{broken", sponsorId, problemId)).toThrow();
  expect(() => parsePendingProblemResearch(" ".repeat(262_145), sponsorId, problemId)).toThrow();
});

test("only the exact confirmed attempt can clear retained retry state", () => {
  const saved = storage();
  const attempt = pending();
  persistPendingProblemResearch(saved, attempt);
  expect(() => clearPendingProblemResearch(saved, pending(resolve, "different-key"))).toThrow(
    "still pending",
  );
  expect(saved.getItem(problemResearchRecoveryKey(sponsorId, problemId))).not.toBeNull();
  clearPendingProblemResearch(saved, attempt);
  expect(saved.getItem(problemResearchRecoveryKey(sponsorId, problemId))).toBeNull();
  clearPendingProblemResearch(saved, attempt);
});

test("storage must confirm exact bytes before dispatch, and expiry never mints a replacement key", () => {
  const attempt = pending();
  expect(() =>
    persistPendingProblemResearch({ getItem: () => null, setItem: () => {} }, attempt),
  ).toThrow("could not be retained");
  expect(problemResearchAttemptExpired(attempt, now)).toBe(false);
  expect(problemResearchAttemptExpired(attempt, now + PROBLEM_RESEARCH_RETRY_MS - 1)).toBe(false);
  expect(problemResearchAttemptExpired(attempt, now + PROBLEM_RESEARCH_RETRY_MS)).toBe(true);
  expect(problemResearchAttemptExpired(attempt, now - 1)).toBe(true);
  expect(attempt.key).toBe("console-research-exact-retry");
});
