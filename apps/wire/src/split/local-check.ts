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
  phase: "pre_promotion" | "post_promotion",
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
      ]),
    `status ${privateByDigestBeforePromotion.response.status}`,
  );

  const anonymousPrivate = await snapshot(await localFetch(`${origin}/__s3/private/${workshopId}`));
  check(
    "anonymous_private_read_is_not_found_without_a_private_cache_entry",
    anonymousPrivate.response.status === 404 &&
      anonymousPrivate.response.headers.get("cache-control") === "no-store" &&
      hasNoPrivateMaterial(anonymousPrivate, [privateCanary, workshopId, privateDigest]),
    `status ${anonymousPrivate.response.status}`,
  );
  const ownerPrivate = await snapshot(
    await localFetch(`${origin}/__s3/private/${workshopId}`, {
      headers: { "x-asimp-local-sponsor": "local-sponsor" },
    }),
  );
  check(
    "owner_private_read_crosses_R2_and_revalidates_the_D1_binding",
    ownerPrivate.response.status === 200 &&
      ownerPrivate.response.headers.get("cache-control") === "private, no-store" &&
      ownerPrivate.body === privateCanary,
    `status ${ownerPrivate.response.status}`,
  );

  const forbiddenMain = [privateCanary, workshopId, privateDigest];
  const preFaces = await assertFaceSet(mainProblemId, forbiddenMain, "pre_promotion");
  const crossValidator = await snapshot(
    await localFetch(`${origin}/__s3/public/${mainProblemId}?format=md`, {
      headers: { "if-none-match": preFaces.find((face) => face.format === "json")?.etag ?? "" },
    }),
  );
  check(
    "a_different_representation_validator_cannot_304_the_markdown_face",
    crossValidator.response.status === 200 &&
      crossValidator.body.length > 0 &&
      hasNoPrivateMaterial(crossValidator, forbiddenMain),
    `status ${crossValidator.response.status}`,
  );

  const publicError = await snapshot(
    await localFetch(
      `${origin}/__s3/public/${mainProblemId}?format=${encodeURIComponent(privateCanary)}`,
    ),
  );
  const preSearch = await snapshot(
    await localFetch(
      `${origin}/__s3/public/${mainProblemId}/search?q=${encodeURIComponent(privateCanary)}`,
    ),
  );
  const preExport = await snapshot(
    await localFetch(`${origin}/__s3/public/${mainProblemId}/export.jsonl`),
  );
  check(
    "public_errors_search_and_export_never_reflect_private_probe_material",
    publicError.response.status === 400 &&
      preSearch.response.status === 200 &&
      preExport.response.status === 200 &&
      hasNoPrivateMaterial(publicError, forbiddenMain) &&
      hasNoPrivateMaterial(preSearch, forbiddenMain) &&
      hasNoPrivateMaterial(preExport, forbiddenMain),
    "a public error, search, or export reflected private material",
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
  check(
    "post_promotion_public_search_and_export_contain_only_the_public_event",
    postSearch.response.status === 200 &&
      postExport.response.status === 200 &&
      postSearch.body.includes(publicStatement) &&
      postExport.body.includes(publicStatement) &&
      hasNoPrivateMaterial(postSearch, forbiddenMain) &&
      hasNoPrivateMaterial(postExport, forbiddenMain),
    "a post-promotion public search or export contained private material",
  );

  const postFaces = await assertFaceSet(mainProblemId, forbiddenMain, "post_promotion");
  check(
    "every_empty_pre_promotion_face_validator_changes_after_the_public_event",
    postFaces.every((after) => {
      const before = preFaces.find((face) => face.format === after.format);
      return (
        before !== undefined && before.etag !== after.etag && after.body.includes(publicStatement)
      );
    }),
    "a face validator did not change with the public projection",
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
    publicStatement,
    "An unpublished artifact accompanying a duplicate claim.",
  );
  check(
    "near_duplicate_promotion_is_refused_citing_P11_without_a_cursor_burn",
    duplicateWorkshop.response.status === 201 &&
      duplicateClaim.response.status === 409 &&
      duplicateClaim.body.code === "DUPLICATE_CLAIM" &&
      duplicateClaim.body.rule === "P11",
    `status ${duplicateClaim.response.status}`,
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
    p2Workshop.response.status === 201 &&
      p2Refusal.response.status === 422 &&
      p2Refusal.body.code === "SCHEMA_INVALID" &&
      p2Refusal.body.rule === "P2/P4",
    `status ${p2Refusal.response.status} code ${String(p2Refusal.body.code)} rule ${String(p2Refusal.body.rule)}`,
  );

  const recoveryProblem = "P-s3-recovery";
  const recoveryBody = `${privateCanary}-r2-before-d1-failure`;
  const recoveryDigest = await sha256Hex(recoveryBody);
  const failedBind = await pushWorkshop(recoveryProblem, recoveryBody, {
    "x-asimp-local-test-fault": "d1-bind-reject",
  });
  const orphanAudit = await requestJson(`/__s3/recovery/sha256/${recoveryDigest}`, {
    headers: { "x-asimp-local-recovery-audit": "local-recovery-audit" },
  });
  const failedArtifactProbe = await snapshot(
    await localFetch(`${origin}/sha256/${recoveryDigest}`),
  );
  const recoveredBind = await pushWorkshop(recoveryProblem, recoveryBody);
  const recoveredAudit = await requestJson(`/__s3/recovery/sha256/${recoveryDigest}`, {
    headers: { "x-asimp-local-recovery-audit": "local-recovery-audit" },
  });
  check(
    "R2_put_then_D1_failure_leaves_an_unreachable_orphan_and_retry_binds_without_a_cursor_burn",
    failedBind.response.status === 503 &&
      failedBind.body.code === "PRIVATE_CAS_RECOVERY_REQUIRED" &&
      orphanAudit.body.state === "unbound_private_r2_object" &&
      failedArtifactProbe.response.status === 404 &&
      hasNoPrivateMaterial(failedArtifactProbe, [recoveryBody, recoveryDigest]) &&
      recoveredBind.response.status === 201 &&
      recoveredBind.body.workshop_id === "W-local-fellow-4" &&
      recoveredBind.body.workshop_seq === 1 &&
      recoveredAudit.body.state === "d1_bound",
    `failure ${failedBind.response.status}/${String(failedBind.body.code)} orphan ${String(orphanAudit.body.state)} retry ${recoveredBind.response.status}/${String(recoveredBind.body.workshop_seq)} recovery ${String(recoveredAudit.body.state)}`,
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
