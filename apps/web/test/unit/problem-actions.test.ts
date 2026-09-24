import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type {
  ProblemPublicationResponse,
  SaveProblemBriefRequest,
  SponsorProblemBrief,
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

describe("sponsor problem actions", () => {
  let realStoa: typeof import("../../lib/stoa.ts");
  let realAuth: typeof import("../../auth.ts");
  let sponsor: string | null = SPONSOR;
  const calls: { kind: string; args: unknown[] }[] = [];
  let saveResult: StoaCall<SponsorProblemBrief> = { ok: true, data: BRIEF };
  let publishResult: StoaCall<ProblemPublicationResponse> = { ok: true, data: PUBLISHED };
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
        return saveResult;
      },
      stoaPublishProblem: async (...args: unknown[]) => {
        calls.push({ kind: "publish", args });
        return publishResult;
      },
    }));
    const specifier: string = "../../app/console/problem-actions.ts?hermetic-problem-actions-test";
    actions = (await import(specifier)) as typeof import("../../app/console/problem-actions.ts");
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
    const result = await actions.saveProblemBrief(request, "console-brief-1");
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
    expect(await actions.saveProblemBrief(body, "console-brief-2")).toEqual({
      ok: true,
      value: BRIEF,
    });
    expect(calls[0]?.args[0]).toBe(SPONSOR);
    saveResult = { ok: false, reason: "refused" } as StoaCall<SponsorProblemBrief>;
    const refused = await actions.saveProblemBrief(body, "console-brief-3");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toContain("assigned Fellow");
  });

  test("publishing without acknowledgement never reaches Stoa", async () => {
    calls.length = 0;
    const result = await actions.publishProblem(PROBLEM, false, "console-publish-x");
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("a malformed problem id never reaches Stoa", async () => {
    calls.length = 0;
    const result = await actions.publishProblem("../v1/sponsors/panic", true, "console-publish-x");
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("an acknowledged publication reports the Worker's new status", async () => {
    calls.length = 0;
    publishResult = { ok: true, data: PUBLISHED };
    expect(await actions.publishProblem(PROBLEM, true, `console-publish-${PROBLEM}`)).toEqual({
      ok: true,
      value: { id: PROBLEM, status: "sharpening" },
    });
    expect(calls[0]?.args.slice(0, 2)).toEqual([SPONSOR, PROBLEM]);
    publishResult = { ok: false, reason: "refused" } as StoaCall<ProblemPublicationResponse>;
    const refused = await actions.publishProblem(PROBLEM, true, `console-publish-${PROBLEM}`);
    expect(refused.ok).toBe(false);
  });
});
