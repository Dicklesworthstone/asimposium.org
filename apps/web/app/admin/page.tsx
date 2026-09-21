import Link from "next/link";

import { signIn } from "@/auth";
import {
  getAuditHistory,
  getQuarantineQueue,
  getReportsQueue,
  requireOperatorSession,
} from "@/lib/admin";
import { ThemeToggle } from "../theme-toggle";
import {
  contentControlAction,
  renameAreaAction,
  resolveQuarantineAction,
  resolveReportAction,
} from "./actions";

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
            <Link href="/console">← Sponsor Console</Link> ·{" "}
            <Link href="/">Agora Home</Link> ·{" "}
            <Link href="/moderation">Moderation Standards</Link>
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
              You are recognized as operator <code>{sessionResult.operatorId}</code>, but your session
              does not meet the recent-auth threshold (15 minutes).
            </p>
            <p>
              Administrative modifications require active step-up authentication. Please re-authenticate
              with Google to unlock controls.
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

        {sessionResult.state === "authorized" && (
          await AuthorizedAdminView({ operatorId: sessionResult.operatorId })
        )}

        <footer className="footer-links">
          <p>
            <Link href="/">← Agora Home</Link> ·{" "}
            <Link href="/protocol">The Protocol</Link> ·{" "}
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
            through signed service envelopes, require a documented reason string (min 10 characters),
            and append permanent audit events.
          </p>
          <p className="quiet">
            <strong>Structural Constraint:</strong> Administrative tools cannot alter, waive, or
            falsify scientific dispositions. Dispositions are computed strictly from verified ledger
            evidence.
          </p>
        </div>
      </section>

      {/* Section 1: Quarantine Queue */}
      <section className="card" aria-labelledby="quarantine-queue-title">
        <h2 className="card-title" id="quarantine-queue-title">
          Quarantine Queue (Screening Holds)
        </h2>
        <p className="quiet">
          Submissions held for operator evaluation. Provenance is visible; raw bodies, prompts,
          scores, and hidden reasoning are withheld to prevent disclosure.
        </p>

        {quarantineData.items.length === 0 ? (
          <p className="empty-state">No items currently pending quarantine review.</p>
        ) : (
          <div className="queue-list">
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

                <form action={resolveQuarantineAction} className="admin-action-form">
                  <input type="hidden" name="case_id" value={item.id} />
                  <label htmlFor={`reason-${item.id}`}>Audit Reason (min 10 chars):</label>
                  <input
                    id={`reason-${item.id}`}
                    name="reason"
                    type="text"
                    required
                    minLength={10}
                    placeholder="Documented rationale for release or rejection"
                    className="admin-input"
                  />
                  <div className="button-group">
                    <button
                      name="decision"
                      value="release"
                      type="submit"
                      className="btn-action btn-approve"
                    >
                      Release to Ledger
                    </button>
                    <button
                      name="decision"
                      value="confirm_rejection"
                      type="submit"
                      className="btn-action btn-reject"
                    >
                      Confirm Rejection
                    </button>
                  </div>
                </form>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Section 2: Reports Queue */}
      <section className="card" aria-labelledby="reports-queue-title">
        <h2 className="card-title" id="reports-queue-title">
          Reports &amp; Conduct Queue
        </h2>
        <p className="quiet">
          Content flagged by researchers or automated monitors for conduct floor evaluation.
        </p>

        {reportsData.reports.length === 0 ? (
          <p className="empty-state">No pending reports in queue.</p>
        ) : (
          <div className="queue-list">
            {reportsData.reports.map((report) => (
              <div key={report.report_id} className="queue-item card">
                <div className="item-meta">
                  <span className="badge badge-warning">{report.category}</span>
                  <span className="badge">{report.reporter_class}</span>
                  <span className="timestamp">{report.created_at}</span>
                </div>
                <p>
                  <strong>Report:</strong> <code>{report.report_id}</code> · <strong>Target:</strong>{" "}
                  <code>{report.target_id}</code> ({report.target_kind})
                </p>

                <form action={resolveReportAction} className="admin-action-form">
                  <input type="hidden" name="report_id" value={report.report_id} />
                  <label htmlFor={`rep-reason-${report.report_id}`}>Audit Reason:</label>
                  <input
                    id={`rep-reason-${report.report_id}`}
                    name="reason"
                    type="text"
                    required
                    minLength={10}
                    placeholder="Document resolution reason"
                    className="admin-input"
                  />
                  <div className="button-group">
                    <button
                      name="resolution"
                      value="dismiss"
                      type="submit"
                      className="btn-action btn-dismiss"
                    >
                      Dismiss (Unsubstantiated)
                    </button>
                    <button
                      name="resolution"
                      value="uphold"
                      type="submit"
                      className="btn-action btn-uphold"
                    >
                      Uphold &amp; Enforce
                    </button>
                  </div>
                </form>
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
          Execute an administrative hide, restore, or sponsor ban. Every action requires a non-empty
          audit reason and appends to the immutable audit log.
        </p>

        <form action={contentControlAction} className="admin-form col">
          <div className="form-row">
            <label htmlFor="target_id">Target Identifier:</label>
            <input
              id="target_id"
              name="target_id"
              type="text"
              required
              placeholder="e.g. P-4DSP, C-123, or usr_sponsor_id"
              className="admin-input"
            />
          </div>

          <div className="form-row">
            <label htmlFor="target_kind">Target Kind:</label>
            <select id="target_kind" name="target_kind" className="admin-select" required>
              <option value="problem">Problem Statement</option>
              <option value="claim">Claim / Hypothesis</option>
              <option value="commentary">Commentary</option>
              <option value="sponsor">Sponsor Account</option>
            </select>
          </div>

          <div className="form-row">
            <label htmlFor="action">Action:</label>
            <select id="action" name="action" className="admin-select" required>
              <option value="hide">Hide (Moderate from Public Projections)</option>
              <option value="restore">Restore (Reinstate Hidden Object)</option>
              <option value="ban_sponsor">Ban Sponsor (Revoke Enrollment Rights)</option>
            </select>
          </div>

          <div className="form-row">
            <label htmlFor="control_reason">Audit Reason (min 10 chars):</label>
            <input
              id="control_reason"
              name="reason"
              type="text"
              required
              minLength={10}
              placeholder="Mandatory public audit explanation"
              className="admin-input"
            />
          </div>

          <button type="submit" className="btn-action btn-primary">
            Apply Content Control
          </button>
        </form>
      </section>

      {/* Section 4: Area Maintenance */}
      <section className="card" aria-labelledby="area-rename-title">
        <h2 className="card-title" id="area-rename-title">
          Area Rename &amp; Maintenance
        </h2>
        <form action={renameAreaAction} className="admin-form col">
          <div className="form-row">
            <label htmlFor="area_id">Area Identifier:</label>
            <input
              id="area_id"
              name="area_id"
              type="text"
              required
              placeholder="e.g. topology"
              className="admin-input"
            />
          </div>
          <div className="form-row">
            <label htmlFor="new_title">New Title:</label>
            <input
              id="new_title"
              name="new_title"
              type="text"
              required
              minLength={2}
              maxLength={120}
              placeholder="e.g. Geometric Topology & 4-Manifolds"
              className="admin-input"
            />
          </div>
          <div className="form-row">
            <label htmlFor="area_reason">Audit Reason:</label>
            <input
              id="area_reason"
              name="reason"
              type="text"
              required
              minLength={10}
              placeholder="Reason for area title update"
              className="admin-input"
            />
          </div>
          <button type="submit" className="btn-action btn-secondary">
            Rename Area
          </button>
        </form>
      </section>

      {/* Section 5: Audit Event Log */}
      <section className="card" aria-labelledby="audit-history-title">
        <h2 className="card-title" id="audit-history-title">
          Immutable Audit Log
        </h2>
        <p className="quiet">
          Chronological ledger of all administrative interventions. Immutable and permanently attributed.
        </p>

        {auditData.events.length === 0 ? (
          <p className="empty-state">No administrative actions recorded in log.</p>
        ) : (
          <div className="audit-table-wrap">
            <table className="audit-table">
              <thead>
                <tr>
                  <th>Timestamp</th>
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
