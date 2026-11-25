import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import {
  CLAIM_DISPOSITIONS,
  CLAIM_REVIEW_STATES,
  ClaimKindSchema,
  CONTRACT_PROBLEM_CODES,
  EvidenceRequestSchema,
  EvidenceResponseSchema,
  LEDGER_OBJECT_KINDS,
  OPAQUE_PROBLEM_CODES,
  PackProfileSchema,
  PublicClaimStateSchema,
  STALE_ROUTE_STATES,
  WorkshopPushTypeSchema,
} from "../../src/index.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const MANIFEST_PATH = resolve(import.meta.dir, "../../ontology-consumers.json");

type EntryStatus = "active" | "tier-2-deferred" | "retire-candidate";

interface OntologyConsumerEntry {
  readonly value: string;
  readonly producer: string | null;
  readonly consumer: string | null;
  readonly decision_changed: string;
  readonly status: EntryStatus;
  readonly transparency_class?: "contract-teaching" | "opaque-policy-or-auth";
  readonly fable_section_6_1?: boolean;
  readonly note?: string;
}

interface OntologyConsumerManifest {
  readonly manifest_version: string;
  readonly fable_reference: string;
  readonly audited_at: string;
  readonly fable_alignment_audit: {
    readonly claim_kinds_fable_6_1_count: number;
    readonly claim_kinds_exported_count: number;
    readonly claim_kinds_appendix_b_retire_candidates: readonly string[];
    readonly unproduced_problem_codes_count: number;
    readonly unproduced_problem_codes: readonly string[];
    readonly summary: string;
  };
  readonly categories: Readonly<Record<string, readonly OntologyConsumerEntry[]>>;
}

interface LiveOntologyEnums {
  readonly claim_kinds: readonly string[];
  readonly workshop_object_kinds: readonly string[];
  readonly ledger_object_kinds: readonly string[];
  readonly dispositions: readonly string[];
  readonly review_states: readonly string[];
  readonly stale_route_states: readonly string[];
  readonly directive_disclosure_facets: readonly string[];
  readonly novelty_facets: readonly string[];
  readonly evidence_classes: readonly string[];
  readonly evidence_kinds: readonly string[];
  readonly evidence_directions: readonly string[];
  readonly evidence_modes: readonly string[];
  readonly pack_profiles: readonly string[];
  readonly problem_codes: readonly string[];
}

/**
 * Grandfathered non-active schema entries identified during the W1 Ontology
 * Consumer Audit (Fable Rev 3.1 §17.2 / Rule A10 / R-22).
 *
 * This set may ONLY shrink over time as candidates are retired or promoted to
 * live runtime consumers. Adding a NEW unconsumed/ceremonial entry to
 * `@asimposium/contracts` fails CI immediately.
 */
const GRANDFATHERED_NON_ACTIVE: Readonly<Record<string, ReadonlySet<string>>> = {
  claim_kinds: new Set(["theorem", "computation", "counterexample", "observation"]),
  problem_codes: new Set([
    "SESSION_CLOSE_ACTIONS_UNAVAILABLE",
    "BATCH_ATOMICITY_UNAVAILABLE",
    "NEGATIVE_KNOWLEDGE_PERMANENT",
    "QUESTION_NOT_LEASED",
    "CONFLICT_NORMALIZATION_REQUIRED",
  ]),
};

