/** Parse one quality value. Invalid or duplicate q parameters refuse the range. */
function acceptQuality(parameters: readonly string[]): number {
  let quality: number | undefined;
  for (const parameter of parameters) {
    const [name, value, ...rest] = parameter.trim().split("=");
    if (name?.toLowerCase() !== "q") continue;
    if (quality !== undefined || value === undefined || rest.length !== 0) return 0;
    const normalized = value.trim();
    if (!/^(?:0(?:\.\d{0,3})?|\.\d{1,3}|1(?:\.0{0,3})?)$/.test(normalized)) return 0;
    quality = Number(normalized);
  }
  return quality ?? 1;
}

interface AcceptedMediaRange {
  readonly type: string;
  readonly subtype: string;
  readonly quality: number;
}

/** Split an HTTP list outside quoted strings, retaining escapes for later validation. */
function splitHeaderList(header: string, delimiter: "," | ";"): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;
  for (const character of header) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      current += character;
      escaped = true;
      continue;
    }
    if (character === '"') quoted = !quoted;
    if (character === delimiter && !quoted) {
      values.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  values.push(current.trim());
  return values;
}

function acceptedMediaRanges(accept: string): readonly AcceptedMediaRange[] {
  const ranges: AcceptedMediaRange[] = [];
  for (const item of splitHeaderList(accept, ",")) {
    const [mediaRange, ...parameters] = splitHeaderList(item, ";");
    const parts = mediaRange?.split("/") ?? [];
    if (parts.length !== 2) continue;
    const type = parts[0]?.trim().toLowerCase() ?? "";
    const subtype = parts[1]?.trim().toLowerCase() ?? "";
    if (type === "" || subtype === "" || (type === "*" && subtype !== "*")) continue;
    ranges.push({ type, subtype, quality: acceptQuality(parameters) });
  }
  return ranges;
}

/** Each offered type uses its most-specific matching range. Ties follow the
 * supplied face order; an unsupported header falls back to the canonical face. */
export function selectMediaFace<Face extends string>(
  accept: string,
  media: Readonly<Record<Face, string>>,
  fallback: Face,
): Face {
  const ranges = acceptedMediaRanges(accept);
  let selected = fallback;
  let highest = 0;
  for (const face of Object.keys(media) as Face[]) {
    const [faceType, faceSubtype] = media[face].split("/") as [string, string];
    let specificity = -1;
    let effectiveQuality = 0;
    for (const range of ranges) {
      const matchesType = range.type === "*" || range.type === faceType;
      const matchesSubtype = range.subtype === "*" || range.subtype === faceSubtype;
      if (!matchesType || !matchesSubtype) continue;
      const candidateSpecificity = range.type === "*" ? 0 : range.subtype === "*" ? 1 : 2;
      if (candidateSpecificity > specificity) {
        specificity = candidateSpecificity;
        effectiveQuality = range.quality;
      } else if (candidateSpecificity === specificity) {
        effectiveQuality = Math.max(effectiveQuality, range.quality);
      }
    }
    if (effectiveQuality > highest) {
      selected = face;
      highest = effectiveQuality;
    }
  }
  return selected;
}

/** GET uses weak comparison: W/"tag" and "tag" refer to the same face. */
export function ifNoneMatchMatches(header: string | null | undefined, etag: string): boolean {
  if (header == null) return false;
  return splitHeaderList(header, ",").some((candidate) => {
    if (candidate === "*") return true;
    const opaque = candidate.startsWith("W/") ? candidate.slice(2) : candidate;
    return opaque === etag;
  });
}
