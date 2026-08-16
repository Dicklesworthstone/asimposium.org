import { expect, mock, test } from "bun:test";
import {
  MintEnrollmentRequestSchema,
  MintEnrollmentResponseSchema,
  SponsorEnrollmentDecisionCommandSchema,
  SponsorEnrollmentDecisionSchema,
  stoaJoinUrl,
} from "@asimposium/contracts";

import {
  bestEffortEnrollmentCacheInvalidation,
  enrollmentRecoveryConfigurationIsValid,
  enrollmentRecoveryDisposition,
  enrollmentRecoveryFingerprint,
  enrollmentRecoveryOwner,
  openEnrollmentRecoveryPayload,
  sealEnrollmentRecoveryPayload,
} from "../../lib/enrollment-recovery.ts";

const ROOT_A = "11".repeat(32);
const ROOT_B = "22".repeat(32);
const SPONSOR = "usr_fixture_sponsor";

test("the recovery fingerprint is pinned to normalized body bytes", async () => {
  const normalized = MintEnrollmentRequestSchema.parse({
    expires_in_ms: 1_800_000,
    requested_scopes: ["promote", "review"],
  });
  expect(await enrollmentRecoveryFingerprint(ROOT_A, SPONSOR, "mint", normalized)).toBe(
    "8903c76bfebba06288ef3a744df62ee0e121898e3b6d9d4fc5fb2956a3d07828",
  );

  const reorderedInput = MintEnrollmentRequestSchema.parse({
    requested_scopes: ["promote", "review"],
    expires_in_ms: 1_800_000,
  });
  expect(await enrollmentRecoveryFingerprint(ROOT_A, SPONSOR, "mint", reorderedInput)).toBe(
    await enrollmentRecoveryFingerprint(ROOT_A, SPONSOR, "mint", normalized),
  );
});

test("sponsor, operation, body, and dedicated root are independent domains", async () => {
  const body = MintEnrollmentRequestSchema.parse({
    requested_scopes: ["review"],
    expires_in_ms: 60_000,
    first_directive: "Keep this private",
  });
  const baseline = await enrollmentRecoveryFingerprint(ROOT_A, SPONSOR, "mint", body);
  const variants = await Promise.all([
    enrollmentRecoveryFingerprint(ROOT_A, "usr_other_sponsor", "mint", body),
    enrollmentRecoveryFingerprint(ROOT_A, SPONSOR, "decision", body),
    enrollmentRecoveryFingerprint(ROOT_A, SPONSOR, "mint", {
      ...body,
      first_directive: "Different private directive",
    }),
    enrollmentRecoveryFingerprint(ROOT_B, SPONSOR, "mint", body),
  ]);

  expect(new Set([baseline, ...variants]).size).toBe(5);
  expect(baseline).toMatch(/^[a-f0-9]{64}$/);
  expect(baseline).not.toContain("Keep this private");
});

test("decision recovery fingerprints stable intent while Agora owns step-up evidence", async () => {
  const intent = SponsorEnrollmentDecisionSchema.parse({
    enrollment_id: "ASIMP-EN-01JXYZ4K6Q",
    decision: "approve",
  });
  const firstFingerprint = await enrollmentRecoveryFingerprint(ROOT_A, SPONSOR, "decision", intent);
  for (const stepUpAuthenticatedAt of [1_786_800_000, 1_786_800_900]) {
    const command = SponsorEnrollmentDecisionCommandSchema.parse({
      ...intent,
      step_up_authenticated_at: stepUpAuthenticatedAt,
    });
    expect(command.step_up_authenticated_at).toBe(stepUpAuthenticatedAt);
    expect(
      await enrollmentRecoveryFingerprint(ROOT_A, SPONSOR, "decision", intent),
    ).toBe(firstFingerprint);
  }
});

