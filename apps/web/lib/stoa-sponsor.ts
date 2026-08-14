/**
 * The one-way Agora → Stoa transport for an already-authenticated sponsor.
 *
 * This is deliberately not a Server Action and does not call `auth()`: the
 * caller must first resolve the host-only Agora session to a canonical,
 * opaque sponsor id through the Worker bootstrap path from Fable §5.1.  Until
 * that identity path exists, exporting a UI action here would either accept a
 * non-canonical identity (for example an email) or create a misleading live
 * write surface.
 *
 * It also deliberately owns no endpoint contract.  W1/W5 routes supply their
 * typed raw JSON, route template, and action name.  Keeping those concerns
 * out of this transport prevents an Agora convenience layer from becoming a
 * second writer or validator.
 */
import { mintServiceEnvelope, serviceEnvelopeHeaders } from "./service-envelope";
import { SITE } from "./site";

/** The only fetch shape this sealed transport needs: a fully resolved Stoa URL. */
export type StoaFetch = (input: string, init: RequestInit) => Promise<Response>;

/** Default bound on one dispatch, covering both signing and the network call. */
export const DEFAULT_STOA_TIMEOUT_MS = 10_000;
/**
 * Ceiling a caller may raise the bound to.  A server action that can wait
 * forever is a request-handle leak on the apex, so the bound is not optional
 * and not unbounded — a caller may tune it inside this range and no further.
 */
export const MAX_STOA_TIMEOUT_MS = 60_000;

/**
 * The one deliberate exception to the pinned production origin, for a local
 * staging or test Worker. It is not a boolean: the caller must name the exact
 * origin it is permitting, that origin must equal `stoaOrigin`, and it must be
 * plaintext loopback. A misconfigured production environment variable
 * therefore cannot silently redirect a signed envelope to another HTTPS host.
 */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface DispatchSignedSponsorRequestOptions {
  /**
   * Origin of the Worker plane. Omit in production: the canonical Stoa origin
   * is pinned in `SITE`. The only accepted override is the exact plaintext
   * loopback origin named by `insecureLoopbackOrigin` for local integration.
   */
  stoaOrigin?: string;
  /** Absolute Worker path. It must stay on `stoaOrigin`. */
  path: string;
  /** HTTP method bound by the envelope. */
  method: string;
  /** Worker route template bound by the envelope, never a filled path. */
  route: string;
  /** Worker action allowlisted by the receiving route. */
  action: string;
  /** Canonical opaque Worker sponsor id; never email, Google subject, or cookie. */
  sponsorId: string;
  /**
   * Exact JSON bytes sent to Stoa and signed by the envelope.
   *
   * A byte view is copied on entry, never retained.  A caller-owned `Buffer`,
   * a view into a pooled or reused `ArrayBuffer`, or any other aliased view
   * would otherwise let a later write change the transmitted bytes after the
   * envelope digest was computed over them.
   */
  rawBody: string | ArrayBufferView | ArrayBuffer;
  /** Agora-only Ed25519 signing key, supplied by a runtime config resolver. */
  privateKey: CryptoKey;
  /** Non-secret id for the corresponding Worker verification key. */
  kid: string;
  /** Epoch seconds, injected so the caller can make short envelope lifetimes testable. */
  now: number;
  /** Optional short lifetime override; production defaults live in the signer. */
  lifetimeSeconds?: number;
  /** Bound on the whole dispatch. Defaults to `DEFAULT_STOA_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Product-level retry key. The Worker retains it for 24 hours on writes. */
  idempotencyKey?: string;
  /** Caller cancellation, composed with the bound above; neither one leaks the other. */
  signal?: AbortSignal;
  /**
   * Explicit plaintext-loopback allowance for a staging or test Worker. It must
   * name the same origin as `stoaOrigin`; anything else fails closed.
   */
  insecureLoopbackOrigin?: string;
  /** Injectable solely for a transport-boundary test; production uses global fetch. */
  fetchImpl?: StoaFetch;
  /** Injectable solely for signing-deadline tests; production uses the canonical signer. */
  mintEnvelopeImpl?: typeof mintServiceEnvelope;
}

