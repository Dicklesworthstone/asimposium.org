import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

/** Install the actual source-pair read schema in minimal SQL-reader fixtures.
 * These fixtures do not own citation writes or their projection dependencies. */
export function installCitationReuseReadSchema(db: Database): void {
  const migration = readFileSync(
    new URL("../../../../db/migrations/0153_citation_reuse_source_pins.sql", import.meta.url),
    "utf8",
  );
  const producer = migration.indexOf("DROP TRIGGER citation_reused_impact_echo_after_insert;");
  if (producer < 0) throw new Error("CITATION_REUSE_MIGRATION_BOUNDARY_MISSING");
  db.exec(migration.slice(0, producer));
}
