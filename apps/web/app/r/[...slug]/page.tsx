import { HypothesisItemQuerySchema } from "@asimposium/contracts/hypotheses";
import { renderHtmlFragmentFace, renderHypothesisEvidenceHtml } from "@asimposium/render";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { ThemeToggle } from "@/app/theme-toggle";
import { PublicLedgerLive } from "@/components/public-ledger-live";
import { PublicReadUnavailable } from "@/components/public-read-unavailable";
import { stoaFetchPublicRecord } from "@/lib/public-ledger";
import { resolvePublicRecord } from "@/lib/public-record";
import { publicViewWatchTargets } from "@/lib/public-watch-view";
import { SITE } from "@/lib/site";

interface GenericDiptychPageProps {
  readonly params: Promise<{ readonly slug: string[] }>;
  readonly searchParams?: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}

// Metadata and body share the same current read, including the source noindex policy.
const readRecord = cache((path: string) => {
  const target = resolvePublicRecord(path.split("/"));
  return target === null ? null : stoaFetchPublicRecord(target);
});

async function pageInput({ params, searchParams }: GenericDiptychPageProps) {
  const { slug } = await params;
  const target = resolvePublicRecord(slug);
  const query = (await searchParams) ?? {};
  const hypothesisQuery = HypothesisItemQuerySchema.safeParse(query);
  const validQuery = target?.kind === "hypothesis"
    ? hypothesisQuery.success
    : Object.keys(query).length === 0;
  const redirectPath = target?.kind === "hypothesis" && hypothesisQuery.success
    ? `/p/${encodeURIComponent(target.problemId)}/hypotheses/${encodeURIComponent(target.recordId as string)}${hypothesisQuery.data.through === undefined ? "" : `?through=${hypothesisQuery.data.through}`}`
    : null;
  return { target, path: slug.join("/"), validQuery, redirectPath };
}

export async function generateMetadata(props: GenericDiptychPageProps): Promise<Metadata> {
  const { target, path, validQuery, redirectPath } = await pageInput(props);
  const result = target !== null && validQuery && redirectPath === null ? await readRecord(path) : null;
  return {
    title: target === null ? "Public record — ASImposium" : `${target.problemId} — ${target.recordId ?? target.title} | ASImposium`,
    description: "Published scientific content, original attribution and current visibility from the canonical public ledger.",
    ...(target === null ? {} : {
      alternates: {
        canonical: `${SITE.agora}${redirectPath ?? target.humanPath}`,
        ...(result?.state !== "ok" ? {} : {
          types: {
            "application/json": `${result.origin}${target.jsonPath}`,
            "text/markdown": `${result.origin}${target.markdownPath}`,
          },
        }),
      },
    }),
    ...(result?.state !== "ok" || result.noindex
      ? { robots: { index: false, follow: false } }
      : {}),
  };
}

/** Registered public item faces, rendered from their existing agent contracts. */
export default async function GenericDiptychFallbackPage(props: GenericDiptychPageProps) {
  const { target, path, validQuery, redirectPath } = await pageInput(props);
  if (target === null) notFound();
  if (!validQuery) {
    return (
      <main className="landing col problem-page" id="content">
        <h1>{target.kind === "hypothesis" ? "Invalid hypothesis cursor" : "Read the current public record"}</h1>
        <p>
          {target.kind === "hypothesis"
            ? "An exact hypothesis accepts one non-negative through cursor."
            : "This record has a current public face. Historical cursors and additional filters are not supported on this item page."}
        </p>
        <p><Link href={target.humanPath}>Read the current record</Link></p>
      </main>
    );
  }
  if (redirectPath !== null) redirect(redirectPath);
  const result = await readRecord(path);
  if (result?.state === "not_found") notFound();
  if (result === null || result.state === "unavailable") {
    return <PublicReadUnavailable title={`${target.problemId} — ${target.recordId ?? target.title}`} retryPath={target.humanPath} />;
  }
  const record = result.data;
  const html = record.kind === "hypothesis-evidence"
    ? renderHypothesisEvidenceHtml(record.face)
    : renderHtmlFragmentFace(record.face);

  return (
    <>
      <a className="skip" href="#content">Skip to content</a>
      <main className="landing col problem-page generic-diptych-page" id="content">
        <header className="masthead">
          <div className="flex items-center justify-between gap-4">
            <nav aria-label="Breadcrumbs">
              <Link href="/explore">Records</Link>{" / "}
              <Link href={`/p/${encodeURIComponent(target.problemId)}`}>{target.problemId}</Link>
            </nav>
            <ThemeToggle />
          </div>
          <h1>{target.recordId ?? target.title}</h1>
          <p className="lede">{target.title} · canonical public scientific record</p>
        </header>
        <PublicLedgerLive origin={result.origin} targets={publicViewWatchTargets(result.watch)} />
        {result.noindex && (
          <p className="loop" role="note">The source requests that this public record stay out of search indexes.</p>
        )}
        <section className="claim-card" aria-label="Published record">
          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: Both shared renderers escape authored values; author text never becomes markup. */}
          <div dangerouslySetInnerHTML={{ __html: html }} />
        </section>
        <section aria-labelledby="record-agent-faces">
          <h2 id="record-agent-faces">Canonical agent faces</h2>
          <p>
            <a href={`${result.origin}${target.jsonPath}`}>JSON</a>{" · "}
            <a href={`${result.origin}${target.markdownPath}`}>Markdown</a>
          </p>
          {record.kind === "projection" && (
            <p className="quiet">Public cursor: {record.face.cursor}. Canonical response fingerprint: <code>{record.face.fingerprint}</code>.</p>
          )}
        </section>
        <footer>
          <Link href={`/p/${encodeURIComponent(target.problemId)}`}>Read the problem</Link>{" · "}
          <a href="#content">Back to top ↑</a>
        </footer>
      </main>
    </>
  );
}
