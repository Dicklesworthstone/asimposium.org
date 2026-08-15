/**
 * Contract suite: the shipped `apps/web` package, not a fixture.
 *
 * The unit suite proves each rule *can* fire. This suite points the same rules
 * at the real tree, so a future commit that adds a write path to Agora, brings
 * back the Pages Router, widens the Auth.js cookie to the whole domain, or
 * drops a gate entry point turns `bun run test:contract` red.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { GET } from "../../app/api/health/route.ts";
import {
  formatAuthViolations,
  PROPYLON_EXPORTS,
  readAuthSurface,
  validateAuthFile,
} from "../../scripts/auth-contract.ts";
import {
  formatViolations,
  validateAgoraPackage,
  WRITE_PATH_EXEMPTIONS,
} from "../../scripts/route-contract.ts";

const PACKAGE_DIR = dirname(dirname(import.meta.dir));

function readPackageFile(relativePath: string): string {
  return readFileSync(join(PACKAGE_DIR, relativePath), "utf8");
}

describe("app router + one-writer contract, against the real tree", () => {
  test("apps/web satisfies every route-contract rule", () => {
    const violations = validateAgoraPackage(PACKAGE_DIR);
    // formatViolations first: a failure should read as the rule, not a diff.
    expect(formatViolations(violations)).toBe("no violations");
  });

  test("every declared write-path exemption still exists on disk", () => {
    for (const relativePath of WRITE_PATH_EXEMPTIONS.keys()) {
      expect(existsSync(join(PACKAGE_DIR, relativePath))).toBe(true);
    }
  });

  test("the app tree contains no Pages Router directory", () => {
    expect(existsSync(join(PACKAGE_DIR, "pages"))).toBe(false);
    expect(existsSync(join(PACKAGE_DIR, "src", "pages"))).toBe(false);
  });
});

describe("Propylon configuration (Fable §5.1, §14.1) — structural guard", () => {
  const surface = readAuthSurface(readPackageFile("auth.ts"), "auth.ts");

  test("the shipped auth.ts satisfies every Propylon rule", () => {
    // Parsed, not pattern-matched: an adversarial probe defeated the three
    // regexes this replaced by reformatting, hyphenating and destructuring.
    expect(formatAuthViolations(validateAuthFile(PACKAGE_DIR))).toBe("no violations");
  });

  test("the configured provider set is exactly the Google module", () => {
    // The configured array, not the import list: a locally-built provider
    // object never appears in an import, and an imported-but-unused Google
    // satisfies an import scan while configuring nothing.
    expect(surface.providers.literalArray).toBe(true);
    expect(surface.providers.unresolvable).toBe(false);
    expect(surface.providers.entries.map((entry) => entry.module)).toEqual([
      "next-auth/providers/google",
    ]);
    expect(surface.imports).toEqual(["next-auth", "next-auth/providers/google"]);
  });

  test("the exported Propylon surface comes from that very factory call", () => {
    // A safe call somewhere in the file is not the property; the exported
    // `handlers` binding being initialised by it is.
    expect(surface.providers.factoryCalls).toBe(1);
    expect(surface.wiring.fromFactory).toEqual([...PROPYLON_EXPORTS]);
    expect(surface.wiring.missing).toEqual([]);
    expect(surface.wiring.foreign).toEqual([]);
    expect(surface.dynamicCode).toEqual([]);
  });

  test("the sponsor session cookie is configured and host-only", () => {
    // A `domain` key would send the sponsor cookie to a.asimposium.org, which
    // is exactly the cross-plane confusion WRONG_PRINCIPAL exists for.
    expect(surface.cookies.present).toBe(true);
    expect(surface.cookies.unresolvable).toBe(false);
    expect(surface.cookies.keys).not.toContain("domain");
    expect(surface.cookies.keys).toContain("httpOnly");
  });

  test("ordinary session reads cannot refresh the recent-auth claim", () => {
    expect(surface.recentAuth).toMatchObject({
      callbacksPresent: true,
      unresolvable: false,
      jwtStampCount: 1,
      safeJwtStampCount: 1,
      sessionProjectionCount: 1,
      safeSessionProjectionCount: 1,
      iatReads: [],
    });
  });

  test("the file contains exactly one environment expression: process.env.NODE_ENV", () => {
    // Auth.js resolves AUTH_* itself at request time, so auth.ts never needs a
    // secret at any scope. The rule is an allowlist over the whole file rather
    // than a search for bad spellings, which is what kept getting bypassed.
    expect(surface.envAccesses).toHaveLength(1);
    expect(surface.envAccesses[0]?.allowed).toBe(true);
    expect(surface.envAccesses[0]?.text).toBe("process.env.NODE_ENV");
  });
});

describe("sponsor console trust boundary", () => {
  const stoa = readPackageFile("lib/stoa.ts");
  const auth = readPackageFile("auth.ts");
  const actions = readPackageFile("app/console/actions.ts");

  test("the Stoa client is server-only and uses the hardened signed dispatcher", () => {
    expect(stoa).toContain('import "server-only"');
    expect(stoa).toContain("dispatchSignedSponsorRequest");
    expect(stoa).not.toMatch(/\bfetch\s*\(/);
    expect(stoa).not.toContain("mintServiceEnvelope");
  });

  test("Google subjects are not promoted to Worker sponsor ids", () => {
    expect(auth).not.toMatch(/session\.user\.id\s*=\s*token\.sub/);
    expect(actions).toContain("isCanonicalSponsorId");
  });

  test("server actions parse decision bodies at runtime before dispatch", () => {
    expect(actions).toContain("SponsorEnrollmentDecisionSchema.safeParse(decision)");
    expect(actions).toContain("parsed.data.enrollment_id !== enrollmentId");
  });

  test("the explicit step-up buttons force a Google challenge", () => {
    const consolePage = readPackageFile("app/console/page.tsx");
    const approvePage = readPackageFile("app/approve/page.tsx");
    for (const page of [consolePage, approvePage]) {
      expect(page).toContain('prompt: "login"');
      expect(page).toContain('max_age: "0"');
      expect(page).toContain("Reauthenticate for decisions");
    }
  });

  test("the console exposes state changes and expandable controls to assistive technology", () => {
    const cards = readPackageFile("app/console/cards.tsx");
    const page = readPackageFile("app/console/page.tsx");
    const deviceForm = readPackageFile("app/approve/form.tsx");
    expect(cards).toContain('aria-live="polite"');
    expect(cards).toContain("aria-expanded={reduceOpen}");
    expect(cards).toContain('role="alert"');
    expect(page).toContain('aria-labelledby="account-title"');
    expect(page).not.toMatch(/<section[^>]+aria-label=/);
    expect(deviceForm.match(/aria-live="polite"/gu)).toHaveLength(1);
    expect(deviceForm).toContain('className="sr-only"');
    expect(deviceForm).toContain("Proposal found");
    expect(deviceForm).toContain("That character is not used in device codes.");
    expect(deviceForm).not.toContain('aria-label="Device code"');
    expect(deviceForm).toContain("Approve another agent");
    expect(deviceForm).toContain("Enter a different code");
  });
});

describe("the health face states availability, never implies it", () => {
  test("GET /api/health returns exactly the declared fields", async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      plane: "agora",
      stage: "pre-G1",
      // Ownership is architecture and is true today; liveness is a separate
      // fact and is false. Rule A4 forbids collapsing them into one phrase.
      writes_owned_by: "https://a.asimposium.org",
      writes_live: false,
      ledger_live: false,
    });
  });

  test("no field advertises a capability that does not exist", async () => {
    const body = (await GET().json()) as Record<string, unknown>;
    // "accepted at"/"endpoint"/"available" all read as a live route. No write
    // route exists on either plane yet.
    for (const key of Object.keys(body)) {
      expect(key).not.toMatch(/accept|endpoint|available|ready/i);
    }
    expect(body.writes_live).toBe(false);
    expect(body.ledger_live).toBe(false);
  });

  test("the face discloses no environment value", async () => {
    process.env.ASIMP_HEALTH_CANARY = "canary-health-value";
    expect(await GET().text()).not.toContain("canary-health-value");
  });
});

describe("OPS.1 gate entry points", () => {
  const manifest = JSON.parse(readPackageFile("package.json")) as {
    name: string;
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };

  test("every suite this package owes is invocable", () => {
    // Root policy (scripts/suite/policy.ts) gives apps/web the baseline plus
    // `security`. Those are the scripts that must exist.
    for (const script of [
      "typecheck",
      "lint",
      "test",
      "test:unit",
      "test:contract",
      "test:security",
    ]) {
      expect(manifest.scripts[script]).toBeDefined();
    }
  });

  test("suites this package does not owe are not declared", () => {
    // The dispatcher runs any declared script (scripts/suite/cli.ts resolution
    // rule 1), so declaring a deliberate blocker for a suite apps/web does not
    // owe turns a root suite permanently red while adding no coverage. Human
    // E2E against staging belongs to the `e2e` workspace, which owns that gate.
    for (const script of ["test:integration", "test:e2e", "test:performance"]) {
      expect(manifest.scripts[script]).toBeUndefined();
    }
  });

  test("toolchain versions are pinned exactly, not floated", () => {
    const allDeps = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
    };
    for (const [name, range] of Object.entries(allDeps)) {
      // Workspace-internal packages are pinned by the monorepo itself; the
      // workspace protocol is the only acceptable range for them, since any
      // published-looking version would drift from the tree.
      if (name.startsWith("@asimposium/")) {
        expect(range).toBe("workspace:*");
        continue;
      }
      expect(`${name}@${range}`).toMatch(/@\d+\.\d+\.\d+(-[\w.]+)?$/);
    }
  });

  test("the stack table is respected: App Router, Tailwind, Auth.js v5", () => {
    expect(manifest.dependencies["next"]).toMatch(/^16\./);
    expect(manifest.dependencies["next-auth"]).toMatch(/^5\./);
    expect(manifest.devDependencies["tailwindcss"]).toMatch(/^4\./);
    expect(readPackageFile("postcss.config.mjs")).toContain("@tailwindcss/postcss");
    expect(readPackageFile("app/globals.css")).toContain('@import "tailwindcss"');
  });
});
