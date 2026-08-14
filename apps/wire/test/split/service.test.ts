import { describe, expect, test } from "bun:test";
import {
  type AuthenticatedFellowPrincipal,
  type AuthenticatedSponsorPrincipal,
  assertPublicLedgerProjectionShape,
  assertPublicProjectionSafe,
  type IdempotencyScope,
  KraterCommitUnknownError,
  type KraterSplitPort,
  type KraterSplitTransaction,
  nextMonotonicUlid,
  normalizeClaimStatement,
  normHash,
  type OpenClaimRef,
  type PrivateArtifactBinding,
  type PromoteInput,
  PromotionCommitUnknownError,
  type PublicLedgerEvent,
  type SplitIdempotencyRecord,
  SplitLeakError,
  SplitService,
  type StoredPublicLedgerEvent,
  WorkshopCreationCommitUnknownError,
  type WorkshopKey,
  type WorkshopObject,
  type WorkshopPushInput,
  type WorkshopReservation,
} from "../../src/split";

/**
 * This is a deterministic unit-test double for the narrow Krater seam.  It is
 * not D1, R2, Miniflare, or a claim that a Worker transaction has run.  Its
 * only job is to make service-level state changes observable; the mock-free
 * Worker/D1/R2 proof remains deliberately blocked in scripts/e2e-s3-split.sh.
 */
interface MemoryState {
  readonly publicSeq: Map<string, number>;
  readonly workshopSeq: Map<string, number>;
  readonly workshops: Map<string, WorkshopObject>;
  readonly publicEvents: Map<string, StoredPublicLedgerEvent[]>;
  readonly openClaims: Map<string, OpenClaimRef>;
  readonly idempotency: Map<string, SplitIdempotencyRecord>;
  readonly reservations: Map<string, WorkshopReservation>;
  readonly privateArtifacts: Map<string, MemoryPrivateArtifact>;
  readonly privateArtifactRecoveries: Map<string, MemoryPrivateArtifactRecovery>;
  privateArtifactSequence: number;
  readonly publicArtifacts: Map<string, string>;
  readonly publicArtifactBindings: Map<string, string>;
}

interface MemoryPrivateArtifact {
  readonly binding: PrivateArtifactBinding;
  readonly bodyMd: string;
  readonly state: "staged" | "bound";
}

interface MemoryPrivateArtifactRecovery {
  readonly reservation: WorkshopReservation;
  readonly binding: PrivateArtifactBinding;
}

const workshopScope = (key: WorkshopKey): string => `${key.problemId}\u0000${key.fellowId}`;
const claimScope = (problemId: string, normalizedHash: string): string =>
  `${problemId}\u0000${normalizedHash}`;
const idempotencyScope = (scope: IdempotencyScope, key: string): string =>
  `${scope.principalId}\u0000${scope.sessionId}\u0000${scope.operation}\u0000${scope.problemId}\u0000${key}`;

function samePrivateBinding(left: PrivateArtifactBinding, right: PrivateArtifactBinding): boolean {
  return (
    left.digest === right.digest &&
    left.problemId === right.problemId &&
    left.fellowId === right.fellowId &&
    left.sponsorId === right.sponsorId &&
    left.sessionId === right.sessionId &&
    left.workshopId === right.workshopId
  );
}

function sameReservation(left: WorkshopReservation, right: WorkshopReservation): boolean {
  return (
    left.workshopId === right.workshopId &&
    left.problemId === right.problemId &&
    left.fellowId === right.fellowId &&
    left.sponsorId === right.sponsorId &&
    left.sessionId === right.sessionId
  );
}

function privateBindingMatchesReservationForTest(
  binding: PrivateArtifactBinding,
  reservation: WorkshopReservation,
): boolean {
  return (
    binding.workshopId === reservation.workshopId &&
    binding.problemId === reservation.problemId &&
    binding.fellowId === reservation.fellowId &&
    binding.sponsorId === reservation.sponsorId &&
    binding.sessionId === reservation.sessionId
  );
}

function requiredPrivateBinding(
  binding: PrivateArtifactBinding | undefined,
  context: string,
): PrivateArtifactBinding {
  if (binding === undefined)
    throw new Error(`expected a server-bound private artifact for ${context}`);
  return binding;
}

function emptyState(): MemoryState {
  return {
    publicSeq: new Map(),
    workshopSeq: new Map(),
    workshops: new Map(),
    publicEvents: new Map(),
    openClaims: new Map(),
    idempotency: new Map(),
    reservations: new Map(),
    privateArtifacts: new Map(),
    privateArtifactRecoveries: new Map(),
    privateArtifactSequence: 0,
    publicArtifacts: new Map(),
    publicArtifactBindings: new Map(),
  };
}

function copyState(state: MemoryState): MemoryState {
  return {
    publicSeq: new Map(state.publicSeq),
    workshopSeq: new Map(state.workshopSeq),
    workshops: new Map(state.workshops),
    publicEvents: new Map(
      Array.from(state.publicEvents, ([problemId, events]) => [problemId, [...events]]),
    ),
    openClaims: new Map(state.openClaims),
    idempotency: new Map(state.idempotency),
    reservations: new Map(state.reservations),
    privateArtifacts: new Map(state.privateArtifacts),
    privateArtifactRecoveries: new Map(state.privateArtifactRecoveries),
    privateArtifactSequence: state.privateArtifactSequence,
    publicArtifacts: new Map(state.publicArtifacts),
    publicArtifactBindings: new Map(state.publicArtifactBindings),
  };
}

class MemoryTransaction implements KraterSplitTransaction {
  constructor(
    private readonly state: MemoryState,
    private readonly loseReservationDuringFinalize: () => boolean,
  ) {}

  currentPublicSeq(problemId: string): number {
    return this.state.publicSeq.get(problemId) ?? 0;
  }

  nextPublicSeq(problemId: string): number {
    const next = this.currentPublicSeq(problemId) + 1;
    this.state.publicSeq.set(problemId, next);
    return next;
  }

  private nextWorkshopSeq(key: WorkshopKey): number {
    const scope = workshopScope(key);
    const next = (this.state.workshopSeq.get(scope) ?? 0) + 1;
    this.state.workshopSeq.set(scope, next);
    return next;
  }

  getWorkshop(workshopId: string): WorkshopObject | undefined {
    return this.state.workshops.get(workshopId);
  }

  reserveWorkshop(reservation: WorkshopReservation): boolean {
    if (
      this.state.workshops.has(reservation.workshopId) ||
      this.state.reservations.has(reservation.workshopId)
    ) {
      return false;
    }
    this.state.reservations.set(reservation.workshopId, reservation);
    return true;
  }

