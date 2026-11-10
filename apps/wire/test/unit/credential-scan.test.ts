import { expect, test } from "bun:test";
import {
  EnrollmentFlowHandleSchema,
  EnrollmentSecretSchema,
  ProblemDocumentSchema,
} from "@asimposium/contracts";
import { bodyLooksSecretShaped, scanBodyForSecrets } from "../../src/krater/cas";

import {
  scanFieldForCredentials,
  scanFieldsForCredentials,
  scanTextForCredentials,
  secretShapedContentProblem,
} from "../../src/screening/credential-scan";

// Synthetic credential shapes. None is a live credential.
const FELLOW_TOKEN = `asimp_ag_${"0123456789ABCDEFGHJKMNPQRS"}_${"a".repeat(43)}`;
const JOIN_URL = `https://a.asimposium.org/join/ASIMP-EN-0123456789ABCDEF#v1.${"Q".repeat(43)}`;
const ENROLLMENT_SECRET = `v1.${"Q".repeat(43)}`;
const FLOW_HANDLE = `flow_v1.${"r".repeat(43)}`;
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

test("body-only enrollment and device credentials are refused by text and artifact scans", async () => {
  expect(EnrollmentSecretSchema.safeParse(ENROLLMENT_SECRET).success).toBe(true);
  expect(EnrollmentFlowHandleSchema.safeParse(FLOW_HANDLE).success).toBe(true);
  for (const [value, kind] of [
    [ENROLLMENT_SECRET, "enrollment-secret"],
    [FLOW_HANDLE, "prefixed-grant"],
  ] as const) {
    const body = `Notes\n𝔽 ${value}.`;
    const findings = scanTextForCredentials("body_md", body);
    expect(findings).toEqual([{ path: "body_md", kind, line: 2, column: 3 }]);
    expect(scanBodyForSecrets(body)).toEqual([{ kind, line: 2, column: 3 }]);
    const response = await secretShapedContentProblem(findings).text();
    expect(ProblemDocumentSchema.parse(JSON.parse(response)).code).toBe("SECRET_SHAPED_CONTENT");
    expect(response).not.toContain(value);
    expect(JSON.stringify(findings)).not.toContain(value);
    expect(scanTextForCredentials("body_md", `${value}extra`)).toHaveLength(1);
  }
  expect(scanBodyForSecrets(JOIN_URL)).toEqual([
    { kind: "enrollment-secret", line: 1, column: 31 },
  ]);
});

