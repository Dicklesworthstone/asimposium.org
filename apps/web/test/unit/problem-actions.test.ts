import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  ProblemPublicationResponse,
  SaveProblemBriefRequest,
  SponsorProblemBrief,
  WithdrawProblemBriefResponse,
} from "@asimposium/contracts";
import type { StoaCall } from "../../lib/stoa.ts";

// Unit scope: the Stoa transport is replaced so the action's own mapping can be
// asserted. The Worker routes these actions call are exercised on real local
// Workerd/D1 by e2e/gauntlet/local-product-flow.mjs (brief save/list, sponsor
// problem list, publish), and in a browser by asimposiumorg-uaw7.
mock.module("server-only", () => ({}));

const SPONSOR = "usr_1234567890abcdef";
const PROBLEM = "P-3D9A180107AC496286CC6D4044";
const BRIEF: SponsorProblemBrief = {
  id: "brief-437ad5f8-248",
  version: 1,
  sponsor_id: SPONSOR,
  title: "Parity of squares",
  statement: "For every integer n with 0 <= n <= 1000, n squared has the same parity as n.",
  falsifier: "An integer n in 0..1000 whose square has the opposite parity to n.",
  motivation: "A calibration problem.",
  areas: ["number-theory"],
  status: "active",
  created_at: "2026-09-24T00:00:00.000Z",
  updated_at: "2026-09-24T00:00:00.000Z",
};
const PUBLISHED: ProblemPublicationResponse = {
  problem: {
    id: PROBLEM,
    title: "Parity of squares",
    status: "sharpening",
    current_statement_version: 1,
    updated_at: "2026-09-24T00:00:00.000Z",
  },
};
const REVIEWED = {
  action: "publish" as const,
  reviewed_statement_version: 1,
  reviewed_digest: "a".repeat(64),
};
function confirmation(accepted = true): FormData {
  const form = new FormData();
  if (accepted) form.set("confirm_publication", "yes");
  return form;
}

