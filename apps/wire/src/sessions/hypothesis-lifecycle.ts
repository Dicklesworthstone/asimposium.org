import type { HypothesisLifecycleRequest } from "@asimposium/contracts";
import { PublicHypothesisIdSchema, type PublicHypothesis } from "@asimposium/contracts/hypotheses";
import type { D1Database } from "@cloudflare/workers-types";
import { eventContentHiddenSql } from "../krater/public-content.ts";
import { loadPublicHypothesisItem } from "../ledger/hypotheses-service.ts";

export class HypothesisLifecycleError extends Error {
  constructor(readonly code: "HYPOTHESIS_NOT_FOUND" | "HYPOTHESIS_BODY_INVALID" |
    "OBJECT_VERSION_CONFLICT" | "WRITE_REFUSED") { super(code); }
}

export const HYPOTHESIS_LIFECYCLE_STATES = {
  defer: "deferred", resume: "active", narrow: "narrowed", supersede: "superseded",
} as const;
export const HYPOTHESIS_LIFECYCLE_EVENTS = {
  defer: "hypothesis.deferred", resume: "hypothesis.resumed",
  narrow: "hypothesis.narrowed", supersede: "hypothesis.superseded",
} as const;

/** Pin the canonical source and current head across a screening wait. The
 * immutable event history was validated by loadPublicHypothesisItem; the
 * transaction must still see exactly that history and visible source bytes. */
export function hypothesisHeadGuard(problemId: string, hypothesis: PublicHypothesis, prefix = "route") {
  const state = hypothesis.status;
  if (!["active", "deferred", "killed"].includes(state))
    throw new HypothesisLifecycleError("OBJECT_VERSION_CONFLICT");
  const types = state === "active" ? "'hypothesis.created', 'hypothesis.resumed'"
    : state === "deferred" ? "'hypothesis.deferred'" : "'hypothesis.killed'";
  return {
    preconditionSql: ` AND EXISTS (
      SELECT 1 FROM events ${prefix}_source
      JOIN event_content ${prefix}_content ON ${prefix}_content.event_id = ${prefix}_source.id
        AND ${prefix}_content.payload_sha256 = ${prefix}_source.payload_sha256
        AND ${prefix}_content.redacted_at IS NULL
      JOIN events ${prefix}_head ON ${prefix}_head.id = ?
        AND ${prefix}_head.problem_id = ${prefix}_source.problem_id
        AND ${prefix}_head.object_kind = 'hypothesis'
        AND ${prefix}_head.object_id = ${prefix}_source.object_id
        AND ${prefix}_head.object_version = 1 AND ${prefix}_head.type IN (${types})
      JOIN event_content ${prefix}_last ON ${prefix}_last.event_id = ${prefix}_head.id
        AND ${prefix}_last.payload_sha256 = ${prefix}_head.payload_sha256
        AND ${prefix}_last.redacted_at IS NULL
      JOIN hypotheses ${prefix}_projection ON ${prefix}_projection.problem_id = ${prefix}_source.problem_id
        AND ${prefix}_projection.hypothesis_id = ${prefix}_source.object_id
        AND ${prefix}_projection.source_event_id = ${prefix}_source.id
        AND ${prefix}_projection.lifecycle_status = '${state}'
        AND ${prefix}_projection.lifecycle_event_id = ${prefix}_head.id
      WHERE ${prefix}_source.id = ? AND ${prefix}_source.problem_id = ?
        AND ${prefix}_source.type = 'hypothesis.created' AND ${prefix}_source.object_kind = 'hypothesis'
        AND ${prefix}_source.object_version = 1
        AND ${prefix}_source.payload_sha256 = ? AND ${prefix}_head.payload_sha256 = ?
        AND NOT ${eventContentHiddenSql(`${prefix}_source`)}
        AND NOT ${eventContentHiddenSql(`${prefix}_head`)}
        AND NOT EXISTS (SELECT 1 FROM events ${prefix}_later
          WHERE ${prefix}_later.problem_id = ${prefix}_source.problem_id
            AND ${prefix}_later.object_kind = 'hypothesis'
            AND ${prefix}_later.object_id = ${prefix}_source.object_id
            AND ${prefix}_later.seq > ${prefix}_head.seq)
    )`,
    preconditionBindings: [hypothesis.last_event.event_id, hypothesis.publication.event_id, problemId,
      hypothesis.publication.payload_sha256, hypothesis.last_event.payload_sha256],
  };
}

export async function readableHypothesisTarget(db: D1Database, problemId: string, hypothesisId: string) {
  if (!PublicHypothesisIdSchema.safeParse(hypothesisId).success)
    throw new HypothesisLifecycleError("HYPOTHESIS_NOT_FOUND");
  const record = await loadPublicHypothesisItem(db, problemId, hypothesisId);
  const hypothesis = record?.face.hypotheses[0];
  if (!hypothesis?.content || hypothesis.status === "unavailable")
    throw new HypothesisLifecycleError("HYPOTHESIS_NOT_FOUND");
  return hypothesis;
}

/** Check readable immutable sources before screening, then return a pin which
 * the same D1 transaction must still satisfy. Public source content is never
 * copied from the mutable hypotheses projection. */
export async function prepareHypothesisLifecycle(db: D1Database, input: {
  problemId: string; hypothesisId: string; fellowId: string;
  request: HypothesisLifecycleRequest;
}) {
  const hypothesis = await readableHypothesisTarget(db, input.problemId, input.hypothesisId);
  if (hypothesis.publication.fellow_id !== input.fellowId)
    throw new HypothesisLifecycleError("WRITE_REFUSED");
  if (hypothesis.last_event.event_id !== input.request.expected_last_event_id)
    throw new HypothesisLifecycleError("OBJECT_VERSION_CONFLICT");
  const current = hypothesis.status;
  const permitted = input.request.action === "resume" ? current === "deferred"
    : input.request.action === "defer" ? current === "active"
    : current === "active" || current === "deferred";
  if (!permitted) throw new HypothesisLifecycleError("OBJECT_VERSION_CONFLICT");

  const successorId = "successor_hypothesis_id" in input.request
    ? input.request.successor_hypothesis_id : null;
  let successor: typeof hypothesis | undefined;
  if (successorId !== null) {
    if (successorId === input.hypothesisId)
      throw new HypothesisLifecycleError("HYPOTHESIS_BODY_INVALID");
    const next = await loadPublicHypothesisItem(db, input.problemId, successorId);
    successor = next?.face.hypotheses[0];
    // Forward creation order makes replacement ancestry acyclic without an
    // unbounded graph traversal. No semantic equivalence is asserted by us.
    if (!successor?.content || successor.status !== "active" ||
      successor.publication.seq <= hypothesis.publication.seq)
      throw new HypothesisLifecycleError("HYPOTHESIS_BODY_INVALID");
  }

  const source = hypothesisHeadGuard(input.problemId, hypothesis, "lifecycle");
  const next = successor ? hypothesisHeadGuard(input.problemId, successor, "successor") : undefined;
  return {
    status: HYPOTHESIS_LIFECYCLE_STATES[input.request.action],
    eventType: HYPOTHESIS_LIFECYCLE_EVENTS[input.request.action],
    successorId,
    preconditionSql: source.preconditionSql + (next?.preconditionSql ?? ""),
    preconditionBindings: [...source.preconditionBindings, ...(next?.preconditionBindings ?? [])],
  };
}
