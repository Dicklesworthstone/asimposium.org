import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { D1Database } from "@cloudflare/workers-types";

const MIGRATIONS = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
let image: { digest: string; bytes: Uint8Array } | undefined;

/**
 * Fresh SQLite UNIT fixture, not D1 or migration-execution proof. Every call
 * reads the ordered migration names and bytes before reusing an empty migrated
 * image. Bun copies the image into a separate writable native connection.
 * Fixture enrollment/seeding happens afterward, never in the shared image.
 * Connection counters start at zero; migration/cutover and initial-counter
 * tests must keep executing their original migrations directly.
 */
export function migratedSqlite(
  options: { strict?: boolean; safeIntegers?: boolean; migrationsDirectory?: string } = {},
): Database {
  const directory = options.migrationsDirectory ?? MIGRATIONS;
  const sources = readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => [name, readFileSync(join(directory, name), "utf8")] as const);
  if (sources.length === 0) throw new Error("SQLite unit fixture requires migrations");
  const digest = createHash("sha256").update(JSON.stringify(sources)).digest("hex");
  if (image?.digest !== digest) {
    const source = new Database(":memory:", { strict: true });
    try {
      for (const [, sql] of sources) source.exec(sql);
      // Publish only a completely migrated image; errors never reuse stale data.
      image = { digest, bytes: source.serialize() };
    } finally {
      source.close();
    }
  }
  const database = Database.deserialize(image.bytes, {
    strict: options.strict ?? false,
    safeIntegers: options.safeIntegers ?? false,
  });
  try {
    // Connection-local settings are not part of sqlite3_serialize's image.
    database.exec("PRAGMA foreign_keys = ON");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

/** SQLite-backed D1 method adapter for route unit fixtures that previously
 * needed no database. Executes the real migrations and SQL, including atomic
 * RETURNING reads; this is not a substitute for the native Workerd/D1 lane. */
export function migratedSqliteD1() {
  const sqlite = migratedSqlite({ strict: true });
  let tail: Promise<unknown> = Promise.resolve();
  const prepare = (query: string) => {
    const methods = (values: unknown[]) => ({
      async first<T>(column?: string): Promise<T | null> {
        const row = sqlite.prepare(query).get(...(values as any[])) as Record<
          string,
          unknown
        > | null;
        return (column === undefined ? (row ?? null) : (row?.[column] ?? null)) as T | null;
      },
      async all() {
        const results = sqlite.prepare(query).all(...(values as any[]));
        return {
          success: true,
          results,
          meta: { changes: 0, rows_read: results.length, rows_written: 0 },
        };
      },
      async run() {
        const statement = sqlite.prepare(query);
        if (statement.columnNames.length > 0) {
          const results = statement.all(...(values as any[]));
          return {
            success: true,
            results,
            meta: { changes: 0, rows_read: results.length, rows_written: 0 },
          };
        }
        const result = statement.run(...(values as any[]));
        return {
          success: true,
          results: [],
          meta: { changes: result.changes, rows_read: 0, rows_written: result.changes },
        };
      },
    });
    return { ...methods([]), bind: (...values: unknown[]) => methods(values) };
  };
  const db = {
    prepare,
    batch(statements: readonly { run(): Promise<unknown> }[]) {
      const result = tail.then(async () => {
        sqlite.exec("BEGIN");
        try {
          const results = [];
          for (const statement of statements) results.push(await statement.run());
          sqlite.exec("COMMIT");
          return results;
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
      });
      tail = result.catch(() => undefined);
      return result;
    },
    async exec(sql: string) {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
  } as unknown as D1Database;
  return { db, sqlite };
}
