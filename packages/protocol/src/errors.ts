/**
 * Refusals raised while loading or checking a served text (bead asimposiumorg-8xn, OPS.1).
 *
 * These are contract errors in the sense of Fable §7.7: the caller is our own Worker or build,
 * so they teach maximally. They deliberately never echo the matched text of a finding — a
 * secret-shaped match must not be reproduced in the diagnostic that reports it (Fable §9.1,
 * §14.3 never-log list).
 */

export const ERROR_TYPE_BASE = "https://asimposium.org/errors/";

export type ProtocolErrorCode =
  | "UNKNOWN_DOCUMENT"
  | "RULES_SECTION_MISSING"
  | "RULES_CAP_EXCEEDED"
  | "CAPSULE_BUDGET_EXCEEDED"
  | "SERVED_TEXT_UNSAFE"
  | "VERSION_NOT_STATED";

export interface ProtocolProblem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: ProtocolErrorCode;
  readonly detail: string;
  readonly fix_hint: string;
  readonly rule?: string;
}

export interface ProtocolErrorInit {
  readonly code: ProtocolErrorCode;
  readonly title: string;
  readonly detail: string;
  readonly fix_hint: string;
  /** Doctrine rule id this refusal cites (e.g. `A8` for the served-text word cap). */
  readonly rule?: string;
  readonly status?: number;
}

export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;
  readonly title: string;
  readonly detail: string;
  readonly fix_hint: string;
  readonly rule?: string;
  readonly status: number;

  constructor(init: ProtocolErrorInit) {
    super(`${init.code}: ${init.detail}`);
    this.name = "ProtocolError";
    this.code = init.code;
    this.title = init.title;
    this.detail = init.detail;
    this.fix_hint = init.fix_hint;
    this.rule = init.rule;
    this.status = init.status ?? 500;
  }

  /** RFC 7807 shaped payload, safe to pass straight through as `problem+json`. */
  toProblem(): ProtocolProblem {
    const problem: ProtocolProblem = {
      type: `${ERROR_TYPE_BASE}${this.code}`,
      title: this.title,
      status: this.status,
      code: this.code,
      detail: this.detail,
      fix_hint: this.fix_hint,
    };
    return this.rule === undefined ? problem : { ...problem, rule: this.rule };
  }
}
