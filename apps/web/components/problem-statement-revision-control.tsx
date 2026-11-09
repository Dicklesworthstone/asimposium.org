"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { acceptStatementRevision } from "@/app/console/problems/[problem]/revisions/actions";
import type { StatementRevisionActionResult } from "@/lib/problem-statement-proposals";
import {
  clearPendingStatementRevision,
  createPendingStatementRevision,
  type PendingStatementRevision,
  parsePendingStatementRevision,
  persistPendingStatementRevision,
  STATEMENT_REVISION_RETRY_MS,
  type StatementRevisionCommand,
  statementRevisionAttemptExpired,
  statementRevisionRecoveryKey,
  statementRevisionsPath,
} from "@/lib/problem-statement-revision";

/** The client receives review metadata only. Scientific text is rendered by the server. */
export function ProblemStatementRevisionControl({
  sponsorId,
  problemId,
  reviewed,
  isPrivate,
}: {
  readonly sponsorId: string;
  readonly problemId: string;
  readonly reviewed: StatementRevisionCommand | null;
  readonly isPrivate: boolean;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [attempt, setAttempt] = useState<PendingStatementRevision | null>(null);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<StatementRevisionActionResult | null>(null);
  const [checkedAt, setCheckedAt] = useState(0);
  const [pending, startTransition] = useTransition();
  const lock = useRef(false);
  const expired = attempt !== null && statementRevisionAttemptExpired(attempt, checkedAt);
  const disabled =
    !ready ||
    pending ||
    attempt !== null ||
    result?.ok === true ||
    (result?.ok === false && result.refreshRequired === true);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      try {
        const stored = sessionStorage.getItem(statementRevisionRecoveryKey(sponsorId, problemId));
        setAttempt(
          stored === null ? null : parsePendingStatementRevision(stored, sponsorId, problemId),
        );
        setCheckedAt(Date.now());
        setReady(true);
        setMessage(
          stored === null
            ? null
            : "An earlier acceptance has no confirmed receipt in this browser. Its exact proposal, digest and key are retained; recover it before accepting another candidate.",
        );
      } catch {
        setReady(false);
        setMessage(
          "The browser could not recover valid retry details for this account and problem. No new acceptance will be sent. Inspect the current record and reload.",
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [sponsorId, problemId]);

  useEffect(() => {
    if (attempt === null) return;
    const now = Date.now();
    const delay = statementRevisionAttemptExpired(attempt, now)
      ? 0
      : attempt.startedAt + STATEMENT_REVISION_RETRY_MS - now;
    const timer = setTimeout(() => setCheckedAt(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [attempt]);

  function clearAttempt(completed: PendingStatementRevision) {
    setAttempt(null);
    try {
      clearPendingStatementRevision(sessionStorage, completed);
      setMessage(null);
    } catch {
      setMessage(
        "The outcome is confirmed, but the browser could not clear its retry details. Keep the receipt below; reloading may offer that same acceptance again.",
      );
    }
  }

  function send(next: PendingStatementRevision) {
    if (
      !ready ||
      lock.current ||
      next.sponsorId !== sponsorId ||
      next.problemId !== problemId ||
      statementRevisionAttemptExpired(next)
    )
      return;
    try {
      persistPendingStatementRevision(sessionStorage, next);
    } catch {
      setResult({
        ok: false,
        retryable: false,
        retainAttempt: true,
        refreshRequired: true,
        message:
          "The exact retry details could not be saved. No acceptance was sent. Reload to recover the existing attempt before trying again.",
      });
      return;
    }
    lock.current = true;
    setAttempt(next);
    setCheckedAt(Date.now());
    startTransition(async () => {
      try {
        const reply = await acceptStatementRevision(
          sponsorId,
          problemId,
          next.input,
          next.key,
          true,
        );
        setResult(reply);
        if (reply.ok || (!reply.retryable && !reply.retainAttempt)) clearAttempt(next);
        if (reply.ok) setConfirmed(false);
      } catch {
        setResult({
          ok: false,
          retryable: true,
          retainAttempt: true,
          message:
            "The acceptance outcome could not be confirmed. Retry the exact retained proposal and key to recover its receipt.",
        });
      } finally {
        lock.current = false;
      }
    });
  }

  return (
    <section className="card" aria-labelledby="statement-revision-confirmation">
      <h2 id="statement-revision-confirmation">Accept the reviewed revision</h2>
      {message !== null && <p role="status">{message}</p>}
      {result?.ok ? (
        <div role="status">
          <p>
            Acceptance confirmed: <code>{result.receipt.statement_revision.proposal_id}</code>{" "}
            became statement S@
            {result.receipt.statement_revision.accepted_statement_version} at{" "}
            <time dateTime={result.receipt.problem.updated_at}>
              {result.receipt.problem.updated_at}
            </time>
            .
          </p>
          <p>
            The scientific author remains{" "}
            <code>{result.receipt.statement_revision.source_fellow_id}</code>. Current status in
            this receipt: {result.receipt.problem.status}.
          </p>
          <p>
            <Link href={`/console/problems/${encodeURIComponent(problemId)}`} prefetch={false}>
              Review the current formulation and next publication step
            </Link>
          </p>
        </div>
      ) : (
        result && <p role="alert">{result.message}</p>
      )}
      {attempt !== null && (
        <div>
          <p>
            Retained acceptance:{" "}
            <Link
              href={statementRevisionsPath(problemId, attempt.input.proposal_id)}
              prefetch={false}
            >
              {attempt.input.proposal_id}
            </Link>
            , based on S@{attempt.input.reviewed_statement_version}. Other acceptances are paused
            until its outcome is known.
          </p>
          {expired ? (
            <>
              <p role="alert">
                The safe retry window has expired. Inspect the statement history and current
                proposals before discarding these retry details.
              </p>
              <button
                type="button"
                className="btn-quiet"
                disabled={pending}
                onClick={() => {
                  try {
                    clearPendingStatementRevision(sessionStorage, attempt);
                    window.location.assign(statementRevisionsPath(problemId));
                  } catch {
                    setMessage(
                      "The retained retry details could not be cleared. Keep this page and inspect the current problem before continuing.",
                    );
                  }
                }}
              >
                Discard expired retry and reload proposals
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn-quiet"
              disabled={pending}
              onClick={() => send(attempt)}
            >
              {pending ? "Recovering acceptance…" : "Recover the exact acceptance"}
            </button>
          )}
        </div>
      )}
      {reviewed !== null && !result?.ok && (
        <form
          className="col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (disabled || lock.current || !confirmed) return;
            send(
              createPendingStatementRevision(
                sponsorId,
                problemId,
                reviewed,
                `console-statement-${crypto.randomUUID()}`,
              ),
            );
          }}
        >
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              name="confirm_statement_revision"
              required
              checked={confirmed}
              disabled={disabled}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>
              I reviewed the complete Fellow-authored proposal above, based on statement S@
              {reviewed.reviewed_statement_version}. I accept those exact words and boundaries as S@
              {reviewed.reviewed_statement_version + 1}.{" "}
              {isPrivate
                ? "The revised draft remains private until a separate publication decision."
                : "The revision becomes a permanent public statement; existing claims may need to be re-anchored. The Fellow remains its scientific author."}
            </span>
          </label>
          <button className="btn" type="submit" disabled={disabled || !confirmed}>
            {pending
              ? "Waiting for acceptance…"
              : `Accept as statement S@${reviewed.reviewed_statement_version + 1}`}
          </button>
        </form>
      )}
      {reviewed === null && !result?.ok && (
        <p>
          No new acceptance is offered from this preview. A previously retained acceptance can still
          be recovered here.
        </p>
      )}
      <p>
        <Link href={statementRevisionsPath(problemId)} prefetch={false}>
          Reload current statement proposals
        </Link>
      </p>
      <p className="quiet">
        Acceptance changes the formulation, not scientific standing. The Worker checks current
        authority, source integrity and the reviewed base version when it admits the revision.
      </p>
    </section>
  );
}
