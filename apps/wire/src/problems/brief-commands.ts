import {
  canonicalJson,
  type SaveProblemBriefRequest,
  SaveProblemBriefResponseSchema,
  type WithdrawProblemBriefRequest,
  WithdrawProblemBriefResponseSchema,
} from "@asimposium/contracts";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { type ValidatedProblemInput, validatedProblem } from "../http/envelope.ts";
import { problemBoundariesRequired } from "./boundaries.ts";

const SCHEMA = "https://a.asimposium.org/schemas/problems.v1.json";
const REPLAY_MILLISECONDS = 24 * 60 * 60 * 1000;

export type SponsorBriefCommand =
  | { readonly operation: "save"; readonly request: SaveProblemBriefRequest }
  | {
      readonly operation: "withdraw";
      readonly id: string;
      readonly request: WithdrawProblemBriefRequest;
    };

interface BriefState {
  readonly sponsor_id: string;
  readonly status: string;
  readonly version: number;
  readonly scope: string | null;
}

interface ReceiptRow {
  readonly current_sponsor_id: string;
  readonly key_digest: string | null;
  readonly operation: string;
  readonly request_digest: string;
  readonly brief_id: string;
  readonly brief_version: number;
  readonly brief_created_at: string;
  readonly brief_updated_at: string;
}

export function privateBriefResponse(response: Response): Response {
  response.headers.set("cache-control", "private, no-store");
  response.headers.set("x-robots-tag", "noindex, nofollow");
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("referrer-policy", "no-referrer");
  return response;
}

function refusal(input: ValidatedProblemInput): Response {
  return privateBriefResponse(validatedProblem(input));
}

function unavailableBrief(): Response {
  return refusal({
    status: 404,
    code: "BRIEF_NOT_FOUND",
    title: "Editable brief unavailable",
    detail: "No active private brief at this identifier is available to this sponsor.",
    fixHint: "Reload the sponsor brief list before starting another edit or withdrawal.",
    rule: "A5",
    extensions: { schema: SCHEMA, example: { method: "GET", path: "/v1/sponsors/problem-briefs" } },
  });
}

function versionConflict(version: number): Response {
  return refusal({
    status: 409,
    code: "BRIEF_VERSION_CONFLICT",
    title: "The brief has a newer version",
    detail:
      "This command did not change the brief. An edit or withdrawal must name its current version.",
    fixHint:
      "Reload the current brief, compare your unsaved changes, then submit a newly reviewed command with its version and a new Idempotency-Key.",
    rule: "A5",
    extensions: {
      schema: SCHEMA,
      example: { expected_version: version },
      current_version: version,
      suggested_action: "refetch_and_reapply",
      refetch_url: "/v1/sponsors/problem-briefs",
    },
  });
}

