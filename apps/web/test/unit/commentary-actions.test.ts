import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  COMMENTARY_SCHEMA_ID,
  type CommentaryItem,
  type SponsorBootstrapResponse,
  type SponsorCommentaryPostRequest,
  type SponsorCommentaryTombstoneRequest,
} from "@asimposium/contracts";
import type { StoaCall } from "../../lib/stoa";

mock.module("server-only", () => ({}));

const SPONSOR = "usr_commentary_action";
const TARGET = { problemId: "P-4DSP" };
const OLD_ID = "COMM-0123456789abcdef";
const RECEIPT = {
  schema: COMMENTARY_SCHEMA_ID,
  commentary_id: "COMM-abcdef0123456789",
  problem_id: TARGET.problemId,
  seq: 12,
  sponsor_id: SPONSOR,
  body: "The boundary case needs a separate argument.",
  relates_to: [],
  supersedes_commentary_id: null,
  superseded_by_commentary_id: null,
  tombstoned: false,
  tombstone_reason: null,
  created_at: "2026-10-11T12:00:00.000Z",
  updated_at: "2026-10-11T12:00:00.000Z",
} satisfies CommentaryItem;

function command(action = "post"): FormData {
  const form = new FormData();
  form.set("action", action);
  form.set("attempt_id", "browser-intent-0123456789");
  if (action === "post") form.set("body", RECEIPT.body ?? "");
  else form.set("confirm_removal", "yes");
  return form;
}

