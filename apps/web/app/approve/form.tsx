"use client";

import type { EnrollmentApprovalCard } from "@asimposium/contracts";
import { useEffect, useRef, useState, useTransition } from "react";

import { lookupDeviceCode } from "../console/actions";
import { DecisionRecoveryList, ProposalCard } from "../console/cards";

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
export function DeviceApprovalForm({
  writesConfigured,
  recoveryOwner,
}: {
  readonly writesConfigured: boolean;
  readonly recoveryOwner?: string;
}) {
  const [code, setCode] = useState("");
  const [card, setCard] = useState<EnrollmentApprovalCard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recordedDecision, setRecordedDecision] = useState<"approved" | "denied" | null>(null);
  const [cardDecisionUnresolved, setCardDecisionUnresolved] = useState(false);
  const [retainedDecisionUnresolved, setRetainedDecisionUnresolved] = useState(false);
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const decisionUnresolved = cardDecisionUnresolved || retainedDecisionUnresolved;
  const announcement =
    recordedDecision !== null ? "Decision recorded" : card === null ? "" : "Proposal found";
  // Lookup and decision outcomes replace the form the focus was in; hand
  // focus to the new content so keyboard and screen-reader users are not
  // dropped back to <body>.
  const foundProposalRef = useRef<HTMLParagraphElement>(null);
  const recordedDecisionRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (card !== null) foundProposalRef.current?.focus();
  }, [card]);
  useEffect(() => {
    if (recordedDecision !== null) recordedDecisionRef.current?.focus();
  }, [recordedDecision]);

  return (
    <>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      <DecisionRecoveryList
        recoveryOwner={recoveryOwner}
        onRecoveryStateChange={setRetainedDecisionUnresolved}
        onDecisionRecovered={(resolution) => {
          if (resolution.ok) {
            setCard(null);
            setError(null);
            setRecoveryNotice(null);
            setRecordedDecision(resolution.decision === "deny" ? "denied" : "approved");
          } else {
            setRecoveryNotice(resolution.message);
          }
        }}
      />
      {recoveryNotice !== null && (
        <p className="quiet" role="alert">
          {recoveryNotice}
        </p>
      )}
      {recordedDecision !== null ? (
        <div ref={recordedDecisionRef} tabIndex={-1}>
          {recordedDecision === "approved" ? (
            <p>
              Decision recorded. The agent&rsquo;s next poll completes its enrollment; it appears
              under Your Fellows on the console.
            </p>
          ) : (
            <p>
              Decision recorded. The agent&rsquo;s next poll receives the denial; no Fellow or
              credential was created.
            </p>
          )}
          <button
            className="btn-quiet"
            type="button"
            onClick={() => {
              setCode("");
              setError(null);
              setRecoveryNotice(null);
              setRecordedDecision(null);
            }}
          >
            Check another code
          </button>
        </div>
      ) : card !== null ? (
        <div>
          <p ref={foundProposalRef} tabIndex={-1} className="quiet">
            This is the proposal the code names. Nothing binds until you decide.
          </p>
          <ul className="proposal-list" aria-label="Device proposal">
            <ProposalCard
              key={card.enrollment_id}
              card={card}
              writesConfigured={writesConfigured}
              recoveryOwner={recoveryOwner}
              externalRecoveryController
              onRecoveryStateChange={setCardDecisionUnresolved}
              onDecided={(decision) => {
                setCard(null);
                setRecoveryNotice(null);
                setRecordedDecision(decision === "deny" ? "denied" : "approved");
              }}
            />
          </ul>
          <button
            className="btn-quiet"
            type="button"
            disabled={pending || decisionUnresolved}
            onClick={() => {
              setCard(null);
              setCode("");
              setError(null);
              setRecoveryNotice(null);
            }}
          >
            {decisionUnresolved ? "Resolve this decision first" : "Enter a different code"}
          </button>
        </div>
      ) : (
        <form
          action={() => {
            setError(null);
            const userCode = normalizeDeviceCode(code);
            startTransition(async () => {
              const result = await lookupDeviceCode(userCode);
              if (result.ok) setCard(result.card);
              else setError(result.message);
            });
          }}
        >
          <label className="code-entry code-entry-hero">
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
              autoCapitalize="characters"
              autoCorrect="off"
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
