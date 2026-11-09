import {
  PublicLedgerProblemIdSchema,
  type SynthesisAnchor,
  SynthesisIdSchema,
  type SynthesisItem,
} from "@asimposium/contracts";
import { PublicHypothesisIdSchema } from "@asimposium/contracts/hypotheses";
import { ConflictIdSchema, conflictsListPath } from "@asimposium/contracts/conflicts";
import {
  type SynthesesListQuery,
  SynthesesListQuerySchema,
  type SynthesesListResponse,
  synthesesListPath,
} from "@asimposium/contracts/syntheses";

export const SYNTHESIS_NOTICE =
  "A synthesis is an attributed research digest frozen at a recorded cursor. Its narrative and closing declarations do not establish scientific standing or a problem resolution.";

export function synthesisOmissionText(reason: string): string {
  switch (reason) {
    case "page_limit": return "More publication positions remain. Continue at the same ledger snapshot; a page can advance even when its content is unavailable.";
    case "content_unavailable": return "Some publication content is unavailable under current visibility or source-integrity checks. An omitted record is not evidence that no synthesis was published.";
    case "byte_limit": return "Some complete publications exceed this page's source-byte budget. The source has not truncated their scientific text into an apparently complete record.";
    default: return reason;
  }
}

/** A synthesis is an immutable publication; its only version is @1. */
export function parseSynthesisTarget(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() !== value) return null;
  const id = value.endsWith("@1") ? value.slice(0, -2) : value;
  return SynthesisIdSchema.safeParse(id).success ? id : null;
}

export function synthesisPagePath(problem: string, target: string): string {
  return `/p/${encodeURIComponent(problem)}/syntheses/${encodeURIComponent(target)}`;
}

export function synthesisConsolePath(
  problem: string,
  selected?: string,
  query: SynthesesListQuery = {},
): string {
  const list = synthesesListPath(problem, "human", query);
  const params = new URLSearchParams(list.includes("?") ? list.slice(list.indexOf("?") + 1) : "");
  if (selected !== undefined) params.set("synthesis", selected);
  return `/console/problems/${encodeURIComponent(problem)}${params.size === 0 ? "" : `?${params}`}`;
}

/** The selection is a read affordance. It cannot supply the closing command. */
export function parseSynthesisConsoleQuery(value: Readonly<Record<string, unknown>>): {
  readonly selected?: string;
  readonly list: SynthesesListQuery;
} | null {
  const { synthesis, ...query } = value;
  if (synthesis !== undefined &&
      (typeof synthesis !== "string" || synthesis.trim() !== synthesis ||
       !SynthesisIdSchema.safeParse(synthesis).success)) return null;
  const parsed = SynthesesListQuerySchema.safeParse(query);
  if (!parsed.success) return null;
  return { ...(synthesis === undefined ? {} : { selected: synthesis }), list: parsed.data };
}

export function synthesisListSearch(problem: string, query: SynthesesListQuery): string {
  const path = synthesesListPath(problem, "json", query);
  return path.includes("?") ? path.slice(path.indexOf("?") + 1) : "";
}

