"use client";

import { useActionState } from "react";
import {
  type AdminModerationKind,
  type AdminModerationState,
  moderationReceiptSummary,
} from "@/lib/admin-moderation";
import { contentControlAction, resolveQuarantineAction, resolveReportAction } from "./actions";

const INITIAL: AdminModerationState = { status: "idle" };

export function AdminReload({ label = "Reload queues and audit history" }: { readonly label?: string }) {
  // A native GET clears the completed action state and loads fresh queues in
  // either browser mode, including a full-page server-action POST.
  return <form action="/admin" method="get"><button className="btn-action" type="submit">{label}</button></form>;
}

export function AdminModerationResult({ state }: { readonly state: AdminModerationState }) {
  if (state.status === "idle") return null;
  const summary = state.status === "committed" ? moderationReceiptSummary(state.receipt) : null;
  return (
    <div role={state.status === "committed" ? "status" : "alert"} className="admin-action-result">
      <p><strong>{state.message}</strong></p>
      {summary !== null ? (
        <dl>
          <dt>Confirmed target</dt><dd><code>{summary.target}</code></dd>
          <dt>Recorded decision</dt><dd><code>{summary.decision}</code></dd>
          <dt>Audit event</dt><dd><code>{summary.auditEventId}</code></dd>
          <dt>Recorded at</dt><dd><time dateTime={summary.at}>{summary.at}</time></dd>
        </dl>
      ) : null}
      {state.status === "refused" && state.code ? <p><code>{state.code}</code></p> : null}
      {state.status !== "invalid" ? <AdminReload /> : null}
    </div>
  );
}

/**
 * One stable form per section survives removal of a decided queue item. The
 * permalink carries action state through a full-page POST without JavaScript.
 * A lost response keeps the exact draft in this private form, never localStorage.
 */
export function AdminModerationControl({
  operatorId, kind, initialKey, targets = [], available = true,
}: {
  readonly operatorId: string;
  readonly kind: AdminModerationKind;
  readonly initialKey: string;
  readonly targets?: readonly { readonly id: string; readonly label: string }[];
  readonly available?: boolean;
}) {
  const action = kind === "quarantine" ? resolveQuarantineAction
    : kind === "report" ? resolveReportAction : contentControlAction;
  // Keeping the action identity stable also preserves a refusal across a
  // no-JS POST when the signed-in account changed. The hidden expected id is
  // only a stale-page fence; every action derives authority from fresh auth.
  const [state, formAction, pending] = useActionState(action, INITIAL, "/admin");
  const attempt = "attempt" in state && state.attempt?.kind === kind ? state.attempt : undefined;
  const draft: Readonly<Record<string, string>> = attempt === undefined
    ? state.status === "invalid" ? state.draft : {}
    : { ...attempt.request, idempotency_key: attempt.key };
  const key = draft.idempotency_key ?? initialKey;
  const targetField = kind === "quarantine" ? "case_id" : "report_id";
  const target = draft[targetField] ?? targets[0]?.id ?? "";
  const retainedTarget = target !== "" && !targets.some((item) => item.id === target);
  const locked = state.status === "unconfirmed" || state.status === "refused" || state.status === "committed";
  const canStart = available && (kind === "content" || targets.length > 0);
  const prefix = `admin-${kind}`;

  return (
    <div className="admin-moderation-control">
      <AdminModerationResult state={state} />
      <form action={formAction} className="admin-action-form col">
        <input type="hidden" name="expected_operator_id" value={operatorId} />
        <input type="hidden" name="idempotency_key" value={key} />
        <fieldset key={`${state.status}:${key}`} disabled={pending || locked || !canStart}>
          <legend>{kind === "quarantine" ? "Decide a reviewed screening hold"
            : kind === "report" ? "Resolve a reviewed report" : "Apply a content control"}</legend>
          {kind === "content" ? (
            <>
              <label htmlFor={`${prefix}-target`}>Whole target identifier</label>
              <input id={`${prefix}-target`} name="target_id" type="text" required maxLength={128}
                defaultValue={draft.target_id ?? ""} placeholder="P-4DSP or P-4DSP/C-12" className="admin-input" />
              <label htmlFor={`${prefix}-kind`}>Target kind</label>
              <select id={`${prefix}-kind`} name="target_kind" required defaultValue={draft.target_kind ?? "problem"} className="admin-select">
                <option value="problem">Problem</option>
                <option value="claim">Claim (all versions)</option>
                <option value="question">Question</option>
                <option value="conflict">Conflict</option>
              </select>
              <p className="quiet">Use a whole object identifier without an @version suffix. These controls change public visibility, never scientific standing. Other kinds do not have this control yet.</p>
              <label htmlFor={`${prefix}-action`}>Decision</label>
              <select id={`${prefix}-action`} name="action" required defaultValue={draft.action ?? "hide"} className="admin-select">
                <option value="hide">Hide from public projections</option>
                <option value="restore">Restore the operator visibility control</option>
              </select>
            </>
          ) : (
            <>
              <label htmlFor={`${prefix}-target`}>{kind === "quarantine" ? "Reviewed case" : "Reviewed report"}</label>
              <select id={`${prefix}-target`} name={targetField} required defaultValue={target} className="admin-select">
                {target === "" ? <option value="">No readable pending targets</option> : null}
                {retainedTarget ? <option value={target}>{target} (retained decision)</option> : null}
                {targets.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
              <label htmlFor={`${prefix}-decision`}>Decision</label>
              {kind === "quarantine" ? (
                <select id={`${prefix}-decision`} name="decision" required defaultValue={draft.decision ?? ""} className="admin-select">
                  <option value="" disabled>Choose after reviewing the held candidate</option>
                  <option value="release">Release for explicit resubmission by the author</option>
                  <option value="confirm_rejection">Confirm rejection</option>
                </select>
              ) : (
                <select id={`${prefix}-decision`} name="resolution" required defaultValue={draft.resolution ?? ""} className="admin-select">
                  <option value="" disabled>Choose after reviewing the report</option>
                  <option value="dismiss">Dismiss as unsubstantiated</option>
                  <option value="uphold">Uphold the report</option>
                </select>
              )}
            </>
          )}
          <label htmlFor={`${prefix}-reason`}>Audit reason (10 to 1,000 characters)</label>
          <textarea id={`${prefix}-reason`} name="reason" required minLength={10} maxLength={1000}
            rows={3} defaultValue={draft.reason ?? ""} className="admin-input" />
          <p className="quiet">Give a reason for the decision. Do not copy held candidate text, private information or detection details into the audit reason.</p>
          <label htmlFor={`${prefix}-confirm`}>
            <input id={`${prefix}-confirm`} name="confirmed_review" type="checkbox" value="yes" required />
            {" "}I reviewed this exact target and decision. The action creates a permanent audit record.
          </label>
          <button className="btn-action btn-primary" type="submit">Record decision</button>
        </fieldset>
        {state.status === "unconfirmed" && attempt !== undefined ? (
          <>
            {Object.entries(attempt.request).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
            <input type="hidden" name="confirmed_review" value="yes" />
            <button type="submit" className="btn-action" disabled={pending}>Retry the exact pending decision</button>
          </>
        ) : null}
        {pending ? <p role="status">Waiting for the Worker’s durable decision…</p> : null}
      </form>
      {!canStart && state.status === "idle" ? <p className="quiet">No readable pending target is available for a new decision. Reload the queue before proceeding.</p> : null}
    </div>
  );
}
