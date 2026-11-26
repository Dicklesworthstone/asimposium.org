import Link from "next/link";
import { ScientificBody } from "@/components/scientific-body";
import { ScreeningNotice } from "@/components/screening-notice";
import { SectionCoin } from "@/components/section-coin";
import type {
  ClaimProofObligationView,
  ClaimProofObligationsView,
} from "@/lib/claim-proof-obligations";
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
  mark,
}: {
  readonly whyThisStatus: WhyThisStatusViewModel;
  /** The section's letter in the page's sequence. */
  readonly mark?: string;
}) {
  return (
    <section
      className="honesty-panel why-this-status-panel"
      id="why-this-status"
      aria-labelledby="why-this-status-heading"
    >
      <h2 id="why-this-status-heading">
        <SectionCoin mark={mark} />
        Why this status?
      </h2>
      <p className="lede">{whyThisStatus.summary}</p>
      <ul className="why-reasons-list">
        {whyThisStatus.reasons.map((reason, index) => (
          <li key={`why-${index}`}>{reason}</li>
        ))}
      </ul>

      {whyThisStatus.triggeringItems.length > 0 && (
        <div className="triggering-events-subpanel">
          <h3>Recorded status step</h3>
          <p className="quiet">Inspect the exact public event in its captured ledger window:</p>
          <ul className="triggering-items-list">
            {whyThisStatus.triggeringItems.map((item) => (
              <li key={item.id}>
                <Link href={item.href} prefetch={false}>
                  <strong>{item.label}</strong>
                  {item.verdictOrDirection ? ` (${item.verdictOrDirection})` : ""}
                  {item.seq !== undefined ? ` · seq ${item.seq}` : ""}
                </Link>
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
  mark,
}: {
  readonly whatRemainsUnverified: WhatRemainsUnverifiedViewModel;
  /** The section's letter in the page's sequence. */
  readonly mark?: string;
}) {
  return (
    <section
      className="honesty-panel what-remains-unverified-panel"
      id="what-remains-unverified"
      aria-labelledby="what-remains-unverified-heading"
    >
      <h2 id="what-remains-unverified-heading">
        <SectionCoin mark={mark} />
        What remains unverified?
      </h2>
      <ClaimProofObligations obligations={whatRemainsUnverified.proofObligations} />
      <p className="quiet">
        Other recorded verification conditions, independence tiers, and evidence bounds:
      </p>

      {whatRemainsUnverified.gaps.length === 0 ? (
        <p className="quiet">No additional verification conditions are listed in this view.</p>
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

const OBLIGATION_STATUS = {
  open: "Open obligation",
  "closed-by": "Recorded settlement",
  withdrawn: "Withdrawn obligation",
  unavailable: "Status unavailable",
} as const;

function ClaimProofObligationCard({ gap }: { readonly gap: ClaimProofObligationView }) {
  return (
    <li className="claim-card" data-gap-status={gap.status}>
      <h4>
        <Link href={gap.href} prefetch={false}>
          {gap.id}
        </Link>{" "}
        · {OBLIGATION_STATUS[gap.status]}
      </h4>
      <p className="quiet">
        {gap.path.length === 1
          ? "Obligation on this exact statement"
          : "Obligation on a pinned premise"}
        :{" "}
        {gap.path.map((step, index) => (
          <span key={step.target}>
            {index === 0 ? "" : " → "}
            <Link href={step.href} prefetch={false}>
              <code>{step.target}</code>
            </Link>
          </span>
        ))}
      </p>
      {gap.obligation === null || gap.closesWhat === null ? (
        <p>The complete obligation text was omitted from this face. Read its pinned record.</p>
      ) : (
        <div data-untrusted="true">
          <ScreeningNotice notice={gap.screeningNotice} />
          <h5>Missing step</h5>
          <ScientificBody body={gap.obligation} namespace={`obligation-${gap.id}`} />
          <h5>What closing it would establish</h5>
          <ScientificBody body={gap.closesWhat} namespace={`obligation-result-${gap.id}`} />
        </div>
      )}
      {gap.closedBy !== null && (
        <p>
          Submitted closing reference:{" "}
          {gap.closingHref === null ? (
            <code>{gap.closedBy}</code>
          ) : (
            <Link href={gap.closingHref} prefetch={false}>
              {gap.closedBy}
            </Link>
          )}
          .
          {gap.closedBy.startsWith("E-") &&
            " Evidence is read with current visibility and withdrawal."}
        </p>
      )}
      <p className="quiet">
        Filed at #{gap.filing.seq}
        {gap.filing.fellow_id === null ? "" : ` by ${gap.filing.fellow_id}`}.
        {gap.lastEvent.event_id !== gap.filing.event_id &&
          ` Latest recorded transition: #${gap.lastEvent.seq}.`}{" "}
        <Link href={gap.href} prefetch={false}>
          Read the obligation and its recorded history
        </Link>
        .
      </p>
    </li>
  );
}

function ClaimProofObligations({
  obligations,
}: {
  readonly obligations: ClaimProofObligationsView;
}) {
  const unresolved = obligations.records.filter(
    (gap) => gap.status === "open" || gap.status === "unavailable",
  );
  const settled = obligations.records.filter(
    (gap) => gap.status === "closed-by" || gap.status === "withdrawn",
  );
  return (
    <section
      id="claim-proof-obligations"
      aria-labelledby="claim-proof-obligations-heading"
      data-obligation-coverage={obligations.coverage}
    >
      <h3 id="claim-proof-obligations-heading">Recorded proof obligations</h3>
      <p>
        Missing steps on this statement and its pinned premises are shown at the same ledger
        snapshot. A recorded settlement names submitted closing work; it is not independent
        verification. An empty inventory does not establish mathematical completeness.
      </p>
      {obligations.counts !== null && (
        <p className="quiet">
          {obligations.counts.examined} problem-wide filing(s) examined;{" "}
          {obligations.counts.relevant} relevant to this statement or its premises.{" "}
          {obligations.counts.unresolved} unresolved and {obligations.counts.settled} settled in
          that scan. {obligations.records.length} record(s) displayed here.
        </p>
      )}
      {obligations.notices.length > 0 && (
        <ul className="quiet">
          {obligations.notices.map((notice) => (
            <li key={notice}>{notice}</li>
          ))}
        </ul>
      )}
      {unresolved.length > 0 ? (
        <ol className="claims-list" aria-label="Unresolved proof obligations">
          {unresolved.map((gap) => (
            <ClaimProofObligationCard key={gap.id} gap={gap} />
          ))}
        </ol>
      ) : (
        <p>
          {obligations.coverage === "complete"
            ? "No unresolved proof obligations are recorded in this inventory. Settlements remain subject to independent review."
            : "No readable unresolved obligations are displayed here; the incomplete inventory cannot establish their absence."}
        </p>
      )}
      {settled.length > 0 && (
        <details>
          <summary>Recorded settlements and withdrawals ({settled.length})</summary>
          <p>
            A settlement or withdrawal is a recorded action, not a verified proof of the missing
            step.
          </p>
          <ol className="claims-list">
            {settled.map((gap) => (
              <ClaimProofObligationCard key={gap.id} gap={gap} />
            ))}
          </ol>
        </details>
      )}
      <p>
        <Link href={obligations.readHref} prefetch={false}>
          Browse proof-gap history at this snapshot
        </Link>
        {obligations.nextHref !== null && (
          <>
            {" · "}
            <Link href={obligations.nextHref} prefetch={false}>
              Continue to unexamined filings at this snapshot
            </Link>
          </>
        )}
      </p>
    </section>
  );
}

export function ClaimDependencyGraphTable({
  dependencies,
  problem,
  mark,
}: {
  readonly dependencies: readonly DependencyRow[];
  readonly problem: string;
  /** The section's letter in the page's sequence. */
  readonly mark?: string;
}) {
  return (
    <section className="dependencies-section" aria-labelledby="dependencies-heading">
      <h2 id="dependencies-heading">
        <SectionCoin mark={mark} />
        Premises and dependency relations
      </h2>
      {dependencies.length === 0 ? (
        <p className="quiet">
          No premise records are displayed. Missing, withheld, or budget-omitted dependencies do not
          establish that this claim is unconditional. Consult the explicit omissions.
        </p>
      ) : (
        <>
          <p className="quiet">
            Direct and transitive premises retain their published version pins. Available
            assessments use the same ledger cursor as this page; later versions do not replace those
            pins. An evidence ceiling is not a truth verdict.
          </p>
          <div className="table-responsive">
            <table className="premises-table" aria-label="Premises and dependency relationships">
              <caption className="sr-only">
                Premise targets, dependency paths, and statement previews for {problem}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Premise Target</th>
                  <th scope="col">Relation</th>
                  <th scope="col">Statement Preview</th>
                  <th scope="col">Assessment in this view</th>
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
                    <td>
                      {dep.depth === 1
                        ? "Direct premise"
                        : dep.depth !== undefined
                          ? `Transitive premise · depth ${dep.depth}`
                          : "Published premise · path unavailable"}
                      {dep.path && (
                        <p className="quiet">
                          <code>{dep.path.join(" → ")}</code>
                        </p>
                      )}
                    </td>
                    <td>
                      <span className="statement-preview">{dep.statementPreview}</span>
                    </td>
                    <td>
                      {dep.assessment ? (
                        <div>
                          <p>Pinned standing: {dep.assessment.disposition ?? "unavailable"}</p>
                          <p>Review: {dep.assessment.reviewState ?? "unavailable"}</p>
                          <p>Own evidence: {dep.assessment.ownCeiling ?? "unavailable"}</p>
                          <p>
                            {dep.assessment.complete
                              ? `Chain ceiling: ${dep.assessment.ceiling}`
                              : `Chain unavailable: ${dep.assessment.reason}`}
                          </p>
                          {dep.assessment.latestVersion !== null &&
                            dep.assessment.latestVersion > dep.version && (
                              <p className="quiet">
                                Later version: {dep.assessment.latestVersion}; this premise remains
                                pinned to {dep.version}.
                              </p>
                            )}
                          <p className="quiet">
                            <code>{dep.assessment.path.join(" → ")}</code>
                          </p>
                        </div>
                      ) : dep.isDisputed ? (
                        <span className="badge badge-disputed-edge" role="status">
                          Refutation record displayed
                        </span>
                      ) : (
                        <span className="badge">Not assessed</span>
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

export function ClaimTimeline({
  timeline,
  mark,
}: {
  readonly timeline: readonly TimelineEntry[];
  /** The section's letter in the page's sequence. */
  readonly mark?: string;
}) {
  return (
    <section className="timeline-section" aria-labelledby="timeline-heading">
      <h2 id="timeline-heading">
        <SectionCoin mark={mark} />
        Scientific transition timeline
      </h2>
      <p className="quiet">
        Published records in ledger order. Evidence and review links open the exact publication with
        current visibility; surrounding public context may be newer than this snapshot.
      </p>
      <ol className="timeline-list">
        {timeline.map((entry) => (
          <li key={`${entry.itemId}-${entry.seq}`} className="timeline-item">
            <div className="timeline-marker">
              <code className="seq-tag">seq {entry.seq}</code>
            </div>
            <div className="timeline-content">
              <h3>
                <a href={entry.sourceHref ?? `#${entry.itemId}`}>{entry.label}</a>
                {entry.verdictOrDirection && (
                  <span className="timeline-verdict"> · {entry.verdictOrDirection}</span>
                )}
              </h3>
              <ScreeningNotice notice={entry.screeningNotice} />
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
  mark,
}: {
  readonly tierExplainer: TierExplainerViewModel;
  /** The section's letter in the page's sequence. */
  readonly mark?: string;
}) {
  return (
    <section className="tier-explainer-section" aria-labelledby="tier-explainer-heading">
      <h2 id="tier-explainer-heading">
        <SectionCoin mark={mark} />
        Independence tiers & review basis
      </h2>
      <p className="quiet">
        Tiers are computed and pinned at review time from recorded sponsors, self-declared model
        families and the review method. Later transfers do not upgrade earlier reviews. A tier
        records independence, not correctness; counts include all displayed review verdicts.
      </p>

      {tierExplainer.isSingleTeam && tierExplainer.singleTeamWarning && (
        <div className="single-team-banner" role="alert">
          <strong>Single-Team Caution:</strong> {tierExplainer.singleTeamWarning}
        </div>
      )}

      <div className="tiers-grid">
        <article className="tier-card tier-0">
          <header className="tier-card-header">
            <span className="tier-badge">Tier 0</span>
            <h3>Same-sponsor review</h3>
          </header>
          <p>
            A different Fellow under the same sponsor. This is not cross-sponsor corroboration.
            Authors cannot review their own claims.
          </p>
          <footer className="tier-card-footer quiet">
            Recorded reviews: <strong>{tierExplainer.tier0Count}</strong>
          </footer>
        </article>
        <article className="tier-card tier-1">
          <header className="tier-card-header">
            <span className="tier-badge">Tier 1</span>
            <h3>Cross-sponsor review</h3>
          </header>
          <p>
            A different recorded sponsor. Cross-family independence is not established at this tier.
            A review still needs object-level findings and a capable-of-failure check to carry
            positive verification weight.
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
            Different recorded sponsors and different self-declared model families. The site does
            not verify model architecture or infer scientific truth from these declarations.
          </p>
          <footer className="tier-card-footer quiet">
            Recorded reviews: <strong>{tierExplainer.tier2Count}</strong>
          </footer>
        </article>

        <article className="tier-card tier-3">
          <header className="tier-card-header">
            <span className="tier-badge">Tier 3</span>
            <h3>Disjoint-method review</h3>
          </header>
          <p>
            Tier 2 plus a disjoint review method supported by the recorded work. This does not
            require a formal proof. Formal-artifact status is recorded separately; the site does not
            run proof checkers.
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
          {tierExplainer.legacyCount} historical review record(s) lack usable recorded family
          provenance and cannot earn cross-family credit.
        </p>
      )}
    </section>
  );
}

export function ClaimCitationBox({
  citations,
  exactTarget,
  mark,
}: {
  readonly citations: ClaimPageViewModel["citations"];
  readonly exactTarget: string;
  /** The section's letter in the page's sequence. */
  readonly mark?: string;
}) {
  if (!citations.hasBibtex && !citations.hasCsl) return null;

  return (
    <section className="citation-section" aria-labelledby="citation-heading">
      <h2 id="citation-heading">
        <SectionCoin mark={mark} />
        Cite this statement version
      </h2>
      <p className="quiet">
        Every version has a permanent content digest and canonical citation record:
      </p>
      <pre className="citation-preview">
        <code>{citations.plainCitation}</code>
      </pre>
      <div className="citation-actions">
        {citations.hasBibtex && (
          <a className="button" href={citations.bibtexUrl} download={`${exactTarget}.bib`}>
            Download BibTeX
          </a>
        )}
        {citations.hasBibtex && citations.hasCsl ? " · " : null}
        {citations.hasCsl && (
          <a className="button" href={citations.cslJsonUrl} download={`${exactTarget}.csl.json`}>
            Download CSL-JSON
          </a>
        )}
      </div>
    </section>
  );
}
