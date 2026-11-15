import "server-only";

import {
  ProblemForkResponseSchema,
  ProblemMergeResponseSchema,
  ProblemRetirementResponseSchema,
} from "@asimposium/contracts";
import {
  type ProblemWorkspaceCommand,
  type ProblemWorkspaceReceipt,
  parseProblemWorkspaceCommand,
  validWorkspaceKey,
} from "./problem-lifecycle";
import { callStoa, type StoaCall } from "./stoa";

/** No mutable preread: the Worker's stored receipt must remain recoverable
 * after retirement, merge, a later revision or a lost first reply. */
export function stoaChangeProblemWorkspace(
  sponsorId: string,
  problemId: string,
  input: ProblemWorkspaceCommand,
  key: string,
): Promise<StoaCall<ProblemWorkspaceReceipt>> {
  const command = parseProblemWorkspaceCommand(problemId, input);
  if (!command || !validWorkspaceKey(key))
    return Promise.resolve({ ok: false, reason: "refused", status: 400 });
  const path = `/v1/sponsors/problems/${encodeURIComponent(problemId)}/lifecycle`;
  return callStoa({
    method: "POST",
    route: path,
    path,
    action: "problem-lifecycle",
    principalId: sponsorId,
    body: JSON.stringify(command),
    idempotencyKey: key,
    responseMaxBytes: 262_144,
    parse: (value): ProblemWorkspaceReceipt => {
      if (command.action === "retire") {
        const result = ProblemRetirementResponseSchema.parse(value);
        if (result.problem.id !== problemId || result.problem.resolution_summary !== command.reason)
          throw new Error("Retirement receipt does not match this command");
        return { action: "retire", result };
      }
      if (command.action === "merge") {
        const result = ProblemMergeResponseSchema.parse(value);
        if (
          result.problem.id !== problemId ||
          result.problem.canonical_problem_id !== command.canonical_problem_id ||
          result.problem.resolution_summary !== `Merged into ${command.canonical_problem_id}`
        )
          throw new Error("Merge receipt does not match this command");
        return { action: "merge", result };
      }
      const result = ProblemForkResponseSchema.parse(value);
      if (result.problem.id !== problemId || result.forked_problem_id === problemId)
        throw new Error("Fork receipt does not match this parent");
      return { action: "fork", result };
    },
  });
}
