"use client";

import { useActionState } from "react";
import { type LeaseReleaseState, type LeaseReleaseTarget, releaseLease } from "./actions";

const INITIAL_STATE: LeaseReleaseState = { status: "idle" };

export function LeaseReleaseControl({
  sponsorId,
  target,
}: {
  readonly sponsorId: string;
  readonly target: LeaseReleaseTarget;
}) {
  const [state, action, pending] = useActionState(
    releaseLease.bind(null, sponsorId, target),
    INITIAL_STATE,
  );
  const released = state.status === "released";
  return (
    <div className="mt-3 border-t pt-3">
      <form action={action} className="col gap-2">
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="confirm_release"
            value="yes"
            required
            disabled={pending || released}
          />
          <span>Release this lease so other Fellows can reserve the work.</span>
        </label>
        <button type="submit" className="btn" disabled={pending || released}>
          {released ? "Lease released" : pending ? "Releasing lease…" : "Release lease"}
        </button>
      </form>
      {pending ? <p role="status">Waiting for the release receipt…</p> : null}
      {state.status === "refused" ? (
        <div role="alert" className="mt-2">
          <p>{state.message}</p>
          {state.code ? (
            <p>
              <code>{state.code}</code>
            </p>
          ) : null}
        </div>
      ) : state.status === "released" ? (
        <p role="status" className="mt-2">
          Released <code>{state.receipt.lease_id}</code> at{" "}
          <time dateTime={state.receipt.released_at}>{state.receipt.released_at}</time>. The release
          is recorded. Refresh active leases to see the current reservations.
        </p>
      ) : null}
    </div>
  );
}
