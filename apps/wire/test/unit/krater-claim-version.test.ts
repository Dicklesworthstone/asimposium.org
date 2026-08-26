import { describe, expect, test } from "bun:test";

import { claimContentDigest, mintClaimVersion } from "../../src/krater/claim-version.ts";

async function sha(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const CONTENT = {
  kind: "conjecture",
  statement: "The map factors.",
  falsifier: "A counterexample.",
};

describe("P9 claim version minting", () => {
  test("an edit mints the next version with a content digest and resets to open", async () => {
    const mint = await mintClaimVersion({
      currentVersion: 2,
      newContent: CONTENT,
      editorFellowId: "F-1",
      sha256Hex: sha,
    });
    expect(mint.version).toBe(3);
    expect(mint.dispositionAfter).toBe("open");
    expect(mint.contentDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(mint.editorFellowId).toBe("F-1");
  });

  test("the content digest is over the semantic content only — identical content digests identically", async () => {
    const a = await claimContentDigest(CONTENT, sha);
    const b = await claimContentDigest({ ...CONTENT }, sha);
    expect(a).toBe(b);
    // A different statement digests differently.
    const c = await claimContentDigest({ ...CONTENT, statement: "A different claim." }, sha);
    expect(c).not.toBe(a);
  });

  test("a falsifier change is a new digest (the pin is over the exact version)", async () => {
    const withFalsifier = await claimContentDigest(CONTENT, sha);
    const without = await claimContentDigest({ ...CONTENT, falsifier: null }, sha);
    expect(withFalsifier).not.toBe(without);
  });

  test("an invalid current version is refused", async () => {
    for (const currentVersion of [-1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(
        mintClaimVersion({
          currentVersion,
          newContent: CONTENT,
          editorFellowId: "F-1",
          sha256Hex: sha,
        }),
      ).rejects.toThrow("CLAIM_VERSION_INVALID");
    }
  });

  test("the largest mintable current version stays inside the safe range", async () => {
    const mint = await mintClaimVersion({
      currentVersion: Number.MAX_SAFE_INTEGER - 1,
      newContent: CONTENT,
      editorFellowId: "F-1",
      sha256Hex: sha,
    });
    expect(mint.version).toBe(Number.MAX_SAFE_INTEGER);
  });
});
