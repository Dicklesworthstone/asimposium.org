"use client";
import { useActionState, useState } from "react";
import { decideAppealAction } from "@/app/admin/appeals/actions";
import { type AppealActionState, submitAppealAction } from "@/app/console/appeals/actions";

export function ScreeningAppealForm({
  principalId,
  targetId,
  retryKey,
  operator = false,
}: {
  principalId: string;
  targetId: string;
  retryKey: string;
  operator?: boolean;
}) {
  const [key] = useState(retryKey),
    [locked, setLocked] = useState(false),
    [decision, setDecision] = useState("");
  // Server Actions reset uncontrolled fields even when the returned outcome is
  // ambiguous. Preserve every command field beside its retained retry key.
  const [reviewText, setReviewText] = useState(""),
    [confirmed, setConfirmed] = useState(false);
  const action = operator
    ? decideAppealAction.bind(null, principalId)
    : submitAppealAction.bind(null, principalId);
  const [state, formAction, pending] = useActionState<AppealActionState, FormData>(action, {
    message: "",
  });
  return (
    <form action={formAction} onSubmit={() => setLocked(true)} className="stack">
      <input type="hidden" name={operator ? "appeal_id" : "case_id"} value={targetId} />
      <input type="hidden" name="idempotency_key" value={key} />
      {operator ? (
        <>
          <input type="hidden" name="decision" value={decision} />
          <fieldset disabled={pending || locked}>
            <legend>Appellate decision</legend>
            <label>
              <input
                type="radio"
                name="decision_choice"
                value="release"
                required
                checked={decision === "release"}
                onChange={() => setDecision("release")}
              />{" "}
              Release the exact candidate for explicit resubmission
            </label>
            <label>
              <input
                type="radio"
                name="decision_choice"
                value="uphold"
                required
                checked={decision === "uphold"}
                onChange={() => setDecision("uphold")}
              />{" "}
              Uphold the reviewed rejection
            </label>
          </fieldset>
        </>
      ) : null}
      <label>
        {operator ? "Private review reason" : "Private appeal statement"}
        <textarea
          name={operator ? "reason" : "statement"}
          required
          minLength={20}
          maxLength={operator ? 1000 : 2000}
          rows={5}
          readOnly={locked}
          value={reviewText}
          onChange={(event) => setReviewText(event.target.value)}
        />
      </label>
      {operator ? (
        <label>
          <input
            type="checkbox"
            name="confirmed_review"
            value="yes"
            required
            checked={confirmed}
            onChange={(event) => {
              if (!locked) setConfirmed(event.target.checked);
            }}
          />{" "}
          I reviewed the original candidate, context, rejection and sponsor’s statement.
        </label>
      ) : (
        <p className="quiet">
          Explain why this exact reviewed submission merits reconsideration. Do not include
          credentials or personal contact information. The statement is available only to trained
          operators.
        </p>
      )}
      <button
        type="submit"
        className="btn-primary"
        disabled={pending || !!state.receipt || state.retryable === false}
      >
        {pending
          ? "Submitting…"
          : state.retryable
            ? "Retry unchanged request"
            : operator
              ? "Record decision"
              : "Submit human appeal"}
      </button>
      {state.message ? <p role="status">{state.message}</p> : null}
      {state.receipt ? (
        <p>
          Receipt <code>{state.receipt.appeal_id}</code> · {state.receipt.state}
        </p>
      ) : null}
      {locked ? (
        <p>
          <a href={operator ? "/admin/appeals" : "/console/appeals"}>
            Reload the current case list
          </a>
        </p>
      ) : null}
    </form>
  );
}
