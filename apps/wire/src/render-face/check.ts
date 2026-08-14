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
 * Usage: S5_ORIGIN=http://127.0.0.1:8793 bun apps/wire/src/render-face/check.ts
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

const origin = process.env.S5_ORIGIN;
const REPRO = "bash scripts/e2e-s5-diptych.sh";
const canary = s5Canary();

let failures = 0;

function emit(record: Record<string, unknown>): void {
  process.stdout.write(
    `${JSON.stringify({ spike: "s5-diptych", phase: "worker-served", repro: REPRO, ...record })}\n`,
  );
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
  if (origin === undefined) {
    emit({ assertion: "origin_supplied", status: "fail", detail: "S5_ORIGIN is not set" });
    process.exitCode = 1;
    return;
  }

  const formats: FaceFormat[] = ["md", "json", "html-fragment"];
  const variants: SpikeVariant[] = ["public", "sponsor"];

  for (const variant of variants) {
    for (const format of formats) {
      const local = renderProjection(s5SpikeProjection(variant), format);
      const started = performance.now();
      const response = await fetch(`${origin}/__s5/face?variant=${variant}&format=${format}`);
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
      check(
        `served_${format}_etag_is_the_fingerprint`,
        response.headers.get("etag") === `"${local.fingerprint}"`,
        `etag ${String(response.headers.get("etag"))} for fingerprint ${local.fingerprint}`,
        context,
      );

      // Conditional replay: same validator, no body, same headers.
      const conditional = await fetch(`${origin}/__s5/face?variant=${variant}&format=${format}`, {
        headers: { "if-none-match": `"${local.fingerprint}"` },
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
        conditional.headers.get("etag") === `"${local.fingerprint}"`,
        `etag ${String(conditional.headers.get("etag"))}`,
        context,
      );

      // A stale validator must still get the full body.
      const stale = await fetch(`${origin}/__s5/face?variant=${variant}&format=${format}`, {
        headers: { "if-none-match": '"fnv1a64:0000000000000000"' },
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

  // Teaching refusals.
  const unknownFormat = await fetch(`${origin}/__s5/face?format=toon`);
  const unknownBody = (await unknownFormat.json()) as Record<string, unknown>;
  check("unknown_format_is_400", unknownFormat.status === 400, `status ${unknownFormat.status}`);
  check("unknown_format_code", unknownBody.code === "UNKNOWN_FORMAT", String(unknownBody.code));
  check(
    "unknown_format_teaches_the_allowed_set",
    Array.isArray(unknownBody.allowed) &&
      unknownBody.allowed.length === 3 &&
      typeof unknownBody.fix_hint === "string",
    JSON.stringify(unknownBody.allowed),
  );

  const unknownVariant = await fetch(`${origin}/__s5/face?variant=everything`);
  check("unknown_variant_is_400", unknownVariant.status === 400, `status ${unknownVariant.status}`);

  const unknownRoute = await fetch(`${origin}/p/demo-bounded-sums.md`);
  check(
    "the harness serves no product route",
    unknownRoute.status === 404,
    `status ${unknownRoute.status} — a spike must not pre-empt the W4-W6 face surface`,
  );

  const write = await fetch(`${origin}/__s5/face`, { method: "POST" });
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
  if (failures > 0) process.exitCode = 1;
}

await main();
