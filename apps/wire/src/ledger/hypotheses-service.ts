import { EvidenceRequestSchema } from "@asimposium/contracts";
import {
  HypothesesQuerySchema,
  HypothesesResponseSchema,
  HypothesisItemQuerySchema,
  HypothesisEvidenceIndexResponseSchema,
  HypothesisLifecyclePublicationSchema,
  HypothesisPublicationSchema,
  PublicHypothesisIdSchema,
  PublicHypothesisSchema,
} from "@asimposium/contracts/hypotheses";
import type { D1Database } from "@cloudflare/workers-types";
import { boundHypothesesFace } from "./hypotheses-face";
import { type HypothesisDecoders, readHypotheses } from "./hypotheses-read";

import { readHypothesisEvidenceIndex } from "./hypothesis-evidence-index";

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
  lifecycle(value) {
    const parsed = HypothesisLifecyclePublicationSchema.safeParse(value);
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

/** Internal negative-memory page. Reuse the public publication/kill schemas
 * and one read transaction; the pack applies its own whole-item budget.
 * This selector is not a new public query parameter or a scientific verdict. */
export async function loadKilledHypotheses(db: D1Database, problemId: string, cursor: number) {
  const result = await readHypotheses(db, problemId, { through: cursor }, decoders, {
    killedOnly: true,
  });
  return result === null ? null : {
    face: HypothesesResponseSchema.parse(result.face), unlisted: result.unlisted,
  };
}

/** The evidence index shares the ordinary evidence request vocabulary. It does
 * not compute scientific standing or replace full immutable evidence reads. */
export async function loadHypothesisEvidenceIndex(
  db: D1Database, problemId: string, hypothesisId: string, query: unknown = {},
) {
  const parsed = HypothesesQuerySchema.parse(query);
  const result = await readHypothesisEvidenceIndex(db, problemId, hypothesisId, {
    ...(parsed.through === undefined ? {} : { through: Number(parsed.through) }),
    ...(parsed.after === undefined ? {} : { after: Number(parsed.after) }),
  }, {
    hypothesis: decoders.publication,
    envelope(value) {
      const parsed = PublicHypothesisSchema.shape.publication.safeParse(value);
      return parsed.success ? parsed.data : null;
    },
    evidence(value) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
      const candidate = { ...value } as Record<string, unknown>;
      for (const key of ["computed_class", "coercion_flags", "caused_by", "sponsor_promotion"])
        delete candidate[key];
      for (const key of ["bears_on_version", "computation_domain_or_floor", "reproduction",
        "selected_hypothesis_id", "falsification_check", "formal_artifact"])
        if (candidate[key] === null) delete candidate[key];
      const parsed = EvidenceRequestSchema.options[1].safeParse(candidate);
      return parsed.success && parsed.data.formal_artifact === undefined &&
        parsed.data.falsification_check === undefined ? parsed.data : null;
    },
  });
  return result === null ? null : {
    face: HypothesisEvidenceIndexResponseSchema.parse(result.face), unlisted: result.unlisted,
  };
}
