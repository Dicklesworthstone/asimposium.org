import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { PRODUCTION_STOA_ORIGIN } from "@asimposium/contracts";
import {
  ARTIFACT_PUBLICATIONS_SCHEMA_ID,
  buildEvidenceArtifactDiscovery,
  type EvidenceArtifacts,
  evidenceArtifactsPath,
} from "@asimposium/contracts/artifact-publications";
import { renderToStaticMarkup } from "react-dom/server";
import { EvidenceArtifactLink } from "../../components/evidence-artifact-link";
import { evidenceArtifactDiscovery } from "../../lib/evidence-artifacts";

mock.module("server-only", () => ({}));
const { stoaFetchEvidenceArtifacts } = await import("../../lib/public-artifacts");
const { default: ArtifactsPage, generateMetadata } = await import("../../app/p/[slug]/evidence/[evidence]/artifacts/page");

const evidenceDigest = `sha256:${"a".repeat(64)}`;
const artifactHash = "b".repeat(64);
const discovery = buildEvidenceArtifactDiscovery({
  problem_id: "P-TEST", evidence_id: "E-TEST",
  evidence_event_id: "EV-EVIDENCE", evidence_digest: evidenceDigest,
});
const current = { evidence_digest: evidenceDigest };
function collection(patch: Partial<EvidenceArtifacts> = {}): EvidenceArtifacts {
  return {
    schema: ARTIFACT_PUBLICATIONS_SCHEMA_ID, problem_id: "P-TEST", evidence_id: "E-TEST",
    evidence_event_id: "EV-EVIDENCE", evidence_digest: evidenceDigest,
    after: 0, through: 51,
    artifacts: [{
      schema: ARTIFACT_PUBLICATIONS_SCHEMA_ID,
      publication_id: `AP-${"c".repeat(32)}`, problem_id: "P-TEST",
      evidence: { evidence_id: "E-TEST", event_id: "EV-EVIDENCE", digest: evidenceDigest },
      artifact: { sha256: artifactHash, size_bytes: 126, encoding: "text",
        content_type: "text/plain; charset=utf-8",
        download_url: `https://artifacts.asimposium.org/sha256/${artifactHash}` },
      author: { fellow_id: "F-RESEARCHER", sponsor_id: "SP-RESEARCHER" },
      publication_event: { event_id: "EV-ARTIFACT", seq: 12, digest: `sha256:${"d".repeat(64)}` },
      license: "CC-BY-4.0", verification: "bytes-only", published_at: 1_800_000_000_000,
      delivery_cursor: 48,
    }],
    next_after: null, next_path: null,
    poll_path: evidenceArtifactsPath("P-TEST", "E-TEST", "json", { after: "51", ...current }),
    ...patch,
  };
}
type Query = Record<string, string | string[] | undefined>;
const props = (query: Query = current) => ({
  params: Promise.resolve({ slug: "P-TEST", evidence: "E-TEST" }),
  searchParams: Promise.resolve(query),
});
const originalFetch = globalThis.fetch;
let previousOrigin: string | undefined;
beforeEach(() => {
  previousOrigin = process.env.STOA_ORIGIN;
  process.env.STOA_ORIGIN = PRODUCTION_STOA_ORIGIN;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousOrigin === undefined) delete process.env.STOA_ORIGIN;
  else process.env.STOA_ORIGIN = previousOrigin;
});

test("public research files render downloads and source pins with no credential forwarding", async () => {
  const calls: string[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request, options?: RequestInit) => {
    calls.push(String(url));
    expect(options?.method).toBe("GET");
    expect(options?.credentials).toBe("omit");
    expect(options?.redirect).toBe("error");
    expect(new Headers(options?.headers).has("authorization")).toBe(false);
    expect(new Headers(options?.headers).has("cookie")).toBe(false);
    expect((options as RequestInit & { next: { revalidate: number } }).next.revalidate).toBe(0);
    return Response.json(collection());
  }) as unknown as typeof fetch;
  const html = renderToStaticMarkup(await ArtifactsPage(props()));
  expect(calls).toEqual([`${PRODUCTION_STOA_ORIGIN}${discovery.json_path}`]);
  expect(html).toContain(`https://artifacts.asimposium.org/sha256/${artifactHash}`);
  expect(html).toContain(evidenceDigest);
  expect(html).toContain("CC-BY-4.0");
  expect(html).toContain("EV-EVIDENCE");
  expect(html).toContain("F-RESEARCHER");
  expect(html).toContain("Refresh current public availability");
  expect(html).toContain("after=0&amp;through=51&amp;evidence_digest=");
  expect(html).not.toContain("certified artifact");
  expect(html).not.toContain("<script");
});

test("later-delivered files page by delivery cursor while retaining exact evidence provenance", async () => {
  globalThis.fetch = mock(async () => Response.json(collection({
    next_after: 48,
    next_path: evidenceArtifactsPath("P-TEST", "E-TEST", "json", { after: "48", through: "51", ...current }),
  }))) as unknown as typeof fetch;
  const html = renderToStaticMarkup(await ArtifactsPage(props()));
  expect(html).toContain(`href="/p/P-TEST/evidence/E-TEST/artifacts?after=48&amp;through=51&amp;evidence_digest=${evidenceDigest}"`);
  expect(html).toContain("More files at this delivery snapshot");
  expect(html).not.toContain("through=12");
});

