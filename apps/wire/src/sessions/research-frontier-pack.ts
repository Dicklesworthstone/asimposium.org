import { activeDirectivesUrl } from "@asimposium/contracts/directives";
import { HypothesesResponseSchema } from "@asimposium/contracts/hypotheses";
import { type ProofGapRecord, ProofGapsResponseSchema } from "@asimposium/contracts/proof-gaps";
import {
  composePack,
  neutralizeUntrustedBody,
  type PackActionCandidate,
  type PackCandidate,
} from "@asimposium/render";
import type { D1Database } from "@cloudflare/workers-types";
import { hypothesisItemPath } from "../ledger/hypotheses-face.ts";
import { loadLiveHypotheses } from "../ledger/hypotheses-service.ts";
import { loadProofGaps } from "../ledger/proof-gaps-service.ts";

export const FRONTIER_ITEM_LIMIT = 3;
export const FRONTIER_GAP_MAX_PAGES = 2;
const MAX_ITEM_BYTES = 18_000;

export interface ResearchFrontierPackSection {
  candidates: PackCandidate[];
  actions: PackActionCandidate[];
  omitted: { reason: string; detail: string }[];
}
export interface ResearchFrontierPackDependencies {
  hypotheses: typeof loadLiveHypotheses;
  gaps: typeof loadProofGaps;
}

function collection(
  problem: string,
  cursor: number,
  kind: "hypotheses" | "gaps" | "questions",
): string {
  return `/p/${encodeURIComponent(problem)}/${kind}.md?through=${cursor}`;
}
function fits(body: string): boolean {
  if (body.length > MAX_ITEM_BYTES || new TextEncoder().encode(body).length > MAX_ITEM_BYTES)
    return false;
  return new TextEncoder().encode(neutralizeUntrustedBody(body).text).length <= MAX_ITEM_BYTES;
}
function sourceAction(url: string, why: string): PackActionCandidate {
  return { method: "GET", url, why, public_read: true };
}

/** The canonical live selector excludes settled routes before its bound, and
 * retains unavailable candidates. It does not infer activity from a mutable
 * projection or treat an unreadable route as evidence of an empty frontier. */
async function readHypotheses(
  db: D1Database,
  problem: string,
  cursor: number,
  read: ResearchFrontierPackDependencies["hypotheses"],
): Promise<ResearchFrontierPackSection> {
  const source = collection(problem, cursor, "hypotheses");
  const section: ResearchFrontierPackSection = { candidates: [], actions: [], omitted: [] };
  try {
    const result = await read(db, problem, cursor);
    if (result === null) throw new Error("hypothesis source unavailable");
    const page = HypothesesResponseSchema.parse(result.face);
    if (
      page.problem_id !== problem ||
      page.cursor !== cursor ||
      page.after !== 0 ||
      page.hypotheses.length > FRONTIER_ITEM_LIMIT
    )
      throw new Error("hypothesis source changed");
    for (const reason of page.omitted.filter((reason) => reason !== "page_limit"))
      section.omitted.push({ reason: `active_hypotheses_${reason}`, detail: source });
    if (page.next_after !== null)
      section.omitted.push({
        reason: "candidate_limit",
        detail: `active-hypotheses: more admission positions remain; read ${source}&after=${page.next_after}`,
      });
    for (const item of page.hypotheses) {
      if (item.status !== "active" || item.content === null) {
        if (!section.omitted.some((entry) => entry.reason === "active_hypotheses_unavailable"))
          section.omitted.push({ reason: "active_hypotheses_unavailable", detail: source });
        continue;
      }
      const reference = {
        hypothesis_id: item.hypothesis_id,
        status: item.status,
        publication: item.publication,
        last_event: item.last_event,
        cursor,
        source: hypothesisItemPath(problem, item.hypothesis_id, "md", cursor),
      };
      let body = JSON.stringify({
        ...reference,
        representation: "headline",
        route: item.content.route,
        mechanism: item.content.mechanism,
        falsifier: item.content.falsifier,
        expected_evidence: item.content.expected_evidence,
        discriminating_predictions: item.content.discriminating_predictions,
        origin: item.content.origin,
      });
      if (!fits(body)) {
        body = JSON.stringify({ ...reference, representation: "reference-only" });
        section.omitted.push({ reason: "item_too_large", detail: `active-hypotheses: ${source}` });
      }
      section.candidates.push({
        kind: "active-hypothesis",
        // Some valid historical hypothesis IDs exceed the renderer's item-key
        // bound. The exact identity remains intact in the record and its URL.
        id: `AH-${item.publication.seq}`,
        scope: "ledger",
        untrusted: true,
        tokens: 1,
        body,
        ...(item.screening_notice === undefined ? {} : { screening_notice: item.screening_notice }),
        why_included:
          "recorded active attack route at this cursor, not scientific support or a work reservation; read the complete publication before pursuing it",
        stable_prefix: 50 + section.candidates.length,
      });
    }
    if (section.candidates.length > 0)
      section.omitted.push({
        reason: "profile_summary",
        detail: `active-hypotheses: full work products and lifecycle details remain at ${source}`,
      });
  } catch {
    section.candidates = [];
    section.omitted = [
      {
        reason: "active_hypotheses_unavailable",
        detail: `Active-route history could not be verified; this is not an empty frontier. Retry ${source}`,
      },
    ];
  }
  if (section.candidates.length || section.omitted.length)
    section.actions.push(
      sourceAction(
        source,
        "Read recorded attack routes and their lifecycle at this ledger snapshot; follow pagination.",
      ),
    );
  return section;
}

