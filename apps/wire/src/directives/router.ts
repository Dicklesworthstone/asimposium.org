import {
  DIRECTIVES_SCHEMA_ID,
  SponsorDirectiveListQuerySchema,
  SponsorDirectiveListResponseSchema,
  type SponsorDirectiveReceipt,
  SponsorDirectiveReceiptSchema,
  SponsorDirectiveRequestSchema,
} from "@asimposium/contracts/directives";
import { Hono } from "hono";
import type { Env } from "../env.ts";
import { problem } from "../http/envelope.ts";

const MAX_IDEMPOTENCY_KEY = 160;

export interface DirectiveRouterOptions {
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

type DirectiveRow = {
  id: string;
  fellow_id: string;
  problem_id: string | null;
  verb: "focus" | "forbid" | "unfocus";
  body: string | null;
  created_at: number;
  acknowledged_at: number | null;
  request_digest: string;
};

function privateNoStore(response: Response): Response {
  response.headers.set("cache-control", "private, no-store");
  response.headers.set("x-content-type-options", "nosniff");
  return response;
}

function refusal(status: number, code: string, title: string, detail: string, fixHint: string) {
  return privateNoStore(
    problem({
      status,
      code,
      title,
      detail,
      fixHint,
      extensions: { schema: DIRECTIVES_SCHEMA_ID },
    }),
  );
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function receipt(row: DirectiveRow): SponsorDirectiveReceipt {
  return SponsorDirectiveReceiptSchema.parse({
    schema: DIRECTIVES_SCHEMA_ID,
    directive_id: row.id,
    fellow_id: row.fellow_id,
    problem_id: row.problem_id,
    verb: row.verb,
    text: row.body,
    created_at: row.created_at,
    delivered: true,
    acknowledged_at: row.acknowledged_at,
  });
}

async function readDirective(
  db: Env["DB"],
  sponsorId: string,
  key: string,
): Promise<DirectiveRow | null> {
  return db
    .prepare(`SELECT d.id, d.fellow_id, d.problem_id, d.verb, d.body, d.created_at,
      d.request_digest, n.acknowledged_at
    FROM sponsor_directives d
    JOIN fellow_inbox_notices n ON n.id = d.notice_id AND n.fellow_id = d.fellow_id
    WHERE d.sponsor_id = ? AND d.idempotency_key = ?`)
    .bind(sponsorId, key)
    .first<DirectiveRow>();
}

function isDirectiveNotCommitted(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("SPONSOR_DIRECTIVE_NOT_COMMITTED") ||
      (error.cause !== undefined && isDirectiveNotCommitted(error.cause)))
  );
}

