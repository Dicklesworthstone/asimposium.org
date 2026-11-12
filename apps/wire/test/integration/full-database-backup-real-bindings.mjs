import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { checkpointSigningKey } from "../../src/krater/checkpoint-signing.ts";
import {
  captureDatabaseSql,
  DATABASE_BACKUP_LEASE_KEY,
  DATABASE_CAS_BACKUP_LIMITS,
  databaseCasManifestKey,
  restoreDatabaseBackup,
  restoreDatabaseCasBackup,
  verifyDatabaseBackup,
} from "../../src/krater/database-backup.ts";
import { canonicalJson } from "../../src/krater/krater.ts";
import { validateScratchTarget } from "../../src/krater/restore.ts";
import {
  applyDeletionJournal,
  computeRetentionControlDigest,
  createRetentionControlRecord,
  fetchLatestDeletionJournal,
  findResurrectedTargets,
  parseAndVerifyDeletionJournal,
  serializeDeletionJournal,
} from "../../src/krater/retention.ts";
import {
  CHECKPOINT_KEY_ID,
  CHECKPOINT_PUBLIC_KEY_HEX,
  runLocalWorkerJourney,
} from "./problem-lifecycle-real-bindings.mjs";

// Real Workerd, D1 and private/public R2. The second in-memory Workerd has a
// distinct binding ID and an EMPTY application schema; no source is destroyed
// or overwritten. Raw SQL round-trip is not a current-rights/cutover claim.
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const target = "scratch-full-database-backup";
await mkdir(join(root, "e2e/artifacts"), { recursive: true, mode: 0o700 });
const destinationDirectory = await mkdtemp(join(root, "e2e/artifacts/full-db-destination-"));
const destinationFile = join(destinationDirectory, "private-marker.bin");
const prepare = () =>
  spawnSync(
    "bun",
    ["scripts/verify-database-backup.ts", "--prepare-destination", destinationFile],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 64 * 1024,
    },
  );
const prepared = prepare();
assert.equal(prepared.status, 0, "operator command prepares the actual destination marker");
const destinationMarker = new Uint8Array(await readFile(destinationFile));
assert.equal(destinationMarker.byteLength, 32);
assert.equal((await stat(destinationFile)).mode & 0o777, 0o600);
const destinationSha256 = createHash("sha256").update(destinationMarker).digest("hex");
const destinationKey = `backups/control/database-destinations/${destinationSha256}.bin`;
assert.deepEqual(JSON.parse(prepared.stdout), {
  status: "prepared",
  sha256: destinationSha256,
  marker_key: destinationKey,
  pin_variable: "DATABASE_BACKUP_DESTINATION_SHA256",
});
const duplicatePreparation = prepare();
assert.equal(duplicatePreparation.status, 1);
assert.equal(
  JSON.parse(duplicatePreparation.stderr).code,
  "DATABASE_BACKUP_DESTINATION_OUTPUT_EXISTS",
);
assert.ok(
  (await readFile(destinationFile)).equals(Buffer.from(destinationMarker)),
  "marker preparation never overwrites an existing destination",
);
validateScratchTarget(target);
const scratch = createTestHarness({
  root,
  workers: [
    {
      config: {
        name: target,
        main: `${root}/apps/wire/test/integration/discovery-local-worker.ts`,
        compatibility_date: "2026-08-13",
        compatibility_flags: ["nodejs_compat"],
        d1_databases: [
          {
            binding: "DB",
            database_name: target,
            database_id: "00000000-0000-0000-0000-000000000002",
          },
        ],
        r2_buckets: [
          { binding: "ARTIFACTS", bucket_name: "full-backup-scratch-private" },
          { binding: "PUBLIC_ARTIFACTS", bucket_name: "full-backup-scratch-public" },
          { binding: "ARCHIVE_ONLY", bucket_name: "full-backup-archive-only" },
          { binding: "BAD_ARCHIVE", bucket_name: "full-backup-bad-archive" },
          { binding: "CONFLICT", bucket_name: "full-backup-conflict" },
        ],
        vars: {
          STOA_ORIGIN: "https://a-staging.asimposium.org",
          AGORA_ORIGIN: "https://staging.asimposium.org",
          ENROLLMENT_REPLAY_KEY: Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString(
            "base64url",
          ),
        },
        rules: [{ type: "Text", globs: ["**/*.md", "**/*.txt"], fallthrough: true }],
      },
    },
  ],
});

