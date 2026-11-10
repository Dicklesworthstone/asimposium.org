import { FullPackPageSchema, type SessionProvenance } from "@asimposium/contracts";
import { eventTailPath } from "@asimposium/contracts/event-tail";
import {
  bucketizePackBudget,
  type ComposedPack,
  composePack,
  neutralizeUntrustedBody,
  PACK_BUDGET_BUCKETS,
  type PackActionCandidate,
  type PackCandidate,
  PackComposerError,
  type PackMembership,
  type Projection,
  renderProjection,
} from "@asimposium/render";
import type { D1Database } from "@cloudflare/workers-types";
import { readPublicEventTail } from "../ledger/event-tail-read.ts";
import {
  type FullPackContentOmission,
  type FullPackRecord,
  readFullPackContent,
} from "./full-pack-content.ts";
import {
  sessionPackProvenance,
  sessionPackProvenanceBudgetOmission,
  sessionPackProvenanceReference,
} from "./provenance.ts";

export const FULL_PACK_RECORD_LIMIT = 20;
const MAX_ITEM_CHARACTERS = 18_000;

/** The canonical public source is absent, private or currently hidden.
 * Distinguish that policy outcome from storage and composition failures. */
export class FullPackSourceUnavailableError extends Error {
  constructor() {
    super("FULL_PACK_SOURCE_UNAVAILABLE");
    this.name = "FullPackSourceUnavailableError";
  }
}

export interface FullPackInput {
  readonly session: string;
  readonly problem: string;
  readonly through: number;
  readonly after: number;
  readonly requestedMaxTokens: number;
  readonly membership: PackMembership;
  readonly provenance?: SessionProvenance | null;
  readonly publicFace?: {
    readonly preamble: string;
    readonly context: readonly PackCandidate[];
    readonly actions: readonly PackActionCandidate[];
    readonly omitted: ComposedPack["omitted"];
    readonly witnesses: readonly FullPackReadWitness[];
    readonly degraded?: ComposedPack["degraded"];
    /** HTTP callers run this after hashing the rendered response so a 304
     * cannot bypass the last current-visibility snapshot. */
    readonly captureRelease?: (release: () => Promise<void>) => void;
  };
}

/** Request-local read witnesses never cross the public projection boundary.
 * All participating bounded reads are replayed in one final D1 snapshot,
 * after asynchronous digest verification and before releasing a page. */
export interface FullPackReadWitness {
  readonly sql: string;
  readonly bindings: readonly (string | number | null)[];
  readonly rows: readonly unknown[];
}

export class FullPackSourceChangedError extends Error {
  constructor() {
    super("FULL_PACK_SOURCE_CHANGED");
    this.name = "FullPackSourceChangedError";
  }
}

function snapshotRows(rows: readonly unknown[]): string {
  return JSON.stringify(
    rows.map((row) => {
      if (row === null || typeof row !== "object" || Array.isArray(row)) return row;
      // Later appends may advance the live head without changing a frozen page.
      const { public_seq: _head, ...source } = row as Record<string, unknown>;
      return source;
    }),
  );
}

/** Public full pages carry no session identity, authority or live lifecycle
 * status. They retain the public face's existing Markdown header vocabulary. */
export function publicFullPackProjection(pack: ComposedPack, preamble: string): Projection {
  return {
    schema: "asimposium.problem-face.v1",
    kind: "problem-face",
    problem: pack.problem,
    profile: "full",
    cursor: pack.cursor,
    title: `${pack.problem} — full problem pack`,
    preamble: `${pack.preamble} ${preamble}`,
    items: pack.items.map(({ tokens: _tokens, ...item }) => item),
    omitted: pack.omitted,
    next_actions: pack.next_actions,
    degraded: pack.degraded,
  };
}

export function fullPackPath(
  input: FullPackInput,
  after: number,
  budget = bucketizePackBudget(input.requestedMaxTokens),
): string {
  if (input.publicFace !== undefined)
    return `/p/${encodeURIComponent(input.problem)}/full.md?through=${input.through}&after=${after}`;
  return `/v1/sessions/${encodeURIComponent(input.session)}/pack?profile=full&max_tokens=${budget}&through=${input.through}&after=${after}`;
}

