import {
  type SessionSharedHandoffPin,
  SessionSharedHandoffPinSchema,
  type SessionSharedHandoffReceipt,
  type SessionSharedHandoffRequest,
  SynthesisItemSchema,
} from "@asimposium/contracts";
import {
  neutralizeUntrustedBody,
  type PackActionCandidate,
  type PackCandidate,
} from "@asimposium/render";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { eventContentHiddenSql, hiddenByContentControlSql } from "../krater/public-content.ts";
import { readSynthesisPage } from "../ledger/synthesis-read.ts";

const MAX_HANDOFF_ITEM_CHARACTERS = 18_000;

/** Closing a session selects existing public work; it does not publish the
 * private handback or append another scientific summary. Selection can change
 * without advancing the ledger. Only the source publication is cursor-bound. */
export const SHARED_HANDOFF_COORDINATION_BOUNDARY =
  "Latest explicit handoff selected by a closed session when this pack was read; this coordination selection is not frozen at the ledger cursor. The linked synthesis is an exact public publication at or before that cursor, with its own coverage and omissions. It is author-written context, not computed scientific standing.";

export class SessionSharedHandoffError extends Error {
  readonly code = "SOURCE_UNAVAILABLE";

  constructor() {
    super("SESSION_SHARED_HANDOFF_SOURCE_UNAVAILABLE");
    this.name = "SessionSharedHandoffError";
  }
}

export interface PreparedSharedHandoff {
  readonly pin: SessionSharedHandoffPin;
  readonly receipt: SessionSharedHandoffReceipt;
  /** These guards must settle in the same transaction as the close, its
   * workshop changes, replay receipt and persisted pin. No separate preflight
   * transaction can establish the required source-at-commit guarantee. */
  readonly statements: readonly D1PreparedStatement[];
}

function synthesisPath(problemId: string, synthesisId: string, format = "md"): string {
  return `/p/${encodeURIComponent(problemId)}/syntheses/${encodeURIComponent(synthesisId)}.${format}`;
}

const decodeSynthesis: Parameters<typeof readSynthesisPage>[3] = (value) => {
  const parsed = SynthesisItemSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/** The source is already an explicitly published, attributed synthesis. A
 * closing Fellow may designate only their own same-problem publication. Never
 * derive public content from sessions.handback or any workshop body. */
export async function prepareSharedHandoff(
  db: D1Database,
  input: {
    readonly problemId: string;
    readonly fellowId: string;
    readonly handoff: SessionSharedHandoffRequest;
  },
): Promise<PreparedSharedHandoff> {
  const page = await readSynthesisPage(
    db,
    input.problemId,
    { synthesisId: input.handoff.synthesis_id },
    decodeSynthesis,
  );
  const item = page.items[0];
  if (
    !page.found ||
    page.items.length !== 1 ||
    page.omitted.length !== 0 ||
    item === undefined ||
    item.synthesis.problem_id !== input.problemId ||
    item.synthesis.synthesis_id !== input.handoff.synthesis_id ||
    item.synthesis.authoring_principal !== input.fellowId ||
    item.source.eventId !== input.handoff.event_id ||
    item.source.problemId !== input.problemId ||
    item.source.seq !== item.synthesis.seq
  )
    throw new SessionSharedHandoffError();

  const pin = SessionSharedHandoffPinSchema.parse({
    synthesis_id: item.synthesis.synthesis_id,
    event_id: item.source.eventId,
    seq: item.source.seq,
    payload_sha256: item.source.payloadDigest,
  });
  return {
    pin,
    receipt: { ...pin, read_url: synthesisPath(input.problemId, pin.synthesis_id, "json") },
    statements: [
      db
        .prepare(`SELECT CASE WHEN EXISTS (
          SELECT 1 FROM events e
          JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
            AND c.redacted_at IS NULL
          JOIN problems p ON p.id = e.problem_id AND p.status <> 'private-draft'
          WHERE e.problem_id = ? AND e.id = ? AND e.seq = ?
            AND e.object_kind = 'synthesis' AND e.type = 'synthesis.created'
            AND e.object_id = ? AND e.object_version = 1 AND e.actor_fellow_id = ?
            AND e.payload_sha256 = ? AND c.payload_json = ? AND e.seq <= p.public_seq
            AND NOT ${eventContentHiddenSql("e")}
            AND NOT ${hiddenByContentControlSql("p.id", "p.id")}
            AND (SELECT COUNT(*) FROM events duplicate
              WHERE duplicate.problem_id = e.problem_id AND duplicate.object_id = e.object_id
                AND duplicate.object_kind = 'synthesis' AND duplicate.type = 'synthesis.created'
                AND duplicate.seq <= p.public_seq) = 1
        ) THEN 1 ELSE json_extract('[]', '$[SESSION_SHARED_HANDOFF_CHANGED') END`)
        .bind(
          input.problemId,
          pin.event_id,
          pin.seq,
          pin.synthesis_id,
          input.fellowId,
          pin.payload_sha256,
          item.source.payloadJson,
        ),
    ],
  };
}

export function isSessionSharedHandoffChanged(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("SESSION_SHARED_HANDOFF_CHANGED") ||
      (error.cause !== undefined && isSessionSharedHandoffChanged(error.cause)))
  );
}

