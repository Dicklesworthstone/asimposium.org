import { afterAll, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

import { renderToStaticMarkup } from "react-dom/server";

import {
  assertNoScientificDispositionOverride,
  ScientificDispositionOverrideProhibitedError,
} from "@asimposium/contracts";
import { getDocument, getProtocolJson, getProtocolRules } from "@asimposium/protocol";

const { default: AboutPage } = await import("../../app/about/page");
const { default: AdminPage, metadata: adminMetadata } = await import("../../app/admin/page");
const { default: ModerationPage } = await import("../../app/moderation/page");
const { default: PolicyPage } = await import("../../app/policy/page");
const { default: ProtocolPage } = await import("../../app/protocol/page");

const realAuth = { ...(await import("../../auth.ts")) };
const originalOperatorIds = process.env.OPERATOR_PRINCIPAL_IDS;

afterAll(() => {
  mock.module("../../auth", () => realAuth);
  mock.module("@/auth", () => realAuth);
  if (originalOperatorIds === undefined) {
    delete process.env.OPERATOR_PRINCIPAL_IDS;
  } else {
    process.env.OPERATOR_PRINCIPAL_IDS = originalOperatorIds;
  }
});

describe("W8.8c Human Protocol Pages & Thin Audited Admin", () => {
  describe("Public Protocol Projections & Diptych Parity", () => {
    test("/protocol renders served protocol text and Diptych links", async () => {
      const doc = getDocument("protocol");
      const rules = getProtocolRules();
      const json = getProtocolJson();

      const element = await ProtocolPage();
      const html = renderToStaticMarkup(element);

      // Title, version, status, digest from served text
      expect(html).toContain(doc.title);
      expect(html).toContain(doc.version);
      expect(html).toContain(doc.digest.slice(0, 16));

      // Diptych links
      expect(html).toContain('href="/protocol.md"');
      expect(html).toContain('href="/protocol.json"');

      // Rules P1-P13
      for (const rule of json.hard_rules) {
        expect(html).toContain(rule.code);
        expect(html).toContain(rule.title);
      }

      // Cap measurement
      expect(html).toContain(`${rules.words} / ${rules.cap} words`);
    });

    test("/policy renders served policy text and Diptych link", async () => {
      const doc = getDocument("policy");

      const element = await PolicyPage();
      const html = renderToStaticMarkup(element);

      expect(html).toContain(doc.title);
      expect(html).toContain(doc.version);
      expect(html).toContain(doc.digest.slice(0, 16));
      expect(html).toContain('href="/policy.md"');
      expect(html).toContain("Dual-Use &amp; Operational Harm");
      expect(html).toContain("Prompt Injection &amp; Evasion");
      expect(html).toContain("SPONSOR_APPEAL_AVAILABLE");
    });

    test("/about renders mission, architecture, and Diptych links", async () => {
      const doc = getDocument("handbook");

      const element = await AboutPage();
      const html = renderToStaticMarkup(element);

      expect(html).toContain("About ASImposium");
      expect(html).toContain(doc.version);
      expect(html).toContain(doc.digest.slice(0, 16));
      expect(html).toContain('href="/about.md"');
      expect(html).toContain('href="/AGENTS.md"');
      expect(html).toContain("Agora (<code>asimposium.org</code>)");
      expect(html).toContain("Stoa (<code>a.asimposium.org</code>)");
      expect(html).toContain("The Diptych Doctrine (Rule A1)");
    });

    test("/moderation renders separation of science from safety and notice standards", async () => {
      const doc = getDocument("policy");

      const element = await ModerationPage();
      const html = renderToStaticMarkup(element);

      expect(html).toContain("Moderation &amp; Safety Standards");
      expect(html).toContain(doc.version);
      expect(html).toContain('href="/moderation.md"');
      expect(html).toContain("Scientific weakness is never safety rhetoric");
      expect(html).toContain("Moderation never alters scientific disposition");
      expect(html).toContain("screening-warning");
      expect(html).toContain("screening-degraded");
      expect(html).toContain("Thin Audited Administration");
    });
  });

  describe("Admin Console Protection & Structural Constraints", () => {
    test("admin metadata declares private noindex/nofollow", () => {
      expect(adminMetadata.robots).toEqual({ index: false, follow: false });
    });

    test("unauthenticated visitor sees sign-in prompt", async () => {
      // Mock unauthenticated
      mock.module("../../auth", () => ({
        auth: async () => null,
        signIn: async () => {},
      }));

      const element = await AdminPage();
      const html = renderToStaticMarkup(element);

      expect(html).toContain("Sign in required");
      expect(html).toContain("restricted to allowlisted platform operators");
    });

    test("non-operator authenticated sponsor sees 403 Forbidden", async () => {
      // Mock sponsor who is not an operator
      mock.module("../../auth", () => ({
        auth: async () => ({
          user: { id: "usr_regular_sponsor_bob" },
          authIssuedAt: Math.floor(Date.now() / 1_000),
        }),
        signIn: async () => {},
      }));

      process.env.OPERATOR_PRINCIPAL_IDS = "usr_operator_alice_only";

      const element = await AdminPage();
      const html = renderToStaticMarkup(element);

      expect(html).toContain("403 Forbidden: Unauthorized Principal");
      expect(html).toContain("usr_regular_sponsor_bob");
      expect(html).toContain("not in the operator allowlist");
    });

    test("operator with stale auth sees Step-Up Required prompt", async () => {
      const operatorId = "usr_operator_alice";
      process.env.OPERATOR_PRINCIPAL_IDS = operatorId;

      // Auth issued 30 minutes ago (stale > 15m threshold)
      mock.module("../../auth", () => ({
        auth: async () => ({
          user: { id: operatorId },
          authIssuedAt: Math.floor(Date.now() / 1_000) - 1800,
        }),
        signIn: async () => {},
      }));

      const element = await AdminPage();
      const html = renderToStaticMarkup(element);

      expect(html).toContain("Recent Authentication Required");
      expect(html).toContain("Re-authenticate with Google");
    });

    test("authorized operator sees queues, controls, and read-only notice", async () => {
      const operatorId = "usr_operator_alice";
      process.env.OPERATOR_PRINCIPAL_IDS = operatorId;

      mock.module("../../auth", () => ({
        auth: async () => ({
          user: { id: operatorId },
          authIssuedAt: Math.floor(Date.now() / 1_000) - 60,
        }),
        signIn: async () => {},
      }));

      const element = await AdminPage();
      const html = renderToStaticMarkup(element);

      expect(html).toContain("Operator Status: Read-Only By Default");
      expect(html).toContain(operatorId);
      expect(html).toContain("Quarantine Queue (Screening Holds)");
      expect(html).toContain("Reports &amp; Conduct Queue");
      expect(html).toContain("Audited Content Controls");
      expect(html).toContain("Area Rename &amp; Maintenance");
      expect(html).toContain("Immutable Audit Log");
      expect(html).toContain("Administrative tools cannot alter, waive, or falsify scientific dispositions");
    });

    test("structural impossibility: disposition override throws ScientificDispositionOverrideProhibitedError", () => {
      expect(() => {
        assertNoScientificDispositionOverride({
          target_id: "C-123",
          disposition: "strongly-supported",
        });
      }).toThrow(ScientificDispositionOverrideProhibitedError);

      expect(() => {
        assertNoScientificDispositionOverride({
          scientific_disposition: "conclusively-settled",
        });
      }).toThrow(ScientificDispositionOverrideProhibitedError);
    });
  });
});
