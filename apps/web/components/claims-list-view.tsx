import { type ClaimsListResponse, claimsListPath } from "@asimposium/contracts/claims-list";
import { CLAIMS_LIST_NOTICE, CLAIMS_LIST_OMISSIONS, claimListEntryPath } from "@asimposium/render/claims-list";
import Link from "next/link";
import type { PublicRead } from "@/lib/public-ledger";
import { ScientificBody } from "./scientific-body";
import { ScreeningNotice } from "./screening-notice";

/** Complete collections stay useful with JavaScript disabled. Every next page
 * and exact statement keeps the captured cut, including after withheld pages. */
export function ClaimsListView({ result, historical }: {
  readonly result: Extract<PublicRead<ClaimsListResponse>, { state: "ok" }>;
  readonly historical: boolean;
}) {
  const face = result.data;
  const query = { through: face.cursor, after: face.after };
  return <>
    <a className="skip" href="#content">Skip to content</a>
    <main className="landing col problem-page" id="content">
      <header className="masthead">
        <Link href={`/p/${encodeURIComponent(face.problem_id)}`}>← {face.problem_id}</Link>
        <h1>Claims</h1>
        <p className="lede">Browse published claim statements beyond the problem digest.</p>
      </header>
      <p className="loop" role="note">{CLAIMS_LIST_NOTICE}</p>
      <p className="quiet">Ledger snapshot {face.cursor}. {face.count} readable {face.count === 1 ? "claim" : "claims"} on this page.</p>
      {result.noindex && <p role="note">This public record is unlisted. A guessable URL is not private.</p>}
      <nav aria-label="Claim collection views">
        <Link href={claimsListPath(face.problem_id, "human", query)} prefetch={false}>Link to this ledger snapshot</Link>
        {historical && <> · <Link href={claimsListPath(face.problem_id, "human")} prefetch={false}>Read the latest public claims</Link></>}
        {face.after > 0 && <> · <Link href={claimsListPath(face.problem_id, "human", { through: face.cursor, after: 0 })} prefetch={false}>First claims at this snapshot</Link></>}
      </nav>
      {face.claims.length === 0 && <p>{face.omitted.length > 0
        ? "No readable statements were returned on this page. See the omissions and continue when a next page is available."
        : "No published claim statements match this range at the selected snapshot."}</p>}
      <ol className="claims-list">
        {face.claims.map((claim) => <li className="claim-card" id={claim.id} key={claim.id}>
          <header className="claim-card-header">
            <h2><Link href={claimListEntryPath(face.problem_id, claim.id, claim.version, face.cursor, "human")} prefetch={false}>
              {claim.id}@{claim.version}
            </Link></h2>
            <p className="quiet">{claim.kind} · publication sequence {claim.source_seq} · untrusted author-supplied data</p>
          </header>
          {claim.stale && <p>This statement is marked stale. Inspect the exact claim record and its premises before relying on its standing.</p>}
          <ScreeningNotice notice={claim.screening_notice} />
          <ScientificBody body={JSON.stringify({ statement: claim.statement })} namespace={`claims-list-${claim.id}-${claim.version}`} />
          <footer className="claim-card-footer">
            <p className="quiet">Published <time dateTime={claim.created_at}>{claim.created_at}</time>.</p>
            <Link href={claimListEntryPath(face.problem_id, claim.id, claim.version, face.cursor, "human")} prefetch={false}>
              Read this exact statement, computed standing, evidence and reviews
            </Link>
          </footer>
        </li>)}
      </ol>
      {face.next_after !== null && <p><Link
        href={claimsListPath(face.problem_id, "human", { through: face.cursor, after: face.next_after })}
        prefetch={false}>Next claims at this snapshot</Link></p>}
      {face.omitted.length > 0 && <section aria-labelledby="omissions-heading">
        <h2 id="omissions-heading">Omissions and limits</h2>
        <ul>{face.omitted.map((reason) => <li key={reason}>{CLAIMS_LIST_OMISSIONS[reason]}</li>)}</ul>
      </section>}
      <p><a href={`${result.origin}${claimsListPath(face.problem_id, "md", query)}`}>Canonical Markdown</a>{" · "}
        <a href={`${result.origin}${claimsListPath(face.problem_id, "json", query)}`}>Canonical JSON</a></p>
    </main>
  </>;
}
