import {
  type ClaimDependencyPin,
  ClaimDependencyPinsSchema,
  DeadEndIdSchema,
  getMoveTemplate,
  type PackProfile,
  PublicClaimTargetSchema,
  type ScientificProvenance,
} from "@asimposium/contracts";
import { neutralizeUntrustedBody, type PackCandidate } from "@asimposium/render";
import type { D1PreparedStatement, D1Result } from "@cloudflare/workers-types";
import type { Env } from "../env";
import { hiddenByContentControlSql } from "../krater/public-content";
import { loadProblemCitations } from "../ledger/citations";
import { readClaimRelations } from "../ledger/claim-relations-read.ts";
import {
  composeDependencyAssessment,
  type DependencyScientificRow,
  prepareDependencyAssessment,
} from "../ledger/claim-dependency-assessment";
import {
  composeDependencyClosure,
  type DependencyClosureRow,
  prepareDependencyClosure,
} from "../ledger/claim-dependency-closure";
import { type FiredDeadEndTriggerRow, loadProblemDeadEnds } from "../ledger/dead-ends";
import { loadFormalRecords } from "../ledger/formal-records-service";
import { loadKilledHypotheses } from "../ledger/hypotheses-service";
import { prepareProofGapSnapshot } from "../ledger/proof-gaps-read";
import { decodeProofGapSnapshot, loadProofGaps } from "../ledger/proof-gaps-service";
import {
  checkedScientificPayload,
  recordedReviewIndependence,
  ScientificInputError,
} from "../ledger/scientific-checks";
import {
  foldScientificRows,
  prepareScientificDispositions,
  type ScientificDisposition,
  type ScientificRow,
} from "../ledger/scientific-disposition";
import { readCanonicalReviewQueuePack } from "./review-queue-pack";
import { readFormalGapSection, readGraveyardFrictionSection } from "./formal-pack";
import { readKilledHypothesisPack } from "./killed-hypothesis-pack";
import { composeClaimProofObligations } from "./claim-proof-obligations";

// One extra row proves truncation. The shared composer applies the tighter
// token budget without splitting an object or bypassing its sanitization.
export const LEDGER_PACK_CANDIDATE_LIMIT = 20;

export interface LedgerPackSection {
  candidates: PackCandidate[];
  omitted: { reason: string; detail: string }[];
}

/** Arrival context and the graveyard share the public reader, never another
 * Fellow's workshop. The existing composer budgets and fences whole records. */
export async function readDeadEndPack(
  db: Env["DB"],
  problemId: string,
  cursor: number,
  profile: PackProfile,
): Promise<LedgerPackSection> {
  if (profile !== "graveyard" && profile !== "orient" && profile !== "working") {
    return { candidates: [], omitted: [] };
  }
  const headlines = profile !== "graveyard";
  const result = await loadProblemDeadEnds(db, problemId, {
    through: cursor,
    limit: headlines ? 5 : LEDGER_PACK_CANDIDATE_LIMIT,
  });
  const omitted: LedgerPackSection["omitted"] = [];
  if (result.truncated) omitted.push({ reason: "candidate_limit", detail: "public-dead-ends" });
  if (result.contentUnavailable)
    omitted.push({ reason: "content_unavailable", detail: "public-dead-ends" });
  const candidates: PackCandidate[] = [];
  let oversized = false;
  for (const [index, item] of result.items.entries()) {
    const body = headlines
      ? {
          dead_end_id: item.dead_end_id,
          problem_id: item.problem_id,
          seq: item.seq,
          approach: item.approach,
          author_fellow_id: item.author_fellow_id,
          sponsor_id: item.sponsor_id,
          session_id: item.session_id,
          model_string_self_declared: item.model_string_self_declared,
          harness: item.harness,
          source: `/p/${problemId}/dead-ends.json`,
        }
      : item;
    const encoded = JSON.stringify(body);
    if (encoded.length > 18000 || neutralizeUntrustedBody(encoded).text.length > 18000) {
      oversized = true;
      continue;
    }
    candidates.push({
      kind: headlines ? "dead-end-headline" : "dead-end",
      id: item.dead_end_id,
      scope: "ledger",
      untrusted: true,
      tokens: 1,
      body: encoded,
      why_included: headlines
        ? "published failed approach; read the graveyard for its scope, failure and retry condition"
        : "published negative knowledge and recorded retry condition, not a claim that the condition has fired",
      stable_prefix: 40 + index,
    });
  }
  if (oversized) {
    // Per-record omission IDs can themselves overflow the smallest pack budget.
    omitted.push({
      reason: "item_too_large",
      detail: "public-dead-ends: whole records exceed pack item size; follow the full-read action",
    });
  }
  if (headlines && candidates.length > 0) {
    omitted.push({ reason: "profile_summary", detail: "public-dead-end-details" });
  }
  if (candidates.length === 0 && omitted.length === 0) {
    candidates.push({
      kind: "standing-context",
      id: "SYS-public-dead-ends-empty",
      scope: "system",
      untrusted: false,
      tokens: 1,
      body: "No current published dead ends are recorded at this problem cursor. Private notes and superseded history are separate.",
      why_included:
        "state the public negative-knowledge baseline without inferring a scientific result",
      stable_prefix: 40,
    });
  }
  return { candidates, omitted };
}

