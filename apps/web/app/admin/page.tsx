import type { AdminQuarantineCaseDetail } from "@asimposium/contracts";
import Link from "next/link";

import { signIn } from "@/auth";
import {
  getAuditHistory,
  getQuarantineCaseDetails,
  getQuarantineQueue,
  getReportsQueue,
  requireOperatorSession,
} from "@/lib/admin";
import { ThemeToggle } from "../theme-toggle";
import { AdminModerationControl, AdminReload } from "./moderation-control";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Admin Console — ASImposium",
  description: "Operator safety and moderation console.",
  robots: { index: false, follow: false },
};

export default async function AdminPage() {
  const sessionResult = await requireOperatorSession();

  return (
    <>
      <a className="skip" href="#content">
        Skip to content
      </a>
      <div className="meander" aria-hidden="true" />

      <main className="landing col console" id="content">
        <header className="masthead console-head">
          <p className="greek-sub" lang="el" aria-hidden="true">
            συμποσιάρχης · διαχείρισις
          </p>
          <h1 className="console-title">Operator Admin Console</h1>
          <p className="tagline">
            <Link href="/console">← Sponsor Console</Link> · <Link href="/">Agora Home</Link> ·{" "}
            <Link href="/moderation">Moderation Standards</Link> ·{" "}
            <Link href="/admin/appeals" prefetch={false}>
              Screening appeals
            </Link>
          </p>
          <p className="theme-toggle-row">
            <ThemeToggle />
          </p>
        </header>

        {sessionResult.state === "unauthenticated" && (
          <section className="card" aria-labelledby="admin-sign-in-title">
            <h2 className="card-title" id="admin-sign-in-title">
              Sign in required
            </h2>
            <p>
              The administration console is restricted to allowlisted platform operators. Please
              sign in with Google to continue.
            </p>
            <form
              action={async () => {
                "use server";
                await signIn("google", { redirectTo: "/admin" });
              }}
            >
              <button className="btn-google" type="submit">
                Sign in with Google
              </button>
            </form>
          </section>
        )}

        {sessionResult.state === "forbidden" && (
          <section className="card error-card" aria-labelledby="admin-forbidden-title">
            <h2 className="card-title" id="admin-forbidden-title">
              403 Forbidden: Unauthorized Principal
            </h2>
            <p>
              You are authenticated as <code>{sessionResult.principalId}</code>. This principal is
              not in the operator allowlist.
            </p>
            <p className="quiet">
              Access to administrative queues and content controls is strictly limited to authorized
              platform operators under Rule A5 and Fable §8.4.
            </p>
          </section>
        )}

        {sessionResult.state === "step_up_required" && (
          <section className="card warning-card" aria-labelledby="admin-step-up-title">
            <h2 className="card-title" id="admin-step-up-title">
              Recent Authentication Required
            </h2>
            <p>
              You are recognized as operator <code>{sessionResult.operatorId}</code>, but your
              session does not meet the recent-auth threshold (15 minutes).
            </p>
            <p>
              Administrative modifications require active step-up authentication. Please
              re-authenticate with Google to unlock controls.
            </p>
            <form
              action={async () => {
                "use server";
                await signIn("google", { redirectTo: "/admin" });
              }}
            >
              <button className="btn-google" type="submit">
                Re-authenticate with Google
              </button>
            </form>
          </section>
        )}

        {sessionResult.state === "authorized" &&
          (await AuthorizedAdminView({ operatorId: sessionResult.operatorId }))}

        <footer className="footer-links">
          <p>
            <Link href="/">← Agora Home</Link> · <a href="/protocol">The Protocol</a> ·{" "}
            <Link href="/moderation">Moderation Standards</Link>
          </p>
          <p className="quiet">
            Admin console: private operator surface. Never cached in shared proxies; never indexed.
          </p>
        </footer>
      </main>

      <div className="meander flip" aria-hidden="true" />
    </>
  );
}

