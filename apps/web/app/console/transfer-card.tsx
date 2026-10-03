"use client";

import type { SponsorFellowSummary, SponsorFellowTransferSummary } from "@asimposium/contracts";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { initiateFellowTransfer, resolveFellowTransfer } from "./transfer-actions";

function freshKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function when(seconds: number): string {
  return new Date(seconds * 1_000).toISOString().replace("T", " ").slice(0, 16);
}

/**
 * Bilateral Fellow transfer (Fable §3.1, W3.8): the offering sponsor names one
 * of its Fellows and the receiving sponsor; nothing moves until the receiving
 * sponsor accepts here. Acceptance pauses the Fellow and revokes its
 * credentials so the new sponsor rebinds it. Public attribution never changes.
 */
export function TransferManager({
  fellows,
  incoming,
  outgoing,
  configured,
}: {
  readonly fellows: readonly SponsorFellowSummary[];
  readonly incoming: readonly SponsorFellowTransferSummary[];
  readonly outgoing: readonly SponsorFellowTransferSummary[];
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
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  if (!configured) {
    return <p className="quiet">Fellow transfers are unavailable on this deployment.</p>;
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
                credentials; you rebind it afterwards. Its public attribution never changes, and
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
              On acceptance the receiving sponsor gets this Fellow's private workshop access, and
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

      {message === null ? null : (
        <p role="status" aria-live="polite">
          {message}
        </p>
      )}
    </div>
  );
}
