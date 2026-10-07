import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ProblemCodeSchema } from "@asimposium/contracts";
import { createTestHarness } from "wrangler";
import { mintServiceEnvelope, serviceEnvelopeHeaders } from "../../../web/lib/service-envelope.ts";
import { eventTypeIsKnown } from "../../src/krater/projection-replay.ts";
import { problemLifecycleJourney } from "./problem-lifecycle-journey.mjs";
import { assertProjectionsRebuild } from "./projection-rebuild-check.mjs";
import {
  assertLedgerTriggersRefuse,
  assertSearchHoldsOnlyPublicClaims,
} from "./trigger-probes.mjs";

assert.equal(process.versions.bun, undefined, "This lane requires genuine Node");

/** Event types only lane fixtures write (discovery-local-worker competingLedgerWrite). */
const LANE_EVENT_TYPES = new Set(["lane.competing-write"]);
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const origin = "http://127.0.0.1:8787";
const userAgent = "OpenAI File Downloader, XaiImageApiFetch/1.0";
// Fresh local signing key exercises the actual sponsor ingress; no OAuth claim.
const signingKeys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
const keyId = "problem-lifecycle-local-sponsor";
const publicKeyHex = Buffer.from(
  await crypto.subtle.exportKey("raw", signingKeys.publicKey),
).toString("hex");

// Fresh checkpoint signing key per run (ADR-23): seed secret + public verify key.
const checkpointSeed = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
const checkpointPrivate = await crypto.subtle.importKey(
  "pkcs8",
  Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), checkpointSeed]),
  { name: "Ed25519" },
  true,
  ["sign"],
);
const checkpointPublicHex = Buffer.from(
  (await crypto.subtle.exportKey("jwk", checkpointPrivate)).x,
  "base64url",
).toString("hex");
export const CHECKPOINT_KEY_ID = "local-checkpoint-1";
export const CHECKPOINT_PUBLIC_KEY_HEX = checkpointPublicHex;

function createLocalWorkerHarness({ scratch = false } = {}) {
  return createTestHarness({
    root,
    workers: [
      {
        // Wrangler's test secret overrides take precedence over workstation
        // .dev.vars. The signer must match this run's fresh public keyring.
        secrets: {
          SERVICE_ENVELOPE_KEYS: JSON.stringify([{ kid: keyId, publicKeyHex, notBefore: 0 }]),
          CHECKPOINT_SIGNING_KEY: JSON.stringify({
            kid: CHECKPOINT_KEY_ID,
            seedHex: checkpointSeed.toString("hex"),
          }),
          CHECKPOINT_VERIFY_KEYS: JSON.stringify([
            { kid: CHECKPOINT_KEY_ID, publicKeyHex: checkpointPublicHex },
          ]),
        },
        config: {
          name: "asimposium-problem-lifecycle-proof",
          main: `${root}/apps/wire/test/integration/discovery-local-worker.ts`,
          compatibility_date: "2026-08-13",
          compatibility_flags: ["nodejs_compat"],
          d1_databases: [
            {
              binding: "DB",
              database_name: "problem-lifecycle-proof",
              database_id: "00000000-0000-0000-0000-000000000000",
              migrations_dir: `${root}/db/migrations`,
            },
            // A separately migrated, empty database that export/restore
            // journeys restore into; the primary DB is never a restore target.
            ...(scratch
              ? [
                  {
                    binding: "SCRATCH_DB",
                    database_name: "scratch-restore-proof",
                    database_id: "00000000-0000-0000-0000-000000000001",
                    migrations_dir: `${root}/db/migrations`,
                  },
                ]
              : []),
          ],
          r2_buckets: [
            { binding: "ARTIFACTS", bucket_name: "problem-lifecycle-private" },
            { binding: "PUBLIC_ARTIFACTS", bucket_name: "problem-lifecycle-public" },
            ...(scratch ? [{ binding: "BACKUPS", bucket_name: "problem-lifecycle-backups" }] : []),
          ],
          durable_objects: {
            bindings: [
              { name: "KRATER_OUTBOX", class_name: "KraterOutboxDrainer" },
              { name: "HERALD_ROOMS", class_name: "HeraldRoom" },
            ],
          },
          exports: {
            KraterOutboxDrainer: { type: "durable-object", storage: "sqlite" },
            HeraldRoom: { type: "durable-object", storage: "sqlite" },
          },
          rules: [
            { type: "Text", globs: ["**/*.md", "**/*.txt", "**/*.schema.json"], fallthrough: true },
          ],
          vars: {
            STOA_ORIGIN: origin,
            AGORA_ORIGIN: "https://staging.asimposium.org",
            SPONSOR_PROMOTION_RATE_LIMIT: "100",
            // The one local operator principal (operatorCall below).
            OPERATOR_PRINCIPAL_IDS: LOCAL_OPERATOR_ID,
            ENROLLMENT_REPLAY_KEY: Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString(
              "base64url",
            ),
          },
        },
      },
    ],
  });
}

