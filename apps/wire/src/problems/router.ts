import {
  ProblemDetailSchema,
  ProblemFamousGuardrailSchema,
  ProblemLifecycleActionRequestSchema,
  type ProblemNoClaimBoundary,
  ProblemNoClaimBoundarySchema,
  ProposeProblemRequestSchema,
  SaveProblemBriefRequestSchema,
  SponsorProblemBriefSchema,
} from "@asimposium/contracts";
import { type Context, Hono } from "hono";
import { parseExactJsonBytes, readBoundedRequestBody } from "../auth/http";
import type { EnrollmentService, FellowCredentialBinding } from "../enrollment/service";
import type { Env } from "../env";
import { validatedProblem } from "../http/envelope";
import { genesisChainDigest } from "../krater/krater";
import { normHash } from "../split/policy";
import { applyPublicProblemGovernance, problemGovernanceRefused } from "./lifecycle-ledger";

export interface ProblemRouterOptions {
  readonly service: EnrollmentService;
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
  // This router is fetched as a nested app; its own error boundary runs
  // before the outer Worker's handler. Never return raw D1 exception text.
  app.onError(() =>
    validatedProblem({
      status: 500,
      code: "INTERNAL_ERROR",
      title: "The Worker failed to handle this request",
      detail: "An unexpected error occurred. Its details are not disclosed on this face.",
      fixHint:
        "Retry the request with the same Idempotency-Key. If it persists, report the route and time.",
      headers: { "cache-control": "private, no-store" },
    }),
  );

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
    if (!binding || binding.fellowStatus !== "active" || binding.revokedAt !== undefined) {
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

    // Scope check: propose-problems
    if (!auth.binding.grantedScopes.includes("propose-problems")) {
      return validatedProblem({
        status: 403,
        code: "WRITE_REFUSED",
        title: "Scope 'propose-problems' required",
        detail: "This Fellow token does not carry the 'propose-problems' scope.",
        fixHint: "Request an enrollment with 'propose-problems' scope.",
      });
    }

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
          "Provide title, statement, falsifier, motivation, and 1–32 areas from GET /areas.json or named other-* areas.",
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

    // If adopting a sponsor brief, verify brief ownership and assignment
    if (parsed.data.brief_id) {
      const brief = await db
        .prepare("SELECT * FROM sponsor_problem_briefs WHERE id = ?")
        .bind(parsed.data.brief_id)
        .first<{
          id: string;
          sponsor_id: string;
          assigned_fellow_id: string | null;
          status: string;
        }>();

      if (!brief || brief.status !== "active") {
        return validatedProblem({
          status: 404,
          code: "BRIEF_NOT_FOUND",
          title: "Sponsor problem brief not found",
          detail: `The problem brief '${parsed.data.brief_id}' was not found or has been withdrawn.`,
          fixHint: "Verify the brief id and ensure it was saved by your sponsor.",
          rule: "A5",
          extensions: {
            schema: "https://a.asimposium.org/schemas/problems.v1.json",
            example: { brief_id: parsed.data.brief_id },
          },
        });
      }

      if (
        brief.sponsor_id !== auth.binding.sponsorId ||
        (brief.assigned_fellow_id && brief.assigned_fellow_id !== auth.binding.fellowId)
      ) {
        return validatedProblem({
          status: 403,
          code: "BRIEF_NOT_ASSIGNED",
          title: "Problem brief is not assigned to this Fellow",
          detail:
            "This problem brief was created by another sponsor or assigned to a different Fellow.",
          fixHint:
            "Adopt only briefs assigned to your Fellow or created by your accountable sponsor.",
          rule: "A5",
          extensions: {
            schema: "https://a.asimposium.org/schemas/problems.v1.json",
            example: { brief_id: parsed.data.brief_id },
          },
        });
      }
    }

    // P11 Duplicate-problem screening
    const candidateHash = await normHash(parsed.data.statement);
    const fullHash = `sha256:${candidateHash}`;
    const duplicateMatches = await db
      .prepare(
        `SELECT p.id, p.title, v.statement
         FROM problem_statement_versions v
         JOIN problems p ON p.id = v.problem_id
         WHERE v.norm_hash = ?
           AND (
             p.status IN ('active', 'sharpening', 'under-result-review')
             OR (p.status = 'private-draft' AND p.sponsor_id = ?)
           )
         LIMIT 5`,
      )
      .bind(fullHash, auth.binding.sponsorId)
      .all<{ id: string; title: string; statement: string }>();

    if (duplicateMatches.results.length > 0 && !parsed.data.distinct_because) {
      return validatedProblem({
        status: 409,
        code: "POSSIBLE_DUPLICATE",
        title: "A duplicate or near-duplicate problem already exists",
        detail: `The problem statement matches existing problem '${duplicateMatches.results[0]?.id ?? ""}'.`,
        fixHint:
          "Review the existing problem or provide distinct_because explaining the material distinction.",
        rule: "P11",
        extensions: {
          schema: "https://a.asimposium.org/schemas/problems.v1.json",
          example: {
            distinct_because: "This problem investigates the variant under modular arithmetic.",
          },
          existing_problem_id: duplicateMatches.results[0]?.id,
        },
      });
    }

    const rawSlug = parsed.data.title
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 20);
    const slug = rawSlug.replace(/-+$/, "") || "PROB";
    const problemId = `P-${slug}-${crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    const now = new Date().toISOString();
    const genesis = await genesisChainDigest(problemId);

    const famousJson = parsed.data.famous_guardrail
      ? JSON.stringify(parsed.data.famous_guardrail)
      : null;
    const areas = [...new Set(parsed.data.areas)];

    const batchStatements = [
      db
        .prepare(
          `INSERT INTO problems (
             id, public_seq, status, unlisted, sponsor_id, created_by_fellow_id,
             title, current_statement_version, chain_version, chain_digest,
             famous_guardrail, created_at, updated_at, areas
           ) VALUES (?, 0, 'private-draft', ?, ?, ?, ?, 1, 2, ?, ?, ?, ?, ?)`,
        )
        .bind(
          problemId,
          parsed.data.unlisted ? 1 : 0,
          auth.binding.sponsorId,
          auth.binding.fellowId,
          parsed.data.title,
          genesis,
          famousJson,
          now,
          now,
          JSON.stringify(areas),
        ),
      db
        .prepare(
          `INSERT INTO problem_statement_versions (
             problem_id, version, statement, norm_hash, falsifier, motivation, created_at
           ) VALUES (?, 1, ?, ?, ?, ?, ?)`,
        )
        .bind(
          problemId,
          parsed.data.statement,
          fullHash,
          parsed.data.falsifier,
          parsed.data.motivation,
          now,
        ),
      db
        .prepare(
          `INSERT INTO krater_integrity_backfill (
             problem_id, state, legacy_event_count, completed_at, chain_version
           ) VALUES (?, 'complete', 0, ?, 2)`,
        )
        .bind(problemId, now),
    ];

    if (parsed.data.brief_id) {
      batchStatements.push(
        db
          .prepare(
            "UPDATE sponsor_problem_briefs SET status = 'adopted', updated_at = ? WHERE id = ?",
          )
          .bind(now, parsed.data.brief_id),
      );
    }

    await db.batch(batchStatements);

    return c.json(
      {
        problem: {
          id: problemId,
          title: parsed.data.title,
          status: "private-draft",
          unlisted: !!parsed.data.unlisted,
          sponsor_id: auth.binding.sponsorId,
          created_by_fellow_id: auth.binding.fellowId,
          current_statement_version: 1,
          public_seq: 0,
          statement: parsed.data.statement,
          falsifier: parsed.data.falsifier,
          motivation: parsed.data.motivation,
          areas,
          famous_guardrail: parsed.data.famous_guardrail,
          created_at: now,
          updated_at: now,
        },
      },
      201,
      { "cache-control": "private, no-store" },
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

    // Private draft visibility gate: visible only to sponsor and creator fellow
    if (problem.status === "private-draft") {
      const token = bearerToken(c.req.raw);
      let allowed = false;
      if (token) {
        try {
          const binding = await options.service.credentialBinding(token);
          if (
            binding &&
            (binding.fellowId === problem.created_by_fellow_id ||
              binding.sponsorId === problem.sponsor_id)
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

    const statementRow = await db
      .prepare(
        "SELECT statement, falsifier, motivation FROM problem_statement_versions WHERE problem_id = ? AND version = ?",
      )
      .bind(problemId, problem.current_statement_version)
      .first<{ statement: string; falsifier: string; motivation: string }>();

    const famousGuardrail = problem.famous_guardrail
      ? JSON.parse(problem.famous_guardrail)
      : undefined;

    let parsedNoClaimBoundary: ProblemNoClaimBoundary | undefined;
    if (problem.resolution_no_claim_boundary) {
      try {
        const parsed = ProblemNoClaimBoundarySchema.safeParse(
          JSON.parse(problem.resolution_no_claim_boundary),
        );
        if (parsed.success) {
          parsedNoClaimBoundary = parsed.data;
        }
      } catch {
        parsedNoClaimBoundary = undefined;
      }
    }

    const resolution =
      problem.status === "resolved" &&
      problem.resolution_direction &&
      problem.resolution_summary &&
      parsedNoClaimBoundary !== undefined
        ? {
            direction: problem.resolution_direction as any,
            summary: problem.resolution_summary,
            no_claim_boundary: parsedNoClaimBoundary,
          }
        : undefined;

    return c.json(
      {
        problem: {
          id: problem.id,
          title: problem.title || problem.id,
          status: problem.status,
          unlisted: problem.unlisted === 1,
          sponsor_id: problem.sponsor_id ?? undefined,
          created_by_fellow_id: problem.created_by_fellow_id ?? undefined,
          current_statement_version: problem.current_statement_version,
          public_seq: problem.public_seq,
          statement: statementRow?.statement ?? "",
          falsifier: statementRow?.falsifier ?? "",
          motivation: statementRow?.motivation ?? "",
          areas: ProblemDetailSchema.shape.areas.parse(JSON.parse(problem.areas)),
          famous_guardrail: famousGuardrail,
          resolution,
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
    if (verified instanceof Response) return verified;
    const sponsor = verified.principal;
    const db = c.env.DB;

    let rawJson: unknown;
    try {
      rawJson = JSON.parse(new TextDecoder().decode(verified.rawBody));
    } catch {
      rawJson = undefined;
    }

    const parsed = SaveProblemBriefRequestSchema.safeParse(rawJson);
    if (!parsed.success) {
      return validatedProblem({
        status: 422,
        code: "PROBLEM_BRIEF_BODY_INVALID",
        title: "Invalid problem brief request body",
        detail: "The request body did not match the save problem brief contract.",
        fixHint: "Provide title, statement, falsifier, motivation, and areas.",
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
      });
    }

    // If assigned_fellow_id, verify fellow belongs to sponsor
    if (parsed.data.assigned_fellow_id) {
      const fellow = await db
        .prepare("SELECT sponsor_id FROM enrollment_fellows WHERE fellow_id = ?")
        .bind(parsed.data.assigned_fellow_id)
        .first<{ sponsor_id: string }>();

      if (!fellow || fellow.sponsor_id !== sponsor.sponsorId) {
        return validatedProblem({
          status: 403,
          code: "BRIEF_NOT_ASSIGNED",
          title: "Assigned Fellow does not belong to this sponsor",
          detail: "A sponsor can only assign problem briefs to their own registered Fellows.",
          fixHint: "Assign to a fellow belonging to your sponsor.",
          rule: "A5",
          extensions: {
            schema: "https://a.asimposium.org/schemas/problems.v1.json",
            example: { assigned_fellow_id: parsed.data.assigned_fellow_id },
          },
        });
      }
    }

    const briefId = parsed.data.id ?? `brief-${crypto.randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();
    const famousJson = parsed.data.famous_guardrail
      ? JSON.stringify(parsed.data.famous_guardrail)
      : null;

    // Ownership and private state are checked by the same statement that
    // changes the brief, including concurrent requests sharing a caller ID.
    const saved = await db
      .prepare(
        `INSERT INTO sponsor_problem_briefs (
           id, sponsor_id, assigned_fellow_id, title, statement, falsifier,
           motivation, areas, famous_guardrail, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           assigned_fellow_id = excluded.assigned_fellow_id,
           title = excluded.title,
           statement = excluded.statement,
           falsifier = excluded.falsifier,
           motivation = excluded.motivation,
           areas = excluded.areas,
           famous_guardrail = excluded.famous_guardrail,
           updated_at = excluded.updated_at
         WHERE sponsor_problem_briefs.sponsor_id = excluded.sponsor_id
           AND sponsor_problem_briefs.status = 'active'
         RETURNING *`,
      )
      .bind(
        briefId,
        sponsor.sponsorId,
        parsed.data.assigned_fellow_id ?? null,
        parsed.data.title,
        parsed.data.statement,
        parsed.data.falsifier,
        parsed.data.motivation,
        JSON.stringify(parsed.data.areas),
        famousJson,
        now,
        now,
      )
      .first<{
        id: string;
        sponsor_id: string;
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
      }>();

    if (!saved) {
      return validatedProblem({
        status: 404,
        code: "BRIEF_NOT_FOUND",
        title: "Editable brief not found",
        detail: "No active private brief with this id is available to this sponsor.",
        fixHint:
          "Use an active brief from your sponsor brief list, or omit id to create a new one.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/problem.v1.json",
          example: { method: "GET", path: "/v1/sponsors/problem-briefs" },
        },
        headers: { "cache-control": "private, no-store" },
      });
    }

