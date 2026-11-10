import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ARTIFACT_PUBLICATIONS_SCHEMA_ID,
  ArtifactPublicationReceiptSchema,
  ArtifactPublicationRequestSchema,
  ArtifactPublicationRetryReceiptSchema,
  ArtifactPublicationRetryRequestSchema,
  ArtifactPublicationStatusSchema,
  buildEvidenceArtifactDiscovery,
  EvidenceArtifactDiscoverySchema,
  EvidenceArtifactsQuerySchema,
  EvidenceArtifactsSchema,
  evidenceArtifactsMatchesQuery,
  evidenceArtifactsPath,
  generateArtifactPublicationsSchema,
  PublicArtifactManifestSchema,
  tryBuildEvidenceArtifactDiscovery,
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
const retryInput = { session_id: input.session_id, expected_retry_generation: 0 };
const retryReceipt = {
  schema: ARTIFACT_PUBLICATIONS_SCHEMA_ID,
  publication_id: id,
  problem_id: "P-DEMO",
  retry_id: `APR-${"c".repeat(32)}`,
  retry_generation: 1,
  requeued_at: 100,
  initial_delivery: "queued",
  status_path: receipt.status_path,
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
test("retry requests select a bounded generation without replacing the original publication consent", () => {
  for (const expected_retry_generation of [0, 7, 8]) {
    const value = { ...retryInput, expected_retry_generation };
    assert.deepEqual(ArtifactPublicationRetryRequestSchema.parse(value), value);
  }
  for (const change of [
    { expected_retry_generation: undefined },
    { expected_retry_generation: -1 },
    { expected_retry_generation: 9 },
    { expected_retry_generation: 0.5 },
    { expected_retry_generation: "0" },
    { expected_retry_generation: Number.NaN },
    { expected_retry_generation: Number.MAX_SAFE_INTEGER + 1 },
    { session_id: undefined },
    { session_id: "S-invalid" },
    { publish: true },
    { license: "CC-BY-4.0" },
    { evidence_id: "E-2" },
    { evidence_digest: digest },
    { publication_id: id },
    { screening_receipt: "pass" },
    { reset_screen_attempts: true },
  ])
    assert.equal(
      ArtifactPublicationRetryRequestSchema.safeParse({ ...retryInput, ...change }).success,
      false,
    );
});
test("recovery receipts pin accepted generations without claiming a new publication or delivery", () => {
  for (const retry_generation of [1, 8]) {
    const value = { ...retryReceipt, retry_generation };
    assert.deepEqual(ArtifactPublicationRetryReceiptSchema.parse(value), value);
  }
  for (const change of [
    { retry_generation: 0 },
    { retry_generation: 9 },
    { retry_generation: 1.5 },
    { retry_generation: "1" },
    { retry_generation: undefined },
    { requeued_at: 0 },
    { requeued_at: 1.5 },
    { requeued_at: Number.MAX_SAFE_INTEGER + 1 },
    { initial_delivery: "published" },
    { retry_id: `AP-${"c".repeat(32)}` },
    { retry_id: `APR-${"C".repeat(32)}` },
    { status_path: "https://evil.test/retry" },
    { status_path: `${receipt.status_path}?token=private` },
    { event_id: "new-publication" },
    { download_url: url },
    { license: "CC-BY-4.0" },
    { session_id: retryInput.session_id },
    { key_hash: "private" },
    { screen_attempts: 0 },
  ])
    assert.equal(
      ArtifactPublicationRetryReceiptSchema.safeParse({ ...retryReceipt, ...change }).success,
      false,
    );
});
test("only delivered status has a download URL and a publication timestamp", () => {
  const common = {
    ...receipt,
    published_at: null,
    download_url: null,
    appeal_path: null,
    recovery: null,
  };
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
test("only held status may advertise a strict bounded recovery action", () => {
  const recovery = { retry_path: `${receipt.status_path}/retry`, expected_retry_generation: 0 };
  const held = {
    ...receipt,
    delivery: "held",
    release_authorized: false,
    published_at: null,
    download_url: null,
    appeal_path: "/policy.md",
    recovery,
  };
  assert.deepEqual(ArtifactPublicationStatusSchema.parse(held), held);
  assert.ok(ArtifactPublicationStatusSchema.safeParse({ ...held, recovery: null }).success);
  assert.ok(
    ArtifactPublicationStatusSchema.safeParse({
      ...held,
      recovery: { ...recovery, expected_retry_generation: 8 },
    }).success,
  );
  for (const change of [
    { expected_retry_generation: -1 },
    { expected_retry_generation: 9 },
    { expected_retry_generation: 1.5 },
    { expected_retry_generation: "0" },
    { expected_retry_generation: undefined },
    { retry_path: "https://evil.test/retry" },
    { retry_path: `${receipt.status_path}/retry?token=private` },
    { retry_path: `${receipt.status_path}/retry/extra` },
    { retry_path: `/v1/artifact-publications/AP-${"A".repeat(32)}/retry` },
    { failure_code: "binding-unavailable" },
    { lease_token: "private" },
    { screen_attempts: 0 },
  ])
    assert.equal(
      ArtifactPublicationStatusSchema.safeParse({ ...held, recovery: { ...recovery, ...change } })
        .success,
      false,
    );

  for (const delivery of ["queued", "held", "release-authorized", "published"]) {
    const value = {
      ...held,
      delivery,
      release_authorized: delivery === "release-authorized" || delivery === "published",
      published_at: delivery === "published" ? 100 : null,
      download_url: delivery === "published" ? url : null,
      appeal_path: delivery === "held" ? "/policy.md" : null,
      recovery: null,
    };
    assert.ok(ArtifactPublicationStatusSchema.safeParse(value).success);
    assert.equal(
      ArtifactPublicationStatusSchema.safeParse({ ...value, recovery: undefined }).success,
      false,
    );
    if (delivery !== "held")
      assert.equal(
        ArtifactPublicationStatusSchema.safeParse({ ...value, recovery }).success,
        false,
      );
  }
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
test("artifact provenance carries only the source evidence's coarse publication notice", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("../fixtures/valid/artifact-publication-evidence-warning.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(PublicArtifactManifestSchema.parse(fixture), fixture);
  const offScope = {
    ...fixture,
    evidence: {
      ...fixture.evidence,
      screening_notice: {
        category: "off-topic",
        action: "published-with-warning",
        notice: "off-scope",
      },
    },
  };
  assert.deepEqual(PublicArtifactManifestSchema.parse(offScope), offScope);
  const invalid = JSON.parse(
    readFileSync(
      new URL(
        "../fixtures/invalid/artifact-publication-evidence-warning-private.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(PublicArtifactManifestSchema.safeParse(invalid).success, false);
  assert.equal(
    PublicArtifactManifestSchema.safeParse({
      ...manifest,
      screening_notice: fixture.evidence.screening_notice,
    }).success,
    false,
  );
  assert.equal(
    PublicArtifactManifestSchema.safeParse({
      ...manifest,
      artifact: { ...manifest.artifact, screening_notice: fixture.evidence.screening_notice },
    }).success,
    false,
  );
});
test("bounded evidence pages carry delivery cutoffs and canonical continuation paths", () => {
  const path = "/p/P-DEMO/evidence/E-1/artifacts.json";
  const page = {
    schema: ARTIFACT_PUBLICATIONS_SCHEMA_ID,
    problem_id: "P-DEMO",
    evidence_id: "E-1",
    evidence_event_id: manifest.evidence.event_id,
    evidence_digest: digest,
    after: 0,
    through: 3,
    artifacts: [manifest],
    next_after: null,
    next_path: null,
    poll_path: `${path}?after=3&evidence_digest=${digest}`,
  };
  assert.deepEqual(EvidenceArtifactsSchema.parse(page), page);
  for (const change of [
    { artifacts: Array(21).fill(manifest) },
    { after: -1 },
    { through: 1.5 },
    { poll_path: "https://evil.test" },
    { next_path: `${path}?token=secret` },
    { evidence_event_id: "other-event" },
    { evidence_digest: `sha256:${"c".repeat(64)}` },
    { problem_id: "P-OTHER" },
    { through: 2 },
    { after: 3 },
    { next_after: 2, next_path: `${path}?after=2&through=3&evidence_digest=${digest}` },
    { artifacts: [manifest, manifest] },
  ])
    assert.equal(EvidenceArtifactsSchema.safeParse({ ...page, ...change }).success, false);
  assert.equal(
    evidenceArtifactsMatchesQuery(page, "P-DEMO", "E-1", { evidence_digest: digest }),
    true,
  );
  assert.equal(evidenceArtifactsMatchesQuery(page, "P-OTHER", "E-1"), false);
  assert.equal(evidenceArtifactsMatchesQuery(page, "P-DEMO", "E-2"), false);
  assert.equal(evidenceArtifactsMatchesQuery(page, "P-DEMO", "E-1", { after: "1" }), false);
  assert.equal(evidenceArtifactsMatchesQuery(page, "P-DEMO", "E-1", { through: "4" }), false);
  assert.equal(
    evidenceArtifactsMatchesQuery(page, "P-DEMO", "E-1", {
      evidence_digest: `sha256:${"c".repeat(64)}`,
    }),
    false,
  );
});
test("discovery links bind one evidence publication without asserting available files", () => {
  const input = {
    problem_id: "P-DEMO",
    evidence_id: "E-1",
    evidence_event_id: "event-evidence",
    evidence_digest: digest,
  };
  const discovery = buildEvidenceArtifactDiscovery(input);
  assert.deepEqual(EvidenceArtifactDiscoverySchema.parse(discovery), discovery);
  assert.equal(discovery.temporal_scope, "current-publications");
  assert.equal(discovery.verification, "bytes-only");
  for (const [key, format] of [
    ["json_path", "json"],
    ["markdown_path", "md"],
    ["human_path", "human"],
  ] as const) {
    assert.equal(
      discovery[key],
      evidenceArtifactsPath("P-DEMO", "E-1", format, { evidence_digest: digest }),
    );
    for (const path of [
      "https://evil.example/files",
      "/p/P-OTHER/evidence/E-1/artifacts.json",
      `${discovery[key]}&token=secret`,
    ]) {
      assert.equal(
        EvidenceArtifactDiscoverySchema.safeParse({ ...discovery, [key]: path }).success,
        false,
      );
    }
  }
  assert.equal(
    EvidenceArtifactDiscoverySchema.safeParse({
      ...discovery,
      verification: "scientifically-verified",
    }).success,
    false,
  );
  assert.equal(
    EvidenceArtifactDiscoverySchema.safeParse({ ...discovery, available: true }).success,
    false,
  );
  for (const problem_id of ["legacy.problem", "P-A", "P--DEMO", "../secret"]) {
    assert.equal(tryBuildEvidenceArtifactDiscovery({ ...input, problem_id }), undefined);
    assert.equal(
      EvidenceArtifactDiscoverySchema.safeParse({ ...discovery, problem_id }).success,
      false,
    );
  }
});
test("artifact queries reject alternate cursor spelling, out-of-range numbers and private authority", () => {
  assert.deepEqual(
    EvidenceArtifactsQuerySchema.parse({ after: "0", through: "5", evidence_digest: digest }),
    { after: "0", through: "5", evidence_digest: digest },
  );
  for (const query of [
    { after: "-1" },
    { after: "01" },
    { after: "1.0" },
    { after: "1e2" },
    { after: "2\n" },
    { after: "9007199254740992" },
    { after: "5", through: "4" },
    { evidence_digest: hash },
    { evidence_digest: `sha256:${"A".repeat(64)}` },
    { token: "secret" },
  ])
    assert.equal(EvidenceArtifactsQuerySchema.safeParse(query).success, false);
  assert.equal(
    PublicArtifactManifestSchema.safeParse({
      ...manifest,
      artifact: {
        ...manifest.artifact,
        download_url: `https://artifacts.asimposium.org/sha256/${"c".repeat(64)}`,
      },
    }).success,
    false,
  );
});
test("the generated public schema comes from the same strict runtime contracts", () => {
  const first = generateArtifactPublicationsSchema();
  assert.equal(first, generateArtifactPublicationsSchema());
  const schema = JSON.parse(first);
  assert.equal(schema.$id, ARTIFACT_PUBLICATIONS_SCHEMA_ID);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties).sort(), [
    "evidence_artifact_discovery",
    "evidence_artifacts",
    "evidence_artifacts_query",
    "manifest",
    "receipt",
    "request",
    "retry_receipt",
    "retry_request",
    "status",
  ]);
});

test("reviewed release receipts preserve current generations without another screen or public delivery", () => {
  const { requeued_at: _requeued, ...base } = retryReceipt;
  const caseId = `QC-${"A".repeat(26)}`;
  for (const retry_generation of [0, 8]) {
    const value = {
      ...base,
      retry_generation,
      initial_delivery: "release-authorized",
      authorized_at: 100,
      review_case_id: caseId,
    };
    assert.deepEqual(ArtifactPublicationRetryReceiptSchema.parse(value), value);
    for (const change of [
      { retry_generation: 9 },
      { retry_generation: -1 },
      { review_case_id: "QC-invalid" },
      { authorized_at: 0 },
      { requeued_at: 100 },
      { decision: "pass" },
      { provider_status: "ok" },
      { download_url: url },
    ])
      assert.equal(
        ArtifactPublicationRetryReceiptSchema.safeParse({ ...value, ...change }).success,
        false,
      );
  }
});
test("held review status exposes only an actionable private case reference", () => {
  const caseId = `QC-${"A".repeat(26)}`;
  const base = {
    ...receipt,
    delivery: "held",
    release_authorized: false,
    published_at: null,
    download_url: null,
    appeal_path: "/policy.md",
    recovery: null,
  };
  for (const state of ["pending", "approved", "rejected", "superseded", "unavailable"]) {
    const review = {
      case_id: caseId,
      state,
      sponsor_case_path: `/v1/sponsors/screening-cases/${caseId}`,
    };
    assert.deepEqual(ArtifactPublicationStatusSchema.parse({ ...base, review }), {
      ...base,
      review,
    });
    for (const change of [
      { candidate: "private bytes" },
      { state: "released" },
      { sponsor_case_path: "https://evil.test" },
    ])
      assert.equal(
        ArtifactPublicationStatusSchema.safeParse({ ...base, review: { ...review, ...change } })
          .success,
        false,
      );
  }
});
