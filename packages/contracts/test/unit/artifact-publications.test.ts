import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  ARTIFACT_PUBLICATIONS_SCHEMA_ID,
  ArtifactPublicationReceiptSchema,
  ArtifactPublicationRequestSchema,
  ArtifactPublicationStatusSchema,
  EvidenceArtifactsSchema,
  generateArtifactPublicationsSchema,
  PublicArtifactManifestSchema,
} from "../../src/artifact-publications.ts";

const id = `AP-${"a".repeat(32)}`,
  hash = "b".repeat(64),
  digest = `sha256:${hash}`;
const input = {
  session_id: `S-${"A".repeat(26)}`,
  evidence_id: "E-1",
  evidence_digest: digest,
  publish: true,
  license: "CC-BY-4.0",
};
const receipt = {
  schema: ARTIFACT_PUBLICATIONS_SCHEMA_ID,
  publication_id: id,
  problem_id: "P-DEMO",
  event_id: "APE-one",
  seq: 2,
  sha256: hash,
  evidence_id: "E-1",
  evidence_digest: digest,
  license: "CC-BY-4.0",
  verification: "bytes-only",
  initial_delivery: "queued",
  status_path: `/v1/artifact-publications/${id}`,
  manifest_path: `/p/P-DEMO/artifacts/${id}.json`,
};
const url = `https://artifacts.asimposium.org/sha256/${hash}`;
const manifest = {
  schema: ARTIFACT_PUBLICATIONS_SCHEMA_ID,
  publication_id: id,
  problem_id: "P-DEMO",
  evidence: { evidence_id: "E-1", event_id: "event-evidence", digest },
  artifact: {
    sha256: hash,
    size_bytes: 1,
    encoding: "text",
    content_type: "text/plain; charset=utf-8",
    download_url: url,
  },
  author: { fellow_id: "fellow-one", sponsor_id: "sponsor-one" },
  publication_event: { event_id: "APE-one", seq: 2, digest },
  license: "CC-BY-4.0",
  verification: "bytes-only",
  published_at: 100,
  delivery_cursor: 3,
};

test("publication consent is strict and cannot be inferred from upload verification", () => {
  assert.deepEqual(ArtifactPublicationRequestSchema.parse(input), input);
  for (const change of [
    { publish: false },
    { publish: undefined },
    { license: "private" },
    { license: undefined },
    { certified: true },
    { public_url: url },
    { evidence_digest: hash },
    { session_id: "S-invalid" },
    { evidence_id: "E-../secret" },
  ])
    assert.equal(
      ArtifactPublicationRequestSchema.safeParse({ ...input, ...change }).success,
      false,
    );
});
test("accepted receipts remain queued and byte-only without claiming a public URL", () => {
  assert.deepEqual(ArtifactPublicationReceiptSchema.parse(receipt), receipt);
  for (const change of [
    { verification: "machine-checked" },
    { initial_delivery: "published" },
    { download_url: url },
    { upload_id: "private" },
    { credential_id: "private" },
    { seq: Number.MAX_SAFE_INTEGER + 1 },
    { status_path: "https://evil.test" },
  ])
    assert.equal(
      ArtifactPublicationReceiptSchema.safeParse({ ...receipt, ...change }).success,
      false,
    );
});
test("only delivered status has a download URL and a publication timestamp", () => {
  const common = { ...receipt, published_at: null, download_url: null, appeal_path: null };
  assert.ok(
    ArtifactPublicationStatusSchema.safeParse({
      ...common,
      delivery: "queued",
      release_authorized: false,
    }).success,
  );
  assert.ok(
    ArtifactPublicationStatusSchema.safeParse({
      ...common,
      delivery: "held",
      release_authorized: false,
      appeal_path: "/policy.md",
    }).success,
  );
  assert.ok(
    ArtifactPublicationStatusSchema.safeParse({
      ...common,
      delivery: "release-authorized",
      release_authorized: true,
    }).success,
  );
  assert.ok(
    ArtifactPublicationStatusSchema.safeParse({
      ...common,
      delivery: "published",
      release_authorized: true,
      published_at: 100,
      download_url: url,
    }).success,
  );
  for (const delivery of ["queued", "held", "release-authorized"])
    assert.equal(
      ArtifactPublicationStatusSchema.safeParse({
        ...common,
        delivery,
        release_authorized: false,
        download_url: url,
      }).success,
      false,
    );
  assert.equal(
    ArtifactPublicationStatusSchema.safeParse({
      ...common,
      delivery: "published",
      release_authorized: true,
    }).success,
    false,
  );
});
test("public provenance rejects private operational fields at every level", () => {
  assert.deepEqual(PublicArtifactManifestSchema.parse(manifest), manifest);
  for (const change of [
    { upload_id: "private" },
    { lease_token: "private" },
    { screen_receipt_json: "private" },
    { artifact: { ...manifest.artifact, private_key: "private" } },
    { author: { ...manifest.author, token_hash: "private" } },
    { artifact: { ...manifest.artifact, download_url: "https://evil.test" } },
    { verification: "proved" },
  ])
    assert.equal(PublicArtifactManifestSchema.safeParse({ ...manifest, ...change }).success, false);
});
test("bounded evidence pages carry delivery cutoffs and canonical continuation paths", () => {
  const path = "/p/P-DEMO/evidence/E-1/artifacts.json";
  const page = {
    schema: ARTIFACT_PUBLICATIONS_SCHEMA_ID,
    problem_id: "P-DEMO",
    evidence_id: "E-1",
    after: 0,
    through: 3,
    artifacts: [manifest],
    next_after: null,
    next_path: null,
    poll_path: `${path}?after=3`,
  };
  assert.deepEqual(EvidenceArtifactsSchema.parse(page), page);
  for (const change of [
    { artifacts: Array(21).fill(manifest) },
    { after: -1 },
    { through: 1.5 },
    { poll_path: "https://evil.test" },
    { next_path: `${path}?token=secret` },
  ])
    assert.equal(EvidenceArtifactsSchema.safeParse({ ...page, ...change }).success, false);
});
test("the generated public schema comes from the same strict runtime contracts", () => {
  const first = generateArtifactPublicationsSchema();
  assert.equal(first, generateArtifactPublicationsSchema());
  const schema = JSON.parse(first);
  assert.equal(schema.$id, ARTIFACT_PUBLICATIONS_SCHEMA_ID);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties).sort(), [
    "evidence_artifacts",
    "manifest",
    "receipt",
    "request",
    "status",
  ]);
});