test("lifecycle recovery seals stable intent but refuses a different command scope", async () => {
  const intent = {
    fellow_id: "F-01JXYZ4K6Q",
    credential_id: "FC-01JXYZ4K6Q",
    confirm: "revoke-credential",
  };
  const fingerprint = await enrollmentRecoveryFingerprint(
    ROOT_A,
    SPONSOR,
    "credential-revoke",
    intent,
  );
  const envelope = await sealEnrollmentRecoveryPayload(ROOT_A, {
    sponsorId: SPONSOR,
    scope: "credential-revoke",
    fingerprint,
    idempotencyKey: "console-revoke-fixture",
    expiresAt: 2_000,
    request: intent,
  });

  await expect(
    openEnrollmentRecoveryPayload(ROOT_A, envelope, SPONSOR, "credential-revoke", 1_999),
  ).resolves.toMatchObject({ request: intent });
  await expect(
    openEnrollmentRecoveryPayload(ROOT_A, envelope, SPONSOR, "sponsor-panic", 1_999),
  ).rejects.toThrow("invalid enrollment recovery payload");
  expect(
    await enrollmentRecoveryFingerprint(ROOT_A, SPONSOR, "sponsor-panic", intent),
  ).not.toBe(fingerprint);
});

test("the page owner is a stable sponsor binding and changes across principals", async () => {
  const owner = await enrollmentRecoveryOwner(ROOT_A, SPONSOR);
  expect(owner).toBe(
    await enrollmentRecoveryFingerprint(ROOT_A, SPONSOR, "mint", {
      purpose: "client-memory-owner-v1",
    }),
  );
  expect(await enrollmentRecoveryOwner(ROOT_A, "usr_other_sponsor")).not.toBe(owner);
  expect(await enrollmentRecoveryOwner(ROOT_B, SPONSOR)).not.toBe(owner);
});

test("the exact recovery body is authenticated, sponsor-bound, and expires closed", async () => {
  const privateDirective = "private-directive-canary";
  const fingerprint = await enrollmentRecoveryFingerprint(ROOT_A, SPONSOR, "mint", {
    requested_scopes: ["review"],
    first_directive: privateDirective,
  });
  const envelope = await sealEnrollmentRecoveryPayload(ROOT_A, {
    sponsorId: SPONSOR,
    scope: "mint",
    fingerprint,
    idempotencyKey: "console-original-key",
    expiresAt: 2_000,
    request: {
      requested_scopes: ["review"],
      first_directive: privateDirective,
    },
  });
  expect(envelope).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  expect(envelope).not.toContain(privateDirective);
  await expect(
    openEnrollmentRecoveryPayload(ROOT_A, envelope, SPONSOR, "mint", 1_999),
  ).resolves.toMatchObject({
    sponsorId: SPONSOR,
    scope: "mint",
    fingerprint,
    idempotencyKey: "console-original-key",
    request: { first_directive: privateDirective },
  });
  await expect(
    openEnrollmentRecoveryPayload(ROOT_A, envelope, "usr_other_sponsor", "mint", 1_999),
  ).rejects.toThrow("invalid enrollment recovery payload");
  await expect(
    openEnrollmentRecoveryPayload(ROOT_A, envelope, SPONSOR, "decision", 1_999),
  ).rejects.toThrow("invalid enrollment recovery payload");
  await expect(
    openEnrollmentRecoveryPayload(ROOT_A, envelope, SPONSOR, "mint", 2_000),
  ).rejects.toThrow("invalid enrollment recovery payload");
  const replacement = envelope.endsWith("A") ? "B" : "A";
  await expect(
    openEnrollmentRecoveryPayload(
      ROOT_A,
      `${envelope.slice(0, -1)}${replacement}`,
      SPONSOR,
      "mint",
      1_999,
    ),
  ).rejects.toThrow("invalid enrollment recovery payload");
});

test("malformed recovery roots fail before producing a reusable identity", async () => {
  await expect(enrollmentRecoveryFingerprint("AA".repeat(32), SPONSOR, "mint", {})).rejects.toThrow(
    "32 lowercase-hex bytes",
  );
  await expect(enrollmentRecoveryFingerprint("11", SPONSOR, "mint", {})).rejects.toThrow(
    "32 lowercase-hex bytes",
  );
});

