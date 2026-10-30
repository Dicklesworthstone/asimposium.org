import { composePack, neutralizeUntrustedBody, type PackActionCandidate, type PackCandidate } from "@asimposium/render";
import type { D1Database } from "@cloudflare/workers-types";

export const MAX_PACK_FORBIDS = 4;

interface DirectiveRow {
  id: string;
  verb: "focus" | "forbid" | "unfocus";
  body: string | null;
  problem_id: string | null;
  notice_id: string;
  seq: number;
  acknowledged_at: number | null;
}

export interface ActiveSponsorDirectives {
  readonly candidates: PackCandidate[];
  readonly actions: PackActionCandidate[];
  readonly omitted: string | null;
}

const SOURCE_SQL = `SELECT d.id, d.verb, d.body, d.problem_id, d.notice_id,
    n.seq, n.acknowledged_at
  FROM sponsor_directives d
  JOIN enrollment_fellows f ON f.fellow_id = d.fellow_id AND f.sponsor_id = d.sponsor_id
  JOIN fellow_inbox_notices n ON n.id = d.notice_id
    AND n.fellow_id = d.fellow_id AND n.notice_type = 'sponsor_directive'
    AND n.target_id = d.id AND n.problem_id IS d.problem_id
  WHERE d.fellow_id = ?1 AND d.sponsor_id = ?2
    AND (d.problem_id IS NULL OR d.problem_id = ?3)`;

/** Sponsor authority does not authorize renderer control markers. A JSON
 * string preserves ordinary code/newlines without opening Markdown fences.
 * The existing neutralizer handles forged controls and active HTML; receipts
 * retain the original text, including any characters neutralized for display. */
function displayInstruction(text: string): string {
  return neutralizeUntrustedBody(JSON.stringify(text)).text
    .replaceAll("`", "\\u0060")
    .replaceAll("~", "\\u007e");
}

/** One bounded snapshot selects current focus separately from cumulative
 * forbids. Applicable global/scoped focus transitions share committed inbox
 * sequence order. An acknowledged unfocus still clears that problem's focus.
 * There is no unforbid verb: ACK, focus and unfocus never cancel prohibitions.
 * Keep historical disclosure records independent of this current-state read. */
export async function readActiveSponsorDirectives(
  db: D1Database,
  fellowId: string,
  sponsorId: string,
  problemId: string,
): Promise<ActiveSponsorDirectives> {
  const result = await db.prepare(`
    SELECT * FROM (
      ${SOURCE_SQL} AND d.verb IN ('focus', 'unfocus')
      ORDER BY n.seq DESC LIMIT 1
    )
    UNION ALL
    SELECT * FROM (
      ${SOURCE_SQL} AND d.verb = 'forbid'
      ORDER BY n.seq ASC LIMIT ${MAX_PACK_FORBIDS + 1}
    )
    ORDER BY seq ASC, id ASC`)
    .bind(fellowId, sponsorId, problemId)
    .all<DirectiveRow>();
  if (!result.success) throw new Error("SPONSOR_DIRECTIVES_UNAVAILABLE");
  const focus = result.results.find((row) => row.verb !== "forbid");
  const forbids = result.results.filter((row) => row.verb === "forbid");
  const selected = forbids.slice(0, MAX_PACK_FORBIDS);
  const active = [...(focus ? [focus] : []), ...selected];
  const firstOmitted = forbids[MAX_PACK_FORBIDS];
  const omitted = firstOmitted
    ? `sponsor-directives: additional active forbids are omitted, beginning with ${firstOmitted.id} (receipt ${firstOmitted.notice_id}). This pack is incomplete. Resolve the remaining constraints with the current sponsor before acting; mixed inbox history is not an authoritative active-instruction list.`
    : null;
  const candidates: PackCandidate[] = [];
  const actions: PackActionCandidate[] = [];
  if (active.length > 0) {
    // Actions are mandatory envelope bytes even if the token budget excludes
    // instruction candidates. Exact omitted IDs can be matched to target_id
    // in the private inbox without treating former-sponsor history as active.
    actions.push({
      method: "GET",
      url: "/v1/inbox?unread_only=false&limit=100",
      why: "Before acting, resolve any sponsor-directive in omitted[]. Continue with since=next_cursor while has_more is true and match directive IDs to target_id; inbox history does not establish which other instructions are active.",
      public_read: false,
    });
    candidates.push({
      kind: "standing-context",
      id: "SYS-sponsor-instructions",
      scope: "system",
      tokens: 1,
      untrusted: false,
      body: "Sponsor steering persists after receipt acknowledgment. Apply the current focus state and continuing forbids below. If sponsor directives are omitted, resolve them before acting; the pack is not a complete instruction set."
        + (omitted === null ? "" : "\n" + omitted),
      why_included: "retain the instruction boundary ahead of bodies that a small token budget may omit",
      stable_prefix: 1,
    });
  }
  for (const [index, directive] of active.entries()) {
    const instruction = directive.verb === "unfocus"
      ? "Clear the current sponsor focus."
      : (directive.body ?? "");
    const receipt = directive.acknowledged_at === null
      ? `Receipt: ${directive.notice_id}. Acknowledge receipt through POST /v1/inbox/ack after reading it.`
      : `Receipt: ${directive.notice_id} (acknowledged).`;
    candidates.push({
      kind: "sponsor-directive",
      id: directive.id,
      scope: "system",
      tokens: 1,
      untrusted: false,
      body: `Sponsor directive (${directive.verb})${directive.problem_id ? ` for ${directive.problem_id}` : " for all authorized problems"}:\nInstruction (display-safe JSON string): ${displayInstruction(instruction)}\n${receipt}`,
      why_included: "apply authenticated current sponsor steering; acknowledgment confirms receipt without withdrawing it",
      stable_prefix: 2 + index,
    });
  }
  return { candidates, actions, omitted };
}

/** Account for omitted instruction identities after all ordinary selection
 * and compact-action fallbacks. The metadata is mandatory envelope content;
 * it survives removal of every instruction body and private next action. */
export function accountSponsorDirectiveOmissions(
  input: Parameters<typeof composePack>[0],
  initial: ReturnType<typeof composePack>,
): ReturnType<typeof composePack> {
  const directives = input.candidates.filter(item => item.kind === "sponsor-directive");
  let composed = initial;
  let prior = "";
  for (;;) {
    const included = new Set(composed.items.map(item => item.id));
    const missing = directives.filter(item => !included.has(item.id)).map(item => item.id);
    const key = missing.join(",");
    if (missing.length === 0 || key === prior) return composed;
    prior = key;
    composed = composePack({ ...input, omitted: [
      ...composed.omitted.filter(item => !item.detail?.startsWith("sponsor-directives: budget")),
      { reason: "budget_exceeded", detail: "sponsor-directives: budget omitted " + key
        + ". Before acting, GET /v1/inbox?unread_only=false&limit=100; continue with since=next_cursor and match target_id. Other inbox history is not active authority." },
    ] });
  }
}
