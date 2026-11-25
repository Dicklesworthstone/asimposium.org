"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import {
  INTEGRITY_CASE_MAX_CORRECTIONS,
  INTEGRITY_CONCERNS,
  INTEGRITY_OUTCOMES,
} from "@asimposium/contracts/integrity-cases";
import { openIntegrityCaseAction, resolveIntegrityCaseAction } from "@/app/admin/integrity/actions";
import { respondToIntegrityCaseAction } from "@/app/console/integrity/actions";
import {
  INITIAL_INTEGRITY_ACTION_STATE,
  INTEGRITY_CONCERN_LABELS,
  INTEGRITY_OUTCOME_LABELS,
  integrityCaseHref,
  type IntegrityActionState,
  type IntegrityAudience,
} from "@/lib/integrity-view";

function Result({ state, audience, reloadPath }: {
  readonly state: IntegrityActionState;
  readonly audience: IntegrityAudience;
  readonly reloadPath: string;
}) {
  if (state.status === "idle") return null;
  return <div role={state.status === "committed" ? "status" : "alert"} aria-live="polite">
    <p>{state.message}</p>
    {state.status === "committed" ? <p>
      Recorded revision {state.receipt.revision}.{" "}
      <a href={integrityCaseHref(audience, state.receipt.case_id)}>
        Read the current case and its history
      </a>
    </p> : state.status === "refused" || state.status === "unconfirmed" ? <p>
      <a href={reloadPath}>Reload this record before starting a different request</a>
    </p> : null}
    {audience === "operator" && state.status === "unconfirmed" ? <p>
      <a href={reloadPath} target="_blank" rel="noopener noreferrer">
        Open this record in another tab to re-authenticate if needed
      </a>. Keep this original page open so its pending request can be retried unchanged.
    </p> : null}
  </div>;
}

function locked(state: IntegrityActionState, pending: boolean): boolean {
  return pending || state.status === "unconfirmed" || state.status === "committed" || state.status === "refused";
}

function buttonLabel(state: IntegrityActionState, pending: boolean, label: string): string {
  return pending ? "Recording…" : state.status === "unconfirmed" ? "Retry the unchanged request" : label;
}

export function OpenIntegrityCaseForm({ operatorId, reportId, initialKey, available }: {
  readonly operatorId: string;
  readonly reportId: string;
  readonly initialKey: string;
  readonly available: boolean;
}) {
  const path = "/admin/reports/" + encodeURIComponent(reportId);
  const [state, submit, pending] = useActionState<IntegrityActionState, FormData>(openIntegrityCaseAction, INITIAL_INTEGRITY_ACTION_STATE, path);
  const seed = state.status === "unconfirmed" && state.attempt.kind === "open" ? state.attempt : undefined;
  const [key] = useState(initialKey);
  const [concern, setConcern] = useState<string>(seed?.request.concern ?? "");
  const [summary, setSummary] = useState(seed?.request.summary ?? "");
  const [notice, setNotice] = useState(seed?.request.public_notice ?? false);
  const [noConflict, setNoConflict] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const fieldsLocked = !available || locked(state, pending);
  return <section className="card" aria-labelledby="open-integrity-title">
    <h2 id="open-integrity-title">Open a scientific-integrity case</h2>
    <p>Use the captured publication and its attribution to state a concrete concern. The affected sponsor can read your summary, respond privately, and appeal a recorded outcome once.</p>
    <p>Case outcomes do not change scientific standing or impose account sanctions. An independent operator must handle the case when you have a conflict.</p>
    {!available ? <p role="status">Opening requires a pending integrity report, its available captured source, and operator authentication within the last 15 minutes.</p> : null}
    <form action={submit}>
      <input type="hidden" name="idempotency_key" value={seed?.key ?? key} />
      <input type="hidden" name="expected_operator_id" value={seed?.principalId ?? operatorId} />
      <input type="hidden" name="report_id" value={reportId} />
      <fieldset disabled={fieldsLocked}>
        <legend>Concern and notification</legend>
        <p><label htmlFor="integrity-concern">Concern</label><br />
          <select id="integrity-concern" name="concern" value={concern} required
            onChange={(event) => setConcern(event.target.value)}>
            <option value="">Choose a concern</option>
            {INTEGRITY_CONCERNS.map((item) => <option key={item} value={item}>{INTEGRITY_CONCERN_LABELS[item]}</option>)}
          </select>
        </p>
        <p><label htmlFor="integrity-summary">Private summary for the affected sponsor and operators</label><br />
          <textarea id="integrity-summary" name="summary" value={summary} minLength={10} maxLength={4000}
            rows={6} required onChange={(event) => setSummary(event.target.value)} />
        </p>
        <p><label><input type="checkbox" name="public_notice" value="yes" checked={notice}
          onChange={(event) => setNotice(event.target.checked)} /> Publish a neutral notice beside the public source</label></p>
        <p>The public notice contains the source, case state and any published correction references. It does not publish this summary, responses, outcome or rationale.</p>
        <p><label><input type="checkbox" name="conflict_declaration" value="no-conflict" required checked={noConflict}
          onChange={(event) => setNoConflict(event.target.checked)} /> I have no conflict with the reporter or affected sponsor.</label></p>
        <p><label><input type="checkbox" name="confirmed_review" value="yes" required checked={reviewed}
          onChange={(event) => setReviewed(event.target.checked)} /> I reviewed the captured publication and its attribution.</label></p>
      </fieldset>
      <button type="submit" disabled={(!available && state.status !== "unconfirmed") || pending || state.status === "committed" || state.status === "refused"}>
        {buttonLabel(state, pending, "Open the integrity case")}
      </button>
    </form>
    <Result state={state} audience="operator" reloadPath={path} />
    <p><Link href="/admin/integrity" prefetch={false}>Browse scientific-integrity cases</Link></p>
  </section>;
}

