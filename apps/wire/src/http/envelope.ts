/**
 * Response envelopes for the Stoa surface (Fable §7.7).
 *
 * Two shapes, one JSON serialiser, deterministic key order:
 *   success  -> {schema, ok, data, degraded[], next_actions[]}
 *   failure  -> RFC 7807 problem+json extended with {code, rule?, fix_hint, ...}
 *
 * Bodies carry no timestamps and no randomness, so the same input produces
 * byte-identical output (Fable §7.1 axiom 7: determinism is cache money).
 */
import {
  type ProblemCode,
  type ProblemDocument,
  ProblemDocumentSchema,
  type ProblemRule,
} from "@asimposium/contracts";

export const SCHEMA_BASE = "https://a.asimposium.org/schemas";
export const ERROR_BASE = "https://asimposium.org/errors";

export interface NextAction {
  method: string;
  url: string;
  why: string;
}

export interface SuccessEnvelope<T> {
  schema: string;
  ok: true;
  data: T;
  degraded: string[];
  next_actions: NextAction[];
}

export interface ProblemEnvelope {
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
  fix_hint: string;
  rule?: string;
  [extension: string]: unknown;
}

export interface SuccessInput<T> {
  schema: string;
  data: T;
  degraded?: string[];
  nextActions?: NextAction[];
  status?: number;
  headers?: Record<string, string>;
}

export interface ProblemInput {
  status: number;
  code: string;
  title: string;
  detail: string;
  fixHint: string;
  rule?: string;
  /** Extra machine-readable fields (allowed lists, binding names, …). */
  extensions?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface ValidatedProblemInput extends Omit<ProblemInput, "code" | "rule"> {
  code: ProblemCode;
  rule?: ProblemRule;
}

const jsonBody = (value: unknown): string => JSON.stringify(value);

const CANONICAL_CONTENT_TYPE_ERROR =
  "Response headers must not replace the canonical content type.";

function responseHeaders(
  contentType: "application/json; charset=utf-8" | "application/problem+json; charset=utf-8",
  supplied: Record<string, string> | undefined,
): Headers {
  const suppliedHeaders = supplied ?? {};
  const keys = Object.keys(suppliedHeaders);
  if (keys.some((key) => key.toLowerCase() === "content-type")) {
    throw new TypeError(CANONICAL_CONTENT_TYPE_ERROR);
  }

  const headers = new Headers({ "content-type": contentType });
  for (const key of keys) {
    const value = suppliedHeaders[key];
    if (typeof value !== "string") {
      throw new TypeError("Response header values must be strings.");
    }
    headers.set(key, value);
  }
  return headers;
}

/** Extensions may add context, never replace authority or mutate object identity. */
const RESERVED_PROBLEM_EXTENSION_KEYS = new Set([
  "type",
  "title",
  "status",
  "code",
  "detail",
  "fix_hint",
  "rule",
  "__proto__",
  "constructor",
  "prototype",
  "toJSON",
]);

function problemExtensions(input: ProblemInput): readonly (readonly [string, unknown])[] {
  const extensions = input.extensions ?? {};
  const keys = Object.keys(extensions).sort();
  if (keys.some((key) => RESERVED_PROBLEM_EXTENSION_KEYS.has(key))) {
    throw new TypeError("Problem extensions must not replace reserved fields.");
  }
  return keys.map((key) => [key, extensions[key]] as const);
}

export function successEnvelope<T>(input: SuccessInput<T>): SuccessEnvelope<T> {
  return {
    schema: input.schema,
    ok: true,
    data: input.data,
    degraded: input.degraded ?? [],
    next_actions: input.nextActions ?? [],
  };
}

export function problemEnvelope(input: ProblemInput): ProblemEnvelope {
  const extensions = problemExtensions(input);
  const envelope: ProblemEnvelope = {
    type: `${ERROR_BASE}/${input.code}`,
    title: input.title,
    status: input.status,
    code: input.code,
    detail: input.detail,
    fix_hint: input.fixHint,
  };
  if (input.rule !== undefined) {
    envelope.rule = input.rule;
  }
  for (const [key, value] of extensions) {
    envelope[key] = value;
  }
  return envelope;
}

/**
 * Construct one refusal owned by the closed contracts catalog. The generic
 * builder remains available to unfinished surfaces, while shipped enrollment,
 * auth, and app-boundary faces fail closed if their transparency class drifts.
 */
export function validatedProblemEnvelope(input: ValidatedProblemInput): ProblemDocument {
  return ProblemDocumentSchema.parse(problemEnvelope(input));
}

export function success<T>(input: SuccessInput<T>): Response {
  const headers = responseHeaders("application/json; charset=utf-8", input.headers);
  return new Response(jsonBody(successEnvelope(input)), {
    status: input.status ?? 200,
    headers,
  });
}

export function problem(input: ProblemInput): Response {
  const headers = responseHeaders("application/problem+json; charset=utf-8", input.headers);
  return new Response(jsonBody(problemEnvelope(input)), {
    status: input.status,
    headers,
  });
}

export function validatedProblem(input: ValidatedProblemInput): Response {
  const headers = responseHeaders("application/problem+json; charset=utf-8", input.headers);
  return new Response(jsonBody(validatedProblemEnvelope(input)), {
    status: input.status,
    headers,
  });
}
