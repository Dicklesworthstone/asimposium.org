import { describe, expect, test } from "bun:test";
import {
  DIRECTOR_GRAMMAR_VERBS,
  type DirectorCommand,
  DirectorCommandSchema,
  evaluateDirectiveAttestation,
  formatDirectorCommand,
  ProtocolConflictSchema,
  parseDirectorCommand,
  SponsorDirectiveAttestationSchema,
} from "../../src/director-grammar.ts";

describe("Director Grammar Parser & Serializer", () => {
  test("all 11 closed verbs are recognized and listed", () => {
    expect(DIRECTOR_GRAMMAR_VERBS).toEqual([
      "assign",
      "focus",
      "forbid",
      "unfocus",
      "pause",
      "resume",
      "revoke",
      "transfer",
      "publish",
      "hide",
      "cap",
    ]);
  });

  describe("happy path parsing & round-tripping for all verbs", () => {
    const testCases: Array<{ name: string; input: string; expected: DirectorCommand }> = [
      {
        name: "assign without role",
        input: "assign FEL-12345678 P-SP4D",
        expected: {
          verb: "assign",
          fellow_id: "FEL-12345678",
          problem_id: "P-SP4D",
          role: undefined,
        },
      },
      {
        name: "assign with role critic",
        input: "assign FEL-12345678 P-SP4D as critic",
        expected: {
          verb: "assign",
          fellow_id: "FEL-12345678",
          problem_id: "P-SP4D",
          role: "critic",
        },
      },
      {
        name: "assign with role investigator",
        input: "assign fel_alpha P-TEST-01 as investigator",
        expected: {
          verb: "assign",
          fellow_id: "fel_alpha",
          problem_id: "P-TEST-01",
          role: "investigator",
        },
      },
      {
        name: "focus with text and Unicode",
        input: "focus FEL-12345678 Investigate lemma 3.1: ∀n > 2, 2n = p + q",
        expected: {
          verb: "focus",
          fellow_id: "FEL-12345678",
          text: "Investigate lemma 3.1: ∀n > 2, 2n = p + q",
        },
      },
      {
        name: "forbid with text",
        input: "forbid FEL-12345678 Do not promote conjecture without counterexample search",
        expected: {
          verb: "forbid",
          fellow_id: "FEL-12345678",
          text: "Do not promote conjecture without counterexample search",
        },
      },
      {
        name: "unfocus fellow",
        input: "unfocus FEL-12345678",
        expected: {
          verb: "unfocus",
          fellow_id: "FEL-12345678",
        },
      },
      {
        name: "pause fellow",
        input: "pause FEL-12345678",
        expected: {
          verb: "pause",
          fellow_id: "FEL-12345678",
        },
      },
      {
        name: "resume fellow",
        input: "resume FEL-12345678",
        expected: {
          verb: "resume",
          fellow_id: "FEL-12345678",
        },
      },
      {
        name: "revoke fellow",
        input: "revoke FEL-12345678",
        expected: {
          verb: "revoke",
          fellow_id: "FEL-12345678",
        },
      },
      {
        name: "transfer fellow to sponsor",
        input: "transfer FEL-12345678 usr_sponsor_bob",
        expected: {
          verb: "transfer",
          fellow_id: "FEL-12345678",
          target_sponsor_id: "usr_sponsor_bob",
        },
      },
      {
        name: "publish problem",
        input: "publish P-SP4D",
        expected: {
          verb: "publish",
          problem_id: "P-SP4D",
        },
      },
      {
        name: "hide problem with reason",
        input: "hide P-SP4D Duplicate statement discovered with P-PREV",
        expected: {
          verb: "hide",
          problem_id: "P-SP4D",
          reason: "Duplicate statement discovered with P-PREV",
        },
      },
      {
        name: "cap problem slots",
        input: "cap P-SP4D 16",
        expected: {
          verb: "cap",
          problem_id: "P-SP4D",
          limit: 16,
        },
      },
    ];

    for (const { name, input, expected } of testCases) {
      test(name, () => {
        const res = parseDirectorCommand(input);
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.command).toEqual(expected);

        // Schema validates parsed command
        expect(DirectorCommandSchema.safeParse(res.command).success).toBe(true);

        // Round-trip formatting
        const formatted = formatDirectorCommand(res.command);
        const reparsed = parseDirectorCommand(formatted);
        expect(reparsed.ok).toBe(true);
        if (reparsed.ok) {
          expect(reparsed.command).toEqual(expected);
        }
      });
    }
  });

  describe("whitespace and case-insensitivity robustness", () => {
    test("handles extra whitespace and mixed case verbs", () => {
      const res = parseDirectorCommand("   FOCUS    FEL-12345678   Work on step 2  ");
      expect(res.ok).toBe(true);
      if (res.ok && res.command.verb === "focus") {
        expect(res.command.verb).toBe("focus");
        expect(res.command.fellow_id).toBe("FEL-12345678");
        expect(res.command.text).toBe("Work on step 2");
      }
    });

    test("handles tab characters in whitespace", () => {
      const res = parseDirectorCommand("assign\tFEL-12345678\tP-SP4D\tas\tcritic");
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.command).toEqual({
          verb: "assign",
          fellow_id: "FEL-12345678",
          problem_id: "P-SP4D",
          role: "critic",
        });
      }
    });
  });

  describe("limits & bounds enforcement", () => {
    test("focus text up to 500 characters passes", () => {
      const text500 = "a".repeat(500);
      const res = parseDirectorCommand(`focus FEL-12345678 ${text500}`);
      expect(res.ok).toBe(true);
      if (res.ok && res.command.verb === "focus") {
        expect(res.command.text.length).toBe(500);
      }
    });

    test("focus text exceeding 500 characters returns DIRECTIVE_TEXT_OVER_LIMIT with count", () => {
      const text501 = "a".repeat(501);
      const res = parseDirectorCommand(`focus FEL-12345678 ${text501}`);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe("DIRECTIVE_TEXT_OVER_LIMIT");
        expect(res.limit).toBe(500);
        expect(res.actual).toBe(501);
        expect(res.message).toContain("focus text capped at 500 characters (received 501)");
        expect(res.verbs).toEqual(DIRECTOR_GRAMMAR_VERBS);
      }
    });

    test("forbid text exceeding 500 characters returns DIRECTIVE_TEXT_OVER_LIMIT with count", () => {
      const text600 = "b".repeat(600);
      const res = parseDirectorCommand(`forbid FEL-12345678 ${text600}`);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe("DIRECTIVE_TEXT_OVER_LIMIT");
        expect(res.limit).toBe(500);
        expect(res.actual).toBe(600);
      }
    });

    test("cap problem between 1 and 16 is accepted", () => {
      const minCap = parseDirectorCommand("cap P-SP4D 1");
      expect(minCap.ok).toBe(true);
      const maxCap = parseDirectorCommand("cap P-SP4D 16");
      expect(maxCap.ok).toBe(true);
    });

    test("cap below 1 or above 16 is rejected with INVALID_PROBLEM_CAP", () => {
      const zeroCap = parseDirectorCommand("cap P-SP4D 0");
      expect(zeroCap.ok).toBe(false);
      if (!zeroCap.ok) {
        expect(zeroCap.code).toBe("INVALID_PROBLEM_CAP");
      }

      const overCap = parseDirectorCommand("cap P-SP4D 17");
      expect(overCap.ok).toBe(false);
      if (!overCap.ok) {
        expect(overCap.code).toBe("INVALID_PROBLEM_CAP");
      }

      const nonIntCap = parseDirectorCommand("cap P-SP4D unlimited");
      expect(nonIntCap.ok).toBe(false);
      if (!nonIntCap.ok) {
        expect(nonIntCap.code).toBe("INVALID_PROBLEM_CAP");
      }
    });
  });

  describe("free-text recovery & closed-verb returning errors", () => {
    test("empty line returns EMPTY_COMMAND with supported verbs", () => {
      const res = parseDirectorCommand("   ");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe("EMPTY_COMMAND");
        expect(res.verbs).toEqual(DIRECTOR_GRAMMAR_VERBS);
      }
    });

    test("unknown verb returns UNKNOWN_DIRECTOR_VERB with supported verbs", () => {
      const res = parseDirectorCommand("destroy FEL-12345678");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe("UNKNOWN_DIRECTOR_VERB");
        expect(res.message).toContain('Unknown directive verb "destroy"');
        expect(res.verbs).toEqual(DIRECTOR_GRAMMAR_VERBS);
      }
    });

    test("missing arguments return hints", () => {
      const res1 = parseDirectorCommand("focus FEL-12345678");
      expect(res1.ok).toBe(false);

      const res2 = parseDirectorCommand("assign FEL-12345678");
      expect(res2.ok).toBe(false);

      const res3 = parseDirectorCommand("transfer FEL-12345678");
      expect(res3.ok).toBe(false);

      const res4 = parseDirectorCommand("hide P-SP4D");
      expect(res4.ok).toBe(false);
    });

    test("extra arguments on unary commands are rejected", () => {
      const res = parseDirectorCommand("unfocus FEL-12345678 please do something else");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe("INVALID_DIRECTOR_COMMAND");
        expect(res.message).toContain("takes only a <fellow> argument");
      }
    });
  });
});

