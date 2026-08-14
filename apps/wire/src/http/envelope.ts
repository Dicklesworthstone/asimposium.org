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

export const SCHEMA_BASE = 'https://a.asimposium.org/schemas';
export const ERROR_BASE = 'https://asimposium.org/errors';

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

const jsonBody = (value: unknown): string => JSON.stringify(value);

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
  for (const [key, value] of Object.entries(input.extensions ?? {})) {
    envelope[key] = value;
  }
  return envelope;
}

export function success<T>(input: SuccessInput<T>): Response {
  return new Response(jsonBody(successEnvelope(input)), {
    status: input.status ?? 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...input.headers,
    },
  });
}

export function problem(input: ProblemInput): Response {
  return new Response(jsonBody(problemEnvelope(input)), {
    status: input.status,
    headers: {
      'content-type': 'application/problem+json; charset=utf-8',
      ...input.headers,
    },
  });
}
