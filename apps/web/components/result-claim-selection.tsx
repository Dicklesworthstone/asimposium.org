import { claimsListPath, type ClaimsListResponse } from "@asimposium/contracts/claims-list";
import Link from "next/link";
import { directiveDisclosureHref } from "@/lib/directive-disclosure-target";
import { type ResultClaimPreview, resultClaimConsolePath } from "@/lib/result-claim-view";
import { ScientificBody } from "./scientific-body";
import { ScreeningNotice } from "./screening-notice";

export function ResultClaimChoices({ problemId, page, selected, disabled, onSelect }: {
  readonly problemId: string;
  readonly page: ClaimsListResponse | null;
  readonly selected?: string;
  readonly disabled: boolean;
  readonly onSelect: (claimId: string, version: number) => void;
}) {
  return (
    <section aria-labelledby="result-claim-choices-heading">
      <h3 id="result-claim-choices-heading">Choose a published result claim</h3>
      <p>Inspect the exact statement before requesting result review. Selecting a row loads its current public record and rechecks your authority.</p>
      {page === null ? (
        <p role="status">Published claim choices are unavailable. Reload this page or load a known exact claim below.</p>
      ) : (
        <>
          <p>{page.claims.length} readable claims on this page at ledger snapshot {page.cursor}.</p>
          {page.claims.length === 0 && <p>{page.omitted.includes("content_unavailable")
            ? "The claims in this range could not be read. Continue to the next page when available."
            : "This range returned no claims."}</p>}
          <ul className="claims-list">
            {page.claims.map((claim) => {
              const target = `${claim.id}@${claim.version}`;
              return <li className="claim-card" key={claim.id}>
                <h4><Link href={`/p/${encodeURIComponent(problemId)}/claims/${encodeURIComponent(target)}?through=${page.cursor}`} prefetch={false}>
                  {target}
                </Link>{" · "}{claim.kind}</h4>
                <ScreeningNotice notice={claim.screening_notice} />
                <ScientificBody body={claim.statement} namespace={`result-choice-${target}`} />
                {claim.stale && <p>Statement drift is recorded. Inspect the claim and its current problem formulation before requesting result review.</p>}
                <button type="button" className="btn-quiet" disabled={disabled}
                  onClick={() => { if (!disabled) onSelect(claim.id, claim.version); }}>
                  Load exact preview of {target}
                </button>
              </li>;
            })}
          </ul>
          {page.omitted.length > 0 && <ul aria-label="Claim selection reading limits">
            {page.omitted.includes("content_unavailable") && <li>Some publication content is unavailable under current visibility or source-integrity checks.</li>}
            {page.omitted.includes("standing_unavailable") && <li>Some scientific standing could not be established. Inspect the exact claim before relying on its status.</li>}
            {page.omitted.includes("page_limit") && <li>Further publication positions remain beyond this page.</li>}
          </ul>}
          <nav aria-label="Result claim selection pages">
            {page.after > 0 && <p><Link href={resultClaimConsolePath(problemId, selected, { through: page.cursor })} prefetch={false}>First claims at this snapshot</Link></p>}
            {page.next_after !== null && <p><Link href={resultClaimConsolePath(problemId, selected, { through: page.cursor, after: page.next_after })} prefetch={false}>Next claims at this snapshot</Link></p>}
            <p><Link href={resultClaimConsolePath(problemId, selected)} prefetch={false}>Refresh current claim choices</Link></p>
          </nav>
        </>
      )}
      <p><Link href={claimsListPath(problemId, "human", page === null ? {} : { through: page.cursor })} prefetch={false}>Browse the public claims collection</Link></p>
    </section>
  );
}

export function ResultClaimReview({ preview }: { readonly preview: ResultClaimPreview }) {
  const state = preview.state;
  const target = `${state.claim_id}@${state.version}`;
  const path = `/p/${encodeURIComponent(preview.problemId)}/claims/${encodeURIComponent(target)}`;
  return (
    <section aria-labelledby="result-claim-preview-heading">
      <h3 id="result-claim-preview-heading">Exact result claim {target}</h3>
      <p>Read at problem ledger snapshot {preview.cursor}. Admission rechecks the current statement, your authority and the required sponsor disclosures.</p>
      <ScreeningNotice notice={preview.publication.screening_notice} />
      <ScientificBody body={preview.publication.body} namespace={`result-preview-${target}`} />
      <dl>
        <dt>Computed disposition</dt><dd>{state.disposition}</dd>
        <dt>Review state</dt><dd>{state.review_state}</dd>
        <dt>Sponsor disclosure</dt><dd>{state.directive_disclosure ?? "unavailable"}</dd>
        <dt>Latest published version</dt><dd>{state.claim_id}@{state.latest_version}</dd>
      </dl>
      {state.stale && <p role="note">This claim is marked stale. Read its problem formulation and pinned premises before requesting result review.</p>}
      {state.latest_version !== state.version && <p role="note">A later claim version is available. Select and preview that version before requesting result review.</p>}
      {state.directive_disclosure !== "satisfied" && <p role="note">The required sponsor disclosures are incomplete or unavailable. Each accountable sponsor must complete their own interval before this result can enter review.</p>}
      <p><Link href={`${path}?through=${preview.cursor}`} prefetch={false}>Read the complete claim, evidence and reviews at this snapshot</Link></p>
      <p><Link href={directiveDisclosureHref({ problemId: preview.problemId, claimId: state.claim_id, version: state.version })} prefetch={false}>Inspect and complete sponsor disclosure for this exact result</Link></p>
    </section>
  );
}
