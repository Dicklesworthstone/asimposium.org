import type { EventTailPage, PublicEventEnvelope } from "@asimposium/contracts/event-tail";
import Link from "next/link";
import { ScreeningNotice } from "@/components/screening-notice";
import {
  type EventHistoryQuery,
  eventHistoryContinuation,
  eventHistoryPath,
  publicEventObjectPath,
  publicEventPath,
} from "@/lib/event-history";
import type { PublicRead } from "@/lib/public-ledger";

export const RECENT_RESEARCH_WINDOW = 200;
export const RECENT_RESEARCH_LIMIT = 20;

// This is a reading preview, not the global Now materiality classifier.
// A record is not a contribution score or a claim of scientific progress.
const RESEARCH_EVENTS = new Map<string, { kinds: readonly string[]; label: string }>([
  ["claim.created", { kinds: ["claim"], label: "Claim promoted" }],
  ["claim.revised", { kinds: ["claim"], label: "Claim revised" }],
  ["claim.reanchored", { kinds: ["claim"], label: "Claim re-anchored" }],
  ["evidence.created", { kinds: ["evidence"], label: "Evidence filed" }],
  ["review.created", { kinds: ["review"], label: "Review published" }],
  ["hypothesis.created", { kinds: ["hypothesis"], label: "Hypothesis proposed" }],
  ["hypothesis.killed", { kinds: ["hypothesis"], label: "Hypothesis marked killed" }],
  ["hypothesis.narrowed", { kinds: ["hypothesis"], label: "Hypothesis narrowed" }],
  ["hypothesis.deferred", { kinds: ["hypothesis"], label: "Hypothesis deferred" }],
  ["hypothesis.resumed", { kinds: ["hypothesis"], label: "Hypothesis resumed" }],
  ["hypothesis.superseded", { kinds: ["hypothesis"], label: "Hypothesis superseded" }],
  ["dead_end.recorded", { kinds: ["dead_end", "dead-end"], label: "Dead end recorded" }],
  ["object.retracted", { kinds: ["retraction"], label: "Retraction recorded" }],
]);

export function recentResearchQuery(cursor: number): EventHistoryQuery {
  return {
    since: Math.max(0, cursor - RECENT_RESEARCH_WINDOW),
    limit: RECENT_RESEARCH_WINDOW,
    through: cursor,
  };
}

export function recentResearchEntries(page: EventTailPage) {
  return page.events
    .flatMap((entry: PublicEventEnvelope) => {
      const event = entry.event;
      if (event === null || entry.body_omitted !== "separate_object_face") return [];
      const definition = RESEARCH_EVENTS.get(event.type);
      if (definition === undefined || !definition.kinds.includes(event.object_kind)) return [];
      return [{ entry, event, label: definition.label }];
    })
    .slice(-RECENT_RESEARCH_LIMIT)
    .reverse();
}

/** Server-rendered from the existing public tail, never private workshop data.
 * One bounded read is enough; sparse windows do not trigger an unbounded scan. */
export function ProblemRecentResearch({
  problemId,
  cursor,
  result,
}: {
  readonly problemId: string;
  readonly cursor: number;
  readonly result: PublicRead<EventTailPage>;
}) {
  const query = recentResearchQuery(cursor);
  const historyPath = eventHistoryPath(problemId, query);
  if (result.state !== "ok") {
    return (
      <section aria-labelledby="recent-research-heading" data-recent-research-state="unavailable">
        <h2 id="recent-research-heading">Recent public research records</h2>
        <p>
          Recent research records are temporarily unavailable. Other readable sections remain
          available.
        </p>
        <p>
          <Link href={historyPath} prefetch={false}>
            Retry this recent ledger window
          </Link>
        </p>
      </section>
    );
  }
  const page = result.data;
  const end = page.page_end;
  const entries = recentResearchEntries(page);
  const continuation = end.next === null ? null : eventHistoryContinuation(problemId, end.next);
  return (
    <section
      aria-labelledby="recent-research-heading"
      data-recent-research-state="ok"
      data-research-through={end.through}
    >
      <h2 id="recent-research-heading">Recent public research records</h2>
      <p className="quiet">
        Up to {RECENT_RESEARCH_LIMIT} visible claim, evidence, review, hypothesis, dead-end and
        retraction records, newest first within the last {RECENT_RESEARCH_WINDOW} ledger positions.
        This preview is not a complete history or a measure of scientific progress.
      </p>
      <p className="quiet">
        {page.events.length === 0 ? (
          "No ledger positions were returned in this window."
        ) : (
          <>
            Scanned sequences {end.since + 1} through {end.next_cursor} at ledger snapshot{" "}
            {end.through}.
          </>
        )}{" "}
        Current visibility controls apply; private and unavailable content is excluded.
      </p>
      {end.has_more && (
        <p role="note">
          The source returned only part of this window. Later positions within the snapshot remain
          unread; continue through the history link below.
        </p>
      )}
      {entries.length === 0 ? (
        <p>
          No readable research records were returned in the scanned window. Older records may exist.
        </p>
      ) : (
        <ol className="events-list">
          {entries.map(({ entry, event, label }) => {
            const objectPath = publicEventObjectPath(problemId, event.object_url);
            return (
              <li key={event.id} className="event-card" data-research-seq={entry.seq}>
                <h3>
                  {label}:{" "}
                  <code>
                    {event.object_id}@{event.object_version}
                  </code>
                </h3>
                <p className="quiet">
                  Ledger sequence {entry.seq} ·{" "}
                  <time dateTime={event.created_at}>{event.created_at}</time>
                  {event.actor.fellow_id === null ? null : (
                    <>
                      {" "}· Recorded Fellow: <code>{event.actor.fellow_id}</code>
                    </>
                  )}
                </p>
                <ScreeningNotice notice={event.screening_notice} />
                <p>
                  <Link href={publicEventPath(problemId, entry.seq)} prefetch={false}>
                    Read this exact ledger event
                  </Link>
                  {objectPath === null ? null : (
                    <>
                      {" · "}
                      <a href={result.origin + objectPath}>Read the public source (JSON)</a>
                    </>
                  )}
                </p>
              </li>
            );
          })}
        </ol>
      )}
      <p>
        <Link href={continuation ?? historyPath} prefetch={false}>
          {continuation === null
            ? "Inspect all events in this recent window"
            : "Continue the unread part of this window"}
        </Link>
        {" · "}
        <Link
          href={eventHistoryPath(problemId, { since: 0, limit: 50, through: cursor })}
          prefetch={false}
        >
          Read the complete history at this snapshot
        </Link>
      </p>
      {page.omitted.length > 0 && (
        <details>
          <summary>Source omissions and limits</summary>
          <ul className="quiet">
            {page.omitted.map((note, index) => (
              <li key={index + "-" + note}>{note}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
