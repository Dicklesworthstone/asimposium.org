#!/usr/bin/env node
/**
 * Planted-defect registry and runner (beads codz, wty4, lu59, p4b, 10lz,
 * ncnw, kqz5, f37v, kw85). Each plant re-introduces one real defect that a
 * real-bindings lane (or unit test) must catch.
 *
 *   node scripts/planted-defects.mjs --check
 *       Every plant's `find` snippet still matches its file exactly once in
 *       this checkout (run by scripts/suite/planted-defects.test.ts), so plants
 *       cannot silently rot.
 *   node scripts/planted-defects.mjs --run <git-worktree> [--only <id,...>]
 *       In a CLEAN git worktree of this repo (with its own `bun install`),
 *       apply each plant, run its lane, REQUIRE a non-zero exit, and write the
 *       original bytes back. Never run against the primary working tree: the
 *       runner refuses a dirty tree and never creates or removes directories.
 *
 * Exit: 0 every plant caught; 1 a plant survived or a restore failed; 2 usage.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LANE = (name) => ["node", `apps/wire/test/integration/${name}-real-bindings.mjs`];
const UNIT = (file) => ["bun", "test", "--timeout=120000", file];

export const PLANTS = [
  {
    id: "conflict-sql-pre-0054",
    bead: "codz",
    file: "apps/wire/src/mega-commands/conflict-moves.ts",
    find: "AND ((c.claim_a_id = cr.source_claim_id AND c.claim_a_version = cr.source_version",
    replace: "AND ((c.object_a = cr.source_claim_id AND c.claim_a_version = cr.source_version",
    command: LANE("moves"),
  },
  {
    id: "inverted-move-ranking",
    bead: "codz",
    file: "apps/wire/src/mega-commands/live-provider.ts",
    find: "  if (tierA !== tierB) return tierA - tierB;",
    replace: "  if (tierA !== tierB) return tierB - tierA;",
    command: LANE("moves"),
  },
  {
    id: "matching-without-sponsor-exclusion",
    bead: "codz",
    file: "apps/wire/src/review-requests/matching-sql.ts",
    find: "  AND f.sponsor_id NOT IN (json_extract(j, '$.author_sponsor'), json_extract(j, '$.sender_sponsor'))\n",
    replace: "",
    command: LANE("matchmaking"),
  },
  {
    id: "honors-ignores-computed-disposition",
    bead: "codz",
    file: "apps/wire/src/discovery/honors-service.ts",
    find: 'const isStronglySupported = fold?.disposition === "strongly-supported";',
    replace:
      'const isStronglySupported = fold?.disposition === "strongly-supported" || (fold?.disposition === "corroborated" || fold?.disposition === "open");',
    command: LANE("honors"),
  },
  {
    id: "transfer-cancel-unguarded",
    bead: "wty4",
    file: "apps/wire/src/enrollment/d1-store.ts",
    find: "            SET status = 'cancelled', resolved_at = ?\n          WHERE transfer_id = ? AND status = 'pending'`,",
    replace:
      "            SET status = 'cancelled', resolved_at = ?\n          WHERE transfer_id = ?`,",
    command: ["bash", "scripts/e2e-identity-lifecycle.sh"],
    note: "Caught deterministically only when the cancel commits after the accept; the lane races them.",
  },
  {
    id: "nonce-expiry-in-milliseconds",
    bead: "p4b",
    file: "apps/wire/src/krater/retention.ts",
    find: 'WHERE expires_at <= ?").bind(nowSeconds)',
    replace: 'WHERE expires_at <= ?").bind(nowMs)',
    command: LANE("security-retention"),
  },
  {
    id: "deletion-journal-replay-skips-drafts",
    bead: "p4b",
    file: "apps/wire/src/krater/retention.ts",
    find: '      if (exists && exists.status === "private-draft" && exists.public_seq === 0) {',
    replace: '      if (exists && exists.status === "PLANTED-never" && exists.public_seq === 0) {',
    command: LANE("deletion-journal"),
  },
  {
    id: "export-verifier-trusts-header",
    bead: "10lz",
    file: "scripts/verify-export.ts",
    find: "  if (last !== undefined && !signedRoots.has(last.seq)) {",
    replace: "  if (false && last !== undefined && !signedRoots.has(last.seq)) {",
    command: UNIT("scripts/suite/verify-export.test.ts"),
  },
  {
    id: "novelty-counts-same-sponsor",
    bead: "ncnw",
    file: "apps/wire/src/ledger-face.ts",
    find: '        review.tier !== "T0" &&',
    replace: "        true &&",
    command: LANE("novelty"),
  },
  {
    id: "publish-not-screened",
    bead: "kqz5",
    file: "apps/wire/src/problems/router.ts",
    find: 'if (action.action === "publish" || action.action === "revise-statement") {',
    replace: "if (false as boolean) {",
    command: LANE("problem-screening"),
  },
  {
    id: "herald-refresh-silent",
    bead: "f37v",
    file: "apps/wire/src/herald/room-core.ts",
    find: "      this.send(socket, a, Math.max(head.seq, a.acknowledged), now);\n    }\n  }",
    replace: "      void now;\n    }\n  }",
    command: LANE("herald-room"),
  },
  {
    id: "formal-records-unwired",
    bead: "kw85",
    file: "apps/wire/src/sessions/router-core.ts",
    find: '    const formalRecords =\n      profile === "formal"',
    replace: '    const formalRecords =\n      (profile as string) === "PLANTED-never"',
    command: LANE("packs"),
  },
];

function occurrences(text, snippet) {
  return text.split(snippet).length - 1;
}

export function checkPlants(root) {
  const problems = [];
  for (const plant of PLANTS) {
    let text;
    try {
      text = readFileSync(resolve(root, plant.file), "utf8");
    } catch {
      problems.push(`${plant.id}: ${plant.file} is missing`);
      continue;
    }
    const count = occurrences(text, plant.find);
    if (count !== 1) problems.push(`${plant.id}: snippet matches ${count} times in ${plant.file}`);
  }
  return problems;
}

function git(worktree, args) {
  return spawnSync("git", ["-C", worktree, ...args], { encoding: "utf8" });
}

function run(worktree, only) {
  const status = git(worktree, ["status", "--porcelain", "--untracked-files=no"]);
  if (status.status !== 0 || status.stdout.trim() !== "") {
    console.error("refusing: the worktree is not a clean git checkout");
    return 2;
  }
  const problems = checkPlants(worktree);
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    return 1;
  }
  let survived = 0;
  for (const plant of PLANTS.filter((p) => only === null || only.includes(p.id))) {
    const path = resolve(worktree, plant.file);
    const original = readFileSync(path, "utf8");
    writeFileSync(path, original.replace(plant.find, plant.replace));
    let exit;
    try {
      exit = spawnSync(plant.command[0], plant.command.slice(1), {
        cwd: worktree,
        stdio: ["ignore", "ignore", "ignore"],
        timeout: 20 * 60_000,
      }).status;
    } finally {
      writeFileSync(path, original);
    }
    const caught = exit !== 0;
    if (!caught) survived += 1;
    console.log(JSON.stringify({ plant: plant.id, bead: plant.bead, caught, exit }));
  }
  const after = git(worktree, ["status", "--porcelain", "--untracked-files=no"]);
  if (after.stdout.trim() !== "") {
    console.error("restore failed: the worktree is dirty after the run");
    return 1;
  }
  return survived === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  if (args[0] === "--check") {
    const problems = checkPlants(root);
    console.log(JSON.stringify({ plants: PLANTS.length, problems }));
    process.exit(problems.length === 0 ? 0 : 1);
  }
  if (args[0] === "--run" && args[1]) {
    const onlyIndex = args.indexOf("--only");
    const only = onlyIndex > -1 ? (args[onlyIndex + 1] ?? "").split(",") : null;
    if (resolve(args[1]) === root) {
      console.error("refusing: pass a separate git worktree, never the primary checkout");
      process.exit(2);
    }
    process.exit(run(resolve(args[1]), only));
  }
  console.error(
    "usage: node scripts/planted-defects.mjs --check | --run <git-worktree> [--only id,...]",
  );
  process.exit(2);
}
