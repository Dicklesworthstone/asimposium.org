#!/usr/bin/env python3
"""Seeded fake Stoa origin for scripts/smoke-agent.sh table tests.

Serves the complete anonymous + credentialed smoke surface from memory so the
full agent journey can be proven against planted defects without a preview
deployment or real credentials. Rate-limit defects fire once on the first GET
(the handbook probe), exercising smoke_agent_fetch_with_rate_limit at its
earliest call site; the helper is shared by every public preflight GET.

Secret discipline: no token, fragment, or handle value is ever echoed into a
log line.
"""

from __future__ import annotations

import json
import os
import re
import signal
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEFECT = os.environ.get("SMOKE_FIXTURE_DEFECT", "")
READY_FILE = os.environ.get("SMOKE_FIXTURE_READY_FILE", "")
FELLOW_TOKEN = os.environ.get("SMOKE_FIXTURE_FELLOW_TOKEN", "")

JSON_CT = "application/json; charset=utf-8"
PROBLEM_CT = "application/problem+json; charset=utf-8"

ALPHABET_26 = "0123456789ABCDEFGHJKMNPQRTVWX"[:26]
SESSION_ID = "S-" + ALPHABET_26
WORKSHOP_ID = "W-" + ALPHABET_26
CLAIM_ID = "C-" + ALPHABET_26

# Mirrors the exact handle/user_code grammar smoke_agent_check_device_flow_shape
# accepts (same strings as the script's own self-test fixtures).
DEVICE_HANDLE = "flow_v1.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq"
DEVICE_BODY = {
    "device_code": DEVICE_HANDLE,
    "user_code": "ABCD-EFGH",
    "verification_url": "https://staging.asimposium.org/approve",
    "interval_seconds": 5,
    "expires_in_seconds": 900,
}

UNAUTHORIZED_PROBLEM = {
    "type": "https://asimposium.org/errors/UNAUTHORIZED",
    "title": "Authorization was not accepted",
    "status": 401,
    "code": "UNAUTHORIZED",
    "detail": "The request did not include an authorization accepted by this route.",
    "fix_hint": "Obtain a fresh sponsor authorization and retry the request.",
}

PROBLEM_INDEX = {
    "problems": [
        {
            "id": "P-4DSP",
            "public_seq": 0,
            "created_at": "2026-01-01T00:00:00.000Z",
            "updated_at": "2026-01-01T00:00:00.000Z",
        }
    ],
    "omitted": ["bodies"],
}

CAPABILITIES = {"capabilities": ["sessions", "packs", "workshop", "promote"], "omitted": []}

PACK = {
    "session_id": SESSION_ID,
    "items": [{"id": "P-4DSP", "kind": "problem"}],
    "omitted": ["bodies"],
    "next_actions": [{"action": "workshop.push"}],
    "cursor": 41,
}

RATE_LIMIT_VALUES = {
    "retry-after-once": "1",
    "retry-after-invalid": "soon",
    "retry-after-zero": "0",
    "retry-after-negative": "-5",
    "retry-after-huge": "9999",
    "retry-after-three": "3",
    "retry-after-eleven": "11",
}


class Ledger:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.cursor = 41
        self.device_keys: dict[str, str] = {}
        self.promoted_norms: set[str] = set()
        self.rate_limit_arm = DEFECT in RATE_LIMIT_VALUES

    @staticmethod
    def norm(statement: str) -> str:
        return re.sub(r"\s+", " ", statement.strip()).casefold()


LEDGER = Ledger()


def problem(code: str, status: int, rule: str | None = None) -> bytes:
    doc = {
        "type": f"https://asimposium.org/errors/{code}",
        "title": code.replace("_", " ").lower(),
        "status": status,
        "code": code,
        "detail": f"seeded {code} refusal for the smoke fixture origin.",
        "fix_hint": "seeded fixture response.",
    }
    if rule:
        doc["rule"] = rule
    return json.dumps(doc).encode()


