import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  AdminQuarantineCaseDetailSchema,
  AdminQuarantineDecisionResponseSchema,
  AdminQuarantineQueueResponseSchema,
  FellowTokenSchema,
  InboxResponseSchema,
  ProblemPublicationPreviewSchema,
} from "@asimposium/contracts";
import {
  ArtifactPublicationReceiptSchema,
  ArtifactPublicationRetryReceiptSchema,
  ArtifactPublicationStatusSchema,
  EvidenceArtifactsSchema,
  PublicArtifactManifestSchema,
} from "@asimposium/contracts/artifact-publications";
import {
  ARTIFACT_PART_SIZE_BYTES,
  ArtifactDeclareResponseSchema,
  ArtifactInventoryResponseSchema,
  ArtifactRenewResponseSchema,
  ArtifactResumeResponseSchema,
  ArtifactStatusResponseSchema,
} from "@asimposium/contracts/artifact-uploads";
import { createTestHarness } from "wrangler";
import { mintServiceEnvelope, serviceEnvelopeHeaders } from "../../../web/lib/service-envelope.ts";
import { assertLedgerTriggersRefuse } from "./trigger-probes.mjs";

assert.equal(process.versions.bun, undefined, "This lane requires genuine Node");
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const origin = "https://a-staging.asimposium.org";
const agoraOrigin = "https://staging.asimposium.org";
const userAgent = "asimposium.org-agent (+https://github.com/Dicklesworthstone/asimposium.org)";
const operatorId = "usr_artifact_operator";

const signingKeys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
const keyId = "artifact-local-sponsor";
const publicKeyHex = Buffer.from(
  await crypto.subtle.exportKey("raw", signingKeys.publicKey),
).toString("hex");

const signingConfig = {
  accountId: "0123456789abcdef0123456789abcdef",
  bucket: "asimposium-artifacts-staging",
  accessKeyId: "0123456789ABCDEF0123456789ABCDEF",
  secretAccessKey: "c".repeat(64),
  sponsorDailyBytes: 1073741824,
  fellowDailyManifests: 100,
};

function createLocalArtifactWorkerHarness() {
  return createTestHarness({
    root,
    workers: [
      {
        secrets: {
          SERVICE_ENVELOPE_KEYS: JSON.stringify([{ kid: keyId, publicKeyHex, notBefore: 0 }]),
          ARTIFACT_UPLOAD_SIGNING: JSON.stringify(signingConfig),
        },
        config: {
          name: "asimposium-artifact-proof",
          main: `${root}/apps/wire/test/integration/discovery-local-worker.ts`,
          compatibility_date: "2026-08-13",
          compatibility_flags: ["nodejs_compat"],
          d1_databases: [
            {
              binding: "DB",
              database_name: "artifact-proof",
              database_id: "00000000-0000-0000-0000-000000000000",
              migrations_dir: `${root}/db/migrations`,
            },
          ],
          r2_buckets: [
            { binding: "ARTIFACTS", bucket_name: "artifact-private" },
            { binding: "PUBLIC_ARTIFACTS", bucket_name: "artifact-public" },
          ],
          durable_objects: {
            bindings: [{ name: "KRATER_OUTBOX", class_name: "KraterOutboxDrainer" }],
          },
          exports: { KraterOutboxDrainer: { type: "durable-object", storage: "sqlite" } },
          rules: [{ type: "Text", globs: ["**/*.md", "**/*.txt"], fallthrough: true }],
          vars: {
            STOA_ORIGIN: origin,
            AGORA_ORIGIN: agoraOrigin,
            SPONSOR_PROMOTION_RATE_LIMIT: "100",
            OPERATOR_PRINCIPAL_IDS: operatorId,
            ENROLLMENT_REPLAY_KEY: Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString(
              "base64url",
            ),
          },
        },
      },
    ],
  });
}

