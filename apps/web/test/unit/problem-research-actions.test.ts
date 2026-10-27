import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import type { ProblemResearchReceipt } from "../../lib/problem-research";
import type { StoaCall } from "../../lib/stoa";
import {
  researchPreview,
  researchProblem,
  researchResolutionReceipt,
  researchResolveCommand,
  researchReviewCommand,
  researchReviewReceipt,
  researchSponsor,
  researchSynthesis,
} from "../fixtures/problem-research";

mock.module("server-only", () => ({}));
let principal: string | null;
let authCalls: number;
let mutationResult: StoaCall<ProblemResearchReceipt>;
let previewResult: Awaited<ReturnType<typeof import("../../lib/problem-research")["stoaProblemClosingSynthesis"]>>;
let failMutation: boolean;
const writes: unknown[][] = [];
const reads: unknown[][] = [];
let realResearch: typeof import("../../lib/problem-research");
let realAuth: typeof import("../../auth");
let actions: typeof import("../../app/console/problems/[problem]/actions");

beforeAll(async () => {
  realResearch = { ...(await import("../../lib/problem-research")) };
  realAuth = { ...(await import("../../auth")) };
  mock.module("@/auth", () => ({ ...realAuth, auth: async () => {
    authCalls++;
    return principal === null ? null : { user: { id: principal } };
  } }));
  mock.module("@/lib/problem-research", () => ({ ...realResearch,
    stoaChangeProblemResearch: async (...args: unknown[]) => {
      writes.push(args);
      if (failMutation) throw new Error("PRIVATE_RESEARCH_RESPONSE_LOST");
      return mutationResult;
    },
    stoaProblemClosingSynthesis: async (...args: unknown[]) => {
      reads.push(args);
      return previewResult;
    },
  }));
  const specifier: string = "../../app/console/problems/[problem]/actions?hermetic-research-actions-test";
  actions = await import(specifier) as typeof actions;
});
beforeEach(() => {
  principal = researchSponsor;
  authCalls = 0;
  mutationResult = { ok: true, data: researchReviewReceipt };
  previewResult = { ok: true, data: researchPreview };
  failMutation = false;
  writes.length = 0;
  reads.length = 0;
});
afterAll(() => {
  mock.module("@/auth", () => realAuth);
  mock.module("@/lib/problem-research", () => realResearch);
});

test("both public actions reauthenticate and an account change cannot discard an earlier uncertain command", async () => {
  for (const changed of [null, "person@example.invalid", "usr_fedcba0987654321"]) {
    principal = changed;
    expect(await actions.previewProblemClosingSynthesis(researchSponsor, researchProblem, researchSynthesis.synthesis_id))
      .toMatchObject({ ok: false, retryable: false, refreshRequired: true });
    expect(await actions.changeProblemResearch(researchSponsor, researchProblem, researchReviewCommand, "key", true))
      .toMatchObject({ ok: false, retryable: false, retainAttempt: true, refreshRequired: true });
  }
  expect(authCalls).toBe(6);
  expect(reads).toHaveLength(0);
  expect(writes).toHaveLength(0);
});

test("explicit confirmation, exact target identifiers and a closed command are required before transport", async () => {
  expect(await actions.changeProblemResearch(researchSponsor, researchProblem, researchReviewCommand, "key", false))
    .toMatchObject({ ok: false, retryable: false, retainAttempt: true });
  for (const input of [
    { ...researchReviewCommand, result_claim: { claim_id: "C-3\n", version: 1 } },
    { ...researchReviewCommand, owner: true },
    { ...researchResolveCommand, closing_synthesis: { ...researchResolveCommand.closing_synthesis, synthesis_id: undefined } },
    { ...researchResolveCommand, external_expert_review_proof: "Unsupported expert assertion." },
    { action: "retire", reason: "Not part of this control." },
  ]) {
    expect(await actions.changeProblemResearch(researchSponsor, researchProblem,
      input as Parameters<typeof actions.changeProblemResearch>[2], "key", true))
      .toMatchObject({ ok: false, retryable: false, retainAttempt: true });
  }
  expect(await actions.changeProblemResearch(researchSponsor, "P-RESEARCH\n", researchReviewCommand, "key", true))
    .toMatchObject({ ok: false });
  expect(await actions.changeProblemResearch(researchSponsor, researchProblem, researchReviewCommand, "key\n", true))
    .toMatchObject({ ok: false });
  expect(await actions.previewProblemClosingSynthesis(researchSponsor, researchProblem, "SYNTH-CLOSING\n"))
    .toMatchObject({ ok: false });
  expect(writes).toHaveLength(0);
  expect(reads).toHaveLength(0);
});

