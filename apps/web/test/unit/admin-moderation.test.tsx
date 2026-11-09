import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  AdminContentControlRequest,
  AdminQuarantineDecisionRequest,
  AdminReportResolutionRequest,
} from "@asimposium/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import type { AdminModerationKind, AdminModerationState } from "../../lib/admin-moderation";
import type { StoaCall } from "../../lib/stoa";

mock.module("server-only", () => ({}));

const OPERATOR = "usr_operator_moderation";
const CASE = `QC-${"0".repeat(26)}`;
const REPORT = `RP-${"0".repeat(26)}`;
const AT = "2026-11-09T00:00:00.000Z";
const REASON = "Reviewed the exact published target and its context.";
const KEY = "admin-test-one-logical-command";
const IDLE: AdminModerationState = { status: "idle" };
const commands = {
  quarantine: { case_id: CASE, decision: "release", reason: REASON },
  report: { report_id: REPORT, resolution: "dismiss", reason: REASON },
  content: { target_id: "P-4DSP/C-12", target_kind: "claim", action: "hide", reason: REASON },
} as const;
const receipts = {
  quarantine: { ok: true, case_id: CASE, decision: "release", audit_event_id: "OA-quarantine", decided_at: AT },
  report: { ok: true, report_id: REPORT, resolution: "dismiss", audit_event_id: "OA-report", resolved_at: AT },
  content: { ok: true, target_id: "P-4DSP/C-12", action: "hide", audit_event_id: "OA-content", applied_at: AT },
} as const;

function form(kind: AdminModerationKind): FormData {
  const value = new FormData();
  for (const [name, entry] of Object.entries(commands[kind])) value.set(name, entry);
  value.set("confirmed_review", "yes");
  value.set("expected_operator_id", OPERATOR);
  value.set("idempotency_key", KEY);
  return value;
}

