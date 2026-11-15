"use client";

import type { SponsorProblemGovernanceResponse } from "@asimposium/contracts";
import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { changeProblemWorkspace } from "@/app/console/problems/[problem]/workspace-actions";
import {
  clearWorkspaceCommand,
  createPendingWorkspaceCommand,
  type PendingWorkspaceCommand,
  type ProblemWorkspaceCommand,
  type ProblemWorkspaceReceipt,
  type ProblemWorkspaceResult,
  parsePendingWorkspaceCommand,
  parseProblemWorkspaceCommand,
  persistWorkspaceCommand,
  validWorkspaceProblem,
  WORKSPACE_RETRY_MS,
  workspaceAttemptExpired,
  workspaceClaimMapping,
  workspaceRecoveryKey,
} from "@/lib/problem-lifecycle";

/** Receipts describe recorded governance, never a newly earned scientific result. */
export function ProblemWorkspaceReceiptView({
  receipt,
}: {
  readonly receipt: ProblemWorkspaceReceipt;
}) {
  const problem = receipt.result.problem;
  return (
    <div role="status">
      {receipt.action === "fork" ? (
        <p>
          Stoa created private draft <code>{receipt.result.forked_problem_id}</code> from the
          published formulation of <code>{problem.id}</code>, statement S@
          {problem.current_statement_version}. The new draft has not been published.
        </p>
      ) : receipt.action === "merge" ? (
        <p>
          Stoa retired <code>{problem.id}</code> and recorded its canonical destination as{" "}
          <Link
            href={`/p/${encodeURIComponent(receipt.result.problem.canonical_problem_id)}`}
            prefetch={false}
          >
            {receipt.result.problem.canonical_problem_id}
          </Link>
          . Both histories remain; no scientific equivalence was established by this action.
        </p>
      ) : (
        <>
          <p>
            Stoa retired <code>{problem.id}</code>. Its public history remains available; retirement
            is not a resolution.
          </p>
          <p className="whitespace-pre-wrap break-words">
            Recorded public reason: {receipt.result.problem.resolution_summary}
          </p>
        </>
      )}
      <p>
        Recorded at <time dateTime={problem.updated_at}>{problem.updated_at}</time>.
      </p>
      {receipt.action === "fork" && (
        <p>
          <Link
            href={`/console/problems/${encodeURIComponent(receipt.result.forked_problem_id)}`}
            prefetch={false}
          >
            Inspect the new private draft and its publication requirements
          </Link>
        </p>
      )}
      <p>
        <Link href={`/p/${encodeURIComponent(problem.id)}/history`} prefetch={false}>
          Read the source problem history
        </Link>
      </p>
    </div>
  );
}

