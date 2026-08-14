/**
 * `@asimposium/render` — one projection, many faces, one sanitization story.
 *
 * See README.md for the scope of this package and for what it deliberately does
 * not do yet (TOON, the GFM + math pipeline, golden face snapshots).
 */

export {
  byteLength,
  contentFingerprint,
  FINGERPRINT_ALGORITHM,
  stableStringify,
} from "./canonical.ts";

export {
  ERROR_TYPE_BASE,
  RenderContractError,
  type RenderErrorCode,
  type RenderProblem,
} from "./errors.ts";
export {
  ITEM_ID_PATTERN,
  type PreparedItem,
  type PreparedProjection,
  prepareProjection,
} from "./prepare.ts";
export { MEDIA_TYPES, renderAllFaces, renderProjection } from "./render.ts";
export {
  escapeHtml,
  type Fence,
  fenceFor,
  isSafeHeaderValue,
  longestBacktickRun,
  type NeutralizationFinding,
  type NeutralizedBody,
  neutralizeUntrustedBody,
  RESERVED_ENVELOPE_KEYS,
} from "./sanitize.ts";
export {
  isSpikeVariant,
  S5_SPIKE_CURSOR,
  S5_SPIKE_PROBLEM,
  S5_SPIKE_SEED,
  SPIKE_VARIANTS,
  type SpikeVariant,
  s5Canary,
  s5SpikeProjection,
} from "./spike.ts";
export {
  FACE_FORMATS,
  type FaceFormat,
  ITEM_SCOPES,
  type ItemScope,
  type NeutralizationMarker,
  type NeutralizationReport,
  type NextAction,
  type OmittedEntry,
  type Projection,
  type ProjectionItem,
  type RenderedFace,
} from "./types.ts";