describe("public commentary server actions", () => {
  let realStoa: typeof import("../../lib/stoa");
  let realAuth: typeof import("../../auth");
  let realPublic: typeof import("../../lib/public-ledger");
  let realCache: typeof import("next/cache");
  let apply: typeof import("../../app/console/commentary-actions").applyCommentaryAction;
  let authSponsor: string | null = SPONSOR;
  let publicProblem: string | undefined = TARGET.problemId;
  let bootstrap: StoaCall<SponsorBootstrapResponse>;
  let result: StoaCall<CommentaryItem>;
  let throwsAfterDispatch = false;
  let refreshThrows = false;
  const calls: {
    action: "post" | "tombstone";
    principal: string;
    request: SponsorCommentaryPostRequest | SponsorCommentaryTombstoneRequest;
    key: string;
  }[] = [];
  const bootstraps: string[] = [];
  const publicReads: string[] = [];
  const refreshes: string[] = [];

  beforeAll(async () => {
    realStoa = { ...(await import("../../lib/stoa")) };
    realAuth = { ...(await import("../../auth")) };
    realPublic = { ...(await import("../../lib/public-ledger")) };
    realCache = { ...(await import("next/cache")) };
    mock.module("@/auth", () => ({
      ...realAuth,
      auth: async () => (authSponsor === null ? null : { user: { id: authSponsor } }),
    }));
    mock.module("@/lib/public-ledger", () => ({
      ...realPublic,
      stoaFetchProblemFace: async (problem: string) => {
        publicReads.push(problem);
        return publicProblem === undefined
          ? { state: "not_found" }
          : { state: "ok", data: { problem: publicProblem } };
      },
    }));
    mock.module("@/lib/stoa", () => ({
      ...realStoa,
      stoaBootstrapSponsor: async (principal: string) => {
        bootstraps.push(principal);
        return bootstrap;
      },
      stoaPostCommentary: async (
        principal: string,
        request: SponsorCommentaryPostRequest,
        key: string,
      ) => {
        calls.push({ action: "post", principal, request, key });
        if (throwsAfterDispatch) throw new Error("Connection lost after dispatch");
        return result;
      },
      stoaTombstoneCommentary: async (
        principal: string,
        request: SponsorCommentaryTombstoneRequest,
        key: string,
      ) => {
        calls.push({ action: "tombstone", principal, request, key });
        return result;
      },
    }));
    mock.module("next/cache", () => ({
      ...realCache,
      revalidatePath: (path: string) => {
        if (refreshThrows) throw new Error("Cache unavailable after durable write");
        refreshes.push(path);
      },
    }));
    const specifier: string = "../../app/console/commentary-actions.ts?hermetic-commentary-actions";
    apply = (await import(specifier)).applyCommentaryAction;
  });

  beforeEach(() => {
    authSponsor = SPONSOR;
    publicProblem = TARGET.problemId;
    bootstrap = {
      ok: true,
      data: { sponsor_id: SPONSOR, created: true, bootstrapped_at: 1791720000 },
    };
    result = { ok: true, data: RECEIPT };
    calls.length = 0;
    bootstraps.length = 0;
    publicReads.length = 0;
    refreshes.length = 0;
    throwsAfterDispatch = false;
    refreshThrows = false;
  });

  afterAll(() => {
    mock.module("@/lib/stoa", () => realStoa);
    mock.module("@/lib/public-ledger", () => realPublic);
    mock.module("@/auth", () => realAuth);
    mock.module("next/cache", () => realCache);
  });

  test("anonymous, malformed and switched accounts cannot bootstrap or write", async () => {
    for (const principal of [null, "sponsor@example.org", "usr_someone_else"]) {
      authSponsor = principal;
      expect((await apply(SPONSOR, TARGET, { status: "idle" }, command())).status).toBe("refused");
    }
    expect(bootstraps).toEqual([]);
    expect(publicReads).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("ambiguous form values and invalid references refuse before any service request", async () => {
    const duplicateBody = command();
    duplicateBody.append("body", "Another browser value");
    const duplicateAction = command();
    duplicateAction.append("action", "tombstone");
    const badReference = command();
    badReference.set("reference_kind", "public-agent-instruction");
    badReference.set("reference_id", "C-1");
    badReference.set("reference_label", "Label");
    const longText = command();
    longText.set("body", "x".repeat(2001));
    for (const form of [duplicateBody, duplicateAction, badReference, longText]) {
      expect((await apply(SPONSOR, TARGET, { status: "idle" }, form)).status).toBe("refused");
    }
    expect(bootstraps).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("a signed-in first-time sponsor can comment only on the exact confirmed public problem", async () => {
    for (const destination of [undefined, "P-OTHER"]) {
      publicProblem = destination;
      expect((await apply(SPONSOR, TARGET, { status: "idle" }, command())).status).toBe("refused");
    }
    expect(calls).toEqual([]);
    publicProblem = TARGET.problemId;
    bootstrap = {
      ok: true,
      data: { sponsor_id: "usr_someone_else", created: false, bootstrapped_at: 1 },
    };
    expect((await apply(SPONSOR, TARGET, { status: "idle" }, command())).status).toBe("refused");
    expect(calls).toEqual([]);
    bootstrap = { ok: true, data: { sponsor_id: SPONSOR, created: true, bootstrapped_at: 1 } };
    expect((await apply(SPONSOR, TARGET, { status: "idle" }, command())).status).toBe("committed");
    expect(calls).toHaveLength(1);
    expect(bootstraps.every((principal) => principal === SPONSOR)).toBe(true);
  });

  test("post intent is normalized, actor-bound and stable across an uncertain retry", async () => {
    const form = command();
    form.set("body", `  ${RECEIPT.body}\n`);
    form.set("sponsor_id", "usr_forged");
    form.set("supersedes_commentary_id", "COMM-ffffffffffffffff");
    form.set("reference_kind", "claim");
    form.set("reference_id", " C-1 ");
    form.set("reference_label", " boundary case ");
    result = { ok: false, reason: "unreachable" };
    const first = await apply(SPONSOR, TARGET, { status: "idle" }, form);
    expect(first).toMatchObject({ status: "refused", uncertain: true, action: "post" });
    await apply(SPONSOR, TARGET, first, form);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(calls[1]);
    expect(calls[0]?.request).toEqual({
      problem_id: TARGET.problemId,
      body: RECEIPT.body,
      relates_to: [{ kind: "claim", id: "C-1", label: "boundary case" }],
    });
    expect(calls[0]?.principal).toBe(SPONSOR);
    expect(calls[0]?.key).toMatch(/^commentary-post-[a-f0-9]{64}$/);
    expect(calls[0]?.key).not.toContain(SPONSOR);
    expect(refreshes).toEqual([]);
  });

  test("correction pins the viewed immutable entry and removal requires its explicit confirmation", async () => {
    const target = { ...TARGET, commentaryId: OLD_ID };
    await apply(SPONSOR, target, { status: "idle" }, command());
    expect(calls[0]?.request).toEqual({
      problem_id: TARGET.problemId,
      body: RECEIPT.body,
      relates_to: [],
      supersedes_commentary_id: OLD_ID,
    });
    const removal = command("tombstone");
    removal.delete("confirm_removal");
    expect((await apply(SPONSOR, target, { status: "idle" }, removal)).status).toBe("refused");
    expect(calls).toHaveLength(1);
    removal.set("confirm_removal", "yes");
    removal.set("commentary_id", "COMM-ffffffffffffffff");
    removal.set("reason", "legal");
    await apply(SPONSOR, target, { status: "idle" }, removal);
    expect(calls[1]?.request).toEqual({
      problem_id: TARGET.problemId,
      commentary_id: OLD_ID,
      reason: "author_request",
    });
    expect(calls[1]?.key).not.toBe(calls[0]?.key);
  });

  test("policy refusal uses only canonical safe category and appeal guidance", async () => {
    result = {
      ok: false,
      reason: "refused",
      status: 403,
      detail: "PRIVATE_CLASSIFIER_DETAIL",
      screening: {
        code: "POLICY_DENIED",
        coarse_category: "harassment",
        appeal: "SPONSOR_APPEAL_AVAILABLE",
      },
    };
    const state = await apply(SPONSOR, TARGET, { status: "idle" }, command());
    expect(state).toMatchObject({ status: "refused", code: "POLICY_DENIED", action: "post" });
    expect(JSON.stringify(state)).toContain("has not been published");
    expect(JSON.stringify(state)).not.toContain("PRIVATE_CLASSIFIER_DETAIL");
    expect(JSON.stringify(state)).not.toContain("could not be confirmed");
    expect(refreshes).toEqual([]);
  });

  test("lost responses preserve retry identity even if a later public read fails", async () => {
    throwsAfterDispatch = true;
    const form = command();
    const first = await apply(SPONSOR, TARGET, { status: "idle" }, form);
    expect(first).toMatchObject({
      status: "refused",
      uncertain: true,
      attemptId: form.get("attempt_id"),
    });
    publicProblem = undefined;
    expect(await apply(SPONSOR, TARGET, first, form)).toMatchObject({
      status: "refused",
      uncertain: true,
    });
    expect(calls).toHaveLength(1);
  });

  test("an unresolved write stays pinned across identity/bootstrap refusal until the receipt is recovered", async () => {
    result = { ok: false, reason: "unreachable" };
    const form = command();
    const first = await apply(SPONSOR, TARGET, { status: "idle" }, form);
    const firstKey = calls[0]?.key;
    bootstrap = { ok: false, reason: "refused", status: 401 };
    const bootstrapRefusal = await apply(SPONSOR, TARGET, first, form);
    expect(bootstrapRefusal).toMatchObject({
      status: "refused",
      uncertain: true,
      action: "post",
      attemptId: form.get("attempt_id"),
    });
    authSponsor = null;
    const identityRefusal = await apply(SPONSOR, TARGET, bootstrapRefusal, form);
    expect(identityRefusal).toMatchObject({
      status: "refused",
      uncertain: true,
      action: "post",
      attemptId: form.get("attempt_id"),
    });
    const otherIntent = command("tombstone");
    expect(
      await apply(SPONSOR, { ...TARGET, commentaryId: OLD_ID }, identityRefusal, otherIntent),
    ).toMatchObject({ status: "refused", uncertain: true, action: "post" });
    expect(calls).toHaveLength(1);
    authSponsor = SPONSOR;
    bootstrap = { ok: true, data: { sponsor_id: SPONSOR, created: false, bootstrapped_at: 1 } };
    result = { ok: true, data: RECEIPT };
    expect(await apply(SPONSOR, TARGET, identityRefusal, form)).toMatchObject({
      status: "committed",
      receipt: RECEIPT,
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.key).toBe(firstKey);
  });

  test("the committed Worker receipt survives a failed Agora cache refresh", async () => {
    const expected = {
      status: "committed" as const,
      action: "post" as const,
      attemptId: "browser-intent-0123456789",
      receipt: RECEIPT,
    };
    expect(await apply(SPONSOR, TARGET, { status: "idle" }, command())).toEqual(expected);
    expect(refreshes).toEqual(["/console/commentary/P-4DSP", "/p/P-4DSP"]);
    refreshThrows = true;
    expect(await apply(SPONSOR, TARGET, { status: "idle" }, command())).toEqual(expected);
  });
});
