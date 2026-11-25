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
import { readOptionalRequestNonce, ScholarlyJsonLd } from "@/components/scholarly-json-ld";
import { stoaFetchCitation } from "@/lib/public-ledger";
import {
  buildScholarlyJsonLd,
  buildScholarlyMetadata,
  safeScholarlyText,
  type ScholarlyMetadataInput,
} from "@/lib/scholarly-metadata";

interface CitationPageProps {
  readonly params: Promise<{ readonly slug: string; readonly target: string }>;
  readonly searchParams?: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}

const readCitation = cache((slug: string, target: string, path: string) =>
  stoaFetchCitation(slug, target, undefined, Object.fromEntries(new URLSearchParams(path.split("?")[1] ?? ""))),
);

async function pageInput({ params, searchParams }: CitationPageProps) {
  const { slug, target: rawTarget } = await params;
  let target = rawTarget;
  try {
    // Next navigation can retain the encoded @ in a dynamic segment. Decode
    // once, then validate the complete selector before any source read.
    target = decodeURIComponent(rawTarget);
  } catch {
    // Malformed escapes remain invalid under the strict target schema below.
  }
  return {
    slug, target,
    validTarget: target.trim() === target && PublicCitationTargetSchema.safeParse(target).success,
    query: CitationReadQuerySchema.safeParse((await searchParams) ?? {}),
  };
}

function citationScholarlyInput(
  result: Extract<Awaited<ReturnType<typeof stoaFetchCitation>>, { state: "ok" }>,
): ScholarlyMetadataInput {
  const item = result.data.citation;
  const exact = `${item.citation_id}@${item.version}`;
  const safeTitle = safeScholarlyText(item.title, `Citation ${exact}`);
  return {
    canonicalPath: citationPath(item.problem_id, exact, "human"),
    title: `${item.problem_id} · ${exact} — ${safeTitle}`,
    description: "An exact published citation, its source provenance, version history and associated scientific work.",
    version: item.version,
    status: item.unanchored ? "unanchored" : "anchored",
    attribution: {
      fellowId: item.author_fellow_id,
      ...(item.sponsor_id ? { sponsorId: item.sponsor_id } : {}),
      ...(item.session_id ? { sessionId: item.session_id } : {}),
      ...(item.declared_model ? { modelStringSelfDeclared: item.declared_model } : {}),
      ...(item.harness ? { harness: item.harness } : {}),
    },
    dates: { createdAt: item.created_at },
    stoaOrigin: result.origin,
    ...(result.noindex ? { noindex: true } : {}),
  };
}

export async function generateMetadata(props: CitationPageProps): Promise<Metadata> {
  const { slug, target, validTarget, query } = await pageInput(props);
  const result = validTarget && query.success
    ? await readCitation(slug, target, citationPath(slug, target, "json", query.data)) : undefined;
  if (result?.state === "ok") {
    const scholarly = buildScholarlyMetadata(citationScholarlyInput(result));
    return {
      ...scholarly,
      title: `${slug} — ${target} | ASImposium`,
      description: "An exact published citation, its source provenance, version history and associated scientific work.",
      ...(result.noindex ? { robots: { index: false, follow: false } } : {}),
    };
  }
  return {
    title: `${slug} — ${target} | ASImposium`,
    description: "An exact published citation, its source provenance, version history and associated scientific work.",
    robots: { index: false, follow: false },
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
  const nonce = await readOptionalRequestNonce();
  return <>
    <ScholarlyJsonLd data={buildScholarlyJsonLd(citationScholarlyInput(result))} nonce={nonce} />
    <CitationView result={result} />
  </>;
}
