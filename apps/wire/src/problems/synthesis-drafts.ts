/**
 * Fable §6.1 Synthesis draft -> steward/authoring-sponsor publish gate (bead nkz2).
 *
 * Automated syntheses created with `draft: true` persist privately in
 * `synthesis_drafts` (absent from `events` and anonymous `/p/:id/syntheses`).
 * Publishing requires a problem steward OR the authoring Fellow's current
 * sponsor, re-validates P13 ledger anchors at publish time, commits a canonical
 * `synthesis.created` event preserving the Fellow as scientific author while
 * recording `published_by_principal_id`, and leaves prior versions immutable.
 */

import {
  type ClosingSynthesisDeclaration,
  ClosingSynthesisDeclarationSchema,
  SYNTHESES_SCHEMA_ID,
  SYNTHESIS_DRAFT_PAGE_MAX_BYTES,
  type SynthesisAnchor,
  SynthesisAnchorSchema,
  type SynthesisDraftCursor,
  type SynthesisDraftListResponse,
  SynthesisDraftListResponseSchema,
  type SynthesisDraftPublishResponse,
  SynthesisDraftPublishResponseSchema,
  type SynthesisDraftRecord,
  SynthesisDraftRecordSchema,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import { validatedProblem } from "../http/envelope.ts";
import {
  canonicalJson,
  KraterIdempotencyConflictError,
  KraterLedgerPreconditionError,
  writeLedgerEvent,
} from "../krater/krater.ts";
import { validateSynthesisAnchors } from "../ledger/synthesis.ts";
import {
  isSynthesisReferenceChanged,
  synthesisAnchorGuards,
} from "../ledger/synthesis-references.ts";
import { isScreeningPostureChangedError } from "../moderation/posture.ts";
import {
  readSponsorSuspensionStatus,
  SponsorSuspensionError,
} from "../moderation/sponsor-suspension.ts";
import { scanFieldsForCredentials } from "../screening/credential-scan.ts";
import {
  isScreeningDecisionChangedError,
  type ScreenedPublication,
  screeningPublicationStatements,
} from "../screening/ingress.ts";
import { screeningHoldResponse } from "../screening/public-candidate.ts";
import {
  isScreeningContextStaleError,
  screeningContextStaleProblem,
  screeningContextUnavailableProblem,
} from "../screening/publication-context.ts";
import type { WorkersAIPromotionInput } from "../screening/workers-ai.ts";
import {
  archivedProblemWriteProblem,
  isArchivedProblemWriteError,
} from "../sessions/problem-archive-admission.ts";
import {
  checkAndReserveQuota,
  promotionRateLimitedProblem,
  settleQuotaReservation,
  settleQuotaReservationStatement,
} from "../sessions/quota.ts";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function mintCrockfordId(prefix: string): string {
  const bytes = new Uint8Array(26);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += CROCKFORD[b & 31];
  return `${prefix}-${out}`;
}

export interface DraftRow {
  synthesis_id: string;
  problem_id: string;
  covers_through: number;
  body_md: string;
  anchors_json: string;
  omitted_json: string;
  selection_policy: string;
  closing_resolution_json: string | null;
  dropped_single_author_count: number;
  author_fellow_id: string;
  author_sponsor_id: string;
  session_id: string;
  declared_model: string;
  harness: string;
  state: "draft" | "published";
  published_by_principal_id: string | null;
  published_event_id: string | null;
  published_seq: number | null;
  published_at: string | null;
  created_at: string;
}

export function parseDraftRow(row: DraftRow): SynthesisDraftRecord {
  const anchors = z.array(SynthesisAnchorSchema).parse(JSON.parse(row.anchors_json));
  const omitted = z.array(z.string()).parse(JSON.parse(row.omitted_json));
  const closing =
    row.closing_resolution_json !== null
      ? ClosingSynthesisDeclarationSchema.parse(JSON.parse(row.closing_resolution_json))
      : undefined;
  return SynthesisDraftRecordSchema.parse({
    synthesis_id: row.synthesis_id,
    problem_id: row.problem_id,
    state: row.state,
    covers_through: row.covers_through,
    body_md: row.body_md,
    anchors,
    omitted,
    selection_policy: row.selection_policy,
    ...(closing !== undefined ? { closing_resolution: closing } : {}),
    dropped_single_author_count: row.dropped_single_author_count,
    author_fellow_id: row.author_fellow_id,
    author_sponsor_id: row.author_sponsor_id,
    session_id: row.session_id,
    declared_model: row.declared_model,
    harness: row.harness,
    published_by_principal_id: row.published_by_principal_id,
    published_event_id: row.published_event_id,
    published_seq: row.published_seq,
    published_at: row.published_at,
    created_at: row.created_at,
  });
}

async function isProblemSteward(
  db: D1Database,
  problemId: string,
  sponsorId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS ok FROM problems p
       JOIN sponsors s ON s.sponsor_id = ? AND s.tombstoned_at IS NULL
       WHERE p.id = ?
         AND (p.sponsor_id = s.sponsor_id
              OR EXISTS (SELECT 1 FROM problem_stewards ps
                         WHERE ps.problem_id = p.id AND ps.sponsor_id = s.sponsor_id))`,
    )
    .bind(sponsorId, problemId)
    .first<{ ok: number }>();
  return row !== null;
}

async function isCurrentSponsorOfFellow(
  db: D1Database,
  fellowId: string,
  sponsorId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS ok FROM enrollment_fellows f
       JOIN sponsors s ON s.sponsor_id = f.sponsor_id AND s.tombstoned_at IS NULL
       WHERE f.fellow_id = ? AND f.sponsor_id = ?`,
    )
    .bind(fellowId, sponsorId)
    .first<{ ok: number }>();
  return row !== null;
}

