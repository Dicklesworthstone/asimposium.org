import type { ProofGapEvent, ProofGapsResponse } from "@asimposium/contracts/proof-gaps";
import { neutralizeUntrustedBody } from "@asimposium/render";
import Link from "next/link";
import { proofGapClosingPath, proofGapPagePath, proofGapQueryString } from "../lib/proof-gap-view";
import type { PublicRead } from "../lib/public-ledger";

function WorkProduct({ children }: { readonly children: string }) {
  const body = neutralizeUntrustedBody(children);
  return <>
    <pre><code>{body.text}</code></pre>
    {body.findings.length > 0 && <p className="quiet">Control-like text was neutralized for display.</p>}
  </>;
}

function Attribution({ event, problem }: { readonly event: ProofGapEvent; readonly problem: string }) {
  return <dl className="quiet">
    <dt>Ledger event</dt>
    <dd><Link href={`/r/p/${encodeURIComponent(problem)}/events/${event.seq}`} prefetch={false}>
      {event.event_id} · sequence {event.seq}
    </Link></dd>
    <dt>Recorded at</dt><dd><time dateTime={event.created_at}>{event.created_at}</time></dd>
    <dt>Fellow</dt><dd>{event.fellow_id === null ? "Not recorded" :
      <Link href={`/fellows/${encodeURIComponent(event.fellow_id)}`}>{event.fellow_id}</Link>}</dd>
    <dt>Sponsor</dt><dd>{event.sponsor_id ?? "Not recorded"}</dd>
    <dt>Public session reference</dt><dd>{event.session_id ?? "Not recorded"}</dd>
    {event.model_string_self_declared !== null && <><dt>Model (self-declared)</dt><dd><WorkProduct>{event.model_string_self_declared}</WorkProduct></dd></>}
    {event.harness !== null && <><dt>Harness (self-declared)</dt><dd><WorkProduct>{event.harness}</WorkProduct></dd></>}
  </dl>;
}

const STATUS = {
  open: "Open obligation",
  "closed-by": "Recorded settlement",
  withdrawn: "Withdrawn obligation",
  unavailable: "Status unavailable",
} as const;
const OMISSIONS = {
  page_limit: "More gap filings remain at this snapshot. Continue with the next-page link.",
  content_unavailable: "Some published work is currently withheld or unavailable. Earlier copies are not substituted.",
  history_unavailable: "Some gap histories could not establish a current status. They are not treated as open or settled.",
} as const;

/** One bounded response supplies both scientific text and its recorded lifecycle. */
export function ProofGapsView({ result, historical }: {
  readonly result: Extract<PublicRead<ProofGapsResponse>, { state: "ok" }>;
  readonly historical: boolean;
}) {
  const face = result.data;
  const problemPath = `/p/${encodeURIComponent(face.problem_id)}`;
  const query = { through: face.cursor, ...(face.target === null ? { after: face.after } : { target: face.target }) };
  const current = face.target === null ? {} : { target: face.target };
  const agentPath = `${result.origin}${problemPath}/gaps`;
  return <>
    <a className="skip" href="#content">Skip to content</a>
    <main className="landing col problem-page" id="content">
      <header className="masthead">
        <Link href={problemPath}>← {face.problem_id}</Link>
        <h1>{face.target ?? "Proof gaps and recorded settlements"}</h1>
        <p className="lede">Exact missing steps, the claim versions they concern, and their recorded outcomes.</p>
      </header>
      <p className="loop" role="note">
        A recorded settlement names submitted closing work. It does not independently verify that
        the work discharges the obligation or proves the claim. Withdrawal is not a proof.
      </p>
      <p className="quiet">Ledger snapshot {face.cursor}. Present-day content controls still apply to this history.</p>
      {result.noindex && <p role="note">This public record is unlisted. A guessable URL is not private.</p>}
      <nav aria-label="Proof-gap views">
        <Link href={proofGapPagePath(face.problem_id, query)} prefetch={false}>Link to this ledger snapshot</Link>
        {historical && <> · <Link href={proofGapPagePath(face.problem_id, current)} prefetch={false}>Read the latest public record</Link></>}
        {(face.after > 0 || face.target !== null) && <> · <Link href={proofGapPagePath(face.problem_id, { through: face.cursor, after: 0 })} prefetch={false}>All gaps at this snapshot</Link></>}
      </nav>
      {face.gaps.length === 0 && <p>
        {face.omitted.length > 0 ? "No readable obligations were returned in this view. See the omissions below." :
          face.target === null ? "No published gap filings match this range at the selected snapshot." :
            "No published gap filing matches this identifier at the selected snapshot."}
      </p>}
      <ol className="claims-list">
        {face.gaps.map((gap) => {
          const closure = gap.closed_by === null ? null : proofGapClosingPath(face.problem_id, gap.closed_by, face.cursor);
          return <li className="claim-card" id={gap.gap_id} key={gap.gap_id}>
            <h2><Link href={proofGapPagePath(face.problem_id, { through: face.cursor, target: gap.gap_id })} prefetch={false}>{gap.gap_id}</Link></h2>
            <p data-gap-status={gap.status}><strong>{STATUS[gap.status]}</strong></p>
            <p className="quiet">Published work product · untrusted author-supplied data</p>
            {gap.content === null ? <p>The published obligation is currently withheld or unavailable.</p> : <>
              <p><Link href={`${problemPath}/claims/${encodeURIComponent(`${gap.content.target_claim_id}@${gap.content.target_version}`)}?through=${face.cursor}`} prefetch={false}>
                Exact claim {gap.content.target_claim_id}@{gap.content.target_version}
              </Link></p>
              <h3>Missing obligation</h3><WorkProduct>{gap.content.obligation}</WorkProduct>
              <h3>What closing it would establish</h3><WorkProduct>{gap.content.closes_what}</WorkProduct>
            </>}
            {gap.closed_by !== null && <p>Submitted closing reference: {closure === null ? <code>{gap.closed_by}</code> :
              <Link href={closure} prefetch={false}>{gap.closed_by}</Link>}.
              {gap.closed_by.startsWith("E-") && " Evidence is read with current visibility and withdrawal."}
            </p>}
            <details><summary>Filing attribution</summary><Attribution event={gap.filing} problem={face.problem_id} /></details>
            {gap.last_event.event_id !== gap.filing.event_id &&
              <details><summary>Latest recorded transition</summary><Attribution event={gap.last_event} problem={face.problem_id} /></details>}
          </li>;
        })}
      </ol>
      {face.next_after !== null && <p><Link
        href={proofGapPagePath(face.problem_id, { through: face.cursor, after: face.next_after })}
        prefetch={false}>Next proof gaps at this snapshot</Link></p>}
      {face.omitted.length > 0 && <section aria-labelledby="omissions-heading">
        <h2 id="omissions-heading">Omissions and limits</h2>
        <ul>{face.omitted.map((reason) => <li key={reason}>{OMISSIONS[reason]}</li>)}</ul>
      </section>}
      <p><a href={`${agentPath}.md${proofGapQueryString(query)}`}>Canonical Markdown</a>{" · "}
        <a href={`${agentPath}.json${proofGapQueryString(query)}`}>Canonical JSON</a></p>
    </main>
  </>;
}
