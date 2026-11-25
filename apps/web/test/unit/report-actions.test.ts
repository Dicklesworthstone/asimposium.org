import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReportRequest, ReportResponse } from "@asimposium/contracts";
import type { ReportActionState, ReportTarget } from "../../lib/report-submission";
import type { StoaCall } from "../../lib/stoa";

const SPONSOR = "usr_report_action";
const TARGET = { problem_id: "P-4DSP", target: "C-1@2" };
const RECEIPT: ReportResponse = {
  ...TARGET,
  report_id: `RP-${"0".repeat(26)}`,
  status: "pending",
  deduplicated: false,
  target_hidden: false,
};

function form(reason = "integrity", note = "Inspect the source citation anchor."): FormData {
  const value = new FormData();
  value.set("reason", reason);
  value.set("note", note);
  return value;
}

// Bun's module mocks share a registry across files. Keep these authenticated
// server-action assertions in their own real test process, without changing
// the production authentication seam or leaking a mock into neighboring suites.
if (process.env.ASIMPOSIUM_REPORT_ACTION_TEST_CHILD !== import.meta.path) {
  test("receipt-backed report action assertions pass in an isolated Bun process", async () => {
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "test",
        "--no-orphans",
        "/dev/null",
        "--timeout=120000",
        import.meta.path,
      ],
      cwd: import.meta.dir,
      env: { ...process.env, ASIMPOSIUM_REPORT_ACTION_TEST_CHILD: import.meta.path },
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 110_000);
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (timedOut)
        throw new Error(
          `Report action child exceeded its 110-second deadline:\n${stdout}\n${stderr}`,
        );
      if (exitCode !== 0) throw new Error(`Report action assertions failed:\n${stdout}\n${stderr}`);
      expect(exitCode).toBe(0);
      expect(stderr).toMatch(/\b10 pass\b/);
      expect(stderr).toMatch(/\b0 fail\b/);
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  }, 120_000);
} else {
  mock.module("server-only", () => ({}));
  describe("receipt-backed sponsor reporting", () => {
    let realAuth: typeof import("../../auth");
    let realStoa: typeof import("../../lib/stoa");
    let submit: typeof import("../../app/report/actions").reportContentAction;
    let sponsor: string | null = SPONSOR;
    let result: StoaCall<ReportResponse> = { ok: true, data: RECEIPT };
    let failAuth = false;
    let throwAfterDispatch = false;
    const calls: { sponsor: string; request: ReportRequest; key: string }[] = [];

    beforeAll(async () => {
      realAuth = { ...(await import("../../auth")) };
      realStoa = { ...(await import("../../lib/stoa")) };
      mock.module("@/auth", () => ({
        ...realAuth,
        auth: async () => {
          if (failAuth) throw new Error("Authentication temporarily unavailable");
          return sponsor === null ? null : { user: { id: sponsor } };
        },
      }));
      mock.module("@/lib/stoa", () => ({
        ...realStoa,
        stoaSponsorReport: async (principal: string, request: ReportRequest, key: string) => {
          calls.push({ sponsor: principal, request, key });
          if (throwAfterDispatch) throw new Error("Response lost after the report committed");
          return result;
        },
      }));
      const specifier: string = "../../app/report/actions.ts?report-action-unit";
      submit = (await import(specifier)).reportContentAction;
    });

    beforeEach(() => {
      sponsor = SPONSOR;
      result = { ok: true, data: RECEIPT };
      throwAfterDispatch = false;
      failAuth = false;
      calls.length = 0;
      mock.module("@/auth", () => ({
        ...realAuth,
        auth: async () => {
          if (failAuth) throw new Error("Authentication temporarily unavailable");
          return sponsor === null ? null : { user: { id: sponsor } };
        },
      }));
      mock.module("@/lib/stoa", () => ({
        ...realStoa,
        stoaSponsorReport: async (principal: string, request: ReportRequest, key: string) => {
          calls.push({ sponsor: principal, request, key });
          if (throwAfterDispatch) throw new Error("Response lost after the report committed");
          return result;
        },
      }));
    });

    afterAll(() => {
      mock.module("@/auth", () => realAuth);
      mock.module("@/lib/stoa", () => realStoa);
    });

    test("authentication and account changes cannot dispatch a report for the wrong sponsor", async () => {
      for (const value of [null, "someone@example.test", "usr_changed_account"]) {
        sponsor = value;
        const state = await submit(SPONSOR, TARGET, { status: "idle" }, form());
        expect(state.status).toBe("refused");
        if (state.status === "refused")
          expect(state.draft.note).toBe("Inspect the source citation anchor.");
      }
      expect(calls).toEqual([]);
    });

    test("invalid targets, categories and repeated fields are refused before a write", async () => {
      for (const target of [
        { problem_id: "../private", target: "C-1" },
        { problem_id: TARGET.problem_id, target: "W-private" },
        { problem_id: TARGET.problem_id, target: "C-1@0" },
      ])
        expect((await submit(SPONSOR, target, { status: "idle" }, form())).status).toBe("refused");
      expect(
        (await submit(SPONSOR, TARGET, { status: "idle" }, form("wrong-category"))).status,
      ).toBe("refused");
      const repeated = form();
      repeated.append("reason", "spam");
      expect((await submit(SPONSOR, TARGET, { status: "idle" }, repeated)).status).toBe("refused");
      const file = form();
      file.set("note", new File(["not a text field"], "note.txt"));
      expect((await submit(SPONSOR, TARGET, { status: "idle" }, file)).status).toBe("refused");
      expect(calls).toEqual([]);
    });

    test("an authentication service exception retains the private draft for a safe retry", async () => {
      failAuth = true;
      const state = await submit(SPONSOR, TARGET, { status: "idle" }, form());
      expect(state.status).toBe("refused");
      if (state.status !== "refused") return;
      expect(state.draft).toEqual({
        reason: "integrity",
        note: "Inspect the source citation anchor.",
      });
      expect(calls).toEqual([]);
    });

    test("unchanged canonical requests reuse a key without including private prose", async () => {
      const value = form();
      value.set("problem_id", "P-FORGED");
      value.set("target", "C-999");
      value.set("sponsor_id", "usr_forged");
      expect(await submit(SPONSOR, TARGET, { status: "idle" }, value)).toEqual({
        status: "committed",
        receipt: RECEIPT,
      });
      await submit(
        SPONSOR,
        TARGET,
        { status: "idle" },
        form("integrity", "  Inspect the source citation anchor.  "),
      );
      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual(calls[1]);
      expect(calls[0]?.request).toEqual({
        ...TARGET,
        reason: "integrity",
        note: "Inspect the source citation anchor.",
      });
      expect(calls[0]?.key).toMatch(/^sponsor-report-[0-9a-f]{64}$/);
      expect(calls[0]?.key).not.toContain("citation");
      await submit(
        SPONSOR,
        TARGET,
        { status: "idle" },
        form("privacy", "Different operator location."),
      );
      expect(calls[2]?.key).not.toBe(calls[0]?.key);
    });

    test("a lost response preserves the draft and an identical retry recovers the actual receipt", async () => {
      throwAfterDispatch = true;
      const first = await submit(SPONSOR, TARGET, { status: "idle" }, form());
      expect(first.status).toBe("refused");
      if (first.status !== "refused") return;
      expect(first.uncertain).toBe(true);
      expect(first.message).toContain("may already be recorded");
      expect(first.message).not.toContain("Nothing was recorded");
      expect(first.draft).toEqual({
        reason: "integrity",
        note: "Inspect the source citation anchor.",
      });
      throwAfterDispatch = false;
      result = { ok: true, data: { ...RECEIPT, deduplicated: true } };
      const recovered = await submit(
        SPONSOR,
        TARGET,
        first,
        form(first.draft.reason, first.draft.note),
      );
      expect(recovered).toEqual({ status: "committed", receipt: result.data });
      expect(calls[0]).toEqual(calls[1]);
    });

    test("server failures and malformed or mismatched receipts never render a completed report", async () => {
      const failures: StoaCall<ReportResponse>[] = [
        { ok: false, reason: "unreachable" },
        { ok: false, reason: "refused", status: 503 },
        { ok: true, data: { ...RECEIPT, problem_id: "P-OTHER" } },
        { ok: true, data: { ...RECEIPT, target: "C-1@3" } },
        { ok: true, data: { ...RECEIPT, target: "C-2@3", deduplicated: true } },
        { ok: true, data: { ...RECEIPT, target: "C-1@invalid", deduplicated: true } },
        { ok: true, data: { ...RECEIPT, report_id: "invalid" } },
      ];
      for (const failure of failures) {
        result = failure;
        const state = await submit(SPONSOR, TARGET, { status: "idle" }, form());
        expect(state.status).toBe("refused");
        if (state.status === "refused") expect(state.uncertain).toBe(true);
      }
    });

    test("a later authentication refusal does not erase a previously uncertain write", async () => {
      result = { ok: false, reason: "unreachable" };
      const first = await submit(SPONSOR, TARGET, { status: "idle" }, form());
      sponsor = null;
      const second = await submit(SPONSOR, TARGET, first, form());
      expect(second.status).toBe("refused");
      if (second.status !== "refused") return;
      expect(second.uncertain).toBe(true);
      expect(second.signInRequired).toBe(true);
      expect(calls).toHaveLength(1);
    });

    test("canonical scientific target kinds and exact claim versions reach the same report writer", async () => {
      for (const id of [
        "problem",
        "C-1@2",
        "H-1",
        "E-1",
        "R-1",
        "G-1",
        "L-1",
        "DE-1",
        "Q-1",
        "CF-1",
        "SYNTH-1",
      ]) {
        const target: ReportTarget = { problem_id: TARGET.problem_id, target: id };
        result = { ok: true, data: { ...RECEIPT, target: id } };
        const state = await submit(SPONSOR, target, { status: "idle" }, form("spam", ""));
        expect(state.status).toBe("committed");
        expect(calls.at(-1)?.request).toEqual({ ...target, reason: "spam" });
      }
    });

    test("a forged previous success cannot substitute for a new authoritative receipt", async () => {
      result = { ok: false, reason: "refused", status: 403 };
      const previous: ReportActionState = { status: "committed", receipt: RECEIPT };
      const state = await submit(SPONSOR, TARGET, previous, form());
      expect(state.status).toBe("refused");
      expect(calls).toHaveLength(1);
    });

    test("a duplicate may already be resolved and must retain the exact status from Stoa", async () => {
      for (const status of ["dismissed", "upheld"] as const) {
        const receipt = { ...RECEIPT, target: "C-1@1", status, deduplicated: true };
        result = { ok: true, data: receipt };
        expect(await submit(SPONSOR, TARGET, { status: "idle" }, form())).toEqual({
          status: "committed",
          receipt,
        });
      }
    });
  });
}
