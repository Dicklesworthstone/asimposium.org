"use client";

import type { ProblemSlowModeState } from "@asimposium/contracts";
import { useRef, useState, useTransition } from "react";
import {
  changeProblemSlowMode,
  type SlowModeActionResult,
  type SlowModeInput,
} from "@/app/console/slow-mode/actions";
import type { SlowModeAudience } from "@/lib/problem-slow-mode";

interface Attempt {
  readonly input: SlowModeInput;
  readonly key: string;
}

/** Small audited control. Revision checks prevent a reload or uncertain retry
 * from applying a second command against an already changed mode. */
export function ProblemSlowModeControl({
  audience,
  initial,
  canChange,
  returnPath,
}: {
  readonly audience: SlowModeAudience;
  readonly initial: ProblemSlowModeState;
  readonly canChange: boolean;
  readonly returnPath: string;
}) {
  const [current, setCurrent] = useState<ProblemSlowModeState | null>(initial);
  const [limit, setLimit] = useState(String(initial.slow_mode?.limit_per_hour ?? 5));
  const [expiry, setExpiry] = useState("");
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<SlowModeActionResult | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [pending, startTransition] = useTransition();
  const lock = useRef(false);
  const retryRequired = result?.ok === false && result.retryable;
  const refreshRequired = result?.ok === false && result.refreshRequired === true;

  function send(next: Attempt) {
    if (lock.current) return;
    lock.current = true;
    setAttempt(next);
    startTransition(async () => {
      try {
        const reply = await changeProblemSlowMode(audience, initial.problem_id, next.input, next.key);
        setResult(reply);
        if (reply.ok) {
          setCurrent(reply.current);
          setAttempt(null);
          setReason("");
        } else if (!reply.retryable) {
          setAttempt(null);
        }
      } catch {
        setResult({ ok: false, retryable: true,
          message: "The change could not be confirmed. Retry these exact settings, or reload the current mode before starting another change." });
      } finally {
        lock.current = false;
      }
    });
  }

  function submit(action: "set" | "clear") {
    if (current === null || !canChange || lock.current || retryRequired || refreshRequired) return;
    if (action === "set" && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(expiry)) {
      setResult({ ok: false, retryable: false, message: "Choose an expiry in UTC." });
      return;
    }
    const expires = new Date(`${expiry}:00.000Z`);
    if (action === "set" && !Number.isFinite(expires.getTime())) {
      setResult({ ok: false, retryable: false, message: "Choose a valid expiry in UTC." });
      return;
    }
    const base = { expected_revision: current.revision, reason };
    const input: SlowModeInput = action === "clear"
      ? { ...base, action }
      : { ...base, action, limit_per_hour: Number(limit), expires_at: expires.toISOString() };
    send({ input, key: `slow-mode-${crypto.randomUUID()}` });
  }

  return (
    <section className="card" aria-labelledby="slow-mode-current-heading">
      <h2 id="slow-mode-current-heading">Current publication limit at last read</h2>
      {current === null ? (
        <p role="status">The command receipt was confirmed, but the current mode could not be read. Reload before making another change.</p>
      ) : (
        <>
          <p><strong>{current.effective_limit_per_hour} new publication admissions per rolling hour</strong> per Fellow on <code>{current.problem_id}</code>.</p>
          <p className="quiet">Mode revision {current.revision}.</p>
          {current.slow_mode === null ? (
            <p>No temporary slow mode is active at this read. The ordinary limit is 20 per hour.</p>
          ) : (
            <dl>
              <dt>Expires at (UTC)</dt>
              <dd><time dateTime={current.slow_mode.expires_at}>{current.slow_mode.expires_at}</time></dd>
              <dt>Applied at (UTC)</dt>
              <dd><time dateTime={current.slow_mode.applied_at}>{current.slow_mode.applied_at}</time></dd>
              <dt>Recorded reason</dt>
              <dd>{current.slow_mode.reason}</dd>
              <dt>Audit event</dt>
              <dd><code>{current.slow_mode.event_id}</code></dd>
            </dl>
          )}
        </>
      )}
      <p>Each attempted public publication consumes one admission, including attempts that are held, rejected, or fail. Each batch member consumes one. Existing reservations can finish. Private workshop work and reads remain available; this control does not decide scientific standing.</p>
      <p><a href={returnPath}>Reload the current mode</a></p>
      {result === null ? null : result.ok ? (
        <p role="status">
          Recorded {result.receipt.action === "set" ? "temporary limit" : "clear command"} at revision {result.receipt.revision}
          {" "}(<code>{result.receipt.event_id}</code>). The current mode above is read separately; a replayed receipt does not reactivate an expired limit.
        </p>
      ) : <p role="alert">{result.message}</p>}
      {!canChange ? <p>Re-authenticate below to change this limit.</p> : null}
      <form onSubmit={(event) => { event.preventDefault(); submit("set"); }}>
        <fieldset disabled={pending || retryRequired || refreshRequired || !canChange || current === null}>
          <legend>Set or clear a temporary limit</legend>
          <label>
            New admissions per hour (1–19)
            <input type="number" min={1} max={19} step={1} required value={limit} onChange={(event) => setLimit(event.target.value)} />
          </label>
          <label>
            Expiry in UTC (within the next 24 hours)
            <input type="datetime-local" step={60} required value={expiry} onChange={(event) => setExpiry(event.target.value)} />
          </label>
          <label>
            Audit reason (10–1000 characters)
            <textarea rows={3} required minLength={10} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} />
          </label>
          <div className="btn-row">
            <button type="submit" className="btn-action">Set temporary limit</button>
            <button type="button" className="btn-quiet" disabled={current?.slow_mode === null} onClick={() => submit("clear")}>
              Clear temporary limit
            </button>
          </div>
        </fieldset>
      </form>
      {retryRequired && attempt !== null ? (
        <button type="button" className="btn-quiet" disabled={pending} onClick={() => send(attempt)}>
          Retry the exact pending change
        </button>
      ) : null}
      {pending ? <p role="status">Waiting for the command receipt…</p> : null}
      <noscript><p>The current mode is available above. Enable JavaScript to submit a change and retain its exact retry settings.</p></noscript>
    </section>
  );
}
