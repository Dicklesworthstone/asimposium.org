"use server";

import type {
  EnrollmentApprovalCard,
  MintEnrollmentRequest,
  SponsorCredentialRevokeRequest,
  SponsorEnrollmentDecision,
  SponsorFellowLifecycleRequest,
  SponsorFellowLifecycleTarget,
  SponsorPanicRequest,
} from "@asimposium/contracts";
import {
  MintEnrollmentRequestSchema,
  SponsorCredentialRevokeRequestSchema,
  SponsorEnrollmentDecisionCommandSchema,
  SponsorEnrollmentDecisionSchema,
  SponsorFellowLifecycleRequestSchema,
  SponsorPanicRequestSchema,
} from "@asimposium/contracts";
import { revalidatePath } from "next/cache";

import { auth } from "@/auth";
import {
  bestEffortEnrollmentCacheInvalidation,
  enrollmentRecoveryConfigurationIsValid,
  enrollmentRecoveryDisposition,
  enrollmentRecoveryFingerprint,
  openEnrollmentRecoveryPayload,
  sealEnrollmentRecoveryPayload,
} from "@/lib/enrollment-recovery";
import { recentAuthOk } from "@/lib/recent-auth";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";
import {
  stoaDecideProposal,
  stoaDeviceLookup,
  stoaEnrollmentRecoveryOwner,
  stoaMintEnrollment,
  stoaPanicSponsor,
  stoaRevokeCredential,
  stoaTransitionFellow,
} from "@/lib/stoa";

export type MintResult =
  | {
      readonly ok: true;
      readonly joinUrl: string;
      readonly enrollmentId: string;
      readonly expiresAt: number;
    }
  | {
      readonly ok: false;
      readonly message: string;
      /** Retain only when transport loss leaves the Worker's commit unknown. */
      readonly recovery: "retain" | "clear";
    };

export type DeviceLookupResult =
  | { readonly ok: true; readonly card: EnrollmentApprovalCard }
  | { readonly ok: false; readonly message: string };

/** W3.5: find a pending device proposal by its human code. Read-only; decisions go through decideProposal with the recent-auth gate. */
export async function lookupDeviceCode(userCode: string): Promise<DeviceLookupResult> {
  const sponsor = await requireSponsorId();
  if (!sponsor.ok) return sponsor;
  const result = await stoaDeviceLookup(sponsor.sponsorId, userCode.trim().toUpperCase());
  if (!result.ok) {
    return {
      ok: false,
      message:
        result.reason === "unreachable"
          ? "The agent host did not answer. Try again in a moment."
          : (result.detail ?? "That code was not accepted."),
    };
  }
  return { ok: true, card: result.data.card };
}

export type DecideResult =
  | {
      readonly ok: true;
      readonly decision: SponsorEnrollmentDecision["decision"];
    }
  | {
      readonly ok: false;
      readonly message: string;
      /** Retain only when transport loss leaves the Worker's commit unknown. */
      readonly recovery: "retain" | "clear";
    };

export type EnrollmentAttemptFingerprintResult =
  | {
      readonly ok: true;
      readonly fingerprint: string;
      readonly recoveryPayload: string;
      readonly serverNow: number;
    }
  | { readonly ok: false; readonly message: string };

const ENROLLMENT_RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1_000;

export type LifecycleAttemptScope =
  | "credential-revoke"
  | "fellow-lifecycle"
  | "sponsor-panic";

type CredentialRevokeIntent = Omit<
  SponsorCredentialRevokeRequest,
  "step_up_authenticated_at"
>;
type FellowLifecycleIntent = Omit<
  SponsorFellowLifecycleRequest,
  "step_up_authenticated_at"
>;
type SponsorPanicIntent = Omit<SponsorPanicRequest, "step_up_authenticated_at">;

type LifecycleIntent =
  | { readonly scope: "credential-revoke"; readonly request: CredentialRevokeIntent }
  | { readonly scope: "fellow-lifecycle"; readonly request: FellowLifecycleIntent }
  | { readonly scope: "sponsor-panic"; readonly request: SponsorPanicIntent };

