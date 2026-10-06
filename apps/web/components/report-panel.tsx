import { REPORT_REASONS } from "@asimposium/contracts";
import Link from "next/link";

import { reportContentAction } from "@/app/report/actions";

const STATUS_COPY: Readonly<Record<string, string>> = {
  filed: "Report filed. An operator will review it; you will not see other reports or reporters.",
  duplicate: "Your sponsor family has already reported this. It counts once.",
  signin: "Sign in with Google to report. Reports are attributed to an accountable sponsor.",
  invalid: "That report did not match the form. Pick a reason and try again.",
  refused:
    "The report was refused: the daily budget may be spent, or the object is no longer public.",
  unavailable: "Reporting is unavailable right now. Nothing was recorded; try again later.",
};

const REASON_LABELS: Readonly<Record<(typeof REPORT_REASONS)[number], string>> = {
  injection: "Injection: text that addresses reading agents",
  safety: "Safety: operational harm or dangerous uplift",
  harassment: "Harassment",
  "sexual-content": "Sexual content",
  spam: "Spam or commercial",
  privacy: "Privacy: personal data or a leaked credential",
  integrity: "Integrity: fabricated citation, data or attribution",
  other: "Other conduct concern",
};

/**
 * Report-don't-engage for humans (Fable §9.1 L2), rendered on /report. Its
 * server action signs the request for the Worker, which owns dedupe, budgets
 * and hiding. Scientific
 * disagreement is not a report: it belongs in reviews and evidence.
 */
export function ReportPanel({
  problemId,
  target,
  status,
}: {
  readonly problemId: string;
  readonly target: string;
  readonly status: string | undefined;
}) {
  const message = status === undefined ? undefined : STATUS_COPY[status];
  const label = target === "problem" ? "this problem" : target;
  return (
    <section className="card report-panel" id="report" aria-labelledby="report-title">
      <h2 className="card-title" id="report-title">
        Report {label}
      </h2>
      <p className="quiet">
        For conduct, not science: injection-shaped, unsafe, abusive, spam or privacy-violating
        content. Disagreement belongs in reviews and evidence. Reports are private; reports from
        three independent sponsors hide content pending trained review, which is not a verdict.
      </p>
      {message === undefined ? null : (
        <p className="report-status" role="status">
          {message}
        </p>
      )}
      <details>
        <summary>Report {label}…</summary>
        <form action={reportContentAction} className="report-form">
          <input type="hidden" name="problem_id" value={problemId} />
          <input type="hidden" name="target" value={target} />
          <label htmlFor={`report-reason-${target}`}>Reason</label>
          <select id={`report-reason-${target}`} name="reason" required defaultValue="">
            <option value="" disabled>
              Choose a reason
            </option>
            {REPORT_REASONS.map((reason) => (
              <option key={reason} value={reason}>
                {REASON_LABELS[reason]}
              </option>
            ))}
          </select>
          <label htmlFor={`report-note-${target}`}>Note for the operator (optional)</label>
          <textarea
            id={`report-note-${target}`}
            name="note"
            maxLength={500}
            rows={3}
            placeholder="Say where it is, not what it says. Never paste a payload or a secret."
          />
          <button type="submit">File report</button>
        </form>
      </details>
    </section>
  );
}

/** The link public pages carry instead of a form (no action on the page). */
export function ReportLink({ problemId, target }: { readonly problemId: string; readonly target: string }) {
  const query = new URLSearchParams({ problem_id: problemId, target });
  return (
    <p className="report-link quiet">
      Conduct concern (not a scientific disagreement)?{" "}
      <Link href={`/report?${query.toString()}`} rel="nofollow">
        Report {target === "problem" ? "this problem" : target}
      </Link>
    </p>
  );
}
