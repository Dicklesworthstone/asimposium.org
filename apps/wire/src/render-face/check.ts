#!/usr/bin/env bun
/**
 * Phase 2 of the S-5 spike: compare what the local Worker *serves* against what the render
 * package produces in this process (bead asimposiumorg-6jo).
 *
 * Phase 1 proves the renderer is deterministic. It cannot prove that the bytes survive a
 * real HTTP hop with the right media type, that the ETag a client sees is the projection's
 * own fingerprint, that a conditional request yields a bodiless 304, or that the public
 * variant carries no workshop byte after crossing the wire. This does, against workerd.
 *
 * Diffs are bounded and redacted: a mismatch reports the first differing offset, both
 * lengths and both digests — never the differing bytes, because a body may contain workshop
 * content and a build log is not the place for it.
 *
 * Usage: invoked by scripts/e2e-s5-diptych.sh, which supplies closed origin, provenance and
 * exact tool-version inputs. Direct invocation without that contract is intentionally refused.
 */

import {
  contentFingerprint,
  type FaceFormat,
  MEDIA_TYPES,
  renderProjection,
  type SpikeVariant,
  s5Canary,
  s5SpikeProjection,
} from "@asimposium/render";
import {
  assertSafeRunId,
  assertSafeS5Seed,
  assertSafeToolVersion,
  assertSecretSafe,
  DiagnosticSafetyError,
  formatDiagnostic,
} from "../../../../packages/render/scripts/diagnostics.ts";
import { provenance } from "../../../../packages/render/scripts/provenance.ts";

const REPRO = "bash scripts/e2e-s5-diptych.sh";
const REQUEST_USER_AGENT = "OpenAI File Downloader, XaiImageApiFetch/1.0";
let origin: string;
let seed: string;
let canary: string;
let diagnosticBase: Record<string, unknown>;

let failures = 0;
let diagnosticSafetyRefused = false;

interface ExpectedRuntime {
  readonly sourceDigest: string;
  readonly sourceFiles: number;
  readonly bunVersion: string;
  readonly wranglerVersion: string;
}

/**
 * The validator this checker expects: SHA-256 over the exact bytes the response carried.
 * Computed here independently, so agreement is evidence rather than a shared helper.
 */
async function representationEtag(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return `"sha256:${hex}"`;
}

function assertLoopbackS5Origin(value: string | undefined): string {
  if (value === undefined) throw new DiagnosticSafetyError("origin", "is not supplied");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new DiagnosticSafetyError("origin", "is not a URL");
  }
  const port = Number(parsed.port);
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new DiagnosticSafetyError("origin", "is not an exact loopback HTTP origin");
  }
  return `http://127.0.0.1:${port}`;
}

function expectedRuntime(): ExpectedRuntime {
  const sourceDigest = process.env.S5_EXPECTED_SOURCE_DIGEST;
  const sourceFiles = process.env.S5_EXPECTED_SOURCE_FILES;
  const bunVersion = process.env.S5_EXPECTED_BUN_VERSION;
  const wranglerVersion = process.env.S5_EXPECTED_WRANGLER_VERSION;
  if (sourceDigest === undefined || !/^sha256:[0-9a-f]{64}$/.test(sourceDigest))
    throw new DiagnosticSafetyError("source_digest", "is not an exact expected digest");
  if (sourceFiles === undefined || !/^[1-9][0-9]*$/.test(sourceFiles))
    throw new DiagnosticSafetyError("source_files", "is not an exact expected input count");
  assertSafeToolVersion("bun_version", bunVersion ?? "");
  assertSafeToolVersion("wrangler_version", wranglerVersion ?? "");
  assertSecretSafe({ source_digest: sourceDigest, source_files: Number(sourceFiles) });
  return {
    sourceDigest,
    sourceFiles: Number(sourceFiles),
    bunVersion: bunVersion as string,
    wranglerVersion: wranglerVersion as string,
  };
}

