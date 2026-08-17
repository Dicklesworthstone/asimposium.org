import "server-only";

import {
  type DeviceLookupResponse,
  DeviceLookupResponseSchema,
  isTrustedStoaOrigin,
  type MintEnrollmentRequest,
  type MintEnrollmentResponse,
  MintEnrollmentResponseSchema,
  type OperatorFellowCapAuditCursor,
  OperatorFellowCapAuditCursorSchema,
  type OperatorFellowCapAuditPageResponse,
  OperatorFellowCapAuditPageResponseSchema,
  type OperatorFellowCapOverrideRequest,
  OperatorFellowCapOverrideRequestSchema,
  type OperatorFellowCapOverrideResponse,
  OperatorFellowCapOverrideResponseSchema,
  type OperatorFellowCapStateResponse,
  OperatorFellowCapStateResponseSchema,
  type ProblemCode,
  ProblemDocumentSchema,
  parseStoaJoinUrl,
  type SponsorBootstrapResponse,
  SponsorBootstrapResponseSchema,
  type SponsorCredentialRevokeRequest,
  type SponsorCredentialRevokeResponse,
  SponsorCredentialRevokeResponseSchema,
  type SponsorEnrollmentDecisionCommand,
  type SponsorEnrollmentDecisionResponse,
  SponsorEnrollmentDecisionResponseSchema,
  type SponsorFellowCursor,
  SponsorFellowCursorSchema,
  type SponsorFellowLifecycleRequest,
  type SponsorFellowLifecycleResponse,
  SponsorFellowLifecycleResponseSchema,
  type SponsorFellowListResponse,
  SponsorFellowListResponseSchema,
  type SponsorPanicRequest,
  type SponsorPanicResponse,
  SponsorPanicResponseSchema,
  type SponsorProposalListResponse,
  SponsorProposalListResponseSchema,
} from "@asimposium/contracts";
import {
  enrollmentRecoveryConfigurationIsValid,
  enrollmentRecoveryOwner,
} from "./enrollment-recovery";
import { importEd25519PrivateSeedHex } from "./service-envelope";
import { isCanonicalSponsorId } from "./sponsor-id";
import { dispatchSignedSponsorRequest } from "./stoa-sponsor";

/**
 * Agora's typed client for the Stoa sponsor surface. Server-only: it reads the
 * envelope signing key from the environment at call time (never at module
 * scope) and must never be imported by a client component.
 *
 * The route templates and action strings here are the contract with
 * `apps/wire/src/enrollment/router.ts`; the Worker's envelope verification
 * signs over exactly these strings, so a rename on one side without the other
 * fails closed as `bad_signature`, never as a silent mismatch.
 */

const ROUTE_MINT = "/v1/enrollments";
const ROUTE_PROPOSALS = "/v1/enrollments/proposals";
const ROUTE_DECISION = "/v1/enrollments/:enrollmentId/decision";
const ROUTE_FELLOWS = "/v1/fellows";
const ROUTE_FELLOWS_AFTER = "/v1/fellows/after/:cursor";
const ROUTE_CREDENTIAL_REVOKE = "/v1/fellows/credentials/revoke";
const ROUTE_FELLOW_LIFECYCLE = "/v1/fellows/lifecycle";
const ROUTE_SPONSOR_PANIC = "/v1/sponsors/panic";
const ROUTE_BOOTSTRAP = "/v1/sponsors/bootstrap";
const ROUTE_DEVICE_LOOKUP = "/v1/device-lookup";
const ROUTE_OPERATOR_FELLOW_CAP = "/v1/operators/fellow-cap";
const ROUTE_OPERATOR_FELLOW_CAP_STATE = "/v1/operators/sponsors/:sponsorId/fellow-cap";
const ROUTE_OPERATOR_FELLOW_CAP_HISTORY = "/v1/operators/sponsors/:sponsorId/fellow-cap/history";
const ROUTE_OPERATOR_FELLOW_CAP_HISTORY_AFTER =
  "/v1/operators/sponsors/:sponsorId/fellow-cap/history/after/:cursor";

