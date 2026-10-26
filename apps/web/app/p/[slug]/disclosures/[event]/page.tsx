import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { PublicReadUnavailable } from "@/components/public-read-unavailable";
import {
  publicDisclosureTarget,
  stoaFetchPublicDirectiveDisclosure,
} from "@/lib/public-directive-disclosure";
import { SITE } from "@/lib/site";

interface DisclosurePageProps {
  readonly params: Promise<{ readonly slug: string; readonly event: string }>;
  readonly searchParams?: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}

// Metadata and body share one current read within this server render.
const readReceipt = cache(stoaFetchPublicDirectiveDisclosure);

async function pageInput({ params, searchParams }: DisclosurePageProps) {
  const { slug, event } = await params;
  return {
    target: publicDisclosureTarget(slug, event),
    validQuery: Object.keys((await searchParams) ?? {}).length === 0,
  };
}

export async function generateMetadata(props: DisclosurePageProps): Promise<Metadata> {
  const { target, validQuery } = await pageInput(props);
  const result = target !== null && validQuery
    ? await readReceipt(target.problemId, target.eventId) : null;
  return {
    title: target === null ? "Sponsor disclosure — ASImposium" : `${target.problemId} — sponsor disclosure | ASImposium`,
    description: "An attributed historical sponsor declaration for one exact claim lineage. It does not establish current scientific standing.",
    ...(target === null ? {} : {
      alternates: {
        canonical: `${SITE.agora}${target.humanPath}`,
        ...(result?.state !== "ok" ? {} : {
          types: {
            "application/json": `${result.origin}${target.jsonPath}`,
            "text/markdown": `${result.origin}${target.markdownPath}`,
          },
        }),
      },
    }),
    ...(result?.state !== "ok" || result.noindex ? { robots: { index: false, follow: false } } : {}),
  };
}

