import {
  canonicalJson,
  fellowProblemBriefReadUrl,
  type ProposeProblemRequest,
  ProposeProblemResponseSchema,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { authorizeFellowWrite, type FellowCredentialBinding } from "../enrollment/service.ts";
import { type ValidatedProblemInput, validatedProblem } from "../http/envelope.ts";
import { genesisChainDigest, sha256Hex } from "../krater/krater.ts";
import { normHash } from "../split/policy.ts";
import { problemBoundariesRequired, problemBoundaryFields } from "./boundaries.ts";
import { privateBriefResponse } from "./brief-commands.ts";
import { problemIntentAuthoritySql } from "./problem-intent-authority.ts";

const SCHEMA = "https://a.asimposium.org/schemas/problems.v1.json";
const REPLAY_MILLISECONDS = 86_400_000;
const WRITE_AUTHORITY = `SELECT 1 FROM authority WHERE fellow_status = 'active'
  AND (event_budget IS NULL OR events_recorded < event_budget)`;

interface ReceiptRow {
  key_digest: string | null;
  request_digest: string;
  sponsor_id: string;
  problem_id: string;
  problem_created_at: string;
  problem_available: number;
  event_budget: number | null;
  events_recorded: number;
}

function refusal(input: ValidatedProblemInput): Response {
  return privateBriefResponse(validatedProblem(input));
}

function authorityRefused(): Response {
  return refusal({
    status: 403,
    code: "WRITE_REFUSED",
    title: "The write is not authorized for this credential",
    detail: "This credential may not perform this write now.",
    fixHint: "Check the console for the credential state or contact your sponsor.",
  });
}

/** One private creation, one metadata receipt, and optional exact-version brief
 * adoption in the same D1 transaction. Matching retries reconstruct only the
 * original result from caller-supplied prose; no private body is retained here.
 */
export async function runProblemProposalCommand(
  db: D1Database,
  binding: FellowCredentialBinding,
  key: string | null,
  request: ProposeProblemRequest,
  now = Date.now(),
): Promise<Response> {
  if (key === null || !/^[A-Za-z0-9._-]{1,160}$/.test(key)) {
    return refusal({
      status: 400,
      code: "IDEMPOTENCY_KEY_INVALID",
      title: "A stable Idempotency-Key is required",
      detail: "Problem creation needs a replay key to recover an uncertain result for 24 hours.",
      fixHint:
        "Send 1 to 160 letters, digits, dots, underscores, or hyphens. Retry with the same key and exact proposal; a new key starts a new command.",
      rule: "A5",
      extensions: { schema: SCHEMA, example: { headers: { "Idempotency-Key": "proposal-1" } } },
    });
  }

  try {
    const keyDigest = await sha256Hex(key);
    const requestDigest = await sha256Hex(
      canonicalJson(
        Object.fromEntries(Object.entries(request).filter(([, value]) => value !== undefined)),
      ),
    );
    const authorityValues = [
      binding.fellowId,
      binding.sponsorId,
      binding.credentialId,
      binding.tokenHash,
    ];
    const areas = [...new Set(request.areas)];
    const readReceipt = async (): Promise<Response | null> => {
      const row = await db
        .prepare(`WITH authority AS (${problemIntentAuthoritySql(true)})
          SELECT authority.event_budget, authority.events_recorded, receipt.*,
            (EXISTS (SELECT 1 FROM problems WHERE id = receipt.problem_id)
              AND NOT EXISTS (SELECT 1 FROM private_draft_erasures WHERE problem_id = receipt.problem_id)) AS problem_available
          FROM authority LEFT JOIN problem_proposal_command_receipts receipt
            ON receipt.fellow_id = ?1 AND receipt.key_digest = ?5 AND receipt.expires_at > ?6
          WHERE authority.fellow_status = 'active'`)
        .bind(...authorityValues, keyDigest, now)
        .first<ReceiptRow>();
      if (!row) return authorityRefused();
      if (row.key_digest === null) {
        const permission = authorizeFellowWrite({
          effect: "propose-problems",
          credential: binding,
          target: {
            kind: "new-problem",
            initialPublication: "private-draft",
            unlisted: !!request.unlisted,
          },
          usage: { eventsRecorded: row.events_recorded, artifactBytesRecorded: 0 },
          now: Date.now(),
        });
        return permission.decision !== "allow" ||
          (row.event_budget !== null && row.events_recorded >= row.event_budget)
          ? authorityRefused()
          : null;
      }
      if (row.sponsor_id !== binding.sponsorId || row.request_digest !== requestDigest) {
        return refusal({
          status: 409,
          code: "IDEMPOTENCY_CONFLICT",
          title: "This key already identifies a different problem proposal",
          detail:
            "This request did not create a draft. The retained result belongs to another command.",
          fixHint:
            "Retry the original proposal unchanged with its original key, or review current state before using a new key for a different proposal.",
          rule: "A5",
          extensions: {
            schema: SCHEMA,
            example: { headers: { "Idempotency-Key": "proposal-new-reviewed-command" } },
          },
        });
      }
      if (!row.problem_available) {
        return refusal({
          status: 404,
          code: "PROBLEM_NOT_FOUND",
          title: "The created problem is no longer available",
          detail:
            "This command previously created a problem whose private draft has since been erased.",
          fixHint:
            "Do not retry under a new key to recover erased work. Review the current sponsor workspace.",
          rule: "A5",
          extensions: { schema: SCHEMA, example: { method: "GET", path: "/v1/sponsors/problems" } },
        });
      }
      const body = ProposeProblemResponseSchema.parse({
        problem: {
          id: row.problem_id,
          title: request.title,
          status: "private-draft",
          unlisted: !!request.unlisted,
          sponsor_id: binding.sponsorId,
          created_by_fellow_id: binding.fellowId,
          current_statement_version: 1,
          public_seq: 0,
          statement: request.statement,
          falsifier: request.falsifier,
          motivation: request.motivation,
          ...problemBoundaryFields(request),
          areas,
          ...(request.famous_guardrail === undefined
            ? {}
            : { famous_guardrail: request.famous_guardrail }),
          created_at: row.problem_created_at,
          updated_at: row.problem_created_at,
        },
      });
      return privateBriefResponse(
        new Response(JSON.stringify(body), {
          status: 201,
          headers: { "content-type": "application/json; charset=utf-8" },
        }),
      );
    };

    const previous = await readReceipt();
    if (previous !== null) return previous;

    const inspectBrief = async (): Promise<Response | null> => {
      if (request.brief_id === undefined) return null;
      const row = await db
        .prepare(`WITH authority AS (${problemIntentAuthoritySql(true)})
          SELECT brief.id, brief.sponsor_id, brief.assigned_fellow_id, brief.status, brief.version, brief.scope
          FROM authority LEFT JOIN sponsor_problem_briefs brief ON brief.id = ?5
          WHERE EXISTS (${WRITE_AUTHORITY})`)
        .bind(...authorityValues, request.brief_id)
        .first<{
          id: string | null;
          sponsor_id: string;
          assigned_fellow_id: string | null;
          status: string;
          version: number;
          scope: string | null;
        }>();
      if (!row) return authorityRefused();
      if (row.id === null || row.status !== "active") {
        return refusal({
          status: 404,
          code: "BRIEF_NOT_FOUND",
          title: "Sponsor problem brief not found",
          detail: "The requested private brief is no longer available for adoption.",
          fixHint: "Reload your assigned briefs before preparing a new proposal.",
          rule: "A5",
          extensions: { schema: SCHEMA, example: { method: "GET", path: "/v1/problem-briefs" } },
        });
      }
      if (
        row.sponsor_id !== binding.sponsorId ||
        (row.assigned_fellow_id !== null && row.assigned_fellow_id !== binding.fellowId)
      ) {
        return refusal({
          status: 403,
          code: "BRIEF_NOT_ASSIGNED",
          title: "Problem brief is not assigned to this Fellow",
          detail:
            "This problem brief was created by another sponsor or assigned to a different Fellow.",
          fixHint:
            "Adopt only briefs assigned to your Fellow or created by your accountable sponsor.",
          rule: "A5",
          extensions: { schema: SCHEMA, example: { brief_id: request.brief_id } },
        });
      }
      if (row.version !== request.expected_brief_version) {
        return refusal({
          status: 409,
          code: "BRIEF_VERSION_CONFLICT",
          title: "The sponsor brief has changed",
          detail:
            "No draft was created. Adoption must name the exact version of sponsor intent used to prepare the formulation.",
          fixHint:
            "Read the current brief, reconsider your formulation, then submit its version with a new Idempotency-Key.",
          rule: "A5",
          extensions: {
            schema: SCHEMA,
            example: { brief_id: request.brief_id, expected_brief_version: row.version },
            current_version: row.version,
            refetch_url: fellowProblemBriefReadUrl(request.brief_id),
            suggested_action: "refetch_and_reapply",
          },
        });
      }
      return row.scope !== null && request.scope === undefined
        ? privateBriefResponse(problemBoundariesRequired())
        : null;
    };
    const briefRefusal = await inspectBrief();
    if (briefRefusal !== null) return (await readReceipt()) ?? briefRefusal;

    const fullHash = `sha256:${await normHash(request.statement)}`;
    const matches = await db
      .prepare(`SELECT p.id FROM problem_statement_versions v JOIN problems p ON p.id = v.problem_id
        WHERE v.norm_hash = ? AND (
          (p.status IN ('active', 'sharpening', 'under-result-review') AND EXISTS (
            SELECT 1 FROM events e WHERE e.problem_id = p.id AND e.object_kind = 'problem'
              AND e.type IN ('problem.admitted', 'problem.statement-revised') AND e.object_version = v.version))
          OR (p.status = 'private-draft' AND p.sponsor_id = ?)) LIMIT 1`)
      .bind(fullHash, binding.sponsorId)
      .first<{ id: string }>();
    if (matches && !request.distinct_because) {
      return (
        (await readReceipt()) ??
        refusal({
          status: 409,
          code: "POSSIBLE_DUPLICATE",
          title: "A duplicate or near-duplicate problem already exists",
          detail: `The problem statement matches existing problem '${matches.id}'.`,
          fixHint:
            "Review the existing problem or provide distinct_because explaining the material distinction.",
          rule: "P11",
          extensions: {
            schema: SCHEMA,
            example: {
              distinct_because: "This investigates the variant under modular arithmetic.",
            },
            existing_problem_id: matches.id,
          },
        })
      );
    }

    const problemId = `P-${crypto.randomUUID().replace(/-/g, "").slice(0, 26).toUpperCase()}`;
    const timestamp = new Date(now).toISOString();
    const genesis = await genesisChainDigest(problemId);
    const statements = [
      db
        .prepare(
          "DELETE FROM problem_proposal_command_receipts WHERE fellow_id = ? AND key_digest = ? AND expires_at <= ?",
        )
        .bind(binding.fellowId, keyDigest, now),
      db
        .prepare(`INSERT INTO problems
        (id,public_seq,status,unlisted,sponsor_id,created_by_fellow_id,title,current_statement_version,chain_version,chain_digest,famous_guardrail,admission_mode,created_at,updated_at,areas,writer_cap)
        VALUES (?,0,'private-draft',?,?,?,?,1,2,?,?,'approval-required',?,?,?,8)`)
        .bind(
          problemId,
          request.unlisted ? 1 : 0,
          binding.sponsorId,
          binding.fellowId,
          request.title,
          genesis,
          request.famous_guardrail === undefined ? null : JSON.stringify(request.famous_guardrail),
          timestamp,
          timestamp,
          JSON.stringify(areas),
        ),
      // NOT NULL failure aborts every effect, including the draft above, when
      // grant authority, exact brief version or boundaries changed in flight.
      db
        .prepare(`WITH authority AS (${problemIntentAuthoritySql(true)})
        INSERT INTO problem_statement_versions
        (problem_id,version,statement,norm_hash,falsifier,motivation,scope,out_of_scope,success_criteria,created_at,scientific_author_json)
        VALUES (?5,1,CASE WHEN EXISTS (${WRITE_AUTHORITY}) AND (?6 IS NULL OR EXISTS (
          SELECT 1 FROM sponsor_problem_briefs WHERE id = ?6 AND sponsor_id = ?2 AND status = 'active'
            AND version = ?7 AND (assigned_fellow_id IS NULL OR assigned_fellow_id = ?1)
            AND (scope IS NULL OR ?8 IS NOT NULL))) THEN ?9 ELSE NULL END,?10,?11,?12,?8,?13,?14,?15,
          (SELECT json_object('fellow_id',fellow_id,'sponsor_id',sponsor_id,'session_id',NULL,
            'model_self_declared',model,'harness',harness) FROM authority))`)
        .bind(
          ...authorityValues,
          problemId,
          request.brief_id ?? null,
          request.expected_brief_version ?? null,
          request.scope ?? null,
          request.statement,
          fullHash,
          request.falsifier,
          request.motivation,
          request.out_of_scope ?? null,
          request.success_criteria ?? null,
          timestamp,
        ),
      db
        .prepare(
          "INSERT INTO problem_stewards (problem_id,sponsor_id,is_founding,created_at) VALUES (?,?,1,?)",
        )
        .bind(problemId, binding.sponsorId, timestamp),
      db
        .prepare(
          "INSERT INTO problem_memberships (problem_id,fellow_id,role,joined_at) VALUES (?,?,'contributor',?)",
        )
        .bind(problemId, binding.fellowId, timestamp),
      db
        .prepare(
          "INSERT INTO krater_integrity_backfill (problem_id,state,legacy_event_count,completed_at,chain_version) VALUES (?,'complete',0,?,2)",
        )
        .bind(problemId, timestamp),
    ];
    if (request.brief_id !== undefined) {
      statements.push(
        db
          .prepare(`UPDATE sponsor_problem_briefs SET status = 'adopted', version = version + 1, updated_at = ?
        WHERE id = ? AND sponsor_id = ? AND status = 'active' AND version = ?
          AND (assigned_fellow_id IS NULL OR assigned_fellow_id = ?)`)
          .bind(
            timestamp,
            request.brief_id,
            binding.sponsorId,
            request.expected_brief_version ?? null,
            binding.fellowId,
          ),
      );
    }
    // Unique key elects one winner even when both requests passed all reads.
    // A losing batch rolls back its whole draft, membership and brief adoption.
    statements.push(
      db
        .prepare(`INSERT INTO problem_proposal_command_receipts
      (fellow_id,sponsor_id,key_digest,request_digest,problem_id,problem_created_at,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?)`)
        .bind(
          binding.fellowId,
          binding.sponsorId,
          keyDigest,
          requestDigest,
          problemId,
          timestamp,
          now,
          now + REPLAY_MILLISECONDS,
        ),
    );
    try {
      await db.batch(statements);
    } catch {
      // The batch may have committed before its transport failed. Recovery
      // must precede mutable brief/duplicate checks, including after failure.
    }
    const committed = await readReceipt();
    if (committed !== null) return committed;
    const changed = await inspectBrief();
    if (changed !== null) return (await readReceipt()) ?? changed;
    throw new Error("PROBLEM_PROPOSAL_RECEIPT_UNCONFIRMED");
  } catch {
    return refusal({
      status: 503,
      code: "INTERNAL_ERROR",
      title: "The problem proposal could not be confirmed",
      detail: "The Worker could not safely confirm whether this command created its draft.",
      fixHint:
        "Keep the exact proposal and Idempotency-Key and retry within 24 hours. Do not start a replacement command while the result is uncertain.",
    });
  }
}
