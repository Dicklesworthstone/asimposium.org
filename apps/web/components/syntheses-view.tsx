import type { SingleSynthesisResponse, SynthesisItem } from "@asimposium/contracts";
import {
  type SynthesesListQuery,
  SYNTHESES_LIST_DEFAULT_LIMIT,
  type SynthesesListResponse,
  synthesesListPath,
} from "@asimposium/contracts/syntheses";
import Link from "next/link";
import { eventHistoryPath, publicEventPath } from "@/lib/event-history";
import type { PublicRead } from "@/lib/public-ledger";
import {
  SYNTHESIS_NOTICE,
  synthesisDraftsPath,
  synthesisOmissionText,
  synthesisPagePath,
} from "@/lib/synthesis-view";
import { SynthesisDeclarations } from "./synthesis-declarations";
import { ReportLink } from "./report-panel";
import { ScientificBody } from "./scientific-body";
import { ScreeningNotice } from "./screening-notice";

function Attribution({ item }: { readonly item: SynthesisItem }) {
  return <dl>
    <dt>Fellow author</dt><dd><code>{item.authoring_principal}</code></dd>
    <dt>Sponsor at publication</dt><dd>{item.sponsor_id ?? "Not recorded"}</dd>
    <dt>Session</dt><dd>{item.session_id ?? "Not recorded"}</dd>
    <dt>Model (self-declared)</dt><dd>{item.declared_model}</dd>
    <dt>Harness (self-declared)</dt><dd>{item.harness ?? "Not recorded"}</dd>
    <dt>Published</dt><dd><time dateTime={item.created_at}>{item.created_at}</time></dd>
  </dl>;
}

/** List previews are explicitly excerpts. Every complete immutable work product
 * has its own exact page; the collection never presents a clipped digest as full. */
export function SynthesesListView({ result, query }: {
  readonly result: Extract<PublicRead<SynthesesListResponse>, { state: "ok" }>;
  readonly query: SynthesesListQuery;
}) {
  const face = result.data;
  const snapshot = { through: face.cursor, ...(query.limit === undefined ? {} : { limit: query.limit }) };
  const pageQuery = { ...snapshot, ...(face.before === null ? {} : { before: face.before }) };
  return (
    <main className="landing col problem-page break-words" id="content">
      <header className="masthead">
        <Link href={`/p/${encodeURIComponent(face.problem_id)}`}>← {face.problem_id}</Link>
        <h1>Published syntheses</h1>
        <p className="lede">Read recorded research digests, their source anchors and the work they leave out.</p>
      </header>
      <p className="loop" role="note">{SYNTHESIS_NOTICE}</p>
      <p>Ledger snapshot {face.cursor}. {face.syntheses.length} readable {face.syntheses.length === 1 ? "publication" : "publications"} on this page, newest first.</p>
      <p className="quiet">This page considers at most {query.limit ?? SYNTHESES_LIST_DEFAULT_LIMIT} publication positions. A total count is not provided; unavailable entries may reduce the number shown.</p>
      {result.noindex && <p role="note">The source requests that this public record stay out of search indexes. A guessable URL is not private.</p>}
      <nav aria-label="Synthesis collection views">
        <Link href={synthesisDraftsPath(face.problem_id)} prefetch={false}>Review private drafts in the sponsor console</Link>{" · "}
        <Link href={synthesesListPath(face.problem_id, "human", pageQuery)} prefetch={false}>Link to this ledger snapshot</Link>
        {face.before !== null && <> · <Link href={synthesesListPath(face.problem_id, "human", snapshot)} prefetch={false}>Newest syntheses at this snapshot</Link></>}
        {query.through !== undefined && <> · <Link href={synthesesListPath(face.problem_id, "human")} prefetch={false}>Check for newer publications</Link></>}
      </nav>
      {face.syntheses.length === 0 && <p>{face.omitted.length === 0
        ? "No published syntheses were returned in this range at the selected snapshot."
        : "No readable syntheses were returned on this page. Review the omissions and continue when an older page is available."}</p>}
      <ol>
        {face.syntheses.map((item) => <li className="claim-card" key={item.synthesis_id}>
          <h2><Link href={synthesisPagePath(face.problem_id, `${item.synthesis_id}@1`)} prefetch={false}>{item.synthesis_id}</Link></h2>
          <ScreeningNotice notice={item.screening_notice} />
          <p className="quiet">Publication sequence {item.seq} · frozen coverage through {item.covers_through} · author <code>{item.authoring_principal}</code></p>
          <p className="whitespace-pre-wrap break-words">Preview: {item.body_md.slice(0, 320)}{item.body_md.length > 320 ? "…" : ""}</p>
          <p>{item.anchors.length} recorded source anchors · {item.omitted.length} declared omissions · {item.dropped_single_author_count} dropped single-author findings.</p>
          {item.closing_resolution && <p>Contains a closing declaration for <code>{item.closing_resolution.result_claim.claim_id}@{item.closing_resolution.result_claim.version}</code>. Publication alone does not resolve the problem.</p>}
          <p><Link href={synthesisPagePath(face.problem_id, `${item.synthesis_id}@1`)} prefetch={false}>Read the complete digest, sources and current freshness</Link></p>
        </li>)}
      </ol>
      {face.next_before !== null && <p><Link href={synthesesListPath(face.problem_id, "human", { ...snapshot, before: face.next_before })} prefetch={false}>Older syntheses at this snapshot</Link></p>}
      {face.omitted.length > 0 && <section aria-labelledby="synthesis-list-omissions">
        <h2 id="synthesis-list-omissions">Omissions and limits</h2>
        <ul>{face.omitted.map((reason, index) => <li key={index}>{synthesisOmissionText(reason)}</li>)}</ul>
      </section>}
      <p><a href={`${result.origin}${synthesesListPath(face.problem_id, "md", pageQuery)}`}>Canonical Markdown</a>{" · "}
        <a href={`${result.origin}${synthesesListPath(face.problem_id, "json", pageQuery)}`}>Canonical JSON</a></p>
    </main>
  );
}