function positive(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

/** Only verified route grammars become links. Unpinned or unsupported targets
 * remain visible as authored references, with their exact event when recorded. */
export function synthesisAnchorLinks(
  problem: string,
  anchor: SynthesisAnchor,
  coversThrough: number,
): { readonly human?: string; readonly agent?: string; readonly event?: string } {
  if (!PublicLedgerProblemIdSchema.safeParse(problem).success ||
      !Number.isSafeInteger(coversThrough) || coversThrough < 0) return {};
  const base = `/p/${encodeURIComponent(problem)}`;
  const version = positive(anchor.target_version) ? anchor.target_version : undefined;
  const event = positive(anchor.target_seq) && anchor.target_seq <= coversThrough
    ? `/r${base}/events/${anchor.target_seq}` : undefined;
  if (anchor.target_id.trim() !== anchor.target_id)
    return event === undefined ? {} : { event };
  let human: string | undefined;
  let agent: string | undefined;
  if (anchor.target_kind === "claim" && /^C-[1-9][0-9]*$/.test(anchor.target_id) && version !== undefined) {
    human = `${base}/claims/${encodeURIComponent(`${anchor.target_id}@${version}`)}?through=${coversThrough}`;
  } else if (anchor.target_kind === "hypothesis" && PublicHypothesisIdSchema.safeParse(anchor.target_id).success &&
      (version === undefined || version === 1)) {
    human = `${base}/hypotheses/${encodeURIComponent(anchor.target_id)}?through=${coversThrough}`;
  } else if ((anchor.target_kind === "evidence" || anchor.target_kind === "review") &&
      new RegExp(`^${anchor.target_kind === "evidence" ? "E" : "R"}-[0-9A-HJKMNP-TV-Z]{1,78}$`).test(anchor.target_id) &&
      version === 1) {
    human = `/r${base}/${anchor.target_kind === "evidence" ? "evidence" : "reviews"}/${encodeURIComponent(anchor.target_id)}`;
  } else if (anchor.target_kind === "gap" && /^G-[1-9][0-9]*$/.test(anchor.target_id)) {
    human = `${base}/gaps?through=${coversThrough}&target=${encodeURIComponent(anchor.target_id)}`;
  } else if (anchor.target_kind === "conflict" && ConflictIdSchema.safeParse(anchor.target_id).success) {
    human = conflictsListPath(problem, "human", { through: coversThrough, target: anchor.target_id });
  } else if (anchor.target_kind === "citation" && /^L-[0-9]+$/.test(anchor.target_id) && version !== undefined) {
    agent = `${base}/citations/${encodeURIComponent(`${anchor.target_id}@${version}`)}.json?through=${coversThrough}`;
  } else if (anchor.target_kind === "statement" && anchor.target_id === problem && version !== undefined) {
    human = `${base}/statements/${version}?through=${coversThrough}`;
  }
  return {
    ...(human === undefined ? {} : { human }),
    ...(agent === undefined ? {} : { agent }),
    ...(event === undefined ? {} : { event }),
  };
}

/** This is a display prerequisite, never a substitute for the authoritative
 * sponsor preview or the Worker's result-review and resolution checks. */
export function selectableClosingSynthesis(item: SynthesisItem): boolean {
  return item.closing_resolution !== undefined && item.body_md.length <= 8192;
}

/** Send only selection metadata into the client control. Large scientific
 * bodies and omission narratives are read only by the exact preview action. */
export interface SynthesisSelectionPage {
  readonly problem_id: string;
  readonly cursor: number;
  readonly before: number | null;
  readonly next_before: number | null;
  readonly omitted: readonly string[];
  readonly choices: readonly {
    readonly synthesis_id: string;
    readonly seq: number;
    readonly covers_through: number;
    readonly authoring_principal: string;
    readonly created_at: string;
    readonly closing?: Pick<NonNullable<SynthesisItem["closing_resolution"]>, "direction" | "result_claim">;
    readonly can_preview: boolean;
  }[];
}

export function synthesisSelectionPage(face: SynthesesListResponse): SynthesisSelectionPage {
  return {
    problem_id: face.problem_id, cursor: face.cursor, before: face.before,
    next_before: face.next_before, omitted: face.omitted,
    choices: face.syntheses.map((item) => ({
      synthesis_id: item.synthesis_id, seq: item.seq, covers_through: item.covers_through,
      authoring_principal: item.authoring_principal, created_at: item.created_at,
      ...(item.closing_resolution === undefined ? {} : { closing: {
        direction: item.closing_resolution.direction,
        result_claim: item.closing_resolution.result_claim,
      } }),
      can_preview: selectableClosingSynthesis(item),
    })),
  };
}
