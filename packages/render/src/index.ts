/**
 * `@asimposium/render` — one projection, many faces, one sanitization story.
 *
 * See README.md for the scope of this package and for what it deliberately does
 * not do yet (TOON, the GFM + math pipeline, golden face snapshots).
 */

export {
  FACE_FORMATS,
  ITEM_SCOPES,
  type FaceFormat,
  type ItemScope,
  type NeutralizationMarker,
  type NeutralizationReport,
  type NextAction,
  type OmittedEntry,
  type Projection,
  type ProjectionItem,
  type RenderedFace,
} from "./types.ts";

export {
  ERROR_TYPE_BASE,
  RenderContractError,
  type RenderErrorCode,
  type RenderProblem,
} from "./errors.ts";

export {
  RESERVED_ENVELOPE_KEYS,
  escapeHtml,
  fenceFor,
  isSafeHeaderValue,
  longestBacktickRun,
  neutralizeUntrustedBody,
  type Fence,
  type NeutralizationFinding,
  type NeutralizedBody,
} from "./sanitize.ts";

export {
  FINGERPRINT_ALGORITHM,
  byteLength,
  contentFingerprint,
  stableStringify,
} from "./canonical.ts";

export {
  ITEM_ID_PATTERN,
  prepareProjection,
  type PreparedItem,
  type PreparedProjection,
} from "./prepare.ts";

export { MEDIA_TYPES, renderAllFaces, renderProjection } from "./render.ts";
