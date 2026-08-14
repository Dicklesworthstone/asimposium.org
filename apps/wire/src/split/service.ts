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
  type PrivateNotFound,
  principalMayReadWorkshop,
  privateNotFound,
  rejectAuthoritativeFields,
  SplitLeakError,
  type SplitPrincipal,
  type SplitProblemRefusal,
  sha256Hex,
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
  readonly publishedPublicArtifactId?: string;
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

export interface PublicArtifact {
  readonly id: string;
  readonly bodyMd: string;
}

export interface PromotionReceipt {
  readonly event: PublicLedgerEvent;
}

export interface SplitIdempotencyRecord {
  readonly requestDigest: string;
  readonly receipt: PromotionReceipt;
}

export interface IdempotencyScope {
  readonly principalId: string;
  readonly sessionId: string;
  readonly operation: "ledger.promote";
  readonly problemId: string;
}

export interface AuthenticatedFellowPrincipal {
  readonly kind: "fellow";
  readonly fellowId: string;
  readonly sponsorId: string;
  readonly sessionId: string;
}

export interface AuthenticatedSponsorPrincipal {
  readonly kind: "sponsor";
  readonly sponsorId: string;
  readonly sessionId: string;
}

/** Auth-derived context only; it is never accepted in a workshop JSON body. */
export type AuthenticatedWorkshopActor =
  | AuthenticatedFellowPrincipal
  | AuthenticatedSponsorPrincipal;

export interface SplitIdFactory {
  nextPublicEventId(): string;
  nextPublicArtifactId(): string;
}

const cryptoIds: SplitIdFactory = {
  nextPublicEventId: () => `EV-${crypto.randomUUID()}`,
  nextPublicArtifactId: () => `PA-${crypto.randomUUID()}`,
};

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
  markWorkshopArtifactPublished(workshopId: string, publicArtifactId: string): void;
  getPublicEvents(problemId: string): readonly StoredPublicLedgerEvent[];
  insertPublicEvent(event: StoredPublicLedgerEvent): void;
  /** Private CAS retrieval, called only after workshop authorization. */
  getPrivateArtifact(privateArtifactDigest: string): { readonly bodyMd: string } | undefined;
  /** Must copy and verify private-CAS bytes before exposing the returned public artifact. */
  copyPrivateArtifactToPublic(
    privateArtifactDigest: string,
    publicArtifactId: string,
  ): PublicArtifact | undefined;
  bindPublicArtifact(publicEventId: string, artifact: PublicArtifact): void;
  getPublicArtifact(publicArtifactId: string): PublicArtifact | undefined;
  findOpenClaim(problemId: string, normalizedHash: string): OpenClaimRef | undefined;
  insertOpenClaim(claim: OpenClaimRef): void;
  getIdempotency(scope: IdempotencyScope, key: string): SplitIdempotencyRecord | undefined;
  putIdempotency(scope: IdempotencyScope, key: string, record: SplitIdempotencyRecord): void;
}

export interface KraterSplitPort {
  transaction<T>(operation: (transaction: KraterSplitTransaction) => Promise<T> | T): Promise<T>;
}

export interface WorkshopPushInput {
  readonly workshopId: string;
  readonly problemId: string;
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
  /** Retrieved bytes are private and may only leave through the authenticated Worker. */
  readonly bodyMd: string;
}

