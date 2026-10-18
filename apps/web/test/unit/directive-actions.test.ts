import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type {
  SponsorDirectiveReceipt,
  SponsorDirectiveRequest,
} from "@asimposium/contracts/directives";
import type { SponsorWriterCapReceipt, StoaCall } from "../../lib/stoa.ts";

mock.module("server-only", () => ({}));

const VALID_SPONSOR_ID = "usr_1234567890abcdef";
const INVALID_SPONSOR_ID = "not-canonical-sponsor";
const VALID_FELLOW_ID = "FEL-12345678";
const VALID_IDEMPOTENCY_KEY = "idem-directive-test-01";

const VALID_RECEIPT: SponsorDirectiveReceipt = {
  schema: "https://a.asimposium.org/schemas/directives.v1.json",
  directive_id: "DIR-0123456789abcdef0123456789abcdef",
  fellow_id: VALID_FELLOW_ID,
  problem_id: null,
  verb: "focus",
  text: "Investigate lemma 3.1",
  created_at: 1786000000000,
  delivered: true,
  acknowledged_at: null,
};

describe("issueSponsorDirective server action", () => {
  let realStoa: typeof import("../../lib/stoa.ts");
  let realAuth: typeof import("../../auth.ts");
  let currentAuthSponsorId: string | null = VALID_SPONSOR_ID;
  const capture: {
    lastStoaCallArgs: {
      principalId: string;
      request: SponsorDirectiveRequest;
      idempotencyKey: string;
    } | null;
  } = {
    lastStoaCallArgs: null,
  };
  const getLastStoaCallArgs = () => capture.lastStoaCallArgs;
  let stoaCallResult: StoaCall<SponsorDirectiveReceipt> = {
    ok: true,
    data: VALID_RECEIPT,
  };
  const writerCapCalls: unknown[][] = [];
  const writerCap: SponsorWriterCapReceipt = {
    id: "P-SP4D",
    writer_cap: 12,
    updated_at: "2026-10-18T20:00:00.000Z",
  };
  let writerCapResult: StoaCall<SponsorWriterCapReceipt> = { ok: true, data: writerCap };
  let issueSponsorDirective: typeof import("../../app/console/directive-actions.ts").issueSponsorDirective;
  let executeDirectorCommand: typeof import("../../app/console/directive-actions.ts").executeDirectorCommand;

  beforeAll(async () => {
    realStoa = { ...(await import("../../lib/stoa.ts")) };
    realAuth = { ...(await import("../../auth.ts")) };

    mock.module("@/auth", () => ({
      auth: async () =>
        currentAuthSponsorId ? { user: { id: currentAuthSponsorId } } : null,
    }));

    mock.module("@/lib/stoa", () => ({
      stoaIssueDirective: async (
        principalId: string,
        request: SponsorDirectiveRequest,
        idempotencyKey: string,
      ) => {
        capture.lastStoaCallArgs = { principalId, request, idempotencyKey };
        return stoaCallResult;
      },
      stoaSetProblemWriterCap: async (...args: unknown[]) => {
        writerCapCalls.push(args);
        return writerCapResult;
      },
    }));

    const hermeticSpecifier: string =
      "../../app/console/directive-actions.ts?hermetic-directive-actions-test";
    const mod = (await import(hermeticSpecifier)) as typeof import("../../app/console/directive-actions.ts");
    issueSponsorDirective = mod.issueSponsorDirective;
    executeDirectorCommand = mod.executeDirectorCommand;
  });

  afterAll(() => {
    mock.module("@/lib/stoa", () => realStoa);
    mock.module("@/auth", () => realAuth);
  });

  test("rejects when unauthenticated", async () => {
    currentAuthSponsorId = null;
    capture.lastStoaCallArgs = null;

    const request: SponsorDirectiveRequest = {
      fellow_id: VALID_FELLOW_ID,
      verb: "focus",
      text: "Investigate lemma 3.1",
    };

    const res = await issueSponsorDirective(request, VALID_IDEMPOTENCY_KEY);
    expect(res).toEqual({
      ok: false,
      message: "Sign in again before issuing a directive.",
    });
    expect(capture.lastStoaCallArgs).toBeNull();
  });

  test("rejects when sponsor id is not canonical", async () => {
    currentAuthSponsorId = INVALID_SPONSOR_ID;
    capture.lastStoaCallArgs = null;

    const request: SponsorDirectiveRequest = {
      fellow_id: VALID_FELLOW_ID,
      verb: "focus",
      text: "Investigate lemma 3.1",
    };

    const res = await issueSponsorDirective(request, VALID_IDEMPOTENCY_KEY);
    expect(res).toEqual({
      ok: false,
      message: "Sign in again before issuing a directive.",
    });
    expect(capture.lastStoaCallArgs).toBeNull();
  });

  test("rejects when directive request is invalid (focus without text)", async () => {
    currentAuthSponsorId = VALID_SPONSOR_ID;
    capture.lastStoaCallArgs = null;

    const request = {
      fellow_id: VALID_FELLOW_ID,
      verb: "focus" as const,
    } as unknown as SponsorDirectiveRequest;

    const res = await issueSponsorDirective(request, VALID_IDEMPOTENCY_KEY);
    expect(res).toEqual({
      ok: false,
      message: "The directive draft is invalid.",
    });
    expect(capture.lastStoaCallArgs).toBeNull();
  });

  test("rejects when directive request is invalid (unfocus with text)", async () => {
    currentAuthSponsorId = VALID_SPONSOR_ID;
    capture.lastStoaCallArgs = null;

    const request = {
      fellow_id: VALID_FELLOW_ID,
      verb: "unfocus" as const,
      text: "should not be here",
    } as unknown as SponsorDirectiveRequest;

    const res = await issueSponsorDirective(request, VALID_IDEMPOTENCY_KEY);
    expect(res).toEqual({
      ok: false,
      message: "The directive draft is invalid.",
    });
    expect(capture.lastStoaCallArgs).toBeNull();
  });

  test("rejects when idempotency key is invalid", async () => {
    currentAuthSponsorId = VALID_SPONSOR_ID;
    capture.lastStoaCallArgs = null;

    const request: SponsorDirectiveRequest = {
      fellow_id: VALID_FELLOW_ID,
      verb: "focus",
      text: "Investigate lemma 3.1",
    };

    // Test invalid keys: empty, with spaces, too long (>160)
    for (const badKey of ["", "has spaces", "x".repeat(161), "invalid@chars!"]) {
      const res = await issueSponsorDirective(request, badKey);
      expect(res).toEqual({
        ok: false,
        message: "The directive draft is invalid.",
      });
      expect(capture.lastStoaCallArgs).toBeNull();
    }
  });

  test("maps Stoa unconfigured refusal correctly", async () => {
    currentAuthSponsorId = VALID_SPONSOR_ID;
    capture.lastStoaCallArgs = null;
    stoaCallResult = { ok: false, reason: "unconfigured" };

    const request: SponsorDirectiveRequest = {
      fellow_id: VALID_FELLOW_ID,
      verb: "focus",
      text: "Investigate lemma 3.1",
    };

    const res = await issueSponsorDirective(request, VALID_IDEMPOTENCY_KEY);
    expect(res).toEqual({
      ok: false,
      message: "Directive delivery is not configured on this deployment.",
    });
    expect(getLastStoaCallArgs()).not.toBeNull();
    expect(getLastStoaCallArgs()?.principalId).toBe(VALID_SPONSOR_ID);
  });

  test("maps Stoa refused response correctly", async () => {
    currentAuthSponsorId = VALID_SPONSOR_ID;
    capture.lastStoaCallArgs = null;
    stoaCallResult = {
      ok: false,
      reason: "refused",
      status: 403,
      detail: "Fellow not owned by sponsor",
    };

    const request: SponsorDirectiveRequest = {
      fellow_id: VALID_FELLOW_ID,
      verb: "forbid",
      text: "Do not expand this proof path",
    };

    const res = await issueSponsorDirective(request, VALID_IDEMPOTENCY_KEY);
    expect(res).toEqual({
      ok: false,
      message:
        "Stoa refused the directive. Refresh the console and check the Fellow assignment.",
    });
  });

  test("maps Stoa unreachable response correctly", async () => {
    currentAuthSponsorId = VALID_SPONSOR_ID;
    capture.lastStoaCallArgs = null;
    stoaCallResult = { ok: false, reason: "unreachable" };

    const request: SponsorDirectiveRequest = {
      fellow_id: VALID_FELLOW_ID,
      verb: "unfocus",
    };

    const res = await issueSponsorDirective(request, VALID_IDEMPOTENCY_KEY);
    expect(res).toEqual({
      ok: false,
      message:
        "Directive delivery could not be confirmed. Retry with the same draft.",
    });
  });

  test("returns receipt on Stoa success with valid request and idempotency key", async () => {
    currentAuthSponsorId = VALID_SPONSOR_ID;
    capture.lastStoaCallArgs = null;
    stoaCallResult = { ok: true, data: VALID_RECEIPT };

    const request: SponsorDirectiveRequest = {
      fellow_id: VALID_FELLOW_ID,
      verb: "focus",
      text: "Investigate lemma 3.1",
    };

    const res = await issueSponsorDirective(request, VALID_IDEMPOTENCY_KEY);
    expect(res).toEqual({
      ok: true,
      receipt: VALID_RECEIPT,
    });
    expect(getLastStoaCallArgs() as unknown).toEqual({
      principalId: VALID_SPONSOR_ID,
      request,
      idempotencyKey: VALID_IDEMPOTENCY_KEY,
    });
  });

  test("a mismatched directive receipt never reports success", async () => {
    currentAuthSponsorId = VALID_SPONSOR_ID;
    stoaCallResult = { ok: true, data: { ...VALID_RECEIPT, fellow_id: "FEL-87654321" } };
    const result = await issueSponsorDirective({
      fellow_id: VALID_FELLOW_ID, verb: "focus", text: VALID_RECEIPT.text!,
    }, VALID_IDEMPOTENCY_KEY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("did not match");
  });

  describe("executeDirectorCommand", () => {
    test("rejects invalid syntax with supported verbs list", async () => {
      const res = await executeDirectorCommand("unsupported-verb FEL-1234", VALID_IDEMPOTENCY_KEY);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe("UNKNOWN_DIRECTOR_VERB");
        expect(res.verbs).toBeDefined();
        expect(res.hint).toBeDefined();
      }
    });

    test("rejects when unauthenticated", async () => {
      currentAuthSponsorId = null;
      const res = await executeDirectorCommand("focus FEL-1234 Investigate lemma 3.1", VALID_IDEMPOTENCY_KEY);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.message).toBe("Sign in again before issuing a directive.");
      }
    });

    test("executes valid focus command via Stoa", async () => {
      currentAuthSponsorId = VALID_SPONSOR_ID;
      stoaCallResult = { ok: true, data: VALID_RECEIPT };

      const res = await executeDirectorCommand(
        `focus ${VALID_FELLOW_ID} Investigate lemma 3.1`,
        VALID_IDEMPOTENCY_KEY,
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.verb).toBe("focus");
        expect(res.receipt).toEqual(VALID_RECEIPT);
      }
    });

    test("executes valid unfocus command via Stoa", async () => {
      currentAuthSponsorId = VALID_SPONSOR_ID;
      stoaCallResult = { ok: true, data: { ...VALID_RECEIPT, verb: "unfocus", text: null } };

      const res = await executeDirectorCommand(
        `unfocus ${VALID_FELLOW_ID}`,
        VALID_IDEMPOTENCY_KEY,
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.verb).toBe("unfocus");
        expect(res.message).toContain("Focus cleared");
      }
    });

    test("assign delivers a private work directive without claiming new membership", async () => {
      currentAuthSponsorId = VALID_SPONSOR_ID;
      const text = "Work on problem P-SP4D as critic. Open or resume an authorized session and follow its working pack. This work request does not change your permissions or problem membership.";
      stoaCallResult = {
        ok: true,
        data: { ...VALID_RECEIPT, problem_id: "P-SP4D", text },
      };
      capture.lastStoaCallArgs = null;
      const res = await executeDirectorCommand(
        `assign ${VALID_FELLOW_ID} P-SP4D as critic`,
        VALID_IDEMPOTENCY_KEY,
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.verb).toBe("assign");
        expect(res.message).toContain("requested role: critic");
        expect(res.message).toContain("permissions and problem membership are unchanged");
        expect(res.receipt?.directive_id).toBe(VALID_RECEIPT.directive_id);
      }
      expect(getLastStoaCallArgs()).toEqual({
        principalId: VALID_SPONSOR_ID,
        request: { fellow_id: VALID_FELLOW_ID, problem_id: "P-SP4D", verb: "focus", text },
        idempotencyKey: VALID_IDEMPOTENCY_KEY,
      });
    });

    test("assignment refuses an inaccessible problem or another sponsor's Fellow", async () => {
      currentAuthSponsorId = VALID_SPONSOR_ID;
      stoaCallResult = { ok: false, reason: "refused", status: 403 };
      const result = await executeDirectorCommand(
        `assign ${VALID_FELLOW_ID} P-OTHER as worker`, VALID_IDEMPOTENCY_KEY,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("Stoa refused");
    });

    test("transfer requires the existing bilateral confirmation and never reports a mutation", async () => {
      currentAuthSponsorId = VALID_SPONSOR_ID;
      capture.lastStoaCallArgs = null;
      writerCapCalls.length = 0;
      const res = await executeDirectorCommand(
        `transfer ${VALID_FELLOW_ID} usr_sponsor_bob`,
        VALID_IDEMPOTENCY_KEY,
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe("DIRECTOR_CONFIRMATION_REQUIRED");
        expect(res.message).toContain("Both sponsors must confirm");
        expect(res.handoff?.href).toBe("#transfers-title");
      }
      expect(getLastStoaCallArgs()).toBeNull();
      expect(writerCapCalls).toHaveLength(0);
    });

    test("cap reports only the acknowledged signed Worker mutation", async () => {
      currentAuthSponsorId = VALID_SPONSOR_ID;
      writerCapCalls.length = 0;
      writerCapResult = { ok: true, data: writerCap };
      const res = await executeDirectorCommand(
        "cap P-SP4D 12",
        VALID_IDEMPOTENCY_KEY,
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.verb).toBe("cap");
        expect(res.message).toContain("Stoa confirmed 12 writer slots");
        expect(res.writerCap).toEqual(writerCap);
      }
      expect(writerCapCalls).toEqual([[VALID_SPONSOR_ID, "P-SP4D", 12, VALID_IDEMPOTENCY_KEY]]);
    });

    test("cap transport loss and permission refusals cannot become success", async () => {
      currentAuthSponsorId = VALID_SPONSOR_ID;
      for (const failure of [
        { ok: false, reason: "unconfigured" },
        { ok: false, reason: "unreachable" },
        { ok: false, reason: "refused", status: 403 },
      ] as const) {
        writerCapResult = failure;
        const result = await executeDirectorCommand("cap P-SP4D 12", VALID_IDEMPOTENCY_KEY);
        expect(result.ok).toBe(false);
      }
    });

    test("cap rejects a success-shaped receipt for the wrong target or limit", async () => {
      currentAuthSponsorId = VALID_SPONSOR_ID;
      for (const receipt of [{ ...writerCap, id: "P-OTHER" }, { ...writerCap, writer_cap: 8 }]) {
        writerCapResult = { ok: true, data: receipt };
        const result = await executeDirectorCommand("cap P-SP4D 12", VALID_IDEMPOTENCY_KEY);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.message).toContain("did not match");
      }
    });

    test("sensitive commands preserve their existing confirmation workflows", async () => {
      currentAuthSponsorId = VALID_SPONSOR_ID;
      capture.lastStoaCallArgs = null;
      writerCapCalls.length = 0;
      for (const [command, href] of [
        [`pause ${VALID_FELLOW_ID}`, "#fellows-title"],
        [`resume ${VALID_FELLOW_ID}`, "#fellows-title"],
        [`revoke ${VALID_FELLOW_ID}`, "#fellows-title"],
        ["publish P-SP4D", "#problems-title"],
      ]) {
        const result = await executeDirectorCommand(command!, VALID_IDEMPOTENCY_KEY);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.code).toBe("DIRECTOR_CONFIRMATION_REQUIRED");
          expect(result.handoff?.href).toBe(href);
        }
      }
      expect(getLastStoaCallArgs()).toBeNull();
      expect(writerCapCalls).toHaveLength(0);
    });

    test("unsupported hiding does not claim a governance change or expose the reason", async () => {
      currentAuthSponsorId = VALID_SPONSOR_ID;
      const result = await executeDirectorCommand("hide P-SP4D private moderation context", VALID_IDEMPOTENCY_KEY);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("DIRECTOR_ACTION_UNAVAILABLE");
        expect(result.message).not.toContain("private moderation context");
        expect(result.handoff?.href).toBe("/p/P-SP4D");
      }
    });

    test("invalid commands and retry keys never reach a mutation", async () => {
      currentAuthSponsorId = VALID_SPONSOR_ID;
      capture.lastStoaCallArgs = null;
      writerCapCalls.length = 0;
      for (const [command, key] of [
        ["cap P-SP4D 17", VALID_IDEMPOTENCY_KEY],
        ["cap P-SP4D 12", ""],
        [`assign ${VALID_FELLOW_ID} P-SP4D`, "invalid key"],
        [null as unknown as string, VALID_IDEMPOTENCY_KEY],
      ]) {
        expect((await executeDirectorCommand(command!, key!)).ok).toBe(false);
      }
      expect(getLastStoaCallArgs()).toBeNull();
      expect(writerCapCalls).toHaveLength(0);
    });
  });
});