async function initialize(): Promise<void> {
  const candidateSeed = process.env.S5_SEED ?? "s5-fixed-seed-v1";
  const candidateRunId = process.env.S5_RUN_ID ?? "s5-local-run";
  // Validate before provenance or any request. Neither supplied value can reach a record
  // until it has crossed the same renderer-owned secret-safety boundary as every emit.
  assertSafeRunId(candidateRunId);
  assertSafeS5Seed(candidateSeed);
  const candidateOrigin = assertLoopbackS5Origin(process.env.S5_ORIGIN);
  const expected = expectedRuntime();
  const run = await provenance();
  assertSafeToolVersion("bun_version", run.bun_version);
  assertSafeToolVersion("wrangler_version", run.wrangler_version);
  if (
    run.source_digest !== expected.sourceDigest ||
    run.source_files !== expected.sourceFiles ||
    run.bun_version !== expected.bunVersion ||
    run.wrangler_version !== expected.wranglerVersion ||
    Bun.version !== expected.bunVersion
  ) {
    throw new DiagnosticSafetyError("runtime", "does not match the launcher contract");
  }
  const base = {
    spike: "s5-diptych",
    phase: "worker-served",
    repro: REPRO,
    run_id: candidateRunId,
    seed: candidateSeed,
    revision: run.revision,
    revision_state: run.revision_state,
    source_digest: run.source_digest,
    source_files: run.source_files,
    bun_version: run.bun_version,
    wrangler_version: run.wrangler_version,
  };
  assertSecretSafe(base);
  seed = candidateSeed;
  origin = candidateOrigin;
  canary = s5Canary(seed);
  diagnosticBase = base;
}

/**
 * Startup has no validated caller values or trustworthy source digest yet. The refusal is
 * therefore fully static: it remains parseable and has every provenance key, but does not
 * fabricate provenance or repeat the rejected environment value, path, error, or stack.
 */
function emitBoundaryRefusal(): void {
  const refusal = {
    spike: "s5-diptych",
    phase: "worker-served",
    repro: REPRO,
    run_id: "s5-checker-refusal-v1",
    seed: "<refused>",
    revision: "unknown",
    revision_state: "unknown",
    source_digest: "unavailable",
    source_files: 0,
    bun_version: "unavailable",
    wrangler_version: "unavailable",
    assertion: "checker_boundary_refused",
    status: "fail",
    code: "CHECKER_BOUNDARY_REFUSED",
    detail: "phase-2 checker startup was refused by the safety boundary",
  };
  assertSecretSafe(refusal);
  process.stdout.write(`${formatDiagnostic(refusal as unknown as never)}\n`);
}

/**
 * The rejected value must not shape the refusal: an unsafe diagnostic is exactly the case
 * where echoing the value, error message, or stack would repeat the leak we are preventing.
 */
function emitDiagnosticSafetyRefusal(): void {
  const refusal = {
    ...diagnosticBase,
    assertion: "diagnostic_safety_refused",
    status: "fail",
    code: "DIAGNOSTIC_SAFETY_REFUSED",
    detail: "a phase-2 diagnostic was refused by the secret-safety policy",
  };
  assertSecretSafe(refusal);
  process.stdout.write(`${formatDiagnostic(refusal as unknown as never)}\n`);
}

/** Main failures must not turn a local Worker error, parser error or stack into a build log. */
function emitRuntimeRefusal(): void {
  const refusal = {
    ...diagnosticBase,
    assertion: "checker_runtime_refused",
    status: "fail",
    code: "CHECKER_RUNTIME_REFUSED",
    detail: "phase-2 checker stopped after an unexpected local Worker result",
  };
  assertSecretSafe(refusal);
  process.stdout.write(`${formatDiagnostic(refusal as unknown as never)}\n`);
}

function emit(record: Record<string, unknown>): boolean {
  if (diagnosticSafetyRefused) return false;
  const complete = { ...diagnosticBase, ...record };
  try {
    assertSecretSafe(complete);
  } catch (error) {
    if (!(error instanceof DiagnosticSafetyError)) throw error;
    diagnosticSafetyRefused = true;
    if (record.status === "pass") failures += 1;
    emitDiagnosticSafetyRefusal();
    return false;
  }
  process.stdout.write(`${formatDiagnostic(complete as unknown as never)}\n`);
  return true;
}

function check(
  assertion: string,
  ok: boolean,
  detail: string,
  extra: Record<string, unknown> = {},
): void {
  if (!ok) failures += 1;
  emit({ assertion, status: ok ? "pass" : "fail", detail: ok ? "as expected" : detail, ...extra });
}

function s5Fetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("user-agent", REQUEST_USER_AGENT);
  return fetch(`${origin}${path}`, { ...init, headers });
}

/** First differing offset plus both digests. Never the bytes themselves. */
function boundedDiff(left: string, right: string): Record<string, unknown> {
  let at = 0;
  while (at < Math.min(left.length, right.length) && left[at] === right[at]) at += 1;
  return {
    first_difference_at: at,
    served_bytes: right.length,
    local_bytes: left.length,
    served_digest: contentFingerprint(right),
    local_digest: contentFingerprint(left),
  };
}

