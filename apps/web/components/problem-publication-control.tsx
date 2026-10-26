"use client";

import { useActionState } from "react";
import {
  publishProblem,
  type ProblemPublicationActionState,
  type ReviewedProblemPublication,
} from "@/app/console/problem-actions";

const INITIAL: ProblemPublicationActionState = { status: "idle" };

/** No draft bytes enter the submitted form; the Worker checks the reviewed digest. */
export function ProblemPublicationControl({ sponsorId, problemId, reviewed }: {
  readonly sponsorId: string;
  readonly problemId: string;
  readonly reviewed: ReviewedProblemPublication;
}) {
  const [state, action, pending] = useActionState(
    publishProblem.bind(null, sponsorId, problemId, reviewed), INITIAL,
  );
  const committed = state.status === "committed";
  const reviewRequired = state.status === "refused" && state.reviewRequired;
  return (
    <section className="card" aria-labelledby="publication-confirmation">
      <h2 id="publication-confirmation">Publish this reviewed formulation</h2>
      {committed ? (
        <div role="status">
          <p>Publication confirmed: statement S@{state.receipt.problem.current_statement_version} entered sharpening.</p>
          <p><a href={`/p/${encodeURIComponent(state.receipt.problem.id)}`}>Read the public problem and its current status</a></p>
        </div>
      ) : (
        <form action={action} className="col gap-3">
          <label className="flex items-start gap-2">
            <input type="checkbox" name="confirm_publication" value="yes" required disabled={pending || reviewRequired} />
            <span>I have reviewed statement S@{reviewed.reviewed_statement_version}, its falsifier,
              motivation, scope, and authorship above. I authorize permanent public disclosure under
              CC BY 4.0 and understand that publishing creates public prior art and may start patent
              deadlines. The Fellow remains the scientific author; I act as publisher.</span>
          </label>
          <button className="btn" type="submit" disabled={pending || reviewRequired}>
            {pending ? "Waiting for publication…" : "Publish reviewed statement"}
          </button>
        </form>
      )}
      {state.status === "refused" ? <p role="alert">{state.message}</p> : null}
      {!committed ? <p><a href={`/console/problems/${encodeURIComponent(problemId)}`}>Reload and review the current formulation</a></p> : null}
      <p className="quiet">Publication starts sharpening. Claims remain gated on an independent statement review and the problem’s admission rules.</p>
    </section>
  );
}
