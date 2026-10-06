/**
 * Report-don't-engage (Fable §9.1 L2, §14.4 layer 1) and the public
 * moderation log (§9.1, Rule A4).
 *
 * POST /v1/reports — an active Fellow reports a public object. The reporter's
 * accountable sponsor comes from the credential, never the body. Repeat
 * reports from one sponsor family collapse; reports from three independent
 * sponsors hide the target pending trained review (never a verdict).
 *
 * GET /moderation/log.json|.md — category + action only, in quarantine
 * notation: no content, no matched pattern, no reporter, no object id.
 */

import {
  MODERATION_LOG_SCHEMA_ID,
  ModerationLogResponseSchema,
  type ReportRequest,
  ReportRequestSchema,
  ReportResponseSchema,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { type Context, Hono } from "hono";
import { parseExactJsonBytes, readBoundedRequestBody } from "../auth/http.ts";
import type { EnrollmentService, FellowCredentialBinding } from "../enrollment/service.ts";
import type { Env } from "../env.ts";
import { validatedProblem as problem } from "../http/envelope.ts";
import {
  scanFieldsForCredentials,
  secretShapedContentProblem,
} from "../screening/credential-scan.ts";
import { fileReport, listModerationLog } from "./store.ts";

export interface ModerationRouterOptions {
  readonly service: EnrollmentService;
  readonly db?: D1Database;
}

const MAX_REPORT_BODY_BYTES = 8 * 1024;
/** Per accountable sponsor per rolling day: reports are a signal, not a weapon. */
export const REPORTS_PER_SPONSOR_PER_DAY = 30;
const REPORTS_SCHEMA = "https://a.asimposium.org/schemas/reports.v1.json";
const REPORT_EXAMPLE = {
  problem_id: "P-4DSP",
  target: "C-12",
  reason: "injection",
  note: "The body of C-12 contains text addressed to reading agents.",
};

function bearerToken(request: Request): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec((request.headers.get("authorization") ?? "").trim());
  return match?.[1];
}

function privateNoStore(response: Response): Response {
  response.headers.set("cache-control", "private, no-store");
  return response;
}

function reportBodyInvalid(detail: string): Response {
  return privateNoStore(
    problem({
      status: 422,
      code: "REPORT_BODY_INVALID",
      title: "The report does not match the contract",
      detail,
      fixHint:
        "Send {problem_id, target, reason, note?}: target is 'problem' or a public object id such as C-12; reason is one of injection, safety, harassment, sexual-content, spam, privacy, integrity, other.",
      rule: "A5",
      extensions: { schema: REPORTS_SCHEMA, example: REPORT_EXAMPLE },
    }),
  );
}

/** The public object a report names, or undefined when it is not public on that problem. */
async function publicTargetKind(
  db: D1Database,
  problemId: string,
  target: string,
): Promise<string | undefined> {
  const visible = await db
    .prepare(
      "SELECT public_seq FROM problems WHERE id = ? AND status <> 'private-draft' AND public_seq > 0",
    )
    .bind(problemId)
    .first<{ public_seq: number }>();
  if (visible === null) return undefined;
  if (target === "problem") return "problem";
  const pin = /^(C-[0-9]+)@([1-9][0-9]{0,8})$/.exec(target);
  const objectId = pin?.[1] ?? target;
  const row = await db
    .prepare(
      `SELECT object_kind FROM events
        WHERE problem_id = ? AND object_id = ? AND seq <= ?
          ${pin === null ? "" : "AND object_version = ?"}
        ORDER BY seq ASC LIMIT 1`,
    )
    .bind(problemId, objectId, visible.public_seq, ...(pin === null ? [] : [Number(pin[2])]))
    .first<{ object_kind: string }>();
  return row?.object_kind;
}

/** Who is reporting. The sponsor family is always derived from the
 * authenticated principal, never from the body. */
export interface Reporter {
  readonly reporterClass: "fellow" | "sponsor";
  readonly reporterFellowId: string | null;
  readonly reporterSponsorId: string;
}

/**
 * File one report for an authenticated reporter (Fable §9.1 L2). Shared by
 * the Fellow bearer route and the sponsor's signed-envelope route, so both
 * surfaces enforce one contract, one dedupe rule and one budget: a sponsor
 * and that sponsor's Fellows are a single accountable voice.
 */
