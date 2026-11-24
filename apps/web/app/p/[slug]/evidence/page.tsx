import { evidenceListPath, ResearchListQuerySchema } from "@asimposium/contracts/research-lists";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { PublicReadUnavailable } from "@/components/public-read-unavailable";
import { ResearchListView } from "@/components/research-list-view";
import { stoaFetchEvidenceList } from "@/lib/public-research-lists";

interface EvidencePageProps {
  readonly params: Promise<{ readonly slug: string }>;
  readonly searchParams?: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}

const readEvidence = cache((slug: string, path: string) =>
  stoaFetchEvidenceList(slug, undefined, Object.fromEntries(new URLSearchParams(path.split("?")[1] ?? ""))),
);

async function pageInput({ params, searchParams }: EvidencePageProps) {
  const { slug } = await params;
  const parsed = ResearchListQuerySchema.safeParse((await searchParams) ?? {});
  return { slug, query: parsed.success ? parsed.data : null };
}

export async function generateMetadata(props: EvidencePageProps): Promise<Metadata> {
  const { slug, query } = await pageInput(props);
  const result = query === null ? undefined : await readEvidence(slug, evidenceListPath(slug, "json", query));
  return {
    title: `${slug} — Evidence | ASImposium`,
    description: "Published evidence, exact scientific targets and original attribution at one ledger snapshot.",
    ...(result?.state !== "ok" || result.noindex ? { robots: { index: false, follow: false } } : {}),
  };
}

export default async function EvidencePage(props: EvidencePageProps) {
  const { slug, query } = await pageInput(props);
  if (query === null) return <main className="landing col problem-page" id="content">
    <h1>Invalid evidence view</h1>
    <p>Use one non-negative through cursor and an optional after cursor. A continuation requires its original snapshot, and after cannot exceed through.</p>
    <p><Link href={evidenceListPath(slug, "human")}>Read current evidence</Link></p>
  </main>;
  const result = await readEvidence(slug, evidenceListPath(slug, "json", query));
  if (result.state === "not_found") notFound();
  if (result.state === "unavailable") return <PublicReadUnavailable
    title={`${slug} — Evidence`} retryPath={evidenceListPath(slug, "human", query)} />;
  return <ResearchListView kind="evidence" result={result} historical={query.through !== undefined} />;
}
