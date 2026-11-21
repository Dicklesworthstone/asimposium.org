import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CONTRACT_PROBLEM_CODES,
  ContractProblemSchema,
  OPAQUE_PROBLEM_CODES,
  OpaqueProblemSchema,
  PROBLEM_TYPE_PREFIX,
  ProblemDocumentSchema,
} from "@asimposium/contracts";
import { evaluateCeremonyTrend, extractCeremonyPoint } from "./ceremony-trend-check.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

const SLOP_AND_BOUNCER_PATTERNS: readonly { readonly label: string; readonly re: RegExp }[] = [
  { label: "ai-slop-delve", re: /\bdelve(?:s|d|ing)?\b/i },
  { label: "ai-slop-tapestry", re: /\btapestry\b/i },
  { label: "ai-slop-game-changer", re: /\bgame[- ]changer\b/i },
  { label: "ai-slop-cutting-edge", re: /\bcutting[- ]edge\b/i },
  { label: "ai-slop-seamless", re: /\bseamless(?:ly)?\b/i },
  { label: "bouncer-access-denied", re: /\baccess denied[!.]?/i },
  { label: "bouncer-illegal-operation", re: /\billegal operation\b/i },
];

const ORACLE_LEAK_FIELDS = [
  "rule",
  "schema",
  "example",
  "pattern_name",
  "matched_phrase",
  "classifier_score",
  "detector_reasoning",
] as const;

