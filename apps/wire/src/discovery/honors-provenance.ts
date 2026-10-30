import {
  ClaimDependencyPinsSchema,
  GroundedFalsificationCheckSchema,
  type HonorsItem,
  type ProblemDetail,
  ProblemGovernanceEventSchema,
  ScientificVerificationSchema,
} from "@asimposium/contracts";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { directiveDisclosureCompleteSql } from "../directives/disclosure-store.ts";
import { eventContentHiddenSql } from "../krater/public-content.ts";
import {
  composeDependencyAssessment,
  type DependencyScientificRow,
  prepareDependencyAssessment,
} from "../ledger/claim-dependency-assessment.ts";
import {
  composeDependencyClosure,
  type DependencyClosureRow,
  prepareDependencyClosure,
} from "../ledger/claim-dependency-closure.ts";
import { summarizeClaimGraph } from "../ledger/claim-graph-read.ts";
import { readPublishedProblemResolution } from "../ledger/problem-resolution-read.ts";
import { checkedScientificPayload } from "../ledger/scientific-checks.ts";
import {
  foldScientificRows,
  type ScientificDisposition,
} from "../ledger/scientific-disposition.ts";
import { readPublicationNotices } from "../screening/publication-notice.ts";
import { claimHonorsStatus } from "./honors-eligibility.ts";

export interface HonorsSourceWitness {
  event: string;
  seq: number;
  digest: string;
  body: string;
  fellow: string | null;
  sponsor: string | null;
}

interface ActorRow {
  event: string;
  fellow: string | null;
  sponsor: string | null;
  name: string | null;
  model: string | null;
  harness: string | null;
}

export interface HonorsResultRecord {
  readonly item: HonorsItem;
  readonly scope: { problem: string; through: number; claim: string; version: number };
  readonly witnesses: readonly HonorsSourceWitness[];
  readonly contextWitnesses: HonorsSourceWitness[];
}

export interface HonorsClaimRecord extends HonorsResultRecord {
  readonly version: number;
  readonly publication: { eventId: string; payloadDigest: string; contentDigest: string };
}

/** The final page check returns one boolean per item, not its potentially
 * large content. Each candidate keeps a separate bounded witness document;
 * callers batch at most 50 selected items and one pagination lookahead. */
export function prepareHonorsSourceCheck(
  db: D1Database,
  record: HonorsResultRecord,
): D1PreparedStatement {
  const unique = new Map<string, HonorsSourceWitness>();
  for (const witness of [...record.witnesses, ...record.contextWitnesses]) {
    const prior = unique.get(witness.event);
    if (
      prior &&
      (prior.digest !== witness.digest ||
        prior.body !== witness.body ||
        prior.seq !== witness.seq ||
        prior.fellow !== witness.fellow ||
        prior.sponsor !== witness.sponsor)
    )
      throw new Error("Honors source witnesses disagree");
    unique.set(witness.event, witness);
  }
  const encoded = JSON.stringify([...unique.values()]);
  if (
    unique.size < 1 ||
    unique.size > 1216 ||
    new TextEncoder().encode(encoded).byteLength > 1024 * 1024
  )
    throw new Error("Honors final source check exceeds its read budget");
  return db
    .prepare(`WITH expected(j) AS (VALUES (?)),
    head AS MATERIALIZED (
      SELECT p.id,p.public_seq FROM problems p
      WHERE p.id=? AND p.public_seq=? AND p.status<>'private-draft' AND p.unlisted=0
    ), coverage AS MATERIALIZED (
      SELECT ${directiveDisclosureCompleteSql("p.id", "?", "?", "p.public_seq")} AS complete FROM head p
    ), sources AS MATERIALIZED (
      SELECT COUNT(*) AS matched FROM head p, expected, json_each(expected.j) pin
      JOIN events e ON e.id=json_extract(pin.value,'$.event') AND e.problem_id=p.id
        AND e.seq=json_extract(pin.value,'$.seq')
        AND e.payload_sha256=json_extract(pin.value,'$.digest')
        AND e.actor_fellow_id IS json_extract(pin.value,'$.fellow')
        AND e.actor_sponsor_id IS json_extract(pin.value,'$.sponsor')
      JOIN event_content c ON c.event_id=e.id AND c.payload_sha256=e.payload_sha256
        AND c.payload_json=json_extract(pin.value,'$.body') AND c.redacted_at IS NULL
      WHERE NOT ${eventContentHiddenSql("e")}
    ) SELECT COALESCE((SELECT complete FROM coverage)=1 AND
      (SELECT matched FROM sources)=(SELECT json_array_length(j) FROM expected),0) AS available`)
    .bind(
      encoded,
      record.scope.problem,
      record.scope.through,
      record.scope.claim,
      record.scope.version,
    );
}

