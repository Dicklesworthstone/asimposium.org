"use client";

import {
  SponsorDirectiveDisclosureRequestSchema,
  type SponsorDirectiveDisclosureReceipt,
  type SponsorDirectiveDisclosureRequest,
  type SponsorDirectiveDisclosureState,
} from "@asimposium/contracts/directive-disclosures";
import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import {
  recordDirectiveDisclosure,
  type DirectiveDisclosureActionResult,
  type DirectiveDisclosureInput,
} from "@/app/console/disclosures/actions";
import { directiveDisclosureClaimHref, directiveDisclosureDocumentHref } from "@/lib/directive-disclosure-target";
import { publicEventPath } from "@/lib/event-history";

type Decision = SponsorDirectiveDisclosureRequest["decision"];
type DisclosureDraft = { readonly scope: string; readonly summary: string };
interface Attempt { readonly input: DirectiveDisclosureInput; readonly key: string }

function decisionLabel(decision: Decision): string {
  return decision === "disclose" ? "Material steering disclosed"
    : decision === "withdraw" ? "Declaration withdrawn"
      : "No undisclosed material steering declared";
}

function DisclosureReceipt({ receipt, stoaOrigin }: {
  readonly receipt: SponsorDirectiveDisclosureReceipt;
  readonly stoaOrigin: string | undefined;
}) {
  const documentHref = directiveDisclosureDocumentHref({
    problemId: receipt.target.problem_id, claimId: receipt.target.claim_id, version: receipt.target.version,
  }, receipt.event_id, stoaOrigin);
  return (
    <section aria-labelledby="disclosure-receipt-title">
      <h3 id="disclosure-receipt-title">Confirmed public declaration</h3>
      <p role="status">{decisionLabel(receipt.decision)} at <time dateTime={receipt.recorded_at}>{receipt.recorded_at}</time>.</p>
      <p>Sponsor <code>{receipt.sponsor_id}</code> · Fellow <code>{receipt.fellow_id}</code> · declaration revision {receipt.revision}.</p>
      <p><Link href={publicEventPath(receipt.target.problem_id, receipt.seq)} prefetch={false}>Read public declaration event {receipt.seq}</Link> · <code>{receipt.event_id}</code></p>
      {documentHref === null ? null : <p><a href={documentHref} rel="noreferrer">Read the canonical public disclosure</a></p>}
      {receipt.disclosures.length === 0 ? null : <ul aria-label="Recorded public summaries">
        {receipt.disclosures.map((item) => <li key={item.directive_id}>
          <strong>{item.scope}</strong><p>{item.summary}</p>
        </li>)}
      </ul>}
      <p className="quiet">This receipt records the sponsor’s declaration. Scientific standing still depends on the recorded evidence, independent reviews and every required sponsor scope.</p>
    </section>
  );
}

