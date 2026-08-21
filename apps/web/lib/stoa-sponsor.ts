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
import { isTrustedStoaOrigin, SponsorIdSchema } from "@asimposium/contracts";

import { mintServiceEnvelope, serviceEnvelopeHeaders } from "./service-envelope";

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
/** One console render may fetch at most two private workshop previews. */
export const MAX_SPONSOR_WORKSHOP_PREVIEW_REQUESTS = 2;
/** One absolute budget covers every preview dispatch and response read in that render. */
export const SPONSOR_WORKSHOP_PREVIEW_RENDER_TIMEOUT_MS = 12_000;

export interface BoundedWorkshopPreviewPlan<T> {
  readonly selected: readonly T[];
  readonly omittedCount: number;
}

/** Select the stable Fellow-prefix that one bounded console render may inspect. */
export function boundedWorkshopPreviewPlan<T>(
  candidates: readonly T[],
): BoundedWorkshopPreviewPlan<T> {
  const selected = candidates.slice(0, MAX_SPONSOR_WORKSHOP_PREVIEW_REQUESTS);
  return { selected, omittedCount: candidates.length - selected.length };
}

export interface LoadedWorkshopPreviewPrefix<T, R> {
  readonly loaded: readonly { readonly candidate: T; readonly value: R }[];
  readonly omittedCount: number;
}

/** Execute the bounded prefix under one deadline that every transport call receives. */
export async function loadBoundedWorkshopPreviewPrefix<T, R>(
  candidates: readonly T[],
  load: (candidate: T, deadlineAtMs: number) => Promise<R>,
  now: () => number = () => performance.now(),
): Promise<LoadedWorkshopPreviewPrefix<T, R>> {
  const plan = boundedWorkshopPreviewPlan(candidates);
  const deadlineAtMs = now() + SPONSOR_WORKSHOP_PREVIEW_RENDER_TIMEOUT_MS;
  const loaded: { candidate: T; value: R }[] = [];
  let omittedCount = plan.omittedCount;
  for (const [index, candidate] of plan.selected.entries()) {
    if (now() >= deadlineAtMs) {
      omittedCount += plan.selected.length - index;
      break;
    }
    loaded.push({ candidate, value: await load(candidate, deadlineAtMs) });
  }
  return { loaded, omittedCount };
}

/**
 * Refusal text for a preview whose rows are not newest-first. Fixed and
 * non-reflecting: it names the contract, never the offending sequence, index or
 * row, so a console error can never republish private workshop ordering.
 */
export const WORKSHOP_PREVIEW_ORDER_ERROR =
  "Stoa workshop rows must arrive newest-first with strictly descending workshop_seq";

/**
 * The console previews the newest five rows from Stoa's DESC workshop view.
 *
 * A bare `slice` would render the OLDEST five under a "newest" label if the
 * Worker's `ORDER BY workshop_seq DESC` ever regressed — a Rule A4 pretence one
 * cross-file edit away, invisible to any test that hands this function an
 * already-sorted fixture. So the ordering is checked here rather than assumed:
 * every row must carry a safe positive `workshop_seq`, and the sequence must be
 * strictly descending, before any row is taken.
 */
export function newestWorkshopPreviewIfValid<T extends { readonly workshop_seq: number }>(
  objects: readonly T[],
): readonly T[] | undefined {
  let previousSeq: number | undefined;
  for (const object of objects) {
    const seq = object.workshop_seq;
    if (!Number.isSafeInteger(seq) || seq < 1) {
      return undefined;
    }
    // Strict: an equal sequence is a duplicated row, not a tie to preserve.
    if (previousSeq !== undefined && seq >= previousSeq) {
      return undefined;
    }
    previousSeq = seq;
  }
  return objects.slice(0, 5);
}

/** Strict adapter for callers that treat a malformed private page as a contract failure. */
export function newestWorkshopPreview<T extends { readonly workshop_seq: number }>(
  objects: readonly T[],
): readonly T[] {
  const preview = newestWorkshopPreviewIfValid(objects);
  if (preview === undefined) throw new TypeError(WORKSHOP_PREVIEW_ORDER_ERROR);
  return preview;
}

/**
 * Signed dispatch stays within the exact environment-configured Stoa origin.
 * Plaintext is permitted only for an explicitly matching local loopback Worker.
 */
export interface DispatchSignedSponsorRequestOptions {
  /** Exact environment-configured Worker origin, validated by shared contracts. */
  stoaOrigin: string;
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
  /** Defaults to sponsor; operator routes must make their distinct authority explicit. */
  principalType?: "sponsor" | "operator";
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
 * The destination must be one of the shared contract's trusted origins. Exact
 * plaintext loopback additionally needs an explicit matching allowance.
 * Everything else fails closed here, before a signature exists to be replayed.
 */
function assertTrustedStoaOrigin(
  stoaOrigin: string,
  insecureLoopbackOrigin: string | undefined,
): URL {
  if (!isTrustedStoaOrigin(stoaOrigin)) {
    throw new TypeError("Stoa origin is not a trusted configured origin");
  }
  const origin = new URL(stoaOrigin);
  if (origin.protocol === "https:") {
    if (insecureLoopbackOrigin !== undefined) {
      throw new TypeError("Insecure Stoa origin allowance is limited to plaintext loopback");
    }
    return origin;
  }
  if (insecureLoopbackOrigin !== stoaOrigin) {
    throw new TypeError("Insecure Stoa origin allowance must name the configured origin exactly");
  }
  return origin;
}

function stoaRequestUrl(
  stoaOrigin: string,
  path: string,
  insecureLoopbackOrigin: string | undefined,
): string {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new TypeError("Stoa request path must be an absolute path on the configured origin");
  }

  const origin = assertTrustedStoaOrigin(stoaOrigin, insecureLoopbackOrigin);
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

async function cancelLateStoaResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The request is already terminal. Cancellation is best-effort cleanup;
    // a locked or transport-owned body must not replace the timeout refusal.
  }
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
  // The principal is the one field whose contract this transport asserts but
  // used to leave to the receiver. Enforcing it HERE, before the envelope is
  // minted, is what keeps a caller mistake from becoming a signed artifact: a
  // Google subject or an email handed in by an upstream bug would otherwise be
  // signed and transmitted in a request header before Stoa refused it, and
  // Fable §14.3 treats a header exactly as it treats a log line.
  //
  // The refusal deliberately does not echo the value. Reflecting a rejected
  // principal would move the same bytes into an exception message, a stack, and
  // whatever collects them — which is the leak this check exists to prevent.
  if (!SponsorIdSchema.safeParse(options.sponsorId).success) {
    throw new TypeError("Stoa sponsor id must be a canonical opaque Worker principal");
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
        ...(options.principalType === undefined ? {} : { principalType: options.principalType }),
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
    // Promise.race observes late rejection, but it cannot dispose of a late
    // fulfillment. An injectable transport may ignore AbortSignal and resolve
    // after the deadline; cancel that abandoned body without touching a
    // response which won while the request was still live.
    void dispatched.then(
      (lateResponse) => {
        if (controller.signal.aborted) void cancelLateStoaResponse(lateResponse);
      },
      () => undefined,
    );
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
