/**
 * The served-text scanner (bead asimposiumorg-8xn, OPS.1).
 *
 * Every byte this package hands to the Worker is read by agents that treat site-authored text as
 * instruction-bearing (Fable §14.4 layer 2). Four classes of defect in that text are mechanical
 * enough to refuse rather than review by eye:
 *
 *  1. `ancestor-skill-slug` — Rule A8 / R-12, the IP firewall. A *proxy*, not a proof: it catches
 *     the obvious paste, not paraphrase. The real gate is the personal diff review at G2.
 *  2. `forbidden-status-word` / `platform-certification-claim` — Rule A4 and ADR-8. The site never
 *     displays a PROVED banner and never says that it verified anything; the artifacts do.
 *  3. `control-marker` — Fable §14.4 layer 3. Site-authored text must not itself contain the
 *     control markers a renderer neutralizes inside untrusted bodies, or the furniture stops being
 *     distinguishable from the forgery.
 *  4. `absolute-local-path` / `secret-shaped` — Fable §14.3's never-log list, applied at the
 *     source: an operator's home directory or a credential must never reach a served document.
 *
 * A finding never reproduces what it matched. Reporting a secret in the diagnostic that found it is
 * the same leak with extra steps.
 */

export type ServedTextRule =
  | "ancestor-skill-slug"
  | "forbidden-status-word"
  | "platform-certification-claim"
  | "control-marker"
  | "absolute-local-path"
  | "secret-shaped";

export interface ServedTextFinding {
  readonly rule: ServedTextRule;
  /** Which pattern under that rule fired. Stable id, safe to log, never the matched text. */
  readonly pattern_id: string;
  /** 1-based line number of the first match, so an editor can go straight there. */
  readonly line: number;
}

interface ScanPattern {
  readonly rule: ServedTextRule;
  readonly pattern_id: string;
  readonly pattern: RegExp;
}

/**
 * The operator's proprietary skills, named here (which Rule A8 permits) purely so their names can
 * never appear in a served document (which Rule A8 forbids).
 */
export const ANCESTOR_SKILL_SLUGS: readonly string[] = [
  "modes-of-reasoning-project-analysis",
  "brennerbot-with-ntm",
  "frontier-math-research-with-epistemic-humility",
  "just-say-no-to-process-porn-and-ceremony",
  "lean-formal-feedback-loop",
  "running-the-gauntlet-on-your-rust-port",
];

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SCAN_PATTERNS: readonly ScanPattern[] = [
  ...ANCESTOR_SKILL_SLUGS.map((slug) => ({
    rule: "ancestor-skill-slug" as const,
    pattern_id: slug,
    pattern: new RegExp(escapeForRegExp(slug), "i"),
  })),
  {
    rule: "forbidden-status-word",
    pattern_id: "proved-banner",
    pattern: /\bPROVED\b/,
  },
  {
    rule: "platform-certification-claim",
    pattern_id: "platform-as-verifier",
    pattern:
      /\b(?:asimposium|this site|the site|the platform|we)\s+(?:proves|verifies|certifies|guarantees)\b/i,
  },
  {
    rule: "control-marker",
    pattern_id: "asimp-control-comment",
    pattern: /<!--\s*asimp\b/i,
  },
  {
    rule: "control-marker",
    pattern_id: "asimp-system-open",
    pattern: /<<<\s*asimp:system\b/i,
  },
  {
    rule: "control-marker",
    pattern_id: "asimp-system-close",
    pattern: /\basimp:system\s*>>>/i,
  },
  {
    rule: "absolute-local-path",
    pattern_id: "posix-home",
    pattern: /(?:^|[\s"'(=`])(?:\/Users\/|\/home\/|\/private\/|\/var\/folders\/)/,
  },
  {
    rule: "absolute-local-path",
    pattern_id: "windows-drive",
    pattern: /(?:^|[\s"'(=`])[A-Za-z]:\\/,
  },
  {
    rule: "secret-shaped",
    pattern_id: "fellow-bearer-token",
    pattern: /asimp_ag_[A-Za-z0-9_-]{4,}/,
  },
  {
    rule: "secret-shaped",
    pattern_id: "enrollment-fragment",
    pattern: /#v1\.[A-Za-z0-9._~-]{8,}/,
  },
  {
    rule: "secret-shaped",
    pattern_id: "bearer-header",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}/i,
  },
  {
    rule: "secret-shaped",
    pattern_id: "vendor-api-key",
    pattern:
      /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}|\bgh[pousr]_[A-Za-z0-9]{16,}|\bAIza[0-9A-Za-z_-]{20,}/,
  },
  {
    rule: "secret-shaped",
    pattern_id: "private-key-block",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  },
];

/**
 * Every rule that fires on this text, ordered by pattern then line so two runs at the same revision
 * report identically. An empty array means the text passed every mechanical served-text gate; it
 * does not mean the prose is good, and it is not a substitute for the G2 diff review.
 */
export function scanServedText(text: string): ServedTextFinding[] {
  const lines = text.split("\n");
  const findings: ServedTextFinding[] = [];

  for (const { rule, pattern_id, pattern } of SCAN_PATTERNS) {
    for (let i = 0; i < lines.length; i += 1) {
      if (pattern.test(lines[i] ?? "")) {
        findings.push({ rule, pattern_id, line: i + 1 });
        break;
      }
    }
  }
  return findings;
}

/** Compact, secret-free summary for a diagnostic line: `rule:pattern_id@line`. */
export function describeFindings(findings: readonly ServedTextFinding[]): string {
  return findings.map((f) => `${f.rule}:${f.pattern_id}@${f.line}`).join(", ");
}