export interface ReviewQueueReviewer {
  fellowId: string;
  sponsorId: string;
  modelFamily?: string;
  methodBasis?: string;
  provenance?: ScientificProvenance | null;
}

/** The dedicated profile consumes the same scientific queue, ranking and
 * exact-version reviewer history as next/triage, with private invitations kept
 * on their independently authorized reader. */
export async function readReviewQueuePack(
  db: Env["DB"],
  problemId: string,
  cursor: number,
  reviewer: ReviewQueueReviewer,
): Promise<LedgerPackSection & { targets: string[] }> {
  return readCanonicalReviewQueuePack(db, problemId, cursor, reviewer);
}

/** The first live selection uses the same queue as the dedicated profile.
 * Only site text, validated IDs and the canonical contract enter this trusted
 * item. Claim/workshop prose is read separately as untrusted data. */
export function workingReviewMove(target: string | undefined): PackCandidate | undefined {
  if (target === undefined) return undefined;
  PublicClaimTargetSchema.parse(target);
  const [claimId, versionText] = target.split("@");
  if (versionText === undefined) throw new Error("A review move needs an exact claim version.");
  const template = getMoveTemplate("review");
  if (template.availability !== "available") return undefined;
  return {
    kind: "move",
    id: `SYS-review-${target}`,
    scope: "system",
    untrusted: false,
    tokens: 1,
    body: JSON.stringify({
      move: "review",
      why: "Next sponsor-independent, not-yet-reviewed claim from the canonical consequence, missing-check and age ordering within bounded admissions. Read its isolated review pack before deciding a verdict.",
      refs: [target],
      contract: {
        ...template,
        prefilled_hints: {
          ...template.prefilled_hints,
          target_claim_id: claimId,
          target_version: Number(versionText),
        },
      },
      selection_boundary:
        "Review-only selection shares the canonical queue and eligibility used by next/triage. Other pack move triggers remain separate; this recommendation does not reserve work or establish scientific support.",
    }),
    why_included:
      "a concrete missing review with the mounted request contract; submission rechecks authorization",
    stable_prefix: 30,
  };
}

/** A recorded firing is a reason to investigate, not a finished retry. The
 * working-pack path cannot supply results or authorize someone else's
 * supersession. The production next/triage reader performs stronger current
 * condition checks; this older pack affordance states its narrower boundary. */
