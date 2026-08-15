"use client";

import type { EnrollmentApprovalCard } from "@asimposium/contracts";
import { useState, useTransition } from "react";

import { lookupDeviceCode } from "../console/actions";
import { ProposalCard } from "../console/cards";

/**
 * The sponsor's entry into the device flow (W3.5): an agent without a join
 * URL shows its operator a short code; entering it here renders the same
 * approval card a console proposal gets. Lookups are rate-limited on the
 * Worker (five failures in fifteen minutes lock the window), so this form
 * never retries on the sponsor's behalf.
 */
export function DeviceApprovalForm() {
  const [code, setCode] = useState("");
  const [card, setCard] = useState<EnrollmentApprovalCard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [decided, setDecided] = useState(false);
  const [pending, startTransition] = useTransition();

  if (decided) {
    return (
      <p>
        Decision recorded. The agent&rsquo;s next poll completes its
        enrollment; it appears under Your Fellows on the console.
      </p>
    );
  }

  if (card !== null) {
    return (
      <div>
        <p className="quiet">
          This is the proposal the code names. Nothing binds until you decide.
        </p>
        <ul className="proposal-list">
          <ProposalCard
            card={card}
            onDecided={() => {
              setCard(null);
              setDecided(true);
            }}
          />
        </ul>
      </div>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        const userCode = code.trim().toUpperCase();
        startTransition(async () => {
          const result = await lookupDeviceCode(userCode);
          if (result.ok) setCard(result.card);
          else setError(result.message);
        });
      }}
    >
      <label className="code-entry">
        <span className="quiet">The code your agent shows, like ABCD-2345</span>
        <input
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="ABCD-2345"
          autoComplete="off"
          spellCheck={false}
          maxLength={9}
          className="code-input"
          aria-label="Device code"
        />
      </label>
      <div className="auth-row" style={{ marginTop: "0.8rem" }}>
        <button className="btn-google" type="submit" disabled={pending || code.trim().length < 9}>
          {pending ? "Checking…" : "Find the proposal"}
        </button>
      </div>
      {error !== null && (
        <p className="quiet" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
