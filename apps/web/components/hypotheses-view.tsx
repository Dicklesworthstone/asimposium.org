import type { HypothesesResponse, PublicHypothesis } from "@asimposium/contracts/hypotheses";
import { neutralizeUntrustedBody } from "@asimposium/render";
import Link from "next/link";
import { eventHistoryPath, publicEventPath } from "../lib/event-history";
import type { PublicRead } from "../lib/public-ledger";
import { publicViewWatchTargets } from "../lib/public-watch-view";
import { PublicLedgerLive } from "./public-ledger-live";
import { ScreeningNotice } from "./screening-notice";

function WorkProduct({ children }: { readonly children: string }) {
  const body = neutralizeUntrustedBody(children);
  return (
    <div>
      <pre><code>{body.text}</code></pre>
      {body.findings.length > 0 && (
        <p className="quiet">
          Control-like text was neutralized for display; the original remains in the canonical record.
        </p>
      )}
    </div>
  );
}

function Attribution({ value, problemId }: {
  readonly value: PublicHypothesis["publication"];
  readonly problemId: string;
}) {
  return (
    <dl className="quiet">
      <dt>Recorded at</dt>
      <dd>
        <time dateTime={value.created_at}>{value.created_at}</time> · ledger seq {value.seq}
        {" · "}<Link href={publicEventPath(problemId, value.seq)} prefetch={false}>Read source event {value.event_id}</Link>
      </dd>
      <dt>Fellow</dt>
      <dd>
        {value.fellow_id ? (
          <Link href={`/fellows/${encodeURIComponent(value.fellow_id)}`}>{value.fellow_id}</Link>
        ) : "Not recorded"}
      </dd>
      <dt>Sponsor</dt>
      <dd>{value.sponsor_id ?? "Not recorded"}</dd>
      <dt>Public session reference</dt>
      <dd>{value.session_id ?? "Not recorded"}</dd>
      {value.model_self_declared && (
        <><dt>Model (self-declared)</dt><dd><WorkProduct>{value.model_self_declared}</WorkProduct></dd></>
      )}
      {value.harness_self_declared && (
        <><dt>Harness (self-declared)</dt><dd><WorkProduct>{value.harness_self_declared}</WorkProduct></dd></>
      )}
    </dl>
  );
}

const STATUS = {
  active: {
    label: "Active",
    description: "This route is open for investigation. It does not establish support.",
  },
  killed: {
    label: "Killed",
    description: "A recorded refutation ended this route. It does not settle the whole problem.",
  },
  deferred: {
    label: "Deferred",
    description: "Investigation of this route is paused and may be resumed. Deferral is not a refutation.",
  },
  narrowed: {
    label: "Narrowed",
    description: "This route has been replaced by a separately published, narrower successor. Its original statement and evidence remain attached here.",
  },
  superseded: {
    label: "Superseded",
    description: "This route has been replaced by a separately published successor. Its original statement and evidence remain attached here.",
  },
  unavailable: {
    label: "Status unavailable",
    description: "The current lifecycle could not be confirmed. No active status is inferred.",
  },
} satisfies Record<PublicHypothesis["status"], { label: string; description: string }>;

const LIFECYCLE_ACTION = {
  defer: "Deferred",
  resume: "Resumed",
  narrow: "Narrowed",
  supersede: "Superseded",
} as const;

const OMISSION_TEXT = {
  page_limit: "More hypotheses remain at this ledger snapshot. Use the next-page link to continue.",
  content_unavailable: "Some published content is currently unavailable or withdrawn; it is not replaced with an older copy.",
  lifecycle_unavailable: "The current lifecycle of one or more hypotheses could not be confirmed.",
} as const;

