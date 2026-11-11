import {
  type AdminAreaRenameRequest,
  AdminAreaRenameResponseSchema,
  canonicalJson,
  SEED_AREA_SLUGS,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { AREA_PROBLEM_VISIBILITY_SQL, getAreaInfo } from "../discovery/areas-service.ts";
import { validatedProblem } from "../http/envelope.ts";
import {
  scanFieldsForCredentials,
  secretShapedContentProblem,
} from "../screening/credential-scan.ts";
import { mintModerationId } from "./store.ts";

const EXAMPLE = {
  area_id: "topology-and-geometry",
  new_title: "Geometric Topology & 4-Manifolds",
  reason: "Clarify the display label after reviewing the public area.",
  step_up_authenticated_at: 1794380000,
};

export function areaRenameProblem(
  status: 403 | 404 | 409 | 422,
  code:
    | "STEP_UP_REQUIRED"
    | "MODERATION_TARGET_NOT_FOUND"
    | "MODERATION_STATE_CONFLICT"
    | "IDEMPOTENCY_CONFLICT"
    | "SCHEMA_INVALID",
): Response {
  return validatedProblem({
    status,
    code,
    title:
      status === 403
        ? "Recent authentication is required"
        : status === 404
          ? "No public area matches this slug"
          : status === 422
            ? "The area rename does not match its contract"
            : "The area rename conflicts",
    detail: "No new area title was recorded by this request.",
    fixHint:
      "Review /areas.json and the area's canonical face. Use its unchanged slug, a nonblank title, an audit reason, recent authentication and a new Idempotency-Key for a new decision. Retry an accepted decision unchanged to recover its receipt.",
    ...(status === 403
      ? {}
      : {
          rule: "A5" as const,
          extensions: {
            schema: "https://a.asimposium.org/schemas/discovery.v1.json",
            example: EXAMPLE,
          },
        }),
    headers: { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow" },
  });
}

async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(value)),
  );
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The action has its own replay namespace. Fresh authentication is checked
 * even on a retry; the original receipt precedes mutable visibility/title checks.
 * Only the immutable slug's label changes, never a problem or scientific event. */
export async function operatorRenameArea(
  db: D1Database,
  operatorId: string,
  request: AdminAreaRenameRequest,
  key: string,
): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  if (request.step_up_authenticated_at > now || now - request.step_up_authenticated_at > 900)
    return areaRenameProblem(403, "STEP_UP_REQUIRED");
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(key)) return areaRenameProblem(422, "SCHEMA_INVALID");
  const secrets = scanFieldsForCredentials({
    new_title: request.new_title,
    reason: request.reason,
  });
  if (secrets.length > 0) {
    const refusal = secretShapedContentProblem(secrets, EXAMPLE);
    refusal.headers.set("cache-control", "private, no-store");
    refusal.headers.set("x-robots-tag", "noindex, nofollow");
    return refusal;
  }
  const keyDigest = await digest(key);
  // A renewed step-up proof must not turn an exact retry into a different intent.
  const requestDigest = await digest({
    area_id: request.area_id,
    new_title: request.new_title,
    reason: request.reason,
  });
  const response = (value: unknown) =>
    Response.json(AdminAreaRenameResponseSchema.parse(value), {
      headers: { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow" },
    });
  const replay = async (): Promise<Response | undefined> => {
    const saved = await db
      .prepare(`SELECT request_digest, receipt_json FROM area_rename_events
      WHERE operator_id = ? AND key_digest = ?`)
      .bind(operatorId, keyDigest)
      .first<{ request_digest: string; receipt_json: string }>();
    return saved === null
      ? undefined
      : saved.request_digest !== requestDigest
        ? areaRenameProblem(409, "IDEMPOTENCY_CONFLICT")
        : response(JSON.parse(saved.receipt_json));
  };
  const previous = await replay();
  if (previous !== undefined) return previous;
  const seed = SEED_AREA_SLUGS.some((slug) => slug === request.area_id);
  const current = await db
    .prepare(`SELECT event_id, seq, new_title FROM area_rename_events
    WHERE area_slug = ? ORDER BY seq DESC LIMIT 1`)
    .bind(request.area_id)
    .first<{ event_id: string; seq: number; new_title: string }>();
  const oldTitle = current?.new_title ?? getAreaInfo(request.area_id, null, []).label;
  const exists = `(? = 1 OR EXISTS (SELECT 1 FROM problems p, json_each(p.areas) area
    WHERE area.value = ? AND ${AREA_PROBLEM_VISIBILITY_SQL}))`;
  const publicArea = await db
    .prepare(`SELECT ${exists} AS present`)
    .bind(seed ? 1 : 0, request.area_id)
    .first<{ present: number }>();
  if (!publicArea?.present) return areaRenameProblem(404, "MODERATION_TARGET_NOT_FOUND");
  if (oldTitle === request.new_title) return areaRenameProblem(409, "MODERATION_STATE_CONFLICT");
  const eventId = mintModerationId("OA");
  const at = new Date().toISOString();
  const receipt = AdminAreaRenameResponseSchema.parse({
    ok: true,
    area_id: request.area_id,
    new_title: request.new_title,
    audit_event_id: eventId,
    renamed_at: at,
  });
  try {
    const result = await db
      .prepare(`INSERT INTO area_rename_events
      (event_id, area_slug, seq, previous_event_id, operator_id, old_title, new_title, reason,
        before_state_digest, after_state_digest, key_digest, request_digest, step_up_authenticated_at, receipt_json, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE ${exists} AND COALESCE((SELECT event_id FROM area_rename_events
        WHERE area_slug = ? ORDER BY seq DESC LIMIT 1), '') = ?`)
      .bind(
        eventId,
        request.area_id,
        (current?.seq ?? 0) + 1,
        current?.event_id ?? null,
        operatorId,
        oldTitle,
        request.new_title,
        request.reason,
        await digest({ slug: request.area_id, label: oldTitle }),
        await digest({ slug: request.area_id, label: request.new_title }),
        keyDigest,
        requestDigest,
        request.step_up_authenticated_at,
        JSON.stringify(receipt),
        at,
        seed ? 1 : 0,
        request.area_id,
        request.area_id,
        current?.event_id ?? "",
      )
      .run();
    const committed = await replay();
    if (committed !== undefined) return committed;
    if (result.meta.changes === 0) return areaRenameProblem(409, "MODERATION_STATE_CONFLICT");
    throw new Error("AREA_RENAME_RECEIPT_MISSING");
  } catch (error) {
    const concurrent = await replay();
    if (concurrent !== undefined) return concurrent;
    throw error;
  }
}