export interface PublicArtifactDelivery {
  readonly status: 200;
  readonly cacheControl: "public, max-age=10";
  readonly bodyMd: string;
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
  readonly idempotencyKey: string;
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

export interface PublicationRequired {
  readonly status: 409;
  readonly code: "PROMOTION_REQUIRED";
}

export interface ArtifactPublicationCreated {
  readonly status: 201;
  readonly publicArtifactId: string;
}

export interface ArtifactAlreadyPublished {
  readonly status: 200;
  readonly publicArtifactId: string;
}

export type PromoteResult =
  | PromotionCreated
  | PromotionReplayed
  | PromotionAlreadyExists
  | IdempotencyConflict
  | SplitProblemRefusal
  | PrivateNotFound;

export type PublishArtifactResult =
  | ArtifactPublicationCreated
  | ArtifactAlreadyPublished
  | PublicationRequired
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

function actorMayManageWorkshop(
  actor: AuthenticatedWorkshopActor,
  workshop: WorkshopObject,
): boolean {
  return (
    (actor.kind === "sponsor" && actor.sponsorId === workshop.sponsorId) ||
    (actor.kind === "fellow" &&
      actor.fellowId === workshop.fellowId &&
      actor.sponsorId === workshop.sponsorId)
  );
}

function idempotencyScope(actor: AuthenticatedWorkshopActor, problemId: string): IdempotencyScope {
  return {
    principalId:
      actor.kind === "fellow" ? `fellow:${actor.fellowId}` : `sponsor:${actor.sponsorId}`,
    sessionId: actor.sessionId,
    operation: "ledger.promote",
    problemId,
  };
}

/** Canonical JSON prevents semantically identical bodies from acquiring different replay identities. */
function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("promotion request contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("promotion request contains a non-JSON value");
}

async function promotionRequestDigest(
  actor: AuthenticatedWorkshopActor,
  workshop: WorkshopObject,
  input: PromoteInput,
): Promise<string> {
  return sha256Hex(
    canonicalJson({
      operation: "ledger.promote",
      principal: idempotencyScope(actor, workshop.problemId).principalId,
      session: actor.sessionId,
      problem: workshop.problemId,
      workshop: workshop.id,
      publicClaim: input.publicClaim,
    }),
  );
}

function publicEventFrom(stored: StoredPublicLedgerEvent): PublicLedgerEvent {
  const { sourceWorkshopId: _sourceWorkshopId, ...event } = stored;
  return event;
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new SplitLeakError(key);
  }
}

/**
 * Public ledger construction is allowlisted, not merely "not obviously
 * private".  An innocent-looking future key such as `annotation` therefore
 * fails closed until the public face contract explicitly admits it.
 */
export function assertPublicLedgerProjectionShape(value: unknown): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SplitLeakError("non-object-public-ledger-projection");
  }
  const record = value as Readonly<Record<string, unknown>>;
  const events = record.events ?? record.results;
  assertExactKeys(record, ["status", "cacheControl", "publicSeq", "events", "results"]);
  if (!Array.isArray(events)) throw new SplitLeakError("events-or-results");
  for (const event of events) {
    if (event === null || typeof event !== "object" || Array.isArray(event)) {
      throw new SplitLeakError("non-object-public-event");
    }
    assertExactKeys(event as Readonly<Record<string, unknown>>, [
      "id",
      "problemId",
      "publicSeq",
      "claimId",
      "title",
      "extract",
      "statement",
    ]);
  }
  assertPublicProjectionSafe(value);
}

function publicSnapshot(
  transaction: KraterSplitTransaction,
  problemId: string,
): PublicLedgerSnapshot {
  const snapshot: PublicLedgerSnapshot = {
    status: 200,
    cacheControl: "public, max-age=10",
    publicSeq: transaction.currentPublicSeq(problemId),
    events: transaction.getPublicEvents(problemId).map(publicEventFrom),
  };
  assertPublicLedgerProjectionShape(snapshot);
  return snapshot;
}

function deliverPublicArtifact(artifact: PublicArtifact): PublicArtifactDelivery {
  return {
    status: 200,
    cacheControl: "public, max-age=10",
    bodyMd: artifact.bodyMd,
  };
}

export class SplitService {
  constructor(
    private readonly krater: KraterSplitPort,
    private readonly ids: SplitIdFactory = cryptoIds,
  ) {}