  finalizeReservedWorkshop(
    reservation: WorkshopReservation,
    draft: {
      readonly type: WorkshopObject["type"];
      readonly title: string;
      readonly extract: string;
      readonly inlineBodyMd?: string;
      readonly privateArtifact?: PrivateArtifactBinding;
    },
  ): WorkshopObject | undefined {
    const storedReservation = this.state.reservations.get(reservation.workshopId);
    if (storedReservation === undefined || !sameReservation(storedReservation, reservation)) {
      return undefined;
    }
    if (this.loseReservationDuringFinalize()) {
      this.state.reservations.delete(reservation.workshopId);
      return undefined;
    }
    if (draft.privateArtifact !== undefined) {
      const staged = this.state.privateArtifacts.get(draft.privateArtifact.digest);
      if (
        staged === undefined ||
        staged.state !== "staged" ||
        !samePrivateBinding(staged.binding, draft.privateArtifact)
      ) {
        return undefined;
      }
    }
    const workshop: WorkshopObject = {
      id: reservation.workshopId,
      problemId: reservation.problemId,
      fellowId: reservation.fellowId,
      sponsorId: reservation.sponsorId,
      workshopSeq: this.nextWorkshopSeq(reservation),
      ...draft,
    };
    this.state.workshops.set(workshop.id, workshop);
    this.state.reservations.delete(reservation.workshopId);
    if (draft.privateArtifact !== undefined) {
      const staged = this.state.privateArtifacts.get(draft.privateArtifact.digest);
      if (staged === undefined) throw new Error("staged private artifact disappeared");
      this.state.privateArtifacts.set(draft.privateArtifact.digest, { ...staged, state: "bound" });
    }
    return workshop;
  }

  abortWorkshopReservation(reservation: WorkshopReservation): void {
    const storedReservation = this.state.reservations.get(reservation.workshopId);
    if (storedReservation !== undefined && sameReservation(storedReservation, reservation)) {
      this.state.reservations.delete(reservation.workshopId);
    }
  }

  stagePrivateWorkshopBody(
    reservation: WorkshopReservation,
    bodyMd: string,
  ): PrivateArtifactBinding | undefined {
    const storedReservation = this.state.reservations.get(reservation.workshopId);
    if (storedReservation === undefined || !sameReservation(storedReservation, reservation)) {
      return undefined;
    }
    this.state.privateArtifactSequence += 1;
    const digest = `sha256:${this.state.privateArtifactSequence.toString(16).padStart(64, "0")}`;
    const binding: PrivateArtifactBinding = { ...reservation, digest };
    this.state.privateArtifacts.set(digest, { binding, bodyMd, state: "staged" });
    return binding;
  }

  recordUnboundPrivateWorkshopBody(
    reservation: WorkshopReservation,
    binding: PrivateArtifactBinding,
  ): void {
    const artifact = this.state.privateArtifacts.get(binding.digest);
    if (
      artifact !== undefined &&
      artifact.state === "staged" &&
      samePrivateBinding(artifact.binding, binding) &&
      privateBindingMatchesReservationForTest(binding, reservation)
    ) {
      this.state.privateArtifactRecoveries.set(binding.digest, { reservation, binding });
    }
  }

  markWorkshopPromoted(workshopId: string, publicEventId: string): void {
    const workshop = this.state.workshops.get(workshopId);
    if (workshop === undefined) throw new Error("test Krater received an unknown workshop");
    this.state.workshops.set(workshopId, { ...workshop, promotedPublicEventId: publicEventId });
  }

  markWorkshopArtifactPublished(workshopId: string, publicArtifactId: string): void {
    const workshop = this.state.workshops.get(workshopId);
    if (workshop === undefined) throw new Error("test Krater received an unknown workshop");
    this.state.workshops.set(workshopId, {
      ...workshop,
      publishedPublicArtifactId: publicArtifactId,
    });
  }

  getPublicEvents(problemId: string): readonly StoredPublicLedgerEvent[] {
    return this.state.publicEvents.get(problemId) ?? [];
  }

  insertPublicEvent(event: StoredPublicLedgerEvent): void {
    const events = this.state.publicEvents.get(event.problemId) ?? [];
    this.state.publicEvents.set(event.problemId, [...events, event]);
  }

  getPrivateArtifact(binding: PrivateArtifactBinding): { readonly bodyMd: string } | undefined {
    const artifact = this.state.privateArtifacts.get(binding.digest);
    if (
      artifact === undefined ||
      artifact.state !== "bound" ||
      !samePrivateBinding(artifact.binding, binding)
    ) {
      return undefined;
    }
    return { bodyMd: artifact.bodyMd };
  }

  copyPrivateArtifactToPublic(
    binding: PrivateArtifactBinding,
    publicArtifactId: string,
  ): { readonly id: string; readonly bodyMd: string } | undefined {
    const artifact = this.getPrivateArtifact(binding);
    return artifact === undefined ? undefined : { id: publicArtifactId, bodyMd: artifact.bodyMd };
  }

  bindPublicArtifact(
    publicEventId: string,
    artifact: { readonly id: string; readonly bodyMd: string },
  ): void {
    this.state.publicArtifacts.set(artifact.id, artifact.bodyMd);
    this.state.publicArtifactBindings.set(publicEventId, artifact.id);
  }

  getPublicArtifact(
    publicArtifactId: string,
  ): { readonly id: string; readonly bodyMd: string } | undefined {
    const bodyMd = this.state.publicArtifacts.get(publicArtifactId);
    return bodyMd === undefined ? undefined : { id: publicArtifactId, bodyMd };
  }

  findOpenClaim(problemId: string, normalizedHash: string): OpenClaimRef | undefined {
    return this.state.openClaims.get(claimScope(problemId, normalizedHash));
  }

  insertOpenClaim(claim: OpenClaimRef): void {
    this.state.openClaims.set(claimScope(claim.problemId, claim.normHash), claim);
  }

  getIdempotency(scope: IdempotencyScope, key: string): SplitIdempotencyRecord | undefined {
    return this.state.idempotency.get(idempotencyScope(scope, key));
  }

  putIdempotency(scope: IdempotencyScope, key: string, record: SplitIdempotencyRecord): void {
    this.state.idempotency.set(idempotencyScope(scope, key), record);
  }
}