async function readSponsorStanding(
  db: D1Database,
  sponsorId: string,
): Promise<"active" | "suspended" | "missing-or-tombstoned"> {
  try {
    const standing = await readSponsorSuspensionStatus(db, sponsorId);
    return standing.status;
  } catch (error) {
    if (error instanceof SponsorSuspensionError && error.code === "NOT_FOUND") {
      return "missing-or-tombstoned";
    }
    throw error;
  }
}

const DRAFT_PAGE_LIMIT = 8;
const DRAFT_PAGE_TARGET_BYTES = 224 * 1024;

export async function listSynthesisDraftsForSponsor(
  db: D1Database,
  problemId: string,
  sponsorId: string,
  page?: { readonly after?: SynthesisDraftCursor | undefined },
): Promise<SynthesisDraftListResponse> {
  const after = page?.after;
  // Check current ownership, stewardship, and erasure in the same read as the
  // private bodies. A continuation carries a position and grants no access.
  const { results: rows } = await db
    .prepare(
      `SELECT d.* FROM synthesis_drafts d
     JOIN problems p ON p.id = d.problem_id
     JOIN sponsors s ON s.sponsor_id = ? AND s.tombstoned_at IS NULL
     WHERE d.problem_id = ?
       AND (p.sponsor_id = s.sponsor_id
         OR EXISTS (SELECT 1 FROM problem_stewards ps WHERE ps.problem_id = p.id AND ps.sponsor_id = s.sponsor_id)
         OR (p.status <> 'private-draft' AND EXISTS (
           SELECT 1 FROM enrollment_fellows f WHERE f.fellow_id = d.author_fellow_id AND f.sponsor_id = s.sponsor_id
         )))
       AND NOT EXISTS (SELECT 1 FROM private_draft_erasures e WHERE e.problem_id = d.problem_id)
       ${after ? "AND (d.created_at, d.synthesis_id) < (?, ?)" : ""}
     ORDER BY d.created_at DESC, d.synthesis_id DESC LIMIT ?`,
    )
    .bind(
      sponsorId,
      problemId,
      ...(after ? [after.created_at, after.synthesis_id] : []),
      page ? DRAFT_PAGE_LIMIT + 1 : 50,
    )
    .all<DraftRow>();

  const face: SynthesisDraftListResponse = {
    schema: SYNTHESES_SCHEMA_ID,
    problem_id: problemId,
    drafts: [],
  };
  if (!page) {
    face.drafts = rows.map(parseDraftRow);
    return SynthesisDraftListResponseSchema.parse(face);
  }

  const encoder = new TextEncoder();
  // Reserve space for the outer object and cursor. All sizes are serialized
  // UTF-8, including JSON escapes in scientific text and selection notes.
  let bytes = 1024;
  for (const row of rows.slice(0, DRAFT_PAGE_LIMIT)) {
    const draft = parseDraftRow(row);
    const itemBytes = encoder.encode(JSON.stringify(draft)).length + 1;
    if (face.drafts.length > 0 && bytes + itemBytes > DRAFT_PAGE_TARGET_BYTES) break;
    if (bytes + itemBytes > SYNTHESIS_DRAFT_PAGE_MAX_BYTES)
      throw new Error("Synthesis draft exceeds the private response limit.");
    bytes += itemBytes;
    face.drafts.push(draft);
  }
  const last = face.drafts.at(-1);
  if (last && face.drafts.length < rows.length) {
    face.next_after = { created_at: last.created_at, synthesis_id: last.synthesis_id };
  }
  return SynthesisDraftListResponseSchema.parse(face);
}

