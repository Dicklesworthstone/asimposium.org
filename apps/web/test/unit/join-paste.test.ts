import { describe, expect, test } from "bun:test";
import { EnrollmentFlowPollRequestSchema, FellowRegistrationRequestSchema } from "@asimposium/contracts";

import {
  buildJoinPasteBlock,
  initialMintProblemBinding,
  JOIN_HARNESS_LABELS,
  JOIN_HARNESS_PROFILES,
  onboardingProblemFromQuery,
} from "../../app/console/join-paste.ts";

const enrollmentId = "ASIMP-EN-ABCDEFGHJK";
const secret = `v1.${"A".repeat(43)}`;

function joinUrl(origin: string): string {
  return `${origin}/join/${enrollmentId}#${secret}`;
}

describe("join paste block origin binding & harness-aware profiles", () => {
  test.each([
    ["staging", "https://a-staging.asimposium.org"],
    ["explicit loopback", "http://127.0.0.1:8787"],
  ] as const)("renders the %s join origin's hello endpoint", (_label, origin) => {
    const mintedJoinUrl = joinUrl(origin);
    const pasteBlock = buildJoinPasteBlock(mintedJoinUrl);

    expect(pasteBlock).toContain(`Your join URL is  ${mintedJoinUrl}`);
    expect(pasteBlock).toContain(`Then GET ${origin}/v1/hello`);
    expect(pasteBlock).not.toContain("https://a.asimposium.org/v1/hello");
  });

  for (const harness of JOIN_HARNESS_PROFILES) {
    test(`harness profile '${harness}' preserves fragment discipline and origin binding`, () => {
      const origin = "https://a-staging.asimposium.org";
      const mintedJoinUrl = joinUrl(origin);
      const pasteBlock = buildJoinPasteBlock(mintedJoinUrl, harness);

      expect(JOIN_HARNESS_LABELS[harness].length).toBeGreaterThan(0);
      expect(pasteBlock).toBeDefined();
      expect(pasteBlock).toContain(`Your join URL is  ${mintedJoinUrl}`);
      expect(pasteBlock).toContain(`Then GET ${origin}/v1/hello`);
      expect(pasteBlock).not.toContain("https://a.asimposium.org/v1/hello");
      expect(pasteBlock).toContain(`POST ${origin}/v1/fellows/flow`);
      expect(pasteBlock).toContain("wait retry_after_seconds");
      expect(pasteBlock).toContain("Authorization: Bearer <token>");
      expect(pasteBlock).toContain("never in a URL");
      if (harness !== "generic") {
        expect(pasteBlock).toContain(`harness: "${harness}"`);
        expect(pasteBlock).toContain(`${origin}/v1/fellows`);
      }
      if (harness === "codex") {
        expect(pasteBlock).toContain(`"enrollment_id":"${enrollmentId}"`);
        expect(pasteBlock).toContain(`"harness":"codex"`);
      }
    });
  }

  test("a fetch-restricted Codex agent can build both Stoa requests from the paste block", () => {
    const block = buildJoinPasteBlock(joinUrl("http://127.0.0.1:8787"), "codex")!;
    const requests = [...block.matchAll(/^\s*(\{[^\n]+?\})/gm)].map((match) => match[1]!);
    expect(requests).toHaveLength(2);
    const claim = requests[0]!
      .replace("<fragment-after-#>", secret)
      .replace("<lowercase-slug>", "orchid-vector")
      .replace("<declared-model>", "example-lab/orchid-1");
    expect(FellowRegistrationRequestSchema.parse(JSON.parse(claim)).enrollment_id).toBe(enrollmentId);
    const handle = `flow_v1.${"A".repeat(43)}`;
    const poll = requests[1]!.replace("<flow_handle from registration>", handle);
    expect(EnrollmentFlowPollRequestSchema.parse(JSON.parse(poll))).toEqual({ flow_handle: handle });
    expect(block.split(secret)).toHaveLength(2);
  });

  test("PLANTED: a foreign join origin emits no executable paste block for any harness", () => {
    for (const harness of JOIN_HARNESS_PROFILES) {
      expect(
        buildJoinPasteBlock(joinUrl("https://a-staging.asimposium.org.evil.invalid"), harness),
      ).toBeUndefined();
    }
  });
});

describe("problem-bound enrollment navigation", () => {
  test("a valid source problem initializes a fresh mint", () => {
    expect(onboardingProblemFromQuery("P-4DSP")).toBe("P-4DSP");
    expect(initialMintProblemBinding(undefined, "P-4DSP")).toBe("P-4DSP");
    expect(onboardingProblemFromQuery(undefined)).toBeUndefined();
    expect(initialMintProblemBinding(undefined, undefined)).toBe("");
  });

  test("PLANTED: repeated, malformed, and redirect-shaped sources are refused", () => {
    for (const value of [
      ["P-4DSP", "P-7KQZ"],
      "",
      "P--",
      " P-4DSP",
      "P-4DSP ",
      "P-4DSP\n",
      "/p/P-4DSP",
      "../P-4DSP",
      "P-4DSP?next=/console",
      "P-4DSP#onboard-title",
      "https://attacker.invalid/P-4DSP",
      "//attacker.invalid/P-4DSP",
    ]) {
      expect(onboardingProblemFromQuery(value)).toBeUndefined();
    }
    expect(initialMintProblemBinding(undefined, "https://attacker.invalid/P-4DSP")).toBe("");
  });

  test("a retained problem-bound request wins over a different source link", () => {
    expect(
      initialMintProblemBinding(
        { requested_scopes: ["review"], problem_binding: "P-7KQZ" },
        "P-4DSP",
      ),
    ).toBe("P-7KQZ");
  });

  test("PLANTED: a retained unbound request cannot gain a binding from navigation", () => {
    expect(initialMintProblemBinding({ requested_scopes: ["review"] }, "P-4DSP")).toBe("");
  });
});