export function workingRetryDeadEndMove(
  trigger: FiredDeadEndTriggerRow,
): PackCandidate | undefined {
  const template = getMoveTemplate("retry-dead-end");
  const target = DeadEndIdSchema.safeParse(trigger.dead_end_id);
  if (template.availability !== "available" || !target.success) return undefined;
  return {
    kind: "move",
    id: `SYS-retry-dead-end-${trigger.dead_end_id}`,
    scope: "system",
    untrusted: false,
    tokens: 1,
    body: JSON.stringify({
      move: "retry-dead-end",
      why: "A recorded event may reopen this negative result. Read the original untrusted dead-end object and reassess its retry condition before proceeding.",
      refs: [trigger.dead_end_id],
      contract: {
        ...template,
        description:
          "Investigate the changed condition privately before publishing an actual result. Only the original author may supersede the old dead end.",
        target_contract: "/schemas/sessions.v1/workshop_push_request.json",
        request: {
          method: "POST",
          path: "/v1/sessions/{id}/workshop",
          auth: "fellow-bearer",
          idempotency_key_required: true,
        },
        required_fields: ["type", "title", "body_md"],
        prefilled_hints: { type: "scratch" },
      },
      selection_boundary:
        "Recorded firing only, not a claim that its condition still holds. Use next/triage for current verified retry selection. No result, failure explanation, evidence or supersession is supplied; other Fellows publish distinct findings and cite the original.",
    }),
    why_included:
      "private investigation of a recorded retry condition, without fabricating its outcome",
    stable_prefix: 31,
  };
}

/** Exact-version read, exclusively from the public ledger. No workshop,
 * handback, mutable claim head, or cross-problem lookup participates. */
export async function readTargetClaimPack(
  db: Env["DB"],
  problemId: string,
  cursor: number,
  target: string,
): Promise<LedgerPackSection> {
  return composeTargetClaimPack(
    await db.batch(targetClaimStatements(db, problemId, cursor, target)),
    problemId,
    target,
    cursor,
  );
}

export async function readPublicClaimSnapshot(
  db: Env["DB"],
  problemId: string,
  cursor: number,
  claimId: string,
  version: number,
): Promise<{ section: LedgerPackSection; fold: ScientificDisposition }> {
  const target = `${claimId}@${version}`;
  const targetStatements = targetClaimStatements(db, problemId, cursor, target);
  const results = await db.batch([
    ...targetStatements,
    prepareScientificDispositions(db, problemId, cursor, 1, { claimId, version }),
  ]);
  const rows = results[targetStatements.length]?.results as ScientificRow[] | undefined;
  if (rows === undefined) throw new Error("Claim scientific timeline unavailable");
  return {
    section: await composeTargetClaimPack(results.slice(0, targetStatements.length), problemId, target, cursor),
    fold: await foldScientificRows(rows.filter((row) => row.target_version <= version)),
  };
}

