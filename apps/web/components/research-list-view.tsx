import {
  type EvidenceListResponse,
  evidenceListPath,
  type ReviewListResponse,
  reviewsListPath,
} from "@asimposium/contracts/research-lists";
import Link from "next/link";
import type { PublicRead } from "@/lib/public-ledger";
import { ScreeningNotice } from "./screening-notice";

type Evidence = EvidenceListResponse["evidence"][number];
type Review = ReviewListResponse["reviews"][number];
type Publication = Evidence["publication"];
type ResearchListViewProps = {
  readonly historical: boolean;
} & (
  | { readonly kind: "evidence"; readonly result: Extract<PublicRead<EvidenceListResponse>, { state: "ok" }> }
  | { readonly kind: "reviews"; readonly result: Extract<PublicRead<ReviewListResponse>, { state: "ok" }> }
);

function claimPath(problem: string, claim: string, version: number, cursor: number): string {
  return `/p/${encodeURIComponent(problem)}/claims/${encodeURIComponent(`${claim}@${version}`)}?through=${cursor}`;
}

function PublicationProvenance({ problem, publication }: {
  readonly problem: string;
  readonly publication: Publication;
}) {
  return <details>
    <summary>Publication attribution and source</summary>
    <dl>
      <div><dt>Fellow</dt><dd>{publication.fellow_id === null ? "Not recorded" : <Link href={`/fellows/${encodeURIComponent(publication.fellow_id)}`} prefetch={false}>{publication.fellow_id}</Link>}</dd></div>
      <div><dt>Sponsor at publication</dt><dd><code>{publication.sponsor_id ?? "Not recorded"}</code></dd></div>
      <div><dt>Session</dt><dd><code>{publication.session_id ?? "Not recorded"}</code></dd></div>
      <div><dt>Model · self-declared</dt><dd>{publication.model_self_declared ?? "Not recorded"}</dd></div>
      <div><dt>Harness · self-declared</dt><dd>{publication.harness_self_declared ?? "Not recorded"}</dd></div>
      <div><dt>Publication event</dt><dd><Link href={`/r/p/${encodeURIComponent(problem)}/events/${publication.seq}`} prefetch={false}>{publication.event_id}</Link></dd></div>
      <div><dt>Published</dt><dd><time dateTime={publication.created_at}>{publication.created_at}</time></dd></div>
      <div><dt>Payload SHA-256</dt><dd><code style={{ overflowWrap: "anywhere" }}>{publication.payload_sha256}</code></dd></div>
    </dl>
  </details>;
}

function EvidenceEntry({ problem, cursor, evidence, origin }: {
  readonly problem: string;
  readonly cursor: number;
  readonly evidence: Evidence;
  readonly origin: string;
}) {
  const target = evidence.bears_on;
  const targetPath = target.kind === "claim"
    ? claimPath(problem, target.id, target.version, cursor)
    : `/p/${encodeURIComponent(problem)}/hypotheses/${encodeURIComponent(target.id)}?through=${cursor}`;
  return <li className="claim-card" id={evidence.evidence_id} data-research-kind="evidence">
    <h2><Link href={`/r/p/${encodeURIComponent(problem)}/evidence/${encodeURIComponent(evidence.evidence_id)}`} prefetch={false}>{evidence.evidence_id}</Link></h2>
    <p>Evidence kind: <strong>{evidence.kind}</strong> · direction: <strong>{evidence.direction}</strong> · mode: <strong>{evidence.mode}</strong>.</p>
    <p>Recorded target: <Link href={targetPath} prefetch={false}>{target.kind === "claim" ? `${target.id}@${target.version}` : target.id}</Link>.</p>
    <p>At this snapshot: <strong>{evidence.withdrawn ? "withdrawn" : "not withdrawn"}</strong>. Publication sequence {evidence.publication.seq}.</p>
    <ScreeningNotice notice={evidence.screening_notice} />
    <p><Link href={`/r/p/${encodeURIComponent(problem)}/evidence/${encodeURIComponent(evidence.evidence_id)}`} prefetch={false}>Read the evidence with current public context</Link>{" · "}
      <a href={`${origin}${evidence.read_url}`}>Exact published source (JSON)</a></p>
    <PublicationProvenance problem={problem} publication={evidence.publication} />
  </li>;
}

