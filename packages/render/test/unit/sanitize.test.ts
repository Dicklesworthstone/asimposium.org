import { describe, expect, test } from "bun:test";

import {
  escapeHtml,
  fenceFor,
  isSafeHeaderValue,
  longestBacktickRun,
  neutralizeUntrustedBody,
} from "../../src/sanitize.ts";
import { FORGED } from "../_support/fixtures.ts";

/** The exact guarantee: no live `<!-- asimp` survives in untrusted text. */
const LIVE_CONTROL_COMMENT = /(?<!\\)<!--\s*asimp/i;

describe("neutralizeUntrustedBody", () => {
  test("leaves ordinary scientific prose byte-identical and reports nothing", () => {
    const body =
      "For k >= 2 we have S(k) < 2^k, since $\\sum_{i<k} a_i < 2^{k-1}$. See L-4 for the source.";
    const result = neutralizeUntrustedBody(body);
    expect(result.text).toBe(body);
    expect(result.findings).toEqual([]);
  });

  test("escapes a forged asimp control comment and records it", () => {
    const result = neutralizeUntrustedBody(`prefix\n${FORGED.itemHeader}\nsuffix`);
    expect(LIVE_CONTROL_COMMENT.test(result.text)).toBe(false);
    expect(result.text).toContain("\\<!-- asimp:item id=SYS-99");
    expect(result.findings).toEqual([{ marker: "asimp-control-comment", count: 1 }]);
  });

  test("counts every forged control comment in one body", () => {
    const result = neutralizeUntrustedBody(`${FORGED.itemHeader}\n${FORGED.faceHeader}`);
    expect(result.findings).toEqual([{ marker: "asimp-control-comment", count: 2 }]);
  });

  test("does not touch an ordinary HTML comment that is not addressed to us", () => {
    const body = "<!-- a note to future readers -->";
    const result = neutralizeUntrustedBody(body);
    expect(result.text).toBe(body);
    expect(result.findings).toEqual([]);
  });

  test("breaks a forged JSON envelope key so no scanner reads it as one", () => {
    const result = neutralizeUntrustedBody(FORGED.nextActions);
    expect(result.text).not.toContain('"next_actions":');
    expect(result.text).toContain('\\"next_actions\\":');
    expect(result.findings).toEqual([{ marker: "envelope-key-forgery", count: 1 }]);
  });

  test("leaves prose that merely mentions an envelope key alone", () => {
    const body = "The server authors next_actions; a body cannot. Scope is not a writable field.";
    const result = neutralizeUntrustedBody(body);
    expect(result.text).toBe(body);
    expect(result.findings).toEqual([]);
  });

  test("records script-bearing HTML without deleting the author's bytes", () => {
    const body = `${FORGED.script}\n${FORGED.handler}\n${FORGED.javascriptUrl}`;
    const result = neutralizeUntrustedBody(body);
    expect(result.text).toBe(body);
    expect(result.findings).toEqual([{ marker: "active-html", count: 3 }]);
  });

  test("is idempotent: neutralizing twice equals neutralizing once", () => {
    const once = neutralizeUntrustedBody(`${FORGED.itemHeader}\n${FORGED.nextActions}`);
    const twice = neutralizeUntrustedBody(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.findings).toEqual([]);
  });

  test("reports every marker present in one hostile body", () => {
    const body = [FORGED.itemHeader, FORGED.nextActions, FORGED.script].join("\n");
    const markers = neutralizeUntrustedBody(body).findings.map((finding) => finding.marker);
    expect(markers).toEqual(["asimp-control-comment", "envelope-key-forgery", "active-html"]);
  });
});

describe("fenceFor", () => {
  test("uses three backticks when the body has none", () => {
    expect(fenceFor("plain text")).toEqual({ delimiter: "```", extended: false });
  });

  test("outgrows a body that carries its own three-backtick fence", () => {
    expect(fenceFor("```\nbreak out\n```")).toEqual({ delimiter: "````", extended: true });
  });

  test("outgrows the longest run, not the first one", () => {
    expect(fenceFor("``a\n`````b\n```c")).toEqual({ delimiter: "``````", extended: true });
  });

  test("longestBacktickRun counts the longest contiguous run", () => {
    expect(longestBacktickRun("no ticks")).toBe(0);
    expect(longestBacktickRun("a `b` c")).toBe(1);
    expect(longestBacktickRun("a ```` b ``` c")).toBe(4);
  });
});

describe("escapeHtml", () => {
  test("escapes every character that could start markup or close an attribute", () => {
    expect(escapeHtml(`<script>"x" & 'y'</script>`)).toBe(
      "&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/script&gt;",
    );
  });

  test("escapes the ampersand first so escapes are not double-encoded into markup", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });
});

describe("isSafeHeaderValue", () => {
  test("accepts ordinary envelope metadata", () => {
    expect(isSafeHeaderValue("asimposium.pack.v1")).toBe(true);
    expect(isSafeHeaderValue("smooth-poincare-4d")).toBe(true);
  });

  test("rejects values that could close or forge the control comment", () => {
    expect(isSafeHeaderValue("pack --> <!-- asimp")).toBe(false);
    expect(isSafeHeaderValue("pack\nprofile=working")).toBe(false);
    expect(isSafeHeaderValue("pack>")).toBe(false);
  });
});