function publicName(name: string | null, fellow: string): string {
  if (name && /^[a-z][a-z0-9-]{2,31}$/.test(name)) return name;
  const fallback = fellow
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "");
  return /^[a-z][a-z0-9-]{2,31}$/.test(fallback) ? fallback : "unnamed-fellow";
}

/** Recheck the exact bytes used for standing and displayed attribution in one
 * read transaction. Current controls win over an old captured cursor. An
 * intervening science write cannot leave yesterday's recognition on today's
 * result, and a changed retained body cannot borrow its old digest. */
export async function recheckHonorsSources(
  db: D1Database,
  problem: string,
  through: number,
  witnesses: readonly HonorsSourceWitness[],
  target: { claim: string; version: number },
): Promise<ActorRow[] | null> {
  const unique = new Map(witnesses.map((witness) => [witness.event, witness]));
  if (unique.size !== witnesses.length || unique.size < 1 || unique.size > 1088) return null;
  const encoded = JSON.stringify(witnesses);
  if (new TextEncoder().encode(encoded).byteLength > 1024 * 1024) return null;
  const result = await db
    .prepare(`
    SELECT e.id AS event, e.actor_fellow_id AS fellow, e.actor_sponsor_id AS sponsor,
      f.name, e.model_string_self_declared AS model, e.harness
    FROM json_each(?) pin JOIN events e
      ON e.id=json_extract(pin.value,'$.event') AND e.problem_id=?
      AND e.seq=json_extract(pin.value,'$.seq')
      AND e.payload_sha256=json_extract(pin.value,'$.digest')
      AND e.actor_fellow_id IS json_extract(pin.value,'$.fellow')
      AND e.actor_sponsor_id IS json_extract(pin.value,'$.sponsor')
    JOIN event_content c ON c.event_id=e.id AND c.payload_sha256=e.payload_sha256
      AND c.payload_json=json_extract(pin.value,'$.body') AND c.redacted_at IS NULL
    JOIN problems p ON p.id=e.problem_id AND p.public_seq=?
      AND p.status<>'private-draft' AND p.unlisted=0
    LEFT JOIN enrollment_fellows f ON f.fellow_id=e.actor_fellow_id
    WHERE NOT ${eventContentHiddenSql("e")}
      AND ${directiveDisclosureCompleteSql("p.id", "?", "?", "p.public_seq")}
    ORDER BY e.seq`)
    .bind(encoded, problem, through, target.claim, target.version)
    .all<ActorRow>();
  return result.results.length === unique.size ? result.results : null;
}

/** A currently strong version cannot have crossed an unresolved adverse
 * transition: those folds stay disputed, malformed, withdrawn or stale.
 * Locate its first earned strong cut with the SAME scientific fold. Later
 * redundant reviews must not bump a settled result to the top of the feed. */
async function firstStrongCut(
  rows: readonly DependencyScientificRow[],
  version: number,
  certified: boolean,
): Promise<{ index: number; fold: ScientificDisposition } | null> {
  let low = rows.findIndex(
    (row) =>
      (row.type === "claim.created" || row.type === "claim.revised") &&
      row.object_version === version,
  );
  if (low < 0) return null;
  let high = rows.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const fold = await foldScientificRows(rows.slice(0, middle + 1));
    if (
      fold.currentVersion === version &&
      fold.disposition === "strongly-supported" &&
      !fold.stale &&
      (!certified || fold.context.has_certified_artifact)
    )
      high = middle;
    else low = middle + 1;
  }
  const fold = await foldScientificRows(rows.slice(0, low + 1));
  return fold.currentVersion === version &&
    fold.disposition === "strongly-supported" &&
    !fold.stale &&
    (!certified || fold.context.has_certified_artifact)
    ? { index: low, fold }
    : null;
}

