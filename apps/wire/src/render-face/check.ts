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
      const servedEtag = response.headers.get("etag") ?? "";
      check(
        `served_${format}_etag_is_a_sha256_of_the_representation`,
        servedEtag === (await representationEtag(served)),
        `etag ${servedEtag}`,
        context,
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
      const head = await fetch(`${origin}/__s5/face?variant=${variant}&format=${format}`, {
        method: "HEAD",
      });
      check(
        `served_${format}_head_parity`,
        head.status === 200 &&
          head.headers.get("etag") === servedEtag &&
          head.headers.get("content-type") === MEDIA_TYPES[format] &&
          (await head.text()).length === 0,
        `HEAD status ${head.status} etag ${String(head.headers.get("etag"))}`,
        context,
      );

      // Conditional replay: same validator, no body, same headers.
      const conditional = await fetch(`${origin}/__s5/face?variant=${variant}&format=${format}`, {
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
        `etag ${String(conditional.headers.get("etag"))}`,
        context,
      );

      // `*` matches whenever a representation exists (RFC 9110 §13.1.2), and a weak
      // validator for the same representation matches under weak comparison.
      const wildcard = await fetch(`${origin}/__s5/face?variant=${variant}&format=${format}`, {
        headers: { "if-none-match": "*" },
      });
      check(
        `served_${format}_wildcard_validator_is_304`,
        wildcard.status === 304 && (await wildcard.text()).length === 0,
        `status ${wildcard.status}`,
        context,
      );
      const weak = await fetch(`${origin}/__s5/face?variant=${variant}&format=${format}`, {
        headers: { "if-none-match": `W/${servedEtag}` },
      });
      check(
        `served_${format}_weak_validator_matches`,
        weak.status === 304,
        `status ${weak.status}`,
        context,
      );

      // A stale validator must still get the full body.
      const stale = await fetch(`${origin}/__s5/face?variant=${variant}&format=${format}`, {
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
    const mdResponse = await fetch(`${origin}/__s5/face?variant=public&format=md`);
    const mdEtag = mdResponse.headers.get("etag") ?? "";
    for (const other of ["json", "html-fragment"] as const) {
      const crossed = await fetch(`${origin}/__s5/face?variant=public&format=${other}`, {
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
    const crossedVariant = await fetch(`${origin}/__s5/face?variant=sponsor&format=md`, {
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
  const unknownFormat = await fetch(`${origin}/__s5/face?format=toon`);
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
