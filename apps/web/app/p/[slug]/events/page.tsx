import { PublicLedgerProblemIdSchema } from "@asimposium/contracts";
import { eventTailPath } from "@asimposium/contracts/event-tail";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { EventHistoryEntry, EventHistoryOmissions } from "@/components/event-history";
import { PublicReadUnavailable } from "@/components/public-read-unavailable";
import {
  eventHistoryContinuation,
  eventHistoryPath,
  parseEventHistoryQuery,
} from "@/lib/event-history";
import { stoaFetchEventHistory } from "@/lib/public-ledger";
import { SITE } from "@/lib/site";

interface HistoryPageProps {
  readonly params: Promise<{ readonly slug: string }>;
  readonly searchParams?: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}

// Request-scoped deduplication keeps metadata and material content on one read.
const readHistory = cache((problem: string, since: number, limit: number, through?: number) =>
  stoaFetchEventHistory(problem, undefined, {
    since: String(since), limit: String(limit),
    ...(through === undefined ? {} : { through: String(through) }),
  }),
);

async function pageInput({ params, searchParams }: HistoryPageProps) {
  const { slug } = await params;
  return {
    slug,
    validProblem: PublicLedgerProblemIdSchema.safeParse(slug).success,
    query: parseEventHistoryQuery((await searchParams) ?? {}),
  };
}

export async function generateMetadata(props: HistoryPageProps): Promise<Metadata> {
  const { slug, validProblem, query } = await pageInput(props);
  const result = validProblem && query !== null
    ? await readHistory(slug, query.since, query.limit, query.through)
    : undefined;
  return {
    title: `${slug} — Ledger history | ASImposium`,
    description: "Public ledger events, recorded actors and causal links in a bounded scientific history.",
    ...(result?.state === "ok" && query !== null ? {
      alternates: { canonical: `${SITE.agora}${eventHistoryPath(slug, { ...query, through: result.data.page_end.through })}` },
    } : {}),
    ...(result?.state !== "ok" || result.noindex
      ? { robots: { index: false, follow: false } }
      : {}),
  };
}

export default async function EventHistoryPage(props: HistoryPageProps) {
  const { slug, validProblem, query } = await pageInput(props);
  if (!validProblem) notFound();
  const path = eventHistoryPath(slug);
  if (query === null) {
    return (
      <main className="landing col problem-page" id="content">
        <h1>Choose a valid history range</h1>
        <p>Use one nonnegative since cursor, a limit from 1 to 200, and an optional through cursor at or after since. Repeated values and other filters are not supported.</p>
        <p><Link href={path} prefetch={false}>Read the public ledger history</Link></p>
      </main>
    );
  }
  const result = await readHistory(slug, query.since, query.limit, query.through);
  if (result.state === "not_found") notFound();
  if (result.state === "unavailable") {
    return <PublicReadUnavailable title={`${slug} — Ledger history`} retryPath={eventHistoryPath(slug, query)} />;
  }
  const page = result.data;
  const end = page.page_end;
  const next = end.next === null ? null : eventHistoryContinuation(slug, end.next);
  const newer = eventHistoryContinuation(slug, end.poll);
  const pinnedQuery = { ...query, through: end.through };
  const jsonPath = eventTailPath(slug, "json", pinnedQuery);

  return (
    <>
      <a className="skip" href="#content">Skip to content</a>
      <main className="landing col problem-page" id="content">
        <header className="masthead">
          <Link href={`/p/${encodeURIComponent(slug)}`}>← {slug}</Link>
          <h1>Ledger history</h1>
          <p className="lede">Inspect the sequence of public records, the actors recorded at the time, and available causal links.</p>
        </header>
        <p className="loop" role="note">
          An event records an action, not scientific certainty. This history includes public event envelopes;
          private or undisclosed events expose only their sequence. Current visibility controls still apply to historical pages.
        </p>
        {result.noindex ? <p className="quiet">The source requests that this history stay out of search indexes.</p> : null}
        <section aria-labelledby="history-events-heading" data-through={end.through}>
          <h2 id="history-events-heading">Recorded events</h2>
          <p className="quiet">
            Snapshot through ledger sequence {end.through}. This page covers sequences after {end.since} through {end.next_cursor}
            {" "}({page.events.length} entries, including undisclosed positions). This is not a count of scientific contributions.
          </p>
          {page.events.length === 0 ? (
            <p>No events were returned in this range. Its resume cursor remains {end.next_cursor}; newer events may exist beyond a pinned snapshot.</p>
          ) : (
            <ol className="claims-list">
              {page.events.map((entry) => (
                <li key={entry.seq}><EventHistoryEntry entry={entry} origin={result.origin} /></li>
              ))}
            </ol>
          )}
        </section>
        <nav aria-label="Ledger history pages">
          {end.since === 0 ? null : (
            <p><Link href={eventHistoryPath(slug, { since: 0, limit: query.limit, through: end.through })} prefetch={false}>
              Beginning of this snapshot
            </Link></p>
          )}
          {next !== null ? (
            <p><Link href={next} prefetch={false}>Next events in this snapshot →</Link></p>
          ) : newer !== null ? (
            <p><Link href={newer} prefetch={false}>Check for newer events →</Link></p>
          ) : null}
          <p><Link href={eventHistoryPath(slug, pinnedQuery)} prefetch={false}>Refresh this range with current visibility</Link></p>
          <p><Link href={path} prefetch={false}>Restart history at the latest ledger head</Link></p>
        </nav>
        <EventHistoryOmissions omitted={page.omitted} />
        <section aria-labelledby="history-agent-heading">
          <h2 id="history-agent-heading">Canonical agent faces</h2>
          <p>
            <a href={`${result.origin}${jsonPath}`}>JSON for this snapshot</a>{" · "}
            <a href={`${result.origin}${jsonPath.replace("/events.json?", "/events.md?")}`}>Markdown</a>{" · "}
            <a href={`${result.origin}${eventTailPath(slug, "ndjson", pinnedQuery)}`}>NDJSON</a>
          </p>
        </section>
      </main>
    </>
  );
}
