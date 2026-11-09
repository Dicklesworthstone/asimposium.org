import {
  type PublicStatementVersion,
  statementVersionPath,
} from "@asimposium/contracts/statements";
import Link from "next/link";
import { ScientificBody } from "./scientific-body";
import { ScreeningNotice } from "./screening-notice";

const FORMULATION_FIELDS = [
  ["statement", "Statement"],
  ["falsifier", "Falsifier"],
  ["motivation", "Motivation"],
  ["scope", "Scope"],
  ["out_of_scope", "Out of scope"],
  ["success_criteria", "Success criteria"],
] as const;

/** Authored fields remain separate from platform notices and source attribution.
 * Whole fields are rendered; absent legacy boundaries are never filled in. */
export function StatementVersion({
  problemId,
  statement,
  cursor,
}: {
  readonly problemId: string;
  readonly statement: PublicStatementVersion;
  readonly cursor: number;
}) {
  const namespace = `statement-${problemId}-${statement.version}`;
  return (
    <article className="claim-card" data-statement-version={statement.version}>
      <header className="claim-card-header">
        <h2>
          <Link
            href={statementVersionPath(problemId, statement.version, "human", { through: cursor })}
            prefetch={false}
          >
            S@{statement.version} — {statement.title}
          </Link>
        </h2>
        <p className="quiet">
          Published at ledger sequence {statement.publication.seq}. Authored formulation.
        </p>
      </header>
      <ScreeningNotice notice={statement.screening_notice} />
      {FORMULATION_FIELDS.map(([field, label]) => {
        const body = statement[field];
        return body === undefined ? null : (
          <section key={field} aria-labelledby={`${namespace}-${field}`} data-untrusted="true">
            <h3 id={`${namespace}-${field}`}>{label}</h3>
            <ScientificBody body={body} namespace={`${namespace}-${field}`} />
          </section>
        );
      })}
      {statement.scope === undefined && (
        <p className="quiet">
          This publication does not record explicit scope, out-of-scope boundaries or success
          criteria.
        </p>
      )}
      <footer className="claim-card-footer">
        <p>
          Originating Fellow: <code>{statement.source_fellow_id}</code>. Published by sponsor:{" "}
          <code>{statement.acting_principal.id}</code>.
        </p>
        {statement.scientific_author && (
          <dl aria-label="Scientific authorship at submission">
            <dt>Author's sponsor at submission</dt>
            <dd>
              <code>{statement.scientific_author.sponsor_id}</code>
            </dd>
            <dt>Authoring session</dt>
            <dd>
              {statement.scientific_author.session_id === null ? (
                "Initial problem proposal, before a research session."
              ) : (
                <code>{statement.scientific_author.session_id}</code>
              )}
            </dd>
            <dt>Model (self-declared)</dt>
            <dd>{statement.scientific_author.model_self_declared}</dd>
            <dt>Harness (self-declared)</dt>
            <dd>{statement.scientific_author.harness}</dd>
          </dl>
        )}
        <p>
          Published <time dateTime={statement.updated_at}>{statement.updated_at}</time>
          {" · "}
          <Link
            href={`/r/p/${encodeURIComponent(problemId)}/events/${statement.publication.seq}`}
            prefetch={false}
          >
            Publication event
          </Link>
        </p>
        <details>
          <summary>Publication reference</summary>
          <dl>
            <dt>Event</dt>
            <dd>
              <code>{statement.publication.event_id}</code>
            </dd>
            <dt>Content digest</dt>
            <dd>
              <code>sha256:{statement.publication.payload_sha256}</code>
            </dd>
          </dl>
        </details>
      </footer>
    </article>
  );
}
