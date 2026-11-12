/** Complete, bounded SQL snapshots on D1, including FTS5. Provider SQL export
 * rejects virtual tables. Read the application schema and losslessly formatted
 * rows in one D1 transaction instead; recreate FTS from its logical contents,
 * never copy engine shadow tables. These private archives are not public ledger
 * exports and do not authorize recovery/cutover without current deletion controls.
 */
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import type { Env } from "../env.ts";
import {
  type CheckpointVerifyKey,
  checkpointSigningKey,
  checkpointVerifyKeys,
} from "./checkpoint-signing.ts";
import { canonicalJson, sha256Hex } from "./krater.ts";

export const DATABASE_BACKUP_LIMITS = {
  tables: 256,
  rowsPerTable: 2000,
  tableBytes: 1024 * 1024,
  bytes: 8 * 1024 * 1024,
  statements: 16000,
} as const;
const schemaQuery = `SELECT type, name, tbl_name, sql FROM sqlite_schema
  WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'
  ORDER BY type, name LIMIT 2001`;
type SchemaRow = { type: string; name: string; tbl_name: string; sql: string };
type Column = { name: string; hidden: number; pk: number };
type Table = { name: string; type: string; wr: number; schema: string };
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const MetadataSchema = z
  .object({
    format: z.literal("asimposium.database-backup.v1"),
    source: z.object({ binding: z.literal("DB"), origin: z.url() }).strict(),
    created_at: z.iso.datetime(),
    sql_key: z.string().regex(/^backups\/sql\/\d{4}-\d{2}-\d{2}\/[a-f0-9-]{36}\.sql$/),
    sql_sha256: digest,
    schema_sha256: digest,
    bytes: count.max(DATABASE_BACKUP_LIMITS.bytes),
    statement_bytes: z.array(count.positive()).max(DATABASE_BACKUP_LIMITS.statements),
    tables: z
      .array(z.object({ name: z.string().min(1).max(200), rows: count }).strict())
      .max(DATABASE_BACKUP_LIMITS.tables),
    rebuilt_fts: z.array(z.string().min(1).max(200)).max(DATABASE_BACKUP_LIMITS.tables),
    key_id: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  })
  .strict();
const ManifestSchema = MetadataSchema.extend({ signature: z.string().regex(/^[a-f0-9]{128}$/) });
type Metadata = z.infer<typeof MetadataSchema>;
const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const utf8 = new TextEncoder();
const bytes = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (s) => Number.parseInt(s, 16));
const hex = (value: ArrayBuffer) =>
  Array.from(new Uint8Array(value), (b) => b.toString(16).padStart(2, "0")).join("");
const message = (metadata: Metadata) => utf8.encode(canonicalJson(metadata));

/** SQLite formats the values, so int64, BLOBs, NULs and multiline text never
 * round-trip through JavaScript numbers or quote-sensitive SQL strings. */
function cell(column: string): string {
  const c = identifier(column);
  return `CASE typeof(${c}) WHEN 'null' THEN 'NULL'
    WHEN 'text' THEN 'CAST(X''' || hex(CAST(${c} AS BLOB)) || ''' AS TEXT)'
    WHEN 'blob' THEN 'X''' || hex(${c}) || ''''
    WHEN 'integer' THEN quote(${c})
    WHEN 'real' THEN CASE WHEN ${c} > 1.7976931348623157e308 THEN '9e999'
      WHEN ${c} < -1.7976931348623157e308 THEN '-9e999' ELSE printf('%!.17g', ${c}) END END`;
}

function rowsQuery(table: Table, columns: Column[], budget: number | null): string {
  const names = columns.filter((c) => c.hidden === 0).map((c) => c.name);
  const rowid = ["rowid", "_rowid_", "oid"].find(
    (name) => !names.some((column) => column.toLowerCase() === name),
  );
  if (!table.wr) {
    if (!rowid) throw new Error("DATABASE_BACKUP_ROWID_UNAVAILABLE");
    names.unshift(rowid);
  }
  const order = table.wr
    ? columns
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => identifier(c.name))
        .join(",")
    : identifier(rowid ?? "rowid");
  const start = `INSERT INTO ${identifier(table.name)} (${names.map(identifier).join(",")}) VALUES(`;
  const expression = `${literal(start)} || ${names.map(cell).join(" || ',' || ")} || ');'`;
  // Materialize the bounded rows once. Oversized tables return counts, never
  // their bodies. The caller refuses the whole snapshot rather than truncating.
  return `WITH rows(line) AS MATERIALIZED (SELECT ${expression} FROM ${identifier(table.name)}
    ORDER BY ${order} LIMIT ${DATABASE_BACKUP_LIMITS.rowsPerTable + 1}),
    stats AS (SELECT count(*) AS n,
      coalesce(sum(length(CAST(line AS BLOB))) + count(*), 0) AS size FROM rows)
    SELECT n, size, CASE WHEN n <= ${DATABASE_BACKUP_LIMITS.rowsPerTable}
      AND ${budget === null ? "0" : "1"} = 1 AND size <= ${budget ?? 0}
      THEN (SELECT json_group_array(line) FROM rows) END AS lines FROM stats`;
}

