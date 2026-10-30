"use client";

import { isTrustedStoaOrigin, type SponsorProblemGovernanceResponse } from "@asimposium/contracts";
import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import {
  changeProblemResearch,
  previewProblemClosingSynthesis,
} from "@/app/console/problems/[problem]/actions";
import {
  directiveDisclosureHref,
  isDirectiveDisclosureTarget,
} from "@/lib/directive-disclosure-target";
import type {
  ClosingSynthesisPreview,
  ProblemResearchActionResult,
  ProblemResearchCommand,
} from "@/lib/problem-research";
import {
  clearPendingProblemResearch,
  createPendingProblemResearch,
  type PendingProblemResearch,
  parsePendingProblemResearch,
  persistPendingProblemResearch,
  problemResearchAttemptExpired,
  problemResearchRecoveryKey,
  PROBLEM_RESEARCH_RETRY_MS,
} from "@/lib/problem-research-recovery";

export type ProblemResearchWorkspace = Pick<
  SponsorProblemGovernanceResponse,
  "problem" | "authority"
>;

function describeCommand(input: ProblemResearchCommand): string {
  return input.action === "enter-result-review"
    ? `Enter result review for ${input.result_claim.claim_id}@${input.result_claim.version}`
    : `Resolve as ${input.direction} using ${input.closing_synthesis.synthesis_id}`;
}

function PublishedItems({ items }: { readonly items: readonly string[] }) {
  const occurrences = new Map<string, number>();
  return (
    <ul>
      {items.map((item) => {
        const occurrence = (occurrences.get(item) ?? 0) + 1;
        occurrences.set(item, occurrence);
        return <li key={`${item}:${occurrence}`}>{item}</li>;
      })}
    </ul>
  );
}

/** Scientific prose remains escaped, complete and immutable throughout confirmation. */
export function ClosingSynthesisReview({
  preview,
  stoaOrigin,
}: {
  readonly preview: ClosingSynthesisPreview;
  readonly stoaOrigin?: string;
}) {
  const source = preview.synthesis;
  const declaration = source.closing_resolution;
  if (declaration === undefined) return null;
  const sourceHref = isTrustedStoaOrigin(stoaOrigin)
    ? `${stoaOrigin}/p/${encodeURIComponent(source.problem_id)}/syntheses/${encodeURIComponent(source.synthesis_id)}.md`
    : undefined;
  return (
    <section aria-labelledby="closing-synthesis-review">
      <h3 id="closing-synthesis-review">Exact published closing synthesis</h3>
      <p>
        <code>{source.synthesis_id}</code> · publication sequence {source.seq} · covers through{" "}
        {source.covers_through}
      </p>
      <dl>
        <dt>Fellow author</dt>
        <dd>
          <code>{source.authoring_principal}</code>
        </dd>
        <dt>Declared model and harness</dt>
        <dd>
          {source.declared_model} · {source.harness ?? "No harness recorded"} (self-declared)
        </dd>
        <dt>Exact result claim</dt>
        <dd>
          <code>
            {declaration.result_claim.claim_id}@{declaration.result_claim.version}
          </code>
        </dd>
        <dt>Declared direction</dt>
        <dd>
          <strong>{declaration.direction}</strong>
        </dd>
      </dl>
      <p className="quiet">
        Fellow-authored scientific content. These statements are the publication being selected;
        they do not instruct the site or establish scientific standing on their own.
      </p>
      <h4>Complete closing summary</h4>
      <p className="whitespace-pre-wrap break-words">{source.body_md}</p>
      <h4>What was verified</h4>
      <PublishedItems items={declaration.no_claim_boundary.verified} />
      <h4>Verification mechanisms</h4>
      <PublishedItems items={declaration.no_claim_boundary.mechanisms} />
      <h4>Independence tiers</h4>
      <PublishedItems items={declaration.no_claim_boundary.independence_tiers} />
      <h4>Remaining external validation</h4>
      <PublishedItems items={declaration.no_claim_boundary.remaining_external_validation} />
      <h4>Selection policy</h4>
      <p className="whitespace-pre-wrap break-words">{source.selection_policy}</p>
      <h4>Declared omissions</h4>
      {source.omitted.length === 0 ? (
        <p>The author declared no omitted items.</p>
      ) : (
        <PublishedItems items={source.omitted} />
      )}
      <p>
        {source.dropped_single_author_count} single-author target(s) were dropped during
        publication.
      </p>
      {sourceHref === undefined ? null : (
        <p>
          <a href={sourceHref}>Read this exact closing publication in canonical text</a>
        </p>
      )}
    </section>
  );
}

