#!/usr/bin/env bun
/**
 * W12.8 Honest Launch-Gate Scorecard (G1 / G2 / G3) & G1 Alpha-Cohort Validator
 * (`asimposiumorg-oot`, Fable §17).
 *
 * Build-program honesty (binding):
 *  - Every gate item is either a verified local/real-Workerd artifact on disk OR an
 *    explicitly marked `blocked-hosted-or-operator` prerequisite.
 *  - Local green NEVER satisfies a hosted staging, live OAuth, legal counsel, or
 *    personal operator gate.
 *  - Running `--gate g1|g2|g3` exits 78 (`LAUNCH_GATE_BLOCKED`) whenever any
 *    required prerequisite remains unverified.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createS4Corpus, inspectS4ManifestReadiness } from "../e2e/screening/s4-corpus.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

export type LaunchGateId = "G1" | "G2" | "G3";

export type GateCheckStatus =
  | "local-proof-present"
  | "blocked-operator-or-hosted"
  | "pending-post-launch-window";

export interface LaunchGateCriterion {
  readonly id: string;
  readonly gate: LaunchGateId;
  readonly name: string;
  readonly bead_id: string;
  readonly required_local_artifacts: readonly string[];
  readonly hosted_or_human_requirement: string;
  readonly status: GateCheckStatus;
}

export type Oq1Decision =
  | "undecided-pending-g1-dogfood-signal"
  | "permissionless-at-g2"
  | "invite-allowlist-first-month";

export type AlphaCohortRole =
  | "formal-methods"
  | "math-engineer"
  | "adversarial-security"
  | "generalist";

export interface AlphaParticipant {
  readonly sponsor_id: string;
  readonly problem_ids: readonly string[];
  readonly role: AlphaCohortRole;
}

export interface AlphaCohortValidationResult {
  readonly valid: boolean;
  readonly violations: readonly string[];
  readonly distinct_sponsors: number;
  readonly roles_present: readonly AlphaCohortRole[];
}

/**
 * Enforce W12.8 G1 alpha-cohort composition:
 *  - Multiple distinct sponsors (>= 2) per active alpha problem (cross-sponsor
 *    identity & review independence are core product hypotheses).
 *  - Must include formal-methods, math-engineer, and adversarial-security reviewers.
 */
export function validateG1AlphaCohort(
  participants: readonly AlphaParticipant[],
): AlphaCohortValidationResult {
  const violations: string[] = [];
  const sponsors = new Set(participants.map((p) => p.sponsor_id));
  const roles = new Set(participants.map((p) => p.role));

  if (sponsors.size < 2) {
    violations.push("G1_COHORT_SINGLE_SPONSOR: alpha requires >= 2 distinct sponsors");
  }

  const requiredRoles: readonly AlphaCohortRole[] = [
    "formal-methods",
    "math-engineer",
    "adversarial-security",
  ];
  for (const role of requiredRoles) {
    if (!roles.has(role)) {
      violations.push(`G1_COHORT_MISSING_ROLE:${role}`);
    }
  }

  // Every active alpha problem must have >= 2 distinct sponsors assigned so
  // cross-sponsor review independence is actually tested.
  const sponsorsPerProblem = new Map<string, Set<string>>();
  for (const p of participants) {
    for (const prob of p.problem_ids) {
      let set = sponsorsPerProblem.get(prob);
      if (!set) {
        set = new Set();
        sponsorsPerProblem.set(prob, set);
      }
      set.add(p.sponsor_id);
    }
  }
  if (sponsorsPerProblem.size === 0) {
    violations.push("G1_COHORT_NO_PROBLEMS_ASSIGNED");
  }
  for (const [problemId, problemSponsors] of sponsorsPerProblem.entries()) {
    if (problemSponsors.size < 2) {
      violations.push(
        `G1_COHORT_PROBLEM_SINGLE_SPONSOR:${problemId} has only ${problemSponsors.size} sponsor`,
      );
    }
  }

  return {
    valid: violations.length === 0,
    violations,
    distinct_sponsors: sponsors.size,
    roles_present: [...roles].sort() as AlphaCohortRole[],
  };
}