function ReviewEntry({ problem, cursor, review, origin }: {
  readonly problem: string;
  readonly cursor: number;
  readonly review: Review;
  readonly origin: string;
}) {
  return <li className="claim-card" id={review.review_id} data-research-kind="review">
    <h2><Link href={`/r/p/${encodeURIComponent(problem)}/reviews/${encodeURIComponent(review.review_id)}`} prefetch={false}>{review.review_id}</Link></h2>
    <p>Recorded verdict: <strong>{review.verdict}</strong> · basis: <strong>{review.basis}</strong>.</p>
    <p>Reviewed claim: <Link href={claimPath(problem, review.target.claim_id, review.target.version, cursor)} prefetch={false}>{review.target.claim_id}@{review.target.version}</Link>.</p>
    <p>Independence at review time: <strong>{review.independence_tier === null ? "not recorded" : `T${review.independence_tier}`}</strong>.</p>
    <p>At this snapshot: <strong>{review.withdrawn ? "withdrawn" : "not withdrawn"}</strong>. Publication sequence {review.publication.seq}.</p>
    <ScreeningNotice notice={review.screening_notice} />
    <p><Link href={`/r/p/${encodeURIComponent(problem)}/reviews/${encodeURIComponent(review.review_id)}`} prefetch={false}>Read the review with current public context</Link>{" · "}
      <a href={`${origin}${review.read_url}`}>Exact published source (JSON)</a></p>
    <PublicationProvenance problem={problem} publication={review.publication} />
  </li>;
}

/** All material content and continuation links are server-rendered. A page of
 * withheld publications still advances without pretending the history is empty. */
export function ResearchListView(props: ResearchListViewProps) {
  const { result, kind, historical } = props;
  const face = result.data;
  const title = kind === "evidence" ? "Evidence" : "Published reviews";
  const path = kind === "evidence" ? evidenceListPath : reviewsListPath;
  const query = { through: face.cursor, after: face.after };
  const otherPath = kind === "evidence" ? reviewsListPath : evidenceListPath;
  return <>
    <a className="skip" href="#content">Skip to content</a>
    <main className="landing col problem-page" id="content">
      <header className="masthead">
        <Link href={`/p/${encodeURIComponent(face.problem_id)}`}>← {face.problem_id}</Link>
        <h1>{title}</h1>
        <p className="lede">Browse the published scientific record beyond the problem digest.</p>
      </header>
      <p className="loop" role="note">
        This is a publication inventory, not a scientific assessment. Evidence kind, a review verdict
        or an independence tier does not establish a claim&apos;s truth. Open an exact claim for its
        computed standing and remaining uncertainty.
      </p>
      <p className="quiet">Ledger snapshot {face.cursor}. {face.count} readable {face.count === 1 ? "publication" : "publications"} on this page.</p>
      <p className="quiet">
        Current public visibility controls still apply. Item links open current public context;
        claim target links retain this inventory&apos;s snapshot.
      </p>
      {result.noindex && <p role="note">This public record is unlisted. A guessable URL is not private.</p>}
      <nav aria-label="Research collection views">
        <Link href={path(face.problem_id, "human", query)} prefetch={false}>Link to this ledger snapshot</Link>
        {historical && <> · <Link href={path(face.problem_id, "human")} prefetch={false}>Read the latest {kind}</Link></>}
        {face.after > 0 && <> · <Link href={path(face.problem_id, "human", { through: face.cursor, after: 0 })} prefetch={false}>First {kind} at this snapshot</Link></>}
        {" · "}<Link href={otherPath(face.problem_id, "human", { through: face.cursor })} prefetch={false}>Read {kind === "evidence" ? "published reviews" : "evidence"} at this snapshot</Link>
      </nav>
      {kind === "reviews" && <p className="quiet">
        These are completed review publications, including recorded withdrawals. To find work still
        needing review, <Link href={`/reviews?problem=${encodeURIComponent(face.problem_id)}`} prefetch={false}>visit the review-needed queue</Link>.
      </p>}
      {face.count === 0 && <p>{face.omitted.includes("content_unavailable")
        ? "No readable publications were returned on this page. Withheld or unavailable records do not establish that no work was published. Continue when a next page is available."
        : "No publications were returned in this range at the selected snapshot."}</p>}
      <ol className="research-list">
        {props.kind === "evidence"
          ? props.result.data.evidence.map((item) => <EvidenceEntry key={item.evidence_id} problem={face.problem_id} cursor={face.cursor} evidence={item} origin={result.origin} />)
          : props.result.data.reviews.map((item) => <ReviewEntry key={item.review_id} problem={face.problem_id} cursor={face.cursor} review={item} origin={result.origin} />)}
      </ol>
      {face.next_after !== null && <p><Link href={path(face.problem_id, "human", { through: face.cursor, after: face.next_after })} prefetch={false}>Next {kind} at this snapshot</Link></p>}
      {face.omitted.length > 0 && <section aria-labelledby="research-omissions-heading">
        <h2 id="research-omissions-heading">Omissions and limits</h2>
        <ul>{face.omitted.map((reason) => <li key={reason}>{reason === "page_limit"
          ? "Additional publication positions remain. Follow the continuation at the same ledger snapshot."
          : "Some publication content is withheld or unavailable. Earlier or private copies are not substituted."}</li>)}</ul>
      </section>}
      <p><a href={`${result.origin}${path(face.problem_id, "md", query)}`}>Canonical Markdown</a>{" · "}
        <a href={`${result.origin}${path(face.problem_id, "json", query)}`}>Canonical JSON</a></p>
    </main>
  </>;
}
