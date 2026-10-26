import {
  ClaimFaceResponseSchema,
  type HypothesisEvidenceItemResponse,
  HypothesisEvidenceItemResponseSchema,
  PUBLIC_RESOURCE_REGISTRY,
  PublicLedgerProblemIdSchema,
  type PublicResourceKind,
} from "@asimposium/contracts";
import { PublicHypothesisIdSchema } from "@asimposium/contracts/hypotheses";
import { type EventTailPage, EventTailResponseSchema } from "@asimposium/contracts/event-tail";
import {
  type NeutralizationFinding,
  type PreparedProjection,
  type Projection,
  prepareProjection,
} from "@asimposium/render";
import { eventHistoryMatchesQuery } from "./event-history";

export interface PublicRecordTarget {
  readonly kind: PublicResourceKind;
  readonly title: string;
  readonly problemId: string;
  readonly recordId?: string;
  readonly humanPath: string;
  readonly jsonPath: string;
  readonly markdownPath: string;
}

/** Resolve only registered public paths; a catch-all must not become a private API proxy. */
export function resolvePublicRecord(slug: readonly string[]): PublicRecordTarget | null {
  if (slug.length < 3 || slug.some((part) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(part))) return null;
  const parts = ["r", ...slug];
  for (const entry of PUBLIC_RESOURCE_REGISTRY) {
    if (!entry.human_route_key.startsWith("/r/") || entry.json_url === undefined) continue;
    const pattern = entry.human_route_key.slice(1).split("/");
    if (pattern.length !== parts.length) continue;
    const variables: Record<string, string> = {};
    let matches = true;
    for (let index = 0; index < pattern.length; index += 1) {
      const token = pattern[index] as string;
      const part = parts[index] as string;
      if (token.startsWith(":")) variables[token.slice(1)] = part;
      else if (token !== part) matches = false;
    }
    if (!matches || !PublicLedgerProblemIdSchema.safeParse(variables.id).success) continue;
    if (entry.kind === "evidence" && !/^E-[0-9A-HJKMNP-TV-Z]{1,78}$/.test(variables.eid ?? "")) return null;
    if (entry.kind === "hypothesis" && !PublicHypothesisIdSchema.safeParse(variables.hid).success) return null;
    for (const key of ["version", "seq"]) {
      const value = variables[key];
      if (value !== undefined && (!/^[1-9][0-9]{0,15}$/.test(value) || !Number.isSafeInteger(Number(value)))) return null;
    }
    if (variables.seq !== undefined) variables.since = String(Number(variables.seq) - 1);
    const fill = (template: string) => template.replace(/:([A-Za-z]+)/g, (_match, key: string) => encodeURIComponent(variables[key] ?? ""));
    const recordId = variables.eid ?? variables.rid ?? variables.hid ?? variables.gid ?? variables.cid ?? variables.did ?? variables.qid ?? variables.relId ?? variables.seq;
    return {
      kind: entry.kind,
      title: entry.title,
      problemId: variables.id as string,
      ...(recordId === undefined ? {} : { recordId }),
      humanPath: `/${parts.map(encodeURIComponent).join("/")}`,
      jsonPath: fill(entry.json_url),
      markdownPath: fill(entry.agent_markdown_url),
    };
  }
  return null;
}

export type PublicRecord =
  | { readonly kind: "event"; readonly face: EventTailPage }
  | { readonly kind: "hypothesis-evidence"; readonly face: HypothesisEvidenceItemResponse }
  | { readonly kind: "projection"; readonly face: PreparedProjection };

const FINDING_MARKERS = new Set(["asimp-control-comment", "envelope-key-forgery", "fence-extended", "active-html"]);

function canonicalFindings(value: unknown): readonly NeutralizationFinding[] | null {
  if (!Array.isArray(value) || value.length > FINDING_MARKERS.size) return null;
  const seen = new Set<string>();
  for (const finding of value) {
    if (
      typeof finding !== "object" || finding === null ||
      !FINDING_MARKERS.has(finding.marker) || seen.has(finding.marker) ||
      !Number.isSafeInteger(finding.count) || finding.count < 1 ||
      Object.keys(finding).some((key) => key !== "marker" && key !== "count")
    ) return null;
    seen.add(finding.marker);
  }
  return value as NeutralizationFinding[];
}

/**
 * Consume the existing evidence/claim contracts and the shared projection
 * validator. Never synthesize a cursor, problem, item id or content envelope
 * for a typed face that has no projection renderer.
 */
export function parsePublicRecord(value: unknown, target: PublicRecordTarget): PublicRecord | null {
  if (target.kind === "event") {
    const page = EventTailResponseSchema.safeParse(value);
    const sequence = Number(target.recordId);
    if (!page.success || !Number.isSafeInteger(sequence) || sequence < 1) return null;
    return page.data.events.length === 1 && page.data.events[0]?.seq === sequence &&
      eventHistoryMatchesQuery(page.data, target.problemId, { since: sequence - 1, limit: 1 })
      ? { kind: "event", face: page.data }
      : null;
  }
  if (target.kind === "evidence") {
    const evidence = HypothesisEvidenceItemResponseSchema.safeParse(value);
    if (evidence.success) {
      return evidence.data.problem_id === target.problemId && evidence.data.evidence_id === target.recordId
        ? { kind: "hypothesis-evidence", face: evidence.data }
        : null;
    }
  }
  if (target.kind === "evidence" || target.kind === "review") {
    const claim = ClaimFaceResponseSchema.safeParse(value);
    if (!claim.success || claim.data.problem !== target.problemId || !claim.data.items.some((item) => item.id === target.recordId && item.kind === (target.kind === "evidence" ? "claim-evidence" : "claim-review"))) return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    raw.face !== "json" || raw.problem !== target.problemId ||
    typeof raw.fingerprint !== "string" || !/^fnv1a64:[0-9a-f]{16}$/.test(raw.fingerprint) ||
    raw.session !== undefined || raw.budget_tokens !== undefined || raw.tokens_estimate !== undefined
  ) return null;
  try {
    const projection = prepareProjection(value as Projection);
    if (
      projection.viewer?.audience === "session" ||
      projection.items.some((item) => item.scope === "workshop") ||
      projection.next_actions.some((action) => action.method !== "GET")
    ) return null;
    const originalItems = raw.items as Record<string, unknown>[];
    const items = [];
    for (const [index, item] of projection.items.entries()) {
      const original = canonicalFindings(originalItems[index]?.neutralized);
      if (original === null) return null;
      // The response is already prepared. Preserve its sanitizer report and
      // canonical fingerprint; a second preparation must not erase that provenance.
      const findings = [...original];
      for (const finding of item.neutralized) {
        if (!findings.some((existing) => existing.marker === finding.marker)) findings.push(finding);
      }
      items.push({ ...item, neutralized: findings });
    }
    return {
      kind: "projection",
      face: {
        ...projection,
        fingerprint: raw.fingerprint,
        items,
        neutralized: items.flatMap((item) => item.neutralized.map((finding) => ({ item_id: item.id, ...finding }))),
      },
    };
  } catch {
    return null;
  }
}
