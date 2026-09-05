/**
 * Source-derived capabilities disclosure census (asimposiumorg-phg.1.2).
 *
 * `createApp` alone cannot see the whole mounted surface: the enrollment and
 * session routers are dispatched through wildcard middleware, so their route
 * tables never enter the root Hono instance. This census unions the runtime
 * `.routes` arrays of all four constructed routers (root app including the
 * ledger-face mount at "/", enrollment router, session router) and requires
 * every mounted method+path to be either advertised in the served capabilities
 * document or explicitly classified as intentionally undisclosed with a
 * nonblank reason below.
 *
 * Adding a mounted route without one of those two outcomes fails this contract
 * lane; an advertisement naming a route nothing mounts also fails (phantom
 * check). Templates normalize one way — mounted `:param{regex}` becomes
 * comparison `<param>` form; OpenAPI `{param}` rows use the same spelling and lose `?query` suffixes and
 * `(bearer)` prose annotations — so the comparison can never be satisfied by
 * editing mounted paths to chase advertisement text.
 */
import { describe, expect, test } from "bun:test";

import { createApp } from "../../src/app.ts";
import { createEnrollmentRouter } from "../../src/enrollment/router.ts";
import type { Env } from "../../src/env.ts";
import { createSessionRouter } from "../../src/sessions/router.ts";

interface RawRoute {
  readonly method: string;
  readonly path: string;
}

/** One-way normalization: mounted regex suffixes retain their public suffix. */
function normalizeMountedPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)(?:\{([^}]*)\})?/g, (_match, name, pattern) => {
    const suffix = ["md", "json", "html"].find((face) => pattern?.endsWith(`\\.${face}$`));
    return `<${name}>${suffix === undefined ? "" : `.${suffix}`}`;
  });
}

/**
 * Normalize an advertised capability row to its method+path template. Fellow-tier
 * rows carry a trailing "(bearer)" prose annotation, pack rows a "?profile=…"
 * suffix; neither is part of the mounted template.
 */
function normalizeAdvertisedEntry(entry: string): `${string} ${string}` {
  const separator = entry.indexOf(" ");
  const method = separator !== -1 ? entry.slice(0, separator) : "GET";
  let path = separator !== -1 ? entry.slice(separator + 1) : entry;
  const query = path.indexOf("?");
  if (query !== -1) path = path.slice(0, query);
  path = path.replace(/\s*\([^)]*\)\s*$/, "").trim();
  path = path.replace(/\{([A-Za-z0-9_]+)\}/g, "<$1>");
  return `${method} ${path}` as `${string} ${string}`;
}

function advertisementHasMount(key: string, mounted: ReadonlySet<string>): boolean {
  if (mounted.has(key)) return true;
  // A final Hono :param accepts suffix bytes inside the parameter. Discovery
  // handlers split those bytes themselves; representation behavior is checked
  // by discovery-routes and the real-binding lane, not inferred by this census.
  const parameterRoute = key.replace(/(<[A-Za-z0-9_]+>)\.(md|json|html)$/, "$1");
  return parameterRoute !== key && mounted.has(parameterRoute);
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
  // answer to "why is this reachable route absent from discovery". A newly
  // mounted route that lands neither here nor in the advertisement turns the
  // main assertion red listing the exact key.
  const UNDISCLOSED_REASON_BY_ROUTE: Record<string, string> = {
    "POST /internal/screen":
      "operator screening runs as the platform principal and is disclosed to operators, never in the public capability document",
    "GET /p/<id>/*":
      "nested /p path guard; contracted digest faces are one-segment only and this template 404s every nested spelling before D1",
    "GET /p/<id>/events.json":
      "the nested W6.4 route remains fail-closed until its response contract and complete implementation land",
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
  };

  function mountedCensus(): {
    readonly all: ReadonlySet<string>;
    readonly counts: Record<string, number>;
  } {
    // Ledger-face routes are mounted at "/" into createApp's own table; prove
    // that assumption against the unfiltered root table instead of trusting it.
    const rootGetPaths = new Set(
      rootApp.routes.filter((route) => route.method === "GET").map((route) => route.path),
    );
    // Each /problems.* row counts once under ledgerFace, so the root bucket
    // excludes exactly those paths.
    const sources: Record<string, readonly RawRoute[]> = {
      createApp: rootApp.routes.filter(
        (route) => route.method !== "HEAD" && !route.path.startsWith("/problems."),
      ),
      ledgerFace: rootApp.routes.filter((route) => route.path.startsWith("/problems.")),
      enrollmentRouter: enrollmentRouter.routes,
      sessionRouter: sessionRouter.routes,
    };
    const ledgerRows = sources.ledgerFace ?? [];
    expect(ledgerRows.length).toBeGreaterThan(0);
    expect(ledgerRows.every((route) => rootGetPaths.has(route.path))).toBe(true);
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
      expect(advertisementHasMount(key, all), key).toBe(true);
    }
    // Retired exemptions must not conceal later disclosure regressions.
    for (const [key, reason] of Object.entries(UNDISCLOSED_REASON_BY_ROUTE)) {
      expect(all.has(key), key).toBe(true);
      expect(advertised.has(key), key).toBe(false);
      expect(reason.trim().length, key).toBeGreaterThan(0);
    }
  });

  test("template normalization preserves parameter names and face suffixes", () => {
    expect(normalizeMountedPath("/a/:name{.+\\.html$}")).toBe("/a/<name>.html");
    expect(normalizeMountedPath("/p/:id{.+\\.json$}")).toBe("/p/<id>.json");
    expect(normalizeMountedPath("/area/:slug.md")).toBe("/area/<slug>.md");
    expect(normalizeAdvertisedEntry("GET /p/{id}.json")).toBe("GET /p/<id>.json");
    expect(normalizeAdvertisedEntry("GET /v1/sessions/{id}/pack?profile=working (bearer)")).toBe(
      "GET /v1/sessions/<id>/pack",
    );
    expect(normalizeAdvertisedEntry("GET /join/{enrollmentId}")).toBe("GET /join/<enrollmentId>");
    expect(normalizeAdvertisedEntry("GET /p/{different}.json")).not.toBe("GET /p/<id>.json");
    expect(normalizeAdvertisedEntry("GET /p/{id}.md")).not.toBe("GET /p/<id>.json");
    const mounted = new Set(["GET /a/<name>", "GET /p/<id>.json"]);
    expect(advertisementHasMount("GET /a/<name>.html", mounted)).toBe(true);
    expect(advertisementHasMount("GET /p/<id>.html", mounted)).toBe(false);
    expect(advertisementHasMount("GET /a/<name>/absent.json", mounted)).toBe(false);
    expect(advertisementHasMount("GET /a/<different>.json", mounted)).toBe(false);
    expect(advertisementHasMount("POST /a/<name>.json", mounted)).toBe(false);
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
