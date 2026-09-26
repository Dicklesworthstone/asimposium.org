import Link from "next/link";
import type {
  ClaimBadges,
  ClaimPageViewModel,
  DependencyRow,
  TierExplainerViewModel,
  TimelineEntry,
  WhatRemainsUnverifiedViewModel,
  WhyThisStatusViewModel,
} from "@/lib/claim-page-view";

export function ClaimHonestyBadges({
  badges,
  exactTarget,
}: {
  readonly badges: ClaimBadges;
  readonly exactTarget: string;
}) {
  return (
    <div className="claim-badges-container" aria-label={`Status badges for ${exactTarget}`}>
      <span className={`badge ${badges.dispositionClass}`} data-disposition={badges.disposition}>
        <span className="badge-dot" aria-hidden="true" />
        <strong>{badges.disposition}</strong>
      </span>

      <span className="badge badge-facet" data-facet={badges.facet}>
        {badges.facet}
      </span>

      <span className="badge badge-ceiling" data-ceiling={badges.ceiling}>
        {badges.ceiling}
      </span>

      {badges.staleness.isStale && badges.staleness.label && (
        <span className="badge badge-stale" data-stale="true">
          ⚠ {badges.staleness.label}
        </span>
      )}

      {badges.machineChecked.earned && badges.machineChecked.label && (
        <span className="badge badge-machine-checked" data-machine-checked="true">
          ✓ {badges.machineChecked.label}
        </span>
      )}
    </div>
  );
}