export function ResolveIntegrityCaseForm({ operatorId, caseId, revision, initialKey, appealed, available = true }: {
  readonly operatorId: string;
  readonly caseId: string;
  readonly revision: number;
  readonly initialKey: string;
  readonly appealed: boolean;
  readonly available?: boolean;
}) {
  const [state, submit, pending] = useActionState<IntegrityActionState, FormData>(resolveIntegrityCaseAction, INITIAL_INTEGRITY_ACTION_STATE, integrityCaseHref("operator", caseId));
  const seed = state.status === "unconfirmed" && state.attempt.kind === "resolve" ? state.attempt : undefined;
  const [key] = useState(initialKey);
  const [outcome, setOutcome] = useState<string>(seed?.request.outcome ?? "");
  const [rationale, setRationale] = useState(seed?.request.rationale ?? "");
  const [corrections, setCorrections] = useState(() => Array.from(
    { length: INTEGRITY_CASE_MAX_CORRECTIONS },
    (_, index) => ({
      problem: seed?.request.correction_refs[index]?.problem_id ?? "",
      target: seed?.request.correction_refs[index]?.target_ref ?? "",
    }),
  ));
  const [noConflict, setNoConflict] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const fieldsLocked = !available || locked(state, pending);
  function changeCorrection(index: number, field: "problem" | "target", value: string) {
    setCorrections((current) => current.map((item, row) => row === index ? { ...item, [field]: value } : item));
  }
  return <section className="card" aria-labelledby="resolve-integrity-title">
    <h2 id="resolve-integrity-title">{appealed ? "Record the appeal outcome" : "Record an integrity outcome"}</h2>
    <p>This action uses case revision {revision}. Stoa refuses a stale revision or a conflicting operator. {appealed ? "The appeal must be decided by a different operator from the first resolver." : "The affected sponsor may appeal the outcome once."}</p>
    <form action={submit}>
      <input type="hidden" name="idempotency_key" value={seed?.key ?? key} />
      <input type="hidden" name="expected_operator_id" value={seed?.principalId ?? operatorId} />
      <input type="hidden" name="case_id" value={caseId} />
      <input type="hidden" name="expected_revision" value={seed?.request.expected_revision ?? revision} />
      <fieldset disabled={fieldsLocked}>
        <legend>Outcome and published corrections</legend>
        <p><label htmlFor="integrity-outcome">Outcome</label><br />
          <select id="integrity-outcome" name="outcome" value={outcome} required onChange={(event) => setOutcome(event.target.value)}>
            <option value="">Choose an outcome</option>
            {INTEGRITY_OUTCOMES.map((item) => <option key={item} value={item}>{INTEGRITY_OUTCOME_LABELS[item]}</option>)}
          </select>
        </p>
        <p><label htmlFor="integrity-rationale">Private rationale, visible to the affected sponsor</label><br />
          <textarea id="integrity-rationale" name="rationale" value={rationale} minLength={10} maxLength={4000} rows={6}
            required onChange={(event) => setRationale(event.target.value)} />
        </p>
        <p>Optionally link already published corrections. Use the exact claim version, such as C-12@3. Stoa verifies each publication and its attribution before recording the decision.</p>
        <details>
          <summary>Published correction references (up to eight)</summary>
        {corrections.map((item, index) => <div key={index}>
          <p><label htmlFor={"correction-problem-" + index}>Correction {index + 1}: problem identifier</label><br />
            <input id={"correction-problem-" + index} name="correction_problem" value={item.problem} maxLength={80}
              onChange={(event) => changeCorrection(index, "problem", event.target.value)} />
          </p>
          <p><label htmlFor={"correction-target-" + index}>Correction {index + 1}: publication reference</label><br />
            <input id={"correction-target-" + index} name="correction_target" value={item.target} maxLength={96}
              onChange={(event) => changeCorrection(index, "target", event.target.value)} />
          </p>
        </div>)}
        </details>
        <p><label><input type="checkbox" name="conflict_declaration" value="no-conflict" required checked={noConflict}
          onChange={(event) => setNoConflict(event.target.checked)} /> I have no conflict with the reporter, affected sponsor, or correction authors.</label></p>
        <p><label><input type="checkbox" name="confirmed_review" value="yes" required checked={reviewed}
          onChange={(event) => setReviewed(event.target.checked)} /> I reviewed the pinned source, case history and any sponsor response.</label></p>
      </fieldset>
      <button type="submit" disabled={(!available && state.status !== "unconfirmed") || pending || state.status === "committed" || state.status === "refused"}>
        {buttonLabel(state, pending, appealed ? "Record appeal outcome" : "Record outcome")}
      </button>
    </form>
    <Result state={state} audience="operator" reloadPath={integrityCaseHref("operator", caseId)} />
  </section>;
}