async function main(): Promise<void> {
  const formats: FaceFormat[] = ["md", "json", "html-fragment"];
  const variants: SpikeVariant[] = ["public", "sponsor"];

  check("checker_provenance_matches_launcher", true, "launcher contract matched current inputs");

  for (const variant of variants) {
    for (const format of formats) {
      const local = renderProjection(s5SpikeProjection(variant, seed), format);
      const started = performance.now();
      const response = await s5Fetch(`/__s5/face?variant=${variant}&format=${format}`);
      const served = await response.text();
      const duration = Math.round(performance.now() - started);
      const context = { variant, face: format, duration_ms: duration };

      check(
        `served_${format}_status_200`,
        response.status === 200,
        `status ${response.status}`,
        context,
      );
      check(
        `served_${format}_bytes_match_local_render`,
        served === local.body,
        "served bytes differ from the local render",
        { ...context, ...(served === local.body ? {} : boundedDiff(local.body, served)) },
      );
      check(
        `served_${format}_content_type`,
        response.headers.get("content-type") === MEDIA_TYPES[format],
        `content-type ${String(response.headers.get("content-type"))}`,
        context,
      );
      const servedEtag = response.headers.get("etag") ?? "";
      check(
        `served_${format}_etag_is_a_sha256_of_the_representation`,
        servedEtag === (await representationEtag(served)),
        "served ETag did not match the local representation",
        { ...context, etag: servedEtag },
      );
      check(
        `served_${format}_etag_is_not_the_projection_fingerprint`,
        servedEtag.length > 0 && !servedEtag.includes(local.fingerprint),
        "a projection-wide checksum cannot be a strong per-representation validator",
        context,
      );
      check(
        `served_${format}_fingerprint_is_served_separately`,
        response.headers.get("x-asimp-fingerprint") === local.fingerprint,
        `x-asimp-fingerprint ${String(response.headers.get("x-asimp-fingerprint"))}`,
        context,
      );
      check(
        `served_${format}_carries_nosniff`,
        response.headers.get("x-content-type-options") === "nosniff",
        `x-content-type-options ${String(response.headers.get("x-content-type-options"))}`,
        context,
      );

      // HEAD must agree with GET on every validator-bearing header, and carry no body.
      const head = await s5Fetch(`/__s5/face?variant=${variant}&format=${format}`, {
        method: "HEAD",
      });
      check(
        `served_${format}_head_parity`,
        head.status === 200 &&
          head.headers.get("etag") === servedEtag &&
          head.headers.get("content-type") === MEDIA_TYPES[format] &&
          (await head.text()).length === 0,
        "HEAD headers or body disagreed with GET",
        { ...context, etag: servedEtag, head_etag: head.headers.get("etag") ?? "" },
      );

      // Conditional replay: same validator, no body, same headers.
      const conditional = await s5Fetch(`/__s5/face?variant=${variant}&format=${format}`, {
        headers: { "if-none-match": servedEtag },
      });
      const conditionalBody = await conditional.text();
      check(
        `served_${format}_conditional_304`,
        conditional.status === 304,
        `status ${conditional.status}`,
        context,
      );
      check(
        `served_${format}_304_has_no_body`,
        conditionalBody.length === 0,
        `${conditionalBody.length} bytes`,
        context,
      );
      check(
        `served_${format}_304_keeps_the_validator`,
        conditional.headers.get("etag") === servedEtag,
        "304 did not keep the GET validator",
        { ...context, etag: servedEtag, conditional_etag: conditional.headers.get("etag") ?? "" },
      );

      // `*` matches whenever a representation exists (RFC 9110 §13.1.2), and a weak
      // validator for the same representation matches under weak comparison.
      const wildcard = await s5Fetch(`/__s5/face?variant=${variant}&format=${format}`, {
        headers: { "if-none-match": "*" },
      });
      check(
        `served_${format}_wildcard_validator_is_304`,
        wildcard.status === 304 && (await wildcard.text()).length === 0,
        `status ${wildcard.status}`,
        context,
      );
      const weak = await s5Fetch(`/__s5/face?variant=${variant}&format=${format}`, {
        headers: { "if-none-match": `W/${servedEtag}` },
      });
      check(
        `served_${format}_weak_validator_matches`,
        weak.status === 304,
        `status ${weak.status}`,
        context,
      );

      // A stale validator must still get the full body.
      const stale = await s5Fetch(`/__s5/face?variant=${variant}&format=${format}`, {
        headers: { "if-none-match": `"sha256:${"0".repeat(64)}"` },
      });
      check(
        `served_${format}_stale_validator_returns_200`,
        stale.status === 200,
        `status ${stale.status}`,
        context,
      );

      if (variant === "public") {
        check(
          `served_${format}_public_face_has_no_workshop_byte`,
          !served.includes(canary) && !served.includes("W-demo-fellow-03"),
          "a workshop byte or id crossed the wire on a public face",
          { ...context, canary_digest: contentFingerprint(canary) },
        );
      } else {
        check(
          `served_${format}_sponsor_face_carries_the_canary`,
          served.includes(canary),
          "the canary never reached the sponsor view, so its absence elsewhere proves nothing",
          { ...context, canary_digest: contentFingerprint(canary) },
        );
      }
    }
  }

  // The cross-representation negative. A validator identifies one representation; if an md
  // ETag can satisfy the json or html face, a client is told a copy it does not hold is
  // fresh, and it receives no body to discover otherwise.
  {
    const mdResponse = await s5Fetch("/__s5/face?variant=public&format=md");
    const mdEtag = mdResponse.headers.get("etag") ?? "";
    for (const other of ["json", "html-fragment"] as const) {
      const crossed = await s5Fetch(`/__s5/face?variant=public&format=${other}`, {
        headers: { "if-none-match": mdEtag },
      });
      const crossedBody = await crossed.text();
      check(
        `md_validator_cannot_satisfy_the_${other}_face`,
        crossed.status === 200 && crossedBody.length > 0,
        `status ${crossed.status} with ${crossedBody.length} bytes`,
        { variant: "public", face: other },
      );
    }
    const crossedVariant = await s5Fetch("/__s5/face?variant=sponsor&format=md", {
      headers: { "if-none-match": mdEtag },
    });
    check(
      "public_validator_cannot_satisfy_the_sponsor_face",
      crossedVariant.status === 200,
      `status ${crossedVariant.status}`,
      { variant: "sponsor", face: "md" },
    );
  }

  // Teaching refusals.
  const unknownFormat = await s5Fetch("/__s5/face?format=toon");
  const unknownBody = (await unknownFormat.json()) as Record<string, unknown>;
  check("unknown_format_is_400", unknownFormat.status === 400, `status ${unknownFormat.status}`);
  check(
    "teaching_refusal_carries_nosniff",
    unknownFormat.headers.get("x-content-type-options") === "nosniff",
    // It reflects the caller's own string back, which §7.7 wants; it must not be sniffable.
    `x-content-type-options ${String(unknownFormat.headers.get("x-content-type-options"))}`,
  );
  check("unknown_format_code", unknownBody.code === "UNKNOWN_FORMAT", String(unknownBody.code));
  check(
    "unknown_format_teaches_the_allowed_set",
    Array.isArray(unknownBody.allowed) &&
      unknownBody.allowed.length === 3 &&
      typeof unknownBody.fix_hint === "string",
    JSON.stringify(unknownBody.allowed),
  );

  const unknownVariant = await s5Fetch("/__s5/face?variant=everything");
  check("unknown_variant_is_400", unknownVariant.status === 400, `status ${unknownVariant.status}`);

  const unknownRoute = await s5Fetch("/p/demo-bounded-sums.md");
  check(
    "the harness serves no product route",
    unknownRoute.status === 404,
    `status ${unknownRoute.status} — a spike must not pre-empt the contracted product face surface`,
  );

  const write = await s5Fetch("/__s5/face", { method: "POST" });
  check("the harness refuses writes", write.status === 400, `status ${write.status}`);

  emit({
    assertion: "phase2_summary",
    status: failures === 0 ? "pass" : "fail",
    detail:
      failures === 0
        ? "served faces match the local render byte for byte"
        : `${failures} assertion(s) failed`,
    scope: "local-workerd, harness entrypoint, no binding touched",
  });
}

async function run(): Promise<number> {
  try {
    await initialize();
  } catch {
    emitBoundaryRefusal();
    return 1;
  }
  try {
    await main();
  } catch {
    failures += 1;
    emitRuntimeRefusal();
    return 1;
  }
  return failures === 0 ? 0 : 1;
}

process.exitCode = await run();
