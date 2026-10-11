import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  SponsorWorkshopMutationRequest,
  SponsorWorkshopMutationResponse,
} from "@asimposium/contracts";
import type { StoaCall } from "../../lib/stoa";

mock.module("server-only", () => ({}));

const SPONSOR = "usr_workshop_action";
const TARGET = {
  problem_id: "P-4DSP",
  fellow_id: "fellow-01JXYZ",
  workshop_id: `W-${"0".repeat(26)}`,
  expected_workshop_version: 3,
};
const RECEIPT: SponsorWorkshopMutationResponse = {
  schema: "https://a.asimposium.org/schemas/sessions.v1.json",
  problem_id: TARGET.problem_id,
  fellow_id: TARGET.fellow_id,
  workshop_id: TARGET.workshop_id,
  acting_sponsor_id: SPONSOR,
  action: "keep",
  version: 4,
  workshop_seq: 9,
  state: "open",
};

function command(action: string, confirm = false): FormData {
  const form = new FormData();
  form.set("action", action);
  if (confirm) form.set("confirm_promotion", "yes");
  return form;
}

describe("workshop server actions", () => {
  let realStoa: typeof import("../../lib/stoa");
  let realAuth: typeof import("../../auth");
  let realCache: typeof import("next/cache");
  let apply: typeof import("../../app/console/workshop-actions").applyWorkshopAction;
  let authSponsor: string | null = SPONSOR;
  let result: StoaCall<SponsorWorkshopMutationResponse> = { ok: true, data: RECEIPT };
  let refreshThrows = false;
  const calls: {
    principal: string;
    request: SponsorWorkshopMutationRequest;
    key: string;
  }[] = [];
  const refreshes: string[] = [];

  beforeAll(async () => {
    realStoa = { ...(await import("../../lib/stoa")) };
    realAuth = { ...(await import("../../auth")) };
    realCache = { ...(await import("next/cache")) };
    mock.module("@/auth", () => ({
      ...realAuth,
      auth: async () => (authSponsor === null ? null : { user: { id: authSponsor } }),
    }));
    mock.module("@/lib/stoa", () => ({
      ...realStoa,
      stoaSponsorWorkshopMutation: async (
        principal: string,
        request: SponsorWorkshopMutationRequest,
        key: string,
      ) => {
        calls.push({ principal, request, key });
        return result;
      },
    }));
    mock.module("next/cache", () => ({
      ...realCache,
      revalidatePath: (path: string) => {
        if (refreshThrows) throw new Error("A cache refresh failed after the durable receipt");
        refreshes.push(path);
      },
    }));
    const specifier: string = "../../app/console/workshop-actions.ts?hermetic-workshop-actions";
    apply = (await import(specifier)).applyWorkshopAction;
  });

  beforeEach(() => {
    authSponsor = SPONSOR;
    result = { ok: true, data: RECEIPT };
    calls.length = 0;
    refreshes.length = 0;
    refreshThrows = false;
  });

  afterAll(() => {
    mock.module("@/lib/stoa", () => realStoa);
    mock.module("@/auth", () => realAuth);
    mock.module("next/cache", () => realCache);
  });

  test("requires the same current sponsor session before dispatching", async () => {
    for (const principal of [null, "owner@example.com", "usr_another_account"]) {
      authSponsor = principal;
      const response = await apply(SPONSOR, TARGET, { status: "idle" }, command("keep"));
      expect(response.status).toBe("refused");
    }
    expect(calls).toEqual([]);
    expect(refreshes).toEqual([]);
  });

  test("rejects malformed pins and duplicate actions without contacting the Worker", async () => {
    const injectedTarget = { ...TARGET, statement: "Sponsor replacement text" };
    expect(
      (await apply(SPONSOR, injectedTarget, { status: "idle" }, command("promote", true))).status,
    ).toBe("refused");
    expect(
      (
        await apply(
          SPONSOR,
          { ...TARGET, expected_workshop_version: 0 },
          { status: "idle" },
          command("keep"),
        )
      ).status,
    ).toBe("refused");
    const duplicated = command("keep");
    duplicated.append("action", "discard");
    expect((await apply(SPONSOR, TARGET, { status: "idle" }, duplicated)).status).toBe("refused");
    expect(calls).toEqual([]);
  });

  test("publication requires a confirmation of the reviewed revision", async () => {
    const response = await apply(SPONSOR, TARGET, { status: "idle" }, command("promote"));
    expect(response).toEqual({
      status: "refused",
      message: "Confirm publication of this stored Fellow-authored revision before promoting.",
    });
    expect(calls).toEqual([]);
  });

  test("sends only the pinned target and action; retries reuse one idempotency key", async () => {
    const form = command("promote", true);
    form.set("statement", "Untrusted replacement supplied by a browser");
    form.set("expected_workshop_version", "999");
    form.set("acting_sponsor_id", "usr_forged");
    result = { ok: false, reason: "unreachable" };
    const first = await apply(SPONSOR, TARGET, { status: "idle" }, form);
    expect(first.status).toBe("refused");
    await apply(SPONSOR, TARGET, first, form);
    expect(calls).toEqual([
      {
        principal: SPONSOR,
        request: { ...TARGET, action: "promote" },
        key: `workshop-promote-${TARGET.workshop_id}-v3`,
      },
      {
        principal: SPONSOR,
        request: { ...TARGET, action: "promote" },
        key: `workshop-promote-${TARGET.workshop_id}-v3`,
      },
    ]);
    expect(refreshes).toEqual([]);
  });

  test("renders actionable contract refusal and current revision without reporting success", async () => {
    result = {
      ok: false,
      reason: "refused",
      status: 409,
      detail: "Workshop draft version is stale",
      problemCode: "WORKSHOP_VERSION_CONFLICT",
      repair: {
        rule: "A5",
        fixHint: "Refresh and review the current draft before retrying.",
        currentVersion: 4,
      },
    };
    expect(await apply(SPONSOR, TARGET, { status: "idle" }, command("keep"))).toEqual({
      status: "refused",
      message: "Workshop draft version is stale",
      code: "WORKSHOP_VERSION_CONFLICT",
      rule: "A5",
      fixHint: "Refresh and review the current draft before retrying.",
      currentVersion: 4,
    });
    expect(refreshes).toEqual([]);
  });

  test("a screening denial explains the non-publication and appeal without an ambiguous retry", async () => {
    result = {
      ok: false,
      reason: "refused",
      status: 403,
      screening: {
        code: "POLICY_DENIED",
        coarse_category: "harassment",
        appeal: "SPONSOR_APPEAL_AVAILABLE",
      },
      detail: "PRIVATE_SCREENING_DETAIL",
    };
    const state = await apply(SPONSOR, TARGET, { status: "idle" }, command("promote", true));
    expect(state).toEqual({
      status: "refused",
      code: "POLICY_DENIED",
      message:
        "Screening declined publication (category: harassment). The claim has not been published.",
      fixHint:
        "A sponsor appeal is available. Ask a trained operator to review the decision before submitting this revision again.",
    });
    expect(JSON.stringify(state)).not.toContain("PRIVATE_SCREENING_DETAIL");
    expect(JSON.stringify(state)).not.toContain("could not be confirmed");
    expect(refreshes).toEqual([]);
  });

  test("a private screening hold waits for its case and does not report a committed claim", async () => {
    const caseId = `QC-${"0".repeat(26)}`;
    result = {
      ok: false,
      reason: "refused",
      status: 202,
      screening: {
        code: "SCREENING_HOLD",
        coarse_category: "dual-use-boundary",
        appeal: "SPONSOR_APPEAL_AVAILABLE",
        case_id: caseId,
      },
    };
    const state = await apply(SPONSOR, TARGET, { status: "idle" }, command("promote", true));
    expect(state).toEqual({
      status: "refused",
      code: "SCREENING_HOLD",
      message:
        "Publication is held for review (category: dual-use-boundary). The claim has not been published.",
      fixHint: `A sponsor appeal is available. Refer to review case ${caseId} and wait for its decision before trying to publish this revision again.`,
    });
    expect(refreshes).toEqual([]);
  });

  test("a posture hold does not invent a category or an unconfirmed review case", async () => {
    result = {
      ok: false,
      reason: "refused",
      status: 202,
      screening: {
        code: "SCREENING_HOLD",
        posture: "quarantine-first",
        appeal: "SPONSOR_APPEAL_AVAILABLE",
      },
    };
    const state = await apply(SPONSOR, TARGET, { status: "idle" }, command("promote", true));
    expect(state).toEqual({
      status: "refused",
      code: "SCREENING_HOLD",
      message: "This Fellow's public writes are held for review. The claim has not been published.",
      fixHint:
        "Review the Fellow's screening posture in the sponsor console. A sponsor appeal is available. No review case was confirmed. Ask a trained operator to review the hold before submitting this revision again.",
    });
    expect(JSON.stringify(state)).not.toContain("category");
    expect(refreshes).toEqual([]);
  });

  test("a durable receipt refreshes workshop and console; refresh failure cannot undo success", async () => {
    expect(await apply(SPONSOR, TARGET, { status: "idle" }, command("keep"))).toEqual({
      status: "committed",
      receipt: RECEIPT,
    });
    expect(refreshes).toEqual([
      `/console/workshop/${TARGET.fellow_id}/${TARGET.problem_id}`,
      "/console",
    ]);
    refreshThrows = true;
    expect(await apply(SPONSOR, TARGET, { status: "idle" }, command("keep"))).toEqual({
      status: "committed",
      receipt: RECEIPT,
    });
  });
});
