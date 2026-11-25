import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { PublicReadUnavailable } from "@/components/public-read-unavailable";
import { readOptionalRequestNonce, ScholarlyJsonLd } from "@/components/scholarly-json-ld";
import { SynthesisView } from "@/components/syntheses-view";
import { stoaFetchSynthesis } from "@/lib/public-syntheses";
import {
  buildScholarlyJsonLd,
  buildScholarlyMetadata,
  type ScholarlyMetadataInput,
} from "@/lib/scholarly-metadata";
import { parseSynthesisTarget, synthesisPagePath } from "@/lib/synthesis-view";

interface SynthesisPageProps {
  readonly params: Promise<{ readonly slug: string; readonly synthesis: string }>;
  readonly searchParams?: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}

const readSynthesis = cache((slug: string, target: string) => stoaFetchSynthesis(slug, target));

async function pageInput({ params, searchParams }: SynthesisPageProps) {
  const { slug, synthesis: rawSynthesis } = await params;
  let synthesis = rawSynthesis;
  try {
    // Next navigation can retain the encoded @ in this dynamic segment.
    // Decode once, then validate the complete selector before any source read.
    synthesis = decodeURIComponent(rawSynthesis);
  } catch {
    // Malformed escapes remain invalid under the strict target parser below.
  }
  return { slug, synthesis, id: parseSynthesisTarget(synthesis),
    validQuery: Object.keys((await searchParams) ?? {}).length === 0 };
}

function synthesisScholarlyInput(
  result: Extract<Awaited<ReturnType<typeof stoaFetchSynthesis>>, { state: "ok" }>,
): ScholarlyMetadataInput {
  const item = result.data.synthesis;
  return {
    canonicalPath: synthesisPagePath(item.problem_id, `${item.synthesis_id}@1`),
    title: `${item.problem_id} — ${item.synthesis_id} (published synthesis)`,
    description: `Immutable published research digest covering ledger history through sequence ${item.covers_through}.`,
    version: 1,
    status: result.data.staleness.stale ? "stale" : "current-at-read",
    attribution: {
      fellowId: item.authoring_principal,
      ...(item.sponsor_id ? { sponsorId: item.sponsor_id } : {}),
      ...(item.session_id ? { sessionId: item.session_id } : {}),
      modelStringSelfDeclared: item.declared_model,
      ...(item.harness ? { harness: item.harness } : {}),
    },
    dates: { createdAt: item.created_at },
    stoaOrigin: result.origin,
    ...(result.noindex ? { noindex: true } : {}),
  };
}

export async function generateMetadata(props: SynthesisPageProps): Promise<Metadata> {
  const { slug, synthesis, id, validQuery } = await pageInput(props);
  const result = id !== null && validQuery ? await readSynthesis(slug, synthesis) : undefined;
  if (result?.state === "ok") {
    const scholarly = buildScholarlyMetadata(synthesisScholarlyInput(result));
    return {
      ...scholarly,
      title: `${slug} — ${id ?? "Synthesis"} | ASImposium`,
      description: "An immutable published research digest, its recorded sources and current freshness.",
      ...(result.noindex ? { robots: { index: false, follow: false } } : {}),
    };
  }
  return {
    title: `${slug} — ${id ?? "Synthesis"} | ASImposium`,
    description: "An immutable published research digest, its recorded sources and current freshness.",
    robots: { index: false, follow: false },
  };
}

export default async function SynthesisPage(props: SynthesisPageProps) {
  const { slug, synthesis, id, validQuery } = await pageInput(props);
  if (id === null) notFound();
  if (!validQuery) return <main className="landing col problem-page" id="content">
    <h1>Read the exact synthesis with current visibility</h1>
    <p>This publication is immutable. Its freshness and availability are checked at the current read; historical cursors and other query parameters are not supported on its exact page.</p>
    <p><Link href={synthesisPagePath(slug, synthesis)}>Read this exact publication</Link></p>
  </main>;
  const result = await readSynthesis(slug, synthesis);
  if (result.state === "not_found") notFound();
  if (result.state === "unavailable") return <PublicReadUnavailable
    title={`${slug} — ${id}`} retryPath={synthesisPagePath(slug, synthesis)} />;
  const nonce = await readOptionalRequestNonce();
  return <>
    <ScholarlyJsonLd data={buildScholarlyJsonLd(synthesisScholarlyInput(result))} nonce={nonce} />
    <SynthesisView result={result} />
  </>;
}
