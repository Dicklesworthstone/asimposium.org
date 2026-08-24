import { describe, expect, test } from "bun:test";

import {
  bucketizePackBudget,
  composePack,
  PACK_BUDGET_BUCKETS,
  type PackCandidate,
  type PackComposerInput,
} from "../../src/index.ts";

/**
 * ceq property tests: the pack engine's guarantees must hold over ARBITRARY
 * candidate sets and budgets, not only the hand-picked cases. These are
 * dependency-free seeded-property tests — a deterministic PRNG drives the
 * search so a failure reproduces from its seed byte-for-byte, and no new
 * package enters the lockfile.
 */

/** mulberry32 — a small deterministic PRNG; the seed is the test case. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KINDS = ["claim", "statement", "evidence", "warning", "handback"] as const;
const SCOPES = ["system", "ledger", "workshop"] as const;

function arbitraryCandidate(rand: () => number, index: number): PackCandidate {
  const tokens = 1 + Math.floor(rand() * 900);
  const bodyLength = 1 + Math.floor(rand() * 240);
  // Draw scope first: a trusted system body renders raw on the markdown face,
  // so admission law (TRUSTED_BODY_CONTAINS_BACKTICK) bans backticks there.
  // The generator respects that contract instead of minting refusals as
  // "found bugs"; untrusted bodies keep the full printable-ASCII alphabet.
  const scope = SCOPES[Math.floor(rand() * SCOPES.length)];
  if (scope === undefined) {
    throw new Error("non-empty property-test vocabularies must yield a candidate value");
  }
  let body = "";
  for (let i = 0; i < bodyLength; i += 1) {
    let codeUnit = 32 + Math.floor(rand() * 95);
    if (scope === "system" && codeUnit === 96) codeUnit = 39;
    body += String.fromCharCode(codeUnit);
  }
  const kind = KINDS[Math.floor(rand() * KINDS.length)];
  return {
    kind,
    id: `X-${index}-${Math.floor(rand() * 1000)}`,
    scope,
    tokens,
    // The composer enforces the trust boundary: system iff untrusted is false.
    untrusted: scope !== "system",
    body,
    why_included: `seed reason ${index}`,
    stable_prefix: Math.floor(rand() * 400),
  };
}

function arbitraryInput(rand: () => number, requestedMaxTokens: number): PackComposerInput {
  const candidateCount = Math.floor(rand() * 24);
  const candidates: PackCandidate[] = [];
  for (let i = 0; i < candidateCount; i += 1) candidates.push(arbitraryCandidate(rand, i));
  return {
    schema: "asimposium.pack.v1",
    session: "S-property",
    problem: "P-PROPERTY",
    profile: "working",
    cursor: Math.floor(rand() * 1000),
    requested_max_tokens: requestedMaxTokens,
    viewer: { audience: "session", membership: "contributor", effective_permissions: [] },
    candidates,
    action_candidates: [],
  };
}

describe("pack composition properties (seeded, reproducible)", () => {
  test("composition is deterministic: identical input yields identical bytes and fingerprint", () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const input = arbitraryInput(prng(seed), 4000);
      const first = composePack(input);
      const second = composePack(input);
      expect(first.canonical_json, `seed ${seed} bytes diverged`).toBe(second.canonical_json);
      expect(first.canonical_fingerprint, `seed ${seed} fingerprint diverged`).toBe(
        second.canonical_fingerprint,
      );
      expect(first.tokens_estimate).toBe(second.tokens_estimate);
    }
  });

  test("insertion order never changes the composition (stable-prefix canonical order)", () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const rand = prng(seed);
      const input = arbitraryInput(rand, 2500);
      const reversed = {
        ...input,
        candidates: [...input.candidates].reverse(),
      };
      const a = composePack(input);
      const b = composePack(reversed);
      expect(
        a.items.map((i) => i.id),
        `seed ${seed} order leaked into selection`,
      ).toEqual(b.items.map((i) => i.id));
      expect(a.canonical_fingerprint).toBe(b.canonical_fingerprint);
    }
  });

  test("a larger budget's selection has every smaller budget's selection as a prefix", () => {
    for (let seed = 1; seed <= 50; seed += 1) {
      const rand = prng(seed);
      const candidates: PackCandidate[] = [];
      for (let i = 0; i < 20; i += 1) candidates.push(arbitraryCandidate(rand, i));
      const base = {
        schema: "asimposium.pack.v1",
        session: "S-property",
        problem: "P-PROPERTY",
        profile: "working",
        cursor: 7,
        viewer: { audience: "session", membership: "contributor", effective_permissions: [] },
        action_candidates: [],
      } as const;
      const selections = PACK_BUDGET_BUCKETS.map((bucket) =>
        composePack({ ...base, candidates, requested_max_tokens: bucket }).items.map((i) => i.id),
      );
      for (let k = 1; k < selections.length; k += 1) {
        const smaller = selections[k - 1];
        const larger = selections[k];
        if (smaller === undefined || larger === undefined) {
          throw new Error("adjacent pack-budget selections must exist");
        }
        expect(
          larger.length,
          `seed ${seed}: a larger bucket selected fewer items`,
        ).toBeGreaterThanOrEqual(smaller.length);
        expect(
          larger.slice(0, smaller.length),
          `seed ${seed}: smaller selection is not a prefix of the larger`,
        ).toEqual(smaller);
      }
    }
  });

  test("the published estimate never exceeds the bucket (no silent overflow)", () => {
    for (let seed = 1; seed <= 80; seed += 1) {
      const rand = prng(seed);
      const requested = 1 + Math.floor(rand() * 8000);
      const pack = composePack(arbitraryInput(rand, requested));
      const bucket = bucketizePackBudget(requested);
      expect(pack.budget_tokens).toBe(bucket);
      expect(
        pack.tokens_estimate,
        `seed ${seed}: estimate ${pack.tokens_estimate} exceeds bucket ${bucket}`,
      ).toBeLessThanOrEqual(bucket);
    }
  });

  test("omission accounting is complete: an empty pack always explains itself", () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const pack = composePack(arbitraryInput(prng(seed), 4000));
      if (pack.items.length === 0) {
        // The Fable invariant: an empty pack with an empty omitted[] is a bug.
        expect(pack.omitted.length, `seed ${seed}: empty pack with empty omitted`).toBeGreaterThan(
          0,
        );
      }
      // Every omission carries a machine-readable reason.
      for (const entry of pack.omitted) {
        expect(typeof entry.reason).toBe("string");
        expect(entry.reason.length).toBeGreaterThan(0);
      }
    }
  });
});