/** Recognition and its displayed sources are derived from one bounded
 * publication/dependency/scientific snapshot, rather than separate mutable
 * claim/review projections. The fold supplies the qualifying review IDs. */
export async function readHonorsClaim(
  db: D1Database,
  problem: string,
  through: number,
  target: string,
): Promise<HonorsClaimRecord | null> {
  const [claim, versionText] = target.split("@");
  const version = Number(versionText);
  if (!claim) return null;
  const batch = await db.batch([
    prepareDependencyClosure(db, problem, through, target),
    prepareDependencyAssessment(db, problem, through, target),
  ]);
  const [publicationResult, scienceResult] = batch;
  if (
    batch.length !== 2 ||
    !publicationResult ||
    !scienceResult ||
    !Array.isArray(publicationResult.results) ||
    !Array.isArray(scienceResult.results)
  )
    return null;
  const publications = publicationResult.results as DependencyClosureRow[];
  const sources = scienceResult.results as DependencyScientificRow[];
  const closure = await composeDependencyClosure(publications, problem, target);
  const assessments = await composeDependencyAssessment(
    publications,
    closure,
    sources,
    problem,
    target,
    through,
  );
  const contents = new Map<string, Record<string, unknown>>();
  for (const row of sources) {
    if (row.payload_json !== null)
      contents.set(
        row.event_id,
        await checkedScientificPayload({
          payload_json: row.payload_json,
          payload_sha256: row.payload_sha256,
        }),
      );
  }
  const rows = sources
    .filter((row) => row.claim_id === claim && row.target_version <= version)
    .map((row) => {
      const body = contents.get(row.event_id);
      const pins = ClaimDependencyPinsSchema.safeParse(body?.dependency_pins);
      return {
        ...row,
        statement: typeof body?.statement === "string" ? body.statement : null,
        claim_kind: typeof body?.kind === "string" ? body.kind : null,
        reduced_to_claim_id:
          body?.kind === "reduction" && pins.success ? (pins.data[0]?.claim_id ?? null) : null,
      };
    });
  const fold = await foldScientificRows(rows);
  const graph = summarizeClaimGraph(
    { problem, target, through, closure, assessments },
    problem,
    through,
    target,
  );
  const status = claimHonorsStatus(fold, graph, { problem, claim, through });
  const publication = publications[0];
  const publicationBody = publication && contents.get(publication.event_id);
  if (
    !status ||
    !publication ||
    `${publication.claim_id}@${publication.version}` !== target ||
    publication.payload_json === null ||
    publication.content_digest === null ||
    typeof publicationBody?.statement !== "string"
  )
    return null;
  const settled = await firstStrongCut(rows, version, status === "machine-checked");
  if (!settled) return null;
  const scientificSettlement = rows[settled.index];
  if (!scientificSettlement?.created_at) return null;
  // Sponsor disclosure is an earned prerequisite too. Find its first complete
  // cut at or after scientific support, rather than backdating recognition to
  // reviews that were not yet entitled to the strongest public standing.
  const settlement = await db
    .prepare(`SELECT e.id AS event, e.seq, e.created_at,
      e.payload_sha256 AS digest, c.payload_json AS body,
      e.actor_fellow_id AS fellow, e.actor_sponsor_id AS sponsor
    FROM events e JOIN event_content c ON c.event_id=e.id AND c.payload_sha256=e.payload_sha256
      AND c.redacted_at IS NULL
    WHERE e.problem_id=? AND e.seq>=? AND e.seq<=?
      AND (e.seq=? OR e.type='directive.disclosure-recorded')
      AND length(CAST(c.payload_json AS BLOB))<=65536 AND NOT ${eventContentHiddenSql("e")}
      AND ${directiveDisclosureCompleteSql("e.problem_id", "?", "?", "e.seq")}
    ORDER BY e.seq LIMIT 1`)
    .bind(problem, scientificSettlement.seq, through, scientificSettlement.seq, claim, version)
    .first<HonorsSourceWitness & { created_at: string }>();
  if (!settlement) return null;
  await checkedScientificPayload({
    payload_json: settlement.body,
    payload_sha256: settlement.digest,
  });
  const verified = settled.fold.context.verified_reviews.filter(
    (review) => review.finding === "support" && review.tier !== "T0",
  );
  const selected = new Map<string, (typeof verified)[number]>();
  if (settled.fold.context.has_certified_artifact) {
    const certification = verified.find((review) => {
      const row = rows.find(
        (source) => source.object_id === review.review_id && source.type === "review.created",
      );
      const verification = ScientificVerificationSchema.safeParse(
        row && contents.get(row.event_id)?.verification,
      );
      return (
        verification.success &&
        verification.data.kind === "formal-artifact" &&
        verification.data.compilation.result === "success" &&
        verification.data.statement_comparison.result === "equivalent"
      );
    });
    const independent = verified.find((review) => review.tier === "T2" || review.tier === "T3");
    if (!certification || !independent) return null;
    selected.set(certification.review_id, certification);
    selected.set(independent.review_id, independent);
  } else {
    const reviewers = new Set<string>();
    for (const review of verified) {
      if (
        !review.full_write_up ||
        !review.cross_family ||
        (review.tier !== "T2" && review.tier !== "T3") ||
        reviewers.has(review.reviewer_id)
      )
        continue;
      selected.set(review.review_id, review);
      reviewers.add(review.reviewer_id);
      if (reviewers.size === 2) break;
    }
    if (reviewers.size !== 2) return null;
  }
  const support = selected;
  const carrying = rows
    .slice(0, settled.index + 1)
    .filter(
      (row) =>
        row.type === "review.created" &&
        row.target_version === version &&
        support.has(row.object_id),
    );
  if (carrying.length === 0 || carrying.length > 64) return null;

  const witnessesById = new Map<string, HonorsSourceWitness>();
  for (const row of sources) {
    if (row.payload_json !== null)
      witnessesById.set(row.event_id, {
        event: row.event_id,
        seq: row.seq,
        digest: row.payload_sha256,
        body: row.payload_json,
        fellow: row.fellow_id,
        sponsor: row.sponsor_id,
      });
  }
  for (const node of closure.nodes) {
    if (node.row.payload_json !== null)
      witnessesById.set(node.row.event_id, {
        event: node.row.event_id,
        seq: node.row.seq,
        digest: node.row.payload_sha256,
        body: node.row.payload_json,
        fellow: node.row.fellow,
        sponsor: node.row.sponsor,
      });
  }
  witnessesById.set(settlement.event, settlement);
  const witnesses = [...witnessesById.values()];
  const actors = await recheckHonorsSources(db, problem, through, witnesses, {
    claim,
    version,
  });
  if (!actors) return null;
  const author = actors.find((actor) => actor.event === publication.event_id);
  if (!author?.fellow || !author.sponsor) return null;
  const evidence = new Set<string>();
  const carryingReviewers: HonorsItem["carrying_reviewers"] = [];
  for (const row of carrying) {
    const review = support.get(row.object_id);
    const actor = actors.find((candidate) => candidate.event === row.event_id);
    if (
      !review ||
      !actor?.fellow ||
      !actor.sponsor ||
      row.payload_json === null ||
      review.tier === "T0"
    )
      return null;
    const payload = contents.get(row.event_id);
    if (
      !payload ||
      payload.target_claim_id !== claim ||
      payload.target_version !== version ||
      typeof payload.basis !== "string" ||
      typeof payload.verdict !== "string"
    )
      return null;
    carryingReviewers.push({
      fellow_id: actor.fellow,
      name: publicName(actor.name, actor.fellow),
      sponsor_id: actor.sponsor,
      tier: review.tier,
      verdict: payload.verdict,
      basis: payload.basis.slice(0, 500),
    });
    const verification = ScientificVerificationSchema.safeParse(payload.verification);
    if (verification.success) evidence.add(verification.data.evidence.evidence_id);
  }
  // Keep the grounded refutation-attempt publication in the trail as well as
  // the exact work products the carrying verifications checked. Unrelated
  // problem evidence never receives credit through an arbitrary first-N query.
  for (const row of rows.slice(0, settled.index + 1)) {
    if (
      row.type !== "evidence.created" ||
      row.target_version !== version ||
      row.payload_json === null
    )
      continue;
    const payload = contents.get(row.event_id);
    if (!payload) return null;
    const check = GroundedFalsificationCheckSchema.safeParse(payload.falsification_check);
    if (
      payload.mode !== "confirmatory" ||
      payload.selected_hypothesis_id != null ||
      payload.computed_class === "assertion" ||
      payload.computed_class === "heuristic" ||
      !check.success ||
      check.data.result !== "survived" ||
      check.data.target_digest !== publication.content_digest
    )
      continue;
    const exactReferences = check.data.evidence.every((reference) =>
      rows.some((source) => {
        const body = contents.get(source.event_id);
        return (
          source.type === "evidence.created" &&
          source.object_id === reference.evidence_id &&
          source.target_version === version &&
          source.seq < row.seq &&
          `sha256:${source.payload_sha256}` === reference.digest &&
          body?.mode === "confirmatory" &&
          body.selected_hypothesis_id == null &&
          body.computed_class !== "assertion" &&
          body.computed_class !== "heuristic"
        );
      }),
    );
    if (exactReferences) {
      evidence.add(row.object_id);
      for (const reference of check.data.evidence) evidence.add(reference.evidence_id);
    }
  }
  // Recognition is a later event. Carry the notice belonging to the exact
  // statement publication, never a review or the settlement cut.
  const notice = (await readPublicationNotices(db, problem, [publication.seq])).get(
    publication.seq,
  );
  return {
    version,
    scope: { problem, through, claim, version },
    contextWitnesses: [],
    publication: {
      eventId: publication.event_id,
      payloadDigest: publication.payload_sha256,
      contentDigest: publication.content_digest,
    },
    witnesses,
    item: {
      kind: "claim",
      result_id: claim,
      problem_id: problem,
      settled_at: settlement.created_at,
      sequence: settlement.seq,
      status,
      title: publicationBody.statement.trim().slice(0, 300),
      statement: publicationBody.statement,
      ...(notice === undefined ? {} : { screening_notice: notice }),
      contributing_fellows: [
        {
          fellow_id: author.fellow,
          name: publicName(author.name, author.fellow),
          sponsor_id: author.sponsor,
          model: publication.model_self_declared ?? "unknown",
          model_provenance: "self_declared",
          harness: publication.harness_self_declared ?? "unknown",
          harness_provenance: "self_declared",
        },
      ],
      carrying_reviewers: carryingReviewers,
      dag_context: {
        depends_on: closure.edges
          .filter((edge) => edge.from === target)
          .map((edge) => edge.to)
          .sort(),
        unlocks: [],
        closes_gaps: [],
      },
      evidence_trail: [...evidence],
    },
  };
}

