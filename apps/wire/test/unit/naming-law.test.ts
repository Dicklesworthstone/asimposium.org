import { describe, expect, test } from "bun:test";
import { FellowNameSchema } from "@asimposium/contracts";
import {
  AesGcmEnrollmentReplayProtector,
  enrollmentNameFailure,
  EnrollmentService,
  InMemoryEnrollmentStore,
} from "../../src/enrollment/service.ts";

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
      const invalidStarts = [
        "-fellow",
        "0agent",
        "1orchid",
        "9vector",
        "_orchid",
      ];
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
      const reserved = [
        "admin",
        "charter",
        "system",
        "symposiarch",
      ];
      for (const name of reserved) {
        expect(FellowNameSchema.safeParse(name).success).toBe(true);
        expect(enrollmentNameFailure(name)).toBe("NAME_RESERVED");
      }
    });

    test("rejects company and product identity terms with NAME_RESERVED", () => {
      const productNames = [
        "anthropic",
        "anthropic-ai",
        "openai",
        "openai-fellow",
      ];
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
      const modNames = [
        "fellow-mod",
        "admin-mod",
        "reviewer-mod",
      ];
      for (const name of modNames) {
        expect(FellowNameSchema.safeParse(name).success).toBe(true);
        expect(enrollmentNameFailure(name)).toBe("NAME_RESERVED");
      }
    });
  });

  describe("Profanity & Leetspeak Denylist", () => {
    test("rejects exact profanity with NAME_RESERVED", () => {
      const profane = [
        "shit-bot",
        "fuck-agent",
        "bitch-solver",
        "asshole-fellow",
      ];
      for (const name of profane) {
        expect(FellowNameSchema.safeParse(name).success).toBe(true);
        expect(enrollmentNameFailure(name)).toBe("NAME_RESERVED");
      }
    });

    test("rejects leetspeak-normalized profanity with NAME_RESERVED", () => {
      const leetProfane = [
        "sh1t-proof",
        "b1tch-core",
        "assh0le-math",
      ];
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
      } catch (error: any) {
        expect(error.code).toBe("MODEL_AS_NAME");
        expect(error.suggestions).toHaveLength(3);
        for (const suggestion of error.suggestions) {
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
      } catch (error: any) {
        expect(error.code).toBe("MODEL_AS_NAME");
        expect(error.suggestions).toEqual(["fellow-5", "fellow-6", "fellow-7"]);
        for (const suggestion of error.suggestions) {
          expect(FellowNameSchema.safeParse(suggestion).success).toBe(true);
          expect(enrollmentNameFailure(suggestion)).toBeUndefined();
        }
      }
    });
  });
});
