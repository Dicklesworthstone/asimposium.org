#!/usr/bin/env node
/**
 * Seed-source contract for W12.P2.
 *
 * This intentionally validates source preparation only. It does not assert a
 * mathematical result, fetch a proof, or substitute for the named external
 * review gate in the dossiers.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, "../../..");
const SOURCE_AUDIT_DATE = "2026-08-17";
const requiredChecks = [
  "exact_formulation",
  "variant_distinctions",
  "primary_anchors",
  "falsifier",
  "settlement_and_no_claim",
  "bounded_subgoals",
  "safety",
  "freshness",
  "external_expert_gate",
  "rendered_face",
];

export const sourcePaths = {
  sp4d: resolve(here, "dossier.json"),
  sp4dMarkdown: resolve(here, "SP4D.md"),
  slate: resolve(here, "../frontier-slate/dossiers.json"),
  matrix: resolve(here, "review-matrix.json"),
  report: resolve(here, "review-report.json"),
};

function diagnostic(code, dossier, detail) {
  return { code, dossier, detail };
}

function hasAnchor(reference) {
  return typeof reference.locator === "string" && reference.locator.trim().length >= 8;
}

function hasRightsRecord(reference) {
  return typeof reference.license_or_rights === "string"
    && reference.license_or_rights.trim().length >= 40
    && /(?:license|rights)/i.test(reference.license_or_rights)
    && /(?:citation|link)/i.test(reference.license_or_rights)
    && /(?:no source text|no paper text|no PDF)/i.test(reference.license_or_rights);
}

function variantIsConflated(dossier) {
  return dossier.variant_distinctions?.some(({ distinction = "" }) =>
    /\b(topological|smooth|PL)\b[\s\S]{0,90}\b(same|identical|equivalent)\b|\b(same|identical|equivalent)\b[\s\S]{0,90}\b(topological|smooth|PL)\b/i.test(distinction),
  );
}

function requiredString(dossier, field, errors) {
  const minimumLength = field === "id" ? 3 : 12;
  if (typeof dossier[field] !== "string" || dossier[field].trim().length < minimumLength) {
    errors.push(diagnostic("MISSING_REQUIRED_TEXT", dossier.id ?? "<unknown>", field));
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function digestDossier(dossier) {
  return sha256(JSON.stringify(canonicalize(dossier)));
}

function validateStatusFreshness(dossier, errors) {
  const freshness = dossier.status_freshness;
  const id = dossier.id ?? "<unknown>";
  if (freshness?.source_audit_date !== SOURCE_AUDIT_DATE || freshness?.prepublication_recheck_required !== true) {
    errors.push(diagnostic("FRESHNESS_POLICY_INVALID", id, `Use source audit date ${SOURCE_AUDIT_DATE} and require a pre-publication recheck.`));
    return;
  }
  if (!['uncertain', 'blocked'].includes(freshness.registry_access)) {
    errors.push(diagnostic("STATUS_REGISTRY_ACCESS_INVALID", id, "registry_access must be uncertain or blocked; a draft cannot self-certify a live status."));
  }
  if (typeof freshness.registry_access_note !== "string" || freshness.registry_access_note.trim().length < 24) {
    errors.push(diagnostic("STATUS_REGISTRY_ACCESS_INVALID", id, "registry_access_note must explain the uncertainty or block."));
  }
  if (!Array.isArray(freshness.status_source_ids) || freshness.status_source_ids.length === 0) {
    errors.push(diagnostic("STATUS_SOURCE_BINDING_INVALID", id, "status_source_ids must name at least one anchored primary or official source."));
    return;
  }
  const referenceIds = new Set((dossier.references ?? []).map((reference) => reference.id));
  for (const sourceId of freshness.status_source_ids) {
    if (typeof sourceId !== "string" || !referenceIds.has(sourceId)) {
      errors.push(diagnostic("STATUS_SOURCE_BINDING_INVALID", id, `status source ${String(sourceId)} is not an anchored reference.`));
    }
  }
}

export function validateDossier(dossier) {
  const errors = [];
  const id = dossier.id ?? "<unknown>";
  for (const field of [
    "id",
    "title",
    "formulation",
    "scope",
    "out_of_scope",
    "motivation",
    "falsifier",
    "settlement_conditions",
    "no_resolution_language",
    "safety",
    "external_expert_requirements",
  ]) {
    requiredString(dossier, field, errors);
  }
  if (Object.hasOwn(dossier, "current_status")) {
    errors.push(diagnostic("UNSUPPORTED_CURRENT_STATUS_FIELD", id, "Use status_freshness plus a pre-publication recheck requirement."));
  }
  validateStatusFreshness(dossier, errors);
  if (!Array.isArray(dossier.variant_distinctions) || dossier.variant_distinctions.length < 2) {
    errors.push(diagnostic("MISSING_VARIANT_DISTINCTIONS", id, "At least two distinctions are required."));
  }
  if (id === "SP4D" && !/topological[\s\S]*PL[\s\S]*smooth|smooth[\s\S]*topological[\s\S]*PL|PL[\s\S]*topological[\s\S]*smooth/i.test(dossier.formulation ?? "")) {
    errors.push(diagnostic("MISSING_CATEGORY_VARIANTS", id, "The exact formulation must explicitly name topological, PL, and smooth variants."));
  }
  if (variantIsConflated(dossier)) {
    errors.push(diagnostic("CONFLATED_VARIANT", id, "Category variants must be distinguished, never equated."));
  }
  if (!Array.isArray(dossier.references) || dossier.references.length === 0) {
    errors.push(diagnostic("MISSING_PRIMARY_REFERENCE", id, "At least one primary or official source is required."));
  } else {
    for (const reference of dossier.references) {
      if (reference.authority !== "primary" && reference.authority !== "official") {
        errors.push(diagnostic("NONAUTHORITATIVE_REFERENCE", id, reference.id ?? "<unnamed reference>"));
      }
      if (typeof reference.url !== "string" || !reference.url.startsWith("https://")) {
        errors.push(diagnostic("INVALID_SOURCE_URL", id, reference.id ?? "<unnamed reference>"));
      }
      if (!hasAnchor(reference)) {
        errors.push(diagnostic("MISSING_SOURCE_ANCHOR", id, reference.id ?? "<unnamed reference>"));
      }
      if (!hasRightsRecord(reference)) {
        errors.push(diagnostic("MISSING_SOURCE_RIGHTS", id, reference.id ?? "<unnamed reference>"));
      }
    }
  }
  if (!Array.isArray(dossier.bounded_subgoals) || dossier.bounded_subgoals.length === 0) {
    errors.push(diagnostic("MISSING_BOUNDED_SUBGOAL", id, "At least one bounded, falsifiable subgoal is required."));
  } else {
    for (const subgoal of dossier.bounded_subgoals) {
      for (const field of ["id", "question", "falsifier", "boundary", "evidence_artifact"]) {
        const minimumLength = field === "id" ? 3 : 8;
        if (typeof subgoal[field] !== "string" || subgoal[field].trim().length < minimumLength) {
          errors.push(diagnostic("SUBGOAL_CONTRACT_INVALID", id, `${subgoal.id ?? "<unnamed>"}.${field}`));
        }
      }
    }
  }
  return errors;
}

export function renderDossier(dossier) {
  const variants = dossier.variant_distinctions.map(({ variant, distinction }) => `- **${variant}:** ${distinction}`).join("\n");
  const references = dossier.references.map((reference) => `- [${reference.id}](${reference.url}) — ${reference.locator}\n  - License/rights: ${reference.license_or_rights}`).join("\n");
  const subgoals = dossier.bounded_subgoals.map((subgoal) => `- **${subgoal.id}:** ${subgoal.question}\n  - Falsifier: ${subgoal.falsifier}\n  - Boundary: ${subgoal.boundary}\n  - Evidence artifact: ${subgoal.evidence_artifact}`).join("\n");
  return `# ${dossier.id}: ${dossier.title}\n\n**Draft source only.** ${dossier.no_resolution_language}\n\n## Exact formulation\n\n${dossier.formulation}\n\n## Scope\n\n${dossier.scope}\n\n## Out of scope\n\n${dossier.out_of_scope}\n\n## Variant distinctions\n\n${variants}\n\n## Falsifier and settlement\n\n- Falsifier: ${dossier.falsifier}\n- Settlement condition: ${dossier.settlement_conditions}\n\n## Bounded subgoals\n\n${subgoals}\n\n## Anchored primary references\n\n${references}\n\n## Safety\n\n${dossier.safety}\n\n## External review gate\n\n${dossier.external_expert_requirements}\n\n## Freshness\n\nSource audit date: ${dossier.status_freshness.source_audit_date}. A pre-publication status recheck is mandatory.\n`;
}

export function validateSp4dMarkdown(markdown, dossier) {
  const errors = [];
  if (!markdown.startsWith("# SP4D")) {
    errors.push(diagnostic("SP4D_MARKDOWN_CONTRACT_INVALID", dossier.id, "missing SP4D heading"));
  }
  for (const reference of dossier.references) {
    if (!markdown.includes(reference.url)) {
      errors.push(diagnostic("SP4D_MARKDOWN_SOURCE_DRIFT", dossier.id, reference.id));
    }
    if (!markdown.includes(reference.locator)) {
      errors.push(diagnostic("SP4D_MARKDOWN_ANCHOR_DRIFT", dossier.id, reference.id));
    }
  }
  return errors;
}

export function validateNewTheoryTemplate(template) {
  const errors = [];
  const requiredFields = [
    "exact construction",
    "explicit predictions",
    "consistency checks",
    "distinction from established theory",
    "falsifier",
    "bounded first test",
    "safety and dual-use note",
    "external-expert review plan",
  ];
  if (!Array.isArray(template?.required_fields) || requiredFields.some((field) => !template.required_fields.includes(field))) {
    errors.push(diagnostic("NEW_THEORY_TEMPLATE_INCOMPLETE", "NEW-THEORY-WORKSHOP-TEMPLATE", "All prediction, consistency, boundary, safety, and review fields are required."));
  }
  for (const field of ["admission_rule", "no_claim_boundary"]) {
    if (typeof template?.[field] !== "string" || template[field].trim().length < 24) {
      errors.push(diagnostic("NEW_THEORY_TEMPLATE_INCOMPLETE", "NEW-THEORY-WORKSHOP-TEMPLATE", field));
    }
  }
  return errors;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function validateMatrix(matrix, dossiers, sourceTexts) {
  const errors = [];
  for (const field of ["consumer", "gate", "observed_defect_class", "deletion_condition"]) {
    if (typeof matrix[field] !== "string" || matrix[field].trim().length < 8) {
      errors.push(diagnostic("MATRIX_METADATA_INVALID", "review-matrix", field));
    }
  }
  if (matrix.prepared_at !== SOURCE_AUDIT_DATE) {
    errors.push(diagnostic("MATRIX_METADATA_INVALID", "review-matrix", `prepared_at must be ${SOURCE_AUDIT_DATE}.`));
  }
  for (const [path, text] of Object.entries(sourceTexts)) {
    if (matrix.source_digests?.[path] !== sha256(text)) {
      errors.push(diagnostic("MATRIX_SOURCE_DIGEST_MISMATCH", "review-matrix", path));
    }
  }
  for (const dossier of dossiers) {
    if (matrix.dossier_digests?.[dossier.id] !== digestDossier(dossier)) {
      errors.push(diagnostic("MATRIX_DOSSIER_DIGEST_MISMATCH", "review-matrix", dossier.id));
    }
  }
  const reviewState = matrix.review_state;
  if (reviewState?.approval_state !== "external_review_pending") {
    errors.push(diagnostic("MATRIX_APPROVAL_STATE_INVALID", "review-matrix", "Source preparation cannot self-approve mathematical validity."));
  }
  if (typeof reviewState?.independence_requirement !== "string" || reviewState.independence_requirement.trim().length < 24) {
    errors.push(diagnostic("MATRIX_REVIEWER_INDEPENDENCE_INVALID", "review-matrix", "An external-review independence requirement is mandatory."));
  }
  if (!Array.isArray(reviewState?.reviewer_records) || reviewState.reviewer_records.length === 0 || reviewState.reviewer_records.some((record) => typeof record.independence !== "string" || typeof record.approval_state !== "string")) {
    errors.push(diagnostic("MATRIX_REVIEWER_INDEPENDENCE_INVALID", "review-matrix", "Each reviewer record must state independence and approval state."));
  }
  if (!Array.isArray(matrix.unresolved_questions) || matrix.unresolved_questions.length === 0) {
    errors.push(diagnostic("MATRIX_UNRESOLVED_QUESTIONS_INVALID", "review-matrix", "At least one unresolved question is required."));
  }
  const ids = dossiers.map((dossier) => dossier.id);
  const rows = Array.isArray(matrix.dossiers) ? matrix.dossiers : [];
  if (rows.length !== ids.length || new Set(rows.map((row) => row.id)).size !== ids.length) {
    errors.push(diagnostic("MATRIX_COVERAGE_INVALID", "review-matrix", "Every dossier needs exactly one row."));
  }
  for (const id of ids) {
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) {
      errors.push(diagnostic("MATRIX_MISSING_DOSSIER", "review-matrix", id));
      continue;
    }
    for (const check of requiredChecks) {
      if (row.checks?.[check] !== "required") {
        errors.push(diagnostic("MATRIX_CHECK_MISSING", id, check));
      }
    }
  }
  return errors;
}

function validateReport(report, sourceTexts) {
  const errors = [];
  if (report.prepared_at !== SOURCE_AUDIT_DATE) {
    errors.push(diagnostic("REPORT_FRESHNESS_INVALID", "review-report", `prepared_at must be ${SOURCE_AUDIT_DATE}.`));
  }
  if (report.approval_state !== "external_review_pending") {
    errors.push(diagnostic("REPORT_APPROVAL_STATE_INVALID", "review-report", "Source preparation cannot self-approve mathematical validity."));
  }
  if (report.external_review?.required !== true || !Array.isArray(report.external_review?.required_expertise) || report.external_review.required_expertise.length < 2) {
    errors.push(diagnostic("REPORT_EXTERNAL_REVIEW_GATE_MISSING", "review-report", "Name independent external expertise."));
  }
  for (const [path, text] of Object.entries(sourceTexts)) {
    if (report.source_digests?.[path] !== sha256(text)) {
      errors.push(diagnostic("REPORT_DIGEST_MISMATCH", "review-report", path));
    }
  }
  for (const field of ["reviewer_record", "unresolved_questions", "corrections"]) {
    if (!Array.isArray(report[field])) {
      errors.push(diagnostic("REPORT_FIELD_INVALID", "review-report", field));
    }
  }
  return errors;
}

async function verifyLinks(dossiers) {
  const results = await Promise.all(dossiers.flatMap((dossier) => dossier.references.map(async (reference) => {
    try {
      const response = await fetch(reference.url, { method: "GET", headers: { Range: "bytes=0-0" }, signal: AbortSignal.timeout(12_000), redirect: "follow" });
      return response.ok || response.status === 403 ? null : diagnostic("SOURCE_LINK_UNAVAILABLE", dossier.id, `${reference.id}: HTTP ${response.status}`);
    } catch (error) {
      return diagnostic("SOURCE_LINK_UNAVAILABLE", dossier.id, `${reference.id}: ${error.name}`);
    }
  })));
  return results.filter(Boolean);
}

export async function runCheck({ verifyLinks: shouldVerifyLinks = false } = {}) {
  const [sp4dText, sp4dMarkdown, slateText, matrix, report] = await Promise.all([
    readFile(sourcePaths.sp4d, "utf8"),
    readFile(sourcePaths.sp4dMarkdown, "utf8"),
    readFile(sourcePaths.slate, "utf8"),
    readJson(sourcePaths.matrix),
    readJson(sourcePaths.report),
  ]);
  const sp4d = JSON.parse(sp4dText);
  const slate = JSON.parse(slateText);
  const dossiers = [sp4d, ...slate.dossiers];
  const errors = dossiers.flatMap(validateDossier);
  errors.push(...validateSp4dMarkdown(sp4dMarkdown, sp4d));
  errors.push(...validateNewTheoryTemplate(slate.new_theory_template));
  const sourceTexts = {
    "docs/seed/sp4d/dossier.json": sp4dText,
    "docs/seed/sp4d/SP4D.md": sp4dMarkdown,
    "docs/seed/frontier-slate/dossiers.json": slateText,
  };
  errors.push(...validateMatrix(matrix, dossiers, sourceTexts));
  errors.push(...validateReport(report, {
    ...sourceTexts,
  }));
  for (const dossier of dossiers) {
    const face = renderDossier(dossier);
    if (!face.includes("## Anchored primary references") || !face.includes("## External review gate")) {
      errors.push(diagnostic("RENDER_CONTRACT_INVALID", dossier.id, "The generated face omitted a mandatory section."));
    }
  }
  if (shouldVerifyLinks) errors.push(...await verifyLinks(dossiers));
  return { dossiers, errors };
}

async function main() {
  const startedAt = performance.now();
  const verifyLinks = process.argv.includes("--verify-links");
  const { errors } = await runCheck({ verifyLinks });
  const durationMs = Math.round(performance.now() - startedAt);
  const relativeRoot = relative(process.cwd(), repositoryRoot) || ".";
  if (errors.length) {
    for (const error of errors) console.error(`code=${error.code} dossier=${error.dossier} detail=${error.detail}`);
    console.error(`tool=node suite=seed-source-contract version=${process.version} duration_ms=${durationMs} status=fail reproduce=\"node ${relativeRoot === "." ? "" : `${relativeRoot}/`}docs/seed/sp4d/check.mjs${verifyLinks ? " --verify-links" : ""}\"`);
    process.exitCode = 1;
    return;
  }
  console.log(`tool=node suite=seed-source-contract version=${process.version} duration_ms=${durationMs} status=pass reproduce=\"node docs/seed/sp4d/check.mjs${verifyLinks ? " --verify-links" : ""}\"`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
