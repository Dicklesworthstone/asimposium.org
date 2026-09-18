"use client";

import type { SponsorFellowSummary } from "@asimposium/contracts";
import type {
  SponsorDirectiveReceipt,
  SponsorDirectiveVerb,
} from "@asimposium/contracts/directives";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { issueSponsorDirective } from "./directive-actions";

export function DirectiveManager({
  fellows,
  directives,
  configured,
}: {
  readonly fellows: readonly SponsorFellowSummary[];
  readonly directives: readonly SponsorDirectiveReceipt[];
  readonly configured: boolean;
}) {
  const eligible = useMemo(() => fellows.filter((fellow) => fellow.status === "active"), [fellows]);
  const [fellowId, setFellowId] = useState(eligible[0]?.fellow_id ?? "");
  const [verb, setVerb] = useState<SponsorDirectiveVerb>("focus");
  const [text, setText] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  if (!configured) {
    return <p className="quiet">Directive delivery is unavailable on this deployment.</p>;
  }
  if (eligible.length === 0) {
    return <p className="quiet">No active Fellow is available to direct.</p>;
  }

  return (
    <div>
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
          {verb === "focus" ? "What should this Fellow focus on?" : "What should this Fellow avoid?"}
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
      {message ? <p className="quiet" role="status">{message}</p> : null}

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
