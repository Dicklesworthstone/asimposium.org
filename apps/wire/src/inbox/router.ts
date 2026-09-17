import {
  type InboxAckRequest,
  InboxAckRequestSchema,
  type InboxAckResponse,
  type InboxQuery,
  InboxQuerySchema,
  type InboxResponse,
  InboxResponseSchema,
  type ProblemFollowResponse,
  ProblemFollowResponseSchema,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { type Context, Hono } from "hono";
import { parseExactJsonBytes, readBoundedRequestBody } from "../auth/http.ts";
import type { EnrollmentService, FellowCredentialBinding } from "../enrollment/service.ts";
import type { Env } from "../env.ts";
import { validatedProblem as problem } from "../http/envelope.ts";
import { authenticatedFollowPrincipal } from "./follow-principal.ts";
import { renderInboxMarkdown } from "./markdown.ts";
import {
  ackInboxNotices,
  followProblem,
  getInboxNotices,
  getProblemFollowStatus,
  unfollowProblem,
} from "./store.ts";

export interface InboxRouterOptions {
  readonly service: EnrollmentService;
  readonly db?: D1Database;
}

function bearerToken(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  if (header === null) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

const PROBLEM_ID_REGEX = /^P-[A-Za-z0-9]{3,32}$/;
const MAX_INBOX_ACK_BODY_BYTES = 16 * 1024;

export function createInboxRouter(options: InboxRouterOptions): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  async function authenticateFellow(request: Request): Promise<FellowCredentialBinding | Response> {
    const token = bearerToken(request);
    if (token === undefined) {
      return problem({
        status: 401,
        code: "FELLOW_TOKEN_INVALID",
        title: "Fellow bearer token is not accepted",
        detail: "No bearer token was provided in Authorization.",
        fixHint:
          "Obtain a token through an explicitly approved enrollment flow and send it in Authorization.",
      });
    }
    const binding = await options.service.credentialBinding(token);
    if (binding === undefined) {
      return problem({
        status: 401,
        code: "FELLOW_TOKEN_INVALID",
        title: "Fellow bearer token is not accepted",
        detail: "The bearer token was not accepted.",
        fixHint:
          "Obtain a token through an explicitly approved enrollment flow and send it in Authorization.",
      });
    }
    return binding;
  }

  async function authenticatePrincipal(
    request: Request,
  ): Promise<{ principalId: string } | Response> {
    const principalId = await authenticatedFollowPrincipal(request, options.service);
    if (principalId !== undefined) return { principalId };

    return problem({
      status: 401,
      code: "FELLOW_TOKEN_INVALID",
      title: "Authentication required",
      detail: "Valid principal credentials are required to manage problem follows.",
      fixHint: "Provide an Authorization bearer token for an active Fellow.",
    });
  }

  // GET /v1/inbox and GET /v1/inbox.md
  app.get("/v1/inbox", async (c) => handleInbox(c));
  app.get("/v1/inbox.md", async (c) => handleInbox(c, "md"));

  async function handleInbox(c: Context<{ Bindings: Env }>, forcedFormat?: "md" | "json") {
    const auth = await authenticateFellow(c.req.raw);
    if (auth instanceof Response) return auth;

    const env = (c.env ?? {}) as Partial<Env>;
    const db = options.db ?? env.DB;
    if (!db) {
      return problem({
        status: 503,
        code: "INTERNAL_ERROR",
        title: "Database unavailable",
        detail: "No database binding available for inbox queries.",
        fixHint: "Retry later.",
      });
    }

    const rawSince = c.req.query("since");
    if (rawSince !== undefined) {
      const numSince = Number(rawSince);
      if (!Number.isInteger(numSince) || numSince < 0) {
        return problem({
          status: 400,
          code: "INBOX_CURSOR_INVALID",
          title: "Invalid inbox cursor",
          detail: "The 'since' parameter must be a non-negative integer.",
          fixHint: "Provide a valid non-negative integer cursor or omit the parameter.",
          rule: "A5",
          extensions: {
            schema: "https://a.asimposium.org/schemas/inbox.v1.json",
            example: { since: 0 },
          },
        });
      }
    }

    const rawLimit = c.req.query("limit");
    let limit = 50;
    if (rawLimit !== undefined) {
      const numLimit = Number(rawLimit);
      if (!Number.isInteger(numLimit) || numLimit < 1 || numLimit > 100) {
        return problem({
          status: 400,
          code: "SCHEMA_INVALID",
          title: "Invalid inbox limit",
          detail: "The 'limit' parameter must be an integer between 1 and 100.",
          fixHint: "Specify a limit between 1 and 100.",
          rule: "A5",
          extensions: {
            schema: "https://a.asimposium.org/schemas/inbox.v1.json",
            example: { limit: 50 },
          },
        });
      }
      limit = numLimit;
    }

    const rawUnread = c.req.query("unread_only");
    const unreadOnly = rawUnread === "true" || rawUnread === "1";

    const query: InboxQuery = {
      ...(rawSince !== undefined ? { since: Number(rawSince) } : {}),
      limit,
      unread_only: unreadOnly,
    };

    const inboxData = await getInboxNotices(db, auth.fellowId, query);
    const response: InboxResponse = InboxResponseSchema.parse(inboxData);

    const wantsMarkdown =
      forcedFormat === "md" ||
      c.req.path.endsWith(".md") ||
      (c.req.header("accept")?.includes("text/markdown") &&
        !c.req.header("accept")?.includes("application/json"));

    if (wantsMarkdown) {
      return new Response(renderInboxMarkdown(response), {
        status: 200,
        headers: {
          "content-type": "text/markdown; charset=utf-8",
          "cache-control": "private, no-store",
        },
      });
    }

    return c.json(response, 200, { "cache-control": "private, no-store" });
  }

  // POST /v1/inbox/ack
  app.post("/v1/inbox/ack", async (c) => {
    const auth = await authenticateFellow(c.req.raw);
    if (auth instanceof Response) return auth;

    const env = (c.env ?? {}) as Partial<Env>;
    const db = options.db ?? env.DB;
    if (!db) {
      return problem({
        status: 503,
        code: "INTERNAL_ERROR",
        title: "Database unavailable",
        detail: "No database binding available for inbox updates.",
        fixHint: "Retry later.",
      });
    }

    const bodyResult = await readBoundedRequestBody(c.req.raw, MAX_INBOX_ACK_BODY_BYTES);
    if (!bodyResult.ok) {
      if (bodyResult.reason === "too-large") {
        return problem({
          status: 413,
          code: "REQUEST_BODY_TOO_LARGE",
          title: "Inbox acknowledgment payload too large",
          detail: `Inbox acknowledgment payloads are bounded at ${MAX_INBOX_ACK_BODY_BYTES} bytes.`,
          fixHint: "Acknowledge in smaller batches or use until_seq.",
        });
      }
      return problem({
        status: 400,
        code: "INBOX_ACK_BODY_INVALID",
        title: "Invalid inbox acknowledgment request",
        detail: "Malformed JSON payload.",
        fixHint: "Provide an array of notice_ids or an until_seq integer.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/inbox.v1.json",
          example: { until_seq: 10 },
        },
      });
    }

    let rawBody: unknown;
    try {
      rawBody = parseExactJsonBytes(bodyResult.bytes);
    } catch {
      return problem({
        status: 400,
        code: "INBOX_ACK_BODY_INVALID",
        title: "Invalid inbox acknowledgment request",
        detail: "Malformed JSON payload.",
        fixHint: "Provide an array of notice_ids or an until_seq integer.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/inbox.v1.json",
          example: { until_seq: 10 },
        },
      });
    }

    const parsed = InboxAckRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return problem({
        status: 400,
        code: "INBOX_ACK_BODY_INVALID",
        title: "Invalid inbox acknowledgment request",
        detail: parsed.error.issues.map((i) => i.message).join("; ") || "Invalid body.",
        fixHint: "Provide an array of notice_ids or an until_seq integer.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/inbox.v1.json",
          example: { until_seq: 10 },
        },
      });
    }

    const ackResult = await ackInboxNotices(db, auth.fellowId, parsed.data);
    const response: InboxAckResponse = {
      acknowledged_count: ackResult.acknowledged_count,
      unacknowledged_count: ackResult.unacknowledged_count,
    };

    return c.json(response, 200, { "cache-control": "private, no-store" });
  });

  // Problem Follow Handlers
  async function handleFollow(c: Context<{ Bindings: Env }>, method: "POST" | "DELETE" | "GET") {
    const auth = await authenticatePrincipal(c.req.raw);
    if (auth instanceof Response) return auth;

    const env = (c.env ?? {}) as Partial<Env>;
    const db = options.db ?? env.DB;
    if (!db) {
      return problem({
        status: 503,
        code: "INTERNAL_ERROR",
        title: "Database unavailable",
        detail: "No database binding available for problem follow operations.",
        fixHint: "Retry later.",
      });
    }

    let rawProblemId = c.req.param("id") ?? "";
    if (rawProblemId.endsWith(".json") || rawProblemId.endsWith(".md")) {
      rawProblemId = rawProblemId.replace(/\.(json|md)$/, "");
    }

    if (!PROBLEM_ID_REGEX.test(rawProblemId)) {
      return problem({
        status: 404,
        code: "PROBLEM_NOT_FOUND",
        title: "Problem not found",
        detail: `The problem identifier ${rawProblemId} is not a valid problem ID.`,
        fixHint: "Specify a valid problem identifier like P-4DSP.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/problem.v1.json",
          example: { method: "GET", path: "/problems.json" },
        },
      });
    }

    const problemId = rawProblemId;

    if (method === "POST") {
      const result = await followProblem(db, auth.principalId, problemId);
      if (result.notFound) {
        return problem({
          status: 404,
          code: "PROBLEM_NOT_FOUND",
          title: "Problem not found",
          detail: `The problem ${problemId} does not exist.`,
          fixHint: "Choose an existing problem from /problems.json.",
          rule: "A5",
          extensions: {
            schema: "https://a.asimposium.org/schemas/problem.v1.json",
            example: { method: "GET", path: "/problems.json" },
          },
        });
      }
      return c.json(ProblemFollowResponseSchema.parse(result.response), 200, {
        "cache-control": "private, no-store",
      });
    }

    if (method === "DELETE") {
      const result = await unfollowProblem(db, auth.principalId, problemId);
      if (result.notFound) {
        return problem({
          status: 404,
          code: "PROBLEM_NOT_FOUND",
          title: "Problem not found",
          detail: `The problem ${problemId} does not exist.`,
          fixHint: "Choose an existing problem from /problems.json.",
          rule: "A5",
          extensions: {
            schema: "https://a.asimposium.org/schemas/problem.v1.json",
            example: { method: "GET", path: "/problems.json" },
          },
        });
      }
      return c.json(ProblemFollowResponseSchema.parse(result.response), 200, {
        "cache-control": "private, no-store",
      });
    }

    const result = await getProblemFollowStatus(db, auth.principalId, problemId);
    if (result.notFound) {
      return problem({
        status: 404,
        code: "PROBLEM_NOT_FOUND",
        title: "Problem not found",
        detail: `The problem ${problemId} does not exist.`,
        fixHint: "Choose an existing problem from /problems.json.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/problem.v1.json",
          example: { method: "GET", path: "/problems.json" },
        },
      });
    }
    return c.json(ProblemFollowResponseSchema.parse(result.response), 200, {
      "cache-control": "private, no-store",
    });
  }

  app.post("/v1/p/:id/follow", (c) => handleFollow(c, "POST"));
  app.post("/v1/problems/:id/follow", (c) => handleFollow(c, "POST"));
  app.delete("/v1/p/:id/follow", (c) => handleFollow(c, "DELETE"));
  app.delete("/v1/problems/:id/follow", (c) => handleFollow(c, "DELETE"));
  app.get("/v1/p/:id/follow", (c) => handleFollow(c, "GET"));
  app.get("/v1/problems/:id/follow", (c) => handleFollow(c, "GET"));

  return app;
}
