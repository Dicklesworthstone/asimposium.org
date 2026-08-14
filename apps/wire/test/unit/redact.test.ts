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

  test("redacts an enrollment fragment secret that leaked into the path", () => {
    expect(redactPathname("/join/v1.9f2c")).toBe("/join/<redacted>");
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