interface RecordCandidate {
  readonly candidate: PackCandidate;
  readonly omission: FullPackContentOmission | null;
}

function recordCandidate(
  input: FullPackInput,
  record: FullPackRecord,
  referenceReason?: "item_size_limit" | "token_budget",
): RecordCandidate {
  const { envelope } = record;
  const event = envelope.event;
  const envelopeUrl = eventTailPath(input.problem, "json", {
    since: envelope.seq - 1,
    through: input.through,
    limit: 1,
  });
  const contentUrl =
    event?.object_url ??
    (event?.object_kind === "hypothesis" &&
    /^H-[A-Za-z0-9][A-Za-z0-9._:-]{0,77}$/.test(event.object_id)
      ? `/p/${encodeURIComponent(input.problem)}/hypotheses/${encodeURIComponent(event.object_id)}.json?through=${input.through}`
      : event?.object_kind === "problem" &&
          event.object_id === input.problem &&
          ["problem.admitted", "problem.statement-revised"].includes(event.type)
        ? `/p/${encodeURIComponent(input.problem)}/statements/${event.object_version}.json?through=${input.through}`
        : null);
  const omission = record.content_omitted ?? referenceReason ?? null;
  const body = JSON.stringify(
    referenceReason === undefined
      ? {
          seq: envelope.seq,
          publication: event,
          content: record.content,
          content_omitted: omission,
          content_url: contentUrl,
          envelope_url: envelopeUrl,
        }
      : {
          seq: envelope.seq,
          event_id: event?.id ?? null,
          payload_sha256: event?.payload_sha256 ?? null,
          content: null,
          content_omitted: omission,
          envelope_omitted: referenceReason,
          content_url: contentUrl,
          envelope_url: envelopeUrl,
        },
  );
  if (
    referenceReason === undefined &&
    (body.length > MAX_ITEM_CHARACTERS ||
      neutralizeUntrustedBody(body).text.length > MAX_ITEM_CHARACTERS)
  )
    return recordCandidate(input, record, "item_size_limit");
  return {
    omission,
    candidate: {
      kind: "full-event",
      id: `FULL-${envelope.seq}`,
      scope: "ledger",
      ...(event?.screening_notice === undefined
        ? {}
        : { screening_notice: event.screening_notice }),
      untrusted: true,
      tokens: 1,
      stable_prefix: envelope.seq - input.after,
      body,
      why_included:
        referenceReason === undefined
          ? "One public sequence with verified typed publication fields; not current scientific standing."
          : "Whole-record reference: omitted bytes are not implied to have been read.",
    },
  };
}

