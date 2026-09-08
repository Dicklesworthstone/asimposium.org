import {
  FormalArtifactSchema,
  type GroundedFalsificationCheck,
  type ScientificEvidenceReference,
  type ScientificProvenance,
  ScientificProvenanceSchema,
  type ScientificVerification,
} from "@asimposium/contracts";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { sha256Hex } from "../krater/krater.ts";

export const SCIENTIFIC_INDEPENDENCE_POLICY = "declared-family-and-grounded-method-v1";

/** Interpret a verified publication, never the current sponsor binding or a
 * legacy projection's tier. This is publication provenance, not a fresh check
 * that its supporting evidence remains available. */
export function recordedReviewIndependence(
  payload: Record<string, unknown>,
  authorSponsorId: string,
  reviewerSponsorId: string,
): { tier: "T0" | "T1" | "T2" | "T3"; legacy: boolean } {
  if (
    payload.independence_policy === SCIENTIFIC_INDEPENDENCE_POLICY &&
    (payload.tier === "T0" ||
      payload.tier === "T1" ||
      payload.tier === "T2" ||
      payload.tier === "T3")
  ) {
    return { tier: payload.tier, legacy: false };
  }
  return { tier: authorSponsorId === reviewerSponsorId ? "T0" : "T1", legacy: true };
}

export class ScientificInputError extends Error {}

export interface ScientificContentIdentity {
  eventId: string;
  payloadDigest: string;
}

export interface ScientificClaim extends ScientificContentIdentity {
  claimId: string;
  version: number;
  contentDigest: string;
  statement: string;
  fellowId: string;
  sponsorId: string;
  provenance: ScientificProvenance | null;
}

export interface ScientificEvidence extends ScientificContentIdentity {
  evidenceId: string;
  fellowId: string;
  sponsorId: string;
  kind: string;
  direction: string;
  body: string;
  payload: Record<string, unknown>;
}

type ContentRow = {
  event_id: string;
  payload_sha256: string;
  payload_json: string;
  fellow_id: string;
  sponsor_id: string;
};

