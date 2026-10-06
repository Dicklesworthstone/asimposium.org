import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ProblemCodeSchema } from "@asimposium/contracts";
import { createTestHarness } from "wrangler";
import { mintServiceEnvelope, serviceEnvelopeHeaders } from "../../../web/lib/service-envelope.ts";
import { eventTypeIsKnown } from "../../src/krater/projection-replay.ts";
import { problemLifecycleJourney } from "./problem-lifecycle-journey.mjs";
import { assertProjectionsRebuild } from "./projection-rebuild-check.mjs";

assert.equal(process.versions.bun, undefined, "This lane requires genuine Node");

/**
 * Probe every `<table>_immutable_(update|delete)` trigger (and the events
 * envelope triggers) against one existing row. The probe is built from the
 * trigger's own definition: an UPDATE sets a column it guards to itself (an
 * unconditional or `UPDATE OF` trigger fires on that), the events trigger,
 * which is guarded by WHEN on its key columns, gets its seq moved, and a
 * DELETE removes the row. Each must be refused. A trigger guarding only some
 * rows (WHEN on OLD, e.g. statement versions of a still-private draft may be
 * deleted, 0075) is probed on a row its condition covers, or skipped and
 * counted when the lane wrote none.
 */
async function assertLedgerTriggersRefuse(db) {
  const triggers = (
    await db
      .prepare(
        `SELECT name, tbl_name, sql FROM sqlite_schema
          WHERE type = 'trigger'
            AND (name GLOB '*_immutable_update' OR name GLOB '*_immutable_delete'
                 OR name IN ('events_immutable_before_update', 'events_immutable_before_delete'))
          ORDER BY name`,
      )
      .all()
  ).results;
  const probed = [];
  const accepted = [];
  const uncovered = [];
  const refusedOtherwise = [];
  for (const { name, tbl_name: table, sql } of triggers) {
    const clause = /\bWHEN\b([\s\S]*?)\bBEGIN\b/i.exec(sql)?.[1];
    // A WHEN that reads no row (e.g. a neutering WHEN 0) guards nothing: it is
    // probed like an unconditional trigger, so it fails here instead of being
    // skipped as uncovered.
    const when = clause !== undefined && /\b(OLD|NEW)\./.test(clause) ? clause : undefined;
    // The events envelope trigger's WHEN compares NEW with OLD; its probe
    // below changes a guarded column, so any row will do.
    const guarded =
      when === undefined || table === "events" ? "1" : when.replace(/\bOLD\./g, "probe_row.");
    const row = await db
      .prepare(`SELECT rowid AS rid, * FROM ${table} AS probe_row WHERE ${guarded} LIMIT 1`)
      .first();
    if (row === null) {
      if (when !== undefined) uncovered.push(name);
      continue;
    }
    const isUpdate = /\bBEFORE\s+UPDATE\b/i.test(sql);
    let statement;
    if (!isUpdate) {
      statement = db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).bind(row.rid);
    } else if (table === "events") {
      statement = db.prepare("UPDATE events SET seq = seq + 1000000 WHERE rowid = ?").bind(row.rid);
    } else {
      const of = /\bUPDATE\s+OF\s+([a-z_]+)/i.exec(sql)?.[1];
      const column = of ?? Object.keys(row).find((key) => key !== "rid");
      statement = db
        .prepare(`UPDATE ${table} SET ${column} = ${column} WHERE rowid = ?`)
        .bind(row.rid);
    }
    probed.push(name);
    try {
      await statement.run();
      accepted.push(name);
    } catch (error) {
      // Refused, but by this trigger? A foreign key or another trigger can
      // refuse the same statement (every event has dependent rows), which would
      // hide a neutered trigger. The refusal must carry its own RAISE message.
      const message = /RAISE\s*\(\s*ABORT\s*,\s*'([^']+)'/i.exec(sql)?.[1];
      if (message === undefined || !String(error?.message ?? error).includes(message)) {
        refusedOtherwise.push(name);
      }
    }
  }
  console.log(
    JSON.stringify({
      stage: "ledger-trigger-probes",
      probed,
      accepted,
      refused_otherwise: refusedOtherwise,
      uncovered_conditional: uncovered,
    }),
  );
  assert.deepEqual(accepted, [], "every ledger immutability trigger refuses its probe");
  assert.deepEqual(refusedOtherwise, [], "each probe is refused by its own trigger");
}

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
    // - lanes that seed rows without events opt out with
    //   { projectionParity: false }.
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
      const statuses = {};
      const mismatched = [];
      const itemName = (item) =>
        `${item.table}:${item.kind}:${item.key}${item.column ? `:${item.column}` : ""}`;
      for (const { id, stand_in, redacted } of problems.results ?? []) {
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
      console.log(JSON.stringify({ stage: "projection-parity", statuses, mismatched }));
      assert.deepEqual(
        mismatched,
        [],
        "every problem's projections equal their replay, or its exception is stated",
      );
    }
    // W2.1 (jfi): every ledger immutability trigger present must actually
    // refuse on real D1, not merely exist by name. Each is probed on one row the
    // lane wrote; a trigger neutered in place (e.g. WHEN 0) lets the probe
    // through and fails here. Runs last: a probe that wrongly succeeds is
    // already a failure, so its mutation never feeds another check.
    await assertLedgerTriggersRefuse(env.DB);
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
