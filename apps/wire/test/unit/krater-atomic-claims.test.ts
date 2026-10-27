import { describe, expect, test } from "bun:test";
import {
  canonicalClaimPayload,
  canonicalJson,
  canonicalRevisionPayload,
  claimCreationProjection,
  claimRevisionProjection,
  eventChainMatches,
  inspectProblem,
  type KraterAtomicSettlement,
  type KraterLedgerBatchMember,
  type KraterLedgerEventInput,
  type KraterRevisionInput,
  type KraterWriteInput,
  readAllEvents,
  readCheckpoints,
  readClaimProjections,
  sha256Hex,
  writeClaim,
  writeClaimRevision,
  writeLedgerBatch,
} from "../../src/krater/krater";
import { mintClaimVersion } from "../../src/krater/claim-version";
import {
  FELLOW,
  NOW,
  OTHER,
  PROBLEM,
  publicationContextFixture,
  SESSION,
  SPONSOR,
} from "../support/publication-context";

type Fixture = Awaited<ReturnType<typeof publicationContextFixture>>;
type DynamicMember = KraterLedgerBatchMember & {
  resolveForAttempt: NonNullable<KraterLedgerBatchMember["resolveForAttempt"]>;
};

// These are unit tests against all migrations in real SQLite transactions.
// The public validator/screening/Worker binding lane is exercised separately.
async function usingFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const fixture = await publicationContextFixture();
  try {
    fixture.sql.exec(`CREATE TABLE atomic_test_receipts (
      receipt_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES events(id),
      body_json TEXT NOT NULL CHECK (json_valid(body_json))
    )`);
    await run(fixture);
  } finally {
    fixture.sql.close();
  }
}

function claimInput(name: string, statement = `Claim ${name} has an exact statement.`): KraterWriteInput {
  return {
    problemId: PROBLEM,
    claimId: "C-1",
    eventId: `E-ATOMIC-${name}`,
    idempotencyKey: `key-atomic-${name}`,
    statement,
    claimVersion: { kind: "conjecture", falsifier: "Find a counterexample." },
    createdAt: NOW(),
    attribution: {
      fellowId: FELLOW,
      sponsorId: SPONSOR,
      sessionId: SESSION,
      modelSelfDeclared: "model",
      harness: "harness",
    },
  };
}

function claimMember(fixture: Fixture, name: string, createdAt = NOW()): DynamicMember {
  const original = { ...claimInput(name), createdAt };
  const resolve = (input: KraterLedgerEventInput, sequence: number) => {
    const claim = { ...original, claimId: `C-${sequence}`, createdAt: input.createdAt };
    return {
      input: {
        ...input,
        objectId: claim.claimId,
        payloadJson: canonicalClaimPayload({
          claimId: claim.claimId,
          kind: "conjecture",
          statement: claim.statement,
          falsifier: "Find a counterexample.",
        }),
      },
      projection: claimCreationProjection(fixture.db, claim),
    };
  };
  const initial = resolve(
    {
      ...fixture.command(fixture.input(), undefined, original.eventId).input,
      idempotencyKey: original.idempotencyKey,
      eventType: "claim.created",
      objectKind: "claim",
      objectId: "C-1",
      objectVersion: 1,
      createdAt: original.createdAt,
    },
    1,
  );
  return {
    ...initial,
    causedByEventIds: [],
    resolveForAttempt: ({ input, sequence }) => resolve(input, sequence),
  };
}