describe("operator moderation commands and honest readback", () => {
  let realStoa: typeof import("../../lib/stoa");
  let realAuth: typeof import("../../auth");
  let actions: typeof import("../../app/admin/actions");
  let controls: typeof import("../../app/admin/moderation-control");
  let AdminPage: typeof import("../../app/admin/page").default;
  let authId: string | null;
  let authTime: number;
  let result: StoaCall<unknown>;
  let throws: boolean;
  let queueState: "ok" | "unreachable" | "unconfigured";
  let oldOperators: string | undefined;
  const calls: { kind: AdminModerationKind; operator: string; request: unknown; key: string }[] = [];

  beforeAll(async () => {
    realStoa = { ...(await import("../../lib/stoa")) };
    realAuth = { ...(await import("../../auth")) };
    oldOperators = process.env.OPERATOR_PRINCIPAL_IDS;
    process.env.OPERATOR_PRINCIPAL_IDS = OPERATOR;
    mock.module("@/auth", () => ({ ...realAuth, auth: async () => authId === null ? null : { user: { id: authId }, authIssuedAt: authTime } }));
    const run = (kind: AdminModerationKind, operator: string, request: unknown, key: string) => {
      calls.push({ kind, operator, request, key });
      if (throws) throw new Error("PRIVATE_BACKEND_FAILURE_MUST_NOT_BE_RENDERED");
      return result;
    };
    mock.module("@/lib/stoa", () => ({
      ...realStoa,
      stoaAdminResolveQuarantine: async (operator: string, request: AdminQuarantineDecisionRequest, key: string) => run("quarantine", operator, request, key),
      stoaAdminResolveReport: async (operator: string, request: AdminReportResolutionRequest, key: string) => run("report", operator, request, key),
      stoaAdminContentControl: async (operator: string, request: AdminContentControlRequest, key: string) => run("content", operator, request, key),
      stoaAdminQuarantineQueue: async () => queueState === "ok" ? { ok: true, data: { items: [], total_pending: 0 } } : { ok: false, reason: queueState },
      stoaAdminReportsQueue: async () => queueState === "ok" ? { ok: true, data: { reports: [], total_pending: 0 } } : { ok: false, reason: queueState },
      stoaAdminAuditHistory: async () => queueState === "ok" ? { ok: true, data: { events: [] } } : { ok: false, reason: queueState },
    }));
    const actionModule: string = "../../app/admin/actions.ts?hermetic-moderation-actions";
    actions = await import(actionModule);
    controls = await import("../../app/admin/moderation-control");
    AdminPage = (await import("../../app/admin/page")).default;
  });
  beforeEach(() => {
    authId = OPERATOR;
    authTime = Math.floor(Date.now() / 1000);
    result = { ok: true, data: receipts.content };
    throws = false;
    queueState = "ok";
    calls.length = 0;
  });
  afterAll(() => {
    mock.module("@/auth", () => realAuth);
    mock.module("@/lib/stoa", () => realStoa);
    if (oldOperators === undefined) delete process.env.OPERATOR_PRINCIPAL_IDS;
    else process.env.OPERATOR_PRINCIPAL_IDS = oldOperators;
  });

  function run(kind: AdminModerationKind, previous = IDLE, input = form(kind)) {
    const apply = kind === "quarantine" ? actions.resolveQuarantineAction
      : kind === "report" ? actions.resolveReportAction : actions.contentControlAction;
    return apply(previous, input);
  }

  test("each command rechecks the same currently authorized operator and recent authentication", async () => {
    for (const kind of ["quarantine", "report", "content"] as const) {
      for (const id of [null, "usr_regular_sponsor", "operator@example.com"]) {
        authId = id;
        expect((await run(kind)).status).toBe("refused");
      }
      authId = OPERATOR;
      authTime = Math.floor(Date.now() / 1000) - 3600;
      expect((await run(kind)).status).toBe("refused");
      authTime = Math.floor(Date.now() / 1000) + 3600;
      expect((await run(kind)).status).toBe("refused");
      authTime = Math.floor(Date.now() / 1000);
    }
    expect(calls).toEqual([]);
  });

  test("another allowlisted account cannot submit a previously rendered operator form", async () => {
    process.env.OPERATOR_PRINCIPAL_IDS = `${OPERATOR},usr_other_operator`;
    authId = "usr_other_operator";
    expect((await run("content")).status).toBe("refused");
    expect(calls).toEqual([]);
    process.env.OPERATOR_PRINCIPAL_IDS = OPERATOR;
  });

  test("confirmed decisions return the matching typed durable audit receipt for every route", async () => {
    for (const kind of ["quarantine", "report", "content"] as const) {
      result = { ok: true, data: receipts[kind] };
      const state = await run(kind);
      expect(state.status).toBe("committed");
      expect(state.status === "committed" && state.receipt.kind).toBe(kind);
      expect(state.status === "committed" && state.receipt.result).toEqual(receipts[kind]);
      expect(calls.at(-1)).toEqual({ kind, operator: OPERATOR, request: commands[kind], key: KEY });
      const html = renderToStaticMarkup(<controls.AdminModerationResult state={state} />);
      expect(html).toContain(receipts[kind].audit_event_id);
      expect(html).toContain(AT);
      expect(html).toContain('role="status"');
    }
  });

  test("refuses missing confirmation, duplicate fields, invalid keys and scientific override fields before dispatch", async () => {
    const missing = form("content"); missing.delete("confirmed_review");
    const duplicate = form("content"); duplicate.append("action", "restore");
    const invalidKey = form("content"); invalidKey.set("idempotency_key", "key\n");
    const emptyReason = form("content"); emptyReason.set("reason", "          ");
    for (const input of [missing, duplicate, invalidKey, emptyReason]) expect((await run("content", IDLE, input)).status).toBe("invalid");
    const recoverable = await run("content", IDLE, invalidKey);
    expect(recoverable.status === "invalid" && recoverable.draft).not.toHaveProperty("idempotency_key");
    for (const field of ["disposition", "scientific_disposition", "claim_disposition", "status_override"]) {
      const input = form("content"); input.set(field, "strongly-supported");
      expect((await run("content", IDLE, input)).status).toBe("invalid");
    }
    expect(calls).toEqual([]);
  });

  test("offers only supported whole-object content controls and never broadens a version pin", async () => {
    for (const [kind, target] of [["commentary", "P-4DSP/COM-1"], ["relation", "P-4DSP/C-1@1-implies-C-2@1"], ["claim", "P-4DSP/C-12@2"], ["problem", "P-4DSP/C-12"], ["claim", "P-4DSP"], ["hypothesis", "P-4DSP/C-12"], ["gap", "P-4DSP/G-1/extra"], ["evidence", "P-4DSP/E-1\n"]]) {
      const input = form("content"); input.set("target_kind", kind!); input.set("target_id", target!);
      expect((await run("content", IDLE, input)).status).toBe("invalid");
    }
    const ban = form("content"); ban.set("action", "ban_sponsor");
    expect((await run("content", IDLE, ban)).status).toBe("invalid");
    expect(calls).toEqual([]);
  });

  test("dispatches every supported scientific whole-object kind with the exact target and receipt", async () => {
    for (const [kind, target] of [
      ["problem", "P-4DSP"], ["claim", "P-4DSP/C-12"],
      ["hypothesis", "P-4DSP/H-01ARZ3NDEKTSV4RRFFQ69G5FAV"],
      ["evidence", "P-4DSP/E-1"], ["review", "P-4DSP/R-1"],
      ["dead_end", "P-4DSP/DE-1"], ["gap", "P-4DSP/G-1"],
      ["citation", "P-4DSP/L-1"], ["question", "P-4DSP/Q-1"],
      ["conflict", "P-4DSP/CF-1"], ["synthesis", "P-4DSP/SYNTH-1"],
      ["retraction", "P-4DSP/R-2"],
    ] as const) {
      const input = form("content");
      input.set("target_kind", kind); input.set("target_id", target);
      result = { ok: true, data: { ...receipts.content, target_id: target } };
      const state = await run("content", IDLE, input);
      expect(state.status).toBe("committed");
      expect(calls.at(-1)).toEqual({
        kind: "content", operator: OPERATOR, key: KEY,
        request: { ...commands.content, target_kind: kind, target_id: target },
      });
    }
    expect(calls).toHaveLength(12);
  });

  test("lost responses retain the exact request and key; retries do not create a new command", async () => {
    result = { ok: false, reason: "unreachable" };
    const first = await run("content");
    expect(first.status).toBe("unconfirmed");
    result = { ok: true, data: receipts.content };
    const replay = await run("content", first);
    expect(replay.status).toBe("committed");
    expect(calls).toEqual([
      { kind: "content", operator: OPERATOR, request: commands.content, key: KEY },
      { kind: "content", operator: OPERATOR, request: commands.content, key: KEY },
    ]);
    await run("content", replay);
    expect(calls).toHaveLength(3);
    expect(calls[2]).toEqual(calls[0]);
  });

  test("caller-supplied success state cannot replace a durable Worker receipt", async () => {
    const forged: AdminModerationState = {
      status: "committed", message: "Forged success must not appear",
      attempt: { kind: "content", key: KEY, request: commands.content },
      receipt: { kind: "content", result: { ...receipts.content, audit_event_id: "OA-forged" } },
    };
    result = { ok: false, reason: "unreachable" };
    const state = await run("content", forged);
    expect(state.status).toBe("unconfirmed");
    expect(state).not.toHaveProperty("receipt");
    expect(JSON.stringify(state)).not.toContain("OA-forged");
    expect(calls).toEqual([{ kind: "content", operator: OPERATOR, request: commands.content, key: KEY }]);
  });

  test("an ambiguous decision cannot change its target, reason, action or retry key", async () => {
    throws = true;
    const first = await run("content");
    expect(first.status).toBe("unconfirmed");
    expect(JSON.stringify(first)).not.toContain("PRIVATE_BACKEND_FAILURE");
    for (const [field, value] of [["target_id", "P-4DSP/C-13"], ["reason", "A different reviewed rationale."], ["action", "restore"], ["idempotency_key", "different-key"]]) {
      const input = form("content"); input.set(field!, value!);
      const next = await run("content", first, input);
      expect(next.status).toBe("unconfirmed");
      expect("attempt" in next && next.attempt).toEqual("attempt" in first && first.attempt);
    }
    expect(calls).toHaveLength(1);
  });

  test("a malformed or foreign receipt cannot be shown as success", async () => {
    for (const [kind, body] of [
      ["quarantine", { ...receipts.quarantine, case_id: "another-case" }],
      ["quarantine", { ...receipts.quarantine, decision: "confirm_rejection" }],
      ["report", { ...receipts.report, report_id: "another-report" }],
      ["report", { ...receipts.report, resolution: "uphold" }],
      ["content", { ...receipts.content, target_id: "P-OTHER/C-1" }],
      ["content", { ...receipts.content, action: "restore" }],
      ["content", { ...receipts.content, audit_event_id: "" }],
    ] as const) {
      result = { ok: true, data: body };
      const state = await run(kind);
      expect(state.status).toBe("unconfirmed");
      expect(state).not.toHaveProperty("receipt");
    }
  });

  test("distinguishes unconfigured, refused and unavailable responses without reflecting internal details", async () => {
    for (const [failure, status] of [
      [{ ok: false, reason: "unconfigured" }, "refused"],
      [{ ok: false, reason: "refused", status: 403 }, "refused"],
      [{ ok: false, reason: "refused", status: 409 }, "refused"],
      [{ ok: false, reason: "refused", status: 503 }, "unconfirmed"],
    ] as const) {
      result = { ...failure, detail: "PRIVATE_OPERATOR_ERROR" };
      const state = await run("content");
      expect(state.status).toBe(status);
      expect(JSON.stringify(state)).not.toContain("PRIVATE_OPERATOR_ERROR");
      expect(state).not.toHaveProperty("receipt");
    }
  });

  test("unavailable queues and audit history do not masquerade as empty state", async () => {
    for (const source of ["unconfigured", "unreachable"] as const) {
      queueState = source;
      const html = renderToStaticMarkup(await AdminPage());
      expect(html).toContain("Pending case counts are unknown");
      expect(html).toContain("Pending report counts are unknown");
      expect(html).toContain("This does not mean that no decisions were recorded");
      expect(html).not.toContain("No items currently pending quarantine review");
      expect(html).not.toContain("No pending reports in queue");
      expect(html).not.toContain("No administrative actions recorded in log");
    }
    queueState = "ok";
    const html = renderToStaticMarkup(await AdminPage());
    expect(html).toContain("No items currently pending quarantine review");
    expect(html).toContain("No pending reports in queue");
    expect(html).toContain("No administrative actions recorded in log");
  });

  test("server-rendered controls retain native forms, confirmation, supported choices and a stable retry key", () => {
    const html = renderToStaticMarkup(<controls.AdminModerationControl operatorId={OPERATOR} kind="content" initialKey={KEY} />);
    expect(html).toContain("<form");
    expect(html).toContain('name="idempotency_key" value="' + KEY + '"');
    expect(html).toContain('name="confirmed_review"');
    for (const kind of ["problem", "claim", "hypothesis", "evidence", "review", "dead_end", "gap", "citation", "question", "conflict", "synthesis", "retraction"]) {
      expect(html).toContain(`value="${kind}"`);
    }
    expect(html).not.toContain('value="relation"');
    expect(html).not.toContain('value="commentary"');
    expect(html).not.toContain('value="ban_sponsor"');
  });
});
