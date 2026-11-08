import {
  StatementVersionQuerySchema,
  StatementVersionSelectorSchema,
  statementHistoryPath,
  statementHistoryQueryString,
  statementVersionPath,
} from "@asimposium/contracts/statements";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { PublicReadUnavailable } from "@/components/public-read-unavailable";
import { StatementVersion } from "@/components/statement-version";
import { stoaFetchStatementVersion } from "@/lib/public-statements";

interface StatementPageProps {
  readonly params: Promise<{ readonly slug: string; readonly version: string }>;
  readonly searchParams?: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}

const readStatement = cache((slug: string, version: string, query: string) =>
  stoaFetchStatementVersion(
    slug,
    version,
    undefined,
    Object.fromEntries(new URLSearchParams(query)),
  ),
);

async function pageInput({ params, searchParams }: StatementPageProps) {
  const { slug, version } = await params;
  return {
    slug,
    version: StatementVersionSelectorSchema.safeParse(version),
    query: StatementVersionQuerySchema.safeParse((await searchParams) ?? {}),
  };
}

export async function generateMetadata(props: StatementPageProps): Promise<Metadata> {
  const { slug, version, query } = await pageInput(props);
  const result =
    version.success && query.success
      ? await readStatement(slug, String(version.data), statementHistoryQueryString(query.data))
      : undefined;
  return {
    title: `${slug} — ${version.success ? `Statement S@${version.data}` : "Statement version"} | ASImposium`,
    description:
      "An exact published problem formulation with its original boundaries and publication reference.",
    ...(result?.state !== "ok" || result.noindex
      ? { robots: { index: false, follow: false } }
      : {}),
  };
}

export default async function StatementPage(props: StatementPageProps) {
  const { slug, version, query } = await pageInput(props);
  if (!version.success) notFound();
  if (!query.success)
    return (
      <main className="landing col problem-page" id="content">
        <h1>Invalid statement cursor</h1>
        <p>An exact statement version accepts one non-negative through cursor.</p>
        <p>
          <Link href={statementVersionPath(slug, version.data, "human")}>
            Read this published version
          </Link>
        </p>
      </main>
    );
  const result = await readStatement(
    slug,
    String(version.data),
    statementHistoryQueryString(query.data),
  );
  if (result.state === "not_found") notFound();
  if (result.state === "unavailable")
    return (
      <PublicReadUnavailable
        title={`${slug} — Statement S@${version.data}`}
        retryPath={statementVersionPath(slug, version.data, "human", query.data)}
      />
    );
  const face = result.data;
  const snapshot = { through: face.cursor };
  return (
    <>
      <a className="skip" href="#content">
        Skip to content
      </a>
      <main className="landing col problem-page" id="content">
        <header className="masthead">
          <nav aria-label="Breadcrumbs">
            <Link href={`/p/${encodeURIComponent(face.problem_id)}`}>{face.problem_id}</Link>
            {" / "}
            <Link href={statementHistoryPath(face.problem_id, "human", snapshot)} prefetch={false}>
              Statement history
            </Link>
          </nav>
          <h1>Statement S@{face.statement.version}</h1>
          <p className="lede">The complete formulation recorded in this exact public version.</p>
        </header>
        <p className="loop" role="note">
          Viewing ledger snapshot {face.cursor}. This historical formulation is not a scientific
          result or a claim that it remains the current question. Current visibility controls still
          apply.
        </p>
        {result.noindex && (
          <p role="note">The source requests that this public record stay out of search indexes.</p>
        )}
        <StatementVersion
          problemId={face.problem_id}
          statement={face.statement}
          cursor={face.cursor}
        />
        <nav aria-label="Statement version views">
          <Link
            href={statementVersionPath(face.problem_id, face.statement.version, "human", snapshot)}
            prefetch={false}
          >
            Link to this version at this snapshot
          </Link>
          {" · "}
          <Link href={statementHistoryPath(face.problem_id, "human", snapshot)} prefetch={false}>
            Published statement history
          </Link>
          {" · "}
          <Link href={`/p/${encodeURIComponent(face.problem_id)}`} prefetch={false}>
            Read the current problem
          </Link>
        </nav>
        <p>
          <a
            href={`${result.origin}${statementVersionPath(face.problem_id, face.statement.version, "md", snapshot)}`}
          >
            Canonical Markdown
          </a>
          {" · "}
          <a
            href={`${result.origin}${statementVersionPath(face.problem_id, face.statement.version, "json", snapshot)}`}
          >
            Canonical JSON
          </a>
        </p>
      </main>
    </>
  );
}
