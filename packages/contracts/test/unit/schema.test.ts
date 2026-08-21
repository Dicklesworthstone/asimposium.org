import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

import { generatedArtifacts } from "../../src/artifacts.ts";
import { type DiagnosticCode, REPRODUCE, safeDiagnostic } from "../../src/diagnostics.ts";
import {
  CONTRACT_PROBLEM_CODES,
  ContractProblemSchema,
  OPAQUE_PROBLEM_CODES,
  OpaqueProblemSchema,
  ProblemDocumentSchema,
} from "../../src/problem.ts";
import {
  REQUIRED_ROW_TOTAL_EXCLUSIONS,
  S2_COST_DURABLE_PUBLICATION_RESERVED_BYTES,
  S2_COST_DURABLE_PUBLICATION_RESERVED_NAMES,
  S2_COST_EVIDENCE_MANIFEST_VERSION,
  S2_COST_MANIFEST_RELATIVE_PATH,
  S2_COST_PUBLICATION_COMMIT_RECORD,
  S2_COST_PUBLICATION_COMMIT_SCHEMA_VERSION,
  S2_COST_PUBLICATION_RELATIVE_PATH,
  S2_COST_RECEIPT_BINDINGS_KEYS,
  S2_COST_RECEIPT_RECORD,
  S2_COST_RECEIPT_RELATIVE_PATH,
  S2_COST_RECEIPT_ROOT_KEYS,
  S2_COST_RECEIPT_SCHEMA_VERSION,
  S2CostEvidenceManifestSchema,
  S2CostMeasurementReceiptSchema,
  S2CostReceiptPublicationCommitSchema,
} from "../../src/s2-cost-receipt.ts";
import { ContractScaffoldSchema } from "../../src/schema.ts";

const VALID_FIXTURE = new URL("../fixtures/valid/contracts-scaffold.json", import.meta.url);
const INVALID_FIXTURE = new URL(
  "../fixtures/invalid/contracts-scaffold-stale.json",
  import.meta.url,
);
const CHECKED_IN_PROBLEM_SCHEMA = new URL("../../generated/problem.schema.json", import.meta.url);

function failureDiagnostic(suite: string, startedAt: number, code: DiagnosticCode): string {
  return safeDiagnostic({
    suite,
    status: "invalid",
    startedAt,
    code,
    reproduce: REPRODUCE.unit,
  });
}

