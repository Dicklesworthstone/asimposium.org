"use client";

import Link from "next/link";
import { useActionState } from "react";
import { applyWorkshopAction, type WorkshopActionState } from "./workshop-actions";

const INITIAL_STATE: WorkshopActionState = { status: "idle" };

/** Every control waits for the Worker's receipt; draft bytes never enter a form. */
export function WorkshopCardActions({
  sponsorId,
  fellowId,
  problemId,
  workshopId,
  version,
  objectState,
  isReplacement,
}: {
  readonly sponsorId: string;
  readonly fellowId: string;
  readonly problemId: string;
  readonly workshopId: string;
  readonly version: number;
  readonly objectState: "open" | "archived" | "discarded";
  readonly isReplacement: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    applyWorkshopAction.bind(null, sponsorId, {
      problem_id: problemId,
      fellow_id: fellowId,
      workshop_id: workshopId,
      expected_workshop_version: version,
    }),
    INITIAL_STATE,
  );
  const promoted =
    state.status === "committed" &&
    state.receipt.action === "promote" &&
    state.receipt.promoted_workshop_version === version;

  return (
    <div className="workshop-card-actions mt-3 border-t pt-3">
      {objectState === "open" && !isReplacement ? (
        <form key={`promote-${version}`} action={formAction} className="col gap-2">
          <input type="hidden" name="action" value="promote" />
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="confirm_promotion"
              value="yes"
              required
              disabled={pending || promoted}
            />
            <span>
              Publish the Fellow’s stored claim from revision {version}. The Fellow, session, model
              and harness remain the scientific author; I am recorded as acting promoter.
            </span>
          </label>
          <button className="btn" type="submit" disabled={pending || promoted}>
            {promoted ? "Promoted to Ledger" : "Promote to Ledger"}
          </button>
        </form>
      ) : isReplacement ? (
        <p className="quiet text-sm">
          The Fellow publishes stored claim replacements through its session.
        </p>
      ) : (
        <p className="quiet text-sm">
          This draft is {objectState}. Keep reopens it for further work.
        </p>
      )}
      <form action={formAction} className="btn-row mt-3">
        <button className="btn-quiet" type="submit" name="action" value="keep" disabled={pending}>
          {objectState === "open" ? "Keep Draft" : "Keep / Reopen Draft"}
        </button>
        <button
          className="btn-quiet"
          type="submit"
          name="action"
          value="discard"
          disabled={pending || objectState === "discarded"}
        >
          Discard (Soft-hide)
        </button>
      </form>
      <p className="quiet text-sm mt-2">Discard preserves the draft and its history privately.</p>
      {pending ? <p role="status">Waiting for the workshop action…</p> : null}
      {state.status === "refused" ? (
        <div role="alert" className="mt-2">
          <p>
            <strong>{state.message}</strong>
          </p>
          {state.code ? (
            <p className="quiet">
              <code>{state.code}</code>
              {state.rule ? ` · ${state.rule}` : ""}
            </p>
          ) : null}
          {state.fixHint ? <p>{state.fixHint}</p> : null}
          {state.currentVersion === undefined ? null : (
            <p>
              The current workshop revision is {state.currentVersion}. Refresh and review it before
              retrying.
            </p>
          )}
        </div>
      ) : state.status === "committed" ? (
        <div role="status" className="mt-2">
          {state.receipt.action === "promote" ? (
            <p>
              Revision {state.receipt.promoted_workshop_version} was promoted as{" "}
              <Link
                href={`/p/${encodeURIComponent(problemId)}/claims/${encodeURIComponent(state.receipt.promotion.claim_id)}`}
              >
                {state.receipt.promotion.claim_id}
              </Link>
              .
            </p>
          ) : (
            <p>
              {state.receipt.action === "keep" ? "Draft kept" : "Draft soft-hidden"} at revision{" "}
              {state.receipt.version}.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