export type LifecycleReceipt =
  | {
      readonly kind: "credential-revoke";
      readonly eventId: string;
      readonly fellowId: string;
      readonly credentialId: string;
      readonly sponsorSeq: number;
      readonly effectiveAt: number;
    }
  | {
      readonly kind: "fellow-lifecycle";
      readonly eventId: string;
      readonly fellowId: string;
      readonly status: SponsorFellowLifecycleTarget;
      readonly sponsorSeq: number;
      readonly effectiveAt: number;
    }
  | {
      readonly kind: "sponsor-panic";
      readonly eventId: string;
      readonly sponsorSeq: number;
      readonly effectiveAt: number;
    };

export type LifecycleResult =
  | { readonly ok: true; readonly receipt: LifecycleReceipt }
  | {
      readonly ok: false;
      readonly message: string;
      /** Retain only when transport loss leaves the Worker's commit unknown. */
      readonly recovery: "retain" | "clear";
    };

function isLifecycleAttemptScope(value: unknown): value is LifecycleAttemptScope {
  return (
    value === "credential-revoke" ||
    value === "fellow-lifecycle" ||
    value === "sponsor-panic"
  );
}

function lifecycleIntent(
  scope: LifecycleAttemptScope,
  request: unknown,
): LifecycleIntent | undefined {
  switch (scope) {
    case "credential-revoke": {
      const parsed = SponsorCredentialRevokeRequestSchema.omit({
        step_up_authenticated_at: true,
      }).safeParse(request);
      return parsed.success ? { scope, request: parsed.data } : undefined;
    }
    case "fellow-lifecycle": {
      const parsed = SponsorFellowLifecycleRequestSchema.omit({
        step_up_authenticated_at: true,
      }).safeParse(request);
      return parsed.success ? { scope, request: parsed.data } : undefined;
    }
    case "sponsor-panic": {
      const parsed = SponsorPanicRequestSchema.omit({
        step_up_authenticated_at: true,
      }).safeParse(request);
      return parsed.success ? { scope, request: parsed.data } : undefined;
    }
  }
}

async function recoveryOwnerForSponsor(sponsorId: string): Promise<string | undefined> {
  return stoaEnrollmentRecoveryOwner(sponsorId);
}

/**
 * A post-signal server read used only to release the client recovery fence.
 * The response contains the existing opaque recovery digest, never a sponsor
 * id; an unauthenticated or unconfigured request deliberately releases nothing.
 */
export async function reconcileEnrollmentRecoveryOwner(): Promise<
  { readonly ok: true; readonly recoveryOwner: string | null } | { readonly ok: false }
> {
  const session = await auth();
  if (session?.user === undefined) return { ok: true, recoveryOwner: null };
  if (!isCanonicalSponsorId(session.user.id)) return { ok: false };
  const recoveryOwner = await recoveryOwnerForSponsor(session.user.id);
  return recoveryOwner === undefined ? { ok: false } : { ok: true, recoveryOwner };
}

async function recoveryOwnerMatchesSponsor(
  sponsorId: string,
  expectedRecoveryOwner: unknown,
): Promise<boolean> {
  if (typeof expectedRecoveryOwner !== "string" || !/^[a-f0-9]{64}$/.test(expectedRecoveryOwner)) {
    return false;
  }
  const currentRecoveryOwner = await recoveryOwnerForSponsor(sponsorId);
  return currentRecoveryOwner !== undefined && currentRecoveryOwner === expectedRecoveryOwner;
}

async function requireSponsorId(): Promise<
  | {
      readonly ok: true;
      readonly sponsorId: string;
      readonly authIssuedAt?: number;
    }
  | { readonly ok: false; readonly message: string }
> {
  const session = await auth();
  if (session?.user === undefined) return { ok: false, message: "Not signed in." };
  if (!isCanonicalSponsorId(session.user.id)) {
    return {
      ok: false,
      message: "Your sponsor identity has not been bootstrapped on this deployment.",
    };
  }
  return {
    ok: true,
    sponsorId: session.user.id,
    authIssuedAt: session.authIssuedAt,
  };
}