function page(
  input: FullPackInput,
  records: readonly RecordCandidate[],
  omitProvenanceForBudget: boolean,
): ComposedPack {
  const provenance =
    input.publicFace !== undefined || input.provenance === undefined || omitProvenanceForBudget
      ? undefined
      : sessionPackProvenance(input.session, input.provenance);
  const nextBudget = PACK_BUDGET_BUCKETS.find(
    (budget) => budget > bucketizePackBudget(input.requestedMaxTokens),
  );
  const next = input.after + records.length;
  const hasMore = next < input.through;
  const control = FullPackPageSchema.parse({
    control: "full_pack_page",
    after: input.after,
    through: input.through,
    next_after: hasMore ? next : null,
    has_more: hasMore,
    records: records.length,
  });
  const grouped = new Map<string, string[]>();
  for (const { candidate, omission } of records) {
    if (omission === null) continue;
    const ids = grouped.get(omission) ?? [];
    ids.push(`#${candidate.id.slice(5)}`);
    grouped.set(omission, ids);
  }
  return composePack({
    schema: "asimposium.pack.v1",
    session: input.session,
    problem: input.problem,
    profile: "full",
    cursor: input.through,
    ...(provenance === undefined ? {} : { provenance: provenance.provenance }),
    requested_max_tokens: input.requestedMaxTokens,
    ...(input.publicFace?.degraded === undefined ? {} : { degraded: input.publicFace.degraded }),
    viewer: {
      audience: input.publicFace === undefined ? "session" : "public",
      membership: input.publicFace === undefined ? input.membership : "none",
      effective_permissions: [],
    },
    candidates: [
      {
        kind: "full-page",
        id: "SYS-full-page",
        scope: "system",
        untrusted: false,
        tokens: 1,
        stable_prefix: 0,
        body: JSON.stringify(control),
        why_included:
          "All public sequences, typed publication fields. Null content_url means no complete-body route is registered. Current controls still apply.",
      },
      ...(input.publicFace?.context.map((candidate, index) => ({
        ...candidate,
        stable_prefix: index + 1,
      })) ?? []),
      ...(input.publicFace === undefined && omitProvenanceForBudget && input.provenance != null
        ? [
            {
              kind: "standing-context",
              id: "SYS-session-provenance",
              scope: "system" as const,
              untrusted: false,
              tokens: 1,
              stable_prefix: 1,
              body: sessionPackProvenanceReference(input.session, input.provenance),
              why_included: "Recover captured metadata omitted by this budget.",
            },
          ]
        : []),
      ...records.map(({ candidate }) => ({
        ...candidate,
        stable_prefix:
          (candidate.stable_prefix ?? 0) +
          (input.publicFace?.context.length ?? 0) +
          (omitProvenanceForBudget ? 1 : 0),
      })),
    ],
    action_candidates: [
      ...(hasMore
        ? [
            {
              method: "GET" as const,
              url: fullPackPath(input, next),
              why: "Continue after the represented records at the same frozen cursor.",
              public_read: input.publicFace !== undefined,
            },
          ]
        : []),
      {
        method: "GET",
        url: eventTailPath(input.problem, "json", {
          since: input.after,
          through: input.through,
          limit: FULL_PACK_RECORD_LIMIT,
        }),
        why: "Read canonical event envelopes; this route does not return publication bodies.",
        public_read: true,
      },
      ...(input.publicFace?.actions ?? []),
      ...(omitProvenanceForBudget && nextBudget !== undefined
        ? [
            {
              method: "GET" as const,
              url: fullPackPath(input, input.after, nextBudget),
              why: "Read a larger pack at this frozen cursor.",
              public_read: false,
            },
          ]
        : []),
    ],
    omitted: [
      ...(input.publicFace?.omitted ?? []),
      ...(provenance?.omitted ?? []),
      ...(omitProvenanceForBudget ? [sessionPackProvenanceBudgetOmission(input.session)] : []),
      ...[...grouped].map(([reason, ids]) => ({
        reason,
        detail: `full-event content ${ids.join(", ")}; consult each record's explicit read links`,
      })),
    ],
  });
}

function allRepresented(
  composed: ComposedPack,
  records: readonly RecordCandidate[],
  omitProvenanceForBudget: boolean,
): boolean {
  const ids = new Set(composed.items.map((item) => item.id));
  return (
    ids.has("SYS-full-page") &&
    (!omitProvenanceForBudget || ids.has("SYS-session-provenance")) &&
    records.every(({ candidate }) => ids.has(candidate.id))
  );
}

function tryPage(
  input: FullPackInput,
  records: readonly RecordCandidate[],
  omitProvenanceForBudget: boolean,
): ComposedPack | null {
  try {
    const composed = page(input, records, omitProvenanceForBudget);
    if (
      input.publicFace !== undefined &&
      renderProjection(publicFullPackProjection(composed, input.publicFace.preamble), "md").bytes >
        bucketizePackBudget(input.requestedMaxTokens) * 4
    )
      return null;
    return allRepresented(composed, records, omitProvenanceForBudget) ? composed : null;
  } catch (error) {
    if (error instanceof PackComposerError && error.code === "MANDATORY_OVERHEAD_EXCEEDS_BUDGET")
      return null;
    throw error;
  }
}