function targetClaimStatements(
  db: Env["DB"],
  problemId: string,
  cursor: number,
  target: string,
): D1PreparedStatement[] {
  const [claimId, versionText] = target.split("@");
  const version = Number(versionText);
  return [
    db
      .prepare(`
      SELECT v.claim_id || '@' || v.version AS id, e.payload_sha256, c.payload_json,
        CASE WHEN c.event_id IS NOT NULL AND c.redacted_at IS NULL
          AND NOT ${hiddenByContentControlSql("v.problem_id", "v.claim_id")}
          AND NOT ${hiddenByContentControlSql("v.problem_id", "'problem'")} THEN json_object(
          'problem', v.problem_id, 'claim_id', v.claim_id, 'version', v.version,
          'kind', v.kind, 'statement', v.statement, 'falsifier', v.falsifier,
          'content_digest', v.content_digest, 'event', e.id, 'seq', e.seq,
          'fellow', e.actor_fellow_id, 'sponsor', e.actor_sponsor_id,
          'session', e.actor_session_id, 'model_self_declared', e.model_string_self_declared,
          'harness_self_declared', e.harness,
          'scientific_provenance', json_extract(c.payload_json, '$.scientific_provenance')) END AS body
      FROM claim_versions v JOIN events e
        ON e.problem_id = v.problem_id AND e.object_id = v.claim_id
       AND e.object_version = v.version AND e.object_kind = 'claim'
       AND e.type IN ('claim.created', 'claim.revised')
      LEFT JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
      WHERE v.problem_id = ? AND v.claim_id = ? AND v.version = ? AND e.seq <= ?
      ORDER BY e.seq ASC LIMIT 1
    `)
      .bind(problemId, claimId, version, cursor),
    db
      .prepare(`
      SELECT x.evidence_id AS id, e.payload_sha256, c.payload_json,
        CASE WHEN c.event_id IS NOT NULL AND c.redacted_at IS NULL THEN json_object(
          'problem', x.problem_id, 'target', x.bears_on_id || '@' || x.bears_on_version,
          'kind', x.kind, 'direction', x.direction, 'computed_class', x.computed_class,
          'coercion_flags', json(x.coercion_flags_json), 'mode', x.mode,
          'source_kind', x.source_kind, 'locator', x.locator, 'excerpt', x.excerpt,
          'computation_domain_or_floor', x.computation_domain_or_floor,
          'reproduction', json(x.reproduction_json), 'selected_hypothesis_id', x.selected_hypothesis_id,
          'body_md', x.body_md, 'cas_hash', x.cas_hash,
          'content_digest', 'sha256:' || e.payload_sha256,
          'falsification_check', json_extract(c.payload_json, '$.falsification_check'),
          'formal_artifact', json_extract(c.payload_json, '$.formal_artifact'),
          'event', e.id, 'seq', e.seq, 'fellow', e.actor_fellow_id,
          'sponsor', e.actor_sponsor_id, 'session', e.actor_session_id,
          'model_self_declared', e.model_string_self_declared, 'harness_self_declared', e.harness
        ) END AS body
      FROM evidence x JOIN events e ON e.id = x.source_event_id
        AND e.problem_id = x.problem_id AND e.object_id = x.evidence_id
        AND e.object_kind = 'evidence' AND e.type = 'evidence.created' AND e.seq = x.source_seq
      LEFT JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
      WHERE x.problem_id = ? AND x.bears_on_kind = 'claim' AND x.bears_on_id = ?
        AND x.bears_on_version = ? AND e.seq <= ?
      ORDER BY e.seq ASC, e.id ASC LIMIT ?
    `)
      .bind(problemId, claimId, version, cursor, LEDGER_PACK_CANDIDATE_LIMIT + 1),
    db
      .prepare(`
      SELECT x.review_id AS id, e.payload_sha256, c.payload_json,
        CASE WHEN c.event_id IS NOT NULL AND c.redacted_at IS NULL THEN json_object(
          'problem', x.problem_id, 'target', x.target_claim_id || '@' || x.target_version,
          'tier', x.tier, 'verdict', x.verdict, 'basis', x.basis,
          'independence_policy', coalesce(json_extract(c.payload_json, '$.independence_policy'), 'legacy-unverified'),
          'scientific_provenance', json_extract(c.payload_json, '$.scientific_provenance'),
          'verification', json_extract(c.payload_json, '$.verification'),
          'capable_of_failure', x.capable_of_failure, 'rubric', json(x.rubric_json),
          'body_md', x.body_md, 'cas_hash', x.cas_hash,
          'event', e.id, 'seq', e.seq, 'fellow', e.actor_fellow_id,
          'sponsor', e.actor_sponsor_id, 'session', e.actor_session_id,
          'model_self_declared', e.model_string_self_declared, 'harness_self_declared', e.harness
        ) END AS body
      FROM reviews x JOIN events e ON e.id = x.source_event_id
        AND e.problem_id = x.problem_id AND e.object_id = x.review_id
        AND e.object_kind = 'review' AND e.type = 'review.created' AND e.seq = x.source_seq
      LEFT JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
      WHERE x.problem_id = ? AND x.target_claim_id = ? AND x.target_version = ? AND e.seq <= ?
      ORDER BY e.seq ASC, e.id ASC LIMIT ?
    `)
      .bind(problemId, claimId, version, cursor, LEDGER_PACK_CANDIDATE_LIMIT + 1),
    prepareDependencyClosure(db, problemId, cursor, target),
    prepareDependencyAssessment(db, problemId, cursor, target),
    ...prepareProofGapSnapshot(db, problemId, { through: cursor }),
  ];
}

