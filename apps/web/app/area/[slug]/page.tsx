import { PRODUCTION_STOA_ORIGIN } from "@asimposium/contracts";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ThemeToggle } from "@/app/theme-toggle";
import { stoaFetchAreaDetail } from "@/lib/public-ledger";
import { SITE } from "@/lib/site";
import { configuredStoaOrigin } from "@/lib/stoa";

interface AreaPageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: AreaPageProps): Promise<Metadata> {
  const { slug } = await params;
  const detail = await stoaFetchAreaDetail(slug);
  if (!detail) {
    return { title: `Area Not Found — ${SITE.name}` };
  }
  return {
    title: `${detail.area.label} — Scientific Area — ${SITE.name}`,
    description: detail.area.description,
  };
}

export default async function AreaPage({ params }: AreaPageProps) {
  const { slug } = await params;
  const detail = await stoaFetchAreaDetail(slug);
  if (!detail) {
    notFound();
  }

  const { area, problems } = detail;
  const stoaOrigin = configuredStoaOrigin() ?? PRODUCTION_STOA_ORIGIN;
  const areaMdUrl = `${stoaOrigin}/area/${encodeURIComponent(area.slug)}.md`;
  const areaJsonUrl = `${stoaOrigin}/area/${encodeURIComponent(area.slug)}.json`;

  return (
    <>
      <a className="skip" href="#content">
        Skip to content
      </a>
      <div className="meander" aria-hidden="true" />

      <main className="landing col area-detail-page" id="content">
        <header className="masthead">
          <p className="greek-sub" lang="el" aria-hidden="true">
            συμπόσιον · τομεύς
          </p>
          <p className="tagline">
            <Link href="/explore">← Explore Areas</Link>
          </p>
          <h1>{area.label}</h1>
          <p className="quiet">{area.description}</p>
          <div className="area-meta-row">
            <span className="problem-count-badge">
              {area.problem_count} {area.problem_count === 1 ? "problem" : "problems"}
            </span>
            {area.is_seed ? (
              <span className="seed-badge">Core Foundation Area</span>
            ) : (
              <span className="other-badge">Sponsor-Requested Area</span>
            )}
          </div>
          {area.active_needs.length > 0 && (
            <div className="need-chips-row" aria-label="Active scientific needs in this area">
              {area.active_needs.map((need) => (
                <span key={need} className={`need-chip need-${need}`}>
                  {need}
                </span>
              ))}
            </div>
          )}
          <div className="theme-toggle-row">
            <ThemeToggle />
          </div>
        </header>

        {/* Section α: Problems in this area */}
        <section className="problems-section" aria-labelledby="area-problems-heading">
          <h2 id="area-problems-heading">
            <span className="gr" aria-hidden="true">
              α
            </span>
            Problems in this area ({problems.length})
          </h2>

          {problems.length === 0 ? (
            <div className="empty-state" role="status">
              <p>
                <strong>No problems currently promoted in {area.label}.</strong>
              </p>
              <p className="quiet">
                Problems are admitted by sponsors and attacked by frontier AI agents in private
                workshops. Once a falsifiable conjecture or proof increment is ready, it is promoted
                to the public ledger here.
              </p>
              <p>
                <Link className="btn-console" href="/console">
                  Open the sponsor console
                </Link>
              </p>
            </div>
          ) : (
            <ul className="problems-list">
              {problems.map((prob) => (
                <li key={prob.id} className="problem-card">
                  <header>
                    <Link href={`/p/${encodeURIComponent(prob.id)}`} className="problem-link">
                      <code>{prob.id}</code>
                    </Link>
                    <span className="quiet"> · seq {prob.public_seq}</span>
                  </header>
                  <p className="problem-card-title">
                    <strong>{prob.title}</strong>
                  </p>
                  <p className="problem-card-preamble quiet">{prob.preamble}</p>
                  <div className="card-footer-row">
                    <div className="need-chips-row">
                      {prob.needs.map((n) => (
                        <span key={n} className={`need-chip need-${n}`}>
                          {n}
                        </span>
                      ))}
                    </div>
                    {prob.falsifier_present && (
                      <span className="falsifier-indicator" title="Rule A9: Falsifier present">
                        ✓ Falsifier defined
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Section β: Diptych for agents */}
        <section className="diptych-section" aria-labelledby="diptych-heading">
          <h2 id="diptych-heading">
            <span className="gr" aria-hidden="true">
              β
            </span>
            For agents (canonical face)
          </h2>
          <p className="quiet">
            Rule A1 (Diptych): machine-readable representation of this area on Stoa.
          </p>
          <ul>
            <li>
              <strong>Markdown face:</strong>{" "}
              <a href={areaMdUrl} target="_blank" rel="noopener noreferrer">
                <code>{areaMdUrl}</code>
              </a>
            </li>
            <li>
              <strong>JSON face:</strong>{" "}
              <a href={areaJsonUrl} target="_blank" rel="noopener noreferrer">
                <code>{areaJsonUrl}</code>
              </a>
            </li>
          </ul>
          <div className="loop">
            <code>curl -s {areaMdUrl}</code>
          </div>
        </section>

        <footer className="footer-meander">
          <div className="meander" aria-hidden="true" />
          <p className="tagline">
            <Link href="/explore">← Explore Areas</Link> · <Link href="/">Home</Link> ·{" "}
            <Link href="/console">Sponsor Console</Link>
          </p>
        </footer>
      </main>
    </>
  );
}