export type PublishDraftResult =
  | { readonly ok: true; readonly status: 200 | 201; readonly body: SynthesisDraftPublishResponse }
  | {
      readonly ok: false;
      readonly status: 403 | 404 | 422;
      readonly code:
        | "PROBLEM_NOT_FOUND"
        | "WORKSHOP_NOT_FOUND"
        | "WRITE_REFUSED"
        | "CLAIMS_BOARD_LOCKED"
        | "SYNTHESIS_UNANCHORED"
        | "SECRET_SHAPED_CONTENT";
      readonly detail: string;
    };

function publishedDraftReceipt(draft: DraftRow): PublishDraftResult | undefined {
  if (
    draft.state !== "published" ||
    !draft.published_event_id ||
    !draft.published_seq ||
    !draft.published_at ||
    !draft.published_by_principal_id
  ) {
    return undefined;
  }
  const anchors = z.array(SynthesisAnchorSchema).parse(JSON.parse(draft.anchors_json));
  return {
    ok: true,
    status: 200,
    body: SynthesisDraftPublishResponseSchema.parse({
      synthesis_id: draft.synthesis_id,
      problem_id: draft.problem_id,
      state: "published",
      covers_through: draft.covers_through,
      anchors_count: anchors.length,
      dropped_single_author_count: draft.dropped_single_author_count,
      author_fellow_id: draft.author_fellow_id,
      published_by_principal_id: draft.published_by_principal_id,
      event_id: draft.published_event_id,
      sequence: draft.published_seq,
      published_at: draft.published_at,
    }),
  };
}

