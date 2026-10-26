import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

/** Read-only scientific fixtures use the real empty table definitions. They
 * intentionally supply no declaration, so the canonical fold must report
 * missing sponsor coverage. Enrollment, writes and guards are exercised by
 * the separate all-migrations directive-disclosure fixture. */
export function installEmptyDirectiveDisclosureTables(db: Database): void {
  const migration = readFileSync(
    new URL("../../../../db/migrations/0111_directive_disclosures.sql", import.meta.url),
    "utf8",
  );
  for (const name of ["directive_disclosure_records", "directive_disclosure_targets"]) {
    const statement = migration.match(new RegExp(`CREATE TABLE ${name} \\([\\s\\S]*?\\n\\);`))?.[0];
    if (!statement) throw new Error(`Missing declaration table definition: ${name}`);
    db.exec(statement);
  }
}
