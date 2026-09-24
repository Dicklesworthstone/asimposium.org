/**
 * Local target for the Cold-Agent Gauntlet (Fable §16.1, bead asimposiumorg-g5h0).
 *
 * Boots the real Worker routes on local Workerd with real D1/R2 through
 * Wrangler's test harness, and puts a recording HTTP proxy in front of it. The
 * proxy is the only origin an agent is given. It records, per request, the
 * method, path (no query), status and problem `code`; it never records headers
 * or bodies, because the enrollment secret travels in a POST body and bearer
 * tokens travel in headers.
 *
 * Sponsor actions use the real signed service envelope (Agora's minting code)
 * with a fresh local Ed25519 key; no fixture RPC stands in for a sponsor.
 *
 * Boundary: screening uses the local test entrypoint's fixture classifier
 * (apps/wire/test/integration/discovery-local-worker.ts), because the local
 * topology deliberately has no Workers AI binding. Nothing here proves hosted
 * screening, Google OAuth, deployment, or cost.
 */
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  mintServiceEnvelope,
  serviceEnvelopeHeaders,
} from "../../apps/web/lib/service-envelope.ts";

export const USER_AGENT = "OpenAI File Downloader, XaiImageApiFetch/1.0";
const root = fileURLToPath(new URL("../../", import.meta.url));
// Wrangler is a dependency of the Worker package, so resolve it from there.
const wranglerEntry = createRequire(`${root}apps/wire/package.json`).resolve("wrangler");
const { createTestHarness } = await import(pathToFileURL(wranglerEntry).href);

async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** Start Workerd + proxy. Returns the agent-facing origin and sponsor/observation handles. */
export async function startLocalTarget({
  sponsorRateLimit = "100",
  injectPromoteRefusal = true,
} = {}) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const signingKeys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const keyId = "gauntlet-local-sponsor";
  const publicKeyHex = Buffer.from(
    await crypto.subtle.exportKey("raw", signingKeys.publicKey),
  ).toString("hex");
  const harness = createTestHarness({
    root,
    workers: [
      {
        secrets: {
          SERVICE_ENVELOPE_KEYS: JSON.stringify([{ kid: keyId, publicKeyHex, notBefore: 0 }]),
        },
        config: {
          name: "asimposium-gauntlet-local",
          main: `${root}/apps/wire/test/integration/discovery-local-worker.ts`,
          compatibility_date: "2026-08-13",
          compatibility_flags: ["nodejs_compat"],
          d1_databases: [
            {
              binding: "DB",
              database_name: "gauntlet-local",
              database_id: "00000000-0000-0000-0000-000000000000",
              migrations_dir: `${root}/db/migrations`,
            },
          ],
          r2_buckets: [
            { binding: "ARTIFACTS", bucket_name: "gauntlet-private" },
            { binding: "PUBLIC_ARTIFACTS", bucket_name: "gauntlet-public" },
          ],
          durable_objects: {
            bindings: [{ name: "KRATER_OUTBOX", class_name: "KraterOutboxDrainer" }],
          },
          exports: { KraterOutboxDrainer: { type: "durable-object", storage: "sqlite" } },
          rules: [
            { type: "Text", globs: ["**/*.md", "**/*.txt", "**/*.schema.json"], fallthrough: true },
          ],
          vars: {
            STOA_ORIGIN: origin,
            AGORA_ORIGIN: "https://staging.asimposium.org",
            SPONSOR_PROMOTION_RATE_LIMIT: sponsorRateLimit,
            ENROLLMENT_REPLAY_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
              "base64url",
            ),
          },
        },
      },
    ],
  });
  await harness.listen();
  const worker = harness.getWorker();
  await worker.applyD1Migrations("DB");
  const env = await worker.getEnv();

  /** Server-side observations: what the Worker answered, never what was sent. */
  const observations = [];
  /**
   * Fable §16.1 "recover from an injected 422": the first promotion of each
   * session reaches the Worker with its falsifier removed (or, if it had none,
   * its statement), so the Worker itself returns a genuine teaching refusal.
   * Nothing is fabricated here; the refusal and its fix_hint are the Worker's.
   */
  const injectedSessions = new Set();
  function injectRefusal(path, body) {
    const match = /^\/v1\/sessions\/([^/]+)\/promote$/.exec(path);
    if (!injectPromoteRefusal || match === null || injectedSessions.has(match[1])) return body;
    let parsed;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      return body;
    }
    if (typeof parsed !== "object" || parsed === null) return body;
    injectedSessions.add(match[1]);
    if ("falsifier" in parsed) delete parsed.falsifier;
    else delete parsed.statement;
    return Buffer.from(JSON.stringify(parsed));
  }
  const proxy = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const url0 = new URL(req.url ?? "/", origin);
    let body = chunks.length === 0 ? undefined : Buffer.concat(chunks);
    const injected =
      body !== undefined && req.method === "POST" ? injectRefusal(url0.pathname, body) : body;
    const wasInjected = injected !== body;
    body = injected;
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (
        typeof value === "string" &&
        name !== "host" &&
        name !== "connection" &&
        name !== "content-length"
      )
        headers.set(name, value);
    }
    const url = new URL(req.url ?? "/", origin);
    let response;
    try {
      response = await worker.fetch(url.href, {
        method: req.method,
        headers,
        ...(body && req.method !== "GET" && req.method !== "HEAD" ? { body } : {}),
      });
    } catch {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("local target transport failure");
      observations.push({ method: req.method, path: url.pathname, status: 502, code: null });
      return;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    let code = null;
    if ((response.headers.get("content-type") ?? "").includes("json") && response.status >= 400) {
      try {
        code = JSON.parse(bytes.toString("utf8")).code ?? null;
      } catch {
        code = null;
      }
    }
    observations.push({
      at: Date.now(),
      method: req.method,
      path: url.pathname,
      status: response.status,
      code,
      authenticated: typeof req.headers.authorization === "string",
      injected: wasInjected,
    });
    const outHeaders = {};
    response.headers.forEach((value, name) => {
      if (name !== "content-length" && name !== "transfer-encoding") outHeaders[name] = value;
    });
    res.writeHead(response.status, outHeaders);
    res.end(bytes);
  });
  await new Promise((resolve) => proxy.listen(port, "127.0.0.1", resolve));

  let sponsorKey = 0;
  /** One real signed sponsor write/read through the proxy (sponsor traffic is observed too). */
  async function sponsor(sponsorId, method, path, action, body, route = path) {
    const raw = method === "GET" ? "" : JSON.stringify(body ?? {});
    const envelope = await mintServiceEnvelope({
      privateKey: signingKeys.privateKey,
      kid: keyId,
      now: Math.floor(Date.now() / 1000),
      method,
      route,
      action,
      principalId: sponsorId,
      body: raw,
    });
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        ...serviceEnvelopeHeaders(envelope),
        "user-agent": USER_AGENT,
        "idempotency-key": `gauntlet-sponsor-${++sponsorKey}-${crypto.randomUUID()}`,
      },
      ...(method === "GET" ? {} : { body: raw }),
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw_bytes: text.length };
    }
    return { status: response.status, body: json };
  }

  async function close() {
    await new Promise((resolve) => proxy.close(resolve));
    await harness.close();
  }

  return { origin, env, worker, observations, injectedSessions, sponsor, close };
}
