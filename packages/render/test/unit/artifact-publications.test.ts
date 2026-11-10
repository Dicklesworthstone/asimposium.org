import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  buildEvidenceArtifactDiscovery,
  EvidenceArtifactsSchema,
  evidenceArtifactsPath,
  PublicArtifactManifestSchema,
} from "@asimposium/contracts/artifact-publications";
import {
  ARTIFACT_BYTES_VERIFICATION_BOUNDARY,
  claimEvidenceArtifactDiscovery,
  EVIDENCE_ARTIFACTS_BOUNDARY,
  renderEvidenceArtifactsHtml,
  renderEvidenceArtifactsMarkdown,
  renderPublicArtifactHtml,
  renderPublicArtifactMarkdown,
} from "../../src/artifact-publications.ts";
import { renderAllFaces } from "../../src/render.ts";
import { safeWorkingPack } from "../_support/fixtures.ts";

const manifest = PublicArtifactManifestSchema.parse(
  JSON.parse(
    readFileSync(
      new URL(
        "../../../contracts/test/fixtures/valid/artifact-publication-evidence-warning.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
);
const pin = { evidence_digest: manifest.evidence.digest };
const page = EvidenceArtifactsSchema.parse({
  schema: manifest.schema,
  problem_id: manifest.problem_id,
  evidence_id: manifest.evidence.evidence_id,
  evidence_event_id: manifest.evidence.event_id,
  evidence_digest: manifest.evidence.digest,
  after: 0,
  through: 10,
  artifacts: [manifest],
  next_after: 8,
  next_path: evidenceArtifactsPath("P-DEMO", "E-1", "json", { after: "8", through: "10", ...pin }),
  poll_path: evidenceArtifactsPath("P-DEMO", "E-1", "json", { after: "10", ...pin }),
});

test("file faces keep exact delivery provenance, screening notice and scientific boundaries", () => {
  const before = JSON.stringify(page);
  for (const output of [
    renderEvidenceArtifactsHtml(page),
    renderEvidenceArtifactsMarkdown(page),
    renderPublicArtifactHtml(manifest),
    renderPublicArtifactMarkdown(manifest),
  ]) {
    for (const value of [
      manifest.publication_id,
      manifest.artifact.download_url,
      manifest.evidence.digest,
      manifest.evidence.event_id,
      manifest.author.fellow_id,
      manifest.author.sponsor_id,
      "CC-BY-4.0",
      "screening context notice",
      ARTIFACT_BYTES_VERIFICATION_BOUNDARY,
    ])
      expect(output.toLowerCase()).toContain(value.toLowerCase());
    expect(output).not.toContain("quarantine");
  }
  const md = renderEvidenceArtifactsMarkdown(page);
  const html = renderEvidenceArtifactsHtml(page);
  expect(md).toContain(EVIDENCE_ARTIFACTS_BOUNDARY);
  expect(html).toContain("global file-publication cursors");
  expect(md).toContain(
    evidenceArtifactsPath("P-DEMO", "E-1", "md", { after: "8", through: "10", ...pin }),
  );
  expect(html).toContain(
    evidenceArtifactsPath("P-DEMO", "E-1", "human", {
      after: "8",
      through: "10",
      ...pin,
    }).replaceAll("&", "&amp;"),
  );
  expect(JSON.stringify(page)).toBe(before);
});

test("empty delivery pages remain empty observations, and forged provenance cannot become a download", () => {
  const empty = { ...page, artifacts: [], next_after: null, next_path: null };
  for (const output of [
    renderEvidenceArtifactsHtml(empty),
    renderEvidenceArtifactsMarkdown(empty),
  ]) {
    expect(output).toContain("No currently available public files occur in this delivery window.");
    expect(output).toContain("Check for later deliveries");
    expect(output).not.toContain("Download 1 bytes");
  }
  for (const artifact of [
    { ...manifest, problem_id: "P-OTHER" },
    { ...manifest, evidence: { ...manifest.evidence, event_id: "different-event" } },
    { ...manifest, artifact: { ...manifest.artifact, download_url: "javascript:alert(1)" } },
    { ...manifest, artifact: { ...manifest.artifact, sha256: "c".repeat(64) } },
  ]) {
    expect(() => renderEvidenceArtifactsHtml({ ...page, artifacts: [artifact] })).toThrow();
    expect(() => renderEvidenceArtifactsMarkdown({ ...page, artifacts: [artifact] })).toThrow();
  }
});

test("claim pack links require the exact ledger evidence source and never infer downloads or standing", () => {
  const discovery = buildEvidenceArtifactDiscovery({
    problem_id: "P-DEMO",
    evidence_id: "E-1",
    evidence_event_id: "EV-source",
    evidence_digest: pin.evidence_digest,
  });
  const data = {
    event: "EV-source",
    content_digest: pin.evidence_digest,
    artifact_discovery: discovery,
  };
  const item = {
    kind: "claim-evidence",
    id: "E-1",
    scope: "ledger" as const,
    untrusted: true,
    why_included: "Exact evidence for this claim version",
    body: JSON.stringify(data),
  };
  const faces = renderAllFaces({ ...safeWorkingPack(), problem: "P-DEMO", items: [item] });
  expect(faces.md.body).toContain(`](${discovery.markdown_path})`);
  expect(faces["html-fragment"].body).toContain(`href="${discovery.human_path}"`);
  expect(faces.md.body).toContain("after this ledger snapshot");
  expect(faces.md.body).toContain("does not establish scientific verification");
  expect(JSON.parse(JSON.parse(faces.json.body).items[0].body).artifact_discovery).toEqual(
    discovery,
  );
  const compact = {
    ...item,
    body: JSON.stringify({ ...data, artifact_discovery: discovery.json_path }),
  };
  expect(claimEvidenceArtifactDiscovery("P-DEMO", compact)).toEqual(discovery);
  const compactFaces = renderAllFaces({
    ...safeWorkingPack(),
    problem: "P-DEMO",
    items: [compact],
  });
  expect(compactFaces.md.body).toContain(`](${discovery.markdown_path})`);
  expect(compactFaces["html-fragment"].body).toContain(`href="${discovery.human_path}"`);
  for (const patch of [
    { event: "other-event" },
    { content_digest: `sha256:${"c".repeat(64)}` },
    { scientific_status: { withdrawal: "withdrawn" } },
    { artifact_discovery: { ...discovery, human_path: "javascript:alert(1)" } },
    { artifact_discovery: { ...discovery, problem_id: "P-OTHER" } },
    { artifact_discovery: discovery.json_path.replace("P-DEMO", "P-OTHER") },
    { artifact_discovery: `${discovery.json_path}&token=secret` },
    { artifact_discovery: undefined },
  ])
    expect(
      claimEvidenceArtifactDiscovery("P-DEMO", {
        ...item,
        body: JSON.stringify({ ...data, ...patch }),
      }),
    ).toBeUndefined();
  expect(claimEvidenceArtifactDiscovery("P-OTHER", item)).toBeUndefined();
  expect(claimEvidenceArtifactDiscovery("P-DEMO", { ...item, scope: "workshop" })).toBeUndefined();
  expect(claimEvidenceArtifactDiscovery("P-DEMO", { ...item, id: "E-2" })).toBeUndefined();
});
