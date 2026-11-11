import type { RateLimitBudget } from "@asimposium/contracts";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { validatedProblem } from "../http/envelope.ts";
import { privateBriefResponse } from "./brief-commands.ts";

/** Fable §7.10: two new problems per sponsor in a rolling 24-hour window.
 * Fellow proposals and sponsor forks consume the same allowance. */
export const PROBLEM_CREATION_LIMIT = 2;
export const PROBLEM_CREATION_WINDOW_MS = 86_400_000;

function checkedNow(now: number): number {
  if (
    !Number.isSafeInteger(now) ||
    now < PROBLEM_CREATION_WINDOW_MS ||
    now > Number.MAX_SAFE_INTEGER - PROBLEM_CREATION_WINDOW_MS
  )
    throw new Error("PROBLEM_CREATION_CLOCK_INVALID");
  return now;
}

/** Only the sponsor's aggregate allowance leaves storage. Creation receipts
 * have no foreign key to problems, so erasing or transferring a draft cannot
 * refund the sponsor who created it. Future admissions remain charged if the
 * clock moves backwards. Legacy pre-limit use can exceed two; recovery waits
 * until fewer than two admissions remain, not merely the oldest expiry. */
export async function getProblemCreationBudget(
  db: D1Database,
  sponsorId: string,
  now = Date.now(),
): Promise<RateLimitBudget> {
  checkedNow(now);
  const row = await db
    .prepare(`SELECT COUNT(*) AS used,
      (SELECT created_at FROM problem_creation_admissions
        WHERE sponsor_id = ?1 AND created_at > ?2
        ORDER BY created_at DESC, problem_id DESC LIMIT 1 OFFSET 1) AS recovery_at
      FROM problem_creation_admissions WHERE sponsor_id = ?1 AND created_at > ?2`)
    .bind(sponsorId, now - PROBLEM_CREATION_WINDOW_MS)
    .first<{ used: number; recovery_at: number | null }>();
  if (
    !row ||
    !Number.isSafeInteger(row.used) ||
    row.used < 0 ||
    (row.used >= PROBLEM_CREATION_LIMIT &&
      (row.recovery_at === null ||
        !Number.isSafeInteger(row.recovery_at) ||
        row.recovery_at <= now - PROBLEM_CREATION_WINDOW_MS ||
        row.recovery_at > Number.MAX_SAFE_INTEGER - PROBLEM_CREATION_WINDOW_MS)) ||
    (row.used < PROBLEM_CREATION_LIMIT && row.recovery_at !== null)
  )
    throw new Error("PROBLEM_CREATION_BUDGET_UNAVAILABLE");
  return {
    limit: PROBLEM_CREATION_LIMIT,
    remaining: Math.max(0, PROBLEM_CREATION_LIMIT - row.used),
    window_seconds: PROBLEM_CREATION_WINDOW_MS / 1000,
    ...(row.used >= PROBLEM_CREATION_LIMIT
      ? {
          retry_after_seconds: Math.max(
            1,
            Math.ceil(
              ((row.recovery_at ?? now) + PROBLEM_CREATION_WINDOW_MS - now) / 1000,
            ),
          ),
        }
      : {}),
  };
}

/** Append these statements immediately after the new problem INSERT, inside
 * its existing atomic D1 batch. SQLite's admission trigger elects the final
 * slot under competing proposals/forks; any later failure rolls the charge
 * back with the problem. A replay never reaches this command, and a losing
 * same-key batch recovers its original receipt before reporting a limit.
 * No public event is appended merely to account for a private creation. */
export function problemCreationAccountingStatements(
  db: D1Database,
  sponsorId: string,
  problemId: string,
  now = Date.now(),
): D1PreparedStatement[] {
  checkedNow(now);
  return [
    db
      .prepare(
        "DELETE FROM problem_creation_admissions WHERE sponsor_id = ? AND created_at <= ?",
      )
      .bind(sponsorId, now - PROBLEM_CREATION_WINDOW_MS),
    db
      .prepare(`INSERT INTO problem_creation_admissions (problem_id, sponsor_id, created_at)
        SELECT id, ?, CAST(? AS INTEGER) FROM problems WHERE id = ? AND sponsor_id = ?`)
      .bind(sponsorId, now, problemId, sponsorId),
  ];
}

export function isProblemCreationRateLimitError(error: unknown): boolean {
  for (let depth = 0; depth < 4 && error instanceof Error; depth++) {
    if (error.message.includes("PROBLEM_CREATION_RATE_LIMITED")) return true;
    error = error.cause;
  }
  return false;
}

export function problemCreationRateLimitedProblem(budget: RateLimitBudget): Response {
  const retryAfter = budget.retry_after_seconds ?? PROBLEM_CREATION_WINDOW_MS / 1000;
  const response = privateBriefResponse(
    validatedProblem({
      status: 429,
      code: "RATE_LIMITED",
      title: "Sponsor problem creation limit reached",
      detail:
        "This sponsor has created two problems in the rolling 24-hour window. Fellow proposals and sponsor forks share this allowance. This request created no problem or fork.",
      fixHint:
        "Continue work in an existing problem or save private sponsor intent as a brief. Retry this unchanged command after Retry-After with the same Idempotency-Key. A completed command can still be recovered immediately with its original key and body; deleting drafts does not restore capacity.",
      rule: "A5",
      extensions: {
        schema: "https://a.asimposium.org/schemas/problems.v1.json",
        example: { method: "GET", path: "/v1/hello" },
        limit: budget.limit,
        remaining: budget.remaining,
        window_seconds: budget.window_seconds,
        retry_after_seconds: retryAfter,
      },
    }),
  );
  response.headers.set("retry-after", String(retryAfter));
  response.headers.set("ratelimit-limit", String(budget.limit));
  response.headers.set("ratelimit-remaining", String(budget.remaining));
  response.headers.set("ratelimit-reset", String(retryAfter));
  return response;
}

export function problemCreationQuotaUnavailableProblem(): Response {
  const response = privateBriefResponse(
    validatedProblem({
      status: 503,
      code: "INTERNAL_ERROR",
      title: "Problem creation is temporarily unavailable",
      detail: "The sponsor's problem creation allowance could not be checked safely.",
      fixHint:
        "Keep the exact command and Idempotency-Key and retry after a short delay. Do not start a replacement command while its outcome is uncertain.",
    }),
  );
  response.headers.set("retry-after", "1");
  return response;
}
