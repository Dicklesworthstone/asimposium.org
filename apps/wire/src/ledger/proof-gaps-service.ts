import { GapFileRequestSchema, GapTransitionRequestSchema } from "@asimposium/contracts";
import { type ProofGapsQuery, ProofGapsResponseSchema } from "@asimposium/contracts/proof-gaps";
import type { D1Database } from "@cloudflare/workers-types";
import { type ProofGapDecoders, readProofGaps } from "./proof-gaps-read.ts";

const decoders: ProofGapDecoders = {
  filed(value) {
    const parsed = GapFileRequestSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  },
  settled(value) {
    // The immutable writer explicitly stores closed_by:null for withdrawal;
    // the original write request correctly forbids that optional field.
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (record.closed_by === null) {
        const { closed_by: _empty, ...request } = record;
        value = request;
      }
    }
    const parsed = GapTransitionRequestSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  },
};

export async function loadProofGaps(
  db: D1Database,
  problem: string,
  query: ProofGapsQuery = {},
  unownedAt?: string,
) {
  const result = await readProofGaps(db, problem, query, decoders, unownedAt);
  return { ...result, face: ProofGapsResponseSchema.parse(result.face) };
}