async function readFixture(url: URL, suite: string): Promise<unknown> {
  const startedAt = performance.now();
  try {
    return JSON.parse(await Bun.file(url).text()) as unknown;
  } catch {
    throw new Error(failureDiagnostic(suite, startedAt, "FIXTURE_JSON_INVALID"));
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Extract the only two direct code shapes emitted by the current Zod generator. */
function directStringCodeMembers(schema: unknown, label: string): readonly string[] {
  if (!isRecord(schema) || schema.type !== "string") {
    throw new Error(`${label} must be a direct string enum or const`);
  }

  const hasEnum = Object.hasOwn(schema, "enum");
  const hasConst = Object.hasOwn(schema, "const");
  if (hasEnum === hasConst) {
    throw new Error(`${label} must contain exactly one of enum or const`);
  }

  const allowedKeys = hasEnum ? ["type", "enum"] : ["type", "const"];
  if (Object.keys(schema).some((key) => !allowedKeys.includes(key))) {
    throw new Error(`${label} must not contain JSON-Schema combinators or negation`);
  }

  if (hasEnum) {
    const enumMembers = schema.enum;
    if (!Array.isArray(enumMembers) || enumMembers.length === 0) {
      throw new Error(`${label} must be a nonempty string enum`);
    }
    const stringMembers = enumMembers.filter(
      (member): member is string => typeof member === "string",
    );
    if (stringMembers.length !== enumMembers.length) {
      throw new Error(`${label} enum must contain only strings`);
    }
    return stringMembers.sort();
  }

  if (typeof schema.const !== "string") {
    throw new Error(`${label} const must be a string`);
  }
  return [schema.const];
}

/**
 * The combinators a direct object branch may never carry. `oneOf` is absent on
 * purpose: it is what distinguishes the two accepted root shapes below, so it
 * is dispatched on rather than rejected outright.
 */
const PROBLEM_SCHEMA_COMBINATORS: readonly string[] = [
  "anyOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "$ref",
];

/** Extract the codes from one direct `{type: "object", properties: {code}}` branch. */
function directObjectProblemCodeMembers(branch: unknown, label: string): readonly string[] {
  if (!isRecord(branch) || branch.type !== "object" || !isRecord(branch.properties)) {
    throw new Error(`${label} must be an object branch with properties`);
  }
  if (branch.properties.code === undefined) {
    throw new Error(`${label} has no code property`);
  }
  return directStringCodeMembers(branch.properties.code, `${label}.properties.code`);
}

/** Extract direct `oneOf` object branches from the generated problem classes. */
function directOneOfProblemCodeMembers(schema: unknown, label: string): readonly string[] {
  if (!isRecord(schema) || !Array.isArray(schema.oneOf) || schema.oneOf.length === 0) {
    throw new Error(`${label} must be a direct nonempty oneOf array`);
  }
  if (Object.keys(schema).some((key) => key !== "oneOf")) {
    throw new Error(`${label} must not contain JSON-Schema combinators or negation`);
  }

  const members = new Set<string>();
  for (const [index, branch] of schema.oneOf.entries()) {
    for (const member of directObjectProblemCodeMembers(branch, `${label}.oneOf[${index}]`)) {
      members.add(member);
    }
  }
  return [...members].sort();
}

/**
 * The generator emits a problem class in exactly one of two direct shapes, and
 * which one it picks is a function of how many branches the union has: a
 * multi-branch class such as `contract_problem` becomes `{oneOf: [...]}`, while
 * a single-branch class such as `opaque_problem` collapses to the object
 * itself. Both are direct; neither is composed. Accepting only the first form
 * made this census throw on honest generated output, so it is the census that
 * was wrong, not the artifact.
 *
 * Strictness is preserved on both paths. A `oneOf` root must still carry that
 * key and nothing else, and a direct object root must carry no combinator at
 * all — so a mixed root that pairs an object with a composition, or a oneOf
 * root with extra sibling keys, is still refused.
 */
function directProblemCodeMembers(schema: unknown, label: string): readonly string[] {
  if (!isRecord(schema)) {
    throw new Error(`${label} must be a direct object or oneOf schema`);
  }
  if (Object.hasOwn(schema, "oneOf")) {
    return directOneOfProblemCodeMembers(schema, label);
  }
  if (PROBLEM_SCHEMA_COMBINATORS.some((key) => Object.hasOwn(schema, key))) {
    throw new Error(`${label} must not contain JSON-Schema combinators or negation`);
  }
  return directObjectProblemCodeMembers(schema, label);
}

function requiredSchemaProperty(document: unknown, name: string): unknown {
  if (!isRecord(document) || !isRecord(document.properties)) {
    throw new Error("checked-in problem schema has no root properties object");
  }
  const property = document.properties[name];
  if (property === undefined) {
    throw new Error(`checked-in problem schema has no ${name} property`);
  }
  return property;
}

test("valid scaffold fixture parses through the Zod source of truth", async () => {
  const startedAt = performance.now();
  const parsed = ContractScaffoldSchema.safeParse(
    await readFixture(VALID_FIXTURE, "schema.valid-fixture"),
  );

  if (!parsed.success) {
    throw new Error(failureDiagnostic("schema.valid-fixture", startedAt, "VALID_FIXTURE_REJECTED"));
  }

  expect(parsed.data.scope).toBe("non-product");
});

test("planted stale fixture is rejected by literal and strict-object checks", async () => {
  const startedAt = performance.now();
  const parsed = ContractScaffoldSchema.safeParse(
    await readFixture(INVALID_FIXTURE, "schema.stale-fixture"),
  );

  if (parsed.success) {
    throw new Error(failureDiagnostic("schema.stale-fixture", startedAt, "STALE_FIXTURE_ACCEPTED"));
  }

  expect(parsed.error.issues.some((issue) => issue.path[0] === "schema")).toBe(true);
  expect(parsed.error.issues.some((issue) => issue.code === "unrecognized_keys")).toBe(true);
});

test("S-2 cost receipt source is closed at root and binding keys", () => {
  const receipt = {
    schema_version: S2_COST_RECEIPT_SCHEMA_VERSION,
    record: S2_COST_RECEIPT_RECORD,
    run_id: "s2-contract",
    phase: "exercise",
    revision: "a".repeat(40),
    dirty_state: "clean",
    source_digest: "b".repeat(64),
    scope: "local-workerd-d1-do",
    bindings: { d1: "DB", durable_object: "KRATER_OUTBOX", r2: null },
    status: "pass",
    metric_scope: "selected-settled-write-receipts",
    write_receipt_count: 1,
    successful_batch_metric_scope: "settled-db.batch-only",
    failed_retry_batch_metrics: "excluded-d1-error-has-no-meta",
    write_claim_wall_scope: "writeClaim-entry-to-return",
    p95_write_phase_ms: 1,
    p95_preflight_wall_ms: 1,
    p95_write_claim_wall_ms: 1,
    sum_successful_batch_rows_read: 1,
    sum_successful_batch_rows_written: 1,
    sum_preflight_rows_read: 1,
    sum_preflight_rows_written: 0,
    sum_preflight_statements: 1,
    sum_retry_count: 0,
    known_row_total_exclusions: REQUIRED_ROW_TOTAL_EXCLUSIONS,
  };
  expect(Object.keys(receipt)).toEqual([...S2_COST_RECEIPT_ROOT_KEYS]);
  expect(Object.keys(receipt.bindings)).toEqual([...S2_COST_RECEIPT_BINDINGS_KEYS]);
  expect(S2CostMeasurementReceiptSchema.safeParse(receipt).success).toBe(true);
  expect(S2CostMeasurementReceiptSchema.safeParse({ ...receipt, unexpected: true }).success).toBe(
    false,
  );
  expect(
    S2CostMeasurementReceiptSchema.safeParse({
      ...receipt,
      bindings: { ...receipt.bindings, unexpected: true },
    }).success,
  ).toBe(false);
});

test("S-2 retained evidence manifest is a closed, bounded envelope", () => {
  const manifest = {
    manifest_version: S2_COST_EVIDENCE_MANIFEST_VERSION,
    run_id: "s2-contract",
    revision: "a".repeat(40),
    dirty_state: "clean",
    source_digest: "b".repeat(64),
    exit_code: 78,
    local_phase_status: {
      exercise: "pass",
      restart_verify: "pass",
      upgrade_existing: "pass",
      upgrade_empty: "pass",
      upgrade_journal_existing: "pass",
      upgrade_journal_empty: "pass",
    },
    retention: {
      retained: true,
      deletion_performed: false,
      max_bytes_per_run: 3_000_000,
      max_files_per_run: 7,
      retained_bytes_before_manifest: 1,
      retained_files_before_manifest: 1,
      durable_publication_reservation: {
        retained_names: S2_COST_DURABLE_PUBLICATION_RESERVED_NAMES,
        reserved_bytes_upper_bound: S2_COST_DURABLE_PUBLICATION_RESERVED_BYTES,
      },
    },
    s2_cost_receipt: {
      path: "s2-cost-input.json",
      digest: "c".repeat(64),
      bytes: 1,
    },
    files: [{ path: "s2-cost-input.json", bytes: 1, kind: "file" }],
  };
  expect(S2CostEvidenceManifestSchema.safeParse(manifest).success).toBe(true);
  expect(S2CostEvidenceManifestSchema.safeParse({ ...manifest, unexpected: true }).success).toBe(
    false,
  );
  expect(
    S2CostEvidenceManifestSchema.safeParse({
      ...manifest,
      retention: { ...manifest.retention, unexpected: true },
    }).success,
  ).toBe(false);
  expect(
    S2CostEvidenceManifestSchema.safeParse({
      ...manifest,
      files: [{ ...manifest.files[0], unexpected: true }],
    }).success,
  ).toBe(false);
  expect(
    S2CostEvidenceManifestSchema.safeParse({
      ...manifest,
      files: [{ ...manifest.files[0], path: "./s2-cost-input.json" }],
    }).success,
  ).toBe(false);
  expect(
    S2CostEvidenceManifestSchema.safeParse({
      ...manifest,
      files: [...manifest.files, manifest.files[0]],
    }).success,
  ).toBe(false);
  expect(
    S2CostEvidenceManifestSchema.safeParse({
      ...manifest,
      files: [{ ...manifest.files[0], bytes: 2 }],
    }).success,
  ).toBe(false);
  expect(
    S2CostEvidenceManifestSchema.safeParse({
      ...manifest,
      retention: {
        ...manifest.retention,
        max_bytes_per_run: Number.MAX_SAFE_INTEGER,
        retained_bytes_before_manifest: Number.MAX_SAFE_INTEGER,
      },
      files: [{ ...manifest.files[0], bytes: Number.MAX_SAFE_INTEGER }],
    }).success,
  ).toBe(false);
});

test("S-2 publication commit strictly binds all three preceding artifacts", () => {
  const commit = {
    schema_version: S2_COST_PUBLICATION_COMMIT_SCHEMA_VERSION,
    record: S2_COST_PUBLICATION_COMMIT_RECORD,
    manifest: { path: S2_COST_MANIFEST_RELATIVE_PATH, digest: "a".repeat(64) },
    receipt: {
      path: S2_COST_RECEIPT_RELATIVE_PATH,
      digest: "b".repeat(64),
      bytes: 1,
    },
    publication: { path: S2_COST_PUBLICATION_RELATIVE_PATH, digest: "c".repeat(64) },
  };
  expect(S2CostReceiptPublicationCommitSchema.safeParse(commit).success).toBe(true);
  expect(
    S2CostReceiptPublicationCommitSchema.safeParse({ ...commit, unexpected: true }).success,
  ).toBe(false);
  expect(
    S2CostReceiptPublicationCommitSchema.safeParse({
      ...commit,
      receipt: { ...commit.receipt, bytes: -1 },
    }).success,
  ).toBe(false);
});

test("the normal contract generator declares both S-2 receipt artifacts for drift checking", () => {
  expect(generatedArtifacts().map((artifact) => artifact.relativePath)).toEqual(
    expect.arrayContaining([
      "generated/s2-cost-receipt.schema.json",
      "generated/s2-cost-receipt.types.ts",
    ]),
  );
});

/**
 * W1.5 golden-corpus completeness (asimposiumorg-uir), first slice.
 *
 * The corpus IS the contract in executable form, so a refusal code the platform
 * can emit but the corpus has never validated is an unproven promise. The
 * existing per-code tables are hand-maintained, which means a new code with no
 * fixture is invisible to them: the table is both the input and the standard.
 *
 * These checks derive the two sides INDEPENDENTLY — codes from the imported
 * source enums, slugs from the fixture directory — so neither can be satisfied
 * by editing one list. The helpers below are pure so the plants can exercise
 * them on synthetic input without touching the filesystem.
 */
const CODE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FIXTURE_SLUG_PATTERN = /^problem-([a-z0-9]+(?:-[a-z0-9]+)*)\.json$/;
const TWIN_SLUG_PATTERN = /^([a-z0-9]+(?:-[a-z0-9]+)*)-(untaught|taught)$/;

type TwinDirection = "untaught" | "taught";

interface ProblemFixture {
  readonly filename: string;
  readonly slug: string;
  readonly url: URL;
}

function slugForCode(code: string): string {
  return code.toLowerCase().replaceAll("_", "-");
}

function problemFixtures(directory: "valid" | "invalid"): readonly ProblemFixture[] {
  const fixtureDirectory = new URL(`../fixtures/${directory}/`, import.meta.url);
  const fixtures: ProblemFixture[] = [];
  for (const filename of readdirSync(fixtureDirectory)) {
    if (!filename.startsWith("problem-") || !filename.endsWith(".json")) continue;
    const match = FIXTURE_SLUG_PATTERN.exec(filename);
    if (match === null) throw new Error(`problem fixture has an invalid slug: ${filename}`);
    // Under noUncheckedIndexedAccess a capture group is `string | undefined`
    // even when the pattern guarantees it. Refuse explicitly rather than
    // widening ProblemFixture.slug or asserting the group non-null: a slug that
    // failed to capture must fail this inventory loudly, not enter it as
    // undefined and mismatch a code slug later with no trace of why.
    const slug = match[1];
    if (slug === undefined) {
      throw new Error(`problem fixture slug did not capture: ${filename}`);
    }
    fixtures.push({ slug, filename, url: new URL(filename, fixtureDirectory) });
  }
  return fixtures.sort((left, right) => left.filename.localeCompare(right.filename));
}

function fixtureSlugs(directory: "valid" | "invalid"): readonly string[] {
  return problemFixtures(directory).map((fixture) => fixture.slug);
}

/** Slugs the source enums require that the directory does not supply. */
function uncovered(codeSlugs: readonly string[], present: readonly string[]): readonly string[] {
  const supplied = new Set(present);
  return codeSlugs.filter((slug) => !supplied.has(slug)).sort();
}

/** Fixture slugs no live code claims — a rename or deletion left them behind. */
function orphaned(codeSlugs: readonly string[], present: readonly string[]): readonly string[] {
  const required = new Set(codeSlugs);
  return present.filter((slug) => !required.has(slug)).sort();
}

interface ReasonedSlug {
  readonly slug: string;
  readonly reason: string;
}

interface ReasonedTwinDebt extends ReasonedSlug {
  readonly direction: TwinDirection;
}

/**
 * Every code that has no valid golden fixture today, with the reason it is
 * still owed. This is recorded debt, not a permanent exclusion list: the
 * assertion below is a SUBSET check, so landing a fixture shrinks the gap
 * without touching this file, while a code that is neither covered nor listed
 * fails immediately. Equality would red on a peer's correct work.
 */
const CORPUS_COVERAGE_DEBT: readonly ReasonedSlug[] = Object.freeze([
  Object.freeze({ slug: "body-only-required", reason: "W1.5: request-shape family unwritten." }),
  Object.freeze({ slug: "path-only-required", reason: "W1.5: request-shape family unwritten." }),
  Object.freeze({ slug: "capsule-unavailable", reason: "W1.5: availability family unwritten." }),
  Object.freeze({ slug: "device-code-unknown", reason: "W1.5: availability family unwritten." }),
  Object.freeze({ slug: "device-lookup-locked", reason: "W1.5: availability family unwritten." }),
  Object.freeze({ slug: "enrollment-unavailable", reason: "W1.5: availability family unwritten." }),
  Object.freeze({ slug: "sponsor-auth-unavailable", reason: "W1.5: availability family owed." }),
  Object.freeze({ slug: "credential-revoke-body-invalid", reason: "W1.5: lifecycle family owed." }),
  Object.freeze({ slug: "fellow-lifecycle-body-invalid", reason: "W1.5: lifecycle family owed." }),
  Object.freeze({ slug: "fellow-lifecycle-not-current", reason: "W1.5: lifecycle family owed." }),
  Object.freeze({ slug: "fellow-token-invalid", reason: "W1.5: lifecycle family owed." }),
  Object.freeze({ slug: "decision-body-invalid", reason: "W1.5: sponsor-decision family owed." }),
  Object.freeze({ slug: "decision-target-mismatch", reason: "W1.5: decision family owed." }),
  Object.freeze({ slug: "harness-as-name", reason: "W1.5: P-EN-NAME policy family owed." }),
  Object.freeze({ slug: "model-as-name", reason: "W1.5: P-EN-NAME policy family owed." }),
  Object.freeze({ slug: "name-invalid", reason: "W1.5: P-EN-NAME policy family owed." }),
  Object.freeze({ slug: "name-reserved", reason: "W1.5: P-EN-NAME policy family owed." }),
  Object.freeze({ slug: "name-taken", reason: "W1.5: P-EN-NAME policy family owed." }),
  Object.freeze({ slug: "idempotency-conflict", reason: "W1.5: replay family owed." }),
  Object.freeze({ slug: "idempotency-key-invalid", reason: "W1.5: replay family owed." }),
  Object.freeze({ slug: "flow-invalid", reason: "W1.5: proposal-state family owed." }),
  Object.freeze({ slug: "pairing-invalid", reason: "W1.5: proposal-state family owed." }),
  Object.freeze({ slug: "proposal-expired", reason: "W1.5: proposal-state family owed." }),
  Object.freeze({ slug: "proposal-not-pending", reason: "W1.5: proposal-state family owed." }),
  Object.freeze({ slug: "scope-escalation", reason: "W1.5: grant-scope family owed." }),
  Object.freeze({ slug: "scope-not-reduced", reason: "W1.5: grant-scope family owed." }),
  Object.freeze({ slug: "sponsor-panic-body-invalid", reason: "W1.5: panic family owed." }),
  Object.freeze({ slug: "step-up-required", reason: "W1.5: authorization family owed." }),
  Object.freeze({ slug: "wrong-principal", reason: "W1.5: authorization family owed." }),
]);

/**
 * Covered contract failures need an invalid `-untaught` twin; covered opaque
 * failures need an invalid `-taught` twin. As with coverage debt, a landed
 * fixture may leave a now-stale entry temporarily without blocking a peer.
 */
const CORPUS_TRANSPARENCY_TWIN_DEBT: readonly ReasonedTwinDebt[] = Object.freeze([
  Object.freeze({
    slug: "device-code-body-invalid",
    direction: "untaught",
    reason: "W1.5: teaching-twin fixture unwritten.",
  }),
  Object.freeze({
    slug: "enrollment-id-invalid",
    direction: "untaught",
    reason: "W1.5: teaching-twin fixture unwritten.",
  }),
  Object.freeze({
    slug: "json-content-type-required",
    direction: "untaught",
    reason: "W1.5: teaching-twin fixture unwritten.",
  }),
  Object.freeze({
    slug: "operator-fellow-cap-body-invalid",
    direction: "untaught",
    reason: "W1.5: teaching-twin fixture unwritten.",
  }),
  Object.freeze({
    slug: "operator-fellow-cap-history-cursor-invalid",
    direction: "untaught",
    reason: "W1.5: teaching-twin fixture unwritten.",
  }),
  Object.freeze({
    slug: "registration-body-invalid",
    direction: "untaught",
    reason: "W1.5: teaching-twin fixture unwritten.",
  }),
  Object.freeze({
    slug: "sponsor-bootstrap-body-invalid",
    direction: "untaught",
    reason: "W1.5: teaching-twin fixture unwritten.",
  }),
  Object.freeze({
    slug: "unknown-format",
    direction: "untaught",
    reason: "W1.5: teaching-twin fixture unwritten.",
  }),
  Object.freeze({
    slug: "unknown-profile",
    direction: "untaught",
    reason: "W1.5: teaching-twin fixture unwritten.",
  }),
  Object.freeze({
    slug: "auth-replay-store-unavailable",
    direction: "taught",
    reason: "W1.5: opaque-twin fixture unwritten.",
  }),
  Object.freeze({
    slug: "internal-error",
    direction: "taught",
    reason: "W1.5: opaque-twin fixture unwritten.",
  }),
  Object.freeze({
    slug: "lifecycle-busy",
    direction: "taught",
    reason: "W1.5: opaque-twin fixture unwritten.",
  }),
  Object.freeze({
    slug: "operator-auth-unavailable",
    direction: "taught",
    reason: "W1.5: opaque-twin fixture unwritten.",
  }),
  Object.freeze({
    slug: "operator-fellow-cap-not-current",
    direction: "taught",
    reason: "W1.5: opaque-twin fixture unwritten.",
  }),
  Object.freeze({
    slug: "request-body-too-large",
    direction: "taught",
    reason: "W1.5: opaque-twin fixture unwritten.",
  }),
  Object.freeze({
    slug: "route-not-found",
    direction: "taught",
    reason: "W1.5: opaque-twin fixture unwritten.",
  }),
  Object.freeze({
    slug: "unauthorized",
    direction: "taught",
    reason: "W1.5: opaque-twin fixture unwritten.",
  }),
]);

function assertReasoned(
  entries: readonly ReasonedSlug[],
  liveCodeSlugs: ReadonlySet<string>,
): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.reason.trim().length === 0) {
      throw new Error(`corpus debt entry ${entry.slug} carries no reason`);
    }
    if (!CODE_SLUG_PATTERN.test(entry.slug)) {
      throw new Error(`corpus debt entry ${entry.slug} has an invalid slug`);
    }
    if (!liveCodeSlugs.has(entry.slug)) {
      throw new Error(`corpus debt entry ${entry.slug} is not a live code`);
    }
    if (seen.has(entry.slug)) {
      throw new Error(`corpus debt entry ${entry.slug} is duplicated`);
    }
    seen.add(entry.slug);
  }
}

