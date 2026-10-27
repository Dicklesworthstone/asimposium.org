import type { MoveTemplate, NextMoveCandidate } from "@asimposium/contracts";
import type { HypothesesResponse } from "@asimposium/contracts/hypotheses";
import type { D1Database } from "@cloudflare/workers-types";
import { hiddenByContentControlSql } from "../krater/public-content.ts";
import { isReadableActiveHypothesis } from "./hypothesis-moves.ts";

export const DISCRIMINATE_BOUNDARY =
  "discrimination-draft-v1: three verified active hypotheses at a captured cursor justify inspecting competing predictions, not a claim that they fit all evidence or lack a pending test. Draft privately; no experiment, evidence, verdict or reservation is manufactured. The bounded sample may omit other routes.";

/** Revalidate visibility after the canonical read. No private/unlisted problem,
 * hidden route or redacted publication can become a trusted move reference.
 * JSON binding keeps this one bounded query regardless of the three pins. */
export const DISCRIMINATE_VISIBLE_SQL = `SELECT p.id FROM problems p
  WHERE p.id = ? AND p.status <> 'private-draft' AND p.unlisted = 0
    AND NOT ${hiddenByContentControlSql("p.id", "'problem'")}
    AND NOT EXISTS (
      SELECT 1 FROM json_each(?) selected
      WHERE ${hiddenByContentControlSql("p.id", "json_extract(selected.value, '$.hypothesis_id')")}
        OR NOT EXISTS (
          SELECT 1 FROM events e JOIN event_content c ON c.event_id = e.id
            AND c.payload_sha256 = e.payload_sha256 AND c.redacted_at IS NULL
          WHERE e.problem_id = p.id AND e.object_kind = 'hypothesis'
            AND e.type = 'hypothesis.created' AND e.object_version = 1
            AND e.object_id = json_extract(selected.value, '$.hypothesis_id')
            AND e.id = json_extract(selected.value, '$.event_id')
            AND e.seq = json_extract(selected.value, '$.seq') AND e.seq <= p.public_seq
            AND e.payload_sha256 = json_extract(selected.value, '$.payload_sha256')
        )
    )`;

export interface DiscriminateMoveResult {
  readonly move: NextMoveCandidate | null;
  readonly degraded: boolean;
}

export interface DiscriminateMoveSource {
  /** The production adapter verifies public envelopes, lifecycle and body hashes. */
  load(
    db: D1Database,
    problemId: string,
    cursor: number,
  ): Promise<{ face: HypothesesResponse; unlisted: boolean } | null>;
  template(): MoveTemplate;
}

/** Only publication identifiers cross into trusted marching orders. Statements,
 * mechanisms, falsifiers and predictions stay behind the untrusted read faces.
 * In particular, counting live hypotheses does not establish scientific fitness. */
