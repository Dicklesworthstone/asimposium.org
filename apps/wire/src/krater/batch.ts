/**
 * W2.2 batch-write planning (Fable §7: `POST /v1/p/:id/events:batch`). A batch
 * is a bounded set of causally related writes committed atomically in one
 * transaction — each validated member is one logical write and therefore one
 * event, with NO batch-wrapper event and no several-objects-in-one-event
 * shortcut. Client-local temporary IDs (`tmp:…`) are resolved server-side.
 *
 * This module is the pure planner: given the batch members, it validates the
 * bound, the causal references, and the acyclicity, and resolves the canonical
 * commit order. The route supplies the D1 transaction; this owns only the
 * plan, so the ordering is reproducible offline and the refusal teaches.
 */

import {
  BATCH_PLAN_REFUSAL_CODES,
  BATCH_TEMP_ID_PATTERN,
  type BatchMember,
  type BatchPlan,
  type BatchPlanFailure,
  type BatchPlanRefusalCode,
  type BatchPlanSuccess,
  type BatchTempId,
  MAX_BATCH_MEMBERS,
  MAX_CAUSED_BY_PER_MEMBER,
} from "@asimposium/contracts";

export {
  BATCH_PLAN_REFUSAL_CODES,
  BATCH_TEMP_ID_PATTERN,
  MAX_BATCH_MEMBERS,
  MAX_CAUSED_BY_PER_MEMBER,
  type BatchMember,
  type BatchPlan,
  type BatchPlanFailure,
  type BatchPlanRefusalCode,
  type BatchPlanSuccess,
  type BatchTempId,
};

/**
 * Plan a batch commit. Returns the members' temp ids in causal (topological)
 * commit order — parents before dependents — or a teaching refusal. Pure.
 */
export function planBatchCommit(members: readonly BatchMember[]): BatchPlan {
  if (!Array.isArray(members) || members.length === 0) {
    return { ok: false, code: "BATCH_EMPTY", detail: "a batch must carry at least one member" };
  }
  if (members.length > MAX_BATCH_MEMBERS) {
    return {
      ok: false,
      code: "BATCH_TOO_LARGE",
      detail: `${members.length} members exceeds the ${MAX_BATCH_MEMBERS}-member bound`,
    };
  }

  for (let i = 0; i < members.length; i++) {
    const member = members[i];
    if (
      typeof member?.tempId !== "string" ||
      member.tempId.length < 5 ||
      member.tempId.length > 128 ||
      !BATCH_TEMP_ID_PATTERN.test(member.tempId)
    ) {
      return {
        ok: false,
        code: "BATCH_INVALID_TEMP_ID",
        detail: `member at index ${i} has invalid temporary id (must match tmp:<identifier>, 5-128 chars)`,
      };
    }
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

  for (const member of members) {
    const causedBy = member.causedBy ?? [];
    if (!Array.isArray(causedBy)) {
      return {
        ok: false,
        code: "BATCH_DANGLING_CAUSAL_REF",
        detail: `member ${member.tempId} caused_by must be an array`,
      };
    }
    if (causedBy.length > MAX_CAUSED_BY_PER_MEMBER) {
      return {
        ok: false,
        code: "BATCH_TOO_LARGE",
        detail: `member ${member.tempId} caused_by length ${causedBy.length} exceeds ${MAX_CAUSED_BY_PER_MEMBER} bound`,
      };
    }

    const seenParents = new Set<string>();
    for (const parent of causedBy) {
      if (
        typeof parent !== "string" ||
        parent.length < 5 ||
        parent.length > 128 ||
        !BATCH_TEMP_ID_PATTERN.test(parent)
      ) {
        return {
          ok: false,
          code: "BATCH_INVALID_TEMP_ID",
          detail: `member ${member.tempId} references invalid caused_by temporary id format`,
        };
      }
      if (parent === member.tempId) {
        return {
          ok: false,
          code: "BATCH_SELF_CAUSAL_REF",
          detail: `member ${member.tempId} cannot list itself in caused_by`,
        };
      }
      if (seenParents.has(parent)) {
        return {
          ok: false,
          code: "BATCH_DUPLICATE_CAUSAL_REF",
          detail: `member ${member.tempId} carries duplicate caused_by reference ${parent}`,
        };
      }
      seenParents.add(parent);

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
    const parents = member.causedBy ?? [];
    inDegree.set(member.tempId, parents.length);
    for (const parent of parents) {
      const list = dependents.get(parent) ?? [];
      list.push(member.tempId);
      dependents.set(parent, list);
    }
  }

  // Deterministic: process ready members in declaration order so the plan is
  // reproducible regardless of map iteration order.
  const declarationOrder = members.map((m) => m.tempId);
  const ready = declarationOrder.filter((id) => (inDegree.get(id) ?? 0) === 0);
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