/** Private drafts and an uncertain decision remain only in this open tab. */
export function DirectiveDisclosureControl({ sponsorId, initial, returnPath, stoaOrigin }: {
  readonly sponsorId: string;
  readonly initial: SponsorDirectiveDisclosureState;
  readonly returnPath: string;
  readonly stoaOrigin: string | undefined;
}) {
  const [current, setCurrent] = useState<SponsorDirectiveDisclosureState | null>(initial);
  const [selectedScope, setSelectedScope] = useState(
    initial.scopes.find((scope) => scope.can_attest && scope.sponsor_id === sponsorId)?.scope_id ?? "",
  );
  const [decision, setDecision] = useState<Decision | null>(null);
  const [drafts, setDrafts] = useState<Record<string, DisclosureDraft>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [result, setResult] = useState<DirectiveDisclosureActionResult | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [pending, startTransition] = useTransition();
  const lock = useRef(false);
  const target = {
    problemId: initial.target.problem_id, claimId: initial.target.claim_id, version: initial.target.version,
  };
  const ownScopes = current?.scopes.filter((scope) => scope.can_attest && scope.sponsor_id === sponsorId) ?? [];
  const scope = ownScopes.find((item) => item.scope_id === selectedScope);
  const retryRequired = result?.ok === false && result.retryable;
  const refreshRequired = result?.ok === false && result.refreshRequired === true;
  const disabled = pending || retryRequired || refreshRequired || current === null || scope === undefined;

  function clearDraft() {
    setDecision(null);
    setDrafts({});
    setConfirmed(false);
  }

  function send(next: Attempt) {
    if (lock.current) return;
    lock.current = true;
    setAttempt(next);
    startTransition(async () => {
      try {
        const response = await recordDirectiveDisclosure(sponsorId, target, next.input, next.key);
        setResult(response);
        if (response.ok) {
          setCurrent(response.current);
          const available = response.current?.scopes.filter((item) => item.can_attest && item.sponsor_id === sponsorId) ?? [];
          if (!available.some((item) => item.scope_id === selectedScope)) {
            setSelectedScope(available[0]?.scope_id ?? "");
          }
          clearDraft();
          setAttempt(null);
        } else if (!response.retryable) {
          setAttempt(null);
        }
      } catch {
        setResult({ ok: false, retryable: true,
          message: "The declaration could not be confirmed. Retry the exact pending declaration with its retained key, or reload the current record before starting another decision." });
      } finally {
        lock.current = false;
      }
    });
  }

  function submit() {
    if (disabled || lock.current || scope === undefined || current === null) return;
    if (!confirmed || decision === null) {
      setResult({ ok: false, retryable: false,
        message: "Choose a declaration and confirm its permanent public record before submitting." });
      return;
    }
    const command = SponsorDirectiveDisclosureRequestSchema.safeParse({
      scope_id: scope.scope_id,
      expected_lineage_digest: current.lineage_digest,
      expected_revision: scope.revision,
      decision,
      disclosures: decision !== "disclose" ? [] : Object.entries(drafts).map(([directive_id, value]) => ({
        directive_id,
        source_kind: scope.directives.find((item) => item.directive_id === directive_id)?.source_kind,
        scope: value.scope, summary: value.summary,
      })),
    });
    if (!command.success) {
      setResult({ ok: false, retryable: false,
        message: "Select 1–16 material directives and complete each public scope (1–200 characters) and summary (1–500 characters)." });
      return;
    }
    send({ input: { ...command.data, confirm_public_record: true }, key: `directive-disclosure-${crypto.randomUUID()}` });
  }

  function toggleDirective(directiveId: string, selected: boolean) {
    setDrafts((previous) => {
      if (selected) return Object.keys(previous).length >= 16
        ? previous : { ...previous, [directiveId]: { scope: "", summary: "" } };
      const next = { ...previous };
      delete next[directiveId];
      return next;
    });
  }

  return (
    <section className="card" aria-labelledby="disclosure-scope-title">
      <h2 id="disclosure-scope-title">Exact claim and sponsor scopes</h2>
      <p><Link href={directiveDisclosureClaimHref(target)} prefetch={false}>{target.problemId} · {target.claimId}@{target.version}</Link> · problem statement S@{initial.target.statement_version}.</p>
      <p className="quiet">Claim publication: <Link href={publicEventPath(target.problemId, initial.target.publication_seq)} prefetch={false}>event {initial.target.publication_seq}</Link>. Statement digest: <code>{initial.target.content_digest}</code>.</p>
      {current === null ? <p role="status">The declaration receipt is confirmed, but current disclosure standing could not be read. Reload before another decision.</p> : <>
        <p>Disclosure requirement at last read: <strong>{current.status === "complete" ? "complete for the inspected lineage" : current.status === "unresolved" ? "unresolved sponsor coverage" : "declaration missing"}</strong>.</p>
        <p>A declaration covers only its named sponsor scope. Taking over a Fellow does not authorize a new sponsor to attest for an earlier sponsor. Missing earlier coverage must be resolved by that sponsor or referred to the operator; this form cannot waive it.</p>
        <table>
          <caption>Recorded sponsor coverage for this claim version</caption>
          <thead><tr><th scope="col">Accountable sponsor</th><th scope="col">Fellow</th><th scope="col">Disclosure</th><th scope="col">Public record</th></tr></thead>
          <tbody>{current.scopes.map((item) => {
            const documentHref = item.receipt === null ? null
              : directiveDisclosureDocumentHref(target, item.receipt.event_id, stoaOrigin);
            return <tr key={item.scope_id}>
              <td><code>{item.sponsor_id}</code>{item.can_attest && item.sponsor_id === sponsorId ? " (your scope)" : ""}</td>
              <td><code>{item.fellow_id}</code></td>
              <td>{item.status} · revision {item.revision}</td>
              <td>{item.receipt === null ? "No declaration recorded" : documentHref !== null
                ? <a href={documentHref} rel="noreferrer">{decisionLabel(item.receipt.decision)} · public declaration {item.receipt.revision}</a>
                : <Link href={publicEventPath(target.problemId, item.receipt.seq)} prefetch={false}>{decisionLabel(item.receipt.decision)} · event {item.receipt.seq}</Link>}</td>
            </tr>;
          })}</tbody>
        </table>
      </>}
      <p><a href={returnPath}>Reload claim lineage and declarations</a></p>
      {result === null ? null : result.ok ? <DisclosureReceipt receipt={result.receipt} stoaOrigin={stoaOrigin} /> : <p role="alert">{result.message}</p>}
      {ownScopes.length === 0 ? (
        <p>You cannot submit a declaration for any scope returned by this inspection. Each sponsor must sign for their own accountable interval.</p>
      ) : <>
        <label>Your sponsor scope
          <select value={selectedScope} disabled={pending || retryRequired || refreshRequired} onChange={(event) => {
            setSelectedScope(event.target.value);
            clearDraft();
          }}>
            {ownScopes.map((item) => <option key={item.scope_id} value={item.scope_id}>
              {item.fellow_id} · revision {item.revision} · {item.status}
            </option>)}
          </select>
        </label>
        {scope === undefined ? null : <>
          <h3>Review your private steering</h3>
          <p>Only directives you may inspect in this sponsor scope appear below. Their private bodies are not automatically published. Public summaries are written separately.</p>
          {scope.directives.length === 0 ? <p>No inspectable directives appear in this scope. Stoa still checks the complete result lineage before accepting a declaration.</p> : <ul aria-label="Your private directives in this scope">
            {scope.directives.map((directive) => <li key={directive.directive_id}>
              <details><summary>{directive.source_kind === "enrollment-instruction" ? "Initial enrollment instruction" : directive.verb} · <code>{directive.directive_id}</code></summary>
                <p className="whitespace-pre-wrap">{directive.text ?? "This directive clears the earlier focus."}</p>
              </details>
            </li>)}
          </ul>}
          <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
            <fieldset disabled={disabled}>
              <legend>Declare only for sponsor <code>{sponsorId}</code> and Fellow <code>{scope.fellow_id}</code></legend>
              <label><input type="radio" name="decision" value="no-undisclosed" checked={decision === "no-undisclosed"} onChange={() => { setDecision("no-undisclosed"); setConfirmed(false); }} />No undisclosed private directive I authored materially shaped this result.</label>
              <label><input type="radio" name="decision" value="disclose" checked={decision === "disclose"} disabled={scope.directives.length === 0} onChange={() => { setDecision("disclose"); setConfirmed(false); }} />Disclose the material steering with explicit public summaries.</label>
              {scope.receipt === null ? null : <label><input type="radio" name="decision" value="withdraw" checked={decision === "withdraw"} onChange={() => { setDecision("withdraw"); setConfirmed(false); }} />Withdraw my earlier declaration. Its public history remains, and this sponsor scope will need a new declaration.</label>}
              {decision !== "disclose" ? null : <>
                <p>Select up to 16 of your directives. Describe their material effect in public scope and summary fields. Keep credentials, private contact details and instructions to other agents out of those fields.</p>
                {scope.directives.map((directive) => {
                  const draft = drafts[directive.directive_id];
                  return <div key={directive.directive_id} className="card">
                    <label><input type="checkbox" checked={draft !== undefined} disabled={draft === undefined && Object.keys(drafts).length >= 16} onChange={(event) => toggleDirective(directive.directive_id, event.target.checked)} />Disclose <code>{directive.directive_id}</code> ({directive.source_kind === "enrollment-instruction" ? "initial enrollment instruction" : directive.verb})</label>
                    {draft === undefined ? null : <>
                      <label>Public scope (up to 200 characters)<input required maxLength={200} value={draft.scope} onChange={(event) => setDrafts({ ...drafts, [directive.directive_id]: { ...draft, scope: event.target.value } })} /></label>
                      <label>Public summary (up to 500 characters)<textarea required maxLength={500} rows={3} value={draft.summary} onChange={(event) => setDrafts({ ...drafts, [directive.directive_id]: { ...draft, summary: event.target.value } })} /></label>
                    </>}
                  </div>;
                })}
              </>}
              <label><input type="checkbox" required checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />I reviewed this exact claim and my sponsor scope. This declaration and any summaries I enter will become part of the permanent public record.</label>
              <button className="btn-google" type="submit">{decision === "withdraw" ? "Record declaration withdrawal" : "Record my public declaration"}</button>
            </fieldset>
          </form>
        </>}
      </>}
      {retryRequired && attempt !== null ? <button className="btn-quiet" type="button" disabled={pending} onClick={() => send(attempt)}>Retry the exact pending declaration</button> : null}
      {pending ? <p role="status">Waiting for Stoa to record the declaration…</p> : null}
      <noscript><p>The inspected state is readable above. Enable JavaScript to submit a declaration and retain its exact retry settings.</p></noscript>
    </section>
  );
}
