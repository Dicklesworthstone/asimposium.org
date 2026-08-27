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
// A still-printable segment can require at most ten percent-decode passes to
// reveal even the shortest credential prefix. Keep two passes of margin so a
// short multiply-encoded prefix cannot evade the prefix rule if the shapes
// above change without this bound changing in lockstep.
const MAX_PERCENT_DECODE_PASSES = 12;

/** Known credential shapes, redacted regardless of length. */
const CREDENTIAL_PREFIXES = [
  "asimp_", // Fellow bearer tokens (`asimp_ag_…`) and any future prefixed grant
  "v1.", // the enrollment fragment secret, `#v1.<secret>`
  // The enrollment flow handle / device code (`flow_v1.<43 base64url>`,
  // EnrollmentFlowHandleSchema). The canonical never-log scanner refuses this
  // family by shape at ANY length — including capture-clipped remainders,
  // because the minted prefix is self-declaring — so the path redactor's
  // prefix list must name it too, or a short handle wedged into a path by a
  // confused client prints while every diagnostic of the same bytes is
  // rewritten. That divergence is exactly the union drift bead 233 exists to
  // end. `workflow_v1.` does not start with this prefix, so ordinary
  // versioned workflow references stay printable.
  "flow_v1.",
];

const REDACTED = "<redacted>";
const TRUNCATED = "...";

function decodeAsciiPercentEscapes(value: string): string {
  return value.replace(/%([0-9a-f]{2})/giu, (encoded, hex: string) => {
    const byte = Number.parseInt(hex, 16);
    return byte <= 0x7f ? String.fromCharCode(byte) : encoded;
  });
}

function carriesCredentialPrefix(segment: string): boolean {
  let inspected = segment;
  for (let pass = 0; pass <= MAX_PERCENT_DECODE_PASSES; pass += 1) {
    // Encoded slashes create path-component boundaries after decoding. Check
    // each resulting component rather than searching arbitrary substrings, so
    // safe text such as `workflow_v1.config` remains printable.
    if (
      inspected
        .split("/")
        .some((part) => CREDENTIAL_PREFIXES.some((prefix) => part.toLowerCase().startsWith(prefix)))
    ) {
      return true;
    }
    if (pass === MAX_PERCENT_DECODE_PASSES) break;
    const decoded = decodeAsciiPercentEscapes(inspected);
    if (decoded === inspected) break;
    inspected = decoded;
  }
  return false;
}

function redactSegment(segment: string): string {
  if (segment.length === 0) {
    return segment;
  }
  if (carriesCredentialPrefix(segment)) {
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