    return c.json(
      {
        brief: SponsorProblemBriefSchema.parse({
          ...saved,
          assigned_fellow_id: saved.assigned_fellow_id ?? undefined,
          areas: JSON.parse(saved.areas),
          famous_guardrail: saved.famous_guardrail ? JSON.parse(saved.famous_guardrail) : undefined,
        }),
      },
      201,
      { "cache-control": "private, no-store" },
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
        "SELECT * FROM sponsor_problem_briefs WHERE sponsor_id = ? AND status = 'active' ORDER BY updated_at DESC",
      )
      .bind(sponsor.sponsorId)
      .all<{
        id: string;
        sponsor_id: string;
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
      }>();

    const briefs = rows.results.map((r) => ({
      id: r.id,
      sponsor_id: r.sponsor_id,
      assigned_fellow_id: r.assigned_fellow_id ?? undefined,
      title: r.title,
      statement: r.statement,
      falsifier: r.falsifier,
      motivation: r.motivation,
      areas: JSON.parse(r.areas),
      famous_guardrail: r.famous_guardrail ? JSON.parse(r.famous_guardrail) : undefined,
      status: r.status,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));

    return c.json({ briefs }, 200, { "cache-control": "private, no-store" });
  });

  // --- POST /v1/sponsors/problem-briefs/:id/withdraw ------------------------
  app.post("/v1/sponsors/problem-briefs/:id/withdraw", async (c) => {
    const briefId = c.req.param("id");
    const verified = await options.verifiedSponsor(c.req.raw, c.req.path, "withdraw-problem-brief");
    if (verified instanceof Response) return verified;
    const sponsor = verified.principal;
    const db = c.env.DB;

    const brief = await db
      .prepare("SELECT * FROM sponsor_problem_briefs WHERE id = ?")
      .bind(briefId)
      .first<{ id: string; sponsor_id: string }>();

    if (!brief || brief.sponsor_id !== sponsor.sponsorId) {
      return validatedProblem({
        status: 404,
        code: "BRIEF_NOT_FOUND",
        title: "Brief not found",
        detail: `No brief with id '${briefId}' exists under this sponsor.`,
        fixHint: "Verify the brief id.",
      });
    }

    const now = new Date().toISOString();
    await db
      .prepare(
        "UPDATE sponsor_problem_briefs SET status = 'withdrawn', updated_at = ? WHERE id = ?",
      )
      .bind(now, briefId)
      .run();

    return c.json({ withdrawn: true, id: briefId }, 200, {
      "cache-control": "private, no-store",
    });
  });

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

    // Sponsor authority check
    if (problem.sponsor_id !== sponsor.sponsorId) {
      return problemGovernanceRefused();
    }

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
          "Specify a valid lifecycle action: publish, revise-statement, enter-result-review, resolve, or retire.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/problems.v1.json",
          example: { action: "publish" },
        },
      });
    }

    const action = parsed.data;
    const now = new Date().toISOString();

    if (
      action.action === "publish" ||
      action.action === "enter-result-review" ||
      action.action === "retire" ||
      (action.action === "revise-statement" && problem.status !== "private-draft")
    ) {
      return applyPublicProblemGovernance(db, problem, sponsor.sponsorId, action, c.req.raw);
    }

    if (action.action === "revise-statement") {
      if (problem.status === "retired" || problem.status === "resolved") {
        return validatedProblem({
          status: 422,
          code: "WRITE_REFUSED",
          title: "Cannot revise statement of closed problem",
          detail: `Problem '${problemId}' is '${problem.status}' and cannot be revised.`,
          fixHint: "Fork the problem if you want to explore an alternate formulation.",
        });
      }

      const nextVersion = problem.current_statement_version + 1;
      const candidateHash = await normHash(action.statement);
      const fullHash = `sha256:${candidateHash}`;

      await db.batch([
        db
          .prepare(
            `INSERT INTO problem_statement_versions (
               problem_id, version, statement, norm_hash, falsifier, motivation,
               steward_accepted_by, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            problemId,
            nextVersion,
            action.statement,
            fullHash,
            action.falsifier,
            action.motivation,
            sponsor.sponsorId,
            now,
          ),
        db
          .prepare("UPDATE problems SET current_statement_version = ?, updated_at = ? WHERE id = ?")
          .bind(nextVersion, now, problemId),
        // Monotonicity law: open claims addressing older versions are flagged statement_drift!
        db
          .prepare(
            "UPDATE claims SET statement_drift = 1 WHERE problem_id = ? AND statement_version < ?",
          )
          .bind(problemId, nextVersion),
      ]);

      return c.json(
        {
          problem: {
            id: problemId,
            status: problem.status,
            title: problem.title,
            current_statement_version: nextVersion,
            statement: action.statement,
            falsifier: action.falsifier,
            motivation: action.motivation,
            updated_at: now,
          },
        },
        200,
        { "cache-control": "private, no-store" },
      );
    }

    if (action.action === "resolve") {
      // Must be under-result-review
      if (problem.status !== "under-result-review") {
        return validatedProblem({
          status: 422,
          code: "PREMATURE_RESOLUTION",
          title: "Resolution cannot be recorded before result review",
          detail:
            "The problem must enter under-result-review and complete verification before resolution.",
          fixHint:
            "Transition the problem to under-result-review and ensure independent reviews are recorded.",
          rule: "P3",
          extensions: {
            schema: "https://a.asimposium.org/schemas/problems.v1.json",
            example: { action: "enter-result-review" },
          },
        });
      }

      // Famous-problem guardrail check: requires external_expert_review_proof
      if (problem.famous_guardrail && !action.external_expert_review_proof) {
        return validatedProblem({
          status: 422,
          code: "PREMATURE_RESOLUTION",
          title: "Famous problems require external-expert review proof before resolution",
          detail:
            "A problem with a famous-problem guardrail requires external-expert review proof before any resolution-shaped status language appears.",
          fixHint: "Provide external_expert_review_proof detailing the external validation.",
          rule: "P3",
          extensions: {
            schema: "https://a.asimposium.org/schemas/problems.v1.json",
            example: {
              external_expert_review_proof:
                "Lean 4 machine-checked proof independently verified by 2 external reviewers.",
            },
          },
        });
      }

      const noClaimJson = JSON.stringify(action.closing_synthesis.no_claim_boundary);

      await db
        .prepare(
          `UPDATE problems
           SET status = 'resolved',
               resolution_direction = ?,
               resolution_summary = ?,
               resolution_no_claim_boundary = ?,
               updated_at = ?
           WHERE id = ?`,
        )
        .bind(action.direction, action.closing_synthesis.summary, noClaimJson, now, problemId)
        .run();

      return c.json(
        {
          problem: {
            id: problemId,
            status: "resolved",
            title: problem.title,
            resolution: {
              direction: action.direction,
              summary: action.closing_synthesis.summary,
              no_claim_boundary: action.closing_synthesis.no_claim_boundary,
            },
            updated_at: now,
          },
        },
        200,
        { "cache-control": "private, no-store" },
      );
    }

    return validatedProblem({
      status: 422,
      code: "PROBLEM_LIFECYCLE_BODY_INVALID",
      title: "Unknown lifecycle action",
      detail: "The specified lifecycle action is not supported.",
      fixHint: "Use publish, revise-statement, enter-result-review, resolve, or retire.",
      rule: "A5",
      extensions: {
        schema: "https://a.asimposium.org/schemas/problems.v1.json",
        example: { action: "publish" },
      },
    });
  });

  return app;
}
