"use client";

import type { AdminSponsorSuspensionState } from "@asimposium/contracts";
import { useRef, useState, useTransition } from "react";
import {
  suspendSponsor,
  type SponsorSuspensionActionResult,
  type SponsorSuspensionInput,
} from "@/app/admin/sponsors/actions";

interface SuspensionAttempt {
  readonly input: SponsorSuspensionInput;
  readonly key: string;
}

/** A pending decision keeps its exact input and key until its outcome is known. */
export function SponsorSuspensionControl({
  operatorId,
  initial,
  reviewedCaseId,
  canChange,
  returnPath,
}: {
  readonly operatorId: string;
  readonly initial: AdminSponsorSuspensionState;
  readonly reviewedCaseId: string | null;
  readonly canChange: boolean;
  readonly returnPath: string;
}) {
  const [current, setCurrent] = useState<AdminSponsorSuspensionState | null>(initial);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [result, setResult] = useState<SponsorSuspensionActionResult | null>(null);
  const [attempt, setAttempt] = useState<SuspensionAttempt | null>(null);
  const [pending, startTransition] = useTransition();
  const lock = useRef(false);
  const retryRequired = result?.ok === false && result.retryable;
  const refreshRequired = result?.ok === false && result.refreshRequired === true;
  const disabled = pending || retryRequired || refreshRequired || !canChange ||
    current === null || current.status !== "active" || current.revision !== 0 || reviewedCaseId === null;

  function send(next: SuspensionAttempt) {
    if (lock.current) return;
    lock.current = true;
    setAttempt(next);
    startTransition(async () => {
      try {
        const reply = await suspendSponsor(operatorId, initial.sponsor_id, next.input, next.key);
        setResult(reply);
        if (reply.ok) {
          setCurrent(reply.current);
          setAttempt(null);
          setReason("");
          setConfirmed(false);
        } else if (!reply.retryable) {
          setAttempt(null);
        }
      } catch {
        setResult({
          ok: false, retryable: true,
          message: "The suspension could not be confirmed. Retry this exact decision with its original retry key, or reload the sponsor before starting another decision.",
        });
      } finally {
        lock.current = false;
      }
    });
  }

  function submit() {
    if (disabled || lock.current || reviewedCaseId === null || current?.revision !== 0) return;
    if (!confirmed || reason.trim().length < 10 || reason.length > 1000) {
      setResult({
        ok: false, retryable: false,
        message: "Confirm the reviewed egregious case and enter an audit reason of 10 to 1000 characters.",
      });
      return;
    }
    send({
      input: {
        expected_revision: current.revision,
        reviewed_case_id: reviewedCaseId,
        basis: "egregious-reviewed-case",
        reason,
        confirm_reviewed_egregious_case: true,
      },
      key: `sponsor-suspension-${crypto.randomUUID()}`,
    });
  }

  return (
    <section className="card" aria-labelledby="sponsor-standing-heading">
      <h2 id="sponsor-standing-heading">Sponsor standing at last read</h2>
      <p>Sponsor: <code>{initial.sponsor_id}</code></p>
      {current === null ? (
        <p role="status">The suspension receipt is confirmed, but current standing could not be read. Reload this inspection for current state.</p>
      ) : (
        <>
          <p><strong>{current.status === "suspended" ? "Suspended" : "Active"}</strong> · revision {current.revision}</p>
          {current.suspension === null ? null : (
            <dl>
              <dt>Suspended at (UTC)</dt><dd><time dateTime={current.suspension.applied_at}>{current.suspension.applied_at}</time></dd>
              <dt>Reviewed case</dt><dd><code>{current.suspension.reviewed_case_id}</code></dd>
              <dt>Recorded reason</dt><dd>{current.suspension.reason}</dd>
              <dt>Suspension event</dt><dd><code>{current.suspension.event_id}</code></dd>
              <dt>Audit event</dt><dd><code>{current.suspension.audit_event_id}</code></dd>
            </dl>
          )}
          <h3>Current account scope</h3>
          <dl>
            <dt>Active Fellows</dt><dd>{current.impact.active_fellows}</dd>
            <dt>Unrevoked Fellow credentials</dt><dd>{current.impact.unrevoked_credentials}</dd>
            <dt>Pending enrollments</dt><dd>{current.impact.pending_enrollments}</dd>
            <dt>Pending transfers involving this sponsor</dt><dd>{current.impact.pending_transfers}</dd>
          </dl>
          <p className="quiet">These counts describe the last read. The committed receipt records the actual affected counts if the account changes before suspension.</p>
        </>
      )}
      <p><a href={returnPath}>Reload sponsor and reviewed case</a></p>
      {result === null ? null : result.ok ? (
        <section aria-labelledby="suspension-receipt-heading">
          <h3 id="suspension-receipt-heading">Confirmed suspension receipt</h3>
          <p role="status">Stoa committed the suspension at <time dateTime={result.receipt.applied_at}>{result.receipt.applied_at}</time>.</p>
          <dl>
            <dt>Paused Fellows</dt><dd>{result.receipt.affected.paused_fellows}</dd>
            <dt>Revoked credentials</dt><dd>{result.receipt.affected.revoked_credentials}</dd>
            <dt>Cancelled enrollments</dt><dd>{result.receipt.affected.cancelled_enrollments}</dd>
            <dt>Cancelled transfers</dt><dd>{result.receipt.affected.cancelled_transfers}</dd>
            <dt>Reviewed case</dt><dd><code>{result.receipt.reviewed_case_id}</code></dd>
            <dt>Audit event</dt><dd><code>{result.receipt.audit_event_id}</code></dd>
          </dl>
        </section>
      ) : <p role="alert">{result.message}</p>}
      {current?.status === "active" ? (
        <>
          <h3>Review the consequences</h3>
          <p>Suspension disables this sponsor’s write authority, pauses active Fellows, revokes their existing credentials, and cancels pending enrollment and transfer requests. Public scientific history is retained. The sponsor can read their coarse account status and seek an appeal.</p>
          <p>Suspension has no automatic expiry. A rejected case alone is insufficient: record your separate judgment that the reviewed case is egregious enough for this account-wide action.</p>
          {reviewedCaseId === null ? <p>Select a rejected screening case belonging to this sponsor before making a decision.</p> : null}
          {!canChange ? <p>Re-authenticate with Google below to submit a decision.</p> : null}
          <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
            <fieldset disabled={disabled}>
              <legend>Suspend this sponsor after review</legend>
              <label>
                Audit reason (10–1000 characters)
                <textarea rows={4} required minLength={10} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} />
              </label>
              <p className="quiet">Describe the reviewed decision. Keep credentials, private payloads and personal contact details out of the reason.</p>
              <label>
                <input type="checkbox" required checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
                I reviewed case <code>{reviewedCaseId ?? "(none selected)"}</code> and consider it egregious enough to suspend sponsor <code>{initial.sponsor_id}</code> with the consequences above.
              </label>
              <button type="submit" className="btn-action btn-reject">Suspend sponsor and revoke credentials</button>
            </fieldset>
          </form>
        </>
      ) : null}
      {retryRequired && attempt !== null ? (
        <button type="button" className="btn-quiet" disabled={pending} onClick={() => send(attempt)}>
          Retry the exact pending decision
        </button>
      ) : null}
      {pending ? <p role="status">Waiting for the suspension receipt…</p> : null}
      <noscript><p>Current standing is available above. Enable JavaScript to submit a decision and retain its exact retry settings.</p></noscript>
    </section>
  );
}
