import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MoveTemplatesDocSchema, ReviewRubricsDocSchema } from "@asimposium/contracts";
import { listPublicSchemas } from "@asimposium/contracts/public-schemas";
import nextConfig from "../../apps/web/next.config.ts";
import { createApp } from "../../apps/wire/src/app.ts";
import type { Env } from "../../apps/wire/src/env.ts";
import { getDocument } from "../../packages/protocol/src/index.ts";
import { parseProtocolMarkdown } from "../../packages/protocol/src/protocol-json.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const APEX_PUBLIC = resolve(REPO_ROOT, "apps/web/public");

interface EndpointVerification {
  readonly route: string;
  readonly status: number;
  readonly etag: string;
  readonly canonicalLink: string;
  readonly durationMs: number;
  readonly bytes: number;
}

interface E2eContext {
  readonly app: ReturnType<typeof createApp>;
  readonly env: Env;
  readonly verifications: EndpointVerification[];
}

function createE2eContext(): E2eContext {
  const env = {
    STOA_ORIGIN: "https://a.asimposium.org",
    AGORA_ORIGIN: "https://asimposium.org",
  } as unknown as Env;

  const app = createApp();
  return { app, env, verifications: [] };
}

async function verifyEndpoint(
  ctx: E2eContext,
  path: string,
  expectedContentType: string,
  expectedFormat: string,
  expectedCanonicalPath: string,
): Promise<{ body: string; etag: string }> {
  const start = performance.now();

  // 1. Cold cache GET
  const getReq = new Request(`https://a.asimposium.org${path}`);
  const res = await ctx.app.fetch(getReq, ctx.env);
  const durationMs = Math.round(performance.now() - start);

  if (res.status !== 200) {
    throw new Error(`GET ${path} expected 200, got ${res.status}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes(expectedContentType)) {
    throw new Error(
      `GET ${path} content-type mismatch: expected ${expectedContentType}, got ${contentType}`,
    );
  }

  const etag = res.headers.get("etag") ?? "";
  if (!etag.startsWith('"') || !etag.endsWith('"')) {
    throw new Error(`GET ${path} missing or unquoted ETag: ${etag}`);
  }

  const link = res.headers.get("link") ?? "";
  const expectedLink = `<https://a.asimposium.org${expectedCanonicalPath}>; rel="canonical"`;
  if (link !== expectedLink) {
    throw new Error(`GET ${path} link header mismatch: expected ${expectedLink}, got ${link}`);
  }

  const body = await res.text();

  // 2. HEAD request: headers match, body empty
  const headReq = new Request(`https://a.asimposium.org${path}`, { method: "HEAD" });
  const headRes = await ctx.app.fetch(headReq, ctx.env);
  if (headRes.status !== 200) {
    throw new Error(`HEAD ${path} expected 200, got ${headRes.status}`);
  }
  if (headRes.headers.get("etag") !== etag) {
    throw new Error(`HEAD ${path} etag mismatch with GET`);
  }
  const headBody = await headRes.text();
  if (headBody.length !== 0) {
    throw new Error(`HEAD ${path} returned non-empty body (${headBody.length} bytes)`);
  }

  // 3. Conditional GET with If-None-Match
  const condReq = new Request(`https://a.asimposium.org${path}`, {
    headers: { "if-none-match": etag },
  });
  const condRes = await ctx.app.fetch(condReq, ctx.env);
  if (condRes.status !== 304) {
    throw new Error(`Conditional GET ${path} expected 304, got ${condRes.status}`);
  }
  const condBody = await condRes.text();
  if (condBody.length !== 0) {
    throw new Error(`Conditional GET ${path} returned non-empty body`);
  }

  // 4. Invalid ?format= parameter
  const badFormatReq = new Request(`https://a.asimposium.org${path}?format=invalid_mime`);
  const badFormatRes = await ctx.app.fetch(badFormatReq, ctx.env);
  if (badFormatRes.status !== 400) {
    throw new Error(`GET ${path}?format=invalid_mime expected 400, got ${badFormatRes.status}`);
  }
  const badProblem = (await badFormatRes.json()) as {
    code?: string;
    allowed?: string[];
  };
  if (badProblem.code !== "UNKNOWN_FORMAT") {
    throw new Error(`GET ${path}?format=invalid_mime expected code UNKNOWN_FORMAT`);
  }
  if (!badProblem.allowed?.includes(expectedFormat)) {
    throw new Error(
      `GET ${path}?format=invalid_mime allowed list does not include ${expectedFormat}`,
    );
  }

  ctx.verifications.push({
    route: path,
    status: 200,
    etag,
    canonicalLink: expectedLink,
    durationMs,
    bytes: body.length,
  });

  return { body, etag };
}

export async function runServedTextsE2e(): Promise<void> {
  console.log("--- Running Served Texts E2E Verification (W6.5, bead asimposiumorg-3bq) ---");
  const ctx = createE2eContext();

  // A. Public Text Routes
  console.log("\n1. Verifying public text routes...");
  await verifyEndpoint(ctx, "/", "text/markdown", "md", "/");
  await verifyEndpoint(ctx, "/AGENTS.md", "text/markdown", "md", "/");
  await verifyEndpoint(ctx, "/llms.txt", "text/plain", "txt", "/llms.txt");
  await verifyEndpoint(ctx, "/policy.md", "text/markdown", "md", "/policy.md");
  await verifyEndpoint(ctx, "/protocol", "text/markdown", "md", "/protocol.md");
  await verifyEndpoint(ctx, "/protocol.md", "text/markdown", "md", "/protocol.md");
  await verifyEndpoint(ctx, "/skill.md", "text/markdown", "md", "/skill.md");
  await verifyEndpoint(ctx, "/inoculation.md", "text/markdown", "md", "/inoculation.md");

  // B. Structured Protocol, Rubrics, and Moves Routes
  console.log("\n2. Verifying structured protocol, rubrics, and moves routes...");
  const { body: protoJsonText } = await verifyEndpoint(
    ctx,
    "/protocol.json",
    "application/json",
    "json",
    "/protocol.json",
  );
  const protoJson = JSON.parse(protoJsonText);
  if (protoJson.version !== "0.1.0-draft") {
    throw new Error(`protocol.json invalid version: ${protoJson.version}`);
  }
  if (!Array.isArray(protoJson.rules?.hard) || protoJson.rules.hard.length !== 12) {
    throw new Error(`protocol.json expected 12 hard rules, got ${protoJson.rules?.hard?.length}`);
  }

  const { body: rubricsText } = await verifyEndpoint(
    ctx,
    "/rubrics",
    "application/json",
    "json",
    "/rubrics.json",
  );
  const { body: rubricsJsonText } = await verifyEndpoint(
    ctx,
    "/rubrics.json",
    "application/json",
    "json",
    "/rubrics.json",
  );
  if (rubricsText !== rubricsJsonText) {
    throw new Error("/rubrics and /rubrics.json byte mismatch");
  }
  const rubricsDoc = JSON.parse(rubricsText);
  ReviewRubricsDocSchema.parse(rubricsDoc);
  if (Object.keys(rubricsDoc.domains).length !== 4) {
    throw new Error(
      `rubrics doc expected 4 domains, got ${Object.keys(rubricsDoc.domains).length}`,
    );
  }

  const { body: movesText } = await verifyEndpoint(
    ctx,
    "/moves",
    "application/json",
    "json",
    "/moves.json",
  );
  const { body: movesJsonText } = await verifyEndpoint(
    ctx,
    "/moves.json",
    "application/json",
    "json",
    "/moves.json",
  );
  if (movesText !== movesJsonText) {
    throw new Error("/moves and /moves.json byte mismatch");
  }
  const movesDoc = JSON.parse(movesText);
  MoveTemplatesDocSchema.parse(movesDoc);
  if (Object.keys(movesDoc.moves).length !== 18) {
    throw new Error(`moves doc expected 18 moves, got ${Object.keys(movesDoc.moves).length}`);
  }

  // C. Public Schema Routes
  console.log("\n3. Verifying public schemas...");
  for (const schema of listPublicSchemas()) {
    await verifyEndpoint(ctx, schema.served_at, schema.media_type, "json", schema.served_at);
  }

  // D. Discovery routes
  console.log("\n4. Verifying discovery routes...");
  await verifyEndpoint(
    ctx,
    "/.well-known/asimposium.json",
    "application/json",
    "json",
    "/.well-known/asimposium.json",
  );
  await verifyEndpoint(ctx, "/openapi.json", "application/json", "json", "/openapi.json");
  await verifyEndpoint(
    ctx,
    "/schemas/index.json",
    "application/json",
    "json",
    "/schemas/index.json",
  );
  await verifyEndpoint(ctx, "/capabilities", "application/json", "json", "/capabilities");

  // E. Semantic Parity Checks
  console.log("\n5. Verifying semantic parity between GFM and JSON representations...");
  const protocolDoc = getDocument("protocol");
  const protocolJsonDirect = parseProtocolMarkdown(protocolDoc.body);
  if (protoJson.preamble !== protocolJsonDirect.preamble) {
    throw new Error("protocol.json preamble does not match protocol.md parsed preamble");
  }
  if (protoJson.rules.hard.length !== protocolJsonDirect.rules.hard.length) {
    throw new Error("protocol.json hard rules count mismatch");
  }
  for (let i = 0; i < protoJson.rules.hard.length; i++) {
    const directRule = protocolJsonDirect.rules.hard[i];
    if (!directRule || protoJson.rules.hard[i].title !== directRule.title) {
      throw new Error(`protocol.json hard rule ${i} title mismatch`);
    }
  }

  // F. Apex Static Copies Parity
  console.log("\n6. Verifying apex static copies parity...");
  const apexCopies: [string, string][] = [
    ["capsule.md", getDocument("capsule").body],
    ["llms.txt", getDocument("llms").body],
    ["AGENTS.md", getDocument("handbook").body],
    ["skill.md", getDocument("skill").body],
    ["protocol.md", getDocument("protocol").body],
    ["policy.md", getDocument("policy").body],
    ["inoculation.md", getDocument("inoculation").body],
  ];

  for (const [filename, expectedBody] of apexCopies) {
    const filePath = join(APEX_PUBLIC, filename);
    const actualBody = readFileSync(filePath, "utf8");
    if (actualBody !== expectedBody) {
      throw new Error(`Apex public/${filename} drifted from protocol registry source!`);
    }
  }

  // G. Apex Next.js Redirects
  console.log("\n7. Verifying apex Next.js redirects...");
  if (typeof nextConfig.redirects !== "function") {
    throw new Error("nextConfig.redirects is not a function");
  }
  const redirects = await nextConfig.redirects();
  const requiredRedirectSources = [
    "/protocol",
    "/protocol.md",
    "/protocol.json",
    "/rubrics",
    "/rubrics.json",
    "/moves",
    "/moves.json",
    "/policy.md",
    "/inoculation.md",
    "/capabilities",
    "/openapi.json",
    "/.well-known/asimposium.json",
    "/schemas/:path*",
    "/problems.md",
    "/problems.json",
    "/p/:slug.md",
    "/p/:slug.json",
    "/search.md",
    "/search.json",
  ];

  const redirectMap = new Map<string, string>();
  for (const r of redirects) {
    redirectMap.set(r.source, r.destination);
    if (!r.permanent) {
      throw new Error(`Redirect for ${r.source} must be permanent (308)`);
    }
  }

  for (const source of requiredRedirectSources) {
    if (!redirectMap.has(source)) {
      throw new Error(`Missing apex redirect for source: ${source}`);
    }
    const dest = redirectMap.get(source);
    if (!dest || (!dest.startsWith("https://a.asimposium.org") && !dest.startsWith("http"))) {
      throw new Error(`Redirect for ${source} does not point to Stoa: ${dest}`);
    }
  }

  // H. OPS.2a Structured Diagnostic Log
  console.log("\n8. Emitting OPS.2a structured diagnostic records...");
  for (const v of ctx.verifications) {
    console.log(
      JSON.stringify({
        tag: "OPS.2a",
        route: v.route,
        status: v.status,
        etag: v.etag,
        canonical_link: v.canonicalLink,
        duration_ms: v.durationMs,
        bytes: v.bytes,
      }),
    );
  }

  console.log(
    `\n--- All ${ctx.verifications.length} endpoints and parity checks passed successfully! ---`,
  );
}

if (import.meta.main) {
  runServedTextsE2e().catch((error) => {
    console.error("Served Texts E2E FAILED:", error);
    process.exit(1);
  });
}
