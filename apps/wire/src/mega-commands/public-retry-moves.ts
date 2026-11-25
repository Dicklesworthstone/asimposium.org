import { getMoveTemplate } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { offScopeClaimSql, offScopePublicationSql } from "../discovery/public-scope.ts";
import { eventContentHiddenSql } from "../krater/public-content.ts";
import type { VerifiedDeadEndRetry } from "../ledger/dead-end-retries.ts";
import { loadDeadEndRetryPage } from "../ledger/dead-end-retry-service.ts";
import { loadRetryMove, type RetryMoveSelection } from "./retry-moves.ts";

export interface PublicRetryReference {
  id: string;
  kind: "claim" | "review" | "evidence" | "gap" | "problem" | "dead_end" | "retraction";
  version: number;
  event_id: string;
  seq: number;
  payload_sha256: string;
}
export interface PublicRetryMoveSelection extends RetryMoveSelection {
  references: PublicRetryReference[];
}
interface ReferenceRow extends PublicRetryReference {
  role: "source" | "firing" | "condition";
}

/** Resolve the original negative result, its exact recorded firing and the
 * current public condition. Scope filtering precedes selection, so an excluded
 * firing cannot crowd out another eligible retry in the bounded pages. */
function referencesSql(globalDiscovery: boolean) {
  return `WITH cut AS (SELECT ? AS problem_id, ? AS cursor),
  condition AS (
    SELECT e.id, e.seq, e.payload_sha256 FROM events e CROSS JOIN cut
    WHERE e.problem_id = cut.problem_id AND e.seq <= cut.cursor
      AND e.object_kind = ? AND e.object_id = ?
      AND e.type IN ('claim.created','claim.revised','gap.filed',
        'problem.admitted','problem.statement-revised')
    ORDER BY e.seq DESC LIMIT 1
  ),
  pins AS (
    SELECT 'source' AS role, ? AS event_id, ? AS seq, ? AS payload_sha256
    UNION ALL SELECT 'firing', ?, ?, ?
    UNION ALL SELECT 'condition', id, seq, payload_sha256 FROM condition
  )
  SELECT pin.role, e.object_id AS id, e.object_kind AS kind,
    e.object_version AS version, e.id AS event_id, e.seq, e.payload_sha256
  FROM pins pin CROSS JOIN cut
  JOIN events e ON e.id = pin.event_id AND e.problem_id = cut.problem_id
    AND e.seq = pin.seq AND e.seq <= cut.cursor AND e.payload_sha256 = pin.payload_sha256
  JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
    AND c.redacted_at IS NULL
  WHERE NOT ${eventContentHiddenSql("e")}
    ${
      globalDiscovery
        ? `AND NOT ${offScopePublicationSql("e.id")}
    AND (e.object_kind != 'claim' OR NOT ${offScopeClaimSql("e.problem_id", "e.object_id", "cut.cursor")})`
        : ""
    }`;
}
export const PUBLIC_RETRY_REFERENCES_SQL = referencesSql(false);
export const GLOBAL_RETRY_REFERENCES_SQL = referencesSql(true);

function condition(item: VerifiedDeadEndRetry): { kind: string; id: string } {
  const trigger = item.source.retry_when;
  return trigger.kind === "claim-reaches"
    ? { kind: "claim", id: trigger.claim_id }
    : trigger.kind === "gap-closed"
      ? { kind: "gap", id: trigger.gap_id }
      : { kind: "problem", id: item.problem_id };
}

function validReferences(rows: ReferenceRow[], item: VerifiedDeadEndRetry): boolean {
  const expected = condition(item);
  return (
    rows.length === 3 &&
    new Set(rows.map((row) => row.role)).size === 3 &&
    rows.every(
      (row) =>
        ["source", "firing", "condition"].includes(row.role) &&
        ["claim", "review", "evidence", "gap", "problem", "dead_end", "retraction"].includes(
          row.kind,
        ) &&
        typeof row.id === "string" &&
        row.id.length > 0 &&
        typeof row.event_id === "string" &&
        row.event_id.length > 0 &&
        Number.isSafeInteger(row.version) &&
        row.version >= 1 &&
        Number.isSafeInteger(row.seq) &&
        row.seq >= 1 &&
        row.seq <= item.cursor &&
        /^[0-9a-f]{64}$/.test(row.payload_sha256) &&
        (row.role === "source"
          ? row.id === item.dead_end_id &&
            row.kind === "dead_end" &&
            row.version === 1 &&
            row.event_id === item.publication.event_id &&
            row.seq === item.publication.seq &&
            row.payload_sha256 === item.publication.payload_sha256
          : row.role === "firing"
            ? row.event_id === item.firing.event_id &&
              row.seq === item.firing.seq &&
              row.payload_sha256 === item.firing.payload_sha256
            : row.id === expected.id && row.kind === expected.kind),
    )
  );
}

/** The public path shares the authenticated retry reader and constructor. It
 * does not inspect an identity or assert the viewer can supersede any result. */
export async function loadPublicRetryMove(
  db: D1Database,
  problem: string,
  cursor: number,
  globalDiscovery = false,
  readPage: typeof loadDeadEndRetryPage = loadDeadEndRetryPage,
): Promise<PublicRetryMoveSelection> {
  const verified = new Map<string, PublicRetryReference[]>();
  const result = await loadRetryMove(db, problem, cursor, undefined, {
    template: () => getMoveTemplate("retry-dead-end"),
    async page(database, id, through, after) {
      const page = await readPage(database, id, through, after);
      if (
        page.items.length > 8 ||
        page.items.some((item) => item.problem_id !== problem || item.cursor !== cursor)
      )
        throw new Error("PUBLIC_RETRY_SCOPE_INVALID");
      if (page.items.length === 0) return page;
      const checks = await database.batch<ReferenceRow>(
        page.items.map((item) => {
          const target = condition(item);
          return database
            .prepare(globalDiscovery ? GLOBAL_RETRY_REFERENCES_SQL : PUBLIC_RETRY_REFERENCES_SQL)
            .bind(
              problem,
              cursor,
              target.kind,
              target.id,
              item.publication.event_id,
              item.publication.seq,
              item.publication.payload_sha256,
              item.firing.event_id,
              item.firing.seq,
              item.firing.payload_sha256,
            );
        }),
      );
      if (checks.length !== page.items.length || checks.some((check) => !check.success))
        throw new Error("PUBLIC_RETRY_REFERENCES_UNAVAILABLE");
      const items = page.items.filter((item, index) => {
        const rows = checks[index]?.results;
        if (!rows || !validReferences(rows, item)) return false;
        verified.set(
          item.dead_end_id,
          rows.map(({ role: _role, ...pin }) => pin),
        );
        return true;
      });
      return {
        ...page,
        items,
        omitted:
          items.length === page.items.length
            ? page.omitted
            : [...new Set([...page.omitted, "content_unavailable" as const])],
      };
    },
  });
  const references = result.move ? verified.get(result.move.refs[1] ?? "") : [];
  if (result.move && !references) throw new Error("PUBLIC_RETRY_REFERENCES_UNAVAILABLE");
  return { ...result, references: references ?? [] };
}
