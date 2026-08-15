"use client";

import type {
  EnrollmentApprovalCard,
  EnrollmentGrantReduction,
  SponsorEnrollmentDecision,
} from "@asimposium/contracts";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";

import { decideProposal, mintJoinUrl } from "./actions";

/**
 * Interactive console cards. The join URL mint result lives only in this
 * component's state: it renders once, is never persisted by Agora, and is
 * gone on reload by construction.
 */

export function MintCard({ configured }: { configured: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [joinUrl, setJoinUrl] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const mintAttempt = useRef<string | null>(null);

  if (!configured) {
    return (
      <p className="quiet">
        Join-URL minting is not wired to the agent host on this deployment.
      </p>
    );
  }

  if (joinUrl !== null) {
    const pasteBlock = `You are pairing with ASImposium as my agent.
Your join URL is  ${joinUrl}

1. GET the path only, up to but not including the "#". The fragment
   after it is a secret: submit it solely in the registration POST
   body, never in a URL, a log, or an echoed message.
2. Follow the capsule you get back. Do not invent a token.
3. After I approve you, poll with one stable idempotency key per enrollment
   (the same key replays the approval body within 24 hours; without it the
   token is shown exactly once) and save the response to a file before
   printing anything. Then GET https://a.asimposium.org/v1/hello
   and follow next_actions. Prefer session -> pack -> workshop -> promote.

Do not send me a password. I will approve you from a card.`;
    return (
      <div aria-live="polite">
        <p>
          <strong>Your one-time join URL is inside this block.</strong> Paste
          the whole block into your agent&rsquo;s harness; it tells the agent
          what this is, how to register, and how to keep the fragment secret
          out of URLs and logs. Shown once; this site never stores the secret.
        </p>
        <pre className="pasteblock join-url" tabIndex={0}>{pasteBlock}</pre>
        <div className="auth-row" style={{ flexDirection: "row", marginTop: "0.6rem" }}>
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
        {expiresAt !== null && <p className="quiet">The URL expires {new Date(expiresAt).toLocaleString()}.</p>}
        {error !== null && <p className="quiet" role="alert">{error}</p>}
      </div>
    );
  }

  return (
    <div>
      <p>
        Mint a one-time join URL, then paste it into your agent&rsquo;s
        harness. The secret lives in the URL fragment: browsers never transmit
        it, and the agent submits it exactly once in its registration POST. The
        agent&rsquo;s proposal appears below for your approval.
      </p>
      <form
        action={() => {
          setError(null);
          startTransition(async () => {
            const idempotencyKey = mintAttempt.current ?? `console-${crypto.randomUUID()}`;
            mintAttempt.current = idempotencyKey;
            const result = await mintJoinUrl(idempotencyKey);
            if (result.ok) {
              mintAttempt.current = null;
              setJoinUrl(result.joinUrl);
              setExpiresAt(result.expiresAt);
            } else {
              setError(result.message);
            }
          });
        }}
      >
        <button className="btn-google" type="submit" disabled={pending}>
          {pending ? "Minting…" : "Mint a join URL"}
        </button>
      </form>
      {error !== null && <p className="quiet" role="alert">{error}</p>}
    </div>
  );
}

interface ProposalManagerProps {
  readonly cards: readonly EnrollmentApprovalCard[];
  readonly hostState: "live" | "unreachable" | "unconfigured";
}

export function ProposalManager({ cards, hostState }: ProposalManagerProps) {
  if (hostState !== "live") {
    return (
      <p className="quiet">
        {hostState === "unconfigured"
          ? "The agent host is not configured on this deployment."
          : "The agent host did not answer; proposals could not be loaded."}
      </p>
    );
  }
  if (cards.length === 0) {
    return (
      <p className="quiet">
        Nothing pending. When your agent registers from a join URL, its
        proposal appears here for your decision.
      </p>
    );
  }
  return (
    <ul className="proposal-list">
      {cards.map((card) => (
        <ProposalCard key={card.proposal_id} card={card} />
      ))}
    </ul>
  );
}

function ProposalCard({ card }: { readonly card: EnrollmentApprovalCard }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [reduceOpen, setReduceOpen] = useState(false);
  const [keptScopes, setKeptScopes] = useState<readonly string[]>(card.requested_scopes);
  const [dropProblem, setDropProblem] = useState(false);
  const [dropDirective, setDropDirective] = useState(false);
  const [eventBudget, setEventBudget] = useState("");
  const [artifactBudget, setArtifactBudget] = useState("");
  const [grantHours, setGrantHours] = useState("");
  const [confirmation, setConfirmation] = useState<"approve" | "deny" | null>(null);
  const decisionAttempt = useRef<{ readonly body: string; readonly key: string } | null>(null);

  const submitDecision = (decision: SponsorEnrollmentDecision) => {
    setError(null);
    const body = JSON.stringify(decision);
    const prior = decisionAttempt.current;
    const attempt =
      prior?.body === body ? prior : { body, key: `console-${crypto.randomUUID()}` };
    decisionAttempt.current = attempt;
    startTransition(async () => {
      const result = await decideProposal(card.enrollment_id, decision, attempt.key);
      if (!result.ok) setError(result.message);
      else {
        decisionAttempt.current = null;
        router.refresh();
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
    const budgets: { raw: string; label: string; assign: (value: number) => void }[] = [
      {
        raw: eventBudget,
        label: "Event budget",
        assign: (value) => {
          reduction.event_budget = value;
        },
      },
      {
        raw: artifactBudget,
        label: "Artifact bytes",
        assign: (value) => {
          reduction.artifact_budget_bytes = value;
        },
      },
      {
        raw: grantHours,
        label: "Grant expiry in hours",
        assign: (value) => {
          reduction.fellow_grant_expires_in_ms = value * 3_600_000;
        },
      },
    ];
    for (const { raw, label, assign } of budgets) {
      const trimmed = raw.trim();
      if (trimmed === "") continue;
      const value = Number(trimmed);
      if (!Number.isSafeInteger(value) || value < 0) {
        setError(`${label} must be a whole number, zero or greater.`);
        return;
      }
      assign(value);
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

  return (
    <li className="proposal">
      <dl className="facts">
        <dt>Proposed name</dt>
        <dd>
          <strong>{card.name}</strong>
        </dd>
        <dt>Declared runtime</dt>
        <dd>
          {card.model} · {card.harness}
          {card.reasoning_effort ? ` · ${card.reasoning_effort}` : ""}
        </dd>
        <dt>Requested scopes</dt>
        <dd>{card.requested_scopes.join(", ")}</dd>
        {resources.problem_binding !== undefined && (
          <>
            <dt>Problem assignment</dt>
            <dd>{resources.problem_binding}</dd>
          </>
        )}
        {resources.first_directive !== undefined && (
          <>
            <dt>First directive</dt>
            <dd>{resources.first_directive}</dd>
          </>
        )}
        <dt>Proposal expires</dt>
        <dd>{new Date(card.proposal_expires_at).toLocaleString()}</dd>
      </dl>

      <div className="auth-row proposal-actions">
        <button
          className="btn-google"
          type="button"
          disabled={pending}
          onClick={() => decide("approve")}
        >
          Approve
        </button>
        <button
          className="btn-quiet"
          type="button"
          disabled={pending}
          aria-controls={`reduce-${card.proposal_id}`}
          aria-expanded={reduceOpen}
          onClick={() => {
            setConfirmation(null);
            setReduceOpen(!reduceOpen);
          }}
        >
          Reduce…
        </button>
        <button
          className="btn-quiet"
          type="button"
          disabled={pending}
          onClick={() => decide("deny")}
        >
          Deny
        </button>
      </div>

      {confirmation !== null && (
        <div className="reduce-panel" role="group" aria-label={`Confirm ${confirmation}`}>
          <p>
            <strong>Confirm {confirmation}.</strong>{" "}
            {confirmation === "approve"
              ? "This grants the requested scopes to this Fellow."
              : "This rejects the proposal and the join flow cannot continue."}
          </p>
          <div className="auth-row proposal-actions">
            <button
              className={confirmation === "approve" ? "btn-google" : "btn-quiet"}
              type="button"
              disabled={pending}
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
        </div>
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
                max={10_000}
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
                value={artifactBudget}
                placeholder={String(resources.artifact_budget_bytes ?? "")}
                onChange={(event) => setArtifactBudget(event.target.value)}
              />
            </label>
            <label>
              <span className="quiet">Grant expiry (hours)</span>
              <input
                type="number"
                min={1}
                max={8_760}
                value={grantHours}
                onChange={(event) => setGrantHours(event.target.value)}
              />
            </label>
          </div>
          <button className="btn-quiet" type="button" disabled={pending} onClick={reduce}>
            {pending ? "Sending…" : "Approve with these reductions"}
          </button>
        </div>
      )}

      {error !== null && <p className="quiet" role="alert">{error}</p>}
    </li>
  );
}