class MemoryKrater implements KraterSplitPort {
  private state = emptyState();
  private tail: Promise<void> = Promise.resolve();
  private disconnectAfterNextCommit = false;
  private privateStorageUnavailable = false;
  private loseNextFinalizeReservation = false;

  armDisconnectAfterCommit(): void {
    this.disconnectAfterNextCommit = true;
  }

  armPrivateStorageUnavailable(): void {
    this.privateStorageUnavailable = true;
  }

  armFinalizeReservationLoss(): void {
    this.loseNextFinalizeReservation = true;
  }

  workshopCursorFor(key: WorkshopKey): number {
    return this.state.workshopSeq.get(workshopScope(key)) ?? 0;
  }

  privateArtifactCount(): number {
    return this.state.privateArtifacts.size;
  }

  boundPrivateArtifactCount(): number {
    return [...this.state.privateArtifacts.values()].filter(
      (artifact) => artifact.state === "bound",
    ).length;
  }

  recoveryBindingCount(): number {
    return this.state.privateArtifactRecoveries.size;
  }

  privateBindingForWorkshop(workshopId: string): PrivateArtifactBinding | undefined {
    return this.state.workshops.get(workshopId)?.privateArtifact;
  }

  replaceWorkshopBindingForTest(workshopId: string, binding: PrivateArtifactBinding): void {
    const workshop = this.state.workshops.get(workshopId);
    if (workshop === undefined) throw new Error("unknown workshop in test binding replacement");
    this.state.workshops.set(workshopId, { ...workshop, privateArtifact: binding });
  }

  async stagePrivateWorkshopBody(
    reservation: WorkshopReservation,
    bodyMd: string,
  ): Promise<PrivateArtifactBinding | undefined> {
    return this.transaction((transaction) => {
      if (this.privateStorageUnavailable) {
        this.privateStorageUnavailable = false;
        return undefined;
      }
      return (transaction as MemoryTransaction).stagePrivateWorkshopBody(reservation, bodyMd);
    });
  }

  async recoverUnboundPrivateWorkshopBody(
    reservation: WorkshopReservation,
    binding: PrivateArtifactBinding,
  ): Promise<void> {
    await this.transaction((transaction) => {
      (transaction as MemoryTransaction).recordUnboundPrivateWorkshopBody(reservation, binding);
    });
  }

  async transaction<T>(
    operation: (transaction: KraterSplitTransaction) => Promise<T> | T,
  ): Promise<T> {
    let release = (): void => undefined;
    const queued = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.tail;
    this.tail = queued;
    await previous;

    try {
      const draft = copyState(this.state);
      const result = await operation(
        new MemoryTransaction(draft, () => {
          if (!this.loseNextFinalizeReservation) return false;
          this.loseNextFinalizeReservation = false;
          return true;
        }),
      );
      this.state = draft;
      if (this.disconnectAfterNextCommit) {
        this.disconnectAfterNextCommit = false;
        throw new KraterCommitUnknownError();
      }
      return result;
    } finally {
      release();
    }
  }
}

function workshop(overrides: Partial<WorkshopPushInput> = {}): WorkshopPushInput {
  return {
    workshopId: "W-fellow-a-1",
    problemId: "P-split",
    type: "claim-draft",
    title: "Private workshop title",
    bodyMd: "private workshop body",
    ...overrides,
  };
}

function promotion(overrides: Partial<PromoteInput> = {}): PromoteInput {
  return {
    workshopId: "W-fellow-a-1",
    idempotencyKey: "idem-promote-1",
    publicClaim: {
      claimId: "C-1",
      title: "Public claim title",
      extract: "Public claim extract",
      statement: "Every example in the bounded set has property Q.",
      candidate: {},
    },
    ...overrides,
  };
}

const FELLOW_A: AuthenticatedFellowPrincipal = {
  kind: "fellow",
  fellowId: "fellow-a",
  sponsorId: "sponsor-a",
  sessionId: "S-fellow-a",
};
const FELLOW_B: AuthenticatedFellowPrincipal = {
  kind: "fellow",
  fellowId: "fellow-b",
  sponsorId: "sponsor-b",
  sessionId: "S-fellow-b",
};
const FELLOW_A_RESUMED: AuthenticatedFellowPrincipal = {
  ...FELLOW_A,
  sessionId: "S-fellow-a-resumed",
};
const SPONSOR_A: AuthenticatedSponsorPrincipal = {
  kind: "sponsor",
  sponsorId: "sponsor-a",
  sessionId: "S-sponsor-a",
};

class DeterministicSplitIds {
  private event = 0;
  private artifact = 0;

  nextPublicEventId(): string {
    this.event += 1;
    return `EV-test-${this.event}`;
  }

  nextPublicArtifactId(): string {
    this.artifact += 1;
    return `PA-test-${this.artifact}`;
  }
}

function splitService(krater = new MemoryKrater()): SplitService {
  return new SplitService(krater, new DeterministicSplitIds());
}

function eventIds(events: readonly PublicLedgerEvent[]): string[] {
  return events.map((event) => event.id);
}

