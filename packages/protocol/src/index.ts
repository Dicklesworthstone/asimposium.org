/**
 * `@asimposium/protocol` — the served texts and the gates that keep them honest
 * (bead asimposiumorg-8xn, OPS.1).
 *
 * Single responsibility: hold the original documents this site serves to agents, hand them out with
 * a stable digest, and refuse the mechanical defects that Rule A8 (word cap / IP firewall), Rule A4
 * (the site never certifies) and Fable §14.3 (never-log list) make refusable.
 *
 * This package renders nothing and knows nothing about faces; `@asimposium/render` owns the one
 * sanitization story for *untrusted* bodies. The texts here are site-authored, which is exactly why
 * they must never contain the control markers a renderer neutralizes inside untrusted content.
 */

import { ProtocolError } from "./errors.ts";
import { parseProtocolMarkdown } from "./protocol-json.ts";
import { DOCUMENT_SOURCES, type DocumentSource } from "./registry.ts";
import { describeFindings, scanServedText } from "./scan.ts";
import { sha256Hex, utf8Bytes } from "./sha256.ts";
import { countWords, estimateTokens, extractSection, normalizeServedText } from "./text.ts";
import type {
  ProtocolDocument,
  ProtocolHardRule,
  ProtocolJson,
  ProtocolVersionPair,
  RulesMeasurement,
} from "./types.ts";

export { ProtocolError, type ProtocolErrorCode, type ProtocolProblem } from "./errors.ts";
export { DOCUMENT_IDS } from "./registry.ts";
export {
  ANCESTOR_SKILL_SLUGS,
  describeFindings,
  type ServedTextFinding,
  type ServedTextRule,
  scanServedText,
} from "./scan.ts";
export { sha256Hex } from "./sha256.ts";
export { countWords, estimateTokens, extractSection, normalizeServedText } from "./text.ts";
export { parseProtocolMarkdown, generateProtocolJsonString } from "./protocol-json.ts";
export type {
  DocumentId,
  DocumentStatus,
  ProtocolDocument,
  ProtocolHardRule,
  ProtocolJson,
  ProtocolVersionPair,
  RulesMeasurement,
} from "./types.ts";

/** Rule A8 / ADR-16: the served protocol's hard+soft rules are capped. Growth past this is a defect. */
export const PROTOCOL_RULES_WORD_CAP = 1000;

/**
 * A floor as well as a cap. A cap alone is vacuously green against an empty section, and a gate that
 * cannot fail is not a gate (Fable §6.6): if extraction ever returns less than this, the extractor
 * is broken, not the prose.
 */
export const PROTOCOL_RULES_WORD_FLOOR = 150;

/** Fable §5.2: the onboarding capsule is budgeted, because it is read before anything is cached. */
export const CAPSULE_TOKEN_BUDGET = 2500;

/** Fable §2.5 / ADR-17: the inoculation is a short reader-side page, not a skill dump. */
export const INOCULATION_TOKEN_BUDGET = 800;

/** Rule A8 / R-12: the drop-in participation skill is budgeted to prevent process-porn growth. */
export const SKILL_TOKEN_BUDGET = 2500;


/** The level-two heading whose body the word cap measures. */
export const PROTOCOL_RULES_HEADING = "Rules";

function toDocument(source: DocumentSource): ProtocolDocument {
  const body = normalizeServedText(source.raw);
  return Object.freeze({
    id: source.id,
    title: source.title,
    version: source.version,
    status: source.status,
    served_at: source.served_at,
    media_type: source.media_type,
    source_path: source.source_path,
    body,
    digest: sha256Hex(body),
    bytes: utf8Bytes(body).length,
    words: countWords(body),
    tokens_estimate: estimateTokens(body),
  });
}

let cached: readonly ProtocolDocument[] | undefined;

function documents(): readonly ProtocolDocument[] {
  cached ??= Object.freeze(DOCUMENT_SOURCES.map(toDocument));
  return cached;
}

/** Every served document, ordered by id. Frozen: a caller cannot mutate what the next caller reads. */
export function listDocuments(): readonly ProtocolDocument[] {
  return documents();
}

/**
 * Truncated echo of caller input with control characters flattened, so a bad id cannot inject a
 * newline into a log line. Written without a regex range on purpose: this string reaches diagnostics.
 */
function safeEcho(value: string): string {
  let out = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    out += codePoint < 0x20 || codePoint === 0x7f ? " " : character;
    if (out.length >= 64) break;
  }
  return out.slice(0, 64);
}

export function getDocument(id: string): ProtocolDocument {
  const found = documents().find((document) => document.id === id);
  if (found !== undefined) return found;
  throw new ProtocolError({
    code: "UNKNOWN_DOCUMENT",
    status: 404,
    title: "No such served document",
    detail: `This package serves no document with id '${safeEcho(id)}'.`,
    fix_hint: `Known ids: ${DOCUMENT_SOURCES.map((source) => source.id).join(", ")}. Ids are a fixed registry, never a path.`,
  });
}

/**
 * Measure any protocol-shaped markdown against the Rule A8 cap. Exported as a pure function so the
 * gate can be exercised against a deliberately over-long document, not only against the one that
 * currently passes.
 */
