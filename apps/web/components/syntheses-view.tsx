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
  synthesisAnchorLinks,
  synthesisConsolePath,
  synthesisOmissionText,
  synthesisPagePath,
} from "@/lib/synthesis-view";
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

function DeclaredItems({ items }: { readonly items: readonly string[] }) {
  return <ul>{items.map((text, index) => <li key={index} className="whitespace-pre-wrap break-words">{text}</li>)}</ul>;
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
  return <>
    <a className="skip" href="#content">Skip to content</a>
    <main className="landing col problem-page" id="content">
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
  </>;
}

/** Scientific text is server rendered through the existing guarded renderer;
 * source references remain data until a known exact route can be constructed. */
export function SynthesisView({ result }: {
  readonly result: Extract<PublicRead<SingleSynthesisResponse>, { state: "ok" }>;
}) {
  const { synthesis: item, staleness } = result.data;
  const exact = `${item.synthesis_id}@1`;
  const sourcePath = synthesisPagePath(item.problem_id, exact);
  const declaration = item.closing_resolution;
  return <>
    <a className="skip" href="#content">Skip to content</a>
    <main className="landing col problem-page" id="content">
      <header className="masthead">
        <nav aria-label="Synthesis breadcrumbs"><Link href={`/p/${encodeURIComponent(item.problem_id)}`}>{item.problem_id}</Link>{" / "}<Link href={synthesesListPath(item.problem_id, "human")}>Published syntheses</Link></nav>
        <h1>{item.synthesis_id}</h1>
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
        <ScientificBody body={JSON.stringify({ body_md: item.body_md })} namespace={`synthesis-${item.synthesis_id}`} />
      </section>
      <section aria-labelledby="synthesis-anchors">
        <h2 id="synthesis-anchors">Recorded source anchors</h2>
        <p>Anchors identify the publications the author referenced. A reference does not establish that its summary is correct, or that the source remains available.</p>
        <ol>{item.anchors.map((anchor, index) => {
          const links = synthesisAnchorLinks(item.problem_id, anchor, item.covers_through);
          return <li className="claim-card" key={index}>
            <p><strong>{anchor.target_kind}</strong>{" "}<code>{anchor.target_id}{anchor.target_version === undefined ? "" : `@${anchor.target_version}`}</code></p>
            {anchor.assertion_summary && <p className="whitespace-pre-wrap break-words">Author&apos;s summary: {anchor.assertion_summary}</p>}
            {links.human && <p><Link href={links.human} prefetch={false}>Read the referenced public record</Link></p>}
            {links.agent && <p><a href={`${result.origin}${links.agent}`}>Read the exact canonical source (JSON)</a></p>}
            {links.event ? <p><Link href={links.event} prefetch={false}>Recorded source event at sequence {anchor.target_seq}</Link></p>
              : <p className="quiet">No exact event sequence was recorded for this anchor.</p>}
            {!links.human && !links.agent && <p className="quiet">This reference has no supported exact object link here; use its recorded event when available.</p>}
          </li>;
        })}</ol>
      </section>
      <section aria-labelledby="synthesis-selection">
        <h2 id="synthesis-selection">Selection policy and declared omissions</h2>
        <p className="whitespace-pre-wrap break-words">{item.selection_policy}</p>
        <p>{item.dropped_single_author_count} single-author findings were recorded as dropped when this synthesis was published.</p>
        {item.omitted.length === 0 ? <p>The author declared no omitted items. This is not a guarantee of completeness.</p> : <DeclaredItems items={item.omitted} />}
      </section>
      {declaration && <section aria-labelledby="synthesis-closing">
        <h2 id="synthesis-closing">Author&apos;s closing declaration</h2>
        <p>Proposed direction: <strong>{declaration.direction}</strong>. This publication does not establish that the problem has been resolved.</p>
        <p>Result claim: <Link href={`/p/${encodeURIComponent(item.problem_id)}/claims/${encodeURIComponent(`${declaration.result_claim.claim_id}@${declaration.result_claim.version}`)}?through=${item.covers_through}`} prefetch={false}>{declaration.result_claim.claim_id}@{declaration.result_claim.version}</Link>.</p>
        <h3>Declared verified scope</h3><DeclaredItems items={declaration.no_claim_boundary.verified} />
        <h3>Declared verification mechanisms</h3><DeclaredItems items={declaration.no_claim_boundary.mechanisms} />
        <h3>Declared independence tiers</h3><DeclaredItems items={declaration.no_claim_boundary.independence_tiers} />
        <h3>Remaining external validation</h3><DeclaredItems items={declaration.no_claim_boundary.remaining_external_validation} />
        <p><Link href={synthesisConsolePath(item.problem_id, item.synthesis_id)} prefetch={false}>Review this closing synthesis in the sponsor console</Link></p>
        <p className="quiet">The console verifies current sponsor authority and loads this exact publication again before any separate resolution confirmation.</p>
      </section>}
      <section aria-labelledby="synthesis-agent-faces"><h2 id="synthesis-agent-faces">Canonical agent faces</h2>
        <p><a href={`${result.origin}${sourcePath}.md`}>Markdown</a>{" · "}<a href={`${result.origin}${sourcePath}.json`}>JSON</a></p>
      </section>
    </main>
  </>;
}