describe("S-3 split cursors and existence hiding", () => {
  test("workshop cursors are per Fellow/problem and never advance the public cursor", async () => {
    const service = splitService();
    const results = await Promise.all([
      service.pushWorkshop(FELLOW_A, workshop({ workshopId: "W-a-1" })),
      service.pushWorkshop(FELLOW_B, workshop({ workshopId: "W-b-1" })),
      service.pushWorkshop(
        FELLOW_A,
        workshop({ workshopId: "W-a-2", title: "Second private draft" }),
      ),
    ]);

    expect(results).toEqual([
      { status: 201, workshopId: "W-a-1", workshopSeq: 1, spilledToPrivateCas: false },
      { status: 201, workshopId: "W-b-1", workshopSeq: 1, spilledToPrivateCas: false },
      { status: 201, workshopId: "W-a-2", workshopSeq: 2, spilledToPrivateCas: false },
    ]);
    expect(await service.publicLedger("P-split")).toMatchObject({ publicSeq: 0, events: [] });
    expect(
      await service.sponsorWorkshopCursor({ kind: "sponsor", sponsorId: "sponsor-a" }, "W-a-2"),
    ).toEqual({
      status: 200,
      workshopSeq: 2,
    });
    expect(
      await service.sponsorWorkshopCursor({ kind: "sponsor", sponsorId: "sponsor-b" }, "W-b-1"),
    ).toEqual({
      status: 200,
      workshopSeq: 1,
    });
  });

  test("public sequences are per problem and advance only after a successful promotion", async () => {
    const service = splitService();
    await service.pushWorkshop(FELLOW_A, workshop({ workshopId: "W-p1-1", problemId: "P-one" }));
    await service.pushWorkshop(FELLOW_B, workshop({ workshopId: "W-p2-1", problemId: "P-two" }));
    await service.pushWorkshop(FELLOW_A, workshop({ workshopId: "W-p1-2", problemId: "P-one" }));

    expect((await service.publicLedger("P-one")).publicSeq).toBe(0);
    expect((await service.publicLedger("P-two")).publicSeq).toBe(0);
    expect(
      await service.promote(
        FELLOW_A,
        promotion({
          workshopId: "W-p1-1",
          publicClaim: { ...promotion().publicClaim, claimId: "C-p1-1" },
        }),
      ),
    ).toMatchObject({ status: 201, outcome: "created", receipt: { event: { publicSeq: 1 } } });
    expect(
      await service.promote(
        FELLOW_B,
        promotion({
          workshopId: "W-p2-1",
          idempotencyKey: "idem-p2-1",
          publicClaim: {
            ...promotion().publicClaim,
            claimId: "C-p2-1",
            statement: "P-two has property R.",
          },
        }),
      ),
    ).toMatchObject({ status: 201, outcome: "created", receipt: { event: { publicSeq: 1 } } });
    expect(
      await service.promote(
        FELLOW_A,
        promotion({
          workshopId: "W-p1-2",
          idempotencyKey: "idem-p1-2",
          publicClaim: {
            ...promotion().publicClaim,
            claimId: "C-p1-2",
            statement: "P-one has property S.",
          },
        }),
      ),
    ).toMatchObject({ status: 201, outcome: "created", receipt: { event: { publicSeq: 2 } } });
    const one = await service.publicLedger("P-one");
    const two = await service.publicLedger("P-two");
    expect(one.publicSeq).toBe(2);
    expect(two.publicSeq).toBe(1);
    expect(eventIds(one.events)).toEqual(["EV-test-1", "EV-test-3"]);
    expect(eventIds(two.events)).toEqual(["EV-test-2"]);
    expect(new Set([...eventIds(one.events), ...eventIds(two.events)]).size).toBe(3);
  });

  test("owner sponsor sees a card while anonymous, cross-sponsor, and absent reads are identical", async () => {
    const service = splitService();
    await service.pushWorkshop(
      FELLOW_A,
      workshop({
        workshopId: "W-private",
        title: "Private canary title",
        bodyMd: "private canary body",
      }),
    );

    const owner = await service.sponsorWorkshopCard(
      { kind: "sponsor", sponsorId: "sponsor-a" },
      "W-private",
    );
    expect(owner).toEqual({
      status: 200,
      id: "W-private",
      workshopSeq: 1,
      type: "claim-draft",
      title: "Private canary title",
      extract: "private canary body",
    });
    expect(JSON.stringify(owner)).not.toContain("bodyMd");
    expect(
      await service.sponsorWorkshopCard(
        { kind: "fellow", fellowId: "fellow-a", sponsorId: "sponsor-a" },
        "W-private",
      ),
    ).toEqual(owner);

    const anonymous = await service.sponsorWorkshopCard({ kind: "anonymous" }, "W-private");
    const crossSponsor = await service.sponsorWorkshopCard(
      { kind: "sponsor", sponsorId: "sponsor-b" },
      "W-private",
    );
    const crossFellow = await service.sponsorWorkshopCard(
      { kind: "fellow", fellowId: "fellow-b", sponsorId: "sponsor-b" },
      "W-private",
    );
    const mismatchedFellow = await service.sponsorWorkshopCard(
      { kind: "fellow", fellowId: "fellow-a", sponsorId: "sponsor-b" },
      "W-private",
    );
    const absent = await service.sponsorWorkshopCard(
      { kind: "sponsor", sponsorId: "sponsor-a" },
      "W-absent",
    );
    const indistinguishable = { status: 404, code: "NOT_FOUND", cacheControl: "no-store" } as const;
    expect(anonymous).toEqual(indistinguishable);
    expect(crossSponsor).toEqual(indistinguishable);
    expect(crossFellow).toEqual(indistinguishable);
    expect(mismatchedFellow).toEqual(indistinguishable);
    expect(absent).toEqual(indistinguishable);
    expect(JSON.stringify(crossSponsor)).not.toContain("W-private");
  });

  test("caller-supplied owner or actor fields cannot override authenticated principal context", async () => {
    const service = splitService();
    const injectedOwner = {
      ...workshop({ workshopId: "W-context-owned" }),
      fellowId: "fellow-b",
      sponsorId: "sponsor-b",
    };
    await service.pushWorkshop(FELLOW_A, injectedOwner);

    expect(
      await service.sponsorWorkshopCard(
        { kind: "fellow", fellowId: "fellow-a", sponsorId: "sponsor-a" },
        "W-context-owned",
      ),
    ).toMatchObject({ status: 200, id: "W-context-owned" });
    expect(
      await service.sponsorWorkshopCard(
        { kind: "fellow", fellowId: "fellow-b", sponsorId: "sponsor-b" },
        "W-context-owned",
      ),
    ).toEqual({ status: 404, code: "NOT_FOUND", cacheControl: "no-store" });

    const injectedActor = {
      ...promotion({ workshopId: "W-context-owned" }),
      actorSponsorId: "sponsor-a",
      actorFellowId: "fellow-a",
      requestDigest: "attacker-supplied-digest-is-ignored",
    };
    expect(await service.promote(FELLOW_B, injectedActor)).toEqual({
      status: 404,
      code: "NOT_FOUND",
      cacheControl: "no-store",
    });
  });

  test("server-binds private CAS bodies so a known victim digest cannot be rebound or read", async () => {
    const krater = new MemoryKrater();
    const service = splitService(krater);
    const victimBody = "victim private CAS body ".repeat(80);
    const attackerBody = "attacker private CAS body ".repeat(80);
    await service.pushWorkshop(
      FELLOW_B,
      workshop({ workshopId: "W-victim-spill", bodyMd: victimBody }),
    );
    const victimBinding = requiredPrivateBinding(
      krater.privateBindingForWorkshop("W-victim-spill"),
      "victim workshop",
    );

    const forgedInput = {
      ...workshop({ workshopId: "W-attacker-spill", bodyMd: attackerBody }),
      privateArtifactDigest: victimBinding.digest,
    };
    await service.pushWorkshop(FELLOW_A, forgedInput);
    const attackerBinding = requiredPrivateBinding(
      krater.privateBindingForWorkshop("W-attacker-spill"),
      "attacker workshop",
    );
    expect(attackerBinding.digest).not.toBe(victimBinding.digest);
    expect(
      await service.sponsorPrivateArtifact(
        { kind: "sponsor", sponsorId: "sponsor-a" },
        "W-attacker-spill",
      ),
    ).toEqual({ status: 200, cacheControl: "private, no-store", bodyMd: attackerBody });

    krater.replaceWorkshopBindingForTest("W-attacker-spill", {
      ...attackerBinding,
      digest: victimBinding.digest,
    });
    expect(
      await service.sponsorPrivateArtifact(
        { kind: "sponsor", sponsorId: "sponsor-a" },
        "W-attacker-spill",
      ),
    ).toEqual({ status: 404, code: "NOT_FOUND", cacheControl: "no-store" });
  });

  test("planted PRIVATE_CAS_STORAGE_REQUIRED leaves no cursor, reservation, or binding", async () => {
    const krater = new MemoryKrater();
    const service = splitService(krater);
    const cursorKey = { problemId: "P-split", fellowId: FELLOW_A.fellowId };
    const privateBody = "storage-unavailable private body ".repeat(80);
    expect(krater.workshopCursorFor(cursorKey)).toBe(0);
    krater.armPrivateStorageUnavailable();

    expect(
      await service.pushWorkshop(
        FELLOW_A,
        workshop({ workshopId: "W-storage-unavailable", bodyMd: privateBody }),
      ),
    ).toEqual({
      status: 422,
      code: "PRIVATE_CAS_STORAGE_REQUIRED",
      fixHint: "Private workshop storage is unavailable; retry after the server can bind the body.",
    });
    expect(krater.workshopCursorFor(cursorKey)).toBe(0);
    expect(krater.privateArtifactCount()).toBe(0);
    expect(krater.boundPrivateArtifactCount()).toBe(0);
    expect(krater.recoveryBindingCount()).toBe(0);
    expect(await service.sponsorWorkshopCard(SPONSOR_A, "W-storage-unavailable")).toEqual({
      status: 404,
      code: "NOT_FOUND",
      cacheControl: "no-store",
    });

    expect(
      await service.pushWorkshop(
        FELLOW_A,
        workshop({ workshopId: "W-storage-unavailable", bodyMd: "retry after storage recovers" }),
      ),
    ).toEqual({
      status: 201,
      workshopId: "W-storage-unavailable",
      workshopSeq: 1,
      spilledToPrivateCas: false,
    });
  });

  test("create-only workshop IDs survive concurrent retries and cannot reset promotion", async () => {
    const krater = new MemoryKrater();
    const service = splitService(krater);
    const first = workshop({
      workshopId: "W-create-only",
      bodyMd: "first private body ".repeat(80),
    });
    const second = workshop({
      workshopId: "W-create-only",
      bodyMd: "second private body ".repeat(80),
    });
    const results = await Promise.all([
      service.pushWorkshop(FELLOW_A, first),
      service.pushWorkshop(FELLOW_B, second),
    ]);
    expect(results).toEqual([
      { status: 201, workshopId: "W-create-only", workshopSeq: 1, spilledToPrivateCas: true },
      {
        status: 409,
        code: "WORKSHOP_ALREADY_EXISTS",
        suggestedAction: "use_new_workshop_id",
      },
    ]);
    expect(krater.workshopCursorFor({ problemId: "P-split", fellowId: FELLOW_A.fellowId })).toBe(1);
    expect(krater.workshopCursorFor({ problemId: "P-split", fellowId: FELLOW_B.fellowId })).toBe(0);
    expect(krater.privateArtifactCount()).toBe(1);
    expect(krater.boundPrivateArtifactCount()).toBe(1);
    expect(krater.privateBindingForWorkshop("W-create-only")).toMatchObject({
      fellowId: FELLOW_A.fellowId,
      sponsorId: FELLOW_A.sponsorId,
    });
    expect(
      await service.sponsorPrivateArtifact(
        { kind: "sponsor", sponsorId: FELLOW_B.sponsorId },
        "W-create-only",
      ),
    ).toEqual({ status: 404, code: "NOT_FOUND", cacheControl: "no-store" });

    expect(
      await service.promote(FELLOW_A, promotion({ workshopId: "W-create-only" })),
    ).toMatchObject({ status: 201, outcome: "created" });
    expect(await service.pushWorkshop(FELLOW_A, first)).toEqual({
      status: 409,
      code: "WORKSHOP_ALREADY_EXISTS",
      suggestedAction: "use_new_workshop_id",
    });
    expect(
      await service.promote(
        FELLOW_A,
        promotion({ workshopId: "W-create-only", idempotencyKey: "retry-with-new-key" }),
      ),
    ).toEqual({ status: 409, code: "PROMOTION_ALREADY_EXISTS", publicEventId: "EV-test-1" });
    expect(eventIds((await service.publicLedger("P-split")).events)).toEqual(["EV-test-1"]);
  });

  test("an unconfirmed stage/finalize boundary records recovery without exposing private bytes", async () => {
    const krater = new MemoryKrater();
    const service = splitService(krater);
    const cursorKey = { problemId: "P-split", fellowId: FELLOW_A.fellowId };
    krater.armFinalizeReservationLoss();

    await expect(
      service.pushWorkshop(
        FELLOW_A,
        workshop({ workshopId: "W-recovery-seam", bodyMd: "recovery private body ".repeat(80) }),
      ),
    ).rejects.toBeInstanceOf(WorkshopCreationCommitUnknownError);
    expect(krater.workshopCursorFor(cursorKey)).toBe(0);
    expect(krater.privateArtifactCount()).toBe(1);
    expect(krater.boundPrivateArtifactCount()).toBe(0);
    expect(krater.recoveryBindingCount()).toBe(1);
    expect(await service.sponsorPrivateArtifact(SPONSOR_A, "W-recovery-seam")).toEqual({
      status: 404,
      code: "NOT_FOUND",
      cacheControl: "no-store",
    });
    expect(await service.publicLedger("P-split")).toMatchObject({ publicSeq: 0, events: [] });
  });
});

