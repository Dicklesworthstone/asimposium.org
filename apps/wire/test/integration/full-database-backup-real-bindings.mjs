import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import {
  captureDatabaseSql,
  DATABASE_BACKUP_LEASE_KEY,
  verifyDatabaseBackup,
} from "../../src/krater/database-backup.ts";
import { validateScratchTarget } from "../../src/krater/restore.ts";
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
        rules: [{ type: "Text", globs: ["**/*.md", "**/*.txt"], fallthrough: true }],
      },
    },
  ],
});

try {
  await scratch.listen();
  const scratchDb = (await scratch.getWorker().getEnv()).DB;
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

  await runLocalWorkerJourney(async ({ call, enroll, sponsorCall, fixtures, env, worker }) => {
    const sponsor = "usr_full_database_backup";
    const author = await enroll("full-backup-author", sponsor);
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
    assert.deepEqual((await env.ARTIFACTS.list({ prefix: "backups/sql/" })).objects, []);
    assert.equal(
      (await worker.scheduled({ cron: "*/5 * * * *" })).outcome,
      "ok",
      "production scheduled entrypoint creates the first SQL backup",
    );
    const completed = (await env.ARTIFACTS.list({ prefix: "backups/sql/" })).objects.filter(
      (object) => object.key.endsWith("/complete.json"),
    );
    assert.equal(completed.length, 1, "cron must publish exactly one completion from absent state");
    const manifestKey = completed[0].key;
    const manifest = await (await env.ARTIFACTS.get(manifestKey)).json();
    const now = Date.parse(manifest.created_at);
    assert.equal((await fixtures.databaseBackupTick(now + 1)).status, "complete");
    const sql = await (await env.ARTIFACTS.get(manifest.sql_key)).text();
    const keys = [{ kid: CHECKPOINT_KEY_ID, publicKeyHex: CHECKPOINT_PUBLIC_KEY_HEX }];
    const verified = await verifyDatabaseBackup(manifest, sql, keys);
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
    await assert.rejects(verifyDatabaseBackup(manifest, sql, []), /DATABASE_BACKUP_UNTRUSTED_KEY/);
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

    // Current implementation refuses unsupported persisted FTS options rather
    // than silently restoring default ranking/search behavior.
    await env.DB.prepare(
      "INSERT INTO public_claim_fts(public_claim_fts, rank) VALUES ('rank', 'bm25(2.0,1.0,1.0)')",
    ).run();
    const unsupportedDay = tomorrow + 24 * 60 * 60 * 1000;
    await assert.rejects(
      async () => await fixtures.databaseBackupTick(unsupportedDay, true),
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
        env.DB.prepare(`INSERT INTO database_backup_big_${index} (body) VALUES (zeroblob(400000))`),
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
  });
} finally {
  await scratch.close();
}