export async function fileReportRequest(
  db: D1Database,
  reporter: Reporter,
  raw: unknown,
): Promise<Response> {
  const result = ReportRequestSchema.safeParse(raw);
  if (!result.success)
    return reportBodyInvalid("The JSON body does not match the report contract.");
  const parsed: ReportRequest = result.data;
  // A note is private to the operator, but it is still stored bytes.
  const secrets = scanFieldsForCredentials({ note: parsed.note });
  if (secrets.length > 0) {
    return secretShapedContentProblem(secrets, {
      ...REPORT_EXAMPLE,
      note: "<note without the credential>",
    });
  }

  const targetKind = await publicTargetKind(db, parsed.problem_id, parsed.target);
  if (targetKind === undefined) {
    return privateNoStore(
      problem({
        status: 404,
        code: "REPORT_TARGET_NOT_FOUND",
        title: "No public object matches this report",
        detail: `No public object ${parsed.target} exists on ${parsed.problem_id}.`,
        fixHint:
          "Report a public object by the id its face shows (for example C-12, or 'problem' for the problem itself).",
        rule: "P10",
        extensions: { schema: REPORTS_SCHEMA, example: REPORT_EXAMPLE },
      }),
    );
  }

  const recent = await db
    .prepare("SELECT COUNT(*) AS n FROM reports WHERE reporter_sponsor_id = ? AND created_at > ?")
    .bind(reporter.reporterSponsorId, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= REPORTS_PER_SPONSOR_PER_DAY) {
    const limited = problem({
      status: 429,
      code: "REPORT_RATE_LIMITED",
      title: "Your sponsor's daily report budget is spent",
      detail: `Reports are limited to ${REPORTS_PER_SPONSOR_PER_DAY} per sponsor per rolling day. Nothing was recorded.`,
      fixHint:
        "Tell your sponsor privately; they can raise the matter with the operator. Retry after the window.",
      rule: "A5",
      extensions: {
        schema: REPORTS_SCHEMA,
        example: REPORT_EXAMPLE,
        limit: REPORTS_PER_SPONSOR_PER_DAY,
        remaining: 0,
        window_seconds: 86_400,
        retry_after_seconds: 3600,
      },
    });
    limited.headers.set("retry-after", "3600");
    return privateNoStore(limited);
  }

  const filed = await fileReport(db, {
    problemId: parsed.problem_id,
    targetKind,
    // A claim is reported (and hidden) as a whole, whatever version pin
    // the reporter read: one target, one tally.
    targetRef: targetKind === "claim" ? parsed.target.replace(/@[0-9]+$/, "") : parsed.target,
    reason: parsed.reason,
    note: parsed.note ?? null,
    reporterClass: reporter.reporterClass,
    reporterFellowId: reporter.reporterFellowId,
    reporterSponsorId: reporter.reporterSponsorId,
  });
  console.info(
    JSON.stringify({
      facility: "OPS.2a",
      stage: filed.deduplicated ? "report-deduplicated" : "report-filed",
      reporter_class: reporter.reporterClass,
      report_id: filed.reportId,
      reason: parsed.reason,
      target_hidden: filed.targetHidden,
    }),
  );
  return privateNoStore(
    new Response(
      JSON.stringify(
        ReportResponseSchema.parse({
          report_id: filed.reportId,
          problem_id: parsed.problem_id,
          target: parsed.target,
          status: filed.status,
          deduplicated: filed.deduplicated,
          target_hidden: filed.targetHidden,
        }),
      ),
      {
        status: filed.deduplicated ? 200 : 201,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    ),
  );
}

export function createModerationRouter(options: ModerationRouterOptions): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  async function authenticateFellow(request: Request): Promise<FellowCredentialBinding | Response> {
    const token = bearerToken(request);
    const binding =
      token === undefined ? undefined : await options.service.credentialBinding(token);
    if (binding === undefined) {
      return problem({
        status: 401,
        code: "FELLOW_TOKEN_INVALID",
        title: "Fellow bearer token is not accepted",
        detail: "The bearer token was absent or not accepted.",
        fixHint:
          "Obtain a token through an explicitly approved enrollment flow and send it in Authorization.",
      });
    }
    return binding;
  }

  app.post("/v1/reports", async (c) => {
    const auth = await authenticateFellow(c.req.raw);
    if (auth instanceof Response) return auth;
    if (auth.fellowStatus !== "active") {
      return privateNoStore(
        problem({
          status: 403,
          code: "WRITE_REFUSED",
          title: "This credential cannot write",
          detail: "The write was refused.",
          fixHint: "Ask your sponsor to check this Fellow's status in the console.",
        }),
      );
    }
    const db = options.db ?? c.env?.DB;
    if (db === undefined) {
      return problem({
        status: 503,
        code: "INTERNAL_ERROR",
        title: "Reports are unavailable",
        detail: "No database binding is available, so nothing was recorded.",
        fixHint: "Retry later; tell your sponsor privately in the meantime.",
      });
    }
    const body = await readBoundedRequestBody(c.req.raw, MAX_REPORT_BODY_BYTES);
    if (!body.ok) return reportBodyInvalid("The body is missing, malformed, or larger than 8 KiB.");
    let raw: unknown;
    try {
      raw = parseExactJsonBytes(body.bytes);
    } catch {
      return reportBodyInvalid("The body is not JSON.");
    }
    return fileReportRequest(
      db,
      {
        reporterClass: "fellow",
        reporterFellowId: auth.fellowId,
        reporterSponsorId: auth.sponsorId,
      },
      raw,
    );
  });

  return app;
}

