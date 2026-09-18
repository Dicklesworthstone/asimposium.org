import { test } from "bun:test";
import assert from "node:assert/strict";
import { LedgerMovesProvider } from "../../src/mega-commands/live-provider";

// These are provider-composition fixtures. Separate reader tests exercise the
// actual SQL; this suite does not replace a central-authorization integration test.
function fixture(
  options: {
    role?: string;
    deny?: string;
    hasClaims?: boolean;
    fail?: boolean;
    mismatch?: boolean;
    queue?: Record<string, boolean>;
    counts?: Record<string, number>;
  } = {},
) {
  const calls: string[] = [];
  const template = (move: string) =>
    ({
      move,
      availability: "available",
      prefilled_hints: {},
      request: { method: "POST", path: `/v1/sessions/{id}/${move}` },
    }) as any;
  const db = {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          return {
            first: async () => {
              calls.push("membership");
              return options.role === "none"
                ? null
                : {
                    role: options.role ?? "contributor",
                    cursor: 50,
                    has_claims: options.hasClaims ? 1 : 0,
                  };
            },
            all: async () => ({ results: [] }),
          };
        },
      };
    },
  } as any;
  const credential = {
    fellowId: "F-READER",
    sponsorId: "SP-READER",
    grantedResources: {},
    fellowStatus: "active",
  } as any;
  let active = 0,
    peak = 0;
  const provider = new LedgerMovesProvider({
    now: () => 123,
    authorize: (({ effect, target }: any) => ({
      decision:
        effect === options.deny || (effect === "promote" && target.membershipRole === "observer")
          ? "refuse"
          : "allow",
    })) as any,
    firstClaimTemplate: () => template("state-claim"),
    templateFor: template,
    async loadQueue(_db, { problem }) {
      const candidates = options.queue?.[problem]
        ? [
            {
              problem_id: problem,
              claim_id: "C-1",
              version: 1,
              cursor: 50,
              author_fellow_id: "F-OTHER",
              author_sponsor_id: "SP-OTHER",
              need: "independent-review",
              direct_dependents: 1,
              created_at: "2026-09-01T00:00:00.000Z",
            },
          ]
        : [];
      return { problem, candidates, omitted: [], next_after: null } as any;
    },
    hypotheses: {
      template: () => template("third-alternative"),
      async load(_db, problem, cursor) {
        assert.equal(cursor, 50);
        calls.push(problem);
        active++;
        peak = Math.max(peak, active);
        try {
          await new Promise((resolve) => setTimeout(resolve, problem.endsWith("A") ? 5 : 1));
          if (options.fail) throw new Error("private source detail");
          return {
            unlisted: false,
            face: {
              problem_id: problem,
              cursor: options.mismatch ? 51 : cursor,
              after: 0,
              next_after: null,
              omitted: [],
              hypotheses: Array.from({ length: options.counts?.[problem] ?? 2 }, (_, i) => ({
                hypothesis_id: `H-${i + 1}`,
                status: "active",
                content: { route: "Untrusted route" },
                publication: {
                  seq: i + 1,
                  event_id: `EV-${i + 1}`,
                  payload_sha256: "a".repeat(64),
                },
                last_event: { event_id: `EV-${i + 1}` },
              })),
            },
          } as any;
        } finally {
          active--;
        }
      },
    },
  });
  const next = (problem = "P-DEMO") =>
    provider.nextMoves({
      db,
      credential,
      problemId: problem,
      fellowId: credential.fellowId,
      role: "contributor",
      effectivePermissions: { promote: true, review: true, session_open: true },
    });
  const triage = (problems: string[]) =>
    provider.triageMove({
      db,
      credential,
      fellowId: credential.fellowId,
      assignments: problems.map((problem_id) => ({ problem_id, role: "contributor" })) as any,
    });
  return { next, triage, calls, peak: () => peak };
}
test("next selects third alternative ahead of first claim and preserves the workshop option", async () => {
  const f = fixture();
  const r = await f.next();
  assert.equal(r.primaryMove?.move, "third-alternative");
  assert.equal(r.alternatives[0]?.move, "state-claim");
  assert.equal(r.degraded, false);
  assert.deepEqual(f.calls, ["membership", "P-DEMO"]);
});
test("next keeps existing independent checks ahead of alternative generation", async () => {
  const f = fixture({ hasClaims: true, queue: { "P-DEMO": true } });
  const r = await f.next();
  assert.equal(r.primaryMove?.move, "review");
  assert.equal(r.alternatives[0]?.move, "third-alternative");
  assert.equal(r.degraded, false);
});
for (const options of [
  { role: "observer" },
  { deny: "promote" },
  { deny: "session.open" },
  { role: "none" },
]) {
  test(`central permission or membership refusal prevents hypothesis selection: ${JSON.stringify(options)}`, async () => {
    const f = fixture(options);
    const r = await f.next();
    assert.equal(r.primaryMove, null);
    assert.equal(f.calls.includes("P-DEMO"), false);
  });
}
for (const options of [{ fail: true }, { mismatch: true }]) {
  test(`a failed hypothesis source preserves existing review work with partial disclosure: ${JSON.stringify(options)}`, async () => {
    const f = fixture({ ...options, hasClaims: true, queue: { "P-DEMO": true } });
    const r = await f.next();
    assert.equal(r.primaryMove?.move, "review");
    assert.equal(r.degraded, true);
    assert.equal(r.degradedReason, "MOVES_PARTIAL");
    assert.ok(!JSON.stringify(r).includes("private source detail"));
  });
}
test("triage chooses an existing review over both third alternative and first claim", async () => {
  const f = fixture({ hasClaims: true, queue: { "P-C": true }, counts: { "P-A": 0, "P-C": 0 } });
  const r = await f.triage(["P-B", "P-C", "P-A"]);
  assert.equal(r.move?.move, "review");
  assert.equal(r.move?.refs[0], "P-C");
});
test("triage chooses an exact two-route need before an empty board with deterministic ties", async () => {
  const f = fixture({ counts: { "P-A": 0 } });
  const r = await f.triage(["P-C", "P-B", "P-A"]);
  assert.equal(r.move?.move, "third-alternative");
  assert.equal(r.move?.refs[0], "P-B");
  assert.equal(r.degraded, false);
  assert.ok(f.peak() <= 2);
});
test("triage does not exceed its bounded problem and concurrency limits", async () => {
  const f = fixture();
  const r = await f.triage(["P-F", "P-E", "P-D", "P-C", "P-B", "P-A"]);
  assert.equal(r.degraded, true);
  assert.equal(r.move?.refs[0], "P-A");
  assert.deepEqual(f.calls.filter((c) => c !== "membership").sort(), ["P-A", "P-B", "P-C", "P-D"]);
  assert.equal(f.peak(), 2);
});
test("three surviving routes leave the first-claim workflow without a false alternative recommendation", async () => {
  const f = fixture({ counts: { "P-DEMO": 3 } });
  const r = await f.next();
  assert.equal(r.primaryMove?.move, "state-claim");
  assert.equal(r.degraded, false);
});