function dependentEvidence(
  fixture: Fixture,
  parent: KraterLedgerBatchMember,
  name = "evidence",
): DynamicMember {
  const original = fixture.command(fixture.input(), undefined, `E-ATOMIC-${name}`);
  const input = {
    ...original.input,
    eventType: "evidence.created",
    objectKind: "evidence",
    objectId: `E-object-${name}`,
    payloadJson: canonicalJson({
      bears_on_kind: "claim",
      bears_on_id: "C-1",
      bears_on_version: 1,
      body_md: "The literal tmp:claim in this explanation is not an object reference.",
    }),
  };
  return {
    ...original,
    input,
    causedByEventIds: [parent.input.eventId],
    resolveForAttempt: ({ input: current, preceding }) => {
      const claim = preceding.find((settlement) => settlement.eventId === parent.input.eventId);
      if (!claim) throw new Error("The claim must precede its evidence.");
      return {
        input: {
          ...current,
          payloadJson: canonicalJson({
            ...JSON.parse(current.payloadJson),
            bears_on_id: claim.claimId,
          }),
        },
        projection: original.projection,
      };
    },
  };
}

function receipt(
  fixture: Fixture,
  settlements: readonly KraterAtomicSettlement[],
  name = "outer",
) {
  const last = settlements.at(-1);
  if (!last) throw new Error("A receipt needs a committed member.");
  return [
    fixture.db
      .prepare(
        "INSERT INTO atomic_test_receipts(receipt_id,event_id,body_json) VALUES(?,?,?)",
      )
      .bind(
        name,
        last.eventId,
        canonicalJson(settlements.map(({ eventId, claimId, sequence }) => ({
          event_id: eventId,
          object_id: claimId,
          seq: sequence,
        }))),
      ),
  ];
}

function content(fixture: Fixture, eventId: string) {
  const row = fixture.sql
    .query("SELECT payload_json FROM event_content WHERE event_id=?")
    .get(eventId) as { payload_json: string } | null;
  if (!row) throw new Error("Missing immutable event content.");
  return JSON.parse(row.payload_json) as Record<string, unknown>;
}

