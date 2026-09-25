import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// kqz5 / b9y9 (P7): a generated census of every MOUNTED write route in the
// Worker, not only the advertised OpenAPI subset. Every route must be
// classified. A new mutation route fails this test until someone decides
// whether it carries public Fellow text and, if so, names the real-bindings
// lane that proves its screening. The classification is a decision record;
// the screening itself is proven by the named lanes, not here.

const WIRE = resolve(import.meta.dir, "../..");
const SRC = join(WIRE, "src");

type Class =
  | { kind: "screened"; proof: string }
  | { kind: "reference-only"; why: string }
  | { kind: "private"; why: string }
  | { kind: "human-lane"; why: string }
  | { kind: "identity-admin"; why: string };

const LANE = "test/integration/discovery-real-bindings.mjs";
const DIRECT = "test/integration/direct-append-screening-real-bindings.mjs";
const screened = (proof: string): Class => ({ kind: "screened", proof });

/** Routes dispatched by path matchers or registered through a path constant. */
const PATH_MATCHED_WRITES = [
  "POST /v1/p/:problem/review-requests",
  "POST /v1/artifacts",
  "POST /v1/artifacts/:id/complete",
  "POST /v1/artifacts/:id/publish",
  "POST /v1/sessions/:id/evidence/:eid/retract",
  "POST /v1/sessions/:id/reviews/:rid/retract",
] as const;

const CENSUS: Readonly<Record<string, Class>> = {
  // Ledger writes carrying public Fellow text.
  "POST /v1/sessions/:id/promote": screened(LANE),
  "POST /v1/sessions/:id/revise": screened(LANE),
  "POST /v1/sessions/:id/gaps": screened(LANE),
  "POST /v1/sessions/:id/gaps/close": screened(LANE),
  "POST /v1/sessions/:id/relations": screened(LANE),
  "POST /v1/sessions/:id/relations/dispute": screened(LANE),
  "POST /v1/sessions/:id/review": screened(LANE),
  "POST /v1/sessions/:id/hypotheses": screened(LANE),
  "POST /v1/sessions/:id/hypotheses/:hid/kill": screened(LANE),
  "POST /v1/sessions/:id/evidence": screened(LANE),
  "POST /v1/sessions/:id/friction": screened(LANE),
  "POST /v1/sessions/:id/synthesize": screened(LANE),
  "POST /v1/sessions/:id/dead-ends": screened(LANE),
  "POST /v1/sessions/:id/questions": screened(LANE),
  "POST /v1/sessions/:id/questions/:qid/lease": screened(LANE),
  "POST /v1/sessions/:id/questions/:qid/withdraw": screened(LANE),
  "POST /v1/sessions/:id/retract": screened(LANE),
  "POST /v1/sessions/:id/conflicts": screened(LANE),
  "POST /v1/sessions/:id/conflicts/:cid/resolve": screened(LANE),
  "POST /v1/sessions/:id/citations": screened(LANE),
  "POST /v1/sessions/:id/citations/correct": screened(LANE),
  "POST /v1/sessions/:id/citations/:citationId/correct": screened(LANE),
  "POST /v1/sessions/:id/leases": screened(LANE),
  "POST /v1/sessions/:id/leases/:ref/release": screened(LANE),
  "POST /v1/sessions/:id/leases/:ref/challenge": screened(LANE),
  "DELETE /v1/sessions/:id/leases/:ref": screened(LANE),
  "POST /v1/sessions/:id/evidence/:eid/retract": screened(LANE),
  "POST /v1/sessions/:id/reviews/:rid/retract": screened(LANE),
  "POST /v1/problems/:id/statement-review": screened(
    "test/integration/statement-review-real-bindings.mjs",
  ),
  "POST /v1/sponsors/problems/:id/lifecycle": screened(
    "test/integration/problem-screening-real-bindings.mjs",
  ),
  "POST /v1/sponsors/leases/release": screened(LANE),
  // Direct-append routes open an implicit session and call the same screened
  // executors as the session routes. Claims and dead-ends are proven directly;
  // the rest cite the session lane that proves their shared executor.
  "POST /v1/p/:id/claims": screened(DIRECT),
  "POST /v1/p/:id/dead-ends": screened(DIRECT),
  "POST /v1/p/:id/hypotheses": screened(LANE),
  "POST /v1/p/:id/evidence": screened(LANE),
  "POST /v1/p/:id/review": screened(LANE),
  "POST /v1/p/:id/reviews": screened(LANE),
  "POST /v1/p/:id/events:batch": screened(LANE),
  "POST /v1/artifacts/:id/publish": screened("test/integration/artifact-real-bindings.mjs"),

  "POST /v1/sessions/:id/reanchor": {
    kind: "reference-only",
    why: "binds a claim id/version to the current statement version",
  },
  "POST /v1/sessions/:id/questions/:qid/answer": {
    kind: "reference-only",
    why: "resolved_by_object is an id",
  },
  "POST /v1/sessions/:id/heartbeat": { kind: "reference-only", why: "liveness only" },

  "POST /v1/sessions": { kind: "private", why: "opens a session; no public text" },
  "POST /v1/sessions/:id/close": { kind: "private", why: "handback goes to the sponsor" },
  "POST /v1/sessions/:id/workshop": { kind: "private", why: "workshop is Fellow+sponsor only" },
  "POST /v1/sponsors/workshop": { kind: "private", why: "sponsor view of own workshop" },
  "POST /v1/problems": {
    kind: "private",
    why: "a proposal is a private draft; its text is screened at publish",
  },
  "POST /v1/sponsors/problem-briefs": { kind: "private", why: "sponsor-private briefs" },
  "POST /v1/sponsors/problem-briefs/:id/withdraw": { kind: "private", why: "sponsor-private" },
  "DELETE /v1/sponsors/problems/:id": { kind: "private", why: "deletes a private draft" },
  "POST /v1/sponsors/directives": { kind: "private", why: "directives reach own Fellows only" },
  "POST /v1/artifacts": { kind: "private", why: "declares a private upload" },
  "POST /v1/artifacts/:id/complete": { kind: "private", why: "verifies private bytes" },
  "POST /v1/p/:problem/review-requests": { kind: "private", why: "private coordination, ids only" },
  "POST /v1/p/:problem/review-requests/:requestId/respond": {
    kind: "private",
    why: "private coordination",
  },

  "POST /v1/problems/:id/commentary": {
    kind: "human-lane",
    why: "human commentary lane with its own screen (commentary/service.ts)",
  },
  "POST /v1/problems/:id/commentary/:commentaryId/tombstone": {
    kind: "human-lane",
    why: "removes commentary",
  },

  "POST /v1/device-code": { kind: "identity-admin", why: "enrollment device flow" },
  "POST /v1/device-lookup": { kind: "identity-admin", why: "enrollment device flow" },
  "POST /v1/device-token": { kind: "identity-admin", why: "enrollment device flow" },
  "POST /v1/enrollments": { kind: "identity-admin", why: "mint enrollment" },
  "POST /v1/enrollments/:enrollmentId/decision": {
    kind: "identity-admin",
    why: "sponsor decision",
  },
  "POST /v1/fellows": {
    kind: "identity-admin",
    why: "registration; the Fellow name is validated by enrollmentNameFailure (not P7-screened)",
  },
  "POST /v1/fellows/flow": { kind: "identity-admin", why: "device poll" },
  "POST /v1/fellows/credentials/revoke": { kind: "identity-admin", why: "credential" },
  "POST /v1/fellows/lifecycle": { kind: "identity-admin", why: "sponsor lifecycle" },
  "POST /v1/protocol/ack": { kind: "identity-admin", why: "protocol acknowledgement" },
  "POST /v1/operators/areas/rename": { kind: "identity-admin", why: "operator" },
  "POST /v1/operators/content-control": { kind: "identity-admin", why: "operator" },
  "POST /v1/operators/fellow-cap": { kind: "identity-admin", why: "operator" },
  "POST /v1/operators/quarantine/decision": { kind: "identity-admin", why: "operator" },
  "POST /v1/operators/reports/resolution": { kind: "identity-admin", why: "operator" },
  "POST /v1/sponsors/account/delete": { kind: "identity-admin", why: "account" },
  "POST /v1/sponsors/bootstrap": { kind: "identity-admin", why: "account" },
  "POST /v1/sponsors/panic": { kind: "identity-admin", why: "account" },
  "POST /v1/sponsors/transfers": { kind: "identity-admin", why: "transfer" },
  "POST /v1/sponsors/transfers/:transferId/accept": { kind: "identity-admin", why: "transfer" },
  "POST /v1/sponsors/transfers/:transferId/cancel": { kind: "identity-admin", why: "transfer" },
  "POST /v1/sponsors/transfers/:transferId/reject": { kind: "identity-admin", why: "transfer" },
  "POST /v1/inbox/ack": { kind: "identity-admin", why: "private inbox state" },
  "POST /v1/p/:id/follow": { kind: "identity-admin", why: "follow state" },
  "DELETE /v1/p/:id/follow": { kind: "identity-admin", why: "follow state" },
  "POST /v1/problems/:id/follow": { kind: "identity-admin", why: "follow state" },
  "DELETE /v1/problems/:id/follow": { kind: "identity-admin", why: "follow state" },
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") && !path.includes(".test.") ? [path] : [];
  });
}

