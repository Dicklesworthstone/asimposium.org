"use client";

import {
  DIRECTOR_GRAMMAR_VERBS,
  parseDirectorCommand,
  type SponsorFellowSummary,
} from "@asimposium/contracts";
import type {
  SponsorDirectiveReceipt,
  SponsorDirectiveVerb,
} from "@asimposium/contracts/directives";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { executeDirectorCommand, issueSponsorDirective } from "./directive-actions";

export function DirectiveManager({
  fellows,
  directives,
  configured,
}: {
  readonly fellows: readonly SponsorFellowSummary[];
  readonly directives: readonly SponsorDirectiveReceipt[];
  readonly configured: boolean;
}) {
  const eligible = useMemo(
    () => fellows.filter((fellow) => fellow.status === "active"),
    [fellows],
  );
  const [inputMode, setInputMode] = useState<"form" | "palette">("form");
  const [fellowId, setFellowId] = useState(eligible[0]?.fellow_id ?? "");
  const [verb, setVerb] = useState<SponsorDirectiveVerb>("focus");
  const [text, setText] = useState("");
  const [paletteCommand, setPaletteCommand] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const paletteParse = useMemo(() => {
    if (paletteCommand.trim().length === 0) return null;
    return parseDirectorCommand(paletteCommand);
  }, [paletteCommand]);

  if (!configured) {
    return <p className="quiet">Directive delivery is unavailable on this deployment.</p>;
  }
  if (eligible.length === 0) {
    return <p className="quiet">No active Fellow is available to direct.</p>;
  }

  return (
    <div>
      <div className="btn-row" style={{ marginBottom: "0.75rem" }}>
        <button
          type="button"
          className={inputMode === "form" ? "btn-active" : "btn-quiet"}
          onClick={() => {
            setInputMode("form");
            setMessage(null);
          }}
          aria-pressed={inputMode === "form"}
        >
          Form view
        </button>
        <button
          type="button"
          className={inputMode === "palette" ? "btn-active" : "btn-quiet"}
          onClick={() => {
            setInputMode("palette");
            setMessage(null);
          }}
          aria-pressed={inputMode === "palette"}
        >
          Command palette
        </button>
      </div>

      {inputMode === "form" ? (
        <>
          <div className="auth-row" style={{ alignItems: "end", flexWrap: "wrap" }}>
            <label>
              Fellow
              <select value={fellowId} onChange={(event) => setFellowId(event.target.value)}>
                {eligible.map((fellow) => (
                  <option key={fellow.fellow_id} value={fellow.fellow_id}>
                    {fellow.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Directive
              <select
                value={verb}
                onChange={(event) => {
                  const next = event.target.value;
                  if (next === "focus" || next === "forbid" || next === "unfocus") setVerb(next);
                }}
              >
                <option value="focus">focus</option>
                <option value="forbid">forbid</option>
                <option value="unfocus">unfocus</option>
              </select>
            </label>
          </div>
          {verb === "unfocus" ? (
            <p className="quiet">Clear the Fellow&apos;s current sponsor focus.</p>
          ) : (
            <label style={{ display: "block", marginTop: "0.75rem" }}>
              <span style={{ display: "flex", justifyContent: "space-between" }}>
                <span>{verb === "focus" ? "What should this Fellow focus on?" : "What should this Fellow avoid?"}</span>
                <span className="quiet" style={{ fontSize: "0.85em" }}>{text.length}/500</span>
              </span>
              <textarea
                value={text}
                maxLength={500}
                rows={3}
                onChange={(event) => setText(event.target.value)}
                style={{ width: "100%" }}
              />
            </label>
          )}
          <div className="btn-row" style={{ marginTop: "0.6rem" }}>
            <button
              className="btn-quiet"
              type="button"
              disabled={pending || fellowId === "" || (verb !== "unfocus" && text.trim() === "")}
              onClick={() => {
                setMessage(null);
                const request = {
                  fellow_id: fellowId,
                  verb,
                  ...(verb === "unfocus" ? {} : { text: text.trim() }),
                } as const;
                const idempotencyKey = `console-directive-${crypto.randomUUID()}`;
                startTransition(async () => {
                  const result = await issueSponsorDirective(request, idempotencyKey);
                  if (!result.ok) {
                    setMessage(result.message);
                    return;
                  }
                  setMessage("Directive delivered to the Fellow inbox.");
                  if (verb !== "unfocus") setText("");
                  router.refresh();
                });
              }}
            >
              {pending ? "Delivering…" : "Deliver directive"}
            </button>
          </div>
        </>
      ) : (
        <div>
          <label style={{ display: "block" }}>
            <span>One-line director command palette</span>
            <input
              type="text"
              className="palette-input"
              value={paletteCommand}
              placeholder="focus FEL-1234 Investigate lemma 3.1"
              onChange={(e) => setPaletteCommand(e.target.value)}
              style={{ width: "100%", marginTop: "0.25rem", fontFamily: "monospace" }}
            />
          </label>

          {paletteParse !== null ? (
            <div style={{ marginTop: "0.5rem", fontSize: "0.9em" }}>
              {paletteParse.ok ? (
                <div style={{ color: "var(--color-success, #2e7d32)" }}>
                  <strong>Parsed {paletteParse.command.verb}:</strong>{" "}
                  <code>{paletteParse.command.verb}</code>
                  {"fellow_id" in paletteParse.command ? <> → <code>{paletteParse.command.fellow_id}</code></> : null}
                  {"problem_id" in paletteParse.command ? <> (<code>{paletteParse.command.problem_id}</code>)</> : null}
                </div>
              ) : (
                <div style={{ color: "var(--color-error, #c62828)" }}>
                  <p><strong>Syntax error:</strong> {paletteParse.message}</p>
                  {paletteParse.hint ? <p className="quiet">Hint: <code>{paletteParse.hint}</code></p> : null}
                  <p className="quiet" style={{ fontSize: "0.85em" }}>
                    Allowed verbs: {DIRECTOR_GRAMMAR_VERBS.join(", ")}
                  </p>
                </div>
              )}
            </div>
          ) : (
            <p className="quiet" style={{ fontSize: "0.85em", marginTop: "0.3rem" }}>
              Syntax: <code>assign</code>, <code>focus</code>, <code>forbid</code>, <code>unfocus</code>, <code>pause</code>, <code>resume</code>, <code>revoke</code>, <code>transfer</code>, <code>publish</code>, <code>hide</code>, <code>cap</code>
            </p>
          )}

          <div className="btn-row" style={{ marginTop: "0.6rem" }}>
            <button
              className="btn-quiet"
              type="button"
              disabled={pending || paletteParse === null || !paletteParse.ok}
              onClick={() => {
                if (!paletteParse || !paletteParse.ok) return;
                setMessage(null);
                const idempotencyKey = `console-palette-${crypto.randomUUID()}`;
                startTransition(async () => {
                  const result = await executeDirectorCommand(paletteCommand, idempotencyKey);
                  if (!result.ok) {
                    setMessage(result.message);
                    return;
                  }
                  setMessage(result.message);
                  setPaletteCommand("");
                  router.refresh();
                });
              }}
            >
              {pending ? "Executing…" : "Execute command"}
            </button>
          </div>
        </div>
      )}

      {message ? <p className="quiet" role="status" style={{ marginTop: "0.5rem" }}>{message}</p> : null}

      <div className="honesty-note" style={{ marginTop: "1rem", padding: "0.5rem", borderLeft: "3px solid #666", fontSize: "0.85em" }}>
        <p className="quiet">
          <strong>Directive disclosure rule (Rule A2 / Fable §8.2):</strong> Directives are private steering with public provenance markers (&quot;received a sponsor directive&quot;). Promoting a claim to <code>strongly-supported</code> or entering <code>under-result-review</code> requires sponsor attestation that no undisclosed directives materially shaped the result.
        </p>
      </div>

      <h3 style={{ marginTop: "1rem" }}>Recent directives</h3>
      {directives.length === 0 ? (
        <p className="quiet">No directives delivered yet.</p>
      ) : (
        <ul>
          {directives.slice(0, 20).map((directive) => (
            <li key={directive.directive_id}>
              <strong>{directive.verb}</strong> → <code>{directive.fellow_id}</code>{" "}
              <span className="quiet">
                {directive.acknowledged_at === null ? "delivered · awaiting acknowledgment" : "acknowledged"}
              </span>
              {directive.text === null ? null : <p>{directive.text}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