test("preview returns only the verified closing work product and its derived immutable command", async () => {
  expect(await actions.previewProblemClosingSynthesis(researchSponsor, researchProblem, researchSynthesis.synthesis_id))
    .toEqual({ ok: true, preview: researchPreview });
  expect(reads).toEqual([[researchSponsor, researchProblem, researchSynthesis.synthesis_id]]);
  expect(writes).toHaveLength(0);
  previewResult = { ok: false, reason: "invalid-closing", issue: "body-too-long" };
  const oversized = await actions.previewProblemClosingSynthesis(researchSponsor, researchProblem, researchSynthesis.synthesis_id);
  expect(oversized).toMatchObject({ ok: false, retryable: false });
  if (!oversized.ok) {
    expect(oversized.message).toContain("8,192");
    expect(oversized.message).toContain("Fellow");
    expect(oversized.message).toContain("cannot be shortened here");
  }
});

test("lost replies recover through the identical signed command without a new preview or mutable status read", async () => {
  mutationResult = { ok: false, reason: "unreachable" };
  for (const throws of [false, true]) {
    failMutation = throws;
    const unknown = await actions.changeProblemResearch(researchSponsor, researchProblem, researchResolveCommand, "recover-resolution", true);
    expect(unknown).toMatchObject({ ok: false, retryable: true, retainAttempt: true });
    expect(JSON.stringify(unknown)).not.toContain("PRIVATE_RESEARCH_RESPONSE_LOST");
  }
  failMutation = false;
  mutationResult = { ok: true, data: researchResolutionReceipt };
  // A source may have disappeared after successful terminal publication. It
  // cannot prevent recovery, because this action never invokes the preview.
  previewResult = { ok: false, reason: "refused", status: 404 };
  expect(await actions.changeProblemResearch(researchSponsor, researchProblem, researchResolveCommand, "recover-resolution", true))
    .toEqual({ ok: true, receipt: researchResolutionReceipt });
  expect(reads).toHaveLength(0);
  expect(writes).toEqual(Array.from({ length: 3 }, () => [researchSponsor, researchProblem, researchResolveCommand, "recover-resolution"]));
  expect(authCalls).toBe(3);
});

test("typed stale-source conflicts settle the attempt, while unknown and identity conflicts preserve it", async () => {
  mutationResult = { ok: false, reason: "refused", status: 409, problemCode: "OBJECT_VERSION_CONFLICT" };
  const stale = await actions.changeProblemResearch(researchSponsor, researchProblem, researchResolveCommand, "stale", true);
  expect(stale).toMatchObject({ ok: false, retryable: false, refreshRequired: true });
  if (!stale.ok) expect(stale.retainAttempt).toBeUndefined();
  for (const problemCode of [undefined, "IDEMPOTENCY_CONFLICT"] as const) {
    mutationResult = { ok: false, reason: "refused", status: 409, problemCode };
    expect(await actions.changeProblemResearch(researchSponsor, researchProblem, researchResolveCommand, "uncertain", true))
      .toMatchObject({ ok: false, retryable: false, retainAttempt: true, refreshRequired: true });
  }
});

test("only an authenticated typed contract refusal can settle a pending scientific transition", async () => {
  mutationResult = { ok: false, reason: "refused", status: 422, problemCode: "PREMATURE_RESOLUTION",
    detail: "UNTRUSTED_WORKER_TEXT_MUST_NOT_BE_DISPLAYED" };
  const refused = await actions.changeProblemResearch(researchSponsor, researchProblem, researchResolveCommand, "refused", true);
  expect(refused).toMatchObject({ ok: false, retryable: false, refreshRequired: true });
  if (!refused.ok) expect(refused.retainAttempt).toBeUndefined();
  expect(JSON.stringify(refused)).not.toContain("UNTRUSTED_WORKER_TEXT");
  for (const result of [
    { ok: false, reason: "unconfigured" },
    { ok: false, reason: "refused", status: 401 },
    { ok: false, reason: "refused", status: 403 },
    { ok: false, reason: "refused", status: 404 },
    { ok: false, reason: "refused", status: 422 },
    { ok: false, reason: "refused", status: 503 },
  ] as const) {
    mutationResult = result;
    expect(await actions.changeProblemResearch(researchSponsor, researchProblem, researchResolveCommand, "uncertain", true))
      .toMatchObject({ ok: false, retainAttempt: true });
  }
  expect(reads).toHaveLength(0);
});
