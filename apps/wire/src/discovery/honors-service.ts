import {
  encodeNowPageCursor,
  type HonorsQuery,
  HonorsQuerySchema,
  type HonorsResponse,
  HonorsResponseSchema,
  parseNowPageCursor,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { sha256Hex } from "../krater/krater.ts";
import { hiddenByContentControlSql } from "../krater/public-content.ts";
import { readScientificDispositions } from "../ledger/scientific-disposition.ts";
import { readHonorsDagContexts } from "./honors-context.ts";
import { honorsCandidateVersion } from "./honors-eligibility.ts";
import {
  type HonorsClaimRecord,
  type HonorsResultRecord,
  prepareHonorsSourceCheck,
  readHonorsClaim,
  readHonorsProblem,
  readHonorsResolution,
} from "./honors-provenance.ts";

interface ProblemRow {
  id: string;
  public_seq: number;
  has_resolution: number;
}

/** The chronological recognition record is derived from current, source-checked
 * scientific standing and actual published settlements. Mutable status labels,
 * activity, arbitrary evidence and current enrollment metadata grant no credit. */
export async function loadHonorsRecord(
  db: D1Database,
  query: HonorsQuery = {},
): Promise<HonorsResponse> {
  const parsedQuery = HonorsQuerySchema.parse(query);
  const boundary =
    parsedQuery.before === undefined ? undefined : parseNowPageCursor(parsedQuery.before);
  if (parsedQuery.before !== undefined && boundary === undefined)
    throw new Error("Invalid Honors cursor");
  const cursorRow = await db
    .prepare("SELECT cursor FROM public_cursor WHERE singleton = 1")
    .first<{ cursor: number }>();
  if (!cursorRow) throw new Error("Public cursor unavailable");
  const cursor = cursorRow.cursor;
  const candidateItems: HonorsResultRecord[] = [];
  const retain = (record: HonorsResultRecord): void => {
    const item = record.item;
    if (boundary !== undefined) {
      const [, time, problem, sequence, id] = boundary;
      const afterBoundary =
        item.settled_at !== time
          ? item.settled_at < time
          : item.problem_id !== problem
            ? item.problem_id > problem
            : item.sequence !== sequence
              ? item.sequence < sequence
              : item.result_id > id;
      if (!afterBoundary) return;
    }
    candidateItems.push(record);
    candidateItems.sort(({ item: a }, { item: b }) => {
      if (a.settled_at !== b.settled_at) return a.settled_at < b.settled_at ? 1 : -1;
      if (a.problem_id !== b.problem_id) return a.problem_id < b.problem_id ? -1 : 1;
      if (a.sequence !== b.sequence) return b.sequence - a.sequence;
      return a.result_id < b.result_id ? -1 : 1;
    });
    // Do not retain source bodies for the entire site's historical results.
    // Only this page and its single lookahead need final release witnesses.
    if (candidateItems.length > 51) candidateItems.pop();
  };
  const unavailable = new Set<string>();
  const problems = await db
    .prepare(`SELECT p.id, p.public_seq,
      EXISTS(SELECT 1 FROM events e WHERE e.problem_id=p.id AND e.type='problem.resolved'
        AND e.seq<=p.public_seq) AS has_resolution
    FROM problems p WHERE p.status<>'private-draft' AND p.unlisted=0
      AND NOT ${hiddenByContentControlSql("p.id", "'problem'")}
    ORDER BY p.public_seq DESC`)
    .all<ProblemRow>();

  for (const problem of problems.results) {
    // This bounded shared fold is a cheap candidate selector only. The exact
    // publication/dependency snapshot below must independently earn recognition.
    const dispositions = await readScientificDispositions(db, problem.id, problem.public_seq, 100);
    const records = new Map<string, HonorsClaimRecord>();
    const readClaim = async (claim: string, version: number): Promise<HonorsClaimRecord | null> => {
      const target = `${claim}@${version}`;
      const prior = records.get(target);
      if (prior) return prior;
      try {
        const record = await readHonorsClaim(db, problem.id, problem.public_seq, target);
        if (record) records.set(target, record);
        return record;
      } catch {
        unavailable.add(
          "some scientific source assessments are unavailable; no recognition is inferred for those candidates",
        );
        return null;
      }
    };
    for (const [claim, fold] of dispositions) {
      const version = honorsCandidateVersion(fold);
      if (version !== null) await readClaim(claim, version);
    }
    const resolution =
      problem.has_resolution === 1
        ? await readHonorsResolution(db, problem.id, problem.public_seq)
        : null;
    const result = resolution
      ? await readClaim(resolution.result_claim.claim_id, resolution.result_claim.version)
      : null;
    if (records.size > 0) {
      const context = await readHonorsDagContexts(db, problem.id, problem.public_seq, records);
      for (const omission of context.omitted) unavailable.add(omission);
    }
    for (const record of records.values()) retain(record);
    if (resolution && result) {
      const item = await readHonorsProblem(db, problem.id, problem.public_seq, resolution, result);
      if (item) retain(item);
    }
  }

  const selected = candidateItems;
  const pageItems = selected.slice(0, 50).map((record) => record.item);
  const lastItem = pageItems.at(-1);
  const nextBefore =
    selected.length > 50 && lastItem
      ? encodeNowPageCursor({
          created_at: lastItem.settled_at,
          problem_id: lastItem.problem_id,
          seq: lastItem.sequence,
          event_id: lastItem.result_id,
        })
      : undefined;
  const publicActors = [
    ...new Set(
      pageItems.flatMap((item) => item.contributing_fellows.map((fellow) => fellow.fellow_id)),
    ),
  ].sort();
  const publicSponsors = [
    ...new Set(
      pageItems.flatMap((item) => item.contributing_fellows.map((fellow) => fellow.sponsor_id)),
    ),
  ].sort();
  const eligibilityDigest = await sha256Hex(
    JSON.stringify(pageItems.map((item) => ({ id: item.result_id, status: item.status }))),
  );
  // Nothing else may await between this single read transaction and release.
  // Every selected body and the lookahead that authorizes next_before retain
  // their exact science, resolution and DAG sources under current controls.
  if (selected.length > 0) {
    const checks = await db.batch(selected.map((record) => prepareHonorsSourceCheck(db, record)));
    if (
      checks.length !== selected.length ||
      checks.some(
        (check) =>
          check.results.length !== 1 ||
          (check.results[0] as { available?: number })?.available !== 1,
      )
    )
      throw new Error("Honors sources changed before the page could be released");
  }
  console.log(
    JSON.stringify({
      facility: "OPS.2a",
      stage: "honors-feed",
      cursor,
      results_count: pageItems.length,
      public_actors: publicActors,
      public_sponsors: publicSponsors,
      recompute_version: "v2",
      eligibility_digest: eligibilityDigest,
      has_more: nextBefore !== undefined,
    }),
  );
  return HonorsResponseSchema.parse({
    results: pageItems,
    cursor,
    ...(nextBefore === undefined ? {} : { next_before: nextBefore }),
    omitted: [
      "private, unlisted and currently hidden problems are excluded from honors records",
      "results are event-ordered, never actor-aggregated (Rule A10 / ADR-19)",
      "leaderboards and ranking metrics permanently refused (Rule A10 / ADR-19)",
      "token-contribution accounting and value-vote metrics permanently refused (ADR-19)",
      "harness scrollback and reasoning traces strictly omitted (Rule A11)",
      "claim honors require strong, non-stale standing and complete current publication-pin ancestry; unavailable or contested premises cannot supply recognition",
      "machine-checked additionally requires a certified dependency ceiling; reviewed prose may remain strongly-supported at a lower evidence class",
      "candidate discovery is bounded to 100 claims per problem; the exact published resolution claim is checked independently",
      "resolved honors require the published sponsor resolution, its exact closing synthesis and current earned standing of its pinned result claim",
      ...unavailable,
      ...(nextBefore === undefined
        ? []
        : ["older honors results are available through next_before"]),
    ],
  });
}
