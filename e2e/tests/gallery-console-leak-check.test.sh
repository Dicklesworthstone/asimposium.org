#!/usr/bin/env bash
# Table tests for scripts/gallery-console-leak-check.py -- the anonymous /console
# privacy gate used by scripts/smoke-gallery.sh. These seed fixtures directly, so
# each privacy assertion is proven to FIRE when defective without any staging
# origin or credentials.
#
# The load-bearing case is a real, uppercase-Crockford workshop id: mintId emits
# ID_PREFIX_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ" (no lowercase), so a
# leak pattern of `W-[a-z]` matches no real id and this test fails RED against
# that defect. Restoring `W-[0-9A-Z]` makes it GREEN.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
detector="$repository_root/scripts/gallery-console-leak-check.py"
suite="gallery-console-leak-check"
failures=0

emit() {
  printf '{"suite":"%s","status":"%s","code":"%s"}\n' "$suite" "$1" "$2"
}

# Runs the real detector on stdin and asserts its exact exit code.
expect_exit() {
  local label="$1" expected="$2" html="$3" actual
  set +e
  printf '%s' "$html" | python3 "$detector" >/dev/null 2>&1
  actual=$?
  set -e
  if [[ "$actual" -ne "$expected" ]]; then
    emit "fail" "LEAK_CHECK_${label}_EXPECTED_${expected}_GOT_${actual}"
    failures=$((failures + 1))
  fi
}

# A real minted workshop id: W- then Crockford base32 (uppercase + digits only).
# The bug (`W-[a-z]`) cannot match this; the fix (`W-[0-9A-Z]`) must.
workshop_id="W-9ZXWVTSRQPNMKJHG0123456789"
fellow_id="F-0123456789ABCDEFGHJKMNPQRS"

signin='<html><body><h1>Sign in with Google to continue</h1></body></html>'

# Safe: sign-in prompt present, no sponsor-scoped identifier.
expect_exit "SAFE" 0 "$signin"

# No sign-in prompt for an anonymous visitor: the console did not gate.
expect_exit "NO_SIGNIN" 1 '<html><body><p>Welcome to the gallery.</p></body></html>'

# The defect this slice fixes: a real (uppercase) workshop id must be caught.
expect_exit "WORKSHOP_ID_LEAK" 2 \
  "${signin/continue/continue $workshop_id}"

# Regression guards for the already-correct classes.
expect_exit "FELLOW_ID_LEAK" 2 "${signin/continue/continue $fellow_id}"
expect_exit "ENROLLMENT_ID_LEAK" 2 "${signin/continue/continue ASIMP-EN-0123ABCD}"
expect_exit "SPONSOR_PRINCIPAL_LEAK" 2 "${signin/continue/continue usr_sponsor01}"

# Non-vacuity: describing the workshop in prose (no id token) stays safe, so the
# gate is not merely matching the word "workshop".
expect_exit "WORKSHOP_PROSE_SAFE" 0 \
  "${signin/continue/continue -- push drafts to your private workshop}"

if [[ "$failures" -ne 0 ]]; then
  emit "fail" "GALLERY_CONSOLE_LEAK_CHECK_TABLE_FAILED"
  exit 1
fi
emit "pass" "GALLERY_CONSOLE_LEAK_CHECK_TABLE_PASSED"
