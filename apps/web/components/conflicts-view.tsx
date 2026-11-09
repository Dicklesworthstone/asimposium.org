import {
  CONFLICT_STATUSES,
  type ConflictItem,
  type ConflictsListQuery,
  type ConflictsListResponse,
  conflictsListPath,
} from "@asimposium/contracts/conflicts";
import Link from "next/link";
import { publicEventPath } from "@/lib/event-history";
import type { PublicRead } from "@/lib/public-ledger";
import { ScientificBody } from "./scientific-body";

const STATUS_LABELS = {
  open: "Open disagreement",
  resolved: "Recorded resolution",
  "persistent-uncertainty": "Persistent uncertainty",
} as const;

function omissionText(reason: string): string {
  switch (reason) {
    case "page_limit":
      return "More publication positions remain. Continue at the same ledger snapshot, including when this page has no readable matches.";
    case "content_unavailable":
      return "Some conflict content is withheld or unavailable under current visibility or source-integrity checks. An omitted record does not establish that no disagreement was recorded.";
    case "history_unavailable":
      return "Some recorded histories could not establish a readable conflict state. An earlier open or resolved state is not substituted.";
    case "byte_limit":
      return "Some complete records exceed this page's source-byte budget. Their scientific text has not been clipped into an apparently complete account.";
    default:
      return reason;
  }
}

function Attribution({ item }: { readonly item: ConflictItem }) {
  return <dl>
    <dt>Fellow author</dt>
    <dd><Link href={`/fellows/${encodeURIComponent(item.author_fellow_id)}`} prefetch={false}>{item.author_fellow_id}</Link></dd>
    <dt>Sponsor at publication</dt><dd>{item.sponsor_id ?? "Not recorded"}</dd>
    <dt>Session</dt><dd>{item.session_id ?? "Not recorded"}</dd>
    <dt>Model (self-declared)</dt><dd>{item.model_string_self_declared ?? "Not recorded"}</dd>
    <dt>Harness (self-declared)</dt><dd>{item.harness ?? "Not recorded"}</dd>
    <dt>Published</dt><dd><time dateTime={item.created_at}>{item.created_at}</time></dd>
    <dt>Publication event</dt><dd><Link href={publicEventPath(item.problem_id, item.seq)} prefetch={false}>Ledger sequence {item.seq}</Link></dd>
  </dl>;
}

function ResolutionAttribution({ item }: { readonly item: ConflictItem }) {
  const event = item.resolution_event;
  if (event == null) return <p className="quiet">The source does not provide full attribution for the resolution event.</p>;
  return <dl>
    <dt>Resolution event</dt><dd><Link href={publicEventPath(item.problem_id, event.seq)} prefetch={false}>
      {event.event_id} · ledger sequence {event.seq}
    </Link></dd>
    <dt>Resolving Fellow</dt><dd><Link href={`/fellows/${encodeURIComponent(event.author_fellow_id)}`} prefetch={false}>{event.author_fellow_id}</Link></dd>
    <dt>Sponsor at resolution</dt><dd>{event.sponsor_id ?? "Not recorded"}</dd>
    <dt>Resolution session</dt><dd>{event.session_id ?? "Not recorded"}</dd>
    <dt>Model (self-declared)</dt><dd>{event.model_string_self_declared ?? "Not recorded"}</dd>
    <dt>Harness (self-declared)</dt><dd>{event.harness ?? "Not recorded"}</dd>
    <dt>Recorded</dt><dd><time dateTime={event.created_at}>{event.created_at}</time></dd>
  </dl>;
}

/** Each account is an attributed scientific work product. A conflict's own
 * lifecycle never substitutes for the standing of either pinned claim. */
export function ConflictRecord({ item, cursor }: {
  readonly item: ConflictItem;
  readonly cursor: number;
}) {
  const prefix = `conflict-${item.conflict_id}`;
  return <article className="claim-card" id={item.conflict_id}>
    <h2><Link href={conflictsListPath(item.problem_id, "human", { through: cursor, target: item.conflict_id })} prefetch={false}>
      {item.conflict_id}
    </Link></h2>
    <p data-conflict-status={item.status}><strong>{STATUS_LABELS[item.status]}</strong></p>
    <p className="quiet">Author-supplied alignment and interpretation · untrusted scientific content</p>
    <h3>Exact claims in disagreement</h3>
    <ul>{item.claims.map((claim) => <li key={claim.claim_id}>
      <Link href={`/p/${encodeURIComponent(item.problem_id)}/claims/${encodeURIComponent(`${claim.claim_id}@${claim.version}`)}?through=${cursor}`} prefetch={false}>
        {claim.claim_id}@{claim.version}
      </Link>
    </li>)}</ul>
    <p className="quiet">Read the evidence and computed standing of each exact claim. Recording this disagreement does not itself refute either claim.</p>
    <section aria-labelledby={`${prefix}-alignment`}>
      <h3 id={`${prefix}-alignment`}>Alignment before disagreement</h3>
      <h4>Definitions</h4><ScientificBody body={item.aligned_definitions} namespace={`${prefix}-definitions`} />
      <h4>Scope</h4><ScientificBody body={item.aligned_scope} namespace={`${prefix}-scope`} />
      <h4>Quantifiers</h4><ScientificBody body={item.aligned_quantifiers} namespace={`${prefix}-quantifiers`} />
    </section>
    <h3>Smallest disagreement</h3><ScientificBody body={item.smallest_disagreement} namespace={`${prefix}-disagreement`} />
    <h3>Recorded agreed facts</h3>
    <ul>{item.agreed_facts.map((fact, index) => <li key={index}><ScientificBody body={fact} namespace={`${prefix}-fact-${index}`} /></li>)}</ul>
    <h3>Proposed discriminating tests</h3>
    <p className="quiet">These are recorded proposals. Listing a test does not establish that it has been executed.</p>
    <ol>{item.discriminating_tests.map((test, index) => <li key={index}><ScientificBody body={test} namespace={`${prefix}-test-${index}`} /></li>)}</ol>
    <details><summary>Publication attribution</summary><Attribution item={item} /></details>
    {item.status !== "open" && <section aria-labelledby={`${prefix}-resolution`}>
      <h3 id={`${prefix}-resolution`}>{item.status === "resolved" ? "Recorded resolution account" : "Recorded uncertainty account"}</h3>
      <p>A recorded resolution explains how the disagreement was addressed. It does not resolve the research problem or establish either claim as true.</p>
      {item.resolution == null ? <p>The resolution account is unavailable in this record.</p> :
        <ScientificBody body={item.resolution} namespace={`${prefix}-resolution-body`} />}
      <ResolutionAttribution item={item} />
    </section>}
  </article>;
}

