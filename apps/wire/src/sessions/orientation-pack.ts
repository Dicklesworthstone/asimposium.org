import {
  ProblemGovernanceEventSchema,
  ProblemStatementReviewEventSchema,
} from "@asimposium/contracts";
import {
  neutralizeUntrustedBody,
  type PackActionCandidate,
  type PackCandidate,
} from "@asimposium/render";
import type { D1Database } from "@cloudflare/workers-types";
import {
  eventTailPath,
  type PublicEventEnvelope,
} from "../../../../packages/contracts/src/event-tail-model.ts";
import { eventContentHiddenSql } from "../krater/public-content.ts";
import {
  type CitationContentRow,
  PUBLIC_EVENT_CONTENT_MAX_BYTES,
  verifiedCitationContent,
} from "../ledger/citation-read-integrity.ts";
import { readPublicEventTail } from "../ledger/event-tail-read.ts";
import { readPublishedProblemFormulation } from "../ledger/problem-formulation-read.ts";
import { isObjectLevelEvent } from "../mega-commands/materiality.ts";

export const ORIENTATION_EVENT_SCAN_LIMIT = 200;
export const ORIENTATION_EVENT_LIMIT = 5;
const CONDITIONAL_MATERIALITY_LIMIT = 12;
const MAX_ITEM_CHARACTERS = 18_000;

export interface OrientationPackSection {
  candidates: PackCandidate[];
  omitted: { reason: string; detail: string }[];
  actions: PackActionCandidate[];
}


async function readFormulation(
  db: D1Database,
  problem: string,
  cursor: number,
): Promise<OrientationPackSection> {
  const source = `/v1/problems/${problem}`;
  const section: OrientationPackSection = {
    candidates: [],
    omitted: [],
    actions: [
      {
        method: "GET",
        url: source,
        why: "Read the complete current problem statement, falsifier and motivation; recheck its version before a statement-sensitive write.",
        public_read: true,
      },
    ],
  };
  try {
    const event = await readPublishedProblemFormulation(db, problem, cursor);
    if (event === undefined) throw new Error("formulation commitment unavailable");
    const reference = {
      problem_id: problem,
      statement_version: event.problem.current_statement_version,
      publication: event.publication,
      source_fellow_id: event.source_fellow_id,
      acting_principal: event.acting_principal,
      current_problem_url: source,
    };
    let body = JSON.stringify({
      ...reference,
      title: event.problem.title,
      statement: event.problem.statement,
      falsifier: event.problem.falsifier,
      motivation: event.problem.motivation,
    });
    if (
      body.length > MAX_ITEM_CHARACTERS ||
      neutralizeUntrustedBody(body).text.length > MAX_ITEM_CHARACTERS
    ) {
      section.omitted.push({
        reason: "item_too_large",
        detail: `problem-formulation: read ${source}`,
      });
      body = JSON.stringify({ ...reference, content_omitted: "whole-formulation-size-limit" });
    }
    section.candidates.push({
      kind: "problem-formulation",
      id: `S@${event.problem.current_statement_version}`,
      scope: "ledger",
      untrusted: true,
      tokens: 1,
      stable_prefix: 2,
      body,
      ...(event.screening_notice === undefined ? {} : { screening_notice: event.screening_notice }),
      why_included:
        "the committed problem statement, falsifier and motivation at this pack's cursor",
    });
  } catch {
    section.omitted.push({
      reason: "problem_formulation_unavailable",
      detail:
        "The current public formulation could not be verified at this cursor; retained draft or projection text is not substituted.",
    });
  }
  return section;
}

