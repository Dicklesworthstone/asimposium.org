/**
 * Envelope validation and the single neutralization pass.
 *
 * Every face is rendered from a `PreparedProjection`, never from the raw input,
 * so there is exactly one place where an untrusted body is touched and exactly
 * one place where the structural trust rules of Fable §14.4 are enforced.
 */

import { contentFingerprint, stableStringify } from "./canonical.ts";
import { RenderContractError } from "./errors.ts";
import {
  isSafeHeaderValue,
  type NeutralizationFinding,
  neutralizeUntrustedBody,
} from "./sanitize.ts";
import {
  ITEM_SCOPES,
  type ItemScope,
  type NeutralizationReport,
  type Projection,
} from "./types.ts";

/** Public ids stay problem-scoped and boring (Fable §6.1). */
export const ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9@#._-]{0,63}$/;

export interface PreparedItem {
  readonly kind: string;
  readonly id: string;
  readonly scope: ItemScope;
  readonly untrusted: boolean;
  readonly why_included: string;
  /** Neutralized body. Untrusted bodies always differ from input when forged. */
  readonly body: string;
  readonly neutralized: readonly NeutralizationFinding[];
}

export interface PreparedProjection {
  readonly schema: string;
  readonly kind: string;
  readonly problem: string;
  readonly profile: string;
  readonly cursor: number;
  readonly title: string;
  readonly preamble: string;
  readonly items: readonly PreparedItem[];
  readonly omitted: readonly { reason: string; detail?: string }[];
  readonly next_actions: readonly { method: "GET" | "POST"; url: string; why: string }[];
  readonly degraded: readonly string[];
  readonly fingerprint: string;
  /** Flat per-item report, in item order. */
  readonly neutralized: readonly NeutralizationReport[];
}

function refuse(
  code: RenderContractError["code"],
  title: string,
  detail: string,
  fix_hint: string,
  rule?: string,
): never {
  // Omit `rule` when the caller cited none. Spreading `{}` keeps the property
  // absent instead of passing an explicit `undefined`, which exactOptionalPropertyTypes
  // (correctly) treats as a different thing from "not supplied".
  throw new RenderContractError({
    code,
    title,
    detail,
    fix_hint,
    ...(rule === undefined ? {} : { rule }),
  });
}