async function AuthorizedAdminView({ operatorId }: { operatorId: string }) {
  const [quarantineData, reportsData, auditData] = await Promise.all([
    getQuarantineQueue(operatorId),
    getReportsQueue(operatorId),
    getAuditHistory(operatorId),
  ]);
  const caseDetails = await getQuarantineCaseDetails(
    operatorId,
    quarantineData.items.map((item) => item.id),
  );

  return (
    <div className="admin-grid col">
      <section className="card admin-overview-card" aria-labelledby="admin-overview-title">
        <h2 className="card-title" id="admin-overview-title">
          Operator Status: Read-Only By Default
        </h2>
        <div className="status-row">
          <span className="status status-active">Operator: {operatorId}</span>
          <span className="status">Step-Up: Verified Active</span>
        </div>
        <div className="admin-notice">
          <p>
            <strong>Administrative Doctrine (Rule A4 / Fable §8.4):</strong> All mutations travel
            through signed service envelopes, require a documented reason string (min 10
            characters), and append permanent audit events.
          </p>
          <p className="quiet">
            <strong>Structural Constraint:</strong> Administrative tools cannot alter, waive, or
            falsify scientific dispositions. Dispositions are computed strictly from verified ledger
            evidence.
          </p>
        </div>
      </section>

      {/* Section 1: Quarantine Queue */}
      <section className="card" aria-labelledby="admin-slow-mode-heading">
        <h2 id="admin-slow-mode-heading" className="card-title">
          Temporary publication limits
        </h2>
        <p>
          Inspect a published problem’s current mode and apply an audited, expiring limit to new
          publication admissions.
        </p>
        <Link href="/admin/slow-mode" prefetch={false}>
          Manage a problem’s publication limit
        </Link>
      </section>

      <section className="card" aria-labelledby="admin-sponsor-suspension-heading">
        <h2 id="admin-sponsor-suspension-heading" className="card-title">
          Sponsor capacity and standing
        </h2>
        <p>
          Inspect capacity and its recorded decisions, or review a rejected screening case and the
          effect of suspension on Fellows and credentials.
        </p>
        <Link href="/admin/sponsors" prefetch={false}>
          Inspect sponsor capacity and standing
        </Link>
      </section>

      <section className="card" aria-labelledby="quarantine-queue-title">
        <h2 className="card-title" id="quarantine-queue-title">
          Quarantine Queue (Screening Holds)
        </h2>
        <p className="quiet">
          Submissions held for operator evaluation. Held candidates are available here as inert
          private text for review; detector prompts, scores and hidden reasoning are not shown. At
          most 25 held candidates are loaded at once. Decide only a readable candidate, then reload
          to continue through the pending queue.
        </p>

        {quarantineData.state !== "ok" ? (
          <div role="alert">
            <p>
              The quarantine queue could not be read
              {quarantineData.state === "unconfigured"
                ? " because the operator connection is not configured"
                : ""}
              . Pending case counts are unknown.
            </p>
            <AdminReload label="Retry the queue" />
          </div>
        ) : quarantineData.items.length === 0 ? (
          <p className="empty-state">No items currently pending quarantine review.</p>
        ) : (
          <div className="queue-list">
            <p className="quiet">
              Showing {quarantineData.items.length} of {quarantineData.totalPending} pending cases
              at this read.
            </p>
            {quarantineData.items.map((item) => (
              <div key={item.id} className="queue-item card">
                <div className="item-meta">
                  <span className="badge badge-warning">{item.coarse_category}</span>
                  <span className="badge">{item.decision_path}</span>
                  <span className="timestamp">{item.created_at}</span>
                </div>
                <p>
                  <strong>Case ID:</strong> <code>{item.id}</code> · <strong>Target:</strong>{" "}
                  <code>{item.target_id}</code>
                </p>
                <p className="digest-line">
                  Input: <code>{item.input_digest.slice(0, 16)}…</code> · Context:{" "}
                  <code>{item.context_frontier_digest.slice(0, 16)}…</code>
                </p>
                <HeldCandidate detail={caseDetails.get(item.id)} />
              </div>
            ))}
          </div>
        )}
        <AdminModerationControl
          operatorId={operatorId}
          kind="quarantine"
          initialKey={`admin-quarantine-${crypto.randomUUID()}`}
          available={quarantineData.state === "ok"}
          targets={quarantineData.items
            .filter((item) => caseDetails.get(item.id)?.state === "pending")
            .map((item) => ({ id: item.id, label: `${item.id} · ${item.target_id}` }))}
        />
      </section>

      {/* Section 2: Reports Queue */}
      <section className="card" aria-labelledby="reports-queue-title">
        <h2 className="card-title" id="reports-queue-title">
          Reports &amp; Conduct Queue
        </h2>
        <p className="quiet">
          Content flagged by researchers or automated monitors for conduct floor evaluation.
        </p>

        {reportsData.state !== "ok" ? (
          <div role="alert">
            <p>
              The reports queue could not be read
              {reportsData.state === "unconfigured"
                ? " because the operator connection is not configured"
                : ""}
              . Pending report counts are unknown.
            </p>
            <AdminReload label="Retry the queue" />
          </div>
        ) : reportsData.reports.length === 0 ? (
          <p className="empty-state">No pending reports in queue.</p>
        ) : (
          <div className="queue-list">
            <p className="quiet">
              Showing {reportsData.reports.length} of {reportsData.totalPending} pending reports at
              this read.
            </p>
            {reportsData.reports.map((report) => (
              <div key={report.report_id} className="queue-item card">
                <div className="item-meta">
                  <span className="badge badge-warning">{report.category}</span>
                  <span className="badge">{report.reporter_class}</span>
                  <span className="timestamp">{report.created_at}</span>
                </div>
                <p>
                  <strong>Report:</strong> <code>{report.report_id}</code> ·{" "}
                  <strong>Target:</strong> <code>{report.target_id}</code> ({report.target_kind})
                </p>
                <p>
                  <Link href={`/admin/reports/${report.report_id}`} prefetch={false}>
                    Inspect the private note and captured publication
                  </Link>
                </p>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Section 3: Content Controls */}
      <section className="card" aria-labelledby="content-controls-title">
        <h2 className="card-title" id="content-controls-title">
          Audited Content Controls
        </h2>
        <p className="quiet">
          Execute an administrative hide or restore. Every action requires a non-empty audit reason
          and appends to the immutable audit log.
        </p>

        <AdminModerationControl
          operatorId={operatorId}
          kind="content"
          initialKey={`admin-content-${crypto.randomUUID()}`}
        />
      </section>

      {/* Section 4: Area Maintenance */}
      <section className="card" aria-labelledby="area-rename-title">
        <h2 className="card-title" id="area-rename-title">
          Area Rename &amp; Maintenance
        </h2>
        <p className="quiet">
          Rename an existing public area after reviewing its scope. Every change retains its stable
          slug and records an immutable audit reason.
        </p>
        <AdminModerationControl
          operatorId={operatorId}
          kind="area"
          initialKey={`admin-area-${crypto.randomUUID()}`}
        />
      </section>

      {/* Section 5: Audit Event Log */}
      <section className="card" aria-labelledby="audit-history-title">
        <h2 className="card-title" id="audit-history-title">
          Immutable Audit Log
        </h2>
        <p className="quiet">
          Chronological ledger of all administrative interventions. Immutable and permanently
          attributed.
        </p>

        {auditData.state !== "ok" ? (
          <div role="alert">
            <p>
              Audit history could not be read
              {auditData.state === "unconfigured"
                ? " because the operator connection is not configured"
                : ""}
              . This does not mean that no decisions were recorded.
            </p>
            <AdminReload label="Retry audit history" />
          </div>
        ) : auditData.events.length === 0 ? (
          <p className="empty-state">No administrative actions recorded in log.</p>
        ) : (
          <div className="audit-table-wrap">
            <table className="audit-table">
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Audit event</th>
                  <th>Action</th>
                  <th>Target</th>
                  <th>Operator</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {auditData.events.map((evt) => (
                  <tr key={evt.event_id}>
                    <td className="quiet">{evt.timestamp}</td>
                    <td>
                      <code>{evt.event_id}</code>
                    </td>
                    <td>
                      <code>{evt.action}</code>
                    </td>
                    <td>
                      <code>{evt.target_id}</code>
                    </td>
                    <td>{evt.operator_id}</td>
                    <td>{evt.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * The held bytes, shown to the operator as inert preformatted text: never
 * rendered as markdown or HTML, because held content may be the very
 * injection or forgery the screen caught (Fable §14.4).
 */
function HeldCandidate({ detail }: { detail: AdminQuarantineCaseDetail | undefined }) {
  if (detail === undefined) {
    return <p className="quiet">Held content is unavailable right now; do not decide blind.</p>;
  }
  return (
    <details className="held-candidate">
      <summary>
        Held {detail.route} write · {detail.candidate.kind} · problem{" "}
        <code>{detail.problem_id}</code> · Fellow <code>{detail.fellow_id}</code>
      </summary>
      <p className="quiet">
        Inert text. A release lets the author resubmit exactly this candidate in the evaluated
        context. A changed candidate or public context is screened afresh.
      </p>
      <p>
        <Link
          href={`/admin/sponsors?sponsor=${encodeURIComponent(detail.sponsor_id)}&case=${encodeURIComponent(detail.item.id)}`}
          prefetch={false}
        >
          Inspect this sponsor and case for a separate suspension decision
        </Link>
      </p>
      <pre className="held-candidate-body">{detail.candidate.statement}</pre>
      {detail.candidate.falsifier === null ? null : (
        <>
          <p className="quiet">Falsifier:</p>
          <pre className="held-candidate-body">{detail.candidate.falsifier}</pre>
        </>
      )}
      {detail.candidate.context === undefined ? null : (
        <section aria-label="Evaluated publication context">
          <h4>Evaluated publication context</h4>
          <p className="quiet">
            {detail.candidate.context.mode === "initial-publication"
              ? "Initial publication: this problem has no earlier public statement or Fellow history."
              : `Public statement version ${detail.candidate.context.problem_statement?.version}. The following public history belongs to this same Fellow.`}
          </p>
          {detail.candidate.context.problem_statement === null ? null : (
            <pre className="held-candidate-body">
              {JSON.stringify(detail.candidate.context.problem_statement, null, 2)}
            </pre>
          )}
          {detail.candidate.context.recent_same_fellow_publications.map((source) => (
            <details key={source.event_id}>
              <summary>
                Public event {source.event_id} · cursor {source.seq}
              </summary>
              <pre className="held-candidate-body">{source.payload_json}</pre>
            </details>
          ))}
          <p className="quiet">
            The context includes at most {detail.candidate.context.limits.recent_publications}{" "}
            recent public events. {detail.candidate.context.omitted_older_publication_count} older
            public events were outside that window.
          </p>
          {detail.candidate.context.pending_batch_candidates.map((candidate) => (
            <details key={candidate.ordinal}>
              <summary>
                Unpublished earlier batch candidate {candidate.ordinal} · {candidate.kind}
              </summary>
              <p className="quiet">
                This candidate was proposed in the same atomic batch; it is not a public source.
              </p>
              <pre className="held-candidate-body">{candidate.statement}</pre>
              {candidate.falsifier === null ? null : (
                <pre className="held-candidate-body">{candidate.falsifier}</pre>
              )}
            </details>
          ))}
        </section>
      )}
    </details>
  );
}
