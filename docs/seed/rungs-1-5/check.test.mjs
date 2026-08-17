import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * `check.mjs` in this directory is a script rather than a library: it performs
 * its whole run at module scope. Importing it would execute the check as a side
 * effect, so every assertion below drives it as a subprocess instead. That also
 * keeps the exit-code contract — the property that makes the checker usable as
 * a gate — under test rather than assumed.
 */
const here = dirname(fileURLToPath(import.meta.url));
const checker = resolve(here, "check.mjs");

/**
 * Under `bun test`, node's `spawnSync` returns empty streams for a spawned
 * `bun` child, so the native API is used when it exists and node's is the
 * fallback. Both branches decode explicitly, keeping assertions identical
 * whether this suite runs under `bun test` or `node --test`.
 */
function spawnChecker(script, args, cwd) {
  if (typeof Bun !== "undefined") {
    const result = Bun.spawnSync({
      cmd: ["bun", script, ...args],
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      status: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  }
  const result = spawnSync("bun", [script, ...args], { cwd });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function runChecker(args = [], cwd = here) {
  return spawnChecker(checker, args, cwd);
}

/**
 * The six fixture-backed plants plus the eleven inline synthetic controls. Two
 * entries carry `E_RENDERED_STATEMENT_DRIFT`: one for a section whose text
 * drifted, one for a section that is not extractable at all.
 */
const PLANTED_NEGATIVE_DIAGNOSTICS = [
  "E_SOURCE_ANCHOR",
  "E_RENDERED_STATEMENT_DRIFT",
  "E_RENDERED_STATEMENT_DRIFT",
  "E_DOC_CONTENT_VERSION_EVIDENCE",
  "E_ARTIFACT_ORACLE_DRIFT",
  "E_PLANTED_ERROR_NOT_REVERSED",
  "E_ORACLE_DISCLOSED",
  "E_DOSSIER_FILE",
  "E_REPORT_DIGEST_DRIFT",
  "E_REPORT_SELF_REVIEW",
  "E_REPORT_DIGEST_DRIFT",
  "E_REQUIRED_STRING",
  "E_REPORT_REVIEW_RUBRIC",
  "E_REPORT_APPROVAL_STATE",
  "E_REQUIRED_STRING",
  "E_REPORT_REVIEW_TIMESTAMP",
  "E_REPORT_RUNG_READINESS",
];

test("the checker passes on the committed dossiers and exits zero", () => {
  const result = runChecker();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /status=passed/);
  assert.match(result.stdout, /suite=source-contract\b/);
});

test("--self-test detects every planted negative and still exits zero", () => {
  const result = runChecker(["--self-test"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /status=passed/);
  assert.match(result.stdout, /suite=source-contract\+planted-negative/);

  const detected = [...result.stdout.matchAll(/^planted-negative id=(\S+) status=detected/gm)];
  assert.equal(
    detected.length,
    PLANTED_NEGATIVE_DIAGNOSTICS.length,
    `expected ${PLANTED_NEGATIVE_DIAGNOSTICS.length} detected plants, saw ${detected.length}`,
  );
});

/**
 * Causal control for this slice. If `validateOracleDisclosure` is removed or
 * stops matching, the inline plant no longer fires `E_ORACLE_DISCLOSED`, the
 * run raises `E_NEGATIVE_NOT_DETECTED`, and both assertions here fail.
 */
test("the oracle-disclosure guard is proven able to fire", () => {
  const result = runChecker(["--self-test"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /planted-negative id=synthetic-oracle-disclosure status=detected diagnostic=E_ORACLE_DISCLOSED/,
  );
  assert.doesNotMatch(result.stdout, /E_NEGATIVE_NOT_DETECTED/);
  assert.doesNotMatch(result.stderr, /E_NEGATIVE_NOT_DETECTED/);
});

/**
 * Causal control for the absent-section branch, which used to return silently.
 * `## Exact statement (draft)` contains the required heading as a substring, so
 * the presence check is satisfied and no `E_DOSSIER_HEADING` fires, while the
 * anchored extraction returns null. Restore the bare `if (actual === null)
 * return;` in `validateRenderedSection` and this plant stops firing, the run
 * raises `E_NEGATIVE_NOT_DETECTED`, and both assertions below fail.
 *
 * The detail is asserted, not just the code, because `validateRenderedSection`
 * emits `E_RENDERED_STATEMENT_DRIFT` from two branches. This fixture's body text
 * is also genuinely drifted, so an extractor regression that accepted the
 * decorated heading would reach the content comparison and re-emit the same
 * code from the other branch — keeping this plant green while the branch it
 * exists to protect had stopped running. Only the detail separates them.
 */
test("a decorated heading cannot skip the rendered-statement comparison", () => {
  const result = runChecker(["--self-test"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /^planted-negative id=negative-decorated-heading status=detected diagnostic=E_RENDERED_STATEMENT_DRIFT detail=## Exact statement must be a standalone heading line$/m,
  );
  // The sibling branch's detail. Seeing it here would mean the plant fired from
  // the content comparison, which is exactly the false green being closed.
  assert.doesNotMatch(
    result.stdout,
    /id=negative-decorated-heading[^\n]*must match the manifest exactly/,
  );
  assert.doesNotMatch(result.stdout, /E_NEGATIVE_NOT_DETECTED/);
});

test("the two rendered-statement plants are distinct sections, not one plant counted twice", () => {
  const result = runChecker(["--self-test"]);
  const drift = [
    ...result.stdout.matchAll(
      /^planted-negative id=(\S+) status=detected diagnostic=E_RENDERED_STATEMENT_DRIFT detail=.+$/gm,
    ),
  ].map((match) => match[1]);
  assert.deepEqual(drift.sort(), [
    "negative-decorated-heading",
    "negative-rendered-statement-drift",
  ]);
});

/**
 * Causal control for the pre-read filename guard. The synthetic dossier names a
 * path outside this directory that certainly exists, so removing the early
 * return in `checkDossierMarkdown` makes the read succeed, `E_DOSSIER_FILE` is
 * never emitted from there, and this control misses. The guard being reachable
 * is the property; the traversal target is named but never opened.
 */
test("a non-canonical dossier filename is refused before any read is attempted", () => {
  const result = runChecker(["--self-test"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /planted-negative id=synthetic-filename-traversal status=detected diagnostic=E_DOSSIER_FILE/,
  );
  // A read that was attempted and failed would surface as E_DOSSIER_READ; a read
  // that was attempted and succeeded would surface as heading diagnostics
  // against the wrong file. Neither may appear for this control.
  assert.doesNotMatch(result.stdout, /E_DOSSIER_READ/);
  assert.doesNotMatch(result.stderr, /E_DOSSIER_READ/);
});

test("the filename guard is the same shape the manifest validator diagnoses", () => {
  const source = readFileSync(checker, "utf8");
  // One definition, two call sites: a second inline copy could drift so that a
  // name is diagnosed but still read, which is the bug this guard closes.
  assert.equal(source.match(/\[0-9\]\{2\}-\[a-z0-9-\]\+\\\.md/g)?.length, 1);
  assert.equal(source.match(/isCanonicalDossierFilename\(/g)?.length, 3);
});

/**
 * Causal control for the review report's digest binding. The plant swaps one
 * pinned digest in memory, so it can only be detected by an actual comparison
 * against the file on disk; drop that comparison and this control misses and
 * the run raises `E_NEGATIVE_NOT_DETECTED`.
 */
test("a dossier edited after review cannot pass the report's digest binding", () => {
  const result = runChecker(["--self-test"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /planted-negative id=synthetic-report-digest-drift status=detected diagnostic=E_REPORT_DIGEST_DRIFT/,
  );
  assert.doesNotMatch(result.stdout, /E_NEGATIVE_NOT_DETECTED/);
});

/**
 * Causal control for the self-review refusal. Independence is the one property
 * a preparer cannot supply for themselves, so the plant records a review whose
 * reviewer identity is the preparer's; drop the identity comparison and this
 * control misses.
 */
test("a preparer cannot record an independent review of their own material", () => {
  const result = runChecker(["--self-test"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /planted-negative id=synthetic-self-review status=detected diagnostic=E_REPORT_SELF_REVIEW/,
  );
  assert.doesNotMatch(result.stdout, /E_NEGATIVE_NOT_DETECTED/);
});

/**
 * Causal control for meaning changes outside the two bound sections. The plant
 * turns "a prepared calibration fixture" into "a validated calibration result"
 * — precisely the overclaim the no-claim boundary exists to prevent, and a
 * section no rendered-section check inspects. It is caught only by the
 * full-file digest, and the checker refuses a plant that matched no text.
 */
test("semantic drift outside the checked sections is caught by the full-file digest", () => {
  const result = runChecker(["--self-test"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /planted-negative id=synthetic-semantic-drift status=detected diagnostic=E_REPORT_DIGEST_DRIFT/,
  );
  assert.doesNotMatch(result.stdout, /E_SEMANTIC_PLANT_INERT/);
});

/**
 * Causal omission control for Fable 6.6. A review that cannot say how it could
 * have failed moves nothing, so the fixture is well formed except that
 * `capable_of_failure` is absent. Make the field optional and this control
 * misses.
 */
test("a review that cannot state how it could have failed is refused", () => {
  const result = runChecker(["--self-test"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /planted-negative id=synthetic-review-missing-capable-of-failure status=detected diagnostic=E_REQUIRED_STRING detail=capable_of_failure/,
  );
  assert.doesNotMatch(result.stdout, /E_NEGATIVE_NOT_DETECTED/);
});

/**
 * The capable-of-failure pair is two fields, and only one had a plant. Both
 * assertions below match on the diagnostic detail, because the two omissions
 * share `E_REQUIRED_STRING`; matching on code alone would let one plant satisfy
 * the other's control.
 */
test("both halves of the capable-of-failure pair are separately required", () => {
  const result = runChecker(["--self-test"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /id=synthetic-review-missing-capable-of-failure status=detected diagnostic=E_REQUIRED_STRING detail=capable_of_failure/,
  );
  assert.match(
    result.stdout,
    /id=synthetic-review-missing-negative-verdict-condition status=detected diagnostic=E_REQUIRED_STRING detail=negative_verdict_condition/,
  );
  assert.doesNotMatch(result.stdout, /E_NEGATIVE_NOT_DETECTED/);
});

/**
 * Causal control for the review timestamp. The fixture is malformed rather than
 * missing, so this exercises the date format check and not merely presence.
 */
test("an undated or misdated review cannot be pinned to the bytes it examined", () => {
  const result = runChecker(["--self-test"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /id=synthetic-review-malformed-timestamp status=detected diagnostic=E_REPORT_REVIEW_TIMESTAMP/,
  );
});

/**
 * Causal control for the per-rung side door. A globally pending report with one
 * rung flipped to staging-ready is the shape a reader would quote, so the rung
 * field has to be constrained as tightly as the envelope.
 */
test("a single rung cannot read as cleared under a pending report", () => {
  const result = runChecker(["--self-test"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /id=synthetic-cleared-rung-readiness status=detected diagnostic=E_REPORT_RUNG_READINESS/,
  );
  const report = JSON.parse(readFileSync(resolve(here, "review-report.json"), "utf8"));
  for (const rung of report.rungs) {
    assert.equal(rung.readiness, "external_review_pending", `${rung.id} readiness`);
  }
});

/** Causal empty-field control: a blank rubric line names nothing exercised. */
test("a blank rubric line cannot satisfy the exercised-lines requirement", () => {
  const result = runChecker(["--self-test"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /planted-negative id=synthetic-review-empty-rubric-entry status=detected diagnostic=E_REPORT_REVIEW_RUBRIC/,
  );
});

/**
 * The identity-authority ceiling, asserted as behaviour rather than prose. The
 * plant is the most favourable possible case for clearance — every rung
 * reviewed by a distinct well-formed reviewer — and it must still be refused,
 * because nothing here can authenticate those identities.
 */
test("no arrangement of recorded reviews can clear this document", () => {
  const result = runChecker(["--self-test"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /planted-negative id=synthetic-cleared-approval-state status=detected diagnostic=E_REPORT_APPROVAL_STATE/,
  );
  const source = readFileSync(checker, "utf8");
  // The allowed-state set is the whole rule; a second permitted state would
  // reopen the transition this control exists to close.
  assert.match(source, /REVIEW_APPROVAL_STATES = new Set\(\["external_review_pending"\]\)/);
});

/**
 * Staleness guard. The report's declared test count drifted from reality once
 * already; binding it to the number of declarations in this file makes adding a
 * test without refreshing the record a refusal.
 */
test("the review report's declared test count matches this suite", () => {
  const source = readFileSync(resolve(here, "check.test.mjs"), "utf8");
  const declared = source.match(/^test\(/gm)?.length ?? 0;
  const report = JSON.parse(readFileSync(resolve(here, "review-report.json"), "utf8"));
  assert.ok(declared > 0, "no test declarations found");
  assert.equal(report.mechanical_checks.unit_suite.tests, declared);
});

/**
 * Honesty guard on the acceptance artifact itself. The bead's DONE condition
 * names an independent domain review that has not happened; this asserts the
 * committed report still says so, so a later edit cannot quietly promote the
 * record to cleared without recording the reviews that would justify it.
 */
test("the committed review report claims no domain review that occurred", () => {
  const report = JSON.parse(readFileSync(resolve(here, "review-report.json"), "utf8"));
  assert.equal(report.approval_state, "external_review_pending");
  assert.equal(report.external_review.required, true);
  assert.equal(report.rungs.length, 5);
  for (const rung of report.rungs) {
    assert.equal(rung.domain_review, "not-performed", `${rung.id} must not claim a domain review`);
  }
  assert.ok(report.unresolved_questions.length > 0);
});

test("the disclosure diagnostic never echoes the matched answer", () => {
  const source = readFileSync(checker, "utf8");
  const emitter = source.slice(source.indexOf("function validateOracleDisclosure"));
  const body = emitter.slice(0, emitter.indexOf("\n}\n"));
  // The detail line may name the oracle field path; interpolating the value
  // would move a hidden answer into CI output.
  assert.match(body, /answer\.path/);
  assert.doesNotMatch(body, /\$\{answer\.value\}/);
});

/**
 * A gate is only a gate if a broken input fails it. `--self-test-fail` runs a
 * committed invalid fixture through the real validator and retains its
 * diagnostic, so the exit-code contract is proven without creating, writing,
 * copying, or deleting anything on disk.
 */
test("a retained invalid fixture fails the checker with a non-zero exit", () => {
  const result = runChecker(["--self-test-fail"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /status=failed/);
  assert.match(result.stderr, /code=E_SOURCE_ANCHOR/);
  assert.match(result.stderr, /suite=source-contract\+retained-failure/);
  assert.match(result.stderr, /reproduce=.*--self-test-fail/);
});

/**
 * Causal control for the plant harness's own ordering.
 *
 * `runPlantedControl` discards a fixture's expected diagnostics before it may
 * record a control failure. Recording first — the original order — pushed
 * `E_NEGATIVE_NOT_DETECTED` at an index the same splice then deleted, so a
 * plant that stopped firing still exited 0. `--self-test-miss` expects a
 * diagnostic the validator cannot emit, so the control must miss; if the
 * missing-plant path is ever filtered away again, this exits 0 and fails here.
 */
test("a missing plant cannot be filtered away and exits non-zero", () => {
  const result = runChecker(["--self-test-miss"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /code=E_NEGATIVE_NOT_DETECTED/);
  assert.match(result.stderr, /location=missing-plant-control/);
  assert.match(result.stderr, /status=failed/);
  assert.match(result.stderr, /suite=source-contract\+missing-plant-control/);
});

test("every planted control routes through the single ordering helper", () => {
  const source = readFileSync(checker, "utf8");
  const helper = source.slice(source.indexOf("function runPlantedControl"));
  const body = helper.slice(0, helper.indexOf("\n}\n"));
  const spliceAt = body.indexOf("diagnostics.splice");
  const recordAt = body.indexOf("E_NEGATIVE_NOT_DETECTED");
  assert.ok(spliceAt > 0 && recordAt > 0, "ordering helper must splice and record");
  assert.ok(
    spliceAt < recordAt,
    "the fixture's diagnostics must be discarded before a control failure is recorded",
  );
  // No control may reintroduce its own splice-after-record sequence.
  assert.equal(source.match(/diagnostics\.splice\(/g)?.length, 1);
});

test("the failure control leaves the ordinary run green", () => {
  const result = runChecker();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /status=passed/);
});

/**
 * No-claim boundary, asserted so it cannot quietly drift out of the checker.
 *
 * This suite proves that the checker runs, that its planted negatives are
 * detected, that the disclosure guard can fire, and that a broken input exits
 * non-zero. It proves nothing about scientific readiness: not that any rung's
 * statement is correct, that its falsifier is sound, that its sources are
 * authoritative or licensed, and not that any external review has occurred.
 *
 * The guard's own scope is narrower still. `Nat.exists_infinite_primes` and
 * `expected_review_verdict` appear in participant-facing text today and are
 * deliberately unadjudicated; their absence from the guarded set is an open
 * question rather than a clearance.
 */
test("the checker records the unadjudicated oracle fields rather than implying clearance", () => {
  const source = readFileSync(checker, "utf8");
  assert.match(source, /Deliberately NOT adjudicated here/);
  assert.match(source, /Nat\.exists_infinite_primes/);
  assert.match(source, /expected_review_verdict/);
  assert.match(source, /not a clearance/);
});
