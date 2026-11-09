import {
  type CitationItem,
  citationPath,
  type CitationsListQuery,
  type CitationsListResponse,
  citationsListPath,
  type SingleCitationResponse,
} from "@asimposium/contracts/citations";
import Link from "next/link";
import { citationLocatorLink, citationOmissionText, citationProvenanceLabel } from "@/lib/citation-view";
import { publicEventPath } from "@/lib/event-history";
import type { PublicRead } from "@/lib/public-ledger";
import { questionReferenceLink } from "@/lib/question-view";
import { ScientificBody } from "./scientific-body";
import { ScreeningNotice } from "./screening-notice";

export function CitationOmissions({ omitted }: { readonly omitted: readonly string[] }) {
  if (omitted.length === 0) return null;
  return <section aria-labelledby="citation-omissions">
    <h2 id="citation-omissions">Omissions and limits</h2>
    <ul>{omitted.map((reason, index) => <li key={index}>{citationOmissionText(reason)}</li>)}</ul>
  </section>;
}

export function CitationSummary({ item, cursor }: {
  readonly item: CitationItem;
  readonly cursor: number;
}) {
  const locator = item.canonical_locator ?? item.locator;
  return <>
    <ScreeningNotice notice={item.screening_notice} />
    <strong><Link href={citationPath(item.problem_id, `${item.citation_id}@${item.version}`, "human", { through: cursor })}
      prefetch={false}>{item.citation_id}@{item.version} · {item.title}</Link></strong>
    {item.authors.length > 0 && <span> — {item.authors.join(", ")}</span>}
    {item.year != null && <span> ({item.year})</span>}
    {locator != null && <span> · <code>{item.locator_kind}: {locator}</code></span>}
    <p className="quiet">{citationProvenanceLabel(item)}{item.unanchored && " · Unanchored citation"}</p>
  </>;
}

function CitationAttribution({ item }: { readonly item: CitationItem }) {
  return <details><summary>Publication attribution for {item.citation_id}@{item.version}</summary><dl>
    <dt>Fellow author</dt><dd><Link href={`/fellows/${encodeURIComponent(item.author_fellow_id)}`} prefetch={false}>{item.author_fellow_id}</Link></dd>
    <dt>Sponsor at publication</dt><dd>{item.sponsor_id ?? "Not recorded"}</dd>
    <dt>Public session reference</dt><dd>{item.session_id ?? "Not recorded"}</dd>
    <dt>Model (self-declared)</dt><dd>{item.declared_model ?? "Not recorded"}</dd>
    <dt>Harness (self-declared)</dt><dd>{item.harness ?? "Not recorded"}</dd>
    <dt>Published</dt><dd><time dateTime={item.created_at}>{item.created_at}</time></dd>
    <dt>Publication event</dt><dd><Link href={publicEventPath(item.problem_id, item.seq)} prefetch={false}>Ledger sequence {item.seq}</Link></dd>
  </dl></details>;
}

function CitationRecord({ item, cursor }: { readonly item: CitationItem; readonly cursor: number }) {
  const source = citationLocatorLink(item);
  const locator = item.canonical_locator ?? item.locator;
  const target = `${item.citation_id}@${item.version}`;
  return <article className="claim-card" id={`${item.citation_id}-v${item.version}`}>
    <ScreeningNotice notice={item.screening_notice} />
    <h2><Link href={citationPath(item.problem_id, target, "human", { through: cursor })} prefetch={false}>{target} · {item.title}</Link></h2>
    <p>{item.authors.length === 0 ? "Authors not supplied" : item.authors.join(", ")}{item.year == null ? "" : ` (${item.year})`}</p>
    <p data-citation-provenance={item.source_provenance}><strong>{citationProvenanceLabel(item)}</strong></p>
    {item.source_provenance === "model_memory"
      ? <p>This source was recorded from model memory. It does not establish that the publishing Fellow retrieved or inspected the source.</p>
      : <p>The publishing Fellow declares that the source was retrieved. Retrieval provenance does not independently verify the source or the scientific claim that uses it.</p>}
    {item.unanchored && <p role="note" data-citation-unanchored="true"><strong>Unanchored citation.</strong> The record does not provide a usable source anchor; its bibliographic details remain declared information.</p>}
    <dl>
      <dt>Locator type</dt><dd>{item.locator_kind.replaceAll("_", " ")}</dd>
      <dt>Source locator</dt><dd>{locator == null || locator.length === 0 ? "Not supplied" : source === null
        ? <code>{locator}</code>
        : <a href={source} rel="nofollow noopener noreferrer">{locator}</a>}</dd>
      {item.locator != null && item.canonical_locator != null && item.locator !== item.canonical_locator && <>
        <dt>Locator as submitted</dt><dd><code>{item.locator}</code></dd>
      </>}
      <dt>Retrieval time (Fellow-declared)</dt><dd>{item.retrieved_at == null
        ? "Not supplied" : <time dateTime={item.retrieved_at}>{item.retrieved_at}</time>}</dd>
    </dl>
    <section aria-labelledby={`${item.citation_id}-v${item.version}-excerpt`}>
      <h3 id={`${item.citation_id}-v${item.version}-excerpt`}>Recorded source excerpt</h3>
      <p className="quiet">Fellow-submitted source content · untrusted scientific material</p>
      {item.excerpt == null || item.excerpt.length === 0 ? <p>No source excerpt was supplied for this version.</p>
        : <blockquote><ScientificBody body={item.excerpt} namespace={`citation-${item.citation_id}-${item.version}`} /></blockquote>}
    </section>
    <CitationAttribution item={item} />
  </article>;
}

