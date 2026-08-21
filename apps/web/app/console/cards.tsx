"use client";

import type {
  EnrollmentApprovalCard,
  EnrollmentGrantReduction,
  MintEnrollmentRequest,
  RequestedScope,
  SponsorEnrollmentDecision,
  SponsorFellowLifecycleTarget,
  SponsorFellowSummary,
} from "@asimposium/contracts";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";

import {
  decideProposal,
  fingerprintEnrollmentAttempt,
  fingerprintLifecycleAttempt,
  type LifecycleAttemptScope,
  type LifecycleReceipt,
  mintJoinUrl,
  recoverLifecycleAttempt,
  recoverMintJoinUrl,
  recoverProposalDecision,
} from "./actions";
import {
  availableSessionStorage,
  claimEnrollmentRecoveryLock,
  clearEnrollmentAttempt,
  type EnrollmentAttemptFallback,
  type EnrollmentAttemptScope,
  enrollmentAttemptKey,
  enrollmentAttemptsRemain,
  type RetainedEnrollmentAttempt,
  releaseEnrollmentRecoveryLock,
  retainedEnrollmentAttempts,
} from "./idempotency";
import { buildJoinPasteBlock } from "./join-paste";

const MINT_SCOPES: readonly {
  readonly scope: RequestedScope;
  readonly label: string;
}[] = [
  { scope: "promote", label: "Promote finished workshop objects" },
  { scope: "review", label: "Submit reviews" },
  { scope: "propose-problems", label: "Propose private-draft problems" },
  { scope: "upload-artifacts", label: "Upload artifacts" },
];

interface TransientMintResult {
  readonly owner: string;
  readonly joinUrl: string;
  readonly expiresAt: number;
  readonly fingerprint: string;
}

interface TransientMintDraft {
  readonly owner: string;
  readonly fingerprint: string;
  readonly request: MintEnrollmentRequest;
}

interface TransientDecisionDraft {
  readonly owner: string;
  readonly enrollmentId: string;
  readonly fingerprint: string;
  readonly decision: SponsorEnrollmentDecision;
  readonly card: EnrollmentApprovalCard;
}

// Next client navigation can unmount this card without unloading the document.
// Keep the one-time result in module memory across that SPA transition. It is
// deliberately never written to Web Storage and is still lost on full reload.
const transientMintResults = new Map<string, TransientMintResult>();
const transientMintDrafts = new Map<string, TransientMintDraft>();
const transientDecisionDrafts = new Map<string, TransientDecisionDraft>();
const transientMintAttempts = new Map<string, EnrollmentAttemptFallback>();
const transientDecisionAttempts = new Map<string, EnrollmentAttemptFallback>();
const transientLifecycleAttempts = new Map<string, EnrollmentAttemptFallback>();

const subscribeToStaticBrowserState = () => () => undefined;

function useBrowserStorageReady(): boolean {
  return useSyncExternalStore(
    subscribeToStaticBrowserState,
    () => true,
    () => false,
  );
}

function attemptFallbackForOwner(
  owners: Map<string, EnrollmentAttemptFallback>,
  owner: string | undefined,
): EnrollmentAttemptFallback {
  if (owner === undefined) return new Map();
  const existing = owners.get(owner);
  if (existing !== undefined) return existing;
  const created: EnrollmentAttemptFallback = new Map();
  owners.set(owner, created);
  return created;
}

function transientDecisionKey(owner: string, enrollmentId: string): string {
  return `${owner}:${enrollmentId}`;
}

function clearTransientDecisionDraft(owner: string, fingerprint: string): void {
  for (const [key, draft] of transientDecisionDrafts) {
    if (draft.owner === owner && draft.fingerprint === fingerprint) {
      transientDecisionDrafts.delete(key);
    }
  }
}

function transientMintDraftKey(owner: string, fingerprint: string): string {
  return `${owner}:${fingerprint}`;
}

function latestMintDraft(owner: string | undefined): TransientMintDraft | undefined {
  if (owner === undefined) return undefined;
  const drafts = [...transientMintDrafts.values()];
  for (let index = drafts.length - 1; index >= 0; index -= 1) {
    const draft = drafts[index];
    if (draft?.owner === owner) return draft;
  }
  return undefined;
}

function decisionDraftsForOwner(owner: string | undefined): readonly TransientDecisionDraft[] {
  if (owner === undefined) return [];
  return [...transientDecisionDrafts.values()].filter((draft) => draft.owner === owner);
}

function retainedAttemptsForOwner(
  scope: EnrollmentAttemptScope,
  fallback: EnrollmentAttemptFallback,
  owner: string | undefined,
  browserStorageReady: boolean,
): {
  readonly attempts: readonly RetainedEnrollmentAttempt[];
  readonly unreadable: boolean;
} {
  if (owner === undefined) return { attempts: [], unreadable: false };
  try {
    return {
      attempts: retainedEnrollmentAttempts(
        scope,
        browserStorageReady ? availableSessionStorage() : undefined,
        fallback,
        owner,
      ),
      unreadable: false,
    };
  } catch {
    return { attempts: [], unreadable: true };
  }
}

