/**
 * Composable workshop/ledger service.
 *
 * Krater owns the actual D1 transaction and R2 object access.  This is an
 * interface boundary, not a D1 implementation and not a substitute for a
 * local-binding or staging test.  The service only sends transaction commands
 * through `KraterSplitPort`, allowing the privacy and sequencing rules to be
 * exercised before Worker routes and migrations are wired.
 */

import {
  assertPublicProjectionSafe,
  duplicateClaimRefusal,
  normHash,
  privateNotFound,
  rejectAuthoritativeFields,
  sponsorMayReadWorkshop,
  type PrivateNotFound,
  type SplitPrincipal,
  type SplitProblemRefusal,
} from "./policy";

export const PRIVATE_BODY_THRESHOLD_BYTES = 1024;

export interface WorkshopKey {
  readonly problemId: string;
  readonly fellowId: string;
}

export interface WorkshopObject extends WorkshopKey {
  readonly id: string;
  readonly sponsorId: string;
  readonly workshopSeq: number;
  readonly type: "scratch" | "claim-draft" | "evidence-draft" | "dead-end-draft" | "note";
  readonly title: string;
  readonly extract: string;
  /** Present only when the body did not spill to private CAS. */
  readonly inlineBodyMd?: string;
  /** A private CAS reference.  It is never a public projection field. */
  readonly privateArtifactDigest?: string;
  readonly promotedPublicEventId?: string;
}

export interface PublicClaimInput {
  readonly claimId: string;
  readonly title: string;
  readonly extract: string;
  readonly statement: string;
  /** Deliberately broad until `@asimposium/contracts` owns the claim type. */
  readonly candidate: Readonly<Record<string, unknown>>;
}

export interface PublicLedgerEvent {
  readonly id: string;
  readonly problemId: string;
  readonly publicSeq: number;
  readonly claimId: string;
  readonly title: string;
  readonly extract: string;
  readonly statement: string;
}

/** Internal persistence detail; never return this from a public method. */
export interface StoredPublicLedgerEvent extends PublicLedgerEvent {
  readonly sourceWorkshopId: string;
}

export interface PromotionReceipt {
  readonly event: PublicLedgerEvent;
}

export interface SplitIdempotencyRecord {
  readonly requestDigest: string;
  readonly receipt: PromotionReceipt;
}

export interface OpenClaimRef {
  readonly id: string;
  readonly problemId: string;
  readonly normHash: string;
}

/**
 * This is the narrow Krater seam.  A production adapter must make one call to
 * `transaction` correspond to one D1 transaction that updates the event log
 * and its projections together (Rule A6).  No implementation lives here.
 */
export interface KraterSplitTransaction {
  currentPublicSeq(problemId: string): number;
  nextPublicSeq(problemId: string): number;
  nextWorkshopSeq(key: WorkshopKey): number;
  getWorkshop(workshopId: string): WorkshopObject | undefined;
  insertWorkshop(workshop: WorkshopObject): void;
  markWorkshopPromoted(workshopId: string, publicEventId: string): void;
  getPublicEvents(problemId: string): readonly StoredPublicLedgerEvent[];
  insertPublicEvent(event: StoredPublicLedgerEvent): void;
  findOpenClaim(problemId: string, normalizedHash: string): OpenClaimRef | undefined;
  insertOpenClaim(claim: OpenClaimRef): void;
  getIdempotency(key: string): SplitIdempotencyRecord | undefined;
  putIdempotency(key: string, record: SplitIdempotencyRecord): void;
}

export interface KraterSplitPort {
  transaction<T>(operation: (transaction: KraterSplitTransaction) => Promise<T> | T): Promise<T>;
}

export interface WorkshopPushInput extends WorkshopKey {
  readonly workshopId: string;
  readonly sponsorId: string;
  readonly type: WorkshopObject["type"];
  readonly title: string;
  readonly bodyMd: string;
  readonly privateArtifactDigest?: string;
}

export interface WorkshopPushAccepted {
  readonly status: 201;
  readonly workshopId: string;
  readonly workshopSeq: number;
  readonly spilledToPrivateCas: boolean;
}

export interface WorkshopPushRefusal {
  readonly status: 422;
  readonly code: "PRIVATE_CAS_REQUIRED";
  readonly fixHint: string;
}

export type WorkshopPushResult = WorkshopPushAccepted | WorkshopPushRefusal;

export interface SponsorWorkshopCard {
  readonly status: 200;
  readonly id: string;
  readonly workshopSeq: number;
  readonly type: WorkshopObject["type"];
  readonly title: string;
  readonly extract: string;
}

export interface SponsorWorkshopCursor {
  readonly status: 200;
  readonly workshopSeq: number;
}

export interface SponsorPrivateArtifact {
  readonly status: 200;
  readonly cacheControl: "private, no-store";
  /** The authenticated Worker may resolve this handle; it is never public CAS output. */
  readonly privateArtifactDigest: string;
}