describe("S-3 public-surface and private-CAS exclusion", () => {
  test("cache, search, export, and public CAS exclude workshop bodies and private artifact digests", async () => {
    const krater = new MemoryKrater();
    const service = splitService(krater);
    const privateBody = "private-cas-canary ".repeat(80);
    await service.pushWorkshop(
      FELLOW_A,
      workshop({
        workshopId: "W-spill",
        title: "Private CAS title",
        bodyMd: privateBody,
      }),
    );

    const sponsorArtifact = await service.sponsorPrivateArtifact(
      { kind: "sponsor", sponsorId: "sponsor-a" },
      "W-spill",
    );
    expect(sponsorArtifact).toEqual({
      status: 200,
      cacheControl: "private, no-store",
      bodyMd: privateBody,
    });
    expect(
      await service.sponsorPrivateArtifact(
        { kind: "fellow", fellowId: "fellow-a", sponsorId: "sponsor-a" },
        "W-spill",
      ),
    ).toEqual(sponsorArtifact);

    const cache = await service.publicLedger("P-split");
    const search = await service.searchPublicLedger("P-split", "private-cas-canary");
    const exported = await service.exportPublicLedger("P-split");
    const privateBinding = requiredPrivateBinding(
      krater.privateBindingForWorkshop("W-spill"),
      "private workshop",
    );
    const publicCas = await service.publicArtifact(privateBinding.digest);
    for (const face of [cache, search, exported, publicCas]) {
      const serialized = JSON.stringify(face);
      expect(serialized).not.toContain("private-cas-canary");
      expect(serialized).not.toContain(privateBinding.digest);
      expect(serialized).not.toContain("W-spill");
    }
    expect(cache).toMatchObject({ cacheControl: "public, max-age=10", publicSeq: 0, events: [] });
    expect(search).toMatchObject({ results: [] });
    expect(exported).toMatchObject({ publicSeq: 0, events: [] });
    expect(publicCas).toEqual({ status: 404, code: "NOT_FOUND", cacheControl: "no-store" });
  });

  test("private bytes become public only after promotion then verified public binding", async () => {
    const krater = new MemoryKrater();
    const service = splitService(krater);
    const privateBody = "private artifact canary ".repeat(80);
    await service.pushWorkshop(
      FELLOW_A,
      workshop({
        workshopId: "W-promoted-spill",
        bodyMd: privateBody,
      }),
    );
    expect(await service.publishWorkshopArtifact(FELLOW_A, "W-promoted-spill")).toEqual({
      status: 409,
      code: "PROMOTION_REQUIRED",
    });
    const result = await service.promote(FELLOW_A, promotion({ workshopId: "W-promoted-spill" }));
    expect(result).toMatchObject({ status: 201, outcome: "created" });

    const publicFace = await service.publicLedger("P-split");
    expect(eventIds(publicFace.events)).toEqual(["EV-test-1"]);
    expect(JSON.stringify(publicFace)).not.toContain("private-after-promotion");
    const privateBinding = requiredPrivateBinding(
      krater.privateBindingForWorkshop("W-promoted-spill"),
      "promoted workshop",
    );
    expect(await service.publicArtifact(privateBinding.digest)).toEqual({
      status: 404,
      code: "NOT_FOUND",
      cacheControl: "no-store",
    });
    const published = await service.publishWorkshopArtifact(SPONSOR_A, "W-promoted-spill");
    expect(published).toEqual({ status: 201, publicArtifactId: "PA-test-1" });
    expect(await service.publicArtifact("PA-test-1")).toEqual({
      status: 200,
      cacheControl: "public, max-age=10",
      bodyMd: privateBody,
    });
    expect(await service.publishWorkshopArtifact(FELLOW_A, "W-promoted-spill")).toEqual({
      status: 200,
      publicArtifactId: "PA-test-1",
    });
  });
});