/**
 * Return an opaque, server-keyed identity for one normalized console write.
 * Session storage can retain this value without exposing a dictionary oracle
 * for private directives or proposal reductions. A dedicated recovery key is
 * read at call time and never crosses into the client. It is deliberately not
 * the rotatable service-envelope signing seed: unchanged retries must retain
 * the same identity for the Worker's complete 24-hour replay window.
 */
export async function fingerprintEnrollmentAttempt(
  scope: "mint" | "decision",
  request: unknown,
  expectedRecoveryOwner: string,
  idempotencyKey: unknown,
): Promise<EnrollmentAttemptFingerprintResult> {
  const sponsor = await requireSponsorId();
  if (!sponsor.ok) return sponsor;
  if (scope !== "mint" && scope !== "decision") {
    return { ok: false, message: "The enrollment attempt type is invalid." };
  }
  if (
    typeof idempotencyKey !== "string" ||
    !/^console-[A-Za-z0-9._-]{1,152}$/.test(idempotencyKey)
  ) {
    return { ok: false, message: "The enrollment recovery key is invalid." };
  }
  if (scope === "decision" && !recentAuthOk(sponsor.authIssuedAt)) {
    return {
      ok: false,
      message:
        "Decisions need a Google sign-in from the last 15 minutes. Reauthenticate before preparing the decision.",
    };
  }
  const parsed =
    scope === "mint"
      ? MintEnrollmentRequestSchema.safeParse(request)
      : SponsorEnrollmentDecisionSchema.safeParse(request);
  if (!parsed.success) {
    return { ok: false, message: "The enrollment attempt is invalid." };
  }
  const rootHex = process.env.ENROLLMENT_RECOVERY_HMAC_KEY_HEX;
  if (
    !enrollmentRecoveryConfigurationIsValid(rootHex, process.env.SERVICE_ENVELOPE_PRIVATE_KEY_HEX)
  ) {
    return {
      ok: false,
      message: "This deployment cannot prepare recoverable writes.",
    };
  }
  try {
    if (!(await recoveryOwnerMatchesSponsor(sponsor.sponsorId, expectedRecoveryOwner))) {
      return {
        ok: false,
        message:
          "Your sponsor session changed. Reload this page before preparing an enrollment write.",
      };
    }
    const serverNow = Date.now();
    const fingerprint = await enrollmentRecoveryFingerprint(
      rootHex,
      sponsor.sponsorId,
      scope,
      parsed.data,
    );
    return {
      ok: true,
      fingerprint,
      recoveryPayload: await sealEnrollmentRecoveryPayload(rootHex, {
        sponsorId: sponsor.sponsorId,
        scope,
        fingerprint,
        idempotencyKey,
        expiresAt: serverNow + ENROLLMENT_RECOVERY_WINDOW_MS,
        request: parsed.data,
      }),
      serverNow,
    };
  } catch {
    return {
      ok: false,
      message: "The browser could not prepare a recoverable write.",
    };
  }
}

/**
 * Seal an exact credential or lifecycle command before it leaves the browser.
 * Fresh Google evidence is checked both here and immediately before dispatch;
 * the signed timestamp itself is never accepted from the client or stored in
 * the recoverable request.
 */
