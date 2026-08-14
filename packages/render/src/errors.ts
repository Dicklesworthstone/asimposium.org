/**
 * Render-time contract refusals.
 *
 * These are *contract* errors in the sense of Fable §7.7 / ADR-18: they teach
 * maximally, because the caller is our own Worker composing a projection, not
 * an attacker probing a policy screen. Policy refusals live in the screening
 * pipeline and are deliberately terse; nothing in this package emits one.
 */

export const ERROR_TYPE_BASE = "https://asimposium.org/errors/";

export type RenderErrorCode =
  | "UNKNOWN_FORMAT"
  | "MISSING_OMITTED"
  | "EMPTY_PROJECTION_WITHOUT_OMISSION"
  | "UNTRUSTED_FLAG_MISMATCH"
  | "SYSTEM_ITEM_MISFLAGGED"
  | "INVALID_ITEM_ID"
  | "INVALID_ITEM_KIND"
  | "INVALID_CURSOR"
  | "DUPLICATE_ITEM_ID"
  | "INVALID_SCOPE"
  | "INVALID_HEADER_VALUE"
  | "INVALID_NEXT_ACTION"
  | "BODY_TOO_LARGE"
  | "TRUSTED_BODY_CONTAINS_CONTROL_MARKER";

export interface RenderProblem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: RenderErrorCode;
  readonly detail: string;
  readonly fix_hint: string;
  readonly rule?: string;
}

export interface RenderErrorInit {
  readonly code: RenderErrorCode;
  readonly title: string;
  readonly detail: string;
  readonly fix_hint: string;
  /** Doctrine rule id this refusal cites, when one applies (e.g. `A1`, `A4`). */
  readonly rule?: string;
  readonly status?: number;
}

/**
 * Thrown when a projection cannot be rendered honestly. Carries an RFC 7807
 * shaped payload so a caller can pass it straight through as `problem+json`.
 */
export class RenderContractError extends Error {
  readonly code: RenderErrorCode;
  readonly title: string;
  readonly detail: string;
  readonly fix_hint: string;
  /**
   * `declare` on purpose: a plain field declaration would be *defined* as
   * `undefined` at construction under ESNext class-field semantics, so
   * `"rule" in error` would be true for a refusal that cites no rule. Declaring
   * it keeps the property genuinely absent until the constructor assigns one.
   */
  declare readonly rule?: string;
  readonly status: number;

  constructor(init: RenderErrorInit) {
    super(`${init.code}: ${init.detail}`);
    this.name = "RenderContractError";
    this.code = init.code;
    this.title = init.title;
    this.detail = init.detail;
    this.fix_hint = init.fix_hint;
    // `rule` is genuinely optional: many refusals are structural and cite no
    // doctrine rule. Under exactOptionalPropertyTypes the honest encoding of
    // "absent" is to leave the property unassigned rather than to store
    // `undefined` in a `string` slot, which is what `toProblem()` already
    // assumes when it decides whether to emit the key at all.
    if (init.rule !== undefined) {
      this.rule = init.rule;
    }
    this.status = init.status ?? 422;
  }

  toProblem(): RenderProblem {
    const problem: RenderProblem = {
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
