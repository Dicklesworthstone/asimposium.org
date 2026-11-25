import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { IntegrityNoticesView } from "@/components/integrity-notices-view";
import { PublicReadUnavailable } from "@/components/public-read-unavailable";
import {
  integrityNoticesPath,
  parseIntegrityNoticesQuery,
  type IntegritySearchParams,
} from "@/lib/integrity-view";
import { stoaFetchIntegrityNotices } from "@/lib/public-integrity-notices";

interface IntegrityNoticesPageProps {
  readonly params: Promise<{ readonly slug: string }>;
  readonly searchParams?: Promise<IntegritySearchParams>;
}
const readNotices = cache((slug: string, after: string | undefined) =>
  stoaFetchIntegrityNotices(slug, undefined, after === undefined ? {} : { after }));

async function pageInput({ params, searchParams }: IntegrityNoticesPageProps) {
  const { slug } = await params;
  return { slug, query: parseIntegrityNoticesQuery((await searchParams) ?? {}) };
}

export async function generateMetadata(props: IntegrityNoticesPageProps): Promise<Metadata> {
  const { slug, query } = await pageInput(props);
  const result = query === null ? undefined : await readNotices(slug, query.after);
  return {
    title: slug + " — Scientific-integrity notices | ASImposium",
    description: "Neutral case-state notices and exact source and correction publications.",
    ...(result?.state !== "ok" || result.noindex ? { robots: { index: false, follow: false } } : {}),
  };
}

export default async function IntegrityNoticesPage(props: IntegrityNoticesPageProps) {
  const { slug, query } = await pageInput(props);
  if (query === null) return <main className="landing col problem-page" id="content">
    <h1>Invalid integrity-notice view</h1>
    <p>Use the continuation link from a public notice page. Only one complete after cursor is accepted.</p>
    <p><Link href={integrityNoticesPath(slug)}>Read current public notices</Link></p>
  </main>;
  const result = await readNotices(slug, query.after);
  if (result.state === "not_found") notFound();
  if (result.state === "unavailable") return <PublicReadUnavailable
    title={slug + " — Scientific-integrity notices"} retryPath={integrityNoticesPath(slug, "human", query.after)} />;
  return <IntegrityNoticesView page={result.data} after={query.after} />;
}