export async function fingerprintLifecycleAttempt(
  scope: LifecycleAttemptScope,
  request: unknown,
  expectedRecoveryOwner: string,
  idempotencyKey: unknown,
): Promise<EnrollmentAttemptFingerprintResult> {
  const sponsor = await requireSponsorId();
  if (!sponsor.ok) return sponsor;
  if (!isLifecycleAttemptScope(scope)) {
    return { ok: false, message: "The lifecycle attempt type is invalid." };
  }
  if (
    typeof idempotencyKey !== "string" ||
    !/^console-[A-Za-z0-9._-]{1,152}$/.test(idempotencyKey)
  ) {
    return { ok: false, message: "The lifecycle recovery key is invalid." };
  }
  const intent = lifecycleIntent(scope, request);
  if (intent === undefined) {
    return { ok: false, message: "The lifecycle command is invalid." };
  }
  if (!recentAuthOk(sponsor.authIssuedAt)) {
    return {
      ok: false,
      message:
        "Credential and lifecycle controls need a Google authentication time from the last 15 minutes. Reauthenticate before preparing this command.",
    };
  }
  const rootHex = process.env.ENROLLMENT_RECOVERY_HMAC_KEY_HEX;
  if (
    !enrollmentRecoveryConfigurationIsValid(rootHex, process.env.SERVICE_ENVELOPE_PRIVATE_KEY_HEX)
  ) {
    return {
      ok: false,
      message: "This deployment cannot prepare recoverable lifecycle commands.",
    };
  }
  try {
    if (!(await recoveryOwnerMatchesSponsor(sponsor.sponsorId, expectedRecoveryOwner))) {
      return {
        ok: false,
        message:
          "Your sponsor session changed. Reload this page before preparing a lifecycle command.",
      };
    }
    const serverNow = Date.now();
    const fingerprint = await enrollmentRecoveryFingerprint(
      rootHex,
      sponsor.sponsorId,
      scope,
      intent.request,
    );
    return {
      ok: true,
      fingerprint,
      recoveryPayload: await sealEnrollmentRecoveryPayload(rootHex, {
        sponsorId: sponsor.sponsorId,
        scope,
        fingerprint,
        idempotencyKey,
        expiresAt: serverNow + ENROLLMENT_RECOVERY_WINDOW_MS,
        request: intent.request,
      }),
      serverNow,
    };
  } catch {
    return {
      ok: false,
      message: "The browser could not prepare a recoverable lifecycle command.",
    };
  }
}

function lifecycleFailure(result: {
  readonly reason: "unconfigured" | "unreachable" | "refused";
  readonly status?: number;
  readonly detail?: string;
  readonly problemCode?: string;
}): LifecycleResult {
  return {
    ok: false,
    recovery:
      result.reason === "unconfigured"
        ? "retain"
        : enrollmentRecoveryDisposition(result.reason, result.status, result.problemCode),
    message:
      result.reason === "unconfigured"
        ? "This deployment is not wired to the agent host. Keep the exact lifecycle command for recovery."
        : result.reason === "unreachable"
          ? "The agent host did not confirm the lifecycle command. Retry it unchanged to reuse its Idempotency-Key."
          : (result.detail ?? "The lifecycle command was not accepted."),
  };
}

async function dispatchLifecycle(
  sponsorId: string,
  intent: LifecycleIntent,
  idempotencyKey: string,
  stepUpAuthenticatedAt: number,
): Promise<LifecycleResult> {
  switch (intent.scope) {
    case "credential-revoke": {
      const command = SponsorCredentialRevokeRequestSchema.parse({
        ...intent.request,
        step_up_authenticated_at: stepUpAuthenticatedAt,
      });
      const result = await stoaRevokeCredential(sponsorId, command, idempotencyKey);
      if (!result.ok) return lifecycleFailure(result);
      bestEffortEnrollmentCacheInvalidation(() => revalidatePath("/console"));
      return {
        ok: true,
        receipt: {
          kind: intent.scope,
          eventId: result.data.event_id,
          fellowId: result.data.fellow_id,
          credentialId: result.data.credential_id,
          sponsorSeq: result.data.sponsor_seq,
          effectiveAt: result.data.effective_at,
        },
      };
    }
    case "fellow-lifecycle": {
      const command = SponsorFellowLifecycleRequestSchema.parse({
        ...intent.request,
        step_up_authenticated_at: stepUpAuthenticatedAt,
      });
      const result = await stoaTransitionFellow(sponsorId, command, idempotencyKey);
      if (!result.ok) return lifecycleFailure(result);
      bestEffortEnrollmentCacheInvalidation(() => revalidatePath("/console"));
      return {
        ok: true,
        receipt: {
          kind: intent.scope,
          eventId: result.data.event_id,
          fellowId: result.data.fellow_id,
          status: result.data.status,
          sponsorSeq: result.data.sponsor_seq,
          effectiveAt: result.data.effective_at,
        },
      };
    }
    case "sponsor-panic": {
      const command = SponsorPanicRequestSchema.parse({
        ...intent.request,
        step_up_authenticated_at: stepUpAuthenticatedAt,
      });
      const result = await stoaPanicSponsor(sponsorId, command, idempotencyKey);
      if (!result.ok) return lifecycleFailure(result);
      bestEffortEnrollmentCacheInvalidation(() => revalidatePath("/console"));
      return {
        ok: true,
        receipt: {
          kind: intent.scope,
          eventId: result.data.event_id,
          sponsorSeq: result.data.sponsor_seq,
          effectiveAt: result.data.effective_at,
        },
      };
    }
  }
}

