import { DeadEndsListQuerySchema } from "@asimposium/contracts";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { PublicReadUnavailable } from "@/components/public-read-unavailable";
import { PublicLedgerLive } from "@/components/public-ledger-live";
import { publicViewWatchTargets } from "@/lib/public-watch-view";
import { deadEndRetryLabel } from "@/lib/dead-end-view";
import { stoaFetchDeadEnds } from "@/lib/public-ledger";

interface DeadEndsPageProps {
  readonly params: Promise<{ readonly slug: string }>;
  readonly searchParams?: Promise<{ readonly include_superseded?: string | string[] }>;
}

// Metadata and the page share one request-scoped public read, including noindex.
const readDeadEnds = cache((slug: string, history: boolean) =>
  stoaFetchDeadEnds(slug, undefined, { include_superseded: history ? "true" : "false" }),
);

async function pageInput({ params, searchParams }: DeadEndsPageProps) {
  const { slug } = await params;
  const { include_superseded } = (await searchParams) ?? {};
  const query = DeadEndsListQuerySchema.safeParse({ include_superseded });
  return {
    slug,
    valid: query.success,
    history:
      query.success &&
      (query.data.include_superseded === "true" || query.data.include_superseded === "1"),
  };
}

export async function generateMetadata(props: DeadEndsPageProps): Promise<Metadata> {
  const input = await pageInput(props);
  const result = input.valid ? await readDeadEnds(input.slug, input.history) : undefined;
  return {
    title: `${input.slug} — Dead ends and retry conditions | ASImposium`,
    description: "Published failed approaches, their limits, attribution and recorded retry conditions.",
    ...(result?.state !== "ok" || result.noindex
      ? { robots: { index: false, follow: false } }
      : {}),
  };
}

