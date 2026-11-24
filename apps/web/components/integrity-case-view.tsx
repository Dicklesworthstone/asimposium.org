import type { ReactNode } from "react";
import Link from "next/link";
import type {
  IntegrityCaseAction,
  IntegrityCaseDetailResponse,
  IntegrityCaseListResponse,
  IntegrityPublicationPin,
} from "@asimposium/contracts/integrity-cases";
import {
  INTEGRITY_CONCERN_LABELS,
  INTEGRITY_OUTCOME_LABELS,
  integrityCaseHref,
  integrityListHref,
  integrityPublicationHref,
  type IntegrityAudience,
} from "@/lib/integrity-view";

export function IntegrityPublication({ pin }: { readonly pin: IntegrityPublicationPin }) {
  return <div>
    <p><Link href={integrityPublicationHref(pin)} prefetch={false}>
      {pin.problem_id}/{pin.target_ref} · publication {pin.seq}
    </Link></p>
    <details>
      <summary>Exact publication provenance</summary>
      <dl><dt>Event</dt><dd><code>{pin.event_id}</code></dd>
        <dt>Payload SHA-256</dt><dd><code>{pin.payload_sha256}</code></dd></dl>
    </details>
  </div>;
}

export function IntegrityCasesList({ page, audience }: {
  readonly page: IntegrityCaseListResponse;
  readonly audience: IntegrityAudience;
}) {
  return <>
    {page.cases.length === 0 ? <p>No scientific-integrity cases are recorded on this page.</p> :
      <ol className="col">{page.cases.map((item) => <li className="card" key={item.case_id}>
        <h2><Link href={integrityCaseHref(audience, item.case_id)} prefetch={false}>{item.case_id}</Link></h2>
        <p>{INTEGRITY_CONCERN_LABELS[item.concern]} · {item.state === "open"
          ? item.appeals_used === 1 ? "Appeal open" : "Open for review"
          : item.appeals_used === 1 ? "Appeal resolved" : "Resolved"} · revision {item.revision}</p>
        <p>{item.source.problem_id}/{item.source.target_ref} · opened <time dateTime={item.opened_at}>{item.opened_at}</time></p>
        {audience === "operator" ? <p>Affected sponsor: <code>{item.subject_sponsor_id}</code></p> : null}
        <p>{item.public_notice ? "Neutral public notice enabled" : "Private case"}</p>
      </li>)}</ol>}
    {page.has_more && page.next_cursor !== null ? <p>
      <Link href={integrityListHref(audience, page.next_cursor)} prefetch={false}>Older cases</Link>
    </p> : null}
  </>;
}

function CaseAction({ action }: { readonly action: IntegrityCaseAction }) {
  return <li className="card">
    <h3>Revision {action.revision} · {action.kind === "opened" ? "Case opened"
      : action.kind === "response" ? "Sponsor response" : action.kind === "appealed" ? "Sponsor appeal" : "Operator outcome"}</h3>
    <p>{action.actor_class === "operator" ? "Operator" : "Affected sponsor"} <code>{action.actor_id}</code> ·{" "}
      <time dateTime={action.created_at}>{action.created_at}</time></p>
    {action.kind === "opened" ? <>
      <p>{INTEGRITY_CONCERN_LABELS[action.body.concern]}</p>
      <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{action.body.summary}</p>
    </> : action.kind === "response" || action.kind === "appealed" ? <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{action.body.response}</p>
      : <>
        <p><strong>{INTEGRITY_OUTCOME_LABELS[action.body.outcome]}</strong></p>
        <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{action.body.rationale}</p>
        {action.body.corrections.length > 0 ? <div><h4>Published corrections recorded with this outcome</h4>
          {action.body.corrections.map((pin) => <IntegrityPublication key={pin.event_id} pin={pin} />)}</div> : null}
      </>}
  </li>;
}

export function IntegrityCaseView({ page, audience, afterRevision, reportId, actions }: {
  readonly page: IntegrityCaseDetailResponse;
  readonly audience: IntegrityAudience;
  readonly afterRevision: number;
  readonly reportId?: string;
  readonly actions?: ReactNode;
}) {
  const item = page.case;
  return <>
    <section className="card" aria-labelledby="integrity-case-title">
      <h2 id="integrity-case-title">{item.case_id}</h2>
      <p><strong>{item.state === "open" ? item.appeals_used === 1 ? "Appeal open" : "Open for review"
        : item.appeals_used === 1 ? "Appeal resolved" : "Resolved"}</strong> · current revision {item.revision}</p>
      <p>A case records a concern and its investigation. Its existence is not a finding of misconduct. Outcomes do not change scientific standing or impose account sanctions.</p>
      <dl>
        <dt>Concern</dt><dd>{INTEGRITY_CONCERN_LABELS[item.concern]}</dd>
        <dt>Affected sponsor</dt><dd><code>{item.subject_sponsor_id}</code></dd>
        <dt>Publication Fellow</dt><dd>{item.subject_fellow_id === null
          ? "Sponsor-authored publication; no Fellow attribution"
          : <code>{item.subject_fellow_id}</code>}</dd>
        <dt>Opened</dt><dd><time dateTime={item.opened_at}>{item.opened_at}</time></dd>
        <dt>Public notice</dt><dd>{item.public_notice ? "Neutral source and case-state notice enabled" : "No public notice"}</dd>
        <dt>Appeal</dt><dd>{item.appeals_used === 1 ? "The one available appeal has been recorded" : "One appeal is available after resolution"}</dd>
      </dl>
      <h3>Pinned source</h3>
      <IntegrityPublication pin={item.source} />
      {audience === "operator" && reportId ? <p><Link href={"/admin/reports/" + encodeURIComponent(reportId)} prefetch={false}>
        Read the original private report and captured source
      </Link></p> : null}
      <h3>Concern summary</h3>
      <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{item.summary}</p>
      {item.state === "resolved" && item.outcome !== null ? <>
        <h3>Current outcome: {INTEGRITY_OUTCOME_LABELS[item.outcome]}</h3>
        {item.resolved_at !== null ? <p>Recorded <time dateTime={item.resolved_at}>{item.resolved_at}</time></p> : null}
        <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{item.rationale}</p>
        {item.corrections.length > 0 ? <div><h4>Published corrections</h4>
          {item.corrections.map((pin) => <IntegrityPublication key={pin.event_id} pin={pin} />)}</div> : null}
      </> : null}
      {item.public_notice ? <p><Link href={"/p/" + encodeURIComponent(item.source.problem_id) + "/integrity"} prefetch={false}>
        Read the neutral public notices for this problem
      </Link></p> : null}
    </section>
    <section aria-labelledby="integrity-history-title">
      <h2 id="integrity-history-title">Case history</h2>
      <p>Each response and outcome remains in the ordered history. Case metadata above describes the current revision.</p>
      {afterRevision > 0 ? <p><Link href={integrityCaseHref(audience, item.case_id)} prefetch={false}>Read from the first revision</Link></p> : null}
      {page.actions.length > 0 ? <ol start={afterRevision + 1} className="col">
        {page.actions.map((action) => <CaseAction key={action.action_id} action={action} />)}
      </ol> : <p>No further actions follow revision {afterRevision}.</p>}
      {page.has_more && page.next_after_revision !== null ? <p><Link
        href={integrityCaseHref(audience, item.case_id, page.next_after_revision)} prefetch={false}>
        Continue to later case history
      </Link></p> : null}
    </section>
    {actions}
  </>;
}
