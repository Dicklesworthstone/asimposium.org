import {
  type ProblemLifecycleActionRequest,
  ProblemLifecycleActionRequestSchema,
  ProblemStatementProposalIdSchema,
  PublicLedgerProblemIdSchema,
} from "@asimposium/contracts";
import { isCanonicalSponsorId } from "./sponsor-id";

export type StatementRevisionCommand = Extract<
  ProblemLifecycleActionRequest,
  { action: "revise-statement" }
>;

export function validStatementRevisionProblem(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    PublicLedgerProblemIdSchema.safeParse(value).success
  );
}

export function validStatementProposalId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    ProblemStatementProposalIdSchema.safeParse(value).success
  );
}

export function validStatementRevisionKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,160}$/.exec(value)?.[0] === value;
}

/** Sponsor acceptance names an immutable Fellow work product; it carries no replacement prose. */
export function parseStatementRevisionCommand(value: unknown): StatementRevisionCommand | null {
  const parsed = ProblemLifecycleActionRequestSchema.safeParse(value);
  return parsed.success && parsed.data.action === "revise-statement" ? parsed.data : null;
}

export function statementRevisionsPath(problem: string, proposal?: string): string {
  return `/console/problems/${encodeURIComponent(problem)}/revisions${
    proposal === undefined ? "" : `/${encodeURIComponent(proposal)}`
  }`;
}

const RECOVERY_VERSION = "asimposium.statement-revision-recovery.v1";
export const STATEMENT_REVISION_RETRY_MS = 23 * 60 * 60 * 1000;

/** Browser recovery retains identifiers, digest and retry identity, never private scientific text. */
export interface PendingStatementRevision {
  readonly version: typeof RECOVERY_VERSION;
  readonly sponsorId: string;
  readonly problemId: string;
  readonly input: StatementRevisionCommand;
  readonly key: string;
  readonly startedAt: number;
}

export function statementRevisionRecoveryKey(sponsorId: string, problemId: string): string {
  if (!isCanonicalSponsorId(sponsorId) || !validStatementRevisionProblem(problemId))
    throw new Error("Invalid statement revision recovery scope");
  return `${RECOVERY_VERSION}:${sponsorId}:${problemId}`;
}

export function parsePendingStatementRevision(
  raw: string,
  sponsorId: string,
  problemId: string,
): PendingStatementRevision {
  statementRevisionRecoveryKey(sponsorId, problemId);
  if (raw.length > 2048) throw new Error("Statement revision recovery exceeds its metadata bound");
  const value: unknown = JSON.parse(raw);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid statement revision recovery");
  const record = value as Record<string, unknown>;
  const input = parseStatementRevisionCommand(record.input);
  if (
    Object.keys(record).sort().join(",") !== "input,key,problemId,sponsorId,startedAt,version" ||
    record.version !== RECOVERY_VERSION ||
    record.sponsorId !== sponsorId ||
    record.problemId !== problemId ||
    !validStatementRevisionKey(record.key) ||
    !input ||
    typeof record.startedAt !== "number" ||
    !Number.isSafeInteger(record.startedAt) ||
    record.startedAt < 0
  )
    throw new Error("Invalid statement revision recovery");
  return {
    version: RECOVERY_VERSION,
    sponsorId,
    problemId,
    input,
    key: record.key,
    startedAt: record.startedAt,
  };
}

export function createPendingStatementRevision(
  sponsorId: string,
  problemId: string,
  input: StatementRevisionCommand,
  key: string,
  startedAt = Date.now(),
): PendingStatementRevision {
  return parsePendingStatementRevision(
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

export function statementRevisionAttemptExpired(
  attempt: PendingStatementRevision,
  now = Date.now(),
): boolean {
  return (
    !Number.isSafeInteger(now) ||
    now < attempt.startedAt ||
    now - attempt.startedAt >= STATEMENT_REVISION_RETRY_MS
  );
}

/** A different candidate cannot replace an unresolved acceptance, even from another page. */
export function persistPendingStatementRevision(
  storage: Pick<Storage, "getItem" | "setItem">,
  pending: PendingStatementRevision,
): void {
  const key = statementRevisionRecoveryKey(pending.sponsorId, pending.problemId);
  const serialized = JSON.stringify(
    parsePendingStatementRevision(JSON.stringify(pending), pending.sponsorId, pending.problemId),
  );
  const previous = storage.getItem(key);
  if (
    previous !== null &&
    JSON.stringify(
      parsePendingStatementRevision(previous, pending.sponsorId, pending.problemId),
    ) !== serialized
  )
    throw new Error("Another statement revision command is unresolved");
  storage.setItem(key, serialized);
  if (storage.getItem(key) !== serialized)
    throw new Error("Statement revision retry identity was not retained");
}

export function clearPendingStatementRevision(
  storage: Pick<Storage, "getItem" | "removeItem">,
  pending: PendingStatementRevision,
): void {
  const key = statementRevisionRecoveryKey(pending.sponsorId, pending.problemId);
  const previous = storage.getItem(key);
  if (previous === null) return;
  if (
    JSON.stringify(
      parsePendingStatementRevision(previous, pending.sponsorId, pending.problemId),
    ) !== JSON.stringify(pending)
  )
    throw new Error("Another statement revision command is unresolved");
  storage.removeItem(key);
  if (storage.getItem(key) !== null)
    throw new Error("Statement revision retry identity was not cleared");
}
