import { describe, expect, test } from "bun:test";

import { buildJoinPasteBlock } from "../../app/console/join-paste.ts";

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
    expect(buildJoinPasteBlock(joinUrl("https://a-staging.asimposium.org.evil.invalid"))).toBeUndefined();
  });
});