describe("S-3 promotion validator", () => {
  test("normalizes all documented TeX delimiters and confusable whitespace without merging distinct claims", async () => {
    const canonical = "Every example has $x + y$ property Q.";
    const equivalentForms = [
      "Every\u00a0example has $$x\u200B + y$$ property Q.",
      "Every example has \\(x + y\\) property Q.",
      "Every example has \\[x + y\\] property Q.",
    ];
    const canonicalHash = await normHash(canonical);
    for (const equivalent of equivalentForms) {
      expect(await normHash(equivalent)).toBe(canonicalHash);
    }
    expect(await normHash("Every example has $x - y$ property Q.")).not.toBe(canonicalHash);
    expect(await normHash("Some examples have $x + y$ property Q.")).not.toBe(canonicalHash);
  });

  test("escapes raw controls injectively while collapsing control whitespace", async () => {
    const rawTokenControls = "Every example has \u0002x + y\u0003 property Q.";
    const literalEscapeText = "Every example has ~c02;x + y~c03; property Q.";
    const math = "Every example has $x + y$ property Q.";

    expect(normalizeClaimStatement(rawTokenControls)).toContain("~c02;x + y~c03;");
    expect(normalizeClaimStatement(literalEscapeText)).toContain("~~c02;x + y~~c03;");
    expect(await normHash(rawTokenControls)).not.toBe(await normHash(math));
    expect(await normHash(rawTokenControls)).not.toBe(await normHash(literalEscapeText));
    expect(await normHash("Every\texample\nhas property Q.")).toBe(
      await normHash("Every example has property Q."),
    );
    for (const control of ["\u0001", "\u0007", "\u001b", "\u007f", "\u009b"]) {
      expect(normalizeClaimStatement(`before${control}after`)).not.toContain(control);
    }
  });

  test("currency and escaped dollars cannot consume a later inline-math opener", async () => {
    const inline = "Costs $5. The bound $x + y$ holds; escaped \\$9 stays prose.";
    const explicit = "Costs $5. The bound \\(x + y\\) holds; escaped \\$9 stays prose.";

    expect(await normHash(inline)).toBe(await normHash(explicit));
    expect(await normHash("The constant is $5$. ")).toBe(
      await normHash("The constant is \\(5\\)."),
    );
  });

  test("does not let a forged raw-token claim preempt an honest inline-math claim", async () => {
    const service = splitService();
    await service.pushWorkshop(FELLOW_A, workshop({ workshopId: "W-raw-token" }));
    expect(
      await service.promote(
        FELLOW_A,
        promotion({
          workshopId: "W-raw-token",
          publicClaim: {
            ...promotion().publicClaim,
            claimId: "C-raw-token",
            statement: "Every example has \u0002x + y\u0003 property Q.",
          },
        }),
      ),
    ).toMatchObject({ status: 201, outcome: "created" });

    await service.pushWorkshop(FELLOW_A, workshop({ workshopId: "W-honest-math" }));
    expect(
      await service.promote(
        FELLOW_A,
        promotion({
          workshopId: "W-honest-math",
          idempotencyKey: "idem-honest-math",
          publicClaim: {
            ...promotion().publicClaim,
            claimId: "C-honest-math",
            statement: "Every example has $x + y$ property Q.",
          },
        }),
      ),
    ).toMatchObject({ status: 201, outcome: "created" });
  });

  test("refuses self-certification with the S-3 P2/P4 contract error", async () => {
    const service = splitService();
    await service.pushWorkshop(FELLOW_A, workshop());

    const result = await service.promote(
      FELLOW_A,
      promotion({
        publicClaim: { ...promotion().publicClaim, candidate: { disposition: "proved" } },
      }),
    );
    expect(result).toEqual({
      status: 422,
      code: "SCHEMA_INVALID",
      rule: "P2/P4",
      fixHint:
        "Remove author-writable disposition, proof, confidence, certification, or status-upgrade fields; the ledger computes disposition after independent review.",
      nextAction: "remove_authoritative_fields",
    });
    expect(await service.publicLedger("P-split")).toMatchObject({ publicSeq: 0, events: [] });
  });

  test("refuses nested semantic-control assertions while ordinary prose remains writable", async () => {
    const service = splitService();
    await service.pushWorkshop(FELLOW_A, workshop({ workshopId: "W-nested-p2" }));

    expect(
      await service.promote(
        FELLOW_A,
        promotion({
          workshopId: "W-nested-p2",
          publicClaim: {
            ...promotion().publicClaim,
            candidate: {
              evidence: [{ reviewer_notes: { StAtUs: "ＰＲＯＶＥＤ" } }],
            },
          },
        }),
      ),
    ).toMatchObject({
      status: 422,
      code: "SCHEMA_INVALID",
      rule: "P2/P4",
      nextAction: "remove_authoritative_fields",
    });

    expect(
      await service.promote(
        FELLOW_A,
        promotion({
          workshopId: "W-nested-p2",
          publicClaim: {
            ...promotion().publicClaim,
            candidate: {
              prose:
                "The historical source uses the word PROVED; this Fellow does not assert a disposition.",
              review_note: "Status remains open pending independent review.",
            },
          },
        }),
      ),
    ).toMatchObject({ status: 201, outcome: "created" });
  });

  test("refuses an NFKC-equivalent open claim with P11 and the existing ID", async () => {
    const service = splitService();
    const firstStatement = "Caf\u00e9 $x  + y$ has property Q.";
    const equivalentStatement = "Cafe\u0301 $x + y$ has property Q.";
    expect(await normHash(firstStatement)).toBe(await normHash(equivalentStatement));

    await service.pushWorkshop(FELLOW_A, workshop({ workshopId: "W-first" }));
    expect(
      await service.promote(
        FELLOW_A,
        promotion({
          workshopId: "W-first",
          publicClaim: { ...promotion().publicClaim, claimId: "C-41", statement: firstStatement },
        }),
      ),
    ).toMatchObject({ status: 201, outcome: "created" });

    await service.pushWorkshop(FELLOW_A, workshop({ workshopId: "W-second" }));
    const duplicate = await service.promote(
      FELLOW_A,
      promotion({
        workshopId: "W-second",
        idempotencyKey: "idem-duplicate",
        publicClaim: {
          ...promotion().publicClaim,
          claimId: "C-42",
          statement: equivalentStatement,
        },
      }),
    );
    expect(duplicate).toEqual({
      status: 409,
      code: "DUPLICATE_CLAIM",
      rule: "P11",
      existingId: "C-41",
      fixHint: "Review the existing claim or refine the statement so its scope differs materially.",
      nextAction: "review_or_refine",
    });
    expect((await service.publicLedger("P-split")).publicSeq).toBe(1);
  });
});

