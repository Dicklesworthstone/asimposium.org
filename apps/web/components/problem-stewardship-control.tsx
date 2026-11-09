"use client";

import type {
  SponsorProblemGovernanceQuery,
  SponsorProblemGovernanceResponse,
} from "@asimposium/contracts";
import { useEffect, useRef, useState, useTransition } from "react";
import {
  changeProblemStewardship,
  type ProblemStewardshipActionResult,
} from "@/app/console/problems/[problem]/access/stewardship-actions";
import {
  createStewardshipAttempt,
  type PendingStewardship,
  parseStewardshipAttempt,
  problemGovernanceConsolePath,
  stewardshipAttemptExpired,
  stewardshipRecoveryKey,
} from "@/lib/problem-stewardship";

function commandDescription(command: PendingStewardship["command"]): string {
  if (command.operation === "add") return `Add ${command.target_sponsor_id} as a steward`;
  if (command.operation === "transfer")
    return `Transfer your stewardship to ${command.target_sponsor_id}`;
  return `Remove stewardship from ${command.target_sponsor_id}`;
}

/** Command recovery remains mounted when current authority is unavailable:
 * a successful transfer must not make its own lost receipt unrecoverable. */
export function ProblemStewardshipControl({
  sponsorId,
  problemId,
  initial,
  query,
  returnPath,
}: {
  readonly sponsorId: string;
  readonly problemId: string;
  readonly initial: SponsorProblemGovernanceResponse | null;
  readonly query: SponsorProblemGovernanceQuery;
  readonly returnPath: string;
}) {
  const [current, setCurrent] = useState(initial);
  const [operation, setOperation] = useState<"add" | "transfer" | "remove">("add");
  const [target, setTarget] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [attempt, setAttempt] = useState<PendingStewardship | null>(null);
  const [result, setResult] = useState<ProblemStewardshipActionResult | null>(null);
  const [ready, setReady] = useState(false);
  const [storageBlocked, setStorageBlocked] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [discardConfirmed, setDiscardConfirmed] = useState(false);
  const [now, setNow] = useState(0);
  const [pending, startTransition] = useTransition();
  const lock = useRef(false);
  const recoveryKey = stewardshipRecoveryKey(sponsorId, problemId);
  const stewardship = current?.stewardship;
  const expired = attempt !== null && stewardshipAttemptExpired(attempt, now);
  const disabled =
    pending ||
    !ready ||
    storageBlocked ||
    attempt !== null ||
    stewardship === undefined ||
    current?.authority.can_edit_access !== true ||
    (result?.ok === false && result.recovery === "reload");

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      try {
        const stored = sessionStorage.getItem(recoveryKey);
        const recovered =
          stored === null ? null : parseStewardshipAttempt(stored, sponsorId, problemId);
        if (recovered === undefined) {
          setStorageBlocked(true);
          setNotice(
            "The saved retry details could not be verified. Inspect the current stewardship before explicitly discarding those details; a new command is blocked.",
          );
        } else {
          setAttempt(recovered);
          setNotice(
            recovered === null
              ? null
              : "An earlier stewardship command has no confirmed receipt in this browser. Recover that exact command before making another change.",
          );
        }
        setNow(Date.now());
        setReady(true);
      } catch {
        setStorageBlocked(true);
        setNotice(
          "This browser cannot read its stewardship retry details. Restore session storage and reload before sending a change.",
        );
        setReady(true);
      }
    });
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [recoveryKey, sponsorId, problemId]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        setCurrent(initial);
        setConfirmed(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [initial]);

  function clearAttempt(): boolean {
    try {
      sessionStorage.removeItem(recoveryKey);
      if (sessionStorage.getItem(recoveryKey) !== null) throw new Error("Retry details remain");
      setAttempt(null);
      setStorageBlocked(false);
      setNotice(null);
      return true;
    } catch {
      setStorageBlocked(true);
      setNotice(
        "The response is shown below, but the browser could not clear its retained retry details. Reload or explicitly discard them before starting another command.",
      );
      return false;
    }
  }

  function send(next: PendingStewardship) {
    if (lock.current || storageBlocked) return;
    setNow(Date.now());
    if (stewardshipAttemptExpired(next)) {
      setNotice(
        "The retained command is outside the safe retry window. Inspect the current roster and explicitly discard local retry details before making a new decision; no automatic retry or new key will be used.",
      );
      return;
    }
    try {
      const encoded = JSON.stringify(next);
      sessionStorage.setItem(recoveryKey, encoded);
      if (sessionStorage.getItem(recoveryKey) !== encoded)
        throw new Error("Retry details were not retained");
    } catch {
      setStorageBlocked(true);
      setNotice(
        "The browser could not retain the exact command for recovery. No request was sent. Restore session storage and reload.",
      );
      return;
    }
    lock.current = true;
    setAttempt(next);
    setNotice(null);
    startTransition(async () => {
      try {
        const reply = await changeProblemStewardship(
          sponsorId,
          problemId,
          next.command,
          next.key,
          true,
          query,
        );
        setResult(reply);
        setConfirmed(false);
        if (reply.ok) {
          setCurrent(reply.current);
          clearAttempt();
        } else if (reply.recovery !== "retry") {
          clearAttempt();
        }
      } catch {
        setResult({
          ok: false,
          recovery: "retry",
          message:
            "The stewardship reply was lost. Retry the exact retained command to recover its outcome.",
        });
      } finally {
        lock.current = false;
      }
    });
  }

  return (
    <section className="card" aria-labelledby="problem-stewardship-heading">
      <h2 id="problem-stewardship-heading">Problem stewardship</h2>
      <p>
        Stewards govern admission, membership, writer capacity and problem lifecycle. They cannot
        grant scientific standing by fiat. Sharing stewardship does not transfer Fellows,
        credentials or private workshops.
      </p>
      {stewardship === undefined ? (
        <p role="status">
          Current stewardship is unavailable to this account. An exact earlier command can still be
          recovered below after a transfer or removal.
        </p>
      ) : (
        <>
          <p>
            Current accountable sponsor:{" "}
            <code>{stewardship.accountable_sponsor_id ?? "None recorded"}</code>. Roster version{" "}
            {stewardship.version} at the last read.
          </p>
          <p>
            {stewardship.total_count} sponsor{" "}
            {stewardship.total_count === 1 ? "steward" : "stewards"}; this bounded page shows{" "}
            {stewardship.stewards.length}
            {query.steward_after === undefined
              ? " from the start of the roster"
              : ` after ${query.steward_after}`}
            .
          </p>
          <p>
            A founding-steward label records provenance. It grants no permanent control; current
            authority follows the roster and accountable sponsor.
          </p>
          {stewardship.stewards.length === 0 ? (
            <p>No sponsor stewards on this page.</p>
          ) : (
            <div className="overflow-x-auto">
              <table>
                <caption>Current sponsor stewards for {problemId}</caption>
                <thead>
                  <tr>
                    <th scope="col">Sponsor</th>
                    <th scope="col">Provenance</th>
                    <th scope="col">Added (UTC)</th>
                    <th scope="col">Review removal</th>
                  </tr>
                </thead>
                <tbody>
                  {stewardship.stewards.map((steward) => (
                    <tr key={steward.sponsor_id}>
                      <th scope="row">
                        <code>{steward.sponsor_id}</code>
                        {steward.sponsor_id === sponsorId ? " (you)" : ""}
                      </th>
                      <td>
                        {steward.is_founding ? "Founding steward" : "Steward"}
                        {steward.sponsor_id === stewardship.accountable_sponsor_id
                          ? " · accountable sponsor"
                          : ""}
                      </td>
                      <td>
                        <time dateTime={steward.created_at}>{steward.created_at}</time>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn-quiet"
                          disabled={disabled || stewardship.total_count <= 1}
                          onClick={() => {
                            setOperation("remove");
                            setTarget(steward.sponsor_id);
                            setConfirmed(false);
                          }}
                        >
                          Review removal of {steward.sponsor_id}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <nav aria-label="Sponsor steward pages">
            {query.steward_after === undefined ? null : (
              <a
                href={problemGovernanceConsolePath(problemId, {
                  ...(query.after === undefined ? {} : { after: query.after }),
                })}
              >
                First steward page
              </a>
            )}
            {stewardship.has_more && stewardship.next_after !== null ? (
              <p>
                <a
                  href={problemGovernanceConsolePath(problemId, {
                    ...query,
                    steward_after: stewardship.next_after,
                  })}
                >
                  Next steward page
                </a>
              </p>
            ) : null}
          </nav>
        </>
      )}
      <p>
        <a href={returnPath}>Reload current stewardship and access</a>
      </p>
      {notice === null ? null : <p role="status">{notice}</p>}
      {result === null ? null : result.ok ? (
        <p role="status">
          Confirmed {result.receipt.operation} for <code>{result.receipt.target_sponsor_id}</code>,
          reviewed at roster version {result.receipt.expected_stewardship_version}, at{" "}
          <time dateTime={result.receipt.updated_at}>{result.receipt.updated_at}</time>.
          {result.receipt.event_id === null ? (
            " This draft command was recorded privately."
          ) : (
            <>
              {" "}
              Public event <code>{result.receipt.event_id}</code>.
            </>
          )}{" "}
          This is the original command receipt. Current stewardship is read separately and may
          include later changes.
          {result.current === null
            ? " Your authority may have ended, or the current read failed. The confirmed receipt remains valid."
            : ""}
        </p>
      ) : (
        <p role="alert">{result.message}</p>
      )}
      {attempt === null ? null : (
        <div>
          <p>
            Retained command: <strong>{commandDescription(attempt.command)}</strong>, based on
            roster version {attempt.command.expected_stewardship_version}.
          </p>
          {expired ? (
            <p role="alert">
              The safe retry window has expired. Inspect current stewardship before discarding local
              retry details.
            </p>
          ) : null}
          <button
            type="button"
            className="btn-quiet"
            disabled={pending || expired || storageBlocked}
            onClick={() => send(attempt)}
          >
            Recover the exact pending command
          </button>
        </div>
      )}
      {attempt !== null || storageBlocked ? (
        <div>
          <p>
            Discarding these local retry details does not undo a command that Stoa already accepted.
            Inspect current state before making a new decision.
          </p>
          <label>
            <input
              type="checkbox"
              checked={discardConfirmed}
              disabled={pending}
              onChange={(event) => setDiscardConfirmed(event.target.checked)}
            />{" "}
            I understand the prior command may already have completed and will inspect current
            stewardship.
          </label>
          <button
            type="button"
            className="btn-quiet"
            disabled={pending || !discardConfirmed}
            onClick={() => {
              if (discardConfirmed && clearAttempt()) window.location.assign(returnPath);
            }}
          >
            Discard local retry details and reload
          </button>
        </div>
      ) : null}
      {pending ? <p role="status">Waiting for the stewardship command receipt…</p> : null}

      <form
        method="post"
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled || !confirmed || stewardship === undefined) return;
          const next = createStewardshipAttempt(
            sponsorId,
            problemId,
            {
              action: "manage-steward",
              operation,
              target_sponsor_id: target,
              expected_stewardship_version: stewardship.version,
            },
            `console-stewardship-${crypto.randomUUID()}`,
          );
          if (next === undefined) {
            setResult({
              ok: false,
              recovery: "edit",
              message:
                "Enter the exact sponsor identifier from the intended collaborator's signed-in console.",
            });
            return;
          }
          send(next);
        }}
      >
        <fieldset disabled={disabled}>
          <legend>Review one stewardship change</legend>
          <label>
            Action
            <select
              value={operation}
              onChange={(event) => {
                const value = event.target.value;
                if (value === "add" || value === "transfer" || value === "remove") {
                  setOperation(value);
                  setConfirmed(false);
                }
              }}
            >
              <option value="add">Add a co-steward</option>
              <option value="transfer">Transfer my stewardship</option>
              <option value="remove">Remove a steward</option>
            </select>
          </label>
          <label>
            Exact sponsor identifier
            <input
              required
              maxLength={128}
              autoComplete="off"
              spellCheck={false}
              value={target}
              onChange={(event) => {
                setTarget(event.target.value);
                setConfirmed(false);
              }}
            />
          </label>
          <p>
            The target must already have signed in. Ask them for the sponsor identifier shown on
            their <a href="/console/account">Account data page</a>; an email address or display name
            does not identify the account.
          </p>
          {operation === "add" ? (
            <p>
              The new steward gains workspace governance and access to private problem formulations.
              Existing stewards remain. Scientific authorship and workshop ownership stay with their
              existing authors and sponsors.
            </p>
          ) : operation === "transfer" ? (
            <p>
              Your own stewardship moves to the named sponsor; the other stewards remain.{" "}
              {stewardship?.accountable_sponsor_id === sponsorId
                ? "Your accountable-sponsor role moves with it."
                : "The accountable sponsor remains unchanged."}{" "}
              You may immediately lose governance and private-formulation access.
            </p>
          ) : (
            <p>
              The named sponsor loses stewardship. The final steward cannot be removed. If the
              accountable sponsor is removed, the server selects a remaining steward as accountable
              sponsor. Removing yourself can end your access immediately; a founding label grants no
              exemption.
            </p>
          )}
          <label>
            <input
              type="checkbox"
              required
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />{" "}
            I confirm this <strong>{operation}</strong> action for{" "}
            <code>{target || "the exact sponsor above"}</code> on <code>{problemId}</code>, based on
            the displayed roster version and consequences.
          </label>
          <button
            type="submit"
            className="btn-action"
            disabled={
              !confirmed ||
              target.length === 0 ||
              (operation === "transfer" && target === sponsorId) ||
              (operation === "remove" && (stewardship?.total_count ?? 0) <= 1)
            }
          >
            {operation === "add"
              ? "Add co-steward"
              : operation === "transfer"
                ? "Transfer my stewardship"
                : "Remove this steward"}
          </button>
        </fieldset>
      </form>
      <noscript>
        <p>
          The current steward roster is readable above. Enable JavaScript to confirm a change and
          retain its exact metadata for recovery.
        </p>
      </noscript>
    </section>
  );
}
