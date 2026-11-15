import {
  type ProblemForkResponse,
  ProblemGovernanceKeySchema,
  type ProblemLifecycleActionRequest,
  ProblemLifecycleActionRequestSchema,
  type ProblemMergeResponse,
  type ProblemRetirementResponse,
  PublicClaimTargetSchema,
  PublicLedgerProblemIdSchema,
} from "@asimposium/contracts";
import { isCanonicalSponsorId } from "./sponsor-id";

/** The sponsor can fork an existing formulation, but cannot author a new one. */
export type ProblemWorkspaceCommand =
  | Extract<ProblemLifecycleActionRequest, { action: "retire" | "merge" }>
  | Pick<Extract<ProblemLifecycleActionRequest, { action: "fork" }>, "action" | "title">;

export type ProblemWorkspaceReceipt =
  | { readonly action: "retire"; readonly result: ProblemRetirementResponse }
  | { readonly action: "merge"; readonly result: ProblemMergeResponse }
  | { readonly action: "fork"; readonly result: ProblemForkResponse };

export type ProblemWorkspaceResult =
  | { readonly ok: true; readonly receipt: ProblemWorkspaceReceipt }
  | {
      readonly ok: false;
      readonly message: string;
      readonly retryable: boolean;
      readonly retainAttempt?: true;
      readonly refreshRequired?: true;
      readonly signInRequired?: true;
    };

export function validWorkspaceProblem(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    PublicLedgerProblemIdSchema.safeParse(value).success
  );
}

export function validWorkspaceKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    ProblemGovernanceKeySchema.safeParse(value).success
  );
}

/** All inputs pass the existing canonical command contract. The console's
 * narrower fork path deliberately carries no sponsor-authored formulation. */
export function parseProblemWorkspaceCommand(
  problemId: string,
  input: unknown,
): ProblemWorkspaceCommand | undefined {
  if (!validWorkspaceProblem(problemId)) return undefined;
  const parsed = ProblemLifecycleActionRequestSchema.safeParse(input);
  if (!parsed.success) return undefined;
  const command = parsed.data;
  if (command.action === "retire") return command.reason.trim().length > 0 ? command : undefined;
  if (command.action === "fork") {
    if (
      Object.keys(command).sort().join(",") !== "action,title" ||
      command.title.trim().length === 0
    )
      return undefined;
    return { action: "fork", title: command.title };
  }
  if (
    command.action !== "merge" ||
    !validWorkspaceProblem(command.canonical_problem_id) ||
    command.canonical_problem_id === problemId
  )
    return undefined;
  const mapping = Object.entries(command.claim_mapping ?? {});
  if (
    mapping.length > 32 ||
    mapping.some(([from, to]) =>
      [from, to].some(
        (reference) =>
          reference.length > 128 ||
          reference.trim() !== reference ||
          !PublicClaimTargetSchema.safeParse(reference).success,
      ),
    )
  )
    return undefined;
  return command;
}

export function workspaceClaimMapping(
  rows: readonly { readonly source: string; readonly target: string }[],
): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  for (const row of rows) {
    const source = row.source.trim();
    const target = row.target.trim();
    if (source === "" && target === "") continue;
    if (
      source === "" ||
      target === "" ||
      Object.hasOwn(result, source) ||
      source.length > 128 ||
      target.length > 128 ||
      !PublicClaimTargetSchema.safeParse(source).success ||
      !PublicClaimTargetSchema.safeParse(target).success
    )
      return undefined;
    result[source] = target;
  }
  return Object.keys(result).length <= 32 ? result : undefined;
}

const RECOVERY_VERSION = "asimposium.problem-workspace-recovery.v1";
export const WORKSPACE_RETRY_MS = 23 * 60 * 60 * 1000;
export interface PendingWorkspaceCommand {
  readonly version: typeof RECOVERY_VERSION;
  readonly sponsorId: string;
  readonly problemId: string;
  readonly input: ProblemWorkspaceCommand;
  readonly key: string;
  readonly startedAt: number;
}

