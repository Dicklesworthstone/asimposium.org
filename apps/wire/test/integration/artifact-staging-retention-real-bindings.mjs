import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";

// Real Workerd/D1/R2. Whole-object byte staging is an explicit binding fixture,
// not a claim that local R2 accepts remote presigned S3 PUTs. Resumable parts,
// completion and reads use the mounted HTTP adapters; cleanup runs in Workerd.
assert.equal(process.versions.bun, undefined, "This lane requires genuine Node");
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const origin = "https://a-staging.asimposium.org";
const userAgent = "asimposium.org-agent (+https://github.com/Dicklesworthstone/asimposium.org)";
const server = createTestHarness({
  root,
  workers: [
    {
      secrets: {
        ARTIFACT_UPLOAD_SIGNING: JSON.stringify({
          accountId: "a".repeat(32),
          bucket: "asimposium-artifacts-staging",
          accessKeyId: "b".repeat(32),
          secretAccessKey: "c".repeat(64),
          sponsorDailyBytes: 1073741824,
          fellowDailyManifests: 100,
        }),
        ENROLLMENT_REPLAY_KEY: Buffer.alloc(32, 19).toString("base64url"),
      },
      config: {
        name: "asimposium-artifact-staging-retention-proof",
        main: `${root}/apps/wire/test/integration/discovery-local-worker.ts`,
        compatibility_date: "2026-08-13",
        compatibility_flags: ["nodejs_compat"],
        d1_databases: [
          {
            binding: "DB",
            database_name: "artifact-staging-retention-proof",
            database_id: "00000000-0000-0000-0000-000000000000",
            migrations_dir: `${root}/db/migrations`,
          },
        ],
        r2_buckets: [
          { binding: "ARTIFACTS", bucket_name: "artifact-retention-private" },
          { binding: "PUBLIC_ARTIFACTS", bucket_name: "artifact-retention-public" },
        ],
        durable_objects: {
          bindings: [{ name: "KRATER_OUTBOX", class_name: "KraterOutboxDrainer" }],
        },
        exports: { KraterOutboxDrainer: { type: "durable-object", storage: "sqlite" } },
        rules: [
          { type: "Text", globs: ["**/*.md", "**/*.txt", "**/*.schema.json"], fallthrough: true },
        ],
        vars: { STOA_ORIGIN: origin, AGORA_ORIGIN: "https://staging.asimposium.org" },
      },
    },
  ],
});
try {
  await server.listen();
  console.log(JSON.stringify({ stage: "workerd-started" }));
  const worker = server.getWorker();
  await worker.applyD1Migrations("DB");
  console.log(JSON.stringify({ stage: "d1-migrated" }));
  const fixtures = await worker.getExport();
  const env = await worker.getEnv();
  let key = 0;
  async function call(path, body, token, expected = 200) {
    const response = await worker.fetch(`${origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "User-Agent": userAgent,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined
          ? {}
          : {
              "content-type": "application/json",
              "idempotency-key": `retention-${++key}`,
            }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    assert.equal(
      response.status,
      expected,
      `${path}: expected=${expected} actual=${response.status} code=${value.code ?? "receipt"}`,
    );
    return value;
  }
  const discovery = await call("/openapi.json");
  function requestPath(property) {
    const entry = Object.entries(discovery.paths).find(([, methods]) =>
      methods.post?.requestBody?.content?.["application/json"]?.schema?.$ref?.endsWith(
        `/properties/${property}`,
      ),
    );
    assert.ok(entry, `missing ${property} request`);
    return entry[0];
  }
  const sponsor = "usr_artifact_retention";
  const minted = await fixtures.mint(sponsor, ["promote", "review", "upload-artifacts"]);
  const proposed = await call(
    requestPath("fellow_registration_request"),
    {
      enrollment_id: minted.enrollmentId,
      secret: minted.secret,
      name: "retention-author",
      model: "synthetic-artifact-retention",
      harness: "local-artifact-retention-proof",
    },
    undefined,
    202,
  );
  await fixtures.approve(sponsor, minted.enrollmentId);
  const { token } = await call(requestPath("flow_poll_request"), {
    flow_handle: proposed.flow_handle,
  });
  assert.equal(typeof token, "string");
  const problem = "P-ARTIFACT-RETENTION";
  await fixtures.seedProblem(problem, sponsor);
  const session = await call(
    "/v1/sessions",
    { problem_id: problem, intent: "explore" },
    token,
    201,
  );
  const bytes = new TextEncoder().encode("theorem retained_verified_bytes : True := by trivial\n");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const declare = () =>
    call(
      "/v1/artifacts",
      {
        session_id: session.session_id,
        sha256: digest,
        size_bytes: bytes.length,
        encoding: "text",
      },
      token,
      201,
    );
  const abandoned = await declare();
  const resumable = await declare();
  const verified = await declare();
  const quarantined = await declare();
  const active = await declare();
  const stageKey = (upload) => `incoming/artifacts/${upload.upload_id}`;
  for (const upload of [abandoned, verified, active])
    await fixtures.stageArtifact(upload.upload_id, bytes);
  const progress = await call(resumable.resumable_path, {}, token);
  const partResponse = await worker.fetch(
    `${origin}${progress.resumable.remaining_parts[0].path}`,
    {
      method: "PUT",
      headers: {
        "User-Agent": userAgent,
        authorization: `Bearer ${token}`,
        "content-type": "application/octet-stream",
        "idempotency-key": "retention-part-1",
      },
      body: bytes,
    },
  );
  assert.equal(partResponse.status, 200);
  const part = await partResponse.json();
  const partKey = `${stageKey(resumable)}/parts/1/${part.sha256}`;
  assert.ok(await env.ARTIFACTS.head(partKey));
  // A hold accepted before completion must also retain its immediate staging copy.
  await env.DB.prepare("UPDATE artifact_staging_retention SET held = 1 WHERE upload_id IN (?, ?)")
    .bind(verified.upload_id, quarantined.upload_id)
    .run();
  assert.equal((await call(verified.complete_path, {}, token)).state, "verified");
  await fixtures.stageArtifact(quarantined.upload_id, bytes.subarray(1));
  await call(quarantined.complete_path, {}, token, 422);
  await env.DB.prepare("UPDATE artifact_staging_retention SET held = 0 WHERE upload_id = ?")
    .bind(quarantined.upload_id)
    .run();
  const sweepAt =
    Math.max(...[abandoned, resumable, verified, quarantined, active].map((u) => u.expires_at)) +
    60000;
  await env.DB.prepare(
    "UPDATE artifact_uploads SET lease_token = ?, lease_until = ? WHERE upload_id = ?",
  )
    .bind("e".repeat(32), sweepAt + 60000, active.upload_id)
    .run();
  await env.ARTIFACTS.put("backups/retention-control", bytes);
  await env.PUBLIC_ARTIFACTS.put(`sha256/${digest}`, bytes);
  const beforeEvents = await env.DB.prepare("SELECT COUNT(*) AS n FROM events").first();
  const results = await Promise.all([
    fixtures.artifactStagingTick(sweepAt),
    fixtures.artifactStagingTick(sweepAt),
  ]);
  assert.equal(
    results.reduce((n, result) => n + result.cleared, 0),
    2,
  );
  assert.equal(
    results.reduce((n, result) => n + result.expired, 0),
    2,
  );
  assert.equal(
    results.reduce((n, result) => n + result.failed + result.pending, 0),
    0,
  );
  assert.equal(await env.ARTIFACTS.head(stageKey(abandoned)), null);
  assert.equal(await env.ARTIFACTS.head(partKey), null);
  for (const upload of [verified, quarantined, active])
    assert.ok(await env.ARTIFACTS.head(stageKey(upload)));
  assert.deepEqual(
    new Uint8Array(await (await env.ARTIFACTS.get(`cas/sha256/${digest}`)).arrayBuffer()),
    bytes,
  );
  assert.ok(await env.PUBLIC_ARTIFACTS.head(`sha256/${digest}`));
  assert.ok(await env.ARTIFACTS.head("backups/retention-control"));
  const receipt = await env.DB.prepare(
    "SELECT sha256, acknowledged_at FROM artifact_upload_parts WHERE upload_id = ?",
  )
    .bind(resumable.upload_id)
    .first();
  assert.equal(receipt.sha256, digest);
  assert.ok(receipt.acknowledged_at > 0);
  await env.DB.prepare("UPDATE artifact_staging_retention SET held = 0 WHERE upload_id = ?")
    .bind(verified.upload_id)
    .run();
  const retry = await fixtures.artifactStagingTick(sweepAt + 60000);
  assert.equal(retry.cleared, 2);
  assert.equal(retry.expired, 1);
  assert.equal(await env.ARTIFACTS.head(stageKey(verified)), null);
  assert.equal(await env.ARTIFACTS.head(stageKey(active)), null);
  assert.ok(await env.ARTIFACTS.head(stageKey(quarantined)));
  const download = await worker.fetch(`${origin}/v1/artifacts/${verified.upload_id}/content`, {
    headers: { "User-Agent": userAgent, authorization: `Bearer ${token}` },
  });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()), bytes);
  await fixtures.stageArtifact(abandoned.upload_id, bytes);
  assert.equal((await fixtures.artifactStagingTick(sweepAt + 86400000)).cleared, 2);
  assert.equal(await env.ARTIFACTS.head(stageKey(abandoned)), null);
  assert.deepEqual(await env.DB.prepare("SELECT COUNT(*) AS n FROM events").first(), beforeEvents);
  const audit = await env.DB.prepare(
    "SELECT state FROM artifact_upload_events WHERE upload_id = ? ORDER BY seq",
  )
    .bind(abandoned.upload_id)
    .all();
  assert.deepEqual(
    audit.results.map((row) => row.state),
    ["presigned", "expired"],
  );
  const captured = JSON.stringify(server.getLogs());
  for (const secret of [token, minted.secret, proposed.flow_handle])
    assert.ok(!captured.includes(secret));
  console.log(
    JSON.stringify({
      kind: "artifact-staging-retention-real-bindings",
      status: "pass",
      manifests: 5,
      concurrent_expired: 2,
      immutable_part_receipts: 1,
      protected_namespaces: 3,
    }),
  );
} finally {
  await server.close();
}