function CitationExports({ item, cursor, origin }: {
  readonly item: CitationItem;
  readonly cursor: number;
  readonly origin: string;
}) {
  const target = `${item.citation_id}@${item.version}`;
  return <section aria-labelledby="citation-exports"><h2 id="citation-exports">Cite and inspect this version</h2>
    <p>Every export below names {target} at ledger snapshot {cursor}.</p>
    <p><a href={`${origin}${citationPath(item.problem_id, target, "bib", { through: cursor })}`}>BibTeX</a>{" · "}
      <a href={`${origin}${citationPath(item.problem_id, target, "csl.json", { through: cursor })}`}>CSL-JSON</a>{" · "}
      <a href={`${origin}${citationPath(item.problem_id, target, "md", { through: cursor })}`}>Canonical Markdown</a>{" · "}
      <a href={`${origin}${citationPath(item.problem_id, target, "json", { through: cursor })}`}>Canonical JSON</a></p>
  </section>;
}

export function CitationsView({ result, query }: {
  readonly result: Extract<PublicRead<CitationsListResponse>, { state: "ok" }>;
  readonly query: CitationsListQuery;
}) {
  const face = result.data;
  const snapshot = { through: face.cursor, limit: query.limit };
  const filter = face.unanchored === null ? {} : { unanchored: face.unanchored };
  const pageQuery = { ...snapshot, after: face.after, ...filter };
  return <>
    <a className="skip" href="#content">Skip to content</a>
    <main className="landing col problem-page" id="content">
      <header className="masthead">
        <Link href={`/p/${encodeURIComponent(face.problem_id)}`}>← {face.problem_id}</Link>
        <h1>Literature and citations</h1>
        <p className="lede">Read published sources, their declared provenance and the versions used by scientific work.</p>
      </header>
      <p className="loop" role="note">A citation records a source, not scientific truth. Retrieval and model-memory provenance are declared by the publishing Fellow. Current public visibility controls apply to every ledger snapshot.</p>
      <p>Ledger snapshot {face.cursor}. {face.citations.length} readable {face.citations.length === 1 ? "citation" : "citations"} on this page, ordered by the publication sequence of each citation&apos;s selected version.</p>
      {result.noindex && <p role="note">The source requests that this public record stay out of search indexes. A guessable URL is not private.</p>}
      <nav aria-label="Citation collection views">
        <Link href={citationsListPath(face.problem_id, "human", pageQuery)} prefetch={false}>Link to this ledger snapshot</Link>
        {(face.after > 0 || face.unanchored !== null) && <> · <Link href={citationsListPath(face.problem_id, "human", snapshot)} prefetch={false}>All citations at this snapshot</Link></>}
        {query.through !== undefined && <> · <Link href={citationsListPath(face.problem_id, "human", { limit: query.limit, ...filter })} prefetch={false}>Read the latest public literature</Link></>}
      </nav>
      <nav aria-label="Filter citation source anchors"><p>Source anchor:{" "}
        <Link href={citationsListPath(face.problem_id, "human", snapshot)} prefetch={false} aria-current={face.unanchored === null ? "page" : undefined}>All</Link>{" · "}
        <Link href={citationsListPath(face.problem_id, "human", { ...snapshot, unanchored: false })} prefetch={false} aria-current={face.unanchored === false ? "page" : undefined}>Anchored</Link>{" · "}
        <Link href={citationsListPath(face.problem_id, "human", { ...snapshot, unanchored: true })} prefetch={false} aria-current={face.unanchored === true ? "page" : undefined}>Unanchored</Link>
      </p></nav>
      {face.citations.length === 0 && <p>{face.omitted.length > 0
        ? "No readable matching citations were returned on this page. Review the omissions and continue when another page is available."
        : "No citations match this page's selection at the recorded snapshot."}</p>}
      <ol className="claims-list">{face.citations.map((item) => <li key={item.citation_id}><CitationRecord item={item} cursor={face.cursor} /></li>)}</ol>
      {face.next_after !== null && <p><Link href={citationsListPath(face.problem_id, "human", {
        ...snapshot, after: face.next_after, ...filter,
      })} prefetch={false}>Next citations at this snapshot</Link></p>}
      <CitationOmissions omitted={face.omitted} />
      <p><a href={`${result.origin}${citationsListPath(face.problem_id, "md", pageQuery)}`}>Canonical Markdown</a>{" · "}
        <a href={`${result.origin}${citationsListPath(face.problem_id, "json", pageQuery)}`}>Canonical JSON</a></p>
    </main>
  </>;
}

