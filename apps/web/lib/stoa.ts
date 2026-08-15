import "server-only";

import {
  type MintEnrollmentRequest,
  type MintEnrollmentResponse,
  MintEnrollmentResponseSchema,
  type SponsorEnrollmentDecision,
  type SponsorEnrollmentDecisionResponse,
  SponsorEnrollmentDecisionResponseSchema,
  type SponsorBootstrapResponse,
  SponsorBootstrapResponseSchema,
  type SponsorFellowListResponse,
  SponsorFellowListResponseSchema,
  type SponsorProposalListResponse,
  SponsorProposalListResponseSchema,
} from "@asimposium/contracts";

import { dispatchSignedSponsorRequest } from "./stoa-sponsor";
import { importEd25519PrivateSeedHex } from "./service-envelope";
import { isCanonicalSponsorId } from "./sponsor-id";

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
const ROUTE_BOOTSTRAP = "/v1/sponsors/bootstrap";

const ACTION_MINT = "enrollment.mint";
const ACTION_PROPOSALS = "enrollment.proposals.list";
const ACTION_DECIDE = "enrollment.decide";
const ACTION_FELLOWS = "fellows.list";
const ACTION_BOOTSTRAP = "sponsor.bootstrap";

export type StoaCall<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      /** `unconfigured`: no signing key here. `unreachable`: host down or bad body. `refused`: Stoa answered a problem. */
      readonly reason: "unconfigured" | "unreachable" | "refused";
      readonly status?: number;
      readonly detail?: string;
    };

interface StoaSigningConfig {
  readonly privateKey: CryptoKey;
  readonly kid: string;
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

/** The refusal detail: retain only a short problem JSON `title`, never the raw body. */
async function refusalDetail(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text();
    if (text.length > 65_536) return undefined;
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && "title" in parsed) {
      // One-field boundary read off a problem body; presence checked by `in`.
      const record: Record<string, unknown> = parsed as Record<string, unknown>;
      const title = record.title;
      if (typeof title === "string") return title.slice(0, 200);
    }
  } catch {
    // A refusal with an unparseable body still reports its status.
  }
  return undefined;
}

async function callStoa<T>(options: {
  readonly method: "GET" | "POST";
  /** Route *template*, signed into the envelope. */
  readonly route: string;
  /** The filled path actually fetched. */
  readonly path: string;
  readonly action: string;
  readonly principalId: string;
  /** The exact body bytes — signed and sent, never reserialized. */
  readonly body: string;
  readonly idempotencyKey?: string;
  readonly parse: (value: unknown) => T;
}): Promise<StoaCall<T>> {
  if (!isCanonicalSponsorId(options.principalId)) {
    return { ok: false, reason: "unconfigured" };
  }
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
      rawBody: options.body,
      privateKey: config.privateKey,
      kid: config.kid,
      now: Math.floor(Date.now() / 1_000),
      timeoutMs: 8_000,
      idempotencyKey: options.idempotencyKey,
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (!response.ok) {
    return {
      ok: false,
      reason: "refused",
      status: response.status,
      detail: await refusalDetail(response),
    };
  }
  try {
    return { ok: true, data: options.parse(await response.json()) };
  } catch {
    // A 2xx that does not parse to the contract is a host failure, not data.
    return { ok: false, reason: "unreachable" };
  }
}

/** True when this deployment holds an envelope signing key (production does; preview never must). */
export async function stoaConfigured(): Promise<boolean> {
  return (await signingConfig()) !== undefined;
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
    parse: (value) => MintEnrollmentResponseSchema.parse(value),
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
  decision: SponsorEnrollmentDecision,
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

export function stoaFellows(principalId: string): Promise<StoaCall<SponsorFellowListResponse>> {
  return callStoa({
    method: "GET",
    route: ROUTE_FELLOWS,
    path: ROUTE_FELLOWS,
    action: ACTION_FELLOWS,
    principalId,
    body: "",
    parse: (value) => SponsorFellowListResponseSchema.parse(value),
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
    body: "",
    parse: (value) => SponsorBootstrapResponseSchema.parse(value),
  });
}