const CONTRACT_CODE_SLUGS = CONTRACT_PROBLEM_CODES.map(slugForCode).sort();
const OPAQUE_CODE_SLUGS = OPAQUE_PROBLEM_CODES.map(slugForCode).sort();
const ALL_CODE_SLUGS = [...CONTRACT_CODE_SLUGS, ...OPAQUE_CODE_SLUGS].sort();

function requiredTwinSlugs(
  contractCodeSlugs: readonly string[],
  opaqueCodeSlugs: readonly string[],
  coveredSlugs: readonly string[],
): Readonly<Record<TwinDirection, readonly string[]>> {
  const covered = new Set(coveredSlugs);
  return {
    untaught: contractCodeSlugs
      .filter((slug) => covered.has(slug))
      .map((slug) => `${slug}-untaught`)
      .sort(),
    taught: opaqueCodeSlugs
      .filter((slug) => covered.has(slug))
      .map((slug) => `${slug}-taught`)
      .sort(),
  };
}

function twinFixtureSlugs(slugs: readonly string[]): readonly string[] {
  return slugs.filter((slug) => TWIN_SLUG_PATTERN.test(slug)).sort();
}

/** Twin files must use the suffix that corresponds to their source transparency class. */
function misdirectedTwinSlugs(
  required: Readonly<Record<TwinDirection, readonly string[]>>,
  supplied: readonly string[],
): readonly string[] {
  const expected = new Set([...required.untaught, ...required.taught]);
  return supplied.filter((slug) => !expected.has(slug)).sort();
}

