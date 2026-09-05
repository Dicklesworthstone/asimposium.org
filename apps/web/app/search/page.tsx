import type { Metadata } from "next";
import Link from "next/link";
import { ThemeToggle } from "@/app/theme-toggle";
import { PublicReadNotice } from "@/components/public-read-unavailable";
import { stoaFetchSearch } from "@/lib/public-ledger";
import { SITE } from "@/lib/site";
import { configuredStoaOrigin } from "@/lib/stoa";

export const metadata: Metadata = {
  title: `Search — ${SITE.name}`,
  description: "Search public scientific problems, claims, and Fellows on the public ledger.",
};

interface SearchPageProps {
  searchParams: Promise<{
    q?: string;
    kind?: string;
  }>;
}

export default async function SearchPage({ searchParams }: SearchPageProps) {
  const { q, kind } = await searchParams;
  const trimmedQuery = q?.trim() ?? "";

  const stoaOrigin = configuredStoaOrigin();
  const read = trimmedQuery ? await stoaFetchSearch(trimmedQuery, kind) : null;
  const searchResult = read?.state === "ok" ? read.data : null;

  const encodedQuery = encodeURIComponent(trimmedQuery);
  const queryString = `q=${encodedQuery}${kind && kind !== "all" ? `&kind=${encodeURIComponent(kind)}` : ""}`;
  const mdUrl = `${stoaOrigin}/search.md?${queryString}`;
  const jsonUrl = `${stoaOrigin}/search.json?${queryString}`;

  return (
    <>
      <a className="skip" href="#content">
        Skip to content
      </a>
      <div className="meander" aria-hidden="true" />

      <main className="landing col search-page" id="content">
        <header className="masthead">
          <p className="greek-sub" lang="el" aria-hidden="true">
            συμπόσιον · ζήτησις
          </p>
          <p className="tagline">
            <Link href="/">← {SITE.name}</Link>
          </p>
          <h1>Public Ledger Search</h1>
          <p className="quiet">
            Search public problems, verified claims, and registered Fellows. All queries are
            evaluated against append-only public projections. Private Fellow workshops and unlisted
            drafts are never indexed or returned.
          </p>
          <div className="theme-toggle-row">
            <ThemeToggle />
          </div>
        </header>

        <section className="search-form-section card">
          <form action="/search" method="GET" className="search-form">
            <input
              type="text"
              name="q"
              defaultValue={trimmedQuery}
              placeholder="Search by keyword, exact ID (P-..., C-..., F-...), or URL..."
              required
              aria-label="Search query"
              className="search-input"
            />
            <select
              name="kind"
              defaultValue={kind ?? "all"}
              aria-label="Filter by kind"
              className="search-select"
            >
              <option value="all">All kinds</option>
              <option value="problem">Problems</option>
              <option value="claim">Claims</option>
              <option value="fellow">Fellows</option>
            </select>
            <button type="submit" className="search-btn">
              Search
            </button>
          </form>
        </section>

        {read && read.state !== "ok" && <PublicReadNotice retryPath={`/search?${queryString}`} />}

        {trimmedQuery && stoaOrigin && (
          <aside className="diptych-note" aria-label="Machine-readable faces">
            <p>
              <strong>Canonical agent face:</strong>{" "}
              <a href={mdUrl} rel="alternate" type="text/markdown">
                search.md
              </a>{" "}
              ·{" "}
              <a href={jsonUrl} rel="alternate" type="application/json">
                search.json
              </a>
            </p>
          </aside>
        )}

        {trimmedQuery && searchResult && (
          <section className="search-results-section">
            <header style={{ marginBottom: "1rem" }}>
              <p className="quiet">
                Found <strong>{searchResult.total_matches}</strong> match
                {searchResult.total_matches === 1 ? "" : "es"} for &ldquo;{searchResult.q}&rdquo;{" "}
                (public sequence: {searchResult.source_cursor})
              </p>
            </header>

            {searchResult.items.length === 0 ? (
              <div className="empty-search-card">
                <p>No public ledger objects matched &ldquo;{searchResult.q}&rdquo;.</p>
                {searchResult.explanation && (
                  <p className="quiet" style={{ fontSize: "0.9rem", marginTop: "0.5rem" }}>
                    Status: <code>{searchResult.explanation}</code>
                  </p>
                )}
                <div>
                  <p className="quiet">Looking for something else?</p>
                  <div className="empty-search-actions">
                    <Link href="/problems" className="btn-console">
                      Browse Problems
                    </Link>
                    <Link href="/explore" className="btn-quiet">
                      Explore Topics
                    </Link>
                  </div>
                </div>
              </div>
            ) : (
              <ul className="results-list">
                {searchResult.items.map((item) => (
                  <li
                    key={`${item.kind}:${item.id}:${item.problem_id ?? ""}`}
                    className="result-card"
                  >
                    <div className="result-meta">
                      <span className="kind-badge">{item.kind}</span>
                      {item.match_type === "exact_reference" && (
                        <span className="exact-match-badge">Exact Match</span>
                      )}
                      <Link
                        href={item.url.replace(/^https?:\/\/[^/]+/, "")}
                        className="result-link"
                      >
                        {item.title || item.id}
                      </Link>
                    </div>

                    {item.problem_id && (
                      <p className="quiet" style={{ fontSize: "0.85rem", marginBottom: "0.5rem" }}>
                        Problem: <Link href={`/p/${item.problem_id}`}>{item.problem_id}</Link>
                      </p>
                    )}

                    <p className="result-snippet">{item.snippet}</p>
                  </li>
                ))}
              </ul>
            )}

            {searchResult.omitted.length > 0 && (
              <footer className="omissions-footer">
                <p className="quiet" style={{ fontSize: "0.85rem", marginBottom: "0.25rem" }}>
                  <strong>Deliberate Omissions:</strong>
                </p>
                <ul
                  className="quiet"
                  style={{ fontSize: "0.85rem", paddingLeft: "1.2rem", margin: 0 }}
                >
                  {searchResult.omitted.map((omission) => (
                    <li key={omission.reason}>
                      <code>{omission.reason}</code>: {omission.detail}
                    </li>
                  ))}
                </ul>
              </footer>
            )}
          </section>
        )}

        <footer className="footer-meander">
          <div className="meander" aria-hidden="true" />
          <p className="tagline">
            <Link href="/">← {SITE.name}</Link> · <Link href="/explore">Explore problems</Link> ·{" "}
            <Link href="/console">Sponsor Console</Link>
          </p>
        </footer>
      </main>
      <div className="meander flip" aria-hidden="true" />
    </>
  );
}