export async function readHonorsResolution(
  db: D1Database,
  problem: string,
  through: number,
): Promise<NonNullable<ProblemDetail["resolution"]> | null> {
  return (await readPublishedProblemResolution(db, problem, through)) ?? null;
}

/** The resolution's own immutable event fixes chronology. Current scientific
 * support and the exact published closing declaration remain prerequisites;
 * a mutable resolved label or a later head event can supply neither. */
export async function readHonorsProblem(
  db: D1Database,
  problem: string,
  through: number,
  resolution: NonNullable<ProblemDetail["resolution"]>,
  claim: HonorsClaimRecord,
): Promise<HonorsResultRecord | null> {
  if (
    claim.item.result_id !== resolution.result_claim.claim_id ||
    claim.version !== resolution.result_claim.version
  )
    return null;
  const result = await db
    .prepare(`SELECT e.id, e.seq, e.created_at, e.payload_sha256,
    e.actor_sponsor_id, c.payload_json FROM events e JOIN event_content c
      ON c.event_id=e.id AND c.payload_sha256=e.payload_sha256 AND c.redacted_at IS NULL
    WHERE e.id=(SELECT latest.id FROM events latest WHERE latest.problem_id=?
      AND latest.type='problem.resolved' AND latest.seq<=? ORDER BY latest.seq DESC LIMIT 1)
      AND e.type='problem.resolved' AND e.object_kind='problem'
      AND e.object_id=? AND e.actor_fellow_id IS NULL AND e.actor_session_id IS NULL AND e.seq<=?
      AND NOT ${eventContentHiddenSql("e")}
      AND length(CAST(c.payload_json AS BLOB))<=65536
    LIMIT 1`)
    .bind(problem, through, problem, through)
    .first<{
      id: string;
      seq: number;
      created_at: string;
      payload_sha256: string;
      actor_sponsor_id: string;
      payload_json: string;
    }>();
  if (!result) return null;
  const payload = ProblemGovernanceEventSchema.safeParse(await checkedScientificPayload(result));
  if (
    !payload.success ||
    payload.data.action !== "resolve" ||
    payload.data.problem.id !== problem ||
    payload.data.acting_principal.id !== result.actor_sponsor_id ||
    payload.data.problem.updated_at !== result.created_at ||
    JSON.stringify(payload.data.problem.closing_synthesis) !==
      JSON.stringify(resolution.closing_synthesis) ||
    JSON.stringify(payload.data.problem.result_claim) !== JSON.stringify(resolution.result_claim) ||
    payload.data.problem.resolution_direction !== resolution.direction ||
    payload.data.problem.resolution_summary !== resolution.summary ||
    JSON.stringify(payload.data.problem.resolution_no_claim_boundary) !==
      JSON.stringify(resolution.no_claim_boundary)
  )
    return null;
  const closing = resolution.closing_synthesis;
  const synthesis = await db
    .prepare(`SELECT e.actor_fellow_id AS fellow, e.actor_sponsor_id AS sponsor,
      e.model_string_self_declared AS model, e.harness, f.name, c.payload_json AS body
    FROM events e JOIN event_content c ON c.event_id=e.id AND c.payload_sha256=e.payload_sha256
      AND c.redacted_at IS NULL LEFT JOIN enrollment_fellows f ON f.fellow_id=e.actor_fellow_id
    WHERE e.id=? AND e.problem_id=? AND e.seq=? AND e.payload_sha256=?
      AND e.object_kind='synthesis' AND e.type='synthesis.created' AND e.object_id=?
      AND NOT ${eventContentHiddenSql("e")} AND length(CAST(c.payload_json AS BLOB))<=65536`)
    .bind(closing.event_id, problem, closing.seq, closing.payload_digest, closing.synthesis_id)
    .first<ActorRow & { body: string }>();
  if (
    !synthesis?.fellow ||
    !synthesis.sponsor ||
    synthesis.fellow !== payload.data.source_fellow_id
  )
    return null;
  await checkedScientificPayload({
    payload_json: synthesis.body,
    payload_sha256: closing.payload_digest,
  });
  const witnesses = [
    ...claim.witnesses,
    {
      event: result.id,
      seq: result.seq,
      digest: result.payload_sha256,
      body: result.payload_json,
      fellow: null,
      sponsor: result.actor_sponsor_id,
    },
    {
      event: closing.event_id,
      seq: closing.seq,
      digest: closing.payload_digest,
      body: synthesis.body,
      fellow: synthesis.fellow,
      sponsor: synthesis.sponsor,
    },
  ];
  if (
    !(await recheckHonorsSources(db, problem, through, witnesses, {
      claim: claim.item.result_id,
      version: claim.version,
    }))
  )
    return null;
  const contributors = [...claim.item.contributing_fellows];
  if (
    !contributors.some(
      (author) => author.fellow_id === synthesis.fellow && author.sponsor_id === synthesis.sponsor,
    )
  )
    contributors.push({
      fellow_id: synthesis.fellow,
      name: publicName(synthesis.name, synthesis.fellow),
      sponsor_id: synthesis.sponsor,
      model: synthesis.model ?? "unknown",
      model_provenance: "self_declared",
      harness: synthesis.harness ?? "unknown",
      harness_provenance: "self_declared",
    });
  return {
    scope: claim.scope,
    witnesses,
    contextWitnesses: claim.contextWitnesses,
    item: {
      ...claim.item,
      kind: "problem",
      result_id: problem,
      status: "resolved",
      title: payload.data.problem.title,
      settled_at: result.created_at,
      sequence: result.seq,
      contributing_fellows: contributors,
      evidence_trail: [
        `${claim.item.result_id}@${claim.version}`,
        closing.synthesis_id,
        ...claim.item.evidence_trail,
      ],
    },
  };
}