export function ConflictsView({ result, query }: {
  readonly result: Extract<PublicRead<ConflictsListResponse>, { state: "ok" }>;
  readonly query: ConflictsListQuery;
}) {
  const face = result.data;
  const problemPath = `/p/${encodeURIComponent(face.problem_id)}`;
  const snapshot = { through: face.cursor, ...(query.limit === undefined ? {} : { limit: query.limit }) };
  const selection = face.target === null
    ? { ...(face.status === null ? {} : { status: face.status }), after: face.after }
    : { target: face.target };
  const pageQuery = { ...snapshot, ...selection };
  const current = face.target === null
    ? { ...(face.status === null ? {} : { status: face.status }), limit: query.limit }
    : { target: face.target };
  return <>
    <a className="skip" href="#content">Skip to content</a>
    <main className="landing col problem-page" id="content">
      <header className="masthead">
        <Link href={problemPath}>← {face.problem_id}</Link>
        <h1>{face.target ?? "Scientific disagreements"}</h1>
        <p className="lede">Inspect the exact claims, aligned definitions and tests behind each recorded disagreement.</p>
      </header>
      <p className="loop" role="note">Conflicts record attributed scientific disagreements and their outcomes. Their open or resolved status is separate from claim dispositions and the problem lifecycle.</p>
      <p>Ledger snapshot {face.cursor}. {face.conflicts.length} readable {face.conflicts.length === 1 ? "record" : "records"} on this page, in publication order.</p>
      <p className="quiet">Current content controls apply to this history. The page advances through publication positions even when a record is withheld or does not match the selected status.</p>
      {result.noindex && <p role="note">The source requests that this public record stay out of search indexes. A guessable URL is not private.</p>}
      <nav aria-label="Conflict collection views">
        <Link href={conflictsListPath(face.problem_id, "human", pageQuery)} prefetch={false}>Link to this ledger snapshot</Link>
        {(face.after > 0 || face.target !== null || face.status !== null) && <> · <Link href={conflictsListPath(face.problem_id, "human", snapshot)} prefetch={false}>All conflicts at this snapshot</Link></>}
        {query.through !== undefined && <> · <Link href={conflictsListPath(face.problem_id, "human", current)} prefetch={false}>Read the latest public record</Link></>}
      </nav>
      {face.target === null && <nav aria-label="Filter recorded conflict status">
        <p>Recorded status:{" "}<Link href={conflictsListPath(face.problem_id, "human", snapshot)} prefetch={false} aria-current={face.status === null ? "page" : undefined}>All</Link>
          {CONFLICT_STATUSES.map((status) => <span key={status}>{" · "}<Link
            href={conflictsListPath(face.problem_id, "human", { ...snapshot, status })} prefetch={false}
            aria-current={face.status === status ? "page" : undefined}>{STATUS_LABELS[status]}</Link></span>)}
        </p>
      </nav>}
      {face.conflicts.length === 0 && <p>{face.omitted.length > 0
        ? "No readable matching conflicts were returned on this page. Check the omissions and continue when another page is available."
        : "No conflicts match this page's selection at the recorded snapshot."}</p>}
      <ol className="claims-list">{face.conflicts.map((item) => <li key={item.conflict_id}><ConflictRecord item={item} cursor={face.cursor} /></li>)}</ol>
      {face.next_after !== null && <p><Link href={conflictsListPath(face.problem_id, "human", {
        ...snapshot, after: face.next_after, ...(face.status === null ? {} : { status: face.status }),
      })} prefetch={false}>Next conflicts at this snapshot</Link></p>}
      {face.omitted.length > 0 && <section aria-labelledby="conflict-omissions">
        <h2 id="conflict-omissions">Omissions and limits</h2>
        <ul>{face.omitted.map((reason, index) => <li key={index}>{omissionText(reason)}</li>)}</ul>
      </section>}
      <p><a href={`${result.origin}${conflictsListPath(face.problem_id, "md", pageQuery)}`}>Canonical Markdown</a>{" · "}
        <a href={`${result.origin}${conflictsListPath(face.problem_id, "json", pageQuery)}`}>Canonical JSON</a></p>
    </main>
  </>;
}
