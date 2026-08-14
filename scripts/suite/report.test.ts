import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  displayPath,
  formatSummaryLine,
  formatUnitLine,
  redact,
  reproduceCommand,
  type SummaryDiagnostic,
  serialize,
  type UnitDiagnostic,
} from "./report.ts";

const ROOT = "/private/var/fixture/asimposium.org";

function unit(overrides: Partial<UnitDiagnostic> = {}): UnitDiagnostic {
  return {
    record: "unit",
    tool: "bun",
    package: "@asimposium/wire",
    suite: "unit",
    version: "1.3.8",
    duration_ms: 1234,
    status: "pass",
    reproduce: "cd ./apps/wire && bun run test:unit",
    dir: "apps/wire",
    code: "SUITE_PASSED",
    ...overrides,
  };
}

describe("redaction", () => {
  test("absolute repository paths never survive into a record", () => {
    const text = `failed at ${ROOT}/apps/wire/src/index.ts`;
    expect(redact(text, ROOT)).toBe("failed at <repo>/apps/wire/src/index.ts");
    expect(redact(text, ROOT)).not.toContain(ROOT);
  });

  test("the home directory is masked even when the root is elsewhere", () => {
    const home = homedir();
    const text = `cache at ${join(home, ".bun", "install")}`;
    const redacted = redact(text, ROOT);
    expect(redacted).toContain("<home>");
    expect(redacted).not.toContain(home);
  });

  test("Fellow bearer tokens are masked", () => {
    const redacted = redact("authorization: asimp_ag_01JXYZABCDEF_s3cr3tvalue", ROOT);
    expect(redacted).toBe("authorization: <redacted>");
  });

  test("enrollment fragment secrets are masked (Fable §5.2: never log the fragment)", () => {
    const redacted = redact(
      "https://a.asimposium.org/join/ASIMP-EN-01JX#v1.abcdef0123456789",
      ROOT,
    );
    expect(redacted).toBe("https://a.asimposium.org/join/ASIMP-EN-01JX<redacted>");
    expect(redacted).not.toContain("abcdef0123456789");
  });

  test("bearer headers and common third-party credential shapes are masked", () => {
    expect(redact("Authorization: Bearer abcdef0123456789", ROOT)).toBe(
      "Authorization: <redacted>",
    );
    expect(redact("ghp_0123456789abcdefghij", ROOT)).toBe("<redacted>");
    expect(redact("sk-0123456789abcdefghij", ROOT)).toBe("<redacted>");
    expect(redact("AIzaSyA0123456789abcdefghijklmnopqrs", ROOT)).toBe("<redacted>");
  });

  test("private key blocks are masked whole, not line by line", () => {
    const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNza\n-----END OPENSSH PRIVATE KEY-----";
    expect(redact(key, ROOT)).toBe("<redacted>");
  });

  test("ordinary scientific text is left alone", () => {
    const text = "claim C-12 depends_on C-7; falsifier missing";
    expect(redact(text, ROOT)).toBe(text);
  });
});

describe("path display", () => {
  test("paths inside the repository are shown relative", () => {
    expect(displayPath(ROOT, join(ROOT, "apps", "wire"))).toBe("./apps/wire");
    expect(displayPath(ROOT, ROOT)).toBe(".");
  });

  test("paths outside the repository are never printed", () => {
    const outside = displayPath(ROOT, "/etc/passwd");
    expect(outside).toBe("<outside-repo>");
    expect(outside).not.toContain("passwd");
  });
});

describe("reproduce commands", () => {
  test("a package unit reproduces with a cd into a relative directory", () => {
    expect(reproduceCommand("apps/wire", "test:unit")).toBe("cd ./apps/wire && bun run test:unit");
  });

  test("a root unit reproduces without a cd", () => {
    expect(reproduceCommand(".", "toolchain:test")).toBe("bun run toolchain:test");
  });
});

describe("serialization", () => {
  test("every diagnostic field is redacted, not just the human line", () => {
    const serialized = serialize(
      unit({
        status: "fail",
        code: "SUITE_FAILED",
        detail: `"bun run test:unit" failed in ${ROOT}/apps/wire with token asimp_ag_0123456789`,
      }),
      ROOT,
    );
    const parsed = JSON.parse(serialized) as UnitDiagnostic;
    expect(parsed.detail).toContain("<repo>/apps/wire");
    expect(parsed.detail).toContain("<redacted>");
    expect(serialized).not.toContain(ROOT);
  });

  test("quotes and backslashes in a detail survive redaction as valid JSON", () => {
    const serialized = serialize(
      unit({
        status: "fail",
        detail: `child said "no" \\ and stopped at ${ROOT}/apps/wire`,
      }),
      ROOT,
    );
    const parsed = JSON.parse(serialized) as UnitDiagnostic;
    expect(parsed.detail).toBe('child said "no" \\ and stopped at <repo>/apps/wire');
  });

  test("the record shape matches the diagnostic contract the acceptance criteria names", () => {
    const parsed = JSON.parse(serialize(unit(), ROOT)) as Record<string, unknown>;
    for (const field of [
      "tool",
      "package",
      "suite",
      "version",
      "duration_ms",
      "status",
      "reproduce",
    ]) {
      expect(parsed[field]).toBeDefined();
    }
  });
});

describe("human rendering", () => {
  test("a unit line carries status, package, directory, command, tool version and duration", () => {
    const line = formatUnitLine(unit({ command: "bun run test:unit" }), ROOT);
    expect(line).toContain("PASS");
    expect(line).toContain("@asimposium/wire");
    expect(line).toContain("./apps/wire");
    expect(line).toContain("bun run test:unit");
    expect(line).toContain("bun@1.3.8");
    expect(line).toContain("1.23s");
  });

  test("a summary line reports every status class and the verdict", () => {
    const summary: SummaryDiagnostic = {
      record: "summary",
      tool: "bun",
      package: "asimposium",
      suite: "unit",
      version: "1.3.8",
      duration_ms: 2000,
      status: "fail",
      reproduce: "bun run suite unit",
      code: "SUITE_INCOMPLETE",
      totals: { total: 4, executed: 3, pass: 2, fail: 1, missing: 0, skip: 1 },
    };
    const line = formatSummaryLine(summary, ROOT);
    expect(line).toBe(
      "summary unit: 2 pass · 1 fail · 0 missing · 1 skip · 3 executed · 2.00s · FAIL",
    );
  });
});
