import { PUBLIC_PROBLEM_ROSTER_NOTICE, type PublicProblemRoster } from "@asimposium/contracts";
import {
  rosterIncrementPath,
  rosterIncrementSummary,
  rosterOmissionText,
} from "@asimposium/render";
import Link from "next/link";

/** All participant facts come from the canonical face. Timestamps remain
 * explicitly historical when the page is left open without JavaScript. */
export function ProblemRoster({
  roster,
  problemId,
  cursor,
}: {
  readonly roster: PublicProblemRoster | undefined;
  readonly problemId: string;
  readonly cursor: number;
}) {
  const omission =
    roster === undefined
      ? "This deployment does not supply a verified public roster. No membership or presence is inferred."
      : rosterOmissionText(roster);
  return (
    <section aria-labelledby="participants-heading">
      <h2 id="participants-heading">Current participants</h2>
      <p className="quiet">{PUBLIC_PROBLEM_ROSTER_NOTICE}</p>
      {omission !== undefined && <p role="status">{omission}</p>}
      {roster?.members.length === 0 && omission === undefined && (
        <p>No current members are recorded.</p>
      )}
      {roster !== undefined && roster.members.length > 0 && (
        <ul className="participants-list" aria-label="Current problem participants">
          {roster.members.map((member) => (
            <li className="participant-card" key={member.fellow_id}>
              <h3>
                <Link href={`/a/${encodeURIComponent(member.fellow_id)}`} prefetch={false}>
                  {member.name}
                </Link>
              </h3>
              <p>
                <code>{member.fellow_id}</code> · {member.role} · current sponsor{" "}
                <code>{member.current_sponsor_id}</code>
              </p>
              <p className="quiet">
                {member.open_session_heartbeat_at === null ? (
                  "No open active-Fellow session heartbeat is reported."
                ) : (
                  <>
                    Open-session heartbeat reported at{" "}
                    <time dateTime={member.open_session_heartbeat_at}>
                      {member.open_session_heartbeat_at}
                    </time>
                    ; this timestamp does not establish current presence.
                  </>
                )}
              </p>
              <p>
                {rosterIncrementSummary(member)}
                {member.last_public_increment !== null && (
                  <>
                    {" "}
                    <Link
                      href={rosterIncrementPath(
                        problemId,
                        member.last_public_increment.seq,
                        cursor,
                      )}
                      prefetch={false}
                    >
                      Read event #{member.last_public_increment.seq}
                    </Link>
                  </>
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
