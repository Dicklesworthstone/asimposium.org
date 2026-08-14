/**
 * The public entry point: one projection → one face, or all of them.
 */

import { byteLength } from "./canonical.ts";
import { RenderContractError } from "./errors.ts";
import { renderHtmlFragmentFace } from "./faces/html.ts";
import { renderJsonFace } from "./faces/json.ts";
import { renderMarkdownFace } from "./faces/markdown.ts";
import { type PreparedProjection, prepareProjection } from "./prepare.ts";
import { FACE_FORMATS, type FaceFormat, type Projection, type RenderedFace } from "./types.ts";

export const MEDIA_TYPES: Readonly<Record<FaceFormat, string>> = {
  md: "text/markdown; charset=utf-8",
  json: "application/json; charset=utf-8",
  "html-fragment": "text/html; charset=utf-8",
};

function assertKnownFormat(format: FaceFormat): void {
  if (!FACE_FORMATS.includes(format)) {
    throw new RenderContractError({
      code: "UNKNOWN_FORMAT",
      title: "Unknown face format",
      detail: `format ${JSON.stringify(format)} is not rendered by this package`,
      fix_hint: `Use one of: ${FACE_FORMATS.join(", ")}.`,
      status: 400,
      rule: "A1",
    });
  }
}

function renderPreparedFace(prepared: PreparedProjection, format: FaceFormat): RenderedFace {
  const body =
    format === "md"
      ? renderMarkdownFace(prepared)
      : format === "json"
        ? renderJsonFace(prepared)
        : renderHtmlFragmentFace(prepared);

  return {
    format,
    media_type: MEDIA_TYPES[format],
    body,
    fingerprint: prepared.fingerprint,
    bytes: byteLength(body),
    neutralized: prepared.neutralized,
  };
}

/**
 * Render one face. Unknown formats are refused with the allowed list rather
 * than silently falling back (Fable §7.1 axiom 9: never silent-fail).
 */
export function renderProjection(projection: Projection, format: FaceFormat): RenderedFace {
  assertKnownFormat(format);
  return renderPreparedFace(prepareProjection(projection), format);
}

/**
 * Render every face from one immutable prepared projection. This is the Diptych
 * contract in code: neutralization and fingerprinting occur once, then each
 * renderer projects the same prepared data without redoing that work.
 */
export function renderAllFaces(projection: Projection): Readonly<Record<FaceFormat, RenderedFace>> {
  const prepared = prepareProjection(projection);
  return {
    md: renderPreparedFace(prepared, "md"),
    json: renderPreparedFace(prepared, "json"),
    "html-fragment": renderPreparedFace(prepared, "html-fragment"),
  };
}