test("write readiness requires an independent well-formed recovery key", () => {
  expect(enrollmentRecoveryConfigurationIsValid(ROOT_A, ROOT_B)).toBe(true);
  expect(enrollmentRecoveryConfigurationIsValid(ROOT_A, ROOT_A)).toBe(false);
  expect(enrollmentRecoveryConfigurationIsValid(undefined, ROOT_B)).toBe(false);
  expect(enrollmentRecoveryConfigurationIsValid("AA".repeat(32), ROOT_B)).toBe(false);
  expect(enrollmentRecoveryConfigurationIsValid("11", ROOT_B)).toBe(false);
});

test("only definite local or schema-valid non-ambiguous Worker refusals discard recovery", () => {
  expect(enrollmentRecoveryDisposition("unconfigured")).toBe("clear");
  expect(enrollmentRecoveryDisposition("unreachable")).toBe("retain");
  expect(enrollmentRecoveryDisposition("refused", 400, "MINT_BODY_INVALID")).toBe("clear");
  expect(enrollmentRecoveryDisposition("refused", 404, "PROPOSAL_NOT_PENDING")).toBe("clear");
  expect(enrollmentRecoveryDisposition("refused", 403, "STEP_UP_REQUIRED")).toBe("clear");
  expect(enrollmentRecoveryDisposition("refused", 408, "ENROLLMENT_UNAVAILABLE")).toBe("retain");
  expect(enrollmentRecoveryDisposition("refused", 425, "ENROLLMENT_UNAVAILABLE")).toBe("retain");
  expect(enrollmentRecoveryDisposition("refused", 429, "SPONSOR_ENROLLMENT_RATE_LIMITED")).toBe(
    "clear",
  );
  expect(enrollmentRecoveryDisposition("refused", 429, "ENROLLMENT_UNAVAILABLE")).toBe("retain");
  expect(enrollmentRecoveryDisposition("refused", 400, "ENROLLMENT_UNAVAILABLE")).toBe("retain");
  expect(enrollmentRecoveryDisposition("refused", 400, "INTERNAL_ERROR")).toBe("retain");
  expect(enrollmentRecoveryDisposition("refused", 400)).toBe("retain");
  expect(enrollmentRecoveryDisposition("refused", 500, "ENROLLMENT_UNAVAILABLE")).toBe("retain");
  expect(enrollmentRecoveryDisposition("refused", 503, "ENROLLMENT_UNAVAILABLE")).toBe("retain");
  expect(enrollmentRecoveryDisposition("refused")).toBe("retain");
  expect(enrollmentRecoveryDisposition("refused", 302)).toBe("retain");
});

test("cache invalidation cannot suppress an already committed one-time result", () => {
  let calls = 0;
  expect(() =>
    bestEffortEnrollmentCacheInvalidation(() => {
      calls += 1;
      throw new Error("cache unavailable");
    }),
  ).not.toThrow();
  expect(calls).toBe(1);
});

/**
 * The real public action, not a transcription of its shape.
 *
 * The test above proves the helper swallows a `revalidatePath` failure. What
 * matters at the call site is stronger and only provable through the action
 * itself: a one-time mint authority is returned *unchanged* after invalidation
 * throws, and the Stoa write is not retried in the attempt to recover. A
 * one-time enrollment result cannot be re-fetched, so an invalidation failure
 * that swallowed, altered, or re-issued it would destroy or duplicate the only
 * copy.
 *
 * `actions.ts` is a `"use server"` module. The directive is inert under Bun, and
 * the only real barrier is the `server-only` marker its imports pull in —
 * replaced here exactly as `service-envelope.test.ts:25` already does. Nothing
 * production-side is reshaped for the test: the action is driven through its
 * public signature with a genuinely sealed payload.
 */
