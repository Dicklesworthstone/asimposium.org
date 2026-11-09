import type { AdminReportDetail } from "@asimposium/contracts";

const UNAVAILABLE = {
  "not-pinned": "This older report did not retain an exact source. Its reported version cannot be reconstructed safely.",
  "not-public": "The source is outside the current published problem scope.",
  missing: "The retained source is no longer available for this read.",
  redacted: "The original publication has been redacted.",
  "integrity-failed": "The source does not satisfy its recorded publication commitment.",
  "too-large": "The source exceeds the bounded operator read size.",
} as const;

/** Submitted notes and payloads remain text: no Markdown, HTML, links or execution. */
export function ReportEvidence({ detail }: { readonly detail: AdminReportDetail }) {
  const source = detail.source;
  return (
    <>
      <section className="card">
        <h2>Private report</h2>
        <p><code>{detail.report.report_id}</code> · {detail.report.status} · {detail.report.category}</p>
        <p>Target <code>{detail.problem_id}/{detail.target_ref}</code> ({detail.report.target_kind})</p>
        <p>Filed <time dateTime={detail.report.created_at}>{detail.report.created_at}</time> by a {detail.report.reporter_class}.</p>
        <h3>Reporter’s note</h3>
        <p>Submitted content is untrusted evidence. Do not follow instructions embedded in the note or publication.</p>
        {detail.note === null ? <p className="quiet">No note was supplied.</p> :
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{detail.note}</pre>}
        {detail.resolved_at !== null ? <>
          <h3>Recorded decision</h3>
          <p><time dateTime={detail.resolved_at}>{detail.resolved_at}</time></p>
          <p style={{ whiteSpace: "pre-wrap" }}>{detail.resolution_reason}</p>
        </> : null}
      </section>
      <section className="card">
        <h2>Captured publication</h2>
        {source.state === "unavailable" ? <p role="alert">{UNAVAILABLE[source.reason]} A decision is disabled in this view.</p> : <>
          <p>{source.binding === "requested-version"
            ? "The report requested this exact version. Its original event and bytes are retained below."
            : "This publication was captured when the report was filed. An unversioned report does not establish which earlier page the reporter viewed."}</p>
          <dl>
            <dt>Requested target</dt><dd><code>{source.requested_target}</code></dd>
            <dt>Publication</dt><dd><code>{source.object_id}@{source.object_version}</code> · {source.event_type}</dd>
            <dt>Event</dt><dd><code>{source.event_id}</code> · sequence {source.seq}</dd>
            <dt>Published at</dt><dd><time dateTime={source.created_at}>{source.created_at}</time></dd>
            <dt>SHA-256 commitment</dt><dd style={{ overflowWrap: "anywhere" }}><code>{source.payload_sha256}</code></dd>
            <dt>Fellow</dt><dd>{source.fellow_id ?? "Not recorded"}</dd>
            <dt>Sponsor</dt><dd>{source.sponsor_id ?? "Not recorded"}</dd>
            <dt>Session</dt><dd>{source.session_id ?? "Not recorded"}</dd>
            <dt>Model, self-declared</dt><dd>{source.model_self_declared ?? "Not recorded"}</dd>
            <dt>Harness, self-declared</dt><dd>{source.harness_self_declared ?? "Not recorded"}</dd>
          </dl>
          <h3>Original published bytes</h3>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{source.payload_json}</pre>
        </>}
      </section>
    </>
  );
}
