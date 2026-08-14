import { describe, expect, test } from "bun:test";
import {
  assertPublicProjectionSafe,
  KraterCommitUnknownError,
  type KraterSplitPort,
  type KraterSplitTransaction,
  normHash,
  type OpenClaimRef,
  type PromoteInput,
  PromotionCommitUnknownError,
  type PublicLedgerEvent,
  type SplitIdempotencyRecord,
  SplitLeakError,
  SplitService,
  type StoredPublicLedgerEvent,
  type WorkshopKey,
  type WorkshopObject,
  type WorkshopPushInput,
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
}

const workshopScope = (key: WorkshopKey): string => `${key.problemId}\u0000${key.fellowId}`;
const claimScope = (problemId: string, normalizedHash: string): string =>
  `${problemId}\u0000${normalizedHash}`;

function emptyState(): MemoryState {
  return {
    publicSeq: new Map(),
    workshopSeq: new Map(),
    workshops: new Map(),
    publicEvents: new Map(),
    openClaims: new Map(),
    idempotency: new Map(),
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
  };
}

class MemoryTransaction implements KraterSplitTransaction {
  constructor(private readonly state: MemoryState) {}

  currentPublicSeq(problemId: string): number {
    return this.state.publicSeq.get(problemId) ?? 0;
  }

  nextPublicSeq(problemId: string): number {
    const next = this.currentPublicSeq(problemId) + 1;
    this.state.publicSeq.set(problemId, next);
    return next;
  }

  nextWorkshopSeq(key: WorkshopKey): number {
    const scope = workshopScope(key);
    const next = (this.state.workshopSeq.get(scope) ?? 0) + 1;
    this.state.workshopSeq.set(scope, next);
    return next;
  }

  getWorkshop(workshopId: string): WorkshopObject | undefined {
    return this.state.workshops.get(workshopId);
  }

  insertWorkshop(workshop: WorkshopObject): void {
    this.state.workshops.set(workshop.id, workshop);
  }

  markWorkshopPromoted(workshopId: string, publicEventId: string): void {
    const workshop = this.state.workshops.get(workshopId);
    if (workshop === undefined) throw new Error("test Krater received an unknown workshop");
    this.state.workshops.set(workshopId, { ...workshop, promotedPublicEventId: publicEventId });
  }

  getPublicEvents(problemId: string): readonly StoredPublicLedgerEvent[] {
    return this.state.publicEvents.get(problemId) ?? [];
  }

  insertPublicEvent(event: StoredPublicLedgerEvent): void {
    const events = this.state.publicEvents.get(event.problemId) ?? [];
    this.state.publicEvents.set(event.problemId, [...events, event]);
  }

  findOpenClaim(problemId: string, normalizedHash: string): OpenClaimRef | undefined {
    return this.state.openClaims.get(claimScope(problemId, normalizedHash));
  }

  insertOpenClaim(claim: OpenClaimRef): void {
    this.state.openClaims.set(claimScope(claim.problemId, claim.normHash), claim);
  }

  getIdempotency(key: string): SplitIdempotencyRecord | undefined {
    return this.state.idempotency.get(key);
  }

  putIdempotency(key: string, record: SplitIdempotencyRecord): void {
    this.state.idempotency.set(key, record);
  }
}

class MemoryKrater implements KraterSplitPort {
  private state = emptyState();
  private tail: Promise<void> = Promise.resolve();
  private disconnectAfterNextCommit = false;

  armDisconnectAfterCommit(): void {
    this.disconnectAfterNextCommit = true;
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
      const result = await operation(new MemoryTransaction(draft));
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
    fellowId: "fellow-a",
    sponsorId: "sponsor-a",
    type: "claim-draft",
    title: "Private workshop title",
    bodyMd: "private workshop body",
    ...overrides,
  };
}

