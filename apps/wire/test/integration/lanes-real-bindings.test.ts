import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { delimiter, resolve } from "node:path";

// Real-bindings journeys that are not screening modes of the discovery
// registry (discovery-real-bindings.test.ts). Each runs as its own genuine
// Node process against local Workerd/D1/R2 and must exit 0 with a passing
// final record. Until 2026-09-26 no suite ran these lanes at all; they
// were reachable only through hand-run scripts/e2e-*.sh wrappers.

const INTEGRATION = import.meta.dir;

const LANES = [
  "artifact",
  "citations",
  "claims",
  "commentary",
  "conflicts",
  "dead-ends",
  "direct-append-race",
  "direct-append-sessions",
  "dispositions",
  "event-tails",
  "face-census",
  "fellow-rebind",
  "hypotheses-evidence",
  "ledger-objects-integration",
  "problem-duplicate-privacy",
  "problem-lifecycle",
  "projection-doctor",
  "projection-legacy-backfill",
  "questions-retractions",
  "relations-gaps",
  "reviews",
  "secret-scan",
  "session-lifecycle",
  "session-presence",
  "stale-route",
  "synthesis",
  "transition-race",
] as const;

/**
 * Lanes that need an input no suite host provides, each with the reason and
 * how to run it. They are registered here so the registry check still sees
 * every journey.
 */
const MANUAL_LANES: Record<string, string> = {
  "cli-search":
    "needs the asimp Rust library test binary (ASIMP_SEARCH_TEST_BINARY); build it as the lane header says, then run the lane by hand",
};

async function genuineNode(): Promise<string> {
  const candidates = [
    ...(process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((dir) => resolve(dir, "node")),
    "/usr/bin/node",
    "/usr/local/bin/node",
  ];
  for (const candidate of candidates) {
    if (!(await Bun.file(candidate).exists())) continue;
    const probe = Bun.spawnSync(
      [
        candidate,
        "-e",
        "process.exit(process.versions.bun || Number(process.versions.node.split('.')[0]) < 22 ? 1 : 0)",
      ],
      { stdout: "ignore", stderr: "ignore", timeout: 5000 },
    );
    if (probe.exitCode === 0) return candidate;
  }
  throw new Error(
    "REAL_BINDINGS_NODE_UNAVAILABLE: install genuine Node >=22; Bun's Node alias cannot run Wrangler's test harness",
  );
}

/** Harness postcondition records printed after a journey returns. */
const POSTCONDITION_STAGES = new Set([
  "projection-parity",
  "ledger-trigger-probes",
  "public-search-invariant",
]);

/** A lane's last JSON record states its own pass in one of three shapes. */
function passed(record: Record<string, unknown> | undefined): boolean {
  if (record === undefined) return false;
  if (record.status === "pass" || record.pass === true) return true;
  return typeof record.stage === "string" && /(passed|success|complete)$/.test(record.stage);
}

describe("real-bindings lane registry", () => {
  test("every real-bindings journey is registered in exactly one runner", () => {
    const discovery = readFileSync(resolve(INTEGRATION, "discovery-real-bindings.test.ts"), "utf8");
    const files = readdirSync(INTEGRATION).filter((name) => name.endsWith("-real-bindings.mjs"));
    const unregistered = files.filter(
      (file) =>
        // discovery-real-bindings.mjs is the discovery registry's own journey.
        file !== "discovery-real-bindings.mjs" &&
        !discovery.includes(`"${file}"`) &&
        !(LANES as readonly string[]).includes(file.replace(/-real-bindings\.mjs$/, "")) &&
        MANUAL_LANES[file.replace(/-real-bindings\.mjs$/, "")] === undefined,
    );
    const doubled = LANES.filter((lane) => discovery.includes(`"${lane}-real-bindings.mjs"`));
    expect({ unregistered, doubled }).toEqual({ unregistered: [], doubled: [] });
  });
});

test.each([...LANES])(
  "%s journey passes on real local bindings",
  async (lane) => {
    const node = await genuineNode();
    const child = Bun.spawn([node, resolve(INTEGRATION, `${lane}-real-bindings.mjs`)], {
      cwd: resolve(INTEGRATION, "../../../.."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exit !== 0) throw new Error(`${lane} lane failed (${exit}): ${stderr.slice(-2000)}`);
    const records = stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      });
    // The shared harness appends postcondition records (projection parity,
    // trigger probes, public-search invariant) after the journey returns; each
    // asserts, so a failing one already exits non-zero. The lane's own verdict
    // is its last record before them.
    const journey = records.filter(
      (record) => record === undefined || !POSTCONDITION_STAGES.has(String(record.stage)),
    );
    expect(passed(journey.at(-1)), `${lane}: final record ${JSON.stringify(journey.at(-1))}`).toBe(
      true,
    );
  },
  600_000,
);
