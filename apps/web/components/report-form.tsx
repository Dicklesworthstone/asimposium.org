"use client";

import { REPORT_REASONS } from "@asimposium/contracts";
import { useActionState, useState } from "react";
import { reportContentAction } from "@/app/report/actions";
import {
  type ReportActionState,
  type ReportTarget,
  reportPageHref,
  reportStatusLabel,
} from "@/lib/report-submission";

const INITIAL_STATE: ReportActionState = { status: "idle" };
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

/** Keep the draft in this form only; uncertain delivery freezes the retry body. */
export function ReportForm({
  sponsorId,
  target,
}: {
  readonly sponsorId: string;
  readonly target: ReportTarget;
}) {
  const [state, action, pending] = useActionState(
    reportContentAction.bind(null, sponsorId, target),
    INITIAL_STATE,
    reportPageHref(target),
  );
  const [reason, setReason] = useState(state.status === "refused" ? state.draft.reason : "");
  const [note, setNote] = useState(state.status === "refused" ? state.draft.note : "");
  const uncertain = state.status === "refused" && state.uncertain;
  const retainedReason = uncertain ? state.draft.reason : reason;
  const retainedNote = uncertain ? state.draft.note : note;

  if (state.status === "committed")
    return (
      <div className="report-status" role="status">
        <p>
          <strong>
            Report confirmed: <code>{state.receipt.report_id}</code>.
          </strong>
        </p>
        <p>{reportStatusLabel(state.receipt.status)} at the time of this receipt.</p>
        <p>
          Target:{" "}
          <code>
            {state.receipt.problem_id} / {state.receipt.target}
          </code>
          .
        </p>
        {state.receipt.deduplicated && (
          <p>
            Your sponsor family already reported this object. The receipt shows the original
            report’s target. Its reason, note and source remain as filed.
          </p>
        )}
        {state.receipt.target_hidden && (
          <p>
            The target was hidden pending review when this receipt was returned. Hiding is not a
            scientific or conduct verdict.
          </p>
        )}
        <p>
          <a href="/console/reports">Follow the recorded status of your reports</a>
        </p>
      </div>
    );

  return (
    <form action={action} className="report-form">
      <label htmlFor="report-reason">Reason</label>
      <select
        id="report-reason"
        name={uncertain ? undefined : "reason"}
        required
        value={retainedReason}
        onChange={(event) => setReason(event.target.value)}
        disabled={pending || uncertain}
      >
        <option value="" disabled>
          Choose a reason
        </option>
        {REPORT_REASONS.map((value) => (
          <option key={value} value={value}>
            {REASON_LABELS[value]}
          </option>
        ))}
      </select>
      <label htmlFor="report-note">Note for the operator (optional)</label>
      <textarea
        id="report-note"
        name={uncertain ? undefined : "note"}
        maxLength={500}
        rows={3}
        value={retainedNote}
        onChange={(event) => setNote(event.target.value)}
        readOnly={pending || uncertain}
        placeholder="Say where it is, not what it says. Never paste a payload or a secret."
      />
      {uncertain && (
        <>
          <input type="hidden" name="reason" value={retainedReason} />
          <input type="hidden" name="note" value={retainedNote} />
        </>
      )}
      {state.status === "refused" && (
        <div role="alert">
          <p>{state.message}</p>
          {state.signInRequired && (
            <p>
              <a href="/console" target="_blank" rel="noopener noreferrer">
                Sign in from the console in another tab
              </a>
              , then return to retry this report.
            </p>
          )}
        </div>
      )}
      {pending && <p role="status">Waiting for the report receipt…</p>}
      <button type="submit" disabled={pending}>
        {pending ? "Submitting report…" : uncertain ? "Retry this unchanged report" : "File report"}
      </button>
      <p className="quiet">
        Your note stays in this form while you retry. It is never added to the page URL or browser
        storage.
      </p>
    </form>
  );
}