function assertReasonedTwinDebt(
  entries: readonly ReasonedTwinDebt[],
  liveCodeSlugs: ReadonlySet<string>,
  contractCodeSlugs: ReadonlySet<string>,
  opaqueCodeSlugs: ReadonlySet<string>,
): void {
  assertReasoned(entries, liveCodeSlugs);
  for (const entry of entries) {
    const codes = entry.direction === "untaught" ? contractCodeSlugs : opaqueCodeSlugs;
    if (!codes.has(entry.slug)) {
      throw new Error(`corpus twin debt entry ${entry.slug} has the wrong direction`);
    }
  }
}

test("the checked-in published problem schema matches the current refusal code classes", () => {
  const published = JSON.parse(readFileSync(CHECKED_IN_PROBLEM_SCHEMA, "utf8")) as unknown;
  const expectedContract = [...CONTRACT_PROBLEM_CODES].sort();
  const expectedOpaque = [...OPAQUE_PROBLEM_CODES].sort();

  expect(
    directStringCodeMembers(requiredSchemaProperty(published, "problem_code"), "problem_code"),
  ).toEqual([...expectedContract, ...expectedOpaque].sort());
  // Both classes go through the same extractor, and the exact class equality is
  // unchanged: contract_problem is a multi-branch oneOf, opaque_problem is the
  // single collapsed object branch, and each must still yield exactly its own
  // code set with no leakage between the two.
  expect(
    directProblemCodeMembers(
      requiredSchemaProperty(published, "contract_problem"),
      "contract_problem",
    ),
  ).toEqual(expectedContract);
  expect(
    directProblemCodeMembers(requiredSchemaProperty(published, "opaque_problem"), "opaque_problem"),
  ).toEqual(expectedOpaque);
});