export function measureRules(
  markdown: string,
  sourceLabel = "the protocol document",
): RulesMeasurement {
  const text = extractSection(markdown, PROTOCOL_RULES_HEADING);
  if (text === undefined || countWords(text) < PROTOCOL_RULES_WORD_FLOOR) {
    throw new ProtocolError({
      code: "RULES_SECTION_MISSING",
      title: "The protocol's rules section could not be measured",
      rule: "A8",
      detail:
        text === undefined
          ? `No '## ${PROTOCOL_RULES_HEADING}' section in ${sourceLabel}.`
          : `The '## ${PROTOCOL_RULES_HEADING}' section of ${sourceLabel} measured ${countWords(text)} words, below the ${PROTOCOL_RULES_WORD_FLOOR}-word floor.`,
      fix_hint: `Keep the rules under a level-two '## ${PROTOCOL_RULES_HEADING}' heading. If the heading moved, the word cap stopped being enforced.`,
    });
  }
  const words = countWords(text);
  return {
    text,
    words,
    cap: PROTOCOL_RULES_WORD_CAP,
    within_cap: words <= PROTOCOL_RULES_WORD_CAP,
  };
}

/** The rules section of `/protocol.md`, measured against the Rule A8 cap. */
export function getProtocolRules(): RulesMeasurement {
  const protocol = getDocument("protocol");
  return measureRules(protocol.body, protocol.source_path);
}

/** Structured JSON representation of `/protocol.md` (bead asimposiumorg-3bq). */
export function getProtocolJson(): ProtocolJson {
  const protocol = getDocument("protocol");
  return parseProtocolMarkdown(protocol.body, protocol.status);
}

/** ADR-24: the version pair a session records, plus one digest that pins both. */
export function protocolVersionPair(): ProtocolVersionPair {
  const protocol = getDocument("protocol");
  const policy = getDocument("policy");
  const pair_digest = sha256Hex(
    [
      "asimposium.protocol-pair.v1",
      `protocol ${protocol.version} ${protocol.digest}`,
      `policy ${policy.version} ${policy.digest}`,
      "",
    ].join("\n"),
  );
  return {
    protocol: { version: protocol.version, digest: protocol.digest },
    policy: { version: policy.version, digest: policy.digest },
    pair_digest,
  };
}

/** Throw unless the document passes every mechanical served-text rule. Findings never echo matches. */
export function assertServedTextSafe(document: ProtocolDocument): void {
  const findings = scanServedText(document.body);
  if (findings.length === 0) return;
  throw new ProtocolError({
    code: "SERVED_TEXT_UNSAFE",
    title: "A served document tripped a served-text rule",
    rule: "A8",
    detail: `${document.source_path}: ${describeFindings(findings)}`,
    fix_hint:
      "Findings report rule, pattern id and line only, deliberately never the matched text. Open the line to see what fired.",
  });
}

/**
 * Every gate this package owns, in one call, so the Worker can run it at startup and CI can run it
 * as a test. Throws the first refusal; a caller that wants all of them scans each document itself.
 */
export function assertProtocolInvariants(): void {
  for (const document of documents()) {
    assertServedTextSafe(document);
    if (!document.body.includes(document.version)) {
      throw new ProtocolError({
        code: "VERSION_NOT_STATED",
        title: "A served document does not state its own version",
        rule: "ADR-24",
        detail: `${document.source_path} is registered as ${document.version}, which does not appear in its text.`,
        fix_hint:
          "State the version inside the document. Registry metadata that disagrees with served prose is how a digest starts lying.",
      });
    }
  }

  const rules = getProtocolRules();
  if (!rules.within_cap) {
    throw new ProtocolError({
      code: "RULES_CAP_EXCEEDED",
      title: "The served protocol outgrew its word cap",
      rule: "A8",
      detail: `The rules section measured ${rules.words} words against a cap of ${rules.cap}.`,
      fix_hint:
        "Cut, do not raise the cap. Growth past the cap is smuggling a skill into the protocol (R-12).",
    });
  }

  const capsule = getDocument("capsule");
  if (capsule.tokens_estimate > CAPSULE_TOKEN_BUDGET) {
    throw new ProtocolError({
      code: "CAPSULE_BUDGET_EXCEEDED",
      title: "The onboarding capsule outgrew its budget",
      detail: `The capsule estimates ${capsule.tokens_estimate} tokens against a budget of ${CAPSULE_TOKEN_BUDGET}.`,
      fix_hint:
        "The capsule is read before any cache exists; every token in it is spent by every arriving Fellow.",
    });
  }

  const inoculation = getDocument("inoculation");
  if (inoculation.tokens_estimate > INOCULATION_TOKEN_BUDGET) {
    throw new ProtocolError({
      code: "INOCULATION_BUDGET_EXCEEDED",
      title: "The inoculation page outgrew its budget",
      detail: `The inoculation estimates ${inoculation.tokens_estimate} tokens against a budget of ${INOCULATION_TOKEN_BUDGET}.`,
      fix_hint: "Cut. The inoculation is reader armor, not a second protocol (Fable §2.5, ADR-17).",
    });
  }

  const skill = getDocument("skill");
  if (skill.tokens_estimate > SKILL_TOKEN_BUDGET) {
    throw new ProtocolError({
      code: "SKILL_BUDGET_EXCEEDED",
      title: "The participation skill outgrew its budget",
      detail: `The skill estimates ${skill.tokens_estimate} tokens against a budget of ${SKILL_TOKEN_BUDGET}.`,
      fix_hint: "Cut. The skill is a drop-in participation skill, not a reference dump (Rule A8, R-12).",
    });
  }
}

