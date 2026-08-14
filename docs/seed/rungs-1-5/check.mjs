#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CHECK_VERSION = "1.0.0";
const root = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const checkLinks = args.has("--check-links");
const selfTest = args.has("--self-test");
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
  if (typeof source.access_date === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(source.access_date)) {
    diagnostic("E_SOURCE_DATE", location, "source access_date must use YYYY-MM-DD");
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

function validateDossier(dossier, oracleIds, renderExpectations) {
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

  if (!Number.isInteger(dossier.rung) || dossier.rung < 1 || dossier.rung > 5) {
    diagnostic("E_RUNG", location, "rung must be an integer from 1 through 5");
  }
  if (!/^[0-9]{2}-[a-z0-9-]+\.md$/.test(dossier.file ?? "")) {
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

  if (!oracleIds.has(dossier.oracle_id)) {
    diagnostic("E_ORACLE_REFERENCE", location, `oracle_id ${JSON.stringify(dossier.oracle_id)} is not defined`);
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
  }
  if (!body.includes(dossier.oracle_id)) {
    diagnostic("E_ORACLE_REFERENCE", pathLabel, `dossier does not name hidden oracle ${dossier.oracle_id}`);
  }
}

async function readJson(name) {
  return JSON.parse(await readFile(resolve(root, name), "utf8"));
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
  }
}

function runPlantedNegative(fixture) {
  const before = diagnostics.length;
  validateSource(fixture.source, `fixtures/planted-negative-missing-anchor.json:${fixture.id}`);
  const detected = diagnostics.slice(before).some((entry) => entry.code === fixture.expected_diagnostic);
  if (!detected) {
    diagnostic("E_NEGATIVE_NOT_DETECTED", "fixtures/planted-negative-missing-anchor.json", `expected ${fixture.expected_diagnostic} was not detected`);
  }
  diagnostics.splice(before, diagnostics.length - before);
  if (detected) console.log(`planted-negative id=${fixture.id} status=detected diagnostic=${fixture.expected_diagnostic}`);
}

function printDigestCandidates(oracles, dossiers) {
  for (const oracle of oracles) console.log(`digest oracle=${oracle.id} sha256=${digest(oracle.data)}`);
  for (const dossier of dossiers) console.log(`digest render=${dossier.id} sha256=${digest(renderDossier(dossier))}`);
}

const [manifest, oracleDocument, renderDocument, negativeFixture] = await Promise.all([
  readJson("manifest.json"),
  readJson("oracles.json"),
  readJson("fixtures/render-expectations.json"),
  readJson("fixtures/planted-negative-missing-anchor.json"),
]);

const dossiers = Array.isArray(manifest.dossiers) ? manifest.dossiers : [];
const oracles = Array.isArray(oracleDocument.oracles) ? oracleDocument.oracles : [];
const oracleIds = new Set(oracles.map((oracle) => oracle.id));
const renderExpectations = new Map((renderDocument.renders ?? []).map((entry) => [entry.id, entry]));

if (dossiers.length !== 5) diagnostic("E_DOSSIER_COUNT", "manifest.json", "exactly five dossiers are required");
if (new Set(dossiers.map((dossier) => dossier.rung)).size !== 5) diagnostic("E_RUNG_UNIQUENESS", "manifest.json", "rungs 1 through 5 must each appear exactly once");
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

for (const dossier of dossiers) validateDossier(dossier, oracleIds, renderExpectations);
await Promise.all(dossiers.map(checkDossierMarkdown));
if (selfTest) runPlantedNegative(negativeFixture);
if (emitDigests) printDigestCandidates(oracles, dossiers);
if (checkLinks) await checkExternalLinks(dossiers);

const duration = Math.round(performance.now() - started);
const suite = checkLinks ? "source-contract+links" : selfTest ? "source-contract+planted-negative" : "source-contract";
const reproduction = checkLinks
  ? "bun docs/seed/rungs-1-5/check.mjs --check-links"
  : selfTest
    ? "bun docs/seed/rungs-1-5/check.mjs --self-test"
    : "bun docs/seed/rungs-1-5/check.mjs";

if (diagnostics.length > 0) {
  for (const entry of diagnostics) {
    console.error(`diagnostic code=${entry.code} location=${entry.location} detail=${entry.detail}`);
  }
  console.error(`tool=bun package=seed-dossier-check suite=${suite} version=${CHECK_VERSION} duration_ms=${duration} status=failed reproduce=${reproduction}`);
  process.exitCode = 1;
} else {
  console.log(`tool=bun package=seed-dossier-check suite=${suite} version=${CHECK_VERSION} duration_ms=${duration} status=passed reproduce=${reproduction}`);
}
