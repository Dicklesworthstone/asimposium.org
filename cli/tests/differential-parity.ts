#!/usr/bin/env bun
/**
 * Cross-language differential parity harness (W11.3, asimposiumorg-psl).
 *
 * Drives the compiled Rust `asimp` binary side-by-side against the live
 * TypeScript Worker implementations:
 *   1. `asimp validate` vs `@asimposium/contracts` Zod schemas +
 *      `rejectAuthoritativeFields` (P2/P4) + P3 falsifier + `requestFieldHints`
 *      + canonical JSON SHA-256 over the golden fixture corpus.
 *   2. `asimp scrub` vs `apps/wire/src/screening/credential-scan.ts`
 *      (`scanFieldForCredentials`) and `apps/wire/src/krater/cas.ts`
 *      (`scanBodyForSecrets`) over the complete shared credential/secret corpus.
 *
 * Zero mocks. Every discrepancy fails loudly with exact case context (never
 * echoing secret material).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { z } from "zod";
import {
  AdminAreaRenameRequestSchema,
  BatchContractsSchema,
  canonicalJson,
  DeadEndsListQuerySchema,
  EnrollmentContractsSchema,
  FellowCardQuerySchema,
  HonorsQuerySchema,
  LedgerContractsSchema,
  NowStripQuerySchema,
  ProblemDocumentSchema,
  RecordDeadEndRequestSchema,
  requestFieldHints,
} from "../../packages/contracts/src/index.ts";
import { ProblemLifecycleContractsSchema } from "../../packages/contracts/src/problems.ts";
import { ContractScaffoldSchema } from "../../packages/contracts/src/schema.ts";
import { SessionsContractsSchema } from "../../packages/contracts/src/sessions.ts";
import { scanBodyForSecrets } from "../../apps/wire/src/krater/cas.ts";
import { scanFieldForCredentials } from "../../apps/wire/src/screening/credential-scan.ts";
import { rejectAuthoritativeFields } from "../../apps/wire/src/split/policy.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const FIXTURES_DIR = resolve(REPO_ROOT, "packages/contracts/test/fixtures");

function resolveAsimpBin(): string {
  const envBin = process.env.ASIMP_BIN;
  if (envBin && existsSync(envBin)) return envBin;
  const candidates = [
    resolve(REPO_ROOT, "target/debug/asimp"),
    resolve(REPO_ROOT, "target/release/asimp"),
    resolve(REPO_ROOT, "cli/target/debug/asimp"),
    resolve(REPO_ROOT, "cli/target/release/asimp"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Compiled asimp binary not found. Build with \`rch exec -- cargo build --manifest-path cli/Cargo.toml --locked -j 2\` or set ASIMP_BIN. Checked: ${candidates.join(", ")}`,
  );
}

const ASIMP_BIN = resolveAsimpBin();

function runAsimp(
  args: readonly string[],
  stdin: string,
): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync([ASIMP_BIN, ...args], {
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      ASIMP_ORIGIN: "https://example.invalid",
    },
  });
  return {
    exitCode: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const CONJECTURE_CLASS_KINDS = new Set([
  "conjecture",
  "lemma",
  "theorem",
  "corollary",
  "reduction",
  "algorithm",
  "heuristic",
  "empirical",
]);

interface ValidateCase {
  readonly id: string;
  readonly kind: string;
  readonly schema: z.ZodType;
  readonly raw: string;
  readonly claimPublication?: boolean;
  readonly expectedValid?: boolean;
  readonly checkSuggestedFields?: boolean;
}

function readFixture(rel: string): string {
  return readFileSync(resolve(FIXTURES_DIR, rel), "utf8");
}

function workerValidate(c: ValidateCase): {
  valid: boolean;
  code: string | null;
  rule: string | null;
  suggestedFields: string[];
} {
  const parsed: unknown = JSON.parse(c.raw);
  if (
    c.claimPublication &&
    parsed !== null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed)
  ) {
    const authRefusal = rejectAuthoritativeFields(parsed as Record<string, unknown>);
    if (authRefusal !== null) {
      return {
        valid: false,
        code: authRefusal.code,
        rule: authRefusal.rule,
        suggestedFields: [],
      };
    }
  }
  const zodResult = c.schema.safeParse(parsed);
  if (!zodResult.success) {
    const hints = requestFieldHints(c.schema, parsed);
    return {
      valid: false,
      code: c.kind === "promote" || c.kind === "sessions/promote_request" ? "PROMOTE_BODY_INVALID" : "SCHEMA_INVALID",
      rule: "A5",
      suggestedFields: hints.suggested_fields ?? [],
    };
  }
  if (
    c.claimPublication &&
    parsed !== null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed)
  ) {
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.kind === "string" &&
      CONJECTURE_CLASS_KINDS.has(record.kind) &&
      !("falsifier" in record)
    ) {
      return {
        valid: false,
        code: "MISSING_FALSIFIER",
        rule: "P3",
        suggestedFields: [],
      };
    }
  }
  return { valid: true, code: null, rule: null, suggestedFields: [] };
}

async function runValidateParity(): Promise<number> {
  const cases: ValidateCase[] = [
    // Valid golden fixtures
    {
      id: "valid/promote-request.json",
      kind: "promote",
      schema: SessionsContractsSchema.shape.promote_request,
      raw: readFixture("valid/promote-request.json"),
      claimPublication: true,
      expectedValid: true,
    },
    {
      id: "valid/promote-workshop-version.json",
      kind: "promote",
      schema: SessionsContractsSchema.shape.promote_request,
      raw: readFixture("valid/promote-workshop-version.json"),
      claimPublication: true,
      expectedValid: true,
    },
    {
      id: "valid/promote-review-feedback.json",
      kind: "sessions/promote_response",
      schema: SessionsContractsSchema.shape.promote_response,
      raw: readFixture("valid/promote-review-feedback.json"),
      expectedValid: true,
    },
    {
      id: "valid/evidence-request.json",
      kind: "evidence",
      schema: SessionsContractsSchema.shape.evidence_request,
      raw: readFixture("valid/evidence-request.json"),
      expectedValid: true,
    },
    {
      id: "valid/review-request.json",
      kind: "review",
      schema: SessionsContractsSchema.shape.review_request,
      raw: readFixture("valid/review-request.json"),
      expectedValid: true,
    },
    {
      id: "valid/revise-request.json",
      kind: "revise",
      schema: SessionsContractsSchema.shape.revise_request,
      raw: readFixture("valid/revise-request.json"),
      claimPublication: true,
      expectedValid: true,
    },
    {
      id: "valid/workshop-push.json",
      kind: "workshop",
      schema: SessionsContractsSchema.shape.workshop_push_request,
      raw: readFixture("valid/workshop-push.json"),
      expectedValid: true,
    },
    {
      id: "valid/session-open.json",
      kind: "session-open",
      schema: SessionsContractsSchema.shape.session_open_request,
      raw: readFixture("valid/session-open.json"),
      expectedValid: true,
    },
    {
      id: "valid/session-close.json",
      kind: "session-close",
      schema: SessionsContractsSchema.shape.session_close_request,
      raw: readFixture("valid/session-close.json"),
      expectedValid: true,
    },
    {
      id: "valid/enrollment.json",
      kind: "enroll",
      schema: EnrollmentContractsSchema.shape.fellow_registration_request,
      raw: readFixture("valid/enrollment.json"),
      expectedValid: true,
    },
    {
      id: "valid/device-code-start.json",
      kind: "device-start",
      schema: EnrollmentContractsSchema.shape.device_code_start_request,
      raw: readFixture("valid/device-code-start.json"),
      expectedValid: true,
    },
    {
      id: "valid/batch-commit-plan-request.json",
      kind: "batch/plan_request",
      schema: BatchContractsSchema.shape.plan_request,
      raw: readFixture("valid/batch-commit-plan-request.json"),
      expectedValid: true,
    },
    {
      id: "valid/batch-commit-plan-response.json",
      kind: "batch/plan_result",
      schema: BatchContractsSchema.shape.plan_result,
      raw: readFixture("valid/batch-commit-plan-response.json"),
      expectedValid: true,
    },
    {
      id: "valid/batch-event-cause.json",
      kind: "batch/event_cause",
      schema: BatchContractsSchema.shape.event_cause,
      raw: readFixture("valid/batch-event-cause.json"),
      expectedValid: true,
    },
    {
      id: "valid/contracts-scaffold.json",
      kind: "contracts-scaffold",
      schema: ContractScaffoldSchema,
      raw: readFixture("valid/contracts-scaffold.json"),
      expectedValid: true,
    },
    {
      id: "valid/admin-area-rename.json",
      kind: "discovery/area_rename_request",
      schema: AdminAreaRenameRequestSchema,
      raw: readFixture("valid/admin-area-rename.json"),
      expectedValid: true,
    },
    {
      id: "valid/discovery-now-query.json",
      kind: "discovery/now_query",
      schema: NowStripQuerySchema,
      raw: readFixture("valid/discovery-now-query.json"),
      expectedValid: true,
    },
    {
      id: "valid/discovery-honors-query.json",
      kind: "discovery/honors_query",
      schema: HonorsQuerySchema,
      raw: readFixture("valid/discovery-honors-query.json"),
      expectedValid: true,
    },
    {
      id: "valid/discovery-fellow-query.json",
      kind: "discovery/fellow_query",
      schema: FellowCardQuerySchema,
      raw: readFixture("valid/discovery-fellow-query.json"),
      expectedValid: true,
    },
    {
      id: "valid/hypothesis-lifecycle-defer.json",
      kind: "sessions/hypothesis_lifecycle_request",
      schema: SessionsContractsSchema.shape.hypothesis_lifecycle_request,
      raw: readFixture("valid/hypothesis-lifecycle-defer.json"),
      expectedValid: true,
    },
    {
      id: "valid/hypothesis-lifecycle-narrow.json",
      kind: "sessions/hypothesis_lifecycle_request",
      schema: SessionsContractsSchema.shape.hypothesis_lifecycle_request,
      raw: readFixture("valid/hypothesis-lifecycle-narrow.json"),
      expectedValid: true,
    },
    {
      id: "valid/full-pack-query.json",
      kind: "sessions/full_pack_query",
      schema: SessionsContractsSchema.shape.full_pack_query,
      raw: readFixture("valid/full-pack-query.json"),
      expectedValid: true,
    },
    {
      id: "valid/full-pack-page.json",
      kind: "sessions/full_pack_page",
      schema: SessionsContractsSchema.shape.full_pack_page,
      raw: readFixture("valid/full-pack-page.json"),
      expectedValid: true,
    },
    {
      id: "valid/enrollment-mint.json",
      kind: "enrollment/mint_request",
      schema: EnrollmentContractsSchema.shape.mint_request,
      raw: readFixture("valid/enrollment-mint.json"),
      expectedValid: true,
    },
    {
      id: "valid/enrollment-mint-response.json",
      kind: "enrollment/mint_response",
      schema: EnrollmentContractsSchema.shape.mint_response,
      raw: readFixture("valid/enrollment-mint-response.json"),
      expectedValid: true,
    },
    {
      id: "valid/enrollment-bootstrap-request.json",
      kind: "enrollment/sponsor_bootstrap_request",
      schema: EnrollmentContractsSchema.shape.sponsor_bootstrap_request,
      raw: readFixture("valid/enrollment-bootstrap-request.json"),
      expectedValid: true,
    },
    {
      id: "valid/enrollment-decision-approve.json",
      kind: "enrollment/sponsor_enrollment_decision",
      schema: EnrollmentContractsSchema.shape.sponsor_enrollment_decision,
      raw: readFixture("valid/enrollment-decision-approve.json"),
      expectedValid: true,
    },
    {
      id: "valid/enrollment-decision-command-approve.json",
      kind: "enrollment/sponsor_enrollment_decision_command",
      schema: EnrollmentContractsSchema.shape.sponsor_enrollment_decision_command,
      raw: readFixture("valid/enrollment-decision-command-approve.json"),
      expectedValid: true,
    },
    {
      id: "valid/enrollment-decision-response.json",
      kind: "enrollment/sponsor_enrollment_decision_response",
      schema: EnrollmentContractsSchema.shape.sponsor_enrollment_decision_response,
      raw: readFixture("valid/enrollment-decision-response.json"),
      expectedValid: true,
    },
    {
      id: "valid/device-code-start-response.json",
      kind: "enrollment/device_code_start_response",
      schema: EnrollmentContractsSchema.shape.device_code_start_response,
      raw: readFixture("valid/device-code-start-response.json"),
      expectedValid: true,
    },
    {
      id: "valid/enrollment-operator-fellow-cap-override-request.json",
      kind: "enrollment/operator_fellow_cap_override_request",
      schema: EnrollmentContractsSchema.shape.operator_fellow_cap_override_request,
      raw: readFixture("valid/enrollment-operator-fellow-cap-override-request.json"),
      expectedValid: true,
    },
    {
      id: "valid/enrollment-operator-fellow-cap-override-response.json",
      kind: "enrollment/operator_fellow_cap_override_response",
      schema: EnrollmentContractsSchema.shape.operator_fellow_cap_override_response,
      raw: readFixture("valid/enrollment-operator-fellow-cap-override-response.json"),
      expectedValid: true,
    },
    {
      id: "valid/ledger-claim-face-query.json",
      kind: "ledger/claim_face_query",
      schema: LedgerContractsSchema.shape.claim_face_query,
      raw: readFixture("valid/ledger-claim-face-query.json"),
      expectedValid: true,
    },
    {
      id: "valid/dead-ends-target-query.json",
      kind: "dead-ends/query",
      schema: DeadEndsListQuerySchema,
      raw: readFixture("valid/dead-ends-target-query.json"),
      expectedValid: true,
    },
    {
      id: "valid/record-dead-end-request.json",
      kind: "dead-end",
      schema: RecordDeadEndRequestSchema,
      raw: readFixture("valid/record-dead-end-request.json"),
      expectedValid: true,
    },

    // Invalid golden fixtures
    {
      id: "invalid/promote-unknown-kind.json",
      kind: "promote",
      schema: SessionsContractsSchema.shape.promote_request,
      raw: readFixture("invalid/promote-unknown-kind.json"),
      claimPublication: true,
      expectedValid: false,
    },
    {
      id: "invalid/promote-workshop-retarget.json",
      kind: "promote",
      schema: SessionsContractsSchema.shape.promote_request,
      raw: readFixture("invalid/promote-workshop-retarget.json"),
      claimPublication: true,
      expectedValid: false,
    },
    {
      id: "invalid/promote-workshop-version.json",
      kind: "promote",
      schema: SessionsContractsSchema.shape.promote_request,
      raw: readFixture("invalid/promote-workshop-version.json"),
      claimPublication: true,
      expectedValid: false,
    },
    {
      id: "invalid/promote-review-feedback-negative.json",
      kind: "sessions/promote_response",
      schema: SessionsContractsSchema.shape.promote_response,
      raw: readFixture("invalid/promote-review-feedback-negative.json"),
      expectedValid: false,
    },
    {
      id: "invalid/session-open-bad-problem.json",
      kind: "session-open",
      schema: SessionsContractsSchema.shape.session_open_request,
      raw: readFixture("invalid/session-open-bad-problem.json"),
      expectedValid: false,
    },
    {
      id: "invalid/workshop-push-extra-field.json",
      kind: "workshop",
      schema: SessionsContractsSchema.shape.workshop_push_request,
      raw: readFixture("invalid/workshop-push-extra-field.json"),
      expectedValid: false,
    },
    {
      id: "invalid/enrollment-invalid-secret.json",
      kind: "enroll",
      schema: EnrollmentContractsSchema.shape.fellow_registration_request,
      raw: readFixture("invalid/enrollment-invalid-secret.json"),
      expectedValid: false,
    },
    {
      id: "invalid/enrollment-nul-persisted-text.json",
      kind: "enroll",
      schema: EnrollmentContractsSchema.shape.fellow_registration_request,
      raw: readFixture("invalid/enrollment-nul-persisted-text.json"),
      expectedValid: false,
    },
    {
      id: "invalid/device-lookup-lowercase-code.json",
      kind: "enrollment/device_lookup_request",
      schema: EnrollmentContractsSchema.shape.device_lookup_request,
      raw: readFixture("invalid/device-lookup-lowercase-code.json"),
      expectedValid: false,
    },
    {
      id: "invalid/enrollment-mint-invalid-budget.json",
      kind: "enrollment/mint_request",
      schema: EnrollmentContractsSchema.shape.mint_request,
      raw: readFixture("invalid/enrollment-mint-invalid-budget.json"),
      expectedValid: false,
    },
    {
      id: "invalid/enrollment-mint-response-plainsecret.json",
      kind: "enrollment/mint_response",
      schema: EnrollmentContractsSchema.shape.mint_response,
      raw: readFixture("invalid/enrollment-mint-response-plainsecret.json"),
      expectedValid: false,
    },
    {
      id: "invalid/enrollment-bootstrap-request-extra.json",
      kind: "enrollment/sponsor_bootstrap_request",
      schema: EnrollmentContractsSchema.shape.sponsor_bootstrap_request,
      raw: readFixture("invalid/enrollment-bootstrap-request-extra.json"),
      expectedValid: false,
    },
    {
      id: "invalid/enrollment-decision-missing-target.json",
      kind: "enrollment/sponsor_enrollment_decision",
      schema: EnrollmentContractsSchema.shape.sponsor_enrollment_decision,
      raw: readFixture("invalid/enrollment-decision-missing-target.json"),
      expectedValid: false,
    },
    {
      id: "invalid/enrollment-decision-command-fractional-step-up.json",
      kind: "enrollment/sponsor_enrollment_decision_command",
      schema: EnrollmentContractsSchema.shape.sponsor_enrollment_decision_command,
      raw: readFixture("invalid/enrollment-decision-command-fractional-step-up.json"),
      expectedValid: false,
    },
    {
      id: "invalid/enrollment-operator-fellow-cap-override-missing-expected.json",
      kind: "enrollment/operator_fellow_cap_override_request",
      schema: EnrollmentContractsSchema.shape.operator_fellow_cap_override_request,
      raw: readFixture("invalid/enrollment-operator-fellow-cap-override-missing-expected.json"),
      expectedValid: false,
    },
    {
      id: "invalid/batch-commit-plan-request-empty.json",
      kind: "batch/plan_request",
      schema: BatchContractsSchema.shape.plan_request,
      raw: readFixture("invalid/batch-commit-plan-request-empty.json"),
      expectedValid: false,
    },
    {
      id: "invalid/batch-commit-plan-request-invalid-temp-id.json",
      kind: "batch/plan_request",
      schema: BatchContractsSchema.shape.plan_request,
      raw: readFixture("invalid/batch-commit-plan-request-invalid-temp-id.json"),
      expectedValid: false,
    },
    {
      id: "invalid/batch-commit-plan-request-too-large.json",
      kind: "batch/plan_request",
      schema: BatchContractsSchema.shape.plan_request,
      raw: readFixture("invalid/batch-commit-plan-request-too-large.json"),
      expectedValid: false,
    },
    {
      id: "invalid/batch-event-cause-unbound.json",
      kind: "batch/event_cause",
      schema: BatchContractsSchema.shape.event_cause,
      raw: readFixture("invalid/batch-event-cause-unbound.json"),
      expectedValid: false,
    },
    {
      id: "invalid/contracts-scaffold-stale.json",
      kind: "contracts-scaffold",
      schema: ContractScaffoldSchema,
      raw: readFixture("invalid/contracts-scaffold-stale.json"),
      expectedValid: false,
    },
    {
      id: "invalid/admin-area-rename.json",
      kind: "discovery/area_rename_request",
      schema: AdminAreaRenameRequestSchema,
      raw: readFixture("invalid/admin-area-rename.json"),
      expectedValid: false,
    },
    {
      id: "invalid/discovery-now-query.json",
      kind: "discovery/now_query",
      schema: NowStripQuerySchema,
      raw: readFixture("invalid/discovery-now-query.json"),
      expectedValid: false,
    },
    {
      id: "invalid/discovery-honors-query.json",
      kind: "discovery/honors_query",
      schema: HonorsQuerySchema,
      raw: readFixture("invalid/discovery-honors-query.json"),
      expectedValid: false,
    },
    {
      id: "invalid/discovery-fellow-query.json",
      kind: "discovery/fellow_query",
      schema: FellowCardQuerySchema,
      raw: readFixture("invalid/discovery-fellow-query.json"),
      expectedValid: false,
    },
    {
      id: "invalid/full-pack-query.json",
      kind: "sessions/full_pack_query",
      schema: SessionsContractsSchema.shape.full_pack_query,
      raw: readFixture("invalid/full-pack-query.json"),
      expectedValid: false,
    },
    {
      id: "invalid/full-pack-page.json",
      kind: "sessions/full_pack_page",
      schema: SessionsContractsSchema.shape.full_pack_page,
      raw: readFixture("invalid/full-pack-page.json"),
      expectedValid: false,
    },
    {
      id: "invalid/dead-ends-target-query.json",
      kind: "dead-ends/query",
      schema: DeadEndsListQuerySchema,
      raw: readFixture("invalid/dead-ends-target-query.json"),
      expectedValid: false,
    },
    {
      id: "invalid/record-dead-end-request.json",
      kind: "dead-end",
      schema: RecordDeadEndRequestSchema,
      raw: readFixture("invalid/record-dead-end-request.json"),
      expectedValid: false,
    },

    // Mechanical Worker policy rules (P2/P4, P3, A5 field hints, RFC3339 format)
    {
      id: "policy/p2-p4-self-cert-disposition",
      kind: "promote",
      schema: SessionsContractsSchema.shape.promote_request,
      raw: JSON.stringify({
        workshop_id: "W-abcdefghijklmnopqrstuvwxyz",
        kind: "conjecture",
        statement: "Every even integer > 2 is the sum of two primes.",
        falsifier: "An even n > 2 not expressible as p + q.",
        disposition: "proved",
      }),
      claimPublication: true,
      expectedValid: false,
    },
    {
      id: "policy/p2-p4-nfkc-fullwidth",
      kind: "promote",
      schema: SessionsContractsSchema.shape.promote_request,
      raw: JSON.stringify({
        workshop_id: "W-abcdefghijklmnopqrstuvwxyz",
        kind: "definition",
        statement: "An even integer is divisible by two.",
        "ｐｒｏｖｅｄ": true,
      }),
      claimPublication: true,
      expectedValid: false,
    },
    {
      id: "policy/p2-p4-status-upgrade",
      kind: "revise",
      schema: SessionsContractsSchema.shape.revise_request,
      raw: JSON.stringify({
        claim_id: "C-1",
        base_version: 1,
        kind: "definition",
        statement: "An even integer is divisible by two.",
        status: "strongly-supported",
      }),
      claimPublication: true,
      expectedValid: false,
    },
    {
      id: "policy/p3-missing-falsifier-conjecture",
      kind: "promote",
      schema: SessionsContractsSchema.shape.promote_request,
      raw: JSON.stringify({
        workshop_id: "W-abcdefghijklmnopqrstuvwxyz",
        kind: "conjecture",
        statement: "Every even integer > 2 is the sum of two primes.",
      }),
      claimPublication: true,
      expectedValid: false,
    },
    {
      id: "policy/p3-definition-no-falsifier-ok",
      kind: "promote",
      schema: SessionsContractsSchema.shape.promote_request,
      raw: JSON.stringify({
        workshop_id: "W-abcdefghijklmnopqrstuvwxyz",
        kind: "definition",
        statement: "A prime integer is greater than one with only trivial divisors.",
      }),
      claimPublication: true,
      expectedValid: true,
    },
    {
      id: "policy/a5-field-hints-typo",
      kind: "promote",
      schema: SessionsContractsSchema.shape.promote_request,
      raw: JSON.stringify({
        workshop_id: "W-abcdefghijklmnopqrstuvwxyz",
        kind: "definition",
        statemnt: "An even integer is divisible by two.",
      }),
      claimPublication: true,
      expectedValid: false,
      checkSuggestedFields: true,
    },
    {
      id: "format/rfc3339-invalid-leap-day",
      kind: "problems/dormancy_event",
      schema: ProblemLifecycleContractsSchema.shape.dormancy_event,
      raw: JSON.stringify({
        problem_id: "P-EXAMPLE",
        quiet_since: "2026-02-29T00:00:00Z",
        recorded_at: "2026-01-01T12:34:00Z",
        reason: "quiet",
      }),
      expectedValid: false,
    },
    {
      id: "format/problem-valid-uri",
      kind: "problem/problem_document",
      schema: ProblemDocumentSchema,
      raw: readFixture("valid/problem-unknown-format.json"),
      expectedValid: true,
    },
    {
      id: "format/problem-invalid-uri",
      kind: "problem/problem_document",
      schema: ProblemDocumentSchema,
      raw: readFixture("valid/problem-unknown-format.json").replace(
        "https://a.asimposium.org/schemas/problem.v1.json",
        "not a valid uri",
      ),
      expectedValid: false,
    },
  ];

  const diffs: string[] = [];
  for (const c of cases) {
    const worker = workerValidate(c);
    if (c.expectedValid !== undefined && worker.valid !== c.expectedValid) {
      diffs.push(
        `[validate/${c.id}] worker sanity mismatch: expected valid=${c.expectedValid}, got ${worker.valid} (code=${worker.code})`,
      );
      continue;
    }

    const cli = runAsimp(["validate", "--stdin", "--kind", c.kind, "--json"], c.raw);
    if (cli.stderr.length > 0) {
      diffs.push(`[validate/${c.id}] unexpected stderr: ${cli.stderr.trim()}`);
      continue;
    }
    const expectedExit = worker.valid ? 0 : 1;
    if (cli.exitCode !== expectedExit) {
      diffs.push(
        `[validate/${c.id}] exitCode mismatch: worker expects ${expectedExit} (valid=${worker.valid}, code=${worker.code}), rust returned ${cli.exitCode}, stdout=${cli.stdout.trim()}`,
      );
      continue;
    }
    const rust = JSON.parse(cli.stdout) as {
      valid: boolean;
      code?: string;
      rule?: string;
      suggested_fields?: string[];
      canonical_sha256?: string;
    };
    if (rust.valid !== worker.valid) {
      diffs.push(`[validate/${c.id}] valid mismatch: worker=${worker.valid}, rust=${rust.valid}`);
    }
    if ((rust.code ?? null) !== worker.code) {
      diffs.push(`[validate/${c.id}] code mismatch: worker=${worker.code}, rust=${rust.code ?? null}`);
    }
    if ((rust.rule ?? null) !== worker.rule) {
      diffs.push(`[validate/${c.id}] rule mismatch: worker=${worker.rule}, rust=${rust.rule ?? null}`);
    }
    if (c.checkSuggestedFields) {
      const rustSuggestions = rust.suggested_fields ?? [];
      if (JSON.stringify(rustSuggestions) !== JSON.stringify(worker.suggestedFields)) {
        diffs.push(
          `[validate/${c.id}] suggested_fields mismatch: worker=${JSON.stringify(worker.suggestedFields)}, rust=${JSON.stringify(rustSuggestions)}`,
        );
      }
    }
    // Canonical JSON SHA-256 parity on every JSON input
    const workerCanonHash = await sha256Hex(canonicalJson(JSON.parse(c.raw)));
    if (rust.canonical_sha256 !== workerCanonHash) {
      diffs.push(
        `[validate/${c.id}] canonical_sha256 mismatch: worker=${workerCanonHash}, rust=${rust.canonical_sha256}`,
      );
    }
  }

  if (diffs.length > 0) {
    throw new Error(`Validate parity failed (${diffs.length} diffs):\n${diffs.join("\n")}`);
  }
  return cases.length;
}

const FELLOW_TOKEN = `asimp_ag_${"0123456789ABCDEFGHJKMNPQRS"}_${"a".repeat(43)}`;
const JOIN_URL = `https://a.asimposium.org/join/ASIMP-EN-0123456789ABCDEF#v1.${"Q".repeat(43)}`;
const ENROLLMENT_SECRET = `v1.${"Q".repeat(43)}`;
const FLOW_HANDLE = `flow_v1.${"r".repeat(43)}`;
const PRIVATE_KEY = "-----BEGIN OPENSSH PRIVATE KEY-----";
const GITHUB = `ghp_${"x".repeat(36)}`;
const AWS = "AKIAABCDEFGHIJKLMNOP";
const JWT = `eyJ${"a".repeat(12)}.eyJ${"b".repeat(12)}.${"c".repeat(12)}`;

const escaped = (value: string) =>
  Array.from(
    value,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  ).join("");

function runScrubParity(): number {
  const ledgerCases: ReadonlyArray<{ id: string; field: string; input: string; canaries?: string[] }> = [
    {
      id: "multiline-credential-classes",
      field: "body_md",
      input: ["Lemma 1 holds.", `token ${FELLOW_TOKEN}`, `see ${JOIN_URL}`, PRIVATE_KEY].join("\n"),
      canaries: [FELLOW_TOKEN, "Q".repeat(20)],
    },
    { id: "github-pat", field: "statement", input: `x ${GITHUB} y`, canaries: [GITHUB] },
    { id: "aws-key", field: "statement", input: `x ${AWS} y`, canaries: [AWS] },
    { id: "jwt", field: "statement", input: `x ${JWT} y`, canaries: [JWT] },
    {
      id: "anthropic-key",
      field: "statement",
      input: `x sk-ant-${"k".repeat(40)} y`,
      canaries: [`sk-ant-${"k".repeat(40)}`],
    },
    {
      id: "body-only-enrollment-secret",
      field: "body_md",
      input: `Notes\n𝔽 ${ENROLLMENT_SECRET}.`,
      canaries: [ENROLLMENT_SECRET],
    },
    {
      id: "body-only-flow-handle",
      field: "body_md",
      input: `Notes\n𝔽 ${FLOW_HANDLE}.`,
      canaries: [FLOW_HANDLE],
    },
    {
      id: "benign-math-and-lean",
      field: "body_md",
      input: [
        "theorem foo (h : n > 0) : n ≥ 1 := by rw [h@Nat.succ_le]; exact h",
        "For all n, sk-1 = sk - 1 where s_k is the k-th partial sum.",
        "Contact: the authors' group at math.example.edu.",
        "Let AKIA be the incidence algebra.",
        "The asimp_ag_ prefix names Fellow tokens.",
        "Protocol v1.2, v1.0-rc1-build-2026 and capsule.v1.json are version labels.",
        `A dotted version is v1.${"1.".repeat(25)}0.`,
        `The identifier workflow_v1.${"x".repeat(43)} is not a polling credential.`,
      ].join("\n"),
    },
    {
      id: "json-nested-procedure",
      field: "statement",
      input: JSON.stringify({
        statement: "Every even n > 2 is a sum of two primes.",
        scientific_provenance: { method: { procedure: `Ran with ${GITHUB}.\nThen checked.` } },
      }),
      canaries: [GITHUB],
    },
    { id: "malformed-brace-prose", field: "statement", input: `{not json ${AWS}`, canaries: [AWS] },
    { id: "unicode-codepoint-columns", field: "body_md", input: `𝔽𝔽 ${AWS}`, canaries: [AWS] },
    {
      id: "2048-leaf-json-array",
      field: "body_md",
      input: JSON.stringify([...Array.from({ length: 2048 }, () => "ordinary scientific data"), GITHUB]),
      canaries: [GITHUB],
    },
    {
      id: "hostile-key-github",
      field: "request",
      input: JSON.stringify({ [GITHUB]: { inner: AWS } }),
      canaries: [GITHUB, AWS],
    },
    {
      id: "escaped-key-github",
      field: "body_md",
      input: `{"${escaped(GITHUB)}":"ordinary"}`,
      canaries: [GITHUB],
    },
    {
      id: "shadowed-duplicate-key",
      field: "body_md",
      input: `{"payload":"${escaped(GITHUB)}","payload":"ordinary"}`,
      canaries: [GITHUB],
    },
    {
      id: "nested-json-source-string",
      field: "request",
      input: JSON.stringify({ body_md: `{"payload":"${escaped(GITHUB)}","payload":"ordinary"}` }),
      canaries: [GITHUB],
    },
    {
      id: "escaped-scalar-string",
      field: "body_md",
      input: `"${escaped(AWS)}"`,
      canaries: [AWS],
    },
    {
      id: "deep-json-20000",
      field: "body_md",
      input: `${"[".repeat(20_000)}"${escaped(GITHUB)}"${"]".repeat(20_000)}`,
      canaries: [GITHUB],
    },
    {
      id: "dense-flood-cap-20",
      field: "body_md",
      input: Array.from({ length: 100 }, () => AWS).join(" "),
      canaries: [AWS],
    },
    {
      id: "benign-nested-json",
      field: "body_md",
      input: JSON.stringify({
        statement: "For every n, sk-1 = sk - 1.",
        "arbitrary field": { proof: "by rw [h@Nat.succ_le]; exact h" },
        vector: [0, 1, 2],
        source: JSON.stringify({ lemma: "Let AKIA be the incidence algebra." }),
      }),
    },
    ...[
      "DB_PASSWORD=synthetic-db-secret",
      "export GITHUB_TOKEN='synthetic-github-secret'",
      'STRIPE_SECRET="synthetic-stripe-secret"',
      "MY_API_KEY=synthetic-api-secret",
      "service_apiKey = 'synthetic-api-secret'",
      "password=x",
      "PASSWORD=0",
      "CLIENT_SECRET=changeme",
      "REFRESH_TOKEN=test",
      "DB_PASSWORD=p(a)[s]s",
      "AWS_SECRET_ACCESS_KEY=synthetic-aws-secret",
      'const config={DB_PASSWORD:"synthetic-nested-secret"};',
      'const config="DB_PASSWORD=synthetic-nested-secret";',
      "PASSWORD=${TOKEN}synthetic-suffix",
      'PASSWORD=""synthetic-suffix',
      'PASSWORD="<redacted>"+"synthetic-suffix"',
      'PASSWORD=process.env.PASSWORD || "synthetic-fallback"',
      "DB_PASSWORD=#synthetic-password",
      '"db_password": "synthetic-json-secret"',
      'password: "synthetic-yaml-secret"',
      String.raw`MY_API_KEY="synthetic\"quoted-secret"`,
      '𝔽 DB_PASSWORD="synthetic-one"\nDB_PASSWORD=synthetic-two',
      `API_KEY=${AWS}`,
      "PASSWORD=<redacted> API_KEY=synthetic-value",
    ].map((input, idx) => ({
      id: `assignment-hit-${idx}`,
      field: "body_md",
      input,
      canaries: input.includes("synthetic") ? ["synthetic"] : [],
    })),
    ...[
      "let token_count = 42; let password_length = 16;",
      'const secreted = "ordinary biological result";',
      "const key = 'lemma-1';",
      "token: String",
      "api_key: Option<String>",
      "For every token, token_count = n.",
      "const token = nextToken(input);",
      "let secret = p*q;",
      "secret = p * q",
      'token = request.headers.get("authorization");',
      "token == expected_token",
      "token === expected_token",
      "const password = await fetchSecret();",
      "password = input.password",
      "DB_PASSWORD=process.env.DB_PASSWORD",
      'DB_PASSWORD=process.env["DB_PASSWORD"]',
      'DB_PASSWORD=os.environ[ "DB_PASSWORD" ]',
      'DB_PASSWORD=getenv( "DB_PASSWORD" )',
      'DB_PASSWORD=os.getenv("DB_PASSWORD")',
      "DB_PASSWORD=${DB_PASSWORD}",
      "DB_PASSWORD=$DB_PASSWORD",
      "DB_PASSWORD=%DB_PASSWORD%",
      "DB_PASSWORD={{ DB_PASSWORD }}",
      "DB_PASSWORD=<your_password>",
      "DB_PASSWORD=[REDACTED]",
      'DB_PASSWORD="<redacted>"',
      'DB_PASSWORD=""',
      "DB_PASSWORD=xxxxxx",
      "DB_PASSWORD=********",
      "DB_PASSWORD=...",
      'MY_API_KEY="${MY_API_KEY}"',
    ].map((input, idx) => ({ id: `assignment-benign-${idx}`, field: "body_md", input })),
    ...[
      "postgresql://reader:synthetic-db-password@db.example.invalid/research",
      "redis://:synthetic-cache-password@cache.example.invalid:6379/0",
      "mongodb+srv://reader:synthetic%40encoded%3Apassword@db.example.invalid/research",
      "https://reader:x@service.example.invalid/",
      "amqps://reader:synthetic%ZZpassword@queue.example.invalid/",
      "postgres://reader:[redacted]@actual@db.example.invalid/research",
      "postgres://reader:%3Credacted%3E%40actual@db.example.invalid/research",
    ].map((uri, idx) => ({
      id: `uri-hit-${idx}`,
      field: "body_md",
      input: `𝔽 ${uri}`,
      canaries: uri.includes("synthetic") ? ["synthetic"] : [],
    })),
    ...[
      "https://service.example.invalid/paper",
      "https://reader@service.example.invalid/paper",
      "postgresql://reader:@db.example.invalid/research",
      "postgresql://reader:<password>@db.invalid/research",
      "postgresql://reader:%3Credacted%3E@db.invalid/research",
      "redis://:${REDIS_PASSWORD}@cache.invalid/0",
    ].map((uri, idx) => ({ id: `uri-benign-${idx}`, field: "body_md", input: uri })),
    {
      id: "json-cred-key-escaped",
      field: "request",
      input: `{"${escaped("DB_PASSWORD")}":"${escaped("synthetic-json-value")}"}`,
      canaries: ["synthetic-json-value"],
    },
    {
      id: "json-cred-key-numeric",
      field: "request",
      input: '{"PASSWORD":0}',
    },
    {
      id: "json-cred-key-duplicate",
      field: "request",
      input: '{"DB_PASSWORD":"synthetic-json-value","DB_PASSWORD":"<redacted>"}',
      canaries: ["synthetic-json-value"],
    },
    {
      id: "json-cred-hostile-key",
      field: "request",
      input: JSON.stringify({ "DB_PASSWORD=synthetic-key-value": { password: "synthetic-value" } }),
      canaries: ["synthetic"],
    },
    {
      id: "json-cred-nested-duplicate",
      field: "request",
      input: JSON.stringify({
        body_md: '{"db_password":"synthetic-json-value","db_password":"<redacted>"}',
      }),
      canaries: ["synthetic-json-value"],
    },
  ];

  const artifactCases: ReadonlyArray<{ id: string; input: string; canaries?: string[] }> = [
    { id: "artifact-join-url", input: JOIN_URL, canaries: ["Q".repeat(20)] },
    { id: "artifact-enrollment-secret", input: `Notes\n𝔽 ${ENROLLMENT_SECRET}.`, canaries: [ENROLLMENT_SECRET] },
    { id: "artifact-flow-handle", input: `Notes\n𝔽 ${FLOW_HANDLE}.`, canaries: [FLOW_HANDLE] },
    { id: "artifact-unicode-emoji-token", input: `😀 ${FELLOW_TOKEN}`, canaries: [FELLOW_TOKEN] },
    {
      id: "artifact-personal-address",
      input: "reach me at researcher@example.org for the data",
      canaries: ["researcher@example.org"],
    },
    {
      id: "artifact-json-multiline-cred",
      input: '{\n  "DB_PASSWORD"\n  :\n  "synthetic-artifact-password"\n}',
      canaries: ["synthetic"],
    },
    {
      id: "artifact-json-escaped-key",
      input: String.raw`{"DB_PASS\u0057ORD":"synthetic-artifact-password"}`,
      canaries: ["synthetic"],
    },
    {
      id: "artifact-json-escaped-value",
      input: String.raw`{"DB_PASSWORD":"\u0073ynthetic-artifact-password"}`,
      canaries: ["synthetic"],
    },
    {
      id: "artifact-json-numeric-cred",
      input: '{"DB_PASSWORD":\n1234}',
    },
    {
      id: "artifact-json-escaped-uri",
      input: String.raw`{"connection":"postgres:\/\/reader:synthetic-artifact-password@db.invalid/research"}`,
      canaries: ["synthetic"],
    },
    {
      id: "artifact-json-redacted-clean",
      input: String.raw`{"DB_PASS\u0057ORD":"<redacted>"}`,
    },
    {
      id: "artifact-json-env-placeholder-clean",
      input: '{\n "DB_PASSWORD": "${DB_PASSWORD}"\n}',
    },
    {
      id: "artifact-json-uri-redacted-clean",
      input: String.raw`{"connection":"postgres:\/\/reader:%3Credacted%3E@db/research"}`,
    },
    {
      id: "artifact-json-counts-clean",
      input: '{"token_count":1234,"password_length":20}',
    },
    {
      id: "artifact-multiline-assignments",
      input: '𝔽 DB_PASSWORD="synthetic-one"\nDB_PASSWORD=synthetic-two',
      canaries: ["synthetic"],
    },
  ];

  const diffs: string[] = [];
  for (const c of ledgerCases) {
    const worker = scanFieldForCredentials(c.field, c.input);
    const cli = runAsimp(["scrub", "--stdin", "--mode", "ledger", "--field", c.field, "--json"], c.input);
    if (cli.stderr.length > 0) {
      diffs.push(`[scrub/ledger/${c.id}] unexpected stderr: ${cli.stderr.trim()}`);
      continue;
    }
    const expectedExit = worker.length === 0 ? 0 : 1;
    if (cli.exitCode !== expectedExit) {
      diffs.push(
        `[scrub/ledger/${c.id}] exitCode mismatch: worker findings=${worker.length} (expect exit ${expectedExit}), rust exit=${cli.exitCode}, stdout=${cli.stdout.trim()}`,
      );
      continue;
    }
    for (const canary of c.canaries ?? []) {
      if (cli.stdout.includes(canary) || cli.stderr.includes(canary)) {
        diffs.push(`[scrub/ledger/${c.id}] SECRET ECHO DETECTED!`);
      }
    }
    const rust = JSON.parse(cli.stdout) as {
      findings: Array<{ path: string; kind: string; line: number; column: number }>;
    };
    const rustNormalized = rust.findings.map(({ path, kind, line, column }) => ({
      path,
      kind,
      line,
      column,
    }));
    const workerNormalized = worker.map(({ path, kind, line, column }) => ({
      path,
      kind,
      line,
      column,
    }));
    if (JSON.stringify(rustNormalized) !== JSON.stringify(workerNormalized)) {
      diffs.push(
        `[scrub/ledger/${c.id}] findings mismatch:\n  worker=${JSON.stringify(workerNormalized)}\n  rust  =${JSON.stringify(rustNormalized)}`,
      );
    }
  }

  for (const c of artifactCases) {
    const worker = scanBodyForSecrets(c.input);
    const cli = runAsimp(["scrub", "--stdin", "--mode", "artifact", "--json"], c.input);
    if (cli.stderr.length > 0) {
      diffs.push(`[scrub/artifact/${c.id}] unexpected stderr: ${cli.stderr.trim()}`);
      continue;
    }
    const expectedExit = worker.length === 0 ? 0 : 1;
    if (cli.exitCode !== expectedExit) {
      diffs.push(
        `[scrub/artifact/${c.id}] exitCode mismatch: worker findings=${worker.length} (expect exit ${expectedExit}), rust exit=${cli.exitCode}, stdout=${cli.stdout.trim()}`,
      );
      continue;
    }
    for (const canary of c.canaries ?? []) {
      if (cli.stdout.includes(canary) || cli.stderr.includes(canary)) {
        diffs.push(`[scrub/artifact/${c.id}] SECRET ECHO DETECTED!`);
      }
    }
    const rust = JSON.parse(cli.stdout) as {
      findings: Array<{ kind: string; line: number; column: number }>;
    };
    const rustNormalized = rust.findings.map(({ kind, line, column }) => ({
      kind,
      line,
      column,
    }));
    const workerNormalized = worker.map(({ kind, line, column }) => ({
      kind,
      line,
      column,
    }));
    if (JSON.stringify(rustNormalized) !== JSON.stringify(workerNormalized)) {
      diffs.push(
        `[scrub/artifact/${c.id}] findings mismatch:\n  worker=${JSON.stringify(workerNormalized)}\n  rust  =${JSON.stringify(rustNormalized)}`,
      );
    }
  }

  // Acknowledge-false-positive boundary: hard credentials cannot be acked; soft findings can.
  const hardAck = runAsimp(
    [
      "scrub",
      "--stdin",
      "--mode",
      "ledger",
      "--field",
      "body_md",
      "--ack-false-positive",
      "body_md:fellow-token:1:1",
      "--json",
    ],
    FELLOW_TOKEN,
  );
  if (
    hardAck.exitCode !== 2 ||
    !hardAck.stderr.includes("cannot be acknowledged") ||
    hardAck.stdout.includes(FELLOW_TOKEN) ||
    hardAck.stderr.includes(FELLOW_TOKEN)
  ) {
    diffs.push(
      `[scrub/ack-hard] hard credential ack was not refused with exit=2: exit=${hardAck.exitCode} stderr=${hardAck.stderr}`,
    );
  }
  const softAck = runAsimp(
    [
      "scrub",
      "--stdin",
      "--mode",
      "artifact",
      "--ack-false-positive",
      "personal-address:1:13",
      "--json",
    ],
    "reach me at researcher@example.org for the data",
  );
  if (softAck.exitCode !== 0 || softAck.stdout.includes("researcher@example.org")) {
    diffs.push(`[scrub/ack-soft] soft personal-address ack failed: exit=${softAck.exitCode} stdout=${softAck.stdout}`);
  }

  if (diffs.length > 0) {
    throw new Error(`Scrub parity failed (${diffs.length} diffs):\n${diffs.join("\n")}`);
  }
  return ledgerCases.length + artifactCases.length + 2;
}

const validatedCount = await runValidateParity();
const scrubbedCount = runScrubParity();
console.log(
  JSON.stringify({
    ok: true,
    asimp_bin: ASIMP_BIN,
    validate_cases_checked: validatedCount,
    scrub_cases_checked: scrubbedCount,
    total_diffs: 0,
  }),
);