describe("atomic sequence-derived claims", () => {
  test("ordinary promotion preserves canonical bytes, replay, projections and sidecars", () =>
    usingFixture(async (fixture) => {
      const input = claimInput("ordinary");
      const expectedBytes = canonicalClaimPayload({
        claimId: "C-1",
        kind: "conjecture",
        statement: input.statement,
        falsifier: "Find a counterexample.",
      });
      const first = await writeClaim(fixture.db, input);
      const beforeReplay = await inspectProblem(fixture.db, PROBLEM);
      const replay = await writeClaim(fixture.db, { ...input, eventId: "E-ordinary-retry" });
      expect(first.idempotent).toBe(false);
      expect(replay.idempotent).toBe(true);
      expect(replay.eventId).toBe(first.eventId);
      expect(replay.payloadSha256).toBe(await sha256Hex(expectedBytes));
      expect(content(fixture, first.eventId)).not.toHaveProperty("caused_by");
      expect(fixture.sql.query("SELECT payload_json FROM event_content WHERE event_id=?").get(first.eventId))
        .toEqual({ payload_json: expectedBytes });
      expect(await inspectProblem(fixture.db, PROBLEM)).toEqual(beforeReplay);
      expect(beforeReplay).toMatchObject({
        claims: 1,
        claim_projections: 1,
        events: 1,
        event_chain_v2: 1,
        event_content: 1,
        idempotency: 1,
        outbox: 1,
        integrity_checkpoints: 1,
        checkpoint_chain_v2: 1,
      });
      const events = await readAllEvents(fixture.db, PROBLEM);
      expect(await eventChainMatches(events)).toBe(true);
      expect(await readClaimProjections(fixture.db, PROBLEM)).toEqual([
        {
          claimId: "C-1",
          problemId: PROBLEM,
          sourceSeq: 1,
          projectionVersion: 1,
          buildDigest: first.rowDigest,
          stale: false,
        },
      ]);
      expect((await readCheckpoints(fixture.db, PROBLEM))[0]?.rootChainDigest)
        .toBe(first.chainDigest);
      expect(fixture.sql.query("PRAGMA foreign_key_check").all()).toEqual([]);
    }));

  test("resolves typed claim references and commits the final receipt with the public prefix", () =>
    usingFixture(async (fixture) => {
      const claim = claimMember(fixture, "claim");
      const evidence = dependentEvidence(fixture, claim);
      const settlements = await writeLedgerBatch(
        fixture.db,
        [claim, evidence],
        (settled) => receipt(fixture, settled),
      );
      expect(settlements.map(({ claimId, sequence }) => [claimId, sequence]))
        .toEqual([["C-1", 1], ["E-object-evidence", 2]]);
      expect(content(fixture, claim.input.eventId)).toMatchObject({
        claim_id: "C-1",
        caused_by: [],
      });
      expect(content(fixture, evidence.input.eventId)).toMatchObject({
        bears_on_id: "C-1",
        bears_on_version: 1,
        body_md: "The literal tmp:claim in this explanation is not an object reference.",
        caused_by: [{
          scope: "problem",
          scope_id: PROBLEM,
          event_id: claim.input.eventId,
          seq: 1,
        }],
      });
      expect(fixture.sql.query("SELECT id,source_seq FROM claims").all())
        .toEqual([{ id: "C-1", source_seq: 1 }]);
      expect(fixture.sql.query("SELECT event_id FROM atomic_test_receipts").all())
        .toEqual([{ event_id: evidence.input.eventId }]);
      // Both existing evidence delivery triggers run inside the same transaction.
      expect(fixture.sql.query("SELECT event_id FROM inbox_event_deliveries").all())
        .toEqual([{ event_id: evidence.input.eventId }]);
      expect(fixture.sql.query("SELECT event_id FROM disposition_change_deliveries").all())
        .toEqual([{ event_id: evidence.input.eventId }]);
      expect(await eventChainMatches(await readAllEvents(fixture.db, PROBLEM))).toBe(true);
      expect((await readCheckpoints(fixture.db, PROBLEM)).length).toBe(2);
      expect(fixture.sql.query("PRAGMA foreign_key_check").all()).toEqual([]);
    }));

  test("a lost head race re-resolves claim identity, evidence target and causal sequence", () =>
    usingFixture(async (fixture) => {
      const claim = claimMember(fixture, "raced");
      const evidence = dependentEvidence(fixture, claim);
      const attemptedSequences: number[] = [];
      const raced: DynamicMember = {
        ...claim,
        resolveForAttempt: (attempt) => {
          attemptedSequences.push(attempt.sequence);
          return claim.resolveForAttempt(attempt);
        },
      };
      let racedOnce = false;
      const settlements = await writeLedgerBatch(
        fixture.db,
        [raced, evidence],
        (settled) => receipt(fixture, settled),
        {
          afterReadHead: async () => {
            if (racedOnce) return;
            racedOnce = true;
            await writeClaim(fixture.db, claimInput("winner"));
          },
        },
      );
      expect(attemptedSequences).toEqual([1, 2]);
      expect(settlements.map(({ sequence }) => sequence)).toEqual([2, 3]);
      expect(content(fixture, claim.input.eventId).claim_id).toBe("C-2");
      expect(content(fixture, evidence.input.eventId)).toMatchObject({
        bears_on_id: "C-2",
        caused_by: [{
          scope: "problem",
          scope_id: PROBLEM,
          event_id: claim.input.eventId,
          seq: 2,
        }],
      });
      expect(fixture.sql.query("SELECT id,source_seq FROM claims ORDER BY source_seq").all())
        .toEqual([{ id: "C-1", source_seq: 1 }, { id: "C-2", source_seq: 2 }]);
      expect(await eventChainMatches(await readAllEvents(fixture.db, PROBLEM))).toBe(true);
    }));

  test("a failed final receipt rolls back claims, delivery queues, sidecars and replay rows", () =>
    usingFixture(async (fixture) => {
      fixture.sql.exec(`CREATE TRIGGER atomic_receipt_failure
        BEFORE INSERT ON atomic_test_receipts WHEN NEW.receipt_id = 'outer'
        BEGIN SELECT RAISE(ABORT, 'ATOMIC_FINAL_RECEIPT_REFUSED'); END`);
      const claim = claimMember(fixture, "rollback");
      const evidence = dependentEvidence(fixture, claim);
      const before = await inspectProblem(fixture.db, PROBLEM);
      const headBefore = fixture.state().head;
      await expect(writeLedgerBatch(
        fixture.db,
        [claim, evidence],
        (settled) => receipt(fixture, settled),
      )).rejects.toThrow("ATOMIC_FINAL_RECEIPT_REFUSED");
      expect(await inspectProblem(fixture.db, PROBLEM)).toEqual(before);
      expect(fixture.state().head).toEqual(headBefore);
      expect(fixture.sql.query("SELECT event_id FROM inbox_event_deliveries").all()).toEqual([]);
      expect(fixture.sql.query("SELECT event_id FROM disposition_change_deliveries").all()).toEqual([]);
      fixture.sql.exec("DROP TRIGGER atomic_receipt_failure");
      const committed = await writeLedgerBatch(
        fixture.db,
        [claim, evidence],
        (settled) => receipt(fixture, settled),
      );
      expect(committed.map(({ sequence }) => sequence)).toEqual([1, 2]);
    }));

  test("a refused later member cannot leave the earlier claim committed", () =>
    usingFixture(async (fixture) => {
      const claim = claimMember(fixture, "guarded-prefix");
      const later = fixture.command(fixture.input(), undefined, "E-ATOMIC-refused");
      const before = await inspectProblem(fixture.db, PROBLEM);
      await expect(writeLedgerBatch(
        fixture.db,
        [claim, {
          ...later,
          projection: {
            preconditionSql: " AND 0",
            statementsAfterEvent: () => [],
          },
        }],
        (settled) => receipt(fixture, settled),
      )).rejects.toThrow();
      expect(await inspectProblem(fixture.db, PROBLEM)).toEqual(before);
      expect(fixture.sql.query("SELECT receipt_id FROM atomic_test_receipts").all()).toEqual([]);
    }));

  test("retains post-screen time and the outer screening/receipt companion", () =>
    usingFixture(async (fixture) => {
      const original = claimMember(
        fixture,
        "screened",
        new Date(Date.now() - 1000).toISOString(),
      );
      const finalTime = NOW();
      const observed: string[] = [];
      const claim: DynamicMember = {
        ...original,
        input: { ...original.input, createdAt: finalTime },
        companion: {
          statementsAfterIdempotencySettlement: (settlement) =>
            receipt(fixture, [settlement], "screened"),
        },
        resolveForAttempt: (attempt) => {
          observed.push(attempt.input.createdAt);
          return original.resolveForAttempt(attempt);
        },
      };
      await writeLedgerBatch(
        fixture.db,
        [claim],
        (settled) => receipt(fixture, settled),
        {},
        { allowSingleMember: true },
      );
      expect(observed).toEqual([finalTime]);
      expect(fixture.sql.query("SELECT created_at FROM claims").get())
        .toEqual({ created_at: finalTime });
      expect(fixture.sql.query("SELECT receipt_id FROM atomic_test_receipts ORDER BY receipt_id").all())
        .toEqual([{ receipt_id: "outer" }, { receipt_id: "screened" }]);
      expect(fixture.sql.query("SELECT created_at FROM events").get())
        .toEqual({ created_at: finalTime });
    }));

  for (const [field, value] of [
    ["eventId", "E-replaced"],
    ["idempotencyKey", "replacement-key"],
    ["requestDigest", "b".repeat(64)],
    ["createdAt", "2020-01-01T00:00:00.000Z"],
  ] as const) {
    test(`rejects resolver changes to stable ${field}`, () =>
      usingFixture(async (fixture) => {
        const original = claimMember(fixture, "stable");
        const member: DynamicMember = {
          ...original,
          resolveForAttempt: async (attempt) => {
            const resolved = await original.resolveForAttempt(attempt);
            return { ...resolved, input: { ...resolved.input, [field]: value } };
          },
        };
        const before = await inspectProblem(fixture.db, PROBLEM);
        await expect(writeLedgerBatch(
          fixture.db,
          [member],
          () => [],
          {},
          { allowSingleMember: true },
        )).rejects.toThrow("stable event identity");
        expect(await inspectProblem(fixture.db, PROBLEM)).toEqual(before);
      }));
  }

  test("rejects changed attribution and resolver-supplied causal metadata", () =>
    usingFixture(async (fixture) => {
      const original = claimMember(fixture, "authority");
      const before = await inspectProblem(fixture.db, PROBLEM);
      for (const alter of ["attribution", "causes"]) {
        const member: DynamicMember = {
          ...original,
          resolveForAttempt: async (attempt) => {
            const resolved = await original.resolveForAttempt(attempt);
            if (resolved.input.attribution.principalType !== undefined)
              throw new Error("Expected Fellow claim attribution");
            return {
              ...resolved,
              input: {
                ...resolved.input,
                ...(alter === "attribution"
                  ? { attribution: { ...resolved.input.attribution, sponsorId: "usr_other" } }
                  : { payloadJson: canonicalJson({
                      ...JSON.parse(resolved.input.payloadJson),
                      caused_by: [],
                    }) }),
              },
            };
          },
        };
        await expect(writeLedgerBatch(
          fixture.db,
          [member],
          () => [],
          {},
          { allowSingleMember: true },
        )).rejects.toThrow(alter === "attribution" ? "stable event identity" : "causal metadata");
        expect(await inspectProblem(fixture.db, PROBLEM)).toEqual(before);
      }
    }));

  test("causal metadata cannot make a payload exceed the public ingress byte ceiling", () =>
    usingFixture(async (fixture) => {
      const original = fixture.command(fixture.input(), undefined, "E-ATOMIC-large");
      const payloadJson = canonicalJson({ body: "x".repeat(512 * 1024 - 11) });
      expect(new TextEncoder().encode(payloadJson).byteLength).toBe(512 * 1024);
      const before = await inspectProblem(fixture.db, PROBLEM);
      await expect(writeLedgerBatch(
        fixture.db,
        [{ ...original, input: { ...original.input, payloadJson } }],
        () => [],
        {},
        { allowSingleMember: true },
      )).rejects.toThrow("ingress byte limit");
      expect(await inspectProblem(fixture.db, PROBLEM)).toEqual(before);
    }));

  test("singleton close is opt-in and the full sixteen-claim boundary remains atomic", () =>
    usingFixture(async (fixture) => {
      const members = Array.from({ length: 16 }, (_, index) =>
        claimMember(fixture, `boundary-${index}`));
      await expect(writeLedgerBatch(fixture.db, members.slice(0, 1), () => []))
        .rejects.toThrow("two through sixteen");
      await expect(writeLedgerBatch(fixture.db, [], () => [], {}, { allowSingleMember: true }))
        .rejects.toThrow("one through sixteen");
      await expect(writeLedgerBatch(
        fixture.db,
        [...members, claimMember(fixture, "overflow")],
        () => [],
      )).rejects.toThrow("two through sixteen");
      const settled = await writeLedgerBatch(
        fixture.db,
        members,
        (values) => receipt(fixture, values),
      );
      expect(settled.map(({ claimId }) => claimId))
        .toEqual(Array.from({ length: 16 }, (_, index) => `C-${index + 1}`));
      expect(await inspectProblem(fixture.db, PROBLEM)).toMatchObject({
        claims: 16,
        claim_projections: 16,
        events: 16,
        event_chain_v2: 16,
        event_content: 16,
        idempotency: 16,
        outbox: 16,
        integrity_checkpoints: 16,
        checkpoint_chain_v2: 16,
      });
      expect(await eventChainMatches(await readAllEvents(fixture.db, PROBLEM))).toBe(true);
      expect(fixture.sql.query("PRAGMA foreign_key_check").all()).toEqual([]);
    }));
});