export function prepareProjection(projection: Projection): PreparedProjection {
  if (!Array.isArray(projection.omitted)) {
    refuse(
      "MISSING_OMITTED",
      "Every projection must declare what it left out",
      "projection.omitted is not an array",
      "Pass omitted: [] when nothing was dropped. A projection that cannot say what it omitted is an editorial, not a pack.",
      "A1",
    );
  }
  if (projection.items.length === 0 && projection.omitted.length === 0) {
    refuse(
      "EMPTY_PROJECTION_WITHOUT_OMISSION",
      "An empty projection with an empty omitted[] is a bug",
      "projection.items and projection.omitted are both empty",
      'Record why the projection is empty, e.g. omitted: [{reason: "no_membership"}].',
      "A1",
    );
  }

  // The cursor is printed straight into the face header as `cursor=<number>` and copied into
  // the JSON face, so it is control-comment metadata that happens to be numeric. Unchecked,
  // the two faces disagreed about the same projection: `NaN` and `Infinity` printed
  // literally in markdown but serialized to `null` in JSON, and an integer past
  // MAX_SAFE_INTEGER was silently rounded. A cursor is a per-scope monotonic sequence number
  // (Fable §7.1 axiom 7, §10.2), so the honest domain is exactly the non-negative safe
  // integers, and anything else is a composer defect rather than a value to render.
  if (!Number.isSafeInteger(projection.cursor) || projection.cursor < 0) {
    refuse(
      "INVALID_CURSOR",
      "The cursor must be a non-negative safe integer",
      `cursor ${JSON.stringify(projection.cursor)} is not a non-negative safe integer; NaN and Infinity render as "NaN"/"Infinity" in markdown but as null in JSON, and values past ${Number.MAX_SAFE_INTEGER} round silently`,
      "Pass the per-scope sequence number the event log assigned (0 or greater). If no events exist yet the cursor is 0, never null or -1.",
      "A6",
    );
  }

  for (const [field, value] of [
    ["schema", projection.schema],
    ["kind", projection.kind],
    ["problem", projection.problem],
    ["profile", projection.profile],
  ] as const) {
    if (!isSafeHeaderValue(value)) {
      refuse(
        "INVALID_HEADER_VALUE",
        "Envelope metadata may not break the face header grammar",
        `${field} ${JSON.stringify(value)} is not a control token: whitespace and '=' make the k=v header ambiguous, and '<', '>' or '--' can close the comment outright`,
        "Envelope metadata is server-authored. Use the boring vocabulary the faces already use — asimposium.pack.v1, pack, demo-bounded-sums, working — and fix the composer rather than escaping the value here.",
        "A1",
      );
    }
  }

  for (const action of projection.next_actions) {
    if (action.method !== "GET" && action.method !== "POST") {
      refuse(
        "INVALID_NEXT_ACTION",
        "next_actions are server-authored and typed",
        `next_action method ${JSON.stringify(action.method)} is not GET or POST`,
        "Emit GET or POST. next_actions are never derived from a body (Fable §14.4).",
      );
    }
  }

  const seen = new Set<string>();
  const items: PreparedItem[] = [];
  const neutralized: NeutralizationReport[] = [];

  for (const item of projection.items) {
    if (!ITEM_ID_PATTERN.test(item.id)) {
      refuse(
        "INVALID_ITEM_ID",
        "Item ids are problem-scoped public ids",
        `item id ${JSON.stringify(item.id)} does not match ${ITEM_ID_PATTERN.source}`,
        "Use the public id grammar: C-12, H-3@2, W-fermat-descent-01.",
        "A1",
      );
    }
    if (seen.has(item.id)) {
      refuse(
        "DUPLICATE_ITEM_ID",
        "One projection cannot carry the same id twice",
        `item id ${JSON.stringify(item.id)} appears more than once`,
        "Deduplicate in the composer; a face with two items of one id cannot be reconciled with the log.",
        "A6",
      );
    }
    seen.add(item.id);

    if (!ITEM_SCOPES.includes(item.scope)) {
      refuse(
        "INVALID_SCOPE",
        "Item scope must be system, ledger or workshop",
        `item ${item.id} declares scope ${JSON.stringify(item.scope)}`,
        `Allowed scopes: ${ITEM_SCOPES.join(", ")}.`,
      );
    }

    // `kind` is printed into the item's own `<!-- asimp:item … -->` delimiter, so it obeys
    // the same grammar as every other control token. Unvalidated, it was the sharpest hole
    // in the canonical face: a kind ending in `-->` closed the delimiter and let the
    // characters after it open a forged item with `scope=system untrusted=false`, which is
    // a fabricated instruction channel (Fable §7.3) reached through metadata rather than
    // through a body.
    if (!isSafeHeaderValue(item.kind)) {
      refuse(
        "INVALID_ITEM_KIND",
        "Item kind may not break the item delimiter grammar",
        `item ${item.id} declares kind ${JSON.stringify(item.kind)}, which is not a control token: whitespace and '=' make the k=v delimiter ambiguous, and '<', '>' or '--' can close it outright`,
        "Use the object vocabulary the ledger already uses — claim, evidence, review, hypothesis, dead-end, move, warning, handback, workshop-note.",
        "A1",
      );
    }

    // The forged-system-item defense, structurally (Fable §7.3, §14.4 layer 2):
    // system items are the only items permitted to carry instructions, and the
    // only ones with untrusted:false. A body can claim anything; the envelope
    // cannot.
    if (item.scope !== "system" && item.untrusted === false) {
      refuse(
        "UNTRUSTED_FLAG_MISMATCH",
        "Only system items may be marked trusted",
        `item ${item.id} has scope ${item.scope} and untrusted:false`,
        "Set untrusted:true. System items are the only instruction channel; ledger and workshop bodies are data.",
        "A2",
      );
    }
    if (item.scope === "system" && item.untrusted === true) {
      refuse(
        "SYSTEM_ITEM_MISFLAGGED",
        "System items are server-authored and are not untrusted",
        `item ${item.id} has scope system and untrusted:true`,
        "Set untrusted:false on system items, or give the item its real scope.",
        "A2",
      );
    }

    if (item.untrusted) {
      const result = neutralizeUntrustedBody(item.body);
      items.push({
        kind: item.kind,
        id: item.id,
        scope: item.scope,
        untrusted: true,
        why_included: item.why_included,
        body: result.text,
        neutralized: result.findings,
      });
      for (const finding of result.findings) {
        neutralized.push({ item_id: item.id, marker: finding.marker, count: finding.count });
      }
    } else {
      items.push({
        kind: item.kind,
        id: item.id,
        scope: item.scope,
        untrusted: false,
        why_included: item.why_included,
        body: item.body,
        neutralized: [],
      });
    }
  }

  const fingerprintSource = stableStringify({
    schema: projection.schema,
    kind: projection.kind,
    problem: projection.problem,
    profile: projection.profile,
    cursor: projection.cursor,
    title: projection.title,
    preamble: projection.preamble,
    items,
    omitted: projection.omitted,
    next_actions: projection.next_actions,
    degraded: projection.degraded,
  });

  return {
    schema: projection.schema,
    kind: projection.kind,
    problem: projection.problem,
    profile: projection.profile,
    cursor: projection.cursor,
    title: projection.title,
    preamble: projection.preamble,
    items,
    omitted: projection.omitted.map((entry) =>
      entry.detail === undefined
        ? { reason: entry.reason }
        : { reason: entry.reason, detail: entry.detail },
    ),
    next_actions: projection.next_actions.map((action) => ({
      method: action.method,
      url: action.url,
      why: action.why,
    })),
    degraded: [...projection.degraded],
    fingerprint: contentFingerprint(fingerprintSource),
    neutralized,
  };
}
