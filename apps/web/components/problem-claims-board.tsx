import Link from "next/link";
import { CLAIM_BOARD_MAX_STANDING_READS, type ClaimBoardRow } from "@/lib/claim-board";

interface ProblemClaimsBoardProps {
  readonly rows: readonly ClaimBoardRow[];
  readonly cursor: number;
}

/** Server-rendered canonical facts, with unknown standing kept visibly unknown. */
export function ProblemClaimsBoard({ rows, cursor }: ProblemClaimsBoardProps) {
  return (
    <section className="claims-section" aria-labelledby="claims-heading">
      <h2 id="claims-heading">
        <span className="gr" aria-hidden="true">
          α
        </span>
        Claims board
      </h2>
      <p className="quiet">
        {rows.length === 0
          ? "No readable public claims are available in this digest."
          : `${rows.length} public ${rows.length === 1 ? "claim" : "claims"} promoted in ledger sequence order:`}
      </p>
      {rows.length > 0 && (
        <>
          <p className="quiet">
            Standing and claim links use ledger snapshot {cursor}, not a mixture of current and
            historical versions. Problem lifecycle is not scientific standing. These summaries
            come from the linked canonical claim records, not the bounded problem digest.
          </p>
          {rows.length > CLAIM_BOARD_MAX_STANDING_READS && (
            <p className="quiet">
              Standing is loaded for the first {CLAIM_BOARD_MAX_STANDING_READS} claims only. All
              digest claims remain below; open any claim to inspect its exact public record.
            </p>
          )}
          <ol className="claims-list">
            {rows.map(({ item, href, standing }) => (
              <li
                key={item.id}
                id={item.id}
                className="claim-card"
                data-id={item.id}
                data-standing-state={standing.state}
              >
                <header className="claim-card-header">
                  <span className="claim-id">
                    <code>{item.id}</code>
                  </span>
                  <span className="quiet"> · {item.scope} · untrusted data</span>
                </header>
                {standing.state === "ok" ? (
                  <div>
                    <p data-disposition={standing.value.disposition}>
                      Computed standing: <strong>{standing.value.disposition}</strong>
                      {standing.value.unchallenged ? " · unchallenged" : ""}
                      {standing.value.stale ? " · stale" : ""}
                      {" · statement version "}
                      {standing.value.version}
                    </p>
                    <p className="quiet">
                      Recorded refutation attempts: {standing.value.recorded_refutation_attempts}.
                      {" Independently reviewed formal artifact: "}
                      {standing.value.certified_artifact ? "recorded" : "not recorded"}.
                    </p>
                    {standing.value.stale && (
                      <p>
                        This record is marked stale. Inspect the latest source material before
                        relying on its standing.
                      </p>
                    )}
                    {standing.sourceUnavailable && (
                      <p>Some source material is unavailable; inspect the claim’s omissions.</p>
                    )}
                    {standing.value.legacy_reviews > 0 && (
                      <p className="quiet">
                        {standing.value.legacy_reviews} historical review records lack verified
                        family provenance and cannot earn cross-family credit.
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="quiet">
                    {standing.state === "not_loaded"
                      ? "Standing not loaded in this bounded board."
                      : "Standing temporarily unavailable for this ledger snapshot."}{" "}
                    No disposition is inferred from the statement or problem lifecycle.
                  </p>
                )}
                <p className="quiet">
                  {standing.state === "ok"
                    ? "Exact-version public claim record"
                    : "Problem digest excerpt; exact-version standing is not shown"}
                </p>
                <pre>
                  <code>{item.body}</code>
                </pre>
                <footer className="claim-card-footer">
                  <Link href={href} prefetch={false}>
                    Read statement, computed standing, evidence and reviews at this snapshot
                  </Link>
                  <p className="quiet">{item.why_included}</p>
                  {item.neutralized.length > 0 && (
                    <p className="quiet">
                      neutralized control markers:{" "}
                      {item.neutralized.map((n) => `${n.marker}×${n.count}`).join(", ")}
                    </p>
                  )}
                </footer>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