/** General pack selection may skip a large item and fit a later small one.
 * A paginated export cannot: advance only across a contiguous, represented
 * prefix. If its first record cannot fit, an explicit whole-record reference
 * makes bounded forward progress while disclosing the unread bytes. */
export function composeFullPack(
  input: FullPackInput,
  records: readonly FullPackRecord[],
): ComposedPack {
  if (
    records.length > FULL_PACK_RECORD_LIMIT ||
    records.some(
      ({ envelope }, index) =>
        envelope.problem_id !== input.problem ||
        envelope.seq !== input.after + index + 1 ||
        envelope.seq > input.through,
    ) ||
    (records.length === 0 && input.after < input.through)
  )
    throw new Error("FULL_PACK_SEQUENCE_UNAVAILABLE");
  try {
    return composeFullPackPage(input, records, false);
  } catch (error) {
    if (
      input.publicFace === undefined &&
      input.provenance != null &&
      error instanceof PackComposerError &&
      error.code === "MANDATORY_OVERHEAD_EXCEEDS_BUDGET"
    )
      return composeFullPackPage(input, records, true);
    throw error;
  }
}

function composeFullPackPage(
  input: FullPackInput,
  records: readonly FullPackRecord[],
  omitProvenanceForBudget: boolean,
): ComposedPack {
  const selected: RecordCandidate[] = [];
  if (records.length === 0) {
    const empty = tryPage(input, selected, omitProvenanceForBudget);
    if (empty !== null) return empty;
    throw new PackComposerError(
      "MANDATORY_OVERHEAD_EXCEEDS_BUDGET",
      "The full-page control does not fit.",
    );
  }
  let composed: ComposedPack | undefined;
  for (const record of records) {
    let candidate = recordCandidate(input, record);
    let attempted = tryPage(input, [...selected, candidate], omitProvenanceForBudget);
    if (attempted === null) {
      if (selected.length > 0) break;
      candidate = recordCandidate(input, record, "token_budget");
      attempted = tryPage(input, [candidate], omitProvenanceForBudget);
      if (attempted === null)
        throw new PackComposerError(
          "MANDATORY_OVERHEAD_EXCEEDS_BUDGET",
          "The full-page record reference does not fit.",
        );
    }
    selected.push(candidate);
    composed = attempted;
  }
  if (composed === undefined) throw new Error("FULL_PACK_SEQUENCE_UNAVAILABLE");
  return composed;
}

/** No workshop, sessions.handback, mutable projection text or private inbox
 * is read. Every page starts with the same canonical public-tail admission. */
export async function readFullPack(db: D1Database, input: FullPackInput): Promise<ComposedPack> {
  const witnesses: FullPackReadWitness[] = [...(input.publicFace?.witnesses ?? [])];
  const capture =
    input.publicFace === undefined
      ? undefined
      : (sql: string, bindings: readonly (string | number | null)[], rows: readonly unknown[]) =>
          witnesses.push({ sql, bindings, rows });
  const tailIndex = witnesses.length;
  const result = await readPublicEventTail(
    db,
    input.problem,
    {
      since: input.after,
      through: input.through,
      limit: FULL_PACK_RECORD_LIMIT,
    },
    capture,
  );
  if (result === null) throw new FullPackSourceUnavailableError();
  const records = await readFullPackContent(
    db,
    input.problem,
    input.through,
    result.page.events,
    capture,
  );
  const composed = composeFullPack(input, records);
  if (input.publicFace !== undefined) {
    const release = async () => {
      const final = await db.batch(
        witnesses.map((witness) => db.prepare(witness.sql).bind(...witness.bindings)),
      );
      if (final.length !== witnesses.length || final.some((row) => !row.success))
        throw new FullPackSourceChangedError();
      if (final[tailIndex]?.results.length === 0) throw new FullPackSourceUnavailableError();
      if (
        witnesses.some(
          (witness, index) => snapshotRows(witness.rows) !== snapshotRows(final[index]!.results),
        )
      )
        throw new FullPackSourceChangedError();
    };
    if (input.publicFace.captureRelease === undefined) await release();
    else input.publicFace.captureRelease(release);
  }
  return composed;
}
