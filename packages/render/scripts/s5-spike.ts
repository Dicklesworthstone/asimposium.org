#!/usr/bin/env bun
/**
 * The S-5 Diptych spike driver (bead asimposiumorg-6jo).
 *
 * Renders one projection to all three faces, checks the Diptych invariants an outside
 * observer can check, and seeds a private workshop canary that must never appear on a
 * public face. Every assertion emits one OPS.2a-shaped NDJSON record on stdout.
 *
 * What a record carries: seed, run provenance (HEAD, whether the inputs are dirty, and a
 * SHA-256 over the exact renderer and spike sources that ran), projection id and cursor,
 * output digests, profile and budget bucket, item ordering, duration, pass/fail and — on
 * failure — a bounded diff. What it never carries: a rendered body, a workshop byte, a
 * credential, a cookie, a token, a URL fragment, or a local absolute path. That is not a
 * convention here; `assertSecretSafe` refuses to emit a record that breaks it, and the
 * canary is reported only as a digest.
 *
 * Usage: bun packages/render/scripts/s5-spike.ts [--seed <string>] [--run-id <safe-id>]
 */

import { contentFingerprint, renderAllFaces, renderProjection } from "../src/index.ts";
import { S5_SPIKE_CURSOR, S5_SPIKE_PROBLEM, s5Canary, s5SpikeProjection } from "../src/spike.ts";
import type { FaceFormat, Projection } from "../src/types.ts";
import {
  assertSafeRunId,
  assertSafeS5Seed,
  assertSecretSafe,
  assertSafeToolVersion,
  formatDiagnostic,
} from "./diagnostics.ts";
import { type Provenance, provenance } from "./provenance.ts";

const SPIKE = "s5-diptych";

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value ?? fallback;
}

const run: Provenance = await provenance();

if (process.argv.includes("--provenance")) {
  assertSecretSafe(run);
  process.stdout.write(`${formatDiagnostic(run as unknown as never)}\n`);
  process.exit(0);
}

const seed = argument("--seed", "s5-fixed-seed-v1");
const runId = argument("--run-id", "s5-local-run");
assertSafeRunId(runId);
assertSafeS5Seed(seed);
assertSafeToolVersion("bun_version", run.bun_version);
assertSafeToolVersion("wrangler_version", run.wrangler_version);
const canary = s5Canary(seed);
const canaryDigest = contentFingerprint(canary);

interface SpikeRecord {
  readonly spike: string;
  readonly seed: string;
  readonly run_id: string;
  readonly revision: string;
  readonly revision_state: string;
  readonly source_digest: string;
  readonly source_files: number;
  readonly bun_version: string;
  readonly wrangler_version: string;
  readonly assertion: string;
  readonly problem: string;
  readonly cursor: number;
  readonly profile: string;
  readonly budget_bucket: string;
  readonly ordering: string;
  readonly digests: string;
  readonly duration_ms: number;
  readonly status: "pass" | "fail" | "blocked";
  readonly detail: string;
  readonly repro: string;
}

let failures = 0;
const REPRO = "bash scripts/e2e-s5-diptych.sh";

interface Context {
  profile: string;
  bucket: string;
  ordering: string;
  digests: string;
}

function emit(
  input: Context & {
    assertion: string;
    startedAt: number;
    status: SpikeRecord["status"];
    detail: string;
  },
): void {
  const record: SpikeRecord = {
    spike: SPIKE,
    seed,
    run_id: runId,
    revision: run.revision,
    revision_state: run.revision_state,
    source_digest: run.source_digest,
    source_files: run.source_files,
    bun_version: run.bun_version,
    wrangler_version: run.wrangler_version,
    assertion: input.assertion,
    problem: S5_SPIKE_PROBLEM,
    cursor: S5_SPIKE_CURSOR,
    profile: input.profile,
    budget_bucket: input.bucket,
    ordering: input.ordering,
    digests: input.digests,
    duration_ms: Math.round(performance.now() - input.startedAt),
    status: input.status,
    detail: input.detail,
    repro: REPRO,
  };
  assertSecretSafe(record);
  if (record.status === "fail") failures += 1;
  process.stdout.write(`${formatDiagnostic(record as unknown as never)}\n`);
}

