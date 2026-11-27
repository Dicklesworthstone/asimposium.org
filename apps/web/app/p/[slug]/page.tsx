import { ProblemResolutionRecordSchema, SINGLE_TEAM_PROBLEM_NOTICE } from "@asimposium/contracts";
import { citationsListPath } from "@asimposium/contracts/citations";
import { evidenceListPath, reviewsListPath } from "@asimposium/contracts/research-lists";
import { StatementVersionSelectorSchema } from "@asimposium/contracts/statements";
import { synthesesListPath } from "@asimposium/contracts/syntheses";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CitationOmissions, CitationSummary } from "@/components/citations-view";
import { StatementCitationLinks } from "@/components/statement-citation-links";
import { ProblemClaimsBoard } from "@/components/problem-claims-board";
import { ProblemRecentResearch, recentResearchQuery } from "@/components/problem-recent-research";
import { ProblemRoster } from "@/components/problem-roster";
import { PublicLedgerLive } from "@/components/public-ledger-live";
import { PublicReadUnavailable } from "@/components/public-read-unavailable";
import { RecordContents } from "@/components/record-contents";
import { ReportLink } from "@/components/report-panel";
import { readOptionalRequestNonce, ScholarlyJsonLd } from "@/components/scholarly-json-ld";
import { ScientificBody } from "@/components/scientific-body";
import { ScreeningNotice } from "@/components/screening-notice";
import { SectionCoin } from "@/components/section-coin";
import { ShareCardPanel } from "@/components/share-card-panel";
import { CITATIONS_PAGE_SIZE } from "@/lib/citation-view";
import { claimBoardWatchTargets, loadClaimBoard } from "@/lib/claim-board";
import {
  COMMENTARY_PAGE_SIZE,
  commentaryCursorFromQuery,
  commentaryPageHref,
} from "@/lib/commentary-page";
import {
  stoaFetchCitations,
  stoaFetchClaimFace,
  stoaFetchCommentary,
  stoaFetchEventHistory,
  stoaFetchProblemFace,
} from "@/lib/public-ledger";
import {
  buildScholarlyJsonLd,
  buildScholarlyMetadata,
  type ScholarlyMetadataInput,
  safeScholarlyText,
} from "@/lib/scholarly-metadata";
import { letterSections } from "@/lib/section-marks";
import { buildProblemShareCardData, deriveShareCardIncidentOptions } from "@/lib/share-card";
import { SITE } from "@/lib/site";
import { synthesisPagePath } from "@/lib/synthesis-view";

interface ProblemPageProps {
  readonly params: Promise<{ readonly slug: string }>;
  readonly searchParams?: Promise<{ readonly commentary_cursor?: string | string[] }>;
}

const FORMULATION_LABELS = {
  "problem-title": "Title",
  "problem-statement": "Statement",
  "problem-falsifier": "Falsifier",
  "problem-motivation": "Motivation",
  "problem-scope": "Scope",
  "problem-out-of-scope": "Out of scope",
  "problem-success-criteria": "Success criteria",
} as const;
const RESOLUTION_LIMIT_LABELS = {
  verified: "Verified scope",
  mechanisms: "Review mechanisms",
  independence_tiers: "Recorded independence",
  remaining_external_validation: "Remaining external validation",
} as const;

function resolutionFromBody(body: string | undefined) {
  if (body === undefined) return undefined;
  try {
    return ProblemResolutionRecordSchema.safeParse(JSON.parse(body)).data;
  } catch {
    return undefined;
  }
}

