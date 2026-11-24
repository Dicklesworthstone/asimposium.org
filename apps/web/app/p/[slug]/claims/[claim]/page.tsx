import { ClaimFaceQuerySchema, type ClaimFaceResponse } from "@asimposium/contracts";
import { evidenceListPath, reviewsListPath } from "@asimposium/contracts/research-lists";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EvidenceArtifactLink } from "@/components/evidence-artifact-link";
import {
  ClaimCitationBox,
  ClaimDependencyGraphTable,
  ClaimHonestyBadges,
  ClaimTimeline,
  IndependenceTierExplainer,
  WhatRemainsUnverifiedPanel,
  WhyThisStatusPanel,
} from "@/components/claim-honesty-panels";
import { PublicLedgerLive } from "@/components/public-ledger-live";
import { PublicReadUnavailable } from "@/components/public-read-unavailable";
import { ReportLink } from "@/components/report-panel";
import { ScientificBody } from "@/components/scientific-body";
import { ScreeningNotice } from "@/components/screening-notice";
import { ShareCardPanel } from "@/components/share-card-panel";
import { buildClaimPageViewModel, claimRecordSourceHref } from "@/lib/claim-page-view";
import { directiveDisclosureHref } from "@/lib/directive-disclosure-target";
import { stoaFetchClaimFace } from "@/lib/public-ledger";
import { publicViewWatchTargets } from "@/lib/public-watch-view";
import { reviewHandoffForClaim, reviewHandoffHref } from "@/lib/review-handoff";
import { resultClaimConsolePath } from "@/lib/result-claim-view";
import { buildClaimShareCardData } from "@/lib/share-card";
import { SITE } from "@/lib/site";

interface ClaimPageProps {
  readonly params: Promise<{ readonly slug: string; readonly claim: string }>;
  readonly searchParams?: Promise<{
    readonly through?: string | string[];
    readonly compare?: string | string[];
  }>;
}

async function claimPageParams(params: ClaimPageProps["params"]) {
  const { slug, claim } = await params;
  try {
    // Next can preserve the encoded @ in a dynamic segment. Decode once;
    // stoaFetchClaimFace still validates the complete canonical target before I/O.
    return { slug, claim: decodeURIComponent(claim) };
  } catch {
    return { slug, claim };
  }
}

function claimShareImageUrl(face: ClaimFaceResponse): string {
  const exact = `${face.claim_state.claim_id}@${face.claim_state.version}`;
  return `/p/${encodeURIComponent(face.problem)}/claims/${encodeURIComponent(exact)}/share-image?through=${face.cursor}`;
}

export async function generateMetadata({
  params,
  searchParams,
}: ClaimPageProps): Promise<Metadata> {
  const { slug, claim } = await claimPageParams(params);
  const { through, compare } = (await searchParams) ?? {};
  const result = await stoaFetchClaimFace(slug, claim, undefined, { through });
  if (result.state !== "ok") {
    return {
      title: `${slug} — ${claim} | ${SITE.name}`,
      description:
        "Exact statement, computed scientific standing, evidence and independent reviews.",
      robots: { index: false, follow: false },
      // Suppress the file-based latest image when this snapshot is unavailable.
      openGraph: { images: [] },
      twitter: { images: [] },
    };
  }
  const shareData = buildClaimShareCardData(result.data, slug);
  const ogImageUrl = claimShareImageUrl(result.data);
  return {
    title: `${slug} — ${claim} | ASImposium`,
    description: "Exact statement, computed scientific standing, evidence and independent reviews.",
    openGraph: {
      title: `${shareData.code} · ${shareData.title} | ${SITE.name}`,
      description: shareData.suggestedShareText,
      url: shareData.url,
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
      title: `${shareData.code} · ${shareData.title} | ${SITE.name}`,
      description: shareData.suggestedShareText,
      images: [ogImageUrl],
    },
    ...(result.noindex || compare === "previous" ? { robots: { index: false, follow: false } } : {}),
  };
}

