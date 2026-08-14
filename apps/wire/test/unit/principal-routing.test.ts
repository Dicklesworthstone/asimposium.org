import { describe, expect, test } from "bun:test";

import {
  type CredentialSource,
  consultedCredentials,
  type PlaneHost,
  type PresentedCredentials,
  type RouteClass,
  routePrincipal,
} from "../../src/auth/principal";

/**
 * S-6 principal routing (asimposiumorg-vw3, Fable §7.9 and §14.1).
 *
 * The two-plane seam has exactly one correct credential per route, and the
 * interesting cases are the confusions: a Fellow bearer reaching for sponsor
 * authority, and a browser session turning up on the agent host.
 */

const none: PresentedCredentials = { bearer: false, envelope: false };
const with_ = (partial: Partial<PresentedCredentials>): PresentedCredentials => ({
  ...none,
  ...partial,
});

describe("cookies are never consulted on the agent plane", () => {
  test.each<RouteClass>(["public", "agent-write", "sponsor-write", "service-envelope-worker"])(
    "the agent host lists only the route's real credential source for %s",
    (routeClass) => {
      const expected: CredentialSource[] =
        routeClass === "public"
          ? []
          : routeClass === "service-envelope-worker"
            ? ["envelope"]
            : ["bearer"];
      expect(consultedCredentials("agent", routeClass)).toEqual(expected);
    },
  );

  test("routing has no cookie field to inspect", () => {
    const classes: RouteClass[] = [
      "public",
      "agent-write",
      "sponsor-write",
      "service-envelope-worker",
    ];
    const presentations: PresentedCredentials[] = [
      none,
      with_({ bearer: true }),
      with_({ envelope: true }),
    ];
    for (const routeClass of classes) {
      for (const presented of presentations) {
        const decision = routePrincipal({ host: "agent", routeClass, presented });
        expect(
          decision.consulted.every((source) => source === "bearer" || source === "envelope"),
        ).toBe(true);
      }
    }
  });

  test("a bearer authenticates without any cookie-derived routing input", () => {
    const decision = routePrincipal({
      host: "agent",
      routeClass: "agent-write",
      presented: with_({ bearer: true }),
    });
    expect(decision).toMatchObject({ ok: true, authenticateWith: "bearer" });
  });

  test("cookie material cannot be supplied to the router at all", () => {
    // There is no field through which Cookie presence or bytes could arrive,
    // so agent-host Cookie requests are necessarily classified as no credential
    // by the HTTP adapter without a Cookie read.
    expect(Object.keys(none).sort()).toEqual(["bearer", "envelope"]);
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

  test("no credential on the agent plane is refused without a cookie classification", () => {
    const decision = routePrincipal({
      host: "agent",
      routeClass: "agent-write",
      presented: none,
    });
    expect(decision).toMatchObject({
      ok: false,
      code: "WRONG_PRINCIPAL",
      reason: "no_credential",
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

  test("the Worker service-envelope ingress accepts only an envelope on the agent host", () => {
    expect(
      routePrincipal({
        host: "agent",
        routeClass: "service-envelope-worker",
        presented: with_({ envelope: true }),
      }),
    ).toMatchObject({ ok: true, authenticateWith: "envelope" });
    expect(
      routePrincipal({
        host: "agent",
        routeClass: "service-envelope-worker",
        presented: with_({ bearer: true, envelope: true }),
      }),
    ).toMatchObject({ ok: false, reason: "bearer_on_service_envelope_route" });
    expect(
      routePrincipal({
        host: "apex",
        routeClass: "service-envelope-worker",
        presented: with_({ envelope: true }),
      }),
    ).toMatchObject({ ok: false, reason: "service_envelope_route_off_agent_host" });
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
        presented: with_({ envelope: true }),
      }),
    ).toMatchObject({ ok: true, authenticateWith: "envelope" });
  });

  test("public reads are free and consult nothing", () => {
    for (const host of ["apex", "agent"] as PlaneHost[]) {
      const decision = routePrincipal({
        host,
        routeClass: "public",
        presented: with_({ bearer: true }),
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
    // bearer token, cookie value, or signature.
    const presented: PresentedCredentials = with_({ bearer: true });
    for (const value of Object.values(presented)) {
      expect(typeof value).toBe("boolean");
    }
  });
});

describe("the full matrix is total", () => {
  test("every host × class × presentation combination decides without throwing", () => {
    const hosts: PlaneHost[] = ["apex", "agent"];
    const classes: RouteClass[] = [
      "public",
      "agent-write",
      "sponsor-write",
      "service-envelope-worker",
    ];
    let decided = 0;
    for (const host of hosts) {
      for (const routeClass of classes) {
        for (let bits = 0; bits < 4; bits += 1) {
          const presented: PresentedCredentials = {
            bearer: (bits & 1) !== 0,
            envelope: (bits & 2) !== 0,
          };
          const decision = routePrincipal({ host, routeClass, presented });
          expect(typeof decision.ok).toBe("boolean");
          decided += 1;
        }
      }
    }
    expect(decided).toBe(32);
  });
});
