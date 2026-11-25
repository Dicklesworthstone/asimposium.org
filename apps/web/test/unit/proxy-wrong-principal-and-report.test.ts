import { describe, expect, test } from "bun:test";
import { REPORT_TARGET_PATTERN } from "@asimposium/contracts";
import { NextRequest } from "next/server";

import { isFellowBearerAuthorization, proxy } from "../../proxy.ts";

describe("Agora WRONG_PRINCIPAL guard for Fellow bearer tokens", () => {
  test("detects asimp_ag_ bearer tokens case-insensitively and ignores unrelated headers", () => {
    expect(isFellowBearerAuthorization("Bearer asimp_ag_01JXYZ_secretvalue")).toBe(true);
    expect(isFellowBearerAuthorization("  bearer   asimp_ag_01JXYZ_secretvalue")).toBe(true);
    expect(isFellowBearerAuthorization(null)).toBe(false);
    expect(isFellowBearerAuthorization("")).toBe(false);
    expect(isFellowBearerAuthorization("Bearer some-other-token")).toBe(false);
    expect(isFellowBearerAuthorization("Basic dXNlcjpwYXNz")).toBe(false);
  });

  test("returns 403 application/problem+json WRONG_PRINCIPAL without echoing the bearer secret", async () => {
    const secretToken = "asimp_ag_01JXYZ_SUPER_SECRET_NEVER_ECHO_9999";
    for (const pathname of ["/", "/console", "/p/P-4DSP"]) {
      const request = new NextRequest(`https://asimposium.org${pathname}`, {
        headers: { authorization: `Bearer ${secretToken}` },
      });
      const response = proxy(request);
      expect(response.status).toBe(403);
      expect(response.headers.get("content-type")).toBe("application/problem+json; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("content-security-policy")).toContain("script-src");

      const rawBody = await response.text();
      expect(rawBody).not.toContain(secretToken);
      expect(rawBody).not.toContain("SUPER_SECRET");
      const parsed = JSON.parse(rawBody) as Record<string, unknown>;
      expect(parsed.code).toBe("WRONG_PRINCIPAL");
      expect(parsed.status).toBe(403);
      expect(parsed.rule).toBe("A5");
      expect(String(parsed.fix_hint)).toContain("https://a.asimposium.org");
    }
  });

  test("allows ordinary anonymous and cookie-bearing human requests through with a CSP nonce", () => {
    const request = new NextRequest("https://asimposium.org/problems", {
      headers: { cookie: "asimp.session=opaque-cookie" },
    });
    const response = proxy(request);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("nonce-");
  });
});

describe("Canonical /report target grammar coverage", () => {
  test("accepts all canonical public ledger target kinds from @asimposium/contracts", () => {
    for (const valid of [
      "problem",
      "C-1",
      "C-42@3",
      "H-1",
      "E-01JXYZ1234",
      "R-01JXYZ1234",
      "G-7",
      "L-12",
      "DE-01JXYZ1234",
      "Q-01JXYZ1234",
      "CF-3",
      "SYNTH-01JXYZ1234",
    ]) {
      expect(REPORT_TARGET_PATTERN.test(valid)).toBe(true);
    }
  });

  test("PLANTED: rejects traversal, arbitrary prose, and malformed targets", () => {
    for (const invalid of [
      "",
      "../problem",
      "C-1@0",
      "W-01JXYZ",
      "problem?foo=1",
      "H-1#frag",
      "C-1/../../etc",
    ]) {
      expect(REPORT_TARGET_PATTERN.test(invalid)).toBe(false);
    }
  });
});
