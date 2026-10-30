import {
  type ScreeningPublicationNotice,
  ScreeningPublicationNoticeSchema,
  ScreeningPublicationProvenanceSchema,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";

/** Only a validated immutable publication receipt may supply a platform notice.
 * Missing receipts remain honest legacy absence; malformed receipts are not
 * silently downgraded to an ordinary, apparently unqualified publication. */
export function publicationScreeningNotice(
  raw: string | null | undefined,
): ScreeningPublicationNotice | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== "string" || new TextEncoder().encode(raw).byteLength > 4096)
    throw new Error("PUBLIC_SCREENING_RECEIPT_UNAVAILABLE");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("PUBLIC_SCREENING_RECEIPT_UNAVAILABLE");
  }
  const receipt = ScreeningPublicationProvenanceSchema.safeParse(value);
  if (!receipt.success) throw new Error("PUBLIC_SCREENING_RECEIPT_UNAVAILABLE");
  return receipt.data.public_action.action === "published-with-warning"
    ? ScreeningPublicationNoticeSchema.parse(receipt.data.public_action)
    : undefined;
}

/** Bound a page's already-selected scientific sources to their exact event
 * sequence. No receipt, actor data, digest or detector configuration escapes. */
export async function readPublicationNotices(
  db: D1Database,
  problem: string,
  sequences: readonly number[],
): Promise<ReadonlyMap<number, ScreeningPublicationNotice>> {
  const selected = [...new Set(sequences)];
  if (selected.length > 200 || selected.some((seq) => !Number.isSafeInteger(seq) || seq < 1))
    throw new Error("PUBLIC_SCREENING_PAGE_INVALID");
  const notices = new Map<number, ScreeningPublicationNotice>();
  if (selected.length === 0) return notices;
  const result = await db
    .prepare(`SELECT e.seq, s.provenance_json
    FROM events e JOIN screening_publications s ON s.event_id = e.id
    WHERE e.problem_id = ? AND e.seq IN (SELECT value FROM json_each(?))`)
    .bind(problem, JSON.stringify(selected))
    .all<{ seq: number; provenance_json: string }>();
  if (!result.success) throw new Error("PUBLIC_SCREENING_RECEIPT_UNAVAILABLE");
  const seen = new Set<number>();
  for (const row of result.results) {
    if (!selected.includes(row.seq) || seen.has(row.seq))
      throw new Error("PUBLIC_SCREENING_PAGE_INVALID");
    seen.add(row.seq);
    const notice = publicationScreeningNotice(row.provenance_json);
    if (notice !== undefined) notices.set(row.seq, notice);
  }
  return notices;
}