async function dispatchPreparedLifecycle(
  scope: LifecycleAttemptScope,
  recoveryPayload: string,
  idempotencyKey: string,
  expectedRecoveryOwner: string,
): Promise<LifecycleResult> {
  const sponsor = await requireSponsorId();
  if (!sponsor.ok) return { ...sponsor, recovery: "retain" };
  if (!(await recoveryOwnerMatchesSponsor(sponsor.sponsorId, expectedRecoveryOwner))) {
    return {
      ok: false,
      recovery: "retain",
      message:
        "Your sponsor session changed after this lifecycle command was prepared. Reload under the intended sponsor, then retry the exact unchanged command.",
    };
  }
  const stepUpAuthenticatedAt = sponsor.authIssuedAt;
  if (typeof stepUpAuthenticatedAt !== "number" || !recentAuthOk(stepUpAuthenticatedAt)) {
    return {
      ok: false,
      recovery: "retain",
      message:
        "Credential and lifecycle controls need a Google authentication time from the last 15 minutes. Recheck the Google evidence on this page; if it remains stale, sign in to your Google Account again. The command is unchanged.",
    };
  }
  const rootHex = process.env.ENROLLMENT_RECOVERY_HMAC_KEY_HEX;
  if (
    !enrollmentRecoveryConfigurationIsValid(rootHex, process.env.SERVICE_ENVELOPE_PRIVATE_KEY_HEX)
  ) {
    return {
      ok: false,
      recovery: "retain",
      message: "This deployment cannot open the prepared lifecycle command. Do not start a replacement.",
    };
  }
  try {
    const opened = await openEnrollmentRecoveryPayload(
      rootHex,
      recoveryPayload,
      sponsor.sponsorId,
      scope,
      Date.now(),
    );
    const intent = lifecycleIntent(scope, opened.request);
    if (
      intent === undefined ||
      opened.idempotencyKey !== idempotencyKey ||
      (await enrollmentRecoveryFingerprint(
        rootHex,
        sponsor.sponsorId,
        scope,
        intent.request,
      )) !== opened.fingerprint
    ) {
      throw new Error("invalid recovery payload");
    }
    return dispatchLifecycle(
      sponsor.sponsorId,
      intent,
      opened.idempotencyKey,
      stepUpAuthenticatedAt,
    );
  } catch {
    return {
      ok: false,
      recovery: "retain",
      message:
        "The prepared lifecycle command could not be authenticated or its recovery window ended. Verify the earlier outcome; do not start a replacement automatically.",
    };
  }
}

/** Dispatch a prepared, exact lifecycle command or recover that command after reload. */
export async function recoverLifecycleAttempt(
  scope: LifecycleAttemptScope,
  recoveryPayload: string,
  idempotencyKey: string,
  expectedRecoveryOwner: string,
): Promise<LifecycleResult> {
  if (!isLifecycleAttemptScope(scope)) {
    return {
      ok: false,
      recovery: "clear",
      message: "The stored lifecycle command type is invalid.",
    };
  }
  return dispatchPreparedLifecycle(scope, recoveryPayload, idempotencyKey, expectedRecoveryOwner);
}

/**
 * Mint a one-time join URL. The returned URL carries the fragment secret; it
 * is shown once in the client and never persisted by Agora. Stoa stores its
 * SHA-256 hash plus an authenticated encrypted replay for 24 hours; plaintext
 * is never persisted.
 */
