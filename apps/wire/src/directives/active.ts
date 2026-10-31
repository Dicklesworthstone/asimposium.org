import { composePack, neutralizeUntrustedBody, type PackActionCandidate, type PackCandidate } from "@asimposium/render";
import type { D1Database } from "@cloudflare/workers-types";
import { activeDirectivesUrl } from "@asimposium/contracts/directives";
import type { FellowCredentialBinding } from "../enrollment/service.ts";
import { ACTIVE_DIRECTIVE_AUTHORITY_SQL, ACTIVE_DIRECTIVE_SOURCE_SQL } from "./active-source.ts";

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
  binding: FellowCredentialBinding,
  problemId: string,
): Promise<ActiveSponsorDirectives> {
  const result = await db.prepare(`
    WITH authority AS (${ACTIVE_DIRECTIVE_AUTHORITY_SQL}),
    selected AS (SELECT * FROM (
      ${ACTIVE_DIRECTIVE_SOURCE_SQL} AND EXISTS (SELECT 1 FROM authority) AND d.verb IN ('focus', 'unfocus')
      ORDER BY n.seq DESC LIMIT 1
    )
    UNION ALL
    SELECT * FROM (
      ${ACTIVE_DIRECTIVE_SOURCE_SQL} AND EXISTS (SELECT 1 FROM authority) AND d.verb = 'forbid'
      ORDER BY n.seq ASC LIMIT ${MAX_PACK_FORBIDS + 1}
    )
    )
    SELECT selected.* FROM authority
    LEFT JOIN selected ON 1 = 1
    ORDER BY seq ASC, id ASC`)
    .bind(binding.fellowId, binding.sponsorId, problemId, binding.credentialId, binding.tokenHash)
    .all<DirectiveRow>();
  if (!result.success) throw new Error("SPONSOR_DIRECTIVES_UNAVAILABLE");
  if (result.results.length === 0) throw new Error("SPONSOR_DIRECTIVES_AUTHORITY_CHANGED");
  const focus = result.results.find((row) => row.id !== null && row.verb !== "forbid");
  const forbids = result.results.filter((row) => row.verb === "forbid");
  const selected = forbids.slice(0, MAX_PACK_FORBIDS);
  const active = [...(focus ? [focus] : []), ...selected];
  const firstOmitted = forbids[MAX_PACK_FORBIDS];
  const continuation = activeDirectivesUrl(problemId);
  const omitted = firstOmitted
    ? `sponsor-directives: additional active forbids are omitted, beginning with ${firstOmitted.id}. Before acting, GET ${continuation}; follow every next_url while has_more. On DIRECTIVE_SET_CHANGED, restart the read.`
    : null;
  const candidates: PackCandidate[] = [];
  const actions: PackActionCandidate[] = [];
  if (active.length > 0) {
    // The authoritative read excludes former-sponsor history and continues
    // through all constraints even when the pack budget excludes their text.
    actions.push({
      method: "GET",
      url: continuation,
      why: "Before acting, read omitted sponsor instructions. Follow every next_url while has_more; if DIRECTIVE_SET_CHANGED, restart. ACK confirms receipt without withdrawing instructions.",
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
        + ". Before acting, GET " + activeDirectivesUrl(input.problem)
        + "; follow every next_url while has_more. On DIRECTIVE_SET_CHANGED, restart." },
    ] });
  }
}
