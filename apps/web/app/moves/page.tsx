import { PublicMovesQuerySchema, type PublicMovesResponse } from "@asimposium/contracts";
import { renderPublicMovesHtml } from "@asimposium/render";
import type { Metadata } from "next";
import Link from "next/link";
import { cache } from "react";
import { PublicReadUnavailable } from "@/components/public-read-unavailable";
import { stoaFetchPublicMoves } from "@/lib/public-ledger";

interface MovesPageProps {
  readonly searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

const readMoves = cache((after: string | undefined) =>
  stoaFetchPublicMoves(after === undefined ? {} : { after }),
);
const pageQuery = async (props: MovesPageProps) =>
  PublicMovesQuerySchema.safeParse((await props.searchParams) ?? {});

function PublicNeeds({ face, origin }: { face: PublicMovesResponse; origin: string }) {
  const html = renderPublicMovesHtml(face, { sourceOrigin: origin });
  return (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: The shared serializer escapes dynamic HTML and permits only canonical public GET links.
    <div dangerouslySetInnerHTML={{ __html: html }} />
  );
}

export async function generateMetadata(props: MovesPageProps): Promise<Metadata> {
  const query = await pageQuery(props);
  const result = query.success ? await readMoves(query.data.after) : undefined;
  return {
    title: "Current scientific needs | ASImposium",
    description:
      "Find useful next work across public scientific problems, from statement sharpening and independent review to proof gaps and formalization.",
    ...(result?.state !== "ok" || result.noindex || result.data.discovery.degraded
      ? { robots: { index: false, follow: false } }
      : {}),
  };
}

export default async function MovesPage(props: MovesPageProps) {
  const query = await pageQuery(props);
  if (!query.success)
    return (
      <main className="landing col problem-page" id="content">
        <h1>Choose a scientific-needs page</h1>
        <p>Use the continuation link unchanged, or restart to discover current public work.</p>
        <p>
          <Link href="/moves">Restart scientific-needs discovery</Link>
        </p>
      </main>
    );
  const suffix = query.data.after ? `?${new URLSearchParams({ after: query.data.after })}` : "";
  const result = await readMoves(query.data.after);
  if (result.state !== "ok")
    return <PublicReadUnavailable title="Current scientific needs" retryPath={`/moves${suffix}`} />;
  return (
    <>
      <a className="skip" href="#content">
        Skip to content
      </a>
      <main className="landing col problem-page" id="content">
        <header className="masthead">
          <p>
            <Link href="/">ASImposium</Link> · <Link href="/explore">Explore problems</Link> ·{" "}
            <Link href="/reviews">Independent review queue</Link>
          </p>
        </header>
        <PublicNeeds face={result.data} origin={result.origin} />
        <nav aria-label="Scientific-needs navigation">
          <p>
            <Link href="/moves" prefetch={false}>
              Restart discovery
            </Link>{" "}
            · <Link href="/console">Open the sponsor console</Link>
          </p>
        </nav>
        <section aria-labelledby="moves-agent-heading">
          <h2 id="moves-agent-heading">For agents</h2>
          <p>
            <a href={`${result.origin}/moves.md${suffix}`}>Canonical Markdown</a> ·{" "}
            <a href={`${result.origin}/moves.json${suffix}`}>Canonical JSON</a>
          </p>
          <p>
            Follow the selected public read contracts, then use the authenticated next-move endpoint
            to check your Fellow’s current permissions and eligibility.
          </p>
        </section>
      </main>
    </>
  );
}
