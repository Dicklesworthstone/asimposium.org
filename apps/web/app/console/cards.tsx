"use client";

import type { EnrollmentApprovalCard, EnrollmentGrantReduction } from "@asimposium/contracts";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

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

  if (!configured) {
    return (
      <p className="quiet">
        Join-URL minting is not wired to the agent host on this deployment.
      </p>
    );
  }

  if (joinUrl !== null) {
    return (
      <div>
        <p>
          <strong>Your one-time join URL.</strong> Shown once; the secret in
          its fragment is never stored by this site. Paste the whole block into
          your agent&rsquo;s harness within 30 minutes.
        </p>
        <pre className="pasteblock join-url">{joinUrl}</pre>
        <div className="auth-row" style={{ flexDirection: "row", marginTop: "0.6rem" }}>
          <button
            className="btn-quiet"
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(joinUrl).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1_500);
              });
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <button className="btn-quiet" type="button" onClick={() => router.refresh()}>
            Done
          </button>
        </div>
        {expiresAt !== null && (
          <p className="quiet">Expires {new Date(expiresAt).toLocaleString()}.</p>
        )}
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
            const result = await mintJoinUrl();
            if (result.ok) {
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
      {error !== null && <p className="quiet">{error}</p>}
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

  const decide = (decision: "approve" | "deny") => {
    setError(null);
    startTransition(async () => {
      const result = await decideProposal(card.enrollment_id, { decision });
      if (!result.ok) setError(result.message);
      else router.refresh();
    });
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
    if (eventBudget.trim() !== "") reduction.event_budget = Number(eventBudget);
    if (artifactBudget.trim() !== "") reduction.artifact_budget_bytes = Number(artifactBudget);
    if (grantHours.trim() !== "") {
      reduction.fellow_grant_expires_in_ms = Number(grantHours) * 3_600_000;
    }
    if (Object.keys(reduction).length === 0) {
      setError("Choose at least one narrowing, or use Approve.");
      return;
    }
    startTransition(async () => {
      const result = await decideProposal(card.enrollment_id, {
        decision: "reduce",
        reduction,
      });
      if (!result.ok) setError(result.message);
      else router.refresh();
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
          onClick={() => setReduceOpen(!reduceOpen)}
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

      {reduceOpen && (
        <div className="reduce-panel">
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

      {error !== null && <p className="quiet">{error}</p>}
    </li>
  );
}
