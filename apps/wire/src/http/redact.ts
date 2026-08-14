/**
 * Path redaction for anything this Worker echoes back or logs.
 *
 * Fable §14.2 says agent tokens are "masked in every log, never in URLs", and
 * §14.3 makes that a redaction layer rather than a habit. Agents get URLs
 * wrong: a join URL pasted whole (secret and all), a token wedged into a path
 * by a confused client, an enrollment fragment that should never have left the
 * browser. When that happens the reply must not hand the credential back, and
 * the server log must not keep a copy.
 *
 * The rules are deliberately blunt and deterministic, because a clever
 * classifier that is right 95% of the time leaks 5% of the time:
 *
 *   - a segment carrying a known credential prefix is redacted at any length;
 *   - any segment longer than `MAX_SEGMENT_LENGTH` is redacted, because no
 *     legitimate route segment in this design is that long and secrets are;
 *   - the path is truncated after `MAX_SEGMENTS`, so a pathological URL cannot
 *     inflate a response body or a log line.
 *
 * A redacted path still shows the caller the *shape* of what it asked for,
 * which is the part that helps it correct the request.
 */

const MAX_SEGMENT_LENGTH = 24;
const MAX_SEGMENTS = 8;

/** Known credential shapes, redacted regardless of length. */
const CREDENTIAL_PREFIXES = [
  "asimp_", // Fellow bearer tokens (`asimp_ag_…`) and any future prefixed grant
  "v1.", // the enrollment fragment secret, `#v1.<secret>`
];

const REDACTED = "<redacted>";
const TRUNCATED = "...";

function redactSegment(segment: string): string {
  if (segment.length === 0) {
    return segment;
  }
  const lowered = segment.toLowerCase();
  if (CREDENTIAL_PREFIXES.some((prefix) => lowered.startsWith(prefix))) {
    return REDACTED;
  }
  if (segment.length > MAX_SEGMENT_LENGTH) {
    return REDACTED;
  }
  return segment;
}

/**
 * Redact a URL pathname for inclusion in a response body or a log line.
 *
 * @param pathname a `URL.pathname`, already percent-encoded.
 */
export function redactPathname(pathname: string): string {
  const segments = pathname.split("/");
  const kept = segments.slice(0, MAX_SEGMENTS + 1).map(redactSegment);
  const redacted = kept.join("/");
  return segments.length > MAX_SEGMENTS + 1 ? `${redacted}/${TRUNCATED}` : redacted;
}
