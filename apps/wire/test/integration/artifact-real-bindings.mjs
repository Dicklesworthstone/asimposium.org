import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  ArtifactPublicationReceiptSchema,
  EvidenceArtifactsSchema,
  PublicArtifactManifestSchema,
} from "@asimposium/contracts/artifact-publications";
import {
  ArtifactDeclareResponseSchema,
  ArtifactStatusResponseSchema,
} from "@asimposium/contracts/artifact-uploads";
import { createTestHarness } from "wrangler";
import { mintServiceEnvelope, serviceEnvelopeHeaders } from "../../../web/lib/service-envelope.ts";

assert.equal(process.versions.bun, undefined, "This lane requires genuine Node");
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const origin = "https://a-staging.asimposium.org";
const agoraOrigin = "https://staging.asimposium.org";
const userAgent = "OpenAI File Downloader, XaiImageApiFetch/1.0";

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
          rules: [
            { type: "Text", globs: ["**/*.md", "**/*.txt", "**/*.schema.json"], fallthrough: true },
          ],
          vars: {
            STOA_ORIGIN: origin,
            AGORA_ORIGIN: agoraOrigin,
            SPONSOR_PROMOTION_RATE_LIMIT: "100",
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

  async function sponsorCall(
    sponsorId,
    method,
    path,
    action,
    body,
    expected = 200,
    route = path,
    idempotencyKey,
  ) {
    const raw = JSON.stringify(body ?? {});
    const envelope = await mintServiceEnvelope({
      privateKey: signingKeys.privateKey,
      kid: keyId,
      now: Math.floor(Date.now() / 1000),
      method,
      route,
      action,
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
      body: raw,
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

  await sponsorCall(
    sponsorA,
    "POST",
    `/v1/sponsors/problems/${problemId}/lifecycle`,
    "problem-lifecycle",
    { action: "publish" },
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

  // 8. Staging and Successful Verification
  await fixtures.stageArtifact(uploadId, textBytes);

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

  // Completion replay returns identical metadata
  const compReplay = await call(uploadReceipt.complete_path, {}, authorTokenA, 200, "key-comp-1");
  assert.deepEqual(compReplay.data, completeData);

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
  assert.equal(statusMismatch.data.content_path, null);

  // Quarantined upload cannot be downloaded
  await call(`/v1/artifacts/${uploadIdMismatch}/content`, undefined, authorTokenA, 401);

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

  // Submit Evidence
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

  // 14. Clean Session Close
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

  console.log(JSON.stringify({ stage: "artifact-real-bindings-complete", pass: true }));
  process.exit(0);
} catch (err) {
  console.error("ARTIFACT_REAL_BINDINGS_FAILED:", err);
  process.exit(1);
}
