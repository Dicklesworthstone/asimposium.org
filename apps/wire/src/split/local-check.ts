#!/usr/bin/env bun
/**
 * Assertions for the real local S-3 workerd binding harness.
 *
 * This process never touches D1 or R2 directly: every observation crosses the
 * local Worker HTTP boundary. Its JSONL diagnostics name assertions and
 * statuses only; private bodies, private digests, and response bytes never
 * enter diagnostics.
 */

import { FACE_FORMATS, MEDIA_TYPES } from "@asimposium/render";

const rawOrigin = process.env.S3_LOCAL_ORIGIN;
const parsedOrigin = rawOrigin === undefined ? undefined : new URL(rawOrigin);
const localRunToken = (() => {
  const token = process.env.S3_LOCAL_RUN_TOKEN;
  if (token === undefined || !/^s3-[0-9]+-[0-9]+-[0-9]+$/u.test(token)) {
    throw new Error("S3_LOCAL_RUN_TOKEN_REQUIRED");
  }
  return token;
})();
if (
  parsedOrigin === undefined ||
  parsedOrigin.protocol !== "http:" ||
  parsedOrigin.hostname !== "127.0.0.1" ||
  parsedOrigin.port === "" ||
  parsedOrigin.username !== "" ||
  parsedOrigin.password !== "" ||
  parsedOrigin.pathname !== "/" ||
  parsedOrigin.search !== "" ||
  parsedOrigin.hash !== ""
) {
  throw new Error("S3_LOCAL_ORIGIN_MUST_BE_LOOPBACK");
}
const origin = parsedOrigin.origin;
const FETCH_TIMEOUT_MS = 5_000;
const REPRODUCE = "bash scripts/e2e-s3-split.sh";
const mainProblemId = "P-s3-local";
const privateCanary = `S3-R2-PRIVATE-CANARY-${"private-body".repeat(160)}`;
const publicStatement = "Every bounded local example has the recorded public property.";
const publicArtifact = "A deliberately public local artifact for the one promoted claim.";
const localSponsorId = `local-sponsor-${localRunToken}`;
const authoritativeFieldFixHint =
  "Remove author-writable disposition, proof, confidence, certification, or status-upgrade fields; the ledger computes disposition after independent review.";
const duplicateClaimFixHint =
  "Review the existing claim or refine the statement so its scope differs materially.";
let failures = 0;

interface JsonResult {
  readonly response: Response;
  readonly body: Record<string, unknown>;
}

interface Snapshot {
  readonly response: Response;
  readonly body: string;
  readonly headers: string;
}

interface FaceObservation {
  readonly format: (typeof FACE_FORMATS)[number];
  readonly etag: string;
  readonly body: string;
}

function emit(record: Record<string, unknown>): void {
  process.stdout.write(
    `${JSON.stringify({ suite: "e2e-s3-split-local", reproduce: REPRODUCE, ...record })}\n`,
  );
}

function check(assertion: string, ok: boolean, detail: string): void {
  if (!ok) failures += 1;
  emit({ assertion, status: ok ? "pass" : "fail", detail: ok ? "as expected" : detail });
}

function recordField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  return typeof value === "number" ? value : undefined;
}

function hasAuthoritativeFieldGuidance(result: JsonResult): boolean {
  return (
    result.response.status === 422 &&
    result.body.code === "SCHEMA_INVALID" &&
    result.body.rule === "P2/P4" &&
    result.body.fix_hint === authoritativeFieldFixHint &&
    result.body.next_action === "remove_authoritative_fields" &&
    !("fixHint" in result.body) &&
    !("nextAction" in result.body)
  );
}

function headersOf(response: Response): string {
  return Array.from(response.headers.entries())
    .map(([name, value]) => `${name}:${value}`)
    .join("\n");
}

async function snapshot(response: Response): Promise<Snapshot> {
  return { response, body: await response.text(), headers: headersOf(response) };
}