def send_json(handler, status: int, body: bytes, content_type: str = JSON_CT, headers: dict | None = None) -> None:
    if os.environ.get("SMOKE_FIXTURE_TRACE"):
        sys.stderr.write(
            f"TRACE {handler.command} {handler.path} -> {status} ct={content_type} "
            f"auth={'yes' if handler.headers.get('Authorization') else 'no'}\n"
        )
        sys.stderr.flush()
    handler.send_response(status)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Content-Length", str(len(body)))
    for key, value in (headers or {}).items():
        handler.send_header(key, value)
    handler.end_headers()
    if handler.command != "HEAD":
        handler.wfile.write(body)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    @property
    def bearer_ok(self) -> bool:
        auth = self.headers.get("Authorization", "")
        return bool(FELLOW_TOKEN) and auth == f"Bearer {FELLOW_TOKEN}"

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?")[0]
        with LEDGER.lock:
            if LEDGER.rate_limit_arm:
                LEDGER.rate_limit_arm = False
                send_json(
                    self,
                    429,
                    b"{}",
                    JSON_CT,
                    {"Retry-After": RATE_LIMIT_VALUES[DEFECT]},
                )
                return

            if path == "/":
                if DEFECT == "handbook-unavailable":
                    send_json(self, 500, b"boom")
                    return
                send_json(self, 200, b"<html>agent handbook</html>", "text/html; charset=utf-8")
                return

            if path == "/capabilities":
                if DEFECT == "capabilities-unavailable":
                    send_json(self, 503, b"unavailable")
                    return
                send_json(self, 200, json.dumps(CAPABILITIES).encode())
                return

            if path == "/problems.json":
                if DEFECT == "problem-index-status":
                    send_json(self, 503, b"unavailable")
                    return
                if DEFECT == "problem-index-media-type":
                    send_json(self, 200, json.dumps(PROBLEM_INDEX).encode(), "text/plain")
                    return
                if DEFECT == "problem-index-malformed":
                    send_json(self, 200, b"{not json", JSON_CT)
                    return
                if DEFECT == "public-face-leak":
                    leaked = dict(PROBLEM_INDEX)
                    leaked["workshop_draft_body"] = "seeded private canary"
                    send_json(self, 200, json.dumps(leaked).encode())
                    return
                if DEFECT == "problem-index-contract":
                    broken = {k: v for k, v in PROBLEM_INDEX.items() if k != "omitted"}
                    broken["extra"] = True
                    send_json(self, 200, json.dumps(broken).encode())
                    return
                send_json(self, 200, json.dumps(PROBLEM_INDEX).encode())
                return

            if path == "/cursor":
                if DEFECT == "cursor-noninteger":
                    send_json(self, 200, b"forty-two", "text/plain; charset=utf-8")
                    return
                if DEFECT == "cursor-http":
                    send_json(self, 503, b"unavailable")
                    return
                send_json(self, 200, str(LEDGER.cursor).encode(), "text/plain; charset=utf-8")
                return

            # Credentialed read: the working pack (GET /v1/sessions/:id/pack).
            if re.fullmatch(r"/v1/sessions/([^/]+)/pack", path):
                if not self.bearer_ok:
                    send_json(self, 401, problem("UNAUTHORIZED", 401), PROBLEM_CT)
                    return
                if DEFECT == "pack-unavailable":
                    send_json(self, 503, b"unavailable")
                    return
                pack = PACK
                if DEFECT == "pack-contract":
                    pack = {k: v for k, v in PACK.items() if k != "omitted"}
                send_json(self, 200, json.dumps(pack).encode())
                return

        send_json(self, 404, problem("NOT_FOUND", 404))

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        path = self.path.split("?")[0]

        try:
            body = json.loads(raw.decode() or "{}")
        except json.JSONDecodeError:
            body = {}

        with LEDGER.lock:
            # Anonymous sponsor boundary probe.
            if path == "/v1/sponsors/workshop":
                if DEFECT == "sponsor-boundary-open":
                    send_json(self, 200, b'{"ok":true}')
                    return
                if DEFECT == "sponsor-boundary-order":
                    send_json(self, 400, problem("SCHEMA_INVALID", 400))
                    return
                if DEFECT == "sponsor-boundary-face":
                    send_json(
                        self,
                        401,
                        problem("WRONG_PRINCIPAL", 401),
                        "application/json; charset=utf-8",
                    )
                    return
                send_json(self, 401, json.dumps(UNAUTHORIZED_PROBLEM).encode(), PROBLEM_CT)
                return

            # Device flow start / idempotent replay.
            if path == "/v1/device-code":
                key = self.headers.get("Idempotency-Key", "")
                if not key:
                    send_json(self, 400, problem("IDEMPOTENCY_KEY_MISSING", 400))
                    return
                replayed = LEDGER.device_keys.get(key)
                if replayed is not None:
                    if DEFECT == "device-flow-replay-status":
                        send_json(self, 500, b"boom")
                        return
                    if DEFECT == "device-flow-replay-drift":
                        drifted = dict(DEVICE_BODY)
                        drifted["device_code"] = DEVICE_HANDLE[:-1] + (
                            "X" if DEVICE_HANDLE[-1] != "X" else "Y"
                        )
                        payload = json.dumps(drifted).encode()
                        LEDGER.device_keys[key] = payload.decode()
                        send_json(self, 201, payload)
                        return
                    send_json(self, 201, replayed.encode())
                    return
                if DEFECT == "device-flow-status":
                    send_json(self, 500, b"boom")
                    return
                payload = DEVICE_BODY
                if DEFECT == "device-flow-shape":
                    payload = dict(DEVICE_BODY, interval_seconds=61)
                encoded = json.dumps(payload).encode()
                LEDGER.device_keys[key] = encoded.decode()
                send_json(self, 201, encoded)
                return

            # Everything below requires the seeded Fellow credential.
            if not self.bearer_ok:
                send_json(self, 401, problem("UNAUTHORIZED", 401), PROBLEM_CT)
                return

            if path == "/v1/sessions":
                if DEFECT == "session-open-failed":
                    send_json(self, 500, b"boom")
                    return
                session_id = SESSION_ID
                if DEFECT == "session-id-malformed":
                    session_id = "S-short"
                send_json(self, 201, json.dumps({"session_id": session_id}).encode())
                return

            match = re.fullmatch(r"/v1/sessions/([^/]+)/pack", path)
            if match:
                if DEFECT == "pack-unavailable":
                    send_json(self, 503, b"unavailable")
                    return
                pack = PACK
                if DEFECT == "pack-contract":
                    pack = {k: v for k, v in PACK.items() if k != "omitted"}
                send_json(self, 200, json.dumps(pack).encode())
                return

            match = re.fullmatch(r"/v1/sessions/([^/]+)/workshop", path)
            if match:
                text = str(body.get("body_md", "")).casefold()
                claim_shaped = "therefore" in text and "prove" in text
                if DEFECT == "intent-classifier-missing" and claim_shaped:
                    send_json(self, 201, json.dumps({"workshop_id": WORKSHOP_ID}).encode())
                    return
                if claim_shaped:
                    send_json(self, 422, problem("LOOKS_LIKE_CLAIM", 422))
                    return
                if DEFECT == "workshop-push-failed":
                    send_json(self, 500, b"boom")
                    return
                workshop_id = WORKSHOP_ID
                if DEFECT == "workshop-id-malformed":
                    workshop_id = "W-short"
                send_json(self, 201, json.dumps({"workshop_id": workshop_id}).encode())
                return

            match = re.fullmatch(r"/v1/sessions/([^/]+)/promote", path)
            if match:
                kind = str(body.get("kind", ""))
                statement = str(body.get("statement", ""))
                has_status_field = any(k in body for k in ("status", "proof", "disposition"))
                if has_status_field and DEFECT != "self-cert-missing":
                    send_json(self, 422, problem("SCHEMA_INVALID", 422, "P2/P4"))
                    return
                if kind == "conjecture" and not str(body.get("falsifier", "")):
                    if DEFECT == "p3-missing":
                        send_json(self, 201, json.dumps({"claim_id": CLAIM_ID}).encode())
                        return
                    send_json(self, 422, problem("MISSING_FALSIFIER", 422, "P3"))
                    return
                norm = LEDGER.norm(statement)
                if norm in LEDGER.promoted_norms and DEFECT != "p11-missing":
                    send_json(self, 409, problem("DUPLICATE_CLAIM", 409, "P11"))
                    return
                if DEFECT == "promote-failed":
                    send_json(self, 500, b"boom")
                    return
                if DEFECT != "cursor-law":
                    LEDGER.cursor += 1
                LEDGER.promoted_norms.add(norm)
                send_json(self, 201, json.dumps({"claim_id": CLAIM_ID}).encode())
                return

            match = re.fullmatch(r"/v1/sessions/([^/]+)/close", path)
            if match:
                if DEFECT == "close-failed":
                    send_json(self, 500, b"boom")
                    return
                send_json(self, 201, json.dumps({"handback": "ok"}).encode())
                return

        send_json(self, 404, problem("NOT_FOUND", 404))


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("SMOKE_FIXTURE_PORT", "0"))
    cert_file = os.environ.get("SMOKE_FIXTURE_CERT", "")
    key_file = os.environ.get("SMOKE_FIXTURE_KEY", "")

    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)

    if cert_file and key_file:
        import ssl

        # macOS system curl links LibreSSL, whose TLS 1.3 handshake against
        # OpenSSL 3 servers can fail with a protocol-version alert; pin both
        # sides to TLS 1.2 for this localhost evidence channel.
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.maximum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(cert_file, key_file)
        httpd.socket = context.wrap_socket(httpd.socket, server_side=True)

    bound_port = httpd.server_address[1]

    def shutdown(signum, _frame):
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    if READY_FILE:
        with open(READY_FILE, "w", encoding="utf-8") as ready:
            ready.write(f"https://127.0.0.1:{bound_port}\n")

    httpd.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
