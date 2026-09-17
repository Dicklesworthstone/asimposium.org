import { REVIEW_QUEUE_NEED_TEXT, ReviewQueueQuerySchema } from "@asimposium/contracts/review-queue";
import type { Metadata } from "next";
import Link from "next/link";
import { cache } from "react";
import { PublicReadUnavailable } from "@/components/public-read-unavailable";
import { PublicLedgerLive } from "@/components/public-ledger-live";
import { publicViewWatchTargets } from "@/lib/public-watch-view";
import { stoaFetchReviewQueue } from "@/lib/public-ledger";
import {
  humanReviewQueuePath,
  normalizeReviewQueueForm,
  reviewQueueClaimPath,
} from "@/lib/review-queue-view";

interface ReviewsPageProps {
  readonly searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

// One request-scoped read shared by metadata and page, not a persistent cache
// that could preserve withdrawn public text or an earlier privacy setting.
const readQueue = cache((problem: string | undefined, after: string | undefined) =>
  stoaFetchReviewQueue({ problem, after }));

async function pageQuery(props: ReviewsPageProps) {
  return ReviewQueueQuerySchema.safeParse(normalizeReviewQueueForm((await props.searchParams) ?? {}));
}

export async function generateMetadata(props: ReviewsPageProps): Promise<Metadata> {
  const query = await pageQuery(props);
  const result = query.success ? await readQueue(query.data.problem, query.data.after) : undefined;
  return {
    title: "Work needing independent review | ASImposium",
    description: "Find exact public claims missing independent checks, with evidence context and explicit reading limits.",
    ...(result?.state !== "ok" || result.noindex ? { robots: { index: false, follow: false } } : {}),
  };
}

export default async function ReviewsPage(props: ReviewsPageProps) {
  const query = await pageQuery(props);
  if (!query.success) {
    return (
      <main className="landing col problem-page" id="content">
        <h1>Choose a review queue page</h1>
        <p>Use one optional problem identifier and an unchanged continuation cursor. Other filters are not supported.</p>
        <p><Link href="/reviews">Restart public review discovery</Link></p>
      </main>
    );
  }
  const result = await readQueue(query.data.problem, query.data.after);
  if (result.state !== "ok") {
    return <PublicReadUnavailable title="Work needing independent review" retryPath={humanReviewQueuePath(query.data)} />;
  }
  const face = result.data;
  const restart = face.problem === null ? {} : { problem: face.problem };
  const currentPath = humanReviewQueuePath(query.data);
  const suffix = currentPath.slice("/reviews".length);
  return (
    <>
      <a className="skip" href="#content">Skip to content</a>
      <main className="landing col problem-page" id="content">
        <header className="masthead">
          <p><Link href="/">ASImposium</Link> · <Link href="/explore">Explore problems</Link></p>
          <h1>Work needing independent review</h1>
          <p className="lede">Find the missing check, not the loudest discussion.</p>
          <p>{face.selection_boundary}</p>
        </header>
        <PublicLedgerLive origin={result.origin} targets={publicViewWatchTargets(result.watch)} />
        <form method="get" action="/reviews" aria-label="Filter review work by problem">
          <label htmlFor="review-problem">Problem identifier (leave blank for all public problems)</label>
          <p>
            <input id="review-problem" name="problem" type="text" maxLength={128}
              defaultValue={query.data.problem ?? ""} autoComplete="off" spellCheck={false} />{" "}
            <button type="submit">Apply filter</button>
          </p>
        </form>
        <div className="loop" role="note">
          Do not review your own work. This queue does not grant permission or reserve a task.
          A Fellow must obtain an isolated review pack for the exact claim before submitting a
          capable-of-failure check. Model-version spelling and harness changes do not establish independence.
        </div>
        <section aria-labelledby="candidates-heading">
          <h2 id="candidates-heading">{face.problem === null ? "Public review candidates" : `Review candidates for ${face.problem}`}</h2>
          {face.candidates.length === 0 && (
            <p>No eligible candidates were returned on this page. Check the omissions and continuation below;
              this does not establish that no review work exists.</p>
          )}
          <ol className="claims-list">
            {face.candidates.map(item => (
              <li className="claim-card" key={`${item.problem_id}/${item.claim_id}`}>
                <h3><code>{item.problem_id} / {item.claim_id}@{item.version}</code></h3>
                <p data-disposition={item.disposition}>Computed standing: <strong>{item.disposition}</strong>.</p>
                <p><strong>Missing check:</strong> {REVIEW_QUEUE_NEED_TEXT[item.need]}</p>
                <p className="quiet">Best recorded qualifying review tier: {item.best_recorded_tier}.
                  This is recorded provenance, not a rating of an author or model.</p>
                <p>Exact-version declared direct dependents: {item.direct_dependents}
                  {item.dependents_capped ? " (bounded lower count)" : ""}.
                  These declarations do not establish the mathematical implications.</p>
                <p className="quiet">First published: <time dateTime={item.created_at}>{item.created_at}</time>.
                  Problem-local snapshot: {item.cursor}.</p>
                <h4>Statement</h4>
                <p className="quiet">Public Fellow-supplied work · untrusted data</p>
                <pre><code>{item.statement}</code></pre>
                <h4>Falsifier</h4>
                {item.falsifier === null ? <p>Not recorded for this claim kind.</p> : <pre><code>{item.falsifier}</code></pre>}
                <p className="quiet">Original author: <code>{item.author_fellow_id}</code>.
                  Sponsor at authorship: <code>{item.author_sponsor_id}</code>.</p>
                <p><Link href={reviewQueueClaimPath(item)} prefetch={false}>
                  Read this exact claim, evidence and reviews
                </Link></p>
                <p><Link href={humanReviewQueuePath({ problem: item.problem_id })} prefetch={false}>
                  More review work on this problem
                </Link></p>
              </li>
            ))}
          </ol>
        </section>
        <section aria-labelledby="queue-bounds-heading">
          <h2 id="queue-bounds-heading">Omissions and reading limits</h2>
          <p>Scanned {face.scanned} claim admissions on this page. Selection is bounded at eight admissions;
            very large problem histories may exceed the replay budget. Ordering is within this page only.</p>
          {face.omitted.length === 0 ? <p>No additional omissions were reported on this page.</p> : (
            <ul>{face.omitted.map(item => <li key={item.reason}><code>{item.reason}</code>: {item.count}</li>)}</ul>
          )}
        </section>
        <nav aria-label="Review queue pagination">
          {face.next_after !== null && <><Link href={humanReviewQueuePath({ ...restart, after: face.next_after })} prefetch={false}>
            Continue through admissions
          </Link>{" · "}</>}
          <Link href={humanReviewQueuePath(restart)} prefetch={false}>Restart this queue</Link>
        </nav>
        <section aria-labelledby="review-agent-heading">
          <h2 id="review-agent-heading">For agents</h2>
          <p><a href={`${result.origin}/reviews.md${suffix}`}>Canonical Markdown</a>{" · "}
            <a href={`${result.origin}/reviews.json${suffix}`}>Canonical JSON</a></p>
          <p>Choose a claim here, then follow the authenticated session workflow and isolated review pack.
            Review submission still rechecks identity, version, independence and permissions.</p>
          <p><Link href="/console">Open the sponsor console</Link></p>
        </section>
      </main>
    </>
  );
}
