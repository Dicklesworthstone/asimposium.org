import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildGateRecord,
  formatGateRecord,
  GATE_PREFIX,
  scrubDiagnostic,
} from "../../scripts/gate-record.ts";

const RUNTIME = { runner: "bun", runnerVersion: "1.3.8" };
const gateRecordSource = readFileSync(
  join(import.meta.dir, "../../scripts/gate-record.ts"),
  "utf8",
);

describe("scrubDiagnostic — the never-log list (Fable §14.3)", () => {
  test("masks Fellow bearer tokens", () => {
    const scrubbed = scrubDiagnostic("authorization: Bearer asimp_ag_9f2b1c4d5e6f7a8b9c0d1e2f");
    expect(scrubbed).not.toContain("9f2b1c4d5e6f7a8b9c0d1e2f");
    expect(scrubbed).toContain("<redacted>");
  });

  test("masks the enrollment secret in a join URL fragment (ADR-20)", () => {
    const scrubbed = scrubDiagnostic(
      "https://a.asimposium.org/join/ASIMP-EN-01JXYZ#v1.s3cr3t-material_here",
    );
    expect(scrubbed).not.toContain("s3cr3t-material_here");
    expect(scrubbed).toContain("https://a.asimposium.org/join/ASIMP-EN-01JXYZ");
    expect(scrubbed).toBe("https://a.asimposium.org/join/ASIMP-EN-01JXYZ<redacted>");
  });

  test("masks secret-shaped environment assignments, keeping the name", () => {
    const scrubbed = scrubDiagnostic(
      "AUTH_SECRET=hunter2-hunter2 AUTH_GOOGLE_SECRET: 'GOCSPX-abc123' PORT=3000",
    );
    expect(scrubbed).not.toContain("hunter2-hunter2");
    expect(scrubbed).not.toContain("GOCSPX-abc123");
    expect(scrubbed).toContain("AUTH_SECRET=<redacted>");
    expect(scrubbed).toContain("AUTH_GOOGLE_SECRET=<redacted>");
    // Non-secret configuration survives, or the output stops being useful.
    expect(scrubbed).toContain("PORT=3000");
  });

  test.each([
    ["double-quoted", `AUTH_SECRET="${String.raw`hunter\"2 tail`}" status=fail`, "status=fail"],
    ["single-quoted", `AUTH_SECRET='${String.raw`hunter\'2 tail`}' status=pass`, "status=pass"],
  ] as const)(
    "PLANTED: %s escaped assignment redacts its complete value",
    (_label, input, status) => {
      const scrubbed = scrubDiagnostic(input);
      expect(scrubbed).toBe(`AUTH_SECRET=<redacted> ${status}`);
      expect(scrubbed).not.toContain("hunter");
      expect(scrubbed).not.toContain("2 tail");
    },
  );

  test("PLANTED: an undelimited quoted-value suffix remains redacted", () => {
    const input = `AUTH_SECRET="${String.raw`hunter\"2 tail`}"status=fail PORT=3000`;
    expect(scrubDiagnostic(input)).toBe("AUTH_SECRET=<redacted> PORT=3000");
  });

  test("masks local absolute paths on POSIX and Windows", () => {
    const scrubbed = scrubDiagnostic(
      "error in /Users/someone/projects/asimposium.org/apps/web/app/page.tsx and C:\\Users\\someone\\web\\page.tsx",
    );
    expect(scrubbed).not.toContain("/Users/someone");
    expect(scrubbed).not.toContain("C:\\Users");
    expect(scrubbed.match(/<path>/g)).toHaveLength(2);
  });

  test("leaves ordinary relative diagnostics untouched", () => {
    const text = "apps/web/app/page.tsx(12,3): error TS2322: Type 'x'.";
    expect(scrubDiagnostic(text)).toBe(text);
  });

  test("does not mangle the Stoa origin", () => {
    const text = "writes go to https://a.asimposium.org/v1/sessions";
    expect(scrubDiagnostic(text)).toBe(text);
  });

  test("uses shared-only credential families and replaces every occurrence", () => {
    const first = "github_pat_0123456789abcdefghijkl";
    const second = "sk_live_0123456789abcdefghijkl";
    const redacted = scrubDiagnostic(`first ${first}; second ${second}; repeat ${first}`);
    expect(redacted).toBe("first <redacted>; second <redacted>; repeat <redacted>");
    expect(redacted).not.toContain(first);
    expect(redacted).not.toContain(second);
  });

  test("shared labelled fields consume multiword, header, and cookie tails", () => {
    expect(scrubDiagnostic("directive_body: prove lemma, then reveal witness")).toBe(
      "directive_body: <redacted>",
    );
    expect(scrubDiagnostic("Authorization: Basic YWxhZGRpbjpvcGVuc2VzYW1l status=ok")).toBe(
      "Authorization: <redacted>",
    );
    expect(scrubDiagnostic("Cookie: sid=abc; other=secret; Path=/")).toBe("Cookie: <redacted>");
  });

  test("leaves safe prose and short version identifiers intact", () => {
    const text =
      "AUTH_SECRET is a documentation label; Bearer tokens are hashed before storage; pk-3 is a version.";
    expect(scrubDiagnostic(text)).toBe(text);
  });

  test("does not retain credential-family regexes now owned by contracts", () => {
    expect(gateRecordSource).toContain(
      'import { redactCredentials } from "@asimposium/contracts/diagnostic-safety"',
    );
    expect(gateRecordSource).toContain("WEB_CONTEXT_REDACTIONS");
    expect(gateRecordSource).not.toContain("asimp_ag_[");
    expect(gateRecordSource).not.toContain("#v1\\.");
    expect(gateRecordSource).not.toContain("Bearer|Basic");
    expect(gateRecordSource).not.toContain("github_pat_");
  });
});

describe("buildGateRecord", () => {
  test("carries tool, package, suite, version, duration and status", () => {
    const record = buildGateRecord(
      {
        suite: "typecheck",
        tool: "tsc",
        toolVersion: "5.9.3",
        status: "pass",
        exitCode: 0,
        durationMs: 1234.7,
        repro: "bun run --filter @asimposium/web typecheck",
      },
      RUNTIME,
    );
    expect(record).toMatchObject({
      gate: 1,
      package: "@asimposium/web",
      packagePath: "apps/web",
      suite: "typecheck",
      tool: "tsc",
      toolVersion: "5.9.3",
      runner: "bun",
      status: "pass",
      exitCode: 0,
      durationMs: 1235,
      repro: "bun run --filter @asimposium/web typecheck",
    });
  });

  test("a not_implemented gate names the blocker instead of passing", () => {
    const record = buildGateRecord(
      {
        suite: "security",
        tool: "none",
        toolVersion: "n/a",
        status: "not_implemented",
        exitCode: 78,
        durationMs: 0,
        repro: "bun run --filter @asimposium/web test:security",
        blockedOn: "external: synthetic fixture dependency",
        note: "No mocks of D1 or R2 are permitted as a substitute.",
      },
      RUNTIME,
    );
    expect(record.status).toBe("not_implemented");
    expect(record.exitCode).not.toBe(0);
    expect(record.blockedOn).toBe("external: synthetic fixture dependency");
  });

  test("scrubs secret-shaped content that reaches a record field", () => {
    const record = buildGateRecord(
      {
        suite: "unit",
        tool: "bun test",
        toolVersion: "1.3.8",
        status: "fail",
        exitCode: 1,
        durationMs: 10,
        repro: "bun test /Users/someone/projects/asimposium.org/apps/web",
        note: "token asimp_ag_deadbeefcafe leaked into a message",
      },
      RUNTIME,
    );
    expect(record.repro).not.toContain("/Users/someone");
    expect(record.note).not.toContain("deadbeefcafe");
  });

  test("negative durations cannot be reported", () => {
    const record = buildGateRecord(
      {
        suite: "unit",
        tool: "bun test",
        toolVersion: "1.3.8",
        status: "pass",
        exitCode: 0,
        durationMs: -5,
        repro: "bun run --filter @asimposium/web test:unit",
      },
      RUNTIME,
    );
    expect(record.durationMs).toBe(0);
  });
});

describe("formatGateRecord", () => {
  test("emits one greppable line of valid JSON", () => {
    const line = formatGateRecord(
      buildGateRecord(
        {
          suite: "lint",
          tool: "eslint",
          toolVersion: "9.39.5",
          status: "pass",
          exitCode: 0,
          durationMs: 900,
          repro: "bun run --filter @asimposium/web lint",
        },
        RUNTIME,
      ),
    );
    expect(line.startsWith(`${GATE_PREFIX} `)).toBe(true);
    expect(line).not.toContain("\n");
    const parsed: unknown = JSON.parse(line.slice(GATE_PREFIX.length + 1));
    expect((parsed as { suite: string }).suite).toBe("lint");
  });
});
