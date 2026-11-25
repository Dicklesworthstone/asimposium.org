import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const MAP_PATH = resolve(REPO_ROOT, "docs/acceptance-command-map.json");
const BEADS_JSONL_PATH = resolve(REPO_ROOT, ".beads/issues.jsonl");
const LANES_REGISTRY_PATH = resolve(
  REPO_ROOT,
  "apps/wire/test/integration/lanes-real-bindings.test.ts",
);
const DISCOVERY_REGISTRY_PATH = resolve(
  REPO_ROOT,
  "apps/wire/test/integration/discovery-real-bindings.test.ts",
);

const ACCEPTANCE_SCRIPT_RE = /scripts\/[A-Za-z0-9._/-]+\.(?:sh|ts|mjs)/g;
const REAL_BINDINGS_LANE_RE = /^apps\/wire\/test\/integration\/([a-z0-9-]+)-real-bindings\.mjs$/;
const REAL_WORKERD_ENTRYPOINT_RE =
  /^(?:apps\/wire\/test\/integration\/(?:[a-z0-9-]+-real-bindings\.mjs|discovery-real-bindings\.test\.ts)|e2e\/gauntlet\/run\.sh|scripts\/e2e-[a-z0-9-]+\.sh)$/;
const REAL_BROWSER_ENTRYPOINT_RE =
  /^(?:e2e\/playwright\/agora-local-lane\.mjs|e2e\/run-playwright\.sh|scripts\/smoke-gallery\.sh)$/;

export type AcceptanceClassification =
  | "reconciled-workerd-real-bindings"
  | "reconciled-browser-real-lane"
  | "reconciled-gauntlet-runner"
  | "reconciled-rust-cli-parity"
  | "reconciled-contracts-corpus"
  | "reconciled-local-audit-hosted-blocked"
  | "blocked-hosted-deploy-only"
  | "tier-2-deferred";

export type ProofLevel =
  | "workerd-real-bindings"
  | "chromium-browser"
  | "rust-cli-parity"
  | "contracts-golden"
  | "unit-audit"
  | "hosted-blocked"
  | "tier-2-deferred";

export interface MappedCommand {
  readonly cmd: string;
  readonly referenced_files: readonly string[];
  readonly proof_level: ProofLevel;
}

export interface AcceptanceMapEntry {
  readonly missing_path: string;
  readonly bead_id: string;
  readonly priority: number;
  readonly classification: AcceptanceClassification;
  readonly authoritative_commands: readonly MappedCommand[];
  readonly prerequisites: readonly string[];
  readonly negative_control: string;
  readonly remaining_gaps_or_blockers: string;
}

export interface AcceptanceCommandMap {
  readonly schema_version: string;
  readonly bead_id: string;
  readonly policy: string;
  readonly entries: readonly AcceptanceMapEntry[];
}

export interface TrackerMissingPath {
  readonly missing_path: string;
  readonly bead_id: string;
}

function loadRegisteredRealLanes(): Set<string> {
  const lanesSrc = readFileSync(LANES_REGISTRY_PATH, "utf8");
  const discoverySrc = readFileSync(DISCOVERY_REGISTRY_PATH, "utf8");
  const registered = new Set<string>(["discovery"]);

  const lanesBlockMatch = lanesSrc.match(/const LANES\s*=\s*\[([\s\S]*?)\]\s*as const/);
  if (lanesBlockMatch?.[1]) {
    for (const m of lanesBlockMatch[1].matchAll(/"([a-z0-9-]+)"/g)) {
      if (m[1]) registered.add(m[1]);
    }
  }
  const manualBlockMatch = lanesSrc.match(/const MANUAL_LANES[^=]*=\s*\{([\s\S]*?)\};/);
  if (manualBlockMatch?.[1]) {
    for (const m of manualBlockMatch[1].matchAll(/"([a-z0-9-]+)"\s*:/g)) {
      if (m[1]) registered.add(m[1]);
    }
  }
  for (const m of discoverySrc.matchAll(/"([a-z0-9-]+)-real-bindings\.mjs"/g)) {
    if (m[1]) registered.add(m[1]);
  }
  return registered;
}

