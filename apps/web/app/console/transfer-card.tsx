"use client";

import type {
  SponsorFellowRebindSummary,
  SponsorFellowSummary,
  SponsorFellowTransferSummary,
} from "@asimposium/contracts";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import {
  createFellowRebind,
  decideFellowRebind,
  initiateFellowTransfer,
  resolveFellowTransfer,
} from "./transfer-actions";

function freshKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

/** Transfer timestamps are epoch milliseconds (W3.8 contract). */
function when(epochMs: number): string {
  return new Date(epochMs).toISOString().replace("T", " ").slice(0, 16);
}

/**
 * Bilateral Fellow transfer (Fable §3.1, W3.8): the offering sponsor names one
 * of its Fellows and the receiving sponsor; nothing moves until the receiving
 * sponsor accepts here. Acceptance pauses the Fellow and revokes its
 * credentials; the receiving sponsor then rebinds it (a one-time URL its agent
 * claims, approved here) and resumes it. Public attribution never changes.
 */
export function TransferManager({
  fellows,
  incoming,
  outgoing,
  loaded,
  rebinds,
  rebindsLoaded,
  configured,
}: {
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
  const [message, setMessage] = useState<string | null>(null);
  const [rebindUrl, setRebindUrl] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  if (!configured) {
    return <p className="quiet">Fellow transfers are unavailable on this deployment.</p>;
  }
  if (!loaded) {
    return (
      <p className="quiet">
        Your transfers could not be loaded just now. Reload the console before offering or accepting
        a transfer.
      </p>
    );
  }

  const resolve = (transferId: string, decision: "accept" | "reject" | "cancel") => {
    setMessage(null);
    startTransition(async () => {
      const result = await resolveFellowTransfer(transferId, decision, freshKey("transfer"));
      setMessage(
        result.ok ? `Transfer ${result.value.transferId} ${result.value.outcome}.` : result.message,
      );
      if (result.ok) router.refresh();
    });
  };

  const mintRebind = (fellowId: string) => {
    setMessage(null);
    setRebindUrl(null);
    startTransition(async () => {
      const result = await createFellowRebind(fellowId, freshKey("rebind"));
      if (result.ok) {
        setRebindUrl(result.value.rebindUrl);
        setMessage(
          `Rebind ${result.value.rebindId} is open until ${when(result.value.expiresAt)} UTC.`,
        );
        router.refresh();
      } else {
        setMessage(result.message);
      }
    });
  };

  const decideRebind = (rebindId: string, decision: "approve" | "deny") => {
    setMessage(null);
    startTransition(async () => {
      const result = await decideFellowRebind(rebindId, decision, freshKey("rebind-decision"));
      setMessage(
        result.ok ? `Rebind ${result.value.rebindId} ${result.value.status}.` : result.message,
      );
      if (result.ok) router.refresh();
    });
  };

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
              <p className="quiet">
                Accepting gives you its private workshop access, pauses it and revokes its
                credentials. You then rebind it below: a one-time URL its agent claims and you
                approve, after which you resume it. Its public attribution never changes, and
                earlier directive bodies are not disclosed to you.
              </p>
              <button
                type="button"
                disabled={pending}
                onClick={() => resolve(transfer.transfer_id, "accept")}
              >
                Accept transfer
              </button>{" "}
              <button
                type="button"
                disabled={pending}
                onClick={() => resolve(transfer.transfer_id, "reject")}
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
              <button
                type="button"
                disabled={pending}
                onClick={() => resolve(transfer.transfer_id, "cancel")}
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
            setMessage(null);
            startTransition(async () => {
              const result = await initiateFellowTransfer(
                fellowId,
                target,
                confirmed,
                freshKey("offer"),
              );
              setMessage(
                result.ok
                  ? `Offer ${result.value.transferId} is pending until ${when(result.value.expiresAt)} UTC. Nothing moves until the receiving sponsor accepts.`
                  : result.message,
              );
              if (result.ok) {
                setConfirmed(false);
                router.refresh();
              }
            });
          }}
        >
          <label>
            Fellow{" "}
            <select value={fellowId} onChange={(event) => setFellowId(event.target.value)}>
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
              onChange={(event) => setTarget(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <p>
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />{" "}
              On acceptance the receiving sponsor gets this Fellow&rsquo;s private workshop access, and
              its credentials are revoked.
            </label>
          </p>
          <button type="submit" disabled={pending}>
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
                    disabled={pending}
                    onClick={() => mintRebind(transfer.fellow_id)}
                  >
                    Mint rebind URL
                  </button>
                </li>
              ))}
            </ul>
          )}
          {rebindUrl === null ? null : (
            <p>
              Give this one-time URL to the Fellow&apos;s agent; it is shown only now, and its
              secret after # never reaches this site again: <code data-rebind-url>{rebindUrl}</code>
            </p>
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
                        disabled={pending || rebind.claim?.matches_fellow !== true}
                        onClick={() => decideRebind(rebind.rebind_id, "approve")}
                      >
                        Approve rebind
                      </button>{" "}
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => decideRebind(rebind.rebind_id, "deny")}
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

      {message === null ? null : (
        <p role="status" aria-live="polite">
          {message}
        </p>
      )}
    </div>
  );
}
