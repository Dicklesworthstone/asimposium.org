import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import {
  ARTIFACT_UPLOADS_SCHEMA_ID,
  ArtifactCompleteRequestSchema,
  ArtifactDeclareRequestSchema,
  ArtifactDeclareResponseSchema,
  ArtifactIdempotencyKeySchema,
  ArtifactRenewRequestSchema,
  ArtifactRenewResponseSchema,
  ArtifactResumableProgressSchema,
  ArtifactResumableRequestSchema,
  ArtifactStatusResponseSchema,
  generateArtifactUploadsSchema,
} from "../../src/artifact-uploads.ts";

const request = {
  session_id: `S-${"A".repeat(26)}`,
  sha256: "a".repeat(64),
  size_bytes: 120,
  encoding: "text",
};
const upload = `AU-${"b".repeat(32)}`;
const pending = {
  schema: ARTIFACT_UPLOADS_SCHEMA_ID,
  upload_id: upload,
  sha256: request.sha256,
  size_bytes: 120,
  encoding: "text",
  storage: "private",
  created_at: 1000,
  expires_at: 86401000,
  state: "presigned",
  verification: "not-verified",
  content_type: null,
  content_path: null,
  verified_at: null,
};

test("artifact manifests accept canonical identity and the distinct text/archive size ceilings", () => {
  assert.ok(ArtifactDeclareRequestSchema.safeParse(request).success);
  assert.ok(
    ArtifactDeclareRequestSchema.safeParse({ ...request, size_bytes: 5 * 1024 * 1024 }).success,
  );
  assert.ok(
    !ArtifactDeclareRequestSchema.safeParse({ ...request, size_bytes: 5 * 1024 * 1024 + 1 })
      .success,
  );
  assert.ok(
    ArtifactDeclareRequestSchema.safeParse({
      ...request,
      encoding: "lake-archive",
      size_bytes: 20 * 1024 * 1024,
    }).success,
  );
  assert.ok(
    !ArtifactDeclareRequestSchema.safeParse({
      ...request,
      encoding: "lake-archive",
      size_bytes: 20 * 1024 * 1024 + 1,
    }).success,
  );
});

test("clients cannot supply ownership, publication, destination or metadata authority", () => {
  for (const extra of [
    { fellow_id: "other" },
    { bucket: "public" },
    { url: "https://evil.test" },
    { state: "verified" },
    { filename: "../../x" },
    { content_type: "text/html" },
    { storage: "public" },
  ]) {
    assert.ok(!ArtifactDeclareRequestSchema.safeParse({ ...request, ...extra }).success);
  }
});

test("malformed hashes, sessions, numeric strings and fractional byte lengths are refused", () => {
  for (const extra of [
    { sha256: "A".repeat(64) },
    { sha256: "a".repeat(63) },
    { session_id: "../S-a" },
    { size_bytes: "120" },
    { size_bytes: 0 },
    { size_bytes: 1.5 },
    { encoding: "html" },
  ]) {
    assert.ok(!ArtifactDeclareRequestSchema.safeParse({ ...request, ...extra }).success);
  }
});

test("completion cannot mutate a declared digest or request public publication", () => {
  assert.ok(ArtifactCompleteRequestSchema.safeParse({}).success);
  for (const value of [
    null,
    [],
    { sha256: request.sha256 },
    { publish: true },
    { fellow_id: "other" },
  ]) {
    assert.ok(!ArtifactCompleteRequestSchema.safeParse(value).success);
  }
});

test("unverified records cannot carry a verified download, and byte verification cannot claim proof", () => {
  assert.ok(ArtifactStatusResponseSchema.safeParse(pending).success);
  assert.ok(
    !ArtifactStatusResponseSchema.safeParse({
      ...pending,
      content_path: `/v1/artifacts/${upload}/content`,
    }).success,
  );
  const verified = {
    ...pending,
    state: "verified",
    verification: "bytes-only",
    verified_at: 2000,
    content_type: "text/plain; charset=utf-8",
    content_path: `/v1/artifacts/${upload}/content`,
  };
  assert.ok(ArtifactStatusResponseSchema.safeParse(verified).success);
  for (const extra of [
    { verification: "machine-checked" },
    { storage: "public" },
    { scientifically_verified: true },
    { content_type: "text/html" },
    { content_path: "https://evil.test/x" },
  ]) {
    assert.ok(!ArtifactStatusResponseSchema.safeParse({ ...verified, ...extra }).success);
  }
});