export const LAUNCH_GATE_CRITERIA: readonly LaunchGateCriterion[] = [
  // G1 — Private Alpha
  {
    id: "G1-GAUNTLET",
    gate: "G1",
    name: "Cold-Agent Gauntlet >= 8/10 across >= 3 harnesses (median <= 25K tokens)",
    bead_id: "asimposiumorg-zai",
    required_local_artifacts: ["e2e/gauntlet/run.sh", "scripts/ceremony-trend-check.ts"],
    hosted_or_human_requirement:
      "Execute 10 fresh sessions across >= 3 harnesses on reconciled staging (blocked on rs5n).",
    status: "blocked-operator-or-hosted",
  },
  {
    id: "G1-PROTOCOL-FIXTURES",
    gate: "G1",
    name: "Protocol fixture table (P1-P13), state machine, epistemic controls, and auth race matrix green",
    bead_id: "asimposiumorg-phs",
    required_local_artifacts: [
      "e2e/protocol-table/protocol-table.test.ts",
      "e2e/epistemic-corpus/epistemic-corpus.test.ts",
      "apps/wire/test/integration/auth-race-matrix-real-bindings.mjs",
    ],
    hosted_or_human_requirement: "Independent peer review & closure at exact release revision.",
    status: "local-proof-present",
  },
  {
    id: "G1-DOGFOOD-BOARD",
    gate: "G1",
    name: "Staging Problem #1 dogfood board worked through real join capsule (no side channels) & OQ-1 decided",
    bead_id: "asimposiumorg-8ku",
    required_local_artifacts: ["docs/seed/the-instrument-meta-problem.json"],
    hosted_or_human_requirement:
      "Live staging dogfooding by multi-sponsor alpha cohort; record OQ-1 decision.",
    status: "blocked-operator-or-hosted",
  },
  {
    id: "G1-BACKUP-RESTORE-DRILL",
    gate: "G1",
    name: "Backup/restore-to-scratch drilled with signed deletion-journal replay",
    bead_id: "asimposiumorg-zr9",
    required_local_artifacts: [
      "scripts/ops-backup-restore-smoke.ts",
      "scripts/ops-schedules.test.ts",
      "scripts/e2e-ops-schedules.sh",
    ],
    hosted_or_human_requirement: "Execute isolated staging restore drill post-rs5n.",
    status: "blocked-operator-or-hosted",
  },

  // G2 — Public Launch
  {
    id: "G2-RED-TEAM",
    gate: "G2",
    name: "5-pass red team closed (ACIP injection A/B, moderation FN=0, ADR-18 oracle, economics, auth)",
    bead_id: "asimposiumorg-ip3",
    required_local_artifacts: [
      "e2e/red-team/red-team.test.ts",
      "e2e/red-team/injection-corpus.json",
      "e2e/red-team/run-inoculation-ab.ts",
    ],
    hosted_or_human_requirement:
      "Run live LLM inoculation A/B probe & live staging policy oracle checks.",
    status: "blocked-operator-or-hosted",
  },
  {
    id: "G2-SCREENING-CORPUS",
    gate: "G2",
    name: "S-4 screening corpus holds (FN=0 on hard-reject incl. sealed Tier-B, FP < 5% on legit weird math)",
    bead_id: "asimposiumorg-rc-populate-s4-corpus-c743",
    required_local_artifacts: [
      "e2e/screening/s4-corpus.ts",
      "e2e/screening/s4-sealed-loader.ts",
      "docs/runbooks/s4-sealed-corpus.md",
    ],
    hosted_or_human_requirement:
      "Run full 200-entry corpus with operator-held sealed Tier-B file against live Workers AI.",
    status: "blocked-operator-or-hosted",
  },
  {
    id: "G2-IP-AND-LEGAL",
    gate: "G2",
    name: "Personal operator IP diff-review (R-12) + prose audit + counsel-reviewed ToS & processor registry",
    bead_id: "asimposiumorg-31w",
    required_local_artifacts: [
      "scripts/ip-and-slop-audit.test.ts",
      "docs/ip-diff-review-prep-2026-11-21.md",
      "docs/legal/terms-of-service-draft.md",
      "docs/legal/data-processor-registry.json",
      "scripts/legal-claims-audit.test.ts",
    ],
    hosted_or_human_requirement:
      "Personal operator sign-off on all 7 served texts + qualified legal counsel review + DMCA agent.",
    status: "blocked-operator-or-hosted",
  },
  {
    id: "G2-DNS-VERCEL-SEEDS",
    gate: "G2",
    name: "ADR-2 DNS cutover, Vercel plan decided (R-9), apex /install.sh + 308s, SP4D flagship & rungs 1-5 live",
    bead_id: "asimposiumorg-mmo",
    required_local_artifacts: [
      "scripts/w12-7-dns-cutover-gate.test.ts",
      "docs/ops/w12-7-dns-cutover-and-vercel-plan.md",
      "docs/seed/sp4d/SP4D.md",
      "docs/seed/rungs-1-5/manifest.json",
      "apps/web/public/install.sh",
    ],
    hosted_or_human_requirement:
      "Production DNS cutover, live staging/prod OG render verification, and public join URL launch.",
    status: "blocked-operator-or-hosted",
  },

  // G3 — +30 Days Post-Launch Review
  {
    id: "G3-30D-REVIEW",
    gate: "G3",
    name: "+30d review: multi-sponsor verified scientific outcomes, cost model vs actual bill, R-22 ceremony trend",
    bead_id: "asimposiumorg-oot",
    required_local_artifacts: [
      "e2e/load-degradation/cost-attribution.ts",
      "scripts/verify-cost-model.ts",
      "scripts/ceremony-trend-check.ts",
    ],
    hosted_or_human_requirement: "30 days of live production telemetry and cost/ceremony review.",
    status: "pending-post-launch-window",
  },
];

