import type { AuthorConcession, AuthorConcessionPublication } from "@asimposium/contracts";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { claimContentDigest } from "../krater/claim-version.ts";
import { sha256Hex } from "../krater/krater.ts";
import {
  readScientificClaim,
  readScientificEvidence,
  scientificContentGuards,
  ScientificInputError,
  type ScientificClaim,
  type ScientificEvidence,
} from "./scientific-checks.ts";
import { readScientificDispositions } from "./scientific-disposition.ts";

export interface PreparedAuthorConcession {
  targetObject: string;
  publication: AuthorConcessionPublication;
  claim: ScientificClaim;
  evidence: ScientificEvidence;
}

/** Current admission only. Historical readers use the immutable publication pins. */
export async function prepareAuthorConcession(
  db: D1Database,
  problemId: string,
  claimId: string,
  author: string,
  input: AuthorConcession,
): Promise<PreparedAuthorConcession> {
  const claim = await readScientificClaim(db, problemId, claimId, input.target_version);
  const original = await db
    .prepare(`SELECT actor_fellow_id FROM events
    WHERE problem_id = ? AND object_id = ? AND object_kind = 'claim'
      AND type = 'claim.created' AND object_version = 1 ORDER BY seq LIMIT 1`)
    .bind(problemId, claimId)
    .first<{ actor_fellow_id: string }>();
  if (original?.actor_fellow_id !== author || claim.fellowId !== author)
    throw new ScientificInputError("Only the original claim author can concede this version.");
  if (!claim.payloadJson) throw new ScientificInputError("The exact claim source is unavailable.");
  const payload = JSON.parse(claim.payloadJson) as Record<string, unknown>;
  const contentDigest = await claimContentDigest(
    {
      kind: String(payload.kind),
      statement: claim.statement,
      falsifier: typeof payload.falsifier === "string" ? payload.falsifier : null,
    },
    sha256Hex,
  );
  if (input.target_digest !== claim.contentDigest || input.target_digest !== contentDigest)
    throw new ScientificInputError("The concession must pin the exact published statement digest.");
  const head = await db
    .prepare(`SELECT p.public_seq,
      (SELECT MAX(version) FROM claim_versions WHERE problem_id = p.id AND claim_id = ?) AS version
    FROM problems p WHERE p.id = ?`)
    .bind(claimId, problemId)
    .first<{ public_seq: number; version: number }>();
  if (!head || head.version !== input.target_version)
    throw new ScientificInputError(
      "Only the current claim version can be conceded; fetch its exact pin.",
    );
  const current = (
    await readScientificDispositions(db, problemId, head.public_seq, 1, {
      claimId,
      version: input.target_version,
    })
  ).get(claimId);
  if (
    !current ||
    ["malformed", "refuted", "withdrawn", "superseded", "draft"].includes(current.disposition)
  )
    throw new ScientificInputError(
      "This claim version has no live scientific standing to concede.",
    );
  const evidence = await readScientificEvidence(db, problemId, claim, input.evidence);
  if (evidence.direction !== "refutes" && evidence.direction !== "fails-to-reproduce")
    throw new ScientificInputError(
      "A concession must cite published counterevidence for this exact claim version.",
    );
  const chronology = await db
    .prepare(`SELECT 1 AS valid FROM events claim JOIN events evidence
    ON evidence.problem_id = claim.problem_id AND evidence.seq > claim.seq
    WHERE claim.id = ? AND evidence.id = ?`)
    .bind(claim.eventId, evidence.eventId)
    .first();
  if (!chronology)
    throw new ScientificInputError(
      "The counterevidence must follow publication of the exact claim version.",
    );
  const source = (item: ScientificClaim | ScientificEvidence) => ({
    event_id: item.eventId,
    digest: `sha256:${item.payloadDigest}`,
    fellow_id: item.fellowId,
    sponsor_id: item.sponsorId,
  });
  return {
    targetObject: `${claimId}@${input.target_version}`,
    publication: { ...input, claim_source: source(claim), evidence_source: source(evidence) },
    claim,
    evidence,
  };
}

/** Rechecked in the same Krater transaction as the event, replay and quota settlement. */
export function authorConcessionStatements(
  db: D1Database,
  problemId: string,
  prepared: PreparedAuthorConcession,
  eventId: string,
  eventDigest: string,
): D1PreparedStatement[] {
  const { claim, evidence } = prepared;
  return [
    ...scientificContentGuards(db, [claim, evidence]),
    db
      .prepare(`INSERT INTO claim_concessions
      (event_id, event_sha256, problem_id, claim_id, claim_version, claim_event_id, evidence_event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        eventId,
        eventDigest,
        problemId,
        claim.claimId,
        claim.version,
        claim.eventId,
        evidence.eventId,
      ),
  ];
}