export async function mintJoinUrl(
  recoveryPayload: string,
  idempotencyKey: string,
  expectedRecoveryOwner: string,
): Promise<MintResult> {
  return dispatchPreparedMint(recoveryPayload, idempotencyKey, expectedRecoveryOwner);
}

async function dispatchPreparedMint(
  recoveryPayload: string,
  idempotencyKey: string,
  expectedRecoveryOwner: string,
): Promise<MintResult> {
  const sponsor = await requireSponsorId();
  if (!sponsor.ok) return { ...sponsor, recovery: "retain" };
  if (!(await recoveryOwnerMatchesSponsor(sponsor.sponsorId, expectedRecoveryOwner))) {
    return {
      ok: false,
      recovery: "retain",
      message:
        "Your sponsor session changed after this write was prepared. Reload under the intended sponsor, then retry the exact unchanged attempt.",
    };
  }
  const rootHex = process.env.ENROLLMENT_RECOVERY_HMAC_KEY_HEX;
  if (
    !enrollmentRecoveryConfigurationIsValid(rootHex, process.env.SERVICE_ENVELOPE_PRIVATE_KEY_HEX)
  ) {
    return {
      ok: false,
      recovery: "retain",
      message: "This deployment cannot open the prepared mint. Do not start a replacement.",
    };
  }
  try {
    const opened = await openEnrollmentRecoveryPayload(
      rootHex,
      recoveryPayload,
      sponsor.sponsorId,
      "mint",
      Date.now(),
    );
    const parsed = MintEnrollmentRequestSchema.safeParse(opened.request);
    if (
      !parsed.success ||
      opened.idempotencyKey !== idempotencyKey ||
      (await enrollmentRecoveryFingerprint(rootHex, sponsor.sponsorId, "mint", parsed.data)) !==
        opened.fingerprint
    ) {
      throw new Error("invalid recovery payload");
    }
    return dispatchMint(sponsor.sponsorId, parsed.data, opened.idempotencyKey);
  } catch {
    return {
      ok: false,
      recovery: "retain",
      message:
        "The prepared mint could not be authenticated or its recovery window ended. Verify the earlier outcome; do not start a replacement automatically.",
    };
  }
}

async function dispatchMint(
  sponsorId: string,
  request: MintEnrollmentRequest,
  idempotencyKey: string,
): Promise<MintResult> {
  const result = await stoaMintEnrollment(sponsorId, request, idempotencyKey);
  if (!result.ok) {
    return {
      ok: false,
      recovery:
        result.reason === "unconfigured"
          ? "retain"
          : enrollmentRecoveryDisposition(result.reason, result.status, result.problemCode),
      message:
        result.reason === "unconfigured"
          ? "This deployment is not wired to the agent host."
          : result.reason === "unreachable"
            ? "The agent host did not confirm the mint. Retry without changing these settings to recover the same one-time URL."
            : (result.detail ?? "The agent host refused the mint."),
    };
  }
  bestEffortEnrollmentCacheInvalidation(() => revalidatePath("/console"));
  return {
    ok: true,
    joinUrl: result.data.join_url,
    enrollmentId: result.data.enrollment_id,
    expiresAt: result.data.expires_at,
  };
}

/** Recover the exact normalized mint body after a crash or full reload. */
export async function recoverMintJoinUrl(
  recoveryPayload: string,
  idempotencyKey: string,
  expectedRecoveryOwner: string,
): Promise<MintResult> {
  return dispatchPreparedMint(recoveryPayload, idempotencyKey, expectedRecoveryOwner);
}

/**
 * Approve, reduce, or deny a pending proposal. This is a permanent public
 * binding, so W3.4 requires recent signed Google authentication evidence. The
 * provider `auth_time` projected as `authIssuedAt` is used here, never
 * refreshable JWT `iat`, callback arrival, or a client-supplied time.
 */
export async function decideProposal(
  recoveryPayload: string,
  idempotencyKey: string,
  expectedRecoveryOwner: string,
): Promise<DecideResult> {
  return dispatchPreparedDecision(recoveryPayload, idempotencyKey, expectedRecoveryOwner);
}