  async pushWorkshop(
    actor: AuthenticatedFellowPrincipal,
    input: WorkshopPushInput,
  ): Promise<WorkshopPushResult> {
    const spilledToPrivateCas = utf8ByteLength(input.bodyMd) > PRIVATE_BODY_THRESHOLD_BYTES;
    if (spilledToPrivateCas && input.privateArtifactDigest === undefined) {
      return {
        status: 422,
        code: "PRIVATE_CAS_REQUIRED",
        fixHint:
          "Bodies above 1 KiB require a private CAS digest before the workshop row is written.",
      };
    }

    return this.krater.transaction((transaction) => {
      const workshopSeq = transaction.nextWorkshopSeq({
        problemId: input.problemId,
        fellowId: actor.fellowId,
      });
      transaction.insertWorkshop({
        id: input.workshopId,
        problemId: input.problemId,
        fellowId: actor.fellowId,
        sponsorId: actor.sponsorId,
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
      if (
        workshop === undefined ||
        !principalMayReadWorkshop(principal, {
          fellowId: workshop.fellowId,
          sponsorId: workshop.sponsorId,
        })
      ) {
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
      if (
        workshop === undefined ||
        !principalMayReadWorkshop(principal, {
          fellowId: workshop.fellowId,
          sponsorId: workshop.sponsorId,
        })
      ) {
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
        !principalMayReadWorkshop(principal, {
          fellowId: workshop.fellowId,
          sponsorId: workshop.sponsorId,
        })
      ) {
        return privateNotFound();
      }
      const artifact = transaction.getPrivateArtifact(workshop.privateArtifactDigest);
      if (artifact === undefined) return privateNotFound();
      return {
        status: 200,
        cacheControl: "private, no-store",
        bodyMd: artifact.bodyMd,
      };
    });
  }

  /**
   * A public handle is resolvable only after `publishWorkshopArtifact` has
   * copied and bound a verified public CAS object.  A private digest is merely
   * an unknown public handle, so it cannot act as an existence oracle.
   */
  async publicArtifact(
    publicArtifactId: string,
  ): Promise<PublicArtifactDelivery | PrivateNotFound> {
    return this.krater.transaction((transaction) => {
      const artifact = transaction.getPublicArtifact(publicArtifactId);
      if (artifact === undefined) return privateNotFound();
      return deliverPublicArtifact(artifact);
    });
  }

  async publishWorkshopArtifact(
    actor: AuthenticatedWorkshopActor,
    workshopId: string,
  ): Promise<PublishArtifactResult> {
    return this.krater.transaction((transaction) => {
      const workshop = transaction.getWorkshop(workshopId);
      if (workshop === undefined || !actorMayManageWorkshop(actor, workshop))
        return privateNotFound();
      if (workshop.privateArtifactDigest === undefined) return privateNotFound();
      if (workshop.promotedPublicEventId === undefined) {
        return { status: 409, code: "PROMOTION_REQUIRED" };
      }
      if (workshop.publishedPublicArtifactId !== undefined) {
        return { status: 200, publicArtifactId: workshop.publishedPublicArtifactId };
      }

      const publicArtifactId = this.ids.nextPublicArtifactId();
      // The port's contract is copy-and-verify first; no public binding is
      // written if the private bytes cannot be read or copied.
      const artifact = transaction.copyPrivateArtifactToPublic(
        workshop.privateArtifactDigest,
        publicArtifactId,
      );
      if (artifact === undefined) return privateNotFound();
      transaction.bindPublicArtifact(workshop.promotedPublicEventId, artifact);
      transaction.markWorkshopArtifactPublished(workshop.id, artifact.id);
      return { status: 201, publicArtifactId: artifact.id };
    });
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
        .filter((event) =>
          `${event.title}\n${event.extract}\n${event.statement}`.toLowerCase().includes(needle),
        );
      const result: PublicSearchResult = {
        status: 200,
        cacheControl: "public, max-age=10",
        results,
      };
      assertPublicLedgerProjectionShape(result);
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
      assertPublicLedgerProjectionShape(result);
      return result;
    });
  }

  async promote(actor: AuthenticatedWorkshopActor, input: PromoteInput): Promise<PromoteResult> {
    try {
      return await this.krater.transaction(async (transaction) => {
        const workshop = transaction.getWorkshop(input.workshopId);
        if (workshop === undefined || !actorMayManageWorkshop(actor, workshop))
          return privateNotFound();

        const scope = idempotencyScope(actor, workshop.problemId);
        const requestDigest = await promotionRequestDigest(actor, workshop, input);
        const previous = transaction.getIdempotency(scope, input.idempotencyKey);
        if (previous !== undefined) {
          if (previous.requestDigest === requestDigest) {
            return { status: 200, outcome: "replayed", receipt: previous.receipt };
          }
          return {
            status: 409,
            code: "IDEMPOTENCY_CONFLICT",
            suggestedAction: "retry_original_request",
          };
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
          id: this.ids.nextPublicEventId(),
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
        transaction.putIdempotency(scope, input.idempotencyKey, {
          requestDigest,
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
