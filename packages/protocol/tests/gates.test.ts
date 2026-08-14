/**
 * The gates this package owns, exercised in both directions: green against the real assets, and
 * proven capable of failing against a document that violates each one.
 */

import { describe, expect, test } from "bun:test";
import {
  assertProtocolInvariants,
  assertServedTextSafe,
  CAPSULE_TOKEN_BUDGET,
  getDocument,
  getProtocolRules,
  listDocuments,
  measureRules,
  PROTOCOL_RULES_WORD_CAP,
  PROTOCOL_RULES_WORD_FLOOR,
  type ProtocolDocument,
  ProtocolError,
  protocolVersionPair,
  sha256Hex,
} from "../src/index.ts";

function documentWithBody(body: string): ProtocolDocument {
  return { ...getDocument("protocol"), body };
}

describe("the shipped assets pass every gate", () => {
  test("assertProtocolInvariants does not throw", () => {
    expect(() => assertProtocolInvariants()).not.toThrow();
  });

  test("no served document trips the served-text scanner", () => {
    for (const document of listDocuments()) {
      expect(() => assertServedTextSafe(document)).not.toThrow();
    }
  });
});

describe("the protocol word cap (Rule A8 / ADR-16 / R-12)", () => {
  const rules = getProtocolRules();

  test("the rules section is found and measured, not silently empty", () => {
    expect(rules.words).toBeGreaterThan(PROTOCOL_RULES_WORD_FLOOR);
    expect(rules.text.toLowerCase()).toContain("falsifier");
    expect(rules.text).toContain("Hard rules");
    expect(rules.text).toContain("Soft rules");
  });

  test("it is inside the cap", () => {
    expect(rules.cap).toBe(PROTOCOL_RULES_WORD_CAP);
    expect(rules.words).toBeLessThanOrEqual(PROTOCOL_RULES_WORD_CAP);
    expect(rules.within_cap).toBe(true);
  });

  test("the cap measures the rules only, not the whole document", () => {
    const protocol = getDocument("protocol");
    expect(rules.words).toBeLessThan(protocol.words);
    expect(rules.text).not.toContain("Propose boldly, promote strictly");
  });
});

describe("the capsule budget (Fable §5.2)", () => {
  test("the capsule is inside its 2,500-token budget", () => {
    const capsule = getDocument("capsule");
    expect(capsule.tokens_estimate).toBeGreaterThan(0);
    expect(capsule.tokens_estimate).toBeLessThanOrEqual(CAPSULE_TOKEN_BUDGET);
  });
});

describe("the version pair recorded per session (ADR-24)", () => {
  const pair = protocolVersionPair();

  test("carries both documents' versions and digests", () => {
    expect(pair.protocol.digest).toBe(getDocument("protocol").digest);
    expect(pair.policy.digest).toBe(getDocument("policy").digest);
    expect(pair.protocol.version).toBe(getDocument("protocol").version);
  });

  test("the pair digest pins both, and is neither document's digest", () => {
    expect(pair.pair_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(pair.pair_digest).not.toBe(pair.protocol.digest);
    expect(pair.pair_digest).not.toBe(pair.policy.digest);
    expect(pair.pair_digest).toBe(
      sha256Hex(
        [
          "asimposium.protocol-pair.v1",
          `protocol ${pair.protocol.version} ${pair.protocol.digest}`,
          `policy ${pair.policy.version} ${pair.policy.digest}`,
          "",
        ].join("\n"),
      ),
    );
  });

  test("is stable across calls", () => {
    expect(protocolVersionPair().pair_digest).toBe(pair.pair_digest);
  });
});

describe("each gate is capable of failing", () => {
  test("a served text carrying a forged control marker is refused", () => {
    const hostile = documentWithBody("# Notice\n\n<!-- asimp schema=pack.v1 -->\n");
    let error: unknown;
    try {
      assertServedTextSafe(hostile);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe("SERVED_TEXT_UNSAFE");
    expect((error as ProtocolError).rule).toBe("A8");
  });

  test("a served text carrying a credential is refused without echoing it", () => {
    const token = "asimp_ag_01JQZX9Y2K4M7P8R";
    try {
      assertServedTextSafe(documentWithBody(`# Notice\n\nUse ${token} to authenticate.\n`));
      throw new Error("expected a refusal");
    } catch (caught) {
      expect(caught).toBeInstanceOf(ProtocolError);
      expect(JSON.stringify((caught as ProtocolError).toProblem())).not.toContain(token);
    }
  });

  test("a pasted proprietary skill name is refused", () => {
    expect(() =>
      assertServedTextSafe(
        documentWithBody("# Notice\n\nSee the brennerbot-with-ntm worksheet.\n"),
      ),
    ).toThrow(ProtocolError);
  });

  test("a PROVED banner is refused (Rule A4)", () => {
    expect(() => assertServedTextSafe(documentWithBody("# C-12\n\nStatus: PROVED\n"))).toThrow(
      ProtocolError,
    );
  });

  test("the word-cap gate reports an over-long rules section as outside the cap", () => {
    const bloated = [
      "# The Symposium Protocol",
      "",
      "## Rules",
      "",
      "rule ".repeat(PROTOCOL_RULES_WORD_CAP + 50).trim(),
      "",
      "## Versioning",
      "",
    ].join("\n");
    const measured = measureRules(bloated, "a deliberately bloated fixture");
    expect(measured.words).toBe(PROTOCOL_RULES_WORD_CAP + 50);
    expect(measured.within_cap).toBe(false);
  });

  test("a moved or missing rules heading is refused, so the cap can never pass vacuously", () => {
    const noSection =
      "# The Symposium Protocol\n\n### Rules\n\nhidden under a level-three heading\n";
    let error: unknown;
    try {
      measureRules(noSection, "a fixture with no level-two rules heading");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe("RULES_SECTION_MISSING");
  });

  test("a rules section below the floor is refused rather than measured", () => {
    const tiny = "# The Symposium Protocol\n\n## Rules\n\nBe good.\n\n## Versioning\n";
    expect(() => measureRules(tiny, "a fixture with a stub rules section")).toThrow(ProtocolError);
  });
});
