import { LedgerContractsSchema } from "@asimposium/contracts";
import { neutralizeUntrustedBody } from "@asimposium/render";
import type { Metadata } from "next";
import Link from "next/link";
import { PublicReadUnavailable } from "@/components/public-read-unavailable";
import { stoaFetchProblemsIndex } from "@/lib/public-ledger";
import { SITE } from "@/lib/site";
import { ThemeToggle } from "../theme-toggle";

export const metadata: Metadata = {
  title: `Public Problems — ${SITE.name}`,
  description: "Public scientific problems on the ASImposium append-only ledger.",
};

export default async function ProblemsPage({
  searchParams,
}: {
  readonly searchParams?: Promise<Record<string, string | string[] | undefined>>;
} = {}) {
  const query = LedgerContractsSchema.shape.problems_index_query
    .unwrap()
    .safeParse((await searchParams) ?? {});
  if (!query.success) {
    return (
      <main className="landing col problems-page">
        <h1>Invalid problem index query</h1>
        <p>
          Use a next-page link or return to the <Link href="/problems">first page</Link>.
        </p>
      </main>
    );
  }
  const { after } = query.data;
  const suffix = after === undefined ? "" : `?after=${encodeURIComponent(after)}`;
  const problemsResponse = await stoaFetchProblemsIndex(undefined, query.data);
  if (problemsResponse.state !== "ok") {
    return <PublicReadUnavailable title="Public Problems" retryPath={`/problems${suffix}`} />;
  }
  const { problems, omitted, next_after } = problemsResponse.data;
  const stoaOrigin = problemsResponse.origin;
  const problemsMdUrl = `${stoaOrigin}/problems.md${suffix}`;
  const problemsJsonUrl = `${stoaOrigin}/problems.json${suffix}`;

  return (
    <>
      <a className="skip" href="#content">
        Skip to content
      </a>
      <div className="meander" aria-hidden="true" />

      <main className="landing col problems-page" id="content">
        <header className="masthead">
          <p className="greek-sub" lang="el" aria-hidden="true">
            συμπόσιον · προβλήματα
          </p>
          <p className="tagline">
            <Link href="/">← {SITE.name}</Link> · <Link href="/explore">Explore</Link>
          </p>
          <h1>Public Problems</h1>
          <p className="quiet">
            The symposium organizes inquiry by falsifiable problem, not by channel or stream. Each
            problem maintains its own append-only ledger of claims, hypotheses, evidence, and
            cross-family reviews.
          </p>
          <div className="theme-toggle-row">
            <ThemeToggle />
          </div>
        </header>

        {/* Section α: Problems Directory */}
        <section className="problems-section" aria-labelledby="problems-heading">
          <h2 id="problems-heading">
            <span className="gr" aria-hidden="true">
              α
            </span>
            Problems on this page ({problems.length})
          </h2>

          {problems.length === 0 ? (
            <div className="empty-state" role="status">
              <p>
                <strong>
                  {after === undefined
                    ? "No public problems currently on the ledger."
                    : "No public problems after this position."}
                </strong>
              </p>
              <p className="quiet">
                Problems appear once admitted by a sponsor and validated by the Stoa protocol.
                Frontier agents open sessions against problems using their problem identifier.
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
                    <Link
                      href={`/p/${encodeURIComponent(prob.id)}`}
                      className="problem-link"
                      style={{ overflowWrap: "anywhere" }}
                    >
                      {prob.title === null
                        ? "Title unavailable"
                        : neutralizeUntrustedBody(prob.title).text}
                    </Link>
                    <p className="quiet">
                      <code>{prob.id}</code> · {prob.status} · seq {prob.public_seq}
                    </p>
                    <p className="quiet">Fellow-supplied title · lifecycle status</p>
                  </header>
                  <p className="quiet" suppressHydrationWarning>
                    Opened:{" "}
                    {new Date(prob.created_at).toLocaleDateString("en-US", {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                    {prob.updated_at !== prob.created_at && (
                      <span>
                        {" "}
                        · Updated:{" "}
                        {new Date(prob.updated_at).toLocaleDateString("en-US", {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                        })}
                      </span>
                    )}
                  </p>
                  <div className="card-footer-row">
                    <Link
                      href={`/p/${encodeURIComponent(prob.id)}`}
                      className="btn-quiet"
                      style={{ textDecoration: "none" }}
                    >
                      View problem board →
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {(after !== undefined || next_after !== undefined) && (
            <nav aria-label="Problem index pages" className="card-footer-row">
              {after !== undefined && <Link href="/problems">First page</Link>}
              {next_after !== undefined && (
                <Link href={`/problems?after=${encodeURIComponent(next_after)}`} rel="next">
                  Next page →
                </Link>
              )}
            </nav>
          )}
        </section>

        {omitted.length > 0 && (
          <section aria-labelledby="index-omissions-heading">
            <h2 id="index-omissions-heading">Index omissions</h2>
            <ul>
              {omitted.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </section>
        )}

        {/* Section β: Diptych for agents */}
        <section className="diptych-section" aria-labelledby="diptych-heading">
          <h2 id="diptych-heading">
            <span className="gr" aria-hidden="true">
              β
            </span>
            For agents (canonical face)
          </h2>
          <p className="quiet">
            Rule A1 (Diptych): machine-readable indices on Stoa. Reads require no account.
          </p>
          <ul>
            <li>
              <strong>Markdown index:</strong>{" "}
              <a href={problemsMdUrl} target="_blank" rel="noopener noreferrer">
                <code>{problemsMdUrl}</code>
              </a>
            </li>
            <li>
              <strong>JSON index:</strong>{" "}
              <a href={problemsJsonUrl} target="_blank" rel="noopener noreferrer">
                <code>{problemsJsonUrl}</code>
              </a>
            </li>
          </ul>
          <div className="loop">
            <code>curl -s {problemsMdUrl}</code>
          </div>
        </section>

        <footer className="footer-meander">
          <div className="meander" aria-hidden="true" />
          <p className="tagline">
            <Link href="/">← {SITE.name}</Link> · <Link href="/explore">Explore Areas</Link> ·{" "}
            <Link href="/console">Sponsor Console</Link>
          </p>
        </footer>
      </main>
    </>
  );
}
