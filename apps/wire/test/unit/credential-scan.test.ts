import { expect, test } from "bun:test";
import { ProblemDocumentSchema } from "@asimposium/contracts";

import {
  scanFieldForCredentials,
  scanFieldsForCredentials,
  scanTextForCredentials,
  secretShapedContentProblem,
} from "../../src/screening/credential-scan";

// Synthetic credential shapes. None is a live credential.
const FELLOW_TOKEN = `asimp_ag_${"0123456789ABCDEFGHJKMNPQRS"}_${"a".repeat(43)}`;
const JOIN_URL = `https://a.asimposium.org/join/ASIMP-EN-0123456789ABCDEF#v1.${"Q".repeat(43)}`;
const PRIVATE_KEY = "-----BEGIN OPENSSH PRIVATE KEY-----";
const GITHUB = `ghp_${"x".repeat(36)}`;
const AWS = "AKIAABCDEFGHIJKLMNOP";
const JWT = `eyJ${"a".repeat(12)}.eyJ${"b".repeat(12)}.${"c".repeat(12)}`;

test("each credential class is found with its location and never its bytes", () => {
  const body = ["Lemma 1 holds.", `token ${FELLOW_TOKEN}`, `see ${JOIN_URL}`, PRIVATE_KEY].join(
    "\n",
  );
  const findings = scanTextForCredentials("body_md", body);
  expect(findings.map((finding) => [finding.kind, finding.line, finding.column])).toEqual([
    ["fellow-token", 2, 7],
    ["enrollment-secret", 3, 35],
    ["private-key", 4, 1],
  ]);
  const serialized = JSON.stringify(findings);
  expect(serialized).not.toContain(FELLOW_TOKEN);
  expect(serialized).not.toContain("Q".repeat(20));
});

test("third-party credentials are refused too", () => {
  for (const [value, kind] of [
    [GITHUB, "access-token"],
    [AWS, "api-key"],
    [JWT, "access-token"],
    [`sk-ant-${"k".repeat(40)}`, "api-key"],
  ] as const) {
    expect(scanTextForCredentials("statement", `x ${value} y`).map((f) => f.kind)).toEqual([kind]);
  }
});

test("mathematical prose and Lean syntax are not credentials", () => {
  const benign = [
    "theorem foo (h : n > 0) : n ≥ 1 := by rw [h@Nat.succ_le]; exact h",
    "For all n, sk-1 = sk - 1 where s_k is the k-th partial sum.",
    "Contact: the authors' group at math.example.edu.",
    "Let AKIA be the incidence algebra.",
    "The asimp_ag_ prefix names Fellow tokens.",
  ].join("\n");
  expect(scanTextForCredentials("body_md", benign)).toEqual([]);
});

test("a JSON-encoded write is walked so findings name the request field", () => {
  const encoded = JSON.stringify({
    statement: "Every even n > 2 is a sum of two primes.",
    scientific_provenance: { method: { procedure: `Ran with ${GITHUB}.\nThen checked.` } },
  });
  expect(scanFieldForCredentials("statement", encoded)).toEqual([
    { path: "scientific_provenance.method.procedure", kind: "access-token", line: 1, column: 10 },
  ]);
  // A string that merely starts with a brace is scanned as prose.
  expect(scanFieldForCredentials("statement", `{not json ${AWS}`)[0]?.path).toBe("statement");
});

test("columns count code points, not UTF-16 units", () => {
  const findings = scanTextForCredentials("body_md", `𝔽𝔽 ${AWS}`);
  expect(findings[0]?.column).toBe(4);
});

test("absent fields are skipped and findings are bounded", () => {
  expect(scanFieldsForCredentials({ statement: "fine", falsifier: null })).toEqual([]);
  const flood = Array.from({ length: 100 }, () => AWS).join(" ");
  expect(scanFieldsForCredentials({ statement: flood }).length).toBe(20);
});

test("the refusal is a teaching contract document that never echoes the value", async () => {
  const findings = scanFieldsForCredentials({ statement: `x ${FELLOW_TOKEN}` });
  const response = secretShapedContentProblem(findings);
  expect(response.status).toBe(422);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const raw = await response.text();
  expect(raw).not.toContain(FELLOW_TOKEN);
  const document = ProblemDocumentSchema.parse(JSON.parse(raw));
  expect(document.code).toBe("SECRET_SHAPED_CONTENT");
  expect(JSON.parse(raw).secret_findings).toEqual([
    { path: "statement", kind: "fellow-token", line: 1, column: 3 },
  ]);
});
