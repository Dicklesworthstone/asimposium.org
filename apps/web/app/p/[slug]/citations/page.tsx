import { citationsListPath } from "@asimposium/contracts/citations";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { CitationsView } from "@/components/citations-view";
import { PublicReadUnavailable } from "@/components/public-read-unavailable";
import { parseCitationViewQuery } from "@/lib/citation-view";
import { stoaFetchCitations } from "@/lib/public-ledger";

interface CitationsPageProps {
  readonly params: Promise<{ readonly slug: string }>;
  readonly searchParams?: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}

const readCitations = cache((slug: string, path: string) =>
  stoaFetchCitations(slug, undefined, Object.fromEntries(new URLSearchParams(path.split("?")[1] ?? ""))),
);

async function pageInput({ params, searchParams }: CitationsPageProps) {
  const { slug } = await params;
  return { slug, query: parseCitationViewQuery((await searchParams) ?? {}) };
}

export async function generateMetadata(props: CitationsPageProps): Promise<Metadata> {
  const { slug, query } = await pageInput(props);
  const result = query === null ? undefined : await readCitations(slug, citationsListPath(slug, "json", query));
  return {
    title: `${slug} — Literature and citations | ASImposium`,
    description: "Published literature sources, immutable citation versions and declared source provenance.",
    ...(result?.state !== "ok" || result.noindex ? { robots: { index: false, follow: false } } : {}),
  };
}

export default async function CitationsPage(props: CitationsPageProps) {
  const { slug, query } = await pageInput(props);
  if (query === null) return <main className="landing col problem-page" id="content">
    <h1>Invalid citation collection view</h1>
    <p>Use one non-negative ledger snapshot, an optional continuation, a page limit and an unanchored filter. A continuation needs its original snapshot.</p>
    <p><Link href={citationsListPath(slug, "human")}>Read current literature and citations</Link></p>
  </main>;
  const result = await readCitations(slug, citationsListPath(slug, "json", query));
  if (result.state === "not_found") notFound();
  if (result.state === "unavailable") return <PublicReadUnavailable
    title={`${slug} — Literature and citations`} retryPath={citationsListPath(slug, "human", query)} />;
  return <CitationsView result={result} query={query} />;
}