/**
 * Copy any caller-supplied byte view into bytes this transport alone owns.
 *
 * `Uint8Array.prototype.slice` would be enough for a plain typed array, but
 * `Buffer.prototype.slice` is Node's deprecated alias for `subarray` and
 * returns a *view*, so a `Buffer` caller would keep write access to the bytes
 * being signed and sent.  Copying through the explicit `(buffer, byteOffset,
 * byteLength)` window also keeps a pooled `Buffer` from dragging its whole
 * allocation pool along, which is what makes `view.buffer` unsafe to hand to
 * WebCrypto directly.
 */
function copyBodyBytes(body: ArrayBufferView | ArrayBuffer) {
  const view =
    body instanceof ArrayBuffer
      ? new Uint8Array(body)
      : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  // Allocate first and copy into it, rather than `new Uint8Array(view)`: the
  // destination must own a plain `ArrayBuffer`, because a view whose buffer is
  // merely `ArrayBufferLike` (a caller's `SharedArrayBuffer`, for instance) is
  // not a legal `BodyInit` and must never reach the request in the first place.
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return copy;
}

function resolveTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_STOA_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_STOA_TIMEOUT_MS) {
    throw new TypeError(`Stoa request timeout must be an integer from 1 to ${MAX_STOA_TIMEOUT_MS}`);
  }
  return timeoutMs;
}

/**
 * The destination must be the trusted HTTPS Stoa origin, or the exact
 * plaintext loopback origin the caller explicitly named.  Everything else —
 * plaintext remote hosts, `file:`, `data:`, an origin carrying credentials —
 * fails closed here, before a signature exists to be replayed elsewhere.
 */
function assertTrustedStoaOrigin(origin: URL, insecureLoopbackOrigin: string | undefined): void {
  if (origin.origin === SITE.stoa) return;
  if (insecureLoopbackOrigin === undefined) {
    throw new TypeError("Stoa origin must be the canonical Worker origin");
  }
  let declared: URL;
  try {
    declared = new URL(insecureLoopbackOrigin);
  } catch {
    throw new TypeError("Insecure Stoa origin allowance must be an absolute origin");
  }
  if (
    declared.pathname !== "/" ||
    declared.search !== "" ||
    declared.hash !== "" ||
    declared.username !== "" ||
    declared.password !== ""
  ) {
    throw new TypeError("Insecure Stoa origin allowance must contain only an origin");
  }
  if (declared.origin !== origin.origin) {
    throw new TypeError("Insecure Stoa origin allowance must name the configured origin exactly");
  }
  if (origin.protocol !== "http:" || !LOOPBACK_HOSTNAMES.has(origin.hostname)) {
    throw new TypeError("Insecure Stoa origin allowance is limited to plaintext loopback");
  }
}

function stoaRequestUrl(
  stoaOrigin: string | undefined,
  path: string,
  insecureLoopbackOrigin: string | undefined,
): string {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new TypeError("Stoa request path must be an absolute path on the configured origin");
  }

  const origin = new URL(stoaOrigin ?? SITE.stoa);
  if (
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    origin.username !== "" ||
    origin.password !== ""
  ) {
    throw new TypeError("Stoa origin must contain only an origin");
  }
  assertTrustedStoaOrigin(origin, insecureLoopbackOrigin);
  const destination = new URL(path, origin);
  if (
    destination.origin !== origin.origin ||
    destination.protocol !== origin.protocol ||
    destination.search !== "" ||
    destination.hash !== ""
  ) {
    throw new TypeError("Stoa request path must remain a query-free path on the configured origin");
  }
  return destination.toString();
}

function abortError(reason: unknown, message: string): unknown {
  if (reason !== undefined) return reason;
  return new DOMException(message, "TimeoutError");
}

/**
 * Sign and dispatch one sponsor request without ever forwarding apex
 * credentials.  `rawBody` is copied once and that copy is passed unchanged to
 * both the signer and fetch; parsing or re-serializing it here would
 * invalidate the Worker's byte binding, and aliasing it would let the sent
 * bytes drift from the signed ones.
 *
 * The dispatch is bounded.  One timer and one caller-signal listener are
 * created, and `finally` removes both on every path — success, refusal,
 * timeout, and caller cancellation alike — so neither a slow Worker nor a
 * long-lived caller signal accumulates handles on the apex.
 */
