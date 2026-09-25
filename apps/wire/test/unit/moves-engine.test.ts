import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { HelloAssignment, MoveKind, MoveTemplate } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import type { FellowCredentialBinding } from "../../src/enrollment/service.ts";
import { selectBackToObjectMove } from "../../src/mega-commands/back-to-object-moves.ts";
import { selectNormalizeConflictMove } from "../../src/mega-commands/conflict-moves.ts";
import { selectRecordDeadEndMove } from "../../src/mega-commands/dead-end-moves.ts";
import { selectDiscriminateMove } from "../../src/mega-commands/discriminate-moves.ts";
import { selectCollapseDuplicateMove } from "../../src/mega-commands/duplicate-moves.ts";
import { selectFormalizeMove } from "../../src/mega-commands/formalize-moves.ts";
import { selectIdleCloseMove } from "../../src/mega-commands/idle-close-moves.ts";
import { selectKillOrStandMove } from "../../src/mega-commands/kill-moves.ts";
import {
  compareMovePriority,
  LedgerMovesProvider,
  MOVE_PRIORITY_TIER,
} from "../../src/mega-commands/live-provider.ts";
import {
  filterMovesByPermissions,
  PROMOTION_MOVE_KINDS,
  TruthfulProductionMovesProvider,
} from "../../src/mega-commands/provider.ts";
import { selectReanchorMove } from "../../src/mega-commands/reanchor-moves.ts";
import { selectSharpenStatementMove } from "../../src/mega-commands/sharpen-moves.ts";
import { selectSynthesizeMove } from "../../src/mega-commands/synthesize-moves.ts";

function createMockDb(sqlite: Database): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind: (...values: unknown[]) => ({
          first: async <T>() => (sqlite.query(sql).get(...(values as any[])) ?? null) as T | null,
          all: async <T>() => ({
            results: sqlite.query(sql).all(...(values as any[])) as T[],
          }),
        }),
      };
    },
  } as unknown as D1Database;
}

const mockCredential = {
  fellowId: "F-EXPLORER",
  credentialId: "FC-EXPLORER",
  sponsorId: "SP-EXPLORER",
  fellowStatus: "active",
  grantedScopes: ["promote", "review"],
  grantedResources: {},
  issuedAt: 1,
  expiresAt: 999999,
} as unknown as FellowCredentialBinding;

