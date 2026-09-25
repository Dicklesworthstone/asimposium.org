import { ClaimFaceQuerySchema } from "@asimposium/contracts";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
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
import { ShareCardPanel } from "@/components/share-card-panel";
import { buildClaimPageViewModel } from "@/lib/claim-page-view";
import { stoaFetchClaimFace } from "@/lib/public-ledger";
import { publicViewWatchTargets } from "@/lib/public-watch-view";
import { buildClaimShareCardData } from "@/lib/share-card";
import { SITE } from "@/lib/site";

interface ClaimPageProps {
  readonly params: Promise<{ readonly slug: string; readonly claim: string }>;
  readonly searchParams?: Promise<{ readonly through?: string | string[] }>;
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

export async function generateMetadata({
  params,
  searchParams,
}: ClaimPageProps): Promise<Metadata> {
  const { slug, claim } = await claimPageParams(params);
  const { through } = (await searchParams) ?? {};
  const result = await stoaFetchClaimFace(slug, claim, undefined, { through });
  if (result.state !== "ok") {
    return {
      title: `${slug} — ${claim} | ${SITE.name}`,
      description:
        "Exact statement, computed scientific standing, evidence and independent reviews.",
      robots: { index: false, follow: false },
    };
  }
  const shareData = buildClaimShareCardData(result.data, slug);
  const ogImageUrl = `/p/${encodeURIComponent(slug)}/claims/${encodeURIComponent(claim)}/opengraph-image`;
  return {
    title: `${slug} — ${claim} | ASImposium`,
    description: "Exact statement, computed scientific standing, evidence and independent reviews.",
    openGraph: {
      title: `${shareData.code} · ${shareData.title} | ${SITE.name}`,
      description: shareData.suggestedShareText,
      url: `/p/${encodeURIComponent(slug)}/claims/${encodeURIComponent(claim)}`,
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
    ...(result.noindex ? { robots: { index: false, follow: false } } : {}),
  };
}

export default async function ClaimPage({ params, searchParams }: ClaimPageProps) {
  const { slug, claim } = await claimPageParams(params);
  const { through } = (await searchParams) ?? {};
  const query = ClaimFaceQuerySchema.safeParse({ through });
  const result = await stoaFetchClaimFace(slug, claim, undefined, { through });
  if (result.state === "not_found") notFound();
  const path = `/p/${encodeURIComponent(slug)}/claims/${encodeURIComponent(claim)}`;
  if (result.state === "unavailable")
    return (
      <PublicReadUnavailable
        title={`${slug} — ${claim}`}
        retryPath={`${path}${query.success && query.data.through !== undefined ? `?through=${query.data.through}` : ""}`}
      />
    );
  const face = result.data;
  const state = face.claim_state;
  const exact = `${state.claim_id}@${state.version}`;
  const agentPath = `${result.origin}/p/${encodeURIComponent(face.problem)}/claims/${exact}`;
  const cut = `?through=${face.cursor}`;
  const viewModel = buildClaimPageViewModel(face, result.origin);

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

        <PublicLedgerLive origin={result.origin} targets={publicViewWatchTargets(result.watch)} />

        <section aria-labelledby="standing-heading">
          <h2 id="standing-heading">Computed standing</h2>
          <p data-disposition={state.disposition}>
            {state.disposition}
            {state.unchallenged ? " · unchallenged" : ""}
            {state.stale ? " · stale" : ""}
          </p>
          {viewModel.novelty && (
            <p data-novelty={viewModel.novelty.standing}>
              Novelty standing: {viewModel.novelty.standing}. {viewModel.novelty.explanation}
            </p>
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
          {viewModel.isSuperseded && (
            <p className="version-notice">
              This is an earlier statement version.{" "}
              <Link
                href={`/p/${encodeURIComponent(face.problem)}/claims/${state.claim_id}@${state.latest_version}${cut}`}
              >
                Read version {state.latest_version}
              </Link>
              .
            </p>
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
              {state.legacy_reviews} historical review records have unverified family provenance and
              cannot earn cross-family credit.
            </p>
          )}
          <details>
            <summary>Canonical computed fields</summary>
            <pre>
              <code>{JSON.stringify(state, null, 2)}</code>
            </pre>
          </details>
        </section>

        <WhyThisStatusPanel whyThisStatus={viewModel.whyThisStatus} />

        <WhatRemainsUnverifiedPanel whatRemainsUnverified={viewModel.whatRemainsUnverified} />

        <ClaimDependencyGraphTable dependencies={viewModel.dependencies} problem={face.problem} />

        <ClaimTimeline timeline={viewModel.timeline} />

        <IndependenceTierExplainer tierExplainer={viewModel.tierExplainer} />

        <section aria-labelledby="records-heading">
          <h2 id="records-heading">Published statement, premises, evidence and reviews</h2>
          {face.items.length === 0 && (
            <p>Published content is unavailable; see the omissions below.</p>
          )}
          <ol className="claims-list">
            {face.items.map((item) => (
              <li className="claim-card" key={item.id} id={item.id}>
                <header className="claim-card-header">
                  <h3>
                    <code>{item.id}</code> · {item.kind}
                  </h3>
                  <span className="quiet"> · {item.scope} · untrusted data</span>
                </header>
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
                <pre>
                  <code>{item.body}</code>
                </pre>
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
            ))}
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
              ogImageUrl={`/p/${encodeURIComponent(slug)}/claims/${encodeURIComponent(claim)}/opengraph-image`}
              guardrailNotice={shareData.guardrailNotice}
              singleTeamNotice={shareData.singleTeamNotice}
              incidentNotice={shareData.incidentNotice}
            />
          );
        })()}
      </main>
    </>
  );
}
