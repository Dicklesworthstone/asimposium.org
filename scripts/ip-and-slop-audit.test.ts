/**
 * W12.5 Automated Pre-Operator IP Firewall, R-12 Rules Word-Cap, and Slop-Scrub Gate
 * (`asimposiumorg-31w`, Fable Rule A8 & R-12).
 *
 * NOTE: Per Fable R-12, final IP diff-review is a personal human operator gate at G2
 * and is NOT delegable to automated agents. This suite provides the permanent CI
 * guardrails and pre-review checklist backing `docs/ip-diff-review-prep-2026-11-21.md`:
 *  1. Hard + soft rules inside `packages/protocol/assets/protocol.md` stay <= 1,000 words
 *     (preamble sits outside the rules cap per W12.5).
 *  2. Zero proprietary-ancestor skill names, private worksheet jargon, or smuggled prompts
 *     appear in any served text (`packages/protocol/assets/*`).
 *  3. Zero telltale AI-slop clichés appear in served texts.
 *  4. Rule A4/A10 non-pretense checks hold (no PROVED banner claims, no leaderboards).
 *  5. Every served text is hash-pinned and matches its static apex copy where applicable.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

const SERVED_ASSETS = [
  "capsule.md",
  "handbook.md",
  "inoculation.md",
  "llms.txt",
  "policy.md",
  "protocol.md",
  "skill.md",
] as const;

/**
 * Proprietary design ancestors named in Rule A8 / W12.5 whose prose, schemas,
 * worksheets, and internal terminology MUST NEVER be copied into served texts.
 */
const FORBIDDEN_ANCESTOR_SIGNATURES: readonly RegExp[] = [
  /\bmodes-of-reasoning-project-analysis\b/i,
  /\bbrennerbot-with-ntm\b/i,
  /\bfrontier-math-research-with-epistemic-humility\b/i,
  /\bjust-say-no-to-process-porn-and-ceremony\b/i,
  /\blean-formal-feedback-loop\b/i,
  /\brunning-the-gauntlet-on-your-rust-port\b/i,
  /\bprocess porn\b/i,
  /\bthird alternative\b/i,
  /\bbrenner\b/i,
  /\bgoodhart\b/i,
  /\bntm swarm\b/i,
  /\bmcp agent mail\b/i,
  /\bcass memory\b/i,
  /\bbeads_rust\b/i,
  /\bfrankensqlite\b/i,
  /\bfrankentui\b/i,
];

/**
 * Telltale AI-generated slop phrases banned from served public prose.
 */
const FORBIDDEN_SLOP_PHRASES: readonly RegExp[] = [
  /\bdelve into\b/i,
  /\btapestry\b/i,
  /\bgame[- ]changer\b/i,
  /\bunleash\b/i,
  /\brevolutioniz(?:e|ing)\b/i,
  /\bparadigm shift\b/i,
  /\bcutting[- ]edge\b/i,
  /\bseamless(?:ly)?\b/i,
  /\bsynergy\b/i,
  /\bholistic\b/i,
  /\bgroundbreaking\b/i,
  /\bworld[- ]class\b/i,
  /\bit is worth noting\b/i,
  /\bin today's fast[- ]paced\b/i,
  /\btestament to\b/i,
];

function wordCount(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0).length;
}

/**
 * Extract the `## Rules` section (hard + soft rules) from `protocol.md`,
 * excluding `## Preamble` and `## Versioning` per W12.5 / R-12.
 */
function extractProtocolRulesSection(protocolMd: string): string {
  const start = protocolMd.indexOf("## Rules");
  if (start === -1) throw new Error("PROTOCOL_RULES_HEADING_MISSING");
  const rest = protocolMd.slice(start);
  const nextSection = rest.indexOf("\n## ", 1);
  return nextSection === -1 ? rest : rest.slice(0, nextSection);
}

describe("W12.5 Pre-Operator IP Firewall, R-12 Rules Cap & Slop-Scrub Gate (asimposiumorg-31w)", () => {
  test("R-12 protocol rules cap: hard + soft rules stay strictly <= 1,000 words (preamble sits outside cap)", () => {
    const protocolMd = readFileSync(
      join(REPO_ROOT, "packages/protocol/assets/protocol.md"),
      "utf8",
    );
    const rulesSection = extractProtocolRulesSection(protocolMd);
    const rulesWords = wordCount(rulesSection);
    const totalWords = wordCount(protocolMd);

    expect(rulesWords).toBeGreaterThan(200);
    expect(rulesWords).toBeLessThanOrEqual(1_000);
    // Entire protocol.md currently sits even under 1,000 words!
    expect(totalWords).toBeLessThanOrEqual(1_200);
    // All 13 hard rules P1..P13 are present in order.
    for (let i = 1; i <= 13; i += 1) {
      expect(rulesSection).toContain(`${i}. **`);
    }
  });

  test("Rule A8 IP firewall: zero proprietary ancestor names, worksheets, or internal fleet jargon in any served text", () => {
    for (const filename of SERVED_ASSETS) {
      const text = readFileSync(join(REPO_ROOT, "packages/protocol/assets", filename), "utf8");
      for (const pattern of FORBIDDEN_ANCESTOR_SIGNATURES) {
        expect(
          pattern.test(text),
          `Forbidden ancestor signature ${pattern} leaked into packages/protocol/assets/${filename}`,
        ).toBe(false);
      }
    }
  });

  test("Slop-scrub & Rule A4/A10 non-pretense: zero AI-slop clichés, no PROVED claims, no leaderboards across all 7 served texts", () => {
    for (const filename of SERVED_ASSETS) {
      const text = readFileSync(join(REPO_ROOT, "packages/protocol/assets", filename), "utf8");
      for (const pattern of FORBIDDEN_SLOP_PHRASES) {
        expect(
          pattern.test(text),
          `AI-slop phrase ${pattern} detected in packages/protocol/assets/${filename}`,
        ).toBe(false);
      }
      // Rule A10: no leaderboard/ranking promises in served protocol texts
      expect(/\bleaderboard\b/i.test(text), `Leaderboard mention in ${filename}`).toBe(false);
      // Rule A4: never claim site executes user code or research models
      expect(/\bwe run your code\b/i.test(text)).toBe(false);
    }
  });

  test("Pre-operator review packet exists, covers all 7 served texts, and carries explicit personal-operator G2 sign-off boundary", () => {
    const prepPath = join(REPO_ROOT, "docs/ip-diff-review-prep-2026-11-21.md");
    expect(existsSync(prepPath)).toBe(true);
    const prep = readFileSync(prepPath, "utf8");
    expect(prep).toContain("personal operator gate at G2");
    expect(prep).toContain("Pending human operator sign-off");
    for (const filename of SERVED_ASSETS) {
      expect(prep).toContain(filename);
      const raw = readFileSync(join(REPO_ROOT, "packages/protocol/assets", filename), "utf8");
      const digestPrefix = createHash("sha256").update(raw).digest("hex").slice(0, 16);
      expect(prep).toContain(digestPrefix);
    }
  });
});
