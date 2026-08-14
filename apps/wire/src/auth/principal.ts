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
 * `WRONG_PRINCIPAL`. Both directions matter, and they fail differently in
 * practice: the first is a Fellow reaching for its sponsor's authority, the
 * second is a browser session leaking onto the agent plane, which is what
 * host-only cookie scoping exists to prevent in the first place.
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
  /** Sponsor write, arriving from an Agora server action: envelope only. */
  | "sponsor-write";

export type CredentialSource = "bearer" | "envelope" | "cookie";

/**
 * Which credentials the request *presented*. Booleans on purpose: this module
 * decides what may be consulted, and must never hold credential material.
 */
export interface PresentedCredentials {
  bearer: boolean;
  envelope: boolean;
  cookie: boolean;
}

export type PrincipalRefusalReason =
  | "bearer_on_sponsor_route"
  | "cookie_on_agent_plane"
  | "envelope_on_agent_route"
  | "sponsor_route_off_apex"
  | "agent_route_off_agent_host"
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
    // The agent plane has no notion of a browser session. Cookies are not on
    // this list, and that absence is the point.
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
      // A cookie may ride along on the request; it is simply not read.
      return { ok: true, authenticateWith: "bearer", consulted };
    }
    // Only a cookie was offered, on a host that does not consult cookies.
    if (presented.cookie) {
      return { ok: false, code: "WRONG_PRINCIPAL", reason: "cookie_on_agent_plane", consulted };
    }
    return { ok: false, code: "WRONG_PRINCIPAL", reason: "no_credential", consulted };
  }

  // Public reads are world-readable: no credential is required or consulted,
  // and presenting one changes nothing (Rule A5, "reads are free").
  return { ok: true, authenticateWith: "none", consulted };
}
