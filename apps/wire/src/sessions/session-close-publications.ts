import {
  ClaimPublicationDraftSchema,
  type ClaimRevision,
  ClaimRevisionSchema,
  type DirectClaimRequest,
  DirectClaimRequestSchema,
  LedgerIntentSchema,
  SessionCloseResponseSchema,
  WorkshopObjectIdSchema,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { sha256Hex } from "../split/policy.ts";

export class SessionClosePublicationError extends Error {
  readonly code: "NOT_FOUND" | "INVALID_PUBLICATION" | "CHANGED";

  constructor(code: "NOT_FOUND" | "INVALID_PUBLICATION" | "CHANGED") {
    super("SESSION_CLOSE_PUBLICATION_" + code);
    this.code = code;
  }
}

/** A pending close retains only these pins, encrypted with its replay receipt.
 * A same-key retry may never adopt replacement bytes from a newer draft. */
export interface SessionClosePublicationPin {
  readonly workshopId: string;
  readonly version: number;
  readonly publicationDigest: string;
}

export type SessionClosePublication =
  | {
      readonly kind: "create";
      readonly pin: SessionClosePublicationPin;
      readonly publicationJson: string;
      readonly data: DirectClaimRequest;
    }
  | {
      readonly kind: "revise";
      readonly pin: SessionClosePublicationPin;
      readonly revisionJson: string;
      readonly data: ClaimRevision;
    };

interface PublicationRow {
  workshop_id: string;
  current_version: number;
  state: string;
  type: string;
  revision_json: string | null;
  ledger_intent_json: string | null;
  publication_json: string | null;
  source_publication_json: string | null;
  source_revision_json: string | null;
  source_ledger_intent_json: string | null;
  source_type: string | null;
}

function parseJson(value: string | null): unknown {
  if (value === null) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** Close publishes saved new claims and explicit claim replacements. Both
 * retain claim-ID receipts; other typed work keeps its own publication route.
 * Source bytes and intent come from the exact owned immutable draft revision. */
export async function readSessionClosePublications(
  db: D1Database,
  input: {
    readonly sessionId: string;
    readonly problemId: string;
    readonly fellowId: string;
    readonly promote: readonly string[];
  },
): Promise<readonly SessionClosePublication[]> {
  if (
    input.promote.length < 1 ||
    input.promote.length > 16 ||
    new Set(input.promote).size !== input.promote.length
  ) {
    throw new SessionClosePublicationError("INVALID_PUBLICATION");
  }
  const rows = await db
    .prepare("SELECT w.workshop_id, w.current_version, w.state, w.type, " +
      "w.revision_json, w.ledger_intent_json, w.publication_json, " +
      "source.publication_json AS source_publication_json, " +
      "source.revision_json AS source_revision_json, " +
      "source.ledger_intent_json AS source_ledger_intent_json, source.type AS source_type " +
      "FROM workshop_objects w LEFT JOIN workshop_revisions source " +
      "ON source.workshop_id=w.workshop_id AND source.version=w.current_version " +
      "AND source.problem_id=w.problem_id AND source.fellow_id=w.fellow_id " +
      "AND source.session_id=w.session_id " +
      "WHERE w.session_id=? AND w.problem_id=? AND w.fellow_id=? " +
      "AND w.workshop_id IN (SELECT value FROM json_each(?))")
    .bind(input.sessionId, input.problemId, input.fellowId, JSON.stringify(input.promote))
    .all<PublicationRow>();
  if (rows.results.length !== input.promote.length) {
    throw new SessionClosePublicationError("NOT_FOUND");
  }
  const byId = new Map(rows.results.map((row) => [row.workshop_id, row]));
  return Promise.all(
    input.promote.map(async (workshopId): Promise<SessionClosePublication> => {
      const row = byId.get(workshopId);
      if (!row) throw new SessionClosePublicationError("NOT_FOUND");
      const intent =
        row.ledger_intent_json === null
          ? null
          : LedgerIntentSchema.safeParse(parseJson(row.ledger_intent_json));
      if (
        row.state !== "open" ||
        row.type !== "claim-draft" ||
        !Number.isSafeInteger(row.current_version) ||
        row.current_version < 1 ||
        row.current_version >= Number.MAX_SAFE_INTEGER ||
        row.type !== row.source_type ||
        row.publication_json !== row.source_publication_json ||
        row.revision_json !== row.source_revision_json ||
        row.ledger_intent_json !== row.source_ledger_intent_json ||
        (intent !== null && !intent.success)
      ) {
        throw new SessionClosePublicationError("INVALID_PUBLICATION");
      }
      if (row.revision_json !== null) {
        const revision = ClaimRevisionSchema.safeParse(parseJson(row.revision_json));
        if (
          row.publication_json !== null ||
          !revision.success ||
          (intent !== null && (!intent.success || intent.data.kind !== "revise" ||
            intent.data.target_id !== revision.data.claim_id ||
            intent.data.base_version !== revision.data.base_version))
        ) {
          throw new SessionClosePublicationError("INVALID_PUBLICATION");
        }
        return {
          kind: "revise",
          pin: {
            workshopId,
            version: row.current_version,
            publicationDigest: await sha256Hex(row.revision_json),
          },
          revisionJson: row.revision_json,
          data: revision.data,
        };
      }
      const publication = ClaimPublicationDraftSchema.safeParse(parseJson(row.publication_json));
      if (
        row.publication_json === null ||
        !publication.success ||
        (intent !== null &&
          (!intent.success || intent.data.kind !== "create" || intent.data.target_kind !== "claim"))
      ) {
        throw new SessionClosePublicationError("INVALID_PUBLICATION");
      }
      return {
        kind: "create",
        pin: {
          workshopId,
          version: row.current_version,
          publicationDigest: await sha256Hex(row.publication_json),
        },
        publicationJson: row.publication_json,
        data: DirectClaimRequestSchema.parse({
          ...publication.data,
          workshop_id: workshopId,
          expected_workshop_version: row.current_version,
        }),
      };
    }),
  );
}

export function assertSessionClosePublicationPins(
  publications: readonly SessionClosePublication[],
  pins: readonly SessionClosePublicationPin[],
): void {
  if (
    publications.length !== pins.length ||
    publications.some(({ pin }, index) => {
      const expected = pins[index];
      return (
        expected === undefined ||
        pin.workshopId !== expected.workshopId ||
        pin.version !== expected.version ||
        pin.publicationDigest !== expected.publicationDigest
      );
    })
  ) {
    throw new SessionClosePublicationError("CHANGED");
  }
}


export interface SessionClosePendingPublication extends SessionClosePublicationPin {
  readonly eventId: string;
}

export type SessionCloseReplayState =
  | {
      readonly kind: "session-close-pending-v1";
      readonly reservation: string;
      readonly publications: readonly SessionClosePendingPublication[];
    }
  | { readonly kind: "completed"; readonly plaintext: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The internal pending value is never itself a public close receipt. Existing
 * completed handback-only receipts continue to replay their exact bytes. */
export function parseSessionCloseReplayState(raw: string): SessionCloseReplayState {
  const value: unknown = JSON.parse(raw);
  if (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    value.kind === "session-close-pending-v1" &&
    typeof value.reservation === "string" &&
    /^R-[0-9A-HJKMNP-TV-Z]{26}$/.test(value.reservation) &&
    Array.isArray(value.publications) &&
    value.publications.length >= 1 &&
    value.publications.length <= 16 &&
    value.publications.every((pin: unknown) =>
      isRecord(pin) &&
      Object.keys(pin).length === 4 &&
      WorkshopObjectIdSchema.safeParse(pin.workshopId).success &&
      typeof pin.version === "number" && Number.isSafeInteger(pin.version) && pin.version >= 1 &&
      typeof pin.publicationDigest === "string" && /^[0-9a-f]{64}$/.test(pin.publicationDigest) &&
      typeof pin.eventId === "string" && /^E-[0-9A-HJKMNP-TV-Z]{26}$/.test(pin.eventId),
    )
  ) {
    const publications = value.publications as SessionClosePendingPublication[];
    if (
      new Set(publications.map((pin) => pin.workshopId)).size !== publications.length ||
      new Set(publications.map((pin) => pin.eventId)).size !== publications.length
    ) {
      throw new Error("Invalid pending session close identities");
    }
    return { kind: "session-close-pending-v1", reservation: value.reservation, publications };
  }
  SessionCloseResponseSchema.parse(value);
  return { kind: "completed", plaintext: raw };
}