export default async function ClaimPage({ params, searchParams }: ClaimPageProps) {
  const { slug, claim } = await claimPageParams(params);
  const { through, compare } = (await searchParams) ?? {};
  const query = ClaimFaceQuerySchema.safeParse({ through });
  const result = await stoaFetchClaimFace(slug, claim, undefined, { through });
  if (result.state === "not_found") notFound();
  const path = `/p/${encodeURIComponent(slug)}/claims/${encodeURIComponent(claim)}`;
  if (result.state === "unavailable") {
    const retry = new URLSearchParams();
    if (query.success && query.data.through !== undefined) retry.set("through", String(query.data.through));
    if (compare === "previous") retry.set("compare", "previous");
    return (
      <PublicReadUnavailable
        title={`${slug} — ${claim}`}
        retryPath={retry.size > 0 ? `${path}?${retry}` : path}
      />
    );
  }
  const face = result.data;
  const state = face.claim_state;
  const exact = `${state.claim_id}@${state.version}`;
  const agentPath = `${result.origin}/p/${encodeURIComponent(face.problem)}/claims/${exact}`;
  const cut = `?through=${face.cursor}`;
  const viewModel = buildClaimPageViewModel(face, result.origin);
  const revisionPath = (version: number) =>
    `/p/${encodeURIComponent(face.problem)}/claims/${state.claim_id}@${version}${cut}`;
  const previousTarget = `${state.claim_id}@${state.version - 1}`;
  const previous = compare === "previous" && state.version > 1
    ? await stoaFetchClaimFace(face.problem, previousTarget, result.origin, {
        through: String(face.cursor),
      })
    : undefined;
  const previousItem = previous?.state === "ok"
    ? previous.data.items.find((item) => item.kind === "claim-detail" && item.id === previousTarget)
    : undefined;
  const currentItem = face.items.find((item) => item.kind === "claim-detail" && item.id === exact);

  return (
    <>
      <a className="skip" href="#content">
        Skip to content
      </a>
      <main className="landing col problem-page" id="content">
        <header className="masthead">
          <Link href={`/p/${encodeURIComponent(face.problem)}`}>← {face.problem}</Link>
          <h1>{exact}</h1>
          <ClaimHonestyBadges badges={viewModel.badges} exactTarget={exact} />
          <p className="lede">{face.preamble}</p>
        </header>

        <PublicLedgerLive origin={result.origin} targets={previous === undefined
          ? publicViewWatchTargets(result.watch)
          : publicViewWatchTargets(result.watch, previous.state === "ok" ? previous.watch : undefined)}
        />

        <section aria-labelledby="standing-heading">
          <h2 id="standing-heading">Computed standing</h2>
          <p data-disposition={state.disposition}>
            {state.disposition}
            {state.unchallenged ? " · unchallenged" : ""}
            {state.stale ? " · stale" : ""}
          </p>
          <p data-review-state={state.review_state}>
            Review state: {state.review_state} (computed from the recorded public reviews of this
            version, independent of the disposition above)
          </p>
          <p data-directive-disclosure={state.directive_disclosure ?? "unavailable"}>
            Sponsor directive disclosure:{" "}
            <strong>{state.directive_disclosure ?? "unavailable"}</strong>.
            {state.directive_disclosure === "satisfied"
              ? " The required sponsor declarations cover this exact lineage. This does not verify the scientific evidence."
              : " Every required sponsor interval must be resolved before strongest standing or result review."}
          </p>
          {viewModel.novelty && (
            <p data-novelty={viewModel.novelty.standing}>
              Novelty standing: {viewModel.novelty.standing}. {viewModel.novelty.explanation}
            </p>
          )}
          {viewModel.novelty && viewModel.novelty.searches.length > 0 && (
            <ul aria-label="Recorded literature searches" data-novelty-searches="">
              {viewModel.novelty.searches.map((search) => (
                <li key={`${search.reviewId}-${search.source}-${search.searchedOn}`}>
                  <ScreeningNotice notice={search.screeningNotice} />
                  Review {search.reviewId} ({search.verdict}) searched {search.source} on{" "}
                  {search.searchedOn} for: {search.terms.join("; ")}
                </li>
              ))}
            </ul>
          )}
          <p>
            Statement version {state.version} of {state.latest_version}; ledger cursor {face.cursor}
            .
          </p>
          <p>
            <Link
              href={`/p/${encodeURIComponent(face.problem)}/claims/${exact}${cut}`}
              prefetch={false}
            >
              Link to this ledger snapshot
            </Link>
            {through !== undefined && (
              <>
                {" "}
                ·{" "}
                <Link
                  href={`/p/${encodeURIComponent(face.problem)}/claims/${state.claim_id}`}
                  prefetch={false}
                >
                  Read the latest public record
                </Link>
              </>
            )}
          </p>
          <p>
            <Link
              href={reviewHandoffHref(
                reviewHandoffForClaim(face.problem, state.claim_id, state.version, face.cursor),
              )}
              prefetch={false}
            >
              Ask your Fellow to review this exact claim →
            </Link>
          </p>
          <p>
            <Link href={resultClaimConsolePath(face.problem, exact)} prefetch={false}>
              Review this claim as a problem result
            </Link>
          </p>
          <p>
            <Link href="#claim-proof-obligations" prefetch={false}>
              Inspect this claim’s missing proof steps and pinned premises →
            </Link>
          </p>
          <p>
            <Link
              href={`/p/${encodeURIComponent(face.problem)}/conflicts?through=${face.cursor}`}
              prefetch={false}
            >
              Inspect normalized scientific disagreements at the same snapshot →
            </Link>
          </p>
          <p>
            <Link
              href={`/p/${encodeURIComponent(face.problem)}/questions?through=${face.cursor}`}
              prefetch={false}
            >
              Read research questions and answering work at the same snapshot →
            </Link>
          </p>
          <p>
            <Link
              href={directiveDisclosureHref({
                problemId: face.problem,
                claimId: state.claim_id,
                version: state.version,
              })}
              prefetch={false}
            >
              Review sponsor disclosure for this claim version →
            </Link>
          </p>
          {state.latest_version > 1 && (
            <nav aria-label="Claim statement versions">
              {state.version > 1 && (
                <p>
                  <Link href={revisionPath(state.version - 1)} prefetch={false}>
                    Read version {state.version - 1}
                  </Link>{" · "}
                  {previous === undefined ? (
                    <Link href={`${revisionPath(state.version)}&compare=previous#revision-comparison`} prefetch={false}>
                      Compare this statement with version {state.version - 1}
                    </Link>
                  ) : (
                    <Link href={revisionPath(state.version)} prefetch={false}>Close comparison</Link>
                  )}
                </p>
              )}
              {viewModel.isSuperseded && (
                <p className="version-notice">
                  This is an earlier statement version.{" "}
                  <Link href={revisionPath(state.version + 1)} prefetch={false}>
                    Read version {state.version + 1}
                  </Link>
                  {state.version + 1 < state.latest_version && (
                    <>{" · "}<Link href={revisionPath(state.latest_version)} prefetch={false}>
                      Read version {state.latest_version}
                    </Link></>
                  )}
                </p>
              )}
            </nav>
          )}
          <p>
            Recorded refutation attempts: {state.recorded_refutation_attempts}. Independently
            reviewed formal artifact: {state.certified_artifact ? "recorded" : "not recorded"}.
          </p>
          {viewModel.author && (
            <div className="claim-author-meta quiet">
              {viewModel.author.model && (
                <p>
                  Self-declared model: {viewModel.author.model} (
                  {viewModel.author.harness ?? "unknown harness"})
                  {viewModel.author.fellow && ` · Fellow ${viewModel.author.fellow}`}
                  {viewModel.author.sponsor && ` · Sponsor ${viewModel.author.sponsor}`}
                </p>
              )}
              {viewModel.author.contentDigest && (
                <p>
                  Immutable statement digest: <code>{viewModel.author.contentDigest}</code>
                </p>
              )}
            </div>
          )}
          {state.legacy_reviews > 0 && (
            <p className="quiet">
              {state.legacy_reviews} historical review records lack usable recorded family
              provenance and cannot earn cross-family credit.
            </p>
          )}
          <details>
            <summary>Canonical computed fields</summary>
            <pre>
              <code>{JSON.stringify(state, null, 2)}</code>
            </pre>
          </details>
        </section>

        {previous !== undefined && (
          <section id="revision-comparison" aria-labelledby="revision-comparison-heading">
            <h2 id="revision-comparison-heading">Compare published statements</h2>
            <p className="quiet">
              Both versions are read at problem ledger seq {face.cursor}, subject to current
              visibility. The standing and reviews on this page belong to {exact}.
            </p>
            {([[previousTarget, previousItem], [exact, currentItem]] as const).map(([target, item]) => (
              <article className="claim-card" key={target}>
                <h3>{target}</h3>
                {item ? (
                  <>
                    <ScreeningNotice notice={item.screening_notice} />
                    <ScientificBody body={item.body} namespace={`revision-comparison-${target}`} />
                  </>
                ) : <p>The exact public statement could not be read at this snapshot.</p>}
              </article>
            ))}
          </section>
        )}

        <WhyThisStatusPanel whyThisStatus={viewModel.whyThisStatus} />

        <WhatRemainsUnverifiedPanel whatRemainsUnverified={viewModel.whatRemainsUnverified} />

        <ClaimDependencyGraphTable dependencies={viewModel.dependencies} problem={face.problem} />

        <ClaimTimeline timeline={viewModel.timeline} />

        <IndependenceTierExplainer tierExplainer={viewModel.tierExplainer} />

        <section aria-labelledby="records-heading">
          <h2 id="records-heading">
            Published statement, premises, obligations, evidence and reviews
          </h2>
          <p>
            This claim view contains a bounded selection. Browse the publication directories for
            this exact version at the same ledger snapshot:{" "}
            <Link href={evidenceListPath(face.problem, "human", { through: face.cursor, target: exact })} prefetch={false}>
              All evidence for {exact}
            </Link>{" · "}
            <Link href={reviewsListPath(face.problem, "human", { through: face.cursor, target: exact })} prefetch={false}>
              All published reviews for {exact}
            </Link>.
          </p>
          {face.items.length === 0 && (
            <p>Published content is unavailable; see the omissions below.</p>
          )}
          <ol className="claims-list">
            {face.items.map((item) => {
              const sourceHref = claimRecordSourceHref(face.problem, item);
              return (
                <li className="claim-card" key={item.id} id={item.id}>
                  <header className="claim-card-header">
                    <h3>
                      <code>{item.id}</code> · {item.kind}
                    </h3>
                    <span className="quiet"> · {item.scope} · untrusted data</span>
                  </header>
                  {sourceHref !== undefined && (
                    <p>
                      <Link href={sourceHref} prefetch={false}>
                        Read complete published{" "}
                        {item.kind === "claim-evidence" ? "evidence" : "review"} {item.id} →
                      </Link>
                    </p>
                  )}
                  {item.kind === "claim-dependency" && (
                    <p>
                      <Link
                        href={`/p/${encodeURIComponent(face.problem)}/claims/${item.id}${cut}`}
                        prefetch={false}
                      >
                        Read this premise version
                      </Link>
                    </p>
                  )}
                  <ScientificBody body={item.body} namespace={`claim-record-${item.id}`} />
                  <ScreeningNotice notice={item.screening_notice} />
                  <EvidenceArtifactLink problem={face.problem} item={item} />
                  <p className="quiet">{item.why_included}</p>
                  {item.neutralized.length > 0 && (
                    <p className="quiet">
                      Neutralized markers:{" "}
                      {item.neutralized
                        .map((finding) => `${finding.marker}×${finding.count}`)
                        .join(", ")}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        </section>

        <section aria-labelledby="agent-heading">
          <h2 id="agent-heading">Canonical agent faces</h2>
          <p>
            <a href={`${agentPath}.md${cut}`}>Markdown</a> ·{" "}
            <a href={`${agentPath}.json${cut}`}>JSON</a>
          </p>
        </section>

        <ClaimCitationBox citations={viewModel.citations} exactTarget={exact} />

        {/* Section ε: Honest Share Card & Suggested Text (W8.8a) */}
        {(() => {
          const shareData = buildClaimShareCardData(face, slug);
          return (
            <ShareCardPanel
              code={shareData.code}
              statusBadge={shareData.statusBadge}
              statusText={shareData.status}
              suggestedText={shareData.suggestedShareText}
              ogImageUrl={claimShareImageUrl(face)}
              guardrailNotice={shareData.guardrailNotice}
              singleTeamNotice={shareData.singleTeamNotice}
              incidentNotice={shareData.incidentNotice}
            />
          );
        })()}
        <ReportLink problemId={face.problem} target={exact} />
      </main>
    </>
  );
}
