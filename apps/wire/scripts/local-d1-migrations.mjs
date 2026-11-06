/**
 * Local fixture adapter: native Wrangler owns the journal schema; one persistent
 * real D1 binding applies each checked-in file and its journal row atomically.
 * Callers create a fresh native journal first, inside their existing deadline.
 * A file entrypoint needs no --input-type flag that could break Miniflare's
 * CommonJS eval worker. This is not execution of native `migrations apply`.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import wrangler from "wrangler";

assert.equal(process.versions.bun, undefined, "D1 fixture migration requires genuine Node");
const [configPath, state, envFile, expectedRecord, rollback] = process.argv.slice(2);
assert.equal(process.argv.length, 7, "D1 fixture migration requires five arguments");
assert.ok(configPath && state && envFile);
assert.ok(rollback === "0" || rollback === "1");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const directory = join(root, "db/migrations");
const discovered = readdirSync(directory)
  .filter((name) => name.endsWith(".sql"))
  .sort();
// Token's existing journal pin stays authoritative. S1 previously applied the
// directory's complete current inventory and continues to do so.
const expected = expectedRecord ? expectedRecord.split(" ") : discovered;
assert.ok(expected.length > 0 && expected.every((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)));
assert.deepEqual(discovered, expected);
const { unstable_getMiniflareWorkerOptions, unstable_splitSqlQuery } = wrangler;
assert.equal(typeof unstable_getMiniflareWorkerOptions, "function");
assert.equal(typeof unstable_splitSqlQuery, "function");
// Use the exact Miniflare shipped with the already-pinned local Wrangler.
const localRequire = createRequire(import.meta.resolve("wrangler"));
const { Miniflare, convertV4MiniflareOptions } = localRequire("miniflare");
const { workerOptions } = unstable_getMiniflareWorkerOptions(configPath, undefined, {
  envFiles: [envFile],
});
assert.ok(workerOptions.d1Databases?.DB);
// Preparing through a Node proxy makes every synchronous prepare/bind another
// Worker RPC. Build the statements inside the real Worker instead; each file
// still has exactly its own D1 batch, including its native journal insert.
const runtime = new Miniflare(
  convertV4MiniflareOptions({
    compatibilityDate: workerOptions.compatibilityDate,
    compatibilityFlags: workerOptions.compatibilityFlags,
    d1Databases: { DB: workerOptions.d1Databases.DB },
    modules: true,
    resourcePersistencePath: join(state, "v3"),
    script: `export default {
      async fetch(request, env) {
        const { statements, name, planted } = await request.json();
        const batch = statements.map((sql) => env.DB.prepare(sql));
        batch.push(env.DB.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(name));
        if (planted) {
          batch.push(
            env.DB.prepare("CREATE TABLE token_lifecycle_migration_atomic_probe (value INTEGER CONSTRAINT TOKEN_LIFECYCLE_PLANTED_MIGRATION_FAILURE CHECK (value > 0))"),
            env.DB.prepare("INSERT INTO token_lifecycle_migration_atomic_probe (value) VALUES (0)")
          );
        }
        try {
          return Response.json({ results: await env.DB.batch(batch) });
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 });
        }
      }
    };`,
  }),
);
let db;
const catalog = async () =>
  (await db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all())
    .results;
const journal = async () =>
  (await db.prepare("SELECT id,name FROM d1_migrations ORDER BY id").all()).results;
try {
  db = await runtime.getD1Database("DB");
  assert.deepEqual(
    await journal(),
    [],
    "the local fixture must start with an empty native journal",
  );
  for (const [index, name] of expected.entries()) {
    const sql = readFileSync(join(directory, name), "utf8");
    const planted = rollback === "1" && index === 1;
    const beforeCatalog = planted ? await catalog() : undefined;
    const beforeJournal = planted ? await journal() : undefined;
    try {
      const response = await runtime.dispatchFetch("http://migration.internal/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent":
            "asimposium.org-agent (+https://github.com/Dicklesworthstone/asimposium.org)",
        },
        body: JSON.stringify({ statements: unstable_splitSqlQuery(sql), name, planted }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      assert.ok(result.results.every((entry) => entry.success));
      assert.equal(planted, false, "the real runtime CHECK fault must refuse its batch");
    } catch (error) {
      if (!planted) throw error;
      assert.match(String(error), /TOKEN_LIFECYCLE_PLANTED_MIGRATION_FAILURE/);
      assert.deepEqual(await catalog(), beforeCatalog);
      assert.deepEqual(await journal(), beforeJournal);
      assert.deepEqual(
        beforeJournal.map((entry) => entry.name),
        expected.slice(0, 1),
      );
      console.log(
        JSON.stringify({
          assertion: "migration_body_and_journal_rollback_preserve_prior_file",
          status: "pass",
        }),
      );
      process.exitCode = 1;
      break;
    }
    console.log(
      JSON.stringify({
        record: "real_d1_migration_applied",
        name,
        sha256: createHash("sha256").update(sql).digest("hex"),
      }),
    );
  }
} finally {
  // Native CLI reads may resume only after disposal releases this exact state.
  await runtime.dispose();
}
