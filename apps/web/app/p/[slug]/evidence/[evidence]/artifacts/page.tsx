import {
  EvidenceArtifactsQuerySchema,
  EvidenceArtifactsTargetSchema,
  evidenceArtifactsPath,
} from "@asimposium/contracts/artifact-publications";
import { renderEvidenceArtifactsHtml } from "@asimposium/render/artifact-publications";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { PublicReadUnavailable } from "@/components/public-read-unavailable";
import { stoaFetchEvidenceArtifacts } from "@/lib/public-artifacts";
import { SITE } from "@/lib/site";

interface ArtifactsPageProps {
  readonly params: Promise<{ readonly slug: string; readonly evidence: string }>;
  readonly searchParams?: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}

const readArtifacts = cache((problem: string, evidence: string, query: string) =>
  stoaFetchEvidenceArtifacts(problem, evidence, undefined, JSON.parse(query)),
);

async function pageInput({ params, searchParams }: ArtifactsPageProps) {
  const { slug, evidence } = await params;
  const parsed = EvidenceArtifactsQuerySchema.safeParse((await searchParams) ?? {});
  const validTarget = EvidenceArtifactsTargetSchema.safeParse({
    problem_id: slug, evidence_id: evidence,
  }).success;
  return { slug, evidence, validTarget, query: parsed.success ? parsed.data : null };
}

export async function generateMetadata(props: ArtifactsPageProps): Promise<Metadata> {
  const { slug, evidence, validTarget, query } = await pageInput(props);
  const result = validTarget && query !== null
    ? await readArtifacts(slug, evidence, JSON.stringify(query)) : null;
  return {
    title: `${slug} — Research files for ${evidence} | ASImposium`,
    description: "Public research artifacts bound to an exact evidence publication, with provenance and license information.",
    ...(result?.state !== "ok" || result.noindex ? { robots: { index: false, follow: false } } : {}),
    ...(validTarget && query !== null ? {
      alternates: { canonical: `${SITE.agora}${evidenceArtifactsPath(slug, evidence, "human", query)}` },
    } : {}),
  };
}

export default async function EvidenceArtifactsPage(props: ArtifactsPageProps) {
  const { slug, evidence, validTarget, query } = await pageInput(props);
  if (!validTarget) notFound();
  if (query === null) return <main className="landing col problem-page" id="content">
    <h1>Invalid artifact collection view</h1>
    <p>Use a single evidence digest and non-negative artifact delivery cursors.
      A claim’s ledger cursor is a different sequence.</p>
    <p><Link href={evidenceArtifactsPath(slug, evidence, "human", {})}>Read current public research files</Link></p>
  </main>;
  const path = evidenceArtifactsPath(slug, evidence, "human", query);
  const result = await readArtifacts(slug, evidence, JSON.stringify(query));
  if (result.state === "not_found") notFound();
  if (result.state === "unavailable") return <PublicReadUnavailable
    title={`${slug} — Research files for ${evidence}`} retryPath={path} />;
  const face = result.data;
  const current = { evidence_digest: face.evidence_digest };
  const snapshot = { ...current, after: String(face.after), through: String(face.through) };
  return <main className="landing col problem-page" id="content">
    <header className="masthead">
      <nav aria-label="Breadcrumbs">
        <Link href={`/p/${encodeURIComponent(slug)}`}>{slug}</Link>{" / "}
        <Link href={`/r/p/${encodeURIComponent(slug)}/evidence/${encodeURIComponent(evidence)}`}>{evidence}</Link>
      </nav>
      <h1>Research files for {evidence}</h1>
      <p className="lede">Published downloads, original provenance and license information.</p>
    </header>
    {result.noindex && <p className="loop" role="note">The source requests that this public record stay out of search indexes.</p>}
    <section aria-label="Published research artifacts">
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: The shared artifact renderer validates the canonical schema and escapes authored values. */}
      <div dangerouslySetInnerHTML={{ __html: renderEvidenceArtifactsHtml(face) }} />
    </section>
    <nav aria-label="Artifact pages">
      {face.next_after !== null && <p><Link prefetch={false}
        href={evidenceArtifactsPath(slug, evidence, "human", { ...snapshot, after: String(face.next_after) })}>
        More files at this delivery snapshot
      </Link></p>}
      <p><Link prefetch={false} href={evidenceArtifactsPath(slug, evidence, "human", current)}>
        Refresh current public availability
      </Link></p>
    </nav>
    <section aria-labelledby="artifact-agent-faces">
      <h2 id="artifact-agent-faces">Canonical agent faces</h2>
      <p><a href={`${result.origin}${evidenceArtifactsPath(slug, evidence, "md", snapshot)}`}>Markdown</a>{" · "}
        <a href={`${result.origin}${evidenceArtifactsPath(slug, evidence, "json", snapshot)}`}>JSON</a></p>
    </section>
  </main>;
}