export function composeDiscriminateMove(
  problemId: string,
  cursor: number,
  result: Awaited<ReturnType<DiscriminateMoveSource["load"]>>,
  templateFor: DiscriminateMoveSource["template"],
): DiscriminateMoveResult {
  const unavailable = { move: null, degraded: true } as const;
  if (
    !Number.isSafeInteger(cursor) || cursor < 0 ||
    !result || result.unlisted || result.face.problem_id !== problemId ||
    result.face.cursor !== cursor || result.face.after !== 0
  ) return unavailable;

  const face = result.face;
  if (
    face.hypotheses.length > 3 ||
    face.omitted.some((reason) => reason !== "page_limit") ||
    (face.next_after !== null) !== face.omitted.includes("page_limit")
  ) return unavailable;

  const ids = new Set<string>();
  const events = new Set<string>();
  let previous = 0;
  for (const item of face.hypotheses) {
    const pin = item.publication;
    if (
      item.status !== "active" || item.content === null || item.kill !== null ||
      !/^H-[0-9A-HJKMNP-TV-Z]{1,78}(?![\s\S])/.test(item.hypothesis_id) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/.test(pin.event_id) ||
      !/^[0-9a-f]{64}(?![\s\S])/.test(pin.payload_sha256) ||
      !Number.isSafeInteger(pin.seq) || pin.seq <= previous || pin.seq > cursor ||
      !isReadableActiveHypothesis(item, cursor) ||
      ids.has(item.hypothesis_id) || events.has(pin.event_id)
    ) return unavailable;
    previous = pin.seq;
    ids.add(item.hypothesis_id);
    events.add(pin.event_id);
  }
  if (face.next_after !== null && face.next_after !== previous) return unavailable;
  if (face.hypotheses.length < 3) {
    return { move: null, degraded: face.next_after !== null };
  }
  const template = templateFor();
  if (
    template.move !== "discriminate" || template.availability !== "available" ||
    template.request.path !== "/v1/sessions/{id}/workshop" ||
    template.target_contract !== "/schemas/sessions.v1/workshop_push_request.json"
  ) return unavailable;

  const pins = face.hypotheses.map(({ hypothesis_id, publication }) => ({
    hypothesis_id,
    event_id: publication.event_id,
    seq: publication.seq,
    payload_sha256: publication.payload_sha256,
  }));
  // Admissions can be separated by hundreds of killed routes. Each link starts
  // immediately before its exact publication rather than assuming page one.
  const reads = pins.map((pin) => ({
    method: "GET" as const,
    path: `/p/${encodeURIComponent(problemId)}/hypotheses.md?through=${cursor}&after=${pin.seq - 1}`,
  }));
  return {
    degraded: face.next_after !== null,
    move: {
      move: "discriminate",
      why: "Three readable active hypotheses are recorded at this cursor. Strong inference: inspect their predictions and existing evidence, then draft a test with divergent possible outcomes if a separating test is still needed. Active status does not establish that a route fits the evidence.",
      refs: [problemId, ...pins.map((pin) => pin.hypothesis_id)],
      contract: {
        ...template,
        prefilled_hints: { type: "note" },
        preparation: {
          problem_id: problemId,
          captured_cursor: cursor,
          hypothesis_pins: pins,
          // This is a read, not a public-write grant. The primary action remains
          // private preparation even when publication quota is exhausted.
          publication_schema: {
            method: "GET",
            path: "/schemas/discrimination.v1/discrimination_request.json",
          },
          read_first: reads[0],
          additional_reads: reads.slice(1),
          selection_complete: face.next_after === null,
          ...(face.next_after === null ? {} : {
            continue_reading: {
              method: "GET",
              path: `/p/${encodeURIComponent(problemId)}/hypotheses.md?through=${cursor}&after=${face.next_after}`,
            },
          }),
          open_session: {
            method: "POST",
            path: "/v1/sessions",
            idempotency_key_required: true,
            body: { problem_id: problemId, intent: "explore" },
          },
          note: `Reuse an owned session or open one, then replace {id}. Supply your own title and body_md: identify the pinned routes, their contrasting predictions, the proposed check and its failure conditions. Read the existing evidence and pending work before duplicating a test. Measurements every route predicts do not discriminate. This write is private WIP, not public evidence. After performing the check, read publication_schema and submit the actual report separately to POST /v1/p/${encodeURIComponent(problemId)}/discrimination when your current public-write permissions and quota allow it. Report contrasting predictions, per-route failure conditions, actual observation and limitations; retrospective or selection evidence is exploratory. One shared experiment is not independent replication. Successful receipts link to its evidence records; retry an uncertain outcome with the same body and Idempotency-Key.`,
        },
      },
      selection_boundary: DISCRIMINATE_BOUNDARY,
    },
  };
}

export async function selectDiscriminateMove(
  db: D1Database,
  problemId: string,
  cursor: number,
  source?: DiscriminateMoveSource,
): Promise<DiscriminateMoveResult> {
  try {
    if (!Number.isSafeInteger(cursor) || cursor < 0) return { move: null, degraded: true };
    // Keep the selector independently testable; production always uses the same
    // canonical decoder as the public hypotheses face and third-alternative.
    let canonical = source;
    if (canonical === undefined) {
      const [hypotheses, contracts] = await Promise.all([
        import("../ledger/hypotheses-service"),
        import("@asimposium/contracts"),
      ]);
      canonical = {
        async load(db, problemId, cursor) {
          const result = await hypotheses.loadLiveHypotheses(db, problemId, cursor);
          if (result === null || result.unlisted) return null;
          const pins = result.face.hypotheses.map(({ hypothesis_id, publication }) => ({
            hypothesis_id,
            event_id: publication.event_id,
            seq: publication.seq,
            payload_sha256: publication.payload_sha256,
          }));
          const visible = await db.prepare(DISCRIMINATE_VISIBLE_SQL)
            .bind(problemId, JSON.stringify(pins)).first<{ id: string }>();
          return visible?.id === problemId ? result : null;
        },
        template: () => contracts.getMoveTemplate("discriminate"),
      };
    }
    return composeDiscriminateMove(problemId, cursor, await canonical.load(db, problemId, cursor), canonical.template);
  } catch {
    return { move: null, degraded: true };
  }
}
