#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 1.5.0 tightens acceptance: a rendered section that cannot be extracted is
// drift rather than an exemption, and a non-canonical dossier filename is
// refused before any read. Inputs that passed under 1.4.0 can fail under this.
const CHECK_VERSION = "1.5.0";
const root = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const checkLinks = args.has("--check-links");
const checkArtifacts = args.has("--check-artifacts");
const selfTest = args.has("--self-test");
const selfTestFail = args.has("--self-test-fail");
const selfTestMiss = args.has("--self-test-miss");
const emitDigests = args.has("--emit-digests");
const runtimeVersion = typeof Bun === "undefined" ? process.version : Bun.version;
const started = performance.now();
const diagnostics = [];

function safePath(path) {
  return relative(root, path).replaceAll("\\", "/");
}

function diagnostic(code, location, detail) {
  diagnostics.push({ code, location, detail });
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function digest(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function requireString(value, location, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    diagnostic("E_REQUIRED_STRING", location, `${label} must be a non-empty string`);
    return false;
  }
  return true;
}

function isIsoDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/**
 * The only filename shape a dossier may name. It has no directory part, so it
 * cannot carry `..`, an absolute root, or a drive letter, and `resolve(root, …)`
 * on a value that satisfies it cannot leave this directory. Two call sites need
 * that answer — one to diagnose it, one to refuse a read before attempting it —
 * so the shape is defined once here rather than twice inline.
 */
function isCanonicalDossierFilename(file) {
  return typeof file === "string" && /^[0-9]{2}-[a-z0-9-]+\.md$/.test(file);
}

function documentationPathVersion(url) {
  if (typeof url !== "string") return null;
  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    const documentationIndex = segments.findIndex((segment) => segment === "doc" || segment === "docs");
    if (documentationIndex === -1) return null;
    const candidate = segments[documentationIndex + 1];
    return /^\d+(?:\.\d+){1,2}$/.test(candidate ?? "") ? candidate : null;
  } catch {
    return null;
  }
}

function validateDocumentationVersionEvidence(source, location) {
  const urlVersion = documentationPathVersion(source.url);
  if (urlVersion === null) return;
  const fields = ["url_version", "observed_content_version", "content_version_status", "content_version_evidence"];
  if (fields.some((field) => typeof source[field] !== "string" || source[field].trim().length === 0)) {
    diagnostic("E_DOC_CONTENT_VERSION_EVIDENCE", location, "a versioned documentation URL requires observed content-version evidence; its path alone is not a version claim");
    return;
  }
  if (source.url_version !== urlVersion) {
    diagnostic("E_DOC_URL_VERSION", location, "source.url_version must equal the version segment in the documentation URL");
  }
  if (!["matches", "discrepant"].includes(source.content_version_status)) {
    diagnostic("E_DOC_CONTENT_VERSION_STATUS", location, "content_version_status must be matches or discrepant");
    return;
  }
  const versionsMatch = source.url_version === source.observed_content_version;
  if ((versionsMatch && source.content_version_status !== "matches") || (!versionsMatch && source.content_version_status !== "discrepant")) {
    diagnostic("E_DOC_CONTENT_VERSION_STATUS", location, "content_version_status must accurately describe the URL/content version relationship");
  }
}