try {
  await scratch.listen();
  const scratchEnv = await scratch.getWorker().getEnv();
  const scratchDb = scratchEnv.DB;
  assert.equal(
    (
      await scratchDb
        .prepare(
          "SELECT count(*) AS n FROM sqlite_schema WHERE name NOT GLOB '_cf_*' AND name NOT GLOB 'sqlite_*'",
        )
        .first()
    ).n,
    0,
  );

  await runLocalWorkerJourney(
    async ({ call, enroll, sponsorCall, fixtures, env, worker, origin, userAgent, workerLogs }) => {
      assert.ok(
        await env.ARTIFACTS.put(destinationKey, destinationMarker, {
          onlyIf: { etagDoesNotMatch: "*" },
          httpMetadata: { cacheControl: "no-store" },
        }),
        "the operator fixture provisions only the designated private destination",
      );
      const sponsor = "usr_full_database_backup";
      const author = await enroll("full-backup-author", sponsor, {
        requested_scopes: ["promote", "review", "propose-problems", "upload-artifacts"],
      });
      const create = async (title, statement) =>
        (
          await call(
            "/v1/problems",
            {
              title,
              statement,
              falsifier: "An even integer with an odd square.",
              motivation: "Exercise private complete database recovery.",
              areas: ["number-theory"],
            },
            author,
            201,
          )
        ).problem.id;
      const publicProblem = await create(
        "Full database public problem",
        "Every even integer has an even square.",
      );
      await sponsorCall(
        sponsor,
        "POST",
        `/v1/sponsors/problems/${publicProblem}/lifecycle`,
        "problem-lifecycle",
        { action: "publish" },
      );
      const reviewer = await enroll("full-backup-reviewer", "usr_full_backup_reviewer");
      const lateFellow = await enroll("full-backup-late-control", "usr_full_backup_late");
      const reviewSession = (
        await call("/v1/sessions", { problem_id: publicProblem, intent: "review" }, reviewer, 201)
      ).session_id;
      await call(
        `/v1/problems/${publicProblem}/statement-review`,
        {
          session_id: reviewSession,
          statement_version: 1,
          verdict: "statement-clear",
          basis: "Exact integer domain.",
        },
        reviewer,
      );
      const privateProblem = await create(
        "Full database private problem",
        "Adding two nonnegative integers produces a nonnegative sum.",
      );
      const privateSession = (
        await call(
          "/v1/sessions",
          {
            problem_id: privateProblem,
            intent: "prove",
          },
          author,
          201,
        )
      ).session_id;
      await call(
        `/v1/sessions/${privateSession}/workshop`,
        {
          type: "claim-draft",
          title: "Recoverable private draft",
          body_md: "erasedsnapshotcanary",
        },
        author,
        201,
      );
      const session = (
        await call("/v1/sessions", { problem_id: publicProblem, intent: "prove" }, author, 201)
      ).session_id;
      const canary = "privatesnapshotcanary";
      const draft = await call(
        `/v1/sessions/${session}/workshop`,
        {
          type: "claim-draft",
          title: "Private recoverable work",
          body_md: canary,
        },
        author,
        201,
      );
      await call(
        `/v1/sessions/${session}/promote`,
        {
          workshop_id: draft.workshop_id,
          kind: "conjecture",
          statement: "The square of zero is even.",
          falsifier: "Zero squared is odd.",
        },
        author,
        201,
      );

      const historicalBody = `Private historical recovery. ${"An even integer has an even square. π\n".repeat(45)}`;
      const currentBody = `Private current recovery. ${"Two nonnegative integers have a nonnegative sum. λ\n".repeat(45)}`;
      const largeDraft = await call(
        `/v1/sessions/${session}/workshop`,
        {
          type: "claim-draft",
          title: "Full private body recovery",
          body_md: historicalBody,
        },
        author,
        201,
      );
      await call(
        `/v1/sessions/${session}/workshop`,
        {
          workshop_id: largeDraft.workshop_id,
          base_version: largeDraft.version,
          body_md: currentBody,
        },
        author,
        201,
      );
      const bodyPath = `/v1/sessions/${session}/workshop/${largeDraft.workshop_id}`;
      assert.equal((await call(bodyPath, undefined, author)).object.body_md, currentBody);
      assert.equal(
        (await call(`${bodyPath}?version=1`, undefined, author)).object.body_md,
        historicalBody,
      );
      const hash = (value) => createHash("sha256").update(value).digest("hex");
      const artifactBytes = new TextEncoder().encode("Private verified recovery artifact.\n");
      const artifactHash = hash(artifactBytes);
      const artifact = await call(
        "/v1/artifacts",
        {
          session_id: session,
          sha256: artifactHash,
          size_bytes: artifactBytes.byteLength,
          encoding: "text",
        },
        author,
        201,
      );
      // Local staging fixture, followed by actual complete/verification admission.
      // This does not claim a provider presigned upload was exercised.
      await fixtures.stageArtifact(artifact.upload_id, artifactBytes);
      assert.equal((await call(artifact.complete_path, {}, author)).state, "verified");
      const stagedBytes = new TextEncoder().encode("Unverified staging is not recoverable CAS.\n");
      const unverifiedArtifact = await call(
        "/v1/artifacts",
        {
          session_id: session,
          sha256: hash(stagedBytes),
          size_bytes: stagedBytes.byteLength,
          encoding: "text",
        },
        author,
        201,
      );
      await fixtures.stageArtifact(unverifiedArtifact.upload_id, stagedBytes);
      const expectedHashes = [hash(historicalBody), hash(currentBody), artifactHash].sort();

      // Independent synthetic SQLite edge values alongside actual product rows.
      await env.DB.batch([
        env.DB.prepare(
          "CREATE TABLE database_backup_value_probe (id INTEGER PRIMARY KEY AUTOINCREMENT, exact_integer INTEGER, body TEXT, bytes BLOB, fraction REAL)",
        ),
        env.DB.prepare(
          "INSERT INTO database_backup_value_probe (id, exact_integer, body, bytes, fraction) VALUES (99, 9223372036854775807, CAST(X'00610AFF273B' AS TEXT), X'0001FEFF', 1.0000000000000002)",
        ),
        env.DB.prepare("DELETE FROM database_backup_value_probe WHERE id = 99"),
        env.DB.prepare(
          "INSERT INTO database_backup_value_probe (id, exact_integer, body, bytes, fraction) VALUES (2, -9223372036854775808, ?, X'0001FEFF', -0.125)",
        ).bind("NUL\0line\n'; SQL remains data. π"),
        env.DB.prepare(
          "INSERT INTO database_backup_value_probe (id, exact_integer, body, bytes, fraction) VALUES (3, 9223372036854775807, CAST(X'00610AFF273B' AS TEXT), X'AB00CD', 1.0000000000000002)",
        ),
        env.DB.prepare(
          "INSERT INTO database_backup_value_probe (id, exact_integer, body, bytes, fraction) VALUES (4, NULL, NULL, NULL, 9e999)",
        ),
        env.DB.prepare(
          "CREATE INDEX database_backup_value_probe_body ON database_backup_value_probe(body)",
        ),
        env.DB.prepare(
          "CREATE VIEW database_backup_probe_view AS SELECT id, exact_integer FROM database_backup_value_probe",
        ),
        env.DB.prepare(
          "CREATE TRIGGER database_backup_probe_guard BEFORE DELETE ON database_backup_value_probe BEGIN SELECT RAISE(ABORT, 'probe immutable'); END",
        ),
        env.DB.prepare(
          'CREATE TABLE "database_backup_odd" ("rowid" TEXT, "quote""column" TEXT, generated TEXT GENERATED ALWAYS AS ("rowid" || \'!\') STORED)',
        ),
        env.DB.prepare(
          'INSERT INTO "database_backup_odd" ("rowid", "quote""column") VALUES (\'own rowid column\', \'quoted column\')',
        ),
        env.DB.prepare(
          "CREATE TABLE database_backup_without_rowid (id TEXT PRIMARY KEY, value ANY) STRICT, WITHOUT ROWID",
        ),
        env.DB.prepare(
          "INSERT INTO database_backup_without_rowid (id, value) VALUES ('a', X'0011'), ('b', 17.25)",
        ),
        env.DB.prepare(
          "CREATE TABLE z_database_backup_sequence (id INTEGER PRIMARY KEY AUTOINCREMENT)",
        ),
        env.DB.prepare("INSERT INTO z_database_backup_sequence (id) VALUES (50)"),
        env.DB.prepare(
          "UPDATE sqlite_sequence SET seq = 7 WHERE name = 'z_database_backup_sequence'",
        ),
      ]);
      assert.deepEqual((await captureDatabaseSql(env.DB)).casInventory, {
        status: "complete",
        hashes: expectedHashes,
      });
      assert.deepEqual((await env.ARTIFACTS.list({ prefix: "backups/sql/" })).objects, []);
      const firstScheduled = await worker.scheduled({ cron: "*/5 * * * *" });
      if (firstScheduled.outcome !== "ok")
        console.error(
          JSON.stringify({
            stage: "database-backup-cron-error",
            codes: workerLogs()
              .filter((entry) => entry.message.includes('"stage":"nightly-database-backup"'))
              .map((entry) => JSON.parse(entry.message).code)
              .filter((code) => /^DATABASE_[A-Z_]+$/.test(code)),
          }),
        );
      assert.equal(
        firstScheduled.outcome,
        "ok",
        "production scheduled entrypoint creates the first SQL backup",
      );
      const completed = (await env.ARTIFACTS.list({ prefix: "backups/sql/" })).objects.filter(
        (object) => object.key.endsWith("/complete.json"),
      );
      assert.equal(
        completed.length,
        1,
        "cron must publish exactly one completion from absent state",
      );
      const manifestKey = completed[0].key;
      const manifest = await (await env.ARTIFACTS.get(manifestKey)).json();
      const casKey = databaseCasManifestKey(manifest.sql_key);
      const firstCasObject = await env.ARTIFACTS.get(casKey);
      assert.ok(
        firstCasObject,
        "production cron publishes CAS completion from absent state before any fixture tick",
      );
      const casManifest = await firstCasObject.json();
      const now = Date.parse(manifest.created_at);
      assert.equal((await fixtures.databaseBackupTick(now + 1)).status, "complete");
      const sql = await (await env.ARTIFACTS.get(manifest.sql_key)).text();
      const keys = [{ kid: CHECKPOINT_KEY_ID, publicKeyHex: CHECKPOINT_PUBLIC_KEY_HEX }];
      const verified = await verifyDatabaseBackup(manifest, sql, keys);
      assert.equal(manifest.format, "asimposium.database-backup.v2");
      assert.deepEqual(manifest.cas_inventory, { status: "complete", hashes: expectedHashes });
      const referenceRows = (
        await env.DB.prepare(
          "SELECT cas_hash FROM workshop_objects WHERE cas_hash IS NOT NULL UNION ALL SELECT cas_hash FROM workshop_revisions WHERE cas_hash IS NOT NULL",
        ).all()
      ).results;
      assert.ok(
        referenceRows.length > new Set(referenceRows.map((row) => row.cas_hash)).size,
        "genuine head/history references are deduplicated",
      );
      assert.deepEqual(
        casManifest.objects.map((object) => object.sha256),
        expectedHashes,
      );
      assert.equal((await fixtures.databaseBackupTick(now + 1)).cas_objects, 3);
      assert.ok(!casManifest.objects.some((object) => object.sha256 === hash(stagedBytes)));
      assert.equal(verified.metadata.source.binding, "DB");
      assert.deepEqual(verified.metadata.rebuilt_fts, ["private_workshop_search"]);
      assert.ok(verified.metadata.tables.some((t) => t.name === "fellow_tokens" && t.rows > 0));
      assert.ok(verified.metadata.tables.some((t) => t.name === "workshop_objects" && t.rows > 0));
      const roster = (await env.DB.prepare("PRAGMA table_list").all()).results
        .filter(
          (t) =>
            t.schema === "main" &&
            ["table", "virtual"].includes(t.type) &&
            (t.name === "sqlite_sequence" || !t.name.startsWith("sqlite_")) &&
            !t.name.startsWith("_cf_"),
        )
        .map((t) => t.name)
        .sort();
      assert.deepEqual(
        manifest.tables.map((t) => t.name).sort(),
        roster,
        "every application table, not a public-only selection",
      );
      assert.deepEqual((await env.PUBLIC_ARTIFACTS.list({ prefix: "backups/" })).objects, []);

      // No import is attempted on these failures. No archive-selected key, byte
      // truncation or altered signed scope can expose executable SQL as verified.
      await assert.rejects(
        verifyDatabaseBackup(manifest, sql.slice(0, -1), keys),
        /DATABASE_BACKUP_DIGEST_INVALID/,
      );
      await assert.rejects(
        verifyDatabaseBackup({ ...manifest, sql_sha256: "0".repeat(64) }, sql, keys),
        /DATABASE_BACKUP_SIGNATURE_INVALID/,
      );
      await assert.rejects(
        verifyDatabaseBackup(manifest, sql, []),
        /DATABASE_BACKUP_UNTRUSTED_KEY/,
      );
      const foreign = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
      const foreignHex = Buffer.from(
        await crypto.subtle.exportKey("raw", foreign.publicKey),
      ).toString("hex");
      await assert.rejects(
        verifyDatabaseBackup(manifest, sql, [{ kid: CHECKPOINT_KEY_ID, publicKeyHex: foreignHex }]),
        /DATABASE_BACKUP_SIGNATURE_INVALID/,
      );
      assert.equal(
        (
          await scratchDb
            .prepare(
              "SELECT count(*) AS n FROM sqlite_schema WHERE name NOT GLOB '_cf_*' AND name NOT GLOB 'sqlite_*'",
            )
            .first()
        ).n,
        0,
      );

      const downloaded = await mkdtemp(join(root, "e2e/artifacts/full-db-backup-"));
      const manifestFile = join(downloaded, "complete.json");
      const sqlFile = join(downloaded, "snapshot.sql");
      const corruptFile = join(downloaded, "truncated.sql");
      await writeFile(manifestFile, JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
      await writeFile(sqlFile, sql, { flag: "wx", mode: 0o600 });
      await writeFile(corruptFile, sql.slice(0, -1), { flag: "wx", mode: 0o600 });
      const cli = (file) =>
        spawnSync(
          "bun",
          [
            "scripts/verify-database-backup.ts",
            "--manifest",
            manifestFile,
            "--sql",
            file,
            "--key",
            `${CHECKPOINT_KEY_ID}=${CHECKPOINT_PUBLIC_KEY_HEX}`,
          ],
          {
            cwd: root,
            encoding: "utf8",
            timeout: 30000,
            maxBuffer: 64 * 1024,
          },
        );
      const goodCli = cli(sqlFile);
      assert.equal(goodCli.status, 0, "offline CLI verifies an actual private archive");
      assert.equal(JSON.parse(goodCli.stdout).status, "verified");
      assert.ok(
        !goodCli.stdout.includes(canary) && !goodCli.stderr.includes(canary),
        "offline verification never prints private bytes",
      );
      const badCli = cli(corruptFile);
      assert.equal(badCli.status, 1);
      assert.equal(JSON.parse(badCli.stderr).code, "DATABASE_BACKUP_DIGEST_INVALID");

      // One transaction, deferring foreign keys until all mutually referring
      // rows exist. Triggers/indexes are installed after base data by the dump.
      await scratchDb.batch([
        scratchDb.prepare("PRAGMA defer_foreign_keys = ON"),
        ...verified.statements.map((statement) => scratchDb.prepare(statement)),
      ]);
      assert.deepEqual((await scratchDb.prepare("PRAGMA foreign_key_check").all()).results, []);
      for (const table of manifest.tables) {
        const name = `"${table.name.replaceAll('"', '""')}"`;
        assert.equal(
          (await scratchDb.prepare(`SELECT count(*) AS n FROM ${name}`).first()).n,
          table.rows,
          `complete row count: ${table.name}`,
        );
      }
      const again = await captureDatabaseSql(scratchDb);
      assert.ok(
        again.sql === sql,
        "all logical rows, values, rowids, sequences and schema round-trip exactly",
      );
      assert.deepEqual(again.casInventory, manifest.cas_inventory);

      // Restore sees ONLY archive objects, not the live source CAS. Independently
      // provision a different target marker; neither source archive nor public
      // bucket is allowed to carry that scratch designation.
      const targetMarker = crypto.getRandomValues(new Uint8Array(32));
      const targetPin = hash(targetMarker);
      const targetKey = `backups/control/database-destinations/${targetPin}.bin`;
      await scratchEnv.ARTIFACTS.put(targetKey, targetMarker, {
        onlyIf: { etagDoesNotMatch: "*" },
      });
      await scratchEnv.CONFLICT.put(targetKey, targetMarker, { onlyIf: { etagDoesNotMatch: "*" } });
      for (const object of casManifest.objects) {
        const key = `${manifest.sql_key}.cas/${object.sha256}`;
        const source = await env.ARTIFACTS.get(key);
        await scratchEnv.ARCHIVE_ONLY.put(key, await source.arrayBuffer(), {
          ...(object.sha256 === hash(historicalBody) ? {} : { sha256: object.sha256 }),
          onlyIf: { etagDoesNotMatch: "*" },
        });
      }
      assert.deepEqual((await scratchEnv.ARCHIVE_ONLY.list({ prefix: "cas/" })).objects, []);
      const restoreBodies = {
        archive: scratchEnv.ARCHIVE_ONLY,
        target: scratchEnv.ARTIFACTS,
        publicBucket: scratchEnv.PUBLIC_ARTIFACTS,
        targetIdentifier: target,
        destinationSha256: targetPin,
        expectedSourceOrigin: origin,
        manifest,
        sql,
        casManifest,
        verifyKeys: keys,
      };
      const scratchRead = (path, token = author) =>
        scratch.getWorker().fetch(`${origin}${path}`, {
          headers: {
            "User-Agent": userAgent,
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
        });
      for (const path of [bodyPath, `${bodyPath}?version=1`]) {
        const response = await scratchRead(path);
        assert.equal(response.status, 500, "owning materialization reaches missing private CAS");
        const text = await response.text();
        assert.ok(!text.includes(currentBody) && !text.includes(historicalBody));
      }
      const noBodies = async () =>
        assert.deepEqual((await scratchEnv.ARTIFACTS.list({ prefix: "cas/" })).objects, []);
      for (const override of [
        { expectedSourceOrigin: "https://another.asimposium.org" },
        { destinationSha256: "0".repeat(64) },
        { destinationSha256: "invalid" },
        { targetIdentifier: "production" },
        { target: scratchEnv.PUBLIC_ARTIFACTS },
        { target: scratchEnv.ARCHIVE_ONLY },
        { casManifest: { ...casManifest, signature: "0".repeat(128) } },
        { casManifest: { ...casManifest, objects: casManifest.objects.slice(1) } },
        { casManifest: { ...casManifest, sql_key: `${manifest.sql_key}/../other` } },
        { verifyKeys: [] },
        { archive: scratchEnv.BAD_ARCHIVE },
      ]) {
        await assert.rejects(restoreDatabaseCasBackup({ ...restoreBodies, ...override }));
        await noBodies();
      }
      const signCas = async (changes) => {
        const { signature: _signature, ...metadata } = { ...casManifest, ...changes };
        const signing = await checkpointSigningKey(env.CHECKPOINT_SIGNING_KEY);
        return {
          ...metadata,
          signature: Buffer.from(
            await crypto.subtle.sign(
              "Ed25519",
              signing.privateKey,
              new TextEncoder().encode(canonicalJson(metadata)),
            ),
          ).toString("hex"),
        };
      };
      for (const changes of [
        { source: { binding: "DB", origin: "https://another.asimposium.org" } },
        { sql_sha256: "0".repeat(64) },
        { objects: casManifest.objects.slice(1) },
        { objects: [...casManifest.objects].reverse() },
        {
          objects: casManifest.objects.map((object, index) =>
            index ? object : { ...object, bytes: object.bytes + 1 },
          ),
        },
        {
          objects: casManifest.objects.map((object) => ({
            ...object,
            bytes: DATABASE_CAS_BACKUP_LIMITS.objectBytes + 1,
          })),
        },
        {
          objects: casManifest.objects.map((object) => ({
            ...object,
            bytes: DATABASE_CAS_BACKUP_LIMITS.objectBytes,
          })),
        },
        { objects: [casManifest.objects[0], casManifest.objects[0], casManifest.objects[2]] },
      ]) {
        await assert.rejects(
          restoreDatabaseCasBackup({ ...restoreBodies, casManifest: await signCas(changes) }),
        );
        await noBodies();
      }
      const first = casManifest.objects[0];
      await scratchEnv.CONFLICT.put(`cas/sha256/${first.sha256}`, "conflicting bytes", {
        onlyIf: { etagDoesNotMatch: "*" },
      });
      await assert.rejects(
        restoreDatabaseCasBackup({ ...restoreBodies, target: scratchEnv.CONFLICT }),
        /DATABASE_CAS_TARGET_CONFLICT/,
      );
      for (const object of casManifest.objects) {
        const key = `${manifest.sql_key}.cas/${object.sha256}`;
        const body =
          object.sha256 === first.sha256
            ? new Uint8Array(object.bytes).fill(120)
            : new Uint8Array(await (await scratchEnv.ARCHIVE_ONLY.get(key)).arrayBuffer());
        // No SHA metadata: actual bounded hashing must catch same-size corruption.
        await scratchEnv.BAD_ARCHIVE.put(key, body, { onlyIf: { etagDoesNotMatch: "*" } });
      }
      await assert.rejects(
        restoreDatabaseCasBackup({ ...restoreBodies, archive: scratchEnv.BAD_ARCHIVE }),
        /DATABASE_CAS_DIGEST_INVALID/,
      );
      await noBodies();
      assert.equal(
        await (await scratchEnv.CONFLICT.get(`cas/sha256/${first.sha256}`)).text(),
        "conflicting bytes",
      );
      // Correct pre-existing partial bytes are verified and retained, not overwritten.
      const partialKey = `cas/sha256/${hash(historicalBody)}`;
      const partialBody = await scratchEnv.ARTIFACTS.put(partialKey, historicalBody, {
        onlyIf: { etagDoesNotMatch: "*" },
      });
      const restoredBodies = await restoreDatabaseCasBackup(restoreBodies);
      assert.equal(restoredBodies.status, "cas-restored");
      assert.equal(restoredBodies.serviceReady, false);
      assert.equal(restoredBodies.objects, 3);
      assert.equal(restoredBodies.written, 2);
      assert.equal(
        (await scratchEnv.ARTIFACTS.head(partialKey)).etag,
        partialBody.etag,
        "correct pre-existing ordinary CAS bytes are retained without checksum metadata",
      );
      for (const [path, expected, version] of [
        [bodyPath, currentBody, 2],
        [`${bodyPath}?version=1`, historicalBody, 1],
      ]) {
        const response = await scratchRead(path);
        assert.equal(response.status, 200, "actual owning read after archive-only recovery");
        const data = await response.json();
        assert.equal(data.object.body_md, expected);
        assert.equal(data.object.version, version);
        assert.equal(data.body_sha256, hash(expected));
        assert.equal((await scratchRead(path, reviewer)).status, 404);
        assert.equal((await scratchRead(path, null)).status, 401);
      }
      const restoredArtifact = await scratchRead(`/v1/artifacts/${artifact.upload_id}/content`);
      assert.equal(restoredArtifact.status, 200);
      assert.deepEqual(new Uint8Array(await restoredArtifact.arrayBuffer()), artifactBytes);
      assert.equal(
        (await scratchRead(`/v1/artifacts/${artifact.upload_id}/content`, reviewer)).status,
        401,
      );
      assert.equal(
        (await scratchRead(`/v1/artifacts/${artifact.upload_id}/content`, null)).status,
        401,
      );
      const publicFace = await scratchRead(`/p/${publicProblem}.md`, null);
      assert.equal(publicFace.status, 200);
      const publicText = await publicFace.text();
      assert.ok(
        !publicText.includes(currentBody) &&
          !publicText.includes(historicalBody) &&
          !publicText.includes("Private verified recovery artifact."),
      );
      assert.equal((await restoreDatabaseCasBackup(restoreBodies)).written, 0);
      assert.deepEqual((await scratchEnv.PUBLIC_ARTIFACTS.list()).objects, []);
      // A marker copied into either wrong namespace invalidates designation.
      await scratchEnv.BAD_ARCHIVE.put(targetKey, targetMarker);
      await assert.rejects(
        restoreDatabaseCasBackup({ ...restoreBodies, archive: scratchEnv.BAD_ARCHIVE }),
        /PRIVATE_DESTINATION_UNVERIFIED/,
      );
      await scratchEnv.PUBLIC_ARTIFACTS.put(targetKey, targetMarker);
      await assert.rejects(
        restoreDatabaseCasBackup(restoreBodies),
        /PRIVATE_DESTINATION_UNVERIFIED/,
      );
      console.log(
        JSON.stringify({
          stage: "full-database-cas-recovery-passed",
          objects: 3,
          boundary:
            "real local archive-only private CAS; quarantined; no provider upload, current-rights or cutover claim",
        }),
      );
      const edgeQuery =
        "SELECT id, CAST(exact_integer AS TEXT) AS exact_integer, hex(body) AS body, hex(bytes) AS bytes, printf('%!.17g', fraction) AS fraction FROM database_backup_value_probe ORDER BY id";
      assert.ok(
        JSON.stringify((await scratchDb.prepare(edgeQuery).all()).results) ===
          JSON.stringify((await env.DB.prepare(edgeQuery).all()).results),
        "independent exact integer/float/text/BLOB comparison",
      );
      assert.equal(
        (
          await scratchDb
            .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'z_database_backup_sequence'")
            .first()
        ).seq,
        7,
      );
      const logicalSchema = async (db) => {
        const shadow = new Set(
          (await db.prepare("PRAGMA table_list").all()).results
            .filter((t) => t.type === "shadow")
            .map((t) => t.name),
        );
        return (
          await db
            .prepare(
              "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY type, name",
            )
            .all()
        ).results.filter((row) => !shadow.has(row.name) && !shadow.has(row.tbl_name));
      };
      assert.deepEqual(
        await logicalSchema(scratchDb),
        await logicalSchema(env.DB),
        "every table, index, trigger and view definition",
      );
      for (const name of ["public_claim_fts", "private_workshop_search"]) {
        assert.deepEqual(
          (await scratchDb.prepare(`SELECT k, v FROM ${name}_config ORDER BY k`).all()).results,
          (await env.DB.prepare(`SELECT k, v FROM ${name}_config ORDER BY k`).all()).results,
          "FTS default configuration retained",
        );
      }
      assert.equal(
        (
          await scratchDb
            .prepare("SELECT status FROM problems WHERE id = ?")
            .bind(privateProblem)
            .first()
        ).status,
        "private-draft",
      );
      assert.ok(
        (
          await scratchDb
            .prepare(
              "SELECT count(*) AS n FROM private_workshop_search WHERE private_workshop_search MATCH ?",
            )
            .bind(canary)
            .first()
        ).n > 0,
        "private FTS reconstructed",
      );
      assert.ok(
        (
          await scratchDb
            .prepare(
              "SELECT count(*) AS n FROM public_claim_fts WHERE public_claim_fts MATCH 'square'",
            )
            .first()
        ).n > 0,
        "public FTS retained",
      );
      assert.deepEqual(
        await scratchDb
          .prepare("SELECT public_seq, chain_digest FROM problems WHERE id = ?")
          .bind(publicProblem)
          .first(),
        await env.DB.prepare("SELECT public_seq, chain_digest FROM problems WHERE id = ?")
          .bind(publicProblem)
          .first(),
      );
      await assert.rejects(
        scratchDb.prepare("DELETE FROM database_backup_value_probe WHERE id = 2").run(),
        /probe immutable/,
      );
      assert.equal((await fixtures.databaseBackupTick(now + 1)).status, "complete");
      assert.equal(
        await (await env.ARTIFACTS.get(manifestKey)).text(),
        JSON.stringify(manifest),
        "existing completion is immutable",
      );
      assert.equal(
        (await worker.scheduled({ cron: "*/5 * * * *" })).outcome,
        "ok",
        "real production cron consumes the completed backup",
      );

      const tomorrow = now + 24 * 60 * 60 * 1000;
      const tomorrowDate = new Date(tomorrow).toISOString().slice(0, 10);
      const orphanKey = `backups/sql/${tomorrowDate}/${crypto.randomUUID()}.sql`;
      await env.ARTIFACTS.put(orphanKey, sql, { sha256: manifest.sql_sha256 });
      await env.ARTIFACTS.put(
        DATABASE_BACKUP_LEASE_KEY,
        JSON.stringify({ owner: crypto.randomUUID(), expiresAt: tomorrow + 1000 }),
      );
      assert.equal((await fixtures.databaseBackupTick(tomorrow)).status, "busy");
      assert.equal(await env.ARTIFACTS.get(`backups/sql/${tomorrowDate}/complete.json`), null);
      const recovered = await fixtures.databaseBackupTick(tomorrow + 1001);
      assert.equal(recovered.status, "written", "expired interrupted writer is recovered");
      const nextManifest = await (
        await env.ARTIFACTS.get(`backups/sql/${tomorrowDate}/complete.json`)
      ).json();
      assert.notEqual(
        nextManifest.sql_key,
        orphanKey,
        "an orphan upload is never a completion witness",
      );
      assert.ok(
        (await (await env.ARTIFACTS.get(orphanKey)).text()) === sql,
        "interrupted objects are preserved",
      );
      await verifyDatabaseBackup(
        nextManifest,
        await (await env.ARTIFACTS.get(nextManifest.sql_key)).text(),
        keys,
      );

      const wrongDestinationDay = tomorrow + 24 * 60 * 60 * 1000;
      let swapCode;
      try {
        await fixtures.databaseBackupTick(wrongDestinationDay, "swapped");
      } catch (error) {
        swapCode = error.message;
      }
      const publicBackupObjects = (await env.PUBLIC_ARTIFACTS.list({ prefix: "backups/sql/" }))
        .objects;
      console.log(
        JSON.stringify({
          stage: "database-backup-wrong-destination",
          public_objects: publicBackupObjects.length,
          refused: swapCode === "DATABASE_BACKUP_PRIVATE_DESTINATION_UNVERIFIED",
        }),
      );
      assert.equal(
        publicBackupObjects.length,
        0,
        "a distinct public destination receives no SQL or completion",
      );
      assert.ok(
        swapCode === "DATABASE_BACKUP_PRIVATE_DESTINATION_UNVERIFIED",
        "a distinct role swap refuses before export",
      );
      const disabled = await fixtures.databaseBackupTick(wrongDestinationDay, "unconfigured");
      assert.equal(disabled.enabled, false);
      assert.equal(disabled.reason, "destination-pin-missing");
      await assert.rejects(
        async () => await fixtures.databaseBackupTick(wrongDestinationDay, "invalid-pin"),
        /DATABASE_BACKUP_DESTINATION_PIN_INVALID/,
      );
      assert.equal(
        await env.ARTIFACTS.get(
          `backups/sql/${new Date(wrongDestinationDay).toISOString().slice(0, 10)}/complete.json`,
        ),
        null,
      );
      const alteredMarker = Uint8Array.from(destinationMarker);
      alteredMarker[0] ^= 1;
      await env.ARTIFACTS.put(destinationKey, alteredMarker);
      try {
        await assert.rejects(
          async () => await fixtures.databaseBackupTick(now + 2),
          /DATABASE_BACKUP_PRIVATE_DESTINATION_UNVERIFIED/,
          "completed archives do not bypass current destination verification",
        );
      } finally {
        await env.ARTIFACTS.put(destinationKey, destinationMarker);
      }

      // Recover the SAME signed historical snapshot under independently current
      // controls. These are actual sponsor writes and actual R2 publication;
      // the original raw snapshot/schema/value/FTS assertions above remain.
      const historicalJournal = await fetchLatestDeletionJournal(env.ARTIFACTS, keys);
      assert.ok(historicalJournal);
      const credential = await env.DB.prepare(
        "SELECT credential_id, fellow_id, token_hash, credential_profile FROM fellow_tokens WHERE sponsor_id = ? AND revoked_at IS NULL",
      )
        .bind(sponsor)
        .first();
      const laterCredential = await env.DB.prepare(
        "SELECT credential_id, fellow_id, token_hash, credential_profile FROM fellow_tokens WHERE sponsor_id = ? AND revoked_at IS NULL",
      )
        .bind("usr_full_backup_late")
        .first();
      assert.ok(credential && laterCredential);
      const revoke = async (row, owner) => {
        await sponsorCall(
          owner,
          "POST",
          "/v1/fellows/credentials/revoke",
          "fellow.credential.revoke",
          {
            credential_id: row.credential_id,
            fellow_id: row.fellow_id,
            confirm: "revoke-credential",
            step_up_authenticated_at: Math.floor(Date.now() / 1000),
          },
        );
      };
      await sponsorCall(
        sponsor,
        "DELETE",
        `/v1/sponsors/problems/${privateProblem}`,
        "delete-problem-draft",
      );
      await revoke(credential, sponsor);
      await call("/v1/hello", undefined, author, 401);
      await fixtures.publishDeletionJournalTick();
      const currentJournal = await fetchLatestDeletionJournal(env.ARTIFACTS, keys);
      assert.ok(
        currentJournal && currentJournal.head.recordCount > historicalJournal.head.recordCount,
      );
      const currentHead = async () =>
        (await fetchLatestDeletionJournal(env.ARTIFACTS, keys))?.head ?? null;
      const controls = await parseAndVerifyDeletionJournal(currentJournal.ndjson, keys);
      assert.ok(controls.valid);
      assert.ok(controls.records.some((record) => record.action === "delete-private-draft"));
      assert.ok(controls.records.some((record) => record.action === "revoke-credential"));
      const rawPolicy = await scratch.getWorker().getExport();
      const privateContents = async (db) =>
        db
          .prepare(`SELECT
        (SELECT count(*) FROM problem_statement_versions WHERE problem_id = ?1) AS statements,
        (SELECT count(*) FROM workshop_objects WHERE problem_id = ?1) AS workshops,
        (SELECT count(*) FROM workshop_revisions WHERE problem_id = ?1) AS revisions,
        (SELECT count(*) FROM problems WHERE id = ?1 AND
          (title <> '' OR sponsor_id IS NOT NULL OR created_by_fellow_id IS NOT NULL)) AS identity`)
          .bind(privateProblem)
          .first();
      const archivedPrivate = await privateContents(scratchDb);
      assert.ok(
        archivedPrivate.statements > 0 &&
          archivedPrivate.workshops > 0 &&
          archivedPrivate.identity > 0,
        "raw SQL actually contains the later-erased private state",
      );
      assert.ok(
        await rawPolicy.restoredCredentialIsActive(
          credential.token_hash,
          credential.credential_profile,
        ),
        "the raw historical import really contains a live credential before replay",
      );
      const scratchHarness = (suffix) =>
        createTestHarness({
          root,
          workers: [
            {
              config: {
                name: `scratch-database-controls-${suffix}`,
                main: `${root}/apps/wire/test/integration/discovery-local-worker.ts`,
                compatibility_date: "2026-08-13",
                compatibility_flags: ["nodejs_compat"],
                d1_databases: [
                  {
                    binding: "DB",
                    database_name: `scratch-database-controls-${suffix}`,
                    database_id: `00000000-0000-0000-0000-${String(suffix).padStart(12, "0")}`,
                  },
                ],
                r2_buckets: [
                  { binding: "CONTROL_JOURNAL", bucket_name: `scratch-current-journal-${suffix}` },
                ],
                rules: [{ type: "Text", globs: ["**/*.md", "**/*.txt"], fallthrough: true }],
              },
            },
          ],
        });
      const applicationTables = async (db) =>
        (
          await db
            .prepare(
              "SELECT count(*) AS n FROM sqlite_schema WHERE name NOT GLOB '_cf_*' AND name NOT GLOB 'sqlite_*'",
            )
            .first()
        ).n;
      let preflightRefusals = 0;
      const guarded = scratchHarness(3);
      try {
        await guarded.listen();
        const bindings = await guarded.getWorker().getEnv();
        const db = bindings.DB;
        const targetPolicy = await guarded.getWorker().getExport();
        const restoreOptions = {
          db,
          targetIdentifier: "scratch-database-controls-3",
          expectedSourceOrigin: env.STOA_ORIGIN,
          manifest,
          sql,
          verifyKeys: keys,
          deletionJournalNdjson: currentJournal.ndjson,
          readCurrentJournal: currentHead,
          revokeCredential: (control) => targetPolicy.replayRestoredCredential(control),
        };
        const rejectBeforeImport = async (overrides, expected) => {
          await assert.rejects(
            restoreDatabaseBackup({ ...restoreOptions, ...overrides }),
            expected,
          );
          assert.equal(
            await applicationTables(db),
            0,
            "a refused preflight must leave the actual target EMPTY",
          );
          preflightRefusals++;
        };
        await rejectBeforeImport(
          { targetIdentifier: "production-main" },
          /RESTORE_NON_SCRATCH_TARGET_REFUSED/,
        );
        await rejectBeforeImport(
          { expectedSourceOrigin: "https://different-source.asimposium.invalid" },
          /DATABASE_RESTORE_SOURCE_MISMATCH/,
        );
        await rejectBeforeImport({ sql: sql.slice(0, -1) }, /DATABASE_BACKUP_DIGEST_INVALID/);
        await rejectBeforeImport(
          { manifest: { ...manifest, sql_sha256: "0".repeat(64) } },
          /DATABASE_BACKUP_SIGNATURE_INVALID/,
        );
        await rejectBeforeImport({ verifyKeys: [] }, /DATABASE_BACKUP_UNTRUSTED_KEY/);
        await rejectBeforeImport({ deletionJournalNdjson: null }, /DELETION_JOURNAL_MISSING/);
        await rejectBeforeImport(
          {
            deletionJournalNdjson: currentJournal.ndjson.replace('"signature":"', '"signature":"0'),
          },
          /DELETION_JOURNAL_VERIFICATION_FAILED/,
        );
        await rejectBeforeImport(
          { deletionJournalNdjson: historicalJournal.ndjson },
          /DELETION_JOURNAL_STALE/,
        );
        await rejectBeforeImport(
          {
            readCurrentJournal: async () =>
              (await fetchLatestDeletionJournal(bindings.CONTROL_JOURNAL, keys))?.head ?? null,
          },
          /DELETION_JOURNAL_CURRENT_HEAD_MISSING/,
        );
        await rejectBeforeImport({ revokeCredential: undefined }, /CREDENTIAL_REVOKER_REQUIRED/);
        const unsupported = await serializeDeletionJournal(
          [
            await createRetentionControlRecord({
              action: "unbind-private-cas",
              targetId: "synthetic-cas-binding",
              targetType: "cas_artifact",
            }),
          ],
          undefined,
          await checkpointSigningKey(env.CHECKPOINT_SIGNING_KEY),
        );
        await bindings.CONTROL_JOURNAL.put("journal/deletion/v1/0000000001.ndjson", unsupported);
        await rejectBeforeImport(
          {
            deletionJournalNdjson: unsupported,
            readCurrentJournal: async () =>
              (await fetchLatestDeletionJournal(bindings.CONTROL_JOURNAL, keys))?.head ?? null,
          },
          /DELETION_CONTROL_UNSUPPORTED/,
        );
        const wrongType = await serializeDeletionJournal(
          [
            ...controls.records,
            await createRetentionControlRecord({
              action: "delete-private-draft",
              targetId: privateProblem,
              targetType: "credential",
            }),
          ],
          undefined,
          await checkpointSigningKey(env.CHECKPOINT_SIGNING_KEY),
        );
        await bindings.CONTROL_JOURNAL.put(
          `journal/deletion/v1/${String(controls.records.length + 1).padStart(10, "0")}.ndjson`,
          wrongType,
        );
        await rejectBeforeImport(
          {
            deletionJournalNdjson: wrongType,
            readCurrentJournal: async () =>
              (await fetchLatestDeletionJournal(bindings.CONTROL_JOURNAL, keys))?.head ?? null,
          },
          /DELETION_CONTROL_INVALID/,
        );
        const badContent = await serializeDeletionJournal(
          [
            ...controls.records,
            await createRetentionControlRecord({
              action: "cancel-enrollment",
              targetId: "synthetic-absent-proposal",
              targetType: "enrollment",
            }),
            await createRetentionControlRecord({
              action: "content-control",
              targetId: "CC-synthetic-invalid",
              targetType: "content_control",
              payload: {},
            }),
          ],
          undefined,
          await checkpointSigningKey(env.CHECKPOINT_SIGNING_KEY),
        );
        await bindings.CONTROL_JOURNAL.put(
          `journal/deletion/v1/${String(controls.records.length + 2).padStart(10, "0")}.ndjson`,
          badContent,
        );
        await rejectBeforeImport(
          {
            deletionJournalNdjson: badContent,
            readCurrentJournal: async () =>
              (await fetchLatestDeletionJournal(bindings.CONTROL_JOURNAL, keys))?.head ?? null,
          },
          /DELETION_JOURNAL_VERIFICATION_FAILED/,
        );
        const payload = {
          control_id: "CC-synthetic-recovery-conflict",
          problem_id: publicProblem,
          target_kind: "claim",
          target_ref: "claim:synthetic-recovery-target",
          visibility: "hidden",
          source: "operator",
          reason_category: "integrity",
          actor: "local-recovery-fixture",
          reason: "Reject an inconsistent signed history.",
          version: 1,
          created_at: new Date().toISOString(),
          actor_kind: "operator",
        };
        const unsigned = {
          controlId: `RC-${payload.control_id}`,
          action: "content-control",
          targetId: payload.control_id,
          targetType: "content_control",
          issuedAt: payload.created_at,
          payload,
        };
        const conflictingControl = {
          ...unsigned,
          controlDigest: await computeRetentionControlDigest(unsigned),
        };
        const conflictingJournal = await serializeDeletionJournal(
          [
            ...controls.records,
            await createRetentionControlRecord({
              action: "cancel-enrollment",
              targetId: "synthetic-absent-proposal",
              targetType: "enrollment",
            }),
            conflictingControl,
            conflictingControl,
          ],
          undefined,
          await checkpointSigningKey(env.CHECKPOINT_SIGNING_KEY),
        );
        assert.ok(
          (await parseAndVerifyDeletionJournal(conflictingJournal, keys)).valid,
          "each record and the signature are valid; replay history is inconsistent",
        );
        await bindings.CONTROL_JOURNAL.put(
          `journal/deletion/v1/${String(controls.records.length + 3).padStart(10, "0")}.ndjson`,
          conflictingJournal,
        );
        await rejectBeforeImport(
          {
            deletionJournalNdjson: conflictingJournal,
            readCurrentJournal: async () =>
              (await fetchLatestDeletionJournal(bindings.CONTROL_JOURNAL, keys))?.head ?? null,
          },
          /DELETION_CONTROL_INVALID/,
        );
        const badSuspension = await serializeDeletionJournal(
          [
            ...controls.records,
            ...(await Promise.all(
              ["A", "B", "C"].map((suffix) =>
                createRetentionControlRecord({
                  action: "cancel-enrollment",
                  targetId: `synthetic-absent-proposal-${suffix}`,
                  targetType: "enrollment",
                }),
              ),
            )),
            await createRetentionControlRecord({
              action: "suspend-sponsor",
              targetId: sponsor,
              targetType: "sponsor",
              payload: {},
            }),
          ],
          undefined,
          await checkpointSigningKey(env.CHECKPOINT_SIGNING_KEY),
        );
        assert.ok((await parseAndVerifyDeletionJournal(badSuspension, keys)).valid);
        await bindings.CONTROL_JOURNAL.put(
          `journal/deletion/v1/${String(controls.records.length + 4).padStart(10, "0")}.ndjson`,
          badSuspension,
        );
        await rejectBeforeImport(
          {
            deletionJournalNdjson: badSuspension,
            readCurrentJournal: async () =>
              (await fetchLatestDeletionJournal(bindings.CONTROL_JOURNAL, keys))?.head ?? null,
          },
          /DELETION_CONTROL_INVALID/,
        );
        const recovered = await restoreDatabaseBackup(restoreOptions);
        assert.equal(recovered.status, "controls-replayed");
        assert.equal(recovered.serviceReady, false, "SQL replay never authorizes service cutover");
        assert.equal(recovered.tables, manifest.tables.length);
        assert.equal(recovered.snapshotSha256, manifest.sql_sha256);
        const remainingPrivate = await privateContents(db);
        assert.ok(
          remainingPrivate.statements === 0 &&
            remainingPrivate.workshops === 0 &&
            remainingPrivate.revisions === 0 &&
            remainingPrivate.identity === 0,
          "newer erasure removes actual statement/workshop content and private identity",
        );
        assert.equal(
          (
            await db
              .prepare(
                "SELECT count(*) AS n FROM private_workshop_search WHERE private_workshop_search MATCH 'erasedsnapshotcanary'",
              )
              .first()
          ).n,
          0,
          "erased draft content is absent from private search too",
        );
        assert.ok(
          !(await targetPolicy.restoredCredentialIsActive(
            credential.token_hash,
            credential.credential_profile,
          )),
          "restored credential is actually rejected by the real enrollment policy",
        );
        assert.ok(recovered.appliedControlsCount >= 2);
        assert.deepEqual(await findResurrectedTargets(db, controls.records), []);
        assert.deepEqual(
          await db
            .prepare("SELECT public_seq, chain_digest FROM problems WHERE id = ?")
            .bind(publicProblem)
            .first(),
          await scratchDb
            .prepare("SELECT public_seq, chain_digest FROM problems WHERE id = ?")
            .bind(publicProblem)
            .first(),
          "current private controls preserve the captured public ledger head",
        );
        await assert.rejects(
          restoreDatabaseBackup(restoreOptions),
          /DATABASE_RESTORE_IMPORT_FAILED/,
        );
        assert.deepEqual(await findResurrectedTargets(db, controls.records), []);
      } finally {
        await guarded.close();
      }
      const changing = scratchHarness(4);
      try {
        await changing.listen();
        const db = (await changing.getWorker().getEnv()).DB;
        const changingPolicy = await changing.getWorker().getExport();
        let reads = 0;
        const restoreOptions = {
          db,
          targetIdentifier: "scratch-database-controls-4",
          expectedSourceOrigin: env.STOA_ORIGIN,
          manifest,
          sql,
          verifyKeys: keys,
          deletionJournalNdjson: currentJournal.ndjson,
          revokeCredential: (control) => changingPolicy.replayRestoredCredential(control),
          readCurrentJournal: async () => {
            reads++;
            if (reads === 3) {
              await revoke(laterCredential, "usr_full_backup_late");
              await call("/v1/hello", undefined, lateFellow, 401);
              await fixtures.publishDeletionJournalTick();
            }
            return currentHead();
          },
        };
        await assert.rejects(restoreDatabaseBackup(restoreOptions), /DELETION_JOURNAL_STALE/);
        assert.ok(
          (await applicationTables(db)) > 0,
          "changed authority leaves the imported database quarantined",
        );
        assert.ok(
          await changingPolicy.restoredCredentialIsActive(
            laterCredential.token_hash,
            laterCredential.credential_profile,
          ),
          "the newly journaled credential is still live in quarantine before explicit resume",
        );
        const newest = await fetchLatestDeletionJournal(env.ARTIFACTS, keys);
        assert.ok(newest && newest.head.recordCount > currentJournal.head.recordCount);
        const replayed = await applyDeletionJournal({
          ...restoreOptions,
          deletionJournalNdjson: newest.ndjson,
          readCurrentJournal: currentHead,
        });
        assert.ok(replayed.appliedControlsCount >= 3);
        const verifiedNewest = await parseAndVerifyDeletionJournal(newest.ndjson, keys);
        assert.ok(verifiedNewest.valid);
        assert.deepEqual(await findResurrectedTargets(db, verifiedNewest.records), []);
        assert.ok(
          !(await changingPolicy.restoredCredentialIsActive(
            laterCredential.token_hash,
            laterCredential.credential_profile,
          )),
          "explicit current-journal resume rejects the newer credential too",
        );
      } finally {
        await changing.close();
      }
      const occupied = scratchHarness(5);
      try {
        await occupied.listen();
        const db = (await occupied.getWorker().getEnv()).DB;
        const occupiedPolicy = await occupied.getWorker().getExport();
        let occupiedNow = false;
        await assert.rejects(
          restoreDatabaseBackup({
            db,
            targetIdentifier: "scratch-database-controls-5",
            expectedSourceOrigin: env.STOA_ORIGIN,
            manifest,
            sql,
            verifyKeys: keys,
            deletionJournalNdjson: (await fetchLatestDeletionJournal(env.ARTIFACTS, keys)).ndjson,
            revokeCredential: (control) => occupiedPolicy.replayRestoredCredential(control),
            readCurrentJournal: async () => {
              if (!occupiedNow) {
                await db.batch([
                  db.prepare("CREATE TABLE scratch_existing_data (value TEXT)"),
                  db.prepare("INSERT INTO scratch_existing_data VALUES ('preserve-me')"),
                ]);
                occupiedNow = true;
              }
              return currentHead();
            },
          }),
          /DATABASE_RESTORE_IMPORT_FAILED/,
        );
        assert.equal(
          (await db.prepare("SELECT value FROM scratch_existing_data").first()).value,
          "preserve-me",
        );
        assert.equal(
          await applicationTables(db),
          1,
          "atomic empty-target fence imports NO snapshot tables",
        );
      } finally {
        await occupied.close();
      }
      console.log(
        JSON.stringify({
          stage: "full-database-current-controls-passed",
          status: "pass",
          tables: manifest.tables.length,
          preflight_empty_refusals: preflightRefusals,
          boundary:
            "real local SQL/current-journal replay and resume; quarantined; no CAS completeness, provider or cutover claim",
        }),
      );

      // Failure and retry use real SQL snapshots/R2, with synthetic additional
      // references only for capacity/corruption. SQL remains independently valid
      // even when a complete body companion cannot be published.
      await env.DB.prepare(
        "CREATE TABLE database_backup_cas_probe (id INTEGER PRIMARY KEY, cas_hash TEXT)",
      ).run();
      const delayed = new TextEncoder().encode("Private delayed CAS recovery.\n");
      const delayedHash = hash(delayed);
      await env.DB.prepare("INSERT INTO database_backup_cas_probe VALUES (1, ?)")
        .bind(`sha256:${delayedHash}`)
        .run();
      let caseDay = now + 10 * 24 * 60 * 60 * 1000;
      const casRefusal = async (pattern) => {
        const instant = caseDay;
        caseDay += 24 * 60 * 60 * 1000;
        await assert.rejects(async () => await fixtures.databaseBackupTick(instant), pattern);
        const key = `backups/sql/${new Date(instant).toISOString().slice(0, 10)}/complete.json`;
        const metadata = await (await env.ARTIFACTS.get(key)).json();
        const text = await (await env.ARTIFACTS.get(metadata.sql_key)).text();
        await verifyDatabaseBackup(metadata, text, keys);
        assert.equal(
          await env.ARTIFACTS.head(databaseCasManifestKey(metadata.sql_key)),
          null,
          "body failure never publishes CAS completion",
        );
        return { instant, metadata, text };
      };
      const interruptedCas = await casRefusal(/DATABASE_CAS_BODY_MISSING/);
      const laterHash = hash("Different current D1 reference after the signed snapshot.");
      await env.DB.prepare("UPDATE database_backup_cas_probe SET cas_hash = ? WHERE id = 1")
        .bind(`sha256:${laterHash}`)
        .run();
      await env.ARTIFACTS.put(`cas/sha256/${delayedHash}`, delayed, {
        onlyIf: { etagDoesNotMatch: "*" },
      });
      const partialArchiveKey = `${interruptedCas.metadata.sql_key}.cas/${hash(historicalBody)}`;
      if (!(await env.ARTIFACTS.head(partialArchiveKey))) {
        await env.ARTIFACTS.put(partialArchiveKey, historicalBody, {
          onlyIf: { etagDoesNotMatch: "*" },
        });
      }
      const partialArchiveEtag = (await env.ARTIFACTS.head(partialArchiveKey)).etag;
      assert.equal(
        (await fixtures.databaseBackupTick(interruptedCas.instant + 1)).cas_objects,
        4,
        "completed SQL retries from signed historical refs, not changed D1",
      );
      assert.equal((await env.ARTIFACTS.head(partialArchiveKey)).etag, partialArchiveEtag);
      const resumedCas = await (
        await env.ARTIFACTS.get(databaseCasManifestKey(interruptedCas.metadata.sql_key))
      ).json();
      assert.deepEqual(
        resumedCas.objects.map((object) => object.sha256),
        [...expectedHashes, delayedHash].sort(),
      );
      assert.ok(!resumedCas.objects.some((object) => object.sha256 === laterHash));
      assert.equal((await fixtures.databaseBackupTick(interruptedCas.instant + 2)).cas_objects, 4);

      const conflictingPartial = await casRefusal(/DATABASE_CAS_BODY_MISSING/);
      const conflictingArchiveKey = `${conflictingPartial.metadata.sql_key}.cas/${laterHash}`;
      const conflictingArchive = await env.ARTIFACTS.put(
        conflictingArchiveKey,
        "conflicting interrupted archive bytes",
        { onlyIf: { etagDoesNotMatch: "*" } },
      );
      assert.ok(conflictingArchive);
      await assert.rejects(
        async () => await fixtures.databaseBackupTick(conflictingPartial.instant + 1),
        /DATABASE_CAS_DIGEST_INVALID/,
      );
      assert.equal((await env.ARTIFACTS.head(conflictingArchiveKey)).etag, conflictingArchive.etag);
      assert.equal(
        await env.ARTIFACTS.head(databaseCasManifestKey(conflictingPartial.metadata.sql_key)),
        null,
      );

      const corruptHash = hash("Expected bytes missing from deliberately corrupt CAS fixture.");
      await env.DB.prepare("UPDATE database_backup_cas_probe SET cas_hash = ? WHERE id = 1")
        .bind(`sha256:${corruptHash}`)
        .run();
      await env.ARTIFACTS.put(`cas/sha256/${corruptHash}`, "wrong bytes", {
        onlyIf: { etagDoesNotMatch: "*" },
      });
      await casRefusal(/DATABASE_CAS_DIGEST_INVALID/);
      for (let index = 0; index < 8; index++) {
        await env.DB.prepare("INSERT INTO database_backup_cas_probe VALUES (?, ?)")
          .bind(index + 2, `sha256:${hash(`synthetic cap reference ${index}`)}`)
          .run();
      }
      await casRefusal(/DATABASE_CAS_OBJECT_LIMIT/);
      await env.DB.prepare("UPDATE database_backup_cas_probe SET cas_hash = NULL").run();
      const oversized = new Uint8Array(DATABASE_CAS_BACKUP_LIMITS.objectBytes + 1).fill(65);
      const oversizedHash = hash(oversized);
      await env.ARTIFACTS.put(`cas/sha256/${oversizedHash}`, oversized, {
        onlyIf: { etagDoesNotMatch: "*" },
      });
      await env.DB.prepare("UPDATE database_backup_cas_probe SET cas_hash = ? WHERE id = 1")
        .bind(`sha256:${oversizedHash}`)
        .run();
      await casRefusal(/DATABASE_CAS_SIZE_INVALID/);
      // Two individually valid17MiB bodies exceed the fixed32MiB aggregate.
      const aggregateHashes = [];
      for (const value of [66, 67]) {
        const body = new Uint8Array(17 * 1024 * 1024).fill(value);
        const bodyHash = hash(body);
        await env.ARTIFACTS.put(`cas/sha256/${bodyHash}`, body, {
          onlyIf: { etagDoesNotMatch: "*" },
        });
        aggregateHashes.push(bodyHash);
      }
      await env.DB.batch(
        aggregateHashes.map((bodyHash, index) =>
          env.DB.prepare("UPDATE database_backup_cas_probe SET cas_hash = ? WHERE id = ?").bind(
            `sha256:${bodyHash}`,
            index + 1,
          ),
        ),
      );
      await casRefusal(/DATABASE_CAS_SIZE_INVALID/);
      await env.DB.prepare(
        "UPDATE database_backup_cas_probe SET cas_hash = 'sha256:malformed' WHERE id = 1",
      ).run();
      const invalidInventory = await casRefusal(/DATABASE_CAS_INVENTORY_UNAVAILABLE/);
      assert.deepEqual(invalidInventory.metadata.cas_inventory, {
        status: "unavailable",
        reason: "invalid-reference",
      });
      await env.DB.prepare("UPDATE database_backup_cas_probe SET cas_hash = NULL").run();
      for (let offset = 0; offset < 1025; offset += 100) {
        await env.DB.batch(
          Array.from({ length: Math.min(100, 1025 - offset) }, (_, index) => {
            const id = offset + index + 1;
            return env.DB.prepare(
              "INSERT INTO database_backup_cas_probe (id, cas_hash) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET cas_hash=excluded.cas_hash",
            ).bind(id, `sha256:${id.toString(16).padStart(64, "0")}`);
          }),
        );
      }
      const inventoryLimit = await casRefusal(/DATABASE_CAS_INVENTORY_UNAVAILABLE/);
      assert.deepEqual(inventoryLimit.metadata.cas_inventory, {
        status: "unavailable",
        reason: "reference-limit",
      });
      // Restore only the lease fixture clock; retain every SQL/CAS object and
      // synthetic row. Existing original tests below still run at their clocks.
      await env.ARTIFACTS.put(
        DATABASE_BACKUP_LEASE_KEY,
        JSON.stringify({ owner: crypto.randomUUID(), expiresAt: now }),
      );
      console.log(
        JSON.stringify({
          stage: "full-database-cas-refusals-passed",
          sql_archives_retained: 8,
          boundary:
            "synthetic capacity refs with real D1/R2; no truncation or false CAS completion",
        }),
      );

      // Current implementation refuses unsupported persisted FTS options rather
      // than silently restoring default ranking/search behavior.
      await env.DB.prepare(
        "INSERT INTO public_claim_fts(public_claim_fts, rank) VALUES ('rank', 'bm25(2.0,1.0,1.0)')",
      ).run();
      const unsupportedDay = tomorrow + 24 * 60 * 60 * 1000;
      await assert.rejects(
        async () => await fixtures.databaseBackupTick(unsupportedDay, "aliased"),
        /DATABASE_BACKUP_PRIVATE_NAMESPACE_REQUIRED/,
      );
      await assert.rejects(
        async () => await fixtures.databaseBackupTick(unsupportedDay),
        /DATABASE_BACKUP_FTS_CONFIG_UNSUPPORTED/,
      );
      assert.deepEqual(
        (
          await env.ARTIFACTS.list({
            prefix: `backups/sql/${new Date(unsupportedDay).toISOString().slice(0, 10)}/`,
          })
        ).objects,
        [],
        "unsupported state publishes no SQL or completion",
      );

      // Each table fits its own bound; aggregate bytes still refuse before any
      // SQL transfer/publication. These are synthetic BLOBs, not service content.
      for (let index = 0; index < 11; index++) {
        await env.DB.batch([
          env.DB.prepare(`CREATE TABLE database_backup_big_${index} (body BLOB)`),
          env.DB.prepare(
            `INSERT INTO database_backup_big_${index} (body) VALUES (zeroblob(400000))`,
          ),
        ]);
      }
      const oversizedDay = unsupportedDay + 24 * 60 * 60 * 1000;
      await assert.rejects(
        async () => await fixtures.databaseBackupTick(oversizedDay),
        /DATABASE_BACKUP_SIZE_LIMIT/,
      );
      assert.deepEqual(
        (
          await env.ARTIFACTS.list({
            prefix: `backups/sql/${new Date(oversizedDay).toISOString().slice(0, 10)}/`,
          })
        ).objects,
        [],
      );
      await env.PUBLIC_ARTIFACTS.put(destinationKey, destinationMarker);
      await assert.rejects(
        async () => await fixtures.databaseBackupTick(now + 3),
        /DATABASE_BACKUP_PRIVATE_DESTINATION_UNVERIFIED/,
        "a marker present on the public side invalidates even an existing completion",
      );
      assert.deepEqual((await env.PUBLIC_ARTIFACTS.list({ prefix: "backups/sql/" })).objects, []);
      console.log(
        JSON.stringify({
          stage: "full-database-backup-passed",
          status: "pass",
          tables: manifest.tables.length,
          statements: verified.statements.length,
          boundary:
            "real local Workerd/D1/R2; raw scratch SQL recovery only; no provider schedule, latest-rights replay or cutover claim",
        }),
      );
    },
    {
      databaseBackupDestinationSha256: destinationSha256,
      stoaOrigin: "https://a-staging.asimposium.org",
      artifactUploadSigning: {
        accountId: "0123456789abcdef0123456789abcdef",
        bucket: "asimposium-artifacts-staging",
        accessKeyId: "0123456789ABCDEF0123456789ABCDEF",
        secretAccessKey: "c".repeat(64),
        sponsorDailyBytes: 1073741824,
        fellowDailyManifests: 100,
      },
    },
  );
} finally {
  await scratch.close();
}
