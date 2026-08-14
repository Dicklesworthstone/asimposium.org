import { describe, expect, test } from "bun:test";

import {
  consultedCredentials,
  routePrincipal,
  type CredentialSource,
  type PlaneHost,
  type PresentedCredentials,
  type RouteClass,
} from "../../src/auth/principal";

/**
 * S-6 principal routing (asimposiumorg-vw3, Fable §7.9 and §14.1).
 *
 * The two-plane seam has exactly one correct credential per route, and the
 * interesting cases are the confusions: a Fellow bearer reaching for sponsor
 * authority, and a browser session turning up on the agent host.
 */

const none: PresentedCredentials = { bearer: false, envelope: false, cookie: false };
const with_ = (partial: Partial<PresentedCredentials>): PresentedCredentials => ({
  ...none,
  ...partial,
});

describe("cookies are never consulted on the agent plane", () => {
  test.each<RouteClass>(["public", "agent-write", "sponsor-write"])(
    "the agent host never lists cookie as consulted for %s",
    (routeClass) => {
      expect(consultedCredentials("agent", routeClass)).not.toContain("cookie");
    },
  );

  test("no decision on the agent host reports having read a cookie", () => {
    const classes: RouteClass[] = ["public", "agent-write", "sponsor-write"];
    const presentations: PresentedCredentials[] = [
      none,
      with_({ cookie: true }),
      with_({ bearer: true }),
      with_({ bearer: true, cookie: true }),
      with_({ envelope: true, cookie: true }),
    ];
    for (const routeClass of classes) {
      for (const presented of presentations) {
        const decision = routePrincipal({ host: "agent", routeClass, presented });
        expect(decision.consulted).not.toContain("cookie" satisfies CredentialSource);
      }
    }
  });

  test("a bearer still authenticates when a cookie rides along unread", () => {
    const decision = routePrincipal({
      host: "agent",
      routeClass: "agent-write",
      presented: with_({ bearer: true, cookie: true }),
    });
    expect(decision).toMatchObject({ ok: true, authenticateWith: "bearer" });
  });
});

describe("WRONG_PRINCIPAL, both directions", () => {
  test("a bearer on a sponsor route is refused", () => {
    // A Fellow reaching for its sponsor's authority.
    const decision = routePrincipal({
      host: "apex",
      routeClass: "sponsor-write",
      presented: with_({ bearer: true, envelope: true }),
    });
    expect(decision).toMatchObject({
      ok: false,
      code: "WRONG_PRINCIPAL",
      reason: "bearer_on_sponsor_route",
    });
  });

  test("a cookie alone on the agent plane is refused", () => {
    // A browser session turning up where sessions do not exist.
    const decision = routePrincipal({
      host: "agent",
      routeClass: "agent-write",
      presented: with_({ cookie: true }),
    });
    expect(decision).toMatchObject({
      ok: false,
      code: "WRONG_PRINCIPAL",
      reason: "cookie_on_agent_plane",
    });
  });

  test("an envelope on an agent route is refused", () => {
    // An envelope authorises a human; the agent plane authenticates Fellows.
    const decision = routePrincipal({
      host: "agent",
      routeClass: "agent-write",
      presented: with_({ envelope: true }),
    });
    expect(decision).toMatchObject({
      ok: false,
      code: "WRONG_PRINCIPAL",
      reason: "envelope_on_agent_route",
    });
  });

  test("a sponsor route answering off the apex is refused", () => {
    const decision = routePrincipal({
      host: "agent",
      routeClass: "sponsor-write",
      presented: with_({ envelope: true }),
    });
    expect(decision).toMatchObject({ ok: false, reason: "sponsor_route_off_apex" });
  });

  test("an agent write route answering off the agent host is refused", () => {
    const decision = routePrincipal({
      host: "apex",
      routeClass: "agent-write",
      presented: with_({ bearer: true }),
    });
    expect(decision).toMatchObject({ ok: false, reason: "agent_route_off_agent_host" });
  });

  test("no credential at all is refused on either write class", () => {
    expect(
      routePrincipal({ host: "apex", routeClass: "sponsor-write", presented: none }),
    ).toMatchObject({ ok: false, reason: "no_credential" });
    expect(
      routePrincipal({ host: "agent", routeClass: "agent-write", presented: none }),
    ).toMatchObject({ ok: false, reason: "no_credential" });
  });
});

describe("the happy paths", () => {
  test("a sponsor write authenticates with the envelope", () => {
    expect(
      routePrincipal({
        host: "apex",
        routeClass: "sponsor-write",
        presented: with_({ envelope: true, cookie: true }),
      }),
    ).toMatchObject({ ok: true, authenticateWith: "envelope" });
  });

  test("public reads are free and consult nothing", () => {
    for (const host of ["apex", "agent"] as PlaneHost[]) {
      const decision = routePrincipal({
        host,
        routeClass: "public",
        presented: with_({ bearer: true, cookie: true }),
      });
      expect(decision).toMatchObject({ ok: true, authenticateWith: "none" });
      expect(decision.consulted).toEqual([]);
    }
  });
});

describe("the decision surface never carries credential material", () => {
  test("every refusal is a code plus an enumerated reason and nothing else", () => {
    const decision = routePrincipal({
      host: "apex",
      routeClass: "sponsor-write",
      presented: with_({ bearer: true }),
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(Object.keys(decision).sort()).toEqual(["code", "consulted", "ok", "reason"]);
    // Reasons are identifiers, never sentences assembled from input.
    expect(decision.reason).toMatch(/^[a-z_]+$/);
  });

  test("the presented type is booleans, so a token cannot be passed in at all", () => {
    // Structural: there is no field on PresentedCredentials that could hold a
    // bearer token, a cookie value, or a signature.
    const presented: PresentedCredentials = with_({ bearer: true });
    for (const value of Object.values(presented)) {
      expect(typeof value).toBe("boolean");
    }
  });
});

describe("the full matrix is total", () => {
  test("every host × class × presentation combination decides without throwing", () => {
    const hosts: PlaneHost[] = ["apex", "agent"];
    const classes: RouteClass[] = ["public", "agent-write", "sponsor-write"];
    let decided = 0;
    for (const host of hosts) {
      for (const routeClass of classes) {
        for (let bits = 0; bits < 8; bits += 1) {
          const presented: PresentedCredentials = {
            bearer: (bits & 1) !== 0,
            envelope: (bits & 2) !== 0,
            cookie: (bits & 4) !== 0,
          };
          const decision = routePrincipal({ host, routeClass, presented });
          expect(typeof decision.ok).toBe("boolean");
          decided += 1;
        }
      }
    }
    expect(decided).toBe(48);
  });

  test("no write route is ever satisfied by a cookie", () => {
    const hosts: PlaneHost[] = ["apex", "agent"];
    const classes: RouteClass[] = ["agent-write", "sponsor-write"];
    for (const host of hosts) {
      for (const routeClass of classes) {
        const decision = routePrincipal({
          host,
          routeClass,
          presented: with_({ cookie: true }),
        });
        expect(decision.ok).toBe(false);
      }
    }
  });
});