function validateSource(source, location) {
  const valid = isObject(source);
  if (!valid) {
    diagnostic("E_SOURCE_SHAPE", location, "source must be an object");
    return;
  }

  for (const field of ["id", "url", "locator", "license_or_rights", "role", "access_date"]) {
    requireString(source[field], location, `source.${field}`);
  }

  try {
    const parsed = new URL(source.url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search) {
      diagnostic("E_SOURCE_URL", location, "source URL must be credential-free HTTPS without a query string");
    }
    if (["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
      diagnostic("E_SOURCE_URL", location, "source URL must not target a local host");
    }
  } catch {
    diagnostic("E_SOURCE_URL", location, "source URL is not parseable");
  }

  if (typeof source.locator === "string" && source.locator.trim().length < 8) {
    diagnostic("E_SOURCE_ANCHOR", location, "source locator must identify a theorem, section, page, API entry, or pinned line range");
  }
  if (typeof source.access_date === "string" && !isIsoDate(source.access_date)) {
    diagnostic("E_SOURCE_DATE", location, "source access_date must use YYYY-MM-DD");
  }
  validateDocumentationVersionEvidence(source, location);
  if (source.pinned_version !== undefined) {
    if (!requireString(source.pinned_version, location, "source.pinned_version")) return;
    if (typeof source.url === "string" && !source.url.includes(source.pinned_version)) {
      diagnostic("E_SOURCE_VERSION_PIN", location, "versioned source URL must include source.pinned_version");
    }
  }
  if (source.pinned_commit !== undefined) {
    if (!requireString(source.pinned_commit, location, "source.pinned_commit")) return;
    if (!/^[a-f0-9]{40}$/.test(source.pinned_commit)) {
      diagnostic("E_SOURCE_COMMIT_PIN", location, "source.pinned_commit must be a 40-character lowercase Git commit");
    } else if (typeof source.url === "string" && !source.url.includes(source.pinned_commit)) {
      diagnostic("E_SOURCE_COMMIT_PIN", location, "pinned source URL must include source.pinned_commit");
    }
  }
  if (source.sha256 !== undefined && !isSha256(source.sha256)) {
    diagnostic("E_ARTIFACT_HASH", location, "source.sha256 must be a lowercase SHA-256 digest");
  }
  if (source.oracle_artifact_key !== undefined) {
    requireString(source.oracle_artifact_key, location, "source.oracle_artifact_key");
    if (!isSha256(source.sha256) || typeof source.pinned_version !== "string") {
      diagnostic("E_ARTIFACT_BINDING", location, "oracle-bound artifact sources require both sha256 and pinned_version");
    }
  }
}

function validateArtifactBinding(source, oracle, location) {
  if (source.oracle_artifact_key === undefined) return;
  const artifact = oracle?.data?.[source.oracle_artifact_key];
  if (!isObject(artifact)) {
    diagnostic("E_ARTIFACT_ORACLE_TARGET", location, "oracle artifact target is absent or malformed");
    return;
  }
  if (artifact.version !== source.pinned_version || artifact.sha256 !== source.sha256) {
    diagnostic("E_ARTIFACT_ORACLE_DRIFT", location, "source artifact version or SHA-256 differs from its hidden oracle target");
  }
}

function normalizeRenderedSection(value) {
  return value
    .replaceAll("\r\n", "\n")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function extractMarkdownSection(body, heading) {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headingMatch = new RegExp(`^${escapedHeading}\\s*$`, "m").exec(body);
  if (!headingMatch || headingMatch.index === undefined) return null;

  const afterHeading = body.slice(headingMatch.index + headingMatch[0].length);
  const nextHeading = afterHeading.search(/\n##\s+/);
  return afterHeading.slice(0, nextHeading === -1 ? undefined : nextHeading).trim();
}

/**
 * An absent section is drift, not an exemption.
 *
 * The heading presence check in `checkDossierMarkdown` accepts a substring
 * anywhere in the body, while `extractMarkdownSection` requires a standalone
 * heading line. Decorating a heading satisfies the first and defeats the
 * second: `## Exact statement (draft)` contains `## Exact statement`, so no
 * `E_DOSSIER_HEADING` fires, and the anchored `^…\s*$` match returns null. This
 * used to return silently, which meant the strongest possible drift — the
 * published statement having no comparable section at all — was the one case
 * that passed. Nothing else binds manifest statement text to the rendered
 * dossier, so that silence was the whole guard.
 */
function validateRenderedSection(body, heading, expected, location, code) {
  const actual = extractMarkdownSection(body, heading);
  if (actual === null) {
    diagnostic(code, location, `${heading} must be a standalone heading line`);
    return;
  }
  if (normalizeRenderedSection(actual) !== normalizeRenderedSection(expected)) {
    diagnostic(code, location, `${heading} must match the manifest exactly apart from inline-code presentation`);
  }
}

function renderDossier(dossier) {
  return [
    `# ${dossier.title}`,
    `rung: ${dossier.rung}`,
    `statement: ${dossier.statement}`,
    `falsifier: ${dossier.falsifier}`,
    `freshness: ${dossier.freshness_date}`,
    `no-claim: ${dossier.no_claim_boundary}`,
  ].join("\n");
}

function validateDossier(dossier, oraclesById, renderExpectations) {
  const location = `manifest.json:${dossier?.id ?? "unknown"}`;
  if (!isObject(dossier)) {
    diagnostic("E_DOSSIER_SHAPE", location, "dossier must be an object");
    return;
  }

  for (const field of [
    "id",
    "file",
    "title",
    "statement",
    "falsifier",
    "motivation",
    "scope",
    "out_of_scope",
    "oracle_id",
    "freshness_date",
    "no_claim_boundary",
  ]) {
    requireString(dossier[field], location, field);
  }

  if (typeof dossier.freshness_date === "string" && !isIsoDate(dossier.freshness_date)) {
    diagnostic("E_FRESHNESS_DATE", location, "freshness_date must use YYYY-MM-DD");
  }

  if (!Number.isInteger(dossier.rung) || dossier.rung < 1 || dossier.rung > 5) {
    diagnostic("E_RUNG", location, "rung must be an integer from 1 through 5");
  }
  if (!isCanonicalDossierFilename(dossier.file)) {
    diagnostic("E_DOSSIER_FILE", location, "file must be a local numbered Markdown filename");
  }
  if (!Array.isArray(dossier.success_criteria) || dossier.success_criteria.length < 2) {
    diagnostic("E_SUCCESS_CRITERIA", location, "at least two bounded success criteria are required");
  }
  if (!Array.isArray(dossier.area_tags) || dossier.area_tags.length === 0) {
    diagnostic("E_AREA_TAGS", location, "at least one area tag is required");
  }
  if (!Array.isArray(dossier.expected_objects) || dossier.expected_objects.length === 0) {
    diagnostic("E_EXPECTED_OBJECTS", location, "expected ledger objects are required");
  }
  if (!Array.isArray(dossier.expected_validator_behaviors) || dossier.expected_validator_behaviors.length === 0) {
    diagnostic("E_VALIDATOR_BEHAVIORS", location, "expected validator behavior is required");
  }
  if (!Array.isArray(dossier.safety_privacy) || dossier.safety_privacy.length === 0) {
    diagnostic("E_SAFETY_PRIVACY", location, "safety and privacy notes are required");
  }
  if (!Array.isArray(dossier.sources) || dossier.sources.length === 0) {
    diagnostic("E_SOURCES", location, "at least one authoritative anchored source is required");
  } else {
    dossier.sources.forEach((source) => validateSource(source, `${location}:source:${source?.id ?? "unknown"}`));
  }

  const oracle = oraclesById.get(dossier.oracle_id);
  if (!oracle) {
    diagnostic("E_ORACLE_REFERENCE", location, `oracle_id ${JSON.stringify(dossier.oracle_id)} is not defined`);
  }
  for (const source of dossier.sources ?? []) {
    if (isObject(source)) {
      validateArtifactBinding(source, oracle, `${location}:source:${source.id ?? "unknown"}`);
    }
  }
  if (!isObject(dossier.external_review_required)) {
    diagnostic("E_EXTERNAL_REVIEW", location, "external_review_required is required");
  } else {
    for (const field of ["expertise", "independence", "evidence", "blocking_before"]) {
      requireString(dossier.external_review_required[field], location, `external_review_required.${field}`);
    }
  }

  const expectation = renderExpectations.get(dossier.id);
  if (!expectation) {
    diagnostic("E_RENDER_FIXTURE", location, "missing render fixture");
  } else {
    const actual = digest(renderDossier(dossier));
    if (expectation.sha256 !== actual) {
      diagnostic("E_RENDER_HASH", location, `render hash mismatch; expected ${expectation.sha256}, got ${actual}`);
    }
  }
}

async function checkDossierMarkdown(dossier) {
  /**
   * Refuse before touching the filesystem. `validateDossier` already diagnoses a
   * non-canonical name, but recording a diagnostic does not stop this function:
   * both run unconditionally over every dossier, so a manifest naming
   * `../../../../etc/passwd` still reached `resolve(root, …)` and read it. The
   * run failed afterwards either way, which is why this was never a false
   * accept — but a checker that reads outside its own directory while
   * complaining about it is not the boundary this file claims to hold.
   */
  if (!isCanonicalDossierFilename(dossier?.file)) {
    diagnostic(
      "E_DOSSIER_FILE",
      `manifest.json:${dossier?.id ?? "unknown"}`,
      "dossier file is not a local numbered Markdown filename; no read was attempted",
    );
    return;
  }
  const path = resolve(root, dossier.file);
  const pathLabel = safePath(path);
  let body;
  try {
    body = await readFile(path, "utf8");
  } catch (error) {
    diagnostic("E_DOSSIER_READ", pathLabel, `unable to read dossier: ${error.code ?? "unknown error"}`);
    return;
  }

  const headings = [
    `# ${dossier.title}`,
    "## Exact statement",
    "## Falsifier",
    "## Motivation",
    "## Scope and out of scope",
    "## Authoritative anchored sources and rights",
    "## Known answer and target hash",
    "## Expected ledger objects and validator behavior",
    "## Safety and privacy",
    "## Freshness",
    "## External review required",
    "## No-claim boundary",
  ];
  for (const heading of headings) {
    if (!body.includes(heading)) {
      diagnostic("E_DOSSIER_HEADING", pathLabel, `missing required heading ${JSON.stringify(heading)}`);
    }
  }
  validateRenderedSection(body, "## Exact statement", dossier.statement, pathLabel, "E_RENDERED_STATEMENT_DRIFT");
  validateRenderedSection(body, "## Falsifier", dossier.falsifier, pathLabel, "E_RENDERED_FALSIFIER_DRIFT");
  if (!body.includes(dossier.freshness_date)) {
    diagnostic("E_RENDERED_FRESHNESS", pathLabel, "dossier must show its manifest freshness date");
  }
  if (body.includes("/Users/") || body.includes("file://")) {
    diagnostic("E_UNSAFE_DIAGNOSTIC", pathLabel, "dossier must not contain a local absolute path or file URI");
  }
  if (body.includes("PROVED")) {
    diagnostic("E_OVERCLAIM", pathLabel, "dossier must not use a PROVED label");
  }
  for (const source of dossier.sources) {
    if (!body.includes(source.id)) {
      diagnostic("E_SOURCE_REFERENCE", pathLabel, `dossier does not name source ${source.id}`);
    }
    if (!body.includes(source.url)) {
      diagnostic("E_RENDERED_SOURCE_URL", pathLabel, `dossier does not link source ${source.id} to its manifest URL`);
    }
  }
  if (!body.includes(dossier.oracle_id)) {
    diagnostic("E_ORACLE_REFERENCE", pathLabel, `dossier does not name hidden oracle ${dossier.oracle_id}`);
  }
  validateOracleDisclosure(oraclesById.get(dossier.oracle_id), body, pathLabel);
}

/**
 * Oracle leaves this checker already treats as the hidden answer itself, as
 * opposed to a binding a dossier is required to publish. The list is derived
 * from `validateCalibrationPlant` above, which already reads
 * `planted_candidate` and `smallest_counterexample` as the calibration answer,
 * plus the reproduction target value a participant is supposed to recompute.
 *
 * Paths are read from `oracles.json` at run time. No answer text is written
 * into this checker, so the guard cannot itself become a disclosure.
 *
 * Deliberately NOT adjudicated here, because deciding them is a judgement
 * about the seed science rather than a mechanical derivation, and both are
 * present in participant-facing text today:
 *
 *   - `declaration` (`Nat.exists_infinite_primes`) — plausibly the formalization
 *     answer, plausibly a legitimate citation.
 *   - `expected_review_verdict` (`refuted`) — plausibly a leaked verdict,
 *     plausibly the "expected ledger objects and validator behavior" section
 *     that this checker separately requires.
 *
 * Their absence from this list is an open question, not a clearance. Numeric
 * leaves are skipped by construction: only non-empty strings are compared, so
 * a bare `1` cannot match ordinary prose.
 */
const HIDDEN_ORACLE_ANSWER_PATHS = [
  ["planted_candidate"],
  ["planted_defect"],
  ["smallest_counterexample", "reason"],
  ["decimal"],
];

function hiddenOracleAnswers(oracle) {
  const answers = [];
  for (const path of HIDDEN_ORACLE_ANSWER_PATHS) {
    let node = oracle?.data;
    for (const key of path) node = isObject(node) ? node[key] : undefined;
    if (typeof node === "string" && node.trim().length > 0) {
      answers.push({ path: path.join("."), value: node });
    }
  }
  return answers;
}

/**
 * Refuse a participant-facing dossier that republishes a hidden oracle answer.
 * The diagnostic names only the oracle field path: echoing the matched value
 * would move the disclosure from the dossier into CI output.
 */
function validateOracleDisclosure(oracle, body, pathLabel) {
  if (typeof body !== "string") return;
  for (const answer of hiddenOracleAnswers(oracle)) {
    if (body.includes(answer.value)) {
      diagnostic(
        "E_ORACLE_DISCLOSED",
        pathLabel,
        `participant-facing dossier discloses hidden oracle answer ${answer.path}`,
      );
    }
  }
}

async function readJson(name) {
  try {
    return JSON.parse(await readFile(resolve(root, name), "utf8"));
  } catch {
    diagnostic("E_JSON_INPUT", name, "file is unreadable or invalid JSON");
    return {};
  }
}

async function probe(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    let response = await fetch(url, { method: "HEAD", redirect: "follow", signal: controller.signal });
    if (response.status === 405 || response.status === 403 || response.status === 501) {
      response = await fetch(url, {
        method: "GET",
        redirect: "follow",
        headers: { Range: "bytes=0-0" },
        signal: controller.signal,
      });
    }
    return { status: response.status, ok: response.status >= 200 && response.status < 400 };
  } catch (error) {
    return { status: "unreachable", ok: false, detail: error.name === "AbortError" ? "timed out" : "request failed" };
  } finally {
    clearTimeout(timer);
  }
}

async function checkExternalLinks(dossiers) {
  const sources = new Map();
  for (const dossier of dossiers) {
    for (const source of dossier.sources) sources.set(source.url, source);
  }
  for (const source of sources.values()) {
    const result = await probe(source.url);
    const location = `source:${source.id}`;
    if (!result.ok) {
      diagnostic("E_LINK_REACHABILITY", location, `${result.status}${result.detail ? ` (${result.detail})` : ""}`);
    }
    console.log(`link source=${source.id} status=${result.status}`);
    await checkDocumentationContentVersion(source);
  }
}

async function checkDocumentationContentVersion(source) {
  if (documentationPathVersion(source.url) === null || typeof source.observed_content_version !== "string") return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(source.url, { method: "GET", redirect: "follow", signal: controller.signal });
    if (!response.ok) {
      diagnostic("E_DOC_CONTENT_VERSION_REACHABILITY", `source:${source.id}`, `HTTP ${response.status}`);
      return;
    }
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(await response.text())?.[1].replace(/\s+/g, " ").trim();
    if (typeof title !== "string" || !title.includes(source.observed_content_version)) {
      diagnostic("E_DOC_CONTENT_VERSION_DRIFT", `source:${source.id}`, "rendered documentation title does not contain the declared observed content version");
      return;
    }
    console.log(`content-version source=${source.id} observed=${source.observed_content_version} status=${source.content_version_status}`);
  } catch (error) {
    diagnostic("E_DOC_CONTENT_VERSION_REACHABILITY", `source:${source.id}`, error.name === "AbortError" ? "timed out" : "request failed");
  } finally {
    clearTimeout(timer);
  }
}

async function checkPinnedArtifacts(dossiers) {
  const artifacts = new Map();
  for (const dossier of dossiers) {
    for (const source of dossier.sources) {
      if (isSha256(source.sha256)) artifacts.set(source.url, source);
    }
  }
  for (const source of artifacts.values()) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(source.url, { method: "GET", redirect: "follow", signal: controller.signal });
      if (!response.ok) {
        diagnostic("E_ARTIFACT_REACHABILITY", `source:${source.id}`, `HTTP ${response.status}`);
        continue;
      }
      const actual = createHash("sha256").update(new Uint8Array(await response.arrayBuffer())).digest("hex");
      if (actual !== source.sha256) {
        diagnostic("E_ARTIFACT_HASH", `source:${source.id}`, `expected ${source.sha256}, got ${actual}`);
      }
      console.log(`artifact source=${source.id} sha256=${actual}`);
    } catch (error) {
      diagnostic("E_ARTIFACT_REACHABILITY", `source:${source.id}`, error.name === "AbortError" ? "timed out" : "request failed");
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Run one planted control and decide the harness's own verdict.
 *
 * Ordering is the whole point and was previously wrong: the fixture's expected
 * diagnostics must be discarded FIRST, and only then may a control failure be
 * recorded. Recording before the splice pushed `E_NEGATIVE_NOT_DETECTED` at an
 * index at or after `before`, so the same splice deleted the one diagnostic
 * that signals a missing plant — a missing plant still exited 0. Every control
 * routes through this helper so that ordering exists in exactly one place.
 *
 * The matched diagnostic's detail is reported next to its code because a code
 * alone does not identify which branch produced it: one validator can emit the
 * same code from several branches, so a control asserting only the code stays
 * green when a regression moves the failure to a different branch. Details are
 * safe to print — the disclosure diagnostic names an oracle field path and
 * never its value.
 */
async function runPlantedControl(id, location, expectedDiagnostic, run) {
  const before = diagnostics.length;
  // Awaited, not called bare: the traversal control drives an async validator,
  // and a synchronous call would inspect `diagnostics` before that validator
  // ever pushed one — every async plant would read as missing. Synchronous
  // plants are unaffected, since awaiting a non-promise still resolves before
  // the slice below.
  await run();
  const detected = diagnostics.slice(before).find((entry) => entry.code === expectedDiagnostic);
  diagnostics.splice(before, diagnostics.length - before);
  if (!detected) {
    diagnostic(
      "E_NEGATIVE_NOT_DETECTED",
      location,
      `expected ${expectedDiagnostic} was not detected`,
    );
    return;
  }
  console.log(
    `planted-negative id=${id} status=detected diagnostic=${expectedDiagnostic} detail=${detected.detail}`,
  );
}

function runPlantedNegative(fixture) {
  return runPlantedControl(
    fixture.id,
    "fixtures/planted-negative-missing-anchor.json",
    fixture.expected_diagnostic,
    () =>
      validateSource(
        fixture.source,
        `fixtures/planted-negative-missing-anchor.json:${fixture.id}`,
      ),
  );
}

function runPlantedRenderedDrift(fixture) {
  return runPlantedControl(
    fixture.id,
    "fixtures/planted-negative-rendered-statement-drift.json",
    fixture.expected_diagnostic,
    () =>
      validateRenderedSection(
        fixture.body,
        fixture.heading,
        fixture.expected_text,
        `fixtures/planted-negative-rendered-statement-drift.json:${fixture.id}`,
        fixture.expected_diagnostic,
      ),
  );
}

/**
 * Causal control for the absent-section branch. The fixture's body contains the
 * required heading only as a substring of a decorated one, so the anchored
 * extraction returns null. Restore the bare `if (actual === null) return;` and
 * this control misses with `E_NEGATIVE_NOT_DETECTED`.
 */
function runPlantedDecoratedHeading(fixture) {
  return runPlantedControl(
    fixture.id,
    "fixtures/planted-negative-decorated-heading.json",
    fixture.expected_diagnostic,
    () =>
      validateRenderedSection(
        fixture.body,
        fixture.heading,
        fixture.expected_text,
        `fixtures/planted-negative-decorated-heading.json:${fixture.id}`,
        fixture.expected_diagnostic,
      ),
  );
}

function runPlantedDocumentationVersionDrift(fixture) {
  return runPlantedControl(
    fixture.id,
    "fixtures/planted-negative-doc-url-version-alone.json",
    fixture.expected_diagnostic,
    () =>
      validateSource(
        fixture.source,
        `fixtures/planted-negative-doc-url-version-alone.json:${fixture.id}`,
      ),
  );
}

function validateCalibrationPlant(dossier, oracle, location) {
  if (!isObject(dossier) || typeof dossier.statement !== "string") {
    diagnostic("E_PLANTED_ERROR_TARGET", location, "calibration target statement is absent or malformed");
    return;
  }
  const expectedCandidate = dossier.statement.replace("n ≤ p", "p ≤ n");
  if (oracle?.data?.planted_candidate !== expectedCandidate) {
    diagnostic("E_PLANTED_ERROR_NOT_REVERSED", location, "calibration oracle must contain the exact reversed-inequality candidate");
  }
  if (oracle?.data?.smallest_counterexample?.n !== 1) {
    diagnostic("E_PLANTED_ERROR_COUNTEREXAMPLE", location, "calibration oracle must preserve n = 1 as the smallest counterexample");
  }
  if (oracle?.data?.expected_review_verdict !== "refuted") {
    diagnostic("E_PLANTED_ERROR_VERDICT", location, "calibration oracle must require a refuted verdict");
  }
}

function runPlantedArtifactDrift(fixture) {
  return runPlantedControl(
    fixture.id,
    "fixtures/planted-negative-artifact-drift.json",
    fixture.expected_diagnostic,
    () =>
      validateArtifactBinding(
        fixture.source,
        fixture.oracle,
        `fixtures/planted-negative-artifact-drift.json:${fixture.id}`,
      ),
  );
}

function runPlantedCalibrationDrift(fixture) {
  return runPlantedControl(
    fixture.id,
    "fixtures/planted-negative-calibration-drift.json",
    fixture.expected_diagnostic,
    () =>
      validateCalibrationPlant(
        fixture.dossier,
        fixture.oracle,
        `fixtures/planted-negative-calibration-drift.json:${fixture.id}`,
      ),
  );
}

/**
 * Causal control for the disclosure guard. The plant is entirely synthetic:
 * it carries no real oracle text, so this control can never itself publish an
 * answer, and it stays inline rather than in `fixtures/` for the same reason.
 * If the guard is removed, `E_ORACLE_DISCLOSED` stops firing here and the run
 * fails with `E_NEGATIVE_NOT_DETECTED`.
 */
function runPlantedOracleDisclosure() {
  const plantedAnswer = "SYNTHETIC-PLANTED-ORACLE-ANSWER-NOT-REAL-CONTENT";
  return runPlantedControl(
    "synthetic-oracle-disclosure",
    "planted-negative:synthetic-oracle-disclosure",
    "E_ORACLE_DISCLOSED",
    () =>
      validateOracleDisclosure(
        { data: { planted_candidate: plantedAnswer } },
        `## Exact statement\n${plantedAnswer}\n`,
        "planted-negative:synthetic-oracle-disclosure",
      ),
  );
}

/**
 * Causal control for the pre-read filename guard.
 *
 * The synthetic dossier names a path that escapes this directory but is
 * certain to exist, so the counterfactual is observable rather than hypothetical:
 * remove the early return in `checkDossierMarkdown` and the read succeeds, the
 * heading checks fire against the wrong file's bytes, `E_DOSSIER_FILE` is never
 * emitted from that function, and this control misses with
 * `E_NEGATIVE_NOT_DETECTED`. With the guard in place nothing outside the seed
 * directory is opened at all. Entirely in memory: no file is created, written,
 * copied, or removed, and the traversal target is only ever named, never read.
 */
function runPlantedFilenameTraversal() {
  return runPlantedControl(
    "synthetic-filename-traversal",
    "planted-negative:synthetic-filename-traversal",
    "E_DOSSIER_FILE",
    () =>
      checkDossierMarkdown({
        id: "synthetic-filename-traversal",
        file: "../../../package.json",
        title: "Synthetic traversal control",
        statement: "not compared",
        falsifier: "not compared",
        freshness_date: "2026-08-13",
        oracle_id: "synthetic-oracle",
        sources: [],
      }),
  );
}

/**
 * Ordering control for the plant harness itself. It runs a committed fixture
 * through the real validator while expecting a diagnostic that validator can
 * never emit, so the control must miss. A missing plant has to survive the
 * splice and exit non-zero; if `E_NEGATIVE_NOT_DETECTED` is ever filtered away
 * again, this exits 0 and its test fails. In-memory only: nothing is created,
 * written, copied, or removed.
 */
function runMissingPlantControl(fixture) {
  return runPlantedControl(
    "synthetic-missing-plant",
    "missing-plant-control",
    "E_DIAGNOSTIC_NEVER_EMITTED_BY_THIS_VALIDATOR",
    () => validateSource(fixture.source, "missing-plant-control"),
  );
}

/**
 * Exit-code control. Every other planted negative discards its diagnostic so a
 * self-test run can still pass; that proves detection but never proves this
 * checker *fails* on a bad input, which is the only property that makes it
 * usable as a gate.
 *
 * `--self-test-fail` runs one already-committed invalid fixture through the
 * real validator and deliberately RETAINS its diagnostic, so the process exits
 * non-zero with a genuine code. It reads committed fixtures only and mutates
 * nothing: no file is created, written, copied, or removed.
 */
function runRetainedFailure(fixture) {
  validateSource(
    fixture.source,
    `retained-failure:fixtures/planted-negative-missing-anchor.json:${fixture.id}`,
  );
}

function printDigestCandidates(oracles, dossiers) {
  for (const oracle of oracles) console.log(`digest oracle=${oracle.id} sha256=${digest(oracle.data)}`);
  for (const dossier of dossiers) console.log(`digest render=${dossier.id} sha256=${digest(renderDossier(dossier))}`);
}

const [manifest, oracleDocument, renderDocument, missingAnchorFixture, renderedDriftFixture, decoratedHeadingFixture, documentationVersionFixture, artifactDriftFixture, calibrationDriftFixture] = await Promise.all([
  readJson("manifest.json"),
  readJson("oracles.json"),
  readJson("fixtures/render-expectations.json"),
  readJson("fixtures/planted-negative-missing-anchor.json"),
  readJson("fixtures/planted-negative-rendered-statement-drift.json"),
  readJson("fixtures/planted-negative-decorated-heading.json"),
  readJson("fixtures/planted-negative-doc-url-version-alone.json"),
  readJson("fixtures/planted-negative-artifact-drift.json"),
  readJson("fixtures/planted-negative-calibration-drift.json"),
]);

const dossiers = Array.isArray(manifest.dossiers) ? manifest.dossiers : [];
const oracles = Array.isArray(oracleDocument.oracles) ? oracleDocument.oracles : [];
const oraclesById = new Map(oracles.map((oracle) => [oracle.id, oracle]));
const renderExpectations = new Map((renderDocument.renders ?? []).map((entry) => [entry.id, entry]));

if (dossiers.length !== 5) diagnostic("E_DOSSIER_COUNT", "manifest.json", "exactly five dossiers are required");
if (new Set(dossiers.map((dossier) => dossier.rung)).size !== 5) diagnostic("E_RUNG_UNIQUENESS", "manifest.json", "rungs 1 through 5 must each appear exactly once");
if (!isIsoDate(manifest.freshness_date)) diagnostic("E_SET_FRESHNESS_DATE", "manifest.json", "freshness_date must use YYYY-MM-DD");
if (oracleDocument.visibility !== "operator-only; never include this file in participant-facing packs or initial review prompts") {
  diagnostic("E_ORACLE_VISIBILITY", "oracles.json", "oracle visibility boundary is missing or weakened");
}

for (const oracle of oracles) {
  const location = `oracles.json:${oracle?.id ?? "unknown"}`;
  requireString(oracle?.id, location, "id");
  if (!isObject(oracle?.data)) diagnostic("E_ORACLE_DATA", location, "oracle data must be an object");
  const actual = digest(oracle?.data);
  if (oracle?.sha256 !== actual) {
    diagnostic("E_ORACLE_HASH", location, `oracle hash mismatch; expected ${oracle?.sha256}, got ${actual}`);
  }
}

for (const dossier of dossiers) validateDossier(dossier, oraclesById, renderExpectations);
validateCalibrationPlant(
  dossiers.find((dossier) => dossier.id === "rung-1-calibration"),
  oraclesById.get("oracle-calibration-unbounded-primes-v1"),
  "oracles.json:oracle-calibration-unbounded-primes-v1",
);
await Promise.all(dossiers.map(checkDossierMarkdown));
if (selfTest) await runPlantedNegative(missingAnchorFixture);
if (selfTest) await runPlantedRenderedDrift(renderedDriftFixture);
if (selfTest) await runPlantedDecoratedHeading(decoratedHeadingFixture);
if (selfTest) await runPlantedDocumentationVersionDrift(documentationVersionFixture);
if (selfTest) await runPlantedArtifactDrift(artifactDriftFixture);
if (selfTest) await runPlantedCalibrationDrift(calibrationDriftFixture);
if (selfTest) await runPlantedOracleDisclosure();
if (selfTest) await runPlantedFilenameTraversal();
if (selfTestFail) runRetainedFailure(missingAnchorFixture);
if (selfTestMiss) await runMissingPlantControl(missingAnchorFixture);
if (emitDigests) printDigestCandidates(oracles, dossiers);
if (checkLinks) await checkExternalLinks(dossiers);
if (checkArtifacts) await checkPinnedArtifacts(dossiers);

const duration = Math.round(performance.now() - started);
const suite = checkLinks && checkArtifacts
  ? "source-contract+links+artifacts"
  : checkLinks
    ? "source-contract+links"
    : checkArtifacts
      ? "source-contract+artifacts"
      : selfTestFail
        ? "source-contract+retained-failure"
        : selfTestMiss
          ? "source-contract+missing-plant-control"
          : selfTest
            ? "source-contract+planted-negative"
            : "source-contract";
const reproductionArgs = [
  checkLinks ? "--check-links" : null,
  checkArtifacts ? "--check-artifacts" : null,
  selfTest ? "--self-test" : null,
  selfTestFail ? "--self-test-fail" : null,
  selfTestMiss ? "--self-test-miss" : null,
]
  .filter(Boolean)
  .join(" ");
const reproduction = `bun docs/seed/rungs-1-5/check.mjs${reproductionArgs ? ` ${reproductionArgs}` : ""}`;

if (diagnostics.length > 0) {
  for (const entry of diagnostics) {
    console.error(`diagnostic code=${entry.code} location=${entry.location} detail=${entry.detail}`);
  }
  console.error(`tool=bun package=seed-dossier-check suite=${suite} version=${CHECK_VERSION} duration_ms=${duration} status=failed reproduce=${reproduction}`);
  process.exitCode = 1;
} else {
  console.log(`tool=bun package=seed-dossier-check suite=${suite} version=${CHECK_VERSION} duration_ms=${duration} status=passed reproduce=${reproduction}`);
}
