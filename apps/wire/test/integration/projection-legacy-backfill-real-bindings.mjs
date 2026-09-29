import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectionDoctorReportSchema } from "@asimposium/contracts";
import { getPlatformProxy } from "wrangler";
import { backfillKraterIntegrity } from "../../src/krater/krater.ts";
import { projectionDoctorReport } from "../../src/krater/projection-replay.ts";

// W2.6 (bead asimposiumorg-nuzc) on a real local D1 that went through the
// legacy upgrade, as the S-2 journal lane builds it: the 0001 schema, the
// retained legacy claim fixture, then the full migration journal. The real
// integrity backfill then rebuilds the legacy claim build row, stamping its
// own completion time (later than the event); the projection doctor must
// still find the problem consistent. No deploy claim.

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const krater = join(root, "apps/wire/src/krater");
const wrangler = join(root, "apps/wire/node_modules/.bin/wrangler");
const PROBLEM = "P-upgrade-existing";
const BACKFILLED_AT = "2026-09-01T00:00:00.000Z";

const persist = mkdtempSync(join(tmpdir(), "asimp-legacy-backfill-"));
const run = (args) =>
  execFileSync(wrangler, [...args, "--local", "--persist-to", persist], {
    cwd: krater,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 300_000,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, CI: "1" },
  });
run(["d1", "migrations", "apply", "DB", "--config", "wrangler.s2-legacy.toml"]);
run([
  "d1",
  "execute",
  "DB",
  "--config",
  "wrangler.s2-legacy.toml",
  "--file",
  "fixtures/legacy-existing-event.sql",
]);
run(["d1", "migrations", "apply", "DB", "--config", "wrangler.s2-upgrade.toml"]);
console.log(JSON.stringify({ stage: "legacy-database-upgraded" }));

// A binding-only config over the same database identity and persisted state.
const configDir = mkdtempSync(join(tmpdir(), "asimp-legacy-proxy-"));
const config = join(configDir, "wrangler.toml");
writeFileSync(
  config,
  [
    'name = "asimposium-legacy-backfill-proxy"',
    'compatibility_date = "2026-08-13"',
    "[[d1_databases]]",
    'binding = "DB"',
    'database_name = "asimposium-s2-krater-legacy"',
    'database_id = "00000000-0000-0000-0000-000000000000"',
    "",
  ].join("\n"),
);
const proxy = await getPlatformProxy({
  configPath: config,
  persist: { path: join(resolve(persist), "v3") },
});
try {
  const db = proxy.env.DB;
  const before = await db
    .prepare("SELECT updated_at FROM claim_projections WHERE problem_id = ?")
    .bind(PROBLEM)
    .first();
  assert.equal(before.updated_at, "2026-08-14T00:00:00.000Z", "the legacy build row is loaded");

  await backfillKraterIntegrity(db, PROBLEM, BACKFILLED_AT, Date.parse(BACKFILLED_AT) + 60_000);
  const after = await db
    .prepare("SELECT updated_at FROM claim_projections WHERE problem_id = ?")
    .bind(PROBLEM)
    .first();
  assert.equal(
    after.updated_at,
    BACKFILLED_AT,
    "the backfill rebuilt the build row at its own time",
  );

  const report = ProjectionDoctorReportSchema.parse(await projectionDoctorReport(db, PROBLEM));
  assert.equal(report.integrity.sound, true, JSON.stringify(report.integrity));
  assert.deepEqual(report.drift, [], JSON.stringify(report.drift));
  assert.equal(report.status, "consistent");
  console.log(
    JSON.stringify({
      kind: "projection-legacy-backfill-real-bindings",
      status: "pass",
      events: report.integrity.events,
      boundary: "local D1 upgraded from the legacy 0001 schema; real integrity backfill; no deploy",
    }),
  );
} finally {
  await proxy.dispose();
}
