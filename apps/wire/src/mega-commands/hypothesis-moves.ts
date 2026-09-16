import type { MoveTemplate, NextMoveCandidate } from "@asimposium/contracts";
import type { HypothesesResponse } from "@asimposium/contracts/hypotheses";
import type { D1Database } from "@cloudflare/workers-types";
import { hypothesisPath } from "../ledger/hypotheses-face";

export interface HypothesisMoveSource {
  load(db: D1Database, problemId: string, cursor: number): Promise<{
    face: HypothesesResponse;
    unlisted: boolean;
  } | null>;
  template(): MoveTemplate;
}

export const LIVE_MOVES_BOUNDARY =
  "ledger-needs-v2: review, add-refuter, third-alternative and first-claim moves only. Review needs rank by consequence, missing check and age within bounded admissions; an exact two-route trigger precedes starting a new claim. Not a global optimum. No assignment or reservation. Submission rechecks authorization, versions and scientific evidence.";

/** Consume only the canonical live-only reader, including its withheld rows.
 * Never infer a two-route frontier by filtering a larger/uncertain page. */
export function selectThirdAlternative(
  problemId: string,
  cursor: number,
  result: Awaited<ReturnType<HypothesisMoveSource["load"]>>,
  templateFor: HypothesisMoveSource["template"],
): { move: NextMoveCandidate | null; degraded: boolean } {
  if (result === null || result.unlisted || result.face.problem_id !== problemId ||
      result.face.cursor !== cursor || result.face.after !== 0) {
    return { move: null, degraded: true };
  }
  const face = result.face;
  if (face.omitted.some(reason => reason !== "page_limit") ||
      face.hypotheses.some(item => item.status !== "active" || item.content === null)) {
    return { move: null, degraded: true };
  }
  if (face.next_after !== null || face.hypotheses.length !== 2) return { move: null, degraded: false };
  const [first, second] = face.hypotheses;
  if (!first || !second || first.hypothesis_id === second.hypothesis_id ||
      [first, second].some(item => item.publication.seq < 1 || item.publication.seq > cursor ||
        item.publication.event_id !== item.last_event.event_id)) return { move: null, degraded: true };
  const template = templateFor();
  if (template.availability !== "available" || template.move !== "third-alternative") {
    return { move: null, degraded: true };
  }
  const read = (item: typeof first) => ({ method: "GET" as const,
    path: hypothesisPath(problemId, "md", cursor, item.publication.seq - 1) });
  return {
    degraded: false,
    move: {
      move: "third-alternative",
      why: "Exactly two readable active attack routes remain at this captured cursor. Read both and propose a structurally distinct alternative with its own falsifier; two surviving routes do not establish an exhaustive choice or scientific support.",
      refs: [problemId, first.hypothesis_id, second.hypothesis_id],
      contract: {
        ...template,
        prefilled_hints: { ...template.prefilled_hints, origin: "third-alternative" },
        preparation: {
          problem_id: problemId, captured_cursor: cursor,
          // Each original admission may be separated by many killed routes.
          // Start each page immediately before its admission, not at page one.
          read_first: read(first), additional_reads: [read(second)],
          hypothesis_pins: [first, second].map(item => ({ hypothesis_id: item.hypothesis_id,
            event_id: item.publication.event_id, seq: item.publication.seq,
            payload_sha256: item.publication.payload_sha256 })),
          open_session: { method: "POST", path: "/v1/sessions", idempotency_key_required: true,
            body: { problem_id: problemId, intent: "explore" } },
          note: "Reuse an owned session or open one, then replace {id} in the request path. Supply your own route, mechanism, falsifier, discriminating predictions and work product. Re-read current state before submitting; this recommendation reserves nothing.",
        },
      },
      selection_boundary: LIVE_MOVES_BOUNDARY,
    },
  };
}
