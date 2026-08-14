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
  readonly privateArtifacts: Map<string, string>;
  readonly publicArtifacts: Map<string, string>;
  readonly publicArtifactBindings: Map<string, string>;
}

const workshopScope = (key: WorkshopKey): string => `${key.problemId}\u0000${key.fellowId}`;
const claimScope = (problemId: string, normalizedHash: string): string =>
  `${problemId}\u0000${normalizedHash}`;
const idempotencyScope = (scope: IdempotencyScope, key: string): string =>
  `${scope.principalId}\u0000${scope.sessionId}\u0000${scope.operation}\u0000${scope.problemId}\u0000${key}`;

function emptyState(): MemoryState {
  return {
    publicSeq: new Map(),
    workshopSeq: new Map(),
    workshops: new Map(),
    publicEvents: new Map(),
    openClaims: new Map(),
    idempotency: new Map(),
    privateArtifacts: new Map(),
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
    privateArtifacts: new Map(state.privateArtifacts),
    publicArtifacts: new Map(state.publicArtifacts),
    publicArtifactBindings: new Map(state.publicArtifactBindings),
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

  getPrivateArtifact(privateArtifactDigest: string): { readonly bodyMd: string } | undefined {
    const bodyMd = this.state.privateArtifacts.get(privateArtifactDigest);
    return bodyMd === undefined ? undefined : { bodyMd };
  }

  copyPrivateArtifactToPublic(
    privateArtifactDigest: string,
    publicArtifactId: string,
  ): { readonly id: string; readonly bodyMd: string } | undefined {
    const bodyMd = this.state.privateArtifacts.get(privateArtifactDigest);
    return bodyMd === undefined ? undefined : { id: publicArtifactId, bodyMd };
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

  armDisconnectAfterCommit(): void {
    this.disconnectAfterNextCommit = true;
  }

  seedPrivateArtifact(digest: string, bodyMd: string): void {
    this.state.privateArtifacts.set(digest, bodyMd);
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

class TestIds {
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
  return new SplitService(krater, new TestIds());
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
});

describe("S-3 public-surface and private-CAS exclusion", () => {
  test("cache, search, export, and public CAS exclude workshop bodies and private artifact digests", async () => {
    const krater = new MemoryKrater();
    const service = splitService(krater);
    const privateBody = "private-cas-canary ".repeat(80);
    krater.seedPrivateArtifact("sha256-private-cas-canary", privateBody);
    await service.pushWorkshop(
      FELLOW_A,
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
    const publicCas = await service.publicArtifact("sha256-private-cas-canary");
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

  test("private bytes become public only after promotion then verified public binding", async () => {
    const krater = new MemoryKrater();
    const service = splitService(krater);
    const privateBody = "private artifact canary ".repeat(80);
    krater.seedPrivateArtifact("sha256-private-after-promotion", privateBody);
    await service.pushWorkshop(
      FELLOW_A,
      workshop({
        workshopId: "W-promoted-spill",
        bodyMd: privateBody,
        privateArtifactDigest: "sha256-private-after-promotion",
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
    expect(await service.publicArtifact("sha256-private-after-promotion")).toEqual({
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
        "Remove author-writable disposition, proof, confidence, or certification fields; the ledger computes disposition after independent review.",
      nextAction: "remove_authoritative_fields",
    });
    expect(await service.publicLedger("P-split")).toMatchObject({ publicSeq: 0, events: [] });
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
});