function liveOntologyEnums(): LiveOntologyEnums {
  return {
    claim_kinds: ClaimKindSchema.options,
    workshop_object_kinds: WorkshopPushTypeSchema.options,
    ledger_object_kinds: LEDGER_OBJECT_KINDS,
    dispositions: CLAIM_DISPOSITIONS,
    review_states: CLAIM_REVIEW_STATES,
    stale_route_states: STALE_ROUTE_STATES,
    directive_disclosure_facets:
      PublicClaimStateSchema.shape.directive_disclosure.removeDefault().options,
    novelty_facets: PublicClaimStateSchema.shape.novelty.unwrap().options,
    evidence_classes: EvidenceResponseSchema.shape.computed_class.options,
    evidence_kinds: EvidenceRequestSchema.options[0].shape.kind.options,
    evidence_directions: EvidenceRequestSchema.options[0].shape.direction.options,
    evidence_modes: EvidenceRequestSchema.options[0].shape.mode.options,
    pack_profiles: PackProfileSchema.options,
    problem_codes: [...CONTRACT_PROBLEM_CODES, ...OPAQUE_PROBLEM_CODES],
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function symbolExistsInSource(source: string, filePath: string, symbol: string): boolean {
  const escaped = escapeRegex(symbol);
  if (filePath.endsWith(".rs")) {
    const rustRe = new RegExp(
      `(?:^|\\n)\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?(?:fn|struct|enum|const|type|trait)\\s+${escaped}\\b`,
    );
    return rustRe.test(source);
  }
  const tsRe = new RegExp(
    `(?:^|\\n)\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|const|let|class|interface|type|enum)\\s+${escaped}\\b`,
  );
  return tsRe.test(source);
}

/**
 * Extract top-level TypeScript/JavaScript symbol declaration spans from a file
 * and return the 2-hop same-file call/reference closure starting at `symbol`.
 * This isolates the exact declared consumer (plus any private helpers or tables
 * it directly invokes in the same module) so an unrelated symbol in the repo —
 * or even a different function in the same file — cannot satisfy observation.
 */
function buildTsDeclarationMap(source: string, filePath: string): Map<string, string> {
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const map = new Map<string, string>();
  for (const stmt of sf.statements) {
    if (
      (ts.isFunctionDeclaration(stmt) ||
        ts.isClassDeclaration(stmt) ||
        ts.isInterfaceDeclaration(stmt) ||
        ts.isTypeAliasDeclaration(stmt) ||
        ts.isEnumDeclaration(stmt)) &&
      stmt.name
    ) {
      map.set(stmt.name.text, source.slice(stmt.getStart(sf), stmt.getEnd()));
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          map.set(decl.name.text, source.slice(decl.getStart(sf), decl.getEnd()));
        }
      }
    }
  }
  return map;
}

function extractRustSymbolSpan(source: string, symbol: string): string {
  const escaped = escapeRegex(symbol);
  const re = new RegExp(
    `(?:^|\\n)\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?(?:fn|struct|enum|const|type|trait)\\s+${escaped}\\b`,
  );
  const match = re.exec(source);
  if (!match) return "";
  const start = match.index;
  const braceStart = source.indexOf("{", start);
  if (braceStart === -1) return source.slice(start, start + 512);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return source.slice(start);
}

const STRICT_LITERAL_CATEGORIES = new Set<keyof LiveOntologyEnums>([
  "dispositions",
  "review_states",
  "stale_route_states",
  "directive_disclosure_facets",
  "evidence_classes",
  "evidence_directions",
  "evidence_modes",
]);

const LEDGER_OBJECT_DOMAIN_STEMS: Readonly<Record<string, readonly RegExp[]>> = {
  claim: [/\bclaims?\b/i],
  hypothesis: [/\bhypothes(?:is|es)\b/i],
  evidence: [/\bevidence\b/i],
  review: [/\breviews?\b/i],
  "proof-gap": [/\bproof_gaps?\b/i, /\bProofGap/],
  conflict: [/\bconflicts?\b/i],
  "dead-end": [/\bdead_ends?\b/i, /\bDeadEnd/],
  citation: [/\bcitations?\b/i],
  question: [/\bquestions?\b/i],
  synthesis: [/\bsynthes(?:is|es)\b/i],
  retraction: [/\bretract(?:ion|ed)?\b/i],
  relation: [/\brelations?\b/i],
  commentary: [/\bcommentar(?:y|ies)\b/i],
  "statement-review": [/\bstatement[-_]reviews?\b/i, /\bStatementReview/],
  "result-review": [/\bresult[-_]reviews?\b/i, /\bResultReview/],
  "problem-resolution": [/\bproblem[-_]resolution\b/i, /\bResolution/],
};

function hasLiteralOrPropertyKey(closure: string, value: string): boolean {
  const escaped = escapeRegex(value);
  const quoted = new RegExp(`["'\`]${escaped}["'\`]`);
  if (quoted.test(closure)) return true;
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    const propKey = new RegExp(`(?:^|[{,\\s])${escaped}\\s*:`);
    if (propKey.test(closure)) return true;
  }
  return false;
}

