"use client";

import {
  COMMENTARY_RELATES_TO_KINDS,
  type CommentaryItem,
  type CommentaryRelatesToKind,
} from "@asimposium/contracts";
import Link from "next/link";
import { useActionState, useId, useState } from "react";
import { publicCommentaryHref } from "@/lib/commentary-page";
import { applyCommentaryAction, type CommentaryActionState } from "./commentary-actions";

const INITIAL_STATE: CommentaryActionState = { status: "idle" };
type ReferenceDraft = { key: string; kind: CommentaryRelatesToKind; id: string; label: string };

/** The same component stays mounted after a correction/removal, so an Agora
 * refresh cannot erase a durable receipt or invite an accidental second post. */
export function CommentaryEditor({
  sponsorId,
  problemId,
  initialAttemptId,
  publicCursor,
  item,
}: {
  readonly sponsorId: string;
  readonly problemId: string;
  readonly initialAttemptId: string;
  readonly publicCursor: number;
  readonly item?: CommentaryItem;
}) {
  const inputId = useId();
  const [attemptId, setAttemptId] = useState(initialAttemptId);
  const [body, setBody] = useState(item?.body ?? "");
  const [refs, setRefs] = useState<ReferenceDraft[]>(() =>
    (item?.relates_to ?? []).map((ref, i) => ({
      key: `initial-${i}`,
      kind: ref.kind,
      id: ref.id,
      label: ref.label ?? "",
    })),
  );
  const [state, formAction, pending] = useActionState(
    applyCommentaryAction.bind(null, sponsorId, {
      problemId,
      ...(item === undefined ? {} : { commentaryId: item.commentary_id }),
    }),
    INITIAL_STATE,
  );
  const uncertain = state.status === "refused" && state.uncertain && state.attemptId === attemptId;
  const postComplete =
    state.status === "committed" && state.action === "post" && state.attemptId === attemptId;
  const frozen = pending || Boolean(uncertain) || postComplete;
  const canCorrect =
    item === undefined || (!item.tombstoned && item.superseded_by_commentary_id === null);
  const updateReference = (key: string, update: Partial<ReferenceDraft>) => {
    if (!frozen)
      setRefs((current) => current.map((ref) => (ref.key === key ? { ...ref, ...update } : ref)));
  };

  const editor = (
    <form action={formAction} className="col gap-3">
      <input type="hidden" name="action" value="post" />
      <input type="hidden" name="attempt_id" value={attemptId} />
      <label htmlFor={`${inputId}-body`} className="font-semibold">
        {item === undefined ? "Public commentary" : "Corrected public commentary"}
      </label>
      <textarea
        id={`${inputId}-body`}
        name="body"
        rows={6}
        maxLength={2000}
        required
        value={body}
        readOnly={frozen}
        onChange={(event) => setBody(event.target.value)}
        aria-describedby={`${inputId}-limit`}
      />
      <p className="quiet text-sm" id={`${inputId}-limit`}>
        {body.trim().length} / 2,000 characters
      </p>
      <details>
        <summary>References (optional)</summary>
        {refs.map((ref, i) => (
          <fieldset key={ref.key} className="border p-3 my-2 col gap-2">
            <legend>Reference {i + 1}</legend>
            <label htmlFor={`${inputId}-${ref.key}-kind`}>Object kind</label>
            <select
              id={`${inputId}-${ref.key}-kind`}
              name="reference_kind"
              value={ref.kind}
              disabled={frozen}
              onChange={(event) =>
                updateReference(ref.key, { kind: event.target.value as CommentaryRelatesToKind })
              }
            >
              {COMMENTARY_RELATES_TO_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
            {frozen ? <input type="hidden" name="reference_kind" value={ref.kind} /> : null}
            <label htmlFor={`${inputId}-${ref.key}-id`}>Object ID</label>
            <input
              id={`${inputId}-${ref.key}-id`}
              name="reference_id"
              maxLength={64}
              value={ref.id}
              readOnly={frozen}
              onChange={(event) => updateReference(ref.key, { id: event.target.value })}
            />
            <label htmlFor={`${inputId}-${ref.key}-label`}>Label (optional)</label>
            <input
              id={`${inputId}-${ref.key}-label`}
              name="reference_label"
              maxLength={200}
              value={ref.label}
              readOnly={frozen}
              onChange={(event) => updateReference(ref.key, { label: event.target.value })}
            />
            <button
              type="button"
              className="btn-quiet"
              disabled={frozen}
              onClick={() => setRefs((current) => current.filter((entry) => entry.key !== ref.key))}
            >
              Remove reference {i + 1}
            </button>
          </fieldset>
        ))}
        <button
          type="button"
          className="btn-quiet"
          disabled={frozen || refs.length >= 10}
          onClick={() =>
            setRefs((current) => [
              ...current,
              { key: crypto.randomUUID(), kind: "claim", id: "", label: "" },
            ])
          }
        >
          Add reference
        </button>
      </details>
      {item === undefined ? null : (
        <p className="quiet text-sm">
          This publishes a new entry linked to {item.commentary_id}. The earlier entry remains in
          the history.
        </p>
      )}
      <button
        className="btn"
        type="submit"
        disabled={
          pending ||
          postComplete ||
          (Boolean(uncertain) && state.status === "refused" && state.action !== "post")
        }
      >
        {uncertain
          ? "Retry unchanged commentary"
          : item === undefined
            ? "Post public commentary"
            : "Publish correction"}
      </button>
    </form>
  );

  return (
    <div className="commentary-editor col gap-3">
      {canCorrect ? (
        item === undefined ? (
          editor
        ) : (
          <details>
            <summary>Correct your commentary</summary>
            {editor}
          </details>
        )
      ) : null}
      {item !== undefined && !item.tombstoned ? (
        <details>
          <summary>Remove your public text</summary>
          <form action={formAction} className="col gap-3 mt-2">
            <input type="hidden" name="action" value="tombstone" />
            <input type="hidden" name="attempt_id" value={attemptId} />
            <p>Removal leaves a visible record of this entry and preserves its attribution.</p>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                name="confirm_removal"
                value="yes"
                required
                disabled={pending}
              />
              <span>Remove the public text of {item.commentary_id}.</span>
            </label>
            <button
              className="btn-quiet"
              type="submit"
              disabled={
                pending ||
                (Boolean(uncertain) && state.status === "refused" && state.action !== "tombstone")
              }
            >
              {uncertain ? "Retry unchanged removal" : "Remove my public text"}
            </button>
          </form>
        </details>
      ) : null}
      {pending ? <p role="status">Waiting for the commentary receipt…</p> : null}
      {state.status === "refused" ? (
        <div role="alert">
          <p>
            <strong>{state.message}</strong>
          </p>
          {state.code ? (
            <p className="quiet">
              <code>{state.code}</code>
            </p>
          ) : null}
          {state.fixHint ? <p>{state.fixHint}</p> : null}
          {uncertain ? (
            <p>
              <Link
                href={`/p/${encodeURIComponent(problemId)}?commentary_cursor=${publicCursor}#commentary-heading`}
              >
                Check the public discussion
              </Link>
              . The draft stays unchanged here so a retry cannot create another copy.
            </p>
          ) : null}
        </div>
      ) : state.status === "committed" ? (
        <div role="status">
          <p>
            {state.receipt.tombstoned
              ? "This commentary entry is recorded and its public text has been removed."
              : state.receipt.supersedes_commentary_id
                ? "Your correction is published."
                : "Your commentary is published."}{" "}
            <Link href={publicCommentaryHref(problemId, state.receipt)}>
              View its public record
            </Link>
            .
          </p>
          {item === undefined && postComplete ? (
            <button
              className="btn-quiet"
              type="button"
              onClick={() => {
                setAttemptId(crypto.randomUUID());
                setBody("");
                setRefs([]);
              }}
            >
              Write another commentary
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
