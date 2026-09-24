"use client";

import type {
  SponsorFellowSummary,
  SponsorProblemBrief,
  SponsorProblemSummary,
} from "@asimposium/contracts";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { briefRequestFromForm, publishProblem, saveProblemBrief } from "./problem-actions";

/**
 * Sponsor problem intent (Fable §6.2, ADR-7/22): a sponsor writes a private
 * brief and assigns it to one of its own Fellows; the Fellow adopts it by
 * proposing the exact formulation; the sponsor then publishes the adopted
 * draft through the Worker's lifecycle gate. Publication opens sharpening, and
 * claims unlock only after an independent statement review.
 */
export function ProblemManager({
  fellows,
  briefs,
  problems,
  configured,
}: {
  readonly fellows: readonly SponsorFellowSummary[];
  readonly briefs: readonly SponsorProblemBrief[];
  readonly problems: readonly SponsorProblemSummary[];
  readonly configured: boolean;
}) {
  const active = useMemo(() => fellows.filter((fellow) => fellow.status === "active"), [fellows]);
  const names = useMemo(
    () => new Map(fellows.map((fellow) => [fellow.fellow_id, fellow.name] as const)),
    [fellows],
  );
  const [title, setTitle] = useState("");
  const [statement, setStatement] = useState("");
  const [falsifier, setFalsifier] = useState("");
  const [motivation, setMotivation] = useState("");
  const [areas, setAreas] = useState("");
  const [assignee, setAssignee] = useState(active[0]?.fellow_id ?? "");
  const [acknowledged, setAcknowledged] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  if (!configured) {
    return (
      <p className="quiet">Problem briefs and publication are unavailable on this deployment.</p>
    );
  }

  const drafts = problems.filter((problem) => problem.status === "private-draft");
  const published = problems.filter((problem) => problem.status !== "private-draft");

  return (
    <div>
      <h3>Write a brief</h3>
      <p className="quiet">
        A brief is private. Your assigned Fellow adopts it by proposing the exact formulation; only
        then can you publish it.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setMessage(null);
          startTransition(async () => {
            const request = await briefRequestFromForm({
              title,
              statement,
              falsifier,
              motivation,
              areas,
              assignedFellowId: assignee,
            });
            if (request === null) {
              setMessage(
                "The brief is incomplete. Give a title, statement, falsifier, motivation and at least one area slug.",
              );
              return;
            }
            const result = await saveProblemBrief(request, `console-brief-${crypto.randomUUID()}`);
            setMessage(result.ok ? `Brief saved: ${result.value.title}.` : result.message);
            if (result.ok) router.refresh();
          });
        }}
      >
        <label>
          Title
          <input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label>
          Statement
          <textarea
            value={statement}
            rows={3}
            maxLength={8192}
            onChange={(event) => setStatement(event.target.value)}
          />
        </label>
        <label>
          Falsifier: what observation or construction would refute it?
          <textarea
            value={falsifier}
            rows={2}
            maxLength={8192}
            onChange={(event) => setFalsifier(event.target.value)}
          />
        </label>
        <label>
          Motivation
          <textarea
            value={motivation}
            rows={2}
            maxLength={8192}
            onChange={(event) => setMotivation(event.target.value)}
          />
        </label>
        <label>
          Areas (comma-separated slugs, e.g. number-theory)
          <input value={areas} onChange={(event) => setAreas(event.target.value)} />
        </label>
        <label>
          Assign to
          <select value={assignee} onChange={(event) => setAssignee(event.target.value)}>
            <option value="">No Fellow yet</option>
            {active.map((fellow) => (
              <option key={fellow.fellow_id} value={fellow.fellow_id}>
                {fellow.name}
              </option>
            ))}
          </select>
        </label>
        <div className="btn-row">
          <button className="btn-quiet" type="submit" disabled={pending}>
            Save brief
          </button>
        </div>
      </form>

      <h3>Briefs awaiting adoption</h3>
      {briefs.length === 0 ? (
        <p className="quiet">No active briefs.</p>
      ) : (
        <ul aria-label="Briefs awaiting adoption">
          {briefs.map((brief) => (
            <li key={brief.id}>
              <strong>{brief.title}</strong>{" "}
              <span className="quiet">
                {brief.assigned_fellow_id === undefined
                  ? "not assigned"
                  : `assigned to ${names.get(brief.assigned_fellow_id) ?? brief.assigned_fellow_id}`}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h3>Adopted drafts</h3>
      {drafts.length === 0 ? (
        <p className="quiet">No private drafts are waiting for publication.</p>
      ) : (
        <ul aria-label="Adopted private drafts">
          {drafts.map((problem) => (
            <li key={problem.id}>
              <strong>{problem.title}</strong>{" "}
              <span className="quiet">
                {problem.id} · statement v{problem.current_statement_version}
                {problem.created_by_fellow_id === null
                  ? ""
                  : ` · proposed by ${names.get(problem.created_by_fellow_id) ?? problem.created_by_fellow_id}`}
              </span>
              <label style={{ display: "block" }}>
                <input
                  type="checkbox"
                  checked={acknowledged[problem.id] === true}
                  onChange={(event) =>
                    setAcknowledged((prior) => ({ ...prior, [problem.id]: event.target.checked }))
                  }
                />{" "}
                I have read the exact formulation. Publishing makes it public, permanent and CC BY
                4.0, attributed to the proposing Fellow and to me as publisher.
              </label>
              <button
                className="btn-quiet"
                type="button"
                disabled={pending || acknowledged[problem.id] !== true}
                onClick={() => {
                  setMessage(null);
                  startTransition(async () => {
                    const result = await publishProblem(
                      problem.id,
                      acknowledged[problem.id] === true,
                      `console-publish-${problem.id}`,
                    );
                    setMessage(
                      result.ok
                        ? `${result.value.id} is now ${result.value.status}. Claims open after an independent statement review.`
                        : result.message,
                    );
                    if (result.ok) router.refresh();
                  });
                }}
              >
                Publish
              </button>
            </li>
          ))}
        </ul>
      )}

      <h3>Your published problems</h3>
      {published.length === 0 ? (
        <p className="quiet">None yet.</p>
      ) : (
        <ul aria-label="Your published problems">
          {published.map((problem) => (
            <li key={problem.id}>
              <a href={`/p/${problem.id}`}>{problem.title}</a>{" "}
              <span className="quiet">
                {problem.status}
                {problem.unlisted ? " · unlisted" : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      {message === null ? null : (
        <p role="status" aria-live="polite">
          {message}
        </p>
      )}
    </div>
  );
}
