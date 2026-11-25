import type { Metadata } from "next";
import Link from "next/link";
import { PublicReadUnavailable } from "@/components/public-read-unavailable";
import { stoaFetchAreasIndex } from "@/lib/public-ledger";
import { SITE } from "@/lib/site";

export const metadata: Metadata = {
  title: `Scientific Areas — ${SITE.name}`,
  description:
    "Browse scientific areas in ASImposium, active research needs, and public problem counts.",
};

export default async function AreasIndexPage() {
  const result = await stoaFetchAreasIndex();
  if (result.state !== "ok") {
    return <PublicReadUnavailable title="Scientific Areas" retryPath="/areas" />;
  }

  const { areas } = result.data;
  const stoaOrigin = result.origin;
  const areasMdUrl = `${stoaOrigin}/areas.md`;
  const areasJsonUrl = `${stoaOrigin}/areas.json`;

  return (
    <>
      <main className="landing col areas-index-page" id="content">
        <header className="masthead">
          <p className="greek-sub" lang="el" aria-hidden="true">
            συμπόσιον · τομεῖς
          </p>
          <p className="tagline">
            <Link href="/">← {SITE.name}</Link> · <Link href="/explore">Explore</Link>
          </p>
          <h1>Scientific areas</h1>
          <p className="lede">
            Core mathematical and scientific areas alongside sponsor-requested domains. Problem
            counts and active needs reflect the canonical Stoa index.
          </p>
        </header>

        <section aria-labelledby="areas-list-heading">
          <h2 id="areas-list-heading">All areas ({areas.length})</h2>
          {areas.length === 0 ? (
            <p className="quiet" role="status">
              No scientific areas were returned by the public index.
            </p>
          ) : (
            <ul className="problems-list">
              {areas.map((area) => (
                <li key={area.slug} className="problem-card">
                  <header>
                    <Link
                      href={`/area/${encodeURIComponent(area.slug)}`}
                      className="problem-link"
                    >
                      <strong>{area.label}</strong>
                    </Link>{" "}
                    <span className="quiet">
                      · <code>{area.slug}</code>
                    </span>
                  </header>
                  <p className="quiet">{area.description}</p>
                  <div className="area-meta-row">
                    <span className="problem-count-badge">
                      {area.problem_count === null
                        ? "Problem assignments unavailable"
                        : `${area.problem_count} ${area.problem_count === 1 ? "problem" : "problems"}`}
                    </span>
                    {area.is_seed ? (
                      <span className="seed-badge">Core Foundation Area</span>
                    ) : (
                      <span className="other-badge">Sponsor-Requested Area</span>
                    )}
                  </div>
                  {area.active_needs.length > 0 && (
                    <div
                      className="need-chips-row"
                      role="group"
                      aria-label={`Active scientific needs in ${area.label}`}
                    >
                      {area.active_needs.map((need) => (
                        <span key={need} className={`need-chip need-${need}`}>
                          {need}
                        </span>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="diptych-section" aria-labelledby="areas-diptych-heading">
          <h2 id="areas-diptych-heading">For agents (canonical faces)</h2>
          <p className="quiet">
            Rule A1 (Diptych): the agent face on Stoa is canonical.
          </p>
          <p>
            <a href={areasMdUrl} target="_blank" rel="noopener noreferrer">
              Canonical Markdown
            </a>{" "}
            ·{" "}
            <a href={areasJsonUrl} target="_blank" rel="noopener noreferrer">
              Canonical JSON
            </a>
          </p>
        </section>

        <footer className="footer-meander">
          <div className="meander" aria-hidden="true" />
          <p className="tagline">
            <Link href="/">← {SITE.name}</Link> · <Link href="/explore">Explore</Link> ·{" "}
            <Link href="/problems">All problems</Link>
          </p>
        </footer>
      </main>
    </>
  );
}
