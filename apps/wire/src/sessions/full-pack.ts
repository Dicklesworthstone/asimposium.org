import { FullPackPageSchema } from "@asimposium/contracts";
import { eventTailPath } from "@asimposium/contracts/event-tail";
import {
  bucketizePackBudget,
  type ComposedPack,
  composePack,
  neutralizeUntrustedBody,
  type PackCandidate,
  PackComposerError,
  type PackMembership,
} from "@asimposium/render";
import type { D1Database } from "@cloudflare/workers-types";
import { readPublicEventTail } from "../ledger/event-tail-read.ts";
import {
  type FullPackContentOmission,
  type FullPackRecord,
  readFullPackContent,
} from "./full-pack-content.ts";

export const FULL_PACK_RECORD_LIMIT = 20;
const MAX_ITEM_CHARACTERS = 18_000;

export interface FullPackInput {
  readonly session: string;
  readonly problem: string;
  readonly through: number;
  readonly after: number;
  readonly requestedMaxTokens: number;
  readonly membership: Exclude<PackMembership, "none">;
}

export function fullPackPath(
  input: FullPackInput,
  after: number,
  budget = bucketizePackBudget(input.requestedMaxTokens),
): string {
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

function page(input: FullPackInput, records: readonly RecordCandidate[]): ComposedPack {
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
    requested_max_tokens: input.requestedMaxTokens,
    viewer: { audience: "session", membership: input.membership, effective_permissions: [] },
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
      ...records.map(({ candidate }) => candidate),
    ],
    action_candidates: [
      ...(hasMore
        ? [
            {
              method: "GET" as const,
              url: fullPackPath(input, next),
              why: "Continue after the represented records at the same frozen cursor.",
              public_read: false,
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
    ],
    omitted: [...grouped].map(([reason, ids]) => ({
      reason,
      detail: `full-event content ${ids.join(", ")}; consult each record's explicit read links`,
    })),
  });
}

function allRepresented(composed: ComposedPack, records: readonly RecordCandidate[]): boolean {
  const ids = new Set(composed.items.map((item) => item.id));
  return ids.has("SYS-full-page") && records.every(({ candidate }) => ids.has(candidate.id));
}

function tryPage(input: FullPackInput, records: readonly RecordCandidate[]): ComposedPack | null {
  try {
    const composed = page(input, records);
    return allRepresented(composed, records) ? composed : null;
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
  const selected: RecordCandidate[] = [];
  if (records.length === 0) return page(input, selected);
  let composed: ComposedPack | undefined;
  for (const record of records) {
    let candidate = recordCandidate(input, record);
    let attempted = tryPage(input, [...selected, candidate]);
    if (attempted === null) {
      if (selected.length > 0) break;
      candidate = recordCandidate(input, record, "token_budget");
      attempted = tryPage(input, [candidate]);
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
  const result = await readPublicEventTail(db, input.problem, {
    since: input.after,
    through: input.through,
    limit: FULL_PACK_RECORD_LIMIT,
  });
  if (result === null) throw new Error("FULL_PACK_SOURCE_UNAVAILABLE");
  return composeFullPack(
    input,
    await readFullPackContent(db, input.problem, input.through, result.page.events),
  );
}