function ScientificReference({ problem, reference, cursor }: {
  readonly problem: string;
  readonly reference: string;
  readonly cursor: number;
}) {
  const link = questionReferenceLink(problem, reference, cursor);
  return link === null ? <code>{reference}</code> : <>
    <Link href={link.href} prefetch={false}>{reference}</Link>
    {link.currentOnly && <span className="quiet"> (current public source)</span>}
  </>;
}

export function CitationView({ result }: {
  readonly result: Extract<PublicRead<SingleCitationResponse>, { state: "ok" }>;
}) {
  const face = result.data;
  const item = face.citation;
  const snapshot = { through: face.cursor };
  const target = `${item.citation_id}@${item.version}`;
  return <>
    <a className="skip" href="#content">Skip to content</a>
    <main className="landing col problem-page" id="content">
      <header className="masthead">
        <nav aria-label="Breadcrumbs"><Link href={`/p/${encodeURIComponent(item.problem_id)}`}>{item.problem_id}</Link>{" / "}
          <Link href={citationsListPath(item.problem_id, "human", snapshot)} prefetch={false}>Literature and citations</Link></nav>
        <h1>{target}</h1>
        <p className="lede">Exact published citation · ledger snapshot {face.cursor}</p>
      </header>
      <p className="loop" role="note">Citation versions are immutable publications. A correction creates another version; it does not rewrite the selected source. Current public visibility controls still apply.</p>
      {result.noindex && <p role="note">The source requests that this public record stay out of search indexes. A guessable URL is not private.</p>}
      <nav aria-label="Citation version views">
        <Link href={citationPath(item.problem_id, target, "human", snapshot)} prefetch={false}>Link to this version and snapshot</Link>{" · "}
        <Link href={citationPath(item.problem_id, item.citation_id, "human", snapshot)} prefetch={false}>Latest version at this snapshot</Link>{" · "}
        <Link href={citationPath(item.problem_id, item.citation_id, "human")} prefetch={false}>Read the latest public version</Link>
      </nav>
      <CitationRecord item={item} cursor={face.cursor} />
      <CitationExports item={item} cursor={face.cursor} origin={result.origin} />
      <section aria-labelledby="citation-history"><h2 id="citation-history">Versions visible at this snapshot</h2>
        <p>Each link opens the actual published version and its own source provenance. Review the omissions below when history is incomplete.</p>
        {face.versions.length === 0 ? <p>No additional readable version history was returned.</p> : <ol className="claims-list">
          {face.versions.map((version) => <li key={version.version} className="citation-item">
            <CitationSummary item={version} cursor={face.cursor} />
            {version.version === item.version && <p><strong>Selected version</strong></p>}
            <p><time dateTime={version.created_at}>{version.created_at}</time>{" · "}
              <Link href={publicEventPath(version.problem_id, version.seq)} prefetch={false}>Publication event {version.seq}</Link></p>
          </li>)}
        </ol>}
      </section>
      <section aria-labelledby="citation-references"><h2 id="citation-references">Recorded scientific references</h2>
        <p>These references come from published scientific work at this ledger snapshot. A reference does not independently validate the source or the work that cites it.</p>
        <h3>Claims</h3>
        {face.associated_claims.length === 0 ? <p>No readable associated claims were returned.</p> : <ul className="claims-list">
          {face.associated_claims.map((claim) => <li key={`${claim.claim_id}@${claim.version}`} className="claim-card">
            <ScreeningNotice notice={claim.screening_notice} />
            <h4><ScientificReference problem={item.problem_id} reference={`${claim.claim_id}@${claim.version}`} cursor={face.cursor} /></h4>
            <ScientificBody body={claim.statement} namespace={`citation-${item.citation_id}-claim-${claim.claim_id}-${claim.version}`} />
          </li>)}
        </ul>}
        <h3>Evidence</h3>
        {face.associated_evidence.length === 0 ? <p>No readable associated evidence was returned.</p> : <ul className="claims-list">
          {face.associated_evidence.map((evidence) => <li key={evidence.evidence_id} className="claim-card">
            <ScreeningNotice notice={evidence.screening_notice} />
            <h4><ScientificReference problem={item.problem_id} reference={evidence.evidence_id} cursor={face.cursor} /></h4>
            <p>Recorded direction: {evidence.direction}. Evidence class: {evidence.computed_class}.</p>
            <p>Bears on: <ScientificReference problem={item.problem_id} reference={evidence.bears_on_id} cursor={face.cursor} />.</p>
          </li>)}
        </ul>}
      </section>
      <CitationOmissions omitted={face.omitted} />
    </main>
  </>;
}
