#!/usr/bin/env python3
"""Loopback fixture for scripts/e2e-served-texts.sh --self-test.

Serves the advertised served-text matrix from memory. Defects flip exactly one
behavior so the matching refusal is proven to fire. No TLS: self-test uses
http://127.0.0.1 and never calls e2e_validate_staging_origin.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEFECT = os.environ.get("SERVED_TEXT_FIXTURE_DEFECT", "")
READY_FILE = os.environ.get("SERVED_TEXT_FIXTURE_READY_FILE", "")

MARKDOWN = "text/markdown; charset=utf-8"
JSON_CT = "application/json; charset=utf-8"
PLAIN = "text/plain; charset=utf-8"
PROBLEM_CT = "application/problem+json; charset=utf-8"

HANDBOOK = "# handbook\n"
PROTOCOL = "# protocol\n"
PROTOCOL_JSON = json.dumps({"schema": "asimposium.protocol.v1", "id": "protocol"}, indent=2) + "\n"
POLICY = "# policy\n"
SKILL = "# skill\n"
INOCULATION = "# inoculation\n"
LLMS = "# llms\n"
CAPABILITIES = json.dumps({"reads": ["/", "/protocol.md"]}, indent=2) + "\n"
WELL_KNOWN = json.dumps({"schema_version": "1"}, indent=2) + "\n"
OPENAPI = json.dumps({"openapi": "3.1.0"}, indent=2) + "\n"
SCHEMA_INDEX = json.dumps({"schema_version": "1", "schemas": []}, indent=2) + "\n"


def digest(body: str) -> str:
    return hashlib.sha256(body.encode()).hexdigest()


# path -> (body, content-type, canonical path)
WORKER_GETS: dict[str, tuple[str, str, str]] = {
    "/": (HANDBOOK, MARKDOWN, "/"),
    "/AGENTS.md": (HANDBOOK, MARKDOWN, "/"),
    "/llms.txt": (LLMS, PLAIN, "/llms.txt"),
    "/protocol": (PROTOCOL, MARKDOWN, "/protocol.md"),
    "/protocol.md": (PROTOCOL, MARKDOWN, "/protocol.md"),
    "/protocol.json": (PROTOCOL_JSON, JSON_CT, "/protocol.json"),
    "/policy.md": (POLICY, MARKDOWN, "/policy.md"),
    "/skill.md": (SKILL, MARKDOWN, "/skill.md"),
    "/inoculation.md": (INOCULATION, MARKDOWN, "/inoculation.md"),
    "/capabilities": (CAPABILITIES, JSON_CT, "/capabilities"),
    "/.well-known/asimposium.json": (WELL_KNOWN, JSON_CT, "/.well-known/asimposium.json"),
    "/openapi.json": (OPENAPI, JSON_CT, "/openapi.json"),
    "/schemas/index.json": (SCHEMA_INDEX, JSON_CT, "/schemas/index.json"),
}

APEX_REDIRECTS = (
    "/protocol",
    "/protocol.md",
    "/protocol.json",
    "/policy.md",
    "/inoculation.md",
)
APEX_STATIC = {
    "/AGENTS.md": HANDBOOK,
    "/skill.md": SKILL,
    "/llms.txt": LLMS,
    "/capsule.md": "# capsule\n",
}

WORKER_ORIGIN = ""


def problem(path: str) -> bytes:
    return json.dumps(
        {
            "type": "https://asimposium.org/errors/ROUTE_NOT_FOUND",
            "title": "No such route",
            "status": 404,
            "code": "ROUTE_NOT_FOUND",
            "detail": f"This Worker serves no route at {path}.",
            "fix_hint": "GET /capabilities.",
        }
    ).encode()


class WorkerHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: object) -> None:  # noqa: A003
        return

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if DEFECT == "missing-inoculation" and path == "/inoculation.md":
            self._send(404, PROBLEM_CT, problem(path), etag=None, canonical=None)
            return
        route = WORKER_GETS.get(path)
        if route is None:
            self._send(404, PROBLEM_CT, problem(path), etag=None, canonical=None)
            return
        body, content_type, canonical = route
        etag = None if DEFECT == "no-etag" and path == "/protocol.md" else f'"{digest(body)}"'
        link = None if DEFECT == "no-canonical" and path == "/protocol" else canonical
        if etag is not None and self.headers.get("If-None-Match") == etag:
            self._send(304, content_type, b"", etag=etag, canonical=link)
            return
        self._send(200, content_type, body.encode(), etag=etag, canonical=link)

    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET()

    def _send(
        self,
        status: int,
        content_type: str,
        body: bytes,
        *,
        etag: str | None,
        canonical: str | None,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body) if status != 304 else 0))
        if etag is not None:
            self.send_header("ETag", etag)
        if canonical is not None:
            self.send_header("Link", f'<{canonical}>; rel="canonical"')
        self.end_headers()
        if status != 304 and self.command != "HEAD":
            self.wfile.write(body)


class ApexHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: object) -> None:  # noqa: A003
        return

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path in APEX_REDIRECTS:
            if DEFECT == "apex-not-308" and path == "/inoculation.md":
                self.send_response(200)
                self.send_header("Content-Type", MARKDOWN)
                body = INOCULATION.encode()
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            self.send_response(308)
            self.send_header("Location", f"{WORKER_ORIGIN}{path}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        static = APEX_STATIC.get(path)
        if static is None:
            self.send_response(404)
            self.send_header("Content-Type", PROBLEM_CT)
            body = problem(path)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        payload = static.encode()
        self.send_response(200)
        self.send_header("Content-Type", MARKDOWN if path.endswith(".md") else PLAIN)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def bind(handler: type[BaseHTTPRequestHandler]) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def main() -> int:
    global WORKER_ORIGIN
    worker = bind(WorkerHandler)
    host, port = worker.server_address[:2]
    WORKER_ORIGIN = f"http://{host}:{port}"
    apex = bind(ApexHandler)
    apex_host, apex_port = apex.server_address[:2]
    ready = f"{WORKER_ORIGIN} http://{apex_host}:{apex_port}\n"
    if READY_FILE:
        with open(READY_FILE, "w", encoding="utf-8") as handle:
            handle.write(ready)
    else:
        sys.stdout.write(ready)
        sys.stdout.flush()
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