const ACTION_MINT = "enrollment.mint";
const ACTION_PROPOSALS = "enrollment.proposals.list";
const ACTION_DECIDE = "enrollment.decide";
const ACTION_FELLOWS = "fellows.list";
const ACTION_CREDENTIAL_REVOKE = "fellow.credential.revoke";
const ACTION_FELLOW_LIFECYCLE = "fellow.lifecycle.change";
const ACTION_SPONSOR_PANIC = "sponsor.panic";
const ACTION_BOOTSTRAP = "sponsor.bootstrap";
const ACTION_DEVICE_LOOKUP = "enrollment.device.lookup";
const ACTION_OPERATOR_FELLOW_CAP_OVERRIDE = "operator.fellow-cap.override";
const ACTION_OPERATOR_FELLOW_CAP_READ = "operator.fellow-cap.read";
const ACTION_OPERATOR_FELLOW_CAP_HISTORY = "operator.fellow-cap.history";

export type StoaCall<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      /** `unconfigured`: no signing key here. `unreachable`: host down or bad body. `refused`: Stoa answered a problem. */
      readonly reason: "unconfigured" | "unreachable" | "refused";
      readonly status?: number;
      readonly detail?: string;
      readonly problemCode?: ProblemCode;
    };

interface StoaSigningConfig {
  readonly privateKey: CryptoKey;
  readonly kid: string;
}

/**
 * The Apex repeats the Worker allowlist before it spends a signing nonce or
 * dispatches an operator command. The Worker remains authoritative, but this
 * closes a stale console session before it becomes a cross-plane mutation.
 */
export function operatorPrincipalIsAllowed(
  principalId: string,
  configured = process.env.OPERATOR_PRINCIPAL_IDS,
): boolean {
  if (!isCanonicalSponsorId(principalId) || configured === undefined) return false;
  const ids = configured.split(",").map((value) => value.trim());
  if (ids.length === 0 || ids.some((id) => !isCanonicalSponsorId(id))) return false;
  const unique = new Set(ids);
  return unique.size === ids.length && unique.has(principalId);
}

/**
 * Resolve the sole Worker origin for this server process. It is intentionally
 * environment-only: request Host and forwarding headers are attacker input.
 * There is no production fallback, so a preview with no explicit origin cannot
 * accidentally sign or fetch against production.
 */
export function configuredStoaOrigin(): string | undefined {
  return configuredStoaOriginValue(process.env.STOA_ORIGIN);
}

/**
 * The same closed origin resolver for server-only diagnostics and tests. The
 * caller supplies only configuration, never request headers or a response URL.
 */
export function configuredStoaOriginValue(origin: unknown): string | undefined {
  return isTrustedStoaOrigin(origin) ? origin : undefined;
}

async function signingConfig(): Promise<StoaSigningConfig | undefined> {
  const hex = process.env.SERVICE_ENVELOPE_PRIVATE_KEY_HEX;
  const kid = process.env.SERVICE_ENVELOPE_KID;
  if (hex === undefined || kid === undefined) return undefined;
  if (!/^[0-9a-f]{64}$/.test(hex) || !/^[A-Za-z0-9._-]{1,64}$/.test(kid)) return undefined;
  try {
    return { privateKey: await importEd25519PrivateSeedHex(hex), kid };
  } catch {
    return undefined;
  }
}

/** Retain only schema-validated problem metadata, never the raw refusal body. */
async function refusalInfo(
  response: Response,
): Promise<{ readonly detail?: string; readonly problemCode?: ProblemCode }> {
  try {
    const text = await response.text();
    if (text.length > 65_536) return {};
    const value: unknown = JSON.parse(text);
    const problem = ProblemDocumentSchema.safeParse(value);
    if (!problem.success || problem.data.status !== response.status) return {};
    return {
      detail: problem.data.title.slice(0, 200),
      problemCode: problem.data.code,
    };
  } catch {
    // A refusal without a valid Worker problem remains ambiguous.
  }
  return {};
}

