import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// This small lane proves actual D1 binding ceilings and commit guards without
// starting the complete application. It uses the pinned Wrangler dependencies;
// no JavaScript database mock or synthesized migration is substituted.
assert.equal(process.versions.bun, undefined, "This lane requires genuine Node");
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const require = createRequire(new URL("../../package.json", import.meta.url));
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { build } = wranglerRequire("esbuild");
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");

/**
 * Split a migration file into complete statements. A bare ";" split is wrong
 * for this corpus: trigger bodies contain semicolons, including nested
 * `CASE ... END;` inside `BEGIN ... END;` and single-line triggers. This is
 * the sqlite3_complete() rule specialized to these files: quoted strings and
 * comments never terminate; elsewhere a ";" ends a statement unless an open
 * CREATE TRIGGER body has not reached its closing END (CASE nests inside the
 * body and consumes its own ENDs).
 */
function splitSqlStatements(sql) {
  const statements = [];
  let statement = "";
  let token = "";
  let priorToken = "";
  let caseDepth = 0;
  let inTrigger = false;
  let triggerBodyClosed = false;
  let index = 0;

  const finishToken = () => {
    if (token.length === 0) return;
    const upper = token.toUpperCase();
    if (priorToken === "CREATE" && upper === "TRIGGER") inTrigger = true;
    else if (upper === "CASE") caseDepth += 1;
    else if (upper === "END" && inTrigger) {
      if (caseDepth > 0) caseDepth -= 1;
      else triggerBodyClosed = true;
    }
    priorToken = upper;
    token = "";
  };

  while (index < sql.length) {
    const ch = sql[index];
    if (/[A-Za-z0-9_]/.test(ch)) {
      token += ch;
      statement += ch;
      index += 1;
      continue;
    }
    finishToken();
    if (ch === "'" || ch === '"') {
      const quote = ch;
      statement += ch;
      index += 1;
      while (index < sql.length) {
        const inner = sql[index];
        statement += inner;
        if (inner === quote) {
          if (sql[index + 1] === quote) {
            statement += sql[index + 1];
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (ch === "-" && sql[index + 1] === "-") {
      while (index < sql.length && sql[index] !== "\n") index += 1;
      continue;
    }
    if (ch === "/" && sql[index + 1] === "*") {
      index += 2;
      while (index < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) index += 1;
      index += 2;
      continue;
    }
    if (ch === ";" && (!inTrigger || triggerBodyClosed)) {
      const trimmed = statement.trim();
      if (trimmed.length > 0) statements.push(trimmed);
      statement = "";
      inTrigger = false;
      triggerBodyClosed = false;
      caseDepth = 0;
      priorToken = "";
      index += 1;
      continue;
    }
    statement += ch;
    index += 1;
  }
  finishToken();
  const rest = statement.trim();
  if (rest.length > 0) statements.push(rest);
  return statements;
}

const bundle = await build({
  absWorkingDir: root,
  entryPoints: ["apps/wire/test/integration/publication-context-local-worker.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
  external: ["cloudflare:*", "node:*"],
});
assert.equal(bundle.outputFiles.length, 1);
const miniflare = new Miniflare(
  convertV4MiniflareOptions({
    workers: [
      {
        name: "asimposium-publication-context-proof",
        modules: true,
        script: bundle.outputFiles[0].text,
        compatibilityDate: "2026-08-13",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: { DB: "context-boundary" },
      },
    ],
  }),
);
try {
  await miniflare.ready;
  console.log(JSON.stringify({ stage: "context-workerd-started" }));
  const db = await miniflare.getD1Database("DB");
  const directory = new URL("../../../../db/migrations/", import.meta.url);
  const migrations = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of migrations) {
    const queries = splitSqlStatements(await readFile(new URL(name, directory), "utf8"));
    assert.ok(queries.length > 0, `${name} has no complete SQL statements`);
    await db.batch(queries.map((query) => db.prepare(query)));
  }
  console.log(JSON.stringify({ stage: "context-d1-migrated", migrations: migrations.length }));
  const response = await miniflare.dispatchFetch("http://localhost/prove", { method: "POST" });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  const report = JSON.parse(body);
  assert.equal(report.status, "pass");
  assert.equal(report.private_case_bytes, 1048576);
  assert.equal(report.source_bytes, 524288);
  assert.ok(report.provider_input_bytes > 1048320);
  assert.equal(report.model_calls_for_boundary_case, 1);
  assert.equal(report.one_byte_over_refused, true);
  assert.equal(report.stale_transaction_aborted, true);
  console.log(JSON.stringify(report));
} finally {
  await miniflare.dispose();
}
