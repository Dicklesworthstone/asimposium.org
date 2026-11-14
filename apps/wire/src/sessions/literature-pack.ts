import { PublicLedgerProblemIdSchema } from "@asimposium/contracts";
import { CITATIONS_SCHEMA_ID, CitationsListResponseSchema } from "@asimposium/contracts/citations";
import {
  CLAIMS_LIST_PAGE_SIZE,
  ClaimsListResponseSchema,
  claimsListMatchesQuery,
  claimsListPath,
} from "@asimposium/contracts/claims-list";
import type { PackCandidate } from "@asimposium/render";
import type { D1Database } from "@cloudflare/workers-types";
import type { loadProblemCitations } from "../ledger/citations.ts";
import type { loadClaimsList } from "../ledger/claims-list-read.ts";

const CITATION_LIMIT = 20;
const CLAIM_PAGES = 2;
const MAX_ITEM_CHARACTERS = 18000;

export interface LiteraturePackSection {
  candidates: PackCandidate[];
  omitted: { reason: string; detail: string }[];
}

export interface LiteraturePackDependencies {
  citations: typeof loadProblemCitations;
  claims: typeof loadClaimsList;
  neutralize(body: string): string;
}

export const LITERATURE_PACK_NOTICE =
  "Published citations and literature/novelty claim summaries at this problem cursor. " +
  "Citation unanchored and model_memory fields preserve the recorded sourcing limits; " +
  "retrieved provenance is an author declaration, not a platform source check. " +
  "Claim kind and stale are not scientific verdicts. Open each exact source for full " +
  "attribution, evidence, objections and standing. At most twenty citation heads and " +
  "sixteen claim heads are examined; omitted entries and continuations describe the rest.";

function appendItem(
  section: LiteraturePackSection,
  candidate: PackCandidate,
  reference: object,
  source: string,
  neutralize: LiteraturePackDependencies["neutralize"],
): void {
  if (
    candidate.body.length > MAX_ITEM_CHARACTERS ||
    neutralize(candidate.body).length > MAX_ITEM_CHARACTERS
  ) {
    section.omitted.push({
      reason: "item_too_large",
      detail: `literature:${candidate.id}; complete public record: ${source}`,
    });
    // Preserve the exact read, never a clipped assertion or citation excerpt.
    candidate = {
      ...candidate,
      body: JSON.stringify({ ...reference, source, content_omitted: "whole-record-size-limit" }),
    };
  }
  section.candidates.push(candidate);
}

