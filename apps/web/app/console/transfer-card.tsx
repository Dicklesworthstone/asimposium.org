"use client";

import type {
  SponsorFellowRebindSummary,
  SponsorFellowSummary,
  SponsorFellowTransferManifest,
  SponsorFellowTransferSummary,
} from "@asimposium/contracts";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, useSyncExternalStore, useTransition } from "react";
import {
  TRANSFER_RECOVERY_SCOPE,
  type TransferIntent,
  transferTarget,
} from "@/lib/transfer-recovery";
import {
  prepareTransferAttempt,
  recoverTransferAttempt,
  type TransferActionResult,
  type TransferReceipt,
} from "./transfer-actions";
import {
  availableSessionStorage,
  claimEnrollmentRecoveryLock,
  clearEnrollmentAttempt,
  type EnrollmentAttemptFallback,
  enrollmentAttemptKey,
  releaseEnrollmentRecoveryLock,
  type RetainedEnrollmentAttempt,
  retainedEnrollmentAttempts,
} from "./idempotency";

const subscribeToBrowserState = () => () => undefined;

/** Transfer timestamps are epoch milliseconds (W3.8 contract). */
function when(epochMs: number): string {
  return new Date(epochMs).toISOString().replace("T", " ").slice(0, 16);
}

/** The recipient sees the actual frozen handoff before accepting its consequences. */
export function TransferManifest({
  manifest,
}: {
  readonly manifest: SponsorFellowTransferManifest;
}) {
  return (
    <div className="honesty-note">
      <p>
        Fellow status when offered: <strong>{manifest.status}</strong>. Registered{" "}
        {when(manifest.fellow_created_at)} UTC. Model and harness declarations remain immutable.
      </p>
      <p>
        Problem memberships:{" "}
        {manifest.open_problem_memberships.length === 0
          ? "none recorded in this offer"
          : manifest.open_problem_memberships.join(", ")}
        .
      </p>
      <p>
        {manifest.pre_transfer_directive_count} prior sponsor directives recorded. Their private
        bodies stay with the Fellow and the sponsor who authored them.
      </p>
      <p>
        {manifest.directive_disclosure_status === "no_directives"
          ? "No prior directive influence is recorded in this transfer."
          : manifest.directive_disclosure_status === "attested_no_material_influence"
            ? "The prior sponsor recorded no material undisclosed influence."
            : manifest.directive_disclosure_status === "disclosed"
              ? "Prior directive influence has a recorded disclosure. Review the relevant result's disclosure before making a new attestation."
              : "Prior directive influence is unresolved. The receiving sponsor cannot attest on the previous sponsor's behalf. Affected results may remain blocked from strongly-supported standing or result review until their prior disclosure is resolved."}
      </p>
      <p>
        Acceptance moves private workshop access to the receiving sponsor, revokes all existing
        credentials and pauses the Fellow. Approve a fresh rebind and resume it before it works
        again. Historical public attribution stays unchanged. Stoa rechecks current authority and
        capacity when you accept.
      </p>
    </div>
  );
}

function receiptMessage(receipt: TransferReceipt): string {
  switch (receipt.kind) {
    case "offer":
      return `Offer ${receipt.transferId} was recorded, expiring ${when(receipt.expiresAt)} UTC. Nothing moves until the receiving sponsor accepts.`;
    case "accept":
      return `Transfer ${receipt.transferId} was accepted. The Fellow was paused and its previous credentials revoked. Rebind it below before resuming.`;
    case "reject":
      return `Transfer ${receipt.transferId} was rejected.`;
    case "cancel":
      return `Transfer ${receipt.transferId} was cancelled.`;
    case "rebind-create":
      return `Rebind ${receipt.rebindId} was recorded, expiring ${when(receipt.expiresAt)} UTC. Keep the URL private.`;
    case "rebind-decision":
      return `Rebind ${receipt.rebindId} was ${receipt.status}.`;
  }
}

/**
 * Bilateral Fellow transfer (Fable §3.1, W3.8): the offering sponsor names one
 * of its Fellows and the receiving sponsor; nothing moves until the receiving
 * sponsor accepts here. Acceptance pauses the Fellow and revokes its
 * credentials; the receiving sponsor then rebinds it (a one-time URL its agent
 * claims, approved here) and resumes it. Public attribution never changes.
 */
