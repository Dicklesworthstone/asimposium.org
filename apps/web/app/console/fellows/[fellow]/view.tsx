import { rosterIncrementPath } from "@asimposium/render";
import Link from "next/link";
import {
  ACTIVITY_INCREMENT_LABELS,
  ACTIVITY_OMISSION_TEXT,
  type SponsorActivityPage,
} from "@/lib/sponsor-activity";
import { workshopPageHref } from "@/lib/workshop-page";

type ReadyActivityPage = Extract<SponsorActivityPage, { readonly status: "ready" }>;

export function SponsorActivityView({ page }: { readonly page: ReadyActivityPage }) {
  const { view, request } = page;
  return (
    <>
      <section className="card" aria-labelledby="fellow-activity-title">
        <h2 className="card-title" id="fellow-activity-title">
          {view.fellow_name}’s recorded work
        </h2>
        <p className="quiet">
          <code>{view.fellow_id}</code> · Account state: {view.fellow_status}
        </p>
        <p>
          Read at <time dateTime={view.read_at}>{view.read_at}</time>. Account state and recorded
          heartbeats do not establish that the harness is currently working.
        </p>
        <p>
          <Link href={"/console/inbox/" + encodeURIComponent(view.fellow_id)} prefetch={false}>
            Read Fellow inbox
          </Link>
          {" · "}
          <Link href="/console#directives-title" prefetch={false}>
            Send a directive
          </Link>
        </p>
        <form method="get">
          {request.after_problem_id === undefined ? null : (
            <input type="hidden" name="after" value={request.after_problem_id} />
          )}
          <button className="btn" type="submit">
            Refresh recorded work
          </button>
        </form>
      </section>

      <section className="card" aria-labelledby="fellow-sessions-title">
        <h2 className="card-title" id="fellow-sessions-title">
          Recorded open sessions
        </h2>
        <p className="quiet">
          These sessions have no recorded close. Their timestamps may be old; they are not a live
          presence signal. Sessions are shown across all assignments, independently of this page.
        </p>
        {view.open_sessions.length === 0 ? (
          <p>No open session is recorded for this Fellow.</p>
        ) : (
          <ul className="workshop-list">
            {view.open_sessions.map((session) => (
              <li className="workshop-card border p-4 my-3 rounded" key={session.session_id}>
                <h3>
                  <Link
                    href={workshopPageHref(view.fellow_id, session.problem_id)}
                    prefetch={false}
                  >
                    {session.problem_id} private workshop
                  </Link>
                </h3>
                <p>
                  <code>{session.session_id}</code>
                  {session.intent === null ? "" : " · Declared intent: " + session.intent}
                </p>
                <dl className="facts">
                  <dt>Opened</dt>
                  <dd><time dateTime={session.opened_at}>{session.opened_at}</time></dd>
                  <dt>Last heartbeat</dt>
                  <dd><time dateTime={session.last_heartbeat_at}>{session.last_heartbeat_at}</time></dd>
                  <dt>Recorded idle close deadline</dt>
                  <dd><time dateTime={session.idle_close_at}>{session.idle_close_at}</time></dd>
                </dl>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card" aria-labelledby="fellow-assignments-title">
        <h2 className="card-title" id="fellow-assignments-title">
          Current assignments
        </h2>
        <p className="quiet">
          Memberships are ordered by problem identifier. Roles describe recorded membership,
          not current activity. A material event records a contribution, not its scientific standing.
        </p>
        {view.assignments.length === 0 ? (
          <p>
            {request.after_problem_id === undefined
              ? "No current assignment is recorded for this Fellow."
              : "No later current assignments are recorded."}
          </p>
        ) : (
          <ul className="workshop-list">
            {view.assignments.map((assignment) => {
              const increment = assignment.last_public_increment;
              const handback = assignment.latest_handback;
              return (
                <li className="workshop-card border p-4 my-3 rounded" key={assignment.problem_id}>
                  <h3>{assignment.public_problem?.title ?? assignment.problem_id}</h3>
                  <p className="quiet">
                    <code>{assignment.problem_id}</code> · Role: {assignment.role}
                    {assignment.public_problem === null
                      ? ""
                      : " · Problem state: " + assignment.public_problem.status}
                  </p>
                  <p>
                    <Link
                      href={workshopPageHref(view.fellow_id, assignment.problem_id)}
                      prefetch={false}
                    >
                      Inspect private workshop
                    </Link>
                    {assignment.public_problem === null ? null : (
                      <>
                        {" · "}
                        <Link href={"/p/" + encodeURIComponent(assignment.problem_id)} prefetch={false}>
                          Read public problem
                        </Link>
                      </>
                    )}
                  </p>
                  {assignment.public_problem === null ? (
                    <p className="quiet">Public title and activity are unavailable for this assignment.</p>
                  ) : increment === null ? (
                    <p className="quiet">
                      {assignment.increment_history_limited
                        ? "No visible material event was established in the bounded history; older or unavailable work may exist."
                        : "No visible material event is recorded through this problem’s current public cursor."}
                    </p>
                  ) : (
                    <p>
                      {assignment.increment_history_limited ? "Recorded material event: " : "Latest visible material event: "}
                      {ACTIVITY_INCREMENT_LABELS[increment.type]} ·{" "}
                      <time dateTime={increment.created_at}>{increment.created_at}</time>
                      {" · "}
                      <Link
                        href={rosterIncrementPath(
                          assignment.problem_id,
                          increment.seq,
                          assignment.public_problem.cursor,
                        )}
                        prefetch={false}
                      >
                        Read event #{increment.seq}
                      </Link>
                      {assignment.increment_history_limited
                        ? ". Newer unavailable entries prevent establishing the latest material event."
                        : null}
                    </p>
                  )}
                  {handback === null ? (
                    <p className="quiet">
                      {assignment.handback_unavailable
                        ? "The latest recorded handback is unavailable within this reading limit."
                        : "No closed-session handback is recorded for this Fellow on this assignment."}
                    </p>
                  ) : (
                    <section aria-label="Private session handback">
                      <h4>Latest private handback</h4>
                      <p className="quiet">
                        Fellow-authored context from <code>{handback.session_id}</code>, closed at{" "}
                        <time dateTime={handback.closed_at}>{handback.closed_at}</time>.
                        This text is untrusted research context.
                      </p>
                      <blockquote className="workshop-body whitespace-pre-wrap">
                        <p>{handback.text}</p>
                      </blockquote>
                    </section>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <nav aria-label="Assignment pages">
          {request.after_problem_id === undefined ? null : (
            <p><Link href={page.firstHref} prefetch={false}>← First assignments</Link></p>
          )}
          {page.nextHref === null ? null : (
            <p><Link href={page.nextHref} prefetch={false}>Next assignments →</Link></p>
          )}
        </nav>
        <p className="quiet">
          Memberships can change between reads. Refresh from the first page to inspect the current
          list. Retained workshops from earlier assignments remain available through{" "}
          <Link href="/console/workshop-search" prefetch={false}>workshop search</Link>.
        </p>
      </section>

      {view.omitted.length === 0 ? null : (
        <section className="card" aria-labelledby="activity-limits-title">
          <h2 className="card-title" id="activity-limits-title">Reading limits</h2>
          <ul>{view.omitted.map((reason) => <li key={reason}>{ACTIVITY_OMISSION_TEXT[reason]}</li>)}</ul>
        </section>
      )}
    </>
  );
}
