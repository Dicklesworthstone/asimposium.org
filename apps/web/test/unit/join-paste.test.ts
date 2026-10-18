import { describe, expect, test } from "bun:test";

import {
  buildJoinPasteBlock,
  initialMintProblemBinding,
  onboardingProblemFromQuery,
} from "../../app/console/join-paste.ts";

const enrollmentId = "ASIMP-EN-ABCDEFGHJK";
const secret = `v1.${"A".repeat(43)}`;

function joinUrl(origin: string): string {
  return `${origin}/join/${enrollmentId}#${secret}`;
}

describe("join paste block origin binding", () => {
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

  test("PLANTED: a foreign join origin emits no executable paste block", () => {
    expect(
      buildJoinPasteBlock(joinUrl("https://a-staging.asimposium.org.evil.invalid")),
    ).toBeUndefined();
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