describe("W10.9 Error-copy audit, refusal voice, oracle starvation, and ceremony regression metric (asimposiumorg-m5s)", () => {
  const snapshotDoc = JSON.parse(
    readFileSync(join(REPO_ROOT, "e2e/error-copy-audit/refusal-snapshots.json"), "utf8"),
  ) as {
    schema: string;
    oracle_starved_policy_refusals: Record<string, Record<string, unknown>>;
    colleague_voice_contract_refusals: Record<string, Record<string, unknown>>;
  };

  test("error dictionary partitions strictly into disjoint contract (teaching) and opaque (oracle-starved) codes", () => {
    const contractSet = new Set<string>(CONTRACT_PROBLEM_CODES);
    const opaqueSet = new Set<string>(OPAQUE_PROBLEM_CODES);
    expect(contractSet.size).toBe(CONTRACT_PROBLEM_CODES.length);
    expect(opaqueSet.size).toBe(OPAQUE_PROBLEM_CODES.length);

    for (const code of CONTRACT_PROBLEM_CODES) {
      expect(
        opaqueSet.has(code),
        `code ${code} must not appear in both contract and opaque sets`,
      ).toBe(false);
    }
    expect(CONTRACT_PROBLEM_CODES.length + OPAQUE_PROBLEM_CODES.length).toBeGreaterThanOrEqual(37);
  });

  test("every CONTRACT_PROBLEM_CODE validates cleanly with RFC 7807 + rule + schema + example + fix_hint", () => {
    for (const code of CONTRACT_PROBLEM_CODES) {
      const base: Record<string, unknown> = {
        type: `${PROBLEM_TYPE_PREFIX}${code}`,
        title: `Contract guidance for ${code}`,
        status: code.includes("CONFLICT") || code.includes("DUPLICATE") ? 409 : 422,
        code,
        detail: `The request could not satisfy the ${code} contract requirement.`,
        fix_hint: "Adjust the request body to match the linked schema and retry.",
        rule: "A5",
        schema: "https://a.asimposium.org/schemas/sessions.v1.json",
        example: { ok: true },
      };
      if (code === "UNKNOWN_FORMAT") base.allowed = ["md", "json", "toon"];
      if (code === "UNKNOWN_PROFILE") base.allowed = ["working", "review", "digest"];
      if (code === "BINDING_MISSING") {
        base.missing = ["DB"];
        base.bindings = { DB: "missing" };
      }

      const parsed = ContractProblemSchema.safeParse(base);
      expect(parsed.success, `ContractProblemSchema failed for ${code}`).toBe(true);
      expect(ProblemDocumentSchema.safeParse(base).success).toBe(true);
    }
  });

  test("ADR-18 ORACLE STARVATION: every OPAQUE_PROBLEM_CODE strictly forbids rule, schema, example, and detector fields", () => {
    for (const code of OPAQUE_PROBLEM_CODES) {
      const clean = {
        type: `${PROBLEM_TYPE_PREFIX}${code}`,
        title: `Opaque refusal (${code})`,
        status: 403,
        code,
        detail: "This request cannot be completed under platform access or safety policy.",
        fix_hint: "Review your session standing or submit an appeal through /console.",
      };
      expect(OpaqueProblemSchema.safeParse(clean).success, `clean opaque failed for ${code}`).toBe(
        true,
      );

      // Every single oracle-leaking field MUST be rejected by strict OpaqueProblemSchema.
      for (const leakKey of ORACLE_LEAK_FIELDS) {
        const poisoned = {
          ...clean,
          [leakKey]: leakKey === "example" ? { leaked: true } : "leaked-oracle-value",
        };
        expect(
          OpaqueProblemSchema.safeParse(poisoned).success,
          `opaque code ${code} MUST reject oracle field '${leakKey}'`,
        ).toBe(false);
      }
    }
  });

  test("refusal snapshots validate strictly, enforce colleague voice, and carry zero AI slop or oracle leaks", () => {
    expect(snapshotDoc.schema).toBe("asimposium.error-copy-snapshots.v1");

    for (const [code, doc] of Object.entries(snapshotDoc.oracle_starved_policy_refusals)) {
      expect(OpaqueProblemSchema.safeParse(doc).success, `opaque snapshot ${code}`).toBe(true);
      expect(ProblemDocumentSchema.safeParse(doc).success).toBe(true);
      const prose = `${String(doc.title)} ${String(doc.detail)} ${String(doc.fix_hint)}`;
      for (const pat of SLOP_AND_BOUNCER_PATTERNS) {
        expect(pat.re.test(prose), `slop/bouncer hit ${pat.label} in opaque snapshot ${code}`).toBe(
          false,
        );
      }
    }

    for (const [code, doc] of Object.entries(snapshotDoc.colleague_voice_contract_refusals)) {
      expect(ContractProblemSchema.safeParse(doc).success, `contract snapshot ${code}`).toBe(true);
      expect(ProblemDocumentSchema.safeParse(doc).success).toBe(true);
      const prose = `${String(doc.title)} ${String(doc.detail)} ${String(doc.fix_hint)}`;
      for (const pat of SLOP_AND_BOUNCER_PATTERNS) {
        expect(
          pat.re.test(prose),
          `slop/bouncer hit ${pat.label} in contract snapshot ${code}`,
        ).toBe(false);
      }
    }

    // 409 OBJECT_VERSION_CONFLICT carries machine-readable version & suggested_action.
    const conflict = snapshotDoc.colleague_voice_contract_refusals.OBJECT_VERSION_CONFLICT;
    expect(conflict?.status).toBe(409);
    expect(conflict?.current_version).toBe(2);
    expect(conflict?.suggested_action).toBe("refetch_and_reapply");

    // UNKNOWN_FORMAT and UNKNOWN_PROFILE require allowed lists.
    expect(
      ContractProblemSchema.safeParse({
        ...snapshotDoc.colleague_voice_contract_refusals.UNKNOWN_PROFILE,
        allowed: undefined,
      }).success,
    ).toBe(false);
    expect(
      ContractProblemSchema.safeParse({
        ...snapshotDoc.colleague_voice_contract_refusals.UNKNOWN_FORMAT,
        allowed: undefined,
      }).success,
    ).toBe(false);
  });

  test("SLOP-SCRUB AUDIT: served agent protocol texts carry zero AI-slop clichés or bouncer phrasing", () => {
    const servedDocs = [
      "packages/protocol/assets/capsule.md",
      "packages/protocol/assets/handbook.md",
      "packages/protocol/assets/inoculation.md",
      "packages/protocol/assets/llms.txt",
      "packages/protocol/assets/policy.md",
      "packages/protocol/assets/protocol.md",
      "packages/protocol/assets/skill.md",
    ];
    for (const rel of servedDocs) {
      const text = readFileSync(join(REPO_ROOT, rel), "utf8");
      expect(text.trim().length).toBeGreaterThan(100);
      for (const pat of SLOP_AND_BOUNCER_PATTERNS) {
        expect(pat.re.test(text), `slop/bouncer hit ${pat.label} in ${rel}`).toBe(false);
      }
    }
  });

  test("R-22 ceremony regression metric tracks tokens-to-first-valid-post accurately and fails closed on regression", () => {
    const empty = evaluateCeremonyTrend([]);
    expect(empty.status).toBe("no-receipts");
    expect(empty.latest_tokens).toBeNull();

    const improving = evaluateCeremonyTrend([
      { run_id: "r1", recorded_at: "2026-11-10T00:00:00Z", tokens_to_first_valid_post: 24_000 },
      { run_id: "r2", recorded_at: "2026-11-21T00:00:00Z", tokens_to_first_valid_post: 18_500 },
    ]);
    expect(improving.status).toBe("within-budget");
    expect(improving.delta_tokens).toBe(-5_500);

    const regressed = evaluateCeremonyTrend([
      { run_id: "r1", recorded_at: "2026-11-10T00:00:00Z", tokens_to_first_valid_post: 12_000 },
      { run_id: "r2", recorded_at: "2026-11-21T00:00:00Z", tokens_to_first_valid_post: 16_000 },
    ]);
    expect(regressed.status).toBe("regression-detected");
    expect(regressed.delta_pct).toBeGreaterThan(15);

    const overBudget = evaluateCeremonyTrend([
      { run_id: "r3", recorded_at: "2026-11-21T00:00:00Z", tokens_to_first_valid_post: 453_529 },
    ]);
    expect(overBudget.status).toBe("over-budget");

    const extracted = extractCeremonyPoint(
      { run_id: "gauntlet-7", generated_at: "2026-11-21T00:00:00Z", median_tokens: 21_400 },
      "fallback",
    );
    expect(extracted?.tokens_to_first_valid_post).toBe(21_400);
  });
});
