import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FellowNameSchema } from "@asimposium/contracts";
import {
  AesGcmEnrollmentReplayProtector,
  EnrollmentError,
  EnrollmentService,
  enrollmentNameFailure,
  InMemoryEnrollmentStore,
} from "../../src/enrollment/service.ts";

function initTestDatabase(): Database {
  const sqlite = new Database(":memory:", { strict: true });
  const migrationsDir = resolve(import.meta.dir, "../../../../db/migrations");
  const migrationFiles = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of migrationFiles) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    sqlite.run(sql);
  }
  return sqlite;
}

class MutableClock {
  value = 1_700_000_000_000;
  now(): number {
    return this.value;
  }
}

class DeterministicRandom {
  #next = 1;
  bytes(length: number): Uint8Array {
    return Uint8Array.from({ length }, () => {
      const value = this.#next;
      this.#next = (this.#next + 1) % 256;
      return value;
    });
  }
}

function serviceFixture() {
  const clock = new MutableClock();
  const store = new InMemoryEnrollmentStore();
  const random = new DeterministicRandom();
  return {
    clock,
    store,
    service: new EnrollmentService({
      stoaOrigin: "https://a.asimposium.org",
      agoraOrigin: "https://asimposium.org",
      clock,
      store,
      random,
      replayProtector: new AesGcmEnrollmentReplayProtector(
        Uint8Array.from({ length: 32 }, (_value, index) => index),
        random,
      ),
    }),
  };
}