export async function dispatchSignedSponsorRequest(
  options: DispatchSignedSponsorRequestOptions,
): Promise<Response> {
  const destination = stoaRequestUrl(
    options.stoaOrigin,
    options.path,
    options.insecureLoopbackOrigin,
  );
  const method = options.method.toUpperCase();
  if (!/^[A-Z]+$/.test(method)) throw new TypeError("Stoa request method must be an HTTP token");

  const timeoutMs = resolveTimeoutMs(options.timeoutMs);
  if (
    options.idempotencyKey !== undefined &&
    !/^[A-Za-z0-9._-]{1,160}$/.test(options.idempotencyKey)
  ) {
    throw new TypeError("Idempotency-Key must be 1 to 160 safe opaque characters");
  }
  const rawBody =
    typeof options.rawBody === "string" ? options.rawBody : copyBodyBytes(options.rawBody);
  if ((method === "GET" || method === "HEAD") && rawBody.length !== 0) {
    throw new TypeError("GET and HEAD sponsor requests must have an empty raw body");
  }

  const callerSignal = options.signal;
  if (callerSignal?.aborted === true) {
    throw abortError(callerSignal.reason, "Stoa request cancelled");
  }
  const controller = new AbortController();
  const onCallerAbort = (): void => {
    controller.abort(abortError(callerSignal?.reason, "Stoa request cancelled"));
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let releaseAbortRace: (() => void) | undefined;

  try {
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    timer = setTimeout(() => {
      controller.abort(abortError(undefined, "Stoa request timed out"));
    }, timeoutMs);

    // Enforce the deadline ourselves from before body hashing/signing through
    // the network call. WebCrypto cannot be cancelled once entered, but the
    // abandoned promise remains observed by Promise.race and can never reach
    // fetch after the deadline wins.
    const deadline = new Promise<never>((_resolve, reject) => {
      const onAbort = (): void => reject(controller.signal.reason);
      if (controller.signal.aborted) onAbort();
      else {
        controller.signal.addEventListener("abort", onAbort, { once: true });
        releaseAbortRace = () => controller.signal.removeEventListener("abort", onAbort);
      }
    });
    // If a signer or transport throws synchronously after causing an abort,
    // the shared deadline may not reach Promise.race; keep it observed anyway.
    void deadline.catch(() => undefined);

    const envelope = await Promise.race([
      (options.mintEnvelopeImpl ?? mintServiceEnvelope)({
        privateKey: options.privateKey,
        kid: options.kid,
        now: options.now,
        lifetimeSeconds: options.lifetimeSeconds,
        method,
        route: options.route,
        action: options.action,
        principalId: options.sponsorId,
        body: rawBody,
      }),
      deadline,
    ]);
    if (controller.signal.aborted) throw controller.signal.reason;

    // The bound cannot be delegated to the transport.  Passing `signal` is
    // necessary so a real `fetch` tears its socket down, but a transport that
    // ignores the signal would otherwise make the deadline advisory, so the
    // deadline is also enforced here. Install the listener before calling the
    // transport: an injected implementation can synchronously trigger caller
    // cancellation before returning its promise. `Promise.race` attaches a
    // handler to both sides, so a later rejection from an abandoned dispatch
    // is observed rather than surfacing as an unhandled rejection.
    const dispatched = (options.fetchImpl ?? fetch)(destination, {
      method,
      headers: {
        ...serviceEnvelopeHeaders(envelope),
        ...(options.idempotencyKey === undefined
          ? {}
          : { "Idempotency-Key": options.idempotencyKey }),
      },
      body: method === "GET" || method === "HEAD" ? undefined : rawBody,
      // The service envelope is the sole cross-plane credential.  These options
      // make an accidental redirect or ambient credential forwarding fail closed.
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    // A transport is allowed to return an already-settled promise. Check the
    // state directly as well as racing the listener so its response cannot win
    // scheduling against cancellation triggered synchronously inside the call.
    if (controller.signal.aborted) {
      // A transport that ignored cancellation may reject later; this dispatch
      // is already terminal, but that late rejection still must be observed.
      void dispatched.catch(() => undefined);
      throw controller.signal.reason;
    }
    return await Promise.race([dispatched, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
    releaseAbortRace?.();
  }
}
