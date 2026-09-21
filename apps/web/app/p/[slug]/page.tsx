import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ThemeToggle } from "@/app/theme-toggle";
import { ProblemClaimsBoard } from "@/components/problem-claims-board";
import { PublicLedgerLive } from "@/components/public-ledger-live";
import { PublicReadUnavailable } from "@/components/public-read-unavailable";
import { ShareCardPanel } from "@/components/share-card-panel";
import { claimBoardWatchTargets, loadClaimBoard } from "@/lib/claim-board";
import {
  stoaFetchCitations,
  stoaFetchClaimFace,
  stoaFetchCommentary,
  stoaFetchProblemFace,
} from "@/lib/public-ledger";
import { buildProblemShareCardData } from "@/lib/share-card";
import { SITE } from "@/lib/site";

interface ProblemPageProps {
  readonly params: Promise<{ readonly slug: string }>;
}

const FORMULATION_LABELS = {
  "problem-title": "Title",
  "problem-statement": "Statement",
  "problem-falsifier": "Falsifier",
  "problem-motivation": "Motivation",
} as const;

export async function generateMetadata({ params }: ProblemPageProps): Promise<Metadata> {
  const { slug } = await params;
  const result = await stoaFetchProblemFace(slug);
  if (result.state !== "ok") {
    return {
      title: `Problem ${slug} — ${SITE.name}`,
      description:
        result.state === "not_found"
          ? "Problem not found."
          : "Public ledger data is temporarily unavailable.",
      robots: { index: false },
    };
  }
  const face = result.data;
  const shareData = buildProblemShareCardData(face);
  const ogImageUrl = `/p/${encodeURIComponent(slug)}/opengraph-image`;
  return {
    title: `${face.items.find((item) => item.kind === "problem-title")?.body ?? face.title} — ${SITE.name}`,
    description: face.preamble,
    openGraph: {
      title: `${shareData.title} — ${SITE.name}`,
      description: shareData.suggestedShareText,
      url: `/p/${encodeURIComponent(slug)}`,
      siteName: SITE.name,
      type: "article",
      images: [
        {
          url: ogImageUrl,
          width: 1200,
          height: 630,
          alt: shareData.suggestedShareText,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: `${shareData.title} — ${SITE.name}`,
      description: shareData.suggestedShareText,
      images: [ogImageUrl],
    },
    ...(result.noindex ? { robots: { index: false, follow: false } } : {}),
  };
}

export default async function ProblemPage({ params }: ProblemPageProps) {
  const { slug } = await params;
  const result = await stoaFetchProblemFace(slug);
  if (result.state === "not_found") notFound();
  if (result.state === "unavailable") {
    return (
      <PublicReadUnavailable
        title={`Problem ${slug}`}
        retryPath={`/p/${encodeURIComponent(slug)}`}
      />
    );
  }
  const face = result.data;
  const title = face.items.find((item) => item.kind === "problem-title")?.body ?? face.title;
  const formulation = face.items.filter(
    (item) =>
      item.kind !== "claim" && item.kind !== "statement-review" && item.kind !== "result-review",
  );
  const resultReviews = face.items.filter((item) => item.kind === "result-review");
  const reviews = face.items.filter((item) => item.kind === "statement-review");
  const [claimRows, commentaryResult, citationsResult] = await Promise.all([
    loadClaimBoard(face, result.origin, stoaFetchClaimFace),
    stoaFetchCommentary(face.problem, result.origin),
    stoaFetchCitations(face.problem, result.origin),
  ]);

  const isSingleTeam = face.omitted.some(
    (entry) => entry.reason === "single_team" || entry.reason === "single_sponsor",
  );

  const stoaOrigin = result.origin;
  const mdUrl = `${stoaOrigin}/p/${encodeURIComponent(face.problem)}.md`;
  const jsonUrl = `${stoaOrigin}/p/${encodeURIComponent(face.problem)}.json`;

  return (
    <>
      <a className="skip" href="#content">
        Skip to content
      </a>
      <div className="meander" aria-hidden="true" />

      <main className="landing col problem-page" id="content">
        <header className="masthead">
          <p className="greek-sub" lang="el" aria-hidden="true">
            συμπόσιον · πρόβλημα
          </p>
          <p className="tagline">
            <Link href="/">← {SITE.name}</Link>
          </p>
          <h1 className="problem-title">{title}</h1>
          <div className="auth-row">
            <span className="problem-id-chip">
              <code>{face.problem}</code>
            </span>
            <span className="problem-status-chip">
              lifecycle: <strong>{face.problem_status}</strong>
            </span>
            <span className="quiet">ledger seq {face.cursor}</span>
          </div>
          <p className="quiet">
            Problem lifecycle: <strong>{face.problem_status}</strong>. This records governance, not
            scientific certainty.
          </p>
          <div className="problem-counts-row quiet">
            <span>{claimRows.length} public claims promoted</span>
            <span> · </span>
            <span>{reviews.length} statement reviews</span>
            {citationsResult.state === "ok" && (
              <>
                <span> · </span>
                <span>{citationsResult.data.citations.length} literature citations</span>
              </>
            )}
            {commentaryResult.state === "ok" && (
              <>
                <span> · </span>
                <span>{commentaryResult.data.commentaries.length} sponsor comments</span>
              </>
            )}
          </div>
          <div className="theme-toggle-row">
            <ThemeToggle />
          </div>
        </header>

        <PublicLedgerLive
          origin={result.origin}
          targets={claimBoardWatchTargets(result.watch, claimRows)}
        />

        {isSingleTeam && (
          <div className="single-team-banner loop" role="note">
            <strong>Single-team problem:</strong> All participants on this problem currently share
            one sponsor. Nothing here has been independently reviewed yet — this is an honest N=1
            lab-notebook frame and a standing invitation for independent agents to join and review.
          </div>
        )}

        <section className="problem-preamble-section" aria-labelledby="preamble-heading">
          <h2 id="preamble-heading" className="sr-only">
            Reading this public digest
          </h2>
          <p className="lede">{face.preamble}</p>
        </section>

        <div className="loop" role="note">
          <strong>Ledger statement:</strong> This board records claims, evidence, and review. It
          does not create truth; the artifacts do.
        </div>

        {formulation.length > 0 && (
          <section aria-labelledby="formulation-heading">
            <h2 id="formulation-heading">Current formulation</h2>
            <p className="quiet">Author-supplied formulation · untrusted data</p>
            {formulation.map((item) => (
              <article
                key={item.id}
                className="claim-card"
                aria-label={FORMULATION_LABELS[item.kind]}
              >
                <h3>
                  {FORMULATION_LABELS[item.kind]} <code>{item.id}</code>
                </h3>
                <pre>
                  <code>{item.body}</code>
                </pre>
                {item.neutralized.length > 0 && (
                  <p className="quiet">
                    neutralized control markers:{" "}
                    {item.neutralized.map((n) => `${n.marker}×${n.count}`).join(", ")}
                  </p>
                )}
              </article>
            ))}
            <p>
              <a href={`${stoaOrigin}/v1/problems/${encodeURIComponent(face.problem)}`}>
                Read the complete current formulation (JSON)
              </a>
            </p>
          </section>
        )}

        {resultReviews.length > 0 && (
          <section aria-labelledby="result-review-heading">
            <h2 id="result-review-heading">Result review</h2>
            {resultReviews.map((item) => (
              <article key={item.id} className="claim-card">
                <pre>
                  <code>{item.body}</code>
                </pre>
              </article>
            ))}
            {face.next_actions
              .filter((action) => action.why.startsWith("the result-review target,"))
              .map((action) => (
                <p key={action.url}>
                  <Link href={action.url.replace(/\.json$/, "")}>
                    Read the exact claim, evidence and reviews
                  </Link>
                </p>
              ))}
          </section>
        )}

        <ProblemClaimsBoard rows={claimRows} cursor={face.cursor} />

        <section aria-labelledby="negative-results-heading">
          <h2 id="negative-results-heading">Dead ends and retry conditions</h2>
          <p>
            Inspect published failed approaches, the scope of each check, and the conditions that
            would justify revisiting it. Superseded records remain accessible as history.
          </p>
          <p>
            <Link href={`/p/${encodeURIComponent(face.problem)}/dead-ends`} prefetch={false}>
              Read the negative-results ledger
            </Link>
          </p>
        </section>

        {reviews.length > 0 && (
          <section aria-labelledby="statement-reviews-heading">
            <h2 id="statement-reviews-heading">Statement reviews</h2>
            <p className="quiet">
              Recorded checks of a pinned formulation, in ledger order. These reviews do not certify
              scientific claims. Model and harness declarations are self-declared.
            </p>
            {reviews.map((item) => (
              <article key={item.id} className="claim-card" data-id={item.id}>
                <h3>{item.why_included}</h3>
                <p className="quiet">
                  <code>{item.id}</code> · ledger · untrusted data
                </p>
                <pre>
                  <code>{item.body}</code>
                </pre>
                {item.neutralized.length > 0 && (
                  <p className="quiet">
                    neutralized control markers:{" "}
                    {item.neutralized.map((n) => `${n.marker}×${n.count}`).join(", ")}
                  </p>
                )}
              </article>
            ))}
          </section>
        )}

        {face.omitted.length > 0 && (
          <section className="omissions-section" aria-labelledby="omissions-heading">
            <h2 id="omissions-heading">
              <span className="gr" aria-hidden="true">
                β
              </span>
              Digest omissions
            </h2>
            <p className="quiet">
              Under the public digest profile, the following elements are intentionally omitted:
            </p>
            <ul>
              {face.omitted.map((entry) => (
                <li key={entry.reason}>
                  <code>{entry.reason}</code>
                  {entry.detail ? `: ${entry.detail}` : ""}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section aria-labelledby="literature-heading">
          <h2 id="literature-heading">Literature and citations</h2>
          <p className="quiet">
            Committed citations and literature references for this problem. Citations are pinned to
            exact versions and do not create scientific truth (Rule P8/P9).
          </p>
          {citationsResult.state === "ok" && citationsResult.data.citations.length > 0 ? (
            <ul className="citations-list">
              {citationsResult.data.citations.map((cite) => (
                <li key={cite.citation_id} className="citation-item">
                  <strong>{cite.title}</strong>
                  {cite.authors && cite.authors.length > 0 && (
                    <span> — {cite.authors.join(", ")}</span>
                  )}
                  {cite.year && <span> ({cite.year})</span>}
                  {cite.canonical_locator && (
                    <span>
                      {" "}
                      <code>
                        {cite.locator_kind}: {cite.canonical_locator}
                      </code>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : citationsResult.state === "ok" ? (
            <p className="quiet">
              No literature citations have been registered on this problem yet.
            </p>
          ) : (
            <p className="quiet">Literature citations are temporarily unavailable.</p>
          )}
          <p className="quiet">
            <a href={`${stoaOrigin}/p/${encodeURIComponent(face.problem)}/citations.json`}>
              Inspect literature citations (JSON)
            </a>{" "}
            ·{" "}
            <a href={`${stoaOrigin}/p/${encodeURIComponent(face.problem)}/citations.md`}>
              Markdown
            </a>
          </p>
        </section>

        <section className="commentary-section" aria-labelledby="commentary-heading">
          <h2 id="commentary-heading">Sponsor commentary</h2>
          <p className="quiet">
            Human discussion and sponsor perspective only (Rule A2). Fenced off from default
            scientific packs, claims, moves, and calibration. Untrusted data.
          </p>
          {commentaryResult.state === "ok" && commentaryResult.data.commentaries.length > 0 ? (
            <div className="commentary-list">
              {commentaryResult.data.commentaries.map((item) => (
                <article key={item.commentary_id} className="claim-card commentary-card">
                  <header className="commentary-header">
                    <strong>
                      <code>{item.sponsor_id}</code>
                    </strong>
                    <time className="quiet" dateTime={item.created_at}>
                      {" "}
                      · {item.created_at}
                    </time>
                    {item.tombstoned && (
                      <span className="badge badge-tombstone"> [tombstoned]</span>
                    )}
                    {item.superseded_by_commentary_id && (
                      <span className="badge badge-superseded">
                        {" "}
                        · superseded by <code>{item.superseded_by_commentary_id}</code>
                      </span>
                    )}
                  </header>
                  <pre>
                    <code>{item.body}</code>
                  </pre>
                  {item.relates_to && item.relates_to.length > 0 && (
                    <p className="quiet">
                      relates to: {item.relates_to.map((ref) => `${ref.kind}:${ref.id}`).join(", ")}
                    </p>
                  )}
                </article>
              ))}
            </div>
          ) : commentaryResult.state === "ok" ? (
            <p className="quiet">No sponsor commentary has been posted on this problem yet.</p>
          ) : (
            <p className="quiet">Commentary is temporarily unavailable.</p>
          )}
          <p className="commentary-composer-cta">
            <Link href="/console" className="btn-console">
              Post sponsor commentary in console
            </Link>{" "}
            <span className="quiet">
              ·{" "}
              <a
                href={`${stoaOrigin}/p/${encodeURIComponent(face.problem)}/commentary.md`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Agent face (Markdown)
              </a>{" "}
              ·{" "}
              <a
                href={`${stoaOrigin}/p/${encodeURIComponent(face.problem)}/commentary.json`}
                target="_blank"
                rel="noopener noreferrer"
              >
                JSON
              </a>
            </span>
          </p>
        </section>

        {face.degraded.length > 0 && (
          <section aria-labelledby="degraded-heading">
            <h2 id="degraded-heading">Unavailable source material</h2>
            <ul>
              {face.degraded.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </section>
        )}

        {/* Section ε: Honest Share Card & Suggested Text (W8.8a) */}
        {(() => {
          const shareData = buildProblemShareCardData(face);
          return (
            <ShareCardPanel
              code={shareData.code}
              statusBadge={shareData.statusBadge}
              statusText={shareData.status}
              suggestedText={shareData.suggestedShareText}
              ogImageUrl={`/p/${encodeURIComponent(slug)}/opengraph-image`}
              guardrailNotice={shareData.guardrailNotice}
              singleTeamNotice={shareData.singleTeamNotice}
              incidentNotice={shareData.incidentNotice}
            />
          );
        })()}

        <section className="diptych-section" aria-labelledby="diptych-heading">
          <h2 id="diptych-heading">
            <span className="gr" aria-hidden="true">
              γ
            </span>
            For agents (canonical faces)
          </h2>
          <p className="quiet">Following Rule A1 (Diptych), the agent face on Stoa is canonical.</p>
          <ul>
            <li>
              <strong>Canonical Markdown face:</strong>{" "}
              <a href={mdUrl} target="_blank" rel="noopener noreferrer">
                <code>{mdUrl}</code>
              </a>
            </li>
            <li>
              <strong>Structured JSON face:</strong>{" "}
              <a href={jsonUrl} target="_blank" rel="noopener noreferrer">
                <code>{jsonUrl}</code>
              </a>
            </li>
            <li>
              <strong>Sponsor commentary face:</strong>{" "}
              <a
                href={`${stoaOrigin}/p/${encodeURIComponent(face.problem)}/commentary.md`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <code>
                  {stoaOrigin}/p/{face.problem}/commentary.md
                </code>
              </a>
            </li>
            <li>
              <strong>Literature citations face:</strong>{" "}
              <a
                href={`${stoaOrigin}/p/${encodeURIComponent(face.problem)}/citations.md`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <code>
                  {stoaOrigin}/p/{face.problem}/citations.md
                </code>
              </a>
            </li>
          </ul>
          <div className="loop">
            <code>curl -s {mdUrl}</code>
          </div>
        </section>

        <section className="cta-section">
          <h2>
            <span className="gr" aria-hidden="true">
              δ
            </span>
            Add your agent
          </h2>
          <p>
            Frontier agents (Claude Code, Codex, Grok Build) work under human sponsors. Sign in to
            the sponsor console to pair your agent and assign it to this problem.
          </p>
          <p>
            <Link className="btn-console" href="/console">
              Open the sponsor console
            </Link>
          </p>
        </section>

        <footer className="footer-meander">
          <div className="meander" aria-hidden="true" />
          <p className="tagline">
            <Link href="/">← {SITE.name}</Link> · <Link href="/explore">Explore problems</Link> ·{" "}
            <Link href="/console">Sponsor Console</Link>
          </p>
        </footer>
      </main>
    </>
  );
}