/** Every Hono write registration with a literal /v1 path in the given sources. */
function mountedWrites(sources: readonly string[]): string[] {
  const routes = new Set<string>();
  for (const text of sources) {
    for (const m of text.matchAll(/\b\w+\.(post|put|patch|delete)\(\s*(["'`])([^"'`]+)\2/g)) {
      const path = (m[3] ?? "").replace(/^\$\{PATH\}/, "/v1/p/:problem/review-requests");
      if (path.startsWith("/v1/")) routes.add(`${(m[1] ?? "").toUpperCase()} ${path}`);
    }
  }
  return [...routes].sort();
}

describe("P7 public-write census (kqz5)", () => {
  const sources = sourceFiles(SRC).map((path) => readFileSync(path, "utf8"));
  const mounted = [...new Set([...mountedWrites(sources), ...PATH_MATCHED_WRITES])].sort();

  test("every mounted write route is classified", () => {
    const unclassified = mounted.filter((route) => CENSUS[route] === undefined);
    expect(unclassified).toEqual([]);
  });

  test("the census has no stale entries", () => {
    const stale = Object.keys(CENSUS).filter((route) => !mounted.includes(route));
    expect(stale).toEqual([]);
  });

  test("every screened route names an existing real-bindings proof", () => {
    for (const [route, decision] of Object.entries(CENSUS)) {
      if (decision.kind !== "screened") continue;
      expect(existsSync(join(WIRE, decision.proof)), `${route} -> ${decision.proof}`).toBe(true);
    }
  });

  test("PLANTED: a new unscreened write route fails the census", () => {
    const planted = `app.post("/v1/sessions/:id/new-public-thing", async (c) => c.json({}));`;
    const withPlant = mountedWrites([...sources, planted]);
    expect(withPlant).toContain("POST /v1/sessions/:id/new-public-thing");
    expect(withPlant.filter((route) => CENSUS[route] === undefined)).toEqual([
      "POST /v1/sessions/:id/new-public-thing",
    ]);
  });
});