async function callStoa<T>(options: {
  readonly method: "GET" | "POST";
  /** Route *template*, signed into the envelope. */
  readonly route: string;
  /** The filled path actually fetched. */
  readonly path: string;
  readonly action: string;
  readonly principalId: string;
  readonly principalType?: "sponsor" | "operator";
  /** The exact body bytes — signed and sent, never reserialized. */
  readonly body: string;
  readonly idempotencyKey?: string;
  /** Parse the response while retaining the exact origin used for this request. */
  readonly parse: (value: unknown, stoaOrigin: string) => T;
}): Promise<StoaCall<T>> {
  if (!isCanonicalSponsorId(options.principalId)) {
    return { ok: false, reason: "unconfigured" };
  }
  if (
    options.principalType === "operator" &&
    !operatorPrincipalIsAllowed(options.principalId)
  ) {
    return { ok: false, reason: "unconfigured" };
  }
  const stoaOrigin = configuredStoaOrigin();
  if (stoaOrigin === undefined) return { ok: false, reason: "unconfigured" };
  const config = await signingConfig();
  if (config === undefined) return { ok: false, reason: "unconfigured" };

  let response: Response;
  try {
    response = await dispatchSignedSponsorRequest({
      method: options.method,
      path: options.path,
      route: options.route,
      action: options.action,
      sponsorId: options.principalId,
      ...(options.principalType === undefined ? {} : { principalType: options.principalType }),
      rawBody: options.body,
      privateKey: config.privateKey,
      kid: config.kid,
      stoaOrigin,
      ...(stoaOrigin.startsWith("http://127.0.0.1:") ? { insecureLoopbackOrigin: stoaOrigin } : {}),
      now: Math.floor(Date.now() / 1_000),
      timeoutMs: 8_000,
      idempotencyKey: options.idempotencyKey,
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (!response.ok) {
    const refusal = await refusalInfo(response);
    return {
      ok: false,
      reason: "refused",
      status: response.status,
      ...refusal,
    };
  }
  try {
    return { ok: true, data: options.parse(await response.json(), stoaOrigin) };
  } catch {
    // A 2xx that does not parse to the contract is a host failure, not data.
    return { ok: false, reason: "unreachable" };
  }
}

/** True only when this deployment has a trusted configured origin and signing key. */
export async function stoaConfigured(): Promise<boolean> {
  return configuredStoaOrigin() !== undefined && (await signingConfig()) !== undefined;
}

/** True when sponsor writes have both signing and stable recovery-key configuration. */
export async function stoaEnrollmentWritesConfigured(): Promise<boolean> {
  return (
    configuredStoaOrigin() !== undefined &&
    (await signingConfig()) !== undefined &&
    enrollmentRecoveryConfigurationIsValid(
      process.env.ENROLLMENT_RECOVERY_HMAC_KEY_HEX,
      process.env.SERVICE_ENVELOPE_PRIVATE_KEY_HEX,
    )
  );
}

/** Opaque sponsor binding for client-memory recovery; never exposes the sponsor id itself. */
export async function stoaEnrollmentRecoveryOwner(sponsorId: string): Promise<string | undefined> {
  if (!isCanonicalSponsorId(sponsorId)) return undefined;
  if (configuredStoaOrigin() === undefined) return undefined;
  const rootHex = process.env.ENROLLMENT_RECOVERY_HMAC_KEY_HEX;
  if (
    !enrollmentRecoveryConfigurationIsValid(rootHex, process.env.SERVICE_ENVELOPE_PRIVATE_KEY_HEX)
  ) {
    return undefined;
  }
  try {
    return await enrollmentRecoveryOwner(rootHex, sponsorId);
  } catch {
    return undefined;
  }
}

export function stoaMintEnrollment(
  principalId: string,
  request: MintEnrollmentRequest,
  idempotencyKey: string,
): Promise<StoaCall<MintEnrollmentResponse>> {
  const body = JSON.stringify(request);
  return callStoa({
    method: "POST",
    route: ROUTE_MINT,
    path: ROUTE_MINT,
    action: ACTION_MINT,
    principalId,
    body,
    idempotencyKey,
    parse: (value, stoaOrigin) => {
      const response = MintEnrollmentResponseSchema.parse(value);
      const parsedJoinUrl = parseStoaJoinUrl(response.join_url);
      if (parsedJoinUrl === undefined || parsedJoinUrl.origin !== stoaOrigin) {
        throw new TypeError("mint response join URL must name the dispatched Stoa origin");
      }
      return response;
    },
  });
}

export function stoaPendingProposals(
  principalId: string,
): Promise<StoaCall<SponsorProposalListResponse>> {
  return callStoa({
    method: "GET",
    route: ROUTE_PROPOSALS,
    path: ROUTE_PROPOSALS,
    action: ACTION_PROPOSALS,
    principalId,
    body: "",
    parse: (value) => SponsorProposalListResponseSchema.parse(value),
  });
}

export function stoaDecideProposal(
  principalId: string,
  enrollmentId: string,
  decision: SponsorEnrollmentDecisionCommand,
  idempotencyKey: string,
): Promise<StoaCall<SponsorEnrollmentDecisionResponse>> {
  return callStoa({
    method: "POST",
    route: ROUTE_DECISION,
    path: `/v1/enrollments/${enrollmentId}/decision`,
    action: ACTION_DECIDE,
    principalId,
    body: JSON.stringify(decision),
    idempotencyKey,
    parse: (value) => SponsorEnrollmentDecisionResponseSchema.parse(value),
  });
}

export function stoaFellows(
  principalId: string,
  after?: SponsorFellowCursor,
): Promise<StoaCall<SponsorFellowListResponse>> {
  const cursor = after === undefined ? undefined : SponsorFellowCursorSchema.parse(after);
  return callStoa({
    method: "GET",
    route: cursor === undefined ? ROUTE_FELLOWS : ROUTE_FELLOWS_AFTER,
    path: cursor === undefined ? ROUTE_FELLOWS : `/v1/fellows/after/${cursor}`,
    action: ACTION_FELLOWS,
    principalId,
    body: "",
    parse: (value) => SponsorFellowListResponseSchema.parse(value),
  });
}

/** Operator-only read of the exact precondition for a cap compare-and-set. */
export function stoaOperatorFellowCapState(
  operatorId: string,
  sponsorId: string,
): Promise<StoaCall<OperatorFellowCapStateResponse>> {
  return callStoa({
    method: "GET",
    route: ROUTE_OPERATOR_FELLOW_CAP_STATE,
    path: `/v1/operators/sponsors/${sponsorId}/fellow-cap`,
    action: ACTION_OPERATOR_FELLOW_CAP_READ,
    principalId: operatorId,
    principalType: "operator",
    body: "",
    parse: (value) => OperatorFellowCapStateResponseSchema.parse(value),
  });
}

/** Operator-only immutable audit history, using the exact Worker keyset cursor. */
export function stoaOperatorFellowCapAudit(
  operatorId: string,
  sponsorId: string,
  after?: OperatorFellowCapAuditCursor,
): Promise<StoaCall<OperatorFellowCapAuditPageResponse>> {
  const cursor =
    after === undefined ? undefined : OperatorFellowCapAuditCursorSchema.parse(after);
  return callStoa({
    method: "GET",
    route: cursor === undefined ? ROUTE_OPERATOR_FELLOW_CAP_HISTORY : ROUTE_OPERATOR_FELLOW_CAP_HISTORY_AFTER,
    path:
      cursor === undefined
        ? `/v1/operators/sponsors/${sponsorId}/fellow-cap/history`
        : `/v1/operators/sponsors/${sponsorId}/fellow-cap/history/after/${cursor}`,
    action: ACTION_OPERATOR_FELLOW_CAP_HISTORY,
    principalId: operatorId,
    principalType: "operator",
    body: "",
    parse: (value) => OperatorFellowCapAuditPageResponseSchema.parse(value),
  });
}

/** Operator-only signed cap override. The server action stamps recent-auth evidence. */
export function stoaOperatorOverrideFellowCap(
  operatorId: string,
  request: OperatorFellowCapOverrideRequest,
  idempotencyKey: string,
): Promise<StoaCall<OperatorFellowCapOverrideResponse>> {
  const command = OperatorFellowCapOverrideRequestSchema.parse(request);
  return callStoa({
    method: "POST",
    route: ROUTE_OPERATOR_FELLOW_CAP,
    path: ROUTE_OPERATOR_FELLOW_CAP,
    action: ACTION_OPERATOR_FELLOW_CAP_OVERRIDE,
    principalId: operatorId,
    principalType: "operator",
    body: JSON.stringify(command),
    idempotencyKey,
    parse: (value) => OperatorFellowCapOverrideResponseSchema.parse(value),
  });
}

export function stoaRevokeCredential(
  principalId: string,
  request: SponsorCredentialRevokeRequest,
  idempotencyKey: string,
): Promise<StoaCall<SponsorCredentialRevokeResponse>> {
  return callStoa({
    method: "POST",
    route: ROUTE_CREDENTIAL_REVOKE,
    path: ROUTE_CREDENTIAL_REVOKE,
    action: ACTION_CREDENTIAL_REVOKE,
    principalId,
    body: JSON.stringify(request),
    idempotencyKey,
    parse: (value) => SponsorCredentialRevokeResponseSchema.parse(value),
  });
}

export function stoaTransitionFellow(
  principalId: string,
  request: SponsorFellowLifecycleRequest,
  idempotencyKey: string,
): Promise<StoaCall<SponsorFellowLifecycleResponse>> {
  return callStoa({
    method: "POST",
    route: ROUTE_FELLOW_LIFECYCLE,
    path: ROUTE_FELLOW_LIFECYCLE,
    action: ACTION_FELLOW_LIFECYCLE,
    principalId,
    body: JSON.stringify(request),
    idempotencyKey,
    parse: (value) => SponsorFellowLifecycleResponseSchema.parse(value),
  });
}

export function stoaPanicSponsor(
  principalId: string,
  request: SponsorPanicRequest,
  idempotencyKey: string,
): Promise<StoaCall<SponsorPanicResponse>> {
  return callStoa({
    method: "POST",
    route: ROUTE_SPONSOR_PANIC,
    path: ROUTE_SPONSOR_PANIC,
    action: ACTION_SPONSOR_PANIC,
    principalId,
    body: JSON.stringify(request),
    idempotencyKey,
    parse: (value) => SponsorPanicResponseSchema.parse(value),
  });
}

/** W3.5: sponsor lookup of a pending device proposal by its human code. */
export function stoaDeviceLookup(
  principalId: string,
  userCode: string,
): Promise<StoaCall<DeviceLookupResponse>> {
  return callStoa({
    method: "POST",
    route: ROUTE_DEVICE_LOOKUP,
    path: ROUTE_DEVICE_LOOKUP,
    action: ACTION_DEVICE_LOOKUP,
    principalId,
    body: JSON.stringify({ user_code: userCode }),
    parse: (value) => DeviceLookupResponseSchema.parse(value),
  });
}

/** W3.1: idempotent sponsor bootstrap through the single writer. */
export function stoaBootstrapSponsor(
  principalId: string,
): Promise<StoaCall<SponsorBootstrapResponse>> {
  return callStoa({
    method: "POST",
    route: ROUTE_BOOTSTRAP,
    path: ROUTE_BOOTSTRAP,
    action: ACTION_BOOTSTRAP,
    principalId,
    body: "{}",
    parse: (value) => SponsorBootstrapResponseSchema.parse(value),
  });
}
