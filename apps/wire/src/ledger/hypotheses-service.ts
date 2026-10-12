import {
  HypothesesQuerySchema,
  HypothesesResponseSchema,
  HypothesisItemQuerySchema,
  HypothesisPublicationSchema,
  PublicHypothesisIdSchema,
  PublicHypothesisSchema,
} from "@asimposium/contracts/hypotheses";
import type { D1Database } from "@cloudflare/workers-types";
import { boundHypothesesFace } from "./hypotheses-face";
import { type HypothesisDecoders, readHypotheses } from "./hypotheses-read";

const killSchema = PublicHypothesisSchema.shape.kill.unwrap();
const decoders: HypothesisDecoders = {
  publication(value) {
    const parsed = HypothesisPublicationSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  },
  kill(value) {
    const parsed = killSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  },
};

/** A single production adapter owns canonical decoding for faces and moves. */
export async function loadPublicHypotheses(db: D1Database, problemId: string, query: unknown = {}) {
  const parsed = HypothesesQuerySchema.parse(query);
  const result = await readHypotheses(
    db,
    problemId,
    {
      ...(parsed.through === undefined ? {} : { through: Number(parsed.through) }),
      ...(parsed.after === undefined ? {} : { after: Number(parsed.after) }),
    },
    decoders,
  );
  return result === null
    ? null
    : {
        face: boundHypothesesFace(HypothesesResponseSchema.parse(result.face)),
        unlisted: result.unlisted,
      };
}

/** Direct identity lookup uses the same publication/lifecycle decoder as lists.
 * No scan ceiling, current-head substitution or second scientific evaluator. */
export async function loadPublicHypothesisItem(
  db: D1Database,
  problemId: string,
  hypothesisId: string,
  query: unknown = {},
) {
  const parsed = HypothesisItemQuerySchema.parse(query);
  const target = PublicHypothesisIdSchema.parse(hypothesisId);
  const result = await readHypotheses(db, problemId,
    parsed.through === undefined ? {} : { through: Number(parsed.through) },
    decoders, { target });
  return result === null ? null : {
    face: boundHypothesesFace(HypothesesResponseSchema.parse(result.face)),
    unlisted: result.unlisted,
  };
}

/** Three candidates plus lookahead suffice to reject a false two-route trigger.
 * Unknown/withdrawn candidates remain counted, so they cannot manufacture two. */
export async function loadLiveHypotheses(db: D1Database, problemId: string, cursor: number) {
  const result = await readHypotheses(db, problemId, { through: cursor }, decoders, {
    liveOnly: true,
    limit: 3,
  });
  return result === null
    ? null
    : { face: HypothesesResponseSchema.parse(result.face), unlisted: result.unlisted };
}
