import {
  INTEGRITY_CASE_STEP_UP_SECONDS,
  IntegrityCaseQuerySchema,
  IntegrityCaseIdSchema,
  IntegrityCaseReadRequestSchema,
  type IntegrityCaseCursor,
  type IntegrityCaseOpenRequest,
  type IntegrityCaseQuery,
  type IntegrityCaseReadRequest,
  type IntegrityCaseReceipt,
  type IntegrityCaseResolveRequest,
  type IntegrityCaseRespondRequest,
  type IntegrityConcern,
  type IntegrityOutcome,
  type IntegrityPublicationPin,
  type PublicIntegrityNoticesResponse,
} from "@asimposium/contracts/integrity-cases";

export type IntegrityAudience = "operator" | "sponsor";
export type IntegritySearchParams = Readonly<Record<string, string | string[] | undefined>>;

export const INTEGRITY_CONCERN_LABELS: Readonly<Record<IntegrityConcern, string>> = {
  "fabricated-source": "Source authenticity",
  "fabricated-verification": "Verification authenticity",
  plagiarism: "Attribution and originality",
  "declaration-mismatch": "Declaration accuracy",
  "coordinated-manipulation": "Coordinated manipulation",
};
export const INTEGRITY_OUTCOME_LABELS: Readonly<Record<IntegrityOutcome, string>> = {
  unsubstantiated: "Concern not substantiated",
  "honest-error": "Honest error",
  inconclusive: "Inconclusive",
  confirmed: "Concern confirmed",
};

export type IntegrityAttempt =
  | { readonly kind: "open"; readonly principalId: string; readonly key: string; readonly request: IntegrityCaseOpenRequest }
  | { readonly kind: "respond"; readonly principalId: string; readonly key: string; readonly request: IntegrityCaseRespondRequest }
  | { readonly kind: "resolve"; readonly principalId: string; readonly key: string; readonly request: IntegrityCaseResolveRequest };

export type IntegrityActionState =
  | { readonly status: "idle" | "invalid" | "refused"; readonly message: string }
  | { readonly status: "unconfirmed"; readonly message: string; readonly attempt: IntegrityAttempt }
  | { readonly status: "committed"; readonly message: string; readonly receipt: IntegrityCaseReceipt };

export const INITIAL_INTEGRITY_ACTION_STATE: IntegrityActionState = { status: "idle", message: "" };

/** Match the Worker's strict freshness gate, including refusal of future timestamps. */
export function integrityAuthIsRecent(
  issuedAt: number | undefined,
  now = Math.floor(Date.now() / 1000),
): issuedAt is number {
  return typeof issuedAt === "number" && Number.isSafeInteger(issuedAt) && issuedAt >= 0 &&
    Number.isSafeInteger(now) && now >= issuedAt && now - issuedAt <= INTEGRITY_CASE_STEP_UP_SECONDS;
}

function validKeys(query: IntegritySearchParams, allowed: readonly string[]): boolean {
  return Object.entries(query).every(([key, value]) =>
    value === undefined || (allowed.includes(key) && typeof value === "string"),
  );
}

export function parseIntegrityListQuery(query: IntegritySearchParams): IntegrityCaseQuery | null {
  if (!validKeys(query, ["before_at", "before_id"])) return null;
  const at = query.before_at;
  const id = query.before_id;
  if ((at === undefined) !== (id === undefined)) return null;
  const parsed = IntegrityCaseQuerySchema.safeParse(at === undefined ? {} : {
    before: { opened_at: at, case_id: id },
  });
  return parsed.success ? parsed.data : null;
}

export function parseIntegrityHistoryQuery(
  caseId: string,
  query: IntegritySearchParams,
): IntegrityCaseReadRequest | null {
  if (!validKeys(query, ["after_revision"])) return null;
  const raw = query.after_revision;
  if (raw !== undefined && (typeof raw !== "string" || raw.length > 16 ||
    !/^(0|[1-9][0-9]*)$(?![\s\S])/.test(raw))) return null;
  const parsed = IntegrityCaseReadRequestSchema.safeParse({
    case_id: caseId, after_revision: raw === undefined ? 0 : Number(raw),
  });
  return parsed.success ? parsed.data : null;
}