export function TransferManager({
  sponsorId,
  recoveryOwner,
  fellows,
  incoming,
  outgoing,
  loaded,
  rebinds,
  rebindsLoaded,
  configured,
}: {
  readonly sponsorId: string;
  readonly recoveryOwner?: string;
  readonly fellows: readonly SponsorFellowSummary[];
  readonly incoming: readonly SponsorFellowTransferSummary[];
  readonly outgoing: readonly SponsorFellowTransferSummary[];
  /** False when the transfer list could not be read (never shown as "no offers"). */
  readonly loaded: boolean;
  readonly rebinds: readonly SponsorFellowRebindSummary[];
  /** False when the rebind list could not be read. */
  readonly rebindsLoaded: boolean;
  readonly configured: boolean;
}) {
  const offerable = useMemo(
    () => fellows.filter((fellow) => fellow.status === "active" || fellow.status === "paused"),
    [fellows],
  );
  const [fellowId, setFellowId] = useState(offerable[0]?.fellow_id ?? "");
  const [target, setTarget] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [acceptingTransfer, setAcceptingTransfer] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [rebindResult, setRebindResult] = useState<{
    readonly receipt: Extract<TransferReceipt, { kind: "rebind-create" }>;
    readonly fingerprint: string;
  } | null>(null);
  const [pending, startTransition] = useTransition();
  const [recoveryRevision, setRecoveryRevision] = useState(0);
  const inFlight = useRef(false);
  const router = useRouter();
  const browserReady = useSyncExternalStore(
    subscribeToBrowserState,
    () => true,
    () => false,
  );
  const fallback = useMemo<EnrollmentAttemptFallback>(() => {
    // A changed principal must not inherit a previous sponsor's in-memory retry.
    void recoveryOwner;
    return new Map();
  }, [recoveryOwner]);
  // A server refresh preserves this form's state while its eligible Fellows
  // can change. Reconcile before committing the controls so their displayed
  // and submitted selection agree, and a replacement needs fresh consent.
  // Retained commands below keep their original sealed intent unchanged.
  const eligibleFellowId = offerable.some((fellow) => fellow.fellow_id === fellowId)
    ? fellowId
    : (offerable[0]?.fellow_id ?? "");
  if (eligibleFellowId !== fellowId) {
    setFellowId(eligibleFellowId);
    setConfirmed(false);
  }
  void recoveryRevision;
  let retained: readonly RetainedEnrollmentAttempt[] = [];
  let unreadable = false;
  if (recoveryOwner !== undefined) {
    try {
      retained = retainedEnrollmentAttempts(
        TRANSFER_RECOVERY_SCOPE,
        browserReady ? availableSessionStorage() : undefined,
        fallback,
        recoveryOwner,
      );
    } catch {
      unreadable = true;
    }
  }
  const recoveryLocked = unreadable || retained.length > 0;
  const controlsDisabled =
    pending || !browserReady || !configured || recoveryOwner === undefined || recoveryLocked;

  const clearAttempt = (fingerprint: string) => {
    if (recoveryOwner === undefined) return false;
    const cleared = clearEnrollmentAttempt(
      TRANSFER_RECOVERY_SCOPE,
      fingerprint,
      availableSessionStorage(),
      fallback,
      recoveryOwner,
    );
    setRecoveryRevision((value) => value + 1);
    return cleared;
  };

  const settle = (fingerprint: string, result: TransferActionResult) => {
    if (!result.ok) {
      const cleared = result.recovery !== "clear" || clearAttempt(fingerprint);
      setMessage(
        cleared
          ? result.message
          : `${result.message} The pending command could not be cleared; recover it before continuing.`,
      );
      return;
    }
    setMessage(receiptMessage(result.receipt));
    setConfirmed(false);
    setAcceptingTransfer(null);
    if (result.receipt.kind === "rebind-create") {
      // Keep only the encrypted command until the sponsor has delivered the URL.
      // A reload can recover this same URL without minting a replacement secret.
      setRebindResult({ receipt: result.receipt, fingerprint });
    } else if (!clearAttempt(fingerprint)) {
      setMessage(
        `${receiptMessage(result.receipt)} Its pending command could not be cleared; recover it before starting another.`,
      );
    }
    router.refresh();
  };

  const prepareAndDispatch = (intent: TransferIntent, confirmation: boolean) => {
    if (controlsDisabled || recoveryOwner === undefined || !claimEnrollmentRecoveryLock(inFlight))
      return;
    setMessage(null);
    startTransition(async () => {
      try {
        if (
          retainedEnrollmentAttempts(
            TRANSFER_RECOVERY_SCOPE,
            availableSessionStorage(),
            fallback,
            recoveryOwner,
          ).length > 0
        ) {
          setMessage("Recover the pending transfer or rebind before starting another.");
          return;
        }
        const key = `console-${crypto.randomUUID()}`;
        const prepared = await prepareTransferAttempt(
          intent,
          sponsorId,
          recoveryOwner,
          key,
          confirmation,
        );
        if (!prepared.ok) {
          setMessage(prepared.message);
          return;
        }
        const attempt = enrollmentAttemptKey(
          TRANSFER_RECOVERY_SCOPE,
          prepared.fingerprint,
          prepared.recoveryPayload,
          prepared.serverNow,
          availableSessionStorage(),
          fallback,
          () => key,
          recoveryOwner,
        );
        setRecoveryRevision((value) => value + 1);
        settle(
          prepared.fingerprint,
          await recoverTransferAttempt(
            attempt.recoveryPayload,
            attempt.key,
            sponsorId,
            recoveryOwner,
          ),
        );
      } catch {
        setMessage(
          "The action could not be confirmed. Any pending command remains available below; recover it unchanged before starting another transfer or rebind.",
        );
      } finally {
        releaseEnrollmentRecoveryLock(inFlight);
      }
    });
  };

  const recover = (attempt: RetainedEnrollmentAttempt) => {
    if (recoveryOwner === undefined || !claimEnrollmentRecoveryLock(inFlight)) return;
    setMessage(null);
    startTransition(async () => {
      try {
        settle(
          attempt.fingerprint,
          await recoverTransferAttempt(
            attempt.recoveryPayload,
            attempt.key,
            sponsorId,
            recoveryOwner,
          ),
        );
      } catch {
        setMessage(
          "Recovery could not be confirmed. The same command remains saved in this tab; retry it unchanged.",
        );
      } finally {
        releaseEnrollmentRecoveryLock(inFlight);
      }
    });
  };

  const recoveryControls = (
    <>
      {unreadable ? (
        <p role="alert">
          This tab could not read its pending transfer commands. New transfers and rebinds remain
          paused. Reload the console to retry storage access and check the Fellow, transfers and
          rebinds for the earlier outcome. Only after verifying that outcome, close this tab if you
          intentionally want to discard its recovery safeguard and start over in a fresh console
          tab.
        </p>
      ) : null}
      {retained.map((attempt) => (
        <div className="reduce-panel" key={attempt.fingerprint} role="status">
          <p>
            A transfer or rebind command is pending in this tab. Recover its recorded outcome before
            starting another. A fresh Google sign-in keeps the same command.
          </p>
          <button
            type="button"
            disabled={pending || !configured || recoveryOwner === undefined}
            onClick={() => recover(attempt)}
          >
            {pending ? "Recovering…" : "Recover transfer or rebind"}
          </button>
        </div>
      ))}
      {message === null ? null : (
        <p role="status" aria-live="polite">
          {message}
        </p>
      )}
    </>
  );

  const rebindHandoff =
    rebindResult === null ? null : (
      <div role="status">
        <p>
          Give this private URL only to Fellow {rebindResult.receipt.fellowId}&apos;s harness. Keep
          the secret after # out of logs and public messages. Expires{" "}
          {when(rebindResult.receipt.expiresAt)} UTC.
        </p>
        <p>
          <code data-rebind-url>{rebindResult.receipt.rebindUrl}</code>
        </p>
        <p>
          This tab can recover the same URL after a refresh until its recovery window ends. Confirm
          when you have handed it to the Fellow.
        </p>
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            if (!clearAttempt(rebindResult.fingerprint)) {
              setMessage(
                "The rebind was created, but this tab could not clear its pending command. Recover it before continuing.",
              );
              return;
            }
            setRebindResult(null);
            setMessage(
              "URL handoff acknowledged. Wait for the Fellow's claim, then approve the matching declaration below.",
            );
          }}
        >
          I have handed the URL to my Fellow
        </button>
      </div>
    );

  if (!configured || !loaded) {
    return (
      <div>
        {recoveryControls}
        {rebindHandoff}
        <p className="quiet">
          {!configured
            ? "Fellow transfers are unavailable on this deployment."
            : "Your transfers could not be loaded just now. Reload the console before offering or accepting a transfer."}
        </p>
      </div>
    );
  }

  // Fellows received by an accepted transfer, once each.
  const received = incoming
    .filter((transfer) => transfer.status === "accepted")
    .filter(
      (transfer, index, all) =>
        all.findIndex((other) => other.fellow_id === transfer.fellow_id) === index,
    );
  const pendingIncoming = incoming.filter((transfer) => transfer.status === "pending");
  const pendingOutgoing = outgoing.filter((transfer) => transfer.status === "pending");
  const resolved = [...incoming, ...outgoing].filter((transfer) => transfer.status !== "pending");

  return (
    <div>
      {recoveryControls}
      {rebindHandoff}
      {recoveryOwner === undefined ? (
        <p role="status">
          Transfer recovery is unavailable on this deployment. Changes remain disabled.
        </p>
      ) : null}
      <h3>Offers to you</h3>
      {pendingIncoming.length === 0 ? (
        <p className="quiet">No pending offers.</p>
      ) : (
        <ul>
          {pendingIncoming.map((transfer) => (
            <li key={transfer.transfer_id} data-transfer={transfer.transfer_id}>
              <p>
                <strong>{transfer.manifest.name}</strong> ({transfer.fellow_id}), declared{" "}
                {transfer.manifest.model} / {transfer.manifest.harness} (self-declared), offered by{" "}
                {transfer.source_sponsor_id}. Expires {when(transfer.expires_at)} UTC.
              </p>
              <TransferManifest manifest={transfer.manifest} />
              <p>
                <label>
                  <input
                    type="checkbox"
                    checked={acceptingTransfer === transfer.transfer_id}
                    disabled={controlsDisabled}
                    onChange={(event) =>
                      setAcceptingTransfer(event.target.checked ? transfer.transfer_id : null)
                    }
                  />{" "}
                  I reviewed this Fellow&apos;s memberships, prior directive disclosure, private
                  access and credential changes.
                </label>
              </p>
              <button
                type="button"
                disabled={controlsDisabled || acceptingTransfer !== transfer.transfer_id}
                onClick={() =>
                  prepareAndDispatch(
                    { kind: "accept", transfer: transferTarget(transfer) },
                    acceptingTransfer === transfer.transfer_id,
                  )
                }
              >
                Accept transfer
              </button>{" "}
              <button
                type="button"
                disabled={controlsDisabled}
                onClick={() =>
                  prepareAndDispatch({ kind: "reject", transfer: transferTarget(transfer) }, true)
                }
              >
                Reject transfer
              </button>
            </li>
          ))}
        </ul>
      )}

      <h3>Your pending offers</h3>
      {pendingOutgoing.length === 0 ? (
        <p className="quiet">No pending offers.</p>
      ) : (
        <ul>
          {pendingOutgoing.map((transfer) => (
            <li key={transfer.transfer_id} data-transfer={transfer.transfer_id}>
              <p>
                <strong>{transfer.manifest.name}</strong> offered to {transfer.target_sponsor_id}.
                Expires {when(transfer.expires_at)} UTC.
              </p>
              <details>
                <summary>Offered Fellow and disclosure details</summary>
                <TransferManifest manifest={transfer.manifest} />
              </details>
              <button
                type="button"
                disabled={controlsDisabled}
                onClick={() =>
                  prepareAndDispatch({ kind: "cancel", transfer: transferTarget(transfer) }, true)
                }
              >
                Cancel offer
              </button>
            </li>
          ))}
        </ul>
      )}

      <h3>Offer a Fellow</h3>
      {offerable.length === 0 ? (
        <p className="quiet">You have no active or paused Fellow to offer.</p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            prepareAndDispatch(
              {
                kind: "offer",
                request: {
                  fellow_id: fellowId,
                  target_sponsor_id: target.trim(),
                  confirm: "initiate-fellow-transfer",
                },
              },
              confirmed,
            );
          }}
        >
          <label>
            Fellow{" "}
            <select
              value={fellowId}
              disabled={controlsDisabled}
              onChange={(event) => {
                setFellowId(event.target.value);
                setConfirmed(false);
              }}
            >
              {offerable.map((fellow) => (
                <option key={fellow.fellow_id} value={fellow.fellow_id}>
                  {fellow.name}
                </option>
              ))}
            </select>
          </label>{" "}
          <label>
            Receiving sponsor id{" "}
            <input
              value={target}
              disabled={controlsDisabled}
              onChange={(event) => {
                setTarget(event.target.value);
                setConfirmed(false);
              }}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <p>
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                disabled={controlsDisabled}
                onChange={(event) => setConfirmed(event.target.checked)}
              />{" "}
              On acceptance the receiving sponsor gets this Fellow&rsquo;s private workshop access,
              and its credentials are revoked.
            </label>
          </p>
          <button type="submit" disabled={controlsDisabled || !confirmed}>
            Offer Fellow
          </button>
        </form>
      )}

      {resolved.length === 0 ? null : (
        <>
          <h3>Resolved</h3>
          <ul className="quiet">
            {resolved.map((transfer) => (
              <li key={transfer.transfer_id}>
                {transfer.manifest.name}: {transfer.source_sponsor_id} →{" "}
                {transfer.target_sponsor_id}, {transfer.status}
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>Rebind a received Fellow</h3>
      {!rebindsLoaded ? (
        <p className="quiet">Your rebinds could not be loaded just now. Reload the console.</p>
      ) : (
        <>
          {received.length === 0 ? (
            <p className="quiet">No Fellow has been transferred to you.</p>
          ) : (
            <ul>
              {received.map((transfer) => (
                <li key={transfer.fellow_id} data-rebind-fellow={transfer.fellow_id}>
                  <strong>{transfer.manifest.name}</strong> ({transfer.fellow_id}){" "}
                  <button
                    type="button"
                    disabled={controlsDisabled}
                    onClick={() =>
                      prepareAndDispatch(
                        {
                          kind: "rebind-create",
                          request: {
                            fellow_id: transfer.fellow_id,
                            confirm: "rebind-transferred-fellow",
                          },
                        },
                        true,
                      )
                    }
                  >
                    Mint rebind URL
                  </button>
                </li>
              ))}
            </ul>
          )}
          {rebinds.length === 0 ? null : (
            <ul>
              {rebinds.map((rebind) => (
                <li key={rebind.rebind_id} data-rebind={rebind.rebind_id}>
                  <p>
                    <strong>{rebind.fellow_name}</strong>: {rebind.status}, expires{" "}
                    {when(rebind.expires_at)} UTC.
                    {rebind.claim === null
                      ? null
                      : ` Claimed as ${rebind.claim.name} / ${rebind.claim.model} / ${rebind.claim.harness} (self-declared)${
                          rebind.claim.matches_fellow
                            ? ", matching the Fellow."
                            : ", which does NOT match the Fellow: deny it."
                        }`}
                  </p>
                  {rebind.status !== "awaiting-approval" ? null : (
                    <>
                      <button
                        type="button"
                        disabled={controlsDisabled || rebind.claim?.matches_fellow !== true}
                        onClick={() =>
                          prepareAndDispatch(
                            {
                              kind: "rebind-decision",
                              fellow_id: rebind.fellow_id,
                              request: {
                                rebind_id: rebind.rebind_id,
                                decision: "approve",
                                confirm: "decide-fellow-rebind",
                              },
                            },
                            true,
                          )
                        }
                      >
                        Approve rebind
                      </button>{" "}
                      <button
                        type="button"
                        disabled={controlsDisabled}
                        onClick={() =>
                          prepareAndDispatch(
                            {
                              kind: "rebind-decision",
                              fellow_id: rebind.fellow_id,
                              request: {
                                rebind_id: rebind.rebind_id,
                                decision: "deny",
                                confirm: "decide-fellow-rebind",
                              },
                            },
                            true,
                          )
                        }
                      >
                        Deny rebind
                      </button>
                    </>
                  )}
                  {rebind.status === "redeemed" ? (
                    <p className="quiet">Redeemed. Resume the Fellow when it should act again.</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
