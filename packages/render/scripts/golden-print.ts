#!/usr/bin/env bun
/**
 * Print one face of the golden fixture to stdout, so a maintainer can regenerate a golden
 * by hand after an intended face change:
 *
 *   bun run golden:print md   > test/golden/working-pack.md
 *   bun run golden:print json > test/golden/working-pack.json
 *   bun run golden:print html > test/golden/working-pack.html
 *
 * It writes nothing itself, and the golden suite has no update flag. The redirection is
 * the point: regenerating a golden is a deliberate act whose diff a human reads, never a
 * side effect of a test run that wanted to be green (Fable §17.0).
 */

import { renderProjection } from "../src/index.ts";
import type { FaceFormat } from "../src/types.ts";
import { safeWorkingPack } from "../test/_support/fixtures.ts";

const ALIASES: Readonly<Record<string, FaceFormat>> = {
  md: "md",
  markdown: "md",
  json: "json",
  html: "html-fragment",
  "html-fragment": "html-fragment",
};

const requested = process.argv[2] ?? "";
const format = ALIASES[requested];

if (format === undefined) {
  process.stderr.write(
    `Unknown face ${JSON.stringify(requested)}. Known: ${Object.keys(ALIASES).join(", ")}.\n`,
  );
  process.exit(2);
}

process.stdout.write(renderProjection(safeWorkingPack(), format).body);
