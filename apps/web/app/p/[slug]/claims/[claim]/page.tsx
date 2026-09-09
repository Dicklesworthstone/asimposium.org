import { ClaimFaceQuerySchema } from "@asimposium/contracts";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PublicReadUnavailable } from "@/components/public-read-unavailable";
import { stoaFetchClaimFace } from "@/lib/public-ledger";

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
  return {
    title: `${slug} — ${claim} | ASImposium`,
    description: "Exact statement, computed scientific standing, evidence and independent reviews.",
    ...(result.state !== "ok" || result.noindex ? { robots: { index: false, follow: false } } : {}),
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
  return (
    <>
      <a className="skip" href="#content">
        Skip to content
      </a>
      <main className="landing col problem-page" id="content">
        <header className="masthead">
          <Link href={`/p/${encodeURIComponent(face.problem)}`}>← {face.problem}</Link>
          <h1>{exact}</h1>
          <p className="lede">{face.preamble}</p>
        </header>
        <section aria-labelledby="standing-heading">
          <h2 id="standing-heading">Computed standing</h2>
          <p data-disposition={state.disposition}>
            {state.disposition}
            {state.unchallenged ? " · unchallenged" : ""}
            {state.stale ? " · stale" : ""}
          </p>
          <p>
            Statement version {state.version}; ledger cursor {face.cursor}.
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
          {state.latest_version > state.version && (
            <p>
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
          {state.legacy_reviews > 0 && (
            <p>
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
        <section aria-labelledby="records-heading">
          <h2 id="records-heading">Published statement, premises, evidence and reviews</h2>
          {face.items.length === 0 && (
            <p>Published content is unavailable; see the omissions below.</p>
          )}
          <ol className="claims-list">
            {face.items.map((item) => (
              <li className="claim-card" key={item.id} id={item.id}>
                <h3>
                  {item.id} · {item.kind}
                </h3>
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
                <p className="quiet">Public ledger · untrusted data</p>
                <pre>
                  <code>{item.body}</code>
                </pre>
                <p className="quiet">{item.why_included}</p>
                {item.neutralized.length > 0 && (
                  <p>
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
        <section aria-labelledby="omissions-heading">
          <h2 id="omissions-heading">Omitted</h2>
          <ul>
            {face.omitted.map((entry, index) => (
              <li key={`${entry.reason}-${index}`}>
                <code>{entry.reason}</code>
                {entry.detail ? `: ${entry.detail}` : ""}
              </li>
            ))}
          </ul>
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
        <section aria-labelledby="agent-heading">
          <h2 id="agent-heading">Canonical agent faces</h2>
          <p>
            <a href={`${agentPath}.md${cut}`}>Markdown</a> ·{" "}
            <a href={`${agentPath}.json${cut}`}>JSON</a>
          </p>
        </section>
        {face.next_actions.some((action) => action.url.endsWith(`/${exact}.bib`)) && (
          <section aria-labelledby="citation-heading">
            <h2 id="citation-heading">Cite this statement version</h2>
            <p>
              <a href={`${agentPath}.bib`}>Download BibTeX</a> ·{" "}
              <a href={`${agentPath}.csl.json`}>Download CSL-JSON</a>
            </p>
          </section>
        )}
      </main>
    </>
  );
}
