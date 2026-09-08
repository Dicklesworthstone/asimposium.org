import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { claimsJourney } from "./claims-journey.mjs";

assert.equal(process.versions.bun, undefined, "This lane requires genuine Node");
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const origin = "http://127.0.0.1:8787";
const userAgent = "OpenAI File Downloader, XaiImageApiFetch/1.0";

const server = createTestHarness({
  root,
  workers: [
    {
      config: {
        name: "asimposium-claims-proof",
        main: `${root}/apps/wire/test/integration/discovery-local-worker.ts`,
        compatibility_date: "2026-08-13",
        compatibility_flags: ["nodejs_compat"],
        d1_databases: [
          {
            binding: "DB",
            database_name: "claims-proof",
            database_id: "00000000-0000-0000-0000-000000000000",
            migrations_dir: `${root}/db/migrations`,
          },
        ],
        r2_buckets: [
          { binding: "ARTIFACTS", bucket_name: "claims-private" },
          { binding: "PUBLIC_ARTIFACTS", bucket_name: "claims-public" },
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
          SPONSOR_PROMOTION_RATE_LIMIT: "100",
          ENROLLMENT_REPLAY_KEY: Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString(
            "base64url",
          ),
        },
      },
    },
  ],
});

async function runClaimsProof() {
  await server.listen();
  console.log(JSON.stringify({ stage: "workerd-started" }));
  const worker = server.getWorker();
  await worker.applyD1Migrations("DB");
  console.log(JSON.stringify({ stage: "d1-migrated" }));

  const fixtures = await worker.getExport();
  const env = await worker.getEnv();
  let key = 0;

  async function call(path, body, token, expected = 200, idempotencyKey) {
    const response = await worker.fetch(`${origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "User-Agent": userAgent,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined
          ? {}
          : {
              "content-type": "application/json",
              "idempotency-key": idempotencyKey ?? `claims-key-${++key}`,
            }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const raw = await response.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(
        `${path}: status=${response.status} non-JSON bytes=${Buffer.byteLength(raw)} sha256=${createHash("sha256").update(raw).digest("hex")}`,
      );
    }

    if (expected !== null && expected !== undefined) {
      assert.equal(
        response.status,
        expected,
        `${path}: status=${response.status} expected=${expected} code=${data.code ?? "none"} detail=${data.detail ?? ""}`,
      );
    }
    if (typeof data === "object" && data !== null) {
      data._status = response.status;
    }
    return data;
  }

  const discovery = await call("/openapi.json");
  function discoveredRequest(property) {
    const matches = Object.entries(discovery.paths).filter(([, methods]) =>
      methods.post?.requestBody?.content?.["application/json"]?.schema?.$ref?.endsWith(
        `/properties/${property}`,
      ),
    );
    assert.ok(matches.length > 0, `Missing published request schema: ${property}`);
    const [path] = matches[0];
    return path;
  }

  async function enroll(name, sponsor = "usr_sponsor_claims") {
    const minted = await fixtures.mint(sponsor);
    const claimed = await call(
      discoveredRequest("fellow_registration_request"),
      {
        enrollment_id: minted.enrollmentId,
        secret: minted.secret,
        name,
        model: "synthetic-claim-model",
        harness: "local-claims-proof",
      },
      undefined,
      202,
    );
    await fixtures.approve(sponsor, minted.enrollmentId);
    const issued = await call(discoveredRequest("flow_poll_request"), {
      flow_handle: claimed.flow_handle,
    });
    assert.equal(typeof issued.token, "string");
    return issued.token;
  }

  try {
    const result = await claimsJourney({
      call,
      enroll,
      fixtures,
      env,
      worker,
      origin,
      userAgent,
    });
    return result;
  } finally {
    await server.close();
  }
}

runClaimsProof()
  .then((receipt) => {
    console.log(JSON.stringify({ kind: "claims-real-bindings-complete", status: "pass", receipt }));
    process.exit(0);
  })
  .catch((err) => {
    console.error("Claims real bindings failed:", err);
    process.exit(1);
  });