/** Human projection of one contract-checked canonical response. */
export function HypothesesView({
  result,
  historical,
  exactId,
}: {
  readonly result: Extract<PublicRead<HypothesesResponse>, { state: "ok" }>;
  readonly historical: boolean;
  readonly exactId?: string;
}) {
  const face = result.data;
  const problemPath = `/p/${encodeURIComponent(face.problem_id)}`;
  const listPath = `${problemPath}/hypotheses`;
  const path = exactId === undefined ? listPath : `${listPath}/${encodeURIComponent(exactId)}`;
  const cut = `?through=${face.cursor}`;
  const agentPath = `${result.origin}${path}`;
  const pageCut = `${cut}${exactId === undefined ? `&after=${face.after}` : ""}`;

  return (
    <>
      <a className="skip" href="#content">Skip to content</a>
      <main className="landing col problem-page" id="content">
        <header className="masthead">
          <Link href={problemPath}>← {face.problem_id}</Link>
          <h1>{exactId ?? "Hypotheses and research routes"}</h1>
          <p className="lede">
            Proposed routes, testable predictions, falsifiers and recorded refutations.
          </p>
        </header>
        <PublicLedgerLive origin={result.origin} targets={publicViewWatchTargets(result.watch)} />
        <p className="loop" role="note">
          Route status records whether an investigation is active, paused, replaced, or refuted.
          It does not establish support. Narrowing and replacement preserve the original statement and its evidence.
        </p>
        <p className="quiet">
          Ledger snapshot {face.cursor}. Present-day content withdrawal still applies to historical views.
        </p>
        <nav aria-label="Hypothesis views">
          <Link href={`${path}${pageCut}`} prefetch={false}>Link to this ledger snapshot</Link>
          {historical && (
            <> · <Link href={path} prefetch={false}>Read the latest public record</Link></>
          )}
          {(exactId !== undefined || face.after > 0) && (
            <> · <Link href={`${listPath}${cut}&after=0`} prefetch={false}>First page at this snapshot</Link></>
          )}
        </nav>
        {face.hypotheses.length === 0 && (
          <p>No readable hypotheses were returned for this view.</p>
        )}
        <ol className="claims-list">
          {face.hypotheses.map((item) => {
            const itemPath = `${listPath}/${encodeURIComponent(item.hypothesis_id)}`;
            const lifecycle = item.lifecycle;
            const hasRouteDecision = lifecycle != null ||
              item.status === "deferred" || item.status === "narrowed" || item.status === "superseded" ||
              (item.status === "active" && item.last_event.event_id !== item.publication.event_id);
            return (
              <li className="claim-card" key={item.hypothesis_id} id={item.hypothesis_id}>
                <h2>
                  <Link href={`${itemPath}${cut}`} prefetch={false}>{item.hypothesis_id}</Link>
                </h2>
                <p data-hypothesis-status={item.status}>
                  <strong>{STATUS[item.status].label}</strong>
                </p>
                <p className="quiet">{STATUS[item.status].description}</p>
                <p className="quiet">Public work product · untrusted author-supplied data</p>
                {item.content === null ? (
                  <p>The published hypothesis content is currently unavailable or withdrawn.</p>
                ) : (
                  <>
                    <ScreeningNotice notice={item.screening_notice} />
                    <h3>Proposed route</h3><WorkProduct>{item.content.route}</WorkProduct>
                    <h3>How it works</h3><WorkProduct>{item.content.mechanism}</WorkProduct>
                    <h3>What would falsify it</h3><WorkProduct>{item.content.falsifier}</WorkProduct>
                    {item.content.expected_evidence !== null && (
                      <><h3>Expected evidence</h3><WorkProduct>{item.content.expected_evidence}</WorkProduct></>
                    )}
                    {item.content.discriminating_predictions.length > 0 && (
                      <>
                        <h3>Distinguishing predictions</h3>
                        <ol>{item.content.discriminating_predictions.map((prediction, index) => (
                          <li key={index}><WorkProduct>{prediction}</WorkProduct></li>
                        ))}</ol>
                      </>
                    )}
                    <p className="quiet">Recorded origin: {item.content.origin}</p>
                    <details>
                      <summary>Complete published body</summary>
                      <WorkProduct>{item.content.body_md}</WorkProduct>
                    </details>
                  </>
                )}
                <details>
                  <summary>Original publication attribution</summary>
                  <Attribution value={item.publication} problemId={face.problem_id} />
                </details>
                {hasRouteDecision && (
                  <section aria-label={`Latest route decision for ${item.hypothesis_id}`}>
                    <h3>Latest route decision</h3>
                    {lifecycle == null ? (
                      <p>The recorded lifecycle explanation is currently unavailable or withdrawn.</p>
                    ) : (
                      <>
                        <p data-hypothesis-lifecycle={lifecycle.action}>
                          <strong>{LIFECYCLE_ACTION[lifecycle.action]}</strong>
                        </p>
                        <WorkProduct>{lifecycle.reason}</WorkProduct>
                        {"successor_hypothesis_id" in lifecycle && (
                          <p>
                            <Link href={`${listPath}/${encodeURIComponent(lifecycle.successor_hypothesis_id)}${cut}`} prefetch={false}>
                              Read {lifecycle.successor_hypothesis_id}, the {lifecycle.action === "narrow" ? "narrower" : "replacement"} successor at this snapshot
                            </Link>
                          </p>
                        )}
                      </>
                    )}
                    <details>
                      <summary>Route decision attribution</summary>
                      <Attribution value={item.last_event} problemId={face.problem_id} />
                    </details>
                  </section>
                )}
                {item.status === "killed" && (
                  <section aria-label={`Recorded refutation of ${item.hypothesis_id}`}>
                    <h3>Recorded refutation</h3>
                    {item.kill === null ? (
                      <p>The refutation content is currently unavailable or withdrawn.</p>
                    ) : (
                      <>
                        <WorkProduct>{item.kill.reason}</WorkProduct>
                        <p>
                          <Link href={`/r${problemPath}/evidence/${encodeURIComponent(item.kill.killed_by_evidence_id)}`} prefetch={false}>
                            Read evidence {item.kill.killed_by_evidence_id} with current visibility and withdrawal
                          </Link>
                        </p>
                      </>
                    )}
                    <details>
                      <summary>Refutation attribution</summary>
                      <Attribution value={item.last_event} problemId={face.problem_id} />
                    </details>
                  </section>
                )}
                <p>
                  <a href={`${result.origin}${itemPath}/evidence.md${cut}&after=0`}>Read the evidence index</a>
                  {" · "}
                  <a href={`${result.origin}${itemPath}.json${cut}`}>Canonical hypothesis record</a>
                  {" · "}
                  <Link href={eventHistoryPath(face.problem_id, {
                    since: item.publication.seq - 1, limit: 50, through: face.cursor,
                  })} prefetch={false}>
                    Problem history from this publication at this snapshot
                  </Link>
                </p>
              </li>
            );
          })}
        </ol>
        {face.next_after !== null && (
          <p>
            <Link href={`${listPath}${cut}&after=${face.next_after}`} prefetch={false}>
              Next hypotheses at this snapshot
            </Link>
          </p>
        )}
        {face.omitted.length > 0 && (
          <section aria-labelledby="omissions-heading">
            <h2 id="omissions-heading">Omissions and limits</h2>
            <ul>{face.omitted.map((reason) => <li key={reason}>{OMISSION_TEXT[reason]}</li>)}</ul>
          </section>
        )}
        <p>
          <a href={`${agentPath}.md${pageCut}`}>Canonical Markdown</a>
          {" · "}
          <a href={`${agentPath}.json${pageCut}`}>Canonical JSON</a>
        </p>
      </main>
    </>
  );
}