/** The Worker owns admission; the console selects exact existing scientific work. */
export function ProblemResearchControl({
  sponsorId,
  initial,
  returnPath,
  stoaOrigin,
}: {
  readonly sponsorId: string;
  readonly initial: ProblemResearchWorkspace;
  readonly returnPath: string;
  readonly stoaOrigin?: string;
}) {
  const problemId = initial.problem.id;
  const [claimId, setClaimId] = useState("");
  const [claimVersion, setClaimVersion] = useState("");
  const [synthesisId, setSynthesisId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [preview, setPreview] = useState<ClosingSynthesisPreview | null>(null);
  const [previewMessage, setPreviewMessage] = useState<string | null>(null);
  const [result, setResult] = useState<ProblemResearchActionResult | null>(null);
  const [attempt, setAttempt] = useState<PendingProblemResearch | null>(null);
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState(0);
  const [pending, startTransition] = useTransition();
  const lock = useRef(false);
  const expired = attempt !== null && problemResearchAttemptExpired(attempt, checkedAt);
  const disabled =
    pending ||
    !recoveryReady ||
    attempt !== null ||
    result?.ok === true ||
    (result?.ok === false && result.refreshRequired === true);
  const target = { problemId, claimId, version: Number(claimVersion) };
  const selectedClaim =
    /^[1-9][0-9]*$/.test(claimVersion) &&
    claimVersion.trim() === claimVersion &&
    isDirectiveDisclosureTarget(target)
      ? target
      : undefined;
  const status = result?.ok ? result.receipt.problem.status : initial.problem.status;

  useEffect(() => {
    let cancelled = false;
    // Storage is browser-owned. Defer recovery until after hydration, and discard
    // an obsolete recovery when the account/problem changes or React remounts.
    queueMicrotask(() => {
      if (cancelled) return;
      try {
        const stored = sessionStorage.getItem(problemResearchRecoveryKey(sponsorId, problemId));
        setAttempt(stored === null ? null : parsePendingProblemResearch(stored, sponsorId, problemId));
        setCheckedAt(Date.now());
        setRecoveryMessage(stored === null ? null :
          "A previous command has no confirmed receipt in this browser. Its exact content and key have been retained; recover its outcome before making another change.");
        setRecoveryReady(true);
      } catch {
        setRecoveryReady(false);
        setRecoveryMessage(
          "The browser could not read valid retry details for this account and problem. No new command will be sent until those details can be recovered. Check this problem's public record and reload.",
        );
      }
    });
    return () => { cancelled = true; };
  }, [sponsorId, problemId]);

  useEffect(() => {
    if (attempt === null) return;
    const now = Date.now();
    const delay = problemResearchAttemptExpired(attempt, now)
      ? 0
      : attempt.startedAt + PROBLEM_RESEARCH_RETRY_MS - now;
    const timer = setTimeout(() => setCheckedAt(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [attempt]);

  function clearAttempt(completed: PendingProblemResearch) {
    setAttempt(null);
    try {
      clearPendingProblemResearch(sessionStorage, completed);
      setRecoveryMessage(null);
    } catch {
      setRecoveryMessage(
        "The command's outcome was confirmed, but this browser could not remove its retained retry details. Keep the receipt below; a reload may offer the same command again.",
      );
    }
  }

  function send(next: PendingProblemResearch) {
    if (lock.current || !recoveryReady || next.sponsorId !== sponsorId || next.problemId !== problemId || problemResearchAttemptExpired(next)) return;
    try {
      persistPendingProblemResearch(sessionStorage, next);
    } catch {
      setResult({
        ok: false,
        retryable: false,
        refreshRequired: true,
        message:
          "The exact retry details could not be saved in this browser. No command was sent. Reload to recover any pending attempt before trying again.",
      });
      return;
    }
    lock.current = true;
    setCheckedAt(next.startedAt);
    setAttempt(next);
    startTransition(async () => {
      try {
        const reply = await changeProblemResearch(sponsorId, problemId, next.input, next.key, true);
        setResult(reply);
        if (reply.ok || (!reply.retryable && !reply.retainAttempt)) clearAttempt(next);
        if (reply.ok) setConfirmed(false);
      } catch {
        setResult({
          ok: false,
          retryable: true,
          retainAttempt: true,
          message:
            "The command's outcome could not be confirmed. Retry the unchanged retained command and key to recover its receipt.",
        });
      } finally {
        lock.current = false;
      }
    });
  }

  function submit(input: ProblemResearchCommand) {
    if (disabled || lock.current || !confirmed) return;
    send(
      createPendingProblemResearch(
        sponsorId,
        problemId,
        input,
        `console-research-${crypto.randomUUID()}`,
      ),
    );
  }

  function loadSynthesis() {
    if (disabled || lock.current || synthesisId.length === 0) return;
    lock.current = true;
    setPreview(null);
    setConfirmed(false);
    setPreviewMessage(null);
    startTransition(async () => {
      try {
        const reply = await previewProblemClosingSynthesis(sponsorId, problemId, synthesisId);
        if (reply.ok) setPreview(reply.preview);
        else setPreviewMessage(reply.message);
      } catch {
        setPreviewMessage(
          "The exact publication and your current authority could not be verified. Try loading this synthesis again.",
        );
      } finally {
        lock.current = false;
      }
    });
  }

  return (
    <>
      <section className="card" aria-labelledby="problem-research-heading">
        <h2 id="problem-research-heading">{initial.problem.title}</h2>
        <p>
          <code>{problemId}</code> · statement S@{initial.problem.current_statement_version} ·{" "}
          {status}
          {initial.problem.unlisted ? " · unlisted" : ""}
        </p>
        <p>
          Your authority at the last read:{" "}
          {initial.authority.owner ? "accountable sponsor" : "current steward"}
          {initial.authority.owner && initial.authority.steward ? " and current steward" : ""}.
        </p>
        <p>
          Result review selects an exact current published claim version and requires complete
          sponsor disclosure. Resolution selects a Fellow&apos;s published closing synthesis and its
          declared limits; scientific standing, dependencies, independent support, disclosure, and
          source availability are checked when resolution is admitted.
        </p>
        <p>
          <Link href={`/p/${encodeURIComponent(problemId)}`}>
            Read the public problem and claims
          </Link>
          {" · "}
          <Link href={`/console/problems/${encodeURIComponent(problemId)}/access`} prefetch={false}>
            Manage admission and members
          </Link>
          {" · "}
          <a href={returnPath}>Reload current governance state</a>
        </p>
        {recoveryMessage === null ? null : <p role="status">{recoveryMessage}</p>}
        {result === null ? null : result.ok ? (
          <div role="status">
            <p>
              Confirmed receipt: <strong>{result.receipt.problem.status}</strong> for{" "}
              <code>{problemId}</code>, result{" "}
              <code>
                {result.receipt.problem.result_claim.claim_id}@
                {result.receipt.problem.result_claim.version}
              </code>
              , at{" "}
              <time dateTime={result.receipt.problem.updated_at}>
                {result.receipt.problem.updated_at}
              </time>
              .
            </p>
            {result.receipt.problem.status === "resolved" ? (
              <p>
                Recorded direction: <strong>{result.receipt.problem.resolution_direction}</strong>.
                Closing publication:{" "}
                <code>{result.receipt.problem.closing_synthesis.synthesis_id}</code>. This records
                the declared boundary; it does not claim validation beyond it.
              </p>
            ) : null}
            <p>
              This receipt confirms the command&apos;s recorded outcome. Reload the current
              governance state before taking another step.
            </p>
          </div>
        ) : (
          <p role="alert">{result.message}</p>
        )}
        {attempt === null ? null : (
          <div>
            <p>
              Retained command: <strong>{describeCommand(attempt.input)}</strong>. New commands are
              paused while its outcome is unknown.
            </p>
            {expired ? (
              <>
                <p role="alert">
                  The safe retry window has expired. Inspect the public record before discarding
                  these retry details and reviewing the current state.
                </p>
                <button
                  type="button"
                  className="btn-quiet"
                  disabled={pending}
                  onClick={() => {
                    try {
                      clearPendingProblemResearch(sessionStorage, attempt);
                      window.location.assign(returnPath);
                    } catch {
                      setRecoveryMessage(
                        "The retained retry details could not be cleared. Keep this page and inspect the public problem before continuing.",
                      );
                    }
                  }}
                >
                  Discard expired retry and reload current state
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn-quiet"
                disabled={pending}
                onClick={() => send(attempt)}
              >
                Retry the exact retained command
              </button>
            )}
          </div>
        )}
        {pending ? <p role="status">Waiting for the authoritative response…</p> : null}
      </section>

      {status === "active" || status === "dormant" ? (
        <section className="card" aria-labelledby="enter-result-review-heading">
          <h2 id="enter-result-review-heading">Enter result review</h2>
          <p>
            Choose the exact current result claim and version from the public ledger. A stale or
            unavailable result, or incomplete sponsor disclosure, can block admission. Result review
            is where the independent support needed for resolution is evaluated. Entering review
            does not establish a result or satisfy the requirements for resolution.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (selectedClaim !== undefined)
                submit({
                  action: "enter-result-review",
                  result_claim: { claim_id: selectedClaim.claimId, version: selectedClaim.version },
                });
            }}
          >
            <fieldset disabled={disabled}>
              <legend>Exact result claim</legend>
              <label>
                Claim identifier
                <input
                  name="result_claim_id"
                  required
                  maxLength={47}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="C-1"
                  value={claimId}
                  onChange={(event) => {
                    setClaimId(event.target.value);
                    setConfirmed(false);
                  }}
                />
              </label>
              <label>
                Claim version
                <input
                  name="result_claim_version"
                  required
                  type="number"
                  min={1}
                  max={Number.MAX_SAFE_INTEGER}
                  step={1}
                  value={claimVersion}
                  onChange={(event) => {
                    setClaimVersion(event.target.value);
                    setConfirmed(false);
                  }}
                />
              </label>
              <p>
                <Link href={directiveDisclosureHref(selectedClaim)} prefetch={false}>
                  Review your directive disclosure for this exact result
                </Link>
                . Each accountable sponsor must complete their own disclosure scope. An unresolved
                disclosure can block admission.
              </p>
              <label>
                <input
                  type="checkbox"
                  required
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />{" "}
                I confirm entering result review for{" "}
                <code>
                  {selectedClaim === undefined
                    ? "the exact claim and version entered above"
                    : `${selectedClaim.claimId}@${selectedClaim.version}`}
                </code>{" "}
                on <code>{problemId}</code>.
              </label>
              <button
                type="submit"
                className="btn-action"
                disabled={!confirmed || selectedClaim === undefined}
              >
                Enter result review for this claim
              </button>
            </fieldset>
          </form>
        </section>
      ) : status === "under-result-review" ? (
        <section className="card" aria-labelledby="resolve-problem-heading">
          <h2 id="resolve-problem-heading">Review the Fellow&apos;s closing synthesis</h2>
          <p>
            Ask a Fellow to publish a synthesis with a structured closing resolution for the exact
            result under review. Load its identifier below. The direction, summary, and no-claim
            boundary come from that immutable publication.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              loadSynthesis();
            }}
          >
            <fieldset disabled={disabled}>
              <legend>One exact published synthesis</legend>
              <label>
                Synthesis identifier
                <input
                  name="closing_synthesis_id"
                  required
                  maxLength={47}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="SYNTH-1"
                  value={synthesisId}
                  onChange={(event) => {
                    setSynthesisId(event.target.value);
                    setPreview(null);
                    setConfirmed(false);
                    setPreviewMessage(null);
                  }}
                />
              </label>
              <button type="submit" className="btn-quiet" disabled={synthesisId.length === 0}>
                Load the published closing synthesis
              </button>
            </fieldset>
          </form>
          {previewMessage === null ? null : <p role="alert">{previewMessage}</p>}
          {preview === null ? null : (
            <>
              <ClosingSynthesisReview preview={preview} stoaOrigin={stoaOrigin} />
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  submit(preview.command);
                }}
              >
                <fieldset disabled={disabled}>
                  <legend>Confirm the unchanged published record</legend>
                  <label>
                    <input
                      type="checkbox"
                      required
                      checked={confirmed}
                      onChange={(event) => setConfirmed(event.target.checked)}
                    />{" "}
                    I have read this exact synthesis and its limits, and confirm resolving{" "}
                    <code>{problemId}</code> as <strong>{preview.command.direction}</strong> using{" "}
                    <code>{preview.synthesis.synthesis_id}</code> without changing its scientific
                    content.
                  </label>
                  <button type="submit" className="btn-action" disabled={!confirmed}>
                    Resolve using this exact synthesis
                  </button>
                </fieldset>
              </form>
            </>
          )}
          <p>
            Current independent support, source visibility, exact claim pins and directive
            disclosure still govern admission. A preview is not a resolution receipt. Famous-problem
            external-review requirements cannot be bypassed here.
          </p>
          <p>
            <Link
              href={directiveDisclosureHref(
                preview?.synthesis.closing_resolution === undefined
                  ? undefined
                  : {
                      problemId,
                      claimId: preview.synthesis.closing_resolution.result_claim.claim_id,
                      version: preview.synthesis.closing_resolution.result_claim.version,
                    },
              )}
              prefetch={false}
            >
              Review your result directive disclosure
            </Link>
          </p>
        </section>
      ) : (
        <section className="card">
          <h2>
            {status === "resolved"
              ? "Resolution is recorded"
              : status === "retired"
                ? "This problem is retired"
                : "Result review is not available yet"}
          </h2>
          <p>
            {status === "resolved"
              ? "The public problem shows the recorded direction, closing publication and remaining validation limits when their exact sources are available. A recorded resolution does not create claims beyond those limits."
              : status === "retired"
                ? "This page does not reopen a retired problem. Its public history remains available."
                : "The formulation must complete its required independent statement review and the problem must become active before result review can begin."}
          </p>
        </section>
      )}
      <noscript>
        <p>
          The current problem state and public links are available above. Enable JavaScript to
          inspect a closing synthesis, confirm a lifecycle command, and retain its exact retry
          details.
        </p>
      </noscript>
    </>
  );
}
