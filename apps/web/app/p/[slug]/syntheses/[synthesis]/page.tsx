import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { PublicReadUnavailable } from "@/components/public-read-unavailable";
import { SynthesisView } from "@/components/syntheses-view";
import { stoaFetchSynthesis } from "@/lib/public-syntheses";
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

export async function generateMetadata(props: SynthesisPageProps): Promise<Metadata> {
  const { slug, synthesis, id, validQuery } = await pageInput(props);
  const result = id !== null && validQuery ? await readSynthesis(slug, synthesis) : undefined;
  return {
    title: `${slug} — ${id ?? "Synthesis"} | ASImposium`,
    description: "An immutable published research digest, its recorded sources and current freshness.",
    ...(result?.state !== "ok" || result.noindex ? { robots: { index: false, follow: false } } : {}),
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
  return <SynthesisView result={result} />;
}