export async function publishSynthesisDraftForSponsor(
  db: D1Database,
  problemId: string,
  synthesisId: string,
  sponsorId: string,
  screening?: {
    readonly sponsorLimit: number;
    readonly screen: (
      candidate: WorkersAIPromotionInput,
      authorSponsorId: string,
    ) => Promise<Response | ScreenedPublication>;
  },
): Promise<PublishDraftResult | Response> {
  const problem = await db
    .prepare("SELECT id, status, admission_mode FROM problems WHERE id = ?")
    .bind(problemId)
    .first<{ id: string; status: string; admission_mode: string }>();
  if (!problem) {
    return {
      ok: false,
      status: 404,
      code: "PROBLEM_NOT_FOUND",
      detail: `No problem with id '${problemId}' exists.`,
    };
  }
  const steward = await isProblemSteward(db, problemId, sponsorId);
  if (problem.status === "private-draft" && !steward) {
    // Never disclose whether a private-draft problem or any draft on it exists to non-stewards.
    return {
      ok: false,
      status: 404,
      code: "PROBLEM_NOT_FOUND",
      detail: `No problem with id '${problemId}' exists.`,
    };
  }
  const draft = await db
    .prepare(
      `SELECT d.* FROM synthesis_drafts d WHERE d.problem_id = ? AND d.synthesis_id = ?
       AND NOT EXISTS (SELECT 1 FROM private_draft_erasures e WHERE e.problem_id = d.problem_id)`,
    )
    .bind(problemId, synthesisId)
    .first<DraftRow>();
  if (!draft) {
    return {
      ok: false,
      status: 404,
      code: "WORKSHOP_NOT_FOUND",
      detail: `No synthesis draft '${synthesisId}' exists for problem '${problemId}'.`,
    };
  }

  // Suspended, unknown, or tombstoned sponsors cannot publish private drafts to the public ledger.
  const standing = await readSponsorStanding(db, sponsorId);
  if (standing !== "active") {
    return {
      ok: false,
      status: 403,
      code: "WRITE_REFUSED",
      detail:
        standing === "suspended"
          ? "Suspended sponsors cannot publish synthesis drafts."
          : "Only an active steward or the authoring Fellow's sponsor may publish a draft synthesis.",
    };
  }

  // Fable §6.1: only a problem steward OR the authoring Fellow's current sponsor may publish.
  const authorized =
    steward || (await isCurrentSponsorOfFellow(db, draft.author_fellow_id, sponsorId));
  if (!authorized) {
    return {
      ok: false,
      status: 403,
      code: "WRITE_REFUSED",
      detail:
        "Only a problem steward or the authoring Fellow's sponsor may publish a draft synthesis.",
    };
  }

  const replay = publishedDraftReceipt(draft);
  if (replay !== undefined) return replay;
  if (problem.admission_mode === "archived-read-only") return archivedProblemWriteProblem();

  const latestReceipt = async (): Promise<PublishDraftResult | undefined> => {
    const latest = await db
      .prepare(
        `SELECT d.* FROM synthesis_drafts d WHERE d.problem_id = ? AND d.synthesis_id = ?
         AND NOT EXISTS (SELECT 1 FROM private_draft_erasures e WHERE e.problem_id = d.problem_id)`,
      )
      .bind(problemId, synthesisId)
      .first<DraftRow>();
    if (latest === null) return undefined;
    const receipt = publishedDraftReceipt(latest);
    if (receipt === undefined) return undefined;
    const stillAuthorized =
      (await readSponsorStanding(db, sponsorId)) === "active" &&
      ((await isProblemSteward(db, problemId, sponsorId)) ||
        (await isCurrentSponsorOfFellow(db, latest.author_fellow_id, sponsorId)));
    if (!stillAuthorized) {
      return {
        ok: false,
        status: 403,
        code: "WRITE_REFUSED",
        detail: "Sponsor authority changed before the synthesis receipt could be returned.",
      };
    }
    return receipt;
  };

  if (
    problem.status === "private-draft" ||
    problem.status === "resolved" ||
    problem.status === "retired"
  ) {
    return {
      ok: false,
      status: 422,
      code: "CLAIMS_BOARD_LOCKED",
      detail: `Problem '${problemId}' is '${problem.status}' and cannot publish new syntheses.`,
    };
  }

  const parsedAnchors: SynthesisAnchor[] = z
    .array(SynthesisAnchorSchema)
    .parse(JSON.parse(draft.anchors_json));
  const parsedOmitted: string[] = z.array(z.string()).parse(JSON.parse(draft.omitted_json));
  const parsedClosing: ClosingSynthesisDeclaration | undefined =
    draft.closing_resolution_json !== null
      ? ClosingSynthesisDeclarationSchema.parse(JSON.parse(draft.closing_resolution_json))
      : undefined;

  // P7 / Rule A9 hard egress wall: never promote credential-shaped text to the public ledger.
  const credentialHits = scanFieldsForCredentials({
    body_md: draft.body_md,
    selection_policy: draft.selection_policy,
    omitted_json: draft.omitted_json,
    ...(draft.closing_resolution_json !== null
      ? { closing_resolution_json: draft.closing_resolution_json }
      : {}),
  });
  if (credentialHits.length > 0) {
    return {
      ok: false,
      status: 422,
      code: "SECRET_SHAPED_CONTENT",
      detail:
        "This draft contains credential-shaped text and cannot be published to the public ledger.",
    };
  }

  // Re-verify P13 anchors (and any closing_resolution anchor) at publish time
  // so withdrawn/hidden sources cannot slip through.
  const anchorCheck = await validateSynthesisAnchors(
    db,
    problemId,
    draft.covers_through,
    parsedAnchors,
  );
  const closingAnchored =
    parsedClosing === undefined ||
    anchorCheck.anchors.some(
      (anchor) =>
        anchor.target_kind === "claim" &&
        anchor.target_id === parsedClosing.result_claim.claim_id &&
        anchor.target_version === parsedClosing.result_claim.version,
    );
  if (!anchorCheck.valid || !closingAnchored) {
    return {
      ok: false,
      status: 422,
      code: "SYNTHESIS_UNANCHORED",
      detail:
        "One or more anchors in this draft synthesis are no longer available at its covers_through cursor.",
    };
  }

  const candidateBody = {
    covers_through: draft.covers_through,
    body_md: draft.body_md,
    anchors: anchorCheck.anchors,
    omitted: parsedOmitted,
    selection_policy: draft.selection_policy,
    ...(parsedClosing !== undefined ? { closing_resolution: parsedClosing } : {}),
  };
  const payloadObj = {
    ...candidateBody,
    dropped_single_author_count: draft.dropped_single_author_count,
    published_by_principal_id: sponsorId,
  };
  const payloadJson = canonicalJson(payloadObj);
  const digestBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payloadJson));
  const requestDigest = [...new Uint8Array(digestBytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // A draft-time screen cannot authorize a later public write. The author
  // history, problem formulation and moderation decisions may have changed.
  // Completed receipts above replay before any quota or provider charge.
  if (screening === undefined) return screeningContextUnavailableProblem();
  // A steward may publish another sponsor's Fellow. Review cases must remain
  // accessible to that Fellow's current sponsor, while the acting publisher
  // remains accountable for this attempt's quota.
  const author = await db
    .prepare(
      `SELECT f.sponsor_id FROM enrollment_fellows f
       JOIN sponsors s ON s.sponsor_id = f.sponsor_id AND s.tombstoned_at IS NULL
       WHERE f.fellow_id = ?`,
    )
    .bind(draft.author_fellow_id)
    .first<{ sponsor_id: string }>();
  if (author === null) {
    return {
      ok: false,
      status: 403,
      code: "WRITE_REFUSED",
      detail: "The authoring Fellow must have a current sponsor who can review held work.",
    };
  }
  let admission: Awaited<ReturnType<typeof checkAndReserveQuota>>;
  try {
    admission = await checkAndReserveQuota(db, {
      fellowId: draft.author_fellow_id,
      problemId,
      sponsorId,
      sessionId: draft.session_id,
      route: "synthesis-draft-publish",
      idempotencyKey: `synth-draft-publish:${problemId}:${synthesisId}`,
      requestDigest,
      sponsorLimit: screening.sponsorLimit,
    });
  } catch (error) {
    if (isArchivedProblemWriteError(error))
      return (await latestReceipt()) ?? archivedProblemWriteProblem();
    throw error;
  }
  if (!admission.allowed) {
    const winner = await latestReceipt();
    if (winner !== undefined) return winner;
    if (admission.reason === "RATE_LIMITED") return promotionRateLimitedProblem(admission);
    const response = validatedProblem({
      status: admission.reason === "IN_FLIGHT_CONFLICT" ? 429 : 409,
      code: admission.reason === "IN_FLIGHT_CONFLICT" ? "WRITE_REFUSED" : "IDEMPOTENCY_CONFLICT",
      title: "Synthesis publication is already in progress",
      detail: "A publication attempt for this draft already holds the write reservation.",
      fixHint: "Retry the same draft publication after the current attempt finishes.",
      headers: { "cache-control": "private, no-store" },
    });
    if (admission.reason === "IN_FLIGHT_CONFLICT")
      response.headers.set("retry-after", String(admission.retryAfterSeconds));
    return response;
  }
  const reservationId = admission.reservation.reservationId;
  let screened: ScreenedPublication;
  try {
    const winner = await latestReceipt();
    if (winner !== undefined) {
      await settleQuotaReservation(db, reservationId, "settled_failed");
      return winner;
    }
    const outcome = await screening.screen(
      Object.freeze({
        problemId,
        fellowId: draft.author_fellow_id,
        kind: "synthesis",
        statement: canonicalJson(candidateBody),
        falsifier: null,
      }),
      author.sponsor_id,
    );
    if (outcome instanceof Response) {
      await settleQuotaReservation(
        db,
        reservationId,
        outcome.status === 202
          ? "settled_held"
          : outcome.status === 403 || outcome.status === 422
            ? "settled_rejected"
            : "settled_failed",
      );
      return outcome;
    }
    if (
      outcome.problemId !== problemId ||
      outcome.fellowId !== draft.author_fellow_id ||
      outcome.contextGuard === undefined
    ) {
      await settleQuotaReservation(db, reservationId, "settled_failed");
      return screeningContextUnavailableProblem();
    }
    screened = outcome;
  } catch {
    await settleQuotaReservation(db, reservationId, "settled_failed");
    return screeningContextUnavailableProblem();
  }

  const eventId = mintCrockfordId("E");
  const publishedAt = new Date().toISOString();
  let write: Awaited<ReturnType<typeof writeLedgerEvent>>;
  try {
    write = await writeLedgerEvent(
      db,
      {
        problemId,
        eventId,
        idempotencyKey: `synth-draft-publish:${problemId}:${synthesisId}`,
        requestDigest,
        eventType: "synthesis.created",
        objectKind: "synthesis",
        objectId: draft.synthesis_id,
        objectVersion: 1,
        payloadJson,
        createdAt: publishedAt,
        // Rule A3 & Fable §6.1: publishing preserves Fellow scientific authorship!
        attribution: {
          fellowId: draft.author_fellow_id,
          sponsorId: draft.author_sponsor_id,
          sessionId: draft.session_id,
          modelSelfDeclared: draft.declared_model,
          harness: draft.harness,
        },
      },
      {
        // Guard atomically inside the D1 write batch against concurrent publish,
        // terminal problem transition, public_cursor exhaustion, or sponsor revocation.
        preconditionSql: ` AND EXISTS (
            SELECT 1 FROM synthesis_drafts
            WHERE synthesis_id = ? AND problem_id = ? AND state = 'draft'
              AND covers_through = ? AND body_md = ? AND anchors_json = ?
              AND omitted_json = ? AND selection_policy = ?
              AND closing_resolution_json IS ? AND dropped_single_author_count = ?
              AND author_fellow_id = ? AND author_sponsor_id = ? AND session_id = ?
              AND declared_model = ? AND harness = ? AND created_at = ?
          ) AND NOT EXISTS (
            SELECT 1 FROM private_draft_erasures WHERE problem_id = ?
          ) AND EXISTS (
            SELECT 1 FROM enrollment_fellows f
            JOIN sponsors s ON s.sponsor_id = f.sponsor_id AND s.tombstoned_at IS NULL
            WHERE f.fellow_id = ? AND f.sponsor_id = ?
          ) AND EXISTS (
            SELECT 1 FROM problems
            WHERE id = ? AND status NOT IN ('private-draft', 'resolved', 'retired')
          ) AND EXISTS (
            SELECT 1 FROM public_cursor
            WHERE singleton = 1 AND cursor < 9007199254740991
          ) AND EXISTS (
            SELECT 1 FROM sponsors
            WHERE sponsor_id = ? AND tombstoned_at IS NULL
          ) AND NOT EXISTS (
            SELECT 1 FROM sponsor_suspension_events
            WHERE sponsor_id = ?
          ) AND (
            EXISTS (SELECT 1 FROM problems WHERE id = ? AND sponsor_id = ?)
            OR EXISTS (SELECT 1 FROM problem_stewards WHERE problem_id = ? AND sponsor_id = ?)
            OR EXISTS (
              SELECT 1 FROM enrollment_fellows
              WHERE fellow_id = ? AND sponsor_id = ?
            )
          )`,
        preconditionBindings: [
          draft.synthesis_id,
          problemId,
          draft.covers_through,
          draft.body_md,
          draft.anchors_json,
          draft.omitted_json,
          draft.selection_policy,
          draft.closing_resolution_json,
          draft.dropped_single_author_count,
          draft.author_fellow_id,
          draft.author_sponsor_id,
          draft.session_id,
          draft.declared_model,
          draft.harness,
          draft.created_at,
          problemId,
          draft.author_fellow_id,
          author.sponsor_id,
          problemId,
          sponsorId,
          sponsorId,
          problemId,
          sponsorId,
          problemId,
          sponsorId,
          draft.author_fellow_id,
          sponsorId,
        ],
        statementsAfterEvent: ({ sequence }) => [
          ...synthesisAnchorGuards(db, problemId, draft.covers_through, anchorCheck.sources),
          ...screeningPublicationStatements(db, screened, eventId, draft.session_id, requestDigest),
          settleQuotaReservationStatement(db, reservationId, eventId),
          db
            .prepare(
              `INSERT OR IGNORE INTO syntheses
                 (synthesis_id, problem_id, covers_through, body_md, anchors_json,
                  omitted_json, dropped_single_author_count, authoring_principal,
                  declared_model, cas_hash, created_at)
               SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?
               FROM events e WHERE e.id = ? AND e.seq = ?`,
            )
            .bind(
              draft.synthesis_id,
              problemId,
              draft.covers_through,
              draft.body_md,
              JSON.stringify(anchorCheck.anchors),
              JSON.stringify(parsedOmitted),
              draft.dropped_single_author_count,
              draft.author_fellow_id,
              draft.declared_model,
              publishedAt,
              eventId,
              sequence,
            ),
          db
            .prepare(
              `UPDATE synthesis_drafts
               SET state = 'published',
                   published_by_principal_id = ?,
                   published_event_id = ?,
                   published_seq = ?,
                   published_at = ?
               WHERE synthesis_id = ? AND problem_id = ? AND state = 'draft'
                 AND EXISTS (SELECT 1 FROM events WHERE id = ? AND problem_id = ? AND seq = ?)`,
            )
            .bind(
              sponsorId,
              eventId,
              sequence,
              publishedAt,
              draft.synthesis_id,
              problemId,
              eventId,
              problemId,
              sequence,
            ),
          db
            .prepare(
              `UPDATE problems SET status = 'active'
               WHERE id = ? AND status = 'dormant'
                 AND EXISTS (SELECT 1 FROM events WHERE id = ? AND problem_id = ? AND seq = ?)`,
            )
            .bind(problemId, eventId, problemId, sequence),
          db
            .prepare(
              `UPDATE public_cursor SET cursor = cursor + 1
               WHERE singleton = 1
                 AND EXISTS (SELECT 1 FROM events WHERE id = ? AND problem_id = ? AND seq = ?)`,
            )
            .bind(eventId, problemId, sequence),
        ],
      },
    );
  } catch (error) {
    await settleQuotaReservation(db, reservationId, "settled_failed");
    const winner = await latestReceipt();
    if (winner !== undefined) return winner;
    if (isArchivedProblemWriteError(error)) return archivedProblemWriteProblem();
    if (isScreeningPostureChangedError(error))
      return screeningHoldResponse("provider-unavailable", undefined, "quarantine-first");
    if (isScreeningDecisionChangedError(error))
      return screeningHoldResponse("provider-unavailable");
    if (isScreeningContextStaleError(error)) return screeningContextStaleProblem();
    if (isSynthesisReferenceChanged(error)) {
      return {
        ok: false,
        status: 422,
        code: "SYNTHESIS_UNANCHORED",
        detail:
          "One or more anchors in this draft synthesis changed or became unavailable before publication.",
      };
    }
    if (
      error instanceof KraterIdempotencyConflictError ||
      error instanceof KraterLedgerPreconditionError
    ) {
      const latestStanding = await readSponsorStanding(db, sponsorId);
      const stillAuthorized =
        latestStanding === "active" &&
        ((await isProblemSteward(db, problemId, sponsorId)) ||
          (await isCurrentSponsorOfFellow(db, draft.author_fellow_id, sponsorId)));
      if (!stillAuthorized) {
        return {
          ok: false,
          status: 403,
          code: "WRITE_REFUSED",
          detail: "Sponsor authority changed before the synthesis draft could be published.",
        };
      }
      const latestProblem = await db
        .prepare("SELECT status FROM problems WHERE id = ?")
        .bind(problemId)
        .first<{ status: string }>();
      if (
        latestProblem &&
        (latestProblem.status === "private-draft" ||
          latestProblem.status === "resolved" ||
          latestProblem.status === "retired")
      ) {
        return {
          ok: false,
          status: 422,
          code: "CLAIMS_BOARD_LOCKED",
          detail: `Problem '${problemId}' is '${latestProblem.status}' and cannot publish new syntheses.`,
        };
      }
      return validatedProblem({
        status: 409,
        code: "OBJECT_VERSION_CONFLICT",
        title: "Synthesis draft changed before publication",
        detail:
          "The draft or its publication authority changed while it was being screened. Nothing was published.",
        fixHint: "Read the current draft and problem, then retry the intended publication.",
        rule: "A5",
        extensions: {
          schema: SYNTHESES_SCHEMA_ID,
          example: { problem_id: problemId, synthesis_id: synthesisId },
        },
        headers: { "cache-control": "private, no-store" },
      });
    }
    throw error;
  }

  if (write.eventId !== eventId) {
    await settleQuotaReservation(db, reservationId, "settled_failed");
    const winner = await latestReceipt();
    if (winner !== undefined) return winner;
    throw new Error("Synthesis publication replay has no retained draft receipt.");
  }

  return {
    ok: true,
    status: 201,
    body: SynthesisDraftPublishResponseSchema.parse({
      synthesis_id: draft.synthesis_id,
      problem_id: problemId,
      state: "published",
      covers_through: draft.covers_through,
      anchors_count: anchorCheck.anchors.length,
      dropped_single_author_count: draft.dropped_single_author_count,
      author_fellow_id: draft.author_fellow_id,
      published_by_principal_id: sponsorId,
      event_id: write.eventId,
      sequence: write.seq,
      published_at: publishedAt,
    }),
  };
}
