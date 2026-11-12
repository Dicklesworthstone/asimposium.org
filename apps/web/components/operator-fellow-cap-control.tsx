"use client";

import {
  OperatorFellowCapOverrideRequestSchema,
  type OperatorFellowCapOverrideRequest,
  type OperatorFellowCapOverrideResponse,
  type OperatorFellowCapStateResponse,
} from "@asimposium/contracts";
import { useRef, useState, useSyncExternalStore, useTransition } from "react";
import {
  operatorFellowCapState,
  overrideOperatorFellowCap,
  type OperatorFellowCapResult,
} from "@/app/console/actions";

const IntentSchema = OperatorFellowCapOverrideRequestSchema.omit({ step_up_authenticated_at: true });
type Intent = Omit<OperatorFellowCapOverrideRequest, "step_up_authenticated_at">;
interface Attempt { readonly intent: Intent; readonly key: string }
const subscribeToBrowserState = () => () => undefined;

export function capacityStateFollowsReceipt(
  state: OperatorFellowCapStateResponse,
  receipt: OperatorFellowCapOverrideResponse,
): boolean {
  return state.sponsor_id === receipt.sponsor_id && state.sponsor_seq >= receipt.sponsor_seq &&
    (state.sponsor_seq > receipt.sponsor_seq || state.active_fellow_limit === receipt.active_fellow_limit);
}

/** One reviewed intent and key survive an uncertain response without optimistic state. */
export function OperatorFellowCapControl({ operatorId, initial, canChange, returnPath }: {
  readonly operatorId: string;
  readonly initial: OperatorFellowCapStateResponse;
  readonly canChange: boolean;
  readonly returnPath: string;
}) {
  const interactive = useSyncExternalStore(subscribeToBrowserState, () => true, () => false);
  const [current, setCurrent] = useState<OperatorFellowCapStateResponse | null>(initial);
  const [limit, setLimit] = useState(String(initial.active_fellow_limit));
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [receipt, setReceipt] = useState<OperatorFellowCapOverrideResponse | null>(null);
  const [result, setResult] = useState<OperatorFellowCapResult | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const lock = useRef(false);
  const disabled = !interactive || !canChange || pending || current === null || attempt !== null;

  function send(next: Attempt) {
    if (lock.current) return;
    lock.current = true;
    setAttempt(next);
    startTransition(async () => {
      try {
        const reply = await overrideOperatorFellowCap(next.intent, next.key, operatorId);
        setResult(reply);
        if (reply.ok) {
          setReceipt(reply.receipt);
          setAttempt(null);
          setReason("");
          setConfirmed(false);
          setCurrent(null);
          // Another operator may already have made a later decision. The
          // receipt confirms our historical write; only this read supplies state.
          try {
            const fresh = await operatorFellowCapState(initial.sponsor_id, operatorId);
            if (fresh.ok && capacityStateFollowsReceipt(fresh.state, reply.receipt)) {
              setCurrent(fresh.state);
              setLimit(String(fresh.state.active_fellow_limit));
              setReadError(null);
            } else setReadError(fresh.ok
              ? "The capacity read does not follow the confirmed receipt. Reload before another decision."
              : fresh.message);
          } catch {
            setReadError("The receipt is confirmed, but current capacity could not be read. Reload before another decision.");
          }
        }
      } catch {
        setResult({ ok: false, message: "The capacity decision could not be confirmed. Retry the exact pending decision with its original retry key, or reload before starting a different decision." });
      } finally {
        lock.current = false;
      }
    });
  }

  function submit() {
    if (disabled || lock.current || current === null) return;
    const parsed = IntentSchema.safeParse({
      sponsor_id: initial.sponsor_id,
      expected_active_fellow_limit: current.active_fellow_limit,
      expected_sponsor_seq: current.sponsor_seq,
      active_fellow_limit: Number(limit), reason,
      confirm: confirmed ? "override-fellow-cap" : "",
    });
    if (!parsed.success) {
      setResult({ ok: false, message: "Choose a whole-number limit from 5 to 500, enter an audit reason of 10 to 1,000 Unicode characters without surrounding whitespace, and confirm the decision." });
      return;
    }
    if (parsed.data.active_fellow_limit === current.active_fellow_limit) {
      setResult({ ok: false, message: "Choose a different limit before recording a capacity decision." });
      return;
    }
    send({ intent: parsed.data, key: `console-fellow-cap-${crypto.randomUUID()}` });
  }

  return (
    <section className="card" aria-labelledby="operator-fellow-cap-heading">
      <h2 id="operator-fellow-cap-heading">Fellow capacity</h2>
      <p>Sponsor: <code>{initial.sponsor_id}</code></p>
      {current === null ? (
        <p role="status">Current capacity is unavailable. Reload this inspection before another decision.</p>
      ) : (
        <dl>
          <dt>Active Fellow limit at last read</dt><dd id="operator-cap-current">{current.active_fellow_limit}</dd>
          <dt>Capacity decision sequence at last read</dt><dd id="operator-cap-sequence">{current.sponsor_seq}</dd>
        </dl>
      )}
      <p>Capacity changes govern new admissions. They do not revoke existing Fellows or change scientific standing.</p>
      <noscript><p>Capacity changes require JavaScript. Current capacity and recent decisions remain available for inspection.</p></noscript>
      {!canChange ? <p>Sign in again with Google before changing capacity.</p> : null}
      <fieldset disabled={disabled}>
        <legend>Review a capacity change</legend>
        <label htmlFor="operator-cap-limit">New active Fellow limit</label>
        <input id="operator-cap-limit" type="number" min={5} max={500} step={1} value={limit} onChange={event => setLimit(event.target.value)} />
        <label htmlFor="operator-cap-reason">Audit reason (10–1,000 Unicode characters)</label>
        <textarea id="operator-cap-reason" maxLength={2000} value={reason} onChange={event => setReason(event.target.value)} />
        <label htmlFor="operator-cap-confirm">
          <input id="operator-cap-confirm" type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />
          I reviewed this sponsor and confirm this capacity decision.
        </label>
        <button id="operator-cap-save" type="button" className="btn-quiet" onClick={submit}>Record capacity decision</button>
      </fieldset>
      {result?.ok === false ? <p role="alert">{result.message}</p> : null}
      {attempt === null ? null : (
        <button type="button" className="btn-quiet" disabled={pending || !interactive || !canChange} onClick={() => send(attempt)}>Retry the exact capacity decision</button>
      )}
      {readError === null ? null : <p role="alert">{readError}</p>}
      {receipt === null ? null : (
        <section aria-labelledby="operator-cap-receipt-heading">
          <h3 id="operator-cap-receipt-heading">Confirmed capacity receipt</h3>
          <p role="status">Capacity decision recorded: {receipt.previous_active_fellow_limit} → {receipt.active_fellow_limit} at sequence {receipt.sponsor_seq}.</p>
          <p>Audit event: <code id="operator-cap-receipt">{receipt.audit_event_id}</code></p>
          <p>Recorded at (UTC): <time dateTime={new Date(receipt.effective_at * 1000).toISOString()}>{new Date(receipt.effective_at * 1000).toISOString()}</time>. Later decisions may change current capacity.</p>
        </section>
      )}
      <p><a href={returnPath}>Reload capacity and recent decisions</a></p>
    </section>
  );
}
