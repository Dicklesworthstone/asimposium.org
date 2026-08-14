/**
 * The S-5 Diptych face harness (bead asimposiumorg-6jo).
 *
 * A local-only entrypoint. It is deliberately **not** mounted in `src/app.ts`: the public
 * face surface is W4–W6 work with its own contract, and a spike must not pre-empt it by
 * quietly adding a product route. `scripts/e2e-s5-diptych.sh` starts this file directly
 * under Wrangler, so the same workerd runtime that will serve production serves the spike.
 *
 * It touches no binding — no D1, no R2, no Durable Object — because it has nothing to
 * store: it renders one synthetic fixture from `@asimposium/render` and serves it. That is
 * also why nothing here needs to be mocked.
 *
 * What it proves that an in-process render cannot: that the bytes survive a real HTTP hop,
 * that the media type and ETag a client sees are the ones the projection dictates, that
 * `If-None-Match` yields a bodiless 304, and that the public variant carries no workshop
 * byte after crossing the wire.
 */

import {
  FACE_FORMATS,
  type FaceFormat,
  isSpikeVariant,
  renderProjection,
  SPIKE_VARIANTS,
  s5SpikeProjection,
} from "@asimposium/render";

/** `?format=` accepts the canonical names plus `html`, which is what a human will type. */
const FORMAT_ALIASES: Readonly<Record<string, FaceFormat>> = {
  md: "md",
  markdown: "md",
  json: "json",
  html: "html-fragment",
  "html-fragment": "html-fragment",
};

const ERROR_TYPE_BASE = "https://asimposium.org/errors/";

/**
 * A contract refusal that teaches (Fable §7.7): the code, what was wrong, how to fix it,
 * and the allowed set. Policy refusals are the terse ones; this is not a policy refusal.
 */
function teachingError(
  code: string,
  title: string,
  detail: string,
  fix_hint: string,
  allowed: readonly string[],
): Response {
  return new Response(
    `${JSON.stringify({ type: `${ERROR_TYPE_BASE}${code}`, title, status: 400, code, detail, fix_hint, allowed }, null, 2)}\n`,
    {
      status: 400,
      headers: {
        "content-type": "application/problem+json; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

function notFound(): Response {
  return new Response(
    `${JSON.stringify(
      {
        type: `${ERROR_TYPE_BASE}HARNESS_ROUTE_NOT_FOUND`,
        title: "No such harness route",
        status: 404,
        code: "HARNESS_ROUTE_NOT_FOUND",
        detail: "This entrypoint serves the S-5 face harness only.",
        fix_hint: "GET /__s5/face?variant=public|sponsor&format=md|json|html-fragment",
      },
      null,
      2,
    )}\n`,
    {
      status: 404,
      headers: {
        "content-type": "application/problem+json; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

/**
 * The ETag is the projection's own content fingerprint, quoted as a strong validator. It is
 * not invented here: two faces of one projection share it, so a client can tell that an md
 * and a json face describe the same state (Rule A1).
 */
function etagFor(fingerprint: string): string {
  return `"${fingerprint}"`;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== "/__s5/face") return notFound();
    if (request.method !== "GET" && request.method !== "HEAD") {
      return teachingError(
        "METHOD_NOT_ALLOWED",
        "The face harness is read-only",
        `method ${request.method} is not served here`,
        "Use GET. Faces are projections; nothing here accepts a write.",
        ["GET", "HEAD"],
      );
    }

    const requestedVariant = url.searchParams.get("variant") ?? "public";
    if (!isSpikeVariant(requestedVariant)) {
      return teachingError(
        "UNKNOWN_VARIANT",
        "Unknown spike variant",
        `variant ${JSON.stringify(requestedVariant)} is not one this harness composes`,
        "Use 'public' for the stranger's view or 'sponsor' for the view that includes the workshop head.",
        SPIKE_VARIANTS,
      );
    }

    const requestedFormat = url.searchParams.get("format") ?? "md";
    const format = FORMAT_ALIASES[requestedFormat];
    if (format === undefined) {
      return teachingError(
        "UNKNOWN_FORMAT",
        "Unknown face format",
        `format ${JSON.stringify(requestedFormat)} is not rendered by this package`,
        `Use one of: ${FACE_FORMATS.join(", ")}. The agent face is '.md' and is canonical (Rule A1).`,
        FACE_FORMATS,
      );
    }

    const face = renderProjection(s5SpikeProjection(requestedVariant), format);
    const etag = etagFor(face.fingerprint);
    const headers: Record<string, string> = {
      "content-type": face.media_type,
      etag,
      "cache-control": "no-store",
      "x-asimp-face": format,
      "x-asimp-variant": requestedVariant,
      "x-asimp-fingerprint": face.fingerprint,
    };

    // A conditional request that already holds this exact face gets no body. The header set
    // stays identical so a client can compare a 304 against its cached 200 without guessing.
    const ifNoneMatch = request.headers.get("if-none-match");
    if (ifNoneMatch?.split(",").some((tag) => tag.trim() === etag) === true) {
      return new Response(null, { status: 304, headers });
    }

    return new Response(request.method === "HEAD" ? null : face.body, { status: 200, headers });
  },
};
