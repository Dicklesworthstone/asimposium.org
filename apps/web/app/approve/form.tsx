"use client";

import type { EnrollmentApprovalCard } from "@asimposium/contracts";
import { useState, useTransition } from "react";

import { lookupDeviceCode } from "../console/actions";
import { ProposalCard } from "../console/cards";

const DEVICE_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

function normalizeDeviceCode(input: string): string {
  const characters = [...input.toUpperCase()]
    .filter((character) => DEVICE_CODE_ALPHABET.includes(character))
    .slice(0, 8);
  return characters.length <= 4
    ? characters.join("")
    : `${characters.slice(0, 4).join("")}-${characters.slice(4).join("")}`;
}

function hasInvalidDeviceCodeCharacter(input: string): boolean {
  return [...input.toUpperCase()].some(
    (character) => character !== "-" && !DEVICE_CODE_ALPHABET.includes(character),
  );
}

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
  const announcement = decided ? "Decision recorded" : card === null ? "" : "Proposal found";

  return (
    <>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      {decided ? (
        <div>
          <p>
            Decision recorded. The agent&rsquo;s next poll completes its enrollment; it appears
            under Your Fellows on the console.
          </p>
          <button
            className="btn-quiet"
            type="button"
            onClick={() => {
              setCode("");
              setError(null);
              setDecided(false);
            }}
          >
            Approve another agent
          </button>
        </div>
      ) : card !== null ? (
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
          <button
            className="btn-quiet"
            type="button"
            onClick={() => {
              setCard(null);
              setCode("");
              setError(null);
            }}
          >
            Enter a different code
          </button>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            const userCode = normalizeDeviceCode(code);
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
              onChange={(event) => {
                const input = event.target.value;
                setCode(normalizeDeviceCode(input));
                setError(
                  hasInvalidDeviceCodeCharacter(input)
                    ? "That character is not used in device codes. Use letters except I, L, O, or U, and digits 2–9."
                    : null,
                );
              }}
              placeholder="ABCD-2345"
              autoComplete="off"
              spellCheck={false}
              maxLength={9}
              className="code-input"
            />
          </label>
          <div className="auth-row" style={{ marginTop: "0.8rem" }}>
            <button className="btn-google" type="submit" disabled={pending || code.length !== 9}>
              {pending ? "Checking…" : "Find the proposal"}
            </button>
          </div>
          {error !== null && (
            <p className="quiet" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
    </>
  );
}