export interface PublicLedgerSnapshot {
  readonly status: 200;
  readonly cacheControl: "public, max-age=10";
  readonly publicSeq: number;
  readonly events: readonly PublicLedgerEvent[];
}

export interface PublicSearchResult {
  readonly status: 200;
  readonly cacheControl: "public, max-age=10";
  readonly results: readonly PublicLedgerEvent[];
}

export interface PublicExport {
  readonly status: 200;
  readonly cacheControl: "public, max-age=10";
  readonly publicSeq: number;
  readonly events: readonly PublicLedgerEvent[];
}

export interface PromoteInput {
  readonly workshopId: string;
  readonly actorSponsorId: string;
  readonly actorFellowId: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly publicClaim: PublicClaimInput;
}

export interface PromotionCreated {
  readonly status: 201;
  readonly outcome: "created";
  readonly receipt: PromotionReceipt;
}

export interface PromotionReplayed {
  readonly status: 200;
  readonly outcome: "replayed";
  readonly receipt: PromotionReceipt;
}

export interface PromotionAlreadyExists {
  readonly status: 409;
  readonly code: "PROMOTION_ALREADY_EXISTS";
  readonly publicEventId: string;
}

export interface IdempotencyConflict {
  readonly status: 409;
  readonly code: "IDEMPOTENCY_CONFLICT";
  readonly suggestedAction: "retry_original_request";
}

export type PromoteResult =
  | PromotionCreated
  | PromotionReplayed
  | PromotionAlreadyExists
  | IdempotencyConflict
  | SplitProblemRefusal
  | PrivateNotFound;

/**
 * The Krater adapter raises this only when it knows the transaction committed
 * but the caller did not receive the result.  A client must retry with the
 * same idempotency key; a new key is not safe after a disconnected write.
 */
export class KraterCommitUnknownError extends Error {
  constructor() {
    super("Krater committed the split transaction but the response was disconnected");
    this.name = "KraterCommitUnknownError";
  }
}

export class PromotionCommitUnknownError extends Error {
  readonly code = "COMMIT_UNKNOWN";
  readonly retry = "retry_same_idempotency_key";

  constructor() {
    super("Promotion result is unknown; retry the exact request with the same idempotency key");
    this.name = "PromotionCommitUnknownError";
  }
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function extractFrom(bodyMd: string): string {
  return bodyMd.replace(/\s+/gu, " ").trim().slice(0, 280);
}

function publicEventFrom(stored: StoredPublicLedgerEvent): PublicLedgerEvent {
  const { sourceWorkshopId: _sourceWorkshopId, ...event } = stored;
  return event;
}

function publicSnapshot(transaction: KraterSplitTransaction, problemId: string): PublicLedgerSnapshot {
  const snapshot: PublicLedgerSnapshot = {
    status: 200,
    cacheControl: "public, max-age=10",
    publicSeq: transaction.currentPublicSeq(problemId),
    events: transaction.getPublicEvents(problemId).map(publicEventFrom),
  };
  assertPublicProjectionSafe(snapshot);
  return snapshot;
}

export class SplitService {
  constructor(private readonly krater: KraterSplitPort) {}

  async pushWorkshop(input: WorkshopPushInput): Promise<WorkshopPushResult> {
    const spilledToPrivateCas = utf8ByteLength(input.bodyMd) > PRIVATE_BODY_THRESHOLD_BYTES;
    if (spilledToPrivateCas && input.privateArtifactDigest === undefined) {
      return {
        status: 422,
        code: "PRIVATE_CAS_REQUIRED",
        fixHint: "Bodies above 1 KiB require a private CAS digest before the workshop row is written.",
      };
    }

    return this.krater.transaction((transaction) => {
      const workshopSeq = transaction.nextWorkshopSeq(input);
      transaction.insertWorkshop({
        id: input.workshopId,
        problemId: input.problemId,
        fellowId: input.fellowId,
        sponsorId: input.sponsorId,
        workshopSeq,
        type: input.type,
        title: input.title,
        extract: extractFrom(input.bodyMd),
        ...(spilledToPrivateCas
          ? { privateArtifactDigest: input.privateArtifactDigest }
          : { inlineBodyMd: input.bodyMd }),
      });
      return { status: 201, workshopId: input.workshopId, workshopSeq, spilledToPrivateCas };
    });
  }

  async sponsorWorkshopCard(
    principal: SplitPrincipal,
    workshopId: string,
  ): Promise<SponsorWorkshopCard | PrivateNotFound> {
    return this.krater.transaction((transaction) => {
      const workshop = transaction.getWorkshop(workshopId);
      if (workshop === undefined || !sponsorMayReadWorkshop(principal, workshop.sponsorId)) {
        return privateNotFound();
      }
      return {
        status: 200,
        id: workshop.id,
        workshopSeq: workshop.workshopSeq,
        type: workshop.type,
        title: workshop.title,
        extract: workshop.extract,
      };
    });
  }