async function dispatchPreparedDecision(
  recoveryPayload: string,
  idempotencyKey: string,
  expectedRecoveryOwner: string,
): Promise<DecideResult> {
  const sponsor = await requireSponsorId();
  if (!sponsor.ok) return { ...sponsor, recovery: "retain" };
  if (!(await recoveryOwnerMatchesSponsor(sponsor.sponsorId, expectedRecoveryOwner))) {
    return {
      ok: false,
      recovery: "retain",
      message:
        "Your sponsor session changed after this decision was prepared. Reload under the intended sponsor, then retry the exact unchanged decision.",
    };
  }
  const stepUpAuthenticatedAt = sponsor.authIssuedAt;
  if (typeof stepUpAuthenticatedAt !== "number" || !recentAuthOk(stepUpAuthenticatedAt)) {
    return {
      ok: false,
      recovery: "retain",
      message:
        "Decisions need a Google authentication time from the last 15 minutes. Recheck the Google evidence on this page; if it remains stale, sign in to your Google Account again. The proposal is unchanged.",
    };
  }
  const rootHex = process.env.ENROLLMENT_RECOVERY_HMAC_KEY_HEX;
  if (
    !enrollmentRecoveryConfigurationIsValid(rootHex, process.env.SERVICE_ENVELOPE_PRIVATE_KEY_HEX)
  ) {
    return {
      ok: false,
      recovery: "retain",
      message: "This deployment cannot open the prepared decision. Do not start a replacement.",
    };
  }
  try {
    const opened = await openEnrollmentRecoveryPayload(
      rootHex,
      recoveryPayload,
      sponsor.sponsorId,
      "decision",
      Date.now(),
    );
    const parsed = SponsorEnrollmentDecisionSchema.safeParse(opened.request);
    if (
      !parsed.success ||
      opened.idempotencyKey !== idempotencyKey ||
      (await enrollmentRecoveryFingerprint(rootHex, sponsor.sponsorId, "decision", parsed.data)) !==
        opened.fingerprint
    ) {
      throw new Error("invalid recovery payload");
    }
    return dispatchDecision(
      sponsor.sponsorId,
      parsed.data.enrollment_id,
      parsed.data,
      opened.idempotencyKey,
      stepUpAuthenticatedAt,
    );
  } catch {
    return {
      ok: false,
      recovery: "retain",
      message:
        "The prepared decision could not be authenticated or its recovery window ended. Verify the earlier outcome; do not start a replacement automatically.",
    };
  }
}

async function dispatchDecision(
  sponsorId: string,
  enrollmentId: string,
  decision: SponsorEnrollmentDecision,
  idempotencyKey: string,
  stepUpAuthenticatedAt: number,
): Promise<DecideResult> {
  const command = SponsorEnrollmentDecisionCommandSchema.parse({
    ...decision,
    step_up_authenticated_at: stepUpAuthenticatedAt,
  });
  const result = await stoaDecideProposal(sponsorId, enrollmentId, command, idempotencyKey);
  if (!result.ok) {
    return {
      ok: false,
      recovery:
        result.reason === "unconfigured"
          ? "retain"
          : enrollmentRecoveryDisposition(result.reason, result.status, result.problemCode),
      message:
        result.reason === "unconfigured"
          ? "This deployment is not wired to the agent host. The proposal is unchanged."
          : result.reason === "unreachable"
            ? "The agent host did not confirm the outcome. Retry this unchanged decision to reuse its Idempotency-Key, then refresh the pending list."
            : (result.detail ?? "The decision was not accepted."),
    };
  }
  bestEffortEnrollmentCacheInvalidation(() => revalidatePath("/console"));
  return { ok: true, decision: decision.decision };
}

/** Recover an exact prepared decision even when its pending card disappeared. */
export async function recoverProposalDecision(
  recoveryPayload: string,
  idempotencyKey: string,
  expectedRecoveryOwner: string,
): Promise<DecideResult> {
  return dispatchPreparedDecision(recoveryPayload, idempotencyKey, expectedRecoveryOwner);
}
