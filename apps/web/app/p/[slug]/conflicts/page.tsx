import { conflictsListPath } from "@asimposium/contracts/conflicts";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { ConflictsView } from "@/components/conflicts-view";
import { PublicReadUnavailable } from "@/components/public-read-unavailable";
import { parseConflictViewQuery, stoaFetchConflicts } from "@/lib/public-conflicts";

interface ConflictsPageProps {
  readonly params: Promise<{ readonly slug: string }>;
  readonly searchParams?: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}

// One request-scoped read supplies metadata and content with the same current
// visibility decision. It is not a persistent cache of historical author text.
const readConflicts = cache((slug: string, path: string) =>
  stoaFetchConflicts(slug, undefined, Object.fromEntries(new URLSearchParams(path.split("?")[1] ?? ""))),
);

async function pageInput({ params, searchParams }: ConflictsPageProps) {
  const { slug } = await params;
  const query = parseConflictViewQuery((await searchParams) ?? {});
  return { slug, query };
}

export async function generateMetadata(props: ConflictsPageProps): Promise<Metadata> {
  const { slug, query } = await pageInput(props);
  const result = query === null ? undefined : await readConflicts(slug, conflictsListPath(slug, "json", query));
  return {
    title: `${slug} — ${query?.target ?? "Scientific disagreements"} | ASImposium`,
    description: "Exact claim disagreements, their aligned scope and definitions, proposed tests and recorded resolutions.",
    ...(result?.state !== "ok" || result.noindex ? { robots: { index: false, follow: false } } : {}),
  };
}

export default async function ConflictsPage(props: ConflictsPageProps) {
  const { slug, query } = await pageInput(props);
  if (query === null) return <main className="landing col problem-page" id="content">
    <h1>Invalid conflict collection view</h1>
    <p>Use one ledger snapshot with an optional continuation and recorded status, or one exact conflict identifier. A continuation needs its original snapshot; an exact target cannot be combined with a continuation or status filter.</p>
    <p><Link href={conflictsListPath(slug, "human")}>Read current scientific disagreements</Link></p>
  </main>;
  const result = await readConflicts(slug, conflictsListPath(slug, "json", query));
  if (result.state === "not_found") notFound();
  if (result.state === "unavailable") return <PublicReadUnavailable
    title={`${slug} — Scientific disagreements`} retryPath={conflictsListPath(slug, "human", query)} />;
  return <ConflictsView result={result} query={query} />;
}