describe("sponsor problem actions", () => {
  let realStoa: typeof import("../../lib/stoa.ts");
  let realAuth: typeof import("../../auth.ts");
  let sponsor: string | null = SPONSOR;
  const calls: { kind: string; args: unknown[] }[] = [];
  let saveResult: StoaCall<SponsorProblemBrief> = { ok: true, data: BRIEF };
  let publishResult: StoaCall<ProblemPublicationResponse> = { ok: true, data: PUBLISHED };
  let failPublish = false;
  let failSave = false;
  let withdrawResult: StoaCall<WithdrawProblemBriefResponse>;
  let actions: typeof import("../../app/console/problem-actions.ts");

  beforeAll(async () => {
    realStoa = { ...(await import("../../lib/stoa.ts")) };
    realAuth = { ...(await import("../../auth.ts")) };
    mock.module("@/auth", () => ({
      auth: async () => (sponsor ? { user: { id: sponsor } } : null),
    }));
    mock.module("@/lib/stoa", () => ({
      stoaSaveProblemBrief: async (...args: unknown[]) => {
        calls.push({ kind: "save", args });
        if (failSave) throw new Error("PRIVATE_LOST_BRIEF_RESPONSE");
        return saveResult;
      },
      stoaWithdrawProblemBrief: async (...args: unknown[]) => {
        calls.push({ kind: "withdraw", args });
        return withdrawResult;
      },
      stoaPublishProblem: async (...args: unknown[]) => {
        calls.push({ kind: "publish", args });
        if (failPublish) throw new Error("synthetic lost response");
        return publishResult;
      },
    }));
    const specifier: string = "../../app/console/problem-actions.ts?hermetic-problem-actions-test";
    actions = (await import(specifier)) as typeof import("../../app/console/problem-actions.ts");
  });

  beforeEach(() => {
    calls.length = 0;
    sponsor = SPONSOR;
    failPublish = false;
    failSave = false;
    saveResult = { ok: true, data: BRIEF };
    withdrawResult = { ok: true, data: { withdrawn: true, id: BRIEF.id, version: 2 } };
    publishResult = { ok: true, data: PUBLISHED };
  });

  afterAll(() => {
    mock.module("@/lib/stoa", () => realStoa);
    mock.module("@/auth", () => realAuth);
  });

  test("form input becomes a canonical brief request with trimmed slugs", async () => {
    const request = await actions.briefRequestFromForm({
      title: "  Parity of squares ",
      statement: BRIEF.statement,
      falsifier: BRIEF.falsifier,
      motivation: BRIEF.motivation,
      areas: " Number-Theory , , ",
      assignedFellowId: "",
    });
    expect(request).toEqual({
      title: "Parity of squares",
      statement: BRIEF.statement,
      falsifier: BRIEF.falsifier,
      motivation: BRIEF.motivation,
      areas: ["number-theory"],
    });
  });

  test("a brief without a falsifier or an area is refused before transport", async () => {
    expect(
      await actions.briefRequestFromForm({
        title: "T",
        statement: "S",
        falsifier: "   ",
        motivation: "M",
        areas: "number-theory",
        assignedFellowId: "",
      }),
    ).toBeNull();
    expect(
      await actions.briefRequestFromForm({
        title: "T",
        statement: "S",
        falsifier: "F",
        motivation: "M",
        areas: " , ",
        assignedFellowId: "",
      }),
    ).toBeNull();
  });

  test("brief boundaries preserve authored bytes through the form and sponsor transport", async () => {
    const boundaries = {
      scope: "  Finite integer inputs $0 \\leq n \\leq 1000$.\n",
      out_of_scope: "  Infinite domains and approximate arithmetic.  ",
      success_criteria: "An exact proof over the stated range,\nor a specific counterexample.\n",
    };
    const request = await actions.briefRequestFromForm({
      title: BRIEF.title,
      statement: BRIEF.statement,
      falsifier: BRIEF.falsifier,
      motivation: BRIEF.motivation,
      scope: boundaries.scope,
      outOfScope: boundaries.out_of_scope,
      successCriteria: boundaries.success_criteria,
      areas: "number-theory",
      assignedFellowId: "",
    });
    expect(request).not.toBeNull();
    if (request === null) throw new Error("Expected a complete bounded brief");
    expect(request).toMatchObject(boundaries);
    saveResult = { ok: true, data: { ...BRIEF, ...boundaries } };
    expect((await actions.saveProblemBrief(SPONSOR, request, "console-brief-boundaries")).ok).toBe(
      true,
    );
    expect(calls).toEqual([{ kind: "save", args: [SPONSOR, request, "console-brief-boundaries"] }]);
    expect(calls[0]?.args[1]).toMatchObject(boundaries);
  });

  test("brief forms omit an empty boundary bundle and refuse incomplete or invalid boundaries", async () => {
    const form = {
      title: BRIEF.title,
      statement: BRIEF.statement,
      falsifier: BRIEF.falsifier,
      motivation: BRIEF.motivation,
      areas: "number-theory",
      assignedFellowId: "",
    };
    const legacy = await actions.briefRequestFromForm({
      ...form,
      scope: "",
      outOfScope: "",
      successCriteria: "",
    });
    expect(legacy).not.toBeNull();
    if (legacy === null) throw new Error("Expected an unchanged legacy brief");
    expect(legacy).not.toHaveProperty("scope");
    expect(legacy).not.toHaveProperty("out_of_scope");
    expect(legacy).not.toHaveProperty("success_criteria");
    for (const boundaries of [
      { scope: "Finite integers" },
      { scope: "Finite integers", outOfScope: "Other inputs" },
      { scope: "  \n", outOfScope: "Other inputs", successCriteria: "Proof or counterexample" },
      { scope: "Finite integers", outOfScope: "", successCriteria: "Proof or counterexample" },
      {
        scope: "x".repeat(4097),
        outOfScope: "Other inputs",
        successCriteria: "Proof or counterexample",
      },
    ]) {
      expect(await actions.briefRequestFromForm({ ...form, ...boundaries })).toBeNull();
    }
    const invalid = { ...legacy, scope: "Finite integers" };
    expect((await actions.saveProblemBrief(SPONSOR, invalid, "console-brief-partial")).ok).toBe(
      false,
    );
    expect(calls).toHaveLength(0);
  });

  test("saving requires a signed-in canonical sponsor", async () => {
    sponsor = null;
    calls.length = 0;
    const request = (await actions.briefRequestFromForm({
      title: BRIEF.title,
      statement: BRIEF.statement,
      falsifier: BRIEF.falsifier,
      motivation: BRIEF.motivation,
      areas: "number-theory",
      assignedFellowId: "",
    })) as SaveProblemBriefRequest;
    const result = await actions.saveProblemBrief(SPONSOR, request, "console-brief-1");
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
    sponsor = SPONSOR;
  });

  test("a saved brief is returned; a refused one explains assignment", async () => {
    calls.length = 0;
    const body: SaveProblemBriefRequest = {
      title: BRIEF.title,
      statement: BRIEF.statement,
      falsifier: BRIEF.falsifier,
      motivation: BRIEF.motivation,
      areas: [...BRIEF.areas],
    };
    saveResult = { ok: true, data: BRIEF };
    expect(await actions.saveProblemBrief(SPONSOR, body, "console-brief-2")).toEqual({
      ok: true,
      value: BRIEF,
    });
    expect(calls[0]?.args[0]).toBe(SPONSOR);
    saveResult = { ok: false, reason: "refused", status: 403, problemCode: "BRIEF_NOT_ASSIGNED" };
    const refused = await actions.saveProblemBrief(SPONSOR, body, "console-brief-3");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toContain("assigned Fellow");
  });

  test("editing carries the reviewed version and rejects a changed sponsor before transport", async () => {
    const request = await actions.briefRequestFromForm(
      {
        title: BRIEF.title,
        statement: BRIEF.statement,
        falsifier: BRIEF.falsifier,
        motivation: BRIEF.motivation,
        areas: "number-theory",
        assignedFellowId: "",
      },
      BRIEF,
    );
    if (request === null) throw new Error("Expected a version-pinned edit");
    expect(request).toMatchObject({ id: BRIEF.id, expected_version: 1 });
    sponsor = "usr_fedcba0987654321";
    expect((await actions.saveProblemBrief(SPONSOR, request, "console-brief-edit")).ok).toBe(false);
    expect(
      (await actions.withdrawProblemBrief(SPONSOR, BRIEF.id, 1, "console-brief-withdraw", true)).ok,
    ).toBe(false);
    expect(calls).toHaveLength(0);
    sponsor = SPONSOR;
    saveResult = { ok: true, data: { ...BRIEF, version: 2 } };
    expect((await actions.saveProblemBrief(SPONSOR, request, "console-brief-edit")).ok).toBe(true);
    expect(calls[0]?.args).toEqual([SPONSOR, request, "console-brief-edit"]);
  });

  test("lost acknowledgements preserve retry identity and do not expose private diagnostics", async () => {
    const request = await actions.briefRequestFromForm(
      {
        title: BRIEF.title,
        statement: BRIEF.statement,
        falsifier: BRIEF.falsifier,
        motivation: BRIEF.motivation,
        areas: "number-theory",
        assignedFellowId: "",
      },
      BRIEF,
    );
    if (request === null) throw new Error("Expected a version-pinned edit");
    failSave = true;
    const uncertain = await actions.saveProblemBrief(SPONSOR, request, "console-brief-stable");
    expect(uncertain).toMatchObject({ ok: false, recovery: "retry" });
    expect(JSON.stringify(uncertain)).not.toContain("PRIVATE_LOST_BRIEF_RESPONSE");
    failSave = false;
    saveResult = { ok: true, data: { ...BRIEF, version: 2 } };
    await actions.saveProblemBrief(SPONSOR, request, "console-brief-stable");
    expect(calls).toEqual([
      { kind: "save", args: [SPONSOR, request, "console-brief-stable"] },
      { kind: "save", args: [SPONSOR, request, "console-brief-stable"] },
    ]);
  });

  test("authoritative conflicts permit reload while malformed or transient refusals stay uncertain", async () => {
    const request = {
      title: BRIEF.title,
      statement: BRIEF.statement,
      falsifier: BRIEF.falsifier,
      motivation: BRIEF.motivation,
      areas: [...BRIEF.areas],
      id: BRIEF.id,
      expected_version: 1,
    };
    for (const problemCode of ["BRIEF_VERSION_CONFLICT", "IDEMPOTENCY_CONFLICT"] as const) {
      saveResult = {
        ok: false,
        reason: "refused",
        status: 409,
        problemCode,
        detail: "PRIVATE_REFUSAL_BODY",
      };
      const result = await actions.saveProblemBrief(SPONSOR, request, "console-brief-conflict");
      expect(result).toMatchObject({ ok: false, recovery: "reload" });
      expect(JSON.stringify(result)).not.toContain("PRIVATE_REFUSAL_BODY");
    }
    for (const result of [
      { ok: false, reason: "unreachable" },
      { ok: false, reason: "refused", status: 409 },
      { ok: false, reason: "refused", status: 503, problemCode: "INTERNAL_ERROR" },
    ] as const) {
      saveResult = result;
      expect(
        await actions.saveProblemBrief(SPONSOR, request, "console-brief-unknown"),
      ).toMatchObject({ ok: false, recovery: "retry" });
    }
  });

  test("withdrawal requires confirmation and sends the exact reviewed version and stable key", async () => {
    expect(
      (await actions.withdrawProblemBrief(SPONSOR, BRIEF.id, 1, "console-withdraw", false)).ok,
    ).toBe(false);
    expect(
      (await actions.withdrawProblemBrief(SPONSOR, BRIEF.id, 0, "console-withdraw", true)).ok,
    ).toBe(false);
    expect(calls).toHaveLength(0);
    expect(
      await actions.withdrawProblemBrief(SPONSOR, BRIEF.id, 1, "console-withdraw", true),
    ).toEqual({ ok: true, value: { withdrawn: true, id: BRIEF.id, version: 2 } });
    expect(calls).toEqual([
      { kind: "withdraw", args: [SPONSOR, BRIEF.id, { expected_version: 1 }, "console-withdraw"] },
    ]);
    withdrawResult = {
      ok: false,
      reason: "refused",
      status: 409,
      problemCode: "BRIEF_VERSION_CONFLICT",
    };
    expect(
      await actions.withdrawProblemBrief(SPONSOR, BRIEF.id, 1, "console-withdraw", true),
    ).toMatchObject({ ok: false, recovery: "reload" });
  });

  test("publishing without acknowledgement never reaches Stoa", async () => {
    calls.length = 0;
    const result = await actions.publishProblem(
      SPONSOR,
      PROBLEM,
      REVIEWED,
      { status: "idle" },
      confirmation(false),
    );
    expect(result.status).toBe("refused");
    expect(calls).toHaveLength(0);
  });

  test("a malformed problem id never reaches Stoa", async () => {
    calls.length = 0;
    const result = await actions.publishProblem(
      SPONSOR,
      "../v1/sponsors/panic",
      REVIEWED,
      { status: "idle" },
      confirmation(),
    );
    expect(result.status).toBe("refused");
    expect(calls).toHaveLength(0);
  });

  test("an acknowledged publication reports the Worker's new status", async () => {
    calls.length = 0;
    publishResult = { ok: true, data: PUBLISHED };
    expect(
      await actions.publishProblem(SPONSOR, PROBLEM, REVIEWED, { status: "idle" }, confirmation()),
    ).toEqual({
      status: "committed",
      receipt: PUBLISHED,
    });
    expect(calls[0]?.args).toEqual([
      SPONSOR,
      PROBLEM,
      REVIEWED,
      `console-publish-${REVIEWED.reviewed_digest}`,
    ]);
    publishResult = { ok: false, reason: "refused" } as StoaCall<ProblemPublicationResponse>;
    const refused = await actions.publishProblem(
      SPONSOR,
      PROBLEM,
      REVIEWED,
      { status: "idle" },
      confirmation(),
    );
    expect(refused.status).toBe("refused");
  });

  test("account changes and unreviewed or forged publications never dispatch", async () => {
    for (const identity of [null, "usr_fedcba0987654321", "someone@example.invalid"]) {
      sponsor = identity;
      expect(
        await actions.publishProblem(
          SPONSOR,
          PROBLEM,
          REVIEWED,
          { status: "idle" },
          confirmation(),
        ),
      ).toMatchObject({ status: "refused", reviewRequired: true });
    }
    sponsor = SPONSOR;
    for (const command of [
      { action: "publish" },
      { ...REVIEWED, reviewed_statement_version: 0 },
      { ...REVIEWED, reviewed_digest: "bad" },
      { ...REVIEWED, sponsor_id: SPONSOR },
      { action: "retire", reason: "Different action" },
    ]) {
      expect(
        await actions.publishProblem(
          SPONSOR,
          PROBLEM,
          command as typeof REVIEWED,
          { status: "idle" },
          confirmation(),
        ),
      ).toMatchObject({ status: "refused", reviewRequired: true });
    }
    const repeated = confirmation();
    repeated.append("confirm_publication", "yes");
    expect(
      await actions.publishProblem(SPONSOR, PROBLEM, REVIEWED, { status: "idle" }, repeated),
    ).toMatchObject({ status: "refused", reviewRequired: false });
    expect(calls).toHaveLength(0);
  });

  test("stale review and authority refusals require a fresh inspection", async () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      publishResult = { ok: false, reason: "refused", status };
      expect(
        await actions.publishProblem(
          SPONSOR,
          PROBLEM,
          REVIEWED,
          { status: "idle" },
          confirmation(),
        ),
      ).toMatchObject({ status: "refused", reviewRequired: true });
    }
  });

  test("an uncertain result retains the exact publication key and request on retry", async () => {
    failPublish = true;
    const failed = await actions.publishProblem(
      SPONSOR,
      PROBLEM,
      REVIEWED,
      { status: "idle" },
      confirmation(),
    );
    expect(failed).toMatchObject({ status: "refused", reviewRequired: false });
    if (failed.status === "refused")
      expect(failed.message).toContain("Do not assume it remained private");
    failPublish = false;
    expect(
      await actions.publishProblem(SPONSOR, PROBLEM, REVIEWED, failed, confirmation()),
    ).toEqual({ status: "committed", receipt: PUBLISHED });
    expect(calls[0]?.args).toEqual(calls[1]?.args);
  });

  test("a screening hold stays an unconfirmed exact retry with its review case", async () => {
    const caseId = `QC-${"0".repeat(26)}`;
    publishResult = {
      ok: false,
      reason: "refused",
      status: 202,
      screening: {
        code: "SCREENING_HOLD",
        coarse_category: "injection",
        appeal: "SPONSOR_APPEAL_AVAILABLE",
        case_id: caseId,
      },
    };
    const held = await actions.publishProblem(
      SPONSOR,
      PROBLEM,
      REVIEWED,
      { status: "idle" },
      confirmation(),
    );
    expect(held).toMatchObject({ status: "refused", reviewRequired: false });
    if (held.status === "refused") {
      expect(held.message).toContain(caseId);
      expect(held.message).toContain("Retry this exact formulation after review");
    }
  });
});
