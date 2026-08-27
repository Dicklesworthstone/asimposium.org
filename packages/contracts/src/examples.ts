/**
 * Validated example embedding for generated schemas (bead asimposiumorg-zjs9,
 * child of asimposiumorg-goc / W1.4).
 *
 * `goc` promises "at least one minimal and one representative valid example
 * per kind" inside the published JSON Schema artifacts so curl-first agents
 * see real payloads, and "filled contract-error examples referenced by
 * fix_hints". The examples are NOT hand-written here: they are curated CORPUS
 * fixtures from test/fixtures/valid, assembled and validated at generation
 * time against the very Zod contract each example claims to represent. A
 * fixture that stops validating fails generation loudly instead of publishing
 * a lie.
 *
 * Bundled contract documents group many message types under one object, so
 * their builders place bodies under truthful member keys; composite arms
 * (screening) combine their published face pair into one whole that parses
 * against the union. Every produced value must pass its contract's
 * `safeParse`, or generation refuses outright.
 *
 * Deterministic by construction: fixed fixture lists per kind, synchronous
 * reads, no clock or randomness anywhere.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ZodTypeAny } from "zod";
import {
  EnrollmentClaimResponseSchema,
  MintEnrollmentRequestSchema,
} from "./enrollment.ts";
import { ProblemsIndexResponseSchema } from "./ledger.ts";
import { ProblemDocumentSchema } from "./problem.ts";
import { ScreeningContractsSchema } from "./screening.ts";
import {
  PromoteRequestSchema,
  SessionOpenRequestSchema,
} from "./sessions.ts";

const FIXTURES_DIR = join(import.meta.dir, "..", "test", "fixtures", "valid");

interface BuilderInput {
  readonly bodies: readonly unknown[];
}

interface ExampleSpec {
  readonly kind: string;
  /** Corpus files, loaded in order and handed to `build`. */
  readonly fixtures: readonly string[];
  /** Whole-value validator; builders that already .parse() members omit it. */
  readonly schema?: ZodTypeAny;
}

function fixture(file: string): string {
  return join(FIXTURES_DIR, file);
}

function parseFixture(path: string): unknown {
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`EXAMPLE_FIXTURE_UNPARSEABLE ${path}: ${String(error)}`);
  }
}

const SPECS: readonly ExampleSpec[] = Object.freeze([
  {
    kind: "enrollment",
    fixtures: ["enrollment.json", "enrollment-mint.json"],
    // Both messages are members of the bundled enrollment document; emitted
    // under their own keys because neither is a whole-bundle instance.
    build: ({ bodies }: BuilderInput): unknown => [
      { fellow_registration_request: bodies[0] },
      { mint_request: MintEnrollmentRequestSchema.parse(bodies[1]) },
    ],
  },
  {
    kind: "ledger",
    fixtures: ["ledger-problems-index.json"],
    schema: ProblemsIndexResponseSchema,
    build: ({ bodies }: BuilderInput): unknown => bodies[0],
  },
  {
    // The problem domain IS the contract-error family: teaching refusals are
    // valid ProblemDocuments, so embedding real refusal bodies fulfills the
    // fix_hint example promise directly.
    kind: "problem",
    fixtures: ["problem-missing-falsifier.json", "problem-unauthorized.json"],
    schema: ProblemDocumentSchema,
    build: ({ bodies }: BuilderInput): unknown => [...bodies],
  },
  {
    kind: "screening",
    fixtures: ["screening-public-action.json", "screening-operator-receipt.json"],
    schema: ScreeningContractsSchema,
    // One whole matched-contract example assembled from its two published
    // faces, so the union validates the assembled truth, not fragments.
    build: ({ bodies }: BuilderInput): unknown => ({
      public_action: bodies[0],
      operator_receipt: bodies[1],
    }),
  },
  {
    kind: "sessions",
    fixtures: ["session-open.json", "promote-request.json"],
    build: ({ bodies }: BuilderInput): unknown => [
      { session_open_request: SessionOpenRequestSchema.parse(bodies[0]) },
      { promote_request: PromoteRequestSchema.parse(bodies[1]) },
    ],
  },
]);

export interface EmbeddedDomainExamples {
  readonly kind: string;
  readonly examples: readonly unknown[];
}

export function embeddedExamplesFor(kind: string): EmbeddedDomainExamples {
  const spec = SPECS.find((candidate) => candidate.kind === kind);
  if (spec === undefined) {
    throw new Error(`EXAMPLES_NO_SPEC ${kind}`);
  }
  const bodies = spec.fixtures.map((file) => parseFixture(fixture(file)));
  const built = spec.build({ bodies });
  const asList = Array.isArray(built) ? built : [built];
  for (const candidate of asList) {
    if (spec.schema !== undefined) {
      const checked = spec.schema.safeParse(candidate);
      if (!checked.success) {
        throw new Error(
          `EXAMPLE_FIXTURE_INVALID kind=${kind}: ${checked.error.message}`,
        );
      }
    }
  }
  return { kind, examples: asList };
}