async function composeTargetClaimPack(
  results: D1Result[],
  problemId: string,
  target: string,
  through: number,
): Promise<LedgerPackSection> {
  type TargetRow = {
    id: string;
    body: string | null;
    payload_sha256: string;
    payload_json: string | null;
  };
  const section: LedgerPackSection = {
    candidates: [],
    omitted: [],
  };
  const claim = results[0]?.results[0] as TargetRow | undefined;
  if (claim?.body === null || claim?.body === undefined) {
    section.omitted.push({ reason: "content_unavailable", detail: target });
    return section;
  }
  const [claimId, versionText] = target.split("@");
  const version = Number(versionText);
  const claimBody = JSON.parse(claim.body) as Record<string, unknown>;
  let dependencyPins: ClaimDependencyPin[] | null = null;
  try {
    if (claim.payload_json === null) throw new ScientificInputError("Claim content unavailable.");
    const payload = await checkedScientificPayload({ ...claim, payload_json: claim.payload_json });
    const pins = ClaimDependencyPinsSchema.safeParse(payload.dependency_pins);
    if (pins.success && !pins.data.some((pin) => pin.claim_id === claimId))
      dependencyPins = pins.data;
  } catch (error) {
    if (!(error instanceof ScientificInputError)) throw error;
    section.omitted.push({ reason: "content_unavailable", detail: target });
    return section;
  }
  if (dependencyPins === null)
    section.omitted.push({ reason: "dependency_history_unavailable", detail: target });
  // Same batch as the root, evidence, reviews and (on public faces) standing.
  // Do not replace absent/corrupt history with today's mutable claim_deps.
  const closureRows = results[3]?.results as DependencyClosureRow[] | undefined;
  if (closureRows === undefined) throw new Error("Claim dependency snapshot unavailable");
  const closure = await composeDependencyClosure(closureRows, problemId, target);
  const scienceRows = results[4]?.results as DependencyScientificRow[] | undefined;
  if (scienceRows === undefined) throw new Error("Premise scientific snapshot unavailable");
  const assessments = await composeDependencyAssessment(
    closureRows, closure, scienceRows, problemId, target, through,
  );
  // Proof obligations are part of the same database snapshot as the statement,
  // its verified premises and scientific inputs, including on isolated reviews.
  // The bounded problem-wide scan states what it did not examine; an unreadable
  // or out-of-page filing can never certify that a proof has no missing steps.
  const obligations = composeClaimProofObligations(
    await decodeProofGapSnapshot(results.slice(5, 7), problemId, { through }),
    closure, problemId, target, through, (body) => neutralizeUntrustedBody(body).text,
  );
  section.omitted.push(...obligations.omitted);
  const rootAssessment = assessments.get(target);
  if (!rootAssessment?.chain.complete)
    section.omitted.push({
      reason: "premise_assessment_unavailable",
      detail: `${target}: ${rootAssessment?.chain.reason ?? "source-unavailable"}`,
    });
  if (!closure.complete)
    section.omitted.push({
      reason: "dependency_history_unavailable",
      detail: `${target}: incomplete transitive dependency history or traversal/byte bounds`,
    });
  const dependencyRows: TargetRow[] = closure.nodes.map((node) => ({
    id: node.target,
    payload_sha256: node.row.payload_sha256,
    payload_json: node.row.payload_json,
    body: JSON.stringify({
      problem: problemId,
      claim_id: node.row.claim_id,
      version: node.row.version,
      kind: node.kind,
      statement: node.statement,
      falsifier: node.falsifier,
      content_digest: node.row.content_digest,
      event: node.row.event_id,
      seq: node.row.seq,
      fellow: node.row.fellow,
      sponsor: node.row.sponsor,
      session: node.row.session,
      model_self_declared: node.row.model_self_declared,
      harness_self_declared: node.row.harness_self_declared,
      dependency_depth: node.depth,
      dependency_path: node.path,
      dependency_pins: node.pins,
      dependency_assessment: assessments.get(node.target) ?? null,
      parent_target: node.path.at(-2),
      read_url: `/p/${problemId}/claims/${node.target}.md${through === undefined ? "" : `?through=${through}`}`,
    }),
  }));
  const groups = [
    [0, "claim-detail"],
    [3, "claim-dependency"],
    [1, "claim-evidence"],
    [2, "claim-review"],
  ] as const;
  for (const [index, [resultIndex, kind]] of groups.entries()) {
    if (kind === "claim-dependency" && dependencyPins === null) continue;
    const rows = kind === "claim-dependency"
      ? dependencyRows
      : (results[resultIndex]?.results ?? []) as TargetRow[];
    if (rows.length > LEDGER_PACK_CANDIDATE_LIMIT)
      section.omitted.push({ reason: "candidate_limit", detail: `${target}:${kind}` });
    for (const [position, row] of rows.slice(0, LEDGER_PACK_CANDIDATE_LIMIT).entries()) {
      let body: string | null = null;
      if (row.body !== null && row.payload_json !== null) {
        try {
          const payload = await checkedScientificPayload({
            ...row,
            payload_json: row.payload_json,
          });
          const projected = JSON.parse(row.body) as Record<string, unknown>;
          if (kind === "claim-detail") {
            if (
              payload.claim_id !== claimId ||
              typeof payload.statement !== "string" ||
              (version > 1 && payload.base_version !== version - 1)
            )
              throw new ScientificInputError(
                "Claim content does not match the requested identity.",
              );
            projected.statement = payload.statement;
            projected.dependency_pins = dependencyPins;
            projected.dependency_assessment = rootAssessment ?? null;
            projected.proof_obligations = obligations.summary;
            projected.dependency_closure = {
              scope: "publication-pins",
              through,
              scan_complete: closure.complete,
              verified_dependencies: closure.nodes.length,
              unavailable_dependencies: closure.unavailable.length,
              boundary: "Declared dependency structure, not established implications. The separate dependency_assessment folds scientific inputs at this cursor and reports a weakest-link ceiling only when complete. Whole records remain subject to the face/pack budget and omissions.",
            };
          } else if (kind === "claim-dependency") {
            const node = closure.nodes[position];
            if (
              !node ||
              row.id !== node.target ||
              projected.event !== node.row.event_id ||
              payload.claim_id !== node.row.claim_id ||
              typeof payload.statement !== "string" ||
              (node.row.version > 1 && payload.base_version !== node.row.version - 1)
            )
              throw new ScientificInputError(
                "Dependency content does not match its publication pin.",
              );
            projected.statement = payload.statement;
          } else if (kind === "claim-review") {
            if (
              payload.target_claim_id !== claimId ||
              payload.target_version !== version ||
              typeof claimBody.sponsor !== "string" ||
              typeof projected.sponsor !== "string"
            )
              throw new ScientificInputError("Review content does not match its version pin.");
            projected.tier = recordedReviewIndependence(
              payload,
              claimBody.sponsor,
              projected.sponsor,
            ).tier;
            for (const key of [
              "verdict",
              "basis",
              "capable_of_failure",
              "rubric",
              "body_md",
              "scientific_provenance",
              "verification",
            ])
              projected[key] = payload[key] ?? null;
            // Novelty reviews show their search record (Fable §6.6(c)); other
            // review bodies are unchanged.
            if (payload.novelty !== undefined) projected.novelty = payload.novelty;
          } else {
            if (
              payload.bears_on_kind !== "claim" ||
              payload.bears_on_id !== claimId ||
              payload.bears_on_version !== version
            )
              throw new ScientificInputError("Evidence content does not match its version pin.");
            for (const key of [
              "kind",
              "direction",
              "computed_class",
              "coercion_flags",
              "mode",
              "computation_domain_or_floor",
              "reproduction",
              "selected_hypothesis_id",
              "body_md",
            ])
              projected[key] = payload[key] ?? null;
            const source = payload.source;
            if (source === null || typeof source !== "object" || Array.isArray(source))
              throw new ScientificInputError("Evidence source provenance is unavailable.");
            const provenance = source as Record<string, unknown>;
            projected.source_kind = provenance.kind;
            projected.locator = provenance.locator ?? null;
            projected.excerpt = provenance.excerpt ?? null;
          }
          body = JSON.stringify(projected);
        } catch (error) {
          if (!(error instanceof ScientificInputError)) throw error;
        }
      }
      if (body === null) {
        section.omitted.push({ reason: "content_unavailable", detail: row.id });
        if (kind === "claim-detail") return section;
      } else if (body.length > 18000 || neutralizeUntrustedBody(body).text.length > 18000) {
        // Check both original and neutralized size; escaping can expand hostile
        // markers. Never let one record break the pack or truncate the object.
        section.omitted.push({ reason: "item_too_large", detail: row.id });
      } else {
        section.candidates.push({
          kind,
          id: row.id,
          scope: "ledger",
          untrusted: true,
          tokens: 1,
          body,
          why_included: `public record for ${problemId}#${target} at the pack cursor`,
          stable_prefix: 3 + index * LEDGER_PACK_CANDIDATE_LIMIT + position,
        });
      }
    }
    if (rows.length === 0 && (kind !== "claim-dependency" || closure.complete))
      section.candidates.push({
        kind: "standing-context",
        id: `SYS-${kind}-empty`,
        scope: "system",
        untrusted: false,
        tokens: 1,
        body: `No recorded ${kind} for ${target} at this cursor.`,
        why_included: "state the exact-version baseline without inventing support",
        stable_prefix: 3 + index * LEDGER_PACK_CANDIDATE_LIMIT,
      });
  }
  section.candidates.push(...obligations.candidates);
  return section;
}

