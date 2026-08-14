/**
 * The public entry point: one projection → one face, or all of them.
 */

import { byteLength } from "./canonical.ts";
import { RenderContractError } from "./errors.ts";
import { renderHtmlFragmentFace } from "./faces/html.ts";
import { renderJsonFace } from "./faces/json.ts";
import { renderMarkdownFace } from "./faces/markdown.ts";
import { prepareProjection } from "./prepare.ts";
import { FACE_FORMATS, type FaceFormat, type Projection, type RenderedFace } from "./types.ts";

export const MEDIA_TYPES: Readonly<Record<FaceFormat, string>> = {
  md: "text/markdown; charset=utf-8",
  json: "application/json; charset=utf-8",
  "html-fragment": "text/html; charset=utf-8",
};

/**
 * Render one face. Unknown formats are refused with the allowed list rather
 * than silently falling back (Fable §7.1 axiom 9: never silent-fail).
 */
export function renderProjection(projection: Projection, format: FaceFormat): RenderedFace {
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

  const prepared = prepareProjection(projection);
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
 * Render every face of one projection. Each face is rendered through the full
 * pipeline independently, so agreement between faces is an observed property of
 * the renderers rather than an artifact of sharing one intermediate value.
 */
export function renderAllFaces(projection: Projection): Readonly<Record<FaceFormat, RenderedFace>> {
  return {
    md: renderProjection(projection, "md"),
    json: renderProjection(projection, "json"),
    "html-fragment": renderProjection(projection, "html-fragment"),
  };
}