test("unavailable or withheld downloads are never displayed as an empty successful collection", async () => {
  for (const status of [404, 503]) {
    globalThis.fetch = mock(async () => Response.json({ status, code: "ROUTE_NOT_FOUND" }, { status })) as unknown as typeof fetch;
    const html = renderToStaticMarkup(await ArtifactsPage(props({ ...current, after: "48", through: "51" })));
    expect(html).toContain("Public ledger data is temporarily unavailable");
    expect(html).toContain('name="evidence_digest"');
    expect(html).toContain('name="through" value="51"');
    expect(html).not.toContain("https://artifacts.asimposium.org/sha256/");
    expect((await generateMetadata(props())).robots).toEqual({ index: false, follow: false });
  }
  globalThis.fetch = mock(async () => Response.json(collection({ artifacts: [] }))) as unknown as typeof fetch;
  const empty = renderToStaticMarkup(await ArtifactsPage(props()));
  expect(empty).not.toContain("Public ledger data is temporarily unavailable");
  expect(empty).toContain("Refresh current public availability");
});

test("foreign evidence, unsafe links and inconsistent delivery cuts fail closed", async () => {
  let value: unknown = collection();
  globalThis.fetch = mock(async () => Response.json(value)) as unknown as typeof fetch;
  for (const patch of [
    { problem_id: "P-OTHER" }, { evidence_id: "E-OTHER" },
    { evidence_digest: `sha256:${"e".repeat(64)}` },
    { after: 1 }, { through: 47 },
    { poll_path: "/v1/private/upload" },
    { artifacts: [{ ...collection().artifacts[0]!, problem_id: "P-OTHER" }] },
    { artifacts: [{ ...collection().artifacts[0]!, evidence: {
      evidence_id: "E-TEST", event_id: "EV-OTHER", digest: evidenceDigest,
    } }] },
    { artifacts: [{ ...collection().artifacts[0]!, artifact: {
      ...collection().artifacts[0]!.artifact, download_url: "https://attacker.example/file",
    } }] },
  ]) {
    value = { ...collection(), ...patch };
    expect(await stoaFetchEvidenceArtifacts("P-TEST", "E-TEST", undefined, current))
      .toEqual({ state: "unavailable", reason: "invalid_response" });
  }
});

test("invalid identities and repeated or unknown selectors are refused before fetching", async () => {
  const fetch = mock(async () => Response.json(collection()));
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
  for (const query of [
    { after: "-1" }, { through: "01" }, { after: "2", through: "1" },
    { through: "9007199254740992" }, { through: ["4", "5"] },
    { evidence_digest: [evidenceDigest, evidenceDigest] }, { evidence_digest: "bad" },
    { token: "not-a-public-selector" },
  ]) {
    expect(renderToStaticMarkup(await ArtifactsPage(props(query)))).toContain("Invalid artifact collection view");
    expect((await generateMetadata(props(query))).robots).toEqual({ index: false, follow: false });
  }
  expect((await stoaFetchEvidenceArtifacts("../v1/private", "E-TEST")).state).toBe("unavailable");
  expect((await stoaFetchEvidenceArtifacts("P-TEST", "../../workshop")).state).toBe("unavailable");
  expect((await stoaFetchEvidenceArtifacts("legacy-problem", "E-TEST")).state).toBe("unavailable");
  expect((await stoaFetchEvidenceArtifacts("P-DOUBLE--HYPHEN", "E-TEST")).state).toBe("unavailable");
  expect((await stoaFetchEvidenceArtifacts("P-TEST", "E-TEST", "https://attacker.example")).state).toBe("unavailable");
  expect(fetch).not.toHaveBeenCalled();
});

test("noindex follows the canonical source", async () => {
  globalThis.fetch = mock(async () => Response.json(collection(), {
    headers: { "x-robots-tag": "noindex, nofollow" },
  })) as unknown as typeof fetch;
  expect((await generateMetadata(props())).robots).toEqual({ index: false, follow: false });
  expect(renderToStaticMarkup(await ArtifactsPage(props()))).toContain("stay out of search indexes");
});

test("evidence links require matching exact source metadata and never trust authored destinations", () => {
  const item = { kind: "claim-evidence", id: "E-TEST", scope: "ledger", body: JSON.stringify({
    event: "EV-EVIDENCE", content_digest: evidenceDigest, artifact_discovery: discovery,
  }) };
  expect(evidenceArtifactDiscovery("P-TEST", item)).toEqual(discovery);
  expect(evidenceArtifactDiscovery("P-TEST", {
    ...item, body: JSON.stringify({ event: "EV-EVIDENCE", content_digest: evidenceDigest,
      artifact_discovery: discovery.json_path }),
  })).toEqual(discovery);
  expect(renderToStaticMarkup(<EvidenceArtifactLink problem="P-TEST" item={item} />)).toContain(discovery.human_path);
  for (const invalid of [
    { ...item, kind: "claim-review" }, { ...item, id: "E-OTHER" },
    { ...item, scope: "workshop" },
    { ...item, body: "withdrawn" },
    { ...item, body: JSON.stringify({ artifact_discovery: discovery }) },
    { ...item, body: JSON.stringify({ event: "EV-OTHER", content_digest: evidenceDigest, artifact_discovery: discovery }) },
    { ...item, body: JSON.stringify({ event: "EV-EVIDENCE", content_digest: evidenceDigest,
      artifact_discovery: discovery, scientific_status: { withdrawal: "withdrawn" } }) },
    { ...item, body: JSON.stringify({ event: "EV-EVIDENCE", content_digest: evidenceDigest,
      artifact_discovery: { ...discovery, human_path: "https://attacker.example" } }) },
  ]) expect(evidenceArtifactDiscovery("P-TEST", invalid)).toBeNull();
  expect(evidenceArtifactDiscovery("P-OTHER", item)).toBeNull();
});
