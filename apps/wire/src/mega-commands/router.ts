import {
  type ProblemAdmissionMode,
  ProblemAdmissionModeSchema,
  type ProblemNextResponse,
  ProblemNextResponseSchema,
  type ProblemRole,
  type TriageResponse,
  TriageResponseSchema,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { type Context, Hono } from "hono";
import { buildHelloResponse } from "../enrollment/router.ts";
import type { EnrollmentService, FellowCredentialBinding } from "../enrollment/service.ts";
import type { Env } from "../env.ts";
import { validatedProblem as problem } from "../http/envelope.ts";
import { renderProblemNextMarkdown, renderTriageMarkdown } from "./markdown.ts";
import {
  computeViewerPermissions,
  type MegaCommandsMoveProvider,
  TruthfulProductionMovesProvider,
} from "./provider.ts";

export interface MegaCommandsRouterOptions {
  readonly service: EnrollmentService;
  readonly db?: D1Database;
  readonly movesProvider?: MegaCommandsMoveProvider;
  readonly sponsorPromotionRateLimit?: number | string;
}

function bearerToken(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  if (header === null) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

const PROBLEM_ID_REGEX = /^P-[A-Za-z0-9]{3,32}$/;

export function createMegaCommandsRouter(
  options: MegaCommandsRouterOptions,
): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  const movesProvider = options.movesProvider ?? new TruthfulProductionMovesProvider();

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

  // GET /v1/triage and GET /v1/triage.md
  app.get("/v1/triage", async (c) => {
    return handleTriage(c);
  });
  app.get("/v1/triage.md", async (c) => {
    return handleTriage(c, "md");
  });

  async function handleTriage(c: Context<{ Bindings: Env }>, forcedFormat?: "md" | "json") {
    const auth = await authenticateFellow(c.req.raw);
    if (auth instanceof Response) return auth;

    const env = (c.env ?? {}) as Partial<Env>;
    const db = options.db ?? env.DB;

    const hello = await buildHelloResponse({
      binding: auth,
      service: options.service,
      db,
      sponsorPromotionRateLimit:
        options.sponsorPromotionRateLimit ?? env.SPONSOR_PROMOTION_RATE_LIMIT,
    });

    const triageResult = await movesProvider.triageMove({
      fellowId: auth.fellowId,
      assignments: hello.assignments ?? [],
      db,
    });

    const response: TriageResponse = TriageResponseSchema.parse({
      hello,
      move: triageResult.move,
      degraded: triageResult.degraded,
      ...(triageResult.degradedReason ? { degraded_reason: triageResult.degradedReason } : {}),
      ...(triageResult.selectionBoundary
        ? { selection_boundary: triageResult.selectionBoundary }
        : {}),
    });

    const wantsMarkdown =
      forcedFormat === "md" ||
      c.req.path.endsWith(".md") ||
      (c.req.header("accept")?.includes("text/markdown") &&
        !c.req.header("accept")?.includes("application/json"));

    if (wantsMarkdown) {
      return new Response(renderTriageMarkdown(response), {
        status: 200,
        headers: {
          "content-type": "text/markdown; charset=utf-8",
          "cache-control": "private, no-store",
        },
      });
    }

    return c.json(response, 200, { "cache-control": "private, no-store" });
  }

  // GET /v1/p/:id/next and GET /v1/p/:id/next.md
  app.get("/v1/p/:id/next", async (c) => {
    return handleProblemNext(c);
  });
  app.get("/v1/p/:id/next.md", async (c) => {
    return handleProblemNext(c, "md");
  });

  async function handleProblemNext(c: Context<{ Bindings: Env }>, forcedFormat?: "md" | "json") {
    const auth = await authenticateFellow(c.req.raw);
    if (auth instanceof Response) return auth;

    const env = (c.env ?? {}) as Partial<Env>;
    const db = options.db ?? env.DB;

    let rawProblemId = c.req.param("id") ?? "";
    if (rawProblemId.endsWith(".md")) {
      rawProblemId = rawProblemId.slice(0, -3);
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

    let role: ProblemRole | "none" = "none";
    let admissionMode: ProblemAdmissionMode = "open";

    if (db !== undefined) {
      const problemRow = await db
        .prepare("SELECT id, admission_mode FROM problems WHERE id = ?")
        .bind(problemId)
        .first<{ id: string; admission_mode: string | null }>();

      if (!problemRow) {
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
      if (problemRow.admission_mode) {
        const parsed = ProblemAdmissionModeSchema.safeParse(problemRow.admission_mode);
        if (parsed.success) {
          admissionMode = parsed.data;
        }
      }

      const membershipRow = await db
        .prepare("SELECT role FROM problem_memberships WHERE problem_id = ? AND fellow_id = ?")
        .bind(problemId, auth.fellowId)
        .first<{ role: ProblemRole }>();

      if (membershipRow?.role) {
        role = membershipRow.role;
      }
    }

    const effectivePermissions = computeViewerPermissions({
      fellowStatus: auth.fellowStatus,
      role,
      admissionMode,
      problemBinding: auth.grantedResources.problemBinding,
      problemId,
    });

    const movesResult = await movesProvider.nextMoves({
      problemId,
      fellowId: auth.fellowId,
      role,
      effectivePermissions,
      db,
    });

    const response: ProblemNextResponse = ProblemNextResponseSchema.parse({
      problem_id: problemId,
      viewer: {
        role,
        effective_permissions: effectivePermissions,
      },
      primary_move: movesResult.primaryMove,
      alternatives: [...movesResult.alternatives],
      degraded: movesResult.degraded,
      ...(movesResult.degradedReason ? { degraded_reason: movesResult.degradedReason } : {}),
      ...(movesResult.selectionBoundary
        ? { selection_boundary: movesResult.selectionBoundary }
        : {}),
    });

    const wantsMarkdown =
      forcedFormat === "md" ||
      c.req.path.endsWith(".md") ||
      (c.req.header("accept")?.includes("text/markdown") &&
        !c.req.header("accept")?.includes("application/json"));

    if (wantsMarkdown) {
      return new Response(renderProblemNextMarkdown(response), {
        status: 200,
        headers: {
          "content-type": "text/markdown; charset=utf-8",
          "cache-control": "private, no-store",
        },
      });
    }

    return c.json(response, 200, { "cache-control": "private, no-store" });
  }

  return app;
}