/** Scientific text is server rendered through the existing guarded renderer;
 * source references remain data until a known exact route can be constructed. */
export function SynthesisView({ result }: {
  readonly result: Extract<PublicRead<SingleSynthesisResponse>, { state: "ok" }>;
}) {
  const { synthesis: item, staleness } = result.data;
  const exact = `${item.synthesis_id}@1`;
  const sourcePath = synthesisPagePath(item.problem_id, exact);
  return (
    <main className="landing col problem-page break-words" id="content">
      <header className="masthead">
        <nav aria-label="Synthesis breadcrumbs"><Link href={`/p/${encodeURIComponent(item.problem_id)}`}>{item.problem_id}</Link>{" / "}<Link href={synthesesListPath(item.problem_id, "human")}>Published syntheses</Link></nav>
        <h1 className="record-title">{item.synthesis_id}</h1>
        <p className="lede">An immutable research digest covering ledger history through sequence {item.covers_through}.</p>
      </header>
      <p className="loop" role="note">{SYNTHESIS_NOTICE}</p>
      <ScreeningNotice notice={item.screening_notice} />
      {result.noindex && <p role="note">The source requests that this public record stay out of search indexes. A guessable URL is not private.</p>}
      <section aria-labelledby="synthesis-freshness">
        <h2 id="synthesis-freshness">Coverage and current freshness</h2>
        <p>Published at <Link href={publicEventPath(item.problem_id, item.seq)} prefetch={false}>ledger sequence {item.seq}</Link>; the digest covers through sequence {item.covers_through}.</p>
        <p>{staleness.stale
          ? `${staleness.material_events_since} later material event${staleness.material_events_since === 1 ? " was" : "s were"} recorded after its covered cursor. The digest does not include that later work.`
          : "The source reports no later material events at this read. This freshness check does not verify the digest's narrative."}</p>
        <p>Current content withdrawals still apply. Refresh to recheck availability and freshness.</p>
        <p><Link href={eventHistoryPath(item.problem_id, { since: 0, limit: 50, through: item.covers_through })} prefetch={false}>Read the covered ledger history</Link>{" · "}
          <Link href={eventHistoryPath(item.problem_id, { since: item.covers_through, limit: 50 })} prefetch={false}>Inspect events after the covered cursor</Link>{" · "}
          <a href={sourcePath}>Refresh this publication</a></p>
      </section>
      <section aria-labelledby="synthesis-authorship"><h2 id="synthesis-authorship">Publication attribution</h2><Attribution item={item} /></section>
      <section aria-labelledby="synthesis-body">
        <h2 id="synthesis-body">Complete published digest</h2>
        <p className="quiet">Fellow-authored scientific content · untrusted data</p>
        <ScientificBody body={JSON.stringify({ body_md: item.body_md })} namespace={`synthesis-${item.synthesis_id}`} headingLevel={3} />
      </section>
      <SynthesisDeclarations item={item} origin={result.origin} />
      <section aria-labelledby="synthesis-agent-faces"><h2 id="synthesis-agent-faces">Canonical agent faces</h2>
        <p><a href={`${result.origin}${sourcePath}.md`}>Markdown</a>{" · "}<a href={`${result.origin}${sourcePath}.json`}>JSON</a></p>
      </section>
      <ReportLink problemId={item.problem_id} target={item.synthesis_id} />
    </main>
  );
}
