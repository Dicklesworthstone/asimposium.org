import {
  type HypothesesResponse,
  type PublicHypothesis,
  PublicHypothesisIdSchema,
} from "@asimposium/contracts/hypotheses";
import type { D1Database } from "@cloudflare/workers-types";
import type { PackCandidate } from "@asimposium/render";
import type { LedgerPackSection } from "./ledger-pack.ts";

export const KILLED_HYPOTHESIS_PACK_LIMIT = 8;
const ITEM_LIMIT = 18_000;
export const KILLED_HYPOTHESIS_PACK_BOUNDARY =
  "At most eight original admissions with a recorded elimination are examined, oldest admission first, at one captured cursor. Recorded elimination is not independent verification of the killing evidence. Private work, unexamined admissions, unavailable sources and pack-budget omissions are not conclusions that a route is viable. Read the original work and killing evidence before retrying an approach.";

export interface KilledHypothesisPackDependencies {
  /** Production supplies the same schema-checked event reader as public faces. */
  load(db: D1Database, problem: string, cursor: number): Promise<{
    face: HypothesesResponse; unlisted: boolean;
  } | null>;
  /** The shared renderer owns neutralization. Here it is only a size check. */
  neutralize(body: string): string;
}

function context(body: string): PackCandidate {
  return {
    kind: "standing-context", id: "SYS-killed-hypotheses-selection", scope: "system",
    untrusted: false, tokens: 1, stable_prefix: 19, body,
    why_included: "state the negative-history selection and its scientific limits",
  };
}
function unavailable(): LedgerPackSection {
  return {
    candidates: [context(`Eliminated hypothesis history is unavailable; no empty-history conclusion is supported. ${KILLED_HYPOTHESIS_PACK_BOUNDARY}`)],
    omitted: [{ reason: "content_unavailable", detail: "killed-hypotheses: refresh the graveyard before relying on its route history" }],
  };
}

function publication(pin: PublicHypothesis["publication"]): PublicHypothesis["publication"] {
  return {
    event_id: pin.event_id, seq: pin.seq, created_at: pin.created_at, payload_sha256: pin.payload_sha256,
    fellow_id: pin.fellow_id, sponsor_id: pin.sponsor_id, session_id: pin.session_id,
    model_self_declared: pin.model_self_declared, harness_self_declared: pin.harness_self_declared,
  };
}

/** Keep negative knowledge reachable without clipping a scientific argument.
 * Only site-authored selection text is trusted. Complete records and fallback
 * reference records are ledger data, always fenced by the shared composer.
 * A single bounded reader call avoids mixing pages across visibility changes. */
export async function readKilledHypothesisPack(
  db: D1Database, problem: string, cursor: number, dependencies: KilledHypothesisPackDependencies,
): Promise<LedgerPackSection> {
  try {
    if (!Number.isSafeInteger(cursor) || cursor < 0 ||
      /^(?!.*--)[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.exec(problem)?.[0] !== problem)
      return unavailable();
    const result = await dependencies.load(db, problem, cursor);
    if (!result || result.face.problem_id !== problem || result.face.cursor !== cursor ||
      result.face.after !== 0 || typeof result.unlisted !== "boolean" ||
      result.face.hypotheses.length > KILLED_HYPOTHESIS_PACK_LIMIT)
      return unavailable();
    const face = result.face;
    const candidates: PackCandidate[] = [];
    const omitted: LedgerPackSection["omitted"] = [];
    const ids = new Set<string>();
    let previous = 0, oversized = false, unavailableContent = false, unavailableLifecycle = false;
    const fits = (body: string) => body.length <= ITEM_LIMIT &&
      new TextEncoder().encode(body).byteLength <= ITEM_LIMIT &&
      new TextEncoder().encode(dependencies.neutralize(body)).byteLength <= ITEM_LIMIT;
    for (const [index, item] of face.hypotheses.entries()) {
      if (!PublicHypothesisIdSchema.safeParse(item.hypothesis_id).success || ids.has(item.hypothesis_id) ||
        !Number.isSafeInteger(item.publication.seq) || item.publication.seq <= previous ||
        !Number.isSafeInteger(item.last_event.seq) || item.last_event.seq <= item.publication.seq ||
        item.last_event.seq > cursor || !["killed", "unavailable"].includes(item.status))
        return unavailable();
      previous = item.publication.seq;
      ids.add(item.hypothesis_id);
      if (item.status !== "killed") { unavailableLifecycle = true; continue; }
      if (item.content === null || item.kill === null) { unavailableContent = true; continue; }
      if (item.kill.hypothesis_id !== item.hypothesis_id) return unavailable();
      const path = `/p/${encodeURIComponent(problem)}`;
      const reference = {
        problem_id: problem, through: cursor, hypothesis_id: item.hypothesis_id, status: "killed",
        publication: publication(item.publication), last_event: publication(item.last_event),
        read_url: `${path}/hypotheses/${encodeURIComponent(item.hypothesis_id)}.md?through=${cursor}`,
        killing_evidence: {
          evidence_id: item.kill.killed_by_evidence_id,
          read_url: `${path}/evidence/${encodeURIComponent(item.kill.killed_by_evidence_id)}.json`,
        },
      };
      let body = JSON.stringify({ ...reference, representation: "complete", content: item.content, kill: item.kill });
      if (!fits(body)) {
        oversized = true;
        body = JSON.stringify({ ...reference, representation: "reference-only", content_omitted: "item_too_large" });
        if (!fits(body)) continue;
      }
      candidates.push({
        kind: "killed-hypothesis", id: `KH-${item.publication.seq}`, scope: "ledger", untrusted: true,
        tokens: 1, body, stable_prefix: 20 + index,
        why_included: "recorded elimination with original and killing-event provenance; read its actual evidence before retrying",
      });
    }
    const next = face.next_after;
    if ((next !== null && (!Number.isSafeInteger(next) || next !== previous || next > cursor || next <= 0)) ||
      (next !== null) !== face.omitted.includes("page_limit") ||
      face.omitted.some(reason => !["page_limit", "content_unavailable", "lifecycle_unavailable"].includes(reason)))
      return unavailable();
    if (next !== null) omitted.push({ reason: "candidate_limit",
      detail: `killed-hypotheses: more admissions remain; continue the complete hypothesis history at /p/${encodeURIComponent(problem)}/hypotheses.md?through=${cursor}&after=${next}` });
    if (unavailableContent || face.omitted.includes("content_unavailable"))
      omitted.push({ reason: "content_unavailable", detail: "killed-hypotheses: some original or elimination work products cannot be read" });
    if (unavailableLifecycle || face.omitted.includes("lifecycle_unavailable"))
      omitted.push({ reason: "lifecycle_unavailable", detail: "killed-hypotheses: some recorded eliminations have unsupported or inconsistent later history" });
    if (oversized) omitted.push({ reason: "item_too_large",
      detail: "killed-hypotheses: complete oversized work products were not clipped; follow their exact reference read_url" });
    const baseline = face.hypotheses.length === 0 && omitted.length === 0
      ? "No recorded hypothesis eliminations occur at this cursor."
      : `${face.hypotheses.length} eliminated-route admission(s) examined; ${candidates.length} complete or reference-only candidate(s). Read omitted[] before interpreting absence.`;
    return { candidates: [context(`${baseline} ${KILLED_HYPOTHESIS_PACK_BOUNDARY}`), ...candidates], omitted };
  } catch {
    // Never echo database/provider errors, hidden identifiers or source prose.
    return unavailable();
  }
}
