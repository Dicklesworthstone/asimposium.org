import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { renderDossier, runCheck, sourcePaths, validateDossier, validateNewTheoryTemplate, validateSp4dMarkdown } from "./check.mjs";

const here = dirname(fileURLToPath(import.meta.url));

test("contract accepts every prepared dossier and its generated face", async () => {
  const { dossiers, errors } = await runCheck();
  assert.deepEqual(errors, []);
  for (const dossier of dossiers) {
    const face = renderDossier(dossier);
    assert.match(face, /^# .+/m);
    assert.match(face, /## Exact formulation/);
    assert.match(face, /## Anchored primary references/);
    assert.match(face, /## External review gate/);
    for (const reference of dossier.references) assert.ok(face.includes(reference.locator));
  }
});

test("rendering is deterministic for a contract fixture", () => {
  const fixture = {
    id: "FIXTURE",
    title: "Renderer contract",
    formulation: "A deliberately bounded fixture proposition.",
    scope: "Fixture scope only.",
    out_of_scope: "No scientific claim.",
    falsifier: "The expected header is absent.",
    settlement_conditions: "The generated sections match this fixture.",
    no_resolution_language: "This is not a resolution claim.",
    variant_distinctions: [{ variant: "Fixture variant", distinction: "One bounded distinction for rendering." }],
    bounded_subgoals: [{ id: "F-1", question: "Render one bounded item.", falsifier: "The item is omitted.", boundary: "No live data.", evidence_artifact: "Exact string comparison." }],
    references: [{ id: "F-REF", url: "https://example.invalid/reference", locator: "§1 fixture anchor", authority: "official", license_or_rights: "License not asserted for this fixture; citation and link only, with no source text or PDF included." }],
    external_expert_requirements: "No external review is implied by this fixture.",
    safety: "Fixture safety boundary.",
    status_freshness: { source_audit_date: "2026-08-13" },
  };
  const rendered = renderDossier(fixture);
  assert.equal(rendered, `# FIXTURE: Renderer contract\n\n**Draft source only.** This is not a resolution claim.\n\n## Exact formulation\n\nA deliberately bounded fixture proposition.\n\n## Scope\n\nFixture scope only.\n\n## Out of scope\n\nNo scientific claim.\n\n## Variant distinctions\n\n- **Fixture variant:** One bounded distinction for rendering.\n\n## Falsifier and settlement\n\n- Falsifier: The expected header is absent.\n- Settlement condition: The generated sections match this fixture.\n\n## Bounded subgoals\n\n- **F-1:** Render one bounded item.\n  - Falsifier: The item is omitted.\n  - Boundary: No live data.\n  - Evidence artifact: Exact string comparison.\n\n## Anchored primary references\n\n- [F-REF](https://example.invalid/reference) — §1 fixture anchor\n  - License/rights: License not asserted for this fixture; citation and link only, with no source text or PDF included.\n\n## Safety\n\nFixture safety boundary.\n\n## External review gate\n\nNo external review is implied by this fixture.\n\n## Freshness\n\nSource audit date: 2026-08-13. A pre-publication status recheck is mandatory.\n`);
});

test("planted negative: a conflated variant is rejected", async () => {
  const dossier = JSON.parse(await readFile(sourcePaths.sp4d, "utf8"));
  dossier.variant_distinctions[0].distinction = "The topological and smooth formulations are the same question.";
  assert.ok(validateDossier(dossier).some((error) => error.code === "CONFLATED_VARIANT"));
});

test("planted negative: a missing primary-source anchor is rejected", async () => {
  const dossier = JSON.parse(await readFile(sourcePaths.sp4d, "utf8"));
  dossier.references[0].locator = "";
  assert.ok(validateDossier(dossier).some((error) => error.code === "MISSING_SOURCE_ANCHOR"));
});

test("planted negative: a missing source rights record is rejected", async () => {
  const dossier = JSON.parse(await readFile(sourcePaths.sp4d, "utf8"));
  dossier.references[0].license_or_rights = "";
  assert.ok(validateDossier(dossier).some((error) => error.code === "MISSING_SOURCE_RIGHTS"));
});

test("planted negative: an SP4D prose citation drift is rejected", async () => {
  const [dossier, markdown] = await Promise.all([
    readFile(sourcePaths.sp4d, "utf8").then(JSON.parse),
    readFile(sourcePaths.sp4dMarkdown, "utf8"),
  ]);
  const drifted = markdown.replace(dossier.references[0].url, "https://example.invalid/wrong-anchor");
  assert.ok(validateSp4dMarkdown(drifted, dossier).some((error) => error.code === "SP4D_MARKDOWN_SOURCE_DRIFT"));
});

test("planted negative: an SP4D prose locator drift is rejected", async () => {
  const [dossier, markdown] = await Promise.all([
    readFile(sourcePaths.sp4d, "utf8").then(JSON.parse),
    readFile(sourcePaths.sp4dMarkdown, "utf8"),
  ]);
  const drifted = markdown.replace(dossier.references[0].locator, "Theorem 1.6, p. 999: unsupported locator.");
  assert.ok(validateSp4dMarkdown(drifted, dossier).some((error) => error.code === "SP4D_MARKDOWN_ANCHOR_DRIFT"));
});

test("planted negative: a current-status field is rejected", async () => {
  const dossier = JSON.parse(await readFile(sourcePaths.sp4d, "utf8"));
  dossier.current_status = "open";
  assert.ok(validateDossier(dossier).some((error) => error.code === "UNSUPPORTED_CURRENT_STATUS_FIELD"));
});

test("rung-7 template requires predictions, bounded checks, and an external-review plan", async () => {
  const slate = JSON.parse(await readFile(sourcePaths.slate, "utf8"));
  assert.deepEqual(validateNewTheoryTemplate(slate.new_theory_template), []);
  slate.new_theory_template.required_fields = slate.new_theory_template.required_fields.filter((field) => field !== "explicit predictions");
  assert.ok(validateNewTheoryTemplate(slate.new_theory_template).some((error) => error.code === "NEW_THEORY_TEMPLATE_INCOMPLETE"));
});

test("every rung-6 slate dossier reaches the contract, not only SP4D", async () => {
  const [{ dossiers, errors }, slate] = await Promise.all([
    runCheck(),
    readFile(sourcePaths.slate, "utf8").then(JSON.parse),
  ]);
  assert.deepEqual(errors, []);
  // Without this the loop below passes vacuously on an empty slate.
  assert.ok(slate.dossiers.length > 0, "the slate carries no dossiers to validate");
  const validated = new Set(dossiers.map((dossier) => dossier.id));
  for (const dossier of slate.dossiers) {
    assert.ok(validated.has(dossier.id), `slate dossier ${dossier.id} was not validated`);
  }
});

test("planted negative: a slate dossier losing its no-resolution language is rejected", async () => {
  const slate = JSON.parse(await readFile(sourcePaths.slate, "utf8"));
  const [dossier] = slate.dossiers;
  dossier.no_resolution_language = "";
  const errors = validateDossier(dossier);
  assert.ok(
    errors.some((error) => error.code === "MISSING_REQUIRED_TEXT"),
    `expected MISSING_REQUIRED_TEXT for ${dossier.id}`,
  );
});

test("planted negative: a slate dossier without a pre-publication recheck is rejected", async () => {
  const slate = JSON.parse(await readFile(sourcePaths.slate, "utf8"));
  const [dossier] = slate.dossiers;
  dossier.status_freshness = { ...dossier.status_freshness, prepublication_recheck_required: false };
  assert.ok(validateDossier(dossier).some((error) => error.code === "FRESHNESS_POLICY_INVALID"));
});

test("CLI-oriented check succeeds with secret-safe diagnostics", () => {
  const result = spawnSync(process.execPath, [resolve(here, "check.mjs")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /tool=node suite=seed-source-contract version=v\d+\.\d+\.\d+ duration_ms=\d+ status=pass/);
  assert.doesNotMatch(result.stdout + result.stderr, /\/Users\//);
});
