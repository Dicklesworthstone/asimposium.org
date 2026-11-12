/** Offline verification only. This command never imports SQL or contacts a
 * service. An independently supplied public key is required. */
import { readFile, stat } from "node:fs/promises";
import {
  DATABASE_BACKUP_LIMITS,
  verifyDatabaseBackup,
} from "../apps/wire/src/krater/database-backup.ts";

const usage =
  "bun scripts/verify-database-backup.ts --manifest <complete.json> --sql <snapshot.sql> --key <kid>=<trusted-public-key-hex>";

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(usage);
    return;
  }
  let manifestPath: string | undefined;
  let sqlPath: string | undefined;
  const keys: { kid: string; publicKeyHex: string }[] = [];
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error("DATABASE_BACKUP_ARGUMENTS_INVALID");
    if (flag === "--manifest" && manifestPath === undefined) manifestPath = value;
    else if (flag === "--sql" && sqlPath === undefined) sqlPath = value;
    else if (flag === "--key") {
      const match = /^([A-Za-z0-9._-]{1,64})=([a-f0-9]{64})$/.exec(value);
      if (!match?.[1] || !match[2] || keys.length >= 16 || keys.some((key) => key.kid === match[1]))
        throw new Error("DATABASE_BACKUP_ARGUMENTS_INVALID");
      keys.push({ kid: match[1], publicKeyHex: match[2] });
    } else throw new Error("DATABASE_BACKUP_ARGUMENTS_INVALID");
  }
  if (!manifestPath || !sqlPath || keys.length === 0)
    throw new Error("DATABASE_BACKUP_ARGUMENTS_INVALID");
  const manifestStat = await stat(manifestPath);
  const sqlStat = await stat(sqlPath);
  if (
    !manifestStat.isFile() ||
    manifestStat.size > 256 * 1024 ||
    !sqlStat.isFile() ||
    sqlStat.size > DATABASE_BACKUP_LIMITS.bytes
  )
    throw new Error("DATABASE_BACKUP_SIZE_LIMIT");
  const verified = await verifyDatabaseBackup(
    JSON.parse(await readFile(manifestPath, "utf8")),
    await readFile(sqlPath, "utf8"),
    keys,
  );
  console.log(
    JSON.stringify({
      status: "verified",
      format: verified.metadata.format,
      source: verified.metadata.source,
      created_at: verified.metadata.created_at,
      sql_sha256: verified.metadata.sql_sha256,
      schema_sha256: verified.metadata.schema_sha256,
      bytes: verified.metadata.bytes,
      tables: verified.metadata.tables.length,
      statements: verified.statements.length,
      recovery: "quarantined-scratch-only-current-deletion-controls-required",
    }),
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const code =
      error instanceof Error && /^DATABASE_BACKUP_[A-Z_]+$/.test(error.message)
        ? error.message
        : "DATABASE_BACKUP_VERIFICATION_FAILED";
    console.error(JSON.stringify({ status: "failed", code }));
    process.exitCode = 1;
  }
}