/** Open obligations can follow many settled filings. Traverse a bounded
 * prefix of the existing public history, preserving unknown content/history
 * as an omission rather than calling it a settled or absent obligation. */
async function readGaps(
  db: D1Database,
  problem: string,
  cursor: number,
  read: ResearchFrontierPackDependencies["gaps"],
): Promise<ResearchFrontierPackSection> {
  const source = collection(problem, cursor, "gaps");
  const section: ResearchFrontierPackSection = { candidates: [], actions: [], omitted: [] };
  const selected: (ProofGapRecord & { content: NonNullable<ProofGapRecord["content"]> })[] = [];
  const seen = new Set<string>();
  let after = 0;
  let continuation: number | null = null;
  try {
    for (let pageNumber = 0; pageNumber < FRONTIER_GAP_MAX_PAGES; pageNumber++) {
      const result = await read(db, problem, { through: cursor, after });
      const page = ProofGapsResponseSchema.parse(result.face);
      if (
        page.problem_id !== problem ||
        page.cursor !== cursor ||
        page.after !== after ||
        page.target !== null
      )
        throw new Error("proof-gap source changed");
      let previous = after;
      for (const gap of page.gaps) {
        if (
          gap.gap_id !== `G-${gap.filing.seq}` ||
          gap.filing.seq <= previous ||
          gap.filing.seq > gap.last_event.seq ||
          gap.last_event.seq > cursor ||
          seen.has(gap.gap_id)
        )
          throw new Error("proof-gap page repeated or unordered");
        previous = gap.filing.seq;
        seen.add(gap.gap_id);
        if (gap.status === "unavailable" || gap.content === null) {
          if (!section.omitted.some((entry) => entry.reason === "open_proof_gaps_unavailable"))
            section.omitted.push({ reason: "open_proof_gaps_unavailable", detail: source });
        } else if (gap.status === "open") selected.push({ ...gap, content: gap.content });
      }
      for (const reason of page.omitted.filter((reason) => reason !== "page_limit")) {
        const key = `open_proof_gaps_${reason}`;
        if (!section.omitted.some((entry) => entry.reason === key))
          section.omitted.push({ reason: key, detail: source });
      }
      if (
        (page.next_after !== null &&
          (page.next_after !== previous || page.next_after <= after || page.next_after > cursor)) ||
        (page.next_after !== null) !== page.omitted.includes("page_limit")
      )
        throw new Error("proof-gap continuation changed");
      continuation = page.next_after;
      if (selected.length >= FRONTIER_ITEM_LIMIT || continuation === null) break;
      after = continuation;
    }
    const lastSelected = selected[FRONTIER_ITEM_LIMIT - 1];
    if (selected.length > FRONTIER_ITEM_LIMIT && lastSelected !== undefined)
      continuation = lastSelected.filing.seq;
    if (continuation !== null)
      section.omitted.push({
        reason: "candidate_limit",
        detail: `open-proof-gaps: more filing positions remain; read ${source}&after=${continuation}`,
      });
    for (const gap of selected.slice(0, FRONTIER_ITEM_LIMIT)) {
      const reference = {
        gap_id: gap.gap_id,
        status: gap.status,
        filing: gap.filing,
        last_event: gap.last_event,
        cursor,
        source: `${source}&target=${gap.gap_id}`,
        target_read: `/p/${encodeURIComponent(problem)}/claims/${gap.content.target_claim_id}@${gap.content.target_version}.md?through=${cursor}`,
      };
      let body = JSON.stringify({ ...reference, content: gap.content });
      if (!fits(body)) {
        body = JSON.stringify({ ...reference, content_omitted: "whole-record-size-limit" });
        section.omitted.push({ reason: "item_too_large", detail: `open-proof-gaps: ${source}` });
      }
      section.candidates.push({
        kind: "open-proof-gap",
        id: gap.gap_id,
        scope: "ledger",
        untrusted: true,
        tokens: 1,
        body,
        ...(gap.screening_notice === undefined ? {} : { screening_notice: gap.screening_notice }),
        why_included:
          "recorded unresolved obligation on an exact claim version; neither proof of a defect nor a claim that the current version or work is available",
        stable_prefix: 55 + section.candidates.length,
      });
    }
  } catch {
    section.candidates = [];
    section.omitted = [
      {
        reason: "open_proof_gaps_unavailable",
        detail: `Proof-gap history could not be verified; no gap-free conclusion is supported. Retry ${source}`,
      },
    ];
  }
  if (section.candidates.length || section.omitted.length)
    section.actions.push(
      sourceAction(
        source,
        "Read proof-gap filings and recorded settlements at this ledger snapshot; a settlement is not independent verification.",
      ),
    );
  return section;
}

