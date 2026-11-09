"use client";

import type {
  SponsorFellowSummary,
  SponsorProblemBrief,
  SponsorProblemSummary,
} from "@asimposium/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { EditableProblemBrief, ProblemBriefEditor } from "./problem-brief-editor";

/**
 * Sponsor intent stays private until its assigned Fellow proposes a private
 * draft. Publication remains the separate reviewed lifecycle action.
 */
export function ProblemManager({
  sponsorId,
  fellows,
  briefs,
  briefsLoaded = true,
  problems,
  configured,
}: {
  readonly sponsorId: string;
  readonly fellows: readonly SponsorFellowSummary[];
  readonly briefs: readonly SponsorProblemBrief[];
  readonly briefsLoaded?: boolean;
  readonly problems: readonly SponsorProblemSummary[];
  readonly configured: boolean;
}) {
  const names = useMemo(
    () => new Map(fellows.map((fellow) => [fellow.fellow_id, fellow.name] as const)),
    [fellows],
  );
  const [message, setMessage] = useState<string | null>(null);
  const router = useRouter();
  const [editingBriefs, setEditingBriefs] = useState<ReadonlyMap<string, SponsorProblemBrief>>(
    () => new Map(),
  );

  if (!configured) {
    return (
      <p className="quiet">Problem briefs and publication are unavailable on this deployment.</p>
    );
  }

  const drafts = problems.filter((problem) => problem.status === "private-draft");
  const published = problems.filter((problem) => problem.status !== "private-draft");
  const listed = new Set(briefs.map((brief) => brief.id));
  // A refresh must not destroy an editor's unresolved command after a Fellow
  // adopts its brief or another tab withdraws it. Close only after a receipt or
  // the sponsor's explicit discard. The page keys this manager by sponsor.
  const displayed = [
    ...briefs,
    ...[...editingBriefs.values()].filter((brief) => !listed.has(brief.id)),
  ];

  return (
    <div>
      <h3>Write a brief</h3>
      <p className="quiet">
        A brief is private. Your assigned Fellow adopts it by proposing the exact formulation; only
        then can you publish it.
      </p>
      <ProblemBriefEditor sponsorId={sponsorId} fellows={fellows} onCommitted={setMessage} />

      <h3>Briefs awaiting adoption</h3>
      {!briefsLoaded ? (
        <p role="status">
          The current private brief list could not be loaded. Open editors and unconfirmed changes
          have been retained.{" "}
          <button className="btn-quiet" type="button" onClick={() => router.refresh()}>
            Reload brief list
          </button>
        </p>
      ) : null}
      {displayed.length === 0 && briefsLoaded ? (
        <p className="quiet">No active briefs.</p>
      ) : displayed.length > 0 ? (
        <ul aria-label="Briefs awaiting adoption">
          {displayed.map((brief) => (
            <EditableProblemBrief
              key={brief.id}
              sponsorId={sponsorId}
              brief={brief}
              fellows={fellows}
              currentAvailable={briefsLoaded && listed.has(brief.id)}
              onEditingChange={(editing) =>
                setEditingBriefs((previous) => {
                  const next = new Map(previous);
                  if (editing) next.set(brief.id, brief);
                  else next.delete(brief.id);
                  return next;
                })
              }
              onCommitted={setMessage}
            />
          ))}
        </ul>
      ) : null}

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
              <p>
                <Link href={`/console/problems/${encodeURIComponent(problem.id)}`} prefetch={false}>
                  Review the complete formulation and publication terms
                </Link>
                {" · "}
                <Link
                  href={`/console/problems/${encodeURIComponent(problem.id)}/revisions`}
                  prefetch={false}
                >
                  Review Fellow statement proposals
                </Link>
                {" · "}
                <Link
                  href={`/console/problems/${encodeURIComponent(problem.id)}/access`}
                  prefetch={false}
                >
                  Manage admission and members
                </Link>
              </p>
            </li>
          ))}
        </ul>
      )}

      <h3>Published problems you govern</h3>
      {published.length === 0 ? (
        <p className="quiet">None yet.</p>
      ) : (
        <ul aria-label="Published problems you govern">
          {published.map((problem) => (
            <li key={problem.id}>
              <a href={`/p/${problem.id}`}>{problem.title}</a>{" "}
              <span className="quiet">
                {problem.status}
                {problem.unlisted ? " · unlisted" : ""}
              </span>
              <p>
                <Link href={`/console/problems/${encodeURIComponent(problem.id)}`} prefetch={false}>
                  Review result claims and resolution
                </Link>
                {" · "}
                <Link
                  href={`/console/problems/${encodeURIComponent(problem.id)}/revisions`}
                  prefetch={false}
                >
                  Review Fellow statement proposals
                </Link>
                {" · "}
                <Link
                  href={`/console/problems/${encodeURIComponent(problem.id)}/access`}
                  prefetch={false}
                >
                  Manage admission and members
                </Link>
              </p>
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
