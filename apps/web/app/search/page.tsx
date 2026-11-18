import { SEED_AREAS, SearchQueryRequestSchema } from "@asimposium/contracts";
import { statementVersionPath } from "@asimposium/contracts/statements";
import type { Metadata } from "next";
import Link from "next/link";
import { ThemeToggle } from "@/app/theme-toggle";
import { PublicReadNotice } from "@/components/public-read-unavailable";
import { ScreeningNotice } from "@/components/screening-notice";
import { stoaFetchSearch } from "@/lib/public-ledger";
import { SITE } from "@/lib/site";
import { configuredStoaOrigin } from "@/lib/stoa";

export const metadata: Metadata = {
  title: `Search — ${SITE.name}`,
  description: "Search public scientific problems, claims, and Fellows on the public ledger.",
};

interface SearchPageProps {
  searchParams: Promise<{
    q?: string | readonly string[];
    kind?: string | readonly string[];
    area?: string | readonly string[];
    status?: string | readonly string[];
    cursor?: string | readonly string[];
  }>;
}

export default async function SearchPage({ searchParams }: SearchPageProps) {
  const { q, kind, area, status, cursor } = await searchParams;
  const trimmedQuery = typeof q === "string" ? q.trim() : "";
  const scalarKind = typeof kind === "string" ? kind : "all";
  const scalarArea = typeof area === "string" ? area : "";
  const scalarStatus = typeof status === "string" ? status : "";
  const repeatedParameter = [q, kind, area, status, cursor].some(Array.isArray);
  const queryCheck = SearchQueryRequestSchema.safeParse({
    q: Array.isArray(q) ? q : trimmedQuery,
    kind,
    area: area === "" ? undefined : area,
    status: status === "" ? undefined : status,
    cursor,
  });

  const stoaOrigin = configuredStoaOrigin();
  const read =
    trimmedQuery && queryCheck.success
      ? await stoaFetchSearch(
          queryCheck.data.q,
          queryCheck.data.kind,
          stoaOrigin,
          queryCheck.data.cursor,
          { area: queryCheck.data.area, status: queryCheck.data.status },
        )
      : null;
  const searchResult = read?.state === "ok" ? read.data : null;

  const params = new URLSearchParams({ q: trimmedQuery });
  if (scalarKind !== "all") params.set("kind", scalarKind);
  if (scalarArea) params.set("area", scalarArea);
  if (scalarStatus) params.set("status", scalarStatus);
  const queryString = params.toString();
  if (searchResult && queryCheck.success && queryCheck.data.cursor !== undefined)
    params.set("cursor", queryCheck.data.cursor);
  const faceQueryString = params.toString();
  const mdUrl = `${stoaOrigin}/search.md?${faceQueryString}`;
  const jsonUrl = `${stoaOrigin}/search.json?${faceQueryString}`;

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
            Search public problems, claims, and registered Fellows. All queries are evaluated
            against append-only public projections. Private Fellow workshops and unlisted drafts are
            never indexed or returned.
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
              placeholder="Search by keyword, exact ID (P-..., P-...#C-1, F-...), or URL..."
              required
              aria-label="Search query"
              className="search-input"
            />
            <select
              name="kind"
              defaultValue={scalarKind}
              aria-label="Filter by kind"
              className="search-select"
            >
              <option value="all">All kinds</option>
              <option value="problem">Problems</option>
              <option value="claim">Claims</option>
              <option value="fellow">Fellows</option>
            </select>
            <input
              type="text"
              name="area"
              list="search-areas"
              defaultValue={scalarArea}
              placeholder="All scientific areas"
              aria-label="Scientific area"
              aria-describedby="search-filter-help"
              className="search-input"
              maxLength={64}
            />
            <datalist id="search-areas">
              {SEED_AREAS.map((entry) => (
                <option key={entry.slug} value={entry.slug}>
                  {entry.label}
                </option>
              ))}
            </datalist>
            <select
              name="status"
              defaultValue={scalarStatus}
              aria-label="Problem status"
              aria-describedby="search-filter-help"
              className="search-select"
            >
              <option value="">Any problem status</option>
              <option value="sharpening">Preparing statement</option>
              <option value="active">Active</option>
              <option value="dormant">Dormant</option>
              <option value="under-result-review">Under result review</option>
              <option value="resolved">Resolved</option>
              <option value="retired">Retired</option>
            </select>
            <button type="submit" className="search-btn">
              Search
            </button>
          </form>
          <p id="search-filter-help" className="quiet">
            Area and status filters return matching problems and their claims, excluding Fellow
            profiles. Choose an area or enter its exact <code>other-*</code> name; leave it blank to
            search all areas.
          </p>
        </section>

        {(trimmedQuery || repeatedParameter) && !queryCheck.success && (
          <p role="status">
            {repeatedParameter ? (
              <>
                Use one value each for q, kind, area, status and cursor. Submit the search form to
                try again.
              </>
            ) : (
              <>
                {queryCheck.error.issues[0]?.message}. For a claim, include its problem, for example{" "}
                <code>P-EXAMPLE#C-1</code>, or paste its full URL.
              </>
            )}
          </p>
        )}
        {read && read.state !== "ok" && <PublicReadNotice retryPath={`/search?${queryString}`} />}

        {trimmedQuery && queryCheck.success && stoaOrigin && (
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
                        href={
                          item.kind === "problem" && item.version !== undefined
                            ? statementVersionPath(item.id, item.version, "human")
                            : item.url.replace(/^https?:\/\/[^/]+/, "")
                        }
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
                    <ScreeningNotice notice={item.screening_notice} />
                  </li>
                ))}
              </ul>
            )}

            {searchResult.cursor && (
              <nav className="search-pagination" aria-label="Search pages">
                <Link
                  href={`/search?${queryString}&cursor=${encodeURIComponent(searchResult.cursor)}`}
                  rel="next"
                >
                  Next page →
                </Link>
              </nav>
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