export async function captureDatabaseSql(db: D1Database) {
  const rawSchema = (await db.prepare(schemaQuery).all<SchemaRow>()).results;
  const roster = (await db.prepare("PRAGMA table_list").all<Table>()).results;
  const tables = roster
    .filter(
      (t) =>
        t.schema === "main" &&
        ["table", "virtual"].includes(t.type) &&
        (t.name === "sqlite_sequence" || !t.name.startsWith("sqlite_")) &&
        !t.name.startsWith("_cf_"),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  const shadowNames = new Set(roster.filter((t) => t.type === "shadow").map((t) => t.name));
  const schema = rawSchema.filter((s) => !shadowNames.has(s.name) && !shadowNames.has(s.tbl_name));
  if (tables.length === 0) throw new Error("DATABASE_BACKUP_SCHEMA_EMPTY");
  if (tables.length > DATABASE_BACKUP_LIMITS.tables || schema.length > 2000)
    throw new Error("DATABASE_BACKUP_SCHEMA_LIMIT");
  const definitions = new Map(schema.filter((s) => s.type === "table").map((s) => [s.name, s.sql]));
  if (tables.filter((t) => t.name !== "sqlite_sequence").length !== definitions.size)
    throw new Error("DATABASE_BACKUP_SCHEMA_CHANGED");
  const columnResults = await db.batch(
    tables.map((t) => db.prepare(`PRAGMA table_xinfo(${identifier(t.name)})`)),
  );
  const rebuilt: string[] = [];
  const virtual: string[] = [];
  const data: { table: Table; external: boolean; columns: Column[] }[] = [];
  for (const [index, table] of tables.entries()) {
    const sql = definitions.get(table.name);
    if (!sql && table.name !== "sqlite_sequence") throw new Error("DATABASE_BACKUP_SCHEMA_CHANGED");
    if (table.type === "virtual") {
      if (!sql || !/\bUSING\s+fts5\s*\(/i.test(sql))
        throw new Error("DATABASE_BACKUP_VIRTUAL_TABLE_UNSUPPORTED");
      virtual.push(table.name);
      if (/\bcontent\s*=/i.test(sql)) {
        if (/\bcontent\s*=\s*(['"])\1/i.test(sql))
          throw new Error("DATABASE_BACKUP_CONTENTLESS_FTS_UNSUPPORTED");
        rebuilt.push(table.name);
        data.push({ table, external: true, columns: [] });
        continue;
      }
    }
    const columns = columnResults[index]?.results as Column[] | undefined;
    if (!columns?.length) throw new Error("DATABASE_BACKUP_SCHEMA_CHANGED");
    data.push({ table, external: false, columns });
  }
  // Measure without transferring bodies, then share remaining space as slack
  // for ordinary concurrent writes. The actual read still refuses growth
  // beyond each allocation; every allocation shares one aggregate budget.
  // Thus 256 individually bounded tables cannot amplify an 8 MiB Worker read
  // into 256 MiB before the aggregate bound is checked.
  const measured = await db.batch(
    data.map(({ table, external, columns }) =>
      db.prepare(
        external
          ? `SELECT count(*) AS n, 0 AS size FROM (SELECT 1 FROM ${identifier(table.name)} LIMIT ${DATABASE_BACKUP_LIMITS.rowsPerTable + 1})`
          : rowsQuery(table, columns, null),
      ),
    ),
  );
  let total = utf8.encode(schema.map((s) => s.sql).join("\n")).byteLength;
  const budgets = measured.map((result) => {
    const row = result.results[0] as { n: number; size: number } | undefined;
    if (
      !row ||
      !Number.isSafeInteger(row.size) ||
      row.size < 0 ||
      row.n > DATABASE_BACKUP_LIMITS.rowsPerTable ||
      row.size > DATABASE_BACKUP_LIMITS.tableBytes
    )
      throw new Error("DATABASE_BACKUP_TABLE_LIMIT");
    total += row.size;
    return row.size;
  });
  if (total > DATABASE_BACKUP_LIMITS.bytes) throw new Error("DATABASE_BACKUP_SIZE_LIMIT");
  const slack = Math.floor((DATABASE_BACKUP_LIMITS.bytes - total) / data.length);
  const allocations = budgets.map((size) =>
    Math.min(DATABASE_BACKUP_LIMITS.tableBytes, size + slack),
  );
  const queries = [
    db.prepare(schemaQuery),
    db.prepare("PRAGMA table_list"),
    ...data.map(({ table, external, columns }, index) =>
      db.prepare(
        external
          ? `SELECT count(*) AS n FROM (SELECT 1 FROM ${identifier(table.name)} LIMIT ${DATABASE_BACKUP_LIMITS.rowsPerTable + 1})`
          : rowsQuery(table, columns, allocations[index] ?? 0),
      ),
    ),
    ...virtual.map((name) =>
      db.prepare(`SELECT count(*) AS n FROM ${identifier(`${name}_config`)} WHERE k <> 'version'`),
    ),
  ];
  // D1 batch is a single transaction. All data and the schema/roster fence
  // share this snapshot, even while ordinary ledger writes continue.
  const result = await db.batch(queries);
  if (
    canonicalJson(result[0]?.results) !== canonicalJson(rawSchema) ||
    canonicalJson(result[1]?.results) !== canonicalJson(roster)
  )
    throw new Error("DATABASE_BACKUP_SCHEMA_CHANGED");
  for (let index = 0; index < virtual.length; index++) {
    if ((result[data.length + 2 + index]?.results[0] as { n: number } | undefined)?.n !== 0)
      throw new Error("DATABASE_BACKUP_FTS_CONFIG_UNSUPPORTED");
  }
  const statements = schema.filter((s) => s.type === "table").map((s) => `${s.sql};`);
  const sequenceStatements: string[] = [];
  const counts: { name: string; rows: number }[] = [];
  for (const [index, { table, external }] of data.entries()) {
    const row = result[index + 2]?.results[0] as
      | { n: number; size: number; lines: string | null }
      | undefined;
    if (external) {
      if (!row || !Number.isSafeInteger(row.n) || row.n > DATABASE_BACKUP_LIMITS.rowsPerTable)
        throw new Error("DATABASE_BACKUP_TABLE_LIMIT");
      counts.push({ name: table.name, rows: row.n });
      continue;
    }
    if (
      !row ||
      row.lines === null ||
      row.n > DATABASE_BACKUP_LIMITS.rowsPerTable ||
      row.size > DATABASE_BACKUP_LIMITS.tableBytes
    )
      throw new Error("DATABASE_BACKUP_TABLE_LIMIT");
    const lines = z.array(z.string()).parse(JSON.parse(row.lines));
    if (lines.length !== row.n) throw new Error("DATABASE_BACKUP_ROWS_INCOMPLETE");
    if (table.name === "sqlite_sequence") {
      // AUTOINCREMENT table creation creates sqlite_sequence. Retain values
      // above current MAX(id), including sequences of emptied tables.
      sequenceStatements.push('DELETE FROM "sqlite_sequence";', ...lines);
    } else {
      statements.push(...lines);
    }
    counts.push({ name: table.name, rows: row.n });
  }
  // Restore sequence state after ALL ordinary inserts, including tables that
  // sort after sqlite_sequence. A valid source can carry seq below MAX(id).
  statements.push(...sequenceStatements);
  for (const name of rebuilt) {
    statements.push(`INSERT INTO ${identifier(name)} (${identifier(name)}) VALUES ('rebuild');`);
  }
  // Data precedes triggers and indexes: importing a snapshot never replays
  // admission triggers or duplicates the FTS maintenance writes.
  statements.push(...schema.filter((s) => s.type !== "table").map((s) => `${s.sql};`));
  const sql = `${statements.join("\n")}\n`;
  if (
    utf8.encode(sql).byteLength > DATABASE_BACKUP_LIMITS.bytes ||
    statements.length > DATABASE_BACKUP_LIMITS.statements
  )
    throw new Error("DATABASE_BACKUP_SIZE_LIMIT");
  return {
    sql,
    statementBytes: statements.map((s) => utf8.encode(`${s}\n`).byteLength),
    tables: counts,
    rebuiltFts: rebuilt,
    schemaSha256: await sha256Hex(canonicalJson(schema)),
  };
}

/** Verify before exposing executable SQL. Keys come from an independent trust
 * channel; an archive cannot nominate its own verification key. Returned SQL
 * is still only for an empty, quarantined scratch DB under current controls. */
async function verifyManifest(input: unknown, trustedKeys: readonly CheckpointVerifyKey[]) {
  const { signature, ...metadata } = ManifestSchema.parse(input);
  const key = trustedKeys.find((k) => k.kid === metadata.key_id);
  if (!key || !/^[a-f0-9]{64}$/.test(key.publicKeyHex))
    throw new Error("DATABASE_BACKUP_UNTRUSTED_KEY");
  const publicKey = await crypto.subtle.importKey(
    "raw",
    bytes(key.publicKeyHex),
    "Ed25519",
    false,
    ["verify"],
  );
  if (!(await crypto.subtle.verify("Ed25519", publicKey, bytes(signature), message(metadata))))
    throw new Error("DATABASE_BACKUP_SIGNATURE_INVALID");
  return metadata;
}

export async function verifyDatabaseBackup(
  input: unknown,
  sql: string,
  trustedKeys: readonly CheckpointVerifyKey[],
) {
  const metadata = await verifyManifest(input, trustedKeys);
  if (sql.length > metadata.bytes) throw new Error("DATABASE_BACKUP_DIGEST_INVALID");
  const encoded = utf8.encode(sql);
  if (encoded.byteLength !== metadata.bytes || (await sha256Hex(sql)) !== metadata.sql_sha256)
    throw new Error("DATABASE_BACKUP_DIGEST_INVALID");
  const statements: string[] = [];
  let offset = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const length of metadata.statement_bytes) {
    if (offset + length > encoded.byteLength || encoded[offset + length - 1] !== 10)
      throw new Error("DATABASE_BACKUP_STATEMENTS_INVALID");
    statements.push(decoder.decode(encoded.subarray(offset, offset + length - 1)));
    offset += length;
  }
  if (offset !== encoded.byteLength) throw new Error("DATABASE_BACKUP_STATEMENTS_INVALID");
  return { metadata, statements };
}

type BackupEnv = Pick<
  Env,
  | "DB"
  | "ARTIFACTS"
  | "PUBLIC_ARTIFACTS"
  | "STOA_ORIGIN"
  | "CHECKPOINT_SIGNING_KEY"
  | "CHECKPOINT_VERIFY_KEYS"
>;
export const DATABASE_BACKUP_LEASE_KEY = "backups/control/database-v1.json";
const LeaseSchema = z.object({ owner: z.uuid(), expiresAt: count }).strict();

/** The existing five-minute cron creates at most one complete SQL snapshot
 * per UTC day. Incomplete objects never become completion witnesses. */
export async function runDatabaseBackup(env: BackupEnv, now = Date.now()) {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isFinite(new Date(now).getTime()))
    throw new Error("DATABASE_BACKUP_CLOCK_INVALID");
  const signing = await checkpointSigningKey(env.CHECKPOINT_SIGNING_KEY);
  const keys = checkpointVerifyKeys(env.CHECKPOINT_VERIFY_KEYS);
  if (env.CHECKPOINT_SIGNING_KEY === undefined || env.CHECKPOINT_VERIFY_KEYS === undefined)
    return { enabled: false, status: "disabled" as const };
  let configuredKeys: unknown;
  try {
    configuredKeys = JSON.parse(env.CHECKPOINT_VERIFY_KEYS);
  } catch {
    throw new Error("DATABASE_BACKUP_KEYS_INVALID");
  }
  const pins = z
    .array(
      z.object({ kid: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/), publicKeyHex: digest }).strict(),
    )
    .min(1)
    .max(16)
    .safeParse(configuredKeys);
  if (!pins.success || new Set(pins.data.map((key) => key.kid)).size !== pins.data.length)
    throw new Error("DATABASE_BACKUP_KEYS_INVALID");
  if (
    !signing ||
    !keys.some((k) => k.kid === signing.kid && k.publicKeyHex === signing.publicKeyHex)
  )
    throw new Error("DATABASE_BACKUP_KEYS_INVALID");
  if (env.ARTIFACTS === env.PUBLIC_ARTIFACTS)
    throw new Error("DATABASE_BACKUP_PRIVATE_NAMESPACE_REQUIRED");
  const origin = z.url().parse(env.STOA_ORIGIN);
  const date = new Date(now).toISOString().slice(0, 10);
  const manifestKey = `backups/sql/${date}/complete.json`;
  const existing = await env.ARTIFACTS.get(manifestKey);
  if (existing) {
    if (existing.size > 256 * 1024) throw new Error("DATABASE_BACKUP_MANIFEST_INVALID");
    const manifest = await verifyManifest(await existing.json(), keys);
    const stored = await env.ARTIFACTS.head(manifest.sql_key);
    if (
      !stored ||
      stored.size !== manifest.bytes ||
      !stored.checksums.sha256 ||
      hex(stored.checksums.sha256) !== manifest.sql_sha256
    )
      throw new Error("DATABASE_BACKUP_SQL_MISSING");
    if (
      manifest.source.origin !== origin ||
      !manifest.created_at.startsWith(date) ||
      !manifest.sql_key.startsWith(`backups/sql/${date}/`)
    )
      throw new Error("DATABASE_BACKUP_SOURCE_MISMATCH");
    return {
      enabled: true,
      status: "complete" as const,
      bytes: manifest.bytes,
      tables: manifest.tables.length,
    };
  }
  const leaseObject = await env.ARTIFACTS.get(DATABASE_BACKUP_LEASE_KEY);
  if (leaseObject && leaseObject.size > 512) throw new Error("DATABASE_BACKUP_LEASE_INVALID");
  if (leaseObject && LeaseSchema.parse(await leaseObject.json()).expiresAt > now)
    return { enabled: true, status: "busy" as const };
  const owner = crypto.randomUUID();
  const leased = await env.ARTIFACTS.put(
    DATABASE_BACKUP_LEASE_KEY,
    JSON.stringify({ owner, expiresAt: now + 10 * 60 * 1000 }),
    {
      onlyIf: leaseObject ? { etagMatches: leaseObject.etag } : { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
    },
  );
  if (!leased) return { enabled: true, status: "busy" as const };
  const snapshot = await captureDatabaseSql(env.DB);
  const sqlKey = `backups/sql/${date}/${owner}.sql`;
  const metadata = MetadataSchema.parse({
    format: "asimposium.database-backup.v1",
    source: { binding: "DB", origin },
    created_at: new Date(now).toISOString(),
    sql_key: sqlKey,
    sql_sha256: await sha256Hex(snapshot.sql),
    schema_sha256: snapshot.schemaSha256,
    bytes: utf8.encode(snapshot.sql).byteLength,
    statement_bytes: snapshot.statementBytes,
    tables: snapshot.tables,
    rebuilt_fts: snapshot.rebuiltFts,
    key_id: signing.kid,
  });
  const signature = hex(await crypto.subtle.sign("Ed25519", signing.privateKey, message(metadata)));
  const manifest = { ...metadata, signature };
  const stored = await env.ARTIFACTS.put(sqlKey, snapshot.sql, {
    sha256: metadata.sql_sha256,
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/sql", cacheControl: "no-store" },
  });
  if (!stored) throw new Error("DATABASE_BACKUP_DESTINATION_EXISTS");
  const readback = await env.ARTIFACTS.get(sqlKey);
  if (!readback || readback.size > DATABASE_BACKUP_LIMITS.bytes)
    throw new Error("DATABASE_BACKUP_SQL_MISSING");
  await verifyDatabaseBackup(manifest, await readback.text(), keys);
  const currentLease = await env.ARTIFACTS.get(DATABASE_BACKUP_LEASE_KEY);
  if (
    !currentLease ||
    currentLease.size > 512 ||
    LeaseSchema.parse(await currentLease.json()).owner !== owner
  )
    throw new Error("DATABASE_BACKUP_LEASE_LOST");
  const complete = await env.ARTIFACTS.put(manifestKey, JSON.stringify(manifest), {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
  });
  if (!complete) throw new Error("DATABASE_BACKUP_DESTINATION_EXISTS");
  return {
    enabled: true,
    status: "written" as const,
    bytes: metadata.bytes,
    tables: metadata.tables.length,
  };
}
