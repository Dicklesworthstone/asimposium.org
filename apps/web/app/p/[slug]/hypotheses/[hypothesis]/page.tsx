import { HypothesisItemQuerySchema } from "@asimposium/contracts/hypotheses";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { HypothesesView } from "@/components/hypotheses-view";
import { PublicReadUnavailable } from "@/components/public-read-unavailable";
import { stoaFetchHypothesis } from "@/lib/public-ledger";

interface HypothesisPageProps {
  readonly params: Promise<{ readonly slug: string; readonly hypothesis: string }>;
  readonly searchParams?: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}

const readHypothesis = cache((slug: string, hypothesis: string, through: string | undefined) =>
  stoaFetchHypothesis(slug, hypothesis, undefined, { through }),
);

async function pageInput({ params, searchParams }: HypothesisPageProps) {
  const { slug, hypothesis } = await params;
  return { slug, hypothesis, query: HypothesisItemQuerySchema.safeParse((await searchParams) ?? {}) };
}

export async function generateMetadata(props: HypothesisPageProps): Promise<Metadata> {
  const { slug, hypothesis, query } = await pageInput(props);
  const result = query.success
    ? await readHypothesis(slug, hypothesis, query.data.through)
    : undefined;
  return {
    title: `${slug} — ${hypothesis} | ASImposium`,
    description: "An exact published hypothesis, its falsifier, attribution and recorded refutation.",
    ...(result?.state !== "ok" || result.noindex
      ? { robots: { index: false, follow: false } }
      : {}),
  };
}

export default async function HypothesisPage(props: HypothesisPageProps) {
  const { slug, hypothesis, query } = await pageInput(props);
  const path = `/p/${encodeURIComponent(slug)}/hypotheses/${encodeURIComponent(hypothesis)}`;
  if (!query.success) {
    return (
      <main className="landing col problem-page" id="content">
        <h1>Invalid hypothesis cursor</h1>
        <p>An exact hypothesis accepts one non-negative through cursor.</p>
        <p><Link href={path}>Read the latest hypothesis record</Link></p>
      </main>
    );
  }
  const result = await readHypothesis(slug, hypothesis, query.data.through);
  if (result.state === "not_found") notFound();
  if (result.state === "unavailable") {
    return (
      <PublicReadUnavailable
        title={`${slug} — ${hypothesis}`}
        retryPath={`${path}${query.data.through === undefined ? "" : `?through=${query.data.through}`}`}
      />
    );
  }
  return <HypothesesView result={result} historical={query.data.through !== undefined} exactId={hypothesis} />;
}
