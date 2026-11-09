"use client";

import type {
  ProblemFamousGuardrail,
  SponsorFellowSummary,
  SponsorProblemBrief,
} from "@asimposium/contracts";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import {
  PROBLEM_BRIEF_FORM_ERROR,
  type ProblemBriefAttempt,
  type ProblemBriefCommand,
  type ProblemBriefFields,
  problemBriefAttempt,
  problemBriefAttemptExpired,
  problemBriefFields,
  problemBriefRequest,
} from "@/lib/problem-briefs";
import { saveProblemBrief, withdrawProblemBrief } from "./problem-actions";

const EMPTY_GUARDRAIL: ProblemFamousGuardrail = {
  canonical_formulation: "",
  variant_distinctions: "",
  authoritative_references: [""],
  standing_banner: "",
};

/** Shared controls preserve the full brief for both creation and later edits. */
export function ProblemBriefFormFields({
  fields,
  fellows,
  disabled,
  onChange,
}: {
  readonly fields: ProblemBriefFields;
  readonly fellows: readonly SponsorFellowSummary[];
  readonly disabled: boolean;
  readonly onChange: (fields: ProblemBriefFields) => void;
}) {
  const id = useId();
  const [referenceKeys, setReferenceKeys] = useState(() =>
    (fields.famousGuardrail?.authoritative_references ?? []).map(
      (_, position) => `${id}-reference-${position}`,
    ),
  );
  const active = fellows.filter((fellow) => fellow.status === "active");
  const current = fellows.find((fellow) => fellow.fellow_id === fields.assignedFellowId);
  const missingFromActive =
    fields.assignedFellowId !== "" &&
    !active.some((fellow) => fellow.fellow_id === fields.assignedFellowId);
  const guardrail = fields.famousGuardrail;
  const changeGuardrail = (update: Partial<ProblemFamousGuardrail>) => {
    if (guardrail !== undefined)
      onChange({ ...fields, famousGuardrail: { ...guardrail, ...update } });
  };

  return (
    <fieldset disabled={disabled}>
      <legend className="sr-only">Private problem brief</legend>
      <label>
        Title
        <input
          name="title"
          value={fields.title}
          required
          maxLength={120}
          onChange={(event) => onChange({ ...fields, title: event.target.value })}
        />
      </label>
      <label>
        Statement
        <textarea
          name="statement"
          value={fields.statement}
          required
          rows={3}
          maxLength={8192}
          onChange={(event) => onChange({ ...fields, statement: event.target.value })}
        />
      </label>
      <label>
        Falsifier: what observation or construction would refute it?
        <textarea
          name="falsifier"
          value={fields.falsifier}
          required
          rows={2}
          maxLength={8192}
          onChange={(event) => onChange({ ...fields, falsifier: event.target.value })}
        />
      </label>
      <label>
        Motivation
        <textarea
          name="motivation"
          value={fields.motivation}
          required
          rows={2}
          maxLength={8192}
          onChange={(event) => onChange({ ...fields, motivation: event.target.value })}
        />
      </label>
      <fieldset aria-describedby={`${id}-boundaries`}>
        <legend>Research boundaries</legend>
        <p className="quiet" id={`${id}-boundaries`}>
          Optional: complete all three fields to specify what belongs in this problem and what would
          count as a successful result.
        </p>
        <label>
          Scope
          <textarea
            name="scope"
            value={fields.scope ?? ""}
            rows={2}
            maxLength={4096}
            onChange={(event) => onChange({ ...fields, scope: event.target.value })}
          />
        </label>
        <label>
          Out of scope
          <textarea
            name="out_of_scope"
            value={fields.outOfScope ?? ""}
            rows={2}
            maxLength={4096}
            onChange={(event) => onChange({ ...fields, outOfScope: event.target.value })}
          />
        </label>
        <label>
          Success criteria
          <textarea
            name="success_criteria"
            value={fields.successCriteria ?? ""}
            rows={2}
            maxLength={4096}
            onChange={(event) => onChange({ ...fields, successCriteria: event.target.value })}
          />
        </label>
      </fieldset>
      <label>
        Areas (comma-separated slugs, e.g. number-theory)
        <input
          name="areas"
          value={fields.areas}
          required
          onChange={(event) => onChange({ ...fields, areas: event.target.value })}
        />
      </label>
      <label>
        Assign to
        <select
          name="assigned_fellow_id"
          value={fields.assignedFellowId}
          onChange={(event) => onChange({ ...fields, assignedFellowId: event.target.value })}
        >
          <option value="">No Fellow yet</option>
          {missingFromActive ? (
            <option value={fields.assignedFellowId} disabled={current !== undefined}>
              {current === undefined
                ? `${fields.assignedFellowId} (current assignment; outside this roster page)`
                : `${current.name} (${current.status})`}
            </option>
          ) : null}
          {active.map((fellow) => (
            <option key={fellow.fellow_id} value={fellow.fellow_id}>
              {fellow.name}
            </option>
          ))}
        </select>
      </label>
      {current !== undefined && current.status !== "active" ? (
        <p className="quiet">
          This Fellow is no longer active. Choose an active Fellow or leave the brief unassigned
          before saving.
        </p>
      ) : active.length === 0 ? (
        <p className="quiet">
          No active Fellows are shown on this roster page. You can keep the current assignment or
          save an unassigned brief.
        </p>
      ) : null}
      <fieldset aria-describedby={`${id}-guardrail`}>
        <legend>Famous-problem guardrail</legend>
        <p className="quiet" id={`${id}-guardrail`}>
          For a named open problem, preserve its canonical formulation, the exact variant being
          investigated, authoritative references and the standing caution.
        </p>
        <label>
          <input
            name="include_famous_guardrail"
            type="checkbox"
            checked={guardrail !== undefined}
            onChange={(event) => {
              setReferenceKeys(
                event.target.checked ? [`${id}-reference-${crypto.randomUUID()}`] : [],
              );
              onChange({
                ...fields,
                famousGuardrail: event.target.checked
                  ? structuredClone(EMPTY_GUARDRAIL)
                  : undefined,
              });
            }}
          />
          Include a famous-problem guardrail
        </label>
        {guardrail === undefined ? null : (
          <>
            <label>
              Canonical formulation
              <textarea
                name="canonical_formulation"
                value={guardrail.canonical_formulation}
                required
                rows={3}
                maxLength={8192}
                onChange={(event) => changeGuardrail({ canonical_formulation: event.target.value })}
              />
            </label>
            <label>
              Distinctions from other variants
              <textarea
                name="variant_distinctions"
                value={guardrail.variant_distinctions}
                required
                rows={3}
                maxLength={8192}
                onChange={(event) => changeGuardrail({ variant_distinctions: event.target.value })}
              />
            </label>
            {referenceKeys.map((referenceKey, index) => (
              <div key={referenceKey}>
                <label>
                  Authoritative reference {index + 1}
                  <textarea
                    name={`authoritative_reference_${index}`}
                    value={guardrail.authoritative_references[index] ?? ""}
                    required
                    rows={2}
                    maxLength={1024}
                    onChange={(event) =>
                      changeGuardrail({
                        authoritative_references: guardrail.authoritative_references.map(
                          (value, position) => (position === index ? event.target.value : value),
                        ),
                      })
                    }
                  />
                </label>
                <button
                  type="button"
                  className="btn-quiet"
                  disabled={guardrail.authoritative_references.length === 1}
                  onClick={() => {
                    setReferenceKeys(referenceKeys.filter((key) => key !== referenceKey));
                    changeGuardrail({
                      authoritative_references: guardrail.authoritative_references.filter(
                        (_, position) => position !== index,
                      ),
                    });
                  }}
                >
                  Remove reference {index + 1}
                </button>
              </div>
            ))}
            <button
              type="button"
              className="btn-quiet"
              onClick={() => {
                setReferenceKeys([...referenceKeys, `${id}-reference-${crypto.randomUUID()}`]);
                changeGuardrail({
                  authoritative_references: [...guardrail.authoritative_references, ""],
                });
              }}
            >
              Add reference
            </button>
            <label>
              Standing banner
              <textarea
                name="standing_banner"
                value={guardrail.standing_banner}
                required
                rows={2}
                maxLength={1024}
                onChange={(event) => changeGuardrail({ standing_banner: event.target.value })}
              />
            </label>
          </>
        )}
      </fieldset>
    </fieldset>
  );
}