function localFetch(input: string, init: RequestInit = {}): Promise<Response> {
  return fetch(input, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

async function requestJson(path: string, init: RequestInit = {}): Promise<JsonResult> {
  const response = await localFetch(`${origin}${path}`, init);
  const body: unknown = await response.json().catch(() => undefined);
  return {
    response,
    body: body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {},
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function representationEtag(value: string): Promise<string> {
  return `"sha256:${await sha256Hex(value)}"`;
}

function hasNoPrivateMaterial(output: Snapshot, forbidden: readonly string[]): boolean {
  const combined = `${output.body}\n${output.headers}`;
  return forbidden.every((value) => !combined.includes(value));
}

function isExactLocalS3BindingFailure(output: Snapshot): boolean {
  const headers = Array.from(output.response.headers.entries());
  const combined = `${output.body}\n${output.headers}`;
  // workerd may inject transport-only compression/framing headers after the
  // Worker creates its Response. The application contract permits only the
  // content type; any cache, validator, or custom header is a failure.
  const applicationHeaders = headers.filter(
    ([name]) => !["content-encoding", "content-length", "transfer-encoding"].includes(name),
  );
  return (
    output.response.status === 500 &&
    output.body === '{"code":"LOCAL_S3_BINDING_FAILURE"}' &&
    applicationHeaders.length === 1 &&
    applicationHeaders[0]?.[0] === "content-type" &&
    applicationHeaders[0]?.[1] === "application/json; charset=utf-8" &&
    !combined.includes("/Users/") &&
    !combined.includes("file:///") &&
    !combined.includes("LocalS3PublicShapeError") &&
    !combined.includes("Error:") &&
    !combined.includes("local-worker.ts") &&
    !/\bat\s+.+:\d+:\d+/u.test(combined)
  );
}

async function pushWorkshop(
  problemId: string,
  bodyMd: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<JsonResult> {
  return requestJson("/__s3/workshops", {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify({ body_md: bodyMd, problem_id: problemId, title: "Private local spill" }),
  });
}

async function promote(
  workshopId: string,
  statement: string,
  publicArtifactMd: string,
  candidate: Record<string, unknown> = {},
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<JsonResult> {
  return requestJson("/__s3/promote", {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify({
      candidate,
      extract: "A public extract for the local binding proof.",
      public_artifact_md: publicArtifactMd,
      statement,
      title: "One public local promotion",
      workshop_id: workshopId,
    }),
  });
}

async function assertFaceSet(
  problemId: string,
  forbidden: readonly string[],
  phase: "post_promotion",
): Promise<FaceObservation[]> {
  const faces: FaceObservation[] = [];
  for (const format of FACE_FORMATS) {
    const served = await snapshot(
      await localFetch(`${origin}/__s3/public/${problemId}?format=${format}`),
    );
    const etag = served.response.headers.get("etag") ?? "";
    const expectedEtag = await representationEtag(served.body);
    const safe = hasNoPrivateMaterial(served, forbidden);
    check(
      `${phase}_${format}_is_a_private-free_rendered_face_with_a_representation_etag`,
      served.response.status === 200 &&
        served.response.headers.get("content-type") === MEDIA_TYPES[format] &&
        served.response.headers.get("cache-control") === "public, max-age=10, must-revalidate" &&
        etag === expectedEtag &&
        /^"sha256:[0-9a-f]{64}"$/u.test(etag) &&
        safe,
      `status ${served.response.status}`,
    );

    const conditional = await snapshot(
      await localFetch(`${origin}/__s3/public/${problemId}?format=${format}`, {
        headers: { "if-none-match": etag },
      }),
    );
    check(
      `${phase}_${format}_matching_validator_returns_a_private-free_304`,
      conditional.response.status === 304 &&
        conditional.body === "" &&
        conditional.response.headers.get("etag") === etag &&
        conditional.response.headers.get("cache-control") ===
          "public, max-age=10, must-revalidate" &&
        hasNoPrivateMaterial(conditional, forbidden),
      `status ${conditional.response.status}`,
    );
    faces.push({ format, etag, body: served.body });
  }
  check(
    `${phase}_face_validators_are_representation_specific`,
    new Set(faces.map((face) => face.etag)).size === FACE_FORMATS.length,
    "one or more rendered representations shared an ETag",
  );
  return faces;
}

async function main(): Promise<void> {
  if (origin === undefined) {
    emit({ assertion: "origin_supplied", status: "fail", detail: "S3_LOCAL_ORIGIN is not set" });
    process.exitCode = 1;
    return;
  }

  const health = await requestJson("/__s3/health");
  check(
    "local_workerd_reports_D1_and_R2_bindings",
    health.response.status === 200 && Array.isArray(health.body.bindings),
    `status ${health.response.status}`,
  );

  const forgedWorkshop = await requestJson("/__s3/workshops", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      body_md: privateCanary,
      problem_id: mainProblemId,
      title: "Forged workshop identifier",
      workshop_id: "W-forged-999",
    }),
  });
  check(
    "caller_cannot_choose_a_workshop_identifier",
    forgedWorkshop.response.status === 400 &&
      forgedWorkshop.body.code === "CALLER_OWNED_ID_FORBIDDEN",
    `status ${forgedWorkshop.response.status}`,
  );

  const pushed = await pushWorkshop(mainProblemId, privateCanary);
  const workshopId = recordField(pushed.body, "workshop_id") ?? "";
  const privateDigest = await sha256Hex(privateCanary);
  const privateBodyKey = `s3-local/private/staged/sha256/${privateDigest}`;
  check(
    "large_workshop_body_spills_to_R2_and_gets_a_server_owned_workshop_id",
    pushed.response.status === 201 &&
      pushed.body.spilled_to_private_r2 === true &&
      workshopId === "W-local-fellow-1" &&
      numberField(pushed.body, "workshop_seq") === 1,
    `status ${pushed.response.status}`,
  );

  const privateByDigestBeforePromotion = await snapshot(
    await localFetch(`${origin}/sha256/${privateDigest}`),
  );
  check(
    "staged_private_digest_is_not_publicly_readable_before_promotion",
    privateByDigestBeforePromotion.response.status === 404 &&
      hasNoPrivateMaterial(privateByDigestBeforePromotion, [
        privateCanary,
        workshopId,
        privateDigest,
        privateBodyKey,
        localSponsorId,
      ]),
    `status ${privateByDigestBeforePromotion.response.status}`,
  );

  const anonymousPrivate = await snapshot(await localFetch(`${origin}/__s3/private/${workshopId}`));
  const staleAuthorityPrivate = await snapshot(
    await localFetch(`${origin}/__s3/private/${workshopId}`, {
      headers: { "x-asimp-local-sponsor": "local-sponsor" },
    }),
  );
  check(
    "anonymous_or_stale_private_authority_is_not_found_without_a_private_cache_entry",
    anonymousPrivate.response.status === 404 &&
      anonymousPrivate.response.headers.get("cache-control") === "no-store" &&
      staleAuthorityPrivate.response.status === 404 &&
      staleAuthorityPrivate.response.headers.get("cache-control") === "no-store" &&
      hasNoPrivateMaterial(anonymousPrivate, [
        privateCanary,
        workshopId,
        privateDigest,
        privateBodyKey,
        localSponsorId,
      ]) &&
      hasNoPrivateMaterial(staleAuthorityPrivate, [
        privateCanary,
        workshopId,
        privateDigest,
        privateBodyKey,
        localSponsorId,
      ]),
    `status ${anonymousPrivate.response.status}`,
  );
  const ownerPrivate = await snapshot(
    await localFetch(`${origin}/__s3/private/${workshopId}`, {
      headers: { "x-asimp-local-sponsor": localRunToken },
    }),
  );
  check(
    "owner_private_read_crosses_R2_and_revalidates_the_D1_binding",
    ownerPrivate.response.status === 200 &&
      ownerPrivate.response.headers.get("cache-control") === "private, no-store" &&
      ownerPrivate.body === privateCanary,
    `status ${ownerPrivate.response.status}`,
  );

  const forbiddenMain = [privateCanary, workshopId, privateDigest, privateBodyKey, localSponsorId];
  const missingProblemId = "P-s3-does-not-exist";
  const privateOnlyPublic = await Promise.all([
    ...FACE_FORMATS.map(async (format) =>
      snapshot(await localFetch(`${origin}/__s3/public/${mainProblemId}?format=${format}`)),
    ),
    snapshot(await localFetch(`${origin}/__s3/public/${mainProblemId}/search?q=neutral`)),
    snapshot(await localFetch(`${origin}/__s3/public/${mainProblemId}/export.jsonl`)),
  ]);
  const unknownPublic = await Promise.all([
    ...FACE_FORMATS.map(async (format) =>
      snapshot(await localFetch(`${origin}/__s3/public/${missingProblemId}?format=${format}`)),
    ),
    snapshot(await localFetch(`${origin}/__s3/public/${missingProblemId}/search?q=neutral`)),
    snapshot(await localFetch(`${origin}/__s3/public/${missingProblemId}/export.jsonl`)),
  ]);
  check(
    "private_only_problem_is_byte_indistinguishable_from_unknown_on_every_public_route",
    privateOnlyPublic.length === unknownPublic.length &&
      privateOnlyPublic.every(
        (observed, index) =>
          observed.response.status === 404 &&
          observed.response.status === unknownPublic[index]?.response.status &&
          observed.body === unknownPublic[index]?.body &&
          observed.headers === unknownPublic[index]?.headers &&
          hasNoPrivateMaterial(observed, forbiddenMain),
      ),
    "a private-only problem differed from an unknown problem on a public route",
  );

  const publicError = await snapshot(
    await localFetch(
      `${origin}/__s3/public/${mainProblemId}?format=${encodeURIComponent(privateCanary)}`,
    ),
  );
  const privateOnlySearch = await snapshot(
    await localFetch(
      `${origin}/__s3/public/${mainProblemId}/search?q=${encodeURIComponent(privateCanary)}`,
    ),
  );
  const privateOnlyExport = await snapshot(
    await localFetch(`${origin}/__s3/public/${mainProblemId}/export.jsonl`),
  );
  check(
    "public_errors_search_and_export_never_reflect_private_probe_material",
    publicError.response.status === 400 &&
      privateOnlySearch.response.status === 404 &&
      privateOnlyExport.response.status === 404 &&
      hasNoPrivateMaterial(publicError, forbiddenMain) &&
      hasNoPrivateMaterial(privateOnlySearch, forbiddenMain) &&
      hasNoPrivateMaterial(privateOnlyExport, forbiddenMain),
    "a public error, search, or export reflected private material",
  );

  const [missingFace, missingSearch, missingExport] = await Promise.all([
    snapshot(await localFetch(`${origin}/__s3/public/${missingProblemId}?format=json`)),
    snapshot(await localFetch(`${origin}/__s3/public/${missingProblemId}/search?q=anything`)),
    snapshot(await localFetch(`${origin}/__s3/public/${missingProblemId}/export.jsonl`)),
  ]);
  check(
    "missing_problem_never_fabricates_an_empty_public_projection",
    missingFace.response.status === 404 &&
      missingSearch.response.status === 404 &&
      missingExport.response.status === 404 &&
      hasNoPrivateMaterial(missingFace, forbiddenMain) &&
      hasNoPrivateMaterial(missingSearch, forbiddenMain) &&
      hasNoPrivateMaterial(missingExport, forbiddenMain),
    "a missing problem returned a public projection or reflected private material",
  );

  const forgedClaim = await requestJson("/__s3/promote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      candidate: {},
      claim_id: "C-forged-99",
      extract: "A public extract.",
      public_artifact_md: publicArtifact,
      statement: publicStatement,
      title: "Forged claim identifier",
      workshop_id: workshopId,
    }),
  });
  check(
    "caller_cannot_choose_a_claim_identifier",
    forgedClaim.response.status === 400 && forgedClaim.body.code === "CALLER_OWNED_ID_FORBIDDEN",
    `status ${forgedClaim.response.status}`,
  );

  const promoted = await promote(workshopId, publicStatement, publicArtifact);
  const publicDigest = recordField(promoted.body, "public_artifact_digest") ?? "";
  check(
    "one_promotion_atomically_allocates_the_first_public_claim_and_binds_its_public_artifact",
    promoted.response.status === 201 &&
      promoted.body.claim_id === "C-1" &&
      promoted.body.public_seq === 1 &&
      publicDigest === (await sha256Hex(publicArtifact)),
    `status ${promoted.response.status}`,
  );

  const repeatedPromotion = await promote(
    workshopId,
    "A different statement that must not be promoted twice from one workshop.",
    "A different public artifact that must stay unpublished.",
  );
  check(
    "repeat_promotion_preserves_the_one_promotion_invariant_without_advancing_public_cursor",
    repeatedPromotion.response.status === 409 &&
      repeatedPromotion.body.code === "PROMOTION_ALREADY_EXISTS",
    `status ${repeatedPromotion.response.status}`,
  );

  const privateByDigestAfterPromotion = await snapshot(
    await localFetch(`${origin}/sha256/${privateDigest}`),
  );
  const publishedArtifact = await snapshot(await localFetch(`${origin}/sha256/${publicDigest}`));
  check(
    "only_the_explicitly_published_public_artifact_is_readable_after_complete_D1_binding",
    privateByDigestAfterPromotion.response.status === 404 &&
      publishedArtifact.response.status === 200 &&
      publishedArtifact.body === publicArtifact &&
      publishedArtifact.response.headers.get("cache-control") ===
        "public, max-age=31536000, immutable" &&
      hasNoPrivateMaterial(privateByDigestAfterPromotion, forbiddenMain) &&
      hasNoPrivateMaterial(publishedArtifact, forbiddenMain),
    "private or incompletely bound artifact was publicly readable",
  );

  const postSearch = await snapshot(
    await localFetch(
      `${origin}/__s3/public/${mainProblemId}/search?q=${encodeURIComponent(publicStatement)}`,
    ),
  );
  const postExport = await snapshot(
    await localFetch(`${origin}/__s3/public/${mainProblemId}/export.jsonl`),
  );
  const poisonedPublicHeaders = { "x-asimp-local-shape-poison": localRunToken };
  const wrongTokenPoisonedPublicHeaders = {
    "x-asimp-local-shape-poison": `${localRunToken}-wrong`,
  };
  const nonemptyPoisonedPublicHeaders = { "x-asimp-local-shape-poison": "nonempty" };
  const poisonedPrivateLocator = `s3-local-shape-poison-${localRunToken}`;
  const poisonedProbeForbidden = [...forbiddenMain, poisonedPrivateLocator, localRunToken];
  const poisonProbePaths = [
    ...FACE_FORMATS.map((format) => `${origin}/__s3/public/${mainProblemId}?format=${format}`),
    `${origin}/__s3/public/${mainProblemId}/search?q=${encodeURIComponent(publicStatement)}`,
    `${origin}/__s3/public/${mainProblemId}/export.jsonl`,
  ];
  const poisonProbeSnapshots = (headers: Readonly<Record<string, string>>) =>
    Promise.all(
      poisonProbePaths.map(async (path) => snapshot(await localFetch(path, { headers }))),
    );
  const routeBindingPoisonHeaders = { "x-asimp-local-route-binding-poison": localRunToken };
  const wrongTokenRouteBindingPoisonHeaders = {
    "x-asimp-local-route-binding-poison": `${localRunToken}-wrong`,
  };
  const nonemptyRouteBindingPoisonHeaders = {
    "x-asimp-local-route-binding-poison": "nonempty",
  };
  const routeBindingPoisonSnapshots = async (headers: Readonly<Record<string, string>>) =>
    Promise.all([
      snapshot(
        await localFetch(`${origin}/__s3/workshops`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: "{}",
        }),
      ),
      snapshot(
        await localFetch(`${origin}/__s3/promote`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: "{}",
        }),
      ),
      snapshot(
        await localFetch(`${origin}/__s3/private/${workshopId}`, {
          headers,
        }),
      ),
      snapshot(
        await localFetch(`${origin}/__s3/recovery/sha256/${privateDigest}`, {
          headers,
        }),
      ),
      snapshot(
        await localFetch(`${origin}/sha256/${publicDigest}`, {
          headers,
        }),
      ),
      snapshot(
        await localFetch(`${origin}/__s3/public/${mainProblemId}/search`, {
          headers,
        }),
      ),
      snapshot(
        await localFetch(`${origin}/__s3/public/${mainProblemId}/export.jsonl`, {
          headers,
        }),
      ),
      snapshot(
        await localFetch(`${origin}/__s3/public/${mainProblemId}`, {
          headers,
        }),
      ),
    ]);
  const [unpoisonedPublic, poisonedPublic, wrongTokenPoisonedPublic, nonemptyPoisonedPublic] =
    await Promise.all([
      poisonProbeSnapshots({}),
      poisonProbeSnapshots(poisonedPublicHeaders),
      poisonProbeSnapshots(wrongTokenPoisonedPublicHeaders),
      poisonProbeSnapshots(nonemptyPoisonedPublicHeaders),
    ]);
  check(
    "post_promotion_public_projection_search_and_export_apply_shape_guards",
    postSearch.response.status === 200 &&
      postExport.response.status === 200 &&
      postSearch.body.includes(publicStatement) &&
      postExport.body.includes(publicStatement) &&
      hasNoPrivateMaterial(postSearch, forbiddenMain) &&
      hasNoPrivateMaterial(postExport, forbiddenMain) &&
      poisonedPublic.length === FACE_FORMATS.length + 2 &&
      poisonedPublic.every(
        (response) =>
          isExactLocalS3BindingFailure(response) &&
          hasNoPrivateMaterial(response, poisonedProbeForbidden),
      ) &&
      [wrongTokenPoisonedPublic, nonemptyPoisonedPublic].every(
        (responses) =>
          unpoisonedPublic.length === FACE_FORMATS.length + 2 &&
          responses.length === unpoisonedPublic.length &&
          responses.every(
            (response, index) =>
              response.response.status === unpoisonedPublic[index]?.response.status &&
              response.body === unpoisonedPublic[index]?.body &&
              response.headers === unpoisonedPublic[index]?.headers &&
              hasNoPrivateMaterial(response, poisonedProbeForbidden),
          ),
      ),
    "a public route serialized a poisoned D1 row or honored a non-authoritative poison header",
  );
  const [
    routeBindingBaseline,
    routeBindingPoisoned,
    wrongTokenRouteBindingPoisoned,
    nonemptyRouteBindingPoisoned,
  ] = await Promise.all([
    routeBindingPoisonSnapshots({}),
    routeBindingPoisonSnapshots(routeBindingPoisonHeaders),
    routeBindingPoisonSnapshots(wrongTokenRouteBindingPoisonHeaders),
    routeBindingPoisonSnapshots(nonemptyRouteBindingPoisonHeaders),
  ]);
  check(
    "all_eight_async_route_handlers_return_one_exact_nonreflective_binding_failure",
    routeBindingPoisoned.length === 8 &&
      routeBindingPoisoned.every(isExactLocalS3BindingFailure) &&
      routeBindingPoisoned.every((response) =>
        hasNoPrivateMaterial(response, [...forbiddenMain, poisonedPrivateLocator]),
      ),
    "an async route bypassed the binding failure boundary or disclosed poisoned internals",
  );
  check(
    "wrong_or_nonempty_route_binding_poison_headers_are_byte_for_byte_inert_on_every_async_route",
    [wrongTokenRouteBindingPoisoned, nonemptyRouteBindingPoisoned].every(
      (responses) =>
        responses.length === 8 &&
        responses.every(
          (response, index) =>
            response.response.status === routeBindingBaseline[index]?.response.status &&
            response.body === routeBindingBaseline[index]?.body &&
            response.headers === routeBindingBaseline[index]?.headers &&
            hasNoPrivateMaterial(response, [...forbiddenMain, poisonedPrivateLocator]),
        ),
    ),
    "a non-authoritative route-binding poison header changed an async route response",
  );

  const postFaces = await assertFaceSet(mainProblemId, forbiddenMain, "post_promotion");
  check(
    "public_faces_begin_only_after_a_committed_ledger_event",
    postFaces.every(
      (face) =>
        face.body.includes(publicStatement) &&
        privateOnlyPublic.every(
          (before) => before.response.status === 404 && before.body !== face.body,
        ),
    ),
    "a public face existed before the ledger event or failed to appear after it",
  );

  const jsonFace = await localFetch(`${origin}/__s3/public/${mainProblemId}?format=json`);
  const projection = (await jsonFace.json()) as {
    readonly cursor?: unknown;
    readonly items?: unknown;
  };
  check(
    "rendered_json_contains_only_one_public_ledger_item",
    projection.cursor === 1 &&
      Array.isArray(projection.items) &&
      projection.items.length === 1 &&
      isLedgerItem(projection.items[0]),
    "the JSON face did not contain exactly one ledger item",
  );

  const duplicateWorkshop = await pushWorkshop(
    mainProblemId,
    `${privateCanary}-duplicate-statement-workshop`,
  );
  const duplicateClaim = await promote(
    recordField(duplicateWorkshop.body, "workshop_id") ?? "",
    "  EVERY bounded\u00a0local example  has the recorded public property.  ",
    "An unpublished artifact accompanying a duplicate claim.",
  );
  check(
    "near_duplicate_promotion_is_refused_citing_P11_without_a_cursor_burn",
    duplicateWorkshop.response.status === 201 &&
      duplicateClaim.response.status === 409 &&
      duplicateClaim.body.code === "DUPLICATE_CLAIM" &&
      duplicateClaim.body.rule === "P11" &&
      duplicateClaim.body.existing_id === "C-1" &&
      duplicateClaim.body.next_action === "review_or_refine" &&
      duplicateClaim.body.fix_hint === duplicateClaimFixHint &&
      !("existingId" in duplicateClaim.body) &&
      !("fixHint" in duplicateClaim.body) &&
      !("nextAction" in duplicateClaim.body),
    `status ${duplicateClaim.response.status}`,
  );

  const c0Problem = "P-s3-c0-normalization";
  const c0FirstWorkshop = await pushWorkshop(c0Problem, `${privateCanary}-c0-first`);
  const c0FirstPromotion = await promote(
    recordField(c0FirstWorkshop.body, "workshop_id") ?? "",
    "The relation \u0002x + y\u0003 is recorded.",
    "A public artifact for the raw C0 control statement.",
  );
  const c0SecondWorkshop = await pushWorkshop(c0Problem, `${privateCanary}-c0-second`);
  const c0SecondPromotion = await promote(
    recordField(c0SecondWorkshop.body, "workshop_id") ?? "",
    "The relation \\(x + y\\) is recorded.",
    "A public artifact for the explicit TeX statement.",
  );
  check(
    "raw_C0_controls_cannot_collide_with_protected_math_tokens",
    c0FirstWorkshop.response.status === 201 &&
      c0FirstPromotion.response.status === 201 &&
      c0FirstPromotion.body.claim_id === "C-1" &&
      c0SecondWorkshop.response.status === 201 &&
      c0SecondPromotion.response.status === 201 &&
      c0SecondPromotion.body.claim_id === "C-2" &&
      c0SecondPromotion.body.public_seq === 2,
    `raw ${c0FirstPromotion.response.status}/${String(c0FirstPromotion.body.code)} explicit ${c0SecondPromotion.response.status}/${String(c0SecondPromotion.body.code)}`,
  );

  const p2Workshop = await pushWorkshop("P-s3-p2", `${privateCanary}-p2`);
  const p2Refusal = await promote(
    recordField(p2Workshop.body, "workshop_id") ?? "",
    "A statement whose author must not set its disposition.",
    "A public artifact which cannot compensate for author-set status.",
    { nested: { PROVED: true } },
  );
  check(
    "self_certified_status_is_refused_citing_P2_P4",
    p2Workshop.response.status === 201 && hasAuthoritativeFieldGuidance(p2Refusal),
    `status ${p2Refusal.response.status} code ${String(p2Refusal.body.code)} rule ${String(p2Refusal.body.rule)}`,
  );

  const topLevelP2Workshop = await pushWorkshop("P-s3-p2-top-level", `${privateCanary}-p2-top`);
  const topLevelP2Refusal = await requestJson("/__s3/promote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      candidate: {},
      extract: "A public extract for the top-level P2 refusal.",
      public_artifact_md: "This artifact must not be published.",
      proved: true,
      statement: "A top-level author-set status must be rejected before promotion.",
      title: "Top-level self-certification",
      workshop_id: recordField(topLevelP2Workshop.body, "workshop_id") ?? "",
    }),
  });
  const topLevelP4Workshop = await pushWorkshop("P-s3-p4-top-level", `${privateCanary}-p4-top`);
  const topLevelP4Refusal = await requestJson("/__s3/promote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      candidate: {},
      disposition: "proved",
      extract: "A public extract for the top-level P4 refusal.",
      public_artifact_md: "This artifact must not be published.",
      statement: "A top-level author-set disposition must be rejected before promotion.",
      title: "Top-level disposition",
      workshop_id: recordField(topLevelP4Workshop.body, "workshop_id") ?? "",
    }),
  });
  const statusP2P4Workshop = await pushWorkshop("P-s3-status-top-level", `${privateCanary}-status`);
  const statusP2P4Refusal = await requestJson("/__s3/promote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      candidate: {},
      extract: "A public extract for the top-level status refusal.",
      public_artifact_md: "This artifact must not be published.",
      statement: "A top-level author-set status upgrade must be rejected before promotion.",
      status: "strongly-supported",
      title: "Top-level status upgrade",
      workshop_id: recordField(statusP2P4Workshop.body, "workshop_id") ?? "",
    }),
  });
  check(
    "top_level_authoritative_fields_and_status_upgrades_are_refused_citing_P2_P4",
    topLevelP2Workshop.response.status === 201 &&
      hasAuthoritativeFieldGuidance(topLevelP2Refusal) &&
      topLevelP4Workshop.response.status === 201 &&
      hasAuthoritativeFieldGuidance(topLevelP4Refusal) &&
      statusP2P4Workshop.response.status === 201 &&
      hasAuthoritativeFieldGuidance(statusP2P4Refusal),
    `proved ${topLevelP2Refusal.response.status}/${String(topLevelP2Refusal.body.code)}/${String(topLevelP2Refusal.body.rule)} disposition ${topLevelP4Refusal.response.status}/${String(topLevelP4Refusal.body.code)}/${String(topLevelP4Refusal.body.rule)} status ${statusP2P4Refusal.response.status}/${String(statusP2P4Refusal.body.code)}/${String(statusP2P4Refusal.body.rule)}`,
  );

  const publicAfterRefusals = await snapshot(
    await localFetch(`${origin}/__s3/public/${mainProblemId}?format=json`),
  );
  const publicAfterRefusalProjection = (await new Response(publicAfterRefusals.body).json()) as {
    readonly cursor?: unknown;
    readonly items?: unknown;
  };
  check(
    "duplicate_and_P2_P4_refusals_leave_the_public_projection_at_its_original_cursor",
    publicAfterRefusals.response.status === 200 &&
      publicAfterRefusalProjection.cursor === 1 &&
      Array.isArray(publicAfterRefusalProjection.items) &&
      publicAfterRefusalProjection.items.length === 1 &&
      hasNoPrivateMaterial(publicAfterRefusals, forbiddenMain),
    "a refused promotion advanced or contaminated the public projection",
  );

  const recoveryProblem = "P-s3-recovery";
  const recoveryBody = `${privateCanary}-r2-before-d1-failure`;
  const recoveryDigest = await sha256Hex(recoveryBody);
  const recoveryPrivateBodyKey = `s3-local/private/staged/sha256/${recoveryDigest}`;
  const failedBind = await pushWorkshop(recoveryProblem, recoveryBody, {
    "x-asimp-local-test-fault": "d1-bind-reject",
    "x-asimp-local-test-fault-authority": localRunToken,
  });
  const staleAuthorityAudit = await snapshot(
    await localFetch(`${origin}/__s3/recovery/sha256/${recoveryDigest}`, {
      headers: { "x-asimp-local-recovery-audit": "local-recovery-audit" },
    }),
  );
  const orphanAudit = await requestJson(`/__s3/recovery/sha256/${recoveryDigest}`, {
    headers: { "x-asimp-local-recovery-audit": localRunToken },
  });
  const failedArtifactProbe = await snapshot(
    await localFetch(`${origin}/sha256/${recoveryDigest}`),
  );
  const recoveredBind = await pushWorkshop(recoveryProblem, recoveryBody);
  const recoveredAudit = await requestJson(`/__s3/recovery/sha256/${recoveryDigest}`, {
    headers: { "x-asimp-local-recovery-audit": localRunToken },
  });
  const missingFaultAuthority = await pushWorkshop(
    "P-s3-recovery-fault-no-authority",
    `${privateCanary}-fault-request-without-authority`,
    { "x-asimp-local-test-fault": "d1-bind-reject" },
  );
  const wrongFaultAuthority = await pushWorkshop(
    "P-s3-recovery-fault-wrong-authority",
    `${privateCanary}-fault-request-with-wrong-authority`,
    {
      "x-asimp-local-test-fault": "d1-bind-reject",
      "x-asimp-local-test-fault-authority": `${localRunToken}-wrong`,
    },
  );
  check(
    "R2_put_then_D1_failure_leaves_an_unreachable_orphan_and_retry_binds_without_a_cursor_burn",
    failedBind.response.status === 503 &&
      failedBind.body.code === "PRIVATE_CAS_RECOVERY_REQUIRED" &&
      staleAuthorityAudit.response.status === 404 &&
      hasNoPrivateMaterial(staleAuthorityAudit, [
        recoveryBody,
        recoveryDigest,
        recoveryPrivateBodyKey,
        localSponsorId,
      ]) &&
      orphanAudit.body.state === "unbound_private_r2_object" &&
      failedArtifactProbe.response.status === 404 &&
      hasNoPrivateMaterial(failedArtifactProbe, [
        recoveryBody,
        recoveryDigest,
        recoveryPrivateBodyKey,
        localSponsorId,
      ]) &&
      recoveredBind.response.status === 201 &&
      recoveredBind.body.workshop_id === "W-local-fellow-9" &&
      recoveredBind.body.workshop_seq === 1 &&
      recoveredAudit.body.state === "d1_bound" &&
      missingFaultAuthority.response.status === 201 &&
      missingFaultAuthority.body.spilled_to_private_r2 === true &&
      wrongFaultAuthority.response.status === 201 &&
      wrongFaultAuthority.body.spilled_to_private_r2 === true,
    `failure ${failedBind.response.status}/${String(failedBind.body.code)} orphan ${String(orphanAudit.body.state)} retry ${recoveredBind.response.status}/${String(recoveredBind.body.workshop_seq)} recovery ${String(recoveredAudit.body.state)} unauthorized ${missingFaultAuthority.response.status}/${wrongFaultAuthority.response.status}`,
  );

  const workshopRaceProblem = "P-s3-workshop-race";
  const racedWorkshops = await Promise.all(
    ["alpha", "beta"].map((suffix) =>
      pushWorkshop(workshopRaceProblem, `${privateCanary}-workshop-race-${suffix}`),
    ),
  );
  const raceSequences = racedWorkshops
    .map((result) => numberField(result.body, "workshop_seq"))
    .sort((left, right) => (left ?? 0) - (right ?? 0));
  const afterWorkshopRace = await pushWorkshop(
    workshopRaceProblem,
    `${privateCanary}-workshop-race-gamma`,
  );
  check(
    "concurrent_workshop_pushes_use_D1_RETURNING_sequences_without_duplicates_or_burns",
    racedWorkshops.every((result) => result.response.status === 201) &&
      raceSequences[0] === 1 &&
      raceSequences[1] === 2 &&
      afterWorkshopRace.body.workshop_seq === 3,
    `sequences ${raceSequences.join(",")} then ${String(afterWorkshopRace.body.workshop_seq)}`,
  );

  const publicRaceProblem = "P-s3-public-race";
  const raceWorkshopResults = await Promise.all(
    ["one", "two"].map((suffix) =>
      pushWorkshop(publicRaceProblem, `${privateCanary}-public-${suffix}`),
    ),
  );
  const raceWorkshopIds = raceWorkshopResults.map(
    (result) => recordField(result.body, "workshop_id") ?? "",
  );
  const racedPromotions = await Promise.all(
    raceWorkshopIds.map((id, index) =>
      promote(
        id,
        `Concurrent public statement ${index + 1} has a distinct normalized form.`,
        `Concurrent public artifact ${index + 1}.`,
      ),
    ),
  );
  const publicSequences = racedPromotions
    .map((result) => numberField(result.body, "public_seq"))
    .sort((left, right) => (left ?? 0) - (right ?? 0));
  const thirdWorkshop = await pushWorkshop(publicRaceProblem, `${privateCanary}-public-three`);
  const thirdPromotion = await promote(
    recordField(thirdWorkshop.body, "workshop_id") ?? "",
    "Concurrent public statement three has a distinct normalized form.",
    "Concurrent public artifact three.",
  );
  check(
    "concurrent_promotions_allocate_server_claim_ids_and_D1_RETURNING_public_sequences_without_burns",
    racedPromotions.every((result) => result.response.status === 201) &&
      publicSequences[0] === 1 &&
      publicSequences[1] === 2 &&
      new Set(racedPromotions.map((result) => result.body.claim_id)).size === 2 &&
      thirdPromotion.response.status === 201 &&
      thirdPromotion.body.claim_id === "C-3" &&
      thirdPromotion.body.public_seq === 3,
    `statuses ${racedPromotions.map((result) => result.response.status).join(",")} sequences ${publicSequences.join(",")} third ${thirdPromotion.response.status}/${String(thirdPromotion.body.claim_id)}/${String(thirdPromotion.body.public_seq)}`,
  );

  emit({
    assertion: "local_binding_summary",
    status: failures === 0 ? "pass" : "fail",
    detail:
      failures === 0
        ? "real local workerd D1/R2, recovery, artifact-gating, cursor, cache, and renderer checks passed"
        : `${failures} assertion(s) failed`,
    scope: "local-workerd only; no production route, OAuth, browser, or staging claim",
  });
  if (failures > 0) process.exitCode = 1;
}

function isLedgerItem(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.scope === "ledger" && typeof item.id === "string";
}

await main();
