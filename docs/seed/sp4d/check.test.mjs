import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  renderDossier,
  resolutionClaimsOutsideDisclaimer,
  runCheck,
  sourcePaths,
  validateDossier,
  validateMatrix,
  validateNewTheoryTemplate,
  validateReport,
  validateSp4dMarkdown,
} from "./check.mjs";

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
    variant_distinctions: [
      { variant: "Fixture variant", distinction: "One bounded distinction for rendering." },
    ],
    bounded_subgoals: [
      {
        id: "F-1",
        question: "Render one bounded item.",
        falsifier: "The item is omitted.",
        boundary: "No live data.",
        evidence_artifact: "Exact string comparison.",
      },
    ],
    references: [
      {
        id: "F-REF",
        url: "https://example.invalid/reference",
        locator: "§1 fixture anchor",
        authority: "official",
        license_or_rights:
          "License not asserted for this fixture; citation and link only, with no source text or PDF included.",
      },
    ],
    external_expert_requirements: "No external review is implied by this fixture.",
    safety: "Fixture safety boundary.",
    status_freshness: { source_audit_date: "2026-08-13" },
  };
  const rendered = renderDossier(fixture);
  assert.equal(
    rendered,
    `# FIXTURE: Renderer contract\n\n**Draft source only.** This is not a resolution claim.\n\n## Exact formulation\n\nA deliberately bounded fixture proposition.\n\n## Scope\n\nFixture scope only.\n\n## Out of scope\n\nNo scientific claim.\n\n## Variant distinctions\n\n- **Fixture variant:** One bounded distinction for rendering.\n\n## Falsifier and settlement\n\n- Falsifier: The expected header is absent.\n- Settlement condition: The generated sections match this fixture.\n\n## Bounded subgoals\n\n- **F-1:** Render one bounded item.\n  - Falsifier: The item is omitted.\n  - Boundary: No live data.\n  - Evidence artifact: Exact string comparison.\n\n## Anchored primary references\n\n- [F-REF](https://example.invalid/reference) — §1 fixture anchor\n  - License/rights: License not asserted for this fixture; citation and link only, with no source text or PDF included.\n\n## Safety\n\nFixture safety boundary.\n\n## External review gate\n\nNo external review is implied by this fixture.\n\n## Freshness\n\nSource audit date: 2026-08-13. A pre-publication status recheck is mandatory.\n`,
  );
});

test("planted negative: a conflated variant is rejected", async () => {
  const dossier = JSON.parse(await readFile(sourcePaths.sp4d, "utf8"));
  dossier.variant_distinctions[0].distinction =
    "The topological and smooth formulations are the same question.";
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
  const drifted = markdown.replace(
    dossier.references[0].url,
    "https://example.invalid/wrong-anchor",
  );
  assert.ok(
    validateSp4dMarkdown(drifted, dossier).some(
      (error) => error.code === "SP4D_MARKDOWN_SOURCE_DRIFT",
    ),
  );
});

test("planted negative: an SP4D prose locator drift is rejected", async () => {
  const [dossier, markdown] = await Promise.all([
    readFile(sourcePaths.sp4d, "utf8").then(JSON.parse),
    readFile(sourcePaths.sp4dMarkdown, "utf8"),
  ]);
  const drifted = markdown.replace(
    dossier.references[0].locator,
    "Theorem 1.6, p. 999: unsupported locator.",
  );
  assert.ok(
    validateSp4dMarkdown(drifted, dossier).some(
      (error) => error.code === "SP4D_MARKDOWN_ANCHOR_DRIFT",
    ),
  );
});

test("planted negative: a current-status field is rejected", async () => {
  const dossier = JSON.parse(await readFile(sourcePaths.sp4d, "utf8"));
  dossier.current_status = "open";
  assert.ok(
    validateDossier(dossier).some((error) => error.code === "UNSUPPORTED_CURRENT_STATUS_FIELD"),
  );
});

test("planted negative: each dossier must disclose uncertain or blocked registry access", async () => {
  const dossier = JSON.parse(await readFile(sourcePaths.sp4d, "utf8"));
  delete dossier.status_freshness.registry_access;
  assert.ok(
    validateDossier(dossier).some((error) => error.code === "STATUS_REGISTRY_ACCESS_INVALID"),
  );
});

