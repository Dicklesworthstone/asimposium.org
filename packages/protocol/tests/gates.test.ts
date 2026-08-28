/**
 * The gates this package owns, exercised in both directions: green against the real assets, and
 * proven capable of failing against a document that violates each one.
 */

import { describe, expect, test } from "bun:test";
import {
  assertProtocolInvariants,
  assertServedTextSafe,
  CAPSULE_TOKEN_BUDGET,
  extractProtocolPreamble,
  generateProtocolJsonDocument,
  getDocument,
  getProtocolRules,
  INOCULATION_TOKEN_BUDGET,
  listDocuments,
  measureRules,
  PROTOCOL_JSON_SCHEMA,
  PROTOCOL_RULES_WORD_CAP,
  PROTOCOL_RULES_WORD_FLOOR,
  type ProtocolDocument,
  ProtocolError,
  protocolJsonFace,
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

describe("the protocol JSON face (W6.5 /protocol.json)", () => {
  test("is derived from the Markdown: same digest, preamble, and rules text", () => {
    const protocol = getDocument("protocol");
    const rules = getProtocolRules();
    const face = protocolJsonFace();
    expect(face.schema).toBe(PROTOCOL_JSON_SCHEMA);
    expect(face.digest).toBe(protocol.digest);
    expect(face.preamble).toBe(extractProtocolPreamble(protocol.body, protocol.source_path));
    expect(face.preamble).toContain("Propose boldly, promote strictly");
    expect(face.rules.text).toBe(rules.text);
    expect(face.rules.words).toBe(rules.words);
    expect(face.rules.cap).toBe(PROTOCOL_RULES_WORD_CAP);
    expect(face.markdown_face).toBe("/protocol.md");
    expect(face.json_face).toBe("/protocol.json");
  });

  test("pretty JSON is byte-stable and parseable", () => {
    const first = generateProtocolJsonDocument();
    const second = generateProtocolJsonDocument();
    expect(first).toBe(second);
    expect(first.endsWith("\n")).toBe(true);
    expect(JSON.parse(first)).toEqual(protocolJsonFace());
  });

  test("a missing preamble heading is refused, so the JSON face cannot pass vacuously", () => {
    const noPreamble = "# The Symposium Protocol\n\n## Rules\n\nExact statement first.\n";
    let error: unknown;
    try {
      extractProtocolPreamble(noPreamble, "a fixture with no preamble heading");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe("PREAMBLE_SECTION_MISSING");
  });
});

describe("the capsule budget (Fable §5.2)", () => {
  test("the capsule is inside its 2,500-token budget", () => {
    const capsule = getDocument("capsule");
    expect(capsule.tokens_estimate).toBeGreaterThan(0);
    expect(capsule.tokens_estimate).toBeLessThanOrEqual(CAPSULE_TOKEN_BUDGET);
  });
});

describe("the inoculation budget (Fable §2.5 / ADR-17)", () => {
  test("the inoculation is inside its 800-token budget", () => {
    const inoculation = getDocument("inoculation");
    expect(inoculation.tokens_estimate).toBeGreaterThan(0);
    expect(inoculation.tokens_estimate).toBeLessThanOrEqual(INOCULATION_TOKEN_BUDGET);
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
    // Assembled rather than written as one literal on purpose. The bytes the scanner sees are
    // identical, but the repository never carries a line matching the `asimp_ag_…` prefix that
    // Fable §14.2 reserves for secret scanning — a package that refuses credentials in served
    // text should not be the file that trips the project's own scanner (`ubs` CRITICAL).
    const token = ["asimp", "ag", "01JQZX9Y2K4M7P8R"].join("_");
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

  test("planted negative: a fenced fake heading cannot hide words from the cap", () => {
    const visible = "rule ".repeat(200).trim();
    const hidden = "hidden ".repeat(900).trim();
    const evasive = [
      "# The Symposium Protocol",
      "",
      "## Rules",
      "",
      visible,
      "",
      "```",
      "## Versioning",
      "```",
      "",
      hidden,
      "",
      "## Versioning",
      "",
      "Not part of the rules.",
    ].join("\n");

    // 200 visible + the word "Versioning" inside the fence + 900 hidden. The fence delimiters
    // themselves carry no letter or digit, so they add nothing.
    const measured = measureRules(evasive, "a fixture hiding its tail behind a fenced heading");
    expect(measured.words).toBe(1101);
    expect(measured.within_cap).toBe(false);
    expect(measured.text).toContain("hidden");

    // The prefix a fence-blind extractor would have measured instead: 200 words, above the floor
    // and inside the cap, i.e. silently green on a document that violates Rule A8 by 101 words.
    const evaded = measureRules(
      ["# The Symposium Protocol", "", "## Rules", "", visible, "", "## Versioning", ""].join("\n"),
      "the prefix a fence-blind extractor would have measured",
    );
    expect(evaded.words).toBe(200);
    expect(evaded.within_cap).toBe(true);
  });

  test("planted negative: CRLF fence delimiters cannot hide words from the cap", () => {
    const visible = "rule ".repeat(200).trim();
    const hidden = "hidden ".repeat(900).trim();
    const body = [
      "# The Symposium Protocol",
      "",
      "## Rules",
      "",
      visible,
      "",
      "```",
      "## Versioning",
      "```",
      "",
      hidden,
      "",
      "## Versioning",
      "",
    ];

    // Only the fence delimiters carry CRLF: the editor artifact that used to reopen the
    // fenced-heading evasion, because a CR-terminated delimiter matched nothing.
    const mixed = body.join("\n").replace(/^```$/gm, "```\r");
    const measuredMixed = measureRules(mixed, "a fixture with CRLF fence delimiters");
    expect(measuredMixed.words).toBe(1101);
    expect(measuredMixed.within_cap).toBe(false);

    // And a wholly CRLF document measures the same, rather than refusing as an absent section.
    const crlf = body.join("\r\n");
    const measuredCrlf = measureRules(crlf, "a CRLF fixture");
    expect(measuredCrlf.words).toBe(1101);
    expect(measuredCrlf.within_cap).toBe(false);
    expect(measuredCrlf.text).toBe(measureRules(body.join("\n"), "the LF twin").text);
  });

  test("planted negative: a tilde fence and a nested longer fence hide nothing either", () => {
    const bulk = (word: string, times: number) => `${word} `.repeat(times).trim();
    for (const fence of [
      ["~~~", "~~~"],
      ["````", "````"],
    ] as const) {
      const document = [
        "# The Symposium Protocol",
        "",
        "## Rules",
        "",
        bulk("rule", 200),
        "",
        fence[0],
        "## Versioning",
        "```",
        fence[1],
        "",
        bulk("hidden", 900),
        "",
        "## Versioning",
        "",
      ].join("\n");
      const measured = measureRules(document, `a fixture fenced with ${fence[0]}`);
      expect(measured.within_cap).toBe(false);
      expect(measured.words).toBeGreaterThan(PROTOCOL_RULES_WORD_CAP);
    }
  });
});

describe("the package typechecks its own tests (B2)", () => {
  test("tsconfig includes the tests directory and Bun types", async () => {
    const raw = await Bun.file(new URL("../tsconfig.json", import.meta.url)).text();
    const config = JSON.parse(raw) as {
      include?: string[];
      compilerOptions?: { types?: string[] };
    };
    expect(config.include ?? []).toContain("tests/**/*.ts");
    expect(config.compilerOptions?.types ?? []).toContain("bun");
  });
});