function symbolObservesOntologyMember(
  category: keyof LiveOntologyEnums,
  value: string,
  relPath: string,
  symbol: string,
  closure: string,
): boolean {
  if (closure.trim().length === 0) return false;
  // Direct exact literal or unquoted property key match in the symbol's AST closure.
  if (hasLiteralOrPropertyKey(closure, value)) return true;

  // Categories where EVERY active consumer MUST branch on or name the exact value.
  if (STRICT_LITERAL_CATEGORIES.has(category)) {
    return false;
  }

  switch (category) {
    case "claim_kinds":
      // Generic claim-kind renderers/aggregators must read claim.kind / ClaimKind directly.
      return /\bClaimKind\b|\bclaim_kind\b|\bclaim\.kind\b/.test(closure);
    case "workshop_object_kinds":
      return value === "note" && /\b(?:assessNoteIntent|NoteIntent)\b/.test(closure);
    case "ledger_object_kinds": {
      const stems = LEDGER_OBJECT_DOMAIN_STEMS[value];
      return stems?.some((re) => re.test(closure)) ?? false;
    }
    case "novelty_facets":
      return /\bnovelty\b/.test(closure) && hasLiteralOrPropertyKey(closure, value);
    case "evidence_kinds":
      return (
        /\bEvidenceKind\b/.test(closure) ||
        /\bevidence\.kind\b/.test(closure) ||
        (/\bHypothesisEvidenceItemResponse\b/.test(closure) && /\bcontent\.kind\b/.test(closure))
      );
    case "pack_profiles":
      if (value === "literature") {
        return /\bLITERATURE_PACK_NOTICE\b/.test(closure) || /literature:/.test(closure);
      }
      if (relPath === "cli/src/session_reads.rs" && symbol === "read_path") {
        return /append_pair\("profile",\s*profile\)/.test(closure);
      }
      return false;
    case "problem_codes":
      // Generic RFC 7807 envelope validators consume ProblemDocumentSchema / ProblemEnvelope.
      return /\b(?:ProblemDocumentSchema|ProblemEnvelope|problemEnvelope|ProblemCode)\b/.test(
        closure,
      );
    default:
      return false;
  }
}

/**
 * Pure audit validator used by both the live CI drift gate and planted
 * should-fail controls. Returns a list of machine-readable violations (empty
 * iff 100% of exported ontology entries are accounted for and bound to live
 * repo symbols).
 */