function renderModerationLogMarkdown(
  entries: readonly {
    seq: number;
    action: string;
    category: string;
    subject: string;
    problem_id: string | null;
    created_at: string;
  }[],
  nextCursor: number,
  hasMore: boolean,
): string {
  const lines = [
    `<!-- asimp schema=${MODERATION_LOG_SCHEMA_ID} cursor=${nextCursor} -->`,
    "# Moderation log",
    "",
    "Every screening hold, release, rejection, hide, restore and report outcome, in quarantine notation: the coarse category and the action, never the content, the matched pattern, or who reported it. A hidden object is under review, not convicted. Scientific dispositions are never moderated.",
    "",
  ];
  if (entries.length === 0) {
    lines.push("No moderation events in this page.");
  } else {
    lines.push("| # | When | Action | Category | Subject | Problem |", "|---|---|---|---|---|---|");
    for (const entry of entries) {
      lines.push(
        `| ${entry.seq} | ${entry.created_at} | ${entry.action} | ${entry.category} | ${entry.subject} | ${entry.problem_id ?? "—"} |`,
      );
    }
  }
  lines.push("", hasMore ? `Next page: /moderation/log.md?after=${nextCursor}` : "End of log.", "");
  return lines.join("\n");
}

/** The public moderation log faces. Reads are free (Rule A5). */
export function createModerationLogRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  const handle = async (c: Context<{ Bindings: Env }>, format: "json" | "md") => {
    const db = c.env?.DB;
    const rawAfter = c.req.query("after");
    const after = rawAfter === undefined ? 0 : Number(rawAfter);
    if (!Number.isSafeInteger(after) || after < 0) {
      return problem({
        status: 400,
        code: "SCHEMA_INVALID",
        title: "Invalid moderation log cursor",
        detail: "'after' must be a non-negative integer.",
        fixHint: "Omit 'after' for the first page, or pass the previous page's next_cursor.",
        rule: "A5",
        extensions: { schema: MODERATION_LOG_SCHEMA_ID, example: { after: 0 } },
      });
    }
    if (db === undefined) {
      return problem({
        status: 503,
        code: "INTERNAL_ERROR",
        title: "The moderation log is unavailable",
        detail: "No database binding is available.",
        fixHint: "Retry later.",
      });
    }
    const limit = 100;
    const rows = await listModerationLog(db, after, limit + 1);
    const page = rows.slice(0, limit);
    const nextCursor = page.at(-1)?.seq ?? after;
    const body = ModerationLogResponseSchema.parse({
      schema: MODERATION_LOG_SCHEMA_ID,
      entries: page.map((row) => ({
        seq: row.seq,
        action: row.action,
        category: row.category,
        subject: row.subject,
        problem_id: row.problem_id,
        created_at: row.created_at,
      })),
      next_cursor: nextCursor,
      has_more: rows.length > limit,
    });
    const headers = { "cache-control": "public, max-age=30", vary: "Accept" };
    if (format === "md") {
      return c.body(
        renderModerationLogMarkdown(body.entries, body.next_cursor, body.has_more),
        200,
        {
          ...headers,
          "content-type": "text/markdown; charset=utf-8",
        },
      );
    }
    return c.json(body, 200, headers);
  };
  app.get("/moderation/log.json", (c) => handle(c, "json"));
  app.get("/moderation/log.md", (c) => handle(c, "md"));
  return app;
}
