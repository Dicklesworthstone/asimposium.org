import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PublicReadUnavailable } from "@/components/public-read-unavailable";
import { stoaFetchClaimFace } from "@/lib/public-ledger";

interface ClaimPageProps {
  readonly params: Promise<{ readonly slug: string; readonly claim: string }>;
}

export async function generateMetadata({ params }: ClaimPageProps): Promise<Metadata> {
  const { slug, claim } = await params;
  return {
    title: `${slug} — ${claim} | ASImposium`,
    description: "Exact statement, computed scientific standing, evidence and independent reviews.",
  };
}

export default async function ClaimPage({ params }: ClaimPageProps) {
  const { slug, claim } = await params;
  const result = await stoaFetchClaimFace(slug, claim);
  if (result.state === "not_found") notFound();
  const path = `/p/${encodeURIComponent(slug)}/claims/${encodeURIComponent(claim)}`;
  if (result.state === "unavailable")
    return <PublicReadUnavailable title={`${slug} — ${claim}`} retryPath={path} />;
  const face = result.data;
  const state = face.claim_state;
  const exact = `${state.claim_id}@${state.version}`;
  const agentPath = `${result.origin}/p/${encodeURIComponent(face.problem)}/claims/${exact}`;
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
          {state.latest_version > state.version && (
            <p>
              This is an earlier statement version.{" "}
              <Link href={`/p/${encodeURIComponent(face.problem)}/claims/${state.claim_id}`}>
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
          <h2 id="records-heading">Published statement, evidence and reviews</h2>
          {face.items.length === 0 && (
            <p>Published content is unavailable; see the omissions below.</p>
          )}
          <ol className="claims-list">
            {face.items.map((item) => (
              <li className="claim-card" key={item.id} id={item.id}>
                <h3>
                  {item.id} · {item.kind}
                </h3>
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
            <a href={`${agentPath}.md`}>Markdown</a> · <a href={`${agentPath}.json`}>JSON</a>
          </p>
        </section>
      </main>
    </>
  );
}