test("planted negative: SP4D cannot omit a topological, PL, or smooth formulation", async () => {
  const dossier = JSON.parse(await readFile(sourcePaths.sp4d, "utf8"));
  dossier.formulation = "A smooth target with no category comparison.";
  assert.ok(validateDossier(dossier).some((error) => error.code === "MISSING_CATEGORY_VARIANTS"));
});

test("planted negative: the review matrix cannot self-approve or lose source/dossier bindings", async () => {
  const [matrix, sp4dText, markdown, slateText] = await Promise.all([
    readFile(sourcePaths.matrix, "utf8").then(JSON.parse),
    readFile(sourcePaths.sp4d, "utf8"),
    readFile(sourcePaths.sp4dMarkdown, "utf8"),
    readFile(sourcePaths.slate, "utf8"),
  ]);
  const dossiers = [JSON.parse(sp4dText), ...JSON.parse(slateText).dossiers];
  matrix.review_state.approval_state = "approved";
  delete matrix.source_digests["docs/seed/sp4d/SP4D.md"];
  const errors = validateMatrix(matrix, dossiers, {
    "docs/seed/sp4d/dossier.json": sp4dText,
    "docs/seed/sp4d/SP4D.md": markdown,
    "docs/seed/frontier-slate/dossiers.json": slateText,
  });
  assert.ok(errors.some((error) => error.code === "MATRIX_APPROVAL_STATE_INVALID"));
  assert.ok(errors.some((error) => error.code === "MATRIX_SOURCE_DIGEST_MISMATCH"));
});

test("rung-7 template requires predictions, bounded checks, and an external-review plan", async () => {
  const slate = JSON.parse(await readFile(sourcePaths.slate, "utf8"));
  assert.deepEqual(validateNewTheoryTemplate(slate.new_theory_template), []);
  slate.new_theory_template.required_fields = slate.new_theory_template.required_fields.filter(
    (field) => field !== "explicit predictions",
  );
  assert.ok(
    validateNewTheoryTemplate(slate.new_theory_template).some(
      (error) => error.code === "NEW_THEORY_TEMPLATE_INCOMPLETE",
    ),
  );
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
  dossier.status_freshness = {
    ...dossier.status_freshness,
    prepublication_recheck_required: false,
  };
  assert.ok(validateDossier(dossier).some((error) => error.code === "FRESHNESS_POLICY_INVALID"));
});

/**
 * The defect the independent audit named.
 *
 * The old face rule checked the heading, the reference URLs, and the locators.
 * A paraphrase preserves all three, so a face could keep every anchor intact and
 * still announce a resolution. This plant is built to satisfy the old rule set
 * exactly — nothing is removed, only added — and the assertions below prove both
 * halves: the anchors survive, and the claim is still refused.
 */
test("planted negative: a locator-preserving resolution claim is refused", async () => {
  const [dossier, markdown] = await Promise.all([
    readFile(sourcePaths.sp4d, "utf8").then(JSON.parse),
    readFile(sourcePaths.sp4dMarkdown, "utf8"),
  ]);
  const claimed = `${markdown}\n## Result\n\nThe smooth formulation has been resolved by the audit above.\n`;
  const errors = validateSp4dMarkdown(claimed, dossier);

  assert.ok(
    errors.some((error) => error.code === "SP4D_RESOLUTION_CLAIM_PRESENT"),
    "a resolution claim must be refused",
  );
  // Causal core: every check the previous rule set performed still passes, so
  // this plant would have been accepted before the semantic bind existed.
  for (const stale of [
    "SP4D_MARKDOWN_SOURCE_DRIFT",
    "SP4D_MARKDOWN_ANCHOR_DRIFT",
    "SP4D_MARKDOWN_CONTRACT_INVALID",
  ]) {
    assert.equal(
      errors.some((error) => error.code === stale),
      false,
      `${stale} must not be what catches this`,
    );
  }
});

test("the declared disclaimer is not itself read as a resolution claim", async () => {
  const [dossier, markdown] = await Promise.all([
    readFile(sourcePaths.sp4d, "utf8").then(JSON.parse),
    readFile(sourcePaths.sp4dMarkdown, "utf8"),
  ]);
  // The disclaimer names the outcome in order to deny it. A scanner that cannot
  // read it without refusing it would make honest disclaiming impossible, so
  // this positive is as load-bearing as the negative above.
  assert.match(dossier.no_resolution_language, /has been resolved/);
  assert.deepEqual(resolutionClaimsOutsideDisclaimer(markdown, dossier), []);
  assert.deepEqual(validateSp4dMarkdown(markdown, dossier), []);
});

