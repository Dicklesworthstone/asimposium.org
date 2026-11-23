/**
 * CI validation gate for `asimposiumorg-1zm`: Deferred Decisions Ledger
 * (OQ-2, OQ-4, OQ-5, OQ-6, OQ-7, OQ-8, OQ-10 plus full Fable Rev 3.1 OQ-1..OQ-13).
 *
 * Verifies:
 *  - Every deferred OQ has default_at_launch, owner, measurable_reopen_trigger,
 *    evidence_location (resolving to a real repo path), decision_dependency,
 *    and explicit forbidden_premature_implementation.
 *  - Every referenced ADR exists in `COMPREHENSIVE_PLAN_FOR_ASIMPOSIUM_SITE_FABLE.md`.
 *  - Every referenced bead ID exists in `.beads/issues.jsonl`.
 *  - `docs/deferred-decisions-ledger.md` mirrors every OQ ID cleanly.
 *  - Dated review report validator enforces complete provenance and zero secrets/private data.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { containsNeverLogMaterial } from "./lib/ops-audit.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

interface DeferredDecisionEntry {
  readonly id: string;
  readonly title: string;
  readonly status: "deferred";
  readonly default_at_launch: string;
  readonly owner: string;
  readonly measurable_reopen_trigger: string;
  readonly evidence_location: string;
  readonly decision_dependency: string;
  readonly forbidden_premature_implementation: string;
  readonly referenced_adrs: readonly string[];
  readonly referenced_beads: readonly string[];
  readonly fable_anchor: string;
}

interface DeferredDecisionsLedger {
  readonly schema: "asimposium.deferred-decisions-ledger.v1";
  readonly source_of_truth: string;
  readonly source_revision: string;
  readonly bead_id: string;
  readonly policy: {
    readonly batch_closure_forbidden: boolean;
    readonly split_on_trigger_rule: string;
    readonly review_report_schema: string;
    readonly required_review_report_fields: readonly string[];
  };
  readonly decisions: readonly DeferredDecisionEntry[];
}

export interface DeferredDecisionReviewReport {
  readonly schema: "asimposium.deferred-decision-review.v1";
  readonly reviewed_at: string;
  readonly revision: string;
  readonly oq_id: string;
  readonly trigger_observation: string;
  readonly source_digest: string;
  readonly reviewer: string;
  readonly decision: "unchanged" | "split-to-bead" | "retired";
  readonly rationale: string;
  readonly next_review_point: string;
}

const STRICT_UTC_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export function validateDeferredDecisionReviewReport(
  report: unknown,
  knownOqs: ReadonlySet<string>,
): { readonly ok: boolean; readonly errors: readonly string[] } {
  const errors: string[] = [];
  if (report === null || typeof report !== "object" || Array.isArray(report)) {
    return { ok: false, errors: ["REPORT_NOT_OBJECT"] };
  }
  const r = report as Partial<DeferredDecisionReviewReport>;
  if (r.schema !== "asimposium.deferred-decision-review.v1") errors.push("INVALID_SCHEMA");
  if (
    !r.reviewed_at ||
    !STRICT_UTC_ISO_RE.test(r.reviewed_at) ||
    Number.isNaN(Date.parse(r.reviewed_at))
  ) {
    errors.push("INVALID_REVIEWED_AT");
  }
  if (!r.revision || !/^[0-9a-f]{7,40}$/i.test(r.revision)) errors.push("INVALID_REVISION");
  if (!r.oq_id || !knownOqs.has(r.oq_id)) errors.push("UNKNOWN_OQ_ID");
  if (!r.trigger_observation || r.trigger_observation.trim().length < 10) {
    errors.push("MISSING_TRIGGER_OBSERVATION");
  }
  if (!r.source_digest || !/^[0-9a-f]{64}$/i.test(r.source_digest)) {
    errors.push("INVALID_SOURCE_DIGEST");
  }
  if (!r.reviewer || r.reviewer.trim().length < 2) errors.push("MISSING_REVIEWER");
  if (!r.decision || !["unchanged", "split-to-bead", "retired"].includes(r.decision)) {
    errors.push("INVALID_DECISION");
  }
  if (!r.rationale || r.rationale.trim().length < 10) errors.push("MISSING_RATIONALE");
  if (!r.next_review_point || r.next_review_point.trim().length < 5) {
    errors.push("MISSING_NEXT_REVIEW_POINT");
  }
  if (containsNeverLogMaterial(JSON.stringify(report))) {
    errors.push("NEVER_LOG_MATERIAL_IN_REVIEW_REPORT");
  }
  return { ok: errors.length === 0, errors };
}

describe("Deferred Decisions Ledger CI Gate (asimposiumorg-1zm, Fable Rev 3.1 OQ-1..OQ-13)", () => {
  const ledgerPath = join(REPO_ROOT, "docs/deferred-decisions-ledger.json");
  const mdPath = join(REPO_ROOT, "docs/deferred-decisions-ledger.md");
  const fablePath = join(REPO_ROOT, "COMPREHENSIVE_PLAN_FOR_ASIMPOSIUM_SITE_FABLE.md");
  const beadsPath = join(REPO_ROOT, ".beads/issues.jsonl");

  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as DeferredDecisionsLedger;
  const mdText = readFileSync(mdPath, "utf8");
  const fableText = readFileSync(fablePath, "utf8");
  const beadIds = new Set(
    readFileSync(beadsPath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => (JSON.parse(line) as { id?: string }).id)
      .filter((id): id is string => typeof id === "string"),
  );

  test("contains all required Fable OQs (OQ-2/4/5/6/7/8/10 + full OQ-1..13) with complete schema, real evidence paths, and valid ADR/bead links", () => {
    expect(ledger.schema).toBe("asimposium.deferred-decisions-ledger.v1");
    expect(ledger.source_revision).toBe("3.1");
    expect(ledger.policy.batch_closure_forbidden).toBe(true);
    expect(containsNeverLogMaterial(readFileSync(ledgerPath, "utf8"))).toBe(false);
    expect(containsNeverLogMaterial(mdText)).toBe(false);

    const ids = new Set(ledger.decisions.map((d) => d.id));
    expect(ids.size).toBe(ledger.decisions.length);

    for (const requiredOq of ["OQ-2", "OQ-4", "OQ-5", "OQ-6", "OQ-7", "OQ-8", "OQ-10"]) {
      expect(ids.has(requiredOq), `missing required ${requiredOq}`).toBe(true);
    }

    for (const entry of ledger.decisions) {
      expect(entry.status).toBe("deferred");
      expect(entry.default_at_launch.trim().length).toBeGreaterThan(10);
      expect(entry.owner.trim().length).toBeGreaterThan(2);
      expect(entry.measurable_reopen_trigger.trim().length).toBeGreaterThan(15);
      expect(entry.decision_dependency.trim().length).toBeGreaterThan(5);
      expect(entry.forbidden_premature_implementation.trim().length).toBeGreaterThan(15);
      expect(
        existsSync(join(REPO_ROOT, entry.evidence_location)),
        `${entry.id} evidence_location missing: ${entry.evidence_location}`,
      ).toBe(true);
      expect(mdText).toContain(`**${entry.id}**`);

      // Verify every referenced ADR exists in Fable.
      expect(entry.referenced_adrs.length).toBeGreaterThanOrEqual(1);
      for (const adr of entry.referenced_adrs) {
        expect(fableText, `${entry.id} references unknown ${adr}`).toContain(`**${adr}**`);
      }

      // Verify every referenced bead exists in .beads/issues.jsonl.
      expect(entry.referenced_beads.length).toBeGreaterThanOrEqual(1);
      for (const bead of entry.referenced_beads) {
        expect(beadIds.has(bead), `${entry.id} references unknown bead ${bead}`).toBe(true);
      }
    }
  });

  test("dated review report validator accepts clean reports and refuses missing fields or leaked secrets", () => {
    const knownOqs = new Set(ledger.decisions.map((d) => d.id));
    const clean = validateDeferredDecisionReviewReport(
      {
        schema: "asimposium.deferred-decision-review.v1",
        reviewed_at: "2026-11-22T05:30:00.000Z",
        revision: "ee310d5b",
        oq_id: "OQ-2",
        trigger_observation: "Pre-launch check; G3 +30d window not yet entered.",
        source_digest: "a".repeat(64),
        reviewer: "OrangeBarn",
        decision: "unchanged",
        rationale: "Emergent synthesis default stands until G3 staleness telemetry is observed.",
        next_review_point: "G3 +30 days post-launch",
      },
      knownOqs,
    );
    expect(clean.ok).toBe(true);
    expect(clean.errors).toEqual([]);

    const leaked = validateDeferredDecisionReviewReport(
      {
        schema: "asimposium.deferred-decision-review.v1",
        reviewed_at: "2026-11-22T05:30:00.000Z",
        revision: "ee310d5b",
        oq_id: "OQ-8",
        trigger_observation: `Saw token ${["asimp", "ag", "01JXYZ4K6QABCDEFGHJKMNPQRS", "X".repeat(43)].join("_")}`,
        source_digest: "b".repeat(64),
        reviewer: "OrangeBarn",
        decision: "unchanged",
        rationale: "Token leak should be refused fail-closed.",
        next_review_point: "G3",
      },
      knownOqs,
    );
    expect(leaked.ok).toBe(false);
    expect(leaked.errors).toContain("NEVER_LOG_MATERIAL_IN_REVIEW_REPORT");

    // Non-object / array / non-ISO date inputs fail closed cleanly.
    expect(validateDeferredDecisionReviewReport(null, knownOqs).errors).toContain(
      "REPORT_NOT_OBJECT",
    );
    expect(validateDeferredDecisionReviewReport([], knownOqs).errors).toContain(
      "REPORT_NOT_OBJECT",
    );
    const badDate = validateDeferredDecisionReviewReport(
      {
        schema: "asimposium.deferred-decision-review.v1",
        reviewed_at: "May 1 2026",
        revision: "ee310d5b",
        oq_id: "OQ-2",
        trigger_observation: "Checking strict ISO-8601 UTC enforcement.",
        source_digest: "c".repeat(64),
        reviewer: "OrangeBarn",
        decision: "unchanged",
        rationale: "Strict UTC timestamp required for auditability.",
        next_review_point: "G3 +30d",
      },
      knownOqs,
    );
    expect(badDate.ok).toBe(false);
    expect(badDate.errors).toContain("INVALID_REVIEWED_AT");
  });
});
