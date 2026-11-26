import {
  ExternalExpertReviewCreateRequestSchema,
  ProblemNoClaimBoundarySchema,
  PublicLedgerProblemIdSchema,
  type ProblemNoClaimBoundary,
  type ExternalExpertReviewCreateRequest,
} from "@asimposium/contracts";
import { isCanonicalSponsorId } from "./sponsor-id";

/** The complete signed UTF-8 JSON body must fit the Worker service-envelope limit. */
export const MAX_EXTERNAL_REVIEW_REQUEST_BYTES = 64 * 1024;
const VERSION = "asimposium.external-review-recovery.v1";
export interface PendingExternalReview {
  readonly version: typeof VERSION;
  readonly operatorId: string;
  readonly problemId: string;
  readonly input: ExternalExpertReviewCreateRequest;
  readonly key: string;
  readonly startedAt: number;
}

export function externalReviewRecoveryKey(operatorId: string, problemId: string): string {
  if (!isCanonicalSponsorId(operatorId) || typeof problemId !== "string" ||
      problemId.trim() !== problemId || !PublicLedgerProblemIdSchema.safeParse(problemId).success)
    throw new Error("Invalid external review scope");
  return VERSION + ":" + operatorId + ":" + problemId;
}

export function parsePendingExternalReview(raw: string, operatorId: string, problemId: string): PendingExternalReview {
  externalReviewRecoveryKey(operatorId, problemId);
  if (raw.length > 262_144) throw new Error("External review recovery is too large");
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "input,key,operatorId,problemId,startedAt,version")
    throw new Error("Invalid external review recovery");
  const row = value as Record<string, unknown>;
  const input = ExternalExpertReviewCreateRequestSchema.safeParse(row.input);
  if (row.version !== VERSION || row.operatorId !== operatorId || row.problemId !== problemId ||
      typeof row.key !== "string" || !/^[A-Za-z0-9._-]{1,160}$/.test(row.key) || row.key.trim() !== row.key ||
      typeof row.startedAt !== "number" || !Number.isSafeInteger(row.startedAt) || row.startedAt < 0 || !input.success)
    throw new Error("Invalid external review recovery");
  return { version: VERSION, operatorId, problemId, input: input.data, key: row.key, startedAt: row.startedAt };
}

/** Serialize through the same schema and byte encoding as the signed transport. */
export function serializeExternalReviewRequest(input: unknown): string | null {
  const parsed = ExternalExpertReviewCreateRequestSchema.safeParse(input);
  if (!parsed.success) return null;
  const body = JSON.stringify(parsed.data);
  return new TextEncoder().encode(body).byteLength <= MAX_EXTERNAL_REVIEW_REQUEST_BYTES ? body : null;
}

export function createPendingExternalReview(operatorId: string, problemId: string,
  input: ExternalExpertReviewCreateRequest, key: string, startedAt = Date.now()): PendingExternalReview {
  if (serializeExternalReviewRequest(input) === null)
    throw new Error("External review request exceeds the 64 KiB ingress limit or is invalid");
  return parsePendingExternalReview(JSON.stringify({ version: VERSION, operatorId, problemId, input, key, startedAt }), operatorId, problemId);
}

/** Preserve exact string contents, including newlines and whitespace, and array order. */
export function parseExternalReviewBoundary(raw: string): ProblemNoClaimBoundary | null {
  if (typeof raw !== "string" || raw.length > 128_000) return null;
  try {
    const parsed = ProblemNoClaimBoundarySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

export function persistPendingExternalReview(storage: Pick<Storage, "getItem" | "setItem">, attempt: PendingExternalReview): void {
  const key = externalReviewRecoveryKey(attempt.operatorId, attempt.problemId);
  const checked = parsePendingExternalReview(JSON.stringify(attempt), attempt.operatorId, attempt.problemId);
  const serialized = JSON.stringify(checked);
  const existing = storage.getItem(key);
  // Older pending requests remain readable and recoverable with their original key.
  // Refuse an oversized NEW attempt before any bytes are written to browser storage.
  if (existing === null && serializeExternalReviewRequest(checked.input) === null)
    throw new Error("External review request exceeds the 64 KiB ingress limit");
  if (existing !== null && JSON.stringify(parsePendingExternalReview(existing, attempt.operatorId, attempt.problemId)) !== serialized)
    throw new Error("Another external review is still pending");
  storage.setItem(key, serialized);
  if (storage.getItem(key) !== serialized) throw new Error("External review retry details were not retained");
}

export function clearPendingExternalReview(storage: Pick<Storage, "getItem" | "removeItem">, attempt: PendingExternalReview): void {
  const key = externalReviewRecoveryKey(attempt.operatorId, attempt.problemId);
  const existing = storage.getItem(key);
  if (existing === null) return;
  if (JSON.stringify(parsePendingExternalReview(existing, attempt.operatorId, attempt.problemId)) !== JSON.stringify(attempt))
    throw new Error("Another external review is still pending");
  storage.removeItem(key);
  if (storage.getItem(key) !== null) throw new Error("External review retry details were not cleared");
}