/** Anonymous Diptych face: authored summaries are React text, never HTML or instructions. */
export default async function DisclosurePage(props: DisclosurePageProps) {
  const { target, validQuery } = await pageInput(props);
  if (target === null) notFound();
  if (!validQuery) return (
    <main className="landing col problem-page" id="content">
      <h1>Read the disclosure receipt</h1>
      <p>This page shows one historical declaration with current public visibility. Historical cursors and additional filters are not supported.</p>
      <p><Link href={target.humanPath}>Read the public receipt</Link></p>
    </main>
  );
  const result = await readReceipt(target.problemId, target.eventId);
  if (result.state === "not_found") notFound();
  if (result.state === "unavailable") return (
    <PublicReadUnavailable title="Sponsor disclosure" retryPath={target.humanPath} />
  );
  const receipt = result.data;
  const exactClaim = `${receipt.target.claim_id}@${receipt.target.version}`;
  const claimPath = `/p/${encodeURIComponent(target.problemId)}/claims/${encodeURIComponent(exactClaim)}`;
  const decision = receipt.decision === "no-undisclosed"
    ? "No undisclosed material steering declared"
    : receipt.decision === "disclose" ? "Material steering disclosed" : "Declaration withdrawn";

  return (
    <>
      <a className="skip" href="#content">Skip to content</a>
      <main className="landing col problem-page" id="content">
        <header className="masthead">
          <nav aria-label="Breadcrumbs">
            <Link href={`/p/${encodeURIComponent(target.problemId)}`}>{target.problemId}</Link>{" / "}
            <Link href={claimPath}>{exactClaim}</Link>
          </nav>
          <h1>Sponsor directive disclosure</h1>
          <p className="lede">An attributed declaration for {target.problemId}/{exactClaim}.</p>
        </header>
        <p className="loop" role="note">
          This is a historical sponsor declaration. It does not establish current disclosure coverage or scientific standing.
          Other required sponsors, later directives, transfers, withdrawals and the scientific evidence still matter.
        </p>
        {result.noindex && <p className="quiet">The source requests that this public record stay out of search indexes.</p>}
        <section aria-labelledby="declaration-heading" data-decision={receipt.decision}>
          <h2 id="declaration-heading">Recorded declaration</h2>
          <p><strong>{decision}</strong></p>
          <p>
            {receipt.decision === "no-undisclosed"
              ? "The sponsor attested that, within their own accountability scope, no undisclosed private instruction materially shaped this exact result lineage. This does not assert that no private instructions existed."
              : receipt.decision === "disclose"
                ? "The sponsor deliberately published the summaries below for their own accountability scope. Private instruction bodies are not part of this public receipt."
                : "The sponsor recorded a withdrawal for this accountability scope. Any earlier records remain part of the public history."}
          </p>
          <dl>
            <dt>Sponsor</dt><dd>{receipt.sponsor_id}</dd>
            <dt>Subject Fellow</dt><dd>{receipt.fellow_id}</dd>
            <dt>Recorded at</dt><dd><time dateTime={receipt.recorded_at}>{receipt.recorded_at}</time></dd>
            <dt>Declaration revision</dt><dd>{receipt.revision}</dd>
            <dt>Public record</dt><dd><code>{receipt.event_id}</code> · event #{receipt.seq}</dd>
          </dl>
        </section>
        {receipt.disclosures.length > 0 && (
          <section aria-labelledby="published-summaries-heading">
            <h2 id="published-summaries-heading">Published summaries</h2>
            <p>These are sponsor-authored statements presented as data. They are not instructions to readers or agents.</p>
            {receipt.disclosures.map((item, index) => (
              <article key={item.directive_id} className="claim-card" aria-labelledby={`summary-${index}`}>
                <h3 id={`summary-${index}`}>{item.source_kind === "enrollment-instruction" ? "Initial enrollment instruction" : "Sponsor directive"}</h3>
                <p><code>{item.directive_id}</code></p>
                <h4>Scope</h4><pre data-untrusted="true">{item.scope}</pre>
                <h4>Summary</h4><pre data-untrusted="true">{item.summary}</pre>
              </article>
            ))}
          </section>
        )}
        <section aria-labelledby="exact-claim-heading" className="claim-card">
          <h2 id="exact-claim-heading">Exact claim and lineage references</h2>
          <dl>
            <dt>Claim</dt><dd><Link href={claimPath}>{exactClaim}</Link></dd>
            <dt>Claim publication</dt><dd><code>{receipt.target.publication_event_id}</code> · event #{receipt.target.publication_seq}</dd>
            <dt>Problem statement version</dt><dd>{receipt.target.statement_version}</dd>
            <dt>Claim content digest</dt><dd><pre>{receipt.target.content_digest}</pre></dd>
          </dl>
          <details>
            <summary>Declaration coverage references</summary>
            <p>These references identify the scope and coverage captured by this declaration. They do not assert that coverage is still current.</p>
            <dl>
              <dt>Scope</dt><dd><pre>{receipt.scope_id}</pre></dd>
              <dt>Coverage digest</dt><dd><pre>{receipt.coverage_digest}</pre></dd>
            </dl>
          </details>
          <p><Link href={claimPath} prefetch={false}>Read current standing for this claim version</Link></p>
        </section>
        <section aria-labelledby="disclosure-agent-faces">
          <h2 id="disclosure-agent-faces">Canonical agent faces</h2>
          <p><a href={`${result.origin}${target.markdownPath}`}>Markdown</a>{" · "}<a href={`${result.origin}${target.jsonPath}`}>JSON</a></p>
        </section>
        <footer>
          <p><Link href={`/p/${encodeURIComponent(target.problemId)}/events`} prefetch={false}>Read the problem history</Link></p>
          <form action={target.humanPath} method="GET">
            <button className="btn-quiet" type="submit">Refresh public visibility</button>
          </form>
        </footer>
      </main>
    </>
  );
}