/** The Worker's OPS.2a records for one stage, parsed from captured runtime
 * logs (workerLogs()). Lines that are not OPS.2a JSON are ignored. */
export function opsRecords(logs, stage) {
  const records = [];
  for (const log of logs) {
    let record;
    try {
      record = JSON.parse(log.message);
    } catch {
      continue;
    }
    if (record?.facility === "OPS.2a" && record.stage === stage) records.push(record);
  }
  return records;
}

/** The allowlisted operator in the local harness; operatorCall signs as it. */
export const LOCAL_OPERATOR_ID = "usr_local_operator";

// Reuse this real binding/signed-request setup for related product journeys.
// Importing it never starts a journey or certifies another product surface.
export async function runLocalWorkerJourney(journey, options = {}) {
  const server = createLocalWorkerHarness(options);
  try {
    await server.listen();
    console.log(JSON.stringify({ stage: "workerd-started" }));
    const worker = server.getWorker();
    await worker.applyD1Migrations("DB");
    if (options.scratch) await worker.applyD1Migrations("SCRATCH_DB");
    console.log(JSON.stringify({ stage: "d1-migrated" }));

    const fixtures = await worker.getExport();
    const env = await worker.getEnv();
    let key = 0;
    // Worker log lines a journey cleared are kept for the end-of-lane
    // credential check, as are the enrollment secrets this harness minted.
    const clearedLogs = [];
    const mintedSecrets = [];

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
                "idempotency-key": idempotencyKey ?? `problem-key-${++key}`,
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
        const code = ProblemCodeSchema.safeParse(data?.code);
        assert.equal(
          response.status,
          expected,
          `${path}: status=${response.status} expected=${expected} code=${code.success ? code.data : "unrecognized"}`,
        );
      }
      return data;
    }

    // Fable §9.1 L1 (b5d68e79): three refusals of distinct bytes put a Fellow
    // in quarantine-first, so a lane that plants policy canaries and then
    // expects benign writes to publish must record the sponsor's clearance,
    // through the real sponsor route. Returns how many Fellows it cleared, so
    // a caller can assert the clearance was needed rather than a no-op.
    async function clearScreeningPosture(sponsorId) {
      const { fellows } = await sponsorCall(
        sponsorId,
        "GET",
        "/v1/sponsors/screening-posture",
        "sponsor.posture.read",
      );
      let cleared = 0;
      for (const fellow of fellows) {
        if (!fellow.quarantine_first) continue;
        await sponsorCall(
          sponsorId,
          "POST",
          "/v1/sponsors/screening-posture/clear",
          "sponsor.posture.clear",
          {
            fellow_id: fellow.fellow_id,
            reason: "Lane fixture: the refused writes were deliberate policy canaries.",
          },
        );
        cleared += 1;
      }
      return cleared;
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

    async function enroll(name, sponsor = "usr_sponsor_problems") {
      const minted = await fixtures.mint(sponsor);
      mintedSecrets.push(minted.secret);
      const claimed = await call(
        discoveredRequest("fellow_registration_request"),
        {
          enrollment_id: minted.enrollmentId,
          secret: minted.secret,
          name,
          model: "synthetic-problem-model",
          harness: "local-problem-lifecycle-proof",
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

    async function sponsorCall(
      sponsorId,
      method,
      path,
      action,
      body,
      expected = 200,
      route = path,
      idempotencyKey,
      principalType = "sponsor",
    ) {
      const raw = body === undefined ? "" : JSON.stringify(body);
      const envelope = await mintServiceEnvelope({
        privateKey: signingKeys.privateKey,
        kid: keyId,
        now: Math.floor(Date.now() / 1000),
        method,
        route,
        action,
        principalType,
        principalId: sponsorId,
        body: raw,
      });
      const response = await worker.fetch(`${origin}${path}`, {
        method,
        headers: {
          ...serviceEnvelopeHeaders(envelope),
          "User-Agent": userAgent,
          "Idempotency-Key": idempotencyKey ?? `local-sponsor-${++key}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: raw }),
      });
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(
          `${path}: status=${response.status} non-JSON bytes=${Buffer.byteLength(text)} sha256=${createHash("sha256").update(text).digest("hex")}`,
        );
      }
      const code = ProblemCodeSchema.safeParse(data?.code);
      if (response.status >= 500) {
        assert.match(response.headers.get("content-type") ?? "", /^application\/problem\+json\b/);
        assert.equal(response.headers.get("cache-control"), "private, no-store");
      }
      assert.ok(
        (Array.isArray(expected) ? expected : [expected]).includes(response.status),
        `${path}: signed sponsor call status=${response.status} expected=${expected} code=${code.success ? code.data : "unrecognized"} detail=${data?.detail}`,
      );
      if (expected >= 200 && expected < 300) {
        assert.equal(response.headers.get("cache-control"), "private, no-store");
      }
      return data;
    }

    // An operator-signed call as the allowlisted local operator.
    const operatorCall = (method, path, action, body, expected = 200, route = path) =>
      sponsorCall(
        LOCAL_OPERATOR_ID,
        method,
        path,
        action,
        body,
        expected,
        route,
        undefined,
        "operator",
      );

    const result = await journey({
      call,
      enroll,
      fixtures,
      env,
      worker,
      origin,
      userAgent,
      sponsorCall,
      operatorCall,
      clearScreeningPosture,
      // The Worker's own runtime log lines since workerd started (or since
      // clearWorkerLogs), so a lane can assert its OPS.2a records.
      workerLogs: () => server.getLogs(),
      clearWorkerLogs: () => {
        clearedLogs.push(...server.getLogs());
        server.clearLogs();
      },
    });
    // 79n: incremental state equals replay. Whatever a lane wrote through the
    // real routes, the projection doctor's dry run must find each problem
    // consistent: rows equal their replay from the log. Exceptions are never
    // silent (x78n):
    // - a problem whose log holds a lane stand-in event (LANE_EVENT_TYPES) or
    //   lawfully redacted content cannot be replayed, so it must report
    //   exactly "unreplayable"; its rows are still compared, and the only
    //   drift allowed is what those events built (assertProjectionsRebuild);
    // - any other expected status is declared by the lane in its result's
    //   projectionParityExpect { problemId: status | { status, drift } } with
    //   the reason in code. Any declared status but "consistent" must list its
    //   drift items exactly ("table:kind:key[:column]"), so the declaration
    //   cannot hide any further drift;
    // - a lane that seeds fixture problems without events names them with
    //   { projectionParitySeeded: (problemId) => boolean }; they are skipped
    //   and counted, and every other problem is still compared. A whole-lane
    //   opt-out ({ projectionParity: false }) remains for lanes that need it.
    // Every lane, opted out or not, is also a runtime census (qnw4): every
    // event type it actually wrote must be one the replay knows, unless the
    // lane names it in { laneEventTypes } as a fixture the Worker never writes.
    const types = await env.DB.prepare("SELECT DISTINCT type FROM events ORDER BY type").all();
    const unknownTypes = (types.results ?? [])
      .map((row) => row.type)
      .filter(
        (type) =>
          !LANE_EVENT_TYPES.has(type) &&
          !(options.laneEventTypes ?? []).includes(type) &&
          !eventTypeIsKnown(type),
      );
    assert.deepEqual(unknownTypes, [], "every event type the lane wrote is known to replay");
    if (options.projectionParity !== false) {
      const declared = result?.projectionParityExpect ?? {};
      const problems = await env.DB.prepare(
        `SELECT p.id,
                EXISTS (SELECT 1 FROM events e WHERE e.problem_id = p.id
                         AND e.type IN (${[...LANE_EVENT_TYPES].map(() => "?").join(", ")})) AS stand_in,
                EXISTS (SELECT 1 FROM events e JOIN event_content c ON c.event_id = e.id
                         WHERE e.problem_id = p.id AND c.redacted_at IS NOT NULL) AS redacted
           FROM problems p ORDER BY p.id`,
      )
        .bind(...LANE_EVENT_TYPES)
        .all();
      // A declaration for a problem the lane did not leave behind (a typo, a
      // step that no longer runs) would check nothing; it is refused.
      const problemIds = new Set((problems.results ?? []).map((row) => row.id));
      assert.deepEqual(
        Object.keys(declared).filter((id) => !problemIds.has(id)),
        [],
        "every projectionParityExpect entry names a problem the lane left",
      );
      const statuses = {};
      const mismatched = [];
      const itemName = (item) =>
        `${item.table}:${item.kind}:${item.key}${item.column ? `:${item.column}` : ""}`;
      const seeded = options.projectionParitySeeded ?? (() => false);
      let skippedSeeded = 0;
      for (const { id, stand_in, redacted } of problems.results ?? []) {
        if (seeded(id)) {
          skippedSeeded += 1;
          continue;
        }
        const declaration =
          typeof declared[id] === "string" ? { status: declared[id] } : declared[id];
        if (declaration !== undefined && declaration.status !== "consistent") {
          assert.ok(
            Array.isArray(declaration.drift),
            `${id}: a declared ${declaration.status} lists its drift items`,
          );
        }
        const expected =
          declaration?.status ?? (stand_in === 1 || redacted === 1 ? "unreplayable" : "consistent");
        if (declared[id] === undefined && expected === "unreplayable") {
          await assertProjectionsRebuild(env.DB, id, {
            standInTypes: LANE_EVENT_TYPES,
            requirePopulated: false,
          });
        }
        const report = await operatorCall(
          "GET",
          `/v1/operators/problems/${encodeURIComponent(id)}/projections`,
          "operator.projections.read",
          undefined,
          200,
          "/v1/operators/problems/:problemId/projections",
        );
        statuses[report.status] = (statuses[report.status] ?? 0) + 1;
        const items = report.drift.map(itemName).sort();
        const driftMatches =
          declaration?.drift === undefined ||
          (!report.drift_truncated &&
            JSON.stringify(items) === JSON.stringify([...declaration.drift].sort()));
        if (report.status !== expected || !driftMatches) {
          mismatched.push({
            problem: id,
            expected,
            status: report.status,
            drift_count: report.drift_count,
            items: items.slice(0, 30),
          });
        }
      }
      console.log(
        JSON.stringify({ stage: "projection-parity", statuses, skippedSeeded, mismatched }),
      );
      assert.deepEqual(
        mismatched,
        [],
        "every problem's projections equal their replay, or its exception is stated",
      );
    }
    // W2.1 (jfi), after the parity sweep: public search holds only public
    // claims, then every guard trigger present must actually refuse on real
    // D1, not merely exist by name (trigger-probes.mjs). The probes run last:
    // one that wrongly succeeds is already a failure, so its mutation never
    // feeds another check.
    await assertSearchHoldsOnlyPublicClaims(env.DB);
    // Rule A5 / UBS critical: no credential ever reaches the Worker's logs.
    // No line may carry a Fellow bearer (asimp_ag_ prefix) or the secret
    // material of any enrollment this lane minted.
    const allLogs = [...clearedLogs, ...server.getLogs()];
    const leaks = allLogs.filter(
      (log) =>
        log.message.includes("asimp_ag_") ||
        mintedSecrets.some((secret) => log.message.includes(secret.replace(/^v1\./, ""))),
    );
    assert.deepEqual(
      leaks.map((log) => `${log.level}: ${log.message.length} chars`),
      [],
      "Worker logs never carry a bearer token or enrollment secret",
    );
    console.log(
      JSON.stringify({
        stage: "worker-log-credentials",
        log_lines: allLogs.length,
        enrollment_secrets_checked: mintedSecrets.length,
      }),
    );
    await assertLedgerTriggersRefuse(
      env.DB,
      options.laneName ?? basename(process.argv[1] ?? "").replace(/-real-bindings\.mjs$/, ""),
    );
    return result;
  } finally {
    await server.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runLocalWorkerJourney(problemLifecycleJourney)
    .then((receipt) => {
      console.log(
        JSON.stringify({
          kind: "problem-lifecycle-real-bindings-complete",
          status: "pass",
          receipt,
        }),
      );
      process.exit(0);
    })
    .catch((err) => {
      console.error(
        JSON.stringify({
          kind: "problem-lifecycle-real-bindings-complete",
          status: "fail",
          // The error class tells an assertion failure from a broken harness.
          error_code: typeof err?.code === "string" ? err.code : (err?.name ?? null),
          error_sha256: createHash("sha256")
            .update(err instanceof Error ? err.message : typeof err)
            .digest("hex"),
          // Where it failed: the first lane frame (file:line), never a message
          // or body, so an intermittent failure can be located (2tnr).
          error_at:
            (err instanceof Error ? (err.stack ?? "") : "")
              .split("\n")
              .map((line) => /test\/integration\/([\w.-]+\.mjs):(\d+)/.exec(line))
              .find((match) => match !== null)
              ?.slice(1, 3)
              .join(":") ?? null,
        }),
      );
      process.exit(1);
    });
}