/** Public ledger only. Call after session ownership and membership checks.
 * Every mutable head/lifecycle is reconstructed at the caller's captured cut;
 * no later revision or settlement may be borrowed from a projection's head.
 * Current redaction still wins over an older cursor.
 */
export async function readLedgerPackSection(
  db: Env["DB"],
  problemId: string,
  cursor: number,
  profile: PackProfile,
  /** claim-graph only: the one relation asserted at this event seq (its
   * public cite), for the relation item face (bead asimposiumorg-qvzk). */
  options: { readonly relationSeq?: number } = {},
): Promise<LedgerPackSection> {
  if (profile === "formal") {
    // The public gap face and formal pack share event/hash/lifecycle decoding.
    // Projection text and a missing settlement body cannot manufacture proof.
    return readFormalGapSection(db, problemId, cursor, {
      gaps: loadProofGaps,
      neutralize: (body) => neutralizeUntrustedBody(body).text,
    });
  }
  if (profile === "graveyard") {
    // Negative knowledge shares the canonical public event reader. Each
    // independently bounded source reports its own outage without erasing the
    // other section or falling back to retained projection/workshop text.
    const killed = await readKilledHypothesisPack(db, problemId, cursor, {
      load: loadKilledHypotheses,
      neutralize: (body) => neutralizeUntrustedBody(body).text,
    });
    const friction = await readGraveyardFrictionSection(db, problemId, cursor, {
      records: loadFormalRecords,
      neutralize: (body) => neutralizeUntrustedBody(body).text,
    });
    return {
      candidates: [...killed.candidates, ...friction.candidates],
      omitted: [...killed.omitted, ...friction.omitted],
    };
  } else if (profile === "claim-graph") {
    const result = await readClaimRelations(db, problemId, cursor, options);
    const omitted = [...result.omitted];
    const candidates: PackCandidate[] = [];
    const claimRead = (target: string) =>
      `/p/${encodeURIComponent(problemId)}/claims/${encodeURIComponent(target)}.md?through=${cursor}`;
    for (const [index, relation] of result.relations.entries()) {
      const status = relation.status === "unavailable"
        ? "Status: unavailable. A dispute was recorded but its current content or lifecycle could not be verified; no clean edge is implied."
        : relation.status === "disputed"
          ? `Status: disputed. A dispute is recorded at #${relation.dispute!.seq}.`
          : "Status: asserted at this cursor.";
      const p = relation.provenance;
      const body = [
        `Asserted relation: ${relation.source} ${relation.kind} ${relation.target}`,
        `Version pins: ${relation.pins}. ${status}`,
        "This edge is an assertion, not an established implication. Pin freshness is version metadata, not a claim disposition or evidence ceiling.",
        `Provenance: ${problemId}#${relation.seq}; event=${relation.event}; fellow=${p.fellow ?? "unavailable"}; sponsor=${p.sponsor ?? "unavailable"}; session=${p.session ?? "unavailable"}`,
        `Self-declared model: ${p.model_self_declared ?? "unavailable"}`,
        `Self-declared harness: ${p.harness_self_declared ?? "unavailable"}`,
        ...(relation.dispute ? [`Recorded dispute (untrusted work product): ${JSON.stringify(relation.dispute)}`] : []),
        `Source read at cursor ${cursor}: ${claimRead(relation.source)}`,
        relation.target.startsWith("C-")
          ? `Target read at cursor ${cursor}: ${claimRead(relation.target)}`
          : `Gap read (live): /p/${encodeURIComponent(problemId)}/gaps/${encodeURIComponent(relation.target)}.md`,
      ].join("\n");
      if (body.length > 18000 || neutralizeUntrustedBody(body).text.length > 18000) {
        omitted.push({ reason: "item_too_large", detail: `typed-relations:${relation.event}` });
        continue;
      }
      candidates.push({
        kind: "claim-relation", id: relation.event, scope: "ledger", untrusted: true,
        tokens: 1, body,
        why_included: "digest-checked relation assertion and available dispute at the pack cursor; not an established implication",
        stable_prefix: 20 + index,
      });
    }
    if (result.scopeAvailable && result.relations.length === 0 && omitted.length === 0) {
      candidates.push({
        kind: "standing-context", id: "SYS-typed-relations-empty", scope: "system",
        untrusted: false, tokens: 1,
        body: "No recorded typed-relations are available at this problem cursor.",
        why_included: "state the typed-relations baseline without inventing a scientific result",
        stable_prefix: 20,
      });
    }
    return { candidates, omitted };
  } else if (profile === "literature") {
    const result = await loadProblemCitations(db, problemId, {
      through: cursor,
      limit: LEDGER_PACK_CANDIDATE_LIMIT,
    });
    const omitted: LedgerPackSection["omitted"] = result.omitted.map((detail) => ({
      reason: "source_omission",
      detail,
    }));
    const candidates: PackCandidate[] = [];
    for (const [index, item] of result.citations.entries()) {
      const target = `${item.citation_id}@${item.version}`;
      const body = JSON.stringify({
        ...item,
        source: `/p/${problemId}/citations/${target}.md?through=${cursor}`,
      });
      if (body.length > 18000 || neutralizeUntrustedBody(body).text.length > 18000) {
        omitted.push({ reason: "item_too_large", detail: `literature:${target}` });
        continue;
      }
      candidates.push({
        kind: "citation",
        id: target,
        scope: "ledger",
        untrusted: true,
        tokens: 1,
        body,
        why_included:
          "committed public citation version at the pack cursor; source provenance and model declarations are not verification",
        stable_prefix: 20 + index,
      });
    }
    if (candidates.length === 0 && omitted.length === 0) {
      candidates.push({
        kind: "standing-context",
        id: "SYS-literature-empty",
        scope: "system",
        untrusted: false,
        tokens: 1,
        body: "No readable published citations are available at this problem cursor. This is not a claim that no relevant literature exists.",
        why_included: "state the public literature baseline without inventing a source",
        stable_prefix: 20,
      });
    }
    return { candidates, omitted };
  } else {
    return { candidates: [], omitted: [] };
  }
}