function authorityRefused(): Response {
  return refusal({
    status: 403,
    code: "WRITE_REFUSED",
    title: "The sponsor command is not authorized",
    detail: "This account cannot perform this command now.",
    fixHint: "Reload the console and check the current account state.",
  });
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A current signed sponsor envelope is verified by the caller on every attempt.
 * Replay checks living-account authority again, before mutable brief conditions.
 * Only receipt metadata is retained; a matching request supplies its own prose.
 */
export async function runSponsorBriefCommand(
  db: D1Database,
  sponsorId: string,
  key: string | null,
  command: SponsorBriefCommand,
  now = Date.now(),
): Promise<Response> {
  if (key === null || !/^[A-Za-z0-9._-]{1,160}$/.test(key)) {
    return refusal({
      status: 400,
      code: "IDEMPOTENCY_KEY_INVALID",
      title: "A stable Idempotency-Key is required",
      detail:
        "The command needs a replay key so an uncertain result can be recovered for 24 hours.",
      fixHint:
        "Send 1 to 160 letters, digits, dots, underscores, or hyphens. Keep the same key and exact command when retrying an uncertain result.",
      rule: "A5",
      extensions: {
        schema: SCHEMA,
        example: { headers: { "Idempotency-Key": "brief-command-1" } },
      },
    });
  }

  try {
    const keyDigest = await digest(key);
    // Optional fields omitted by JSON transport and explicitly undefined in a
    // typed internal caller name the same command. Nested values remain strict.
    const requestDigest = await digest(
      canonicalJson({
        ...command,
        request: Object.fromEntries(
          Object.entries(command.request).filter(([, value]) => value !== undefined),
        ),
      }),
    );
    const readReceipt = async (): Promise<Response | null> => {
      const row = await db
        .prepare(`SELECT sponsor.sponsor_id AS current_sponsor_id, receipt.*
        FROM sponsors sponsor LEFT JOIN sponsor_brief_command_receipts receipt
          ON receipt.sponsor_id = sponsor.sponsor_id AND receipt.key_digest = ?
          AND receipt.expires_at > ?
        WHERE sponsor.sponsor_id = ? AND sponsor.tombstoned_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM sponsor_suspension_events WHERE sponsor_id = sponsor.sponsor_id)`)
        .bind(keyDigest, now, sponsorId)
        .first<ReceiptRow>();
      if (!row) return authorityRefused();
      if (row.key_digest === null) return null;
      if (row.operation !== command.operation || row.request_digest !== requestDigest) {
        return refusal({
          status: 409,
          code: "IDEMPOTENCY_CONFLICT",
          title: "This key already identifies a different brief command",
          detail:
            "This request did not change the brief. The retained result belongs to another command.",
          fixHint:
            "Retry the original command unchanged with its original key, or review current state before starting a different command with a new key.",
          rule: "A5",
          extensions: {
            schema: SCHEMA,
            example: { headers: { "Idempotency-Key": "brief-new-reviewed-command" } },
          },
        });
      }
      let body: unknown;
      if (command.operation === "save") {
        const formulation = { ...command.request };
        delete formulation.id;
        delete formulation.expected_version;
        body = SaveProblemBriefResponseSchema.parse({
          brief: {
            ...formulation,
            id: row.brief_id,
            sponsor_id: sponsorId,
            version: row.brief_version,
            status: "active",
            created_at: row.brief_created_at,
            updated_at: row.brief_updated_at,
          },
        });
      } else {
        if (row.brief_id !== command.id) throw new Error("BRIEF_RECEIPT_TARGET_MISMATCH");
        body = WithdrawProblemBriefResponseSchema.parse({
          withdrawn: true,
          id: row.brief_id,
          version: row.brief_version,
        });
      }
      return privateBriefResponse(
        new Response(JSON.stringify(body), {
          status: command.operation === "save" ? 201 : 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        }),
      );
    };

    const previous = await readReceipt();
    if (previous !== null) return previous;
    const briefId =
      command.operation === "withdraw"
        ? command.id
        : (command.request.id ?? `brief-${crypto.randomUUID()}`);
    const expectedVersion = command.request.expected_version;
    const assignedFellow =
      command.operation === "save" ? (command.request.assigned_fellow_id ?? null) : null;

    const inspectCurrent = async (): Promise<{ brief: BriefState | null } | Response> => {
      const brief = await db
        .prepare("SELECT sponsor_id,status,version,scope FROM sponsor_problem_briefs WHERE id = ?")
        .bind(briefId)
        .first<BriefState>();
      if (brief) {
        if (brief.sponsor_id !== sponsorId || brief.status !== "active") return unavailableBrief();
        if (expectedVersion !== brief.version) return versionConflict(brief.version);
        if (
          command.operation === "save" &&
          brief.scope !== null &&
          command.request.scope === undefined
        )
          return privateBriefResponse(problemBoundariesRequired());
      } else if (command.operation === "withdraw" || expectedVersion !== undefined) {
        return unavailableBrief();
      }
      if (assignedFellow !== null) {
        const assignee = await db
          .prepare(
            "SELECT fellow_id FROM enrollment_fellows WHERE fellow_id = ? AND sponsor_id = ? AND status = 'active'",
          )
          .bind(assignedFellow, sponsorId)
          .first();
        if (!assignee)
          return refusal({
            status: 403,
            code: "BRIEF_NOT_ASSIGNED",
            title: "The brief needs a current active Fellow",
            detail: "A sponsor may assign private briefs only to its own active Fellows.",
            fixHint: "Choose an active Fellow from your console, or leave the brief unassigned.",
            rule: "A5",
            extensions: { schema: SCHEMA, example: { assigned_fellow_id: "F-own-active-fellow" } },
          });
      }
      return { brief };
    };

    const current = await inspectCurrent();
    if (current instanceof Response) return (await readReceipt()) ?? current;
    const nextVersion = (current.brief?.version ?? 0) + 1;
    const timestamp = new Date(now).toISOString();
    const livingSponsor = `EXISTS (SELECT 1 FROM sponsors s WHERE s.sponsor_id = ? AND s.tombstoned_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM sponsor_suspension_events WHERE sponsor_id = ?)`;
    const ownAssignee = `(? IS NULL OR EXISTS (SELECT 1 FROM enrollment_fellows
      WHERE fellow_id = ? AND sponsor_id = ? AND status = 'active'))`;
    let effect: D1PreparedStatement;
    if (command.operation === "withdraw") {
      effect = db
        .prepare(`UPDATE sponsor_problem_briefs SET status = 'withdrawn', version = version + 1, updated_at = ?
        WHERE id = ? AND sponsor_id = ? AND status = 'active' AND version = ? AND ${livingSponsor}`)
        .bind(timestamp, briefId, sponsorId, expectedVersion, sponsorId, sponsorId);
    } else {
      const body = command.request;
      const fields = [
        assignedFellow,
        body.title,
        body.statement,
        body.falsifier,
        body.motivation,
        body.scope ?? null,
        body.out_of_scope ?? null,
        body.success_criteria ?? null,
        JSON.stringify(body.areas),
        body.famous_guardrail === undefined ? null : JSON.stringify(body.famous_guardrail),
      ];
      if (current.brief === null) {
        effect = db
          .prepare(`INSERT INTO sponsor_problem_briefs
          (id,sponsor_id,assigned_fellow_id,title,statement,falsifier,motivation,scope,out_of_scope,success_criteria,areas,famous_guardrail,status,version,created_at,updated_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?
          WHERE ${livingSponsor} AND ${ownAssignee}
          ON CONFLICT(id) DO NOTHING`)
          .bind(
            briefId,
            sponsorId,
            ...fields,
            timestamp,
            timestamp,
            sponsorId,
            sponsorId,
            assignedFellow,
            assignedFellow,
            sponsorId,
          );
      } else {
        effect = db
          .prepare(`UPDATE sponsor_problem_briefs SET
          assigned_fellow_id = ?, title = ?, statement = ?, falsifier = ?, motivation = ?,
          scope = ?, out_of_scope = ?, success_criteria = ?, areas = ?, famous_guardrail = ?,
          version = version + 1, updated_at = ?
          WHERE id = ? AND sponsor_id = ? AND status = 'active' AND version = ?
            AND (scope IS NULL OR ? IS NOT NULL) AND ${livingSponsor} AND ${ownAssignee}`)
          .bind(
            ...fields,
            timestamp,
            briefId,
            sponsorId,
            expectedVersion,
            body.scope ?? null,
            sponsorId,
            sponsorId,
            assignedFellow,
            assignedFellow,
            sponsorId,
          );
      }
    }

    // A successful effect must record its exact head. A failed pin becomes
    // NULL and aborts the whole batch rather than committing an unreceipted save.
    // A concurrent duplicate key also aborts all effects in the losing batch.
    const receipt = db
      .prepare(`INSERT INTO sponsor_brief_command_receipts
      (sponsor_id,key_digest,operation,request_digest,brief_id,brief_version,brief_created_at,brief_updated_at,created_at,expires_at)
      SELECT ?, ?, ?, ?, CASE WHEN EXISTS (
        SELECT 1 FROM sponsor_problem_briefs WHERE id = ? AND sponsor_id = ? AND version = ? AND status = ? AND updated_at = ?
      ) THEN ? ELSE NULL END, ?,
      (SELECT created_at FROM sponsor_problem_briefs WHERE id = ? AND sponsor_id = ?), ?, ?, ?
      WHERE changes() = 1`)
      .bind(
        sponsorId,
        keyDigest,
        command.operation,
        requestDigest,
        briefId,
        sponsorId,
        nextVersion,
        command.operation === "save" ? "active" : "withdrawn",
        timestamp,
        briefId,
        nextVersion,
        briefId,
        sponsorId,
        timestamp,
        now,
        now + REPLAY_MILLISECONDS,
      );
    let failed = false;
    try {
      await db.batch([
        db
          .prepare(
            "DELETE FROM sponsor_brief_command_receipts WHERE sponsor_id = ? AND key_digest = ? AND expires_at <= ?",
          )
          .bind(sponsorId, keyDigest, now),
        effect,
        receipt,
      ]);
    } catch {
      failed = true;
    }
    // This lookup is also necessary after a zero-row CAS: the same-key winner
    // may have committed before this request reached its transaction.
    const committed = await readReceipt();
    if (committed !== null) return committed;
    const changed = await inspectCurrent();
    if (changed instanceof Response) return (await readReceipt()) ?? changed;
    throw new Error(failed ? "BRIEF_COMMAND_BATCH_FAILED" : "BRIEF_COMMAND_RECEIPT_MISSING");
  } catch {
    return refusal({
      status: 503,
      code: "INTERNAL_ERROR",
      title: "The brief command could not be confirmed",
      detail: "The Worker could not safely confirm this command's result.",
      fixHint:
        "Keep the exact command and Idempotency-Key and retry within 24 hours. Do not start a replacement command while the result is uncertain.",
    });
  }
}