function loadTrackerAcceptanceIndex(repoRoot: string): {
  readonly openMissingPaths: TrackerMissingPath[];
  readonly allBeadReferencedPaths: ReadonlySet<string>;
} {
  const jsonlPath = resolve(repoRoot, ".beads/issues.jsonl");
  if (!existsSync(jsonlPath)) {
    return { openMissingPaths: [], allBeadReferencedPaths: new Set<string>() };
  }
  const openMissingPaths: TrackerMissingPath[] = [];
  const allBeadReferencedPaths = new Set<string>();
  for (const line of readFileSync(jsonlPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const issue = JSON.parse(line) as {
      id?: string;
      status?: string;
      acceptance_criteria?: string;
    };
    if (!issue.id) continue;
    const ac = issue.acceptance_criteria ?? "";
    for (const matched of new Set(ac.match(ACCEPTANCE_SCRIPT_RE) ?? [])) {
      allBeadReferencedPaths.add(`${matched}::${issue.id}`);
      if (
        (issue.status === "open" || issue.status === "in_progress") &&
        !existsSync(resolve(repoRoot, matched))
      ) {
        openMissingPaths.push({ missing_path: matched, bead_id: issue.id });
      }
    }
  }
  return { openMissingPaths, allBeadReferencedPaths };
}

export function validateAcceptanceCommandMap(
  map: AcceptanceCommandMap,
  opts: {
    readonly repoRoot: string;
    readonly registeredRealLanes: ReadonlySet<string>;
    readonly trackerMissingPaths?: readonly TrackerMissingPath[];
    readonly allBeadReferencedPaths?: ReadonlySet<string>;
  },
): string[] {
  const violations: string[] = [];
  const seenKeys = new Set<string>();

  for (const entry of map.entries) {
    const key = `${entry.missing_path}::${entry.bead_id}`;
    if (seenKeys.has(key)) {
      violations.push(`DUPLICATE_MAP_ENTRY:${key}`);
    }
    seenKeys.add(key);

    if (existsSync(resolve(opts.repoRoot, entry.missing_path))) {
      violations.push(`STALE_MISSING_PATH_NOW_EXISTS:${entry.missing_path}`);
    }
    if (entry.prerequisites.length === 0 || entry.prerequisites.some((p) => p.trim().length < 5)) {
      violations.push(`MISSING_PREREQUISITES:${entry.missing_path}`);
    }
    if (entry.negative_control.trim().length < 15) {
      violations.push(`MISSING_NEGATIVE_CONTROL:${entry.missing_path}`);
    }
    if (entry.remaining_gaps_or_blockers.trim().length < 15) {
      violations.push(`MISSING_NO_CLAIM_BOUNDARY:${entry.missing_path}`);
    }

    if (entry.classification === "tier-2-deferred") {
      if (entry.priority < 4) {
        violations.push(`TIER2_CLASSIFICATION_ON_LAUNCH_PRIORITY:${entry.missing_path}`);
      }
      continue;
    }

    if (entry.authoritative_commands.length === 0) {
      violations.push(`NON_TIER2_ENTRY_MISSING_COMMANDS:${entry.missing_path}`);
    }

    let hasRealWorkerdCommand = false;
    let hasChromiumBrowserCommand = false;
    for (const command of entry.authoritative_commands) {
      if (command.cmd.trim().length === 0 || command.referenced_files.length === 0) {
        violations.push(`EMPTY_MAPPED_COMMAND:${entry.missing_path}`);
      }
      if (command.proof_level === "workerd-real-bindings") {
        hasRealWorkerdCommand = true;
        if (!command.referenced_files.some((f) => REAL_WORKERD_ENTRYPOINT_RE.test(f))) {
          violations.push(`WORKERD_PROOF_LEVEL_UNSUPPORTED_BY_FILES:${entry.missing_path}`);
        }
      }
      if (command.proof_level === "chromium-browser") {
        hasChromiumBrowserCommand = true;
        if (!command.referenced_files.some((f) => REAL_BROWSER_ENTRYPOINT_RE.test(f))) {
          violations.push(`BROWSER_PROOF_LEVEL_UNSUPPORTED_BY_FILES:${entry.missing_path}`);
        }
      }
      for (const file of command.referenced_files) {
        if (!existsSync(resolve(opts.repoRoot, file))) {
          violations.push(`MAPPED_COMMAND_FILE_MISSING:${entry.missing_path}:${file}`);
        }
        const laneMatch = REAL_BINDINGS_LANE_RE.exec(file);
        if (laneMatch?.[1] && !opts.registeredRealLanes.has(laneMatch[1])) {
          violations.push(`MAPPED_REAL_LANE_UNREGISTERED:${entry.missing_path}:${laneMatch[1]}`);
        }
      }
    }

    if (entry.classification === "reconciled-workerd-real-bindings" && !hasRealWorkerdCommand) {
      violations.push(`WORKERD_MAPPING_LACKS_REAL_BINDINGS_COMMAND:${entry.missing_path}`);
    }
    if (entry.classification === "reconciled-browser-real-lane") {
      if (!hasChromiumBrowserCommand) {
        violations.push(`BROWSER_MAPPING_LACKS_CHROMIUM_COMMAND:${entry.missing_path}`);
      }
      if (!entry.prerequisites.some((p) => /Chromium|ASIMPOSIUM_CHROMIUM_EXECUTABLE/i.test(p))) {
        violations.push(`BROWSER_MAPPING_MISSING_CHROMIUM_PREREQUISITE:${entry.missing_path}`);
      }
    }
  }

  if (opts.trackerMissingPaths) {
    for (const t of opts.trackerMissingPaths) {
      const key = `${t.missing_path}::${t.bead_id}`;
      if (!seenKeys.has(key)) {
        violations.push(`UNMAPPED_MISSING_ACCEPTANCE_PATH:${key}`);
      }
    }
  }
  if (opts.allBeadReferencedPaths) {
    for (const key of seenKeys) {
      if (!opts.allBeadReferencedPaths.has(key)) {
        violations.push(`GHOST_MAP_ENTRY_UNKNOWN_IN_BEADS:${key}`);
      }
    }
  }

  return violations;
}

describe("Unfinished acceptance-command reconciliation map (asimposiumorg-9lqv)", () => {
  const map = JSON.parse(readFileSync(MAP_PATH, "utf8")) as AcceptanceCommandMap;
  const registeredRealLanes = loadRegisteredRealLanes();

  test("POSITIVE: every absent scripts/* acceptance path across unfinished beads is mapped to live registered commands or explicit Tier-2/hosted blockers", () => {
    const tracker = existsSync(BEADS_JSONL_PATH)
      ? loadTrackerAcceptanceIndex(REPO_ROOT)
      : undefined;
    const violations = validateAcceptanceCommandMap(map, {
      repoRoot: REPO_ROOT,
      registeredRealLanes,
      trackerMissingPaths: tracker?.openMissingPaths,
      allBeadReferencedPaths: tracker?.allBeadReferencedPaths,
    });
    expect(violations).toEqual([]);
    expect(map.entries.length).toBeGreaterThanOrEqual(30);
    // Verify Tier 2 P4 entries are explicitly separated from launch-critical work.
    const tier2 = map.entries.filter((e) => e.classification === "tier-2-deferred");
    expect(tier2.length).toBe(6);
    expect(tier2.every((e) => e.priority === 4)).toBe(true);
  });

  test("SHOULD-FAIL CONTROL 1: unmapped missing scripts/* acceptance path blocks closure", () => {
    const tracker = loadTrackerAcceptanceIndex(REPO_ROOT);
    const violations = validateAcceptanceCommandMap(map, {
      repoRoot: REPO_ROOT,
      registeredRealLanes,
      trackerMissingPaths: [
        ...tracker.openMissingPaths,
        { missing_path: "scripts/e2e-planted-missing.sh", bead_id: "asimposiumorg-planted" },
      ],
    });
    expect(violations).toContain(
      "UNMAPPED_MISSING_ACCEPTANCE_PATH:scripts/e2e-planted-missing.sh::asimposiumorg-planted",
    );
  });

  test("SHOULD-FAIL CONTROL 2: mapped command referencing a missing file fails closed", () => {
    const poisoned: AcceptanceCommandMap = {
      ...map,
      entries: map.entries.map((entry, idx) =>
        idx === 0
          ? {
              ...entry,
              authoritative_commands: [
                {
                  cmd: "node apps/wire/test/integration/nonexistent-planted-real-bindings.mjs",
                  referenced_files: [
                    "apps/wire/test/integration/nonexistent-planted-real-bindings.mjs",
                  ],
                  proof_level: "workerd-real-bindings",
                },
              ],
            }
          : entry,
      ),
    };
    const violations = validateAcceptanceCommandMap(poisoned, {
      repoRoot: REPO_ROOT,
      registeredRealLanes,
    });
    expect(violations.some((v) => v.startsWith("MAPPED_COMMAND_FILE_MISSING:"))).toBe(true);
    expect(violations.some((v) => v.startsWith("MAPPED_REAL_LANE_UNREGISTERED:"))).toBe(true);
  });

  test("SHOULD-FAIL CONTROL 3: unit-only command masquerading as reconciled-workerd-real-bindings fails closed", () => {
    const poisoned: AcceptanceCommandMap = {
      ...map,
      entries: map.entries.map((entry) =>
        entry.missing_path === "scripts/e2e-rate-limits.sh"
          ? {
              ...entry,
              authoritative_commands: [
                {
                  cmd: "bun test apps/wire/test/unit/stats.test.ts",
                  referenced_files: ["apps/wire/test/unit/stats.test.ts"],
                  proof_level: "unit-audit",
                },
              ],
            }
          : entry,
      ),
    };
    const violations = validateAcceptanceCommandMap(poisoned, {
      repoRoot: REPO_ROOT,
      registeredRealLanes,
    });
    expect(violations).toContain(
      "WORKERD_MAPPING_LACKS_REAL_BINDINGS_COMMAND:scripts/e2e-rate-limits.sh",
    );
  });

  test("SHOULD-FAIL CONTROL 4: omitting Chromium prerequisite on a browser-reconciled entry fails closed", () => {
    const poisoned: AcceptanceCommandMap = {
      ...map,
      entries: map.entries.map((entry) =>
        entry.missing_path === "scripts/e2e-problem-page.sh"
          ? { ...entry, prerequisites: ["Genuine Node >=22 only"] }
          : entry,
      ),
    };
    const violations = validateAcceptanceCommandMap(poisoned, {
      repoRoot: REPO_ROOT,
      registeredRealLanes,
    });
    expect(violations).toContain(
      "BROWSER_MAPPING_MISSING_CHROMIUM_PREREQUISITE:scripts/e2e-problem-page.sh",
    );
  });

  test("SHOULD-FAIL CONTROL 5: unit test mislabelled proof_level=workerd-real-bindings fails closed", () => {
    const poisoned: AcceptanceCommandMap = {
      ...map,
      entries: map.entries.map((entry) =>
        entry.missing_path === "scripts/e2e-rate-limits.sh"
          ? {
              ...entry,
              authoritative_commands: [
                {
                  cmd: "bun test apps/wire/test/unit/stats.test.ts",
                  referenced_files: ["apps/wire/test/unit/stats.test.ts"],
                  proof_level: "workerd-real-bindings",
                },
              ],
            }
          : entry,
      ),
    };
    const violations = validateAcceptanceCommandMap(poisoned, {
      repoRoot: REPO_ROOT,
      registeredRealLanes,
    });
    expect(violations).toContain(
      "WORKERD_PROOF_LEVEL_UNSUPPORTED_BY_FILES:scripts/e2e-rate-limits.sh",
    );
  });
});
