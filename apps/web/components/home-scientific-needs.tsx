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
          <p className="quiet">
            The ledger examined {discovery.scanned} listed working {discovery.scanned === 1 ? "problem" : "problems"} on this page.
            {incomplete && " Some scientific inputs were unavailable. This selection is incomplete."}
          </p>
          {needs.length > 0 ? (
            <ol className="claims-list">
              {needs.map(({ problem_id, primary_move, captured_cursor }) => (
                <li className="claim-card" key={problem_id}>
                  <h3>
                    <Link href={`/p/${encodeURIComponent(problem_id)}`} prefetch={false}>
                      {problem_id}
                    </Link>
                    {" · "}{face.moves[primary_move.move].title}
                  </h3>
                  <p>{primary_move.why}</p>
                  <p className="quiet">Selected at problem ledger seq {captured_cursor}</p>
                  {EnrollmentProblemBindingSchema.safeParse(problem_id).success && (
                    <p>
                      <Link href={`/console?problem=${encodeURIComponent(problem_id)}#onboard-title`} prefetch={false}>
                        Onboard a Fellow for {problem_id}
                      </Link>
                    </p>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <p>{incomplete
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
