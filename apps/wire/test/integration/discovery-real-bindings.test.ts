import { expect, test } from "bun:test";
import { delimiter, resolve } from "node:path";

test.each([
  "positive",
  "reject",
  "quarantine",
  "unavailable",
  "wrong-digest",
  "wrong-context",
  "science",
  "areas",
  "governance",
  "statement-review",
  "credential-liveness",
  "workshop-read",
  "unlisted",
])(
  "production ledger writes reach discovery through real local Workerd/D1/R2: %s",
  async (screenMode) => {
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
    const child = Bun.spawn(
      [
        node,
        resolve(
          import.meta.dir,
          screenMode === "workshop-read"
            ? "workshop-read-real-bindings.mjs"
            : screenMode === "credential-liveness"
              ? "claim-credential-liveness-real-bindings.mjs"
              : screenMode === "statement-review"
                ? "statement-review-real-bindings.mjs"
                : screenMode === "unlisted"
                  ? "unlisted-real-bindings.mjs"
                  : screenMode === "governance"
                    ? "problem-lifecycle-ledger-real-bindings.mjs"
                    : screenMode === "areas"
                      ? "area-discovery-real-bindings.mjs"
                      : "discovery-real-bindings.mjs",
        ),
        screenMode,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 230000,
      },
    );
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
          return JSON.parse(line) as {
            kind?: string;
            status?: string;
            screening_mode?: string;
            screening_refusals?: number;
          };
        } catch {
          return null;
        }
      });
    for (const record of records) if (record !== null) console.info(JSON.stringify(record));
    if (exit !== 0) throw new Error(`Real binding lane failed (${exit}): ${stderr}`);
    const kind =
      screenMode === "workshop-read"
        ? "workshop-read-real-bindings"
        : screenMode === "credential-liveness"
          ? "claim-credential-liveness-real-bindings"
          : screenMode === "statement-review"
            ? "statement-review-real-bindings"
            : screenMode === "unlisted"
              ? "unlisted-real-bindings"
              : screenMode === "governance"
                ? "problem-lifecycle-ledger"
                : screenMode === "areas"
                  ? "area-discovery-real-bindings"
                  : screenMode === "science"
                    ? "scientific-journey-real-bindings"
                    : screenMode === "positive"
                      ? "discovery-real-bindings"
                      : "discovery-screening-real-bindings";
    const receipt = records.find((line) => line?.kind === kind);
    expect(receipt?.status).toBe("pass");
    // Area publication is not a paid-screening-mode proof.
    if (
      screenMode === "areas" ||
      screenMode === "governance" ||
      screenMode === "unlisted" ||
      screenMode === "statement-review" ||
      screenMode === "credential-liveness" ||
      screenMode === "workshop-read"
    )
      return;
    expect(receipt?.screening_mode).toBe(screenMode);
    expect(receipt?.screening_refusals).toBe(
      screenMode === "science" ? 1 : screenMode === "positive" ? 0 : 11,
    );
  },
  240000,
);
