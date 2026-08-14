import {
  type MintEnrollmentRequest,
  type MintEnrollmentResponse,
  MintEnrollmentResponseSchema,
  type SponsorEnrollmentDecision,
  type SponsorEnrollmentDecisionResponse,
  SponsorEnrollmentDecisionResponseSchema,
  type SponsorFellowListResponse,
  SponsorFellowListResponseSchema,
  type SponsorProposalListResponse,
  SponsorProposalListResponseSchema,
} from "@asimposium/contracts";

import { mintServiceEnvelope, serviceEnvelopeHeaders } from "./service-envelope";
import { SITE } from "./site";

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

const ENVELOPE_ISSUER = "agora";
const ENVELOPE_AUDIENCE = "stoa";

const ROUTE_MINT = "/v1/enrollments";
const ROUTE_PROPOSALS = "/v1/enrollments/proposals";
const ROUTE_DECISION = "/v1/enrollments/:enrollmentId/decision";
const ROUTE_FELLOWS = "/v1/fellows";

const ACTION_MINT = "enrollment.mint";
const ACTION_PROPOSALS = "enrollment.proposals.list";
const ACTION_DECIDE = "enrollment.decide";
const ACTION_FELLOWS = "fellows.list";

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
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  try {
    const privateKey = await crypto.subtle.importKey("raw", bytes, { name: "Ed25519" }, false, [
      "sign",
    ]);
    return { privateKey, kid };
  } catch {
    return undefined;
  }
}

/** The refusal detail, bounded: problem JSON `title` only, never the raw body. */
async function refusalDetail(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text();
    const parsed: unknown = JSON.parse(text.slice(0, 4_096));
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
  readonly parse: (value: unknown) => T;
}): Promise<StoaCall<T>> {
  const config = await signingConfig();
  if (config === undefined) return { ok: false, reason: "unconfigured" };

  const envelope = await mintServiceEnvelope({
    privateKey: config.privateKey,
    kid: config.kid,
    now: Math.floor(Date.now() / 1_000),
    issuer: ENVELOPE_ISSUER,
    audience: ENVELOPE_AUDIENCE,
    method: options.method,
    route: options.route,
    action: options.action,
    principalId: options.principalId,
    body: options.body,
  });

  let response: Response;
  try {
    response = await fetch(`${SITE.stoa}${options.path}`, {
      method: options.method,
      headers: serviceEnvelopeHeaders(envelope),
      body: options.method === "GET" ? undefined : options.body,
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
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
): Promise<StoaCall<MintEnrollmentResponse>> {
  const body = JSON.stringify(request);
  return callStoa({
    method: "POST",
    route: ROUTE_MINT,
    path: ROUTE_MINT,
    action: ACTION_MINT,
    principalId,
    body,
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
): Promise<StoaCall<SponsorEnrollmentDecisionResponse>> {
  return callStoa({
    method: "POST",
    route: ROUTE_DECISION,
    path: `/v1/enrollments/${enrollmentId}/decision`,
    action: ACTION_DECIDE,
    principalId,
    body: JSON.stringify(decision),
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