export interface SharedHandoffPackSection {
  readonly candidates: PackCandidate[];
  readonly actions: PackActionCandidate[];
  readonly omitted: { reason: string; detail: string }[];
}

/** Select the designation before checking its source. A hidden, redacted or
 * corrupt latest handoff must not revive an older narrative. No private text
 * or another Fellow's session identifier is selected by this query. */
export const LATEST_SHARED_HANDOFF_SQL = `SELECT fellow_id, shared_handoff_json FROM sessions
  WHERE problem_id = ? AND closed_at IS NOT NULL AND shared_handoff_json IS NOT NULL
  ORDER BY closed_at DESC, session_id DESC LIMIT 1`;

function unavailable(): SharedHandoffPackSection {
  return {
    candidates: [],
    actions: [],
    omitted: [
      {
        reason: "shared_handoff_unavailable",
        detail:
          "The latest selected shared handoff could not be verified at this pack cursor under current content controls. No older handoff was substituted. Refresh this pack before relying on shared session context.",
      },
    ],
  };
}

/** Arrival-only caller: orient/working on an authorized published problem.
 * Review and public full-export profiles must not call this coordination read.
 * Existing own-handback candidates use prefix 10; this follows them at 11. */
export async function readSharedHandoffPack(
  db: D1Database,
  problemId: string,
  cursor: number,
): Promise<SharedHandoffPackSection> {
  try {
    if (!Number.isSafeInteger(cursor) || cursor < 0) return unavailable();
    const selected = await db.prepare(LATEST_SHARED_HANDOFF_SQL).bind(problemId).first<{
      fellow_id: string;
      shared_handoff_json: string;
    }>();
    if (selected === null) return { candidates: [], actions: [], omitted: [] };
    if (
      typeof selected.fellow_id !== "string" ||
      selected.fellow_id.length === 0 ||
      selected.fellow_id.length > 128 ||
      typeof selected.shared_handoff_json !== "string" ||
      selected.shared_handoff_json.length > 1024
    )
      return unavailable();
    const parsed = SessionSharedHandoffPinSchema.safeParse(
      JSON.parse(selected.shared_handoff_json),
    );
    if (!parsed.success || parsed.data.seq > cursor) return unavailable();
    const pin = parsed.data;
    const page = await readSynthesisPage(
      db,
      problemId,
      { through: cursor, synthesisId: pin.synthesis_id },
      decodeSynthesis,
    );
    const item = page.items[0];
    if (
      !page.found ||
      page.cursor !== cursor ||
      page.items.length !== 1 ||
      page.omitted.length !== 0 ||
      item === undefined ||
      item.synthesis.problem_id !== problemId ||
      item.synthesis.synthesis_id !== pin.synthesis_id ||
      item.synthesis.authoring_principal !== selected.fellow_id ||
      item.synthesis.seq !== pin.seq ||
      item.source.eventId !== pin.event_id ||
      item.source.payloadDigest !== pin.payload_sha256 ||
      item.source.seq !== pin.seq ||
      item.source.problemId !== problemId
    )
      return unavailable();

    const readUrl = synthesisPath(problemId, pin.synthesis_id);
    const { screening_notice: notice, ...synthesis } = item.synthesis;
    const context = {
      coordination: SHARED_HANDOFF_COORDINATION_BOUNDARY,
      publication_event_id: pin.event_id,
      publication_sha256: pin.payload_sha256,
      read_url: readUrl,
    };
    const completeBody = JSON.stringify({ ...context, synthesis });
    const referenceOnly =
      completeBody.length > MAX_HANDOFF_ITEM_CHARACTERS ||
      neutralizeUntrustedBody(completeBody).text.length > MAX_HANDOFF_ITEM_CHARACTERS;
    return {
      candidates: [
        {
          kind: "shared-handoff",
          id: pin.synthesis_id,
          scope: "ledger",
          tokens: 1,
          untrusted: true,
          body: referenceOnly
            ? JSON.stringify({
                ...context,
                synthesis_id: pin.synthesis_id,
                publication_seq: pin.seq,
                covers_through: synthesis.covers_through,
                authoring_principal: synthesis.authoring_principal,
                content_omitted: "item_size_limit",
              })
            : completeBody,
          ...(notice === undefined ? {} : { screening_notice: notice }),
          why_included:
            "Explicitly shared public work for the next arrival; read after your own previous handback. Private notes remain separate, and scientific standing is computed from the ledger.",
          stable_prefix: 11,
        },
      ],
      actions: [
        {
          method: "GET",
          url: readUrl,
          why: "Read the exact synthesis selected for this shared handoff, including its anchors, coverage and disclosed omissions. Current content controls still apply.",
          public_read: true,
        },
      ],
      omitted: referenceOnly
        ? [
            {
              reason: "item_too_large",
              detail: `shared-handoff: the complete synthesis exceeds the pack item limit; read ${readUrl}`,
            },
          ]
        : [],
    };
  } catch {
    return unavailable();
  }
}