export function validateOntologyConsumerManifest(
  manifest: OntologyConsumerManifest,
  liveEnums: LiveOntologyEnums,
  repoRoot: string,
): readonly string[] {
  const errors: string[] = [];
  const fileCache = new Map<string, string>();
  const declMapCache = new Map<string, Map<string, string>>();
  const readCached = (relPath: string): string | null => {
    const existing = fileCache.get(relPath);
    if (existing !== undefined) return existing;
    const abs = resolve(repoRoot, relPath);
    if (!existsSync(abs)) return null;
    const text = readFileSync(abs, "utf8");
    fileCache.set(relPath, text);
    return text;
  };
  const extractSymbolClosure = (relPath: string, symbol: string, source: string): string => {
    if (relPath.endsWith(".rs")) return extractRustSymbolSpan(source, symbol);
    let decls = declMapCache.get(relPath);
    if (decls === undefined) {
      decls = buildTsDeclarationMap(source, relPath);
      declMapCache.set(relPath, decls);
    }
    const visited = new Set<string>();
    const parts: string[] = [];
    const expand = (name: string, depth: number) => {
      if (visited.has(name) || depth > 2) return;
      const body = decls?.get(name);
      if (body === undefined) return;
      visited.add(name);
      parts.push(body);
      for (const candidate of decls?.keys() ?? []) {
        if (!visited.has(candidate) && new RegExp(`\\b${escapeRegex(candidate)}\\b`).test(body)) {
          expand(candidate, depth + 1);
        }
      }
    };
    expand(symbol, 0);
    return parts.join("\n");
  };

  const validStatuses = new Set<EntryStatus>(["active", "tier-2-deferred", "retire-candidate"]);
  const allowedProducerPrefixes = ["apps/wire/src/", "packages/contracts/src/"];
  const allowedConsumerPrefixes = [
    "apps/wire/src/",
    "apps/web/",
    "packages/render/src/",
    "e2e/gauntlet/",
    "cli/src/",
  ];

  const verifyBinding = (
    binding: string,
    role: "producer" | "consumer",
    category: string,
    value: string,
  ): string | null => {
    const colon = binding.indexOf(":");
    if (colon <= 0 || colon === binding.length - 1) {
      errors.push(`INVALID_BINDING:${category}:${value}:${role}:${binding}`);
      return null;
    }
    const relPath = binding.slice(0, colon);
    const symbol = binding.slice(colon + 1);
    const prefixes = role === "producer" ? allowedProducerPrefixes : allowedConsumerPrefixes;
    if (!prefixes.some((prefix) => relPath.startsWith(prefix))) {
      errors.push(`DISALLOWED_BINDING_ROOT:${category}:${value}:${role}:${relPath}`);
      return null;
    }
    const source = readCached(relPath);
    if (source === null) {
      errors.push(`FILE_NOT_FOUND:${category}:${value}:${role}:${relPath}`);
      return null;
    }
    if (!symbolExistsInSource(source, relPath, symbol)) {
      errors.push(`SYMBOL_NOT_FOUND:${category}:${value}:${role}:${binding}`);
      return null;
    }
    return source;
  };

  for (const [category, liveValues] of Object.entries(liveEnums) as [
    keyof LiveOntologyEnums,
    readonly string[],
  ][]) {
    const entries = manifest.categories[category];
    if (!Array.isArray(entries)) {
      errors.push(`MISSING_CATEGORY:${category} (Rule A10 / R-22)`);
      continue;
    }

    const byValue = new Map<string, OntologyConsumerEntry>();
    for (const entry of entries) {
      if (byValue.has(entry.value)) {
        errors.push(`DUPLICATE_MANIFEST_ENTRY:${category}:${entry.value}`);
        continue;
      }
      byValue.set(entry.value, entry);

      if (!validStatuses.has(entry.status)) {
        errors.push(`INVALID_STATUS:${category}:${entry.value}:${String(entry.status)}`);
      }
      if (typeof entry.decision_changed !== "string" || entry.decision_changed.trim().length < 15) {
        errors.push(`DECISION_CHANGED_EMPTY:${category}:${entry.value} (Rule A10)`);
      }

      if (entry.status === "active") {
        if (entry.producer === null) {
          errors.push(`ACTIVE_MISSING_PRODUCER:${category}:${entry.value} (Rule A10 / R-22)`);
        } else {
          const producerSource = verifyBinding(entry.producer, "producer", category, entry.value);
          // For active RFC 7807 error codes, prove the producer file actually emits the code literal!
          if (
            category === "problem_codes" &&
            producerSource !== null &&
            !producerSource.includes(`"${entry.value}"`) &&
            !producerSource.includes(`'${entry.value}'`) &&
            !producerSource.includes(`\`${entry.value}\``)
          ) {
            errors.push(
              `PRODUCER_DOES_NOT_EMIT_CODE:${category}:${entry.value}:${entry.producer} (Rule A10 / R-22)`,
            );
          }
        }
        if (entry.consumer === null) {
          errors.push(`ACTIVE_MISSING_CONSUMER:${category}:${entry.value} (Rule A10 / R-22)`);
        } else {
          const consumerSource = verifyBinding(entry.consumer, "consumer", category, entry.value);
          if (consumerSource !== null) {
            const colon = entry.consumer.indexOf(":");
            const relPath = entry.consumer.slice(0, colon);
            const symbol = entry.consumer.slice(colon + 1);
            const closure = extractSymbolClosure(relPath, symbol, consumerSource);
            if (!symbolObservesOntologyMember(category, entry.value, relPath, symbol, closure)) {
              errors.push(
                `CONSUMER_DOES_NOT_OBSERVE_MEMBER:${category}:${entry.value}:${entry.consumer} (Rule A10 / R-22)`,
              );
            }
          }
        }
      } else {
        const allowed = GRANDFATHERED_NON_ACTIVE[category];
        if (!allowed?.has(entry.value)) {
          errors.push(
            `NEW_UNCONSUMED_SCHEMA_CEREMONY:${category}:${entry.value}:${entry.status} (Rule A10 / R-22)`,
          );
        }
        if (entry.producer !== null)
          verifyBinding(entry.producer, "producer", category, entry.value);
        if (entry.consumer !== null)
          verifyBinding(entry.consumer, "consumer", category, entry.value);
      }
    }

    for (const value of liveValues) {
      if (!byValue.has(value)) {
        errors.push(`UNAUDITED_ONTOLOGY_ENTRY:${category}:${value} (Rule A10 / R-22)`);
      }
    }
    const liveSet = new Set(liveValues);
    for (const value of byValue.keys()) {
      if (!liveSet.has(value)) {
        errors.push(`STALE_MANIFEST_ENTRY:${category}:${value}`);
      }
    }
  }

  return errors;
}

