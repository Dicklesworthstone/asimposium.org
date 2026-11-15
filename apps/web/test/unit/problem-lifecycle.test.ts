import { expect, test } from "bun:test";
import {
  clearWorkspaceCommand,
  createPendingWorkspaceCommand,
  parsePendingWorkspaceCommand,
  parseProblemWorkspaceCommand,
  persistWorkspaceCommand,
  WORKSPACE_RETRY_MS,
  workspaceAttemptExpired,
  workspaceClaimMapping,
  workspaceRecoveryKey,
} from "../../lib/problem-lifecycle";
import {
  forkCommand,
  mergeCommand,
  workspaceCases,
  workspaceProblem,
  workspaceSponsor,
} from "../fixtures/problem-lifecycle";

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

test("workspace commands preserve ordinary governance and refuse sponsor-authored scientific forks", () => {
  for (const { command } of workspaceCases)
    expect(parseProblemWorkspaceCommand(workspaceProblem, command)).toEqual(command);
  for (const input of [
    { ...forkCommand, statement: "An unadopted human claim." },
    { ...forkCommand, motivation: "A new human-authored theory." },
    { ...forkCommand, title: "   " },
    { action: "retire", reason: "\n " },
    { ...mergeCommand, canonical_problem_id: workspaceProblem },
    { ...mergeCommand, canonical_problem_id: "P-CANONICAL\n" },
    { ...mergeCommand, claim_mapping: { "../private": "C-1" } },
    { ...mergeCommand, claim_mapping: { "C-1": "https://attacker.invalid" } },
    { action: "resolve", direction: "affirmed" },
    { ...forkCommand, sponsor_id: workspaceSponsor },
  ])
    expect(parseProblemWorkspaceCommand(workspaceProblem, input)).toBeUndefined();
  expect(parseProblemWorkspaceCommand("../private", forkCommand)).toBeUndefined();
  expect(parseProblemWorkspaceCommand("P-LINEAGE\n", forkCommand)).toBeUndefined();
});

test("claim correspondence is bounded, version-aware and cannot silently overwrite a source", () => {
  expect(
    workspaceClaimMapping([
      { source: "C-1", target: "C-2@1" },
      { source: "", target: "" },
    ]),
  ).toEqual({ "C-1": "C-2@1" });
  for (const rows of [
    [{ source: "C-1", target: "" }],
    [
      { source: "C-1", target: "C-2" },
      { source: "C-1", target: "C-3" },
    ],
    [{ source: "C-1", target: "C-2@9007199254740992" }],
    Array.from({ length: 33 }, (_, i) => ({ source: `C-${i + 1}`, target: "C-1" })),
  ])
    expect(workspaceClaimMapping(rows)).toBeUndefined();
});

test("exact pending commands survive reload and cross-account recovery is refused", () => {
  for (const { command } of workspaceCases) {
    const attempt = createPendingWorkspaceCommand(
      workspaceSponsor,
      workspaceProblem,
      command,
      "workspace-one",
      1000,
    );
    const saved = storage();
    persistWorkspaceCommand(saved, attempt);
    const raw = saved.getItem(workspaceRecoveryKey(workspaceSponsor, workspaceProblem));
    if (raw === null) throw new Error("The exact pending command was not saved");
    expect(parsePendingWorkspaceCommand(raw, workspaceSponsor, workspaceProblem)).toEqual(attempt);
    expect(() =>
      parsePendingWorkspaceCommand(raw, "usr_fedcba0987654321", workspaceProblem),
    ).toThrow();
    expect(() => parsePendingWorkspaceCommand(raw, workspaceSponsor, "P-OTHER")).toThrow();
    expect(workspaceAttemptExpired(attempt, 1000 + WORKSPACE_RETRY_MS - 1)).toBe(false);
    expect(workspaceAttemptExpired(attempt, 1000 + WORKSPACE_RETRY_MS)).toBe(true);
    expect(workspaceAttemptExpired(attempt, 999)).toBe(true);
    const other = { ...attempt, key: "workspace-two" };
    expect(() => persistWorkspaceCommand(saved, other)).toThrow();
    expect(() => clearWorkspaceCommand(saved, other)).toThrow();
    expect(saved.getItem(workspaceRecoveryKey(workspaceSponsor, workspaceProblem))).toBe(raw);
    clearWorkspaceCommand(saved, attempt);
    expect(saved.values.size).toBe(0);
  }
});

test("blocked browser storage and malformed recovery never allow a new blind fork", () => {
  const attempt = createPendingWorkspaceCommand(
    workspaceSponsor,
    workspaceProblem,
    forkCommand,
    "fork-once",
  );
  expect(() =>
    persistWorkspaceCommand({ getItem: () => null, setItem: () => {} }, attempt),
  ).toThrow();
  for (const changes of [
    { key: "key\n" },
    { startedAt: Infinity },
    { extra: true },
    { input: { ...forkCommand, statement: "changed" } },
  ]) {
    expect(() =>
      parsePendingWorkspaceCommand(
        JSON.stringify({ ...attempt, ...changes }),
        workspaceSponsor,
        workspaceProblem,
      ),
    ).toThrow();
  }
});
