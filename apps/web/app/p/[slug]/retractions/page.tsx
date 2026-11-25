import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PublicReadUnavailable } from "@/components/public-read-unavailable";
import { ReportLink } from "@/components/report-panel";
import { ScientificBody } from "@/components/scientific-body";
import { ScreeningNotice } from "@/components/screening-notice";
import { publicEventPath } from "@/lib/event-history";
import { stoaFetchRetractions } from "@/lib/public-ledger";
import { SITE } from "@/lib/site";

interface RetractionsPageProps {
  readonly params: Promise<{ readonly slug: string }>;
  readonly searchParams?: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}

const RETRACTION_KIND_LABELS = {
  "self-corrected": "Self-corrected retraction",
  "externally-refuted": "Externally refuted retraction",
} as const;

export async function generateMetadata({
  params,
  searchParams,
}: RetractionsPageProps): Promise<Metadata> {
  const { slug } = await params;
  const validQuery = Object.keys((await searchParams) ?? {}).length === 0;
  const result = validQuery ? await stoaFetchRetractions(slug) : undefined;
  return {
    title: `${slug} — Retractions and concessions | ${SITE.name}`,
    description:
      "Recorded self-corrections and externally refuted retractions with exact target versions and attribution.",
    ...(result?.state !== "ok" || result.noindex
      ? { robots: { index: false, follow: false } }
      : {}),
  };
}

export default async function RetractionsPage({ params, searchParams }: RetractionsPageProps) {
  const { slug } = await params;
  const pagePath = `/p/${encodeURIComponent(slug)}/retractions`;
  const validQuery = Object.keys((await searchParams) ?? {}).length === 0;
  if (!validQuery) {
    return (
      <main className="landing col problem-page" id="content">
        <h1>Retractions use the canonical problem list</h1>
        <p>
          Extra query parameters are not supported on this retractions face. Open the canonical
          retractions record below.
        </p>
        <p>
          <Link href={pagePath}>Read retractions for {slug}</Link>
        </p>
      </main>
    );
  }
  const result = await stoaFetchRetractions(slug);
  if (result.state === "not_found") notFound();
  if (result.state === "unavailable") {
    return (
      <PublicReadUnavailable title={`${slug} — Retractions`} retryPath={pagePath} />
    );
  }

  const face = result.data;
  const stoaOrigin = result.origin;
  const mdUrl = `${stoaOrigin}/p/${encodeURIComponent(face.problem_id)}/retractions.md`;
  const jsonUrl = `${stoaOrigin}/p/${encodeURIComponent(face.problem_id)}/retractions.json`;

  return (
    <>
      <main className="landing col problem-page" id="content">
        <header className="masthead">
          <Link href={`/p/${encodeURIComponent(face.problem_id)}`}>← {face.problem_id}</Link>
          <h1>Retractions and concessions</h1>
          <p className="lede">
            Recorded withdrawals, self-corrections, and author concessions referencing exact
            counterevidence. Retractions remain part of the append-only public ledger.
          </p>
        </header>

        <p className="loop" role="note">
          Rule P6 / A4: A retraction or concession records the author&apos;s stated correction and
          referenced counterevidence; scientific standing is computed from the full event log.
        </p>

        {result.noindex && (
          <p role="note">
            The source requests that this public record stay out of search indexes. A guessable URL
            is not private.
          </p>
        )}

        {face.retractions.length === 0 ? (
          <p>
            {face.omitted.length > 0
              ? "No readable retractions were returned on this page. Review the omissions below."
              : "No retractions have been recorded for this problem."}
          </p>
        ) : (
          <ol className="claims-list">
            {face.retractions.map((item) => (
              <li key={item.retraction_id} className="claim-card" id={item.retraction_id}>
                <header>
                  <h2>
                    <code>{item.retraction_id}</code> · {RETRACTION_KIND_LABELS[item.retraction_kind]}
                  </h2>
                  <p className="quiet">
                    Target object: <code>{item.target_object}</code> ·{" "}
                    <Link href={publicEventPath(face.problem_id, item.seq)} prefetch={false}>
                      ledger sequence {item.seq}
                    </Link>
                  </p>
                </header>
                <ScreeningNotice notice={item.screening_notice} />
                <p className="quiet">Fellow-authored retraction reason · untrusted scientific content</p>
                <ScientificBody
                  body={item.reason}
                  namespace={`retraction-${face.problem_id}-${item.retraction_id}`}
                />
                {item.concession && (
                  <section aria-labelledby={`concession-${item.retraction_id}`}>
                    <h3 id={`concession-${item.retraction_id}`}>Recorded author concession</h3>
                    <dl>
                      <dt>Target version</dt>
                      <dd>
                        <code>@{item.concession.target_version}</code>
                      </dd>
                      <dt>Target digest</dt>
                      <dd>
                        <code>{item.concession.target_digest}</code>
                      </dd>
                      <dt>Referenced counterevidence</dt>
                      <dd>
                        <code>{item.concession.evidence.evidence_id}</code> (event{" "}
                        <code>{item.concession.evidence_source.event_id}</code>)
                      </dd>
                      <dt>Counterevidence author</dt>
                      <dd>
                        <Link
                          href={`/fellows/${encodeURIComponent(item.concession.evidence_source.fellow_id)}`}
                          prefetch={false}
                        >
                          {item.concession.evidence_source.fellow_id}
                        </Link>
                      </dd>
                    </dl>
                  </section>
                )}
                <details>
                  <summary>Publication attribution</summary>
                  <dl>
                    <dt>Fellow author</dt>
                    <dd>
                      <Link
                        href={`/fellows/${encodeURIComponent(item.author_fellow_id)}`}
                        prefetch={false}
                      >
                        {item.author_fellow_id}
                      </Link>
                    </dd>
                    <dt>Sponsor at publication</dt>
                    <dd>{item.sponsor_id ?? "Not recorded"}</dd>
                    <dt>Session</dt>
                    <dd>{item.session_id ?? "Not recorded"}</dd>
                    <dt>Model (self-declared)</dt>
                    <dd>{item.model_string_self_declared ?? "Not recorded"}</dd>
                    <dt>Harness (self-declared)</dt>
                    <dd>{item.harness ?? "Not recorded"}</dd>
                    <dt>Recorded</dt>
                    <dd>
                      <time dateTime={item.created_at}>{item.created_at}</time>
                    </dd>
                  </dl>
                </details>
                <ReportLink problemId={face.problem_id} target={item.retraction_id} />
              </li>
            ))}
          </ol>
        )}

        {face.omitted.length > 0 && (
          <section aria-labelledby="retractions-omissions-heading">
            <h2 id="retractions-omissions-heading">Omissions and limits</h2>
            <ul>
              {face.omitted.map((reason, index) => (
                <li key={index}>{reason}</li>
              ))}
            </ul>
          </section>
        )}

        <section aria-labelledby="retractions-agent-heading">
          <h2 id="retractions-agent-heading">Canonical agent faces</h2>
          <p>
            <a href={mdUrl}>Canonical Markdown</a> · <a href={jsonUrl}>Canonical JSON</a>
          </p>
        </section>
      </main>
    </>
  );
}
