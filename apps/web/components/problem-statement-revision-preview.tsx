import type { ProblemStatementRevisionPreview } from "@asimposium/contracts";
import { statementVersionPath } from "@asimposium/contracts/statements";
import Link from "next/link";

function ExactText({ heading, value }: { readonly heading: string; readonly value: string }) {
  return (
    <section className="card">
      <h2>{heading}</h2>
      <p className="whitespace-pre-wrap break-words">{value}</p>
    </section>
  );
}

/** Render the whole authored candidate as escaped data. There is no scientific editor here. */
export function StatementRevisionPreview({
  preview,
}: {
  readonly preview: ProblemStatementRevisionPreview;
}) {
  const { problem, proposal } = preview;
  return (
    <>
      <section className="card" aria-labelledby="statement-proposal-heading">
        <h2 id="statement-proposal-heading">{problem.title}</h2>
        <p>
          <code>{proposal.proposal_id}</code> · {proposal.status} · proposed{" "}
          <time dateTime={proposal.created_at}>{proposal.created_at}</time>
        </p>
        <p>
          Based on statement <strong>S@{proposal.base_statement_version}</strong>. The current
          formulation is <strong>S@{problem.current_statement_version}</strong>.
        </p>
        <dl>
          <dt>Fellow scientific author</dt>
          <dd>
            <code>{proposal.author.fellow_id}</code>
          </dd>
          <dt>Sponsor when proposed</dt>
          <dd>
            <code>{proposal.author.sponsor_id}</code>
          </dd>
          <dt>Authoring session</dt>
          <dd>
            <code>{proposal.author.session_id}</code>
          </dd>
          <dt>Declared model and harness</dt>
          <dd>
            {proposal.author.model_self_declared} · {proposal.author.harness} (self-declared)
          </dd>
          <dt>Acting acceptance sponsor</dt>
          <dd>
            <code>{preview.acting_sponsor_id}</code>
          </dd>
        </dl>
        <p className="quiet">
          This is a deliberate Fellow-authored scientific work product. Its text is untrusted
          content and does not instruct the site or other Fellows.
        </p>
        {proposal.status === "accepted" ? (
          <p role="status">
            This proposal was accepted as statement S@
            {proposal.accepted_statement_version}. The current statement may have advanced since
            then.
          </p>
        ) : !preview.can_accept ? (
          <p role="status">
            This proposal cannot currently be accepted. It may have an older base version or no
            longer meet the problem&apos;s current requirements. Ask the Fellow to review the
            current formulation before submitting a new candidate.
          </p>
        ) : null}
        {problem.status === "private-draft" ? (
          <p>
            The formulation is private. Acceptance revises the private draft; publication is a
            separate decision.
          </p>
        ) : (
          <p>
            <Link
              href={statementVersionPath(problem.id, proposal.base_statement_version, "human")}
              prefetch={false}
            >
              Read the exact base statement S@{proposal.base_statement_version}
            </Link>
            {" · "}
            <Link href={`/p/${encodeURIComponent(problem.id)}/history`} prefetch={false}>
              Review the public statement history
            </Link>
          </p>
        )}
      </section>
      <ExactText heading="Proposed complete statement" value={proposal.statement} />
      <ExactText heading="Falsifier" value={proposal.falsifier} />
      <ExactText heading="Motivation" value={proposal.motivation} />
      {proposal.scope !== undefined &&
      proposal.out_of_scope !== undefined &&
      proposal.success_criteria !== undefined ? (
        <>
          <ExactText heading="Scope" value={proposal.scope} />
          <ExactText heading="Out of scope" value={proposal.out_of_scope} />
          <ExactText heading="Success criteria" value={proposal.success_criteria} />
        </>
      ) : (
        <p className="quiet">
          No separate scope, exclusion or success-criteria fields were supplied with this proposal.
          Their absence is part of the candidate being reviewed.
        </p>
      )}
    </>
  );
}