async function conditionalMateriality(
  db: D1Database,
  problem: string,
  cursor: number,
  events: readonly PublicEventEnvelope[],
): Promise<Map<number, boolean>> {
  const conditional = events
    .flatMap((envelope) => {
      const event = envelope.event;
      return event !== null &&
        ["dead_end.recorded", "problem.statement-revised", "problem.statement-reviewed"].includes(
          event.type,
        )
        ? [{ envelope, event }]
        : [];
    })
    .slice(0, CONDITIONAL_MATERIALITY_LIMIT);
  const material = new Map<number, boolean>();
  if (conditional.length === 0) return material;
  // One bounded content read classifies events; none of these narrative
  // payloads are returned by the event summary.
  const result = await db
    .prepare(
      `SELECT e.id, e.problem_id, e.seq, p.public_seq,
        e.payload_sha256, c.payload_sha256 AS content_sha256, c.redacted_at,
        CASE WHEN length(CAST(c.payload_json AS BLOB)) <= ${PUBLIC_EVENT_CONTENT_MAX_BYTES} THEN c.payload_json END AS payload_json
      FROM events e JOIN problems p ON p.id = e.problem_id
      LEFT JOIN event_content c ON c.event_id = e.id
      WHERE e.problem_id = ? AND e.seq <= ?
        AND e.id IN (${conditional.map(() => "?").join(",")})
        AND p.status != 'private-draft'
        AND NOT ${eventContentHiddenSql("e")}`,
    )
    .bind(problem, cursor, ...conditional.map(({ event }) => event.id))
    .all<CitationContentRow & { id: string }>();
  for (const { envelope, event } of conditional) {
    const matches = result.results.filter(
      (row) => row.id === event.id && row.seq === envelope.seq,
    );
    const row = matches[0];
    if (
      matches.length !== 1 ||
      row === undefined ||
      row.payload_sha256 !== event.payload_sha256
    ) {
      continue;
    }
    const payload = await verifiedCitationContent(problem, row, PUBLIC_EVENT_CONTENT_MAX_BYTES);
    if (payload === undefined) continue;
    if (event.type === "dead_end.recorded") {
      material.set(
        envelope.seq,
        isObjectLevelEvent({ type: event.type, extract: row.payload_json }),
      );
    } else if (event.type === "problem.statement-revised") {
      const parsed = ProblemGovernanceEventSchema.safeParse(payload);
      if (
        parsed.success &&
        parsed.data.action === "revise-statement" &&
        parsed.data.problem.id === problem &&
        parsed.data.problem.current_statement_version === event.object_version
      ) {
        material.set(
          envelope.seq,
          isObjectLevelEvent({
            type: event.type,
            problem_status: parsed.data.previous_status,
          }),
        );
      }
    } else {
      const parsed = ProblemStatementReviewEventSchema.safeParse(payload);
      if (
        parsed.success &&
        parsed.data.problem_id === problem &&
        parsed.data.statement_version === event.object_version
      ) {
        // The lifecycle recorded by this event, never today's problem status.
        material.set(
          envelope.seq,
          isObjectLevelEvent({
            type: event.type,
            problem_status: parsed.data.previous_status,
          }),
        );
      }
    }
  }
  return material;
}