function promotion(overrides: Partial<PromoteInput> = {}): PromoteInput {
  return {
    workshopId: "W-fellow-a-1",
    actorSponsorId: "sponsor-a",
    actorFellowId: "fellow-a",
    idempotencyKey: "idem-promote-1",
    requestDigest: "request-sha256-a",
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

function eventIds(events: readonly PublicLedgerEvent[]): string[] {
  return events.map((event) => event.id);
}

describe("S-3 split cursors and existence hiding", () => {
  test("workshop cursors are per Fellow/problem and never advance the public cursor", async () => {
    const service = new SplitService(new MemoryKrater());
    const results = await Promise.all([
      service.pushWorkshop(workshop({ workshopId: "W-a-1" })),
      service.pushWorkshop(
        workshop({ workshopId: "W-b-1", fellowId: "fellow-b", sponsorId: "sponsor-b" }),
      ),
      service.pushWorkshop(workshop({ workshopId: "W-a-2", title: "Second private draft" })),
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
    const service = new SplitService(new MemoryKrater());
    await service.pushWorkshop(workshop({ workshopId: "W-p1-1", problemId: "P-one" }));
    await service.pushWorkshop(
      workshop({ workshopId: "W-p2-1", problemId: "P-two", fellowId: "fellow-b", sponsorId: "sponsor-b" }),
    );
    await service.pushWorkshop(workshop({ workshopId: "W-p1-2", problemId: "P-one" }));

    expect((await service.publicLedger("P-one")).publicSeq).toBe(0);
    expect((await service.publicLedger("P-two")).publicSeq).toBe(0);
    expect(
      await service.promote(
        promotion({ workshopId: "W-p1-1", publicClaim: { ...promotion().publicClaim, claimId: "C-p1-1" } }),
      ),
    ).toMatchObject({ status: 201, outcome: "created", receipt: { event: { publicSeq: 1 } } });
    expect(
      await service.promote(
        promotion({
          workshopId: "W-p2-1",
          actorSponsorId: "sponsor-b",
          actorFellowId: "fellow-b",
          idempotencyKey: "idem-p2-1",
          requestDigest: "request-sha256-p2-1",
          publicClaim: { ...promotion().publicClaim, claimId: "C-p2-1", statement: "P-two has property R." },
        }),
      ),
    ).toMatchObject({ status: 201, outcome: "created", receipt: { event: { publicSeq: 1 } } });
    expect(
      await service.promote(
        promotion({
          workshopId: "W-p1-2",
          idempotencyKey: "idem-p1-2",
          requestDigest: "request-sha256-p1-2",
          publicClaim: { ...promotion().publicClaim, claimId: "C-p1-2", statement: "P-one has property S." },
        }),
      ),
    ).toMatchObject({ status: 201, outcome: "created", receipt: { event: { publicSeq: 2 } } });
    expect((await service.publicLedger("P-one")).publicSeq).toBe(2);
    expect((await service.publicLedger("P-two")).publicSeq).toBe(1);
  });

  test("owner sponsor sees a card while anonymous, cross-sponsor, and absent reads are identical", async () => {
    const service = new SplitService(new MemoryKrater());
    await service.pushWorkshop(
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

    const anonymous = await service.sponsorWorkshopCard({ kind: "anonymous" }, "W-private");
    const crossSponsor = await service.sponsorWorkshopCard(
      { kind: "sponsor", sponsorId: "sponsor-b" },
      "W-private",
    );
    const absent = await service.sponsorWorkshopCard(
      { kind: "sponsor", sponsorId: "sponsor-a" },
      "W-absent",
    );
    const indistinguishable = { status: 404, code: "NOT_FOUND", cacheControl: "no-store" } as const;
    expect(anonymous).toEqual(indistinguishable);
    expect(crossSponsor).toEqual(indistinguishable);
    expect(absent).toEqual(indistinguishable);
    expect(JSON.stringify(crossSponsor)).not.toContain("W-private");
  });
});

describe("S-3 public-surface and private-CAS exclusion", () => {
  test("cache, search, export, and public CAS exclude workshop bodies and private artifact digests", async () => {
    const service = new SplitService(new MemoryKrater());
    const privateBody = "private-cas-canary ".repeat(80);
    await service.pushWorkshop(
      workshop({
        workshopId: "W-spill",
        title: "Private CAS title",
        bodyMd: privateBody,
        privateArtifactDigest: "sha256-private-cas-canary",
      }),
    );

    const sponsorArtifact = await service.sponsorPrivateArtifact(
      { kind: "sponsor", sponsorId: "sponsor-a" },
      "W-spill",
    );
    expect(sponsorArtifact).toEqual({
      status: 200,
      cacheControl: "private, no-store",
      privateArtifactDigest: "sha256-private-cas-canary",
    });

    const cache = await service.publicLedger("P-split");
    const search = await service.searchPublicLedger("P-split", "private-cas-canary");
    const exported = await service.exportPublicLedger("P-split");
    const publicCas = service.publicPrivateArtifact();
    for (const face of [cache, search, exported, publicCas]) {
      const serialized = JSON.stringify(face);
      expect(serialized).not.toContain("private-cas-canary");
      expect(serialized).not.toContain("sha256-private-cas-canary");
      expect(serialized).not.toContain("W-spill");
    }
    expect(cache).toMatchObject({ cacheControl: "public, max-age=10", publicSeq: 0, events: [] });
    expect(search).toMatchObject({ results: [] });
    expect(exported).toMatchObject({ publicSeq: 0, events: [] });
    expect(publicCas).toEqual({ status: 404, code: "NOT_FOUND", cacheControl: "no-store" });
  });

  test("promotion creates a public copy but does not publish its private workshop artifact", async () => {
    const service = new SplitService(new MemoryKrater());
    await service.pushWorkshop(
      workshop({
        workshopId: "W-promoted-spill",
        bodyMd: "private artifact canary ".repeat(80),
        privateArtifactDigest: "sha256-private-after-promotion",
      }),
    );
    const result = await service.promote(promotion({ workshopId: "W-promoted-spill" }));
    expect(result).toMatchObject({ status: 201, outcome: "created" });

    const publicFace = await service.publicLedger("P-split");
    expect(eventIds(publicFace.events)).toEqual(["E-1"]);
    expect(JSON.stringify(publicFace)).not.toContain("private-after-promotion");
    expect(service.publicPrivateArtifact()).toEqual({
      status: 404,
      code: "NOT_FOUND",
      cacheControl: "no-store",
    });
  });
});

describe("S-3 promotion validator", () => {
  test("refuses self-certification with the S-3 P2/P4 contract error", async () => {
    const service = new SplitService(new MemoryKrater());
    await service.pushWorkshop(workshop());

    const result = await service.promote(
      promotion({
        publicClaim: { ...promotion().publicClaim, candidate: { disposition: "proved" } },
      }),
    );
    expect(result).toEqual({
      status: 422,
      code: "SCHEMA_INVALID",
      rule: "P2/P4",
      fixHint:
        "Remove author-writable disposition, proof, confidence, or certification fields; the ledger computes disposition after independent review.",
      nextAction: "remove_authoritative_fields",
    });
    expect(await service.publicLedger("P-split")).toMatchObject({ publicSeq: 0, events: [] });
  });

  test("refuses an NFKC-equivalent open claim with P11 and the existing ID", async () => {
    const service = new SplitService(new MemoryKrater());
    const firstStatement = "Caf\u00e9 $x  + y$ has property Q.";
    const equivalentStatement = "Cafe\u0301 $x + y$ has property Q.";
    expect(await normHash(firstStatement)).toBe(await normHash(equivalentStatement));

    await service.pushWorkshop(workshop({ workshopId: "W-first" }));
    expect(
      await service.promote(
        promotion({
          workshopId: "W-first",
          publicClaim: { ...promotion().publicClaim, claimId: "C-41", statement: firstStatement },
        }),
      ),
    ).toMatchObject({ status: 201, outcome: "created" });

    await service.pushWorkshop(workshop({ workshopId: "W-second" }));
    const duplicate = await service.promote(
      promotion({
        workshopId: "W-second",
        idempotencyKey: "idem-duplicate",
        requestDigest: "request-sha256-duplicate",
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
  test("replays the same idempotency key, rejects a changed digest, and never makes a second public event", async () => {
    const service = new SplitService(new MemoryKrater());
    await service.pushWorkshop(workshop());
    const input = promotion();

    const created = await service.promote(input);
    const replayed = await service.promote(input);
    const conflict = await service.promote({ ...input, requestDigest: "request-sha256-different" });
    const secondKey = await service.promote({
      ...input,
      idempotencyKey: "idem-promote-2",
      requestDigest: "request-sha256-second-key",
    });

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
      publicEventId: "E-1",
    });
    expect(eventIds((await service.publicLedger("P-split")).events)).toEqual(["E-1"]);
  });

  test("a disconnect after the committed transaction is recovered only by the same idempotency key", async () => {
    const krater = new MemoryKrater();
    const service = new SplitService(krater);
    await service.pushWorkshop(workshop());
    const input = promotion();
    krater.armDisconnectAfterCommit();

    await expect(service.promote(input)).rejects.toBeInstanceOf(PromotionCommitUnknownError);
    const recovered = await service.promote(input);
    expect(recovered).toMatchObject({ status: 200, outcome: "replayed" });
    expect(eventIds((await service.publicLedger("P-split")).events)).toEqual(["E-1"]);
  });
});

describe("S-3 planted negative", () => {
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
});
