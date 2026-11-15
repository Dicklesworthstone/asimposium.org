import type { ProblemWorkspaceCommand, ProblemWorkspaceReceipt } from "../../lib/problem-lifecycle";
import { accessWorkspace } from "./problem-governance";

export const workspaceSponsor = "usr_1234567890abcdef";
export const workspaceProblem = "P-LINEAGE";
export const workspace = {
  ...accessWorkspace,
  acting_sponsor_id: workspaceSponsor,
  problem: { ...accessWorkspace.problem, id: workspaceProblem, status: "active" as const },
};
export const workspaceFormulation = {
  id: workspaceProblem,
  title: "Finite paths",
  status: "active" as const,
  current_statement_version: 2,
  statement: "Every simple path with n edges has n + 1 vertices.",
  falsifier: "A simple path with a different vertex count.",
  motivation: "Specify the path counting convention for review.",
  updated_at: "2026-11-14T20:00:00.000Z",
};
export const retirementCommand = {
  action: "retire",
  reason: "The team is no longer pursuing this formulation.",
} as const;
export const mergeCommand = {
  action: "merge",
  canonical_problem_id: "P-CANONICAL",
  claim_mapping: { "C-1": "C-2@1" },
} as const;
export const forkCommand = { action: "fork", title: "Independent finite paths" } as const;
export const workspaceCases = [
  {
    command: retirementCommand,
    receipt: {
      action: "retire",
      result: {
        problem: {
          ...workspaceFormulation,
          status: "retired",
          resolution_summary: retirementCommand.reason,
        },
      },
    },
  },
  {
    command: mergeCommand,
    receipt: {
      action: "merge",
      result: {
        problem: {
          ...workspaceFormulation,
          status: "retired",
          canonical_problem_id: mergeCommand.canonical_problem_id,
          resolution_summary: `Merged into ${mergeCommand.canonical_problem_id}`,
        },
      },
    },
  },
  {
    command: forkCommand,
    receipt: {
      action: "fork",
      result: {
        problem: workspaceFormulation,
        forked_problem_id: "P-PRIVATEFORK",
      },
    },
  },
] as const satisfies readonly {
  command: ProblemWorkspaceCommand;
  receipt: ProblemWorkspaceReceipt;
}[];
