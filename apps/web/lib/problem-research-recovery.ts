import {
  ProblemLifecycleActionRequestSchema,
  PublicLedgerProblemIdSchema,
} from "@asimposium/contracts";
import type { ProblemResearchCommand } from "./problem-research";
import { isCanonicalSponsorId } from "./sponsor-id";

const RECOVERY_VERSION = "asimposium.problem-research-recovery.v1";
export const PROBLEM_RESEARCH_RETRY_MS = 23 * 60 * 60 * 1000;

/** Only public scientific content and its unchanged retry identity are retained. */
export interface PendingProblemResearch {
  readonly version: typeof RECOVERY_VERSION;
  readonly sponsorId: string;
  readonly problemId: string;
  readonly input: ProblemResearchCommand;
  readonly key: string;
  readonly startedAt: number;
}

export function problemResearchRecoveryKey(sponsorId: string, problemId: string): string {
  if (
    !isCanonicalSponsorId(sponsorId) ||
    !PublicLedgerProblemIdSchema.safeParse(problemId).success ||
    problemId.trim() !== problemId
  )
    throw new Error("Invalid research recovery scope");
  return `${RECOVERY_VERSION}:${sponsorId}:${problemId}`;
}

/** Parse through the same command schema before the first send and every retry. */
export function parsePendingProblemResearch(
  raw: string,
  sponsorId: string,
  problemId: string,
): PendingProblemResearch {
  problemResearchRecoveryKey(sponsorId, problemId);
  if (raw.length > 262_144) throw new Error("Research recovery is too large");
  const value: unknown = JSON.parse(raw);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid research recovery");
  }
  const record = value as Record<string, unknown>;
  const parsed = ProblemLifecycleActionRequestSchema.safeParse(record.input);
  if (
    Object.keys(record).sort().join(",") !== "input,key,problemId,sponsorId,startedAt,version" ||
    record.version !== RECOVERY_VERSION ||
    record.sponsorId !== sponsorId ||
    record.problemId !== problemId ||
    typeof record.key !== "string" ||
    !/^[A-Za-z0-9._-]{1,160}$/.test(record.key) ||
    record.key.trim() !== record.key ||
    typeof record.startedAt !== "number" ||
    !Number.isSafeInteger(record.startedAt) ||
    record.startedAt < 0 ||
    !parsed.success ||
    !["enter-result-review", "resolve"].includes(parsed.data.action)
  )
    throw new Error("Invalid research recovery");
  const input = parsed.data;
  if (
    input.action === "resolve" &&
    (input.closing_synthesis.synthesis_id === undefined ||
      input.closing_synthesis.synthesis_id.trim() !== input.closing_synthesis.synthesis_id ||
      input.external_expert_review_proof !== undefined)
  ) {
    throw new Error("A resolution retry requires its exact ordinary closing synthesis");
  }
  if (input.action !== "enter-result-review" && input.action !== "resolve") {
    throw new Error("Invalid research action");
  }
  if (
    input.action === "enter-result-review" &&
    (input.result_claim.claim_id.trim() !== input.result_claim.claim_id ||
      !Number.isSafeInteger(input.result_claim.version))
  )
    throw new Error("A result review requires an exact claim version");
  return {
    version: RECOVERY_VERSION,
    sponsorId,
    problemId,
    input,
    key: record.key,
    startedAt: record.startedAt,
  };
}

export function createPendingProblemResearch(
  sponsorId: string,
  problemId: string,
  input: ProblemResearchCommand,
  key: string,
  startedAt = Date.now(),
): PendingProblemResearch {
  return parsePendingProblemResearch(
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

export function problemResearchAttemptExpired(
  attempt: PendingProblemResearch,
  now = Date.now(),
): boolean {
  return (
    !Number.isSafeInteger(now) ||
    now < attempt.startedAt ||
    now - attempt.startedAt >= PROBLEM_RESEARCH_RETRY_MS
  );
}

/** A later click must never replace an unresolved command, including after reload. */
export function persistPendingProblemResearch(
  storage: Pick<Storage, "getItem" | "setItem">,
  pending: PendingProblemResearch,
): void {
  const key = problemResearchRecoveryKey(pending.sponsorId, pending.problemId);
  const serialized = JSON.stringify(
    parsePendingProblemResearch(JSON.stringify(pending), pending.sponsorId, pending.problemId),
  );
  const existing = storage.getItem(key);
  if (
    existing !== null &&
    JSON.stringify(parsePendingProblemResearch(existing, pending.sponsorId, pending.problemId)) !==
      serialized
  ) {
    throw new Error("Another research command is still pending");
  }
  storage.setItem(key, serialized);
  if (storage.getItem(key) !== serialized)
    throw new Error("Research retry details could not be retained");
}

export function clearPendingProblemResearch(
  storage: Pick<Storage, "getItem" | "removeItem">,
  pending: PendingProblemResearch,
): void {
  const key = problemResearchRecoveryKey(pending.sponsorId, pending.problemId);
  const existing = storage.getItem(key);
  if (existing === null) return;
  if (
    JSON.stringify(parsePendingProblemResearch(existing, pending.sponsorId, pending.problemId)) !==
    JSON.stringify(pending)
  ) {
    throw new Error("Another research command is still pending");
  }
  storage.removeItem(key);
  if (storage.getItem(key) !== null) throw new Error("Research retry details could not be cleared");
}