const server = createLocalArtifactWorkerHarness();
try {
  await server.listen();
  console.log(JSON.stringify({ stage: "workerd-started" }));
  const worker = server.getWorker();
  await worker.applyD1Migrations("DB");
  console.log(JSON.stringify({ stage: "d1-migrated" }));

  const fixtures = await worker.getExport();
  let key = 0;

  async function call(path, body, token, expected = 200, idempotencyKey, extraHeaders = {}) {
    const response = await worker.fetch(`${origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "User-Agent": userAgent,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined
          ? {}
          : {
              "content-type": "application/json",
              "idempotency-key": idempotencyKey ?? `artifact-key-${++key}`,
            }),
        ...extraHeaders,
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });

    const raw = await response.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }

    if (expected !== null && expected !== undefined) {
      const code = typeof data === "object" && data !== null ? data.code : undefined;
      assert.equal(
        response.status,
        expected,
        `${path}: status=${response.status} expected=${expected} code=${code ?? "raw"} body=${String(raw).slice(0, 200)}`,
      );
    }
    return { status: response.status, data, headers: response.headers, raw };
  }

  async function uploadPart(path, bytes, token, expected = 200) {
    const response = await worker.fetch(`${origin}${path}`, {
      method: "PUT",
      headers: {
        "User-Agent": userAgent,
        authorization: `Bearer ${token}`,
        "content-type": "application/octet-stream",
        "idempotency-key": `private-part-${++key}`,
      },
      body: new Uint8Array(bytes),
    });
    const data = await response.json();
    assert.equal(
      response.status,
      expected,
      `${path}: expected=${expected} code=${data.code ?? "part"}`,
    );
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    return data;
  }

  async function sponsorCall(
    sponsorId,
    method,
    path,
    action,
    body,
    expected = 200,
    route = path,
    idempotencyKey,
    principalType = "sponsor",
  ) {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const envelope = await mintServiceEnvelope({
      privateKey: signingKeys.privateKey,
      kid: keyId,
      now: Math.floor(Date.now() / 1000),
      method,
      route,
      action,
      principalType,
      principalId: sponsorId,
      body: raw,
    });
    const response = await worker.fetch(`${origin}${path}`, {
      method,
      headers: {
        ...serviceEnvelopeHeaders(envelope),
        "User-Agent": userAgent,
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      ...(body === undefined ? {} : { body: raw }),
    });
    const resultRaw = await response.text();
    let data;
    try {
      data = JSON.parse(resultRaw);
    } catch {
      data = resultRaw;
    }
    if (expected !== null && expected !== undefined) {
      assert.equal(
        response.status,
        expected,
        `${path}: status=${response.status} expected=${expected}`,
      );
    }
    return { status: response.status, data, headers: response.headers, raw: resultRaw };
  }

  const operatorCall = (method, path, action, body, expected = 200, route = path) =>
    sponsorCall(
      operatorId,
      method,
      path,
      action,
      body,
      expected,
      route,
      method === "POST" ? `artifact-operator-${++key}` : undefined,
      "operator",
    );

  const discovery = (await call("/openapi.json")).data;
  function discoveredRequest(property) {
    const matches = Object.entries(discovery.paths).filter(([, methods]) =>
      methods.post?.requestBody?.content?.["application/json"]?.schema?.$ref?.endsWith(
        `/properties/${property}`,
      ),
    );
    assert.ok(matches.length > 0, `Missing published request schema: ${property}`);
    const [path] = matches[0];
    return path;
  }

  async function enroll(
    name,
    sponsor = "usr_sponsor_artifacts",
    scopes = ["promote", "review", "propose-problems", "upload-artifacts"],
  ) {
    const minted = await fixtures.mint(sponsor, scopes);
    const claimed = await call(
      discoveredRequest("fellow_registration_request"),
      {
        enrollment_id: minted.enrollmentId,
        secret: minted.secret,
        name,
        model: "synthetic-artifact-model",
        harness: "local-artifact-proof",
      },
      undefined,
      202,
    );
    await fixtures.approve(sponsor, minted.enrollmentId);
    const issued = await call(discoveredRequest("flow_poll_request"), {
      flow_handle: claimed.data.flow_handle,
    });
    assert.equal(typeof issued.data.token, "string");
    return issued.data.token;
  }

  // 1. Setup actors
  const sponsorA = "usr_artifact_sponsor_a";
  const authorTokenA = await enroll("art-author-a", sponsorA);
  const helloA = await call("/v1/hello", undefined, authorTokenA);
  const fellowIdA = helloA.data.fellow.fellow_id;

  const sponsorB = "usr_artifact_sponsor_b";
  const reviewerTokenB = await enroll("art-reviewer-b", sponsorB);
  const helloB = await call("/v1/hello", undefined, reviewerTokenB);
  const fellowIdB = helloB.data.fellow.fellow_id;

  assert.notEqual(fellowIdA, fellowIdB, "Author and Reviewer must be distinct Fellows");

  // 2. Propose, publish, and activate problem P-1
  const createdProblem = await call(
    "/v1/problems",
    {
      title: "Artifact Pipeline Real Bindings Test Problem",
      statement:
        "Every verified computation artifact has deterministic content-addressed integrity.",
      falsifier:
        "A verified computation artifact whose bytes diverge from its declared content digest.",
      motivation:
        "End-to-end verification of W6.9 and W2.7 artifact upload, completion, and publication.",
      areas: ["number-theory"],
    },
    authorTokenA,
    201,
  );
  const problemId = createdProblem.data.problem.id;

  const publicationPreview = await sponsorCall(
    sponsorA,
    "GET",
    `/v1/sponsors/problems/${problemId}/publication-preview`,
    "problem-publication-preview",
  );
  const reviewed = ProblemPublicationPreviewSchema.parse(publicationPreview.data);
  assert.equal(reviewed.acting_sponsor_id, sponsorA);
  assert.equal(reviewed.problem.id, problemId);
  await sponsorCall(
    sponsorA,
    "POST",
    `/v1/sponsors/problems/${problemId}/lifecycle`,
    "problem-lifecycle",
    {
      action: "publish",
      reviewed_statement_version: reviewed.problem.current_statement_version,
      reviewed_digest: reviewed.review_digest,
    },
    200,
    `/v1/sponsors/problems/${problemId}/lifecycle`,
    "publish-art-problem",
  );

  // Unlock problem via statement review
  const revSession = await call(
    "/v1/sessions",
    { problem_id: problemId, intent: "review" },
    reviewerTokenB,
    201,
  );
  await call(
    `/v1/problems/${problemId}/statement-review`,
    {
      session_id: revSession.data.session_id,
      statement_version: 1,
      verdict: "statement-clear",
      basis: "Problem is clearly falsifiable and computationally checkable.",
    },
    reviewerTokenB,
    200,
  );
  await call(
    `/v1/sessions/${revSession.data.session_id}/close`,
    {
      handback: "Statement review approved.",
      promote: [],
      keep: [],
      discard: [],
    },
    reviewerTokenB,
    201,
  );

  // 3. Open working session for Author Fellow A
  const sessionA = await call(
    "/v1/sessions",
    { problem_id: problemId, intent: "prove" },
    authorTokenA,
    201,
  );
  const sessionIdA = sessionA.data.session_id;

  // 4. Private Artifact Upload (W6.9 / W2.7) - Declaration
  const textContent = "theorem artifact_integrity_verified : True := by trivial\n";
  const textBytes = new TextEncoder().encode(textContent);
  const textSha256 = createHash("sha256").update(textBytes).digest("hex");
  const textSize = textBytes.length;

  const declRes = await call(
    "/v1/artifacts",
    {
      session_id: sessionIdA,
      sha256: textSha256,
      size_bytes: textSize,
      encoding: "text",
    },
    authorTokenA,
    201,
    "key-art-decl-1",
  );
  const uploadReceipt = ArtifactDeclareResponseSchema.parse(declRes.data);
  const uploadId = uploadReceipt.upload_id;

  assert.equal(uploadReceipt.sha256, textSha256);
  assert.equal(uploadReceipt.size_bytes, textSize);
  assert.equal(uploadReceipt.storage, "private");
  assert.equal(uploadReceipt.put.method, "PUT");
  assert.ok(uploadReceipt.put.url.includes("asimposium-artifacts-staging"));
  assert.equal(uploadReceipt.put.headers["content-type"], "application/octet-stream");
  assert.equal(uploadReceipt.put.headers["if-none-match"], "*");
  assert.equal(uploadReceipt.complete_path, `/v1/artifacts/${uploadId}/complete`);
  assert.equal(uploadReceipt.status_path, `/v1/artifacts/${uploadId}`);
  assert.equal(uploadReceipt.renew_path, `/v1/artifacts/${uploadId}/renew`);
  assert.equal(declRes.headers.get("cache-control"), "private, no-store");

  // 5. Idempotency Replay on Declaration
  const replayDecl = await call(
    "/v1/artifacts",
    {
      session_id: sessionIdA,
      sha256: textSha256,
      size_bytes: textSize,
      encoding: "text",
    },
    authorTokenA,
    201,
    "key-art-decl-1",
  );
  assert.equal(replayDecl.data.upload_id, uploadId);
  assert.equal(replayDecl.data.put.url, uploadReceipt.put.url);

  // 6. Idempotency Conflict & Schema Validation
  await call(
    "/v1/artifacts",
    {
      session_id: sessionIdA,
      sha256: textSha256,
      size_bytes: textSize + 1,
      encoding: "text",
    },
    authorTokenA,
    409,
    "key-art-decl-1",
  );

  await call(
    "/v1/artifacts",
    {
      session_id: sessionIdA,
      sha256: "INVALID_UPPERCASE_HASH",
      size_bytes: textSize,
      encoding: "text",
    },
    authorTokenA,
    422,
  );

  await call(
    "/v1/artifacts?extra=query_param",
    {
      session_id: sessionIdA,
      sha256: textSha256,
      size_bytes: textSize,
      encoding: "text",
    },
    authorTokenA,
    400,
  );

  // 7. Premature Completion & Body Validation
  await call(uploadReceipt.complete_path, {}, authorTokenA, 409, "key-comp-early");

  await call(
    uploadReceipt.complete_path,
    { invalid_fields_not_empty: true },
    authorTokenA,
    422,
    "key-comp-bad-shape",
  );

  // Expired PUT continuation goes through the production Request/D1 path.
  // The fixture clock avoids a fifteen-minute wait; it never bypasses auth,
  // changes the manifest deadline, or substitutes for a real R2 binding.
  const reservationBeforeRenewal = await fixtures.artifactReservationSummary(fellowIdA);
  let renewedReceipt;
  await fixtures.setArtifactClock(uploadReceipt.put.expires_at + 1000);
  try {
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        call(uploadReceipt.renew_path, {}, authorTokenA, 200, "key-art-renew-1"),
      ),
    );
    renewedReceipt = ArtifactRenewResponseSchema.parse(responses[0].data);
    for (const response of responses) {
      assert.deepEqual(ArtifactRenewResponseSchema.parse(response.data), renewedReceipt);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
    }
    assert.equal(renewedReceipt.upload_id, uploadId);
    assert.equal(renewedReceipt.created_at, uploadReceipt.created_at);
    assert.equal(renewedReceipt.expires_at, uploadReceipt.expires_at);
    assert.equal(renewedReceipt.sha256, uploadReceipt.sha256);
    assert.equal(renewedReceipt.size_bytes, uploadReceipt.size_bytes);
    assert.notEqual(renewedReceipt.put.url, uploadReceipt.put.url);
    assert.ok(renewedReceipt.put.expires_at > uploadReceipt.put.expires_at);
    assert.deepEqual(renewedReceipt.put.headers, uploadReceipt.put.headers);
    const reservationAfterRenewal = await fixtures.artifactReservationSummary(fellowIdA);
    assert.ok(reservationBeforeRenewal !== null && reservationAfterRenewal !== null);
    // Workerd RPC results are proxies; compare the returned scalar counters.
    assert.equal(reservationAfterRenewal.manifests, reservationBeforeRenewal.manifests);
    assert.equal(reservationAfterRenewal.bytes, reservationBeforeRenewal.bytes);
    assert.equal(reservationAfterRenewal.renewals, reservationBeforeRenewal.renewals + 1);

    await call(uploadReceipt.renew_path, {}, reviewerTokenB, 401, "cross-sponsor-renewal");
    await call(uploadReceipt.renew_path, {}, undefined, 401, "anonymous-renewal");
    await call(uploadReceipt.renew_path, { offset: 10 }, authorTokenA, 422, "range-renewal");
    const pending = await call(uploadReceipt.status_path, undefined, authorTokenA, 200);
    assert.equal(pending.data.state, "presigned");
    assert.equal(pending.data.put, undefined);
    assert.equal(await fixtures.readPublicCas(textSha256), null);
  } finally {
    await fixtures.setArtifactClock(null);
  }
  const replayRenewal = await call(
    uploadReceipt.renew_path,
    {},
    authorTokenA,
    200,
    "key-art-renew-1",
  );
  assert.deepEqual(ArtifactRenewResponseSchema.parse(replayRenewal.data), renewedReceipt);
  const immutableDeclaration = await call(
    "/v1/artifacts",
    {
      session_id: sessionIdA,
      sha256: textSha256,
      size_bytes: textSize,
      encoding: "text",
    },
    authorTokenA,
    201,
    "key-art-decl-1",
  );
  assert.deepEqual(immutableDeclaration.data, uploadReceipt);

  // 8. Staging and Successful Verification
  // Upload through the production HTTP adapter into real private R2. The
  // same object is later published and bound to evidence below.
  const textResume = await call(uploadReceipt.resumable_path, {}, authorTokenA, 200, "resume-text");
  const textPart = textResume.data.resumable.remaining_parts[0];
  await uploadPart(textPart.path, textBytes, authorTokenA);
  await uploadPart(textPart.path, textBytes, authorTokenA);

  const completeRes = await call(uploadReceipt.complete_path, {}, authorTokenA, 200, "key-comp-1");
  const completeData = ArtifactStatusResponseSchema.parse(completeRes.data);
  assert.equal(completeData.state, "verified");
  assert.equal(completeData.verification, "bytes-only");
  assert.equal(completeData.content_path, `/v1/artifacts/${uploadId}/content`);
  assert.equal(completeData.content_type, "text/plain; charset=utf-8");

  // Verify bytes written to private CAS in real R2
  const casBytes = await fixtures.readPrivateCas(textSha256);
  assert.ok(casBytes !== null, "Bytes must be written to private CAS");
  assert.deepEqual(Buffer.from(casBytes), Buffer.from(textBytes));
  assert.equal(
    await fixtures.hasStagedArtifact(uploadId),
    false,
    "the staging copy must be discarded once the bytes are verified into the CAS",
  );

  // Completion replay returns identical metadata
  const compReplay = await call(uploadReceipt.complete_path, {}, authorTokenA, 200, "key-comp-1");
  assert.deepEqual(compReplay.data, completeData);
  await call(uploadReceipt.renew_path, {}, authorTokenA, 409, "key-renew-verified");

  // 9. Private Status & Content Retrieval
  const statusRes = await call(uploadReceipt.status_path, undefined, authorTokenA, 200);
  assert.deepEqual(statusRes.data, completeData);
  assert.equal(statusRes.data.put, undefined, "Status must never echo presigned PUT URL");

  // Authorized private download
  const downloadRes = await call(completeData.content_path, undefined, authorTokenA, 200);
  assert.equal(downloadRes.raw, textContent);
  assert.equal(downloadRes.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(
    downloadRes.headers.get("content-disposition"),
    `attachment; filename="${textSha256}.txt"`,
  );
  assert.equal(downloadRes.headers.get("content-security-policy"), "sandbox; default-src 'none'");
  assert.equal(downloadRes.headers.get("cache-control"), "private, no-store");
  assert.equal(downloadRes.headers.get("x-artifact-sha256"), textSha256);

  // Anonymous retrieval refused (401)
  await call(completeData.content_path, undefined, undefined, 401);

  // Cross-sponsor retrieval refused (401)
  await call(completeData.content_path, undefined, reviewerTokenB, 401);

  // Byte range request refused (400)
  await call(completeData.content_path, undefined, authorTokenA, 400, undefined, {
    range: "bytes=0-10",
  });

  // 10. Mismatch and Terminal Quarantine
  const decl2 = await call(
    "/v1/artifacts",
    {
      session_id: sessionIdA,
      sha256: createHash("sha256").update("intended_clean_data").digest("hex"),
      size_bytes: 20,
      encoding: "text",
    },
    authorTokenA,
    201,
    "key-art-decl-mismatch",
  );
  const uploadIdMismatch = decl2.data.upload_id;
  // Stage bytes with mismatched content
  await fixtures.stageArtifact(uploadIdMismatch, new TextEncoder().encode("wrong_corrupted_data!"));

  await call(decl2.data.complete_path, {}, authorTokenA, 422, "key-comp-mismatch");

  const statusMismatch = await call(decl2.data.status_path, undefined, authorTokenA, 200);
  assert.equal(statusMismatch.data.state, "quarantined");
  assert.equal(await fixtures.hasStagedArtifact(uploadIdMismatch), false);
  assert.equal(statusMismatch.data.content_path, null);

  // Quarantined upload cannot be downloaded
  await call(`/v1/artifacts/${uploadIdMismatch}/content`, undefined, authorTokenA, 401);

  await call(decl2.data.renew_path, {}, authorTokenA, 403, "key-renew-quarantined");

  // Expiry is a terminal manifest state, even when an older grant exists.
  const expiring = await call(
    "/v1/artifacts",
    {
      session_id: sessionIdA,
      sha256: textSha256,
      size_bytes: textSize,
      encoding: "text",
    },
    authorTokenA,
    201,
    "key-art-decl-expiry",
  );
  await call(expiring.data.renew_path, {}, authorTokenA, 409, "key-art-renew-1");
  const reservationBeforeExpiry = await fixtures.artifactReservationSummary(fellowIdA);
  await fixtures.setArtifactClock(expiring.data.expires_at);
  try {
    await call(expiring.data.renew_path, {}, authorTokenA, 410, "key-renew-expired");
    const expired = await call(expiring.data.status_path, undefined, authorTokenA, 200);
    assert.equal(expired.data.state, "expired");
    assert.equal(expired.data.put, undefined);
    assert.equal(expired.data.content_path, null);
    await call(`/v1/artifacts/${expiring.data.upload_id}/content`, undefined, authorTokenA, 401);
    const reservationAfterExpiry = await fixtures.artifactReservationSummary(fellowIdA);
    assert.ok(reservationBeforeExpiry !== null && reservationAfterExpiry !== null);
    assert.equal(reservationAfterExpiry.manifests, reservationBeforeExpiry.manifests);
    assert.equal(reservationAfterExpiry.bytes, reservationBeforeExpiry.bytes);
    assert.equal(reservationAfterExpiry.renewals, reservationBeforeExpiry.renewals);
  } finally {
    await fixtures.setArtifactClock(null);
  }

  // 10a. Same-size substitution: only a digest check can catch bytes of the
  //      declared length that are not the declared object (step 10 differs in
  //      size, so a size check alone would pass it).
  const intended = new TextEncoder().encode("intended lemma bytes, exact length\n");
  const substitute = new TextEncoder().encode("SUBSTITUTED lemma bytes, same len\n\n");
  assert.equal(substitute.length, intended.length);
  const declSame = await call(
    "/v1/artifacts",
    {
      session_id: sessionIdA,
      sha256: createHash("sha256").update(intended).digest("hex"),
      size_bytes: intended.length,
      encoding: "text",
    },
    authorTokenA,
    201,
    "key-art-decl-same-size",
  );
  await fixtures.stageArtifact(declSame.data.upload_id, substitute);
  await call(declSame.data.complete_path, {}, authorTokenA, 422, "key-comp-same-size");
  const statusSame = await call(declSame.data.status_path, undefined, authorTokenA, 200);
  assert.equal(statusSame.data.state, "quarantined", "same-size substituted bytes never verify");
  assert.equal(
    await fixtures.readPrivateCas(createHash("sha256").update(intended).digest("hex")),
    null,
    "substituted bytes never land under the declared hash",
  );

  // 10c. Archives and text are admitted from their observed bytes (rhg/y2t7):
  //      a well-formed USTAR+gzip Lake source tree verifies; a digest-correct
  //      expansion bomb and digest-correct invalid UTF-8 are quarantined, and
  //      neither lands in the CAS.
  const ustar = (members, compression) => {
    const blocks = [];
    for (const [name, body] of members) {
      const header = Buffer.alloc(512);
      header.write(name, 0, "utf8");
      header.write("0000644\0", 100);
      header.write("0000000\0", 108);
      header.write("0000000\0", 116);
      header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
      header.write("00000000000\0", 136);
      header.write("        ", 148);
      header.write("0", 156);
      header.write("ustar\0", 257);
      header.write("00", 263);
      const sum = header.reduce((total, byte) => total + byte, 0);
      header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
      blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
    }
    blocks.push(Buffer.alloc(1024));
    return gzipSync(Buffer.concat(blocks), compression);
  };
  const admit = async (bytes, encoding, key) => {
    const declared = await call(
      "/v1/artifacts",
      {
        session_id: sessionIdA,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size_bytes: bytes.length,
        encoding,
      },
      authorTokenA,
      201,
      `key-art-decl-${key}`,
    );
    await fixtures.stageArtifact(declared.data.upload_id, bytes);
    const completed = await call(
      declared.data.complete_path,
      {},
      authorTokenA,
      null,
      `key-comp-${key}`,
    );
    const status = await call(declared.data.status_path, undefined, authorTokenA, 200);
    const inCas = await fixtures.readPrivateCas(createHash("sha256").update(bytes).digest("hex"));
    return { completed, state: status.data.state, inCas: inCas !== null };
  };
  let lemma = "";
  for (let i = 0; lemma.length < 6000; i++)
    lemma += `theorem t${i} : ${createHash("sha256").update(String(i)).digest("hex").slice(0, 16)} = _ := rfl\n`;
  const lakeTree = ustar([
    ["lakefile.lean", Buffer.from("import Lake\nopen Lake DSL\npackage parity\n")],
    ["Parity.lean", Buffer.from(lemma)],
  ]);
  const goodArchive = await admit(lakeTree, "lake-archive", "lake-ok");
  assert.equal(goodArchive.state, "verified", "a well-formed Lake source archive verifies");
  assert.ok(goodArchive.inCas);

  // A genuinely interrupted upload resumes its missing range on the same
  // manifest. Stored DEFLATE keeps this valid source archive above 5 MiB.
  const resumableBytes = ustar(
    [
      ["First.lean", Buffer.alloc(3 * 1024 * 1024, "x")],
      ["Second.lean", Buffer.alloc(3 * 1024 * 1024, "y")],
    ],
    { level: 0 },
  );
  assert.ok(resumableBytes.length > ARTIFACT_PART_SIZE_BYTES);
  const resumeDigest = createHash("sha256").update(resumableBytes).digest("hex");
  const resumeDecl = ArtifactDeclareResponseSchema.parse(
    (
      await call(
        "/v1/artifacts",
        {
          session_id: sessionIdA,
          sha256: resumeDigest,
          size_bytes: resumableBytes.length,
          encoding: "lake-archive",
        },
        authorTokenA,
        201,
        "resumable-archive",
      )
    ).data,
  );
  const reservationBeforeParts = await fixtures.artifactReservationSummary(fellowIdA);
  const resumeBegin = ArtifactStatusResponseSchema.parse(
    (await call(resumeDecl.resumable_path, {}, authorTokenA, 200, "resume-archive")).data,
  );
  assert.equal(resumeBegin.resumable.total_parts, 2);
  await call(resumeDecl.status_path, undefined, reviewerTokenB, 401);
  await uploadPart(
    resumeBegin.resumable.remaining_parts[0].path,
    resumableBytes.subarray(0, 32),
    authorTokenA,
    422,
  );
  let resumeStatus = ArtifactStatusResponseSchema.parse(
    (await call(resumeDecl.status_path, undefined, authorTokenA)).data,
  );
  assert.equal(
    resumeStatus.resumable.uploaded_parts.length,
    0,
    "truncated bodies never acknowledge a range",
  );
  const lastPart = resumeBegin.resumable.remaining_parts[1];
  await uploadPart(lastPart.path, resumableBytes.subarray(lastPart.offset), authorTokenA);
  resumeStatus = ArtifactStatusResponseSchema.parse(
    (await call(resumeDecl.status_path, undefined, authorTokenA)).data,
  );
  assert.deepEqual(
    resumeStatus.resumable.uploaded_parts.map((part) => part.part_number),
    [2],
  );
  assert.deepEqual(
    resumeStatus.resumable.remaining_parts.map((part) => part.part_number),
    [1],
  );
  await call(resumeDecl.complete_path, {}, authorTokenA, 409, "resume-incomplete");
  const changedPart = new Uint8Array(resumableBytes.subarray(lastPart.offset));
  changedPart[0] ^= 1;
  await uploadPart(lastPart.path, changedPart, authorTokenA, 409);
  const remaining = resumeStatus.resumable.remaining_parts[0];
  await uploadPart(
    remaining.path,
    resumableBytes.subarray(remaining.offset, remaining.offset + remaining.size_bytes),
    authorTokenA,
  );
  const resumed = ArtifactStatusResponseSchema.parse(
    (await call(resumeDecl.complete_path, {}, authorTokenA, 200, "resume-complete")).data,
  );
  assert.equal(resumed.state, "verified");
  assert.deepEqual(resumed.resumable.remaining_parts, []);
  const resumedDownload = await worker.fetch(`${origin}${resumed.content_path}`, {
    headers: { "User-Agent": userAgent, authorization: `Bearer ${authorTokenA}` },
  });
  assert.equal(resumedDownload.status, 200);
  assert.deepEqual(Buffer.from(await resumedDownload.arrayBuffer()), resumableBytes);
  const reservationAfterParts = await fixtures.artifactReservationSummary(fellowIdA);
  assert.equal(reservationAfterParts.manifests, reservationBeforeParts.manifests);
  assert.equal(reservationAfterParts.bytes, reservationBeforeParts.bytes);
  assert.equal(reservationAfterParts.renewals, reservationBeforeParts.renewals);
  assert.equal(
    await fixtures.readPublicCas(resumeDigest),
    null,
    "resumed verification remains private",
  );
  console.log(
    JSON.stringify({
      stage: "resumable-artifact-parts",
      status: "pass",
      parts: 2,
      bytes: resumableBytes.length,
      single_reservation: true,
    }),
  );
  const bomb = ustar([["Bomb.lean", Buffer.alloc(4 * 1024 * 1024, "a")]]);
  assert.ok(bomb.length * 100 < 4 * 1024 * 1024, "the bomb exceeds the expansion ratio");
  const bombed = await admit(bomb, "lake-archive", "lake-bomb");
  assert.equal(bombed.state, "quarantined", "a digest-correct expansion bomb is quarantined");
  assert.equal(bombed.inCas, false, "a bomb never lands in the CAS");
  const notText = Buffer.from([0x70, 0x61, 0x72, 0xff, 0xfe, 0x69, 0x74, 0x79]);
  const binary = await admit(notText, "text", "text-invalid-utf8");
  assert.equal(binary.state, "quarantined", "invalid UTF-8 declared as text is quarantined");
  assert.equal(binary.inCas, false);

  // 10d. Boundary sizes (rhg): exactly the text cap verifies end to end; one
  //      byte more, or an archive past its cap, is refused at declaration
  //      with a teaching 422 and no upload grant.
  const atCap = Buffer.alloc(5 * 1024 * 1024, "a");
  const capped = await admit(atCap, "text", "text-at-cap");
  assert.equal(capped.state, "verified", "a text artifact of exactly 5 MiB verifies");
  for (const [encoding, size] of [
    ["text", 5 * 1024 * 1024 + 1],
    ["lake-archive", 20 * 1024 * 1024 + 1],
  ]) {
    const over = await call(
      "/v1/artifacts",
      {
        session_id: sessionIdA,
        sha256: createHash("sha256").update(`over-${encoding}`).digest("hex"),
        size_bytes: size,
        encoding,
      },
      authorTokenA,
      422,
      `key-art-decl-over-${encoding}`,
    );
    assert.equal(over.data.code, "SCHEMA_INVALID", `${encoding} over its cap is refused`);
    assert.ok(over.data.fix_hint, "the refusal teaches");
    assert.equal(over.data.put, undefined, "no upload grant is issued");
  }

  // 10b. Concurrent same-hash writers (y2t7): two Fellows under different
  //      sponsors upload identical bytes and complete at the same moment.
  //      Both verify, the CAS holds one correct object, and each Fellow can
  //      read only through its own upload.
  const sessionB = await call(
    "/v1/sessions",
    { problem_id: problemId, intent: "prove" },
    reviewerTokenB,
    201,
  );
  const sharedBytes = new TextEncoder().encode("shared lemma bytes for concurrent CAS writers\n");
  const sharedSha = createHash("sha256").update(sharedBytes).digest("hex");
  const declareShared = (token, sessionId, key) =>
    call(
      "/v1/artifacts",
      {
        session_id: sessionId,
        sha256: sharedSha,
        size_bytes: sharedBytes.length,
        encoding: "text",
      },
      token,
      201,
      key,
    );
  const sharedA = (await declareShared(authorTokenA, sessionIdA, "key-art-shared-a")).data;
  const sharedB = (
    await declareShared(reviewerTokenB, sessionB.data.session_id, "key-art-shared-b")
  ).data;
  assert.notEqual(sharedA.upload_id, sharedB.upload_id);
  await fixtures.stageArtifact(sharedA.upload_id, sharedBytes);
  await fixtures.stageArtifact(sharedB.upload_id, sharedBytes);
  const [doneA, doneB] = await Promise.all([
    call(sharedA.complete_path, {}, authorTokenA, 200, "key-comp-shared-a"),
    call(sharedB.complete_path, {}, reviewerTokenB, 200, "key-comp-shared-b"),
  ]);
  assert.equal(doneA.data.state, "verified");
  assert.equal(doneB.data.state, "verified");
  assert.deepEqual(Buffer.from(await fixtures.readPrivateCas(sharedSha)), Buffer.from(sharedBytes));
  assert.equal(
    (await call(doneA.data.content_path, undefined, authorTokenA, 200)).raw,
    new TextDecoder().decode(sharedBytes),
  );
  assert.equal(
    (await call(doneB.data.content_path, undefined, reviewerTokenB, 200)).raw,
    new TextDecoder().decode(sharedBytes),
  );
  await call(doneA.data.content_path, undefined, reviewerTokenB, 401);
  await call(doneB.data.content_path, undefined, authorTokenA, 401);

  // A lost receipt is recoverable through the authenticated owner directory.
  const recoveredUploads = [];
  let inventoryPath = "/v1/artifacts?limit=2";
  while (inventoryPath) {
    const response = await call(inventoryPath, undefined, authorTokenA, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const page = ArtifactInventoryResponseSchema.parse(response.data);
    assert.ok(page.items.length <= 2);
    assert.ok(!response.raw.includes(sharedB.upload_id));
    assert.ok(!response.raw.includes("X-Amz-"));
    assert.ok(!response.raw.includes("replay_ciphertext"));
    recoveredUploads.push(...page.items.map((item) => item.upload_id));
    inventoryPath = page.next_path;
  }
  assert.ok(recoveredUploads.includes(uploadId));
  assert.ok(recoveredUploads.includes(sharedA.upload_id));
  assert.equal(new Set(recoveredUploads).size, recoveredUploads.length);
  assert.deepEqual(recoveredUploads, [...recoveredUploads].sort());
  await call("/v1/artifacts", undefined, undefined, 401);
  await call("/v1/artifacts?limit=51", undefined, authorTokenA, 400);
  await call("/v1/artifacts?limit=1&limit=2", undefined, authorTokenA, 400);
  console.log(
    JSON.stringify({ stage: "private-artifact-inventory", recovered: recoveredUploads.length }),
  );

  // Credential issuance below is harness-migration fixture setup. Revocation,
  // session closure, inventory, resumption and byte work use the real HTTP path.
  const recoverySponsor = "usr_artifact_recovery_sponsor";
  const recoveryOriginalToken = await enroll("art-recovery-owner", recoverySponsor);
  const recoveryFellow = (await call("/v1/hello", undefined, recoveryOriginalToken)).data.fellow
    .fellow_id;
  const originalWork = (
    await call(
      "/v1/sessions",
      { problem_id: problemId, intent: "explore" },
      recoveryOriginalToken,
      201,
    )
  ).data.session_id;
  const recoveryDeclaration = {
    session_id: originalWork,
    sha256: resumeDigest,
    size_bytes: resumableBytes.length,
    encoding: "lake-archive",
  };
  const recoveryUpload = ArtifactDeclareResponseSchema.parse(
    (
      await call(
        "/v1/artifacts",
        recoveryDeclaration,
        recoveryOriginalToken,
        201,
        "recovery-declare",
      )
    ).data,
  );
  const recoveryStart = ArtifactStatusResponseSchema.parse(
    (await call(recoveryUpload.resumable_path, {}, recoveryOriginalToken)).data,
  );
  const recoveryFirst = recoveryStart.resumable.remaining_parts[0];
  await uploadPart(
    recoveryFirst.path,
    resumableBytes.subarray(recoveryFirst.offset, recoveryFirst.offset + recoveryFirst.size_bytes),
    recoveryOriginalToken,
  );
  const immutableUpload = (
    await fixtures.snapshotRows("artifact_uploads", "upload_id", recoveryUpload.upload_id)
  )[0];
  const immutablePart = (
    await fixtures.snapshotRows("artifact_upload_parts", "upload_id", recoveryUpload.upload_id)
  )[0];
  const recoveryReservation = await fixtures.artifactReservationSummary(recoveryFellow);
  await call(
    `/v1/sessions/${originalWork}/close`,
    {
      handback: "Retain the acknowledged artifact part for a replacement credential.",
      promote: [],
      keep: [],
      discard: [],
    },
    recoveryOriginalToken,
    201,
  );
  const originalCredential = (
    await fixtures.snapshotRows("fellow_tokens", "fellow_id", recoveryFellow)
  )[0];
  const replacementTokenId = `0${crypto.randomUUID().replaceAll("-", "").slice(0, 25).toUpperCase()}`;
  const replacementToken = FellowTokenSchema.parse(
    `asimp_ag_${replacementTokenId}_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`,
  );
  const replacementCredential = `cred-artifact-recovery-${crypto.randomUUID()}`;
  await fixtures.execRaw(
    `INSERT INTO fellow_tokens
    (credential_id, proposal_id, fellow_id, sponsor_id, token_hash, granted_scopes_json,
      granted_resources_json, issued_at, expires_at, credential_profile, credential_origin)
    SELECT ?, NULL, fellow_id, sponsor_id, ?, granted_scopes_json, granted_resources_json,
      ?, expires_at, 'bearer', 'harness-migration' FROM fellow_tokens WHERE credential_id = ?`,
    [
      replacementCredential,
      createHash("sha256").update(replacementToken).digest("hex"),
      Date.now(),
      originalCredential.credential_id,
    ],
  );
  await sponsorCall(
    recoverySponsor,
    "POST",
    "/v1/fellows/credentials/revoke",
    "fellow.credential.revoke",
    {
      fellow_id: recoveryFellow,
      credential_id: originalCredential.credential_id,
      confirm: "revoke-credential",
      step_up_authenticated_at: Math.floor(Date.now() / 1000),
    },
    200,
    "/v1/fellows/credentials/revoke",
    "recovery-revoke-original",
  );
  await call(recoveryUpload.status_path, undefined, recoveryOriginalToken, 401);
  const recoveredDirectory = ArtifactInventoryResponseSchema.parse(
    (await call("/v1/artifacts", undefined, replacementToken)).data,
  );
  assert.equal(recoveredDirectory.items.length, 1);
  assert.equal(recoveredDirectory.items[0].upload_id, recoveryUpload.upload_id);
  assert.equal(recoveredDirectory.items[0].original_session_id, originalWork);
  const replacementWork = (
    await call("/v1/sessions", { problem_id: problemId, intent: "explore" }, replacementToken, 201)
  ).data.session_id;
  const pendingRecovery = ArtifactStatusResponseSchema.parse(
    (await call(recoveryUpload.status_path, undefined, replacementToken)).data,
  );
  assert.equal(pendingRecovery.authorization.generation, 0);
  assert.deepEqual(
    pendingRecovery.resumable.uploaded_parts.map((part) => part.part_number),
    [1],
  );
  await call(recoveryUpload.complete_path, {}, replacementToken, 401);
  const resumeBody = {
    session_id: replacementWork,
    expected_generation: pendingRecovery.recovery.expected_generation,
  };
  await call(pendingRecovery.recovery.resume_path, resumeBody, reviewerTokenB, 401);
  const recovered = ArtifactResumeResponseSchema.parse(
    (
      await call(
        pendingRecovery.recovery.resume_path,
        resumeBody,
        replacementToken,
        200,
        "recover-session",
      )
    ).data,
  );
  assert.equal(recovered.generation, 1);
  assert.equal(recovered.expires_at, recoveryUpload.expires_at);
  assert.deepEqual(
    (
      await call(
        pendingRecovery.recovery.resume_path,
        resumeBody,
        replacementToken,
        200,
        "recover-session",
      )
    ).data,
    recovered,
  );
  await call(
    pendingRecovery.recovery.resume_path,
    resumeBody,
    replacementToken,
    409,
    "stale-generation",
  );
  await call("/v1/artifacts", recoveryDeclaration, replacementToken, 409, "recovery-declare");
  const recoveryMissing = pendingRecovery.resumable.remaining_parts[0];
  await uploadPart(
    recoveryMissing.path,
    resumableBytes.subarray(
      recoveryMissing.offset,
      recoveryMissing.offset + recoveryMissing.size_bytes,
    ),
    replacementToken,
  );
  const recoveredVerified = ArtifactStatusResponseSchema.parse(
    (await call(recoveryUpload.complete_path, {}, replacementToken)).data,
  );
  assert.equal(recoveredVerified.state, "verified");
  assert.equal(recoveredVerified.authorization.original_session_id, originalWork);
  assert.equal(recoveredVerified.authorization.session_id, replacementWork);
  assert.equal(recoveredVerified.recovery, null);
  const recoveredBytes = await worker.fetch(`${origin}${recoveredVerified.content_path}`, {
    headers: { "User-Agent": userAgent, authorization: `Bearer ${replacementToken}` },
  });
  assert.equal(recoveredBytes.status, 200);
  assert.deepEqual(Buffer.from(await recoveredBytes.arrayBuffer()), resumableBytes);
  const finalUpload = (
    await fixtures.snapshotRows("artifact_uploads", "upload_id", recoveryUpload.upload_id)
  )[0];
  for (const field of [
    "session_id",
    "credential_id",
    "fellow_id",
    "sponsor_id",
    "problem_id",
    "sha256",
    "size_bytes",
    "created_at",
    "expires_at",
    "put_expires_at",
    "key_hash",
    "request_digest",
    "replay_ciphertext",
    "replay_iv",
  ])
    assert.equal(finalUpload[field], immutableUpload[field], `recovery preserves ${field}`);
  const recoveredParts = await fixtures.snapshotRows(
    "artifact_upload_parts",
    "upload_id",
    recoveryUpload.upload_id,
  );
  assert.deepEqual(
    recoveredParts.find((part) => part.part_number === 1),
    immutablePart,
  );
  const replacementPart = recoveredParts.find((part) => part.part_number === 2);
  assert.equal(replacementPart.acknowledged_credential_id, replacementCredential);
  assert.equal(replacementPart.acknowledged_generation, 1);
  assert.deepEqual(await fixtures.artifactReservationSummary(recoveryFellow), recoveryReservation);
  assert.equal(await fixtures.readPublicCas(resumeDigest), null);
  console.log(
    JSON.stringify({
      stage: "artifact-session-credential-recovery",
      status: "pass",
      generation: 1,
      retained_parts: 1,
      single_reservation: true,
      original_provenance: true,
    }),
  );

  // 11. Secret / PII Screening Refusal (Rule P7)
  const probePrefix = ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ");
  const probeSuffix = ["-----END", "PRIVATE", "KEY-----"].join(" ");
  const probeContent = `${probePrefix}\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg...\n${probeSuffix}\n`;
  const probeBytes = new TextEncoder().encode(probeContent);
  const probeSha = createHash("sha256").update(probeBytes).digest("hex");

  const declSec = await call(
    "/v1/artifacts",
    {
      session_id: sessionIdA,
      sha256: probeSha,
      size_bytes: probeBytes.length,
      encoding: "text",
    },
    authorTokenA,
    201,
    "key-art-decl-sec",
  );
  const uploadIdSec = declSec.data.upload_id;
  await fixtures.stageArtifact(uploadIdSec, probeBytes);

  // Complete refuses secret content with 403 WRITE_REFUSED
  await call(declSec.data.complete_path, {}, authorTokenA, 403, "key-comp-sec");

  // 12. Evidence Submission & Artifact Publication (W6.9)
  // Create draft and promote claim
  const wsDraft = await call(
    `/v1/sessions/${sessionIdA}/workshop`,
    {
      type: "claim-draft",
      title: "Artifact Pipeline Claim Draft",
      body_md: "Draft claim for artifact verification.",
      relates_to: [],
    },
    authorTokenA,
    201,
  );
  const claimRes = await call(
    `/v1/sessions/${sessionIdA}/promote`,
    {
      workshop_id: wsDraft.data.workshop_id,
      kind: "conjecture",
      statement:
        "Every verified computation artifact has deterministic content-addressed integrity.",
      falsifier:
        "A verified computation artifact whose bytes diverge from its declared content digest.",
    },
    authorTokenA,
    201,
  );
  const claimId = claimRes.data.claim_id;

  // Publish warned evidence through the real writer. Artifact byte screening
  // below still uses its separate pass decision; these are distinct contexts.
  await fixtures.setScreenMode("allow-with-warning");
  const evRes = await call(
    `/v1/sessions/${sessionIdA}/evidence`,
    {
      bears_on_kind: "claim",
      bears_on_id: claimId,
      bears_on_version: 1,
      direction: "supports",
      kind: "argument",
      source: { kind: "model_memory" },
      mode: "confirmatory",
      body_md: "Model memory argument outlining the artifact verification theorem.",
    },
    authorTokenA,
    201,
  );
  await fixtures.setScreenMode("pass");
  const sourceEvidenceNotice = {
    category: "dual-use-boundary",
    action: "published-with-warning",
    notice: "screening-warning",
  };
  const evidenceId = evRes.data.evidence_id;
  const evidenceDigest = await fixtures.getEvidenceDigest(evidenceId);
  assert.ok(evidenceDigest, "Evidence digest must be found in ledger events");

  // Publish verified artifact
  const pubPayload = {
    session_id: sessionIdA,
    evidence_id: evidenceId,
    evidence_digest: evidenceDigest,
    publish: true,
    license: "CC-BY-4.0",
  };

  const pubRes = await call(
    `/v1/artifacts/${uploadId}/publish`,
    pubPayload,
    authorTokenA,
    202,
    "key-art-pub-1",
  );
  const pubReceipt = ArtifactPublicationReceiptSchema.parse(pubRes.data);
  const pubId = pubReceipt.publication_id;

  assert.equal(pubReceipt.initial_delivery, "queued");
  assert.equal(pubReceipt.verification, "bytes-only");
  assert.equal(pubReceipt.status_path, `/v1/artifact-publications/${pubId}`);

  // Publication idempotent replay
  const pubReplay = await call(
    `/v1/artifacts/${uploadId}/publish`,
    pubPayload,
    authorTokenA,
    202,
    "key-art-pub-1",
  );
  assert.equal(pubReplay.data.publication_id, pubId);

  // Publication conflict under same key
  await call(
    `/v1/artifacts/${uploadId}/publish`,
    { ...pubPayload, evidence_digest: `sha256:${"1".repeat(64)}` },
    authorTokenA,
    409,
    "key-art-pub-1",
  );

  // Cross-sponsor publication refusal (Reviewer B cannot publish Author A's upload)
  await call(
    `/v1/artifacts/${uploadId}/publish`,
    pubPayload,
    reviewerTokenB,
    404,
    "key-art-pub-cross",
  );

  // Quarantined upload cannot be published
  await call(
    `/v1/artifacts/${uploadIdMismatch}/publish`,
    pubPayload,
    authorTokenA,
    403,
    "key-art-pub-quarantined",
  );

  // 13. Delivery & Provenance Faces
  const pubStatusQueued = await call(
    `/v1/artifact-publications/${pubId}`,
    undefined,
    authorTokenA,
    200,
  );
  assert.equal(pubStatusQueued.data.delivery, "queued");

  // Deliver publication via real outbox delivery engine
  const deliverOutcome = await fixtures.deliverPublication(pubId, "pass");
  assert.equal(deliverOutcome, "published");

  // Status after delivery
  const pubStatusDone = await call(
    `/v1/artifact-publications/${pubId}`,
    undefined,
    authorTokenA,
    200,
  );
  assert.equal(pubStatusDone.data.delivery, "published");
  assert.equal(
    pubStatusDone.data.download_url,
    `https://artifacts-staging.asimposium.org/sha256/${textSha256}`,
  );

  // Verify bytes written to PUBLIC_ARTIFACTS CAS in real R2
  const publicBytes = await fixtures.readPublicCas(textSha256);
  assert.ok(publicBytes !== null, "Bytes must be copied to public CAS");
  assert.deepEqual(Buffer.from(publicBytes), Buffer.from(textBytes));

  // Public Manifest Face (Rule A1 Diptych)
  const manifestRes = await call(
    `/p/${problemId}/artifacts/${pubId}.json`,
    undefined,
    undefined,
    200,
  );
  const publicManifest = PublicArtifactManifestSchema.parse(manifestRes.data);
  assert.equal(publicManifest.publication_id, pubId);
  assert.equal(publicManifest.artifact.sha256, textSha256);
  assert.equal(publicManifest.artifact.size_bytes, textSize);
  assert.equal(publicManifest.license, "CC-BY-4.0");
  assert.equal(publicManifest.verification, "bytes-only");
  assert.equal(publicManifest.evidence.evidence_id, evidenceId);
  assert.deepEqual(publicManifest.evidence.screening_notice, sourceEvidenceNotice);
  assert.equal("screening_notice" in publicManifest.artifact, false);
  for (const field of ["input_digest", "configuration_digest", "model_version", "provenance_json"])
    assert.equal(manifestRes.raw.includes(field), false);
  assert.equal(
    publicManifest.artifact.download_url,
    `https://artifacts-staging.asimposium.org/sha256/${textSha256}`,
  );

  // Public Evidence Artifacts Listing Face
  const evArtifactsRes = await call(
    `/p/${problemId}/evidence/${evidenceId}/artifacts.json`,
    undefined,
    undefined,
    200,
  );
  const evArtifacts = EvidenceArtifactsSchema.parse(evArtifactsRes.data);
  assert.ok(evArtifacts.artifacts.length >= 1);
  assert.equal(evArtifacts.artifacts[0].publication_id, pubId);
  assert.equal(evArtifacts.artifacts[0].artifact.sha256, textSha256);
  assert.deepEqual(evArtifacts.artifacts[0].evidence.screening_notice, sourceEvidenceNotice);
  const manifestEtag = manifestRes.headers.get("etag");
  assert.ok(manifestEtag);
  assert.equal(
    (
      await call(pubReceipt.manifest_path, undefined, undefined, 304, undefined, {
        "if-none-match": manifestEtag,
      })
    ).raw,
    "",
  );

  // 14. Observer evidence publication uses the same production HTTP/D1/R2
  // path. Fixture setup supplies the roster role; no publication is injected.
  await fixtures.execRaw(
    "UPDATE problem_memberships SET role='observer' WHERE problem_id=? AND fellow_id=?",
    [problemId, fellowIdB],
  );
  const observerEvidence = (
    await call(
      `/v1/sessions/${sessionB.data.session_id}/evidence`,
      {
        bears_on_kind: "claim",
        bears_on_id: claimId,
        bears_on_version: 1,
        direction: "supports",
        kind: "argument",
        source: { kind: "model_memory" },
        mode: "confirmatory",
        body_md: "An observer records independently attributable reproducibility evidence.",
      },
      reviewerTokenB,
      201,
    )
  ).data;
  const observerEvidenceDigest = await fixtures.getEvidenceDigest(observerEvidence.evidence_id);
  assert.ok(observerEvidenceDigest);
  const observerPayload = {
    session_id: sessionB.data.session_id,
    evidence_id: observerEvidence.evidence_id,
    evidence_digest: observerEvidenceDigest,
    publish: true,
    license: "CC-BY-4.0",
  };
  await call(
    `/v1/artifacts/${sharedB.upload_id}/publish`,
    {
      ...pubPayload,
      session_id: sessionB.data.session_id,
    },
    reviewerTokenB,
    403,
    "observer-other-evidence",
  );
  const observerPublication = ArtifactPublicationReceiptSchema.parse(
    (
      await call(
        `/v1/artifacts/${sharedB.upload_id}/publish`,
        observerPayload,
        reviewerTokenB,
        202,
        "observer-own-publication",
      )
    ).data,
  );
  assert.equal(await fixtures.deliverPublication(observerPublication.publication_id), "published");
  const observerManifest = PublicArtifactManifestSchema.parse(
    (await call(observerPublication.manifest_path)).data,
  );
  assert.equal(observerManifest.author.fellow_id, fellowIdB);
  assert.equal(observerManifest.author.sponsor_id, sponsorB);
  assert.equal(observerManifest.evidence.evidence_id, observerEvidence.evidence_id);
  assert.deepEqual(Buffer.from(await fixtures.readPublicCas(sharedSha)), Buffer.from(sharedBytes));

  async function observerArtifact(text, label) {
    const bytes = new TextEncoder().encode(text);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const declaration = ArtifactDeclareResponseSchema.parse(
      (
        await call(
          "/v1/artifacts",
          {
            session_id: sessionB.data.session_id,
            sha256: digest,
            size_bytes: bytes.length,
            encoding: "text",
          },
          reviewerTokenB,
          201,
          `${label}-declare`,
        )
      ).data,
    );
    const status = ArtifactStatusResponseSchema.parse(
      (await call(declaration.resumable_path, {}, reviewerTokenB, 200, `${label}-resume`)).data,
    );
    await uploadPart(status.resumable.remaining_parts[0].path, bytes, reviewerTokenB);
    const complete = ArtifactStatusResponseSchema.parse(
      (await call(declaration.complete_path, {}, reviewerTokenB, 200, `${label}-complete`)).data,
    );
    assert.equal(complete.state, "verified");
    assert.equal(await fixtures.readPublicCas(digest), null);
    return { declaration, digest, bytes };
  }
  const visibilityRace = await observerArtifact(
    "theorem observer_visibility_release : True := by trivial\n",
    "observer-release-race",
  );
  const publicationAttempts = async () =>
    (
      await fixtures.snapshotRows("public_write_attempt_reservations", "fellow_id", fellowIdB)
    ).filter((row) => row.route === "artifact.publish").length;
  const sourceState = async (id) =>
    (await fixtures.snapshotRows("artifact_publication_jobs", "publication_id", id)).map(
      ({ state, screen_attempts, released_at, failure_code }) => ({
        state,
        screen_attempts,
        released_at,
        failure_code,
      }),
    );
  const attemptsBeforeHidden = await publicationAttempts();
  await fixtures.setArtifactSourceVisibility(problemId, claimId, "hidden");
  await call(pubReceipt.manifest_path, undefined, undefined, 404, undefined, {
    "if-none-match": manifestEtag,
  });
  await call(observerPublication.manifest_path, undefined, undefined, 404);
  await call(`/p/${problemId}/evidence/${evidenceId}/artifacts.json`, undefined, undefined, 404);
  await call(
    `/v1/artifacts/${visibilityRace.declaration.upload_id}/publish`,
    observerPayload,
    reviewerTokenB,
    404,
    "observer-hidden-request",
  );
  assert.equal(
    await publicationAttempts(),
    attemptsBeforeHidden,
    "a hidden target never reserves a publication screening attempt",
  );
  assert.deepEqual(
    Buffer.from(await fixtures.readPublicCas(textSha256)),
    Buffer.from(textBytes),
    "hiding a source withdraws its public reference without clawing back released bytes",
  );

  await fixtures.setArtifactSourceVisibility(problemId, claimId, "visible");
  assert.deepEqual((await call(pubReceipt.manifest_path)).data, manifestRes.data);
  const racingPublication = ArtifactPublicationReceiptSchema.parse(
    (
      await call(
        `/v1/artifacts/${visibilityRace.declaration.upload_id}/publish`,
        observerPayload,
        reviewerTokenB,
        202,
        "observer-release-request",
      )
    ).data,
  );
  assert.equal(
    await fixtures.deliverPublication(racingPublication.publication_id, "pass", claimId),
    "held",
  );
  assert.equal(
    await fixtures.readPublicCas(visibilityRace.digest),
    null,
    "visibility changing during a paid pass prevents any public R2 copy",
  );
  const racedJob = await sourceState(racingPublication.publication_id);
  assert.deepEqual(racedJob, [
    { state: "held", screen_attempts: 1, released_at: null, failure_code: "binding-unavailable" },
  ]);

  await fixtures.setArtifactSourceVisibility(problemId, claimId, "visible");
  const queuedSource = await observerArtifact(
    "theorem observer_visible_preflight : True := by trivial\n",
    "observer-preflight",
  );
  const queuedSourcePublication = ArtifactPublicationReceiptSchema.parse(
    (
      await call(
        `/v1/artifacts/${queuedSource.declaration.upload_id}/publish`,
        observerPayload,
        reviewerTokenB,
        202,
        "observer-preflight-request",
      )
    ).data,
  );
  await fixtures.setArtifactSourceVisibility(problemId, observerEvidence.evidence_id, "hidden");
  assert.equal(await fixtures.deliverPublication(queuedSourcePublication.publication_id), "held");
  assert.equal(await fixtures.readPublicCas(queuedSource.digest), null);
  assert.deepEqual(await sourceState(queuedSourcePublication.publication_id), [
    { state: "held", screen_attempts: 0, released_at: null, failure_code: "binding-unavailable" },
  ]);
  await call(observerPublication.manifest_path, undefined, undefined, 404);
  await call(
    `/p/${problemId}/evidence/${observerEvidence.evidence_id}/artifacts.json`,
    undefined,
    undefined,
    404,
  );
  await fixtures.setArtifactSourceVisibility(problemId, observerEvidence.evidence_id, "visible");
  assert.deepEqual((await call(observerPublication.manifest_path)).data, observerManifest);
  console.log(
    JSON.stringify({
      stage: "current-evidence-artifact-publication",
      pass: true,
      observer_publication: true,
      hidden_preflight_attempts: 0,
      hidden_during_screen: "held",
      restored_manifests: true,
      prior_released_bytes_retained: true,
    }),
  );

  // 15. Recover the existing held publications through the discovered API.
  // Recovery must retain the original consent, bytes, quota and paid attempts.
  const retryTemplate = discoveredRequest("retry_request");
  assert.equal(retryTemplate, "/v1/artifact-publications/{publicationId}/retry");
  const retryPath = (publication) =>
    retryTemplate.replace("{publicationId}", publication.publication_id);
  const publicationRows = async (table, publication) => {
    const rows = await fixtures.snapshotRows(table, "publication_id", publication.publication_id);
    if (table === "artifact_publication_retries")
      rows.sort((a, b) => a.retry_generation - b.retry_generation);
    else if (table.endsWith("_audit")) rows.sort((a, b) => a.seq - b.seq);
    return rows;
  };
  const recoveryStatus = async (publication) => {
    const response = await call(publication.status_path, undefined, reviewerTokenB);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    return ArtifactPublicationStatusSchema.parse(response.data);
  };
  const recoveryBody = (generation) => ({
    session_id: sessionB.data.session_id,
    expected_retry_generation: generation,
  });
  const recover = (publication, body, key, expected = 202, token = reviewerTokenB) =>
    call(retryPath(publication), body, token, expected, key);
  const recoverySnapshot = async (publication) => {
    const original = (await publicationRows("artifact_publications", publication))[0];
    assert.ok(original);
    return {
      original,
      requests: await fixtures.snapshotRows("artifact_publications", "fellow_id", fellowIdB),
      events: await fixtures.snapshotRows("events", "problem_id", problemId),
      eventContent: await fixtures.snapshotRows("event_content", "event_id", original.event_id),
      quota: await fixtures.snapshotRows(
        "public_write_attempt_reservations",
        "reservation_id",
        original.reservation_id,
      ),
      upload: await fixtures.snapshotRows("artifact_uploads", "upload_id", original.upload_id),
      jobs: await publicationRows("artifact_publication_jobs", publication),
      legacyAudit: await publicationRows("artifact_publication_audit", publication),
      retries: await publicationRows("artifact_publication_retries", publication),
      retryAudit: await publicationRows("artifact_publication_retry_audit", publication),
      reviews: await publicationRows("artifact_publication_reviews", publication),
      reviewReleases: await publicationRows("artifact_publication_review_releases", publication),
    };
  };
  const assertOriginalPublication = (before, after) => {
    for (const name of [
      "original",
      "requests",
      "events",
      "eventContent",
      "quota",
      "upload",
      "legacyAudit",
    ])
      assert.deepEqual(after[name], before[name], `recovery preserves ${name}`);
  };
  const withoutRecoveryEffect = async (publication, operation) => {
    const before = await recoverySnapshot(publication);
    const result = await operation();
    assert.deepEqual(
      await recoverySnapshot(publication),
      before,
      "refusal or replay cannot enqueue, screen or create audit",
    );
    return result;
  };
  const acceptRecovery = async (publication, generation, key) => {
    const status = await recoveryStatus(publication);
    assert.equal(status.delivery, "held");
    assert.deepEqual(status.recovery, {
      retry_path: retryPath(publication),
      expected_retry_generation: generation,
    });
    const before = await recoverySnapshot(publication);
    const body = recoveryBody(status.recovery.expected_retry_generation);
    const response = await recover(publication, body, key);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const receipt = ArtifactPublicationRetryReceiptSchema.parse(response.data);
    assert.equal(receipt.publication_id, publication.publication_id);
    assert.equal(receipt.problem_id, problemId);
    assert.equal(receipt.retry_generation, generation + 1);
    assert.equal(receipt.initial_delivery, "queued");
    assert.equal(receipt.status_path, publication.status_path);
    const after = await recoverySnapshot(publication);
    assertOriginalPublication(before, after);
    assert.equal(after.jobs[0].state, "queued");
    assert.equal(after.jobs[0].retry_generation, generation + 1);
    for (const name of ["attempts", "screen_attempts", "last_screen_json"])
      assert.deepEqual(after.jobs[0][name], before.jobs[0][name], `recovery retains ${name}`);
    assert.deepEqual(after.retries.slice(0, -1), before.retries);
    assert.deepEqual(after.retryAudit.slice(0, -1), before.retryAudit);
    assert.equal(after.retries.length, before.retries.length + 1);
    assert.equal(after.retryAudit.length, before.retryAudit.length + 1);
    assert.equal(after.retryAudit.at(-1).state, "queued");
    assert.equal(after.retryAudit.at(-1).retry_generation, generation + 1);
    assert.equal(after.retries.at(-1).prior_screen_attempts, before.jobs[0].screen_attempts);
    assert.equal((await recoveryStatus(publication)).recovery, null);
    await withoutRecoveryEffect(publication, async () => {
      const replay = await recover(publication, body, key);
      assert.equal(replay.raw, response.raw, "accepted recovery has an immutable receipt");
    });
    return { publication, body, key, response };
  };
  const assertRecoveredDelivery = async (publication, artifact, screens, generation, before) => {
    assert.equal(await fixtures.deliverPublication(publication.publication_id), "published");
    const after = await recoverySnapshot(publication);
    assertOriginalPublication(before, after);
    assert.equal(after.jobs[0].screen_attempts, screens);
    assert.equal(after.jobs[0].retry_generation, generation);
    assert.ok(after.jobs[0].released_at);
    const status = await recoveryStatus(publication);
    assert.equal(status.delivery, "published");
    assert.equal(status.release_authorized, true);
    assert.equal(status.recovery, null);
    const manifest = PublicArtifactManifestSchema.parse(
      (await call(publication.manifest_path)).data,
    );
    assert.equal(manifest.publication_id, publication.publication_id);
    assert.equal(manifest.artifact.sha256, artifact.digest);
    assert.equal(manifest.artifact.size_bytes, artifact.bytes.length);
    assert.equal(manifest.evidence.evidence_id, observerEvidence.evidence_id);
    assert.equal(manifest.author.fellow_id, fellowIdB);
    assert.equal(manifest.author.sponsor_id, sponsorB);
    assert.deepEqual(
      Buffer.from(await fixtures.readPublicCas(artifact.digest)),
      Buffer.from(artifact.bytes),
    );
  };

  const zeroScreenOriginal = await recoverySnapshot(queuedSourcePublication);
  await withoutRecoveryEffect(queuedSourcePublication, () =>
    recover(queuedSourcePublication, recoveryBody(0), "recovery-foreign-owner", 404, authorTokenA),
  );
  await fixtures.setArtifactSourceVisibility(problemId, observerEvidence.evidence_id, "hidden");
  await withoutRecoveryEffect(queuedSourcePublication, () =>
    recover(queuedSourcePublication, recoveryBody(0), "recovery-restored-source", 404),
  );
  await fixtures.setArtifactSourceVisibility(problemId, observerEvidence.evidence_id, "visible");
  // The failed request did not consume its key or reserve new publication work.
  const firstRecovery = await acceptRecovery(
    queuedSourcePublication,
    0,
    "recovery-restored-source",
  );
  await withoutRecoveryEffect(queuedSourcePublication, () =>
    recover(queuedSourcePublication, recoveryBody(0), "recovery-stale-generation", 409),
  );

  // A second temporary loss creates another durable hold in the same job.
  await fixtures.setArtifactSourceVisibility(problemId, claimId, "hidden");
  assert.equal(await fixtures.deliverPublication(queuedSourcePublication.publication_id), "held");
  const repeatedHold = await recoverySnapshot(queuedSourcePublication);
  assertOriginalPublication(zeroScreenOriginal, repeatedHold);
  assert.equal(repeatedHold.jobs[0].screen_attempts, 0);
  assert.equal(repeatedHold.jobs[0].retry_generation, 1);
  assert.deepEqual(
    repeatedHold.retryAudit.map(({ retry_generation, state }) => [retry_generation, state]),
    [
      [1, "queued"],
      [1, "held"],
    ],
  );
  await withoutRecoveryEffect(queuedSourcePublication, async () =>
    assert.equal(
      (await recover(firstRecovery.publication, firstRecovery.body, firstRecovery.key)).raw,
      firstRecovery.response.raw,
    ),
  );
  await withoutRecoveryEffect(queuedSourcePublication, () =>
    recover(queuedSourcePublication, recoveryBody(0), "recovery-old-held-generation", 409),
  );
  await fixtures.setArtifactSourceVisibility(problemId, claimId, "visible");
  const secondRecovery = await acceptRecovery(
    queuedSourcePublication,
    1,
    "recovery-second-generation",
  );
  await assertRecoveredDelivery(queuedSourcePublication, queuedSource, 1, 2, zeroScreenOriginal);
  const zeroScreenDone = await recoverySnapshot(queuedSourcePublication);
  assert.deepEqual(
    zeroScreenDone.retryAudit.map(({ retry_generation, state }) => [retry_generation, state]),
    [
      [1, "queued"],
      [1, "held"],
      [2, "queued"],
      [2, "release-authorized"],
      [2, "published"],
    ],
  );

  const paidOriginal = await recoverySnapshot(racingPublication);
  assert.equal(paidOriginal.jobs[0].screen_attempts, 1);
  const paidRecovery = await acceptRecovery(racingPublication, 0, "recovery-paid-screen");
  await assertRecoveredDelivery(racingPublication, visibilityRace, 2, 1, paidOriginal);
  await withoutRecoveryEffect(racingPublication, () =>
    recover(racingPublication, recoveryBody(1), "recovery-already-published", 409),
  );
  const delivered = EvidenceArtifactsSchema.parse(
    (await call(`/p/${problemId}/evidence/${observerEvidence.evidence_id}/artifacts.json`)).data,
  );
  for (const publication of [observerPublication, queuedSourcePublication, racingPublication])
    assert.equal(
      delivered.artifacts.filter((item) => item.publication_id === publication.publication_id)
        .length,
      1,
    );

  // Recovery is not an override for a classifier's policy hold.
  const rejectedArtifact = await observerArtifact(
    "theorem observer_policy_held : True := by trivial\n",
    "observer-policy-held",
  );
  const rejectedPublication = ArtifactPublicationReceiptSchema.parse(
    (
      await call(
        `/v1/artifacts/${rejectedArtifact.declaration.upload_id}/publish`,
        observerPayload,
        reviewerTokenB,
        202,
        "observer-policy-held-request",
      )
    ).data,
  );
  assert.equal(
    await fixtures.deliverPublication(rejectedPublication.publication_id, "reject"),
    "held",
  );
  assert.equal((await recoveryStatus(rejectedPublication)).recovery, null);
  await withoutRecoveryEffect(rejectedPublication, () =>
    recover(rejectedPublication, recoveryBody(0), "recovery-policy-refused", 409),
  );
  assert.equal(await fixtures.readPublicCas(rejectedArtifact.digest), null);

  // A reviewed policy hold is not a new upload or another model attempt.
  // The operator decides the exact private bytes; the current owner must
  // separately consent before the existing delivery job can publish them.
  const reviewedArtifact = await observerArtifact(
    "theorem reviewed_artifact_release : True := by trivial\n",
    "operator-reviewed-artifact",
  );
  const reviewedPublication = ArtifactPublicationReceiptSchema.parse(
    (
      await call(
        `/v1/artifacts/${reviewedArtifact.declaration.upload_id}/publish`,
        observerPayload,
        reviewerTokenB,
        202,
        "operator-reviewed-publication",
      )
    ).data,
  );
  assert.equal(
    await fixtures.deliverPublication(reviewedPublication.publication_id, "reject"),
    "held",
  );
  const heldReview = await recoveryStatus(reviewedPublication);
  assert.equal(heldReview.delivery, "held");
  assert.equal(heldReview.review?.state, "pending");
  assert.equal(heldReview.recovery, null);
  assert.equal(heldReview.download_url, null);
  assert.equal(await fixtures.readPublicCas(reviewedArtifact.digest), null);
  await call(reviewedPublication.manifest_path, undefined, undefined, 404);
  const heldSnapshot = await recoverySnapshot(reviewedPublication);
  assert.equal(
    heldSnapshot.reviews.length,
    1,
    "the actual hold has one immutable review observation",
  );
  assert.equal(heldSnapshot.reviewReleases.length, 0);
  await withoutRecoveryEffect(reviewedPublication, () =>
    recover(reviewedPublication, recoveryBody(0), "review-not-approved", 409),
  );

  const caseId = heldReview.review.case_id;
  const casePath = `/v1/operators/quarantine/${caseId}`;
  const sponsorReviewRefusal = await sponsorCall(
    sponsorB,
    "GET",
    casePath,
    "operator.quarantine.read",
    undefined,
    401,
    "/v1/operators/quarantine/:caseId",
  );
  assert.equal(sponsorReviewRefusal.data.code, "UNAUTHORIZED");
  const fellowReviewRefusal = await call(casePath, undefined, reviewerTokenB, 403);
  assert.equal(fellowReviewRefusal.data.code, "WRONG_PRINCIPAL");
  const unlistedOperator = await sponsorCall(
    sponsorB,
    "GET",
    casePath,
    "operator.quarantine.read",
    undefined,
    401,
    "/v1/operators/quarantine/:caseId",
    undefined,
    "operator",
  );
  assert.equal(unlistedOperator.data.code, "UNAUTHORIZED");
  const queueResponse = await operatorCall(
    "GET",
    "/v1/operators/quarantine",
    "operator.quarantine.list",
  );
  assert.equal(queueResponse.headers.get("cache-control"), "private, no-store");
  const queue = AdminQuarantineQueueResponseSchema.parse(queueResponse.data);
  assert.ok(queue.items.some((item) => item.id === caseId));
  assert.ok(
    !queueResponse.raw.includes("reviewed_artifact_release"),
    "the queue never copies bytes",
  );
  const detailResponse = await operatorCall(
    "GET",
    casePath,
    "operator.quarantine.read",
    undefined,
    200,
    "/v1/operators/quarantine/:caseId",
  );
  assert.equal(detailResponse.headers.get("cache-control"), "private, no-store");
  const reviewDetail = AdminQuarantineCaseDetailSchema.parse(detailResponse.data);
  assert.equal(reviewDetail.state, "pending");
  assert.equal(reviewDetail.candidate.kind, "artifact-publication");
  assert.equal(
    createHash("sha256").update(reviewDetail.candidate.statement).digest("hex"),
    heldSnapshot.original.screening_sha256,
    "the operator reads the complete, digest-bound screening envelope",
  );
  assert.equal(
    JSON.parse(reviewDetail.candidate.statement).items[0].text,
    new TextDecoder().decode(reviewedArtifact.bytes),
  );
  const reviewReason =
    "Reviewed the exact complete artifact; this is legitimate reproducible mathematics.";
  const decision = AdminQuarantineDecisionResponseSchema.parse(
    (
      await operatorCall(
        "POST",
        "/v1/operators/quarantine/decision",
        "operator.quarantine.decide",
        {
          case_id: caseId,
          decision: "release",
          reason: reviewReason,
        },
      )
    ).data,
  );
  assert.equal(decision.decision, "release");
  const beforeNoticeReads = await recoverySnapshot(reviewedPublication);
  const decisionInboxResponse = await call("/v1/inbox", undefined, reviewerTokenB);
  assert.equal(decisionInboxResponse.headers.get("cache-control"), "private, no-store");
  const decisionInbox = InboxResponseSchema.parse(decisionInboxResponse.data);
  const approvalNotice = decisionInbox.items.find(
    (item) => item.type === "moderation_outcome" && item.target_id === caseId,
  );
  assert.ok(approvalNotice, "the actual review decision reaches its owner");
  assert.deepEqual(
    approvalNotice.next_actions?.map(({ action, url }) => ({ action, url })),
    [{ action: "orient", url: reviewedPublication.status_path }],
    "an artifact decision notice must point to its owner's current publication status",
  );
  const approvedResponse = await call(
    approvalNotice.next_actions[0].url,
    undefined,
    reviewerTokenB,
  );
  assert.equal(approvedResponse.headers.get("cache-control"), "private, no-store");
  const approved = ArtifactPublicationStatusSchema.parse(approvedResponse.data);
  assert.equal(
    approved.delivery,
    "held",
    "operator approval alone is not owner publication consent",
  );
  assert.equal(approved.release_authorized, false);
  assert.equal(approved.review?.state, "approved");
  assert.ok(approved.recovery);
  const decisionMarkdown = await call("/v1/inbox.md", undefined, reviewerTokenB);
  assert.equal(decisionMarkdown.headers.get("cache-control"), "private, no-store");
  assert.ok(
    decisionMarkdown.raw.includes(
      `[${reviewedPublication.status_path}](${reviewedPublication.status_path})`,
    ),
    "the Markdown face carries the same server-selected status read",
  );

  // Deliberately malformed/misrouted stored notices exercise the read boundary;
  // they do not claim the production decision producer misdelivered anything.
  const otherNoticeProblem = "P-ARTIFACT-NOTICE-OTHER";
  await fixtures.seedProblem(otherNoticeProblem, sponsorB);
  const otherReview = await recoveryStatus(rejectedPublication);
  assert.ok(otherReview.review?.case_id && otherReview.review.case_id !== caseId);
  const noticeProbes = [
    ["foreign", fellowIdA, problemId, "moderation_outcome", caseId],
    ["problem", fellowIdB, otherNoticeProblem, "moderation_outcome", caseId],
    ["unknown", fellowIdB, problemId, "moderation_outcome", `QC-${"0".repeat(26)}`],
    ["malformed", fellowIdB, problemId, "moderation_outcome", "QC-not-a-case"],
    ["type", fellowIdB, problemId, "protocol_notice", caseId],
    ["other-case", fellowIdB, problemId, "moderation_outcome", otherReview.review.case_id],
  ];
  for (const [label, fellow, noticeProblem, type, target] of noticeProbes) {
    assert.equal(
      await fixtures.execRaw(
        `INSERT INTO fellow_inbox_notices
          (id,fellow_id,problem_id,notice_type,seq,title,detail,impact_kind,
           caused_by_event_id,target_id,acknowledged_at,expires_at,created_at)
         SELECT ?,?,?,?,
           (SELECT COALESCE(MAX(seq),0)+1 FROM fellow_inbox_notices WHERE fellow_id=?),
           'Synthetic artifact notice source probe',NULL,NULL,
           caused_by_event_id,?,NULL,NULL,created_at
         FROM fellow_inbox_notices WHERE id=?`,
        [
          `N-artifact-source-${label}`,
          fellow,
          noticeProblem,
          type,
          fellow,
          target,
          approvalNotice.id,
        ],
      ),
      1,
    );
  }
  const ownerNoticePage = InboxResponseSchema.parse(
    (await call("/v1/inbox?limit=100", undefined, reviewerTokenB)).data,
  );
  for (const label of ["problem", "unknown", "malformed", "type"]) {
    const item = ownerNoticePage.items.find((notice) => notice.id === `N-artifact-source-${label}`);
    assert.ok(item, `source probe ${label} is actually visible to its recipient`);
    assert.equal(
      item.next_actions,
      undefined,
      `source probe ${label} cannot mint an artifact link`,
    );
  }
  const otherCaseNotice = ownerNoticePage.items.find(
    (notice) => notice.id === "N-artifact-source-other-case",
  );
  assert.deepEqual(
    otherCaseNotice?.next_actions?.map(({ action, url }) => ({ action, url })),
    [{ action: "orient", url: rejectedPublication.status_path }],
    "two owned publications on the same problem remain bound to their exact cases",
  );
  const foreignNoticePage = InboxResponseSchema.parse(
    (await call("/v1/inbox?limit=100", undefined, authorTokenA)).data,
  );
  assert.ok(!foreignNoticePage.items.some((item) => item.id === approvalNotice.id));
  const foreignSourceProbe = foreignNoticePage.items.find(
    (notice) => notice.id === "N-artifact-source-foreign",
  );
  assert.ok(foreignSourceProbe, "the foreign source probe is actually read");
  assert.equal(foreignSourceProbe.next_actions, undefined);
  await call(reviewedPublication.status_path, undefined, authorTokenA, 404);
  assert.deepEqual(
    await recoverySnapshot(reviewedPublication),
    beforeNoticeReads,
    "notice reads and source probes cannot enqueue, authorize, screen or publish an artifact",
  );
  assert.equal(await fixtures.readPublicCas(reviewedArtifact.digest), null);
  await call(reviewedPublication.manifest_path, undefined, undefined, 404);
  assertOriginalPublication(heldSnapshot, await recoverySnapshot(reviewedPublication));
  await withoutRecoveryEffect(reviewedPublication, async () => {
    assert.equal(
      await fixtures.deliverPublication(reviewedPublication.publication_id),
      "idle",
      "the drainer cannot publish an operator-approved artifact without fresh owner consent",
    );
  });
  assert.equal(await fixtures.readPublicCas(reviewedArtifact.digest), null);
  await withoutRecoveryEffect(reviewedPublication, () =>
    recover(reviewedPublication, recoveryBody(0), "review-foreign-consent", 404, authorTokenA),
  );

  const reviewedConsentBody = recoveryBody(0);
  const reviewedConsentKey = "reviewed-owner-consent";
  const reviewedConsentResponse = await recover(
    reviewedPublication,
    reviewedConsentBody,
    reviewedConsentKey,
  );
  const reviewedConsent = ArtifactPublicationRetryReceiptSchema.parse(reviewedConsentResponse.data);
  assert.equal(reviewedConsent.publication_id, reviewedPublication.publication_id);
  assert.equal(reviewedConsent.problem_id, problemId);
  assert.equal(reviewedConsent.status_path, reviewedPublication.status_path);
  assert.equal(reviewedConsent.initial_delivery, "release-authorized");
  assert.equal(reviewedConsent.retry_generation, 0);
  assert.equal(reviewedConsent.review_case_id, caseId);
  const assertReviewedPublication = (after) => {
    for (const name of ["original", "requests", "events", "eventContent", "quota", "upload"])
      assert.deepEqual(after[name], heldSnapshot[name], `reviewed recovery preserves ${name}`);
    assert.deepEqual(after.reviews, heldSnapshot.reviews);
    assert.deepEqual(
      after.legacyAudit.slice(0, heldSnapshot.legacyAudit.length),
      heldSnapshot.legacyAudit,
      "reviewed recovery appends to the audit without rewriting the hold",
    );
  };
  const authorized = await recoverySnapshot(reviewedPublication);
  assertReviewedPublication(authorized);
  assert.deepEqual(
    authorized.legacyAudit.map((row) => row.state),
    ["queued", "held", "release-authorized"],
  );
  assert.equal(authorized.reviewReleases.length, 1);
  assert.equal(authorized.reviewReleases[0].publication_id, reviewedPublication.publication_id);
  assert.equal(authorized.reviewReleases[0].case_id, caseId);
  assert.equal(authorized.reviewReleases[0].retry_id, reviewedConsent.retry_id);
  assert.equal(authorized.reviewReleases[0].created_at, reviewedConsent.authorized_at);
  assert.equal(authorized.reviewReleases[0].fellow_id, fellowIdB);
  assert.equal(authorized.reviewReleases[0].sponsor_id, sponsorB);
  assert.equal(authorized.reviewReleases[0].audit_event_id, decision.audit_event_id);
  assert.equal(authorized.reviewReleases[0].session_id, sessionB.data.session_id);
  assert.deepEqual(authorized.reviews, heldSnapshot.reviews);
  assert.equal(authorized.jobs[0].state, "release-authorized");
  assert.equal(authorized.jobs[0].screen_attempts, 1);
  assert.equal(authorized.jobs[0].last_screen_json, heldSnapshot.jobs[0].last_screen_json);
  assert.equal(await fixtures.readPublicCas(reviewedArtifact.digest), null);
  await withoutRecoveryEffect(reviewedPublication, async () => {
    const replay = await recover(reviewedPublication, reviewedConsentBody, reviewedConsentKey);
    assert.equal(replay.raw, reviewedConsentResponse.raw);
  });
  assert.equal(await fixtures.deliverPublication(reviewedPublication.publication_id), "published");
  const reviewedDelivery = await recoverySnapshot(reviewedPublication);
  assertReviewedPublication(reviewedDelivery);
  assert.deepEqual(
    reviewedDelivery.legacyAudit.map((row) => row.state),
    ["queued", "held", "release-authorized", "published"],
  );
  assert.equal(
    reviewedDelivery.jobs[0].screen_attempts,
    1,
    "operator release does not screen again",
  );
  assert.equal(reviewedDelivery.jobs[0].retry_generation, 0);
  const publishedReviewStatus = await recoveryStatus(reviewedPublication);
  assert.equal(publishedReviewStatus.delivery, "published");
  assert.equal(publishedReviewStatus.release_authorized, true);
  assert.equal(publishedReviewStatus.recovery, null);
  const reviewedManifest = PublicArtifactManifestSchema.parse(
    (await call(reviewedPublication.manifest_path)).data,
  );
  assert.equal(reviewedManifest.artifact.sha256, reviewedArtifact.digest);
  assert.equal(reviewedManifest.artifact.size_bytes, reviewedArtifact.bytes.length);
  assert.equal(reviewedManifest.evidence.evidence_id, observerEvidence.evidence_id);
  assert.equal(reviewedManifest.author.fellow_id, fellowIdB);
  assert.equal(reviewedManifest.author.sponsor_id, sponsorB);
  assert.deepEqual(
    Buffer.from(await fixtures.readPublicCas(reviewedArtifact.digest)),
    Buffer.from(reviewedArtifact.bytes),
  );
  assert.equal((await recoverySnapshot(reviewedPublication)).reviewReleases.length, 1);
  assert.ok(
    !server
      .getLogs()
      .some(
        (log) =>
          log.message.includes("reviewed_artifact_release") || log.message.includes(reviewReason),
      ),
    "operator recovery diagnostics never copy uploaded text or the private review reason",
  );
  console.log(
    JSON.stringify({
      stage: "artifact-operator-review-release",
      pass: true,
      separate_operator_and_owner_consent: true,
      exact_reviewed_bytes: true,
      screen_attempts: 1,
      immutable_release_receipts: 1,
    }),
  );

  // The original recovery session may close without changing an accepted receipt.
  await call(
    `/v1/sessions/${sessionB.data.session_id}/close`,
    {
      handback:
        "Recovered artifact deliveries retain original scientific identity and screening budgets.",
    },
    reviewerTokenB,
    201,
  );
  for (const accepted of [
    firstRecovery,
    secondRecovery,
    paidRecovery,
    {
      publication: reviewedPublication,
      body: reviewedConsentBody,
      key: reviewedConsentKey,
      response: reviewedConsentResponse,
    },
  ]) {
    await withoutRecoveryEffect(accepted.publication, async () => {
      const replay = await recover(accepted.publication, accepted.body, accepted.key);
      assert.equal(
        replay.raw,
        accepted.response.raw,
        "delivery and session closure do not rewrite recovery receipts",
      );
    });
  }
  console.log(
    JSON.stringify({
      stage: "artifact-publication-recovery",
      pass: true,
      discovered_http_retry: true,
      immutable_receipt_after_delivery_and_session_close: true,
      repeated_hold_generations: 2,
      prior_paid_attempt_preserved: true,
      unchanged_publication_events_quota_and_bytes: true,
      policy_hold_not_recoverable: true,
    }),
  );

  // Expiry is a terminal private-upload transition. It must discard only that
  // upload's incoming bytes, including immutable parts, without collecting CAS
  // objects used by verified, public or held publications.
  {
    const expiryEnv = await worker.getEnv();
    const expiring = [];
    for (const operation of [
      "complete",
      "renew",
      "resumable",
      "part",
      "renew-replay",
      "resumable-replay",
      "part-replay",
      "declare-replay",
    ]) {
      const multipart = ["part", "resumable-replay", "part-replay"].includes(operation);
      const declaration = ArtifactDeclareResponseSchema.parse(
        (
          await call(
            "/v1/artifacts",
            {
              session_id: sessionIdA,
              sha256: multipart ? resumeDigest : textSha256,
              size_bytes: multipart ? resumableBytes.length : textBytes.length,
              encoding: multipart ? "lake-archive" : "text",
            },
            authorTokenA,
            201,
            `expiry-${operation}-declaration`,
          )
        ).data,
      );
      let pendingPart;
      let acknowledgedPart;
      let stagedPartKey;
      if (multipart) {
        const begun = ArtifactStatusResponseSchema.parse(
          (await call(declaration.resumable_path, {}, authorTokenA, 200)).data,
        );
        const first = begun.resumable.remaining_parts[0];
        acknowledgedPart = first;
        const firstBytes = resumableBytes.subarray(first.offset, first.offset + first.size_bytes);
        await uploadPart(first.path, firstBytes, authorTokenA);
        stagedPartKey = `incoming/artifacts/${declaration.upload_id}/parts/1/${createHash("sha256").update(firstBytes).digest("hex")}`;
        assert.ok(
          await expiryEnv.ARTIFACTS.head(stagedPartKey),
          "the native part exists before expiry",
        );
        pendingPart = begun.resumable.remaining_parts[1];
      } else {
        if (operation === "renew-replay")
          await call(declaration.renew_path, {}, authorTokenA, 200, "expiry-renew-replay-grant");
        await fixtures.stageArtifact(declaration.upload_id, textBytes);
        assert.equal(await fixtures.hasStagedArtifact(declaration.upload_id), true);
      }
      expiring.push({ operation, declaration, pendingPart, acknowledgedPart, stagedPartKey });
    }
    // This grant remains inside its original completion window when the earlier
    // uploads expire. The fixture clock never changes the immutable deadlines.
    await fixtures.setArtifactClock(
      Math.max(...expiring.map((item) => item.declaration.created_at)) + 60_000,
    );
    let protectedStaging;
    try {
      protectedStaging = ArtifactDeclareResponseSchema.parse(
        (
          await call(
            "/v1/artifacts",
            {
              session_id: sessionIdA,
              sha256: textSha256,
              size_bytes: textBytes.length,
              encoding: "text",
            },
            authorTokenA,
            201,
            "expiry-unexpired-declaration",
          )
        ).data,
      );
      await fixtures.stageArtifact(protectedStaging.upload_id, textBytes);
    } finally {
      await fixtures.setArtifactClock(null);
    }
    const expiredAt = Math.max(...expiring.map((item) => item.declaration.expires_at)) + 1;
    assert.ok(protectedStaging.expires_at > expiredAt);
    const heldBeforeExpiry = await fixtures.readPrivateCas(rejectedArtifact.digest);
    assert.ok(heldBeforeExpiry !== null);
    const publicBeforeExpiry = await fixtures.readPublicCas(textSha256);
    assert.ok(publicBeforeExpiry !== null);
    const archiveBeforeExpiry = await fixtures.readPrivateCas(resumeDigest);
    assert.ok(archiveBeforeExpiry !== null);
    const reservationsBeforeExpiry = await fixtures.artifactReservationSummary(fellowIdA);
    const publicEventsBeforeExpiry = await expiryEnv.DB.prepare(
      "SELECT COUNT(*) AS n FROM events",
    ).first();
    await fixtures.setArtifactClock(expiredAt);
    try {
      for (const {
        operation,
        declaration,
        pendingPart,
        acknowledgedPart,
        stagedPartKey,
      } of expiring) {
        await call(declaration.complete_path, {}, undefined, 401);
        await call(declaration.complete_path, {}, reviewerTokenB, 401);
        assert.equal(
          stagedPartKey
            ? (await expiryEnv.ARTIFACTS.head(stagedPartKey)) !== null
            : await fixtures.hasStagedArtifact(declaration.upload_id),
          true,
          "an anonymous or foreign principal cannot trigger staging cleanup",
        );
        const expire = async () => {
          if (operation === "declare-replay") {
            await call(
              "/v1/artifacts",
              {
                session_id: sessionIdA,
                sha256: textSha256,
                size_bytes: textBytes.length,
                encoding: "text",
              },
              authorTokenA,
              410,
              "expiry-declare-replay-declaration",
            );
          } else if (operation === "part") {
            await uploadPart(
              pendingPart.path,
              resumableBytes.subarray(pendingPart.offset),
              authorTokenA,
              410,
            );
          } else if (operation === "part-replay") {
            await uploadPart(
              acknowledgedPart.path,
              resumableBytes.subarray(
                acknowledgedPart.offset,
                acknowledgedPart.offset + acknowledgedPart.size_bytes,
              ),
              authorTokenA,
              200,
            );
          } else {
            const path = operation.startsWith("renew")
              ? declaration.renew_path
              : operation.startsWith("resumable")
                ? declaration.resumable_path
                : declaration.complete_path;
            const response = await call(
              path,
              {},
              authorTokenA,
              operation === "resumable-replay" ? 200 : 410,
              operation === "renew-replay" ? "expiry-renew-replay-grant" : undefined,
            );
            if (operation === "resumable-replay")
              assert.equal(ArtifactStatusResponseSchema.parse(response.data).state, "expired");
          }
        };
        await expire();
        const stored = await expiryEnv.DB.prepare(
          "SELECT state FROM artifact_uploads WHERE upload_id = ?",
        )
          .bind(declaration.upload_id)
          .first();
        assert.equal(stored.state, "expired");
        assert.equal(
          await fixtures.hasStagedArtifact(declaration.upload_id),
          false,
          `${operation}: expired whole-object staging must be discarded`,
        );
        if (stagedPartKey)
          assert.equal(
            await expiryEnv.ARTIFACTS.head(stagedPartKey),
            null,
            "expired multipart staging must be discarded",
          );

        // A late staging arrival is still private. Retrying the terminal request
        // must clean it without recording another expiration or reserving bytes.
        await fixtures.stageArtifact(declaration.upload_id, textBytes);
        if (stagedPartKey) await expiryEnv.ARTIFACTS.put(stagedPartKey, new Uint8Array([1, 2, 3]));
        await expire();
        assert.equal(await fixtures.hasStagedArtifact(declaration.upload_id), false);
        if (stagedPartKey) assert.equal(await expiryEnv.ARTIFACTS.head(stagedPartKey), null);
        const transitions = await expiryEnv.DB.prepare(
          "SELECT COUNT(*) AS n FROM artifact_upload_events WHERE upload_id = ? AND state = 'expired'",
        )
          .bind(declaration.upload_id)
          .first();
        assert.equal(transitions.n, 1, "expiration remains a single terminal transition");
      }
      assert.equal(
        await fixtures.hasStagedArtifact(protectedStaging.upload_id),
        true,
        "an unexpired upload keeps its own incoming bytes",
      );
      const privateAfterExpiry = await fixtures.readPrivateCas(textSha256);
      const heldAfterExpiry = await fixtures.readPrivateCas(rejectedArtifact.digest);
      const publicAfterExpiry = await fixtures.readPublicCas(textSha256);
      const archiveAfterExpiry = await fixtures.readPrivateCas(resumeDigest);
      for (const [before, after, label] of [
        [textBytes, privateAfterExpiry, "verified private CAS"],
        [heldBeforeExpiry, heldAfterExpiry, "held publication CAS"],
        [publicBeforeExpiry, publicAfterExpiry, "public immutable CAS"],
        [archiveBeforeExpiry, archiveAfterExpiry, "verified resumable CAS"],
      ])
        assert.ok(
          after !== null && Buffer.from(before).equals(Buffer.from(after)),
          `${label} is retained byte-for-byte`,
        );
      const reservationsAfterExpiry = await fixtures.artifactReservationSummary(fellowIdA);
      for (const field of ["manifests", "bytes", "renewals"])
        assert.equal(reservationsAfterExpiry[field], reservationsBeforeExpiry[field]);
      const publicEventsAfterExpiry = await expiryEnv.DB.prepare(
        "SELECT COUNT(*) AS n FROM events",
      ).first();
      assert.equal(publicEventsAfterExpiry.n, publicEventsBeforeExpiry.n);
    } finally {
      await fixtures.setArtifactClock(null);
    }
    console.log(
      JSON.stringify({
        stage: "expired-artifact-staging",
        status: "pass",
        paths: 8,
        late_arrival_cleanup: true,
        terminal_transitions_per_upload: 1,
        protected_cas_classes: 4,
        boundary:
          "local Workerd/D1/R2; staged fixture bytes, not provider presigned-PUT or automatic bucket lifecycle proof",
      }),
    );
  }

  // 16. Clean Session Close
  await call(
    `/v1/sessions/${sessionIdA}/close`,
    {
      handback: "Artifact upload and evidence publication verified.",
      promote: [],
      keep: [],
      discard: [],
    },
    authorTokenA,
    201,
  );

  await assertLedgerTriggersRefuse((await worker.getEnv()).DB, "artifact");
  console.log(JSON.stringify({ stage: "artifact-real-bindings-complete", pass: true }));
} catch (err) {
  console.error("ARTIFACT_REAL_BINDINGS_FAILED:", err);
  process.exitCode = 1;
} finally {
  await server.close();
}
