"use client";

import type { SponsorAccountDeletePreviewResponse, SponsorAccountDeleteResponse } from "@asimposium/contracts";
import Link from "next/link";
import { useMemo, useRef, useState, useSyncExternalStore, useTransition } from "react";
import {
  confirmAccountDeletion,
  prepareAccountDeletion,
  type AccountDeletionFailure,
} from "@/app/console/account/actions";
import {
  accountDeletionRecoveryKey,
  clearPendingAccountDeletion,
  parsePendingAccountDeletion,
  persistPendingAccountDeletion,
  type PendingAccountDeletion,
} from "@/lib/account-deletion-recovery";

const STORAGE_UNAVAILABLE = Symbol("deletion-recovery-unavailable");
function subscribeToRecovery(onChange: () => void) {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}
const serverRecoverySnapshot = () => undefined;

export function AccountDeletionControl({ principalId, canDelete }: {
  readonly principalId: string;
  readonly canDelete: boolean;
}) {
  const [reviewedPreview, setPreview] = useState<SponsorAccountDeletePreviewResponse | null>(null);
  const [submittedAttempt, setAttempt] = useState<PendingAccountDeletion | null>(null);
  const [receipt, setReceipt] = useState<SponsorAccountDeleteResponse | null>(null);
  const [failure, setFailure] = useState<AccountDeletionFailure | null>(null);
  const [phrase, setPhrase] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [storageFailed, setStorageBlocked] = useState(false);
  const [pending, startTransition] = useTransition();
  const lock = useRef(false);

  // A stable string snapshot reads the external session store after hydration.
  // Initial server rendering cannot mistake an unread pending write for an empty tab.
  const rawRecovery = useSyncExternalStore<string | null | undefined | typeof STORAGE_UNAVAILABLE>(subscribeToRecovery, () => {
    try {
      return sessionStorage.getItem(accountDeletionRecoveryKey(principalId));
    } catch {
      return STORAGE_UNAVAILABLE;
    }
  }, serverRecoverySnapshot);
  const recovery = useMemo(() => {
    if (typeof rawRecovery !== "string") return { pending: null, blocked: rawRecovery === STORAGE_UNAVAILABLE };
    try { return { pending: parsePendingAccountDeletion(rawRecovery, principalId), blocked: false }; }
    catch { return { pending: null, blocked: true }; }
  }, [principalId, rawRecovery]);
  const recoveryReady = rawRecovery !== undefined;
  const storageBlocked = storageFailed || recovery.blocked;
  const attempt = submittedAttempt ?? recovery.pending;
  const preview = attempt?.preview ?? reviewedPreview;
  const visibleFailure: AccountDeletionFailure | null = failure ?? (recovery.blocked ? {
    ok: false, recovery: "retain",
    message: "This tab's deletion recovery record could not be read. No new deletion will be sent while its prior confirmation cannot be verified. Restore access to this tab's session storage and reload.",
  } : submittedAttempt === null && recovery.pending !== null ? {
    ok: false, recovery: "retain",
    message: "A previously confirmed deletion has an unresolved response. Retry that same confirmation below to recover its receipt. Returning to this page does not send it automatically.",
  } : null);

  function readPreview() {
    if (lock.current || !recoveryReady || storageBlocked || attempt !== null || receipt !== null) return;
    lock.current = true;
    setFailure(null);
    setPreview(null);
    setConfirmed(false);
    setPhrase("");
    startTransition(async () => {
      try {
        const result = await prepareAccountDeletion(principalId);
        if (result.ok) setPreview(result.preview);
        else setFailure(result);
      } catch {
        setFailure({ ok: false, recovery: "retain", message: "The account preview could not be read. No deletion was sent. Try reading the impact again." });
      } finally {
        lock.current = false;
      }
    });
  }

  function send(next: PendingAccountDeletion) {
    if (lock.current || !recoveryReady || storageBlocked || !canDelete || receipt !== null) return;
    try {
      persistPendingAccountDeletion(sessionStorage, next);
    } catch {
      setStorageBlocked(true);
      setFailure({ ok: false, recovery: "retain",
        message: "The exact confirmation and retry key could not be saved in this tab. No deletion was sent. Restore session storage and reload before trying again." });
      return;
    }
    lock.current = true;
    setAttempt(next);
    setFailure(null);
    startTransition(async () => {
      try {
        const result = await confirmAccountDeletion(principalId, {
          confirm: "delete-sponsor-account-and-revoke-all-fellows", expected_preview: next.preview.review,
        }, next.idempotency_key);
        if (result.ok) {
          setReceipt(result.receipt);
          setAttempt(null);
          try { clearPendingAccountDeletion(sessionStorage, next); } catch {
            // The committed receipt stays authoritative; a retained key can only replay it.
          }
        } else {
          setFailure(result);
          if (result.recovery === "review") {
            try {
              clearPendingAccountDeletion(sessionStorage, next);
              setAttempt(null);
              setPreview(null);
              setConfirmed(false);
              setPhrase("");
            } catch {
              setStorageBlocked(true);
              setFailure({ ok: false, recovery: "retain",
                message: "The refused confirmation could not be cleared from this tab's recovery record. Restore session storage and reload before starting another review." });
            }
          }
        }
      } catch {
        setFailure({ ok: false, recovery: "retain",
          message: "The deletion response was interrupted. This tab retained the exact confirmation and retry key. Retry below to recover the receipt without creating a different deletion." });
      } finally {
        lock.current = false;
      }
    });
  }

  function submit() {
    if (preview === null || attempt !== null || !confirmed || phrase !== "DELETE MY ACCOUNT") return;
    try {
      send({ version: "asimposium.account-deletion-recovery.v1", sponsor_id: principalId,
        preview, idempotency_key: `account-deletion-${crypto.randomUUID()}` });
    } catch {
      setFailure({ ok: false, recovery: "review", message: "A secure retry key could not be created. No deletion was sent. Reload in a supported browser." });
    }
  }

  return (
    <section className="card" aria-labelledby="account-deletion-title">
      <h2 className="card-title" id="account-deletion-title">Delete your sponsor account</h2>
      <p>This irreversible action closes sponsor <code>{principalId}</code>, revokes its Fellows and credentials, cancels its pending enrollment and transfer flows, and erases its never-published private draft content.</p>
      <p>Download your account export above first. To keep Fellows active under a different sponsor, complete a bilateral transfer from the <Link href="/console">sponsor console</Link> before deleting this account.</p>
      <p>Public scientific history remains with tombstoned sponsor attribution. Private workshop and directive material attached to retained scientific records is not confirmed erased by this account action. See the <Link href="/policy">retention policy</Link> for retained records and backup handling.</p>
      <p>Erased drafts cannot be reopened. Minimal draft identities, moderation decisions, and upload quota evidence may remain for audit. Artifact storage bytes follow the retention policy; this action does not confirm their physical erasure.</p>

      {receipt !== null ? (
        <section aria-labelledby="account-deletion-receipt-title">
          <h3 id="account-deletion-receipt-title">Account deletion confirmed</h3>
          <p role="status">The account service committed this deletion at <time dateTime={receipt.deleted_at}>{receipt.deleted_at}</time>. The sponsor account cannot be reopened.</p>
          <dl className="facts">
            <dt>Fellows revoked</dt><dd>{receipt.revoked_fellows_count}</dd>
            <dt>Credentials revoked</dt><dd>{receipt.revoked_credentials_count}</dd>
            <dt>Enrollment links invalidated</dt><dd>{receipt.invalidated_enrollments_count}</dd>
            <dt>Pending enrollments denied</dt><dd>{receipt.cancelled_proposals_count}</dd>
            <dt>Transfers cancelled</dt><dd>{receipt.cancelled_transfers_count}</dd>
            <dt>Rebinds superseded</dt><dd>{receipt.superseded_rebinds_count}</dd>
            <dt>Never-published drafts with content erased</dt><dd>{receipt.private_drafts_deleted_count}</dd>
            <dt>Deletion receipt</dt><dd><code>{receipt.deletion_receipt.receiptId}</code></dd>
            <dt>Retention journal record</dt><dd><code>{receipt.retention_control_record.controlId}</code></dd>
            <dt>Confirmed impact digest</dt><dd><code>{receipt.review.digest}</code></dd>
          </dl>
          <p>The receipt confirms account closure and the operations counted above. It is not proof that all physical copies of retained private material have been erased.</p>
        </section>
      ) : (
        <>
          {visibleFailure !== null ? <p role="alert">{visibleFailure.message}</p> : null}
          {!canDelete || visibleFailure?.reauthenticate ? <p><a href="#account-reauth">Re-authenticate with Google</a> before confirming or retrying deletion. Authentication must be from the last 15 minutes.</p> : null}
          {attempt === null ? (
            <button type="button" className="btn-quiet" disabled={pending || !recoveryReady || storageBlocked} onClick={readPreview}>
              {preview === null ? "Review exact deletion impact" : "Refresh deletion impact"}
            </button>
          ) : null}
          {preview !== null ? (
            <section aria-labelledby="account-deletion-impact-title">
              <h3 id="account-deletion-impact-title">{attempt === null ? "Review the affected resources" : "Previously confirmed impact"}</h3>
              <dl className="facts">
                <dt>Fellows to revoke, including paused Fellows</dt><dd>{preview.fellows_to_revoke_count}</dd>
                <dt>Credentials to revoke, including expired credentials</dt><dd>{preview.credentials_to_revoke_count}</dd>
                <dt>Enrollment links to invalidate</dt><dd>{preview.enrollment_links_to_invalidate_count}</dd>
                <dt>Pending enrollments to deny</dt><dd>{preview.pending_enrollments_count}</dd>
                <dt>Pending transfers to cancel</dt><dd>{preview.pending_transfers_count}</dd>
                <dt>Pending rebinds to supersede</dt><dd>{preview.pending_rebinds_count}</dd>
                <dt>Never-published private drafts whose content will be erased</dt><dd>{preview.private_draft_problems_count}</dd>
                <dt>Ordinary backup residual window</dt><dd>Up to {preview.backup_residual_window_days} days after deletion</dd>
                <dt>Legal hold reported by account service</dt><dd>{preview.legal_hold_exceptions ? "Yes; retained copies may remain beyond the ordinary window" : "No"}</dd>
                <dt>Reviewed impact digest</dt><dd><code>{preview.review.digest}</code></dd>
              </dl>
              <p>If account resources change after this preview, deletion is refused and a new review is required. Shared hashes referenced by public scientific history remain.</p>
              {attempt === null ? (
                <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
                  <fieldset disabled={pending || !canDelete || storageBlocked || !recoveryReady}>
                    <legend>Confirm irreversible account deletion</legend>
                    <label>
                      <input type="checkbox" checked={confirmed} required onChange={(event) => setConfirmed(event.target.checked)} />
                      I reviewed this exact account impact and understand that account closure cannot be undone and public scientific history will remain.
                    </label>
                    <label>
                      Type DELETE MY ACCOUNT
                      <input type="text" value={phrase} autoComplete="off" spellCheck={false} required onChange={(event) => setPhrase(event.target.value)} />
                    </label>
                    <button type="submit" className="btn-action btn-reject" disabled={!confirmed || phrase !== "DELETE MY ACCOUNT"}>Delete account and revoke Fellows</button>
                  </fieldset>
                </form>
              ) : (
                <>
                  <p>Retry key: <code>{attempt.idempotency_key}</code>. Keep this tab open until its receipt is confirmed. The confirmation is retained across reloads and re-authentication in this tab. Retry promptly: the account service keeps an exact replay receipt for 24 hours.</p>
                  <button type="button" className="btn-action btn-reject" disabled={pending || !canDelete || storageBlocked} onClick={() => send(attempt)}>Retry confirmed deletion</button>
                </>
              )}
            </section>
          ) : null}
          {pending ? <p role="status">Waiting for the account service…</p> : null}
        </>
      )}
      <noscript><p>Enable JavaScript to load the exact account impact and retain a replay-safe deletion confirmation. This page does not delete an account merely by being opened.</p></noscript>
    </section>
  );
}
