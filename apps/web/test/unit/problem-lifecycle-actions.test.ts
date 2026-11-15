import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import type { ProblemWorkspaceReceipt } from "../../lib/problem-lifecycle";
import type { StoaCall } from "../../lib/stoa";
import {
  forkCommand,
  workspaceCases,
  workspaceProblem,
  workspaceSponsor,
} from "../fixtures/problem-lifecycle";

mock.module("server-only", () => ({}));
let principal: string | null;
let authIssuedAt: number | undefined;
let reply: StoaCall<ProblemWorkspaceReceipt>;
let loseReply: boolean;
let failRefresh: boolean;
const writes: unknown[][] = [];
const invalidations: unknown[][] = [];
let realAuth: typeof import("../../auth");
let realTransport: typeof import("../../lib/stoa-problem-lifecycle");
let realCache: typeof import("next/cache");
let actions: typeof import("../../app/console/problems/[problem]/workspace-actions");
beforeAll(async () => {
  realAuth = { ...(await import("../../auth")) };
  realTransport = { ...(await import("../../lib/stoa-problem-lifecycle")) };
  realCache = { ...(await import("next/cache")) };
  mock.module("@/auth", () => ({
    ...realAuth,
    auth: async () => (principal === null ? null : { user: { id: principal }, authIssuedAt }),
  }));
  mock.module("@/lib/stoa-problem-lifecycle", () => ({
    ...realTransport,
    stoaChangeProblemWorkspace: async (...args: unknown[]) => {
      writes.push(args);
      if (loseReply) throw new Error("PRIVATE_SERVER_CANARY");
      return reply;
    },
  }));
  mock.module("next/cache", () => ({
    ...realCache,
    revalidatePath: (...args: unknown[]) => {
      invalidations.push(args);
      if (failRefresh) throw new Error("CACHE_FAILED");
    },
  }));
  const path: string =
    "../../app/console/problems/[problem]/workspace-actions?workspace-action-test";
  actions = (await import(path)) as typeof actions;
});
beforeEach(() => {
  principal = workspaceSponsor;
  authIssuedAt = Math.floor(Date.now() / 1000);
  reply = { ok: true, data: workspaceCases[2].receipt };
  loseReply = false;
  failRefresh = false;
  writes.length = 0;
  invalidations.length = 0;
});
afterAll(() => {
  mock.module("@/auth", () => realAuth);
  mock.module("@/lib/stoa-problem-lifecycle", () => realTransport);
  mock.module("next/cache", () => realCache);
});

test("every workspace write requires the intended recently authenticated sponsor", async () => {
  for (const identity of [null, "person@example.invalid", "usr_fedcba0987654321"]) {
    principal = identity;
    expect(
      await actions.changeProblemWorkspace(
        workspaceSponsor,
        workspaceProblem,
        forkCommand,
        "key",
        true,
      ),
    ).toMatchObject({ ok: false, retryable: false, retainAttempt: true, signInRequired: true });
  }
  principal = workspaceSponsor;
  for (const time of [undefined, 0, Infinity, Math.floor(Date.now() / 1000) + 500]) {
    authIssuedAt = time;
    expect(
      await actions.changeProblemWorkspace(
        workspaceSponsor,
        workspaceProblem,
        forkCommand,
        "key",
        true,
      ),
    ).toMatchObject({ ok: false, retainAttempt: true, signInRequired: true });
  }
  expect(writes).toHaveLength(0);
});

test("confirmation and closed command validation precede any Worker mutation", async () => {
  expect(
    await actions.changeProblemWorkspace(
      workspaceSponsor,
      workspaceProblem,
      forkCommand,
      "key",
      false,
    ),
  ).toMatchObject({ ok: false, retainAttempt: true });
  expect(
    await actions.changeProblemWorkspace(
      workspaceSponsor,
      workspaceProblem,
      { ...forkCommand, statement: "Invented author prose." } as typeof forkCommand,
      "key",
      true,
    ),
  ).toMatchObject({ ok: false });
  expect(
    await actions.changeProblemWorkspace(workspaceSponsor, "../private", forkCommand, "key", true),
  ).toMatchObject({ ok: false });
  expect(
    await actions.changeProblemWorkspace(
      workspaceSponsor,
      workspaceProblem,
      forkCommand,
      "key\n",
      true,
    ),
  ).toMatchObject({ ok: false });
  expect(writes).toHaveLength(0);
  expect(invalidations).toHaveLength(0);
});

test("each lost reply is recovered with the identical command and key, and refresh cannot erase a receipt", async () => {
  for (const { command, receipt } of workspaceCases) {
    writes.length = 0;
    loseReply = true;
    const unknown = await actions.changeProblemWorkspace(
      workspaceSponsor,
      workspaceProblem,
      command,
      "recover-one",
      true,
    );
    expect(unknown).toMatchObject({ ok: false, retryable: true, retainAttempt: true });
    expect(JSON.stringify(unknown)).not.toContain("PRIVATE_SERVER_CANARY");
    loseReply = false;
    reply = { ok: true, data: receipt };
    failRefresh = true;
    expect(
      await actions.changeProblemWorkspace(
        workspaceSponsor,
        workspaceProblem,
        command,
        "recover-one",
        true,
      ),
    ).toEqual({ ok: true, receipt });
    expect(writes).toEqual(
      Array.from({ length: 2 }, () => [workspaceSponsor, workspaceProblem, command, "recover-one"]),
    );
  }
  expect(invalidations).toEqual(Array.from({ length: 3 }, () => ["/", "layout"]));
});

test("unknown, authority and idempotency conflicts retain the attempt; typed stale state permits fresh review", async () => {
  for (const failure of [
    { reason: "unreachable" },
    { reason: "unconfigured" },
    ...[401, 403, 404, 409, 429, 503].map((status) => ({ reason: "refused" as const, status })),
    { reason: "refused", status: 409, problemCode: "IDEMPOTENCY_CONFLICT" },
  ] as const) {
    reply = { ok: false, ...failure };
    expect(
      await actions.changeProblemWorkspace(
        workspaceSponsor,
        workspaceProblem,
        forkCommand,
        "key",
        true,
      ),
    ).toMatchObject({ ok: false, retainAttempt: true });
  }
  reply = {
    ok: false,
    reason: "refused",
    status: 409,
    problemCode: "OBJECT_VERSION_CONFLICT",
    detail: "UNTRUSTED_WORKER_CANARY",
  };
  const stale = await actions.changeProblemWorkspace(
    workspaceSponsor,
    workspaceProblem,
    forkCommand,
    "key",
    true,
  );
  expect(stale).toMatchObject({ ok: false, retryable: false, refreshRequired: true });
  if (!stale.ok) expect(stale.retainAttempt).toBeUndefined();
  expect(JSON.stringify(stale)).not.toContain("UNTRUSTED_WORKER_CANARY");
  expect(invalidations).toHaveLength(0);
});