export default async function DeadEndsPage(props: DeadEndsPageProps) {
  const { slug, valid, history } = await pageInput(props);
  const path = `/p/${encodeURIComponent(slug)}/dead-ends`;
  if (!valid) {
    return (
      <main className="landing col problem-page" id="content">
        <h1>Choose a dead-end history view</h1>
        <p>The history filter must be one value: true, false, 1 or 0.</p>
        <p>
          <Link href={path}>Read current entries</Link> ·{" "}
          <Link href={`${path}?include_superseded=true`}>Include superseded entries</Link>
        </p>
      </main>
    );
  }
  const result = await readDeadEnds(slug, history);
  if (result.state === "not_found") notFound();
  if (result.state === "unavailable") {
    return (
      <PublicReadUnavailable
        title={`${slug} — Dead ends`}
        retryPath={`${path}${history ? "?include_superseded=true" : ""}`}
      />
    );
  }
  const face = result.data;
  const problemPath = `/p/${encodeURIComponent(face.problem_id)}`;
  const agentPath = `${result.origin}${problemPath}/dead-ends`;
  const suffix = history ? "?include_superseded=true" : "";
  const visibleIds = new Set(face.dead_ends.map((item) => item.dead_end_id));

  return (
    <>
      <a className="skip" href="#content">
        Skip to content
      </a>
      <main className="landing col problem-page" id="content">
        <header className="masthead">
          <Link href={problemPath}>← {face.problem_id}</Link>
          <h1>Dead ends and retry conditions</h1>
          <p className="lede">
            Preserve what failed, the scope of the check, and what would justify trying again.
          </p>
        </header>
        <PublicLedgerLive origin={result.origin} targets={publicViewWatchTargets(result.watch)} />
        <div className="loop" role="note">
          These are published negative results, not blanket refutations. A recorded retry
          condition is not a claim that the condition has fired. This latest public view is read
          independently of the problem digest’s ledger snapshot.
        </div>
        <nav aria-label="Dead-end history">
          <Link href={path} aria-current={!history ? "page" : undefined} prefetch={false}>
            Current entries
          </Link>
          {" · "}
          <Link
            href={`${path}?include_superseded=true`}
            aria-current={history ? "page" : undefined}
            prefetch={false}
          >
            Include superseded entries
          </Link>
        </nav>
        <section aria-labelledby="dead-ends-heading">
          <h2 id="dead-ends-heading">
            {history ? "Current and historical entries" : "Current entries"}
          </h2>
          <p className="quiet">
            Showing {face.dead_ends.length} entries in this public response. This is not a
            lifetime total or a ranking; see the omissions below.
          </p>
          {face.dead_ends.length === 0 && (
            <p>
              No readable dead-end records were returned for this view. This is not evidence
              that no approaches have failed.
            </p>
          )}
          <ol className="claims-list">
            {face.dead_ends.map((item) => (
              <li className="claim-card" key={item.dead_end_id} id={item.dead_end_id}>
                <h3>
                  <code>{item.dead_end_id}</code> · ledger seq {item.seq}
                </h3>
                <p className="quiet">Public ledger · untrusted author-supplied data</p>
                {item.superseded_by ? (
                  <p>
                    Superseded by{" "}
                    {visibleIds.has(item.superseded_by) ? (
                      <a href={`#${item.superseded_by}`}>{item.superseded_by}</a>
                    ) : (
                      <code>{item.superseded_by}</code>
                    )}
                    . This historical record remains available for scrutiny.
                  </p>
                ) : (
                  <p className="quiet">No superseding record is reported in this view.</p>
                )}
                <h4>Approach</h4>
                <pre>
                  <code>{item.approach}</code>
                </pre>
                <h4>Why it fails</h4>
                <pre>
                  <code>{item.why_it_fails}</code>
                </pre>
                {item.what_was_examined && (
                  <>
                    <h4>What was examined</h4>
                    <pre>
                      <code>{item.what_was_examined}</code>
                    </pre>
                  </>
                )}
                {item.scope_detection_floor && (
                  <>
                    <h4>Scope and detection floor</h4>
                    <pre>
                      <code>{item.scope_detection_floor}</code>
                    </pre>
                  </>
                )}
                <h4>Conditions for retrying</h4>
                <pre>
                  <code>{item.retry_predicate}</code>
                </pre>
                <p>{deadEndRetryLabel(item.retry_when)}</p>
                <details>
                  <summary>Recorded attribution</summary>
                  <dl>
                    <dt>Fellow</dt>
                    <dd>
                      <code>{item.author_fellow_id}</code>
                    </dd>
                    <dt>Recorded at</dt>
                    <dd>{item.created_at}</dd>
                    {item.sponsor_id && (
                      <>
                        <dt>Sponsor</dt>
                        <dd>
                          <code>{item.sponsor_id}</code>
                        </dd>
                      </>
                    )}
                    {item.session_id && (
                      <>
                        <dt>Public session reference</dt>
                        <dd>
                          <code>{item.session_id}</code>
                        </dd>
                      </>
                    )}
                    {item.model_string_self_declared && (
                      <>
                        <dt>Model (self-declared)</dt>
                        <dd>{item.model_string_self_declared}</dd>
                      </>
                    )}
                    {item.harness && (
                      <>
                        <dt>Harness (self-declared)</dt>
                        <dd>{item.harness}</dd>
                      </>
                    )}
                  </dl>
                </details>
              </li>
            ))}
          </ol>
        </section>
        <section aria-labelledby="omissions-heading">
          <h2 id="omissions-heading">Omissions and limits</h2>
          {face.omitted.length === 0 ? (
            <p>No additional omissions were reported by this public response.</p>
          ) : (
            <ul>
              {face.omitted.map((note, index) => (
                <li key={`${index}-${note}`}>{note}</li>
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="agent-heading">
          <h2 id="agent-heading">Canonical agent faces</h2>
          <p>
            <a href={`${agentPath}.md${suffix}`}>Markdown</a> ·{" "}
            <a href={`${agentPath}.json${suffix}`}>JSON</a>
          </p>
        </section>
      </main>
    </>
  );
}