export function integrityListHref(audience: IntegrityAudience, before?: IntegrityCaseCursor | null): string {
  const path = audience === "operator" ? "/admin/integrity" : "/console/integrity";
  if (!before) return path;
  const params = new URLSearchParams({ before_at: before.opened_at, before_id: before.case_id });
  return path + "?" + params.toString();
}

export function integrityCaseHref(audience: IntegrityAudience, caseId: string, afterRevision = 0): string {
  return integrityListHref(audience) + "/" + encodeURIComponent(caseId) +
    (afterRevision === 0 ? "" : "?after_revision=" + String(afterRevision));
}

/** The event is the exact immutable publication, even if its object was later revised. */
export function integrityPublicationHref(pin: IntegrityPublicationPin): string {
  return "/r/p/" + encodeURIComponent(pin.problem_id) + "/events/" + String(pin.seq);
}

export function integrityKeyIsValid(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,160}$(?![\s\S])/.test(value);
}

/** Form values are untrusted; repeated command fields are never silently chosen. */
export function singleIntegrityFormValue(form: FormData, key: string): string | undefined {
  const values = form.getAll(key);
  return values.length === 1 && typeof values[0] === "string" ? values[0] : undefined;
}

export function integrityWriteState(
  attempt: IntegrityAttempt,
  result: { readonly ok: true; readonly data: IntegrityCaseReceipt } |
    { readonly ok: false; readonly reason: string; readonly status?: number },
): IntegrityActionState {
  if (result.ok) return {
    status: "committed",
    message: result.data.action === "appealed"
      ? "Your appeal is recorded. The case is open for a different operator; the earlier decision remains in its history."
      : result.data.action === "response"
        ? "Your response is recorded in the private case history."
        : result.data.action === "opened"
          ? "The scientific-integrity case is open. Its existence is not a finding of misconduct."
          : "The operator outcome is recorded. It does not change scientific standing or impose an account sanction.",
    receipt: result.data,
  };
  if (result.reason === "unconfigured") return {
    status: "refused", message: "Scientific-integrity case handling is not configured on this deployment.",
  };
  if (result.reason === "refused" && result.status !== undefined &&
    result.status < 500 && result.status !== 408 && result.status !== 429) return {
    status: "refused",
    message: "Stoa refused this request. The source, revision, case state or your authority may have changed. Reload the case before another action. Operator conflicts and the one-appeal limit are enforced by Stoa.",
  };
  return {
    status: "unconfirmed", attempt,
    message: "The outcome could not be confirmed. Keep this exact request and retry with its retained key, or inspect the current case before doing anything else.",
  };
}

export function parseIntegrityNoticesQuery(query: IntegritySearchParams): { readonly after?: string } | null {
  if (!validKeys(query, ["after"])) return null;
  if (query.after === undefined) return {};
  const parsed = IntegrityCaseIdSchema.safeParse(query.after);
  return parsed.success ? { after: parsed.data } : null;
}

export function integrityNoticesPath(
  problem: string,
  format: "human" | "json" | "md" | "html" = "human",
  after?: string,
): string {
  return "/p/" + encodeURIComponent(problem) + "/integrity" +
    (format === "human" ? "" : "." + format) +
    (after === undefined ? "" : "?after=" + encodeURIComponent(after));
}

export function integrityNoticesMatchQuery(
  problem: string,
  after: string | undefined,
  page: PublicIntegrityNoticesResponse,
): boolean {
  return page.problem_id === problem &&
    (after === undefined || (
      page.notices.every((notice) => notice.case_id > after) &&
      (page.next_after === null || page.next_after > after)
    ));
}
