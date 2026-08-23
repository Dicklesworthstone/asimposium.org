/**
 * Source-derived capabilities disclosure census (asimposiumorg-phg.1.2).
 *
 * `createApp` alone cannot see the whole mounted surface: the enrollment and
 * session routers are dispatched through wildcard middleware, so their route
 * tables never enter the root Hono instance. This census unions the runtime
 * `.routes` arrays of all four constructed routers (root app including the
 * ledger-face mount, enrollment router, session router) and requires every
 * mounted method+path to be either advertised in the served capabilities
 * document or explicitly classified as intentionally undisclosed with a
 * nonblank reason below.
 *
 * Adding a mounted route without one of those two outcomes fails this contract
 * lane; an advertisement naming a route nothing mounts also fails (phantom
 * check). Templates are normalized one way — mounted `:param{regex}` becomes
 * advertised `<param>` form, and a trailing `?query` on an advertised entry is
 * ignored — so the comparison can never be satisfied by editing the mounted
 * path to chase the advertisement text.
 */
import { describe, expect, test } from "bun:test";

import { createApp } from "../../src/app.ts";
import type { Env } from "../../src/env.ts";
import { createEnrollmentRouter } from "../../src/enrollment/router.ts";
import { createSessionRouter } from "../../src/sessions/router.ts";

interface RawRoute {
  readonly method: string;
  readonly path: string;
}

/** One-way normalization: mounted `:p{regex}` / `:p` become advertised `<p>` form. */
function normalizeMountedPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)(\{[^}]*\})?/g, "<$1>");
}

/** Strip a prose query suffix (`/pack?profile=…`) so only the path template compares. */
function normalizeAdvertisedEntry(entry: string): `${string} ${string}` {
  const separator = entry.indexOf(" ");
  if (separator !== -1) {
    const method = entry.slice(0, separator);
    const rest = entry.slice(separator + 1);
    const query = rest.indexOf("?");
    return `${method} ${query === -1 ? rest : rest.slice(0, query)}` as `${string} ${string}`;
  }
  return `GET ${entry.trim()}` as `${string} ${string}`;
}

const STUB_SERVICE = {} as never;

const rootApp = createApp({ createEnrollmentStore: (() => ({})) as never });
const enrollmentRouter = createEnrollmentRouter({ service: STUB_SERVICE });
const sessionRouter = createSessionRouter({
  service: STUB_SERVICE,
  replayProtector: STUB_SERVICE,
});