export async function readResearchFrontierPack(
  db: D1Database,
  problem: string,
  cursor: number,
  dependencies: ResearchFrontierPackDependencies = {
    hypotheses: loadLiveHypotheses,
    gaps: loadProofGaps,
  },
): Promise<ResearchFrontierPackSection> {
  const [hypotheses, gaps] = await Promise.all([
    readHypotheses(db, problem, cursor, dependencies.hypotheses),
    readGaps(db, problem, cursor, dependencies.gaps),
  ]);
  return {
    candidates: [...hypotheses.candidates, ...gaps.candidates],
    actions: [...hypotheses.actions, ...gaps.actions],
    omitted: [...hypotheses.omitted, ...gaps.omitted],
  };
}

/** Compose the three arrival source families and private sponsor-instruction
 * disclosures together. Only newly omitted families/IDs enlarge the mandatory
 * metadata; each pass adds at least one of at most 3 + directive-count entries.
 * Derived generic omissions are regenerated, never fed back as input. The
 * fixed point depends on that finite set, not changing serialization bytes. */
export function accountArrivalContextOmissions(
  input: Parameters<typeof composePack>[0],
  initial: ReturnType<typeof composePack>,
): ReturnType<typeof composePack> {
  const families = [
    ["research-question", "public-questions", "questions", "whole unanswered requests"],
    ["active-hypothesis", "active-hypotheses", "hypotheses", "whole records"],
    ["open-proof-gap", "open-proof-gaps", "gaps", "whole records"],
  ] as const;
  const directives = input.candidates.filter((item) => item.kind === "sponsor-directive");
  const base = initial.omitted.filter((item) => {
    if (item.reason === "budget_exceeded") {
      if (item.detail === undefined || item.detail.startsWith("sponsor-directives: budget"))
        return false;
      if (families.some(([, marker]) => item.detail?.startsWith(`${marker}: budget`))) return false;
    }
    // Keep declared omissions and earlier detailed section accounting. Generic
    // permission/profile/empty markers belong to composePack's fresh output.
    return (
      item.detail !== undefined ||
      input.omitted?.some(
        (declared) => declared.reason === item.reason && declared.detail === undefined,
      )
    );
  });
  const baseOmitted = [...new Map(base.map((item) => [JSON.stringify(item), item])).values()];
  const omittedFamilies = new Set<string>();
  const omittedDirectives = new Set<string>();
  let pack = composePack({ ...input, omitted: baseOmitted });
  for (let pass = 0; pass <= families.length + directives.length; pass++) {
    const included = new Set(pack.items.map((item) => item.id));
    let changed = false;
    for (const [kind, marker] of families) {
      if (
        !omittedFamilies.has(marker) &&
        input.candidates.some((item) => item.kind === kind && !included.has(item.id))
      ) {
        omittedFamilies.add(marker);
        changed = true;
      }
    }
    for (const item of directives) {
      if (!included.has(item.id) && !omittedDirectives.has(item.id)) {
        omittedDirectives.add(item.id);
        changed = true;
      }
    }
    if (!changed) return pack;
    const directiveIds = directives
      .filter((item) => omittedDirectives.has(item.id))
      .map((item) => item.id);
    pack = composePack({
      ...input,
      omitted: [
        ...baseOmitted,
        ...families
          .filter(([, marker]) => omittedFamilies.has(marker))
          .map(([, marker, kind, description]) => ({
            reason: "budget_exceeded",
            detail: `${marker}: budget omitted ${description}; read ${collection(input.problem, input.cursor, kind)}`,
          })),
        ...(directiveIds.length === 0
          ? []
          : [
              {
                reason: "budget_exceeded",
                detail:
                  "sponsor-directives: budget omitted " +
                  directiveIds.join(",") +
                  ". Before acting, GET " +
                  activeDirectivesUrl(input.problem) +
                  "; follow every next_url while has_more. On DIRECTIVE_SET_CHANGED, restart.",
              },
            ]),
      ],
    });
  }
  throw new Error("ARRIVAL_OMISSION_ACCOUNTING_DID_NOT_SETTLE");
}