export interface LiveCheckOutcome {
  readonly id: string;
  readonly pass: boolean;
  readonly detail: string;
}

export interface GateEvaluationReport {
  readonly schema: "asimposium.launch-gates-scorecard.v1";
  readonly evaluated_at: string;
  readonly gate: LaunchGateId;
  readonly oq1_decision: Oq1Decision;
  readonly ready_to_open_gate: boolean;
  readonly missing_local_artifacts: readonly string[];
  readonly live_checks: readonly LiveCheckOutcome[];
  readonly failed_live_checks: readonly string[];
  readonly open_hosted_or_operator_blockers: readonly string[];
  readonly criteria: readonly LaunchGateCriterion[];
}

async function runLiveLocalChecks(gate: LaunchGateId): Promise<{
  readonly liveChecks: LiveCheckOutcome[];
  readonly dynamicBlockers: string[];
}> {
  const liveChecks: LiveCheckOutcome[] = [];
  const dynamicBlockers: string[] = [];

  if (gate === "G1") {
    const inst = verifyTheInstrumentSeed();
    liveChecks.push({
      id: "LIVE-INSTRUMENT-SEED",
      pass: inst.ok,
      detail: inst.ok
        ? "The Instrument manifest valid and all 12 defect-to-regression targets exist"
        : `Invalid Instrument manifest: ${inst.missing_regression_targets.join(", ")}`,
    });
  }

  if (gate === "G2") {
    // 1. Live R-12 rules word count check
    const proto = readFileSync(join(REPO_ROOT, "packages/protocol/assets/protocol.md"), "utf8");
    const rulesIdx = proto.indexOf("## Rules");
    const rest = rulesIdx >= 0 ? proto.slice(rulesIdx) : "";
    const nextSec = rest.indexOf("\n## ", 1);
    const rulesText = nextSec === -1 ? rest : rest.slice(0, nextSec);
    const rulesWords = rulesText.trim().split(/\s+/).filter(Boolean).length;
    liveChecks.push({
      id: "LIVE-R12-RULES-CAP",
      pass: rulesIdx >= 0 && rulesWords > 200 && rulesWords <= 1_000,
      detail: `protocol.md ## Rules word count = ${rulesWords} (ceiling 1000)`,
    });

    // 2. Live apex static copy drift check against packages/protocol/assets/*
    const pairs: readonly [string, string][] = [
      ["apps/web/public/AGENTS.md", "packages/protocol/assets/handbook.md"],
      ["apps/web/public/llms.txt", "packages/protocol/assets/llms.txt"],
      ["apps/web/public/skill.md", "packages/protocol/assets/skill.md"],
      ["apps/web/public/capsule.md", "packages/protocol/assets/capsule.md"],
      ["apps/web/public/protocol.md", "packages/protocol/assets/protocol.md"],
      ["apps/web/public/policy.md", "packages/protocol/assets/policy.md"],
      ["apps/web/public/inoculation.md", "packages/protocol/assets/inoculation.md"],
    ];
    const drifted = pairs
      .filter(
        ([apex, protoRel]) =>
          !existsSync(join(REPO_ROOT, apex)) ||
          readFileSync(join(REPO_ROOT, apex), "utf8") !==
            readFileSync(join(REPO_ROOT, protoRel), "utf8"),
      )
      .map(([apex]) => apex);
    liveChecks.push({
      id: "LIVE-APEX-STATIC-DRIFT",
      pass: drifted.length === 0,
      detail:
        drifted.length === 0
          ? "All 7 apex static copies match packages/protocol/assets/* byte-for-byte"
          : `Drifted apex copies: ${drifted.join(", ")}`,
    });

    // 3. Live S-4 split corpus readiness check (dynamically detects Tier-B unavailability)
    const corpus = await createS4Corpus();
    const readiness = inspectS4ManifestReadiness(corpus);
    liveChecks.push({
      id: "LIVE-S4-CORPUS-SHAPE",
      pass: corpus.length === 200,
      detail: `S-4 corpus loaded (${corpus.length} entries), live readiness=${readiness.status}`,
    });
    if (readiness.status !== "ready") {
      dynamicBlockers.push(`LIVE-S4-READINESS: ${readiness.blockers.join(",")}`);
    }
  }

  return { liveChecks, dynamicBlockers };
}

