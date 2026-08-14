/**
 * S-6 local ingress harness (bead asimposiumorg-vw3).
 *
 * Wrangler runs this entrypoint with a real local D1 binding so the service
 * envelope's replay window is decided by SQLite's unique index inside workerd,
 * not by an in-process Map and not by a `bun:sqlite` shim standing in for D1.
 *
 * It is deliberately **not** imported by `src/index.ts`. W1 owns endpoint
 * contracts; a spike that quietly minted `/v1/...` would pre-empt them. The two
 * routes below are named `__s6` precisely so nothing here can be mistaken for a
 * product surface, and the ingress route performs **no business effect**: it
 * authenticates, records one nonce, and answers. Nothing else is written.
 *
 * ## What this proves, and what it cannot
 *
 * Proves, against real local workerd + real local D1: that two byte-identical
 * concurrently signed requests yield exactly one accepted effect and one replay
 * refusal across *separate* `D1NonceStore` instances; that `Cookie` is never
 * read on the agent host; that a reordered body is refused without consuming
 * the valid nonce.
 *
 * Cannot prove: a deployed Worker, a deployed D1, multi-colo isolate
 * distribution, a real Vercel Auth.js Google cookie, or true cross-plane
 * behaviour. `scripts/e2e-s6-cross-plane-auth.sh` owns that and stays blocked.
 */

import type { D1Database, ExecutionContext } from "@cloudflare/workers-types";

import { buildAuthDiagnostic, formatAuthDiagnostic, principalPseudonym } from "./diagnostics";
import { authenticateServiceEnvelopeRequest, SERVICE_ENVELOPE_HEADER } from "./http";
import { VerificationKeyring } from "./keyring";
import { D1NonceStore } from "./nonce";
import { routePrincipal } from "./principal";
import { wrongPrincipalProblem } from "./refusal";

/**
 * Harness route template. Never a `/v1/...` name: W1 owns product contracts.
 *
 * Deliberately NOT exported: workerd treats every named export of an entrypoint
 * module as a candidate service binding and rejects a string or array with
 * "not of type function or ExportedHandler". The default export is the only
 * thing this module may publish.
 */
const S6_INGRESS_ROUTE = "/__s6/ingress";

/**
 * A second mount of the same verifier, and the extra method it answers.
 *
 * Both exist so a *route* or *method* tamper is refused by envelope
 * verification rather than by the router. With a single POST-only mount, an
 * envelope replayed at another path or with another verb gets a 404/`404`-shaped
 * harness face — which proves the router works and says nothing about whether
 * the verifier binds the envelope to the request it is actually serving. These
 * mounts let the checker present one envelope against a request it was not
 * signed for and observe a real `UNAUTHORIZED`.
 */
const S6_INGRESS_ALIAS_ROUTE = "/__s6/ingress-alias";
const S6_INGRESS_METHODS: ReadonlySet<string> = new Set(["POST", "PUT"]);
const S6_PERMITTED_ACTIONS: readonly string[] = ["s6.probe"];