describe("Protocol Conflict Contract (Fable §8.2)", () => {
  test("valid protocol conflict parses and passes validation", () => {
    const valid = {
      directive_id: "DIR-0123456789abcdef0123456789abcdef",
      fellow_id: "FEL-12345678",
      problem_id: "P-SP4D",
      rule_cited: "Rule A4",
      refused_part: "assert PROVED without counterexample search",
      explanation:
        "Sponsor directive requested asserting a proved status without independent refutation check.",
      timestamp: 1786000000000,
    };
    const parsed = ProtocolConflictSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
  });

  test("rejects protocol conflict with malformed directive ID", () => {
    const invalid = {
      directive_id: "not-a-dir-id",
      fellow_id: "FEL-12345678",
      rule_cited: "Rule A4",
      refused_part: "refused",
      explanation: "explanation",
      timestamp: 1786000000000,
    };
    const parsed = ProtocolConflictSchema.safeParse(invalid);
    expect(parsed.success).toBe(false);
  });
});

describe("Sponsor Disclosure Attestation Gate (Fable §8.2, Bead 0i9)", () => {
  test("sponsor attesting no undisclosed directives passes gate", () => {
    const attestation = SponsorDirectiveAttestationSchema.parse({
      attested_no_undisclosed_directives: true,
      disclosed_directives: [],
      unresolved_transferred_directives: [],
    });
    const result = evaluateDirectiveAttestation(attestation);
    expect(result.eligible).toBe(true);
  });

  test("sponsor disclosing material directives passes gate", () => {
    const attestation = SponsorDirectiveAttestationSchema.parse({
      attested_no_undisclosed_directives: false,
      disclosed_directives: [
        {
          directive_id: "DIR-0123456789abcdef0123456789abcdef",
          sponsor_id: "usr_sponsor_alice",
          scope: "lemma-3-direction",
          summary: "Suggested testing branch with n=6 mod 4",
          authored_by_current_sponsor: true,
        },
      ],
      unresolved_transferred_directives: [],
    });
    const result = evaluateDirectiveAttestation(attestation);
    expect(result.eligible).toBe(true);
  });

  test("missing attestation fails with directive_disclosure_missing", () => {
    const attestation = SponsorDirectiveAttestationSchema.parse({
      attested_no_undisclosed_directives: false,
      disclosed_directives: [],
      unresolved_transferred_directives: [],
    });
    const result = evaluateDirectiveAttestation(attestation);
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.code).toBe("directive_disclosure_missing");
    }
  });

  test("transfer-aware gate blocks when pre-transfer directives lack prior sponsor resolution", () => {
    const attestation = SponsorDirectiveAttestationSchema.parse({
      attested_no_undisclosed_directives: true,
      disclosed_directives: [],
      unresolved_transferred_directives: [
        {
          directive_id: "DIR-0123456789abcdef0123456789abcdef",
          prior_sponsor_id: "usr_prior_sponsor",
          received_at: 1785000000000,
        },
      ],
    });
    const result = evaluateDirectiveAttestation(attestation);
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.code).toBe("directive_disclosure_unresolved");
      expect(result.reason).toContain("lack resolved attestation from prior sponsor");
    }
  });
});
