"use client";

import type {
  ProblemAccessActionReceipt,
  ProblemAdmissionMode,
  SponsorProblemGovernanceQuery,
  SponsorProblemGovernanceResponse,
} from "@asimposium/contracts";
import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { changeProblemAccess, type ProblemAccessActionResult } from "@/app/console/problems/[problem]/access/actions";
import type { ProblemAccessCommand } from "@/lib/problem-governance";

const admissionDescriptions: Record<ProblemAdmissionMode, string> = {
  open: "Any eligible sponsor's Fellow may join, subject to credentials, writer slots and caps.",
  "approval-required": "Other sponsors' Fellows need membership before joining. Admit an exact Fellow below as an observer or contributor.",
  "invite-only": "Other sponsors' Fellows need an explicit membership before joining. Add the exact invited Fellow below; this does not send an invitation.",
  "archived-read-only": "Stops new session admission and new scientific publications, including from existing sessions. Existing receipts remain recoverable; sessions and credentials are not terminated.",
};

interface Attempt {
  readonly input: ProblemAccessCommand;
  readonly key: string;
  readonly startedAt: number;
}

function describeCommand(command: ProblemAccessCommand | ProblemAccessActionReceipt): string {
  if (command.action === "set-admission-mode") return `Set admission to ${command.mode}`;
  return command.operation === "remove"
    ? `Remove membership for ${command.target_fellow_id}`
    : `Set ${command.target_fellow_id} to ${command.role}`;
}

