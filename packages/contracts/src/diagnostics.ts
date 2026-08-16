import { redactCredentials } from "./diagnostic-safety.ts";

export const CONTRACTS_PACKAGE = "@asimposium/contracts";
export const CONTRACTS_VERSION = "0.0.0";

export type DiagnosticStatus = "pass" | "invalid" | "stale";
export type DiagnosticCode =
  | "DIAGNOSTIC_JSON_INVALID"
  | "FIXTURE_JSON_INVALID"
  | "GENERATED_ARTIFACT_MISSING"
  | "GENERATED_ARTIFACT_STALE"
  | "NO_ARTIFACT"
  | "STALE_ARTIFACT_ACCEPTED"
  | "STALE_FIXTURE_ACCEPTED"
  | "VALID_FIXTURE_REJECTED";

export const REPRODUCE = {
  contract: "bun run --cwd packages/contracts test:contract",
  drift: "bun run --cwd packages/contracts check:drift",
  generate: "bun run --cwd packages/contracts generate",
  unit: "bun run --cwd packages/contracts test:unit",
} as const;

export type SafeReproduction = (typeof REPRODUCE)[keyof typeof REPRODUCE];

export interface SafeDiagnosticInput {
  readonly suite: string;
  readonly status: DiagnosticStatus;
  readonly startedAt: number;
  readonly reproduce: SafeReproduction;
  readonly code?: DiagnosticCode;
}

/**
 * Diagnostics are deliberately structured and omit error bodies, paths, and
 * environment data so a failed contract gate cannot echo a secret.
 *
 * Safety here is primarily *typed*: `status`, `code` and `reproduce` are closed
 * vocabularies, and every caller in this package passes a literal `suite`. That
 * leaves `suite` as the one free-form string, so it is scanned with the shared
 * never-log vocabulary as defense in depth against a future dynamic caller.
 *
 * The scan redacts rather than throws. A diagnostic emitter that throws
 * destroys the very failure it was called to report, so the record is always
 * emitted and a credential-shaped suite name is printed as `<redacted>`.
 */
export function safeDiagnostic(input: SafeDiagnosticInput): string {
  const record = {
    tool: "bun",
    package: CONTRACTS_PACKAGE,
    suite: redactCredentials(input.suite),
    version: CONTRACTS_VERSION,
    duration_ms: Math.max(0, Math.round(performance.now() - input.startedAt)),
    status: input.status,
    ...(input.code === undefined ? {} : { code: input.code }),
    reproduce: input.reproduce,
  };

  return JSON.stringify(record);
}
