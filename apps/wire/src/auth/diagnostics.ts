/**
 * Secret-safe diagnostics for the cross-plane seam (Fable §14.3 never-log list).
 *
 * An auth decision is exactly the event an operator most wants logged and the
 * one most likely to carry material that must never be written down: the
 * signature, the session cookie, the bearer token, the OAuth code, the request
 * body.
 *
 * The defence here is structural rather than a redaction pass. This module is
 * given the *decision*, not the request: there is no parameter through which a
 * signature or a cookie could arrive, so no amount of careless calling can put
 * one in a log line. What is emitted is bounded to non-secret identifiers plus
 * short digest prefixes that are useful for correlation and useless for
 * reconstruction.
 */
import { type ServiceEnvelopeClaims, sha256Hex } from "./canonical";
import type { EnvelopeRefusalReason } from "./envelope";
import type { PrincipalRefusalReason } from "./principal";

/** Prefix length for correlation digests. 12 hex chars = 48 bits. */
const DIGEST_PREFIX = 12;

export interface AuthDiagnostic {
  event: "cross_plane_auth";
  outcome: "accepted" | "refused";
  /** Coarse external code, the one the caller also receives. */
  code: "OK" | "UNAUTHORIZED" | "WRONG_PRINCIPAL";
  /** Internal enumerated reason. Never free text, never attacker-controlled. */
  reason: EnvelopeRefusalReason | PrincipalRefusalReason | "accepted";
  /** Route template, never a filled path: no ids, no query, no fragment. */
  route: string;
  method: string;
  /** Non-secret key identifier, with its authentication state beside it. */
  kid?: string;
  kid_claim_state?: ClaimState;
  action?: string;
  action_claim_state?: ClaimState;
  /** Pseudonymous, salted digest prefix of the acting principal. */
  principal_pseudonym?: string;
  /** First bytes of the payload digest, for correlating a write to its body. */
  payload_digest_prefix?: string;
  payload_digest_claim_state?: ClaimState;
  /** Milliseconds, rounded. */
  duration_ms?: number;
}

/**
 * Parsed envelope fields are attacker input until a signature has verified.
 * A refusal may still record bounded values for correlation, but must label
 * them rather than silently turning them into trusted operator facts.
 */
export type ClaimState = "authenticated_claim" | "unauthenticated_attacker_claim";

/**
 * Stable pseudonym for a principal id.
 *
 * Salted so the digest cannot be reversed by enumerating a small id space, and
 * truncated so it correlates events without becoming a durable identifier in
 * its own right. The salt is operator-held and never logged.
 */
export async function principalPseudonym(principalId: string, salt: string): Promise<string> {
  const digest = await sha256Hex(new TextEncoder().encode(`${salt}${principalId}`));
  return digest.slice(0, DIGEST_PREFIX);
}

export interface DiagnosticInput {
  outcome: "accepted" | "refused";
  code: AuthDiagnostic["code"];
  reason: AuthDiagnostic["reason"];
  method: string;
  route: string;
  durationMs?: number;
  /** Present only once an envelope has parsed; still not secret material. */
  claims?: Pick<ServiceEnvelopeClaims, "kid" | "action" | "payload_sha256">;
  /** Required for a trusted label; omitted claims default conservatively below. */
  claimsState?: ClaimState;
  /** Precomputed by `principalPseudonym`; the raw id is not accepted here. */
  principalPseudonym?: string;
}

export function buildAuthDiagnostic(input: DiagnosticInput): AuthDiagnostic {
  const record: AuthDiagnostic = {
    event: "cross_plane_auth",
    outcome: input.outcome,
    code: input.code,
    reason: input.reason,
    method: input.method,
    route: input.route,
  };
  if (input.claims !== undefined) {
    // A caller that forgets to identify a successful signature must not turn
    // raw envelope fields into trusted telemetry. More importantly, a refusal
    // can never carry an authenticated-claim label, even if its caller passes
    // one accidentally: failed verification leaves every parsed field attacker
    // input for diagnostic purposes.
    const claimsState =
      input.outcome === "accepted" && input.claimsState === "authenticated_claim"
        ? "authenticated_claim"
        : "unauthenticated_attacker_claim";
    record.kid = input.claims.kid;
    record.kid_claim_state = claimsState;
    record.action = input.claims.action;
    record.action_claim_state = claimsState;
    record.payload_digest_prefix = input.claims.payload_sha256.slice(0, DIGEST_PREFIX);
    record.payload_digest_claim_state = claimsState;
  }
  if (input.principalPseudonym !== undefined) {
    record.principal_pseudonym = input.principalPseudonym;
  }
  if (input.durationMs !== undefined) {
    record.duration_ms = Math.max(0, Math.round(input.durationMs));
  }
  return record;
}

export function formatAuthDiagnostic(record: AuthDiagnostic): string {
  return JSON.stringify(record);
}
