import {
  StatementHistoryQuerySchema,
  statementHistoryPath,
  statementHistoryQueryString,
} from "@asimposium/contracts/statements";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { PublicReadUnavailable } from "@/components/public-read-unavailable";
import { StatementVersion } from "@/components/statement-version";
import { stoaFetchStatementHistory } from "@/lib/public-statements";

interface StatementHistoryPageProps {
  readonly params: Promise<{ readonly slug: string }>;
  readonly searchParams?: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}

const readHistory = cache((slug: string, query: string) =>
  stoaFetchStatementHistory(slug, undefined, Object.fromEntries(new URLSearchParams(query))),
);

async function pageInput({ params, searchParams }: StatementHistoryPageProps) {
  const { slug } = await params;
  const parsed = StatementHistoryQuerySchema.safeParse((await searchParams) ?? {});
  return { slug, query: parsed.success ? parsed.data : null };
}

export async function generateMetadata(props: StatementHistoryPageProps): Promise<Metadata> {
  const { slug, query } = await pageInput(props);
  const result =
    query === null ? undefined : await readHistory(slug, statementHistoryQueryString(query));
  return {
    title: `${slug} — Statement history | ASImposium`,
    description:
      "Complete published problem formulations, their scope and success criteria, at exact ledger versions.",
    ...(result?.state !== "ok" || result.noindex
      ? { robots: { index: false, follow: false } }
      : {}),
  };
}

export default async function StatementHistoryPage(props: StatementHistoryPageProps) {
  const { slug, query } = await pageInput(props);
  if (query === null)
    return (
      <main className="landing col problem-page" id="content">
        <h1>Invalid statement history view</h1>
        <p>
          Use one non-negative through cursor and one optional after cursor. The after cursor cannot
          exceed through.
        </p>
        <p>
          <Link href={statementHistoryPath(slug, "human")}>
            Read the published statement history
          </Link>
        </p>
      </main>
    );
  const result = await readHistory(slug, statementHistoryQueryString(query));
  if (result.state === "not_found") notFound();
  if (result.state === "unavailable")
    return (
      <PublicReadUnavailable
        title={`${slug} — Statement history`}
        retryPath={statementHistoryPath(slug, "human", query)}
      />
    );
  const face = result.data;
  const snapshot = { through: face.cursor, after: face.after };
  return (
    <>
      <a className="skip" href="#content">
        Skip to content
      </a>
      <main className="landing col problem-page" id="content">
        <header className="masthead">
          <Link href={`/p/${encodeURIComponent(face.problem_id)}`}>← {face.problem_id}</Link>
          <h1>Statement history</h1>
          <p className="lede">
            Read how the published question, its scope and its success criteria changed.
          </p>
        </header>
        <p className="loop" role="note">
          These are complete published formulations in publication order. Private drafts are absent,
          and current visibility controls apply to every version. A formulation does not establish a
          scientific result.
        </p>
        <p className="quiet">
          Ledger snapshot {face.cursor}. {face.count} readable{" "}
          {face.count === 1 ? "version" : "versions"} on this page.
        </p>
        {result.noindex && (
          <p role="note">The source requests that this public record stay out of search indexes.</p>
        )}
        <nav aria-label="Statement history views">
          <Link href={statementHistoryPath(face.problem_id, "human", snapshot)} prefetch={false}>
            Link to this ledger snapshot
          </Link>
          {query.through !== undefined && (
            <>
              {" "}
              ·{" "}
              <Link href={statementHistoryPath(face.problem_id, "human")} prefetch={false}>
                Read the latest published history
              </Link>
            </>
          )}
          {face.after > 0 && (
            <>
              {" "}
              ·{" "}
              <Link
                href={statementHistoryPath(face.problem_id, "human", {
                  through: face.cursor,
                  after: 0,
                })}
                prefetch={false}
              >
                First published versions at this snapshot
              </Link>
            </>
          )}
        </nav>
        {face.statements.length === 0 && (
          <p>
            {face.omitted.includes("content_unavailable")
              ? "No readable versions were returned on this page. Some publications are unavailable; continue when a next page is available."
              : "No published statement versions were returned in this range."}
          </p>
        )}
        <ol className="claims-list">
          {face.statements.map((statement) => (
            <li key={statement.version}>
              <StatementVersion
                problemId={face.problem_id}
                statement={statement}
                cursor={face.cursor}
              />
            </li>
          ))}
        </ol>
        {face.next_after !== null && (
          <p>
            <Link
              href={statementHistoryPath(face.problem_id, "human", {
                through: face.cursor,
                after: face.next_after,
              })}
              prefetch={false}
            >
              Next published versions at this snapshot
            </Link>
          </p>
        )}
        {face.omitted.length > 0 && (
          <section aria-labelledby="statement-history-omissions">
            <h2 id="statement-history-omissions">Omissions and limits</h2>
            <ul>
              {face.omitted.map((reason) => (
                <li key={reason}>
                  {reason === "page_limit"
                    ? "This page is bounded. Continue at the same ledger snapshot to read later published versions."
                    : "Some published formulation content is unavailable under current visibility or source-integrity checks. No substitute version is shown."}
                </li>
              ))}
            </ul>
          </section>
        )}
        <p>
          <a href={`${result.origin}${statementHistoryPath(face.problem_id, "md", snapshot)}`}>
            Canonical Markdown
          </a>
          {" · "}
          <a href={`${result.origin}${statementHistoryPath(face.problem_id, "json", snapshot)}`}>
            Canonical JSON
          </a>
        </p>
      </main>
    </>
  );
}