async function readEventDelta(
  db: D1Database,
  problem: string,
  cursor: number,
  since?: number,
): Promise<OrientationPackSection> {
  const start = since ?? Math.max(0, cursor - ORIENTATION_EVENT_SCAN_LIMIT);
  const query = { since: start, through: cursor, limit: ORIENTATION_EVENT_SCAN_LIMIT };
  const source = eventTailPath(problem, "json", query);
  const section: OrientationPackSection = {
    candidates: [],
    omitted: [],
    actions: [
      {
        method: "GET",
        url: source,
        why: "Read every public sequence in this selected event window, including omitted items; follow page_end.next before advancing your cursor.",
        public_read: true,
      },
    ],
  };
  try {
    const result = await readPublicEventTail(db, problem, query);
    if (result === null) throw new Error("event tail unavailable");
    const page = result.page;
    // Catch-up starts with the earliest changes. An initial orientation
    // shows the newest changes. Both are emitted in chronological order.
    const ordered = since === undefined ? [...page.events].reverse() : page.events;
    let conditional = new Map<number, boolean>();
    try {
      conditional = await conditionalMateriality(db, problem, cursor, ordered);
    } catch {
      // Missing conditional classifications are disclosed below. The verified
      // public envelopes still remain useful; no projection text is used.
    }
    const material: PublicEventEnvelope[] = [];
    let filtered = false;
    let unclassified = false;
    for (const envelope of ordered) {
      const event = envelope.event;
      if (event === null) {
        filtered = true;
        continue;
      }
      const included = [
        "dead_end.recorded",
        "problem.statement-revised",
        "problem.statement-reviewed",
      ].includes(event.type)
        ? conditional.get(envelope.seq)
        : isObjectLevelEvent({ type: event.type });
      if (included === undefined) unclassified = true;
      else if (included) material.push(envelope);
      else filtered = true;
    }
    const selected = material
      .slice(0, ORIENTATION_EVENT_LIMIT)
      .sort((left, right) => left.seq - right.seq);
    const notice =
      since === undefined
        ? `Recent material events: up to five newest classifiable events in the returned page, in chronological order, from public sequences after ${start} through ${cursor}.`
        : `Changes after cursor ${since}: up to five earliest material events, in chronological order, through captured cursor ${cursor}.`;
    section.candidates.push({
      kind: "standing-context",
      id: "SYS-orientation-events",
      scope: "system",
      untrusted: false,
      tokens: 1,
      stable_prefix: 420,
      body: `${notice} Standing problem context is unchanged by since. These are public event envelopes, not evidence bodies or a scientific verdict. This summary is not a completed event-tail page; use ${source} and its page_end before advancing a catch-up cursor.${selected.length === 0 ? " No classifiable material events were found in the scanned window." : ""}`,
      why_included: "explain the exact event window and safe recovery from a bounded summary",
    });
    selected.forEach((envelope, index) => {
      section.candidates.push({
        kind: "orientation-event",
        id: `DELTA-${envelope.seq}`,
        scope: "ledger",
        untrusted: true,
        tokens: 1,
        stable_prefix: 421 + index,
        body: JSON.stringify(envelope),
        why_included:
          "a material public ledger change in the selected cursor window; full content remains on its canonical object face",
      });
    });
    if (material.length > ORIENTATION_EVENT_LIMIT || page.page_end.has_more) {
      section.omitted.push({
        reason: "candidate_limit",
        detail: `orientation-events: read ${source} and follow page_end.next`,
      });
    }
    if (since === undefined && start > 0) {
      section.omitted.push({
        reason: "history_window",
        detail: `orientation-events before #${start + 1}; read ${eventTailPath(problem, "json", {
          since: 0,
          through: start,
          limit: ORIENTATION_EVENT_SCAN_LIMIT,
        })}`,
      });
    }
    if (unclassified) {
      section.omitted.push({
        reason: "materiality_unavailable",
        detail:
          "Some statement-work/dead-end events could not be classified from bounded available publication content; the complete public tail remains linked.",
      });
    }
    if (filtered) {
      section.omitted.push({
        reason: "profile_summary",
        detail:
          "orientation-events: process and undisclosed events are omitted from the material summary; public sequence numbers are unchanged.",
      });
    }
  } catch {
    section.candidates = [];
    section.omitted = [
      {
        reason: "orientation_events_unavailable",
        detail: `The canonical event window is unavailable; retry ${source}. No projection history is substituted.`,
      },
    ];
  }
  return section;
}

/** The caller has authenticated the session and checked problem membership.
 * Both reads use current visibility controls and the caller's captured public
 * cursor. Neither reads workshop, handback, session history or private inboxes. */
export async function readOrientationPack(
  db: D1Database,
  problem: string,
  cursor: number,
  since?: number,
): Promise<OrientationPackSection> {
  const [formulation, delta] = await Promise.all([
    readFormulation(db, problem, cursor),
    readEventDelta(db, problem, cursor, since),
  ]);
  return {
    candidates: [...formulation.candidates, ...delta.candidates],
    omitted: [...formulation.omitted, ...delta.omitted],
    actions: [...formulation.actions, ...delta.actions],
  };
}
