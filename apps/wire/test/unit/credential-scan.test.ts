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

const escaped = (value: string) =>
  Array.from(
    value,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  ).join("");

test("every JSON leaf is inspected beyond the former 512-leaf cutoff", () => {
  const values = Array.from({ length: 2048 }, () => "ordinary scientific data");
  values.push(GITHUB);
  const findings = scanFieldForCredentials("body_md", JSON.stringify(values));
  expect(findings).toEqual([{ path: "body_md[2048]", kind: "access-token", line: 1, column: 1 }]);
  const object = Object.fromEntries(values.map((value, index) => [`field_${index}`, value]));
  expect(scanFieldForCredentials("request", JSON.stringify(object))[0]?.path).toBe("field_2048");
});

test("JSON keys are screened without exposing their bytes through diagnostic paths", async () => {
  for (const key of [GITHUB, FELLOW_TOKEN, PRIVATE_KEY]) {
    const onlyKey = scanFieldForCredentials("body_md", JSON.stringify({ [key]: "ordinary" }));
    expect(onlyKey.length).toBeGreaterThan(0);
    expect(onlyKey[0]?.path).toBe("[key:0]");
    const nested = scanFieldForCredentials("request", JSON.stringify({ [key]: { inner: AWS } }));
    expect(nested.some((finding) => finding.path === "[entry:0].inner")).toBe(true);
    const response = await secretShapedContentProblem(nested).text();
    for (const canary of [key, AWS]) {
      expect(JSON.stringify(nested)).not.toContain(canary);
      expect(response).not.toContain(canary);
    }
    expect(ProblemDocumentSchema.safeParse(JSON.parse(response)).success).toBe(true);
  }
});

test("escaped keys and shadowed duplicate values cannot disappear during JSON scanning", () => {
  const key = `{"${escaped(GITHUB)}":"ordinary"}`;
  const duplicate = `{"payload":"${escaped(GITHUB)}","payload":"ordinary"}`;
  expect(scanFieldForCredentials("body_md", key)).toEqual([
    { path: "[key:0]", kind: "access-token", line: 1, column: 1 },
  ]);
  expect(JSON.parse(duplicate)).toEqual({ payload: "ordinary" });
  expect(scanFieldForCredentials("body_md", duplicate)).toEqual([
    { path: "payload", kind: "access-token", line: 1, column: 1 },
  ]);
});

test("JSON-encoded workshop source and scalar strings retain decoded credential detection", () => {
  const source = `{"payload":"${escaped(GITHUB)}","payload":"ordinary"}`;
  const request = JSON.stringify({ body_md: source });
  expect(scanFieldForCredentials("request", request)).toEqual([
    { path: "body_md.payload", kind: "access-token", line: 1, column: 1 },
  ]);
  expect(scanFieldForCredentials("body_md", `"${escaped(AWS)}"`)).toEqual([
    { path: "body_md", kind: "api-key", line: 1, column: 1 },
  ]);
  const layered = JSON.stringify({ body_md: JSON.stringify(source) });
  expect(
    scanFieldForCredentials("request", layered).some((finding) => finding.kind === "access-token"),
  ).toBe(true);
  expect(scanFieldForCredentials("request", JSON.stringify({ [source]: "ordinary" }))).toEqual([
    { path: "[key:0].payload", kind: "access-token", line: 1, column: 1 },
  ]);
});

test("deep JSON cannot overflow recursion and falsely report an escaped credential clean", () => {
  const depth = 20_000;
  const source = `${"[".repeat(depth)}"${escaped(GITHUB)}"${"]".repeat(depth)}`;
  const findings = scanFieldForCredentials("body_md", source);
  expect(findings).toEqual([{ path: "[nested-field]", kind: "access-token", line: 1, column: 1 }]);
  expect(JSON.stringify(findings)).not.toContain(GITHUB);
});

test("dense credential floods retain at most twenty useful locations", () => {
  const findings = scanTextForCredentials(
    "body_md",
    Array.from({ length: 10_000 }, () => AWS).join(" "),
  );
  expect(findings).toHaveLength(20);
  expect(findings.at(-1)?.column).toBe(19 * (AWS.length + 1) + 1);
});

test("the response boundary redacts unsafe supplied locations and benign JSON remains clean", async () => {
  const response = await secretShapedContentProblem([
    { path: GITHUB, kind: "api-key", line: 1, column: 1 },
  ]).text();
  expect(response).not.toContain(GITHUB);
  expect(JSON.parse(response).secret_findings[0].path).toBe("[redacted-field]");
  expect(
    scanFieldForCredentials(
      "body_md",
      JSON.stringify({
        statement: "For every n, sk-1 = sk - 1.",
        "arbitrary field": { proof: "by rw [h@Nat.succ_le]; exact h" },
        vector: [0, 1, 2],
        source: JSON.stringify({ lemma: "Let AKIA be the incidence algebra." }),
      }),
    ),
  ).toEqual([]);
});
