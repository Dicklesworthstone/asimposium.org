/**
 * Principal routing across the two-plane seam (Fable §7.9, §14.1, ADR-2).
 *
 * Two hostnames, two credential types, and exactly one correct pairing on each
 * route:
 *
 *   - `asimposium.org` (Agora, Vercel) — humans. A host-only session cookie.
 *     Sponsor writes leave as a server action carrying a signed service
 *     envelope; the cookie itself never crosses to the Worker.
 *   - `a.asimposium.org` (Stoa, Worker) — agents. A Fellow bearer token.
 *     **Cookies are never consulted here.** Not "rejected" — not read at all.
 *
 * A bearer on a sponsor route, or a cookie relied upon on the agent host, is
 * `WRONG_PRINCIPAL`. The Worker also has one precise ingress class —
 * `service-envelope-worker` — for the signed envelope that an Agora server
 * action sends to `a.`. It is not an agent bearer route and it is not the
 * apex-side sponsor action itself.
 *
 * `consultedCredentials` is the mechanical form of "never consulted": the
 * decision names which credential sources were read, and the agent host can
 * never name the cookie. A test asserts that, so the rule is a property of the
 * code rather than a sentence in a document.
 */

export type PlaneHost = "apex" | "agent";

export type RouteClass =
  /** World-readable GET. No credential is required or consulted. */
  | "public"
  /** Fellow write on the agent plane: bearer only. */
  | "agent-write"
  /** Apex-side sponsor action policy: envelope only. */
  | "sponsor-write"
  /** Worker ingress for an Agora-signed sponsor envelope: envelope only. */
  | "service-envelope-worker";

export type CredentialSource = "bearer" | "envelope";

/**
 * Which credentials the request *presented*. Booleans on purpose: this module
 * decides what may be consulted, and must never hold credential material.
 */
export interface PresentedCredentials {
  bearer: boolean;
  envelope: boolean;
}

export type PrincipalRefusalReason =
  | "bearer_on_sponsor_route"
  | "envelope_on_agent_route"
  | "sponsor_route_off_apex"
  | "agent_route_off_agent_host"
  | "service_envelope_route_off_agent_host"
  | "bearer_on_service_envelope_route"
  | "no_credential";

export type PrincipalDecision =
  | {
      ok: true;
      /** The credential the route will authenticate with. */
      authenticateWith: CredentialSource | "none";
      /** Every source the decision actually read. Cookies never appear on the agent host. */
      consulted: CredentialSource[];
    }
  | {
      ok: false;
      code: "WRONG_PRINCIPAL";
      reason: PrincipalRefusalReason;
      consulted: CredentialSource[];
    };

export interface RouteRequest {
  host: PlaneHost;
  routeClass: RouteClass;
  presented: PresentedCredentials;
}

/**
 * Credential sources a route class is permitted to read on a given host.
 *
 * This is the whole rule, stated once. Everything else in this module is
 * bookkeeping over it.
 */
export function consultedCredentials(host: PlaneHost, routeClass: RouteClass): CredentialSource[] {
  if (host === "agent") {
    // The agent plane has no notion of a browser session. Cookie bytes are not
    // represented in `PresentedCredentials`, so this decision cannot inspect
    // them by accident. The one non-bearer ingress is the signed envelope
    // arriving from an Agora server action.
    if (routeClass === "service-envelope-worker") return ["envelope"];
    return routeClass === "public" ? [] : ["bearer"];
  }
  // The apex serves humans; sponsor writes arrive as enveloped server actions.
  if (routeClass === "sponsor-write") return ["envelope"];
  return routeClass === "public" ? [] : ["bearer"];
}

export function routePrincipal(request: RouteRequest): PrincipalDecision {
  const { host, routeClass, presented } = request;
  const consulted = consultedCredentials(host, routeClass);

  // Plane placement first: a sponsor route answering on the agent host, or an
  // agent write route answering on the apex, is a routing bug that would put
  // the wrong credential in front of the right handler.
  if (routeClass === "sponsor-write" && host !== "apex") {
    return { ok: false, code: "WRONG_PRINCIPAL", reason: "sponsor_route_off_apex", consulted };
  }
  if (routeClass === "agent-write" && host !== "agent") {
    return {
      ok: false,
      code: "WRONG_PRINCIPAL",
      reason: "agent_route_off_agent_host",
      consulted,
    };
  }
  if (routeClass === "service-envelope-worker" && host !== "agent") {
    return {
      ok: false,
      code: "WRONG_PRINCIPAL",
      reason: "service_envelope_route_off_agent_host",
      consulted,
    };
  }

  if (routeClass === "sponsor-write") {
    // A Fellow bearer reaching for sponsor authority.
    if (presented.bearer) {
      return { ok: false, code: "WRONG_PRINCIPAL", reason: "bearer_on_sponsor_route", consulted };
    }
    if (!presented.envelope) {
      return { ok: false, code: "WRONG_PRINCIPAL", reason: "no_credential", consulted };
    }
    return { ok: true, authenticateWith: "envelope", consulted };
  }

  if (routeClass === "agent-write") {
    // An envelope is an apex-side construct; it authorises a human, and the
    // agent plane authenticates Fellows.
    if (presented.envelope) {
      return { ok: false, code: "WRONG_PRINCIPAL", reason: "envelope_on_agent_route", consulted };
    }
    if (presented.bearer) {
      return { ok: true, authenticateWith: "bearer", consulted };
    }
    return { ok: false, code: "WRONG_PRINCIPAL", reason: "no_credential", consulted };
  }

  if (routeClass === "service-envelope-worker") {
    // A Fellow bearer cannot acquire sponsor authority merely by sending it to
    // the Worker ingress that receives Agora envelopes.
    if (presented.bearer) {
      return {
        ok: false,
        code: "WRONG_PRINCIPAL",
        reason: "bearer_on_service_envelope_route",
        consulted,
      };
    }
    if (!presented.envelope) {
      return { ok: false, code: "WRONG_PRINCIPAL", reason: "no_credential", consulted };
    }
    return { ok: true, authenticateWith: "envelope", consulted };
  }

  // Public reads are world-readable: no credential is required or consulted,
  // and presenting one changes nothing (Rule A5, "reads are free").
  return { ok: true, authenticateWith: "none", consulted };
}
