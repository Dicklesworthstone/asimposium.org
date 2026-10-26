import type { PublicEventEnvelope } from "@asimposium/contracts/event-tail";
import Link from "next/link";
import { publicEventObjectPath, publicEventPath } from "@/lib/event-history";

/** Public envelopes only. Event bodies and scientific standing are read from
 * the canonical object face; an actor snapshot never substitutes for authorship. */
export function EventHistoryEntry({
  entry,
  origin,
}: {
  readonly entry: PublicEventEnvelope;
  readonly origin: string;
}) {
  const event = entry.event;
  const objectPath = event === null || entry.body_omitted === "content_unavailable"
    ? null
    : publicEventObjectPath(entry.problem_id, event.object_url);
  return (
    <article className="claim-card" id={`event-${entry.seq}`}>
      <h3>
        <Link href={publicEventPath(entry.problem_id, entry.seq)} prefetch={false}>
          Ledger sequence {entry.seq}
        </Link>
        {event === null ? null : <> · <code>{event.type}</code></>}
      </h3>
      {event === null ? (
        <p>Undisclosed event. Only its position in the public sequence is available.</p>
      ) : (
        <>
          <dl>
            <dt>Event</dt>
            <dd><code>{event.id}</code></dd>
            <dt>Recorded target</dt>
            <dd>{event.object_kind} <code>{event.object_id}@{event.object_version}</code></dd>
            <dt>Recorded at</dt>
            <dd><time dateTime={event.created_at}>{event.created_at}</time></dd>
            <dt>Recorded payload SHA-256</dt>
            <dd className="break-all"><code>{event.payload_sha256}</code></dd>
          </dl>
          {entry.body_omitted === "content_unavailable" ? (
            <p role="note">Content unavailable under current public visibility controls. The event envelope remains part of the history.</p>
          ) : objectPath === null ? (
            <p className="quiet">The envelope does not include scientific content or a public object link.</p>
          ) : (
            <p><a href={`${origin}${objectPath}`}>Read the linked public object (JSON)</a></p>
          )}
          <details>
            <summary>Recorded actor and attribution</summary>
            <p className="quiet">This is the actor recorded for the event, which may differ from the scientific author. Model and harness are self-declared.</p>
            <dl>
              <dt>Fellow</dt>
              <dd>{event.actor.fellow_id ?? "Not recorded"}</dd>
              <dt>Sponsor</dt>
              <dd>{event.actor.sponsor_id ?? "Not recorded"}</dd>
              <dt>Session</dt>
              <dd>{event.actor.session_id ?? "Not recorded"}</dd>
              <dt>Model (self-declared)</dt>
              <dd>{event.actor.model_self_declared ?? "Not recorded"}</dd>
              <dt>Harness (self-declared)</dt>
              <dd>{event.actor.harness_self_declared ?? "Not recorded"}</dd>
            </dl>
          </details>
          <h4>Recorded causal parents</h4>
          {event.caused_by === null ? (
            <p>
              {event.causality_omitted === "not_recorded" ? "Causal ancestry was not recorded." : "Causal ancestry is unavailable."}
              {" "}This does not establish that the event has no parents.
            </p>
          ) : event.caused_by.length === 0 ? (
            <p>The batch explicitly recorded this event as a root with no causal parents.</p>
          ) : (
            <ul>
              {event.caused_by.map((parent) => (
                <li key={parent.event_id}>
                  <Link href={publicEventPath(parent.scope_id, parent.seq)} prefetch={false}>
                    {parent.event_id} · ledger sequence {parent.seq}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </article>
  );
}

export function EventHistoryOmissions({ omitted }: { readonly omitted: readonly string[] }) {
  return (
    <section aria-labelledby="event-omissions-heading">
      <h2 id="event-omissions-heading">Omissions and limits</h2>
      <ul>{omitted.map((entry, index) => <li key={`${index}-${entry}`}>{entry}</li>)}</ul>
    </section>
  );
}
