#!/usr/bin/env python3
"""Anonymous /console privacy gate for smoke-gallery.sh (S-4/S-6 sponsor boundary).

Reads a rendered /console HTML document on stdin and decides, with no network
and no credentials, whether the anonymous view is safe. Extracted from an inline
snippet in scripts/smoke-gallery.sh so the assertion is independently invocable
and therefore testable against seeded fixtures (a gate whose logic only runs
behind a live staging origin can never be proven to fail when defective).

Exit codes (consumed by smoke-gallery.sh):
  0  safe: a sign-in prompt is present and no sponsor-scoped identifier leaks.
  1  no sign-in prompt for an anonymous visitor (the console did not gate).
  2  a Fellow, workshop, enrollment, or sponsor identifier leaked anonymously.

Identifier alphabet: mintId() (apps/wire/src/sessions/router.ts) emits
ID_PREFIX_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ" -- Crockford base32,
uppercase and digits only, never lowercase. A leak pattern of `W-[a-z]` matches
no real workshop id, so the workshop class uses the same [0-9A-Z] class the
Fellow class already uses. The product copy may DESCRIBE the workshop; it must
never render a real object id.
"""

import re
import sys
from html import unescape

# `\b` anchors each id to a token boundary. Both F- and W- use the Crockford
# uppercase/digit class the minter actually emits; ASIMP-EN- is the enrollment
# id prefix and usr_ is the sponsor principal prefix.
LEAK_PATTERN = re.compile(r"\bF-[0-9A-Z]|\bW-[0-9A-Z]|ASIMP-EN-|usr_")
SIGN_IN_PATTERN = re.compile(r"sign in|google|authenticate", re.IGNORECASE)


def classify(html: str) -> int:
    rendered_html = unescape(html)
    if not SIGN_IN_PATTERN.search(rendered_html):
        return 1
    if LEAK_PATTERN.search(rendered_html):
        return 2
    return 0


def main() -> int:
    return classify(sys.stdin.read())


if __name__ == "__main__":
    sys.exit(main())
