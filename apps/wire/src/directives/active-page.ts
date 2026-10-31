import {
  ACTIVE_DIRECTIVE_CURSOR_PATTERN,
  ActiveDirectiveQuerySchema,
  ActiveDirectiveResponseSchema,
  DIRECTIVES_SCHEMA_ID,
  activeDirectivesUrl,
  type ActiveDirectiveQuery,
  type ActiveDirectiveResponse,
} from "@asimposium/contracts/directives";
import type { D1Database } from "@cloudflare/workers-types";
import type { FellowCredentialBinding } from "../enrollment/service.ts";
import { ACTIVE_DIRECTIVE_AUTHORITY_SQL, ACTIVE_DIRECTIVE_SOURCE_SQL, type ActiveDirectiveRow } from "./active-source.ts";

export class ActiveDirectiveReadError extends Error {
  constructor(readonly reason: "invalid" | "changed" | "unauthorized" | "unavailable") {
    super("Active sponsor directives could not be read safely.");
    this.name = "ActiveDirectiveReadError";
  }
}

/** Authentication verifies the complete enrollment evidence first. Recheck
 * every mutable authorization boundary inside the instruction read, so a
 * transfer, revoke, grant reduction, panic or expiry cannot race that check. */
const PAGE_SQL = `WITH authority AS (
  ${ACTIVE_DIRECTIVE_AUTHORITY_SQL}
), source AS (
  ${ACTIVE_DIRECTIVE_SOURCE_SQL} AND EXISTS (SELECT 1 FROM authority)
), snapshot AS (
  SELECT COALESCE(MAX(seq), 0) AS snapshot_seq FROM source
), page AS (
  SELECT * FROM (SELECT * FROM source
    WHERE verb IN ('focus', 'unfocus')
      AND (?6 IS NULL OR ?6 = (SELECT snapshot_seq FROM snapshot))
    ORDER BY seq DESC LIMIT 1)
  UNION ALL
  SELECT * FROM (SELECT * FROM source WHERE verb = 'forbid' AND seq > ?7
    AND (?6 IS NULL OR ?6 = (SELECT snapshot_seq FROM snapshot))
    ORDER BY seq ASC LIMIT ?8)
)
SELECT snapshot.snapshot_seq,
  (?7 = 0 OR EXISTS (SELECT 1 FROM source WHERE verb = 'forbid' AND seq = ?7)) AS frontier_valid,
  page.*
FROM authority CROSS JOIN snapshot LEFT JOIN page ON 1 = 1
ORDER BY page.seq ASC, page.id ASC`;

type PageRow = Partial<ActiveDirectiveRow> & { snapshot_seq: number; frontier_valid: number };

async function queryDigest(binding: FellowCredentialBinding, query: ActiveDirectiveQuery): Promise<string> {
  const value = JSON.stringify(["active-directives-v1", binding.fellowId, binding.sponsorId,
    binding.credentialId, query.problem_id ?? null, query.limit]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function readActiveDirectivePage(
  db: D1Database,
  binding: FellowCredentialBinding,
  input: ActiveDirectiveQuery,
): Promise<ActiveDirectiveResponse> {
  const parsed = ActiveDirectiveQuerySchema.safeParse(input);
  if (!parsed.success) throw new ActiveDirectiveReadError("invalid");
  const query = parsed.data;
  const digest = await queryDigest(binding, query);
  let expected: number | null = null;
  let after = 0;
  if (query.cursor !== undefined) {
    if (ACTIVE_DIRECTIVE_CURSOR_PATTERN.exec(query.cursor)?.[0] !== query.cursor)
      throw new ActiveDirectiveReadError("invalid");
    const [, boundQuery, snapshotText, afterText] = query.cursor.split(".");
    expected = Number(snapshotText);
    after = Number(afterText);
    if (boundQuery !== digest || !Number.isSafeInteger(expected) || expected < 1
      || !Number.isSafeInteger(after) || after < 1 || after > expected)
      throw new ActiveDirectiveReadError("invalid");
  }
  const result = await db.prepare(PAGE_SQL).bind(binding.fellowId, binding.sponsorId,
    query.problem_id ?? null, binding.credentialId, binding.tokenHash,
    expected, after, query.limit + 1).all<PageRow>();
  if (!result.success) throw new ActiveDirectiveReadError("unavailable");
  const state = result.results[0];
  // A valid empty set still has an authority row. No row means the live
  // credential/scope was lost; never publish that as "no instructions".
  if (!state) throw new ActiveDirectiveReadError("unauthorized");
  if (!Number.isSafeInteger(state.snapshot_seq) || state.snapshot_seq < 0)
    throw new ActiveDirectiveReadError("unavailable");
  if (expected !== null && expected !== state.snapshot_seq)
    throw new ActiveDirectiveReadError("changed");
  if (state.frontier_valid !== 1) throw new ActiveDirectiveReadError("invalid");
  const rows = result.results.filter(row => row.id !== null && row.id !== undefined) as ActiveDirectiveRow[];
  const focus = rows.find(row => row.verb !== "forbid");
  const forbids = rows.filter(row => row.verb === "forbid");
  const selected = forbids.slice(0, query.limit);
  const hasMore = forbids.length > query.limit;
  const cursor = hasMore ? `ad1.${digest}.${state.snapshot_seq}.${selected.at(-1)!.seq}` : null;
  const receipt = (row: ActiveDirectiveRow) => ({
    schema: DIRECTIVES_SCHEMA_ID, directive_id: row.id, fellow_id: binding.fellowId,
    problem_id: row.problem_id, verb: row.verb, text: row.body,
    notice_id: row.notice_id, seq: row.seq, created_at: row.created_at,
    delivered: true, acknowledged_at: row.acknowledged_at,
  });
  return ActiveDirectiveResponseSchema.parse({
    schema: DIRECTIVES_SCHEMA_ID, fellow_id: binding.fellowId, sponsor_id: binding.sponsorId,
    problem_id: query.problem_id ?? null, scope: query.problem_id ? "problem" : "global",
    snapshot_seq: state.snapshot_seq, focus: focus ? receipt(focus) : null,
    forbids: selected.map(receipt), has_more: hasMore, next_cursor: cursor,
    next_url: cursor ? activeDirectivesUrl(query.problem_id, query.limit, cursor) : null,
    restart_url: activeDirectivesUrl(query.problem_id, query.limit),
    omitted: [
      ...(query.problem_id ? [] : ["Global instructions only. Before working on a problem, request this endpoint again with problem_id to include its scoped instructions."]),
      ...(hasMore ? ["Continuing forbids remain. Follow every next_url before acting; if the instruction set changes, restart from restart_url."] : []),
    ],
  });
}