export async function checkedScientificPayload(
  row: Pick<ContentRow, "payload_sha256" | "payload_json">,
): Promise<Record<string, unknown>> {
  if ((await sha256Hex(row.payload_json)) !== row.payload_sha256) {
    throw new ScientificInputError(
      "The referenced public content no longer matches its ledger digest.",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(row.payload_json);
  } catch {
    throw new ScientificInputError("The referenced scientific work product is not valid JSON.");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ScientificInputError("The referenced public content is unavailable.");
  }
  return value as Record<string, unknown>;
}

export function readScientificProvenance(value: unknown): ScientificProvenance | null {
  const parsed = ScientificProvenanceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function readScientificClaim(
  db: D1Database,
  problemId: string,
  claimId: string,
  version: number,
): Promise<ScientificClaim> {
  const row = await db
    .prepare(`
    SELECT e.id AS event_id, e.payload_sha256, c.payload_json,
      e.actor_fellow_id AS fellow_id, e.actor_sponsor_id AS sponsor_id,
      v.content_digest, v.statement
    FROM claim_versions v JOIN events e ON e.problem_id = v.problem_id
      AND e.object_id = v.claim_id AND e.object_version = v.version
      AND e.object_kind = 'claim' AND e.type IN ('claim.created', 'claim.revised')
    JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256
      AND c.redacted_at IS NULL
    WHERE v.problem_id = ? AND v.claim_id = ? AND v.version = ?
    ORDER BY e.seq ASC LIMIT 1
  `)
    .bind(problemId, claimId, version)
    .first<ContentRow & { content_digest: string; statement: string }>();
  if (!row) throw new ScientificInputError("The exact public claim version is unavailable.");
  const payload = await checkedScientificPayload(row);
  return {
    eventId: row.event_id,
    payloadDigest: row.payload_sha256,
    claimId,
    version,
    contentDigest: row.content_digest,
    statement: row.statement,
    fellowId: row.fellow_id,
    sponsorId: row.sponsor_id,
    provenance: readScientificProvenance(payload.scientific_provenance),
  };
}

export async function readScientificEvidence(
  db: D1Database,
  problemId: string,
  claim: ScientificClaim,
  reference: ScientificEvidenceReference,
): Promise<ScientificEvidence> {
  const row = await db
    .prepare(`
    SELECT e.id AS event_id, e.payload_sha256, c.payload_json,
      e.actor_fellow_id AS fellow_id, e.actor_sponsor_id AS sponsor_id
    FROM events e JOIN event_content c ON c.event_id = e.id
      AND c.payload_sha256 = e.payload_sha256 AND c.redacted_at IS NULL
    WHERE e.problem_id = ? AND e.object_id = ? AND e.object_kind = 'evidence'
      AND e.type = 'evidence.created' AND e.object_version = 1
    ORDER BY e.seq ASC LIMIT 1
  `)
    .bind(problemId, reference.evidence_id)
    .first<ContentRow>();
  if (!row || reference.digest !== `sha256:${row.payload_sha256}`) {
    throw new ScientificInputError(
      "An evidence reference is unavailable or has a different content digest.",
    );
  }
  const payload = await checkedScientificPayload(row);
  if (
    payload.bears_on_kind !== "claim" ||
    payload.bears_on_id !== claim.claimId ||
    payload.bears_on_version !== claim.version
  ) {
    throw new ScientificInputError(
      "Every evidence reference must identify this exact claim version on this problem.",
    );
  }
  if (payload.mode !== "confirmatory" || payload.selected_hypothesis_id != null) {
    throw new ScientificInputError(
      "Exploratory or selection-contaminated evidence cannot ground independent verification.",
    );
  }
  if (payload.computed_class === "assertion" || payload.computed_class === "heuristic") {
    throw new ScientificInputError(
      "Assertion-only or heuristic evidence cannot ground independent verification.",
    );
  }
  if (
    typeof payload.kind !== "string" ||
    typeof payload.direction !== "string" ||
    typeof payload.body_md !== "string" ||
    payload.body_md.trim().length === 0
  ) {
    throw new ScientificInputError("The referenced scientific work product is incomplete.");
  }
  return {
    eventId: row.event_id,
    payloadDigest: row.payload_sha256,
    evidenceId: reference.evidence_id,
    fellowId: row.fellow_id,
    sponsorId: row.sponsor_id,
    kind: payload.kind,
    direction: payload.direction,
    body: payload.body_md,
    payload,
  };
}

export async function resolveScientificReferences(
  db: D1Database,
  problemId: string,
  claim: ScientificClaim,
  references: readonly ScientificEvidenceReference[],
): Promise<ScientificEvidence[]> {
  if (new Set(references.map((item) => item.evidence_id)).size !== references.length) {
    throw new ScientificInputError("List each grounding evidence object once.");
  }
  return Promise.all(
    references.map((reference) => readScientificEvidence(db, problemId, claim, reference)),
  );
}

export async function validateFalsificationCheck(
  db: D1Database,
  problemId: string,
  claim: ScientificClaim,
  check: GroundedFalsificationCheck,
  direction: string,
): Promise<ScientificEvidence[]> {
  if (check.target_digest !== claim.contentDigest) {
    throw new ScientificInputError(
      "The check target digest must match the exact published claim version.",
    );
  }
  const refutes = direction === "refutes" || direction === "fails-to-reproduce";
  if ((check.result === "fired") !== refutes) {
    throw new ScientificInputError(
      "A fired falsifier is refuting evidence; a surviving check is not a refutation.",
    );
  }
  return resolveScientificReferences(db, problemId, claim, check.evidence);
}

export async function inspectFormalArtifact(value: unknown): Promise<string | null> {
  const parsed = FormalArtifactSchema.safeParse(value);
  if (!parsed.success) return null;
  const artifact = parsed.data;
  // This is only the conservative source/axiom scan from Fable §6.5. A passed
  // scan never says that Lean compiled or that the theorem matches the claim.
  if (
    /\b(?:sorry|sorryAx|admit|axiom)\b/u.test(artifact.source) ||
    /\b(?:sorry|sorryAx|admit)\b/u.test(artifact.axiom_report) ||
    !artifact.source.includes(artifact.declaration) ||
    !artifact.axiom_report.includes(artifact.declaration)
  )
    return null;
  return `sha256:${await sha256Hex(artifact.source)}`;
}

export async function validateScientificVerification(
  db: D1Database,
  problemId: string,
  claim: ScientificClaim,
  verification: ScientificVerification,
  reviewerFellowId: string,
  reviewerSponsorId: string,
): Promise<{ evidence: ScientificEvidence; fullWriteUp: boolean; certifiedArtifact: boolean }> {
  const evidence = await readScientificEvidence(db, problemId, claim, verification.evidence);
  return assessScientificVerification(
    claim,
    evidence,
    verification,
    reviewerFellowId,
    reviewerSponsorId,
  );
}

/** Same assessment at publication and read time. Read consumers supply only
 * digest-checked, still-public evidence resolved from the current ledger cut. */
export async function assessScientificVerification(
  claim: ScientificClaim,
  evidence: ScientificEvidence,
  verification: ScientificVerification,
  reviewerFellowId: string,
  reviewerSponsorId: string,
): Promise<{ evidence: ScientificEvidence; fullWriteUp: boolean; certifiedArtifact: boolean }> {
  if (
    verification.target_digest !== claim.contentDigest ||
    verification.evidence.evidence_id !== evidence.evidenceId ||
    verification.evidence.digest !== `sha256:${evidence.payloadDigest}`
  ) {
    throw new ScientificInputError(
      "The verification must match the exact published claim and evidence digests.",
    );
  }
  if (evidence.fellowId === reviewerFellowId || evidence.sponsorId === reviewerSponsorId) {
    throw new ScientificInputError(
      "Independent verification requires a different Fellow and sponsor from the evidence author.",
    );
  }
  if (evidence.direction !== "supports" && evidence.direction !== "reproduces") {
    throw new ScientificInputError(
      "Strong-support verification must identify supporting evidence.",
    );
  }
  if (verification.kind === "full-write-up") {
    if (evidence.kind !== "argument" && evidence.kind !== "construction") {
      throw new ScientificInputError(
        "A full-write-up review must identify the published argument or construction.",
      );
    }
    return { evidence, fullWriteUp: verification.result === "verified", certifiedArtifact: false };
  }
  const artifact = FormalArtifactSchema.safeParse(evidence.payload.formal_artifact);
  const scannedDigest = await inspectFormalArtifact(evidence.payload.formal_artifact);
  if (
    evidence.kind !== "certificate" ||
    !artifact.success ||
    scannedDigest === null ||
    scannedDigest !== verification.artifact_digest
  ) {
    throw new ScientificInputError(
      "The formal verification must identify the exact source of a qualifying published artifact.",
    );
  }
  if (
    verification.compilation.toolchain !== artifact.data.toolchain ||
    verification.statement_comparison.declaration !== artifact.data.declaration ||
    verification.statement_comparison.statement !== claim.statement
  ) {
    throw new ScientificInputError(
      "The verification must record the published toolchain, declaration and exact claim statement.",
    );
  }
  return {
    evidence,
    fullWriteUp: false,
    certifiedArtifact:
      verification.compilation.result === "success" &&
      verification.statement_comparison.result === "equivalent",
  };
}

/** Recheck identities inside the same D1 batch as event/projection/replay. The
 * invalid JSON path gives a recognizable transaction-aborting SQLite error,
 * without introducing mutable scientific status or another storage table. */
export function scientificContentGuards(
  db: D1Database,
  identities: readonly ScientificContentIdentity[],
): D1PreparedStatement[] {
  return [...new Map(identities.map((identity) => [identity.eventId, identity])).values()].map(
    (identity) =>
      db
        .prepare(`SELECT CASE WHEN EXISTS (
      SELECT 1 FROM event_content c JOIN events e ON e.id = c.event_id
      WHERE c.event_id = ? AND c.payload_sha256 = ? AND e.payload_sha256 = c.payload_sha256
        AND c.redacted_at IS NULL
    ) THEN 1 ELSE json_extract('[]', '$[SCIENTIFIC_REFERENCE_CHANGED') END`)
        .bind(identity.eventId, identity.payloadDigest),
  );
}

export function isScientificReferenceChanged(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("SCIENTIFIC_REFERENCE_CHANGED") ||
      (error.cause !== undefined && isScientificReferenceChanged(error.cause)))
  );
}