test("every valid problem fixture maps filename, parsed code, and transparency class", async () => {
  const contractCodeSlugs = new Set(CONTRACT_CODE_SLUGS);
  const opaqueCodeSlugs = new Set(OPAQUE_CODE_SLUGS);
  const fixtures = problemFixtures("valid");
  expect(fixtures.length).toBeGreaterThan(0);

  for (const fixture of fixtures) {
    const document = await readFixture(fixture.url, `schema.problem-fixture.${fixture.filename}`);
    const parsed = ProblemDocumentSchema.safeParse(document);
    expect(parsed.success, fixture.filename).toBe(true);
    if (!parsed.success) continue;

    expect(slugForCode(parsed.data.code), fixture.filename).toBe(fixture.slug);
    expect(ContractProblemSchema.safeParse(document).success, fixture.filename).toBe(
      contractCodeSlugs.has(fixture.slug),
    );
    expect(OpaqueProblemSchema.safeParse(document).success, fixture.filename).toBe(
      opaqueCodeSlugs.has(fixture.slug),
    );
  }
});

test("every refusal code is covered by a golden fixture or recorded as debt", () => {
  const present = fixtureSlugs("valid");
  const gap = uncovered(ALL_CODE_SLUGS, present);
  const recorded = new Set(CORPUS_COVERAGE_DEBT.map((entry) => entry.slug));
  const liveCodeSlugs = new Set(ALL_CODE_SLUGS);

  // Nonvacuity: the enums and the directory must both be real before a subset
  // check means anything. An empty either side would pass silently.
  expect(ALL_CODE_SLUGS.length).toBeGreaterThan(0);
  expect(present.length).toBeGreaterThan(0);

  expect(gap.filter((slug) => !recorded.has(slug))).toEqual([]);
  assertReasoned(CORPUS_COVERAGE_DEBT, liveCodeSlugs);
  expect(Object.isFrozen(CORPUS_COVERAGE_DEBT)).toBe(true);
});