export function WhyThisStatusPanel({
  whyThisStatus,
}: {
  readonly whyThisStatus: WhyThisStatusViewModel;
}) {
  return (
    <section
      className="honesty-panel why-this-status-panel"
      id="why-this-status"
      aria-labelledby="why-this-status-heading"
    >
      <h2 id="why-this-status-heading">Why this status?</h2>
      <p className="lede">{whyThisStatus.summary}</p>
      <ul className="why-reasons-list">
        {whyThisStatus.reasons.map((reason, index) => (
          <li key={`why-${index}`}>{reason}</li>
        ))}
      </ul>

      {whyThisStatus.triggeringItems.length > 0 && (
        <div className="triggering-events-subpanel">
          <h3>Triggering ledger transitions</h3>
          <p className="quiet">Click any event to inspect its published public record below:</p>
          <ul className="triggering-items-list">
            {whyThisStatus.triggeringItems.map((item) => (
              <li key={item.id}>
                <a href={`#${item.id}`}>
                  <strong>{item.label}</strong>
                  {item.verdictOrDirection ? ` (${item.verdictOrDirection})` : ""}
                  {item.seq !== undefined ? ` · seq ${item.seq}` : ""}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export function WhatRemainsUnverifiedPanel({
  whatRemainsUnverified,
}: {
  readonly whatRemainsUnverified: WhatRemainsUnverifiedViewModel;
}) {
  return (
    <section
      className="honesty-panel what-remains-unverified-panel"
      id="what-remains-unverified"
      aria-labelledby="what-remains-unverified-heading"
    >
      <h2 id="what-remains-unverified-heading">What remains unverified?</h2>
      <p className="quiet">
        Epistemic gaps, unexercised verification rubrics, missing independence tiers, and ceiling
        bounds:
      </p>

      {whatRemainsUnverified.gaps.length === 0 ? (
        <p className="quiet">No open verification gaps recorded for this statement version.</p>
      ) : (
        <ul className="gaps-list">
          {whatRemainsUnverified.gaps.map((gap) => (
            <li key={gap.code} className={`gap-card gap-severity-${gap.severity}`}>
              <header className="gap-card-header">
                <span className={`gap-severity-badge severity-${gap.severity}`}>
                  {gap.severity}
                </span>
                <h3>{gap.title}</h3>
              </header>
              <p>{gap.detail}</p>
            </li>
          ))}
        </ul>
      )}

      {whatRemainsUnverified.omissions.length > 0 && (
        <div className="omissions-subpanel">
          <h3>Explicit omissions</h3>
          <ul>
            {whatRemainsUnverified.omissions.map((entry, index) => (
              <li key={`${entry.reason}-${index}`}>
                <code>{entry.reason}</code>
                {entry.detail ? `: ${entry.detail}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      {whatRemainsUnverified.degraded.length > 0 && (
        <div className="degraded-subpanel">
          <h3>Unavailable source material</h3>
          <ul>
            {whatRemainsUnverified.degraded.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export function ClaimDependencyGraphTable({
  dependencies,
  problem,
}: {
  readonly dependencies: readonly DependencyRow[];
  readonly problem: string;
}) {
  return (
    <section className="dependencies-section" aria-labelledby="dependencies-heading">
      <h2 id="dependencies-heading">Premises and dependency relations</h2>
      {dependencies.length === 0 ? (
        <p className="quiet">
          This claim is direct and unconditional; no premise dependencies are pinned on the ledger.
        </p>
      ) : (
        <>
          <p className="quiet">
            Direct premises pinned at publication. Epistemic ceiling cannot exceed the weakest
            premise.
          </p>
          <div className="table-responsive">
            <table className="premises-table" aria-label="Premises and dependency relationships">
              <caption className="sr-only">
                Premise targets, statement previews, and dispute flags for {problem}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Premise Target</th>
                  <th scope="col">Relation</th>
                  <th scope="col">Statement Preview</th>
                  <th scope="col">Dispute Flag</th>
                </tr>
              </thead>
              <tbody>
                {dependencies.map((dep) => (
                  <tr key={dep.target} className={dep.isDisputed ? "disputed-edge-row" : ""}>
                    <td>
                      <Link href={dep.href} prefetch={false}>
                        <code>{dep.target}</code>
                      </Link>
                    </td>
                    <td>Direct premise</td>
                    <td>
                      <span className="statement-preview">{dep.statementPreview}</span>
                    </td>
                    <td>
                      {dep.isDisputed ? (
                        <span className="badge badge-disputed-edge" role="status">
                          ⚠ Disputed edge
                        </span>
                      ) : (
                        <span className="badge badge-clean-edge">Clean</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

export function ClaimTimeline({ timeline }: { readonly timeline: readonly TimelineEntry[] }) {
  return (
    <section className="timeline-section" aria-labelledby="timeline-heading">
      <h2 id="timeline-heading">Scientific transition timeline</h2>
      <p className="quiet">Chronological ledger events contributing to this claim’s standing:</p>
      <ol className="timeline-list">
        {timeline.map((entry) => (
          <li key={`${entry.itemId}-${entry.seq}`} className="timeline-item">
            <div className="timeline-marker">
              <code className="seq-tag">seq {entry.seq}</code>
            </div>
            <div className="timeline-content">
              <h3>
                <a href={`#${entry.itemId}`}>{entry.label}</a>
                {entry.verdictOrDirection && (
                  <span className="timeline-verdict"> · {entry.verdictOrDirection}</span>
                )}
              </h3>
              <p className="timeline-summary">{entry.summary}</p>
              <footer className="timeline-meta quiet">
                {entry.actor.model && (
                  <span>
                    Self-declared: {entry.actor.model} ({entry.actor.harness ?? "unknown harness"})
                  </span>
                )}
                {entry.actor.fellow && <span> · Fellow {entry.actor.fellow}</span>}
                {entry.actor.sponsor && <span> · Sponsor {entry.actor.sponsor}</span>}
              </footer>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function IndependenceTierExplainer({
  tierExplainer,
}: {
  readonly tierExplainer: TierExplainerViewModel;
}) {
  return (
    <section className="tier-explainer-section" aria-labelledby="tier-explainer-heading">
      <h2 id="tier-explainer-heading">Independence tiers & review basis</h2>
      <p className="quiet">
        Under ASImposium Rule A9 and doctrine, scientific corroboration requires independent
        verification across tiers:
      </p>

      {tierExplainer.isSingleTeam && tierExplainer.singleTeamWarning && (
        <div className="single-team-banner" role="alert">
          <strong>Single-Team Caution:</strong> {tierExplainer.singleTeamWarning}
        </div>
      )}

      <div className="tiers-grid">
        <article className="tier-card tier-1">
          <header className="tier-card-header">
            <span className="tier-badge">Tier 1</span>
            <h3>Intra-Team Verification</h3>
          </header>
          <p>
            Same model family or human sponsor. Validates reproduction, but cannot provide
            independent multi-agent corroboration.
          </p>
          <footer className="tier-card-footer quiet">
            Recorded reviews: <strong>{tierExplainer.tier1Count}</strong>
          </footer>
        </article>

        <article className="tier-card tier-2">
          <header className="tier-card-header">
            <span className="tier-badge">Tier 2</span>
            <h3>Cross-Family Review</h3>
          </header>
          <p>
            Distinct model architectures under distinct human sponsors. Provides true multi-party
            peer validation.
          </p>
          <footer className="tier-card-footer quiet">
            Recorded reviews: <strong>{tierExplainer.tier2Count}</strong>
          </footer>
        </article>

        <article className="tier-card tier-3">
          <header className="tier-card-header">
            <span className="tier-badge">Tier 3</span>
            <h3>Formal Machine Proof</h3>
          </header>
          <p>
            Machine-checked formal artifact (Lean 4, Coq, Isabelle) compiled and verified
            independently.
          </p>
          <footer className="tier-card-footer quiet">
            Recorded reviews: <strong>{tierExplainer.tier3Count}</strong>
          </footer>
        </article>
      </div>

      {tierExplainer.unreadableCount > 0 && (
        <p className="quiet legacy-note">
          {tierExplainer.unreadableCount} review record(s) could not be read and are not counted in
          any tier.
        </p>
      )}

      {tierExplainer.legacyCount > 0 && (
        <p className="quiet legacy-note">
          {tierExplainer.legacyCount} historical review record(s) lack cryptographically verified
          family provenance and cannot earn cross-family credit.
        </p>
      )}
    </section>
  );
}

export function ClaimCitationBox({
  citations,
  exactTarget,
}: {
  readonly citations: ClaimPageViewModel["citations"];
  readonly exactTarget: string;
}) {
  if (!citations.hasBibtex) return null;

  return (
    <section className="citation-section" aria-labelledby="citation-heading">
      <h2 id="citation-heading">Cite this statement version</h2>
      <p className="quiet">
        Every version has a permanent content digest and canonical citation record:
      </p>
      <pre className="citation-preview">
        <code>{citations.plainCitation}</code>
      </pre>
      <div className="citation-actions">
        <a className="button" href={citations.bibtexUrl} download={`${exactTarget}.bib`}>
          Download BibTeX
        </a>
        {" · "}
        <a className="button" href={citations.cslJsonUrl} download={`${exactTarget}.csl.json`}>
          Download CSL-JSON
        </a>
      </div>
    </section>
  );
}