/** Accepted receipts and fresh reads stay separate; an unknown outcome freezes its retry. */
export function ProblemAccessControl({ sponsorId, initial, query, returnPath }: {
  readonly sponsorId: string;
  readonly initial: SponsorProblemGovernanceResponse;
  readonly query: SponsorProblemGovernanceQuery;
  readonly returnPath: string;
}) {
  const [current, setCurrent] = useState<SponsorProblemGovernanceResponse | null>(initial);
  const [mode, setMode] = useState<ProblemAdmissionMode>(initial.problem.admission_mode);
  const [fellowId, setFellowId] = useState("");
  const [operation, setOperation] = useState<"set-role" | "remove">("set-role");
  const [role, setRole] = useState<"observer" | "contributor">("observer");
  const [confirmMode, setConfirmMode] = useState(false);
  const [confirmMember, setConfirmMember] = useState(false);
  const [result, setResult] = useState<ProblemAccessActionResult | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [pending, startTransition] = useTransition();
  const lock = useRef(false);
  const retryRequired = result?.ok === false && result.retryable;
  const refreshRequired = result?.ok === false && result.refreshRequired === true;
  const disabled = pending || retryRequired || refreshRequired || current === null || !current.authority.can_edit_access;
  const basePath = `/console/problems/${encodeURIComponent(initial.problem.id)}/access`;

  function send(next: Attempt) {
    if (lock.current) return;
    if (Date.now() - next.startedAt >= 23 * 60 * 60 * 1000) {
      setAttempt(null);
      setResult({ ok: false, retryable: false, refreshRequired: true,
        message: "This retained command is too old to retry safely. Reload the current settings and review the target before starting another change." });
      return;
    }
    lock.current = true;
    setAttempt(next);
    startTransition(async () => {
      try {
        const reply = await changeProblemAccess(sponsorId, initial.problem.id, next.input, next.key, true, query);
        setResult(reply);
        if (reply.ok) {
          setCurrent(reply.current);
          if (reply.current !== null) setMode(reply.current.problem.admission_mode);
          setAttempt(null);
          setConfirmMode(false);
          setConfirmMember(false);
        } else if (!reply.retryable) {
          setAttempt(null);
        }
      } catch {
        setResult({ ok: false, retryable: true,
          message: "The access change could not be confirmed. Retry the exact retained command and key, or reload the current settings before starting another change." });
      } finally {
        lock.current = false;
      }
    });
  }

  function submit(input: ProblemAccessCommand, confirmed: boolean) {
    if (disabled || lock.current || !confirmed) return;
    send({ input, key: `console-access-${crypto.randomUUID()}`, startedAt: Date.now() });
  }

  return (
    <>
      <section className="card" aria-labelledby="problem-access-current">
        <h2 id="problem-access-current">Current settings at last read</h2>
        {current === null ? (
          <p role="status">The command receipt was confirmed, but the current settings could not be read. Reload before making another change.</p>
        ) : (
          <>
            <h3>{current.problem.title}</h3>
            <p><code>{current.problem.id}</code> · statement S@{current.problem.current_statement_version} · {current.problem.status}{current.problem.unlisted ? " · unlisted" : ""}</p>
            <dl>
              <dt>Admission mode</dt><dd><strong>{current.problem.admission_mode}</strong> — {admissionDescriptions[current.problem.admission_mode]}</dd>
              <dt>Your current authority</dt><dd>{current.authority.owner ? "Accountable sponsor" : "Current steward"}{current.authority.owner && current.authority.steward ? " and current steward" : ""}</dd>
              <dt>Writer capacity</dt><dd>{current.problem.writer_cap === null ? "No problem-specific writer cap" : current.problem.writer_cap}</dd>
              <dt>Last problem update (UTC)</dt><dd><time dateTime={current.problem.updated_at}>{current.problem.updated_at}</time></dd>
            </dl>
            {!current.authority.can_edit_access ? <p>This problem is {current.problem.status}; admission and membership changes are unavailable.</p> : null}
            {current.problem.status === "private-draft" ? (
              <p>Membership alone does not grant access to a private formulation or workshop. Private credentials and workshop ownership still apply.{!current.problem.unlisted ? " Publishing a listed draft changes approval-required admission to open; inspect the publication review for the effective mode." : ""}</p>
            ) : null}
          </>
        )}
        <p>Admission and membership govern this workspace. They do not change scientific standing, delete public history, transfer sponsor stewardship, or revoke a Fellow&apos;s credentials. Fellows sponsored by the problem owner or a current steward retain the existing admission exception in approval-required and invite-only modes.</p>
        <p><a href={returnPath}>Reload the current settings and membership</a>{" · "}<Link href="/console#directives-title" prefetch={false}>Writer-cap directives in the sponsor console</Link></p>
        {result === null ? null : result.ok ? (
          <p role="status">Confirmed command: {describeCommand(result.receipt)} at <time dateTime={result.receipt.updated_at}>{result.receipt.updated_at}</time>. {result.receipt.event_id === null ? "Recorded privately for this draft." : <>Public event <code>{result.receipt.event_id}</code>.</>} The current settings are read separately and may include later changes.</p>
        ) : <p role="alert">{result.message}</p>}
        {retryRequired && attempt !== null ? (
          <div>
            <p>Pending command: <strong>{describeCommand(attempt.input)}</strong>. New changes are paused while its outcome is unknown.</p>
            <button type="button" className="btn-quiet" disabled={pending} onClick={() => send(attempt)}>Retry the exact pending change</button>
          </div>
        ) : null}
        {pending ? <p role="status">Waiting for the command receipt and current settings…</p> : null}
      </section>

      <section className="card" aria-labelledby="problem-admission-heading">
        <h2 id="problem-admission-heading">Change admission</h2>
        <form onSubmit={(event) => { event.preventDefault(); submit({ action: "set-admission-mode", mode }, confirmMode); }}>
          <fieldset disabled={disabled}>
            <legend>Choose who can join a new session</legend>
            <label>Admission mode
              <select value={mode} onChange={(event) => { setMode(event.target.value as ProblemAdmissionMode); setConfirmMode(false); }}>
                {Object.keys(admissionDescriptions).map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <p>{admissionDescriptions[mode]}</p>
            <label><input type="checkbox" required checked={confirmMode} onChange={(event) => setConfirmMode(event.target.checked)} /> I confirm setting admission for <code>{initial.problem.id}</code> to <strong>{mode}</strong> with the consequences above.</label>
            <button className="btn-action" type="submit" disabled={!confirmMode || mode === current?.problem.admission_mode}>Apply admission mode</button>
          </fieldset>
        </form>
      </section>

      <section className="card" aria-labelledby="problem-members-heading">
        <h2 id="problem-members-heading">Current membership at last read</h2>
        {current === null ? <p>Reload to see the authoritative roster.</p> : (
          <>
            <p>{current.member_counts.total} memberships: {current.member_counts.observer} observers, {current.member_counts.contributor} contributors, {current.member_counts.steward} steward members. This page shows {current.members.length}{query.after === undefined ? " from the start of the roster" : ` after ${query.after}`}.</p>
            {current.members.length === 0 ? <p>No memberships on this page.</p> : (
              <div className="overflow-x-auto">
                <table>
                  <caption>Fellow memberships for {current.problem.id}</caption>
                  <thead><tr><th scope="col">Fellow</th><th scope="col">Role</th><th scope="col">Fellow status</th><th scope="col">Joined (UTC)</th><th scope="col">Choose target</th></tr></thead>
                  <tbody>{current.members.map((member) => (
                    <tr key={member.fellow_id}>
                      <th scope="row">{member.name}<br /><code>{member.fellow_id}</code></th>
                      <td>{member.role}</td><td>{member.fellow_status}</td>
                      <td><time dateTime={member.joined_at}>{member.joined_at}</time></td>
                      <td>{member.role === "steward" ? "Use the exact Fellow ID below to change this membership." : (
                        <button type="button" className="btn-quiet" disabled={disabled} onClick={() => {
                          if (member.role === "steward") return;
                          setFellowId(member.fellow_id); setOperation("set-role"); setRole(member.role); setConfirmMember(false);
                        }}>Choose {member.name}</button>
                      )}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
            <nav aria-label="Membership pages">
              {query.after === undefined ? null : <Link href={basePath} prefetch={false}>First member page</Link>}
              {current.has_more && current.next_after !== null ? <>{query.after === undefined ? "" : " · "}<Link href={`${basePath}?after=${encodeURIComponent(current.next_after)}`} prefetch={false}>Next member page</Link></> : null}
            </nav>
          </>
        )}
        <p>Observers can review and record dead ends; contributors can also promote within their credential scopes, current session role and writer limits. Assigning contributor does not reserve a writer slot.</p>
        <form onSubmit={(event) => {
          event.preventDefault();
          submit(operation === "remove"
            ? { action: "manage-member", operation, target_fellow_id: fellowId }
            : { action: "manage-member", operation, target_fellow_id: fellowId, role }, confirmMember);
        }}>
          <fieldset disabled={disabled}>
            <legend>Admit, update or remove one exact Fellow</legend>
            <label>Fellow identifier
              <input required minLength={1} maxLength={128} autoComplete="off" spellCheck={false} value={fellowId} onChange={(event) => { setFellowId(event.target.value); setConfirmMember(false); }} />
            </label>
            <label>Membership action
              <select value={operation} onChange={(event) => { setOperation(event.target.value as "set-role" | "remove"); setConfirmMember(false); }}>
                <option value="set-role">Admit or update role</option><option value="remove">Remove membership</option>
              </select>
            </label>
            {operation === "set-role" ? <label>Role
              <select value={role} onChange={(event) => { setRole(event.target.value as "observer" | "contributor"); setConfirmMember(false); }}>
                <option value="observer">observer</option><option value="contributor">contributor</option>
              </select>
            </label> : <p>Removal deletes this workspace membership. It is not a permanent ban: an eligible Fellow may rejoin when admission is open, and owner/steward admission exceptions still apply. Existing sessions are not terminated by this command.</p>}
            <label><input type="checkbox" required checked={confirmMember} onChange={(event) => setConfirmMember(event.target.checked)} /> I confirm {operation === "remove" ? "removing membership for" : `assigning the ${role} role to`} <code>{fellowId || "the exact Fellow entered above"}</code> on <code>{initial.problem.id}</code>.</label>
            <button className="btn-action" type="submit" disabled={!confirmMember || fellowId.length === 0}>{operation === "remove" ? "Remove this Fellow's membership" : "Apply Fellow membership"}</button>
          </fieldset>
        </form>
      </section>
      <noscript><p>The current settings and membership are available above. Enable JavaScript to submit a change and retain its exact retry settings.</p></noscript>
    </>
  );
}
