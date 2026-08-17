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
const localAuthorityToken = (() => {
  const token = process.env.S3_LOCAL_RUN_TOKEN;
  if (token === undefined || !/^[a-f0-9]{64}$/u.test(token)) {
    throw new Error("S3_LOCAL_RUN_TOKEN_REQUIRED");
  }
  return token;
})();
const localReadinessNonce = (() => {
  const nonce = process.env.S3_LOCAL_READINESS_NONCE;
  if (nonce === undefined || !/^s3-ready-[a-f0-9]{32}$/u.test(nonce)) {
    throw new Error("S3_LOCAL_READINESS_NONCE_REQUIRED");
  }
  return nonce;
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
const sponsorVisiblePrivateProblemId = "P-s3-sponsor-private";
const sponsorVisiblePrivateFellowId = "s3-sponsor-visible-fellow";
const sponsorVisiblePrivateCanary = `S3-SPONSOR-PRIVATE-CANARY-${"sponsor-private-body".repeat(128)}`;
const publicStatement = "Every bounded local example has the recorded public property.";
const publicArtifact = "A deliberately public local artifact for the one promoted claim.";
const LOCAL_S4_TIMEOUT_MARKER = "S4-TIMEOUT-FIXTURE";
const LOCAL_S4_DIRECT_REJECT_MARKER = "S4-DIRECT-REJECT-FIXTURE";
const LOCAL_S4_HISTORY_PIECE_MARKER = "S4-PIECE-A-FIXTURE";
const LOCAL_S4_CURRENT_PIECE_MARKER = "S4-PIECE-B-FIXTURE";
const LOCAL_S4_PROVIDER_EXCEPTION_MARKER = "S4-PROVIDER-EXCEPTION-FIXTURE";
const LOCAL_S4_PROVIDER_EXCEPTION_MESSAGE_CANARY = "S4-PROVIDER-EXCEPTION-MESSAGE-CANARY";
const LOCAL_S4_PROVIDER_EXCEPTION_STACK_CANARY = "S4-PROVIDER-EXCEPTION-STACK-CANARY";
const LOCAL_S4_WARNING_MARKER = "S4-WARNING-FIXTURE";
const LOCAL_S4_NEGATIVE_DEDUP_MARKER = "S4-NEGATIVE-DEDUP-FIXTURE";
const LOCAL_S4_BENIGN_OUTAGE_MARKER = "S4-BENIGN-OUTAGE-FIXTURE";
const localS4FellowAuthorityHeader = "x-asimp-local-s4-fellow-authority";
const localS4FellowIdHeader = "x-asimp-local-s4-fellow-id";
const localS3SponsorAuthorityHeader = "x-asimp-local-s3-sponsor-authority";
const localS3SponsorIdHeader = "x-asimp-local-s3-sponsor-id";
const localS4FixtureAuthorityHeader = "x-asimp-local-s4-fixture-authority";
const localS4NowSecondsHeader = "x-asimp-local-s4-now-seconds";
const localSponsorId = "local-sponsor-fixture";
const crossSponsorId = "s3-cross-sponsor";
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

function promotionRequest(
  workshopId: string,
  statement: string,
  publicArtifactMd: string,
  candidate: Record<string, unknown> = {},
  extraHeaders: Readonly<Record<string, string>> = {},
  outward: Partial<{
    readonly title: string;
    readonly extract: string;
    readonly statement: string;
    readonly public_artifact_md: string;
  }> = {},
): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `local-promote-${workshopId}`,
      ...extraHeaders,
    },
    body: JSON.stringify({
      candidate,
      extract: outward.extract ?? "A public extract for the local binding proof.",
      public_artifact_md: outward.public_artifact_md ?? publicArtifactMd,
      statement: outward.statement ?? statement,
      title: outward.title ?? "One public local promotion",
      workshop_id: workshopId,
    }),
  };
}

function s4FixtureHeaders(
  idempotencyKey: string,
  extra: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  return {
    "idempotency-key": idempotencyKey,
    [localS4FixtureAuthorityHeader]: localAuthorityToken,
    ...extra,
  };
}

async function resetS4Fixtures(authority = localAuthorityToken): Promise<Snapshot> {
  return snapshot(
    await localFetch(`${origin}/__s3/s4/fixtures/reset`, {
      method: "POST",
      headers: { [localS4FixtureAuthorityHeader]: authority },
    }),
  );
}