test("no golden fixture outlives the refusal code it was written for", () => {
  expect(orphaned(ALL_CODE_SLUGS, fixtureSlugs("valid"))).toEqual([]);
});

test("transparency twins have the right direction or separately recorded debt", () => {
  const covered = fixtureSlugs("valid");
  const invalid = fixtureSlugs("invalid");
  const required = requiredTwinSlugs(CONTRACT_CODE_SLUGS, OPAQUE_CODE_SLUGS, covered);
  const missing = [
    ...uncovered(required.untaught, invalid),
    ...uncovered(required.taught, invalid),
  ];
  const recorded = new Set(
    CORPUS_TRANSPARENCY_TWIN_DEBT.map((entry) => `${entry.slug}-${entry.direction}`),
  );

  expect(missing.filter((slug) => !recorded.has(slug))).toEqual([]);
  expect(misdirectedTwinSlugs(required, twinFixtureSlugs(invalid))).toEqual([]);
  assertReasonedTwinDebt(
    CORPUS_TRANSPARENCY_TWIN_DEBT,
    new Set(ALL_CODE_SLUGS),
    new Set(CONTRACT_CODE_SLUGS),
    new Set(OPAQUE_CODE_SLUGS),
  );
  expect(Object.isFrozen(CORPUS_TRANSPARENCY_TWIN_DEBT)).toBe(true);
});

