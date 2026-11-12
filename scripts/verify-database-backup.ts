/** Offline verification and explicit destination-marker preparation. Never
 * imports SQL or contacts a service; marker output is create-only and private. */
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import {
  DATABASE_BACKUP_LIMITS,
  verifyDatabaseBackup,
} from "../apps/wire/src/krater/database-backup.ts";

const usage =
  "bun scripts/verify-database-backup.ts --manifest <complete.json> --sql <snapshot.sql> --key <kid>=<trusted-public-key-hex>\n" +
  "bun scripts/verify-database-backup.ts --prepare-destination <new-private-marker-file>";

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(usage);
    return;
  }
  if (args.length === 2 && args[0] === "--prepare-destination") {
    const output = args[1];
    if (!output || output.startsWith("--")) throw new Error("DATABASE_BACKUP_ARGUMENTS_INVALID");
    const marker = crypto.getRandomValues(new Uint8Array(32));
    try {
      await writeFile(output, marker, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST")
        throw new Error("DATABASE_BACKUP_DESTINATION_OUTPUT_EXISTS");
      throw new Error("DATABASE_BACKUP_DESTINATION_PREPARATION_FAILED");
    }
    const sha256 = createHash("sha256").update(marker).digest("hex");
    console.log(
      JSON.stringify({
        status: "prepared",
        sha256,
        marker_key: `backups/control/database-destinations/${sha256}.bin`,
        pin_variable: "DATABASE_BACKUP_DESTINATION_SHA256",
      }),
    );
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