test("PUT receipts expose only the restricted S3 upload capability and exact required headers", () => {
  const receipt = {
    schema: ARTIFACT_UPLOADS_SCHEMA_ID,
    upload_id: upload,
    sha256: request.sha256,
    size_bytes: 120,
    encoding: "text",
    storage: "private",
    created_at: 1000,
    expires_at: 86401000,
    status_path: `/v1/artifacts/${upload}`,
    complete_path: `/v1/artifacts/${upload}/complete`,
    renew_path: `/v1/artifacts/${upload}/renew`,
    put: {
      method: "PUT",
      url: `https://${"a".repeat(32)}.r2.cloudflarestorage.com/private-bucket/incoming/artifacts/${upload}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=fake`,
      expires_at: 900000,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": "120",
        "if-none-match": "*",
      },
    },
  };
  assert.ok(ArtifactDeclareResponseSchema.safeParse(receipt).success);
  const renewed = { ...receipt, renewed_at: 2000 };
  assert.ok(ArtifactRenewResponseSchema.safeParse(renewed).success);
  assert.ok(!ArtifactRenewResponseSchema.safeParse(receipt).success);
  assert.ok(
    !ArtifactRenewResponseSchema.safeParse({
      ...renewed,
      renew_path: "https://evil.test/upload",
    }).success,
  );
  assert.ok(!ArtifactDeclareResponseSchema.safeParse(renewed).success);
  for (const extra of [
    { method: "POST" },
    { url: "https://evil.test/upload" },
    { headers: { ...receipt.put.headers, "if-none-match": undefined } },
    { headers: { ...receipt.put.headers, authorization: "secret" } },
  ]) {
    assert.ok(
      !ArtifactDeclareResponseSchema.safeParse({ ...receipt, put: { ...receipt.put, ...extra } })
        .success,
    );
  }
});

test("idempotency keys have a bounded header-safe vocabulary", () => {
  assert.ok(ArtifactIdempotencyKeySchema.safeParse("upload.project-1:v2").success);
  for (const value of ["", "a".repeat(129), "two keys", "x\ny", null])
    assert.ok(!ArtifactIdempotencyKeySchema.safeParse(value).success);
});

test("renewal preserves a manifest and cannot accept byte ranges or replacement authority", () => {
  assert.ok(ArtifactRenewRequestSchema.safeParse({}).success);
  for (const value of [
    null,
    [],
    { offset: 10 },
    { upload_id: upload },
    { sha256: request.sha256 },
    { size_bytes: 240 },
    { expires_at: 999999999 },
    { publish: true },
  ]) {
    assert.ok(!ArtifactRenewRequestSchema.safeParse(value).success);
  }
});

test("resumable setup preserves the original manifest and refuses client-selected ranges", () => {
  assert.ok(ArtifactResumableRequestSchema.safeParse({}).success);
  for (const value of [
    null,
    [],
    { offset: 10 },
    { sha256: request.sha256 },
    { upload_id: upload },
    { part_size_bytes: 1 },
    { publish: true },
  ])
    assert.ok(!ArtifactResumableRequestSchema.safeParse(value).success);
});

test("resumable progress fixtures agree with the served generated JSON Schema", () => {
  const schema = JSON.parse(generateArtifactUploadsSchema()).properties.resumable_progress;
  const validate = new Ajv2020({ strict: true }).compile(schema);
  for (const [kind, expected] of [
    ["valid", true],
    ["invalid", false],
  ] as const) {
    const value = JSON.parse(
      readFileSync(
        new URL(`../fixtures/${kind}/artifact-resumable-progress.json`, import.meta.url),
        "utf8",
      ),
    );
    assert.equal(ArtifactResumableProgressSchema.safeParse(value).success, expected);
    assert.equal(validate(value), expected);
  }
});

test("resumable responses never expose bucket keys, arbitrary part URLs or empty byte ranges", () => {
  const progress = {
    protocol: "private-parts-v1",
    part_size_bytes: 5242880,
    total_parts: 1,
    uploaded_parts: [],
    remaining_parts: [
      { part_number: 1, offset: 0, size_bytes: 120, path: `/v1/artifacts/${upload}/parts/1` },
    ],
  };
  assert.ok(ArtifactStatusResponseSchema.safeParse({ ...pending, resumable: progress }).success);
  for (const extra of [
    { private_key: "incoming/private" },
    { upload_id: "s3-upload-secret" },
    { uploaded_parts: [{ part_number: 1, offset: 0, size_bytes: 0, sha256: request.sha256 }] },
  ])
    assert.ok(!ArtifactResumableProgressSchema.safeParse({ ...progress, ...extra }).success);
});