async function promote(
  workshopId: string,
  statement: string,
  publicArtifactMd: string,
  candidate: Record<string, unknown> = {},
  extraHeaders: Readonly<Record<string, string>> = {},
  outward: Partial<{
    readonly title: string;
    readonly extract: string;
    readonly statement: string;
    readonly public_artifact_md: string;
  }> = {},
): Promise<JsonResult> {
  return requestJson(
    "/__s3/promote",
    promotionRequest(workshopId, statement, publicArtifactMd, candidate, extraHeaders, outward),
  );
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
    "local_workerd_reports_D1_and_R2_bindings_with_a_public_readiness_nonce_but_never_authority",
    health.response.status === 200 &&
      Array.isArray(health.body.bindings) &&
      health.body.readiness_nonce === localReadinessNonce &&
      !("run_token" in health.body) &&
      !JSON.stringify(health.body).includes(localAuthorityToken),
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
  const sponsorVisiblePushed = await pushWorkshop(
    sponsorVisiblePrivateProblemId,
    sponsorVisiblePrivateCanary,
    {
      [localS4FellowAuthorityHeader]: localAuthorityToken,
      [localS4FellowIdHeader]: sponsorVisiblePrivateFellowId,
    },
  );
  const sponsorVisibleWorkshopId = recordField(sponsorVisiblePushed.body, "workshop_id") ?? "";
  const sponsorVisiblePrivateDigest = await sha256Hex(sponsorVisiblePrivateCanary);
  const sponsorVisiblePrivateBodyKey = `s3-local/private/staged/sha256/${sponsorVisiblePrivateDigest}`;
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
  const crossSponsorPrivate = await snapshot(
    await localFetch(`${origin}/__s3/private/${workshopId}`, {
      headers: {
        "x-asimp-local-sponsor": localAuthorityToken,
        [localS3SponsorAuthorityHeader]: localAuthorityToken,
        [localS3SponsorIdHeader]: crossSponsorId,
      },
    }),
  );
  const missingPrivateWorkshopId = "W-s3-does-not-exist";
  const anonymousMissingPrivate = await snapshot(
    await localFetch(`${origin}/__s3/private/${missingPrivateWorkshopId}`),
  );
  const crossSponsorMissingPrivate = await snapshot(
    await localFetch(`${origin}/__s3/private/${missingPrivateWorkshopId}`, {
      headers: {
        "x-asimp-local-sponsor": localAuthorityToken,
        [localS3SponsorAuthorityHeader]: localAuthorityToken,
        [localS3SponsorIdHeader]: crossSponsorId,
      },
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
  check(
    "authenticated_cross_sponsor_private_authority_is_indistinguishable_from_anonymous",
    crossSponsorPrivate.response.status === 404 &&
      crossSponsorPrivate.response.headers.get("cache-control") === "no-store" &&
      crossSponsorPrivate.body === anonymousPrivate.body &&
      crossSponsorPrivate.headers === anonymousPrivate.headers &&
      hasNoPrivateMaterial(crossSponsorPrivate, [
        privateCanary,
        workshopId,
        privateDigest,
        privateBodyKey,
        localSponsorId,
        crossSponsorId,
      ]),
    "an authenticated cross-sponsor principal could distinguish or read the private workshop",
  );
  check(
    "missing_private_id_cross_sponsor_authority_is_indistinguishable_from_anonymous",
    anonymousMissingPrivate.response.status === 404 &&
      anonymousMissingPrivate.response.headers.get("cache-control") === "no-store" &&
      crossSponsorMissingPrivate.response.status === 404 &&
      crossSponsorMissingPrivate.response.headers.get("cache-control") === "no-store" &&
      crossSponsorMissingPrivate.body === anonymousMissingPrivate.body &&
      crossSponsorMissingPrivate.headers === anonymousMissingPrivate.headers &&
      hasNoPrivateMaterial(anonymousMissingPrivate, [
        privateCanary,
        workshopId,
        privateDigest,
        privateBodyKey,
        localSponsorId,
        missingPrivateWorkshopId,
      ]) &&
      hasNoPrivateMaterial(crossSponsorMissingPrivate, [
        privateCanary,
        workshopId,
        privateDigest,
        privateBodyKey,
        localSponsorId,
        crossSponsorId,
        missingPrivateWorkshopId,
      ]),
    "a missing private identifier reveals cross-sponsor authority or reaches private material",
  );
  check(
    "private_not_found_response_is_invariant_across_existence_classes_for_each_principal",
    anonymousPrivate.body === anonymousMissingPrivate.body &&
      anonymousPrivate.headers === anonymousMissingPrivate.headers &&
      crossSponsorPrivate.body === crossSponsorMissingPrivate.body &&
      crossSponsorPrivate.headers === crossSponsorMissingPrivate.headers,
    "a private not-found response varies by workshop existence for one principal",
  );
  const ownerPrivate = await snapshot(
    await localFetch(`${origin}/__s3/private/${workshopId}`, {
      headers: { "x-asimp-local-sponsor": localAuthorityToken },
    }),
  );
  const sponsorVisiblePrivate = await snapshot(
    await localFetch(`${origin}/__s3/private/${sponsorVisibleWorkshopId}`, {
      headers: { "x-asimp-local-sponsor": localAuthorityToken },
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
  const sponsorVisiblePrivatePublic = await Promise.all([
    ...FACE_FORMATS.map(async (format) =>
      snapshot(
        await localFetch(
          `${origin}/__s3/public/${sponsorVisiblePrivateProblemId}?format=${format}`,
        ),
      ),
    ),
    snapshot(
      await localFetch(`${origin}/__s3/public/${sponsorVisiblePrivateProblemId}/search?q=neutral`),
    ),
    snapshot(
      await localFetch(`${origin}/__s3/public/${sponsorVisiblePrivateProblemId}/export.jsonl`),
    ),
  ]);
  check(
    "sponsor_can_read_own_fellow_workshop_while_public_routes_disclose_nothing",
    sponsorVisiblePushed.response.status === 201 &&
      sponsorVisibleWorkshopId === `W-${sponsorVisiblePrivateFellowId}-1` &&
      sponsorVisiblePrivate.response.status === 200 &&
      sponsorVisiblePrivate.response.headers.get("cache-control") === "private, no-store" &&
      sponsorVisiblePrivate.body === sponsorVisiblePrivateCanary &&
      sponsorVisiblePrivatePublic.length === unknownPublic.length &&
      sponsorVisiblePrivatePublic.every(
        (observed, index) =>
          observed.response.status === 404 &&
          observed.response.status === unknownPublic[index]?.response.status &&
          observed.body === unknownPublic[index]?.body &&
          observed.headers === unknownPublic[index]?.headers &&
          hasNoPrivateMaterial(observed, [
            sponsorVisiblePrivateCanary,
            sponsorVisibleWorkshopId,
            sponsorVisiblePrivateDigest,
            sponsorVisiblePrivateBodyKey,
            sponsorVisiblePrivateFellowId,
            localSponsorId,
          ]),
      ),
    "the owning sponsor could not read a Fellow workshop, or an anonymous public route exposed it",
  );
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
    "reused_idempotency_key_with_a_different_promotion_preserves_the_one_promotion_invariant",
    repeatedPromotion.response.status === 409 &&
      repeatedPromotion.body.code === "IDEMPOTENCY_CONFLICT",
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
  const poisonedPublicHeaders = { "x-asimp-local-shape-poison": localAuthorityToken };
  const readinessNoncePoisonedPublicHeaders = {
    "x-asimp-local-shape-poison": localReadinessNonce,
  };
  const nonemptyPoisonedPublicHeaders = { "x-asimp-local-shape-poison": "nonempty" };
  const poisonedPrivateLocator = `s3-local-shape-poison-${localAuthorityToken}`;
  const poisonedProbeForbidden = [
    ...forbiddenMain,
    poisonedPrivateLocator,
    localAuthorityToken,
    localReadinessNonce,
  ];
  const poisonProbePaths = [
    ...FACE_FORMATS.map((format) => `${origin}/__s3/public/${mainProblemId}?format=${format}`),
    `${origin}/__s3/public/${mainProblemId}/search?q=${encodeURIComponent(publicStatement)}`,
    `${origin}/__s3/public/${mainProblemId}/export.jsonl`,
  ];
  const poisonProbeSnapshots = (headers: Readonly<Record<string, string>>) =>
    Promise.all(
      poisonProbePaths.map(async (path) => snapshot(await localFetch(path, { headers }))),
    );
  const routeBindingPoisonHeaders = {
    "x-asimp-local-route-binding-poison": localAuthorityToken,
  };
  const readinessNonceRouteBindingPoisonHeaders = {
    "x-asimp-local-route-binding-poison": localReadinessNonce,
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
        await localFetch(`${origin}/__s3/public/${mainProblemId}/screening.json`, {
          headers,
        }),
      ),
      snapshot(
        await localFetch(`${origin}/__s3/s4/diagnostics/${mainProblemId}`, {
          headers,
        }),
      ),
      snapshot(
        await localFetch(`${origin}/__s3/s4/fixtures/oversized-history/${mainProblemId}`, {
          method: "POST",
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
  const [unpoisonedPublic, poisonedPublic, readinessNoncePoisonedPublic, nonemptyPoisonedPublic] =
    await Promise.all([
      poisonProbeSnapshots({}),
      poisonProbeSnapshots(poisonedPublicHeaders),
      poisonProbeSnapshots(readinessNoncePoisonedPublicHeaders),
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
      [readinessNoncePoisonedPublic, nonemptyPoisonedPublic].every(
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
    readinessNonceRouteBindingPoisoned,
    nonemptyRouteBindingPoisoned,
  ] = await Promise.all([
    routeBindingPoisonSnapshots({}),
    routeBindingPoisonSnapshots(routeBindingPoisonHeaders),
    routeBindingPoisonSnapshots(readinessNonceRouteBindingPoisonHeaders),
    routeBindingPoisonSnapshots(nonemptyRouteBindingPoisonHeaders),
  ]);
  check(
    "all_eleven_async_route_entry_faults_return_one_exact_nonreflective_binding_failure",
    routeBindingPoisoned.length === 11 &&
      routeBindingPoisoned.every(isExactLocalS3BindingFailure) &&
      routeBindingPoisoned.every((response) =>
        hasNoPrivateMaterial(response, [...forbiddenMain, poisonedPrivateLocator]),
      ),
    "an async route bypassed the binding failure boundary or disclosed poisoned internals",
  );
  check(
    "readiness_nonce_or_nonempty_route_binding_poison_headers_are_byte_for_byte_inert_on_every_async_route",
    [readinessNonceRouteBindingPoisoned, nonemptyRouteBindingPoisoned].every(
      (responses) =>
        responses.length === 11 &&
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
    "x-asimp-local-test-fault-authority": localAuthorityToken,
  });
  const staleAuthorityAudit = await snapshot(
    await localFetch(`${origin}/__s3/recovery/sha256/${recoveryDigest}`, {
      headers: { "x-asimp-local-recovery-audit": "local-recovery-audit" },
    }),
  );
  const orphanAudit = await requestJson(`/__s3/recovery/sha256/${recoveryDigest}`, {
    headers: { "x-asimp-local-recovery-audit": localAuthorityToken },
  });
  const readinessNonceAudit = await snapshot(
    await localFetch(`${origin}/__s3/recovery/sha256/${recoveryDigest}`, {
      headers: { "x-asimp-local-recovery-audit": localReadinessNonce },
    }),
  );
  const failedArtifactProbe = await snapshot(
    await localFetch(`${origin}/sha256/${recoveryDigest}`),
  );
  const recoveredBind = await pushWorkshop(recoveryProblem, recoveryBody);
  const recoveredAudit = await requestJson(`/__s3/recovery/sha256/${recoveryDigest}`, {
    headers: { "x-asimp-local-recovery-audit": localAuthorityToken },
  });
  const missingFaultAuthority = await pushWorkshop(
    "P-s3-recovery-fault-no-authority",
    `${privateCanary}-fault-request-without-authority`,
    { "x-asimp-local-test-fault": "d1-bind-reject" },
  );
  const readinessNonceFaultAuthority = await pushWorkshop(
    "P-s3-recovery-fault-readiness-nonce",
    `${privateCanary}-fault-request-with-readiness-nonce`,
    {
      "x-asimp-local-test-fault": "d1-bind-reject",
      "x-asimp-local-test-fault-authority": localReadinessNonce,
    },
  );
  check(
    "R2_put_then_D1_failure_leaves_an_unreachable_orphan_and_retry_binds_without_a_cursor_burn",
    failedBind.response.status === 503 &&
      failedBind.body.code === "PRIVATE_CAS_RECOVERY_REQUIRED" &&
      staleAuthorityAudit.response.status === 404 &&
      readinessNonceAudit.response.status === 404 &&
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
      readinessNonceFaultAuthority.response.status === 201 &&
      readinessNonceFaultAuthority.body.spilled_to_private_r2 === true,
    `failure ${failedBind.response.status}/${String(failedBind.body.code)} orphan ${String(orphanAudit.body.state)} readiness-audit ${readinessNonceAudit.response.status} retry ${recoveredBind.response.status}/${String(recoveredBind.body.workshop_seq)} recovery ${String(recoveredAudit.body.state)} unauthorized ${missingFaultAuthority.response.status}/${readinessNonceFaultAuthority.response.status}`,
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

  const sameKeyPublicationProblemId = "P-s4-publishing-idempotency-race";
  const sameKeyPublicationWorkshop = await pushWorkshop(
    sameKeyPublicationProblemId,
    `${privateCanary}-s4-publishing-idempotency-race`,
  );
  const sameKeyPublicationRequest = promotionRequest(
    recordField(sameKeyPublicationWorkshop.body, "workshop_id") ?? "",
    "S4 simultaneous same-key promotion has one immutable public outcome.",
    "S4 simultaneous same-key public artifact.",
    {},
    s4FixtureHeaders("s4-publishing-idempotency-race"),
  );
  // These are independent HTTP requests released together, not a sequential
  // replay. The loser may pass its first replay lookup before the winner's
  // D1 batch commits, and must still return the winner's exact persisted 201.
  const sameKeyPublicationResponses = await Promise.all(
    Array.from({ length: 2 }, async () =>
      snapshot(await localFetch(`${origin}/__s3/promote`, sameKeyPublicationRequest)),
    ),
  );
  const sameKeyPublicationBodies = sameKeyPublicationResponses.map((response) => response.body);
  const sameKeyPublicationEvents = sameKeyPublicationBodies.map((body) => {
    try {
      return recordField(JSON.parse(body) as Record<string, unknown>, "event_id");
    } catch {
      return undefined;
    }
  });
  const sameKeyPublicationLedger = await snapshot(
    await localFetch(`${origin}/__s3/public/${sameKeyPublicationProblemId}?format=json`),
  );
  const sameKeyPublicationEventsInLedger = (() => {
    try {
      const body = JSON.parse(sameKeyPublicationLedger.body) as Record<string, unknown>;
      return Array.isArray(body.items) ? body.items.filter(isLedgerItem) : [];
    } catch {
      return [];
    }
  })();
  const sameKeyPublicationActions = await snapshot(
    await localFetch(`${origin}/__s3/public/${sameKeyPublicationProblemId}/screening.json`),
  );
  const sameKeyPublicationActionRows = (() => {
    try {
      const body = JSON.parse(sameKeyPublicationActions.body) as Record<string, unknown>;
      return Array.isArray(body.actions) ? body.actions : [];
    } catch {
      return [];
    }
  })();
  const sameKeyPublicationDiagnostics = await requestJson(
    `/__s3/s4/diagnostics/${sameKeyPublicationProblemId}`,
    { headers: { [localS4FixtureAuthorityHeader]: localAuthorityToken } },
  );
  const sameKeyPublicationReceipts = Array.isArray(sameKeyPublicationDiagnostics.body.receipts)
    ? sameKeyPublicationDiagnostics.body.receipts
    : [];
  check(
    "S4_concurrent_same_key_publishing_replays_the_exact_201_and_commits_one_event_action_and_receipt",
    sameKeyPublicationWorkshop.response.status === 201 &&
      sameKeyPublicationResponses.every((response) => response.response.status === 201) &&
      sameKeyPublicationBodies[0] !== undefined &&
      sameKeyPublicationBodies.every((body) => body === sameKeyPublicationBodies[0]) &&
      sameKeyPublicationEvents[0] !== undefined &&
      sameKeyPublicationEvents.every((eventId) => eventId === sameKeyPublicationEvents[0]) &&
      sameKeyPublicationEventsInLedger.length === 1 &&
      sameKeyPublicationActionRows.length === 1 &&
      sameKeyPublicationDiagnostics.response.status === 200 &&
      sameKeyPublicationReceipts.length === 1,
    `statuses ${sameKeyPublicationResponses.map((response) => response.response.status).join(",")} events ${sameKeyPublicationEvents.join(",")} ledger ${sameKeyPublicationEventsInLedger.length} actions ${sameKeyPublicationActionRows.length} receipts ${sameKeyPublicationReceipts.length}`,
  );

  const s4OutwardFields = ["title", "extract", "statement", "public_artifact_md"] as const;
  const s4HeldResponses: boolean[] = [];
  for (const [index, field] of s4OutwardFields.entries()) {
    const problemId = `P-s4-context-${field}`;
    const priorMarker = `${LOCAL_S4_HISTORY_PIECE_MARKER}-${field}`;
    const currentMarker = `${LOCAL_S4_CURRENT_PIECE_MARKER}-${field}`;
    const priorWorkshop = await pushWorkshop(problemId, `${privateCanary}-s4-prior-${field}`);
    const priorOutward: Partial<{
      readonly title: string;
      readonly extract: string;
      readonly statement: string;
      readonly public_artifact_md: string;
    }> = { [field]: priorMarker };
    const priorPromotion = await promote(
      recordField(priorWorkshop.body, "workshop_id") ?? "",
      `S4 prior public statement for ${field}.`,
      `S4 prior public artifact for ${field}.`,
      {},
      s4FixtureHeaders(`s4-context-prior-${index}`),
      priorOutward,
    );
    const beforeHold = await snapshot(
      await localFetch(`${origin}/__s3/public/${problemId}?format=json`),
    );
    const heldWorkshop = await pushWorkshop(problemId, `${privateCanary}-s4-held-${field}`);
    const heldArtifact = `S4 held public artifact for ${field}.`;
    const currentOutward: Partial<{
      readonly title: string;
      readonly extract: string;
      readonly statement: string;
      readonly public_artifact_md: string;
    }> = { [field]: currentMarker };
    const holdHeaders = s4FixtureHeaders(`s4-context-hold-${index}`);
    const holdRequest = promotionRequest(
      recordField(heldWorkshop.body, "workshop_id") ?? "",
      `S4 held public statement for ${field}.`,
      heldArtifact,
      {},
      holdHeaders,
      currentOutward,
    );
    const firstHold = await snapshot(await localFetch(`${origin}/__s3/promote`, holdRequest));
    const replayedHold = await snapshot(await localFetch(`${origin}/__s3/promote`, holdRequest));
    const mismatchedReplay = await snapshot(
      await localFetch(
        `${origin}/__s3/promote`,
        promotionRequest(
          recordField(heldWorkshop.body, "workshop_id") ?? "",
          `S4 mismatched replay statement for ${field}.`,
          heldArtifact,
          {},
          holdHeaders,
          { ...currentOutward, title: `S4 mismatched replay title for ${field}.` },
        ),
      ),
    );
    const afterHold = await snapshot(
      await localFetch(`${origin}/__s3/public/${problemId}?format=json`),
    );
    const heldArtifactDigest = await sha256Hex(currentOutward.public_artifact_md ?? heldArtifact);
    const heldArtifactRead = await snapshot(
      await localFetch(`${origin}/sha256/${heldArtifactDigest}`),
    );
    const fieldHeld =
      priorWorkshop.response.status === 201 &&
      priorPromotion.response.status === 201 &&
      beforeHold.response.status === 200 &&
      firstHold.response.status === 202 &&
      firstHold.body ===
        '{"code":"SCREENING_HOLD","coarse_category":"dual-use-boundary","appeal":"SPONSOR_APPEAL_AVAILABLE"}' &&
      replayedHold.response.status === 202 &&
      replayedHold.body === firstHold.body &&
      mismatchedReplay.response.status === 409 &&
      mismatchedReplay.body === '{"code":"IDEMPOTENCY_CONFLICT"}' &&
      afterHold.response.status === 200 &&
      afterHold.body === beforeHold.body &&
      heldArtifactRead.response.status === 404 &&
      hasNoPrivateMaterial(firstHold, [currentMarker, heldArtifact]) &&
      hasNoPrivateMaterial(replayedHold, [currentMarker, heldArtifact]) &&
      hasNoPrivateMaterial(mismatchedReplay, [currentMarker, heldArtifact]) &&
      hasNoPrivateMaterial(afterHold, [currentMarker, heldArtifact]) &&
      hasNoPrivateMaterial(heldArtifactRead, [currentMarker, heldArtifact]);
    s4HeldResponses.push(fieldHeld);
    check(
      `S4_${field}_history_field_reaches_contextual_provider_without_public_effect`,
      fieldHeld,
      `prior ${priorPromotion.response.status} hold ${firstHold.response.status} replay ${replayedHold.response.status} mismatch ${mismatchedReplay.response.status} public ${afterHold.response.status} artifact ${heldArtifactRead.response.status}`,
    );
  }
  check(
    "S4_contextual_aggregation_reads_all_four_D1_authorized_public_fields_and_holds_without_public_effect",
    s4HeldResponses.length === s4OutwardFields.length && s4HeldResponses.every(Boolean),
    "a field-specific contextual hold reflected content, duplicated a hold, or changed a public face",
  );

  const callerProblemCanary = "S4-CALLER-PROBLEM-STATEMENT-MUST-NOT-REACH-CONTEXT";
  const callerProblemWorkshop = await pushWorkshop(
    "P-s4-caller-problem",
    `${privateCanary}-s4-caller-problem`,
  );
  const callerProblemResponse = await snapshot(
    await localFetch(`${origin}/__s3/promote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        candidate: {},
        extract: "S4 caller problem extract.",
        problem_statement: callerProblemCanary,
        public_artifact_md: "S4 caller problem artifact.",
        statement: "S4 caller problem statement.",
        title: "S4 caller problem title.",
        workshop_id: recordField(callerProblemWorkshop.body, "workshop_id") ?? "",
      }),
    }),
  );
  check(
    "S4_problem_statement_is_server_owned_and_caller_material_never_reflects",
    callerProblemWorkshop.response.status === 201 &&
      callerProblemResponse.response.status === 400 &&
      callerProblemResponse.body === '{"code":"LOCAL_INPUT_INVALID"}' &&
      hasNoPrivateMaterial(callerProblemResponse, [callerProblemCanary]),
    `status ${callerProblemResponse.response.status}`,
  );

  const timeoutProblemId = "P-s4-timeout";
  const timeoutArtifact = "S4 timeout artifact must not become public.";
  const timeoutWorkshop = await pushWorkshop(timeoutProblemId, `${privateCanary}-s4-timeout`);
  const timeoutHold = await snapshot(
    await localFetch(
      `${origin}/__s3/promote`,
      promotionRequest(
        recordField(timeoutWorkshop.body, "workshop_id") ?? "",
        LOCAL_S4_TIMEOUT_MARKER,
        timeoutArtifact,
        {},
        s4FixtureHeaders("s4-timeout-hold"),
      ),
    ),
  );
  const timeoutFace = await snapshot(
    await localFetch(`${origin}/__s3/public/${timeoutProblemId}?format=json`),
  );
  const timeoutArtifactRead = await snapshot(
    await localFetch(`${origin}/sha256/${await sha256Hex(timeoutArtifact)}`),
  );
  check(
    "S4_provider_timeout_fails_closed_to_a_private_appealable_hold_without_public_cursor_or_artifact",
    timeoutWorkshop.response.status === 201 &&
      timeoutHold.response.status === 202 &&
      timeoutHold.body ===
        '{"code":"SCREENING_HOLD","coarse_category":"provider-unavailable","appeal":"SPONSOR_APPEAL_AVAILABLE"}' &&
      timeoutFace.response.status === 404 &&
      timeoutArtifactRead.response.status === 404 &&
      hasNoPrivateMaterial(timeoutHold, [LOCAL_S4_TIMEOUT_MARKER, timeoutArtifact]) &&
      hasNoPrivateMaterial(timeoutFace, [LOCAL_S4_TIMEOUT_MARKER, timeoutArtifact]) &&
      hasNoPrivateMaterial(timeoutArtifactRead, [LOCAL_S4_TIMEOUT_MARKER, timeoutArtifact]),
    `hold ${timeoutHold.response.status} public ${timeoutFace.response.status} artifact ${timeoutArtifactRead.response.status}`,
  );

  const directProblemId = "P-s4-direct-reject";
  const directArtifact = "S4 direct-reject artifact must not become public.";
  const directWorkshop = await pushWorkshop(directProblemId, `${privateCanary}-s4-direct-reject`);
  const directRefusal = await snapshot(
    await localFetch(
      `${origin}/__s3/promote`,
      promotionRequest(
        recordField(directWorkshop.body, "workshop_id") ?? "",
        "S4 normal statement.",
        directArtifact,
        {},
        s4FixtureHeaders("s4-direct-reject"),
        { title: LOCAL_S4_DIRECT_REJECT_MARKER },
      ),
    ),
  );
  const directFace = await snapshot(
    await localFetch(`${origin}/__s3/public/${directProblemId}?format=json`),
  );
  const directArtifactRead = await snapshot(
    await localFetch(`${origin}/sha256/${await sha256Hex(directArtifact)}`),
  );
  check(
    "S4_direct_content_reject_is_not_downgraded_by_contextual_screening",
    directWorkshop.response.status === 201 &&
      directRefusal.response.status === 403 &&
      directRefusal.body ===
        '{"code":"POLICY_DENIED","coarse_category":"operational-harm","appeal":"SPONSOR_APPEAL_AVAILABLE"}' &&
      directFace.response.status === 404 &&
      directArtifactRead.response.status === 404 &&
      hasNoPrivateMaterial(directRefusal, [LOCAL_S4_DIRECT_REJECT_MARKER, directArtifact]) &&
      hasNoPrivateMaterial(directFace, [LOCAL_S4_DIRECT_REJECT_MARKER, directArtifact]) &&
      hasNoPrivateMaterial(directArtifactRead, [LOCAL_S4_DIRECT_REJECT_MARKER, directArtifact]),
    `refusal ${directRefusal.response.status} public ${directFace.response.status} artifact ${directArtifactRead.response.status}`,
  );

  const providerExceptionProblemId = "P-s4-provider-exception";
  const providerExceptionArtifact = "S4 provider exception artifact must not become public.";
  const providerExceptionWorkshop = await pushWorkshop(
    providerExceptionProblemId,
    `${privateCanary}-s4-provider-exception`,
  );
  const providerExceptionHold = await snapshot(
    await localFetch(
      `${origin}/__s3/promote`,
      promotionRequest(
        recordField(providerExceptionWorkshop.body, "workshop_id") ?? "",
        "S4 provider exception statement.",
        providerExceptionArtifact,
        {},
        s4FixtureHeaders("s4-provider-exception-hold"),
        { title: LOCAL_S4_PROVIDER_EXCEPTION_MARKER },
      ),
    ),
  );
  const providerExceptionFace = await snapshot(
    await localFetch(`${origin}/__s3/public/${providerExceptionProblemId}?format=json`),
  );
  const providerExceptionExport = await snapshot(
    await localFetch(`${origin}/__s3/public/${providerExceptionProblemId}/export.jsonl`),
  );
  const providerExceptionArtifactRead = await snapshot(
    await localFetch(`${origin}/sha256/${await sha256Hex(providerExceptionArtifact)}`),
  );
  const providerExceptionCanaries = [
    LOCAL_S4_PROVIDER_EXCEPTION_MARKER,
    LOCAL_S4_PROVIDER_EXCEPTION_MESSAGE_CANARY,
    LOCAL_S4_PROVIDER_EXCEPTION_STACK_CANARY,
    providerExceptionArtifact,
  ];
  check(
    "S4_provider_exception_message_and_stack_are_a_coarse_private_hold_without_response_R2_event_or_export_leakage",
    providerExceptionWorkshop.response.status === 201 &&
      providerExceptionHold.response.status === 202 &&
      providerExceptionHold.body ===
        '{"code":"SCREENING_HOLD","coarse_category":"provider-unavailable","appeal":"SPONSOR_APPEAL_AVAILABLE"}' &&
      providerExceptionFace.response.status === 404 &&
      providerExceptionExport.response.status === 404 &&
      providerExceptionArtifactRead.response.status === 404 &&
      hasNoPrivateMaterial(providerExceptionHold, providerExceptionCanaries) &&
      hasNoPrivateMaterial(providerExceptionFace, providerExceptionCanaries) &&
      hasNoPrivateMaterial(providerExceptionExport, providerExceptionCanaries) &&
      hasNoPrivateMaterial(providerExceptionArtifactRead, providerExceptionCanaries),
    `hold ${providerExceptionHold.response.status} public ${providerExceptionFace.response.status} export ${providerExceptionExport.response.status} artifact ${providerExceptionArtifactRead.response.status}`,
  );

  const oversizedProblemId = "P-s4-oversized-context";
  const oversizedCanary = "S4-OVERSIZED-CONTEXT-CANARY-MUST-NOT-LEAK";
  const oversizedArtifact = `${oversizedCanary}${"x".repeat(4_096)}`;
  const oversizedWorkshop = await pushWorkshop(
    oversizedProblemId,
    `${privateCanary}-s4-oversized-context`,
  );
  const oversizedHold = await snapshot(
    await localFetch(
      `${origin}/__s3/promote`,
      promotionRequest(
        recordField(oversizedWorkshop.body, "workshop_id") ?? "",
        "S4 oversized statement.",
        oversizedArtifact,
        {},
        s4FixtureHeaders("s4-oversized-context-hold"),
      ),
    ),
  );
  const oversizedFace = await snapshot(
    await localFetch(`${origin}/__s3/public/${oversizedProblemId}?format=json`),
  );
  const oversizedExport = await snapshot(
    await localFetch(`${origin}/__s3/public/${oversizedProblemId}/export.jsonl`),
  );
  const oversizedArtifactRead = await snapshot(
    await localFetch(`${origin}/sha256/${await sha256Hex(oversizedArtifact)}`),
  );
  check(
    "S4_oversized_context_fails_closed_without_response_R2_event_or_export_canary_leakage",
    oversizedWorkshop.response.status === 201 &&
      oversizedHold.response.status === 202 &&
      oversizedHold.body ===
        '{"code":"SCREENING_HOLD","coarse_category":"provider-unavailable","appeal":"SPONSOR_APPEAL_AVAILABLE"}' &&
      oversizedFace.response.status === 404 &&
      oversizedExport.response.status === 404 &&
      oversizedArtifactRead.response.status === 404 &&
      hasNoPrivateMaterial(oversizedHold, [oversizedCanary]) &&
      hasNoPrivateMaterial(oversizedFace, [oversizedCanary]) &&
      hasNoPrivateMaterial(oversizedExport, [oversizedCanary]) &&
      hasNoPrivateMaterial(oversizedArtifactRead, [oversizedCanary]),
    `hold ${oversizedHold.response.status} public ${oversizedFace.response.status} export ${oversizedExport.response.status} artifact ${oversizedArtifactRead.response.status}`,
  );

  const missingKeyProblemId = "P-s4-idempotency-required";
  const missingKeyWorkshop = await pushWorkshop(
    missingKeyProblemId,
    `${privateCanary}-s4-idempotency-required`,
  );
  const missingKeyResponse = await snapshot(
    await localFetch(`${origin}/__s3/promote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        candidate: {},
        extract: "S4 idempotency-required extract.",
        public_artifact_md: "S4 idempotency-required artifact.",
        statement: "S4 idempotency-required statement.",
        title: "S4 idempotency-required title.",
        workshop_id: recordField(missingKeyWorkshop.body, "workshop_id") ?? "",
      }),
    }),
  );
  check(
    "S4_promotion_requires_an_explicit_idempotency_key_before_screening_or_public_effect",
    missingKeyWorkshop.response.status === 201 &&
      missingKeyResponse.response.status === 400 &&
      missingKeyResponse.body === '{"code":"IDEMPOTENCY_KEY_REQUIRED"}',
    `workshop ${missingKeyWorkshop.response.status} promote ${missingKeyResponse.response.status}/${missingKeyResponse.body}`,
  );

  const readinessNonceReset = await resetS4Fixtures(localReadinessNonce);
  const trustedReset = await resetS4Fixtures();
  const negativeDedupProblemId = "P-s4-negative-dedup";
  const negativeDedupFirstWorkshop = await pushWorkshop(
    negativeDedupProblemId,
    `${privateCanary}-s4-negative-dedup-first`,
  );
  const negativeDedupFirst = await snapshot(
    await localFetch(
      `${origin}/__s3/promote`,
      promotionRequest(
        recordField(negativeDedupFirstWorkshop.body, "workshop_id") ?? "",
        "S4 negative-dedup statement.",
        "S4 negative-dedup artifact.",
        {},
        s4FixtureHeaders("s4-negative-dedup-first", { [localS4NowSecondsHeader]: "1000" }),
        { title: LOCAL_S4_NEGATIVE_DEDUP_MARKER },
      ),
    ),
  );
  const negativeDedupSecondWorkshop = await pushWorkshop(
    negativeDedupProblemId,
    `${privateCanary}-s4-negative-dedup-second`,
  );
  const negativeDedupSecond = await snapshot(
    await localFetch(
      `${origin}/__s3/promote`,
      promotionRequest(
        recordField(negativeDedupSecondWorkshop.body, "workshop_id") ?? "",
        "S4 negative-dedup statement.",
        "S4 negative-dedup artifact.",
        {},
        s4FixtureHeaders("s4-negative-dedup-second", { [localS4NowSecondsHeader]: "1001" }),
        { title: LOCAL_S4_NEGATIVE_DEDUP_MARKER },
      ),
    ),
  );
  const negativeDedupPublic = await snapshot(
    await localFetch(`${origin}/__s3/public/${negativeDedupProblemId}/screening.json`),
  );
  const negativeDedupDiagnosticsDenied = await snapshot(
    await localFetch(`${origin}/__s3/s4/diagnostics/${negativeDedupProblemId}`),
  );
  const negativeDedupDiagnosticsReadinessNonce = await snapshot(
    await localFetch(`${origin}/__s3/s4/diagnostics/${negativeDedupProblemId}`, {
      headers: { [localS4FixtureAuthorityHeader]: localReadinessNonce },
    }),
  );
  const negativeDedupDiagnostics = await requestJson(
    `/__s3/s4/diagnostics/${negativeDedupProblemId}`,
    { headers: { [localS4FixtureAuthorityHeader]: localAuthorityToken } },
  );
  const negativeDedupReceipts = Array.isArray(negativeDedupDiagnostics.body.receipts)
    ? negativeDedupDiagnostics.body.receipts
    : [];
  const firstDedupReceipt = negativeDedupReceipts[0];
  const firstDedupRecord =
    firstDedupReceipt !== null && typeof firstDedupReceipt === "object"
      ? (firstDedupReceipt as Record<string, unknown>)
      : undefined;
  const deduplicatedReceipt = negativeDedupReceipts[1];
  const deduplicatedFrom =
    deduplicatedReceipt !== null && typeof deduplicatedReceipt === "object"
      ? recordField(deduplicatedReceipt as Record<string, unknown>, "deduplicated_from_receipt_id")
      : undefined;
  check(
    "S4_negative_content_context_dedup_is_expiring_receipted_and_never_leaks_into_public_projection",
    readinessNonceReset.response.status === 404 &&
      trustedReset.response.status === 204 &&
      negativeDedupFirst.response.status === 202 &&
      negativeDedupSecond.response.status === 202 &&
      negativeDedupSecond.body === negativeDedupFirst.body &&
      negativeDedupPublic.response.status === 200 &&
      negativeDedupPublic.body ===
        '{"schema":"asimposium.s4-public-actions.v1","actions":[{"category":"dual-use-boundary","action":"quarantined","notice":"none"},{"category":"dual-use-boundary","action":"quarantined","notice":"none"}]}' &&
      negativeDedupDiagnosticsDenied.response.status === 404 &&
      negativeDedupDiagnosticsReadinessNonce.response.status === 404 &&
      negativeDedupDiagnostics.response.status === 200 &&
      negativeDedupReceipts.length === 2 &&
      typeof recordField(firstDedupRecord ?? {}, "configuration_digest") === "string" &&
      /^sha256:[0-9a-f]{64}$/u.test(
        recordField(firstDedupRecord ?? {}, "configuration_digest") ?? "",
      ) &&
      /^sha256:[0-9a-f]{64}$/u.test(
        recordField(firstDedupRecord ?? {}, "context_frontier_digest") ?? "",
      ) &&
      recordField(firstDedupRecord ?? {}, "decision") === "quarantine" &&
      recordField(firstDedupRecord ?? {}, "action") === "quarantined" &&
      typeof deduplicatedFrom === "string" &&
      /^DR-[A-Za-z0-9._-]+$/u.test(deduplicatedFrom) &&
      hasNoPrivateMaterial(negativeDedupPublic, [LOCAL_S4_NEGATIVE_DEDUP_MARKER]),
    `reset ${readinessNonceReset.response.status}/${trustedReset.response.status} holds ${negativeDedupFirst.response.status}/${negativeDedupSecond.response.status} public ${negativeDedupPublic.response.status} diagnostics ${negativeDedupDiagnosticsDenied.response.status}/${negativeDedupDiagnosticsReadinessNonce.response.status}/${negativeDedupDiagnostics.response.status}`,
  );

  const expiringReplayProblemId = "P-s4-replay-expiry";
  const expiringReplayWorkshop = await pushWorkshop(
    expiringReplayProblemId,
    `${privateCanary}-s4-replay-expiry`,
  );
  const expiringReplayWorkshopId = recordField(expiringReplayWorkshop.body, "workshop_id") ?? "";
  const expiringReplayFirst = await snapshot(
    await localFetch(
      `${origin}/__s3/promote`,
      promotionRequest(
        expiringReplayWorkshopId,
        "S4 replay expiry held statement.",
        "S4 replay expiry held artifact.",
        {},
        s4FixtureHeaders("s4-replay-expiry", { [localS4NowSecondsHeader]: "2000" }),
        { title: LOCAL_S4_TIMEOUT_MARKER },
      ),
    ),
  );
  const expiringReplayAfterWindow = await snapshot(
    await localFetch(
      `${origin}/__s3/promote`,
      promotionRequest(
        expiringReplayWorkshopId,
        "S4 replay expiry published statement.",
        "S4 replay expiry published artifact.",
        {},
        s4FixtureHeaders("s4-replay-expiry", { [localS4NowSecondsHeader]: "88401" }),
      ),
    ),
  );
  check(
    "S4_replay_map_expires_after_24_hours_without_erasing_immutable_decision_history",
    expiringReplayWorkshop.response.status === 201 &&
      expiringReplayFirst.response.status === 202 &&
      expiringReplayAfterWindow.response.status === 201 &&
      expiringReplayAfterWindow.body.includes('"public_seq":1'),
    `first ${expiringReplayFirst.response.status} after-window ${expiringReplayAfterWindow.response.status}`,
  );

  const warningProblemId = "P-s4-warning";
  const warningWorkshop = await pushWorkshop(warningProblemId, `${privateCanary}-s4-warning`);
  const warningPromotion = await snapshot(
    await localFetch(
      `${origin}/__s3/promote`,
      promotionRequest(
        recordField(warningWorkshop.body, "workshop_id") ?? "",
        "S4 warning statement.",
        "S4 warning artifact.",
        {},
        s4FixtureHeaders("s4-warning"),
        { title: LOCAL_S4_WARNING_MARKER },
      ),
    ),
  );
  const warningProjection = await snapshot(
    await localFetch(`${origin}/__s3/public/${warningProblemId}/screening.json`),
  );
  check(
    "S4_allow_with_warning_publishes_a_safe_category_action_notice_without_provider_detail",
    warningWorkshop.response.status === 201 &&
      warningPromotion.response.status === 201 &&
      warningPromotion.body.includes('"screening_notice":"screening-warning"') &&
      warningProjection.response.status === 200 &&
      warningProjection.body ===
        '{"schema":"asimposium.s4-public-actions.v1","actions":[{"category":"dual-use-boundary","action":"published-with-warning","notice":"screening-warning"}]}' &&
      hasNoPrivateMaterial(warningProjection, [LOCAL_S4_WARNING_MARKER]),
    `promotion ${warningPromotion.response.status} projection ${warningProjection.response.status}`,
  );

  const benignOutageProblemId = "P-s4-benign-outage";
  const benignOutageWorkshop = await pushWorkshop(
    benignOutageProblemId,
    `${privateCanary}-s4-benign-outage`,
  );
  const benignOutagePromotion = await snapshot(
    await localFetch(
      `${origin}/__s3/promote`,
      promotionRequest(
        recordField(benignOutageWorkshop.body, "workshop_id") ?? "",
        "S4 benign-outage statement.",
        "S4 benign-outage artifact.",
        {},
        s4FixtureHeaders("s4-benign-outage"),
        { title: `${LOCAL_S4_TIMEOUT_MARKER} ${LOCAL_S4_BENIGN_OUTAGE_MARKER}` },
      ),
    ),
  );
  const benignOutageProjection = await snapshot(
    await localFetch(`${origin}/__s3/public/${benignOutageProblemId}/screening.json`),
  );
  check(
    "S4_authorized_benign_outage_fixture_degrades_to_a_public_warning_notice_not_a_silent_pass",
    benignOutageWorkshop.response.status === 201 &&
      benignOutagePromotion.response.status === 201 &&
      benignOutagePromotion.body.includes('"screening_notice":"screening-degraded"') &&
      benignOutageProjection.response.status === 200 &&
      benignOutageProjection.body.includes('"notice":"screening-degraded"'),
    `promotion ${benignOutagePromotion.response.status} projection ${benignOutageProjection.response.status}`,
  );

  const sameFellowReset = await resetS4Fixtures();
  const sameFellowProblemId = "P-s4-same-fellow-frontier";
  const sameFellowSeedWorkshop = await pushWorkshop(
    sameFellowProblemId,
    `${privateCanary}-s4-same-fellow-seed`,
  );
  const sameFellowSeed = await snapshot(
    await localFetch(
      `${origin}/__s3/promote`,
      promotionRequest(
        recordField(sameFellowSeedWorkshop.body, "workshop_id") ?? "",
        "S4 same-fellow frontier seed statement.",
        "S4 same-fellow frontier seed artifact.",
        {},
        s4FixtureHeaders("s4-same-fellow-seed"),
        { title: LOCAL_S4_HISTORY_PIECE_MARKER },
      ),
    ),
  );
  const sameFellowCurrentWorkshop = await pushWorkshop(
    sameFellowProblemId,
    `${privateCanary}-s4-same-fellow-current`,
  );
  const sameFellowCurrent = await snapshot(
    await localFetch(
      `${origin}/__s3/promote`,
      promotionRequest(
        recordField(sameFellowCurrentWorkshop.body, "workshop_id") ?? "",
        "S4 same-fellow frontier current statement.",
        "S4 same-fellow frontier current artifact.",
        {},
        s4FixtureHeaders("s4-same-fellow-current"),
        { title: LOCAL_S4_CURRENT_PIECE_MARKER },
      ),
    ),
  );
  const crossFellowReset = await resetS4Fixtures();
  const crossFellowProblemId = "P-s4-cross-fellow-frontier";
  const crossFellowSeedWorkshop = await pushWorkshop(
    crossFellowProblemId,
    `${privateCanary}-s4-cross-fellow-seed`,
    {
      [localS4FellowAuthorityHeader]: localAuthorityToken,
      [localS4FellowIdHeader]: "fixture-fellow-a",
    },
  );
  const crossFellowCurrentWorkshop = await pushWorkshop(
    crossFellowProblemId,
    `${privateCanary}-s4-cross-fellow-current`,
    {
      [localS4FellowAuthorityHeader]: localAuthorityToken,
      [localS4FellowIdHeader]: "fixture-fellow-b",
    },
  );
  const crossFellowSeed = await snapshot(
    await localFetch(
      `${origin}/__s3/promote`,
      promotionRequest(
        recordField(crossFellowSeedWorkshop.body, "workshop_id") ?? "",
        "S4 cross-fellow frontier seed statement.",
        "S4 cross-fellow frontier seed artifact.",
        {},
        s4FixtureHeaders("s4-cross-fellow-seed"),
        { title: LOCAL_S4_HISTORY_PIECE_MARKER },
      ),
    ),
  );
  const crossFellowCurrent = await snapshot(
    await localFetch(
      `${origin}/__s3/promote`,
      promotionRequest(
        recordField(crossFellowCurrentWorkshop.body, "workshop_id") ?? "",
        "S4 cross-fellow frontier current statement.",
        "S4 cross-fellow frontier current artifact.",
        {},
        s4FixtureHeaders("s4-cross-fellow-current"),
        { title: LOCAL_S4_CURRENT_PIECE_MARKER },
      ),
    ),
  );
  check(
    "S4_frontier_receipts_revalidate_same_fellow_history_but_do_not_spuriously_invalidate_another_fellow",
    sameFellowReset.response.status === 204 &&
      sameFellowSeed.response.status === 201 &&
      sameFellowCurrent.response.status === 202 &&
      crossFellowReset.response.status === 204 &&
      crossFellowSeed.response.status === 201 &&
      crossFellowCurrent.response.status === 201,
    `same ${sameFellowSeed.response.status}/${sameFellowCurrent.response.status} cross ${crossFellowSeed.response.status}/${crossFellowCurrent.response.status}`,
  );

  const oversizedHistoryProblemId = "P-s4-oversized-history";
  const oversizedHistorySeedDenied = await snapshot(
    await localFetch(`${origin}/__s3/s4/fixtures/oversized-history/${oversizedHistoryProblemId}`, {
      method: "POST",
      headers: { [localS4FixtureAuthorityHeader]: localReadinessNonce },
    }),
  );
  const oversizedHistorySeed = await snapshot(
    await localFetch(`${origin}/__s3/s4/fixtures/oversized-history/${oversizedHistoryProblemId}`, {
      method: "POST",
      headers: { [localS4FixtureAuthorityHeader]: localAuthorityToken },
    }),
  );
  const oversizedHistoryWorkshop = await pushWorkshop(
    oversizedHistoryProblemId,
    `${privateCanary}-s4-oversized-history-current`,
  );
  const oversizedHistoryPromotion = await snapshot(
    await localFetch(
      `${origin}/__s3/promote`,
      promotionRequest(
        recordField(oversizedHistoryWorkshop.body, "workshop_id") ?? "",
        "S4 later benign statement after oversized history.",
        "S4 later benign artifact after oversized history.",
        {},
        s4FixtureHeaders("s4-oversized-history-current"),
      ),
    ),
  );
  const oversizedHistoryDiagnostics = await requestJson(
    `/__s3/s4/diagnostics/${oversizedHistoryProblemId}`,
    { headers: { [localS4FixtureAuthorityHeader]: localAuthorityToken } },
  );
  const oversizedHistoryReceipts = Array.isArray(oversizedHistoryDiagnostics.body.receipts)
    ? oversizedHistoryDiagnostics.body.receipts
    : [];
  const oversizedHistoryReceipt = oversizedHistoryReceipts[0];
  const oversizedHistoryOmissions =
    oversizedHistoryReceipt !== null && typeof oversizedHistoryReceipt === "object"
      ? numberField(oversizedHistoryReceipt as Record<string, unknown>, "context_omission_count")
      : undefined;
  check(
    "S4_oversized_historical_artifact_is_omitted_before_materialization_and_later_benign_promotion_records_the_exact_omission",
    oversizedHistorySeedDenied.response.status === 404 &&
      oversizedHistorySeed.response.status === 201 &&
      oversizedHistoryWorkshop.response.status === 201 &&
      oversizedHistoryPromotion.response.status === 201 &&
      oversizedHistoryDiagnostics.response.status === 200 &&
      oversizedHistoryReceipts.length === 1 &&
      oversizedHistoryOmissions === 1,
    `seed ${oversizedHistorySeedDenied.response.status}/${oversizedHistorySeed.response.status} promotion ${oversizedHistoryPromotion.response.status} omissions ${String(oversizedHistoryOmissions)}`,
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
