import {
  ProblemAdmissionModeSchema,
  ProblemDetailSchema,
  ProblemLifecycleActionRequestSchema,
  ProblemStatementProposalIdSchema,
  ProblemStatementProposalListQuerySchema,
  ProblemStatementProposalRequestSchema,
  ProposeProblemRequestSchema,
  SaveProblemBriefRequestSchema,
  SponsorProblemBriefListResponseSchema,
  SponsorProblemGovernanceQuerySchema,
  SponsorProblemListResponseSchema,
  WithdrawProblemBriefRequestSchema,
} from "@asimposium/contracts";
import type { D1PreparedStatement } from "@cloudflare/workers-types";
import { type Handler, Hono } from "hono";
import { parseExactJsonBytes, readBoundedRequestBody } from "../auth/http";
import { createCommentaryRouter } from "../commentary/router.ts";
import { createDirectiveDisclosureRouter } from "../directives/disclosure-router.ts";
import { createDirectiveRouter } from "../directives/router.ts";
import type { EnrollmentService, FellowCredentialBinding } from "../enrollment/service";
import { fellowCanAccessPrivateProblem } from "../enrollment/service";
import type { Env } from "../env";
import { validatedProblem } from "../http/envelope";
import { hardDeletePrivateDraft, RetentionError } from "../krater/retention";
import { readPublishedProblemFormulation } from "../ledger/problem-formulation-read.ts";
import { readPublishedProblemResolution } from "../ledger/problem-resolution-read.ts";
import { type PublicCandidateScreener, screenPublicCandidate } from "../screening/public-candidate";
import { screenPromotionWithWorkersAI, type WorkersAiBinding } from "../screening/workers-ai";
import { parseSponsorLimit } from "../sessions/quota";
import {
  applyPrivateProblemAccessAction,
  isProblemAccessAction,
  replayPrivateProblemAccessAction,
} from "./access-actions.ts";
import { problemBoundaryFields, type StoredProblemBoundaries } from "./boundaries.ts";
import { privateBriefResponse, runSponsorBriefCommand } from "./brief-commands.ts";
import { createFellowBriefRouter } from "./fellow-briefs.ts";
import {
  privateProblemGovernanceResponse,
  readSponsorProblemGovernance,
} from "./governance-read.ts";
import {
  applyPublicProblemGovernance,
  governanceTargetRefusal,
  problemGovernanceRefused,
} from "./lifecycle-ledger";
import { runProblemProposalCommand } from "./proposal-commands.ts";
import { readProblemPublicationPreview } from "./publication-preview.ts";
import {
  acceptPrivateStatementProposal,
  listStatementProposals,
  loadStatementRevisionSnapshot,
  privateStatementResponse,
  readOwnStatementProposal,
  replayPrivateStatementAcceptance,
  statementProposalAbsent,
  submitStatementProposal,
} from "./statement-revision-proposals.ts";

export interface ProblemRouterOptions {
  readonly service: EnrollmentService;
  /** P7 screening seam; production uses the Worker's AI binding. */
  readonly screenPromotion?: PublicCandidateScreener;
  readonly verifiedSponsor: (
    request: Request,
    route: string,
    action: string,
  ) => Promise<
    | {
        readonly principal: { readonly type: "sponsor"; readonly sponsorId: string };
        readonly rawBody: Uint8Array;
      }
    | Response
  >;
}

function bearerToken(request: Request): string | undefined {
  const auth = request.headers.get("authorization");
  if (!auth) return undefined;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : undefined;
}

// Match Fellow session ingress while admitting large, escaped formulations.
const MAX_PROBLEM_REQUEST_BODY_BYTES = 512 * 1024;

async function readJsonBody(request: Request): Promise<unknown> {
  const body = await readBoundedRequestBody(request, MAX_PROBLEM_REQUEST_BODY_BYTES);
  if (!body.ok) {
    if (body.reason !== "too-large") return undefined;
    return validatedProblem({
      status: 413,
      code: "REQUEST_BODY_TOO_LARGE",
      title: "The problem request body is too large",
      detail: `Problem write bodies are bounded at ${MAX_PROBLEM_REQUEST_BODY_BYTES} bytes.`,
      fixHint: "Send only the contracted fields and keep large artifacts in the artifact store.",
    });
  }
  try {
    return parseExactJsonBytes(body.bytes);
  } catch {
    return undefined;
  }
}