export function ProblemBriefEditor({
  sponsorId,
  fellows,
  brief,
  currentAvailable = true,
  onCommitted,
  onCancel,
}: {
  readonly sponsorId: string;
  readonly fellows: readonly SponsorFellowSummary[];
  readonly brief?: SponsorProblemBrief;
  readonly currentAvailable?: boolean;
  readonly onCommitted: (message: string) => void;
  readonly onCancel?: () => void;
}) {
  // Refreshing another card must not silently replace this editor's review pin
  // or discard the sponsor's local changes.
  const [source] = useState(() => (brief === undefined ? undefined : structuredClone(brief)));
  const firstActive = fellows.find((fellow) => fellow.status === "active")?.fellow_id ?? "";
  const [fields, setFields] = useState(() => problemBriefFields(source, firstActive));
  const [notice, setNotice] = useState<string | null>(null);
  const [retry, setRetry] = useState<ProblemBriefAttempt | null>(null);
  const [reloadRequired, setReloadRequired] = useState(false);
  const [withdrawConfirmed, setWithdrawConfirmed] = useState(false);
  const [pending, startTransition] = useTransition();
  const sending = useRef(false);
  const router = useRouter();
  const changedSinceOpen =
    source !== undefined &&
    (!currentAvailable ||
      brief === undefined ||
      brief.status !== "active" ||
      brief.version !== source.version);
  const expiredRetry = retry !== null && problemBriefAttemptExpired(retry);
  const frozen = pending || retry !== null || reloadRequired || changedSinceOpen;

  useEffect(() => {
    if (retry === null) return;
    const leave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, [retry]);

  function dispatch(command: ProblemBriefCommand, retained?: ProblemBriefAttempt) {
    // React's pending flag does not close the synchronous double-click window.
    if (sending.current) return;
    const attempt =
      retained ?? problemBriefAttempt(command, `console-brief-${crypto.randomUUID()}`);
    if (problemBriefAttemptExpired(attempt)) {
      setNotice(
        "The retry window has elapsed. Inspect the current brief list before starting another change; this page will not send an expired retry or replace its key.",
      );
      return;
    }
    sending.current = true;
    setRetry(attempt);
    setNotice(null);
    startTransition(async () => {
      try {
        const result =
          attempt.command.kind === "save"
            ? await saveProblemBrief(sponsorId, attempt.command.request, attempt.key)
            : await withdrawProblemBrief(
                sponsorId,
                attempt.command.id,
                attempt.command.expectedVersion,
                attempt.key,
                true,
              );
        if (result.ok) {
          setRetry(null);
          setWithdrawConfirmed(false);
          if (source === undefined) setFields(problemBriefFields(undefined, firstActive));
          // A replay is a historical receipt. Only a fresh console read says
          // whether the brief is currently active, adopted, withdrawn or edited.
          const message =
            attempt.command.kind === "save"
              ? "Brief save confirmed. The current brief list is being refreshed."
              : "Brief withdrawal confirmed. The current brief list is being refreshed.";
          onCommitted(message);
          try {
            router.refresh();
          } catch {
            // A client refresh failure cannot turn the durable receipt into
            // another uncertain mutation. The next console read reconciles it.
          }
          return;
        }
        if (result.recovery === "retry") {
          setRetry(attempt);
          setNotice(
            result.message +
              " Keep this page open and retry the same command before making other changes.",
          );
        } else {
          setRetry(null);
          setReloadRequired(result.recovery === "reload");
          setNotice(result.message);
        }
      } catch {
        setRetry(attempt);
        setNotice(
          "The change could not be confirmed. Keep this page open and retry the same command; its original contents and retry identity have been retained.",
        );
      } finally {
        sending.current = false;
      }
    });
  }

  return (
    <div>
      {source === undefined ? null : (
        <p className="quiet">
          Editing this private brief does not change an already adopted problem. The Fellow must
          adopt the current formulation before publication.
        </p>
      )}
      {changedSinceOpen ? (
        <p role="status">
          {currentAvailable
            ? "This brief changed after the editor opened. Your local edits remain visible; review the current brief before making a new change."
            : "This brief is not available in the latest active list. Your local edits and any unconfirmed command remain available here until you close the editor."}
        </p>
      ) : null}
      <form
        method="post"
        onSubmit={(event) => {
          event.preventDefault();
          if (frozen || sending.current) return;
          const assigned = fellows.find((fellow) => fellow.fellow_id === fields.assignedFellowId);
          if (assigned !== undefined && assigned.status !== "active") {
            setNotice("Choose one of your active Fellows or leave this brief unassigned.");
            return;
          }
          const request = problemBriefRequest(fields, source);
          if (request === null) {
            setNotice(PROBLEM_BRIEF_FORM_ERROR);
            return;
          }
          dispatch({ kind: "save", request });
        }}
      >
        <ProblemBriefFormFields
          fields={fields}
          fellows={fellows}
          disabled={frozen}
          onChange={setFields}
        />
        <div className="btn-row">
          <button className="btn-quiet" type="submit" disabled={frozen}>
            {pending ? "Saving…" : source === undefined ? "Save brief" : "Save brief changes"}
          </button>
          {onCancel === undefined ? null : (
            <button
              className="btn-quiet"
              type="button"
              disabled={pending || retry !== null}
              onClick={onCancel}
            >
              Cancel editing
            </button>
          )}
        </div>
      </form>
      {source === undefined ? null : (
        <details>
          <summary>Withdraw this brief</summary>
          <form
            method="post"
            onSubmit={(event) => {
              event.preventDefault();
              if (frozen || sending.current || !withdrawConfirmed) return;
              dispatch({ kind: "withdraw", id: source.id, expectedVersion: source.version });
            }}
          >
            <p>
              Withdrawal removes this brief from the Fellow&apos;s active assignments. It cannot
              withdraw an already adopted problem.
            </p>
            <label>
              <input
                name="confirm_withdrawal"
                type="checkbox"
                checked={withdrawConfirmed}
                disabled={frozen}
                onChange={(event) => setWithdrawConfirmed(event.target.checked)}
              />
              I confirm withdrawing this private brief.
            </label>
            <button className="btn-quiet" type="submit" disabled={frozen || !withdrawConfirmed}>
              Withdraw brief
            </button>
          </form>
        </details>
      )}
      {retry === null || pending ? null : (
        <p>
          <button
            className="btn-quiet"
            type="button"
            disabled={problemBriefAttemptExpired(retry)}
            onClick={() => dispatch(retry.command, retry)}
          >
            {retry.command.kind === "save" ? "Retry the same save" : "Retry the same withdrawal"}
          </button>
        </p>
      )}
      {(reloadRequired || changedSinceOpen || expiredRetry) && (retry === null || expiredRetry) ? (
        <p>
          <button
            className="btn-quiet"
            type="button"
            disabled={pending}
            onClick={() => {
              setRetry(null);
              setReloadRequired(false);
              setNotice(null);
              if (onCancel !== undefined) onCancel();
              else setFields(problemBriefFields(undefined, firstActive));
              router.refresh();
            }}
          >
            {expiredRetry
              ? "Discard expired retry and inspect current briefs"
              : "Reload current briefs and discard these edits"}
          </button>
        </p>
      ) : null}
      {notice === null ? null : (
        <p role="status" aria-live="polite">
          {notice}
        </p>
      )}
      <noscript>
        This private editor needs JavaScript. No change is confirmed until the saved result appears.
      </noscript>
    </div>
  );
}

export function EditableProblemBrief({
  sponsorId,
  brief,
  fellows,
  currentAvailable = true,
  onEditingChange,
  onCommitted,
}: {
  readonly sponsorId: string;
  readonly brief: SponsorProblemBrief;
  readonly fellows: readonly SponsorFellowSummary[];
  readonly currentAvailable?: boolean;
  readonly onEditingChange?: (editing: boolean) => void;
  readonly onCommitted: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const assignee = fellows.find((fellow) => fellow.fellow_id === brief.assigned_fellow_id);
  return (
    <li>
      <strong>{brief.title}</strong>{" "}
      <span className="quiet">
        {brief.assigned_fellow_id === undefined
          ? "not assigned"
          : `assigned to ${assignee?.name ?? brief.assigned_fellow_id}`}
      </span>
      {editing ? (
        <ProblemBriefEditor
          sponsorId={sponsorId}
          brief={brief}
          fellows={fellows}
          currentAvailable={currentAvailable}
          onCancel={() => {
            setEditing(false);
            onEditingChange?.(false);
          }}
          onCommitted={(message) => {
            setEditing(false);
            onEditingChange?.(false);
            onCommitted(message);
          }}
        />
      ) : brief.status !== "active" || !currentAvailable ? (
        <p className="quiet">This brief is no longer awaiting adoption.</p>
      ) : (
        <p>
          <button
            className="btn-quiet"
            type="button"
            onClick={() => {
              setEditing(true);
              onEditingChange?.(true);
            }}
          >
            Edit brief and assignment
          </button>
        </p>
      )}
    </li>
  );
}