test("PLANTED: strict problem-code extractors accept direct branches and refuse composition", () => {
  const directEnum = { type: "string", enum: ["ALPHA", "BETA"] };
  const directConst = { type: "string", const: "GAMMA" };
  const branches = {
    oneOf: [
      { type: "object", properties: { code: directEnum } },
      { type: "object", properties: { code: directConst } },
    ],
  };

  expect(directStringCodeMembers(directEnum, "direct_enum")).toEqual(["ALPHA", "BETA"]);
  expect(directStringCodeMembers(directConst, "direct_const")).toEqual(["GAMMA"]);
  expect(directOneOfProblemCodeMembers(branches, "branches")).toEqual(["ALPHA", "BETA", "GAMMA"]);
  expect(() =>
    directStringCodeMembers(
      { type: "string", enum: ["ALPHA"], not: { const: "NOT_ONLY" } },
      "negated",
    ),
  ).toThrow("must not contain JSON-Schema combinators or negation");
  expect(() =>
    directOneOfProblemCodeMembers(
      {
        oneOf: [{ type: "object", properties: { code: { anyOf: [directEnum, directConst] } } }],
      },
      "composed",
    ),
  ).toThrow("must be a direct string enum or const");

  // The generator collapses a single-branch problem class to the object itself,
  // with no oneOf wrapper. That shape is direct and must be accepted, or the
  // census throws on honest output — the failure this repair closes.
  const collapsed = {
    type: "object",
    properties: { code: directEnum },
    required: ["code"],
    additionalProperties: false,
  };
  expect(directProblemCodeMembers(collapsed, "collapsed")).toEqual(["ALPHA", "BETA"]);
  // Positive control for the other accepted root, through the same extractor,
  // so acceptance of the collapsed form did not come at the cost of the oneOf
  // form or quietly merge the two.
  expect(directProblemCodeMembers(branches, "branches")).toEqual(["ALPHA", "BETA", "GAMMA"]);

  // Tolerating two roots must not tolerate a mixture of them. A root that pairs
  // a direct object with a composition keyword is exactly the form an extractor
  // that merely "looked for a code somewhere" would accept. This list is spelled
  // out rather than read from PROBLEM_SCHEMA_COMBINATORS on purpose: derived
  // from the constant it would still pass after someone shortened the constant,
  // which is the regression it exists to catch.
  for (const combinator of ["anyOf", "allOf", "not", "if", "then", "else", "$ref"]) {
    expect(() =>
      directProblemCodeMembers({ ...collapsed, [combinator]: {} }, `mixed_${combinator}`),
    ).toThrow("must not contain JSON-Schema combinators or negation");
  }
  // A oneOf root keeps its exact-key strictness: a sibling key alongside oneOf
  // is a composed root, not a direct one.
  expect(() => directProblemCodeMembers({ ...branches, type: "object" }, "mixed_root")).toThrow(
    "must not contain JSON-Schema combinators or negation",
  );
  // And neither root may be empty or a non-object.
  expect(() => directProblemCodeMembers({ oneOf: [] }, "empty_oneof")).toThrow(
    "must be a direct nonempty oneOf array",
  );
  expect(() => directProblemCodeMembers("not-a-schema", "scalar")).toThrow(
    "must be a direct object or oneOf schema",
  );
  expect(() => directProblemCodeMembers({ type: "object", properties: {} }, "no_code")).toThrow(
    "has no code property",
  );
});