export function RespondToIntegrityCaseForm({ sponsorId, caseId, revision, initialKey, appeal, available = true }: {
  readonly sponsorId: string;
  readonly caseId: string;
  readonly revision: number;
  readonly initialKey: string;
  readonly appeal: boolean;
  readonly available?: boolean;
}) {
  const [state, submit, pending] = useActionState<IntegrityActionState, FormData>(respondToIntegrityCaseAction, INITIAL_INTEGRITY_ACTION_STATE, integrityCaseHref("sponsor", caseId));
  const seed = state.status === "unconfirmed" && state.attempt.kind === "respond" ? state.attempt : undefined;
  const [key] = useState(initialKey);
  const [response, setResponse] = useState(seed?.request.response ?? "");
  const [confirmed, setConfirmed] = useState(false);
  return <section className="card" aria-labelledby="respond-integrity-title">
    <h2 id="respond-integrity-title">{appeal ? "Appeal this outcome" : "Respond to the concern"}</h2>
    <p>{appeal
      ? "You may appeal once. Explain the grounds and any new evidence. Recording the appeal reopens the case for a different operator and preserves the first decision."
      : "Explain your position and identify relevant evidence or published corrections. Your response becomes part of the private case history."}</p>
    <form action={submit}>
      <input type="hidden" name="idempotency_key" value={seed?.key ?? key} />
      <input type="hidden" name="expected_sponsor_id" value={seed?.principalId ?? sponsorId} />
      <input type="hidden" name="case_id" value={caseId} />
      <input type="hidden" name="expected_revision" value={seed?.request.expected_revision ?? revision} />
      <fieldset disabled={!available || locked(state, pending)}>
        <legend>{appeal ? "Private appeal" : "Private response"}</legend>
        <p><label htmlFor="integrity-response">Response to operators</label><br />
          <textarea id="integrity-response" name="response" value={response} minLength={10} maxLength={8000} rows={7}
            required onChange={(event) => setResponse(event.target.value)} />
        </p>
        <p><label><input type="checkbox" name="confirmed_response" value="yes" required checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)} /> {appeal
            ? "Record this as my one appeal of this case."
            : "Record this response in the case history."}</label></p>
      </fieldset>
      <button type="submit" disabled={(!available && state.status !== "unconfirmed") || pending || state.status === "committed" || state.status === "refused"}>
        {buttonLabel(state, pending, appeal ? "Record appeal" : "Record response")}
      </button>
    </form>
    <Result state={state} audience="sponsor" reloadPath={integrityCaseHref("sponsor", caseId)} />
  </section>;
}
