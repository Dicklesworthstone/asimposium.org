import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import type { StatementRevisionReceipt } from "../../lib/problem-statement-proposals";
import type { StoaCall } from "../../lib/stoa";
import {
  revisionCommand,
  revisionProblem,
  revisionReceipt,
  revisionSponsor,
} from "../fixtures/problem-statement-revision";

mock.module("server-only", () => ({}));
let principal: string | null;
let authCalls: number;
let result: StoaCall<StatementRevisionReceipt>;
let throws: boolean;
const writes: unknown[][] = [];
const reads: unknown[][] = [];
let realAuth: typeof import("../../auth");
let realProposals: typeof import("../../lib/problem-statement-proposals");
let actions: typeof import("../../app/console/problems/[problem]/revisions/actions");
beforeAll(async () => {
  realAuth = { ...(await import("../../auth")) };
  realProposals = { ...(await import("../../lib/problem-statement-proposals")) };
  mock.module("@/auth", () => ({
    ...realAuth,
    auth: async () => {
      authCalls++;
      return principal === null ? null : { user: { id: principal } };
    },
  }));
  mock.module("@/lib/problem-statement-proposals", () => ({
    ...realProposals,
    stoaAcceptStatementRevision: async (...args: unknown[]) => {
      writes.push(args);
      if (throws) throw new Error("PRIVATE_BACKEND_DIAGNOSTIC");
      return result;
    },
    stoaStatementRevisionPreview: async (...args: unknown[]) => {
      reads.push(args);
      throw new Error("Preview must not gate sealed replay");
    },
  }));
  const specifier: string =
    "../../app/console/problems/[problem]/revisions/actions?hermetic-statement-revision-actions";
  actions = (await import(specifier)) as typeof actions;
});
beforeEach(() => {
  principal = revisionSponsor;
  authCalls = 0;
  throws = false;
  result = { ok: true, data: revisionReceipt };
  writes.length = 0;
  reads.length = 0;
});
afterAll(() => {
  mock.module("@/auth", () => realAuth);
  mock.module("@/lib/problem-statement-proposals", () => realProposals);
});

test("every acceptance reauthenticates and account changes preserve uncertain attempts", async () => {
  for (const account of [null, "person@example.invalid", "usr_another_sponsor"]) {
    principal = account;
    expect(
      await actions.acceptStatementRevision(
        revisionSponsor,
        revisionProblem,
        revisionCommand,
        "key",
        true,
      ),
    ).toMatchObject({ ok: false, retainAttempt: true, refreshRequired: true });
  }
  expect(authCalls).toBe(3);
  expect(writes).toHaveLength(0);
});

test("confirmation, exact metadata and closed scientific input are required before transport", async () => {
  expect(
    await actions.acceptStatementRevision(
      revisionSponsor,
      revisionProblem,
      revisionCommand,
      "key",
      false,
    ),
  ).toMatchObject({ ok: false, retryable: false, retainAttempt: true });
  for (const command of [
    { ...revisionCommand, statement: "SPONSOR_AUTHORED_REPLACEMENT" },
    { ...revisionCommand, reviewed_digest: "incorrect" },
    { ...revisionCommand, proposal_id: `${revisionCommand.proposal_id}\n` },
    { action: "publish", reviewed_statement_version: 3, reviewed_digest: "b".repeat(64) },
  ])
    expect(
      await actions.acceptStatementRevision(
        revisionSponsor,
        revisionProblem,
        command as typeof revisionCommand,
        "key",
        true,
      ),
    ).toMatchObject({ ok: false });
  expect(
    await actions.acceptStatementRevision(
      revisionSponsor,
      `${revisionProblem}\n`,
      revisionCommand,
      "key",
      true,
    ),
  ).toMatchObject({ ok: false });
  expect(
    await actions.acceptStatementRevision(
      revisionSponsor,
      revisionProblem,
      revisionCommand,
      "key\n",
      true,
    ),
  ).toMatchObject({ ok: false });
  expect(writes).toHaveLength(0);
  expect(reads).toHaveLength(0);
});

test("lost replies recover with the exact command and no mutable source reread", async () => {
  result = { ok: false, reason: "unreachable" };
  expect(
    await actions.acceptStatementRevision(
      revisionSponsor,
      revisionProblem,
      revisionCommand,
      "retained-key",
      true,
    ),
  ).toMatchObject({ ok: false, retryable: true, retainAttempt: true });
  throws = true;
  const failed = await actions.acceptStatementRevision(
    revisionSponsor,
    revisionProblem,
    revisionCommand,
    "retained-key",
    true,
  );
  expect(failed).toMatchObject({ ok: false, retainAttempt: true });
  expect(JSON.stringify(failed)).not.toContain("PRIVATE_BACKEND_DIAGNOSTIC");
  throws = false;
  result = { ok: true, data: revisionReceipt };
  expect(
    await actions.acceptStatementRevision(
      revisionSponsor,
      revisionProblem,
      revisionCommand,
      "retained-key",
      true,
    ),
  ).toEqual({ ok: true, receipt: revisionReceipt });
  expect(writes).toEqual(
    Array.from({ length: 3 }, () => [
      revisionSponsor,
      revisionProblem,
      revisionCommand,
      "retained-key",
    ]),
  );
  expect(reads).toHaveLength(0);
  expect(authCalls).toBe(3);
});

test("only known rejection outcomes release a pending acceptance, without surfacing untrusted prose", async () => {
  result = { ok: false, reason: "refused", status: 409, problemCode: "OBJECT_VERSION_CONFLICT" };
  const stale = await actions.acceptStatementRevision(
    revisionSponsor,
    revisionProblem,
    revisionCommand,
    "key",
    true,
  );
  expect(stale).toMatchObject({ ok: false, retryable: false, refreshRequired: true });
  if (!stale.ok) expect(stale.retainAttempt).toBeUndefined();
  result = {
    ok: false,
    reason: "refused",
    status: 422,
    problemCode: "PROBLEM_LIFECYCLE_BODY_INVALID",
    detail: "UNTRUSTED_RESPONSE_CONTENT",
  };
  const refused = await actions.acceptStatementRevision(
    revisionSponsor,
    revisionProblem,
    revisionCommand,
    "key",
    true,
  );
  if (!refused.ok) expect(refused.retainAttempt).toBeUndefined();
  expect(JSON.stringify(refused)).not.toContain("UNTRUSTED_RESPONSE_CONTENT");
  for (const failure of [
    { ok: false, reason: "unconfigured" },
    { ok: false, reason: "refused", status: 403 },
    { ok: false, reason: "refused", status: 404 },
    { ok: false, reason: "refused", status: 409, problemCode: "IDEMPOTENCY_CONFLICT" },
    { ok: false, reason: "refused", status: 422 },
    { ok: false, reason: "refused", status: 202 },
  ] as const) {
    result = failure;
    expect(
      await actions.acceptStatementRevision(
        revisionSponsor,
        revisionProblem,
        revisionCommand,
        "key",
        true,
      ),
    ).toMatchObject({ ok: false, retainAttempt: true });
  }
});
