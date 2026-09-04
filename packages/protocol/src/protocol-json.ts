import { sha256Hex } from "./sha256.ts";
import { extractSection, normalizeServedText } from "./text.ts";
import type { DocumentStatus, ProtocolHardRule, ProtocolJson } from "./types.ts";

/**
 * Parse the canonical protocol markdown into a structured JSON representation
 * (bead asimposiumorg-3bq).
 */
export function parseProtocolMarkdown(
  markdown: string,
  status: DocumentStatus = "draft",
): ProtocolJson {
  const normalized = normalizeServedText(markdown);
  const preamble = extractSection(normalized, "Preamble") ?? "";
  const rulesSection = extractSection(normalized, "Rules") ?? "";
  const versioning = extractSection(normalized, "Versioning") ?? "";

  // Extract version from header
  const versionMatch = /version\s+([0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9]+)?)/.exec(normalized);
  const version = versionMatch ? (versionMatch[1] ?? "0.1.0-draft") : "0.1.0-draft";

  // Parse hard and soft rules from the rules section
  const lines = rulesSection.split("\n");
  const hardRules: ProtocolHardRule[] = [];
  const softRules: string[] = [];

  let inHard = false;
  let inSoft = false;
  let currentHardRule: {
    id: number;
    code: string;
    number: number;
    title: string;
    ruleLines: string[];
  } | null = null;
  let currentSoftLines: string[] | null = null;

  for (const line of lines) {
    if (/^###\s+Hard rules/i.test(line)) {
      inHard = true;
      inSoft = false;
      continue;
    }
    if (/^###\s+Soft rules/i.test(line)) {
      if (currentHardRule) {
        hardRules.push({
          id: currentHardRule.id,
          code: currentHardRule.code,
          number: currentHardRule.number,
          title: currentHardRule.title,
          rule: currentHardRule.ruleLines.join(" ").trim(),
        });
        currentHardRule = null;
      }
      inHard = false;
      inSoft = true;
      continue;
    }
    if (/^##\s+/i.test(line) || /^###\s+/i.test(line)) {
      if (currentHardRule) {
        hardRules.push({
          id: currentHardRule.id,
          code: currentHardRule.code,
          number: currentHardRule.number,
          title: currentHardRule.title,
          rule: currentHardRule.ruleLines.join(" ").trim(),
        });
        currentHardRule = null;
      }
      if (currentSoftLines) {
        softRules.push(currentSoftLines.join(" ").trim());
        currentSoftLines = null;
      }
      inHard = false;
      inSoft = false;
      continue;
    }

    if (inHard) {
      const match = /^(\d+)\.\s+\*\*(.*?)\*\*\s*(.*)$/.exec(line);
      if (match?.[1] && match[2]) {
        if (currentHardRule) {
          hardRules.push({
            id: currentHardRule.id,
            code: currentHardRule.code,
            number: currentHardRule.number,
            title: currentHardRule.title,
            rule: currentHardRule.ruleLines.join(" ").trim(),
          });
        }
        const num = parseInt(match[1], 10);
        currentHardRule = {
          id: num,
          code: `P${num}`,
          number: num,
          title: match[2].trim(),
          ruleLines: match[3]?.trim() ? [match[3].trim()] : [],
        };
      } else if (currentHardRule && line.trim()) {
        currentHardRule.ruleLines.push(line.trim());
      }
    } else if (inSoft) {
      const match = /^-\s+(.*)$/.exec(line);
      if (match?.[1]) {
        if (currentSoftLines) {
          softRules.push(currentSoftLines.join(" ").trim());
        }
        currentSoftLines = [match[1].trim()];
      } else if (currentSoftLines && line.trim()) {
        currentSoftLines.push(line.trim());
      }
    }
  }

  if (currentHardRule) {
    hardRules.push({
      id: currentHardRule.id,
      code: currentHardRule.code,
      number: currentHardRule.number,
      title: currentHardRule.title,
      rule: currentHardRule.ruleLines.join(" ").trim(),
    });
  }
  if (currentSoftLines) {
    softRules.push(currentSoftLines.join(" ").trim());
  }

  return {
    title: "The Symposium Protocol",
    version,
    status,
    preamble: preamble.trim(),
    rules: {
      hard: hardRules,
      soft: softRules,
    },
    hard_rules: hardRules,
    soft_rules: softRules,
    versioning: versioning.trim(),
    digest: sha256Hex(normalized),
  };
}

export function generateProtocolJsonString(markdown: string): string {
  const json = parseProtocolMarkdown(markdown);
  return `${JSON.stringify(json, null, 2)}\n`;
}
