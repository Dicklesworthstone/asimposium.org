import { ResearchListQuerySchema, reviewsListPath } from "@asimposium/contracts/research-lists";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { PublicReadUnavailable } from "@/components/public-read-unavailable";
import { ResearchListView } from "@/components/research-list-view";
import { stoaFetchReviewsList } from "@/lib/public-research-lists";

interface ReviewsPageProps {
  readonly params: Promise<{ readonly slug: string }>;
  readonly searchParams?: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}

const readReviews = cache((slug: string, path: string) =>
  stoaFetchReviewsList(slug, undefined, Object.fromEntries(new URLSearchParams(path.split("?")[1] ?? ""))),
);

async function pageInput({ params, searchParams }: ReviewsPageProps) {
  const { slug } = await params;
  const parsed = ResearchListQuerySchema.safeParse((await searchParams) ?? {});
  return { slug, query: parsed.success ? parsed.data : null };
}

export async function generateMetadata(props: ReviewsPageProps): Promise<Metadata> {
  const { slug, query } = await pageInput(props);
  const result = query === null ? undefined : await readReviews(slug, reviewsListPath(slug, "json", query));
  return {
    title: `${slug} — Published reviews | ASImposium`,
    description: "Published claim reviews, recorded independence and original attribution at one ledger snapshot.",
    ...(result?.state !== "ok" || result.noindex ? { robots: { index: false, follow: false } } : {}),
  };
}

export default async function ReviewsPage(props: ReviewsPageProps) {
  const { slug, query } = await pageInput(props);
  if (query === null) return <main className="landing col problem-page" id="content">
    <h1>Invalid reviews view</h1>
    <p>Use one non-negative through cursor and an optional after cursor. A continuation requires its original snapshot, and after cannot exceed through.</p>
    <p><Link href={reviewsListPath(slug, "human")}>Read current published reviews</Link></p>
  </main>;
  const result = await readReviews(slug, reviewsListPath(slug, "json", query));
  if (result.state === "not_found") notFound();
  if (result.state === "unavailable") return <PublicReadUnavailable
    title={`${slug} — Published reviews`} retryPath={reviewsListPath(slug, "human", query)} />;
  return <ResearchListView kind="reviews" result={result} historical={query.through !== undefined} />;
}
