import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type {
  SponsorDirectiveReceipt,
  SponsorDirectiveRequest,
} from "@asimposium/contracts/directives";
import type { StoaCall } from "../../lib/stoa.ts";

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

    test("routes assign command with role", async () => {
      currentAuthSponsorId = VALID_SPONSOR_ID;
      const res = await executeDirectorCommand(
        `assign ${VALID_FELLOW_ID} P-SP4D as critic`,
        VALID_IDEMPOTENCY_KEY,
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.verb).toBe("assign");
        expect(res.message).toContain("role: critic");
      }
    });

    test("routes transfer command", async () => {
      currentAuthSponsorId = VALID_SPONSOR_ID;
      const res = await executeDirectorCommand(
        `transfer ${VALID_FELLOW_ID} usr_sponsor_bob`,
        VALID_IDEMPOTENCY_KEY,
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.verb).toBe("transfer");
        expect(res.message).toContain("bilateral cards");
      }
    });

    test("routes cap command", async () => {
      currentAuthSponsorId = VALID_SPONSOR_ID;
      const res = await executeDirectorCommand(
        "cap P-SP4D 12",
        VALID_IDEMPOTENCY_KEY,
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.verb).toBe("cap");
        expect(res.message).toContain("capped to 12 writer slots");
      }
    });
  });
});

