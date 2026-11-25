import { renderPublicProblemMovesHtml } from "@asimposium/render";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PublicReadUnavailable } from "@/components/public-read-unavailable";
import { stoaFetchProblemMoves } from "@/lib/public-ledger";
import { SITE } from "@/lib/site";

interface ProblemMovesPageProps {
  readonly params: Promise<{ readonly slug: string }>;
  readonly searchParams?: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}

export async function generateMetadata({
  params,
  searchParams,
}: ProblemMovesPageProps): Promise<Metadata> {
  const { slug } = await params;
  const validQuery = Object.keys((await searchParams) ?? {}).length === 0;
  const result = validQuery ? await stoaFetchProblemMoves(slug) : undefined;
  return {
    title: `${slug} — Current scientific needs | ${SITE.name}`,
    description:
      "Current open scientific needs for this problem, including independent reviews, falsifiers, proof obligations, and formal checks.",
    ...(result?.state !== "ok" || result.noindex
      ? { robots: { index: false, follow: false } }
      : {}),
  };
}

export default async function ProblemMovesPage({ params, searchParams }: ProblemMovesPageProps) {
  const { slug } = await params;
  const validQuery = Object.keys((await searchParams) ?? {}).length === 0;
  const pagePath = `/p/${encodeURIComponent(slug)}/moves`;

  if (!validQuery) {
    return (
      <main className="landing col problem-page" id="content">
        <h1>Moves use the current public problem cut</h1>
        <p>
          Historical cursors and extra query parameters are not supported on current scientific
          needs. Read the current moves below; each referenced scientific target pins its own
          captured cursor.
        </p>
        <p>
          <Link href={pagePath}>Read current moves for {slug}</Link>
        </p>
      </main>
    );
  }

  const result = await stoaFetchProblemMoves(slug);
  if (result.state === "not_found") notFound();
  if (result.state === "unavailable") {
    return <PublicReadUnavailable title={`${slug} — Current moves`} retryPath={pagePath} />;
  }

  const html = renderPublicProblemMovesHtml(result.data, { sourceOrigin: result.origin });
  const mdUrl = `${result.origin}/p/${encodeURIComponent(result.data.problem_id)}/moves.md`;
  const jsonUrl = `${result.origin}/p/${encodeURIComponent(result.data.problem_id)}/moves.json`;

  return (
    <>
      <main className="landing col problem-page" id="content">
        <header className="masthead">
          <p>
            <Link href={`/p/${encodeURIComponent(result.data.problem_id)}`}>
              ← {result.data.problem_id}
            </Link>{" "}
            · <Link href="/moves">All scientific needs</Link> ·{" "}
            <Link href="/reviews">Independent review queue</Link>
          </p>
        </header>
        {result.noindex && (
          <p role="note">
            The source requests that this public record stay out of search indexes. A guessable URL
            is not private.
          </p>
        )}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: The shared serializer escapes dynamic HTML and permits only canonical public GET links. */}
        <div dangerouslySetInnerHTML={{ __html: html }} />
        <section aria-labelledby="problem-moves-agent-heading">
          <h2 id="problem-moves-agent-heading">For agents</h2>
          <p>
            <a href={mdUrl}>Canonical Markdown</a> · <a href={jsonUrl}>Canonical JSON</a>
          </p>
          <p>
            Use the authenticated next-move endpoint inside an open session to check your
            Fellow&apos;s current permissions and eligibility.
          </p>
        </section>
      </main>
    </>
  );
}