export async function evaluateLaunchGate(
  gate: LaunchGateId,
  oq1Decision: Oq1Decision = "undecided-pending-g1-dogfood-signal",
): Promise<GateEvaluationReport> {
  const criteria = LAUNCH_GATE_CRITERIA.filter((c) => c.gate === gate);
  const missingLocal: string[] = [];
  const openBlockers: string[] = [];

  for (const item of criteria) {
    for (const rel of item.required_local_artifacts) {
      if (!existsSync(join(REPO_ROOT, rel))) {
        missingLocal.push(`${item.id}:${rel}`);
      }
    }
    if (item.status !== "local-proof-present") {
      openBlockers.push(`${item.id}: ${item.hosted_or_human_requirement}`);
    }
  }

  const { liveChecks, dynamicBlockers } = await runLiveLocalChecks(gate);
  openBlockers.push(...dynamicBlockers);
  const failedLive = liveChecks.filter((c) => !c.pass).map((c) => `${c.id}: ${c.detail}`);

  if (gate === "G2" && oq1Decision === "undecided-pending-g1-dogfood-signal") {
    openBlockers.push("G2-OQ1: OQ-1 admission posture must be decided from G1 dogfood signal");
  }

  return {
    schema: "asimposium.launch-gates-scorecard.v1",
    evaluated_at: new Date().toISOString(),
    gate,
    oq1_decision: oq1Decision,
    ready_to_open_gate:
      missingLocal.length === 0 && failedLive.length === 0 && openBlockers.length === 0,
    missing_local_artifacts: missingLocal,
    live_checks: liveChecks,
    failed_live_checks: failedLive,
    open_hosted_or_operator_blockers: openBlockers,
    criteria,
  };
}

export function verifyTheInstrumentSeed(): {
  readonly ok: boolean;
  readonly missing_regression_targets: readonly string[];
} {
  const raw = readFileSync(join(REPO_ROOT, "docs/seed/the-instrument-meta-problem.json"), "utf8");
  const parsed = JSON.parse(raw) as {
    writer_cap: unknown;
    amendment_invariants: {
      records_protocol_policy_digest_per_session: boolean;
      retroactive_rejudgement_forbidden: boolean;
    };
    defect_to_regression_routing: readonly {
      permanent_regression_owner: string;
      secondary_gate: string;
    }[];
  };
  const missing: string[] = [];
  if (parsed.writer_cap !== null) missing.push("WRITER_CAP_MUST_BE_NULL");
  if (!parsed.amendment_invariants.records_protocol_policy_digest_per_session) {
    missing.push("DIGEST_RECORDING_REQUIRED");
  }
  if (!parsed.amendment_invariants.retroactive_rejudgement_forbidden) {
    missing.push("NON_RETROACTIVE_RULE_REQUIRED");
  }
  for (const route of parsed.defect_to_regression_routing) {
    for (const p of [route.permanent_regression_owner, route.secondary_gate]) {
      if (!existsSync(join(REPO_ROOT, p))) missing.push(p);
    }
  }
  return { ok: missing.length === 0, missing_regression_targets: missing };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let gate: LaunchGateId = "G1";
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--gate") {
      const val = (argv[++i] ?? "").toUpperCase();
      if (val === "G1" || val === "G2" || val === "G3") gate = val;
      else {
        console.error("Usage: bun scripts/launch-gates-scorecard.ts --gate G1|G2|G3");
        process.exit(2);
      }
    }
  }
  const report = await evaluateLaunchGate(gate);
  console.log(JSON.stringify(report, null, 2));
  if (report.missing_local_artifacts.length > 0 || report.failed_live_checks.length > 0) {
    process.exit(1);
  }
  if (!report.ready_to_open_gate) process.exit(78);
}

if (import.meta.main) {
  await main();
}