describe("W9.4 Moves Engine & Materiality Rule", () => {
  describe("Move Priority Hierarchy & Constraints", () => {
    test("defines priority tier for all 18 moves without exception", () => {
      const all18Moves: MoveKind[] = [
        "back-to-the-object",
        "idle-close",
        "sharpen-statement",
        "add-refuter-from-friction",
        "kill-or-stand",
        "add-refuter",
        "review",
        "close-gap",
        "retry-dead-end",
        "normalize-conflict",
        "collapse-duplicate",
        "re-anchor",
        "third-alternative",
        "discriminate",
        "formalize",
        "state-claim",
        "record-dead-end",
        "synthesize",
      ];

      for (const move of all18Moves) {
        expect(MOVE_PRIORITY_TIER[move]).toBeDefined();
        expect(typeof MOVE_PRIORITY_TIER[move]).toBe("number");
      }
    });

    test("ceremony breaker (back-to-the-object) is strictly top priority", () => {
      expect(MOVE_PRIORITY_TIER["back-to-the-object"]).toBe(1);
      const ceremonyMove = { move: "back-to-the-object", why: "", refs: [] } as any;
      const reviewMove = { move: "review", why: "", refs: [] } as any;
      const claimMove = { move: "state-claim", why: "", refs: [] } as any;

      expect(compareMovePriority(ceremonyMove, reviewMove)).toBeLessThan(0);
      expect(compareMovePriority(ceremonyMove, claimMove)).toBeLessThan(0);
    });

    test("idle-close is second priority to prompt session hygiene", () => {
      expect(MOVE_PRIORITY_TIER["idle-close"]).toBe(2);
      const idleMove = { move: "idle-close", why: "", refs: [] } as any;
      const reviewMove = { move: "review", why: "", refs: [] } as any;
      expect(compareMovePriority(idleMove, reviewMove)).toBeLessThan(0);
    });

    test("permission filtering excludes promotion moves for observers", () => {
      const candidates = [
        { move: "state-claim", refs: ["P-1"] },
        { move: "formalize", refs: ["P-1", "C-1@1"] },
        { move: "review", refs: ["P-1", "C-2@1"] },
        { move: "idle-close", refs: ["P-1", "S-1"] },
      ] as any[];

      // Observer permissions: promote is false, review is true, session_open is true
      const observerPermissions = {
        read: true,
        session_open: true,
        workshop_push: true,
        promote: false,
        review: true,
      };

      const filtered = filterMovesByPermissions(candidates, observerPermissions);
      const moveKinds = filtered.map((c) => c.move);
      expect(moveKinds).toContain("review");
      expect(moveKinds).toContain("idle-close");
      expect(moveKinds).not.toContain("state-claim");
      expect(moveKinds).not.toContain("formalize");
    });
  });

  describe("Individual Move Selectors", () => {
    test("sharpen-statement triggers when status is sharpening", async () => {
      const sqlite = new Database(":memory:");
      sqlite.exec(`
        CREATE TABLE problems (id TEXT PRIMARY KEY, status TEXT, current_statement_version INTEGER);
        CREATE TABLE problem_statement_versions (problem_id TEXT, version INTEGER, statement TEXT, falsifier TEXT);
        INSERT INTO problems VALUES ('P-1', 'sharpening', 1);
        INSERT INTO problem_statement_versions VALUES ('P-1', 1, 'Statement here', 'Falsifier here');
      `);

      const db = createMockDb(sqlite);
      const res = await selectSharpenStatementMove(db, "P-1", 5);
      expect(res.move).not.toBeNull();
      expect(res.move?.move).toBe("sharpen-statement");
      expect(res.move?.refs).toEqual(["P-1", "S@1"]);
      expect(res.move?.why).toContain("sharpening status");
      sqlite.close();
    });

    test("discriminate triggers when >= 3 live hypotheses exist", async () => {
      const sqlite = new Database(":memory:");
      sqlite.exec(`
        CREATE TABLE hypotheses (
          hypothesis_id TEXT PRIMARY KEY,
          problem_id TEXT,
          route TEXT,
          mechanism TEXT,
          falsifier TEXT,
          discriminating_predictions_json TEXT,
          status TEXT
        );
        INSERT INTO hypotheses VALUES ('H-1', 'P-1', 'Route 1', 'Mech 1', 'Fals 1', '[]', 'open');
        INSERT INTO hypotheses VALUES ('H-2', 'P-1', 'Route 2', 'Mech 2', 'Fals 2', '[]', 'open');
      `);

      const db = createMockDb(sqlite);
      // 2 live hypotheses: discriminate does not trigger (third-alternative triggers instead)
      const res2 = await selectDiscriminateMove(db, "P-1", 10);
      expect(res2.move).toBeNull();

      // 3 live hypotheses: discriminate triggers
      sqlite.run(
        "INSERT INTO hypotheses VALUES ('H-3', 'P-1', 'Route 3', 'Mech 3', 'Fals 3', '[]', 'open')",
      );
      const res3 = await selectDiscriminateMove(db, "P-1", 10);
      expect(res3.move).not.toBeNull();
      expect(res3.move?.move).toBe("discriminate");
      expect(res3.move?.refs).toEqual(["P-1", "H-1", "H-2", "H-3"]);
      expect(res3.move?.why).toContain("Strong inference");
      sqlite.close();
    });

    test("kill-or-stand triggers when hypothesis falsifier appears fired in evidence", async () => {
      const sqlite = new Database(":memory:");
      sqlite.exec(`
        CREATE TABLE hypotheses (hypothesis_id TEXT PRIMARY KEY, problem_id TEXT, route TEXT, falsifier TEXT, status TEXT);
        CREATE TABLE evidence (evidence_id TEXT PRIMARY KEY, problem_id TEXT, bears_on_kind TEXT, bears_on_id TEXT, direction TEXT);
        INSERT INTO hypotheses VALUES ('H-1', 'P-1', 'Route 1', 'Expected bound > 10', 'open');
        INSERT INTO evidence VALUES ('E-1', 'P-1', 'hypothesis', 'H-1', 'refutes');
      `);

      const db = createMockDb(sqlite);
      const res = await selectKillOrStandMove(db, "P-1", 10);
      expect(res.move).not.toBeNull();
      expect(res.move?.move).toBe("kill-or-stand");
      expect(res.move?.refs).toEqual(["P-1", "H-1", "E-1"]);
      expect(res.move?.contract.prefilled_hints).toEqual({
        hypothesis_id: "H-1",
        killed_by_evidence_id: "E-1",
        reason: "Falsifying evidence observed in E-1: declared falsifier fired.",
      });
      sqlite.close();
    });

    test("formalize selects most load-bearing claim by DAG dependents count", async () => {
      const sqlite = new Database(":memory:");
      sqlite.exec(`
        CREATE TABLE events (
          id TEXT PRIMARY KEY,
          problem_id TEXT,
          seq INTEGER,
          object_kind TEXT,
          object_id TEXT,
          object_version INTEGER,
          type TEXT
        );
        CREATE TABLE event_content (event_id TEXT PRIMARY KEY, payload_json TEXT);
        CREATE TABLE claim_deps (problem_id TEXT, claim_id TEXT, depends_on_claim_id TEXT);

        -- Two claims: C-1 (has 1 dependent) and C-2 (has 3 dependents)
        INSERT INTO events VALUES ('EV-C1', 'P-1', 1, 'claim', 'C-1', 1, 'claim.created');
        INSERT INTO events VALUES ('EV-C2', 'P-1', 2, 'claim', 'C-2', 1, 'claim.created');
        INSERT INTO event_content VALUES ('EV-C1', json_object('statement', 'Lemma 1'));
        INSERT INTO event_content VALUES ('EV-C2', json_object('statement', 'Key theorem 2'));

        -- C-2 has 3 dependents: C-3, C-4, C-5 depend on C-2
        INSERT INTO claim_deps VALUES ('P-1', 'C-3', 'C-2');
        INSERT INTO claim_deps VALUES ('P-1', 'C-4', 'C-2');
        INSERT INTO claim_deps VALUES ('P-1', 'C-5', 'C-2');

        -- C-1 has only 1 dependent: C-6 depends on C-1
        INSERT INTO claim_deps VALUES ('P-1', 'C-6', 'C-1');
      `);

      const db = createMockDb(sqlite);
      const res = await selectFormalizeMove(db, "P-1", 10);
      expect(res.move).not.toBeNull();
      expect(res.move?.move).toBe("formalize");
      // C-2 is chosen because it has 3 dependents (most load-bearing)
      expect(res.move?.refs).toEqual(["P-1", "C-2@1"]);
      expect(res.move?.why).toContain("3 dependents");
      sqlite.close();
    });

    test("collapse-duplicate detects matching norm_hash across distinct claims", async () => {
      const sqlite = new Database(":memory:");
      sqlite.exec(`
        CREATE TABLE claim_versions (claim_id TEXT, version INTEGER, problem_id TEXT, norm_hash TEXT);
        CREATE TABLE claim_relations (problem_id TEXT, kind TEXT, source_claim_id TEXT, target_ref TEXT);

        -- Two claims with identical normalized statement hash
        INSERT INTO claim_versions VALUES ('C-1', 1, 'P-1', 'hash-identical-statement');
        INSERT INTO claim_versions VALUES ('C-2', 1, 'P-1', 'hash-identical-statement');
      `);

      const db = createMockDb(sqlite);
      const res = await selectCollapseDuplicateMove(db, "P-1", 10);
      expect(res.move).not.toBeNull();
      expect(res.move?.move).toBe("collapse-duplicate");
      expect(res.move?.refs).toEqual(["P-1", "C-1@1", "C-2@1"]);
      sqlite.close();
    });

    test("re-anchor detects statement drift on fellow's claim", async () => {
      const sqlite = new Database(":memory:");
      sqlite.exec(`
        CREATE TABLE problems (id TEXT PRIMARY KEY, current_statement_version INTEGER);
        CREATE TABLE events (
          id TEXT PRIMARY KEY,
          problem_id TEXT,
          seq INTEGER,
          object_kind TEXT,
          object_id TEXT,
          object_version INTEGER,
          actor_fellow_id TEXT
        );
        CREATE TABLE claims (problem_id TEXT, id TEXT, statement_drift INTEGER);

        -- Problem is at statement version 2
        INSERT INTO problems VALUES ('P-1', 2);
        -- Fellow F-AUTHOR has a claim at version 1 with statement_drift = 1
        INSERT INTO events VALUES ('EV-1', 'P-1', 1, 'claim', 'C-1', 1, 'F-AUTHOR');
        INSERT INTO claims VALUES ('P-1', 'C-1', 1);
      `);

      const db = createMockDb(sqlite);
      const res = await selectReanchorMove(db, "P-1", "F-AUTHOR", 10);
      expect(res.move).not.toBeNull();
      expect(res.move?.move).toBe("re-anchor");
      expect(res.move?.refs).toEqual(["P-1", "C-1@1", "S@2"]);
      expect(res.move?.contract.prefilled_hints).toEqual({
        claim_id: "C-1",
        base_version: 1,
      });

      // Different fellow does not get reanchor for someone else's claim
      const resOther = await selectReanchorMove(db, "P-1", "F-OTHER", 10);
      expect(resOther.move).toBeNull();
      sqlite.close();
    });

    test("normalize-conflict detects contradicting claims lacking conflict object", async () => {
      const sqlite = new Database(":memory:");
      sqlite.exec(`
        CREATE TABLE claim_relations (problem_id TEXT, kind TEXT, source_claim_id TEXT, source_version INTEGER, target_ref TEXT);
        -- The column shape of migration 0054 (the real table), not an invented one.
        CREATE TABLE conflicts (problem_id TEXT, claim_a_id TEXT, claim_a_version INTEGER, claim_b_id TEXT, claim_b_version INTEGER);

        -- Relation asserts contradiction between C-1@1 and C-2@1
        INSERT INTO claim_relations VALUES ('P-1', 'contradicts', 'C-1', 1, 'C-2@1');
      `);

      const db = createMockDb(sqlite);
      const res = await selectNormalizeConflictMove(db, "P-1", 10);
      expect(res.move).not.toBeNull();
      expect(res.move?.move).toBe("normalize-conflict");
      expect(res.move?.refs).toEqual(["P-1", "C-1@1", "C-2@1"]);
      expect(res.degraded).toBe(false);

      // A conflict object for the exact pair (either order) retires the move;
      // one for another version does not.
      sqlite.exec("INSERT INTO conflicts VALUES ('P-1', 'C-2', 2, 'C-1', 1)");
      expect((await selectNormalizeConflictMove(db, "P-1", 10)).move?.move).toBe(
        "normalize-conflict",
      );
      sqlite.exec("INSERT INTO conflicts VALUES ('P-1', 'C-2', 1, 'C-1', 1)");
      const settled = await selectNormalizeConflictMove(db, "P-1", 10);
      expect(settled).toEqual({ move: null, degraded: false });
      sqlite.close();
    });

    test("record-dead-end provides structured retry_when guidance", async () => {
      const sqlite = new Database(":memory:");
      const db = createMockDb(sqlite);
      const res = await selectRecordDeadEndMove(db, "P-1", 10);
      expect(res.move).not.toBeNull();
      expect(res.move?.move).toBe("record-dead-end");
      expect(res.move?.why).toContain("An honest null is success");
      sqlite.close();
    });
  });

  describe("TruthfulProductionMovesProvider Wiring", () => {
    test("TruthfulProductionMovesProvider instantiates with all real loaders", () => {
      const provider = new TruthfulProductionMovesProvider();
      expect(provider).toBeInstanceOf(LedgerMovesProvider);
    });
  });
});
