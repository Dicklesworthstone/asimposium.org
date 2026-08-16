/**
 * Request-level ingress for Agora's signed service envelope.
 *
 * This is deliberately an unmounted adapter, not a new public product route:
 * W1 owns endpoint contracts. A future Worker route supplies its exact route
 * template and action allowlist, then consumes the verified raw bytes here.
 *
 * Body bytes are read once through a byte-bounded stream and passed to signature
 * verification before any JSON parsing. JSON values that look equivalent after
 * parsing — whitespace, object key order, duplicate keys, escapes, and number
 * spellings — are different signed payloads unless their exact bytes match.
 */
import { type EnvelopeVerification, verifyServiceEnvelope } from "./envelope";
import type { VerificationKeyring } from "./keyring";
import type { NonceStore } from "./nonce";
import { routePrincipal } from "./principal";
import {
  envelopeRefusalProblem,
  requestBodyTooLargeProblem,
  wrongPrincipalProblem,
} from "./refusal";

/** Header shared with Agora's signer; never an Authorization or Cookie header. */
export const SERVICE_ENVELOPE_HEADER = "asimp-service-envelope";
const MAX_ENVELOPE_HEADER_BYTES = 8 * 1024;
export const MAX_SERVICE_ENVELOPE_BODY_BYTES = 64 * 1024;
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

type BoundedBodyRead =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: "malformed" | "too-large" };

interface BoundedBodyReader {
  read(view?: Uint8Array): Promise<{ readonly done: boolean; readonly value?: Uint8Array }>;
  cancel(): Promise<unknown>;
  releaseLock(): void;
}

function cancelUnconsumedRequestBody(request: Request): void {
  try {
    const body = request.body;
    if (body !== null && !body.locked) void body.cancel().catch(() => undefined);
  } catch {
    // Refusal is already determined; cancellation must not delay or replace it.
  }
}

async function readBoundedRequestBody(request: Request): Promise<BoundedBodyRead> {
  const contentEncoding = request.headers.get("content-encoding");
  if (contentEncoding !== null && contentEncoding.trim().toLowerCase() !== "identity") {
    // Sponsor JSON routes do not accept compressed request bodies. Refusing the
    // encoding avoids making a compressed-size header stand in for the actual
    // bytes that the route would parse.
    cancelUnconsumedRequestBody(request);
    return { ok: false, reason: "malformed" };
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(contentLength)) {
      cancelUnconsumedRequestBody(request);
      return { ok: false, reason: "malformed" };
    }
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength)) {
      cancelUnconsumedRequestBody(request);
      return { ok: false, reason: "malformed" };
    }
    if (declaredLength > MAX_SERVICE_ENVELOPE_BODY_BYTES) {
      cancelUnconsumedRequestBody(request);
      return { ok: false, reason: "too-large" };
    }
  }

  let body: ReadableStream<Uint8Array> | null;
  try {
    body = request.body;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (body === null) return { ok: true, bytes: new Uint8Array() };

  // Own one fixed allocation. A BYOB-capable Fetch implementation additionally
  // prevents an upstream producer from choosing an attacker-sized JavaScript
  // chunk. Bun's Request stream is not currently BYOB, so the fallback copies
  // only accepted bytes and never retains or duplicates an oversized chunk.
  const bytes = new Uint8Array(MAX_SERVICE_ENVELOPE_BODY_BYTES + 1);
  let total = 0;
  let reader: BoundedBodyReader;
  let byob = true;
  try {
    reader = body.getReader({ mode: "byob" }) as unknown as BoundedBodyReader;
  } catch {
    byob = false;
    try {
      reader = body.getReader() as unknown as BoundedBodyReader;
    } catch {
      return { ok: false, reason: "malformed" };
    }
  }
  const cancel = () => {
    try {
      void reader.cancel().catch(() => undefined);
    } catch {
      // The refusal is already determined; cancellation is best effort.
    }
  };
  try {
    for (;;) {
      const next = await reader.read(
        byob ? new Uint8Array(Math.min(16 * 1024, bytes.byteLength - total)) : undefined,
      );
      if (next.done) break;
      const chunk = next.value;
      if (chunk === undefined) throw new Error("request body reader omitted a chunk");
      total += chunk.byteLength;
      if (total > MAX_SERVICE_ENVELOPE_BODY_BYTES) {
        cancel();
        return { ok: false, reason: "too-large" };
      }
      bytes.set(chunk, total - chunk.byteLength);
    }
  } catch {
    cancel();
    return { ok: false, reason: "malformed" };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A hostile or already-invalid stream must not replace the typed result.
    }
  }
  return { ok: true, bytes: bytes.subarray(0, total) };
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
  if (!principal.ok) {
    cancelUnconsumedRequestBody(request);
    return { ok: false, response: wrongPrincipalProblem() };
  }

  // `PrincipalDecision` carries the runtime fact, but TypeScript cannot use it
  // to narrow a separately-read header value.
  if (envelopeHeader === null) {
    cancelUnconsumedRequestBody(request);
    return { ok: false, response: wrongPrincipalProblem() };
  }

  const envelope = parseEnvelopeHeader(envelopeHeader);
  if (envelope === undefined) {
    cancelUnconsumedRequestBody(request);
    return { ok: false, response: envelopeRefusalProblem("malformed") };
  }

  const body = await readBoundedRequestBody(request);
  if (!body.ok) {
    return {
      ok: false,
      response:
        body.reason === "too-large"
          ? requestBodyTooLargeProblem()
          : envelopeRefusalProblem("malformed"),
    };
  }
  const rawBody = body.bytes;

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
