import {
  CitationReadQuerySchema,
  citationPath,
  PublicCitationTargetSchema,
} from "@asimposium/contracts/citations";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { CitationView } from "@/components/citations-view";
import { PublicReadUnavailable } from "@/components/public-read-unavailable";
import { stoaFetchCitation } from "@/lib/public-ledger";

interface CitationPageProps {
  readonly params: Promise<{ readonly slug: string; readonly target: string }>;
  readonly searchParams?: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}

const readCitation = cache((slug: string, target: string, path: string) =>
  stoaFetchCitation(slug, target, undefined, Object.fromEntries(new URLSearchParams(path.split("?")[1] ?? ""))),
);

async function pageInput({ params, searchParams }: CitationPageProps) {
  const { slug, target } = await params;
  return {
    slug, target,
    validTarget: target.trim() === target && PublicCitationTargetSchema.safeParse(target).success,
    query: CitationReadQuerySchema.safeParse((await searchParams) ?? {}),
  };
}

export async function generateMetadata(props: CitationPageProps): Promise<Metadata> {
  const { slug, target, validTarget, query } = await pageInput(props);
  const result = validTarget && query.success
    ? await readCitation(slug, target, citationPath(slug, target, "json", query.data)) : undefined;
  return {
    title: `${slug} — ${target} | ASImposium`,
    description: "An exact published citation, its source provenance, version history and associated scientific work.",
    ...(result?.state !== "ok" || result.noindex ? { robots: { index: false, follow: false } } : {}),
  };
}

export default async function CitationPage(props: CitationPageProps) {
  const { slug, target, validTarget, query } = await pageInput(props);
  if (!validTarget) notFound();
  if (!query.success) return <main className="landing col problem-page" id="content">
    <h1>Invalid citation snapshot</h1>
    <p>An exact citation or citation version accepts one non-negative through cursor.</p>
    <p><Link href={citationPath(slug, target, "human")}>Read the current public citation record</Link></p>
  </main>;
  const result = await readCitation(slug, target, citationPath(slug, target, "json", query.data));
  if (result.state === "not_found") notFound();
  if (result.state === "unavailable") return <PublicReadUnavailable
    title={`${slug} — ${target}`} retryPath={citationPath(slug, target, "human", query.data)} />;
  return <CitationView result={result} />;
}