test("planted negative: category, claim, subgoal, and expert-gate drift are refused with anchors intact", async () => {
  const [dossier, markdown] = await Promise.all([
    readFile(sourcePaths.sp4d, "utf8").then(JSON.parse),
    readFile(sourcePaths.sp4dMarkdown, "utf8"),
  ]);
  const plants = [
    [
      "SP4D_MARKDOWN_CATEGORY_DRIFT",
      markdown.replace(
        dossier.variant_distinctions[0].distinction,
        "The categories agree closely enough for this purpose.",
      ),
    ],
    ["SP4D_MARKDOWN_CLAIM_DRIFT", markdown.replace(dossier.no_resolution_language, "Draft notes.")],
    [
      "SP4D_MARKDOWN_SUBGOAL_DRIFT",
      markdown.replace(dossier.bounded_subgoals[0].falsifier, "Reviewer discretion."),
    ],
    [
      "SP4D_MARKDOWN_CLAIM_DRIFT",
      markdown.replace(dossier.external_expert_requirements, "Review as convenient."),
    ],
  ];
  for (const [code, drifted] of plants) {
    const errors = validateSp4dMarkdown(drifted, dossier);
    assert.ok(
      errors.some((error) => error.code === code),
      `expected ${code}`,
    );
    // Each substitution leaves every URL and locator untouched, so the old rule
    // set accepts all four.
    for (const reference of dossier.references) {
      assert.ok(drifted.includes(reference.url) && drifted.includes(reference.locator));
    }
    assert.ok(errors.some((error) => error.code === "SP4D_MARKDOWN_FACE_DRIFT"));
  }
});

test("planted negative: a resolution claim inside any dossier is refused", async () => {
  const slate = JSON.parse(await readFile(sourcePaths.slate, "utf8"));
  const [dossier] = slate.dossiers;
  const claimed = { ...dossier, scope: `${dossier.scope} The conjecture is true.` };
  assert.deepEqual(resolutionClaimsOutsideDisclaimer(JSON.stringify(dossier), dossier), []);
  assert.deepEqual(resolutionClaimsOutsideDisclaimer(JSON.stringify(claimed), claimed), [
    "conjecture-truth",
  ]);
});

/**
 * The review record pins the machinery, not only the material. A weakened rule
 * or a deleted matrix row would otherwise leave every recorded digest intact,
 * so the report would still read as a complete account of what was checked.
 */
test("planted negative: drift in the matrix or the checker breaks its recorded digest", async () => {
  const report = JSON.parse(await readFile(sourcePaths.report, "utf8"));
  const pinned = {
    "docs/seed/sp4d/review-matrix.json": sourcePaths.matrix,
    "docs/seed/sp4d/check.mjs": sourcePaths.checker,
    "docs/seed/sp4d/check.test.mjs": sourcePaths.checkerTest,
  };
  for (const [recorded, path] of Object.entries(pinned)) {
    assert.ok(typeof report.source_digests?.[recorded] === "string", `${recorded} must be pinned`);
    const text = await readFile(path, "utf8");
    const drifted = `${text}\n// planted drift\n`;
    const errors = validateReport(report, { [recorded]: drifted });
    assert.ok(
      errors.some((error) => error.code === "REPORT_DIGEST_MISMATCH" && error.detail === recorded),
      `${recorded} drift must be caught`,
    );
    // Non-vacuity: the undrifted bytes match, so the assertion above is about
    // the drift rather than about a digest that never matched.
    assert.deepEqual(
      validateReport(report, { [recorded]: text }).filter(
        (error) => error.code === "REPORT_DIGEST_MISMATCH",
      ),
      [],
    );
  }
});

test("CLI-oriented check succeeds with secret-safe diagnostics", () => {
  const result = spawnSync(process.execPath, [resolve(here, "check.mjs")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /tool=node suite=seed-source-contract version=v\d+\.\d+\.\d+ duration_ms=\d+ status=pass/,
  );
  assert.doesNotMatch(result.stdout + result.stderr, /\/Users\//);
});
