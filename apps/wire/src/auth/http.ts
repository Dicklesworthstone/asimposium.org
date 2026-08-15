/**
 * Request-level ingress for Agora's signed service envelope.
 *
 * This is deliberately an unmounted adapter, not a new public product route:
 * W1 owns endpoint contracts. A future Worker route supplies its exact route
 * template and action allowlist, then consumes the verified raw bytes here.
 *
 * Body bytes are read once with `Request.arrayBuffer()` and passed to signature
 * verification before any JSON parsing. JSON values that look equivalent after
 * parsing — whitespace, object key order, duplicate keys, escapes, and number
 * spellings — are different signed payloads unless their exact bytes match.
 */
import { type EnvelopeVerification, verifyServiceEnvelope } from "./envelope";
import type { VerificationKeyring } from "./keyring";
import type { NonceStore } from "./nonce";
import { routePrincipal } from "./principal";
import { envelopeRefusalProblem, wrongPrincipalProblem } from "./refusal";

/** Header shared with Agora's signer; never an Authorization or Cookie header. */
export const SERVICE_ENVELOPE_HEADER = "asimp-service-envelope";
const MAX_ENVELOPE_HEADER_BYTES = 8 * 1024;
const utf8 = new TextEncoder();
const decoder = new TextDecoder();

export interface ServiceEnvelopeIngressOptions {
  keyring: VerificationKeyring;
  nonces: NonceStore;
  now: number;
  issuer: string;
  audience: string;
  /** Route template selected by the mounted Worker handler, never request text. */
  route: string;
  /** Mandatory, non-empty allowlist selected by that handler. */
  permittedActions: readonly string[];
}

export type AuthenticatedServiceEnvelopeRequest = {
  ok: true;
  verification: Extract<EnvelopeVerification, { ok: true }>;
  /** Exact bytes authenticated by `payload_sha256`; never parse a second body. */
  rawBody: Uint8Array;
};

export type ServiceEnvelopeIngressResult =
  | AuthenticatedServiceEnvelopeRequest
  | { ok: false; response: Response };

function hasBearerAuthorization(headers: Headers): boolean {
  const authorization = headers.get("authorization");
  return authorization !== null && /^Bearer\s+\S/i.test(authorization);
}

function parseEnvelopeHeader(value: string): unknown | undefined {
  if (utf8.encode(value).length > MAX_ENVELOPE_HEADER_BYTES) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * Authenticate one Worker request before a business handler parses its JSON.
 *
 * Cookie is intentionally absent: neither this function nor `routePrincipal`
 * reads `Cookie`, tests pass a sentinel header implementation that throws if
 * it is queried. A stray Cookie therefore behaves exactly as no credential.
 */
export async function authenticateServiceEnvelopeRequest(
  request: Request,
  options: ServiceEnvelopeIngressOptions,
): Promise<ServiceEnvelopeIngressResult> {
  const envelopeHeader = request.headers.get(SERVICE_ENVELOPE_HEADER);
  const principal = routePrincipal({
    host: "agent",
    routeClass: "service-envelope-worker",
    presented: {
      bearer: hasBearerAuthorization(request.headers),
      envelope: envelopeHeader !== null,
    },
  });
  if (!principal.ok) return { ok: false, response: wrongPrincipalProblem() };

  // `PrincipalDecision` carries the runtime fact, but TypeScript cannot use it
  // to narrow a separately-read header value.
  if (envelopeHeader === null) return { ok: false, response: wrongPrincipalProblem() };

  const envelope = parseEnvelopeHeader(envelopeHeader);
  if (envelope === undefined) {
    return { ok: false, response: envelopeRefusalProblem("malformed") };
  }

  let rawBody: Uint8Array;
  try {
    rawBody = new Uint8Array(await request.arrayBuffer());
  } catch {
    // An envelope that cannot bind the received body cannot authorize a write.
    return { ok: false, response: envelopeRefusalProblem("malformed") };
  }

  const verification = await verifyServiceEnvelope(envelope, {
    keyring: options.keyring,
    nonces: options.nonces,
    now: options.now,
    issuer: options.issuer,
    audience: options.audience,
    body: rawBody,
    method: request.method,
    route: options.route,
    permittedActions: options.permittedActions,
  });
  if (!verification.ok) {
    return { ok: false, response: envelopeRefusalProblem(verification.reason) };
  }

  return { ok: true, verification, rawBody };
}

/**
 * Parse JSON only from previously verified bytes. This helper intentionally
 * does not assign an HTTP error code: endpoint contracts own malformed-body
 * responses, while this auth core owns byte binding and authorization only.
 */
export function parseAuthenticatedJsonBody(request: AuthenticatedServiceEnvelopeRequest): unknown {
  return JSON.parse(decoder.decode(request.rawBody));
}