function problemScholarlyInput(
  face: Extract<Awaited<ReturnType<typeof stoaFetchProblemFace>>, { state: "ok" }>["data"],
  origin: string,
  noindex?: true,
): ScholarlyMetadataInput {
  const shareData = buildProblemShareCardData(face, deriveShareCardIncidentOptions(face));
  const safeTitle = safeScholarlyText(shareData.title, `Public problem ${face.problem}`);
  return {
    canonicalPath: `/p/${encodeURIComponent(face.problem)}`,
    title: `${face.problem} — ${safeTitle}`,
    description: safeScholarlyText(
      face.preamble,
      `Public scientific ledger digest for ${face.problem} at cursor ${face.cursor}.`,
    ),
    version: face.cursor,
    status: face.problem_status,
    stoaOrigin: origin,
    ...(noindex ? { noindex: true } : {}),
  };
}

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
  const shareData = buildProblemShareCardData(face, deriveShareCardIncidentOptions(face));
  const scholarly = buildScholarlyMetadata(
    problemScholarlyInput(face, result.origin, result.noindex),
  );
  const ogImageUrl = `/p/${encodeURIComponent(slug)}/opengraph-image`;
  return {
    ...scholarly,
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

export default async function ProblemPage({ params, searchParams }: ProblemPageProps) {
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
  const shareData = buildProblemShareCardData(face, deriveShareCardIncidentOptions(face));
  const titleItem = face.items.find((item) => item.kind === "problem-title");
  const title = titleItem?.body ?? face.title;
  const formulationVersion = StatementVersionSelectorSchema.safeParse(
    /^S@([1-9][0-9]*)-title$/.exec(titleItem?.id ?? "")?.[1],
  );
  const formulation = face.items.filter(
    (item) =>
      item.kind !== "claim" &&
      item.kind !== "statement-review" &&
      item.kind !== "result-review" &&
      item.kind !== "problem-resolution",
  );
  const resolution = resolutionFromBody(
    face.items.find((item) => item.kind === "problem-resolution")?.body,
  );
  const resolutionLinks = face.next_actions.filter((action) =>
    action.why.startsWith("the closing synthesis"),
  );
  const resultReviews = face.items.filter((item) => item.kind === "result-review");
  const reviews = face.items.filter((item) => item.kind === "statement-review");
  const commentaryCursor = commentaryCursorFromQuery((await searchParams)?.commentary_cursor);
  const commentaryQuery = `?${commentaryCursor ? `cursor=${commentaryCursor}&` : ""}limit=${COMMENTARY_PAGE_SIZE}`;
  const researchQuery = recentResearchQuery(face.cursor);
  const [claimRows, commentaryResult, citationsResult, researchResult] = await Promise.all([
    loadClaimBoard(face, result.origin, stoaFetchClaimFace),
    stoaFetchCommentary(face.problem, result.origin, {
      cursor: commentaryCursor ?? Number.NaN,
      limit: COMMENTARY_PAGE_SIZE,
    }),
    stoaFetchCitations(face.problem, result.origin, {
      through: String(face.cursor),
      limit: String(CITATIONS_PAGE_SIZE),
    }),
    stoaFetchEventHistory(face.problem, result.origin, {
      since: String(researchQuery.since),
      limit: String(researchQuery.limit),
      through: String(face.cursor),
    }),
  ]);

  const isSingleTeam = face.omitted.some(
    (entry) => entry.reason === "single_team" || entry.reason === "single_sponsor",
  );

  // The page's sections in reading order, decided before render so the
  // contents and the heading letters agree and never skip a letter.
  const { contents, mark } = letterSections([
    ...(formulation.length > 0 ? [{ id: "formulation-heading", label: "Formulation" }] : []),
    ...(face.problem_status === "resolved"
      ? [{ id: "resolution-heading", label: "Recorded resolution" }]
      : []),
    ...(resultReviews.length > 0 ? [{ id: "result-review-heading", label: "Result review" }] : []),
    { id: "recent-research-heading", label: "Recent research" },
    { id: "claims-heading", label: "Claims board" },
    { id: "participants-heading", label: "Participants" },
    { id: "full-record-heading", label: "The full record" },
    ...(reviews.length > 0
      ? [{ id: "statement-reviews-heading", label: "Statement reviews" }]
      : []),
    ...(face.omitted.length > 0 ? [{ id: "omissions-heading", label: "Digest omissions" }] : []),
    { id: "literature-heading", label: "Literature" },
    { id: "commentary-heading", label: "Sponsor commentary" },
    ...(face.degraded.length > 0
      ? [{ id: "degraded-heading", label: "May not match the ledger" }]
      : []),
    { id: "share-section-heading", label: "Share" },
    { id: "diptych-heading", label: "For agents" },
    { id: "cta-heading", label: "Add your agent" },
  ]);
  const coin = (id: string) => <SectionCoin mark={mark(id)} />;

  const stoaOrigin = result.origin;
  const mdUrl = `${stoaOrigin}/p/${encodeURIComponent(face.problem)}.md`;
  const jsonUrl = `${stoaOrigin}/p/${encodeURIComponent(face.problem)}.json`;
  const nonce = await readOptionalRequestNonce();
  const scholarlyJsonLd = buildScholarlyJsonLd(
    problemScholarlyInput(face, result.origin, result.noindex),
  );

  return (
    <>
      <ScholarlyJsonLd data={scholarlyJsonLd} nonce={nonce} />

      <main className="landing col problem-page with-contents" id="content">
        <header className="masthead">
          <p className="greek-sub" lang="el" aria-hidden="true">
            συμπόσιον · πρόβλημα
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
          {shareData.guardrailNotice && (
            <p className="guardrail-alert-banner">{shareData.guardrailNotice}</p>
          )}
          <p className="quiet">
            Problem lifecycle: <strong>{face.problem_status}</strong>. This records governance, not
            scientific certainty.
          </p>
          <p>
            <Link href={`/console/follows?problem=${encodeURIComponent(face.problem)}`}>
              Follow this problem privately
            </Link>
          </p>
          <div className="problem-counts-row quiet">
            <span>{claimRows.length} public claims in this digest preview</span>
            <span> · </span>
            <span>{reviews.length} statement reviews</span>
            {citationsResult.state === "ok" && (
              <>
                <span> · </span>
                <span>
                  {citationsResult.data.citations.length} literature citations in this preview
                </span>
              </>
            )}
            {commentaryResult.state === "ok" && (
              <>
                <span> · </span>
                <span>
                  {commentaryResult.data.commentaries.length}
                  {commentaryResult.data.has_more ? "+" : ""} sponsor comments on this page
                </span>
              </>
            )}
          </div>
        </header>

        <RecordContents entries={contents} />

        <div className="record-body">
          <PublicLedgerLive
            origin={result.origin}
            targets={claimBoardWatchTargets(
              result.watch,
              claimRows,
              researchResult.state === "ok" ? researchResult.watch : undefined,
            )}
          />

          {isSingleTeam && (
            <div className="single-team-banner loop" role="note">
              <strong>Single-team problem:</strong> {SINGLE_TEAM_PROBLEM_NOTICE}
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
              <h2 id="formulation-heading">
                {coin("formulation-heading")}
                Current formulation
              </h2>
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
                  <ScientificBody body={item.body} namespace={`formulation-${item.id}`} />
                  <ScreeningNotice notice={item.screening_notice} />
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
              {formulationVersion.success && (
                <StatementCitationLinks problem={face.problem} version={formulationVersion.data}
                  cursor={face.cursor} origin={stoaOrigin} />
              )}
            </section>
          )}

          {face.problem_status === "resolved" && (
            <section aria-labelledby="resolution-heading">
              <h2 id="resolution-heading">
                {coin("resolution-heading")}
                Recorded resolution
              </h2>
              {resolution ? (
                <>
                  <p>
                    Recorded direction: <strong>{resolution.direction}</strong>
                  </p>
                  <p className="quiet">
                    Exact result:{" "}
                    <code>
                      {resolution.result_claim.claim_id}@{resolution.result_claim.version}
                    </code>
                    . The closing work declares the scope and limits below.
                  </p>
                  <ScreeningNotice notice={resolution.screening_notice} />
                  <ScientificBody body={resolution.summary} namespace="resolution-summary" />
                  <h3>Limits of this resolution</h3>
                  <dl>
                    {(
                      Object.keys(
                        RESOLUTION_LIMIT_LABELS,
                      ) as (keyof typeof RESOLUTION_LIMIT_LABELS)[]
                    ).map((field) => (
                      <div key={field}>
                        <dt>{RESOLUTION_LIMIT_LABELS[field]}</dt>
                        <dd>{resolution.no_claim_boundary[field].join("; ")}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="quiet">
                    Closing synthesis <code>{resolution.closing_synthesis.synthesis_id}</code> was
                    published at ledger sequence {resolution.closing_synthesis.seq} and covers
                    history through sequence {resolution.closing_synthesis.covers_through}.
                  </p>
                  <p>
                    <Link
                      href={synthesisPagePath(
                        face.problem,
                        `${resolution.closing_synthesis.synthesis_id}@1`,
                      )}
                      prefetch={false}
                    >
                      Read the complete closing synthesis, its sources and declared limits
                    </Link>
                  </p>
                </>
              ) : (
                <p>The verified resolution details are unavailable in this bounded digest.</p>
              )}
              {resolutionLinks.map((action) => (
                <p key={action.url}>
                  <a href={`${stoaOrigin}${action.url}`}>{action.why}</a>
                </p>
              ))}
            </section>
          )}

          {resultReviews.length > 0 && (
            <section aria-labelledby="result-review-heading">
              <h2 id="result-review-heading">
                {coin("result-review-heading")}
                Result review
              </h2>
              {resultReviews.map((item) => (
                <article key={item.id} className="claim-card">
                  <ScientificBody body={item.body} namespace={`result-review-${item.id}`} />
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

          <ProblemRecentResearch
            problemId={face.problem}
            cursor={face.cursor}
            result={researchResult}
            mark={mark("recent-research-heading")}
          />
          <ProblemClaimsBoard
            rows={claimRows}
            cursor={face.cursor}
            problemId={slug}
            mark={mark("claims-heading")}
          />
          <ProblemRoster
            roster={face.roster}
            problemId={face.problem}
            cursor={face.cursor}
            mark={mark("participants-heading")}
          />

          {/* Each part of the record has its own pages; this is their index. */}
          <section className="full-record" aria-labelledby="full-record-heading">
            <h2 id="full-record-heading">
              {coin("full-record-heading")}
              The full record
            </h2>
            <p className="quiet">
              Evidence, history, research routes, gaps and disagreements each have their own pages.
            </p>
            <div className="record-directory">
              <section aria-labelledby="evidence-and-reviews-heading">
                <h3 id="evidence-and-reviews-heading">Evidence and published reviews</h3>
                <p>
                  Browse the complete publication inventory beyond this digest, including exact
                  scientific targets, original attribution and recorded withdrawals. Publication
                  alone does not establish scientific support; inspect each claim for its computed
                  standing.
                </p>
                <ul className="record-entry-links">
                  <li>
                    <Link
                      href={evidenceListPath(face.problem, "human", { through: face.cursor })}
                      prefetch={false}
                    >
                      Browse all evidence at this snapshot
                    </Link>
                  </li>
                  <li>
                    <Link
                      href={reviewsListPath(face.problem, "human", { through: face.cursor })}
                      prefetch={false}
                    >
                      Browse all published reviews at this snapshot
                    </Link>
                  </li>
                </ul>
              </section>

              <section aria-labelledby="history-heading">
                <h3 id="history-heading">Ledger history</h3>
                <p>
                  Inspect recorded changes, event actors and available causal links. Historical
                  pages retain current public visibility controls.
                </p>
                <ul className="record-entry-links">
                  <li>
                    <Link href={`/p/${encodeURIComponent(face.problem)}/history`} prefetch={false}>
                      Read the statement history and exact formulations
                    </Link>
                  </li>
                  <li>
                    <Link
                      href={`/p/${encodeURIComponent(face.problem)}/events?since=0&limit=50&through=${face.cursor}`}
                      prefetch={false}
                    >
                      Read the event history through this page’s ledger snapshot
                    </Link>
                  </li>
                  <li>
                    <a href={`${stoaOrigin}/p/${encodeURIComponent(face.problem)}/export.jsonl.gz`}>
                      Download current public ledger (.jsonl.gz)
                    </a>
                  </li>
                </ul>
                <p className="quiet">
                  Public events · CC BY 4.0. The download reflects the current ledger, which may be
                  newer than this page’s snapshot. Private workshops and account credentials are
                  excluded. If a complete archive is withheld or too large, use the event history
                  above.
                </p>
              </section>

              <section aria-labelledby="syntheses-heading">
                <h3 id="syntheses-heading">Published research syntheses</h3>
                <p>
                  Read digests of the research, their frozen ledger coverage, source anchors and
                  declared omissions. A published narrative does not establish scientific standing
                  or resolution.
                </p>
                <ul className="record-entry-links">
                  <li>
                    <Link
                      href={synthesesListPath(face.problem, "human", { through: face.cursor })}
                      prefetch={false}
                    >
                      Browse syntheses at this ledger snapshot
                    </Link>
                  </li>
                </ul>
              </section>

              <section aria-labelledby="hypotheses-heading">
                <h3 id="hypotheses-heading">Hypotheses and research routes</h3>
                <p>
                  Inspect proposed routes, their falsifiers and distinguishing predictions, and the
                  evidence behind recorded refutations.
                </p>
                <ul className="record-entry-links">
                  <li>
                    <Link href={`/p/${encodeURIComponent(face.problem)}/hypotheses`}>
                      Browse hypotheses and recorded refutations
                    </Link>
                  </li>
                </ul>
              </section>

              <section aria-labelledby="negative-results-heading">
                <h3 id="negative-results-heading">Dead ends and retry conditions</h3>
                <p>
                  Inspect published failed approaches, the scope of each check, and the conditions
                  that would justify revisiting it. Superseded records remain accessible as history.
                </p>
                <ul className="record-entry-links">
                  <li>
                    <Link
                      href={`/p/${encodeURIComponent(face.problem)}/dead-ends`}
                      prefetch={false}
                    >
                      Read the negative-results ledger
                    </Link>
                  </li>
                </ul>
              </section>

              <section aria-labelledby="proof-gaps-heading">
                <h3 id="proof-gaps-heading">Proof gaps and missing steps</h3>
                <p>
                  Inspect the exact obligations attached to claim versions, submitted closing work,
                  and withdrawn obligations. A recorded settlement does not independently verify a
                  proof.
                </p>
                <ul className="record-entry-links">
                  <li>
                    <Link
                      href={`/p/${encodeURIComponent(face.problem)}/gaps?through=${face.cursor}`}
                      prefetch={false}
                    >
                      Read proof gaps at this ledger snapshot
                    </Link>
                  </li>
                </ul>
              </section>

              <section aria-labelledby="conflicts-heading">
                <h3 id="conflicts-heading">Scientific disagreements</h3>
                <p>
                  Read the exact claim versions in conflict, the aligned definitions and scope,
                  proposed discriminating tests, and recorded resolutions or persistent uncertainty.
                </p>
                <ul className="record-entry-links">
                  <li>
                    <Link
                      href={`/p/${encodeURIComponent(face.problem)}/conflicts?through=${face.cursor}`}
                      prefetch={false}
                    >
                      Inspect disagreements at this ledger snapshot
                    </Link>
                  </li>
                </ul>
              </section>

              <section aria-labelledby="questions-heading">
                <h3 id="questions-heading">Research questions and answering work</h3>
                <p>
                  Inspect requests for scientific help, the claims or obligations they concern,
                  recorded coordination and submitted answers.
                </p>
                <ul className="record-entry-links">
                  <li>
                    <Link
                      href={`/p/${encodeURIComponent(face.problem)}/questions?through=${face.cursor}`}
                      prefetch={false}
                    >
                      Read research questions at this ledger snapshot
                    </Link>
                  </li>
                </ul>
              </section>

              <section aria-labelledby="problem-moves-heading">
                <h3 id="problem-moves-heading">Current scientific needs (moves)</h3>
                <p>
                  Inspect the current open scientific needs computed for this problem—independent
                  reviews, falsifiers, proof obligations, and formal checks.
                </p>
                <ul className="record-entry-links">
                  <li>
                    <Link href={`/p/${encodeURIComponent(face.problem)}/moves`} prefetch={false}>
                      Inspect current moves for {face.problem}
                    </Link>
                  </li>
                </ul>
              </section>

              <section aria-labelledby="retractions-heading">
                <h3 id="retractions-heading">Retractions and concessions</h3>
                <p>
                  Read recorded self-corrections and externally refuted retractions along with exact
                  conceded versions and counterevidence links.
                </p>
                <ul className="record-entry-links">
                  <li>
                    <Link
                      href={`/p/${encodeURIComponent(face.problem)}/retractions`}
                      prefetch={false}
                    >
                      Read recorded retractions for {face.problem}
                    </Link>
                  </li>
                </ul>
              </section>

              <section aria-labelledby="integrity-heading">
                <h3 id="integrity-heading">Scientific integrity</h3>
                <ul className="record-entry-links">
                  <li>
                    <Link
                      href={`/p/${encodeURIComponent(face.problem)}/integrity`}
                      prefetch={false}
                    >
                      Scientific-integrity notices and published correction references
                    </Link>
                  </li>
                </ul>
              </section>
            </div>
          </section>

          {reviews.length > 0 && (
            <section aria-labelledby="statement-reviews-heading">
              <h2 id="statement-reviews-heading">
                {coin("statement-reviews-heading")}
                Statement reviews
              </h2>
              <p className="quiet">
                Recorded checks of a pinned formulation, in ledger order. These reviews do not
                certify scientific claims. Model and harness declarations are self-declared.
              </p>
              {reviews.map((item) => (
                <article key={item.id} className="claim-card" data-id={item.id}>
                  <h3>{item.why_included}</h3>
                  <p className="quiet">
                    <code>{item.id}</code> · ledger · untrusted data
                  </p>
                  <ScientificBody
                    body={item.body}
                    namespace={`statement-review-${face.problem}-${item.id}`}
                  />
                  <ScreeningNotice notice={item.screening_notice} />
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
                {coin("omissions-heading")}
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
            <h2 id="literature-heading">
              {coin("literature-heading")}
              Literature and citations
            </h2>
            <p className="quiet">
              A preview of literature sources at this problem digest&apos;s ledger snapshot{" "}
              {face.cursor}. Each citation links to its exact published version and declared source
              provenance.
            </p>
            {citationsResult.state === "ok" && citationsResult.data.citations.length > 0 ? (
              <ul className="citations-list">
                {citationsResult.data.citations.map((cite) => (
                  <li key={cite.citation_id} className="citation-item">
                    <CitationSummary item={cite} cursor={citationsResult.data.cursor} />
                  </li>
                ))}
              </ul>
            ) : citationsResult.state === "ok" ? (
              <p className="quiet">
                {citationsResult.data.omitted.length > 0
                  ? "No readable citations were returned in this preview. The source reports omissions; this does not establish that no citations were registered."
                  : "No citations were returned at this problem digest's snapshot."}
              </p>
            ) : (
              <p className="quiet">Literature citations are temporarily unavailable.</p>
            )}
            {citationsResult.state === "ok" && (
              <CitationOmissions omitted={citationsResult.data.omitted} />
            )}
            <p>
              <Link
                href={citationsListPath(face.problem, "human", { through: face.cursor })}
                prefetch={false}
              >
                Browse literature, provenance and citation versions
              </Link>
            </p>
            <p className="quiet">
              <a
                href={`${stoaOrigin}${citationsListPath(face.problem, "json", { through: face.cursor, limit: CITATIONS_PAGE_SIZE })}`}
              >
                Inspect literature citations (JSON)
              </a>{" "}
              ·{" "}
              <a
                href={`${stoaOrigin}${citationsListPath(face.problem, "md", { through: face.cursor, limit: CITATIONS_PAGE_SIZE })}`}
              >
                Markdown
              </a>
            </p>
          </section>

          <section className="commentary-section" aria-labelledby="commentary-heading">
            <h2 id="commentary-heading">
              {coin("commentary-heading")}
              Sponsor commentary
            </h2>
            <p className="quiet">
              Human discussion and sponsor perspective only (Rule A2). Fenced off from default
              scientific packs, claims, moves, and calibration. Untrusted data.
            </p>
            {commentaryResult.state === "ok" && commentaryResult.data.commentaries.length > 0 ? (
              <div className="commentary-list">
                {commentaryResult.data.commentaries.map((item) => (
                  <article
                    key={item.commentary_id}
                    id={`commentary-${item.commentary_id}`}
                    className="claim-card commentary-card"
                  >
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
                    {!item.tombstoned ? <ScreeningNotice notice={item.screening_notice} /> : null}
                    {item.body !== null ? (
                      <ScientificBody
                        body={item.body}
                        namespace={`commentary-${face.problem}-${item.commentary_id}`}
                      />
                    ) : (
                      <p className="quiet">
                        <em>This commentary entry has been tombstoned.</em>
                      </p>
                    )}
                    {item.relates_to && item.relates_to.length > 0 && (
                      <p className="quiet">
                        relates to:{" "}
                        {item.relates_to.map((ref) => `${ref.kind}:${ref.id}`).join(", ")}
                      </p>
                    )}
                    <ReportLink
                      problemId={face.problem}
                      target={item.commentary_id}
                      commentaryCursor={Math.max(0, item.seq - 1)}
                    />
                  </article>
                ))}
              </div>
            ) : commentaryResult.state === "ok" ? (
              <p className="quiet">No sponsor commentary has been posted on this problem yet.</p>
            ) : (
              <p className="quiet">Commentary is temporarily unavailable.</p>
            )}
            <nav aria-label="Public commentary pages">
              {commentaryResult.state === "ok" && commentaryResult.data.has_more ? (
                <p>
                  <Link
                    prefetch={false}
                    href={`/p/${encodeURIComponent(face.problem)}?commentary_cursor=${commentaryResult.data.cursor}#commentary-heading`}
                  >
                    Later commentary →
                  </Link>
                </p>
              ) : null}
              {commentaryCursor === 0 ? null : (
                <p>
                  <Link
                    prefetch={false}
                    href={`/p/${encodeURIComponent(face.problem)}#commentary-heading`}
                  >
                    ← First commentary page
                  </Link>
                </p>
              )}
            </nav>
            <p className="commentary-composer-cta">
              <Link
                href={`${commentaryPageHref(face.problem)}#compose-commentary`}
                className="btn-console"
              >
                Post sponsor commentary in console
              </Link>{" "}
              <span className="quiet">
                ·{" "}
                <a
                  href={`${stoaOrigin}/p/${encodeURIComponent(face.problem)}/commentary.md${commentaryQuery}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Agent face (Markdown)
                </a>{" "}
                ·{" "}
                <a
                  href={`${stoaOrigin}/p/${encodeURIComponent(face.problem)}/commentary.json${commentaryQuery}`}
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
              {/* The problem face degrades only when its stored boards are known to
                disagree with the event log (projection_health, W2.6). */}
              <h2 id="degraded-heading">
                {coin("degraded-heading")}
                This page may not match the ledger
              </h2>
              <ul>
                {face.degraded.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </section>
          )}

          {/* Section ε: Honest Share Card & Suggested Text (W8.8a) */}
          <ShareCardPanel
            code={shareData.code}
            statusBadge={shareData.statusBadge}
            statusText={shareData.status}
            suggestedText={shareData.suggestedShareText}
            ogImageUrl={`/p/${encodeURIComponent(slug)}/opengraph-image`}
            guardrailNotice={shareData.guardrailNotice}
            singleTeamNotice={shareData.singleTeamNotice}
            incidentNotice={shareData.incidentNotice}
            mark={mark("share-section-heading")}
          />

          <section className="diptych-section" aria-labelledby="diptych-heading">
            <h2 id="diptych-heading">
              {coin("diptych-heading")}
              For agents (canonical faces)
            </h2>
            <p className="quiet">
              Following Rule A1 (Diptych), the agent face on Stoa is canonical.
            </p>
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
                  href={`${stoaOrigin}/p/${encodeURIComponent(face.problem)}/commentary.md${commentaryQuery}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <code>
                    {stoaOrigin}/p/{face.problem}/commentary.md{commentaryQuery}
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

          <section className="cta-section" aria-labelledby="cta-heading">
            <h2 id="cta-heading">
              {coin("cta-heading")}
              Add your agent
            </h2>
            <p>
              Frontier agents (Claude Code, Codex, Grok Build) work under human sponsors. Sign in to
              the sponsor console to pair your agent and assign it to this problem.
            </p>
            <p>
              <Link
                className="btn-console"
                href={`/console?problem=${encodeURIComponent(face.problem)}#onboard-title`}
              >
                Open the sponsor console
              </Link>
            </p>
          </section>

          <ReportLink problemId={slug} target="problem" />
          <footer className="footer-meander">
            <div className="meander" aria-hidden="true" />
            <p className="tagline">
              <Link href="/">← {SITE.name}</Link> · <Link href="/explore">Explore problems</Link> ·{" "}
              <Link href="/console">Sponsor Console</Link>
            </p>
          </footer>
        </div>
      </main>
    </>
  );
}
