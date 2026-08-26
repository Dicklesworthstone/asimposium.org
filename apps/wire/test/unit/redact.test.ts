import { describe, expect, test } from "bun:test";
import { redactPathname } from "../../src/http/redact";

describe("redactPathname", () => {
  test("leaves ordinary route shapes intact", () => {
    expect(redactPathname("/internal/health")).toBe("/internal/health");
    expect(redactPathname("/v1/sessions")).toBe("/v1/sessions");
    expect(redactPathname("/p/smooth-poincare-4d/claims.md")).toBe(
      "/p/smooth-poincare-4d/claims.md",
    );
    expect(redactPathname("/join/ASIMP-EN-01JXYZ")).toBe("/join/ASIMP-EN-01JXYZ");
    expect(redactPathname("/")).toBe("/");
  });

  test("redacts a Fellow bearer token wherever it appears", () => {
    expect(redactPathname("/v1/asimp_ag_abcdefghijklmnop")).toBe("/v1/<redacted>");
    expect(redactPathname("/asimp_ag_x/sessions")).toBe("/<redacted>/sessions");
  });

  test("redacts a token prefix regardless of case or length", () => {
    expect(redactPathname("/ASIMP_AG_short")).toBe("/<redacted>");
    expect(redactPathname("/asimp_")).toBe("/<redacted>");
  });

  test("redacts percent-encoded credential prefixes before they can be echoed", () => {
    expect(redactPathname("/%61simp_ag_x")).toBe("/<redacted>");
    expect(redactPathname("/ASIMP%5fAG_short")).toBe("/<redacted>");
    expect(redactPathname("/join/v1%2E9f2c")).toBe("/join/<redacted>");
    expect(redactPathname("/poll/%66low_v1.aabb")).toBe("/poll/<redacted>");
  });

  test("redacts nested encoding and prefixes behind encoded path boundaries", () => {
    expect(redactPathname("/%2561simp_ag_x")).toBe("/<redacted>");
    expect(redactPathname("/%252561simp_ag_x")).toBe("/<redacted>");
    expect(redactPathname("/safe%2Fasimp_ag_x")).toBe("/<redacted>");
    expect(redactPathname("/safe%252Fv1.9f2c")).toBe("/<redacted>");
  });

  test("redacts an enrollment fragment secret that leaked into the path", () => {
    expect(redactPathname("/join/v1.9f2c")).toBe("/join/<redacted>");
  });

  test("redacts an enrollment flow handle at any length, even below the shape floor", () => {
    // A full minted handle is long enough that the length rule would catch it;
    // the prefix rule is what refuses a SHORT remainder, mirroring the
    // canonical scanner's terminal-clipped class for this self-declaring
    // family (bead asimposiumorg-233.1).
    expect(redactPathname("/poll/flow_v1.aabbccddeeff")).toBe("/poll/<redacted>");
    expect(redactPathname("/flow_v1.")).toBe("/<redacted>");
  });

  test("keeps versioned workflow references that merely contain the prefix", () => {
    expect(redactPathname("/runs/workflow_v1.config")).toBe("/runs/workflow_v1.config");
    expect(redactPathname("/runs/work%66low_v1.config")).toBe("/runs/work%66low_v1.config");
  });

  test("redacts any segment longer than a legitimate route segment", () => {
    const long = "a".repeat(25);
    expect(redactPathname(`/p/${long}`)).toBe("/p/<redacted>");
  });

  test("keeps a segment at exactly the length limit", () => {
    const boundary = "b".repeat(24);
    expect(redactPathname(`/p/${boundary}`)).toBe(`/p/${boundary}`);
  });

  test("truncates a pathological path instead of echoing it whole", () => {
    const deep = `/${Array.from({ length: 40 }, (_, i) => `s${i}`).join("/")}`;
    const redacted = redactPathname(deep);

    expect(redacted.endsWith("/...")).toBe(true);
    expect(redacted.length).toBeLessThan(deep.length);
    expect(redacted).not.toContain("s39");
  });

  test("is deterministic", () => {
    const path = "/v1/asimp_ag_deadbeef/pack";
    expect(redactPathname(path)).toBe(redactPathname(path));
  });

  test("never returns a string containing a credential prefix it was given", () => {
    for (const path of [
      "/asimp_ag_tokenvalue",
      "/a/b/asimp_ag_tokenvalue",
      "/v1.secretfragmentvalue",
      `/${"z".repeat(64)}`,
    ]) {
      const redacted = redactPathname(path);
      expect(redacted).not.toContain("tokenvalue");
      expect(redacted).not.toContain("secretfragmentvalue");
      expect(redacted).not.toContain("zzzz");
    }
  });
});
