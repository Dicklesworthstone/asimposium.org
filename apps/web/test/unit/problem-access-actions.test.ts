import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import type { ProblemAccessActionReceipt, SponsorProblemGovernanceResponse } from "@asimposium/contracts";
import type { StoaCall } from "../../lib/stoa";
import {
  accessMemberCommand, accessMemberReceipt, accessModeCommand, accessModeReceipt,
  accessProblem, accessSponsor, accessWorkspace,
} from "../fixtures/problem-governance";

mock.module("server-only", () => ({}));
let principal: string | null;
let mutationResult: StoaCall<ProblemAccessActionReceipt>;
let readResult: StoaCall<SponsorProblemGovernanceResponse>;
let failMutation: boolean;
let failRead: boolean;
const writes: unknown[][] = [];
const reads: unknown[][] = [];
let authCalls: number;
let realGovernance: typeof import("../../lib/problem-governance");
let realAuth: typeof import("../../auth");
let actions: typeof import("../../app/console/problems/[problem]/access/actions");

beforeAll(async () => {
  realGovernance = { ...(await import("../../lib/problem-governance")) };
  realAuth = { ...(await import("../../auth")) };
  mock.module("@/auth", () => ({ ...realAuth, auth: async () => {
    authCalls++;
    return principal === null ? null : { user: { id: principal } };
  } }));
  mock.module("@/lib/problem-governance", () => ({ ...realGovernance,
    stoaChangeProblemAccess: async (...args: unknown[]) => {
      writes.push(args);
      if (failMutation) throw new Error("PRIVATE_ACCESS_RESPONSE_LOST");
      return mutationResult;
    },
    stoaProblemGovernance: async (...args: unknown[]) => {
      reads.push(args);
      if (failRead) throw new Error("PRIVATE_MEMBERSHIP_READ_FAILED");
      return readResult;
    },
  }));
  const specifier: string = "../../app/console/problems/[problem]/access/actions?hermetic-access-actions-test";
  actions = await import(specifier) as typeof actions;
});
beforeEach(() => {
  principal = accessSponsor;
  authCalls = 0;
  mutationResult = { ok: true, data: accessModeReceipt };
  readResult = { ok: true, data: accessWorkspace };
  failMutation = false;
  failRead = false;
  writes.length = 0;
  reads.length = 0;
});
afterAll(() => {
  mock.module("@/auth", () => realAuth);
  mock.module("@/lib/problem-governance", () => realGovernance);
});

test("every write derives the current account and refuses a changed or missing identity before transport", async () => {
  for (const changed of [null, "person@example.invalid", "usr_fedcba0987654321"]) {
    principal = changed;
    expect(await actions.changeProblemAccess(accessSponsor, accessProblem, accessModeCommand, "key", true))
      .toMatchObject({ ok: false, retryable: false, refreshRequired: true });
  }
  expect(authCalls).toBe(3);
  expect(writes).toHaveLength(0);
  expect(reads).toHaveLength(0);
});

test("explicit consent and a closed access command are required before any write", async () => {
  expect(await actions.changeProblemAccess(accessSponsor, accessProblem, accessModeCommand, "key", false))
    .toMatchObject({ ok: false, retryable: false });
  for (const command of [
    { action: "manage-member", operation: "set-role", target_fellow_id: "fellow-access-c" },
    { ...accessMemberCommand, operation: "remove" },
    { ...accessModeCommand, acting_sponsor_id: accessSponsor },
    { action: "retire", reason: "Unrelated scientific lifecycle command" },
  ]) {
    expect(await actions.changeProblemAccess(accessSponsor, accessProblem,
      command as Parameters<typeof actions.changeProblemAccess>[2], "key", true))
      .toMatchObject({ ok: false, retryable: false });
  }
  expect(await actions.changeProblemAccess(accessSponsor, "P-ACCESS\n", accessModeCommand, "key", true)).toMatchObject({ ok: false });
  expect(await actions.changeProblemAccess(accessSponsor, accessProblem, accessModeCommand, "key\n", true)).toMatchObject({ ok: false });
  expect(await actions.changeProblemAccess(accessSponsor, accessProblem, accessModeCommand, "key", true,
    { after: "", limit: 1000 } as Parameters<typeof actions.changeProblemAccess>[5])).toMatchObject({ ok: false });
  expect(writes).toHaveLength(0);
});

test("an accepted receipt stays distinct from a newer authoritative workspace read", async () => {
  const newer = { ...accessWorkspace, problem: { ...accessWorkspace.problem, admission_mode: "open" as const } };
  readResult = { ok: true, data: newer };
  const result = await actions.changeProblemAccess(accessSponsor, accessProblem, accessModeCommand, "mode-key", true, { after: "fellow-access-0" });
  expect(result).toEqual({ ok: true, receipt: accessModeReceipt, current: newer });
  expect(writes).toEqual([[accessSponsor, accessProblem, accessModeCommand, "mode-key"]]);
  expect(reads).toEqual([[accessSponsor, accessProblem, { after: "fellow-access-0" }]]);
});

test("a lost follow-up read never turns a confirmed command into a failed or invented state", async () => {
  mutationResult = { ok: true, data: accessMemberReceipt };
  for (const throws of [false, true]) {
    failRead = throws;
    readResult = { ok: false, reason: "unreachable" };
    const result = await actions.changeProblemAccess(accessSponsor, accessProblem, accessMemberCommand, "member-key", true);
    expect(result).toEqual({ ok: true, receipt: accessMemberReceipt, current: null });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_MEMBERSHIP_READ_FAILED");
  }
});

test("unknown outcomes preserve the exact request and key for a replay under fresh authority", async () => {
  mutationResult = { ok: false, reason: "unreachable" };
  for (const throws of [false, true]) {
    failMutation = throws;
    expect(await actions.changeProblemAccess(accessSponsor, accessProblem, accessModeCommand, "retained-key", true))
      .toMatchObject({ ok: false, retryable: true });
  }
  expect(reads).toHaveLength(0);
  failMutation = false;
  mutationResult = { ok: true, data: accessModeReceipt };
  const accepted = await actions.changeProblemAccess(accessSponsor, accessProblem, accessModeCommand, "retained-key", true);
  expect(accepted).toMatchObject({ ok: true, receipt: accessModeReceipt });
  expect(writes).toEqual(Array.from({ length: 3 }, () => [accessSponsor, accessProblem, accessModeCommand, "retained-key"]));
  expect(authCalls).toBe(3);
});

test("current-authority refusals, conflicts and invalid-target refusals require a fresh review", async () => {
  for (const status of [400, 401, 403, 404, 409, 422]) {
    mutationResult = { ok: false, reason: "refused", status };
    const result = await actions.changeProblemAccess(accessSponsor, accessProblem, accessModeCommand, "key", true);
    expect(result).toMatchObject({ ok: false, retryable: false, refreshRequired: true });
  }
  expect(reads).toHaveLength(0);
  mutationResult = { ok: false, reason: "unconfigured" };
  expect(await actions.changeProblemAccess(accessSponsor, accessProblem, accessModeCommand, "key", true))
    .toMatchObject({ ok: false, retryable: false });
});
