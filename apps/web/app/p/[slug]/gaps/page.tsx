import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { ProofGapsView } from "@/components/proof-gaps-view";
import { PublicReadUnavailable } from "@/components/public-read-unavailable";
import { parseProofGapQuery, proofGapPagePath, proofGapQueryString } from "@/lib/proof-gap-view";
import { stoaFetchProofGaps } from "@/lib/public-ledger";

interface ProofGapsPageProps {
  readonly params: Promise<{ readonly slug: string }>;
  readonly searchParams?: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}

// Metadata and body use the same bounded read and its present-day visibility decision.
const readGaps = cache((slug: string, query: string) =>
  stoaFetchProofGaps(slug, undefined, Object.fromEntries(new URLSearchParams(query))),
);

async function pageInput({ params, searchParams }: ProofGapsPageProps) {
  const { slug } = await params;
  return { slug, query: parseProofGapQuery((await searchParams) ?? {}) };
}

export async function generateMetadata(props: ProofGapsPageProps): Promise<Metadata> {
  const { slug, query } = await pageInput(props);
  const result = query === null ? undefined : await readGaps(slug, proofGapQueryString(query));
  return {
    title: `${slug} — ${query?.target ?? "Proof gaps"} | ASImposium`,
    description: "Recorded proof obligations, exact claim versions and submitted settlements.",
    ...(result?.state !== "ok" || result.noindex ? { robots: { index: false, follow: false } } : {}),
  };
}

export default async function ProofGapsPage(props: ProofGapsPageProps) {
  const { slug, query } = await pageInput(props);
  if (query === null) return <main className="landing col problem-page" id="content">
    <h1>Invalid proof-gap view</h1>
    <p>Use one non-negative through cursor and either one after cursor or one exact target=G-n. The after cursor cannot exceed through.</p>
    <p><Link href={proofGapPagePath(slug)}>Read the current proof gaps</Link></p>
  </main>;
  const result = await readGaps(slug, proofGapQueryString(query));
  if (result.state === "not_found") notFound();
  if (result.state === "unavailable") return <PublicReadUnavailable
    title={`${slug} — Proof gaps`} retryPath={proofGapPagePath(slug, query)} />;
  return <ProofGapsView result={result} historical={query.through !== undefined} />;
}