test("mathematical prose and Lean syntax are not credentials", () => {
  const benign = [
    "theorem foo (h : n > 0) : n ≥ 1 := by rw [h@Nat.succ_le]; exact h",
    "For all n, sk-1 = sk - 1 where s_k is the k-th partial sum.",
    "Contact: the authors' group at math.example.edu.",
    "Let AKIA be the incidence algebra.",
    "The asimp_ag_ prefix names Fellow tokens.",
    "Protocol v1.2, v1.0-rc1-build-2026 and capsule.v1.json are version labels.",
    `A dotted version is v1.${"1.".repeat(25)}0.`,
    `The identifier workflow_v1.${"x".repeat(43)} is not a polling credential.`,
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
  for (const key of [GITHUB, FELLOW_TOKEN, PRIVATE_KEY, ENROLLMENT_SECRET, FLOW_HANDLE]) {
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

test("escaped body-only credentials survive JSON token and duplicate-key screening", () => {
  for (const [value, kind] of [
    [ENROLLMENT_SECRET, "enrollment-secret"],
    [FLOW_HANDLE, "prefixed-grant"],
  ] as const) {
    const source = `{"payload":"${escaped(value)}","payload":"ordinary"}`;
    expect(scanFieldForCredentials("request", JSON.stringify({ body_md: source }))).toEqual([
      { path: "body_md.payload", kind, line: 1, column: 1 },
    ]);
    expect(scanFieldForCredentials("body_md", `{"${escaped(value)}":"ordinary"}`)).toEqual([
      { path: "[key:0]", kind, line: 1, column: 1 },
    ]);
  }
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

test("credential-labelled assignments catch prefixed names and weak literal values", async () => {
  for (const [assignment, kind] of [
    ["DB_PASSWORD=synthetic-db-secret", "access-token"],
    ["export GITHUB_TOKEN='synthetic-github-secret'", "access-token"],
    ['STRIPE_SECRET="synthetic-stripe-secret"', "access-token"],
    ["MY_API_KEY=synthetic-api-secret", "api-key"],
    ["service_apiKey = 'synthetic-api-secret'", "api-key"],
    ["password=x", "access-token"],
    ["PASSWORD=0", "access-token"],
    ["CLIENT_SECRET=changeme", "access-token"],
    ["REFRESH_TOKEN=test", "access-token"],
    ["DB_PASSWORD=p(a)[s]s", "access-token"],
    ["AWS_SECRET_ACCESS_KEY=synthetic-aws-secret", "api-key"],
    ['const config={DB_PASSWORD:"synthetic-nested-secret"};', "access-token"],
    ['const config="DB_PASSWORD=synthetic-nested-secret";', "access-token"],
    ["PASSWORD=${TOKEN}synthetic-suffix", "access-token"],
    ['PASSWORD=""synthetic-suffix', "access-token"],
    ['PASSWORD="<redacted>"+"synthetic-suffix"', "access-token"],
    ['PASSWORD=process.env.PASSWORD || "synthetic-fallback"', "access-token"],
    ["DB_PASSWORD=#synthetic-password", "access-token"],
    ['"db_password": "synthetic-json-secret"', "access-token"],
    ['password: "synthetic-yaml-secret"', "access-token"],
    [String.raw`MY_API_KEY="synthetic\"quoted-secret"`, "api-key"],
  ] as const) {
    const findings = scanTextForCredentials("body_md", assignment);
    expect(findings.map((finding) => finding.kind)).toEqual([kind]);
    expect(scanBodyForSecrets(assignment).some((finding) => finding.kind === kind)).toBe(true);
    expect(bodyLooksSecretShaped(assignment)).toBe(true);
    const refusal = await secretShapedContentProblem(findings).text();
    expect(ProblemDocumentSchema.safeParse(JSON.parse(refusal)).success).toBe(true);
    expect(refusal).not.toContain("synthetic");
  }
});

test("assignment findings retain Unicode columns, repeated lines and specific token kinds", () => {
  const text = '𝔽 DB_PASSWORD="synthetic-one"\nDB_PASSWORD=synthetic-two';
  expect(scanTextForCredentials("body_md", text)).toEqual([
    { path: "body_md", kind: "access-token", line: 1, column: 16 },
    { path: "body_md", kind: "access-token", line: 2, column: 13 },
  ]);
  expect(scanBodyForSecrets(text)).toEqual([
    { kind: "access-token", line: 1, column: 16 },
    { kind: "access-token", line: 2, column: 13 },
  ]);
  expect(scanTextForCredentials("body_md", `API_KEY=${AWS}`)).toEqual([
    { path: "body_md", kind: "api-key", line: 1, column: 9 },
  ]);
  expect(scanTextForCredentials("body_md", "PASSWORD=<redacted> API_KEY=synthetic-value")).toEqual([
    { path: "body_md", kind: "api-key", line: 1, column: 29 },
  ]);
});

test("benign code, scientific identifiers, source references and explicit placeholders pass", () => {
  for (const text of [
    "let token_count = 42; let password_length = 16;",
    'const secreted = "ordinary biological result";',
    "const key = 'lemma-1';",
    "token: String",
    "api_key: Option<String>",
    "For every token, token_count = n.",
    "const token = nextToken(input);",
    "let secret = p*q;",
    "secret = p * q",
    'token = request.headers.get("authorization");',
    "token == expected_token",
    "token === expected_token",
    "const password = await fetchSecret();",
    "password = input.password",
    "DB_PASSWORD=process.env.DB_PASSWORD",
    'DB_PASSWORD=process.env["DB_PASSWORD"]',
    'DB_PASSWORD=os.environ[ "DB_PASSWORD" ]',
    'DB_PASSWORD=getenv( "DB_PASSWORD" )',
    'DB_PASSWORD=os.getenv("DB_PASSWORD")',
    "DB_PASSWORD=${DB_PASSWORD}",
    "DB_PASSWORD=$DB_PASSWORD",
    "DB_PASSWORD=%DB_PASSWORD%",
    "DB_PASSWORD={{ DB_PASSWORD }}",
    "DB_PASSWORD=<your_password>",
    "DB_PASSWORD=[REDACTED]",
    'DB_PASSWORD="<redacted>"',
    'DB_PASSWORD=""',
    "DB_PASSWORD=xxxxxx",
    "DB_PASSWORD=********",
    "DB_PASSWORD=...",
    'MY_API_KEY="${MY_API_KEY}"',
  ]) {
    expect(scanTextForCredentials("body_md", text)).toEqual([]);
    expect(scanBodyForSecrets(text)).toEqual([]);
    expect(bodyLooksSecretShaped(text)).toBe(false);
  }
});

test("password-bearing connection URIs are detected including encoded and empty-user forms", async () => {
  for (const uri of [
    "postgresql://reader:synthetic-db-password@db.example.invalid/research",
    "redis://:synthetic-cache-password@cache.example.invalid:6379/0",
    "mongodb+srv://reader:synthetic%40encoded%3Apassword@db.example.invalid/research",
    "https://reader:x@service.example.invalid/",
    "amqps://reader:synthetic%ZZpassword@queue.example.invalid/",
    "postgres://reader:[redacted]@actual@db.example.invalid/research",
    "postgres://reader:%3Credacted%3E%40actual@db.example.invalid/research",
  ]) {
    const findings = scanTextForCredentials("body_md", `𝔽 ${uri}`);
    expect(findings.map((finding) => finding.kind)).toEqual(["access-token"]);
    expect(bodyLooksSecretShaped(uri)).toBe(true);
    expect(scanBodyForSecrets(uri).some((finding) => finding.kind === "access-token")).toBe(true);
    const response = await secretShapedContentProblem(findings).text();
    expect(response).not.toContain("synthetic");
    expect(response).not.toContain(uri);
    expect(ProblemDocumentSchema.safeParse(JSON.parse(response)).success).toBe(true);
  }
  for (const uri of [
    "https://service.example.invalid/paper",
    "https://reader@service.example.invalid/paper",
    "postgresql://reader:@db.example.invalid/research",
    "postgresql://reader:<password>@db.invalid/research",
    "postgresql://reader:%3Credacted%3E@db.invalid/research",
    "redis://:${REDIS_PASSWORD}@cache.invalid/0",
  ]) {
    expect(scanTextForCredentials("body_md", uri)).toEqual([]);
  }
});

test("decoded JSON credential fields cannot hide behind escaped or duplicate keys", async () => {
  const cases = [
    ['{"DB_PASSWORD":"synthetic-json-value"}', "DB_PASSWORD", "access-token"],
    ['{"connection":{"my_api_key":"synthetic-json-value"}}', "connection.my_api_key", "api-key"],
    ['{"PASSWORD":0}', "PASSWORD", "access-token"],
    [
      `{"${escaped("DB_PASSWORD")}":"${escaped("synthetic-json-value")}"}`,
      "DB_PASSWORD",
      "access-token",
    ],
    [
      '{"DB_PASSWORD":"synthetic-json-value","DB_PASSWORD":"<redacted>"}',
      "DB_PASSWORD",
      "access-token",
    ],
  ] as const;
  for (const [text, path, kind] of cases) {
    const findings = scanFieldForCredentials("request", text);
    expect(findings).toEqual([{ path, kind, line: 1, column: 1 }]);
    expect(JSON.stringify(findings)).not.toContain("synthetic-json-value");
    const response = await secretShapedContentProblem(findings).text();
    expect(response).not.toContain("synthetic-json-value");
    expect(ProblemDocumentSchema.safeParse(JSON.parse(response)).success).toBe(true);
  }
  const source = '{"db_password":"synthetic-json-value","db_password":"<redacted>"}';
  expect(scanFieldForCredentials("request", JSON.stringify({ body_md: source }))).toEqual([
    { path: "body_md", kind: "access-token", line: 1, column: 17 },
    { path: "body_md.db_password", kind: "access-token", line: 1, column: 1 },
  ]);
  expect(
    scanFieldForCredentials(
      "request",
      JSON.stringify({ password: "<redacted>", token_count: 123 }),
    ),
  ).toEqual([]);
});

test("generic credentials in hostile diagnostic keys are not echoed", async () => {
  const hostileKey = "DB_PASSWORD=synthetic-key-value";
  const findings = scanFieldForCredentials(
    "request",
    JSON.stringify({ [hostileKey]: { password: "synthetic-value" } }),
  );
  expect(findings.map((finding) => finding.path)).toEqual(["[key:0]", "[entry:0].password"]);
  const response = await secretShapedContentProblem(findings).text();
  expect(response).not.toContain("synthetic");
  const supplied = await secretShapedContentProblem([
    { path: hostileKey, kind: "access-token", line: 1, column: 1 },
  ]).text();
  expect(JSON.parse(supplied).secret_findings[0].path).toBe("[redacted-field]");
  expect(supplied).not.toContain("synthetic");
});

test("JSON artifacts share decoded credential detection and source-token locations", () => {
  for (const body of [
    String.raw`{"DB_PASS\u0057ORD":"synthetic-artifact-password"}`,
    String.raw`{"DB_PASSWORD":"\u0073ynthetic-artifact-password"}`,
    '{\n  "DB_PASSWORD"\n  :\n  "synthetic-artifact-password"\n}',
    '{"DB_PASSWORD":\n1234}',
    JSON.stringify({ source: String.raw`{"DB_PASS\u0057ORD":"synthetic-artifact-password"}` }),
    String.raw`{"connection":"postgres:\/\/reader:synthetic-artifact-password@db.invalid/research"}`,
    String.raw`"postgres:\/\/reader:synthetic-artifact-password@db.invalid/research"`,
  ]) {
    expect(scanFieldForCredentials("request", body).length).toBeGreaterThan(0);
    expect(bodyLooksSecretShaped(body)).toBe(true);
    expect(scanBodyForSecrets(body).some((finding) => finding.kind === "access-token")).toBe(true);
    expect(JSON.stringify(scanBodyForSecrets(body))).not.toContain("synthetic");
  }
  expect(scanBodyForSecrets('{\n  "DB_PASSWORD"\n  :\n  "synthetic-artifact-password"\n}')).toEqual(
    [{ kind: "access-token", line: 4, column: 4 }],
  );
  for (const body of [
    String.raw`{"DB_PASS\u0057ORD":"<redacted>"}`,
    '{\n "DB_PASSWORD": "${DB_PASSWORD}"\n}',
    String.raw`{"connection":"postgres:\/\/reader:%3Credacted%3E@db/research"}`,
    '{"token_count":1234,"password_length":20}',
  ]) {
    expect(bodyLooksSecretShaped(body)).toBe(false);
    expect(scanBodyForSecrets(body)).toEqual([]);
  }
});
