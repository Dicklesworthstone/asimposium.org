/**
 * W2.2 batch-write planning (Fable §7: `POST /v1/p/:id/events:batch`). A batch
 * is a bounded set of causally related writes committed atomically in one
 * transaction — each validated member is one logical write and therefore one
 * event, with NO batch-wrapper event and no several-objects-in-one-event
 * shortcut. Client-local temporary IDs are resolved server-side.
 *
 * This module is the pure planner: given the batch members, it validates the
 * bound, the causal references, and the acyclicity, and resolves the canonical
 * commit order. The route supplies the D1 transaction; this owns only the
 * plan, so the ordering is reproducible offline and the refusal teaches.
 */

/** The batch is bounded so one request cannot hold the write transaction open. */
export const MAX_BATCH_MEMBERS = 16;

/** A client-local temporary id (`tmp:…`) a later member's caused_by may name. */
export interface BatchMember {
  /** The member's client-local temporary id. */
  readonly tempId: string;
  /** Temp ids this member causally follows (its caused_by parents). */
  readonly causedBy: readonly string[];
}

export type BatchPlanRefusalCode =
  | "BATCH_EMPTY"
  | "BATCH_TOO_LARGE"
  | "BATCH_DUPLICATE_TEMP_ID"
  | "BATCH_DANGLING_CAUSAL_REF"
  | "BATCH_CAUSAL_CYCLE";

export type BatchPlan =
  | { readonly ok: true; readonly commitOrder: readonly string[] }
  | { readonly ok: false; readonly code: BatchPlanRefusalCode; readonly detail: string };

/**
 * Plan a batch commit. Returns the members' temp ids in causal (topological)
 * commit order — parents before dependents — or a teaching refusal. Pure.
 */
export function planBatchCommit(members: readonly BatchMember[]): BatchPlan {
  if (members.length === 0) {
    return { ok: false, code: "BATCH_EMPTY", detail: "a batch must carry at least one member" };
  }
  if (members.length > MAX_BATCH_MEMBERS) {
    return {
      ok: false,
      code: "BATCH_TOO_LARGE",
      detail: `${members.length} members exceeds the ${MAX_BATCH_MEMBERS}-member bound`,
    };
  }

  const byTempId = new Map<string, BatchMember>();
  for (const member of members) {
    if (byTempId.has(member.tempId)) {
      return {
        ok: false,
        code: "BATCH_DUPLICATE_TEMP_ID",
        detail: `temporary id ${member.tempId} appears twice`,
      };
    }
    byTempId.set(member.tempId, member);
  }

  // Every caused_by reference must name a member of this batch — a batch is
  // self-contained; a dangling reference would order against a phantom.
  for (const member of members) {
    for (const parent of member.causedBy) {
      if (!byTempId.has(parent)) {
        return {
          ok: false,
          code: "BATCH_DANGLING_CAUSAL_REF",
          detail: `${member.tempId} follows ${parent}, which is not a member of this batch`,
        };
      }
    }
  }

  // Topological order (Kahn): parents before dependents, cycle-safe.
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const member of members) {
    inDegree.set(member.tempId, member.causedBy.length);
    for (const parent of member.causedBy) {
      const list = dependents.get(parent) ?? [];
      list.push(member.tempId);
      dependents.set(parent, list);
    }
  }

  // Deterministic: process ready members in declaration order so the plan is
  // reproducible regardless of map iteration order.
  const declarationOrder = members.map((m) => m.tempId);
  const ready = declarationOrder.filter((id) => inDegree.get(id) === 0);
  const commitOrder: string[] = [];
  const inFlight = [...ready];

  while (inFlight.length > 0) {
    const current = inFlight.shift() as string;
    commitOrder.push(current);
    for (const dependent of dependents.get(current) ?? []) {
      const remaining = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, remaining);
      if (remaining === 0) inFlight.push(dependent);
    }
  }

  if (commitOrder.length !== members.length) {
    return {
      ok: false,
      code: "BATCH_CAUSAL_CYCLE",
      detail: "the caused_by references form a cycle — dependencies must be a DAG (P10)",
    };
  }

  return { ok: true, commitOrder };
}