export function createProblemRouter(options: ProblemRouterOptions): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/", createFellowBriefRouter({ service: options.service }));
  const screenPromotion: PublicCandidateScreener =
    options.screenPromotion ??
    ((input, env) =>
      screenPromotionWithWorkersAI(env.AI as unknown as WorkersAiBinding | undefined, input));
  app.route("/", createDirectiveRouter({ verifiedSponsor: options.verifiedSponsor }));
  app.route(
    "/",
    createDirectiveDisclosureRouter({
      verifiedSponsor: options.verifiedSponsor,
      sponsorLimit: (env) => parseSponsorLimit(env.SPONSOR_PROMOTION_RATE_LIMIT),
      screen: (publication, env) =>
        screenPublicCandidate(
          screenPromotion,
          env,
          {
            problemId: publication.target.problem_id,
            fellowId: publication.fellow_id,
            kind: "directive-disclosure",
            // All caller-authored public prose is screened. Server timestamps stay
            // outside the candidate so an unchanged held disclosure can be released.
            statement: JSON.stringify(publication.disclosures),
            falsifier: null,
          },
          {
            sponsorId: publication.sponsor_id,
            route: "directive-disclosure",
            authorKind: "sponsor",
          },
        ),
    }),
  );
  app.route("/", createCommentaryRouter({ verifiedSponsor: options.verifiedSponsor }));
  // This router is fetched as a nested app; its own error boundary runs
  // before the outer Worker's handler. Never return raw D1 exception text.
  app.onError((err) => {
    console.error("PROBLEM_ROUTER_ERROR:", err);
    return validatedProblem({
      status: 500,
      code: "INTERNAL_ERROR",
      title: "The Worker failed to handle this request",
      detail: "An unexpected error occurred. Its details are not disclosed on this face.",
      fixHint:
        "Retry the request with the same Idempotency-Key. If it persists, report the route and time.",
      headers: { "cache-control": "private, no-store" },
    });
  });

  async function authenticateFellow(
    request: Request,
  ): Promise<
    | { readonly ok: true; readonly binding: FellowCredentialBinding }
    | { readonly ok: false; readonly response: Response }
  > {
    const token = bearerToken(request);
    if (!token) {
      return {
        ok: false,
        response: validatedProblem({
          status: 401,
          code: "FELLOW_TOKEN_INVALID",
          title: "Fellow bearer token required",
          detail: "This endpoint requires an active Fellow bearer token.",
          fixHint: "Provide an Authorization: Bearer asimp_ag_... header.",
        }),
      };
    }
    let binding: FellowCredentialBinding | undefined;
    try {
      binding = await options.service.credentialBinding(token);
    } catch {
      return {
        ok: false,
        response: validatedProblem({
          status: 401,
          code: "FELLOW_TOKEN_INVALID",
          title: "Fellow bearer token invalid",
          detail: "The provided bearer token could not be verified.",
          fixHint: "Obtain a valid token from enrollment.",
        }),
      };
    }
    if (binding?.fellowStatus !== "active" || binding.revokedAt !== undefined) {
      return {
        ok: false,
        response: validatedProblem({
          status: 401,
          code: "FELLOW_TOKEN_INVALID",
          title: "Fellow bearer token invalid or revoked",
          detail: "The provided bearer token is invalid or no longer active.",
          fixHint: "Obtain an active token from enrollment.",
        }),
      };
    }
    return { ok: true, binding };
  }

  // --- POST /v1/problems (Fellow problem proposal) -------------------------
  app.post("/v1/problems", async (c) => {
    const auth = await authenticateFellow(c.req.raw);
    if (!auth.ok) return auth.response;
    const db = c.env.DB;

    const rawBody = await readJsonBody(c.req.raw);
    if (rawBody instanceof Response) return rawBody;
    const parsed = ProposeProblemRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return validatedProblem({
        status: 422,
        code: "PROBLEM_PROPOSE_BODY_INVALID",
        title: "Invalid problem proposal request body",
        detail: "The request body did not match the problem proposal contract.",
        fixHint:
          "Provide title, statement, falsifier, motivation, and 1–32 areas from GET /areas.json or named other-* areas. Supply scope, out_of_scope and success_criteria together when recording research boundaries. Brief adoption also requires brief_id and expected_brief_version from the current intent read.",
        rule: "P3",
        extensions: {
          schema: "https://a.asimposium.org/schemas/problems.v1.json",
          example: {
            title: "Riemann Hypothesis Investigation",
            statement: "All non-trivial zeros of the zeta function have real part 1/2.",
            falsifier: "A zero off the critical line.",
            motivation: "Determines the precise distribution of prime numbers.",
            areas: ["number-theory"],
          },
        },
      });
    }

    return runProblemProposalCommand(
      db,
      auth.binding,
      c.req.header("Idempotency-Key") ?? null,
      parsed.data,
    );
  });

  app.post("/v1/problems/:id/statement-proposals", async (c) => {
    const auth = await authenticateFellow(c.req.raw);
    if (!auth.ok) return privateStatementResponse(auth.response);
    const raw = await readJsonBody(c.req.raw);
    if (raw instanceof Response) return privateStatementResponse(raw);
    const parsed = ProblemStatementProposalRequestSchema.safeParse(raw);
    if (!parsed.success)
      return privateStatementResponse(
        validatedProblem({
          status: 422,
          code: "SCHEMA_INVALID",
          title: "Invalid statement proposal",
          detail:
            "A proposal requires your owned session, exact base statement version and complete replacement formulation.",
          fixHint:
            "Submit session_id, base_statement_version, statement, falsifier and motivation. Supply all three boundary fields together. Submission hands this exact proposal to current stewards for review; it does not publish it.",
          rule: "P3",
          extensions: {
            schema: "https://a.asimposium.org/schemas/problems.v1.json",
            example: {
              session_id: "SESSION",
              base_statement_version: 1,
              statement: "For every finite tree, |E| = |V| - 1.",
              falsifier: "A finite tree with a different edge count.",
              motivation: "Establish a precise invariant.",
            },
          },
        }),
      );
    return submitStatementProposal(
      c.env.DB,
      auth.binding,
      c.req.param("id"),
      parsed.data,
      c.req.header("Idempotency-Key") ?? null,
    );
  });

  app.get("/v1/problems/:id/statement-proposals/:proposalId", async (c) => {
    const auth = await authenticateFellow(c.req.raw);
    if (!auth.ok) return privateStatementResponse(auth.response);
    if (!ProblemStatementProposalIdSchema.safeParse(c.req.param("proposalId")).success)
      return statementProposalAbsent();
    return readOwnStatementProposal(
      c.env.DB,
      auth.binding,
      c.req.param("id"),
      c.req.param("proposalId"),
    );
  });

  app.get("/v1/sponsors/problems/:id/statement-proposals", async (c) => {
    const verified = await options.verifiedSponsor(
      c.req.raw,
      c.req.path,
      "problem-statement-proposals",
    );
    if (verified instanceof Response) return privateStatementResponse(verified);
    const query = ProblemStatementProposalListQuerySchema.safeParse(c.req.query());
    if (!query.success)
      return privateStatementResponse(
        validatedProblem({
          status: 400,
          code: "SCHEMA_INVALID",
          title: "Invalid proposal page cursor",
          detail: "Statement proposals use the exact after cursor returned by the prior page.",
          fixHint: "Omit the query for the first page, or pass its next_after value as after.",
          rule: "A5",
          extensions: { schema: "https://a.asimposium.org/schemas/problems.v1.json", example: {} },
        }),
      );
    return listStatementProposals(
      c.env.DB,
      c.req.param("id"),
      verified.principal.sponsorId,
      query.data.after,
    );
  });

  app.get("/v1/sponsors/problems/:id/statement-proposals/:proposalId", async (c) => {
    const verified = await options.verifiedSponsor(
      c.req.raw,
      c.req.path,
      "problem-statement-proposal-preview",
    );
    if (verified instanceof Response) return privateStatementResponse(verified);
    if (
      new URL(c.req.url).search !== "" ||
      !ProblemStatementProposalIdSchema.safeParse(c.req.param("proposalId")).success
    )
      return statementProposalAbsent();
    const snapshot = await loadStatementRevisionSnapshot(
      c.env.DB,
      c.req.param("id"),
      c.req.param("proposalId"),
      verified.principal.sponsorId,
    );
    return snapshot
      ? privateStatementResponse(c.json(snapshot.preview))
      : statementProposalAbsent();
  });

  app.get("/v1/sponsors/problems/:id/statement-proposals/after/:after", async (c) => {
    const verified = await options.verifiedSponsor(
      c.req.raw,
      c.req.path,
      "problem-statement-proposals",
    );
    if (verified instanceof Response) return privateStatementResponse(verified);
    const query = ProblemStatementProposalListQuerySchema.safeParse({
      after: c.req.param("after"),
    });
    if (!query.success || new URL(c.req.url).search !== "") return statementProposalAbsent();
    return listStatementProposals(
      c.env.DB,
      c.req.param("id"),
      verified.principal.sponsorId,
      query.data.after,
    );
  });

  // --- GET /v1/problems/:id (Problem Detail) -------------------------------
  app.get("/v1/problems/:id", async (c) => {
    const db = c.env.DB;
    const problemId = c.req.param("id");

    const problem = await db.prepare("SELECT * FROM problems WHERE id = ?").bind(problemId).first<{
      id: string;
      public_seq: number;
      status: string;
      unlisted: number;
      sponsor_id: string | null;
      created_by_fellow_id: string | null;
      title: string;
      current_statement_version: number;
      resolution_direction: string | null;
      resolution_summary: string | null;
      resolution_no_claim_boundary: string | null;
      famous_guardrail: string | null;
      areas: string;
      admission_mode: string | null;
      canonical_problem_id: string | null;
      forked_from_problem_id: string | null;
      forked_from_cursor: number | null;
      writer_cap: number | null;
      created_at: string;
      updated_at: string;
    }>();

    if (!problem) {
      return validatedProblem({
        status: 404,
        code: "PROBLEM_NOT_FOUND",
        title: "Problem not found",
        detail: `No problem with id '${problemId}' exists.`,
        fixHint: "Check the id against GET /problems.json.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/problem.v1.json",
          example: { method: "GET", path: "/problems.json" },
        },
      });
    }

    // A Fellow may read its own draft or an explicit owner-issued problem grant.
    if (problem.status === "private-draft") {
      const token = bearerToken(c.req.raw);
      let allowed = false;
      if (token) {
        try {
          const binding = await options.service.credentialBinding(token);
          if (
            binding &&
            fellowCanAccessPrivateProblem(
              binding,
              {
                id: problem.id,
                sponsorId: problem.sponsor_id,
                creatorFellowId: problem.created_by_fellow_id,
              },
              Date.now(),
            )
          ) {
            allowed = true;
          }
        } catch {
          allowed = false;
        }
      }
      if (!allowed) {
        return validatedProblem({
          status: 404,
          code: "PROBLEM_NOT_FOUND",
          title: "Problem not found",
          detail: `No public problem with id '${problemId}' exists.`,
          fixHint: "Check the id against GET /problems.json.",
          rule: "A5",
          extensions: {
            schema: "https://a.asimposium.org/schemas/problem.v1.json",
            example: { method: "GET", path: "/problems.json" },
          },
        });
      }
    }

    // Public recovery reads use the same committed formulation as agent packs.
    // Private drafts remain available only through the grant check above.
    const publicFormulation =
      problem.status === "private-draft"
        ? undefined
        : await readPublishedProblemFormulation(db, problemId, problem.public_seq);
    if (
      problem.status !== "private-draft" &&
      (publicFormulation === undefined ||
        publicFormulation.problem.current_statement_version !== problem.current_statement_version)
    ) {
      return validatedProblem({
        status: 404,
        code: "PROBLEM_NOT_FOUND",
        title: "Problem not found",
        detail: "No available public formulation exists for this problem.",
        fixHint: "Check the id against GET /problems.json and retry after availability changes.",
        rule: "A5",
        headers: { "cache-control": "private, no-store" },
        extensions: {
          schema: "https://a.asimposium.org/schemas/problem.v1.json",
          example: { method: "GET", path: "/problems.json" },
        },
      });
    }

    if (problem.canonical_problem_id && c.req.query("redirect") !== "false") {
      return c.redirect(`/v1/problems/${problem.canonical_problem_id}`, 308);
    }

    const statementRow =
      problem.status === "private-draft"
        ? await db
            .prepare(
              "SELECT statement, falsifier, motivation, scope, out_of_scope, success_criteria FROM problem_statement_versions WHERE problem_id = ? AND version = ?",
            )
            .bind(problemId, problem.current_statement_version)
            .first<
              StoredProblemBoundaries & { statement: string; falsifier: string; motivation: string }
            >()
        : publicFormulation?.problem;

    const famousGuardrail = problem.famous_guardrail
      ? JSON.parse(problem.famous_guardrail)
      : undefined;

    const resolution =
      problem.status === "resolved"
        ? await readPublishedProblemResolution(db, problemId, problem.public_seq)
        : undefined;

    const stewardsRows = await db
      .prepare(
        "SELECT sponsor_id FROM problem_stewards WHERE problem_id = ? ORDER BY created_at ASC",
      )
      .bind(problemId)
      .all<{ sponsor_id: string }>();
    const stewards = (stewardsRows.results ?? []).map((r) => r.sponsor_id);

    return c.json(
      {
        problem: {
          id: problem.id,
          title: publicFormulation?.problem.title ?? (problem.title || problem.id),
          status: problem.status,
          unlisted: problem.unlisted === 1,
          sponsor_id: problem.sponsor_id ?? undefined,
          created_by_fellow_id: problem.created_by_fellow_id ?? undefined,
          current_statement_version:
            publicFormulation?.problem.current_statement_version ??
            problem.current_statement_version,
          public_seq: problem.public_seq,
          screening_notice: publicFormulation?.screening_notice,
          statement: statementRow?.statement ?? "",
          falsifier: statementRow?.falsifier ?? "",
          motivation: statementRow?.motivation ?? "",
          ...problemBoundaryFields(statementRow),
          areas: ProblemDetailSchema.shape.areas.parse(JSON.parse(problem.areas)),
          famous_guardrail: famousGuardrail,
          resolution,
          admission_mode:
            ProblemAdmissionModeSchema.safeParse(problem.admission_mode).data ?? "open",
          canonical_problem_id: problem.canonical_problem_id ?? undefined,
          forked_from_problem_id: problem.forked_from_problem_id ?? undefined,
          forked_from_cursor: problem.forked_from_cursor ?? undefined,
          writer_cap: problem.writer_cap ?? undefined,
          stewards:
            stewards.length > 0 ? stewards : problem.sponsor_id ? [problem.sponsor_id] : undefined,
          created_at: problem.created_at,
          updated_at: problem.updated_at,
        },
      },
      200,
      {
        "cache-control":
          problem.status === "private-draft" ? "private, no-store" : "public, max-age=60",
        ...(problem.unlisted === 1 || problem.status === "private-draft"
          ? { "x-robots-tag": "noindex, nofollow" }
          : {}),
      },
    );
  });

  // --- POST /v1/sponsors/problem-briefs (Save Sponsor Problem Brief) --------
  app.post("/v1/sponsors/problem-briefs", async (c) => {
    const verified = await options.verifiedSponsor(
      c.req.raw,
      "/v1/sponsors/problem-briefs",
      "save-problem-brief",
    );
    if (verified instanceof Response) return privateBriefResponse(verified);

    let rawJson: unknown;
    try {
      rawJson = JSON.parse(new TextDecoder().decode(verified.rawBody));
    } catch {
      rawJson = undefined;
    }

    const parsed = SaveProblemBriefRequestSchema.safeParse(rawJson);
    if (!parsed.success) {
      return privateBriefResponse(
        validatedProblem({
          status: 422,
          code: "PROBLEM_BRIEF_BODY_INVALID",
          title: "Invalid problem brief request body",
          detail: "The request body did not match the save problem brief contract.",
          fixHint:
            "Provide title, statement, falsifier, motivation, and areas. Editing also needs id and expected_version from the current brief. Supply scope, out_of_scope and success_criteria together; an existing bundle cannot be omitted on update.",
          rule: "A5",
          extensions: {
            schema: "https://a.asimposium.org/schemas/problems.v1.json",
            example: {
              title: "Riemann Hypothesis Brief",
              statement: "All non-trivial zeros have real part 1/2.",
              falsifier: "A zero off the line.",
              motivation: "Prime distribution.",
              areas: ["number-theory"],
            },
          },
        }),
      );
    }

    return runSponsorBriefCommand(
      c.env.DB,
      verified.principal.sponsorId,
      c.req.header("idempotency-key") ?? null,
      { operation: "save", request: parsed.data },
    );
  });

  // --- GET /v1/sponsors/problem-briefs (List Sponsor Problem Briefs) ---------
  app.get("/v1/sponsors/problem-briefs", async (c) => {
    const verified = await options.verifiedSponsor(
      c.req.raw,
      "/v1/sponsors/problem-briefs",
      "list-problem-briefs",
    );
    if (verified instanceof Response) return verified;
    const sponsor = verified.principal;
    const db = c.env.DB;

    const rows = await db
      .prepare(
        `SELECT * FROM sponsor_problem_briefs b WHERE sponsor_id = ? AND status = 'active'
         AND EXISTS (SELECT 1 FROM sponsors s WHERE s.sponsor_id = b.sponsor_id AND s.tombstoned_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM sponsor_suspension_events WHERE sponsor_id = b.sponsor_id)
         ORDER BY updated_at DESC, id`,
      )
      .bind(sponsor.sponsorId)
      .all<
        StoredProblemBoundaries & {
          id: string;
          sponsor_id: string;
          version: number;
          assigned_fellow_id: string | null;
          title: string;
          statement: string;
          falsifier: string;
          motivation: string;
          areas: string;
          famous_guardrail: string | null;
          status: string;
          created_at: string;
          updated_at: string;
        }
      >();

    const briefs = rows.results.map((r) => ({
      id: r.id,
      sponsor_id: r.sponsor_id,
      version: r.version,
      assigned_fellow_id: r.assigned_fellow_id ?? undefined,
      title: r.title,
      statement: r.statement,
      falsifier: r.falsifier,
      motivation: r.motivation,
      ...problemBoundaryFields(r),
      areas: JSON.parse(r.areas),
      famous_guardrail: r.famous_guardrail ? JSON.parse(r.famous_guardrail) : undefined,
      status: r.status,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));

    return c.json(SponsorProblemBriefListResponseSchema.parse({ briefs }), 200, {
      "cache-control": "private, no-store",
    });
  });

  // --- GET /v1/sponsors/problems ---------------------------------------------
  // The sponsor's owned or stewarded problems, including private drafts,
  // so the console can offer the lifecycle gate. Private; never a public face.
  app.get("/v1/sponsors/problems", async (c) => {
    const verified = await options.verifiedSponsor(
      c.req.raw,
      "/v1/sponsors/problems",
      "list-sponsor-problems",
    );
    if (verified instanceof Response) return verified;
    const rows = await c.env.DB.prepare(
      `SELECT id, title, status, unlisted, created_by_fellow_id, current_statement_version,
              created_at, updated_at
         FROM problems p WHERE (sponsor_id = ? OR EXISTS (
           SELECT 1 FROM problem_stewards WHERE problem_id = p.id AND sponsor_id = ?))
           AND NOT EXISTS (SELECT 1 FROM private_draft_erasures WHERE problem_id = p.id)
           AND EXISTS (SELECT 1 FROM sponsors WHERE sponsor_id = ? AND tombstoned_at IS NULL)
           AND NOT EXISTS (SELECT 1 FROM sponsor_suspension_events WHERE sponsor_id = ?)
         ORDER BY updated_at DESC, id LIMIT 500`,
    )
      .bind(
        verified.principal.sponsorId,
        verified.principal.sponsorId,
        verified.principal.sponsorId,
        verified.principal.sponsorId,
      )
      .all<{
        id: string;
        title: string;
        status: string;
        unlisted: number;
        created_by_fellow_id: string | null;
        current_statement_version: number;
        created_at: string;
        updated_at: string;
      }>();
    const problems = (rows.results ?? []).map((row) => ({
      ...row,
      unlisted: row.unlisted === 1,
    }));
    return c.json(SponsorProblemListResponseSchema.parse({ problems }), 200, {
      "cache-control": "private, no-store",
    });
  });

  // --- POST /v1/sponsors/problem-briefs/:id/withdraw ------------------------
  app.post("/v1/sponsors/problem-briefs/:id/withdraw", async (c) => {
    const briefId = c.req.param("id");
    const verified = await options.verifiedSponsor(c.req.raw, c.req.path, "withdraw-problem-brief");
    if (verified instanceof Response) return privateBriefResponse(verified);
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(verified.rawBody));
    } catch {
      raw = undefined;
    }
    const parsed = WithdrawProblemBriefRequestSchema.safeParse(raw);
    if (!parsed.success)
      return privateBriefResponse(
        validatedProblem({
          status: 422,
          code: "PROBLEM_BRIEF_BODY_INVALID",
          title: "A reviewed brief version is required",
          detail: "Withdrawal must identify the current version of an active private brief.",
          fixHint:
            "Read the sponsor brief list, then send its expected_version with a stable Idempotency-Key.",
          rule: "A5",
          extensions: {
            schema:
              "https://a.asimposium.org/schemas/problems.v1.json#/properties/withdraw_brief_request",
            example: { expected_version: 1 },
          },
        }),
      );
    return runSponsorBriefCommand(
      c.env.DB,
      verified.principal.sponsorId,
      c.req.header("idempotency-key") ?? null,
      { operation: "withdraw", id: briefId, request: parsed.data },
    );
  });

  // A private draft must be readable by its accountable sponsor before the
  // sponsor can authorize any bytes to cross into the permanent public ledger.
  app.get("/v1/sponsors/problems/:id/publication-preview", async (c) => {
    const privateResponse = (response: Response): Response => {
      const headers = new Headers(response.headers);
      headers.set("cache-control", "private, no-store");
      headers.set("x-robots-tag", "noindex, nofollow");
      headers.set("referrer-policy", "no-referrer");
      return new Response(response.body, { status: response.status, headers });
    };
    const verified = await options.verifiedSponsor(
      c.req.raw,
      c.req.path,
      "problem-publication-preview",
    );
    if (verified instanceof Response) return privateResponse(verified);
    if (new URL(c.req.url).search !== "") {
      return privateResponse(
        validatedProblem({
          status: 400,
          code: "SCHEMA_INVALID",
          title: "Publication preview query is not supported",
          detail: "Publication previews always describe the current private draft.",
          fixHint: "Use this signed GET path without query parameters.",
          rule: "A5",
          extensions: { schema: "https://a.asimposium.org/schemas/problems.v1.json", example: {} },
        }),
      );
    }
    const preview = await readProblemPublicationPreview(
      c.env.DB,
      c.req.param("id") ?? "",
      verified.principal.sponsorId,
    );
    if (!preview)
      return privateResponse(
        validatedProblem({
          status: 404,
          code: "PROBLEM_NOT_FOUND",
          title: "Private publication preview unavailable",
          detail: "No publishable private draft is available under this sponsor's authority.",
          fixHint:
            "Refresh your sponsor problem list. Already published problems use their public read face.",
          rule: "A5",
          extensions: {
            schema: "https://a.asimposium.org/schemas/problems.v1.json",
            example: { method: "GET", path: "/v1/sponsors/problems" },
          },
        }),
      );
    return privateResponse(c.json(preview));
  });

  const readGovernance: Handler<{ Bindings: Env }> = async (c) => {
    const verified = await options.verifiedSponsor(
      c.req.raw,
      c.req.path,
      "problem-governance-read",
    );
    if (verified instanceof Response) return privateProblemGovernanceResponse(verified);
    const parsed = SponsorProblemGovernanceQuerySchema.safeParse({
      after: c.req.param("cursor"),
      steward_after: c.req.param("stewardCursor"),
    });
    if (!parsed.success || new URL(c.req.url).search !== "") {
      return privateProblemGovernanceResponse(
        validatedProblem({
          status: 400,
          code: "SCHEMA_INVALID",
          title: "Invalid governance member page",
          detail:
            "The signed route identifies the exact member page. Query parameters are not accepted.",
          fixHint:
            "Read the base governance path, append /after/ and the next_after Fellow id, or /stewards/after/ and the stewardship next_after sponsor id.",
          rule: "A5",
          extensions: { schema: "https://a.asimposium.org/schemas/problems.v1.json", example: {} },
        }),
      );
    }
    const state = await readSponsorProblemGovernance(
      c.env.DB,
      c.req.param("id") ?? "",
      verified.principal.sponsorId,
      parsed.data,
    );
    if (!state)
      return privateProblemGovernanceResponse(
        validatedProblem({
          status: 404,
          code: "PROBLEM_NOT_FOUND",
          title: "Problem governance unavailable",
          detail: "No current problem workspace is available under this sponsor's authority.",
          fixHint: "Refresh your sponsor problem list.",
          rule: "A5",
          extensions: {
            schema: "https://a.asimposium.org/schemas/problems.v1.json",
            example: { method: "GET", path: "/v1/sponsors/problems" },
          },
        }),
      );
    return privateProblemGovernanceResponse(c.json(state));
  };
  app.get("/v1/sponsors/problems/:id/governance", readGovernance);
  app.get("/v1/sponsors/problems/:id/governance/after/:cursor", readGovernance);
  app.get("/v1/sponsors/problems/:id/governance/stewards/after/:stewardCursor", readGovernance);
  app.get(
    "/v1/sponsors/problems/:id/governance/after/:cursor/stewards/after/:stewardCursor",
    readGovernance,
  );

  // --- POST /v1/sponsors/problems/:id/lifecycle ----------------------------
  app.post("/v1/sponsors/problems/:id/lifecycle", async (c) => {
    const problemId = c.req.param("id");
    const verified = await options.verifiedSponsor(c.req.raw, c.req.path, "problem-lifecycle");
    if (verified instanceof Response) return verified;
    const sponsor = verified.principal;
    const db = c.env.DB;

    const problem = await db.prepare("SELECT * FROM problems WHERE id = ?").bind(problemId).first<{
      id: string;
      public_seq: number;
      status: string;
      unlisted: number;
      sponsor_id: string | null;
      created_by_fellow_id: string | null;
      title: string;
      current_statement_version: number;
      resolution_direction: string | null;
      resolution_summary: string | null;
      resolution_no_claim_boundary: string | null;
      famous_guardrail: string | null;
      areas: string;
    }>();

    if (!problem) {
      return validatedProblem({
        status: 404,
        code: "PROBLEM_NOT_FOUND",
        title: "Problem not found",
        detail: `No problem with id '${problemId}' exists.`,
        fixHint: "Check the id against GET /problems.json.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/problem.v1.json",
          example: { method: "GET", path: "/problems.json" },
        },
      });
    }

    // Steward authority check: creator sponsor or active steward in problem_stewards
    const isSteward =
      problem.sponsor_id === sponsor.sponsorId ||
      !!(await db
        .prepare("SELECT 1 FROM problem_stewards WHERE problem_id = ? AND sponsor_id = ?")
        .bind(problemId, sponsor.sponsorId)
        .first());

    let rawJson: unknown;
    try {
      rawJson = JSON.parse(new TextDecoder().decode(verified.rawBody));
    } catch {
      rawJson = undefined;
    }

    const parsed = ProblemLifecycleActionRequestSchema.safeParse(rawJson);
    if (!parsed.success) {
      return validatedProblem({
        status: 422,
        code: "PROBLEM_LIFECYCLE_BODY_INVALID",
        title: "Invalid problem lifecycle request body",
        detail: "The request body did not match the problem lifecycle action contract.",
        fixHint:
          "Specify a valid lifecycle action: publish, revise-statement, enter-result-review, resolve, retire, set-admission-mode, manage-steward, manage-member, set-writer-cap, merge, or fork.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/problems.v1.json",
          example: {
            action: "publish",
            reviewed_statement_version: 1,
            reviewed_digest: "0".repeat(64),
          },
        },
      });
    }

    const action = parsed.data;
    const now = new Date().toISOString();

    if (action.action === "revise-statement") {
      const previous = await replayPrivateStatementAcceptance(
        db,
        problemId,
        sponsor.sponsorId,
        action,
        c.req.header("Idempotency-Key") ?? null,
      );
      if (previous) return previous;
      if (problem.status === "private-draft")
        return acceptPrivateStatementProposal(
          db,
          problemId,
          sponsor.sponsorId,
          action,
          c.req.header("Idempotency-Key") ?? null,
        );
    }

    if (isProblemAccessAction(action)) {
      const previous = await replayPrivateProblemAccessAction(
        db,
        problemId,
        sponsor.sponsorId,
        action,
        c.req.raw,
      );
      if (previous) return previous;
      // An exact stewardship receipt is private to its original actor, even
      // when the accepted transfer/removal ended that actor's authority. The
      // receipt recovers only the command, never current workspace content.
      if (action.action === "manage-steward" && problem.status !== "private-draft") {
        return privateProblemGovernanceResponse(
          await applyPublicProblemGovernance(db, problem, sponsor.sponsorId, action, c.req.raw),
        );
      }
      if (!isSteward) return privateProblemGovernanceResponse(problemGovernanceRefused());
      if (problem.status === "private-draft") {
        const targetRefused = await governanceTargetRefusal(db, action, sponsor.sponsorId);
        if (targetRefused) {
          const winner = await replayPrivateProblemAccessAction(
            db,
            problemId,
            sponsor.sponsorId,
            action,
            c.req.raw,
          );
          return winner ?? privateProblemGovernanceResponse(targetRefused);
        }
        return applyPrivateProblemAccessAction(db, problemId, sponsor.sponsorId, action, c.req.raw);
      }
    }
    if (!isSteward && action.action !== "revise-statement") return problemGovernanceRefused();

    if (
      problem.status === "private-draft" &&
      action.action !== "publish" &&
      action.action !== "resolve"
    ) {
      const targetRefused = await governanceTargetRefusal(db, action, sponsor.sponsorId);
      if (targetRefused) return targetRefused;
      // ism6: the draft branch was chosen on a status read before this write.
      // Every draft write is one batch led by this guard, and every statement
      // after it repeats the draft condition, so a publish that commits first
      // leaves the batch changing nothing; the request then refuses instead of
      // changing a public problem's governance without an event.
      const draftGuard = db
        .prepare("UPDATE problems SET updated_at = ? WHERE id = ? AND status = 'private-draft'")
        .bind(now, problemId);
      const draftWrite = async (
        statements: D1PreparedStatement[],
        guard = draftGuard,
      ): Promise<Response | null> => {
        const results = await db.batch([guard, ...statements]);
        // >= 1: D1 can count rows a trigger writes into a statement's changes.
        if ((results[0]?.meta.changes ?? 0) >= 1) return null;
        return validatedProblem({
          status: 409,
          code: "OBJECT_VERSION_CONFLICT",
          title: "The private problem draft changed",
          detail:
            "The problem was published or its formulation changed while this draft action was in flight; nothing changed.",
          fixHint: "Read the current problem again and submit the appropriate lifecycle action.",
          rule: "A5",
          extensions: {
            schema: "https://a.asimposium.org/schemas/problems.v1.json",
            example: { action: "set-writer-cap", writer_cap: 4 },
          },
        });
      };
      if (action.action === "set-writer-cap") {
        const refused = await draftWrite([
          db
            .prepare(
              "UPDATE problems SET writer_cap = ?, updated_at = ? WHERE id = ? AND status = 'private-draft'",
            )
            .bind(action.writer_cap, now, problemId),
        ]);
        if (refused) return refused;
        return c.json(
          { problem: { id: problemId, writer_cap: action.writer_cap, updated_at: now } },
          200,
          { "cache-control": "private, no-store" },
        );
      }
    }

    // P7 applies to all public lifecycle prose, including sponsor governance.
    // The ledger writer performs replay, authority and scientific admission
    // checks before invoking this paid boundary or committing public state.
    const screening =
      action.action === "publish" ||
      action.action === "revise-statement" ||
      action.action === "resolve" ||
      action.action === "retire" ||
      action.action === "merge"
        ? {
            sponsorLimit: parseSponsorLimit(c.env.SPONSOR_PROMOTION_RATE_LIMIT),
            screen: async (
              revision?: import("@asimposium/contracts").ProblemStatementProposal,
              publication?: import("@asimposium/contracts").ProblemPublicationPreview,
            ) => {
              if (
                action.action === "resolve" ||
                action.action === "retire" ||
                action.action === "merge"
              ) {
                return screenPublicCandidate(
                  screenPromotion,
                  c.env,
                  {
                    problemId,
                    fellowId: problem.created_by_fellow_id ?? sponsor.sponsorId,
                    kind: "problem-lifecycle",
                    // Include every nested field and mapping key; screen exactly
                    // the immutable parsed action the governance writer will use.
                    statement: JSON.stringify(action),
                    falsifier: null,
                  },
                  {
                    sponsorId: sponsor.sponsorId,
                    route: `problem-${action.action}`,
                    authorKind: "sponsor",
                  },
                );
              }
              let candidate: StoredProblemBoundaries & {
                statement: string;
                falsifier: string | null;
                motivation: string | null;
              };
              if (action.action === "revise-statement") {
                if (revision === undefined) return problemGovernanceRefused();
                candidate = {
                  statement: revision.statement,
                  falsifier: revision.falsifier,
                  motivation: revision.motivation,
                  ...problemBoundaryFields(revision),
                };
              } else {
                if (!publication) return problemGovernanceRefused();
                candidate = publication.problem;
              }
              const screened = await screenPublicCandidate(
                screenPromotion,
                c.env,
                {
                  problemId,
                  fellowId:
                    revision?.author.fellow_id ??
                    publication?.author.fellow_id ??
                    problem.created_by_fellow_id ??
                    sponsor.sponsorId,
                  kind:
                    action.action === "publish" ? "problem-proposal" : "problem-statement-revision",
                  // The famous-problem guardrail and named other-* areas are
                  // Fellow-proposed text served with the public problem, so publish
                  // screens them with the statement.
                  statement: [
                    problem.title,
                    candidate.statement,
                    candidate.motivation ?? "",
                    candidate.scope ?? "",
                    candidate.out_of_scope ?? "",
                    candidate.success_criteria ?? "",
                    action.action === "publish" ? (problem.famous_guardrail ?? "") : "",
                    action.action === "publish" ? problem.areas : "",
                  ]
                    .filter((part) => part.length > 0)
                    .join("\n\n"),
                  falsifier: candidate.falsifier,
                },
                // The stored formulation belongs to the submitting Fellow;
                // the sponsor only accepts those exact reviewed bytes.
                action.action === "publish"
                  ? problem.created_by_fellow_id == null
                    ? undefined
                    : {
                        sponsorId: publication?.scientific_author?.sponsor_id ?? sponsor.sponsorId,
                        route: `problem-${action.action}`,
                      }
                  : {
                      sponsorId: revision?.author.sponsor_id ?? sponsor.sponsorId,
                      route: `problem-${action.action}`,
                    },
              );
              return screened;
            },
          }
        : undefined;

    return applyPublicProblemGovernance(
      db,
      problem,
      sponsor.sponsorId,
      action,
      c.req.raw,
      screening,
    );
  });

  // --- DELETE /v1/sponsors/problems/:id (Hard deletion of private draft) -----
  app.delete("/v1/sponsors/problems/:id", async (c) => {
    const problemId = c.req.param("id");
    const verified = await options.verifiedSponsor(c.req.raw, c.req.path, "delete-problem-draft");
    if (verified instanceof Response) return verified;
    const sponsor = verified.principal;
    const db = c.env.DB;

    try {
      const result = await hardDeletePrivateDraft(db, problemId, sponsor.sponsorId);
      return c.json(
        {
          ok: true,
          deleted: true,
          problem_id: result.problemId,
          receipt: result.receipt,
          rows_deleted: result.rowsDeleted,
        },
        200,
        { "cache-control": "private, no-store" },
      );
    } catch (err) {
      if (err instanceof RetentionError) {
        if (err.code === "PROBLEM_NOT_FOUND") {
          return validatedProblem({
            status: 404,
            code: "PROBLEM_NOT_FOUND",
            title: "Problem not found",
            detail: err.message,
            fixHint: "Verify the problem id against your active drafts.",
          });
        }
        if (err.code === "GOVERNANCE_NOT_AUTHORIZED") {
          return problemGovernanceRefused();
        }
        if (
          err.code === "CANNOT_DELETE_NON_DRAFT_PROBLEM" ||
          err.code === "CANNOT_DELETE_PROBLEM_WITH_PUBLIC_EVENTS"
        ) {
          return validatedProblem({
            status: 422,
            code: "WRITE_REFUSED",
            title: "Public ledger problems cannot be deleted",
            detail: err.message,
            fixHint:
              "Public problems and problems with committed events are immutable per Rule A6.",
          });
        }
      }
      throw err;
    }
  });

  return app;
}