function optionalWholeNumber(
  raw: string,
  label: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${label} must be a whole number from ${minimum.toLocaleString()} to ${maximum.toLocaleString()}.`,
    );
  }
  return value;
}

function optionalDurationMilliseconds(raw: string, label: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const seconds = Number(trimmed);
  const milliseconds = seconds * 1_000;
  if (
    !Number.isFinite(seconds) ||
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 1 ||
    milliseconds > 31_536_000_000
  ) {
    throw new Error(`${label} must be from 0.001 seconds to 365 days, in millisecond steps.`);
  }
  return milliseconds;
}

/**
 * Interactive console cards. The join URL mint result lives only in client
 * memory: it survives same-document Next navigation, is never persisted by
 * Agora or Web Storage, and is gone on full reload by construction.
 */

export function MintCard({
  configured,
  recoveryOwner,
}: {
  readonly configured: boolean;
  readonly recoveryOwner?: string;
}) {
  const recoveredResult =
    recoveryOwner === undefined ? null : (transientMintResults.get(recoveryOwner) ?? null);
  const recoveredDraftState = latestMintDraft(recoveryOwner);
  const recoveredDraft = recoveredDraftState?.request;
  const router = useRouter();
  const browserStorageReady = useBrowserStorageReady();
  const [pending, startTransition] = useTransition();
  const [joinUrl, setJoinUrl] = useState<string | null>(recoveredResult?.joinUrl ?? null);
  const [expiresAt, setExpiresAt] = useState<number | null>(recoveredResult?.expiresAt ?? null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [requestedScopes, setRequestedScopes] = useState<readonly RequestedScope[]>(
    recoveredDraft?.requested_scopes ?? ["promote", "review"],
  );
  const [problemBinding, setProblemBinding] = useState(recoveredDraft?.problem_binding ?? "");
  const [firstDirective, setFirstDirective] = useState(recoveredDraft?.first_directive ?? "");
  const [eventBudget, setEventBudget] = useState(
    recoveredDraft?.event_budget === undefined ? "" : String(recoveredDraft.event_budget),
  );
  const [artifactBudgetMiB, setArtifactBudgetMiB] = useState(
    recoveredDraft?.artifact_budget_bytes === undefined
      ? ""
      : String(recoveredDraft.artifact_budget_bytes / 1_048_576),
  );
  const [grantDays, setGrantDays] = useState(
    recoveredDraft?.fellow_grant_expires_in_ms === undefined
      ? ""
      : String(recoveredDraft.fellow_grant_expires_in_ms / 86_400_000),
  );
  const [joinMinutes, setJoinMinutes] = useState(
    recoveredDraft?.expires_in_ms === undefined
      ? "30"
      : String(recoveredDraft.expires_in_ms / 60_000),
  );
  const mintAttemptFallback = attemptFallbackForOwner(transientMintAttempts, recoveryOwner);
  const mintInFlight = useRef(false);
  const successfulMintFingerprint = useRef<string | null>(recoveredResult?.fingerprint ?? null);
  const retainedMintState = retainedAttemptsForOwner(
    "mint",
    mintAttemptFallback,
    recoveryOwner,
    browserStorageReady,
  );
  const retainedMintAttempt = retainedMintState.attempts[0];
  const [recoveryRevision, setRecoveryRevision] = useState(0);
  void recoveryRevision;
  const navigationWarning =
    retainedMintState.unreadable ||
    retainedMintState.attempts.length > 0 ||
    recoveredResult !== null ||
    recoveredDraft !== undefined;

  if (!configured) {
    return (
      <p className="quiet">
        Join-URL minting is disabled because this deployment cannot prepare recoverable writes.
      </p>
    );
  }

  if (joinUrl !== null) {
    const pasteBlock = buildJoinPasteBlock(joinUrl);
    if (pasteBlock === undefined) {
      return (
        <p className="quiet" role="alert">
          The recovered join URL did not pass the trusted-origin check. Do not use it; refresh the
          console and mint a new enrollment.
        </p>
      );
    }
    return (
      <div>
        <p className="sr-only" aria-live="polite">
          Your one-time join URL is ready below.
        </p>
        <p>
          <strong>Your one-time join URL is inside this block.</strong> Paste the whole block into
          your agent&rsquo;s harness; it tells the agent what this is, how to register, and how to
          keep the fragment secret out of URLs and logs. This page does not put the secret in
          browser storage. Stoa retains its SHA-256 hash plus an authenticated encrypted replay for
          24 hours so an unchanged retry can recover it. Save it before leaving or reloading this
          page.
        </p>
        <pre className="pasteblock join-url">{pasteBlock}</pre>
        <div className="auth-row btn-row" style={{ marginTop: "0.6rem" }}>
          <button
            className="btn-quiet"
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(pasteBlock).then(
                () => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1_500);
                },
                () => setError("Clipboard access was refused. Select and copy the block manually."),
              );
            }}
          >
            {copied ? "Copied" : "Copy the block"}
          </button>
          <button
            className="btn-quiet"
            type="button"
            onClick={() => {
              const fingerprint = successfulMintFingerprint.current;
              if (
                fingerprint === null ||
                !clearEnrollmentAttempt(
                  "mint",
                  fingerprint,
                  availableSessionStorage(),
                  mintAttemptFallback,
                  recoveryOwner,
                )
              ) {
                setError(
                  "This tab could not acknowledge the recovery marker. Keep this one-time URL visible, save it, and close the tab before minting the same settings again.",
                );
                return;
              }
              successfulMintFingerprint.current = null;
              if (recoveryOwner !== undefined) transientMintResults.delete(recoveryOwner);
              if (recoveryOwner !== undefined) {
                transientMintDrafts.delete(transientMintDraftKey(recoveryOwner, fingerprint));
              }
              setRecoveryRevision((revision) => revision + 1);
              setJoinUrl(null);
              setExpiresAt(null);
              setCopied(false);
              setError(null);
              router.refresh();
            }}
          >
            Done
          </button>
        </div>
        {expiresAt !== null && (
          <p className="quiet">The URL expires {new Date(expiresAt).toLocaleString()}.</p>
        )}
        {error !== null && (
          <p className="quiet" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  const mintRecoveryLocked = recoveredDraftState === undefined && retainedMintAttempt !== undefined;
  const mintDraftLocked = recoveredDraftState !== undefined || mintRecoveryLocked;
  const mintBodyUnavailable =
    navigationWarning && recoveredDraftState === undefined && retainedMintAttempt === undefined;

  return (
    <div>
      <p>
        Mint a one-time join URL, then paste it into your agent&rsquo;s harness. The secret lives in
        the URL fragment: browsers never transmit it, and the agent submits it exactly once in its
        registration POST. The agent&rsquo;s proposal appears below for your approval.
      </p>
      {mintDraftLocked && (
        <p className="quiet" role="status">
          This tab has an unresolved mint. Its exact encrypted request and Idempotency-Key are
          locked to the sponsor who prepared it.
        </p>
      )}
      {mintRecoveryLocked && retainedMintAttempt !== undefined && recoveryOwner !== undefined && (
        <div className="reduce-panel" role="status">
          <p>
            The exact request survived the reload as authenticated ciphertext. Recovering it sends
            the same body with the same Idempotency-Key; it never creates a replacement attempt.
          </p>
          <button
            className="btn-quiet"
            type="button"
            disabled={pending}
            onClick={() => {
              if (mintInFlight.current) return;
              mintInFlight.current = true;
              setError(null);
              startTransition(async () => {
                try {
                  const result = await recoverMintJoinUrl(
                    retainedMintAttempt.recoveryPayload,
                    retainedMintAttempt.key,
                    recoveryOwner,
                  );
                  if (result.ok) {
                    successfulMintFingerprint.current = retainedMintAttempt.fingerprint;
                    transientMintResults.set(recoveryOwner, {
                      owner: recoveryOwner,
                      joinUrl: result.joinUrl,
                      expiresAt: result.expiresAt,
                      fingerprint: retainedMintAttempt.fingerprint,
                    });
                    setJoinUrl(result.joinUrl);
                    setExpiresAt(result.expiresAt);
                    return;
                  }
                  if (result.recovery === "clear") {
                    const cleared = clearEnrollmentAttempt(
                      "mint",
                      retainedMintAttempt.fingerprint,
                      availableSessionStorage(),
                      mintAttemptFallback,
                      recoveryOwner,
                    );
                    setRecoveryRevision((revision) => revision + 1);
                    setError(
                      cleared
                        ? result.message
                        : `${result.message} This tab could not clear the retained marker.`,
                    );
                  } else {
                    setError(result.message);
                  }
                } catch {
                  setError(
                    "The browser could not reach the recovery action. The exact mint marker remains retained; retry it unchanged.",
                  );
                } finally {
                  mintInFlight.current = false;
                }
              });
            }}
          >
            {pending ? "Recovering…" : "Recover the exact mint"}
          </button>
        </div>
      )}
      {mintBodyUnavailable && (
        <p className="quiet" role="alert">
          This tab has an unresolved mint marker, but its recovery storage cannot be read safely. To
          avoid minting a duplicate, this form is locked. Verify the earlier outcome; close this tab
          only if you intentionally want to discard its recovery safeguard.
        </p>
      )}
      <form
        action={() => {
          setError(null);
          let request: MintEnrollmentRequest;
          try {
            if (requestedScopes.length === 0) {
              throw new Error("Choose at least one requested scope.");
            }
            const eventLimit = optionalWholeNumber(eventBudget, "Event budget", 1, 10_000);
            const artifactLimitMiB = optionalWholeNumber(
              artifactBudgetMiB,
              "Artifact budget",
              0,
              1_024,
            );
            const grantLifetimeDays = optionalWholeNumber(
              grantDays,
              "Fellow grant lifetime",
              1,
              365,
            );
            const joinLifetimeMinutes = optionalWholeNumber(
              joinMinutes,
              "Join URL lifetime",
              1,
              30,
            );
            if (joinLifetimeMinutes === undefined) {
              throw new Error("Join URL lifetime is required.");
            }
            request = {
              requested_scopes: MINT_SCOPES.map(({ scope }) => scope).filter((scope) =>
                requestedScopes.includes(scope),
              ),
              expires_in_ms: joinLifetimeMinutes * 60_000,
              ...(problemBinding.trim() === ""
                ? {}
                : { problem_binding: problemBinding.trim().toUpperCase() }),
              ...(firstDirective.trim() === "" ? {} : { first_directive: firstDirective.trim() }),
              ...(eventLimit === undefined ? {} : { event_budget: eventLimit }),
              ...(artifactLimitMiB === undefined
                ? {}
                : { artifact_budget_bytes: artifactLimitMiB * 1_048_576 }),
              ...(grantLifetimeDays === undefined
                ? {}
                : {
                    fellow_grant_expires_in_ms: grantLifetimeDays * 86_400_000,
                  }),
            };
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Check the enrollment settings.");
            return;
          }
          if (mintInFlight.current) {
            setError(
              "A mint is already in progress. Wait for its outcome before submitting again.",
            );
            return;
          }
          mintInFlight.current = true;
          startTransition(async () => {
            try {
              if (recoveryOwner === undefined) {
                throw new Error("This deployment cannot bind recoverable writes to this sponsor.");
              }
              const proposedIdempotencyKey = `console-${crypto.randomUUID()}`;
              const fingerprintResult = await fingerprintEnrollmentAttempt(
                "mint",
                request,
                recoveryOwner,
                proposedIdempotencyKey,
              );
              if (!fingerprintResult.ok) {
                setError(fingerprintResult.message);
                return;
              }
              const storage = availableSessionStorage();
              const unresolvedDraft = latestMintDraft(recoveryOwner);
              if (
                unresolvedDraft !== undefined &&
                unresolvedDraft.fingerprint !== fingerprintResult.fingerprint
              ) {
                throw new Error(
                  "Retry the unresolved mint with its exact locked settings before starting another.",
                );
              }
              const attempt = enrollmentAttemptKey(
                "mint",
                fingerprintResult.fingerprint,
                fingerprintResult.recoveryPayload,
                fingerprintResult.serverNow,
                storage,
                mintAttemptFallback,
                () => proposedIdempotencyKey,
                recoveryOwner,
              );
              transientMintDrafts.set(
                transientMintDraftKey(recoveryOwner, fingerprintResult.fingerprint),
                {
                  owner: recoveryOwner,
                  fingerprint: fingerprintResult.fingerprint,
                  request,
                },
              );
              setRecoveryRevision((revision) => revision + 1);
              const result = await mintJoinUrl(attempt.recoveryPayload, attempt.key, recoveryOwner);
              if (result.ok) {
                successfulMintFingerprint.current = fingerprintResult.fingerprint;
                transientMintResults.set(recoveryOwner, {
                  owner: recoveryOwner,
                  joinUrl: result.joinUrl,
                  expiresAt: result.expiresAt,
                  fingerprint: fingerprintResult.fingerprint,
                });
                setJoinUrl(result.joinUrl);
                setExpiresAt(result.expiresAt);
              } else {
                if (result.recovery === "clear") {
                  const cleared = clearEnrollmentAttempt(
                    "mint",
                    fingerprintResult.fingerprint,
                    storage,
                    mintAttemptFallback,
                    recoveryOwner,
                  );
                  setError(
                    cleared
                      ? result.message
                      : `${result.message} This tab could not discard its confirmed attempt marker. Close the tab only after you have verified the outcome and intentionally want to reset it.`,
                  );
                  if (cleared) {
                    transientMintDrafts.delete(
                      transientMintDraftKey(recoveryOwner, fingerprintResult.fingerprint),
                    );
                    setRecoveryRevision((revision) => revision + 1);
                  }
                } else {
                  setError(
                    attempt.keyReloadSafe
                      ? `${result.message} This tab retained the exact request as authenticated ciphertext; after a reload, use Recover the exact mint.`
                      : `${result.message} Keep this browser document open: the exact fields and key live only in its memory. Same-site navigation can restore them; reload cannot.`,
                  );
                }
              }
            } catch (cause) {
              setError(
                cause instanceof Error
                  ? cause.message
                  : "The browser could not prepare a recoverable mint attempt. Try again.",
              );
            } finally {
              mintInFlight.current = false;
            }
          });
        }}
      >
        <div className="mint-config">
          <fieldset>
            <legend>Requested scopes</legend>
            <p className="quiet">
              The common promote + review pair is selected. Broader powers are opt-in.
            </p>
            {MINT_SCOPES.map(({ scope, label }) => (
              <label key={scope} className="check">
                <input
                  type="checkbox"
                  disabled={mintDraftLocked || mintBodyUnavailable}
                  checked={requestedScopes.includes(scope)}
                  onChange={(event) =>
                    setRequestedScopes(
                      event.target.checked
                        ? [...requestedScopes, scope]
                        : requestedScopes.filter((requested) => requested !== scope),
                    )
                  }
                />
                {label}
              </label>
            ))}
          </fieldset>
          <div className="mint-grid">
            <label>
              <span>Problem assignment</span>
              <input
                type="text"
                disabled={mintDraftLocked || mintBodyUnavailable}
                value={problemBinding}
                placeholder="Optional, for example P-4DSP"
                onChange={(event) => setProblemBinding(event.target.value)}
              />
            </label>
            <label className="mint-wide">
              <span>First directive</span>
              <textarea
                rows={3}
                maxLength={2_000}
                disabled={mintDraftLocked || mintBodyUnavailable}
                value={firstDirective}
                placeholder="Optional first task for this Fellow"
                onChange={(event) => setFirstDirective(event.target.value)}
              />
            </label>
            <label>
              <span>Event budget</span>
              <input
                type="number"
                disabled={mintDraftLocked || mintBodyUnavailable}
                min={1}
                max={10_000}
                value={eventBudget}
                placeholder="Blank means unbounded"
                onChange={(event) => setEventBudget(event.target.value)}
              />
            </label>
            <label>
              <span>Artifact budget (MiB)</span>
              <input
                type="number"
                disabled={mintDraftLocked || mintBodyUnavailable}
                min={0}
                max={1_024}
                value={artifactBudgetMiB}
                placeholder="Blank means unbounded"
                onChange={(event) => setArtifactBudgetMiB(event.target.value)}
              />
            </label>
            <label>
              <span>Fellow grant lifetime (days)</span>
              <input
                type="number"
                disabled={mintDraftLocked || mintBodyUnavailable}
                min={1}
                max={365}
                value={grantDays}
                placeholder="Blank means no grant expiry"
                onChange={(event) => setGrantDays(event.target.value)}
              />
            </label>
            <label>
              <span>Join URL lifetime (minutes)</span>
              <input
                type="number"
                disabled={mintDraftLocked || mintBodyUnavailable}
                min={1}
                max={30}
                required
                value={joinMinutes}
                onChange={(event) => setJoinMinutes(event.target.value)}
              />
            </label>
          </div>
          <p className="quiet">
            Blank budget fields are an explicit unbounded grant. You can still impose finite limits
            on the approval card.
          </p>
        </div>
        <button
          className="btn-google"
          type="submit"
          disabled={pending || mintBodyUnavailable || mintRecoveryLocked}
        >
          {pending ? "Minting…" : mintDraftLocked ? "Retry the exact mint" : "Mint a join URL"}
        </button>
      </form>
      {error !== null && (
        <p className="quiet" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

interface ProposalManagerProps {
  readonly cards: readonly EnrollmentApprovalCard[];
  readonly hostState: "live" | "refused" | "unreachable" | "unconfigured";
  readonly writesConfigured: boolean;
  readonly recoveryOwner?: string;
}

export type DecisionRecoveryResolution =
  | {
      readonly ok: true;
      readonly decision: SponsorEnrollmentDecision["decision"];
    }
  | { readonly ok: false; readonly message: string };

function RetainedDecisionRecovery({
  attempt,
  recoveryOwner,
  fallback,
  onResolved,
}: {
  readonly attempt: RetainedEnrollmentAttempt;
  readonly recoveryOwner: string;
  readonly fallback: EnrollmentAttemptFallback;
  readonly onResolved: (resolution: DecisionRecoveryResolution) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  /**
   * Synchronous double-submit barrier.
   *
   * `pending` is state: it is false until React re-renders after the transition
   * is scheduled, so two invocations that both run before that render — a
   * double click, or a synthetic double dispatch — both read `disabled={pending}`
   * as false and both reach `recoverProposalDecision`. That would issue the same
   * sealed recovery twice. The lock flips in the same tick as the first call, so
   * the second returns before any action is issued. `disabled` stays as the
   * visible affordance; this is the one that actually holds.
   *
   * The claim and release live in `idempotency.ts` so they can be driven by a
   * test without a renderer. A ref is already a `{ current: boolean }` cell, so
   * the helper takes exactly what this passes — the tested path and the shipped
   * path are the same code, not two spellings of it.
   */
  const inFlight = useRef(false);

  return (
    <div className="reduce-panel" role="status">
      <p>
        An exact decision survived reload as authenticated ciphertext. Recover it before making a
        different enrollment decision.
      </p>
      <button
        className="btn-quiet"
        type="button"
        disabled={pending}
        onClick={() => {
          if (!claimEnrollmentRecoveryLock(inFlight)) return;
          setError(null);
          startTransition(async () => {
            try {
              const result = await recoverProposalDecision(
                attempt.recoveryPayload,
                attempt.key,
                recoveryOwner,
              );
              if (!result.ok && result.recovery === "retain") {
                setError(result.message);
                return;
              }
              const cleared = clearEnrollmentAttempt(
                "decision",
                attempt.fingerprint,
                availableSessionStorage(),
                fallback,
                recoveryOwner,
              );
              if (!cleared) {
                setError(
                  result.ok
                    ? "The decision was recovered, but this tab could not clear its marker. Verify the proposal state before closing the tab."
                    : `${result.message} This tab could not clear its confirmed marker.`,
                );
                return;
              }
              clearTransientDecisionDraft(recoveryOwner, attempt.fingerprint);
              onResolved(result.ok ? result : { ok: false, message: result.message });
              router.refresh();
            } catch {
              setError(
                "The browser could not reach the recovery action. The exact decision marker remains retained; retry it unchanged.",
              );
            } finally {
              // Released on every path, including the retained-error paths above:
              // a refusal that leaves the marker retained has to stay retryable,
              // and the barrier exists to collapse concurrent invocations, not to
              // make the control single-use.
              releaseEnrollmentRecoveryLock(inFlight);
            }
          });
        }}
      >
        {pending ? "Recovering…" : "Recover the exact decision"}
      </button>
      {error !== null && (
        <p className="quiet" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function DecisionRecoveryList({
  recoveryOwner,
  onRecoveryStateChange,
  onDecisionRecovered,
}: {
  readonly recoveryOwner?: string;
  readonly onRecoveryStateChange?: (unresolved: boolean) => void;
  readonly onDecisionRecovered?: (resolution: DecisionRecoveryResolution) => void;
}) {
  const browserStorageReady = useBrowserStorageReady();
  const [, setRecoveryRevision] = useState(0);
  const [resolution, setResolution] = useState<DecisionRecoveryResolution | null>(null);
  const fallback = attemptFallbackForOwner(transientDecisionAttempts, recoveryOwner);
  const state = retainedAttemptsForOwner("decision", fallback, recoveryOwner, browserStorageReady);
  const unresolved = state.unreadable || state.attempts.length > 0;

  useEffect(() => {
    onRecoveryStateChange?.(unresolved);
  }, [onRecoveryStateChange, unresolved]);

  if (recoveryOwner === undefined) return null;
  return (
    <>
      {state.unreadable && (
        <p className="quiet" role="alert">
          This tab has an unresolved decision marker, but its authenticated recovery body cannot be
          read safely. New decisions are locked.
        </p>
      )}
      {resolution !== null && (
        <p className="quiet" role={resolution.ok ? "status" : "alert"}>
          {resolution.ok ? "The exact decision was recovered and recorded." : resolution.message}
        </p>
      )}
      {state.attempts.map((attempt) => (
        <RetainedDecisionRecovery
          key={attempt.fingerprint}
          attempt={attempt}
          recoveryOwner={recoveryOwner}
          fallback={fallback}
          onResolved={(recovered) => {
            if (onDecisionRecovered === undefined) setResolution(recovered);
            else onDecisionRecovered(recovered);
            setRecoveryRevision((revision) => revision + 1);
          }}
        />
      ))}
    </>
  );
}

export function ProposalManager({
  cards,
  hostState,
  writesConfigured,
  recoveryOwner,
}: ProposalManagerProps) {
  const browserStorageReady = useBrowserStorageReady();
  const [, setRecoveryRevision] = useState(0);
  const [recoveryResolution, setRecoveryResolution] = useState<DecisionRecoveryResolution | null>(
    null,
  );
  const decisionFallback = attemptFallbackForOwner(transientDecisionAttempts, recoveryOwner);
  const retainedDecisionState = retainedAttemptsForOwner(
    "decision",
    decisionFallback,
    recoveryOwner,
    browserStorageReady,
  );
  const liveEnrollmentIds = new Set(cards.map((card) => card.enrollment_id));
  const orphanedRecoveryCards = decisionDraftsForOwner(recoveryOwner)
    .filter((draft) => !liveEnrollmentIds.has(draft.enrollmentId))
    .map((draft) => draft.card);
  const visibleCards = [...cards, ...orphanedRecoveryCards];
  const transientFingerprints = new Set(
    decisionDraftsForOwner(recoveryOwner).map((draft) => draft.fingerprint),
  );
  const retainedOnlyDecisions = retainedDecisionState.attempts.filter(
    (attempt) => !transientFingerprints.has(attempt.fingerprint),
  );
  const decisionBodiesUnavailable = retainedDecisionState.unreadable;
  const anotherRecoveryIsPending =
    retainedDecisionState.attempts.length > 0 || decisionDraftsForOwner(recoveryOwner).length > 0;
  const effectiveWritesConfigured =
    writesConfigured && recoveryOwner !== undefined && !decisionBodiesUnavailable;
  const retainedRecoveryControls =
    recoveryOwner === undefined
      ? null
      : retainedOnlyDecisions.map((attempt) => (
          <RetainedDecisionRecovery
            key={attempt.fingerprint}
            attempt={attempt}
            recoveryOwner={recoveryOwner}
            fallback={decisionFallback}
            onResolved={(recovered) => {
              setRecoveryResolution(recovered);
              setRecoveryRevision((revision) => revision + 1);
            }}
          />
        ));
  const recoveryNotice =
    recoveryResolution === null ? null : (
      <p className="quiet" role={recoveryResolution.ok ? "status" : "alert"}>
        {recoveryResolution.ok
          ? "The exact decision was recovered and recorded."
          : recoveryResolution.message}
      </p>
    );
  if (hostState !== "live") {
    return (
      <>
        <p className="quiet">
          {hostState === "unconfigured"
            ? "The agent host is not configured on this deployment."
            : hostState === "refused"
              ? "The agent host refused the proposal list."
              : "The agent host did not answer; proposals could not be loaded."}
        </p>
        {decisionBodiesUnavailable && (
          <p className="quiet" role="alert">
            This tab has an unresolved decision marker, but its authenticated recovery body cannot
            be read safely. New decisions are locked.
          </p>
        )}
        {recoveryNotice}
        {retainedRecoveryControls}
      </>
    );
  }
  if (visibleCards.length === 0) {
    return (
      <>
        <p className="quiet">
          Nothing pending. When your agent registers from a join URL, its proposal appears here for
          your decision.
        </p>
        {decisionBodiesUnavailable && (
          <p className="quiet" role="alert">
            This tab has an unresolved decision marker, but its recovery storage cannot be read
            safely. New decisions are locked until you verify that outcome or intentionally reset
            the tab.
          </p>
        )}
        {recoveryNotice}
        {retainedRecoveryControls}
      </>
    );
  }
  return (
    <>
      {decisionBodiesUnavailable && (
        <p className="quiet" role="alert">
          This tab has an unresolved decision marker, but its authenticated recovery body cannot be
          read safely. New decisions are locked.
        </p>
      )}
      {recoveryNotice}
      {retainedRecoveryControls}
      <ul className="proposal-list">
        {visibleCards.map((card) => (
          <ProposalCard
            key={card.proposal_id}
            card={card}
            writesConfigured={effectiveWritesConfigured}
            otherRecoveryPending={anotherRecoveryIsPending}
            recoveryOwner={recoveryOwner}
          />
        ))}
      </ul>
    </>
  );
}

export function ProposalCard({
  card,
  onDecided,
  onRecoveryStateChange,
  writesConfigured,
  otherRecoveryPending = false,
  externalRecoveryController = false,
  recoveryOwner,
}: {
  readonly card: EnrollmentApprovalCard;
  readonly onDecided?: (decision: SponsorEnrollmentDecision["decision"]) => void;
  readonly onRecoveryStateChange?: (unresolved: boolean) => void;
  readonly writesConfigured: boolean;
  readonly otherRecoveryPending?: boolean;
  readonly externalRecoveryController?: boolean;
  readonly recoveryOwner?: string;
}) {
  const router = useRouter();
  const browserStorageReady = useBrowserStorageReady();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [reduceOpen, setReduceOpen] = useState(false);
  const [keptScopes, setKeptScopes] = useState<readonly string[]>(card.requested_scopes);
  const [dropProblem, setDropProblem] = useState(false);
  const [dropDirective, setDropDirective] = useState(false);
  const [eventBudget, setEventBudget] = useState("");
  const [artifactBudget, setArtifactBudget] = useState("");
  const [grantSeconds, setGrantSeconds] = useState("");
  const [confirmation, setConfirmation] = useState<"approve" | "deny" | null>(null);
  const decisionAttemptFallback = attemptFallbackForOwner(transientDecisionAttempts, recoveryOwner);
  const decisionInFlight = useRef(false);
  const decisionDraftKey =
    recoveryOwner === undefined
      ? undefined
      : transientDecisionKey(recoveryOwner, card.enrollment_id);
  const recoveredDecisionDraft =
    decisionDraftKey === undefined ? undefined : transientDecisionDrafts.get(decisionDraftKey);
  const [decisionRecoveryRevision, setDecisionRecoveryRevision] = useState(0);
  void decisionRecoveryRevision;
  const decisionAttemptState = retainedAttemptsForOwner(
    "decision",
    decisionAttemptFallback,
    recoveryOwner,
    browserStorageReady,
  );
  const decisionWarning =
    decisionAttemptState.unreadable ||
    decisionAttemptState.attempts.length > 0 ||
    recoveredDecisionDraft !== undefined;

  useEffect(() => {
    onRecoveryStateChange?.(decisionWarning);
  }, [decisionWarning, onRecoveryStateChange]);

  const submitDecision = (decision: SponsorEnrollmentDecision) => {
    setError(null);
    if (decisionInFlight.current) {
      setError("A decision is already in progress. Wait for its outcome before submitting again.");
      return;
    }
    decisionInFlight.current = true;
    startTransition(async () => {
      try {
        if (recoveryOwner === undefined || decisionDraftKey === undefined) {
          throw new Error("This deployment cannot bind recoverable writes to this sponsor.");
        }
        const proposedIdempotencyKey = `console-${crypto.randomUUID()}`;
        const fingerprintResult = await fingerprintEnrollmentAttempt(
          "decision",
          decision,
          recoveryOwner,
          proposedIdempotencyKey,
        );
        if (!fingerprintResult.ok) {
          setError(fingerprintResult.message);
          return;
        }
        const storage = availableSessionStorage();
        if (
          recoveredDecisionDraft !== undefined &&
          recoveredDecisionDraft.fingerprint !== fingerprintResult.fingerprint
        ) {
          throw new Error(
            "Retry the unresolved decision exactly before choosing a different action.",
          );
        }
        const attempt = enrollmentAttemptKey(
          "decision",
          fingerprintResult.fingerprint,
          fingerprintResult.recoveryPayload,
          fingerprintResult.serverNow,
          storage,
          decisionAttemptFallback,
          () => proposedIdempotencyKey,
          recoveryOwner,
        );
        transientDecisionDrafts.set(decisionDraftKey, {
          owner: recoveryOwner,
          enrollmentId: card.enrollment_id,
          fingerprint: fingerprintResult.fingerprint,
          decision,
          card,
        });
        setDecisionRecoveryRevision((revision) => revision + 1);
        onRecoveryStateChange?.(true);
        const result = await decideProposal(attempt.recoveryPayload, attempt.key, recoveryOwner);
        if (!result.ok) {
          if (result.recovery === "clear") {
            const cleared = clearEnrollmentAttempt(
              "decision",
              fingerprintResult.fingerprint,
              storage,
              decisionAttemptFallback,
              recoveryOwner,
            );
            setError(
              cleared
                ? result.message
                : `${result.message} This tab could not discard its confirmed attempt marker. Close the tab only after you have verified the outcome and intentionally want to reset it.`,
            );
            if (cleared) {
              transientDecisionDrafts.delete(decisionDraftKey);
              setDecisionRecoveryRevision((revision) => revision + 1);
              onRecoveryStateChange?.(
                enrollmentAttemptsRemain(
                  "decision",
                  storage,
                  decisionAttemptFallback,
                  recoveryOwner,
                ),
              );
            }
          } else {
            setError(
              attempt.keyReloadSafe
                ? `${result.message} This tab retained the exact decision as authenticated ciphertext; after a reload, use Recover the exact decision.`
                : `${result.message} Keep this browser document open: the exact decision and key live only in its memory. Same-site navigation can restore them; reload cannot.`,
            );
          }
        } else {
          const cleared = clearEnrollmentAttempt(
            "decision",
            fingerprintResult.fingerprint,
            storage,
            decisionAttemptFallback,
            recoveryOwner,
          );
          if (!cleared) {
            setError(
              "The decision succeeded, but this tab could not clear its recovery marker. Verify the proposal is no longer pending, then close this tab to reset the marker.",
            );
            return;
          }
          transientDecisionDrafts.delete(decisionDraftKey);
          setDecisionRecoveryRevision((revision) => revision + 1);
          onRecoveryStateChange?.(
            enrollmentAttemptsRemain("decision", storage, decisionAttemptFallback, recoveryOwner),
          );
          onDecided?.(decision.decision);
          router.refresh();
        }
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "The browser could not prepare a recoverable decision. Try again.",
        );
      } finally {
        decisionInFlight.current = false;
      }
    });
  };

  const decide = (decision: "approve" | "deny") => {
    setReduceOpen(false);
    setConfirmation(decision);
  };

  const reduce = () => {
    setError(null);
    const reduction: EnrollmentGrantReduction = {};
    const kept = card.requested_scopes.filter((scope) => keptScopes.includes(scope));
    if (kept.length !== card.requested_scopes.length) {
      if (kept.length === 0) {
        setError("A reduction must keep at least one scope.");
        return;
      }
      reduction.scopes = kept;
    }
    if (dropProblem) reduction.problem_binding = null;
    if (dropDirective) reduction.first_directive = null;

    // Number("") is 0 and Number("junk") is NaN — and NaN serializes to null
    // in JSON, which would reach the Worker as a contract violation instead
    // of a readable message here.
    const budgets: {
      raw: string;
      label: string;
      minimum: number;
      maximum: number;
      assign: (value: number) => void;
    }[] = [
      {
        raw: eventBudget,
        label: "Event budget",
        minimum: 1,
        maximum: resources.event_budget === undefined ? 10_000 : resources.event_budget - 1,
        assign: (value) => {
          reduction.event_budget = value;
        },
      },
      {
        raw: artifactBudget,
        label: "Artifact bytes",
        minimum: 0,
        maximum:
          resources.artifact_budget_bytes === undefined
            ? 1_073_741_824
            : resources.artifact_budget_bytes - 1,
        assign: (value) => {
          reduction.artifact_budget_bytes = value;
        },
      },
    ];
    for (const { raw, label, minimum, maximum, assign } of budgets) {
      let value: number | undefined;
      try {
        value = optionalWholeNumber(raw, label, minimum, maximum);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : `Check ${label.toLowerCase()}.`);
        return;
      }
      if (value === undefined) continue;
      assign(value);
    }
    let grantLifetimeMs: number | undefined;
    try {
      grantLifetimeMs = optionalDurationMilliseconds(grantSeconds, "Grant lifetime");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Check the grant lifetime.");
      return;
    }
    if (grantLifetimeMs !== undefined) {
      const currentRemainingMs =
        resources.fellow_grant_expires_at === undefined
          ? undefined
          : resources.fellow_grant_expires_at - Date.now();
      if (currentRemainingMs !== undefined && grantLifetimeMs >= currentRemainingMs) {
        setError("Grant lifetime must end before the currently requested grant expiry.");
        return;
      }
      reduction.fellow_grant_expires_in_ms = grantLifetimeMs;
    }

    if (Object.keys(reduction).length === 0) {
      setError("Choose at least one narrowing, or use Approve.");
      return;
    }
    submitDecision({
      enrollment_id: card.enrollment_id,
      decision: "reduce",
      reduction,
    });
  };

  const resources = card.requested_resources;

  const SCOPE_PLAIN: Record<string, string> = {
    promote: "Publish finished work to the public ledger",
    review: "Submit reviews of other work",
    "propose-problems": "Draft new problems (nothing publishes without you)",
    "upload-artifacts": "Upload supporting files (datasets, code archives)",
  };
  const scopeDescriptions = card.requested_scopes.map((scope) => SCOPE_PLAIN[scope] ?? scope);

  return (
    <li className="proposal">
      <dl className="facts">
        <dt>Agent name</dt>
        <dd>
          <strong>{card.name}</strong>
        </dd>
        <dt>It says it is</dt>
        <dd>
          {card.model} on {card.harness}
          {card.reasoning_effort ? ` · ${card.reasoning_effort}` : ""}
        </dd>
        <dt>Agent-declared tools</dt>
        <dd>{card.tools_note ?? "None declared"}</dd>
        <dt>It&rsquo;s asking to</dt>
        <dd>
          <ul className="plain-list">
            {scopeDescriptions.map((description) => (
              <li key={description}>{description}</li>
            ))}
          </ul>
        </dd>
        <dt>Problem assignment</dt>
        <dd>{resources.problem_binding ?? "None — it picks when it starts"}</dd>
        <dt>First directive</dt>
        <dd>{resources.first_directive ?? "None"}</dd>
        <dt>Event budget</dt>
        <dd>
          {resources.event_budget === undefined
            ? "Unbounded"
            : resources.event_budget.toLocaleString()}
        </dd>
        <dt>Artifact budget</dt>
        <dd>
          {resources.artifact_budget_bytes === undefined
            ? "Unbounded"
            : `${resources.artifact_budget_bytes.toLocaleString()} bytes`}
        </dd>
        <dt>Fellow grant expires</dt>
        <dd>
          {resources.fellow_grant_expires_at === undefined
            ? "No grant expiry (you can revoke it anytime from the console)"
            : new Date(resources.fellow_grant_expires_at).toLocaleString()}
        </dd>
        <dt>Proposal expires</dt>
        <dd>
          {Number.isFinite(new Date(card.proposal_expires_at).getTime())
            ? new Date(card.proposal_expires_at).toLocaleString()
            : String(card.proposal_expires_at ?? "unspecified")}
        </dd>
      </dl>

      {recoveredDecisionDraft !== undefined && !externalRecoveryController && (
        <div className="reduce-panel" role="status">
          <p>
            <strong>This tab has an unconfirmed {recoveredDecisionDraft.decision.decision}.</strong>{" "}
            Retry the exact unchanged decision to recover its recorded outcome before editing or
            choosing another action.
          </p>
          <button
            className="btn-quiet"
            type="button"
            disabled={pending || !writesConfigured}
            onClick={() => submitDecision(recoveredDecisionDraft.decision)}
          >
            {pending ? "Checking…" : "Retry the exact decision"}
          </button>
        </div>
      )}

      {!writesConfigured && (
        <p className="quiet">
          Decisions are disabled because this deployment cannot prepare recoverable writes.
        </p>
      )}
      {writesConfigured && otherRecoveryPending && recoveredDecisionDraft === undefined && (
        <p className="quiet">
          A different enrollment decision must be recovered before this card can be changed.
        </p>
      )}

      <div className="auth-row proposal-actions">
        <button
          className="btn-google"
          type="button"
          disabled={pending || !writesConfigured || otherRecoveryPending || decisionWarning}
          onClick={() => decide("approve")}
        >
          Approve
        </button>
        <button
          className="btn-quiet"
          type="button"
          disabled={pending || !writesConfigured || otherRecoveryPending || decisionWarning}
          aria-controls={`reduce-${card.proposal_id}`}
          aria-expanded={reduceOpen}
          onClick={() => {
            setConfirmation(null);
            setReduceOpen(!reduceOpen);
          }}
        >
          Change permissions…
        </button>
        <button
          className="btn-quiet"
          type="button"
          disabled={pending || !writesConfigured || otherRecoveryPending || decisionWarning}
          onClick={() => decide("deny")}
        >
          Deny
        </button>
      </div>

      {confirmation !== null && (
        <fieldset className="reduce-panel">
          <legend className="sr-only">Confirm {confirmation}</legend>
          <p>
            <strong>Confirm {confirmation}.</strong>{" "}
            {confirmation === "approve"
              ? "This grants every requested scope and resource limit shown above to this Fellow."
              : "This rejects the proposal and the join flow cannot continue."}
          </p>
          <div className="auth-row proposal-actions">
            <button
              className={confirmation === "approve" ? "btn-google" : "btn-quiet"}
              type="button"
              disabled={pending || otherRecoveryPending || decisionWarning}
              onClick={() =>
                submitDecision({
                  enrollment_id: card.enrollment_id,
                  decision: confirmation,
                })
              }
            >
              {pending ? "Sending…" : `Yes, ${confirmation}`}
            </button>
            <button
              className="btn-quiet"
              type="button"
              disabled={pending}
              onClick={() => setConfirmation(null)}
            >
              Cancel
            </button>
          </div>
        </fieldset>
      )}

      {reduceOpen && (
        <div className="reduce-panel" id={`reduce-${card.proposal_id}`}>
          <fieldset>
            <legend className="quiet">Keep scopes</legend>
            {card.requested_scopes.map((scope) => (
              <label key={scope} className="check">
                <input
                  type="checkbox"
                  checked={keptScopes.includes(scope)}
                  onChange={(event) =>
                    setKeptScopes(
                      event.target.checked
                        ? [...keptScopes, scope]
                        : keptScopes.filter((kept) => kept !== scope),
                    )
                  }
                />
                {scope}
              </label>
            ))}
          </fieldset>
          {resources.problem_binding !== undefined && (
            <label className="check">
              <input
                type="checkbox"
                checked={dropProblem}
                onChange={(event) => setDropProblem(event.target.checked)}
              />
              Remove the problem assignment
            </label>
          )}
          {resources.first_directive !== undefined && (
            <label className="check">
              <input
                type="checkbox"
                checked={dropDirective}
                onChange={(event) => setDropDirective(event.target.checked)}
              />
              Remove the first directive
            </label>
          )}
          <div className="reduce-grid">
            <label>
              <span className="quiet">Event budget</span>
              <input
                type="number"
                min={1}
                max={
                  resources.event_budget === undefined
                    ? 10_000
                    : Math.max(0, resources.event_budget - 1)
                }
                disabled={resources.event_budget !== undefined && resources.event_budget <= 1}
                value={eventBudget}
                placeholder={String(resources.event_budget ?? "")}
                onChange={(event) => setEventBudget(event.target.value)}
              />
            </label>
            <label>
              <span className="quiet">Artifact bytes</span>
              <input
                type="number"
                min={0}
                max={
                  resources.artifact_budget_bytes === undefined
                    ? 1_073_741_824
                    : Math.max(0, resources.artifact_budget_bytes - 1)
                }
                disabled={resources.artifact_budget_bytes === 0}
                value={artifactBudget}
                placeholder={String(resources.artifact_budget_bytes ?? "")}
                onChange={(event) => setArtifactBudget(event.target.value)}
              />
            </label>
            <label>
              <span className="quiet">Grant lifetime from decision (seconds)</span>
              <input
                type="number"
                min={0.001}
                max={31_536_000}
                step={0.001}
                value={grantSeconds}
                placeholder={
                  resources.fellow_grant_expires_at === undefined
                    ? "Up to 31,536,000"
                    : "Shorter than the current remaining lifetime"
                }
                onChange={(event) => setGrantSeconds(event.target.value)}
              />
            </label>
          </div>
          <button
            className="btn-quiet"
            type="button"
            disabled={pending || otherRecoveryPending || decisionWarning}
            onClick={reduce}
          >
            {pending ? "Sending…" : "Approve with these reductions"}
          </button>
        </div>
      )}

      {error !== null && (
        <p className="quiet" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

const LIFECYCLE_TARGETS: Readonly<
  Record<SponsorFellowSummary["status"], readonly SponsorFellowLifecycleTarget[]>
> = {
  pending: ["active"],
  active: ["paused", "revoked", "compromised", "suspicious_review"],
  paused: ["active", "revoked", "compromised", "suspicious_review"],
  suspicious_review: ["active", "paused", "revoked", "compromised"],
  revoked: ["archived"],
  compromised: ["archived"],
  archived: [],
};

const LIFECYCLE_LABELS: Readonly<Record<SponsorFellowLifecycleTarget, string>> = {
  active: "Resume active",
  paused: "Pause Fellow",
  revoked: "Revoke Fellow",
  archived: "Archive Fellow",
  compromised: "Mark compromised",
  suspicious_review: "Mark for suspicious-review",
};

function lifecycleScopeLabel(scope: LifecycleAttemptScope): string {
  switch (scope) {
    case "credential-revoke":
      return "credential revocation";
    case "fellow-lifecycle":
      return "Fellow lifecycle change";
    case "sponsor-panic":
      return "sponsor panic";
  }
}

function LifecycleReceiptView({ receipt }: { readonly receipt: LifecycleReceipt }) {
  const detail =
    receipt.kind === "credential-revoke"
      ? `Credential ${receipt.credentialId} was revoked for Fellow ${receipt.fellowId}.`
      : receipt.kind === "fellow-lifecycle"
        ? `Fellow ${receipt.fellowId} is now ${receipt.status}.`
        : "All current Fellow credentials were revoked.";
  return (
    <div className="reduce-panel" aria-live="polite">
      <p>{detail}</p>
      <dl className="facts">
        <dt>Lifecycle event</dt>
        <dd>{receipt.eventId}</dd>
        <dt>Sponsor sequence</dt>
        <dd>{receipt.sponsorSeq}</dd>
        <dt>Effective</dt>
        <dd>{new Date(receipt.effectiveAt).toLocaleString()}</dd>
      </dl>
    </div>
  );
}

/**
 * Sponsor-only credential hygiene and Fellow posture controls. The console
 * lists only existing non-secret projection fields; every mutating command is
 * sealed before dispatch and recovers with its exact body and idempotency key.
 */
export function LifecycleManager({
  fellows,
  hostState,
  writesConfigured,
  recoveryOwner,
}: {
  readonly fellows: readonly SponsorFellowSummary[];
  readonly hostState: "live" | "unreachable" | "unconfigured" | "refused";
  readonly writesConfigured: boolean;
  readonly recoveryOwner?: string;
}) {
  const router = useRouter();
  const browserStorageReady = useBrowserStorageReady();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<LifecycleReceipt | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [recoveryRevision, setRecoveryRevision] = useState(0);
  const lifecycleInFlight = useRef(false);
  const lifecycleAttemptFallback = attemptFallbackForOwner(
    transientLifecycleAttempts,
    recoveryOwner,
  );
  void recoveryRevision;

  // The two-step destructive confirm swaps the pressed button in place; the
  // starting button unmounts, which would otherwise drop keyboard focus to
  // <body>. Hand focus to the confirm button the moment it appears.
  const confirmControlRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirming !== null) confirmControlRef.current?.focus();
  }, [confirming]);

  const retained = (["credential-revoke", "fellow-lifecycle", "sponsor-panic"] as const).map(
    (scope) => ({
      scope,
      state: retainedAttemptsForOwner(
        scope,
        lifecycleAttemptFallback,
        recoveryOwner,
        browserStorageReady,
      ),
    }),
  );
  const unreadableRecovery = retained.some(({ state }) => state.unreadable);
  const retainedAttempt = retained.find(({ state }) => state.attempts[0] !== undefined);
  const recoveryLocked = unreadableRecovery || retainedAttempt !== undefined;
  const controlsDisabled =
    pending || !writesConfigured || recoveryOwner === undefined || recoveryLocked;

  const clearAttempt = (scope: LifecycleAttemptScope, fingerprint: string): boolean =>
    clearEnrollmentAttempt(
      scope,
      fingerprint,
      availableSessionStorage(),
      lifecycleAttemptFallback,
      recoveryOwner,
    );

  const settle = (
    scope: LifecycleAttemptScope,
    fingerprint: string,
    result: Awaited<ReturnType<typeof recoverLifecycleAttempt>>,
  ) => {
    if (result.ok) {
      const cleared = clearAttempt(scope, fingerprint);
      setReceipt(result.receipt);
      setConfirming(null);
      setRecoveryRevision((revision) => revision + 1);
      if (!cleared) {
        setError(
          "The lifecycle command was acknowledged, but this tab could not clear its retained marker. Do not begin another safety command in this tab until you reload and recover the exact marker.",
        );
      }
      router.refresh();
      return;
    }
    if (result.recovery === "clear") {
      const cleared = clearAttempt(scope, fingerprint);
      setRecoveryRevision((revision) => revision + 1);
      setError(
        cleared
          ? result.message
          : `${result.message} This tab could not clear the retained marker.`,
      );
      return;
    }
    setError(result.message);
  };

  const prepareAndDispatch = (scope: LifecycleAttemptScope, request: unknown) => {
    if (lifecycleInFlight.current) return;
    lifecycleInFlight.current = true;
    setError(null);
    startTransition(async () => {
      try {
        if (recoveryOwner === undefined) {
          throw new Error("This deployment cannot bind lifecycle recovery to this sponsor.");
        }
        const proposedIdempotencyKey = `console-${crypto.randomUUID()}`;
        const prepared = await fingerprintLifecycleAttempt(
          scope,
          request,
          recoveryOwner,
          proposedIdempotencyKey,
        );
        if (!prepared.ok) {
          setError(prepared.message);
          return;
        }
        const attempt = enrollmentAttemptKey(
          scope,
          prepared.fingerprint,
          prepared.recoveryPayload,
          prepared.serverNow,
          availableSessionStorage(),
          lifecycleAttemptFallback,
          () => proposedIdempotencyKey,
          recoveryOwner,
        );
        setRecoveryRevision((revision) => revision + 1);
        const result = await recoverLifecycleAttempt(
          scope,
          attempt.recoveryPayload,
          attempt.key,
          recoveryOwner,
        );
        settle(scope, prepared.fingerprint, result);
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "The browser could not prepare a recoverable lifecycle command. Retry it unchanged.",
        );
      } finally {
        lifecycleInFlight.current = false;
      }
    });
  };

  const recoverExactAttempt = (
    scope: LifecycleAttemptScope,
    attempt: RetainedEnrollmentAttempt,
  ) => {
    if (lifecycleInFlight.current || recoveryOwner === undefined) return;
    lifecycleInFlight.current = true;
    setError(null);
    startTransition(async () => {
      try {
        const result = await recoverLifecycleAttempt(
          scope,
          attempt.recoveryPayload,
          attempt.key,
          recoveryOwner,
        );
        settle(scope, attempt.fingerprint, result);
      } catch {
        setError(
          "The browser could not reach the recovery action. The exact lifecycle marker remains retained; retry it unchanged.",
        );
      } finally {
        lifecycleInFlight.current = false;
      }
    });
  };

  const retainedRecoveryControls = (
    <>
      {unreadableRecovery ? (
        <p className="quiet" role="alert">
          This tab has an unreadable lifecycle recovery marker. To avoid a conflicting safety
          command, controls remain locked; verify the earlier outcome before using another tab.
        </p>
      ) : null}
      {retained.map(({ scope, state }) =>
        state.attempts.map((attempt) => (
          <div className="reduce-panel" key={`${scope}:${attempt.fingerprint}`} role="status">
            <p>
              An exact {lifecycleScopeLabel(scope)} command survived reload as authenticated
              ciphertext. Recover it before starting another lifecycle command.
            </p>
            <button
              className="btn-quiet"
              type="button"
              disabled={pending || recoveryOwner === undefined}
              onClick={() => recoverExactAttempt(scope, attempt)}
            >
              {pending ? "Recovering…" : `Recover exact ${lifecycleScopeLabel(scope)}`}
            </button>
          </div>
        )),
      )}
    </>
  );

  if (hostState !== "live") {
    return (
      <div>
        {retainedRecoveryControls}
        <p className="quiet">
          {hostState === "unconfigured"
            ? "The agent host is not configured on this deployment."
            : hostState === "refused"
              ? "The agent host refused the Fellows list."
              : "The Fellows list could not be loaded just now."}
        </p>
      </div>
    );
  }

  return (
    <div>
      <p className="sr-only" aria-live="polite">
        {confirming === null
          ? ""
          : "Second step required: a matching confirm button is now shown; activate it to apply the command."}
      </p>
      <p className="quiet">
        Credential revocation, Fellow posture, and sponsor panic require a Google authentication
        time from the last 15 minutes. The console never renders a credential token or token hash.
      </p>
      {!writesConfigured || recoveryOwner === undefined ? (
        <p className="quiet" role="alert">
          Lifecycle controls are disabled because this deployment cannot prepare recoverable writes.
        </p>
      ) : null}
      {retainedRecoveryControls}
      {receipt !== null ? <LifecycleReceiptView receipt={receipt} /> : null}
      {fellows.length === 0 ? (
        <p className="quiet">
          None yet. Approved Fellows appear here with their declared model, harness, and granted
          scopes.
        </p>
      ) : (
        <ul className="status-rows fellow-status-rows">
          {fellows.map((fellow) => (
            <li key={fellow.fellow_id}>
              <span>
                <strong>{fellow.name}</strong> · {fellow.model} · {fellow.harness} · {fellow.status}
                <br />
                scopes: {fellow.granted_scopes.join(", ")}
                {fellow.credentials.length > 0 ? (
                  <span>
                    <br />
                    credentials:{" "}
                    {fellow.credentials.map((credential) => (
                      <span key={credential.credential_id}>
                        {credential.profile} issued{" "}
                        {new Date(credential.issued_at).toLocaleDateString()}
                        {credential.active ? " · active" : " · inactive"}
                        {credential.active ? (
                          <button
                            className="btn-quiet"
                            type="button"
                            disabled={controlsDisabled}
                            onClick={() =>
                              setConfirming(
                                `credential-revoke:${fellow.fellow_id}:${credential.credential_id}`,
                              )
                            }
                          >
                            Revoke credential
                          </button>
                        ) : null}
                        {confirming ===
                        `credential-revoke:${fellow.fellow_id}:${credential.credential_id}` ? (
                          <button
                            ref={confirmControlRef}
                            className="btn-quiet btn-confirm"
                            type="button"
                            disabled={controlsDisabled}
                            onClick={() =>
                              prepareAndDispatch("credential-revoke", {
                                fellow_id: fellow.fellow_id,
                                credential_id: credential.credential_id,
                                confirm: "revoke-credential",
                              })
                            }
                          >
                            Confirm revocation
                          </button>
                        ) : null}{" "}
                      </span>
                    ))}
                  </span>
                ) : null}
              </span>
              <span className="state">
                since {new Date(fellow.granted_at).toLocaleDateString()}
                {LIFECYCLE_TARGETS[fellow.status].map((status) => {
                  const confirmationKey = `fellow-lifecycle:${fellow.fellow_id}:${status}`;
                  return (
                    <span key={status}>
                      <button
                        className="btn-quiet"
                        type="button"
                        disabled={controlsDisabled}
                        onClick={() => setConfirming(confirmationKey)}
                      >
                        {LIFECYCLE_LABELS[status]}
                      </button>
                      {confirming === confirmationKey ? (
                        <button
                          ref={confirmControlRef}
                          className="btn-quiet btn-confirm"
                          type="button"
                          disabled={controlsDisabled}
                          onClick={() =>
                            prepareAndDispatch("fellow-lifecycle", {
                              fellow_id: fellow.fellow_id,
                              status,
                              confirm: "change-fellow-lifecycle",
                            })
                          }
                        >
                          Confirm {LIFECYCLE_LABELS[status].toLowerCase()}
                        </button>
                      ) : null}{" "}
                    </span>
                  );
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="reduce-panel">
        <p>
          Sponsor panic revokes all current Fellow credentials. It does not expose or recover any
          credential secret in this console.
        </p>
        {confirming === "sponsor-panic" ? (
          <button
            ref={confirmControlRef}
            className="btn-quiet btn-confirm"
            type="button"
            disabled={controlsDisabled}
            onClick={() =>
              prepareAndDispatch("sponsor-panic", {
                confirm: "revoke-all-fellow-credentials",
              })
            }
          >
            Confirm sponsor panic
          </button>
        ) : (
          <button
            className="btn-quiet"
            type="button"
            disabled={controlsDisabled}
            onClick={() => setConfirming("sponsor-panic")}
          >
            Start sponsor panic confirmation
          </button>
        )}
      </div>
      {error !== null ? (
        <p className="quiet" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
