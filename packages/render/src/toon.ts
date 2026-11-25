import { type ProblemsIndexResponse, ProblemsIndexResponseSchema } from "@asimposium/contracts";
import { type EventTailPage, EventTailResponseSchema } from "@asimposium/contracts/event-tail";
import { decode, encode } from "@toon-format/toon";
import {
  ClaimsListToonUnavailableError,
  parseClaimsListToon,
  renderClaimsListToon,
} from "./claims-list.ts";

/** Canonical media type for uniform-list TOON faces across all Stoa surfaces (ADR-5). */
export const TOON_MEDIA_TYPE = "text/toon; charset=utf-8" as const;

export class ToonUnavailableError extends Error {
  constructor(
    message = "TOON cannot preserve the canonical data over UTF-8",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ToonUnavailableError";
  }
}

export type EventTailToonPage = ReturnType<typeof EventTailResponseSchema.parse>;

function encodeLosslessToon<T>(
  value: unknown,
  parse: (input: unknown) => T,
  label: string,
): string {
  const canonical = parse(value);
  try {
    const body = `${encode(canonical)}\n`;
    const transported = new TextDecoder().decode(new TextEncoder().encode(body));
    const decoded = parse(decode(transported, { strict: true }));
    if (JSON.stringify(decoded) !== JSON.stringify(canonical)) {
      throw new ToonUnavailableError(`${label} TOON round-trip diverged from canonical JSON`);
    }
    return body;
  } catch (cause) {
    if (cause instanceof ToonUnavailableError) throw cause;
    throw new ToonUnavailableError(`${label} TOON cannot preserve canonical data over UTF-8`, {
      cause,
    });
  }
}

export function parseProblemsIndexToon(body: string): ProblemsIndexResponse {
  return ProblemsIndexResponseSchema.parse(decode(body, { strict: true }));
}

export function renderProblemsIndexToon(data: ProblemsIndexResponse): string {
  return encodeLosslessToon(
    data,
    (value) => ProblemsIndexResponseSchema.parse(value),
    "Problems index",
  );
}

export function parseEventTailToon(body: string): EventTailToonPage {
  return EventTailResponseSchema.parse(decode(body, { strict: true }));
}

export function renderEventTailToon(page: EventTailPage | EventTailToonPage): string {
  return encodeLosslessToon(page, (value) => EventTailResponseSchema.parse(value), "Event tail");
}

export { ClaimsListToonUnavailableError, parseClaimsListToon, renderClaimsListToon };