async function citationSection(
  db: D1Database,
  problem: string,
  cursor: number,
  dependencies: LiteraturePackDependencies,
): Promise<LiteraturePackSection> {
  const section: LiteraturePackSection = { candidates: [], omitted: [] };
  try {
    const result = await dependencies.citations(db, problem, {
      through: cursor,
      limit: CITATION_LIMIT,
    });
    const { problem: scope, ...page } = result;
    if (scope?.id !== problem) throw new Error("LITERATURE_CITATION_SCOPE");
    const face = CitationsListResponseSchema.parse({
      schema: CITATIONS_SCHEMA_ID,
      problem_id: problem,
      ...page,
    });
    if (
      face.cursor !== cursor ||
      face.after !== 0 ||
      face.unanchored !== null ||
      face.citations.length > CITATION_LIMIT
    )
      throw new Error("LITERATURE_CITATION_SCOPE");
    section.omitted.push(...face.omitted.map((detail) => ({ reason: "source_omission", detail })));
    if (face.next_after !== null)
      section.omitted.push({
        reason: "candidate_limit",
        detail: `literature citations: continue /p/${encodeURIComponent(problem)}/citations.md?through=${cursor}&after=${face.next_after}&limit=${CITATION_LIMIT}`,
      });
    for (const [index, item] of face.citations.entries()) {
      const target = `${item.citation_id}@${item.version}`;
      const source = `/p/${encodeURIComponent(problem)}/citations/${encodeURIComponent(item.citation_id)}@${item.version}.md?through=${cursor}`;
      const { screening_notice: screeningNotice, ...citation } = item;
      appendItem(
        section,
        {
          kind: "citation",
          id: target,
          scope: "ledger",
          untrusted: true,
          tokens: 1,
          body: JSON.stringify({ ...citation, source }),
          ...(screeningNotice === undefined ? {} : { screening_notice: screeningNotice }),
          why_included:
            "committed public citation version at the pack cursor; sourcing declarations and unanchored flags are not verification",
          stable_prefix: 20 + 2 * index,
        },
        { citation_id: item.citation_id, version: item.version },
        source,
        dependencies.neutralize,
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message === "PUBLIC_SCREENING_RECEIPT_UNAVAILABLE")
      throw error;
    return {
      candidates: [],
      omitted: [
        {
          reason: "literature_citations_unavailable",
          detail: "Canonical public citation history is unavailable; retry the literature pack.",
        },
      ],
    };
  }
  return section;
}

async function claimSection(
  db: D1Database,
  problem: string,
  cursor: number,
  dependencies: LiteraturePackDependencies,
): Promise<LiteraturePackSection> {
  const section: LiteraturePackSection = { candidates: [], omitted: [] };
  try {
    let after = 0;
    let filtered = false;
    const seen = new Set<string>();
    for (let page = 0; page < CLAIM_PAGES; page++) {
      const query = { through: cursor, after };
      const result = await dependencies.claims(db, problem, query);
      const face = ClaimsListResponseSchema.parse(result.face);
      if (!claimsListMatchesQuery(problem, query, face)) throw new Error("LITERATURE_CLAIM_SCOPE");
      for (const claim of face.claims) {
        if (seen.has(claim.id)) throw new Error("LITERATURE_CLAIM_DUPLICATE");
        seen.add(claim.id);
        if (claim.kind !== "literature-claim" && claim.kind !== "novelty-claim") {
          filtered = true;
          continue;
        }
        const target = `${claim.id}@${claim.version}`;
        const source = `/p/${encodeURIComponent(problem)}/claims/${encodeURIComponent(claim.id)}@${claim.version}.md?through=${cursor}`;
        const { screening_notice: screeningNotice, ...summary } = claim;
        appendItem(
          section,
          {
            kind: claim.kind,
            id: target,
            scope: "ledger",
            untrusted: true,
            tokens: 1,
            body: JSON.stringify({ ...summary, source }),
            ...(screeningNotice === undefined ? {} : { screening_notice: screeningNotice }),
            why_included:
              "digest-checked latest literature or novelty claim publication at this cursor; read its exact source for full attribution and scientific standing",
            // Alternate citations and claims so bibliography volume cannot
            // consume the entire profile before any scientific context appears.
            stable_prefix: 21 + 2 * section.candidates.length,
          },
          { id: claim.id, version: claim.version, kind: claim.kind },
          source,
          dependencies.neutralize,
        );
      }
      for (const reason of face.omitted.filter((reason) => reason !== "page_limit"))
        section.omitted.push({ reason, detail: "literature: public claim summaries" });
      if (face.next_after === null) break;
      // Continuation advances over withheld heads too. The final visible item
      // may precede scanned_through or the entire page may be unavailable.
      after = face.next_after;
      if (page === CLAIM_PAGES - 1)
        section.omitted.push({
          reason: "candidate_limit",
          detail: `literature: examined at most ${CLAIM_PAGES * CLAIMS_LIST_PAGE_SIZE} claim heads; continue ${claimsListPath(problem, "md", { through: cursor, after })}`,
        });
    }
    if (filtered)
      section.omitted.push({
        reason: "profile_summary",
        detail: `literature: other claim kinds excluded; complete collection ${claimsListPath(problem, "md", { through: cursor })}`,
      });
  } catch (error) {
    if (error instanceof Error && error.message === "PUBLIC_SCREENING_RECEIPT_UNAVAILABLE")
      throw error;
    return {
      candidates: [],
      omitted: [
        {
          reason: "literature_claims_unavailable",
          detail: "Canonical public claim summaries are unavailable; retry the literature pack.",
        },
      ],
    };
  }
  return section;
}

/** Reuse public event/digest/visibility readers; this adapter never reads a
 * workshop, retained projection body, private draft, or author narrative.
 * Each bounded source can degrade without erasing the other source's work. */
export async function readLiteraturePack(
  db: D1Database,
  problem: string,
  cursor: number,
  dependencies: LiteraturePackDependencies,
): Promise<LiteraturePackSection> {
  if (
    !PublicLedgerProblemIdSchema.safeParse(problem).success ||
    !Number.isSafeInteger(cursor) ||
    cursor < 0
  )
    throw new Error("LITERATURE_PACK_QUERY_INVALID");
  const [citations, claims] = await Promise.all([
    citationSection(db, problem, cursor, dependencies),
    claimSection(db, problem, cursor, dependencies),
  ]);
  const candidates = [...citations.candidates, ...claims.candidates];
  const omitted = [...citations.omitted, ...claims.omitted];
  return {
    candidates: [
      {
        kind: "standing-context",
        id: "SYS-literature-context",
        scope: "system",
        untrusted: false,
        tokens: 1,
        body: LITERATURE_PACK_NOTICE,
        why_included: "distinguish source provenance and literature summaries from verification",
        stable_prefix: 19,
      },
      ...candidates,
      ...(candidates.length === 0 && omitted.length === 0
        ? [
            {
              kind: "standing-context",
              id: "SYS-literature-empty",
              scope: "system" as const,
              untrusted: false,
              tokens: 1,
              body: "No readable published citations, literature claims or novelty claims are available at this problem cursor. This is not a claim that no relevant literature exists.",
              why_included: "state the literature baseline without inventing a source or finding",
              stable_prefix: 20,
            },
          ]
        : []),
    ],
    omitted,
  };
}
