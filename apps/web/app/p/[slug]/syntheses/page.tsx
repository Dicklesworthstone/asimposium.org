import { SynthesesListQuerySchema, synthesesListPath } from "@asimposium/contracts/syntheses";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { PublicReadUnavailable } from "@/components/public-read-unavailable";
import { SynthesesListView } from "@/components/syntheses-view";
import { stoaFetchSyntheses } from "@/lib/public-syntheses";
import { synthesisListSearch } from "@/lib/synthesis-view";

interface SynthesesPageProps {
  readonly params: Promise<{ readonly slug: string }>;
  readonly searchParams?: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}

const readSyntheses = cache((slug: string, query: string) =>
  stoaFetchSyntheses(slug, undefined, Object.fromEntries(new URLSearchParams(query))),
);

async function pageInput({ params, searchParams }: SynthesesPageProps) {
  const { slug } = await params;
  const parsed = SynthesesListQuerySchema.safeParse((await searchParams) ?? {});
  return { slug, query: parsed.success ? parsed.data : null };
}

export async function generateMetadata(props: SynthesesPageProps): Promise<Metadata> {
  const { slug, query } = await pageInput(props);
  const result = query === null ? undefined : await readSyntheses(slug, synthesisListSearch(slug, query));
  return {
    title: `${slug} — Published syntheses | ASImposium`,
    description: "Published research digests, frozen coverage, source anchors and declared omissions.",
    ...(result?.state !== "ok" || result.noindex ? { robots: { index: false, follow: false } } : {}),
  };
}

export default async function SynthesesPage(props: SynthesesPageProps) {
  const { slug, query } = await pageInput(props);
  if (query === null) return <main className="landing col problem-page" id="content">
    <h1>Invalid synthesis collection view</h1>
    <p>Use one non-negative through cursor, an optional exclusive before cursor with through, and a limit from 1 to 200.</p>
    <p><Link href={synthesesListPath(slug, "human")}>Read the latest published syntheses</Link></p>
  </main>;
  const result = await readSyntheses(slug, synthesisListSearch(slug, query));
  if (result.state === "not_found") notFound();
  if (result.state === "unavailable") return <PublicReadUnavailable
    title={`${slug} — Published syntheses`} retryPath={synthesesListPath(slug, "human", query)} />;
  return <SynthesesListView result={result} query={query} />;
}