async function seedRevisionClaim(fixture: Fixture): Promise<void> {
  const input = claimInput("revision-seed");
  const version = await mintClaimVersion({
    currentVersion: 0,
    newContent: { kind: "conjecture", statement: input.statement, falsifier: "Find a counterexample." },
    editorFellowId: FELLOW,
    sha256Hex,
  });
  await writeClaim(fixture.db, input, {}, {
    statementsAfterIdempotencySettlement: (settled) => [
      fixture.db.prepare(`INSERT INTO claim_versions
        (claim_id,problem_id,version,kind,statement,falsifier,content_digest,editor_fellow_id,created_at)
        SELECT e.object_id,e.problem_id,1,'conjecture',?,?,?,?,e.created_at
        FROM events e WHERE e.id=?`)
        .bind(input.statement, "Find a counterexample.", version.contentDigest, FELLOW, settled.eventId),
    ],
  });
}

async function revisionInput(name: string, baseVersion = 1, fellowId = FELLOW): Promise<KraterRevisionInput> {
  const statement = `Exact replacement ${name}.`;
  const mint = await mintClaimVersion({
    currentVersion: baseVersion,
    newContent: { kind: "conjecture", statement, falsifier: "Find a replacement counterexample." },
    editorFellowId: fellowId,
    sha256Hex,
  });
  return {
    problemId: PROBLEM,
    claimId: "C-1",
    eventId: `E-REVISION-${name}`,
    idempotencyKey: `key-revision-${name}`,
    baseVersion,
    newVersion: mint.version,
    kind: "conjecture",
    statement,
    falsifier: "Find a replacement counterexample.",
    contentDigest: mint.contentDigest,
    editorFellowId: fellowId,
    normHash: await sha256Hex(statement.toLowerCase()),
    createdAt: NOW(),
    attribution: {
      fellowId, sponsorId: SPONSOR, sessionId: SESSION,
      modelSelfDeclared: "model", harness: "harness",
    },
  };
}