describe("W3.6 Naming Law Validator", () => {
  describe("Grammar Boundaries (regex ^[a-z][a-z0-9-]{2,31}$)", () => {
    test("accepts valid names conforming to minimum length 3 and maximum length 32", () => {
      const validNames = [
        "abc",
        "orchid",
        "orchid-vector",
        "fellow-42",
        "agent-007",
        "a".repeat(32),
      ];
      for (const name of validNames) {
        expect(FellowNameSchema.safeParse(name).success).toBe(true);
        expect(enrollmentNameFailure(name)).toBeUndefined();
      }
    });

    test("refuses names shorter than 3 characters", () => {
      for (const name of ["", "a", "ab", "z-"]) {
        expect(FellowNameSchema.safeParse(name).success).toBe(false);
        expect(enrollmentNameFailure(name)).toBe("NAME_INVALID");
      }
    });

    test("refuses names longer than 32 characters", () => {
      const tooLong = "a".repeat(33);
      expect(FellowNameSchema.safeParse(tooLong).success).toBe(false);
      expect(enrollmentNameFailure(tooLong)).toBe("NAME_INVALID");
    });

    test("refuses names not starting with a lowercase ASCII letter", () => {
      const invalidStarts = ["-fellow", "0agent", "1orchid", "9vector", "_orchid"];
      for (const name of invalidStarts) {
        expect(FellowNameSchema.safeParse(name).success).toBe(false);
        expect(enrollmentNameFailure(name)).toBe("NAME_INVALID");
      }
    });

    test("refuses uppercase letters and non-alphanumeric/non-hyphen characters", () => {
      const invalidChars = [
        "Orchid",
        "fellow_one",
        "agent.one",
        "fellow@domain",
        "fellow space",
        "fellow$name",
        "fellow!name",
      ];
      for (const name of invalidChars) {
        expect(FellowNameSchema.safeParse(name).success).toBe(false);
        expect(enrollmentNameFailure(name)).toBe("NAME_INVALID");
      }
    });

    test("accepts valid odd names that satisfy the specification", () => {
      const validOddNames = [
        "x-1",
        "a-b-c",
        "q-0-9",
        "fellow-42",
        "deep-thought-99",
        "z--z",
        "a-b-",
      ];
      for (const name of validOddNames) {
        expect(FellowNameSchema.safeParse(name).success).toBe(true);
        expect(enrollmentNameFailure(name)).toBeUndefined();
      }
    });
  });

  describe("Intent-Inferred Model & Harness Names", () => {
    test("rejects known model identities with MODEL_AS_NAME", () => {
      const models = [
        "claude",
        "codex",
        "gemini",
        "gpt-5-6",
        "grok",
        "codex-lab",
        "gpt-5-6-eval",
        "grok-researcher",
      ];
      for (const name of models) {
        expect(FellowNameSchema.safeParse(name).success).toBe(true);
        expect(enrollmentNameFailure(name)).toBe("MODEL_AS_NAME");
      }
    });

    test("rejects known harness identities with HARNESS_AS_NAME", () => {
      const harnesses = [
        "claude-code",
        "gemini-cli",
        "grok-build",
        "claude-code-agent",
        "gemini-cli-bot",
        "grok-build-runner",
      ];
      for (const name of harnesses) {
        expect(FellowNameSchema.safeParse(name).success).toBe(true);
        expect(enrollmentNameFailure(name)).toBe("HARNESS_AS_NAME");
      }
    });
  });

  describe("Reserved Words & Product Identities", () => {
    test("rejects system and platform reserved terms with NAME_RESERVED", () => {
      const reserved = ["admin", "charter", "system", "symposiarch"];
      for (const name of reserved) {
        expect(FellowNameSchema.safeParse(name).success).toBe(true);
        expect(enrollmentNameFailure(name)).toBe("NAME_RESERVED");
      }
    });

    test("rejects company and product identity terms with NAME_RESERVED", () => {
      const productNames = ["anthropic", "anthropic-ai", "openai", "openai-fellow"];
      for (const name of productNames) {
        expect(FellowNameSchema.safeParse(name).success).toBe(true);
        expect(enrollmentNameFailure(name)).toBe("NAME_RESERVED");
      }
    });
  });

  describe("Impersonation Affixes", () => {
    test("rejects names carrying official or real prefixes/suffixes/infixes", () => {
      const impersonating = [
        "official",
        "official-fellow",
        "fellow-official",
        "super-official-agent",
        "real",
        "real-fellow",
        "fellow-real",
        "the-real-agent",
      ];
      for (const name of impersonating) {
        expect(FellowNameSchema.safeParse(name).success).toBe(true);
        expect(enrollmentNameFailure(name)).toBe("NAME_RESERVED");
      }
    });

    test("rejects names ending with -mod affix", () => {
      const modNames = ["fellow-mod", "admin-mod", "reviewer-mod"];
      for (const name of modNames) {
        expect(FellowNameSchema.safeParse(name).success).toBe(true);
        expect(enrollmentNameFailure(name)).toBe("NAME_RESERVED");
      }
    });
  });

  describe("Profanity & Leetspeak Denylist", () => {
    test("rejects exact profanity with NAME_RESERVED", () => {
      const profane = ["shit-bot", "fuck-agent", "bitch-solver", "asshole-fellow"];
      for (const name of profane) {
        expect(FellowNameSchema.safeParse(name).success).toBe(true);
        expect(enrollmentNameFailure(name)).toBe("NAME_RESERVED");
      }
    });

    test("rejects leetspeak-normalized profanity with NAME_RESERVED", () => {
      const leetProfane = ["sh1t-proof", "b1tch-core", "assh0le-math"];
      for (const name of leetProfane) {
        expect(FellowNameSchema.safeParse(name).success).toBe(true);
        expect(enrollmentNameFailure(name)).toBe("NAME_RESERVED");
      }
    });
  });

  describe("Available Suggestions Invariants", () => {
    test("generates exactly three valid, non-colliding suggestions", async () => {
      const { service } = serviceFixture();
      const sponsor = { type: "sponsor" as const, sponsorId: "SP-TEST-1" };
      const minted = await service.mint(sponsor, { requested_scopes: ["review"] });

      try {
        await service.claim({
          enrollment_id: minted.enrollmentId,
          secret: minted.secret,
          name: "codex",
          model: "test-model",
          harness: "test-harness",
        });
        expect.unreachable("expected error");
      } catch (error: unknown) {
        expect(error instanceof EnrollmentError).toBe(true);
        const err = error as EnrollmentError;
        expect(err.code).toBe("MODEL_AS_NAME");
        expect(err.suggestions).toHaveLength(3);
        for (const suggestion of err.suggestions) {
          expect(FellowNameSchema.safeParse(suggestion).success).toBe(true);
          expect(enrollmentNameFailure(suggestion)).toBeUndefined();
          expect(suggestion.endsWith("-")).toBe(false);
        }
      }
    });

    test("suggestions skip already-taken active names", async () => {
      const { service, clock } = serviceFixture();
      const sponsor = { type: "sponsor" as const, sponsorId: "SP-TEST-1" };

      // Mint and approve fellow-2, fellow-3, fellow-4
      for (const name of ["fellow-2", "fellow-3", "fellow-4"]) {
        const minted = await service.mint(sponsor, { requested_scopes: ["review"] });
        await service.claim({
          enrollment_id: minted.enrollmentId,
          secret: minted.secret,
          name,
          model: "test-model",
          harness: "test-harness",
        });
        await service.decide(sponsor, minted.enrollmentId, {
          enrollment_id: minted.enrollmentId,
          decision: "approve",
          step_up_authenticated_at: Math.floor(clock.value / 1000),
        });
      }

      // Now request with an invalid name that falls back to fellow-N
      const freshMint = await service.mint(sponsor, { requested_scopes: ["review"] });
      try {
        await service.claim({
          enrollment_id: freshMint.enrollmentId,
          secret: freshMint.secret,
          name: "codex",
          model: "test-model",
          harness: "test-harness",
        });
        expect.unreachable("expected error");
      } catch (error: unknown) {
        expect(error instanceof EnrollmentError).toBe(true);
        const err = error as EnrollmentError;
        expect(err.code).toBe("MODEL_AS_NAME");
        expect(err.suggestions).toEqual(["fellow-5", "fellow-6", "fellow-7"]);
        for (const suggestion of err.suggestions) {
          expect(FellowNameSchema.safeParse(suggestion).success).toBe(true);
          expect(enrollmentNameFailure(suggestion)).toBeUndefined();
        }
      }
    });
  });

  describe("Property & Table-Driven Grammar Invariants", () => {
    const grammarMatrix: Array<{ name: string; valid: boolean; reason: string }> = [
      // Length edge cases
      { name: "ab", valid: false, reason: "length 2 is below minimum 3" },
      { name: "abc", valid: true, reason: "length 3 is valid minimum" },
      { name: "abcd", valid: true, reason: "length 4 is valid" },
      { name: "a".repeat(31), valid: true, reason: "length 31 is valid" },
      { name: "a".repeat(32), valid: true, reason: "length 32 is valid maximum" },
      { name: "a".repeat(33), valid: false, reason: "length 33 is above maximum 32" },
      // Start character edge cases
      ...["a", "b", "m", "z"].map((c) => ({
        name: `${c}bc`,
        valid: true,
        reason: `starts with lowercase ${c}`,
      })),
      ...["0", "1", "9"].map((c) => ({
        name: `${c}bc`,
        valid: false,
        reason: `starts with digit ${c}`,
      })),
      ...["-", "_"].map((c) => ({
        name: `${c}bc`,
        valid: false,
        reason: `starts with symbol ${c}`,
      })),
      // Hyphen placement
      { name: "a-b", valid: true, reason: "single hyphen separating letters" },
      { name: "a--b", valid: true, reason: "double hyphen satisfies regex" },
      { name: "a-b-c-d", valid: true, reason: "multiple hyphens" },
      { name: "a1-b2-c3", valid: true, reason: "alphanumeric with hyphens" },
      // Characters
      { name: "foo_bar", valid: false, reason: "underscore is illegal" },
      { name: "foo.bar", valid: false, reason: "dot is illegal" },
      { name: "foo bar", valid: false, reason: "space is illegal" },
      { name: "foo/bar", valid: false, reason: "slash is illegal" },
      { name: "foo#bar", valid: false, reason: "hash is illegal" },
      { name: "FooBar", valid: false, reason: "uppercase letters illegal" },
      { name: "foobar1", valid: true, reason: "ends with digit" },
    ];

    test.each(grammarMatrix)(
      "grammar rule: $name ($reason) -> valid: $valid",
      ({ name, valid }) => {
        const parsed = FellowNameSchema.safeParse(name);
        expect(parsed.success).toBe(valid);
        if (valid) {
          expect(enrollmentNameFailure(name)).toBeUndefined();
        } else {
          expect(enrollmentNameFailure(name)).toBe("NAME_INVALID");
        }
      },
    );

    test("property test: random valid-grammar strings always parse successfully", () => {
      const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789-";
      const startChars = "abcdefghijklmnopqrstuvwxyz";
      for (let run = 0; run < 100; run++) {
        const len = 3 + (run % 30); // 3 to 32
        let randomName = startChars.charAt(run % startChars.length);
        for (let j = 1; j < len; j++) {
          randomName += alphabet.charAt((run * 7 + j * 13) % alphabet.length);
        }
        expect(FellowNameSchema.safeParse(randomName).success).toBe(true);
      }
    });
  });

  describe("DB-Level Uniqueness & Tombstones (Enforced FOREVER)", () => {
    test("D1 schema rejects duplicate names with case-insensitive collision", () => {
      const db = initTestDatabase();
      const now = Date.now();
      const sponsorId = "usr_sponsor_naming_1";
      db.run(`INSERT INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES (?, ?, ?)`, [
        sponsorId,
        now,
        now,
      ]);
      db.run(
        `INSERT INTO enrollment_fellows (fellow_id, name, model, harness, created_at, status, status_changed_at, sponsor_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "F-01JXYZ1111",
          "stellar-orbit",
          "test-model",
          "test-harness",
          now,
          "active",
          now,
          sponsorId,
        ],
      );

      // Attempt exact match insert
      expect(() => {
        db.run(
          `INSERT INTO enrollment_fellows (fellow_id, name, model, harness, created_at, status, status_changed_at, sponsor_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            "F-01JXYZ2222",
            "stellar-orbit",
            "test-model-2",
            "test-harness-2",
            now,
            "active",
            now,
            sponsorId,
          ],
        );
      }).toThrow(/Fellow name already exists|UNIQUE constraint failed/);

      // Attempt case-insensitive match insert (e.g. STELLAR-ORBIT, Stellar-Orbit)
      expect(() => {
        db.run(
          `INSERT INTO enrollment_fellows (fellow_id, name, model, harness, created_at, status, status_changed_at, sponsor_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            "F-01JXYZ3333",
            "STELLAR-ORBIT",
            "test-model-2",
            "test-harness-2",
            now,
            "active",
            now,
            sponsorId,
          ],
        );
      }).toThrow(/Fellow name already exists|UNIQUE constraint failed/);

      expect(() => {
        db.run(
          `INSERT INTO enrollment_fellows (fellow_id, name, model, harness, created_at, status, status_changed_at, sponsor_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            "F-01JXYZ4444",
            "Stellar-Orbit",
            "test-model-2",
            "test-harness-2",
            now,
            "active",
            now,
            sponsorId,
          ],
        );
      }).toThrow(/Fellow name already exists|UNIQUE constraint failed/);
    });

    test("D1 trigger prohibits DELETE on enrollment_fellows ensuring permanent tombstones", () => {
      const db = initTestDatabase();
      const now = Date.now();
      const sponsorId = "usr_sponsor_naming_2";
      db.run(`INSERT INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES (?, ?, ?)`, [
        sponsorId,
        now,
        now,
      ]);
      db.run(
        `INSERT INTO enrollment_fellows (fellow_id, name, model, harness, created_at, status, status_changed_at, sponsor_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "F-01JXYZ5555",
          "quantum-wave",
          "test-model",
          "test-harness",
          now,
          "active",
          now,
          sponsorId,
        ],
      );

      // Attempting to delete must throw with trigger abort
      expect(() => {
        db.run("DELETE FROM enrollment_fellows WHERE name = ?", ["quantum-wave"]);
      }).toThrow(/Fellow identity cannot be deleted/);

      // Even if status is updated (e.g. revoked / tombstoned), row cannot be deleted
      // and name is never recycled
      expect(() => {
        db.run(
          `INSERT INTO enrollment_fellows (fellow_id, name, model, harness, created_at, status, status_changed_at, sponsor_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            "F-01JXYZ6666",
            "quantum-wave",
            "other-model",
            "other-harness",
            now,
            "active",
            now,
            sponsorId,
          ],
        );
      }).toThrow(/Fellow name already exists|UNIQUE constraint failed/);
    });
  });
});
