import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