describe("W1 Ontology Consumer Audit (Fable Rev 3.1 §17.2 / Rule A10 / R-22)", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as OntologyConsumerManifest;
  const liveEnums = liveOntologyEnums();

  test("POSITIVE: 100% of exported ontology kinds, dispositions, facets, evidence classes, pack profiles, and error codes resolve to live repo symbols", () => {
    const errors = validateOntologyConsumerManifest(manifest, liveEnums, REPO_ROOT);
    expect(errors).toEqual([]);

    // Confirm Fable §6.1 alignment audit counts match reality.
    expect(manifest.fable_alignment_audit.claim_kinds_fable_6_1_count).toBe(12);
    expect(manifest.fable_alignment_audit.claim_kinds_exported_count).toBe(
      liveEnums.claim_kinds.length,
    );
    expect(manifest.categories.pack_profiles).toHaveLength(12);
    expect(manifest.categories.problem_codes).toHaveLength(
      CONTRACT_PROBLEM_CODES.length + OPAQUE_PROBLEM_CODES.length,
    );
  });

  test("SHOULD-FAIL CONTROL 1: adding a dummy unused RFC 7807 error code fails closed citing Rule A10 / R-22", () => {
    const mutated: LiveOntologyEnums = {
      ...liveEnums,
      problem_codes: [...liveEnums.problem_codes, "CEREMONIAL_UNUSED_ERROR_CODE"],
    };
    const errors = validateOntologyConsumerManifest(manifest, mutated, REPO_ROOT);
    expect(errors).toEqual([
      "UNAUDITED_ONTOLOGY_ENTRY:problem_codes:CEREMONIAL_UNUSED_ERROR_CODE (Rule A10 / R-22)",
    ]);
  });

  test("SHOULD-FAIL CONTROL 2: adding a dummy unused claim kind fails closed citing Rule A10 / R-22", () => {
    const mutated: LiveOntologyEnums = {
      ...liveEnums,
      claim_kinds: [...liveEnums.claim_kinds, "ceremonial-claim-kind"],
    };
    const errors = validateOntologyConsumerManifest(manifest, mutated, REPO_ROOT);
    expect(errors).toEqual([
      "UNAUDITED_ONTOLOGY_ENTRY:claim_kinds:ceremonial-claim-kind (Rule A10 / R-22)",
    ]);
  });

  test("SHOULD-FAIL CONTROL 3: pointing a binding at a non-existent symbol fails closed with SYMBOL_NOT_FOUND", () => {
    const mutated: OntologyConsumerManifest = {
      ...manifest,
      categories: {
        ...manifest.categories,
        pack_profiles: (manifest.categories.pack_profiles ?? []).map((entry) =>
          entry.value === "working"
            ? { ...entry, consumer: "cli/src/session_reads.rs:definitely_missing_symbol" }
            : entry,
        ),
      },
    };
    const errors = validateOntologyConsumerManifest(mutated, liveEnums, REPO_ROOT);
    expect(errors).toContain(
      "SYMBOL_NOT_FOUND:pack_profiles:working:consumer:cli/src/session_reads.rs:definitely_missing_symbol",
    );
  });

  test("SHOULD-FAIL CONTROL 4: pointing an active problem code at a real producer file that does not emit that code fails closed", () => {
    const mutated: OntologyConsumerManifest = {
      ...manifest,
      categories: {
        ...manifest.categories,
        problem_codes: (manifest.categories.problem_codes ?? []).map((entry) =>
          entry.value === "MISSING_FALSIFIER"
            ? { ...entry, producer: "apps/wire/src/http/envelope.ts:problem" }
            : entry,
        ),
      },
    };
    const errors = validateOntologyConsumerManifest(mutated, liveEnums, REPO_ROOT);
    expect(errors).toContain(
      "PRODUCER_DOES_NOT_EMIT_CODE:problem_codes:MISSING_FALSIFIER:apps/wire/src/http/envelope.ts:problem (Rule A10 / R-22)",
    );
  });

  test("SHOULD-FAIL CONTROL 5: sneaking a brand-new retire-candidate or tier-2-deferred entry past the audit fails closed", () => {
    const mutatedEnums: LiveOntologyEnums = {
      ...liveEnums,
      pack_profiles: [...liveEnums.pack_profiles, "ceremonial-profile"],
    };
    const mutatedManifest: OntologyConsumerManifest = {
      ...manifest,
      categories: {
        ...manifest.categories,
        pack_profiles: [
          ...(manifest.categories.pack_profiles ?? []),
          {
            value: "ceremonial-profile",
            producer: null,
            consumer: null,
            decision_changed: "Unconsumed ceremonial pack profile added without a live consumer.",
            status: "retire-candidate",
          },
        ],
      },
    };
    const errors = validateOntologyConsumerManifest(mutatedManifest, mutatedEnums, REPO_ROOT);
    expect(errors).toContain(
      "NEW_UNCONSUMED_SCHEMA_CEREMONY:pack_profiles:ceremonial-profile:retire-candidate (Rule A10 / R-22)",
    );
  });

  test("SHOULD-FAIL CONTROL 6: exact 83c75754 unrelated-consumer plant (EnrollmentService for definition) fails closed", () => {
    const mutated: OntologyConsumerManifest = {
      ...manifest,
      categories: {
        ...manifest.categories,
        claim_kinds: (manifest.categories.claim_kinds ?? []).map((entry) =>
          entry.value === "definition"
            ? { ...entry, consumer: "apps/wire/src/enrollment/service.ts:EnrollmentService" }
            : entry,
        ),
      },
    };
    const errors = validateOntologyConsumerManifest(mutated, liveEnums, REPO_ROOT);
    expect(errors).toContain(
      "CONSUMER_DOES_NOT_OBSERVE_MEMBER:claim_kinds:definition:apps/wire/src/enrollment/service.ts:EnrollmentService (Rule A10 / R-22)",
    );
  });

  test("SHOULD-FAIL CONTROL 7: wrong function in the right module (rankReviewQueue instead of reviewNeed for dispositions.open) fails closed", () => {
    const mutated: OntologyConsumerManifest = {
      ...manifest,
      categories: {
        ...manifest.categories,
        dispositions: (manifest.categories.dispositions ?? []).map((entry) =>
          entry.value === "open"
            ? {
                ...entry,
                consumer: "apps/wire/src/discovery/review-queue-selection.ts:rankReviewQueue",
              }
            : entry,
        ),
      },
    };
    const errors = validateOntologyConsumerManifest(mutated, liveEnums, REPO_ROOT);
    expect(errors).toContain(
      "CONSUMER_DOES_NOT_OBSERVE_MEMBER:dispositions:open:apps/wire/src/discovery/review-queue-selection.ts:rankReviewQueue (Rule A10 / R-22)",
    );
  });

  test("SHOULD-FAIL CONTROL 8: unrelated consumer bound to an active RFC 7807 problem code fails closed", () => {
    const mutated: OntologyConsumerManifest = {
      ...manifest,
      categories: {
        ...manifest.categories,
        problem_codes: (manifest.categories.problem_codes ?? []).map((entry) =>
          entry.value === "MISSING_FALSIFIER"
            ? { ...entry, consumer: "apps/wire/src/enrollment/service.ts:EnrollmentService" }
            : entry,
        ),
      },
    };
    const errors = validateOntologyConsumerManifest(mutated, liveEnums, REPO_ROOT);
    expect(errors).toContain(
      "CONSUMER_DOES_NOT_OBSERVE_MEMBER:problem_codes:MISSING_FALSIFIER:apps/wire/src/enrollment/service.ts:EnrollmentService (Rule A10 / R-22)",
    );
  });
});