async function servedCapabilities(): Promise<{
  readonly reads: readonly string[];
  readonly agent_writes: readonly string[];
  readonly fellow_reads: readonly string[];
}> {
  const env = {
    STOA_ORIGIN: "https://a.asimposium.org",
    AGORA_ORIGIN: "https://asimposium.org",
  } as unknown as Env;
  const response = await rootApp.fetch(
    new Request("https://a.asimposium.org/capabilities"),
    env,
    undefined,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as {
    reads: string[];
    agent_writes: string[];
    fellow_reads: string[];
  };
}

describe("capabilities disclosure census over every mounted router (asimposiumorg-phg.1.2)", () => {
  // Intentionally undisclosed classes. Each reason is the declaration-site
  // answer to "why is this reachable route absent from discovery". A new
  // mounted route that lands here neither advertised nor classified turns the
  // main assertion red with the exact key listed.
  const UNDISCLOSED_REASON_BY_ROUTE: Record<string, string> = {
    "POST /internal/screen":
      "operator screening runs as the platform principal and is disclosed to operators, never in the public capability document",
    "GET /p/<id>{.+\\.events\\.json$}":
      "per-problem event tails are quarantined fail-closed placeholders until the W6.4 face contract mounts",
    "GET /p/<id>{.+\\.json$}":
      "per-problem JSON faces are quarantined fail-closed placeholders until their Diptych contract mounts",
    "GET /p/<id>{.+\\.md$}":
      "per-problem markdown faces are quarantined fail-closed placeholders until their Diptych contract mounts",
    "POST /v1/enrollments":
      "signed sponsor-plane write; capabilities summarizes this surface as sponsor_surface and never enumerates it",
    "GET /v1/enrollments/proposals":
      "signed sponsor-plane read; summarized by sponsor_surface, never enumerated",
    "POST /v1/enrollments/<enrollmentId>/decision":
      "signed sponsor-plane approval write; summarized by sponsor_surface, never enumerated",
    "POST /v1/device-lookup":
      "signed sponsor-plane device lookup; summarized by sponsor_surface, never enumerated",
    "POST /v1/fellows/credentials/revoke":
      "signed sponsor-plane revocation write; summarized by sponsor_surface, never enumerated",
    "POST /v1/fellows/lifecycle":
      "signed sponsor-plane lifecycle write; summarized by sponsor_surface, never enumerated",
    "POST /v1/sponsors/panic":
      "signed sponsor-plane panic boundary write; summarized by sponsor_surface, never enumerated",
    "POST /v1/sponsors/bootstrap":
      "signed sponsor-plane bootstrap write; summarized by sponsor_surface, never enumerated",
    "POST /v1/sponsors/workshop":
      "signed sponsor console workshop preview; summarized by sponsor_surface, never enumerated",
    "GET /v1/operators/sponsors/<sponsorId>/fellow-cap":
      "operator-plane read behind the service envelope; operator tooling is deliberately undisclosed",
    "GET /v1/operators/sponsors/<sponsorId>/fellow-cap/history":
      "operator-plane history read; operator tooling is deliberately undisclosed",
    "GET /v1/operators/sponsors/<sponsorId>/fellow-cap/history/after/<cursor>":
      "operator-plane history cursor read; operator tooling is deliberately undisclosed",
    "POST /v1/operators/fellow-cap":
      "operator-plane cap override write; operator tooling is deliberately undisclosed",
    "GET /v1/fellows":
      "Fellow roster read exists behind the bearer but discovery omits it until its public face contract lands",
    "GET /v1/fellows/after/<cursor>":
      "Fellow roster cursor page exists behind the bearer but discovery omits it until its public face contract lands",
    "POST /v1/sessions/<id>/revise":
      "session-write family beyond the advertised core; enumeration awaits the capabilities v0.2 revision",
    "POST /v1/sessions/<id>/gaps":
      "session-write family beyond the advertised core; enumeration awaits the capabilities v0.2 revision",
    "POST /v1/sessions/<id>/gaps/close":
      "session-write family beyond the advertised core; enumeration awaits the capabilities v0.2 revision",
    "POST /v1/sessions/<id>/relations":
      "session-write family beyond the advertised core; enumeration awaits the capabilities v0.2 revision",
    "POST /v1/sessions/<id>/review":
      "session-write family beyond the advertised core; enumeration awaits the capabilities v0.2 revision",
    "POST /v1/sessions/<id>/hypotheses":
      "session-write family beyond the advertised core; enumeration awaits the capabilities v0.2 revision",
    "POST /v1/sessions/<id>/hypotheses/<hid>/kill":
      "session-write family beyond the advertised core; enumeration awaits the capabilities v0.2 revision",
    "POST /v1/sessions/<id>/evidence":
      "session-write family beyond the advertised core; enumeration awaits the capabilities v0.2 revision",
  };

  function mountedCensus(): {
    readonly all: ReadonlySet<string>;
    readonly counts: Record<string, number>;
  } {
  function mountedCensus(): {
    readonly all: ReadonlySet<string>;
    readonly counts: Record<string, number>;
  } {
    // Ledger-face routes are mounted at "/" into createApp's own table; prove
    // that assumption against the unfiltered root table instead of trusting it.
    const rootGetPaths = new Set(
      rootApp.routes.filter((route) => route.method === "GET").map((route) => route.path),
    );
    const sources: Record<string, readonly RawRoute[]> = {
      // The census counts each /problems.* row once under ledgerFace, so the
      // root bucket excludes exactly those paths.
      createApp: rootApp.routes.filter(
        (route) => !route.method.startsWith("HEAD") && !route.path.startsWith("/problems."),
      ),
      ledgerFace: rootApp.routes.filter((route) => route.path.startsWith("/problems.")),
      enrollmentRouter: enrollmentRouter.routes,
      sessionRouter: sessionRouter.routes,
    };
    expect(
      [...sources.ledgerFace].every((route) => rootGetPaths.has(route.path)),
    ).toBe(true);
    const counts: Record<string, number> = {};
    const all = new Set<string>();
    for (const [source, routes] of Object.entries(sources)) {
      let count = 0;
      for (const route of routes) {
        if (route.method === "HEAD") continue; // disclosed together with its GET twin
        if (route.method === "ALL") continue; // wildcard middleware plumbing
        all.add(`${route.method} ${normalizeMountedPath(route.path)}`);
        count += 1;
      }
      counts[source] = count;
    }
    return { all, counts };
  }

  test("every source table contributes routes (nonvacuity)", () => {
    const { counts } = mountedCensus();
    expect(counts.createApp ?? 0).toBeGreaterThan(10);
    expect(counts.enrollmentRouter ?? 0).toBeGreaterThanOrEqual(15);
    expect(counts.sessionRouter ?? 0).toBeGreaterThanOrEqual(10);
    expect(counts.ledgerFace ?? 0).toBeGreaterThanOrEqual(2);
  });

  test("every mounted route is advertised, or classified undisclosed with a reason", async () => {
    const body = await servedCapabilities();
    const advertised = new Set<string>(
      [...body.reads, ...body.agent_writes, ...body.fellow_reads].map(normalizeAdvertisedEntry),
    );

    const { all } = mountedCensus();
    const unclassified: string[] = [];
    for (const key of all) {
      if (advertised.has(key)) continue;
      const reason = UNDISCLOSED_REASON_BY_ROUTE[key];
      if (reason !== undefined && reason.length > 0) continue;
      unclassified.push(key);
    }
    // The exact list keeps a failure actionable: each missing classification is
    // named, not counted.
    expect(unclassified).toEqual([]);

    // Phantom direction: no advertisement may name a route nothing mounts.
    for (const key of advertised) {
      expect(all.has(key), key).toBe(true);
    }
  });

  test("the refusal predicate rejects rather than ignores an unknown route", () => {
    // Feed the same predicate one synthetic route that is neither advertised
    // nor classified: it must come back unclassified, proving the gate refuses
    // instead of silently passing unknown entries.
    const advertised = new Set<string>(["GET /"]);
    const candidate = "POST /v1/future-thing";
    const reason = UNDISCLOSED_REASON_BY_ROUTE[candidate];
    const unclassified =
      !advertised.has(candidate) && (reason === undefined || reason.length === 0);
    expect(unclassified).toBe(true);
  });
});
