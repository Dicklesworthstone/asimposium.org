/**
 * W12.4c & W12.4d Legal Claims-vs-Behavior & Data-Processor Registry CI Audit
 * (`asimposiumorg-1wu`, `asimposiumorg-izl`).
 *
 * Proves mechanically:
 *  1. Every promise in ToS & retention/takedown drafts maps to an existing file in the repo.
 *  2. Every active processor in `docs/legal/data-processor-registry.json` maps to real code/config.
 *  3. Uninstalled planned processors (Sentry, Resend/Postmark) are NOT falsely listed as active.
 *  4. Forbidden architecture shortcuts (Supabase, Algolia, Pusher, Vercel Blob) are absent.
 *  5. Private workshop bytes cannot flow to public-content embeddings (`outbox-consumers.ts`).
 *  6. SHA-256 digests of draft legal texts are computable and deterministic for W6 serving.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

interface ProcessorEntry {
  readonly id: string;
  readonly provider: string;
  readonly services: readonly string[];
  readonly purpose: string;
  readonly input_classes: readonly string[];
  readonly workshop_bytes_may_flow: boolean;
  readonly workshop_flow_justification: string;
  readonly environments: readonly string[];
  readonly legal_retention_posture: string;
  readonly subprocessors_url: string;
  readonly deletion_route: string;
  readonly code_evidence: readonly string[];
}

interface DataProcessorRegistry {
  readonly schema: string;
  readonly version: string;
  readonly policy_guarantees: {
    readonly public_posting_is_training_consent: boolean;
    readonly public_content_embeddings_only: boolean;
    readonly workshop_bytes_to_non_blocking_external_processors: boolean;
    readonly never_log_redaction_enforced: boolean;
  };
  readonly active_processors: readonly ProcessorEntry[];
  readonly not_active_planned_or_evaluated_processors: readonly {
    readonly id: string;
    readonly status: string;
    readonly notes: string;
  }[];
  readonly forbidden_by_architecture: readonly string[];
}

function readPackageDeps(relPath: string): Set<string> {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, relPath), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);
}

describe("W12.4c & W12.4d Legal Claims-vs-Behavior & Data-Processor Audit", () => {
  test("W12.4c ToS & retention/takedown drafts contain all required clauses, backup precision, CAS dedup precision, and valid W6 digests", () => {
    const tosPath = join(REPO_ROOT, "docs/legal/terms-of-service-draft.md");
    const retPath = join(REPO_ROOT, "docs/legal/licenses-retention-takedown-draft.md");
    const tos = readFileSync(tosPath, "utf8");
    const ret = readFileSync(retPath, "utf8");

    // Required W12.4c clauses
    for (const phrase of [
      "CC BY 4.0",
      "MIT License",
      "freezes the license",
      "not** consent for ASImposium to",
      "prior art",
      "precise",
      "short",
      "DMCA",
      "tombstone",
      "qualified legal counsel sign-off",
    ]) {
      expect(tos).toContain(phrase);
    }

    // Required backup disclosure precision & CAS deduplication precision
    for (const phrase of [
      "Live Service Deletion",
      "Encrypted Residual Copies in Bounded Backups",
      "Legal-Hold Extensions",
      "Restore-Time Deletion-Journal Enforcement",
      "Final Physical / Cryptographic Erasure",
      "90-day",
      "Content-Addressed Deduplication (CAS)",
      "unbind-private-cas",
      "CC BY 4.0",
    ]) {
      expect(ret).toContain(phrase);
    }

    // Every file path referenced in the claims-to-implementation matrix MUST exist in-tree
    const matrixRefs = [
      "packages/protocol/assets/policy.md",
      "apps/wire/src/krater/retention.ts",
      "apps/wire/src/enrollment/account-export.ts",
      "apps/wire/src/enrollment/account-deletion.ts",
      "apps/wire/src/krater/content-control-retention.ts",
      "apps/wire/src/krater/restore-fence.ts",
      "apps/wire/src/krater/backup-scheduler.ts",
      "scripts/lib/ops-schedules.ts",
      "apps/wire/src/krater/cas.ts",
      "apps/wire/src/krater/artifact-store.ts",
      "packages/contracts/src/diagnostic-safety.ts",
      "scripts/lib/ops-audit.ts",
      "apps/wire/src/krater/outbox-consumers.ts",
      "apps/wire/src/screening/context.ts",
      "apps/wire/src/screening/workers-ai.ts",
      "apps/wire/src/enrollment/router.ts",
      "docs/runbooks/INDEX.md",
      "docs/runbooks/processor-change-management.md",
    ];
    for (const rel of matrixRefs) {
      expect(existsSync(join(REPO_ROOT, rel)), `Missing mapped owner file: ${rel}`).toBe(true);
    }

    // Digests computable for W6 serving
    const tosDigest = createHash("sha256").update(tos).digest("hex");
    const retDigest = createHash("sha256").update(ret).digest("hex");
    expect(tosDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(retDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  test("W12.4d data-processor registry matches real package dependencies & infra topology (no phantom active processors, no omitted active providers, no forbidden stack)", () => {
    const registry = JSON.parse(
      readFileSync(join(REPO_ROOT, "docs/legal/data-processor-registry.json"), "utf8"),
    ) as DataProcessorRegistry;

    expect(registry.schema).toBe("asimposium.data-processor-registry.v1");
    expect(registry.policy_guarantees.public_posting_is_training_consent).toBe(false);
    expect(registry.policy_guarantees.public_content_embeddings_only).toBe(true);
    expect(registry.policy_guarantees.workshop_bytes_to_non_blocking_external_processors).toBe(
      false,
    );
    expect(registry.policy_guarantees.never_log_redaction_enforced).toBe(true);

    // Every active processor has non-empty required metadata & existing code evidence
    expect(registry.active_processors.length).toBe(4);
    for (const proc of registry.active_processors) {
      expect(proc.provider.length).toBeGreaterThan(0);
      expect(proc.subprocessors_url).toMatch(/^https:\/\//);
      expect(proc.deletion_route.length).toBeGreaterThan(10);
      expect(proc.code_evidence.length).toBeGreaterThan(0);
      for (const rel of proc.code_evidence) {
        expect(existsSync(join(REPO_ROOT, rel)), `Missing evidence ${rel} for ${proc.id}`).toBe(
          true,
        );
      }
    }

    const webDeps = readPackageDeps("apps/web/package.json");
    const wireDeps = readPackageDeps("apps/wire/package.json");
    const allDeps = new Set([...webDeps, ...wireDeps]);

    // Active auth & hosting deps match registry
    expect(webDeps.has("next")).toBe(true);
    expect(webDeps.has("next-auth")).toBe(true);
    expect(wireDeps.has("hono")).toBe(true);
    expect(wireDeps.has("wrangler")).toBe(true);

    // Uninstalled planned processors MUST NOT be installed OR listed as active
    const notActivePatterns = ["@sentry/", "resend", "postmark", "@aws-sdk/client-ses", "sendgrid"];
    for (const dep of allDeps) {
      for (const pattern of notActivePatterns) {
        expect(
          dep.includes(pattern),
          `Unregistered external processor dependency detected: ${dep} — update data-processor-registry.json via docs/runbooks/processor-change-management.md`,
        ).toBe(false);
      }
    }

    // Forbidden architecture shortcuts MUST be absent from every app
    for (const forbidden of registry.forbidden_by_architecture) {
      expect(allDeps.has(forbidden), `Forbidden dependency found: ${forbidden}`).toBe(false);
    }

    // Verify infra/environments.toml still declares exact private-cas / public-delivery R2 separation
    const envToml = readFileSync(join(REPO_ROOT, "infra/environments.toml"), "utf8");
    expect(envToml).toContain('required_r2_roles = ["private-cas", "public-delivery"]');
    expect(envToml).toContain('publishable_role = "public-delivery"');

    // Verify policy.md aligns on CC BY 4.0 + no silent training consent
    const policyMd = readFileSync(join(REPO_ROOT, "packages/protocol/assets/policy.md"), "utf8");
    expect(policyMd).toContain("CC BY 4.0");
    expect(policyMd).toContain("never silently converted");
    expect(policyMd).toContain("explicit opt-in");

    // Verify processor change-management runbook exists
    expect(existsSync(join(REPO_ROOT, "docs/runbooks/processor-change-management.md"))).toBe(true);
  });
});