test("mintJoinUrl returns the exact Stoa authority when revalidation throws, without a second write", async () => {
  const sponsorId = "usr_01JXYZSPONSOR0000000000";
  const rootHex = "a".repeat(64);
  const envelopeHex = "b".repeat(64);
  // Captured, not assumed absent: `delete` on a variable that was set would be a
  // silent mutation of every later test in this shared process.
  const priorEnv = {
    ENROLLMENT_RECOVERY_HMAC_KEY_HEX: process.env.ENROLLMENT_RECOVERY_HMAC_KEY_HEX,
    SERVICE_ENVELOPE_PRIVATE_KEY_HEX: process.env.SERVICE_ENVELOPE_PRIVATE_KEY_HEX,
  };
  process.env.ENROLLMENT_RECOVERY_HMAC_KEY_HEX = rootHex;
  process.env.SERVICE_ENVELOPE_PRIVATE_KEY_HEX = envelopeHex;

  const request = MintEnrollmentRequestSchema.parse({
    requested_scopes: ["review"],
    expires_in_ms: 1_800_000,
  });
  const idempotencyKey = "console-01JXYZCOMPOSITION";
  const fingerprint = await enrollmentRecoveryFingerprint(rootHex, sponsorId, "mint", request);
  const recoveryPayload = await sealEnrollmentRecoveryPayload(rootHex, {
    sponsorId,
    scope: "mint",
    fingerprint,
    idempotencyKey,
    expiresAt: Date.now() + 600_000,
    request,
  });
  const owner = await enrollmentRecoveryOwner(rootHex, sponsorId);

  // The authority the Worker already committed, built through the production
  // contract rather than invented. `MintEnrollmentResponseSchema` cross-checks
  // that `join_url` embeds exactly this `enrollment_id` and this secret, so a
  // stub returning a plausible-looking literal would not survive it — and a test
  // that asserts an authority production could never mint proves nothing about
  // the composition it claims to cover.
  const enrollmentId = "ASIMP-EN-01JXYZ4K6QRSTV";
  const secret = `v1.${"A".repeat(43)}`;
  const authority = MintEnrollmentResponseSchema.parse({
    enrollment_id: enrollmentId,
    join_url: stoaJoinUrl("https://a.asimposium.org", enrollmentId, secret),
    secret,
    expires_at: 1_786_000_000,
  });
  let stoaCalls = 0;
  let ownerChecks = 0;
  let revalidations = 0;

  // `mock.module` is process-global and this runner shares one process across
  // files, so anything left mocked silently reshapes sibling suites — an
  // unrestored Stoa client disarms the origin-binding tests in
  // `service-envelope.test.ts`, which then pass against a stub that cannot
  // refuse anything. Every module replaced below is captured first and handed
  // back in the `finally`.
  //
  // `server-only` is the one exception and is deliberately not restored: the
  // real module throws by design, so there is nothing to capture, and
  // `service-envelope.test.ts:25` already neutralises it for the whole run.
  // This adds no condition that was not already in force.
  mock.module("server-only", () => ({}));
  const realStoa = { ...(await import("../../lib/stoa.ts")) };
  const realCache = { ...(await import("next/cache")) };
  const realAuth = { ...(await import("../../auth.ts")) };
  mock.module("next/cache", () => ({
    revalidatePath: () => {
      revalidations += 1;
      throw new Error("revalidatePath unavailable");
    },
  }));
  mock.module("@/auth", () => ({
    auth: async () => ({ user: { id: sponsorId } }),
  }));
  // Every Stoa write the action module imports. The five the mint path must not
  // touch throw rather than returning a benign stub, so a stray second write
  // fails the test instead of passing quietly.
  const unreachable = (name: string) => async () => {
    throw new Error(`${name} must not be called on the mint path`);
  };
  mock.module("@/lib/stoa", () => ({
    stoaEnrollmentRecoveryOwner: async (candidateSponsorId: string) => {
      ownerChecks += 1;
      expect(candidateSponsorId).toBe(sponsorId);
      return owner;
    },
    stoaMintEnrollment: async () => {
      stoaCalls += 1;
      return { ok: true, data: authority };
    },
    stoaDecideProposal: unreachable("stoaDecideProposal"),
    stoaDeviceLookup: unreachable("stoaDeviceLookup"),
    stoaPanicSponsor: unreachable("stoaPanicSponsor"),
    stoaRevokeCredential: unreachable("stoaRevokeCredential"),
    stoaTransitionFellow: unreachable("stoaTransitionFellow"),
  }));

  let result: Awaited<ReturnType<typeof import("../../app/console/actions.ts").mintJoinUrl>>;
  try {
    // Cache-busted on purpose. A plain specifier would instantiate the canonical
    // `actions.ts` registry entry with these mocks bound into it and leave it
    // cached for every later importer; this URL is a distinct entry, so the
    // canonical one is never populated under mocks at all. The restore below
    // then has nothing contaminated left to undo.
    // Held in a variable so TypeScript does not try to resolve the query suffix
    // as a module path; the suffix is a runtime registry key, not a file.
    const hermeticSpecifier = "../../app/console/actions.ts?hermetic-composition";
    const { mintJoinUrl } = (await import(hermeticSpecifier)) as typeof import(
      "../../app/console/actions.ts"
    );
    result = await mintJoinUrl(recoveryPayload, idempotencyKey, owner);
  } finally {
    mock.module("@/lib/stoa", () => realStoa);
    mock.module("next/cache", () => realCache);
    mock.module("@/auth", () => realAuth);
    for (const [name, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  // Non-vacuity: both sides of the composition genuinely ran. Without these a
  // refusal before Stoa would satisfy nothing below and still look green.
  expect(ownerChecks).toBe(1);
  expect(stoaCalls).toBe(1);
  expect(revalidations).toBe(1);

  expect(result).toEqual({
    ok: true,
    joinUrl: authority.join_url,
    enrollmentId: authority.enrollment_id,
    expiresAt: authority.expires_at,
  });
});

/**
 * The restore above is load-bearing, so every part of it is asserted rather than
 * trusted. A leaked mock does not fail loudly — it makes a sibling suite pass
 * against a stub that cannot refuse anything, which is worse than a red one.
 *
 * This test must run after the composition test; `bun test` executes a file's
 * tests in declaration order, which is why it sits here rather than earlier.
 */
test("the composition test leaves no process-global state behind", async () => {
  // 1. The Stoa client is the real one again. The stub returned a fixed
  //    authority; the real client refuses, because this environment names no
  //    trusted Stoa origin.
  const stoa = await import("../../lib/stoa.ts");
  const probe = await stoa.stoaMintEnrollment(
    "usr_01JXYZSPONSOR0000000000",
    MintEnrollmentRequestSchema.parse({ requested_scopes: ["review"] }),
    "console-01JXYZRESTORECHECK",
  );
  expect(probe.ok).toBe(false);

  // 2. `revalidatePath` is the real one. Outside a Next request context it may
  //    still throw, so the identifying property is *which* failure: the stub
  //    threw exactly "revalidatePath unavailable" on every call.
  const cache = await import("next/cache");
  expect(typeof cache.revalidatePath).toBe("function");
  let cacheFailure = "";
  try {
    cache.revalidatePath("/console");
  } catch (error) {
    cacheFailure = (error as Error).message;
  }
  expect(cacheFailure).not.toContain("revalidatePath unavailable");

  // 3. `auth` is the configured Auth.js handler again, not a fixed session.
  const auth = await import("../../auth.ts");
  expect(Object.keys(auth).sort()).toEqual(["auth", "handlers", "signIn", "signOut"]);

  // 4. Both recovery keys are back to whatever this process had before, which in
  //    an unconfigured test environment is unset. The test's own values must not
  //    be visible here, or a later test could pass on borrowed configuration.
  expect(process.env.ENROLLMENT_RECOVERY_HMAC_KEY_HEX).not.toBe("a".repeat(64));
  expect(process.env.SERVICE_ENVELOPE_PRIVATE_KEY_HEX).not.toBe("b".repeat(64));

  // 5. The canonical action module was never instantiated under the mocks, so
  //    importing it now builds it against the restored modules above.
  const actions = await import("../../app/console/actions.ts");
  expect(typeof actions.mintJoinUrl).toBe("function");
  let actionOutcome = "returned";
  try {
    await actions.mintJoinUrl(
      "v1.notarealpayload.notarealciphertextnotarealciphertext",
      "console-01JXYZRESTORECHECK",
      "0".repeat(64),
    );
  } catch (error) {
    actionOutcome = (error as Error).message;
  }
  // Real Auth.js reads request headers, which do not exist outside a request
  // scope, so the canonical module fails here. That failure is the proof: a
  // cached instance still bound to the fixed-session mock would have sailed past
  // the sponsor check and returned an ordinary refusal object instead.
  expect(actionOutcome).toContain("outside a request scope");
});
