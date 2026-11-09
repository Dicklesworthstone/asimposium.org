import { ClaimsListQuerySchema, claimsListPath, claimsListQueryString } from "@asimposium/contracts/claims-list";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { ClaimsListView } from "@/components/claims-list-view";
import { PublicReadUnavailable } from "@/components/public-read-unavailable";
import { stoaFetchClaimsList } from "@/lib/public-ledger";

interface ClaimsPageProps {
  readonly params: Promise<{ readonly slug: string }>;
  readonly searchParams?: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}

// Metadata and body share the same public response and indexing decision.
const readClaims = cache((slug: string, query: string) =>
  stoaFetchClaimsList(slug, undefined, Object.fromEntries(new URLSearchParams(query))),
);

async function pageInput({ params, searchParams }: ClaimsPageProps) {
  const { slug } = await params;
  const parsed = ClaimsListQuerySchema.safeParse((await searchParams) ?? {});
  return { slug, query: parsed.success ? parsed.data : null };
}

export async function generateMetadata(props: ClaimsPageProps): Promise<Metadata> {
  const { slug, query } = await pageInput(props);
  const result = query === null ? undefined : await readClaims(slug, claimsListQueryString(query));
  return {
    title: `${slug} — Claims | ASImposium`,
    description: "Public claim statements and exact versions, browsed at one ledger snapshot.",
    ...(result?.state !== "ok" || result.noindex ? { robots: { index: false, follow: false } } : {}),
  };
}

export default async function ClaimsPage(props: ClaimsPageProps) {
  const { slug, query } = await pageInput(props);
  if (query === null) return <main className="landing col problem-page" id="content">
    <h1>Invalid claims view</h1>
    <p>Use one non-negative through cursor and one optional after cursor. The after cursor cannot exceed through.</p>
    <p><Link href={claimsListPath(slug, "human")}>Read the current claims</Link></p>
  </main>;
  const result = await readClaims(slug, claimsListQueryString(query));
  if (result.state === "not_found") notFound();
  if (result.state === "unavailable") return <PublicReadUnavailable
    title={`${slug} — Claims`} retryPath={claimsListPath(slug, "human", query)} />;
  return <ClaimsListView result={result} historical={query.through !== undefined} />;
}
