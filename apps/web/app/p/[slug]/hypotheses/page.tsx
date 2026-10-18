import { HypothesesQuerySchema } from "@asimposium/contracts/hypotheses";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { HypothesesView } from "@/components/hypotheses-view";
import { PublicReadUnavailable } from "@/components/public-read-unavailable";
import { stoaFetchHypotheses } from "@/lib/public-ledger";

interface HypothesesPageProps {
  readonly params: Promise<{ readonly slug: string }>;
  readonly searchParams?: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}

// Share the exact public response, including its noindex decision, within a request.
const readHypotheses = cache((slug: string, through: string | undefined, after: string | undefined) =>
  stoaFetchHypotheses(slug, undefined, { through, after }),
);

async function pageInput({ params, searchParams }: HypothesesPageProps) {
  const { slug } = await params;
  return { slug, query: HypothesesQuerySchema.safeParse((await searchParams) ?? {}) };
}

export async function generateMetadata(props: HypothesesPageProps): Promise<Metadata> {
  const { slug, query } = await pageInput(props);
  const result = query.success
    ? await readHypotheses(slug, query.data.through, query.data.after)
    : undefined;
  return {
    title: `${slug} — Hypotheses and research routes | ASImposium`,
    description: "Proposed research routes, falsifiers, predictions and recorded refutations.",
    ...(result?.state !== "ok" || result.noindex
      ? { robots: { index: false, follow: false } }
      : {}),
  };
}

export default async function HypothesesPage(props: HypothesesPageProps) {
  const { slug, query } = await pageInput(props);
  const path = `/p/${encodeURIComponent(slug)}/hypotheses`;
  if (!query.success) {
    return (
      <main className="landing col problem-page" id="content">
        <h1>Invalid hypothesis cursor</h1>
        <p>Use one non-negative integer for each of through and after, with after no greater than through.</p>
        <p><Link href={path}>Read the current hypotheses</Link></p>
      </main>
    );
  }
  const result = await readHypotheses(slug, query.data.through, query.data.after);
  if (result.state === "not_found") notFound();
  if (result.state === "unavailable") {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query.data)) {
      if (value !== undefined) params.set(key, value);
    }
    return (
      <PublicReadUnavailable
        title={`${slug} — Hypotheses`}
        retryPath={`${path}${params.size === 0 ? "" : `?${params}`}`}
      />
    );
  }
  return <HypothesesView result={result} historical={query.data.through !== undefined} />;
}