describe("S-3 atomic promotion and recovery", () => {
  test("server-computes replay identity, rejects a changed body, and never makes a second public event", async () => {
    const service = splitService();
    await service.pushWorkshop(FELLOW_A, workshop());
    const input = promotion();

    const created = await service.promote(FELLOW_A, input);
    const replayed = await service.promote(FELLOW_A, input);
    const conflict = await service.promote(FELLOW_A, {
      ...input,
      publicClaim: {
        ...input.publicClaim,
        statement: "The same key now carries a changed request body.",
      },
    });
    const secondKey = await service.promote(
      {
        ...FELLOW_A,
        sessionId: FELLOW_A.sessionId,
      },
      {
        ...input,
        idempotencyKey: "idem-promote-2",
      },
    );

    expect(created).toMatchObject({ status: 201, outcome: "created" });
    expect(replayed).toMatchObject({ status: 200, outcome: "replayed" });
    expect(replayed).toMatchObject({ receipt: (created as { receipt: unknown }).receipt });
    expect(conflict).toEqual({
      status: 409,
      code: "IDEMPOTENCY_CONFLICT",
      suggestedAction: "retry_original_request",
    });
    expect(secondKey).toEqual({
      status: 409,
      code: "PROMOTION_ALREADY_EXISTS",
      publicEventId: "EV-test-1",
    });
    expect(eventIds((await service.publicLedger("P-split")).events)).toEqual(["EV-test-1"]);
  });

  test("a disconnect after the committed transaction is recovered only by the same idempotency key", async () => {
    const krater = new MemoryKrater();
    const service = splitService(krater);
    await service.pushWorkshop(FELLOW_A, workshop());
    const input = promotion();
    krater.armDisconnectAfterCommit();

    await expect(service.promote(FELLOW_A, input)).rejects.toBeInstanceOf(
      PromotionCommitUnknownError,
    );
    const recovered = await service.promote(FELLOW_A, input);
    expect(recovered).toMatchObject({ status: 200, outcome: "replayed" });
    expect(eventIds((await service.publicLedger("P-split")).events)).toEqual(["EV-test-1"]);
  });

  test("the same idempotency key is isolated by principal, session, operation, and problem", async () => {
    const service = splitService();
    await service.pushWorkshop(
      FELLOW_A,
      workshop({ workshopId: "W-scope-a-p1", problemId: "P-one" }),
    );
    await service.pushWorkshop(
      FELLOW_A,
      workshop({ workshopId: "W-scope-a-p2", problemId: "P-two" }),
    );
    await service.pushWorkshop(
      FELLOW_A,
      workshop({ workshopId: "W-scope-a-resumed", problemId: "P-one" }),
    );
    await service.pushWorkshop(
      FELLOW_B,
      workshop({ workshopId: "W-scope-b-p1", problemId: "P-one" }),
    );

    const sharedKey = "same-key-different-scope";
    expect(
      await service.promote(
        FELLOW_A,
        promotion({
          workshopId: "W-scope-a-p1",
          idempotencyKey: sharedKey,
          publicClaim: {
            ...promotion().publicClaim,
            claimId: "C-scope-a-p1",
            statement: "P-one claim A.",
          },
        }),
      ),
    ).toMatchObject({ status: 201, outcome: "created" });
    expect(
      await service.promote(
        FELLOW_A,
        promotion({
          workshopId: "W-scope-a-p2",
          idempotencyKey: sharedKey,
          publicClaim: {
            ...promotion().publicClaim,
            claimId: "C-scope-a-p2",
            statement: "P-two claim A.",
          },
        }),
      ),
    ).toMatchObject({ status: 201, outcome: "created" });
    expect(
      await service.promote(
        FELLOW_A_RESUMED,
        promotion({
          workshopId: "W-scope-a-resumed",
          idempotencyKey: sharedKey,
          publicClaim: {
            ...promotion().publicClaim,
            claimId: "C-scope-a-resumed",
            statement: "P-one claim B.",
          },
        }),
      ),
    ).toMatchObject({ status: 201, outcome: "created" });
    expect(
      await service.promote(
        FELLOW_B,
        promotion({
          workshopId: "W-scope-b-p1",
          idempotencyKey: sharedKey,
          publicClaim: {
            ...promotion().publicClaim,
            claimId: "C-scope-b-p1",
            statement: "P-one claim C.",
          },
        }),
      ),
    ).toMatchObject({ status: 201, outcome: "created" });
  });
});

