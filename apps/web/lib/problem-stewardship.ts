import {
  ProblemGovernanceKeySchema,
  ProblemLifecycleActionRequestSchema,
  PublicLedgerProblemIdSchema,
  SponsorIdSchema,
  type SponsorProblemGovernanceQuery,
} from "@asimposium/contracts";

export type ProblemStewardshipCommand = {
  readonly action: "manage-steward";
  readonly operation: "add" | "transfer" | "remove";
  readonly target_sponsor_id: string;
  readonly expected_stewardship_version: number;
};

/** The console always pins the roster it showed; legacy unpinned API commands
 * are deliberately outside this human confirmation surface. */
export function parseProblemStewardshipCommand(
  value: unknown,
): ProblemStewardshipCommand | undefined {
  const parsed = ProblemLifecycleActionRequestSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.action !== "manage-steward" ||
    parsed.data.expected_stewardship_version === undefined
  )
    return undefined;
  return {
    action: parsed.data.action,
    operation: parsed.data.operation,
    target_sponsor_id: parsed.data.target_sponsor_id,
    expected_stewardship_version: parsed.data.expected_stewardship_version,
  };
}

export const STEWARDSHIP_RETRY_MS = 23 * 60 * 60 * 1000;
export interface PendingStewardship {
  readonly version: 1;
  readonly sponsorId: string;
  readonly problemId: string;
  readonly command: ProblemStewardshipCommand;
  readonly key: string;
  readonly startedAt: number;
}

export function stewardshipRecoveryKey(sponsorId: string, problemId: string): string {
  return `asimp:stewardship:${sponsorId}:${problemId}`;
}

export function createStewardshipAttempt(
  sponsorId: string,
  problemId: string,
  command: ProblemStewardshipCommand,
  key: string,
  now = Date.now(),
): PendingStewardship | undefined {
  const parsed = parseProblemStewardshipCommand(command);
  if (
    !parsed ||
    !SponsorIdSchema.safeParse(sponsorId).success ||
    !PublicLedgerProblemIdSchema.safeParse(problemId).success ||
    !ProblemGovernanceKeySchema.safeParse(key).success ||
    !Number.isSafeInteger(now) ||
    now < 0
  )
    return undefined;
  return { version: 1, sponsorId, problemId, command: parsed, key, startedAt: now };
}

export function parseStewardshipAttempt(
  raw: string,
  sponsorId: string,
  problemId: string,
  now = Date.now(),
): PendingStewardship | undefined {
  if (raw.length > 4096) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const entry = value as Record<string, unknown>;
    if (
      Object.keys(entry).length !== 6 ||
      entry.version !== 1 ||
      entry.sponsorId !== sponsorId ||
      entry.problemId !== problemId ||
      typeof entry.key !== "string" ||
      typeof entry.startedAt !== "number" ||
      entry.startedAt > now
    )
      return undefined;
    const command = parseProblemStewardshipCommand(entry.command);
    return command
      ? createStewardshipAttempt(sponsorId, problemId, command, entry.key, entry.startedAt)
      : undefined;
  } catch {
    return undefined;
  }
}

export function stewardshipAttemptExpired(attempt: PendingStewardship, now = Date.now()): boolean {
  return (
    !Number.isSafeInteger(now) ||
    now < attempt.startedAt ||
    now - attempt.startedAt >= STEWARDSHIP_RETRY_MS
  );
}

export function problemGovernanceConsolePath(
  problemId: string,
  query: SponsorProblemGovernanceQuery = {},
): string {
  const params = new URLSearchParams();
  if (query.after !== undefined) params.set("after", query.after);
  if (query.steward_after !== undefined) params.set("steward_after", query.steward_after);
  const search = params.toString();
  return `/console/problems/${encodeURIComponent(problemId)}/access${search ? `?${search}` : ""}`;
}
