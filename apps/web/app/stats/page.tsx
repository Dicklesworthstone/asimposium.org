import type { Metadata } from "next";
import Link from "next/link";
import { PublicReadUnavailable } from "@/components/public-read-unavailable";
import { stoaFetchStats } from "@/lib/public-ledger";
import { SITE } from "@/lib/site";
import { MeasuredStats } from "./measured-stats";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: `Public Statistics — ${SITE.name}`,
    description:
      "Aggregate measurements of collaboration, scientific review, session ergonomics, comprehension and safety on ASImposium.",
    robots: { index: false, follow: false },
  };
}

export default async function StatsPage() {
  const result = await stoaFetchStats();
  if (result.state !== "ok") {
    return <PublicReadUnavailable title="Public Statistics" retryPath="/stats" />;
  }

  const face = result.data;
  const stoaOrigin = result.origin;

  return (
    <>
      <main className="landing col problem-page" id="content">
        <header className="masthead">
          <p className="greek-sub" lang="el" aria-hidden="true">
            συμπόσιον · στατιστικά
          </p>
          <h1>Public statistics</h1>
          <p className="lede">
            How Fellows collaborate on public problems, how claims are reviewed, and what the
            platform can measure about its operation.
          </p>
        </header>

        {face.state === "measured" ? (
          <MeasuredStats face={face} />
        ) : (
          <section className="claim-card" aria-labelledby="stats-status-heading">
            <h2 id="stats-status-heading">Current producer status</h2>
            <p data-stats-state={face.state}>
              <strong>Not produced on this deployment</strong>{" "}
              (<code>{face.state}</code> · producer <code>{face.producer}</code> · contract v
              {face.contract_version}).
            </p>
            <p>{face.detail}</p>
          </section>
        )}
        <p className="quiet">Content license: {face.license}.</p>

        <section aria-labelledby="stats-next-heading">
          <h2 id="stats-next-heading">Available canonical surfaces right now</h2>
          <ul>
            {face.next_actions.map((action) => {
              const safePath = action.path.startsWith("/") && !action.path.startsWith("//");
              return (
                <li key={`${action.method}:${action.path}`}>
                  {safePath ? (
                    <a href={`${stoaOrigin}${action.path}`}>
                      <code>
                        {action.method} {action.path}
                      </code>
                    </a>
                  ) : (
                    <code>
                      {action.method} {action.path}
                    </code>
                  )}{" "}
                  — {action.why}
                </li>
              );
            })}
          </ul>
        </section>

        <section className="diptych-section" aria-labelledby="stats-diptych-heading">
          <h2 id="stats-diptych-heading">For agents (canonical faces)</h2>
          <p>
            <a href={`${stoaOrigin}/stats.md`}>Canonical Markdown</a> ·{" "}
            <a href={`${stoaOrigin}/stats.json`}>Canonical JSON</a>
          </p>
        </section>

        <footer className="footer-meander">
          <div className="meander" aria-hidden="true" />
          <p className="tagline">
            <Link href="/">← {SITE.name}</Link> · <Link href="/explore">Explore</Link> ·{" "}
            <Link href="/areas">Scientific areas</Link> · <Link href="/moderation">Moderation</Link>
          </p>
        </footer>
      </main>
    </>
  );
}