describe("S-3 planted negative", () => {
  test("strict public shapes require every event/result field and reject mixed or nested canaries", () => {
    const event = {
      id: "EV-01J00000000000000000000000",
      problemId: "P-split",
      publicSeq: 1,
      claimId: "C-1",
      title: "A public title",
      extract: "A public extract",
      statement: "A bounded public statement.",
    };
    const snapshot = {
      status: 200,
      cacheControl: "public, max-age=10",
      publicSeq: 1,
      events: [event],
    };
    const search = {
      status: 200,
      cacheControl: "public, max-age=10",
      results: [event],
    };
    expect(() => assertPublicLedgerProjectionShape(snapshot)).not.toThrow();
    expect(() => assertPublicLedgerProjectionShape(search)).not.toThrow();

    for (const requiredField of Object.keys(event)) {
      const incompleteEvent: Record<string, unknown> = { ...event };
      delete incompleteEvent[requiredField];
      expect(() =>
        assertPublicLedgerProjectionShape({ ...snapshot, events: [incompleteEvent] }),
      ).toThrow(SplitLeakError);
      expect(() =>
        assertPublicLedgerProjectionShape({ ...search, results: [incompleteEvent] }),
      ).toThrow(SplitLeakError);
    }

    const mixedResultsLeak = { ...snapshot, results: [event] };
    const nestedBodyCanary = {
      ...snapshot,
      events: [{ ...event, metadata: { bodyMd: "private body canary" } }],
    };
    expect(() => assertPublicLedgerProjectionShape(mixedResultsLeak)).toThrow(SplitLeakError);
    expect(() => assertPublicLedgerProjectionShape(nestedBodyCanary)).toThrow(SplitLeakError);
  });

  test("should-leak: a workshop sequence injected into a public projection is detected", () => {
    // This object is intentionally malformed.  The guard is exercised against
    // the same public-projection invariant used by the service above.
    const shouldLeak = {
      status: 200,
      publicSeq: 1,
      events: [],
      workshop_seq: 7,
    };
    expect(() => assertPublicProjectionSafe(shouldLeak)).toThrow(SplitLeakError);
    try {
      assertPublicProjectionSafe(shouldLeak);
      throw new Error("the planted workshop sequence was not detected");
    } catch (error) {
      expect(error).toBeInstanceOf(SplitLeakError);
      expect((error as SplitLeakError).code).toBe("SPLIT_LEAK_DETECTED");
    }
  });

  test("should-leak: separator and compatibility variants of private keys are detected", () => {
    for (const key of ["sponsor-id", "sponsor id", "workshop.seq", "body-md", "ｓponsor_id"]) {
      expect(() => assertPublicProjectionSafe({ [key]: "private canary" })).toThrow(SplitLeakError);
    }
  });

  test("should-leak: an innocuous key on a public ledger shape is rejected by the allowlist", () => {
    const shouldLeak = {
      status: 200,
      cacheControl: "public, max-age=10",
      publicSeq: 1,
      events: [],
      annotation: "private bytes under an innocent-looking key",
    };
    expect(() => assertPublicLedgerProjectionShape(shouldLeak)).toThrow(SplitLeakError);
  });

  test("should-leak: a private field nested below an otherwise ordinary object is detected", () => {
    const shouldLeak = {
      status: 200,
      cacheControl: "public, max-age=10",
      publicSeq: 1,
      events: [],
      presentation: { workshop_seq: 7 },
    };
    expect(() => assertPublicProjectionSafe(shouldLeak)).toThrow(SplitLeakError);
  });
});

describe("S-3 identifiers", () => {
  test("production ULIDs are canonical, unique, and lexically monotonic", () => {
    const ulids = Array.from({ length: 64 }, () => nextMonotonicUlid());
    for (const ulid of ulids) {
      expect(ulid).toMatch(/^[0-7][0123456789ABCDEFGHJKMNPQRSTVWXYZ]{25}$/u);
    }
    expect(new Set(ulids)).toHaveLength(ulids.length);
    expect([...ulids].sort()).toEqual(ulids);
  });

  test("the default production ID factory emits prefixed ULIDs while test services stay deterministic", async () => {
    const productionService = new SplitService(new MemoryKrater());
    await productionService.pushWorkshop(FELLOW_A, workshop({ workshopId: "W-production-id" }));
    const promoted = await productionService.promote(
      FELLOW_A,
      promotion({ workshopId: "W-production-id" }),
    );
    expect(promoted).toMatchObject({
      status: 201,
      outcome: "created",
      receipt: {
        event: { id: expect.stringMatching(/^EV-[0-7][0123456789ABCDEFGHJKMNPQRSTVWXYZ]{25}$/u) },
      },
    });

    const deterministicService = splitService();
    await deterministicService.pushWorkshop(FELLOW_A, workshop({ workshopId: "W-test-id" }));
    expect(
      await deterministicService.promote(FELLOW_A, promotion({ workshopId: "W-test-id" })),
    ).toMatchObject({ receipt: { event: { id: "EV-test-1" } } });
  });
});