function CommandSummary({ command }: { readonly command: ProblemWorkspaceCommand }) {
  if (command.action === "retire")
    return (
      <>
        <p>
          <strong>Retire this problem with the public reason:</strong>
        </p>
        <p className="whitespace-pre-wrap break-words">{command.reason}</p>
      </>
    );
  if (command.action === "fork")
    return (
      <p>
        <strong>Create a private fork titled:</strong> {command.title}. Copy the currently published
        formulation without changing its scientific text.
      </p>
    );
  return (
    <>
      <p>
        <strong>Merge this problem into:</strong> <code>{command.canonical_problem_id}</code>.
      </p>
      {Object.entries(command.claim_mapping ?? {}).length > 0 && (
        <ul>
          {Object.entries(command.claim_mapping ?? {}).map(([source, target]) => (
            <li key={source}>
              <code>{source}</code> on this problem → <code>{target}</code> on the canonical problem
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** One pending command per sponsor and source problem, retained before dispatch. */
export function ProblemLifecycleControl({
  sponsorId,
  initial,
  returnPath,
  reauthenticate,
}: {
  readonly sponsorId: string;
  readonly initial: Pick<SponsorProblemGovernanceResponse, "problem" | "authority">;
  readonly returnPath: string;
  readonly reauthenticate: () => Promise<void>;
}) {
  const problemId = initial.problem.id;
  const [operation, setOperation] = useState<ProblemWorkspaceCommand["action"]>("fork");
  const [title, setTitle] = useState("");
  const [reason, setReason] = useState("");
  const [canonical, setCanonical] = useState("");
  const [mapping, setMapping] = useState<readonly { id: string; source: string; target: string }[]>(
    [],
  );
  const [confirmed, setConfirmed] = useState(false);
  const [attempt, setAttempt] = useState<PendingWorkspaceCommand | null>(null);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ProblemWorkspaceResult | null>(null);
  const [checkedAt, setCheckedAt] = useState(0);
  const [pending, startTransition] = useTransition();
  const lock = useRef(false);
  const canGovern = initial.authority.owner || initial.authority.steward;
  const canRetire = ["sharpening", "active", "dormant", "under-result-review"].includes(
    initial.problem.status,
  );
  const expired = attempt !== null && workspaceAttemptExpired(attempt, checkedAt);
  const frozen =
    pending ||
    !ready ||
    attempt !== null ||
    outcome?.ok === true ||
    (outcome?.ok === false && outcome.refreshRequired === true) ||
    !canGovern;

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      try {
        const raw = sessionStorage.getItem(workspaceRecoveryKey(sponsorId, problemId));
        setAttempt(raw === null ? null : parsePendingWorkspaceCommand(raw, sponsorId, problemId));
        setCheckedAt(Date.now());
        setReady(true);
        if (raw !== null)
          setMessage(
            "A previous workspace command has no confirmed outcome in this browser. Recover it before making another change.",
          );
      } catch {
        setReady(false);
        setMessage(
          "The browser could not read valid recovery details. No workspace command will be sent. Check the public history and reload this page.",
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [sponsorId, problemId]);

  useEffect(() => {
    if (attempt === null) return;
    const delay = workspaceAttemptExpired(attempt)
      ? 0
      : attempt.startedAt + WORKSPACE_RETRY_MS - Date.now();
    const timer = setTimeout(() => setCheckedAt(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [attempt]);

  function send(saved: PendingWorkspaceCommand) {
    if (lock.current || workspaceAttemptExpired(saved)) return;
    lock.current = true;
    setOutcome(null);
    startTransition(async () => {
      try {
        const reply = await changeProblemWorkspace(
          sponsorId,
          problemId,
          saved.input,
          saved.key,
          true,
        );
        setOutcome(reply);
        if (reply.ok || !reply.retainAttempt) {
          try {
            clearWorkspaceCommand(sessionStorage, saved);
            setAttempt(null);
            setMessage(null);
          } catch {
            setMessage(
              "The outcome below was received, but the browser could not clear its recovery details. Reload and recover the same command before starting another change.",
            );
          }
        }
      } catch {
        setOutcome({
          ok: false,
          retryable: true,
          retainAttempt: true,
          message:
            "The reply was lost. Recover this unchanged command to check whether it committed.",
        });
      } finally {
        lock.current = false;
      }
    });
  }

  function submit() {
    if (frozen || lock.current || !confirmed || (operation !== "fork" && !canRetire)) return;
    const claimMapping = workspaceClaimMapping(mapping);
    if (operation === "merge" && claimMapping === undefined) {
      setMessage(
        "Each correspondence needs one distinct source claim and one target claim, such as C-1 or C-1@2. Complete or remove empty rows.",
      );
      return;
    }
    const command = parseProblemWorkspaceCommand(
      problemId,
      operation === "fork"
        ? { action: "fork", title: title.trim() }
        : operation === "retire"
          ? { action: "retire", reason: reason.trim() }
          : {
              action: "merge",
              canonical_problem_id: canonical.trim(),
              ...(claimMapping !== undefined && Object.keys(claimMapping).length > 0
                ? { claim_mapping: claimMapping }
                : {}),
            },
    );
    if (!command) {
      setMessage(
        "Provide a title, a nonempty public retirement reason, or a different canonical problem identifier for the selected action.",
      );
      return;
    }
    try {
      const saved = createPendingWorkspaceCommand(
        sponsorId,
        problemId,
        command,
        `console-workspace-${crypto.randomUUID()}`,
      );
      persistWorkspaceCommand(sessionStorage, saved);
      setAttempt(saved);
      setCheckedAt(Date.now());
      setMessage(null);
      send(saved);
    } catch {
      setMessage(
        "The browser could not retain this exact command safely. Nothing was sent. Reload to recover any previous command.",
      );
    }
  }

  return (
    <section className="card" aria-labelledby="problem-workspace-heading">
      <h2 id="problem-workspace-heading">Problem lineage and retirement</h2>
      <p>
        Continue an independent line of work, consolidate duplicate problems, or retire an abandoned
        question. These are governance decisions. Scientific authorship, evidence and review
        standing remain in their existing records.
      </p>
      <p>
        <Link href={`/p/${encodeURIComponent(problemId)}`} prefetch={false}>
          Inspect this public formulation
        </Link>
        {" · "}
        <Link href={`/p/${encodeURIComponent(problemId)}/history`} prefetch={false}>
          Read its history
        </Link>
      </p>
      <noscript>
        <p>
          These controls need JavaScript to retain an exact command across an interrupted reply. No
          workspace change is submitted without an explicit confirmation.
        </p>
      </noscript>
      {message !== null && <p role="status">{message}</p>}
      {outcome !== null &&
        (outcome.ok ? (
          <ProblemWorkspaceReceiptView receipt={outcome.receipt} />
        ) : (
          <p role="alert">{outcome.message}</p>
        ))}
      {outcome?.ok === false && outcome.signInRequired && (
        <form action={reauthenticate}>
          <button className="btn-google" type="submit">
            Sign in again with Google
          </button>
        </form>
      )}
      {attempt !== null && (
        <section aria-labelledby="workspace-pending-heading">
          <h3 id="workspace-pending-heading">Saved command awaiting confirmation</h3>
          <CommandSummary command={attempt.input} />
          {expired ? (
            <p role="alert">
              The safe retry window has elapsed. Inspect the problem history and contact the
              operator to reconcile this command before creating another fork, merge or retirement.
            </p>
          ) : (
            <button className="btn" type="button" disabled={pending} onClick={() => send(attempt)}>
              {pending ? "Checking the saved command…" : "Recover saved command"}
            </button>
          )}
        </section>
      )}
      <form action={submit}>
        <fieldset disabled={frozen} className="col gap-3">
          <legend>Choose a workspace change</legend>
          <label>
            Action
            <select
              value={operation}
              onChange={(event) => {
                const value = event.target.value;
                if (value === "fork" || value === "merge" || value === "retire") {
                  setOperation(value);
                  setConfirmed(false);
                }
              }}
            >
              <option value="fork">Create a private fork</option>
              <option value="merge" disabled={!canRetire}>
                Merge into another problem
              </option>
              <option value="retire" disabled={!canRetire}>
                Retire this problem
              </option>
            </select>
          </label>
          {!canRetire && (
            <p>
              This problem is {initial.problem.status}. It cannot be retired or merged again; a
              private fork can continue an available published formulation.
            </p>
          )}
          {operation === "fork" ? (
            <>
              <label>
                Title for the new private draft
                <input
                  value={title}
                  required
                  maxLength={120}
                  onChange={(event) => {
                    setTitle(event.target.value);
                    setConfirmed(false);
                  }}
                />
              </label>
              <p>
                The Worker copies the currently published formulation into a new private draft and
                records its parent lineage. The original problem stays intact. The new draft needs
                its own publication review; creating it does not publish it or grant a scientific
                result.
              </p>
            </>
          ) : operation === "retire" ? (
            <>
              <label>
                Public retirement reason
                <textarea
                  value={reason}
                  required
                  rows={4}
                  maxLength={2048}
                  onChange={(event) => {
                    setReason(event.target.value);
                    setConfirmed(false);
                  }}
                />
              </label>
              <p>
                The reason enters the public history after screening. Retirement closes this problem
                to new scientific work and preserves its published history. It does not declare the
                question solved, and this console has no reopen action.
              </p>
            </>
          ) : (
            <>
              <label>
                Canonical problem identifier
                <input
                  value={canonical}
                  required
                  maxLength={128}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => {
                    setCanonical(event.target.value);
                    setConfirmed(false);
                  }}
                  placeholder="P-…"
                />
              </label>
              {validWorkspaceProblem(canonical.trim()) && (
                <p>
                  <Link href={`/p/${encodeURIComponent(canonical.trim())}`} prefetch={false}>
                    Inspect the selected canonical problem
                  </Link>
                </p>
              )}
              <p>
                The source problem retires and its ordinary public page redirects to the selected
                published problem. Existing objects and both histories remain. Correspondence below
                records where readers should look; it neither moves claims nor certifies
                equivalence.
              </p>
              <fieldset>
                <legend>Claim correspondence (optional)</legend>
                {mapping.map((row, index) => (
                  <div className="col gap-2" key={row.id}>
                    <label>
                      Source claim {index + 1}
                      <input
                        value={row.source}
                        maxLength={128}
                        placeholder="C-1"
                        onChange={(event) => {
                          setMapping(
                            mapping.map((entry, i) =>
                              i === index ? { ...entry, source: event.target.value } : entry,
                            ),
                          );
                          setConfirmed(false);
                        }}
                      />
                    </label>
                    <label>
                      Canonical claim {index + 1}
                      <input
                        value={row.target}
                        maxLength={128}
                        placeholder="C-2"
                        onChange={(event) => {
                          setMapping(
                            mapping.map((entry, i) =>
                              i === index ? { ...entry, target: event.target.value } : entry,
                            ),
                          );
                          setConfirmed(false);
                        }}
                      />
                    </label>
                    <button
                      type="button"
                      className="btn-quiet"
                      onClick={() => {
                        setMapping(mapping.filter((_, i) => i !== index));
                        setConfirmed(false);
                      }}
                    >
                      Remove correspondence {index + 1}
                    </button>
                  </div>
                ))}
                <button
                  className="btn-quiet"
                  type="button"
                  disabled={mapping.length >= 32}
                  onClick={() => {
                    setMapping([...mapping, { id: crypto.randomUUID(), source: "", target: "" }]);
                    setConfirmed(false);
                  }}
                >
                  Add claim correspondence
                </button>
              </fieldset>
            </>
          )}
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              required
              onChange={(event) => setConfirmed(event.target.checked)}
            />{" "}
            I confirm{" "}
            {operation === "fork"
              ? "creating the private fork with this title and the published source formulation"
              : operation === "merge"
                ? "retiring this problem and recording the displayed canonical destination and correspondence"
                : "retiring this problem with the displayed public reason"}
            .
          </label>
          <button className="btn" type="submit" disabled={!confirmed}>
            {pending
              ? "Waiting for Stoa…"
              : operation === "fork"
                ? "Create private fork"
                : operation === "merge"
                  ? "Confirm merge"
                  : "Confirm retirement"}
          </button>
        </fieldset>
      </form>
      <p>
        <a href={returnPath}>Reload current problem governance</a>
        {" · "}
        <Link href="/console/appeals" prefetch={false}>
          Screening appeals
        </Link>
      </p>
    </section>
  );
}