test("PLANTED: the coverage helpers detect a synthetic omission and a synthetic orphan", () => {
  // Pure inputs: no filesystem, no enum. A helper that returned [] regardless
  // would satisfy every assertion above and prove nothing; these fail it.
  expect(uncovered(["alpha", "beta"], ["alpha"])).toEqual(["beta"]);
  expect(uncovered(["alpha"], ["alpha"])).toEqual([]);
  expect(orphaned(["alpha"], ["alpha", "stale"])).toEqual(["stale"]);
  expect(orphaned(["alpha"], ["alpha"])).toEqual([]);

  // A code added to the enums without a fixture and without a debt entry is
  // exactly the regression this slice exists to catch.
  const recorded = new Set(CORPUS_COVERAGE_DEBT.map((entry) => entry.slug));
  const invented = uncovered([...ALL_CODE_SLUGS, "made-up-code"], fixtureSlugs("valid"));
  expect(invented).toContain("made-up-code");
  expect(invented.filter((slug) => !recorded.has(slug))).toEqual(["made-up-code"]);

  expect(slugForCode("FELLOW_CREDENTIAL_CAP_REACHED")).toBe("fellow-credential-cap-reached");
});

test("PLANTED: debt entries require a reasoned, unique live slug", () => {
  const liveCodeSlugs = new Set(["alpha"]);
  expect(() => assertReasoned([{ slug: "alpha", reason: "   " }], liveCodeSlugs)).toThrow(
    "carries no reason",
  );
  expect(() => assertReasoned([{ slug: "alpha--bad", reason: "owed" }], liveCodeSlugs)).toThrow(
    "invalid slug",
  );
  expect(() => assertReasoned([{ slug: "omega", reason: "owed" }], liveCodeSlugs)).toThrow(
    "not a live code",
  );
  expect(() =>
    assertReasoned(
      [
        { slug: "alpha", reason: "one" },
        { slug: "alpha", reason: "two" },
      ],
      liveCodeSlugs,
    ),
  ).toThrow("duplicated");
  expect(() => assertReasoned([{ slug: "alpha", reason: "owed" }], liveCodeSlugs)).not.toThrow();
});

test("PLANTED: required twins detect missing and misdirected transparency fixtures", () => {
  const required = requiredTwinSlugs(["alpha"], ["omega"], ["alpha", "omega"]);
  expect(required).toEqual({ untaught: ["alpha-untaught"], taught: ["omega-taught"] });
  expect(uncovered(required.untaught, [])).toEqual(["alpha-untaught"]);
  expect(uncovered(required.taught, [])).toEqual(["omega-taught"]);
  expect(
    misdirectedTwinSlugs(required, [
      "alpha-untaught",
      "omega-taught",
      "alpha-taught",
      "omega-untaught",
    ]),
  ).toEqual(["alpha-taught", "omega-untaught"]);
  expect(() =>
    assertReasonedTwinDebt(
      [{ slug: "alpha", direction: "taught", reason: "wrong direction" }],
      new Set(["alpha", "omega"]),
      new Set(["alpha"]),
      new Set(["omega"]),
    ),
  ).toThrow("wrong direction");
});
