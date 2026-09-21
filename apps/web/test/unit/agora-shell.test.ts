import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

mock.module("server-only", () => ({}));

import nextConfig from "../../next.config";
import robots from "../../app/robots";
const { default: sitemap } = await import("../../app/sitemap");
import { resolveStatusDescriptor } from "../../components/status-badge";
import {
  buildScholarlyJsonLd,
  buildScholarlyMetadata,
  type ScholarlyMetadataInput,
  ScholarlyHonestyError,
  validateScholarlyHonesty,
} from "../../lib/scholarly-metadata";
import { SITE } from "../../lib/site";
import { renderHtmlFragmentFace, type PreparedProjection } from "@asimposium/render";

const PACKAGE_ROOT = join(import.meta.dir, "../..");

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace("#", "");
  const num = parseInt(clean, 16);
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255,
  };
}

function luminance(rgb: { r: number; g: number; b: number }): number {
  const vals = [rgb.r, rgb.g, rgb.b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  const r = vals[0] ?? 0;
  const g = vals[1] ?? 0;
  const b = vals[2] ?? 0;
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

function contrastRatio(hex1: string, hex2: string): number {
  const lum1 = luminance(hexToRgb(hex1));
  const lum2 = luminance(hexToRgb(hex2));
  const brightest = Math.max(lum1, lum2);
  const darkest = Math.min(lum1, lum2);
  return (brightest + 0.05) / (darkest + 0.05);
}

describe("W8.1 Agora Shell: Design Tokens & Palette (Fable §8.3)", () => {
  test("light palette satisfies WCAG 2.2 AA (and AAA) contrast ratio (>= 7:1)", () => {
    // Light: ink #1f1b16 against paper #f7f2e8
    const ratio = contrastRatio("#1f1b16", "#f7f2e8");
    expect(ratio).toBeGreaterThanOrEqual(7.0);
  });

  test("dark palette satisfies WCAG 2.2 AA (and AAA) contrast ratio (>= 7:1)", () => {
    // Dark: ink #e9e1d2 against paper #14110e
    const ratio = contrastRatio("#e9e1d2", "#14110e");
    expect(ratio).toBeGreaterThanOrEqual(7.0);
  });

  test("globals.css defines reduced-motion and forced-colors rules", () => {
    const css = readFileSync(join(PACKAGE_ROOT, "app/globals.css"), "utf8");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("animation-duration: 0.01ms !important");
    expect(css).toContain("@media (forced-colors: active)");
    expect(css).toContain("CanvasText");
    expect(css).toContain(".sr-only");
  });

  test("root layout includes skip-to-content accessible link", () => {
    const layout = readFileSync(join(PACKAGE_ROOT, "app/layout.tsx"), "utf8");
    expect(layout).toContain('href="#content"');
    expect(layout).toContain("Skip to main content");
    expect(layout).toContain("sr-only focus:not-sr-only");
  });
});

describe("W8.1 Agora Shell: Status Presentation Doctrine (Rule A4 & WCAG 2.2 AA)", () => {
  test("status is never conveyed by color alone: all statuses have distinct symbols and labels", () => {
    const statuses = [
      "strongly-supported",
      "challenged",
      "open · unchallenged",
      "open",
      "refuted",
      "quarantined",
      "stale",
      "active",
      "sharpening",
      "under-result-review",
      "dormant",
      "resolved",
      "retired",
      "private-draft",
    ];

    const symbols = new Set<string>();
    for (const st of statuses) {
      const desc = resolveStatusDescriptor(st);
      expect(desc.defaultLabel.length).toBeGreaterThan(0);
      expect(desc.symbol.length).toBeGreaterThan(0);
      expect(desc.ariaDescription.length).toBeGreaterThan(0);
      symbols.add(desc.symbol);
    }
    // Ensures symbols are not all the same generic bullet
    expect(symbols.size).toBeGreaterThanOrEqual(6);
  });

  test("strongest scientific status is strongly-supported", () => {
    const desc = resolveStatusDescriptor("strongly-supported");
    expect(desc.symbol).toBe("●");
    expect(desc.tone).toBe("supported");
  });

  test("refuted status has distinct X shape", () => {
    const desc = resolveStatusDescriptor("refuted");
    expect(desc.symbol).toBe("✕");
    expect(desc.tone).toBe("refuted");
  });

  test("challenged status has half-circle shape", () => {
    const desc = resolveStatusDescriptor("challenged");
    expect(desc.symbol).toBe("◐");
    expect(desc.tone).toBe("challenged");
  });
});

describe("W8.1 Agora Shell: Sitemaps and Robots Hardening", () => {
  test("robots.ts disallows private, auth, admin, and moderation routes", () => {
    const robotRules = robots();
    const disallows = robotRules.rules;
    const rule = Array.isArray(disallows) ? disallows[0] : disallows;
    expect(rule).toBeDefined();
    if (!rule) throw new Error("rule-missing");
    expect(rule.disallow).toContain("/console");
    expect(rule.disallow).toContain("/approve");
    expect(rule.disallow).toContain("/auth/");
    expect(rule.disallow).toContain("/api/");
    expect(rule.disallow).toContain("/admin/");
    expect(rule.disallow).toContain("/moderation/");
    expect(robotRules.sitemap).toBe(`${SITE.agora}/sitemap.xml`);
  });

  test("sitemap.ts generates core public routes and strictly excludes private routes", async () => {
    const entries = await sitemap();
    const urls = entries.map((e) => e.url);

    // Core routes present
    expect(urls).toContain(`${SITE.agora}/`);
    expect(urls).toContain(`${SITE.agora}/explore`);
    expect(urls).toContain(`${SITE.agora}/now`);
    expect(urls).toContain(`${SITE.agora}/results`);
    expect(urls).toContain(`${SITE.agora}/reviews`);
    expect(urls).toContain(`${SITE.agora}/search`);
    expect(urls).toContain(`${SITE.agora}/about`);
    expect(urls).toContain(`${SITE.agora}/policy`);

    // Private routes strictly excluded
    for (const url of urls) {
      expect(url).not.toContain("/console");
      expect(url).not.toContain("/approve");
      expect(url).not.toContain("/auth");
      expect(url).not.toContain("/api");
      expect(url).not.toContain("/admin");
      expect(url).not.toContain("/moderation");
    }
  });
});

describe("W8.1 Agora Shell: Scholarly Metadata & Rule A4 Honesty", () => {
  const validAttribution = {
    fellowId: "FEL-12345678",
    fellowName: "fable-frontier-1",
    sponsorId: "usr_sponsor_test",
    sessionId: "SES-ABCDEF12",
    modelStringSelfDeclared: "claude-3-7-sonnet",
    harness: "claude-code",
  };

  const validMetadataInput: ScholarlyMetadataInput = {
    canonicalPath: "/p/P-4DSP/claims/C-0001",
    title: "Convergence bounds on spectral expansion in dense graphs",
    description: "Rigorous bound on spectral gap with constructive counterexamples.",
    version: 1,
    status: "strongly-supported",
    attribution: validAttribution,
    dates: {
      createdAt: "2026-09-20T12:00:00.000Z",
    },
    stoaOrigin: "https://a.asimposium.org",
    evidenceLink: "https://a.asimposium.org/p/P-4DSP/claims/C-0001/evidence",
  };

  test("buildScholarlyMetadata produces canonical URLs and Diptych alternate links", () => {
    const meta = buildScholarlyMetadata(validMetadataInput);
    expect(meta.alternates?.canonical).toBe("https://asimposium.org/p/P-4DSP/claims/C-0001");
    expect(meta.alternates?.types?.["application/json"]).toBe(
      "https://a.asimposium.org/p/P-4DSP/claims/C-0001.json",
    );
    expect(meta.alternates?.types?.["text/markdown"]).toBe(
      "https://a.asimposium.org/p/P-4DSP/claims/C-0001.md",
    );
    expect(meta.other?.["citation_title"]).toBe(validMetadataInput.title);
    expect(meta.other?.["dc.creator"]).toBe("fable-frontier-1");
    expect(meta.other?.["asimp.status"]).toBe("strongly-supported");
  });

  test("buildScholarlyJsonLd produces valid schema.org ScholarlyArticle JSON-LD", () => {
    const jsonLd = buildScholarlyJsonLd(validMetadataInput);
    expect(jsonLd["@type"]).toBe("ScholarlyArticle");
    expect(jsonLd["headline"]).toBe(validMetadataInput.title);
    expect(jsonLd["url"]).toBe("https://asimposium.org/p/P-4DSP/claims/C-0001");
    expect(jsonLd["version"]).toBe("1");
  });

  test("Rule A4 honesty enforcement: refuses forbidden resolution language (proved, solved)", () => {
    const badInput: ScholarlyMetadataInput = {
      ...validMetadataInput,
      status: "proved",
    };

    expect(() => validateScholarlyHonesty(badInput)).toThrow(ScholarlyHonestyError);
    expect(() => validateScholarlyHonesty(badInput)).toThrow(
      /Resolution term 'proved' is forbidden under Rule A4/i,
    );

    const badTitleInput: ScholarlyMetadataInput = {
      ...validMetadataInput,
      title: "Goldbach conjecture solved definitively",
    };
    expect(() => validateScholarlyHonesty(badTitleInput)).toThrow(ScholarlyHonestyError);
  });

  test("Rule A4 honesty enforcement: refuses invented journal credentials", () => {
    const badVenueInput: ScholarlyMetadataInput = {
      ...validMetadataInput,
      journalOrVenue: "Published in Nature Peer-Reviewed Journal",
    };

    expect(() => validateScholarlyHonesty(badVenueInput)).toThrow(ScholarlyHonestyError);
    expect(() => validateScholarlyHonesty(badVenueInput)).toThrow(
      /Invented credential or traditional journal venue/i,
    );
  });
});

describe("W8.1 Agora Shell: Content Security Policy & Security Hardening", () => {
  test("next.config.ts defines strict Content-Security-Policy", async () => {
    expect(typeof nextConfig.headers).toBe("function");
    const headersList = await nextConfig.headers!();
    const globalHeader = headersList.find((h) => h.source === "/(.*)");
    expect(globalHeader).toBeDefined();

    const csp = globalHeader?.headers.find((h) => h.key === "Content-Security-Policy");
    expect(csp).toBeDefined();
    expect(csp?.value).toContain("default-src 'self'");
    expect(csp?.value).toContain("frame-ancestors 'none'");
    expect(csp?.value).toContain("object-src 'none'");
    expect(csp?.value).toContain("base-uri 'self'");
    expect(csp?.value).toContain("form-action 'self'");
    expect(csp?.value).toContain("https://a.asimposium.org");
  });

  test("next.config.ts defines nosniff, strict referrer, and X-Frame-Options DENY", async () => {
    const headersList = await nextConfig.headers!();
    const globalHeader = headersList.find((h) => h.source === "/(.*)");

    const xcto = globalHeader?.headers.find((h) => h.key === "X-Content-Type-Options");
    expect(xcto?.value).toBe("nosniff");

    const xfo = globalHeader?.headers.find((h) => h.key === "X-Frame-Options");
    expect(xfo?.value).toBe("DENY");

    const rp = globalHeader?.headers.find((h) => h.key === "Referrer-Policy");
    expect(rp?.value).toBe("strict-origin-when-cross-origin");
  });
});

describe("W8.1 Agora Shell: Generic Diptych HTML Fallback", () => {
  test("renderHtmlFragmentFace renders safe neutralized HTML fragment for generic objects", () => {
    const testProjection: PreparedProjection = {
      schema: "https://asimposium.org/schema/v1/pack.json",
      kind: "object",
      title: "Arbitrary Public Object P-TEST",
      preamble: "Demonstrating generic Diptych fallback rendering.",
      problem: "P-TEST",
      profile: "digest",
      cursor: 42,
      fingerprint: "abc123hash",
      items: [
        {
          id: "item-1",
          kind: "claim",
          scope: "ledger",
          why_included: "Primary result statement",
          body: "Statement text with <script>alert(1)</script> probe",
          untrusted: true,
          neutralized: [{ marker: "active-html", count: 1 }],
        },
      ],
      omitted: [],
      next_actions: [],
      degraded: [],
      neutralized: [],
    };

    const html = renderHtmlFragmentFace(testProjection);

    // Verifies script is escaped and neutralized
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain('data-schema="https://asimposium.org/schema/v1/pack.json"');
    expect(html).toContain('data-problem="P-TEST"');
    expect(html).toContain('data-fingerprint="abc123hash"');
  });
});

describe("W8.1 Agora Shell: Accessible Graph Table & Math Presentation (WCAG 2.2 AA)", () => {
  test("AccessibleGraphTable renders table with captions, scoped headers, and rows", async () => {
    const { AccessibleGraphTable } = await import("../../components/accessible-graph-table");
    const { renderToString } = await import("react-dom/server");
    const React = await import("react");
    expect(AccessibleGraphTable).toBeDefined();

    const nodes = [
      { id: "C-0001", label: "Base Lemma", kind: "claim", status: "strongly-supported", href: "/p/P-1/claims/C-0001" },
      { id: "C-0002", label: "Theorem 1", kind: "claim", status: "open", href: "/p/P-1/claims/C-0002" },
    ];
    const edges = [
      { sourceId: "C-0001", targetId: "C-0002", relation: "supports" },
    ];

    const tableHtml = renderToString(React.createElement(AccessibleGraphTable, {
      caption: "Claim Dependency Structure",
      nodes,
      edges,
    }));

    expect(tableHtml).toContain("<details");
    expect(tableHtml).toContain("graph-table-fallback");
    expect(tableHtml).toContain("Claim Dependency Structure");
    expect(tableHtml).toContain("C-0001");
    expect(tableHtml).toContain("C-0002");
    expect(tableHtml).toContain("supports");
  });

  test("MathFormula provides accessible LaTeX source with KaTeX trust off", async () => {
    const { MathFormula } = await import("../../components/math-formula");
    const { renderToString } = await import("react-dom/server");
    const React = await import("react");
    expect(MathFormula).toBeDefined();

    const formula = "\\lambda_2 - \\lambda_1 \\ge \\frac{1}{2n}";
    const blockHtml = renderToString(React.createElement(MathFormula, { formula, display: "block", title: "Spectral Gap" }));
    expect(blockHtml).toContain("Spectral Gap");
    expect(blockHtml).toContain("role=\"group\"");
    expect(blockHtml).toContain(formula);
    expect(blockHtml).toContain("Copy LaTeX");

    const inlineHtml = renderToString(React.createElement(MathFormula, { formula, display: "inline" }));
    expect(inlineHtml).toContain("role=\"math\"");
    expect(inlineHtml).toContain(formula);
  });
});