interface LocalAuthEnv {
  readonly DB: D1Database;
  /** Non-secret Ed25519 public key hex for the harness signer. */
  readonly S6_PUBLIC_KEY_HEX?: string;
  readonly S6_KID?: string;
  /** Epoch seconds; injected so expiry cases are real, not clock-dependent. */
  readonly S6_NOW?: string;
  /** Non-secret salt for principal pseudonymisation in diagnostics. */
  readonly S6_PSEUDONYM_SALT?: string;
  /** Per-run, non-secret ownership marker so a runner can tell our Worker from
   * a stranger already listening on the same port. Never a credential. */
  readonly S6_RUN_ID?: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * A `Headers` view that refuses to answer for `Cookie`.
 *
 * The agent plane has no notion of a browser session, so a read is a defect
 * rather than a policy decision. A JS proxy cannot cross an HTTP boundary, so
 * the trap has to live here, inside the Worker, wrapping the real request
 * before the auth adapter ever sees it. If the adapter (or anything it calls)
 * asks for `Cookie`, this throws and the run fails loudly instead of quietly
 * passing a test that never exercised the path.
 */
export function cookieTrappedRequest(request: Request, onCookieRead: () => void): Request {
  const isCookie = (name: string): boolean => /^cookie$/i.test(name);
  const trip = (): never => {
    onCookieRead();
    throw new Error("S6_COOKIE_READ_ON_AGENT_HOST");
  };

  /**
   * `get`/`has` are the obvious ways to read a header and the only ones the
   * first version of this trap covered. They are not the only ways.
   *
   * `Headers` is iterable, so `for (const [name, value] of request.headers)`,
   * `entries()`, `values()` and `forEach()` all hand over the cookie without
   * ever calling `get`, and `keys()` discloses that a session cookie is
   * present. A canary that watches only `get` reports zero reads while the
   * adapter reads freely — worse than no canary, because the zero is trusted.
   *
   * Each iterator therefore trips *before* yielding the cookie entry, so no
   * consumer can obtain the name or the value without being observed. Headers
   * that are not `Cookie` iterate normally.
   */
  function* guardedEntries(): IterableIterator<[string, string]> {
    // Iterate the real Headers, not the proxy, or `entries()` would recurse.
    for (const [name, value] of request.headers as unknown as Iterable<[string, string]>) {
      if (isCookie(name)) trip();
      yield [name, value];
    }
  }

  const headers = new Proxy(request.headers, {
    get(target, property, receiver) {
      if (property === "get" || property === "has") {
        return (name: string) => {
          if (isCookie(name)) trip();
          return property === "get" ? target.get(name) : target.has(name);
        };
      }
      if (property === "entries" || property === Symbol.iterator) {
        return () => guardedEntries();
      }
      if (property === "keys") {
        return function* (): IterableIterator<string> {
          for (const [name] of guardedEntries()) yield name;
        };
      }
      if (property === "values") {
        // Values alone would hide which header a value belongs to, so this
        // walks entries and screens by name before releasing the value.
        return function* (): IterableIterator<string> {
          for (const [, value] of guardedEntries()) yield value;
        };
      }
      if (property === "forEach") {
        return (
          callback: (value: string, name: string, parent: Headers) => void,
          thisArg?: unknown,
        ) => {
          for (const [name, value] of guardedEntries()) {
            // The third argument is the GUARDED proxy, never the real target.
            // Handing over `target` gave every callback an unguarded handle:
            // `(v, n, parent) => parent.get("cookie")` read the session value
            // on the first non-cookie entry, before iteration ever reached the
            // cookie the trap was watching for.
            callback.call(thisArg, value, name, headers as Headers);
          }
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(request, {
    get(target, property) {
      if (property === "headers") return headers;
      /**
       * `clone()` is the one method that hands back another `Request`, and
       * binding it to the real target returned an *unguarded* one: an adapter
       * could call `guarded.clone().headers.get("cookie")` and read the session
       * value while the canary counted zero reads. A trap that any downstream
       * caller can step around by cloning is not a trap.
       *
       * The clone is therefore re-wrapped with the same observer. Body reads
       * are unaffected — cloning exists so the body can be consumed twice, and
       * the underlying clone still owns its own stream.
       */
      if (property === "clone") {
        // `clone()` is typed against the ambient fetch types, which differ from
        // the global `Request` this module is written against; the two-step
        // cast is this repository's established form for that mismatch.
        return (): Request =>
          cookieTrappedRequest(target.clone() as unknown as Request, onCookieRead);
      }
      // Request accessors must run against the real instance, not the proxy.
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Request;
}

function keyringFrom(env: LocalAuthEnv): VerificationKeyring {
  return new VerificationKeyring([
    {
      kid: env.S6_KID ?? "s6-local",
      publicKeyHex: env.S6_PUBLIC_KEY_HEX ?? "",
      notBefore: 0,
    },
  ]);
}

/**
 * Authenticate one envelope. A fresh `D1NonceStore` is constructed per request
 * on purpose: the replay winner must be decided by the durable D1 row, not by
 * state that happens to live in one adapter instance. (Contrast
 * `enrollment/local-d1-worker.ts`, where per-request construction is a defect
 * because it re-randomises a key. Same shape, opposite meaning.)
 */
async function ingress(request: Request, env: LocalAuthEnv): Promise<Response> {
  const startedAt = Date.now();
  let cookieReads = 0;
  const guarded = cookieTrappedRequest(request, () => {
    cookieReads += 1;
  });

  const now = Number.parseInt(env.S6_NOW ?? "", 10);
  if (!Number.isSafeInteger(now) || now <= 0) {
    return json({ code: "S6_HARNESS_CLOCK_MISSING" }, 500);
  }

  const result = await authenticateServiceEnvelopeRequest(guarded, {
    keyring: keyringFrom(env),
    nonces: new D1NonceStore(env.DB),
    now,
    issuer: "agora",
    audience: "stoa",
    // The route actually being served, not a constant. Binding to a constant
    // would let an envelope signed for one mount authenticate at another, which
    // is precisely the confusion the route claim exists to prevent.
    route: new URL(request.url).pathname,
    permittedActions: S6_PERMITTED_ACTIONS,
  });

  if (!result.ok) {
    // The adapter returns a refusal `Response`, not its enumerated reason, so a
    // caller cannot honestly label one. Inventing a reason here would put a
    // guess into telemetry, which is exactly what `buildAuthDiagnostic`'s
    // claim-state discipline exists to prevent. The harness therefore reports
    // only what it actually knows: that the cookie path stayed untouched.
    const response = new Response(result.response.body, result.response);
    response.headers.set("x-s6-cookie-reads", String(cookieReads));
    return response;
  }

  const pseudonym = await principalPseudonym(
    result.verification.principal.id,
    env.S6_PSEUDONYM_SALT ?? "s6-local-salt",
  );
  const diagnostic = buildAuthDiagnostic({
    outcome: "accepted",
    code: "OK",
    reason: "accepted",
    method: request.method,
    route: new URL(request.url).pathname,
    durationMs: Date.now() - startedAt,
    claims: result.verification.claims,
    claimsState: "authenticated_claim",
    principalPseudonym: pseudonym,
  });

  const response = json({
    ok: true,
    action: result.verification.principal.action,
    principal_pseudonym: pseudonym,
    body_bytes: result.rawBody.byteLength,
  });
  response.headers.set("x-s6-cookie-reads", String(cookieReads));
  response.headers.set("x-s6-diagnostic", formatAuthDiagnostic(diagnostic));
  return response;
}

/**
 * Principal-routing probes. These need no envelope: they assert that a bearer
 * reaching for sponsor authority and a cookie relied upon on the agent host are
 * both `WRONG_PRINCIPAL`, decided by `routePrincipal` rather than by this file.
 */
function principalProbe(url: URL): Response {
  const host = url.searchParams.get("host") ?? "agent";
  const routeClass = url.searchParams.get("route_class") ?? "sponsor-write";
  const presented = {
    bearer: url.searchParams.get("bearer") === "1",
    envelope: url.searchParams.get("envelope") === "1",
  };
  if (host !== "apex" && host !== "agent") return json({ code: "S6_BAD_HOST" }, 400);
  if (
    routeClass !== "sponsor-write" &&
    routeClass !== "agent-write" &&
    routeClass !== "service-envelope-worker" &&
    routeClass !== "public"
  ) {
    return json({ code: "S6_BAD_ROUTE_CLASS" }, 400);
  }

  const decision = routePrincipal({ host, routeClass, presented });
  if (!decision.ok) {
    const response = new Response(wrongPrincipalProblem().body, wrongPrincipalProblem());
    response.headers.set("x-s6-principal-reason", decision.reason);
    response.headers.set("x-s6-consulted", decision.consulted.join(","));
    return response;
  }
  // The accepted path reports `consulted` as a header as well as in the body,
  // exactly as the refusal path above does. Emitting it only on refusal makes
  // the *positive* case the one that cannot be cross-checked -- and "the
  // envelope was consulted and the cookie was not" is a claim that matters most
  // precisely when the request succeeded.
  const accepted = json({
    ok: true,
    authenticate_with: decision.authenticateWith,
    consulted: decision.consulted,
  });
  accepted.headers.set("x-s6-consulted", decision.consulted.join(","));
  return accepted;
}

export default {
  async fetch(request: Request, env: LocalAuthEnv, _ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/__s6/health") {
        return json({
          status: "ok",
          run_id: env.S6_RUN_ID ?? "",
          bindings: ["DB"],
          route: S6_INGRESS_ROUTE,
          envelope_header: SERVICE_ENVELOPE_HEADER,
        });
      }
      if (request.method === "GET" && url.pathname === "/__s6/principal") {
        // Routed through the cookie trap so a probe that *presents* a Cookie
        // proves it was never consulted, rather than proving only that the
        // decision function ignores a query parameter.
        let principalCookieReads = 0;
        const guardedProbe = cookieTrappedRequest(request, () => {
          principalCookieReads += 1;
        });
        const response = principalProbe(new URL(guardedProbe.url));
        response.headers.set("x-s6-cookie-reads", String(principalCookieReads));
        return response;
      }
      /**
       * Harness-only status forcer.
       *
       * The checker's refusal assertions must fail on a server error rather
       * than count it as a refusal, and proving that needs a response the
       * harness can produce on demand. It mints no effect and touches no
       * binding; it exists so the suite can demonstrate it rejects a 500.
       */
      if (request.method === "GET" && url.pathname === "/__s6/force-status") {
        const requested = Number.parseInt(url.searchParams.get("code") ?? "", 10);
        const status = requested >= 400 && requested <= 599 ? requested : 500;
        return json({ code: "S6_FORCED_STATUS", forced: status }, status);
      }
      if (
        S6_INGRESS_METHODS.has(request.method) &&
        (url.pathname === S6_INGRESS_ROUTE || url.pathname === S6_INGRESS_ALIAS_ROUTE)
      ) {
        return await ingress(request, env);
      }
      return json({ code: "S6_HARNESS_ROUTE_NOT_FOUND" }, 404);
    } catch (error) {
      // A cookie read must be unmistakable rather than folded into a generic 500.
      const code =
        error instanceof Error && error.message === "S6_COOKIE_READ_ON_AGENT_HOST"
          ? "S6_COOKIE_READ_ON_AGENT_HOST"
          : "S6_HARNESS_BINDING_FAILURE";
      return json({ code }, 500);
    }
  },
};