export function workspaceRecoveryKey(sponsorId: string, problemId: string): string {
  if (!isCanonicalSponsorId(sponsorId) || !validWorkspaceProblem(problemId))
    throw new Error("Invalid workspace recovery scope");
  return `${RECOVERY_VERSION}:${sponsorId}:${problemId}`;
}

export function parsePendingWorkspaceCommand(
  raw: string,
  sponsorId: string,
  problemId: string,
): PendingWorkspaceCommand {
  workspaceRecoveryKey(sponsorId, problemId);
  if (raw.length > 32_768) throw new Error("Workspace retry details are too large");
  const value: unknown = JSON.parse(raw);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid workspace retry details");
  const record = value as Record<string, unknown>;
  const input = parseProblemWorkspaceCommand(problemId, record.input);
  if (
    Object.keys(record).sort().join(",") !== "input,key,problemId,sponsorId,startedAt,version" ||
    record.version !== RECOVERY_VERSION ||
    record.sponsorId !== sponsorId ||
    record.problemId !== problemId ||
    !validWorkspaceKey(record.key) ||
    typeof record.startedAt !== "number" ||
    !Number.isSafeInteger(record.startedAt) ||
    record.startedAt < 0 ||
    input === undefined
  )
    throw new Error("Invalid workspace retry details");
  return {
    version: RECOVERY_VERSION,
    sponsorId,
    problemId,
    input,
    key: record.key,
    startedAt: record.startedAt,
  };
}

export function createPendingWorkspaceCommand(
  sponsorId: string,
  problemId: string,
  input: ProblemWorkspaceCommand,
  key: string,
  startedAt = Date.now(),
): PendingWorkspaceCommand {
  return parsePendingWorkspaceCommand(
    JSON.stringify({
      version: RECOVERY_VERSION,
      sponsorId,
      problemId,
      input,
      key,
      startedAt,
    }),
    sponsorId,
    problemId,
  );
}

export function workspaceAttemptExpired(
  attempt: PendingWorkspaceCommand,
  now = Date.now(),
): boolean {
  return (
    !Number.isSafeInteger(now) ||
    now < attempt.startedAt ||
    now - attempt.startedAt >= WORKSPACE_RETRY_MS
  );
}

/** Retain exact bytes before sending; a lost reply must never create another fork. */
export function persistWorkspaceCommand(
  storage: Pick<Storage, "getItem" | "setItem">,
  attempt: PendingWorkspaceCommand,
): void {
  const key = workspaceRecoveryKey(attempt.sponsorId, attempt.problemId);
  const serialized = JSON.stringify(
    parsePendingWorkspaceCommand(JSON.stringify(attempt), attempt.sponsorId, attempt.problemId),
  );
  const existing = storage.getItem(key);
  if (
    existing !== null &&
    JSON.stringify(parsePendingWorkspaceCommand(existing, attempt.sponsorId, attempt.problemId)) !==
      serialized
  )
    throw new Error("Another workspace command is still pending");
  storage.setItem(key, serialized);
  if (storage.getItem(key) !== serialized)
    throw new Error("Workspace retry details were not saved");
}

export function clearWorkspaceCommand(
  storage: Pick<Storage, "getItem" | "removeItem">,
  attempt: PendingWorkspaceCommand,
): void {
  const key = workspaceRecoveryKey(attempt.sponsorId, attempt.problemId);
  const existing = storage.getItem(key);
  if (existing === null) return;
  if (
    JSON.stringify(parsePendingWorkspaceCommand(existing, attempt.sponsorId, attempt.problemId)) !==
    JSON.stringify(attempt)
  )
    throw new Error("A different workspace command is pending");
  storage.removeItem(key);
  if (storage.getItem(key) !== null) throw new Error("Workspace retry details were not cleared");
}
