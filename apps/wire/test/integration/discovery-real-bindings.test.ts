import { expect, test } from "bun:test";
import { delimiter, resolve } from "node:path";

test("production ledger writes reach discovery through real local Workerd/D1/R2", async () => {
  const candidates = [
    ...new Set([
      ...(process.env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((dir) => resolve(dir, "node")),
      "/usr/bin/node",
      "/usr/local/bin/node",
    ]),
  ];
  let node: string | undefined;
  for (const candidate of candidates) {
    if (!(await Bun.file(candidate).exists())) continue;
    const probe = Bun.spawnSync(
      [
        candidate,
        "-e",
        "process.exit(process.versions.bun || Number(process.versions.node.split('.')[0]) < 22 ? 1 : 0)",
      ],
      {
        stdout: "ignore",
        stderr: "ignore",
        timeout: 5000,
      },
    );
    if (probe.exitCode === 0) {
      node = candidate;
      break;
    }
  }
  if (node === undefined)
    throw new Error(
      "DISCOVERY_REAL_BINDINGS_NODE_UNAVAILABLE: install genuine Node >=22; Bun's Node alias cannot run Wrangler's test harness",
    );
  const child = Bun.spawn([node, resolve(import.meta.dir, "discovery-real-bindings.mjs")], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 230000,
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (stderr.trim()) console.error(stderr);
  const records = stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as { kind?: string; status?: string };
      } catch {
        return null;
      }
    });
  for (const record of records) if (record !== null) console.info(JSON.stringify(record));
  if (exit !== 0) throw new Error(`Real binding lane failed (${exit}): ${stderr}`);
  const receipt = records.find((line) => line?.kind === "discovery-real-bindings");
  expect(receipt?.status).toBe("pass");
}, 240000);
