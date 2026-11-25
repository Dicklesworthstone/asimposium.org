import { EnrollmentProblemBindingSchema, type PublicMovesResponse } from "@asimposium/contracts";
import Link from "next/link";
import type { PublicRead } from "@/lib/public-ledger";
import { PublicReadNotice } from "./public-read-unavailable";

/**
 * A home page section, so it uses the home section head: `mark` is the
 * section letter the page assigns (the page owns the α, β, … sequence), and
 * the link label stays as short as its siblings' ("All areas →") because
 * section-head links never wrap.
 */
export function HomeScientificNeeds({
  result,
  mark,
}: {
  readonly result: PublicRead<PublicMovesResponse>;
  readonly mark?: string;
}) {
  const face = result.state === "ok" && !result.noindex ? result.data : undefined;
  const discovery = face?.discovery;
  const incomplete = discovery?.degraded || discovery?.problems.some((problem) => problem.degraded);
  const needs = discovery?.problems.flatMap(({ problem_id, primary_move, captured_cursor }) =>
    primary_move ? [{ problem_id, primary_move, captured_cursor }] : [],
  );
  // An empty public ledger is not "no move selected": say plainly that there
  // is nothing listed, rather than reporting zero problems examined.
  const nothingListed =
    discovery !== undefined && discovery.scanned === 0 && !incomplete && !discovery.next_after;
  return (
    <section aria-labelledby="scientific-needs-heading">
      <header className="section-head">
        <h2 id="scientific-needs-heading">
          {mark ? (
            <span className="gr" aria-hidden="true">
              {mark}
            </span>
          ) : null}
          Problems needing help
        </h2>
        <Link href="/moves" prefetch={false} className="btn-quiet">
          All needs →
        </Link>
      </header>
      {face && discovery && needs ? (
        <>
          {nothingListed ? null : (
            <p className="quiet">
              The ledger examined {discovery.scanned} listed working {discovery.scanned === 1 ? "problem" : "problems"} on this page.
              {incomplete && " Some scientific inputs were unavailable. This selection is incomplete."}
            </p>
          )}
          {needs.length > 0 ? (
            <ol className="claims-list needs-list">
              {needs.map(({ problem_id, primary_move, captured_cursor }) => (
                <li className="claim-card need-card" key={problem_id}>
                  <p className="need-move">{face.moves[primary_move.move].title}</p>
                  <h3>
                    <Link href={`/p/${encodeURIComponent(problem_id)}`} prefetch={false}>
                      {problem_id}
                    </Link>
                  </h3>
                  <p className="need-why">{primary_move.why}</p>
                  <div className="need-foot">
                    <span className="quiet">Selected at problem ledger seq {captured_cursor}</span>
                    {EnrollmentProblemBindingSchema.safeParse(problem_id).success && (
                      <Link
                        className="btn-quiet"
                        href={`/console?problem=${encodeURIComponent(problem_id)}#onboard-title`}
                        prefetch={false}
                      >
                        Onboard a Fellow<span className="sr-only"> for {problem_id}</span>
                      </Link>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p>{nothingListed
              ? "No working problems are listed on the public ledger yet, so there is nothing to recommend."
              : incomplete
                ? "The available inputs yielded no recommendation on this page."
                : "No primary move was selected for this page of problems."}</p>
          )}
          {discovery.next_after && (
            <p><Link href={`/moves?${new URLSearchParams({ after: discovery.next_after })}`} prefetch={false}>
              Check the next page of problems
            </Link></p>
          )}
        </>
      ) : (
        <PublicReadNotice retryPath="/" />
      )}
    </section>
  );
}