export function createDirectiveRouter(options: DirectiveRouterOptions): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.post("/v1/sponsors/directives", async (c) => {
    const verified = await options.verifiedSponsor(
      c.req.raw,
      "/v1/sponsors/directives",
      "issue-directive",
    );
    if (verified instanceof Response) return privateNoStore(verified);

    const key = c.req.header("idempotency-key");
    if (!key || key.length > MAX_IDEMPOTENCY_KEY || !/^[A-Za-z0-9._-]+$/.test(key)) {
      return refusal(
        400,
        "IDEMPOTENCY_KEY_INVALID",
        "A stable Idempotency-Key is required",
        "Directive delivery is replay-safe only when the sponsor supplies a valid stable key.",
        "Send 1–160 letters, digits, dots, underscores, or hyphens and reuse it for unchanged retries.",
      );
    }

    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(verified.rawBody));
    } catch {
      body = undefined;
    }
    const parsed = SponsorDirectiveRequestSchema.safeParse(body);
    if (!parsed.success) {
      return refusal(
        422,
        "DIRECTIVE_BODY_INVALID",
        "Invalid sponsor directive",
        "The signed body does not match the closed focus/forbid/unfocus directive contract.",
        "Use focus or forbid with text up to 500 characters, or unfocus without text.",
      );
    }

    const sponsorId = verified.principal.sponsorId;
    const requestDigest = await sha256(JSON.stringify(parsed.data));
    const prior = await readDirective(c.env.DB, sponsorId, key);
    if (prior) {
      if (prior.request_digest !== requestDigest) {
        return refusal(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency key already used",
          "This sponsor already used the key for a different directive.",
          "Retry the original request unchanged or use a new Idempotency-Key.",
        );
      }
      return privateNoStore(c.json(receipt(prior), 200));
    }

    const directiveHash = await sha256(`${sponsorId}\0${key}`);
    const directiveId = `DIR-${directiveHash.slice(0, 32)}`;
    const noticeId = `N-${directiveHash.slice(0, 48)}`;
    const createdAt = Date.now();
    const requestedProblem = parsed.data.problem_id ?? null;
    const text = parsed.data.text ?? null;

    await c.env.DB.batch([
      // Insert the inbox receipt first: sponsor_directives has an immediate
      // foreign key to this row. Authority is repeated in both statements and
      // a final guard aborts the entire batch if either side did not materialize.
      c.env.DB.prepare(`INSERT INTO fellow_inbox_notices
        (id, fellow_id, problem_id, notice_type, seq, title, detail, impact_kind,
         caused_by_event_id, target_id, acknowledged_at, expires_at, created_at)
        SELECT ?, f.fellow_id,
          COALESCE(?, json_extract(g.granted_resources_json, '$.problemBinding'),
                      json_extract(g.granted_resources_json, '$.problem_binding')),
          'sponsor_directive',
          (SELECT CASE WHEN COALESCE(MAX(n.seq), 0) < 9007199254740991
            THEN COALESCE(MAX(n.seq), 0) + 1 ELSE NULL END
           FROM fellow_inbox_notices n WHERE n.fellow_id = f.fellow_id),
          'Sponsor directive: ' || ?, ?, NULL, NULL, ?, NULL, NULL, ?
        FROM enrollment_fellows f
        JOIN enrollment_grants g ON g.fellow_id = f.fellow_id AND g.sponsor_id = f.sponsor_id
        WHERE f.fellow_id = ? AND f.sponsor_id = ? AND f.status = 'active'
          AND (? IS NULL OR
            ? = json_extract(g.granted_resources_json, '$.problemBinding') OR
            ? = json_extract(g.granted_resources_json, '$.problem_binding') OR
            EXISTS (SELECT 1 FROM problem_memberships m
              WHERE m.problem_id = ? AND m.fellow_id = f.fellow_id))
        ON CONFLICT(id) DO NOTHING`).bind(
        noticeId,
        requestedProblem,
        parsed.data.verb,
        text,
        directiveId,
        createdAt,
        parsed.data.fellow_id,
        sponsorId,
        requestedProblem,
        requestedProblem,
        requestedProblem,
        requestedProblem,
      ),
      c.env.DB.prepare(`INSERT INTO sponsor_directives
        (id, sponsor_id, fellow_id, problem_id, verb, body, notice_id,
         idempotency_key, request_digest, created_at)
        SELECT ?, ?, f.fellow_id,
          COALESCE(?, json_extract(g.granted_resources_json, '$.problemBinding'),
                      json_extract(g.granted_resources_json, '$.problem_binding')),
          ?, ?, ?, ?, ?, ?
        FROM enrollment_fellows f
        JOIN enrollment_grants g ON g.fellow_id = f.fellow_id AND g.sponsor_id = f.sponsor_id
        JOIN fellow_inbox_notices n ON n.id = ? AND n.fellow_id = f.fellow_id
          AND n.notice_type = 'sponsor_directive' AND n.target_id = ?
        WHERE f.fellow_id = ? AND f.sponsor_id = ? AND f.status = 'active'
          AND (? IS NULL OR
            ? = json_extract(g.granted_resources_json, '$.problemBinding') OR
            ? = json_extract(g.granted_resources_json, '$.problem_binding') OR
            EXISTS (SELECT 1 FROM problem_memberships m
              WHERE m.problem_id = ? AND m.fellow_id = f.fellow_id))
        ON CONFLICT(sponsor_id, idempotency_key) DO NOTHING`).bind(
        directiveId,
        sponsorId,
        requestedProblem,
        parsed.data.verb,
        text,
        noticeId,
        key,
        requestDigest,
        createdAt,
        noticeId,
        directiveId,
        parsed.data.fellow_id,
        sponsorId,
        requestedProblem,
        requestedProblem,
        requestedProblem,
        requestedProblem,
      ),
      c.env.DB.prepare(`SELECT CASE WHEN EXISTS (
          SELECT 1 FROM sponsor_directives d
          JOIN fellow_inbox_notices n ON n.id = d.notice_id
          WHERE d.id = ? AND d.sponsor_id = ? AND d.fellow_id = ?
            AND d.idempotency_key = ? AND d.request_digest = ?
            AND n.fellow_id = d.fellow_id AND n.target_id = d.id
        ) THEN 1 ELSE json_extract('[]', '$[SPONSOR_DIRECTIVE_NOT_COMMITTED') END`).bind(
        directiveId,
        sponsorId,
        parsed.data.fellow_id,
        key,
        requestDigest,
      ),
    ]).catch((error: unknown) => {
      // The guard aborts the batch when the target is not an active Fellow of
      // this sponsor on an assigned problem, or a concurrent request took the
      // key: the read below answers 404 or 409, not 500. Other failures throw.
      if (!isDirectiveNotCommitted(error)) throw error;
    });

    const saved = await readDirective(c.env.DB, sponsorId, key);
    if (!saved) {
      return refusal(
        404,
        "DIRECTIVE_TARGET_NOT_FOUND",
        "Directive target unavailable",
        "The requested Fellow is not an active Fellow owned by this sponsor, or the problem is outside the Fellow's assignment.",
        "Refresh the sponsor console and direct only an active Fellow on an assigned problem.",
      );
    }
    if (saved.request_digest !== requestDigest) {
      return refusal(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Idempotency key already used",
        "A concurrent request used this key for a different directive.",
        "Retry the original request unchanged or use a new Idempotency-Key.",
      );
    }

    console.info(
      JSON.stringify({
        facility: "OPS.2a",
        stage: "sponsor-directive-issued",
        directive_id: saved.id,
        fellow_id: saved.fellow_id,
        problem_id: saved.problem_id,
        verb: saved.verb,
        timestamp: createdAt,
      }),
    );
    return privateNoStore(c.json(receipt(saved), 201));
  });

  app.get("/v1/sponsors/directives", async (c) => {
    const verified = await options.verifiedSponsor(
      c.req.raw,
      "/v1/sponsors/directives",
      "list-directives",
    );
    if (verified instanceof Response) return privateNoStore(verified);

    const query = SponsorDirectiveListQuerySchema.safeParse({
      fellow_id: c.req.query("fellow_id"),
      limit: c.req.query("limit"),
    });
    if (!query.success) {
      return refusal(
        400,
        "DIRECTIVE_QUERY_INVALID",
        "Invalid directive query",
        "The directive list query did not match the contract.",
        "Optionally provide one Fellow id and a limit from 1 to 100.",
      );
    }
    const sponsorId = verified.principal.sponsorId;
    if (query.data.fellow_id) {
      const owned = await c.env.DB.prepare(
        "SELECT 1 FROM enrollment_fellows WHERE fellow_id = ? AND sponsor_id = ?",
      )
        .bind(query.data.fellow_id, sponsorId)
        .first();
      if (!owned) {
        return refusal(
          404,
          "DIRECTIVE_TARGET_NOT_FOUND",
          "Directive target unavailable",
          "The requested Fellow is not owned by this sponsor.",
          "Refresh the sponsor console and choose one of your Fellows.",
        );
      }
    }

    const result = await c.env.DB.prepare(`SELECT d.id, d.fellow_id, d.problem_id, d.verb, d.body,
        d.created_at, d.request_digest, n.acknowledged_at
      FROM sponsor_directives d
      JOIN fellow_inbox_notices n ON n.id = d.notice_id AND n.fellow_id = d.fellow_id
      WHERE d.sponsor_id = ? AND (? IS NULL OR d.fellow_id = ?)
      ORDER BY d.created_at DESC, d.id DESC LIMIT ?`)
      .bind(sponsorId, query.data.fellow_id ?? null, query.data.fellow_id ?? null, query.data.limit)
      .all<DirectiveRow>();

    return privateNoStore(
      c.json(
        SponsorDirectiveListResponseSchema.parse({
          schema: DIRECTIVES_SCHEMA_ID,
          directives: result.results.map(receipt),
        }),
      ),
    );
  });

  return app;
}