  async sponsorWorkshopCursor(
    principal: SplitPrincipal,
    workshopId: string,
  ): Promise<SponsorWorkshopCursor | PrivateNotFound> {
    return this.krater.transaction((transaction) => {
      const workshop = transaction.getWorkshop(workshopId);
      if (workshop === undefined || !sponsorMayReadWorkshop(principal, workshop.sponsorId)) {
        return privateNotFound();
      }
      return { status: 200, workshopSeq: workshop.workshopSeq };
    });
  }

  async sponsorPrivateArtifact(
    principal: SplitPrincipal,
    workshopId: string,
  ): Promise<SponsorPrivateArtifact | PrivateNotFound> {
    return this.krater.transaction((transaction) => {
      const workshop = transaction.getWorkshop(workshopId);
      if (
        workshop === undefined ||
        workshop.privateArtifactDigest === undefined ||
        !sponsorMayReadWorkshop(principal, workshop.sponsorId)
      ) {
        return privateNotFound();
      }
      return {
        status: 200,
        cacheControl: "private, no-store",
        privateArtifactDigest: workshop.privateArtifactDigest,
      };
    });
  }

  /** The public CAS surface cannot resolve a private workshop digest, even after promotion. */
  publicPrivateArtifact(): PrivateNotFound {
    return privateNotFound();
  }

  async publicLedger(problemId: string): Promise<PublicLedgerSnapshot> {
    return this.krater.transaction((transaction) => publicSnapshot(transaction, problemId));
  }

  async searchPublicLedger(problemId: string, query: string): Promise<PublicSearchResult> {
    return this.krater.transaction((transaction) => {
      const needle = query.normalize("NFKC").toLowerCase();
      const results = transaction
        .getPublicEvents(problemId)
        .map(publicEventFrom)
        .filter((event) => `${event.title}\n${event.extract}\n${event.statement}`.toLowerCase().includes(needle));
      const result: PublicSearchResult = {
        status: 200,
        cacheControl: "public, max-age=10",
        results,
      };
      assertPublicProjectionSafe(result);
      return result;
    });
  }

  async exportPublicLedger(problemId: string): Promise<PublicExport> {
    return this.krater.transaction((transaction) => {
      const snapshot = publicSnapshot(transaction, problemId);
      const result: PublicExport = {
        status: 200,
        cacheControl: snapshot.cacheControl,
        publicSeq: snapshot.publicSeq,
        events: snapshot.events,
      };
      assertPublicProjectionSafe(result);
      return result;
    });
  }

  async promote(input: PromoteInput): Promise<PromoteResult> {
    try {
      return await this.krater.transaction(async (transaction) => {
        const previous = transaction.getIdempotency(input.idempotencyKey);
        if (previous !== undefined) {
          if (previous.requestDigest === input.requestDigest) {
            return { status: 200, outcome: "replayed", receipt: previous.receipt };
          }
          return {
            status: 409,
            code: "IDEMPOTENCY_CONFLICT",
            suggestedAction: "retry_original_request",
          };
        }

        const workshop = transaction.getWorkshop(input.workshopId);
        if (
          workshop === undefined ||
          workshop.sponsorId !== input.actorSponsorId ||
          workshop.fellowId !== input.actorFellowId
        ) {
          return privateNotFound();
        }
        if (workshop.promotedPublicEventId !== undefined) {
          return {
            status: 409,
            code: "PROMOTION_ALREADY_EXISTS",
            publicEventId: workshop.promotedPublicEventId,
          };
        }

        const selfCertification = rejectAuthoritativeFields(input.publicClaim.candidate);
        if (selfCertification !== null) return selfCertification;

        const normalizedHash = await normHash(input.publicClaim.statement);
        const existing = transaction.findOpenClaim(workshop.problemId, normalizedHash);
        if (existing !== undefined) return duplicateClaimRefusal(existing.id);

        const publicSeq = transaction.nextPublicSeq(workshop.problemId);
        const event: StoredPublicLedgerEvent = {
          id: `E-${publicSeq}`,
          problemId: workshop.problemId,
          publicSeq,
          claimId: input.publicClaim.claimId,
          title: input.publicClaim.title,
          extract: input.publicClaim.extract,
          statement: input.publicClaim.statement,
          sourceWorkshopId: workshop.id,
        };
        const receipt: PromotionReceipt = { event: publicEventFrom(event) };

        // The Krater adapter commits these projection and log mutations together.
        transaction.insertPublicEvent(event);
        transaction.insertOpenClaim({
          id: input.publicClaim.claimId,
          problemId: workshop.problemId,
          normHash: normalizedHash,
        });
        transaction.markWorkshopPromoted(workshop.id, event.id);
        transaction.putIdempotency(input.idempotencyKey, {
          requestDigest: input.requestDigest,
          receipt,
        });

        return { status: 201, outcome: "created", receipt };
      });
    } catch (error) {
      if (error instanceof KraterCommitUnknownError) throw new PromotionCommitUnknownError();
      throw error;
    }
  }
}
