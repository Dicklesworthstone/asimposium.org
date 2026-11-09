import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import type {
  ProblemStewardshipActionReceipt,
  SponsorProblemGovernanceResponse,
} from "@asimposium/contracts";
import type { StoaCall } from "../../lib/stoa";
import { accessProblem, accessSponsor } from "../fixtures/problem-governance";
import {
  stewardshipCommand,
  stewardshipReceipt,
  stewardshipWorkspace,
  stewardTarget,
} from "../fixtures/problem-stewardship";

mock.module("server-only", () => ({}));
let principal: string | null;
let result: StoaCall<ProblemStewardshipActionReceipt>;
let read: StoaCall<SponsorProblemGovernanceResponse>;
let throwWrite = false;
let throwRead = false;
const writes: unknown[][] = [];
const reads: unknown[][] = [];
let realGovernance: typeof import("../../lib/problem-governance");
let realAuth: typeof import("../../auth");
let actions: typeof import("../../app/console/problems/[problem]/access/stewardship-actions");
beforeAll(async () => {
  realGovernance = { ...(await import("../../lib/problem-governance")) };
  realAuth = { ...(await import("../../auth")) };
  mock.module("@/auth", () => ({
    ...realAuth,
    auth: async () => (principal === null ? null : { user: { id: principal } }),
  }));
  mock.module("@/lib/problem-governance", () => ({
    ...realGovernance,
    stoaChangeProblemStewardship: async (...args: unknown[]) => {
      writes.push(args);
      if (throwWrite) throw new Error("PRIVATE_WRITE_FAILURE");
      return result;
    },
    stoaProblemGovernance: async (...args: unknown[]) => {
      reads.push(args);
      if (throwRead) throw new Error("PRIVATE_READ_FAILURE");
      return read;
    },
  }));
  const path: string =
    "../../app/console/problems/[problem]/access/stewardship-actions?isolated-stewardship";
  actions = (await import(path)) as typeof actions;
});
beforeEach(() => {
  principal = accessSponsor;
  result = { ok: true, data: stewardshipReceipt };
  read = { ok: true, data: stewardshipWorkspace };
  writes.length = 0;
  reads.length = 0;
  throwWrite = false;
  throwRead = false;
});
afterAll(() => {
  mock.module("@/auth", () => realAuth);
  mock.module("@/lib/problem-governance", () => realGovernance);
});

test("a changed account preserves the original retry rather than dispatching under another principal", async () => {
  for (const changed of [null, stewardTarget, "person@example.invalid"]) {
    principal = changed;
    expect(
      await actions.changeProblemStewardship(
        accessSponsor,
        accessProblem,
        stewardshipCommand,
        "key",
        true,
      ),
    ).toMatchObject({ ok: false, recovery: "retry" });
  }
  expect(writes).toHaveLength(0);
});

test("exact review, explicit confirmation and a different transfer target are required before writing", async () => {
  expect(
    await actions.changeProblemStewardship(
      accessSponsor,
      accessProblem,
      stewardshipCommand,
      "key",
      false,
    ),
  ).toMatchObject({ ok: false, recovery: "edit" });
  expect(
    await actions.changeProblemStewardship(
      accessSponsor,
      accessProblem,
      { ...stewardshipCommand, target_sponsor_id: accessSponsor },
      "key",
      true,
    ),
  ).toMatchObject({ ok: false, recovery: "edit" });
  for (const command of [
    { ...stewardshipCommand, expected_stewardship_version: undefined },
    { ...stewardshipCommand, extra_authority: true },
  ]) {
    expect(
      await actions.changeProblemStewardship(
        accessSponsor,
        accessProblem,
        command as typeof stewardshipCommand,
        "key",
        true,
      ),
    ).toMatchObject({ ok: false, recovery: "edit" });
  }
  expect(writes).toHaveLength(0);
});

test("an accepted transfer remains confirmed when its follow-up current-authority read is refused or lost", async () => {
  read = { ok: false, reason: "refused", status: 404 };
  for (const throws of [false, true]) {
    throwRead = throws;
    expect(
      await actions.changeProblemStewardship(
        accessSponsor,
        accessProblem,
        stewardshipCommand,
        "transfer-key",
        true,
      ),
    ).toEqual({ ok: true, receipt: stewardshipReceipt, current: null });
  }
  expect(writes).toEqual(
    Array.from({ length: 2 }, () => [
      accessSponsor,
      accessProblem,
      stewardshipCommand,
      "transfer-key",
    ]),
  );
});

test("transient or malformed refusals retain the original body/key while canonical conflicts require a reload", async () => {
  for (const failed of [
    { ok: false, reason: "unreachable" },
    { ok: false, reason: "refused", status: 409 },
    { ok: false, reason: "refused", status: 503, problemCode: "WRITE_REFUSED" },
  ] as const) {
    result = failed;
    expect(
      await actions.changeProblemStewardship(
        accessSponsor,
        accessProblem,
        stewardshipCommand,
        "retained",
        true,
      ),
    ).toMatchObject({ ok: false, recovery: "retry" });
  }
  throwWrite = true;
  expect(
    await actions.changeProblemStewardship(
      accessSponsor,
      accessProblem,
      stewardshipCommand,
      "retained",
      true,
    ),
  ).toMatchObject({ ok: false, recovery: "retry" });
  throwWrite = false;
  for (const status of [400, 403, 404, 409, 422]) {
    result = {
      ok: false,
      reason: "refused",
      status,
      problemCode: status === 409 ? "OBJECT_VERSION_CONFLICT" : "WRITE_REFUSED",
    };
    expect(
      await actions.changeProblemStewardship(
        accessSponsor,
        accessProblem,
        stewardshipCommand,
        "retained",
        true,
      ),
    ).toMatchObject({ ok: false, recovery: "reload" });
  }
  expect(reads).toHaveLength(0);
});

test("the original receipt and a later roster are never conflated", async () => {
  if (stewardshipWorkspace.stewardship === undefined)
    throw new Error("Missing fixture stewardship");
  const newer = {
    ...stewardshipWorkspace,
    stewardship: { ...stewardshipWorkspace.stewardship, version: 12 },
  };
  read = { ok: true, data: newer };
  expect(
    await actions.changeProblemStewardship(
      accessSponsor,
      accessProblem,
      stewardshipCommand,
      "key",
      true,
      { steward_after: accessSponsor },
    ),
  ).toEqual({ ok: true, receipt: stewardshipReceipt, current: newer });
  expect(reads).toEqual([[accessSponsor, accessProblem, { steward_after: accessSponsor }]]);
});
