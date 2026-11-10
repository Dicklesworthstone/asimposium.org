import type { RateLimitBudget } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { validatedProblem } from "../http/envelope";

export const FELLOW_READ_RATE_LIMIT = 120;
export const FELLOW_READ_RATE_WINDOW_MS = 60_000;

interface ReadWindow {
  admitted_at_json: string;
}

function checkedNow(now: number): number {
  if (!Number.isSafeInteger(now) || now < FELLOW_READ_RATE_WINDOW_MS)
    throw new Error("FELLOW_READ_CLOCK_INVALID");
  return now;
}

function windowBudget(row: ReadWindow, now: number): RateLimitBudget {
  if (typeof row.admitted_at_json !== "string" || row.admitted_at_json.length > 2161)
    throw new Error("FELLOW_READ_WINDOW_INVALID");
  const timestamps: unknown = JSON.parse(row.admitted_at_json);
  if (
    !Array.isArray(timestamps) ||
    timestamps.length < 1 ||
    timestamps.length > FELLOW_READ_RATE_LIMIT ||
    timestamps.some((value) => !Number.isSafeInteger(value) || value < FELLOW_READ_RATE_WINDOW_MS)
  )
    throw new Error("FELLOW_READ_WINDOW_INVALID");
  // Future timestamps remain charged if clocks move backwards. They never
  // create capacity or an earlier retry than the first retained admission.
  const active = (timestamps as number[]).filter(
    (value) => value > now - FELLOW_READ_RATE_WINDOW_MS,
  );
  return {
    limit: FELLOW_READ_RATE_LIMIT,
    remaining: FELLOW_READ_RATE_LIMIT - active.length,
    window_seconds: FELLOW_READ_RATE_WINDOW_MS / 1000,
    ...(active.length === FELLOW_READ_RATE_LIMIT
      ? {
          retry_after_seconds: Math.max(
            1,
            Math.ceil((Math.min(...active) + FELLOW_READ_RATE_WINDOW_MS - now) / 1000),
          ),
        }
      : {}),
  };
}

/** One SQLite statement checks the rolling window, prunes expired entries and
 * admits this request. RETURNING is the committed reservation, so competing
 * credentials and sessions cannot each spend the same remaining slot. Each
 * HTTP read counts once, including HEAD and conditional reads; no caller key
 * can turn repeated expensive reads into a free idempotent replay. */
export async function reserveFellowRead(
  db: D1Database,
  fellowId: string,
  now = Date.now(),
): Promise<{ readonly admitted: boolean; readonly budget: RateLimitBudget }> {
  checkedNow(now);
  // D1 binds JavaScript numbers as SQLite REAL, including integer-valued
  // clocks. Normalize before JSON construction so subsequent admissions see
  // the canonical integer timestamps required by the stored-state guard.
  const row = await db
    .prepare(`INSERT INTO fellow_read_windows (fellow_id, admitted_at_json)
      VALUES (?1, json_array(CAST(?2 AS INTEGER)))
      ON CONFLICT (fellow_id) DO UPDATE SET admitted_at_json = json_insert(
        (SELECT json_group_array(value) FROM json_each(fellow_read_windows.admitted_at_json)
          WHERE value > ?3), '$[#]', CAST(?2 AS INTEGER))
      WHERE json_valid(fellow_read_windows.admitted_at_json)
        AND json_type(fellow_read_windows.admitted_at_json) = 'array'
        AND json_array_length(fellow_read_windows.admitted_at_json) BETWEEN 1 AND ${FELLOW_READ_RATE_LIMIT}
        AND length(fellow_read_windows.admitted_at_json) <= 2161
        AND NOT EXISTS (
        SELECT 1 FROM json_each(fellow_read_windows.admitted_at_json)
        WHERE type <> 'integer' OR value < ${FELLOW_READ_RATE_WINDOW_MS}
          OR value > 9007199254740991
      ) AND (SELECT COUNT(*) FROM json_each(fellow_read_windows.admitted_at_json)
        WHERE value > ?3) < ${FELLOW_READ_RATE_LIMIT}
      RETURNING admitted_at_json`)
    .bind(fellowId, now, now - FELLOW_READ_RATE_WINDOW_MS)
    .first<ReadWindow>();
  if (row !== null) return { admitted: true, budget: windowBudget(row, now) };
  const current = await db
    .prepare("SELECT admitted_at_json FROM fellow_read_windows WHERE fellow_id = ?")
    .bind(fellowId)
    .first<ReadWindow>();
  if (current === null) throw new Error("FELLOW_READ_WINDOW_UNAVAILABLE");
  const budget = windowBudget(current, now);
  if (budget.remaining !== 0) throw new Error("FELLOW_READ_WINDOW_UNAVAILABLE");
  return { admitted: false, budget };
}

export function fellowReadBudgetHeaders(budget: RateLimitBudget): Record<string, string> {
  return {
    "ratelimit-limit": String(budget.limit),
    "ratelimit-remaining": String(budget.remaining),
    "ratelimit-reset": String(budget.retry_after_seconds ?? budget.window_seconds),
  };
}

/** Call only after authenticating the Fellow, before pack/move composition or
 * source-body reads. Internal hello composition does not reserve a second slot. */
export async function admitFellowRead(
  db: D1Database | undefined,
  fellowId: string,
): Promise<RateLimitBudget | Response> {
  try {
    if (db === undefined) throw new Error("FELLOW_READ_STORE_UNAVAILABLE");
    const admission = await reserveFellowRead(db, fellowId);
    if (admission.admitted) return admission.budget;
    const retryAfter = admission.budget.retry_after_seconds ?? 60;
    const response = validatedProblem({
      status: 429,
      code: "RATE_LIMITED",
      title: "Fellow read rate limit reached",
      detail:
        "This Fellow has used its 120 authenticated orientation reads in the last minute. Hello, triage, next moves and session packs (including deltas) share this allowance across credentials and sessions.",
      fixHint:
        "Wait for Retry-After before reading again. Reuse the current pack while working locally; public cursor and ledger reads remain available without a credential.",
      rule: "A5",
      extensions: {
        schema: "https://a.asimposium.org/schemas/enrollment.v1/hello_response.json",
        example: { method: "GET", path: "/v1/hello" },
        retry_after_seconds: retryAfter,
        limit: admission.budget.limit,
        remaining: admission.budget.remaining,
        window_seconds: admission.budget.window_seconds,
      },
    });
    response.headers.set("retry-after", String(retryAfter));
    for (const [name, value] of Object.entries(fellowReadBudgetHeaders(admission.budget)))
      response.headers.set(name, value);
    response.headers.set("cache-control", "private, no-store");
    return response;
  } catch {
    const response = validatedProblem({
      status: 503,
      code: "INTERNAL_ERROR",
      title: "Authenticated reads are temporarily unavailable",
      detail: "The Fellow read budget could not be reserved safely.",
      fixHint:
        "Retry this read after a short delay. Public cursor and ledger reads remain available.",
    });
    response.headers.set("retry-after", "1");
    response.headers.set("cache-control", "private, no-store");
    return response;
  }
}