function revisionMember(fixture: Fixture, input: KraterRevisionInput): KraterLedgerBatchMember {
  return {
    input: {
      problemId: input.problemId,
      eventId: input.eventId,
      idempotencyKey: input.idempotencyKey,
      requestDigest: "a".repeat(64),
      eventType: "claim.revised",
      objectKind: "claim",
      objectId: input.claimId,
      objectVersion: input.newVersion,
      payloadJson: canonicalRevisionPayload(input),
      createdAt: input.createdAt,
      attribution: input.attribution!,
    },
    projection: claimRevisionProjection(fixture.db, input),
    causedByEventIds: [],
  };
}

function revisionLease(
  fixture: Fixture,
  name: string,
  fellowId = OTHER,
  parallelSafe = 0,
  expired = false,
  status = "active",
): void {
  const now = NOW();
  const sessionId = fellowId === FELLOW ? SESSION : "S-OTHER";
  fixture.sql.query(`INSERT OR IGNORE INTO sessions
    (session_id,fellow_id,problem_id,opened_at,last_heartbeat_at,idle_close_at)
    VALUES(?,?,?,?,?,?)`)
    .run(sessionId, fellowId, PROBLEM, now, now, new Date(Date.now() + 60_000).toISOString());
  fixture.sql.query(`INSERT INTO leases
    (lease_id,problem_id,object_ref,object_kind,object_id,session_id,fellow_id,sponsor_id,
     objective,deliverable,parallel_safe,status,leased_at,leased_until,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(`L-${name}`, PROBLEM, "C-1", "claim", "C-1", sessionId, fellowId, SPONSOR,
      "Revise the exact claim.", "Publish a replacement.", parallelSafe, status, now,
      new Date(Date.now() + (expired ? -60_000 : 60_000)).toISOString(), now, now);
}

describe("shared atomic claim revisions", () => {
  test("ordinary revisions preserve immutable versions and replay without mutating the projection", () =>
    usingFixture(async (fixture) => {
      await seedRevisionClaim(fixture);
      const input = await revisionInput("ordinary");
      const first = await writeClaimRevision(fixture.db, input);
      expect(first).toMatchObject({ claimId: "C-1", seq: 2, idempotent: false, retryCount: 0 });
      expect(first.buildDigest).toBe(first.rowDigest);
      expect(fixture.sql.query("SELECT version,content_digest FROM claim_versions ORDER BY version").all())
        .toHaveLength(2);
      expect(fixture.sql.query("SELECT content_digest FROM claim_versions WHERE version=2").get())
        .toEqual({ content_digest: input.contentDigest });
      expect(fixture.sql.query("SELECT statement,source_seq FROM claims WHERE id='C-1'").get())
        .toEqual({ statement: input.statement, source_seq: 2 });
      const before = await inspectProblem(fixture.db, PROBLEM);
      const projections = await readClaimProjections(fixture.db, PROBLEM);
      // A completed replay remains readable after mutable lease authority changes.
      revisionLease(fixture, "after-completion");
      const replay = await writeClaimRevision(fixture.db, { ...input, eventId: "E-REVISION-replay" });
      expect(replay).toMatchObject({ eventId: first.eventId, seq: first.seq, idempotent: true });
      expect(await inspectProblem(fixture.db, PROBLEM)).toEqual(before);
      expect(await readClaimProjections(fixture.db, PROBLEM)).toEqual(projections);
      expect(fixture.sql.query("SELECT event_id FROM outbox WHERE event_id=?").all(first.eventId))
        .toEqual([{ event_id: first.eventId }]);
      expect(await eventChainMatches(await readAllEvents(fixture.db, PROBLEM))).toBe(true);
      expect(fixture.sql.query("PRAGMA foreign_key_check").all()).toEqual([]);
    }));

  test("a foreign exclusive lease acquired after preparation rolls back the complete batch", () =>
    usingFixture(async (fixture) => {
      await seedRevisionClaim(fixture);
      revisionLease(fixture, "own", FELLOW);
      const input = await revisionInput("lease-race");
      const member = revisionMember(fixture, input);
      const later = fixture.command(fixture.input(), undefined, "E-REVISION-after-lease");
      const before = await inspectProblem(fixture.db, PROBLEM);
      let acquired = false;
      await expect(writeLedgerBatch(fixture.db, [member, later], (values) => receipt(fixture, values), {
        afterReadHead: async () => {
          if (acquired) return;
          acquired = true;
          revisionLease(fixture, "foreign");
        },
      })).rejects.toThrow();
      expect(acquired).toBe(true);
      expect(await inspectProblem(fixture.db, PROBLEM)).toEqual(before);
      expect(fixture.sql.query("SELECT version FROM claim_versions ORDER BY version").all())
        .toEqual([{ version: 1 }]);
      expect(fixture.sql.query("SELECT receipt_id FROM atomic_test_receipts").all()).toEqual([]);
    }));

  test.each([
    { name: "own", fellow: FELLOW, parallel: 0, expired: false, status: "active" },
    { name: "parallel", fellow: OTHER, parallel: 1, expired: false, status: "active" },
    { name: "expired", fellow: OTHER, parallel: 0, expired: true, status: "active" },
    { name: "released", fellow: OTHER, parallel: 0, expired: false, status: "released" },
  ])("does not block a revision for a $name lease", ({ name, fellow, parallel, expired, status }) =>
    usingFixture(async (fixture) => {
      await seedRevisionClaim(fixture);
      revisionLease(fixture, name, fellow, parallel, expired, status);
      const result = await writeClaimRevision(fixture.db, await revisionInput(name));
      expect(result).toMatchObject({ seq: 2, idempotent: false });
      expect(fixture.sql.query("PRAGMA foreign_key_check").all()).toEqual([]);
    }));

  test.each([
    { name: "future-base", base: 3, fellow: FELLOW },
    { name: "foreign-author", base: 1, fellow: OTHER },
  ])("refuses a $name before any revision effect", ({ name, base, fellow }) =>
    usingFixture(async (fixture) => {
      await seedRevisionClaim(fixture);
      const before = await inspectProblem(fixture.db, PROBLEM);
      await expect(writeClaimRevision(fixture.db, await revisionInput(name, base, fellow)))
        .rejects.toThrow("base, author, or exclusive lease");
      expect(await inspectProblem(fixture.db, PROBLEM)).toEqual(before);
      expect(fixture.sql.query("SELECT version FROM claim_versions").all()).toEqual([{ version: 1 }]);
    }));

  test("derives created and revised semantic digests from content for pending scientific folds", () =>
    usingFixture(async (fixture) => {
      await seedRevisionClaim(fixture);
      const input = await revisionInput("pending-digest");
      const revision = revisionMember(fixture, input);
      const claim = claimMember(fixture, "pending-created");
      const settled = await writeLedgerBatch(fixture.db, [{
        ...revision,
        input: { ...revision.input, payloadJson: canonicalJson({
          ...JSON.parse(revision.input.payloadJson), content_digest: `sha256:${"0".repeat(64)}`,
        }) },
      }, claim], (values) => receipt(fixture, values));
      const expectedCreated = await mintClaimVersion({
        currentVersion: 0,
        newContent: {
          kind: "conjecture",
          statement: claimInput("pending-created").statement,
          falsifier: "Find a counterexample.",
        },
        editorFellowId: FELLOW,
        sha256Hex,
      });
      expect(settled[0]?.event?.contentDigest).toBe(input.contentDigest);
      expect(settled[1]?.event?.contentDigest).toBe(expectedCreated.contentDigest);
      expect(fixture.sql.query("SELECT content_digest FROM claim_versions WHERE version=2").get())
        .toEqual({ content_digest: input.contentDigest });
      expect(await eventChainMatches(await readAllEvents(fixture.db, PROBLEM))).toBe(true);
    }));

  test("a late receipt failure restores the old claim and all immutable sidecars", () =>
    usingFixture(async (fixture) => {
      await seedRevisionClaim(fixture);
      const input = await revisionInput("late-failure");
      const member = revisionMember(fixture, input);
      const later = fixture.command(fixture.input(), undefined, "E-REVISION-late-tail");
      const before = await inspectProblem(fixture.db, PROBLEM);
      const oldClaim = fixture.sql.query("SELECT * FROM claims").all();
      fixture.sql.exec(`CREATE TRIGGER revision_final_receipt_failure
        BEFORE INSERT ON atomic_test_receipts
        BEGIN SELECT RAISE(ABORT, 'REVISION_FINAL_RECEIPT_FAILED'); END`);
      await expect(writeLedgerBatch(fixture.db, [member, later], (values) => receipt(fixture, values)))
        .rejects.toThrow("REVISION_FINAL_RECEIPT_FAILED");
      expect(await inspectProblem(fixture.db, PROBLEM)).toEqual(before);
      expect(fixture.sql.query("SELECT * FROM claims").all()).toEqual(oldClaim);
      expect(fixture.sql.query("SELECT version FROM claim_versions").all()).toEqual([{ version: 1 }]);
      expect(fixture.sql.query("SELECT event_id FROM disposition_change_deliveries").all()).toEqual([]);
      expect(fixture.sql.query("PRAGMA foreign_key_check").all()).toEqual([]);
    }));
});
