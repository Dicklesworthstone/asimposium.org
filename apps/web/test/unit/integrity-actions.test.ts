import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import type {
  IntegrityCaseOpenRequest,
  IntegrityCaseResolveRequest,
  IntegrityCaseRespondRequest,
  IntegrityCaseReceipt,
} from "@asimposium/contracts/integrity-cases";
import type { OperatorSessionResult } from "../../lib/admin";
import type { IntegrityActionState } from "../../lib/integrity-view";
import type { StoaCall } from "../../lib/stoa";

if (process.env.ASIMPOSIUM_INTEGRITY_ACTION_TEST_CHILD !== import.meta.path) {
  test("integrity actions enforce auth, revision and exact retries in an isolated Bun process", async () => {
    const child = Bun.spawn({
      cmd: [process.execPath, "test", "--no-orphans", "/dev/null", "--timeout=120000", import.meta.path],
      cwd: import.meta.dir,
      env: { ...process.env, ASIMPOSIUM_INTEGRITY_ACTION_TEST_CHILD: import.meta.path },
      stdout: "pipe", stderr: "pipe",
    });
    const deadline = setTimeout(() => child.kill("SIGKILL"), 110_000);
    try {
      const [exit, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      if (exit !== 0) throw new Error("Integrity action assertions failed:\n" + stdout + "\n" + stderr);
      expect(exit).toBe(0);
      expect(stderr).toMatch(/\b0 fail\b/);
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  }, 120_000);
} else {
  mock.module("server-only", () => ({}));
  const operator = "usr_integrity_operator";
  const sponsor = "usr_integrity_subject";
  const caseId = "IC-" + "0".repeat(25) + "1";
  const reportId = "RP-" + "0".repeat(26);
  const idle: IntegrityActionState = { status: "idle", message: "" };
  let operatorSession: OperatorSessionResult;
  let signedInSponsor: string | null;
  let result: StoaCall<IntegrityCaseReceipt>;
  let throwAfterDispatch = false;
  const calls: { principal: string; request: unknown; key: string; kind: string }[] = [];
  let realAuth: typeof import("../../auth");
  let realAdmin: typeof import("../../lib/admin");
  let realAdapter: typeof import("../../lib/integrity-cases");
  let open: typeof import("../../app/admin/integrity/actions").openIntegrityCaseAction;
  let resolve: typeof import("../../app/admin/integrity/actions").resolveIntegrityCaseAction;
  let respond: typeof import("../../app/console/integrity/actions").respondToIntegrityCaseAction;

  const dispatch = async (kind: string, principal: string, request: unknown, key: string) => {
    calls.push({ kind, principal, request, key });
    if (throwAfterDispatch) throw new Error("Response lost after commit");
    return result;
  };
  beforeAll(async () => {
    realAuth = { ...(await import("../../auth")) };
    realAdmin = { ...(await import("../../lib/admin")) };
    realAdapter = { ...(await import("../../lib/integrity-cases")) };
    mock.module("@/auth", () => ({
      ...realAuth, auth: async () => signedInSponsor === null ? null : { user: { id: signedInSponsor } },
    }));
    mock.module("@/lib/admin", () => ({ ...realAdmin, requireOperatorSession: async () => operatorSession }));
    mock.module("@/lib/integrity-cases", () => ({
      ...realAdapter,
      stoaOpenIntegrityCase: (principal: string, request: IntegrityCaseOpenRequest, key: string) => dispatch("open", principal, request, key),
      stoaResolveIntegrityCase: (principal: string, request: IntegrityCaseResolveRequest, key: string) => dispatch("resolve", principal, request, key),
      stoaRespondToIntegrityCase: (principal: string, request: IntegrityCaseRespondRequest, key: string) => dispatch("respond", principal, request, key),
    }));
    const adminSpecifier: string = "../../app/admin/integrity/actions.ts?integrity-actions-unit";
    const sponsorSpecifier: string = "../../app/console/integrity/actions.ts?integrity-actions-unit";
    const adminActions = await import(adminSpecifier);
    open = adminActions.openIntegrityCaseAction;
    resolve = adminActions.resolveIntegrityCaseAction;
    respond = (await import(sponsorSpecifier)).respondToIntegrityCaseAction;
  });
  beforeEach(() => {
    operatorSession = { state: "authorized", operatorId: operator, authIssuedAt: Math.floor(Date.now() / 1000) - 5 };
    signedInSponsor = sponsor;
    result = { ok: false, reason: "unreachable" };
    throwAfterDispatch = false;
    calls.length = 0;
  });
  afterAll(() => {
    mock.module("@/auth", () => realAuth);
    mock.module("@/lib/admin", () => realAdmin);
    mock.module("@/lib/integrity-cases", () => realAdapter);
  });

  function baseForm(): FormData {
    const form = new FormData();
    form.set("expected_operator_id", operator);
    form.set("expected_sponsor_id", sponsor);
    form.set("report_id", reportId);
    form.set("case_id", caseId);
    form.set("expected_revision", "2");
    form.set("idempotency_key", "integrity-fixed-key");
    return form;
  }
  function openForm(): FormData {
    const form = baseForm();
    form.set("concern", "fabricated-source");
    form.set("summary", "Review this exact source citation.");
    form.set("conflict_declaration", "no-conflict");
    form.set("confirmed_review", "yes");
    form.set("public_notice", "yes");
    return form;
  }
  function resolveForm(): FormData {
    const form = baseForm();
    form.set("outcome", "honest-error");
    form.set("rationale", "The original source was corrected by its author.");
    form.set("conflict_declaration", "no-conflict");
    form.set("confirmed_review", "yes");
    form.append("correction_problem", "P-4DSP");
    form.append("correction_target", "C-1@3");
    return form;
  }
  function responseForm(): FormData {
    const form = baseForm();
    form.set("response", "The archived source supports this response.");
    form.set("confirmed_response", "yes");
    return form;
  }

  test("operator writes require the same allowlisted account and a strict recent auth timestamp", async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const session of [
      { state: "unauthenticated" as const },
      { state: "forbidden" as const, principalId: operator },
      { state: "step_up_required" as const, operatorId: operator, authIssuedAt: now - 901 },
      { state: "authorized" as const, operatorId: "usr_changed", authIssuedAt: now },
      { state: "authorized" as const, operatorId: operator, authIssuedAt: now + 60 },
      { state: "authorized" as const, operatorId: operator, authIssuedAt: now - 901 },
    ]) {
      operatorSession = session;
      expect((await open(idle, openForm())).status).toBe("refused");
      expect((await resolve(idle, resolveForm())).status).toBe("refused");
    }
    expect(calls).toEqual([]);
  });

  test("opening binds the report, no-conflict declaration and actual authentication time", async () => {
    const state = await open(idle, openForm());
    expect(state.status).toBe("unconfirmed");
    if (operatorSession.state !== "authorized") throw new Error("operator fixture");
    expect(calls[0]).toMatchObject({
      kind: "open", principal: operator, key: "integrity-fixed-key",
      request: { report_id: reportId, concern: "fabricated-source", public_notice: true,
        conflict_declaration: "no-conflict", auth_issued_at: operatorSession.authIssuedAt },
    });
    const repeated = openForm();
    repeated.append("concern", "plagiarism");
    expect((await open(idle, repeated)).status).toBe("invalid");
    expect(calls).toHaveLength(1);
  });

  test("outcomes reject mutable claim corrections and unmatched correction pairs", async () => {
    const mutable = resolveForm();
    mutable.set("correction_target", "C-1");
    expect((await resolve(idle, mutable)).status).toBe("invalid");
    const unmatched = resolveForm();
    unmatched.append("correction_problem", "P-4DSP");
    expect((await resolve(idle, unmatched)).status).toBe("invalid");
    expect(calls).toEqual([]);
    expect((await resolve(idle, resolveForm())).status).toBe("unconfirmed");
    expect(calls[0]).toMatchObject({ request: { expected_revision: 2,
      correction_refs: [{ problem_id: "P-4DSP", target_ref: "C-1@3" }] } });
  });

  test("sponsor identity, duplicate fields and stale-page fences are checked before dispatch", async () => {
    for (const value of [null, "someone@example.test", "usr_changed"]) {
      signedInSponsor = value;
      expect((await respond(idle, responseForm())).status).toBe("refused");
    }
    signedInSponsor = sponsor;
    const repeated = responseForm();
    repeated.append("expected_revision", "3");
    expect((await respond(idle, repeated)).status).toBe("invalid");
    expect(calls).toEqual([]);
  });

  test("unknown responses retry the original private body, revision and idempotency key", async () => {
    throwAfterDispatch = true;
    const first = await respond(idle, responseForm());
    expect(first.status).toBe("unconfirmed");
    const changed = responseForm();
    changed.set("response", "Changed text must not replace the retained request.");
    changed.set("idempotency_key", "different-key");
    const second = await respond(first, changed);
    expect(second.status).toBe("unconfirmed");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    changed.set("expected_revision", "3");
    expect((await respond(second, changed)).status).toBe("refused");
    expect(calls).toHaveLength(2);
  });

  test("same-operator re-authentication refreshes only auth context for an unchanged retry", async () => {
    const first = await open(idle, openForm());
    expect(first.status).toBe("unconfirmed");
    const refreshedAt = Math.floor(Date.now() / 1000);
    operatorSession = { state: "authorized", operatorId: operator, authIssuedAt: refreshedAt };
    const changed = openForm();
    changed.set("summary", "Changed text cannot replace the pending case summary.");
    changed.set("idempotency_key", "must-not-replace-key");
    expect((await open(first, changed)).status).toBe("unconfirmed");
    expect(calls).toHaveLength(2);
    const initialCall = calls[0];
    if (initialCall === undefined) throw new Error("Missing original operator command");
    expect(calls[1]).toEqual({
      ...initialCall, request: { ...(initialCall.request as IntegrityCaseOpenRequest), auth_issued_at: refreshedAt },
    });
    operatorSession = { state: "authorized", operatorId: "usr_changed_operator", authIssuedAt: refreshedAt };
    changed.set("expected_operator_id", "usr_changed_operator");
    expect((await open(first, changed)).status).toBe("refused");
    expect(calls).toHaveLength(2);
  });

  test("an expired same-operator session retains uncertain intent until step-up completes", async () => {
    const first = await open(idle, openForm());
    expect(first.status).toBe("unconfirmed");
    if (first.status !== "unconfirmed") throw new Error("Missing retained operator intent");
    const now = Math.floor(Date.now() / 1000);
    operatorSession = { state: "step_up_required", operatorId: operator, authIssuedAt: now - 901 };
    const changed = openForm();
    changed.set("summary", "This edit must not replace the pending operation.");
    changed.set("idempotency_key", "must-not-replace-key");
    const expired = await open(first, changed);
    expect(expired).toMatchObject({ status: "unconfirmed", attempt: first.attempt });
    expect(expired.message).toContain("another tab");
    expect(calls).toHaveLength(1);
    operatorSession = { state: "authorized", operatorId: operator, authIssuedAt: now };
    expect((await open(expired, changed)).status).toBe("unconfirmed");
    expect(calls).toHaveLength(2);
    const initialCall = calls[0];
    if (initialCall === undefined) throw new Error("Missing original operator command");
    expect(calls[1]).toEqual({
      ...initialCall, request: { ...(initialCall.request as IntegrityCaseOpenRequest), auth_issued_at: now },
    });
  });

  test("a durable appeal receipt is the only source of successful appeal feedback", async () => {
    result = { ok: true, data: {
      case_id: caseId, action_id: "IA-" + "0".repeat(25) + "3", revision: 3,
      state: "open", action: "appealed", created_at: "2026-11-24T00:00:00.000Z", appeals_used: 1,
    } };
    const state = await respond(idle, responseForm());
    expect(state.status).toBe("committed");
    expect(state.message).toContain("different operator");
    result = { ok: false, reason: "refused", status: 409 };
    expect((await respond(idle, responseForm())).status).toBe("refused");
  });
}