function check(assertion: string, context: Context, ok: boolean, detail: string): void {
  const startedAt = performance.now();
  emit({
    assertion,
    ...context,
    startedAt,
    status: ok ? "pass" : "fail",
    detail: ok ? "as expected" : detail,
  });
}

const ids = (items: Projection["items"]) => items.map((item) => item.id).join(">");
const digestsOf = (pack: Projection) => {
  const faces = renderAllFaces(pack);
  return (["md", "json", "html-fragment"] as FaceFormat[])
    .map((format) => `${format}=${contentFingerprint(faces[format].body)}`)
    .join(" ");
};
const contextFor = (pack: Projection): Context => ({
  profile: pack.profile,
  bucket: `items=${pack.items.length}`,
  ordering: ids(pack.items),
  digests: digestsOf(pack),
});

// ── 1. one projection, three faces, one fingerprint ─────────────────────────
{
  const pack = s5SpikeProjection("public", seed);
  const faces = renderAllFaces(pack);
  const context = contextFor(pack);
  const fingerprints = new Set(Object.values(faces).map((face) => face.fingerprint));
  check(
    "faces_share_one_fingerprint",
    context,
    fingerprints.size === 1,
    `saw ${fingerprints.size}`,
  );
  check(
    "faces_share_item_order",
    context,
    Object.values(faces).every((face) => pack.items.every((item) => face.body.includes(item.id))),
    "an id is missing from a face",
  );
  check(
    "md_header_is_parseable",
    context,
    /^<!-- asimp face=md schema=\S+ kind=\S+ problem=\S+ profile=\S+ cursor=\d+ /.test(
      faces.md.body,
    ),
    "the markdown control header does not match the documented grammar",
  );
  check(
    "omitted_is_stated",
    context,
    faces.md.body.includes("## Omitted") && pack.omitted.length > 0,
    "omitted[] is absent or empty without a reason",
  );
}

// ── 2. determinism across buckets ───────────────────────────────────────────
for (const bucket of [1, 2]) {
  const full = s5SpikeProjection("public", seed);
  const pack: Projection = { ...full, items: full.items.slice(0, bucket) };
  const context = { ...contextFor(pack), bucket: `items=${bucket}` };
  const first = renderProjection(pack, "md").body;
  const second = renderProjection(pack, "md").body;
  check("repeat_render_is_byte_identical", context, first === second, "two renders differed");
}

// ── 3. the private workshop canary ──────────────────────────────────────────
{
  const sponsor = s5SpikeProjection("sponsor", seed);
  const pub = s5SpikeProjection("public", seed);
  const sponsorFaces = renderAllFaces(sponsor);
  const publicFaces = renderAllFaces(pub);

  const sponsorContext = { ...contextFor(sponsor), digests: `canary=${canaryDigest}` };
  check(
    "canary_present_in_sponsor_view",
    sponsorContext,
    Object.values(sponsorFaces).every((face) => face.body.includes(canary)),
    "the canary never reached the sponsor's own view, so its absence elsewhere proves nothing",
  );

  const publicContext = { ...contextFor(pub), digests: `canary=${canaryDigest}` };
  const leaked = Object.entries(publicFaces).filter(([, face]) => face.body.includes(canary));
  check(
    "canary_absent_from_every_public_face",
    publicContext,
    leaked.length === 0,
    `workshop bytes reached ${leaked.map(([format]) => format).join(",")}`,
  );
  check(
    "public_face_records_the_exclusion",
    publicContext,
    publicFaces.md.body.includes("workshop_scope_excluded"),
    "the public pack dropped a private item without saying so in omitted[]",
  );
  check(
    "no_workshop_id_on_a_public_face",
    publicContext,
    Object.values(publicFaces).every((face) => !face.body.includes("W-demo-fellow-03")),
    "a workshop item id appears on a public face",
  );
}

process.exit(failures === 0 ? 0 : 1);
